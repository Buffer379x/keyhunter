//! Daily budget per shop, the pacing of paced jobs and the expected demand.

use super::{
    DAY, DEAD_AFTER, DEFAULT_DAILY_JOBS, ITEM, Kind, PACE_MAX, PACE_MIN, complete::dead_backoff,
    queued, trend::effective_interval,
};
use crate::shops::Shop;
use sqlx::{AssertSqlSafe, SqlitePool};

/// Operator default of the daily budget per shop and where it comes from (`env` or `default`).
/// `KEYHUNTER_SHOP_DAILY_JOBS` counts when it is a whole number from 1 to 2000.
pub(super) fn default_budget() -> (i64, &'static str) {
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
pub(super) fn pace_gap(t: i64, remaining: i64) -> i64 {
    let rest = DAY - t.rem_euclid(DAY);
    (rest / remaining.max(1)).clamp(PACE_MIN, PACE_MAX)
}

/// Expected jobs per day of a shop under its current schedule.
///
/// Uses the scheduler's own rules: the [`queued`](super::queued) filter (no owned or rejected items, previews
/// only while watched and viewed in the last 14 days, nothing without an active wish), the
/// effective adaptive interval ([`effective_interval`], stored price-trend pace, [`dead_backoff`] of dead links) and the repeat delay of
/// each kind ([`Kind::repeat_after`](super::Kind::repeat_after)). One-off work (first searches, continuation pages, new links,
/// retries) is not part of the steady state and therefore not counted.
pub(super) async fn demand(pool: &SqlitePool, shop: Shop, t: i64) -> sqlx::Result<f64> {
    type Group = (Option<i64>, Option<String>, bool, i64, f64, i64, i64);
    let groups: Vec<Group> = sqlx::query_as(AssertSqlSafe(format!(
        "SELECT MIN(j.link_id),MIN(j.wish_id),COALESCE(t.state,'wished')='preview',s.poll_interval_seconds,j.pace,MIN(j.dead_failures,{DEAD_AFTER}),COUNT(*)
        FROM shop_job j JOIN source_settings s ON s.id=j.source LEFT JOIN offer_link l ON l.id=j.link_id {ITEM}
        WHERE j.source=?1 AND s.enabled AND s.configured AND {}
        GROUP BY j.link_id IS NOT NULL,j.wish_id IS NOT NULL,3,4,5,6",
        queued()
    )))
    .bind(shop.id())
    .bind(t)
    .fetch_all(pool)
    .await?;
    Ok(groups
        .into_iter()
        .map(|(link, wish, preview, interval, pace, dead, count)| {
            let kind = Kind::of(link, wish.as_deref());
            let pace = if kind == Kind::Product { pace } else { 1.0 };
            let backoff = if kind == Kind::Product {
                dead_backoff(dead)
            } else {
                1
            };
            let interval = effective_interval(interval, preview, pace) * backoff;
            let period = if kind == Kind::Discovery {
                shop.discovery_every(interval)
            } else {
                kind.repeat_after(interval)
            };
            count as f64 * DAY as f64 / period as f64
        })
        .sum())
}

#[cfg(test)]
mod tests {
    use super::*;
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
}
