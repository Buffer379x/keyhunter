//! Explicit synthetic provider for browser checks; never selected by the production binary.
use async_trait::async_trait;
use keyhunter::{
    catalog::provider::{
        CatalogError, CatalogGame, CatalogProvider, IgdbCredentials, ProviderStatus,
    },
    config::Config,
    create_app_with_catalog,
};
use std::{
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};

struct FixtureProvider(AtomicBool);
fn fixture(id: i64, name: &str, kind: &str, platforms: &[i64]) -> CatalogGame {
    CatalogGame {
        igdb_id: id,
        name: name.into(),
        slug: None,
        summary: Some(
            "Synthetischer Datensatz für den lokalen Browser-Test. Keine Shoppreise.".into(),
        ),
        first_release_date: Some(1636416000),
        platforms: platforms
            .iter()
            .map(|id| keyhunter::catalog::provider::Platform {
                id: *id,
                name: if *id == 169 {
                    "Xbox Series X|S"
                } else {
                    "Xbox One"
                }
                .into(),
            })
            .collect(),
        aliases: vec!["Alternativer Testtitel".into()],
        cover_url: None,
        artwork_url: None,
        store_product_id: None,
        version_parent: (kind == "edition").then_some(1001),
        edition_name: (kind == "edition").then_some("Premium Edition".into()),
        kind: kind.into(),
        fetched_at: 1794940000,
    }
}
#[async_trait]
impl CatalogProvider for FixtureProvider {
    async fn edition_contents(
        &self,
        games: &[CatalogGame],
    ) -> Result<Vec<keyhunter::catalog::contents::EditionContent>, CatalogError> {
        use keyhunter::catalog::contents::{ContentItem, EditionContent};
        Ok(games
            .iter()
            .map(|game| EditionContent {
                igdb_id: game.igdb_id,
                status: "verified".into(),
                source_url: None,
                observed_at: 1795107000,
                description: Some("Synthetische Editionsinhalte für den Browser-Test.".into()),
                items: if game.kind == "edition" {
                    vec![
                        ContentItem {
                            id: "fixture-base".into(),
                            name: "Grundspiel".into(),
                        },
                        ContentItem {
                            id: "fixture-extra".into(),
                            name: "Zusatzpaket".into(),
                        },
                    ]
                } else {
                    vec![ContentItem {
                        id: "fixture-base".into(),
                        name: "Grundspiel".into(),
                    }]
                },
            })
            .collect())
    }
    async fn search(&self, query: &str, _platform: i64) -> Result<Vec<CatalogGame>, CatalogError> {
        let query = query.to_lowercase();
        if query.contains("ausfall") {
            return Err(CatalogError::Unavailable);
        }
        if query.starts_with("alt-") {
            tokio::time::sleep(Duration::from_millis(900)).await;
            return Ok(vec![fixture(1007, "Alter Treffer", "base_game", &[169])]);
        }
        if query == "neu" {
            return Ok(vec![fixture(1008, "Neuer Treffer", "base_game", &[169])]);
        }
        if query.contains("kein") {
            return Ok(vec![]);
        }
        if query.contains("dlc") {
            return Ok(vec![fixture(
                1004,
                "Testspiel Zusatzinhalt (DLC)",
                "dlc",
                &[169],
            )]);
        }
        Ok(vec![
            fixture(1001, "Forza Horizon 5", "base_game", &[169, 49]),
            fixture(
                1002,
                "Forza Horizon 5: Premium Edition",
                "edition",
                &[169, 49],
            ),
        ])
    }
    async fn game(&self, id: i64) -> Result<Option<CatalogGame>, CatalogError> {
        Ok(match id {
            1001 => Some(fixture(id, "Forza Horizon 5", "base_game", &[169, 49])),
            1002 => Some(fixture(
                id,
                "Forza Horizon 5: Premium Edition",
                "edition",
                &[169, 49],
            )),
            1007 => Some(fixture(id, "Alter Treffer", "base_game", &[169])),
            1008 => Some(fixture(id, "Neuer Treffer", "base_game", &[169])),
            _ => None,
        })
    }
    async fn editions(&self, _parent: i64) -> Result<Vec<CatalogGame>, CatalogError> {
        Ok(vec![
            fixture(1001, "Forza Horizon 5", "base_game", &[169, 49]),
            fixture(
                1002,
                "Forza Horizon 5: Premium Edition",
                "edition",
                &[169, 49],
            ),
        ])
    }
    async fn status(&self) -> ProviderStatus {
        ProviderStatus {
            configured: self.0.load(Ordering::Relaxed),
            state: if self.0.load(Ordering::Relaxed) {
                "configured"
            } else {
                "not_configured"
            }
            .into(),
            last_success_at: None,
            retry_at: None,
        }
    }
    async fn update_credentials(
        &self,
        credentials: Option<IgdbCredentials>,
    ) -> Result<(), CatalogError> {
        self.0.store(credentials.is_some(), Ordering::Relaxed);
        Ok(())
    }
}

