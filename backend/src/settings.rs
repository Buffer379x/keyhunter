use crate::{ApiError, ApiResult, Shared, auth};
use axum::{
    Json,
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
};
use serde::{Deserialize, Serialize};
use sqlx::Row;

// ISO 3166-1 alpha-2 codes; labels are localized in the browser.
const COUNTRY_CODES: &str = "AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW";

pub(crate) fn valid_country(code: &str) -> bool {
    COUNTRY_CODES.split_whitespace().any(|v| v == code)
}

// Countries whose activation the shop readers can currently confirm.
const CONFIRMED_ACTIVATION_COUNTRIES: [&str; 1] = ["DE"];

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

fn is_column_order(columns: &[String]) -> bool {
    columns.len() == WISHLIST_COLUMNS.len()
        && WISHLIST_COLUMNS
            .iter()
            .all(|key| columns.iter().filter(|c| c == key).count() == 1)
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
    #[serde(default = "default_price_scope")]
    wishlist_price_scope: String,
    /// Order of the wishlist table columns. Absent on PUT keeps the stored order.
    #[serde(default)]
    wishlist_columns: Option<Vec<String>>,
    sources: Vec<SourceSettings>,
    #[serde(default)]
    countries: Vec<String>,
    #[serde(default)]
    confirmed_activation_countries: Vec<String>,
}

fn default_price_scope() -> String {
    "preferred".into()
}

async fn load(state: &Shared) -> ApiResult<Settings> {
    let row = sqlx::query(
        "SELECT target_country, currency, wishlist_price_scope, wishlist_columns FROM app_settings WHERE id = 1",
    )
    .fetch_one(&state.pool)
    .await?;
    let rows = sqlx::query("SELECT * FROM source_settings ORDER BY CASE id WHEN 'eneba' THEN 0 WHEN 'igdb' THEN 1 ELSE 2 END,id").fetch_all(&state.pool).await?;
    Ok(Settings {
        target_country: row.get("target_country"),
        currency: row.get("currency"),
        wishlist_price_scope: row.get("wishlist_price_scope"),
        wishlist_columns: Some(column_order(row.get("wishlist_columns"))),
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
                    daily_jobs: shop.then(|| crate::jobs::daily_limit(r.get("daily_jobs"))),
                    daily_jobs_default: shop.then(crate::jobs::daily_budget),
                }
            })
            .collect(),
        countries: COUNTRY_CODES
            .split_whitespace()
            .map(str::to_string)
            .collect(),
        confirmed_activation_countries: CONFIRMED_ACTIVATION_COUNTRIES
            .iter()
            .map(|c| c.to_string())
            .collect(),
    })
}

pub(crate) async fn get_settings(
    State(state): State<Shared>,
    headers: HeaderMap,
) -> ApiResult<Json<Settings>> {
    auth::authenticate(&state, &headers).await?;
    Ok(Json(load(&state).await?))
}

pub(crate) async fn put_settings(
    State(state): State<Shared>,
    headers: HeaderMap,
    Json(input): Json<Settings>,
) -> ApiResult<Json<Settings>> {
    let session = auth::authenticate(&state, &headers).await?;
    auth::require_csrf(&state, &headers, &session)?;
    let bad = || {
        ApiError(
            StatusCode::BAD_REQUEST,
            "Ungültige Einstellungen. Land, Gebühren (0–100 %) und Tagesbudget (20–2000 Abrufe) prüfen.",
        )
    };
    if !matches!(input.wishlist_price_scope.as_str(), "preferred" | "all")
        || input.currency != "EUR"
        || input
            .target_country
            .as_ref()
            .is_some_and(|c| !valid_country(c))
        || input
            .wishlist_columns
            .as_ref()
            .is_some_and(|columns| !is_column_order(columns))
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
    let mut tx = state.pool.begin().await?;
    sqlx::query(
        "UPDATE app_settings SET target_country = ?, wishlist_price_scope = ? WHERE id = 1",
    )
    .bind(input.target_country)
    .bind(input.wishlist_price_scope)
    .execute(&mut *tx)
    .await?;
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
        sqlx::query("UPDATE source_settings SET enabled=?,fee_estimation_enabled=?,fee_basis_points=?,configured=?,poll_interval_seconds=?,daily_jobs=? WHERE id=?")
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
            // Same rule as the scheduler (jobs::effective_interval, without the preview factor): the interval times
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
    Ok(Json(load(&state).await?))
}

