//! Links the products a search or a discovery found to the wishes, and queues the searches of new wishes.

use crate::{
    eventlog::{self, Area, Level},
    now, offers,
    shops::{Product, Shop},
};
use sqlx::SqlitePool;

pub(super) async fn attach_failed(pool: &SqlitePool, shop: Shop, error: &anyhow::Error) {
    tracing::warn!(source = shop.id(), %error, "Candidate attachment failed");
    eventlog::record_once(
        pool,
        Level::Warn,
        Area::Fetch,
        format!(
            "{}: Gefundene Angebote konnten nicht zugeordnet werden",
            shop.name()
        ),
        eventlog::REPEAT,
    )
    .await;
}

/// Persist every discovered region; each product gets its own budgeted, retryable job.
/// `initial` marks new jobs as the first fetch of a direct user action (module docs).
pub(super) async fn enqueue_candidates(
    conn: &mut sqlx::SqliteConnection,
    shop: Shop,
    id: &str,
    urls: &[String],
    t: i64,
    initial: bool,
) -> sqlx::Result<i64> {
    let mut found = 0;
    // One game per product (1.1.4): the search leaves a product out that another wish holds already.
    let assigned = offers::assignments(&mut *conn).await?;
    for raw in urls {
        let Some(url) = shop.product_url(raw) else {
            continue;
        };
        if !offers::elsewhere(&assigned, id, shop.id(), url.as_str()).is_empty()
            && !offers::holds(&assigned, id, shop.id(), url.as_str())
        {
            continue;
        }
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

pub(super) async fn confirm_discovered(
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
    let Some(wish) = wish else {
        return Ok(());
    };
    // FUNC-01: a same-titled game of another year in the catalog leaves the product for the owner to check.
    let peers = offers::peers(&mut *conn, &wish).await?;
    if wish.auto_matches(product, &peers) {
        sqlx::query("UPDATE offer_link SET review='confirmed',fingerprint=?,confirmed_name=? WHERE id=? AND review='pending'")
            .bind(product.fingerprint()).bind(&product.name).bind(link).execute(conn).await?;
    }
    Ok(())
}

/// Attach indexed candidates to every non-owned item (after start and after discovery).
pub(super) async fn attach(pool: &SqlitePool, shop: Shop) -> anyhow::Result<()> {
    let ids: Vec<String> = sqlx::query_scalar(
        "SELECT id FROM wishlist_item w WHERE w.state!='owned' ORDER BY created_at,id",
    )
    .fetch_all(pool)
    .await?;
    attach_items(pool, shop, &ids, false).await
}

/// Attach indexed candidates to one item (when it is saved, restored or previewed);
/// `initial` when a user action asked for it.
async fn attach_wish(pool: &SqlitePool, shop: Shop, id: &str, initial: bool) -> anyhow::Result<()> {
    attach_items(pool, shop, &[id.to_string()], initial).await
}

/// Links the indexed candidates of the shop whose title keys fit an item to that item, with the same few queries
/// for one item or the whole wishlist (PERF-08). Items that are gone are skipped.
async fn attach_items(
    pool: &SqlitePool,
    shop: Shop,
    ids: &[String],
    initial: bool,
) -> anyhow::Result<()> {
    let active: bool =
        sqlx::query_scalar("SELECT configured AND enabled FROM source_settings WHERE id=?")
            .bind(shop.id())
            .fetch_one(pool)
            .await?;
    if !active || ids.is_empty() {
        return Ok(());
    }
    let ids_json = serde_json::to_string(ids)?;
    // In the order of `ids` (the oldest wish first): of two wishes a new product fits, the older one gets it (1.1.4).
    let mut wishes = offers::wishes(pool, &ids_json).await?;
    let keys: Vec<(String, Vec<String>)> = ids
        .iter()
        .filter_map(|id| Some((id.clone(), shop.candidate_keys(wishes.remove(id)?.keys()))))
        .filter(|(_, keys)| !keys.is_empty())
        .collect();
    let wanted: std::collections::BTreeSet<&String> =
        keys.iter().flat_map(|(_, keys)| keys).collect();
    if wanted.is_empty() {
        return Ok(());
    }
    let candidates: Vec<(String, String)> = sqlx::query_as(
        "SELECT title_key,url FROM shop_candidate WHERE source=? AND title_key IN (SELECT value FROM json_each(?)) ORDER BY url",
    )
    .bind(shop.id())
    .bind(serde_json::to_string(&wanted)?)
    .fetch_all(pool)
    .await?;
    let linked: std::collections::BTreeSet<(String, String)> = sqlx::query_as(
        "SELECT wish_id,url FROM offer_link WHERE source=? AND wish_id IN (SELECT value FROM json_each(?))",
    )
    .bind(shop.id())
    .bind(&ids_json)
    .fetch_all(pool)
    .await?
    .into_iter()
    .collect();
    let t = now();
    let mut tx = pool.begin().await?;
    for (id, keys) in &keys {
        let urls: Vec<String> = candidates
            .iter()
            .filter(|(key, url)| keys.contains(key) && !linked.contains(&(id.clone(), url.clone())))
            .map(|(_, url)| url.clone())
            .collect();
        if !urls.is_empty() {
            enqueue_candidates(&mut tx, shop, id, &urls, t, initial).await?;
        }
    }
    tx.commit().await?;
    Ok(())
}

/// Queue the search of an item in the caller's transaction, so a wish never exists without one (P3). `direct` marks it
/// as a direct user action (module docs); the search of an imported wish is not one.
pub(crate) async fn queue_search(
    conn: &mut sqlx::SqliteConnection,
    id: &str,
    direct: bool,
) -> sqlx::Result<()> {
    for shop in Shop::ALL.into_iter().filter(|shop| shop.searches()) {
        sqlx::query("INSERT OR IGNORE INTO shop_job(source,wish_id,due,initial) SELECT ?,id,?,? FROM wishlist_item w WHERE id=? AND w.state!='owned'")
            .bind(shop.id()).bind(now()).bind(direct).bind(id).execute(&mut *conn).await?;
    }
    Ok(())
}

/// Link the indexed candidates of every shop to an item; `direct` as for [`queue_search`]. A failure or an
/// interrupted request is no loss: the next start or discovery attaches them again.
pub(crate) async fn attach_candidates(pool: &SqlitePool, id: &str, direct: bool) {
    for shop in Shop::ALL {
        if let Err(error) = attach_wish(pool, shop, id, direct).await {
            attach_failed(pool, shop, &error).await;
        }
    }
}

/// Queue the search and the indexed candidates of an item a user saved, restored, refreshed
/// or previewed. New jobs are direct user actions (they bypass pacing only for wishes).
pub(crate) async fn schedule_wish(pool: &SqlitePool, id: &str) -> sqlx::Result<()> {
    queue_search(&mut *pool.acquire().await?, id, true).await?;
    attach_candidates(pool, id, true).await;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::jobs::{tests::*, *};
    use serde_json::json;
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
            platform_unknown: false,
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

    /// PERF-08: attaching the indexed candidates (the catch-up after every start) reads with a constant number of
    /// statements, whether the wishlist holds one wish or fifty.
    #[tokio::test]
    async fn attaching_candidates_uses_the_same_statements_for_one_and_for_fifty_wishes_perf08() {
        use std::sync::{
            Mutex,
            atomic::{AtomicUsize, Ordering},
        };
        // sqlx logs each statement from the worker thread of its connection. A marker statement tells which thread is
        // the one of the test's pool, so concurrent tests do not count.
        static WORKER: Mutex<Option<std::thread::ThreadId>> = Mutex::new(None);
        static STATEMENTS: AtomicUsize = AtomicUsize::new(0);
        struct Counter;
        struct Marked(bool);
        impl tracing::field::Visit for Marked {
            fn record_debug(&mut self, field: &tracing::field::Field, value: &dyn std::fmt::Debug) {
                self.0 |=
                    field.name() == "summary" && format!("{value:?}").contains("perf08_marker");
            }
        }
        impl<S: tracing::Subscriber> tracing_subscriber::Layer<S> for Counter {
            fn on_event(
                &self,
                event: &tracing::Event<'_>,
                _: tracing_subscriber::layer::Context<'_, S>,
            ) {
                if event.metadata().target() != "sqlx::query" {
                    return;
                }
                let mut marked = Marked(false);
                event.record(&mut marked);
                let mut worker = WORKER.lock().unwrap();
                if marked.0 {
                    *worker = Some(std::thread::current().id());
                } else if *worker == Some(std::thread::current().id()) {
                    STATEMENTS.fetch_add(1, Ordering::SeqCst);
                }
            }
        }
        tracing::subscriber::set_global_default(tracing_subscriber::layer::SubscriberExt::with(
            tracing_subscriber::registry(),
            Counter,
        ))
        .unwrap();
        let mut counts = vec![];
        for wishes in [1, 50] {
            let pool = sqlx::sqlite::SqlitePoolOptions::new()
                .max_connections(1)
                .connect("sqlite::memory:")
                .await
                .unwrap();
            sqlx::migrate!("./migrations").run(&pool).await.unwrap();
            sqlx::query("SELECT 1 AS perf08_marker")
                .execute(&pool)
                .await
                .unwrap();
            for n in 1..=wishes {
                sqlx::query(
                    "INSERT INTO game(id,manual_title,manual_key,created_at) VALUES(?1,?2,?3,0)",
                )
                .bind(format!("g{n}"))
                .bind(format!("Forza Horizon {n}"))
                .bind(format!("forza horizon {n}"))
                .execute(&pool)
                .await
                .unwrap();
                sqlx::query("INSERT INTO wishlist_item(id,game_id,platform_id,created_at) VALUES(?1,?1,169,0)")
                    .bind(format!("g{n}")).execute(&pool).await.unwrap();
                sqlx::query("INSERT INTO shop_candidate(source,url,title_key) VALUES('eneba',?,?)")
                    .bind(format!(
                        "https://www.eneba.com/de/xbox-forza-horizon-{n}-xbox-live-key-global"
                    ))
                    .bind(format!("forza horizon {n}"))
                    .execute(&pool)
                    .await
                    .unwrap();
            }
            attach(&pool, Shop::Eneba).await.unwrap();
            let links: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM offer_link")
                .fetch_one(&pool)
                .await
                .unwrap();
            assert_eq!(links, wishes, "every wish got its candidate");
            // Everything is linked now: the catch-up of the next start only reads.
            let before = STATEMENTS.load(Ordering::SeqCst);
            attach(&pool, Shop::Eneba).await.unwrap();
            counts.push(STATEMENTS.load(Ordering::SeqCst) - before);
        }
        assert!(counts[0] > 0, "the counter sees no statements");
        assert_eq!(
            counts[0], counts[1],
            "statements for one and for fifty wishes"
        );
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

    /// 1.1.4: a product belongs to one game of the list. The search leaves a product out that another wish holds, and gives
    /// it to the next one once the first sets it aside.
    #[tokio::test]
    async fn the_search_gives_a_product_to_one_wish_only() {
        let pool = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        sqlx::migrate!("./migrations").run(&pool).await.unwrap();
        sqlx::query("INSERT INTO game(id,manual_title,manual_key,created_at) VALUES('g','Forza Horizon 5','forza horizon 5',0)").execute(&pool).await.unwrap();
        for (id, platform, at) in [("series", 169, 1), ("one", 49, 2)] {
            sqlx::query(
                "INSERT INTO wishlist_item(id,game_id,platform_id,created_at) VALUES(?,'g',?,?)",
            )
            .bind(id)
            .bind(platform)
            .bind(at)
            .execute(&pool)
            .await
            .unwrap();
        }
        let url = "https://www.eneba.com/de/xbox-forza-horizon-5-xbox-live-key-global";
        sqlx::query(
            "INSERT INTO shop_candidate(source,url,title_key) VALUES('eneba',?,'forza horizon 5')",
        )
        .bind(url)
        .execute(&pool)
        .await
        .unwrap();
        let holders = || async {
            sqlx::query_scalar::<_, String>(
                "SELECT wish_id FROM offer_link WHERE review!='rejected' ORDER BY id",
            )
            .fetch_all(&pool)
            .await
            .unwrap()
        };
        attach(&pool, Shop::Eneba).await.unwrap();
        attach(&pool, Shop::Eneba).await.unwrap();
        assert_eq!(holders().await, ["series"]);
        sqlx::query("UPDATE offer_link SET review='rejected' WHERE wish_id='series'")
            .execute(&pool)
            .await
            .unwrap();
        attach(&pool, Shop::Eneba).await.unwrap();
        assert_eq!(holders().await, ["one"]);
    }

    /// FUNC-01: a same-titled game of another year keeps a found product pending, and the update leaves every mapping
    /// a 0.9.2 database confirmed exactly as it was, also after new observations through the new code.
    #[tokio::test]
    async fn same_titled_games_wait_for_review_and_confirmed_links_keep_their_state_func01() {
        let pool = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        let migrator = sqlx::migrate!("./migrations");
        for migration in migrator.iter().filter(|m| m.version <= 27) {
            sqlx::raw_sql(AssertSqlSafe(migration.sql.as_str().to_owned()))
                .execute(&pool)
                .await
                .unwrap();
        }
        let game = |id: i64, year: i64| {
            json!({"igdb_id":id,"name":"Doom","slug":null,"summary":null,"first_release_date":year,
                "platforms":[{"id":49,"name":"Xbox One"},{"id":6,"name":"PC"}],"aliases":[],"cover_url":null,
                "version_parent":null,"edition_name":null,"kind":"base_game","fetched_at":0})
            .to_string()
        };
        // Doom (1993, 10 Dec) is wished; the catalog also knows Doom (2016, 13 May) from the same search.
        let doom = |key_game: bool| Product {
            id: "doom".into(),
            name: "DOOM XBOX LIVE Key EUROPE".into(),
            title: "doom".into(),
            platform_ids: vec![49],
            platform_unknown: false,
            key_game,
            region: Some("Europe".into()),
            allowed: vec!["DE".into()],
            blocked: vec![],
            purchase_country: Some("DE".into()),
            offers: vec![crate::shops::Quote {
                id: "q".into(),
                cents: 999,
                seller: None,
            }],
            availability: Availability::InStock,
        };
        let (key, account) = (doom(true), doom(false));
        sqlx::raw_sql(AssertSqlSafe(format!(
            "INSERT INTO catalog_game VALUES(1,'{}',0),(2,'{}',0);
            INSERT INTO game(id,igdb_id,created_at) VALUES('g',1,0);
            INSERT INTO wishlist_item(id,game_id,platform_id,created_at) VALUES('w','g',49,0);
            INSERT INTO offer_link(id,wish_id,source,url,review,auto_discovered,fingerprint,latest,manual_match) VALUES
                (1,'w','eneba','https://www.eneba.com/de/xbox-doom-key-1','confirmed',1,'{fp}','{json}',0),
                (2,'w','eneba','https://www.eneba.com/de/xbox-doom-key-2','pending',1,NULL,'{json}',0),
                (3,'w','eneba','https://www.eneba.com/de/xbox-doom-key-3','confirmed',0,'{afp}','{ajson}',1);
            INSERT INTO shop_job(source,link_id,due) VALUES('eneba',1,0),('eneba',2,0),('eneba',3,0);",
            game(1, 755_481_600),
            game(2, 1_463_097_600),
            fp = key.fingerprint(),
            json = serde_json::to_string(&key).unwrap(),
            afp = account.fingerprint(),
            ajson = serde_json::to_string(&account).unwrap(),
        )))
        .execute(&pool)
        .await
        .unwrap();
        let reviews = || {
            let pool = pool.clone();
            async move {
                sqlx::query_as::<_, (i64, String, Option<String>, bool)>(
                    "SELECT id,review,fingerprint,manual_match FROM offer_link ORDER BY id",
                )
                .fetch_all(&pool)
                .await
                .unwrap()
            }
        };
        let before = reviews().await;
        let update = migrator.iter().find(|m| m.version == 28).unwrap();
        sqlx::raw_sql(AssertSqlSafe(update.sql.as_str().to_owned()))
            .execute(&pool)
            .await
            .unwrap();
        let t = now();
        for (link, product) in [(1, &key), (2, &key), (3, &account)] {
            finish(&pool, link, Ok(Work::Product(Box::new(product.clone()))), t).await;
        }
        assert_eq!(reviews().await, before, "no mapping changed its review");
        assert_eq!(
            before[1].1, "pending",
            "the ambiguous Doom waits for the owner"
        );
        let Ok(wish) = offers::wish(&pool, "w").await else {
            panic!("the wish")
        };
        let links = offers::links(&pool, "w", t).await.unwrap();
        assert!(
            links[0].confirmed(&wish, &key),
            "the confirmed Doom still counts"
        );
        let verdict = crate::pricing::evaluate(
            &links[2],
            &wish,
            Some(&account),
            &crate::pricing::Scope::AllRegions,
            t,
        );
        assert!(
            verdict.has(crate::pricing::Reason::NotAKey) && !verdict.eligible(),
            "an account confirmed by hand stays confirmed, but its price never counts (FUNC-04)"
        );
        // Without the other Doom in the catalog the same product is confirmed automatically, as before.
        sqlx::query("DELETE FROM catalog_game WHERE igdb_id=2")
            .execute(&pool)
            .await
            .unwrap();
        let mut conn = pool.acquire().await.unwrap();
        confirm_discovered(&mut conn, 2, &key).await.unwrap();
        let review: String = sqlx::query_scalar("SELECT review FROM offer_link WHERE id=2")
            .fetch_one(&mut *conn)
            .await
            .unwrap();
        assert_eq!(review, "confirmed");
    }
}
