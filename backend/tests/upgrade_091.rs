//! K13 / K14 for 1.0: a database as 0.9.1 left it (schema 0027) is backed up, migrated to the current schema and
//! served by the current app with every row intact, confirmed links untouched.
use async_trait::async_trait;
use axum::{
    Router,
    body::{Body, to_bytes},
    http::{Request, StatusCode},
};
use keyhunter::{
    catalog::provider::{CatalogError, CatalogGame, CatalogProvider, ProviderStatus},
    config::Config,
    create_app_with_catalog,
};
use serde_json::{Value, json};
use sqlx::{SqlitePool, sqlite::SqliteConnectOptions};
use std::{path::Path, sync::Arc};
use tower::ServiceExt;

const SESSION: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const CSRF: &str = "csrf-token-of-the-seeded-session";

struct NoCatalog;
#[async_trait]
impl CatalogProvider for NoCatalog {
    async fn search(&self, _: &str, _: i64) -> Result<Vec<CatalogGame>, CatalogError> {
        Err(CatalogError::Unavailable)
    }
    async fn game(&self, _: i64) -> Result<Option<CatalogGame>, CatalogError> {
        Err(CatalogError::Unavailable)
    }
    async fn editions(&self, _: i64) -> Result<Vec<CatalogGame>, CatalogError> {
        Err(CatalogError::Unavailable)
    }
    async fn status(&self) -> ProviderStatus {
        ProviderStatus {
            configured: false,
            state: "not_configured".into(),
            last_success_at: None,
            retry_at: None,
        }
    }
}

fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs() as i64
}

async fn open(path: &Path) -> SqlitePool {
    SqlitePool::connect_with(
        SqliteConnectOptions::new()
            .filename(path)
            .create_if_missing(true)
            .foreign_keys(true),
    )
    .await
    .unwrap()
}

/// The tables the upgrade must not change, as the user left them in 0.9.1 (the log gets an entry of its own, the
/// settings row a new default, and the observations and jobs new columns, each checked separately).
const KEPT: [&str; 17] = [
    "game",
    "wishlist_item",
    "offer_link",
    "offer_link_block",
    "shop_state",
    "source_settings",
    "alert_rule",
    "alert_outbox",
    "channel_delivery",
    "notification_channel",
    "cart_item",
    "edition_watch",
    "job_run",
    "owner",
    "session",
    "shop_candidate",
    "catalog_search",
];

/// Every row of a table as JSON, columns as the table has them now.
async fn rows(pool: &SqlitePool, table: &str, columns: &[String]) -> String {
    let list = columns.join(",");
    sqlx::query_scalar(sqlx::AssertSqlSafe(format!(
        "SELECT COALESCE(json_group_array(json_array({list})),'[]') FROM (SELECT * FROM {table} ORDER BY rowid)"
    )))
    .fetch_one(pool)
    .await
    .unwrap()
}

async fn columns(pool: &SqlitePool, table: &str) -> Vec<String> {
    sqlx::query_scalar(sqlx::AssertSqlSafe(format!(
        "SELECT name FROM pragma_table_info('{table}') ORDER BY cid"
    )))
    .fetch_all(pool)
    .await
    .unwrap()
}

