//! The fetch status page: queue, budget, pauses, history and the jobs that come next.

use super::{
    ITEM, JOBS, Kind, PAUSED_AT, REQUEST_WINDOW,
    budget::{daily_budget, daily_limit, default_budget, demand, pace_gap},
    bypass, class, fourth_turn, queued, waiting,
};
use crate::extract::ApiJson;
use crate::{
    ApiResult, DAY, Shared,
    eventlog::{self, Area, GAME_NAME, Level},
    now,
    shops::Shop,
};
use axum::{
    Json,
    extract::{Query, State, rejection::QueryRejection},
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::{AssertSqlSafe, FromRow, SqlitePool};

/// Budget part of the fetch status of one shop.
pub(super) async fn budget_status(pool: &SqlitePool, shop: Shop, t: i64) -> sqlx::Result<Value> {
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
    ApiJson(input): ApiJson<Value>,
) -> ApiResult<Json<Value>> {
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
    let message = if paused {
        "Automatische Abfragen pausiert"
    } else {
        "Automatische Abfragen fortgesetzt"
    };
    eventlog::record(&state.pool, Level::Info, Area::Settings, message).await;
    Ok(Json(json!({ "paused_at": paused_at })))
}

/// Due jobs of a shop that really wait ([`waiting`]): count, oldest due time, requested refreshes, products, searches.
pub(super) async fn backlog(
    pool: &SqlitePool,
    shop: Shop,
    t: i64,
) -> sqlx::Result<(i64, Option<i64>, i64, i64, i64)> {
    sqlx::query_as(AssertSqlSafe(format!(
        "SELECT COUNT(*),MIN(j.due),COALESCE(SUM(j.requested_at>?5),0),COALESCE(SUM(j.link_id IS NOT NULL),0),
        COALESCE(SUM(j.wish_id IS NOT NULL),0) FROM {JOBS} WHERE j.source=?1 AND {}",
        waiting()
    )))
    .bind(shop.id())
    .bind(t)
    .bind(t / DAY)
    .bind(daily_budget())
    .bind(t - REQUEST_WINDOW)
    .fetch_one(pool)
    .await
}

/// GET /api/v1/status/fetch: queue, budget, pauses and recent runs per shop.
pub(crate) async fn status(State(state): State<Shared>) -> ApiResult<Json<Value>> {
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
        let (due, oldest, requested, products, searches) = backlog(&state.pool, shop, t).await?;
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
            "backlog": {"due": due, "requested": requested, "products": products, "searches": searches},
            "oldest_due_at": oldest,
            "next_due_at": next_due,
            "worker_seen_at": state.heartbeat.last(shop),
        }));
    }
    let runs: Vec<Run> = sqlx::query_as(AssertSqlSafe(format!(
        "SELECT {RUN_COLUMNS} {RUNS} ORDER BY r.started_at DESC,r.id DESC LIMIT 25"
    )))
    .fetch_all(&state.pool)
    .await?;
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
        "recent_runs": runs,
        "upcoming": upcoming(&state.pool, t, paused_at.is_some()).await?,
        "upcoming_paused": paused_at.is_some(),
    })))
}

/// One fetch run with its game (`wish_id` and `link_id` as stored: a product run has only its link).
#[derive(Serialize, FromRow)]
struct Run {
    id: i64,
    source: String,
    kind: String,
    wish_id: Option<String>,
    link_id: Option<i64>,
    game: Option<String>,
    /// Region of the product of the link, when it has been fetched.
    region: Option<String>,
    started_at: i64,
    duration_ms: i64,
    outcome: String,
    detail: Option<String>,
}

const RUNS: &str = "FROM job_run r LEFT JOIN offer_link l ON l.id=r.link_id
    LEFT JOIN wishlist_item w ON w.id=COALESCE(r.wish_id,l.wish_id) LEFT JOIN game g ON g.id=w.game_id
    LEFT JOIN catalog_game c ON c.igdb_id=g.igdb_id";
