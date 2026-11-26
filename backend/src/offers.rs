use crate::extract::{ApiJson, ApiPath};
use crate::{
    ApiError, ApiResult, Shared,
    eventlog::{self, Area, Level},
    internal, now, pricing,
    shops::{self, Product, Shop, title_key},
};
use axum::{Json, extract::State, http::StatusCode};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::{AssertSqlSafe, FromRow, SqlitePool};
use std::collections::BTreeMap;

const BAD_URL: ApiError = ApiError(
    StatusCode::BAD_REQUEST,
    "Gib eine öffentliche Xbox-Key-Produktseite eines unterstützten Shops ein.",
);
const NOT_FOUND: ApiError = ApiError(StatusCode::NOT_FOUND, "Wunsch oder Angebot nicht gefunden.");
const CONFLICT: ApiError = ApiError(
    StatusCode::CONFLICT,
    "Titel, Edition, Produkttyp und Xbox-Plattform müssen übereinstimmen.",
);

#[derive(FromRow)]
pub(crate) struct Wish {
    platform_id: i64,
    manual_title: Option<String>,
    payload: Option<String>,
}

/// Why a shop product does not match a wish plainly (FUNC-01, FUNC-04), for the review dialog.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum Mismatch {
    /// Neither the catalog title (or an alias) nor its standard edition.
    Title,
    /// Not a key for the wish's system; see [`Wish::takes_key`] for the ones the owner may still confirm.
    Platform,
    /// The shop names no platform (1.1.5); the owner may confirm it.
    PlatformUnknown,
    /// Not an activation code (an account, a gift, a top-up).
    KeyType,
    /// Possibly a same-titled game of another release year: the catalog knows one on the product's platform, or the
    /// key is an Xbox One key for an older system ([`Wish::same_release`]).
    Year,
}

/// Another catalog game a shop title could belong to (FUNC-01): its title keys, release year and platforms.
pub(crate) struct Peer {
    keys: Vec<String>,
    year: Option<i64>,
    platforms: Vec<i64>,
}

const XBOX_ONE: i64 = 49;
const XBOX_SERIES: i64 = 169;

/// Calendar year (UTC) of a Unix time; IGDB release dates are Unix times.
fn year(seconds: i64) -> i64 {
    crate::wishlist::civil(seconds).0
}

/// The exact title keys of a catalog game: its name, and for a base game its standard edition.
fn name_keys(game: &crate::catalog::provider::CatalogGame) -> Vec<String> {
    let name = title_key(&game.name);
    let mut keys = vec![name.clone()];
    if game.kind == "base_game" {
        keys.push(format!("{name} standard edition"));
        keys.push(format!("{name} standard"));
    }
    keys
}

impl Wish {
    pub(crate) fn from_parts(
        platform_id: i64,
        manual_title: Option<String>,
        payload: Option<String>,
    ) -> Self {
        Self {
            platform_id,
            manual_title,
            payload,
        }
    }

    fn game(&self) -> Option<crate::catalog::provider::CatalogGame> {
        serde_json::from_str(self.payload.as_ref()?).ok()
    }

    pub(crate) fn keys(&self) -> Vec<String> {
        let Some(game) = self.game() else {
            return self.manual_title.iter().map(|s| title_key(s)).collect();
        };
        if !game.selection_allowed() || !game.platforms.iter().any(|p| p.id == self.platform_id) {
            return vec![];
        }
        let mut keys = vec![title_key(&game.name)];
        if game.kind != "edition" {
            keys.extend(game.aliases.iter().map(|alias| title_key(alias)));
            if game.kind == "base_game" {
                keys.push(format!("{} standard edition", keys[0]));
                keys.push(format!("{} standard", keys[0]));
            }
        }
        keys
    }

    /// Confirmed without the owner: the catalog title (or its standard edition), a key game, exactly the wish's
    /// platform, and no same-titled game of another year in the catalog ([`Self::same_release`], FUNC-01, 0.9.3).
    pub(crate) fn auto_matches(&self, product: &Product, peers: &[Peer]) -> bool {
        self.game().is_some_and(|game| {
            game.selection_allowed()
                && game.platforms.iter().any(|p| p.id == self.platform_id)
                && name_keys(&game).contains(&title_key(&product.title))
        }) && product.key_game
            && product.platform_ids.contains(&self.platform_id)
            && self.same_release(product, peers)
    }

    /// A product the owner may confirm: same title, a key game, for the wish's system. A wish for the Xbox 360 or the
    /// original Xbox also takes an Xbox One key (0.8.2): shops sell those classics as backward-compatible Xbox Live keys.
    /// Such a match is never confirmed automatically ([`Self::auto_matches`] stays exact), the owner checks it once.
    pub(crate) fn matches(&self, product: &Product) -> bool {
        product.key_game && self.platform_matches(product) && self.title_matches(product)
    }

    fn platform_matches(&self, product: &Product) -> bool {
        product.platform_ids.contains(&self.platform_id)
            || (matches!(self.platform_id, 12 | 11) && product.platform_ids.contains(&XBOX_ONE))
    }

    fn title_matches(&self, product: &Product) -> bool {
        self.keys().contains(&title_key(&product.title))
    }

    /// An Xbox activation code the wish's system can use (FUNC-04, 0.9.3): the wish's platform, or an Xbox One key for
    /// an Xbox 360, original Xbox or Series X|S wish (backward compatible), or a key the shop names no platform for (1.1.5). Nothing else ever counts as a key price,
    /// not even confirmed by hand: accounts, gifts, PC-only products, Series-only keys for older systems.
    pub(crate) fn takes_key(&self, product: &Product) -> bool {
        product.key_game
            && (self.platform_matches(product)
                || (self.platform_id == XBOX_SERIES && product.platform_ids.contains(&XBOX_ONE))
                || product.platform_unknown)
    }

    /// The product is the wished release and not a same-titled game of another year (FUNC-01, 0.9.3). The shops name no
    /// release year, so the catalog decides: another catalog game with the product's title on one of its platforms,
    /// released more than a year apart (or without a known date), makes the title ambiguous ("Doom" 1993 and 2016). An
    /// Xbox One key for an Xbox 360 or original Xbox wish may always be a newer game of the same name.
    pub(crate) fn same_release(&self, product: &Product, peers: &[Peer]) -> bool {
        if !product.platform_ids.contains(&self.platform_id) {
            return false;
        }
        let wished = self
            .game()
            .and_then(|game| game.first_release_date)
            .map(year);
        let title = title_key(&product.title);
        !peers.iter().any(|peer| {
            peer.keys.contains(&title)
                && peer
                    .platforms
                    .iter()
                    .any(|p| product.platform_ids.contains(p))
                && !wished
                    .zip(peer.year)
                    .is_some_and(|(wished, other)| (wished - other).abs() <= 1)
        })
    }

    /// Every reason why the owner has to look at a product before it counts; empty for a plain match.
    pub(crate) fn mismatches(&self, product: &Product, peers: &[Peer]) -> Vec<Mismatch> {
        let mut reasons = vec![];
        if !self.title_matches(product) {
            reasons.push(Mismatch::Title);
        }
        if !self.platform_matches(product) {
            reasons.push(if product.platform_unknown {
                Mismatch::PlatformUnknown
            } else {
                Mismatch::Platform
            });
        }
        if !product.key_game {
            reasons.push(Mismatch::KeyType);
        }
        if reasons.is_empty() && !self.same_release(product, peers) {
            reasons.push(Mismatch::Year);
        }
        reasons
    }
}

