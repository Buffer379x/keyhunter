use crate::DAY;
use crate::extract::{ApiJson, ApiPath};
use crate::{
    ApiError, ApiResult, Shared, auth,
    eventlog::{self, Area, Level},
    notify::{
        Kind, Notifier,
        message::{Alert, Event, euro},
    },
    now, offers,
    shops::{Product, Shop},
};
use axum::{
    Json,
    extract::State,
    http::{HeaderMap, StatusCode},
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::{FromRow, SqliteConnection, SqlitePool};
use std::{sync::Arc, time::Duration};

const COOLDOWN: i64 = DAY;
/// Deliveries of one alert per channel before it counts as failed.
const ATTEMPTS: i64 = 3;
/// How long the worker holds an alert while it sends through every channel (each send times out after 10–15 s).
const LEASE: i64 = 300;
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
    sqlx::query_as("SELECT * FROM alert_rule WHERE wish_id=? AND (SELECT state FROM wishlist_item w WHERE w.id=alert_rule.wish_id)='wished'")
        .bind(id)
        .fetch_optional(conn)
        .await
}

pub(crate) async fn get_rule(
    State(state): State<Shared>,
    _: auth::Session,
    ApiPath(id): ApiPath<String>,
) -> ApiResult<Json<Value>> {
    offers::wish(&state.pool, &id).await?;
    let mut conn = state.pool.acquire().await?;
    let current = rule(&mut conn, &id).await?.map(|r| Rule {
        mode: r.mode,
        basis: r.basis,
        target_cents: r.target_cents,
        enabled: r.enabled,
    });
    let channels = state.notifier.active_names(&state.pool).await?;
    Ok(Json(
        json!({"rule":current,"configured":!channels.is_empty(),"channels":channels}),
    ))
}

pub(crate) async fn put_rule(
    State(state): State<Shared>,
    session: auth::Session,
    ApiPath(id): ApiPath<String>,
    headers: HeaderMap,
    ApiJson(input): ApiJson<Rule>,
) -> ApiResult<StatusCode> {
    auth::require_csrf(&state, &headers, &session)?;
    crate::wishlist::require_unowned(&state.pool, &id).await?;
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
    let summary = match input.target_cents {
        Some(cents) => format!("Zielpreis {}", euro(cents)),
        None => "neuer Tiefstpreis".into(),
    };
    let summary = if input.enabled {
        summary
    } else {
        format!("{summary}, ausgeschaltet")
    };
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
        .bind(&id)
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await?;
    let game = eventlog::game(&state.pool, &id).await;
    eventlog::record(
        &state.pool,
        Level::Info,
        Area::Alerts,
        format!("Preisalarm für {game} gespeichert ({summary})"),
    )
    .await;
    Ok(StatusCode::NO_CONTENT)
}

