use async_trait::async_trait;
use axum::{
    Router,
    body::{Body, to_bytes},
    http::{Request, StatusCode},
};
use keyhunter::{
    catalog::provider::{CatalogError, CatalogGame, CatalogProvider, Platform, ProviderStatus},
    config::Config,
    create_app_with_catalog,
};
use serde_json::{Value, json};
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};
use tower::ServiceExt;

struct Provider {
    offline: AtomicBool,
    changed_platform: AtomicBool,
}
fn game(id: i64) -> CatalogGame {
    CatalogGame {
        igdb_id: id,
        name: match id {
            2 => "Example Premium",
            3 => "Example PC",
            4 => "Example DLC",
            5 => "Example Remaster",
            6 => "Example 2",
            _ => "Example",
        }
        .into(),
        slug: Some("example".into()),
        summary: None,
        first_release_date: None,
        platforms: vec![Platform {
            id: if id == 3 { 6 } else { 169 },
            name: if id == 3 { "PC" } else { "Xbox Series X|S" }.into(),
        }],
        aliases: vec!["Alternative".into()],
        cover_url: None,
        version_parent: (id == 2).then_some(1),
        edition_name: (id == 2).then_some("Premium".into()),
        kind: match id {
            2 => "edition",
            4 => "dlc",
            5 => "remaster",
            _ => "base_game",
        }
        .into(),
        fetched_at: 1794940000,
    }
}
#[async_trait]
impl CatalogProvider for Provider {
    async fn search(&self, q: &str, _platform: i64) -> Result<Vec<CatalogGame>, CatalogError> {
        if self.offline.load(Ordering::SeqCst) {
            return Err(CatalogError::Unavailable);
        }
        if q == "empty" {
            return Ok(vec![]);
        }
        Ok((1..=6).map(game).collect())
    }
    async fn game(&self, id: i64) -> Result<Option<CatalogGame>, CatalogError> {
        if self.offline.load(Ordering::SeqCst) {
            return Err(CatalogError::Unavailable);
        }
        Ok((1..=6).contains(&id).then(|| {
            let mut value = game(id);
            if self.changed_platform.load(Ordering::SeqCst) {
                value.platforms = vec![Platform {
                    id: 6,
                    name: "PC".into(),
                }];
            }
            value
        }))
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

struct Fixture {
    _dir: tempfile::TempDir,
    config: Config,
    app: Router,
    provider: Arc<Provider>,
    cookie: String,
    csrf: String,
}
impl Fixture {
    async fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let frontend = dir.path().join("frontend");
        std::fs::create_dir(&frontend).unwrap();
        std::fs::write(frontend.join("index.html"), "<title>fixture</title>").unwrap();
        let config = Config {
            bind: "127.0.0.1:3000".parse().unwrap(),
            origin: "http://localhost:3000".into(),
            data_dir: dir.path().join("data"),
            frontend_dir: frontend,
            bootstrap_file: None,
            igdb_env_file: None,
            allow_insecure_http: true,
        };
        let provider = Arc::new(Provider {
            offline: AtomicBool::new(false),
            changed_platform: AtomicBool::new(false),
        });
        let app = create_app_with_catalog(config.clone(), provider.clone())
            .await
            .unwrap();
        let token = std::fs::read_to_string(config.data_dir.join("bootstrap-token")).unwrap();
        let (_, session, cookie) = request(
            &app,
            "POST",
            "/api/v1/setup",
            json!({"token":token,"password":"catalog test passphrase"}),
            None,
            None,
        )
        .await;
        Self {
            _dir: dir,
            config,
            app,
            provider,
            cookie: cookie.unwrap().split(';').next().unwrap().into(),
            csrf: session["csrf_token"].as_str().unwrap().into(),
        }
    }
    async fn call(&self, method: &str, path: &str, body: Value) -> (StatusCode, Value) {
        let (s, v, _) = request(
            &self.app,
            method,
            path,
            body,
            Some(&self.cookie),
            Some(&self.csrf),
        )
        .await;
        (s, v)
    }
}
async fn request(
    app: &Router,
    method: &str,
    path: &str,
    body: Value,
    cookie: Option<&str>,
    csrf: Option<&str>,
) -> (StatusCode, Value, Option<String>) {
    let mut req = Request::builder()
        .method(method)
        .uri(path)
        .header("Origin", "http://localhost:3000")
        .header("Content-Type", "application/json");
    if let Some(c) = cookie {
        req = req.header("Cookie", c)
    }
    if let Some(c) = csrf {
        req = req.header("X-CSRF-Token", c)
    }
    let res = app
        .clone()
        .oneshot(
            req.body(if body.is_null() {
                Body::empty()
            } else {
                Body::from(body.to_string())
            })
            .unwrap(),
        )
        .await
        .unwrap();
    let status = res.status();
    let cookie = res
        .headers()
        .get("Set-Cookie")
        .map(|v| v.to_str().unwrap().into());
    let bytes = to_bytes(res.into_body(), 1024 * 1024).await.unwrap();
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
        cookie,
    )
}

