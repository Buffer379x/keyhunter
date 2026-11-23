use crate::extract::{ApiJson, ApiPath};
use crate::{
    ApiError, ApiResult, Shared, auth,
    catalog::{self, provider::CatalogGame},
    eventlog::{self, Area, Level},
    internal, now, random_token,
};
use axum::{
    Json,
    extract::State,
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
    /// In the shopping cart (0.8.0).
    in_cart: bool,
    /// Paused on its own (0.9.0): no automatic checks until `paused_until` (null: until resumed).
    paused: bool,
    paused_until: Option<i64>,
    /// Offers of the confirmed products of active shops, one per valid seller price (0.9.1, the count of the tab
    /// Angebote; one rule since 0.9.3, [`crate::offers::Link::offer_count`], FUNC-11). Only with the price badge.
    #[serde(skip_serializing_if = "Option::is_none")]
    offer_count: Option<i64>,
    /// Mappings waiting for the owner (0.9.1): products not yet confirmed or rejected, and confirmed ones the shop renamed.
    review_count: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) price_badge: Option<crate::price_badges::PriceBadge>,
}
macro_rules! items_sql {
    ($suffix:literal) => { concat!("SELECT w.id, w.game_id, w.platform_id, w.created_at, g.manual_title, c.payload, EXISTS(SELECT 1 FROM cart_item k WHERE k.wish_id = w.id) AS in_cart, w.paused_at IS NOT NULL AND (w.paused_until IS NULL OR w.paused_until > CAST(strftime('%s','now') AS INTEGER)) AS paused, w.paused_until, (SELECT COUNT(*) FROM offer_link l JOIN source_settings s ON s.id = l.source WHERE l.wish_id = w.id AND s.enabled AND s.configured AND (l.review = 'pending' OR (l.review = 'confirmed' AND l.confirmed_name IS NOT NULL AND l.confirmed_name != json_extract(l.latest, '$.name')))) AS review_count FROM wishlist_item w JOIN game g ON g.id = w.game_id LEFT JOIN catalog_game c ON c.igdb_id = g.igdb_id", $suffix) };
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
        in_cart: row.get("in_cart"),
        // Library rows have no pause.
        paused: row.try_get("paused").unwrap_or(false),
        paused_until: row
            .try_get("paused")
            .unwrap_or(false)
            .then(|| row.try_get("paused_until").ok().flatten())
            .flatten(),
        offer_count: None,
        review_count: row.try_get("review_count").unwrap_or(0),
        price_badge: None,
    })
}

/// GET /api/v1/counts: the numbers of the navigation (CODE-08), the same rows the wishlist, cart, library and
/// alert lists show (enabled alerts only), without building those lists.
pub(crate) async fn counts(
    State(state): State<Shared>,
    _: auth::Session,
) -> ApiResult<Json<serde_json::Value>> {
    let (wishlist, cart, library, alerts): (i64, i64, i64, i64) = sqlx::query_as(
        "SELECT (SELECT COUNT(*) FROM wishlist_item WHERE state='wished'),
        (SELECT COUNT(*) FROM cart_item k JOIN wishlist_item w ON w.id=k.wish_id WHERE w.state='wished'),
        (SELECT COUNT(*) FROM wishlist_item WHERE state='owned'),
        (SELECT COUNT(*) FROM alert_rule r JOIN wishlist_item w ON w.id=r.wish_id WHERE w.state='wished' AND r.enabled)",
    )
    .fetch_one(&state.pool)
    .await?;
    Ok(Json(
        serde_json::json!({"wishlist": wishlist, "cart": cart, "library": library, "alerts": alerts}),
    ))
}

pub(crate) async fn list(
    State(state): State<Shared>,
    _: auth::Session,
) -> ApiResult<Json<Vec<WishlistItem>>> {
    let rows = sqlx::query(items_sql!(
        " WHERE w.state='wished' ORDER BY w.created_at DESC, w.rowid DESC"
    ))
    .fetch_all(&state.pool)
    .await?;
    let items = rows
        .into_iter()
        .map(decode)
        .collect::<ApiResult<Vec<_>>>()?;
    Ok(Json(with_badges(&state, items).await?))
}

