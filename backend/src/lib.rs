mod alerts;
mod auth;
pub mod canary;
mod cart;
pub mod catalog;
pub mod config;
pub mod container;
mod edition_tracking;
mod eventlog;
mod extract;
pub mod health;
mod history;
mod jobs;
#[cfg(test)]
mod migration_tests;
mod notify;
mod offers;
mod price_badges;
mod pricing;
mod settings;
mod shops;
mod throttle;
mod wishlist;

use anyhow::{Context, Result, bail};
use axum::{
    Json, Router,
    body::Body,
    extract::{DefaultBodyLimit, State},
    http::{HeaderValue, Request, StatusCode, header},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{delete, get, post, put},
};
use serde_json::json;
use sha2::{Digest, Sha256};
use sqlx::{
    SqlitePool,
    sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions, SqliteSynchronous},
};
use std::{
    fs,
    os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt},
    path::{Path, PathBuf},
    sync::Arc,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tower::limit::ConcurrencyLimitLayer;
use tower_http::{
    compression::{CompressionLayer, CompressionLevel},
    services::{ServeDir, ServeFile},
};

/// Largest request body (all bodies are small JSON documents).
const BODY_LIMIT: usize = 16 * 1024;
/// The wishlist import takes the file of the export (PROD-01); the page sends it in parts of 100 entries.
const IMPORT_PATH: &str = "/api/v1/wishlist/import";
const IMPORT_BODY_LIMIT: usize = 128 * 1024;
/// A request body must arrive completely within this time (SEC-02).
const BODY_TIMEOUT: Duration = Duration::from_secs(15);
/// Longest time for a whole request, above the slowest handlers (IGDB: 10 s per call and token refresh).
const REQUEST_TIMEOUT: Duration = Duration::from_secs(60);
/// Seconds of a day (Unix days, UTC).
pub(crate) const DAY: i64 = 86400;

pub(crate) struct AppState {
    config: config::Config,
    pool: SqlitePool,
    /// The setup code file, read at each setup attempt, so a code written by `--reset-owner` counts at once.
    bootstrap_file: PathBuf,
    password_slots: Arc<tokio::sync::Semaphore>,
    login_throttle: throttle::LoginThrottle,
    catalog: Arc<dyn catalog::provider::CatalogProvider>,
    notifier: Arc<notify::Notifier>,
    heartbeat: Arc<jobs::Heartbeat>,
    background: bool,
    trend_cache: price_badges::TrendCache,
}
type Shared = Arc<AppState>;
type ApiResult<T> = std::result::Result<T, ApiError>;

