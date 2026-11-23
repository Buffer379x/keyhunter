use axum::{
    Router,
    body::{Body, to_bytes},
    http::{Request, StatusCode},
};
use keyhunter::{config::Config, create_app};
use serde_json::{Value, json};
use tempfile::TempDir;
use tower::ServiceExt;

struct Fixture {
    _dir: TempDir,
    config: Config,
    app: Router,
    token: String,
}

impl Fixture {
    async fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let frontend = dir.path().join("frontend");
        std::fs::create_dir(&frontend).unwrap();
        std::fs::write(
            frontend.join("index.html"),
            "<!doctype html><title>KEYHUNTER</title>",
        )
        .unwrap();
        let config = Config {
            bind: "127.0.0.1:3000".parse().unwrap(),
            origin: Some("http://localhost:3000".into()),
            data_dir: dir.path().join("data"),
            frontend_dir: frontend,
            bootstrap_file: None,
            allow_insecure_http: true,
            trusted_proxies: vec![],
        };
        let app = create_app(config.clone()).await.unwrap();
        let token = std::fs::read_to_string(config.data_dir.join("bootstrap-token")).unwrap();
        Self {
            _dir: dir,
            config,
            app,
            token,
        }
    }
}

async fn call(
    app: &Router,
    method: &str,
    path: &str,
    body: Value,
    cookie: Option<&str>,
    csrf: Option<&str>,
    origin: Option<&str>,
) -> (StatusCode, Value, Option<String>) {
    let mut req = Request::builder()
        .method(method)
        .uri(path)
        .header("Content-Type", "application/json");
    if let Some(v) = cookie {
        req = req.header("Cookie", v);
    }
    if let Some(v) = csrf {
        req = req.header("X-CSRF-Token", v);
    }
    if let Some(v) = origin {
        req = req.header("Origin", v);
    }
    let response = app
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
    let cookie = response
        .headers()
        .get("Set-Cookie")
        .map(|v| v.to_str().unwrap().to_string());
    let bytes = to_bytes(response.into_body(), 1024 * 1024).await.unwrap();
    let data = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
    (status, data, cookie)
}

