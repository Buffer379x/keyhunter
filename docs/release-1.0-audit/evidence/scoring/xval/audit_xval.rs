// Audit cross-validation harness (NOT part of the product). run_xval.sh appends
// `#[cfg(test)] #[path = "audit_xval.rs"] mod audit_xval;` to a scratch COPY of backend/src/jobs.rs,
// so the real `claim` and `complete` (jobs.rs:259, 551) replay a recorded scenario on an
// in-memory database with the worker's timing (jobs.rs:147-151: +2 s after a job, +3 s idle).
use super::*;
use crate::shops::{Quote, eneba::SearchPage};
use std::io::Write;

#[derive(serde::Deserialize)]
struct LinkIn {
    wish: usize,
    valid: bool,
    /// [start, cents or null (sold out), error code or null], sorted by start.
    states: Vec<(i64, Option<i64>, Option<String>)>,
}
#[derive(serde::Deserialize)]
struct Scenario {
    t0: i64,
    days: i64,
    budget: i64,
    interval: i64,
    duration: i64,
    wishes: usize,
    links: Vec<LinkIn>,
}

fn product(valid: bool, cents: Option<i64>) -> Product {
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
        offers: cents
            .map(|c| vec![Quote { id: "q".into(), cents: c, seller: None }])
            .unwrap_or_default(),
        availability: if cents.is_some() { Availability::InStock } else { Availability::SoldOut },
    }
}

fn error(code: &str) -> ShopError {
    match code {
        "network" => ShopError::Network,
        "not_found" => ShopError::NotFound,
        "rate_limited" => ShopError::Throttled(900),
        "access_denied" => ShopError::Denied,
        _ => ShopError::Parse,
    }
}

#[tokio::test]
async fn audit_xval_replay() {
    let Ok(input) = std::env::var("XVAL_IN") else { return };
    let out = std::env::var("XVAL_OUT").unwrap();
    let sc: Scenario = serde_json::from_str(&std::fs::read_to_string(input).unwrap()).unwrap();
    let pool = sqlx::sqlite::SqlitePoolOptions::new().max_connections(1).connect("sqlite::memory:").await.unwrap();
    sqlx::migrate!("./migrations").run(&pool).await.unwrap();
    sqlx::query("UPDATE app_settings SET target_country='DE'").execute(&pool).await.unwrap();
    sqlx::query("UPDATE source_settings SET poll_interval_seconds=? WHERE id='eneba'")
        .bind(sc.interval).execute(&pool).await.unwrap();
    let mut index = std::collections::HashMap::new();
    for w in 0..sc.wishes {
        let id = format!("w{w}");
        sqlx::query("INSERT INTO game(id,manual_title,manual_key,created_at) VALUES(?,?,?,0)")
            .bind(&id).bind(&id).bind(&id).execute(&pool).await.unwrap();
        sqlx::query("INSERT INTO wishlist_item(id,game_id,platform_id,created_at) VALUES(?,?,169,0)")
            .bind(&id).bind(&id).execute(&pool).await.unwrap();
        // an existing wish: searched once before (class 2 from now on)
        sqlx::query("INSERT INTO shop_job(source,wish_id,due,checked_at) VALUES('eneba',?,?,?)")
            .bind(&id).bind(sc.t0).bind(sc.t0 - DAY).execute(&pool).await.unwrap();
        for (n, _) in sc.links.iter().enumerate().filter(|(_, l)| l.wish == w) {
            let lid: i64 = sqlx::query_scalar("INSERT INTO offer_link(wish_id,source,url,review) VALUES(?,'eneba',?,'confirmed') RETURNING id")
                .bind(&id).bind(format!("https://www.eneba.com/de/xbox-{id}-{n}-key-global")).fetch_one(&pool).await.unwrap();
            sqlx::query("INSERT INTO shop_job(source,link_id,due) VALUES('eneba',?,?)")
                .bind(lid).bind(sc.t0).execute(&pool).await.unwrap();
            index.insert(lid, n);
        }
    }
    let mut file = std::fs::File::create(out).unwrap();
    let mut t = sc.t0;
    let end = sc.t0 + sc.days * DAY;
    while t < end {
        let Some(job) = claim(&pool, Shop::Eneba, "aa", t, sc.budget).await.unwrap() else {
            t += 3;
            continue;
        };
        let (kind, n, result) = match (job.link_id, &job.wish_id) {
            (Some(lid), _) => {
                let n = index[&lid];
                let link = &sc.links[n];
                let (_, cents, err) = link.states.iter().rev().find(|s| s.0 <= t).cloned().unwrap();
                let result = match err {
                    Some(code) => Err(error(&code)),
                    None => Ok(Work::Product(Box::new(product(link.valid, cents)))),
                };
                ("product", n as i64, result)
            }
            (None, Some(_)) => ("search", -1, Ok(Work::Search(SearchPage { urls: vec![], next_page: None }))),
            (None, None) => ("discovery", -1, Ok(Work::Discovery(vec![], None))),
        };
        let outcome = match &result { Ok(_) => "ok".to_string(), Err(e) => e.code().to_string() };
        complete(&pool, Shop::Eneba, &job, "aa", result, t + sc.duration, t, sc.duration * 1000).await.unwrap();
        let (due, pace, relevance): (i64, f64, i64) = sqlx::query_as("SELECT due,pace,relevance FROM shop_job WHERE id=?")
            .bind(job.id).fetch_one(&pool).await.unwrap();
        let score: Option<f64> = match job.link_id {
            Some(lid) => sqlx::query_scalar("SELECT cheap_score FROM offer_link WHERE id=?").bind(lid).fetch_one(&pool).await.unwrap(),
            None => None,
        };
        writeln!(file, "{}", serde_json::json!([t, kind, n, outcome, due, pace, relevance, score])).unwrap();
        t += sc.duration + 2;
    }
}

