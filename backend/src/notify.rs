//! Notification channels (0.9.0): ntfy, Telegram, Discord, e-mail (SMTP), Gotify, Pushover and a generic webhook. Each
//! channel has a switch and its settings in `notification_channel` (migration 0027). Tokens, passwords and secret URLs
//! live in `<data>/notification-secrets.json` (0600), written like the IGDB access; the API only says whether one is set.
//! An existing ntfy file (`KEYHUNTER_NTFY_ENV_FILE`) serves the ntfy channel as long as no topic URL is saved in the UI.

use crate::{
    ApiError, ApiResult, Shared, auth,
    config::is_local_http_origin,
    eventlog::{self, Area, Level},
};
use axum::{
    Json,
    extract::{Path, State, rejection::JsonRejection},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
};
use lettre::{
    AsyncSmtpTransport, AsyncTransport, Message, Tokio1Executor,
    message::{Mailbox, MultiPart},
    transport::smtp::authentication::Credentials,
};
use reqwest::{Client, RequestBuilder, header::HeaderValue, redirect::Policy};
use serde::Deserialize;
use serde_json::{Value, json};
use sqlx::SqlitePool;
use std::{
    collections::BTreeMap,
    os::unix::fs::PermissionsExt,
    path::{Path as FsPath, PathBuf},
    sync::{Mutex, PoisonError},
    time::Duration,
};
use url::Url;

type Values = BTreeMap<String, String>;

const MISSING: &str = "Fülle alle Pflichtfelder des Kanals aus.";
const BAD_URL: &str = "Gib eine http- oder https-Adresse ohne Zugangsdaten in der Adresse ein.";
const PLAIN_HTTP: &str =
    "Über http gehen Zugangsdaten nur an Server im lokalen Netz. Verwende eine https-Adresse.";
const BAD_INPUT: ApiError = ApiError(StatusCode::BAD_REQUEST, "Prüfe die Angaben des Kanals.");
const UNKNOWN: ApiError = ApiError(StatusCode::NOT_FOUND, "Diesen Kanal gibt es nicht.");
const STORAGE: ApiError = ApiError(
    StatusCode::INTERNAL_SERVER_ERROR,
    "Zugangsdaten konnten nicht gespeichert werden. Prüfe den Schreibzugriff auf das Datenverzeichnis.",
);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Kind {
    Ntfy,
    Telegram,
    Discord,
    Email,
    Gotify,
    Pushover,
    Webhook,
}

impl Kind {
    const ALL: [Self; 7] = [
        Self::Ntfy,
        Self::Telegram,
        Self::Discord,
        Self::Email,
        Self::Gotify,
        Self::Pushover,
        Self::Webhook,
    ];

    pub(crate) fn id(self) -> &'static str {
        match self {
            Self::Ntfy => "ntfy",
            Self::Telegram => "telegram",
            Self::Discord => "discord",
            Self::Email => "email",
            Self::Gotify => "gotify",
            Self::Pushover => "pushover",
            Self::Webhook => "webhook",
        }
    }

    pub(crate) fn name(self) -> &'static str {
        match self {
            Self::Ntfy => "ntfy",
            Self::Telegram => "Telegram",
            Self::Discord => "Discord",
            Self::Email => "E-Mail",
            Self::Gotify => "Gotify",
            Self::Pushover => "Pushover",
            Self::Webhook => "Webhook",
        }
    }

    pub(crate) fn from_id(id: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|kind| kind.id() == id)
    }

    /// Keys of the visible settings and of the write-only secrets.
    fn keys(self) -> (&'static [&'static str], &'static [&'static str]) {
        match self {
            Self::Ntfy => (&[], &["url", "token"]),
            Self::Telegram => (&["chat_id"], &["bot_token"]),
            Self::Discord => (&[], &["webhook_url"]),
            Self::Email => (
                &["host", "port", "security", "username", "from", "to"],
                &["password"],
            ),
            Self::Gotify => (&["url"], &["token"]),
            Self::Pushover => (&[], &["user", "token"]),
            Self::Webhook => (&[], &["url", "token"]),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Security {
    /// Port 587: plain connection upgraded with STARTTLS, which is required.
    StartTls,
    /// Port 465: TLS from the first byte.
    Tls,
    /// Unencrypted, only to a mail server in the local network and never with a password.
    None,
}

#[derive(Clone, Debug)]
pub(crate) struct Smtp {
    host: String,
    port: u16,
    security: Security,
    login: Option<(String, String)>,
    from: Mailbox,
    to: Vec<Mailbox>,
}

/// A complete, validated channel.
#[derive(Clone, Debug)]
pub(crate) enum Target {
    Ntfy { url: Url, token: Option<String> },
    Telegram { token: String, chat: String },
    Discord { url: Url },
    Email(Box<Smtp>),
    Gotify { url: Url, token: String },
    Pushover { user: String, token: String },
    Webhook { url: Url, token: Option<String> },
}

impl Target {
    /// Values that must never appear in an error text or the log.
    fn secrets(&self) -> Vec<String> {
        match self {
            Self::Ntfy { url, token } | Self::Webhook { url, token } => [
                Some(url.to_string()),
                Some(url.path().to_owned()),
                token.clone(),
            ]
            .into_iter()
            .flatten()
            .collect(),
            Self::Telegram { token, .. } => vec![token.clone()],
            Self::Discord { url } => vec![url.to_string(), url.path().to_owned()],
            Self::Email(smtp) => smtp.login.iter().map(|(_, p)| p.clone()).collect(),
            Self::Gotify { token, .. } => vec![token.clone()],
            Self::Pushover { user, token } => vec![user.clone(), token.clone()],
        }
    }
}

fn value<'a>(map: &'a Values, key: &str) -> Option<&'a str> {
    map.get(key).map(String::as_str).filter(|v| !v.is_empty())
}

/// An http(s) address without credentials or fragment. Plain http only carries a secret into the local network.
fn address(raw: &str, secret: bool, query: bool) -> Result<Url, &'static str> {
    let url = Url::parse(raw).map_err(|_| BAD_URL)?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
        || (!query && url.query().is_some())
    {
        return Err(BAD_URL);
    }
    if secret && url.scheme() == "http" && !is_local_http_origin(&url) {
        return Err(PLAIN_HTTP);
    }
    Ok(url)
}

/// Printable ASCII without spaces, 1 to `max` characters.
fn printable(value: &str, max: usize) -> bool {
    !value.is_empty() && value.len() <= max && value.bytes().all(|b| b.is_ascii_graphic())
}

fn ascii_word(value: &str, min: usize, max: usize) -> bool {
    (min..=max).contains(&value.len())
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

fn ntfy(url: &str, token: Option<&str>) -> Result<Target, &'static str> {
    let url = address(url, token.is_some(), false)?;
    if url.path().trim_matches('/').is_empty() {
        return Err("Die ntfy-Adresse braucht ein Topic, z. B. https://ntfy.sh/mein-topic.");
    }
    if token.is_some_and(|t| !printable(t, 512)) {
        return Err("Der ntfy-Token enthält ungültige Zeichen.");
    }
    Ok(Target::Ntfy {
        url,
        token: token.map(str::to_owned),
    })
}

fn discord(raw: &str) -> Result<Target, &'static str> {
    const BAD: &str = "Kopiere die Webhook-URL aus Discord (https://discord.com/api/webhooks/…).";
    let url = Url::parse(raw).map_err(|_| BAD)?;
    let segments: Vec<&str> = url.path_segments().map_or(vec![], Iterator::collect);
    let valid = url.scheme() == "https"
        && matches!(
            url.host_str(),
            Some("discord.com" | "discordapp.com" | "ptb.discord.com" | "canary.discord.com")
        )
        && url.port().is_none()
        && url.username().is_empty()
        && url.password().is_none()
        && url.query().is_none()
        && url.fragment().is_none()
        && matches!(segments.as_slice(), ["api", "webhooks", id, token]
            if id.len() <= 24 && !id.is_empty() && id.bytes().all(|b| b.is_ascii_digit()) && ascii_word(token, 20, 128));
    valid.then_some(Target::Discord { url }).ok_or(BAD)
}

