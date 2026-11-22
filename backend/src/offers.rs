use crate::{
    ApiError, ApiResult, Shared, auth,
    eventlog::{self, Area, Level},
    internal, now, pricing,
    shops::{self, Product, Shop, title_key},
};
use axum::{
    Json,
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::{AssertSqlSafe, FromRow, SqlitePool};
use std::collections::BTreeMap;

pub(crate) use crate::pricing::FRESH;
const BAD_URL: ApiError = ApiError(
    StatusCode::BAD_REQUEST,
    "Gib eine öffentliche Xbox-Key-Produktseite eines unterstützten Shops ein.",
);
const NOT_FOUND: ApiError = ApiError(StatusCode::NOT_FOUND, "Wunsch oder Angebot nicht gefunden.");
const CONFLICT: ApiError = ApiError(
    StatusCode::CONFLICT,
    "Titel, Edition, Produkttyp und Xbox-Plattform müssen übereinstimmen.",
);

#[derive(FromRow)]
pub(crate) struct Wish {
    platform_id: i64,
    manual_title: Option<String>,
    payload: Option<String>,
}
impl Wish {
    pub(crate) fn from_parts(
        platform_id: i64,
        manual_title: Option<String>,
        payload: Option<String>,
    ) -> Self {
        Self {
            platform_id,
            manual_title,
            payload,
        }
    }

    pub(crate) fn keys(&self) -> Vec<String> {
        let Some(game) = self
            .payload
            .as_ref()
            .and_then(|p| serde_json::from_str::<crate::catalog::provider::CatalogGame>(p).ok())
        else {
            return self.manual_title.iter().map(|s| title_key(s)).collect();
        };
        if !game.selection_allowed() || !game.platforms.iter().any(|p| p.id == self.platform_id) {
            return vec![];
        }
        let mut keys = vec![title_key(&game.name)];
        if game.kind != "edition" {
            keys.extend(game.aliases.iter().map(|alias| title_key(alias)));
            if game.kind == "base_game" {
                keys.push(format!("{} standard edition", keys[0]));
                keys.push(format!("{} standard", keys[0]));
            }
        }
        keys
    }
    pub(crate) fn auto_matches(&self, product: &Product) -> bool {
        self.payload
            .as_ref()
            .and_then(|p| serde_json::from_str::<crate::catalog::provider::CatalogGame>(p).ok())
            .is_some_and(|game| {
                game.selection_allowed()
                    && game.platforms.iter().any(|p| p.id == self.platform_id)
                    && [
                        title_key(&game.name),
                        format!("{} standard edition", title_key(&game.name)),
                        format!("{} standard", title_key(&game.name)),
                    ]
                    .contains(&title_key(&product.title))
            })
            && product.key_game
            && product.platform_ids.contains(&self.platform_id)
    }
    /// A product the owner may confirm: same title, a key game, for the wish's system. A wish for the Xbox 360 or the
    /// original Xbox also takes an Xbox One key (0.8.2): shops sell those classics as backward-compatible Xbox Live keys.
    /// Such a match is never confirmed automatically ([`Self::auto_matches`] stays exact), the owner checks it once.
    pub(crate) fn matches(&self, product: &Product) -> bool {
        product.key_game
            && (product.platform_ids.contains(&self.platform_id)
                || (matches!(self.platform_id, 12 | 11) && product.platform_ids.contains(&49)))
            && self.keys().contains(&title_key(&product.title))
    }
}

#[derive(FromRow)]
struct ItemWish {
    id: String,
    #[sqlx(flatten)]
    wish: Wish,
}

/// Wishes of many items, keyed by item id (`ids_json` is a JSON array of ids).
pub(crate) async fn wishes(
    pool: &SqlitePool,
    ids_json: &str,
) -> sqlx::Result<BTreeMap<String, Wish>> {
    let rows: Vec<ItemWish> = sqlx::query_as("SELECT w.id,w.platform_id,g.manual_title,c.payload FROM wishlist_item w JOIN game g ON g.id=w.game_id LEFT JOIN catalog_game c ON c.igdb_id=g.igdb_id WHERE w.id IN (SELECT value FROM json_each(?))")
        .bind(ids_json).fetch_all(pool).await?;
    Ok(rows.into_iter().map(|row| (row.id, row.wish)).collect())
}

pub(crate) async fn wish(pool: &SqlitePool, id: &str) -> ApiResult<Wish> {
    sqlx::query_as("SELECT w.platform_id,g.manual_title,c.payload FROM wishlist_item w JOIN game g ON g.id=w.game_id LEFT JOIN catalog_game c ON c.igdb_id=g.igdb_id WHERE w.id=?")
        .bind(id).fetch_optional(pool).await?.ok_or(NOT_FOUND)
}

#[derive(FromRow)]
struct ItemLink {
    wish_id: String,
    #[sqlx(flatten)]
    link: Link,
}

#[derive(FromRow)]
pub(crate) struct Link {
    pub id: i64,
    pub source: String,
    url: String,
    pub(crate) review: String,
    fingerprint: Option<String>,
    latest: Option<String>,
    confirmed_name: Option<String>,
    /// Confirmed by hand although the shop data does not match the wish (migration 0015).
    pub(crate) manual_match: bool,
    pub observed_at: Option<i64>,
    pub attempted_at: Option<i64>,
    pub last_error: Option<String>,
    pub enabled: bool,
    pub fee_estimation_enabled: bool,
    pub fee_basis_points: i64,
    pub queued: bool,
    pub retry_at: i64,
    /// Price trend within the wish (migration 0016): 0 = mostly the cheapest, 1 = mostly the most expensive.
    #[sqlx(default)]
    pub cheap_score: f64,
    /// Interval of the next check in seconds (shop interval, validity in the target country, price-trend pace).
    #[sqlx(default)]
    pub check_every: Option<i64>,
    /// Interval factor of the job from the price trend (0.5 to 2, `shop_job.pace`); `None` without a job yet.
    #[sqlx(default)]
    pub pace: Option<f64>,
    /// An edition preview: checked half as often.
    #[sqlx(default)]
    pub preview: bool,
}
impl Link {
    /// Fingerprint stored at confirmation.
    pub(crate) fn fingerprint(&self) -> Option<&str> {
        self.fingerprint.as_deref()
    }
    /// The shop page of the offer.
    pub(crate) fn url(&self) -> &str {
        &self.url
    }
    pub(crate) fn product(&self) -> Option<Product> {
        serde_json::from_str(self.latest.as_deref()?).ok()
    }
    /// Confirmed for exactly this product: automatically matching, or matched by hand by the owner.
    pub(crate) fn confirmed(&self, wish: &Wish, product: &Product) -> bool {
        self.review == "confirmed"
            && (wish.matches(product) || self.manual_match)
            && self.fingerprint.as_deref() == Some(product.fingerprint().as_str())
    }
    /// Score 0 to 100 (0.8.2) of a confirmed, measured product: how it does in the check plan. It follows the interval
    /// factor against the shop interval, `pace × 2` for a preview (see `jobs::effective_interval`), on a log scale:
    /// factor 0.5 (steadily the cheapest of the game, checked twice as often) → 100, 1 (no trend yet, average) → 50,
    /// 2 (steadily the most expensive, or sold out; checked half as often) → 0. `None` for products that are not
    /// checked for a price: unconfirmed, rejected, switched-off shop, not measured yet.
    pub(crate) fn score(&self) -> Option<i64> {
        (self.review == "confirmed" && self.enabled && self.observed_at.is_some()).then(|| {
            let factor =
                self.pace.unwrap_or(1.0).clamp(0.5, 2.0) * if self.preview { 2.0 } else { 1.0 };
            (50.0 * (1.0 - factor.log2())).round().clamp(0.0, 100.0) as i64
        })
    }
    pub(crate) fn estimate(&self, cents: i64) -> Option<i64> {
        self.fee_estimation_enabled
            .then(|| with_fee(cents, self.fee_basis_points))
    }
    #[cfg(test)]
    pub(crate) fn fixture(
        id: i64,
        review: &str,
        fingerprint: Option<String>,
        observed_at: Option<i64>,
    ) -> Self {
        Self {
            id,
            source: "eneba".into(),
            url: String::new(),
            review: review.into(),
            fingerprint,
            latest: None,
            confirmed_name: None,
            manual_match: false,
            observed_at,
            attempted_at: observed_at,
            last_error: None,
            enabled: true,
            fee_estimation_enabled: false,
            fee_basis_points: 0,
            queued: false,
            retry_at: 0,
            cheap_score: 0.5,
            check_every: None,
            pace: None,
            preview: false,
        }
    }
}

/// Estimated total of a base price with the shop's fee in basis points, rounded to the cent.
pub(crate) fn with_fee(cents: i64, basis_points: i64) -> i64 {
    cents + (cents * basis_points + 5000) / 10000
}

/// Columns of [`Link`] for `offer_link l` joined with its shop (`s`, `p`), item (`t`) and job (`j`, optional).
/// `queued` is the scheduler's [`crate::jobs::pending`]; placeholders as there (`?1` the item or item ids).
fn link_query(filter: &str) -> String {
    format!(
        "SELECT l.*, (s.enabled AND s.configured) AS enabled, s.fee_estimation_enabled, s.fee_basis_points, p.retry_at,
        COALESCE({},0) AS queued,
        CAST(MIN(604800,MAX(MIN(900,s.poll_interval_seconds),ROUND(s.poll_interval_seconds
            *CASE WHEN t.state='preview' THEN 2 ELSE 1 END*j.pace))) AS INTEGER) AS check_every,
        j.pace AS pace, t.state='preview' AS preview
        FROM offer_link l JOIN source_settings s ON s.id=l.source JOIN shop_state p ON p.source=l.source
        JOIN wishlist_item t ON t.id=l.wish_id LEFT JOIN shop_job j ON j.link_id=l.id WHERE {filter} ORDER BY l.id",
        crate::jobs::pending()
    )
}

/// Binds the clock placeholders `?2` to `?5` of the scheduler conditions after `?1`.
pub(crate) fn clock<'q, O>(
    query: sqlx::query::QueryAs<'q, sqlx::Sqlite, O, sqlx::sqlite::SqliteArguments>,
    ts: i64,
) -> sqlx::query::QueryAs<'q, sqlx::Sqlite, O, sqlx::sqlite::SqliteArguments> {
    query
        .bind(ts)
        .bind(ts / 86400)
        .bind(crate::jobs::daily_budget())
        .bind(ts - 900)
}

