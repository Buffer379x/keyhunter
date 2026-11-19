use crate::{
    ApiError, ApiResult, Shared, auth, internal, now,
    shops::{self, Availability, Product, Shop, title_key},
};
use axum::{
    Json,
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::{FromRow, SqlitePool};

pub(crate) const FRESH: i64 = 24 * 3600;
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

pub(crate) async fn wish(pool: &SqlitePool, id: &str) -> ApiResult<Wish> {
    sqlx::query_as("SELECT w.platform_id,g.manual_title,c.payload FROM wishlist_item w JOIN game g ON g.id=w.game_id LEFT JOIN catalog_game c ON c.igdb_id=g.igdb_id WHERE w.id=?")
        .bind(id).fetch_optional(pool).await?.ok_or(NOT_FOUND)
}

#[derive(FromRow)]
pub(crate) struct Link {
    pub id: i64,
    pub source: String,
    url: String,
    pub(crate) review: String,
    fingerprint: Option<String>,
    latest: Option<String>,
    pub observed_at: Option<i64>,
    pub attempted_at: Option<i64>,
    pub last_error: Option<String>,
    pub enabled: bool,
    pub fee_estimation_enabled: bool,
    pub fee_basis_points: i64,
    pub queued: bool,
    pub retry_at: i64,
}
impl Link {
    pub(crate) fn product(&self) -> Option<Product> {
        serde_json::from_str(self.latest.as_deref()?).ok()
    }
    pub(crate) fn confirmed(&self, wish: &Wish, product: &Product) -> bool {
        self.review == "confirmed"
            && wish.matches(product)
            && self.fingerprint.as_deref() == Some(product.fingerprint().as_str())
    }
    pub(crate) fn available(&self, wish: &Wish, product: &Product, target: &str, ts: i64) -> bool {
        self.available_globally(wish, product, ts)
            && product.activation(target) == "confirmed"
            && product.purchase_country.as_deref() == Some(target)
    }
    pub(crate) fn available_globally(&self, wish: &Wish, product: &Product, ts: i64) -> bool {
        self.enabled
            && self.retry_at <= ts
            && self.last_error.is_none()
            && self.observed_at.is_some_and(|t| t <= ts && ts - t <= FRESH)
            && product.availability == Availability::InStock
            && self.confirmed(wish, product)
    }
    pub(crate) fn estimate(&self, cents: i64) -> Option<i64> {
        self.fee_estimation_enabled
            .then(|| cents + (cents * self.fee_basis_points + 5000) / 10000)
    }
}

pub(crate) async fn links<'e>(
    executor: impl sqlx::Executor<'e, Database = sqlx::Sqlite>,
    id: &str,
    ts: i64,
) -> sqlx::Result<Vec<Link>> {
    sqlx::query_as("SELECT l.*, (s.enabled AND s.configured) AS enabled, s.fee_estimation_enabled, s.fee_basis_points, p.retry_at,
        COALESCE(j.lease_until>?,0) OR COALESCE(j.due<=? AND s.enabled AND p.retry_at<=? AND (p.budget_day!=? OR p.jobs_today<?),0) AS queued
        FROM offer_link l JOIN source_settings s ON s.id=l.source JOIN shop_state p ON p.source=l.source
        LEFT JOIN shop_job j ON j.link_id=l.id WHERE l.wish_id=? ORDER BY l.id")
        .bind(ts).bind(ts).bind(ts).bind(ts/86400).bind(crate::jobs::daily_budget()).bind(id).fetch_all(executor).await
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
    sqlx::query("UPDATE edition_preview SET viewed_at=? WHERE track_id=? AND viewed_at<?")
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
    for link in links(&state.pool, &id, t).await? {
        let product = link.product();
        let matching = product.as_ref().is_some_and(|p| wish.matches(p));
        let confirmed = product.as_ref().is_some_and(|p| link.confirmed(&wish, p));
        let eligible = product
            .as_ref()
            .is_some_and(|p| link.available(&wish, p, &target, t));
        let quotes: Vec<_> = product
            .iter()
            .flat_map(|p| &p.offers)
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
            "can_confirm":matching,"eligible":eligible,"queued":link.queued,"enabled":link.enabled,
            "observed_at":link.observed_at,"attempted_at":link.attempted_at,"last_error":link.last_error,
            "retry_at":link.retry_at,"stale":link.observed_at.is_some_and(|at|t-at > FRESH),
            "product": product.as_ref().map(|p| json!({"name":p.name,"region":p.region,
                "market":p.purchase_country,"activation":p.activation(&target),"availability":p.availability})),
            "quotes":quotes}));
    }
    history.sort_unstable_by_key(|a| std::cmp::Reverse(a.observed_at));
    let discovery_running: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM shop_job j JOIN shop_state p ON p.source=j.source JOIN source_settings s ON s.id=j.source
        WHERE j.link_id IS NULL AND j.wish_id IS NULL AND s.enabled AND s.configured AND p.retry_at<=? AND j.due<=? AND (p.budget_day!=? OR p.jobs_today<?))").bind(t).bind(t).bind(t/86400).bind(crate::jobs::daily_budget()).fetch_one(&state.pool).await?;
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
        (p.retry_at>? OR (p.budget_day=? AND p.jobs_today>=?)) FROM shop_job j
        JOIN source_settings s ON s.id=j.source JOIN shop_state p ON p.source=j.source WHERE j.wish_id=?")
        .bind(t).bind(t/86400).bind(crate::jobs::daily_budget()).bind(&id).fetch_all(&state.pool).await?;
    let searches=search_rows.into_iter().map(|(source,enabled,due,lease,checked,error,count,paused)| {
        let status=if !enabled {"disabled"} else if paused {"paused"} else if lease>t {"searching"}
            else if error.is_some() {"error"} else if checked.is_none() || due<=t {"queued"} else if count==Some(0) {"no_match"} else {"complete"};
        json!({"source":source,"status":status,"checked_at":checked,"last_error":error,"result_count":count})
    }).collect();
    let (_, scope) = crate::price_badges::context(&state.pool).await?;
    let price_badge = crate::price_badges::load(&state.pool, &id, &target, &scope).await?;
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
        sqlx::query("INSERT INTO shop_job(source,link_id,due) VALUES(?,?,?)")
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
}
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
        let product = link.product().filter(|p| wish.matches(p)).ok_or(CONFLICT)?;
        let changed = sqlx::query("UPDATE offer_link SET review='confirmed', fingerprint=? WHERE id=? AND wish_id=? AND latest=?")
            .bind(product.fingerprint()).bind(link_id).bind(&id).bind(link.latest).execute(&state.pool).await?;
        if changed.rows_affected() == 0 {
            return Err(CONFLICT);
        }
    } else if matches!(input.decision.as_str(), "rejected" | "pending") {
        sqlx::query("UPDATE offer_link SET review=?, fingerprint=NULL WHERE id=? AND wish_id=?")
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
    sqlx::query("UPDATE shop_job SET due=MIN(due,?),search_page=1,result_count=0 WHERE wish_id=? AND lease_until<=? AND COALESCE(checked_at,0)<=?")
        .bind(t).bind(&id).bind(t).bind(t-900).execute(&state.pool).await?;
    sqlx::query("UPDATE shop_job SET due=MIN(due,?) WHERE lease_until<=? AND failures=0
        AND link_id IN (SELECT id FROM offer_link WHERE wish_id=? AND review!='rejected' AND last_error IS NULL AND COALESCE(attempted_at,0)<=?)")
        .bind(t).bind(t).bind(id).bind(t-900).execute(&state.pool).await?;
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

pub(crate) async fn wishlist_prices(
    State(state): State<Shared>,
    headers: HeaderMap,
) -> ApiResult<Json<Value>> {
    auth::authenticate(&state, &headers).await?;
    let target = target(&state.pool).await?;
    let scope: String =
        sqlx::query_scalar("SELECT wishlist_price_scope FROM app_settings WHERE id=1")
            .fetch_one(&state.pool)
            .await?;
    let ids: Vec<String> = sqlx::query_scalar("SELECT id FROM wishlist_item w WHERE NOT EXISTS(SELECT 1 FROM edition_preview p WHERE p.track_id=w.id) AND NOT EXISTS(SELECT 1 FROM library_item b WHERE b.track_id=w.id)")
        .fetch_all(&state.pool)
        .await?;
    let mut prices = serde_json::Map::new();
    let time = now();
    for id in ids {
        let wish = wish(&state.pool, &id).await?;
        let mut best = None;
        for link in links(&state.pool, &id, time).await? {
            if let Some(p) = link.product().filter(|p| {
                if scope == "all" {
                    link.available_globally(&wish, p, time)
                } else {
                    link.available(&wish, p, &target, time)
                }
            }) {
                for quote in p.offers {
                    update_min(&mut best, quote.cents);
                }
            }
        }
        prices.insert(id, json!(best));
    }
    Ok(Json(Value::Object(prices)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::shops::Quote;

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
            observed_at: Some(200),
            attempted_at: Some(200),
            last_error: None,
            enabled: true,
            fee_estimation_enabled: true,
            fee_basis_points: 200,
            queued: false,
            retry_at: 0,
        };
        assert!(link.available(&wish, &product, "DE", 201));
        assert_eq!(link.estimate(2392), Some(2440));
        link.fee_estimation_enabled = false;
        assert_eq!(link.estimate(2392), None);
        assert!(!link.available(&wish, &product, "AT", 201));
        assert!(link.available_globally(&wish, &product, 201));
        assert!(!link.available_globally(&wish, &product, 201 + FRESH));
        assert!(!link.available(&wish, &product, "DE", 201 + FRESH));
        product.blocked.push("DE".into());
        assert!(!link.available(&wish, &product, "DE", 201));
        product.blocked.clear();
        link.last_error = Some("network".into());
        assert!(!link.available(&wish, &product, "DE", 201));
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
    }
}