/// Other catalog games whose title a shop product of this wish could carry (see [`Wish::same_release`]). Reads the
/// catalog cache, which holds every game of the owner's searches; manual titles have none.
pub(crate) async fn peers<'e>(
    executor: impl sqlx::Executor<'e, Database = sqlx::Sqlite>,
    wish: &Wish,
) -> sqlx::Result<Vec<Peer>> {
    let Some(game) = wish.game() else {
        return Ok(vec![]);
    };
    let keys = name_keys(&game);
    // A cheap prefilter on the longest ASCII word of the name (SQLite's lower() folds ASCII only).
    let word = keys[0]
        .split(' ')
        .filter(|w| w.is_ascii())
        .max_by_key(|w| w.len())
        .unwrap_or_default()
        .to_string();
    let rows: Vec<String> = sqlx::query_scalar(
        "SELECT payload FROM catalog_game WHERE igdb_id!=? AND instr(lower(json_extract(payload,'$.name')),?)>0",
    )
    .bind(game.igdb_id)
    .bind(word)
    .fetch_all(executor)
    .await?;
    Ok(rows
        .iter()
        .filter_map(|raw| serde_json::from_str::<crate::catalog::provider::CatalogGame>(raw).ok())
        .filter(|other| other.selection_allowed())
        .map(|other| Peer {
            keys: name_keys(&other),
            year: other.first_release_date.map(year),
            platforms: other.platforms.iter().map(|p| p.id).collect(),
        })
        .filter(|peer| peer.keys.iter().any(|key| keys.contains(key)))
        .collect())
}

#[derive(FromRow)]
struct ItemWish {
    id: String,
    #[sqlx(flatten)]
    wish: Wish,
}

/// Wishes of many items, keyed by item id (`ids_json` is a JSON array of ids).
pub(crate) async fn wishes(
    pool: &SqlitePool,
    ids_json: &str,
) -> sqlx::Result<BTreeMap<String, Wish>> {
    let rows: Vec<ItemWish> = sqlx::query_as("SELECT w.id,w.platform_id,g.manual_title,c.payload FROM wishlist_item w JOIN game g ON g.id=w.game_id LEFT JOIN catalog_game c ON c.igdb_id=g.igdb_id WHERE w.id IN (SELECT value FROM json_each(?))")
        .bind(ids_json).fetch_all(pool).await?;
    Ok(rows.into_iter().map(|row| (row.id, row.wish)).collect())
}

pub(crate) async fn wish(pool: &SqlitePool, id: &str) -> ApiResult<Wish> {
    sqlx::query_as("SELECT w.platform_id,g.manual_title,c.payload FROM wishlist_item w JOIN game g ON g.id=w.game_id LEFT JOIN catalog_game c ON c.igdb_id=g.igdb_id WHERE w.id=?")
        .bind(id).fetch_optional(pool).await?.ok_or(NOT_FOUND)
}

#[derive(FromRow)]
struct ItemLink {
    wish_id: String,
    #[sqlx(flatten)]
    link: Link,
}

#[derive(FromRow)]
pub(crate) struct Link {
    pub id: i64,
    pub source: String,
    url: String,
    pub(crate) review: String,
    fingerprint: Option<String>,
    latest: Option<String>,
    confirmed_name: Option<String>,
    /// Confirmed by hand although the shop data does not match the wish (migration 0015).
    pub(crate) manual_match: bool,
    pub observed_at: Option<i64>,
    pub attempted_at: Option<i64>,
    pub last_error: Option<String>,
    pub enabled: bool,
    pub fee_estimation_enabled: bool,
    pub fee_basis_points: i64,
    /// The job of the link runs or waits ([`crate::jobs::pending`]); only [`links`] reads it.
    pub queued: bool,
    pub retry_at: i64,
    /// Price trend within the wish (migration 0016, [`crate::jobs::trend`]): 0 = mostly the cheapest of all regions, 1 = mostly
    /// twice that or more.
    #[sqlx(default)]
    pub cheap_score: f64,
    /// Interval of the next check in seconds (shop interval, price-trend pace; validity in the target country plays no part).
    #[sqlx(default)]
    pub check_every: Option<i64>,
    /// Interval factor of the job from the price trend (0.5 to 2, `shop_job.pace`); `None` without a job yet.
    #[sqlx(default)]
    pub pace: Option<f64>,
    /// An edition preview: checked half as often.
    #[sqlx(default)]
    pub preview: bool,
}
impl Link {
    /// Fingerprint stored at confirmation.
    pub(crate) fn fingerprint(&self) -> Option<&str> {
        self.fingerprint.as_deref()
    }
    /// The shop page of the offer.
    pub(crate) fn url(&self) -> &str {
        &self.url
    }
    pub(crate) fn product(&self) -> Option<Product> {
        serde_json::from_str(self.latest.as_deref()?).ok()
    }
    /// Confirmed for exactly this product: automatically matching, or matched by hand by the owner.
    pub(crate) fn confirmed(&self, wish: &Wish, product: &Product) -> bool {
        self.review == "confirmed"
            && (wish.matches(product) || self.manual_match)
            && self.fingerprint.as_deref() == Some(product.fingerprint().as_str())
    }
    /// How long an observation of this link counts as current ([`pricing::fresh_for`]).
    pub(crate) fn fresh_for(&self) -> i64 {
        pricing::fresh_for(self.check_every)
    }
    /// The last observation counts as current at `now`.
    pub(crate) fn fresh(&self, now: i64) -> bool {
        self.observed_at
            .is_some_and(|at| at <= now && now - at <= self.fresh_for())
    }
    /// Offers of this link the wish counts (FUNC-11): one per valid seller price of a confirmed product of an active
    /// shop. The wishlist and the tab Angebote both count with this rule.
    pub(crate) fn offer_count(&self, wish: &Wish, product: &Product) -> i64 {
        if !self.enabled || !self.confirmed(wish, product) {
            return 0;
        }
        product
            .offers
            .iter()
            .filter(|quote| pricing::valid_cents(quote.cents))
            .count() as i64
    }
    /// Score 0 to 100 (0.8.2) of a confirmed, measured product: how it does in the check plan. It follows the interval
    /// factor against the shop interval, `pace × 2` for a preview (see `jobs::trend::effective_interval`), on a log scale:
    /// factor 0.5 (steadily the cheapest of the game, checked twice as often) → 100, 1 (no trend yet, average) → 50,
    /// 2 (steadily the most expensive, or sold out; checked half as often) → 0. `None` for products that are not
    /// checked for a price: unconfirmed, rejected, switched-off shop, not measured yet.
    pub(crate) fn score(&self) -> Option<i64> {
        (self.review == "confirmed" && self.enabled && self.observed_at.is_some()).then(|| {
            let factor =
                self.pace.unwrap_or(1.0).clamp(0.5, 2.0) * if self.preview { 2.0 } else { 1.0 };
            (50.0 * (1.0 - factor.log2())).round().clamp(0.0, 100.0) as i64
        })
    }
    pub(crate) fn estimate(&self, cents: i64) -> Option<i64> {
        self.fee_estimation_enabled
            .then(|| with_fee(cents, self.fee_basis_points))
    }
    #[cfg(test)]
    pub(crate) fn fixture(
        id: i64,
        review: &str,
        fingerprint: Option<String>,
        observed_at: Option<i64>,
    ) -> Self {
        Self {
            id,
            source: "eneba".into(),
            url: String::new(),
            review: review.into(),
            fingerprint,
            latest: None,
            confirmed_name: None,
            manual_match: false,
            observed_at,
            attempted_at: observed_at,
            last_error: None,
            enabled: true,
            fee_estimation_enabled: false,
            fee_basis_points: 0,
            queued: false,
            retry_at: 0,
            cheap_score: 0.5,
            check_every: None,
            pace: None,
            preview: false,
        }
    }
}

