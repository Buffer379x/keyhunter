//! `Json`, `Query` and `Path` whose rejections answer like every other error: German JSON with a `code`, never
//! Axum's English plain text with serde details (CODE-02, FUNC-15, SEC-06). On protected routes the session is
//! checked before any of them runs ([`crate::auth::require_session`]).
use crate::ApiError;
use axum::{
    extract::{
        FromRequest, FromRequestParts, Path, Query, Request,
        rejection::{JsonRejection, PathRejection, QueryRejection},
    },
    http::{StatusCode, request::Parts},
};
use serde::de::DeserializeOwned;

/// A JSON request body.
pub(crate) struct ApiJson<T>(pub T);
/// The query string of the address.
pub(crate) struct ApiQuery<T>(pub T);
/// The parameters in the path of the address.
pub(crate) struct ApiPath<T>(pub T);

pub(crate) const TOO_LARGE: ApiError =
    ApiError(StatusCode::PAYLOAD_TOO_LARGE, "Die Anfrage ist zu groß.");
pub(crate) const UNREADABLE: ApiError = ApiError(
    StatusCode::BAD_REQUEST,
    "Die Anfrage konnte nicht gelesen werden.",
);

fn json_error(rejection: JsonRejection) -> ApiError {
    match rejection {
        JsonRejection::JsonDataError(_) => ApiError(
            StatusCode::BAD_REQUEST,
            "Die Anfrage enthält ungültige oder fehlende Werte.",
        ),
        JsonRejection::JsonSyntaxError(_) => ApiError(
            StatusCode::BAD_REQUEST,
            "Die Anfrage ist kein gültiges JSON.",
        ),
        JsonRejection::MissingJsonContentType(_) => ApiError(
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            "Die Anfrage muss als JSON gesendet werden.",
        ),
        other if other.status() == StatusCode::PAYLOAD_TOO_LARGE => TOO_LARGE,
        _ => UNREADABLE,
    }
}

impl<T: DeserializeOwned, S: Send + Sync> FromRequest<S> for ApiJson<T> {
    type Rejection = ApiError;
    async fn from_request(req: Request, state: &S) -> Result<Self, ApiError> {
        axum::Json::from_request(req, state)
            .await
            .map(|axum::Json(value)| Self(value))
            .map_err(json_error)
    }
}

impl<T: DeserializeOwned, S: Send + Sync> FromRequestParts<S> for ApiQuery<T> {
    type Rejection = ApiError;
    async fn from_request_parts(parts: &mut Parts, state: &S) -> Result<Self, ApiError> {
        Query::from_request_parts(parts, state)
            .await
            .map(|Query(value)| Self(value))
            .map_err(|_: QueryRejection| {
                ApiError(
                    StatusCode::BAD_REQUEST,
                    "Die Adresse enthält ungültige Parameter.",
                )
            })
    }
}

impl<T: DeserializeOwned + Send, S: Send + Sync> FromRequestParts<S> for ApiPath<T> {
    type Rejection = ApiError;
    async fn from_request_parts(parts: &mut Parts, state: &S) -> Result<Self, ApiError> {
        Path::from_request_parts(parts, state)
            .await
            .map(|Path(value)| Self(value))
            .map_err(|_: PathRejection| {
                ApiError(
                    StatusCode::BAD_REQUEST,
                    "Die Adresse enthält einen ungültigen Wert.",
                )
            })
    }
}
