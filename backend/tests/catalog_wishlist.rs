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
        artwork_url: None,
        store_product_id: None,
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
            origin: Some("http://localhost:3000".into()),
            data_dir: dir.path().join("data"),
            frontend_dir: frontend,
            bootstrap_file: None,
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
async fn unregistered_shops_cannot_receive_manual_product_jobs() {
    let f = Fixture::new().await;
    let (_, saved) = f
        .call(
            "POST",
            "/api/v1/wishlist",
            json!({"igdb_id":1,"platform_id":169}),
        )
        .await;
    let id = saved["item"]["id"].as_str().unwrap();
    let status = f
        .call(
            "POST",
            &format!("/api/v1/wishlist/{id}/offers"),
            json!({"url":"https://driffle.com/de/example-xbox-live-digital-key-p1"}),
        )
        .await
        .0;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
}

#[tokio::test]
async fn preferred_and_global_history_follow_the_actual_lowest_country_and_withdrawals() {
    let f = Fixture::new().await;
    let (_, saved) = f
        .call(
            "POST",
            "/api/v1/wishlist",
            json!({"igdb_id":1,"platform_id":169}),
        )
        .await;
    let id = saved["item"]["id"].as_str().unwrap();
    let (_, mut settings) = f.call("GET", "/api/v1/settings", Value::Null).await;
    settings["target_country"] = json!("DE");
    f.call("PUT", "/api/v1/settings", settings).await;
    let pool = sqlx::sqlite::SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(
            sqlx::sqlite::SqliteConnectOptions::new()
                .filename(f.config.data_dir.join("keyhunter.db")),
        )
        .await
        .unwrap();
    let t = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs() as i64;
    let mut global_id = 0;
    let mut global_fingerprint = String::new();
    for (region, cents, at, activation) in [
        ("India", 1000, t - 600, "unknown"),
        ("Global", 900, t - 300, "confirmed"),
    ] {
        let quotes = json!([{"id":region,"cents":cents,"seller":null}]);
        let product = json!({"id":region,"name":"Example","title":"Example","platform_ids":[169],"key_game":true,"region":region,"allowed":if region=="Global"{vec!["DE"]}else{vec![]},"blocked":[],"purchase_country":"DE","offers":quotes,"availability":"in_stock"});
        let link:i64=sqlx::query_scalar("INSERT INTO offer_link(wish_id,source,url,latest,observed_at) VALUES(?,'eneba',?,?,?) RETURNING id")
            .bind(id).bind(format!("https://www.eneba.com/de/xbox-example-xbox-live-key-{}",region.to_lowercase())).bind(product.to_string()).bind(at).fetch_one(&pool).await.unwrap();
        assert_eq!(
            f.call(
                "PUT",
                &format!("/api/v1/wishlist/{id}/offers/{link}"),
                json!({"decision":"confirmed"})
            )
            .await
            .0,
            StatusCode::NO_CONTENT
        );
        let fingerprint: String =
            sqlx::query_scalar("SELECT fingerprint FROM offer_link WHERE id=?")
                .bind(link)
                .fetch_one(&pool)
                .await
                .unwrap();
        sqlx::query("INSERT INTO price_observation(link_id,product_id,observed_at,market,fingerprint,offers,activation,availability) VALUES(?,?,?,'DE',?,?,?,'in_stock')")
            .bind(link).bind(region).bind(at).bind(&fingerprint).bind(quotes.to_string()).bind(activation).execute(&pool).await.unwrap();
        if region == "Global" {
            global_id = link;
            global_fingerprint = fingerprint;
        }
    }
    let path = format!("/api/v1/wishlist/{id}/offers");
    let (_, view) = f.call("GET", &path, Value::Null).await;
    assert_eq!(
        view["histories"]["all"]
            .as_array()
            .unwrap()
            .iter()
            .map(|p| p["base_cents"].as_i64().unwrap())
            .collect::<Vec<_>>(),
        vec![1000, 900]
    );
    assert_eq!(view["histories"]["all"][0]["region"], "India");
    assert_eq!(view["histories"]["preferred"].as_array().unwrap().len(), 1);
    sqlx::query("INSERT INTO price_observation(link_id,product_id,observed_at,market,fingerprint,offers,activation,availability) VALUES(?,'Global',?,'DE',?,'[]','confirmed','sold_out')")
        .bind(global_id).bind(t).bind(global_fingerprint).execute(&pool).await.unwrap();
    let (_, view) = f.call("GET", &path, Value::Null).await;
    assert_eq!(
        view["histories"]["all"].as_array().unwrap().last().unwrap()["base_cents"],
        1000
    );
    assert!(
        view["histories"]["preferred"]
            .as_array()
            .unwrap()
            .last()
            .unwrap()["base_cents"]
            .is_null()
    );
}

