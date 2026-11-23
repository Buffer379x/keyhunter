use crate::extract::ApiJson;
use crate::{
    ApiError, ApiResult, Shared, digest,
    eventlog::{self, Area, Level},
    internal, now, random_token,
    throttle::{self, Limit, Peer},
};
use argon2::{Argon2, PasswordHash, PasswordHasher, PasswordVerifier};
use axum::{
    Json,
    extract::{FromRequestParts, Request, State},
    http::{HeaderMap, HeaderValue, Method, StatusCode, header, request::Parts, uri::Authority},
    middleware::Next,
    response::{IntoResponse, Response},
};
use serde::Deserialize;
use serde_json::{Value, json};
use std::net::IpAddr;
use subtle::ConstantTimeEq;

/// The owner's session of a request on a protected route, found by [`require_session`].
#[derive(Clone)]
pub(crate) struct Session {
    pub token_hash: String,
    pub csrf_token: String,
}

/// Layer of the protected routes: checks the session before any extractor reads the path, the query or the body
/// (CODE-02, SEC-06) and hands it to the handler as [`Session`]. A state-changing method also needs the origin and
/// CSRF token here, so a forged request gets 403 before its body is parsed (CODE-03); handlers still check as well.
pub(crate) async fn require_session(
    State(state): State<Shared>,
    mut req: Request,
    next: Next,
) -> Response {
    match authenticate(&state, req.headers()).await {
        Ok(session) => {
            if !matches!(*req.method(), Method::GET | Method::HEAD)
                && let Err(error) = require_csrf(&state, req.headers(), &session)
            {
                return error.into_response();
            }
            req.extensions_mut().insert(session);
            next.run(req).await
        }
        Err(error) => error.into_response(),
    }
}

