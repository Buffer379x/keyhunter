mod driffle;
pub(crate) mod eneba;
mod http;

use serde::{Deserialize, Serialize};
use url::Url;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Shop {
    Eneba,
    Driffle,
}

impl Shop {
    pub(crate) const ALL: [Self; 2] = [Self::Eneba, Self::Driffle];

    pub(crate) fn id(self) -> &'static str {
        match self {
            Self::Eneba => "eneba",
            Self::Driffle => "driffle",
        }
    }

    pub(crate) fn host(self) -> &'static str {
        match self {
            Self::Eneba => "www.eneba.com",
            Self::Driffle => "driffle.com",
        }
    }

    pub(crate) fn from_id(id: &str) -> Option<Self> {
        match id {
            "eneba" => Some(Self::Eneba),
            "driffle" => Some(Self::Driffle),
            _ => None,
        }
    }

    pub(crate) fn product_url(self, raw: &str) -> Option<Url> {
        let url = Url::parse(raw).ok()?;
        if url.scheme() != "https"
            || url.host_str() != Some(self.host())
            || url.port().is_some()
            || !url.username().is_empty()
            || url.password().is_some()
            || url.query().is_some()
            || url.fragment().is_some()
        {
            return None;
        }
        let path = url
            .path()
            .strip_prefix("/de/")
            .or_else(|| url.path().strip_prefix('/'))?;
        let valid = match self {
            Self::Eneba => path.starts_with("xbox-") && path.contains("-key-"),
            Self::Driffle => {
                path.contains("-xbox-live-digital-")
                    && path.rsplit_once("-p").is_some_and(|(_, id)| {
                        !id.is_empty() && id.len() <= 12 && id.bytes().all(|c| c.is_ascii_digit())
                    })
            }
        };
        if path.len() > 220
            || !valid
            || !path
                .bytes()
                .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-')
        {
            return None;
        }
        Url::parse(&format!("https://{}/de/{path}", self.host())).ok()
    }

    pub(crate) async fn product(self, url: &Url) -> Result<Product, ShopError> {
        let mut client = http::PublicClient::new(self.host()).await?;
        let body = client.get(url, 2 * 1024 * 1024, false).await?;
        match self {
            Self::Eneba => eneba::parse(url, &body),
            Self::Driffle => driffle::parse(url, &body),
        }
    }

    pub(crate) async fn discover(self, shard: usize) -> Result<Vec<(String, String)>, ShopError> {
        match self {
            Self::Eneba => eneba::discover(self, shard).await,
            Self::Driffle => driffle::discover(self).await,
        }
    }
}

pub(crate) fn product_link(raw: &str) -> Option<(Shop, Url)> {
    Shop::ALL
        .into_iter()
        .find_map(|shop| Some((shop, shop.product_url(raw)?)))
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub(crate) struct Product {
    pub id: String,
    pub name: String,
    pub title: String,
    pub platform_ids: Vec<i64>,
    pub key_game: bool,
    pub region: Option<String>,
    pub allowed: Vec<String>,
    pub blocked: Vec<String>,
    pub purchase_country: Option<String>,
    pub offers: Vec<Quote>,
    pub availability: Availability,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub(crate) struct Quote {
    pub id: String,
    pub cents: i64,
    pub seller: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum Availability {
    InStock,
    SoldOut,
    Unknown,
}

impl Availability {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::InStock => "in_stock",
            Self::SoldOut => "sold_out",
            Self::Unknown => "unknown",
        }
    }
}

impl Product {
    pub(crate) fn activation(&self, country: &str) -> &'static str {
        if !country.is_empty() && self.blocked.iter().any(|c| c == country) {
            "blocked"
        } else if !country.is_empty() && self.allowed.iter().any(|c| c == country) {
            "confirmed"
        } else {
            "unknown"
        }
    }

    /// Stable identity of a confirmed product: shop product id, key type and platforms.
    /// A renamed shop title keeps the confirmation (audit DQ-05).
    pub(crate) fn fingerprint(&self) -> String {
        let identity = serde_json::json!([2, self.id, self.key_game, self.platform_ids]);
        hex::encode(crate::digest(&identity.to_string()))
    }

    /// Identity up to 0.5, which also contained the normalized title.
    fn legacy_fingerprint(&self) -> String {
        let identity = serde_json::json!([
            1,
            self.id,
            title_key(&self.title),
            self.key_game,
            self.platform_ids
        ]);
        hex::encode(crate::digest(&identity.to_string()))
    }
}

