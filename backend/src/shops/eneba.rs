use super::{
    Availability, Product, Quote, SearchPage, Shop, ShopError, http::PublicClient, title_key,
};
use scraper::{Html, Selector};
use serde_json::Value;
use std::collections::BTreeSet;
use url::Url;

pub(super) fn parse(url: &Url, body: &str) -> Result<Product, ShopError> {
    let document = Html::parse_document(body);
    let selector = |css: &str| Selector::parse(css).expect("static selector");
    let script = document
        .select(&selector("script#__APOLLO_STATE__"))
        .next()
        .ok_or(ShopError::Parse)?
        .inner_html();
    let state: Value = serde_json::from_str(&script).map_err(|_| ShopError::Parse)?;
    let slug = url.path().rsplit('/').next().ok_or(ShopError::Parse)?;
    let product = &state[format!("Product::{slug}")];
    if product["slug"].as_str() != Some(slug) {
        return Err(ShopError::Parse);
    }
    let id = product["shortId"]
        .as_str()
        .filter(|id| {
            !id.is_empty() && id.len() <= 64 && id.bytes().all(|c| c.is_ascii_alphanumeric())
        })
        .ok_or(ShopError::Parse)?;
    let name = product["name"]
        .as_str()
        .filter(|name| !name.is_empty() && name.chars().count() <= 300)
        .ok_or(ShopError::Parse)?;
    let title = strip_suffix(&title_key(name))
        .map(strip_platforms)
        .unwrap_or_default()
        .to_string();
    let code = !title.is_empty()
        && product["drm"]["slug"] == "xbox"
        && product["category"] == "DIGITAL"
        && product.get("linkedProduct").is_some_and(Value::is_null)
        && !slug
            .split('-')
            .any(|word| matches!(word, "account" | "konto" | "upgrade" | "gift"));
    let dlc_word = slug.split('-').any(|word| word == "dlc");
    let key_game = code && product["type"]["value"] == "GAME" && !dlc_word;
    // An add-on key (1.1.6): typed DLC, or a game typed product with "dlc" in its address.
    let addon = code && (product["type"]["value"] == "DLC" || dlc_word);
    // Xbox 360 (0.8.2): Eneba lists the 360 classics it sells as Xbox One / Series X (backward compatible, checked
    // live), so a key marked for the 360 itself is rare; it is recognised all the same.
    let platform_ids = ["XBOX_SERIES_X", "XBOX_ONE", "XBOX_360"]
        .into_iter()
        .zip([169, 49, 12])
        .filter(|(value, _)| {
            product["worksOn"]
                .as_array()
                .is_some_and(|rows| rows.iter().any(|row| row["value"] == *value))
        })
        .map(|(_, id)| id)
        .collect();
    // An empty list (1.1.5): Eneba names no platform for some new Xbox Live keys. Windows alone stays a PC product.
    let platform_unknown = product["worksOn"].as_array().is_some_and(Vec::is_empty);
    let region = product["regions"]
        .as_array()
        .and_then(|rows| rows.first())
        .and_then(|row| row["name"].as_str())
        .map(|s| s.chars().take(80).collect());
    let blocked = countries(&product["blockedCountries"]);
    // Activation comes from the structured country list, not from page text. Without the
    // list the page structure changed, which must surface as a source error, not as
    // silently unconfirmed offers.
    let allowed: Vec<String> = product["countriesAlpha2"]
        .is_array()
        .then(|| countries(&product["countriesAlpha2"]))
        .ok_or(ShopError::Parse)?
        .into_iter()
        .filter(|c| !blocked.contains(c))
        .collect();
    let context = state["ROOT_QUERY"].as_object().and_then(|query| {
        query
            .iter()
            .filter(|(k, v)| k.starts_with("product(") && v["__ref"] == format!("Product::{slug}"))
            .filter_map(|(k, _)| {
                serde_json::from_str::<Value>(k.strip_prefix("product(")?.strip_suffix(')')?).ok()
            })
            .filter_map(|j| {
                j["context"]["country"]
                    .as_str()
                    .filter(|c| country_code(c))
                    .map(str::to_owned)
            })
            .collect::<BTreeSet<_>>()
            .into_iter()
            .next()
    });

    let mut refs = BTreeSet::new();
    if let Some(key) = product["preferredAuction"]["__ref"].as_str() {
        refs.insert(key);
    }
    if let Some(fields) = product.as_object() {
        for (key, connection) in fields {
            if key.starts_with("auctions(")
                && let Some(edges) = connection["edges"].as_array()
            {
                refs.extend(
                    edges
                        .iter()
                        .filter_map(|edge| edge["node"]["__ref"].as_str()),
                );
            }
        }
    }
    let mut offers: Vec<_> = refs
        .into_iter()
        .filter_map(|key| {
            let auction = &state[key];
            let offer_id = auction["id"].as_str()?;
            if key.strip_prefix("Auction::")? != offer_id
                || offer_id.len() > 80
                || auction["isInStock"] != true
                || auction["isPreOrder"] != false
            {
                return None;
            }
            let promo = &auction["promotionalPrice({\"currency\":\"EUR\"})"];
            let money = if promo.is_null() {
                &auction["price({\"currency\":\"EUR\"})"]
            } else {
                promo
            };
            let cents = money["amount"]
                .as_i64()
                .filter(|c| (1..=10_000_000).contains(c))?;
            if money["currency"] != "EUR" {
                return None;
            }
            Some(Quote {
                id: offer_id.to_string(),
                cents,
                seller: None,
            })
        })
        .collect();
    // Keep the cheapest offers when a page lists many sellers.
    offers.sort_by_key(|quote| quote.cents);
    offers.truncate(20);
    let availability = if !offers.is_empty() {
        Availability::InStock
    } else if document
        .select(&selector("script[type='application/ld+json']"))
        .any(|node| {
            serde_json::from_str::<Value>(&node.inner_html()).is_ok_and(|j| {
                j["@type"] == "Product"
                    && j["name"] == name
                    && j["offers"]["availability"] == "https://schema.org/SoldOut"
            })
        })
    {
        Availability::SoldOut
    } else {
        Availability::Unknown
    };

    Ok(Product {
        id: id.to_string(),
        name: name.to_string(),
        title,
        key_game,
        addon,
        platform_ids,
        platform_unknown,
        region,
        allowed,
        blocked,
        purchase_country: context,
        offers,
        availability,
    })
}

