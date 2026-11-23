//! One rule set for every price KeyHunter shows or alerts on.
//!
//! An offer counts as a *current* price only when the product matches the wish,
//! the mapping is confirmed, the product is an Xbox key, the last fetch succeeded
//! within [`fresh_for`] its check interval, the shop reports stock and the purchase
//! works in the requested scope. Every failed
//! check is reported as a [`Reason`], so views can explain why a price does not
//! count instead of silently hiding or showing it.
//!
//! A *last known* price passes every product, stock and region check and fails
//! only on age or on the latest fetch. Badges may display it, marked as stale;
//! best prices, history and alerts use current prices only.

use crate::offers::{Link, Wish};
use crate::shops::{Availability, Product};
use serde::Serialize;

/// Shortest freshness limit: an observation counts as current for at least this long.
pub(crate) const FRESH: i64 = 24 * 3600;

/// How long an observation of a link counts as current (FUNC-05, 0.9.3): twice the effective check interval of the
/// link (`offer_link` joined with its job, see `jobs::trend::effective_interval`), at least [`FRESH`]. A planned check that
/// comes on time therefore never lets a price go stale, whatever interval the owner chose. Without an interval (no
/// job yet) the floor applies. The one rule for every current/stale decision: prices, badges, KPIs, history, alerts.
pub(crate) fn fresh_for(check_every: Option<i64>) -> i64 {
    check_every.map_or(FRESH, |every| FRESH.max(every.saturating_mul(2)))
}
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
    /// Not an Xbox activation code for the wish's system (an account, a gift, a PC-only product), even when the
    /// owner confirmed the mapping by hand (FUNC-04). Never counts, not even as a last known price.
    NotAKey,
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

/// Member states of the EU: one market in which the shops sell a key at the same euro price (0.9.0).
pub(crate) const EU: [&str; 27] = [
    "AT", "BE", "BG", "CY", "CZ", "DE", "DK", "EE", "ES", "FI", "FR", "GR", "HR", "HU", "IE", "IT",
    "LT", "LU", "LV", "MT", "NL", "PL", "PT", "RO", "SE", "SI", "SK",
];

/// The shop page was read for a buyer in `context`; the price holds for `country` too when it is the
/// same country or both are in the EU (0.9.0: before, only the exact country, so only DE ever matched,
/// since the shops are read from a server in Germany). Activation stays a check of `country` itself.
pub(crate) fn same_market(context: &str, country: &str) -> bool {
    context == country || (EU.contains(&context) && EU.contains(&country))
}

/// Every purchase context whose observations can count for `country`: [`same_market`] as a list, for SQL filters.
pub(crate) fn markets(country: &str) -> Vec<&str> {
    if EU.contains(&country) {
        EU.to_vec()
    } else {
        vec![country]
    }
}

