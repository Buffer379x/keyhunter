use crate::extract::ApiJson;
use crate::{ApiError, ApiResult, Shared};
use axum::{Json, extract::State, http::StatusCode};
use serde::{Deserialize, Serialize};
use sqlx::Row;

// ISO 3166-1 alpha-2 codes; labels are localized in the browser.
const COUNTRY_CODES: &str = "AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW";

pub(crate) fn valid_country(code: &str) -> bool {
    COUNTRY_CODES.split_whitespace().any(|v| v == code)
}

#[derive(Serialize, Deserialize)]
pub(crate) struct SourceSettings {
    id: String,
    kind: String,
    enabled: bool,
    fee_estimation_enabled: bool,
    fee_basis_points: i64,
    #[serde(default = "default_configured")]
    configured: bool,
    #[serde(default = "default_interval")]
    poll_interval_seconds: i64,
    /// Shops only: effective daily job budget. On PUT, null, an absent value or the default
    /// clears the setting, so the shop follows `daily_jobs_default` again.
    #[serde(default)]
    daily_jobs: Option<i64>,
    /// Shops only, read-only: `KEYHUNTER_SHOP_DAILY_JOBS` if valid, else 500.
    #[serde(default)]
    daily_jobs_default: Option<i64>,
}
fn default_configured() -> bool {
    true
}
fn default_interval() -> i64 {
    28800
}

/// Columns of the wishlist table in their default order; the settings store any permutation of them.
const WISHLIST_COLUMNS: [&str; 8] = [
    "game", "price", "world", "save", "target", "status", "trend", "open",
];

/// Columns of the offers table (0.8.2); the actions ("Zum Shop", cart) always stay last and are not listed.
const OFFERS_COLUMNS: [&str; 7] = [
    "shop", "region", "validity", "price", "diff", "score", "seen",
];
/// The price column cannot be hidden: without it the table has no purpose.
const OFFERS_REQUIRED: &str = "price";

fn is_column_order(columns: &[String]) -> bool {
    is_order_of(columns, &WISHLIST_COLUMNS)
}
/// Every known column exactly once.
fn is_order_of(columns: &[String], known: &[&str]) -> bool {
    columns.len() == known.len()
        && known
            .iter()
            .all(|key| columns.iter().filter(|c| c == key).count() == 1)
}
/// Hidden offers columns: known ones, each once, never the price.
fn valid_offers_hidden(hidden: &[String]) -> bool {
    hidden.iter().enumerate().all(|(i, key)| {
        OFFERS_COLUMNS.contains(&key.as_str())
            && key != OFFERS_REQUIRED
            && !hidden[..i].contains(key)
    })
}
/// The stored offers order, or the default one.
fn offers_order(stored: &str) -> Vec<String> {
    let columns: Vec<String> = stored.split(',').map(str::to_string).collect();
    if is_order_of(&columns, &OFFERS_COLUMNS) {
        columns
    } else {
        OFFERS_COLUMNS.iter().map(|c| c.to_string()).collect()
    }
}

/// Hidden columns are known columns, each once. The column that opens the game page cannot be hidden: the details
/// button (`open`) with the "button" mode, the game column (title and cover) with "title" or "cover".
fn valid_hidden(hidden: &[String], open: &str) -> bool {
    let opener = if open == "button" { "open" } else { "game" };
    hidden.iter().enumerate().all(|(i, key)| {
        WISHLIST_COLUMNS.contains(&key.as_str()) && key != opener && !hidden[..i].contains(key)
    })
}

