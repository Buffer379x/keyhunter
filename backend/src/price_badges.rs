use crate::shops::Product;
use crate::{
    ApiError, ApiResult, AppState, Shared, auth, now, offers,
    pricing::{self, Reason},
};
use axum::{
    Json,
    extract::{Query, State},
    http::{HeaderMap, StatusCode},
};
use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;
use std::{
    collections::{BTreeMap, HashMap},
    sync::Mutex,
};

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
    /// Shop and region of `cents` (the target-country price, or the scope's best).
    pub source: Option<String>,
    pub region: Option<String>,
    /// Best price valid in the target country at the end of each of the last 14 UTC days,
    /// oldest first (today: now). Each link carries its last observation forward; `None`
    /// before the first observation or while no confirmed link has a valid price.
    pub trend: Vec<Option<i64>>,
    /// Estimated total of the offer behind `cents` (shop fee from the settings); `None` while
    /// that shop has no fee estimate. The wishlist shows it in the title of the base price (0.7.3).
    pub estimate_cents: Option<i64>,
    /// The same view compared by estimated totals, for the wishlist switch "Mit Gebühren".
    pub with_fees: FeeView,
}

/// Prices of a badge compared by estimated totals (base price plus the shop fee from the
/// settings). Offers of shops without a fee estimate do not count: their total is unknown.
#[derive(Clone, Default, Serialize)]
pub(crate) struct FeeView {
    pub cents: Option<i64>,
    /// Base price of the offer behind `cents`.
    pub base_cents: Option<i64>,
    pub observed_at: Option<i64>,
    pub stale: bool,
    pub source: Option<String>,
    pub region: Option<String>,
    pub world: Option<WorldBest>,
    /// Like [`PriceBadge::trend`], with each link's fee added; links without a fee estimate left out.
    pub trend: Vec<Option<i64>>,
}

/// Number of UTC days in [`PriceBadge::trend`].
const TREND_DAYS: i64 = 14;
const DAY: i64 = 86400;

