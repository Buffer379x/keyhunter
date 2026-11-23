//! CODE-08: the number of SQL statements of the list endpoints must not grow with the size of the list. Each
//! statement is an `sqlx::query` event; a counting subscriber compares a database with one wish and one link with one
//! holding 50 wishes, one of them with 50 links.
use async_trait::async_trait;
use axum::{
    Router,
    body::{Body, to_bytes},
    http::Request,
};
use keyhunter::{
    catalog::provider::{CatalogError, CatalogGame, CatalogProvider, Platform, ProviderStatus},
    config::Config,
    create_app_with_catalog,
};
use serde_json::{Value, json};
use sqlx::{SqlitePool, sqlite::SqliteConnectOptions};
use std::sync::{
    Arc,
    atomic::{AtomicUsize, Ordering},
};
use tower::ServiceExt;
use tracing_subscriber::{Layer, layer::SubscriberExt};

static STATEMENTS: AtomicUsize = AtomicUsize::new(0);

struct Counter;
impl<S: tracing::Subscriber> Layer<S> for Counter {
    fn on_event(&self, event: &tracing::Event<'_>, _: tracing_subscriber::layer::Context<'_, S>) {
        if event.metadata().target() == "sqlx::query" {
            STATEMENTS.fetch_add(1, Ordering::SeqCst);
        }
    }
}

fn game(id: i64) -> CatalogGame {
    CatalogGame {
        igdb_id: id,
        name: format!("Example {id}"),
        slug: None,
        summary: None,
        first_release_date: Some(1_600_000_000),
        platforms: vec![Platform {
            id: 169,
            name: "Xbox Series X|S".into(),
        }],
        aliases: vec![],
        cover_url: None,
        artwork_url: None,
        store_product_id: None,
        version_parent: None,
        edition_name: None,
        kind: "base_game".into(),
        fetched_at: 1_794_940_000,
    }
}
struct Provider;
#[async_trait]
impl CatalogProvider for Provider {
    async fn search(&self, _: &str, _: i64) -> Result<Vec<CatalogGame>, CatalogError> {
        Ok((1..=10).map(game).collect())
    }
    async fn game(&self, id: i64) -> Result<Option<CatalogGame>, CatalogError> {
        Ok((1..=100).contains(&id).then(|| game(id)))
    }
    async fn editions(&self, _: i64) -> Result<Vec<CatalogGame>, CatalogError> {
        Ok(vec![])
    }
    async fn status(&self) -> ProviderStatus {
        ProviderStatus {
            configured: true,
            state: "ready".into(),
            last_success_at: None,
            retry_at: None,
        }
    }
}

struct Api {
    app: Router,
    cookie: String,
    csrf: String,
}
impl Api {
    async fn call(&self, method: &str, path: &str, body: Value) -> Value {
        let response = self
            .app
            .clone()
            .oneshot(
                Request::builder()
                    .method(method)
                    .uri(format!("/api/v1{path}"))
                    .header("Origin", "http://localhost:3000")
                    .header("Content-Type", "application/json")
                    .header("Cookie", &self.cookie)
                    .header("X-CSRF-Token", &self.csrf)
                    .body(if body.is_null() {
                        Body::empty()
                    } else {
                        Body::from(body.to_string())
                    })
                    .unwrap(),
            )
            .await
            .unwrap();
        assert!(
            response.status().is_success(),
            "{method} {path}: {}",
            response.status()
        );
        serde_json::from_slice(&to_bytes(response.into_body(), 4 << 20).await.unwrap())
            .unwrap_or(Value::Null)
    }
}

