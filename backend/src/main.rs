use anyhow::{Result, bail};
use keyhunter::{config::Config, create_app, reset_owner};

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "keyhunter=info".into()),
        )
        .init();
    let config = Config::from_env()?;
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.as_slice() {
        [] => {}
        // Owner recovery for a forgotten passphrase (SEC-03), from a shell only: docs/operations.md.
        [flag] if flag == "--reset-owner" => {
            let reset = reset_owner(&config).await?;
            println!(
                "KeyHunter: owner {}, {} session(s) ended. Open KeyHunter and set it up again with the new code in {}. Wishlist, prices and settings are kept.",
                if reset.had_owner {
                    "removed"
                } else {
                    "was not set up yet"
                },
                reset.ended_sessions,
                reset.setup_file.display()
            );
            return Ok(());
        }
        _ => bail!("Unknown arguments {args:?}. Usage: keyhunter [--reset-owner]"),
    }
    let bind = config.bind;
    let app = create_app(config).await?;
    let listener = tokio::net::TcpListener::bind(bind).await?;
    tracing::info!(%bind, "KeyHunter ready");
    axum::serve(
        listener,
        app.into_make_service_with_connect_info::<std::net::SocketAddr>(),
    )
    .with_graceful_shutdown(shutdown())
    .await?;
    Ok(())
}

async fn shutdown() {
    let ctrl_c = async {
        let _ = tokio::signal::ctrl_c().await;
    };
    #[cfg(unix)]
    let terminate = async {
        if let Ok(mut signal) =
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
        {
            signal.recv().await;
        }
    };
    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();
    tokio::select! { _ = ctrl_c => {}, _ = terminate => {} }
}
