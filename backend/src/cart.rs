//! Shopping cart (0.8.0): wishes the owner plans to buy together. The cart stores only which wishes
//! are in it; prices come from the same saved observations as the wishlist badges, so they follow
//! every new shop check.

use crate::{ApiError, ApiResult, Shared, auth, now, wishlist::WishlistItem};
use axum::{
    Json,
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
};
use serde::{Deserialize, Serialize};

#[derive(Serialize)]
pub(crate) struct CartEntry {
    added_at: i64,
    #[serde(flatten)]
    item: WishlistItem,
}

/// The cart, oldest first, each wish with its current price badge.
pub(crate) async fn list(
    State(state): State<Shared>,
    headers: HeaderMap,
) -> ApiResult<Json<Vec<CartEntry>>> {
    auth::authenticate(&state, &headers).await?;
    let rows: Vec<(String, i64)> = sqlx::query_as(
        "SELECT k.wish_id,k.added_at FROM cart_item k JOIN wishlist_item w ON w.id=k.wish_id
        WHERE w.state='wished' ORDER BY k.added_at,k.rowid",
    )
    .fetch_all(&state.pool)
    .await?;
    let ids: Vec<String> = rows.iter().map(|(id, _)| id.clone()).collect();
    let mut items = crate::wishlist::items(&state, &ids).await?;
    Ok(Json(
        rows.into_iter()
            .filter_map(|(id, added_at)| {
                let at = items.iter().position(|item| item.id == id)?;
                Some(CartEntry {
                    added_at,
                    item: items.swap_remove(at),
                })
            })
            .collect(),
    ))
}

#[derive(Deserialize)]
pub(crate) struct AddInput {
    wish_id: String,
}

const NOT_A_WISH: ApiError = ApiError(
    StatusCode::NOT_FOUND,
    "Nur Spiele der Wunschliste können in den Warenkorb.",
);

pub(crate) async fn add(
    State(state): State<Shared>,
    headers: HeaderMap,
    Json(input): Json<AddInput>,
) -> ApiResult<StatusCode> {
    let session = auth::authenticate(&state, &headers).await?;
    auth::require_csrf(&state, &headers, &session)?;
    let added = sqlx::query(
        "INSERT INTO cart_item(wish_id,added_at) SELECT id,? FROM wishlist_item WHERE id=? AND state='wished'
        ON CONFLICT(wish_id) DO NOTHING",
    )
    .bind(now())
    .bind(&input.wish_id)
    .execute(&state.pool)
    .await?
    .rows_affected();
    if added == 1 {
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

pub(crate) async fn remove(
    State(state): State<Shared>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> ApiResult<StatusCode> {
    let session = auth::authenticate(&state, &headers).await?;
    auth::require_csrf(&state, &headers, &session)?;
    let removed = sqlx::query("DELETE FROM cart_item WHERE wish_id=?")
        .bind(&id)
        .execute(&state.pool)
        .await?
        .rows_affected();
    if removed == 0 {
        return Err(ApiError(
            StatusCode::NOT_FOUND,
            "Dieses Spiel liegt nicht im Warenkorb.",
        ));
    }
    Ok(StatusCode::NO_CONTENT)
}
