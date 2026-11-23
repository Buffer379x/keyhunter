//! Event log (0.8.3, Settings › Log): short German entries about the owner's actions, sent notifications
//! and fetch problems. Entries are kept seven days (trigger of migration 0025, so every insert prunes, the
//! start entry included). They never contain secrets: no passphrase, session or CSRF token, cookie, address,
//! token or password of a notification channel, and no IGDB access.

use crate::{ApiError, ApiResult, Shared, now, shops::Shop};
use axum::{
    Json,
    extract::{Query, State, rejection::QueryRejection},
    http::StatusCode,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::FromRow;

/// A repeating background problem is logged at most once in this time (see [`record_once`]).
pub(crate) const REPEAT: i64 = 3600;

/// Name of the game of a wish; `g` is its game row, `c` the joined catalog entry.
pub(crate) const GAME_NAME: &str = "COALESCE(json_extract(c.payload,'$.name'),g.manual_title)";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Level {
    Info,
    Warn,
    Error,
}

impl Level {
    fn as_str(self) -> &'static str {
        match self {
            Self::Info => "info",
            Self::Warn => "warn",
            Self::Error => "error",
        }
    }
}

/// Area of an entry; stored and shown as its German name.
#[derive(Clone, Copy)]
pub(crate) enum Area {
    Login,
    Wishlist,
    Library,
    Cart,
    Offers,
    Alerts,
    Settings,
    Fetch,
    System,
}

impl Area {
    fn name(self) -> &'static str {
        match self {
            Self::Login => "Anmeldung",
            Self::Wishlist => "Wunschliste",
            Self::Library => "Bibliothek",
            Self::Cart => "Warenkorb",
            Self::Offers => "Angebote",
            Self::Alerts => "Preisalarme",
            Self::Settings => "Einstellungen",
            Self::Fetch => "Abruf",
            Self::System => "System",
        }
    }
}

/// Write one entry. A failure is only traced: the log never fails what it describes.
pub(crate) async fn record<'e>(
    conn: impl sqlx::Executor<'e, Database = sqlx::Sqlite>,
    level: Level,
    area: Area,
    message: impl Into<String>,
) {
    let result = sqlx::query("INSERT INTO event_log(at,level,area,message) VALUES(?,?,?,?)")
        .bind(now())
        .bind(level.as_str())
        .bind(area.name())
        .bind(message.into())
        .execute(conn)
        .await;
    if let Err(error) = result {
        tracing::warn!(%error, "Event log entry could not be written");
    }
}

/// Like [`record`], but skipped while the same entry is younger than `window` seconds, for repeating
/// problems (retry loops, rejected login floods).
pub(crate) async fn record_once<'e>(
    conn: impl sqlx::Executor<'e, Database = sqlx::Sqlite>,
    level: Level,
    area: Area,
    message: impl Into<String>,
    window: i64,
) {
    let result = sqlx::query(
        "INSERT INTO event_log(at,level,area,message) SELECT ?1,?2,?3,?4
        WHERE NOT EXISTS(SELECT 1 FROM event_log WHERE at>?1-?5 AND area=?3 AND message=?4)",
    )
    .bind(now())
    .bind(level.as_str())
    .bind(area.name())
    .bind(message.into())
    .bind(window)
    .execute(conn)
    .await;
    if let Err(error) = result {
        tracing::warn!(%error, "Event log entry could not be written");
    }
}

/// Game of a wish or library item in German quotes („Forza Horizon 5“), for messages.
pub(crate) async fn game<'e>(
    conn: impl sqlx::Executor<'e, Database = sqlx::Sqlite>,
    wish: &str,
) -> String {
    let name: Option<String> = sqlx::query_scalar(sqlx::AssertSqlSafe(format!(
        "SELECT {GAME_NAME} FROM wishlist_item w JOIN game g ON g.id=w.game_id
        LEFT JOIN catalog_game c ON c.igdb_id=g.igdb_id WHERE w.id=?"
    )))
    .bind(wish)
    .fetch_optional(conn)
    .await
    .ok()
    .flatten()
    .flatten();
    quoted(name.as_deref())
}

/// „name“, or „Unbekanntes Spiel“ without one.
pub(crate) fn quoted(name: Option<&str>) -> String {
    format!("„{}“", name.unwrap_or("Unbekanntes Spiel"))
}

/// An offer link for messages: "Eneba-Angebot (Global)", the region when the product is known.
pub(crate) async fn offer<'e>(
    conn: impl sqlx::Executor<'e, Database = sqlx::Sqlite>,
    link: i64,
) -> String {
    let row: Option<(String, Option<String>)> =
        sqlx::query_as("SELECT source,json_extract(latest,'$.region') FROM offer_link WHERE id=?")
            .bind(link)
            .fetch_optional(conn)
            .await
            .ok()
            .flatten();
    let (source, region) = row.unwrap_or_default();
    let shop = Shop::from_id(&source).map_or("Shop", Shop::name);
    match region {
        Some(region) => format!("{shop}-Angebot ({region})"),
        None => format!("{shop}-Angebot"),
    }
}

pub(crate) const BAD_FILTER: ApiError = ApiError(
    StatusCode::BAD_REQUEST,
    "Ungültiger Filter. Stufe, Suchtext (höchstens 200 Zeichen) und Seite prüfen.",
);

