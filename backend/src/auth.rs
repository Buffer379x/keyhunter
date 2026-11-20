use crate::{ApiError, ApiResult, Shared, digest, internal, now, random_token};
use argon2::{Argon2, PasswordHash, PasswordHasher, PasswordVerifier, password_hash::SaltString};
use axum::{
    Json,
    extract::State,
    http::{HeaderMap, HeaderValue, StatusCode, header, uri::Authority},
    response::{IntoResponse, Response},
};
use serde::Deserialize;
use serde_json::{Value, json};
use subtle::ConstantTimeEq;

pub(crate) struct Session {
    pub token_hash: String,
    pub csrf_token: String,
}

pub(crate) fn require_origin(state: &Shared, headers: &HeaderMap) -> ApiResult<bool> {
    checked_transport(&state.config, headers).ok_or(ApiError(
        StatusCode::FORBIDDEN,
        "Anfrage abgewiesen: Die Adresse im Browser passt nicht zur App. Öffne KeyHunter über die IP-Adresse oder setze KEYHUNTER_ORIGIN auf die genutzte Adresse.",
    ))
}

// Returns whether the browser's validated origin uses HTTPS.
fn checked_transport(config: &crate::config::Config, headers: &HeaderMap) -> Option<bool> {
    use crate::config::{is_local_http_origin, parse_origin};

    if headers
        .get_all("sec-fetch-site")
        .iter()
        .any(|site| site != "same-origin")
    {
        return None;
    }
    let mut origins = headers.get_all(header::ORIGIN).iter();
    let raw_origin = origins.next()?.to_str().ok()?;
    if origins.next().is_some() {
        return None;
    }
    let origin = parse_origin(raw_origin)?;
    let secure = origin.scheme() == "https";
    if !secure && !config.allow_insecure_http {
        return None;
    }
    if let Some(pinned) = &config.origin {
        return (pinned == raw_origin).then_some(secure);
    }

    let mut hosts = headers.get_all(header::HOST).iter();
    let host = hosts.next()?.to_str().ok()?.parse::<Authority>().ok()?;
    if hosts.next().is_some() || host.as_str().contains('@') {
        return None;
    }
    // Use the incoming Host, never forwarded headers. Reverse proxies must preserve it.
    let incoming = url::Url::parse(&format!("{}://{}", origin.scheme(), host)).ok()?;
    if incoming.origin() != origin.origin() || (!secure && !is_local_http_origin(&origin)) {
        return None;
    }
    Some(secure)
}

pub(crate) async fn authenticate(state: &Shared, headers: &HeaderMap) -> ApiResult<Session> {
    let token = headers
        .get(header::COOKIE)
        .and_then(|h| h.to_str().ok())
        .and_then(|h| {
            h.split(';')
                .find_map(|item| item.trim().strip_prefix("keyhunter_session="))
        })
        .filter(|t| t.len() == 64 && t.bytes().all(|c| c.is_ascii_hexdigit()))
        .ok_or(ApiError(StatusCode::UNAUTHORIZED, "Bitte anmelden."))?;
    let token_hash = hex::encode(digest(token));
    let csrf: Option<String> = sqlx::query_scalar(
        "SELECT csrf_token FROM session WHERE token_hash = ? AND expires_at > ?",
    )
    .bind(&token_hash)
    .bind(now())
    .fetch_optional(&state.pool)
    .await?;
    Ok(Session {
        token_hash,
        csrf_token: csrf.ok_or(ApiError(
            StatusCode::UNAUTHORIZED,
            "Sitzung abgelaufen. Bitte anmelden.",
        ))?,
    })
}

pub(crate) fn require_csrf(
    state: &Shared,
    headers: &HeaderMap,
    session: &Session,
) -> ApiResult<bool> {
    let secure = require_origin(state, headers)?;
    let supplied = headers
        .get("X-CSRF-Token")
        .and_then(|h| h.to_str().ok())
        .unwrap_or("");
    if !bool::from(digest(supplied).ct_eq(&digest(&session.csrf_token))) {
        return Err(ApiError(
            StatusCode::FORBIDDEN,
            "Sicherheitsprüfung fehlgeschlagen. Seite neu laden.",
        ));
    }
    Ok(secure)
}

