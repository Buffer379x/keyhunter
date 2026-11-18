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
    let rows = sqlx::query(items_sql!(" ORDER BY w.created_at DESC, w.id"))
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
            let existing = sqlx::query(items_sql!(" WHERE g.igdb_id = ? AND w.platform_id = ?"))
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
    let inserted = sqlx::query("INSERT INTO wishlist_item (id, game_id, platform_id, created_at) SELECT ?, ?, ?, ? WHERE (SELECT COUNT(*) FROM wishlist_item) < 100 ON CONFLICT(game_id, platform_id) DO NOTHING")
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
    let item = decode(row)?;
    let created = inserted.rows_affected() == 1;
    tx.commit().await?;
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
