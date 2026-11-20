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

#[derive(Clone, Serialize)]
pub(crate) struct WishlistItem {
    pub(crate) id: String,
    game_id: String,
    pub(crate) platform_id: i64,
    created_at: i64,
    verification: &'static str,
    pub(crate) game: Option<CatalogGame>,
    manual_title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) price_badge: Option<crate::price_badges::PriceBadge>,
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
        price_badge: None,
    })
}

pub(crate) async fn list(
    State(state): State<Shared>,
    headers: HeaderMap,
) -> ApiResult<Json<Vec<WishlistItem>>> {
    auth::authenticate(&state, &headers).await?;
    let rows = sqlx::query(items_sql!(
        " WHERE w.state='wished' ORDER BY w.created_at DESC, w.rowid DESC"
    ))
    .fetch_all(&state.pool)
    .await?;
    let mut items = rows
        .into_iter()
        .map(decode)
        .collect::<ApiResult<Vec<_>>>()?;
    let (target, scope) = crate::price_badges::context(&state.pool).await?;
    let ids: Vec<String> = items.iter().map(|item| item.id.clone()).collect();
    let mut badges = crate::price_badges::load_many(&state, &ids, &target, &scope).await?;
    for item in &mut items {
        item.price_badge = badges.remove(&item.id);
    }
    Ok(Json(items))
}

