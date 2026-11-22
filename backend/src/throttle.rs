//! Sign-in throttle (SEC-01): attempts per source address plus a much higher limit over all sources, in memory.
//!
//! An attempt is counted before the passphrase is checked, so parallel guesses cannot overtake the limit, and
//! a correct passphrase takes it back and lets its source start over. A source that guessed wrong five times
//! waits; others still sign in until the total limit stops distributed guessing as well. Behind a reverse
//! proxy every request comes from the proxy, one source, unless `KEYHUNTER_TRUSTED_PROXY` names it
//! ([`client`]).

use crate::config::Network;
use axum::{
    extract::{ConnectInfo, FromRequestParts},
    http::{HeaderMap, request::Parts},
};
use std::{
    collections::HashMap,
    convert::Infallible,
    net::{IpAddr, SocketAddr},
    sync::Mutex,
};

/// Length of a throttle window in seconds (also the `Retry-After` of a 429).
pub(crate) const WINDOW: i64 = 900;
/// Attempts per source and window.
const PER_SOURCE: u32 = 5;
/// Attempts over all sources and window.
const TOTAL: u32 = 100;
/// Expired sources are dropped at most this often.
const SWEEP_EVERY: i64 = 60;

/// TCP peer of a request (`into_make_service_with_connect_info`); `None` without connection info (tests).
pub(crate) struct Peer(pub Option<IpAddr>);

impl<S: Send + Sync> FromRequestParts<S> for Peer {
    type Rejection = Infallible;
    async fn from_request_parts(parts: &mut Parts, _: &S) -> Result<Self, Infallible> {
        Ok(Self(
            parts
                .extensions
                .get::<ConnectInfo<SocketAddr>>()
                .map(|info| info.0.ip().to_canonical()),
        ))
    }
}

/// The address the throttle counts for a request: the peer, or, when the peer is a trusted proxy, the nearest
/// address in `X-Forwarded-For` that is not a trusted proxy itself. Entries further left are written by the
/// client and could be anything, so the search runs from the right.
pub(crate) fn client(
    trusted: &[Network],
    peer: Option<IpAddr>,
    headers: &HeaderMap,
) -> Option<IpAddr> {
    let is_trusted = |ip: IpAddr| trusted.iter().any(|net| net.contains(ip));
    let Some(proxy) = peer.filter(|ip| is_trusted(*ip)) else {
        return peer;
    };
    let entries: Vec<&str> = headers
        .get_all("x-forwarded-for")
        .iter()
        .filter_map(|value| value.to_str().ok())
        .flat_map(|value| value.split(','))
        .map(str::trim)
        .collect();
    let mut nearest = proxy;
    for entry in entries.iter().rev() {
        let Ok(ip) = entry.parse::<IpAddr>().map(|ip| ip.to_canonical()) else {
            return Some(proxy);
        };
        if !is_trusted(ip) {
            return Some(ip);
        }
        nearest = ip;
    }
    Some(nearest)
}

/// Which limit refused an attempt.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Limit {
    Source,
    Total,
}

#[derive(Default, Clone, Copy)]
struct Window {
    started: i64,
    count: u32,
}

impl Window {
    fn current(&mut self, t: i64) -> &mut u32 {
        if self.started <= t - WINDOW {
            *self = Self {
                started: t,
                count: 0,
            };
        }
        &mut self.count
    }
}

#[derive(Default)]
struct State {
    sources: HashMap<Option<IpAddr>, Window>,
    total: Window,
    swept_at: i64,
}

#[derive(Default)]
pub(crate) struct LoginThrottle(Mutex<State>);

impl LoginThrottle {
    /// Counts an attempt of `source` at `t`, or refuses it while a limit is reached.
    pub(crate) fn reserve(&self, source: Option<IpAddr>, t: i64) -> Result<(), Limit> {
        let mut state = self
            .0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if t - state.swept_at >= SWEEP_EVERY {
            state
                .sources
                .retain(|_, window| window.started > t - WINDOW);
            state.swept_at = t;
        }
        if *state.total.current(t) >= TOTAL {
            return Err(Limit::Total);
        }
        let attempts = state.sources.entry(source).or_default().current(t);
        if *attempts >= PER_SOURCE {
            return Err(Limit::Source);
        }
        *attempts += 1;
        *state.total.current(t) += 1;
        Ok(())
    }

