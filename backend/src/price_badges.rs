use crate::DAY;
use crate::extract::ApiQuery;
use crate::shops::Product;
use crate::{
    ApiError, ApiResult, AppState, Shared, jobs, now, offers,
    pricing::{self, Reason},
};
use axum::{Json, extract::State, http::StatusCode};
use serde::{Deserialize, Serialize};
use sqlx::{AssertSqlSafe, SqlitePool};
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
    /// A job of the item runs or really waits for its shop ([`jobs::pending`]).
    pub pending: bool,
    /// A pending job serves a fetch the owner triggered ([`jobs::direct_action`]); only then the pages poll every 3 s.
    pub refreshing: bool,
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
    /// Offers of the wish by [`offers::Link::offer_count`] (FUNC-11); the wishlist item carries it as `offer_count`.
    #[serde(skip)]
    pub offer_count: i64,
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
    /// The cheapest region can be bought for the target country (RESP-14): activation confirmed there and the same
    /// market ([`pricing::Verdict::fits_target`]). `false` marks an offer whose use in the target country is not safe.
    pub fits_target: bool,
    /// Activation of the offer in the target country: `confirmed`, `blocked` or `unknown`.
    pub activation: &'static str,
}

/// Display a saved observation; live alert eligibility remains stricter.
pub(crate) async fn load(state: &AppState, id: &str, target: &str) -> ApiResult<PriceBadge> {
    load_many(state, &[id.to_string()], target)
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
    refreshing: bool,
}

