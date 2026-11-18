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
            origin: "http://localhost:3000".into(),
            data_dir: dir.path().join("data"),
            frontend_dir: frontend,
            bootstrap_file: None,
            igdb_env_file: None,
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
    config.origin = "https://keyhunter.example".into();
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
async fn insecure_nonloopback_or_path_origins_are_rejected() {
    let f = Fixture::new().await;
    for origin in [
        "http://keyhunter.example",
        "https://keyhunter.example/path",
        "https://user:pass@keyhunter.example",
        "https://keyhunter.example?x=1",
    ] {
        let mut config = f.config.clone();
        config.origin = origin.into();
        assert!(config.validate().is_err());
    }
}
