use crate::extract::ApiPath;
use crate::{
    ApiError, ApiResult, Shared, auth, catalog,
    eventlog::{self, Area, Level},
    now,
    wishlist::{self, WishlistItem},
};
use axum::{
    Json,
    extract::State,
    http::{HeaderMap, StatusCode},
};
use serde::Serialize;
use std::time::Duration;

const ACTIVE: &str = "SELECT w.id FROM wishlist_item w WHERE w.id=? AND w.state='wished'";
const MISSING: ApiError = ApiError(StatusCode::NOT_FOUND, "Wunschlisteneintrag nicht gefunden.");
#[derive(Serialize)]
pub(crate) struct Prepared {
    items: Vec<WishlistItem>,
    preparing: bool,
    error: Option<&'static str>,
}

async fn anchor(state: &Shared, id: &str) -> ApiResult<WishlistItem> {
    if sqlx::query_scalar::<_, String>(ACTIVE)
        .bind(id)
        .fetch_optional(&state.pool)
        .await?
        .is_none()
    {
        return Err(MISSING);
    }
    wishlist::item(&state.pool, id).await
}
async fn snapshot(state: &Shared, id: &str) -> ApiResult<Prepared> {
    let saved = anchor(state, id).await?;
    // Opening a game counts as viewing its editions: their previews keep being fetched.
    let t = now();
    sqlx::query("UPDATE wishlist_item SET viewed_at=? WHERE state='preview' AND COALESCE(viewed_at,0)<? AND id IN (SELECT track_id FROM edition_watch WHERE wish_id=?)")
        .bind(t)
        .bind(t - 300)
        .bind(id)
        .execute(&state.pool)
        .await?;
    let mut items = vec![saved];
    let ids: Vec<String> =
        sqlx::query_scalar("SELECT track_id FROM edition_watch WHERE wish_id=? ORDER BY track_id")
            .bind(id)
            .fetch_all(&state.pool)
            .await?;
    for track in ids {
        items.push(wishlist::item(&state.pool, &track).await?);
    }
    let target = crate::offers::target(&state.pool).await?;
    let ids: Vec<String> = items.iter().map(|item| item.id.clone()).collect();
    let mut badges = crate::price_badges::load_many(state, &ids, &target).await?;
    for item in &mut items {
        item.price_badge = badges.remove(&item.id);
    }
    let scan: Option<(i64, Option<String>)> =
        sqlx::query_as("SELECT lease_until,last_error FROM edition_scan WHERE wish_id=?")
            .bind(id)
            .fetch_optional(&state.pool)
            .await?;
    Ok(Prepared{items,preparing:scan.as_ref().is_some_and(|(lease,_)|*lease>now()),error:scan.and_then(|(_,error)|error).map(|_|"Editionen konnten noch nicht vorbereitet werden. Die Datenquelle wird später erneut geprüft.")})
}

pub(crate) async fn get(
    State(state): State<Shared>,
    _: auth::Session,
    ApiPath(id): ApiPath<String>,
) -> ApiResult<Json<Prepared>> {
    Ok(Json(snapshot(&state, &id).await?))
}
pub(crate) async fn prepare(
    State(state): State<Shared>,
    session: auth::Session,
    ApiPath(id): ApiPath<String>,
    headers: HeaderMap,
) -> ApiResult<Json<Prepared>> {
    auth::require_csrf(&state, &headers, &session)?;
    prepare_one(&state, &id).await?;
    Ok(Json(snapshot(&state, &id).await?))
}

