use super::*;
use super::{
    api::{UPCOMING, backlog, budget_status, upcoming, upcoming_sql},
    attach::{queue_search, schedule_wish},
    budget::demand,
    complete::complete,
    trend::MIN_INTERVAL,
};
/// A file of the repository outside `backend/` (docs, deploy files). Not part of the Docker build context, so this only
/// runs in the check container where the whole repository is mounted.
fn repo_file(path: &str) -> String {
    let full = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join(path);
    std::fs::read_to_string(&full).unwrap_or_else(|e| panic!("{}: {e}", full.display()))
}

/// CODE-09 / FUNC-08 / SCORE-10 / PERF-14: the numbers the docs, `.env.example`, the compose file and the Unraid
/// template state are the constants the code runs with.
#[test]
fn documented_limits_match_the_constants() {
    let (lo, hi) = (*DAILY_JOBS_SETTING.start(), *DAILY_JOBS_SETTING.end());
    let ops = repo_file("docs/operations.md");
    assert!(
        ops.contains(&format!("zwischen {lo} und {hi} festlegen")),
        "budget bounds in operations.md"
    );
    assert!(
        ops.contains(&format!(
            "{lo} bis {hi} Jobs pro UTC-Tag in der App, Standard {DEFAULT_DAILY_JOBS}"
        )),
        "budget row"
    );
    assert!(
        ops.contains(&format!(
            "| `KEYHUNTER_SHOP_DAILY_JOBS` | {DEFAULT_DAILY_JOBS} |"
        )),
        "env table default"
    );
    assert!(ops.contains(&format!("von 1 bis {hi}")), "env range");
    assert!(
        ops.contains(&format!("{PACE_MIN} s bis 1 h")) && PACE_MAX == 3600,
        "pacing bounds"
    );
    let ladder = format!(
        "nach {}, {} und {} Minuten",
        RETRY_LADDER[0] / 60,
        RETRY_LADDER[1] / 60,
        RETRY_LADDER[2] / 60
    );
    assert!(ops.contains(&ladder), "retry ladder: {ladder}");
    assert!(
        ops.contains(&format!(
            "nach {DEAD_AFTER} Fehlschlägen in Folge nur noch mit {DEAD_BACKOFF}-fachem Intervall"
        )),
        "dead-link backoff"
    );
    assert!(
        ops.contains(&format!(
            "{} Minuten Abstand zum letzten Abruf",
            REQUEST_WINDOW / 60
        )),
        "refresh spacing"
    );
    assert!(
        ops.contains(&format!(
            "max({} Stunden, 2 × effektives Intervall)",
            crate::pricing::FRESH / 3600
        )),
        "freshness rule"
    );
    assert!(
        ops.contains(&format!(
            "| Abrufhistorie / Log | {} Tage / 7 Tage |",
            RUN_RETENTION / DAY
        )),
        "retention"
    );
    let sources = repo_file("docs/data-sources.md");
    assert!(
        sources.contains(&format!(
            "max({} h, 2 × Intervall)",
            crate::pricing::FRESH / 3600
        )),
        "freshness rule in data-sources.md"
    );
    assert!(
        sources.contains(&format!(
            "zwischen {} Minuten und 7 Tagen",
            MIN_INTERVAL / 60
        )),
        "interval bounds"
    );
    let env = repo_file(".env.example");
    assert!(
        env.contains(&format!("KEYHUNTER_SHOP_DAILY_JOBS={DEFAULT_DAILY_JOBS}")),
        ".env.example default"
    );
    assert!(
        env.contains(&format!("from 1 to {hi} (default {DEFAULT_DAILY_JOBS})")),
        ".env.example range"
    );
    assert!(
        repo_file("compose.yaml").contains(&format!(
            "KEYHUNTER_SHOP_DAILY_JOBS:-{DEFAULT_DAILY_JOBS}}}"
        )),
        "compose default"
    );
    let template = repo_file("deploy/unraid/keyhunter.xml");
    let line = template
        .lines()
        .find(|l| l.contains("Target=\"KEYHUNTER_SHOP_DAILY_JOBS\""))
        .expect("template entry");
    assert!(
        line.contains(&format!("Default=\"{DEFAULT_DAILY_JOBS}\""))
            && line.contains(&format!("1-{hi}"))
            && line.contains(&format!("({lo}-{hi})")),
        "template entry: {line}"
    );
}

