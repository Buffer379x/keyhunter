//! Persistent, budgeted and paced shop jobs.
//!
//! Each shop has one worker. A job is claimed with a lease, executed (network) and
//! completed in one short transaction. Claim order and pacing:
//!
//! | class | jobs | paced |
//! |---|---|---|
//! | 0 | refresh requested by the user, first search of a new wish (not of a preview) | no |
//! | 1 | price of an active wish that is in stock (any region; the target country is not preferred), search continuation pages | yes, unless a direct user action (below) |
//! | 2 | repeated search of an active wish | yes, unless a direct user action |
//! | 3 | price of an active wish that is sold out or has no price | yes, unless a direct user action |
//! | 4 | edition previews | yes (a requested refresh is class 0) |
//! | 5 | shop-wide discovery | yes |
//!
//! Every fourth job of a day goes to the most overdue job of classes 2 to 5, so lower
//! classes keep a share of the budget even when class 1 alone could use it up. Product intervals adapt to
//! the price trend of each product within its wish (0.6.5, [`price_trend`]): the steadily cheapest region is
//! checked twice as often, the steadily most expensive one and sold-out products half as often, previews half
//! as often. Every region is treated alike; the target country only decides which price counts, not how often.
//!
//! **Budget.** A shop runs at most [`daily_limit`] jobs per UTC day: `source_settings.daily_jobs`
//! (Settings → Key-Shops), else `KEYHUNTER_SHOP_DAILY_JOBS`, else 500. Every job counts, paced or not.
//! Workers read the value on every claim, so a change applies without restart.
//!
//! **Pacing.** After a paced job the shop may start its next paced job [`pace_gap`] later: the rest
//! of the UTC day divided by the remaining budget, clamped to 20 s … 1 h. The time is stored in
//! `shop_state.paced_until`, so a restart does not burst. Retry ladder, source pauses, robots and the
//! per-host gap of the shop clients apply in addition.
//!
//! **Direct user actions** ([`bypass`]) skip pacing (never the budget). A job is one when its item is
//! a wish (not a preview, owned or deleted item; class 0 excepted) and
//! - it is class 0 (requested refresh of any item, first search of a new wish), or
//! - it is a search with `initial=1`: every page and retry of the first search of a new wish or
//!   of a search run started by a requested refresh, until its last page is stored, or
//! - it is a product with `initial=1` whose link has no observation yet: the first price fetch of a
//!   link created by a user action (saving, restoring or refreshing a wish, adding a link by hand)
//!   or found by a search run that itself bypassed pacing. The flag clears after that first run.
//!
//! Links attached at start-up or after a shop-wide discovery are never direct user actions.

use crate::{
    ApiResult, Shared, alerts, auth, now, offers, random_token,
    shops::{Availability, Product, Shop, ShopError},
};
use axum::{Json, extract::State, http::HeaderMap};
use serde_json::{Value, json};
// Composed queries only join the constant SQL fragments below; values are always bound.
use sqlx::{AssertSqlSafe, FromRow, SqlitePool};
use std::{
    sync::{
        Arc,
        atomic::{AtomicI64, Ordering},
    },
    time::{Duration, Instant},
};

const DAY: i64 = 86400;
const WEEK: i64 = 7 * DAY;
/// Delays after the first, second and third consecutive transient failure.
const RETRY_LADDER: [i64; 3] = [120, 600, 3600];
/// A search walks at most this many result pages per run.
const MAX_SEARCH_PAGES: i64 = 5;
/// A requested refresh keeps top priority this long.
const REQUEST_WINDOW: i64 = 900;
/// Fetch history is kept this long.
const RUN_RETENTION: i64 = 30 * DAY;
/// A worker that has not looped for this long counts as stalled.
const STALL_AFTER: i64 = 300;

/// Daily budget per shop when neither the setting nor the environment sets one.
const DEFAULT_DAILY_JOBS: i64 = 500;
/// Allowed values of the per-shop setting `daily_jobs`.
pub(crate) const DAILY_JOBS_SETTING: std::ops::RangeInclusive<i64> = 20..=2000;
/// Shortest and longest pause between two paced jobs of a shop.
const PACE_MIN: i64 = 20;
const PACE_MAX: i64 = 3600;

/// Operator default of the daily budget per shop and where it comes from (`env` or `default`).
/// `KEYHUNTER_SHOP_DAILY_JOBS` counts when it is a whole number from 1 to 2000.
pub(crate) fn default_budget() -> (i64, &'static str) {
    std::env::var("KEYHUNTER_SHOP_DAILY_JOBS")
        .ok()
        .and_then(|v| v.trim().parse::<i64>().ok())
        .filter(|v| (1..=2000).contains(v))
        .map_or((DEFAULT_DAILY_JOBS, "default"), |v| (v, "env"))
}

/// Operator default of the daily budget per shop (see [`default_budget`]).
pub(crate) fn daily_budget() -> i64 {
    default_budget().0
}

/// Effective daily limit of a shop: its setting, else the operator default.
pub(crate) fn daily_limit(setting: Option<i64>) -> i64 {
    setting.unwrap_or_else(daily_budget)
}

/// Pause after a paced job at `t` with `remaining` budget left today: the remaining budget
/// spread evenly over the rest of the UTC day.
pub(crate) fn pace_gap(t: i64, remaining: i64) -> i64 {
    let rest = DAY - t.rem_euclid(DAY);
    (rest / remaining.max(1)).clamp(PACE_MIN, PACE_MAX)
}

/// Last loop time of each shop worker, for readiness and the status page.
#[derive(Default)]
pub(crate) struct Heartbeat([AtomicI64; 2]);

impl Heartbeat {
    fn slot(shop: Shop) -> usize {
        match shop {
            Shop::Eneba => 0,
            Shop::Driffle => 1,
        }
    }
    pub(crate) fn beat(&self, shop: Shop, t: i64) {
        self.0[Self::slot(shop)].store(t, Ordering::Relaxed);
    }
    pub(crate) fn last(&self, shop: Shop) -> i64 {
        self.0[Self::slot(shop)].load(Ordering::Relaxed)
    }
    pub(crate) fn stalled(&self, t: i64) -> bool {
        Shop::ALL
            .into_iter()
            .any(|shop| t - self.last(shop) > STALL_AFTER)
    }
}

pub(crate) fn start(pool: &SqlitePool, heartbeat: Arc<Heartbeat>) {
    let budget = daily_budget();
    for shop in Shop::ALL {
        let pool = pool.clone();
        let heartbeat = Arc::clone(&heartbeat);
        heartbeat.beat(shop, now());
        tokio::spawn(async move {
            // Catch up once after start or upgrade; afterwards only events attach candidates.
            if let Err(error) = attach(&pool, shop).await {
                tracing::warn!(source = shop.id(), %error, "Candidate attachment failed");
            }
            loop {
                heartbeat.beat(shop, now());
                match run_one(&pool, shop, budget).await {
                    Ok(true) => tokio::time::sleep(Duration::from_secs(2)).await,
                    Ok(false) => tokio::time::sleep(Duration::from_secs(3)).await,
                    Err(error) => {
                        tracing::error!(source = shop.id(), error = %error, "Shop job database operation failed");
                        tokio::time::sleep(Duration::from_secs(10)).await;
                    }
                }
            }
        });
    }
}

// Shared SQL conditions; `j` is shop_job, `l` the joined offer_link and `t` the item the job
// belongs to (NULL for discovery). `?2` is the current time.
const ITEM: &str = "LEFT JOIN wishlist_item t ON t.id=COALESCE(j.wish_id,l.wish_id)";
/// Time the owner paused the automatic checks (0.7.0), NULL while they run.
pub(crate) const PAUSED_AT: &str = "(SELECT fetch_paused_at FROM app_settings WHERE id=1)";
const NOT_OWNED: &str = "COALESCE(t.state,'wished')!='owned'";
/// A preview is fetched while an active wish watches it and it was viewed in the last 14 days.
const WATCHED_IF_PREVIEW: &str = "(COALESCE(t.state,'wished')!='preview' OR (COALESCE(t.viewed_at,0)>?2-1209600 AND EXISTS(SELECT 1 FROM edition_watch ew JOIN wishlist_item aw ON aw.id=ew.wish_id WHERE ew.track_id=t.id AND aw.state='wished')))";
const ANY_ACTIVE_WISH: &str = "EXISTS(SELECT 1 FROM wishlist_item w WHERE w.state='wished')";

/// Jobs the scheduler runs at all (whenever they are due); idle jobs stay out.
fn queued() -> String {
    format!(
        "(j.link_id IS NULL OR l.review!='rejected') AND {NOT_OWNED} AND {WATCHED_IF_PREVIEW} AND {ANY_ACTIVE_WISH}"
    )
}

/// Claim class (module table); `window` is the placeholder of `now - REQUEST_WINDOW`.
fn class(window: &str) -> String {
    format!(
        "CASE
    WHEN j.requested_at>{window} THEN 0
    WHEN t.state='preview' THEN 4
    WHEN j.wish_id IS NOT NULL AND j.checked_at IS NULL THEN 0
    WHEN j.link_id IS NULL AND j.wish_id IS NULL THEN 5
    WHEN j.link_id IS NOT NULL THEN CASE WHEN j.relevance=1 THEN 1 ELSE 3 END
    WHEN j.search_page>1 THEN 1
    ELSE 2 END"
    )
}

/// True for a job that serves a direct user action and skips pacing (module docs).
fn bypass(window: &str) -> String {
    format!(
        "(({})=0 OR (j.initial=1 AND COALESCE(t.state,'wished')='wished'
        AND (j.wish_id IS NOT NULL OR (j.link_id IS NOT NULL AND l.observed_at IS NULL))))",
        class(window)
    )
}

/// `?1` shop, `?2` now, `?3` UTC day, `?4` default budget, `?5` now - REQUEST_WINDOW.
fn claimable() -> String {
    format!(
        "FROM shop_job j JOIN source_settings s ON s.id=j.source JOIN shop_state p ON p.source=j.source
        LEFT JOIN offer_link l ON l.id=j.link_id {ITEM}
        WHERE j.source=?1 AND s.enabled AND s.configured AND p.retry_at<=?2
        AND (p.budget_day!=?3 OR p.jobs_today<COALESCE(s.daily_jobs,?4))
        AND j.due<=?2 AND j.lease_until<=?2 AND (p.paced_until<=?2 OR {})
        AND ({PAUSED_AT} IS NULL OR {})
        AND {}",
        bypass("?5"),
        bypass("?5"),
        queued()
    )
}

#[derive(FromRow)]
pub(crate) struct Job {
    id: i64,
    link_id: Option<i64>,
    failures: i64,
    wish_id: Option<String>,
    search_page: i64,
    /// The job serves a direct user action and skipped pacing.
    #[sqlx(skip)]
    bypass: bool,
}