/// The stored order, or the default order when nothing (or an outdated list) is stored.
fn column_order(stored: &str) -> Vec<String> {
    let columns: Vec<String> = stored.split(',').map(str::to_string).collect();
    if is_column_order(&columns) {
        columns
    } else {
        WISHLIST_COLUMNS.iter().map(|c| c.to_string()).collect()
    }
}
#[derive(Serialize, Deserialize)]
pub(crate) struct Settings {
    target_country: Option<String>,
    currency: String,
    /// Order of the wishlist table columns. Absent on PUT keeps the stored order.
    #[serde(default)]
    wishlist_columns: Option<Vec<String>>,
    /// Hidden wishlist columns (0.7.1). Absent on PUT keeps the stored set.
    #[serde(default)]
    wishlist_hidden: Option<Vec<String>>,
    /// What opens the game page from the list: "button", "title" or "cover" (0.7.1). Absent on PUT keeps it.
    #[serde(default)]
    wishlist_open: Option<String>,
    /// Price-change arrows (1.1.3): "price" follows the price (green down = cheaper), "rating" says better or worse (green
    /// up = cheaper). Absent on PUT keeps it.
    #[serde(default)]
    trend_arrows: Option<String>,
    /// Order and hidden columns of the offers table (0.8.2). Absent on PUT keeps the stored ones.
    #[serde(default)]
    offers_columns: Option<Vec<String>>,
    #[serde(default)]
    offers_hidden: Option<Vec<String>>,
    sources: Vec<SourceSettings>,
    #[serde(default)]
    countries: Vec<String>,
    #[serde(default)]
    confirmed_activation_countries: Vec<String>,
}

async fn load(state: &Shared) -> ApiResult<Settings> {
    let row = sqlx::query(
        "SELECT target_country, currency, wishlist_columns, wishlist_hidden, wishlist_open, trend_arrows, offers_columns, offers_hidden FROM app_settings WHERE id = 1",
    )
    .fetch_one(&state.pool)
    .await?;
    let rows = sqlx::query("SELECT * FROM source_settings ORDER BY CASE id WHEN 'eneba' THEN 0 WHEN 'igdb' THEN 1 ELSE 2 END,id").fetch_all(&state.pool).await?;
    Ok(Settings {
        target_country: row.get("target_country"),
        currency: row.get("currency"),
        wishlist_columns: Some(column_order(row.get("wishlist_columns"))),
        wishlist_hidden: Some(
            row.get::<String, _>("wishlist_hidden")
                .split(',')
                .filter(|key| WISHLIST_COLUMNS.contains(key))
                .map(str::to_string)
                .collect(),
        ),
        wishlist_open: Some(row.get("wishlist_open")),
        trend_arrows: Some(row.get("trend_arrows")),
        offers_columns: Some(offers_order(row.get("offers_columns"))),
        offers_hidden: Some(
            row.get::<String, _>("offers_hidden")
                .split(',')
                .filter(|key| OFFERS_COLUMNS.contains(key) && *key != OFFERS_REQUIRED)
                .map(str::to_string)
                .collect(),
        ),
        sources: rows
            .into_iter()
            .map(|r| {
                let shop = r.get::<String, _>("kind") == "shop";
                SourceSettings {
                    id: r.get("id"),
                    kind: r.get("kind"),
                    enabled: r.get("enabled"),
                    fee_estimation_enabled: r.get("fee_estimation_enabled"),
                    fee_basis_points: r.get("fee_basis_points"),
                    configured: r.get("configured"),
                    poll_interval_seconds: r.get("poll_interval_seconds"),
                    daily_jobs: shop.then(|| crate::jobs::budget::daily_limit(r.get("daily_jobs"))),
                    daily_jobs_default: shop.then(crate::jobs::budget::daily_budget),
                }
            })
            .collect(),
        countries: COUNTRY_CODES
            .split_whitespace()
            .map(str::to_string)
            .collect(),
        // Countries whose offers can count in the target country: the EU market the shops are read in (0.9.0).
        confirmed_activation_countries: crate::pricing::EU.iter().map(|c| c.to_string()).collect(),
    })
}

pub(crate) async fn get_settings(State(state): State<Shared>) -> ApiResult<Json<Settings>> {
    Ok(Json(load(&state).await?))
}