impl<S: Send + Sync> FromRequestParts<S> for Session {
    type Rejection = ApiError;
    /// Fails closed: a handler outside the protected routes never gets a session.
    async fn from_request_parts(parts: &mut Parts, _: &S) -> Result<Self, ApiError> {
        parts
            .extensions
            .get::<Session>()
            .cloned()
            .ok_or(ApiError(StatusCode::UNAUTHORIZED, "Bitte anmelden."))
    }
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

/// The well-formed session token of the request's cookie, not yet checked against the database.
pub(crate) fn session_cookie(headers: &HeaderMap) -> Option<&str> {
    headers
        .get(header::COOKIE)
        .and_then(|h| h.to_str().ok())
        .and_then(|h| {
            h.split(';')
                .find_map(|item| item.trim().strip_prefix("keyhunter_session="))
        })
        .filter(|t| t.len() == 64 && t.bytes().all(|c| c.is_ascii_hexdigit()))
}

async fn authenticate(state: &Shared, headers: &HeaderMap) -> ApiResult<Session> {
    let token =
        session_cookie(headers).ok_or(ApiError(StatusCode::UNAUTHORIZED, "Bitte anmelden."))?;
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

/// The address the sign-in throttle counts for this request ([`throttle::client`]).
fn source(state: &Shared, peer: Option<IpAddr>, headers: &HeaderMap) -> Option<IpAddr> {
    throttle::client(&state.config.trusted_proxies, peer, headers)
}

/// Counts a sign-in attempt (login, setup code, current passphrase) of `source` before it is checked.
async fn reserve_attempt(state: &Shared, source: Option<IpAddr>) -> ApiResult<()> {
    let Err(limit) = state.login_throttle.reserve(source, now()) else {
        return Ok(());
    };
    // Once per throttle window, so a flood of attempts cannot flood the log.
    let message = match limit {
        Limit::Source => "Zu viele Anmeldeversuche",
        Limit::Total => {
            "Zu viele Anmeldeversuche von verschiedenen Adressen, Anmeldung vorübergehend gesperrt"
        }
    };
    eventlog::record_once(
        &state.pool,
        Level::Warn,
        Area::Login,
        message,
        throttle::WINDOW,
    )
    .await;
    Err(ApiError(
        StatusCode::TOO_MANY_REQUESTS,
        "Zu viele Anmeldeversuche. Bitte nach 15 Minuten erneut versuchen.",
    ))
}

/// Passphrase rule of the setup and of a change.
fn check_strength(password: &str) -> ApiResult<()> {
    if (12..=128).contains(&password.chars().count()) {
        Ok(())
    } else {
        Err(ApiError(
            StatusCode::BAD_REQUEST,
            "Die Passphrase muss 12 bis 128 Zeichen enthalten.",
        ))
    }
}

/// Argon2id hash of a new passphrase, in one of the limited password slots.
async fn hash_passphrase(state: &Shared, password: String) -> ApiResult<String> {
    let permit = state
        .password_slots
        .clone()
        .acquire_owned()
        .await
        .map_err(|_| internal())?;
    tokio::task::spawn_blocking(move || {
        let _permit = permit;
        let mut salt = [0u8; 16];
        getrandom::fill(&mut salt).map_err(|_| ())?;
        Argon2::default()
            .hash_password_with_salt(password.as_bytes(), &salt)
            .map(|h| h.to_string())
            .map_err(|_| ())
    })
    .await
    .map_err(|_| internal())?
    .map_err(|_| internal())
}

/// Checks `password` against the owner's passphrase, in one of the limited password slots. At most four
/// verifications run at once; the throttle keeps the queue short (≤ 100 attempts per window).
async fn verify_passphrase(state: &Shared, password: String) -> ApiResult<bool> {
    if password.chars().count() > 128 {
        return Ok(false);
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
    tokio::task::spawn_blocking(move || {
        let _permit = permit;
        PasswordHash::new(&hash).is_ok_and(|parsed| {
            Argon2::default()
                .verify_password(password.as_bytes(), &parsed)
                .is_ok()
        })
    })
    .await
    .map_err(|_| internal())
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
    Peer(peer): Peer,
    headers: HeaderMap,
    ApiJson(input): ApiJson<SetupInput>,
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
    let source = source(&state, peer, &headers);
    reserve_attempt(&state, source).await?;
    let expected = crate::setup_code(&state.bootstrap_file).map_err(|error| {
        tracing::error!(%error, "Setup token file unusable");
        ApiError(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Der Einrichtungscode kann nicht gelesen werden. Container-Protokoll prüfen.",
        )
    })?;
    if !bool::from(expected.ct_eq(&digest(input.token.trim()))) {
        eventlog::record(
            &state.pool,
            Level::Warn,
            Area::Login,
            "Einrichtung fehlgeschlagen: Einrichtungscode ungültig",
        )
        .await;
        return Err(ApiError(
            StatusCode::UNAUTHORIZED,
            "Einrichtungscode ungültig.",
        ));
    }
    state.login_throttle.succeeded(source, now());
    check_strength(&input.password)?;
    let hash = hash_passphrase(&state, input.password).await?;
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
    let response = issue_session(&state, StatusCode::CREATED, secure).await?;
    eventlog::record(
        &state.pool,
        Level::Info,
        Area::Login,
        "Einrichtung abgeschlossen",
    )
    .await;
    Ok(response)
}

#[derive(Deserialize)]
pub(crate) struct LoginInput {
    password: String,
}
pub(crate) async fn login(
    State(state): State<Shared>,
    Peer(peer): Peer,
    headers: HeaderMap,
    ApiJson(input): ApiJson<LoginInput>,
) -> ApiResult<Response> {
    let secure = require_origin(&state, &headers)?;
    let source = source(&state, peer, &headers);
    reserve_attempt(&state, source).await?;
    if !verify_passphrase(&state, input.password).await? {
        return Err(login_failed(&state).await);
    }
    state.login_throttle.succeeded(source, now());
    let response = issue_session(&state, StatusCode::OK, secure).await?;
    eventlog::record(&state.pool, Level::Info, Area::Login, "Angemeldet").await;
    Ok(response)
}

/// A wrong passphrase: logged (never the passphrase itself) and answered without detail.
async fn login_failed(state: &Shared) -> ApiError {
    eventlog::record(
        &state.pool,
        Level::Warn,
        Area::Login,
        "Anmeldung fehlgeschlagen",
    )
    .await;
    ApiError(StatusCode::UNAUTHORIZED, "Anmeldung fehlgeschlagen.")
}

pub(crate) async fn me(session: Session) -> Json<Value> {
    Json(json!({"csrf_token":session.csrf_token}))
}

/// The response that ends the session in this browser.
fn signed_out(secure: bool) -> ApiResult<Response> {
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

/// "1 Sitzung", "2 Sitzungen".
pub(crate) fn sessions(count: usize) -> String {
    format!(
        "{count} {}",
        if count == 1 { "Sitzung" } else { "Sitzungen" }
    )
}

pub(crate) async fn logout(
    State(state): State<Shared>,
    session: Session,
    headers: HeaderMap,
) -> ApiResult<Response> {
    let secure = require_csrf(&state, &headers, &session)?;
    sqlx::query("DELETE FROM session WHERE token_hash = ?")
        .bind(session.token_hash)
        .execute(&state.pool)
        .await?;
    eventlog::record(&state.pool, Level::Info, Area::Login, "Abgemeldet").await;
    signed_out(secure)
}

/// DELETE /api/v1/sessions: ends every session, this one included (SEC-03).
pub(crate) async fn logout_everywhere(
    State(state): State<Shared>,
    session: Session,
    headers: HeaderMap,
) -> ApiResult<Response> {
    let secure = require_csrf(&state, &headers, &session)?;
    let active: Vec<bool> = sqlx::query_scalar("DELETE FROM session RETURNING expires_at > ?")
        .bind(now())
        .fetch_all(&state.pool)
        .await?;
    let ended = active.into_iter().filter(|active| *active).count();
    eventlog::record(
        &state.pool,
        Level::Info,
        Area::Login,
        format!("Überall abgemeldet, {} beendet", sessions(ended)),
    )
    .await;
    signed_out(secure)
}

#[derive(Deserialize)]
pub(crate) struct PassphraseInput {
    current: String,
    new: String,
}
/// PUT /api/v1/session/passphrase `{"current","new"}`: changes the passphrase (rules of the setup). This
/// session stays, every other one ends (SEC-03). A wrong current passphrase counts like a failed sign-in.
pub(crate) async fn change_passphrase(
    State(state): State<Shared>,
    Peer(peer): Peer,
    session: Session,
    headers: HeaderMap,
    ApiJson(input): ApiJson<PassphraseInput>,
) -> ApiResult<Json<Value>> {
    require_csrf(&state, &headers, &session)?;
    check_strength(&input.new)?;
    let source = source(&state, peer, &headers);
    reserve_attempt(&state, source).await?;
    if !verify_passphrase(&state, input.current.clone()).await? {
        eventlog::record(
            &state.pool,
            Level::Warn,
            Area::Login,
            "Passphrase nicht geändert: aktuelle Passphrase falsch",
        )
        .await;
        return Err(ApiError(
            StatusCode::FORBIDDEN,
            "Die aktuelle Passphrase stimmt nicht.",
        ));
    }
    state.login_throttle.succeeded(source, now());
    if input.new == input.current {
        return Err(ApiError(
            StatusCode::BAD_REQUEST,
            "Die neue Passphrase muss sich von der aktuellen unterscheiden.",
        ));
    }
    let hash = hash_passphrase(&state, input.new).await?;
    let mut tx = state.pool.begin().await?;
    sqlx::query("UPDATE owner SET password_hash = ? WHERE id = 1")
        .bind(hash)
        .execute(&mut *tx)
        .await?;
    let others: Vec<bool> =
        sqlx::query_scalar("DELETE FROM session WHERE token_hash != ? RETURNING expires_at > ?")
            .bind(&session.token_hash)
            .bind(now())
            .fetch_all(&mut *tx)
            .await?;
    tx.commit().await?;
    let ended = others.into_iter().filter(|active| *active).count();
    eventlog::record(
        &state.pool,
        Level::Info,
        Area::Login,
        format!(
            "Passphrase geändert, {} auf anderen Geräten beendet",
            sessions(ended)
        ),
    )
    .await;
    Ok(Json(json!({ "ended_sessions": ended })))
}