/// Move confirmations and price history from the 0.5 fingerprint to the stable one.
/// Idempotent: only rows that still carry the old fingerprint of their latest product change.
pub(crate) async fn upgrade_fingerprints(pool: &sqlx::SqlitePool) -> sqlx::Result<()> {
    let rows: Vec<(i64, String)> = sqlx::query_as(
        "SELECT id,latest FROM offer_link WHERE latest IS NOT NULL AND fingerprint IS NOT NULL",
    )
    .fetch_all(pool)
    .await?;
    let mut tx = pool.begin().await?;
    for (id, latest) in rows {
        let Ok(product) = serde_json::from_str::<Product>(&latest) else {
            continue;
        };
        let (old, new) = (product.legacy_fingerprint(), product.fingerprint());
        sqlx::query("UPDATE offer_link SET fingerprint=? WHERE id=? AND fingerprint=?")
            .bind(&new)
            .bind(id)
            .bind(&old)
            .execute(&mut *tx)
            .await?;
        sqlx::query("UPDATE OR IGNORE price_observation SET fingerprint=? WHERE link_id=? AND fingerprint=?")
            .bind(&new)
            .bind(id)
            .bind(&old)
            .execute(&mut *tx)
            .await?;
    }
    tx.commit().await
}

pub(crate) fn title_key(value: &str) -> String {
    value
        .split(|c: char| !c.is_alphanumeric())
        .filter(|token| !token.is_empty())
        .map(str::to_lowercase)
        .collect::<Vec<_>>()
        .join(" ")
}

#[derive(Debug)]
pub(crate) enum ShopError {
    Network,
    NotFound,
    Throttled(i64),
    Denied,
    Parse,
}

impl ShopError {
    pub(crate) fn code(&self) -> &'static str {
        match self {
            Self::Network => "network",
            Self::NotFound => "not_found",
            Self::Throttled(_) => "rate_limited",
            Self::Denied => "access_denied",
            Self::Parse => "invalid_response",
        }
    }

    pub(crate) fn source_pause(&self) -> i64 {
        match self {
            Self::Throttled(seconds) => *seconds,
            Self::Denied => 3600,
            _ => 0,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn input_only_allows_fixed_shop_hosts_and_product_paths() {
        const ENEBA: &str = "https://www.eneba.com/xbox-forza-horizon-5-pc-xbox-live-key-global";
        assert_eq!(
            product_link(ENEBA).unwrap().1.path(),
            "/de/xbox-forza-horizon-5-pc-xbox-live-key-global"
        );
        for url in [
            "http://www.eneba.com/xbox-a-key-b",
            "https://127.0.0.1/xbox-a-key-b",
            "https://www.eneba.com.example.com/xbox-a-key-b",
            "https://www.eneba.com:8443/xbox-a-key-b",
            "https://x@www.eneba.com/xbox-a-key-b",
            "https://www.eneba.com/xbox-a-key-b?x=y",
            "https://www.eneba.com/de/search",
            "https://driffle.com/de/store/collection/xbox-games",
        ] {
            assert!(product_link(url).is_none(), "{url}");
        }
    }

    #[tokio::test]
    async fn fingerprint_upgrade_keeps_confirmations_and_history() {
        let pool = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        sqlx::migrate!("./migrations").run(&pool).await.unwrap();
        let product = Product {
            id: "p1".into(),
            name: "Game".into(),
            title: "game".into(),
            platform_ids: vec![169],
            key_game: true,
            region: None,
            allowed: vec!["DE".into()],
            blocked: vec![],
            purchase_country: Some("DE".into()),
            offers: vec![],
            availability: Availability::InStock,
        };
        sqlx::query(
            "INSERT INTO game(id,manual_title,manual_key,created_at) VALUES('g','Game','game',0)",
        )
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query("INSERT INTO wishlist_item VALUES('w','g',169,0)")
            .execute(&pool)
            .await
            .unwrap();
        let latest = serde_json::to_string(&product).unwrap();
        for (id, fingerprint) in [(1, product.legacy_fingerprint()), (2, "manual".to_string())] {
            sqlx::query("INSERT INTO offer_link(id,wish_id,source,url,review,fingerprint,latest) VALUES(?,'w','eneba',?,'confirmed',?,?)")
                .bind(id).bind(format!("https://www.eneba.com/de/xbox-game-{id}-key-global")).bind(&fingerprint).bind(&latest)
                .execute(&pool).await.unwrap();
            sqlx::query("INSERT INTO price_observation(link_id,product_id,observed_at,market,fingerprint,offers,activation,availability) VALUES(?,'p1',1,'DE',?,'[]','confirmed','in_stock')")
                .bind(id).bind(&fingerprint).execute(&pool).await.unwrap();
        }
        for _ in 0..2 {
            upgrade_fingerprints(&pool).await.unwrap();
        }
        let links: Vec<String> =
            sqlx::query_scalar("SELECT fingerprint FROM offer_link ORDER BY id")
                .fetch_all(&pool)
                .await
                .unwrap();
        let history: Vec<String> =
            sqlx::query_scalar("SELECT fingerprint FROM price_observation ORDER BY link_id")
                .fetch_all(&pool)
                .await
                .unwrap();
        let expected = [product.fingerprint(), "manual".to_string()];
        assert_eq!(links, expected);
        assert_eq!(history, expected);
    }
}