pub(crate) async fn links<'e>(
    executor: impl sqlx::Executor<'e, Database = sqlx::Sqlite>,
    id: &str,
    ts: i64,
) -> sqlx::Result<Vec<Link>> {
    // check_every follows jobs::effective_interval: twice as long for an edition preview, times the price-trend pace,
    // between 15 minutes (or the shop interval) and a week.
    clock(
        sqlx::query_as(AssertSqlSafe(link_query("l.wish_id=?1"))).bind(id),
        ts,
    )
    .fetch_all(executor)
    .await
}

/// Links of many items in one query, keyed by item id.
pub(crate) async fn links_of_items(
    pool: &SqlitePool,
    ids_json: &str,
    ts: i64,
) -> sqlx::Result<BTreeMap<String, Vec<Link>>> {
    let rows: Vec<ItemLink> = clock(
        sqlx::query_as(AssertSqlSafe(link_query(
            "l.wish_id IN (SELECT value FROM json_each(?1))",
        )))
        .bind(ids_json),
        ts,
    )
    .fetch_all(pool)
    .await?;
    let mut map: BTreeMap<String, Vec<Link>> = BTreeMap::new();
    for row in rows {
        map.entry(row.wish_id).or_default().push(row.link);
    }
    Ok(map)
}

pub(crate) async fn target(pool: &SqlitePool) -> ApiResult<String> {
    Ok(sqlx::query_scalar::<_, Option<String>>(
        "SELECT target_country FROM app_settings WHERE id=1",
    )
    .fetch_one(pool)
    .await?
    .unwrap_or_default())
}

