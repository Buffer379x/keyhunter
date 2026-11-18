use crate::{ApiError, ApiResult, Shared, auth, now, offers, shops::Product};
use axum::{
    Json,
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
};
use reqwest::{Client, header::HeaderValue, redirect::Policy};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::{FromRow, SqliteConnection, SqlitePool};
use std::{os::unix::fs::PermissionsExt, path::Path as FsPath, sync::Arc, time::Duration};
use url::Url;

const DAY: i64 = 86400;
const COOLDOWN: i64 = DAY;
const BAD_RULE: ApiError = ApiError(StatusCode::BAD_REQUEST, "Prüfe Alarmart und Zielpreis.");
const NEED_COUNTRY: ApiError = ApiError(StatusCode::CONFLICT, "Wähle zuerst ein Zielland.");

#[derive(Deserialize, Serialize)]
pub(crate) struct Rule {
    mode: String,
    basis: String,
    target_cents: Option<i64>,
    enabled: bool,
}
#[derive(FromRow)]
struct StoredRule {
    mode: String,
    basis: String,
    target_cents: Option<i64>,
    enabled: bool,
    scope: Option<String>,
    previous_cents: Option<i64>,
    lowest_cents: Option<i64>,
    last_sent: Option<i64>,
}

async fn rule(conn: &mut SqliteConnection, id: &str) -> sqlx::Result<Option<StoredRule>> {
    sqlx::query_as("SELECT * FROM alert_rule WHERE wish_id=?")
        .bind(id)
        .fetch_optional(conn)
        .await
}

