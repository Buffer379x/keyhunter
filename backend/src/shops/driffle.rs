use super::{Availability, Product, Quote, Shop, ShopError, http::PublicClient, title_key};
use scraper::{Html, Selector};
use serde_json::Value;
use std::collections::BTreeSet;
use url::Url;

pub(super) fn parse(url: &Url, body: &str) -> Result<Product, ShopError> {
    let document = Html::parse_document(body);
    let select = |css: &str| Selector::parse(css).expect("static selector");
    let page: Value = serde_json::from_str(
        &document
            .select(&select("script#__NEXT_DATA__"))
            .next()
            .ok_or(ShopError::Parse)?
            .inner_html(),
    )
    .map_err(|_| ShopError::Parse)?;
    let page = &page["props"]["pageProps"];
    let data = &page["product"]["data"];
    let slug = url.path().rsplit('/').next().ok_or(ShopError::Parse)?;
    let id = data["productSku"]
        .as_i64()
        .filter(|id| *id > 0)
        .ok_or(ShopError::Parse)?
        .to_string();
    if data["slug"] != slug || slug.rsplit_once("-p").map(|(_, id)| id) != Some(id.as_str()) {
        return Err(ShopError::Parse);
    }
    let name = data["name"]
        .as_str()
        .filter(|name| !name.is_empty() && name.chars().count() <= 300)
        .ok_or(ShopError::Parse)?;
    let title = name
        .strip_suffix(" - Xbox Live - Digital Key")
        .and_then(|s| s.rsplit_once(" ("))
        .and_then(|(s, platforms)| {
            let expected = data["regions"].as_array()?.first()?["name"].as_str()?;
            let region_suffix = format!(" ({expected})");
            (platforms.contains("Xbox") && platforms.ends_with(')'))
                .then(|| s.strip_suffix(&region_suffix))
                .flatten()
        })
        .map(title_key)
        .unwrap_or_default();
    let key_game = !title.is_empty()
        && data["platform"] == "Xbox Live"
        && data["productTypes"]
            .as_array()
            .is_some_and(|kinds| kinds.len() == 1 && kinds[0] == "game")
        && !slug
            .split('-')
            .any(|word| matches!(word, "account" | "addon" | "upgrade" | "dlc" | "gift"))
        && !title
            .split(' ')
            .any(|word| matches!(word, "account" | "upgrade" | "dlc"));
    let platform_ids = ["xbox_series_x|s", "xbox_one"]
        .into_iter()
        .zip([169, 49])
        .filter(|(key, _)| data["systemRequirements"][*key].is_object())
        .map(|(_, id)| id)
        .collect();
    let purchase_country = country(&data["countryData"]["countryCode"]);
    let allowed = data["worksIn"]["allowedCountries"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(country)
        .take(260)
        .collect();
    let blocked = data["worksIn"]["blockedCountries"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(country)
        .take(260)
        .collect();
    let region = data["productRegion"]
        .as_str()
        .map(|s| s.chars().take(80).collect());
    let mut offers = Vec::new();
    let mut sold_out = false;
    if data["countryData"]["currency"] == "EUR" && data["isPreReleased"] == 0 {
        for script in document.select(&select("script[type='application/ld+json']")) {
            let Ok(schema) = serde_json::from_str::<Value>(&script.inner_html()) else {
                continue;
            };
            for node in schema["@graph"]
                .as_array()
                .into_iter()
                .flatten()
                .filter(|v| v["@type"] == "Product" && v["productID"] == id && v["name"] == name)
            {
                let aggregate = &node["offers"];
                sold_out |= is_availability(aggregate, "SoldOut")
                    || is_availability(aggregate, "OutOfStock");
                for row in aggregate["offers"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .take(100)
                {
                    if let Some(quote) = quote(row, page, slug) {
                        offers.push(quote);
                    }
                }
            }
        }
    }
    offers.sort_by(|a, b| a.id.cmp(&b.id));
    offers.dedup_by(|a, b| a.id == b.id);
    offers.sort_by_key(|q| q.cents);
    offers.truncate(20);
    let availability = if !offers.is_empty() {
        Availability::InStock
    } else if sold_out {
        Availability::SoldOut
    } else {
        Availability::Unknown
    };
    Ok(Product {
        id,
        name: name.into(),
        title,
        platform_ids,
        key_game,
        region,
        allowed,
        blocked,
        purchase_country,
        offers,
        availability,
    })
}

fn quote(row: &Value, page: &Value, slug: &str) -> Option<Quote> {
    if row["@type"] != "Offer" || !is_availability(row, "InStock") {
        return None;
    }
    let spec = row["priceSpecification"].as_array()?.iter().find(|s| {
        s["@type"] == "UnitPriceSpecification"
            && s.get("priceType").is_none()
            && s["priceCurrency"] == "EUR"
    })?;
    let cents = decimal_cents(spec["price"].as_str()?)?;
    let seller = row["seller"]["name"].as_str()?.trim();
    if seller.is_empty() || seller.chars().count() > 100 {
        return None;
    }
    let link = Url::parse(row["url"].as_str()?).ok()?;
    if link.scheme() != "https"
        || link.host_str() != Some("driffle.com")
        || link.path().strip_prefix('/') != Some(slug)
    {
        return None;
    }
    let seller_id = link
        .query_pairs()
        .find(|(k, _)| k == "seller")?
        .1
        .parse::<i64>()
        .ok()?;
    let offer_id = page["mcPdpData"]["offers"].as_array()?.iter().find(|v| {
        v["sellerId"].as_i64() == Some(seller_id)
            && v["storeName"] == seller
            && decimal_cents(&v["price"].to_string()) == Some(cents)
    })?["offerId"]
        .as_i64()?;
    (offer_id > 0).then(|| Quote {
        id: offer_id.to_string(),
        cents,
        seller: Some(seller.into()),
    })
}

fn country(v: &Value) -> Option<String> {
    v.as_str()
        .filter(|s| s.len() == 2 && s.bytes().all(|c| c.is_ascii_uppercase()))
        .map(str::to_string)
}

fn is_availability(v: &Value, state: &str) -> bool {
    v["availability"].as_str().and_then(|s| {
        s.strip_prefix("https://schema.org/")
            .or_else(|| s.strip_prefix("http://schema.org/"))
    }) == Some(state)
}

fn decimal_cents(s: &str) -> Option<i64> {
    let (whole, fraction) = s.split_once('.').unwrap_or((s, ""));
    if whole.is_empty()
        || whole.len() > 6
        || fraction.len() > 2
        || !whole
            .bytes()
            .chain(fraction.bytes())
            .all(|c| c.is_ascii_digit())
    {
        return None;
    }
    let cents = whole.parse::<i64>().ok()? * 100
        + fraction.parse::<i64>().unwrap_or_default() * if fraction.len() == 1 { 10 } else { 1 };
    (1..=10_000_000).contains(&cents).then_some(cents)
}

pub(super) async fn discover(shop: Shop) -> Result<Vec<(String, String)>, ShopError> {
    let mut client = PublicClient::new(shop.host()).await?;
    let category = Url::parse("https://driffle.com/de/store/collection/xbox-games").unwrap();
    let body = client.get(&category, 2 * 1024 * 1024, false).await?;
    let document = Html::parse_document(&body);
    let selector = Selector::parse("a[href]").unwrap();
    let mut seen = BTreeSet::new();
    Ok(document
        .select(&selector)
        .filter_map(|node| {
            let url = shop.product_url(category.join(node.value().attr("href")?).ok()?.as_str())?;
            let slug = url.path().rsplit('/').next()?;
            let (before, _) = slug.split_once("-xbox-live-digital-")?;
            let (title, _) = before
                .split_once("-pc-")
                .or_else(|| before.split_once("-xbox-"))?;
            seen.insert(url.to_string())
                .then(|| (url.to_string(), title_key(title)))
        })
        .take(250)
        .collect())
}
