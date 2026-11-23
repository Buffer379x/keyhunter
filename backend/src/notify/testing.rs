//! Local stand-ins for the services: no test ever reaches a real one.

use super::{
    Kind, Notifier, Values,
    message::{Alert, Event},
};
use axum::{
    Json,
    body::Bytes,
    http::{HeaderMap, Method, StatusCode, Uri},
};
use serde_json::{Value, json};
use sqlx::SqlitePool;
use std::{
    collections::VecDeque,
    path::Path as FsPath,
    sync::{Arc, Mutex},
};

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

pub(crate) async fn configure(notifier: &Notifier, pool: &SqlitePool, kind: Kind, input: Value) {
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

// Made-up values in the shape the validation expects. They are glued together from pieces (0.9.1) so secret
// scanners do not take the source for a real Telegram token, Pushover key or Discord webhook.
pub(crate) const BOT: &str = concat!("123456789", ":", "AAE", "fixtureTokenOnlyForTests_abcdef");

pub(crate) const PUSH_USER: &str = concat!("ufixture", "userkey", "000000000000001");

pub(crate) const PUSH_TOKEN: &str = concat!("afixture", "apptoken", "00000000000001");

pub(crate) fn forza() -> Alert {
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

pub(crate) fn values(pairs: &[(&str, &str)]) -> Values {
    pairs
        .iter()
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect()
}
