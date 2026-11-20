//! One rule set for every price KeyHunter shows or alerts on.
//!
//! An offer counts as a *current* price only when the product matches the wish,
//! the mapping is confirmed, the last fetch succeeded within [`FRESH`], the shop
//! reports stock and the purchase works in the requested scope. Every failed
//! check is reported as a [`Reason`], so views can explain why a price does not
//! count instead of silently hiding or showing it.
//!
//! A *last known* price passes every product, stock and region check and fails
//! only on age or on the latest fetch. Badges may display it, marked as stale;
//! best prices, history and alerts use current prices only.

use crate::offers::{Link, Wish};
use crate::shops::{Availability, Product};
use serde::Serialize;

/// An observation older than this no longer counts as a current price.
pub(crate) const FRESH: i64 = 24 * 3600;
pub(crate) const MAX_CENTS: i64 = 10_000_000;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum Reason {
    SourceDisabled,
    Rejected,
    NotObserved,
    Mismatch,
    NotConfirmed,
    SourceError,
    Stale,
    SoldOut,
    AvailabilityUnknown,
    NoPrice,
    NoTargetCountry,
    ActivationBlocked,
    ActivationUnknown,
    PurchaseContextMismatch,
}

impl Reason {
    /// Reasons that describe only the age of an observation or the latest fetch.
    fn about_freshness(self) -> bool {
        matches!(self, Self::Stale | Self::SourceError)
    }
}

/// Where a price has to be usable.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum Scope {
    /// Activation confirmed for, and purchase context observed in, this country.
    Target(String),
    /// Any region, regardless of activation in the target country.
    AllRegions,
}

impl Scope {
    pub(crate) fn target(country: &str) -> Self {
        Self::Target(country.to_string())
    }

    /// The scope of the wishlist badge setting (`preferred` or `all`).
    pub(crate) fn for_wishlist(country: &str, setting: &str) -> Self {
        if setting == "all" {
            Self::AllRegions
        } else {
            Self::target(country)
        }
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(transparent)]
pub(crate) struct Verdict(Vec<Reason>);

impl Verdict {
    pub(crate) fn eligible(&self) -> bool {
        self.0.is_empty()
    }

    pub(crate) fn last_known(&self) -> bool {
        !self.0.is_empty() && self.0.iter().all(|reason| reason.about_freshness())
    }

