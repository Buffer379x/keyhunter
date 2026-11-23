//! Delivery of one message through a channel.

use super::{
    Notifier,
    channel::{Security, Smtp, Target},
    message::Alert,
};
use lettre::{
    AsyncSmtpTransport, AsyncTransport, Message, Tokio1Executor, message::MultiPart,
    transport::smtp::authentication::Credentials,
};
use reqwest::{RequestBuilder, header::HeaderValue};
use serde_json::{Value, json};
use std::time::Duration;

impl Notifier {
    /// Deliver one message. The error is a short German reason without secrets ("HTTP 401 · Unauthorized").
    pub(crate) async fn send(&self, target: &Target, alert: &Alert) -> Result<(), String> {
        let title = alert.title();
        let text = alert.text();
        let result = match target {
            Target::Ntfy { url, token } => {
                let title = HeaderValue::from_bytes(title.as_bytes())
                    .unwrap_or(HeaderValue::from_static("KeyHunter"));
                let mut request = self
                    .client
                    .post(url.clone())
                    .header("Content-Type", "text/plain; charset=utf-8")
                    .header("Title", title)
                    .header("Tags", alert.tag())
                    .body(text);
                if let Some(url) = &alert.url {
                    request = request.header("Click", url.as_str());
                }
                if let Some(token) = token {
                    request = request.bearer_auth(token);
                }
                self.http(request).await
            }
            Target::Telegram { token, chat } => {
                let mut html = format!("<b>{}</b>\n{}", escape_html(&title), escape_html(&text));
                if let Some((url, label)) = alert.link() {
                    html.push_str(&format!(
                        "\n<a href=\"{}\">{}</a>",
                        escape_html(url),
                        escape_html(&label)
                    ));
                }
                let url = format!("{}/bot{token}/sendMessage", self.telegram_api);
                self.http(self.client.post(url).json(&json!({
                    "chat_id": chat, "text": html, "parse_mode": "HTML",
                    "link_preview_options": {"is_disabled": true},
                })))
                .await
            }
            Target::Discord { url } => {
                let mut embed = json!({"title": title, "description": escape_markdown(&text), "color": 0xF07C1E});
                if let Some(url) = &alert.url {
                    embed["url"] = json!(url);
                }
                self.http(self.client.post(url.clone()).json(&json!({
                    "username": "KeyHunter", "embeds": [embed], "allowed_mentions": {"parse": []},
                })))
                .await
            }
            Target::Email(smtp) => send_mail(smtp, alert).await,
            Target::Gotify { url, token } => {
                let mut message = escape_markdown(&text);
                let mut extras = json!({"client::display": {"contentType": "text/markdown"}});
                if let Some((url, label)) = alert.link() {
                    message.push_str(&format!("\n\n[{label}]({url})"));
                    extras["client::notification"] = json!({"click": {"url": url}});
                }
                self.http(
                    self.client
                        .post(url.clone())
                        .header("X-Gotify-Key", token.as_str())
                        .json(&json!({"title": title, "message": message, "priority": 5, "extras": extras})),
                )
                .await
            }
            Target::Pushover { user, token } => {
                let mut form = vec![
                    ("token", token.clone()),
                    ("user", user.clone()),
                    ("title", title),
                    ("message", text),
                ];
                if let Some((url, label)) = alert.link() {
                    form.push(("url", url.to_owned()));
                    form.push(("url_title", label));
                }
                let url = format!("{}/1/messages.json", self.pushover_api);
                self.http(self.client.post(url).form(&form)).await
            }
            Target::Webhook { url, token } => {
                let mut request = self.client.post(url.clone()).json(&alert.json());
                if let Some(token) = token {
                    request = request.bearer_auth(token);
                }
                self.http(request).await
            }
        };
        result.map_err(|reason| redact(&reason, &target.secrets()))
    }