/// The wished items with these ids (in no particular order), each with its price badge.
pub(crate) async fn items(state: &Shared, ids: &[String]) -> ApiResult<Vec<WishlistItem>> {
    let ids = serde_json::to_string(ids).map_err(|_| internal())?;
    let rows = sqlx::query(items_sql!(
        " WHERE w.state='wished' AND w.id IN (SELECT value FROM json_each(?))"
    ))
    .bind(ids)
    .fetch_all(&state.pool)
    .await?;
    let items = rows
        .into_iter()
        .map(decode)
        .collect::<ApiResult<Vec<_>>>()?;
    with_badges(state, items).await
}

async fn with_badges(state: &Shared, mut items: Vec<WishlistItem>) -> ApiResult<Vec<WishlistItem>> {
    let target = crate::offers::target(&state.pool).await?;
    let ids: Vec<String> = items.iter().map(|item| item.id.clone()).collect();
    let mut badges = crate::price_badges::load_many(state, &ids, &target).await?;
    for item in &mut items {
        item.price_badge = badges.remove(&item.id);
        item.offer_count = item.price_badge.as_ref().map(|badge| badge.offer_count);
    }
    Ok(items)
}

#[derive(Deserialize)]
pub(crate) struct AddInput {
    igdb_id: Option<i64>,
    manual_title: Option<String>,
    platform_id: i64,
    #[serde(default)]
    confirm_owned: bool,
}

/// The game a user picked for a platform: a catalog game that fits it, or a checked manual title.
struct Target {
    igdb_id: Option<i64>,
    manual_title: Option<String>,
    manual_key: Option<String>,
    /// Catalog family (the base game of an edition) for the ownership warning.
    family: Option<i64>,
}

impl Target {
    async fn check(
        state: &Shared,
        igdb_id: Option<i64>,
        manual_title: Option<String>,
        platform_id: i64,
    ) -> ApiResult<Self> {
        if !catalog::platform_valid(platform_id) {
            return Err(ApiError(
                StatusCode::BAD_REQUEST,
                "Nicht unterstützte Plattform.",
            ));
        }
        match (igdb_id, manual_title) {
            (Some(id), None) if id > 0 => {
                let game = catalog::load_game(state, id).await?;
                if !game.platforms.iter().any(|p| p.id == platform_id) || !game.selection_allowed()
                {
                    return Err(ApiError(
                        StatusCode::UNPROCESSABLE_ENTITY,
                        "Plattform oder Produkttyp passt nicht zu einem eigenständig vorgemerkten Xbox-Spiel bzw. einer Edition.",
                    ));
                }
                Ok(Self {
                    igdb_id: Some(id),
                    manual_title: None,
                    manual_key: None,
                    family: Some(game.version_parent.unwrap_or(game.igdb_id)),
                })
            }
            (None, Some(title)) => {
                let title = title.trim();
                if !(2..=200).contains(&title.chars().count())
                    || title.chars().any(char::is_control)
                {
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
                Ok(Self {
                    igdb_id: None,
                    manual_title: Some(title.to_string()),
                    manual_key: Some(key),
                    family: None,
                })
            }
            _ => Err(ApiError(
                StatusCode::BAD_REQUEST,
                "Entweder Katalog-ID oder manuellen Titel angeben.",
            )),
        }
    }

    /// Id of the game row, created on first use.
    async fn game(&self, tx: &mut sqlx::SqliteConnection) -> ApiResult<String> {
        let game_id = random_token().map_err(|_| internal())?[..32].to_string();
        sqlx::query("INSERT INTO game (id, igdb_id, manual_title, manual_key, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING")
            .bind(&game_id).bind(self.igdb_id).bind(&self.manual_title).bind(&self.manual_key).bind(now()).execute(&mut *tx).await?;
        Ok(if let Some(id) = self.igdb_id {
            sqlx::query_scalar("SELECT id FROM game WHERE igdb_id = ?")
                .bind(id)
                .fetch_one(&mut *tx)
                .await?
        } else {
            sqlx::query_scalar("SELECT id FROM game WHERE manual_key = ?")
                .bind(&self.manual_key)
                .fetch_one(&mut *tx)
                .await?
        })
    }
}

/// What putting a game on the wishlist did.
pub(crate) enum Added {
    /// The wish after the call; `created` is false when it was already on the list.
    Wish {
        item: Box<WishlistItem>,
        created: bool,
    },
    /// The game (its title) is in the library and the caller did not confirm.
    InLibrary(String),
}

/// How [`add_wish`] puts a game on the list.
#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum AddMode {
    /// The add dialog: the first search is a direct user action and starts at once.
    ByHand,
    /// An import: the first search waits for its turn in the shop's pacing, so a restore of many wishes leaves
    /// the daily budget to the regular checks (P2).
    Import,
    /// The preview of an import: decided the same way, then rolled back.
    DryRun,
}