#[derive(Deserialize)]
pub(crate) struct AddInput {
    igdb_id: Option<i64>,
    manual_title: Option<String>,
    platform_id: i64,
    #[serde(default)]
    confirm_owned: bool,
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
    let mut family = None;
    let (igdb_id, manual_title, manual_key) = match (input.igdb_id, input.manual_title) {
        (Some(id), None) if id > 0 => {
            let existing = sqlx::query(items_sql!(
                " WHERE g.igdb_id = ? AND w.platform_id = ? AND w.state='wished'"
            ))
            .bind(id)
            .bind(input.platform_id)
            .fetch_optional(&state.pool)
            .await?;
            if let Some(row) = existing {
                return Ok((
                    StatusCode::OK,
                    Json(serde_json::json!({"item":with_badge(&state,decode(row)?).await?,"created":false})),
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
            family = Some(game.version_parent.unwrap_or(game.igdb_id));
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
    if !input.confirm_owned {
        let owned: Option<String> = sqlx::query_scalar("SELECT COALESCE(g.manual_title,json_extract(c.payload,'$.name'),'Spiel') FROM wishlist_item w JOIN game g ON g.id=w.game_id LEFT JOIN catalog_game c ON c.igdb_id=g.igdb_id WHERE w.state='owned' AND (g.id=? OR (? IS NOT NULL AND COALESCE(json_extract(c.payload,'$.version_parent'),g.igdb_id)=?)) LIMIT 1")
            .bind(&game_id).bind(family).bind(family).fetch_optional(&mut *tx).await?;
        if let Some(title) = owned {
            return Ok((StatusCode::CONFLICT, Json(serde_json::json!({"error":format!("„{title}“ ist bereits in deiner Bibliothek. Wirklich fortfahren?"),"code":"owned_game"}))).into_response());
        }
    }
    let item_id = random_token().map_err(|_| internal())?[..32].to_string();
    let inserted = sqlx::query("INSERT INTO wishlist_item (id, game_id, platform_id, created_at) SELECT ?, ?, ?, ? WHERE (SELECT COUNT(*) FROM wishlist_item w WHERE w.state='wished') < 100 ON CONFLICT(game_id, platform_id) DO NOTHING")
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
    let item_state: String = sqlx::query_scalar("SELECT state FROM wishlist_item WHERE id=?")
        .bind(&item.id)
        .fetch_one(&mut *tx)
        .await?;
    let moved = item_state != "wished";
    if moved {
        let count: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM wishlist_item w WHERE w.state='wished'")
                .fetch_one(&mut *tx)
                .await?;
        if count >= 100 {
            return Err(ApiError(
                StatusCode::CONFLICT,
                "Die Wunschliste enthält bereits 100 Einträge.",
            ));
        }
        item.created_at = now();
        sqlx::query("UPDATE wishlist_item SET state='wished',viewed_at=NULL,acquired_at=NULL,created_at=? WHERE id=?")
            .bind(item.created_at)
            .bind(&item.id)
            .execute(&mut *tx)
            .await?;
    }
    let created = inserted.rows_affected() == 1 || moved;
    tx.commit().await?;
    crate::jobs::schedule_wish(&state.pool, &item.id).await?;
    item = with_badge(&state, item).await?;
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
    let row = sqlx::query(items_sql!(" WHERE w.id=? AND w.state='wished'"))
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
    let track = track_edition(&mut tx, &game, anchor.platform_id).await?;
    if track != id {
        sqlx::query("INSERT OR IGNORE INTO edition_watch(wish_id,track_id) VALUES(?,?)")
            .bind(&id)
            .bind(&track)
            .execute(&mut *tx)
            .await?;
    }
    sqlx::query("UPDATE wishlist_item SET viewed_at=? WHERE id=? AND state='preview'")
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
    let item = with_badge(&state, item).await?;
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
    let mut tx = state.pool.begin().await?;
    crate::edition_tracking::cancel_children(&mut tx, &id).await?;
    // Wishes and library entries can be removed; hidden previews are not the user's entries.
    let item_state: Option<String> =
        sqlx::query_scalar("SELECT state FROM wishlist_item WHERE id=?")
            .bind(&id)
            .fetch_optional(&mut *tx)
            .await?;
    if matches!(item_state.as_deref(), Some("wished" | "owned")) {
        let needed:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM edition_watch e JOIN wishlist_item w ON w.id=e.wish_id WHERE e.track_id=? AND e.wish_id!=? AND w.state='wished')").bind(&id).bind(&id).fetch_one(&mut *tx).await?;
        if needed {
            // Preserve observations shared with another game's edition selector.
            sqlx::query(
                "UPDATE wishlist_item SET state='preview',viewed_at=?,acquired_at=NULL WHERE id=?",
            )
            .bind(now())
            .bind(&id)
            .execute(&mut *tx)
            .await?;
            sqlx::query("DELETE FROM edition_watch WHERE wish_id=?")
                .bind(&id)
                .execute(&mut *tx)
                .await?;
            sqlx::query("DELETE FROM edition_scan WHERE wish_id=?")
                .bind(&id)
                .execute(&mut *tx)
                .await?;
            sqlx::query("UPDATE alert_rule SET enabled=0,scope=NULL,previous_cents=NULL,lowest_cents=NULL WHERE wish_id=?").bind(&id).execute(&mut *tx).await?;
            sqlx::query(
                "UPDATE alert_outbox SET state='cancelled' WHERE wish_id=? AND state='pending'",
            )
            .bind(&id)
            .execute(&mut *tx)
            .await?;
        } else {
            sqlx::query("DELETE FROM wishlist_item WHERE id=?")
                .bind(&id)
                .execute(&mut *tx)
                .await?;
        }
    }
    tx.commit().await?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Serialize)]
pub(crate) struct LibraryItem {
    #[serde(flatten)]
    item: WishlistItem,
    acquired_at: i64,
}

pub(crate) async fn library(
    State(state): State<Shared>,
    headers: HeaderMap,
) -> ApiResult<Json<Vec<LibraryItem>>> {
    auth::authenticate(&state, &headers).await?;
    let rows = sqlx::query("SELECT w.id,w.game_id,w.platform_id,w.created_at,g.manual_title,c.payload,COALESCE(w.acquired_at,0) AS acquired_at FROM wishlist_item w JOIN game g ON g.id=w.game_id LEFT JOIN catalog_game c ON c.igdb_id=g.igdb_id WHERE w.state='owned' ORDER BY w.acquired_at DESC,w.rowid DESC")
    .fetch_all(&state.pool)
    .await?;
    Ok(Json(
        rows.into_iter()
            .map(|row| {
                let acquired_at = row.get("acquired_at");
                Ok(LibraryItem {
                    item: decode(row)?,
                    acquired_at,
                })
            })
            .collect::<ApiResult<Vec<_>>>()?,
    ))
}

pub(crate) async fn purchase(
    State(state): State<Shared>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> ApiResult<StatusCode> {
    let session = auth::authenticate(&state, &headers).await?;
    auth::require_csrf(&state, &headers, &session)?;
    let mut tx = state.pool.begin().await?;
    let result = sqlx::query(
        "UPDATE wishlist_item SET state='owned',acquired_at=? WHERE id=? AND state='wished'",
    )
    .bind(now())
    .bind(&id)
    .execute(&mut *tx)
    .await?;
    if result.rows_affected() == 0 {
        return Err(ApiError(
            StatusCode::NOT_FOUND,
            "Wunschlisteneintrag nicht gefunden oder bereits gekauft.",
        ));
    }
    sqlx::query("UPDATE alert_rule SET enabled=0,scope=NULL,previous_cents=NULL,lowest_cents=NULL WHERE wish_id=?").bind(&id).execute(&mut *tx).await?;
    sqlx::query("UPDATE alert_outbox SET state='cancelled' WHERE wish_id=? AND state='pending'")
        .bind(&id)
        .execute(&mut *tx)
        .await?;
    crate::edition_tracking::cancel_children(&mut tx, &id).await?;
    // Revoke in-flight leases: their results cannot update observations or send alerts.
    sqlx::query("UPDATE shop_job SET lease_until=0,lease_token=NULL WHERE wish_id=? OR link_id IN (SELECT id FROM offer_link WHERE wish_id=?)").bind(&id).bind(&id).execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
pub(crate) struct RestoreInput {
    #[serde(default)]
    confirm: bool,
}
pub(crate) async fn restore(
    State(state): State<Shared>,
    headers: HeaderMap,
    Path(id): Path<String>,
    Json(input): Json<RestoreInput>,
) -> ApiResult<StatusCode> {
    let session = auth::authenticate(&state, &headers).await?;
    auth::require_csrf(&state, &headers, &session)?;
    if !input.confirm {
        return Err(ApiError(
            StatusCode::CONFLICT,
            "Zurücksetzen in die Wunschliste bitte bestätigen.",
        ));
    }
    let mut tx = state.pool.begin().await?;
    let deleted=sqlx::query("UPDATE wishlist_item SET state='wished',acquired_at=NULL,created_at=? WHERE id=? AND state='owned' AND (SELECT COUNT(*) FROM wishlist_item w WHERE w.state='wished')<100")
        .bind(now()).bind(&id).execute(&mut *tx).await?;
    if deleted.rows_affected() == 0 {
        return Err(ApiError(
            StatusCode::CONFLICT,
            "Bibliothekseintrag nicht gefunden oder Wunschliste bereits voll.",
        ));
    }
    tx.commit().await?;
    crate::jobs::schedule_wish(&state.pool, &id).await?;
    Ok(StatusCode::NO_CONTENT)
}

pub(crate) async fn require_unowned(pool: &sqlx::SqlitePool, id: &str) -> ApiResult<()> {
    let owned: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM wishlist_item WHERE id=? AND state='owned')",
    )
    .bind(id)
    .fetch_one(pool)
    .await?;
    if owned {
        return Err(ApiError(
            StatusCode::CONFLICT,
            "Dieses Spiel ist in der Bibliothek. Zuerst in die Wunschliste zurücksetzen.",
        ));
    }
    Ok(())
}

pub(crate) async fn item(pool: &sqlx::SqlitePool, id: &str) -> ApiResult<WishlistItem> {
    decode(
        sqlx::query(items_sql!(" WHERE w.id=?"))
            .bind(id)
            .fetch_optional(pool)
            .await?
            .ok_or(ApiError(
                StatusCode::NOT_FOUND,
                "Wunschlisteneintrag nicht gefunden.",
            ))?,
    )
}

pub(crate) async fn track_edition(
    conn: &mut sqlx::SqliteConnection,
    game: &CatalogGame,
    platform_id: i64,
) -> ApiResult<String> {
    let existing:Option<String>=sqlx::query_scalar("SELECT w.id FROM wishlist_item w JOIN game g ON g.id=w.game_id WHERE g.igdb_id=? AND w.platform_id=?")
        .bind(game.igdb_id).bind(platform_id).fetch_optional(&mut *conn).await?;
    let track = if let Some(track) = existing {
        track
    } else {
        let count: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM wishlist_item WHERE state='preview'")
                .fetch_one(&mut *conn)
                .await?;
        if count >= 3000 {
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
            .execute(&mut *conn)
            .await?;
        let game_id: String = sqlx::query_scalar("SELECT id FROM game WHERE igdb_id=?")
            .bind(game.igdb_id)
            .fetch_one(&mut *conn)
            .await?;
        let track = random_token().map_err(|_| internal())?[..32].to_string();
        sqlx::query("INSERT INTO wishlist_item(id,game_id,platform_id,created_at,state,viewed_at) VALUES(?,?,?,?,'preview',?)")
            .bind(&track)
            .bind(game_id)
            .bind(platform_id)
            .bind(now())
            .bind(now())
            .execute(&mut *conn)
            .await?;
        track
    };
    Ok(track)
}

async fn with_badge(state: &crate::AppState, mut item: WishlistItem) -> ApiResult<WishlistItem> {
    let (target, scope) = crate::price_badges::context(&state.pool).await?;
    item.price_badge = Some(crate::price_badges::load(state, &item.id, &target, &scope).await?);
    Ok(item)
}
