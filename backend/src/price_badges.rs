use crate::{
    ApiError, ApiResult, Shared, auth, now, offers,
    pricing::{self, Reason},
};
use axum::{
    Json,
    extract::{Query, State},
    http::{HeaderMap, StatusCode},
};
use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;
use std::collections::BTreeMap;

#[derive(Clone, Serialize)]
pub(crate) struct PriceBadge {
    pub cents: Option<i64>,
    pub state: &'static str,
    pub observed_at: Option<i64>,
    pub checked_at: Option<i64>,
    pub stale: bool,
    pub pending: bool,
}

pub(crate) async fn context(pool: &SqlitePool) -> ApiResult<(String, String)> {
    let (target, scope): (Option<String>, String) =
        sqlx::query_as("SELECT target_country, wishlist_price_scope FROM app_settings WHERE id=1")
            .fetch_one(pool)
            .await?;
    Ok((target.unwrap_or_default(), scope))
}

/// Display a saved observation; live alert eligibility remains stricter.
pub(crate) async fn load(
    pool: &SqlitePool,
    id: &str,
    target: &str,
    scope: &str,
) -> ApiResult<PriceBadge> {
    let t = now();
    let wish = offers::wish(pool, id).await?;
    let (checked,failed,pending):(Option<i64>,bool,bool)=sqlx::query_as("SELECT MAX(j.checked_at),COALESCE(MAX(j.last_error IS NOT NULL),0),COALESCE(MAX((j.lease_until>? OR j.due<=?) AND s.enabled AND s.configured AND (j.link_id IS NULL OR l.review!='rejected') AND NOT EXISTS(SELECT 1 FROM library_item b WHERE b.track_id=COALESCE(j.wish_id,l.wish_id)) AND p.retry_at<=? AND (p.budget_day!=? OR p.jobs_today<?)),0) FROM shop_job j JOIN source_settings s ON s.id=j.source JOIN shop_state p ON p.source=j.source LEFT JOIN offer_link l ON l.id=j.link_id WHERE j.wish_id=? OR l.wish_id=?")
        .bind(t).bind(t).bind(t).bind(t/86400).bind(crate::jobs::daily_budget()).bind(id).bind(id).fetch_one(pool).await?;
    let mut result = PriceBadge {
        cents: None,
        state: "unknown",
        observed_at: None,
        checked_at: checked,
        stale: false,
        pending,
    };
    let mut observed = false;
    let mut review = false;
    let mut error = failed;
    let price_scope = pricing::Scope::for_wishlist(target, scope);
    let links = offers::links(pool, id, t).await?;
    let mut candidates = Vec::new();
    for link in &links {
        result.checked_at = result
            .checked_at
            .max(link.attempted_at)
            .max(link.observed_at);
        error |= link.last_error.is_some();
        let Some(product) = link.product() else {
            continue;
        };
        observed = true;
        let verdict = pricing::evaluate(link, &wish, Some(&product), &price_scope, t);
        if verdict.has(Reason::SourceDisabled)
            || verdict.has(Reason::Rejected)
            || verdict.has(Reason::Mismatch)
        {
            continue;
        }
        if verdict.has(Reason::NotConfirmed) {
            review = true;
            continue;
        }
        candidates.push((link, product, verdict));
    }
    // A current price wins; otherwise the last known one is shown, marked as stale.
    let prices = pricing::best(
        candidates
            .iter()
            .map(|(link, product, verdict)| (*link, product, verdict)),
        pricing::base,
    );
    if let Some((best, stale)) = prices
        .current
        .map(|best| (best, false))
        .or(prices.last_known.map(|best| (best, true)))
    {
        result.cents = Some(best.cents);
        result.observed_at = Some(best.observed_at);
        result.stale = stale;
    }
    result.state = if result.cents.is_some() {
        "price"
    } else if review {
        "review"
    } else if observed {
        "no_offer"
    } else if error {
        "error"
    } else if result.checked_at.is_some() {
        "no_offer"
    } else {
        "unknown"
    };
    Ok(result)
}

#[derive(Deserialize)]
pub(crate) struct BadgeQuery {
    /// An empty anchor requests only the wishlist. No parameter includes all watched editions.
    anchor: Option<String>,
}

pub(crate) async fn list(
    State(state): State<Shared>,
    headers: HeaderMap,
    Query(query): Query<BadgeQuery>,
) -> ApiResult<Json<BTreeMap<String, PriceBadge>>> {
    auth::authenticate(&state, &headers).await?;
    let (target, scope) = context(&state.pool).await?;
    let ids:Vec<String>=sqlx::query_scalar("SELECT w.id FROM wishlist_item w WHERE NOT EXISTS(SELECT 1 FROM library_item b WHERE b.track_id=w.id) AND (NOT EXISTS(SELECT 1 FROM edition_preview p WHERE p.track_id=w.id) OR EXISTS(SELECT 1 FROM edition_watch e JOIN wishlist_item a ON a.id=e.wish_id WHERE e.track_id=w.id AND (?1 IS NULL OR a.id=?1) AND NOT EXISTS(SELECT 1 FROM library_item b WHERE b.track_id=a.id) AND NOT EXISTS(SELECT 1 FROM edition_preview p WHERE p.track_id=a.id)))").bind(query.anchor).fetch_all(&state.pool).await?;
    let mut entries = BTreeMap::new();
    for id in ids {
        match load(&state.pool, &id, &target, &scope).await {
            Ok(badge) => {
                entries.insert(id, badge);
            }
            Err(ApiError(StatusCode::NOT_FOUND, _)) => continue,
            Err(error) => return Err(error),
        }
    }
    Ok(Json(entries))
}
