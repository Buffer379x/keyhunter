//! Price trend of a product among the other regions of its wish, and the check interval that follows from it.

use super::WEEK;
use crate::shops::{Availability, Product};
use sqlx::SqlitePool;

/// Interval of the next product check: the shop interval, twice as long for an edition preview, times the price-trend
/// `pace` (0.5 to 2, see [`price_trend`]). Never shorter than 15 minutes, never longer than a week.
pub(crate) fn effective_interval(interval: i64, preview: bool, pace: f64) -> i64 {
    let factor = if preview { 2 } else { 1 };
    let paced = (interval * factor) as f64 * pace.clamp(PACE_FASTEST, SOLD_OUT_PACE);
    (paced.round() as i64).clamp(MIN_INTERVAL.min(interval), WEEK)
}

/// Weight of the newest measurement in the price trend (moving average over roughly the last ten measurements).
const TREND_WEIGHT: f64 = 0.2;
/// Pace of the product that is steadily the cheapest of its game: checked twice as often.
const PACE_FASTEST: f64 = 0.5;
/// Pace of a sold-out product (or one without a valid price): checked half as often until it is in stock again.
/// A product steadily at twice the cheapest price or more gets the same pace from its trend.
const SOLD_OUT_PACE: f64 = 2.0;
/// Shortest interval the settings allow.
pub(crate) const MIN_INTERVAL: i64 = 900;
/// Prices older than this do not take part in the comparison.
const TREND_PRICE_AGE: i64 = WEEK;
/// A price this many times the cheapest one (or more) has position 1, like a sold-out product (1.1, SCORE-01/-02).
const IRRELEVANT_RATIO: f64 = 2.0;

/// Price position of `own` against the other `prices`: the logarithmic distance to the cheapest of all, own included,
/// `log2(own / min) / log2(IRRELEVANT_RATIO)`, clamped to 0..1. 0 = the cheapest, +41 % = 0.5, twice the cheapest or
/// more = 1. Only the cheapest price is the reference, so a more expensive offer never shifts the others, and a single
/// offer is the cheapest (1.1; up to 1.0 min-max between cheapest and most expensive, none without a comparison).
fn price_position(own: i64, prices: &[i64]) -> f64 {
    let min = prices.iter().copied().fold(own, i64::min).max(1);
    ((own as f64 / min as f64).log2() / IRRELEVANT_RATIO.log2()).clamp(0.0, 1.0)
}

/// Next price trend: the moving average moves a fifth of the way to the new position.
fn next_trend(score: f64, position: f64) -> f64 {
    (score + TREND_WEIGHT * (position - score)).clamp(0.0, 1.0)
}

/// Interval factor from the trend: 0 (steadily the cheapest) → 0.5, 0.5 → 1, 1 (steadily twice the cheapest) → 2.
fn trend_pace(score: f64) -> f64 {
    2f64.powf(2.0 * score - 1.0)
}