/// 1-based page and page size of a list: 50 entries by default, 10 to 200.
pub(crate) fn paging(page: Option<i64>, per_page: Option<i64>) -> (i64, i64) {
    (
        page.unwrap_or(1).clamp(1, 1_000_000),
        per_page.unwrap_or(25).clamp(10, 200),
    )
}

/// LIKE pattern (with `ESCAPE '\'`) of a case-insensitive substring search; `%` and `_` count literally.
/// None for an empty search, an error beyond 200 characters.
pub(crate) fn pattern(q: Option<&str>) -> ApiResult<Option<String>> {
    let q = q.unwrap_or_default().trim();
    if q.chars().count() > 200 {
        return Err(BAD_FILTER);
    }
    Ok((!q.is_empty()).then(|| {
        let escaped = q
            .replace('\\', r"\\")
            .replace('%', r"\%")
            .replace('_', r"\_");
        format!("%{escaped}%")
    }))
}

/// An optional choice filter: absent or empty is no filter, anything outside `allowed` an error.
pub(crate) fn choice<'a>(value: Option<&'a str>, allowed: &[&str]) -> ApiResult<Option<&'a str>> {
    match value.filter(|v| !v.is_empty()) {
        Some(v) if !allowed.contains(&v) => Err(BAD_FILTER),
        other => Ok(other),
    }
}

#[derive(Deserialize)]
pub(crate) struct LogQuery {
    level: Option<String>,
    q: Option<String>,
    page: Option<i64>,
    per_page: Option<i64>,
}

#[derive(Serialize, FromRow)]
struct Entry {
    id: i64,
    at: i64,
    level: String,
    area: String,
    message: String,
}

const FILTER: &str = r"FROM event_log WHERE (?1 IS NULL OR level=?1)
    AND (?2 IS NULL OR message LIKE ?2 ESCAPE '\' OR area LIKE ?2 ESCAPE '\')";

/// GET /api/v1/log?level=&q=&page=&per_page=: entries, newest first, and the number after filtering.
pub(crate) async fn list(
    State(state): State<Shared>,
    query: Result<Query<LogQuery>, QueryRejection>,
) -> ApiResult<Json<Value>> {
    let Query(query) = query.map_err(|_| BAD_FILTER)?;
    let level = choice(query.level.as_deref(), &["info", "warn", "error"])?;
    let pattern = pattern(query.q.as_deref())?;
    let (page, per_page) = paging(query.page, query.per_page);
    let total: i64 = sqlx::query_scalar(sqlx::AssertSqlSafe(format!("SELECT COUNT(*) {FILTER}")))
        .bind(level)
        .bind(&pattern)
        .fetch_one(&state.pool)
        .await?;
    let entries: Vec<Entry> = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "SELECT id,at,level,area,message {FILTER} ORDER BY at DESC,id DESC LIMIT ?3 OFFSET ?4"
    )))
    .bind(level)
    .bind(&pattern)
    .bind(per_page)
    .bind((page - 1) * per_page)
    .fetch_all(&state.pool)
    .await?;
    Ok(Json(
        json!({"entries": entries, "total": total, "page": page, "per_page": per_page}),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::SqlitePool;

    async fn memory() -> SqlitePool {
        let pool = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        sqlx::migrate!("./migrations").run(&pool).await.unwrap();
        pool
    }

    #[tokio::test]
    async fn entries_older_than_seven_days_go_with_the_next_insert() {
        let pool = memory().await;
        for age in [8 * 86400, 6 * 86400] {
            sqlx::query("INSERT INTO event_log(at,level,area,message) VALUES(?,'info','System',?)")
                .bind(now() - age)
                .bind(format!("age {age}"))
                .execute(&pool)
                .await
                .unwrap();
        }
        record(&pool, Level::Warn, Area::Fetch, "neu").await;
        let left: Vec<String> = sqlx::query_scalar("SELECT message FROM event_log ORDER BY at")
            .fetch_all(&pool)
            .await
            .unwrap();
        assert_eq!(left, [format!("age {}", 6 * 86400), "neu".into()]);
    }

    #[tokio::test]
    async fn repeated_problems_are_logged_once_per_window() {
        let pool = memory().await;
        for _ in 0..3 {
            record_once(&pool, Level::Error, Area::Fetch, "kaputt", 3600).await;
        }
        record_once(&pool, Level::Error, Area::Fetch, "anders", 3600).await;
        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM event_log")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(count, 2);
    }

    #[test]
    fn search_patterns_take_wildcards_literally_and_filters_reject_unknown_values() {
        assert!(matches!(pattern(None), Ok(None)));
        assert!(matches!(pattern(Some("  ")), Ok(None)));
        assert_eq!(
            pattern(Some(r"50%_a\b")).ok().flatten().unwrap(),
            r"%50\%\_a\\b%"
        );
        assert!(pattern(Some(&"x".repeat(201))).is_err());
        assert!(pattern(Some(&"x".repeat(200))).is_ok());
        assert_eq!(paging(None, None), (1, 25));
        assert_eq!(paging(Some(0), Some(5)), (1, 10));
        assert_eq!(paging(Some(3), Some(500)), (3, 200));
        assert!(matches!(choice(Some(""), &["ok"]), Ok(None)));
        assert_eq!(choice(Some("ok"), &["ok"]).ok().flatten(), Some("ok"));
        assert!(choice(Some("bad"), &["ok"]).is_err());
    }
}