/// Estimated total of a base price with the shop's fee in basis points, rounded to the cent.
pub(crate) fn with_fee(cents: i64, basis_points: i64) -> i64 {
    cents + (cents * basis_points + 5000) / 10000
}

/// Columns of [`Link`] for `offer_link l` joined with its shop (`s`, `p`), item (`t`) and job (`j`, optional);
/// `?1` is the item or the item ids. `queued` is the SQL of [`Link::queued`].
fn link_query(filter: &str, queued: &str) -> String {
    format!(
        "SELECT l.*, (s.enabled AND s.configured) AS enabled, s.fee_estimation_enabled, s.fee_basis_points, p.retry_at,
        COALESCE({queued},0) AS queued,
        CAST(MIN(604800,MAX(MIN({min},s.poll_interval_seconds),ROUND(s.poll_interval_seconds
            *CASE WHEN t.state='preview' THEN 2 ELSE 1 END*j.pace))) AS INTEGER) AS check_every,
        j.pace AS pace, t.state='preview' AS preview
        FROM offer_link l JOIN source_settings s ON s.id=l.source JOIN shop_state p ON p.source=l.source
        JOIN wishlist_item t ON t.id=l.wish_id LEFT JOIN shop_job j ON j.link_id=l.id WHERE {filter} ORDER BY l.id",
        min = crate::jobs::trend::MIN_INTERVAL
    )
}

/// Binds the clock placeholders `?2` to `?5` of the scheduler conditions after `?1`.
pub(crate) fn clock<'q, O>(
    query: sqlx::query::QueryAs<'q, sqlx::Sqlite, O, sqlx::sqlite::SqliteArguments>,
    ts: i64,
) -> sqlx::query::QueryAs<'q, sqlx::Sqlite, O, sqlx::sqlite::SqliteArguments> {
    query
        .bind(ts)
        .bind(ts / crate::DAY)
        .bind(crate::jobs::budget::daily_budget())
        .bind(ts - crate::jobs::REQUEST_WINDOW)
}

pub(crate) async fn links<'e>(
    executor: impl sqlx::Executor<'e, Database = sqlx::Sqlite>,
    id: &str,
    ts: i64,
) -> sqlx::Result<Vec<Link>> {
    // check_every follows jobs::trend::effective_interval: twice as long for an edition preview, times the price-trend pace,
    // between 15 minutes (or the shop interval) and a week.
    clock(
        sqlx::query_as(AssertSqlSafe(link_query(
            "l.wish_id=?1",
            &crate::jobs::pending(),
        )))
        .bind(id),
        ts,
    )
    .fetch_all(executor)
    .await
}

/// Links of many items in one query, keyed by item id; `queued` stays false.
pub(crate) async fn links_of_items(
    pool: &SqlitePool,
    ids_json: &str,
) -> sqlx::Result<BTreeMap<String, Vec<Link>>> {
    // Badges and the cart do not show whether a link is queued.
    let rows: Vec<ItemLink> = sqlx::query_as(AssertSqlSafe(link_query(
        "l.wish_id IN (SELECT value FROM json_each(?1))",
        "0",
    )))
    .bind(ids_json)
    .fetch_all(pool)
    .await?;
    let mut map: BTreeMap<String, Vec<Link>> = BTreeMap::new();
    for row in rows {
        map.entry(row.wish_id).or_default().push(row.link);
    }
    Ok(map)
}

pub(crate) async fn target(pool: &SqlitePool) -> ApiResult<String> {
    Ok(sqlx::query_scalar::<_, Option<String>>(
        "SELECT target_country FROM app_settings WHERE id=1",
    )
    .fetch_one(pool)
    .await?
    .unwrap_or_default())
}

#[derive(Serialize)]
struct OfferView {
    id: String,
    seller: Option<String>,
    base_cents: i64,
    estimated_total_cents: Option<i64>,
}
#[derive(Serialize)]
pub(crate) struct OffersView {
    links: Vec<Value>,
    histories: HistoryScopes,
    price_badge: crate::price_badges::PriceBadge,
    best_base: Option<i64>,
    best_estimate: Option<i64>,
    /// Lowest price that fails only on age or the latest fetch; never counts as best.
    last_known: Option<pricing::Best>,
    /// Offers of the wish by [`Link::offer_count`], the same number the wishlist shows (FUNC-11).
    offer_count: i64,
    target_country: String,
    discovery_running: bool,
    searches: Vec<Value>,
    sources: Vec<Value>,
}
#[derive(Serialize)]
struct HistoryScopes {
    preferred: Vec<crate::history::Point>,
    all: Vec<crate::history::Point>,
}

/// One observation for the history: link, time, quotes, availability, market, activation.
type Observation = (i64, i64, String, String, String, String);

/// The newest 180 observations of each confirmed link with its confirmed product, newest first, in one query (CODE-08).
async fn samples(
    pool: &SqlitePool,
    wish: &Wish,
    links: &[Link],
) -> sqlx::Result<BTreeMap<i64, Vec<Observation>>> {
    let wanted: Vec<(i64, String)> = links
        .iter()
        .filter_map(|link| {
            let product = link.product()?;
            link.confirmed(wish, &product)
                .then(|| (link.id, product.fingerprint()))
        })
        .collect();
    let rows: Vec<Observation> = sqlx::query_as(
        "SELECT o.link_id,o.observed_at,o.offers,o.availability,o.market,o.activation FROM json_each(?) w
        JOIN price_observation o ON o.id IN (SELECT x.id FROM price_observation x
            WHERE x.link_id=json_extract(w.value,'$[0]') AND x.fingerprint=json_extract(w.value,'$[1]')
            ORDER BY x.observed_at DESC LIMIT 180)
        ORDER BY o.link_id,o.observed_at DESC",
    )
    .bind(serde_json::to_string(&wanted).unwrap_or_default())
    .fetch_all(pool)
    .await?;
    let mut map: BTreeMap<i64, Vec<Observation>> = BTreeMap::new();
    for row in rows {
        map.entry(row.0).or_default().push(row);
    }
    Ok(map)
}