#[derive(Clone, Serialize)]
pub(crate) struct WorldBest {
    /// Compared amount: the base price, or the estimated total in [`FeeView`].
    pub cents: i64,
    pub base_cents: i64,
    /// Estimated total of the same offer; `None` while the shop has no fee estimate.
    pub estimate_cents: Option<i64>,
    pub source: String,
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
    state: &AppState,
    id: &str,
    target: &str,
    scope: &str,
) -> ApiResult<PriceBadge> {
    load_many(state, &[id.to_string()], target, scope)
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

/// Observation time and price of a link: `None` when it was not valid in the target country.
type Series = Vec<(i64, Option<i64>)>;
type Samples = BTreeMap<i64, Series>;
/// A link a badge shows: id, latest observation time, confirmed fingerprint and the shop fee
/// in basis points (`None` while the shop has no fee estimate).
type ShownLink = (i64, Option<i64>, Option<String>, Option<i64>);
/// Link id and its shop fee in basis points (see [`ShownLink`]).
type LinkFee = (i64, Option<i64>);

/// What the trend samples of a link depend on. Observations are immutable and every new one
/// sets `offer_link.observed_at`, so samples stay valid while this key stays the same.
#[derive(Clone, PartialEq, Eq)]
struct TrendKey {
    start: i64,
    target: String,
    observed_at: Option<i64>,
    fingerprint: Option<String>,
}

/// Trend samples per link, so polling the badges reads only links with new observations.
#[derive(Default)]
pub(crate) struct TrendCache(Mutex<HashMap<i64, (TrendKey, Series)>>);

/// Upper bound of cached links; the cache starts over when it is reached.
const TREND_CACHE_LINKS: usize = 20_000;

impl TrendCache {
    /// Samples of the given links: cached ones as they are, the others in one batched query.
    async fn samples(
        &self,
        pool: &SqlitePool,
        links: &[(i64, TrendKey)],
        t: i64,
    ) -> sqlx::Result<Samples> {
        let mut samples = Samples::new();
        let mut missing = vec![];
        {
            let cache = self.0.lock().unwrap_or_else(|e| e.into_inner());
            for (link, key) in links {
                match cache.get(link) {
                    Some((cached, values)) if cached == key => {
                        samples.insert(*link, values.clone());
                    }
                    _ => missing.push(*link),
                }
            }
        }
        let Some((_, key)) = links.first() else {
            return Ok(samples);
        };
        if missing.is_empty() {
            return Ok(samples);
        }
        let fetched = trend_samples(pool, &missing, &key.target, key.start, t).await?;
        let mut cache = self.0.lock().unwrap_or_else(|e| e.into_inner());
        if cache.len() + fetched.len() > TREND_CACHE_LINKS {
            cache.clear();
        }
        for (link, key) in links {
            if let Some(values) = fetched.get(link) {
                cache.insert(*link, (key.clone(), values.clone()));
            }
        }
        samples.extend(fetched);
        Ok(samples)
    }
}

/// Observations that decide the trend of the given links, in one query that reads only the
/// `price_history` index: per link the last observation before the window (carried forward)
/// and every observation in the window, all in the target country with the link's confirmed
/// fingerprint. One row per link keeps the transfer small.
async fn trend_samples(
    pool: &SqlitePool,
    links: &[i64],
    target: &str,
    start: i64,
    t: i64,
) -> sqlx::Result<Samples> {
    let links = serde_json::to_string(links).unwrap_or_else(|_| "[]".into());
    let rows: Vec<(i64, Option<i64>, Option<String>)> = sqlx::query_as(
        "SELECT l.id,
            (SELECT p.valid_cents FROM price_observation p WHERE p.link_id=l.id AND p.market=?2
                AND p.fingerprint=l.fingerprint AND p.observed_at<?3 ORDER BY p.observed_at DESC LIMIT 1),
            (SELECT group_concat(o.observed_at||':'||COALESCE(o.valid_cents,''),',') FROM price_observation o
                WHERE o.link_id=l.id AND o.market=?2 AND o.fingerprint=l.fingerprint AND o.observed_at>=?3 AND o.observed_at<=?4)
        FROM offer_link l WHERE l.id IN (SELECT value FROM json_each(?1))",
    )
    .bind(links)
    .bind(target)
    .bind(start)
    .bind(t)
    .fetch_all(pool)
    .await?;
    let mut samples = Samples::new();
    for (link, carried, window) in rows {
        let entry = samples.entry(link).or_default();
        entry.push((start - 1, carried));
        for sample in window.iter().flat_map(|w| w.split(',')) {
            if let Some((at, cents)) = sample.split_once(':')
                && let Ok(at) = at.parse()
            {
                entry.push((at, cents.parse().ok()));
            }
        }
        entry.sort_unstable_by_key(|(at, _)| *at);
    }
    Ok(samples)
}

/// Samples of the links with a fee estimate, each price raised by the link's fee.
fn with_fees(samples: &Samples, links: &[LinkFee]) -> Samples {
    links
        .iter()
        .filter_map(|(link, fee)| {
            let fee = (*fee)?;
            let series = samples.get(link)?;
            let raised = series
                .iter()
                .map(|(at, cents)| (*at, cents.map(|cents| offers::with_fee(cents, fee))))
                .collect();
            Some((*link, raised))
        })
        .collect()
}

/// Daily best target-country price of the given links (see [`PriceBadge::trend`]).
fn trend(links: &[i64], samples: &Samples, start: i64) -> Vec<Option<i64>> {
    (1..=TREND_DAYS)
        .map(|day| {
            let end = start + day * DAY;
            links
                .iter()
                .filter_map(|link| samples.get(link)?.iter().rev().find(|(at, _)| *at < end)?.1)
                .min()
        })
        .collect()
}

/// Badges for many items with at most four queries in total, independent of the number of
/// items (the trend query only for links with new observations, see [`TrendCache`]).
pub(crate) async fn load_many(
    state: &AppState,
    ids: &[String],
    target: &str,
    scope: &str,
) -> ApiResult<BTreeMap<String, PriceBadge>> {
    let pool = &state.pool;
    let t = now();
    let ids_json = serde_json::to_string(ids).map_err(|_| crate::internal())?;
    let wishes = offers::wishes(pool, &ids_json).await?;
    let mut links = offers::links_of_items(pool, &ids_json, t).await?;
    let jobs: Vec<JobSummary> = sqlx::query_as("SELECT COALESCE(j.wish_id,l.wish_id) AS item,MAX(j.checked_at) AS checked,COALESCE(MAX(j.last_error IS NOT NULL),0) AS failed,COALESCE(MAX((j.lease_until>?1 OR j.due<=?1) AND s.enabled AND s.configured AND (j.link_id IS NULL OR l.review!='rejected') AND COALESCE(w.state,'wished')!='owned' AND p.retry_at<=?1 AND (p.budget_day!=?2 OR p.jobs_today<COALESCE(s.daily_jobs,?3))
            AND ((SELECT fetch_paused_at FROM app_settings WHERE id=1) IS NULL OR j.requested_at>?1-900)),0) AS pending
        FROM shop_job j JOIN source_settings s ON s.id=j.source JOIN shop_state p ON p.source=j.source LEFT JOIN offer_link l ON l.id=j.link_id
        LEFT JOIN wishlist_item w ON w.id=COALESCE(j.wish_id,l.wish_id)
        WHERE COALESCE(j.wish_id,l.wish_id) IN (SELECT value FROM json_each(?4)) GROUP BY 1")
        .bind(t).bind(t / 86400).bind(crate::jobs::daily_budget()).bind(&ids_json).fetch_all(pool).await?;
    let mut jobs: BTreeMap<String, JobSummary> =
        jobs.into_iter().map(|j| (j.item.clone(), j)).collect();
    // Since 0.6.1 the wishlist always shows the target-country price next to the cheapest region
    // worldwide (`world`), so the stored scope setting no longer changes `cents`.
    let _ = scope;
    let price_scope = pricing::Scope::for_wishlist(target, "preferred");
    let start = t - t.rem_euclid(DAY) - (TREND_DAYS - 1) * DAY;
    let mut shown = vec![];
    let mut badges: Vec<(String, PriceBadge, Vec<LinkFee>)> = wishes
        .into_iter()
        .map(|(id, wish)| {
            let job = jobs.remove(&id);
            let (badge, links_shown) = compute(
                &wish,
                &links.remove(&id).unwrap_or_default(),
                job.as_ref(),
                &price_scope,
                t,
            );
            let ids = links_shown
                .iter()
                .map(|(link, .., fee)| (*link, *fee))
                .collect();
            shown.extend(
                links_shown
                    .into_iter()
                    .map(|(link, observed_at, fingerprint, _)| {
                        let key = TrendKey {
                            start,
                            target: target.to_string(),
                            observed_at,
                            fingerprint,
                        };
                        (link, key)
                    }),
            );
            (id, badge, ids)
        })
        .collect();
    let samples = state.trend_cache.samples(pool, &shown, t).await?;
    for (_, badge, links) in &mut badges {
        let ids: Vec<i64> = links.iter().map(|(link, _)| *link).collect();
        badge.trend = trend(&ids, &samples, start);
        badge.with_fees.trend = trend(&ids, &with_fees(&samples, links), start);
    }
    Ok(badges
        .into_iter()
        .map(|(id, badge, _)| (id, badge))
        .collect())
}