fn email(settings: &Values, password: Option<&str>) -> Result<Target, &'static str> {
    let host = value(settings, "host").ok_or(MISSING)?;
    if host.len() > 253
        || !host
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'-')
    {
        return Err("Gib den Mailserver als Namen oder IP-Adresse ein, z. B. smtp.gmx.net.");
    }
    let port = value(settings, "port")
        .ok_or(MISSING)?
        .parse::<u16>()
        .ok()
        .filter(|p| *p > 0)
        .ok_or("Der Port ist eine Zahl von 1 bis 65535, meist 587 oder 465.")?;
    let security = match value(settings, "security").unwrap_or("starttls") {
        "starttls" => Security::StartTls,
        "tls" => Security::Tls,
        "none" => Security::None,
        _ => return Err("Wähle STARTTLS, TLS oder Unverschlüsselt."),
    };
    let login = match (value(settings, "username"), password) {
        (Some(user), Some(password))
            if user.len() <= 256 && password.len() <= 256 && !password.contains('\n') =>
        {
            Some((user.to_owned(), password.to_owned()))
        }
        (None, None) => None,
        _ => return Err("Benutzername und Passwort gehören zusammen."),
    };
    if security == Security::None {
        let local = Url::parse(&format!("http://{host}")).is_ok_and(|u| is_local_http_origin(&u));
        if !local {
            return Err("Unverschlüsselt geht nur an einen Mailserver im lokalen Netz.");
        }
        if login.is_some() {
            return Err(
                "Ohne Verschlüsselung sendet KeyHunter kein Passwort. Wähle STARTTLS oder TLS.",
            );
        }
    }
    const BAD_ADDRESS: &str = "Prüfe Absender und Empfänger, z. B. keyhunter@example.org.";
    let from: Mailbox = value(settings, "from")
        .ok_or(MISSING)?
        .parse()
        .map_err(|_| BAD_ADDRESS)?;
    let to = value(settings, "to")
        .ok_or(MISSING)?
        .split(',')
        .map(|a| a.trim().parse::<Mailbox>().map_err(|_| BAD_ADDRESS))
        .collect::<Result<Vec<_>, _>>()?;
    if to.len() > 5 {
        return Err("Höchstens fünf Empfänger, getrennt durch Komma.");
    }
    Ok(Target::Email(Box::new(Smtp {
        host: host.to_owned(),
        port,
        security,
        login,
        from,
        to,
    })))
}

/// Validate a stored or entered channel configuration.
fn target(kind: Kind, settings: &Values, secrets: &Values) -> Result<Target, &'static str> {
    match kind {
        Kind::Ntfy => ntfy(
            value(secrets, "url").ok_or(MISSING)?,
            value(secrets, "token"),
        ),
        Kind::Telegram => {
            let token = value(secrets, "bot_token").ok_or(MISSING)?;
            let chat = value(settings, "chat_id").ok_or(MISSING)?;
            let valid_token = token.split_once(':').is_some_and(|(id, key)| {
                (5..=16).contains(&id.len())
                    && id.bytes().all(|b| b.is_ascii_digit())
                    && ascii_word(key, 20, 64)
            });
            if !valid_token {
                return Err("Kopiere den Bot-Token von @BotFather, z. B. 123456789:AAE…");
            }
            let digits = chat.strip_prefix('-').unwrap_or(chat);
            let valid_chat = (1..=20).contains(&digits.len())
                && digits.bytes().all(|b| b.is_ascii_digit())
                || chat
                    .strip_prefix('@')
                    .is_some_and(|name| ascii_word(name, 5, 32) && !name.contains('-'));
            if !valid_chat {
                return Err("Die Chat-ID ist eine Zahl (Gruppen mit Minus) oder @kanalname.");
            }
            Ok(Target::Telegram {
                token: token.to_owned(),
                chat: chat.to_owned(),
            })
        }
        Kind::Discord => discord(value(secrets, "webhook_url").ok_or(MISSING)?),
        Kind::Email => email(settings, value(secrets, "password")),
        Kind::Gotify => {
            let mut url = address(value(settings, "url").ok_or(MISSING)?, true, false)?;
            let token = value(secrets, "token").ok_or(MISSING)?;
            if !printable(token, 128) {
                return Err("Der Gotify-Token enthält ungültige Zeichen.");
            }
            if !url.path().ends_with('/') {
                url.set_path(&format!("{}/", url.path()));
            }
            Ok(Target::Gotify {
                url: url.join("message").map_err(|_| BAD_URL)?,
                token: token.to_owned(),
            })
        }
        Kind::Pushover => {
            let user = value(secrets, "user").ok_or(MISSING)?;
            let token = value(secrets, "token").ok_or(MISSING)?;
            let key = |v: &str| v.len() == 30 && v.bytes().all(|b| b.is_ascii_alphanumeric());
            if !key(user) || !key(token) {
                return Err(
                    "User Key und API-Token von Pushover haben je 30 Buchstaben und Ziffern.",
                );
            }
            Ok(Target::Pushover {
                user: user.to_owned(),
                token: token.to_owned(),
            })
        }
        Kind::Webhook => {
            let token = value(secrets, "token");
            if token.is_some_and(|t| !printable(t, 512)) {
                return Err("Der Token enthält ungültige Zeichen.");
            }
            Ok(Target::Webhook {
                url: address(value(secrets, "url").ok_or(MISSING)?, true, true)?,
                token: token.map(str::to_owned),
            })
        }
    }
}

/// The ntfy file of the operator (before 0.9.0 the only channel): NTFY_URL and optional NTFY_TOKEN, owner-only.
/// Its rules stay as they were: a token needs https, the URL has no query.
fn ntfy_file(path: &FsPath) -> Option<Target> {
    let metadata = std::fs::metadata(path).ok()?;
    if !metadata.is_file() || metadata.permissions().mode() & 0o077 != 0 || metadata.len() > 8192 {
        return None;
    }
    let body = std::fs::read_to_string(path).ok()?;
    let fields: BTreeMap<_, _> = body
        .lines()
        .map(str::trim)
        .filter(|line| !line.starts_with('#'))
        .filter_map(|line| line.split_once('='))
        .map(|(k, v)| (k.trim(), v.trim()))
        .collect();
    let token = fields.get("NTFY_TOKEN").copied().filter(|v| !v.is_empty());
    let target = ntfy(fields.get("NTFY_URL")?, token).ok()?;
    match &target {
        Target::Ntfy { url, .. } if token.is_some() && url.scheme() != "https" => None,
        _ => Some(target),
    }
}

fn read_secrets(path: &FsPath) -> BTreeMap<String, Values> {
    let Ok(metadata) = std::fs::symlink_metadata(path) else {
        return BTreeMap::new();
    };
    if !metadata.is_file() || metadata.len() > 65536 || metadata.permissions().mode() & 0o077 != 0 {
        tracing::warn!("Notification secrets ignored: not an owner-only file");
        return BTreeMap::new();
    }
    std::fs::read(path)
        .ok()
        .and_then(|body| serde_json::from_slice(&body).ok())
        .unwrap_or_default()
}

/// One channel as configured now.
struct Channel {
    kind: Kind,
    enabled: bool,
    settings: Values,
    secrets: Values,
    /// ntfy only: served by the ntfy file because no topic URL is saved in the UI.
    from_file: bool,
    target: Result<Target, &'static str>,
}

pub(crate) struct Notifier {
    client: Client,
    path: PathBuf,
    secrets: Mutex<BTreeMap<String, Values>>,
    /// One save at a time, so two writers never replace each other's secrets.
    writing: tokio::sync::Mutex<()>,
    file: Option<Target>,
    telegram_api: String,
    pushover_api: String,
}

impl Notifier {
    pub(crate) fn new(data_dir: &FsPath, ntfy_env: Option<&FsPath>) -> anyhow::Result<Self> {
        let path = data_dir.join("notification-secrets.json");
        let file = ntfy_env.and_then(|env| {
            let target = ntfy_file(env);
            if target.is_none() {
                tracing::info!("ntfy configuration absent or invalid");
            }
            target
        });
        Ok(Self {
            client: Client::builder()
                .no_proxy()
                .redirect(Policy::none())
                .timeout(Duration::from_secs(10))
                .connect_timeout(Duration::from_secs(5))
                .user_agent(concat!("KeyHunter/", env!("CARGO_PKG_VERSION")))
                .build()?,
            secrets: Mutex::new(read_secrets(&path)),
            path,
            writing: tokio::sync::Mutex::new(()),
            file,
            telegram_api: "https://api.telegram.org".into(),
            pushover_api: "https://api.pushover.net".into(),
        })
    }

    fn stored_secrets(&self) -> BTreeMap<String, Values> {
        self.secrets
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone()
    }