async fn reserve_attempt(state: &Shared) -> ApiResult<()> {
    let result = sqlx::query("UPDATE auth_throttle SET attempts = CASE WHEN window_started_at <= ? THEN 1 ELSE attempts + 1 END, window_started_at = CASE WHEN window_started_at <= ? THEN ? ELSE window_started_at END WHERE id = 1 AND (attempts < 5 OR window_started_at <= ?)")
        .bind(now() - 900).bind(now() - 900).bind(now()).bind(now() - 900).execute(&state.pool).await?;
    if result.rows_affected() == 0 {
        return Err(ApiError(
            StatusCode::TOO_MANY_REQUESTS,
            "Zu viele Anmeldeversuche. Bitte nach 15 Minuten erneut versuchen.",
        ));
    }
    Ok(())
}

async fn issue_session(state: &Shared, status: StatusCode, secure: bool) -> ApiResult<Response> {
    let token = random_token().map_err(|_| internal())?;
    let csrf = random_token().map_err(|_| internal())?;
    let mut tx = state.pool.begin().await?;
    sqlx::query("DELETE FROM session WHERE expires_at <= ?")
        .bind(now())
        .execute(&mut *tx)
        .await?;
    sqlx::query("INSERT INTO session (token_hash, owner_id, csrf_token, created_at, expires_at) VALUES (?, 1, ?, ?, ?)")
        .bind(hex::encode(digest(&token))).bind(&csrf).bind(now()).bind(now() + 43200).execute(&mut *tx).await?;
    sqlx::query("UPDATE auth_throttle SET attempts = 0, window_started_at = ? WHERE id = 1")
        .bind(now())
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    let cookie = format!(
        "keyhunter_session={token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=43200{}",
        if secure { "; Secure" } else { "" }
    );
    let mut response = (status, Json(json!({"csrf_token":csrf}))).into_response();
    response.headers_mut().insert(
        header::SET_COOKIE,
        HeaderValue::from_str(&cookie).map_err(|_| internal())?,
    );
    Ok(response)
}

pub(crate) async fn setup_status(State(state): State<Shared>) -> ApiResult<Json<Value>> {
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM owner")
        .fetch_one(&state.pool)
        .await?;
    Ok(Json(json!({"required": count == 0})))
}