pub(crate) async fn remove_rule(
    State(state): State<Shared>,
    session: auth::Session,
    ApiPath(id): ApiPath<String>,
    headers: HeaderMap,
) -> ApiResult<StatusCode> {
    auth::require_csrf(&state, &headers, &session)?;
    let removed = sqlx::query("DELETE FROM alert_rule WHERE wish_id=?")
        .bind(&id)
        .execute(&state.pool)
        .await?
        .rows_affected();
    if removed > 0 {
        let game = eventlog::game(&state.pool, &id).await;
        eventlog::record(
            &state.pool,
            Level::Info,
            Area::Alerts,
            format!("Preisalarm für {game} entfernt"),
        )
        .await;
    }
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
    #[sqlx(skip)]
    deliveries: Vec<DeliveryView>,
}
/// Delivery of one alert through one channel; `error` is the short reason of the last failure.
#[derive(Serialize, FromRow)]
struct DeliveryView {
    #[serde(skip)]
    outbox_id: i64,
    channel: String,
    #[sqlx(skip)]
    name: &'static str,
    state: String,
    attempts: i64,
    error: Option<String>,
}
pub(crate) async fn list(State(state): State<Shared>, _: auth::Session) -> ApiResult<Json<Value>> {
    let rules: Vec<RuleView> = sqlx::query_as("SELECT r.*, COALESCE(g.manual_title,json_extract(c.payload,'$.name')) AS title,
        (SELECT state FROM alert_outbox o WHERE o.wish_id=r.wish_id ORDER BY o.id DESC LIMIT 1) AS delivery
        FROM alert_rule r JOIN wishlist_item w ON w.id=r.wish_id JOIN game g ON g.id=w.game_id
        LEFT JOIN catalog_game c ON c.igdb_id=g.igdb_id WHERE w.state='wished' ORDER BY title").fetch_all(&state.pool).await?;
    let mut events: Vec<EventView> = sqlx::query_as(
        "SELECT id,wish_id,state,observed_at,sent_at,cents,attempts FROM alert_outbox
        ORDER BY id DESC LIMIT 30",
    )
    .fetch_all(&state.pool)
    .await?;
    let deliveries: Vec<DeliveryView> = sqlx::query_as(
        "SELECT outbox_id,channel,state,attempts,error FROM channel_delivery
        WHERE outbox_id IN (SELECT id FROM alert_outbox ORDER BY id DESC LIMIT 30) ORDER BY rowid",
    )
    .fetch_all(&state.pool)
    .await?;
    for mut delivery in deliveries {
        let Some(kind) = Kind::from_id(&delivery.channel) else {
            continue;
        };
        delivery.name = kind.name();
        if let Some(event) = events.iter_mut().find(|e| e.id == delivery.outbox_id) {
            event.deliveries.push(delivery);
        }
    }
    let channels = state.notifier.active_names(&state.pool).await?;
    Ok(Json(
        json!({"configured":!channels.is_empty(),"channels":channels,"rules":rules,"events":events}),
    ))
}
/// POST /alerts/test: queue a test message for every active channel, at most once a minute. It takes the way of an
/// alert (outbox, one delivery per channel) and shows up in "Letzte Zustellungen".
pub(crate) async fn test_message(
    State(state): State<Shared>,
    session: auth::Session,
    headers: HeaderMap,
) -> ApiResult<StatusCode> {
    auth::require_csrf(&state, &headers, &session)?;
    if state.notifier.active(&state.pool).await?.is_empty() {
        return Err(ApiError(
            StatusCode::CONFLICT,
            "Es ist kein Benachrichtigungskanal eingerichtet.",
        ));
    }
    let t = now();
    let n = sqlx::query(
        "INSERT INTO alert_outbox(observed_at,due) SELECT ?,?
        WHERE NOT EXISTS(SELECT 1 FROM alert_outbox WHERE wish_id IS NULL AND observed_at>?)",
    )
    .bind(t)
    .bind(t)
    .bind(t - 60)
    .execute(&state.pool)
    .await?
    .rows_affected();
    if n == 0 {
        return Err(ApiError(
            StatusCode::CONFLICT,
            "Eine Testnachricht ist einmal pro Minute möglich.",
        ));
    }
    eventlog::record(
        &state.pool,
        Level::Info,
        Area::Alerts,
        "Testnachricht vorgemerkt",
    )
    .await;
    Ok(StatusCode::ACCEPTED)
}

/// The cheapest eligible offer of a check.
struct Best {
    cents: i64,
    shop: String,
    region: Option<String>,
    url: String,
    /// Freshness limit of the offer's link ([`crate::pricing::fresh_for`]).
    fresh_for: i64,
}
struct Check {
    scope: String,
    country: String,
    best: Option<Best>,
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
    // The series depends only on the wish, the rule and the fee settings. Newly found
    // or re-mapped offers join it instead of resetting its baseline.
    let price_scope = crate::pricing::Scope::target(&target);
    let mut best: Option<Best> = None;
    let mut sampled = false;
    for link in offers::links(&mut *conn, id, t).await? {
        let Some(product) = link.product() else {
            continue;
        };
        if !crate::pricing::evaluate(&link, &wish, Some(&product), &price_scope, t).eligible() {
            continue;
        }
        if let Some(price) = price(&link, &product, rule) {
            sampled |= link_id == Some(link.id) && link.observed_at == Some(t);
            if best.as_ref().is_none_or(|old| price < old.cents) {
                best = Some(Best {
                    cents: price,
                    shop: Shop::from_id(&link.source)
                        .map_or_else(|| link.source.clone(), |shop| shop.name().into()),
                    region: product.region.clone(),
                    url: link.url().to_owned(),
                    fresh_for: link.fresh_for(),
                });
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
        estimate_settings
    ])
    .to_string();
    Ok(Check {
        scope: hex::encode(crate::digest(&scope)),
        country: target,
        best,
        sampled,
    })
}

fn price(link: &offers::Link, product: &Product, rule: &StoredRule) -> Option<i64> {
    if rule.basis == "base" {
        crate::pricing::base(link, product)
    } else {
        crate::pricing::estimate(link, product)
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
    let Some(best) = current.best.as_ref().filter(|_| current.sampled) else {
        return Ok(());
    };
    let cents = best.cents;
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
        Some(target) => cents <= target && previous.is_none_or(|price| price > target),
        None => lowest.is_some_and(|price| cents < price),
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
        let due = t.max(rule.last_sent.unwrap_or(0) + COOLDOWN);
        // reference_cents: the target, or for a new low the lowest price before.
        sqlx::query("INSERT INTO alert_outbox(wish_id,scope,observed_at,cents,due,game,mode,basis,reference_cents,shop,region,country,url)
            VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING")
            .bind(id).bind(&current.scope).bind(t).bind(cents).bind(due).bind(title).bind(&rule.mode).bind(&rule.basis)
            .bind(rule.target_cents.or(lowest)).bind(&best.shop).bind(&best.region)
            .bind(Some(&current.country).filter(|c| !c.is_empty())).bind(&best.url)
            .execute(&mut *conn).await?;
    }
    sqlx::query("UPDATE alert_rule SET scope=?,previous_cents=?,lowest_cents=? WHERE wish_id=?")
        .bind(&current.scope)
        .bind(cents)
        .bind(lowest.map_or(cents, |v| v.min(cents)))
        .bind(id)
        .execute(&mut *conn)
        .await?;
    Ok(())
}

pub(crate) fn start(pool: &SqlitePool, notifier: Arc<Notifier>) {
    let pool = pool.clone();
    tokio::spawn(async move {
        loop {
            if let Err(error) = deliver_one(&pool, &notifier).await {
                tracing::warn!(%error,"Notification queue operation failed");
            }
            tokio::time::sleep(Duration::from_secs(3)).await;
        }
    });
}

#[derive(FromRow)]
struct Outbox {
    id: i64,
    wish_id: Option<String>,
    scope: Option<String>,
    observed_at: i64,
    cents: Option<i64>,
    game: Option<String>,
    mode: Option<String>,
    basis: Option<String>,
    reference_cents: Option<i64>,
    shop: Option<String>,
    region: Option<String>,
    country: Option<String>,
    url: Option<String>,
}
impl Outbox {
    fn alert(&self) -> Alert {
        if self.wish_id.is_none() {
            return Alert::test();
        }
        Alert {
            event: if self.mode.as_deref() == Some("low") {
                Event::Low(self.reference_cents)
            } else {
                Event::Target(self.reference_cents)
            },
            game: self.game.clone().unwrap_or_default(),
            cents: self.cents.unwrap_or_default(),
            estimate: self.basis.as_deref() == Some("estimate"),
            shop: self.shop.clone(),
            region: self.region.clone(),
            country: self.country.clone(),
            url: self.url.clone(),
        }
    }
}

/// Process the next due alert: check that it is still true, create one delivery per active channel in the first
/// round, send every due delivery (each with its own attempts and backoff), then let the outbox row follow them.
async fn deliver_one(pool: &SqlitePool, notifier: &Notifier) -> anyhow::Result<()> {
    let t = now();
    let channels = notifier.active(pool).await?;
    if channels.is_empty() {
        return Ok(());
    }
    let lease = t + LEASE;
    let row: Option<Outbox> = sqlx::query_as("UPDATE alert_outbox SET lease_until=?
        WHERE id=(SELECT id FROM alert_outbox WHERE state='pending' AND due<=? AND lease_until<=?
        AND NOT EXISTS(SELECT 1 FROM alert_outbox WHERE state='pending' AND lease_until>?) ORDER BY due,id LIMIT 1)
        RETURNING id,wish_id,scope,observed_at,cents,game,mode,basis,reference_cents,shop,region,country,url")
        .bind(lease).bind(t).bind(t).bind(t).fetch_optional(pool).await?;
    let Some(row) = row else {
        return Ok(());
    };
    let valid = if let Some(id) = &row.wish_id {
        let mut conn = pool.acquire().await?;
        if let Some(rule) = rule(&mut conn, id).await?.filter(|r| r.enabled) {
            let current = check(&mut conn, id, &rule, None, t).await?;
            row.scope.as_deref() == Some(&current.scope)
                && current.best.zip(row.cents).is_some_and(|(best, recorded)| {
                    best.cents <= recorded && t - row.observed_at <= best.fresh_for
                })
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
    let mut outcomes = vec![];
    if valid {
        let fresh: bool = sqlx::query_scalar(
            "SELECT NOT EXISTS(SELECT 1 FROM channel_delivery WHERE outbox_id=?)",
        )
        .bind(row.id)
        .fetch_one(pool)
        .await?;
        if fresh {
            for (kind, _) in &channels {
                sqlx::query("INSERT INTO channel_delivery(outbox_id,channel,due) VALUES(?,?,?)")
                    .bind(row.id)
                    .bind(kind.id())
                    .bind(t)
                    .execute(pool)
                    .await?;
            }
        }
        let due: Vec<(String, i64)> = sqlx::query_as(
            "SELECT channel,attempts FROM channel_delivery WHERE outbox_id=? AND state='pending' AND due<=? ORDER BY rowid",
        )
        .bind(row.id)
        .bind(t)
        .fetch_all(pool)
        .await?;
        let alert = row.alert();
        for (channel, attempts) in due {
            let attempts = attempts + 1;
            let target = channels.iter().find(|(kind, _)| kind.id() == channel);
            // A channel switched off since the first round is skipped.
            let (state, error) = match target {
                None => ("cancelled", None),
                Some((_, target)) => match notifier.send(target, &alert).await {
                    Ok(()) => ("sent", None),
                    Err(reason) if attempts >= ATTEMPTS => ("failed", Some(reason)),
                    Err(reason) => ("pending", Some(reason)),
                },
            };
            sqlx::query("UPDATE channel_delivery SET state=?,attempts=?,due=?,sent_at=?,error=? WHERE outbox_id=? AND channel=? AND state='pending'")
                .bind(state).bind(attempts).bind(t + 60 * (1 << attempts.min(3))).bind((state == "sent").then_some(t))
                .bind(&error).bind(row.id).bind(&channel).execute(pool).await?;
            if let Some((kind, _)) = target {
                outcomes.push((*kind, state, error));
            }
        }
    } else {
        sqlx::query(
            "UPDATE channel_delivery SET state='cancelled' WHERE outbox_id=? AND state='pending'",
        )
        .bind(row.id)
        .execute(pool)
        .await?;
    }
    let mut tx = pool.begin().await?;
    let n = sqlx::query(
        "UPDATE alert_outbox SET lease_until=0,
        attempts=COALESCE((SELECT MAX(attempts) FROM channel_delivery WHERE outbox_id=?1),0),
        due=COALESCE((SELECT MIN(due) FROM channel_delivery WHERE outbox_id=?1 AND state='pending'),due),
        sent_at=(SELECT MAX(sent_at) FROM channel_delivery WHERE outbox_id=?1),
        state=CASE WHEN EXISTS(SELECT 1 FROM channel_delivery WHERE outbox_id=?1 AND state='pending') THEN 'pending'
            WHEN EXISTS(SELECT 1 FROM channel_delivery WHERE outbox_id=?1 AND state='sent') THEN 'sent'
            WHEN EXISTS(SELECT 1 FROM channel_delivery WHERE outbox_id=?1 AND state='failed') THEN 'failed'
            ELSE 'cancelled' END
        WHERE id=?1 AND state='pending' AND lease_until=?2",
    )
    .bind(row.id)
    .bind(lease)
    .execute(&mut *tx)
    .await?
    .rows_affected();
    if n > 0
        && outcomes.iter().any(|(_, state, _)| *state == "sent")
        && let Some(id) = &row.wish_id
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
    if outcomes.is_empty() {
        return Ok(());
    }
    let subject = match &row.wish_id {
        Some(id) => format!("Benachrichtigung für {}", eventlog::game(pool, id).await),
        None => "Testnachricht".into(),
    };
    for (kind, state, error) in outcomes {
        let name = kind.name();
        let reason = error.unwrap_or_default();
        let (level, message) = match state {
            "sent" => (Level::Info, format!("{subject} über {name} gesendet")),
            "failed" => (
                Level::Error,
                format!("{subject} über {name} konnte nicht zugestellt werden ({reason})"),
            ),
            _ => (
                Level::Warn,
                format!("{subject} über {name} fehlgeschlagen ({reason}), neuer Versuch folgt"),
            ),
        };
        eventlog::record(pool, level, Area::Alerts, message).await;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::notify::testing::{configure, mock, notifier, pool};

    /// One alert goes to every active channel; a failing channel retries on its own (three attempts, then failed)
    /// while the others are sent exactly once, and every outcome is logged per channel.
    #[tokio::test]
    async fn alarms_follow_fresh_prices_and_retry_per_channel() {
        let pool = pool().await;
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
        sqlx::query(
            "INSERT INTO wishlist_item(id,game_id,platform_id,created_at) VALUES('wish','g',169,0)",
        )
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query("INSERT INTO offer_link(id,wish_id,source,url,review) VALUES(1,'wish','eneba','https://www.eneba.com/de/xbox-game-key-global','confirmed')").execute(&pool).await.unwrap();
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
        async fn states(pool: &SqlitePool) -> (String, Vec<(String, String, i64)>) {
            let outbox =
                sqlx::query_scalar("SELECT state FROM alert_outbox ORDER BY id DESC LIMIT 1")
                    .fetch_one(pool)
                    .await
                    .unwrap();
            let deliveries = sqlx::query_as(
                "SELECT channel,state,attempts FROM channel_delivery ORDER BY rowid",
            )
            .fetch_all(pool)
            .await
            .unwrap();
            (outbox, deliveries)
        }
        async fn retry_now(pool: &SqlitePool) {
            sqlx::query("UPDATE alert_outbox SET due=0")
                .execute(pool)
                .await
                .unwrap();
            sqlx::query("UPDATE channel_delivery SET due=0")
                .execute(pool)
                .await
                .unwrap();
        }
        sample(&pool, &product, t, None).await;
        product.offers[0].cents = 2400;
        sample(&pool, &product, t + 1, Some("network")).await;
        assert_eq!(total(&pool).await, 0);
        sample(&pool, &product, t + 2, None).await;
        sample(&pool, &product, t + 3, None).await;
        assert_eq!(total(&pool).await, 1);

        let ntfy = mock(&[503, 503, 503]).await;
        let hook = mock(&[]).await;
        let dir = tempfile::tempdir().unwrap();
        let notifier = notifier(dir.path(), "http://127.0.0.1:9");
        // Nothing is sent and nothing is lost while no channel is active.
        deliver_one(&pool, &notifier).await.unwrap();
        assert_eq!(states(&pool).await, ("pending".into(), vec![]));
        configure(
            &notifier,
            &pool,
            Kind::Ntfy,
            json!({"enabled": true, "secrets": {"url": format!("{}/kh", ntfy.url)}}),
        )
        .await;
        configure(
            &notifier,
            &pool,
            Kind::Webhook,
            json!({"enabled": true, "secrets": {"url": format!("{}/hook", hook.url)}}),
        )
        .await;
        deliver_one(&pool, &notifier).await.unwrap();
        assert_eq!(
            states(&pool).await,
            (
                "pending".into(),
                vec![
                    ("ntfy".into(), "pending".into(), 1),
                    ("webhook".into(), "sent".into(), 1)
                ]
            )
        );
        let [first] = ntfy.take().try_into().ok().unwrap();
        assert_eq!(
            first.text(),
            "„Game“ ist bei deinem Wunschpreis angekommen: 24,00 € bei Eneba (Global, gültig in Deutschland). Ziel: 24,00 €."
        );
        assert_eq!(
            first.header("click"),
            "https://www.eneba.com/de/xbox-game-key-global"
        );
        let [sent] = hook.take().try_into().ok().unwrap();
        assert_eq!(sent.json()["game"], "Game");
        assert_eq!(sent.json()["shop"], "Eneba");
        assert_eq!(sent.json()["target_cents"], 2400);
        // The cooldown starts with the first channel that delivered.
        let last_sent: Option<i64> = sqlx::query_scalar("SELECT last_sent FROM alert_rule")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert!(last_sent.is_some());
        // Not due yet: no request at all.
        deliver_one(&pool, &notifier).await.unwrap();
        assert_eq!(ntfy.count() + hook.count(), 0);
        retry_now(&pool).await;
        deliver_one(&pool, &notifier).await.unwrap();
        retry_now(&pool).await;
        deliver_one(&pool, &notifier).await.unwrap();
        assert_eq!(ntfy.take().len(), 2);
        assert_eq!(hook.count(), 0, "the webhook got its message once");
        assert_eq!(
            states(&pool).await,
            (
                "sent".into(),
                vec![
                    ("ntfy".into(), "failed".into(), 3),
                    ("webhook".into(), "sent".into(), 1)
                ]
            )
        );
        let (attempts, error): (i64, Option<String>) =
            sqlx::query_as("SELECT o.attempts,d.error FROM alert_outbox o JOIN channel_delivery d ON d.outbox_id=o.id WHERE d.channel='ntfy'")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(
            (attempts, error.as_deref()),
            (3, Some("HTTP 503 · mock answer"))
        );
        retry_now(&pool).await;
        deliver_one(&pool, &notifier).await.unwrap();
        assert_eq!(ntfy.count(), 0, "a failed delivery stays failed");
        let log: Vec<(String, String)> = sqlx::query_as(
            "SELECT level,message FROM event_log WHERE area='Preisalarme' ORDER BY id",
        )
        .fetch_all(&pool)
        .await
        .unwrap();
        let log: Vec<(&str, &str)> = log.iter().map(|(l, m)| (l.as_str(), m.as_str())).collect();
        assert!(
            log.contains(&("info", "Benachrichtigung für „Game“ über Webhook gesendet")),
            "{log:?}"
        );
        assert!(log.contains(&("warn", "Benachrichtigung für „Game“ über ntfy fehlgeschlagen (HTTP 503 · mock answer), neuer Versuch folgt")));
        assert!(log.contains(&("error", "Benachrichtigung für „Game“ über ntfy konnte nicht zugestellt werden (HTTP 503 · mock answer)")));
        assert!(
            !format!("{log:?}").contains(&ntfy.url),
            "no channel address in the log"
        );

        sqlx::query("UPDATE alert_rule SET mode='low',target_cents=NULL,scope=NULL,previous_cents=NULL,lowest_cents=NULL").execute(&pool).await.unwrap();
        sample(&pool, &product, t + 4, None).await;
        assert_eq!(total(&pool).await, 1);
        product.offers[0].cents = 2300;
        sample(&pool, &product, t + 5, None).await;
        assert_eq!(total(&pool).await, 2);
        let (due, reference): (i64, Option<i64>) =
            sqlx::query_as("SELECT due,reference_cents FROM alert_outbox WHERE state='pending'")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert!(due >= t + COOLDOWN);
        assert_eq!(
            reference,
            Some(2400),
            "a new low names the lowest price before"
        );
        // A changed rule cancels the open alert and its deliveries.
        sqlx::query("INSERT INTO channel_delivery(outbox_id,channel,due) SELECT id,'webhook',0 FROM alert_outbox WHERE state='pending'")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("UPDATE alert_outbox SET state='cancelled' WHERE state='pending'")
            .execute(&pool)
            .await
            .unwrap();
        let open: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM channel_delivery WHERE state='pending'")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(open, 0);
    }

    /// FUNC-05: the delivery re-checks the freshness of its price with the link's own limit
    /// ([`crate::pricing::fresh_for`], twice the check interval, at least a day), not a fixed day.
    #[tokio::test]
    async fn delivery_keeps_a_price_that_is_fresh_for_the_interval_of_its_link() {
        const HOUR: i64 = 3600;
        // (check interval in hours, age of the observation in hours, delivered)
        for (interval, age, delivered) in [
            (72, 30, true),
            (72, 143, true),
            (72, 145, false),
            (8, 30, false),
        ] {
            let pool = pool().await;
            sqlx::query("UPDATE app_settings SET target_country='DE'")
                .execute(&pool)
                .await
                .unwrap();
            sqlx::query("UPDATE source_settings SET poll_interval_seconds=? WHERE id='eneba'")
                .bind(interval * HOUR)
                .execute(&pool)
                .await
                .unwrap();
            sqlx::query("INSERT INTO game(id,manual_title,manual_key,created_at) VALUES('g','Game','game',0)").execute(&pool).await.unwrap();
            sqlx::query("INSERT INTO wishlist_item(id,game_id,platform_id,created_at) VALUES('wish','g',169,0)").execute(&pool).await.unwrap();
            sqlx::query("INSERT INTO offer_link(id,wish_id,source,url,review) VALUES(1,'wish','eneba','https://www.eneba.com/de/xbox-game-key-global','confirmed')").execute(&pool).await.unwrap();
            sqlx::query("INSERT INTO shop_job(source,link_id,due) VALUES('eneba',1,0)")
                .execute(&pool)
                .await
                .unwrap();
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
            // The alert arises when the price drops (observed `age` hours ago) and is delivered now.
            let t = now() - age * HOUR;
            for (offset, cents) in [(0, 2600), (2, 2400), (3, 2400)] {
                product.offers[0].cents = cents;
                let mut tx = pool.begin().await.unwrap();
                sqlx::query(
                    "UPDATE offer_link SET fingerprint=?,latest=?,observed_at=? WHERE id=1",
                )
                .bind(product.fingerprint())
                .bind(serde_json::to_string(&product).unwrap())
                .bind(t + offset)
                .execute(&mut *tx)
                .await
                .unwrap();
                observe(&mut tx, "wish", 1, t + offset).await.unwrap();
                tx.commit().await.unwrap();
            }
            let hook = mock(&[]).await;
            let dir = tempfile::tempdir().unwrap();
            let notifier = notifier(dir.path(), "http://127.0.0.1:9");
            configure(
                &notifier,
                &pool,
                Kind::Webhook,
                json!({"enabled": true, "secrets": {"url": format!("{}/hook", hook.url)}}),
            )
            .await;
            deliver_one(&pool, &notifier).await.unwrap();
            assert_eq!(
                hook.count(),
                usize::from(delivered),
                "interval {interval} h, observed {age} h ago"
            );
        }
    }

    /// The test message of the alert page takes the outbox to every active channel.
    #[tokio::test]
    async fn the_queued_test_message_reaches_every_active_channel() {
        let pool = pool().await;
        let hook = mock(&[]).await;
        let dir = tempfile::tempdir().unwrap();
        let notifier = notifier(dir.path(), "http://127.0.0.1:9");
        configure(
            &notifier,
            &pool,
            Kind::Webhook,
            json!({"enabled": true, "secrets": {"url": format!("{}/hook", hook.url)}}),
        )
        .await;
        sqlx::query("INSERT INTO alert_outbox(observed_at,due) VALUES(?,0)")
            .bind(now())
            .execute(&pool)
            .await
            .unwrap();
        deliver_one(&pool, &notifier).await.unwrap();
        let [request] = hook.take().try_into().ok().unwrap();
        assert_eq!(request.json()["event"], "test");
        let state: String = sqlx::query_scalar("SELECT state FROM alert_outbox")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(state, "sent");
    }
}
