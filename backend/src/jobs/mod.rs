//! Persistent, budgeted and paced shop jobs.
//!
//! Each shop has one worker. A job is claimed with a lease, executed (network) and
//! completed in one short transaction. Claim order and pacing:
//!
//! | class | jobs | paced |
//! |---|---|---|
//! | 0 | refresh requested by the user, first search of a wish added by hand (not of a preview or an import) | no |
//! | 1 | price of an active wish that is in stock (any region; the target country is not preferred), search continuation pages | yes, unless a direct user action (below) |
//! | 2 | repeated search of an active wish, first search of an imported wish | yes, unless a direct user action |
//! | 3 | price of an active wish that is sold out or has no price | yes, unless a direct user action |
//! | 4 | edition previews | yes (a requested refresh is class 0) |
//! | 5 | shop-wide discovery | yes |
//!
//! Every fourth job of a day goes to the most overdue job of classes 2 to 5, so lower
//! classes keep a share of the budget even when class 1 alone could use it up. Product intervals adapt to
//! the price trend of each product within its wish (0.6.5, [`trend::price_trend`]): the steadily cheapest region is
//! checked twice as often, the steadily most expensive one and sold-out products half as often, previews half
//! as often. Every region is treated alike; the target country only decides which price counts, not how often.
//!
//! **Budget.** A shop runs at most [`budget::daily_limit`] jobs per UTC day: `source_settings.daily_jobs`
//! (Settings → Key-Shops), else `KEYHUNTER_SHOP_DAILY_JOBS`, else 500. Every job counts, paced or not.
//! Workers read the value on every claim, so a change applies without restart.
//!
//! **Pacing.** After a paced job the shop may start its next paced job [`budget::pace_gap`] later: the rest
//! of the UTC day divided by the remaining budget, clamped to 20 s … 1 h. The time is stored in
//! `shop_state.paced_until`, so a restart does not burst. Retry ladder, source pauses, robots and the
//! per-host gap of the shop clients apply in addition.
//!
//! **Direct user actions** ([`bypass`]) skip pacing (never the budget). A job is one when its item is
//! a wish (not a preview, owned or deleted item; class 0 excepted) and
//! - it is class 0 (requested refresh of any item, first search of a wish added by hand), or
//! - it is a search with `initial=1`: every page and retry of the first search of a wish added by hand or
//!   of a search run started by a requested refresh, until its last page is stored, or
//! - it is a product with `initial=1` whose link has no observation yet: the first price fetch of a
//!   link created by a user action (saving, restoring or refreshing a wish, adding a link by hand)
//!   or found by a search run that itself bypassed pacing. The flag clears after that first run.
//!
//! Links attached at start-up or after a shop-wide discovery are never direct user actions, and neither is an
//! import (`POST /api/v1/wishlist/import`, P2): its wishes are queued with `initial=0`, so their first searches
//! (class 2) and the links they find wait for their turn, and restoring hundreds of wishes cannot spend a day's
//! budget at once. "Jetzt prüfen" on an imported wish is a requested refresh like any other.
//!
//! Parts: the worker, the claim and the shared SQL rules here; [`complete`] stores a finished job, [`trend`] holds the
//! price trend and the interval, [`budget`] the daily budget, the pacing and the demand, [`attach`] links found
//! products and queues searches, [`api`] answers the status page.

pub(crate) mod api;
pub(crate) mod attach;
pub(crate) mod budget;
mod complete;
#[cfg(test)]
mod tests;
pub(crate) mod trend;

use crate::{
    DAY,
    eventlog::{self, Area, Level},
    now, offers, random_token,
    shops::{Availability, Product, SearchPage, Shop, ShopError},
};
use attach::{attach, attach_failed};
use budget::{daily_budget, pace_gap};
use complete::complete;
// Composed queries only join the constant SQL fragments below; values are always bound.
use sqlx::{AssertSqlSafe, FromRow, SqlitePool};
use std::{
    sync::{
        Arc,
        atomic::{AtomicI64, Ordering},
    },
    time::{Duration, Instant},
};

