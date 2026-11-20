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
    // Released means 0 or false; a missing flag stays unknown and yields no prices.
    let released = data["isPreReleased"].as_f64() == Some(0.0) || data["isPreReleased"] == false;
    if data["countryData"]["currency"] == "EUR" && released {
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
            && decimal_cents(
                &v["price"]
                    .as_str()
                    .map_or_else(|| v["price"].to_string(), str::to_owned),
            ) == Some(cents)
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
    Ok(parse_collection(&category, &body))
}

/// Candidate product links and title keys from a collection page; pure so it can be tested on fixtures.
fn parse_collection(category: &Url, body: &str) -> Vec<(String, String)> {
    let shop = Shop::Driffle;
    let document = Html::parse_document(body);
    let selector = Selector::parse("a[href]").unwrap();
    let mut seen = BTreeSet::new();
    document
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
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    const BASE: &str = include_str!("fixtures/driffle-product-base.html");
    const COLLECTION: &str = include_str!("fixtures/driffle-collection.html");
    const SLUG: &str = "forza-horizon-5-standard-edition-pc-xbox-one-xbox-series-xs-xbox-live-digital-code-p100001";
    const NAME: &str = "Forza Horizon 5 Standard Edition (Global) (PC / Xbox One / Xbox Series X|S) - Xbox Live - Digital Key";
    const NEXT_OPEN: &str = r#"<script id="__NEXT_DATA__" type="application/json">"#;
    const LD_OPEN: &str =
        r#"<script id="json-ld-product" type="application/ld+json" data-next-head="">"#;

    type Case = (&'static str, fn(&mut Value));

    fn url() -> Url {
        Url::parse(&format!("https://driffle.com/de/{SLUG}")).unwrap()
    }

    fn rewrite(body: &str, open: &str, change: impl FnOnce(&mut Value)) -> String {
        let start = body.find(open).expect("script present") + open.len();
        let end = start + body[start..].find("</script>").expect("script closed");
        let mut json: Value = serde_json::from_str(&body[start..end]).unwrap();
        change(&mut json);
        format!("{}{}{}", &body[..start], json, &body[end..])
    }

    fn next(change: impl FnOnce(&mut Value)) -> String {
        rewrite(BASE, NEXT_OPEN, change)
    }

    fn ld(change: impl FnOnce(&mut Value)) -> String {
        rewrite(BASE, LD_OPEN, change)
    }

    fn data(state: &mut Value) -> &mut Value {
        &mut state["props"]["pageProps"]["product"]["data"]
    }

    fn mc_offers(state: &mut Value) -> &mut Vec<Value> {
        state["props"]["pageProps"]["mcPdpData"]["offers"]
            .as_array_mut()
            .unwrap()
    }

    fn ld_offers(schema: &mut Value) -> &mut Vec<Value> {
        schema["@graph"][0]["offers"]["offers"]
            .as_array_mut()
            .unwrap()
    }

    fn ld_row(seller_id: i64, store: &str, price: &str) -> Value {
        serde_json::json!({
            "@type": "Offer",
            "priceSpecification": [{
                "@type": "UnitPriceSpecification", "price": price, "priceCurrency": "EUR"
            }],
            "availability": "http://schema.org/InStock",
            "url": format!("https://driffle.com/{SLUG}?seller={seller_id}"),
            "seller": {"@type": "Organization", "name": store}
        })
    }

    fn offers(product: &Product) -> Vec<(&str, i64, &str)> {
        product
            .offers
            .iter()
            .map(|q| (q.id.as_str(), q.cents, q.seller.as_deref().unwrap()))
            .collect()
    }

    fn parse_ok(body: &str) -> Product {
        parse(&url(), body).unwrap()
    }

    #[test]
    fn product_base_game_with_several_offers_returns_every_field() {
        let product = parse_ok(BASE);
        assert_eq!(product.id, "100001");
        assert_eq!(product.name, NAME);
        assert_eq!(product.title, "forza horizon 5 standard edition");
        assert!(product.key_game);
        assert_eq!(product.platform_ids, [169, 49]);
        assert_eq!(product.region.as_deref(), Some("GLOBAL"));
        assert_eq!(product.allowed, ["AT", "DE", "FR"]);
        assert!(product.blocked.is_empty());
        assert_eq!(product.purchase_country.as_deref(), Some("DE"));
        assert_eq!(product.availability, Availability::InStock);
        // Sorted by price, the duplicated "Alpha Keys" row appears once, the second store of seller 101 is kept,
        // and subscription/list prices (priceType present) are never used.
        assert_eq!(
            offers(&product),
            [
                ("5004", 2450, "Alpha Outlet"),
                ("5001", 2502, "Alpha Keys"),
                ("5002", 2575, "Beta Store"),
                ("5003", 2739, "Gamma Games"),
            ]
        );
        assert_eq!(product.activation("DE"), "confirmed");
        assert_eq!(product.activation("US"), "unknown");
    }

    #[test]
    fn product_offer_not_matching_marketplace_data_is_dropped() {
        // Different price in mcPdpData.
        let body = next(|s| mc_offers(s)[1]["price"] = 25.76.into());
        assert_eq!(parse_ok(&body).offers.len(), 3);
        // Different store name.
        let body = next(|s| mc_offers(s)[1]["storeName"] = "Someone else".into());
        assert_eq!(parse_ok(&body).offers.len(), 3);
        // Different seller id.
        let body = next(|s| mc_offers(s)[1]["sellerId"] = 999.into());
        assert_eq!(parse_ok(&body).offers.len(), 3);
        // Offer missing from mcPdpData.
        let body = next(|s| {
            mc_offers(s).remove(1);
        });
        assert_eq!(parse_ok(&body).offers.len(), 3);
        // Non-positive or missing offer id.
        let body = next(|s| mc_offers(s)[1]["offerId"] = 0.into());
        assert_eq!(parse_ok(&body).offers.len(), 3);
        let body = next(|s| {
            mc_offers(s)[1].as_object_mut().unwrap().remove("offerId");
        });
        assert_eq!(parse_ok(&body).offers.len(), 3);
        // Nothing left to match at all: availability is unknown, not sold out.
        let body = next(|s| mc_offers(s).clear());
        let product = parse_ok(&body);
        assert!(product.offers.is_empty());
        assert_eq!(product.availability, Availability::Unknown);
    }

    #[test]
    fn product_mc_price_matches_regardless_of_trailing_zero_formatting() {
        // 25.5 serialises as "25.5" and still matches the JSON-LD string "25.50".
        let body = rewrite(
            &next(|s| mc_offers(s)[1]["price"] = 25.5.into()),
            LD_OPEN,
            |s| {
                ld_offers(s)[1]["priceSpecification"][0]["price"] = "25.50".into();
            },
        );
        assert!(
            parse_ok(&body)
                .offers
                .iter()
                .any(|q| q.id == "5002" && q.cents == 2550)
        );
        // A whole number serialised as 26.0 also matches "26.00".
        let body = rewrite(
            &next(|s| mc_offers(s)[1]["price"] = 26.0.into()),
            LD_OPEN,
            |s| {
                ld_offers(s)[1]["priceSpecification"][0]["price"] = "26.00".into();
            },
        );
        assert!(parse_ok(&body).offers.iter().any(|q| q.cents == 2600));
    }

    #[test]
    fn product_offers_are_deduplicated_sorted_and_capped_at_twenty() {
        let body = rewrite(
            &next(|s| {
                for n in 0..25_i64 {
                    mc_offers(s).push(serde_json::json!({
                        "offerId": 6000 + n, "sellerId": 200 + n,
                        "storeName": format!("Store {n}"),
                        "price": format!("30.{n:02}").parse::<f64>().unwrap()
                    }));
                }
            }),
            LD_OPEN,
            |s| {
                for n in (0..25_i64).rev() {
                    ld_offers(s).push(ld_row(
                        200 + n,
                        &format!("Store {n}"),
                        &format!("30.{n:02}"),
                    ));
                }
            },
        );
        let product = parse_ok(&body);
        assert_eq!(product.offers.len(), 20);
        assert!(product.offers.windows(2).all(|w| w[0].cents <= w[1].cents));
        assert_eq!(product.offers[0].cents, 2450);
        assert_eq!(product.offers[19].cents, 3015);
        let ids: BTreeSet<_> = product.offers.iter().map(|q| &q.id).collect();
        assert_eq!(ids.len(), 20);
    }

    #[test]
    fn product_json_ld_is_read_up_to_one_hundred_offer_rows() {
        let body = rewrite(
            &next(|s| {
                for n in 0..150 {
                    mc_offers(s).push(serde_json::json!({
                        "offerId": 7000 + n, "sellerId": 300, "storeName": format!("Bulk {n}"), "price": 40.0
                    }));
                }
            }),
            LD_OPEN,
            |s| {
                ld_offers(s).clear();
                for n in (0..150).rev() {
                    ld_offers(s).push(ld_row(300, &format!("Bulk {n}"), "40.00"));
                }
            },
        );
        let product = parse_ok(&body);
        assert_eq!(product.offers.len(), 20);
        // Only the first 100 rows are inspected: rows 100..150 of the page (Bulk 49..0) never appear.
        assert!(
            !product
                .offers
                .iter()
                .any(|q| q.seller.as_deref() == Some("Bulk 0"))
        );
    }

    #[test]
    fn product_is_released_for_zero_or_false_only() {
        for value in [
            serde_json::json!(0),
            serde_json::json!(0.0),
            serde_json::json!(false),
        ] {
            let body = next(|s| data(s)["isPreReleased"] = value.clone());
            assert_eq!(
                parse_ok(&body).availability,
                Availability::InStock,
                "{value}"
            );
        }
        for value in [
            serde_json::json!(null),
            serde_json::json!("0"),
            serde_json::json!(1),
            serde_json::json!(true),
        ] {
            let body = next(|s| data(s)["isPreReleased"] = value.clone());
            let product = parse_ok(&body);
            assert!(product.offers.is_empty(), "{value}");
            assert_eq!(product.availability, Availability::Unknown, "{value}");
        }
        // A missing flag is unknown, not released.
        let body = next(|s| {
            data(s).as_object_mut().unwrap().remove("isPreReleased");
        });
        assert_eq!(parse_ok(&body).availability, Availability::Unknown);
        // A pre-release skips the JSON-LD block, so a SoldOut marker is not seen either.
        let body = rewrite(
            &next(|s| data(s)["isPreReleased"] = true.into()),
            LD_OPEN,
            |s| {
                s["@graph"][0]["offers"]["availability"] = "https://schema.org/SoldOut".into();
                ld_offers(s).clear();
            },
        );
        assert_eq!(parse_ok(&body).availability, Availability::Unknown);
    }

    #[test]
    fn product_mc_price_may_be_a_number_or_a_string() {
        let expected = parse_ok(BASE).offers.len();
        let body = next(|s| {
            for row in mc_offers(s) {
                let price = row["price"].as_f64().unwrap();
                row["price"] = format!("{price:.2}").into();
            }
        });
        assert_eq!(parse_ok(&body).offers.len(), expected);
        // A string price that differs from the JSON-LD price drops only that offer.
        let body = next(|s| mc_offers(s)[1]["price"] = "25.70".into());
        assert_eq!(parse_ok(&body).offers.len(), expected - 1);
        // More than two decimals never match.
        let body = next(|s| mc_offers(s)[1]["price"] = 25.755.into());
        assert_eq!(parse_ok(&body).offers.len(), expected - 1);
    }

    #[test]
    fn product_subscription_and_list_prices_are_ignored() {
        // The fixture lists subscription (cheaper) and list (71.14) prices after the regular one: never used.
        let product = parse_ok(BASE);
        assert!(product.offers.iter().all(|q| q.cents != 7114));
        assert!(product.offers.iter().all(|q| q.cents != 2302));
        // A row with only priceType specifications has no usable price.
        let body = ld(|s| {
            let specs = ld_offers(s)[1]["priceSpecification"]
                .as_array_mut()
                .unwrap();
            specs.remove(0);
        });
        assert_eq!(parse_ok(&body).offers.len(), 3);
        // The regular price must be in EUR and a UnitPriceSpecification.
        let body = ld(|s| ld_offers(s)[1]["priceSpecification"][0]["priceCurrency"] = "USD".into());
        assert_eq!(parse_ok(&body).offers.len(), 3);
        let body =
            ld(|s| ld_offers(s)[1]["priceSpecification"][0]["@type"] = "PriceSpecification".into());
        assert_eq!(parse_ok(&body).offers.len(), 3);
        // A priceSpecification given as a single object instead of an array is not understood.
        let body = ld(|s| {
            let first = ld_offers(s)[1]["priceSpecification"][0].clone();
            ld_offers(s)[1]["priceSpecification"] = first;
        });
        assert_eq!(parse_ok(&body).offers.len(), 3);
    }

    #[test]
    fn product_offer_rows_with_bad_links_sellers_or_availability_are_dropped() {
        let cases: &[Case] = &[
            ("foreign host", |s| {
                ld_offers(s)[1]["url"] = format!("https://evil.example/{SLUG}?seller=102").into();
            }),
            ("http scheme", |s| {
                ld_offers(s)[1]["url"] = format!("http://driffle.com/{SLUG}?seller=102").into();
            }),
            ("other path", |s| {
                ld_offers(s)[1]["url"] = "https://driffle.com/other-p1?seller=102".into();
            }),
            ("no seller query", |s| {
                ld_offers(s)[1]["url"] = format!("https://driffle.com/{SLUG}").into();
            }),
            ("non numeric seller", |s| {
                ld_offers(s)[1]["url"] = format!("https://driffle.com/{SLUG}?seller=x").into();
            }),
            ("blank seller name", |s| {
                ld_offers(s)[1]["seller"]["name"] = "  ".into()
            }),
            ("long seller name", |s| {
                ld_offers(s)[1]["seller"]["name"] = "x".repeat(101).into();
            }),
            ("out of stock row", |s| {
                ld_offers(s)[1]["availability"] = "https://schema.org/OutOfStock".into();
            }),
            ("not an Offer", |s| {
                ld_offers(s)[1]["@type"] = "Product".into()
            }),
        ];
        for (label, change) in cases {
            let body = ld(change);
            let product = parse_ok(&body);
            assert_eq!(product.offers.len(), 3, "{label}");
            assert!(product.offers.iter().all(|q| q.id != "5002"), "{label}");
        }
        // Surrounding whitespace in the seller name is trimmed before it is compared with mcPdpData.
        let body = ld(|s| ld_offers(s)[1]["seller"]["name"] = "  Beta Store ".into());
        assert_eq!(parse_ok(&body).offers.len(), 4);
    }

    #[test]
    fn product_sold_out_marker_gives_sold_out_without_offers() {
        for marker in ["https://schema.org/SoldOut", "http://schema.org/OutOfStock"] {
            let body = ld(|s| {
                s["@graph"][0]["offers"]["availability"] = marker.into();
                ld_offers(s).clear();
            });
            let product = parse_ok(&body);
            assert!(product.offers.is_empty(), "{marker}");
            assert_eq!(product.availability, Availability::SoldOut, "{marker}");
        }
        // Offers still win over a sold-out marker.
        let body =
            ld(|s| s["@graph"][0]["offers"]["availability"] = "https://schema.org/SoldOut".into());
        assert_eq!(parse_ok(&body).availability, Availability::InStock);
        // No marker, no offers: unknown.
        let body = ld(|s| ld_offers(s).clear());
        assert_eq!(parse_ok(&body).availability, Availability::Unknown);
    }

    #[test]
    fn product_json_ld_must_describe_the_same_product() {
        let body = ld(|s| s["@graph"][0]["productID"] = "999".into());
        assert!(parse_ok(&body).offers.is_empty());
        let body = ld(|s| s["@graph"][0]["name"] = "Other name".into());
        assert!(parse_ok(&body).offers.is_empty());
        // A Product placed at the top level instead of in @graph is not read.
        let body = ld(|s| {
            let product = s["@graph"][0].clone();
            *s = product;
        });
        let product = parse_ok(&body);
        assert!(product.offers.is_empty());
        assert_eq!(product.availability, Availability::Unknown);
        // Broken JSON-LD is skipped, not fatal.
        let body = BASE.replace(LD_OPEN, &format!("{LD_OPEN}{{broken"));
        assert_eq!(parse_ok(&body).availability, Availability::Unknown);
    }

    #[test]
    fn product_non_eur_currency_yields_no_offers() {
        let body = next(|s| data(s)["countryData"]["currency"] = "USD".into());
        let product = parse_ok(&body);
        assert!(product.offers.is_empty());
        assert_eq!(product.availability, Availability::Unknown);
        assert_eq!(product.purchase_country.as_deref(), Some("DE"));
    }

    #[test]
    fn product_identity_mismatches_are_parse_errors() {
        assert!(matches!(
            parse(&url(), "<html>blocked</html>"),
            Err(ShopError::Parse)
        ));
        assert!(matches!(
            parse(&url(), &format!("{NEXT_OPEN}{{oops</script>")),
            Err(ShopError::Parse)
        ));
        let cases: &[Case] = &[
            ("sku differs from slug", |s| {
                data(s)["productSku"] = 100002.into()
            }),
            ("sku not a number", |s| {
                data(s)["productSku"] = "100001".into()
            }),
            ("sku zero", |s| data(s)["productSku"] = 0.into()),
            ("slug differs", |s| data(s)["slug"] = "other-p100001".into()),
            ("empty name", |s| data(s)["name"] = "".into()),
            ("missing product", |s| {
                s["props"]["pageProps"]["product"] = Value::Null
            }),
        ];
        for (label, change) in cases {
            let body = next(change);
            assert!(
                matches!(parse(&url(), &body), Err(ShopError::Parse)),
                "{label}"
            );
        }
        let other = Url::parse("https://driffle.com/de/other-game-p5").unwrap();
        assert!(matches!(parse(&other, BASE), Err(ShopError::Parse)));
    }

    #[test]
    fn product_title_requires_the_exact_name_structure() {
        // Region in the name must equal the first entry of `regions`.
        let body = next(|s| data(s)["regions"] = serde_json::json!([{"name": "Europe"}]));
        let product = parse_ok(&body);
        assert_eq!(product.title, "");
        assert!(!product.key_game);
        // Name without the platform list, or without the Xbox platform, gives an empty title.
        for name in [
            "Forza Horizon 5 Standard Edition (Global) - Xbox Live - Digital Key",
            "Forza Horizon 5 Standard Edition (Global) (PC / Steam) - Xbox Live - Digital Key",
            "Forza Horizon 5 Standard Edition (Global) (PC / Xbox One)",
        ] {
            let body = BASE.replace(NAME, name);
            let product = parse_ok(&body);
            assert_eq!(product.title, "", "{name}");
            assert!(!product.key_game, "{name}");
        }
    }

    #[test]
    fn product_key_game_excludes_non_games_accounts_and_dlc() {
        let cases: &[Case] = &[
            ("other platform", |s| data(s)["platform"] = "Steam".into()),
            ("two types", |s| {
                data(s)["productTypes"] = serde_json::json!(["game", "dlc"])
            }),
            ("dlc type", |s| {
                data(s)["productTypes"] = serde_json::json!(["dlc"])
            }),
            ("no types", |s| {
                data(s)["productTypes"] = serde_json::json!([])
            }),
            ("missing types", |s| {
                data(s).as_object_mut().unwrap().remove("productTypes");
            }),
        ];
        for (label, change) in cases {
            let body = next(change);
            assert!(!parse_ok(&body).key_game, "{label}");
        }
        for word in ["account", "addon", "upgrade", "dlc", "gift"] {
            let slug = SLUG.replace("horizon-5", &format!("horizon-5-{word}"));
            let body = BASE.replace(SLUG, &slug);
            let url = Url::parse(&format!("https://driffle.com/de/{slug}")).unwrap();
            assert!(!parse(&url, &body).unwrap().key_game, "{word}");
        }
        // Title words account/upgrade/dlc exclude too (but "addon" is only checked in the slug).
        for word in ["Account", "Upgrade", "DLC"] {
            let name = NAME.replace("Standard Edition", &format!("{word} Standard Edition"));
            let body = BASE.replace(NAME, &name);
            assert!(!parse_ok(&body).key_game, "{word}");
        }
        let name = NAME.replace("Standard Edition", "Addon Standard Edition");
        assert!(parse_ok(&BASE.replace(NAME, &name)).key_game);
    }

    #[test]
    fn product_platforms_follow_system_requirements_keys() {
        let body = next(|s| {
            data(s)["systemRequirements"] = serde_json::json!({"windows": {}, "xbox_one": {}});
        });
        assert_eq!(parse_ok(&body).platform_ids, [49]);
        let body = next(|s| data(s)["systemRequirements"] = serde_json::json!({"windows": {}}));
        assert!(parse_ok(&body).platform_ids.is_empty());
        // Present but not an object (e.g. null): not counted.
        let body = next(|s| {
            data(s)["systemRequirements"] =
                serde_json::json!({"xbox_one": null, "xbox_series_x|s": []});
        });
        assert!(parse_ok(&body).platform_ids.is_empty());
    }

    #[test]
    fn product_activation_lists_keep_valid_country_codes_only() {
        let body = next(|s| {
            data(s)["worksIn"] = serde_json::json!({
                "allowedCountries": ["DE", "de", "DEU", 5, null, "AT"],
                "blockedCountries": ["US", "xx"]
            });
        });
        let product = parse_ok(&body);
        assert_eq!(product.allowed, ["DE", "AT"]);
        assert_eq!(product.blocked, ["US"]);
        assert_eq!(product.activation("US"), "blocked");
        let body = next(|s| {
            data(s)["worksIn"] =
                serde_json::json!({"allowedCountries": ["DE"], "blockedCountries": ["DE"]});
        });
        assert_eq!(parse_ok(&body).activation("DE"), "blocked");
        let body = next(|s| {
            data(s).as_object_mut().unwrap().remove("worksIn");
            data(s)["countryData"]["countryCode"] = "de".into();
        });
        let product = parse_ok(&body);
        assert!(product.allowed.is_empty());
        assert_eq!(product.purchase_country, None);
    }

    #[test]
    fn quote_function_requires_all_cross_checks() {
        let mut page = serde_json::json!({"mcPdpData": {"offers": [
            {"offerId": 1, "sellerId": 7, "storeName": "S", "price": 9.9}
        ]}});
        let row = ld_row(7, "S", "9.90");
        let found = quote(&row, &page, SLUG).unwrap();
        assert_eq!((found.id.as_str(), found.cents), ("1", 990));
        assert_eq!(found.seller.as_deref(), Some("S"));
        page["mcPdpData"]["offers"][0]["price"] = 9.91.into();
        assert!(quote(&row, &page, SLUG).is_none());
        assert!(quote(&row, &Value::Null, SLUG).is_none());
    }

    #[test]
    fn decimal_cents_edge_cases() {
        let cases: &[(&str, Option<i64>)] = &[
            ("23", Some(2300)),
            ("23.9", Some(2390)),
            ("23.99", Some(2399)),
            ("23.999", None),
            ("", None),
            ("1e2", None),
            ("0.00", None),
            ("0", None),
            ("0.01", Some(1)),
            ("0.1", Some(10)),
            ("1.05", Some(105)),
            ("1.0", Some(100)),
            ("1.00", Some(100)),
            (".5", None),
            // Current behaviour: a trailing dot is accepted.
            ("5.", Some(500)),
            ("-1", None),
            ("+1", None),
            (" 1", None),
            ("1,5", None),
            ("1.1.1", None),
            ("1.5e1", None),
            ("\"1.50\"", None),
            ("100000.00", Some(10_000_000)),
            ("100000.01", None),
            ("999999.99", None),
            ("1000000", None),
            ("\u{663}", None),
            ("007", Some(700)),
        ];
        for &(input, expected) in cases {
            assert_eq!(decimal_cents(input), expected, "{input:?}");
        }
    }

    #[test]
    fn collection_extracts_product_links_and_titles_from_slugs() {
        let category = Url::parse("https://driffle.com/de/store/collection/xbox-games").unwrap();
        let found = parse_collection(&category, COLLECTION);
        let base = "https://driffle.com/de/";
        assert_eq!(
            found,
            [
                (
                    format!(
                        "{base}age-of-mythology-retold-europe-pc-xbox-series-xs-xbox-live-digital-key-p9917801"
                    ),
                    "age of mythology retold europe".to_string()
                ),
                (
                    format!(
                        "{base}sea-of-thieves-2024-edition-europe-pc-xbox-one-xbox-series-xs-xbox-live-digital-key-p9911202"
                    ),
                    "sea of thieves 2024 edition europe".to_string()
                ),
                (
                    format!(
                        "{base}need-for-speed-unbound-eu-xbox-series-xs-xbox-live-digital-code-p9884403"
                    ),
                    "need for speed unbound eu".to_string()
                ),
                (
                    format!(
                        "{base}fortnite-rogue-scout-pack-dlc-1500-v-bucks-challenge-ar-xbox-one-xbox-series-xs-xbox-live-digital-code-p9892104"
                    ),
                    "fortnite rogue scout pack dlc 1500 v bucks challenge ar".to_string()
                ),
                (
                    format!(
                        "{base}forza-horizon-5-eu-pc-xbox-one-xbox-series-x-s-xbox-live-digital-code-p9897405"
                    ),
                    "forza horizon 5 eu".to_string()
                ),
            ]
        );
        // Duplicate card links, navigation, foreign hosts, query strings, other platforms and slugs without
        // a platform separator are all ignored. The region token stays part of the title (known quirk).
    }

    #[test]
    fn collection_is_capped_at_250_unique_links_and_empty_for_unrelated_pages() {
        let category = Url::parse("https://driffle.com/de/store/collection/xbox-games").unwrap();
        let mut html = String::new();
        for n in 0..300 {
            html.push_str(&format!(
                "<a href='/de/game-{n}-eu-pc-xbox-one-xbox-live-digital-code-p{n}0001'>x</a>"
            ));
        }
        let found = parse_collection(&category, &html);
        assert_eq!(found.len(), 250);
        assert_eq!(found[0].1, "game 0 eu");
        assert!(parse_collection(&category, "<html><body>Changed</body></html>").is_empty());
    }
}
