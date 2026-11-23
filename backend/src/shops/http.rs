use super::{Shop, ShopError};
use reqwest::{Client, StatusCode, redirect::Policy};
use std::{
    collections::HashMap,
    net::{IpAddr, Ipv4Addr},
    sync::{Arc, LazyLock, Mutex},
    time::{Duration, SystemTime},
};
use tokio::{
    sync::{Mutex as AsyncMutex, OwnedMutexGuard},
    time::{Instant, sleep_until, timeout},
};
use url::Url;

const USER_AGENT: &str = "Keyhunter";
/// A client, its pinned DNS answer and robots.txt are reused this long.
const CLIENT_TTL: Duration = Duration::from_secs(24 * 3600);
/// A shop that throttles (429, 503) without `Retry-After` is paused this long.
const THROTTLE_WITHOUT_RETRY_AFTER: i64 = 900;

struct Session {
    client: Client,
    robots: Robots,
    next: Instant,
    created: Instant,
}

type Slot = Arc<AsyncMutex<Option<Session>>>;
static SESSIONS: LazyLock<Mutex<HashMap<&'static str, Slot>>> = LazyLock::new(Default::default);

/// Exclusive use of the shared session for one host: requests to a shop are serialized,
/// so the crawl delay also holds across jobs and manual link checks.
pub(super) struct PublicClient {
    shop: Shop,
    session: OwnedMutexGuard<Option<Session>>,
}

impl PublicClient {
    pub(super) async fn new(shop: Shop) -> Result<Self, ShopError> {
        let host = shop.host();
        let slot = Arc::clone(
            SESSIONS
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .entry(host)
                .or_default(),
        );
        let mut session = slot.lock_owned().await;
        if session
            .as_ref()
            .is_none_or(|current| current.created.elapsed() >= CLIENT_TTL)
        {
            *session = Some(Session::open(host).await?);
        }
        Ok(Self { shop, session })
    }

    pub(super) async fn get(
        &mut self,
        url: &Url,
        limit: usize,
        prefix: bool,
    ) -> Result<String, ShopError> {
        let session = self.session.as_mut().ok_or(ShopError::Network)?;
        if url.scheme() != "https"
            || url.host_str() != Some(self.shop.host())
            || url.port().is_some()
            || !url.username().is_empty()
            || url.password().is_some()
            || !allowed_query(self.shop, url)
            || !session.robots.allows(&url[url::Position::BeforePath..])
        {
            return Err(ShopError::Denied);
        }
        sleep_until(session.next).await;
        let result = fetch(&session.client, url, limit, prefix).await;
        session.next = Instant::now() + Duration::from_secs(session.robots.delay);
        if matches!(result, Err(ShopError::Network)) {
            // Resolve the host again on the next request; the address may have moved.
            *self.session = None;
        }
        result
    }
}

impl Session {
    async fn open(host: &'static str) -> Result<Self, ShopError> {
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
        let robots = Robots::from_response(fetch(&client, &url, 128 * 1024, false).await)?;
        let next = Instant::now() + Duration::from_secs(robots.delay);
        Ok(Self {
            client,
            robots,
            next,
            created: Instant::now(),
        })
    }
}