async fn setup(f: &Fixture) -> (String, String) {
    let (status, data, cookie) = call(
        &f.app,
        "POST",
        "/api/v1/setup",
        json!({"token": f.token.trim(), "password": "correct horse battery staple"}),
        None,
        None,
        Some("http://localhost:3000"),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    let cookie = cookie.unwrap();
    assert!(cookie.contains("HttpOnly") && cookie.contains("SameSite=Strict"));
    (
        cookie.split(';').next().unwrap().to_string(),
        data["csrf_token"].as_str().unwrap().to_string(),
    )
}

#[tokio::test]
async fn setup_requires_local_secret_and_is_single_use() {
    let f = Fixture::new().await;
    assert_eq!(
        call(
            &f.app,
            "GET",
            "/api/v1/settings",
            Value::Null,
            None,
            None,
            None
        )
        .await
        .0,
        StatusCode::UNAUTHORIZED
    );
    let body = json!({"token":f.token.trim(),"password":"correct horse battery staple"});
    assert_eq!(
        call(
            &f.app,
            "POST",
            "/api/v1/setup",
            body.clone(),
            None,
            None,
            Some("https://evil.example")
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        call(
            &f.app,
            "POST",
            "/api/v1/setup",
            json!({"token":"wrong","password":"correct horse battery staple"}),
            None,
            None,
            Some("http://localhost:3000")
        )
        .await
        .0,
        StatusCode::UNAUTHORIZED
    );
    let _ = setup(&f).await;
    assert_eq!(
        call(
            &f.app,
            "POST",
            "/api/v1/setup",
            body,
            None,
            None,
            Some("http://localhost:3000")
        )
        .await
        .0,
        StatusCode::CONFLICT
    );
    assert_eq!(
        call(
            &f.app,
            "GET",
            "/api/v1/setup",
            Value::Null,
            None,
            None,
            None
        )
        .await
        .1["required"],
        false
    );
}

#[tokio::test]
async fn settings_require_csrf_and_origin_and_survive_restart_atomically() {
    let f = Fixture::new().await;
    let (cookie, csrf) = setup(&f).await;
    let (_, mut settings, _) = call(
        &f.app,
        "GET",
        "/api/v1/settings",
        Value::Null,
        Some(&cookie),
        None,
        None,
    )
    .await;
    assert!(settings["target_country"].is_null());
    assert_eq!(settings["sources"][0]["fee_estimation_enabled"], false);
    settings["target_country"] = json!("DE");
    settings["sources"][0]["fee_estimation_enabled"] = json!(true);
    settings["sources"][0]["fee_basis_points"] = json!(250);
    assert_eq!(
        call(
            &f.app,
            "PUT",
            "/api/v1/settings",
            settings.clone(),
            Some(&cookie),
            None,
            Some("http://localhost:3000")
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        call(
            &f.app,
            "PUT",
            "/api/v1/settings",
            settings.clone(),
            Some(&cookie),
            Some(&csrf),
            Some("https://evil.example")
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        call(
            &f.app,
            "PUT",
            "/api/v1/settings",
            settings.clone(),
            Some(&cookie),
            Some(&csrf),
            Some("http://localhost:3000")
        )
        .await
        .0,
        StatusCode::OK
    );
    let mut invalid = settings.clone();
    invalid["target_country"] = json!("FR");
    invalid["sources"][0]["fee_basis_points"] = json!(-1);
    assert_eq!(
        call(
            &f.app,
            "PUT",
            "/api/v1/settings",
            invalid,
            Some(&cookie),
            Some(&csrf),
            Some("http://localhost:3000")
        )
        .await
        .0,
        StatusCode::BAD_REQUEST
    );
    let mut invalid = settings.clone();
    invalid["target_country"] = json!("XX");
    assert_eq!(
        call(
            &f.app,
            "PUT",
            "/api/v1/settings",
            invalid,
            Some(&cookie),
            Some(&csrf),
            Some("http://localhost:3000")
        )
        .await
        .0,
        StatusCode::BAD_REQUEST
    );
    let restarted = create_app(f.config.clone()).await.unwrap();
    let (status, persisted, _) = call(
        &restarted,
        "GET",
        "/api/v1/settings",
        Value::Null,
        Some(&cookie),
        None,
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(persisted["target_country"], "DE");
    assert_eq!(persisted["sources"][0]["fee_basis_points"], 250);
    assert_eq!(persisted["sources"][0]["fee_estimation_enabled"], true);
}

#[tokio::test]
async fn logout_revokes_cookie_and_login_issues_new_session() {
    let f = Fixture::new().await;
    let (cookie, csrf) = setup(&f).await;
    assert_eq!(
        call(
            &f.app,
            "DELETE",
            "/api/v1/session",
            Value::Null,
            Some(&cookie),
            Some(&csrf),
            Some("http://localhost:3000")
        )
        .await
        .0,
        StatusCode::NO_CONTENT
    );
    assert_eq!(
        call(
            &f.app,
            "GET",
            "/api/v1/me",
            Value::Null,
            Some(&cookie),
            None,
            None
        )
        .await
        .0,
        StatusCode::UNAUTHORIZED
    );
    let (status, data, new_cookie) = call(
        &f.app,
        "POST",
        "/api/v1/session",
        json!({"password":"correct horse battery staple"}),
        None,
        None,
        Some("http://localhost:3000"),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_ne!(data["csrf_token"], csrf);
    assert!(!new_cookie.unwrap().starts_with(&cookie));
}

#[tokio::test]
async fn invalid_logins_are_rate_limited_without_creating_sessions() {
    let f = Fixture::new().await;
    let _ = setup(&f).await;
    for _ in 0..5 {
        let (status, _, cookie) = call(
            &f.app,
            "POST",
            "/api/v1/session",
            json!({"password":"incorrect-password"}),
            None,
            None,
            Some("http://localhost:3000"),
        )
        .await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
        assert!(cookie.is_none());
    }
    assert_eq!(
        call(
            &f.app,
            "POST",
            "/api/v1/session",
            json!({"password":"incorrect-password"}),
            None,
            None,
            Some("http://localhost:3000")
        )
        .await
        .0,
        StatusCode::TOO_MANY_REQUESTS
    );
}

#[tokio::test]
async fn unknown_api_paths_are_not_spa_successes_and_health_is_available() {
    let f = Fixture::new().await;
    assert_eq!(
        call(
            &f.app,
            "GET",
            "/health/ready",
            Value::Null,
            None,
            None,
            None
        )
        .await
        .0,
        StatusCode::OK
    );
    assert_eq!(
        call(&f.app, "GET", "/api/unknown", Value::Null, None, None, None)
            .await
            .0,
        StatusCode::NOT_FOUND
    );
}

#[tokio::test]
async fn https_sessions_are_secure_and_forwarded_headers_cannot_bypass_origin() {
    let f = Fixture::new().await;
    let mut config = f.config.clone();
    config.origin = Some("https://keyhunter.example".into());
    config.allow_insecure_http = false;
    let app = create_app(config).await.unwrap();
    let body = json!({"token":f.token.trim(),"password":"correct horse battery staple"});
    assert_eq!(
        call(
            &app,
            "POST",
            "/api/v1/setup",
            body.clone(),
            None,
            None,
            Some("http://localhost:3000")
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    let (status, _, cookie) = call(
        &app,
        "POST",
        "/api/v1/setup",
        body,
        None,
        None,
        Some("https://keyhunter.example"),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    assert!(cookie.unwrap().contains("; Secure"));
    let response = app
        .oneshot(
            Request::builder()
                .uri("/api/v1/me")
                .header("X-Forwarded-For", "127.0.0.1")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    assert_eq!(response.headers()["Cache-Control"], "no-store");
    assert!(
        response.headers()["Content-Security-Policy"]
            .to_str()
            .unwrap()
            .contains("frame-ancestors 'none'")
    );
}

#[tokio::test]
async fn database_contains_hashes_and_current_sqlite_not_passwords_or_session_cookies() {
    let f = Fixture::new().await;
    let (cookie, _) = setup(&f).await;
    let options =
        sqlx::sqlite::SqliteConnectOptions::new().filename(f.config.data_dir.join("keyhunter.db"));
    let pool = sqlx::SqlitePool::connect_with(options).await.unwrap();
    let hash: String = sqlx::query_scalar("SELECT password_hash FROM owner")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert!(hash.starts_with("$argon2id$"));
    assert!(!hash.contains("correct horse"));
    let stored: String = sqlx::query_scalar("SELECT token_hash FROM session LIMIT 1")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_ne!(stored, cookie.strip_prefix("keyhunter_session=").unwrap());
    let version: String = sqlx::query_scalar("SELECT sqlite_version()")
        .fetch_one(&pool)
        .await
        .unwrap();
    let parts: Vec<u32> = version.split('.').map(|s| s.parse().unwrap()).collect();
    assert!(
        parts.as_slice() >= [3, 51, 3].as_slice(),
        "SQLite is older than the required WAL reset fix"
    );
    println!("Bundled SQLite version: {version}");
    use std::os::unix::fs::PermissionsExt;
    assert_eq!(
        std::fs::metadata(&f.config.data_dir)
            .unwrap()
            .permissions()
            .mode()
            & 0o077,
        0
    );
}

#[tokio::test]
async fn origin_pins_require_a_complete_url_without_path_or_credentials() {
    let f = Fixture::new().await;
    for origin in [
        "192.168.50.9",
        "https://keyhunter.example/path",
        "https://user:pass@keyhunter.example",
        "https://keyhunter.example?x=1",
    ] {
        let mut config = f.config.clone();
        config.origin = Some(origin.into());
        assert!(config.validate().is_err());
    }
}

#[tokio::test]
async fn igdb_credentials_are_write_only_and_protected() {
    let f = Fixture::new().await;
    let origin = Some("http://localhost:3000");
    let path = "/api/v1/settings/igdb";
    let rejected = json!({"client_id":"declined-fixture-id","client_secret":""});
    let (status, _, _) = call(&f.app, "PUT", path, rejected.clone(), None, None, origin).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);

    let (cookie, csrf) = setup(&f).await;
    let (status, _, _) = call(
        &f.app,
        "PUT",
        path,
        rejected.clone(),
        Some(&cookie),
        None,
        origin,
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    let (status, _, _) = call(
        &f.app,
        "DELETE",
        path,
        Value::Null,
        Some(&cookie),
        Some(&csrf),
        Some("https://evil.example"),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    let (status, data, _) = call(
        &f.app,
        "PUT",
        path,
        rejected,
        Some(&cookie),
        Some(&csrf),
        origin,
    )
    .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert!(!data.to_string().contains("declined-fixture-id"));
    let (status, data, _) = call(
        &f.app,
        "PUT",
        path,
        json!({"client_id":{"declined-fixture-id":1},"client_secret":true}),
        Some(&cookie),
        Some(&csrf),
        origin,
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert!(!data.to_string().contains("declined-fixture-id"));
    assert_eq!(
        call(&f.app, "GET", path, Value::Null, Some(&cookie), None, None)
            .await
            .0,
        StatusCode::METHOD_NOT_ALLOWED
    );
    assert!(!f.config.data_dir.join("igdb-credentials.json").exists());
    assert_eq!(
        call(
            &f.app,
            "DELETE",
            path,
            Value::Null,
            Some(&cookie),
            Some(&csrf),
            origin
        )
        .await
        .0,
        StatusCode::NO_CONTENT
    );
    let (_, data, _) = call(
        &f.app,
        "GET",
        "/api/v1/sources/status",
        Value::Null,
        Some(&cookie),
        None,
        None,
    )
    .await;
    assert_eq!(data["igdb"]["configured"], false);
    assert!(data["igdb"].get("client_id").is_none() && data["igdb"].get("client_secret").is_none());
}

#[tokio::test]
async fn lan_hostnames_are_accepted_over_http_but_public_names_are_not() {
    let f = Fixture::new().await;
    let mut config = f.config.clone();
    config.origin = None;
    let app = create_app(config).await.unwrap();
    let attempt = |host: &str, origin: &str| {
        Request::builder()
            .method("POST")
            .uri("/api/v1/session")
            .header("Host", host.to_string())
            .header("Origin", origin.to_string())
            .header("Content-Type", "application/json")
            .body(Body::from(r#"{"password":"x"}"#))
            .unwrap()
    };
    // Accepted names reach the login handler (not yet set up, so not 403).
    for (host, origin) in [
        ("tower:3000", "http://tower:3000"),
        ("keyhunter.local:3000", "http://keyhunter.local:3000"),
    ] {
        let status = app
            .clone()
            .oneshot(attempt(host, origin))
            .await
            .unwrap()
            .status();
        assert_ne!(status, StatusCode::FORBIDDEN, "{origin}");
    }
    for (host, origin) in [
        ("example.com", "http://example.com"),
        ("tower:3000", "http://tower:4000"),
        ("other:3000", "http://tower:3000"),
    ] {
        let response = app.clone().oneshot(attempt(host, origin)).await.unwrap();
        assert_eq!(response.status(), StatusCode::FORBIDDEN, "{origin}");
        let bytes = to_bytes(response.into_body(), 4096).await.unwrap();
        assert!(String::from_utf8_lossy(&bytes).contains("KEYHUNTER_ORIGIN"));
    }
}

#[tokio::test]
async fn setup_stores_optional_target_country_and_rejects_invalid_codes() {
    for (country, expected) in [
        (Some("AT"), Some("AT")),
        (None, None),
        (Some("XX"), Some("invalid")),
    ] {
        let f = Fixture::new().await;
        let mut body = json!({"token": f.token.trim(), "password": "correct horse battery staple"});
        if let Some(c) = country {
            body["target_country"] = json!(c);
        }
        let (status, data, cookie) = call(
            &f.app,
            "POST",
            "/api/v1/setup",
            body,
            None,
            None,
            Some("http://localhost:3000"),
        )
        .await;
        if expected == Some("invalid") {
            assert_eq!(status, StatusCode::BAD_REQUEST);
            let (status, _, _) = call(
                &f.app,
                "GET",
                "/api/v1/setup",
                Value::Null,
                None,
                None,
                None,
            )
            .await;
            assert_eq!(status, StatusCode::OK);
            continue;
        }
        assert_eq!(status, StatusCode::CREATED);
        let _ = data;
        let (status, settings, _) = call(
            &f.app,
            "GET",
            "/api/v1/settings",
            Value::Null,
            Some(cookie.unwrap().split(';').next().unwrap()),
            None,
            None,
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(settings["target_country"].as_str(), expected);
        // 0.9.0: every EU country counts like Germany (same market as the German shop pages).
        let confirmed = settings["confirmed_activation_countries"]
            .as_array()
            .unwrap();
        assert_eq!(confirmed.len(), 27);
        assert!(
            confirmed.contains(&json!("DE"))
                && confirmed.contains(&json!("AT"))
                && !confirmed.contains(&json!("CH"))
        );
    }
}

#[tokio::test]
async fn automatic_origin_supports_lan_http_and_proxy_https() {
    const LAN: &str = "192.168.50.9:3000";
    const WEB: &str = "keyhunter.example";
    let f = Fixture::new().await;
    let mut config = f.config.clone();
    config.origin = None;
    let app = create_app(config.clone()).await.unwrap();
    let setup = json!({"token":f.token.trim(),"password":"correct horse battery staple"});
    let setup_request = |host: &str, origin: &str| {
        Request::builder()
            .method("POST")
            .uri("/api/v1/setup")
            .header("Host", host)
            .header("Origin", origin)
            .header("Content-Type", "application/json")
    };

    for (host, origin) in [
        (LAN, "https://different.example"),
        (LAN, "http://192.168.50.9:4000"),
        (LAN, "null"),
        ("different.example", "http://different.example"),
    ] {
        let response = app
            .clone()
            .oneshot(
                setup_request(host, origin)
                    .header("X-Forwarded-Host", LAN)
                    .header("X-Forwarded-Proto", "https")
                    .body(Body::from(setup.to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::FORBIDDEN);
    }
    let response = app
        .clone()
        .oneshot(
            setup_request(LAN, "http://192.168.50.9:3000")
                .body(Body::from(setup.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::CREATED);
    let cookie = response.headers()["set-cookie"]
        .to_str()
        .unwrap()
        .to_owned();
    assert!(
        cookie.contains("HttpOnly")
            && cookie.contains("SameSite=Strict")
            && !cookie.contains("; Secure")
    );
    let cookie = cookie.split(';').next().unwrap();
    let bytes = to_bytes(response.into_body(), 1024).await.unwrap();
    let session: Value = serde_json::from_slice(&bytes).unwrap();
    let csrf = session["csrf_token"].as_str().unwrap();

    for (csrf, status) in [
        ("invalid", StatusCode::FORBIDDEN),
        (csrf, StatusCode::NO_CONTENT),
    ] {
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("DELETE")
                    .uri("/api/v1/session")
                    .header("Host", LAN)
                    .header("Origin", "http://192.168.50.9:3000")
                    .header("Cookie", cookie)
                    .header("X-CSRF-Token", csrf)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), status);
    }
    let login = r#"{"password":"correct horse battery staple"}"#;
    let secure_login = |site: &str| {
        Request::builder()
            .method("POST")
            .uri("/api/v1/session")
            .header("Host", WEB)
            .header("Origin", "https://keyhunter.example")
            .header("Sec-Fetch-Site", site)
            .header("Content-Type", "application/json")
            .body(Body::from(login))
            .unwrap()
    };
    assert_eq!(
        app.clone()
            .oneshot(secure_login("same-site"))
            .await
            .unwrap()
            .status(),
        StatusCode::FORBIDDEN
    );
    let response = app.oneshot(secure_login("same-origin")).await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert!(
        response.headers()["set-cookie"]
            .to_str()
            .unwrap()
            .contains("; Secure")
    );

    config.allow_insecure_http = false;
    let https_only = create_app(config).await.unwrap();
    let response = https_only
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/v1/session")
                .header("Host", LAN)
                .header("Origin", "http://192.168.50.9:3000")
                .header("Content-Type", "application/json")
                .body(Body::from(login))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::FORBIDDEN);
}

async fn get(f: &Fixture, cookie: &str, path: &str) -> (StatusCode, Value) {
    let (status, data, _) = call(&f.app, "GET", path, Value::Null, Some(cookie), None, None).await;
    (status, data)
}

#[tokio::test]
async fn the_log_records_logins_without_secrets_and_can_be_filtered_searched_and_paged() {
    let f = Fixture::new().await;
    let (cookie, _) = setup(&f).await;
    let login = |password: &'static str| {
        call(
            &f.app,
            "POST",
            "/api/v1/session",
            json!({ "password": password }),
            None,
            None,
            Some("http://localhost:3000"),
        )
    };
    assert_eq!(
        login("wrong passphrase secret").await.0,
        StatusCode::UNAUTHORIZED
    );
    let (status, warnings) = get(&f, &cookie, "/api/v1/log?level=warn").await;
    assert_eq!(status, StatusCode::OK, "{warnings}");
    assert_eq!(warnings["total"], 1);
    let entry = &warnings["entries"][0];
    assert_eq!(entry["level"], "warn");
    assert_eq!(entry["area"], "Anmeldung");
    assert_eq!(entry["message"], "Anmeldung fehlgeschlagen");
    assert!(entry["id"].is_i64() && entry["at"].is_i64());
    // A flood of rejected attempts is logged once.
    for _ in 0..6 {
        login("wrong passphrase secret").await;
    }
    let (_, all) = get(&f, &cookie, "/api/v1/log?per_page=200").await;
    let messages: Vec<&str> = all["entries"]
        .as_array()
        .unwrap()
        .iter()
        .map(|e| e["message"].as_str().unwrap())
        .collect();
    assert_eq!(
        messages
            .iter()
            .filter(|m| **m == "Zu viele Anmeldeversuche")
            .count(),
        1
    );
    assert!(messages.contains(&"Einrichtung abgeschlossen"));
    assert!(messages.contains(&concat!(
        "KeyHunter ",
        env!("CARGO_PKG_VERSION"),
        " gestartet"
    )));
    let text = all.to_string();
    for secret in [
        "wrong passphrase secret",
        "correct horse battery staple",
        f.token.trim(),
        cookie.trim_start_matches("keyhunter_session="),
    ] {
        assert!(!text.contains(secret), "the log contains a secret");
    }

    let pool = sqlx::SqlitePool::connect_with(
        sqlx::sqlite::SqliteConnectOptions::new().filename(f.config.data_dir.join("keyhunter.db")),
    )
    .await
    .unwrap();
    let t = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs() as i64;
    for n in 0..30 {
        sqlx::query("INSERT INTO event_log(at,level,area,message) VALUES(?,'info','Abruf',?)")
            .bind(t - n)
            .bind(format!("Eintrag {n}"))
            .execute(&pool)
            .await
            .unwrap();
    }
    sqlx::query("INSERT INTO event_log(at,level,area,message) VALUES(?,'error','Abruf','100% fehlgeschlagen')")
        .bind(t)
        .execute(&pool)
        .await
        .unwrap();
    let (_, page) = get(
        &f,
        &cookie,
        "/api/v1/log?level=info&q=EINTRAG&page=3&per_page=10",
    )
    .await;
    assert_eq!(page["total"], 30);
    assert_eq!(page["page"], 3);
    assert_eq!(page["per_page"], 10);
    assert_eq!(page["entries"].as_array().unwrap().len(), 10);
    assert_eq!(page["entries"][0]["message"], "Eintrag 20");
    // `%` is a literal character, not a wildcard; the area is searched too.
    let (_, percent) = get(&f, &cookie, "/api/v1/log?q=0%25").await;
    assert_eq!(percent["total"], 1);
    assert_eq!(percent["entries"][0]["message"], "100% fehlgeschlagen");
    let (_, area) = get(&f, &cookie, "/api/v1/log?q=abruf&level=error").await;
    assert_eq!(area["total"], 1);
    let (_, clamped) = get(&f, &cookie, "/api/v1/log?per_page=5&level=").await;
    assert_eq!(clamped["per_page"], 10);
    assert_eq!(clamped["page"], 1);
    for bad in ["?level=debug", "?page=x"] {
        let (status, error) = get(&f, &cookie, &format!("/api/v1/log{bad}")).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{bad}");
        assert_eq!(error["code"], "invalid_request");
    }
    let (status, _, _) = call(&f.app, "GET", "/api/v1/log", Value::Null, None, None, None).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
}

type Seen = std::sync::Arc<std::sync::Mutex<Vec<(String, Value)>>>;

/// A local stand-in for a webhook receiver: records every request and answers with `status`.
async fn hook_server(status: std::sync::Arc<std::sync::atomic::AtomicU16>) -> (String, Seen) {
    let seen: Seen = Default::default();
    let recorder = seen.clone();
    let router = Router::new().route(
        "/hook",
        axum::routing::post(
            move |headers: axum::http::HeaderMap, axum::Json(body): axum::Json<Value>| {
                let (recorder, status) = (recorder.clone(), status.clone());
                async move {
                    let auth = headers
                        .get("authorization")
                        .map_or(String::new(), |v| v.to_str().unwrap().to_owned());
                    recorder.lock().unwrap().push((auth, body));
                    StatusCode::from_u16(status.load(std::sync::atomic::Ordering::Relaxed)).unwrap()
                }
            },
        ),
    );
    let socket = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/hook", socket.local_addr().unwrap());
    tokio::spawn(async move { axum::serve(socket, router).await.unwrap() });
    (url, seen)
}

#[tokio::test]
async fn notification_channels_are_write_only_validated_and_testable() {
    let f = Fixture::new().await;
    let origin = Some("http://localhost:3000");
    let answer = std::sync::Arc::new(std::sync::atomic::AtomicU16::new(204));
    let (url, seen) = hook_server(answer.clone()).await;
    let token = "hook-secret-token-0815";
    let path = "/api/v1/alerts/channels/webhook";
    let body = json!({"enabled": true, "secrets": {"url": url, "token": token}});
    assert_eq!(
        call(
            &f.app,
            "GET",
            "/api/v1/alerts/channels",
            Value::Null,
            None,
            None,
            None
        )
        .await
        .0,
        StatusCode::UNAUTHORIZED
    );
    let (cookie, csrf) = setup(&f).await;
    let put = |body: Value| {
        call(
            &f.app,
            "PUT",
            path,
            body,
            Some(&cookie),
            Some(&csrf),
            origin,
        )
    };
    assert_eq!(
        call(
            &f.app,
            "PUT",
            path,
            body.clone(),
            Some(&cookie),
            None,
            origin
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    for bad in [
        json!({"enabled": true, "secrets": {"url": "ftp://127.0.0.1/hook"}}),
        json!({"enabled": true, "secrets": {"url": "http://user:pw@127.0.0.1/hook"}}),
        json!({"enabled": true, "secrets": {"url": "http://hooks.example.org/hook", "token": token}}),
        json!({"enabled": true, "secrets": {"password": token}}),
        json!({"enabled": true}),
    ] {
        let (status, data, _) = put(bad.clone()).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{bad}");
        assert!(!data.to_string().contains(token));
    }
    let (status, _, _) = call(
        &f.app,
        "PUT",
        "/api/v1/alerts/channels/sms",
        body.clone(),
        Some(&cookie),
        Some(&csrf),
        origin,
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    let (status, saved, _) = put(body).await;
    assert_eq!(status, StatusCode::OK, "{saved}");
    assert_eq!(saved["secrets"], json!({"url": true, "token": true}));
    assert_eq!(saved["active"], true);
    let (_, list) = get(&f, &cookie, "/api/v1/alerts/channels").await;
    let (_, alerts) = get(&f, &cookie, "/api/v1/alerts").await;
    assert_eq!(alerts["channels"], json!(["Webhook"]));
    assert_eq!(alerts["configured"], true);
    for shown in [&saved, &list, &alerts] {
        let text = shown.to_string();
        assert!(
            !text.contains(token) && !text.contains(&url),
            "a secret is returned: {text}"
        );
    }
    // The secret lies owner-only in the data directory, never in the database.
    use std::os::unix::fs::PermissionsExt;
    let file = f.config.data_dir.join("notification-secrets.json");
    assert_eq!(
        std::fs::metadata(&file).unwrap().permissions().mode() & 0o777,
        0o600
    );
    let database = std::fs::read(f.config.data_dir.join("keyhunter.db")).unwrap();
    assert!(!database.windows(token.len()).any(|w| w == token.as_bytes()));

    let test = "/api/v1/alerts/channels/webhook/test";
    let (status, data, _) = call(
        &f.app,
        "POST",
        test,
        Value::Null,
        Some(&cookie),
        Some(&csrf),
        origin,
    )
    .await;
    assert_eq!((status, data), (StatusCode::OK, json!({"ok": true})));
    let (auth, sent) = seen.lock().unwrap().pop().unwrap();
    assert_eq!(auth, format!("Bearer {token}"));
    assert_eq!(sent["event"], "test");
    assert_eq!(sent["title"], "KeyHunter: Testnachricht");
    answer.store(500, std::sync::atomic::Ordering::Relaxed);
    let (status, data, _) = call(
        &f.app,
        "POST",
        test,
        Value::Null,
        Some(&cookie),
        Some(&csrf),
        origin,
    )
    .await;
    assert_eq!(status, StatusCode::BAD_GATEWAY);
    assert_eq!(
        data["error"],
        "Testnachricht über Webhook fehlgeschlagen: HTTP 500 · Internal Server Error"
    );
    let (status, _, _) = call(
        &f.app,
        "POST",
        "/api/v1/alerts/channels/telegram/test",
        Value::Null,
        Some(&cookie),
        Some(&csrf),
        origin,
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT);
    let (_, log) = get(&f, &cookie, "/api/v1/log?per_page=200").await;
    let log = log.to_string();
    assert!(log.contains("Testnachricht über Webhook gesendet"));
    assert!(log.contains("Testnachricht über Webhook fehlgeschlagen (HTTP 500"));
    assert!(!log.contains(token) && !log.contains(&url));

    let (status, _, _) = call(
        &f.app,
        "DELETE",
        path,
        Value::Null,
        Some(&cookie),
        Some(&csrf),
        origin,
    )
    .await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    let (_, alerts) = get(&f, &cookie, "/api/v1/alerts").await;
    assert_eq!(alerts["configured"], false);
    assert!(!std::fs::read_to_string(&file).unwrap().contains(token));
}

const PASSPHRASE: &str = "correct horse battery staple";

/// A sign-in from the TCP peer `peer` (as `into_make_service_with_connect_info` provides it), optionally
/// with an `X-Forwarded-For` header.
async fn login_from(
    app: &Router,
    peer: &str,
    forwarded: Option<&str>,
    password: &str,
) -> StatusCode {
    let mut req = Request::builder()
        .method("POST")
        .uri("/api/v1/session")
        .header("Content-Type", "application/json")
        .header("Origin", "http://localhost:3000");
    if let Some(value) = forwarded {
        req = req.header("X-Forwarded-For", value);
    }
    let mut req = req
        .body(Body::from(json!({ "password": password }).to_string()))
        .unwrap();
    let addr: std::net::SocketAddr = format!("{peer}:50000").parse().unwrap();
    req.extensions_mut()
        .insert(axum::extract::ConnectInfo(addr));
    app.clone().oneshot(req).await.unwrap().status()
}

/// SEC-01: a source that guesses wrong is throttled on its own; the owner still signs in from elsewhere. Behind
/// a trusted proxy the forwarded client counts, without that option the proxy is one source.
#[tokio::test]
async fn a_guessing_source_cannot_lock_out_the_owner_sec01() {
    let f = Fixture::new().await;
    let _ = setup(&f).await;
    for _ in 0..5 {
        assert_eq!(
            login_from(&f.app, "192.168.1.66", None, "wrong guess").await,
            StatusCode::UNAUTHORIZED
        );
    }
    assert_eq!(
        login_from(&f.app, "192.168.1.66", None, PASSPHRASE).await,
        StatusCode::TOO_MANY_REQUESTS
    );
    assert_eq!(
        login_from(&f.app, "192.168.1.10", None, PASSPHRASE).await,
        StatusCode::OK
    );
    // A forwarded header from an untrusted peer changes nothing.
    assert_eq!(
        login_from(&f.app, "192.168.1.66", Some("192.168.1.10"), PASSPHRASE).await,
        StatusCode::TOO_MANY_REQUESTS
    );

    let mut config = f.config.clone();
    config.trusted_proxies = vec![keyhunter::config::Network::parse("172.18.0.0/16").unwrap()];
    let proxied = create_app(config).await.unwrap();
    for _ in 0..5 {
        login_from(&proxied, "172.18.0.2", Some("203.0.113.9"), "wrong guess").await;
    }
    assert_eq!(
        login_from(&proxied, "172.18.0.2", Some("203.0.113.9"), PASSPHRASE).await,
        StatusCode::TOO_MANY_REQUESTS
    );
    // An address the client put in front of its own does not count.
    assert_eq!(
        login_from(
            &proxied,
            "172.18.0.2",
            Some("198.51.100.7, 203.0.113.9"),
            PASSPHRASE
        )
        .await,
        StatusCode::TOO_MANY_REQUESTS
    );
    assert_eq!(
        login_from(&proxied, "172.18.0.2", Some("198.51.100.7"), PASSPHRASE).await,
        StatusCode::OK
    );

    // Without the option every request through the proxy is one source, as before.
    let unconfigured = create_app(f.config.clone()).await.unwrap();
    for _ in 0..5 {
        login_from(
            &unconfigured,
            "172.18.0.2",
            Some("203.0.113.9"),
            "wrong guess",
        )
        .await;
    }
    assert_eq!(
        login_from(
            &unconfigured,
            "172.18.0.2",
            Some("198.51.100.7"),
            PASSPHRASE
        )
        .await,
        StatusCode::TOO_MANY_REQUESTS
    );
}

/// SEC-02: clients that send the headers of a sign-in and then stay silent hold nothing the owner's sign-in
/// needs, and are cut off after the body timeout. Before, 16 of them blocked every further sign-in.
#[tokio::test]
async fn silent_request_bodies_cannot_block_the_sign_in_sec02() {
    use std::time::{Duration, Instant};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let f = Fixture::new().await;
    let _ = setup(&f).await;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let app = f.app.clone();
    tokio::spawn(async move {
        axum::serve(
            listener,
            app.into_make_service_with_connect_info::<std::net::SocketAddr>(),
        )
        .await
    });
    let head = |length: usize| {
        format!(
            "POST /api/v1/session HTTP/1.1\r\nHost: localhost:3000\r\nOrigin: http://localhost:3000\r\n\
            Content-Type: application/json\r\nContent-Length: {length}\r\nConnection: close\r\n\r\n"
        )
    };
    let mut silent = Vec::new();
    for _ in 0..24 {
        let mut stream = tokio::net::TcpStream::connect(addr).await.unwrap();
        stream
            .write_all(format!("{}{{", head(15000)).as_bytes())
            .await
            .unwrap();
        silent.push(stream);
    }
    tokio::time::sleep(Duration::from_millis(300)).await;
    let body = json!({ "password": PASSPHRASE }).to_string();
    let started = Instant::now();
    let mut stream = tokio::net::TcpStream::connect(addr).await.unwrap();
    stream
        .write_all(format!("{}{body}", head(body.len())).as_bytes())
        .await
        .unwrap();
    let mut response = String::new();
    tokio::time::timeout(
        Duration::from_secs(10),
        stream.read_to_string(&mut response),
    )
    .await
    .expect("the sign-in waits behind the silent requests")
    .unwrap();
    assert!(response.starts_with("HTTP/1.1 200"), "{response}");
    assert!(started.elapsed() < Duration::from_secs(5));
    let mut first = String::new();
    tokio::time::timeout(
        Duration::from_secs(25),
        silent[0].read_to_string(&mut first),
    )
    .await
    .expect("a silent request is cut off")
    .unwrap();
    assert!(first.starts_with("HTTP/1.1 408"), "{first}");
    assert!(first.contains(r#""code":"timeout""#), "{first}");
}

/// SEC-03: the passphrase can be changed with the current one and the rules of the setup; this session stays,
/// every other one ends. "Überall abmelden" ends every session. Both need the CSRF token and the origin.
#[tokio::test]
async fn the_passphrase_can_be_changed_and_every_session_ended_sec03() {
    const NEW: &str = "a brand new passphrase here";
    let f = Fixture::new().await;
    let (cookie, csrf) = setup(&f).await;
    let origin = Some("http://localhost:3000");
    let sign_in = |password: &'static str| {
        call(
            &f.app,
            "POST",
            "/api/v1/session",
            json!({ "password": password }),
            None,
            None,
            origin,
        )
    };
    let (_, _, other) = sign_in(PASSPHRASE).await;
    let other = other.unwrap().split(';').next().unwrap().to_string();
    let change = |current: &'static str,
                  new: &'static str,
                  csrf: Option<String>,
                  origin: Option<&'static str>| {
        let app = f.app.clone();
        let cookie = cookie.clone();
        async move {
            call(
                &app,
                "PUT",
                "/api/v1/session/passphrase",
                json!({ "current": current, "new": new }),
                Some(&cookie),
                csrf.as_deref(),
                origin,
            )
            .await
        }
    };
    let token = || Some(csrf.clone());
    assert_eq!(
        change(PASSPHRASE, NEW, None, origin).await.0,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        change(PASSPHRASE, NEW, token(), None).await.0,
        StatusCode::FORBIDDEN
    );
    let (status, error, _) = change(PASSPHRASE, "too short", token(), origin).await;
    assert_eq!(
        (status, error["code"].as_str()),
        (StatusCode::BAD_REQUEST, Some("invalid_request"))
    );
    let (status, error, _) = change("not the passphrase", NEW, token(), origin).await;
    assert_eq!(
        (status, error["code"].as_str()),
        (StatusCode::FORBIDDEN, Some("forbidden"))
    );
    assert_eq!(
        change(PASSPHRASE, PASSPHRASE, token(), origin).await.0,
        StatusCode::BAD_REQUEST
    );
    let (status, data, _) = change(PASSPHRASE, NEW, token(), origin).await;
    assert_eq!(status, StatusCode::OK, "{data}");
    assert_eq!(data["ended_sessions"], 1);
    assert_eq!(get(&f, &cookie, "/api/v1/me").await.0, StatusCode::OK);
    assert_eq!(
        get(&f, &other, "/api/v1/me").await.0,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(sign_in(PASSPHRASE).await.0, StatusCode::UNAUTHORIZED);
    let (status, _, second) = sign_in(NEW).await;
    assert_eq!(status, StatusCode::OK);
    let second = second.unwrap().split(';').next().unwrap().to_string();

    let everywhere = |csrf: Option<String>| {
        let app = f.app.clone();
        let cookie = cookie.clone();
        async move {
            call(
                &app,
                "DELETE",
                "/api/v1/sessions",
                Value::Null,
                Some(&cookie),
                csrf.as_deref(),
                origin,
            )
            .await
        }
    };
    assert_eq!(everywhere(None).await.0, StatusCode::FORBIDDEN);
    let (status, _, cleared) = everywhere(token()).await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    assert!(cleared.unwrap().contains("Max-Age=0"));
    for session in [&cookie, &second] {
        assert_eq!(
            get(&f, session, "/api/v1/me").await.0,
            StatusCode::UNAUTHORIZED
        );
    }
    let (_, _, third) = sign_in(NEW).await;
    let third = third.unwrap().split(';').next().unwrap().to_string();
    let (_, log) = get(&f, &third, "/api/v1/log?q=Sitzung").await;
    let messages: Vec<&str> = log["entries"]
        .as_array()
        .unwrap()
        .iter()
        .map(|e| e["message"].as_str().unwrap())
        .collect();
    assert_eq!(
        messages,
        [
            "Überall abgemeldet, 2 Sitzungen beendet",
            "Passphrase geändert, 1 Sitzung auf anderen Geräten beendet"
        ]
    );
    let (_, all) = get(&f, &third, "/api/v1/log?per_page=200").await;
    let text = all.to_string();
    assert!(text.contains("Passphrase nicht geändert: aktuelle Passphrase falsch"));
    for secret in [PASSPHRASE, NEW, "not the passphrase"] {
        assert!(!text.contains(secret), "the log contains a passphrase");
    }
}

/// PERF-03/04: compressed responses; `index.html` and the SPA fallback revalidate, hashed assets are immutable
/// (also when revalidated), icons are kept for an hour, API answers are never stored.
#[tokio::test]
async fn responses_are_compressed_and_static_files_carry_cache_rules_perf03_perf04() {
    let f = Fixture::new().await;
    let (cookie, _) = setup(&f).await;
    let dist = &f.config.frontend_dir;
    std::fs::create_dir(dist.join("assets")).unwrap();
    std::fs::write(
        dist.join("assets/index-B4xY9zQ1.js"),
        "console.log('KeyHunter');\n".repeat(400),
    )
    .unwrap();
    std::fs::write(
        dist.join("favicon.svg"),
        "<svg xmlns=\"http://www.w3.org/2000/svg\"/>",
    )
    .unwrap();
    std::fs::write(dist.join("manifest.webmanifest"), "{}").unwrap();
    let fetch = |path: &'static str, headers: Vec<(&'static str, String)>| {
        let app = f.app.clone();
        async move {
            let mut req = Request::builder().uri(path);
            for (name, value) in headers {
                req = req.header(name, value);
            }
            app.oneshot(req.body(Body::empty()).unwrap()).await.unwrap()
        }
    };
    let header = |response: &axum::response::Response, name: &str| {
        response
            .headers()
            .get(name)
            .map(|v| v.to_str().unwrap().to_string())
    };
    for (path, cache) in [
        ("/", "no-cache"),
        ("/index.html", "no-cache"),
        ("/einstellungen", "no-cache"),
        ("/manifest.webmanifest", "no-cache"),
        (
            "/assets/index-B4xY9zQ1.js",
            "public, max-age=31536000, immutable",
        ),
        ("/assets/index-Removed1.js", "no-cache"),
        ("/favicon.svg", "public, max-age=3600"),
        ("/api/v1/setup", "no-store"),
        ("/health/ready", "no-store"),
    ] {
        let response = fetch(path, vec![]).await;
        assert_eq!(
            header(&response, "cache-control").as_deref(),
            Some(cache),
            "{path}"
        );
    }
    // A revalidated asset keeps its rule.
    let response = fetch("/assets/index-B4xY9zQ1.js", vec![]).await;
    let modified = header(&response, "last-modified").unwrap();
    let response = fetch(
        "/assets/index-B4xY9zQ1.js",
        vec![("If-Modified-Since", modified)],
    )
    .await;
    assert_eq!(response.status(), StatusCode::NOT_MODIFIED);
    assert_eq!(
        header(&response, "cache-control").as_deref(),
        Some("public, max-age=31536000, immutable")
    );
    for encoding in ["br", "gzip"] {
        let response = fetch(
            "/assets/index-B4xY9zQ1.js",
            vec![("Accept-Encoding", encoding.into())],
        )
        .await;
        assert_eq!(
            header(&response, "content-encoding").as_deref(),
            Some(encoding)
        );
        let bytes = to_bytes(response.into_body(), 1 << 20).await.unwrap();
        assert!(bytes.len() < 1000, "{encoding}: {} bytes", bytes.len());
        let response = fetch(
            "/api/v1/settings",
            vec![
                ("Accept-Encoding", encoding.into()),
                ("Cookie", cookie.clone()),
            ],
        )
        .await;
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            header(&response, "content-encoding").as_deref(),
            Some(encoding)
        );
        assert_eq!(
            header(&response, "cache-control").as_deref(),
            Some("no-store")
        );
    }
    assert!(
        header(
            &fetch("/assets/index-B4xY9zQ1.js", vec![]).await,
            "content-encoding"
        )
        .is_none()
    );
}

/// The `.route(…)` calls of `source` as (method, path).
fn routes_in(source: &str) -> Vec<(String, String)> {
    let mut routes = Vec::new();
    for (start, _) in source.match_indices(".route(") {
        let rest = &source[start + ".route(".len()..];
        let mut depth = 1;
        let end = rest
            .char_indices()
            .find(|(_, c)| {
                depth += match c {
                    '(' => 1,
                    ')' => -1,
                    _ => 0,
                };
                depth == 0
            })
            .unwrap()
            .0;
        let call = &rest[..end];
        let path = call.split('"').nth(1).unwrap();
        for method in ["get", "post", "put", "delete", "patch"] {
            let token = format!("{method}(");
            let found = call.match_indices(&token).any(|(at, _)| {
                at == 0 || matches!(call.as_bytes()[at - 1], b'.' | b':' | b'(' | b' ' | b'\n')
            });
            if found {
                routes.push((method.to_uppercase(), path.to_string()));
            }
        }
    }
    routes
}

/// The API routes of one router function in `src/lib.rs` (`public_api` or `protected_api`) as (method, path), read
/// from the source, so a new route is part of the matrices below without being listed by hand.
fn api_routes(function: &str) -> Vec<(String, String)> {
    let source = include_str!("../src/lib.rs");
    let start = source
        .find(&format!("\nfn {function}("))
        .unwrap_or_else(|| panic!("fn {function} in src/lib.rs"));
    let body = &source[start..];
    routes_in(&body[..body.find("\n}\n").unwrap()])
}

/// The routes that answer without a session; [`public_routes_answer_without_a_session_code03`] pins them.
fn public_routes() -> Vec<(String, String)> {
    api_routes("public_api")
}

/// The routes behind the session layer.
fn protected_routes() -> Vec<(String, String)> {
    api_routes("protected_api")
}

/// The URL of a route with every path parameter filled with `value`.
fn url_of(path: &str, value: &str) -> String {
    let mut url = String::from("/api/v1");
    for part in path.split('/').skip(1) {
        url.push('/');
        url.push_str(if part.starts_with('{') { value } else { part });
    }
    url
}

/// A request with a raw body; answers status, content type and the JSON body (`Null` if it is none).
async fn raw(
    app: &Router,
    method: &str,
    path: &str,
    body: &str,
    content_type: Option<&str>,
    session: Option<(&str, &str)>,
) -> (StatusCode, String, Value) {
    let mut req = Request::builder()
        .method(method)
        .uri(path)
        .header("Origin", "http://localhost:3000");
    if let Some(value) = content_type {
        req = req.header("Content-Type", value);
    }
    if let Some((cookie, csrf)) = session {
        req = req.header("Cookie", cookie).header("X-CSRF-Token", csrf);
    }
    let response = app
        .clone()
        .oneshot(req.body(Body::from(body.to_string())).unwrap())
        .await
        .unwrap();
    let status = response.status();
    let kind = response
        .headers()
        .get("Content-Type")
        .map(|v| v.to_str().unwrap().to_string())
        .unwrap_or_default();
    let bytes = to_bytes(response.into_body(), 1024 * 1024).await.unwrap();
    (
        status,
        kind,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    )
}

/// The error shape of the API: JSON with a German `error` and a `code`, never Axum's English plain text.
fn assert_api_error(route: &str, status: StatusCode, kind: &str, data: &Value) {
    assert!(
        kind.starts_with("application/json"),
        "{route}: {status} {kind}"
    );
    let code = data["code"].as_str().unwrap_or_default();
    let error = data["error"].as_str().unwrap_or_default();
    assert!(!code.is_empty() && !error.is_empty(), "{route}: {data}");
    for english in [
        "Failed",
        "missing field",
        "invalid type",
        "Cannot parse",
        "Expected request",
    ] {
        assert!(!error.contains(english), "{route}: {error}");
    }
}

/// CODE-02 / FUNC-15 / SEC-06, the route matrix: a broken body gets 401 without a session on every protected route,
/// before anything is parsed; with a session every error is German JSON with a `code`. Only the setup and the
/// sign-in answer without a session, and no route resets the owner (that needs a shell, SEC-03).
#[tokio::test]
async fn every_route_checks_the_session_first_and_answers_errors_as_german_json_code02() {
    let f = Fixture::new().await;
    let (cookie, csrf) = setup(&f).await;
    let public = public_routes();
    let mut routes = [public.clone(), protected_routes()].concat();
    assert!(routes.len() >= 45, "{routes:?}");
    assert!(routes.iter().all(|(_, path)| !path.contains("reset")));
    // Ending the session last, the one of this browser at the very end.
    routes.sort_by_key(|(method, path)| {
        (
            method == "DELETE" && path.starts_with("/session"),
            path == "/session",
        )
    });
    for (method, path) in &routes {
        let route = format!("{method} {path}");
        let url = url_of(path, "abc");
        let (status, kind, data) =
            raw(&f.app, method, &url, "{", Some("application/json"), None).await;
        if public.contains(&(method.clone(), path.clone())) {
            if method == "POST" {
                assert_eq!(status, StatusCode::BAD_REQUEST, "{route}");
                assert_api_error(&route, status, &kind, &data);
            }
        } else {
            assert_eq!(status, StatusCode::UNAUTHORIZED, "{route}");
            assert_api_error(&route, status, &kind, &data);
            assert_eq!(data["code"], "unauthenticated", "{route}");
        }
        let (status, kind, data) = raw(
            &f.app,
            method,
            &url,
            "{",
            Some("application/json"),
            Some((&cookie, &csrf)),
        )
        .await;
        if !status.is_success() {
            assert!(status.is_client_error(), "{route}: {status} {data}");
            assert_api_error(&route, status, &kind, &data);
        }
    }
}

/// CODE-03, the CSRF and origin matrix: every state-changing route behind the session layer (POST, PUT, DELETE, PATCH)
/// rejects a request with a valid session but no CSRF header, a wrong token or a foreign origin with 403 before it
/// changes anything. Only the session layer checks, so a route outside it fails here. The documented exceptions are the
/// setup and the sign-in: they have no session yet, so no CSRF token, and are protected by the origin check alone
/// (covered by `setup_requires_local_secret_and_is_single_use` and the sign-in tests).
#[tokio::test]
async fn every_state_changing_route_needs_csrf_and_a_matching_origin_code03() {
    let f = Fixture::new().await;
    let (cookie, csrf) = setup(&f).await;
    let routes: Vec<_> = protected_routes()
        .into_iter()
        .filter(|(method, _)| method != "GET")
        .collect();
    assert!(routes.len() >= 25, "{routes:?}");
    let before = state_snapshot(&f, &cookie).await;
    for (method, path) in &routes {
        let route = format!("{method} {path}");
        let url = url_of(path, if path.contains("{kind}") { "ntfy" } else { "1" });
        let forged = "Sicherheitsprüfung fehlgeschlagen. Seite neu laden.";
        let foreign = "Anfrage abgewiesen: Die Adresse im Browser passt nicht zur App. Öffne KeyHunter über die IP-Adresse oder setze KEYHUNTER_ORIGIN auf die genutzte Adresse.";
        let attempts = [
            ("no CSRF header", None, "http://localhost:3000", forged),
            (
                "wrong CSRF token",
                Some("0".repeat(csrf.len())),
                "http://localhost:3000",
                forged,
            ),
            (
                "foreign origin",
                Some(csrf.clone()),
                "https://evil.example",
                foreign,
            ),
        ];
        for (what, token, origin, message) in attempts {
            let mut req = Request::builder()
                .method(method.as_str())
                .uri(&url)
                .header("Content-Type", "application/json")
                .header("Origin", origin)
                .header("Cookie", &cookie);
            if let Some(token) = token {
                req = req.header("X-CSRF-Token", token);
            }
            let response = f
                .app
                .clone()
                .oneshot(req.body(Body::from("{}")).unwrap())
                .await
                .unwrap();
            assert_eq!(
                response.status(),
                StatusCode::FORBIDDEN,
                "{route} with {what}"
            );
            let bytes = to_bytes(response.into_body(), 1024 * 1024).await.unwrap();
            let data: Value = serde_json::from_slice(&bytes).unwrap();
            assert_eq!(
                data,
                json!({"error": message, "code": "forbidden"}),
                "{route} with {what}"
            );
        }
    }
    // Nothing changed: the session still works and the state is as before.
    assert_eq!(state_snapshot(&f, &cookie).await, before);
}

/// CODE-03: the session layer guards every route of the API but the public ones. Each route in `src/lib.rs` is either
/// in `public_api`, in `protected_api` or a health check, and every method of every protected route answers 401 with the
/// German JSON error without a session cookie and with a cookie whose session is gone, whatever the body.
#[tokio::test]
async fn every_protected_route_needs_a_session_code03() {
    let f = Fixture::new().await;
    let (public, protected) = (public_routes(), protected_routes());
    assert!(protected.len() >= 45, "{protected:?}");
    for route in routes_in(include_str!("../src/lib.rs")) {
        assert!(
            route.1.starts_with("/health/")
                || public.contains(&route)
                || protected.contains(&route),
            "{route:?} is neither public nor behind the session layer"
        );
    }
    let gone = format!("keyhunter_session={}", "ab".repeat(32));
    for (method, path) in &protected {
        let url = url_of(path, "1");
        let mut methods = vec![method.as_str()];
        if method == "GET" {
            methods.push("HEAD");
        }
        for method in methods {
            let route = format!("{method} {path}");
            for (cookie, message) in [
                (None, "Bitte anmelden."),
                (Some(gone.as_str()), "Sitzung abgelaufen. Bitte anmelden."),
            ] {
                let mut req = Request::builder()
                    .method(method)
                    .uri(&url)
                    .header("Content-Type", "application/json")
                    .header("Origin", "http://localhost:3000");
                if let Some(cookie) = cookie {
                    req = req.header("Cookie", cookie);
                }
                let response = f
                    .app
                    .clone()
                    .oneshot(req.body(Body::from("{")).unwrap())
                    .await
                    .unwrap();
                assert_eq!(
                    response.status(),
                    StatusCode::UNAUTHORIZED,
                    "{route} {cookie:?}"
                );
                if method != "HEAD" {
                    let bytes = to_bytes(response.into_body(), 1024 * 1024).await.unwrap();
                    let data: Value = serde_json::from_slice(&bytes).unwrap();
                    assert_eq!(
                        data,
                        json!({"error": message, "code": "unauthenticated"}),
                        "{route} {cookie:?}"
                    );
                }
            }
        }
    }
}

/// CODE-03: without a session only the setup, the sign-in, the health checks and the app itself answer, and they still
/// do. A new public route has to be added here on purpose.
#[tokio::test]
async fn public_routes_answer_without_a_session_code03() {
    let f = Fixture::new().await;
    let mut public = public_routes();
    public.sort();
    assert_eq!(
        public,
        [("GET", "/setup"), ("POST", "/session"), ("POST", "/setup")]
            .map(|(m, p)| (m.to_string(), p.to_string()))
    );
    let get = |path: &'static str| raw(&f.app, "GET", path, "", None, None);
    let (status, _, data) = get("/api/v1/setup").await;
    assert_eq!((status, data), (StatusCode::OK, json!({"required": true})));
    // The handlers run: a broken body is a 400 of the extractor, a wrong passphrase the sign-in's own 401.
    for path in ["/api/v1/setup", "/api/v1/session"] {
        let (status, _, data) =
            raw(&f.app, "POST", path, "{", Some("application/json"), None).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{path}");
        assert_eq!(data["code"], "invalid_request", "{path}");
    }
    let (status, _, data) = raw(
        &f.app,
        "POST",
        "/api/v1/session",
        r#"{"password":"wrong passphrase"}"#,
        Some("application/json"),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert_eq!(data["error"], "Bitte zuerst die Einrichtung abschließen.");
    setup(&f).await;
    let (status, _, data) = get("/api/v1/setup").await;
    assert_eq!((status, data), (StatusCode::OK, json!({"required": false})));
    let (status, _, data) = raw(
        &f.app,
        "POST",
        "/api/v1/session",
        r#"{"password":"wrong passphrase"}"#,
        Some("application/json"),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert_eq!(data["error"], "Anmeldung fehlgeschlagen.");
    assert_eq!(get("/health/live").await.0, StatusCode::OK);
    assert_eq!(get("/health/ready").await.0, StatusCode::OK);
    // The app and a page of it (the single-page fallback serves the same index).
    for path in ["/", "/wishlist"] {
        let response = f
            .app
            .clone()
            .oneshot(Request::get(path).body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert!(path != "/" || response.status() == StatusCode::OK);
        let bytes = to_bytes(response.into_body(), 1024 * 1024).await.unwrap();
        assert!(
            String::from_utf8_lossy(&bytes).contains("KEYHUNTER"),
            "{path}"
        );
    }
}

/// The parts of the state a state-changing route could touch.
async fn state_snapshot(f: &Fixture, cookie: &str) -> Vec<Value> {
    let mut out = Vec::new();
    for path in [
        "/me",
        "/settings",
        "/wishlist",
        "/library",
        "/cart",
        "/alerts",
        "/alerts/channels",
        "/status/fetch",
    ] {
        let (status, data, _) = call(
            &f.app,
            "GET",
            &format!("/api/v1{path}"),
            Value::Null,
            Some(cookie),
            None,
            None,
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{path}");
        out.push(data);
    }
    out
}

/// CODE-02 / FUNC-15: the rejections of body, query and path, the method and the size, each with its own message.
#[tokio::test]
async fn extractor_rejections_name_the_problem_in_german_code02() {
    let f = Fixture::new().await;
    let (cookie, csrf) = setup(&f).await;
    let session = Some((cookie.as_str(), csrf.as_str()));
    let cases = [
        (
            "PUT",
            "/api/v1/settings",
            "{",
            Some("application/json"),
            400,
            "invalid_request",
            "Die Anfrage ist kein gültiges JSON.",
        ),
        (
            "PUT",
            "/api/v1/settings",
            r#"{"currency":5}"#,
            Some("application/json"),
            400,
            "invalid_request",
            "Die Anfrage enthält ungültige oder fehlende Werte.",
        ),
        (
            "PUT",
            "/api/v1/settings",
            "{}",
            None,
            415,
            "unsupported_media_type",
            "Die Anfrage muss als JSON gesendet werden.",
        ),
        (
            "GET",
            "/api/v1/catalog/games/abc?platform=169",
            "",
            None,
            400,
            "invalid_request",
            "Die Adresse enthält einen ungültigen Wert.",
        ),
        (
            "GET",
            "/api/v1/catalog/search?q=halo&platform=x",
            "",
            None,
            400,
            "invalid_request",
            "Die Adresse enthält ungültige Parameter.",
        ),
        (
            "PATCH",
            "/api/v1/settings",
            "{}",
            Some("application/json"),
            405,
            "method_not_allowed",
            "Diese Methode ist für den Endpunkt nicht erlaubt.",
        ),
    ];
    for (method, path, body, kind, status, code, error) in cases {
        let (got, content, data) = raw(&f.app, method, path, body, kind, session).await;
        assert_eq!(got.as_u16(), status, "{method} {path}: {data}");
        assert!(content.starts_with("application/json"), "{method} {path}");
        assert_eq!(
            data,
            json!({"code": code, "error": error}),
            "{method} {path}"
        );
    }
    let large = format!(r#"{{"password":"{}"}}"#, "x".repeat(20 * 1024));
    let (status, _, data) = raw(
        &f.app,
        "POST",
        "/api/v1/session",
        &large,
        Some("application/json"),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::PAYLOAD_TOO_LARGE);
    assert_eq!(data["code"], "too_large");
}

/// SEC-03 (c): `keyhunter --reset-owner` ends the owner's access for a forgotten passphrase. The owner and every
/// session are gone, a new setup code replaces the old one and works on the running server without a restart; the
/// wishlist and the settings stay, and the log names the reset.
#[tokio::test]
async fn reset_owner_allows_a_new_setup_and_keeps_the_data_sec03() {
    let f = Fixture::new().await;
    let (cookie, csrf) = setup(&f).await;
    let origin = Some("http://localhost:3000");
    let (status, _, _) = call(
        &f.app,
        "POST",
        "/api/v1/wishlist",
        json!({"manual_title": "Altes Lieblingsspiel", "platform_id": 49}),
        Some(&cookie),
        Some(&csrf),
        origin,
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    let (_, mut settings, _) = call(
        &f.app,
        "GET",
        "/api/v1/settings",
        Value::Null,
        Some(&cookie),
        None,
        None,
    )
    .await;
    settings["target_country"] = json!("AT");
    let (status, _, _) = call(
        &f.app,
        "PUT",
        "/api/v1/settings",
        settings,
        Some(&cookie),
        Some(&csrf),
        origin,
    )
    .await;
    assert_eq!(status, StatusCode::OK);

    let reset = keyhunter::reset_owner(&f.config).await.unwrap();
    assert!(reset.had_owner);
    assert_eq!(reset.ended_sessions, 1);
    let token = std::fs::read_to_string(&reset.setup_file).unwrap();
    assert_ne!(token.trim(), f.token.trim());
    use std::os::unix::fs::PermissionsExt;
    assert_eq!(
        std::fs::metadata(&reset.setup_file)
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o600
    );

    let (status, _, _) = call(
        &f.app,
        "GET",
        "/api/v1/me",
        Value::Null,
        Some(&cookie),
        None,
        None,
    )
    .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED, "the old session ended");
    let (_, status_view, _) = call(
        &f.app,
        "GET",
        "/api/v1/setup",
        Value::Null,
        None,
        None,
        None,
    )
    .await;
    assert_eq!(status_view["required"], true);
    let (status, _, _) = call(
        &f.app,
        "POST",
        "/api/v1/setup",
        json!({"token": f.token.trim(), "password": "a new and long passphrase"}),
        None,
        None,
        origin,
    )
    .await;
    assert_eq!(
        status,
        StatusCode::UNAUTHORIZED,
        "the old setup code is void"
    );
    let (status, data, new_cookie) = call(
        &f.app,
        "POST",
        "/api/v1/setup",
        json!({"token": token.trim(), "password": "a new and long passphrase"}),
        None,
        None,
        origin,
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    let new_cookie = new_cookie.unwrap();
    let new_cookie = new_cookie.split(';').next().unwrap();
    assert!(data["csrf_token"].is_string());
    let (_, wishes, _) = call(
        &f.app,
        "GET",
        "/api/v1/wishlist",
        Value::Null,
        Some(new_cookie),
        None,
        None,
    )
    .await;
    assert_eq!(wishes[0]["manual_title"], "Altes Lieblingsspiel");
    let (_, settings, _) = call(
        &f.app,
        "GET",
        "/api/v1/settings",
        Value::Null,
        Some(new_cookie),
        None,
        None,
    )
    .await;
    assert_eq!(settings["target_country"], "AT");
    let (_, log, _) = call(
        &f.app,
        "GET",
        "/api/v1/log?q=Kommandozeile",
        Value::Null,
        Some(new_cookie),
        None,
        None,
    )
    .await;
    assert_eq!(
        log["entries"][0]["message"],
        "Eigentümerzugang über die Kommandozeile zurückgesetzt, 1 Sitzung beendet; Einrichtung mit neuem Code möglich"
    );
    assert_eq!(log["entries"][0]["level"], "warn");
}