const WEEK: i64 = 7 * DAY;
/// Delays after the first, second and third consecutive transient failure.
const RETRY_LADDER: [i64; 3] = [120, 600, 3600];
/// A product link that is "not found" or unreadable this many times in a row counts as dead (FUNC-13) ...
const DEAD_AFTER: i64 = 5;
/// ... and waits this many intervals between checks until a fetch succeeds again.
const DEAD_BACKOFF: i64 = 4;
/// A search walks at most this many result pages per run.
const MAX_SEARCH_PAGES: i64 = 5;
/// A requested refresh keeps top priority this long.
pub(crate) const REQUEST_WINDOW: i64 = 900;
/// An edition preview is fetched while it was viewed within this time.
const PREVIEW_VIEWED_WITHIN: i64 = 14 * DAY;
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

/// Last loop time of each shop worker, for readiness and the status page; one slot per shop (`shop as usize`).
#[derive(Default)]
pub(crate) struct Heartbeat([AtomicI64; Shop::ALL.len()]);

impl Heartbeat {
    pub(crate) fn beat(&self, shop: Shop, t: i64) {
        self.0[shop as usize].store(t, Ordering::Relaxed);
    }
    pub(crate) fn last(&self, shop: Shop) -> i64 {
        self.0[shop as usize].load(Ordering::Relaxed)
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
                attach_failed(&pool, shop, &error).await;
            }
            loop {
                heartbeat.beat(shop, now());
                match run_one(&pool, shop, budget).await {
                    Ok(true) => tokio::time::sleep(Duration::from_secs(2)).await,
                    Ok(false) => tokio::time::sleep(Duration::from_secs(3)).await,
                    Err(error) => {
                        tracing::error!(source = shop.id(), error = %error, "Shop job database operation failed");
                        eventlog::record_once(
                            &pool,
                            Level::Error,
                            Area::Fetch,
                            format!(
                                "{}: Datenbankfehler im Abrufdienst, der Abruf wird wiederholt",
                                shop.name()
                            ),
                            eventlog::REPEAT,
                        )
                        .await;
                        tokio::time::sleep(Duration::from_secs(10)).await;
                    }
                }
            }
        });
    }
}

// Shared SQL of the scheduler. `j` is shop_job, `s` its source_settings, `p` its shop_state, `l` the joined
// offer_link and `t` the item the job belongs to (NULL for discovery). Placeholders: `?2` now, `?3` UTC day,
// `?4` default budget, `?5` now - REQUEST_WINDOW; `?1` is the caller's (shop, item or item ids).
const ITEM: &str = "LEFT JOIN wishlist_item t ON t.id=COALESCE(j.wish_id,l.wish_id)";
/// Jobs with everything the conditions below refer to.
pub(crate) const JOBS: &str = "shop_job j JOIN source_settings s ON s.id=j.source JOIN shop_state p ON p.source=j.source
    LEFT JOIN offer_link l ON l.id=j.link_id LEFT JOIN wishlist_item t ON t.id=COALESCE(j.wish_id,l.wish_id)";
/// Time the owner paused the automatic checks (0.7.0), NULL while they run.
const PAUSED_AT: &str = "(SELECT fetch_paused_at FROM app_settings WHERE id=1)";
const NOT_OWNED: &str = "COALESCE(t.state,'wished')!='owned'";
/// A preview is fetched while an active wish that is not paused (0.9.0) watches it and it was viewed in the last 14 days.
fn watched_if_preview() -> String {
    format!(
        "(COALESCE(t.state,'wished')!='preview' OR (COALESCE(t.viewed_at,0)>?2-{PREVIEW_VIEWED_WITHIN} AND EXISTS(SELECT 1 FROM edition_watch ew JOIN wishlist_item aw ON aw.id=ew.wish_id WHERE ew.track_id=t.id AND aw.state='wished' AND (aw.paused_at IS NULL OR (aw.paused_until IS NOT NULL AND aw.paused_until<=?2)))))"
    )
}
/// Uncorrelated scalar subquery, so SQLite evaluates it once per statement. As `EXISTS(…)` SQLite 3.51 turned it
/// into a join with every job row, quadratic in the size of the wishlist (PERF-01).
const ANY_ACTIVE_WISH: &str =
    "(SELECT 1 FROM wishlist_item any_wish WHERE any_wish.state='wished' LIMIT 1) IS NOT NULL";
/// A wish paused on its own (0.9.0) waits until its pause ends; a check the owner requested still runs.
/// Independent of the global pause: resuming that leaves these wishes paused.
fn not_held() -> String {
    format!(
        "(t.paused_at IS NULL OR (t.paused_until IS NOT NULL AND t.paused_until<=?2) OR j.requested_at>?2-{REQUEST_WINDOW})"
    )
}
/// The shop can start a job now: no retry pause, budget left today.
const SHOP_READY: &str =
    "p.retry_at<=?2 AND (p.budget_day!=?3 OR p.jobs_today<COALESCE(s.daily_jobs,?4))";

