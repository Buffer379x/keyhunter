use crate::{
    ApiError, ApiResult, Shared, auth,
    catalog::{self, provider::CatalogGame},
    internal, now, random_token,
};
use axum::{
    Json,
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
};
use serde::{Deserialize, Serialize};
use sqlx::{Row, sqlite::SqliteRow};

#[derive(Serialize)]
pub(crate) struct WishlistItem {
    id: String,
    game_id: String,
    platform_id: i64,
    created_at: i64,
    verification: &'static str,
    game: Option<CatalogGame>,
    manual_title: Option<String>,
}
macro_rules! items_sql {
    ($suffix:literal) => { concat!("SELECT w.id, w.game_id, w.platform_id, w.created_at, g.manual_title, c.payload FROM wishlist_item w JOIN game g ON g.id = w.game_id LEFT JOIN catalog_game c ON c.igdb_id = g.igdb_id", $suffix) };
}

fn decode(row: SqliteRow) -> ApiResult<WishlistItem> {
    let platform_id: i64 = row.get("platform_id");
    let payload: Option<String> = row.get("payload");
    let game = payload
        .map(|p| serde_json::from_str::<CatalogGame>(&p))
        .transpose()
        .map_err(|_| internal())?;
    let verification = match &game {
        Some(g) if g.selection_allowed() && g.platforms.iter().any(|p| p.id == platform_id) => {
            "catalog"
        }
        Some(_) => "needs_review",
        None => "manual_unverified",
    };
    Ok(WishlistItem {
        id: row.get("id"),
        game_id: row.get("game_id"),
        platform_id,
        created_at: row.get("created_at"),
        verification,
        game,
        manual_title: row.get("manual_title"),
    })
}

pub(crate) async fn list(
    State(state): State<Shared>,
    headers: HeaderMap,
) -> ApiResult<Json<Vec<WishlistItem>>> {
    auth::authenticate(&state, &headers).await?;
    let rows = sqlx::query(items_sql!(" WHERE NOT EXISTS(SELECT 1 FROM edition_preview p WHERE p.track_id=w.id) ORDER BY w.created_at DESC, w.rowid DESC"))
        .fetch_all(&state.pool)
        .await?;
    Ok(Json(
        rows.into_iter()
            .map(decode)
            .collect::<ApiResult<Vec<_>>>()?,
    ))
}

#[derive(Deserialize)]
pub(crate) struct AddInput {
    igdb_id: Option<i64>,
    manual_title: Option<String>,
    platform_id: i64,
}