    fn resolve(
        &self,
        kind: Kind,
        settings: &Values,
        secrets: &Values,
    ) -> Result<Target, &'static str> {
        match &self.file {
            Some(file) if kind == Kind::Ntfy && value(secrets, "url").is_none() => Ok(file.clone()),
            _ => target(kind, settings, secrets),
        }
    }

    async fn channels(&self, pool: &SqlitePool) -> sqlx::Result<Vec<Channel>> {
        let rows: Vec<(String, bool, String)> =
            sqlx::query_as("SELECT kind,enabled,settings FROM notification_channel")
                .fetch_all(pool)
                .await?;
        let mut secrets = self.stored_secrets();
        Ok(Kind::ALL
            .into_iter()
            .filter_map(|kind| {
                let (_, enabled, settings) = rows.iter().find(|row| row.0 == kind.id())?;
                let settings: Values = serde_json::from_str(settings).unwrap_or_default();
                let secrets = secrets.remove(kind.id()).unwrap_or_default();
                Some(Channel {
                    kind,
                    enabled: *enabled,
                    from_file: kind == Kind::Ntfy
                        && self.file.is_some()
                        && value(&secrets, "url").is_none(),
                    target: self.resolve(kind, &settings, &secrets),
                    settings,
                    secrets,
                })
            })
            .collect())
    }

    /// The channels that are switched on and complete, in display order.
    pub(crate) async fn active(&self, pool: &SqlitePool) -> sqlx::Result<Vec<(Kind, Target)>> {
        Ok(self
            .channels(pool)
            .await?
            .into_iter()
            .filter(|c| c.enabled)
            .filter_map(|c| Some((c.kind, c.target.ok()?)))
            .collect())
    }

    /// Names of the active channels ("Telegram", "E-Mail") for the alert pages.
    pub(crate) async fn active_names(&self, pool: &SqlitePool) -> sqlx::Result<Vec<&'static str>> {
        Ok(self
            .active(pool)
            .await?
            .into_iter()
            .map(|(kind, _)| kind.name())
            .collect())
    }

    /// Save one channel. Empty or absent secrets keep the stored one, `null` removes it. A channel that is switched on
    /// or has any value must be complete and valid.
    async fn save(&self, pool: &SqlitePool, kind: Kind, input: ChannelInput) -> ApiResult<()> {
        let (setting_keys, secret_keys) = kind.keys();
        if input
            .settings
            .keys()
            .any(|k| !setting_keys.contains(&k.as_str()))
            || input
                .secrets
                .keys()
                .any(|k| !secret_keys.contains(&k.as_str()))
        {
            return Err(BAD_INPUT);
        }
        let clean = |raw: &str| {
            let raw = raw.trim();
            if raw.len() > 2048 || raw.chars().any(char::is_control) {
                Err(BAD_INPUT)
            } else {
                Ok((!raw.is_empty()).then(|| raw.to_owned()))
            }
        };
        let mut settings = Values::new();
        for (key, raw) in &input.settings {
            if let Some(v) = clean(raw)? {
                settings.insert(key.clone(), v);
            }
        }
        let _writing = self.writing.lock().await;
        let before = self.stored_secrets();
        let mut all = before.clone();
        let secrets = all.entry(kind.id().to_owned()).or_default();
        for (key, raw) in &input.secrets {
            match raw.as_deref().map(clean).transpose()? {
                Some(Some(v)) => {
                    secrets.insert(key.clone(), v);
                }
                Some(None) => {}
                None => {
                    secrets.remove(key);
                }
            }
        }
        if input.enabled || !settings.is_empty() || !secrets.is_empty() {
            self.resolve(kind, &settings, secrets)
                .map_err(|message| ApiError(StatusCode::BAD_REQUEST, message))?;
        }
        all.retain(|_, values| !values.is_empty());
        self.store(&before, all)?;
        sqlx::query("UPDATE notification_channel SET enabled=?,settings=? WHERE kind=?")
            .bind(input.enabled)
            .bind(serde_json::to_string(&settings).map_err(|_| crate::internal())?)
            .bind(kind.id())
            .execute(pool)
            .await?;
        Ok(())
    }

    /// Switch a channel off and forget its settings and secrets.
    async fn remove(&self, pool: &SqlitePool, kind: Kind) -> ApiResult<()> {
        let _writing = self.writing.lock().await;
        let before = self.stored_secrets();
        let mut all = before.clone();
        all.remove(kind.id());
        self.store(&before, all)?;
        sqlx::query("UPDATE notification_channel SET enabled=0,settings='{}' WHERE kind=?")
            .bind(kind.id())
            .execute(pool)
            .await?;
        Ok(())
    }

    fn store(
        &self,
        before: &BTreeMap<String, Values>,
        after: BTreeMap<String, Values>,
    ) -> ApiResult<()> {
        if *before != after {
            let body = serde_json::to_vec(&after).map_err(|_| STORAGE)?;
            crate::write_private(&self.path, &body).map_err(|_| STORAGE)?;
            *self.secrets.lock().unwrap_or_else(PoisonError::into_inner) = after;
        }
        Ok(())
    }

    /// Deliver one message. The error is a short German reason without secrets ("HTTP 401 · Unauthorized").
    pub(crate) async fn send(&self, target: &Target, alert: &Alert) -> Result<(), String> {
        let title = alert.title();
        let text = alert.text();
        let result = match target {
            Target::Ntfy { url, token } => {
                let title = HeaderValue::from_bytes(title.as_bytes())
                    .unwrap_or(HeaderValue::from_static("KeyHunter"));
                let mut request = self
                    .client
                    .post(url.clone())
                    .header("Content-Type", "text/plain; charset=utf-8")
                    .header("Title", title)
                    .header("Tags", alert.tag())
                    .body(text);
                if let Some(url) = &alert.url {
                    request = request.header("Click", url.as_str());
                }
                if let Some(token) = token {
                    request = request.bearer_auth(token);
                }
                self.http(request).await
            }
            Target::Telegram { token, chat } => {
                let mut html = format!("<b>{}</b>\n{}", escape_html(&title), escape_html(&text));
                if let Some((url, label)) = alert.link() {
                    html.push_str(&format!(
                        "\n<a href=\"{}\">{}</a>",
                        escape_html(url),
                        escape_html(&label)
                    ));
                }
                let url = format!("{}/bot{token}/sendMessage", self.telegram_api);
                self.http(self.client.post(url).json(&json!({
                    "chat_id": chat, "text": html, "parse_mode": "HTML",
                    "link_preview_options": {"is_disabled": true},
                })))
                .await
            }
            Target::Discord { url } => {
                let mut embed = json!({"title": title, "description": escape_markdown(&text), "color": 0xF07C1E});
                if let Some(url) = &alert.url {
                    embed["url"] = json!(url);
                }
                self.http(self.client.post(url.clone()).json(&json!({
                    "username": "KeyHunter", "embeds": [embed], "allowed_mentions": {"parse": []},
                })))
                .await
            }
            Target::Email(smtp) => send_mail(smtp, alert).await,
            Target::Gotify { url, token } => {
                let mut message = escape_markdown(&text);
                let mut extras = json!({"client::display": {"contentType": "text/markdown"}});
                if let Some((url, label)) = alert.link() {
                    message.push_str(&format!("\n\n[{label}]({url})"));
                    extras["client::notification"] = json!({"click": {"url": url}});
                }
                self.http(
                    self.client
                        .post(url.clone())
                        .header("X-Gotify-Key", token.as_str())
                        .json(&json!({"title": title, "message": message, "priority": 5, "extras": extras})),
                )
                .await
            }
            Target::Pushover { user, token } => {
                let mut form = vec![
                    ("token", token.clone()),
                    ("user", user.clone()),
                    ("title", title),
                    ("message", text),
                ];
                if let Some((url, label)) = alert.link() {
                    form.push(("url", url.to_owned()));
                    form.push(("url_title", label));
                }
                let url = format!("{}/1/messages.json", self.pushover_api);
                self.http(self.client.post(url).form(&form)).await
            }
            Target::Webhook { url, token } => {
                let mut request = self.client.post(url.clone()).json(&alert.json());
                if let Some(token) = token {
                    request = request.bearer_auth(token);
                }
                self.http(request).await
            }
        };
        result.map_err(|reason| redact(&reason, &target.secrets()))
    }

    async fn http(&self, request: RequestBuilder) -> Result<(), String> {
        let response = request.send().await.map_err(|error| {
            if error.is_timeout() {
                "Zeitüberschreitung".to_owned()
            } else if error.is_connect() {
                "Server nicht erreichbar".to_owned()
            } else {
                "Netzwerkfehler".to_owned()
            }
        })?;
        let status = response.status();
        if status.is_success() {
            return Ok(());
        }
        let body = response.bytes().await.unwrap_or_default();
        // Telegram: description, Discord: message, Gotify: errorDescription, ntfy: error, Pushover: errors[0].
        let detail = serde_json::from_slice::<Value>(&body).ok().and_then(|v| {
            ["description", "message", "errorDescription", "error"]
                .iter()
                .find_map(|k| v.get(k)?.as_str().map(str::to_owned))
                .or_else(|| v.get("errors")?.get(0)?.as_str().map(str::to_owned))
        });
        Err(
            match detail.or_else(|| status.canonical_reason().map(str::to_owned)) {
                Some(reason) => format!("HTTP {} · {reason}", status.as_u16()),
                None => format!("HTTP {}", status.as_u16()),
            },
        )
    }
}