pub(crate) async fn put_settings(
    State(state): State<Shared>,
    ApiJson(input): ApiJson<Settings>,
) -> ApiResult<Json<Settings>> {
    let bad = || {
        ApiError(
            StatusCode::BAD_REQUEST,
            "Ungültige Einstellungen. Land, Gebühren (0–100 %) und Tagesbudget (20–2000 Abrufe) prüfen.",
        )
    };
    if input.currency != "EUR"
        || input
            .target_country
            .as_ref()
            .is_some_and(|c| !valid_country(c))
        || input
            .wishlist_columns
            .as_ref()
            .is_some_and(|columns| !is_column_order(columns))
        || input
            .wishlist_open
            .as_deref()
            .is_some_and(|open| !matches!(open, "button" | "title" | "cover"))
        || input
            .trend_arrows
            .as_deref()
            .is_some_and(|arrows| !matches!(arrows, "price" | "rating"))
        || input
            .offers_columns
            .as_ref()
            .is_some_and(|columns| !is_order_of(columns, &OFFERS_COLUMNS))
        || input
            .offers_hidden
            .as_ref()
            .is_some_and(|hidden| !valid_offers_hidden(hidden))
    {
        return Err(bad());
    }
    if !(2..=3).contains(&input.sources.len()) {
        return Err(bad());
    }
    for (id, kind) in [("eneba", "shop"), ("igdb", "catalog"), ("driffle", "shop")] {
        let matches: Vec<_> = input.sources.iter().filter(|s| s.id == id).collect();
        if id == "driffle" && input.sources.len() == 2 && matches.is_empty() {
            continue;
        }
        if matches.len() != 1 {
            return Err(bad());
        }
        let s = matches[0];
        if s.kind != kind
            || !(0..=10000).contains(&s.fee_basis_points)
            || !(900..=604800).contains(&s.poll_interval_seconds)
            || (kind == "catalog" && (s.fee_estimation_enabled || s.fee_basis_points != 0))
            || (kind == "catalog" && s.daily_jobs.is_some())
            || stored_daily_jobs(s).is_some_and(|v| !crate::jobs::DAILY_JOBS_SETTING.contains(&v))
        {
            return Err(bad());
        }
    }
    let (stored_hidden, stored_open): (String, String) =
        sqlx::query_as("SELECT wishlist_hidden, wishlist_open FROM app_settings WHERE id = 1")
            .fetch_one(&state.pool)
            .await?;
    let open = input.wishlist_open.clone().unwrap_or(stored_open);
    let hidden: Vec<String> = input.wishlist_hidden.clone().unwrap_or_else(|| {
        stored_hidden
            .split(',')
            .filter(|key| !key.is_empty())
            .map(str::to_string)
            .collect()
    });
    if !valid_hidden(&hidden, &open) {
        return Err(bad());
    }
    let mut tx = state.pool.begin().await?;
    sqlx::query("UPDATE app_settings SET wishlist_hidden = ?, wishlist_open = ? WHERE id = 1")
        .bind(hidden.join(","))
        .bind(&open)
        .execute(&mut *tx)
        .await?;
    // The column wishlist_price_scope stays in the schema unread: the wishlist shows the target-country price and the
    // cheapest region side by side since 0.6.1 (CODE-05).
    sqlx::query("UPDATE app_settings SET target_country = ? WHERE id = 1")
        .bind(input.target_country)
        .execute(&mut *tx)
        .await?;
    if let Some(columns) = &input.offers_columns {
        sqlx::query("UPDATE app_settings SET offers_columns = ? WHERE id = 1")
            .bind(columns.join(","))
            .execute(&mut *tx)
            .await?;
    }
    if let Some(hidden) = &input.offers_hidden {
        sqlx::query("UPDATE app_settings SET offers_hidden = ? WHERE id = 1")
            .bind(hidden.join(","))
            .execute(&mut *tx)
            .await?;
    }
    if let Some(arrows) = &input.trend_arrows {
        sqlx::query("UPDATE app_settings SET trend_arrows = ? WHERE id = 1")
            .bind(arrows)
            .execute(&mut *tx)
            .await?;
    }
    if let Some(columns) = &input.wishlist_columns {
        sqlx::query("UPDATE app_settings SET wishlist_columns = ? WHERE id = 1")
            .bind(columns.join(","))
            .execute(&mut *tx)
            .await?;
    }
    for source in input.sources {
        let (previous, previous_jobs): (i64, Option<i64>) = sqlx::query_as(
            "SELECT poll_interval_seconds,daily_jobs FROM source_settings WHERE id=?",
        )
        .bind(&source.id)
        .fetch_one(&mut *tx)
        .await?;
        let daily_jobs = stored_daily_jobs(&source);
        // Shops are always listed since 0.7.4 (migration 0021); only "Aktiv" (enabled) switches them.
        sqlx::query("UPDATE source_settings SET enabled=?,fee_estimation_enabled=?,fee_basis_points=?,configured=CASE WHEN kind='shop' THEN 1 ELSE ? END,poll_interval_seconds=?,daily_jobs=? WHERE id=?")
            .bind(source.enabled).bind(source.fee_estimation_enabled).bind(source.fee_basis_points)
            .bind(source.configured).bind(source.poll_interval_seconds).bind(daily_jobs).bind(&source.id).execute(&mut *tx).await?;
        if previous_jobs != daily_jobs {
            // The next paced job follows the new budget at once instead of the old slot.
            sqlx::query("UPDATE shop_state SET paced_until=0 WHERE source=?")
                .bind(&source.id)
                .execute(&mut *tx)
                .await?;
        }
        if previous != source.poll_interval_seconds {
            // Same rule as the scheduler (jobs::trend::effective_interval, without the preview factor): the interval times
            // the price-trend pace, at most a week.
            sqlx::query(
            "UPDATE shop_job SET due=MAX(?,(SELECT observed_at FROM offer_link WHERE id=link_id)
                +MIN(604800,CAST(ROUND(?*pace) AS INTEGER)))
            WHERE source=? AND link_id IS NOT NULL AND failures=0 AND lease_until<=?
            AND last_error IS NULL AND (SELECT observed_at FROM offer_link WHERE id=link_id) IS NOT NULL",
        )
        .bind(crate::now())
        .bind(source.poll_interval_seconds)
        .bind(&source.id)
        .bind(crate::now())
        .execute(&mut *tx)
        .await?;
        }
    }
    tx.commit().await?;
    log(&state, "Einstellungen gespeichert").await;
    Ok(Json(load(&state).await?))
}