fn country_code(s: &str) -> bool {
    s.len() == 2 && s.bytes().all(|c| c.is_ascii_uppercase())
}

fn countries(value: &Value) -> Vec<String> {
    value
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .filter(|c| country_code(c))
        .take(260)
        .map(str::to_owned)
        .collect()
}

fn strip_suffix(name: &str) -> Option<&str> {
    [
        " pc xbox series x s xbox live key ",
        " xbox series x s xbox live key ",
        " pc xbox live key ",
        " xbox live key ",
        " pc xbox live key",
        " xbox live key",
    ]
    .into_iter()
    .find_map(|suffix| {
        if suffix.ends_with(' ') {
            name.rsplit_once(suffix).map(|(title, _)| title)
        } else {
            name.strip_suffix(suffix)
        }
    })
}

/// The title without a platform named in it before the key type (1.1.5): "SnowRunner - Premium Edition (Xbox One) Xbox
/// Live Key" is "snowrunner premium edition". The platforms come from the product data.
fn strip_platforms(mut title: &str) -> &str {
    while let Some(rest) = [
        " xbox series x s",
        " xbox series x",
        " xbox one",
        " windows 10",
        " windows",
        " pc",
        " dlc",
    ]
    .into_iter()
    .find_map(|platform| title.strip_suffix(platform))
    .filter(|rest| !rest.is_empty())
    {
        title = rest;
    }
    title
}

pub(super) async fn discover(shop: Shop, shard: usize) -> Result<Vec<(String, String)>, ShopError> {
    let mut client = PublicClient::new(shop).await?;
    let index = Url::parse("https://www.eneba.com/de/sitemap.xml").unwrap();
    let body = client.get(&index, 128 * 1024, false).await?;
    let paths: Vec<_> = sitemap_locs(&body)?
        .filter_map(|raw| {
            let url = Url::parse(raw).ok()?;
            let n = url
                .as_str()
                .strip_prefix("https://www.eneba.com/de/sitemap/products")?
                .strip_suffix(".xml")?
                .parse::<u16>()
                .ok()?;
            (n > 0).then_some(url)
        })
        .take(100)
        .collect();
    let path = paths
        .get(shard % paths.len().max(1))
        .ok_or(ShopError::Parse)?;
    let body = client.get(path, 2 * 1024 * 1024, true).await?;
    Ok(sitemap_locs(&body)?
        .filter_map(|raw| {
            let url = shop.product_url(raw)?;
            let slug = url.path().rsplit('/').next()?.strip_prefix("xbox-")?;
            let key = title_key(slug);
            Some((url.to_string(), strip_suffix(&key)?.to_string()))
        })
        .take(2000)
        .collect())
}

/// Extract complete loc elements from a bounded prefix. External entities and declarations are never processed.
pub(super) fn sitemap_locs(body: &str) -> Result<impl Iterator<Item = &str>, ShopError> {
    if body.contains("<!") || !(body.contains("<sitemapindex") || body.contains("<urlset")) {
        return Err(ShopError::Parse);
    }
    Ok(body
        .split("<loc>")
        .skip(1)
        .filter_map(|s| s.split_once("</loc>").map(|(v, _)| v.trim()))
        .filter(|s| !s.contains(['&', '<', '>'])))
}

fn search_urls(keys: &[String]) -> Vec<Url> {
    let Some(title) = keys.first() else {
        return vec![];
    };
    let slug = title.split_whitespace().collect::<Vec<_>>().join("-");
    if slug.len() < 2
        || !slug
            .bytes()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-')
    {
        return vec![];
    }
    [
        "pc-xbox-live-key-global",
        "xbox-live-key-global",
        "pc-xbox-live-key-europe",
        "xbox-live-key-europe",
    ]
    .iter()
    .filter_map(|suffix| {
        Shop::Eneba.product_url(&format!("https://www.eneba.com/de/xbox-{slug}-{suffix}"))
    })
    .collect()
}

/// The query of a public search page ([`search_page`]): only the title text, the type and platform filters and the
/// page number, so a shop client requests nothing else with a query.
pub(super) fn search_query(url: &Url) -> bool {
    url.host_str() == Some("www.eneba.com")
        && url.path() == "/de/store/all"
        && url.query().is_some_and(|q| q.len() <= 1500)
        && url.query_pairs().all(|(key, value)| match key.as_ref() {
            "text" => {
                !value.is_empty()
                    && value.chars().count() <= 300
                    && !value.chars().any(char::is_control)
            }
            "types[]" => value == "game",
            "drms[]" => value == "xbox",
            "page" => value.parse::<u16>().is_ok_and(|n| (1..=500).contains(&n)),
            _ => false,
        })
}

