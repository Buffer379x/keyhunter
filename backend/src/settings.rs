use crate::{ApiError, ApiResult, Shared, auth};
use axum::{
    Json,
    extract::State,
    http::{HeaderMap, StatusCode},
};
use serde::{Deserialize, Serialize};
use sqlx::Row;

// ISO 3166-1 alpha-2 codes; labels are localized in the browser.
const COUNTRY_CODES: &str = "AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW";

#[derive(Serialize, Deserialize)]
pub(crate) struct SourceSettings {
    id: String,
    kind: String,
    enabled: bool,
    fee_estimation_enabled: bool,
    fee_basis_points: i64,
}
#[derive(Serialize, Deserialize)]
pub(crate) struct Settings {
    target_country: Option<String>,
    currency: String,
    sources: Vec<SourceSettings>,
    #[serde(default)]
    countries: Vec<String>,
}

async fn load(state: &Shared) -> ApiResult<Settings> {
    let row = sqlx::query("SELECT target_country, currency FROM app_settings WHERE id = 1")
        .fetch_one(&state.pool)
        .await?;
    let rows = sqlx::query("SELECT id, kind, enabled, fee_estimation_enabled, fee_basis_points FROM source_settings ORDER BY CASE id WHEN 'eneba' THEN 0 WHEN 'igdb' THEN 1 ELSE 2 END,id").fetch_all(&state.pool).await?;
    Ok(Settings {
        target_country: row.get("target_country"),
        currency: row.get("currency"),
        sources: rows
            .into_iter()
            .map(|r| SourceSettings {
                id: r.get("id"),
                kind: r.get("kind"),
                enabled: r.get("enabled"),
                fee_estimation_enabled: r.get("fee_estimation_enabled"),
                fee_basis_points: r.get("fee_basis_points"),
            })
            .collect(),
        countries: COUNTRY_CODES
            .split_whitespace()
            .map(str::to_string)
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
            "Ungültige Einstellungen. Land und Gebühren (0–100 %) prüfen.",
        )
    };
    if input.currency != "EUR"
        || input
            .target_country
            .as_ref()
            .is_some_and(|c| !COUNTRY_CODES.split_whitespace().any(|v| v == c))
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
            || (kind == "catalog" && (s.fee_estimation_enabled || s.fee_basis_points != 0))
        {
            return Err(bad());
        }
    }
    let mut tx = state.pool.begin().await?;
    sqlx::query("UPDATE app_settings SET target_country = ? WHERE id = 1")
        .bind(input.target_country)
        .execute(&mut *tx)
        .await?;
    for source in input.sources {
        sqlx::query("UPDATE source_settings SET enabled = ?, fee_estimation_enabled = ?, fee_basis_points = ? WHERE id = ?")
            .bind(source.enabled).bind(source.fee_estimation_enabled).bind(source.fee_basis_points).bind(source.id).execute(&mut *tx).await?;
    }
    tx.commit().await?;
    Ok(Json(load(&state).await?))
}