/// jobs.rs:1859-2045 with the vacuous `stale_count(.., 0)` replaced by a count of links never measured.
#[tokio::test]
async fn audit_budget_test_counts() {
    let Ok(out) = std::env::var("XVAL_BUDGET_OUT") else { return };
    let pool = sqlx::sqlite::SqlitePoolOptions::new().max_connections(1).connect("sqlite::memory:").await.unwrap();
    sqlx::migrate!("./migrations").run(&pool).await.unwrap();
    sqlx::query("UPDATE app_settings SET target_country='DE'").execute(&pool).await.unwrap();
    const T0: i64 = 1_800_000_000 - 1_800_000_000 % DAY;
    let (mut active, mut previews) = (vec![], vec![]);
    let mut valid = std::collections::HashMap::new();
    async fn item(pool: &SqlitePool, id: &str) {
        sqlx::query("INSERT INTO game(id,manual_title,manual_key,created_at) VALUES(?,?,?,0)").bind(id).bind(id).bind(id).execute(pool).await.unwrap();
        sqlx::query("INSERT INTO wishlist_item(id,game_id,platform_id,created_at) VALUES(?,?,169,0)").bind(id).bind(id).execute(pool).await.unwrap();
        sqlx::query("INSERT INTO shop_job(source,wish_id,due) VALUES('eneba',?,?)").bind(id).bind(T0).execute(pool).await.unwrap();
    }
    async fn link(pool: &SqlitePool, wish: &str, n: usize) -> i64 {
        let id: i64 = sqlx::query_scalar("INSERT INTO offer_link(wish_id,source,url,review) VALUES(?,'eneba',?,'confirmed') RETURNING id")
            .bind(wish).bind(format!("https://www.eneba.com/de/xbox-{wish}-{n}-key-global")).fetch_one(pool).await.unwrap();
        sqlx::query("INSERT INTO shop_job(source,link_id,due) VALUES('eneba',?,?)").bind(id).bind(T0).execute(pool).await.unwrap();
        id
    }
    for w in 0..10 {
        let wish = format!("w{w}");
        item(&pool, &wish).await;
        for n in 0..10 {
            let id = link(&pool, &wish, n).await;
            valid.insert(id, n < 2);
            active.push(id);
        }
        for e in 0..2 {
            let preview = format!("p{w}x{e}");
            item(&pool, &preview).await;
            sqlx::query("UPDATE wishlist_item SET state='preview',viewed_at=? WHERE id=?").bind(T0).bind(&preview).execute(&pool).await.unwrap();
            sqlx::query("INSERT INTO edition_watch VALUES(?,?)").bind(&wish).bind(&preview).execute(&pool).await.unwrap();
            for n in 0..10 {
                let id = link(&pool, &preview, n).await;
                valid.insert(id, n < 2);
                previews.push(id);
            }
        }
    }
    let mut t = T0;
    while t < T0 + 10 * DAY {
        while let Some(job) = claim(&pool, Shop::Eneba, "aa", t, 40).await.unwrap() {
            let result = match (job.link_id, &job.wish_id) {
                (Some(id), _) => Ok(Work::Product(Box::new(product(valid[&id], Some(2000))))),
                (None, Some(_)) => Ok(Work::Search(SearchPage { urls: vec![], next_page: None })),
                (None, None) => Ok(Work::Discovery(vec![], None)),
            };
            complete(&pool, Shop::Eneba, &job, "aa", result, t + 5, t, 5000).await.unwrap();
        }
        t += 300;
    }
    let never = |ids: &Vec<i64>| {
        let ids = serde_json::to_string(ids).unwrap();
        let pool = pool.clone();
        async move {
            sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM offer_link WHERE id IN (SELECT value FROM json_each(?)) AND observed_at IS NULL")
                .bind(ids).fetch_one(&pool).await.unwrap()
        }
    };
    let vacuous: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM offer_link WHERE COALESCE(observed_at,0)<0").fetch_one(&pool).await.unwrap();
    let runs: Vec<(String, i64)> = sqlx::query_as("SELECT kind,COUNT(*) FROM job_run GROUP BY kind ORDER BY kind").fetch_all(&pool).await.unwrap();
    std::fs::write(out, serde_json::json!({
        "previews_never_measured": never(&previews).await, "previews": previews.len(),
        "active_never_measured": never(&active).await, "active": active.len(),
        "original_assertion_count_since_0": vacuous, "runs_by_kind": runs,
    }).to_string()).unwrap();
}