/// One public search page per durable job.
pub(super) async fn search_page(
    keys: &[String],
    known: &[String],
    page: i64,
) -> Result<SearchPage, ShopError> {
    let Some(key) = keys.first().filter(|key| !key.is_empty()) else {
        return Ok(SearchPage {
            urls: vec![],
            next_page: None,
        });
    };
    let mut url = Url::parse("https://www.eneba.com/de/store/all").unwrap();
    url.query_pairs_mut()
        .append_pair("text", key)
        .append_pair("types[]", "game")
        .append_pair("drms[]", "xbox")
        .append_pair("page", &page.to_string());
    let mut client = PublicClient::new(Shop::Eneba).await?;
    let mut result = match client.get(&url, 2 * 1024 * 1024, false).await {
        Ok(body) => parse_search_page(&body, keys, page)?,
        Err(ShopError::NotFound) if page == 1 => SearchPage {
            urls: search_urls(keys).into_iter().map(String::from).collect(),
            next_page: None,
        },
        Err(error) => return Err(error),
    };
    if page == 1 {
        for url in known.iter().filter_map(|raw| Shop::Eneba.product_url(raw)) {
            if !result.urls.contains(&url.to_string()) {
                result.urls.push(url.to_string());
            }
        }
    }
    Ok(result)
}

fn parse_search_page(body: &str, keys: &[String], page: i64) -> Result<SearchPage, ShopError> {
    let document = Html::parse_document(body);
    let selector = Selector::parse("script#__ALGOLIA_STATE__").expect("static selector");
    let script = document
        .select(&selector)
        .next()
        .ok_or(ShopError::Parse)?
        .inner_html();
    let state: Value = serde_json::from_str(&script).map_err(|_| ShopError::Parse)?;
    let result = state["responses"]
        .as_object()
        .into_iter()
        .flatten()
        .flat_map(|(_, response)| response["results"].as_array().into_iter().flatten())
        .find(|result| result["hits"].is_array() && result["nbHits"].is_u64())
        .ok_or(ShopError::Parse)?;
    let count = result["nbHits"]
        .as_u64()
        .filter(|n| *n <= 10000)
        .ok_or(ShopError::Parse)?;
    if !(1..=500).contains(&page) {
        return Err(ShopError::Parse);
    }
    // Extract the public product links rather than using the search service's API.
    let urls = collection_products(body, keys)
        .into_iter()
        .map(String::from)
        .collect();
    Ok(SearchPage {
        urls,
        next_page: ((page as u64) * 20 < count).then_some(page + 1),
    })
}

fn collection_slug(key: &str) -> String {
    let tokens: Vec<_> = key.split_whitespace().collect();
    let mut words = Vec::new();
    let mut i = 0;
    while i < tokens.len() {
        let start = i;
        while i < tokens.len()
            && tokens[i].len() == 1
            && tokens[i].bytes().all(|c| c.is_ascii_lowercase())
        {
            i += 1;
        }
        if i - start >= 3 {
            words.push(tokens[start..i].join(""));
        } else {
            words.extend(tokens[start..i].iter().map(|s| s.to_string()));
        }
        if i < tokens.len() {
            words.push(tokens[i].to_string());
            i += 1;
        }
    }
    words.join("-")
}

