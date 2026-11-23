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
/// The steadily most expensive product gets the same pace from its trend.
const SOLD_OUT_PACE: f64 = 2.0;
/// Shortest interval the settings allow.
pub(crate) const MIN_INTERVAL: i64 = 900;
/// Prices older than this do not take part in the comparison.
const TREND_PRICE_AGE: i64 = WEEK;

/// Relative price position of `own` among `prices` (own included): 0 = cheapest, 1 = most expensive.
/// None without a comparison: fewer than two prices, or all prices equal.
fn price_position(own: i64, prices: &[i64]) -> Option<f64> {
    let (min, max) = (*prices.iter().min()?, *prices.iter().max()?);
    (max > min).then(|| (own - min) as f64 / (max - min) as f64)
}

/// Next price trend: the moving average moves a fifth of the way to the new position; unchanged without a comparison.
fn next_trend(score: f64, position: Option<f64>) -> f64 {
    position
        .map_or(score, |p| score + TREND_WEIGHT * (p - score))
        .clamp(0.0, 1.0)
}

/// Interval factor from the trend: 0 (steadily cheapest) → 0.5, 0.5 → 1, 1 (steadily most expensive) → 2.
fn trend_pace(score: f64) -> f64 {
    2f64.powf(2.0 * score - 1.0)
}

/// New price trend and pace of a measured product link, compared with the other confirmed, recently measured products
/// of the same wish in every region. Whether a product can be activated in the target country plays no part.
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
    let mut prices: Vec<i64> = others
        .iter()
        .filter_map(|raw| serde_json::from_str::<Product>(raw).ok())
        .filter(|other| other.availability == Availability::InStock)
        .filter_map(|other| crate::pricing::min_cents(&other))
        .collect();
    prices.push(own);
    let score = next_trend(score, price_position(own, &prices));
    Ok((score, trend_pace(score)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::jobs::{budget::demand, tests::*, *};
    #[test]
    fn price_trend_moves_slowly_and_maps_to_half_or_double_interval() {
        assert_eq!(price_position(1000, &[1000]), None);
        assert_eq!(price_position(1000, &[1000, 1000]), None);
        assert_eq!(price_position(1000, &[3000, 1000, 2000]), Some(0.0));
        assert_eq!(price_position(2000, &[3000, 1000, 2000]), Some(0.5));
        assert_eq!(price_position(3000, &[3000, 1000, 2000]), Some(1.0));
        // One cheap measurement moves the neutral trend a fifth of the way; without a comparison it stays.
        assert!((next_trend(0.5, Some(0.0)) - 0.4).abs() < 1e-9);
        assert_eq!(next_trend(0.3, None), 0.3);
        let mut score = 0.5;
        for _ in 0..20 {
            score = next_trend(score, Some(0.0));
        }
        assert!(score < 0.01, "{score}");
        assert!((trend_pace(0.0) - 0.5).abs() < 1e-9);
        assert!((trend_pace(0.5) - 1.0).abs() < 1e-9);
        assert!((trend_pace(1.0) - 2.0).abs() < 1e-9);
        // 8 h for every region alike: the steadily cheapest every 4 h, the most expensive every 16 h, a preview twice as
        // long; never beyond a week, never below 15 minutes.
        assert_eq!(effective_interval(8 * 3600, false, 0.5), 4 * 3600);
        assert_eq!(effective_interval(8 * 3600, false, 1.0), 8 * 3600);
        assert_eq!(effective_interval(8 * 3600, false, 2.0), 16 * 3600);
        assert_eq!(effective_interval(8 * 3600, true, 1.0), 16 * 3600);
        assert_eq!(effective_interval(WEEK, true, 2.0), WEEK);
        assert_eq!(effective_interval(900, false, 0.5), 900);
    }

    #[tokio::test]
    async fn cheap_regions_are_checked_more_often_expensive_and_sold_out_ones_less() {
        let pool = memory().await;
        sqlx::query("UPDATE app_settings SET target_country='DE'")
            .execute(&pool)
            .await
            .unwrap();
        const T0: i64 = 1_800_000_000 - 1_800_000_000 % DAY;
        // Only the product jobs of this wish (no discovery).
        sqlx::query("DELETE FROM shop_job WHERE link_id IS NULL")
            .execute(&pool)
            .await
            .unwrap();
        add_item(&pool, "w", "wished").await;
        // Regions that cannot count in DE at 1 €, 2 € and 3 €, one sold out, and a product valid in DE at 2.50 €:
        // all compared alike.
        let mut links = vec![];
        for n in 0..5 {
            links.push(add_link(&pool, "w", n, T0 + 100 * DAY).await);
        }
        let product = |n: usize| {
            let mut product = priced(n == 4);
            product.offers[0].cents = [100, 200, 300, 150, 250][n];
            if n == 3 {
                product.offers.clear();
                product.availability = Availability::SoldOut;
            }
            product
        };
        let mut t = T0;
        for _ in 0..12 {
            for (n, link) in links.iter().enumerate() {
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
                let work = Work::Product(Box::new(product(n)));
                complete(&pool, Shop::Eneba, &job, "aa", Ok(work), t, t, 1)
                    .await
                    .unwrap();
            }
            t += 3600;
        }
        let rows: Vec<(f64, f64, i64)> = sqlx::query_as(
                "SELECT l.cheap_score,j.pace,j.due-j.checked_at FROM offer_link l JOIN shop_job j ON j.link_id=l.id ORDER BY l.id",
            )
            .fetch_all(&pool)
            .await
            .unwrap();
        let interval = 8 * 3600;
        // Steadily the cheapest region: trend near 0, checked almost twice as often.
        assert!(rows[0].0 < 0.1 && rows[0].1 < 0.6, "{:?}", rows[0]);
        assert!(rows[0].2 < interval * 6 / 10, "{:?}", rows[0]);
        // 2 € between 1 € and 3 € (position 0.5): the plain interval.
        assert!((rows[1].1 - 1.0).abs() < 0.1, "{:?}", rows[1]);
        // Steadily the most expensive region: about half as often.
        assert!(rows[2].0 > 0.9 && rows[2].1 > 1.8, "{:?}", rows[2]);
        assert!(rows[2].2 > interval * 18 / 10, "{:?}", rows[2]);
        // Sold out: half as often until it is in stock again; its trend stays where it was.
        assert_eq!(
            (rows[3].0, rows[3].1, rows[3].2),
            (0.5, SOLD_OUT_PACE, 2 * interval)
        );
        // The product valid in DE is not preferred: 2.50 € (position 0.75) is checked less often than the plain interval.
        assert!(
            rows[4].0 > 0.65 && rows[4].1 > 1.3 && rows[4].1 < 1.5,
            "{:?}",
            rows[4]
        );
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
}