pub(crate) async fn list(
    State(state): State<Shared>,
    ApiPath(id): ApiPath<String>,
) -> ApiResult<Json<OffersView>> {
    let wish = wish(&state.pool, &id).await?;
    let target = target(&state.pool).await?;
    let t = now();
    // Refresh the activity window of a currently viewed preview; saved wishes are unaffected.
    sqlx::query("UPDATE wishlist_item SET viewed_at=? WHERE id=? AND state='preview' AND COALESCE(viewed_at,0)<?")
        .bind(t)
        .bind(&id)
        .bind(t - 300)
        .execute(&state.pool)
        .await?;
    let mut rows = Vec::new();
    let mut all_samples = Vec::new();
    let mut preferred_samples = Vec::new();
    let mut best_base = None;
    let mut best_estimate = None;
    let mut last_known: Option<pricing::Best> = None;
    let mut offer_count = 0;
    let scope = pricing::Scope::target(&target);
    let peers = peers(&state.pool, &wish).await?;
    let links = links(&state.pool, &id, t).await?;
    let assigned = assignments(&state.pool).await?;
    let mut samples = samples(&state.pool, &wish, &links).await?;
    for link in links {
        let product = link.product();
        let mismatch = product
            .as_ref()
            .map_or_else(Vec::new, |p| wish.mismatches(p, &peers));
        let confirmed = product.as_ref().is_some_and(|p| link.confirmed(&wish, p));
        offer_count += product.as_ref().map_or(0, |p| link.offer_count(&wish, p));
        let verdict = pricing::evaluate(&link, &wish, product.as_ref(), &scope, t);
        let anywhere = pricing::evaluate(
            &link,
            &wish,
            product.as_ref(),
            &pricing::Scope::AllRegions,
            t,
        );
        let eligible = verdict.eligible();
        if verdict.last_known()
            && let Some(cents) = product.as_ref().and_then(pricing::min_cents)
            && last_known.is_none_or(|known| cents < known.cents)
        {
            last_known = Some(pricing::Best {
                cents,
                link_id: link.id,
                observed_at: link.observed_at.unwrap_or_default(),
            });
        }
        let quotes: Vec<_> = product
            .iter()
            .flat_map(|p| &p.offers)
            .filter(|q| pricing::valid_cents(q.cents))
            .map(|q| {
                let estimate = link.estimate(q.cents);
                if eligible {
                    update_min(&mut best_base, q.cents);
                    if let Some(estimate) = estimate {
                        update_min(&mut best_estimate, estimate);
                    }
                }
                OfferView {
                    id: q.id.clone(),
                    seller: q.seller.clone(),
                    base_cents: q.cents,
                    estimated_total_cents: estimate,
                }
            })
            .collect();
        if confirmed && let Some(p) = &product {
            for (_, observed_at, offers, availability, market, activation) in
                samples.remove(&link.id).unwrap_or_default()
            {
                let offers: Vec<shops::Quote> =
                    serde_json::from_str(&offers).map_err(|_| internal())?;
                let cents = offers.into_iter().map(|q| q.cents).min();
                let sample = crate::history::Sample {
                    link_id: link.id,
                    observed_at,
                    fresh_for: link.fresh_for(),
                    base_cents: cents,
                    availability,
                    region: p.region.clone(),
                    source: link.source.clone(),
                };
                // The same market rule as the price (FUNC-02): an EU target counts observations of the EU market.
                if pricing::counts_in(&market, &activation, p, &target) {
                    preferred_samples.push(sample.clone());
                }
                all_samples.push(sample);
            }
        }
        // Other games that hold the same product (1.1.4): shown with a warning, a set-aside link holds nothing.
        let elsewhere = if link.review == "rejected" {
            Vec::new()
        } else {
            elsewhere(&assigned, &id, &link.source, &link.url)
        };
        rows.push(json!({"id":link.id,"source":link.source,"url":link.url,"assigned_elsewhere":elsewhere,
            "review": if confirmed { "confirmed" } else if link.review == "confirmed" { "pending" } else { &link.review },
            // A plain confirmation is enough; otherwise `mismatch` says why the owner has to look, and only a key for the
            // wish's system can be confirmed by hand at all (FUNC-01, FUNC-04).
            "can_confirm":mismatch.is_empty(),"mismatch":mismatch,"manual_allowed":product.as_ref().is_some_and(|p| wish.takes_key(p)),
            "manual_match":link.manual_match && confirmed,"eligible":eligible,"reasons":verdict,"queued":link.queued,"enabled":link.enabled,"cheap_score":link.cheap_score,"check_every":link.check_every,"score":link.score(),
            "observed_at":link.observed_at,"attempted_at":link.attempted_at,"last_error":link.last_error,
            "retry_at":link.retry_at,"stale":link.observed_at.is_some_and(|at| t - at > link.fresh_for()),
            "fresh_until":link.observed_at.map(|at| at.saturating_add(link.fresh_for())),
            // For the actions of a row (FUNC-03, RESP-14): the state of its data, whether it is a current price of
            // any region, and whether that region can be bought for the target country.
            "data_state":pricing::data_state(&link, product.as_ref(), t),"current":anywhere.eligible(),"fits_target":verdict.fits_target(),
            // A confirmed product the shop renamed since: the price counts, the title is worth a look.
            "renamed": product.as_ref().filter(|p| link.review == "confirmed" && link.confirmed_name.as_ref().is_some_and(|name| *name != p.name))
                .map(|p| json!({"from":link.confirmed_name,"to":p.name})),
            "product": product.as_ref().map(|p| json!({"name":p.name,"region":p.region,
                "market":p.purchase_country,"activation":p.activation(&target),"availability":p.availability})),
            "quotes":quotes}));
    }
    // The search of this item and the shop-wide discoveries, pending by the scheduler's own rule. A discovery
    // does not count for a paused item: what it finds waits for the end of the pause.
    type SearchRow = (
        bool,
        String,
        bool,
        i64,
        i64,
        Option<i64>,
        Option<String>,
        Option<i64>,
        bool,
    );
    let (discoveries, search_rows): (Vec<SearchRow>, Vec<SearchRow>) = clock(
        sqlx::query_as(AssertSqlSafe(format!(
            "SELECT j.wish_id IS NULL,j.source,s.enabled AND s.configured,j.due,j.lease_until,j.checked_at,
            COALESCE(j.last_error,p.last_error),j.result_count,COALESCE({},0) AND (j.wish_id IS NOT NULL OR EXISTS(
                SELECT 1 FROM wishlist_item w WHERE w.id=?1 AND (w.paused_at IS NULL OR w.paused_until<=?2)))
            FROM {} WHERE j.wish_id=?1 OR (j.wish_id IS NULL AND j.link_id IS NULL)",
            crate::jobs::pending(),
            crate::jobs::JOBS
        )))
        .bind(&id),
        t,
    )
    .fetch_all(&state.pool)
    .await?
    .into_iter()
    .partition(|row: &SearchRow| row.0);
    let discovery_running = discoveries.iter().any(|row| row.8);
    let searches = search_rows
        .into_iter()
        .map(|(_, source, enabled, due, lease, checked, error, count, pending)| {
            // A due search that does not wait (a pause, the budget or a retry holds it) is paused, never "queued".
            let status = if !enabled {
                "disabled"
            } else if lease > t {
                "searching"
            } else if checked.is_none() || due <= t {
                if !pending {
                    "paused"
                } else if error.is_some() {
                    "error"
                } else {
                    "queued"
                }
            } else if error.is_some() {
                "error"
            } else if count == Some(0) {
                "no_match"
            } else {
                "complete"
            };
            json!({"source":source,"status":status,"checked_at":checked,"last_error":error,"result_count":count})
        })
        .collect();
    let price_badge = crate::price_badges::load(&state, &id, &target).await?;
    Ok(Json(OffersView {
        price_badge,
        links: rows,
        histories: HistoryScopes {
            preferred: crate::history::minimum_series(&preferred_samples),
            all: crate::history::minimum_series(&all_samples),
        },
        best_base,
        best_estimate,
        last_known,
        offer_count,
        target_country: target,
        discovery_running,
        searches,
        sources: source_rows(&state.pool)
            .await?
            .into_iter()
            .map(|(id, status)| json!({"source":id,"status":status}))
            .collect(),
    }))
}

