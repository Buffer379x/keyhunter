mod alerts;
mod auth;
pub mod catalog;
pub mod config;
mod edition_tracking;
mod history;
mod jobs;
mod offers;
mod price_badges;
mod pricing;
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
    heartbeat: Arc<jobs::Heartbeat>,
    background: bool,
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
    let migrator = sqlx::migrate!("./migrations");
    backup_before_migration(&pool, &migrator, &config.data_dir).await?;
    migrator
        .run(&pool)
        .await
        .context("Database migration failed")?;
    shops::upgrade_fingerprints(&pool)
        .await
        .context("Fingerprint upgrade failed")?;
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
        heartbeat: Arc::default(),
        background: run_background,
    });
    if run_background {
        jobs::start(&state.pool, Arc::clone(&state.heartbeat));
        edition_tracking::start(&state);
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
        .route(
            "/catalog/games/{id}/edition-comparison",
            get(catalog::edition_comparison),
        )
        .route("/sources/status", get(catalog::source_status))
        .route("/status/fetch", get(jobs::status))
        .route("/wishlist", get(wishlist::list).post(wishlist::add))
        .route("/library", get(wishlist::library))
        .route("/wishlist/{id}/purchase", post(wishlist::purchase))
        .route("/library/{id}/restore", post(wishlist::restore))
        .route("/wishlist/price-badges", get(price_badges::list))
        .route(
            "/wishlist/{id}/editions",
            get(edition_tracking::get).post(edition_tracking::prepare),
        )
        .route("/wishlist/{id}/preview", post(wishlist::preview))
        .route("/settings/shop-readers", get(settings::shop_readers))
        .route("/settings/shops", post(settings::register_shop))
        .route(
            "/settings/shops/{id}",
            axum::routing::delete(settings::unregister_shop),
        )
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

/// Copy the database before pending migrations change an existing schema. The newest three
/// copies are kept in `<data>/backups`; restoring one is a plain file copy (docs/operations.md).
async fn backup_before_migration(
    pool: &SqlitePool,
    migrator: &sqlx::migrate::Migrator,
    data_dir: &std::path::Path,
) -> Result<()> {
    let initialized: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='_sqlx_migrations')",
    )
    .fetch_one(pool)
    .await?;
    if !initialized {
        return Ok(());
    }
    let applied: i64 =
        sqlx::query_scalar("SELECT COALESCE(MAX(version),0) FROM _sqlx_migrations WHERE success")
            .fetch_one(pool)
            .await?;
    let latest = migrator.iter().map(|m| m.version).max().unwrap_or(0);
    if applied >= latest {
        return Ok(());
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
    Ok(())
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
}
