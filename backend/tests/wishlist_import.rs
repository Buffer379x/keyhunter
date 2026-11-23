//! PROD-01: the wishlist import takes the file of the export through the same path as adding a wish by hand.
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
use std::sync::Arc;
use tower::ServiceExt;

/// Games 1 and 2 are Xbox Series X|S base games, 3 is a PC game; every other id is unknown.
struct Provider;
fn game(id: i64) -> CatalogGame {
    CatalogGame {
        igdb_id: id,
        name: format!("Example {id}"),
        slug: None,
        summary: None,
        first_release_date: None,
        platforms: vec![Platform {
            id: if id == 3 { 6 } else { 169 },
            name: "Platform".into(),
        }],
        aliases: vec![],
        cover_url: None,
        artwork_url: None,
        store_product_id: None,
        version_parent: None,
        edition_name: None,
        kind: "base_game".into(),
        fetched_at: 1794940000,
    }
}
#[async_trait]
impl CatalogProvider for Provider {
    async fn search(&self, _q: &str, _platform: i64) -> Result<Vec<CatalogGame>, CatalogError> {
        Ok(vec![])
    }
    async fn game(&self, id: i64) -> Result<Option<CatalogGame>, CatalogError> {
        Ok((1..=3).contains(&id).then(|| game(id)))
    }
    async fn editions(&self, _parent: i64) -> Result<Vec<CatalogGame>, CatalogError> {
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

struct Fixture {
    _dir: tempfile::TempDir,
    app: Router,
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
        let (_, session, cookie) = send(
            &app,
            "POST",
            "/api/v1/setup",
            json!({"token":token,"password":"import test passphrase"}),
            None,
            None,
        )
        .await;
        Self {
            _dir: dir,
            app,
            cookie: cookie.unwrap().split(';').next().unwrap().into(),
            csrf: session["csrf_token"].as_str().unwrap().into(),
        }
    }
    async fn call(&self, method: &str, path: &str, body: Value) -> (StatusCode, Value) {
        let (s, v, _) = send(
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
    async fn import(&self, items: Value, dry_run: bool) -> (StatusCode, Value) {
        self.call(
            "POST",
            "/api/v1/wishlist/import",
            json!({"version":1,"items":items,"dry_run":dry_run}),
        )
        .await
    }
    /// The wishlist as the export writes it: title, platform, IGDB id.
    async fn wishlist(&self) -> Vec<Value> {
        let mut rows = self.call("GET", "/api/v1/wishlist", Value::Null).await.1;
        let rows = rows.as_array_mut().unwrap();
        rows.sort_by_key(|r| r["id"].as_str().unwrap().to_string());
        let mut names: Vec<Value> = rows
            .iter()
            .map(|r| {
                json!({
                    "title": r["game"]["name"].as_str().or(r["manual_title"].as_str()),
                    "platform_id": r["platform_id"],
                    "igdb_id": r["game"]["igdb_id"],
                })
            })
            .collect();
        names.sort_by_key(Value::to_string);
        names
    }
}
async fn send(
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

fn entry(title: &str, platform: &str, igdb_id: Option<i64>) -> Value {
    json!({"title":title,"platform":platform,"igdb_id":igdb_id,"kind":null,"verification":"catalog"})
}

#[tokio::test]
async fn export_then_import_into_an_empty_instance_gives_the_same_wishlist() {
    let source = Fixture::new().await;
    source
        .call(
            "POST",
            "/api/v1/wishlist",
            json!({"igdb_id":1,"platform_id":169}),
        )
        .await;
    source
        .call(
            "POST",
            "/api/v1/wishlist",
            json!({"igdb_id":2,"platform_id":169}),
        )
        .await;
    source
        .call(
            "POST",
            "/api/v1/wishlist",
            json!({"manual_title":"Manual Game","platform_id":12}),
        )
        .await;
    // What the page writes: the same fields as the export of the wishlist.
    let rows = source.call("GET", "/api/v1/wishlist", Value::Null).await.1;
    let platforms = [(169, "Xbox Series X|S"), (12, "Xbox 360")];
    let items: Vec<Value> = rows
        .as_array()
        .unwrap()
        .iter()
        .map(|r| {
            let name = platforms
                .iter()
                .find(|(id, _)| *id == r["platform_id"])
                .unwrap()
                .1;
            json!({
                "title": r["game"]["name"].as_str().or(r["manual_title"].as_str()),
                "platform": name,
                "igdb_id": r["game"]["igdb_id"],
                "kind": r["game"]["kind"],
                "verification": r["verification"],
            })
        })
        .collect();
    assert_eq!(items.len(), 3);

    let target = Fixture::new().await;
    let (status, preview) = target.import(json!(items), true).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(preview["counts"]["added"], 3);
    assert!(
        target.wishlist().await.is_empty(),
        "a preview changes nothing"
    );

    let (status, done) = target.import(json!(items), false).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(done["counts"]["added"], 3);
    assert_eq!(target.wishlist().await, source.wishlist().await);
}

#[tokio::test]
async fn importing_twice_adds_nothing_and_duplicates_are_reported() {
    let f = Fixture::new().await;
    f.call(
        "POST",
        "/api/v1/wishlist",
        json!({"igdb_id":1,"platform_id":169}),
    )
    .await;
    let items = json!([
        entry("Example 1", "Xbox Series X|S", Some(1)),
        entry("Example 2", "Xbox Series X|S", Some(2)),
        entry("Example 2", "Xbox Series X|S", Some(2)),
        entry("Manual Game", "Xbox One", None),
        entry("  manual   game ", "Xbox One", None),
    ]);
    let (_, first) = f.import(items.clone(), false).await;
    assert_eq!(first["counts"]["added"], 2, "{first}");
    assert_eq!(first["counts"]["existing"], 3);
    let before = f.wishlist().await;
    assert_eq!(before.len(), 3);
    let (_, second) = f.import(items, false).await;
    assert_eq!(second["counts"]["added"], 0);
    assert_eq!(second["counts"]["existing"], 5);
    assert_eq!(f.wishlist().await, before);
}

#[tokio::test]
async fn a_game_in_the_library_stays_there_and_is_reported() {
    let f = Fixture::new().await;
    let (_, wish) = f
        .call(
            "POST",
            "/api/v1/wishlist",
            json!({"igdb_id":1,"platform_id":169}),
        )
        .await;
    let id = wish["item"]["id"].as_str().unwrap();
    f.call(
        "POST",
        &format!("/api/v1/wishlist/{id}/purchase"),
        json!({}),
    )
    .await;
    for dry_run in [true, false] {
        let (status, result) = f
            .import(
                json!([entry("Example 1", "Xbox Series X|S", Some(1))]),
                dry_run,
            )
            .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(result["counts"]["library"], 1);
        assert_eq!(result["counts"]["added"], 0);
        assert_eq!(result["results"][0]["status"], "library");
    }
    assert!(f.wishlist().await.is_empty());
    assert_eq!(
        f.call("GET", "/api/v1/library", Value::Null)
            .await
            .1
            .as_array()
            .unwrap()
            .len(),
        1
    );
}

#[tokio::test]
async fn unknown_games_platforms_and_broken_entries_are_reported_one_by_one() {
    let f = Fixture::new().await;
    let (status, result) = f
        .import(
            json!([
                entry("Gone", "Xbox Series X|S", Some(99)),
                entry("PC only", "Xbox Series X|S", Some(3)),
                entry("Example 1", "PlayStation 5", Some(1)),
                entry("", "Xbox One", None),
                {"title": 5, "platform": "Xbox One"},
                "not an entry",
                entry("Example 1", "Xbox Series X|S", Some(1)),
            ]),
            false,
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    let statuses: Vec<_> = result["results"]
        .as_array()
        .unwrap()
        .iter()
        .map(|r| r["status"].as_str().unwrap())
        .collect();
    assert_eq!(
        statuses,
        [
            "unknown", "unknown", "unknown", "invalid", "invalid", "invalid", "added"
        ]
    );
    assert_eq!(result["counts"]["unknown"], 3);
    assert_eq!(result["counts"]["invalid"], 3);
    assert_eq!(f.wishlist().await.len(), 1);
}

#[tokio::test]
async fn an_invalid_file_is_refused_and_the_size_is_limited() {
    let f = Fixture::new().await;
    let post = |body: Value| f.call("POST", "/api/v1/wishlist/import", body);
    assert_eq!(post(json!({"items":[]})).await.0, StatusCode::BAD_REQUEST);
    assert_eq!(
        post(json!({"version":2,"items":[]})).await.0,
        StatusCode::UNPROCESSABLE_ENTITY
    );
    assert_eq!(post(json!({"version":1})).await.0, StatusCode::BAD_REQUEST);
    let many: Vec<Value> = (0..101)
        .map(|i| entry(&format!("Game {i}"), "Xbox One", None))
        .collect();
    assert_eq!(
        post(json!({"version":1,"items":many})).await.0,
        StatusCode::UNPROCESSABLE_ENTITY
    );
    // 128 KiB is the limit of the body, well above 100 entries.
    let huge =
        json!({"version":1,"items":[{"title":"x".repeat(200 * 1024),"platform":"Xbox One"}]});
    let (status, body) = post(huge).await;
    assert_eq!(status, StatusCode::PAYLOAD_TOO_LARGE);
    assert_eq!(body["code"], "too_large");
    assert!(f.wishlist().await.is_empty());
}

#[tokio::test]
async fn the_import_needs_a_session_and_the_csrf_token() {
    let f = Fixture::new().await;
    let body = json!({"version":1,"items":[]});
    let (status, _, _) = send(
        &f.app,
        "POST",
        "/api/v1/wishlist/import",
        body.clone(),
        None,
        None,
    )
    .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    let (status, _, _) = send(
        &f.app,
        "POST",
        "/api/v1/wishlist/import",
        body,
        Some(&f.cookie),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn a_confirmed_mapping_survives_an_import_of_the_same_game() {
    let f = Fixture::new().await;
    let (_, wish) = f
        .call(
            "POST",
            "/api/v1/wishlist",
            json!({"igdb_id":1,"platform_id":169}),
        )
        .await;
    let before = f.call("GET", "/api/v1/wishlist", Value::Null).await.1;
    f.import(
        json!([entry("Example 1", "Xbox Series X|S", Some(1))]),
        false,
    )
    .await;
    let after = f.call("GET", "/api/v1/wishlist", Value::Null).await.1;
    assert_eq!(before[0]["id"], wish["item"]["id"]);
    assert_eq!(after, before, "the existing wish is not touched");
}
