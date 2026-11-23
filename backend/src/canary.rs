//! Parser canary (PROD-13): `keyhunter --canary <product-link>...` fetches one product page per shop through the
//! app's own client (robots.txt, crawl delay, user agent, address checks) and reports whether the parser still finds
//! products with prices. It runs only by hand, only with `KEYHUNTER_CANARY_CONSENT=1` and says first what it contacts.
//! No other code starts it: not the server, not the tests, not `deploy/check.sh`.
use crate::shops::{Availability, Product, Shop, ShopError};
use anyhow::{Result, bail};
use url::Url;

pub const CONSENT_VARIABLE: &str = "KEYHUNTER_CANARY_CONSENT";

fn consented(value: Option<&str>) -> bool {
    value == Some("1")
}

/// One product link per shop; anything else is refused before a request is made.
fn targets(args: &[String]) -> Result<Vec<(Shop, Url)>> {
    let mut targets: Vec<(Shop, Url)> = Vec::new();
    for arg in args {
        let Some((shop, url)) = crate::shops::product_link(arg) else {
            bail!(
                "{arg:?} is no product link of a supported shop (https://www.eneba.com/de/xbox-…-key-…, https://driffle.com/de/…-xbox-live-digital-…-p<number>)"
            );
        };
        if targets.iter().any(|(known, _)| *known == shop) {
            bail!(
                "Give one product link per shop; {} appears twice",
                shop.name()
            );
        }
        targets.push((shop, url));
    }
    if targets.is_empty() {
        bail!(
            "Give one product link per shop to check, e.g. keyhunter --canary <eneba-link> <driffle-link>"
        );
    }
    Ok(targets)
}

fn announcement(targets: &[(Shop, Url)]) -> String {
    let mut text = String::from(
        "KeyHunter parser canary. This contacts, with the user agent \"Keyhunter\", respecting robots.txt and the crawl delay:\n",
    );
    for (shop, url) in targets {
        text.push_str(&format!(
            "  {}: https://{}/robots.txt and {}\n",
            shop.name(),
            shop.host(),
            url
        ));
    }
    text.push_str("Nothing is stored; the database is not opened.\n");
    text
}

/// Whether a result shows a working parser: a product with at least one price.
fn verdict(result: &Result<Product, ShopError>) -> (bool, String) {
    match result {
        Ok(product) if product.offers.iter().any(|offer| offer.cents > 0) => {
            let lowest = product
                .offers
                .iter()
                .map(|o| o.cents)
                .filter(|c| *c > 0)
                .min();
            (
                true,
                format!(
                    "ok: \"{}\", {} offer(s), from {} cents",
                    product.name,
                    product.offers.len(),
                    lowest.unwrap_or_default()
                ),
            )
        }
        Ok(product) if product.availability == Availability::SoldOut => (
            false,
            format!(
                "page read, \"{}\" is sold out; no price to compare, try another link",
                product.name
            ),
        ),
        Ok(product) => (
            false,
            format!(
                "page read, \"{}\" but no price found: the parser may be broken",
                product.name
            ),
        ),
        Err(error) => (
            false,
            format!(
                "failed ({}): the page or the parser changed, or the shop refused",
                error.code()
            ),
        ),
    }
}

/// Runs the canary and returns whether every shop passed. `consent` is the value of [`CONSENT_VARIABLE`].
pub async fn run(args: &[String], consent: Option<&str>) -> Result<bool> {
    if !consented(consent) {
        bail!(
            "The canary contacts the shops. Set {CONSENT_VARIABLE}=1 to confirm that you want this run (deploy/parser-canary.sh lists what it would contact first and passes your consent on)."
        );
    }
    let targets = targets(args)?;
    print!("{}", announcement(&targets));
    let mut all = true;
    for (shop, url) in &targets {
        let (passed, text) = verdict(&shop.product(url).await);
        all &= passed;
        println!("{}: {text}", shop.name());
    }
    Ok(all)
}

#[cfg(test)]
mod tests {
    use super::*;

