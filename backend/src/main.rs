use anyhow::{Result, bail};
use keyhunter::{config::Config, container, create_app, reset_owner, setup_code_text};

fn main() -> Result<()> {
    let mut args: Vec<String> = std::env::args().skip(1).collect();
    // User checks and the privilege drop of the container start (SEC-05), before the runtime starts any thread.
    if let Err(message) = container::prepare(&mut args) {
        eprintln!("KeyHunter: {message}");
        std::process::exit(1);
    }
    tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()?
        .block_on(run(args))
}

async fn run(args: Vec<String>) -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "keyhunter=info".into()),
        )
        .init();
    let config = Config::from_env()?;
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
        // The setup code for `docker exec`, the image has no shell or cat (SEC-05).
        [flag] if flag == "--setup-code" => {
            println!("{}", setup_code_text(&config)?);
            return Ok(());
        }
        // Container healthcheck without curl in the image (SEC-05).
        [flag] if flag == "--health" => {
            if !keyhunter::health::ready(config.bind) {
                std::process::exit(1);
            }
            return Ok(());
        }
        // Parser canary (PROD-13): by hand only, with consent; see deploy/parser-canary.sh.
        [flag, links @ ..] if flag == "--canary" => {
            let consent = std::env::var(keyhunter::canary::CONSENT_VARIABLE).ok();
            if !keyhunter::canary::run(links, consent.as_deref()).await? {
                std::process::exit(1);
            }
            return Ok(());
        }
        _ => bail!(
            "Unknown arguments {args:?}. Usage: keyhunter [--init-unraid-data] [--reset-owner | --setup-code | --health | --canary <product-link>...]"
        ),
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
