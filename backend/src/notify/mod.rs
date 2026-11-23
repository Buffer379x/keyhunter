//! Notification channels (0.9.0): ntfy, Telegram, Discord, e-mail (SMTP), Gotify, Pushover and a generic webhook. Each
//! channel has a switch and its settings in `notification_channel` (migration 0027). Tokens, passwords and secret URLs
//! live in `<data>/notification-secrets.json` (0600), written like the IGDB access; the API only says whether one is set.
//! An existing ntfy file (`KEYHUNTER_NTFY_ENV_FILE`) serves the ntfy channel as long as no topic URL is saved in the UI.
//!
//! Parts: [`channel`] validates the channels and keeps their secrets, [`send`] delivers a message, [`message`] words
//! it, [`api`] answers the settings page.

pub(crate) mod api;
mod channel;
pub(crate) mod message;
mod send;
#[cfg(test)]
pub(crate) mod testing;

use channel::{Target, ntfy_file, read_secrets};
use reqwest::{Client, redirect::Policy};
use std::{
    collections::BTreeMap,
    path::{Path as FsPath, PathBuf},
    sync::Mutex,
    time::Duration,
};

type Values = BTreeMap<String, String>;

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
}