#[derive(Serialize)]
struct OfferView {
    id: String,
    seller: Option<String>,
    base_cents: i64,
    estimated_total_cents: Option<i64>,
}
#[derive(Serialize)]
struct History {
    link_id: i64,
    observed_at: i64,
    base_cents: Option<i64>,
    availability: String,
}
#[derive(Serialize)]
pub(crate) struct OffersView {
    links: Vec<Value>,
    history: Vec<History>,
    histories: HistoryScopes,
    price_badge: crate::price_badges::PriceBadge,
    best_base: Option<i64>,
    best_estimate: Option<i64>,
    /// Lowest price that fails only on age or the latest fetch; never counts as best.
    last_known: Option<pricing::Best>,
    target_country: String,
    discovery_running: bool,
    searches: Vec<Value>,
    sources: Vec<Value>,
}
#[derive(Serialize)]
struct HistoryScopes {
    preferred: Vec<crate::history::Point>,
    all: Vec<crate::history::Point>,
}

pub(crate) async fn list(
    State(state): State<Shared>,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> ApiResult<Json<OffersView>> {
    auth::authenticate(&state, &headers).await?;
    let wish = wish(&state.pool, &id).await?;
    let target = target(&state.pool).await?;
    let t = now();
    // Refresh the activity window of a currently viewed preview; saved wishes are unaffected.
    sqlx::query("UPDATE wishlist_item SET viewed_at=? WHERE id=? AND state='preview' AND COALESCE(viewed_at,0)<?")
        .bind(t)
        .bind(&id)
        .bind(t - 300)
        .execute(&state.pool)
        .await?;
    let mut rows = Vec::new();
    let mut history = Vec::new();
    let mut all_samples = Vec::new();
    let mut preferred_samples = Vec::new();
    let mut best_base = None;
    let mut best_estimate = None;
    let mut last_known: Option<pricing::Best> = None;
    let scope = pricing::Scope::target(&target);
    for link in links(&state.pool, &id, t).await? {
        let product = link.product();
        let matching = product.as_ref().is_some_and(|p| wish.matches(p));
        let confirmed = product.as_ref().is_some_and(|p| link.confirmed(&wish, p));
        let verdict = pricing::evaluate(&link, &wish, product.as_ref(), &scope, t);
        let eligible = verdict.eligible();
        if verdict.last_known()
            && let Some(cents) = product.as_ref().and_then(pricing::min_cents)
            && last_known.is_none_or(|known| cents < known.cents)
        {
            last_known = Some(pricing::Best {
                cents,
                link_id: link.id,
                observed_at: link.observed_at.unwrap_or_default(),
            });
        }
        let quotes: Vec<_> = product
            .iter()
            .flat_map(|p| &p.offers)
            .filter(|q| pricing::valid_cents(q.cents))
            .map(|q| {
                let estimate = link.estimate(q.cents);
                if eligible {
                    update_min(&mut best_base, q.cents);
                    if let Some(estimate) = estimate {
                        update_min(&mut best_estimate, estimate);
                    }
                }
                OfferView {
                    id: q.id.clone(),
                    seller: q.seller.clone(),
                    base_cents: q.cents,
                    estimated_total_cents: estimate,
                }
            })
            .collect();
        if confirmed && let Some(p) = &product {
            let samples: Vec<(i64, String, String, String, String)> = sqlx::query_as(
                "SELECT observed_at,offers,availability,market,activation FROM price_observation
                WHERE link_id=? AND fingerprint=? ORDER BY observed_at DESC LIMIT 180",
            )
            .bind(link.id)
            .bind(p.fingerprint())
            .fetch_all(&state.pool)
            .await?;
            for (observed_at, offers, availability, market, activation) in samples {
                let offers: Vec<shops::Quote> =
                    serde_json::from_str(&offers).map_err(|_| internal())?;
                let cents = offers.into_iter().map(|q| q.cents).min();
                let sample = crate::history::Sample {
                    link_id: link.id,
                    observed_at,
                    base_cents: cents,
                    availability: availability.clone(),
                    region: p.region.clone(),
                    source: link.source.clone(),
                };
                if market == target && activation == "confirmed" {
                    preferred_samples.push(sample.clone());
                    history.push(History {
                        link_id: link.id,
                        observed_at,
                        base_cents: cents,
                        availability,
                    });
                }
                all_samples.push(sample);
            }
        }
        rows.push(json!({"id":link.id,"source":link.source,"url":link.url,
            "review": if confirmed { "confirmed" } else if link.review == "confirmed" { "pending" } else { &link.review },
            "can_confirm":matching,"manual_match":link.manual_match && confirmed,"eligible":eligible,"reasons":verdict,"queued":link.queued,"enabled":link.enabled,"cheap_score":link.cheap_score,"check_every":link.check_every,"score":link.score(),
            "observed_at":link.observed_at,"attempted_at":link.attempted_at,"last_error":link.last_error,
            "retry_at":link.retry_at,"stale":link.observed_at.is_some_and(|at|t-at > FRESH),
            // A confirmed product the shop renamed since: the price counts, the title is worth a look.
            "renamed": product.as_ref().filter(|p| link.review == "confirmed" && link.confirmed_name.as_ref().is_some_and(|name| *name != p.name))
                .map(|p| json!({"from":link.confirmed_name,"to":p.name})),
            "product": product.as_ref().map(|p| json!({"name":p.name,"region":p.region,
                "market":p.purchase_country,"activation":p.activation(&target),"availability":p.availability})),
            "quotes":quotes}));
    }
    history.sort_unstable_by_key(|a| std::cmp::Reverse(a.observed_at));
    // The search of this item and the shop-wide discoveries, pending by the scheduler's own rule. A discovery
    // does not count for a paused item: what it finds waits for the end of the pause.
    type SearchRow = (
        bool,
        String,
        bool,
        i64,
        i64,
        Option<i64>,
        Option<String>,
        Option<i64>,
        bool,
    );
    let (discoveries, search_rows): (Vec<SearchRow>, Vec<SearchRow>) = clock(
        sqlx::query_as(AssertSqlSafe(format!(
            "SELECT j.wish_id IS NULL,j.source,s.enabled AND s.configured,j.due,j.lease_until,j.checked_at,
            COALESCE(j.last_error,p.last_error),j.result_count,COALESCE({},0) AND (j.wish_id IS NOT NULL OR EXISTS(
                SELECT 1 FROM wishlist_item w WHERE w.id=?1 AND (w.paused_at IS NULL OR w.paused_until<=?2)))
            FROM {} WHERE j.wish_id=?1 OR (j.wish_id IS NULL AND j.link_id IS NULL)",
            crate::jobs::pending(),
            crate::jobs::JOBS
        )))
        .bind(&id),
        t,
    )
    .fetch_all(&state.pool)
    .await?
    .into_iter()
    .partition(|row: &SearchRow| row.0);
    let discovery_running = discoveries.iter().any(|row| row.8);
    let searches = search_rows
        .into_iter()
        .map(|(_, source, enabled, due, lease, checked, error, count, pending)| {
            // A due search that does not wait (a pause, the budget or a retry holds it) is paused, never "queued".
            let status = if !enabled {
                "disabled"
            } else if lease > t {
                "searching"
            } else if checked.is_none() || due <= t {
                if !pending {
                    "paused"
                } else if error.is_some() {
                    "error"
                } else {
                    "queued"
                }
            } else if error.is_some() {
                "error"
            } else if count == Some(0) {
                "no_match"
            } else {
                "complete"
            };
            json!({"source":source,"status":status,"checked_at":checked,"last_error":error,"result_count":count})
        })
        .collect();
    let (_, scope) = crate::price_badges::context(&state.pool).await?;
    let price_badge = crate::price_badges::load(&state, &id, &target, &scope).await?;
    Ok(Json(OffersView {
        price_badge,
        links: rows,
        history,
        histories: HistoryScopes {
            preferred: crate::history::minimum_series(&preferred_samples),
            all: crate::history::minimum_series(&all_samples),
        },
        best_base,
        best_estimate,
        last_known,
        target_country: target,
        discovery_running,
        searches,
        sources: source_rows(&state.pool)
            .await?
            .into_iter()
            .map(|(id, status)| json!({"source":id,"status":status}))
            .collect(),
    }))
}

fn update_min(min: &mut Option<i64>, value: i64) {
    *min = Some(min.map_or(value, |old| old.min(value)));
}

#[derive(Deserialize)]
pub(crate) struct AddLink {
    url: String,
}
pub(crate) async fn add_link(
    State(state): State<Shared>,
    Path(id): Path<String>,
    headers: HeaderMap,
    Json(input): Json<AddLink>,
) -> ApiResult<StatusCode> {
    let session = auth::authenticate(&state, &headers).await?;
    auth::require_csrf(&state, &headers, &session)?;
    let (shop, url) = shops::product_link(input.url.trim()).ok_or(BAD_URL)?;
    let enabled: bool =
        sqlx::query_scalar("SELECT enabled AND configured FROM source_settings WHERE id=?")
            .bind(shop.id())
            .fetch_one(&state.pool)
            .await?;
    if !enabled {
        return Err(ApiError(
            StatusCode::UNPROCESSABLE_ENTITY,
            "Schalte diesen Key-Shop zuerst unter Einstellungen › Key-Shops ein.",
        ));
    }
    crate::wishlist::require_unowned(&state.pool, &id).await?;
    wish(&state.pool, &id).await?;
    let mut tx = state.pool.begin().await?;
    let link: Option<i64> = sqlx::query_scalar(
        "INSERT INTO offer_link(wish_id,source,url)
        SELECT ?,?,? WHERE (SELECT count(*) FROM offer_link WHERE wish_id=? AND auto_discovered=0)<16
        ON CONFLICT(wish_id,source,url) DO NOTHING RETURNING id",
    )
    .bind(&id)
    .bind(shop.id())
    .bind(url.as_str())
    .bind(&id)
    .fetch_optional(&mut *tx)
    .await?;
    // Adding a link by hand lifts an earlier deletion of the same product (migration 0020).
    sqlx::query("DELETE FROM offer_link_block WHERE wish_id=? AND source=? AND url=?")
        .bind(&id)
        .bind(shop.id())
        .bind(url.as_str())
        .execute(&mut *tx)
        .await?;
    if let Some(link) = link {
        // The first price of a link added by hand is a direct user action (jobs.rs).
        sqlx::query("INSERT INTO shop_job(source,link_id,due,initial) VALUES(?,?,?,1)")
            .bind(shop.id())
            .bind(link)
            .bind(now())
            .execute(&mut *tx)
            .await?;
    } else {
        let exists: bool =
            sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM offer_link WHERE wish_id=? AND url=?)")
                .bind(&id)
                .bind(url.as_str())
                .fetch_one(&mut *tx)
                .await?;
        if !exists {
            return Err(ApiError(
                StatusCode::CONFLICT,
                "Pro Wunsch sind bis zu 16 manuell ergänzte Produktlinks möglich.",
            ));
        }
    }
    tx.commit().await?;
    if link.is_some() {
        let game = eventlog::game(&state.pool, &id).await;
        log(
            &state,
            format!("{}-Link für {game} von Hand hinzugefügt", shop.name()),
        )
        .await;
    }
    Ok(StatusCode::ACCEPTED)
}

