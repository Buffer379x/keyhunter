mod alerts;
mod auth;
pub mod catalog;
pub mod config;
mod jobs;
mod offers;
mod settings;
mod shops;
mod wishlist;

use anyhow::{Context, Result, bail};
use axum::{
    Json, Router,
    body::Body,
    extract::{DefaultBodyLimit, State},
    http::{HeaderValue, Request, StatusCode, header},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use serde_json::json;
use sha2::{Digest, Sha256};
use sqlx::{
    SqlitePool,
    sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions, SqliteSynchronous},
};
use std::{
    fs,
    os::unix::fs::{OpenOptionsExt, PermissionsExt},
    sync::Arc,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tower::limit::ConcurrencyLimitLayer;
use tower_http::services::{ServeDir, ServeFile};

pub(crate) struct AppState {
    config: config::Config,
    pool: SqlitePool,
    bootstrap_hash: Option<[u8; 32]>,
    password_slots: Arc<tokio::sync::Semaphore>,
    catalog: Arc<dyn catalog::provider::CatalogProvider>,
    ntfy: Option<Arc<alerts::Ntfy>>,
}
type Shared = Arc<AppState>;
type ApiResult<T> = std::result::Result<T, ApiError>;

pub(crate) struct ApiError(pub StatusCode, pub &'static str);
impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let mut response = (self.0, Json(json!({"error": self.1}))).into_response();
        if self.0 == StatusCode::TOO_MANY_REQUESTS {
            response
                .headers_mut()
                .insert(header::RETRY_AFTER, HeaderValue::from_static("900"));
        }
        response
    }
}
impl From<sqlx::Error> for ApiError {
    fn from(_: sqlx::Error) -> Self {
        tracing::error!("Database request failed");
        internal()
    }
}
pub(crate) fn internal() -> ApiError {
    ApiError(
        StatusCode::INTERNAL_SERVER_ERROR,
        "Interner Fehler. Bitte erneut versuchen.",
    )
}
pub(crate) fn now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64
}
pub(crate) fn random_token() -> Result<String> {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).map_err(|_| anyhow::anyhow!("OS randomness unavailable"))?;
    Ok(hex::encode(bytes))
}
pub(crate) fn digest(value: &str) -> [u8; 32] {
    Sha256::digest(value.as_bytes()).into()
}

pub async fn create_app(config: config::Config) -> Result<Router> {
    let provider = Arc::new(catalog::provider::IgdbProvider::new(&config.data_dir)?);
    create_app_inner(config, provider, true).await
}

pub async fn create_app_with_catalog(
    config: config::Config,
    catalog: Arc<dyn catalog::provider::CatalogProvider>,
) -> Result<Router> {
    create_app_inner(config, catalog, false).await
}