/// Columns of [`Run`]; the game name is [`GAME_NAME`].
const RUN_COLUMNS: &str = "r.id,r.source,r.kind,r.wish_id,r.link_id,
    COALESCE(json_extract(c.payload,'$.name'),g.manual_title) AS game,json_extract(l.latest,'$.region') AS region,
    r.started_at,r.duration_ms,r.outcome,r.detail";
/// `?1` tone (ok, warn or error as in the frontend's outcomeTone), `?2` LIKE pattern; both optional.
const RUN_FILTER: &str = r"WHERE (?1 IS NULL OR CASE WHEN r.outcome='ok' THEN 'ok'
    WHEN r.outcome IN ('rate_limited','not_found') THEN 'warn' ELSE 'error' END=?1)
    AND (?2 IS NULL OR COALESCE(json_extract(c.payload,'$.name'),g.manual_title) LIKE ?2 ESCAPE '\'
    OR r.detail LIKE ?2 ESCAPE '\' OR r.source LIKE ?2 ESCAPE '\' OR r.outcome LIKE ?2 ESCAPE '\'
    OR r.kind LIKE ?2 ESCAPE '\')";

#[derive(Deserialize)]
pub(crate) struct RunsQuery {
    tone: Option<String>,
    q: Option<String>,
    page: Option<i64>,
    per_page: Option<i64>,
}

/// GET /api/v1/status/fetch/runs?tone=&q=&page=&per_page=: the fetch history (30 days), newest first.
pub(crate) async fn runs(
    State(state): State<Shared>,
    query: Result<Query<RunsQuery>, QueryRejection>,
) -> ApiResult<Json<Value>> {
    let Query(query) = query.map_err(|_| eventlog::BAD_FILTER)?;
    let tone = eventlog::choice(query.tone.as_deref(), &["ok", "warn", "error"])?;
    let pattern = eventlog::pattern(query.q.as_deref())?;
    let (page, per_page) = eventlog::paging(query.page, query.per_page);
    let total: i64 = sqlx::query_scalar(AssertSqlSafe(format!(
        "SELECT COUNT(*) {RUNS} {RUN_FILTER}"
    )))
    .bind(tone)
    .bind(&pattern)
    .fetch_one(&state.pool)
    .await?;
    let runs: Vec<Run> = sqlx::query_as(AssertSqlSafe(format!(
        "SELECT {RUN_COLUMNS} {RUNS} {RUN_FILTER} ORDER BY r.started_at DESC,r.id DESC LIMIT ?3 OFFSET ?4"
    )))
    .bind(tone)
    .bind(&pattern)
    .bind(per_page)
    .bind((page - 1) * per_page)
    .fetch_all(&state.pool)
    .await?;
    Ok(Json(
        json!({"runs": runs, "total": total, "page": page, "per_page": per_page}),
    ))
}

/// Length of the queue preview of the status page.
pub(super) const UPCOMING: usize = 5;
/// Jobs per shop the preview considers.
const UPCOMING_CANDIDATES: i64 = 200;

#[derive(FromRow)]
struct Queued {
    id: i64,
    source: String,
    link_id: Option<i64>,
    wish_id: Option<String>,
    search_page: i64,
    due: i64,
    requested: bool,
    class: i64,
    bypass: bool,
    game: Option<String>,
    region: Option<String>,
}

/// Candidates of [`upcoming`]: `?1` shop, `?2` now, `?3` now - REQUEST_WINDOW, `?4` paused, `?5` paced until, `?6` limit.
pub(super) fn upcoming_sql() -> String {
    format!(
            "SELECT j.id,j.source,j.link_id,j.wish_id,j.search_page,j.due,j.requested_at>?3 AS requested,
            {} AS class,{} AS bypass,{GAME_NAME} AS game,json_extract(l.latest,'$.region') AS region
            FROM shop_job j LEFT JOIN offer_link l ON l.id=j.link_id {ITEM}
            LEFT JOIN game g ON g.id=t.game_id LEFT JOIN catalog_game c ON c.igdb_id=g.igdb_id
            WHERE j.source=?1 AND j.lease_until<=?2 AND (NOT ?4 OR {}) AND {}
            ORDER BY MAX(j.due,CASE WHEN {} THEN 0 ELSE ?5 END),class,j.due,j.id LIMIT ?6",
            class("?3"),
            bypass("?3"),
            bypass("?3"),
            queued(),
            bypass("?3")
    )
}

/// The next [`UPCOMING`] jobs over all active shops, a best estimate: each shop's worker is replayed with the
/// claim rules (claimable jobs, class order with every fourth job for classes 2 to 5 in turn, retry pause, pacing
/// after each paced job and the daily budget). Running jobs are left out; while the automatic checks are
/// paused only direct user actions remain. `due_at` is the estimated start.
pub(super) async fn upcoming(pool: &SqlitePool, t: i64, paused: bool) -> sqlx::Result<Vec<Value>> {
    let mut picks = Vec::new();
    for shop in Shop::ALL {
        let state: Option<(i64, i64, i64, i64, Option<i64>)> = sqlx::query_as(
            "SELECT p.paced_until,p.retry_at,p.budget_day,p.jobs_today,s.daily_jobs
            FROM shop_state p JOIN source_settings s ON s.id=p.source WHERE p.source=? AND s.enabled AND s.configured",
        )
        .bind(shop.id())
        .fetch_optional(pool)
        .await?;
        let Some((mut paced, retry_at, budget_day, jobs_today, setting)) = state else {
            continue;
        };
        let mut pending: Vec<Queued> = sqlx::query_as(AssertSqlSafe(upcoming_sql()))
            .bind(shop.id())
            .bind(t)
            .bind(t - REQUEST_WINDOW)
            .bind(paused)
            .bind(paced)
            .bind(UPCOMING_CANDIDATES)
            .fetch_all(pool)
            .await?;
        let limit = daily_limit(setting);
        let mut day = t / DAY;
        let mut used = if budget_day == day { jobs_today } else { 0 };
        let mut clock = t.max(retry_at);
        for seq in 0..UPCOMING {
            let ready = |job: &Queued| {
                if job.bypass {
                    job.due
                } else {
                    job.due.max(paced)
                }
            };
            let Some(first) = pending.iter().map(ready).min() else {
                break;
            };
            let mut at = first.max(clock);
            if at / DAY != day {
                day = at / DAY;
                used = 0;
            }
            if used >= limit {
                day += 1;
                at = at.max(day * DAY);
                used = 0;
            }
            let turn = fourth_turn(used);
            let rank = |job: &Queued| match (job.class, turn) {
                (0, _) => (0, false),
                (class, Some(turn)) => (1 + i64::from(class < 2), class != turn),
                (class, None) => (class, false),
            };
            let Some(next) = (0..pending.len())
                .filter(|&i| ready(&pending[i]) <= at)
                .min_by_key(|&i| (rank(&pending[i]), pending[i].due, pending[i].id))
            else {
                break;
            };
            let job = pending.swap_remove(next);
            used += 1;
            if !job.bypass {
                paced = at + pace_gap(at, limit - used);
            }
            clock = at;
            picks.push((at, seq, job));
        }
    }
    picks.sort_by_key(|(at, seq, job)| (*at, *seq, job.class, job.due, job.id));
    Ok(picks
        .into_iter()
        .take(UPCOMING)
        .map(|(at, _, job)| {
            let kind = Kind::of(job.link_id, job.wish_id.as_deref());
            json!({
                "source": job.source, "kind": kind.id(), "wish_id": job.wish_id, "link_id": job.link_id,
                "game": job.game, "region": job.region,
                "search_page": (kind == Kind::Search).then_some(job.search_page),
                "due_at": at, "requested": job.requested,
            })
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::jobs::{tests::*, *};
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

    fn links_and_starts(next: &[Value]) -> Vec<(i64, i64)> {
        next.iter()
            .map(|e| {
                (
                    e["link_id"].as_i64().unwrap(),
                    e["due_at"].as_i64().unwrap(),
                )
            })
            .collect()
    }

    #[tokio::test]
    async fn upcoming_jobs_follow_the_claim_order_and_the_pace() {
        let pool = empty_queue().await;
        let t = now();
        let old = add_link(&pool, "w", 0, t - 10).await;
        let future = add_link(&pool, "w", 1, t + 3600).await;
        let requested = add_link(&pool, "w", 2, t - 5).await;
        sqlx::query("UPDATE shop_job SET requested_at=? WHERE link_id=?")
            .bind(t)
            .bind(requested)
            .execute(&pool)
            .await
            .unwrap();
        let next = upcoming(&pool, t, false).await.unwrap();
        // The requested refresh (class 0) goes before the older due job; the future job waits for its time.
        assert_eq!(
            links_and_starts(&next),
            [(requested, t), (old, t), (future, t + 3600)]
        );
        assert_eq!(next[0]["requested"], true);
        assert_eq!(next[1]["requested"], false);
        assert_eq!(next[0]["game"], "w");
        assert_eq!(next[0]["kind"], "product");
        assert_eq!(next[0]["source"], "eneba");
        assert!(next[0]["search_page"].is_null());
        // Five at most; paced jobs follow each other at the pace gap, the requested one does not count.
        for n in 3..10 {
            add_link(&pool, "w", n, t - 100).await;
        }
        let next = upcoming(&pool, t, false).await.unwrap();
        assert_eq!(next.len(), 5);
        assert_eq!(next[0]["link_id"], requested);
        let limit = daily_limit(None);
        let second = t + pace_gap(t, limit - 2);
        assert_eq!(next[1]["due_at"], t);
        assert_eq!(next[2]["due_at"], second);
        assert_eq!(next[3]["due_at"], second + pace_gap(second, limit - 3));
    }

    #[tokio::test]
    async fn upcoming_jobs_leave_out_owned_rejected_running_and_switched_off_shops() {
        let pool = empty_queue().await;
        let t = now();
        add_item(&pool, "owned", "owned").await;
        let kept = add_link(&pool, "w", 0, t - 10).await;
        add_link(&pool, "owned", 1, t - 10).await;
        let rejected = add_link(&pool, "w", 2, t - 10).await;
        sqlx::query("UPDATE offer_link SET review='rejected' WHERE id=?")
            .bind(rejected)
            .execute(&pool)
            .await
            .unwrap();
        let running = add_link(&pool, "w", 3, t - 10).await;
        sqlx::query("UPDATE shop_job SET lease_until=? WHERE link_id=?")
            .bind(t + 60)
            .bind(running)
            .execute(&pool)
            .await
            .unwrap();
        // Driffle is switched off in a fresh database.
        let off: i64 = sqlx::query_scalar("INSERT INTO offer_link(wish_id,source,url) VALUES('w','driffle','https://driffle.com/de/x-xbox-live-digital-key-p1') RETURNING id")
            .fetch_one(&pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO shop_job(source,link_id,due) VALUES('driffle',?,?)")
            .bind(off)
            .bind(t - 10)
            .execute(&pool)
            .await
            .unwrap();
        let next = upcoming(&pool, t, false).await.unwrap();
        assert_eq!(links_and_starts(&next), [(kept, t)]);
        // Paused: only direct user actions remain.
        assert!(upcoming(&pool, t, true).await.unwrap().is_empty());
        sqlx::query("UPDATE shop_job SET requested_at=? WHERE link_id=?")
            .bind(t)
            .bind(kept)
            .execute(&pool)
            .await
            .unwrap();
        let next = upcoming(&pool, t, true).await.unwrap();
        assert_eq!(links_and_starts(&next), [(kept, t)]);
        assert_eq!(next[0]["requested"], true);
    }
}