#[derive(Deserialize)]
pub(crate) struct SetupInput {
    token: String,
    password: String,
    #[serde(default)]
    target_country: Option<String>,
}
pub(crate) async fn setup(
    State(state): State<Shared>,
    headers: HeaderMap,
    Json(input): Json<SetupInput>,
) -> ApiResult<Response> {
    let secure = require_origin(&state, &headers)?;
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM owner")
        .fetch_one(&state.pool)
        .await?;
    if count != 0 {
        return Err(ApiError(
            StatusCode::CONFLICT,
            "Einrichtung bereits abgeschlossen.",
        ));
    }
    if input
        .target_country
        .as_deref()
        .is_some_and(|c| !crate::settings::valid_country(c))
    {
        return Err(ApiError(
            StatusCode::BAD_REQUEST,
            "Das gewählte Zielland ist ungültig.",
        ));
    }
    reserve_attempt(&state).await?;
    let expected = state.bootstrap_hash.ok_or(ApiError(
        StatusCode::CONFLICT,
        "Einrichtung bereits abgeschlossen.",
    ))?;
    if !bool::from(expected.ct_eq(&digest(input.token.trim()))) {
        return Err(ApiError(
            StatusCode::UNAUTHORIZED,
            "Einrichtungscode ungültig.",
        ));
    }
    if !(12..=128).contains(&input.password.chars().count()) {
        return Err(ApiError(
            StatusCode::BAD_REQUEST,
            "Die Passphrase muss 12 bis 128 Zeichen enthalten.",
        ));
    }
    let permit = state
        .password_slots
        .clone()
        .acquire_owned()
        .await
        .map_err(|_| internal())?;
    let hash = tokio::task::spawn_blocking(move || {
        let _permit = permit;
        let random = random_token().map_err(|_| ())?;
        let salt = SaltString::encode_b64(&random.as_bytes()[..32]).map_err(|_| ())?;
        Argon2::default()
            .hash_password(input.password.as_bytes(), &salt)
            .map(|h| h.to_string())
            .map_err(|_| ())
    })
    .await
    .map_err(|_| internal())?
    .map_err(|_| internal())?;
    let inserted = sqlx::query("INSERT INTO owner (id, password_hash, created_at) VALUES (1, ?, ?) ON CONFLICT(id) DO NOTHING")
        .bind(hash).bind(now()).execute(&state.pool).await?;
    if inserted.rows_affected() == 0 {
        return Err(ApiError(
            StatusCode::CONFLICT,
            "Einrichtung bereits abgeschlossen.",
        ));
    }
    if let Some(country) = &input.target_country {
        sqlx::query("UPDATE app_settings SET target_country = ? WHERE id = 1")
            .bind(country)
            .execute(&state.pool)
            .await?;
    }
    issue_session(&state, StatusCode::CREATED, secure).await
}

#[derive(Deserialize)]
pub(crate) struct LoginInput {
    password: String,
}
pub(crate) async fn login(
    State(state): State<Shared>,
    headers: HeaderMap,
    Json(input): Json<LoginInput>,
) -> ApiResult<Response> {
    let secure = require_origin(&state, &headers)?;
    reserve_attempt(&state).await?;
    if input.password.chars().count() > 128 {
        return Err(ApiError(
            StatusCode::UNAUTHORIZED,
            "Anmeldung fehlgeschlagen.",
        ));
    }
    let hash: Option<String> = sqlx::query_scalar("SELECT password_hash FROM owner WHERE id = 1")
        .fetch_optional(&state.pool)
        .await?;
    let hash = hash.ok_or(ApiError(
        StatusCode::UNAUTHORIZED,
        "Bitte zuerst die Einrichtung abschließen.",
    ))?;
    let permit = state
        .password_slots
        .clone()
        .acquire_owned()
        .await
        .map_err(|_| internal())?;
    let valid = tokio::task::spawn_blocking(move || {
        let _permit = permit;
        PasswordHash::new(&hash).is_ok_and(|parsed| {
            Argon2::default()
                .verify_password(input.password.as_bytes(), &parsed)
                .is_ok()
        })
    })
    .await
    .map_err(|_| internal())?;
    if !valid {
        return Err(ApiError(
            StatusCode::UNAUTHORIZED,
            "Anmeldung fehlgeschlagen.",
        ));
    }
    issue_session(&state, StatusCode::OK, secure).await
}

pub(crate) async fn me(State(state): State<Shared>, headers: HeaderMap) -> ApiResult<Json<Value>> {
    let session = authenticate(&state, &headers).await?;
    Ok(Json(json!({"csrf_token":session.csrf_token})))
}

pub(crate) async fn logout(State(state): State<Shared>, headers: HeaderMap) -> ApiResult<Response> {
    let session = authenticate(&state, &headers).await?;
    let secure = require_csrf(&state, &headers, &session)?;
    sqlx::query("DELETE FROM session WHERE token_hash = ?")
        .bind(session.token_hash)
        .execute(&state.pool)
        .await?;
    let mut response = StatusCode::NO_CONTENT.into_response();
    response.headers_mut().insert(
        header::SET_COOKIE,
        HeaderValue::from_str(&format!(
            "keyhunter_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0{}",
            if secure { "; Secure" } else { "" }
        ))
        .map_err(|_| internal())?,
    );
    Ok(response)
}