async fn create_app_inner(
    config: config::Config,
    catalog: Arc<dyn catalog::provider::CatalogProvider>,
    run_background: bool,
) -> Result<Router> {
    config.validate()?;
    if !config.data_dir.exists() {
        fs::create_dir_all(&config.data_dir).context("Cannot create data directory")?;
        fs::set_permissions(&config.data_dir, fs::Permissions::from_mode(0o700))?;
    }
    let db_path = config.data_dir.join("keyhunter.db");
    fs::OpenOptions::new()
        .create(true)
        .append(true)
        .mode(0o600)
        .open(&db_path)
        .context("Cannot open database")?;
    let options = SqliteConnectOptions::new()
        .filename(db_path)
        .create_if_missing(true)
        .foreign_keys(true)
        .journal_mode(SqliteJournalMode::Wal)
        .synchronous(SqliteSynchronous::Normal)
        .busy_timeout(Duration::from_secs(5));
    let pool = SqlitePoolOptions::new()
        .max_connections(4)
        .connect_with(options)
        .await?;
    sqlx::migrate!("./migrations")
        .run(&pool)
        .await
        .context("Database migration failed")?;
    let exists: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM owner")
        .fetch_one(&pool)
        .await?;
    let bootstrap_hash = if exists == 0 {
        let path = config
            .bootstrap_file
            .clone()
            .unwrap_or_else(|| config.data_dir.join("bootstrap-token"));
        if !path.exists() {
            use std::io::Write;
            let mut file = fs::OpenOptions::new().write(true).create_new(true).mode(0o600).open(&path)
                .context("Cannot create setup token; provide an existing protected KEYHUNTER_BOOTSTRAP_FILE")?;
            file.write_all(random_token()?.as_bytes())?;
            file.sync_all()?;
        }
        if fs::metadata(&path)?.permissions().mode() & 0o077 != 0 {
            bail!("Setup token file must have owner-only permissions (0600)");
        }
        let token = fs::read_to_string(&path).context("Cannot read setup token file")?;
        if token.trim().len() < 32 {
            bail!("Setup token must contain at least 32 characters");
        }
        tracing::info!(path = %path.display(), "Initial setup token file ready; value is never logged");
        Some(digest(token.trim()))
    } else {
        None
    };
    let ntfy = run_background
        .then(alerts::Ntfy::from_env)
        .flatten()
        .map(Arc::new);
    let state = Arc::new(AppState {
        config: config.clone(),
        pool,
        bootstrap_hash,
        password_slots: Arc::new(tokio::sync::Semaphore::new(4)),
        catalog,
        ntfy: ntfy.clone(),
    });
    if run_background {
        jobs::start(&state.pool);
        if let Some(ntfy) = ntfy {
            alerts::start(&state.pool, ntfy);
        }
    }
    let api = Router::new()
        .route("/setup", get(auth::setup_status).post(auth::setup))
        .route("/session", post(auth::login).delete(auth::logout))
        .route("/me", get(auth::me))
        .route("/catalog/search", get(catalog::search))
        .route("/catalog/games/{id}", get(catalog::game_detail))
        .route("/catalog/games/{id}/editions", get(catalog::editions))
        .route("/sources/status", get(catalog::source_status))
        .route("/wishlist", get(wishlist::list).post(wishlist::add))
        .route("/wishlist/prices", get(offers::wishlist_prices))
        .route(
            "/wishlist/{id}/offers",
            get(offers::list).post(offers::add_link),
        )
        .route("/wishlist/{id}/offers/refresh", post(offers::refresh))
        .route(
            "/wishlist/{id}/offers/{link}",
            axum::routing::put(offers::review),
        )
        .route(
            "/wishlist/{id}/alert",
            get(alerts::get_rule)
                .put(alerts::put_rule)
                .delete(alerts::remove_rule),
        )
        .route("/alerts", get(alerts::list))
        .route("/alerts/test", post(alerts::test_message))
        .route("/wishlist/{id}", axum::routing::delete(wishlist::remove))
        .route(
            "/settings",
            get(settings::get_settings).put(settings::put_settings),
        )
        .route(
            "/settings/igdb",
            axum::routing::put(settings::put_igdb_credentials)
                .delete(settings::delete_igdb_credentials),
        )
        .fallback(api_not_found);
    Ok(Router::new()
        .nest(
            "/api",
            Router::new().nest("/v1", api).fallback(api_not_found),
        )
        .route(
            "/health/live",
            get(|| async { Json(json!({"status":"ok"})) }),
        )
        .route("/health/ready", get(ready))
        .fallback_service(
            ServeDir::new(&config.frontend_dir)
                .not_found_service(ServeFile::new(config.frontend_dir.join("index.html"))),
        )
        .layer(DefaultBodyLimit::max(16 * 1024))
        .layer(ConcurrencyLimitLayer::new(16))
        .layer(middleware::from_fn(security_headers))
        .with_state(state))
}

async fn ready(State(state): State<Shared>) -> ApiResult<Json<serde_json::Value>> {
    sqlx::query("SELECT 1").execute(&state.pool).await?;
    Ok(Json(
        json!({"status":"ready","version":env!("CARGO_PKG_VERSION")}),
    ))
}
async fn api_not_found() -> ApiError {
    ApiError(StatusCode::NOT_FOUND, "Endpunkt nicht gefunden.")
}
async fn security_headers(req: Request<Body>, next: Next) -> Response {
    let private = req.uri().path().starts_with("/api/") || req.uri().path().starts_with("/health/");
    let mut response = next.run(req).await;
    let headers = response.headers_mut();
    headers.insert(header::CONTENT_SECURITY_POLICY, HeaderValue::from_static("default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: https://images.igdb.com; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'"));
    headers.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    headers.insert(header::X_FRAME_OPTIONS, HeaderValue::from_static("DENY"));
    headers.insert(
        header::REFERRER_POLICY,
        HeaderValue::from_static("same-origin"),
    );
    headers.insert(
        "permissions-policy",
        HeaderValue::from_static("camera=(), microphone=(), geolocation=()"),
    );
    if private {
        headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    }
    response
}
