//! FUNC-06, the contract between the Rust JSON and the TypeScript types. The shapes of the main responses (field
//! names, JSON types, required or optional, nullable) are checked in under `frontend/tests/contract/`; this test fails
//! when the backend changes one. `frontend/tests/contract.test.ts` checks the TypeScript types against them, so a field
//! renamed on either side breaks one of the two. After an intended change run
//! `KEYHUNTER_UPDATE_CONTRACT=1 cargo test --test contract` and commit the snapshots.
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
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};
use sqlx::{SqlitePool, sqlite::SqliteConnectOptions};
use std::{path::PathBuf, sync::Arc};
use tower::ServiceExt;

struct Provider;
fn game(id: i64) -> CatalogGame {
    CatalogGame {
        igdb_id: id,
        name: if id == 1 { "Example" } else { "Example Two" }.into(),
        slug: Some("example".into()),
        summary: Some("Summary".into()),
        first_release_date: Some(1_600_000_000),
        platforms: vec![Platform {
            id: 169,
            name: "Xbox Series X|S".into(),
        }],
        aliases: vec!["Alternative".into()],
        cover_url: Some("https://images.igdb.com/igdb/image/upload/t_cover_big/example.jpg".into()),
        artwork_url: None,
        store_product_id: None,
        version_parent: None,
        edition_name: None,
        kind: "base_game".into(),
        fetched_at: 1_794_940_000,
    }
}
#[async_trait]
impl CatalogProvider for Provider {
    async fn search(&self, _: &str, _: i64) -> Result<Vec<CatalogGame>, CatalogError> {
        Ok(vec![game(1), game(2)])
    }
    async fn game(&self, id: i64) -> Result<Option<CatalogGame>, CatalogError> {
        Ok((1..=2).contains(&id).then(|| game(id)))
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
    async fn call(&self, method: &str, path: &str, body: Value) -> (StatusCode, Value) {
        let mut req = Request::builder()
            .method(method)
            .uri(format!("/api/v1{path}"))
            .header("Origin", "http://localhost:3000")
            .header("Content-Type", "application/json")
            .header("Cookie", &self.cookie)
            .header("X-CSRF-Token", &self.csrf);
        if method == "GET" {
            req = req.header("Accept", "application/json");
        }
        let response = self
            .app
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
        let status = response.status();
        let bytes = to_bytes(response.into_body(), 4 * 1024 * 1024)
            .await
            .unwrap();
        (
            status,
            serde_json::from_slice(&bytes).unwrap_or(Value::Null),
        )
    }

    async fn ok(&self, method: &str, path: &str, body: Value) -> Value {
        let (status, data) = self.call(method, path, body).await;
        assert!(status.is_success(), "{method} {path}: {status} {data}");
        data
    }
}

fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs() as i64
}

