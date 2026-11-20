//! Persistent, budgeted shop jobs.
//!
//! Each shop has one worker. A job is claimed with a lease, executed (network) and
//! completed in one short transaction. Claim order:
//!
//! | class | jobs |
//! |---|---|
//! | 0 | refresh requested by the user, first search of a new wish (not of a preview) |
//! | 1 | price of an active wish that is (or may be) valid in the target country, search continuation pages |
//! | 2 | repeated search of an active wish |
//! | 3 | price of an active wish outside the target country, sold out or unknown |
//! | 4 | edition previews |
//! | 5 | shop-wide discovery |
//!
//! Every fourth job of a day goes to the most overdue job of classes 2 to 5, so lower
//! classes keep a share of the budget even when class 1 alone could use it up. Product intervals adapt to
//! relevance: irrelevant variants and previews are fetched less often.

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

pub(crate) fn daily_budget() -> i64 {
    std::env::var("KEYHUNTER_SHOP_DAILY_JOBS")
        .ok()
        .and_then(|v| v.parse::<i64>().ok())
        .filter(|v| (1..=1000).contains(v))
        .unwrap_or(120)
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
const NOT_OWNED: &str = "COALESCE(t.state,'wished')!='owned'";
/// A preview is fetched while an active wish watches it and it was viewed in the last 14 days.
const WATCHED_IF_PREVIEW: &str = "(COALESCE(t.state,'wished')!='preview' OR (COALESCE(t.viewed_at,0)>?2-1209600 AND EXISTS(SELECT 1 FROM edition_watch ew JOIN wishlist_item aw ON aw.id=ew.wish_id WHERE ew.track_id=t.id AND aw.state='wished')))";
const ANY_ACTIVE_WISH: &str = "EXISTS(SELECT 1 FROM wishlist_item w WHERE w.state='wished')";
const CLASS: &str = "CASE
    WHEN j.requested_at>?5 THEN 0
    WHEN t.state='preview' THEN 4
    WHEN j.wish_id IS NOT NULL AND j.checked_at IS NULL THEN 0
    WHEN j.link_id IS NULL AND j.wish_id IS NULL THEN 5
    WHEN j.link_id IS NOT NULL THEN CASE WHEN j.relevance=1 THEN 1 ELSE 3 END
    WHEN j.search_page>1 THEN 1
    ELSE 2 END";

fn claimable() -> String {
    format!(
        "FROM shop_job j JOIN source_settings s ON s.id=j.source JOIN shop_state p ON p.source=j.source
        LEFT JOIN offer_link l ON l.id=j.link_id {ITEM}
        WHERE j.source=?1 AND s.enabled AND s.configured AND p.retry_at<=?2 AND (p.budget_day!=?3 OR p.jobs_today<?4)
        AND j.due<=?2 AND j.lease_until<=?2 AND (j.link_id IS NULL OR l.review!='rejected')
        AND {NOT_OWNED} AND {WATCHED_IF_PREVIEW} AND {ANY_ACTIVE_WISH}"
    )
}

#[derive(FromRow)]
pub(crate) struct Job {
    id: i64,
    link_id: Option<i64>,
    failures: i64,
    wish_id: Option<String>,
    search_page: i64,
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
    .fetch_one(pool)
    .await?;
    if !pending {
        return Ok(None);
    }

    let mut tx = pool.begin().await?;
    // Every fourth job of the day goes to the most overdue job of classes 2..5.
    let sql = format!(
        "UPDATE shop_job SET lease_until=?6,lease_token=?7 WHERE id=(SELECT id FROM (
            SELECT j.id AS id, j.due AS due, {CLASS} AS class {}
            AND NOT EXISTS(SELECT 1 FROM shop_job running WHERE running.source=j.source AND running.lease_until>?2)
        ) ORDER BY CASE
            WHEN class=0 THEN 0
            WHEN (SELECT CASE WHEN q.budget_day=?3 THEN q.jobs_today ELSE 0 END FROM shop_state q WHERE q.source=?1)%4=3
                THEN CASE WHEN class>=2 THEN 1 ELSE 2 END
            ELSE class END, due, id LIMIT 1)
        RETURNING id,link_id,failures,wish_id,search_page",
        claimable()
    );
    let claimed = sqlx::query_as(AssertSqlSafe(sql))
        .bind(shop.id())
        .bind(t)
        .bind(day)
        .bind(budget)
        .bind(t - REQUEST_WINDOW)
        .bind(t + 180)
        .bind(token)
        .fetch_optional(&mut *tx)
        .await?;
    if claimed.is_some() {
        sqlx::query("UPDATE shop_state SET jobs_today=CASE WHEN budget_day=? THEN jobs_today+1 ELSE 1 END, budget_day=? WHERE source=?")
            .bind(day).bind(day).bind(shop.id()).execute(&mut *tx).await?;
    }
    tx.commit().await?;
    Ok(claimed)
}

