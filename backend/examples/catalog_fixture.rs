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
                via: None,
                store_title: None,
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
            _ => PRICED
                .iter()
                .find(|(priced, _)| *priced == id)
                .map(|(_, name)| fixture(id, name, "base_game", &[169, 49])),
        })
    }
    async fn editions(&self, parent: i64) -> Result<Vec<CatalogGame>, CatalogError> {
        // The priced test games have no other edition.
        if let Some((id, name)) = PRICED.iter().find(|(id, _)| *id == parent) {
            return Ok(vec![fixture(*id, name, "base_game", &[169, 49])]);
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

/// The synthetic wishes of `KEYHUNTER_FIXTURE_PRICES=1` besides "Forza Horizon 5" (1001): igdb id and title.
const PRICED: [(i64, &str); 6] = [
    (1031, "Teststadt Chroniken"),
    (1032, "Leerlauf Legende"),
    (1033, "Funkstille Frontier"),
    (1034, "Lichtungsfall"),
    (1035, "Pausenzeit Odyssee"),
    (1036, "Suchlauf Saga"),
];

/// A synthetic shop product of the fixture: an Xbox Series key bought for a buyer in Germany. `allowed` are the
/// countries it can be activated in; `quotes` are the seller prices in cents.
fn product(
    id: &str,
    title: &str,
    region: &str,
    allowed: &[&str],
    quotes: &[i64],
    availability: &str,
) -> serde_json::Value {
    let offers: Vec<_> = quotes
        .iter()
        .enumerate()
        .map(|(n, cents)| serde_json::json!({"id":format!("{id}-{n}"),"cents":cents,"seller":format!("Fixture-Händler {}", n + 1)}))
        .collect();
    serde_json::json!({"id":id,"name":format!("{title} (Xbox Series X|S) Xbox Live Key {}", region.to_uppercase()),
        "title":title,"platform_ids":[169],"key_game":true,"region":region,"allowed":allowed,"blocked":[],
        "purchase_country":"DE","offers":offers,"availability":availability})
}

/// One link of a seeded wish: the product it points at, when it was read, and the error of its latest fetch.
struct SeedLink<'a> {
    source: &'a str,
    product: serde_json::Value,
    /// Seconds before now of the last successful read.
    read_ago: i64,
    error: Option<&'a str>,
}

/// With `KEYHUNTER_FIXTURE_PRICES=1`, seeded without any network access (the fixture runs no shop workers):
/// - "Forza Horizon 5": a confirmed Eneba link with 16 days of DE prices (usable in the whole EU) and a cheaper
///   Driffle offer from India, so the list shows a trend, a saving and the INT price;
/// - "Teststadt Chroniken": a stale Eneba price (3 days old) next to a current Indian one: no saving may be shown;
/// - "Leerlauf Legende": a confirmed link without any offer yet (nothing read, no error);
/// - "Funkstille Frontier": a link whose latest fetch failed and has no price at all;
/// - "Lichtungsfall": a price whose latest fetch failed, next to a current Indian one;
/// - "Pausenzeit Odyssee" (paused) and "Suchlauf Saga": the same pending search, the first one on hold.
///
/// Target country becomes DE. Off by default because the browser suite expects an empty wishlist.
async fn seed_prices(data_dir: &std::path::Path) -> anyhow::Result<()> {
    use sha2::{Digest, Sha256};
    let pool = sqlx::SqlitePool::connect_with(
        sqlx::sqlite::SqliteConnectOptions::new()
            .filename(data_dir.join("keyhunter.db"))
            .foreign_keys(true),
    )
    .await?;
    let seeded: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM wishlist_item WHERE game_id='fixture-fh5')",
    )
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
    let wish_id = |igdb: i64| format!("f1c70000000000000000000000{igdb:06}");
    let eu = ["DE", "AT", "FR"];
    let mut tx = pool.begin().await?;
    sqlx::query("UPDATE app_settings SET target_country='DE' WHERE id=1")
        .execute(&mut *tx)
        .await?;
    // Driffle is off by default; the seeded Indian offers come from it.
    sqlx::query("UPDATE source_settings SET enabled=1 WHERE id='driffle'")
        .execute(&mut *tx)
        .await?;
    let mut games = vec![(
        1001,
        "Forza Horizon 5".to_string(),
        "fixture-fh5".to_string(),
    )];
    games.extend(
        PRICED
            .iter()
            .map(|(id, name)| (*id, name.to_string(), format!("fixture-{id}"))),
    );
    for (n, (igdb, name, game_id)) in games.iter().enumerate() {
        let game = fixture(*igdb, name, "base_game", &[169, 49]);
        sqlx::query("INSERT OR IGNORE INTO catalog_game(igdb_id,payload,fetched_at) VALUES(?,?,?)")
            .bind(igdb)
            .bind(serde_json::to_string(&game)?)
            .bind(t)
            .execute(&mut *tx)
            .await?;
        sqlx::query("INSERT OR IGNORE INTO game(id,igdb_id,created_at) VALUES(?,?,?)")
            .bind(game_id)
            .bind(igdb)
            .bind(t)
            .execute(&mut *tx)
            .await?;
        // Newest first in the list: Forza is the oldest wish.
        sqlx::query(
            "INSERT INTO wishlist_item(id,game_id,platform_id,created_at) VALUES(?,?,169,?)",
        )
        .bind(wish_id(*igdb))
        .bind(game_id)
        .bind(t - 20 * day + n as i64 * 3600)
        .execute(&mut *tx)
        .await?;
    }
    let fh5 = product(
        "fixture-fh5",
        "Forza Horizon 5",
        "Europe",
        &eu,
        &[2399, 2499],
        "in_stock",
    );
    let links: Vec<(i64, Vec<SeedLink>)> = vec![
        (
            1001,
            vec![
                SeedLink {
                    source: "eneba",
                    product: fh5.clone(),
                    read_ago: 600,
                    error: None,
                },
                SeedLink {
                    source: "driffle",
                    product: product(
                        "fixture-fh5-in",
                        "Forza Horizon 5",
                        "India",
                        &[],
                        &[1299],
                        "in_stock",
                    ),
                    read_ago: 900,
                    error: None,
                },
            ],
        ),
        (
            1031,
            vec![
                SeedLink {
                    source: "eneba",
                    product: product(
                        "fixture-1031",
                        "Teststadt Chroniken",
                        "Europe",
                        &eu,
                        &[1999],
                        "in_stock",
                    ),
                    read_ago: 3 * day,
                    error: None,
                },
                SeedLink {
                    source: "driffle",
                    product: product(
                        "fixture-1031-in",
                        "Teststadt Chroniken",
                        "India",
                        &[],
                        &[999],
                        "in_stock",
                    ),
                    read_ago: 900,
                    error: None,
                },
            ],
        ),
        (
            1032,
            vec![SeedLink {
                source: "eneba",
                product: product(
                    "fixture-1032",
                    "Leerlauf Legende",
                    "Europe",
                    &eu,
                    &[],
                    "unknown",
                ),
                read_ago: 3600,
                error: None,
            }],
        ),
        (
            1033,
            vec![SeedLink {
                source: "eneba",
                product: product(
                    "fixture-1033",
                    "Funkstille Frontier",
                    "Europe",
                    &eu,
                    &[],
                    "unknown",
                ),
                read_ago: 3600,
                error: Some("network"),
            }],
        ),
        (
            1034,
            vec![
                SeedLink {
                    source: "eneba",
                    product: product(
                        "fixture-1034",
                        "Lichtungsfall",
                        "Europe",
                        &eu,
                        &[3499],
                        "in_stock",
                    ),
                    read_ago: 3600,
                    error: Some("network"),
                },
                SeedLink {
                    source: "driffle",
                    product: product(
                        "fixture-1034-in",
                        "Lichtungsfall",
                        "India",
                        &[],
                        &[1099],
                        "in_stock",
                    ),
                    read_ago: 900,
                    error: None,
                },
            ],
        ),
    ];
    for (igdb, links) in links {
        for link in links {
            let id = link.product["id"].as_str().unwrap_or_default().to_string();
            let title = link.product["title"]
                .as_str()
                .unwrap_or_default()
                .to_string();
            // Same identity as `Product::fingerprint` in the library.
            let fingerprint = hex::encode(Sha256::digest(
                serde_json::json!([2, id, true, [169]]).to_string(),
            ));
            let read = t - link.read_ago;
            let name = link.product["name"]
                .as_str()
                .unwrap_or_default()
                .to_string();
            let url = format!("https://www.{}.com/de/{id}", link.source);
            let link_id: i64 = sqlx::query_scalar(
                "INSERT INTO offer_link(wish_id,source,url,review,fingerprint,latest,observed_at,attempted_at,last_error,confirmed_name)
                VALUES(?,?,?,'confirmed',?,?,?,?,?,?) RETURNING id",
            )
            .bind(wish_id(igdb))
            .bind(link.source)
            .bind(url)
            .bind(&fingerprint)
            .bind(link.product.to_string())
            .bind(read)
            .bind(if link.error.is_some() { t - 600 } else { read })
            .bind(link.error)
            .bind(name)
            .fetch_one(&mut *tx)
            .await?;
            let observe = |at: i64, product: &serde_json::Value| {
                let offers = product["offers"].to_string();
                let availability = product["availability"]
                    .as_str()
                    .unwrap_or("unknown")
                    .to_string();
                let activation = if product["allowed"]
                    .as_array()
                    .is_some_and(|c| c.iter().any(|c| c == "DE"))
                {
                    "confirmed"
                } else {
                    "unknown"
                };
                (at, offers, availability, activation)
            };
            let mut seen = vec![observe(read, &link.product)];
            if igdb == 1001 && title == "Forza Horizon 5" && link.source == "eneba" {
                // Days ago and lowest price; `None` is a sold-out day, which shows as a gap in the trend.
                let history = [
                    (16, Some(3199)),
                    (13, Some(2999)),
                    (11, Some(3099)),
                    (9, Some(2799)),
                    (7, None),
                    (6, Some(2899)),
                    (4, Some(2549)),
                    (2, Some(2649)),
                ];
                for (ago, cents) in history {
                    let mut past = fh5.clone();
                    past["offers"] = match cents {
                        Some(cents) => {
                            serde_json::json!([{"id":"fixture-offer","cents":cents,"seller":"Fixture-Händler 1"}])
                        }
                        None => serde_json::json!([]),
                    };
                    past["availability"] = if cents.is_some() {
                        "in_stock"
                    } else {
                        "sold_out"
                    }
                    .into();
                    seen.push(observe(today - ago * day + 10 * 3600, &past));
                }
            }
            for (at, offers, availability, activation) in seen {
                sqlx::query("INSERT INTO price_observation(link_id,product_id,observed_at,market,fingerprint,offers,activation,availability) VALUES(?,?,?,'DE',?,?,?,?)")
                    .bind(link_id).bind(&id).bind(at).bind(&fingerprint).bind(offers).bind(activation).bind(availability)
                    .execute(&mut *tx).await?;
            }
        }
    }
    // The daily discovery would show "Wird gesucht" on every wish: it ran an hour ago.
    sqlx::query(
        "UPDATE shop_job SET due=?, checked_at=? WHERE wish_id IS NULL AND link_id IS NULL",
    )
    .bind(t + 30 * day)
    .bind(t - 3600)
    .execute(&mut *tx)
    .await?;
    // The first search of two new wishes waits for its shop; the owner paused one of them.
    for igdb in [1035, 1036] {
        sqlx::query("INSERT INTO shop_job(source,wish_id,due) VALUES('eneba',?,0)")
            .bind(wish_id(igdb))
            .execute(&mut *tx)
            .await?;
    }
    sqlx::query("UPDATE wishlist_item SET paused_at=? WHERE id=?")
        .bind(t - 3600)
        .bind(wish_id(1035))
        .execute(&mut *tx)
        .await?;
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
    axum::serve(
        listener,
        app.into_make_service_with_connect_info::<std::net::SocketAddr>(),
    )
    .await?;
    Ok(())
}
