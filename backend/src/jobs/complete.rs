//! Storing a finished job: next schedule, data, observation, alert events, log and history in one transaction.

use super::{
    DEAD_AFTER, DEAD_BACKOFF, Job, Kind, MAX_SEARCH_PAGES, RETRY_LADDER, RUN_RETENTION, Work,
    attach::{attach, confirm_discovered, enqueue_candidates},
    relevance,
    trend::{effective_interval, price_trend},
};
use crate::{
    DAY, alerts,
    eventlog::{self, Area, GAME_NAME, Level},
    shops::{Shop, ShopError},
};
use sqlx::{AssertSqlSafe, SqlitePool};

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

/// Consecutive dead results of a product link after a run (FUNC-13, SCORE-06) and the factor of its next interval: a
/// "not found" or an unreadable page counts, a transient error leaves the count, a success resets it. From
/// [`DEAD_AFTER`] on the link waits [`DEAD_BACKOFF`] intervals, so a delisted product or a broken reader does not take
/// a full share of the budget.
fn dead_link(result: &Result<Work, ShopError>, link: bool, previous: i64) -> (i64, i64) {
    match result {
        Err(ShopError::NotFound | ShopError::Parse) if link => {
            let dead = (previous + 1).min(20);
            (dead, dead_backoff(dead))
        }
        Err(_) => (previous, 1),
        Ok(_) => (0, 1),
    }
}

/// Factor of the interval of a product link with `dead` dead results in a row; the demand estimate uses it too.
pub(super) fn dead_backoff(dead: i64) -> i64 {
    if dead >= DEAD_AFTER { DEAD_BACKOFF } else { 1 }
}