    pub(crate) fn has(&self, reason: Reason) -> bool {
        self.0.contains(&reason)
    }
}

pub(crate) fn valid_cents(cents: i64) -> bool {
    (1..=MAX_CENTS).contains(&cents)
}

/// Lowest valid quote of a product; zero, negative or absurd amounts never count.
pub(crate) fn min_cents(product: &Product) -> Option<i64> {
    product
        .offers
        .iter()
        .map(|quote| quote.cents)
        .filter(|cents| valid_cents(*cents))
        .min()
}

pub(crate) fn evaluate(
    link: &Link,
    wish: &Wish,
    product: Option<&Product>,
    scope: &Scope,
    now: i64,
) -> Verdict {
    let mut reasons = Vec::new();
    if !link.enabled {
        reasons.push(Reason::SourceDisabled);
    }
    if link.review == "rejected" {
        reasons.push(Reason::Rejected);
    }
    let Some(product) = product else {
        reasons.push(Reason::NotObserved);
        return Verdict(reasons);
    };
    if !wish.matches(product) {
        reasons.push(Reason::Mismatch);
    } else if !link.confirmed(wish, product) {
        reasons.push(Reason::NotConfirmed);
    }
    if link.last_error.is_some() {
        reasons.push(Reason::SourceError);
    }
    if !link
        .observed_at
        .is_some_and(|at| at <= now && now - at <= FRESH)
    {
        reasons.push(Reason::Stale);
    }
    match product.availability {
        Availability::InStock if min_cents(product).is_some() => {}
        Availability::InStock => reasons.push(Reason::NoPrice),
        Availability::SoldOut => reasons.push(Reason::SoldOut),
        Availability::Unknown => reasons.push(Reason::AvailabilityUnknown),
    }
    if let Scope::Target(country) = scope {
        if country.is_empty() {
            reasons.push(Reason::NoTargetCountry);
        } else {
            match product.activation(country) {
                "confirmed" => {}
                "blocked" => reasons.push(Reason::ActivationBlocked),
                _ => reasons.push(Reason::ActivationUnknown),
            }
            if product.purchase_country.as_deref() != Some(country.as_str()) {
                reasons.push(Reason::PurchaseContextMismatch);
            }
        }
    }
    Verdict(reasons)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub(crate) struct Best {
    pub cents: i64,
    pub link_id: i64,
    pub observed_at: i64,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct Prices {
    pub current: Option<Best>,
    pub last_known: Option<Best>,
}

/// Lowest current and lowest last known price. `amount` returns the compared
/// value of one link (base price or estimated total); ties prefer the newer
/// observation.
pub(crate) fn best<'a>(
    entries: impl IntoIterator<Item = (&'a Link, &'a Product, &'a Verdict)>,
    amount: impl Fn(&Link, &Product) -> Option<i64>,
) -> Prices {
    let pick = |slot: &mut Option<Best>, candidate: Best| {
        if slot.is_none_or(|old| {
            candidate.cents < old.cents
                || (candidate.cents == old.cents && candidate.observed_at > old.observed_at)
        }) {
            *slot = Some(candidate);
        }
    };
    let mut prices = Prices::default();
    for (link, product, verdict) in entries {
        let Some(cents) = amount(link, product).filter(|cents| valid_cents(*cents)) else {
            continue;
        };
        let candidate = Best {
            cents,
            link_id: link.id,
            observed_at: link.observed_at.unwrap_or_default(),
        };
        if verdict.eligible() {
            pick(&mut prices.current, candidate);
        } else if verdict.last_known() {
            pick(&mut prices.last_known, candidate);
        }
    }
    prices
}

/// Compared amount: the lowest base price.
pub(crate) fn base(_: &Link, product: &Product) -> Option<i64> {
    min_cents(product)
}

/// Compared amount: the lowest estimated total; `None` while the shop's fee estimate is off.
pub(crate) fn estimate(link: &Link, product: &Product) -> Option<i64> {
    min_cents(product).and_then(|cents| link.estimate(cents))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::shops::Quote;

    const NOW: i64 = 1_000_000;

    fn wish() -> Wish {
        Wish::from_parts(169, Some("Forza Horizon 5".into()), None)
    }

    fn product() -> Product {
        Product {
            id: "fh5".into(),
            name: "Forza Horizon 5".into(),
            title: "Forza Horizon 5".into(),
            platform_ids: vec![169, 49],
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
        }
    }

    fn link(product: &Product) -> Link {
        Link::fixture(1, "confirmed", Some(product.fingerprint()), Some(NOW - 60))
    }

    fn reasons(link: &Link, product: &Product, scope: &Scope) -> Vec<Reason> {
        evaluate(link, &wish(), Some(product), scope, NOW).0
    }

    #[test]
    fn decision_table() {
        let de = Scope::target("DE");
        let p = product();
        let l = link(&p);
        assert!(
            reasons(&l, &p, &de).is_empty(),
            "confirmed, fresh, in stock, DE"
        );
        assert!(reasons(&l, &p, &Scope::AllRegions).is_empty());

        let mut old = link(&p);
        old.observed_at = Some(NOW - FRESH - 1);
        assert_eq!(reasons(&old, &p, &de), [Reason::Stale]);
        assert!(evaluate(&old, &wish(), Some(&p), &de, NOW).last_known());

        let mut failed = link(&p);
        failed.last_error = Some("network".into());
        assert_eq!(reasons(&failed, &p, &de), [Reason::SourceError]);

        let mut paused = link(&p);
        paused.retry_at = NOW + 3600;
        assert!(
            reasons(&paused, &p, &de).is_empty(),
            "a shop pause alone never invalidates a fresh observation"
        );

        let mut blocked = product();
        blocked.blocked.push("DE".into());
        let verdict = evaluate(&link(&blocked), &wish(), Some(&blocked), &de, NOW);
        assert!(verdict.has(Reason::ActivationBlocked) && !verdict.last_known());

        let mut unknown = product();
        unknown.allowed.clear();
        assert!(reasons(&link(&unknown), &unknown, &de).contains(&Reason::ActivationUnknown));
        assert!(reasons(&link(&unknown), &unknown, &Scope::AllRegions).is_empty());

        let mut elsewhere = product();
        elsewhere.purchase_country = Some("AT".into());
        assert_eq!(
            reasons(&link(&elsewhere), &elsewhere, &de),
            [Reason::PurchaseContextMismatch]
        );

        assert!(reasons(&l, &p, &Scope::target("")).contains(&Reason::NoTargetCountry));

        let mut sold = product();
        sold.availability = Availability::SoldOut;
        sold.offers.clear();
        assert!(reasons(&link(&sold), &sold, &de).contains(&Reason::SoldOut));

        let mut zero = product();
        zero.offers[0].cents = 0;
        assert_eq!(reasons(&link(&zero), &zero, &de), [Reason::NoPrice]);

        let pending = Link::fixture(1, "pending", None, Some(NOW - 60));
        assert_eq!(reasons(&pending, &p, &de), [Reason::NotConfirmed]);

        let mut renamed = product();
        renamed.title = "Forza Horizon 5 Premium Edition".into();
        assert!(reasons(&l, &renamed, &de).contains(&Reason::Mismatch));

        let mut disabled = link(&p);
        disabled.enabled = false;
        assert_eq!(reasons(&disabled, &p, &de), [Reason::SourceDisabled]);

        let rejected = Link::fixture(1, "rejected", Some(p.fingerprint()), Some(NOW - 60));
        assert!(reasons(&rejected, &p, &de).contains(&Reason::Rejected));

        let unobserved = Link::fixture(1, "pending", None, None);
        assert_eq!(
            evaluate(&unobserved, &wish(), None, &de, NOW).0,
            [Reason::NotObserved]
        );
    }

    #[test]
    fn best_separates_current_and_last_known_prices() {
        let de = Scope::target("DE");
        let cheap_old = product();
        let mut cheap_old_link = link(&cheap_old);
        cheap_old_link.id = 1;
        cheap_old_link.observed_at = Some(NOW - FRESH - 10);
        let mut fresh = product();
        fresh.offers[0].cents = 2600;
        let mut fresh_link = link(&fresh);
        fresh_link.id = 2;
        let w = wish();
        let v1 = evaluate(&cheap_old_link, &w, Some(&cheap_old), &de, NOW);
        let v2 = evaluate(&fresh_link, &w, Some(&fresh), &de, NOW);
        let prices = best(
            [
                (&cheap_old_link, &cheap_old, &v1),
                (&fresh_link, &fresh, &v2),
            ],
            base,
        );
        assert_eq!(
            prices.current.map(|b| (b.cents, b.link_id)),
            Some((2600, 2))
        );
        assert_eq!(
            prices.last_known.map(|b| (b.cents, b.link_id)),
            Some((2392, 1))
        );

        let mut with_fee = link(&fresh);
        with_fee.fee_estimation_enabled = true;
        with_fee.fee_basis_points = 200;
        let v = evaluate(&with_fee, &w, Some(&fresh), &de, NOW);
        assert_eq!(
            best([(&with_fee, &fresh, &v)], estimate)
                .current
                .map(|b| b.cents),
            Some(2652)
        );
        let v = evaluate(&fresh_link, &w, Some(&fresh), &de, NOW);
        assert!(
            best([(&fresh_link, &fresh, &v)], estimate)
                .current
                .is_none(),
            "no estimate while the fee estimate is off"
        );
    }
}
