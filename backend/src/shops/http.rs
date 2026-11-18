use super::ShopError;
use reqwest::{Client, StatusCode, redirect::Policy};
use std::{
    net::{IpAddr, Ipv4Addr},
    time::{Duration, SystemTime},
};
use tokio::time::{Instant, sleep_until, timeout};
use url::Url;

const USER_AGENT: &str = "Keyhunter";

pub(super) struct PublicClient {
    client: Client,
    host: &'static str,
    robots: Robots,
    next: Instant,
}

impl PublicClient {
    pub(super) async fn new(host: &'static str) -> Result<Self, ShopError> {
        let ips: Vec<_> = timeout(Duration::from_secs(5), tokio::net::lookup_host((host, 443)))
            .await
            .map_err(|_| ShopError::Network)?
            .map_err(|_| ShopError::Network)?
            .collect();
        if ips.is_empty() || ips.iter().any(|ip| !public_ip(ip.ip())) {
            return Err(ShopError::Denied);
        }
        let client = Client::builder()
            .no_proxy()
            .redirect(Policy::none())
            .resolve_to_addrs(host, &ips)
            .user_agent(USER_AGENT)
            .connect_timeout(Duration::from_secs(5))
            .timeout(Duration::from_secs(15))
            .build()
            .map_err(|_| ShopError::Network)?;
        let url =
            Url::parse(&format!("https://{host}/robots.txt")).map_err(|_| ShopError::Denied)?;
        let body = fetch(&client, &url, 128 * 1024, false).await?;
        let robots = Robots::parse(&body)?;
        let next = Instant::now() + Duration::from_secs(robots.delay);
        Ok(Self {
            client,
            host,
            robots,
            next,
        })
    }

    pub(super) async fn get(
        &mut self,
        url: &Url,
        limit: usize,
        prefix: bool,
    ) -> Result<String, ShopError> {
        if url.scheme() != "https"
            || url.host_str() != Some(self.host)
            || url.port().is_some()
            || !url.username().is_empty()
            || url.password().is_some()
            || !allowed_query(url)
            || !self.robots.allows(&url[url::Position::BeforePath..])
        {
            return Err(ShopError::Denied);
        }
        sleep_until(self.next).await;
        let result = fetch(&self.client, url, limit, prefix).await;
        self.next = Instant::now() + Duration::from_secs(self.robots.delay);
        result
    }
}

// Only the public catalog's pagination and title/platform filters accept a query.
// Product links and all other endpoints remain query-free.
fn allowed_query(url: &Url) -> bool {
    url.query().is_none()
        || (url.host_str() == Some("www.eneba.com")
            && url.path() == "/de/store/all"
            && url.query().is_some_and(|q| q.len() <= 1500)
            && url.query_pairs().all(|(key, value)| match key.as_ref() {
                "text" => {
                    !value.is_empty()
                        && value.chars().count() <= 300
                        && !value.chars().any(char::is_control)
                }
                "types[]" => value == "game",
                "drms[]" => value == "xbox",
                "page" => value.parse::<u16>().is_ok_and(|n| (1..=500).contains(&n)),
                _ => false,
            }))
}

async fn fetch(
    client: &Client,
    url: &Url,
    limit: usize,
    prefix: bool,
) -> Result<String, ShopError> {
    let mut res = client
        .get(url.clone())
        .send()
        .await
        .map_err(|_| ShopError::Network)?;
    if res.status() == StatusCode::TOO_MANY_REQUESTS
        || res.status() == StatusCode::SERVICE_UNAVAILABLE
    {
        let wait = res
            .headers()
            .get(reqwest::header::RETRY_AFTER)
            .and_then(|h| h.to_str().ok())
            .and_then(|v| {
                v.parse::<i64>().ok().or_else(|| {
                    httpdate::parse_http_date(v).ok().map(|date| {
                        date.duration_since(SystemTime::now())
                            .unwrap_or_default()
                            .as_secs() as i64
                    })
                })
            })
            .unwrap_or(900)
            .clamp(60, 7 * 86400);
        return Err(ShopError::Throttled(wait));
    }
    if res.status().is_redirection() || matches!(res.status().as_u16(), 401 | 403) {
        return Err(ShopError::Denied);
    }
    if res.status() == StatusCode::NOT_FOUND {
        return Err(ShopError::NotFound);
    }
    if !res.status().is_success() {
        return Err(ShopError::Network);
    }
    let mut body = Vec::new();
    while let Some(chunk) = res.chunk().await.map_err(|_| ShopError::Network)? {
        let free = limit - body.len();
        if chunk.len() > free && !prefix {
            return Err(ShopError::Parse);
        }
        body.extend_from_slice(&chunk[..free.min(chunk.len())]);
        if prefix && body.len() == limit {
            break;
        }
    }
    if prefix
        && let Err(error) = std::str::from_utf8(&body)
        && error.error_len().is_none()
    {
        body.truncate(error.valid_up_to());
    }
    String::from_utf8(body).map_err(|_| ShopError::Parse)
}

fn public_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => public_v4(ip),
        IpAddr::V6(ip) => ip.to_ipv4_mapped().map_or_else(
            || {
                let [a, b, ..] = ip.segments();
                (0x2000..0x4000).contains(&a)
                    && a != 0x2002
                    && !(a == 0x2001 && (b < 0x0200 || b == 0xdb8))
                    && !(a == 0x3fff && b & 0xf000 == 0)
            },
            public_v4,
        ),
    }
}