pub(crate) async fn add(
    State(state): State<Shared>,
    headers: HeaderMap,
    Json(input): Json<AddInput>,
) -> ApiResult<Response> {
    let session = auth::authenticate(&state, &headers).await?;
    auth::require_csrf(&state, &headers, &session)?;
    if !catalog::platform_valid(input.platform_id) {
        return Err(ApiError(
            StatusCode::BAD_REQUEST,
            "Nicht unterstützte Plattform.",
        ));
    }
    let (igdb_id, manual_title, manual_key) = match (input.igdb_id, input.manual_title) {
        (Some(id), None) if id > 0 => {
            let existing = sqlx::query(items_sql!(" WHERE g.igdb_id = ? AND w.platform_id = ? AND NOT EXISTS(SELECT 1 FROM edition_preview p WHERE p.track_id=w.id)"))
                .bind(id)
                .bind(input.platform_id)
                .fetch_optional(&state.pool)
                .await?;
            if let Some(row) = existing {
                return Ok((
                    StatusCode::OK,
                    Json(serde_json::json!({"item":decode(row)?,"created":false})),
                )
                    .into_response());
            }
            let game = catalog::load_game(&state, id).await?;
            if !game.platforms.iter().any(|p| p.id == input.platform_id)
                || !game.selection_allowed()
            {
                return Err(ApiError(
                    StatusCode::UNPROCESSABLE_ENTITY,
                    "Plattform oder Produkttyp passt nicht zu einem eigenständig vorgemerkten Xbox-Spiel bzw. einer Edition.",
                ));
            }
            (Some(id), None, None)
        }
        (None, Some(title)) => {
            let title = title.trim();
            if !(2..=200).contains(&title.chars().count()) || title.chars().any(char::is_control) {
                return Err(ApiError(
                    StatusCode::BAD_REQUEST,
                    "Manuellen Titel mit 2 bis 200 Zeichen eingeben.",
                ));
            }
            let key = title
                .split_whitespace()
                .collect::<Vec<_>>()
                .join(" ")
                .to_lowercase();
            (None, Some(title.to_string()), Some(key))
        }
        _ => {
            return Err(ApiError(
                StatusCode::BAD_REQUEST,
                "Entweder Katalog-ID oder manuellen Titel angeben.",
            ));
        }
    };
    let mut tx = state.pool.begin().await?;
    let game_id = random_token().map_err(|_| internal())?[..32].to_string();
    sqlx::query("INSERT INTO game (id, igdb_id, manual_title, manual_key, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING")
        .bind(&game_id).bind(igdb_id).bind(&manual_title).bind(&manual_key).bind(now()).execute(&mut *tx).await?;
    let game_id: String = if let Some(id) = igdb_id {
        sqlx::query_scalar("SELECT id FROM game WHERE igdb_id = ?")
            .bind(id)
            .fetch_one(&mut *tx)
            .await?
    } else {
        sqlx::query_scalar("SELECT id FROM game WHERE manual_key = ?")
            .bind(manual_key)
            .fetch_one(&mut *tx)
            .await?
    };
    let item_id = random_token().map_err(|_| internal())?[..32].to_string();
    let inserted = sqlx::query("INSERT INTO wishlist_item (id, game_id, platform_id, created_at) SELECT ?, ?, ?, ? WHERE (SELECT COUNT(*) FROM wishlist_item w WHERE NOT EXISTS(SELECT 1 FROM edition_preview p WHERE p.track_id=w.id)) < 100 ON CONFLICT(game_id, platform_id) DO NOTHING")
        .bind(item_id).bind(&game_id).bind(input.platform_id).bind(now()).execute(&mut *tx).await?;
    let row = sqlx::query(items_sql!(" WHERE w.game_id = ? AND w.platform_id = ?"))
        .bind(&game_id)
        .bind(input.platform_id)
        .fetch_optional(&mut *tx)
        .await?;
    let Some(row) = row else {
        return Err(ApiError(
            StatusCode::CONFLICT,
            "Die Wunschliste enthält bereits 100 Einträge.",
        ));
    };
    let mut item = decode(row)?;
    let preview: bool =
        sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM edition_preview WHERE track_id=?)")
            .bind(&item.id)
            .fetch_one(&mut *tx)
            .await?;
    if preview {
        let count:i64=sqlx::query_scalar("SELECT COUNT(*) FROM wishlist_item w WHERE NOT EXISTS(SELECT 1 FROM edition_preview p WHERE p.track_id=w.id)").fetch_one(&mut *tx).await?;
        if count >= 100 {
            return Err(ApiError(
                StatusCode::CONFLICT,
                "Die Wunschliste enthält bereits 100 Einträge.",
            ));
        }
        sqlx::query("DELETE FROM edition_preview WHERE track_id=?")
            .bind(&item.id)
            .execute(&mut *tx)
            .await?;
        item.created_at = now();
        sqlx::query("UPDATE wishlist_item SET created_at=? WHERE id=?")
            .bind(item.created_at)
            .bind(&item.id)
            .execute(&mut *tx)
            .await?;
    }
    let created = inserted.rows_affected() == 1 || preview;
    tx.commit().await?;
    crate::jobs::schedule_wish(&state.pool, &item.id).await?;
    Ok((
        if created {
            StatusCode::CREATED
        } else {
            StatusCode::OK
        },
        Json(serde_json::json!({"item":item,"created":created})),
    )
        .into_response())
}

#[derive(Deserialize)]
pub(crate) struct PreviewInput {
    igdb_id: i64,
}

