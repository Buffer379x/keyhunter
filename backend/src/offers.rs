use crate::{
    ApiError, ApiResult, Shared, auth, internal, now, pricing,
    shops::{self, Product, Shop, title_key},
};
use axum::{
    Json,
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::{FromRow, SqlitePool};
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
    pub(crate) fn matches(&self, product: &Product) -> bool {
        product.key_game
            && product.platform_ids.contains(&self.platform_id)
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
}
impl Link {
    /// Fingerprint stored at confirmation.
    pub(crate) fn fingerprint(&self) -> Option<&str> {
        self.fingerprint.as_deref()
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
    pub(crate) fn estimate(&self, cents: i64) -> Option<i64> {
        self.fee_estimation_enabled
            .then(|| cents + (cents * self.fee_basis_points + 5000) / 10000)
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
        }
    }
}

pub(crate) async fn links<'e>(
    executor: impl sqlx::Executor<'e, Database = sqlx::Sqlite>,
    id: &str,
    ts: i64,
) -> sqlx::Result<Vec<Link>> {
    // check_every follows jobs::effective_interval: three times as long when not valid in the target country, twice for
    // an edition preview, times the price-trend pace, between 15 minutes (or the shop interval) and a week.
    sqlx::query_as("SELECT l.*, (s.enabled AND s.configured) AS enabled, s.fee_estimation_enabled, s.fee_basis_points, p.retry_at,
        COALESCE(j.lease_until>?,0) OR COALESCE(j.due<=? AND s.enabled AND p.retry_at<=? AND (p.budget_day!=? OR p.jobs_today<COALESCE(s.daily_jobs,?)),0) AS queued,
        CAST(MIN(604800,MAX(MIN(900,s.poll_interval_seconds),ROUND(s.poll_interval_seconds*CASE WHEN j.relevance=2 THEN 3 ELSE 1 END
            *CASE WHEN w.state='preview' THEN 2 ELSE 1 END*j.pace))) AS INTEGER) AS check_every
        FROM offer_link l JOIN source_settings s ON s.id=l.source JOIN shop_state p ON p.source=l.source
        JOIN wishlist_item w ON w.id=l.wish_id LEFT JOIN shop_job j ON j.link_id=l.id WHERE l.wish_id=? ORDER BY l.id")
        .bind(ts).bind(ts).bind(ts).bind(ts/86400).bind(crate::jobs::daily_budget()).bind(id).fetch_all(executor).await
}

/// Links of many items in one query, keyed by item id.
pub(crate) async fn links_of_items(
    pool: &SqlitePool,
    ids_json: &str,
    ts: i64,
) -> sqlx::Result<BTreeMap<String, Vec<Link>>> {
    let rows: Vec<ItemLink> = sqlx::query_as("SELECT l.*, (s.enabled AND s.configured) AS enabled, s.fee_estimation_enabled, s.fee_basis_points, p.retry_at,
        COALESCE(j.lease_until>?,0) OR COALESCE(j.due<=? AND s.enabled AND p.retry_at<=? AND (p.budget_day!=? OR p.jobs_today<COALESCE(s.daily_jobs,?)),0) AS queued
        FROM offer_link l JOIN source_settings s ON s.id=l.source JOIN shop_state p ON p.source=l.source
        LEFT JOIN shop_job j ON j.link_id=l.id WHERE l.wish_id IN (SELECT value FROM json_each(?)) ORDER BY l.id")
        .bind(ts).bind(ts).bind(ts).bind(ts/86400).bind(crate::jobs::daily_budget()).bind(ids_json).fetch_all(pool).await?;
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
            "can_confirm":matching,"manual_match":link.manual_match && confirmed,"eligible":eligible,"reasons":verdict,"queued":link.queued,"enabled":link.enabled,"cheap_score":link.cheap_score,"check_every":link.check_every,
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
    let discovery_running: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM shop_job j JOIN shop_state p ON p.source=j.source JOIN source_settings s ON s.id=j.source
        WHERE j.link_id IS NULL AND j.wish_id IS NULL AND s.enabled AND s.configured AND p.retry_at<=? AND j.due<=? AND (p.budget_day!=? OR p.jobs_today<COALESCE(s.daily_jobs,?)))").bind(t).bind(t).bind(t/86400).bind(crate::jobs::daily_budget()).fetch_one(&state.pool).await?;
    type SearchRow = (
        String,
        bool,
        i64,
        i64,
        Option<i64>,
        Option<String>,
        Option<i64>,
        bool,
    );
    let search_rows:Vec<SearchRow> = sqlx::query_as(
        "SELECT j.source,s.enabled,j.due,j.lease_until,j.checked_at,COALESCE(j.last_error,p.last_error),j.result_count,
        (p.retry_at>? OR (p.budget_day=? AND p.jobs_today>=COALESCE(s.daily_jobs,?))) FROM shop_job j
        JOIN source_settings s ON s.id=j.source JOIN shop_state p ON p.source=j.source WHERE j.wish_id=?")
        .bind(t).bind(t/86400).bind(crate::jobs::daily_budget()).bind(&id).fetch_all(&state.pool).await?;
    let searches=search_rows.into_iter().map(|(source,enabled,due,lease,checked,error,count,paused)| {
        let status=if !enabled {"disabled"} else if paused {"paused"} else if lease>t {"searching"}
            else if error.is_some() {"error"} else if checked.is_none() || due<=t {"queued"} else if count==Some(0) {"no_match"} else {"complete"};
        json!({"source":source,"status":status,"checked_at":checked,"last_error":error,"result_count":count})
    }).collect();
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
    let configured: bool = sqlx::query_scalar("SELECT configured FROM source_settings WHERE id=?")
        .bind(shop.id())
        .fetch_one(&state.pool)
        .await?;
    if !configured {
        return Err(ApiError(
            StatusCode::UNPROCESSABLE_ENTITY,
            "Füge diesen Key-Shop zuerst in den Einstellungen hinzu.",
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
    } else {
        return Err(ApiError(
            StatusCode::BAD_REQUEST,
            "Ungültige Prüfentscheidung.",
        ));
    }
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
        .bind(t).bind(t).bind(t).bind(id).bind(t-900).execute(&state.pool).await?;
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