/// Store a finished job: schedule, data, observation, alert events and history in one transaction.
#[allow(clippy::too_many_arguments)]
pub(super) async fn complete(
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
    let (dead, backoff) = dead_link(&result, job.link_id.is_some(), job.dead_failures);
    let (due, failures) = next_schedule(&result, job.failures, t, interval * backoff, jitter);
    // A search run keeps `initial` until its last page is stored; a product only for one run.
    let keep_initial = job.link_id.is_none()
        && job.wish_id.is_some()
        && !matches!(&result, Ok(Work::Search(page)) if page.next_page.is_none());
    let mut tx = pool.begin().await?;
    let count = sqlx::query(
        "UPDATE shop_job SET due=?,failures=?,dead_failures=?,lease_until=0,lease_token=NULL,requested_at=0,initial=CASE WHEN ? THEN initial ELSE 0 END
        WHERE id=? AND lease_token=? AND lease_until>?",
    )
    .bind(due)
    .bind(failures)
    .bind(dead)
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
    let kind = Kind::of(job.link_id, job.wish_id.as_deref());
    if let Err(error) = &result {
        let (game, region): (Option<String>, Option<String>) = sqlx::query_as(AssertSqlSafe(format!(
            "SELECT {GAME_NAME},(SELECT json_extract(latest,'$.region') FROM offer_link WHERE id=?2)
            FROM wishlist_item w JOIN game g ON g.id=w.game_id LEFT JOIN catalog_game c ON c.igdb_id=g.igdb_id
            WHERE w.id=COALESCE(?1,(SELECT wish_id FROM offer_link WHERE id=?2))"
        )))
        .bind(&job.wish_id)
        .bind(job.link_id)
        .fetch_optional(&mut *tx)
        .await
        .ok()
        .flatten()
        .unwrap_or_default();
        if let Some((level, message)) =
            failure_entry(shop, kind, game.as_deref(), region.as_deref(), error)
        {
            eventlog::record(&mut *tx, level, Area::Fetch, message).await;
        }
        if dead == DEAD_AFTER && job.dead_failures < DEAD_AFTER {
            eventlog::record_once(
                &mut *tx,
                Level::Warn,
                Area::Fetch,
                dead_entry(shop, game.as_deref(), region.as_deref()),
                eventlog::REPEAT,
            )
            .await;
        }
    }
    sqlx::query("INSERT INTO job_run(source,kind,wish_id,link_id,started_at,duration_ms,outcome,detail) VALUES(?,?,?,?,?,?,?,?)")
        .bind(shop.id()).bind(kind.id()).bind(&job.wish_id).bind(job.link_id).bind(started_at).bind(elapsed_ms)
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

/// Log entry of a failed shop job: a warning for network errors and rate limits, an error otherwise, with
/// the shop pause it causes. None for `not_found`, which is normal.
fn failure_entry(
    shop: Shop,
    kind: Kind,
    game: Option<&str>,
    region: Option<&str>,
    error: &ShopError,
) -> Option<(Level, String)> {
    let (level, reason) = match error {
        ShopError::NotFound => return None,
        ShopError::Network => (Level::Warn, "Netzwerkfehler"),
        ShopError::Throttled(_) => (Level::Warn, "Abruflimit erreicht"),
        ShopError::Denied => (Level::Error, "Zugriff verweigert"),
        ShopError::Parse => (Level::Error, "Antwort nicht lesbar"),
    };
    let game = eventlog::quoted(game);
    let what = match (kind, region) {
        (Kind::Product, Some(region)) => format!("Preisabruf für {game} ({region})"),
        (Kind::Product, None) => format!("Preisabruf für {game}"),
        (Kind::Search, _) => format!("Suche nach {game}"),
        (Kind::Discovery, _) => "Discovery".into(),
    };
    let mut message = format!("{}: {what} fehlgeschlagen ({reason})", shop.name());
    let pause = error.source_pause();
    if pause > 0 {
        message += &format!(
            ". Abrufe bei {} pausieren {} Min.",
            shop.name(),
            (pause + 59) / 60
        );
    }
    Some((level, message))
}

/// Log entry when a product link turns dead ([`dead_link`]).
fn dead_entry(shop: Shop, game: Option<&str>, region: Option<&str>) -> String {
    let game = eventlog::quoted(game);
    let page = match region {
        Some(region) => format!("Produktseite für {game} ({region})"),
        None => format!("Produktseite für {game}"),
    };
    format!(
        "{}: {page} {DEAD_AFTER}-mal in Folge nicht gefunden oder nicht lesbar. Sie wird bis zum nächsten erfolgreichen Abruf nur noch mit {DEAD_BACKOFF}-fachem Abstand geprüft.",
        shop.name()
    )
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::jobs::{budget::demand, tests::*, *};
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
            let done = crate::shops::SearchPage {
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
            let page = crate::shops::SearchPage {
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
    async fn failed_shop_jobs_are_logged_with_shop_game_and_pause_but_not_found_is_not() {
        let pool = empty_queue().await;
        let link = add_link(&pool, "w", 0, 0).await;
        sqlx::query("UPDATE offer_link SET latest=? WHERE id=?")
            .bind(serde_json::to_string(&priced(true)).unwrap())
            .bind(link)
            .execute(&pool)
            .await
            .unwrap();
        for error in [ShopError::NotFound, ShopError::Network, ShopError::Denied] {
            unpace(&pool).await;
            sqlx::raw_sql("UPDATE shop_state SET retry_at=0; UPDATE shop_job SET due=0")
                .execute(&pool)
                .await
                .unwrap();
            let job = claim(&pool, Shop::Eneba, "aa", now(), 1000)
                .await
                .unwrap()
                .unwrap();
            complete(&pool, Shop::Eneba, &job, "aa", Err(error), now(), now(), 1)
                .await
                .unwrap();
        }
        let entries: Vec<(String, String, String)> =
            sqlx::query_as("SELECT level,area,message FROM event_log ORDER BY id")
                .fetch_all(&pool)
                .await
                .unwrap();
        let entry = |level: &str, message: &str| (level.into(), "Abruf".into(), message.into());
        assert_eq!(
            entries,
            [
                entry(
                    "warn",
                    "Eneba: Preisabruf für „w“ (Global) fehlgeschlagen (Netzwerkfehler)"
                ),
                entry(
                    "error",
                    "Eneba: Preisabruf für „w“ (Global) fehlgeschlagen (Zugriff verweigert). Abrufe bei Eneba pausieren 60 Min."
                ),
            ]
        );
    }

    /// FUNC-13 / SCORE-06: five dead results in a row stretch the interval fourfold and log once; a success resets it.
    #[tokio::test]
    async fn dead_links_back_off_after_five_failures_and_recover_func13() {
        let pool = memory().await;
        add_item(&pool, "w", "wished").await;
        let link = add_link(&pool, "w", 0, 0).await;
        let interval: i64 = sqlx::query_scalar(
            "SELECT poll_interval_seconds FROM source_settings WHERE id='eneba'",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        let wait = |t: i64| {
            let pool = pool.clone();
            async move {
                let due: i64 = sqlx::query_scalar("SELECT due FROM shop_job WHERE link_id=?")
                    .bind(link)
                    .fetch_one(&pool)
                    .await
                    .unwrap();
                due - t
            }
        };
        let logged = || {
            let pool = pool.clone();
            async move {
                sqlx::query_scalar::<_, i64>(
                    "SELECT COUNT(*) FROM event_log WHERE message LIKE '%5-mal in Folge%'",
                )
                .fetch_one(&pool)
                .await
                .unwrap()
            }
        };
        let mut t = 1_800_000_000;
        for (n, error) in [
            ShopError::NotFound,
            ShopError::Parse,
            ShopError::NotFound,
            ShopError::NotFound,
        ]
        .into_iter()
        .enumerate()
        {
            finish(&pool, link, Err(error), t).await;
            assert_eq!(wait(t).await, interval, "dead result {}", n + 1);
            t += interval;
        }
        assert_eq!(logged().await, 0);
        finish(&pool, link, Err(ShopError::NotFound), t).await;
        assert_eq!(wait(t).await, 4 * interval, "the fifth one backs off");
        assert_eq!(logged().await, 1);
        t += 4 * interval;
        finish(&pool, link, Err(ShopError::Parse), t).await;
        assert_eq!(wait(t).await, 4 * interval);
        assert_eq!(logged().await, 1, "logged once");
        // A transient error neither counts nor resets, and is not stretched (its ladder is used up by now).
        t += 4 * interval;
        finish(&pool, link, Err(ShopError::Network), t).await;
        assert_eq!(wait(t).await, interval);
        t += interval;
        finish(&pool, link, Ok(Work::Product(Box::new(priced(true)))), t).await;
        let dead: i64 = sqlx::query_scalar("SELECT dead_failures FROM shop_job WHERE link_id=?")
            .bind(link)
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(dead, 0, "a success resets the count");
        t += interval;
        finish(&pool, link, Err(ShopError::NotFound), t).await;
        assert_eq!(wait(t).await, interval);
        // Searches and discoveries never count as dead links.
        assert_eq!(dead_link(&Err(ShopError::Parse), false, 9), (9, 1));
        assert_eq!(dead_link(&Err(ShopError::Network), true, 6), (6, 1));
    }

    /// FUNC-13 follow-up: the demand behind "Abrufe heute" counts a dead link with the same stretched interval as the
    /// scheduler, so the per-shop "zu knapp" is not raised by checks that no longer happen.
    #[tokio::test]
    async fn demand_counts_dead_links_with_the_backed_off_interval_func13() {
        let pool = memory().await;
        add_item(&pool, "w", "wished").await;
        add_link(&pool, "w", 0, 0).await;
        let dead = add_link(&pool, "w", 1, 0).await;
        let interval: i64 = sqlx::query_scalar(
            "SELECT poll_interval_seconds FROM source_settings WHERE id='eneba'",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        let per_day = DAY as f64 / interval as f64;
        // Two product checks and the shop's discovery.
        let base = demand(&pool, Shop::Eneba, 0).await.unwrap();
        assert!(base > 2.0 * per_day, "{base}");
        for failures in [DEAD_AFTER - 1, DEAD_AFTER, 20] {
            sqlx::query("UPDATE shop_job SET dead_failures=? WHERE link_id=?")
                .bind(failures)
                .bind(dead)
                .execute(&pool)
                .await
                .unwrap();
            let expected = base - per_day + per_day / dead_backoff(failures) as f64;
            assert_eq!(
                demand(&pool, Shop::Eneba, 0).await.unwrap(),
                expected,
                "{failures}"
            );
        }
        let (_, backoff) = dead_link(&Err(ShopError::NotFound), true, DEAD_AFTER - 1);
        assert_eq!(backoff, DEAD_BACKOFF, "the scheduler uses the same factor");
        sqlx::query("UPDATE shop_job SET dead_failures=0 WHERE link_id=?")
            .bind(dead)
            .execute(&pool)
            .await
            .unwrap();
        assert_eq!(
            demand(&pool, Shop::Eneba, 0).await.unwrap(),
            base,
            "recovered"
        );
    }
}