pub(crate) async fn get_rule(
    State(state): State<Shared>,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> ApiResult<Json<Value>> {
    auth::authenticate(&state, &headers).await?;
    offers::wish(&state.pool, &id).await?;
    let mut conn = state.pool.acquire().await?;
    let current = rule(&mut conn, &id).await?.map(|r| Rule {
        mode: r.mode,
        basis: r.basis,
        target_cents: r.target_cents,
        enabled: r.enabled,
    });
    Ok(Json(
        json!({"rule":current,"configured":state.ntfy.is_some()}),
    ))
}

pub(crate) async fn put_rule(
    State(state): State<Shared>,
    Path(id): Path<String>,
    headers: HeaderMap,
    Json(input): Json<Rule>,
) -> ApiResult<StatusCode> {
    let session = auth::authenticate(&state, &headers).await?;
    auth::require_csrf(&state, &headers, &session)?;
    offers::wish(&state.pool, &id).await?;
    if !matches!(input.basis.as_str(), "base" | "estimate")
        || !(input.mode == "target"
            && input
                .target_cents
                .is_some_and(|c| (1..=10_000_000).contains(&c))
            || input.mode == "low" && input.target_cents.is_none())
    {
        return Err(BAD_RULE);
    }
    if input.enabled && offers::target(&state.pool).await?.is_empty() {
        return Err(NEED_COUNTRY);
    }
    let mut tx = state.pool.begin().await?;
    let edited = sqlx::query("INSERT INTO alert_rule(wish_id,mode,basis,target_cents,enabled) VALUES(?,?,?,?,?)
        ON CONFLICT(wish_id) DO UPDATE SET mode=excluded.mode,basis=excluded.basis,target_cents=excluded.target_cents,
        enabled=excluded.enabled,scope=NULL,previous_cents=NULL,lowest_cents=NULL,last_sent=NULL
        WHERE mode!=excluded.mode OR basis!=excluded.basis OR target_cents IS NOT excluded.target_cents OR enabled!=excluded.enabled")
        .bind(&id).bind(input.mode).bind(input.basis).bind(input.target_cents).bind(input.enabled)
        .execute(&mut *tx).await?.rows_affected();
    if edited > 0 {
        sqlx::query(
            "UPDATE alert_outbox SET state='cancelled' WHERE wish_id=? AND state='pending'",
        )
        .bind(id)
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await?;
    Ok(StatusCode::NO_CONTENT)
}

pub(crate) async fn remove_rule(
    State(state): State<Shared>,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> ApiResult<StatusCode> {
    let session = auth::authenticate(&state, &headers).await?;
    auth::require_csrf(&state, &headers, &session)?;
    sqlx::query("DELETE FROM alert_rule WHERE wish_id=?")
        .bind(id)
        .execute(&state.pool)
        .await?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Serialize, FromRow)]
struct RuleView {
    wish_id: String,
    title: String,
    mode: String,
    basis: String,
    enabled: bool,
    target_cents: Option<i64>,
    delivery: Option<String>,
}
#[derive(Serialize, FromRow)]
struct EventView {
    id: i64,
    wish_id: Option<String>,
    state: String,
    observed_at: i64,
    sent_at: Option<i64>,
    cents: Option<i64>,
    attempts: i64,
}
pub(crate) async fn list(
    State(state): State<Shared>,
    headers: HeaderMap,
) -> ApiResult<Json<Value>> {
    auth::authenticate(&state, &headers).await?;
    let rules: Vec<RuleView> = sqlx::query_as("SELECT r.*, COALESCE(g.manual_title,json_extract(c.payload,'$.name')) AS title,
        (SELECT state FROM alert_outbox o WHERE o.wish_id=r.wish_id ORDER BY o.id DESC LIMIT 1) AS delivery
        FROM alert_rule r JOIN wishlist_item w ON w.id=r.wish_id JOIN game g ON g.id=w.game_id
        LEFT JOIN catalog_game c ON c.igdb_id=g.igdb_id ORDER BY title").fetch_all(&state.pool).await?;
    let events: Vec<EventView> = sqlx::query_as(
        "SELECT id,wish_id,state,observed_at,sent_at,cents,attempts FROM alert_outbox
        ORDER BY id DESC LIMIT 30",
    )
    .fetch_all(&state.pool)
    .await?;
    Ok(Json(
        json!({"configured":state.ntfy.is_some(),"rules":rules,"events":events}),
    ))
}
pub(crate) async fn test_message(
    State(state): State<Shared>,
    headers: HeaderMap,
) -> ApiResult<StatusCode> {
    let session = auth::authenticate(&state, &headers).await?;
    auth::require_csrf(&state, &headers, &session)?;
    if state.ntfy.is_none() {
        return Err(ApiError(
            StatusCode::CONFLICT,
            "Der ntfy-Kanal ist nicht eingerichtet.",
        ));
    }
    let t = now();
    let n=sqlx::query("INSERT INTO alert_outbox(observed_at,message,due) SELECT ?,'KEYHUNTER Global: Testnachricht',?
        WHERE NOT EXISTS(SELECT 1 FROM alert_outbox WHERE wish_id IS NULL AND observed_at>?)")
        .bind(t).bind(t).bind(t-60).execute(&state.pool).await?.rows_affected();
    if n == 0 {
        return Err(ApiError(
            StatusCode::CONFLICT,
            "Eine Testnachricht ist einmal pro Minute möglich.",
        ));
    }
    Ok(StatusCode::ACCEPTED)
}

struct Check {
    scope: String,
    best: Option<i64>,
    sampled: bool,
}
async fn check(
    conn: &mut SqliteConnection,
    id: &str,
    rule: &StoredRule,
    link_id: Option<i64>,
    t: i64,
) -> anyhow::Result<Check> {
    let target = sqlx::query_scalar::<_, Option<String>>(
        "SELECT target_country FROM app_settings WHERE id=1",
    )
    .fetch_one(&mut *conn)
    .await?
    .unwrap_or_default();
    let (platform,title,payload): (i64,Option<String>,Option<String>) = sqlx::query_as("SELECT w.platform_id,g.manual_title,c.payload
        FROM wishlist_item w JOIN game g ON g.id=w.game_id LEFT JOIN catalog_game c ON g.igdb_id=c.igdb_id WHERE w.id=?")
        .bind(id).fetch_one(&mut *conn).await?;
    let wish = offers::Wish::from_parts(platform, title, payload);
    let estimate_settings: Vec<(String, i64)> = if rule.basis == "estimate" {
        sqlx::query_as("SELECT id,fee_basis_points FROM source_settings WHERE kind='shop' AND enabled AND fee_estimation_enabled ORDER BY id")
            .fetch_all(&mut *conn).await?
    } else {
        vec![]
    };
    // Changing the comparison basis or any eligible product identity starts a new series.
    let mut identities = Vec::new();
    let mut best = None;
    let mut sampled = false;
    for link in offers::links(&mut *conn, id, t).await? {
        let Some(product) = link.product() else {
            continue;
        };
        if link.enabled
            && link.confirmed(&wish, &product)
            && (rule.basis == "base" || link.fee_estimation_enabled)
            && product.activation(&target) == "confirmed"
            && product.purchase_country.as_deref() == Some(&target)
        {
            identities.push((link.id, product.fingerprint()));
        }
        if link.available(&wish, &product, &target, t) {
            let price = price(&link, &product, rule);
            if let Some(price) = price {
                sampled |= link_id == Some(link.id) && link.observed_at == Some(t);
                best = Some(best.map_or(price, |old: i64| old.min(price)));
            }
        }
    }
    let scope = json!([
        id,
        platform,
        wish.keys(),
        target,
        rule.mode,
        rule.basis,
        rule.target_cents,
        estimate_settings,
        identities
    ])
    .to_string();
    Ok(Check {
        scope: hex::encode(crate::digest(&scope)),
        best,
        sampled,
    })
}

fn price(link: &offers::Link, product: &Product, rule: &StoredRule) -> Option<i64> {
    let base = product.offers.iter().map(|o| o.cents).min()?;
    if rule.basis == "base" {
        Some(base)
    } else {
        link.estimate(base)
    }
}

pub(crate) async fn observe(
    conn: &mut SqliteConnection,
    id: &str,
    link_id: i64,
    t: i64,
) -> anyhow::Result<()> {
    let Some(rule) = rule(&mut *conn, id).await?.filter(|r| r.enabled) else {
        return Ok(());
    };
    let current = check(&mut *conn, id, &rule, Some(link_id), t).await?;
    let Some(best) = current.best.filter(|_| current.sampled) else {
        return Ok(());
    };
    let same_scope = rule.scope.as_deref() == Some(&current.scope);
    let previous = rule.previous_cents.filter(|_| same_scope);
    let lowest = rule.lowest_cents.filter(|_| same_scope);
    if !same_scope {
        sqlx::query(
            "UPDATE alert_outbox SET state='cancelled' WHERE wish_id=? AND state='pending'",
        )
        .bind(id)
        .execute(&mut *conn)
        .await?;
    }
    let triggered = match rule.target_cents {
        Some(target) => best <= target && previous.is_none_or(|price| price > target),
        None => lowest.is_some_and(|price| best < price),
    };
    if triggered {
        sqlx::query(
            "UPDATE alert_outbox SET state='cancelled' WHERE wish_id=? AND state='pending'",
        )
        .bind(id)
        .execute(&mut *conn)
        .await?;
        let title: String = sqlx::query_scalar("SELECT COALESCE(g.manual_title,json_extract(c.payload,'$.name'))
            FROM wishlist_item w JOIN game g ON g.id=w.game_id LEFT JOIN catalog_game c ON c.igdb_id=g.igdb_id WHERE w.id=?")
            .bind(id).fetch_one(&mut *conn).await?;
        let basis = if rule.basis == "base" {
            "Grundpreis"
        } else {
            "geschätzter Gesamtpreis"
        };
        let message = format!(
            "KEYHUNTER Global: {title}\n{}.{:02} EUR ({basis})",
            best / 100,
            best % 100
        );
        let due = t.max(rule.last_sent.unwrap_or(0) + COOLDOWN);
        sqlx::query("INSERT INTO alert_outbox(wish_id,scope,observed_at,cents,message,due) VALUES(?,?,?,?,?,?) ON CONFLICT DO NOTHING")
            .bind(id).bind(&current.scope).bind(t).bind(best).bind(message).bind(due).execute(&mut *conn).await?;
    }
    sqlx::query("UPDATE alert_rule SET scope=?,previous_cents=?,lowest_cents=? WHERE wish_id=?")
        .bind(current.scope)
        .bind(best)
        .bind(lowest.map_or(best, |v| v.min(best)))
        .bind(id)
        .execute(&mut *conn)
        .await?;
    Ok(())
}

pub(crate) struct Ntfy {
    client: Client,
    url: Url,
    authorization: Option<HeaderValue>,
}
impl Ntfy {
    pub(crate) fn from_env() -> Option<Self> {
        let path = std::env::var_os("KEYHUNTER_NTFY_ENV_FILE")?;
        let result = Self::load(FsPath::new(&path));
        if result.is_none() {
            tracing::info!("ntfy configuration absent or invalid");
        }
        result
    }

    fn load(path: &FsPath) -> Option<Self> {
        let metadata = std::fs::metadata(path).ok()?;
        if !metadata.is_file()
            || metadata.permissions().mode() & 0o077 != 0
            || metadata.len() > 8192
        {
            return None;
        }
        let body = std::fs::read_to_string(path).ok()?;
        let fields: std::collections::BTreeMap<_, _> = body
            .lines()
            .map(str::trim)
            .filter(|line| !line.starts_with('#'))
            .filter_map(|line| line.split_once('='))
            .map(|(k, v)| (k.trim(), v.trim()))
            .collect();
        let url = Url::parse(fields.get("NTFY_URL")?).ok()?;
        if !matches!(url.scheme(), "https" | "http")
            || url.host_str().is_none()
            || !url.username().is_empty()
            || url.password().is_some()
            || url.query().is_some()
            || url.fragment().is_some()
            || url.path().trim_matches('/').is_empty()
        {
            return None;
        }
        let authorization = match fields.get("NTFY_TOKEN").filter(|v| !v.is_empty()) {
            Some(token) if url.scheme() == "https" => {
                let mut value = HeaderValue::from_str(&format!("Bearer {token}")).ok()?;
                value.set_sensitive(true);
                Some(value)
            }
            Some(_) => return None,
            None => None,
        };
        let client = Client::builder()
            .no_proxy()
            .redirect(Policy::none())
            .timeout(Duration::from_secs(10))
            .connect_timeout(Duration::from_secs(5))
            .build()
            .ok()?;
        Some(Self {
            client,
            url,
            authorization,
        })
    }

    async fn send(&self, message: String) -> bool {
        let mut request = self
            .client
            .post(self.url.clone())
            .header("Content-Type", "text/plain; charset=utf-8")
            .header("Title", "KEYHUNTER Global")
            .body(message);
        if let Some(value) = &self.authorization {
            request = request.header(reqwest::header::AUTHORIZATION, value.clone());
        }
        request
            .send()
            .await
            .is_ok_and(|response| response.status().is_success())
    }
}

pub(crate) fn start(pool: &SqlitePool, ntfy: Arc<Ntfy>) {
    let pool = pool.clone();
    tokio::spawn(async move {
        loop {
            if let Err(error) = deliver_one(&pool, &ntfy).await {
                tracing::warn!(%error,"Notification queue operation failed");
            }
            tokio::time::sleep(Duration::from_secs(3)).await;
        }
    });
}

#[derive(FromRow)]
struct Delivery {
    id: i64,
    wish_id: Option<String>,
    scope: Option<String>,
    observed_at: i64,
    cents: Option<i64>,
    message: String,
    attempts: i64,
}
async fn deliver_one(pool: &SqlitePool, ntfy: &Ntfy) -> anyhow::Result<()> {
    let t = now();
    let row: Option<Delivery> = sqlx::query_as("UPDATE alert_outbox SET lease_until=?,attempts=attempts+1
        WHERE id=(SELECT id FROM alert_outbox WHERE state='pending' AND due<=? AND lease_until<=?
        AND NOT EXISTS(SELECT 1 FROM alert_outbox WHERE state='pending' AND lease_until>?) ORDER BY due,id LIMIT 1)
        RETURNING id,wish_id,scope,observed_at,cents,message,attempts")
        .bind(t+60).bind(t).bind(t).bind(t).fetch_optional(pool).await?;
    let Some(row) = row else {
        return Ok(());
    };
    let valid = if let Some(id) = &row.wish_id {
        let mut conn = pool.acquire().await?;
        if let Some(rule) = rule(&mut conn, id).await?.filter(|r| r.enabled) {
            let current = check(&mut conn, id, &rule, None, t).await?;
            row.scope.as_deref() == Some(&current.scope)
                && current
                    .best
                    .zip(row.cents)
                    .is_some_and(|(best, recorded)| best <= recorded)
                && t - row.observed_at <= offers::FRESH
        } else {
            false
        }
    } else {
        t - row.observed_at < 3600
    };
    let still_pending: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM alert_outbox WHERE id=? AND state='pending')",
    )
    .bind(row.id)
    .fetch_one(pool)
    .await?;
    if !still_pending {
        return Ok(());
    }
    let status = if !valid {
        "cancelled"
    } else if ntfy.send(row.message).await {
        "sent"
    } else if row.attempts >= 3 {
        "failed"
    } else {
        "pending"
    };
    let mut tx = pool.begin().await?;
    let n=sqlx::query("UPDATE alert_outbox SET state=?,lease_until=0,due=?,sent_at=? WHERE id=? AND state='pending' AND lease_until=?")
        .bind(status).bind(t+60*(1<<row.attempts.min(3))).bind((status=="sent").then_some(t)).bind(row.id).bind(t+60)
        .execute(&mut *tx).await?.rows_affected();
    if n > 0
        && status == "sent"
        && let Some(id) = row.wish_id
    {
        sqlx::query("UPDATE alert_rule SET last_sent=? WHERE wish_id=?")
            .bind(t)
            .bind(id)
            .execute(&mut *tx)
            .await?;
    }
    sqlx::query("DELETE FROM alert_outbox WHERE observed_at<? AND state!='pending'")
        .bind(t - 90 * DAY)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    #[tokio::test]
    async fn alarms_follow_fresh_prices_and_retry_locally() {
        let pool = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        sqlx::migrate!("./migrations").run(&pool).await.unwrap();
        sqlx::query("UPDATE app_settings SET target_country='DE'")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query(
            "INSERT INTO game(id,manual_title,manual_key,created_at) VALUES('g','Game','game',0)",
        )
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query("INSERT INTO wishlist_item VALUES('wish','g',169,0)")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO offer_link(id,wish_id,source,url,review) VALUES(1,'wish','eneba','fixture','confirmed')").execute(&pool).await.unwrap();
        sqlx::query("INSERT INTO alert_rule(wish_id,mode,basis,target_cents,enabled) VALUES('wish','target','base',2400,1)").execute(&pool).await.unwrap();
        let mut product = Product {
            id: "fixture".into(),
            name: "Game".into(),
            title: "Game".into(),
            key_game: true,
            platform_ids: vec![169],
            region: Some("Global".into()),
            allowed: vec!["DE".into()],
            blocked: vec![],
            purchase_country: Some("DE".into()),
            offers: vec![crate::shops::Quote {
                id: "one".into(),
                cents: 2600,
                seller: None,
            }],
            availability: crate::shops::Availability::InStock,
        };
        let t = now() - 60;
        async fn sample(pool: &SqlitePool, product: &Product, t: i64, error: Option<&str>) {
            let mut tx = pool.begin().await.unwrap();
            sqlx::query("UPDATE offer_link SET fingerprint=?,latest=?,observed_at=?,last_error=? WHERE id=1")
                .bind(product.fingerprint()).bind(serde_json::to_string(product).unwrap()).bind(t).bind(error)
                .execute(&mut *tx).await.unwrap();
            observe(&mut tx, "wish", 1, t).await.unwrap();
            tx.commit().await.unwrap();
        }
        async fn total(pool: &SqlitePool) -> i64 {
            sqlx::query_scalar("SELECT count(*) FROM alert_outbox")
                .fetch_one(pool)
                .await
                .unwrap()
        }
        sample(&pool, &product, t, None).await;
        product.offers[0].cents = 2400;
        sample(&pool, &product, t + 1, Some("network")).await;
        assert_eq!(total(&pool).await, 0);
        sample(&pool, &product, t + 2, None).await;
        sample(&pool, &product, t + 3, None).await;
        assert_eq!(total(&pool).await, 1);

        let requests = Arc::new(AtomicUsize::new(0));
        let handler = Arc::clone(&requests);
        let router = axum::Router::new().route(
            "/keyhunter-test",
            axum::routing::post(move |body: String| {
                let num = handler.fetch_add(1, Ordering::Relaxed);
                async move {
                    assert!(body.contains("24.00 EUR"));
                    if num == 0 {
                        StatusCode::SERVICE_UNAVAILABLE
                    } else {
                        StatusCode::OK
                    }
                }
            }),
        );
        let socket = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = socket.local_addr().unwrap();
        let server = tokio::spawn(async move { axum::serve(socket, router).await.unwrap() });
        let ntfy = Ntfy {
            client: Client::builder().no_proxy().build().unwrap(),
            url: Url::parse(&format!("http://{address}/keyhunter-test")).unwrap(),
            authorization: None,
        };
        deliver_one(&pool, &ntfy).await.unwrap();
        assert_eq!(requests.load(Ordering::Relaxed), 1);
        assert_eq!(
            sqlx::query_scalar::<_, String>("SELECT state FROM alert_outbox")
                .fetch_one(&pool)
                .await
                .unwrap(),
            "pending"
        );
        sqlx::query("UPDATE alert_outbox SET due=0")
            .execute(&pool)
            .await
            .unwrap();
        deliver_one(&pool, &ntfy).await.unwrap();
        assert_eq!(requests.load(Ordering::Relaxed), 2);
        assert_eq!(
            sqlx::query_scalar::<_, String>("SELECT state FROM alert_outbox")
                .fetch_one(&pool)
                .await
                .unwrap(),
            "sent"
        );
        sqlx::query("UPDATE alert_rule SET mode='low',target_cents=NULL,scope=NULL,previous_cents=NULL,lowest_cents=NULL").execute(&pool).await.unwrap();
        sample(&pool, &product, t + 4, None).await;
        assert_eq!(total(&pool).await, 1);
        product.offers[0].cents = 2300;
        sample(&pool, &product, t + 5, None).await;
        assert_eq!(total(&pool).await, 2);
        let due: i64 = sqlx::query_scalar("SELECT due FROM alert_outbox WHERE state='pending'")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert!(due >= t + COOLDOWN);
        server.abort();
    }
}