/// Product links and every other endpoint stay query-free; only the shop's own search pages carry a query.
fn allowed_query(shop: Shop, url: &Url) -> bool {
    url.query().is_none() || shop.allows_query(url)
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
            .unwrap_or(THROTTLE_WITHOUT_RETRY_AFTER)
            .clamp(60, 7 * crate::DAY);
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
    /// A missing robots.txt allows everything (RFC 9309 §2.3.1.3); other failures stop the shop.
    fn from_response(response: Result<String, ShopError>) -> Result<Self, ShopError> {
        match response {
            Ok(body) => Self::parse(&body),
            Err(ShopError::NotFound) => Ok(Self {
                rules: Vec::new(),
                delay: 2,
            }),
            Err(error) => Err(error),
        }
    }

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
            assert!(allowed_query(Shop::Eneba, &Url::parse(raw).unwrap()));
        }
        for raw in [
            "https://www.eneba.com/de/store/all?text=game&regions%5B%5D=global",
            "https://www.eneba.com/de/store/all?text=game&redirect=https://example.com",
            "https://www.eneba.com/de/store/all?text=game&page=0",
            "https://www.eneba.com/de/store/all?text=game&page=501",
            "https://www.eneba.com/de/store/all?text=game&srsltid=tracking",
            "https://www.eneba.com/de/xbox-game-xbox-live-key-global?text=game",
        ] {
            assert!(
                !allowed_query(Shop::Eneba, &Url::parse(raw).unwrap()),
                "{raw}"
            );
        }
        let driffle = Url::parse("https://driffle.com/de/store/all?text=game").unwrap();
        assert!(!allowed_query(Shop::Driffle, &driffle));
        let robots = Robots::parse("User-agent: *\nDisallow: /*?*srsltid").unwrap();
        assert!(!robots.allows("/de/store/all?text=game&srsltid=tracking"));
    }
    #[test]
    fn missing_robots_txt_allows_everything_but_errors_do_not() {
        let robots = Robots::from_response(Err(ShopError::NotFound)).unwrap();
        assert!(robots.allows("/de/any-product"));
        assert_eq!(robots.delay, 2);
        assert!(Robots::from_response(Err(ShopError::Network)).is_err());
        assert!(Robots::from_response(Err(ShopError::Denied)).is_err());
        let robots = Robots::from_response(Ok("User-agent: *\nDisallow: /".into())).unwrap();
        assert!(!robots.allows("/de/any-product"));
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

    // FUNC-07: the HTTP classes are tested through `fetch` against a loopback server.
    // `fetch` takes the client as a parameter, so no production seam is needed; the
    // address check lives in `Session::open` and is covered separately below.
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    /// Serves `response` once per connection, forever; returns the base URL.
    async fn mock_server(response: Vec<u8>) -> Url {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            loop {
                let Ok((mut socket, _)) = listener.accept().await else {
                    return;
                };
                let response = response.clone();
                tokio::spawn(async move {
                    let mut buf = [0u8; 2048];
                    let _ = socket.read(&mut buf).await;
                    let _ = socket.write_all(&response).await;
                    let _ = socket.shutdown().await;
                });
            }
        });
        Url::parse(&format!("http://127.0.0.1:{port}/page")).unwrap()
    }

    fn response(status: &str, headers: &[(&str, String)], body: &[u8]) -> Vec<u8> {
        let mut out = format!("HTTP/1.1 {status}\r\n").into_bytes();
        for (name, value) in headers {
            out.extend(format!("{name}: {value}\r\n").bytes());
        }
        out.extend(
            format!(
                "Content-Length: {}\r\nConnection: close\r\n\r\n",
                body.len()
            )
            .bytes(),
        );
        out.extend_from_slice(body);
        out
    }

    fn test_client() -> Client {
        Client::builder()
            .no_proxy()
            .redirect(Policy::none())
            .timeout(Duration::from_millis(400))
            .build()
            .unwrap()
    }

    async fn get(status: &str, headers: &[(&str, String)]) -> Result<String, ShopError> {
        let url = mock_server(response(status, headers, b"")).await;
        fetch(&test_client(), &url, 1024, false).await
    }

    fn retry_after(value: String) -> [(&'static str, String); 1] {
        [("Retry-After", value)]
    }

    #[tokio::test]
    async fn throttle_responses_honour_retry_after_within_bounds() {
        let day = crate::DAY;
        for (status, header, expected) in [
            ("429 Too Many Requests", Some("600".to_string()), 600),
            ("503 Service Unavailable", Some("120".to_string()), 120),
            ("429 Too Many Requests", Some("5".to_string()), 60),
            (
                "429 Too Many Requests",
                Some("999999999".to_string()),
                7 * day,
            ),
            ("429 Too Many Requests", None, THROTTLE_WITHOUT_RETRY_AFTER),
            (
                "503 Service Unavailable",
                None,
                THROTTLE_WITHOUT_RETRY_AFTER,
            ),
            (
                "429 Too Many Requests",
                Some("garbage".to_string()),
                THROTTLE_WITHOUT_RETRY_AFTER,
            ),
            // An HTTP date in the past means "now": clamped to the minimum.
            (
                "429 Too Many Requests",
                Some("Mon, 01 Jan 2001 00:00:00 GMT".to_string()),
                60,
            ),
        ] {
            let headers: Vec<_> = header.into_iter().flat_map(retry_after).collect();
            assert!(
                matches!(get(status, &headers).await, Err(ShopError::Throttled(wait)) if wait == expected),
                "{status} {headers:?}"
            );
        }
        let date = httpdate::fmt_http_date(SystemTime::now() + Duration::from_secs(3600));
        match get("429 Too Many Requests", &retry_after(date)).await {
            Err(ShopError::Throttled(wait)) => assert!((3590..=3600).contains(&wait), "{wait}"),
            other => panic!("{other:?}"),
        }
    }

    #[tokio::test]
    async fn status_codes_map_to_denied_not_found_and_network() {
        for status in [
            "401 Unauthorized",
            "403 Forbidden",
            "301 Moved Permanently",
            "302 Found",
        ] {
            let headers = [("Location", "https://example.com/".to_string())];
            assert!(
                matches!(get(status, &headers).await, Err(ShopError::Denied)),
                "{status}"
            );
        }
        assert!(matches!(
            get("404 Not Found", &[]).await,
            Err(ShopError::NotFound)
        ));
        for status in [
            "500 Internal Server Error",
            "502 Bad Gateway",
            "418 I'm a teapot",
        ] {
            assert!(
                matches!(get(status, &[]).await, Err(ShopError::Network)),
                "{status}"
            );
        }
    }

    #[tokio::test]
    async fn body_limit_fails_whole_reads_and_truncates_prefix_reads() {
        let url = mock_server(response("200 OK", &[], "äöü0123456789".as_bytes())).await;
        let client = test_client();
        assert_eq!(
            fetch(&client, &url, 1024, false).await.unwrap(),
            "äöü0123456789"
        );
        assert!(matches!(
            fetch(&client, &url, 12, false).await,
            Err(ShopError::Parse)
        ));
        // Prefix mode keeps what fits and never splits a multi-byte character.
        assert_eq!(fetch(&client, &url, 5, true).await.unwrap(), "äö");
        assert_eq!(fetch(&client, &url, 8, true).await.unwrap(), "äöü01");
    }

    #[tokio::test]
    async fn a_silent_server_times_out_as_network_error() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = Url::parse(&format!("http://{}/page", listener.local_addr().unwrap())).unwrap();
        let held = tokio::spawn(async move {
            let _connection = listener.accept().await;
            sleep_until(Instant::now() + Duration::from_secs(5)).await;
        });
        assert!(matches!(
            fetch(&test_client(), &url, 1024, false).await,
            Err(ShopError::Network)
        ));
        held.abort();
    }

    #[tokio::test]
    async fn robots_txt_goes_through_the_same_classification() {
        let client = test_client();
        let url = |response| mock_server(response);
        let ok = url(response(
            "200 OK",
            &[],
            b"User-agent: *\nDisallow: /private\nCrawl-delay: 4",
        ))
        .await;
        let robots = Robots::from_response(fetch(&client, &ok, 128 * 1024, false).await).unwrap();
        assert!(!robots.allows("/private"));
        assert_eq!(robots.delay, 4);
        // 404 allows everything; throttling, denial and server errors stop the shop.
        let missing = url(response("404 Not Found", &[], b"")).await;
        assert!(Robots::from_response(fetch(&client, &missing, 1024, false).await).is_ok());
        for status in [
            "429 Too Many Requests",
            "403 Forbidden",
            "500 Internal Server Error",
        ] {
            let failing = url(response(status, &[], b"")).await;
            assert!(Robots::from_response(fetch(&client, &failing, 1024, false).await).is_err());
        }
    }

    #[tokio::test]
    async fn the_normal_constructor_refuses_loopback_addresses() {
        // A literal address needs no DNS; the real session must never reach loopback.
        for host in ["127.0.0.1", "localhost"] {
            assert!(
                matches!(Session::open(host).await, Err(ShopError::Denied)),
                "{host}"
            );
        }
    }
}
