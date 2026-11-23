//! `keyhunter --health` (SEC-05/SEC-10): the container healthcheck without curl in the image. It asks the local
//! server for `/health/ready` and succeeds only on HTTP 200.
use std::{
    io::{Read, Write},
    net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr, TcpStream},
    time::Duration,
};

/// Whether the server listening on `bind` answers `/health/ready` with 200 (an unspecified address means loopback).
pub fn ready(bind: SocketAddr) -> bool {
    let host = match bind.ip() {
        IpAddr::V4(ip) if ip.is_unspecified() => IpAddr::V4(Ipv4Addr::LOCALHOST),
        IpAddr::V6(ip) if ip.is_unspecified() => IpAddr::V6(Ipv6Addr::LOCALHOST),
        ip => ip,
    };
    let address = SocketAddr::new(host, bind.port());
    let timeout = Duration::from_secs(2);
    let Ok(mut stream) = TcpStream::connect_timeout(&address, timeout) else {
        return false;
    };
    let _ = stream.set_read_timeout(Some(timeout));
    let _ = stream.set_write_timeout(Some(timeout));
    let request =
        format!("GET /health/ready HTTP/1.1\r\nHost: {address}\r\nConnection: close\r\n\r\n");
    let mut status = [0u8; 12];
    stream.write_all(request.as_bytes()).is_ok()
        && stream.read_exact(&mut status).is_ok()
        && status.starts_with(b"HTTP/1.1 200")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;

    /// A server that answers one request with `status` and reports the request line it saw.
    fn serve(status: &'static str) -> (SocketAddr, std::thread::JoinHandle<String>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let handle = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut buffer = [0u8; 512];
            let read = stream.read(&mut buffer).unwrap();
            stream
                .write_all(format!("HTTP/1.1 {status}\r\nContent-Length: 0\r\n\r\n").as_bytes())
                .unwrap();
            String::from_utf8_lossy(&buffer[..read])
                .lines()
                .next()
                .unwrap_or_default()
                .to_string()
        });
        (address, handle)
    }

    #[test]
    fn only_a_200_answer_is_healthy() {
        let (address, request) = serve("200 OK");
        assert!(ready(address));
        assert_eq!(request.join().unwrap(), "GET /health/ready HTTP/1.1");
        let (address, _) = serve("503 Service Unavailable");
        assert!(!ready(address));
    }

    #[test]
    fn nothing_listening_is_unhealthy_and_an_unspecified_address_means_loopback() {
        let port = TcpListener::bind("127.0.0.1:0")
            .unwrap()
            .local_addr()
            .unwrap()
            .port();
        assert!(!ready(SocketAddr::from(([127, 0, 0, 1], port))));
        let (address, _) = serve("200 OK");
        assert!(ready(SocketAddr::from(([0, 0, 0, 0], address.port()))));
    }
}