/// The identity of a confirmed product (`Product::fingerprint`).
fn fingerprint(product_id: &str) -> String {
    Sha256::digest(json!([2, product_id, true, [169]]).to_string().as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// An app with wishes in every state that changes the shape of a response: a confirmed and a pending product, a
/// price history in several markets, a paused wish, a library item, a cart entry, an alert rule with a delivery.
/// Returns the ids of the wish with the price history and of the one with only a pending link.
async fn fixture() -> (tempfile::TempDir, Api, [String; 2]) {
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
                    json!({"token": token.trim(), "password": "contract test passphrase"})
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
    let mut settings = api.ok("GET", "/settings", Value::Null).await;
    settings["target_country"] = json!("DE");
    api.ok("PUT", "/settings", settings).await;

    let add = |body: Value| async {
        api.ok("POST", "/wishlist", body).await["item"]["id"]
            .as_str()
            .unwrap()
            .to_string()
    };
    let priced = add(json!({"igdb_id": 1, "platform_id": 169})).await;
    let pending = add(json!({"igdb_id": 2, "platform_id": 169})).await;
    let paused = add(json!({"manual_title": "Manual Game", "platform_id": 169})).await;
    api.ok(
        "PUT",
        &format!("/wishlist/{paused}/pause"),
        json!({"paused": true, "until": now() + 86400}),
    )
    .await;
    api.ok(
        "POST",
        "/library",
        json!({"manual_title": "Owned Game", "platform_id": 169}),
    )
    .await;
    api.ok(
        "PUT",
        &format!("/wishlist/{priced}/alert"),
        json!({"mode": "target", "basis": "base", "target_cents": 1500, "enabled": true}),
    )
    .await;
    api.ok("POST", "/cart", json!({"wish_id": priced})).await;

    let pool = SqlitePool::connect_with(
        SqliteConnectOptions::new().filename(config.data_dir.join("keyhunter.db")),
    )
    .await
    .unwrap();
    // Fee estimates only show up for a shop whose estimation is on.
    sqlx::query(
        "UPDATE source_settings SET fee_estimation_enabled=1,fee_basis_points=500 WHERE id='eneba'",
    )
    .execute(&pool)
    .await
    .unwrap();
    let t = now();
    let product = |id: &str, cents: i64| {
        json!({"id": id, "name": "Example", "title": "Example", "platform_ids": [169], "key_game": true,
            "region": "Global", "allowed": ["DE"], "blocked": [], "purchase_country": "DE",
            "offers": [{"id": "quote", "cents": cents, "seller": "Seller"}], "availability": "in_stock"})
        .to_string()
    };
    let link = |wish: &str,
                source: &str,
                url: &str,
                review: &str,
                fp: Option<String>,
                latest: String| {
        let pool = pool.clone();
        let confirmed_name = (review == "confirmed").then_some("Example");
        let (wish, source, url, review) = (
            wish.to_string(),
            source.to_string(),
            url.to_string(),
            review.to_string(),
        );
        async move {
            sqlx::query_scalar::<_, i64>(
                "INSERT INTO offer_link(wish_id,source,url,review,fingerprint,latest,observed_at,confirmed_name)
                VALUES(?,?,?,?,?,?,?,?) RETURNING id",
            )
            .bind(wish)
            .bind(source)
            .bind(url)
            .bind(review)
            .bind(fp)
            .bind(latest)
            .bind(t - 600)
            .bind(confirmed_name)
            .fetch_one(&pool)
            .await
            .unwrap()
        }
    };
    let confirmed = link(
        &priced,
        "eneba",
        "https://www.eneba.com/de/example-xbox-key-global",
        "confirmed",
        Some(fingerprint("p1")),
        product("p1", 1250),
    )
    .await;
    link(
        &priced,
        "driffle",
        "https://driffle.com/example-xbox-key-pl",
        "pending",
        None,
        product("p2", 1100),
    )
    .await;
    link(
        &pending,
        "eneba",
        "https://www.eneba.com/de/example-two-xbox-key-global",
        "pending",
        None,
        product("p3", 990),
    )
    .await;
    for (age, market, cents) in [
        (6 * 86400, "DE", 1500),
        (4 * 86400, "DE", 1400),
        (2 * 86400, "PL", 1100),
        (3600, "DE", 1250),
    ] {
        sqlx::query(
            "INSERT INTO price_observation(link_id,product_id,observed_at,market,fingerprint,offers,activation,availability)
            VALUES(?,'p1',?,?,?,?,'confirmed','in_stock')",
        )
        .bind(confirmed)
        .bind(t - age)
        .bind(market)
        .bind(fingerprint("p1"))
        .bind(json!([{"id": "quote", "cents": cents}]).to_string())
        .execute(&pool)
        .await
        .unwrap();
    }
    sqlx::query("UPDATE shop_job SET checked_at=? WHERE wish_id=?")
        .bind(t - 600)
        .bind(&priced)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query(
        "INSERT INTO alert_outbox(id,wish_id,scope,observed_at,cents,due,state,sent_at,game,mode,basis,reference_cents,shop,region,country,url)
        VALUES(1,?,'DE',?,1250,?,'sent',?,'Example','target','base',1500,'eneba','Global','DE','https://www.eneba.com/de/example-xbox-key-global')",
    )
    .bind(&priced)
    .bind(t - 100)
    .bind(t - 100)
    .bind(t - 90)
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query("INSERT INTO channel_delivery(outbox_id,channel,state,attempts,due,sent_at,error) VALUES(1,'ntfy','sent',1,?,?,NULL),(1,'telegram','failed',3,?,NULL,'HTTP 401')")
        .bind(t - 100)
        .bind(t - 90)
        .bind(t - 100)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("UPDATE notification_channel SET enabled=1 WHERE kind='ntfy'")
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO job_run(source,kind,wish_id,link_id,started_at,duration_ms,outcome) VALUES('eneba','product',?,?,?,150,'ok')")
        .bind(&priced)
        .bind(confirmed)
        .bind(t - 600)
        .execute(&pool)
        .await
        .unwrap();
    (dir, api, [priced, pending])
}

/// The shape of a JSON value: `{"kind": "scalar" | "object" | "array" | "map" | "unknown", "nullable": true?, ...}`.
fn shape(value: &Value) -> Value {
    match value {
        Value::Null => json!({"nullable": true}),
        Value::Bool(_) => json!({"kind": "scalar", "types": ["boolean"]}),
        Value::Number(_) => json!({"kind": "scalar", "types": ["number"]}),
        Value::String(_) => json!({"kind": "scalar", "types": ["string"]}),
        Value::Array(items) => {
            json!({"kind": "array", "items": items.iter().map(shape).reduce(merge).unwrap_or(json!({"kind": "unknown"}))})
        }
        Value::Object(fields) => {
            let fields: Map<_, _> = fields
                .iter()
                .map(|(k, v)| (k.clone(), json!({"required": true, "shape": shape(v)})))
                .collect();
            json!({"kind": "object", "fields": fields})
        }
    }
}

/// The shape both values fit: fields missing in one become optional, types are joined, null makes it nullable.
fn merge(a: Value, b: Value) -> Value {
    let nullable = a["nullable"] == true || b["nullable"] == true;
    let kind = |v: &Value| v["kind"].as_str().map(str::to_string);
    let mut merged = match (kind(&a), kind(&b)) {
        (None, None) => json!({}),
        (Some(_), None) => a,
        (None, Some(_)) => b,
        (Some(x), Some(_)) if x == "unknown" => b,
        (Some(_), Some(y)) if y == "unknown" => a,
        (Some(x), Some(y)) => {
            assert_eq!(x, y, "one field is both {x} and {y}");
            match x.as_str() {
                "scalar" => {
                    let mut types: Vec<Value> = a["types"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .chain(b["types"].as_array().unwrap())
                        .cloned()
                        .collect();
                    types.sort_by_key(|t| t.as_str().unwrap().to_string());
                    types.dedup();
                    json!({"kind": "scalar", "types": types})
                }
                "array" => {
                    json!({"kind": "array", "items": merge(a["items"].clone(), b["items"].clone())})
                }
                "map" => {
                    json!({"kind": "map", "values": merge(a["values"].clone(), b["values"].clone())})
                }
                _ => {
                    let (fa, fb) = (
                        a["fields"].as_object().unwrap(),
                        b["fields"].as_object().unwrap(),
                    );
                    let mut fields = Map::new();
                    for key in fa.keys().chain(fb.keys()) {
                        let entry = match (fa.get(key), fb.get(key)) {
                            (Some(x), Some(y)) => {
                                json!({"required": x["required"] == true && y["required"] == true, "shape": merge(x["shape"].clone(), y["shape"].clone())})
                            }
                            (Some(x), None) | (None, Some(x)) => {
                                json!({"required": false, "shape": x["shape"]})
                            }
                            (None, None) => unreachable!(),
                        };
                        fields.insert(key.clone(), entry);
                    }
                    json!({"kind": "object", "fields": fields})
                }
            }
        }
    };
    if nullable {
        merged["nullable"] = json!(true);
    }
    merged
}

/// An object whose keys are data (wish ids) becomes a map of its values.
fn as_map(shape: Value) -> Value {
    let values = shape["fields"]
        .as_object()
        .unwrap()
        .values()
        .map(|f| f["shape"].clone())
        .reduce(merge)
        .unwrap();
    json!({"kind": "map", "values": values})
}

fn check(name: &str, endpoint: &str, shape: Value) {
    let path: PathBuf = [
        env!("CARGO_MANIFEST_DIR"),
        "..",
        "frontend",
        "tests",
        "contract",
        &format!("{name}.json"),
    ]
    .iter()
    .collect();
    let text = serde_json::to_string_pretty(&json!({"endpoint": endpoint, "shape": shape}))
        .unwrap()
        + "\n";
    if std::env::var_os("KEYHUNTER_UPDATE_CONTRACT").is_some() {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, &text).unwrap();
        return;
    }
    let stored = std::fs::read_to_string(&path).unwrap_or_default();
    assert!(
        stored == text,
        "The JSON of `{endpoint}` no longer has the shape in {}. If the change is intended, run \
         `KEYHUNTER_UPDATE_CONTRACT=1 cargo test --test contract`, check that the TypeScript types in frontend/src follow \
         and commit the snapshot.\n--- stored\n{stored}\n--- now\n{text}",
        path.display()
    );
}

async fn get(api: &Api, path: &str) -> Value {
    api.ok("GET", path, Value::Null).await
}

#[tokio::test]
async fn the_main_responses_keep_the_shapes_the_frontend_types_are_checked_against_func06() {
    let (_dir, api, [priced, pending]) = fixture().await;

    let wishlist = get(&api, "/wishlist").await;
    assert_eq!(wishlist.as_array().unwrap().len(), 3);
    check("wishlist", "GET /wishlist", shape(&wishlist));
    check(
        "library",
        "GET /library",
        shape(&get(&api, "/library").await),
    );
    let badges = get(&api, "/wishlist/price-badges").await;
    assert_eq!(badges[&priced]["state"], "price", "{badges}");
    check(
        "price-badges",
        "GET /wishlist/price-badges",
        as_map(shape(&badges)),
    );
    // The price tab and the history tab read the same response.
    let offers = merge(
        shape(&get(&api, &format!("/wishlist/{priced}/offers")).await),
        shape(&get(&api, &format!("/wishlist/{pending}/offers")).await),
    );
    check("offers", "GET /wishlist/{id}/offers", offers);
    check(
        "fetch-status",
        "GET /status/fetch",
        shape(&get(&api, "/status/fetch").await),
    );
    check("counts", "GET /counts", shape(&get(&api, "/counts").await));
    let alerts = get(&api, "/alerts").await;
    assert!(!alerts["events"].as_array().unwrap().is_empty(), "{alerts}");
    check("alerts", "GET /alerts", shape(&alerts));
    let cart = get(&api, "/cart").await;
    assert_eq!(cart.as_array().unwrap().len(), 1, "{cart}");
    check("cart", "GET /cart", shape(&cart));
    check(
        "settings",
        "GET /settings",
        shape(&get(&api, "/settings").await),
    );
    let editions = get(&api, &format!("/wishlist/{priced}/editions")).await;
    assert_eq!(editions["items"].as_array().unwrap().len(), 1, "{editions}");
    check("editions", "GET /wishlist/{id}/editions", shape(&editions));
}