async fn claim(
    pool: &SqlitePool,
    shop: Shop,
    token: &str,
    t: i64,
    budget: i64,
) -> sqlx::Result<Option<Job>> {
    let day = t / DAY;
    let pending: bool = sqlx::query_scalar(AssertSqlSafe(format!(
        "SELECT EXISTS(SELECT 1 {})",
        claimable()
    )))
    .bind(shop.id())
    .bind(t)
    .bind(day)
    .bind(budget)
    .bind(t - REQUEST_WINDOW)
    .fetch_one(pool)
    .await?;
    if !pending {
        return Ok(None);
    }

    let mut tx = pool.begin().await?;
    // Every fourth job of the day goes to the most overdue job of classes 2..5.
    let sql = format!(
        "UPDATE shop_job SET lease_until=?6,lease_token=?7 WHERE id=(SELECT id FROM (
            SELECT j.id AS id, j.due AS due, {} AS class {}
            AND NOT EXISTS(SELECT 1 FROM shop_job running WHERE running.source=j.source AND running.lease_until>?2)
        ) ORDER BY CASE
            WHEN class=0 THEN 0
            WHEN (SELECT CASE WHEN q.budget_day=?3 THEN q.jobs_today ELSE 0 END FROM shop_state q WHERE q.source=?1)%4=3
                THEN CASE WHEN class>=2 THEN 1 ELSE 2 END
            ELSE class END, due, id LIMIT 1)
        RETURNING id,link_id,failures,wish_id,search_page",
        class("?5"),
        claimable()
    );
    let mut claimed: Option<Job> = sqlx::query_as(AssertSqlSafe(sql))
        .bind(shop.id())
        .bind(t)
        .bind(day)
        .bind(budget)
        .bind(t - REQUEST_WINDOW)
        .bind(t + 180)
        .bind(token)
        .fetch_optional(&mut *tx)
        .await?;
    if let Some(job) = &mut claimed {
        // The transaction holds the write lock, so the job cannot change in between.
        job.bypass = sqlx::query_scalar(AssertSqlSafe(format!(
            "SELECT {} FROM shop_job j LEFT JOIN offer_link l ON l.id=j.link_id {ITEM} WHERE j.id=?1",
            bypass("?2")
        )))
        .bind(job.id)
        .bind(t - REQUEST_WINDOW)
        .fetch_one(&mut *tx)
        .await?;
        let (used, limit): (i64, i64) = sqlx::query_as(
            "UPDATE shop_state SET jobs_today=CASE WHEN budget_day=?1 THEN jobs_today+1 ELSE 1 END, budget_day=?1 WHERE source=?2
            RETURNING jobs_today,(SELECT COALESCE(s.daily_jobs,?3) FROM source_settings s WHERE s.id=?2)",
        )
        .bind(day)
        .bind(shop.id())
        .bind(budget)
        .fetch_one(&mut *tx)
        .await?;
        if !job.bypass {
            sqlx::query("UPDATE shop_state SET paced_until=? WHERE source=?")
                .bind(t + pace_gap(t, limit - used))
                .bind(shop.id())
                .execute(&mut *tx)
                .await?;
        }
    }
    tx.commit().await?;
    Ok(claimed)
}

pub(crate) enum Work {
    Product(Box<Product>),
    /// Candidates and the wait until the next discovery run (None: [`Kind::repeat_after`]).
    Discovery(Vec<(String, String)>, Option<i64>),
    Search(crate::shops::eneba::SearchPage),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Kind {
    Product,
    Search,
    Discovery,
}

impl Kind {
    fn of(link_id: Option<i64>, wish_id: Option<&str>) -> Self {
        match (link_id, wish_id) {
            (Some(_), _) => Self::Product,
            (None, Some(_)) => Self::Search,
            (None, None) => Self::Discovery,
        }
    }
    fn id(self) -> &'static str {
        match self {
            Self::Product => "product",
            Self::Search => "search",
            Self::Discovery => "discovery",
        }
    }
    /// Delay after a successful run until the job is due again (`interval` is effective).
    fn repeat_after(self, interval: i64) -> i64 {
        match self {
            Self::Product => interval,
            Self::Search => WEEK.max(interval),
            Self::Discovery => DAY.max(interval),
        }
    }
}

fn next_schedule(
    result: &Result<Work, ShopError>,
    previous_failures: i64,
    t: i64,
    interval: i64,
    jitter: i64,
) -> (i64, i64) {
    match result {
        Ok(Work::Product(_)) => (t + Kind::Product.repeat_after(interval), 0),
        Ok(Work::Search(page)) if page.next_page.is_some() => (t, 0),
        Ok(Work::Search(_)) => (t + Kind::Search.repeat_after(interval), 0),
        Ok(Work::Discovery(_, Some(wait))) => (t + wait, 0),
        Ok(Work::Discovery(_, None)) => (t + Kind::Discovery.repeat_after(interval), 0),
        Err(error) => {
            // Transient errors climb a short ladder; others wait a full interval.
            let retry = match error {
                ShopError::Network | ShopError::Throttled(_) => RETRY_LADDER
                    .get(usize::try_from(previous_failures).unwrap_or(usize::MAX))
                    .copied()
                    .unwrap_or(interval),
                _ => interval,
            };
            (
                t + error.source_pause().max(retry + jitter),
                (previous_failures + 1).min(20),
            )
        }
    }
}

/// 1 = in stock with a price, 2 = sold out or without a price (claim class 3, see the module table).
fn relevance(product: &Product) -> i64 {
    if product.availability == Availability::InStock && crate::pricing::min_cents(product).is_some()
    {
        1
    } else {
        2
    }
}

/// Interval of the next product check: the shop interval, twice as long for an edition preview, times the price-trend
/// `pace` (0.5 to 2, see [`price_trend`]). Never shorter than 15 minutes, never longer than a week.
pub(crate) fn effective_interval(interval: i64, preview: bool, pace: f64) -> i64 {
    let factor = if preview { 2 } else { 1 };
    let paced = (interval * factor) as f64 * pace.clamp(PACE_FASTEST, SOLD_OUT_PACE);
    (paced.round() as i64).clamp(MIN_INTERVAL.min(interval), WEEK)
}

/// Weight of the newest measurement in the price trend (moving average over roughly the last ten measurements).
const TREND_WEIGHT: f64 = 0.2;
/// Pace of the product that is steadily the cheapest of its game: checked twice as often.
const PACE_FASTEST: f64 = 0.5;
/// Pace of a sold-out product (or one without a valid price): checked half as often until it is in stock again.
/// The steadily most expensive product gets the same pace from its trend.
const SOLD_OUT_PACE: f64 = 2.0;
/// Shortest interval the settings allow.
const MIN_INTERVAL: i64 = 900;
/// Prices older than this do not take part in the comparison.
const TREND_PRICE_AGE: i64 = WEEK;

/// Relative price position of `own` among `prices` (own included): 0 = cheapest, 1 = most expensive.
/// None without a comparison: fewer than two prices, or all prices equal.
fn price_position(own: i64, prices: &[i64]) -> Option<f64> {
    let (min, max) = (*prices.iter().min()?, *prices.iter().max()?);
    (max > min).then(|| (own - min) as f64 / (max - min) as f64)
}

/// Next price trend: the moving average moves a fifth of the way to the new position; unchanged without a comparison.
fn next_trend(score: f64, position: Option<f64>) -> f64 {
    position
        .map_or(score, |p| score + TREND_WEIGHT * (p - score))
        .clamp(0.0, 1.0)
}

/// Interval factor from the trend: 0 (steadily cheapest) → 0.5, 0.5 → 1, 1 (steadily most expensive) → 2.
fn trend_pace(score: f64) -> f64 {
    2f64.powf(2.0 * score - 1.0)
}

/// New price trend and pace of a measured product link, compared with the other confirmed, recently measured products
/// of the same wish in every region. Whether a product can be activated in the target country plays no part.
async fn price_trend(
    pool: &SqlitePool,
    link: i64,
    product: &Product,
    t: i64,
) -> sqlx::Result<(f64, f64)> {
    let Some((wish, score)): Option<(String, f64)> =
        sqlx::query_as("SELECT wish_id,cheap_score FROM offer_link WHERE id=?")
            .bind(link)
            .fetch_optional(pool)
            .await?
    else {
        return Ok((0.5, 1.0));
    };
    let Some(own) = crate::pricing::min_cents(product)
        .filter(|_| product.availability == Availability::InStock)
    else {
        return Ok((score, SOLD_OUT_PACE));
    };
    let others: Vec<String> = sqlx::query_scalar(
        "SELECT l.latest FROM offer_link l JOIN source_settings s ON s.id=l.source
        WHERE l.wish_id=? AND l.id!=? AND l.review='confirmed' AND s.enabled AND s.configured
        AND l.latest IS NOT NULL AND l.observed_at>?",
    )
    .bind(&wish)
    .bind(link)
    .bind(t - TREND_PRICE_AGE)
    .fetch_all(pool)
    .await?;
    let mut prices: Vec<i64> = others
        .iter()
        .filter_map(|raw| serde_json::from_str::<Product>(raw).ok())
        .filter(|other| other.availability == Availability::InStock)
        .filter_map(|other| crate::pricing::min_cents(&other))
        .collect();
    prices.push(own);
    let score = next_trend(score, price_position(own, &prices));
    Ok((score, trend_pace(score)))
}

async fn run_one(pool: &SqlitePool, shop: Shop, budget: i64) -> anyhow::Result<bool> {
    let token = random_token()?;
    let Some(job) = claim(pool, shop, &token, now(), budget).await? else {
        return Ok(false);
    };
    let started_at = now();
    let clock = Instant::now();
    let result = execute(pool, shop, &job).await?;
    let elapsed = i64::try_from(clock.elapsed().as_millis()).unwrap_or(i64::MAX);
    complete(pool, shop, &job, &token, result, now(), started_at, elapsed).await?;
    Ok(true)
}

async fn execute(
    pool: &SqlitePool,
    shop: Shop,
    job: &Job,
) -> anyhow::Result<Result<Work, ShopError>> {
    Ok(if let Some(id) = &job.wish_id {
        match offers::wish(pool, id).await {
            Ok(wish) => {
                let keys = wish.keys();
                let known:Vec<String> = sqlx::query_scalar("SELECT url FROM shop_candidate WHERE source=? AND title_key IN (SELECT value FROM json_each(?))")
                    .bind(shop.id()).bind(serde_json::to_string(&keys)?).fetch_all(pool).await?;
                crate::shops::eneba::search_page(&keys, &known, job.search_page)
                    .await
                    .map(Work::Search)
            }
            Err(_) => Err(ShopError::NotFound),
        }
    } else if let Some(link) = job.link_id {
        let raw: Option<String> = sqlx::query_scalar("SELECT url FROM offer_link WHERE id=?")
            .bind(link)
            .fetch_optional(pool)
            .await?;
        match raw.as_deref().and_then(|raw| shop.product_url(raw)) {
            Some(url) => shop.product(&url).await.map(|p| Work::Product(Box::new(p))),
            None if raw.is_none() => Err(ShopError::NotFound),
            None => Err(ShopError::Denied),
        }
    } else {
        let shard: i64 = sqlx::query_scalar("SELECT next_discovery FROM shop_state WHERE source=?")
            .bind(shop.id())
            .fetch_one(pool)
            .await?;
        shop.discover(usize::try_from(shard).unwrap_or_default())
            .await
            .map(|(found, wait)| Work::Discovery(found, wait))
    })
}