async fn send_mail(smtp: &Smtp, alert: &Alert) -> Result<(), String> {
    let mut builder = Message::builder()
        .from(smtp.from.clone())
        .subject(alert.title());
    for to in &smtp.to {
        builder = builder.to(to.clone());
    }
    let mut plain = alert.text();
    let mut html = format!("<p>{}</p>", escape_html(&plain));
    if let Some((url, label)) = alert.link() {
        plain.push_str(&format!("\n\n{label}: {url}"));
        html.push_str(&format!(
            "<p><a href=\"{}\">{}</a></p>",
            escape_html(url),
            escape_html(&label)
        ));
    }
    plain.push_str("\n\n-- \nKeyHunter");
    html.push_str("<p style=\"color:#777\">KeyHunter</p>");
    let message = builder
        .multipart(MultiPart::alternative_plain_html(plain, html))
        .map_err(|_| "E-Mail konnte nicht erstellt werden".to_owned())?;
    let failure = |error: lettre::transport::smtp::Error| {
        if error.is_timeout() {
            "Zeitüberschreitung".to_owned()
        } else {
            format!("SMTP: {error}")
        }
    };
    let transport = match smtp.security {
        Security::Tls => {
            AsyncSmtpTransport::<Tokio1Executor>::relay(&smtp.host).map_err(failure)?
        }
        Security::StartTls => {
            AsyncSmtpTransport::<Tokio1Executor>::starttls_relay(&smtp.host).map_err(failure)?
        }
        Security::None => AsyncSmtpTransport::<Tokio1Executor>::builder_dangerous(&smtp.host),
    };
    let mut transport = transport
        .port(smtp.port)
        .timeout(Some(Duration::from_secs(15)));
    if let Some((user, password)) = &smtp.login {
        transport = transport.credentials(Credentials::new(user.clone(), password.clone()));
    }
    transport
        .build()
        .send(message)
        .await
        .map(|_| ())
        .map_err(failure)
}

/// Remove secrets and control characters from an error text and keep it short.
fn redact(reason: &str, secrets: &[String]) -> String {
    let mut text: String = reason
        .chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .collect();
    for secret in secrets.iter().filter(|s| s.len() >= 4) {
        text = text.replace(secret.as_str(), "…");
    }
    text.chars().take(200).collect()
}

