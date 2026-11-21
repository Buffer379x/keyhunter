pub mod contents;
pub mod provider;
use crate::{ApiError, ApiResult, Shared, auth, internal, now};
use axum::{
    Json,
    extract::{Path, Query, State},
    http::{HeaderMap, StatusCode},
};
use provider::{CatalogError, CatalogGame};
use serde::Deserialize;
use serde_json::{Value, json};
use sqlx::Row;

/// Xbox systems a wish or library entry can be for (IGDB ids): Series X|S, One, 360 (0.8.1) and the original Xbox (0.8.1).
pub(crate) const PLATFORMS: [i64; 4] = [169, 49, 12, 11];
/// `platform` of a catalog search that covers every system in [`PLATFORMS`] ("Alle", 0.8.1).
pub(crate) const ALL_PLATFORMS: i64 = 0;
pub(crate) fn platform_valid(id: i64) -> bool {
    PLATFORMS.contains(&id)
}
/// A game is on the searched system, or on any supported one for [`ALL_PLATFORMS`].
fn on_platform(game: &CatalogGame, platform: i64) -> bool {
    game.platforms
        .iter()
        .any(|p| p.id == platform || (platform == ALL_PLATFORMS && PLATFORMS.contains(&p.id)))
}
pub(crate) fn provider_error(error: CatalogError) -> ApiError {
    match error {
        CatalogError::Storage => internal(),
        CatalogError::NotConfigured => ApiError(
            StatusCode::SERVICE_UNAVAILABLE,
            "Hinterlege den IGDB-Zugang in den Einstellungen. Die gespeicherte Wunschliste bleibt verfügbar.",
        ),
        CatalogError::InvalidCredentials => ApiError(
            StatusCode::SERVICE_UNAVAILABLE,
            "IGDB hat den Zugang abgewiesen. Prüfe die Zugangsdaten in den Einstellungen.",
        ),
        CatalogError::Unavailable => ApiError(
            StatusCode::SERVICE_UNAVAILABLE,
            "Der Spielekatalog ist vorübergehend nicht erreichbar. Bitte später erneut versuchen.",
        ),
        CatalogError::InvalidResponse => ApiError(
            StatusCode::BAD_GATEWAY,
            "Die Katalogantwort konnte nicht geprüft werden. Es werden keine erfundenen Ergebnisse angezeigt.",
        ),
        CatalogError::RateLimited => ApiError(
            StatusCode::SERVICE_UNAVAILABLE,
            "IGDB hat die Abfragen begrenzt. Die Quelle pausiert bis zum nächsten erlaubten Abruf.",
        ),
    }
}

pub(crate) async fn enabled(state: &Shared) -> ApiResult<()> {
    let enabled: bool = sqlx::query_scalar("SELECT enabled FROM source_settings WHERE id = 'igdb'")
        .fetch_one(&state.pool)
        .await?;
    if !enabled {
        return Err(ApiError(
            StatusCode::SERVICE_UNAVAILABLE,
            "IGDB ist in den Einstellungen deaktiviert.",
        ));
    }
    Ok(())
}

pub(crate) async fn save_games(state: &Shared, games: &[CatalogGame]) -> ApiResult<()> {
    let mut tx = state.pool.begin().await?;
    for game in games {
        if game.igdb_id <= 0 || game.name.trim().is_empty() {
            return Err(provider_error(CatalogError::InvalidResponse));
        }
        let payload = serde_json::to_string(game).map_err(|_| internal())?;
        sqlx::query("INSERT INTO catalog_game (igdb_id, payload, fetched_at) VALUES (?, ?, ?) ON CONFLICT(igdb_id) DO UPDATE SET payload = excluded.payload, fetched_at = excluded.fetched_at")
            .bind(game.igdb_id).bind(payload).bind(now()).execute(&mut *tx).await?;
    }
    tx.commit().await?;
    Ok(())
}

pub(crate) async fn load_game(state: &Shared, id: i64) -> ApiResult<CatalogGame> {
    if id <= 0 {
        return Err(ApiError(StatusCode::BAD_REQUEST, "Ungültige Katalog-ID."));
    }
    enabled(state).await?;
    if let Some(payload) = sqlx::query_scalar::<_, String>(
        "SELECT payload FROM catalog_game WHERE igdb_id = ? AND fetched_at > ?",
    )
    .bind(id)
    .bind(now() - 86400)
    .fetch_optional(&state.pool)
    .await?
        && let Ok(game) = serde_json::from_str(&payload)
    {
        return Ok(game);
    }
    let game = state
        .catalog
        .game(id)
        .await
        .map_err(provider_error)?
        .ok_or(ApiError(
            StatusCode::NOT_FOUND,
            "Dieser Titel wurde im Katalog nicht gefunden.",
        ))?;
    if game.igdb_id != id {
        return Err(provider_error(CatalogError::InvalidResponse));
    }
    save_games(state, std::slice::from_ref(&game)).await?;
    Ok(game)
}

#[derive(Deserialize)]
pub(crate) struct SearchQuery {
    q: String,
    #[serde(default = "default_platform")]
    platform: i64,
}
fn default_platform() -> i64 {
    169
}