#[tokio::test]
async fn catalog_errors_do_not_become_empty_results_and_fresh_cache_works_offline() {
    let f = Fixture::new().await;
    let (status, _, _) = request(
        &f.app,
        "GET",
        "/api/v1/catalog/search?q=Example",
        Value::Null,
        None,
        None,
    )
    .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    let (status, result) = f
        .call("GET", "/api/v1/catalog/search?q=Example", Value::Null)
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(result["games"].as_array().unwrap().len(), 5);
    assert_eq!(result["cached"], false);
    assert!(
        !result["games"]
            .as_array()
            .unwrap()
            .iter()
            .any(|g| g["igdb_id"] == 3)
    );
    let (_, empty) = f
        .call("GET", "/api/v1/catalog/search?q=empty", Value::Null)
        .await;
    assert_eq!(empty["games"], json!([]));
    f.provider.offline.store(true, Ordering::SeqCst);
    let (status, cached) = f
        .call("GET", "/api/v1/catalog/search?q=Example", Value::Null)
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(cached["cached"], true);
    assert_eq!(
        f.call("GET", "/api/v1/catalog/search?q=new-query", Value::Null)
            .await
            .0,
        StatusCode::SERVICE_UNAVAILABLE
    );
    assert_eq!(
        f.call("GET", "/api/v1/catalog/search?q=x", Value::Null)
            .await
            .0,
        StatusCode::BAD_REQUEST
    );
}

