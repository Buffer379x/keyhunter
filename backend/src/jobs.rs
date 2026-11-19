use crate::{
    alerts, now, offers, random_token,
    shops::{Product, Shop, ShopError},
};
use sqlx::{FromRow, SqlitePool};
use std::time::Duration;

const INTERVAL: i64 = 8 * 3600;
const DAY: i64 = 86400;

pub(crate) fn daily_budget() -> i64 {
    std::env::var("KEYHUNTER_SHOP_DAILY_JOBS")
        .ok()
        .and_then(|v| v.parse::<i64>().ok())
        .filter(|v| (1..=1000).contains(v))
        .unwrap_or(120)
}

pub(crate) fn start(pool: &SqlitePool) {
    let budget = daily_budget();
    for shop in Shop::ALL {
        let pool = pool.clone();
        tokio::spawn(async move {
            let mut next_attach = 0;
            loop {
                if now() >= next_attach {
                    if let Err(error) = attach(&pool, shop).await {
                        tracing::warn!(source = shop.id(), %error, "Candidate attachment failed");
                    }
                    next_attach = now() + 30;
                }
                match run_one(&pool, shop, budget).await {
                    Ok(true) => tokio::time::sleep(Duration::from_secs(2)).await,
                    Ok(false) => tokio::time::sleep(Duration::from_secs(3)).await,
                    Err(error) => {
                        tracing::error!(source = shop.id(), %error, "Shop job database operation failed");
                        tokio::time::sleep(Duration::from_secs(10)).await;
                    }
                }
            }
        });
    }
}

#[derive(FromRow)]
struct Job {
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
    let pending: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM shop_job j JOIN source_settings s ON s.id=j.source
        JOIN shop_state p ON p.source=j.source LEFT JOIN offer_link l ON l.id=j.link_id
        WHERE j.source=? AND s.enabled AND s.configured AND p.retry_at<=? AND (p.budget_day!=? OR p.jobs_today<?)
        AND j.due<=? AND j.lease_until<=? AND (j.link_id IS NULL OR l.review!='rejected')
        AND NOT EXISTS(SELECT 1 FROM edition_preview ep WHERE ep.track_id=COALESCE(j.wish_id,l.wish_id) AND ep.viewed_at<unixepoch()-86400)
        AND EXISTS(SELECT 1 FROM wishlist_item w WHERE NOT EXISTS(SELECT 1 FROM edition_preview ep WHERE ep.track_id=w.id)))",
    )
    .bind(shop.id())
    .bind(t)
    .bind(day)
    .bind(budget)
    .bind(t)
    .bind(t)
    .fetch_one(pool)
    .await?;
    if !pending {
        return Ok(None);
    }

    let mut tx = pool.begin().await?;
    let claimed = sqlx::query_as("UPDATE shop_job SET lease_until=?,lease_token=?
        WHERE id=(SELECT j.id FROM shop_job j JOIN source_settings s ON s.id=j.source
        JOIN shop_state p ON p.source=j.source LEFT JOIN offer_link l ON l.id=j.link_id
        WHERE j.source=? AND s.enabled AND s.configured AND p.retry_at<=? AND j.due<=? AND j.lease_until<=?
        AND (p.budget_day!=? OR p.jobs_today<?)
        AND (j.link_id IS NULL OR l.review!='rejected')
        AND NOT EXISTS(SELECT 1 FROM shop_job running WHERE running.source=j.source AND running.lease_until>?)
        AND NOT EXISTS(SELECT 1 FROM edition_preview ep WHERE ep.track_id=COALESCE(j.wish_id,l.wish_id) AND ep.viewed_at<unixepoch()-86400)
        AND EXISTS(SELECT 1 FROM wishlist_item w WHERE NOT EXISTS(SELECT 1 FROM edition_preview ep WHERE ep.track_id=w.id))
        ORDER BY (j.wish_id IS NOT NULL) DESC,j.due,(j.link_id IS NULL),j.id LIMIT 1)
        RETURNING id,link_id,failures,wish_id,search_page")
        .bind(t+180).bind(token).bind(shop.id()).bind(t).bind(t).bind(t).bind(day).bind(budget).bind(t)
        .fetch_optional(&mut *tx).await?;
    if claimed.is_some() {
        sqlx::query("UPDATE shop_state SET jobs_today=CASE WHEN budget_day=? THEN jobs_today+1 ELSE 1 END, budget_day=? WHERE source=?")
            .bind(day).bind(day).bind(shop.id()).execute(&mut *tx).await?;
    }
    tx.commit().await?;
    Ok(claimed)
}