/// The IGDB ID in a search text: digits, optionally after "#" or "igdb" ("igdb:119171", "IGDB 119171").
fn igdb_id(text: &str) -> Option<i64> {
    let lower = text.trim().to_ascii_lowercase();
    let rest = lower
        .strip_prefix("igdb")
        .map(|rest| rest.trim_start_matches([':', ' ', '#']))
        .or_else(|| lower.strip_prefix('#'))
        .unwrap_or(&lower);
    (!rest.is_empty() && rest.len() <= 10 && rest.bytes().all(|b| b.is_ascii_digit()))
        .then(|| rest.parse().ok())
        .flatten()
        .filter(|id| *id > 0)
}

pub(crate) async fn search(
    State(state): State<Shared>,
    headers: HeaderMap,
    Query(query): Query<SearchQuery>,
) -> ApiResult<Json<Value>> {
    auth::authenticate(&state, &headers).await?;
    enabled(&state).await?;
    let text = query.q.trim();
    if !(2..=100).contains(&text.chars().count())
        || text.chars().any(char::is_control)
        || !(platform_valid(query.platform) || query.platform == ALL_PLATFORMS)
    {
        return Err(ApiError(
            StatusCode::BAD_REQUEST,
            "Suche mit 2 bis 100 Zeichen und einer unterstützten Xbox-Plattform eingeben.",
        ));
    }
    let key = format!("{}:{}", query.platform, text.to_lowercase());
    if let Some(row) = sqlx::query(
        "SELECT result_ids, fetched_at FROM catalog_search WHERE query_key = ? AND fetched_at > ?",
    )
    .bind(&key)
    .bind(now() - 3600)
    .fetch_optional(&state.pool)
    .await?
        && let Ok(ids) = serde_json::from_str::<Vec<i64>>(&row.get::<String, _>("result_ids"))
    {
        let mut games = Vec::new();
        for id in &ids {
            if let Some(payload) = sqlx::query_scalar::<_, String>(
                "SELECT payload FROM catalog_game WHERE igdb_id = ?",
            )
            .bind(id)
            .fetch_optional(&state.pool)
            .await?
                && let Ok(game) = serde_json::from_str::<CatalogGame>(&payload)
            {
                games.push(game);
            }
        }
        if games.len() == ids.len() {
            return Ok(Json(
                json!({"games":games,"cached":true,"fetched_at":row.get::<i64,_>("fetched_at")}),
            ));
        }
    }
    // An IGDB ID ("119171", "#119171", "igdb:119171") finds that game first; the text search still runs, so titles
    // that are numbers ("1942") keep working.
    let by_id = match igdb_id(text) {
        Some(id) => match load_game(&state, id).await {
            Ok(game) if on_platform(&game, query.platform) => Some(game),
            Ok(_) | Err(ApiError(StatusCode::NOT_FOUND, _)) => None,
            Err(error) => return Err(error),
        },
        None => None,
    };
    let found = state
        .catalog
        .search(text, query.platform)
        .await
        .map_err(provider_error)?;
    let games: Vec<_> = by_id
        .iter()
        .cloned()
        .chain(found.into_iter().filter(|game| {
            on_platform(game, query.platform)
                && by_id
                    .as_ref()
                    .is_none_or(|first| first.igdb_id != game.igdb_id)
        }))
        .take(20)
        .collect();
    save_games(&state, &games).await?;
    let ids: Vec<_> = games.iter().map(|g| g.igdb_id).collect();
    sqlx::query("INSERT INTO catalog_search VALUES (?, ?, ?) ON CONFLICT(query_key) DO UPDATE SET result_ids = excluded.result_ids, fetched_at = excluded.fetched_at")
        .bind(&key).bind(serde_json::to_string(&ids).map_err(|_| internal())?).bind(now()).execute(&state.pool).await?;
    sqlx::query("DELETE FROM catalog_search WHERE query_key NOT IN (SELECT query_key FROM catalog_search ORDER BY fetched_at DESC, query_key LIMIT 400)").execute(&state.pool).await?;
    sqlx::query("DELETE FROM catalog_game WHERE fetched_at < ? AND NOT EXISTS (SELECT 1 FROM game WHERE game.igdb_id = catalog_game.igdb_id)")
        .bind(now() - 7 * 86400).execute(&state.pool).await?;
    Ok(Json(
        json!({"games":games,"cached":false,"fetched_at":now()}),
    ))
}

#[derive(Deserialize)]
pub(crate) struct PlatformQuery {
    #[serde(default = "default_platform")]
    platform: i64,
}
pub(crate) async fn game_detail(
    State(state): State<Shared>,
    headers: HeaderMap,
    Path(id): Path<i64>,
    Query(query): Query<PlatformQuery>,
) -> ApiResult<Json<CatalogGame>> {
    auth::authenticate(&state, &headers).await?;
    if !platform_valid(query.platform) {
        return Err(ApiError(
            StatusCode::BAD_REQUEST,
            "Nicht unterstützte Plattform.",
        ));
    }
    let game = load_game(&state, id).await?;
    if !game.platforms.iter().any(|p| p.id == query.platform) {
        return Err(ApiError(
            StatusCode::UNPROCESSABLE_ENTITY,
            "Dieser Katalogtitel ist nicht für die gewählte Xbox-Plattform belegt.",
        ));
    }
    Ok(Json(game))
}

