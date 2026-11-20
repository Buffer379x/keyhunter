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
    /// Cheapest current offer of any region, always reported for the comparison with the
    /// target country (the core use case), independent of the badge setting.
    pub world: Option<WorldBest>,
}

#[derive(Clone, Serialize)]
pub(crate) struct WorldBest {
    pub cents: i64,
    pub region: Option<String>,
    pub observed_at: i64,
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
    load_many(pool, &[id.to_string()], target, scope)
        .await?
        .remove(id)
        .ok_or(ApiError(
            StatusCode::NOT_FOUND,
            "Wunschlisteneintrag nicht gefunden.",
        ))
}

#[derive(sqlx::FromRow)]
struct JobSummary {
    item: String,
    checked: Option<i64>,
    failed: bool,
    pending: bool,
}

/// Badges for many items with three queries in total, independent of the number of items.
pub(crate) async fn load_many(
    pool: &SqlitePool,
    ids: &[String],
    target: &str,
    scope: &str,
) -> ApiResult<BTreeMap<String, PriceBadge>> {
    let t = now();
    let ids_json = serde_json::to_string(ids).map_err(|_| crate::internal())?;
    let wishes = offers::wishes(pool, &ids_json).await?;
    let mut links = offers::links_of_items(pool, &ids_json, t).await?;
    let jobs: Vec<JobSummary> = sqlx::query_as("SELECT COALESCE(j.wish_id,l.wish_id) AS item,MAX(j.checked_at) AS checked,COALESCE(MAX(j.last_error IS NOT NULL),0) AS failed,COALESCE(MAX((j.lease_until>?1 OR j.due<=?1) AND s.enabled AND s.configured AND (j.link_id IS NULL OR l.review!='rejected') AND COALESCE(w.state,'wished')!='owned' AND p.retry_at<=?1 AND (p.budget_day!=?2 OR p.jobs_today<COALESCE(s.daily_jobs,?3))),0) AS pending
        FROM shop_job j JOIN source_settings s ON s.id=j.source JOIN shop_state p ON p.source=j.source LEFT JOIN offer_link l ON l.id=j.link_id
        LEFT JOIN wishlist_item w ON w.id=COALESCE(j.wish_id,l.wish_id)
        WHERE COALESCE(j.wish_id,l.wish_id) IN (SELECT value FROM json_each(?4)) GROUP BY 1")
        .bind(t).bind(t / 86400).bind(crate::jobs::daily_budget()).bind(&ids_json).fetch_all(pool).await?;
    let mut jobs: BTreeMap<String, JobSummary> =
        jobs.into_iter().map(|j| (j.item.clone(), j)).collect();
    let price_scope = pricing::Scope::for_wishlist(target, scope);
    Ok(wishes
        .into_iter()
        .map(|(id, wish)| {
            let job = jobs.remove(&id);
            let badge = compute(
                &wish,
                &links.remove(&id).unwrap_or_default(),
                job.as_ref(),
                &price_scope,
                t,
            );
            (id, badge)
        })
        .collect())
}

fn compute(
    wish: &offers::Wish,
    links: &[offers::Link],
    job: Option<&JobSummary>,
    price_scope: &pricing::Scope,
    t: i64,
) -> PriceBadge {
    let mut result = PriceBadge {
        cents: None,
        state: "unknown",
        observed_at: None,
        checked_at: job.and_then(|j| j.checked),
        stale: false,
        pending: job.is_some_and(|j| j.pending),
        world: None,
    };
    let mut observed = false;
    let mut review = false;
    let mut error = job.is_some_and(|j| j.failed);
    let mut candidates = Vec::new();
    for link in links {
        result.checked_at = result
            .checked_at
            .max(link.attempted_at)
            .max(link.observed_at);
        error |= link.last_error.is_some();
        let Some(product) = link.product() else {
            continue;
        };
        observed = true;
        let verdict = pricing::evaluate(link, wish, Some(&product), price_scope, t);
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
        let anywhere =
            pricing::evaluate(link, wish, Some(&product), &pricing::Scope::AllRegions, t);
        candidates.push((link, product, verdict, anywhere));
    }
    let world = pricing::best(
        candidates
            .iter()
            .map(|(link, product, _, anywhere)| (*link, product, anywhere)),
        pricing::base,
    )
    .current;
    result.world = world.map(|best| WorldBest {
        cents: best.cents,
        region: candidates
            .iter()
            .find(|(link, ..)| link.id == best.link_id)
            .and_then(|(_, product, ..)| product.region.clone()),
        observed_at: best.observed_at,
    });
    // A current price wins; otherwise the last known one is shown, marked as stale.
    let prices = pricing::best(
        candidates
            .iter()
            .map(|(link, product, verdict, _)| (*link, product, verdict)),
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
    result
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
    let ids:Vec<String>=sqlx::query_scalar("SELECT w.id FROM wishlist_item w WHERE w.state!='owned' AND (w.state='wished' OR EXISTS(SELECT 1 FROM edition_watch e JOIN wishlist_item a ON a.id=e.wish_id WHERE e.track_id=w.id AND (?1 IS NULL OR a.id=?1) AND a.state='wished'))").bind(query.anchor).fetch_all(&state.pool).await?;
    Ok(Json(load_many(&state.pool, &ids, &target, &scope).await?))
}
