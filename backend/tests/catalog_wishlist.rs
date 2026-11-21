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
    async fn editions(&self, _parent: i64) -> Result<Vec<CatalogGame>, CatalogError> {
        if self.offline.load(Ordering::SeqCst) {
            return Err(CatalogError::Unavailable);
        }
        Ok((1..=6).map(game).collect())
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
async fn switched_off_shops_cannot_receive_manual_product_jobs() {
    let f = Fixture::new().await;
    let (_, saved) = f
        .call(
            "POST",
            "/api/v1/wishlist",
            json!({"igdb_id":1,"platform_id":169}),
        )
        .await;
    let id = saved["item"]["id"].as_str().unwrap();
    // Driffle is listed (0.7.4) but switched off in the fixture.
    let (_, settings) = f.call("GET", "/api/v1/settings", Value::Null).await;
    let driffle = settings["sources"]
        .as_array()
        .unwrap()
        .iter()
        .find(|s| s["id"] == "driffle")
        .unwrap();
    assert_eq!(
        (&driffle["configured"], &driffle["enabled"]),
        (&json!(true), &json!(false))
    );
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
    // Current badge scope remains independent from the selected history scope.
    assert_eq!(
        f.call("GET", "/api/v1/wishlist/price-badges", Value::Null)
            .await
            .1[id]["cents"],
        900
    );
    sqlx::query("UPDATE offer_link SET latest=json_set(latest,'$.offers[0].cents',500) WHERE json_extract(latest,'$.region')='India'").execute(&pool).await.unwrap();
    let (_, mut settings) = f.call("GET", "/api/v1/settings", Value::Null).await;
    // The stored scope no longer changes the badge: the target-country price stays, the cheaper
    // region appears as the world comparison (0.6.1).
    settings["wishlist_price_scope"] = json!("all");
    f.call("PUT", "/api/v1/settings", settings.clone()).await;
    let (_, badges) = f
        .call("GET", "/api/v1/wishlist/price-badges", Value::Null)
        .await;
    assert_eq!(badges[id]["cents"], 900);
    assert_eq!(badges[id]["world"]["cents"], 500);
    settings["wishlist_price_scope"] = json!("preferred");
    f.call("PUT", "/api/v1/settings", settings).await;
    assert_eq!(
        f.call("GET", "/api/v1/wishlist/price-badges", Value::Null)
            .await
            .1[id]["cents"],
        900
    );
    sqlx::query("UPDATE offer_link SET latest=json_set(latest,'$.offers[0].cents',1000) WHERE json_extract(latest,'$.region')='India'").execute(&pool).await.unwrap();
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
async fn shops_are_always_listed_and_keep_configured_intervals() {
    let f = Fixture::new().await;
    let (_, mut settings) = f.call("GET", "/api/v1/settings", Value::Null).await;
    let eneba = settings["sources"]
        .as_array()
        .unwrap()
        .iter()
        .find(|s| s["id"] == "eneba")
        .unwrap();
    assert_eq!(eneba["poll_interval_seconds"], 28800);
    // The registration endpoints are gone (0.7.4); every shop reader is listed and switched by "Aktiv".
    for (method, path) in [
        ("POST", "/api/v1/settings/shops"),
        ("DELETE", "/api/v1/settings/shops/driffle"),
        ("GET", "/api/v1/settings/shop-readers"),
    ] {
        assert_ne!(
            f.call(method, path, json!({"url":"https://driffle.com"}))
                .await
                .0,
            StatusCode::OK
        );
    }
    let source = settings["sources"]
        .as_array_mut()
        .unwrap()
        .iter_mut()
        .find(|s| s["id"] == "driffle")
        .unwrap();
    assert_eq!(source["configured"], true);
    source["enabled"] = json!(true);
    // A client cannot take a shop off the list any more.
    source["configured"] = json!(false);
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
    let (_, saved) = f.call("GET", "/api/v1/settings", Value::Null).await;
    let driffle = saved["sources"]
        .as_array()
        .unwrap()
        .iter()
        .find(|s| s["id"] == "driffle")
        .unwrap();
    assert_eq!(
        (&driffle["configured"], &driffle["enabled"]),
        (&json!(true), &json!(true))
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
    // An IGDB ID puts that game first (once), next to the normal text results; an ID of another platform or an
    // unknown ID changes nothing.
    let ids = |result: &Value| -> Vec<i64> {
        result["games"]
            .as_array()
            .unwrap()
            .iter()
            .map(|g| g["igdb_id"].as_i64().unwrap())
            .collect()
    };
    let (status, by_id) = f
        .call("GET", "/api/v1/catalog/search?q=%235", Value::Null)
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(ids(&by_id), vec![5, 1, 2, 4, 6]);
    let (_, prefixed) = f
        .call("GET", "/api/v1/catalog/search?q=igdb%3A6", Value::Null)
        .await;
    assert_eq!(ids(&prefixed)[0], 6);
    let (_, pc) = f
        .call("GET", "/api/v1/catalog/search?q=igdb%3A3", Value::Null)
        .await;
    assert_eq!(ids(&pc), vec![1, 2, 4, 5, 6]);
    let (status, unknown) = f
        .call("GET", "/api/v1/catalog/search?q=%2399", Value::Null)
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(ids(&unknown), vec![1, 2, 4, 5, 6]);
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
async fn library_moves_preserve_identity_and_require_confirmation() {
    let f = Fixture::new().await;
    let (_, saved) = f
        .call(
            "POST",
            "/api/v1/wishlist",
            json!({"igdb_id":1,"platform_id":169}),
        )
        .await;
    let id = saved["item"]["id"].as_str().unwrap();
    let pool = sqlx::SqlitePool::connect_with(
        sqlx::sqlite::SqliteConnectOptions::new().filename(f.config.data_dir.join("keyhunter.db")),
    )
    .await
    .unwrap();
    let link:i64=sqlx::query_scalar("INSERT INTO offer_link(wish_id,source,url) VALUES(?,'eneba','https://www.eneba.com/test') RETURNING id").bind(id).fetch_one(&pool).await.unwrap();
    sqlx::query("INSERT INTO price_observation(link_id,product_id,observed_at,market,fingerprint,offers,activation,availability) VALUES(?,'fixture',1,'DE','test','[]','confirmed','in_stock')").bind(link).execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO alert_rule(wish_id,mode,basis,enabled) VALUES(?,'low','base',1)")
        .bind(id)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query(
        "INSERT INTO alert_outbox(wish_id,observed_at,message,due) VALUES(?,1,'fixture',1)",
    )
    .bind(id)
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query("INSERT INTO shop_job(source,link_id,due,lease_until,lease_token) VALUES('eneba',?,0,9999999999,'inflight')").bind(link).execute(&pool).await.unwrap();
    assert_eq!(
        f.call(
            "POST",
            &format!("/api/v1/wishlist/{id}/purchase"),
            json!({})
        )
        .await
        .0,
        StatusCode::NO_CONTENT
    );
    assert_eq!(
        f.call("GET", "/api/v1/wishlist", Value::Null).await.1,
        json!([])
    );
    assert_eq!(
        f.call("GET", "/api/v1/wishlist/price-badges", Value::Null)
            .await
            .1,
        json!({}),
        "library items have no badge and no current price"
    );
    let (_, owned) = f.call("GET", "/api/v1/library", Value::Null).await;
    assert_eq!(owned[0]["id"], id);
    assert!(
        !sqlx::query_scalar::<_, bool>("SELECT enabled FROM alert_rule WHERE wish_id=?")
            .bind(id)
            .fetch_one(&pool)
            .await
            .unwrap()
    );
    assert_eq!(
        sqlx::query_scalar::<_, String>("SELECT state FROM alert_outbox WHERE wish_id=?")
            .bind(id)
            .fetch_one(&pool)
            .await
            .unwrap(),
        "cancelled"
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT lease_until FROM shop_job WHERE link_id=?")
            .bind(link)
            .fetch_one(&pool)
            .await
            .unwrap(),
        0
    );
    assert_eq!(
        f.call(
            "POST",
            &format!("/api/v1/wishlist/{id}/offers/refresh"),
            json!({})
        )
        .await
        .0,
        StatusCode::CONFLICT
    );
    let restore = format!("/api/v1/library/{id}/restore");
    assert_eq!(
        f.call("POST", &restore, json!({"confirm":false})).await.0,
        StatusCode::CONFLICT
    );
    let (s, warning) = f
        .call(
            "POST",
            "/api/v1/wishlist",
            json!({"igdb_id":1,"platform_id":169}),
        )
        .await;
    assert_eq!(s, StatusCode::CONFLICT);
    assert_eq!(warning["code"], "owned_game");
    let (s, warning) = f
        .call(
            "POST",
            "/api/v1/wishlist",
            json!({"igdb_id":2,"platform_id":169}),
        )
        .await;
    assert_eq!(s, StatusCode::CONFLICT);
    assert_eq!(warning["code"], "owned_game");
    assert_eq!(
        f.call("GET", "/api/v1/wishlist", Value::Null).await.1,
        json!([])
    );
    assert_eq!(
        f.call(
            "POST",
            "/api/v1/wishlist",
            json!({"igdb_id":2,"platform_id":169,"confirm_owned":true})
        )
        .await
        .0,
        StatusCode::CREATED
    );
    assert_eq!(
        f.call("GET", "/api/v1/library", Value::Null)
            .await
            .1
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert_eq!(
        f.call("POST", &restore, json!({"confirm":true})).await.0,
        StatusCode::NO_CONTENT
    );
    let (_, items) = f.call("GET", "/api/v1/wishlist", Value::Null).await;
    assert_eq!(items.as_array().unwrap().len(), 2);
    assert!(
        items
            .as_array()
            .unwrap()
            .iter()
            .any(|item| item["id"] == id)
    );
    assert_eq!(
        f.call("GET", "/api/v1/library", Value::Null).await.1,
        json!([])
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM price_observation WHERE link_id=?")
            .bind(link)
            .fetch_one(&pool)
            .await
            .unwrap(),
        1
    );
}

#[tokio::test]
async fn owned_exact_manual_and_catalog_readd_is_confirmed_and_atomic() {
    let f = Fixture::new().await;
    for input in [
        json!({"igdb_id":1,"platform_id":169}),
        json!({"manual_title":"Manual Game","platform_id":169}),
    ] {
        let (_, saved) = f.call("POST", "/api/v1/wishlist", input.clone()).await;
        let id = saved["item"]["id"].as_str().unwrap();
        f.call(
            "POST",
            &format!("/api/v1/wishlist/{id}/purchase"),
            json!({}),
        )
        .await;
        assert_eq!(
            f.call("POST", "/api/v1/wishlist", input.clone()).await.0,
            StatusCode::CONFLICT
        );
        let mut confirmed = input;
        confirmed["confirm_owned"] = json!(true);
        let (status, restored) = f.call("POST", "/api/v1/wishlist", confirmed).await;
        assert_eq!(status, StatusCode::CREATED);
        assert_eq!(restored["item"]["id"], id);
        assert_eq!(
            f.call("GET", "/api/v1/library", Value::Null).await.1,
            json!([])
        );
    }
}

#[tokio::test]
async fn wishlist_price_scope_defaults_and_validates() {
    let f = Fixture::new().await;
    let (_, mut settings) = f.call("GET", "/api/v1/settings", Value::Null).await;
    assert_eq!(settings["wishlist_price_scope"], "preferred");
    assert!(
        settings["sources"]
            .as_array()
            .unwrap()
            .iter()
            .all(|s| s["poll_interval_seconds"] == 28800)
    );
    settings["wishlist_price_scope"] = json!("all");
    assert_eq!(
        f.call("PUT", "/api/v1/settings", settings.clone()).await.1["wishlist_price_scope"],
        "all"
    );
    settings["wishlist_price_scope"] = json!("invalid");
    assert_eq!(
        f.call("PUT", "/api/v1/settings", settings).await.0,
        StatusCode::BAD_REQUEST
    );
}

#[tokio::test]
async fn automatic_checks_can_be_paused_and_resumed() {
    let f = Fixture::new().await;
    let (_, status) = f.call("GET", "/api/v1/status/fetch", Value::Null).await;
    assert!(status["paused_at"].is_null());
    let (code, paused) = f
        .call(
            "POST",
            "/api/v1/status/fetch/pause",
            json!({"paused": true}),
        )
        .await;
    assert_eq!(code, StatusCode::OK);
    let since = paused["paused_at"].as_i64().unwrap();
    // Pausing again keeps the start of the pause.
    let (_, again) = f
        .call(
            "POST",
            "/api/v1/status/fetch/pause",
            json!({"paused": true}),
        )
        .await;
    assert_eq!(again["paused_at"].as_i64(), Some(since));
    let (_, status) = f.call("GET", "/api/v1/status/fetch", Value::Null).await;
    assert_eq!(status["paused_at"].as_i64(), Some(since));
    let (_, resumed) = f
        .call(
            "POST",
            "/api/v1/status/fetch/pause",
            json!({"paused": false}),
        )
        .await;
    assert!(resumed["paused_at"].is_null());
    assert_eq!(
        f.call(
            "POST",
            "/api/v1/status/fetch/pause",
            json!({"paused": "yes"})
        )
        .await
        .0,
        StatusCode::BAD_REQUEST
    );
}

#[tokio::test]
async fn wishlist_columns_can_be_hidden_and_the_opener_chosen() {
    let f = Fixture::new().await;
    let (_, mut settings) = f.call("GET", "/api/v1/settings", Value::Null).await;
    assert_eq!(settings["wishlist_hidden"], json!([]));
    assert_eq!(settings["wishlist_open"], "button");
    settings["wishlist_hidden"] = json!(["trend", "target"]);
    settings["wishlist_open"] = json!("title");
    let (code, saved) = f.call("PUT", "/api/v1/settings", settings.clone()).await;
    assert_eq!(code, StatusCode::OK);
    assert_eq!(saved["wishlist_hidden"], json!(["trend", "target"]));
    assert_eq!(saved["wishlist_open"], "title");
    // Without the details button the button column may be hidden, the game column (title, cover) not.
    settings["wishlist_hidden"] = json!(["open"]);
    assert_eq!(
        f.call("PUT", "/api/v1/settings", settings.clone()).await.0,
        StatusCode::OK
    );
    for (hidden, open) in [
        (json!(["game"]), "title"),
        (json!(["game"]), "cover"),
        (json!(["open"]), "button"),
        (json!(["trend", "trend"]), "button"),
        (json!(["sparkline"]), "button"),
        (json!([]), "row"),
    ] {
        settings["wishlist_hidden"] = hidden;
        settings["wishlist_open"] = json!(open);
        assert_eq!(
            f.call("PUT", "/api/v1/settings", settings.clone()).await.0,
            StatusCode::BAD_REQUEST
        );
    }
    // A client that sends neither keeps both.
    let mut without = settings.clone();
    let object = without.as_object_mut().unwrap();
    object.remove("wishlist_hidden");
    object.remove("wishlist_open");
    let (_, kept) = f.call("PUT", "/api/v1/settings", without).await;
    assert_eq!(kept["wishlist_hidden"], json!(["open"]));
    assert_eq!(kept["wishlist_open"], "title");
}

#[tokio::test]
async fn wishlist_column_order_defaults_saves_and_validates() {
    let f = Fixture::new().await;
    let (_, mut settings) = f.call("GET", "/api/v1/settings", Value::Null).await;
    assert_eq!(
        settings["wishlist_columns"],
        json!([
            "game", "price", "world", "save", "target", "status", "trend", "open"
        ])
    );
    let order = json!([
        "open", "game", "price", "world", "save", "target", "status", "trend"
    ]);
    settings["wishlist_columns"] = order.clone();
    assert_eq!(
        f.call("PUT", "/api/v1/settings", settings.clone()).await.1["wishlist_columns"],
        order
    );
    // A client that does not send the order keeps the stored one.
    let mut without = settings.clone();
    without.as_object_mut().unwrap().remove("wishlist_columns");
    assert_eq!(
        f.call("PUT", "/api/v1/settings", without).await.1["wishlist_columns"],
        order
    );
    for bad in [
        json!(["open", "game"]),
        json!([
            "open", "open", "price", "world", "save", "target", "status", "trend"
        ]),
        json!([
            "open", "game", "price", "world", "save", "target", "status", "cover"
        ]),
    ] {
        settings["wishlist_columns"] = bad;
        assert_eq!(
            f.call("PUT", "/api/v1/settings", settings.clone()).await.0,
            StatusCode::BAD_REQUEST
        );
    }
}

#[tokio::test]
async fn saving_unchanged_interval_preserves_schedule_and_edited_interval_reschedules() {
    let f = Fixture::new().await;
    let (_, item) = f
        .call(
            "POST",
            "/api/v1/wishlist",
            json!({"igdb_id":1,"platform_id":169}),
        )
        .await;
    let pool = sqlx::SqlitePool::connect_with(
        sqlx::sqlite::SqliteConnectOptions::new().filename(f.config.data_dir.join("keyhunter.db")),
    )
    .await
    .unwrap();
    let t = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs() as i64;
    let link:i64=sqlx::query_scalar("INSERT INTO offer_link(wish_id,source,url,observed_at) VALUES(?,'eneba','https://www.eneba.com/test',?) RETURNING id")
        .bind(item["item"]["id"].as_str().unwrap()).bind(t).fetch_one(&pool).await.unwrap();
    sqlx::query("INSERT INTO shop_job(source,link_id,due) VALUES('eneba',?,?)")
        .bind(link)
        .bind(t + 40000)
        .execute(&pool)
        .await
        .unwrap();
    let (_, mut settings) = f.call("GET", "/api/v1/settings", Value::Null).await;
    f.call("PUT", "/api/v1/settings", settings.clone()).await;
    let due: i64 = sqlx::query_scalar("SELECT due FROM shop_job WHERE link_id=?")
        .bind(link)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(due, t + 40000);
    settings["sources"][0]["poll_interval_seconds"] = json!(36000);
    assert_eq!(
        f.call("PUT", "/api/v1/settings", settings).await.0,
        StatusCode::OK
    );
    let due: i64 = sqlx::query_scalar("SELECT due FROM shop_job WHERE link_id=?")
        .bind(link)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(due, t + 36000);
}

#[tokio::test]
async fn library_restore_at_capacity_keeps_ownership_until_space_is_available() {
    let f = Fixture::new().await;
    let (_, saved) = f
        .call(
            "POST",
            "/api/v1/wishlist",
            json!({"igdb_id":1,"platform_id":169}),
        )
        .await;
    let id = saved["item"]["id"].as_str().unwrap();
    assert_eq!(
        request(&f.app, "GET", "/api/v1/library", Value::Null, None, None)
            .await
            .0,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        request(
            &f.app,
            "POST",
            &format!("/api/v1/wishlist/{id}/purchase"),
            json!({}),
            Some(&f.cookie),
            None
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    f.call(
        "POST",
        &format!("/api/v1/wishlist/{id}/purchase"),
        json!({}),
    )
    .await;
    for other in [5, 6] {
        assert_eq!(
            f.call(
                "POST",
                "/api/v1/wishlist",
                json!({"igdb_id":other,"platform_id":169})
            )
            .await
            .0,
            StatusCode::CREATED,
            "Remasters and sequels are not the owned edition family"
        );
    }
    let pool = sqlx::SqlitePool::connect_with(
        sqlx::sqlite::SqliteConnectOptions::new().filename(f.config.data_dir.join("keyhunter.db")),
    )
    .await
    .unwrap();
    for n in 0..98 {
        let key = format!("capacity-{n}");
        sqlx::query("INSERT INTO game(id,manual_title,manual_key,created_at) VALUES(?,?,?,1)")
            .bind(&key)
            .bind(&key)
            .bind(&key)
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query(
            "INSERT INTO wishlist_item(id,game_id,platform_id,created_at) VALUES(?,?,169,1)",
        )
        .bind(&key)
        .bind(&key)
        .execute(&pool)
        .await
        .unwrap();
    }
    let path = format!("/api/v1/library/{id}/restore");
    assert_eq!(
        f.call("POST", &path, json!({"confirm":true})).await.0,
        StatusCode::CONFLICT
    );
    assert_eq!(
        f.call("GET", "/api/v1/library", Value::Null).await.1[0]["id"],
        id
    );
    sqlx::query("DELETE FROM wishlist_item WHERE id='capacity-0'")
        .execute(&pool)
        .await
        .unwrap();
    assert_eq!(
        f.call("POST", &path, json!({"confirm":true})).await.0,
        StatusCode::NO_CONTENT
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
async fn saved_badges_distinguish_unqueried_empty_error_and_retained_observations() {
    let f = Fixture::new().await;
    let (_, saved) = f
        .call(
            "POST",
            "/api/v1/wishlist",
            json!({"igdb_id":1,"platform_id":169}),
        )
        .await;
    let id = saved["item"]["id"].as_str().unwrap();
    let badges = "/api/v1/wishlist/price-badges";
    assert_eq!(
        f.call("GET", badges, Value::Null).await.1[id]["state"],
        "unknown"
    );
    let pool = sqlx::SqlitePool::connect_with(
        sqlx::sqlite::SqliteConnectOptions::new().filename(f.config.data_dir.join("keyhunter.db")),
    )
    .await
    .unwrap();
    let t = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs() as i64;
    sqlx::query("UPDATE shop_job SET checked_at=? WHERE wish_id=?")
        .bind(t)
        .bind(id)
        .execute(&pool)
        .await
        .unwrap();
    assert_eq!(
        f.call("GET", badges, Value::Null).await.1[id]["state"],
        "no_offer"
    );
    sqlx::query("UPDATE shop_job SET last_error='network' WHERE wish_id=?")
        .bind(id)
        .execute(&pool)
        .await
        .unwrap();
    assert_eq!(
        f.call("GET", badges, Value::Null).await.1[id]["state"],
        "error"
    );
    let product = json!({"id":"fixture","name":"Example","title":"Example","platform_ids":[169],"key_game":true,"region":"Global","allowed":["DE"],"blocked":[],"purchase_country":"DE","offers":[{"id":"quote","cents":1250,"seller":null}],"availability":"in_stock"});
    let link:i64=sqlx::query_scalar("INSERT INTO offer_link(wish_id,source,url,latest,observed_at) VALUES(?,'eneba','https://www.eneba.com/de/xbox-example-key-global',?,?) RETURNING id").bind(id).bind(product.to_string()).bind(t-90000).fetch_one(&pool).await.unwrap();
    let (_, mut settings) = f.call("GET", "/api/v1/settings", Value::Null).await;
    settings["target_country"] = json!("DE");
    f.call("PUT", "/api/v1/settings", settings.clone()).await;
    assert_eq!(
        f.call("GET", badges, Value::Null).await.1[id]["state"],
        "review"
    );
    f.call(
        "PUT",
        &format!("/api/v1/wishlist/{id}/offers/{link}"),
        json!({"decision":"confirmed"}),
    )
    .await;
    sqlx::query("UPDATE offer_link SET last_error='network',attempted_at=? WHERE id=?")
        .bind(t)
        .bind(link)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("UPDATE shop_state SET retry_at=? WHERE source='eneba'")
        .bind(t + 3600)
        .execute(&pool)
        .await
        .unwrap();
    let (_, data) = f.call("GET", badges, Value::Null).await;
    assert_eq!(data[id]["state"], "price");
    assert_eq!(data[id]["cents"], 1250);
    assert_eq!(data[id]["stale"], true);
    assert_eq!(data[id]["observed_at"], t - 90000);
    let (_, items) = f.call("GET", "/api/v1/wishlist", Value::Null).await;
    assert_eq!(
        items[0]["price_badge"]["cents"], 1250,
        "first list response already contains the saved price"
    );
    settings["target_country"] = json!("AT");
    f.call("PUT", "/api/v1/settings", settings.clone()).await;
    assert_eq!(
        f.call("GET", badges, Value::Null).await.1[id]["state"],
        "no_offer"
    );
    settings["wishlist_price_scope"] = json!("all");
    f.call("PUT", "/api/v1/settings", settings.clone()).await;
    // The stored scope no longer widens the badge (0.6.1): still nothing valid in AT, and the
    // world comparison only uses current observations, so the day-old price is not repeated there.
    let (_, shown) = f.call("GET", badges, Value::Null).await;
    assert_eq!(shown[id]["state"], "no_offer");
    assert!(shown[id]["cents"].is_null(), "no price is valid in AT");
    assert!(shown[id]["world"].is_null());
    settings["target_country"] = json!("DE");
    f.call("PUT", "/api/v1/settings", settings).await;
    assert_eq!(
        f.call("GET", badges, Value::Null).await.1[id]["cents"],
        1250
    );
    sqlx::query(
        "UPDATE offer_link SET latest=json_set(latest,'$.availability','sold_out') WHERE id=?",
    )
    .bind(link)
    .execute(&pool)
    .await
    .unwrap();
    assert!(
        f.call("GET", badges, Value::Null).await.1[id]["cents"].is_null(),
        "a known withdrawal must not retain a sold-out price"
    );

    sqlx::query("UPDATE shop_state SET retry_at=0 WHERE source='eneba'")
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("UPDATE shop_job SET due=? WHERE wish_id=?")
        .bind(t + 3600)
        .bind(id)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("UPDATE offer_link SET review='rejected' WHERE id=?")
        .bind(link)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("INSERT OR REPLACE INTO shop_job(source,link_id,due) VALUES('eneba',?,0)")
        .bind(link)
        .execute(&pool)
        .await
        .unwrap();
    assert_eq!(
        f.call("GET", badges, Value::Null).await.1[id]["pending"],
        false,
        "a rejected product must not permanently trigger fast polling",
    );
}

#[tokio::test]
async fn preparing_all_editions_preserves_the_saved_selection_and_exposes_preview_badges() {
    let f = Fixture::new().await;
    let (_, saved) = f
        .call(
            "POST",
            "/api/v1/wishlist",
            json!({"igdb_id":1,"platform_id":169}),
        )
        .await;
    let id = saved["item"]["id"].as_str().unwrap();
    let path = format!("/api/v1/wishlist/{id}/editions");
    let (status, prepared) = f.call("POST", &path, json!({})).await;
    assert_eq!(status, StatusCode::OK);
    let items = prepared["items"].as_array().unwrap();
    assert_eq!(items.len(), 2);
    let premium = items.iter().find(|i| i["game"]["igdb_id"] == 2).unwrap();
    let preview_id = premium["id"].as_str().unwrap();
    assert_eq!(premium["price_badge"]["state"], "unknown");
    assert_eq!(
        f.call("GET", "/api/v1/wishlist", Value::Null)
            .await
            .1
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert_eq!(
        f.call("GET", "/api/v1/wishlist/price-badges", Value::Null)
            .await
            .1[preview_id]["state"],
        "unknown"
    );
    let pool = sqlx::SqlitePool::connect_with(
        sqlx::sqlite::SqliteConnectOptions::new().filename(f.config.data_dir.join("keyhunter.db")),
    )
    .await
    .unwrap();
    let t = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs() as i64;
    let product = json!({"id":"premium-fixture","name":"Example Premium","title":"Example Premium","platform_ids":[169],"key_game":true,"region":"Global","allowed":["DE"],"blocked":[],"purchase_country":"DE","offers":[{"id":"premium","cents":2345,"seller":null}],"availability":"in_stock"});
    let link:i64=sqlx::query_scalar("INSERT INTO offer_link(wish_id,source,url,latest,observed_at) VALUES(?,'eneba','https://www.eneba.com/de/xbox-example-premium-key-global',?,?) RETURNING id").bind(preview_id).bind(product.to_string()).bind(t).fetch_one(&pool).await.unwrap();
    let (_, mut settings) = f.call("GET", "/api/v1/settings", Value::Null).await;
    settings["target_country"] = json!("DE");
    f.call("PUT", "/api/v1/settings", settings).await;
    assert_eq!(
        f.call(
            "PUT",
            &format!("/api/v1/wishlist/{preview_id}/offers/{link}"),
            json!({"decision":"confirmed"})
        )
        .await
        .0,
        StatusCode::NO_CONTENT
    );
    assert_eq!(
        f.call("GET", "/api/v1/wishlist/price-badges", Value::Null)
            .await
            .1[preview_id]["cents"],
        2345
    );
    assert_eq!(
        f.call("GET", "/api/v1/wishlist", Value::Null).await.1[0]["price_badge"]["state"],
        "unknown",
        "preview price must not replace the saved base edition price"
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM shop_job WHERE wish_id=?")
            .bind(preview_id)
            .fetch_one(&pool)
            .await
            .unwrap(),
        1
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM edition_watch WHERE wish_id=?")
            .bind(id)
            .fetch_one(&pool)
            .await
            .unwrap(),
        1
    );
    let scoped = format!("/api/v1/wishlist/price-badges?anchor={id}");
    assert_eq!(
        f.call("GET", &scoped, Value::Null).await.1[preview_id]["cents"],
        2345
    );
    assert!(
        f.call("GET", "/api/v1/wishlist/price-badges?anchor=", Value::Null)
            .await
            .1
            .get(preview_id)
            .is_none()
    );
    let (_, again) = f.call("POST", &path, json!({})).await;
    assert_eq!(again["items"].as_array().unwrap().len(), 2);
    let (status, promoted) = f
        .call(
            "POST",
            "/api/v1/wishlist",
            json!({"igdb_id":2,"platform_id":169}),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED);
    assert_eq!(promoted["item"]["id"], preview_id);
    assert_eq!(
        f.call(
            "DELETE",
            &format!("/api/v1/wishlist/{preview_id}"),
            Value::Null
        )
        .await
        .0,
        StatusCode::NO_CONTENT
    );
    let (_, retained) = f.call("GET", &path, Value::Null).await;
    assert!(
        retained["items"]
            .as_array()
            .unwrap()
            .iter()
            .any(|entry| entry["id"] == preview_id && entry["price_badge"]["cents"] == 2345),
        "removing a saved edition must preserve its observations when another saved game still needs its preview"
    );
    sqlx::query(
        "UPDATE shop_job SET lease_until=9999999999,lease_token='inflight-edition' WHERE wish_id=?",
    )
    .bind(preview_id)
    .execute(&pool)
    .await
    .unwrap();
    f.call(
        "POST",
        &format!("/api/v1/wishlist/{id}/purchase"),
        json!({}),
    )
    .await;
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT lease_until FROM shop_job WHERE wish_id=?")
            .bind(preview_id)
            .fetch_one(&pool)
            .await
            .unwrap(),
        0,
        "buying the anchor revokes in-flight preview work"
    );
    assert_eq!(
        f.call("GET", &path, Value::Null).await.0,
        StatusCode::NOT_FOUND
    );
}

#[tokio::test]
async fn fetch_status_reports_queue_budget_and_requested_refreshes() {
    let fx = Fixture::new().await;
    let (s, _, _) = request(
        &fx.app,
        "GET",
        "/api/v1/status/fetch",
        Value::Null,
        None,
        None,
    )
    .await;
    assert_eq!(s, StatusCode::UNAUTHORIZED);

    let (s, wish) = fx
        .call(
            "POST",
            "/api/v1/wishlist",
            json!({"igdb_id":1,"platform_id":169}),
        )
        .await;
    assert!(s.is_success(), "{wish}");
    let (s, status) = fx.call("GET", "/api/v1/status/fetch", Value::Null).await;
    assert_eq!(s, StatusCode::OK, "{status}");
    let eneba = status["shops"]
        .as_array()
        .unwrap()
        .iter()
        .find(|shop| shop["source"] == "eneba")
        .expect("eneba is listed");
    assert_eq!(eneba["budget"]["used"], 0);
    assert!(eneba["budget"]["limit"].as_i64().unwrap() > 0);
    assert_eq!(
        eneba["backlog"]["searches"], 1,
        "the new wish waits for its first search"
    );
    assert_eq!(status["errors_24h"], 0);
    assert_eq!(status["recent_runs"], json!([]));

    let (s, ready, _) = request(&fx.app, "GET", "/health/ready", Value::Null, None, None).await;
    assert_eq!(s, StatusCode::OK, "{ready}");
}

#[tokio::test]
async fn removing_a_library_entry_deletes_it_instead_of_doing_nothing() {
    let f = Fixture::new().await;
    let (_, saved) = f
        .call(
            "POST",
            "/api/v1/wishlist",
            json!({"igdb_id":1,"platform_id":169}),
        )
        .await;
    let id = saved["item"]["id"].as_str().unwrap().to_string();
    let purchase = format!("/api/v1/wishlist/{id}/purchase");
    assert_eq!(
        f.call("POST", &purchase, json!({})).await.0,
        StatusCode::NO_CONTENT
    );
    assert_eq!(
        f.call("GET", "/api/v1/library", Value::Null).await.1[0]["id"],
        id
    );
    assert_eq!(
        f.call("DELETE", &format!("/api/v1/wishlist/{id}"), Value::Null)
            .await
            .0,
        StatusCode::NO_CONTENT
    );
    assert_eq!(
        f.call("GET", "/api/v1/library", Value::Null).await.1,
        json!([])
    );
    assert_eq!(
        f.call("GET", "/api/v1/wishlist", Value::Null).await.1,
        json!([])
    );
}

#[tokio::test]
async fn a_renamed_confirmed_product_keeps_its_price_and_shows_a_hint() {
    let f = Fixture::new().await;
    let (_, saved) = f
        .call(
            "POST",
            "/api/v1/wishlist",
            json!({"igdb_id":1,"platform_id":169}),
        )
        .await;
    let id = saved["item"]["id"].as_str().unwrap().to_string();
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
    let product = |name: &str| json!({"id":"fixture","name":name,"title":"Example","platform_ids":[169],"key_game":true,"region":"Global","allowed":["DE"],"blocked":[],"purchase_country":"DE","offers":[{"id":"quote","cents":1250,"seller":null}],"availability":"in_stock"});
    let link: i64 = sqlx::query_scalar("INSERT INTO offer_link(wish_id,source,url,latest,observed_at) VALUES(?,'eneba','https://www.eneba.com/de/xbox-example-key-global',?,?) RETURNING id")
        .bind(&id).bind(product("Example Xbox Key").to_string()).bind(t).fetch_one(&pool).await.unwrap();
    let offers = format!("/api/v1/wishlist/{id}/offers");
    f.call(
        "PUT",
        &format!("{offers}/{link}"),
        json!({"decision":"confirmed"}),
    )
    .await;
    assert_eq!(
        f.call("GET", &offers, Value::Null).await.1["links"][0]["renamed"],
        Value::Null
    );
    sqlx::query("UPDATE offer_link SET latest=? WHERE id=?")
        .bind(product("Example Xbox Key GLOBAL (2025)").to_string())
        .bind(link)
        .execute(&pool)
        .await
        .unwrap();
    let (_, view) = f.call("GET", &offers, Value::Null).await;
    assert_eq!(
        view["links"][0]["renamed"],
        json!({"from":"Example Xbox Key","to":"Example Xbox Key GLOBAL (2025)"})
    );
    assert_eq!(view["links"][0]["eligible"], true, "the price still counts");
    assert_eq!(view["best_base"], 1250);
    // Confirming again accepts the new title.
    f.call(
        "PUT",
        &format!("{offers}/{link}"),
        json!({"decision":"confirmed"}),
    )
    .await;
    assert_eq!(
        f.call("GET", &offers, Value::Null).await.1["links"][0]["renamed"],
        Value::Null
    );
}

#[tokio::test]
async fn a_product_that_does_not_match_can_be_confirmed_by_hand() {
    let f = Fixture::new().await;
    let (_, saved) = f
        .call(
            "POST",
            "/api/v1/wishlist",
            json!({"igdb_id":1,"platform_id":169}),
        )
        .await;
    let id = saved["item"]["id"].as_str().unwrap().to_string();
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
    // Found automatically, but the shop title differs from the catalog title: no automatic match.
    let product = |cents: i64| json!({"id":"fixture","name":"Example Deluxe Bundle Xbox Key","title":"Example Deluxe Bundle","platform_ids":[169],"key_game":true,"region":"Global","allowed":["DE"],"blocked":[],"purchase_country":"DE","offers":[{"id":"quote","cents":cents,"seller":null}],"availability":"in_stock"});
    let link: i64 = sqlx::query_scalar("INSERT INTO offer_link(wish_id,source,url,latest,observed_at,auto_discovered) VALUES(?,'eneba','https://www.eneba.com/de/xbox-example-deluxe-key-global',?,?,1) RETURNING id")
        .bind(&id).bind(product(1250).to_string()).bind(t).fetch_one(&pool).await.unwrap();
    let offers = format!("/api/v1/wishlist/{id}/offers");
    let (_, view) = f.call("GET", &offers, Value::Null).await;
    assert_eq!(view["links"][0]["can_confirm"], false);
    assert_eq!(view["best_base"], Value::Null);
    // A plain confirmation is refused; the explicit one by the owner counts.
    let (status, _) = f
        .call(
            "PUT",
            &format!("{offers}/{link}"),
            json!({"decision":"confirmed"}),
        )
        .await;
    assert_eq!(status, StatusCode::CONFLICT);
    let (status, _) = f
        .call(
            "PUT",
            &format!("{offers}/{link}"),
            json!({"decision":"confirmed","manual":true}),
        )
        .await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    let (_, view) = f.call("GET", &offers, Value::Null).await;
    assert_eq!(view["links"][0]["review"], "confirmed");
    assert_eq!(view["links"][0]["manual_match"], true);
    assert_eq!(view["links"][0]["eligible"], true);
    assert_eq!(view["best_base"], 1250);
    let (_, badges) = f
        .call("GET", "/api/v1/wishlist/price-badges", Value::Null)
        .await;
    assert_eq!(badges[&id]["cents"], 1250);
    // Another product behind the link (new fingerprint) needs a new look, like every confirmation.
    sqlx::query("UPDATE offer_link SET latest=? WHERE id=?")
        .bind(
            product(1100)
                .to_string()
                .replace("\"id\":\"fixture\"", "\"id\":\"other\""),
        )
        .bind(link)
        .execute(&pool)
        .await
        .unwrap();
    let (_, view) = f.call("GET", &offers, Value::Null).await;
    assert_eq!(view["links"][0]["review"], "pending");
    assert_eq!(view["best_base"], Value::Null);
    let (_, badges) = f
        .call("GET", "/api/v1/wishlist/price-badges", Value::Null)
        .await;
    assert_eq!(badges[&id]["state"], "review");
    // Rejecting clears the manual match.
    f.call(
        "PUT",
        &format!("{offers}/{link}"),
        json!({"decision":"rejected"}),
    )
    .await;
    let manual: bool = sqlx::query_scalar("SELECT manual_match FROM offer_link WHERE id=?")
        .bind(link)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert!(!manual);
}

#[tokio::test]
async fn api_errors_carry_a_stable_code_next_to_the_message() {
    let f = Fixture::new().await;
    let (status, body, _) =
        request(&f.app, "GET", "/api/v1/wishlist", Value::Null, None, None).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert_eq!(body["code"], "unauthenticated");
    assert!(body["error"].as_str().is_some_and(|m| !m.is_empty()));
    let (status, body) = f
        .call(
            "GET",
            "/api/v1/wishlist/00000000000000000000000000000000/offers",
            Value::Null,
        )
        .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(body["code"], "not_found");
}

#[tokio::test]
async fn badges_always_compare_the_target_country_with_the_cheapest_region() {
    let f = Fixture::new().await;
    let (_, saved) = f
        .call(
            "POST",
            "/api/v1/wishlist",
            json!({"igdb_id":1,"platform_id":169}),
        )
        .await;
    let id = saved["item"]["id"].as_str().unwrap().to_string();
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
    let offers = format!("/api/v1/wishlist/{id}/offers");
    for (product, region, allowed, cents) in [
        ("de", "Global", json!(["DE"]), 2890),
        ("in", "India", json!([]), 1290),
    ] {
        let latest = json!({"id":product,"name":"Example","title":"Example","platform_ids":[169],"key_game":true,"region":region,"allowed":allowed,"blocked":[],"purchase_country":"DE","offers":[{"id":product,"cents":cents,"seller":null}],"availability":"in_stock"});
        let link: i64 = sqlx::query_scalar("INSERT INTO offer_link(wish_id,source,url,latest,observed_at) VALUES(?,'eneba',?,?,?) RETURNING id")
            .bind(&id).bind(format!("https://www.eneba.com/de/xbox-example-{product}-key")).bind(latest.to_string()).bind(t)
            .fetch_one(&pool).await.unwrap();
        f.call(
            "PUT",
            &format!("{offers}/{link}"),
            json!({"decision":"confirmed"}),
        )
        .await;
    }
    let (_, badges) = f
        .call("GET", "/api/v1/wishlist/price-badges", Value::Null)
        .await;
    assert_eq!(
        badges[&id]["cents"], 2890,
        "the badge counts only offers valid in DE"
    );
    assert_eq!(badges[&id]["world"]["cents"], 1290);
    assert_eq!(badges[&id]["world"]["region"], "India");
    assert_eq!(badges[&id]["world"]["source"], "eneba");
    assert_eq!(
        badges[&id]["source"], "eneba",
        "the badge names the shop of its price"
    );
    assert!(badges[&id]["region"].is_string() || badges[&id]["region"].is_null());
    let (_, items) = f.call("GET", "/api/v1/wishlist", Value::Null).await;
    assert_eq!(items[0]["price_badge"]["world"]["cents"], 1290);
}

async fn fetch_budget(f: &Fixture) -> Value {
    let (_, status) = f.call("GET", "/api/v1/status/fetch", Value::Null).await;
    status["shops"]
        .as_array()
        .unwrap()
        .iter()
        .find(|shop| shop["source"] == "eneba")
        .unwrap()["budget"]
        .clone()
}

#[tokio::test]
async fn daily_jobs_setting_overrides_the_default_and_shows_in_the_fetch_status() {
    let f = Fixture::new().await;
    let (_, mut settings) = f.call("GET", "/api/v1/settings", Value::Null).await;
    let eneba = |settings: &Value| {
        settings["sources"]
            .as_array()
            .unwrap()
            .iter()
            .find(|s| s["id"] == "eneba")
            .unwrap()
            .clone()
    };
    let default = eneba(&settings)["daily_jobs_default"].as_i64().unwrap();
    assert_eq!(eneba(&settings)["daily_jobs"], default);
    let igdb = settings["sources"]
        .as_array()
        .unwrap()
        .iter()
        .find(|s| s["id"] == "igdb")
        .unwrap();
    assert!(igdb["daily_jobs"].is_null() && igdb["daily_jobs_default"].is_null());
    let budget = fetch_budget(&f).await;
    assert_eq!(budget["limit"], default);
    assert!(matches!(
        budget["limit_source"].as_str(),
        Some("env" | "default")
    ));
    assert_eq!(budget["by_hour"].as_array().unwrap().len(), 24);
    for key in ["used", "demand_per_day", "pace_seconds"] {
        assert!(budget[key].is_i64(), "{key}");
    }

    let set = |settings: &mut Value, value: Value| {
        for source in settings["sources"].as_array_mut().unwrap() {
            if source["id"] == "eneba" {
                source["daily_jobs"] = value.clone();
            }
        }
    };
    set(&mut settings, json!(800));
    let (code, saved) = f.call("PUT", "/api/v1/settings", settings.clone()).await;
    assert_eq!(code, StatusCode::OK);
    assert_eq!(eneba(&saved)["daily_jobs"], 800);
    let budget = fetch_budget(&f).await;
    assert_eq!(
        (budget["limit"].clone(), budget["limit_source"].clone()),
        (json!(800), json!("setting"))
    );
    for invalid in [json!(19), json!(2001), json!("viel")] {
        let mut changed = settings.clone();
        set(&mut changed, invalid);
        let code = f.call("PUT", "/api/v1/settings", changed).await.0;
        assert!(code.is_client_error(), "{code}");
    }
    let mut catalog = settings.clone();
    for source in catalog["sources"].as_array_mut().unwrap() {
        if source["id"] == "igdb" {
            source["daily_jobs"] = json!(100);
        }
    }
    assert_eq!(
        f.call("PUT", "/api/v1/settings", catalog).await.0,
        StatusCode::BAD_REQUEST
    );
    // Null (or the default) clears the setting; the shop follows the default again.
    for clear in [Value::Null, json!(default)] {
        set(&mut settings, json!(800));
        f.call("PUT", "/api/v1/settings", settings.clone()).await;
        set(&mut settings, clear);
        let (code, saved) = f.call("PUT", "/api/v1/settings", settings.clone()).await;
        assert_eq!(code, StatusCode::OK);
        assert_eq!(eneba(&saved)["daily_jobs"], default);
        assert_ne!(fetch_budget(&f).await["limit_source"], "setting");
    }
}

#[tokio::test]
async fn price_badges_carry_a_daily_target_country_trend() {
    let f = Fixture::new().await;
    let (_, saved) = f
        .call(
            "POST",
            "/api/v1/wishlist",
            json!({"igdb_id":1,"platform_id":169}),
        )
        .await;
    let id = saved["item"]["id"].as_str().unwrap().to_string();
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
    let today = t - t % 86400;
    let quotes = |cents: i64| json!([{"id":"q","cents":cents,"seller":null}]).to_string();
    let product = json!({"id":"global","name":"Example","title":"Example","platform_ids":[169],"key_game":true,"region":"Global","allowed":["DE"],"blocked":[],"purchase_country":"DE","offers":[{"id":"q","cents":1100,"seller":null}],"availability":"in_stock"});
    let link: i64 = sqlx::query_scalar("INSERT INTO offer_link(wish_id,source,url,latest,observed_at) VALUES(?,'eneba','https://www.eneba.com/de/xbox-example-xbox-live-key-global',?,?) RETURNING id")
        .bind(&id).bind(product.to_string()).bind(t - 60).fetch_one(&pool).await.unwrap();
    f.call(
        "PUT",
        &format!("/api/v1/wishlist/{id}/offers/{link}"),
        json!({"decision":"confirmed"}),
    )
    .await;
    let fingerprint: String = sqlx::query_scalar("SELECT fingerprint FROM offer_link WHERE id=?")
        .bind(link)
        .fetch_one(&pool)
        .await
        .unwrap();
    // Before the window, two observations on day 8, one not activatable in DE, today's price,
    // and an observation in another market that never counts.
    for (at, cents, market, activation) in [
        (today - 20 * 86400, 1500, "DE", "confirmed"),
        (today - 5 * 86400 + 100, 1300, "DE", "confirmed"),
        (today - 5 * 86400 + 200, 1200, "DE", "confirmed"),
        (today - 2 * 86400, 1000, "DE", "unknown"),
        (today - 86400, 500, "US", "confirmed"),
        (t - 60, 1100, "DE", "confirmed"),
    ] {
        sqlx::query("INSERT INTO price_observation(link_id,product_id,observed_at,market,fingerprint,offers,activation,availability) VALUES(?,'global',?,?,?,?,?,'in_stock')")
            .bind(link).bind(at).bind(market).bind(&fingerprint).bind(quotes(cents)).bind(activation).execute(&pool).await.unwrap();
    }
    let mut expected = vec![json!(1500); 8];
    expected.extend([json!(1200), json!(1200), json!(1200)]);
    expected.extend([Value::Null, Value::Null, json!(1100)]);
    let (_, badges) = f
        .call("GET", "/api/v1/wishlist/price-badges", Value::Null)
        .await;
    assert_eq!(badges[&id]["trend"], json!(expected));
    let (_, list) = f.call("GET", "/api/v1/wishlist", Value::Null).await;
    assert_eq!(list[0]["price_badge"]["trend"], json!(expected));
    // A new fetch (new observation and observation time of the link) updates the cached trend.
    sqlx::query("INSERT INTO price_observation(link_id,product_id,observed_at,market,fingerprint,offers,activation,availability) VALUES(?,'global',?,'DE',?,?,'confirmed','in_stock')")
        .bind(link).bind(t - 30).bind(&fingerprint).bind(quotes(900)).execute(&pool).await.unwrap();
    sqlx::query("UPDATE offer_link SET observed_at=? WHERE id=?")
        .bind(t - 30)
        .bind(link)
        .execute(&pool)
        .await
        .unwrap();
    expected[13] = json!(900);
    let (_, badges) = f
        .call("GET", "/api/v1/wishlist/price-badges", Value::Null)
        .await;
    assert_eq!(badges[&id]["trend"], json!(expected));
    // A rejected link no longer contributes.
    f.call(
        "PUT",
        &format!("/api/v1/wishlist/{id}/offers/{link}"),
        json!({"decision":"rejected"}),
    )
    .await;
    let (_, badges) = f
        .call("GET", "/api/v1/wishlist/price-badges", Value::Null)
        .await;
    assert_eq!(badges[&id]["trend"], json!(vec![Value::Null; 14]));
}

#[tokio::test]
async fn games_can_be_added_straight_to_the_library() {
    let f = Fixture::new().await;
    // A catalog game and a manual title go straight into the library, without a wish or a shop search.
    let (status, added) = f
        .call(
            "POST",
            "/api/v1/library",
            json!({"igdb_id":1,"platform_id":169}),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED);
    assert_eq!(added["created"], true);
    assert!(added["item"]["acquired_at"].as_i64().unwrap() > 0);
    let id = added["item"]["id"].as_str().unwrap().to_string();
    let (status, manual) = f
        .call(
            "POST",
            "/api/v1/library",
            json!({"manual_title":"Old Disc Game","platform_id":49}),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED);
    assert_eq!(manual["item"]["manual_title"], "Old Disc Game");
    let (_, owned) = f.call("GET", "/api/v1/library", Value::Null).await;
    assert_eq!(owned.as_array().unwrap().len(), 2);
    assert_eq!(
        f.call("GET", "/api/v1/wishlist", Value::Null).await.1,
        json!([])
    );
    let pool = sqlx::SqlitePool::connect_with(
        sqlx::sqlite::SqliteConnectOptions::new().filename(f.config.data_dir.join("keyhunter.db")),
    )
    .await
    .unwrap();
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM shop_job WHERE wish_id IS NOT NULL")
            .fetch_one(&pool)
            .await
            .unwrap(),
        0,
        "nothing is searched for a game already owned"
    );
    // Adding it again returns the same entry.
    let (status, again) = f
        .call(
            "POST",
            "/api/v1/library",
            json!({"igdb_id":1,"platform_id":169}),
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        (again["item"]["id"].as_str(), again["created"].clone()),
        (Some(id.as_str()), json!(false))
    );

    // A game on the wishlist moves over only after confirmation, as if bought; its alert stops.
    let (_, wish) = f
        .call(
            "POST",
            "/api/v1/wishlist",
            json!({"igdb_id":6,"platform_id":169}),
        )
        .await;
    let wish_id = wish["item"]["id"].as_str().unwrap().to_string();
    sqlx::query("INSERT INTO alert_rule(wish_id,mode,basis,enabled) VALUES(?,'low','base',1)")
        .bind(&wish_id)
        .execute(&pool)
        .await
        .unwrap();
    let input = json!({"igdb_id":6,"platform_id":169});
    let (status, warning) = f.call("POST", "/api/v1/library", input.clone()).await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(warning["code"], "wished_game");
    assert_eq!(
        f.call("GET", "/api/v1/wishlist", Value::Null).await.1[0]["id"],
        wish_id
    );
    let mut confirmed = input;
    confirmed["confirm_wished"] = json!(true);
    let (status, moved) = f.call("POST", "/api/v1/library", confirmed).await;
    assert_eq!(status, StatusCode::CREATED);
    assert_eq!(moved["item"]["id"], wish_id);
    assert_eq!(
        f.call("GET", "/api/v1/wishlist", Value::Null).await.1,
        json!([])
    );
    assert!(
        !sqlx::query_scalar::<_, bool>("SELECT enabled FROM alert_rule WHERE wish_id=?")
            .bind(&wish_id)
            .fetch_one(&pool)
            .await
            .unwrap()
    );
    // Same checks as the wishlist: unknown platform, empty title, both or neither field.
    for bad in [
        json!({"igdb_id":1,"platform_id":6}),
        json!({"manual_title":" ","platform_id":169}),
        json!({"igdb_id":1,"manual_title":"Both","platform_id":169}),
        json!({"platform_id":169}),
    ] {
        assert_eq!(
            f.call("POST", "/api/v1/library", bad).await.0,
            StatusCode::BAD_REQUEST
        );
    }
}

/// 0.7.3: a completely wrong mapping is deleted with its prices; the automatic search leaves it
/// out from then on, adding the link by hand brings it back.
#[tokio::test]
async fn wrong_mappings_can_be_deleted_and_added_back_by_hand() {
    let f = Fixture::new().await;
    let (_, saved) = f
        .call(
            "POST",
            "/api/v1/wishlist",
            json!({"igdb_id":1,"platform_id":169}),
        )
        .await;
    let id = saved["item"]["id"].as_str().unwrap();
    let url = "https://www.eneba.com/de/xbox-wrong-game-xbox-live-key-global";
    let offers = format!("/api/v1/wishlist/{id}/offers");
    assert_eq!(
        f.call("POST", &offers, json!({ "url": url })).await.0,
        StatusCode::ACCEPTED
    );
    let pool = sqlx::sqlite::SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(
            sqlx::sqlite::SqliteConnectOptions::new()
                .filename(f.config.data_dir.join("keyhunter.db")),
        )
        .await
        .unwrap();
    let link: i64 = sqlx::query_scalar("SELECT id FROM offer_link WHERE url=?")
        .bind(url)
        .fetch_one(&pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO price_observation(link_id,product_id,observed_at,market,fingerprint,offers,activation,availability) VALUES(?,'p',1,'DE','f','[]','unknown','in_stock')")
        .bind(link).execute(&pool).await.unwrap();

    let path = format!("/api/v1/wishlist/{id}/offers/{link}");
    assert_eq!(
        f.call("DELETE", &path, Value::Null).await.0,
        StatusCode::NO_CONTENT
    );
    assert_eq!(
        f.call("DELETE", &path, Value::Null).await.0,
        StatusCode::NOT_FOUND
    );
    for query in [
        "SELECT COUNT(*) FROM offer_link",
        "SELECT COUNT(*) FROM price_observation",
        "SELECT COUNT(*) FROM shop_job WHERE link_id IS NOT NULL",
    ] {
        assert_eq!(
            sqlx::query_scalar::<_, i64>(query)
                .fetch_one(&pool)
                .await
                .unwrap(),
            0,
            "{query}"
        );
    }
    let blocked: Vec<String> =
        sqlx::query_scalar("SELECT url FROM offer_link_block WHERE wish_id=?")
            .bind(id)
            .fetch_all(&pool)
            .await
            .unwrap();
    assert_eq!(blocked, [url]);
    assert!(
        f.call("GET", &offers, Value::Null).await.1["links"]
            .as_array()
            .unwrap()
            .is_empty()
    );

    // Added by hand again, the block is gone.
    assert_eq!(
        f.call("POST", &offers, json!({ "url": url })).await.0,
        StatusCode::ACCEPTED
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM offer_link_block")
            .fetch_one(&pool)
            .await
            .unwrap(),
        0
    );
    assert_eq!(
        f.call("GET", &offers, Value::Null).await.1["links"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
}

/// 0.7.3: the badge also carries the prices compared by estimated totals (switch "Mit Gebühren"),
/// and the estimated total of the base price shown.
#[tokio::test]
async fn badges_carry_prices_with_the_estimated_shop_fee() {
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
    for (region, cents) in [("Global", 1000), ("India", 800)] {
        let quotes = json!([{"id":region,"cents":cents,"seller":null}]);
        let product = json!({"id":region,"name":"Example","title":"Example","platform_ids":[169],"key_game":true,"region":region,"allowed":if region=="Global"{vec!["DE"]}else{vec![]},"blocked":[],"purchase_country":"DE","offers":quotes,"availability":"in_stock"});
        let link:i64=sqlx::query_scalar("INSERT INTO offer_link(wish_id,source,url,latest,observed_at) VALUES(?,'eneba',?,?,?) RETURNING id")
            .bind(id).bind(format!("https://www.eneba.com/de/xbox-example-xbox-live-key-{}",region.to_lowercase())).bind(product.to_string()).bind(t).fetch_one(&pool).await.unwrap();
        f.call(
            "PUT",
            &format!("/api/v1/wishlist/{id}/offers/{link}"),
            json!({"decision":"confirmed"}),
        )
        .await;
        let fingerprint: String =
            sqlx::query_scalar("SELECT fingerprint FROM offer_link WHERE id=?")
                .bind(link)
                .fetch_one(&pool)
                .await
                .unwrap();
        let activation = if region == "Global" {
            "confirmed"
        } else {
            "blocked"
        };
        sqlx::query("INSERT INTO price_observation(link_id,product_id,observed_at,market,fingerprint,offers,activation,availability) VALUES(?,?,?,'DE',?,?,?,'in_stock')")
            .bind(link).bind(region).bind(t).bind(&fingerprint).bind(quotes.to_string()).bind(activation).execute(&pool).await.unwrap();
    }
    let badges = "/api/v1/wishlist/price-badges";
    // Without a fee estimate the totals are unknown.
    let badge = &f.call("GET", badges, Value::Null).await.1[id];
    assert_eq!(badge["cents"], 1000);
    assert_eq!(badge["estimate_cents"], Value::Null);
    assert_eq!(badge["world"]["estimate_cents"], Value::Null);
    assert_eq!(badge["with_fees"]["cents"], Value::Null);
    assert_eq!(badge["with_fees"]["world"], Value::Null);

    sqlx::query(
        "UPDATE source_settings SET fee_estimation_enabled=1,fee_basis_points=1000 WHERE id='eneba'",
    )
    .execute(&pool)
    .await
    .unwrap();
    let badge = &f.call("GET", badges, Value::Null).await.1[id];
    assert_eq!(badge["cents"], 1000);
    assert_eq!(badge["estimate_cents"], 1100);
    assert_eq!(badge["world"]["cents"], 800);
    assert_eq!(badge["world"]["base_cents"], 800);
    assert_eq!(badge["world"]["estimate_cents"], 880);
    let fees = &badge["with_fees"];
    assert_eq!(fees["cents"], 1100);
    assert_eq!(fees["base_cents"], 1000);
    assert_eq!(fees["source"], "eneba");
    assert_eq!(fees["region"], "Global");
    assert_eq!(fees["world"]["cents"], 880);
    assert_eq!(fees["world"]["base_cents"], 800);
    assert_eq!(badge["trend"].as_array().unwrap().last().unwrap(), 1000);
    assert_eq!(fees["trend"].as_array().unwrap().last().unwrap(), 1100);
}

/// 0.8.0: the shopping cart holds each wish once, carries its live price badge, and loses a wish
/// that is bought or deleted.
#[tokio::test]
async fn the_cart_holds_each_wish_once_and_drops_bought_and_deleted_ones() {
    let f = Fixture::new().await;
    let mut ids = vec![];
    for igdb in [1, 6] {
        let (status, saved) = f
            .call(
                "POST",
                "/api/v1/wishlist",
                json!({"igdb_id":igdb,"platform_id":169,"confirm_owned":true}),
            )
            .await;
        assert!(status.is_success(), "{saved}");
        ids.push(saved["item"]["id"].as_str().unwrap().to_string());
    }
    let (a, b) = (&ids[0], &ids[1]);
    assert_eq!(
        f.call("GET", "/api/v1/cart", Value::Null).await.1,
        json!([])
    );
    for id in [b, a] {
        assert_eq!(
            f.call("POST", "/api/v1/cart", json!({ "wish_id": id }))
                .await
                .0,
            StatusCode::CREATED
        );
    }
    // Not twice, and only wishes.
    let (status, body) = f
        .call("POST", "/api/v1/cart", json!({ "wish_id": a }))
        .await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(body["error"], "Dieses Spiel liegt schon im Warenkorb.");
    assert_eq!(
        f.call("POST", "/api/v1/cart", json!({ "wish_id": "missing" }))
            .await
            .0,
        StatusCode::NOT_FOUND
    );
    let (_, cart) = f.call("GET", "/api/v1/cart", Value::Null).await;
    let order: Vec<&str> = cart
        .as_array()
        .unwrap()
        .iter()
        .map(|entry| entry["id"].as_str().unwrap())
        .collect();
    assert_eq!(order, [b.as_str(), a.as_str()], "oldest first");
    assert!(cart[0]["added_at"].is_i64());
    assert_eq!(cart[0]["in_cart"], true);
    assert!(cart[0]["price_badge"].is_object());
    let (_, list) = f.call("GET", "/api/v1/wishlist", Value::Null).await;
    assert!(
        list.as_array()
            .unwrap()
            .iter()
            .all(|item| item["in_cart"] == true)
    );

    // Bought: out of the cart, and it cannot come back while it is in the library.
    assert!(
        f.call("POST", &format!("/api/v1/wishlist/{a}/purchase"), json!({}))
            .await
            .0
            .is_success()
    );
    let (_, cart) = f.call("GET", "/api/v1/cart", Value::Null).await;
    assert_eq!(cart.as_array().unwrap().len(), 1);
    assert_eq!(cart[0]["id"], b.as_str());
    assert_eq!(
        f.call("POST", "/api/v1/cart", json!({ "wish_id": a }))
            .await
            .0,
        StatusCode::NOT_FOUND
    );
    let (_, library) = f.call("GET", "/api/v1/library", Value::Null).await;
    assert_eq!(library[0]["in_cart"], false);

    // Taken out by hand, then put back and the wish deleted.
    let path = format!("/api/v1/cart/{b}");
    assert_eq!(
        f.call("DELETE", &path, Value::Null).await.0,
        StatusCode::NO_CONTENT
    );
    assert_eq!(
        f.call("DELETE", &path, Value::Null).await.0,
        StatusCode::NOT_FOUND
    );
    f.call("POST", "/api/v1/cart", json!({ "wish_id": b }))
        .await;
    f.call("DELETE", &format!("/api/v1/wishlist/{b}"), Value::Null)
        .await;
    assert_eq!(
        f.call("GET", "/api/v1/cart", Value::Null).await.1,
        json!([])
    );
}