pub(crate) async fn source_status(
    State(state): State<Shared>,
    headers: HeaderMap,
) -> ApiResult<Json<Value>> {
    auth::authenticate(&state, &headers).await?;
    let active: bool = sqlx::query_scalar("SELECT enabled FROM source_settings WHERE id='igdb'")
        .fetch_one(&state.pool)
        .await?;
    let mut igdb = serde_json::to_value(state.catalog.status().await).map_err(|_| internal())?;
    igdb["enabled"] = json!(active);
    if !active {
        igdb["state"] = json!("disabled");
    }
    let mut entries: serde_json::Map<String, Value> = crate::offers::source_rows(&state.pool)
        .await?
        .into_iter()
        .collect();
    entries.insert("igdb".into(), igdb);
    Ok(Json(Value::Object(entries)))
}

pub(crate) async fn editions(
    State(state): State<Shared>,
    Path(id): Path<i64>,
    headers: HeaderMap,
) -> ApiResult<Json<Vec<CatalogGame>>> {
    auth::authenticate(&state, &headers).await?;
    enabled(&state).await?;
    let game = load_game(&state, id).await?;
    let parent = game.version_parent.unwrap_or(id);
    let games = state
        .catalog
        .editions(parent)
        .await
        .map_err(provider_error)?;
    save_games(&state, &games).await?;
    Ok(Json(
        games
            .into_iter()
            .filter(|g| {
                g.selection_allowed() && g.platforms.iter().any(|p| p.id == 169 || p.id == 49)
            })
            .collect(),
    ))
}

pub(crate) async fn edition_comparison(
    State(state): State<Shared>,
    Path(id): Path<i64>,
    headers: HeaderMap,
    Query(query): Query<PlatformQuery>,
) -> ApiResult<Json<Value>> {
    auth::authenticate(&state, &headers).await?;
    if !platform_valid(query.platform) {
        return Err(ApiError(
            StatusCode::BAD_REQUEST,
            "Nicht unterstützte Plattform.",
        ));
    }
    let game = load_game(&state, id).await?;
    let parent = game.version_parent.unwrap_or(id);
    if let Some((payload, at)) = sqlx::query_as::<_, (String, i64)>(
        "SELECT payload,fetched_at FROM edition_contents_cache WHERE parent_id=? AND platform_id=?",
    )
    .bind(parent)
    .bind(query.platform)
    .fetch_optional(&state.pool)
    .await?
        && let Ok(entries) = serde_json::from_str::<Vec<contents::EditionContent>>(&payload)
    {
        let ttl = if entries.iter().all(|e| e.status == "verified") {
            86400
        } else {
            900
        };
        if at > now() - ttl {
            return Ok(Json(
                json!({"editions":entries,"fetched_at":at,"cached":true}),
            ));
        }
    }
    let games = state
        .catalog
        .editions(parent)
        .await
        .map_err(provider_error)?;
    let mut games: Vec<_> = games
        .into_iter()
        .filter(|g| g.selection_allowed() && g.platforms.iter().any(|p| p.id == query.platform))
        .take(30)
        .collect();
    if !games.iter().any(|g| g.igdb_id == game.igdb_id)
        && game.platforms.iter().any(|p| p.id == query.platform)
    {
        games.push(game);
    }
    save_games(&state, &games).await?;
    let mut content_games = games.clone();
    for game in &mut content_games {
        game.platforms.retain(|p| p.id == query.platform);
    }
    let entries = state
        .catalog
        .edition_contents(&content_games)
        .await
        .unwrap_or_else(|_| contents::unknown(&games, "unavailable"));
    let at = now();
    sqlx::query("INSERT INTO edition_contents_cache VALUES(?,?,?,?) ON CONFLICT(parent_id,platform_id) DO UPDATE SET payload=excluded.payload,fetched_at=excluded.fetched_at")
        .bind(parent).bind(query.platform).bind(serde_json::to_string(&entries).map_err(|_|internal())?).bind(at).execute(&state.pool).await?;
    Ok(Json(
        json!({"editions":entries,"fetched_at":at,"cached":false}),
    ))
}

#[cfg(test)]
mod tests {
    use super::igdb_id;
    #[test]
    fn igdb_ids_are_recognised_in_search_texts() {
        assert_eq!(igdb_id("119171"), Some(119171));
        assert_eq!(igdb_id(" #1001 "), Some(1001));
        assert_eq!(igdb_id("igdb:1001"), Some(1001));
        assert_eq!(igdb_id("IGDB 1001"), Some(1001));
        assert_eq!(igdb_id("1942"), Some(1942));
        assert_eq!(igdb_id("Forza 5"), None);
        assert_eq!(igdb_id("0"), None);
        assert_eq!(igdb_id("igdb"), None);
        assert_eq!(igdb_id("12345678901"), None);
    }
}
