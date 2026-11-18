use anyhow::{Context, Result, bail};
use std::{env, net::SocketAddr, path::PathBuf};

#[derive(Clone)]
pub struct Config {
    pub bind: SocketAddr,
    pub origin: String,
    pub data_dir: PathBuf,
    pub frontend_dir: PathBuf,
    pub bootstrap_file: Option<PathBuf>,
    pub igdb_env_file: Option<PathBuf>,
    pub allow_insecure_http: bool,
}

impl Config {
    pub fn from_env() -> Result<Self> {
        let config = Self {
            bind: env::var("KEYHUNTER_BIND")
                .unwrap_or_else(|_| "127.0.0.1:3000".into())
                .parse()
                .context("Invalid KEYHUNTER_BIND")?,
            origin: env::var("KEYHUNTER_ORIGIN")
                .unwrap_or_else(|_| "http://localhost:3000".into())
                .trim_end_matches('/')
                .to_string(),
            data_dir: env::var_os("KEYHUNTER_DATA_DIR")
                .map(PathBuf::from)
                .unwrap_or_else(|| "data".into()),
            frontend_dir: env::var_os("KEYHUNTER_FRONTEND_DIR")
                .map(PathBuf::from)
                .unwrap_or_else(|| "../frontend/dist".into()),
            bootstrap_file: env::var_os("KEYHUNTER_BOOTSTRAP_FILE").map(PathBuf::from),
            igdb_env_file: env::var_os("KEYHUNTER_IGDB_ENV_FILE").map(PathBuf::from),
            allow_insecure_http: match env::var("KEYHUNTER_ALLOW_INSECURE_HTTP").as_deref() {
                Ok("true") => true,
                Ok("false") | Err(_) => false,
                _ => bail!("KEYHUNTER_ALLOW_INSECURE_HTTP must be true or false"),
            },
        };
        config.validate()?;
        Ok(config)
    }

    pub fn validate(&self) -> Result<()> {
        let url = url::Url::parse(&self.origin).context("Invalid KEYHUNTER_ORIGIN")?;
        if !url.username().is_empty()
            || url.password().is_some()
            || url.query().is_some()
            || url.fragment().is_some()
            || url.path() != "/"
            || url.host_str().is_none()
            || url.origin().ascii_serialization() != self.origin
        {
            bail!("KEYHUNTER_ORIGIN must be an exact origin without path or credentials");
        }
        match url.scheme() {
            "https" => {}
            "http"
                if self.allow_insecure_http
                    && matches!(
                        url.host_str(),
                        Some("localhost" | "127.0.0.1" | "[::1]" | "::1")
                    ) => {}
            _ => bail!("Use HTTPS, or explicitly allow HTTP for loopback development"),
        }
        if !self.frontend_dir.join("index.html").is_file() {
            bail!("Frontend build missing: build frontend/dist before starting KEYHUNTER");
        }
        Ok(())
    }

    pub fn secure_cookie(&self) -> bool {
        self.origin.starts_with("https://")
    }
}