/// An app with `wishes` catalog wishes; the first has `links` product links, every other one link.
async fn app(wishes: i64, links: i64) -> (tempfile::TempDir, Api, String) {
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
    let app = create_app_with_catalog(config.clone(), Arc::new(Provider))
        .await
        .unwrap();
    let token = std::fs::read_to_string(config.data_dir.join("bootstrap-token")).unwrap();
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/v1/setup")
                .header("Origin", "http://localhost:3000")
                .header("Content-Type", "application/json")
                .body(Body::from(
                    json!({"token": token.trim(), "password": "query count passphrase"})
                        .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    let cookie = response.headers()["Set-Cookie"]
        .to_str()
        .unwrap()
        .split(';')
        .next()
        .unwrap()
        .to_string();
    let session: Value =
        serde_json::from_slice(&to_bytes(response.into_body(), 1 << 20).await.unwrap()).unwrap();
    let api = Api {
        app,
        cookie,
        csrf: session["csrf_token"].as_str().unwrap().into(),
    };
    let mut settings = api.call("GET", "/settings", Value::Null).await;
    settings["target_country"] = json!("DE");
    api.call("PUT", "/settings", settings).await;
    let pool = SqlitePool::connect_with(
        SqliteConnectOptions::new().filename(config.data_dir.join("keyhunter.db")),
    )
    .await
    .unwrap();
    let t = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs() as i64;
    let mut first = String::new();
    for id in 1..=wishes {
        let wish = api
            .call(
                "POST",
                "/wishlist",
                json!({"igdb_id": id, "platform_id": 169}),
            )
            .await["item"]["id"]
            .as_str()
            .unwrap()
            .to_string();
        let product = |n: i64| {
            json!({"id": format!("p{id}-{n}"), "name": format!("Example {id}"), "title": format!("Example {id}"), "platform_ids": [169], "key_game": true,
            "region": "Global", "allowed": ["DE"], "blocked": [], "purchase_country": "DE", "offers": [{"id": "q", "cents": 1000 + n, "seller": null}], "availability": "in_stock"}).to_string()
        };
        for n in 0..(if id == 1 { links } else { 1 }) {
            let link: i64 = sqlx::query_scalar("INSERT INTO offer_link(wish_id,source,url,review,latest,observed_at) VALUES(?,'eneba',?,?,?,?) RETURNING id")
                .bind(&wish)
                .bind(format!("https://www.eneba.com/de/example-{id}-{n}-xbox-key-global"))
                .bind(if n % 2 == 0 { "pending" } else { "rejected" })
                .bind(product(n))
                .bind(t - 600)
                .fetch_one(&pool)
                .await
                .unwrap();
            sqlx::query("INSERT INTO price_observation(link_id,product_id,observed_at,market,fingerprint,offers,activation,availability) VALUES(?,'p',?,'DE','f','[{\"id\":\"q\",\"cents\":1000}]','confirmed','in_stock')")
                .bind(link)
                .bind(t - 600)
                .execute(&pool)
                .await
                .unwrap();
        }
        api.call("POST", "/cart", json!({"wish_id": wish})).await;
        api.call(
            "PUT",
            &format!("/wishlist/{wish}/alert"),
            json!({"mode": "low", "basis": "base", "enabled": true}),
        )
        .await;
        if id == 1 {
            first = wish;
        }
    }
    (dir, api, first)
}

/// Installs the counter once; the tests share it, so each holds the lock while it measures.
async fn counting() -> tokio::sync::MutexGuard<'static, ()> {
    static SERIAL: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
    static INSTALL: std::sync::Once = std::sync::Once::new();
    INSTALL.call_once(|| {
        tracing::subscriber::set_global_default(tracing_subscriber::registry().with(Counter))
            .unwrap()
    });
    SERIAL.lock().await
}

/// The statements one request needs.
async fn statements(api: &Api, path: &str) -> usize {
    let before = STATEMENTS.load(Ordering::SeqCst);
    api.call("GET", path, Value::Null).await;
    STATEMENTS.load(Ordering::SeqCst) - before
}

#[tokio::test]
async fn list_endpoints_use_the_same_number_of_statements_for_one_and_for_fifty_wishes_code08() {
    let _serial = counting().await;
    let (_small_dir, small, small_first) = app(1, 1).await;
    let (_large_dir, large, large_first) = app(50, 50).await;
    for (what, small_path, large_path) in [
        ("wishlist", "/wishlist".to_string(), "/wishlist".to_string()),
        (
            "price badges",
            "/wishlist/price-badges".into(),
            "/wishlist/price-badges".into(),
        ),
        (
            "offers and history",
            format!("/wishlist/{small_first}/offers"),
            format!("/wishlist/{large_first}/offers"),
        ),
        (
            "catalog search",
            "/catalog/search?q=example&platform=169".into(),
            "/catalog/search?q=example&platform=169".into(),
        ),
        ("counts", "/counts".into(), "/counts".into()),
        ("alerts", "/alerts".into(), "/alerts".into()),
        ("cart", "/cart".into(), "/cart".into()),
        ("library", "/library".into(), "/library".into()),
    ] {
        // The first request of an app may fill a cache; measure the second.
        statements(&small, &small_path).await;
        statements(&large, &large_path).await;
        let (one, many) = (
            statements(&small, &small_path).await,
            statements(&large, &large_path).await,
        );
        assert!(one > 0, "{what}: the counter sees no statements");
        assert!(
            many <= one,
            "{what}: {many} statements for 50 wishes, {one} for one"
        );
    }
}

/// PERF-08: the start of an already upgraded database (`upgrade_fingerprints`) runs the same statements for one link
/// as for fifty.
#[tokio::test]
async fn a_second_start_uses_the_same_statements_for_one_and_for_fifty_links_perf08() {
    let _serial = counting().await;
    let mut counts = vec![];
    for links in [1, 50] {
        let (dir, _api, _) = app(1, links).await;
        let config = Config {
            bind: "127.0.0.1:3000".parse().unwrap(),
            origin: Some("http://localhost:3000".into()),
            data_dir: dir.path().join("data"),
            frontend_dir: dir.path().join("frontend"),
            bootstrap_file: None,
            allow_insecure_http: true,
            trusted_proxies: vec![],
        };
        // A fingerprint that is neither the old nor the new one: nothing is left to upgrade.
        let pool = SqlitePool::connect_with(
            SqliteConnectOptions::new().filename(config.data_dir.join("keyhunter.db")),
        )
        .await
        .unwrap();
        sqlx::query("UPDATE offer_link SET fingerprint='current'")
            .execute(&pool)
            .await
            .unwrap();
        let before = STATEMENTS.load(Ordering::SeqCst);
        let _ = create_app_with_catalog(config, Arc::new(Provider))
            .await
            .unwrap();
        counts.push(STATEMENTS.load(Ordering::SeqCst) - before);
    }
    assert!(counts[0] > 0, "the counter sees no statements");
    // The pool may open one more connection while it starts (a statement or two of its setup); a statement per link
    // would add fifty.
    assert!(
        counts[1] <= counts[0] + 3,
        "{} statements of a start with fifty links, {} with one",
        counts[1],
        counts[0]
    );
}
