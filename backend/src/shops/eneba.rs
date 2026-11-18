use super::{Availability, Product, Quote, Shop, ShopError, http::PublicClient, title_key};
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
        .unwrap_or_default()
        .to_string();
    let key_game = !title.is_empty()
        && product["type"]["value"] == "GAME"
        && product["drm"]["slug"] == "xbox"
        && product["category"] == "DIGITAL"
        && product.get("linkedProduct").is_some_and(Value::is_null)
        && !slug
            .split('-')
            .any(|word| matches!(word, "account" | "konto" | "dlc" | "upgrade" | "gift"));
    let platform_ids = ["XBOX_SERIES_X", "XBOX_ONE"]
        .into_iter()
        .zip([169, 49])
        .filter(|(value, _)| {
            product["worksOn"]
                .as_array()
                .is_some_and(|rows| rows.iter().any(|row| row["value"] == *value))
        })
        .map(|(_, id)| id)
        .collect();
    let region = product["regions"]
        .as_array()
        .and_then(|rows| rows.first())
        .and_then(|row| row["name"].as_str())
        .map(|s| s.chars().take(80).collect());
    let blocked = countries(&product["blockedCountries"]);
    let mut allowed = Vec::new();
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
    if context.as_deref() == Some("DE")
        && countries(&product["countriesAlpha2"])
            .iter()
            .any(|c| c == "DE")
    {
        let activation = document.select(&selector("span")).any(|node| {
            node.text()
                .collect::<Vec<_>>()
                .join(" ")
                .split_whitespace()
                .collect::<Vec<_>>()
                .join(" ")
                == "Kann in Deutschland aktiviert werden"
        });
        if activation {
            allowed.push("DE".to_string());
        }
    }

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
    let offers: Vec<_> = refs
        .into_iter()
        .take(20)
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
        platform_ids,
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

pub(super) async fn discover(shop: Shop, shard: usize) -> Result<Vec<(String, String)>, ShopError> {
    let mut client = PublicClient::new(shop.host()).await?;
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
fn sitemap_locs(body: &str) -> Result<impl Iterator<Item = &str>, ShopError> {
    if body.contains("<!") || !(body.contains("<sitemapindex") || body.contains("<urlset")) {
        return Err(ShopError::Parse);
    }
    Ok(body
        .split("<loc>")
        .skip(1)
        .filter_map(|s| s.split_once("</loc>").map(|(v, _)| v.trim()))
        .filter(|s| !s.contains(['&', '<', '>'])))
}

pub(crate) fn search_urls(keys: &[String]) -> Vec<Url> {
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

/// One public search page per durable job; country preference never filters discovery.
pub(crate) struct SearchPage {
    pub urls: Vec<String>,
    pub next_page: Option<i64>,
}

pub(crate) async fn search_page(
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
    let mut client = PublicClient::new(Shop::Eneba.host()).await?;
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
