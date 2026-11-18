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
        version_parent: (kind == "edition").then_some(1001),
        edition_name: (kind == "edition").then_some("Premium Edition".into()),
        kind: kind.into(),
        fetched_at: 1794940000,
    }
}
#[async_trait]
impl CatalogProvider for FixtureProvider {
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

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let config = Config::from_env()?;
    let bind = config.bind;
    let app =
        create_app_with_catalog(config, Arc::new(FixtureProvider(AtomicBool::new(true)))).await?;
    let listener = tokio::net::TcpListener::bind(bind).await?;
    axum::serve(listener, app).await?;
    Ok(())
}