fn public_v4(ip: Ipv4Addr) -> bool {
    let [a, b, c, _] = ip.octets();
    !matches!(
        (a, b, c),
        (0 | 10 | 127 | 224..=255, _, _)
            | (100, 64..=127, _)
            | (169, 254, _)
            | (172, 16..=31, _)
            | (192, 168, _)
            | (192, 0, 0 | 2)
            | (198, 18 | 19, _)
            | (198, 51, 100)
            | (203, 0, 113)
            | (192, 88, 99)
    )
}

#[derive(Default)]
struct Robots {
    rules: Vec<(bool, String)>,
    delay: u64,
}

impl Robots {
    fn parse(body: &str) -> Result<Self, ShopError> {
        type Group = (Vec<String>, Vec<(String, String)>);
        let mut groups: Vec<Group> = Vec::new();
        for line in body.lines() {
            let line = line.split('#').next().unwrap_or("").trim();
            let Some((key, value)) = line.split_once(':') else {
                continue;
            };
            let key = key.trim().to_ascii_lowercase();
            if key == "user-agent" {
                if groups.last().is_none_or(|g| !g.1.is_empty()) {
                    groups.push((Vec::new(), Vec::new()));
                }
                groups
                    .last_mut()
                    .unwrap()
                    .0
                    .push(value.trim().to_ascii_lowercase());
            } else if matches!(key.as_str(), "allow" | "disallow" | "crawl-delay")
                && let Some(group) = groups.last_mut()
            {
                group.1.push((key, value.trim().to_string()));
            }
        }
        if groups.is_empty() {
            return Err(ShopError::Parse);
        }
        let explicit = groups.iter().any(|g| g.0.iter().any(|a| a == "keyhunter"));
        let agent = if explicit { "keyhunter" } else { "*" };
        let mut robots = Self {
            rules: Vec::new(),
            delay: 2,
        };
        for (_, entries) in groups
            .into_iter()
            .filter(|g| g.0.iter().any(|a| a == agent))
        {
            for (key, value) in entries {
                if key == "crawl-delay" {
                    let delay = value.parse::<f64>().map_err(|_| ShopError::Denied)?;
                    if !delay.is_finite() || !(0.0..=20.0).contains(&delay) {
                        return Err(ShopError::Denied);
                    }
                    robots.delay = robots.delay.max(delay.ceil() as u64);
                } else if !value.is_empty() && value.len() <= 512 {
                    robots.rules.push((key == "allow", value));
                }
            }
        }
        Ok(robots)
    }

    fn allows(&self, path: &str) -> bool {
        self.rules
            .iter()
            .filter(|(_, rule)| path_matches(path, rule))
            .max_by_key(|(allow, rule)| (rule.len(), *allow))
            .is_none_or(|(allow, _)| *allow)
    }
}

fn path_matches(path: &str, rule: &str) -> bool {
    let end = rule.ends_with('$');
    let rule = rule.strip_suffix('$').unwrap_or(rule);
    let mut positions = vec![false; path.len() + 1];
    positions[0] = true;
    for c in rule.bytes() {
        if c == b'*' {
            for i in 1..positions.len() {
                positions[i] |= positions[i - 1];
            }
        } else {
            for (i, b) in path.bytes().enumerate().rev() {
                positions[i + 1] = positions[i] && b == c;
            }
            positions[0] = false;
        }
    }
    if end {
        positions[path.len()]
    } else {
        positions.contains(&true)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn public_catalog_query_is_narrow_and_product_urls_remain_query_free() {
        for raw in [
            "https://www.eneba.com/de/store/all?text=Forza+Horizon+5&types%5B%5D=game&drms%5B%5D=xbox&page=2",
            "https://www.eneba.com/de/xbox-game-xbox-live-key-global",
        ] {
            assert!(allowed_query(&Url::parse(raw).unwrap()));
        }
        for raw in [
            "https://www.eneba.com/de/store/all?text=game&regions%5B%5D=global",
            "https://www.eneba.com/de/store/all?text=game&redirect=https://example.com",
            "https://www.eneba.com/de/store/all?text=game&page=0",
            "https://www.eneba.com/de/store/all?text=game&page=501",
            "https://www.eneba.com/de/store/all?text=game&srsltid=tracking",
            "https://www.eneba.com/de/xbox-game-xbox-live-key-global?text=game",
            "https://driffle.com/de/store/all?text=game",
        ] {
            assert!(!allowed_query(&Url::parse(raw).unwrap()), "{raw}");
        }
        let robots = Robots::parse("User-agent: *\nDisallow: /*?*srsltid").unwrap();
        assert!(!robots.allows("/de/store/all?text=game&srsltid=tracking"));
    }
    #[test]
    fn robots_paths_and_public_resolution() {
        let rules = Robots::parse("User-agent: *\nDisallow: /*/search\nDisallow: /de/private*\nAllow: /de/private-game$\nCrawl-delay: 3").unwrap();
        assert!(rules.allows("/de/private-game"));
        assert!(!rules.allows("/de/private-game-extra"));
        assert!(!rules.allows("/de/search"));
        assert_eq!(rules.delay, 3);
        for addr in [
            "127.0.0.1",
            "169.254.169.254",
            "10.0.0.1",
            "100.64.0.1",
            "::1",
            "fc00::1",
            "::ffff:10.0.0.1",
            "2001:db8::1",
        ] {
            assert!(!public_ip(addr.parse().unwrap()), "{addr}");
        }
        assert!(public_ip("1.1.1.1".parse().unwrap()));
    }
}