/// The one path onto the wishlist, for the add dialog and the import (PROD-01). A dry run decides everything the
/// same way but rolls back, so a preview and the import that follows agree. The search job is written in the same
/// transaction as the wish, so an interrupted request never leaves a wish without one (P3).
pub(crate) async fn add_wish(state: &Shared, input: AddInput, mode: AddMode) -> ApiResult<Added> {
    if let (Some(id), None) = (input.igdb_id, &input.manual_title) {
        let existing = sqlx::query(items_sql!(
            " WHERE g.igdb_id = ? AND w.platform_id = ? AND w.state='wished'"
        ))
        .bind(id)
        .bind(input.platform_id)
        .fetch_optional(&state.pool)
        .await?;
        if let Some(row) = existing {
            return Ok(Added::Wish {
                item: Box::new(decode(row)?),
                created: false,
            });
        }
    }
    let target = Target::check(state, input.igdb_id, input.manual_title, input.platform_id).await?;
    let family = target.family;
    let mut tx = state.pool.begin().await?;
    let game_id = target.game(&mut tx).await?;
    if !input.confirm_owned {
        let owned: Option<String> = sqlx::query_scalar("SELECT COALESCE(g.manual_title,json_extract(c.payload,'$.name'),'Spiel') FROM wishlist_item w JOIN game g ON g.id=w.game_id LEFT JOIN catalog_game c ON c.igdb_id=g.igdb_id WHERE w.state='owned' AND (g.id=? OR (? IS NOT NULL AND COALESCE(json_extract(c.payload,'$.version_parent'),g.igdb_id)=?)) LIMIT 1")
            .bind(&game_id).bind(family).bind(family).fetch_optional(&mut *tx).await?;
        if let Some(title) = owned {
            return Ok(Added::InLibrary(title));
        }
    }
    let item_id = random_token().map_err(|_| internal())?[..32].to_string();
    let inserted = sqlx::query("INSERT INTO wishlist_item (id, game_id, platform_id, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(game_id, platform_id) DO NOTHING")
        .bind(item_id).bind(&game_id).bind(input.platform_id).bind(now()).execute(&mut *tx).await?;
    let row = sqlx::query(items_sql!(" WHERE w.game_id = ? AND w.platform_id = ?"))
        .bind(&game_id)
        .bind(input.platform_id)
        .fetch_optional(&mut *tx)
        .await?;
    // The wishlist has no size limit (0.9.0); the row exists after the insert or the conflict.
    let Some(row) = row else {
        return Err(internal());
    };
    let mut item = decode(row)?;
    let item_state: String = sqlx::query_scalar("SELECT state FROM wishlist_item WHERE id=?")
        .bind(&item.id)
        .fetch_one(&mut *tx)
        .await?;
    let moved = item_state != "wished";
    if moved {
        item.created_at = now();
        sqlx::query("UPDATE wishlist_item SET state='wished',viewed_at=NULL,acquired_at=NULL,created_at=? WHERE id=?")
            .bind(item.created_at)
            .bind(&item.id)
            .execute(&mut *tx)
            .await?;
    }
    let created = inserted.rows_affected() == 1 || moved;
    if mode == AddMode::DryRun {
        tx.rollback().await?;
        return Ok(Added::Wish {
            item: Box::new(item),
            created,
        });
    }
    let direct = mode == AddMode::ByHand;
    crate::jobs::attach::queue_search(&mut tx, &item.id, direct).await?;
    tx.commit().await?;
    if created {
        let game = eventlog::game(&state.pool, &item.id).await;
        eventlog::record(
            &state.pool,
            Level::Info,
            Area::Wishlist,
            format!("{game} hinzugefügt"),
        )
        .await;
    }
    crate::jobs::attach::attach_candidates(&state.pool, &item.id, direct).await;
    Ok(Added::Wish {
        item: Box::new(item),
        created,
    })
}