/// Observation time and price of a link: `None` when it was not valid in the target country.
type Series = Vec<(i64, Option<i64>)>;
type Samples = BTreeMap<i64, Series>;
/// A link a badge shows: id, latest observation time, confirmed fingerprint, the shop fee in basis points (`None`
/// while the shop has no fee estimate) and whether its product can be activated in the target country now.
type ShownLink = (i64, Option<i64>, Option<String>, Option<i64>, bool);
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
    /// The product can be activated in the target country (it changes only with a new observation).
    active: bool,
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
        let mut active = vec![];
        {
            let cache = self.0.lock().unwrap_or_else(|e| e.into_inner());
            for (link, key) in links {
                match cache.get(link) {
                    Some((cached, values)) if cached == key => {
                        samples.insert(*link, values.clone());
                    }
                    _ => {
                        missing.push(*link);
                        if key.active {
                            active.push(*link);
                        }
                    }
                }
            }
        }
        let Some((_, key)) = links.first() else {
            return Ok(samples);
        };
        if missing.is_empty() {
            return Ok(samples);
        }
        let fetched = trend_samples(pool, &missing, &active, &key.target, key.start, t).await?;
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
/// and every observation in the window, all with the link's confirmed fingerprint and valid in
/// the target country by the rule of the price (FUNC-02, [`pricing::counts_in`]): bought in the
/// same market, and activatable in the target country. An observation in the target country
/// itself carries its own activation (`valid_cents`); one elsewhere in the EU market counts with
/// its stock price when the product can be activated in the target country now (`active`).
/// One row per link keeps the transfer small.
async fn trend_samples(
    pool: &SqlitePool,
    links: &[i64],
    active: &[i64],
    target: &str,
    start: i64,
    t: i64,
) -> sqlx::Result<Samples> {
    let links = serde_json::to_string(links).unwrap_or_else(|_| "[]".into());
    let active = serde_json::to_string(active).unwrap_or_else(|_| "[]".into());
    let markets = serde_json::to_string(&pricing::markets(target)).unwrap_or_else(|_| "[]".into());
    let rows: Vec<(i64, Option<i64>, Option<String>)> = sqlx::query_as(
        "SELECT l.id,
            (SELECT CASE WHEN p.market=?2 THEN p.valid_cents WHEN l.id IN (SELECT value FROM json_each(?5)) THEN p.stock_cents END
                FROM price_observation p WHERE p.link_id=l.id AND p.fingerprint=l.fingerprint AND p.observed_at<?3
                AND (p.market=?2 OR p.market IN (SELECT value FROM json_each(?6))) ORDER BY p.observed_at DESC LIMIT 1),
            (SELECT group_concat(o.observed_at||':'||COALESCE(CASE WHEN o.market=?2 THEN o.valid_cents
                    WHEN l.id IN (SELECT value FROM json_each(?5)) THEN o.stock_cents END,''),',')
                FROM price_observation o WHERE o.link_id=l.id AND o.fingerprint=l.fingerprint AND o.observed_at>=?3
                AND o.observed_at<=?4 AND (o.market=?2 OR o.market IN (SELECT value FROM json_each(?6))))
        FROM offer_link l WHERE l.id IN (SELECT value FROM json_each(?1))",
    )
    .bind(links)
    .bind(target)
    .bind(start)
    .bind(t)
    .bind(active)
    .bind(markets)
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
) -> ApiResult<BTreeMap<String, PriceBadge>> {
    let pool = &state.pool;
    let t = now();
    let ids_json = serde_json::to_string(ids).map_err(|_| crate::internal())?;
    let wishes = offers::wishes(pool, &ids_json).await?;
    let mut links = offers::links_of_items(pool, &ids_json).await?;
    let jobs: Vec<JobSummary> = offers::clock(
        sqlx::query_as(AssertSqlSafe(format!(
            "SELECT item,MAX(checked) AS checked,COALESCE(MAX(failed),0) AS failed,COALESCE(MAX(pending),0) AS pending,
            COALESCE(MAX(pending AND direct),0) AS refreshing FROM (
                SELECT COALESCE(j.wish_id,l.wish_id) AS item,j.checked_at AS checked,j.last_error IS NOT NULL AS failed,
                {} AS pending,{} AS direct
                FROM {} WHERE COALESCE(j.wish_id,l.wish_id) IN (SELECT value FROM json_each(?1))
            ) GROUP BY item",
            jobs::pending(),
            jobs::direct_action(),
            jobs::JOBS
        )))
        .bind(&ids_json),
        t,
    )
    .fetch_all(pool)
    .await?;
    let mut jobs: BTreeMap<String, JobSummary> =
        jobs.into_iter().map(|j| (j.item.clone(), j)).collect();
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
                target,
                t,
            );
            let ids = links_shown
                .iter()
                .map(|(link, _, _, fee, _)| (*link, *fee))
                .collect();
            shown.extend(links_shown.into_iter().map(
                |(link, observed_at, fingerprint, _, active)| {
                    let key = TrendKey {
                        start,
                        target: target.to_string(),
                        observed_at,
                        fingerprint,
                        active,
                    };
                    (link, key)
                },
            ));
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
    target: &str,
    t: i64,
) -> (PriceBadge, Vec<ShownLink>) {
    let price_scope = &pricing::Scope::target(target);
    let mut result = PriceBadge {
        cents: None,
        state: "unknown",
        observed_at: None,
        checked_at: job.and_then(|j| j.checked),
        stale: false,
        pending: job.is_some_and(|j| j.pending),
        refreshing: job.is_some_and(|j| j.refreshing),
        world: None,
        source: None,
        region: None,
        trend: vec![],
        estimate_cents: None,
        with_fees: FeeView::default(),
        offer_count: 0,
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
        result.offer_count += link.offer_count(wish, &product);
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
        candidates.iter().find(|(link, ..)| link.id == link_id).map(
            |(link, product, verdict, _)| {
                (
                    pricing::base(link, product),
                    pricing::estimate(link, product),
                    link.source.clone(),
                    product.region.clone(),
                    verdict.fits_target(),
                    product.activation(target),
                )
            },
        )
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
            let (base, estimate, source, region, fits_target, activation) = amounts(best.link_id)?;
            Some(WorldBest {
                cents: best.cents,
                base_cents: base.unwrap_or(best.cents),
                estimate_cents: estimate,
                source,
                region,
                observed_at: best.observed_at,
                fits_target,
                activation,
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
        if let Some((_, estimate, source, region, ..)) = amounts(best.link_id) {
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
        if let Some((base, _, source, region, ..)) = amounts(best.link_id) {
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
    // The trend follows the same links: enabled shop, not rejected, matching, confirmed and a key (FUNC-04).
    let shown = candidates
        .iter()
        .filter(|(_, _, verdict, _)| !verdict.has(Reason::NotAKey))
        .map(|(link, product, ..)| {
            (
                link.id,
                link.observed_at,
                link.fingerprint().map(str::to_string),
                link.fee_estimation_enabled.then_some(link.fee_basis_points),
                product.activation(target) == "confirmed",
            )
        })
        .collect();
    (result, shown)
}

/// One shop's best offer for a cart entry (0.8.1): key price, estimated total and region.
#[derive(Clone, Serialize)]
pub(crate) struct CartOffer {
    pub cents: i64,
    pub estimate_cents: Option<i64>,
    pub region: Option<String>,
    pub observed_at: i64,
    /// Only the last known price (no current offer); target-country prices only.
    pub stale: bool,
    /// Can be bought for the target country (RESP-14, [`pricing::Verdict::fits_target`]): always for `home`; a `world`
    /// offer of another region may not be safely activatable there.
    pub fits_target: bool,
    /// Activation of the offer in the target country: `confirmed`, `blocked` or `unknown`.
    pub activation: &'static str,
}

/// A shop's best offers for a wish: valid in the target country (`home`) and of any region (`world`).
#[derive(Clone, Default, Serialize)]
pub(crate) struct ShopOffers {
    pub home: Option<CartOffer>,
    pub world: Option<CartOffer>,
}

/// Per wish and shop the best offers by key price, from the same links and rules as the badges:
/// enabled shop, not rejected, matching and confirmed. `home` falls back to the last known price
/// like the badge does; `world` counts current offers only, like the badge's cheapest region.
pub(crate) async fn shop_offers(
    state: &AppState,
    ids: &[String],
    target: &str,
) -> ApiResult<BTreeMap<String, BTreeMap<String, ShopOffers>>> {
    let pool = &state.pool;
    let t = now();
    let ids_json = serde_json::to_string(ids).map_err(|_| crate::internal())?;
    let wishes = offers::wishes(pool, &ids_json).await?;
    let mut links = offers::links_of_items(pool, &ids_json).await?;
    let home_scope = pricing::Scope::target(target);
    let mut result = BTreeMap::new();
    for (id, wish) in wishes {
        let mut by_shop: BTreeMap<String, Vec<_>> = BTreeMap::new();
        for link in links.remove(&id).unwrap_or_default() {
            let Some(product) = link.product() else {
                continue;
            };
            let verdict = pricing::evaluate(&link, &wish, Some(&product), &home_scope, t);
            if [
                Reason::SourceDisabled,
                Reason::Rejected,
                Reason::Mismatch,
                Reason::NotConfirmed,
            ]
            .into_iter()
            .any(|reason| verdict.has(reason))
            {
                continue;
            }
            let anywhere =
                pricing::evaluate(&link, &wish, Some(&product), &pricing::Scope::AllRegions, t);
            by_shop
                .entry(link.source.clone())
                .or_default()
                .push((link, product, verdict, anywhere));
        }
        let shops = by_shop
            .into_iter()
            .map(|(source, rows)| {
                let offer = |best: pricing::Best, stale: bool| {
                    let (link, product, verdict, _) =
                        rows.iter().find(|(link, ..)| link.id == best.link_id)?;
                    Some(CartOffer {
                        cents: best.cents,
                        estimate_cents: pricing::estimate(link, product),
                        region: product.region.clone(),
                        observed_at: best.observed_at,
                        stale,
                        fits_target: verdict.fits_target(),
                        activation: product.activation(target),
                    })
                };
                let home = pricing::best(
                    rows.iter()
                        .map(|(link, product, verdict, _)| (link, product, verdict)),
                    pricing::base,
                );
                let world = pricing::best(
                    rows.iter()
                        .map(|(link, product, _, anywhere)| (link, product, anywhere)),
                    pricing::base,
                );
                let offers = ShopOffers {
                    home: home
                        .current
                        .map(|best| (best, false))
                        .or(home.last_known.map(|best| (best, true)))
                        .and_then(|(best, stale)| offer(best, stale)),
                    world: world.current.and_then(|best| offer(best, false)),
                };
                (source, offers)
            })
            .filter(|(_, offers)| offers.home.is_some() || offers.world.is_some())
            .collect();
        result.insert(id, shops);
    }
    Ok(result)
}

#[derive(Deserialize)]
pub(crate) struct BadgeQuery {
    /// An empty anchor requests only the wishlist. No parameter includes all watched editions.
    anchor: Option<String>,
}

pub(crate) async fn list(
    State(state): State<Shared>,
    ApiQuery(query): ApiQuery<BadgeQuery>,
) -> ApiResult<Json<BTreeMap<String, PriceBadge>>> {
    let target = offers::target(&state.pool).await?;
    let ids:Vec<String>=sqlx::query_scalar("SELECT w.id FROM wishlist_item w WHERE w.state!='owned' AND (w.state='wished' OR EXISTS(SELECT 1 FROM edition_watch e JOIN wishlist_item a ON a.id=e.wish_id WHERE e.track_id=w.id AND (?1 IS NULL OR a.id=?1) AND a.state='wished'))").bind(query.anchor).fetch_all(&state.pool).await?;
    Ok(Json(load_many(&state, &ids, &target).await?))
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