#[tokio::test]
async fn edition_comparison_returns_content_status_without_requiring_prices_or_a_wish() {
    let f = Fixture::new().await;
    let (status, comparison) = f
        .call(
            "GET",
            "/api/v1/catalog/games/1/edition-comparison?platform=169",
            Value::Null,
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    assert!(
        comparison["editions"]
            .as_array()
            .unwrap()
            .iter()
            .any(|e| e["igdb_id"] == 1)
    );
    assert!(comparison.get("prices").is_none());
    assert_eq!(
        f.call("GET", "/api/v1/wishlist", Value::Null).await.1,
        json!([])
    );
}

#[tokio::test]
async fn shops_require_a_compatible_reader_and_keep_configured_intervals() {
    let f = Fixture::new().await;
    let (_, settings) = f.call("GET", "/api/v1/settings", Value::Null).await;
    let eneba = settings["sources"]
        .as_array()
        .unwrap()
        .iter()
        .find(|s| s["id"] == "eneba")
        .unwrap();
    assert_eq!(eneba["poll_interval_seconds"], 28800);
    for url in [
        "http://127.0.0.1",
        "https://www.gamivo.com",
        "https://driffle.com@untrusted.example",
        "https://driffle.com/?token=private",
    ] {
        assert_eq!(
            f.call("POST", "/api/v1/settings/shops", json!({"url":url}))
                .await
                .0,
            StatusCode::UNPROCESSABLE_ENTITY
        );
    }
    let (status, mut settings) = f
        .call(
            "POST",
            "/api/v1/settings/shops",
            json!({"url":"https://driffle.com"}),
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        f.call(
            "POST",
            "/api/v1/settings/shops",
            json!({"url":"https://driffle.com"})
        )
        .await
        .0,
        StatusCode::CONFLICT
    );
    let source = settings["sources"]
        .as_array_mut()
        .unwrap()
        .iter_mut()
        .find(|s| s["id"] == "driffle")
        .unwrap();
    assert_eq!(source["configured"], true);
    source["poll_interval_seconds"] = json!(3600);
    let (_, wish) = f
        .call(
            "POST",
            "/api/v1/wishlist",
            json!({"igdb_id":1,"platform_id":169}),
        )
        .await;
    let pool = sqlx::sqlite::SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(
            sqlx::sqlite::SqliteConnectOptions::new()
                .filename(f.config.data_dir.join("keyhunter.db")),
        )
        .await
        .unwrap();
    let observed = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs() as i64
        - 60;
    let link:i64=sqlx::query_scalar("INSERT INTO offer_link(wish_id,source,url,observed_at) VALUES(?,'driffle','https://driffle.com/de/example-xbox-live-digital-key-p1',?) RETURNING id")
        .bind(wish["item"]["id"].as_str().unwrap()).bind(observed).fetch_one(&pool).await.unwrap();
    sqlx::query("INSERT INTO shop_job(source,link_id,due) VALUES('driffle',?,?)")
        .bind(link)
        .bind(observed + 28800)
        .execute(&pool)
        .await
        .unwrap();
    assert_eq!(
        f.call("PUT", "/api/v1/settings", settings.clone()).await.0,
        StatusCode::OK
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT due FROM shop_job WHERE link_id=?")
            .bind(link)
            .fetch_one(&pool)
            .await
            .unwrap(),
        observed + 3600
    );

    settings["sources"]
        .as_array_mut()
        .unwrap()
        .iter_mut()
        .find(|s| s["id"] == "driffle")
        .unwrap()["poll_interval_seconds"] = json!(1);
    assert_eq!(
        f.call("PUT", "/api/v1/settings", settings).await.0,
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        f.call("DELETE", "/api/v1/settings/shops/driffle", Value::Null)
            .await
            .0,
        StatusCode::OK
    );
    let (_, settings) = f.call("GET", "/api/v1/settings", Value::Null).await;
    let source = settings["sources"]
        .as_array()
        .unwrap()
        .iter()
        .find(|s| s["id"] == "driffle")
        .unwrap();
    assert_eq!(source["configured"], false);
    assert_eq!(source["poll_interval_seconds"], 3600);
}

#[tokio::test]
async fn edition_preview_never_changes_the_saved_wishlist_and_can_be_added_explicitly() {
    let f = Fixture::new().await;
    let (_, saved) = f
        .call(
            "POST",
            "/api/v1/wishlist",
            json!({"igdb_id":1,"platform_id":169}),
        )
        .await;
    let id = saved["item"]["id"].as_str().unwrap();
    let path = format!("/api/v1/wishlist/{id}/preview");
    let (status, preview) = f.call("POST", &path, json!({"igdb_id":2})).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(preview["item"]["game"]["igdb_id"], 2);
    assert_ne!(preview["item"]["id"], saved["item"]["id"]);
    let (_, rows) = f.call("GET", "/api/v1/wishlist", Value::Null).await;
    assert_eq!(rows, json!([saved["item"].clone()]));
    assert_eq!(
        f.call("POST", &path, json!({"igdb_id":6})).await.0,
        StatusCode::UNPROCESSABLE_ENTITY
    );
    let (status, added) = f
        .call(
            "POST",
            "/api/v1/wishlist",
            json!({"igdb_id":2,"platform_id":169}),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED);
    assert_eq!(added["item"]["id"], preview["item"]["id"]);
    let (_, rows) = f.call("GET", "/api/v1/wishlist", Value::Null).await;
    assert_eq!(rows.as_array().unwrap().len(), 2);
}

#[tokio::test]
async fn a_full_wishlist_can_preview_editions_but_cannot_promote_one_until_a_slot_is_free() {
    let f = Fixture::new().await;
    let (_, saved) = f
        .call(
            "POST",
            "/api/v1/wishlist",
            json!({"igdb_id":1,"platform_id":169}),
        )
        .await;
    let id = saved["item"]["id"].as_str().unwrap();
    let mut remove = String::new();
    for i in 0..99 {
        let (status, result) = f
            .call(
                "POST",
                "/api/v1/wishlist",
                json!({"manual_title":format!("Capacity game {i}"),"platform_id":169}),
            )
            .await;
        assert_eq!(status, StatusCode::CREATED);
        remove = result["item"]["id"].as_str().unwrap().to_string();
    }
    assert_eq!(
        f.call(
            "POST",
            &format!("/api/v1/wishlist/{id}/preview"),
            json!({"igdb_id":2})
        )
        .await
        .0,
        StatusCode::OK
    );
    let (_, list) = f.call("GET", "/api/v1/wishlist", Value::Null).await;
    assert_eq!(list.as_array().unwrap().len(), 100);
    assert_eq!(
        f.call(
            "POST",
            "/api/v1/wishlist",
            json!({"igdb_id":2,"platform_id":169})
        )
        .await
        .0,
        StatusCode::CONFLICT
    );
    f.call("DELETE", &format!("/api/v1/wishlist/{remove}"), Value::Null)
        .await;
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
}

#[tokio::test]
async fn regional_discovery_preserves_all_countries_and_leaves_room_for_manual_links() {
    let f = Fixture::new().await;
    let (_, result) = f
        .call(
            "POST",
            "/api/v1/wishlist",
            json!({"igdb_id":1,"platform_id":169}),
        )
        .await;
    let id = result["item"]["id"].as_str().unwrap();
    let pool = sqlx::sqlite::SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(
            sqlx::sqlite::SqliteConnectOptions::new()
                .filename(f.config.data_dir.join("keyhunter.db")),
        )
        .await
        .unwrap();
    for i in 0..21 {
        let region = ["Germany", "Global", "Europe", "United States", "Argentina"][i % 5];
        let product = json!({"id":format!("fixture{i}"),"name":"Example","title":"Example","platform_ids":[169],
            "key_game":true,"region":region,"allowed":[],"blocked":[],"purchase_country":"DE",
            "offers":[{"id":format!("quote{i}"),"cents":1000+i,"seller":null}],"availability":"in_stock"});
        sqlx::query("INSERT INTO offer_link(wish_id,source,url,latest,auto_discovered) VALUES(?,'eneba',?,?,1)")
            .bind(id).bind(format!("https://www.eneba.com/de/xbox-example-xbox-live-key-country-{i}"))
            .bind(product.to_string()).execute(&pool).await.unwrap();
    }
    let path = format!("/api/v1/wishlist/{id}/offers");
    for country in ["DE", "US"] {
        let (_, mut settings) = f.call("GET", "/api/v1/settings", Value::Null).await;
        settings["target_country"] = json!(country);
        assert_eq!(
            f.call("PUT", "/api/v1/settings", settings).await.0,
            StatusCode::OK
        );
        let (status, offers) = f.call("GET", &path, Value::Null).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(offers["links"].as_array().unwrap().len(), 21);
        assert_eq!(
            offers["links"]
                .as_array()
                .unwrap()
                .iter()
                .map(|l| l["quotes"].as_array().unwrap().len())
                .sum::<usize>(),
            21
        );
        assert_eq!(offers["target_country"], country);
    }
    assert_eq!(
        f.call(
            "POST",
            &path,
            json!({"url":"https://www.eneba.com/de/xbox-example-xbox-live-key-japan"})
        )
        .await
        .0,
        StatusCode::ACCEPTED
    );
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