#[derive(Deserialize)]
pub(crate) struct Review {
    decision: String,
    /// The owner looked at the product page and confirms a product whose shop data does not match automatically.
    #[serde(default)]
    manual: bool,
}
const MANUAL_REQUIRED: ApiError = ApiError(
    StatusCode::CONFLICT,
    "Die Shop-Daten passen nicht automatisch zum Spiel. Prüfe die Produktseite und bestätige die Zuordnung ausdrücklich.",
);
pub(crate) async fn review(
    State(state): State<Shared>,
    Path((id, link_id)): Path<(String, i64)>,
    headers: HeaderMap,
    Json(input): Json<Review>,
) -> ApiResult<StatusCode> {
    let session = auth::authenticate(&state, &headers).await?;
    auth::require_csrf(&state, &headers, &session)?;
    crate::wishlist::require_unowned(&state.pool, &id).await?;
    let wish = wish(&state.pool, &id).await?;
    let link = links(&state.pool, &id, now())
        .await?
        .into_iter()
        .find(|l| l.id == link_id)
        .ok_or(NOT_FOUND)?;
    if input.decision == "confirmed" {
        let product = link.product().ok_or(CONFLICT)?;
        let matching = wish.matches(&product);
        if !matching && !input.manual {
            return Err(MANUAL_REQUIRED);
        }
        let changed = sqlx::query("UPDATE offer_link SET review='confirmed', fingerprint=?, confirmed_name=?, manual_match=? WHERE id=? AND wish_id=? AND latest=?")
            .bind(product.fingerprint()).bind(&product.name).bind(!matching).bind(link_id).bind(&id).bind(link.latest).execute(&state.pool).await?;
        if changed.rows_affected() == 0 {
            return Err(CONFLICT);
        }
        let how = if matching {
            "bestätigt"
        } else {
            "von Hand bestätigt"
        };
        log_review(&state, &id, link_id, how).await;
    } else if matches!(input.decision.as_str(), "rejected" | "pending") {
        sqlx::query("UPDATE offer_link SET review=?, fingerprint=NULL, confirmed_name=NULL, manual_match=0 WHERE id=? AND wish_id=?")
            .bind(&input.decision)
            .bind(link_id)
            .bind(&id)
            .execute(&state.pool)
            .await?;
        if input.decision == "pending" {
            sqlx::query("UPDATE shop_job SET due=MIN(due,?) WHERE link_id=? AND lease_until<=?")
                .bind(now())
                .bind(link_id)
                .bind(now())
                .execute(&state.pool)
                .await?;
        }
        let how = if input.decision == "rejected" {
            "abgelehnt"
        } else {
            "zur erneuten Prüfung zurückgesetzt"
        };
        log_review(&state, &id, link_id, how).await;
    } else {
        return Err(ApiError(
            StatusCode::BAD_REQUEST,
            "Ungültige Prüfentscheidung.",
        ));
    }
    Ok(StatusCode::NO_CONTENT)
}