    async fn http(&self, request: RequestBuilder) -> Result<(), String> {
        let response = request.send().await.map_err(|error| {
            if error.is_timeout() {
                "Zeitüberschreitung".to_owned()
            } else if error.is_connect() {
                "Server nicht erreichbar".to_owned()
            } else {
                "Netzwerkfehler".to_owned()
            }
        })?;
        let status = response.status();
        if status.is_success() {
            return Ok(());
        }
        let body = response.bytes().await.unwrap_or_default();
        // Telegram: description, Discord: message, Gotify: errorDescription, ntfy: error, Pushover: errors[0].
        let detail = serde_json::from_slice::<Value>(&body).ok().and_then(|v| {
            ["description", "message", "errorDescription", "error"]
                .iter()
                .find_map(|k| v.get(k)?.as_str().map(str::to_owned))
                .or_else(|| v.get("errors")?.get(0)?.as_str().map(str::to_owned))
        });
        Err(
            match detail.or_else(|| status.canonical_reason().map(str::to_owned)) {
                Some(reason) => format!("HTTP {} · {reason}", status.as_u16()),
                None => format!("HTTP {}", status.as_u16()),
            },
        )
    }
}

async fn send_mail(smtp: &Smtp, alert: &Alert) -> Result<(), String> {
    let mut builder = Message::builder()
        .from(smtp.from.clone())
        .subject(alert.title());
    for to in &smtp.to {
        builder = builder.to(to.clone());
    }
    let mut plain = alert.text();
    let mut html = format!("<p>{}</p>", escape_html(&plain));
    if let Some((url, label)) = alert.link() {
        plain.push_str(&format!("\n\n{label}: {url}"));
        html.push_str(&format!(
            "<p><a href=\"{}\">{}</a></p>",
            escape_html(url),
            escape_html(&label)
        ));
    }
    plain.push_str("\n\n-- \nKeyHunter");
    html.push_str("<p style=\"color:#777\">KeyHunter</p>");
    let message = builder
        .multipart(MultiPart::alternative_plain_html(plain, html))
        .map_err(|_| "E-Mail konnte nicht erstellt werden".to_owned())?;
    let failure = |error: lettre::transport::smtp::Error| {
        if error.is_timeout() {
            "Zeitüberschreitung".to_owned()
        } else {
            format!("SMTP: {error}")
        }
    };
    let transport = match smtp.security {
        Security::Tls => {
            AsyncSmtpTransport::<Tokio1Executor>::relay(&smtp.host).map_err(failure)?
        }
        Security::StartTls => {
            AsyncSmtpTransport::<Tokio1Executor>::starttls_relay(&smtp.host).map_err(failure)?
        }
        Security::None => AsyncSmtpTransport::<Tokio1Executor>::builder_dangerous(&smtp.host),
    };
    let mut transport = transport
        .port(smtp.port)
        .timeout(Some(Duration::from_secs(15)));
    if let Some((user, password)) = &smtp.login {
        transport = transport.credentials(Credentials::new(user.clone(), password.clone()));
    }
    transport
        .build()
        .send(message)
        .await
        .map(|_| ())
        .map_err(failure)
}

/// Remove secrets and control characters from an error text and keep it short.
fn redact(reason: &str, secrets: &[String]) -> String {
    let mut text: String = reason
        .chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .collect();
    for secret in secrets.iter().filter(|s| s.len() >= 4) {
        text = text.replace(secret.as_str(), "…");
    }
    text.chars().take(200).collect()
}

