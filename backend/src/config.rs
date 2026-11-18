use anyhow::{Context, Result, bail};
use std::{env, net::SocketAddr, path::PathBuf};
use url::{Host, Url};

#[derive(Clone)]
pub struct Config {
    pub bind: SocketAddr,
    pub origin: Option<String>,
    pub data_dir: PathBuf,
    pub frontend_dir: PathBuf,
    pub bootstrap_file: Option<PathBuf>,
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
                .ok()
                .filter(|origin| !origin.is_empty())
                .map(|origin| origin.trim_end_matches('/').to_string()),
            data_dir: env::var_os("KEYHUNTER_DATA_DIR")
                .map(PathBuf::from)
                .unwrap_or_else(|| "data".into()),
            frontend_dir: env::var_os("KEYHUNTER_FRONTEND_DIR")
                .map(PathBuf::from)
                .unwrap_or_else(|| "../frontend/dist".into()),
            bootstrap_file: env::var_os("KEYHUNTER_BOOTSTRAP_FILE").map(PathBuf::from),
            allow_insecure_http: match env::var("KEYHUNTER_ALLOW_INSECURE_HTTP").as_deref() {
                Ok("true") | Err(_) => true,
                Ok("false") => false,
                _ => bail!("KEYHUNTER_ALLOW_INSECURE_HTTP must be true or false"),
            },
        };
        config.validate()?;
        Ok(config)
    }

    pub fn validate(&self) -> Result<()> {
        if let Some(origin) = &self.origin {
            let url = parse_origin(origin).context(
                "KEYHUNTER_ORIGIN must be an exact HTTP(S) origin without a path or credentials",
            )?;
            if url.scheme() == "http" && !self.allow_insecure_http {
                bail!("KEYHUNTER_ORIGIN uses HTTP but KEYHUNTER_ALLOW_INSECURE_HTTP is false");
            }
        }
        if !self.frontend_dir.join("index.html").is_file() {
            bail!("Frontend build missing: build frontend/dist before starting KEYHUNTER");
        }
        Ok(())
    }
}

pub(crate) fn parse_origin(origin: &str) -> Option<Url> {
    let url = Url::parse(origin).ok()?;
    (matches!(url.scheme(), "http" | "https") && url.origin().ascii_serialization() == origin)
        .then_some(url)
}

pub(crate) fn is_local_http_origin(origin: &Url) -> bool {
    match origin.host() {
        Some(Host::Domain("localhost")) => true,
        Some(Host::Ipv4(ip)) => ip.is_private() || ip.is_loopback(),
        Some(Host::Ipv6(ip)) => ip.is_unique_local() || ip.is_loopback(),
        _ => false,
    }
}