pub(crate) async fn add(
    State(state): State<Shared>,
    session: auth::Session,
    headers: HeaderMap,
    ApiJson(input): ApiJson<AddInput>,
) -> ApiResult<Response> {
    auth::require_csrf(&state, &headers, &session)?;
    Ok(match add_wish(&state, input, AddMode::ByHand).await? {
        Added::InLibrary(title) => (
            StatusCode::CONFLICT,
            Json(serde_json::json!({"error":format!("„{title}“ ist bereits in deiner Bibliothek. Wirklich fortfahren?"),"code":"owned_game"})),
        )
            .into_response(),
        Added::Wish { item, created } => (
            if created {
                StatusCode::CREATED
            } else {
                StatusCode::OK
            },
            Json(serde_json::json!({"item":with_badge(&state,*item).await?,"created":created})),
        )
            .into_response(),
    })
}

/// Entries one import request handles: unknown games are fetched from the catalog one by one, and a request ends
/// after a minute (the page sends longer files in several requests).
const IMPORT_ENTRIES: usize = 100;

#[derive(Deserialize)]
pub(crate) struct ImportInput {
    version: i64,
    items: Vec<serde_json::Value>,
    /// Only report what would happen.
    #[serde(default)]
    dry_run: bool,
}

#[derive(Deserialize)]
struct ImportEntry {
    title: Option<String>,
    platform: String,
    igdb_id: Option<i64>,
}

#[derive(Serialize)]
struct ImportResult {
    title: String,
    platform: String,
    /// `added`, `existing` (already on the list), `library`, `unknown` (the catalog does not know the game for that
    /// system) or `invalid`.
    status: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    message: Option<String>,
}

/// POST /api/v1/wishlist/import: the file of the export, each entry through [`add_wish`] like a wish added by hand
/// (PROD-01), except that the first searches wait for the shop's pacing (P2). It only adds: nothing is removed or
/// overwritten, a game in the library stays there, and a second import of the same file adds nothing.
pub(crate) async fn import(
    State(state): State<Shared>,
    session: auth::Session,
    headers: HeaderMap,
    ApiJson(input): ApiJson<ImportInput>,
) -> ApiResult<Json<serde_json::Value>> {
    auth::require_csrf(&state, &headers, &session)?;
    if input.version != 1 {
        return Err(ApiError(
            StatusCode::UNPROCESSABLE_ENTITY,
            "Diese Datei hat eine unbekannte Version und stammt nicht aus dem Export von KeyHunter.",
        ));
    }
    if input.items.len() > IMPORT_ENTRIES {
        return Err(ApiError(
            StatusCode::UNPROCESSABLE_ENTITY,
            "Höchstens 100 Einträge pro Anfrage.",
        ));
    }
    let mut seen = std::collections::HashSet::new();
    let mut results = Vec::with_capacity(input.items.len());
    for value in input.items {
        let Ok(entry) = serde_json::from_value::<ImportEntry>(value) else {
            results.push(ImportResult {
                title: String::new(),
                platform: String::new(),
                status: "invalid",
                message: Some("Der Eintrag hat nicht das Format des Exports.".into()),
            });
            continue;
        };
        let (status, message) = import_entry(&state, &entry, &mut seen, input.dry_run).await?;
        results.push(ImportResult {
            title: entry.title.unwrap_or_default(),
            platform: entry.platform,
            status,
            message,
        });
    }
    let count = |status: &str| results.iter().filter(|r| r.status == status).count();
    Ok(Json(serde_json::json!({
        "dry_run": input.dry_run,
        "counts": {
            "added": count("added"),
            "existing": count("existing"),
            "library": count("library"),
            "unknown": count("unknown"),
            "invalid": count("invalid"),
        },
        "results": results,
    })))
}