async fn log(state: &Shared, message: &str) {
    crate::eventlog::record(
        &state.pool,
        crate::eventlog::Level::Info,
        crate::eventlog::Area::Settings,
        message,
    )
    .await;
}

/// The value to store for `daily_jobs`: NULL when absent or equal to the operator default.
fn stored_daily_jobs(source: &SourceSettings) -> Option<i64> {
    source
        .daily_jobs
        .filter(|v| *v != crate::jobs::budget::daily_budget())
}

pub(crate) async fn put_igdb_credentials(
    State(state): State<Shared>,
    input: Result<
        Json<crate::catalog::provider::IgdbCredentials>,
        axum::extract::rejection::JsonRejection,
    >,
) -> ApiResult<StatusCode> {
    let Json(input) = input.map_err(|_| {
        ApiError(
            StatusCode::BAD_REQUEST,
            "Gib Client-ID und Client Secret ein.",
        )
    })?;
    state.catalog.update_credentials(Some(input)).await.map_err(|error| match error {
        crate::catalog::provider::CatalogError::InvalidCredentials => ApiError(
            StatusCode::UNPROCESSABLE_ENTITY,
            "Client-ID und Client Secret sind ungültig oder wurden von Twitch abgewiesen.",
        ),
        crate::catalog::provider::CatalogError::Storage => ApiError(
            StatusCode::INTERNAL_SERVER_ERROR,
            "IGDB-Zugang konnte nicht gespeichert werden. Prüfe den Schreibzugriff auf das Datenverzeichnis.",
        ),
        error => crate::catalog::provider_error(error),
    })?;
    log(&state, "IGDB-Zugang gespeichert").await;
    Ok(StatusCode::NO_CONTENT)
}

pub(crate) async fn delete_igdb_credentials(State(state): State<Shared>) -> ApiResult<StatusCode> {
    state
        .catalog
        .update_credentials(None)
        .await
        .map_err(crate::catalog::provider_error)?;
    log(&state, "IGDB-Zugang entfernt").await;
    Ok(StatusCode::NO_CONTENT)
}
