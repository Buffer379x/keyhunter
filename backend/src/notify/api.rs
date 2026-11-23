//! The settings page of the channels: list, save, remove and test.

use super::{
    Kind,
    channel::{BAD_INPUT, Channel, ChannelInput},
    message::Alert,
};
use crate::extract::ApiPath;
use crate::{
    ApiError, ApiResult, Shared, auth,
    eventlog::{self, Area, Level},
};
use axum::{
    Json,
    extract::{State, rejection::JsonRejection},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
};
use serde_json::{Value, json};
use std::collections::BTreeMap;

const UNKNOWN: ApiError = ApiError(StatusCode::NOT_FOUND, "Diesen Kanal gibt es nicht.");

pub(super) fn view(channel: &Channel) -> Value {
    let (setting_keys, secret_keys) = channel.kind.keys();
    let settings: BTreeMap<_, _> = setting_keys
        .iter()
        .map(|k| (*k, channel.settings.get(*k).cloned().unwrap_or_default()))
        .collect();
    let secrets: BTreeMap<_, _> = secret_keys
        .iter()
        .map(|k| (*k, channel.secrets.contains_key(*k)))
        .collect();
    json!({
        "kind": channel.kind.id(),
        "name": channel.kind.name(),
        "enabled": channel.enabled,
        "configured": channel.target.is_ok(),
        "active": channel.enabled && channel.target.is_ok(),
        "from_file": channel.from_file,
        "settings": settings,
        "secrets": secrets,
    })
}

/// GET /alerts/channels: every channel with its switch, visible settings and which secrets are stored.
pub(crate) async fn list_channels(
    State(state): State<Shared>,
    _: auth::Session,
) -> ApiResult<Json<Value>> {
    let channels = state.notifier.channels(&state.pool).await?;
    Ok(Json(
        json!({"channels": channels.iter().map(view).collect::<Vec<_>>()}),
    ))
}

async fn channel_view(state: &Shared, kind: Kind) -> ApiResult<Json<Value>> {
    let channels = state.notifier.channels(&state.pool).await?;
    let channel = channels
        .iter()
        .find(|c| c.kind == kind)
        .ok_or_else(crate::internal)?;
    Ok(Json(view(channel)))
}

/// PUT /alerts/channels/{kind}: `{"enabled", "settings": {…}, "secrets": {…}}`; answers like one entry of the list.
pub(crate) async fn put_channel(
    State(state): State<Shared>,
    session: auth::Session,
    ApiPath(kind): ApiPath<String>,
    headers: HeaderMap,
    input: Result<Json<ChannelInput>, JsonRejection>,
) -> ApiResult<Json<Value>> {
    auth::require_csrf(&state, &headers, &session)?;
    let kind = Kind::from_id(&kind).ok_or(UNKNOWN)?;
    let Json(input) = input.map_err(|_| BAD_INPUT)?;
    let enabled = input.enabled;
    state.notifier.save(&state.pool, kind, input).await?;
    eventlog::record(
        &state.pool,
        Level::Info,
        Area::Alerts,
        format!(
            "Benachrichtigungskanal {} gespeichert ({})",
            kind.name(),
            if enabled { "an" } else { "aus" }
        ),
    )
    .await;
    channel_view(&state, kind).await
}

/// DELETE /alerts/channels/{kind}: switch off and forget settings and secrets.
pub(crate) async fn delete_channel(
    State(state): State<Shared>,
    session: auth::Session,
    ApiPath(kind): ApiPath<String>,
    headers: HeaderMap,
) -> ApiResult<StatusCode> {
    auth::require_csrf(&state, &headers, &session)?;
    let kind = Kind::from_id(&kind).ok_or(UNKNOWN)?;
    state.notifier.remove(&state.pool, kind).await?;
    eventlog::record(
        &state.pool,
        Level::Info,
        Area::Alerts,
        format!("Benachrichtigungskanal {} entfernt", kind.name()),
    )
    .await;
    Ok(StatusCode::NO_CONTENT)
}

/// POST /alerts/channels/{kind}/test: send a test message through the saved channel right away (also while it is
/// switched off). 200 `{"ok": true}`, or 502 with the reason in `error`.
pub(crate) async fn test_channel(
    State(state): State<Shared>,
    session: auth::Session,
    ApiPath(kind): ApiPath<String>,
    headers: HeaderMap,
) -> Response {
    test(&state, &session, &kind, &headers)
        .await
        .unwrap_or_else(IntoResponse::into_response)
}

async fn test(
    state: &Shared,
    session: &auth::Session,
    kind: &str,
    headers: &HeaderMap,
) -> ApiResult<Response> {
    auth::require_csrf(state, headers, session)?;
    let kind = Kind::from_id(kind).ok_or(UNKNOWN)?;
    let channels = state.notifier.channels(&state.pool).await?;
    let target = channels
        .into_iter()
        .find(|c| c.kind == kind)
        .and_then(|c| c.target.ok())
        .ok_or(ApiError(
            StatusCode::CONFLICT,
            "Richte den Kanal zuerst vollständig ein und speichere ihn.",
        ))?;
    let name = kind.name();
    Ok(match state.notifier.send(&target, &Alert::test()).await {
        Ok(()) => {
            eventlog::record(
                &state.pool,
                Level::Info,
                Area::Alerts,
                format!("Testnachricht über {name} gesendet"),
            )
            .await;
            Json(json!({"ok": true})).into_response()
        }
        Err(reason) => {
            eventlog::record(
                &state.pool,
                Level::Warn,
                Area::Alerts,
                format!("Testnachricht über {name} fehlgeschlagen ({reason})"),
            )
            .await;
            let error = format!("Testnachricht über {name} fehlgeschlagen: {reason}");
            (
                StatusCode::BAD_GATEWAY,
                Json(json!({"error": error, "code": "unavailable"})),
            )
                .into_response()
        }
    })
}