/// One entry of an import: its status and, for a refusal, the reason. Only an unavailable catalog ends the import
/// (nothing is lost: running it again adds the rest).
async fn import_entry(
    state: &Shared,
    entry: &ImportEntry,
    seen: &mut std::collections::HashSet<(String, i64)>,
    dry_run: bool,
) -> ApiResult<(&'static str, Option<String>)> {
    let Some(platform_id) = catalog::platform_by_name(&entry.platform) else {
        return Ok((
            "unknown",
            Some(format!(
                "Plattform „{}“ wird nicht unterstützt.",
                entry.platform
            )),
        ));
    };
    let (igdb_id, manual_title) = match (entry.igdb_id, entry.title.as_deref()) {
        (Some(id), _) => (Some(id), None),
        (None, Some(title)) => (None, Some(title.to_string())),
        (None, None) => return Ok(("invalid", Some("Der Eintrag hat keinen Titel.".into()))),
    };
    let key = match (igdb_id, &manual_title) {
        (Some(id), _) => id.to_string(),
        (None, title) => title
            .iter()
            .flat_map(|t| t.split_whitespace())
            .collect::<Vec<_>>()
            .join(" ")
            .to_lowercase(),
    };
    if !seen.insert((key, platform_id)) {
        return Ok(("existing", Some("Steht in der Datei mehrfach.".into())));
    }
    let added = add_wish(
        state,
        AddInput {
            igdb_id,
            manual_title,
            platform_id,
            confirm_owned: false,
        },
        if dry_run {
            AddMode::DryRun
        } else {
            AddMode::Import
        },
    )
    .await;
    Ok(match added {
        Ok(Added::Wish { created: true, .. }) => ("added", None),
        Ok(Added::Wish { .. }) => ("existing", None),
        Ok(Added::InLibrary(title)) => (
            "library",
            Some(format!("„{title}“ ist schon in der Bibliothek.")),
        ),
        Err(ApiError(StatusCode::BAD_REQUEST, message)) => ("invalid", Some(message.into())),
        Err(ApiError(StatusCode::NOT_FOUND | StatusCode::UNPROCESSABLE_ENTITY, message)) => {
            ("unknown", Some(message.into()))
        }
        Err(error) => return Err(error),
    })
}

#[derive(Deserialize)]
pub(crate) struct PreviewInput {
    igdb_id: i64,
}

pub(crate) async fn preview(
    State(state): State<Shared>,
    session: auth::Session,
    headers: HeaderMap,
    ApiPath(id): ApiPath<String>,
    ApiJson(input): ApiJson<PreviewInput>,
) -> ApiResult<Json<serde_json::Value>> {
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
    crate::jobs::attach::schedule_wish(&state.pool, &track).await?;
    let item = with_badge(&state, item).await?;
    Ok(Json(serde_json::json!({"item":item})))
}