async fn prepare_one(state: &Shared, id: &str) -> ApiResult<()> {
    let saved = anchor(state, id).await?;
    let Some(game) = saved.game else {
        return Ok(());
    };
    let t = now();
    let claimed=sqlx::query("INSERT INTO edition_scan(wish_id,lease_until) VALUES(?,?) ON CONFLICT(wish_id) DO UPDATE SET lease_until=excluded.lease_until WHERE edition_scan.lease_until<=? AND edition_scan.next_attempt<=?")
        .bind(id).bind(t+180).bind(t).bind(t).execute(&state.pool).await?.rows_affected();
    if claimed == 0 {
        return Ok(());
    }
    let result=async {
        catalog::enabled(state).await?;
        let parent=game.version_parent.unwrap_or(game.igdb_id);
        let games=state.catalog.editions(parent).await.map_err(catalog::provider_error)?;
        let mut games:Vec<_>=games.into_iter().filter(|entry|entry.selection_allowed()&&entry.platforms.iter().any(|p|p.id==saved.platform_id)&&entry.version_parent.unwrap_or(entry.igdb_id)==parent).take(30).collect();
        if !games.iter().any(|entry|entry.igdb_id==game.igdb_id){games.truncate(29);games.insert(0,game);}
        catalog::save_games(state,&games).await?;
        let mut tx=state.pool.begin().await?;
        if sqlx::query_scalar::<_,String>(ACTIVE).bind(id).fetch_optional(&mut *tx).await?.is_none(){return Err(MISSING);}
        for entry in games {
            let track=wishlist::track_edition(&mut tx,&entry,saved.platform_id).await?;
            if track!=id {sqlx::query("INSERT OR IGNORE INTO edition_watch(wish_id,track_id) VALUES(?,?)").bind(id).bind(&track).execute(&mut *tx).await?;}
        }
        sqlx::query("UPDATE edition_scan SET checked_at=?,lease_until=0,next_attempt=?,last_error=NULL WHERE wish_id=?").bind(now()).bind(now()+crate::DAY).bind(id).execute(&mut *tx).await?;
        tx.commit().await?;
        let ids:Vec<String>=sqlx::query_scalar("SELECT track_id FROM edition_watch WHERE wish_id=?").bind(id).fetch_all(&state.pool).await?;
        for track in ids {crate::jobs::schedule_wish(&state.pool,&track).await?;}
        Ok::<_,ApiError>(())
    }.await;
    if let Err(error) = result {
        tracing::warn!(status=%error.0,reason=error.1,"Edition preparation incomplete");
        let game = eventlog::game(&state.pool, id).await;
        eventlog::record_once(
            &state.pool,
            Level::Warn,
            Area::Fetch,
            format!(
                "Editionen für {game} konnten nicht vorbereitet werden. {}",
                error.1
            ),
            eventlog::REPEAT,
        )
        .await;
        sqlx::query("UPDATE edition_scan SET checked_at=?,lease_until=0,next_attempt=?,last_error='catalog_unavailable' WHERE wish_id=?").bind(now()).bind(now()+RETRY_AFTER_OUTAGE).bind(id).execute(&state.pool).await?;
    }
    // A catalog outage leaves the saved selection and any prepared observations usable.
    Ok(())
}

/// After a catalog outage the editions are prepared again this much later (a day after success).
const RETRY_AFTER_OUTAGE: i64 = 900;

pub(crate) fn start(state: &Shared) {
    let state = state.clone();
    tokio::spawn(async move {
        loop {
            if state.catalog.status().await.configured {
                let id=sqlx::query_scalar::<_,String>("SELECT w.id FROM wishlist_item w JOIN game g ON g.id=w.game_id LEFT JOIN edition_scan e ON e.wish_id=w.id WHERE g.igdb_id IS NOT NULL AND w.state='wished' AND COALESCE(e.lease_until,0)<=? AND COALESCE(e.next_attempt,0)<=? AND EXISTS(SELECT 1 FROM source_settings WHERE id='igdb' AND enabled) ORDER BY COALESCE(e.next_attempt,0),w.created_at LIMIT 1")
                    .bind(now()).bind(now()).fetch_optional(&state.pool).await;
                if let Ok(Some(id)) = id
                    && prepare_one(&state, &id).await.is_err()
                {
                    tracing::warn!("Edition preparation could not access the saved selection");
                    eventlog::record_once(
                        &state.pool,
                        Level::Warn,
                        Area::Fetch,
                        "Editionen konnten nicht vorbereitet werden: Der gemerkte Eintrag war nicht lesbar.",
                        eventlog::REPEAT,
                    )
                    .await;
                }
            }
            tokio::time::sleep(Duration::from_secs(10)).await;
        }
    });
}

pub(crate) async fn cancel_children(
    conn: &mut sqlx::SqliteConnection,
    anchor: &str,
) -> sqlx::Result<()> {
    sqlx::query("UPDATE shop_job SET lease_until=0,lease_token=NULL WHERE COALESCE(wish_id,(SELECT wish_id FROM offer_link WHERE id=link_id)) IN (SELECT e.track_id FROM edition_watch e JOIN wishlist_item p ON p.id=e.track_id AND p.state='preview' WHERE e.wish_id=? AND NOT EXISTS(SELECT 1 FROM edition_watch other JOIN wishlist_item w ON w.id=other.wish_id WHERE other.track_id=e.track_id AND other.wish_id!=? AND w.state='wished'))")
        .bind(anchor).bind(anchor).execute(conn).await?;
    Ok(())
}