/// The value to store for `daily_jobs`: NULL when absent or equal to the operator default.
fn stored_daily_jobs(source: &SourceSettings) -> Option<i64> {
    source
        .daily_jobs
        .filter(|v| *v != crate::jobs::daily_budget())
}

#[derive(Deserialize)]
pub(crate) struct RegisterShop {
    url: String,
}

pub(crate) async fn shop_readers(
    State(state): State<Shared>,
    headers: HeaderMap,
) -> ApiResult<Json<serde_json::Value>> {
    auth::authenticate(&state, &headers).await?;
    Ok(Json(serde_json::json!([
        {"id":"eneba","name":"Eneba","url":"https://www.eneba.com","recommended_interval_seconds":28800},
        {"id":"driffle","name":"Driffle","url":"https://driffle.com","recommended_interval_seconds":28800}
    ])))
}

pub(crate) async fn register_shop(
    State(state): State<Shared>,
    headers: HeaderMap,
    Json(input): Json<RegisterShop>,
) -> ApiResult<Json<Settings>> {
    let session = auth::authenticate(&state, &headers).await?;
    auth::require_csrf(&state, &headers, &session)?;
    let url = url::Url::parse(input.url.trim()).ok();
    let shop=url.filter(|u|u.scheme()=="https" && u.username().is_empty() && u.password().is_none()
        && u.port().is_none() && u.query().is_none() && u.fragment().is_none() && u.path()=="/")
        .and_then(|u|match u.host_str()? { "www.eneba.com"|"eneba.com"=>Some("eneba"),"driffle.com"=>Some("driffle"),_=>None })
        .ok_or(ApiError(StatusCode::UNPROCESSABLE_ENTITY,"Für diese Shop-URL ist kein geprüfter Reader verfügbar. Unterstützt werden Eneba und Driffle (HTTPS)."))?;
    let added = sqlx::query(
        "UPDATE source_settings SET configured=1,enabled=1 WHERE id=? AND configured=0",
    )
    .bind(shop)
    .execute(&state.pool)
    .await?
    .rows_affected();
    if added == 0 {
        return Err(ApiError(
            StatusCode::CONFLICT,
            "Dieser Dienst ist bereits hinzugefügt.",
        ));
    }
    Ok(Json(load(&state).await?))
}

pub(crate) async fn unregister_shop(
    State(state): State<Shared>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> ApiResult<Json<Settings>> {
    let session = auth::authenticate(&state, &headers).await?;
    auth::require_csrf(&state, &headers, &session)?;
    if crate::shops::Shop::from_id(&id).is_none() {
        return Err(ApiError(StatusCode::NOT_FOUND, "Key-Shop nicht gefunden."));
    }
    sqlx::query("UPDATE source_settings SET configured=0,enabled=0 WHERE id=?")
        .bind(id)
        .execute(&state.pool)
        .await?;
    Ok(Json(load(&state).await?))
}

pub(crate) async fn put_igdb_credentials(
    State(state): State<Shared>,
    headers: HeaderMap,
    input: Result<
        Json<crate::catalog::provider::IgdbCredentials>,
        axum::extract::rejection::JsonRejection,
    >,
) -> ApiResult<StatusCode> {
    let session = auth::authenticate(&state, &headers).await?;
    auth::require_csrf(&state, &headers, &session)?;
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
    Ok(StatusCode::NO_CONTENT)
}

pub(crate) async fn delete_igdb_credentials(
    State(state): State<Shared>,
    headers: HeaderMap,
) -> ApiResult<StatusCode> {
    let session = auth::authenticate(&state, &headers).await?;
    auth::require_csrf(&state, &headers, &session)?;
    state
        .catalog
        .update_credentials(None)
        .await
        .map_err(crate::catalog::provider_error)?;
    Ok(StatusCode::NO_CONTENT)
}
