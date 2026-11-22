use anyhow::{Context, Result, bail};
use std::{
    env,
    net::{IpAddr, SocketAddr},
    path::PathBuf,
};
use url::{Host, Url};

#[derive(Clone)]
pub struct Config {
    pub bind: SocketAddr,
    pub origin: Option<String>,
    pub data_dir: PathBuf,
    pub frontend_dir: PathBuf,
    pub bootstrap_file: Option<PathBuf>,
    pub allow_insecure_http: bool,
    /// Reverse proxies whose `X-Forwarded-For` names the client for the sign-in throttle
    /// (`KEYHUNTER_TRUSTED_PROXY`: IP addresses or CIDR ranges, comma-separated). Empty: the peer counts.
    pub trusted_proxies: Vec<Network>,
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
            trusted_proxies: env::var("KEYHUNTER_TRUSTED_PROXY")
                .unwrap_or_default()
                .split(',')
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(|value| {
                    Network::parse(value).with_context(|| {
                        format!("KEYHUNTER_TRUSTED_PROXY: {value:?} is no IP address or CIDR range")
                    })
                })
                .collect::<Result<_>>()?,
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
            bail!("Frontend build missing: build frontend/dist before starting KeyHunter");
        }
        Ok(())
    }
}

pub(crate) fn parse_origin(origin: &str) -> Option<Url> {
    let url = Url::parse(origin).ok()?;
    (matches!(url.scheme(), "http" | "https") && url.origin().ascii_serialization() == origin)
        .then_some(url)
}

// Private-network names: "localhost", single-label names (e.g. "tower") and
// well-known local-only suffixes.
fn is_private_hostname(name: &str) -> bool {
    let name = name.trim_end_matches('.').to_ascii_lowercase();
    !name.is_empty()
        && (!name.contains('.')
            || [".local", ".lan", ".home.arpa", ".internal"]
                .iter()
                .any(|suffix| name.ends_with(suffix)))
}

pub(crate) fn is_local_http_origin(origin: &Url) -> bool {
    match origin.host() {
        Some(Host::Domain(name)) => is_private_hostname(name),
        Some(Host::Ipv4(ip)) => ip.is_private() || ip.is_loopback(),
        Some(Host::Ipv6(ip)) => ip.is_unique_local() || ip.is_loopback(),
        _ => false,
    }
}

/// An IP address or CIDR range, e.g. `172.18.0.0/16` or `fd00::/8`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Network {
    addr: IpAddr,
    prefix: u8,
}

impl Network {
    pub fn parse(value: &str) -> Option<Self> {
        let (addr, prefix) = match value.split_once('/') {
            Some((addr, prefix)) => (
                addr.parse::<IpAddr>().ok()?,
                Some(prefix.parse::<u8>().ok()?),
            ),
            None => (value.parse::<IpAddr>().ok()?, None),
        };
        let addr = addr.to_canonical();
        let bits = if addr.is_ipv4() { 32 } else { 128 };
        let prefix = prefix.unwrap_or(bits);
        (prefix <= bits).then_some(Self { addr, prefix })
    }

    pub fn contains(&self, ip: IpAddr) -> bool {
        // Compare the network bits; a shift by the full width (prefix 0) is None on both sides.
        let host_bits = |width: u32| width - u32::from(self.prefix);
        match (self.addr, ip.to_canonical()) {
            (IpAddr::V4(net), IpAddr::V4(ip)) => {
                u32::from(net).checked_shr(host_bits(32))
                    == u32::from(ip).checked_shr(host_bits(32))
            }
            (IpAddr::V6(net), IpAddr::V6(ip)) => {
                u128::from(net).checked_shr(host_bits(128))
                    == u128::from(ip).checked_shr(host_bits(128))
            }
            _ => false,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::Network;

    #[test]
    fn trusted_proxy_ranges_match_addresses_of_their_family() {
        let net = Network::parse("172.18.0.0/16").unwrap();
        assert!(net.contains("172.18.4.2".parse().unwrap()));
        assert!(net.contains("::ffff:172.18.4.2".parse().unwrap()));
        assert!(!net.contains("172.19.0.1".parse().unwrap()));
        assert!(!net.contains("::1".parse().unwrap()));
        let single = Network::parse("192.168.1.2").unwrap();
        assert!(single.contains("192.168.1.2".parse().unwrap()));
        assert!(!single.contains("192.168.1.3".parse().unwrap()));
        assert!(
            Network::parse("0.0.0.0/0")
                .unwrap()
                .contains("8.8.8.8".parse().unwrap())
        );
        assert!(
            Network::parse("fd00::/8")
                .unwrap()
                .contains("fd12::1".parse().unwrap())
        );
        for invalid in ["", "proxy", "10.0.0.0/33", "::/129", "10.0.0.0/x"] {
            assert_eq!(Network::parse(invalid), None, "{invalid}");
        }
    }
}
