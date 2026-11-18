use crate::now;
use async_trait::async_trait;
use reqwest::{
    Client, Response, StatusCode,
    header::{AUTHORIZATION, HeaderMap, HeaderValue},
};
use serde::{Deserialize, Serialize};
use std::{
    fs,
    os::unix::fs::PermissionsExt,
    path::Path,
    time::{Duration, Instant, SystemTime},
};
use tokio::sync::Mutex;

const FIELDS: &str = "id,name,slug,summary,first_release_date,platforms.name,cover.image_id,alternative_names.name,version_parent,version_title,game_type.type";
const MAX_RESPONSE: usize = 2 * 1024 * 1024;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct Platform {
    pub id: i64,
    pub name: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct CatalogGame {
    pub igdb_id: i64,
    pub name: String,
    pub slug: Option<String>,
    pub summary: Option<String>,
    pub first_release_date: Option<i64>,
    pub platforms: Vec<Platform>,
    pub aliases: Vec<String>,
    pub cover_url: Option<String>,
    pub version_parent: Option<i64>,
    pub edition_name: Option<String>,
    pub kind: String,
    pub fetched_at: i64,
}

impl CatalogGame {
    pub fn selection_allowed(&self) -> bool {
        matches!(
            self.kind.as_str(),
            "base_game" | "edition" | "remake" | "remaster" | "port" | "standalone_expansion"
        )
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum CatalogError {
    NotConfigured,
    InvalidCredentials,
    Unavailable,
    InvalidResponse,
    RateLimited,
}

#[derive(Clone, Serialize)]
pub struct ProviderStatus {
    pub configured: bool,
    pub state: String,
    pub last_success_at: Option<i64>,
    pub retry_at: Option<i64>,
}

#[async_trait]
pub trait CatalogProvider: Send + Sync {
    async fn search(&self, query: &str, platform: i64) -> Result<Vec<CatalogGame>, CatalogError>;
    async fn game(&self, id: i64) -> Result<Option<CatalogGame>, CatalogError>;
    async fn status(&self) -> ProviderStatus;
}

struct Credentials {
    id: String,
    secret: String,
}
struct Token {
    value: String,
    expires: Instant,
}
struct Wire {
    token: Option<Token>,
    next_request: Instant,
    pause_until: i64,
    last_success: Option<i64>,
    last_error: Option<CatalogError>,
}

pub struct IgdbProvider {
    client: Client,
    credentials: Option<Credentials>,
    oauth_url: String,
    games_url: String,
    spacing: Duration,
    wire: Mutex<Wire>,
}

impl IgdbProvider {
    pub fn new(path: Option<&Path>) -> Result<Self, reqwest::Error> {
        Ok(Self {
            client: Client::builder()
                .https_only(true)
                .redirect(reqwest::redirect::Policy::none())
                .connect_timeout(Duration::from_secs(5))
                .timeout(Duration::from_secs(10))
                .user_agent("KeyHunter/0.1 (private catalog client)")
                .build()?,
            credentials: path.and_then(read_credentials),
            oauth_url: "https://id.twitch.tv/oauth2/token".into(),
            games_url: "https://api.igdb.com/v4/games".into(),
            spacing: Duration::from_millis(350),
            wire: Mutex::new(Wire {
                token: None,
                next_request: Instant::now(),
                pause_until: 0,
                last_success: None,
                last_error: None,
            }),
        })
    }

    async fn send(
        &self,
        wire: &mut Wire,
        builder: reqwest::RequestBuilder,
    ) -> Result<Response, CatalogError> {
        if wire.pause_until > now() {
            return Err(CatalogError::RateLimited);
        }
        if let Some(delay) = wire.next_request.checked_duration_since(Instant::now()) {
            tokio::time::sleep(delay).await;
        }
        wire.next_request = Instant::now() + self.spacing;
        let response = builder
            .send()
            .await
            .map_err(|_| CatalogError::Unavailable)?;
        if response.status() == StatusCode::TOO_MANY_REQUESTS {
            let delay = response
                .headers()
                .get("retry-after")
                .and_then(|v| v.to_str().ok())
                .and_then(|v| {
                    v.parse::<i64>().ok().or_else(|| {
                        httpdate::parse_http_date(v).ok().map(|date| {
                            i64::try_from(
                                date.duration_since(SystemTime::now())
                                    .unwrap_or_default()
                                    .as_secs(),
                            )
                            .unwrap_or(i64::MAX)
                        })
                    })
                })
                .unwrap_or(60)
                .max(1);
            wire.pause_until = now().saturating_add(delay);
            return Err(CatalogError::RateLimited);
        }
        Ok(response)
    }

    async fn token(&self, wire: &mut Wire, credentials: &Credentials) -> Result<(), CatalogError> {
        if wire
            .token
            .as_ref()
            .is_some_and(|t| t.expires > Instant::now())
        {
            return Ok(());
        }
        let response = self
            .send(
                wire,
                self.client.post(&self.oauth_url).form(&[
                    ("client_id", credentials.id.as_str()),
                    ("client_secret", credentials.secret.as_str()),
                    ("grant_type", "client_credentials"),
                ]),
            )
            .await?;
        if !response.status().is_success() {
            return Err(if response.status().is_client_error() {
                CatalogError::InvalidCredentials
            } else {
                CatalogError::Unavailable
            });
        }
        #[derive(Deserialize)]
        struct OAuth {
            access_token: String,
            expires_in: u64,
            token_type: String,
        }
        let token: OAuth = decode(response).await?;
        if token.access_token.is_empty()
            || token.access_token.len() > 4096
            || !token.token_type.eq_ignore_ascii_case("bearer")
            || token.expires_in == 0
        {
            return Err(CatalogError::InvalidResponse);
        }
        let validity = token.expires_in.saturating_sub(30).clamp(1, 30 * 86400);
        wire.token = Some(Token {
            value: token.access_token,
            expires: Instant::now() + Duration::from_secs(validity),
        });
        Ok(())
    }

    async fn query(&self, query: String) -> Result<Vec<CatalogGame>, CatalogError> {
        let credentials = self
            .credentials
            .as_ref()
            .ok_or(CatalogError::NotConfigured)?;
        let mut wire = self.wire.lock().await;
        let result = async {
            for attempt in 0..2 {
                self.token(&mut wire, credentials).await?;
                let mut headers = HeaderMap::new();
                let mut client_id = HeaderValue::from_str(&credentials.id)
                    .map_err(|_| CatalogError::InvalidCredentials)?;
                client_id.set_sensitive(true);
                headers.insert("Client-ID", client_id);
                let value = &wire
                    .token
                    .as_ref()
                    .ok_or(CatalogError::InvalidCredentials)?
                    .value;
                let mut auth = HeaderValue::from_str(&format!("Bearer {value}"))
                    .map_err(|_| CatalogError::InvalidCredentials)?;
                auth.set_sensitive(true);
                headers.insert(AUTHORIZATION, auth);
                let response = self
                    .send(
                        &mut wire,
                        self.client
                            .post(&self.games_url)
                            .headers(headers)
                            .header("Content-Type", "text/plain")
                            .body(query.clone()),
                    )
                    .await?;
                if response.status() == StatusCode::UNAUTHORIZED {
                    wire.token = None;
                    if attempt == 0 {
                        continue;
                    }
                    return Err(CatalogError::InvalidCredentials);
                }
                if !response.status().is_success() {
                    return Err(CatalogError::Unavailable);
                }
                let raw: Vec<RawGame> = decode(response).await?;
                if raw.len() > 50 {
                    return Err(CatalogError::InvalidResponse);
                }
                return raw.into_iter().map(normalize).collect();
            }
            Err(CatalogError::InvalidCredentials)
        }
        .await;
        match &result {
            Ok(_) => {
                wire.last_success = Some(now());
                wire.last_error = None;
            }
            Err(e) => wire.last_error = Some(*e),
        }
        result
    }
}

#[async_trait]
impl CatalogProvider for IgdbProvider {
    async fn search(&self, query: &str, platform: i64) -> Result<Vec<CatalogGame>, CatalogError> {
        let literal = serde_json::to_string(query).map_err(|_| CatalogError::InvalidResponse)?;
        self.query(format!(
            "search {literal}; fields {FIELDS}; where platforms = ({platform}); limit 20;"
        ))
        .await
    }
    async fn game(&self, id: i64) -> Result<Option<CatalogGame>, CatalogError> {
        let games = self
            .query(format!("fields {FIELDS}; where id = {id}; limit 1;"))
            .await?;
        Ok(games.into_iter().find(|game| game.igdb_id == id))
    }
    async fn status(&self) -> ProviderStatus {
        let wire = self.wire.lock().await;
        let state = if self.credentials.is_none() {
            "not_configured"
        } else if wire.pause_until > now() {
            "rate_limited"
        } else if wire.last_error.is_some() {
            "unavailable"
        } else if wire.last_success.is_some() {
            "ready"
        } else {
            "configured"
        };
        ProviderStatus {
            configured: self.credentials.is_some(),
            state: state.into(),
            last_success_at: wire.last_success,
            retry_at: (wire.pause_until > now()).then_some(wire.pause_until),
        }
    }
}

fn read_credentials(path: &Path) -> Option<Credentials> {
    let metadata = fs::metadata(path).ok()?;
    if !metadata.is_file() || metadata.len() > 16384 || metadata.permissions().mode() & 0o077 != 0 {
        return None;
    }
    let contents = fs::read_to_string(path).ok()?;
    let (mut id, mut secret) = (None, None);
    for line in contents
        .lines()
        .map(str::trim)
        .filter(|s| !s.starts_with('#'))
    {
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        let mut value = value.trim();
        if value.len() >= 2
            && ((value.starts_with('"') && value.ends_with('"'))
                || (value.starts_with('\'') && value.ends_with('\'')))
        {
            value = &value[1..value.len() - 1];
        }
        if value.is_empty() || value.len() > 512 || value.chars().any(char::is_control) {
            continue;
        }
        match key.trim() {
            "IGDB_CLIENT_ID" => id = Some(value.to_string()),
            "IGDB_CLIENT_SECRET" => secret = Some(value.to_string()),
            _ => {}
        }
    }
    Some(Credentials {
        id: id?,
        secret: secret?,
    })
}

async fn decode<T: serde::de::DeserializeOwned>(mut response: Response) -> Result<T, CatalogError> {
    if response
        .content_length()
        .is_some_and(|size| size > MAX_RESPONSE as u64)
    {
        return Err(CatalogError::InvalidResponse);
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| CatalogError::Unavailable)?
    {
        if bytes.len() + chunk.len() > MAX_RESPONSE {
            return Err(CatalogError::InvalidResponse);
        }
        bytes.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&bytes).map_err(|_| CatalogError::InvalidResponse)
}

#[derive(Deserialize)]
struct RawGame {
    id: i64,
    name: String,
    slug: Option<String>,
    summary: Option<String>,
    first_release_date: Option<i64>,
    #[serde(default)]
    platforms: Vec<Platform>,
    #[serde(default)]
    alternative_names: Vec<Alias>,
    cover: Option<Cover>,
    version_parent: Option<i64>,
    version_title: Option<String>,
    game_type: Option<GameType>,
}
#[derive(Deserialize)]
struct Alias {
    name: String,
}
#[derive(Deserialize)]
struct Cover {
    image_id: Option<String>,
}
#[derive(Deserialize)]
struct GameType {
    #[serde(rename = "type")]
    kind: String,
}

fn normalize(raw: RawGame) -> Result<CatalogGame, CatalogError> {
    if raw.id <= 0 || raw.name.trim().is_empty() || raw.name.chars().count() > 300 {
        return Err(CatalogError::InvalidResponse);
    }
    let kind = match raw.game_type.as_ref().map(|g| g.kind.as_str()) {
        Some("Main Game" | "Bundle") if raw.version_parent.is_some_and(|id| id > 0) => "edition",
        Some("Main Game") => "base_game",
        Some("Bundle") => "bundle",
        Some("DLC" | "Expansion" | "Pack / Addon" | "Update") => "dlc",
        Some("Remake") => "remake",
        Some("Remaster") => "remaster",
        Some("Port") => "port",
        Some("Standalone Expansion") => "standalone_expansion",
        Some("Mod") => "mod",
        _ => "unknown",
    };
    let cover_url = raw
        .cover
        .and_then(|c| c.image_id)
        .filter(|id| {
            !id.is_empty()
                && id.len() <= 80
                && id.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'_')
        })
        .map(|id| format!("https://images.igdb.com/igdb/image/upload/t_cover_big/{id}.jpg"));
    let slug = raw.slug.filter(|s| {
        !s.is_empty() && s.len() <= 250 && s.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-')
    });
    let aliases = raw
        .alternative_names
        .into_iter()
        .map(|a| a.name)
        .filter(|s| !s.is_empty() && s.chars().count() <= 200)
        .take(10)
        .collect();
    Ok(CatalogGame {
        igdb_id: raw.id,
        name: raw.name.trim().into(),
        slug,
        summary: raw.summary.map(|s| s.chars().take(1600).collect()),
        first_release_date: raw.first_release_date.filter(|v| *v > 0),
        platforms: raw
            .platforms
            .into_iter()
            .filter(|p| p.id > 0 && !p.name.is_empty())
            .take(30)
            .collect(),
        aliases,
        cover_url,
        version_parent: raw.version_parent.filter(|id| *id > 0),
        edition_name: raw
            .version_title
            .filter(|s| !s.is_empty())
            .map(|s| s.chars().take(200).collect()),
        kind: kind.into(),
        fetched_at: now(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{
        Json, Router,
        extract::{Form, State},
        http::{HeaderMap, StatusCode},
        response::{IntoResponse, Response},
        routing::post,
    };
    use serde_json::json;
    use std::{
        collections::HashMap,
        sync::{
            Arc, Mutex as StdMutex,
            atomic::{AtomicUsize, Ordering},
        },
    };

    struct Server {
        mode: &'static str,
        tokens: AtomicUsize,
        games: AtomicUsize,
        body: StdMutex<String>,
    }
    async fn oauth(
        State(state): State<Arc<Server>>,
        Form(form): Form<HashMap<String, String>>,
    ) -> Response {
        if form.get("client_secret").map(String::as_str) != Some("synthetic-secret")
            || form.get("grant_type").map(String::as_str) != Some("client_credentials")
        {
            return StatusCode::UNAUTHORIZED.into_response();
        }
        let count = state.tokens.fetch_add(1, Ordering::SeqCst) + 1;
        Json(json!({"access_token":format!("fixture-{count}"),"expires_in":3600,"token_type":"bearer"})).into_response()
    }
    async fn games(State(state): State<Arc<Server>>, headers: HeaderMap, body: String) -> Response {
        state.games.fetch_add(1, Ordering::SeqCst);
        *state.body.lock().unwrap() = body;
        if state.mode == "limit" {
            return (StatusCode::TOO_MANY_REQUESTS, [("Retry-After", "60")], "{}").into_response();
        }
        if state.mode == "invalid" {
            return "not json".into_response();
        }
        if state.mode == "always401"
            || (state.mode == "retry"
                && headers.get("Authorization").and_then(|v| v.to_str().ok())
                    == Some("Bearer fixture-1"))
        {
            return StatusCode::UNAUTHORIZED.into_response();
        }
        if headers.get("Client-ID").and_then(|v| v.to_str().ok()) != Some("fixture-client") {
            return StatusCode::UNAUTHORIZED.into_response();
        }
        Json(json!([{"id":171270,"name":"Example Premium","slug":"example-premium","game_type":{"id":3,"type":"Bundle"},"version_parent":141503,"version_title":"Premium Edition","platforms":[{"id":169,"name":"Xbox Series X|S"}],"cover":{"image_id":"co45k9"}}])).into_response()
    }
    async fn fixture(
        mode: &'static str,
    ) -> (IgdbProvider, Arc<Server>, tokio::task::JoinHandle<()>) {
        let server = Arc::new(Server {
            mode,
            tokens: AtomicUsize::new(0),
            games: AtomicUsize::new(0),
            body: StdMutex::new(String::new()),
        });
        let router = Router::new()
            .route("/token", post(oauth))
            .route("/games", post(games))
            .with_state(server.clone());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let task = tokio::spawn(async move {
            axum::serve(listener, router).await.unwrap();
        });
        let provider = IgdbProvider {
            client: Client::builder()
                .timeout(Duration::from_secs(3))
                .build()
                .unwrap(),
            credentials: Some(Credentials {
                id: "fixture-client".into(),
                secret: "synthetic-secret".into(),
            }),
            oauth_url: format!("http://{address}/token"),
            games_url: format!("http://{address}/games"),
            spacing: Duration::from_millis(2),
            wire: Mutex::new(Wire {
                token: None,
                next_request: Instant::now(),
                pause_until: 0,
                last_success: None,
                last_error: None,
            }),
        };
        (provider, server, task)
    }

    #[tokio::test]
    async fn refreshes_rejected_token_once_and_keeps_query_text_inside_literal() {
        let (provider, server, task) = fixture("retry").await;
        let result = provider.search("Example\"; fields *;", 169).await.unwrap();
        assert_eq!(result[0].kind, "edition");
        assert_eq!(result[0].version_parent, Some(141503));
        assert_eq!(result[0].edition_name.as_deref(), Some("Premium Edition"));
        assert_eq!(server.tokens.load(Ordering::SeqCst), 2);
        assert!(
            server
                .body
                .lock()
                .unwrap()
                .starts_with("search \"Example\\\"; fields *;\"; fields ")
        );
        provider.search("second", 169).await.unwrap();
        assert_eq!(server.tokens.load(Ordering::SeqCst), 2);
        provider.wire.lock().await.token.as_mut().unwrap().expires =
            Instant::now() - Duration::from_secs(1);
        provider.search("expired", 169).await.unwrap();
        assert_eq!(server.tokens.load(Ordering::SeqCst), 3);
        task.abort();
    }
    #[tokio::test]
    async fn rate_limit_pauses_source_and_invalid_response_is_not_empty_success() {
        let (provider, server, task) = fixture("limit").await;
        assert!(matches!(
            provider.search("first", 169).await,
            Err(CatalogError::RateLimited)
        ));
        assert!(matches!(
            provider.search("second", 169).await,
            Err(CatalogError::RateLimited)
        ));
        assert_eq!(server.games.load(Ordering::SeqCst), 1);
        let status = provider.status().await;
        assert_eq!(status.state, "rate_limited");
        assert!(status.retry_at.unwrap() >= now() + 55);
        task.abort();
        let (provider, _, task) = fixture("invalid").await;
        assert!(matches!(
            provider.search("invalid", 169).await,
            Err(CatalogError::InvalidResponse)
        ));
        assert_eq!(provider.status().await.state, "unavailable");
        task.abort();
        assert!(matches!(
            IgdbProvider::new(None).unwrap().search("none", 169).await,
            Err(CatalogError::NotConfigured)
        ));
    }
    #[tokio::test]
    async fn repeated_unauthorized_response_stops_after_one_refresh() {
        let (provider, server, task) = fixture("always401").await;
        assert!(matches!(
            provider.search("bad", 169).await,
            Err(CatalogError::InvalidCredentials)
        ));
        assert_eq!(server.tokens.load(Ordering::SeqCst), 2);
        assert_eq!(server.games.load(Ordering::SeqCst), 2);
        task.abort();
    }
    #[test]
    fn metadata_conflicts_and_invalid_cover_identifiers_stay_conservative() {
        let raw:RawGame=serde_json::from_value(json!({"id":12,"name":"Example DLC","game_type":{"type":"DLC"},"cover":{"image_id":"../../elsewhere"}})).unwrap();
        let game = normalize(raw).unwrap();
        assert!(!game.selection_allowed());
        assert!(game.cover_url.is_none());
        assert!(game.first_release_date.is_none());
        for (source, kind) in [
            ("Remaster", "remaster"),
            ("Remake", "remake"),
            ("Main Game", "base_game"),
        ] {
            let raw: RawGame = serde_json::from_value(
                json!({"id":12,"name":"Example","game_type":{"type":source}}),
            )
            .unwrap();
            let game = normalize(raw).unwrap();
            assert_eq!(game.kind, kind);
            assert!(game.selection_allowed());
        }
    }
}