    /// A correct passphrase or setup code: the source starts over and its attempt leaves the total.
    pub(crate) fn succeeded(&self, source: Option<IpAddr>, t: i64) {
        let mut state = self
            .0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        state.sources.remove(&source);
        let total = state.total.current(t);
        *total = total.saturating_sub(1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ip(value: &str) -> Option<IpAddr> {
        Some(value.parse().unwrap())
    }

    #[test]
    fn five_attempts_per_source_and_a_hundred_in_total_per_window() {
        let throttle = LoginThrottle::default();
        let t = 1_800_000_000;
        for _ in 0..5 {
            throttle.reserve(ip("192.168.1.66"), t).unwrap();
        }
        assert_eq!(throttle.reserve(ip("192.168.1.66"), t), Err(Limit::Source));
        // Another source still gets in, and a success lets it start over.
        throttle.reserve(ip("192.168.1.10"), t).unwrap();
        throttle.succeeded(ip("192.168.1.10"), t);
        // The window ends: the source may try again.
        throttle.reserve(ip("192.168.1.66"), t + WINDOW).unwrap();
        // Distributed guessing stops at the total limit, for every source.
        let throttle = LoginThrottle::default();
        for n in 0..TOTAL {
            throttle
                .reserve(ip(&format!("10.0.{}.{}", n / 4, n % 4)), t)
                .unwrap();
        }
        assert_eq!(throttle.reserve(ip("192.168.1.10"), t), Err(Limit::Total));
        assert!(throttle.reserve(ip("192.168.1.10"), t + WINDOW).is_ok());
    }

    #[test]
    fn expired_sources_are_dropped() {
        let throttle = LoginThrottle::default();
        let t = 1_800_000_000;
        for n in 0..50 {
            throttle.reserve(ip(&format!("10.0.0.{n}")), t).unwrap();
        }
        throttle.reserve(None, t + WINDOW + SWEEP_EVERY).unwrap();
        assert_eq!(throttle.0.lock().unwrap().sources.len(), 1);
    }

    #[test]
    fn forwarded_addresses_count_only_behind_a_trusted_proxy() {
        let trusted = [
            Network::parse("172.18.0.0/16").unwrap(),
            Network::parse("::1").unwrap(),
        ];
        let mut headers = HeaderMap::new();
        headers.insert(
            "x-forwarded-for",
            "203.0.113.9, 198.51.100.7".parse().unwrap(),
        );
        headers.append("x-forwarded-for", "172.18.0.5".parse().unwrap());
        // Not from the proxy: the header is ignored.
        assert_eq!(
            client(&trusted, ip("192.168.1.66"), &headers),
            ip("192.168.1.66")
        );
        // From the proxy: the nearest untrusted entry, never one the client could have made up further left.
        assert_eq!(
            client(&trusted, ip("172.18.0.2"), &headers),
            ip("198.51.100.7")
        );
        assert_eq!(
            client(&trusted, ip("::ffff:172.18.0.2"), &headers),
            ip("198.51.100.7")
        );
        assert_eq!(
            client(&trusted, ip("172.18.0.2"), &HeaderMap::new()),
            ip("172.18.0.2")
        );
        headers.insert("x-forwarded-for", "nonsense, 172.18.0.9".parse().unwrap());
        assert_eq!(client(&trusted, ip("::1"), &headers), ip("::1"));
        headers.insert("x-forwarded-for", "172.18.0.9".parse().unwrap());
        assert_eq!(client(&trusted, ip("::1"), &headers), ip("172.18.0.9"));
        assert_eq!(client(&[], ip("172.18.0.2"), &headers), ip("172.18.0.2"));
    }
}