pub(crate) struct ApiError(pub StatusCode, pub &'static str);
impl ApiError {
    /// Stable machine-readable class of the error; `error` stays the German message.
    fn code(&self) -> &'static str {
        match self.0 {
            StatusCode::BAD_REQUEST => "invalid_request",
            StatusCode::UNAUTHORIZED => "unauthenticated",
            StatusCode::FORBIDDEN => "forbidden",
            StatusCode::NOT_FOUND => "not_found",
            StatusCode::REQUEST_TIMEOUT => "timeout",
            StatusCode::CONFLICT => "conflict",
            StatusCode::METHOD_NOT_ALLOWED => "method_not_allowed",
            StatusCode::PAYLOAD_TOO_LARGE => "too_large",
            StatusCode::UNSUPPORTED_MEDIA_TYPE => "unsupported_media_type",
            StatusCode::UNPROCESSABLE_ENTITY => "unprocessable",
            StatusCode::TOO_MANY_REQUESTS => "rate_limited",
            StatusCode::SERVICE_UNAVAILABLE
            | StatusCode::BAD_GATEWAY
            | StatusCode::GATEWAY_TIMEOUT => "unavailable",
            _ => "internal",
        }
    }
}
impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let mut response =
            (self.0, Json(json!({"error": self.1, "code": self.code()}))).into_response();
        if self.0 == StatusCode::TOO_MANY_REQUESTS {
            // The sign-in throttle window.
            response
                .headers_mut()
                .insert(header::RETRY_AFTER, HeaderValue::from(throttle::WINDOW));
        }
        response
    }
}
impl From<sqlx::Error> for ApiError {
    fn from(error: sqlx::Error) -> Self {
        // sqlx messages name the failing constraint or I/O cause, never bound values.
        tracing::error!(%error, "Database request failed");
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
/// Replace `path` atomically with an owner-only (0600) file holding `body` (IGDB access, channel secrets).
pub(crate) fn write_private(path: &std::path::Path, body: &[u8]) -> Result<()> {
    use std::io::Write;
    let name = path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("secret");
    let temporary = path.with_file_name(format!(".{name}-{}.tmp", random_token()?));
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&temporary)?;
    let result = (|| -> Result<()> {
        file.write_all(body)?;
        file.sync_all()?;
        fs::rename(&temporary, path)?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(temporary);
    }
    result
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

/// Opens the database (owner-only file), backs it up before pending migrations and applies them.
async fn open_database(config: &config::Config) -> Result<SqlitePool> {
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
    let migrator = sqlx::migrate!("./migrations");
    let backup = backup_before_migration(&pool, &migrator, &config.data_dir).await?;
    migrator
        .run(&pool)
        .await
        .context("Database migration failed")?;
    shops::upgrade_fingerprints(&pool)
        .await
        .context("Fingerprint upgrade failed")?;
    if let Some((from, to)) = backup {
        eventlog::record(
            &pool,
            eventlog::Level::Info,
            eventlog::Area::System,
            format!("Datenbank vor dem Update gesichert (Schema {from} → {to})"),
        )
        .await;
    }
    Ok(pool)
}

/// The setup code file: `KEYHUNTER_BOOTSTRAP_FILE`, or `bootstrap-token` in the data directory.
fn bootstrap_path(config: &config::Config) -> PathBuf {
    config
        .bootstrap_file
        .clone()
        .unwrap_or_else(|| config.data_dir.join("bootstrap-token"))
}

/// `keyhunter --setup-code`: the current setup code, read from its file.
pub fn setup_code_text(config: &config::Config) -> Result<String> {
    let path = bootstrap_path(config);
    match fs::read_to_string(&path) {
        Ok(code) => Ok(code.trim().to_string()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => bail!(
            "No setup code in {}: KeyHunter has not started yet. For a forgotten passphrase see --reset-owner",
            path.display()
        ),
        Err(error) => Err(error).with_context(|| format!("Cannot read {}", path.display())),
    }
}

/// Digest of the setup code in `path`: an owner-only (0600) file with at least 32 characters.
pub(crate) fn setup_code(path: &Path) -> Result<[u8; 32]> {
    if fs::metadata(path)?.permissions().mode() & 0o077 != 0 {
        bail!("Setup token file must have owner-only permissions (0600)");
    }
    let token = fs::read_to_string(path).context("Cannot read setup token file")?;
    if token.trim().len() < 32 {
        bail!("Setup token must contain at least 32 characters");
    }
    Ok(digest(token.trim()))
}

async fn create_app_inner(
    config: config::Config,
    catalog: Arc<dyn catalog::provider::CatalogProvider>,
    run_background: bool,
) -> Result<Router> {
    config.validate()?;
    let pool = open_database(&config).await?;
    // The start entry also prunes entries older than seven days.
    eventlog::record(
        &pool,
        eventlog::Level::Info,
        eventlog::Area::System,
        format!("KeyHunter {} gestartet", env!("CARGO_PKG_VERSION")),
    )
    .await;
    let exists: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM owner")
        .fetch_one(&pool)
        .await?;
    let bootstrap_file = bootstrap_path(&config);
    if exists == 0 {
        if !bootstrap_file.exists() {
            use std::io::Write;
            let mut file = fs::OpenOptions::new().write(true).create_new(true).mode(0o600).open(&bootstrap_file)
                .context("Cannot create setup token; provide an existing protected KEYHUNTER_BOOTSTRAP_FILE")?;
            file.write_all(random_token()?.as_bytes())?;
            file.sync_all()?;
        }
        setup_code(&bootstrap_file)?;
        tracing::info!(path = %bootstrap_file.display(), "Initial setup token file ready; value is never logged");
    }
    // The ntfy file of the operator counts for the service with background work, not for the browser fixture.
    let ntfy_env = run_background
        .then(|| std::env::var_os("KEYHUNTER_NTFY_ENV_FILE"))
        .flatten();
    let notifier = Arc::new(
        notify::Notifier::new(
            &config.data_dir,
            ntfy_env.as_deref().map(std::path::Path::new),
        )
        .context("Cannot prepare notifications")?,
    );
    let state = Arc::new(AppState {
        config: config.clone(),
        pool,
        bootstrap_file,
        password_slots: Arc::new(tokio::sync::Semaphore::new(4)),
        login_throttle: Default::default(),
        catalog,
        notifier: Arc::clone(&notifier),
        heartbeat: Arc::default(),
        background: run_background,
        trend_cache: Default::default(),
    });
    if run_background {
        jobs::start(&state.pool, Arc::clone(&state.heartbeat));
        edition_tracking::start(&state);
        alerts::start(&state.pool, notifier);
    }
    let api = public_api()
        .merge(protected_api(&state))
        .fallback(api_not_found)
        .method_not_allowed_fallback(method_not_allowed);
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
        // Innermost first: the body is read in full before the request takes a concurrency slot.
        .layer(DefaultBodyLimit::max(BODY_LIMIT))
        .layer(ConcurrencyLimitLayer::new(16))
        .layer(middleware::from_fn(read_body))
        .layer(middleware::from_fn(time_limit))
        // JSON and static files (PERF-03); brotli at quality 4 stays cheap for the 460 KB script.
        .layer(CompressionLayer::new().quality(CompressionLevel::Precise(4)))
        .layer(middleware::from_fn(security_headers))
        .with_state(state))
}

/// The API without a session: the setup and the sign-in. `tests/api.rs` reads the routes of this function and of
/// [`protected_api`] from the source, so every route is part of its route matrices.
fn public_api() -> Router<Shared> {
    Router::new()
        .route("/setup", get(auth::setup_status).post(auth::setup))
        .route("/session", post(auth::login))
}

/// Everything else: the session is checked before any extractor reads the path, the query or the body, so a request
/// without one gets 401 whatever it sends (CODE-02, SEC-06), and every state-changing method needs the CSRF token
/// (CODE-03, [`auth::require_session`]). Handlers do not check again.
fn protected_api(state: &Shared) -> Router<Shared> {
    Router::new()
        .route("/session", delete(auth::logout))
        .route("/session/passphrase", put(auth::change_passphrase))
        .route("/sessions", delete(auth::logout_everywhere))
        .route("/me", get(auth::me))
        .route("/counts", get(wishlist::counts))
        .route("/catalog/search", get(catalog::search))
        .route("/catalog/games/{id}", get(catalog::game_detail))
        .route(
            "/catalog/games/{id}/edition-comparison",
            get(catalog::edition_comparison),
        )
        .route("/sources/status", get(catalog::source_status))
        .route("/status/fetch", get(jobs::api::status))
        .route("/status/fetch/pause", post(jobs::api::set_paused))
        .route("/status/fetch/runs", get(jobs::api::runs))
        .route("/log", get(eventlog::list))
        .route("/wishlist", get(wishlist::list).post(wishlist::add))
        .route(
            "/wishlist/import",
            post(wishlist::import).layer(DefaultBodyLimit::max(IMPORT_BODY_LIMIT)),
        )
        .route("/library", get(wishlist::library).post(wishlist::add_owned))
        .route("/wishlist/{id}/purchase", post(wishlist::purchase))
        .route("/library/{id}/restore", post(wishlist::restore))
        .route("/wishlist/price-badges", get(price_badges::list))
        .route(
            "/wishlist/{id}/editions",
            get(edition_tracking::get).post(edition_tracking::prepare),
        )
        .route("/wishlist/{id}/preview", post(wishlist::preview))
        .route("/wishlist/{id}/pause", put(wishlist::pause))
        .route(
            "/wishlist/{id}/offers",
            get(offers::list).post(offers::add_link),
        )
        .route("/wishlist/{id}/offers/refresh", post(offers::refresh))
        .route(
            "/wishlist/{id}/offers/{link}",
            put(offers::review).delete(offers::remove_link),
        )
        .route(
            "/wishlist/{id}/alert",
            get(alerts::get_rule)
                .put(alerts::put_rule)
                .delete(alerts::remove_rule),
        )
        .route("/alerts", get(alerts::list))
        .route("/alerts/test", post(alerts::test_message))
        .route("/alerts/channels", get(notify::api::list_channels))
        .route(
            "/alerts/channels/{kind}",
            put(notify::api::put_channel).delete(notify::api::delete_channel),
        )
        .route(
            "/alerts/channels/{kind}/test",
            post(notify::api::test_channel),
        )
        .route("/wishlist/{id}", delete(wishlist::remove))
        .route("/cart", get(cart::list).post(cart::add))
        .route("/cart/{id}", put(cart::change).delete(cart::remove))
        .route(
            "/settings",
            get(settings::get_settings).put(settings::put_settings),
        )
        .route(
            "/settings/igdb",
            put(settings::put_igdb_credentials).delete(settings::delete_igdb_credentials),
        )
        .route_layer(middleware::from_fn_with_state(
            Arc::clone(state),
            auth::require_session,
        ))
}

/// Result of [`reset_owner`].
pub struct OwnerReset {
    /// An owner was set up before.
    pub had_owner: bool,
    /// Sessions that were still valid.
    pub ended_sessions: usize,
    /// The file with the new setup code.
    pub setup_file: PathBuf,
}

/// Owner recovery for a forgotten passphrase (SEC-03): writes a new setup code, removes the owner and every session,
/// so the setup runs again; wishes, prices, mappings and settings stay. Only from a shell with access to the data
/// (`keyhunter --reset-owner`, see docs/operations.md), never over HTTP. A running server takes the new code at the
/// next setup attempt, without a restart.
pub async fn reset_owner(config: &config::Config) -> Result<OwnerReset> {
    if !config.data_dir.join("keyhunter.db").is_file() {
        bail!(
            "No KeyHunter database in {}; check KEYHUNTER_DATA_DIR",
            config.data_dir.display()
        );
    }
    // A code written by another user (root in `docker exec`) would be unreadable for the service.
    let probe = config
        .data_dir
        .join(format!(".reset-probe-{}", random_token()?));
    fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&probe)
        .context("Cannot write to the data directory")?;
    let user = fs::metadata(&probe)?.uid();
    fs::remove_file(&probe)?;
    if user != fs::metadata(&config.data_dir)?.uid() {
        bail!(
            "Run this as the owner of the data directory, like the service (Unraid: docker exec --user 10001:10001 …)"
        );
    }
    let pool = open_database(config).await?;
    let setup_file = bootstrap_path(config);
    // The new code first: if it cannot be written, the owner stays.
    write_private(&setup_file, random_token()?.as_bytes())
        .context("Cannot write the new setup token file")?;
    let mut tx = pool.begin().await?;
    let active: Vec<bool> = sqlx::query_scalar("DELETE FROM session RETURNING expires_at > ?")
        .bind(now())
        .fetch_all(&mut *tx)
        .await?;
    let owners = sqlx::query("DELETE FROM owner")
        .execute(&mut *tx)
        .await?
        .rows_affected();
    tx.commit().await?;
    let ended_sessions = active.into_iter().filter(|active| *active).count();
    eventlog::record(
        &pool,
        eventlog::Level::Warn,
        eventlog::Area::Login,
        format!(
            "Eigentümerzugang über die Kommandozeile zurückgesetzt, {} beendet; Einrichtung mit neuem Code möglich",
            auth::sessions(ended_sessions)
        ),
    )
    .await;
    pool.close().await;
    Ok(OwnerReset {
        had_owner: owners > 0,
        ended_sessions,
        setup_file,
    })
}

async fn ready(State(state): State<Shared>) -> ApiResult<Json<serde_json::Value>> {
    sqlx::query("SELECT 1").execute(&state.pool).await?;
    if state.background && state.heartbeat.stalled(now()) {
        return Err(ApiError(
            StatusCode::SERVICE_UNAVAILABLE,
            "Ein Abrufdienst reagiert nicht. Container-Protokoll prüfen.",
        ));
    }
    Ok(Json(
        json!({"status":"ready","version":env!("CARGO_PKG_VERSION")}),
    ))
}
async fn api_not_found() -> ApiError {
    ApiError(StatusCode::NOT_FOUND, "Endpunkt nicht gefunden.")
}
async fn method_not_allowed() -> ApiError {
    ApiError(
        StatusCode::METHOD_NOT_ALLOWED,
        "Diese Methode ist für den Endpunkt nicht erlaubt.",
    )
}
/// Ends a request after [`REQUEST_TIMEOUT`] with a JSON error like every other one.
async fn time_limit(req: Request<Body>, next: Next) -> Response {
    tokio::time::timeout(REQUEST_TIMEOUT, next.run(req))
        .await
        .unwrap_or_else(|_| {
            ApiError(
                StatusCode::SERVICE_UNAVAILABLE,
                "Die Anfrage hat zu lange gedauert. Bitte erneut versuchen.",
            )
            .into_response()
        })
}
/// Reads the whole request body (at most [`BODY_LIMIT`]) within [`BODY_TIMEOUT`] before the request reaches the
/// concurrency limit and the handler, so a client that sends its body slowly or never holds nothing that a
/// sign-in or any other request needs (SEC-02). The import may send [`IMPORT_BODY_LIMIT`], but only with a session
/// cookie: the body is read before the session layer runs, so without one a stranger gets no more than anywhere else.
async fn read_body(req: Request<Body>, next: Next) -> Response {
    use axum::body::HttpBody;
    let (parts, mut body) = req.into_parts();
    let limit = if parts.uri.path() == IMPORT_PATH && auth::session_cookie(&parts.headers).is_some()
    {
        IMPORT_BODY_LIMIT
    } else {
        BODY_LIMIT
    };
    let read = async {
        let mut bytes = Vec::new();
        while let Some(frame) =
            std::future::poll_fn(|cx| std::pin::Pin::new(&mut body).poll_frame(cx)).await
        {
            let frame = frame.map_err(|_| extract::UNREADABLE)?;
            if let Ok(data) = frame.into_data() {
                if bytes.len() + data.len() > limit {
                    return Err(extract::TOO_LARGE);
                }
                bytes.extend_from_slice(&data);
            }
        }
        Ok(bytes)
    };
    match tokio::time::timeout(BODY_TIMEOUT, read).await {
        Ok(Ok(bytes)) => {
            next.run(Request::from_parts(parts, Body::from(bytes)))
                .await
        }
        Ok(Err(error)) => error.into_response(),
        Err(_) => ApiError(
            StatusCode::REQUEST_TIMEOUT,
            "Die Anfrage kam nicht rechtzeitig vollständig an.",
        )
        .into_response(),
    }
}

/// Caching (PERF-04): API and health never; `index.html`, the SPA fallback, the manifest and errors revalidate on
/// every load, so an update never leaves a page that points to removed scripts; the hashed `/assets/*` files
/// never change; the icons may be reused for an hour.
fn cache_control(path: &str, status: StatusCode) -> &'static str {
    let stored = status.is_success() || status == StatusCode::NOT_MODIFIED;
    if path.starts_with("/api/") || path.starts_with("/health/") {
        "no-store"
    } else if stored && path.starts_with("/assets/") {
        "public, max-age=31536000, immutable"
    } else if stored
        && [".png", ".svg", ".ico"]
            .iter()
            .any(|ext| path.ends_with(ext))
    {
        "public, max-age=3600"
    } else {
        "no-cache"
    }
}

async fn security_headers(req: Request<Body>, next: Next) -> Response {
    let path = req.uri().path().to_owned();
    let mut response = next.run(req).await;
    let cache = cache_control(&path, response.status());
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
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static(cache));
    response
}

