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
