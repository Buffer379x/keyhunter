use crate::{
    alerts, now, offers, random_token,
    shops::{Product, Shop, ShopError},
};
use serde_json::Value;
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
        WHERE j.source=? AND s.enabled AND p.retry_at<=? AND (p.budget_day!=? OR p.jobs_today<?)
        AND j.due<=? AND j.lease_until<=? AND (j.link_id IS NULL OR l.review!='rejected')
        AND EXISTS(SELECT 1 FROM wishlist_item))",
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
        WHERE j.source=? AND s.enabled AND p.retry_at<=? AND j.due<=? AND j.lease_until<=?
        AND (p.budget_day!=? OR p.jobs_today<?)
        AND (j.link_id IS NULL OR l.review!='rejected')
        AND NOT EXISTS(SELECT 1 FROM shop_job running WHERE running.source=j.source AND running.lease_until>?)
        AND EXISTS(SELECT 1 FROM wishlist_item)
        ORDER BY j.due,(j.link_id IS NULL),j.id LIMIT 1)
        RETURNING id,link_id,failures")
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
}

async fn run_one(pool: &SqlitePool, shop: Shop, budget: i64) -> anyhow::Result<bool> {
    let token = random_token()?;
    let Some(job) = claim(pool, shop, &token, now(), budget).await? else {
        return Ok(false);
    };
    let result = if let Some(link) = job.link_id {
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
    let (due, failures) = match &result {
        Ok(Work::Product(_)) => (t + INTERVAL, 0),
        Ok(Work::Discovery(_)) => (t + DAY, 0),
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

    let mut measured = None;
    match result {
        Ok(Work::Product(product)) => {
            let link = job.link_id.expect("product job");
            let json = serde_json::to_string(&product)?;
            let wish: Option<String> = sqlx::query_scalar("UPDATE offer_link SET latest=?,observed_at=?,attempted_at=?,last_error=NULL
                WHERE id=? AND review!='rejected' AND EXISTS(SELECT 1 FROM source_settings s WHERE s.id=source AND s.enabled)
                RETURNING wish_id").bind(json).bind(t).bind(t).bind(link).fetch_optional(&mut *tx).await?;
            if let Some(id) = wish {
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
    if job.link_id.is_none() {
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

async fn attach(pool: &SqlitePool, shop: Shop) -> anyhow::Result<()> {
    let ids: Vec<String> = sqlx::query_scalar(
        "SELECT id FROM wishlist_item WHERE
        (SELECT count(*) FROM offer_link WHERE wish_id=wishlist_item.id) < 12",
    )
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
        let keys = Value::from(keys).to_string();
        let mut tx = pool.begin().await?;
        let links: Vec<i64> = sqlx::query_scalar("INSERT INTO offer_link(wish_id,source,url)
            SELECT w.id,c.source,c.url FROM shop_candidate c JOIN wishlist_item w ON w.id=?
            WHERE c.source=? AND c.title_key IN (SELECT value FROM json_each(?))
            AND NOT EXISTS(SELECT 1 FROM offer_link l WHERE l.wish_id=w.id AND l.source=c.source AND l.url=c.url)
            AND (SELECT count(*) FROM offer_link WHERE wish_id=w.id AND source=c.source)<6
            AND (SELECT count(*) FROM offer_link WHERE wish_id=w.id)<12
            ORDER BY CASE WHEN c.url LIKE '%global%' THEN 0 WHEN c.url LIKE '%europe%' THEN 1 ELSE 2 END,c.url
            LIMIT 2 ON CONFLICT DO NOTHING RETURNING id")
            .bind(id).bind(shop.id()).bind(keys).fetch_all(&mut *tx).await?;
        for link in links {
            sqlx::query("INSERT INTO shop_job(source,link_id,due) VALUES(?,?,?)")
                .bind(shop.id())
                .bind(link)
                .bind(now())
                .execute(&mut *tx)
                .await?;
        }
        tx.commit().await?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
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