pub(crate) async fn remove(
    State(state): State<Shared>,
    session: auth::Session,
    headers: HeaderMap,
    ApiPath(id): ApiPath<String>,
) -> ApiResult<StatusCode> {
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
    let removed = match item_state.as_deref() {
        Some("wished") => Some((Area::Wishlist, "von der Wunschliste entfernt")),
        Some("owned") => Some((Area::Library, "aus der Bibliothek entfernt")),
        _ => None,
    };
    let game = eventlog::game(&mut *tx, &id).await;
    if removed.is_some() {
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
    if let Some((area, what)) = removed {
        eventlog::record(&state.pool, Level::Info, area, format!("{game} {what}")).await;
    }
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
    _: auth::Session,
) -> ApiResult<Json<Vec<LibraryItem>>> {
    let rows = sqlx::query("SELECT w.id,w.game_id,w.platform_id,w.created_at,g.manual_title,c.payload,0 AS in_cart,COALESCE(w.acquired_at,0) AS acquired_at FROM wishlist_item w JOIN game g ON g.id=w.game_id LEFT JOIN catalog_game c ON c.igdb_id=g.igdb_id WHERE w.state='owned' ORDER BY w.acquired_at DESC,w.rowid DESC")
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

#[derive(Deserialize)]
pub(crate) struct PauseInput {
    paused: bool,
    /// End of the pause (unix seconds); absent or null: until resumed by hand.
    until: Option<i64>,
}

/// Longest pause with an end date: one year.
const PAUSE_MAX: i64 = 366 * crate::DAY;

/// `PUT /wishlist/{id}/pause` (0.9.0): pause or resume the automatic checks of one wish. The global
/// pause does not touch it: a wish paused here stays paused when the checks are resumed.
pub(crate) async fn pause(
    State(state): State<Shared>,
    session: auth::Session,
    headers: HeaderMap,
    ApiPath(id): ApiPath<String>,
    ApiJson(input): ApiJson<PauseInput>,
) -> ApiResult<Json<WishlistItem>> {
    auth::require_csrf(&state, &headers, &session)?;
    let t = now();
    if input.paused
        && input
            .until
            .is_some_and(|until| until <= t || until > t + PAUSE_MAX)
    {
        return Err(ApiError(
            StatusCode::BAD_REQUEST,
            "Das Ende der Pause muss in der Zukunft liegen, höchstens ein Jahr.",
        ));
    }
    let (at, until) = if input.paused {
        (Some(t), input.until)
    } else {
        (None, None)
    };
    let changed = sqlx::query(
        "UPDATE wishlist_item SET paused_at=?,paused_until=? WHERE id=? AND state='wished'",
    )
    .bind(at)
    .bind(until)
    .bind(&id)
    .execute(&state.pool)
    .await?;
    if changed.rows_affected() == 0 {
        return Err(ApiError(
            StatusCode::NOT_FOUND,
            "Wunschlisteneintrag nicht gefunden.",
        ));
    }
    let row = sqlx::query(items_sql!(" WHERE w.id = ?"))
        .bind(&id)
        .fetch_one(&state.pool)
        .await?;
    let game = eventlog::game(&state.pool, &id).await;
    let message = match (input.paused, until) {
        (false, _) => format!("{game}: Abfragen fortgesetzt"),
        (true, None) => format!("{game}: Abfragen pausiert, bis sie fortgesetzt werden"),
        (true, Some(end)) => format!("{game}: Abfragen pausiert bis {}", date_text(end)),
    };
    eventlog::record(&state.pool, Level::Info, Area::Wishlist, message).await;
    Ok(Json(decode(row)?))
}

/// "24.12.2026" (UTC date) for the log.
fn date_text(seconds: i64) -> String {
    let (year, month, day) = civil(seconds);
    format!("{day:02}.{month:02}.{year}")
}

/// Year, month and day (UTC) of a Unix time.
pub(crate) fn civil(seconds: i64) -> (i64, i64, i64) {
    let days = seconds.div_euclid(crate::DAY);
    // Civil date from days since 1970-01-01 (Howard Hinnant's algorithm).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    (yoe + era * 400 + i64::from(month <= 2), month, day)
}

pub(crate) async fn purchase(
    State(state): State<Shared>,
    session: auth::Session,
    headers: HeaderMap,
    ApiPath(id): ApiPath<String>,
) -> ApiResult<StatusCode> {
    auth::require_csrf(&state, &headers, &session)?;
    let mut tx = state.pool.begin().await?;
    if !mark_owned(&mut tx, &id).await? {
        return Err(ApiError(
            StatusCode::NOT_FOUND,
            "Wunschlisteneintrag nicht gefunden oder bereits gekauft.",
        ));
    }
    tx.commit().await?;
    log_bought(&state, &id).await;
    Ok(StatusCode::NO_CONTENT)
}

async fn log_bought(state: &Shared, id: &str) {
    let game = eventlog::game(&state.pool, id).await;
    eventlog::record(
        &state.pool,
        Level::Info,
        Area::Wishlist,
        format!("{game} als gekauft in die Bibliothek verschoben"),
    )
    .await;
}

/// Moves a wish into the library: alerts stop, pending messages and tracked editions are cancelled and
/// in-flight fetches lose their lease. False when the item is not a wish.
async fn mark_owned(tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>, id: &str) -> ApiResult<bool> {
    let result = sqlx::query(
        "UPDATE wishlist_item SET state='owned',acquired_at=?,paused_at=NULL,paused_until=NULL WHERE id=? AND state='wished'",
    )
    .bind(now())
    .bind(id)
    .execute(&mut **tx)
    .await?;
    if result.rows_affected() == 0 {
        return Ok(false);
    }
    sqlx::query("UPDATE alert_rule SET enabled=0,scope=NULL,previous_cents=NULL,lowest_cents=NULL WHERE wish_id=?").bind(id).execute(&mut **tx).await?;
    sqlx::query("UPDATE alert_outbox SET state='cancelled' WHERE wish_id=? AND state='pending'")
        .bind(id)
        .execute(&mut **tx)
        .await?;
    crate::edition_tracking::cancel_children(tx, id).await?;
    // Bought: out of the shopping cart (0.8.0).
    sqlx::query("DELETE FROM cart_item WHERE wish_id=?")
        .bind(id)
        .execute(&mut **tx)
        .await?;
    // Revoke in-flight leases: their results cannot update observations or send alerts.
    sqlx::query("UPDATE shop_job SET lease_until=0,lease_token=NULL WHERE wish_id=? OR link_id IN (SELECT id FROM offer_link WHERE wish_id=?)").bind(id).bind(id).execute(&mut **tx).await?;
    Ok(true)
}

#[derive(Deserialize)]
pub(crate) struct OwnedInput {
    igdb_id: Option<i64>,
    manual_title: Option<String>,
    platform_id: i64,
    /// The game is on the wishlist: move it into the library as bought.
    #[serde(default)]
    confirm_wished: bool,
}

/// Adds a game straight to the library (0.7.2), without the wishlist. A game already in the library is
/// returned as it is; one on the wishlist moves over only after confirmation (`wished_game`), as if bought.
/// A preview of an edition becomes an owned item too.
pub(crate) async fn add_owned(
    State(state): State<Shared>,
    session: auth::Session,
    headers: HeaderMap,
    ApiJson(input): ApiJson<OwnedInput>,
) -> ApiResult<Response> {
    auth::require_csrf(&state, &headers, &session)?;
    let target =
        Target::check(&state, input.igdb_id, input.manual_title, input.platform_id).await?;
    let mut tx = state.pool.begin().await?;
    let game_id = target.game(&mut tx).await?;
    let existing: Option<(String, String)> =
        sqlx::query_as("SELECT id,state FROM wishlist_item WHERE game_id=? AND platform_id=?")
            .bind(&game_id)
            .bind(input.platform_id)
            .fetch_optional(&mut *tx)
            .await?;
    let mut bought = None;
    let created = match existing {
        Some((_, item_state)) if item_state == "owned" => false,
        Some((id, item_state)) if item_state == "wished" => {
            if !input.confirm_wished {
                let title: String = sqlx::query_scalar("SELECT COALESCE(g.manual_title,json_extract(c.payload,'$.name'),'Spiel') FROM game g LEFT JOIN catalog_game c ON c.igdb_id=g.igdb_id WHERE g.id=?")
                    .bind(&game_id).fetch_one(&mut *tx).await?;
                return Ok((StatusCode::CONFLICT, Json(serde_json::json!({"error":format!("„{title}“ steht auf deiner Wunschliste. Als gekauft in die Bibliothek verschieben?"),"code":"wished_game"}))).into_response());
            }
            let moved = mark_owned(&mut tx, &id).await?;
            bought = moved.then_some(id);
            moved
        }
        Some((id, _)) => {
            // An edition preview: no alerts, nothing watched any more once it is owned.
            sqlx::query(
                "UPDATE wishlist_item SET state='owned',acquired_at=?,viewed_at=NULL WHERE id=?",
            )
            .bind(now())
            .bind(&id)
            .execute(&mut *tx)
            .await?;
            sqlx::query("UPDATE shop_job SET lease_until=0,lease_token=NULL WHERE wish_id=? OR link_id IN (SELECT id FROM offer_link WHERE wish_id=?)").bind(&id).bind(&id).execute(&mut *tx).await?;
            true
        }
        None => {
            let id = random_token().map_err(|_| internal())?[..32].to_string();
            let t = now();
            sqlx::query("INSERT INTO wishlist_item (id,game_id,platform_id,created_at,state,acquired_at) VALUES (?,?,?,?,'owned',?)")
                .bind(&id).bind(&game_id).bind(input.platform_id).bind(t).bind(t).execute(&mut *tx).await?;
            true
        }
    };
    let row = sqlx::query("SELECT w.id,w.game_id,w.platform_id,w.created_at,g.manual_title,c.payload,EXISTS(SELECT 1 FROM cart_item k WHERE k.wish_id=w.id) AS in_cart,COALESCE(w.acquired_at,0) AS acquired_at FROM wishlist_item w JOIN game g ON g.id=w.game_id LEFT JOIN catalog_game c ON c.igdb_id=g.igdb_id WHERE w.game_id=? AND w.platform_id=?")
        .bind(&game_id)
        .bind(input.platform_id)
        .fetch_one(&mut *tx)
        .await?;
    tx.commit().await?;
    let acquired_at = row.get("acquired_at");
    let item = LibraryItem {
        item: decode(row)?,
        acquired_at,
    };
    if let Some(id) = bought {
        log_bought(&state, &id).await;
    } else if created {
        let game = eventlog::game(&state.pool, &item.item.id).await;
        eventlog::record(
            &state.pool,
            Level::Info,
            Area::Library,
            format!("{game} zur Bibliothek hinzugefügt"),
        )
        .await;
    }
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
pub(crate) struct RestoreInput {
    #[serde(default)]
    confirm: bool,
}
pub(crate) async fn restore(
    State(state): State<Shared>,
    session: auth::Session,
    headers: HeaderMap,
    ApiPath(id): ApiPath<String>,
    ApiJson(input): ApiJson<RestoreInput>,
) -> ApiResult<StatusCode> {
    auth::require_csrf(&state, &headers, &session)?;
    if !input.confirm {
        return Err(ApiError(
            StatusCode::CONFLICT,
            "Zurücksetzen in die Wunschliste bitte bestätigen.",
        ));
    }
    let mut tx = state.pool.begin().await?;
    let deleted=sqlx::query("UPDATE wishlist_item SET state='wished',acquired_at=NULL,created_at=? WHERE id=? AND state='owned'")
        .bind(now()).bind(&id).execute(&mut *tx).await?;
    if deleted.rows_affected() == 0 {
        return Err(ApiError(
            StatusCode::CONFLICT,
            "Bibliothekseintrag nicht gefunden.",
        ));
    }
    tx.commit().await?;
    let game = eventlog::game(&state.pool, &id).await;
    eventlog::record(
        &state.pool,
        Level::Info,
        Area::Wishlist,
        format!("{game} aus der Bibliothek in die Wunschliste zurückgesetzt"),
    )
    .await;
    crate::jobs::attach::schedule_wish(&state.pool, &id).await?;
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
    let target = crate::offers::target(&state.pool).await?;
    let badge = crate::price_badges::load(state, &item.id, &target).await?;
    item.offer_count = Some(badge.offer_count);
    item.price_badge = Some(badge);
    Ok(item)
}