/// Jobs the scheduler runs at all (whenever they are due); idle jobs stay out.
fn queued() -> String {
    format!(
        "(j.link_id IS NULL OR l.review!='rejected') AND {NOT_OWNED} AND {} AND {ANY_ACTIVE_WISH} AND {}",
        watched_if_preview(),
        not_held()
    )
}

/// The one rule for "this job really waits for its shop's worker" (CODE-01): due, not running, its shop switched
/// on, not held by the global pause (direct user actions excepted) and [`queued`]. The worker additionally needs
/// [`SHOP_READY`] and its pace ([`claimable`]); the pages show [`pending`]. Needs [`JOBS`].
fn waiting() -> String {
    format!(
        "j.due<=?2 AND j.lease_until<=?2 AND s.enabled AND s.configured AND ({PAUSED_AT} IS NULL OR {}) AND {}",
        bypass("?5"),
        queued()
    )
}

/// What the pages call pending ("Wird gesucht …", "Suche eingeplant"): the job runs, or it waits and its shop could
/// start it now. Pacing does not count, a paced job only waits for its turn. Needs [`JOBS`], 0 or NULL otherwise.
pub(crate) fn pending() -> String {
    format!("(j.lease_until>?2 OR ({} AND {SHOP_READY}))", waiting())
}

/// The job serves a fetch the owner triggered (a requested check, the first search of a new wish, the first price
/// of a link from a user action; [`bypass`]). Pending, only these make the pages poll quickly (PERF-02).
pub(crate) fn direct_action() -> String {
    bypass("?5")
}

/// Claim class (module table); `window` is the placeholder of `now - REQUEST_WINDOW`.
fn class(window: &str) -> String {
    format!(
        "CASE
    WHEN j.requested_at>{window} THEN 0
    WHEN t.state='preview' THEN 4
    WHEN j.wish_id IS NOT NULL AND j.checked_at IS NULL AND j.initial=1 THEN 0
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
        "FROM {JOBS} WHERE j.source=?1 AND {} AND {SHOP_READY} AND (p.paced_until<=?2 OR {})",
        waiting(),
        bypass("?5")
    )
}

#[derive(FromRow)]
struct Job {
    id: i64,
    link_id: Option<i64>,
    failures: i64,
    /// Consecutive dead results of a product link ([`complete::dead_link`]).
    dead_failures: i64,
    wish_id: Option<String>,
    search_page: i64,
    /// The job serves a direct user action and skipped pacing.
    #[sqlx(skip)]
    bypass: bool,
}

/// Leases the next job of `?1` (placeholders of [`claimable`], `?6` lease end, `?7` token). Every fourth job of the
/// day goes to the most overdue job of classes 2..5.
fn claim_sql() -> String {
    format!(
        "UPDATE shop_job SET lease_until=?6,lease_token=?7 WHERE id=(SELECT id FROM (
            SELECT j.id AS id, j.due AS due, {} AS class {}
            AND NOT EXISTS(SELECT 1 FROM shop_job running WHERE running.source=j.source AND running.lease_until>?2)
        ) ORDER BY CASE
            WHEN class=0 THEN 0
            WHEN (SELECT CASE WHEN q.budget_day=?3 THEN q.jobs_today ELSE 0 END FROM shop_state q WHERE q.source=?1)%4=3
                THEN CASE WHEN class>=2 THEN 1 ELSE 2 END
            ELSE class END, due, id LIMIT 1)
        RETURNING id,link_id,failures,dead_failures,wish_id,search_page",
        class("?5"),
        claimable()
    )
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
    let sql = claim_sql();
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

enum Work {
    Product(Box<Product>),
    /// Candidates and the wait until the next discovery run (None: [`Kind::repeat_after`]).
    Discovery(Vec<(String, String)>, Option<i64>),
    Search(SearchPage),
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

/// 1 = in stock with a price, 2 = sold out or without a price (claim class 3, see the module table).
fn relevance(product: &Product) -> i64 {
    if product.availability == Availability::InStock && crate::pricing::min_cents(product).is_some()
    {
        1
    } else {
        2
    }
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
                shop.search_page(&keys, &known, job.search_page)
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
