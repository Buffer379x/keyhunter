use super::provider::{CatalogError, CatalogGame};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};

#[derive(Clone, Serialize, Deserialize)]
pub struct ContentItem {
    pub id: String,
    pub name: String,
}
#[derive(Clone, Serialize, Deserialize)]
pub struct EditionContent {
    pub igdb_id: i64,
    pub status: String,
    pub source_url: Option<String>,
    pub observed_at: i64,
    pub items: Vec<ContentItem>,
    pub description: Option<String>,
    /// "xbox" when KeyHunter found the store product on the Xbox store itself (1.1.4), not through the IGDB link.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub via: Option<String>,
}
pub fn unknown(games: &[CatalogGame], status: &str) -> Vec<EditionContent> {
    games
        .iter()
        .map(|game| EditionContent {
            igdb_id: game.igdb_id,
            status: status.into(),
            source_url: None,
            observed_at: crate::now(),
            items: vec![],
            description: game.summary.clone(),
            via: None,
        })
        .collect()
}
pub fn valid_store_id(id: &str) -> bool {
    id.len() == 12 && id.bytes().all(|b| b.is_ascii_alphanumeric())
}
pub fn store_id(raw: &str) -> Option<String> {
    let url = url::Url::parse(raw).ok()?;
    if url.scheme() != "https"
        || !matches!(url.host_str(), Some("www.xbox.com" | "www.microsoft.com"))
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return None;
    }
    let id = url.path().trim_end_matches('/').rsplit('/').next()?;
    valid_store_id(id).then(|| id.to_ascii_uppercase())
}
async fn fetch(client: &reqwest::Client, ids: &[String]) -> Result<Vec<Value>, CatalogError> {
    let mut all = Vec::new();
    for chunk in ids.chunks(10) {
        if chunk.iter().any(|id| !valid_store_id(id)) {
            return Err(CatalogError::InvalidResponse);
        }
        let mut url =
            url::Url::parse("https://displaycatalog.mp.microsoft.com/v7.0/products").unwrap();
        url.query_pairs_mut()
            .append_pair("bigIds", &chunk.join(","))
            .append_pair("market", "DE")
            .append_pair("languages", "de-de");
        let response = client
            .get(url)
            .send()
            .await
            .map_err(|_| CatalogError::Unavailable)?;
        if !response.status().is_success() {
            return Err(CatalogError::Unavailable);
        }
        let data: Value = super::provider::decode(response).await?;
        let products = data["Products"]
            .as_array()
            .ok_or(CatalogError::InvalidResponse)?;
        all.extend(
            products
                .iter()
                .filter(|p| {
                    p["ProductId"]
                        .as_str()
                        .is_some_and(|id| chunk.iter().any(|wanted| wanted == id))
                })
                .cloned(),
        );
    }
    Ok(all)
}
fn title(product: &Value) -> Option<&str> {
    product["LocalizedProperties"].as_array()?.first()?["ProductTitle"].as_str()
}
/// The title keys a store product of `game` may carry: its own name, the base game with the edition name ("Forza Horizon 5"
/// + "Premium Edition", 1.1.4) and, for the base game, its standard edition.
fn expected_titles(game: &CatalogGame, base: Option<&str>) -> Vec<String> {
    let name = crate::shops::title_key(&game.name);
    let mut titles = vec![name.clone()];
    if let (Some(base), Some(edition)) = (base, game.edition_name.as_deref()) {
        titles.push(crate::shops::title_key(&format!("{base} {edition}")));
    }
    if game.kind == "base_game" {
        titles.push(format!("{name} standard"));
        titles.push(format!("{name} standard edition"));
    }
    titles
}
/// The name of the base game of `game` among `games`, for [`expected_titles`].
fn base_name<'a>(games: &'a [CatalogGame], game: &CatalogGame) -> Option<&'a str> {
    let parent = game.version_parent?;
    games
        .iter()
        .find(|g| g.igdb_id == parent)
        .map(|g| g.name.as_str())
}
/// The console generation of the Microsoft catalog and the platform name of the Xbox store for an IGDB platform.
fn generation(platform: i64) -> Option<(&'static str, &'static str)> {
    match platform {
        169 => Some(("ConsoleGen9", "XboxSeriesX")),
        49 => Some(("ConsoleGen8", "XboxOne")),
        _ => None,
    }
}
fn identity_matches(game: &CatalogGame, product: &Value, base: Option<&str>) -> bool {
    let Some(id) = game.store_product_id.as_deref() else {
        return false;
    };
    if product["ProductId"] != id || product["ProductType"] != "Game" {
        return false;
    }
    let compatible = product["Properties"]["XboxConsoleGenCompatible"].as_array();
    let supported = game.platforms.iter().any(|platform| {
        generation(platform.id).is_some_and(|(generation, _)| {
            compatible.is_some_and(|values| values.iter().any(|v| v == generation))
        })
    });
    if !supported {
        return false;
    }
    let actual = crate::shops::title_key(title(product).unwrap_or_default());
    expected_titles(game, base).contains(&actual)
}