pub(crate) enum Work {
    Product(Box<Product>),
    Discovery(Vec<(String, String)>),
    Search(crate::shops::eneba::SearchPage),
}

fn next_schedule(
    result: &Result<Work, ShopError>,
    previous_failures: i64,
    t: i64,
    interval: i64,
    jitter: i64,
) -> (i64, i64) {
    match result {
        Ok(Work::Product(_)) => (t + interval, 0),
        Ok(Work::Search(page)) if page.next_page.is_some() => (t, 0),
        Ok(Work::Search(_)) => (t + WEEK.max(interval), 0),
        Ok(Work::Discovery(_)) => (t + DAY.max(interval), 0),
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

/// 1 = counts (or may count) for the target country, 2 = cannot count there.
fn relevance(product: &Product, target: &str) -> i64 {
    let valid = target.is_empty()
        || (product.availability == Availability::InStock
            && product.activation(target) == "confirmed"
            && product.purchase_country.as_deref() == Some(target));
    if valid { 1 } else { 2 }
}

fn effective_interval(interval: i64, relevant: bool, preview: bool) -> i64 {
    let factor = (if relevant { 1 } else { 3 }) * (if preview { 2 } else { 1 });
    (interval * factor).min(WEEK)
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
        shop.discover(shard as usize).await.map(Work::Discovery)
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
    let (interval, target): (i64, Option<String>) = sqlx::query_as(
        "SELECT s.poll_interval_seconds,a.target_country FROM source_settings s,app_settings a WHERE s.id=? AND a.id=1",
    )
    .bind(shop.id())
    .fetch_one(pool)
    .await?;
    let target = target.unwrap_or_default();
    let preview: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM wishlist_item WHERE state='preview' AND id=COALESCE(?,(SELECT wish_id FROM offer_link WHERE id=?)))")
        .bind(&job.wish_id).bind(job.link_id).fetch_one(pool).await?;
    let relevance = match &result {
        Ok(Work::Product(product)) => Some(relevance(product, &target)),
        _ => None,
    };
    let interval = effective_interval(interval, relevance != Some(2), preview);
    let jitter = i64::from(u8::from_str_radix(&token[..2], 16).unwrap_or(0) % 31);
    let (due, failures) = next_schedule(&result, job.failures, t, interval, jitter);
    let mut tx = pool.begin().await?;
    let count = sqlx::query(
        "UPDATE shop_job SET due=?,failures=?,lease_until=0,lease_token=NULL,requested_at=0
        WHERE id=? AND lease_token=? AND lease_until>?",
    )
    .bind(due)
    .bind(failures)
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
        "UPDATE shop_job SET checked_at=?,last_error=?,relevance=COALESCE(?,relevance) WHERE id=?",
    )
    .bind(t)
    .bind(result.as_ref().err().map(ShopError::code))
    .bind(relevance)
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
            let found = enqueue_candidates(&mut tx, shop, id, &page.urls, t).await?;
            sqlx::query("UPDATE shop_job SET result_count=CASE WHEN search_page=1 THEN ? ELSE COALESCE(result_count,0)+? END, search_page=? WHERE id=?")
                .bind(found).bind(found).bind(page.next_page.unwrap_or(1)).bind(job.id)
                .execute(&mut *tx).await?;
            set_success(&mut tx, shop, t, false).await?;
            Some(format!("Seite {}: {found} Produkte", job.search_page))
        }
        Ok(Work::Discovery(candidates)) => {
            for (url, key) in candidates {
                sqlx::query("INSERT OR IGNORE INTO shop_candidate(source,url,title_key)
                    SELECT ?,?,? WHERE (SELECT count(*) FROM shop_candidate WHERE source=?) < 12000")
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
    let kind = if job.link_id.is_some() {
        "product"
    } else if job.wish_id.is_some() {
        "search"
    } else {
        "discovery"
    };
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
async fn enqueue_candidates(
    conn: &mut sqlx::SqliteConnection,
    shop: Shop,
    id: &str,
    urls: &[String],
    t: i64,
) -> sqlx::Result<i64> {
    let mut found = 0;
    for raw in urls {
        let Some(url) = shop.product_url(raw) else {
            continue;
        };
        let link: Option<i64> = sqlx::query_scalar(
            "INSERT INTO offer_link(wish_id,source,url,auto_discovered)
            VALUES(?,?,?,1) ON CONFLICT(wish_id,source,url) DO UPDATE SET url=excluded.url
            WHERE review!='rejected' RETURNING id",
        )
        .bind(id)
        .bind(shop.id())
        .bind(url.as_str())
        .fetch_optional(&mut *conn)
        .await?;
        if let Some(link) = link {
            sqlx::query("INSERT OR IGNORE INTO shop_job(source,link_id,due) VALUES(?,?,?)")
                .bind(shop.id())
                .bind(link)
                .bind(t)
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
        sqlx::query("UPDATE offer_link SET review='confirmed',fingerprint=? WHERE id=? AND review='pending'")
            .bind(product.fingerprint()).bind(link).execute(conn).await?;
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
        attach_wish(pool, shop, &id).await?;
    }
    Ok(())
}

/// Attach indexed candidates to one item (when it is saved, restored or previewed).
async fn attach_wish(pool: &SqlitePool, shop: Shop, id: &str) -> anyhow::Result<()> {
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
    let keys = wish.keys();
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
    enqueue_candidates(&mut tx, shop, id, &urls, now()).await?;
    tx.commit().await?;
    Ok(())
}

pub(crate) async fn schedule_wish(pool: &SqlitePool, id: &str) -> sqlx::Result<()> {
    sqlx::query("INSERT OR IGNORE INTO shop_job(source,wish_id,due) SELECT 'eneba',id,? FROM wishlist_item w WHERE id=? AND w.state!='owned'")
        .bind(now()).bind(id).execute(pool).await?;
    for shop in Shop::ALL {
        if let Err(error) = attach_wish(pool, shop, id).await {
            tracing::warn!(source = shop.id(), %error, "Candidate attachment failed");
        }
    }
    Ok(())
}

/// GET /api/v1/status/fetch: queue, budget, pauses and recent runs per shop.
pub(crate) async fn status(
    State(state): State<Shared>,
    headers: HeaderMap,
) -> ApiResult<Json<Value>> {
    auth::authenticate(&state, &headers).await?;
    let t = now();
    let budget = daily_budget();
    type ShopRow = (String, bool, Option<i64>, Option<String>, i64, i64);
    let rows: Vec<ShopRow> = sqlx::query_as(
        "SELECT s.id,(s.enabled AND s.configured),p.last_success,p.last_error,p.retry_at,
        CASE WHEN p.budget_day=? THEN p.jobs_today ELSE 0 END
        FROM shop_state p JOIN source_settings s ON s.id=p.source WHERE s.configured=1 ORDER BY s.id",
    )
    .bind(t / DAY)
    .fetch_all(&state.pool)
    .await?;
    let mut shops = Vec::new();
    for (source, enabled, last_success, last_error, retry_at, used) in rows {
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
            "budget": {"used": used, "limit": budget},
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
    Ok(Json(json!({
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
                next_schedule(&Ok(Work::Discovery(vec![])), 0, 100, interval, 0),
                (100 + DAY.max(interval), 0)
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
        sqlx::query("UPDATE source_settings SET configured=1 WHERE id='driffle'")
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
        assert!(
            claim(&pool, Shop::Eneba, "resumed", t + 600, 3)
                .await
                .unwrap()
                .is_some()
        );
    }

    #[tokio::test]
    async fn budget_keeps_valid_regions_of_active_wishes_fresh() {
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
            if let Some(job) = claim(&pool, Shop::Eneba, "aa", t, BUDGET).await.unwrap() {
                if job.wish_id.as_deref() == Some("late") && late_search.is_none() {
                    late_search = Some(t);
                }
                let result = match (job.link_id, &job.wish_id) {
                    (Some(id), _) => Ok(Work::Product(Box::new(product(relevant[&id])))),
                    (None, Some(_)) => Ok(Work::Search(SearchPage {
                        urls: vec![],
                        next_page: None,
                    })),
                    (None, None) => Ok(Work::Discovery(vec![])),
                };
                complete(&pool, Shop::Eneba, &job, "aa", result, t + 5, t, 5000)
                    .await
                    .unwrap();
            }
            t += 1800;
            if t % DAY == 0 && t >= T0 + 5 * DAY {
                assert_eq!(
                    stale_count(&active_valid, t - DAY).await,
                    0,
                    "every DE-valid variant of an active wish is at most a day old on day {}",
                    (t - T0) / DAY
                );
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
    }
}