/// Copy the database before pending migrations change an existing schema. The newest three
/// copies are kept in `<data>/backups`; restoring one is a plain file copy (docs/operations.md).
/// Returns the schema versions before and after the update when a copy was made.
async fn backup_before_migration(
    pool: &SqlitePool,
    migrator: &sqlx::migrate::Migrator,
    data_dir: &std::path::Path,
) -> Result<Option<(i64, i64)>> {
    let initialized: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='_sqlx_migrations')",
    )
    .fetch_one(pool)
    .await?;
    if !initialized {
        return Ok(None);
    }
    let applied: i64 =
        sqlx::query_scalar("SELECT COALESCE(MAX(version),0) FROM _sqlx_migrations WHERE success")
            .fetch_one(pool)
            .await?;
    let latest = migrator.iter().map(|m| m.version).max().unwrap_or(0);
    if applied >= latest {
        return Ok(None);
    }
    let dir = data_dir.join("backups");
    if !dir.exists() {
        fs::create_dir(&dir).context("Cannot create backup directory")?;
        fs::set_permissions(&dir, fs::Permissions::from_mode(0o700))?;
    }
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_millis());
    let file = dir.join(format!("keyhunter-schema-{applied:04}-{stamp}.db"));
    let path = file.to_str().context("Backup path is not valid UTF-8")?;
    sqlx::query("VACUUM INTO ?")
        .bind(path)
        .execute(pool)
        .await
        .context("Backup before migration failed")?;
    fs::set_permissions(&file, fs::Permissions::from_mode(0o600))?;
    tracing::info!(from = applied, to = latest, file = %file.display(), "Database backed up before migration");
    let mut copies: Vec<_> = fs::read_dir(&dir)?
        .filter_map(|entry| entry.ok().map(|e| e.path()))
        .filter(|p| {
            p.file_name()
                .and_then(|n| n.to_str())
                .is_some_and(|n| n.starts_with("keyhunter-schema-") && n.ends_with(".db"))
        })
        .collect();
    copies.sort();
    for old in copies.iter().rev().skip(3) {
        fs::remove_file(old)?;
    }
    Ok(Some((applied, latest)))
}