/// A product of an Xbox store page (1.1.4). A product page carries its editions and what they bundle, a search page its
/// hits; both put them into the same preloaded state.
#[derive(Debug, Clone, PartialEq)]
struct StoreSummary {
    id: String,
    title: String,
    game: bool,
    available_on: Vec<String>,
}
/// Largest Xbox store page read (they are about 0.5 to 0.8 MB).
const MAX_STORE_PAGE: usize = 4 * 1024 * 1024;

/// The products of an Xbox store page from `window.__PRELOADED_STATE__`; empty when the page has none.
fn store_summaries(html: &str) -> Vec<StoreSummary> {
    let Some(start) = html.find("window.__PRELOADED_STATE__") else {
        return vec![];
    };
    let rest = &html[start..];
    let Some(equals) = rest.find('=') else {
        return vec![];
    };
    let Some(Ok(state)) = serde_json::Deserializer::from_str(rest[equals + 1..].trim_start())
        .into_iter::<Value>()
        .next()
    else {
        return vec![];
    };
    let Some(products) = state["core2"]["products"]["productSummaries"].as_object() else {
        return vec![];
    };
    products
        .iter()
        .filter_map(|(id, product)| {
            let title = product["title"]
                .as_str()
                .filter(|t| !t.is_empty() && t.chars().count() <= 200)?;
            (valid_store_id(id) && product["productId"] == id.as_str()).then(|| StoreSummary {
                id: id.to_ascii_uppercase(),
                title: title.into(),
                game: product["productKind"] == "Game",
                available_on: product["availableOn"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(|v| v.as_str().map(str::to_string))
                    .take(20)
                    .collect(),
            })
        })
        .take(300)
        .collect()
}

/// The store id of `game` among the products of store pages: the Xbox game for its platform with its best title, the
/// own name before the base game with the edition name before a standard edition, and only when exactly one carries it.
fn pick(summaries: &[StoreSummary], game: &CatalogGame, base: Option<&str>) -> Option<String> {
    let titles = expected_titles(game, base);
    let platforms: Vec<_> = game
        .platforms
        .iter()
        .filter_map(|p| generation(p.id).map(|(_, store)| store))
        .collect();
    let games: Vec<_> = summaries
        .iter()
        .filter(|s| {
            s.game
                && s.available_on
                    .iter()
                    .any(|on| platforms.contains(&on.as_str()))
        })
        .collect();
    for title in &titles {
        let found: BTreeSet<&str> = games
            .iter()
            .filter(|s| crate::shops::title_key(&s.title) == *title)
            .map(|s| s.id.as_str())
            .collect();
        match found.len() {
            0 => continue,
            1 => return found.into_iter().next().map(str::to_string),
            _ => return None,
        }
    }
    None
}

async fn store_page(
    client: &reqwest::Client,
    url: url::Url,
) -> Result<Vec<StoreSummary>, CatalogError> {
    let response = client
        .get(url)
        .header(reqwest::header::ACCEPT_LANGUAGE, "de-DE,de;q=0.9")
        .send()
        .await
        .map_err(|_| CatalogError::Unavailable)?;
    if !response.status().is_success() {
        return Err(CatalogError::Unavailable);
    }
    let bytes = super::provider::body(response, MAX_STORE_PAGE).await?;
    Ok(store_summaries(&String::from_utf8_lossy(&bytes)))
}

/// Store ids for the games IGDB links to no store product, or to one that is not theirs (1.1.4): first from the Xbox store
/// page of an edition with a matching link (it lists the editions of the game), then from the Xbox store search for the
/// base game. At most two pages; a failed page leaves the games as they are.
async fn find_store_ids(
    client: &reqwest::Client,
    games: &[CatalogGame],
    open: &[usize],
    linked: Option<&str>,
) -> BTreeMap<usize, String> {
    let mut found = BTreeMap::new();
    let mut pages = Vec::new();
    if let Some(id) = linked {
        pages.push(
            url::Url::parse(&format!("https://www.xbox.com/de-DE/games/store/-/{id}")).unwrap(),
        );
    }
    let search = games
        .iter()
        .find(|g| g.kind == "base_game")
        .or_else(|| games.first())
        .map(|g| {
            g.name
                .chars()
                .filter(|c| !matches!(c, '™' | '®' | '©'))
                .take(120)
                .collect::<String>()
        });
    if let Some(name) = search {
        let mut url = url::Url::parse("https://www.xbox.com/de-DE/search/results/games").unwrap();
        url.query_pairs_mut().append_pair("q", &name);
        pages.push(url);
    }
    for url in pages {
        if open.iter().all(|index| found.contains_key(index)) {
            break;
        }
        let Ok(summaries) = store_page(client, url).await else {
            continue;
        };
        for &index in open {
            if !found.contains_key(&index)
                && let Some(id) = pick(&summaries, &games[index], base_name(games, &games[index]))
            {
                found.insert(index, id);
            }
        }
    }
    found
}

/// Edition contents: through the store link of IGDB, and for the editions without a usable one through the Xbox store
/// (1.1.4), each verified again against the Microsoft catalog (title, platform, contents).
pub async fn load(
    client: &reqwest::Client,
    games: &[CatalogGame],
) -> Result<Vec<EditionContent>, CatalogError> {
    let mut output = load_linked(client, games).await?;
    let open: Vec<usize> = output
        .iter()
        .enumerate()
        .filter(|(_, e)| matches!(e.status.as_str(), "not_linked" | "identity_mismatch"))
        .map(|(index, _)| index)
        .collect();
    if open.is_empty() {
        return Ok(output);
    }
    let linked = output
        .iter()
        .zip(games)
        .find(|(entry, _)| matches!(entry.status.as_str(), "verified" | "ambiguous"))
        .and_then(|(_, game)| game.store_product_id.as_deref());
    let found = find_store_ids(client, games, &open, linked).await;
    if found.is_empty() {
        return Ok(output);
    }
    // The found products are checked like linked ones; the other games stay in the list for the base names.
    let mut retry = games.to_vec();
    for (index, game) in retry.iter_mut().enumerate() {
        game.store_product_id = found.get(&index).cloned();
    }
    let Ok(again) = load_linked(client, &retry).await else {
        return Ok(output);
    };
    for &index in found.keys() {
        let entry = &again[index];
        if matches!(entry.status.as_str(), "verified" | "ambiguous") {
            output[index] = EditionContent {
                via: Some("xbox".into()),
                ..entry.clone()
            };
        }
    }
    Ok(output)
}
fn bundled_ids(product: &Value) -> Option<BTreeSet<String>> {
    let mut variants = BTreeSet::new();
    for sku in product["DisplaySkuAvailabilities"].as_array()? {
        let sku = &sku["Sku"];
        if sku["SkuType"] != "full" || sku["Properties"]["IsTrial"] == true {
            continue;
        }
        let props = &sku["Properties"];
        let ids = if props["IsBundle"] == true {
            props["BundledSkus"]
                .as_array()?
                .iter()
                .map(|item| {
                    item["BigId"]
                        .as_str()
                        .filter(|s| valid_store_id(s))
                        .map(str::to_string)
                })
                .collect::<Option<BTreeSet<_>>>()?
        } else {
            [product["ProductId"].as_str()?.to_string()]
                .into_iter()
                .collect()
        };
        if !ids.is_empty() && ids.len() <= 60 {
            variants.insert(ids);
        }
    }
    if variants.len() == 1 {
        variants.into_iter().next()
    } else {
        None
    }
}
async fn load_linked(
    client: &reqwest::Client,
    games: &[CatalogGame],
) -> Result<Vec<EditionContent>, CatalogError> {
    let ids: Vec<_> = games
        .iter()
        .filter_map(|g| g.store_product_id.clone())
        .filter(|s| valid_store_id(s))
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect();
    if ids.is_empty() {
        return Ok(unknown(games, "not_linked"));
    }
    let products = fetch(client, &ids).await?;
    let mut labels: BTreeMap<String, String> = products
        .iter()
        .filter_map(|p| {
            Some((
                p["ProductId"].as_str()?.to_string(),
                title(p)?.chars().take(200).collect(),
            ))
        })
        .collect();
    let mut output = unknown(games, "not_linked");
    let mut bundles = BTreeMap::new();
    for (game, entry) in games.iter().zip(output.iter_mut()) {
        let Some(id) = game.store_product_id.as_deref() else {
            continue;
        };
        entry.status = "unavailable".into();
        let Some(product) = products.iter().find(|p| p["ProductId"] == id) else {
            continue;
        };
        if !identity_matches(game, product, base_name(games, game)) {
            entry.status = "identity_mismatch".into();
            continue;
        }
        entry.source_url = Some(format!("https://www.xbox.com/de-de/games/store/-/{id}"));
        entry.description = product["LocalizedProperties"]
            .as_array()
            .and_then(|p| p.first())
            .and_then(|p| p["ProductDescription"].as_str())
            .map(|s| s.chars().take(4000).collect());
        if let Some(ids) = bundled_ids(product) {
            bundles.insert(game.igdb_id, ids);
        } else {
            entry.status = "ambiguous".into();
        }
    }
    let missing: Vec<_> = bundles
        .values()
        .flatten()
        .filter(|id| !labels.contains_key(*id))
        .cloned()
        .collect::<BTreeSet<_>>()
        .into_iter()
        .take(100)
        .collect();
    for p in fetch(client, &missing).await? {
        if let (Some(id), Some(name)) = (p["ProductId"].as_str(), title(&p)) {
            labels.insert(id.into(), name.chars().take(200).collect());
        }
    }
    for entry in &mut output {
        if let Some(ids) = bundles.get(&entry.igdb_id)
            && ids.iter().all(|id| labels.contains_key(id))
        {
            entry.items = ids
                .iter()
                .map(|id| ContentItem {
                    id: id.clone(),
                    name: labels[id].clone(),
                })
                .collect();
            entry.status = "verified".into();
        }
    }
    Ok(output)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn a_matching_title_without_xbox_support_does_not_verify_edition_contents() {
        let game:CatalogGame=serde_json::from_value(serde_json::json!({"igdb_id":1,"name":"Test Game","platforms":[{"id":169,"name":"Xbox Series X|S"}],"aliases":[],"kind":"base_game","fetched_at":0,"store_product_id":"9NKX70BBCDRN"})).unwrap();
        let mut product = serde_json::json!({"ProductId":"9NKX70BBCDRN","ProductType":"Game","LocalizedProperties":[{"ProductTitle":"Test Game"}],"Properties":{"XboxConsoleGenCompatible":["ConsoleGen9"]}});
        assert!(identity_matches(&game, &product, None));
        product["Properties"]["XboxConsoleGenCompatible"] = serde_json::json!([]);
        assert!(!identity_matches(&game, &product, None));
    }
    fn game(
        id: i64,
        name: &str,
        kind: &str,
        edition: Option<&str>,
        parent: Option<i64>,
    ) -> CatalogGame {
        serde_json::from_value(serde_json::json!({"igdb_id":id,"name":name,"platforms":[{"id":169,"name":"Xbox Series X|S"}],
            "aliases":[],"kind":kind,"fetched_at":0,"edition_name":edition,"version_parent":parent})).unwrap()
    }
    /// A synthetic Xbox store page: its preloaded state with the product summaries, followed by more script.
    fn page(products: serde_json::Value) -> String {
        format!(
            "<html><script>window.env={{}};window.__PRELOADED_STATE__ = {};window.other = {{\"a\":1}};</script></html>",
            serde_json::json!({"core2":{"products":{"productSummaries":products}}})
        )
    }
    #[test]
    fn xbox_store_pages_yield_their_products_and_an_edition_takes_the_one_game_with_its_title() {
        let html = page(serde_json::json!({
            "9NKX70BBCDRN": {"productId":"9NKX70BBCDRN","title":"Test Game","productKind":"Game","availableOn":["XboxOne","XboxSeriesX"]},
            "9MTLKM2DJMZ2": {"productId":"9MTLKM2DJMZ2","title":"TEST GAME – Deluxe Edition","productKind":"Game","availableOn":["XboxSeriesX","PC"]},
            "9PDEMO000001": {"productId":"9PDEMO000001","title":"Test Game Demo Version","productKind":"Game","availableOn":["XboxSeriesX"]},
            "9PADDON00001": {"productId":"9PADDON00001","title":"Test Game Deluxe Edition","productKind":"Durable","availableOn":["XboxSeriesX"]},
            "9PPCONLY0001": {"productId":"9PPCONLY0001","title":"Test Game Ultimate Edition","productKind":"Game","availableOn":["PC"]},
            "BADID": {"productId":"BADID","title":"Test Game","productKind":"Game","availableOn":["XboxSeriesX"]},
            "9POTHERID001": {"productId":"9PSOMEOTHER1","title":"Test Game","productKind":"Game","availableOn":["XboxSeriesX"]}
        }));
        let summaries = store_summaries(&html);
        assert_eq!(
            summaries.len(),
            5,
            "invalid ids and ids that are not the product's are dropped"
        );
        assert!(store_summaries("<html>no state</html>").is_empty());
        assert!(store_summaries("window.__PRELOADED_STATE__ = {broken").is_empty());

        let base = game(1, "Test Game", "base_game", None, None);
        // The edition name after the base game, whatever the punctuation; an add-on with the same title is no game.
        let deluxe = game(
            2,
            "Test Game: Deluxe",
            "edition",
            Some("Deluxe Edition"),
            Some(1),
        );
        assert_eq!(
            pick(&summaries, &base, None).as_deref(),
            Some("9NKX70BBCDRN")
        );
        assert_eq!(
            pick(&summaries, &deluxe, Some("Test Game")).as_deref(),
            Some("9MTLKM2DJMZ2")
        );
        assert_eq!(
            pick(&summaries, &deluxe, None),
            None,
            "without the base name the title does not fit"
        );
        // Only on PC, or the platform of the wish missing: nothing.
        let ultimate = game(
            3,
            "Test Game Ultimate Edition",
            "edition",
            Some("Ultimate Edition"),
            Some(1),
        );
        assert_eq!(pick(&summaries, &ultimate, Some("Test Game")), None);
        // The own name comes before the standard edition.
        let mut standard = summaries.clone();
        standard.push(StoreSummary {
            id: "9PSTANDARD01".into(),
            title: "Test Game Standard Edition".into(),
            ..summaries[0].clone()
        });
        assert_eq!(
            pick(&standard, &base, None).as_deref(),
            Some("9NKX70BBCDRN")
        );
        standard.retain(|s| s.id != "9NKX70BBCDRN");
        assert_eq!(
            pick(&standard, &base, None).as_deref(),
            Some("9PSTANDARD01")
        );
        // Two Xbox games with the same best title: too unsure, nothing.
        let mut twice = summaries.clone();
        twice.push(StoreSummary {
            id: "9PSECOND0001".into(),
            ..summaries
                .iter()
                .find(|s| s.id == "9NKX70BBCDRN")
                .unwrap()
                .clone()
        });
        assert_eq!(pick(&twice, &base, None), None);
        // The catalog check takes the same titles.
        let product = serde_json::json!({"ProductId":"9MTLKM2DJMZ2","ProductType":"Game","LocalizedProperties":[{"ProductTitle":"Test Game Deluxe Edition"}],"Properties":{"XboxConsoleGenCompatible":["ConsoleGen9"]}});
        let mut linked = deluxe.clone();
        linked.store_product_id = Some("9MTLKM2DJMZ2".into());
        assert!(identity_matches(&linked, &product, Some("Test Game")));
        assert!(!identity_matches(&linked, &product, None));
        assert_eq!(
            base_name(&[base.clone(), deluxe.clone()], &deluxe),
            Some("Test Game")
        );
    }
    #[test]
    fn store_links_reject_untrusted_hosts_and_bundle_variations_remain_unknown() {
        assert_eq!(
            store_id("https://www.xbox.com/en-us/games/store/game/9NKX70BBCDRN").as_deref(),
            Some("9NKX70BBCDRN")
        );
        assert!(store_id("https://www.xbox.com.untrusted.example/en-us/9NKX70BBCDRN").is_none());
        assert!(store_id("https://www.xbox.com/en-us/9NKX70BBCDRN?token=private").is_none());
        let sku = |id: &str| serde_json::json!({"Sku":{"SkuType":"full","Properties":{"IsTrial":false,"IsBundle":true,"BundledSkus":[{"BigId":id}]}}});
        let same = serde_json::json!({"DisplaySkuAvailabilities":[sku("9NKX70BBCDRN"),sku("9NKX70BBCDRN")]});
        assert_eq!(bundled_ids(&same).unwrap().len(), 1);
        let mixed = serde_json::json!({"DisplaySkuAvailabilities":[sku("9NKX70BBCDRN"),sku("9MTLKM2DJMZ2")]});
        assert!(bundled_ids(&mixed).is_none());
    }
}
