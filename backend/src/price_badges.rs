use crate::{ApiResult, Shared, auth, now, offers, shops::Availability};
use axum::{Json, extract::State, http::HeaderMap};
use serde::Serialize;
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
    let target = offers::target(pool).await?;
    let scope = sqlx::query_scalar("SELECT wishlist_price_scope FROM app_settings WHERE id=1")
        .fetch_one(pool)
        .await?;
    Ok((target, scope))
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
    let (checked,failed,pending):(Option<i64>,bool,bool)=sqlx::query_as("SELECT MAX(j.checked_at),COALESCE(MAX(j.last_error IS NOT NULL),0),COALESCE(MAX((j.lease_until>? OR j.due<=?) AND s.enabled AND s.configured AND NOT EXISTS(SELECT 1 FROM library_item b WHERE b.track_id=COALESCE(j.wish_id,l.wish_id)) AND p.retry_at<=? AND (p.budget_day!=? OR p.jobs_today<?)),0) FROM shop_job j JOIN source_settings s ON s.id=j.source JOIN shop_state p ON p.source=j.source LEFT JOIN offer_link l ON l.id=j.link_id WHERE j.wish_id=? OR l.wish_id=?")
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
    for link in offers::links(pool, id, t).await? {
        result.checked_at = result
            .checked_at
            .max(link.attempted_at)
            .max(link.observed_at);
        error |= link.last_error.is_some();
        let Some(product) = link.product() else {
            continue;
        };
        observed = true;
        if !link.enabled || link.review == "rejected" || !wish.matches(&product) {
            continue;
        }
        if !link.confirmed(&wish, &product) {
            review = true;
            continue;
        }
        if product.availability != Availability::InStock
            || (scope != "all"
                && (product.activation(target) != "confirmed"
                    || product.purchase_country.as_deref() != Some(target)))
        {
            continue;
        }
        let Some(at) = link.observed_at.filter(|at| *at <= t) else {
            continue;
        };
        for quote in &product.offers {
            if !(0..=10_000_000).contains(&quote.cents) {
                continue;
            }
            if result.cents.is_none_or(|old| quote.cents < old)
                || (result.cents == Some(quote.cents)
                    && result.observed_at.is_none_or(|old| at > old))
            {
                result.cents = Some(quote.cents);
                result.observed_at = Some(at);
                result.stale =
                    t - at > offers::FRESH || link.last_error.is_some() || link.retry_at > t;
            }
        }
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

pub(crate) async fn list(
    State(state): State<Shared>,
    headers: HeaderMap,
) -> ApiResult<Json<BTreeMap<String, PriceBadge>>> {
    auth::authenticate(&state, &headers).await?;
    let (target, scope) = context(&state.pool).await?;
    let ids:Vec<String>=sqlx::query_scalar("SELECT w.id FROM wishlist_item w WHERE NOT EXISTS(SELECT 1 FROM library_item b WHERE b.track_id=w.id) AND (NOT EXISTS(SELECT 1 FROM edition_preview p WHERE p.track_id=w.id) OR EXISTS(SELECT 1 FROM edition_watch e JOIN wishlist_item a ON a.id=e.wish_id WHERE e.track_id=w.id AND NOT EXISTS(SELECT 1 FROM library_item b WHERE b.track_id=a.id) AND NOT EXISTS(SELECT 1 FROM edition_preview p WHERE p.track_id=a.id)))").fetch_all(&state.pool).await?;
    let mut entries = BTreeMap::new();
    for id in ids {
        entries.insert(id.clone(), load(&state.pool, &id, &target, &scope).await?);
    }
    Ok(Json(entries))
}