fn compute(
    wish: &offers::Wish,
    links: &[offers::Link],
    job: Option<&JobSummary>,
    price_scope: &pricing::Scope,
    t: i64,
) -> (PriceBadge, Vec<ShownLink>) {
    let mut result = PriceBadge {
        cents: None,
        state: "unknown",
        observed_at: None,
        checked_at: job.and_then(|j| j.checked),
        stale: false,
        pending: job.is_some_and(|j| j.pending),
        world: None,
        source: None,
        region: None,
        trend: vec![],
        estimate_cents: None,
        with_fees: FeeView::default(),
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

    // Base price and estimated total of the offer a best price comes from.
    let amounts = |link_id| {
        candidates
            .iter()
            .find(|(link, ..)| link.id == link_id)
            .map(|(link, product, ..)| {
                (
                    pricing::base(link, product),
                    pricing::estimate(link, product),
                    link.source.clone(),
                    product.region.clone(),
                )
            })
    };
    // Cheapest current offer of any region, and the best target-country price: a current price
    // wins, otherwise the last known one is shown, marked as stale. Once by base price and once
    // by estimated total.
    let pick = |amount: fn(&offers::Link, &Product) -> Option<i64>| {
        let world = pricing::best(
            candidates
                .iter()
                .map(|(link, product, _, anywhere)| (*link, product, anywhere)),
            amount,
        )
        .current
        .and_then(|best| {
            let (base, estimate, source, region) = amounts(best.link_id)?;
            Some(WorldBest {
                cents: best.cents,
                base_cents: base.unwrap_or(best.cents),
                estimate_cents: estimate,
                source,
                region,
                observed_at: best.observed_at,
            })
        });
        let prices = pricing::best(
            candidates
                .iter()
                .map(|(link, product, verdict, _)| (*link, product, verdict)),
            amount,
        );
        let shown = prices
            .current
            .map(|best| (best, false))
            .or(prices.last_known.map(|best| (best, true)));
        (world, shown)
    };
    let (world, shown) = pick(pricing::base);
    result.world = world;
    if let Some((best, stale)) = shown {
        result.cents = Some(best.cents);
        result.observed_at = Some(best.observed_at);
        result.stale = stale;
        if let Some((_, estimate, source, region)) = amounts(best.link_id) {
            result.estimate_cents = estimate;
            result.source = Some(source);
            result.region = region;
        }
    }
    let (world, shown) = pick(pricing::estimate);
    result.with_fees.world = world;
    if let Some((best, stale)) = shown {
        result.with_fees.cents = Some(best.cents);
        result.with_fees.observed_at = Some(best.observed_at);
        result.with_fees.stale = stale;
        if let Some((base, _, source, region)) = amounts(best.link_id) {
            result.with_fees.base_cents = base;
            result.with_fees.source = Some(source);
            result.with_fees.region = region;
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
    // The trend follows the same links: enabled shop, not rejected, matching and confirmed.
    let shown = candidates
        .iter()
        .map(|(link, ..)| {
            (
                link.id,
                link.observed_at,
                link.fingerprint().map(str::to_string),
                link.fee_estimation_enabled.then_some(link.fee_basis_points),
            )
        })
        .collect();
    (result, shown)
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
    Ok(Json(load_many(&state, &ids, &target, &scope).await?))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn trend_carries_each_link_forward_and_takes_the_daily_best() {
        let start = 1_800_000_000 - 1_800_000_000 % DAY;
        let samples = Samples::from([
            (
                1,
                vec![
                    (start - 10, Some(1000)),
                    (start + DAY + 5, Some(900)),
                    (start + 3 * DAY, None),
                ],
            ),
            (2, vec![(start + 2 * DAY + 1, Some(950))]),
            (3, vec![(start + 5 * DAY, Some(100))]),
        ]);
        let trend = trend(&[1, 2], &samples, start);
        assert_eq!(trend.len(), 14);
        assert_eq!(
            trend[..5],
            [Some(1000), Some(900), Some(900), Some(950), Some(950)]
        );
        assert!(trend[5..].iter().all(|cents| *cents == Some(950)));
        assert_eq!(
            super::trend(&[3], &samples, start)[..7],
            [None, None, None, None, None, Some(100), Some(100)],
            "null before the first observation"
        );
        assert!(
            super::trend(&[], &samples, start)
                .iter()
                .all(Option::is_none)
        );
    }
}