fn update_min(min: &mut Option<i64>, value: i64) {
    *min = Some(min.map_or(value, |old| old.min(value)));
}

/// A shop product assigned to a wish, for the duplicate check (1.1.4): a product belongs to one game of the list only.
#[derive(Serialize, FromRow, Clone)]
pub(crate) struct Assigned {
    wish_id: String,
    name: Option<String>,
    platform_id: i64,
    state: String,
    #[serde(skip)]
    source: String,
    #[serde(skip)]
    url: String,
}

/// The product behind a link: Driffle keeps its product id ("…-p9896327") when it renames the slug, so the id counts.
pub(crate) fn product_key(source: &str, url: &str) -> String {
    match (source, url.rsplit_once("-p")) {
        ("driffle", Some((_, id))) => format!("driffle:{id}"),
        _ => format!("{source}:{url}"),
    }
}

/// Every assignment that counts: all links except those set aside ("Verwerfen"), in the order they were wished.
pub(crate) async fn assignments<'e>(
    executor: impl sqlx::Executor<'e, Database = sqlx::Sqlite>,
) -> sqlx::Result<Vec<Assigned>> {
    sqlx::query_as(AssertSqlSafe(format!(
        "SELECT l.wish_id,l.source,l.url,{} AS name,w.platform_id,w.state
        FROM offer_link l JOIN wishlist_item w ON w.id=l.wish_id JOIN game g ON g.id=w.game_id
        LEFT JOIN catalog_game c ON c.igdb_id=g.igdb_id WHERE l.review!='rejected' ORDER BY w.created_at,l.id",
        eventlog::GAME_NAME
    )))
    .fetch_all(executor)
    .await
}

/// The other wishes that hold the product of `source`/`url`, each once.
pub(crate) fn elsewhere<'a>(
    all: &'a [Assigned],
    wish: &str,
    source: &str,
    url: &str,
) -> Vec<&'a Assigned> {
    let key = product_key(source, url);
    let mut found: Vec<&Assigned> = Vec::new();
    for entry in all {
        if entry.wish_id != wish
            && product_key(&entry.source, &entry.url) == key
            && !found.iter().any(|seen| seen.wish_id == entry.wish_id)
        {
            found.push(entry);
        }
    }
    found
}

/// Whether `wish` holds the product of `source`/`url` already, under this address or another one of the shop.
pub(crate) fn holds(all: &[Assigned], wish: &str, source: &str, url: &str) -> bool {
    let key = product_key(source, url);
    all.iter()
        .any(|entry| entry.wish_id == wish && product_key(&entry.source, &entry.url) == key)
}

const ASSIGNED_ELSEWHERE: ApiError = ApiError(
    StatusCode::CONFLICT,
    "Dieses Produkt ist schon einem anderen Spiel deiner Liste zugeordnet. Doppelte Zuordnungen sind nicht möglich.",
);
const ASSIGNED_HERE: ApiError = ApiError(
    StatusCode::CONFLICT,
    "Dieses Produkt ist diesem Spiel schon zugeordnet.",
);

#[derive(Deserialize)]
pub(crate) struct AssignedQuery {
    url: String,
}
/// The check before adding a link by hand (1.1.4): whether the address is a product page at all, whether this wish has it
/// already, and which other games hold the same product. Read-only; the warning comes before the add.
pub(crate) async fn assigned(
    State(state): State<Shared>,
    ApiPath(id): ApiPath<String>,
    crate::extract::ApiQuery(query): crate::extract::ApiQuery<AssignedQuery>,
) -> ApiResult<Json<Value>> {
    wish(&state.pool, &id).await?;
    let Some((shop, url)) = shops::product_link(query.url.trim()) else {
        return Ok(Json(json!({"valid":false,"here":false,"assigned":[]})));
    };
    let all = assignments(&state.pool).await?;
    Ok(Json(json!({
        "valid": true,
        "here": holds(&all, &id, shop.id(), url.as_str()),
        "assigned": elsewhere(&all, &id, shop.id(), url.as_str()),
    })))
}

#[derive(Deserialize)]
pub(crate) struct AddLink {
    url: String,
}
pub(crate) async fn add_link(
    State(state): State<Shared>,
    ApiPath(id): ApiPath<String>,
    ApiJson(input): ApiJson<AddLink>,
) -> ApiResult<StatusCode> {
    let (shop, url) = shops::product_link(input.url.trim()).ok_or(BAD_URL)?;
    let enabled: bool =
        sqlx::query_scalar("SELECT enabled AND configured FROM source_settings WHERE id=?")
            .bind(shop.id())
            .fetch_one(&state.pool)
            .await?;
    if !enabled {
        return Err(ApiError(
            StatusCode::UNPROCESSABLE_ENTITY,
            "Schalte diesen Key-Shop zuerst unter Einstellungen › Key-Shops ein.",
        ));
    }
    crate::wishlist::require_unowned(&state.pool, &id).await?;
    wish(&state.pool, &id).await?;
    let mut tx = state.pool.begin().await?;
    // One game per product (1.1.4): a product another wish holds is not added here; the form warned before.
    let all = assignments(&mut *tx).await?;
    if !elsewhere(&all, &id, shop.id(), url.as_str()).is_empty() {
        return Err(ASSIGNED_ELSEWHERE);
    }
    // Already here, also as the same Driffle product under another address of the shop.
    if holds(&all, &id, shop.id(), url.as_str()) {
        return Err(ASSIGNED_HERE);
    }
    let link: Option<i64> = sqlx::query_scalar(
        "INSERT INTO offer_link(wish_id,source,url)
        SELECT ?,?,? WHERE (SELECT count(*) FROM offer_link WHERE wish_id=? AND auto_discovered=0)<16
        ON CONFLICT(wish_id,source,url) DO NOTHING RETURNING id",
    )
    .bind(&id)
    .bind(shop.id())
    .bind(url.as_str())
    .bind(&id)
    .fetch_optional(&mut *tx)
    .await?;
    // Adding a link by hand lifts an earlier deletion of the same product (migration 0020).
    sqlx::query("DELETE FROM offer_link_block WHERE wish_id=? AND source=? AND url=?")
        .bind(&id)
        .bind(shop.id())
        .bind(url.as_str())
        .execute(&mut *tx)
        .await?;
    if let Some(link) = link {
        // The first price of a link added by hand is a direct user action (module docs of `jobs`).
        sqlx::query("INSERT INTO shop_job(source,link_id,due,initial) VALUES(?,?,?,1)")
            .bind(shop.id())
            .bind(link)
            .bind(now())
            .execute(&mut *tx)
            .await?;
    } else {
        let exists: bool =
            sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM offer_link WHERE wish_id=? AND url=?)")
                .bind(&id)
                .bind(url.as_str())
                .fetch_one(&mut *tx)
                .await?;
        if !exists {
            return Err(ApiError(
                StatusCode::CONFLICT,
                "Pro Wunsch sind bis zu 16 manuell ergänzte Produktlinks möglich.",
            ));
        }
    }
    tx.commit().await?;
    if link.is_some() {
        let game = eventlog::game(&state.pool, &id).await;
        log(
            &state,
            format!("{}-Link für {game} von Hand hinzugefügt", shop.name()),
        )
        .await;
    }
    Ok(StatusCode::ACCEPTED)
}