pub(crate) async fn preview(
    State(state): State<Shared>,
    headers: HeaderMap,
    Path(id): Path<String>,
    Json(input): Json<PreviewInput>,
) -> ApiResult<Json<serde_json::Value>> {
    let session = auth::authenticate(&state, &headers).await?;
    auth::require_csrf(&state, &headers, &session)?;
    let row = sqlx::query(items_sql!(
        " WHERE w.id=? AND NOT EXISTS(SELECT 1 FROM edition_preview p WHERE p.track_id=w.id)"
    ))
    .bind(&id)
    .fetch_optional(&state.pool)
    .await?
    .ok_or(ApiError(
        StatusCode::NOT_FOUND,
        "Wunschlisteneintrag nicht gefunden.",
    ))?;
    let anchor = decode(row)?;
    let base = anchor.game.as_ref().ok_or(ApiError(
        StatusCode::UNPROCESSABLE_ENTITY,
        "Für manuelle Titel sind keine Katalogeditionen verfügbar.",
    ))?;
    let game = catalog::load_game(&state, input.igdb_id).await?;
    if !base.selection_allowed()
        || !base.platforms.iter().any(|p| p.id == anchor.platform_id)
        || !game.selection_allowed()
        || !game.platforms.iter().any(|p| p.id == anchor.platform_id)
        || game.version_parent.unwrap_or(game.igdb_id)
            != base.version_parent.unwrap_or(base.igdb_id)
    {
        return Err(ApiError(
            StatusCode::UNPROCESSABLE_ENTITY,
            "Edition und Plattform müssen zum gemerkten Spiel gehören.",
        ));
    }
    let mut tx = state.pool.begin().await?;
    let existing:Option<String>=sqlx::query_scalar("SELECT w.id FROM wishlist_item w JOIN game g ON g.id=w.game_id WHERE g.igdb_id=? AND w.platform_id=?")
        .bind(game.igdb_id).bind(anchor.platform_id).fetch_optional(&mut *tx).await?;
    let track = if let Some(track) = existing {
        track
    } else {
        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM edition_preview")
            .fetch_one(&mut *tx)
            .await?;
        if count >= 300 {
            return Err(ApiError(
                StatusCode::CONFLICT,
                "Die gespeicherte Editionsvorschau ist ausgelastet.",
            ));
        }
        let game_id = random_token().map_err(|_| internal())?[..32].to_string();
        sqlx::query("INSERT OR IGNORE INTO game(id,igdb_id,created_at) VALUES(?,?,?)")
            .bind(game_id)
            .bind(game.igdb_id)
            .bind(now())
            .execute(&mut *tx)
            .await?;
        let game_id: String = sqlx::query_scalar("SELECT id FROM game WHERE igdb_id=?")
            .bind(game.igdb_id)
            .fetch_one(&mut *tx)
            .await?;
        let track = random_token().map_err(|_| internal())?[..32].to_string();
        sqlx::query("INSERT INTO wishlist_item(id,game_id,platform_id,created_at) VALUES(?,?,?,?)")
            .bind(&track)
            .bind(game_id)
            .bind(anchor.platform_id)
            .bind(now())
            .execute(&mut *tx)
            .await?;
        sqlx::query("INSERT INTO edition_preview VALUES(?,?)")
            .bind(&track)
            .bind(now())
            .execute(&mut *tx)
            .await?;
        track
    };
    sqlx::query("UPDATE edition_preview SET viewed_at=? WHERE track_id=?")
        .bind(now())
        .bind(&track)
        .execute(&mut *tx)
        .await?;
    let item = decode(
        sqlx::query(items_sql!(" WHERE w.id=?"))
            .bind(&track)
            .fetch_one(&mut *tx)
            .await?,
    )?;
    tx.commit().await?;
    crate::jobs::schedule_wish(&state.pool, &track).await?;
    Ok(Json(serde_json::json!({"item":item})))
}

pub(crate) async fn remove(
    State(state): State<Shared>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> ApiResult<StatusCode> {
    let session = auth::authenticate(&state, &headers).await?;
    auth::require_csrf(&state, &headers, &session)?;
    if id.len() != 32 || !id.bytes().all(|c| c.is_ascii_hexdigit()) {
        return Err(ApiError(
            StatusCode::BAD_REQUEST,
            "Ungültiger Wunschlisteneintrag.",
        ));
    }
    sqlx::query("DELETE FROM wishlist_item WHERE id = ?")
        .bind(id)
        .execute(&state.pool)
        .await?;
    Ok(StatusCode::NO_CONTENT)
}
