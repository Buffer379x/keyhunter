//! Migration tests: the embedded migrations applied step by step to databases of older versions.

use sqlx::sqlite::SqlitePoolOptions;

/// Apply the embedded migrations up to `version` (inclusive) as plain SQL.
async fn up_to(pool: &sqlx::SqlitePool, version: i64) {
    for migration in sqlx::migrate!("./migrations").iter() {
        if migration.version <= version {
            sqlx::raw_sql(sqlx::AssertSqlSafe(migration.sql.as_str().to_owned()))
                .execute(pool)
                .await
                .unwrap();
        }
    }
}

async fn legacy_pool() -> sqlx::SqlitePool {
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect("sqlite::memory:")
        .await
        .unwrap();
    up_to(&pool, 11).await;
    sqlx::raw_sql(
            "INSERT INTO game(id,manual_title,manual_key,created_at) VALUES('g','Game','game',0),('h','Other','other',0);
            INSERT INTO wishlist_item(id,game_id,platform_id,created_at) VALUES('wish','g',169,1),('preview','g',49,2),('owned','h',169,3);
            INSERT INTO edition_preview VALUES('preview',20);
            INSERT INTO library_item VALUES('owned',30);
            INSERT INTO edition_watch VALUES('wish','preview');",
        )
        .execute(&pool)
        .await
        .unwrap();
    pool
}

fn item_state_sql() -> String {
    sqlx::migrate!("./migrations")
        .iter()
        .find(|m| m.version == 12)
        .unwrap()
        .sql
        .as_str()
        .to_owned()
}