enum Work {
    Product(Box<Product>),
    Discovery(Vec<(String, String)>),
    Search(crate::shops::eneba::SearchPage),
}

async fn run_one(pool: &SqlitePool, shop: Shop, budget: i64) -> anyhow::Result<bool> {
    let token = random_token()?;
    let Some(job) = claim(pool, shop, &token, now(), budget).await? else {
        return Ok(false);
    };
    let result = if let Some(id) = &job.wish_id {
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
        let Some(raw) = raw else {
            return Ok(true);
        };
        match shop.product_url(&raw) {
            Some(url) => shop.product(&url).await.map(|p| Work::Product(Box::new(p))),
            None => Err(ShopError::Denied),
        }
    } else {
        let shard: i64 = sqlx::query_scalar("SELECT next_discovery FROM shop_state WHERE source=?")
            .bind(shop.id())
            .fetch_one(pool)
            .await?;
        shop.discover(shard as usize).await.map(Work::Discovery)
    };

    let t = now();
    let interval: i64 =
        sqlx::query_scalar("SELECT poll_interval_seconds FROM source_settings WHERE id=?")
            .bind(shop.id())
            .fetch_one(pool)
            .await?;
    let (due, failures) = match &result {
        Ok(Work::Product(_)) => (t + interval, 0),
        Ok(Work::Search(page)) if page.next_page.is_some() => (t, 0),
        Ok(Work::Discovery(_) | Work::Search(_)) => (t + DAY, 0),
        Err(error) => {
            let failures = job.failures + 1;
            let ordinary = if failures == 3 {
                INTERVAL
            } else {
                120 * (1 << job.failures)
            };
            let jitter = i64::from(u8::from_str_radix(&token[..2], 16).unwrap_or(0) % 31);
            (
                t + error.source_pause().max(ordinary + jitter),
                if failures == 3 { 0 } else { failures },
            )
        }
    };
    let mut tx = pool.begin().await?;
    let count = sqlx::query(
        "UPDATE shop_job SET due=?,failures=?,lease_until=0,lease_token=NULL
        WHERE id=? AND lease_token=? AND lease_until>?",
    )
    .bind(due)
    .bind(failures)
    .bind(job.id)
    .bind(&token)
    .bind(t)
    .execute(&mut *tx)
    .await?
    .rows_affected();
    if count == 0 {
        return Ok(true);
    }

    sqlx::query("UPDATE shop_job SET checked_at=?,last_error=? WHERE id=?")
        .bind(t)
        .bind(result.as_ref().err().map(ShopError::code))
        .bind(job.id)
        .execute(&mut *tx)
        .await?;
    let mut measured = None;
    match result {
        Ok(Work::Product(product)) => {
            let link = job.link_id.expect("product job");
            let json = serde_json::to_string(&product)?;
            let wish: Option<String> = sqlx::query_scalar("UPDATE offer_link SET latest=?,observed_at=?,attempted_at=?,last_error=NULL
                WHERE id=? AND review!='rejected' AND EXISTS(SELECT 1 FROM source_settings s WHERE s.id=source AND s.enabled AND s.configured)
                RETURNING wish_id").bind(json).bind(t).bind(t).bind(link).fetch_optional(&mut *tx).await?;
            if let Some(id) = wish {
                confirm_discovered(&mut tx, link, &product).await?;
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
        }
        Ok(Work::Search(page)) => {
            let id = job.wish_id.as_ref().expect("search job");
            let found = enqueue_candidates(&mut tx, shop, id, &page.urls, t).await?;
            sqlx::query("UPDATE shop_job SET result_count=CASE WHEN search_page=1 THEN ? ELSE COALESCE(result_count,0)+? END, search_page=? WHERE id=?")
                .bind(found).bind(found).bind(page.next_page.unwrap_or(1)).bind(job.id)
                .execute(&mut *tx).await?;
            set_success(&mut tx, shop, t, false).await?;
        }
        Ok(Work::Discovery(candidates)) => {
            for (url, key) in candidates {
                sqlx::query("INSERT OR IGNORE INTO shop_candidate(source,url,title_key)
                    SELECT ?,?,? WHERE (SELECT count(*) FROM shop_candidate WHERE source=?) < 12000")
                    .bind(shop.id()).bind(url).bind(key).bind(shop.id()).execute(&mut *tx).await?;
            }
            set_success(&mut tx, shop, t, true).await?;
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
        }
    }
    // Observation and outbox commit together. The rule reads the current matches using this transaction.
    if let Some((id, link)) = measured {
        alerts::observe(&mut tx, &id, link, t).await?;
    }
    tx.commit().await?;
    if job.link_id.is_none() && job.wish_id.is_none() {
        attach(pool, shop).await?;
    }
    Ok(true)
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

async fn attach(pool: &SqlitePool, shop: Shop) -> anyhow::Result<()> {
    let active: bool =
        sqlx::query_scalar("SELECT configured AND enabled FROM source_settings WHERE id=?")
            .bind(shop.id())
            .fetch_one(pool)
            .await?;
    if !active {
        return Ok(());
    }
    let ids: Vec<String> = sqlx::query_scalar("SELECT id FROM wishlist_item")
        .fetch_all(pool)
        .await?;
    for id in ids {
        let Ok(wish) = offers::wish(pool, &id).await else {
            continue;
        };
        let keys = wish.keys();
        if keys.is_empty() {
            continue;
        }
        let urls: Vec<String> = sqlx::query_scalar(
            "SELECT url FROM shop_candidate c WHERE source=?
            AND title_key IN (SELECT value FROM json_each(?))
            AND NOT EXISTS(SELECT 1 FROM offer_link l WHERE l.wish_id=? AND l.source=c.source AND l.url=c.url) ORDER BY url",
        )
        .bind(shop.id())
        .bind(serde_json::to_string(&keys)?)
        .bind(&id)
        .fetch_all(pool)
        .await?;
        let mut tx = pool.begin().await?;
        enqueue_candidates(&mut tx, shop, &id, &urls, now()).await?;
        tx.commit().await?;
    }
    Ok(())
}

pub(crate) async fn schedule_wish(pool: &SqlitePool, id: &str) -> sqlx::Result<()> {
    sqlx::query("INSERT OR IGNORE INTO shop_job(source,wish_id,due) SELECT 'eneba',id,? FROM wishlist_item WHERE id=?")
        .bind(now()).bind(id).execute(pool).await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn expired_edition_previews_do_not_use_background_shop_jobs() {
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
        sqlx::query("INSERT INTO wishlist_item VALUES('saved','g',169,0),('preview','g',49,0)")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO edition_preview VALUES('preview',?)")
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
        sqlx::query("UPDATE edition_preview SET viewed_at=?")
            .bind(now())
            .execute(&pool)
            .await
            .unwrap();
        let job = claim(&pool, Shop::Eneba, "active", now(), 120)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(job.wish_id.as_deref(), Some("preview"));
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
        sqlx::query("INSERT INTO wishlist_item VALUES('wish','g',169,0)")
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
        sqlx::query("INSERT INTO wishlist_item VALUES('wish','g',169,0)")
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
        sqlx::query("INSERT INTO wishlist_item VALUES('wish','g',169,0)")
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
        sqlx::query("INSERT INTO wishlist_item VALUES('wish','g',169,0)")
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
}