async fn log(state: &Shared, message: String) {
    eventlog::record(&state.pool, Level::Info, Area::Offers, message).await;
}

/// "Eneba-Angebot (Global) für „Forza Horizon 5“ abgelehnt".
async fn log_review(state: &Shared, id: &str, link: i64, how: &str) {
    let offer = eventlog::offer(&state.pool, link).await;
    let game = eventlog::game(&state.pool, id).await;
    log(state, format!("{offer} für {game} {how}")).await;
}

/// Deletes a completely wrong product mapping with its price history. The automatic search does not
/// suggest the product for this wish again (`offer_link_block`); adding the link by hand lifts that.
pub(crate) async fn remove_link(
    State(state): State<Shared>,
    Path((id, link_id)): Path<(String, i64)>,
    headers: HeaderMap,
) -> ApiResult<StatusCode> {
    let session = auth::authenticate(&state, &headers).await?;
    auth::require_csrf(&state, &headers, &session)?;
    crate::wishlist::require_unowned(&state.pool, &id).await?;
    let mut tx = state.pool.begin().await?;
    let blocked = sqlx::query(
        "INSERT INTO offer_link_block(wish_id,source,url,blocked_at)
        SELECT wish_id,source,url,? FROM offer_link WHERE id=? AND wish_id=?
        ON CONFLICT(wish_id,source,url) DO UPDATE SET blocked_at=excluded.blocked_at",
    )
    .bind(now())
    .bind(link_id)
    .bind(&id)
    .execute(&mut *tx)
    .await?;
    if blocked.rows_affected() == 0 {
        return Err(NOT_FOUND);
    }
    let offer = eventlog::offer(&mut *tx, link_id).await;
    // Jobs and price observations go with the link (ON DELETE CASCADE).
    sqlx::query("DELETE FROM offer_link WHERE id=? AND wish_id=?")
        .bind(link_id)
        .bind(&id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    let game = eventlog::game(&state.pool, &id).await;
    log(&state, format!("{offer} für {game} gelöscht")).await;
    Ok(StatusCode::NO_CONTENT)
}

pub(crate) async fn refresh(
    State(state): State<Shared>,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> ApiResult<StatusCode> {
    let session = auth::authenticate(&state, &headers).await?;
    auth::require_csrf(&state, &headers, &session)?;
    crate::wishlist::require_unowned(&state.pool, &id).await?;
    wish(&state.pool, &id).await?;
    let t = now();
    crate::jobs::schedule_wish(&state.pool, &id).await?;
    // A requested refresh gets top priority, also for links whose last fetch failed. The whole
    // search run is a direct user action and bypasses pacing (jobs.rs).
    sqlx::query("UPDATE shop_job SET due=MIN(due,?),requested_at=?,search_page=1,result_count=0,initial=1 WHERE wish_id=? AND lease_until<=? AND COALESCE(checked_at,0)<=?")
        .bind(t).bind(t).bind(&id).bind(t).bind(t-900).execute(&state.pool).await?;
    sqlx::query("UPDATE shop_job SET due=MIN(due,?),requested_at=? WHERE lease_until<=?
        AND link_id IN (SELECT id FROM offer_link WHERE wish_id=? AND review!='rejected' AND COALESCE(attempted_at,0)<=?)")
        .bind(t).bind(t).bind(t).bind(&id).bind(t-900).execute(&state.pool).await?;
    let game = eventlog::game(&state.pool, &id).await;
    log(&state, format!("Aktualisierung für {game} angefordert")).await;
    Ok(StatusCode::ACCEPTED)
}

pub(crate) async fn source_rows(pool: &SqlitePool) -> ApiResult<Vec<(String, Value)>> {
    type ShopStatus = (String, bool, Option<i64>, Option<String>, i64);
    let rows: Vec<ShopStatus> = sqlx::query_as(
        "SELECT s.id,(s.enabled AND s.configured),p.last_success,p.last_error,p.retry_at FROM shop_state p JOIN source_settings s ON s.id=p.source WHERE s.configured=1")
        .fetch_all(pool).await?;
    Ok(rows.into_iter().filter(|(id,..)| Shop::from_id(id).is_some()).map(|(id,enabled,success,error,retry)| {
        let status = if !enabled {"disabled"} else if retry > now() {"paused"} else if error.is_some() {"error"} else if success.is_some() {"ready"} else {"idle"};
        (id,json!({"state":status,"enabled":enabled,"last_success_at":success,"last_error":error,"retry_at":retry}))
    }).collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::shops::{Availability, Quote};

    #[test]
    fn older_xbox_wishes_take_backward_compatible_one_keys_but_only_by_hand() {
        let payload=serde_json::json!({"igdb_id":1,"name":"Fable Anniversary","slug":null,"summary":null,"first_release_date":null,
            "platforms":[{"id":12,"name":"Xbox 360"},{"id":11,"name":"Xbox"}],"aliases":[],"cover_url":null,
            "version_parent":null,"edition_name":null,"kind":"base_game","fetched_at":0}).to_string();
        let mut product = Product {
            id: "fable".into(),
            name: "Fable Anniversary XBOX LIVE Key ARGENTINA".into(),
            title: "Fable Anniversary".into(),
            platform_ids: vec![49, 169],
            key_game: true,
            region: None,
            allowed: vec![],
            blocked: vec![],
            purchase_country: None,
            offers: vec![],
            availability: Availability::Unknown,
        };
        for platform in [12, 11] {
            let wish = Wish::from_parts(platform, None, Some(payload.clone()));
            assert!(wish.matches(&product), "{platform}: confirm by hand");
            assert!(
                !wish.auto_matches(&product),
                "{platform}: never automatically"
            );
        }
        // Only Series X|S: no Xbox One key, no match; a real 360 key matches the 360 wish automatically.
        product.platform_ids = vec![169];
        assert!(!Wish::from_parts(12, None, Some(payload.clone())).matches(&product));
        product.platform_ids = vec![12];
        assert!(Wish::from_parts(12, None, Some(payload.clone())).auto_matches(&product));
        assert!(!Wish::from_parts(11, None, Some(payload)).matches(&product));
    }

    #[test]
    fn score_follows_the_check_interval_factor() {
        let mut link = Link::fixture(1, "confirmed", None, Some(1));
        for (pace, preview, score) in [
            (Some(0.5), false, 100),
            (Some(0.707), false, 75),
            (Some(1.0), false, 50),
            (None, false, 50),
            (Some(1.414), false, 25),
            (Some(2.0), false, 0),
            (Some(0.5), true, 50),
            (Some(1.0), true, 0),
        ] {
            link.pace = pace;
            link.preview = preview;
            assert_eq!(link.score(), Some(score), "{pace:?} {preview}");
        }
        assert_eq!(Link::fixture(1, "pending", None, Some(1)).score(), None);
        assert_eq!(
            Link::fixture(1, "confirmed", None, None).score(),
            None,
            "not measured yet"
        );
        link.enabled = false;
        assert_eq!(link.score(), None, "switched-off shop");
    }

    #[test]
    fn automatic_confirmation_requires_catalog_identity() {
        let payload=serde_json::json!({"igdb_id":1,"name":"Forza Horizon 5","slug":null,"summary":null,"first_release_date":null,
            "platforms":[{"id":169,"name":"Xbox Series X|S"}],"aliases":["Unrelated Name"],"cover_url":null,
            "version_parent":null,"edition_name":null,"kind":"base_game","fetched_at":0}).to_string();
        let wish = Wish::from_parts(169, None, Some(payload));
        let mut p = Product {
            id: "test".into(),
            name: "Forza Horizon 5".into(),
            title: "Forza Horizon 5".into(),
            platform_ids: vec![169],
            key_game: true,
            region: None,
            allowed: vec![],
            blocked: vec![],
            purchase_country: None,
            offers: vec![],
            availability: Availability::Unknown,
        };
        assert!(wish.auto_matches(&p));
        assert!(!Wish::from_parts(169, Some("Forza Horizon 5".into()), None).auto_matches(&p));
        for title in [
            "Forza Horizon 5 Premium Edition",
            "Forza Horizon 5 Remaster",
            "Forza Horizon 6",
            "Unrelated Name",
        ] {
            p.title = title.into();
            assert!(!wish.auto_matches(&p));
        }
        p.title = "Forza Horizon 5".into();
        p.platform_ids = vec![6];
        assert!(!wish.auto_matches(&p));
        p.platform_ids = vec![169];
        p.key_game = false;
        assert!(!wish.auto_matches(&p));
    }
    #[test]
    fn exact_product_scope_and_price_quality() {
        let wish = Wish::from_parts(169, Some("Forza Horizon 5".into()), None);
        let mut product = Product {
            id: "test".into(),
            name: "Forza Horizon 5".into(),
            title: "Forza Horizon 5".into(),
            platform_ids: vec![169, 49],
            key_game: true,
            region: Some("Global".into()),
            allowed: vec!["DE".into()],
            blocked: vec![],
            purchase_country: Some("DE".into()),
            offers: vec![Quote {
                id: "offer".into(),
                cents: 2392,
                seller: None,
            }],
            availability: Availability::InStock,
        };
        let mut link = Link {
            id: 1,
            source: "eneba".into(),
            url: "".into(),
            review: "confirmed".into(),
            fingerprint: Some(product.fingerprint()),
            latest: None,
            confirmed_name: None,
            manual_match: false,
            observed_at: Some(200),
            attempted_at: Some(200),
            last_error: None,
            enabled: true,
            fee_estimation_enabled: true,
            fee_basis_points: 200,
            queued: false,
            retry_at: 0,
            cheap_score: 0.5,
            check_every: None,
            pace: None,
            preview: false,
        };
        assert_eq!(link.estimate(2392), Some(2440));
        link.fee_estimation_enabled = false;
        assert_eq!(link.estimate(2392), None);
        assert!(link.confirmed(&wish, &product));
        for title in [
            "Forza Horizon 5 Premium Edition",
            "Forza Horizon 5 Remastered",
            "Forza Horizon 6",
            "Forza Horizon 5: Hot Wheels",
            "Forza Horizon 5 Premium Add-On Bundle",
            "Forza Horizon 5 Account",
        ] {
            product.title = title.into();
            assert!(!wish.matches(&product), "{title}");
        }
        product.title = "Forza Horizon 5".into();
        product.platform_ids = vec![6];
        assert!(!wish.matches(&product));
        product.platform_ids = vec![169];
        product.key_game = false;
        assert!(!wish.matches(&product));
        assert!(!link.confirmed(&wish, &product), "the fingerprint changed");
        // Confirmed by hand: counts although the shop data does not match, for exactly this product.
        product.key_game = true;
        product.platform_ids = vec![169, 49];
        product.title = "Forza Horizon 5 Premium Edition".into();
        link.manual_match = true;
        assert!(link.confirmed(&wish, &product));
        link.manual_match = false;
        assert!(!link.confirmed(&wish, &product));
    }
}
