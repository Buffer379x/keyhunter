mod alerts;
mod auth;
mod cart;
pub mod catalog;
pub mod config;
mod edition_tracking;
mod eventlog;
mod extract;
mod history;
mod jobs;
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
    // Without a session: the setup and the sign-in.
    let public = Router::new()
        .route("/setup", get(auth::setup_status).post(auth::setup))
        .route("/session", post(auth::login));
    // Everything else: the session is checked before any extractor reads the path, the query or the body, so a
    // request without one gets 401 whatever it sends (CODE-02, SEC-06).
    let protected = Router::new()
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
        .route("/status/fetch", get(jobs::status))
        .route("/status/fetch/pause", post(jobs::set_paused))
        .route("/status/fetch/runs", get(jobs::runs))
        .route("/log", get(eventlog::list))
        .route("/wishlist", get(wishlist::list).post(wishlist::add))
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
        .route("/alerts/channels", get(notify::list_channels))
        .route(
            "/alerts/channels/{kind}",
            put(notify::put_channel).delete(notify::delete_channel),
        )
        .route("/alerts/channels/{kind}/test", post(notify::test_channel))
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
            Arc::clone(&state),
            auth::require_session,
        ));
    let api = public
        .merge(protected)
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
/// sign-in or any other request needs (SEC-02).
async fn read_body(req: Request<Body>, next: Next) -> Response {
    use axum::body::HttpBody;
    let (parts, mut body) = req.into_parts();
    let read = async {
        let mut bytes = Vec::new();
        while let Some(frame) =
            std::future::poll_fn(|cx| std::pin::Pin::new(&mut body).poll_frame(cx)).await
        {
            let frame = frame.map_err(|_| extract::UNREADABLE)?;
            if let Ok(data) = frame.into_data() {
                if bytes.len() + data.len() > BODY_LIMIT {
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

#[cfg(test)]
mod migration_tests {
    use sqlx::sqlite::SqlitePoolOptions;

    /// Apply the embedded migrations up to `version` (inclusive) as plain SQL.
    async fn up_to(pool: &sqlx::SqlitePool, version: i64) {
        for migration in sqlx::migrate!("./migrations").iter() {
            if migration.version <= version {
                sqlx::raw_sql(sqlx::AssertSqlSafe(migration.sql.as_str().to_owned()))
                    .execute(pool)
                    .await
                    .unwrap();
            }
        }
    }

    async fn legacy_pool() -> sqlx::SqlitePool {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        up_to(&pool, 11).await;
        sqlx::raw_sql(
            "INSERT INTO game(id,manual_title,manual_key,created_at) VALUES('g','Game','game',0),('h','Other','other',0);
            INSERT INTO wishlist_item(id,game_id,platform_id,created_at) VALUES('wish','g',169,1),('preview','g',49,2),('owned','h',169,3);
            INSERT INTO edition_preview VALUES('preview',20);
            INSERT INTO library_item VALUES('owned',30);
            INSERT INTO edition_watch VALUES('wish','preview');",
        )
        .execute(&pool)
        .await
        .unwrap();
        pool
    }

    fn item_state_sql() -> String {
        sqlx::migrate!("./migrations")
            .iter()
            .find(|m| m.version == 12)
            .unwrap()
            .sql
            .as_str()
            .to_owned()
    }

    #[tokio::test]
    async fn budget_migration_backfills_valid_prices_and_marks_unsearched_wishes() {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        up_to(&pool, 13).await;
        let observation = |at: i64, offers: &str, activation: &str, availability: &str| {
            format!("INSERT INTO price_observation(link_id,product_id,observed_at,market,fingerprint,offers,activation,availability)
                VALUES(1,'p',{at},'DE','f','{offers}','{activation}','{availability}');")
        };
        let rows = [
            observation(
                1,
                r#"[{"id":"a","cents":0},{"id":"b","cents":1500},{"id":"c","cents":900}]"#,
                "confirmed",
                "in_stock",
            ),
            observation(2, r#"[{"id":"a","cents":900}]"#, "unknown", "in_stock"),
            observation(3, r#"[]"#, "confirmed", "sold_out"),
        ];
        sqlx::raw_sql(sqlx::AssertSqlSafe(format!(
            "INSERT INTO game(id,manual_title,manual_key,created_at) VALUES('g','Game','game',0);
            INSERT INTO wishlist_item(id,game_id,platform_id,created_at) VALUES('new','g',169,0),('old','g',49,0);
            INSERT INTO offer_link(id,wish_id,source,url) VALUES(1,'new','eneba','https://www.eneba.com/de/xbox-game-key');
            INSERT INTO shop_job(source,wish_id,due) VALUES('eneba','new',0);
            INSERT INTO shop_job(source,wish_id,due,checked_at) VALUES('eneba','old',0,5);
            {}",
            rows.concat()
        )))
        .execute(&pool)
        .await
        .unwrap();
        up_to_only(&pool, 14).await;
        sqlx::raw_sql(sqlx::AssertSqlSafe(observation(
            4,
            r#"[{"id":"a","cents":700},{"id":"b","cents":20000000}]"#,
            "confirmed",
            "in_stock",
        )))
        .execute(&pool)
        .await
        .unwrap();
        let cents: Vec<Option<i64>> =
            sqlx::query_scalar("SELECT valid_cents FROM price_observation ORDER BY observed_at")
                .fetch_all(&pool)
                .await
                .unwrap();
        assert_eq!(cents, [Some(900), None, None, Some(700)]);
        let initial: Vec<(String, i64)> = sqlx::query_as(
            "SELECT wish_id,initial FROM shop_job WHERE wish_id IS NOT NULL ORDER BY wish_id",
        )
        .fetch_all(&pool)
        .await
        .unwrap();
        assert_eq!(initial, [("new".into(), 1), ("old".into(), 0)]);
    }

    /// 0.9.3 (FUNC-02, FUNC-13): stock prices for old and new observations, whatever their activation; the trend
    /// index reads them; the dead-link count starts at zero.
    #[tokio::test]
    async fn release_093_migration_backfills_stock_prices_and_counts_dead_links() {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        up_to(&pool, 27).await;
        let observation = |at: i64, offers: &str, activation: &str, availability: &str| {
            format!("INSERT INTO price_observation(link_id,product_id,observed_at,market,fingerprint,offers,activation,availability)
                VALUES(1,'p',{at},'DE','f','{offers}','{activation}','{availability}');")
        };
        sqlx::raw_sql(sqlx::AssertSqlSafe(format!(
            "INSERT INTO game(id,manual_title,manual_key,created_at) VALUES('g','Game','game',0);
            INSERT INTO wishlist_item(id,game_id,platform_id,created_at) VALUES('w','g',169,0);
            INSERT INTO offer_link(id,wish_id,source,url) VALUES(1,'w','eneba','https://www.eneba.com/de/xbox-game-key');
            INSERT INTO shop_job(source,link_id,due) VALUES('eneba',1,0);
            {}{}",
            observation(1, r#"[{"id":"a","cents":0},{"id":"b","cents":1500}]"#, "confirmed", "in_stock"),
            observation(2, r#"[{"id":"a","cents":900}]"#, "unknown", "in_stock"),
        )))
        .execute(&pool)
        .await
        .unwrap();
        up_to_only(&pool, 28).await;
        sqlx::raw_sql(sqlx::AssertSqlSafe(format!(
            "{}{}",
            observation(3, r#"[{"id":"a","cents":700}]"#, "blocked", "in_stock"),
            observation(4, r#"[{"id":"a","cents":700}]"#, "confirmed", "sold_out"),
        )))
        .execute(&pool)
        .await
        .unwrap();
        let cents: Vec<(Option<i64>, Option<i64>)> = sqlx::query_as(
            "SELECT valid_cents,stock_cents FROM price_observation ORDER BY observed_at",
        )
        .fetch_all(&pool)
        .await
        .unwrap();
        assert_eq!(
            cents,
            [
                (Some(1500), Some(1500)),
                (None, Some(900)),
                (None, Some(700)),
                (None, None)
            ]
        );
        let columns: Vec<String> = sqlx::query_scalar(
            "SELECT name FROM pragma_index_info('price_history') ORDER BY seqno",
        )
        .fetch_all(&pool)
        .await
        .unwrap();
        assert_eq!(
            columns,
            [
                "link_id",
                "fingerprint",
                "observed_at",
                "market",
                "valid_cents",
                "stock_cents"
            ]
        );
        let dead: i64 = sqlx::query_scalar("SELECT dead_failures FROM shop_job")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(dead, 0);
    }

    /// Apply exactly one embedded migration as plain SQL.
    async fn up_to_only(pool: &sqlx::SqlitePool, version: i64) {
        let migrator = sqlx::migrate!("./migrations");
        let migration = migrator.iter().find(|m| m.version == version).unwrap();
        sqlx::raw_sql(sqlx::AssertSqlSafe(migration.sql.as_str().to_owned()))
            .execute(pool)
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn item_state_migration_moves_previews_and_library_into_one_column() {
        let pool = legacy_pool().await;
        sqlx::raw_sql(sqlx::AssertSqlSafe(item_state_sql()))
            .execute(&pool)
            .await
            .unwrap();
        let rows: Vec<(String, String, Option<i64>, Option<i64>)> = sqlx::query_as(
            "SELECT id,state,viewed_at,acquired_at FROM wishlist_item ORDER BY created_at",
        )
        .fetch_all(&pool)
        .await
        .unwrap();
        assert_eq!(
            rows,
            [
                ("wish".into(), "wished".into(), None, None),
                ("preview".into(), "preview".into(), Some(20), None),
                ("owned".into(), "owned".into(), None, Some(30)),
            ]
        );
        let side_tables: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM sqlite_master WHERE name IN ('edition_preview','library_item')",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(side_tables, 0);
        let watches: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM edition_watch")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(watches, 1);
    }

    #[tokio::test]
    async fn pending_migrations_back_up_the_database_and_keep_three_copies() {
        let dir = tempfile::tempdir().unwrap();
        let pool = SqlitePoolOptions::new()
            .connect_with(
                sqlx::sqlite::SqliteConnectOptions::new()
                    .filename(dir.path().join("keyhunter.db"))
                    .create_if_missing(true),
            )
            .await
            .unwrap();
        let migrator = sqlx::migrate!("./migrations");
        // A fresh database has nothing to protect.
        super::backup_before_migration(&pool, &migrator, dir.path())
            .await
            .unwrap();
        assert!(!dir.path().join("backups").exists());
        sqlx::raw_sql("CREATE TABLE _sqlx_migrations(version INTEGER, success BOOLEAN); INSERT INTO _sqlx_migrations VALUES(11,1); CREATE TABLE marker(v); INSERT INTO marker VALUES('kept');")
            .execute(&pool)
            .await
            .unwrap();
        for _ in 0..4 {
            super::backup_before_migration(&pool, &migrator, dir.path())
                .await
                .unwrap();
            tokio::time::sleep(std::time::Duration::from_millis(3)).await;
        }
        let mut copies: Vec<_> = std::fs::read_dir(dir.path().join("backups"))
            .unwrap()
            .map(|e| e.unwrap().path())
            .collect();
        copies.sort();
        assert_eq!(copies.len(), 3);
        assert!(
            copies[0]
                .file_name()
                .unwrap()
                .to_str()
                .unwrap()
                .starts_with("keyhunter-schema-0011-")
        );
        let copy = SqlitePoolOptions::new()
            .connect_with(sqlx::sqlite::SqliteConnectOptions::new().filename(&copies[2]))
            .await
            .unwrap();
        let marker: String = sqlx::query_scalar("SELECT v FROM marker")
            .fetch_one(&copy)
            .await
            .unwrap();
        assert_eq!(marker, "kept");
        // Up to date: no further copy.
        sqlx::query("UPDATE _sqlx_migrations SET version=?")
            .bind(migrator.iter().map(|m| m.version).max().unwrap())
            .execute(&pool)
            .await
            .unwrap();
        super::backup_before_migration(&pool, &migrator, dir.path())
            .await
            .unwrap();
        assert_eq!(
            std::fs::read_dir(dir.path().join("backups"))
                .unwrap()
                .count(),
            3
        );
    }

    /// 0.9.0: an alert waiting at the update keeps what its message needs, and ntfy stays switched on for an
    /// existing ntfy file. Applied after every earlier migration (0026 included).
    #[tokio::test]
    async fn channel_migration_keeps_waiting_alerts_and_the_ntfy_switch() {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        up_to(&pool, 26).await;
        sqlx::raw_sql(
            "INSERT INTO game(id,manual_title,manual_key,created_at) VALUES('g','Halo','halo',0);
            INSERT INTO wishlist_item(id,game_id,platform_id,created_at) VALUES('wish','g',169,1);
            INSERT INTO alert_rule(wish_id,mode,basis,target_cents,enabled) VALUES('wish','target','estimate',1999,1);
            INSERT INTO alert_outbox(wish_id,scope,observed_at,cents,message,due) VALUES('wish','s',5,1900,'KeyHunter: Halo',5);
            INSERT INTO alert_outbox(observed_at,message,due) VALUES(6,'KeyHunter: Testnachricht',6);",
        )
        .execute(&pool)
        .await
        .unwrap();
        up_to_only(&pool, 27).await;
        let rows: Vec<String> = sqlx::query_scalar(
            "SELECT json_array(game,mode,basis,reference_cents) FROM alert_outbox ORDER BY id",
        )
        .fetch_all(&pool)
        .await
        .unwrap();
        assert_eq!(
            rows,
            [
                r#"["Halo","target","estimate",1999]"#,
                "[null,null,null,null]"
            ]
        );
        let message: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM pragma_table_info('alert_outbox') WHERE name='message'",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(message, 0);
        let switches: Vec<(String, bool)> =
            sqlx::query_as("SELECT kind,enabled FROM notification_channel WHERE enabled")
                .fetch_all(&pool)
                .await
                .unwrap();
        assert_eq!(switches, [("ntfy".into(), true)]);
    }

    #[tokio::test]
    async fn item_state_migration_refuses_contradictory_rows() {
        let pool = legacy_pool().await;
        sqlx::query("INSERT INTO library_item VALUES('preview',40)")
            .execute(&pool)
            .await
            .unwrap();
        let mut tx = pool.begin().await.unwrap();
        assert!(
            sqlx::raw_sql(sqlx::AssertSqlSafe(item_state_sql()))
                .execute(&mut *tx)
                .await
                .is_err()
        );
        tx.rollback().await.unwrap();
        let previews: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM edition_preview")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(previews, 1, "the old tables stay untouched");
    }

    /// 0.8.1: the rebuilt wishlist table keeps every row and every reference, takes Xbox 360 and the
    /// original Xbox, still cascades, and cart entries start with the cheapest shop of any region.
    #[tokio::test]
    async fn platform_rebuild_keeps_all_references_and_accepts_older_xbox_systems() {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(
                "sqlite::memory:"
                    .parse::<sqlx::sqlite::SqliteConnectOptions>()
                    .unwrap()
                    .foreign_keys(true),
            )
            .await
            .unwrap();
        up_to(&pool, 22).await;
        sqlx::raw_sql(
            "INSERT INTO game(id,manual_title,manual_key,created_at) VALUES('g','Game','game',0),('h','Other','other',0);
            INSERT INTO wishlist_item(id,game_id,platform_id,created_at,state,acquired_at) VALUES('wish','g',169,1,'wished',NULL),('preview','g',49,2,'preview',NULL),('owned','h',169,3,'owned',9);
            INSERT INTO offer_link(id,wish_id,source,url) VALUES(1,'wish','eneba','https://www.eneba.com/de/xbox-game-key');
            INSERT INTO price_observation(link_id,product_id,observed_at,market,fingerprint,offers,activation,availability) VALUES(1,'p',1,'DE','f','[]','unknown','in_stock');
            INSERT INTO alert_rule(wish_id,mode,basis,target_cents,enabled) VALUES('wish','target','base',1000,1);
            INSERT INTO edition_watch VALUES('wish','preview');
            INSERT INTO cart_item(wish_id,added_at) VALUES('wish',5);",
        )
        .execute(&pool)
        .await
        .unwrap();
        up_to_only(&pool, 23).await;
        let rows: Vec<(String, i64, String, Option<i64>)> = sqlx::query_as(
            "SELECT id,platform_id,state,acquired_at FROM wishlist_item ORDER BY created_at",
        )
        .fetch_all(&pool)
        .await
        .unwrap();
        assert_eq!(
            rows,
            [
                ("wish".into(), 169, "wished".into(), None),
                ("preview".into(), 49, "preview".into(), None),
                ("owned".into(), 169, "owned".into(), Some(9))
            ]
        );
        let broken: Vec<(String,)> = sqlx::query_as("PRAGMA foreign_key_check")
            .fetch_all(&pool)
            .await
            .unwrap();
        assert!(broken.is_empty(), "{broken:?}");
        let cart: (Option<String>, String) =
            sqlx::query_as("SELECT source,scope FROM cart_item WHERE wish_id='wish'")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(cart, (None, "world".into()));
        for platform in [12, 11] {
            sqlx::query(
                "INSERT INTO wishlist_item(id,game_id,platform_id,created_at) VALUES(?,'h',?,4)",
            )
            .bind(format!("old-{platform}"))
            .bind(platform)
            .execute(&pool)
            .await
            .unwrap();
        }
        assert!(
            sqlx::query(
                "INSERT INTO wishlist_item(id,game_id,platform_id,created_at) VALUES('pc','h',6,4)"
            )
            .execute(&pool)
            .await
            .is_err(),
            "PC stays out"
        );
        // Deleting a wish still removes what hangs on it.
        sqlx::query("DELETE FROM wishlist_item WHERE id='wish'")
            .execute(&pool)
            .await
            .unwrap();
        for table in [
            "offer_link",
            "price_observation",
            "alert_rule",
            "edition_watch",
            "cart_item",
        ] {
            let count: i64 =
                sqlx::query_scalar(sqlx::AssertSqlSafe(format!("SELECT COUNT(*) FROM {table}")))
                    .fetch_one(&pool)
                    .await
                    .unwrap();
            assert_eq!(count, 0, "{table}");
        }
    }
}