#[tokio::test]
async fn budget_migration_backfills_valid_prices_and_marks_unsearched_wishes() {
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect("sqlite::memory:")
        .await
        .unwrap();
    up_to(&pool, 13).await;
    let observation = |at: i64, offers: &str, activation: &str, availability: &str| {
        format!("INSERT INTO price_observation(link_id,product_id,observed_at,market,fingerprint,offers,activation,availability)
                VALUES(1,'p',{at},'DE','f','{offers}','{activation}','{availability}');")
    };
    let rows = [
        observation(
            1,
            r#"[{"id":"a","cents":0},{"id":"b","cents":1500},{"id":"c","cents":900}]"#,
            "confirmed",
            "in_stock",
        ),
        observation(2, r#"[{"id":"a","cents":900}]"#, "unknown", "in_stock"),
        observation(3, r#"[]"#, "confirmed", "sold_out"),
    ];
    sqlx::raw_sql(sqlx::AssertSqlSafe(format!(
            "INSERT INTO game(id,manual_title,manual_key,created_at) VALUES('g','Game','game',0);
            INSERT INTO wishlist_item(id,game_id,platform_id,created_at) VALUES('new','g',169,0),('old','g',49,0);
            INSERT INTO offer_link(id,wish_id,source,url) VALUES(1,'new','eneba','https://www.eneba.com/de/xbox-game-key');
            INSERT INTO shop_job(source,wish_id,due) VALUES('eneba','new',0);
            INSERT INTO shop_job(source,wish_id,due,checked_at) VALUES('eneba','old',0,5);
            {}",
            rows.concat()
        )))
        .execute(&pool)
        .await
        .unwrap();
    up_to_only(&pool, 14).await;
    sqlx::raw_sql(sqlx::AssertSqlSafe(observation(
        4,
        r#"[{"id":"a","cents":700},{"id":"b","cents":20000000}]"#,
        "confirmed",
        "in_stock",
    )))
    .execute(&pool)
    .await
    .unwrap();
    let cents: Vec<Option<i64>> =
        sqlx::query_scalar("SELECT valid_cents FROM price_observation ORDER BY observed_at")
            .fetch_all(&pool)
            .await
            .unwrap();
    assert_eq!(cents, [Some(900), None, None, Some(700)]);
    let initial: Vec<(String, i64)> = sqlx::query_as(
        "SELECT wish_id,initial FROM shop_job WHERE wish_id IS NOT NULL ORDER BY wish_id",
    )
    .fetch_all(&pool)
    .await
    .unwrap();
    assert_eq!(initial, [("new".into(), 1), ("old".into(), 0)]);
}

/// 0.9.3 (FUNC-02, FUNC-13): stock prices for old and new observations, whatever their activation; the trend
/// index reads them; the dead-link count starts at zero.
#[tokio::test]
async fn release_093_migration_backfills_stock_prices_and_counts_dead_links() {
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect("sqlite::memory:")
        .await
        .unwrap();
    up_to(&pool, 27).await;
    let observation = |at: i64, offers: &str, activation: &str, availability: &str| {
        format!("INSERT INTO price_observation(link_id,product_id,observed_at,market,fingerprint,offers,activation,availability)
                VALUES(1,'p',{at},'DE','f','{offers}','{activation}','{availability}');")
    };
    sqlx::raw_sql(sqlx::AssertSqlSafe(format!(
            "INSERT INTO game(id,manual_title,manual_key,created_at) VALUES('g','Game','game',0);
            INSERT INTO wishlist_item(id,game_id,platform_id,created_at) VALUES('w','g',169,0);
            INSERT INTO offer_link(id,wish_id,source,url) VALUES(1,'w','eneba','https://www.eneba.com/de/xbox-game-key');
            INSERT INTO shop_job(source,link_id,due) VALUES('eneba',1,0);
            {}{}",
            observation(1, r#"[{"id":"a","cents":0},{"id":"b","cents":1500}]"#, "confirmed", "in_stock"),
            observation(2, r#"[{"id":"a","cents":900}]"#, "unknown", "in_stock"),
        )))
        .execute(&pool)
        .await
        .unwrap();
    up_to_only(&pool, 28).await;
    sqlx::raw_sql(sqlx::AssertSqlSafe(format!(
        "{}{}",
        observation(3, r#"[{"id":"a","cents":700}]"#, "blocked", "in_stock"),
        observation(4, r#"[{"id":"a","cents":700}]"#, "confirmed", "sold_out"),
    )))
    .execute(&pool)
    .await
    .unwrap();
    let cents: Vec<(Option<i64>, Option<i64>)> = sqlx::query_as(
        "SELECT valid_cents,stock_cents FROM price_observation ORDER BY observed_at",
    )
    .fetch_all(&pool)
    .await
    .unwrap();
    assert_eq!(
        cents,
        [
            (Some(1500), Some(1500)),
            (None, Some(900)),
            (None, Some(700)),
            (None, None)
        ]
    );
    let columns: Vec<String> =
        sqlx::query_scalar("SELECT name FROM pragma_index_info('price_history') ORDER BY seqno")
            .fetch_all(&pool)
            .await
            .unwrap();
    assert_eq!(
        columns,
        [
            "link_id",
            "fingerprint",
            "observed_at",
            "market",
            "valid_cents",
            "stock_cents"
        ]
    );
    let dead: i64 = sqlx::query_scalar("SELECT dead_failures FROM shop_job")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(dead, 0);
}

/// Apply exactly one embedded migration as plain SQL.
async fn up_to_only(pool: &sqlx::SqlitePool, version: i64) {
    let migrator = sqlx::migrate!("./migrations");
    let migration = migrator.iter().find(|m| m.version == version).unwrap();
    sqlx::raw_sql(sqlx::AssertSqlSafe(migration.sql.as_str().to_owned()))
        .execute(pool)
        .await
        .unwrap();
}

#[tokio::test]
async fn item_state_migration_moves_previews_and_library_into_one_column() {
    let pool = legacy_pool().await;
    sqlx::raw_sql(sqlx::AssertSqlSafe(item_state_sql()))
        .execute(&pool)
        .await
        .unwrap();
    let rows: Vec<(String, String, Option<i64>, Option<i64>)> = sqlx::query_as(
        "SELECT id,state,viewed_at,acquired_at FROM wishlist_item ORDER BY created_at",
    )
    .fetch_all(&pool)
    .await
    .unwrap();
    assert_eq!(
        rows,
        [
            ("wish".into(), "wished".into(), None, None),
            ("preview".into(), "preview".into(), Some(20), None),
            ("owned".into(), "owned".into(), None, Some(30)),
        ]
    );
    let side_tables: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM sqlite_master WHERE name IN ('edition_preview','library_item')",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(side_tables, 0);
    let watches: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM edition_watch")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(watches, 1);
}

#[tokio::test]
async fn pending_migrations_back_up_the_database_and_keep_three_copies() {
    let dir = tempfile::tempdir().unwrap();
    let pool = SqlitePoolOptions::new()
        .connect_with(
            sqlx::sqlite::SqliteConnectOptions::new()
                .filename(dir.path().join("keyhunter.db"))
                .create_if_missing(true),
        )
        .await
        .unwrap();
    let migrator = sqlx::migrate!("./migrations");
    // A fresh database has nothing to protect.
    super::backup_before_migration(&pool, &migrator, dir.path())
        .await
        .unwrap();
    assert!(!dir.path().join("backups").exists());
    sqlx::raw_sql("CREATE TABLE _sqlx_migrations(version INTEGER, success BOOLEAN); INSERT INTO _sqlx_migrations VALUES(11,1); CREATE TABLE marker(v); INSERT INTO marker VALUES('kept');")
            .execute(&pool)
            .await
            .unwrap();
    for _ in 0..4 {
        super::backup_before_migration(&pool, &migrator, dir.path())
            .await
            .unwrap();
        tokio::time::sleep(std::time::Duration::from_millis(3)).await;
    }
    let mut copies: Vec<_> = std::fs::read_dir(dir.path().join("backups"))
        .unwrap()
        .map(|e| e.unwrap().path())
        .collect();
    copies.sort();
    assert_eq!(copies.len(), 3);
    assert!(
        copies[0]
            .file_name()
            .unwrap()
            .to_str()
            .unwrap()
            .starts_with("keyhunter-schema-0011-")
    );
    let copy = SqlitePoolOptions::new()
        .connect_with(sqlx::sqlite::SqliteConnectOptions::new().filename(&copies[2]))
        .await
        .unwrap();
    let marker: String = sqlx::query_scalar("SELECT v FROM marker")
        .fetch_one(&copy)
        .await
        .unwrap();
    assert_eq!(marker, "kept");
    // Up to date: no further copy.
    sqlx::query("UPDATE _sqlx_migrations SET version=?")
        .bind(migrator.iter().map(|m| m.version).max().unwrap())
        .execute(&pool)
        .await
        .unwrap();
    super::backup_before_migration(&pool, &migrator, dir.path())
        .await
        .unwrap();
    assert_eq!(
        std::fs::read_dir(dir.path().join("backups"))
            .unwrap()
            .count(),
        3
    );
}

/// 0.9.0: an alert waiting at the update keeps what its message needs, and ntfy stays switched on for an
/// existing ntfy file. Applied after every earlier migration (0026 included).
#[tokio::test]
async fn channel_migration_keeps_waiting_alerts_and_the_ntfy_switch() {
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect("sqlite::memory:")
        .await
        .unwrap();
    up_to(&pool, 26).await;
    sqlx::raw_sql(
            "INSERT INTO game(id,manual_title,manual_key,created_at) VALUES('g','Halo','halo',0);
            INSERT INTO wishlist_item(id,game_id,platform_id,created_at) VALUES('wish','g',169,1);
            INSERT INTO alert_rule(wish_id,mode,basis,target_cents,enabled) VALUES('wish','target','estimate',1999,1);
            INSERT INTO alert_outbox(wish_id,scope,observed_at,cents,message,due) VALUES('wish','s',5,1900,'KeyHunter: Halo',5);
            INSERT INTO alert_outbox(observed_at,message,due) VALUES(6,'KeyHunter: Testnachricht',6);",
        )
        .execute(&pool)
        .await
        .unwrap();
    up_to_only(&pool, 27).await;
    let rows: Vec<String> = sqlx::query_scalar(
        "SELECT json_array(game,mode,basis,reference_cents) FROM alert_outbox ORDER BY id",
    )
    .fetch_all(&pool)
    .await
    .unwrap();
    assert_eq!(
        rows,
        [
            r#"["Halo","target","estimate",1999]"#,
            "[null,null,null,null]"
        ]
    );
    let message: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM pragma_table_info('alert_outbox') WHERE name='message'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(message, 0);
    let switches: Vec<(String, bool)> =
        sqlx::query_as("SELECT kind,enabled FROM notification_channel WHERE enabled")
            .fetch_all(&pool)
            .await
            .unwrap();
    assert_eq!(switches, [("ntfy".into(), true)]);
}

#[tokio::test]
async fn item_state_migration_refuses_contradictory_rows() {
    let pool = legacy_pool().await;
    sqlx::query("INSERT INTO library_item VALUES('preview',40)")
        .execute(&pool)
        .await
        .unwrap();
    let mut tx = pool.begin().await.unwrap();
    assert!(
        sqlx::raw_sql(sqlx::AssertSqlSafe(item_state_sql()))
            .execute(&mut *tx)
            .await
            .is_err()
    );
    tx.rollback().await.unwrap();
    let previews: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM edition_preview")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(previews, 1, "the old tables stay untouched");
}

/// 0.8.1: the rebuilt wishlist table keeps every row and every reference, takes Xbox 360 and the
/// original Xbox, still cascades, and cart entries start with the cheapest shop of any region.
#[tokio::test]
async fn platform_rebuild_keeps_all_references_and_accepts_older_xbox_systems() {
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(
            "sqlite::memory:"
                .parse::<sqlx::sqlite::SqliteConnectOptions>()
                .unwrap()
                .foreign_keys(true),
        )
        .await
        .unwrap();
    up_to(&pool, 22).await;
    sqlx::raw_sql(
            "INSERT INTO game(id,manual_title,manual_key,created_at) VALUES('g','Game','game',0),('h','Other','other',0);
            INSERT INTO wishlist_item(id,game_id,platform_id,created_at,state,acquired_at) VALUES('wish','g',169,1,'wished',NULL),('preview','g',49,2,'preview',NULL),('owned','h',169,3,'owned',9);
            INSERT INTO offer_link(id,wish_id,source,url) VALUES(1,'wish','eneba','https://www.eneba.com/de/xbox-game-key');
            INSERT INTO price_observation(link_id,product_id,observed_at,market,fingerprint,offers,activation,availability) VALUES(1,'p',1,'DE','f','[]','unknown','in_stock');
            INSERT INTO alert_rule(wish_id,mode,basis,target_cents,enabled) VALUES('wish','target','base',1000,1);
            INSERT INTO edition_watch VALUES('wish','preview');
            INSERT INTO cart_item(wish_id,added_at) VALUES('wish',5);",
        )
        .execute(&pool)
        .await
        .unwrap();
    up_to_only(&pool, 23).await;
    let rows: Vec<(String, i64, String, Option<i64>)> = sqlx::query_as(
        "SELECT id,platform_id,state,acquired_at FROM wishlist_item ORDER BY created_at",
    )
    .fetch_all(&pool)
    .await
    .unwrap();
    assert_eq!(
        rows,
        [
            ("wish".into(), 169, "wished".into(), None),
            ("preview".into(), 49, "preview".into(), None),
            ("owned".into(), 169, "owned".into(), Some(9))
        ]
    );
    let broken: Vec<(String,)> = sqlx::query_as("PRAGMA foreign_key_check")
        .fetch_all(&pool)
        .await
        .unwrap();
    assert!(broken.is_empty(), "{broken:?}");
    let cart: (Option<String>, String) =
        sqlx::query_as("SELECT source,scope FROM cart_item WHERE wish_id='wish'")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(cart, (None, "world".into()));
    for platform in [12, 11] {
        sqlx::query(
            "INSERT INTO wishlist_item(id,game_id,platform_id,created_at) VALUES(?,'h',?,4)",
        )
        .bind(format!("old-{platform}"))
        .bind(platform)
        .execute(&pool)
        .await
        .unwrap();
    }
    assert!(
        sqlx::query(
            "INSERT INTO wishlist_item(id,game_id,platform_id,created_at) VALUES('pc','h',6,4)"
        )
        .execute(&pool)
        .await
        .is_err(),
        "PC stays out"
    );
    // Deleting a wish still removes what hangs on it.
    sqlx::query("DELETE FROM wishlist_item WHERE id='wish'")
        .execute(&pool)
        .await
        .unwrap();
    for table in [
        "offer_link",
        "price_observation",
        "alert_rule",
        "edition_watch",
        "cart_item",
    ] {
        let count: i64 =
            sqlx::query_scalar(sqlx::AssertSqlSafe(format!("SELECT COUNT(*) FROM {table}")))
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(count, 0, "{table}");
    }
}