/// Lift the pacing of every shop, for tests about other scheduling rules.
pub(super) async fn unpace(pool: &SqlitePool) {
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
    sqlx::query(
        "INSERT INTO wishlist_item(id,game_id,platform_id,created_at) VALUES('saved','g',169,0)",
    )
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
    sqlx::query(
        "INSERT INTO game(id,manual_title,manual_key,created_at) VALUES('g2','Other','other',0)",
    )
    .execute(&pool)
    .await
    .unwrap();
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
    sqlx::query("UPDATE shop_job SET lease_until=0,lease_token=NULL,due=? WHERE wish_id IS NULL")
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
async fn wishlist_searches_are_persistent_idempotent_prioritized_and_cascade() {
    let pool = sqlx::sqlite::SqlitePoolOptions::new()
        .max_connections(1)
        .connect("sqlite::memory:")
        .await
        .unwrap();
    sqlx::migrate!("./migrations").run(&pool).await.unwrap();
    sqlx::query(
        "INSERT INTO game(id,manual_title,manual_key,created_at) VALUES('g','Example','example',0)",
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
    use crate::shops::{Quote, SearchPage};
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
        // Saved by hand like `schedule_wish` does it (P2: only then the first search is a direct user action).
        sqlx::query("INSERT INTO shop_job(source,wish_id,due,initial) VALUES('eneba',?,?,1)")
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
    // SCORE-05: every observation happens at a claim time from T0 on, so `observed_at < T0` means never measured.
    // (Up to 0.9.2 this compared with 0, which no observation is below: both checks could not fail.)
    assert_eq!(
        stale_count(&active_other, T0).await,
        0,
        "other regions are not starved"
    );
    // Classes 2 to 5 share every fourth job by due time, so under this bottleneck 121 of the 200 preview links are
    // still unmeasured after ten days and the discovery runs once (audit 11, SCORE-05). Known and kept for 1.0; the
    // fair share of the fourth slot is planned for 1.1. The bound keeps it from getting worse unnoticed.
    assert!(
        stale_count(&previews, T0).await <= 121,
        "at most 121 of 200 previews stay unmeasured (SCORE-05, 1.1)"
    );
    let discoveries: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM job_run WHERE kind='discovery'")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert!(discoveries >= 1, "the discovery runs at least once");
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

pub(super) async fn memory() -> SqlitePool {
    let pool = sqlx::sqlite::SqlitePoolOptions::new()
        .max_connections(1)
        .connect("sqlite::memory:")
        .await
        .unwrap();
    sqlx::migrate!("./migrations").run(&pool).await.unwrap();
    pool
}

pub(super) async fn add_item(pool: &SqlitePool, id: &str, state: &str) {
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

pub(super) async fn add_link(pool: &SqlitePool, wish: &str, n: usize, due: i64) -> i64 {
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

pub(super) fn priced(valid: bool) -> Product {
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

#[tokio::test]
async fn paced_jobs_wait_while_direct_user_actions_bypass_pacing_but_count() {
    use crate::shops::SearchPage;
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
    let paced: i64 = sqlx::query_scalar("SELECT paced_until FROM shop_state WHERE source='eneba'")
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

/// P2: an import queues the first searches of its wishes without the direct-action flag. Restoring 300 wishes
/// then takes one paced slot at a time instead of the whole budget at once, the regular price checks keep
/// running through the day, and a game added by hand still searches at once.
#[tokio::test]
async fn imported_wishes_search_paced_and_leave_the_budget_to_regular_checks() {
    use crate::shops::SearchPage;
    const T0: i64 = 1_800_000_000 - 1_800_000_000 % DAY;
    const BUDGET: i64 = 300;
    let pool = memory().await;
    let t = T0 + 3600;
    // An existing wish whose in-stock price is due now; discovery is far off.
    add_item(&pool, "old", "wished").await;
    let price = add_link(&pool, "old", 0, t).await;
    sqlx::query("UPDATE shop_job SET relevance=1 WHERE link_id=?")
        .bind(price)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("UPDATE shop_job SET due=? WHERE wish_id IS NULL AND link_id IS NULL")
        .bind(T0 + 10 * DAY)
        .execute(&pool)
        .await
        .unwrap();
    for n in 0..300 {
        let id = format!("imported{n}");
        add_item(&pool, &id, "wished").await;
        queue_search(&mut pool.acquire().await.unwrap(), &id, false)
            .await
            .unwrap();
    }
    sqlx::query("UPDATE shop_job SET due=? WHERE wish_id LIKE 'imported%'")
        .bind(t)
        .execute(&pool)
        .await
        .unwrap();
    let run = |job: Job, token: &'static str, at: i64| {
        let pool = pool.clone();
        async move {
            let work = if job.link_id.is_some() {
                Work::Product(Box::new(priced(true)))
            } else {
                Work::Search(SearchPage {
                    urls: vec![],
                    next_page: None,
                })
            };
            complete(&pool, Shop::Eneba, &job, token, Ok(work), at, at, 1)
                .await
                .unwrap();
        }
    };

    let first = claim(&pool, Shop::Eneba, "i0", t, BUDGET)
        .await
        .unwrap()
        .unwrap();
    assert!(!first.bypass, "an imported search is paced");
    run(first, "i0", t).await;
    assert!(
        claim(&pool, Shop::Eneba, "i1", t, BUDGET)
            .await
            .unwrap()
            .is_none(),
        "the other 299 imported searches wait for their slots"
    );

    // A game added by hand searches at once, also while the import is paced.
    add_item(&pool, "hand", "wished").await;
    schedule_wish(&pool, "hand").await.unwrap();
    let hand = claim(&pool, Shop::Eneba, "h1", t, BUDGET)
        .await
        .unwrap()
        .unwrap();
    assert_eq!((hand.wish_id.as_deref(), hand.bypass), (Some("hand"), true));
    run(hand, "h1", t).await;

    // The rest of the day: the worker claims whatever pacing allows.
    let (mut at, mut searches, mut prices, mut most_at_once) = (t + 1, 0, 0, 0);
    while at < T0 + DAY {
        let mut at_once = 0;
        while let Some(job) = claim(&pool, Shop::Eneba, "ww", at, BUDGET).await.unwrap() {
            assert!(!job.bypass);
            at_once += 1;
            if job.link_id == Some(price) {
                prices += 1;
            } else {
                searches += 1;
            }
            run(job, "ww", at).await;
        }
        most_at_once = most_at_once.max(at_once);
        let paced: i64 =
            sqlx::query_scalar("SELECT paced_until FROM shop_state WHERE source='eneba'")
                .fetch_one(&pool)
                .await
                .unwrap();
        at = paced.max(at + 60);
    }
    assert_eq!(most_at_once, 1, "one paced job per slot");
    assert!(
        prices >= 2,
        "the regular price check keeps its 8-hour interval: {prices}"
    );
    assert!(
        searches > 250,
        "the imported searches use the rest of the budget: {searches}"
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
async fn a_paused_wish_waits_through_a_global_pause_and_resume_until_its_end() {
    let pool = memory().await;
    const T0: i64 = 1_800_000_000 - 1_800_000_000 % DAY;
    add_item(&pool, "w", "wished").await;
    let link = add_link(&pool, "w", 0, T0).await;
    for sql in [
        "UPDATE shop_job SET initial=0",
        "DELETE FROM shop_job WHERE link_id IS NULL AND wish_id IS NULL",
        "UPDATE wishlist_item SET paused_at=1 WHERE id='w'",
    ] {
        sqlx::query(sql).execute(&pool).await.unwrap();
    }
    unpace(&pool).await;
    let next = |t| {
        let pool = pool.clone();
        async move { claim(&pool, Shop::Eneba, "aa", t, 1000).await.unwrap() }
    };
    // Paused until resumed by hand: nothing runs, none of it is upcoming or counted as demand.
    assert!(next(T0).await.is_none());
    assert!(upcoming(&pool, T0, false).await.unwrap().is_empty());
    assert_eq!(demand(&pool, Shop::Eneba, T0).await.unwrap(), 0.0);
    // The global pause and its end leave the wish paused.
    sqlx::query("UPDATE app_settings SET fetch_paused_at=?")
        .bind(T0)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("UPDATE app_settings SET fetch_paused_at=NULL")
        .execute(&pool)
        .await
        .unwrap();
    assert!(next(T0 + DAY).await.is_none());
    // A check the owner asks for still runs.
    sqlx::query("UPDATE shop_job SET requested_at=? WHERE link_id=?")
        .bind(T0 + DAY)
        .bind(link)
        .execute(&pool)
        .await
        .unwrap();
    let job = next(T0 + DAY).await.unwrap();
    assert_eq!(job.link_id, Some(link));
    complete(
        &pool,
        Shop::Eneba,
        &job,
        "aa",
        Err(ShopError::Network),
        T0 + DAY,
        T0 + DAY,
        1,
    )
    .await
    .unwrap();
    // A pause with an end: the checks start again by themselves afterwards.
    sqlx::query("UPDATE wishlist_item SET paused_until=? WHERE id='w'")
        .bind(T0 + 3 * DAY)
        .execute(&pool)
        .await
        .unwrap();
    unpace(&pool).await;
    assert!(next(T0 + 2 * DAY).await.is_none());
    unpace(&pool).await;
    assert_eq!(next(T0 + 4 * DAY).await.unwrap().link_id, Some(link));
}

#[tokio::test]
async fn demand_estimate_matches_an_unlimited_simulation() {
    use crate::shops::SearchPage;
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

/// Only the jobs a test adds, nothing paced.
pub(super) async fn empty_queue() -> SqlitePool {
    let pool = memory().await;
    sqlx::query("DELETE FROM shop_job")
        .execute(&pool)
        .await
        .unwrap();
    unpace(&pool).await;
    add_item(&pool, "w", "wished").await;
    pool
}

/// 500 active wishes with 4 linked products each (2000 links, one job each) plus a search per wish:
/// the data set of the PERF-01 measurement. Everything is due, so the whole queue is a backlog.
async fn large_queue(t: i64) -> SqlitePool {
    let pool = memory().await;
    sqlx::raw_sql("UPDATE source_settings SET enabled=1,configured=1 WHERE kind='shop'")
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query(
            "WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i+1 FROM n WHERE i<1999)
            INSERT INTO game(id,manual_title,manual_key,created_at) SELECT 'g'||i,'Game '||i,'game '||i,0 FROM n WHERE i<500",
        )
        .execute(&pool)
        .await
        .unwrap();
    for sql in [
            "INSERT INTO wishlist_item(id,game_id,platform_id,created_at) SELECT 'w'||substr(id,2),id,169,0 FROM game",
            "WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i+1 FROM n WHERE i<1999)
            INSERT INTO offer_link(wish_id,source,url,review,observed_at)
            SELECT 'w'||(i/4),CASE WHEN i%4=3 THEN 'driffle' ELSE 'eneba' END,'https://www.eneba.com/de/xbox-perf-'||i,'confirmed',?1-3600 FROM n",
            "INSERT INTO shop_job(source,link_id,due,checked_at) SELECT source,id,?1-60-id,?1-3600 FROM offer_link",
            "INSERT INTO shop_job(source,wish_id,due,checked_at) SELECT 'eneba',id,?1-30,?1-WEEK FROM wishlist_item",
        ] {
            sqlx::query(AssertSqlSafe(sql.replace("WEEK", &WEEK.to_string())))
                .bind(t)
                .execute(&pool)
                .await
                .unwrap();
        }
    unpace(&pool).await;
    pool
}

/// Median duration of `runs` calls in microseconds.
async fn median_us<F, Fut>(runs: usize, mut call: F) -> u128
where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = ()>,
{
    let mut times = Vec::with_capacity(runs);
    for _ in 0..runs {
        let start = Instant::now();
        call().await;
        times.push(start.elapsed().as_micros());
    }
    times.sort_unstable();
    times[runs / 2]
}

/// PERF-01: claim and the fetch status stay fast at 500 wishes and 2000 links.
#[tokio::test]
async fn perf01_claim_and_status_stay_fast_at_500_wishes() {
    const T0: i64 = 1_800_000_000 - 1_800_000_000 % DAY + 12 * 3600;
    let pool = large_queue(T0).await;
    let claim_us = median_us(11, || {
            let pool = pool.clone();
            async move {
                let job = claim(&pool, Shop::Eneba, "perf", T0, 2000).await.unwrap();
                assert!(job.is_some());
                sqlx::raw_sql("UPDATE shop_job SET lease_until=0,lease_token=NULL; UPDATE shop_state SET paced_until=0,jobs_today=0")
                    .execute(&pool)
                    .await
                    .unwrap();
            }
        })
        .await;
    let status_us = median_us(5, || {
        let pool = pool.clone();
        async move {
            for shop in Shop::ALL {
                backlog(&pool, shop, T0).await.unwrap();
                budget_status(&pool, shop, T0).await.unwrap();
            }
            assert_eq!(upcoming(&pool, T0, false).await.unwrap().len(), UPCOMING);
        }
    })
    .await;
    println!(
        "PERF-01 at 500 wishes/2000 links: claim median {claim_us} µs, status queries median {status_us} µs"
    );
    // Every scheduler statement evaluates the active-wish check once, as an uncorrelated scalar subquery,
    // never as an EXISTS join per job row (the plan SQLite 3.51 chose for `EXISTS(…)`).
    let statements = [
        format!("SELECT EXISTS(SELECT 1 {})", claimable()),
        claim_sql(),
        upcoming_sql(),
        format!(
            "SELECT COUNT(*) FROM {JOBS} WHERE j.source=?1 AND {}",
            waiting()
        ),
        format!(
            "SELECT MAX({}),MAX({}) FROM {JOBS}",
            pending(),
            direct_action()
        ),
        format!(
            "SELECT COUNT(*) FROM shop_job j LEFT JOIN offer_link l ON l.id=j.link_id {ITEM} WHERE {}",
            queued()
        ),
    ];
    for sql in statements {
        let plan: Vec<(i64, i64, i64, String)> =
            sqlx::query_as(AssertSqlSafe(format!("EXPLAIN QUERY PLAN {sql}")))
                .fetch_all(&pool)
                .await
                .unwrap();
        let parent = |id: i64| plan.iter().find(|row| row.0 == id);
        let checks: Vec<_> = plan
            .iter()
            .filter(|row| row.3.contains("any_wish"))
            .collect();
        assert!(!checks.is_empty(), "no active-wish check in {plan:?}");
        for row in checks {
            let mut up = parent(row.1);
            while let Some(node) = up.filter(|node| !node.3.contains("SCALAR SUBQUERY")) {
                up = parent(node.1);
            }
            assert!(
                up.is_some_and(|node| !node.3.starts_with("CORRELATED"))
                    && !row.3.contains("EXISTS"),
                "active-wish check evaluated per row: {plan:#?}"
            );
        }
    }
    // Generous bounds for a debug build; the release build needs a fraction (K22: claim < 5 ms, status < 50 ms).
    assert!(claim_us < 100_000, "claim took {claim_us} µs");
    assert!(status_us < 400_000, "status queries took {status_us} µs");
}

/// Leases the job of `link` and stores `result` at `t`, like the worker does.
pub(super) async fn finish(pool: &SqlitePool, link: i64, result: Result<Work, ShopError>, t: i64) {
    let job: Job = sqlx::query_as(
        "UPDATE shop_job SET lease_until=?,lease_token='tt' WHERE link_id=?
            RETURNING id,link_id,failures,dead_failures,wish_id,search_page",
    )
    .bind(t + 180)
    .bind(link)
    .fetch_one(pool)
    .await
    .unwrap();
    complete(pool, Shop::Eneba, &job, "tt", result, t, t, 1000)
        .await
        .unwrap();
}