fn escape_html(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

fn escape_markdown(text: &str) -> String {
    text.chars()
        .flat_map(|c| {
            ("\\`*_[]()~|<>#".contains(c).then_some('\\'))
                .into_iter()
                .chain([c])
        })
        .collect()
}

/// "1.234,50 €".
pub(crate) fn euro(cents: i64) -> String {
    let sign = if cents < 0 { "-" } else { "" };
    let cents = cents.abs();
    let whole = (cents / 100).to_string();
    let mut grouped = String::new();
    for (i, digit) in whole.chars().enumerate() {
        if i > 0 && (whole.len() - i).is_multiple_of(3) {
            grouped.push('.');
        }
        grouped.push(digit);
    }
    format!("{sign}{grouped},{:02} €", cents % 100)
}

/// German name of a target country; other codes stay as they are.
fn country_name(code: &str) -> &str {
    const NAMES: [(&str, &str); 32] = [
        ("AT", "Österreich"),
        ("AU", "Australien"),
        ("BE", "Belgien"),
        ("BR", "Brasilien"),
        ("CA", "Kanada"),
        ("CH", "der Schweiz"),
        ("CZ", "Tschechien"),
        ("DE", "Deutschland"),
        ("DK", "Dänemark"),
        ("ES", "Spanien"),
        ("FI", "Finnland"),
        ("FR", "Frankreich"),
        ("GB", "Großbritannien"),
        ("GR", "Griechenland"),
        ("HU", "Ungarn"),
        ("IE", "Irland"),
        ("IN", "Indien"),
        ("IT", "Italien"),
        ("JP", "Japan"),
        ("LU", "Luxemburg"),
        ("MX", "Mexiko"),
        ("NL", "den Niederlanden"),
        ("NO", "Norwegen"),
        ("NZ", "Neuseeland"),
        ("PL", "Polen"),
        ("PT", "Portugal"),
        ("RO", "Rumänien"),
        ("SE", "Schweden"),
        ("SK", "der Slowakei"),
        ("TR", "der Türkei"),
        ("US", "den USA"),
        ("ZA", "Südafrika"),
    ];
    NAMES
        .iter()
        .find(|(c, _)| *c == code)
        .map_or(code, |(_, name)| name)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Event {
    Test,
    /// The target price of the rule, if known.
    Target(Option<i64>),
    /// The lowest price before, if known.
    Low(Option<i64>),
}

/// What one message reports; every channel formats it in its own way.
#[derive(Debug)]
pub(crate) struct Alert {
    pub(crate) event: Event,
    pub(crate) game: String,
    pub(crate) cents: i64,
    pub(crate) estimate: bool,
    pub(crate) shop: Option<String>,
    pub(crate) region: Option<String>,
    pub(crate) country: Option<String>,
    pub(crate) url: Option<String>,
}

impl Alert {
    pub(crate) fn test() -> Self {
        Self {
            event: Event::Test,
            game: String::new(),
            cents: 0,
            estimate: false,
            shop: None,
            region: None,
            country: None,
            url: None,
        }
    }

    /// "KeyHunter: Wunschpreis erreicht · 24,90 €".
    fn title(&self) -> String {
        match self.event {
            Event::Test => "KeyHunter: Testnachricht".into(),
            Event::Target(_) => format!("KeyHunter: Wunschpreis erreicht · {}", euro(self.cents)),
            Event::Low(_) => format!("KeyHunter: Neuer Tiefstpreis · {}", euro(self.cents)),
        }
    }

    /// "24,90 € bei Eneba (Global, gültig in Deutschland)".
    fn offer(&self) -> String {
        let mut text = euro(self.cents);
        if self.estimate {
            text.push_str(" (geschätzter Gesamtpreis)");
        }
        if let Some(shop) = &self.shop {
            text.push_str(&format!(" bei {shop}"));
        }
        let place: Vec<String> = [
            self.region.clone(),
            self.country
                .as_deref()
                .map(|c| format!("gültig in {}", country_name(c))),
        ]
        .into_iter()
        .flatten()
        .collect();
        if !place.is_empty() {
            text.push_str(&format!(" ({})", place.join(", ")));
        }
        text
    }

    /// The message in plain text, without the link.
    fn text(&self) -> String {
        let game = &self.game;
        match self.event {
            Event::Test => "Das ist eine Testnachricht von KeyHunter. Dieser Kanal ist richtig eingerichtet: \
                Hier kommen deine Preisalarme an, zum Beispiel „Spiel X ist bei deinem Wunschpreis angekommen“."
                .into(),
            Event::Target(target) => {
                let mut text = format!("„{game}“ ist bei deinem Wunschpreis angekommen: {}.", self.offer());
                if let Some(target) = target {
                    text.push_str(&format!(" Ziel: {}.", euro(target)));
                }
                text
            }
            Event::Low(previous) => {
                let mut text = format!("„{game}“ hat einen neuen Tiefstpreis: {}.", self.offer());
                if let Some(previous) = previous {
                    text.push_str(&format!(" Bisher am günstigsten: {}.", euro(previous)));
                }
                text
            }
        }
    }

    /// ntfy tag (shown as an emoji).
    fn tag(&self) -> &'static str {
        match self.event {
            Event::Test => "white_check_mark",
            Event::Target(_) => "moneybag",
            Event::Low(_) => "chart_with_downwards_trend",
        }
    }

    /// The shop offer and its label ("Zum Angebot bei Eneba").
    fn link(&self) -> Option<(&str, String)> {
        let url = self.url.as_deref()?;
        let label = match &self.shop {
            Some(shop) => format!("Zum Angebot bei {shop}"),
            None => "Zum Angebot".into(),
        };
        Some((url, label))
    }

    /// Body of the generic webhook (docs/notifications.md).
    fn json(&self) -> Value {
        let price = (self.event != Event::Test).then_some(self.cents);
        let (event, target, previous) = match self.event {
            Event::Test => ("test", None, None),
            Event::Target(target) => ("target_reached", target, None),
            Event::Low(previous) => ("new_low", None, previous),
        };
        json!({
            "event": event,
            "title": self.title(),
            "message": self.text(),
            "game": (event != "test").then_some(&self.game),
            "price_cents": price,
            "price": price.map(euro),
            "target_cents": target,
            "previous_low_cents": previous,
            "estimate": self.estimate,
            "shop": self.shop,
            "region": self.region,
            "country": self.country,
            "url": self.url,
        })
    }
}

fn view(channel: &Channel) -> Value {
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

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct ChannelInput {
    enabled: bool,
    #[serde(default)]
    settings: BTreeMap<String, String>,
    #[serde(default)]
    secrets: BTreeMap<String, Option<String>>,
}

/// GET /alerts/channels: every channel with its switch, visible settings and which secrets are stored.
pub(crate) async fn list_channels(
    State(state): State<Shared>,
    headers: HeaderMap,
) -> ApiResult<Json<Value>> {
    auth::authenticate(&state, &headers).await?;
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
    Path(kind): Path<String>,
    headers: HeaderMap,
    input: Result<Json<ChannelInput>, JsonRejection>,
) -> ApiResult<Json<Value>> {
    let session = auth::authenticate(&state, &headers).await?;
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
    Path(kind): Path<String>,
    headers: HeaderMap,
) -> ApiResult<StatusCode> {
    let session = auth::authenticate(&state, &headers).await?;
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
    Path(kind): Path<String>,
    headers: HeaderMap,
) -> Response {
    test(&state, &kind, &headers)
        .await
        .unwrap_or_else(IntoResponse::into_response)
}

async fn test(state: &Shared, kind: &str, headers: &HeaderMap) -> ApiResult<Response> {
    let session = auth::authenticate(state, headers).await?;
    auth::require_csrf(state, headers, &session)?;
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

/// Local stand-ins for the services: no test ever reaches a real one.
#[cfg(test)]
pub(crate) mod testing {
    use super::*;
    use axum::{
        body::Bytes,
        http::{Method, Uri},
    };
    use std::{collections::VecDeque, sync::Arc};

    pub(crate) struct Recorded {
        pub(crate) method: Method,
        pub(crate) path: String,
        pub(crate) headers: HeaderMap,
        pub(crate) body: Bytes,
    }
    impl Recorded {
        pub(crate) fn header(&self, name: &str) -> &str {
            self.headers
                .get(name)
                .map_or("", |v| std::str::from_utf8(v.as_bytes()).unwrap())
        }
        pub(crate) fn json(&self) -> Value {
            serde_json::from_slice(&self.body).unwrap()
        }
        pub(crate) fn text(&self) -> &str {
            std::str::from_utf8(&self.body).unwrap()
        }
    }

    /// HTTP server on 127.0.0.1 that records every request and answers with `statuses` in turn, then 200.
    pub(crate) struct Mock {
        pub(crate) url: String,
        requests: Arc<Mutex<Vec<Recorded>>>,
        server: tokio::task::JoinHandle<()>,
    }
    impl Mock {
        pub(crate) fn count(&self) -> usize {
            self.requests.lock().unwrap().len()
        }
        pub(crate) fn take(&self) -> Vec<Recorded> {
            std::mem::take(&mut *self.requests.lock().unwrap())
        }
    }
    impl Drop for Mock {
        fn drop(&mut self) {
            self.server.abort();
        }
    }
    pub(crate) async fn mock(statuses: &[u16]) -> Mock {
        let requests = Arc::new(Mutex::new(vec![]));
        let answers = Arc::new(Mutex::new(
            statuses.iter().copied().collect::<VecDeque<_>>(),
        ));
        let recorder = Arc::clone(&requests);
        let router = axum::Router::new().fallback(
            move |method: Method, uri: Uri, headers: HeaderMap, body: Bytes| {
                let (recorder, answers) = (Arc::clone(&recorder), Arc::clone(&answers));
                async move {
                    let path = uri
                        .path_and_query()
                        .map_or(String::new(), |p| p.to_string());
                    recorder.lock().unwrap().push(Recorded {
                        method,
                        path,
                        headers,
                        body,
                    });
                    let status = answers.lock().unwrap().pop_front().unwrap_or(200);
                    (
                        StatusCode::from_u16(status).unwrap(),
                        Json(json!({"message": "mock answer"})),
                    )
                }
            },
        );
        let socket = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", socket.local_addr().unwrap());
        let server = tokio::spawn(async move { axum::serve(socket, router).await.unwrap() });
        Mock {
            url,
            requests,
            server,
        }
    }

    /// A notifier whose Telegram and Pushover API point at `api`.
    pub(crate) fn notifier(dir: &FsPath, api: &str) -> Notifier {
        let mut notifier = Notifier::new(dir, None).unwrap();
        notifier.telegram_api = api.into();
        notifier.pushover_api = api.into();
        notifier
    }

    pub(crate) async fn configure(
        notifier: &Notifier,
        pool: &SqlitePool,
        kind: Kind,
        input: Value,
    ) {
        let input = serde_json::from_value(input).unwrap();
        if let Err(error) = notifier.save(pool, kind, input).await {
            panic!("{}", error.1);
        }
    }

    pub(crate) async fn pool() -> SqlitePool {
        let pool = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        sqlx::migrate!("./migrations").run(&pool).await.unwrap();
        pool
    }
}

#[cfg(test)]
mod tests {
    use super::testing::*;
    use super::*;
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

    // Made-up values in the shape the validation expects. They are glued together from pieces (0.9.1) so secret
    // scanners do not take the source for a real Telegram token, Pushover key or Discord webhook.
    const BOT: &str = concat!("123456789", ":", "AAE", "fixtureTokenOnlyForTests_abcdef");
    const PUSH_USER: &str = concat!("ufixture", "userkey", "000000000000001");
    const PUSH_TOKEN: &str = concat!("afixture", "apptoken", "00000000000001");

    fn forza() -> Alert {
        Alert {
            event: Event::Target(Some(2500)),
            game: "Forza Horizon 5".into(),
            cents: 2490,
            estimate: false,
            shop: Some("Eneba".into()),
            region: Some("Global".into()),
            country: Some("DE".into()),
            url: Some("https://www.eneba.com/de/xbox-forza-horizon-5-key-global".into()),
        }
    }

    #[test]
    fn messages_are_german_and_name_price_shop_region_and_target() {
        let alert = forza();
        assert_eq!(alert.title(), "KeyHunter: Wunschpreis erreicht · 24,90 €");
        assert_eq!(
            alert.text(),
            "„Forza Horizon 5“ ist bei deinem Wunschpreis angekommen: 24,90 € bei Eneba (Global, gültig in Deutschland). Ziel: 25,00 €."
        );
        let low = Alert {
            event: Event::Low(Some(2600)),
            estimate: true,
            region: None,
            country: Some("XK".into()),
            ..forza()
        };
        assert_eq!(low.title(), "KeyHunter: Neuer Tiefstpreis · 24,90 €");
        assert_eq!(
            low.text(),
            "„Forza Horizon 5“ hat einen neuen Tiefstpreis: 24,90 € (geschätzter Gesamtpreis) bei Eneba (gültig in XK). Bisher am günstigsten: 26,00 €."
        );
        let test = Alert::test();
        assert_eq!(test.title(), "KeyHunter: Testnachricht");
        assert!(
            test.text()
                .starts_with("Das ist eine Testnachricht von KeyHunter.")
        );
        assert!(test.link().is_none());
        assert_eq!(euro(123_456), "1.234,56 €");
        assert_eq!(euro(5), "0,05 €");
        assert_eq!(euro(100_000_000), "1.000.000,00 €");
        assert_eq!(
            forza().link(),
            Some((
                "https://www.eneba.com/de/xbox-forza-horizon-5-key-global",
                "Zum Angebot bei Eneba".into()
            ))
        );
    }

    fn values(pairs: &[(&str, &str)]) -> Values {
        pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect()
    }

    #[test]
    fn inputs_are_validated_and_secrets_need_https_outside_the_lan() {
        let none = Values::new();
        let ok = |kind, settings: &[(&str, &str)], secrets: &[(&str, &str)]| {
            target(kind, &values(settings), &values(secrets))
        };
        assert!(
            ok(
                Kind::Ntfy,
                &[],
                &[("url", "https://ntfy.sh/kh-topic"), ("token", "tk_abc")]
            )
            .is_ok()
        );
        assert!(
            ok(
                Kind::Ntfy,
                &[],
                &[("url", "http://ntfy.example.org/kh-topic")]
            )
            .is_ok()
        );
        for bad in [
            "https://ntfy.sh/",
            "ftp://ntfy.sh/topic",
            "https://user:pass@ntfy.sh/topic",
            "https://ntfy.sh/topic?auth=x",
        ] {
            assert!(ok(Kind::Ntfy, &[], &[("url", bad)]).is_err(), "{bad}");
        }
        assert_eq!(
            ok(
                Kind::Ntfy,
                &[],
                &[("url", "http://ntfy.example.org/t"), ("token", "tk_abc")]
            )
            .unwrap_err(),
            PLAIN_HTTP
        );
        assert!(
            ok(
                Kind::Ntfy,
                &[],
                &[("url", "http://192.168.1.5/t"), ("token", "tk_abc")]
            )
            .is_ok()
        );
        assert!(
            ok(
                Kind::Telegram,
                &[("chat_id", "-1001234567")],
                &[("bot_token", BOT)]
            )
            .is_ok()
        );
        assert!(
            ok(
                Kind::Telegram,
                &[("chat_id", "@keyhunter_alerts")],
                &[("bot_token", BOT)]
            )
            .is_ok()
        );
        assert!(
            ok(
                Kind::Telegram,
                &[("chat_id", "12 34")],
                &[("bot_token", BOT)]
            )
            .is_err()
        );
        assert!(
            ok(
                Kind::Telegram,
                &[("chat_id", "1234")],
                &[("bot_token", "not-a-token")]
            )
            .is_err()
        );
        assert!(ok(Kind::Telegram, &[], &[("bot_token", BOT)]).is_err());
        let hook = concat!(
            "https://discord.com/api/webhooks/",
            "123456789012345678",
            "/",
            "abcdefghijklmnopqrstuvwxyz_-ABCDEF"
        );
        assert!(ok(Kind::Discord, &[], &[("webhook_url", hook)]).is_ok());
        for bad in [
            "https://evil.example/api/webhooks/1/abcdefghijklmnopqrstuvwxyz",
            "http://discord.com/api/webhooks/1/abcdefghijklmnopqrstuvwxyz",
            "https://discord.com/api/webhooks/1/abcdefghijklmnopqrstuvwxyz?wait=true",
            "https://discord.com/channels/1/2",
        ] {
            assert!(
                ok(Kind::Discord, &[], &[("webhook_url", bad)]).is_err(),
                "{bad}"
            );
        }
        assert!(
            ok(
                Kind::Gotify,
                &[("url", "http://192.168.1.10:8080")],
                &[("token", "AbCdEf.123")]
            )
            .is_ok()
        );
        assert!(
            ok(
                Kind::Gotify,
                &[("url", "http://gotify.example.org")],
                &[("token", "AbCdEf.123")]
            )
            .is_err()
        );
        let Ok(Target::Gotify { url, .. }) = ok(
            Kind::Gotify,
            &[("url", "https://example.org/gotify")],
            &[("token", "AbCdEf")],
        ) else {
            panic!("gotify");
        };
        assert_eq!(url.as_str(), "https://example.org/gotify/message");
        assert!(
            ok(
                Kind::Pushover,
                &[],
                &[("user", PUSH_USER), ("token", PUSH_TOKEN)]
            )
            .is_ok()
        );
        assert!(
            ok(
                Kind::Pushover,
                &[],
                &[("user", "short"), ("token", PUSH_TOKEN)]
            )
            .is_err()
        );
        assert!(
            ok(
                Kind::Webhook,
                &[],
                &[("url", "https://hooks.example.org/kh?id=1")]
            )
            .is_ok()
        );
        assert!(
            ok(
                Kind::Webhook,
                &[],
                &[
                    ("url", "http://hooks.example.org/kh"),
                    ("token", "secret-1")
                ]
            )
            .is_err()
        );
        assert!(ok(Kind::Webhook, &[], &[("url", "javascript:alert(1)")]).is_err());
        let mail = [
            ("host", "smtp.example.org"),
            ("port", "587"),
            ("security", "starttls"),
            ("username", "me@example.org"),
            ("from", "KeyHunter <me@example.org>"),
            ("to", "me@example.org, partner@example.org"),
        ];
        assert!(ok(Kind::Email, &mail, &[("password", "app password")]).is_ok());
        assert_eq!(
            ok(Kind::Email, &mail, &[]).unwrap_err(),
            "Benutzername und Passwort gehören zusammen."
        );
        let mut plain = mail.to_vec();
        plain.retain(|(k, _)| *k != "username");
        plain.push(("security", "none"));
        let plain: Values = values(&plain);
        assert!(
            email(&plain, None).is_err(),
            "unencrypted to a public server"
        );
        let mut local = plain.clone();
        local.insert("host".into(), "mail.lan".into());
        assert!(email(&local, None).is_ok());
        local.insert("username".into(), "me".into());
        assert!(
            email(&local, Some("secret")).is_err(),
            "no password without TLS"
        );
        let mut bad = values(&mail);
        bad.insert("to".into(), "not an address".into());
        assert!(email(&bad, Some("pw")).is_err());
        bad.insert("to".into(), "me@example.org".into());
        bad.insert("port".into(), "0".into());
        assert!(email(&bad, Some("pw")).is_err());
        assert!(target(Kind::Email, &none, &none).is_err());
    }

    #[tokio::test]
    async fn ntfy_posts_the_text_with_title_click_tags_and_token() {
        let server = mock(&[]).await;
        let dir = tempfile::tempdir().unwrap();
        let notifier = notifier(dir.path(), &server.url);
        let target = ntfy(&format!("{}/kh-alerts", server.url), Some("tk_fixture")).unwrap();
        notifier.send(&target, &forza()).await.unwrap();
        let [request] = server.take().try_into().ok().unwrap();
        assert_eq!(request.method, "POST");
        assert_eq!(request.path, "/kh-alerts");
        assert_eq!(request.header("authorization"), "Bearer tk_fixture");
        assert_eq!(
            request.header("title"),
            "KeyHunter: Wunschpreis erreicht · 24,90 €"
        );
        assert_eq!(
            request.header("click"),
            "https://www.eneba.com/de/xbox-forza-horizon-5-key-global"
        );
        assert_eq!(request.header("tags"), "moneybag");
        assert_eq!(request.header("content-type"), "text/plain; charset=utf-8");
        assert_eq!(request.text(), forza().text());
    }

    #[tokio::test]
    async fn telegram_sends_escaped_html_with_a_link() {
        let server = mock(&[]).await;
        let dir = tempfile::tempdir().unwrap();
        let notifier = notifier(dir.path(), &server.url);
        let target = target(
            Kind::Telegram,
            &values(&[("chat_id", "-100200")]),
            &values(&[("bot_token", BOT)]),
        )
        .unwrap();
        let alert = Alert {
            game: "Tom & Jerry <Deluxe>".into(),
            ..forza()
        };
        notifier.send(&target, &alert).await.unwrap();
        let [request] = server.take().try_into().ok().unwrap();
        assert_eq!(request.method, "POST");
        assert_eq!(request.path, format!("/bot{BOT}/sendMessage"));
        let body = request.json();
        assert_eq!(body["chat_id"], "-100200");
        assert_eq!(body["parse_mode"], "HTML");
        assert_eq!(body["link_preview_options"]["is_disabled"], true);
        assert_eq!(
            body["text"],
            "<b>KeyHunter: Wunschpreis erreicht · 24,90 €</b>\n„Tom &amp; Jerry &lt;Deluxe&gt;“ ist bei deinem Wunschpreis angekommen: \
            24,90 € bei Eneba (Global, gültig in Deutschland). Ziel: 25,00 €.\n\
            <a href=\"https://www.eneba.com/de/xbox-forza-horizon-5-key-global\">Zum Angebot bei Eneba</a>"
        );
    }

    #[tokio::test]
    async fn discord_sends_an_embed_with_a_clickable_title_and_no_mentions() {
        let server = mock(&[]).await;
        let dir = tempfile::tempdir().unwrap();
        let notifier = notifier(dir.path(), &server.url);
        let target = Target::Discord {
            url: Url::parse(&format!("{}/api/webhooks/1/fixture-token", server.url)).unwrap(),
        };
        let alert = Alert {
            game: "Halo *Infinite*".into(),
            ..forza()
        };
        notifier.send(&target, &alert).await.unwrap();
        let [request] = server.take().try_into().ok().unwrap();
        assert_eq!(request.method, "POST");
        assert_eq!(request.path, "/api/webhooks/1/fixture-token");
        assert_eq!(request.header("content-type"), "application/json");
        let body = request.json();
        assert_eq!(body["username"], "KeyHunter");
        assert_eq!(body["allowed_mentions"]["parse"], json!([]));
        let embed = &body["embeds"][0];
        assert_eq!(embed["title"], "KeyHunter: Wunschpreis erreicht · 24,90 €");
        assert_eq!(
            embed["url"],
            "https://www.eneba.com/de/xbox-forza-horizon-5-key-global"
        );
        assert!(
            embed["description"]
                .as_str()
                .unwrap()
                .starts_with("„Halo \\*Infinite\\*“ ist bei")
        );
    }

    #[tokio::test]
    async fn gotify_sends_markdown_with_a_click_url() {
        let server = mock(&[]).await;
        let dir = tempfile::tempdir().unwrap();
        let notifier = notifier(dir.path(), &server.url);
        let target = target(
            Kind::Gotify,
            &values(&[("url", &server.url)]),
            &values(&[("token", "AppTokenFixture")]),
        )
        .unwrap();
        notifier.send(&target, &forza()).await.unwrap();
        let [request] = server.take().try_into().ok().unwrap();
        assert_eq!(request.method, "POST");
        assert_eq!(request.path, "/message");
        assert_eq!(request.header("x-gotify-key"), "AppTokenFixture");
        let body = request.json();
        assert_eq!(body["title"], "KeyHunter: Wunschpreis erreicht · 24,90 €");
        assert_eq!(body["priority"], 5);
        assert_eq!(
            body["extras"]["client::display"]["contentType"],
            "text/markdown"
        );
        assert_eq!(
            body["extras"]["client::notification"]["click"]["url"],
            "https://www.eneba.com/de/xbox-forza-horizon-5-key-global"
        );
        assert!(body["message"].as_str().unwrap().ends_with(
            "Ziel: 25,00 €.\n\n[Zum Angebot bei Eneba](https://www.eneba.com/de/xbox-forza-horizon-5-key-global)"
        ));
    }

    #[tokio::test]
    async fn pushover_posts_a_form_with_url_and_url_title() {
        let server = mock(&[]).await;
        let dir = tempfile::tempdir().unwrap();
        let notifier = notifier(dir.path(), &server.url);
        let target = target(
            Kind::Pushover,
            &Values::new(),
            &values(&[("user", PUSH_USER), ("token", PUSH_TOKEN)]),
        )
        .unwrap();
        notifier.send(&target, &forza()).await.unwrap();
        let [request] = server.take().try_into().ok().unwrap();
        assert_eq!(request.method, "POST");
        assert_eq!(request.path, "/1/messages.json");
        assert_eq!(
            request.header("content-type"),
            "application/x-www-form-urlencoded"
        );
        let form: BTreeMap<String, String> = url::form_urlencoded::parse(&request.body)
            .into_owned()
            .collect();
        assert_eq!(form["token"], PUSH_TOKEN);
        assert_eq!(form["user"], PUSH_USER);
        assert_eq!(form["title"], "KeyHunter: Wunschpreis erreicht · 24,90 €");
        assert_eq!(form["message"], forza().text());
        assert_eq!(
            form["url"],
            "https://www.eneba.com/de/xbox-forza-horizon-5-key-global"
        );
        assert_eq!(form["url_title"], "Zum Angebot bei Eneba");
    }

    #[tokio::test]
    async fn webhook_posts_structured_json_with_an_optional_bearer_token() {
        let server = mock(&[]).await;
        let dir = tempfile::tempdir().unwrap();
        let notifier = notifier(dir.path(), &server.url);
        let target = target(
            Kind::Webhook,
            &Values::new(),
            &values(&[
                ("url", &format!("{}/hook?id=7", server.url)),
                ("token", "hook-token"),
            ]),
        )
        .unwrap();
        notifier.send(&target, &forza()).await.unwrap();
        notifier.send(&target, &Alert::test()).await.unwrap();
        let [alert, test] = server.take().try_into().ok().unwrap();
        assert_eq!(alert.method, "POST");
        assert_eq!(alert.path, "/hook?id=7");
        assert_eq!(alert.header("authorization"), "Bearer hook-token");
        assert_eq!(
            alert.json(),
            json!({
                "event": "target_reached", "title": "KeyHunter: Wunschpreis erreicht · 24,90 €", "message": forza().text(),
                "game": "Forza Horizon 5", "price_cents": 2490, "price": "24,90 €", "target_cents": 2500,
                "previous_low_cents": null, "estimate": false, "shop": "Eneba", "region": "Global", "country": "DE",
                "url": "https://www.eneba.com/de/xbox-forza-horizon-5-key-global",
            })
        );
        let test = test.json();
        assert_eq!(test["event"], "test");
        assert_eq!(test["game"], Value::Null);
        assert_eq!(test["price_cents"], Value::Null);
    }

    #[tokio::test]
    async fn failures_report_status_and_reason_but_never_the_secret() {
        let server = mock(&[401]).await;
        let dir = tempfile::tempdir().unwrap();
        let notifier = notifier(dir.path(), &server.url);
        let telegram = target(
            Kind::Telegram,
            &values(&[("chat_id", "1")]),
            &values(&[("bot_token", BOT)]),
        )
        .unwrap();
        assert_eq!(
            notifier.send(&telegram, &Alert::test()).await.unwrap_err(),
            "HTTP 401 · mock answer"
        );
        let closed = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = closed.local_addr().unwrap();
        drop(closed);
        let hook = Target::Webhook {
            url: Url::parse(&format!("http://{address}/hook-secret-path")).unwrap(),
            token: None,
        };
        let error = notifier.send(&hook, &Alert::test()).await.unwrap_err();
        assert_eq!(error, "Server nicht erreichbar");
        assert_eq!(
            redact(
                "failed for http://h/hook-secret-path\nagain",
                &hook.secrets()
            ),
            "failed for http://h… again"
        );
    }

    /// SMTP server that answers every command with success and returns what it received.
    async fn smtp_stub() -> (u16, tokio::task::JoinHandle<String>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let task = tokio::spawn(async move {
            let (socket, _) = listener.accept().await.unwrap();
            let (read, mut write) = socket.into_split();
            let mut lines = BufReader::new(read).lines();
            let mut transcript = String::new();
            write.write_all(b"220 stub ESMTP\r\n").await.unwrap();
            let mut data = false;
            while let Ok(Some(line)) = lines.next_line().await {
                transcript.push_str(&line);
                transcript.push('\n');
                let reply: &[u8] = if data {
                    if line != "." {
                        continue;
                    }
                    data = false;
                    b"250 queued\r\n"
                } else {
                    match line.to_ascii_uppercase().split(' ').next().unwrap() {
                        "EHLO" | "HELO" => b"250 stub\r\n",
                        "DATA" => {
                            data = true;
                            b"354 go ahead\r\n"
                        }
                        "QUIT" => b"221 bye\r\n",
                        _ => b"250 ok\r\n",
                    }
                };
                write.write_all(reply).await.unwrap();
            }
            transcript
        });
        (port, task)
    }

    /// Undo quoted-printable (soft breaks and =XX) for the assertions.
    fn unquote(text: &str) -> String {
        let joined = text.replace("=\n", "");
        let bytes = joined.as_bytes();
        let mut out = vec![];
        let mut i = 0;
        while i < bytes.len() {
            match (bytes[i], bytes.get(i + 1..i + 3)) {
                (b'=', Some(hex)) if hex.iter().all(u8::is_ascii_hexdigit) => {
                    out.push(u8::from_str_radix(std::str::from_utf8(hex).unwrap(), 16).unwrap());
                    i += 3;
                }
                (byte, _) => {
                    out.push(byte);
                    i += 1;
                }
            }
        }
        String::from_utf8(out).unwrap()
    }

    #[tokio::test]
    async fn email_sends_plain_text_and_html_through_smtp() {
        let (port, transcript) = smtp_stub().await;
        let settings = values(&[
            ("host", "127.0.0.1"),
            ("port", &port.to_string()),
            ("security", "none"),
            ("from", "KeyHunter <keyhunter@example.org>"),
            ("to", "owner@example.org"),
        ]);
        let target = target(Kind::Email, &settings, &Values::new()).unwrap();
        let dir = tempfile::tempdir().unwrap();
        notifier(dir.path(), "http://127.0.0.1:9")
            .send(&target, &forza())
            .await
            .unwrap();
        let transcript = unquote(&transcript.await.unwrap());
        assert!(
            transcript.contains("MAIL FROM:<keyhunter@example.org>"),
            "{transcript}"
        );
        assert!(transcript.contains("RCPT TO:<owner@example.org>"));
        assert!(transcript.contains("Subject: "));
        assert!(transcript.contains("multipart/alternative"));
        assert!(transcript.contains("Content-Type: text/plain; charset=utf-8"));
        assert!(transcript.contains("Content-Type: text/html; charset=utf-8"));
        assert!(transcript.contains(&forza().text()));
        assert!(transcript.contains(
            "Zum Angebot bei Eneba: https://www.eneba.com/de/xbox-forza-horizon-5-key-global"
        ));
        assert!(transcript.contains("<a href=\"https://www.eneba.com/de/xbox-forza-horizon-5-key-global\">Zum Angebot bei Eneba</a>"));
        // TLS variants build their transport without connecting.
        for security in ["starttls", "tls"] {
            let mut tls = settings.clone();
            tls.insert("security".into(), security.into());
            tls.insert("host".into(), "smtp.example.org".into());
            assert!(
                matches!(target_of(&tls), Ok(Target::Email(smtp)) if smtp.security != Security::None)
            );
        }
    }

    fn target_of(settings: &Values) -> Result<Target, &'static str> {
        target(Kind::Email, settings, &Values::new())
    }

    #[tokio::test]
    async fn secrets_are_stored_owner_only_kept_when_empty_and_never_shown() {
        let pool = pool().await;
        let dir = tempfile::tempdir().unwrap();
        let notifier = notifier(dir.path(), "http://127.0.0.1:9");
        configure(&notifier, &pool, Kind::Telegram, json!({"enabled": true, "settings": {"chat_id": "4711"}, "secrets": {"bot_token": BOT}})).await;
        let file = dir.path().join("notification-secrets.json");
        assert_eq!(
            std::fs::metadata(&file).unwrap().permissions().mode() & 0o777,
            0o600
        );
        assert!(std::fs::read_to_string(&file).unwrap().contains(BOT));
        let stored: String =
            sqlx::query_scalar("SELECT settings FROM notification_channel WHERE kind='telegram'")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(stored, r#"{"chat_id":"4711"}"#);
        // An empty secret keeps the stored one; the view only says that it is set.
        configure(
            &notifier,
            &pool,
            Kind::Telegram,
            json!({"enabled": true, "settings": {"chat_id": "4712"}, "secrets": {"bot_token": ""}}),
        )
        .await;
        let channels = notifier.channels(&pool).await.unwrap();
        let shown = Value::Array(channels.iter().map(view).collect());
        assert!(!shown.to_string().contains(BOT));
        let telegram = shown
            .as_array()
            .unwrap()
            .iter()
            .find(|c| c["kind"] == "telegram")
            .unwrap();
        assert_eq!(telegram["secrets"], json!({"bot_token": true}));
        assert_eq!(telegram["settings"], json!({"chat_id": "4712"}));
        assert_eq!(telegram["active"], true);
        assert_eq!(notifier.active_names(&pool).await.unwrap(), ["Telegram"]);
        // A restart reads the protected file again; a readable file is ignored.
        let again = Notifier::new(dir.path(), None).unwrap();
        assert!(
            again
                .channels(&pool)
                .await
                .unwrap()
                .iter()
                .any(|c| c.kind == Kind::Telegram && c.target.is_ok())
        );
        std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o644)).unwrap();
        assert!(
            Notifier::new(dir.path(), None)
                .unwrap()
                .stored_secrets()
                .is_empty()
        );
        std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o600)).unwrap();
        // Invalid or incomplete input is refused and changes nothing.
        let refused = notifier
            .save(
                &pool,
                Kind::Telegram,
                serde_json::from_value(json!({"enabled": true, "settings": {"chat_id": "x y"}}))
                    .unwrap(),
            )
            .await;
        assert_eq!(refused.err().map(|e| e.0), Some(StatusCode::BAD_REQUEST));
        let unknown = notifier
            .save(
                &pool,
                Kind::Telegram,
                serde_json::from_value(json!({"enabled": true, "secrets": {"password": "x"}}))
                    .unwrap(),
            )
            .await;
        assert_eq!(unknown.err().map(|e| e.1), Some(BAD_INPUT.1));
        assert!(
            serde_json::from_value::<ChannelInput>(json!({"enabled": true, "extra": 1})).is_err()
        );
        // null removes a secret; removing the channel forgets everything.
        configure(&notifier, &pool, Kind::Webhook, json!({"enabled": false, "secrets": {"url": "https://hooks.example.org/a", "token": "tok-1"}})).await;
        configure(
            &notifier,
            &pool,
            Kind::Webhook,
            json!({"enabled": false, "secrets": {"token": null}}),
        )
        .await;
        assert!(!notifier.stored_secrets()["webhook"].contains_key("token"));
        assert!(notifier.remove(&pool, Kind::Telegram).await.is_ok());
        assert!(!std::fs::read_to_string(&file).unwrap().contains(BOT));
        assert!(notifier.active_names(&pool).await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn the_ntfy_file_keeps_working_until_a_topic_is_saved_in_the_ui() {
        let server = mock(&[]).await;
        let pool = pool().await;
        let dir = tempfile::tempdir().unwrap();
        let env = dir.path().join("ntfy.env");
        let write = |body: &str, mode: u32| {
            std::fs::write(&env, body).unwrap();
            std::fs::set_permissions(&env, std::fs::Permissions::from_mode(mode)).unwrap();
        };
        write(
            &format!("# comment\nNTFY_URL={}/legacy-topic\n", server.url),
            0o600,
        );
        let notifier = Notifier::new(dir.path(), Some(&env)).unwrap();
        let channels = notifier.channels(&pool).await.unwrap();
        let ntfy = channels.iter().find(|c| c.kind == Kind::Ntfy).unwrap();
        assert!(ntfy.from_file && ntfy.enabled && ntfy.target.is_ok());
        assert_eq!(view(ntfy)["secrets"], json!({"url": false, "token": false}));
        let active = notifier.active(&pool).await.unwrap();
        assert_eq!(active.len(), 1);
        notifier.send(&active[0].1, &forza()).await.unwrap();
        assert_eq!(server.take()[0].path, "/legacy-topic");
        // The switch still works for the file channel.
        configure(&notifier, &pool, Kind::Ntfy, json!({"enabled": false})).await;
        assert!(notifier.active(&pool).await.unwrap().is_empty());
        configure(&notifier, &pool, Kind::Ntfy, json!({"enabled": true})).await;
        // A topic URL from the UI replaces the file.
        configure(
            &notifier,
            &pool,
            Kind::Ntfy,
            json!({"enabled": true, "secrets": {"url": format!("{}/ui-topic", server.url)}}),
        )
        .await;
        let active = notifier.active(&pool).await.unwrap();
        notifier.send(&active[0].1, &forza()).await.unwrap();
        assert_eq!(server.take()[0].path, "/ui-topic");
        // The old file rules stay: owner-only, and a token only over https.
        write(&format!("NTFY_URL={}/legacy-topic\n", server.url), 0o644);
        assert!(ntfy_file(&env).is_none());
        write(
            &format!("NTFY_URL={}/legacy-topic\nNTFY_TOKEN=tk_1\n", server.url),
            0o600,
        );
        assert!(ntfy_file(&env).is_none());
        write(
            "NTFY_URL=https://ntfy.example.org/topic\nNTFY_TOKEN=tk_1\n",
            0o600,
        );
        assert!(matches!(
            ntfy_file(&env),
            Some(Target::Ntfy { token: Some(_), .. })
        ));
    }
}