fn escape_html(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

fn escape_markdown(text: &str) -> String {
    text.chars()
        .flat_map(|c| {
            ("\\`*_[]()~|<>#".contains(c).then_some('\\'))
                .into_iter()
                .chain([c])
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::notify::{
        Kind, Values,
        channel::{ntfy, target},
        testing::*,
    };
    use std::collections::BTreeMap;
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
    use url::Url;
    #[tokio::test]
    async fn ntfy_posts_the_text_with_title_click_tags_and_token() {
        let server = mock(&[]).await;
        let dir = tempfile::tempdir().unwrap();
        let notifier = notifier(dir.path(), &server.url);
        let target = ntfy(&format!("{}/kh-alerts", server.url), Some("tk_fixture")).unwrap();
        notifier.send(&target, &forza()).await.unwrap();
        let [request] = server.take().try_into().ok().unwrap();
        assert_eq!(request.method, "POST");
        assert_eq!(request.path, "/kh-alerts");
        assert_eq!(request.header("authorization"), "Bearer tk_fixture");
        assert_eq!(
            request.header("title"),
            "KeyHunter: Wunschpreis erreicht · 24,90 €"
        );
        assert_eq!(
            request.header("click"),
            "https://www.eneba.com/de/xbox-forza-horizon-5-key-global"
        );
        assert_eq!(request.header("tags"), "moneybag");
        assert_eq!(request.header("content-type"), "text/plain; charset=utf-8");
        assert_eq!(request.text(), forza().text());
    }

    #[tokio::test]
    async fn telegram_sends_escaped_html_with_a_link() {
        let server = mock(&[]).await;
        let dir = tempfile::tempdir().unwrap();
        let notifier = notifier(dir.path(), &server.url);
        let target = target(
            Kind::Telegram,
            &values(&[("chat_id", "-100200")]),
            &values(&[("bot_token", BOT)]),
        )
        .unwrap();
        let alert = Alert {
            game: "Tom & Jerry <Deluxe>".into(),
            ..forza()
        };
        notifier.send(&target, &alert).await.unwrap();
        let [request] = server.take().try_into().ok().unwrap();
        assert_eq!(request.method, "POST");
        assert_eq!(request.path, format!("/bot{BOT}/sendMessage"));
        let body = request.json();
        assert_eq!(body["chat_id"], "-100200");
        assert_eq!(body["parse_mode"], "HTML");
        assert_eq!(body["link_preview_options"]["is_disabled"], true);
        assert_eq!(
            body["text"],
            "<b>KeyHunter: Wunschpreis erreicht · 24,90 €</b>\n„Tom &amp; Jerry &lt;Deluxe&gt;“ ist bei deinem Wunschpreis angekommen: \
            24,90 € bei Eneba (Global, gültig in Deutschland). Ziel: 25,00 €.\n\
            <a href=\"https://www.eneba.com/de/xbox-forza-horizon-5-key-global\">Zum Angebot bei Eneba</a>"
        );
    }

    #[tokio::test]
    async fn discord_sends_an_embed_with_a_clickable_title_and_no_mentions() {
        let server = mock(&[]).await;
        let dir = tempfile::tempdir().unwrap();
        let notifier = notifier(dir.path(), &server.url);
        let target = Target::Discord {
            url: Url::parse(&format!("{}/api/webhooks/1/fixture-token", server.url)).unwrap(),
        };
        let alert = Alert {
            game: "Halo *Infinite*".into(),
            ..forza()
        };
        notifier.send(&target, &alert).await.unwrap();
        let [request] = server.take().try_into().ok().unwrap();
        assert_eq!(request.method, "POST");
        assert_eq!(request.path, "/api/webhooks/1/fixture-token");
        assert_eq!(request.header("content-type"), "application/json");
        let body = request.json();
        assert_eq!(body["username"], "KeyHunter");
        assert_eq!(body["allowed_mentions"]["parse"], json!([]));
        let embed = &body["embeds"][0];
        assert_eq!(embed["title"], "KeyHunter: Wunschpreis erreicht · 24,90 €");
        assert_eq!(
            embed["url"],
            "https://www.eneba.com/de/xbox-forza-horizon-5-key-global"
        );
        assert!(
            embed["description"]
                .as_str()
                .unwrap()
                .starts_with("„Halo \\*Infinite\\*“ ist bei")
        );
    }

    #[tokio::test]
    async fn gotify_sends_markdown_with_a_click_url() {
        let server = mock(&[]).await;
        let dir = tempfile::tempdir().unwrap();
        let notifier = notifier(dir.path(), &server.url);
        let target = target(
            Kind::Gotify,
            &values(&[("url", &server.url)]),
            &values(&[("token", "AppTokenFixture")]),
        )
        .unwrap();
        notifier.send(&target, &forza()).await.unwrap();
        let [request] = server.take().try_into().ok().unwrap();
        assert_eq!(request.method, "POST");
        assert_eq!(request.path, "/message");
        assert_eq!(request.header("x-gotify-key"), "AppTokenFixture");
        let body = request.json();
        assert_eq!(body["title"], "KeyHunter: Wunschpreis erreicht · 24,90 €");
        assert_eq!(body["priority"], 5);
        assert_eq!(
            body["extras"]["client::display"]["contentType"],
            "text/markdown"
        );
        assert_eq!(
            body["extras"]["client::notification"]["click"]["url"],
            "https://www.eneba.com/de/xbox-forza-horizon-5-key-global"
        );
        assert!(body["message"].as_str().unwrap().ends_with(
            "Ziel: 25,00 €.\n\n[Zum Angebot bei Eneba](https://www.eneba.com/de/xbox-forza-horizon-5-key-global)"
        ));
    }

    #[tokio::test]
    async fn pushover_posts_a_form_with_url_and_url_title() {
        let server = mock(&[]).await;
        let dir = tempfile::tempdir().unwrap();
        let notifier = notifier(dir.path(), &server.url);
        let target = target(
            Kind::Pushover,
            &Values::new(),
            &values(&[("user", PUSH_USER), ("token", PUSH_TOKEN)]),
        )
        .unwrap();
        notifier.send(&target, &forza()).await.unwrap();
        let [request] = server.take().try_into().ok().unwrap();
        assert_eq!(request.method, "POST");
        assert_eq!(request.path, "/1/messages.json");
        assert_eq!(
            request.header("content-type"),
            "application/x-www-form-urlencoded"
        );
        let form: BTreeMap<String, String> = url::form_urlencoded::parse(&request.body)
            .into_owned()
            .collect();
        assert_eq!(form["token"], PUSH_TOKEN);
        assert_eq!(form["user"], PUSH_USER);
        assert_eq!(form["title"], "KeyHunter: Wunschpreis erreicht · 24,90 €");
        assert_eq!(form["message"], forza().text());
        assert_eq!(
            form["url"],
            "https://www.eneba.com/de/xbox-forza-horizon-5-key-global"
        );
        assert_eq!(form["url_title"], "Zum Angebot bei Eneba");
    }

    #[tokio::test]
    async fn webhook_posts_structured_json_with_an_optional_bearer_token() {
        let server = mock(&[]).await;
        let dir = tempfile::tempdir().unwrap();
        let notifier = notifier(dir.path(), &server.url);
        let target = target(
            Kind::Webhook,
            &Values::new(),
            &values(&[
                ("url", &format!("{}/hook?id=7", server.url)),
                ("token", "hook-token"),
            ]),
        )
        .unwrap();
        notifier.send(&target, &forza()).await.unwrap();
        notifier.send(&target, &Alert::test()).await.unwrap();
        let [alert, test] = server.take().try_into().ok().unwrap();
        assert_eq!(alert.method, "POST");
        assert_eq!(alert.path, "/hook?id=7");
        assert_eq!(alert.header("authorization"), "Bearer hook-token");
        assert_eq!(
            alert.json(),
            json!({
                "event": "target_reached", "title": "KeyHunter: Wunschpreis erreicht · 24,90 €", "message": forza().text(),
                "game": "Forza Horizon 5", "price_cents": 2490, "price": "24,90 €", "target_cents": 2500,
                "previous_low_cents": null, "estimate": false, "shop": "Eneba", "region": "Global", "country": "DE",
                "url": "https://www.eneba.com/de/xbox-forza-horizon-5-key-global",
            })
        );
        let test = test.json();
        assert_eq!(test["event"], "test");
        assert_eq!(test["game"], Value::Null);
        assert_eq!(test["price_cents"], Value::Null);
    }

    #[tokio::test]
    async fn failures_report_status_and_reason_but_never_the_secret() {
        let server = mock(&[401]).await;
        let dir = tempfile::tempdir().unwrap();
        let notifier = notifier(dir.path(), &server.url);
        let telegram = target(
            Kind::Telegram,
            &values(&[("chat_id", "1")]),
            &values(&[("bot_token", BOT)]),
        )
        .unwrap();
        assert_eq!(
            notifier.send(&telegram, &Alert::test()).await.unwrap_err(),
            "HTTP 401 · mock answer"
        );
        let closed = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = closed.local_addr().unwrap();
        drop(closed);
        let hook = Target::Webhook {
            url: Url::parse(&format!("http://{address}/hook-secret-path")).unwrap(),
            token: None,
        };
        let error = notifier.send(&hook, &Alert::test()).await.unwrap_err();
        assert_eq!(error, "Server nicht erreichbar");
        assert_eq!(
            redact(
                "failed for http://h/hook-secret-path\nagain",
                &hook.secrets()
            ),
            "failed for http://h… again"
        );
    }

    /// SMTP server that answers every command with success and returns what it received.
    async fn smtp_stub() -> (u16, tokio::task::JoinHandle<String>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let task = tokio::spawn(async move {
            let (socket, _) = listener.accept().await.unwrap();
            let (read, mut write) = socket.into_split();
            let mut lines = BufReader::new(read).lines();
            let mut transcript = String::new();
            write.write_all(b"220 stub ESMTP\r\n").await.unwrap();
            let mut data = false;
            while let Ok(Some(line)) = lines.next_line().await {
                transcript.push_str(&line);
                transcript.push('\n');
                let reply: &[u8] = if data {
                    if line != "." {
                        continue;
                    }
                    data = false;
                    b"250 queued\r\n"
                } else {
                    match line.to_ascii_uppercase().split(' ').next().unwrap() {
                        "EHLO" | "HELO" => b"250 stub\r\n",
                        "DATA" => {
                            data = true;
                            b"354 go ahead\r\n"
                        }
                        "QUIT" => b"221 bye\r\n",
                        _ => b"250 ok\r\n",
                    }
                };
                write.write_all(reply).await.unwrap();
            }
            transcript
        });
        (port, task)
    }

    /// Undo quoted-printable (soft breaks and =XX) for the assertions.
    fn unquote(text: &str) -> String {
        let joined = text.replace("=\n", "");
        let bytes = joined.as_bytes();
        let mut out = vec![];
        let mut i = 0;
        while i < bytes.len() {
            match (bytes[i], bytes.get(i + 1..i + 3)) {
                (b'=', Some(hex)) if hex.iter().all(u8::is_ascii_hexdigit) => {
                    out.push(u8::from_str_radix(std::str::from_utf8(hex).unwrap(), 16).unwrap());
                    i += 3;
                }
                (byte, _) => {
                    out.push(byte);
                    i += 1;
                }
            }
        }
        String::from_utf8(out).unwrap()
    }

    #[tokio::test]
    async fn email_sends_plain_text_and_html_through_smtp() {
        let (port, transcript) = smtp_stub().await;
        let settings = values(&[
            ("host", "127.0.0.1"),
            ("port", &port.to_string()),
            ("security", "none"),
            ("from", "KeyHunter <keyhunter@example.org>"),
            ("to", "owner@example.org"),
        ]);
        let target = target(Kind::Email, &settings, &Values::new()).unwrap();
        let dir = tempfile::tempdir().unwrap();
        notifier(dir.path(), "http://127.0.0.1:9")
            .send(&target, &forza())
            .await
            .unwrap();
        let transcript = unquote(&transcript.await.unwrap());
        assert!(
            transcript.contains("MAIL FROM:<keyhunter@example.org>"),
            "{transcript}"
        );
        assert!(transcript.contains("RCPT TO:<owner@example.org>"));
        assert!(transcript.contains("Subject: "));
        assert!(transcript.contains("multipart/alternative"));
        assert!(transcript.contains("Content-Type: text/plain; charset=utf-8"));
        assert!(transcript.contains("Content-Type: text/html; charset=utf-8"));
        assert!(transcript.contains(&forza().text()));
        assert!(transcript.contains(
            "Zum Angebot bei Eneba: https://www.eneba.com/de/xbox-forza-horizon-5-key-global"
        ));
        assert!(transcript.contains("<a href=\"https://www.eneba.com/de/xbox-forza-horizon-5-key-global\">Zum Angebot bei Eneba</a>"));
        // TLS variants build their transport without connecting.
        for security in ["starttls", "tls"] {
            let mut tls = settings.clone();
            tls.insert("security".into(), security.into());
            tls.insert("host".into(), "smtp.example.org".into());
            assert!(
                matches!(target_of(&tls), Ok(Target::Email(smtp)) if smtp.security != Security::None)
            );
        }
    }

    fn target_of(settings: &Values) -> Result<Target, &'static str> {
        target(Kind::Email, settings, &Values::new())
    }
}