    const ENEBA: &str = include_str!("shops/fixtures/eneba-product-base.html");
    const DRIFFLE: &str = include_str!("shops/fixtures/driffle-product-base.html");
    const ENEBA_LINK: &str =
        "https://www.eneba.com/de/xbox-forza-horizon-5-pc-xbox-live-key-global";
    const DRIFFLE_LINK: &str = "https://driffle.com/de/forza-horizon-5-standard-edition-pc-xbox-one-xbox-series-xs-xbox-live-digital-code-p100001";

    fn args(links: &[&str]) -> Vec<String> {
        links.iter().map(|l| l.to_string()).collect()
    }

    #[test]
    fn only_the_exact_consent_value_lets_the_canary_run() {
        for value in [None, Some(""), Some("0"), Some("true"), Some("yes")] {
            assert!(!consented(value), "{value:?}");
        }
        assert!(consented(Some("1")));
    }

    #[tokio::test]
    async fn without_consent_it_refuses_before_any_request() {
        let error = run(&args(&[ENEBA_LINK]), None).await.unwrap_err();
        assert!(error.to_string().contains(CONSENT_VARIABLE));
        let error = run(&args(&[ENEBA_LINK]), Some("0")).await.unwrap_err();
        assert!(error.to_string().contains(CONSENT_VARIABLE));
    }

    /// The refusal points to deploy/parser-canary.sh as the script that lists what a run contacts before it passes the
    /// consent on; the script does exactly that, in that order.
    #[test]
    fn the_script_lists_what_it_contacts_before_it_passes_consent_on() {
        let script = std::fs::read_to_string(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../deploy/parser-canary.sh"),
        )
        .unwrap();
        let listed = script
            .find("/robots.txt and $link")
            .expect("lists hosts and pages");
        let checked = script
            .find(&format!("\"${{{CONSENT_VARIABLE}:-}}\" != 1"))
            .expect("checks the consent");
        let started = script.rfind("--canary").expect("starts the canary");
        assert!(listed < checked && checked < started);
    }

    #[test]
    fn links_must_be_known_product_pages_one_per_shop() {
        assert!(targets(&[]).is_err());
        assert!(targets(&args(&["https://example.com/de/xbox-game-key-1"])).is_err());
        assert!(targets(&args(&["https://www.eneba.com/de/store/all"])).is_err());
        assert!(targets(&args(&[ENEBA_LINK, ENEBA_LINK])).is_err());
        assert_eq!(
            targets(&args(&[ENEBA_LINK, DRIFFLE_LINK])).unwrap().len(),
            2
        );
    }

    #[test]
    fn the_announcement_names_every_host_and_page() {
        let text = announcement(&targets(&args(&[ENEBA_LINK, DRIFFLE_LINK])).unwrap());
        for expected in [
            "https://www.eneba.com/robots.txt",
            ENEBA_LINK,
            "https://driffle.com/robots.txt",
            DRIFFLE_LINK,
            "Keyhunter",
        ] {
            assert!(text.contains(expected), "{expected}");
        }
    }

    #[test]
    fn fixture_pages_pass_and_a_changed_page_fails() {
        for (shop, link, page) in [
            (Shop::Eneba, ENEBA_LINK, ENEBA),
            (Shop::Driffle, DRIFFLE_LINK, DRIFFLE),
        ] {
            let url = Url::parse(link).unwrap();
            let (passed, text) = verdict(&shop.parse(&url, page));
            assert!(passed, "{text}");
            let (passed, text) =
                verdict(&shop.parse(&url, "<html><body>Neues Layout</body></html>"));
            assert!(!passed);
            assert!(text.contains("invalid_response"), "{text}");
        }
    }

    #[test]
    fn a_product_without_any_price_does_not_pass() {
        let url = Url::parse(ENEBA_LINK).unwrap();
        let mut product = Shop::Eneba.parse(&url, ENEBA).unwrap();
        product.offers.clear();
        product.availability = Availability::SoldOut;
        let (passed, text) = verdict(&Ok(product.clone()));
        assert!(!passed && text.contains("sold out"), "{text}");
        product.availability = Availability::InStock;
        let (passed, text) = verdict(&Ok(product));
        assert!(!passed && text.contains("no price"), "{text}");
    }
}