/// Store a finished job: schedule, data, observation, alert events and history in one transaction.
#[allow(clippy::too_many_arguments)]
async fn complete(
    pool: &SqlitePool,
    shop: Shop,
    job: &Job,
    token: &str,
    mut result: Result<Work, ShopError>,
    t: i64,
    started_at: i64,
    elapsed_ms: i64,
) -> anyhow::Result<()> {
    if let Ok(Work::Search(page)) = &mut result {
        page.next_page = page.next_page.filter(|next| *next <= MAX_SEARCH_PAGES);
    }
    let interval: i64 =
        sqlx::query_scalar("SELECT poll_interval_seconds FROM source_settings WHERE id=?")
            .bind(shop.id())
            .fetch_one(pool)
            .await?;
    let preview: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM wishlist_item WHERE state='preview' AND id=COALESCE(?,(SELECT wish_id FROM offer_link WHERE id=?)))")
        .bind(&job.wish_id).bind(job.link_id).fetch_one(pool).await?;
    let relevance = match &result {
        Ok(Work::Product(product)) => Some(relevance(product)),
        _ => None,
    };
    let trend = match (&result, job.link_id) {
        (Ok(Work::Product(product)), Some(link)) => {
            Some(price_trend(pool, link, product, t).await?)
        }
        _ => None,
    };
    let pace = trend.map_or(1.0, |(_, pace)| pace);
    let interval = effective_interval(interval, preview, pace);
    let jitter = i64::from(u8::from_str_radix(&token[..2], 16).unwrap_or(0) % 31);
    let (due, failures) = next_schedule(&result, job.failures, t, interval, jitter);
    // A search run keeps `initial` until its last page is stored; a product only for one run.
    let keep_initial = job.link_id.is_none()
        && job.wish_id.is_some()
        && !matches!(&result, Ok(Work::Search(page)) if page.next_page.is_none());
    let mut tx = pool.begin().await?;
    let count = sqlx::query(
        "UPDATE shop_job SET due=?,failures=?,lease_until=0,lease_token=NULL,requested_at=0,initial=CASE WHEN ? THEN initial ELSE 0 END
        WHERE id=? AND lease_token=? AND lease_until>?",
    )
    .bind(due)
    .bind(failures)
    .bind(keep_initial)
    .bind(job.id)
    .bind(token)
    .bind(t)
    .execute(&mut *tx)
    .await?
    .rows_affected();
    if count == 0 {
        // The lease was revoked or expired; another run owns the job now.
        return Ok(());
    }

    sqlx::query(
        "UPDATE shop_job SET checked_at=?,last_error=?,relevance=COALESCE(?,relevance),pace=COALESCE(?,pace) WHERE id=?",
    )
    .bind(t)
    .bind(result.as_ref().err().map(ShopError::code))
    .bind(relevance)
    .bind(trend.map(|(_, pace)| pace))
    .bind(job.id)
    .execute(&mut *tx)
    .await?;
    let mut measured = None;
    let detail = match &result {
        Ok(Work::Product(product)) => {
            let link = job.link_id.expect("product job");
            let json = serde_json::to_string(&product)?;
            let wish: Option<String> = sqlx::query_scalar("UPDATE offer_link SET latest=?,observed_at=?,attempted_at=?,last_error=NULL
                WHERE id=? AND review!='rejected' AND EXISTS(SELECT 1 FROM source_settings s WHERE s.id=source AND s.enabled AND s.configured)
                RETURNING wish_id").bind(json).bind(t).bind(t).bind(link).fetch_optional(&mut *tx).await?;
            if let Some(id) = wish {
                confirm_discovered(&mut tx, link, product).await?;
                if let Some((score, _)) = trend {
                    sqlx::query("UPDATE offer_link SET cheap_score=? WHERE id=?")
                        .bind(score)
                        .bind(link)
                        .execute(&mut *tx)
                        .await?;
                }
                let market = product.purchase_country.as_deref().unwrap_or_default();
                sqlx::query("INSERT INTO price_observation(link_id,product_id,observed_at,market,fingerprint,offers,activation,availability)
                    VALUES(?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING")
                    .bind(link).bind(&product.id).bind(t).bind(market).bind(product.fingerprint())
                    .bind(serde_json::to_string(&product.offers)?).bind(product.activation(market)).bind(product.availability.as_str())
                    .execute(&mut *tx).await?;
                sqlx::query("DELETE FROM price_observation WHERE link_id=? AND observed_at<?")
                    .bind(link)
                    .bind(t - 365 * DAY)
                    .execute(&mut *tx)
                    .await?;
                measured = Some((id, link));
            }
            set_success(&mut tx, shop, t, false).await?;
            Some(match crate::pricing::min_cents(product) {
                Some(cents) => format!("{cents} ct"),
                None => product.availability.as_str().to_string(),
            })
        }
        Ok(Work::Search(page)) => {
            let id = job.wish_id.as_ref().expect("search job");
            let found = enqueue_candidates(&mut tx, shop, id, &page.urls, t, job.bypass).await?;
            sqlx::query("UPDATE shop_job SET result_count=CASE WHEN search_page=1 THEN ? ELSE COALESCE(result_count,0)+? END, search_page=? WHERE id=?")
                .bind(found).bind(found).bind(page.next_page.unwrap_or(1)).bind(job.id)
                .execute(&mut *tx).await?;
            set_success(&mut tx, shop, t, false).await?;
            Some(format!("Seite {}: {found} Produkte", job.search_page))
        }
        Ok(Work::Discovery(candidates, _)) => {
            for (url, key) in candidates {
                sqlx::query("INSERT OR IGNORE INTO shop_candidate(source,url,title_key)
                    SELECT ?,?,? WHERE (SELECT count(*) FROM shop_candidate WHERE source=?) < 40000")
                    .bind(shop.id()).bind(url).bind(key).bind(shop.id()).execute(&mut *tx).await?;
            }
            set_success(&mut tx, shop, t, true).await?;
            Some(format!("{} Kandidaten", candidates.len()))
        }
        Err(error) => {
            if let Some(link) = job.link_id {
                sqlx::query("UPDATE offer_link SET last_error=?,attempted_at=? WHERE id=?")
                    .bind(error.code())
                    .bind(t)
                    .bind(link)
                    .execute(&mut *tx)
                    .await?;
            }
            sqlx::query(
                "UPDATE shop_state SET last_error=?,retry_at=MAX(retry_at,?) WHERE source=?",
            )
            .bind(error.code())
            .bind(t + error.source_pause())
            .bind(shop.id())
            .execute(&mut *tx)
            .await?;
            None
        }
    };
    let kind = Kind::of(job.link_id, job.wish_id.as_deref()).id();
    sqlx::query("INSERT INTO job_run(source,kind,wish_id,link_id,started_at,duration_ms,outcome,detail) VALUES(?,?,?,?,?,?,?,?)")
        .bind(shop.id()).bind(kind).bind(&job.wish_id).bind(job.link_id).bind(started_at).bind(elapsed_ms)
        .bind(result.as_ref().err().map_or("ok", ShopError::code)).bind(detail)
        .execute(&mut *tx).await?;
    sqlx::query("DELETE FROM job_run WHERE started_at<?")
        .bind(t - RUN_RETENTION)
        .execute(&mut *tx)
        .await?;
    // Observation and outbox commit together. The rule reads the current matches using this transaction.
    if let Some((id, link)) = measured {
        alerts::observe(&mut tx, &id, link, t).await?;
    }
    tx.commit().await?;
    if job.link_id.is_none() && job.wish_id.is_none() && result.is_ok() {
        attach(pool, shop).await?;
    }
    Ok(())
}

async fn set_success(
    conn: &mut sqlx::SqliteConnection,
    shop: Shop,
    t: i64,
    discovery: bool,
) -> sqlx::Result<()> {
    sqlx::query("UPDATE shop_state SET last_success=?,last_error=NULL,next_discovery=next_discovery+? WHERE source=?")
        .bind(t).bind(discovery).bind(shop.id()).execute(conn).await?;
    Ok(())
}

/// Persist every discovered region; each product gets its own budgeted, retryable job.
/// `initial` marks new jobs as the first fetch of a direct user action (module docs).
async fn enqueue_candidates(
    conn: &mut sqlx::SqliteConnection,
    shop: Shop,
    id: &str,
    urls: &[String],
    t: i64,
    initial: bool,
) -> sqlx::Result<i64> {
    let mut found = 0;
    for raw in urls {
        let Some(url) = shop.product_url(raw) else {
            continue;
        };
        let link: Option<i64> = sqlx::query_scalar(
            "INSERT INTO offer_link(wish_id,source,url,auto_discovered)
            SELECT ?1,?2,?3,1 WHERE NOT EXISTS(SELECT 1 FROM offer_link_block WHERE wish_id=?1 AND source=?2 AND url=?3)
            ON CONFLICT(wish_id,source,url) DO UPDATE SET url=excluded.url
            WHERE review!='rejected' RETURNING id",
        )
        .bind(id)
        .bind(shop.id())
        .bind(url.as_str())
        .fetch_optional(&mut *conn)
        .await?;
        if let Some(link) = link {
            sqlx::query(
                "INSERT OR IGNORE INTO shop_job(source,link_id,due,initial) VALUES(?,?,?,?)",
            )
            .bind(shop.id())
            .bind(link)
            .bind(t)
            .bind(initial)
            .execute(&mut *conn)
            .await?;
            found += 1;
        }
    }
    Ok(found)
}

async fn confirm_discovered(
    conn: &mut sqlx::SqliteConnection,
    link: i64,
    product: &Product,
) -> sqlx::Result<()> {
    let wish: Option<offers::Wish> = sqlx::query_as(
        "SELECT w.platform_id,g.manual_title,c.payload
        FROM offer_link l JOIN wishlist_item w ON w.id=l.wish_id JOIN game g ON g.id=w.game_id
        LEFT JOIN catalog_game c ON c.igdb_id=g.igdb_id
        WHERE l.id=? AND l.auto_discovered=1 AND l.review='pending'",
    )
    .bind(link)
    .fetch_optional(&mut *conn)
    .await?;
    if wish.is_some_and(|wish| wish.auto_matches(product)) {
        sqlx::query("UPDATE offer_link SET review='confirmed',fingerprint=?,confirmed_name=? WHERE id=? AND review='pending'")
            .bind(product.fingerprint()).bind(&product.name).bind(link).execute(conn).await?;
    }
    Ok(())
}

/// Attach indexed candidates to every non-owned item (after start and after discovery).
async fn attach(pool: &SqlitePool, shop: Shop) -> anyhow::Result<()> {
    let ids: Vec<String> =
        sqlx::query_scalar("SELECT id FROM wishlist_item w WHERE w.state!='owned'")
            .fetch_all(pool)
            .await?;
    for id in ids {
        attach_wish(pool, shop, &id, false).await?;
    }
    Ok(())
}

/// Attach indexed candidates to one item (when it is saved, restored or previewed);
/// `initial` when a user action asked for it.
async fn attach_wish(pool: &SqlitePool, shop: Shop, id: &str, initial: bool) -> anyhow::Result<()> {
    let active: bool =
        sqlx::query_scalar("SELECT configured AND enabled FROM source_settings WHERE id=?")
            .bind(shop.id())
            .fetch_one(pool)
            .await?;
    if !active {
        return Ok(());
    }
    let Ok(wish) = offers::wish(pool, id).await else {
        return Ok(());
    };
    let keys = shop.candidate_keys(wish.keys());
    if keys.is_empty() {
        return Ok(());
    }
    let urls: Vec<String> = sqlx::query_scalar(
        "SELECT url FROM shop_candidate c WHERE source=?
        AND title_key IN (SELECT value FROM json_each(?))
        AND NOT EXISTS(SELECT 1 FROM offer_link l WHERE l.wish_id=? AND l.source=c.source AND l.url=c.url) ORDER BY url",
    )
    .bind(shop.id())
    .bind(serde_json::to_string(&keys)?)
    .bind(id)
    .fetch_all(pool)
    .await?;
    if urls.is_empty() {
        return Ok(());
    }
    let mut tx = pool.begin().await?;
    enqueue_candidates(&mut tx, shop, id, &urls, now(), initial).await?;
    tx.commit().await?;
    Ok(())
}

/// Queue the search and the indexed candidates of an item a user saved, restored, refreshed
/// or previewed. New jobs are direct user actions (they bypass pacing only for wishes).
pub(crate) async fn schedule_wish(pool: &SqlitePool, id: &str) -> sqlx::Result<()> {
    sqlx::query("INSERT OR IGNORE INTO shop_job(source,wish_id,due,initial) SELECT 'eneba',id,?,1 FROM wishlist_item w WHERE id=? AND w.state!='owned'")
        .bind(now()).bind(id).execute(pool).await?;
    for shop in Shop::ALL {
        if let Err(error) = attach_wish(pool, shop, id, true).await {
            tracing::warn!(source = shop.id(), %error, "Candidate attachment failed");
        }
    }
    Ok(())
}

/// Expected jobs per day of a shop under its current schedule.
///
/// Uses the scheduler's own rules: the [`queued`] filter (no owned or rejected items, previews
/// only while watched and viewed in the last 14 days, nothing without an active wish), the
/// effective adaptive interval ([`effective_interval`], stored price-trend pace) and the repeat delay of
/// each kind ([`Kind::repeat_after`]). One-off work (first searches, continuation pages, new links,
/// retries) is not part of the steady state and therefore not counted.
pub(crate) async fn demand(pool: &SqlitePool, shop: Shop, t: i64) -> sqlx::Result<f64> {
    type Group = (Option<i64>, Option<String>, bool, i64, f64, i64);
    let groups: Vec<Group> = sqlx::query_as(AssertSqlSafe(format!(
        "SELECT MIN(j.link_id),MIN(j.wish_id),COALESCE(t.state,'wished')='preview',s.poll_interval_seconds,j.pace,COUNT(*)
        FROM shop_job j JOIN source_settings s ON s.id=j.source LEFT JOIN offer_link l ON l.id=j.link_id {ITEM}
        WHERE j.source=?1 AND s.enabled AND s.configured AND {}
        GROUP BY j.link_id IS NOT NULL,j.wish_id IS NOT NULL,3,4,5",
        queued()
    )))
    .bind(shop.id())
    .bind(t)
    .fetch_all(pool)
    .await?;
    Ok(groups
        .into_iter()
        .map(|(link, wish, preview, interval, pace, count)| {
            let kind = Kind::of(link, wish.as_deref());
            let pace = if kind == Kind::Product { pace } else { 1.0 };
            let interval = effective_interval(interval, preview, pace);
            let period = if kind == Kind::Discovery {
                shop.discovery_every(interval)
            } else {
                kind.repeat_after(interval)
            };
            count as f64 * DAY as f64 / period as f64
        })
        .sum())
}

/// Budget part of the fetch status of one shop.
async fn budget_status(pool: &SqlitePool, shop: Shop, t: i64) -> sqlx::Result<Value> {
    let today = t - t.rem_euclid(DAY);
    let (setting, used, paced_until, retry_at, enabled): (Option<i64>, i64, i64, i64, bool) =
        sqlx::query_as(
            "SELECT s.daily_jobs,CASE WHEN p.budget_day=? THEN p.jobs_today ELSE 0 END,p.paced_until,p.retry_at,(s.enabled AND s.configured)
            FROM shop_state p JOIN source_settings s ON s.id=p.source WHERE p.source=?",
        )
        .bind(t / DAY)
        .bind(shop.id())
        .fetch_one(pool)
        .await?;
    let limit = daily_limit(setting);
    let limit_source = if setting.is_some() {
        "setting"
    } else {
        default_budget().1
    };
    // A paced job waits for `paced_until`, a direct user action only for its due time.
    let next_job: Option<i64> = sqlx::query_scalar(AssertSqlSafe(format!(
        "SELECT MIN(CASE WHEN {} THEN j.due ELSE MAX(j.due,?4) END)
        FROM shop_job j LEFT JOIN offer_link l ON l.id=j.link_id {ITEM} WHERE j.source=?1 AND {}",
        bypass("?3"),
        queued()
    )))
    .bind(shop.id())
    .bind(t)
    .bind(t - REQUEST_WINDOW)
    .bind(paced_until)
    .fetch_one(pool)
    .await?;
    let paused: bool = sqlx::query_scalar(AssertSqlSafe(format!("SELECT {PAUSED_AT} IS NOT NULL")))
        .fetch_one(pool)
        .await?;
    let next_at = next_job.filter(|_| enabled && !paused).map(|at| {
        let at = at.max(t).max(retry_at);
        if used >= limit {
            at.max(today + DAY)
        } else {
            at
        }
    });
    let hours: Vec<(i64, i64)> = sqlx::query_as(
        "SELECT (started_at-?2)/3600,COUNT(*) FROM job_run WHERE source=?1 AND started_at>=?2 AND started_at<?2+86400 GROUP BY 1",
    )
    .bind(shop.id())
    .bind(today)
    .fetch_all(pool)
    .await?;
    let mut by_hour = [0i64; 24];
    for (hour, count) in hours {
        if let Some(slot) = usize::try_from(hour).ok().and_then(|h| by_hour.get_mut(h)) {
            *slot = count;
        }
    }
    Ok(json!({
        "used": used,
        "limit": limit,
        "limit_source": limit_source,
        "demand_per_day": demand(pool, shop, t).await?.round() as i64,
        "pace_seconds": pace_gap(t, limit - used),
        "next_at": next_at,
        "by_hour": by_hour,
    }))
}

/// POST /api/v1/status/fetch/pause `{"paused": bool}`: pause or resume the automatic shop checks.
/// While paused only direct user actions run (requested refresh, first search of a new wish).
pub(crate) async fn set_paused(
    State(state): State<Shared>,
    headers: HeaderMap,
    Json(input): Json<Value>,
) -> ApiResult<Json<Value>> {
    let session = auth::authenticate(&state, &headers).await?;
    auth::require_csrf(&state, &headers, &session)?;
    let Some(paused) = input["paused"].as_bool() else {
        return Err(crate::ApiError(
            axum::http::StatusCode::BAD_REQUEST,
            "Ungültige Anfrage.",
        ));
    };
    // Pausing again keeps the original start; resuming clears it.
    sqlx::query("UPDATE app_settings SET fetch_paused_at=CASE WHEN ? THEN COALESCE(fetch_paused_at,?) END WHERE id=1")
        .bind(paused)
        .bind(now())
        .execute(&state.pool)
        .await?;
    let paused_at: Option<i64> = sqlx::query_scalar(AssertSqlSafe(format!("SELECT {PAUSED_AT}")))
        .fetch_one(&state.pool)
        .await?;
    Ok(Json(json!({ "paused_at": paused_at })))
}

/// GET /api/v1/status/fetch: queue, budget, pauses and recent runs per shop.
pub(crate) async fn status(
    State(state): State<Shared>,
    headers: HeaderMap,
) -> ApiResult<Json<Value>> {
    auth::authenticate(&state, &headers).await?;
    let t = now();
    type ShopRow = (String, bool, Option<i64>, Option<String>, i64);
    let rows: Vec<ShopRow> = sqlx::query_as(
        "SELECT s.id,(s.enabled AND s.configured),p.last_success,p.last_error,p.retry_at
        FROM shop_state p JOIN source_settings s ON s.id=p.source WHERE s.configured=1 ORDER BY s.id",
    )
    .fetch_all(&state.pool)
    .await?;
    let mut shops = Vec::new();
    for (source, enabled, last_success, last_error, retry_at) in rows {
        let Some(shop) = Shop::from_id(&source) else {
            continue;
        };
        type Backlog = (i64, Option<i64>, Option<i64>, Option<i64>, Option<i64>);
        let (due, oldest, requested, products, searches): Backlog = sqlx::query_as(AssertSqlSafe(format!(
            "SELECT COUNT(*),MIN(j.due),SUM(j.requested_at>?3),SUM(j.link_id IS NOT NULL),SUM(j.wish_id IS NOT NULL)
            FROM shop_job j LEFT JOIN offer_link l ON l.id=j.link_id {ITEM}
            WHERE j.source=?1 AND j.due<=?2 AND j.lease_until<=?2 AND (j.link_id IS NULL OR l.review!='rejected')
            AND {NOT_OWNED} AND {WATCHED_IF_PREVIEW}"
        )))
        .bind(&source)
        .bind(t)
        .bind(t - REQUEST_WINDOW)
        .fetch_one(&state.pool)
        .await?;
        let next_due: Option<i64> =
            sqlx::query_scalar("SELECT MIN(due) FROM shop_job WHERE source=? AND due>?")
                .bind(&source)
                .bind(t)
                .fetch_one(&state.pool)
                .await?;
        shops.push(json!({
            "source": source,
            "enabled": enabled,
            "last_success_at": last_success,
            "last_error": last_error,
            "paused_until": (retry_at > t).then_some(retry_at),
            "budget": budget_status(&state.pool, shop, t).await?,
            "backlog": {"due": due, "requested": requested.unwrap_or(0), "products": products.unwrap_or(0), "searches": searches.unwrap_or(0)},
            "oldest_due_at": oldest,
            "next_due_at": next_due,
            "worker_seen_at": state.heartbeat.last(shop),
        }));
    }
    type Run = (
        String,
        String,
        Option<String>,
        Option<i64>,
        i64,
        i64,
        String,
        Option<String>,
    );
    let runs: Vec<Run> = sqlx::query_as("SELECT source,kind,wish_id,link_id,started_at,duration_ms,outcome,detail FROM job_run ORDER BY started_at DESC,id DESC LIMIT 25")
        .fetch_all(&state.pool).await?;
    let errors: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM job_run WHERE started_at>? AND outcome!='ok'")
            .bind(t - DAY)
            .fetch_one(&state.pool)
            .await?;
    let paused_at: Option<i64> = sqlx::query_scalar(AssertSqlSafe(format!("SELECT {PAUSED_AT}")))
        .fetch_one(&state.pool)
        .await?;
    Ok(Json(json!({
        "paused_at": paused_at,
        "shops": shops,
        "errors_24h": errors,
        "recent_runs": runs.into_iter().map(|(source, kind, wish_id, link_id, started_at, duration_ms, outcome, detail)| json!({
            "source": source, "kind": kind, "wish_id": wish_id, "link_id": link_id,
            "started_at": started_at, "duration_ms": duration_ms, "outcome": outcome, "detail": detail,
        })).collect::<Vec<_>>(),
    })))
}

#[cfg(test)]
mod tests {
    use super::*;
    /// Lift the pacing of every shop, for tests about other scheduling rules.
    async fn unpace(pool: &SqlitePool) {
        sqlx::query("UPDATE shop_state SET paced_until=0")
            .execute(pool)
            .await
            .unwrap();
    }
    #[tokio::test]
    async fn discovered_product_prices_run_before_more_search_pages() {
        let pool = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        sqlx::migrate!("./migrations").run(&pool).await.unwrap();
        sqlx::query(
            "INSERT INTO game(id,manual_title,manual_key,created_at) VALUES('g','Game','game',0)",
        )
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query("INSERT INTO wishlist_item(id,game_id,platform_id,created_at) VALUES('saved','g',169,0)")
            .execute(&pool)
            .await
            .unwrap();
        schedule_wish(&pool, "saved").await.unwrap();
        // A continuation page of a search that already started.
        sqlx::query("UPDATE shop_job SET checked_at=0,search_page=2 WHERE wish_id='saved'")
            .execute(&pool)
            .await
            .unwrap();
        let link:i64=sqlx::query_scalar("INSERT INTO offer_link(wish_id,source,url) VALUES('saved','eneba','https://www.eneba.com/test') RETURNING id").fetch_one(&pool).await.unwrap();
        sqlx::query("INSERT INTO shop_job(source,link_id,due) VALUES('eneba',?,0)")
            .bind(link)
            .execute(&pool)
            .await
            .unwrap();
        let job = claim(&pool, Shop::Eneba, "price", now(), 120)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(job.link_id, Some(link));
    }
    #[tokio::test]
    async fn prepared_editions_follow_only_their_active_saved_anchor() {
        let pool = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        sqlx::migrate!("./migrations").run(&pool).await.unwrap();
        sqlx::query(
            "INSERT INTO game(id,manual_title,manual_key,created_at) VALUES('g','Game','game',0)",
        )
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query("INSERT INTO game(id,manual_title,manual_key,created_at) VALUES('g2','Other','other',0)").execute(&pool).await.unwrap();
        sqlx::query("INSERT INTO wishlist_item(id,game_id,platform_id,created_at) VALUES('anchor','g',169,0),('preview','g',49,0),('other','g2',169,0)").execute(&pool).await.unwrap();
        sqlx::query("UPDATE wishlist_item SET state='preview',viewed_at=? WHERE id='preview'")
            .bind(now())
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO edition_watch VALUES('anchor','preview')")
            .execute(&pool)
            .await
            .unwrap();
        schedule_wish(&pool, "preview").await.unwrap();
        sqlx::query("UPDATE shop_job SET due=? WHERE wish_id IS NULL")
            .bind(now() + DAY)
            .execute(&pool)
            .await
            .unwrap();
        assert_eq!(
            claim(&pool, Shop::Eneba, "active", now(), 120)
                .await
                .unwrap()
                .unwrap()
                .wish_id
                .as_deref(),
            Some("preview")
        );
        sqlx::query("UPDATE shop_job SET lease_until=0,lease_token=NULL")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("UPDATE wishlist_item SET viewed_at=? WHERE state='preview'")
            .bind(now())
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("UPDATE wishlist_item SET state='owned',acquired_at=0 WHERE id='anchor'")
            .execute(&pool)
            .await
            .unwrap();
        assert!(
            claim(&pool, Shop::Eneba, "owned", now(), 120)
                .await
                .unwrap()
                .is_none()
        );
        sqlx::query("DELETE FROM wishlist_item WHERE id='anchor'")
            .execute(&pool)
            .await
            .unwrap();
        assert!(
            claim(&pool, Shop::Eneba, "removed", now(), 120)
                .await
                .unwrap()
                .is_none()
        );
    }
    #[test]
    fn transient_errors_climb_a_ladder_and_searches_repeat_weekly() {
        for interval in [900, 28800, 604800] {
            for (failures, wait) in [(0, 120), (1, 600), (2, 3600), (3, interval), (9, interval)] {
                assert_eq!(
                    next_schedule(&Err(ShopError::Network), failures, 100, interval, 0),
                    (100 + wait, failures + 1)
                );
            }
            assert_eq!(
                next_schedule(&Err(ShopError::Parse), 0, 100, interval, 0),
                (100 + interval, 1),
                "a changed page waits a full interval"
            );
            let done = crate::shops::eneba::SearchPage {
                urls: vec![],
                next_page: None,
            };
            assert_eq!(
                next_schedule(&Ok(Work::Search(done)), 0, 100, interval, 0),
                (100 + WEEK.max(interval), 0)
            );
            assert_eq!(
                next_schedule(&Ok(Work::Discovery(vec![], None)), 0, 100, interval, 0),
                (100 + DAY.max(interval), 0)
            );
            // Driffle: the next sitemap right away during the first pass, else after the wait it returned.
            assert_eq!(
                next_schedule(&Ok(Work::Discovery(vec![], Some(0))), 0, 100, interval, 0),
                (100, 0)
            );
            assert_eq!(
                next_schedule(
                    &Ok(Work::Discovery(vec![], Some(16200))),
                    0,
                    100,
                    interval,
                    0
                ),
                (16300, 0)
            );
            let page = crate::shops::eneba::SearchPage {
                urls: vec![],
                next_page: Some(2),
            };
            assert_eq!(
                next_schedule(&Ok(Work::Search(page)), 0, 100, interval, 0),
                (100, 0)
            );
        }
        assert!(next_schedule(&Err(ShopError::Throttled(90000)), 0, 100, 28800, 0).0 >= 90100);
    }
    #[tokio::test]
    async fn owned_jobs_are_never_claimed_even_with_other_active_wishes() {
        let pool = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        sqlx::migrate!("./migrations").run(&pool).await.unwrap();
        sqlx::query(
            "INSERT INTO game(id,manual_title,manual_key,created_at) VALUES('g','Game','game',0)",
        )
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query("INSERT INTO wishlist_item(id,game_id,platform_id,created_at) VALUES('owned','g',169,0),('active','g',49,0)")
            .execute(&pool)
            .await
            .unwrap();
        schedule_wish(&pool, "owned").await.unwrap();
        sqlx::query("UPDATE wishlist_item SET state='owned',acquired_at=0 WHERE id='owned'")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("UPDATE shop_job SET due=? WHERE wish_id IS NULL")
            .bind(now() + DAY)
            .execute(&pool)
            .await
            .unwrap();
        assert!(
            claim(&pool, Shop::Eneba, "test", now(), 120)
                .await
                .unwrap()
                .is_none()
        );
    }
    #[tokio::test]
    async fn unwatched_edition_previews_do_not_use_background_shop_jobs() {
        let pool = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        sqlx::migrate!("./migrations").run(&pool).await.unwrap();
        sqlx::query(
            "INSERT INTO game(id,manual_title,manual_key,created_at) VALUES('g','Game','game',0)",
        )
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query("INSERT INTO wishlist_item(id,game_id,platform_id,created_at) VALUES('saved','g',169,0),('preview','g',49,0)")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("UPDATE wishlist_item SET state='preview',viewed_at=? WHERE id='preview'")
            .bind(now() - 2 * DAY)
            .execute(&pool)
            .await
            .unwrap();
        schedule_wish(&pool, "preview").await.unwrap();
        let job = claim(&pool, Shop::Eneba, "expired", now(), 120)
            .await
            .unwrap()
            .unwrap();
        assert_ne!(job.wish_id.as_deref(), Some("preview"));
        sqlx::query(
            "UPDATE shop_job SET lease_until=0,lease_token=NULL,due=? WHERE wish_id IS NULL",
        )
        .bind(now() + DAY)
        .execute(&pool)
        .await
        .unwrap();
        unpace(&pool).await;
        sqlx::query("INSERT INTO edition_watch VALUES('saved','preview')")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("UPDATE wishlist_item SET viewed_at=? WHERE state='preview'")
            .bind(now())
            .execute(&pool)
            .await
            .unwrap();
        let job = claim(&pool, Shop::Eneba, "active", now(), 120)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(job.wish_id.as_deref(), Some("preview"));
        // A watched preview nobody opened for 14 days rests until it is viewed again.
        sqlx::query("UPDATE shop_job SET lease_until=0,lease_token=NULL,checked_at=NULL")
            .execute(&pool)
            .await
            .unwrap();
        unpace(&pool).await;
        sqlx::query("UPDATE wishlist_item SET viewed_at=? WHERE id='preview'")
            .bind(now() - 15 * DAY)
            .execute(&pool)
            .await
            .unwrap();
        let job = claim(&pool, Shop::Eneba, "idle", now(), 120).await.unwrap();
        assert_ne!(job.and_then(|j| j.wish_id).as_deref(), Some("preview"));
    }
    #[tokio::test]
    async fn automatic_products_confirm_only_matching_discovered_links_and_preserve_reviews() {
        let pool = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        sqlx::migrate!("./migrations").run(&pool).await.unwrap();
        let payload=serde_json::json!({"igdb_id":1,"name":"Forza Horizon 5","slug":null,"summary":null,"first_release_date":null,
            "platforms":[{"id":169,"name":"Xbox Series X|S"}],"aliases":[],"cover_url":null,
            "version_parent":null,"edition_name":null,"kind":"base_game","fetched_at":0}).to_string();
        sqlx::query("INSERT INTO catalog_game VALUES(1,?,0)")
            .bind(payload)
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO game(id,igdb_id,created_at) VALUES('g',1,0)")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query(
            "INSERT INTO wishlist_item(id,game_id,platform_id,created_at) VALUES('wish','g',169,0)",
        )
        .execute(&pool)
        .await
        .unwrap();
        let product = Product {
            id: "fixture".into(),
            name: "Forza Horizon 5".into(),
            title: "Forza Horizon 5".into(),
            platform_ids: vec![169],
            key_game: true,
            region: Some("Argentina".into()),
            allowed: vec![],
            blocked: vec!["DE".into()],
            purchase_country: Some("DE".into()),
            offers: vec![],
            availability: crate::shops::Availability::Unknown,
        };
        let mut conn = pool.acquire().await.unwrap();
        for (i, review, auto, expected) in [
            (1, "pending", true, "confirmed"),
            (2, "pending", false, "pending"),
            (3, "rejected", true, "rejected"),
            (4, "confirmed", true, "confirmed"),
        ] {
            sqlx::query("INSERT INTO offer_link(id,wish_id,source,url,review,auto_discovered,fingerprint) VALUES(?,'wish','eneba',?,?,?,'original')")
                .bind(i).bind(format!("https://www.eneba.com/de/xbox-game-key-{i}")).bind(review).bind(auto).execute(&mut *conn).await.unwrap();
            confirm_discovered(&mut conn, i, &product).await.unwrap();
            let (actual, fingerprint): (String, Option<String>) =
                sqlx::query_as("SELECT review,fingerprint FROM offer_link WHERE id=?")
                    .bind(i)
                    .fetch_one(&mut *conn)
                    .await
                    .unwrap();
            assert_eq!(actual, expected);
            assert_eq!(
                fingerprint,
                Some(if i == 1 {
                    product.fingerprint()
                } else {
                    "original".into()
                })
            );
        }
        // A regional restriction does not reject identity; mismatched editions/platforms do.
        for (i, mut mismatch) in [product.clone(), product.clone(), product.clone()]
            .into_iter()
            .enumerate()
        {
            match i {
                0 => mismatch.title = "Forza Horizon 5 Premium Edition".into(),
                1 => mismatch.platform_ids = vec![49],
                _ => mismatch.key_game = false,
            }
            sqlx::query("UPDATE offer_link SET review='pending',auto_discovered=1 WHERE id=1")
                .execute(&mut *conn)
                .await
                .unwrap();
            confirm_discovered(&mut conn, 1, &mismatch).await.unwrap();
            assert_eq!(
                sqlx::query_scalar::<_, String>("SELECT review FROM offer_link WHERE id=1")
                    .fetch_one(&mut *conn)
                    .await
                    .unwrap(),
                "pending"
            );
        }
    }
    #[tokio::test]
    async fn indexed_regions_are_all_queued_once_regardless_of_country_preference() {
        let pool = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        sqlx::migrate!("./migrations").run(&pool).await.unwrap();
        sqlx::query("INSERT INTO game(id,manual_title,manual_key,created_at) VALUES('g','Forza Horizon 5','forza horizon 5',0)").execute(&pool).await.unwrap();
        sqlx::query(
            "INSERT INTO wishlist_item(id,game_id,platform_id,created_at) VALUES('wish','g',169,0)",
        )
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query("UPDATE app_settings SET target_country='DE'")
            .execute(&pool)
            .await
            .unwrap();
        for i in 0..20 {
            sqlx::query("INSERT INTO shop_candidate(source,url,title_key) VALUES('eneba',?,'forza horizon 5')")
                .bind(format!("https://www.eneba.com/de/xbox-forza-horizon-5-pc-xbox-live-key-country-{i}"))
                .execute(&pool).await.unwrap();
        }
        attach(&pool, Shop::Eneba).await.unwrap();
        sqlx::query("UPDATE app_settings SET target_country='US'")
            .execute(&pool)
            .await
            .unwrap();
        attach(&pool, Shop::Eneba).await.unwrap();
        for query in [
            "SELECT COUNT(*) FROM offer_link",
            "SELECT COUNT(*) FROM shop_job WHERE link_id IS NOT NULL",
        ] {
            assert_eq!(
                sqlx::query_scalar::<_, i64>(query)
                    .fetch_one(&pool)
                    .await
                    .unwrap(),
                20
            );
        }
    }
    #[tokio::test]
    async fn deleted_mappings_are_not_suggested_again() {
        let pool = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        sqlx::migrate!("./migrations").run(&pool).await.unwrap();
        sqlx::query("INSERT INTO game(id,manual_title,manual_key,created_at) VALUES('g','Forza Horizon 5','forza horizon 5',0)").execute(&pool).await.unwrap();
        sqlx::query(
            "INSERT INTO wishlist_item(id,game_id,platform_id,created_at) VALUES('wish','g',169,0)",
        )
        .execute(&pool)
        .await
        .unwrap();
        for region in ["global", "turkey"] {
            sqlx::query("INSERT INTO shop_candidate(source,url,title_key) VALUES('eneba',?,'forza horizon 5')")
                .bind(format!("https://www.eneba.com/de/xbox-forza-horizon-5-xbox-live-key-{region}"))
                .execute(&pool).await.unwrap();
        }
        sqlx::query("INSERT INTO offer_link_block(wish_id,source,url,blocked_at) VALUES('wish','eneba','https://www.eneba.com/de/xbox-forza-horizon-5-xbox-live-key-turkey',0)")
            .execute(&pool).await.unwrap();
        attach(&pool, Shop::Eneba).await.unwrap();
        let urls: Vec<String> = sqlx::query_scalar("SELECT url FROM offer_link")
            .fetch_all(&pool)
            .await
            .unwrap();
        assert_eq!(
            urls,
            ["https://www.eneba.com/de/xbox-forza-horizon-5-xbox-live-key-global"]
        );
    }

    #[tokio::test]
    async fn wishlist_searches_are_persistent_idempotent_prioritized_and_cascade() {
        let pool = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        sqlx::migrate!("./migrations").run(&pool).await.unwrap();
        sqlx::query("INSERT INTO game(id,manual_title,manual_key,created_at) VALUES('g','Example','example',0)").execute(&pool).await.unwrap();
        sqlx::query(
            "INSERT INTO wishlist_item(id,game_id,platform_id,created_at) VALUES('wish','g',169,0)",
        )
        .execute(&pool)
        .await
        .unwrap();
        schedule_wish(&pool, "wish").await.unwrap();
        schedule_wish(&pool, "wish").await.unwrap();
        assert_eq!(
            sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM shop_job WHERE wish_id='wish'")
                .fetch_one(&pool)
                .await
                .unwrap(),
            1
        );
        let claimed = claim(&pool, Shop::Eneba, "search", now(), 120)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(claimed.wish_id.as_deref(), Some("wish"));
        assert!(claimed.link_id.is_none());
        sqlx::query("DELETE FROM wishlist_item WHERE id='wish'")
            .execute(&pool)
            .await
            .unwrap();
        assert_eq!(
            sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM shop_job WHERE wish_id='wish'")
                .fetch_one(&pool)
                .await
                .unwrap(),
            0
        );
    }
    #[tokio::test]
    async fn persistent_lease_budget_and_source_pause() {
        let pool = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        sqlx::migrate!("./migrations").run(&pool).await.unwrap();
        sqlx::query(
            "INSERT INTO game(id,manual_title,manual_key,created_at) VALUES('g','Game','game',0)",
        )
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO wishlist_item(id,game_id,platform_id,created_at) VALUES('wish','g',169,0)",
        )
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query("UPDATE source_settings SET enabled=1 WHERE id='driffle'")
            .execute(&pool)
            .await
            .unwrap();
        let t = DAY;
        let (a, b) = tokio::join!(
            claim(&pool, Shop::Eneba, "one", t, 3),
            claim(&pool, Shop::Eneba, "two", t, 3)
        );
        assert_ne!(a.unwrap().is_some(), b.unwrap().is_some());
        assert!(
            claim(&pool, Shop::Driffle, "independent", t, 1)
                .await
                .unwrap()
                .is_some()
        );
        assert!(
            claim(&pool, Shop::Eneba, "not_yet", t + 179, 3)
                .await
                .unwrap()
                .is_none()
        );
        unpace(&pool).await;
        assert!(
            claim(&pool, Shop::Eneba, "reclaimed", t + 180, 3)
                .await
                .unwrap()
                .is_some()
        );
        assert!(
            claim(&pool, Shop::Driffle, "budget", t + 180, 1)
                .await
                .unwrap()
                .is_none()
        );
        unpace(&pool).await;
        assert!(
            claim(&pool, Shop::Driffle, "next_day", t + DAY, 1)
                .await
                .unwrap()
                .is_some()
        );
        sqlx::query("UPDATE shop_state SET retry_at=? WHERE source='eneba'")
            .bind(t + 600)
            .execute(&pool)
            .await
            .unwrap();
        assert!(
            claim(&pool, Shop::Eneba, "paused", t + 599, 3)
                .await
                .unwrap()
                .is_none()
        );
        unpace(&pool).await;
        assert!(
            claim(&pool, Shop::Eneba, "resumed", t + 600, 3)
                .await
                .unwrap()
                .is_some()
        );
    }

    #[tokio::test]
    async fn budget_keeps_every_region_of_active_wishes_fresh_alike() {
        use crate::shops::{Quote, eneba::SearchPage};
        let pool = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        sqlx::migrate!("./migrations").run(&pool).await.unwrap();
        sqlx::query("UPDATE app_settings SET target_country='DE'")
            .execute(&pool)
            .await
            .unwrap();
        const T0: i64 = 1_800_000_000 - 1_800_000_000 % DAY;
        let mut relevant = std::collections::HashMap::new();
        let (mut active_valid, mut active_other, mut previews) = (vec![], vec![], vec![]);
        async fn item(pool: &SqlitePool, id: &str) {
            sqlx::query("INSERT INTO game(id,manual_title,manual_key,created_at) VALUES(?,?,?,0)")
                .bind(id)
                .bind(id)
                .bind(id)
                .execute(pool)
                .await
                .unwrap();
            sqlx::query(
                "INSERT INTO wishlist_item(id,game_id,platform_id,created_at) VALUES(?,?,169,0)",
            )
            .bind(id)
            .bind(id)
            .execute(pool)
            .await
            .unwrap();
            sqlx::query("INSERT INTO shop_job(source,wish_id,due) VALUES('eneba',?,?)")
                .bind(id)
                .bind(T0)
                .execute(pool)
                .await
                .unwrap();
        }
        async fn link(pool: &SqlitePool, wish: &str, n: usize) -> i64 {
            let id: i64 = sqlx::query_scalar("INSERT INTO offer_link(wish_id,source,url,review) VALUES(?,'eneba',?,'confirmed') RETURNING id")
                .bind(wish).bind(format!("https://www.eneba.com/de/xbox-{wish}-{n}-key-global"))
                .fetch_one(pool).await.unwrap();
            sqlx::query("INSERT INTO shop_job(source,link_id,due) VALUES('eneba',?,?)")
                .bind(id)
                .bind(T0)
                .execute(pool)
                .await
                .unwrap();
            id
        }
        // 10 active wishes and 2 watched edition previews each, 10 regional variants per item,
        // of which 2 are activatable in DE: 300 products and 30 searches for 40 jobs a day
        // (the same ratio as 900 products for the default budget of 120).
        const BUDGET: i64 = 40;
        for w in 0..10 {
            let wish = format!("w{w}");
            item(&pool, &wish).await;
            for n in 0..10 {
                let id = link(&pool, &wish, n).await;
                relevant.insert(id, n < 2);
                if n < 2 {
                    active_valid.push(id)
                } else {
                    active_other.push(id)
                }
            }
            for e in 0..2 {
                let preview = format!("p{w}x{e}");
                item(&pool, &preview).await;
                sqlx::query("UPDATE wishlist_item SET state='preview',viewed_at=? WHERE id=?")
                    .bind(T0)
                    .bind(&preview)
                    .execute(&pool)
                    .await
                    .unwrap();
                sqlx::query("INSERT INTO edition_watch VALUES(?,?)")
                    .bind(&wish)
                    .bind(&preview)
                    .execute(&pool)
                    .await
                    .unwrap();
                for n in 0..10 {
                    let id = link(&pool, &preview, n).await;
                    relevant.insert(id, n < 2);
                    previews.push(id);
                }
            }
        }
        let product = |valid: bool| Product {
            id: "fixture".into(),
            name: "Game".into(),
            title: "Game".into(),
            platform_ids: vec![169],
            key_game: true,
            region: Some("Global".into()),
            allowed: if valid { vec!["DE".into()] } else { vec![] },
            blocked: vec![],
            purchase_country: Some("DE".into()),
            offers: vec![Quote {
                id: "q".into(),
                cents: 2000,
                seller: None,
            }],
            availability: Availability::InStock,
        };
        let stale_count = |ids: &[i64], since: i64| {
            let ids = serde_json::to_string(ids).unwrap();
            let pool = pool.clone();
            async move {
                sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM offer_link WHERE id IN (SELECT value FROM json_each(?)) AND COALESCE(observed_at,0)<?")
                    .bind(ids).bind(since).fetch_one(&pool).await.unwrap()
            }
        };
        let mut late_search = None;
        let mut t = T0;
        while t < T0 + 10 * DAY {
            if t == T0 + 6 * DAY {
                item(&pool, "late").await;
                sqlx::query("UPDATE shop_job SET due=? WHERE wish_id='late'")
                    .bind(t)
                    .execute(&pool)
                    .await
                    .unwrap();
            }
            // The worker claims whatever budget and pacing allow at this time.
            while let Some(job) = claim(&pool, Shop::Eneba, "aa", t, BUDGET).await.unwrap() {
                if job.wish_id.as_deref() == Some("late") && late_search.is_none() {
                    late_search = Some(t);
                }
                let result = match (job.link_id, &job.wish_id) {
                    (Some(id), _) => Ok(Work::Product(Box::new(product(relevant[&id])))),
                    (None, Some(_)) => Ok(Work::Search(SearchPage {
                        urls: vec![],
                        next_page: None,
                    })),
                    (None, None) => Ok(Work::Discovery(vec![], None)),
                };
                complete(&pool, Shop::Eneba, &job, "aa", result, t + 5, t, 5000)
                    .await
                    .unwrap();
            }
            t += 300;
            if t % DAY == 0 && t >= T0 + 5 * DAY {
                // Every region of an active wish shares the budget alike, valid in DE or not.
                for (ids, what) in [(&active_valid, "DE-valid"), (&active_other, "other")] {
                    assert_eq!(
                        stale_count(ids, t - 4 * DAY).await,
                        0,
                        "every {what} variant of an active wish is at most four days old on day {}",
                        (t - T0) / DAY
                    );
                }
            }
        }
        assert_eq!(
            late_search,
            Some(T0 + 6 * DAY),
            "a new wish is searched at once"
        );
        assert_eq!(
            stale_count(&active_other, 0).await,
            0,
            "other regions are not starved"
        );
        assert!(
            stale_count(&previews, 0).await < previews.len() as i64 / 2,
            "previews keep a share of the budget"
        );
        let runs: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM job_run")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert!(runs <= BUDGET * 10, "the daily budget holds: {runs} runs");
        // Pacing spreads the budget: no UTC hour of a busy day gets more than a few jobs.
        let busiest: i64 = sqlx::query_scalar(
            "SELECT MAX(n) FROM (SELECT COUNT(*) AS n FROM job_run WHERE started_at>=? GROUP BY started_at/3600)",
        )
        .bind(T0 + DAY)
        .fetch_one(&pool)
        .await
        .unwrap();
        assert!(busiest <= 6, "at most 6 jobs in one hour, got {busiest}");
        assert!(
            runs >= BUDGET * 9,
            "pacing still uses the budget: {runs} runs"
        );
    }

    async fn memory() -> SqlitePool {
        let pool = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        sqlx::migrate!("./migrations").run(&pool).await.unwrap();
        pool
    }

    async fn add_item(pool: &SqlitePool, id: &str, state: &str) {
        sqlx::query("INSERT INTO game(id,manual_title,manual_key,created_at) VALUES(?,?,?,0)")
            .bind(id)
            .bind(id)
            .bind(id)
            .execute(pool)
            .await
            .unwrap();
        sqlx::query(
            "INSERT INTO wishlist_item(id,game_id,platform_id,created_at,state,viewed_at,acquired_at) VALUES(?,?,169,0,?,?,?)",
        )
        .bind(id)
        .bind(id)
        .bind(state)
        .bind((state == "preview").then_some(i64::MAX / 2))
        .bind((state == "owned").then_some(0))
        .execute(pool)
        .await
        .unwrap();
    }

    async fn add_link(pool: &SqlitePool, wish: &str, n: usize, due: i64) -> i64 {
        let id: i64 = sqlx::query_scalar("INSERT INTO offer_link(wish_id,source,url,review) VALUES(?,'eneba',?,'confirmed') RETURNING id")
            .bind(wish).bind(format!("https://www.eneba.com/de/xbox-{wish}-{n}-key-global"))
            .fetch_one(pool).await.unwrap();
        sqlx::query("INSERT INTO shop_job(source,link_id,due) VALUES('eneba',?,?)")
            .bind(id)
            .bind(due)
            .execute(pool)
            .await
            .unwrap();
        id
    }

    fn priced(valid: bool) -> Product {
        Product {
            id: "fixture".into(),
            name: "Game".into(),
            title: "Game".into(),
            platform_ids: vec![169],
            key_game: true,
            region: Some("Global".into()),
            allowed: if valid { vec!["DE".into()] } else { vec![] },
            blocked: vec![],
            purchase_country: Some("DE".into()),
            offers: vec![crate::shops::Quote {
                id: "q".into(),
                cents: 2000,
                seller: None,
            }],
            availability: Availability::InStock,
        }
    }

    #[test]
    fn pace_spreads_the_remaining_budget_over_the_rest_of_the_utc_day() {
        const T0: i64 = 1_800_000_000 - 1_800_000_000 % DAY;
        assert_eq!(pace_gap(T0, 500), 172);
        assert_eq!(pace_gap(T0, 120), 720);
        assert_eq!(pace_gap(T0 + DAY / 2, 120), 360);
        assert_eq!(pace_gap(T0, 10_000), PACE_MIN, "never faster than 20 s");
        assert_eq!(pace_gap(T0, 20), PACE_MAX, "never slower than one hour");
        assert_eq!(
            pace_gap(T0 + DAY - 600, 0),
            600,
            "no budget left: wait for the new day"
        );
        assert_eq!(pace_gap(T0 + DAY - 5, 1), PACE_MIN);
    }

    #[tokio::test]
    async fn paced_jobs_wait_while_direct_user_actions_bypass_pacing_but_count() {
        use crate::shops::eneba::SearchPage;
        let pool = memory().await;
        const T0: i64 = 1_800_000_000 - 1_800_000_000 % DAY;
        let t = T0 + 3600;
        add_item(&pool, "old", "wished").await;
        // Two known links of an existing wish, due now.
        let known = [
            add_link(&pool, "old", 0, 0).await,
            add_link(&pool, "old", 1, 0).await,
        ];
        sqlx::query("UPDATE offer_link SET observed_at=0")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("UPDATE shop_job SET due=? WHERE wish_id IS NULL AND link_id IS NULL")
            .bind(T0 + 10 * DAY)
            .execute(&pool)
            .await
            .unwrap();
        let first = claim(&pool, Shop::Eneba, "a1", t, 500)
            .await
            .unwrap()
            .unwrap();
        assert!(first.link_id.is_some() && !first.bypass);
        complete(
            &pool,
            Shop::Eneba,
            &first,
            "a1",
            Ok(Work::Product(Box::new(priced(true)))),
            t,
            t,
            1,
        )
        .await
        .unwrap();
        let gap = pace_gap(t, 499);
        let paced: i64 =
            sqlx::query_scalar("SELECT paced_until FROM shop_state WHERE source='eneba'")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(paced, t + gap, "the next paced job time is persisted");
        assert!(
            claim(&pool, Shop::Eneba, "a2", t + gap - 1, 500)
                .await
                .unwrap()
                .is_none(),
            "the second known link waits for its slot"
        );

        // A new wish: its first search, the continuation pages of that run and the first
        // price of every product it found run at once and still use the budget.
        add_item(&pool, "new", "wished").await;
        schedule_wish(&pool, "new").await.unwrap();
        let search = claim(&pool, Shop::Eneba, "s1", t + 10, 500)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(search.wish_id.as_deref(), Some("new"));
        assert!(search.bypass);
        let urls = |n: usize| {
            vec![format!(
                "https://www.eneba.com/de/xbox-new-{n}-xbox-live-key-global"
            )]
        };
        complete(
            &pool,
            Shop::Eneba,
            &search,
            "s1",
            Ok(Work::Search(SearchPage {
                urls: urls(1),
                next_page: Some(2),
            })),
            t + 10,
            t + 10,
            1,
        )
        .await
        .unwrap();
        // Page 2 and the products of pages 1 and 2, in claim order.
        let mut found = vec![];
        for (i, token) in ["j1", "j2", "j3"].into_iter().enumerate() {
            let job = claim(&pool, Shop::Eneba, token, t + 20 + i as i64, 500)
                .await
                .unwrap()
                .unwrap();
            assert!(job.bypass, "{token} bypasses pacing");
            let result = if let Some(link) = job.link_id {
                found.push(link);
                Work::Product(Box::new(priced(true)))
            } else {
                assert_eq!(job.search_page, 2);
                Work::Search(SearchPage {
                    urls: urls(2),
                    next_page: None,
                })
            };
            complete(
                &pool,
                Shop::Eneba,
                &job,
                token,
                Ok(result),
                t + 20 + i as i64,
                t,
                1,
            )
            .await
            .unwrap();
        }
        assert_eq!(found.len(), 2);
        assert!(!found.iter().any(|id| known.contains(id)));
        let (used, still_paced): (i64, i64) =
            sqlx::query_as("SELECT jobs_today,paced_until FROM shop_state WHERE source='eneba'")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(used, 5, "direct user actions count toward the budget");
        assert_eq!(still_paced, t + gap, "and leave the pacing slot alone");
        assert!(
            claim(&pool, Shop::Eneba, "a3", t + gap - 1, 500)
                .await
                .unwrap()
                .is_none(),
            "the new wish's links are done; the next repeated search waits as well"
        );

        // After its first run the repeated search, a refetched product and links attached by
        // a shop-wide discovery are paced again.
        sqlx::query("UPDATE shop_job SET due=0 WHERE wish_id='new' OR link_id IN (SELECT value FROM json_each(?))")
            .bind(serde_json::to_string(&found).unwrap())
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO shop_candidate(source,url,title_key) VALUES('eneba','https://www.eneba.com/de/xbox-new-9-xbox-live-key-global','new')")
            .execute(&pool)
            .await
            .unwrap();
        attach(&pool, Shop::Eneba).await.unwrap();
        assert!(
            claim(&pool, Shop::Eneba, "a4", t + gap - 1, 500)
                .await
                .unwrap()
                .is_none()
        );
        // A requested refresh is class 0 and bypasses pacing.
        sqlx::query("UPDATE shop_job SET requested_at=? WHERE link_id=?")
            .bind(t)
            .bind(known[1])
            .execute(&pool)
            .await
            .unwrap();
        let refresh = claim(&pool, Shop::Eneba, "rr", t + gap - 1, 500)
            .await
            .unwrap()
            .unwrap();
        assert_eq!((refresh.link_id, refresh.bypass), (Some(known[1]), true));
        complete(
            &pool,
            Shop::Eneba,
            &refresh,
            "rr",
            Ok(Work::Product(Box::new(priced(true)))),
            t + gap - 1,
            t,
            1,
        )
        .await
        .unwrap();
        let next = claim(&pool, Shop::Eneba, "a5", t + gap, 500)
            .await
            .unwrap()
            .unwrap();
        assert!(
            !next.bypass,
            "once the slot is reached, paced jobs run again"
        );

        // Budget exhaustion stops direct user actions too.
        sqlx::query("UPDATE source_settings SET daily_jobs=20 WHERE id='eneba'")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("UPDATE shop_state SET jobs_today=20 WHERE source='eneba'")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("UPDATE shop_job SET lease_until=0,lease_token=NULL,requested_at=?")
            .bind(t + gap)
            .execute(&pool)
            .await
            .unwrap();
        assert!(
            claim(&pool, Shop::Eneba, "full", t + gap + 1, 500)
                .await
                .unwrap()
                .is_none()
        );
    }

    #[tokio::test]
    async fn previews_and_manual_restarts_do_not_bypass_pacing() {
        let pool = memory().await;
        add_item(&pool, "anchor", "wished").await;
        add_item(&pool, "preview", "preview").await;
        sqlx::query("INSERT INTO edition_watch VALUES('anchor','preview')")
            .execute(&pool)
            .await
            .unwrap();
        schedule_wish(&pool, "preview").await.unwrap();
        sqlx::query("UPDATE shop_state SET paced_until=? WHERE source='eneba'")
            .bind(now() + 600)
            .execute(&pool)
            .await
            .unwrap();
        assert!(
            claim(&pool, Shop::Eneba, "preview", now(), 500)
                .await
                .unwrap()
                .is_none(),
            "the first search of an edition preview is paced"
        );
        // Once the slot is reached, the preview runs as a paced job.
        unpace(&pool).await;
        let job = claim(&pool, Shop::Eneba, "preview", now(), 500)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            (job.wish_id.as_deref(), job.bypass),
            (Some("preview"), false)
        );
    }

    #[tokio::test]
    async fn the_daily_jobs_setting_overrides_the_default_without_restart() {
        let pool = memory().await;
        add_item(&pool, "wish", "wished").await;
        for n in 0..3 {
            add_link(&pool, "wish", n, 0).await;
        }
        const T0: i64 = 1_800_000_000 - 1_800_000_000 % DAY;
        sqlx::query("UPDATE shop_state SET budget_day=?,jobs_today=25 WHERE source='eneba'")
            .bind(T0 / DAY)
            .execute(&pool)
            .await
            .unwrap();
        assert!(
            claim(&pool, Shop::Eneba, "default", T0, 500)
                .await
                .unwrap()
                .is_some()
        );
        sqlx::query("UPDATE shop_job SET lease_until=0,lease_token=NULL")
            .execute(&pool)
            .await
            .unwrap();
        unpace(&pool).await;
        sqlx::query("UPDATE source_settings SET daily_jobs=26 WHERE id='eneba'")
            .execute(&pool)
            .await
            .unwrap();
        assert!(
            claim(&pool, Shop::Eneba, "setting", T0 + 1, 500)
                .await
                .unwrap()
                .is_none(),
            "26 jobs used of 26"
        );
        let budget = budget_status(&pool, Shop::Eneba, T0 + 1).await.unwrap();
        assert_eq!(budget["limit"], 26);
        assert_eq!(budget["limit_source"], "setting");
        assert_eq!(
            budget["next_at"],
            T0 + DAY,
            "a full budget waits for the next UTC day"
        );
    }

    #[tokio::test]
    async fn fetch_status_reports_pace_next_start_and_runs_per_hour() {
        let pool = memory().await;
        let t = now();
        let today = t - t % DAY;
        add_item(&pool, "wish", "wished").await;
        add_link(&pool, "wish", 0, t + 900).await;
        sqlx::query("UPDATE shop_job SET due=? WHERE link_id IS NULL AND wish_id IS NULL")
            .bind(t + 7200)
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query(
            "UPDATE shop_state SET budget_day=?,jobs_today=3,paced_until=? WHERE source='eneba'",
        )
        .bind(t / DAY)
        .bind(t + 1800)
        .execute(&pool)
        .await
        .unwrap();
        for at in [today, today + 1, today + 3600 * 5, today - 1] {
            sqlx::query("INSERT INTO job_run(source,kind,started_at,duration_ms,outcome) VALUES('eneba','product',?,1,'ok')")
                .bind(at)
                .execute(&pool)
                .await
                .unwrap();
        }
        let budget = budget_status(&pool, Shop::Eneba, t).await.unwrap();
        let expected = default_budget();
        assert_eq!(budget["used"], 3);
        assert_eq!(budget["limit"], expected.0);
        assert_eq!(budget["limit_source"], expected.1);
        assert_eq!(budget["pace_seconds"], pace_gap(t, expected.0 - 3));
        assert_eq!(
            budget["next_at"],
            t + 1800,
            "the product is due but waits for its slot"
        );
        let hours = budget["by_hour"].as_array().unwrap();
        assert_eq!(hours.len(), 24);
        assert_eq!(hours[0], 2);
        assert_eq!(hours[5], 1);
        assert_eq!(hours.iter().map(|h| h.as_i64().unwrap()).sum::<i64>(), 3);
        // A product (3/day at 8 h) and the daily discovery.
        assert_eq!(budget["demand_per_day"], 4);
        sqlx::query("DELETE FROM shop_job")
            .execute(&pool)
            .await
            .unwrap();
        assert!(budget_status(&pool, Shop::Eneba, t).await.unwrap()["next_at"].is_null());
    }

    #[test]
    fn price_trend_moves_slowly_and_maps_to_half_or_double_interval() {
        assert_eq!(price_position(1000, &[1000]), None);
        assert_eq!(price_position(1000, &[1000, 1000]), None);
        assert_eq!(price_position(1000, &[3000, 1000, 2000]), Some(0.0));
        assert_eq!(price_position(2000, &[3000, 1000, 2000]), Some(0.5));
        assert_eq!(price_position(3000, &[3000, 1000, 2000]), Some(1.0));
        // One cheap measurement moves the neutral trend a fifth of the way; without a comparison it stays.
        assert!((next_trend(0.5, Some(0.0)) - 0.4).abs() < 1e-9);
        assert_eq!(next_trend(0.3, None), 0.3);
        let mut score = 0.5;
        for _ in 0..20 {
            score = next_trend(score, Some(0.0));
        }
        assert!(score < 0.01, "{score}");
        assert!((trend_pace(0.0) - 0.5).abs() < 1e-9);
        assert!((trend_pace(0.5) - 1.0).abs() < 1e-9);
        assert!((trend_pace(1.0) - 2.0).abs() < 1e-9);
        // 8 h for every region alike: the steadily cheapest every 4 h, the most expensive every 16 h, a preview twice as
        // long; never beyond a week, never below 15 minutes.
        assert_eq!(effective_interval(8 * 3600, false, 0.5), 4 * 3600);
        assert_eq!(effective_interval(8 * 3600, false, 1.0), 8 * 3600);
        assert_eq!(effective_interval(8 * 3600, false, 2.0), 16 * 3600);
        assert_eq!(effective_interval(8 * 3600, true, 1.0), 16 * 3600);
        assert_eq!(effective_interval(WEEK, true, 2.0), WEEK);
        assert_eq!(effective_interval(900, false, 0.5), 900);
    }

    #[tokio::test]
    async fn cheap_regions_are_checked_more_often_expensive_and_sold_out_ones_less() {
        let pool = memory().await;
        sqlx::query("UPDATE app_settings SET target_country='DE'")
            .execute(&pool)
            .await
            .unwrap();
        const T0: i64 = 1_800_000_000 - 1_800_000_000 % DAY;
        // Only the product jobs of this wish (no discovery).
        sqlx::query("DELETE FROM shop_job WHERE link_id IS NULL")
            .execute(&pool)
            .await
            .unwrap();
        add_item(&pool, "w", "wished").await;
        // Regions that cannot count in DE at 1 €, 2 € and 3 €, one sold out, and a product valid in DE at 2.50 €:
        // all compared alike.
        let mut links = vec![];
        for n in 0..5 {
            links.push(add_link(&pool, "w", n, T0 + 100 * DAY).await);
        }
        let product = |n: usize| {
            let mut product = priced(n == 4);
            product.offers[0].cents = [100, 200, 300, 150, 250][n];
            if n == 3 {
                product.offers.clear();
                product.availability = Availability::SoldOut;
            }
            product
        };
        let mut t = T0;
        for _ in 0..12 {
            for (n, link) in links.iter().enumerate() {
                sqlx::query("UPDATE shop_job SET due=? WHERE link_id=?")
                    .bind(t)
                    .bind(link)
                    .execute(&pool)
                    .await
                    .unwrap();
                unpace(&pool).await;
                let job = claim(&pool, Shop::Eneba, "aa", t, 1_000_000)
                    .await
                    .unwrap()
                    .unwrap();
                assert_eq!(job.link_id, Some(*link));
                let work = Work::Product(Box::new(product(n)));
                complete(&pool, Shop::Eneba, &job, "aa", Ok(work), t, t, 1)
                    .await
                    .unwrap();
            }
            t += 3600;
        }
        let rows: Vec<(f64, f64, i64)> = sqlx::query_as(
            "SELECT l.cheap_score,j.pace,j.due-j.checked_at FROM offer_link l JOIN shop_job j ON j.link_id=l.id ORDER BY l.id",
        )
        .fetch_all(&pool)
        .await
        .unwrap();
        let interval = 8 * 3600;
        // Steadily the cheapest region: trend near 0, checked almost twice as often.
        assert!(rows[0].0 < 0.1 && rows[0].1 < 0.6, "{:?}", rows[0]);
        assert!(rows[0].2 < interval * 6 / 10, "{:?}", rows[0]);
        // 2 € between 1 € and 3 € (position 0.5): the plain interval.
        assert!((rows[1].1 - 1.0).abs() < 0.1, "{:?}", rows[1]);
        // Steadily the most expensive region: about half as often.
        assert!(rows[2].0 > 0.9 && rows[2].1 > 1.8, "{:?}", rows[2]);
        assert!(rows[2].2 > interval * 18 / 10, "{:?}", rows[2]);
        // Sold out: half as often until it is in stock again; its trend stays where it was.
        assert_eq!(
            (rows[3].0, rows[3].1, rows[3].2),
            (0.5, SOLD_OUT_PACE, 2 * interval)
        );
        // The product valid in DE is not preferred: 2.50 € (position 0.75) is checked less often than the plain interval.
        assert!(
            rows[4].0 > 0.65 && rows[4].1 > 1.3 && rows[4].1 < 1.5,
            "{:?}",
            rows[4]
        );
        // The demand estimate uses the same paces.
        let expected = rows
            .iter()
            .map(|row| DAY as f64 / row.2 as f64)
            .sum::<f64>();
        let estimate = demand(&pool, Shop::Eneba, t).await.unwrap();
        assert!(
            (estimate - expected).abs() < 0.01,
            "estimate {estimate}, expected {expected}"
        );
    }

    #[tokio::test]
    async fn a_pause_stops_automatic_checks_but_not_requested_refreshes() {
        let pool = memory().await;
        const T0: i64 = 1_800_000_000 - 1_800_000_000 % DAY;
        add_item(&pool, "w", "wished").await;
        let link = add_link(&pool, "w", 0, T0).await;
        sqlx::query("UPDATE shop_job SET initial=0 WHERE link_id=?")
            .bind(link)
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("UPDATE offer_link SET observed_at=? WHERE id=?")
            .bind(T0 - DAY)
            .bind(link)
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("UPDATE app_settings SET fetch_paused_at=?")
            .bind(T0)
            .execute(&pool)
            .await
            .unwrap();
        unpace(&pool).await;
        // Paused: neither the due product nor the discovery runs, and the status shows no next run.
        assert!(
            claim(&pool, Shop::Eneba, "aa", T0, 1000)
                .await
                .unwrap()
                .is_none()
        );
        assert!(budget_status(&pool, Shop::Eneba, T0).await.unwrap()["next_at"].is_null());
        // A refresh the owner asks for still runs.
        sqlx::query("UPDATE shop_job SET requested_at=? WHERE link_id=?")
            .bind(T0)
            .bind(link)
            .execute(&pool)
            .await
            .unwrap();
        let job = claim(&pool, Shop::Eneba, "aa", T0, 1000)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(job.link_id, Some(link));
        complete(
            &pool,
            Shop::Eneba,
            &job,
            "aa",
            Err(ShopError::Network),
            T0,
            T0,
            1,
        )
        .await
        .unwrap();
        // Resumed: the automatic checks run again.
        sqlx::query("UPDATE app_settings SET fetch_paused_at=NULL")
            .execute(&pool)
            .await
            .unwrap();
        unpace(&pool).await;
        assert!(
            claim(&pool, Shop::Eneba, "aa", T0 + DAY, 1000)
                .await
                .unwrap()
                .is_some()
        );
    }

    #[tokio::test]
    async fn demand_estimate_matches_an_unlimited_simulation() {
        use crate::shops::eneba::SearchPage;
        let pool = memory().await;
        sqlx::query("UPDATE app_settings SET target_country='DE'")
            .execute(&pool)
            .await
            .unwrap();
        const T0: i64 = 1_800_000_000 - 1_800_000_000 % DAY;
        let mut valid = std::collections::HashMap::new();
        // Active wishes with valid and other regions, watched previews, an unviewed preview,
        // an owned item and a rejected link; the last three stay idle.
        for w in 0..4 {
            let wish = format!("w{w}");
            add_item(&pool, &wish, "wished").await;
            schedule_wish(&pool, &wish).await.unwrap();
            for n in 0..5 {
                valid.insert(add_link(&pool, &wish, n, T0).await, n < 2);
            }
            let preview = format!("p{w}");
            add_item(&pool, &preview, "preview").await;
            sqlx::query("INSERT INTO edition_watch VALUES(?,?)")
                .bind(&wish)
                .bind(&preview)
                .execute(&pool)
                .await
                .unwrap();
            schedule_wish(&pool, &preview).await.unwrap();
            for n in 0..3 {
                valid.insert(add_link(&pool, &preview, n, T0).await, n < 1);
            }
        }
        add_item(&pool, "unviewed", "preview").await;
        sqlx::query("UPDATE wishlist_item SET viewed_at=? WHERE id='unviewed'")
            .bind(T0 - 30 * DAY)
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO edition_watch VALUES('w0','unviewed')")
            .execute(&pool)
            .await
            .unwrap();
        add_item(&pool, "owned", "owned").await;
        for item in ["unviewed", "owned"] {
            schedule_wish(&pool, item).await.unwrap();
            valid.insert(add_link(&pool, item, 0, T0).await, true);
        }
        let rejected = add_link(&pool, "w0", 9, T0).await;
        valid.insert(rejected, true);
        sqlx::query("UPDATE offer_link SET review='rejected' WHERE id=?")
            .bind(rejected)
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("UPDATE shop_job SET due=? WHERE wish_id IS NOT NULL OR link_id IS NULL")
            .bind(T0)
            .execute(&pool)
            .await
            .unwrap();

        // Unlimited budget, no pacing: every job runs exactly when it is due.
        let mut estimate = None;
        let mut t = T0;
        while t < T0 + 15 * DAY {
            if t == T0 + DAY {
                // Relevance is learned after the first run of every product.
                estimate = Some(demand(&pool, Shop::Eneba, t).await.unwrap());
            }
            loop {
                unpace(&pool).await;
                let Some(job) = claim(&pool, Shop::Eneba, "aa", t, 1_000_000).await.unwrap() else {
                    break;
                };
                let result = match (job.link_id, &job.wish_id) {
                    (Some(id), _) => Work::Product(Box::new(priced(valid[&id]))),
                    (None, Some(_)) => Work::Search(SearchPage {
                        urls: vec![],
                        next_page: None,
                    }),
                    (None, None) => Work::Discovery(vec![], None),
                };
                complete(&pool, Shop::Eneba, &job, "aa", Ok(result), t, t, 1)
                    .await
                    .unwrap();
            }
            t += 300;
        }
        let runs: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM job_run WHERE started_at>=?")
            .bind(T0 + DAY)
            .fetch_one(&pool)
            .await
            .unwrap();
        let simulated = runs as f64 / 14.0;
        let estimate = estimate.unwrap();
        // Every region alike (equal prices, no trend): 20 wish links ×3, 12 preview links ×1.5,
        // 8 weekly searches and the daily discovery.
        assert!(
            (estimate - (60.0 + 18.0 + 8.0 / 7.0 + 1.0)).abs() < 1e-9,
            "{estimate}"
        );
        assert!(
            (simulated - estimate).abs() <= estimate * 0.03,
            "estimate {estimate:.1}/day, simulation {simulated:.1}/day"
        );
    }
}
