use serde::{Deserialize, Serialize};

#[derive(Clone)]
pub(crate) struct Sample {
    pub link_id: i64,
    pub observed_at: i64,
    pub base_cents: Option<i64>,
    pub availability: String,
    pub region: Option<String>,
    pub source: String,
}
#[derive(Clone, Serialize, Deserialize, Debug, PartialEq)]
pub(crate) struct Point {
    pub observed_at: i64,
    pub base_cents: Option<i64>,
    pub link_id: Option<i64>,
    pub region: Option<String>,
    pub source: Option<String>,
}
pub(crate) fn minimum_series(samples: &[Sample]) -> Vec<Point> {
    use std::collections::{BTreeMap, BTreeSet};
    let Some(end) = samples.iter().map(|s| s.observed_at).max() else {
        return vec![];
    };
    let mut events: BTreeMap<i64, Vec<&Sample>> = BTreeMap::new();
    for sample in samples {
        events.entry(sample.observed_at).or_default().push(sample);
        let expires = sample.observed_at.saturating_add(crate::offers::FRESH);
        if expires <= end {
            events.entry(expires).or_default();
        }
    }
    let mut current: BTreeMap<i64, &Sample> = BTreeMap::new();
    let mut output = Vec::new();
    for (time, updates) in events {
        current.retain(|_, s| s.observed_at.saturating_add(crate::offers::FRESH) > time);
        let updated: BTreeSet<_> = updates.iter().map(|s| s.link_id).collect();
        for sample in updates {
            current.remove(&sample.link_id);
            if sample.availability == "in_stock" && sample.base_cents.is_some_and(|n| n > 0) {
                current.insert(sample.link_id, sample);
            }
        }
        let best = current
            .values()
            .min_by_key(|s| (s.base_cents.unwrap_or(i64::MAX), s.link_id));
        let point = Point {
            observed_at: time,
            base_cents: best.and_then(|s| s.base_cents),
            link_id: best.map(|s| s.link_id),
            region: best.and_then(|s| s.region.clone()),
            source: best.map(|s| s.source.clone()),
        };
        if !updated.is_empty()
            || output.last().is_some_and(|p: &Point| {
                p.link_id != point.link_id || p.base_cents != point.base_cents
            })
        {
            output.push(point);
        }
    }
    output
}

#[cfg(test)]
mod tests {
    use super::*;
    fn sample(id: i64, time: i64, cents: Option<i64>, region: &str) -> Sample {
        Sample {
            link_id: id,
            observed_at: time,
            base_cents: cents,
            region: Some(region.into()),
            source: "eneba".into(),
            availability: if cents.is_some() {
                "in_stock"
            } else {
                "sold_out"
            }
            .into(),
        }
    }
    #[test]
    fn minimum_changes_between_countries_and_retains_the_winning_region() {
        let points = minimum_series(&[
            sample(2, 200, Some(900), "Global"),
            sample(1, 100, Some(1000), "India"),
        ]);
        assert_eq!(
            points
                .iter()
                .map(|p| (p.observed_at, p.base_cents, p.region.as_deref()))
                .collect::<Vec<_>>(),
            vec![
                (100, Some(1000), Some("India")),
                (200, Some(900), Some("Global"))
            ]
        );
    }
    #[test]
    fn simultaneous_quotes_are_one_point_and_withdrawn_or_expired_prices_do_not_win() {
        let points = minimum_series(&[
            sample(1, 100, Some(900), "India"),
            sample(2, 100, Some(1000), "Global"),
            sample(1, 200, None, "India"),
            sample(3, 90000, Some(1200), "Europe"),
        ]);
        assert_eq!(points[0].base_cents, Some(900));
        assert_eq!(points[1].base_cents, Some(1000));
        assert!(
            points
                .iter()
                .any(|p| p.base_cents.is_none() && p.observed_at < 90000)
        );
        assert_eq!(points.last().unwrap().base_cents, Some(1200));
        assert!(minimum_series(&[]).is_empty());
    }
}