/// Whether a stored observation was a price for `country` (FUNC-02): read in the same market, and activatable there.
/// An observation stores the activation of its own purchase context; for another country of the same market the
/// current country list of the product counts, which belongs to the same product identity (fingerprint).
pub(crate) fn counts_in(market: &str, activation: &str, product: &Product, country: &str) -> bool {
    same_market(market, country)
        && if market == country {
            activation == "confirmed"
        } else {
            product.activation(country) == "confirmed"
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

    /// The offer works in the target country of a [`Scope::Target`] verdict: activation confirmed there and bought in
    /// the same market, regardless of age, stock and price (RESP-14: a cheaper region that is safe to buy for it).
    pub(crate) fn fits_target(&self) -> bool {
        ![
            Reason::NoTargetCountry,
            Reason::ActivationBlocked,
            Reason::ActivationUnknown,
            Reason::PurchaseContextMismatch,
        ]
        .into_iter()
        .any(|reason| self.has(reason))
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
    // A product confirmed by hand counts like a matching one; a changed product needs a new confirmation.
    if !link.confirmed(wish, product) {
        reasons.push(if wish.matches(product) || link.manual_match {
            Reason::NotConfirmed
        } else {
            Reason::Mismatch
        });
    }
    if !wish.takes_key(product) {
        reasons.push(Reason::NotAKey);
    }
    if link.last_error.is_some() {
        reasons.push(Reason::SourceError);
    }
    if !link.fresh(now) {
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
            if !product
                .purchase_country
                .as_deref()
                .is_some_and(|context| same_market(context, country))
            {
                reasons.push(Reason::PurchaseContextMismatch);
            }
        }
    }
    Verdict(reasons)
}

/// What the data of a link is worth right now, for the actions of an offer row (FUNC-03, RESP-11): `unknown` (not
/// observed yet, or the shop did not say whether it is in stock), `failed` (the latest fetch failed), `stale` (older
/// than the link's freshness limit) or `current`. Only a `current` price may be offered as a saving or a cart action.
pub(crate) fn data_state(link: &Link, product: Option<&Product>, now: i64) -> &'static str {
    match product {
        None => "unknown",
        Some(_) if link.last_error.is_some() => "failed",
        Some(_) if !link.fresh(now) => "stale",
        Some(product) if product.availability == Availability::Unknown => "unknown",
        Some(_) => "current",
    }
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

        // 0.9.0: a purchase context elsewhere in the EU counts as the same market, one outside does not.
        let mut neighbour = product();
        neighbour.purchase_country = Some("AT".into());
        assert!(reasons(&link(&neighbour), &neighbour, &de).is_empty());
        let mut elsewhere = product();
        elsewhere.purchase_country = Some("CH".into());
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

    /// FUNC-05 / SCORE-04: an observation stays current for twice its link's check interval, at least 24 h, so a
    /// long interval chosen by the owner does not let prices go stale between two planned checks.
    #[test]
    fn freshness_follows_the_check_interval_func05() {
        assert_eq!(fresh_for(None), FRESH);
        assert_eq!(fresh_for(Some(8 * 3600)), FRESH, "the 24 h floor");
        assert_eq!(fresh_for(Some(72 * 3600)), 144 * 3600);
        let de = Scope::target("DE");
        let p = product();
        let mut weekly = link(&p);
        weekly.check_every = Some(7 * 86400);
        weekly.observed_at = Some(NOW - 3 * 86400);
        assert!(
            reasons(&weekly, &p, &de).is_empty(),
            "checked weekly, three days old: current"
        );
        assert_eq!(data_state(&weekly, Some(&p), NOW), "current");
        weekly.observed_at = Some(NOW - 14 * 86400 - 1);
        assert_eq!(reasons(&weekly, &p, &de), [Reason::Stale]);
        assert_eq!(data_state(&weekly, Some(&p), NOW), "stale");
        let mut hourly = link(&p);
        hourly.check_every = Some(3600);
        hourly.observed_at = Some(NOW - FRESH - 1);
        assert_eq!(reasons(&hourly, &p, &de), [Reason::Stale]);
    }

    #[test]
    fn data_state_and_target_fit_of_an_offer() {
        let de = Scope::target("DE");
        let p = product();
        let l = link(&p);
        assert_eq!(data_state(&l, None, NOW), "unknown");
        let mut failed = link(&p);
        failed.last_error = Some("network".into());
        assert_eq!(data_state(&failed, Some(&p), NOW), "failed");
        let mut unsure = product();
        unsure.availability = Availability::Unknown;
        assert_eq!(data_state(&link(&unsure), Some(&unsure), NOW), "unknown");
        assert!(evaluate(&l, &wish(), Some(&p), &de, NOW).fits_target());
        let mut india = product();
        india.allowed.clear();
        india.region = Some("India".into());
        let verdict = evaluate(&link(&india), &wish(), Some(&india), &de, NOW);
        assert!(!verdict.fits_target(), "activation in DE unclear");
        let mut old = link(&p);
        old.observed_at = Some(NOW - FRESH - 1);
        assert!(
            evaluate(&old, &wish(), Some(&p), &de, NOW).fits_target(),
            "age does not decide the region"
        );
    }

    /// FUNC-04: a product confirmed by hand still has to be an Xbox key for the wish's system.
    #[test]
    fn accounts_and_pc_products_never_count_even_confirmed_by_hand_func04() {
        let de = Scope::target("DE");
        let mut account = product();
        account.key_game = false;
        let mut manual = link(&account);
        manual.manual_match = true;
        let verdict = evaluate(&manual, &wish(), Some(&account), &de, NOW);
        assert!(verdict.has(Reason::NotAKey));
        assert!(!verdict.eligible() && !verdict.last_known());
        let mut pc = product();
        pc.platform_ids = vec![6];
        let mut manual = link(&pc);
        manual.manual_match = true;
        assert!(reasons(&manual, &pc, &Scope::AllRegions).contains(&Reason::NotAKey));
        // An Xbox One key for a Series X|S wish runs backward compatible: confirmed by hand, it counts.
        let mut one = product();
        one.platform_ids = vec![49];
        let mut manual = link(&one);
        manual.manual_match = true;
        assert!(reasons(&manual, &one, &de).is_empty());
    }

    /// FUNC-02: the EU market as one list, and which stored observations count for a target country.
    #[test]
    fn observations_count_in_the_same_market_func02() {
        assert_eq!(markets("AT").len(), 27);
        assert_eq!(markets("CH"), ["CH"]);
        let mut p = product();
        p.allowed = vec!["DE".into(), "AT".into()];
        assert!(counts_in("DE", "confirmed", &p, "DE"));
        assert!(!counts_in("DE", "unknown", &p, "DE"), "its own activation");
        assert!(counts_in("DE", "unknown", &p, "AT"), "AT from the product");
        assert!(
            !counts_in("DE", "confirmed", &p, "FR"),
            "not activatable in FR"
        );
        assert!(!counts_in("US", "confirmed", &p, "AT"), "another market");
        assert!(!counts_in("DE", "confirmed", &p, ""));
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