fn collection_products(body: &str, keys: &[String]) -> Vec<Url> {
    let document = Html::parse_document(body);
    let selector = Selector::parse("a[href]").expect("static selector");
    document
        .select(&selector)
        .filter_map(|node| {
            let href = node.value().attr("href")?;
            let base = Url::parse("https://www.eneba.com").ok()?;
            let url = Shop::Eneba.product_url(base.join(href).ok()?.as_str())?;
            let slug = url.path().rsplit('/').next()?.strip_prefix("xbox-")?;
            let key = title_key(slug);
            let title = strip_suffix(&key)?;
            keys.iter()
                .any(|k| *k == title || collection_slug(k) == collection_slug(title))
                .then_some(url)
        })
        .map(String::from)
        .collect::<BTreeSet<_>>()
        .into_iter()
        .filter_map(|raw| Url::parse(&raw).ok())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::shops::Product;

    const BASE: &str = include_str!("fixtures/eneba-product-base.html");
    const SEARCH: &str = include_str!("fixtures/eneba-search.html");
    const SLUG: &str = "xbox-forza-horizon-5-pc-xbox-live-key-global";
    const NAME: &str = "Forza Horizon 5 PC/XBOX LIVE Key GLOBAL";
    const A1: &str = "Auction::0a1b2c3d-0000-4000-8000-000000000001";
    const A2: &str = "Auction::0a1b2c3d-0000-4000-8000-000000000002";
    const APOLLO_OPEN: &str = r#"<script id="__APOLLO_STATE__" type="application/json">"#;
    const ALGOLIA_OPEN: &str = r#"<script id="__ALGOLIA_STATE__" type="application/json">"#;

    type Case = (&'static str, fn(&mut Value));

    fn url(slug: &str) -> Url {
        Url::parse(&format!("https://www.eneba.com/de/{slug}")).unwrap()
    }

    /// Rewrites the JSON inside the script that starts with `open`.
    fn rewrite(body: &str, open: &str, change: impl FnOnce(&mut Value)) -> String {
        let start = body.find(open).expect("script present") + open.len();
        let end = start + body[start..].find("</script>").expect("script closed");
        let mut json: Value = serde_json::from_str(&body[start..end]).unwrap();
        change(&mut json);
        format!("{}{}{}", &body[..start], json, &body[end..])
    }

    fn variant(change: impl FnOnce(&mut Value)) -> String {
        rewrite(BASE, APOLLO_OPEN, change)
    }

    fn product_of(state: &mut Value) -> &mut Value {
        &mut state[format!("Product::{SLUG}")]
    }

    fn parse_base() -> Product {
        parse(&url(SLUG), BASE).unwrap()
    }

    fn auction(id: &str, cents: i64) -> Value {
        serde_json::json!({
            "id": id,
            "price({\"currency\":\"EUR\"})": {"amount": cents, "currency": "EUR"},
            "promotionalPrice({\"currency\":\"EUR\"})": null,
            "isInStock": true,
            "isPreOrder": false
        })
    }

    fn offers(product: &Product) -> Vec<(&str, i64)> {
        product
            .offers
            .iter()
            .map(|q| (q.id.as_str(), q.cents))
            .collect()
    }

    #[test]
    fn product_base_game_global_returns_every_field() {
        let product = parse_base();
        assert_eq!(product.id, "synthproduct0001");
        assert_eq!(product.name, NAME);
        assert_eq!(product.title, "forza horizon 5");
        assert!(product.key_game);
        assert_eq!(product.platform_ids, [169, 49]);
        assert_eq!(product.region.as_deref(), Some("Global"));
        assert_eq!(product.allowed, ["AT", "DE", "FR"]);
        assert!(product.blocked.is_empty());
        assert_eq!(product.purchase_country.as_deref(), Some("DE"));
        assert_eq!(product.availability, Availability::InStock);
        assert!(product.offers.iter().all(|q| q.seller.is_none()));
        // The cheapest offer lives only in auctions({"first":1}); the preferred auction is dearer.
        assert!(product.offers.iter().any(|q| q.cents == 2392));
        // Offers are ordered by price.
        assert_eq!(
            offers(&product),
            [
                ("0a1b2c3d-0000-4000-8000-000000000002", 2392),
                ("0a1b2c3d-0000-4000-8000-000000000001", 2571)
            ]
        );
        assert_eq!(product.activation("DE"), "confirmed");
        assert_eq!(product.activation("AT"), "confirmed");
        assert_eq!(product.activation("IT"), "unknown");
        assert_eq!(product.activation(""), "unknown");
    }

    #[test]
    fn product_premium_edition_keeps_edition_in_title() {
        let premium = "Forza Horizon 5 Premium Edition PC/XBOX LIVE Key GLOBAL";
        let body = BASE.replace(NAME, premium);
        let product = parse(&url(SLUG), &body).unwrap();
        assert_eq!(product.title, "forza horizon 5 premium edition");
        assert_eq!(product.name, premium);
        assert!(product.key_game);
    }

    #[test]
    fn product_dlc_type_is_not_a_key_game() {
        let body = variant(|s| product_of(s)["type"]["value"] = "DLC".into());
        let product = parse(&url(SLUG), &body).unwrap();
        assert!(!product.key_game);
        assert_eq!(product.title, "forza horizon 5");
        assert_eq!(product.offers.len(), 2);
    }

    /// 1.1.6: an add-on key is typed DLC or has "dlc" in its address; accounts, gifts and upgrades are none.
    #[test]
    fn dlc_keys_are_add_ons_not_games() {
        let body = variant(|s| product_of(s)["type"]["value"] = "DLC".into());
        let product = parse(&url(SLUG), &body).unwrap();
        assert!(product.addon && !product.key_game);
        assert!(!parse_base().addon);
        assert_ne!(product.fingerprint(), parse_base().fingerprint());
        let slug = SLUG.replace("horizon-5", "horizon-5-dlc");
        let product = parse(&url(&slug), &BASE.replace(SLUG, &slug)).unwrap();
        assert!(product.addon && !product.key_game);
        for word in ["account", "konto", "upgrade", "gift"] {
            let slug = SLUG.replace("horizon-5", &format!("horizon-5-dlc-{word}"));
            let product = parse(&url(&slug), &BASE.replace(SLUG, &slug)).unwrap();
            assert!(!product.addon && !product.key_game, "{word}");
        }
        assert_eq!(
            strip_suffix(&title_key(
                "RoboCop: Rogue City - Unfinished Business (DLC) XBOX LIVE Key EUROPE"
            ))
            .map(strip_platforms),
            Some("robocop rogue city unfinished business")
        );
    }

    #[test]
    fn product_slug_words_account_konto_dlc_upgrade_gift_are_not_key_games() {
        for word in ["account", "konto", "dlc", "upgrade", "gift"] {
            let slug = SLUG.replace("horizon-5", &format!("horizon-5-{word}"));
            let body = BASE.replace(SLUG, &slug);
            let product = parse(&url(&slug), &body).unwrap();
            assert!(!product.key_game, "{word}");
        }
        // Only whole dash-separated words count.
        let slug = SLUG.replace("horizon-5", "horizon-5-accounting");
        let body = BASE.replace(SLUG, &slug);
        assert!(parse(&url(&slug), &body).unwrap().key_game);
    }

    #[test]
    fn product_other_game_checks_all_must_hold_for_key_game() {
        let cases: &[Case] = &[
            ("drm", |p| p["drm"]["slug"] = "steam".into()),
            ("category", |p| p["category"] = "PHYSICAL".into()),
            ("linked", |p| {
                p["linkedProduct"] = serde_json::json!({"__ref": "x"})
            }),
            ("type", |p| p["type"]["value"] = "SOFTWARE".into()),
        ];
        for (label, change) in cases {
            let body = variant(|s| change(product_of(s)));
            assert!(!parse(&url(SLUG), &body).unwrap().key_game, "{label}");
        }
        // A name without a recognised platform suffix yields an empty title and therefore no key game.
        let body = BASE.replace(NAME, "Forza Horizon 5");
        let product = parse(&url(SLUG), &body).unwrap();
        assert_eq!(product.title, "");
        assert!(!product.key_game);
    }

    #[test]
    fn product_pc_only_has_no_platform_ids() {
        let body = variant(|s| {
            product_of(s)["worksOn"] =
                serde_json::json!([{"label": "Windows", "value": "WINDOWS"}]);
        });
        let product = parse(&url(SLUG), &body).unwrap();
        assert!(product.platform_ids.is_empty());
        assert!(!product.platform_unknown, "Windows alone is a PC product");
        assert!(product.key_game);
        // 1.1.5: an empty list names no platform (new Xbox Live keys such as Prince of Persia: The Lost Crown).
        let body = variant(|s| product_of(s)["worksOn"] = serde_json::json!([]));
        let product = parse(&url(SLUG), &body).unwrap();
        assert!(product.platform_ids.is_empty() && product.platform_unknown);
        assert!(product.key_game);
        assert_ne!(product.fingerprint(), parse_base().fingerprint());
        assert!(!parse_base().platform_unknown);
        let body = variant(|s| {
            product_of(s)["worksOn"] = serde_json::json!([{"value": "XBOX_ONE"}]);
        });
        assert_eq!(parse(&url(SLUG), &body).unwrap().platform_ids, [49]);
        // 0.8.2: a key marked for the Xbox 360 itself.
        let body = variant(|s| {
            product_of(s)["worksOn"] = serde_json::json!([{"value": "XBOX_360"}]);
        });
        assert_eq!(parse(&url(SLUG), &body).unwrap().platform_ids, [12]);
    }

    #[test]
    fn product_blocked_country_wins_over_confirmed_activation() {
        let body =
            variant(|s| product_of(s)["blockedCountries"] = serde_json::json!(["DE", "xx", "FRA"]));
        let product = parse(&url(SLUG), &body).unwrap();
        // Malformed country codes are dropped.
        assert_eq!(product.blocked, ["DE"]);
        // A blocked country is never allowed, even when the country list names it.
        assert_eq!(product.allowed, ["AT", "FR"]);
        assert_eq!(product.activation("DE"), "blocked");
        assert_eq!(product.activation("AT"), "confirmed");
        assert_eq!(product.activation("IT"), "unknown");
    }

    #[test]
    fn product_activation_comes_from_the_structured_country_list() {
        // Page text does not matter (audit DQ-06): without the German sentence DE stays allowed.
        let body = BASE.replace(r#"Kann in <span>Deutschland</span> aktiviert werden"#, "");
        assert_eq!(
            parse(&url(SLUG), &body).unwrap().activation("DE"),
            "confirmed"
        );
        // DE not in countriesAlpha2.
        let body = variant(|s| product_of(s)["countriesAlpha2"] = serde_json::json!(["AT", "FR"]));
        let product = parse(&url(SLUG), &body).unwrap();
        assert_eq!(product.activation("DE"), "unknown");
        assert_eq!(product.activation("AT"), "confirmed");
        // An empty list allows nothing.
        let body = variant(|s| product_of(s)["countriesAlpha2"] = serde_json::json!([]));
        assert!(parse(&url(SLUG), &body).unwrap().allowed.is_empty());
        // A missing list is a changed page structure and fails loudly.
        let body = variant(|s| {
            product_of(s)
                .as_object_mut()
                .unwrap()
                .remove("countriesAlpha2");
        });
        assert!(matches!(parse(&url(SLUG), &body), Err(ShopError::Parse)));
        // The purchase context follows the page context; the evaluator compares it to the target.
        let body = variant(|s| {
            let root = s["ROOT_QUERY"].as_object_mut().unwrap();
            let rekeyed: serde_json::Map<String, Value> = root
                .iter()
                .map(|(k, v)| {
                    (
                        k.replace(r#""country":"DE""#, r#""country":"AT""#),
                        v.clone(),
                    )
                })
                .collect();
            *root = rekeyed;
        });
        assert_eq!(
            parse(&url(SLUG), &body)
                .unwrap()
                .purchase_country
                .as_deref(),
            Some("AT")
        );
        // No ROOT_QUERY entry with a country: purchase country unknown.
        let body = variant(|s| {
            s["ROOT_QUERY"] = serde_json::json!({});
        });
        assert_eq!(parse(&url(SLUG), &body).unwrap().purchase_country, None);
    }

    #[test]
    fn product_pre_order_auction_is_excluded() {
        let body = variant(|s| s[A2]["isPreOrder"] = true.into());
        let product = parse(&url(SLUG), &body).unwrap();
        assert_eq!(
            offers(&product),
            [("0a1b2c3d-0000-4000-8000-000000000001", 2571)]
        );
        assert_eq!(product.availability, Availability::InStock);
        // A missing isPreOrder flag is not "false" and is excluded as well.
        let body = variant(|s| {
            s[A2].as_object_mut().unwrap().remove("isPreOrder");
        });
        assert_eq!(parse(&url(SLUG), &body).unwrap().offers.len(), 1);
    }

    #[test]
    fn product_non_eur_zero_and_out_of_range_prices_are_excluded() {
        let price = r#"price({"currency":"EUR"})"#;
        let body = variant(|s| s[A2][price]["currency"] = "USD".into());
        assert_eq!(offers(&parse(&url(SLUG), &body).unwrap()).len(), 1);
        for cents in [0, -5, 10_000_001] {
            let body = variant(|s| s[A2][price]["amount"] = cents.into());
            assert_eq!(parse(&url(SLUG), &body).unwrap().offers.len(), 1, "{cents}");
        }
        let body = variant(|s| s[A2][price]["amount"] = 1.into());
        assert_eq!(parse(&url(SLUG), &body).unwrap().offers.len(), 2);
        // A fractional amount is not an integer and is dropped.
        let body = variant(|s| s[A2][price]["amount"] = 23.92.into());
        assert_eq!(parse(&url(SLUG), &body).unwrap().offers.len(), 1);
    }

    #[test]
    fn product_promotional_price_replaces_regular_price() {
        let promo = r#"promotionalPrice({"currency":"EUR"})"#;
        let body =
            variant(|s| s[A2][promo] = serde_json::json!({"amount": 1999, "currency": "EUR"}));
        assert!(
            offers(&parse(&url(SLUG), &body).unwrap())
                .contains(&("0a1b2c3d-0000-4000-8000-000000000002", 1999))
        );
        // A promotional price in another currency drops the offer; it does not fall back to the regular price.
        let body =
            variant(|s| s[A2][promo] = serde_json::json!({"amount": 1999, "currency": "USD"}));
        assert_eq!(parse(&url(SLUG), &body).unwrap().offers.len(), 1);
    }

    #[test]
    fn product_out_of_stock_and_inconsistent_auctions_are_excluded() {
        let body = variant(|s| s[A2]["isInStock"] = false.into());
        assert_eq!(parse(&url(SLUG), &body).unwrap().offers.len(), 1);
        // The id stored in the auction must equal the key suffix.
        let body = variant(|s| s[A2]["id"] = "something-else".into());
        assert_eq!(parse(&url(SLUG), &body).unwrap().offers.len(), 1);
        // Dangling reference.
        let body = variant(|s| {
            s.as_object_mut().unwrap().remove(A2);
        });
        assert_eq!(parse(&url(SLUG), &body).unwrap().offers.len(), 1);
    }

    #[test]
    fn product_offers_are_capped_at_twenty() {
        let body = variant(|s| {
            let mut edges = Vec::new();
            for n in 10..40 {
                let key = format!("Auction::0a1b2c3d-0000-4000-8000-0000000001{n}");
                let cents = if n == 39 { 999 } else { 3000 + n };
                s[key.as_str()] = auction(&key["Auction::".len()..], cents);
                edges.push(serde_json::json!({"node": {"__ref": key}}));
            }
            product_of(s)["auctions({\"first\":30})"] = serde_json::json!({"edges": edges});
        });
        let product = parse(&url(SLUG), &body).unwrap();
        assert_eq!(product.offers.len(), 20);
        // The cap keeps the cheapest offers, even when they come last.
        assert_eq!(product.offers[0].cents, 999);
        assert!(product.offers.windows(2).all(|w| w[0].cents <= w[1].cents));
        assert!(!product.offers.iter().any(|q| q.cents == 3038));
    }

    #[test]
    fn product_sold_out_needs_json_ld_and_no_offers() {
        let sold_out = BASE.replace("https://schema.org/InStock", "https://schema.org/SoldOut");
        let none_in_stock = rewrite(&sold_out, APOLLO_OPEN, |s| {
            s[A1]["isInStock"] = false.into();
            s[A2]["isInStock"] = false.into();
        });
        let product = parse(&url(SLUG), &none_in_stock).unwrap();
        assert_eq!(product.availability, Availability::SoldOut);
        assert!(product.offers.is_empty());
        // Without the SoldOut marker the state is merely unknown.
        let unknown = rewrite(BASE, APOLLO_OPEN, |s| {
            s[A1]["isInStock"] = false.into();
            s[A2]["isInStock"] = false.into();
        });
        let product = parse(&url(SLUG), &unknown).unwrap();
        assert_eq!(product.availability, Availability::Unknown);
        assert!(product.offers.is_empty());
        // The JSON-LD block must describe the same product name.
        let other = none_in_stock.replace(
            r#""name": "Forza Horizon 5 PC/XBOX LIVE Key GLOBAL""#,
            r#""name": "Other""#,
        );
        assert_ne!(other, none_in_stock);
        assert_eq!(
            parse(&url(SLUG), &other).unwrap().availability,
            Availability::Unknown
        );
        // Offers win over a SoldOut marker.
        let product = parse(&url(SLUG), &sold_out).unwrap();
        assert_eq!(product.availability, Availability::InStock);
    }

    #[test]
    fn product_without_apollo_state_or_with_wrong_identity_is_a_parse_error() {
        assert!(matches!(
            parse(&url(SLUG), "<html><body>Access denied</body></html>"),
            Err(ShopError::Parse)
        ));
        assert!(matches!(
            parse(&url(SLUG), &format!("{APOLLO_OPEN}{{not json</script>")),
            Err(ShopError::Parse)
        ));
        // The URL slug must match the product in the state.
        assert!(matches!(
            parse(&url("xbox-other-pc-xbox-live-key-global"), BASE),
            Err(ShopError::Parse)
        ));
        let cases: &[Case] = &[
            ("empty id", |p| p["shortId"] = "".into()),
            ("id with symbol", |p| p["shortId"] = "a-b".into()),
            ("empty name", |p| p["name"] = "".into()),
            ("slug field differs", |p| p["slug"] = "other".into()),
        ];
        for (label, change) in cases {
            let body = variant(|s| change(product_of(s)));
            assert!(
                matches!(parse(&url(SLUG), &body), Err(ShopError::Parse)),
                "{label}"
            );
        }
    }

    #[test]
    fn product_region_is_first_region_name_limited_to_80_chars() {
        let long = "R".repeat(100);
        let body = variant(|s| {
            product_of(s)["regions"] = serde_json::json!([{"name": long}, {"name": "x"}])
        });
        assert_eq!(
            parse(&url(SLUG), &body)
                .unwrap()
                .region
                .unwrap()
                .chars()
                .count(),
            80
        );
        let body = variant(|s| product_of(s)["regions"] = serde_json::json!([]));
        assert_eq!(parse(&url(SLUG), &body).unwrap().region, None);
    }

    #[test]
    fn fingerprint_identity_ignores_offers_and_punctuation_but_not_platforms() {
        let base = parse_base();
        let mut same = base.clone();
        same.offers.clear();
        same.title = "Forza Horizon 5: Renamed by the shop".into();
        same.name = same.title.clone();
        assert_eq!(
            base.fingerprint(),
            same.fingerprint(),
            "a renamed title keeps the identity"
        );
        let mut other = base.clone();
        other.id = "synthproduct0002".into();
        assert_ne!(base.fingerprint(), other.fingerprint());
        let mut other = base.clone();
        other.platform_ids = vec![49];
        assert_ne!(base.fingerprint(), other.fingerprint());
        let mut other = base.clone();
        other.key_game = false;
        assert_ne!(base.fingerprint(), other.fingerprint());
        assert_eq!(base.fingerprint().len(), 64);
    }

    #[test]
    fn strip_suffix_recognises_known_platform_suffixes_only() {
        assert_eq!(strip_suffix("a pc xbox live key global"), Some("a"));
        assert_eq!(strip_suffix("a xbox live key europe"), Some("a"));
        assert_eq!(
            strip_suffix("a xbox series x s xbox live key global"),
            Some("a")
        );
        assert_eq!(strip_suffix("a pc xbox live key"), Some("a"));
        assert_eq!(strip_suffix("a xbox live key"), Some("a"));
        assert_eq!(strip_suffix("a"), None);
        assert_eq!(strip_suffix("a steam key global"), None);
        // The last occurrence wins for suffixes followed by a region.
        assert_eq!(
            strip_suffix("a pc xbox live key b pc xbox live key global"),
            Some("a pc xbox live key b")
        );
    }

    /// 1.1.5: a platform in the name before the key type is not part of the title (SnowRunner, checked live).
    #[test]
    fn a_platform_in_the_name_is_not_part_of_the_title() {
        let title =
            |name: &str| strip_suffix(&title_key(name)).map(|t| strip_platforms(t).to_string());
        assert_eq!(
            title("SnowRunner - Premium Edition (Xbox One) Xbox Live Key EUROPE"),
            Some("snowrunner premium edition".into())
        );
        assert_eq!(
            title("Forza Horizon 5 (Xbox Series X|S / Xbox One) XBOX LIVE Key GLOBAL"),
            Some("forza horizon 5".into())
        );
        assert_eq!(
            title("Prince of Persia: The Lost Crown - Complete Edition XBOX LIVE Key AUSTRALIA"),
            Some("prince of persia the lost crown complete edition".into())
        );
        assert_eq!(title("Halo PC XBOX LIVE Key GLOBAL"), Some("halo".into()));
        // A title that is only a platform word stays as it is.
        assert_eq!(title("PC Xbox Live Key"), Some("pc".into()));
    }

    fn search(change: impl FnOnce(&mut Value)) -> String {
        rewrite(SEARCH, ALGOLIA_OPEN, change)
    }

    fn hits_result(s: &mut Value) -> &mut Value {
        let responses = s["responses"].as_object_mut().unwrap();
        &mut responses.values_mut().next().unwrap()["results"][1]
    }

    #[test]
    fn search_fixture_paginates_by_hits_per_page_of_twenty() {
        let keys = ["forza horizon 5".to_string()];
        let cases = [
            (41, 1, Some(2)),
            (41, 2, Some(3)),
            (41, 3, None),
            (40, 2, None),
            (40, 1, Some(2)),
            (20, 1, None),
            (21, 1, Some(2)),
            (0, 1, None),
        ];
        for (hits, page, next) in cases {
            let body = search(|s| hits_result(s)["nbHits"] = hits.into());
            let result = parse_search_page(&body, &keys, page).unwrap();
            assert_eq!(result.next_page, next, "nbHits {hits} page {page}");
        }
        // Boundaries of the accepted ranges.
        let body = search(|s| hits_result(s)["nbHits"] = 10_000.into());
        assert_eq!(
            parse_search_page(&body, &keys, 500).unwrap().next_page,
            None
        );
        assert_eq!(
            parse_search_page(&body, &keys, 499).unwrap().next_page,
            Some(500)
        );
        assert!(parse_search_page(&body, &keys, 501).is_err());
        assert!(parse_search_page(&body, &keys, -1).is_err());
        let body = search(|s| hits_result(s)["nbHits"] = 10_001.into());
        assert!(parse_search_page(&body, &keys, 1).is_err());
    }

    #[test]
    fn search_fixture_keeps_regional_variants_but_not_other_editions() {
        let keys = ["forza horizon 5".to_string()];
        let result = parse_search_page(SEARCH, &keys, 1).unwrap();
        let mut urls = result.urls.clone();
        urls.sort();
        // Output is sorted and deduplicated; the console spelling matches via the title comparison.
        assert_eq!(
            result.urls,
            [
                "https://www.eneba.com/de/xbox-forza-horizon-5-pc-xbox-live-key-argentina",
                "https://www.eneba.com/de/xbox-forza-horizon-5-pc-xbox-live-key-turkey",
                "https://www.eneba.com/de/xbox-forza-horizon-5-xbox-series-x-s-xbox-live-key-global",
            ]
        );
        assert_eq!(urls, result.urls);
        // A different key selects a different set; no key match means no links (but still Ok).
        let other = parse_search_page(SEARCH, &["starfield".to_string()], 1).unwrap();
        assert!(other.urls.is_empty());
        assert_eq!(other.next_page, Some(2));
        // Links are matched against any of the keys, not just the first one.
        let both = parse_search_page(
            SEARCH,
            &[
                "starfield".to_string(),
                "forza horizon 5 premium edition".to_string(),
            ],
            1,
        )
        .unwrap();
        assert_eq!(
            both.urls,
            [
                "https://www.eneba.com/de/xbox-forza-horizon-5-premium-edition-pc-xbox-live-key-global"
            ]
        );
    }

    #[test]
    fn search_changed_structure_is_an_error_not_an_empty_result() {
        let keys = ["forza horizon 5".to_string()];
        assert!(parse_search_page("<html><body>Changed</body></html>", &keys, 1).is_err());
        assert!(parse_search_page(&format!("{ALGOLIA_OPEN}nope</script>"), &keys, 1).is_err());
        let broken: &[fn(&mut Value)] = &[
            |s| *s = serde_json::json!({}),
            |s| s["responses"] = serde_json::json!([]),
            |s| s["responses"] = serde_json::json!({"q": {"results": []}}),
            |s| hits_result(s)["hits"] = "none".into(),
            |s| hits_result(s)["nbHits"] = "41".into(),
        ];
        for (n, change) in broken.iter().enumerate() {
            let body = search(change);
            assert!(parse_search_page(&body, &keys, 1).is_err(), "case {n}");
        }
        // The result entry carrying hits+nbHits is found even if it is not the first one.
        assert!(parse_search_page(SEARCH, &keys, 1).is_ok());
    }

    #[test]
    fn search_page_with_state_but_no_links_is_ok_and_empty() {
        // KNOWN BEHAVIOUR: a valid state without product links is an empty page, not an error.
        let body = format!(
            "{ALGOLIA_OPEN}{}</script>",
            serde_json::json!({"responses": {"q": {"results": [{"hits": [], "nbHits": 0}]}}})
        );
        let result = parse_search_page(&body, &["forza horizon 5".to_string()], 1).unwrap();
        assert!(result.urls.is_empty());
        assert_eq!(result.next_page, None);
    }

    #[test]
    fn sitemap_locs_accepts_index_and_urlset_and_skips_unsafe_values() {
        let index = "<sitemapindex><sitemap><loc> https://www.eneba.com/de/sitemap/products1.xml </loc></sitemap></sitemapindex>";
        assert_eq!(
            sitemap_locs(index).unwrap().collect::<Vec<_>>(),
            ["https://www.eneba.com/de/sitemap/products1.xml"]
        );
        let set = "<urlset><url><loc>https://a/x?a=1&amp;b=2</loc></url><url><loc>https://a/ok</loc></url></urlset>";
        assert_eq!(
            sitemap_locs(set).unwrap().collect::<Vec<_>>(),
            ["https://a/ok"]
        );
        assert!(sitemap_locs("<html><loc>https://a</loc></html>").is_err());
        assert!(sitemap_locs("").is_err());
    }

    #[test]
    fn public_search_pages_continue_until_every_region_is_processed() {
        let state =
            serde_json::json!({"responses":{"fixture":{"results":[{"nbHits":41,"hits":[]}]}}});
        let html = format!(
            r#"<script id="__ALGOLIA_STATE__">{state}</script>
            <a href="/de/xbox-forza-horizon-5-pc-xbox-live-key-argentina">Argentina</a>
            <a href="/de/xbox-forza-horizon-5-pc-xbox-live-key-turkey">Turkey</a>
            <a href="/de/xbox-forza-horizon-5-premium-edition-pc-xbox-live-key-global">Different edition</a>"#
        );
        let keys = ["forza horizon 5".into()];
        for (page, next) in [(1, Some(2)), (2, Some(3)), (3, None)] {
            let result = parse_search_page(&html, &keys, page).unwrap();
            assert_eq!(result.next_page, next);
            assert_eq!(result.urls.len(), 2);
            assert!(result.urls.iter().any(|url| url.ends_with("-argentina")));
        }
        assert!(parse_search_page("<html>Changed source response</html>", &keys, 1).is_err());
        assert!(parse_search_page(&html, &keys, 0).is_err());
    }
    #[test]
    fn collection_keeps_all_distinct_regional_variants() {
        let mut html = String::new();
        for region in 0..40 {
            let link = format!(
                "<a href='/xbox-forza-horizon-5-pc-xbox-live-key-country-{region}'>Game</a>"
            );
            html.push_str(&link);
            html.push_str(&link);
        }
        let urls = collection_products(&html, &["forza horizon 5".into()]);
        assert_eq!(
            urls.len(),
            40,
            "duplicates must not crowd out regional variants"
        );
    }
    #[test]
    fn public_collection_extracts_matching_game_across_platform_spellings() {
        let html = r#"<a href="/xbox-starfield-pc-xbox-series-x-s-xbox-live-key-global">Starfield</a>
            <a href="/xbox-starfield-premium-edition-pc-xbox-series-x-s-xbox-live-key-global">Premium</a>
            <a href="https://untrusted.example/xbox-starfield-pc-xbox-live-key-global">foreign</a>"#;
        let urls = collection_products(html, &["starfield".into()]);
        assert_eq!(urls.len(), 1);
        assert!(
            urls[0]
                .path()
                .ends_with("starfield-pc-xbox-series-x-s-xbox-live-key-global")
        );
        assert_eq!(
            strip_suffix("starfield pc xbox series x s xbox live key global"),
            Some("starfield")
        );
        assert_eq!(
            collection_slug("s t a l k e r 2 heart of chornobyl"),
            "stalker-2-heart-of-chornobyl"
        );
    }
    #[test]
    fn targeted_urls_preserve_game_and_edition_and_exclude_unrepresentable_titles() {
        let base = search_urls(&["forza horizon 5".into()]);
        assert_eq!(
            base[0].as_str(),
            "https://www.eneba.com/de/xbox-forza-horizon-5-pc-xbox-live-key-global"
        );
        let premium = search_urls(&["forza horizon 5 premium edition".into()]);
        assert!(
            premium
                .iter()
                .all(|url| url.path().contains("premium-edition"))
        );
        assert!(search_urls(&["遊戲".into()]).is_empty());
        assert!(search_urls(&[]).is_empty());
    }
    #[test]
    fn sitemap_ignores_partial_elements_and_rejects_declarations() {
        assert!(sitemap_locs("<!DOCTYPE example><urlset><loc>&xxe;</loc>").is_err());
        assert_eq!(
            sitemap_locs("<urlset><loc>https://example.com</loc><loc>partial")
                .unwrap()
                .collect::<Vec<_>>(),
            ["https://example.com"]
        );
    }
}
