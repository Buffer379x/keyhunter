//! Validation of the channel settings and the owner-only file of their secrets.

use super::{FsPath, Kind, Notifier, Values};
use crate::{ApiError, ApiResult, config::is_local_http_origin};
use axum::http::StatusCode;
use lettre::message::Mailbox;
use serde::Deserialize;
use sqlx::SqlitePool;
use std::{collections::BTreeMap, os::unix::fs::PermissionsExt, sync::PoisonError};
use url::Url;

const MISSING: &str = "Fülle alle Pflichtfelder des Kanals aus.";
const BAD_URL: &str = "Gib eine http- oder https-Adresse ohne Zugangsdaten in der Adresse ein.";
const PLAIN_HTTP: &str =
    "Über http gehen Zugangsdaten nur an Server im lokalen Netz. Verwende eine https-Adresse.";
pub(super) const BAD_INPUT: ApiError =
    ApiError(StatusCode::BAD_REQUEST, "Prüfe die Angaben des Kanals.");
const STORAGE: ApiError = ApiError(
    StatusCode::INTERNAL_SERVER_ERROR,
    "Zugangsdaten konnten nicht gespeichert werden. Prüfe den Schreibzugriff auf das Datenverzeichnis.",
);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Security {
    /// Port 587: plain connection upgraded with STARTTLS, which is required.
    StartTls,
    /// Port 465: TLS from the first byte.
    Tls,
    /// Unencrypted, only to a mail server in the local network and never with a password.
    None,
}

#[derive(Clone, Debug)]
pub(crate) struct Smtp {
    pub(super) host: String,
    pub(super) port: u16,
    pub(super) security: Security,
    pub(super) login: Option<(String, String)>,
    pub(super) from: Mailbox,
    pub(super) to: Vec<Mailbox>,
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
    pub(super) fn secrets(&self) -> Vec<String> {
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

pub(super) fn ntfy(url: &str, token: Option<&str>) -> Result<Target, &'static str> {
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
pub(super) fn target(
    kind: Kind,
    settings: &Values,
    secrets: &Values,
) -> Result<Target, &'static str> {
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
pub(super) fn ntfy_file(path: &FsPath) -> Option<Target> {
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

pub(super) fn read_secrets(path: &FsPath) -> BTreeMap<String, Values> {
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
pub(super) struct Channel {
    pub(super) kind: Kind,
    pub(super) enabled: bool,
    pub(super) settings: Values,
    pub(super) secrets: Values,
    /// ntfy only: served by the ntfy file because no topic URL is saved in the UI.
    pub(super) from_file: bool,
    pub(super) target: Result<Target, &'static str>,
}

impl Notifier {
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

    pub(super) async fn channels(&self, pool: &SqlitePool) -> sqlx::Result<Vec<Channel>> {
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
    pub(super) async fn save(
        &self,
        pool: &SqlitePool,
        kind: Kind,
        input: ChannelInput,
    ) -> ApiResult<()> {
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
    pub(super) async fn remove(&self, pool: &SqlitePool, kind: Kind) -> ApiResult<()> {
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
}

/// Body of `PUT /alerts/channels/{kind}`, saved by [`Notifier::save`].
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct ChannelInput {
    pub(super) enabled: bool,
    #[serde(default)]
    settings: BTreeMap<String, String>,
    #[serde(default)]
    secrets: BTreeMap<String, Option<String>>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::notify::{api::view, testing::*};
    use serde_json::{Value, json};
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
