//! Shopping cart (0.8.0): wishes the owner plans to buy together. The cart stores only which wishes
//! are in it; prices come from the same saved observations as the wishlist badges, so they follow
//! every new shop check.

use crate::extract::{ApiJson, ApiPath};
use crate::price_badges::ShopOffers;
use crate::{
    ApiError, ApiResult, Shared, auth,
    eventlog::{self, Area, Level},
    now,
    wishlist::WishlistItem,
};
use axum::{
    Json,
    extract::State,
    http::{HeaderMap, StatusCode},
};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Serialize)]
pub(crate) struct CartEntry {
    added_at: i64,
    /// The shop chosen in the cart; `None`: the cheapest one (0.8.1).
    source: Option<String>,
    /// `world`: the cheapest offer of any region; `home`: valid in the target country (0.8.1).
    scope: String,
    /// Each shop's best offers for this wish, so the cart can switch shop and scope at once.
    offers: BTreeMap<String, ShopOffers>,
    #[serde(flatten)]
    item: WishlistItem,
}

/// The cart, oldest first, each wish with its current price badge.
pub(crate) async fn list(
    State(state): State<Shared>,
    _: auth::Session,
) -> ApiResult<Json<Vec<CartEntry>>> {
    let rows: Vec<(String, i64, Option<String>, String)> = sqlx::query_as(
        "SELECT k.wish_id,k.added_at,k.source,k.scope FROM cart_item k JOIN wishlist_item w ON w.id=k.wish_id
        WHERE w.state='wished' ORDER BY k.added_at,k.rowid",
    )
    .fetch_all(&state.pool)
    .await?;
    let ids: Vec<String> = rows.iter().map(|(id, ..)| id.clone()).collect();
    let mut items = crate::wishlist::items(&state, &ids).await?;
    let target = crate::offers::target(&state.pool).await?;
    let mut offers = crate::price_badges::shop_offers(&state, &ids, &target).await?;
    Ok(Json(
        rows.into_iter()
            .filter_map(|(id, added_at, source, scope)| {
                let at = items.iter().position(|item| item.id == id)?;
                Some(CartEntry {
                    added_at,
                    source,
                    scope,
                    offers: offers.remove(&id).unwrap_or_default(),
                    item: items.swap_remove(at),
                })
            })
            .collect(),
    ))
}

#[derive(Deserialize)]
pub(crate) struct AddInput {
    wish_id: String,
    /// A shop from the Angebote tab (0.8.1); absent: the cheapest one.
    #[serde(default)]
    source: Option<String>,
    #[serde(default)]
    scope: Option<String>,
}

/// Shop and scope of a cart entry, checked: a known shop or `None`, and `home` or `world`.
fn choice(source: Option<String>, scope: Option<String>) -> ApiResult<(Option<String>, String)> {
    let scope = scope.unwrap_or_else(|| "world".into());
    if !matches!(scope.as_str(), "home" | "world")
        || source
            .as_deref()
            .is_some_and(|id| crate::shops::Shop::from_id(id).is_none())
    {
        return Err(ApiError(
            StatusCode::BAD_REQUEST,
            "Unbekannter Shop oder ungültige Preisgrundlage.",
        ));
    }
    Ok((source, scope))
}

const NOT_A_WISH: ApiError = ApiError(
    StatusCode::NOT_FOUND,
    "Nur Spiele der Wunschliste können in den Warenkorb.",
);

pub(crate) async fn add(
    State(state): State<Shared>,
    session: auth::Session,
    headers: HeaderMap,
    ApiJson(input): ApiJson<AddInput>,
) -> ApiResult<StatusCode> {
    auth::require_csrf(&state, &headers, &session)?;
    let (source, scope) = choice(input.source, input.scope)?;
    let added = sqlx::query(
        "INSERT INTO cart_item(wish_id,added_at,source,scope) SELECT id,?,?,? FROM wishlist_item WHERE id=? AND state='wished'
        ON CONFLICT(wish_id) DO NOTHING",
    )
    .bind(now())
    .bind(source)
    .bind(scope)
    .bind(&input.wish_id)
    .execute(&state.pool)
    .await?
    .rows_affected();
    if added == 1 {
        let game = eventlog::game(&state.pool, &input.wish_id).await;
        eventlog::record(
            &state.pool,
            Level::Info,
            Area::Cart,
            format!("{game} in den Warenkorb gelegt"),
        )
        .await;
        return Ok(StatusCode::CREATED);
    }
    let wished: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM wishlist_item WHERE id=? AND state='wished')",
    )
    .bind(&input.wish_id)
    .fetch_one(&state.pool)
    .await?;
    Err(if wished {
        ApiError(
            StatusCode::CONFLICT,
            "Dieses Spiel liegt schon im Warenkorb.",
        )
    } else {
        NOT_A_WISH
    })
}

#[derive(Deserialize)]
pub(crate) struct ChangeInput {
    /// `null`: back to the cheapest shop.
    source: Option<String>,
    scope: String,
}

/// Shop and price scope of one entry (cart page switch and shop choice, or an offer from the Angebote tab).
pub(crate) async fn change(
    State(state): State<Shared>,
    session: auth::Session,
    headers: HeaderMap,
    ApiPath(id): ApiPath<String>,
    ApiJson(input): ApiJson<ChangeInput>,
) -> ApiResult<StatusCode> {
    auth::require_csrf(&state, &headers, &session)?;
    let (source, scope) = choice(input.source, Some(input.scope))?;
    let changed = sqlx::query("UPDATE cart_item SET source=?,scope=? WHERE wish_id=?")
        .bind(&source)
        .bind(&scope)
        .bind(&id)
        .execute(&state.pool)
        .await?
        .rows_affected();
    if changed == 0 {
        return Err(NOT_IN_CART);
    }
    let shop = source
        .as_deref()
        .and_then(crate::shops::Shop::from_id)
        .map_or("günstigster Shop", crate::shops::Shop::name);
    let basis = if scope == "home" {
        "gültig im Zielland"
    } else {
        "jede Region"
    };
    let game = eventlog::game(&state.pool, &id).await;
    eventlog::record(
        &state.pool,
        Level::Info,
        Area::Cart,
        format!("{game} im Warenkorb umgestellt: {shop}, {basis}"),
    )
    .await;
    Ok(StatusCode::NO_CONTENT)
}

const NOT_IN_CART: ApiError = ApiError(
    StatusCode::NOT_FOUND,
    "Dieses Spiel liegt nicht im Warenkorb.",
);

pub(crate) async fn remove(
    State(state): State<Shared>,
    session: auth::Session,
    headers: HeaderMap,
    ApiPath(id): ApiPath<String>,
) -> ApiResult<StatusCode> {
    auth::require_csrf(&state, &headers, &session)?;
    let removed = sqlx::query("DELETE FROM cart_item WHERE wish_id=?")
        .bind(&id)
        .execute(&state.pool)
        .await?
        .rows_affected();
    if removed == 0 {
        return Err(NOT_IN_CART);
    }
    let game = eventlog::game(&state.pool, &id).await;
    eventlog::record(
        &state.pool,
        Level::Info,
        Area::Cart,
        format!("{game} aus dem Warenkorb entfernt"),
    )
    .await;
    Ok(StatusCode::NO_CONTENT)
}