/// New price trend and pace of a measured product link, compared with the other confirmed, recently measured products
/// of the same wish in every region. Whether a product can be activated in the target country plays no part (owner's
/// rule, 1.1): a region that is not valid there is never checked less often than a valid one at the same price, since
/// buying there only takes a few more steps.
pub(super) async fn price_trend(
    pool: &SqlitePool,
    link: i64,
    product: &Product,
    t: i64,
) -> sqlx::Result<(f64, f64)> {
    let Some((wish, score)): Option<(String, f64)> =
        sqlx::query_as("SELECT wish_id,cheap_score FROM offer_link WHERE id=?")
            .bind(link)
            .fetch_optional(pool)
            .await?
    else {
        return Ok((0.5, 1.0));
    };
    let Some(own) = crate::pricing::min_cents(product)
        .filter(|_| product.availability == Availability::InStock)
    else {
        return Ok((score, SOLD_OUT_PACE));
    };
    let others: Vec<String> = sqlx::query_scalar(
        "SELECT l.latest FROM offer_link l JOIN source_settings s ON s.id=l.source
        WHERE l.wish_id=? AND l.id!=? AND l.review='confirmed' AND s.enabled AND s.configured
        AND l.latest IS NOT NULL AND l.observed_at>?",
    )
    .bind(&wish)
    .bind(link)
    .bind(t - TREND_PRICE_AGE)
    .fetch_all(pool)
    .await?;
    let prices: Vec<i64> = others
        .iter()
        .filter_map(|raw| serde_json::from_str::<Product>(raw).ok())
        .filter(|other| other.availability == Availability::InStock)
        .filter_map(|other| crate::pricing::min_cents(&other))
        .collect();
    let score = next_trend(score, price_position(own, &prices));
    Ok((score, trend_pace(score)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::jobs::{budget::demand, tests::*, *};

    #[test]
    fn price_trend_moves_slowly_and_maps_to_half_or_double_interval() {
        // SCORE-02 (1.1): the position is the logarithmic distance to the cheapest price; twice the cheapest or more is 1.
        assert_eq!(
            price_position(1000, &[]),
            0.0,
            "a single offer is the cheapest"
        );
        assert_eq!(price_position(1000, &[1000]), 0.0);
        assert_eq!(price_position(1000, &[3000, 2000]), 0.0);
        assert!((price_position(1414, &[1000, 3000]) - 0.5).abs() < 1e-3);
        assert_eq!(price_position(2000, &[1000]), 1.0);
        assert_eq!(price_position(5000, &[1000]), 1.0);
        // Steady pace of an offer this far above the cheapest (audit 11, 8.2): +0 → 0.5, +10 % → 0.61, +25 % → 0.78,
        // +41 % → 1, twice or more → 2.
        for (own, pace) in [
            (1000, 0.5),
            (1100, 0.61),
            (1250, 0.78),
            (1410, 1.0),
            (2000, 2.0),
            (3500, 2.0),
        ] {
            let steady = trend_pace(price_position(own, &[1000, 4000]));
            assert!((steady - pace).abs() < 0.01, "{own} ct: pace {steady}");
        }
        // Monotone in the distance: a higher price is never checked more often.
        let mut last = 0.0;
        for own in (1000..=2500).step_by(10) {
            let position = price_position(own, &[1000, 1700]);
            if own > 1000 && own <= 2000 {
                assert!(position > last, "{own} ct: {position} <= {last}");
            } else {
                assert!(position >= last, "{own} ct: {position} < {last}");
            }
            last = position;
        }
        // An additional expensive offer does not move the position of the others (min-max did up to 1.0).
        let prices = [1000, 1200, 1800, 2400, 3000];
        for own in prices {
            let others: Vec<i64> = prices.into_iter().filter(|&p| p != own).collect();
            let with_outlier = [others.as_slice(), &[6000]].concat();
            assert_eq!(
                price_position(own, &others),
                price_position(own, &with_outlier),
                "{own} ct"
            );
        }
        // One cheap measurement moves the neutral trend a fifth of the way.
        assert!((next_trend(0.5, 0.0) - 0.4).abs() < 1e-9);
        let mut score = 0.5;
        for _ in 0..20 {
            score = next_trend(score, 0.0);
        }
        assert!(score < 0.01, "{score}");
        assert!((trend_pace(0.0) - 0.5).abs() < 1e-9);
        assert!((trend_pace(0.5) - 1.0).abs() < 1e-9);
        assert!((trend_pace(1.0) - 2.0).abs() < 1e-9);
        // 8 h for every region alike: the steadily cheapest every 4 h, twice the cheapest every 16 h, a preview twice as
        // long; never beyond a week, never below 15 minutes.
        assert_eq!(effective_interval(8 * 3600, false, 0.5), 4 * 3600);
        assert_eq!(effective_interval(8 * 3600, false, 1.0), 8 * 3600);
        assert_eq!(effective_interval(8 * 3600, false, 2.0), 16 * 3600);
        assert_eq!(effective_interval(8 * 3600, true, 1.0), 16 * 3600);
        assert_eq!(effective_interval(WEEK, true, 2.0), WEEK);
        assert_eq!(effective_interval(900, false, 0.5), 900);
    }

    const T0: i64 = 1_800_000_000 - 1_800_000_000 % DAY;

    /// Wish `w` with target country DE and one link per product of `products`, product jobs only (no discovery). Every
    /// link is measured `rounds` times, an hour apart, by the real claim and complete. Returns the pool, the time after
    /// the last round and per link (cheap_score, pace, planned interval).
    async fn measured(
        products: &[Product],
        rounds: usize,
    ) -> (SqlitePool, i64, Vec<(f64, f64, i64)>) {
        let pool = memory().await;
        sqlx::query("UPDATE app_settings SET target_country='DE'")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("DELETE FROM shop_job WHERE link_id IS NULL")
            .execute(&pool)
            .await
            .unwrap();
        add_item(&pool, "w", "wished").await;
        let mut links = vec![];
        for n in 0..products.len() {
            links.push(add_link(&pool, "w", n, T0 + 100 * DAY).await);
        }
        let mut t = T0;
        for _ in 0..rounds {
            for (link, product) in links.iter().zip(products) {
                sqlx::query("UPDATE shop_job SET due=? WHERE link_id=?")
                    .bind(t)
                    .bind(link)
                    .execute(&pool)
                    .await
                    .unwrap();
                unpace(&pool).await;
                let job = claim(&pool, Shop::Eneba, "aa", t, 1_000_000)
                    .await
                    .unwrap()
                    .unwrap();
                assert_eq!(job.link_id, Some(*link));
                let work = Work::Product(Box::new(product.clone()));
                complete(&pool, Shop::Eneba, &job, "aa", Ok(work), t, t, 1)
                    .await
                    .unwrap();
            }
            t += 3600;
        }
        let rows = sqlx::query_as(
                "SELECT l.cheap_score,j.pace,j.due-j.checked_at FROM offer_link l JOIN shop_job j ON j.link_id=l.id ORDER BY l.id",
            )
            .fetch_all(&pool)
            .await
            .unwrap();
        (pool, t, rows)
    }

    /// A product at `cents`, valid in DE or not; `None` is sold out.
    fn at(cents: Option<i64>, valid: bool) -> Product {
        let mut product = priced(valid);
        match cents {
            Some(cents) => product.offers[0].cents = cents,
            None => {
                product.offers.clear();
                product.availability = Availability::SoldOut;
            }
        }
        product
    }

    #[tokio::test]
    async fn cheap_regions_are_checked_more_often_expensive_and_sold_out_ones_less() {
        // SCORE-01/-02 (1.1): the distance to the cheapest price decides, whatever the spread of the others. Regions that
        // cannot count in DE at 10, 11, 14.10 and 30 €, one sold out, and a product valid in DE at 14.10 €.
        let products = [
            at(Some(1000), false),
            at(Some(1100), false),
            at(Some(1410), false),
            at(Some(3000), false),
            at(None, false),
            at(Some(1410), true),
        ];
        let (pool, t, rows) = measured(&products, 12).await;
        let interval = 8 * 3600;
        // Steadily the cheapest region: trend near 0, checked almost twice as often.
        assert!(rows[0].0 < 0.1 && rows[0].1 < 0.6, "{:?}", rows[0]);
        assert!(rows[0].2 < interval * 6 / 10, "{:?}", rows[0]);
        // 10 % above the cheapest: still clearly more often than the plain interval (min-max put it at 0.1 of the spread).
        assert!(rows[1].1 > rows[0].1 && rows[1].1 < 0.7, "{:?}", rows[1]);
        // 41 % above the cheapest: about the plain interval.
        assert!((rows[2].1 - 1.0).abs() < 0.1, "{:?}", rows[2]);
        // Twice the cheapest or more: about half as often.
        assert!(rows[3].0 > 0.9 && rows[3].1 > 1.8, "{:?}", rows[3]);
        assert!(rows[3].2 > interval * 18 / 10, "{:?}", rows[3]);
        // Sold out: half as often until it is in stock again; its trend stays where it was.
        assert_eq!(
            (rows[4].0, rows[4].1, rows[4].2),
            (0.5, SOLD_OUT_PACE, 2 * interval)
        );
        // Validity in DE plays no part: the valid product at the same price is checked exactly like the other one.
        assert_eq!(rows[5], rows[2]);
        // The demand estimate uses the same paces.
        let expected = rows
            .iter()
            .map(|row| DAY as f64 / row.2 as f64)
            .sum::<f64>();
        let estimate = demand(&pool, Shop::Eneba, t).await.unwrap();
        assert!(
            (estimate - expected).abs() < 0.01,
            "estimate {estimate}, expected {expected}"
        );
    }

    /// The owner's rule (1.1): a region that is not valid in the target country never gets a lower score or a slower
    /// check than a valid offer at the same price; buying there only takes a few more steps, the result is the same.
    #[tokio::test]
    async fn owner_rule_invalid_regions_are_never_checked_slower_than_valid_ones() {
        // Index 0/1: the same price, not valid and valid in DE; 2/3 cheaper not valid and dearer valid; 4/5 the cheapest
        // of the wish (not valid) and its valid twin.
        let products = [
            at(Some(1500), false),
            at(Some(1500), true),
            at(Some(1200), false),
            at(Some(1800), true),
            at(Some(1000), false),
            at(Some(1000), true),
        ];
        for rounds in [1, 4, 12] {
            let (pool, t, rows) = measured(&products, rounds).await;
            let links = crate::offers::links(&pool, "w", t).await.unwrap();
            let score = |n: usize| links[n].score();
            let due: Vec<i64> = sqlx::query_scalar(
                "SELECT due FROM shop_job WHERE link_id IS NOT NULL ORDER BY link_id",
            )
            .fetch_all(&pool)
            .await
            .unwrap();
            for (invalid, valid) in [(0, 1), (4, 5)] {
                assert_eq!(rows[invalid], rows[valid], "same price, round {rounds}");
                assert_eq!(score(invalid), score(valid), "same score, round {rounds}");
                assert_eq!(due[invalid], due[valid], "same due, round {rounds}");
            }
            // Cheaper and not valid: a faster pace, a shorter interval and a higher score than the dearer valid offer.
            assert!(rows[2].1 < rows[3].1 && rows[2].2 < rows[3].2, "{rows:?}");
            assert!(score(2) > score(3), "{:?} {:?}", score(2), score(3));
        }
    }
}