#[tokio::test]
async fn edition_ids_are_distinct_duplicates_are_idempotent_and_wishlist_survives_restart() {
    let f = Fixture::new().await;
    let (status, first) = f
        .call(
            "POST",
            "/api/v1/wishlist",
            json!({"igdb_id":1,"platform_id":169}),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED);
    let (status, duplicate) = f
        .call(
            "POST",
            "/api/v1/wishlist",
            json!({"igdb_id":1,"platform_id":169}),
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(duplicate["created"], false);
    assert_eq!(first["item"]["id"], duplicate["item"]["id"]);
    assert_eq!(
        f.call(
            "POST",
            "/api/v1/wishlist",
            json!({"igdb_id":2,"platform_id":169})
        )
        .await
        .0,
        StatusCode::CREATED
    );
    let restarted = create_app_with_catalog(f.config.clone(), f.provider.clone())
        .await
        .unwrap();
    f.provider.offline.store(true, Ordering::SeqCst);
    let (status, items, _) = request(
        &restarted,
        "GET",
        "/api/v1/wishlist",
        Value::Null,
        Some(&f.cookie),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(items.as_array().unwrap().len(), 2);
    assert_ne!(items[0]["game_id"], items[1]["game_id"]);
    let id = first["item"]["id"].as_str().unwrap();
    assert_eq!(
        request(
            &restarted,
            "DELETE",
            &format!("/api/v1/wishlist/{id}"),
            Value::Null,
            Some(&f.cookie),
            None
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        request(
            &restarted,
            "DELETE",
            &format!("/api/v1/wishlist/{id}"),
            Value::Null,
            Some(&f.cookie),
            Some(&f.csrf)
        )
        .await
        .0,
        StatusCode::NO_CONTENT
    );
    let (_, items, _) = request(
        &restarted,
        "GET",
        "/api/v1/wishlist",
        Value::Null,
        Some(&f.cookie),
        None,
    )
    .await;
    assert_eq!(items.as_array().unwrap().len(), 1);
}

#[tokio::test]
async fn dlc_pc_and_wrong_release_platform_cannot_be_saved_as_xbox_game() {
    let f = Fixture::new().await;
    for (id, platform) in [(3, 169), (4, 169), (1, 49)] {
        assert_eq!(
            f.call(
                "POST",
                "/api/v1/wishlist",
                json!({"igdb_id":id,"platform_id":platform})
            )
            .await
            .0,
            StatusCode::UNPROCESSABLE_ENTITY
        );
    }
    assert_eq!(
        f.call("GET", "/api/v1/wishlist", Value::Null).await.1,
        json!([])
    );
    for id in [5, 6] {
        assert_eq!(
            f.call(
                "POST",
                "/api/v1/wishlist",
                json!({"igdb_id":id,"platform_id":169})
            )
            .await
            .0,
            StatusCode::CREATED
        );
    }
    let (_, items) = f.call("GET", "/api/v1/wishlist", Value::Null).await;
    assert_ne!(items[0]["game_id"], items[1]["game_id"]);
}

#[tokio::test]
async fn manual_titles_remain_unverified_and_duplicate_normalized_titles_do_not_multiply() {
    let f = Fixture::new().await;
    f.provider.offline.store(true, Ordering::SeqCst);
    let (status, item) = f
        .call(
            "POST",
            "/api/v1/wishlist",
            json!({"manual_title":"  Unknown Game  ","platform_id":169}),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED);
    assert_eq!(item["item"]["verification"], "manual_unverified");
    assert!(item["item"]["game"].is_null());
    let (_, duplicate) = f
        .call(
            "POST",
            "/api/v1/wishlist",
            json!({"manual_title":"unknown  game","platform_id":169}),
        )
        .await;
    assert_eq!(duplicate["created"], false);
    assert_eq!(
        f.call(
            "POST",
            "/api/v1/wishlist",
            json!({"manual_title":"Unknown","igdb_id":1,"platform_id":169})
        )
        .await
        .0,
        StatusCode::BAD_REQUEST
    );
}

#[tokio::test]
async fn hundred_item_limit_is_atomic_and_existing_items_still_return_at_capacity() {
    let f = Fixture::new().await;
    for i in 0..99 {
        assert_eq!(
            f.call(
                "POST",
                "/api/v1/wishlist",
                json!({"manual_title":format!("Manual {i}"),"platform_id":169})
            )
            .await
            .0,
            StatusCode::CREATED
        );
    }
    let (a, b) = tokio::join!(
        f.call(
            "POST",
            "/api/v1/wishlist",
            json!({"manual_title":"Last Alpha","platform_id":169})
        ),
        f.call(
            "POST",
            "/api/v1/wishlist",
            json!({"manual_title":"Last Beta","platform_id":169})
        )
    );
    let mut statuses = [a.0.as_u16(), b.0.as_u16()];
    statuses.sort();
    assert_eq!(statuses, [201, 409]);
    assert_eq!(
        f.call(
            "POST",
            "/api/v1/wishlist",
            json!({"manual_title":"Manual 0","platform_id":169})
        )
        .await
        .0,
        StatusCode::OK
    );
    assert_eq!(
        f.call("GET", "/api/v1/wishlist", Value::Null)
            .await
            .1
            .as_array()
            .unwrap()
            .len(),
        100
    );
}

#[tokio::test]
async fn changed_provider_platform_marks_saved_selection_for_review() {
    let f = Fixture::new().await;
    assert_eq!(
        f.call(
            "POST",
            "/api/v1/wishlist",
            json!({"igdb_id":1,"platform_id":169})
        )
        .await
        .0,
        StatusCode::CREATED
    );
    f.provider.changed_platform.store(true, Ordering::SeqCst);
    let pool = sqlx::SqlitePool::connect_with(
        sqlx::sqlite::SqliteConnectOptions::new().filename(f.config.data_dir.join("keyhunter.db")),
    )
    .await
    .unwrap();
    sqlx::query("UPDATE catalog_game SET fetched_at = 0")
        .execute(&pool)
        .await
        .unwrap();
    assert_eq!(
        f.call("GET", "/api/v1/catalog/games/1?platform=169", Value::Null)
            .await
            .0,
        StatusCode::UNPROCESSABLE_ENTITY
    );
    let (_, items) = f.call("GET", "/api/v1/wishlist", Value::Null).await;
    assert_eq!(items[0]["verification"], "needs_review");
}

#[tokio::test]
async fn overly_open_credentials_are_not_used_for_live_requests() {
    use keyhunter::catalog::provider::IgdbProvider;
    use std::os::unix::fs::PermissionsExt;
    let directory = tempfile::tempdir().unwrap();
    let file = directory.path().join("igdb.env");
    std::fs::write(
        &file,
        "IGDB_CLIENT_ID=fixture-client\nIGDB_CLIENT_SECRET=synthetic-secret\n",
    )
    .unwrap();
    std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o600)).unwrap();
    assert!(
        IgdbProvider::new(Some(&file))
            .unwrap()
            .status()
            .await
            .configured
    );
    std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o644)).unwrap();
    let provider = IgdbProvider::new(Some(&file)).unwrap();
    assert!(!provider.status().await.configured);
    assert!(matches!(
        provider.search("Example", 169).await,
        Err(CatalogError::NotConfigured)
    ));
}