/// A 0.9.1 database: migrations 0001-0027 applied by the real migrator, then filled with every kind of user data.
async fn database_of_091(path: &Path, offers_hidden: &str) {
    let pool = open(path).await;
    sqlx::migrate!("./migrations")
        .run_to(27, &pool)
        .await
        .unwrap();
    let t = now();
    let product = |name: &str, cents: i64| {
        json!({"id":name,"name":name,"title":name,"platform_ids":[169],"key_game":true,"region":"Global",
            "allowed":["DE"],"blocked":[],"purchase_country":"DE","offers":[{"id":"quote","cents":cents,"seller":null}],
            "availability":"in_stock"})
        .to_string()
    };
    let (fp1, fp4) = (fingerprint("Alpha Quest"), fingerprint("Beta Run"));
    let observation = |link: i64, at: i64, market: &str, offers: &str, availability: &str| {
        let fingerprint = if link == 1 { &fp1 } else { &fp4 };
        format!(
            "INSERT INTO price_observation(link_id,product_id,observed_at,market,fingerprint,offers,activation,availability)
            VALUES({link},'p{link}',{at},'{market}','{fingerprint}','{offers}','confirmed','{availability}');"
        )
    };
    let seed = format!(
        "INSERT INTO owner(id,password_hash,created_at) VALUES(1,'not-a-real-hash',{t});
        INSERT INTO session(token_hash,owner_id,csrf_token,created_at,expires_at)
            VALUES('{session}',1,'{CSRF}',{t},{later});
        UPDATE app_settings SET target_country='DE', offers_hidden='{offers_hidden}';
        INSERT INTO game(id,manual_title,manual_key,created_at) VALUES
            ('g1','Alpha Quest','alpha quest',1),('g2','Beta Run','beta run',2),('g3','Gamma Rush','gamma rush',3),
            ('g4','Delta Force','delta force',4),('g5','Epsilon Eve','epsilon eve',5);
        INSERT INTO wishlist_item(id,game_id,platform_id,created_at,state,acquired_at,paused_at,paused_until) VALUES
            ('w1','g1',169,1,'wished',NULL,NULL,NULL),
            ('w2','g2',169,2,'wished',NULL,{t},NULL),
            ('w3','g3',169,3,'preview',NULL,NULL,NULL),
            ('w4','g4',169,4,'owned',{t},NULL,NULL),
            ('w5','g5',169,5,'wished',NULL,NULL,{later});
        INSERT INTO edition_watch VALUES('w1','w3');
        INSERT INTO offer_link(id,wish_id,source,url,review,fingerprint,latest,observed_at,confirmed_name,manual_match,cheap_score,auto_discovered) VALUES
            (1,'w1','eneba','https://www.eneba.com/de/alpha-quest-xbox-key-global','confirmed','{fp1}',?1,{t},'Alpha Quest',1,0.1,0),
            (2,'w1','driffle','https://driffle.com/alpha-quest-xbox-key','pending',NULL,?2,{t},NULL,0,0.5,1),
            (3,'w1','eneba','https://www.eneba.com/de/alpha-quest-xbox-key-pl','rejected',NULL,?2,{t},NULL,0,0.5,1),
            (4,'w2','eneba','https://www.eneba.com/de/beta-run-xbox-key-global','confirmed','{fp4}',?3,{t},'Beta Run',0,0.9,0);
        INSERT INTO offer_link_block VALUES('w1','eneba','https://www.eneba.com/de/blocked',{t});
        INSERT INTO shop_job(source,link_id,due,failures) VALUES('eneba',1,{t},0),('driffle',2,{t},1),('eneba',4,{t},3);
        {obs}
        INSERT INTO alert_rule(wish_id,mode,basis,target_cents,enabled,scope) VALUES('w1','target','base',1500,1,'DE');
        INSERT INTO alert_outbox(id,wish_id,scope,observed_at,cents,due,state,game,mode,basis,reference_cents,shop,region,country,url)
            VALUES(1,'w1','DE',{t},1250,{t},'sent','Alpha Quest','target','base',1500,'eneba','Global','DE','https://www.eneba.com/de/alpha-quest-xbox-key-global');
        INSERT INTO channel_delivery(outbox_id,channel,state,attempts,due,sent_at) VALUES(1,'ntfy','sent',1,{t},{t});
        UPDATE notification_channel SET enabled=1, settings='{{\"topic\":\"beispiel\"}}' WHERE kind='ntfy';
        INSERT INTO cart_item(wish_id,added_at,source,scope) VALUES('w1',{t},'eneba','world');
        INSERT INTO job_run(source,kind,wish_id,link_id,started_at,duration_ms,outcome) VALUES('eneba','product','w1',1,{t},120,'ok');",
        session = hex_digest(SESSION),
        later = t + 86400,
        obs = [
            observation(1, t - 7200, "DE", r#"[{"id":"a","cents":1300},{"id":"b","cents":1250}]"#, "in_stock"),
            observation(1, t - 3600, "DE", r#"[{"id":"a","cents":1250}]"#, "in_stock"),
            observation(1, t - 1800, "PL", r#"[{"id":"a","cents":990}]"#, "in_stock"),
            observation(1, t - 900, "AR", r#"[{"id":"a","cents":0}]"#, "in_stock"),
            observation(4, t - 600, "DE", r#"[{"id":"a","cents":2000}]"#, "sold_out"),
        ]
        .concat(),
    );
    // The three product payloads are bound, everything around the link insert runs as plain SQL.
    let (before_links, after_links) = seed.split_once("INSERT INTO offer_link(").unwrap();
    let (links, rest) = after_links.split_once(";\n").unwrap();
    sqlx::raw_sql(sqlx::AssertSqlSafe(before_links.to_owned()))
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query(sqlx::AssertSqlSafe(format!(
        "INSERT INTO offer_link({links}"
    )))
    .bind(product("Alpha Quest", 1250))
    .bind(product("Alpha Quest PL", 1100))
    .bind(product("Beta Run", 2000))
    .execute(&pool)
    .await
    .unwrap();
    sqlx::raw_sql(sqlx::AssertSqlSafe(rest.to_owned()))
        .execute(&pool)
        .await
        .unwrap();
    pool.close().await;
}

/// The identity of a confirmed product (`Product::fingerprint`): shop product id, key type and platforms.
fn fingerprint(product_id: &str) -> String {
    hex_digest(&json!([2, product_id, true, [169]]).to_string())
}

fn hex_digest(value: &str) -> String {
    use sha2::{Digest, Sha256};
    Sha256::digest(value.as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

async fn get(app: &Router, path: &str) -> (StatusCode, Value) {
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .uri(path)
                .header("Cookie", format!("keyhunter_session={SESSION}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let status = response.status();
    let bytes = to_bytes(response.into_body(), 4 * 1024 * 1024)
        .await
        .unwrap();
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    )
}

/// A data directory holding the seeded 0.9.1 database; nothing has opened it with the current app yet.
async fn seeded(offers_hidden: &str) -> (tempfile::TempDir, Config) {
    let dir = tempfile::tempdir().unwrap();
    let frontend = dir.path().join("frontend");
    std::fs::create_dir(&frontend).unwrap();
    std::fs::write(frontend.join("index.html"), "<title>x</title>").unwrap();
    let config = Config {
        bind: "127.0.0.1:3000".parse().unwrap(),
        origin: Some("http://localhost:3000".into()),
        data_dir: dir.path().join("data"),
        frontend_dir: frontend,
        bootstrap_file: None,
        allow_insecure_http: true,
        trusted_proxies: vec![],
    };
    std::fs::create_dir(&config.data_dir).unwrap();
    database_of_091(&config.data_dir.join("keyhunter.db"), offers_hidden).await;
    (dir, config)
}

async fn start(config: &Config) -> Router {
    create_app_with_catalog(config.clone(), Arc::new(NoCatalog))
        .await
        .unwrap()
}

/// K13 / K14 (release 1.0): the upgrade of a 0.9.1 database keeps all rows and the confirmed links, writes the backup
/// first, backfills 0028 and 0029 and leaves the main read paths working.
#[tokio::test]
async fn k13_k14_database_of_091_upgrades_to_the_current_schema_without_losing_anything() {
    let (_dir, config) = seeded("").await;
    let pool = open(&config.data_dir.join("keyhunter.db")).await;
    let mut before = Vec::new();
    for table in KEPT {
        let cols = columns(&pool, table).await;
        before.push((table, rows(&pool, table, &cols).await, cols));
    }
    let obs_cols = columns(&pool, "price_observation").await;
    let obs_before = rows(&pool, "price_observation", &obs_cols).await;
    let job_cols = columns(&pool, "shop_job").await;
    let jobs_before = rows(&pool, "shop_job", &job_cols).await;
    pool.close().await;

    let app = start(&config).await;
    let pool = open(&config.data_dir.join("keyhunter.db")).await;

    // The copy before the migration exists, is a 0027 database and holds the user's data.
    let backups: Vec<_> = std::fs::read_dir(config.data_dir.join("backups"))
        .unwrap()
        .map(|e| e.unwrap().path())
        .collect();
    assert_eq!(backups.len(), 1, "{backups:?}");
    assert!(
        backups[0]
            .file_name()
            .unwrap()
            .to_str()
            .unwrap()
            .starts_with("keyhunter-schema-0027-")
    );
    let backup = open(&backups[0]).await;
    let wishes: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM wishlist_item")
        .fetch_one(&backup)
        .await
        .unwrap();
    assert_eq!(wishes, 5);
    assert!(
        !columns(&backup, "shop_job")
            .await
            .contains(&"dead_failures".into())
    );
    backup.close().await;
    let logged: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM event_log WHERE message LIKE 'Datenbank vor dem Update gesichert (Schema 27 →%'")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(logged, 1);

    // Nothing of the user's data changed, confirmed links included.
    let version: i64 =
        sqlx::query_scalar("SELECT MAX(version) FROM _sqlx_migrations WHERE success")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert!(version >= 29, "{version}");
    for (table, rows_before, cols) in &before {
        assert_eq!(&rows(&pool, table, cols).await, rows_before, "{table}");
    }
    let confirmed: Vec<(i64, String, Option<String>, i64)> = sqlx::query_as(
        "SELECT id,url,confirmed_name,manual_match FROM offer_link WHERE review='confirmed' ORDER BY id",
    )
    .fetch_all(&pool)
    .await
    .unwrap();
    assert_eq!(
        confirmed,
        [
            (
                1,
                "https://www.eneba.com/de/alpha-quest-xbox-key-global".into(),
                Some("Alpha Quest".into()),
                1
            ),
            (
                4,
                "https://www.eneba.com/de/beta-run-xbox-key-global".into(),
                Some("Beta Run".into()),
                0
            )
        ]
    );
    let reviews: Vec<String> = sqlx::query_scalar("SELECT review FROM offer_link ORDER BY id")
        .fetch_all(&pool)
        .await
        .unwrap();
    assert_eq!(reviews, ["confirmed", "pending", "rejected", "confirmed"]);
    let states: Vec<String> = sqlx::query_scalar("SELECT state FROM wishlist_item ORDER BY id")
        .fetch_all(&pool)
        .await
        .unwrap();
    assert_eq!(states, ["wished", "wished", "preview", "owned", "wished"]);

    // The observations keep every column; 0028 backfills the in-stock minimum, a sold-out row has none.
    assert_eq!(
        rows(&pool, "price_observation", &obs_cols).await,
        obs_before
    );
    let stock: Vec<(String, Option<i64>)> =
        sqlx::query_as("SELECT market,stock_cents FROM price_observation ORDER BY id")
            .fetch_all(&pool)
            .await
            .unwrap();
    assert_eq!(
        stock,
        [
            ("DE".into(), Some(1250)),
            ("DE".into(), Some(1250)),
            ("PL".into(), Some(990)),
            ("AR".into(), None),
            ("DE".into(), None)
        ]
    );
    // The jobs keep every column; 0028 starts every dead-link counter at zero.
    assert_eq!(rows(&pool, "shop_job", &job_cols).await, jobs_before);
    let dead: Vec<i64> =
        sqlx::query_scalar("SELECT dead_failures FROM shop_job WHERE link_id IS NOT NULL")
            .fetch_all(&pool)
            .await
            .unwrap();
    assert_eq!(dead, [0, 0, 0]);
    // 0029: an owner who never hid a column gets the new default, in the same row as the rest of the settings.
    let (target, hidden): (Option<String>, String) =
        sqlx::query_as("SELECT target_country,offers_hidden FROM app_settings")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!((target.as_deref(), hidden.as_str()), (Some("DE"), "score"));
    let integrity: String = sqlx::query_scalar("PRAGMA integrity_check")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(integrity, "ok");
    let broken: Vec<(String,)> = sqlx::query_as("SELECT \"table\" FROM pragma_foreign_key_check")
        .fetch_all(&pool)
        .await
        .unwrap();
    assert!(broken.is_empty(), "{broken:?}");

    // The main read paths of the app on the upgraded database.
    let (status, wishlist) = get(&app, "/api/v1/wishlist").await;
    assert_eq!(status, StatusCode::OK, "{wishlist}");
    let titles: Vec<&str> = wishlist
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|i| i["manual_title"].as_str())
        .collect();
    for title in ["Alpha Quest", "Beta Run", "Epsilon Eve"] {
        assert!(titles.contains(&title), "{titles:?}");
    }
    let (_, library) = get(&app, "/api/v1/library").await;
    assert_eq!(library.as_array().unwrap().len(), 1);
    let (status, badges) = get(&app, "/api/v1/wishlist/price-badges").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(badges["w1"]["state"], "price", "{badges}");
    assert_eq!(badges["w1"]["cents"], 1250);
    let (status, offers) = get(&app, "/api/v1/wishlist/w1/offers").await;
    assert_eq!(status, StatusCode::OK, "{offers}");
    let links = offers["links"].as_array().unwrap();
    assert_eq!(links.len(), 3, "{offers}");
    let review = |id: i64| links.iter().find(|l| l["id"] == id).unwrap()["review"].clone();
    assert_eq!(
        (review(1), review(2), review(3)),
        (json!("confirmed"), json!("pending"), json!("rejected"))
    );
    assert!(
        !offers["histories"]["preferred"]
            .as_array()
            .unwrap()
            .is_empty(),
        "{offers}"
    );
    let (_, paused) = get(&app, "/api/v1/wishlist/w2/offers").await;
    assert_eq!(paused["links"][0]["review"], "confirmed");
    let (_, counts) = get(&app, "/api/v1/counts").await;
    assert_eq!(counts["wishlist"], 3, "{counts}");
    assert_eq!(counts["library"], 1);
    let (status, alerts) = get(&app, "/api/v1/alerts").await;
    assert_eq!(status, StatusCode::OK);
    assert!(alerts.to_string().contains("Alpha Quest"), "{alerts}");
    let (_, cart) = get(&app, "/api/v1/cart").await;
    assert!(cart.to_string().contains("Alpha Quest"), "{cart}");
    let (_, channels) = get(&app, "/api/v1/alerts/channels").await;
    assert!(channels.to_string().contains("ntfy"));
    let (_, settings) = get(&app, "/api/v1/settings").await;
    assert_eq!(settings["offers_hidden"], json!(["score"]));
    assert_eq!(get(&app, "/api/v1/status/fetch").await.0, StatusCode::OK);
}

/// 0029 only replaces the empty choice: an owner who hid columns keeps exactly that.
#[tokio::test]
async fn k13_hidden_offer_columns_chosen_in_091_survive_the_upgrade() {
    let (_dir, config) = seeded("shop,region").await;
    let app = start(&config).await;
    let (_, settings) = get(&app, "/api/v1/settings").await;
    assert_eq!(settings["offers_hidden"], json!(["shop", "region"]));
}