#[derive(Deserialize)]
pub(crate) struct Review {
    decision: String,
    /// The owner looked at the product page and confirms a product whose shop data does not match automatically.
    #[serde(default)]
    manual: bool,
}
const MANUAL_REQUIRED: ApiError = ApiError(
    StatusCode::CONFLICT,
    "Die Shop-Daten passen nicht automatisch zum Spiel. Prüfe die Produktseite und bestätige die Zuordnung ausdrücklich.",
);
const NOT_A_KEY: ApiError = ApiError(
    StatusCode::UNPROCESSABLE_ENTITY,
    "Laut Shop ist das kein Xbox-Key für diese Plattform, etwa ein Konto, ein Geschenk oder ein Produkt nur für PC. Solche Angebote zählen nie als Key-Preis.",
);
pub(crate) async fn review(
    State(state): State<Shared>,
    ApiPath((id, link_id)): ApiPath<(String, i64)>,
    ApiJson(input): ApiJson<Review>,
) -> ApiResult<StatusCode> {
    crate::wishlist::require_unowned(&state.pool, &id).await?;
    let wish = wish(&state.pool, &id).await?;
    let link = links(&state.pool, &id, now())
        .await?
        .into_iter()
        .find(|l| l.id == link_id)
        .ok_or(NOT_FOUND)?;
    if input.decision == "confirmed" {
        let product = link.product().ok_or(CONFLICT)?;
        // FUNC-04: the key type and the platform hold for a confirmation by hand too.
        if !wish.takes_key(&product) {
            return Err(NOT_A_KEY);
        }
        let matching = wish
            .mismatches(&product, &peers(&state.pool, &wish).await?)
            .is_empty();
        if !matching && !input.manual {
            return Err(MANUAL_REQUIRED);
        }
        let changed = sqlx::query("UPDATE offer_link SET review='confirmed', fingerprint=?, confirmed_name=?, manual_match=? WHERE id=? AND wish_id=? AND latest=?")
            .bind(product.fingerprint()).bind(&product.name).bind(!matching).bind(link_id).bind(&id).bind(link.latest).execute(&state.pool).await?;
        if changed.rows_affected() == 0 {
            return Err(CONFLICT);
        }
        let how = if matching {
            "bestätigt"
        } else {
            "von Hand bestätigt"
        };
        log_review(&state, &id, link_id, how).await;
    } else if matches!(input.decision.as_str(), "rejected" | "pending") {
        sqlx::query("UPDATE offer_link SET review=?, fingerprint=NULL, confirmed_name=NULL, manual_match=0 WHERE id=? AND wish_id=?")
            .bind(&input.decision)
            .bind(link_id)
            .bind(&id)
            .execute(&state.pool)
            .await?;
        if input.decision == "pending" {
            sqlx::query("UPDATE shop_job SET due=MIN(due,?) WHERE link_id=? AND lease_until<=?")
                .bind(now())
                .bind(link_id)
                .bind(now())
                .execute(&state.pool)
                .await?;
        }
        let how = if input.decision == "rejected" {
            "abgelehnt"
        } else {
            "zur erneuten Prüfung zurückgesetzt"
        };
        log_review(&state, &id, link_id, how).await;
    } else {
        return Err(ApiError(
            StatusCode::BAD_REQUEST,
            "Ungültige Prüfentscheidung.",
        ));
    }
    Ok(StatusCode::NO_CONTENT)
}

async fn log(state: &Shared, message: String) {
    eventlog::record(&state.pool, Level::Info, Area::Offers, message).await;
}

/// "Eneba-Angebot (Global) für „Forza Horizon 5“ abgelehnt".
async fn log_review(state: &Shared, id: &str, link: i64, how: &str) {
    let offer = eventlog::offer(&state.pool, link).await;
    let game = eventlog::game(&state.pool, id).await;
    log(state, format!("{offer} für {game} {how}")).await;
}