/// With `KEYHUNTER_FIXTURE_PRICES=1`: one confirmed Eneba link for "Forza Horizon 5" (Xbox
/// Series X|S) with 16 days of synthetic DE prices, so badges show a 14-day trend. Target
/// country becomes DE. Off by default because the browser suite expects an empty wishlist.
async fn seed_prices(data_dir: &std::path::Path) -> anyhow::Result<()> {
    use sha2::{Digest, Sha256};
    const WISH: &str = "f1c7000000000000000000000000a001";
    let pool = sqlx::SqlitePool::connect_with(
        sqlx::sqlite::SqliteConnectOptions::new()
            .filename(data_dir.join("keyhunter.db"))
            .foreign_keys(true),
    )
    .await?;
    let seeded: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM wishlist_item WHERE id=?)")
        .bind(WISH)
        .fetch_one(&pool)
        .await?;
    if seeded {
        return Ok(());
    }
    let t = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)?
        .as_secs() as i64;
    let day = 86400;
    let today = t - t % day;
    let game = fixture(1001, "Forza Horizon 5", "base_game", &[169, 49]);
    // Same identity as `Product::fingerprint` in the library.
    let fingerprint = hex::encode(Sha256::digest(
        serde_json::json!([2, "fixture-fh5", true, [169]]).to_string(),
    ));
    let product = |cents: i64, availability: &str| {
        serde_json::json!({"id":"fixture-fh5","name":"Forza Horizon 5 (Xbox Series X|S) Xbox Live Key EUROPE",
            "title":"Forza Horizon 5","platform_ids":[169],"key_game":true,"region":"Europe","allowed":["DE"],
            "blocked":[],"purchase_country":"DE","offers":[{"id":"fixture-offer","cents":cents,"seller":"Fixture-Händler"}],
            "availability":availability})
    };
    let mut tx = pool.begin().await?;
    sqlx::query("UPDATE app_settings SET target_country='DE' WHERE id=1")
        .execute(&mut *tx)
        .await?;
    sqlx::query("INSERT OR IGNORE INTO catalog_game(igdb_id,payload,fetched_at) VALUES(1001,?,?)")
        .bind(serde_json::to_string(&game)?)
        .bind(t)
        .execute(&mut *tx)
        .await?;
    sqlx::query("INSERT OR IGNORE INTO game(id,igdb_id,created_at) VALUES('fixture-fh5',1001,?)")
        .bind(t)
        .execute(&mut *tx)
        .await?;
    sqlx::query("INSERT INTO wishlist_item(id,game_id,platform_id,created_at) VALUES(?,'fixture-fh5',169,?)")
        .bind(WISH)
        .bind(t - 20 * day)
        .execute(&mut *tx)
        .await?;
    let link: i64 = sqlx::query_scalar(
        "INSERT INTO offer_link(wish_id,source,url,review,fingerprint,latest,observed_at,attempted_at,confirmed_name)
        VALUES(?,'eneba','https://www.eneba.com/de/xbox-forza-horizon-5-xbox-series-x-s-xbox-live-key-europe','confirmed',?,?,?,?,?) RETURNING id",
    )
    .bind(WISH)
    .bind(&fingerprint)
    .bind(product(2399, "in_stock").to_string())
    .bind(t - 600)
    .bind(t - 600)
    .bind("Forza Horizon 5 (Xbox Series X|S) Xbox Live Key EUROPE")
    .fetch_one(&mut *tx)
    .await?;
    // Days ago and price; `None` is a sold-out day, which shows as a gap.
    let history = [
        (16, Some(3199)),
        (13, Some(2999)),
        (11, Some(3099)),
        (9, Some(2799)),
        (7, None),
        (6, Some(2899)),
        (4, Some(2549)),
        (2, Some(2649)),
        (0, Some(2399)),
    ];
    for (ago, cents) in history {
        let at = if ago == 0 {
            t - 600
        } else {
            today - ago * day + 10 * 3600
        };
        let observed = product(
            cents.unwrap_or(0),
            if cents.is_some() {
                "in_stock"
            } else {
                "sold_out"
            },
        );
        sqlx::query("INSERT INTO price_observation(link_id,product_id,observed_at,market,fingerprint,offers,activation,availability) VALUES(?,'fixture-fh5',?,'DE',?,?,'confirmed',?)")
            .bind(link).bind(at).bind(&fingerprint)
            .bind(if cents.is_some() { observed["offers"].to_string() } else { "[]".into() })
            .bind(observed["availability"].as_str()).execute(&mut *tx).await?;
    }
    tx.commit().await?;
    Ok(())
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let config = Config::from_env()?;
    let bind = config.bind;
    let data_dir = config.data_dir.clone();
    let app =
        create_app_with_catalog(config, Arc::new(FixtureProvider(AtomicBool::new(true)))).await?;
    if std::env::var("KEYHUNTER_FIXTURE_PRICES").as_deref() == Ok("1") {
        seed_prices(&data_dir).await?;
    }
    let listener = tokio::net::TcpListener::bind(bind).await?;
    axum::serve(listener, app).await?;
    Ok(())
}
