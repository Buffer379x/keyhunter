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
fn identity_matches(game: &CatalogGame, product: &Value) -> bool {
    let Some(id) = game.store_product_id.as_deref() else {
        return false;
    };
    if product["ProductId"] != id || product["ProductType"] != "Game" {
        return false;
    }
    let compatible = product["Properties"]["XboxConsoleGenCompatible"].as_array();
    let supported = game.platforms.iter().any(|platform| {
        let generation = match platform.id {
            169 => "ConsoleGen9",
            49 => "ConsoleGen8",
            _ => return false,
        };
        compatible.is_some_and(|values| values.iter().any(|v| v == generation))
    });
    if !supported {
        return false;
    }
    let actual = crate::shops::title_key(title(product).unwrap_or_default());
    let expected = crate::shops::title_key(&game.name);
    actual == expected
        || (game.kind == "base_game"
            && [
                format!("{expected} standard"),
                format!("{expected} standard edition"),
            ]
            .contains(&actual))
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
pub async fn load(
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
        if !identity_matches(game, product) {
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
        assert!(identity_matches(&game, &product));
        product["Properties"]["XboxConsoleGenCompatible"] = serde_json::json!([]);
        assert!(!identity_matches(&game, &product));
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
