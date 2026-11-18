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

pub(crate) fn platform_valid(id: i64) -> bool {
    matches!(id, 169 | 49)
}
pub(crate) fn provider_error(error: CatalogError) -> ApiError {
    match error {
        CatalogError::NotConfigured => ApiError(
            StatusCode::SERVICE_UNAVAILABLE,
            "IGDB-Zugang ist nicht konfiguriert. Die gespeicherte Wunschliste bleibt verfügbar.",
        ),
        CatalogError::InvalidCredentials => ApiError(
            StatusCode::SERVICE_UNAVAILABLE,
            "IGDB hat den Zugang abgewiesen. Bitte die lokale Zugangskonfiguration prüfen.",
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

async fn enabled(state: &Shared) -> ApiResult<()> {
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

async fn save_games(state: &Shared, games: &[CatalogGame]) -> ApiResult<()> {
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
        || !platform_valid(query.platform)
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
    let games: Vec<_> = state
        .catalog
        .search(text, query.platform)
        .await
        .map_err(provider_error)?
        .into_iter()
        .filter(|game| game.platforms.iter().any(|p| p.id == query.platform))
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