/// Deletes a completely wrong product mapping with its price history. The automatic search does not
/// suggest the product for this wish again (`offer_link_block`); adding the link by hand lifts that.
pub(crate) async fn remove_link(
    State(state): State<Shared>,
    ApiPath((id, link_id)): ApiPath<(String, i64)>,
) -> ApiResult<StatusCode> {
    crate::wishlist::require_unowned(&state.pool, &id).await?;
    let mut tx = state.pool.begin().await?;
    let blocked = sqlx::query(
        "INSERT INTO offer_link_block(wish_id,source,url,blocked_at)
        SELECT wish_id,source,url,? FROM offer_link WHERE id=? AND wish_id=?
        ON CONFLICT(wish_id,source,url) DO UPDATE SET blocked_at=excluded.blocked_at",
    )
    .bind(now())
    .bind(link_id)
    .bind(&id)
    .execute(&mut *tx)
    .await?;
    if blocked.rows_affected() == 0 {
        return Err(NOT_FOUND);
    }
    let offer = eventlog::offer(&mut *tx, link_id).await;
    // Jobs and price observations go with the link (ON DELETE CASCADE).
    sqlx::query("DELETE FROM offer_link WHERE id=? AND wish_id=?")
        .bind(link_id)
        .bind(&id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    let game = eventlog::game(&state.pool, &id).await;
    log(&state, format!("{offer} für {game} gelöscht")).await;
    Ok(StatusCode::NO_CONTENT)
}

/// A manual check skips searches and links fetched within this time.
const REFRESH_SPACING: i64 = 900;

pub(crate) async fn refresh(
    State(state): State<Shared>,
    ApiPath(id): ApiPath<String>,
) -> ApiResult<StatusCode> {
    crate::wishlist::require_unowned(&state.pool, &id).await?;
    wish(&state.pool, &id).await?;
    let t = now();
    crate::jobs::attach::schedule_wish(&state.pool, &id).await?;
    // A requested refresh gets top priority, also for links whose last fetch failed. The whole
    // search run is a direct user action and bypasses pacing (module docs of `jobs`).
    sqlx::query("UPDATE shop_job SET due=MIN(due,?),requested_at=?,search_page=1,result_count=0,initial=1 WHERE wish_id=? AND lease_until<=? AND COALESCE(checked_at,0)<=?")
        .bind(t).bind(t).bind(&id).bind(t).bind(t-REFRESH_SPACING).execute(&state.pool).await?;
    sqlx::query("UPDATE shop_job SET due=MIN(due,?),requested_at=? WHERE lease_until<=?
        AND link_id IN (SELECT id FROM offer_link WHERE wish_id=? AND review!='rejected' AND COALESCE(attempted_at,0)<=?)")
        .bind(t).bind(t).bind(t).bind(&id).bind(t-REFRESH_SPACING).execute(&state.pool).await?;
    let game = eventlog::game(&state.pool, &id).await;
    log(&state, format!("Aktualisierung für {game} angefordert")).await;
    Ok(StatusCode::ACCEPTED)
}

pub(crate) async fn source_rows(pool: &SqlitePool) -> ApiResult<Vec<(String, Value)>> {
    type ShopStatus = (String, bool, Option<i64>, Option<String>, i64);
    let rows: Vec<ShopStatus> = sqlx::query_as(
        "SELECT s.id,(s.enabled AND s.configured),p.last_success,p.last_error,p.retry_at FROM shop_state p JOIN source_settings s ON s.id=p.source WHERE s.configured=1")
        .fetch_all(pool).await?;
    Ok(rows.into_iter().filter(|(id,..)| Shop::from_id(id).is_some()).map(|(id,enabled,success,error,retry)| {
        let status = if !enabled {"disabled"} else if retry > now() {"paused"} else if error.is_some() {"error"} else if success.is_some() {"ready"} else {"idle"};
        (id,json!({"state":status,"enabled":enabled,"last_success_at":success,"last_error":error,"retry_at":retry}))
    }).collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::shops::{Availability, Quote};

    #[test]
    fn older_xbox_wishes_take_backward_compatible_one_keys_but_only_by_hand() {
        let payload=serde_json::json!({"igdb_id":1,"name":"Fable Anniversary","slug":null,"summary":null,"first_release_date":null,
            "platforms":[{"id":12,"name":"Xbox 360"},{"id":11,"name":"Xbox"}],"aliases":[],"cover_url":null,
            "version_parent":null,"edition_name":null,"kind":"base_game","fetched_at":0}).to_string();
        let mut product = Product {
            id: "fable".into(),
            name: "Fable Anniversary XBOX LIVE Key ARGENTINA".into(),
            title: "Fable Anniversary".into(),
            platform_ids: vec![49, 169],
            platform_unknown: false,
            key_game: true,
            region: None,
            allowed: vec![],
            blocked: vec![],
            purchase_country: None,
            offers: vec![],
            availability: Availability::Unknown,
        };
        for platform in [12, 11] {
            let wish = Wish::from_parts(platform, None, Some(payload.clone()));
            assert!(wish.matches(&product), "{platform}: confirm by hand");
            assert!(
                !wish.auto_matches(&product, &[]),
                "{platform}: never automatically"
            );
        }
        // Only Series X|S: no Xbox One key, no match; a real 360 key matches the 360 wish automatically.
        product.platform_ids = vec![169];
        assert!(!Wish::from_parts(12, None, Some(payload.clone())).matches(&product));
        product.platform_ids = vec![12];
        assert!(Wish::from_parts(12, None, Some(payload.clone())).auto_matches(&product, &[]));
        assert!(!Wish::from_parts(11, None, Some(payload)).matches(&product));
    }

    fn catalog(name: &str, kind: &str, platforms: &[i64], released: Option<i64>) -> String {
        serde_json::json!({"igdb_id":1,"name":name,"slug":null,"summary":null,"first_release_date":released,
            "platforms":platforms.iter().map(|p| serde_json::json!({"id":p,"name":"x"})).collect::<Vec<_>>(),
            "aliases":[],"cover_url":null,"version_parent":null,"edition_name":null,"kind":kind,"fetched_at":0})
        .to_string()
    }
    fn key(title: &str, platforms: &[i64]) -> Product {
        Product {
            id: "p".into(),
            name: title.into(),
            title: title.into(),
            platform_ids: platforms.to_vec(),
            platform_unknown: false,
            key_game: true,
            region: None,
            allowed: vec![],
            blocked: vec![],
            purchase_country: None,
            offers: vec![],
            availability: Availability::Unknown,
        }
    }
    fn peer(name: &str, released: Option<i64>, platforms: &[i64]) -> Peer {
        let game: crate::catalog::provider::CatalogGame =
            serde_json::from_str(&catalog(name, "base_game", platforms, released)).unwrap();
        Peer {
            keys: name_keys(&game),
            year: released.map(year),
            platforms: platforms.to_vec(),
        }
    }
    const DEC_1993: i64 = 755_481_600;
    const MAY_2016: i64 = 1_463_097_600;
    const NOV_2005: i64 = 1_130_803_200;
    const NOV_2017: i64 = 1_510_617_600;

    /// FUNC-01, audit probes A and B (`evidence/functional/matching-probes.txt`): same title, other release.
    #[test]
    fn same_titled_games_of_another_year_are_never_confirmed_automatically_func01() {
        assert_eq!(
            (year(DEC_1993), year(MAY_2016), year(0)),
            (1993, 2016, 1970)
        );
        // A: the Doom of 1993 is wished on the Xbox One, the shop sells "DOOM" (2016); the catalog knows both.
        let doom = Wish::from_parts(
            49,
            None,
            Some(catalog("Doom", "base_game", &[49, 12], Some(DEC_1993))),
        );
        let reboot = [peer("DOOM", Some(MAY_2016), &[49, 6, 48])];
        let p = key("doom", &[49]);
        assert!(
            !doom.auto_matches(&p, &reboot),
            "probe A was true up to 0.9.2"
        );
        assert!(doom.matches(&p), "the owner can still confirm it");
        assert_eq!(doom.mismatches(&p, &reboot), [Mismatch::Year]);
        assert!(
            doom.auto_matches(&p, &[]),
            "alone in the catalog: as before"
        );
        // A port within a year, or the other game on another system only, is no other release.
        assert!(doom.auto_matches(&p, &[peer("Doom", Some(DEC_1993 + 200 * 86400), &[49])]));
        assert!(doom.auto_matches(&p, &[peer("Doom", Some(MAY_2016), &[6])]));
        // An undated namesake cannot be told apart.
        assert!(!doom.auto_matches(&p, &[peer("Doom", None, &[49])]));
        // B: an original-Xbox wish for Battlefront II (2005) and the One key of the 2017 game: no plain match.
        let battlefront = Wish::from_parts(
            11,
            None,
            Some(catalog(
                "Star Wars: Battlefront II",
                "base_game",
                &[11, 14],
                Some(NOV_2005),
            )),
        );
        let one = key("star wars battlefront ii", &[49, 169]);
        let newer = [peer(
            "Star Wars Battlefront II",
            Some(NOV_2017),
            &[49, 6, 48],
        )];
        assert!(!battlefront.auto_matches(&one, &newer));
        assert_eq!(battlefront.mismatches(&one, &newer), [Mismatch::Year]);
        // The 360/original-Xbox rule only with a known same release: an Xbox One key may always be a newer namesake.
        let fable = Wish::from_parts(
            12,
            None,
            Some(catalog("Fable II", "base_game", &[12], Some(1_224_633_600))),
        );
        let fable_key = key("fable ii", &[49, 169]);
        assert!(fable.matches(&fable_key));
        assert_eq!(fable.mismatches(&fable_key, &[]), [Mismatch::Year]);
        assert!(fable.mismatches(&key("fable ii", &[12]), &[]).is_empty());
    }

    /// FUNC-04: only an Xbox key for the wish's system can be confirmed by hand; the reasons say why not.
    #[test]
    fn accounts_and_pc_products_cannot_be_confirmed_by_hand_func04() {
        let forza = Wish::from_parts(
            169,
            None,
            Some(catalog("Forza Horizon 5", "base_game", &[169, 49, 6], None)),
        );
        let mut account = key("forza horizon 5", &[169]);
        account.key_game = false;
        assert!(!forza.takes_key(&account));
        assert_eq!(forza.mismatches(&account, &[]), [Mismatch::KeyType]);
        let pc = key("forza horizon 5", &[6]);
        assert!(!forza.takes_key(&pc));
        assert_eq!(forza.mismatches(&pc, &[]), [Mismatch::Platform]);
        let one = key("forza horizon 5", &[49]);
        assert!(
            forza.takes_key(&one),
            "a One key runs on the Series X|S: by hand"
        );
        assert_eq!(forza.mismatches(&one, &[]), [Mismatch::Platform]);
        let bundle = key("forza horizon 5 deluxe bundle", &[169]);
        assert!(forza.takes_key(&bundle));
        assert_eq!(forza.mismatches(&bundle, &[]), [Mismatch::Title]);
        // A Series-only key does not run on the Xbox One.
        let older = Wish::from_parts(
            49,
            None,
            Some(catalog("Forza Horizon 5", "base_game", &[169, 49], None)),
        );
        assert!(!older.takes_key(&key("forza horizon 5", &[169])));
        // 1.1.5: no platform named at all is not a PC product: confirmable by hand, never automatically.
        let mut unnamed = key("forza horizon 5", &[]);
        unnamed.platform_unknown = true;
        assert!(forza.takes_key(&unnamed) && older.takes_key(&unnamed));
        assert!(!forza.auto_matches(&unnamed, &[]));
        assert_eq!(forza.mismatches(&unnamed, &[]), [Mismatch::PlatformUnknown]);
        unnamed.key_game = false;
        assert!(!forza.takes_key(&unnamed));
    }

    /// 1.1.1: a bundle without a parent game (IGDB lists "Final Fantasy VII Remake Intergrade" this way) is matched by its
    /// own title only. It never takes the keys of the game it contains, nor that game the bundle's keys.
    #[test]
    fn a_bundle_is_matched_by_its_own_title_only() {
        let intergrade = Wish::from_parts(
            169,
            None,
            Some(catalog(
                "Final Fantasy VII Remake Intergrade",
                "bundle",
                &[169],
                None,
            )),
        );
        let bundle_key = key("final fantasy vii remake intergrade", &[169]);
        assert!(intergrade.auto_matches(&bundle_key, &[]));
        let remake_key = key("final fantasy vii remake", &[169]);
        assert!(!intergrade.auto_matches(&remake_key, &[]));
        assert_eq!(intergrade.mismatches(&remake_key, &[]), [Mismatch::Title]);
        let remake = Wish::from_parts(
            169,
            None,
            Some(catalog(
                "Final Fantasy VII Remake",
                "base_game",
                &[169],
                None,
            )),
        );
        assert!(!remake.auto_matches(&bundle_key, &[]));
        assert_eq!(remake.mismatches(&bundle_key, &[]), [Mismatch::Title]);
    }

    #[test]
    fn score_follows_the_check_interval_factor() {
        let mut link = Link::fixture(1, "confirmed", None, Some(1));
        for (pace, preview, score) in [
            (Some(0.5), false, 100),
            (Some(0.707), false, 75),
            (Some(1.0), false, 50),
            (None, false, 50),
            (Some(1.414), false, 25),
            (Some(2.0), false, 0),
            (Some(0.5), true, 50),
            (Some(1.0), true, 0),
        ] {
            link.pace = pace;
            link.preview = preview;
            assert_eq!(link.score(), Some(score), "{pace:?} {preview}");
        }
        assert_eq!(Link::fixture(1, "pending", None, Some(1)).score(), None);
        assert_eq!(
            Link::fixture(1, "confirmed", None, None).score(),
            None,
            "not measured yet"
        );
        link.enabled = false;
        assert_eq!(link.score(), None, "switched-off shop");
    }

    #[test]
    fn automatic_confirmation_requires_catalog_identity() {
        let payload=serde_json::json!({"igdb_id":1,"name":"Forza Horizon 5","slug":null,"summary":null,"first_release_date":null,
            "platforms":[{"id":169,"name":"Xbox Series X|S"}],"aliases":["Unrelated Name"],"cover_url":null,
            "version_parent":null,"edition_name":null,"kind":"base_game","fetched_at":0}).to_string();
        let wish = Wish::from_parts(169, None, Some(payload));
        let mut p = Product {
            id: "test".into(),
            name: "Forza Horizon 5".into(),
            title: "Forza Horizon 5".into(),
            platform_ids: vec![169],
            platform_unknown: false,
            key_game: true,
            region: None,
            allowed: vec![],
            blocked: vec![],
            purchase_country: None,
            offers: vec![],
            availability: Availability::Unknown,
        };
        assert!(wish.auto_matches(&p, &[]));
        assert!(!Wish::from_parts(169, Some("Forza Horizon 5".into()), None).auto_matches(&p, &[]));
        for title in [
            "Forza Horizon 5 Premium Edition",
            "Forza Horizon 5 Remaster",
            "Forza Horizon 6",
            "Unrelated Name",
        ] {
            p.title = title.into();
            assert!(!wish.auto_matches(&p, &[]));
        }
        p.title = "Forza Horizon 5".into();
        p.platform_ids = vec![6];
        assert!(!wish.auto_matches(&p, &[]));
        p.platform_ids = vec![169];
        p.key_game = false;
        assert!(!wish.auto_matches(&p, &[]));
    }
    #[test]
    fn exact_product_scope_and_price_quality() {
        let wish = Wish::from_parts(169, Some("Forza Horizon 5".into()), None);
        let mut product = Product {
            id: "test".into(),
            name: "Forza Horizon 5".into(),
            title: "Forza Horizon 5".into(),
            platform_ids: vec![169, 49],
            platform_unknown: false,
            key_game: true,
            region: Some("Global".into()),
            allowed: vec!["DE".into()],
            blocked: vec![],
            purchase_country: Some("DE".into()),
            offers: vec![Quote {
                id: "offer".into(),
                cents: 2392,
                seller: None,
            }],
            availability: Availability::InStock,
        };
        let mut link = Link {
            id: 1,
            source: "eneba".into(),
            url: "".into(),
            review: "confirmed".into(),
            fingerprint: Some(product.fingerprint()),
            latest: None,
            confirmed_name: None,
            manual_match: false,
            observed_at: Some(200),
            attempted_at: Some(200),
            last_error: None,
            enabled: true,
            fee_estimation_enabled: true,
            fee_basis_points: 200,
            queued: false,
            retry_at: 0,
            cheap_score: 0.5,
            check_every: None,
            pace: None,
            preview: false,
        };
        assert_eq!(link.estimate(2392), Some(2440));
        link.fee_estimation_enabled = false;
        assert_eq!(link.estimate(2392), None);
        assert!(link.confirmed(&wish, &product));
        for title in [
            "Forza Horizon 5 Premium Edition",
            "Forza Horizon 5 Remastered",
            "Forza Horizon 6",
            "Forza Horizon 5: Hot Wheels",
            "Forza Horizon 5 Premium Add-On Bundle",
            "Forza Horizon 5 Account",
        ] {
            product.title = title.into();
            assert!(!wish.matches(&product), "{title}");
        }
        product.title = "Forza Horizon 5".into();
        product.platform_ids = vec![6];
        assert!(!wish.matches(&product));
        product.platform_ids = vec![169];
        product.key_game = false;
        assert!(!wish.matches(&product));
        assert!(!link.confirmed(&wish, &product), "the fingerprint changed");
        // Confirmed by hand: counts although the shop data does not match, for exactly this product.
        product.key_game = true;
        product.platform_ids = vec![169, 49];
        product.title = "Forza Horizon 5 Premium Edition".into();
        link.manual_match = true;
        assert!(link.confirmed(&wish, &product));
        link.manual_match = false;
        assert!(!link.confirmed(&wish, &product));
    }
}
