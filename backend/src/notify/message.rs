//! The wording of a message: title, text, link and the body of the webhook.

use serde_json::{Value, json};

/// "1.234,50 €".
pub(crate) fn euro(cents: i64) -> String {
    let sign = if cents < 0 { "-" } else { "" };
    let cents = cents.abs();
    let whole = (cents / 100).to_string();
    let mut grouped = String::new();
    for (i, digit) in whole.chars().enumerate() {
        if i > 0 && (whole.len() - i).is_multiple_of(3) {
            grouped.push('.');
        }
        grouped.push(digit);
    }
    format!("{sign}{grouped},{:02} €", cents % 100)
}

/// German name of a target country; other codes stay as they are.
fn country_name(code: &str) -> &str {
    const NAMES: [(&str, &str); 32] = [
        ("AT", "Österreich"),
        ("AU", "Australien"),
        ("BE", "Belgien"),
        ("BR", "Brasilien"),
        ("CA", "Kanada"),
        ("CH", "der Schweiz"),
        ("CZ", "Tschechien"),
        ("DE", "Deutschland"),
        ("DK", "Dänemark"),
        ("ES", "Spanien"),
        ("FI", "Finnland"),
        ("FR", "Frankreich"),
        ("GB", "Großbritannien"),
        ("GR", "Griechenland"),
        ("HU", "Ungarn"),
        ("IE", "Irland"),
        ("IN", "Indien"),
        ("IT", "Italien"),
        ("JP", "Japan"),
        ("LU", "Luxemburg"),
        ("MX", "Mexiko"),
        ("NL", "den Niederlanden"),
        ("NO", "Norwegen"),
        ("NZ", "Neuseeland"),
        ("PL", "Polen"),
        ("PT", "Portugal"),
        ("RO", "Rumänien"),
        ("SE", "Schweden"),
        ("SK", "der Slowakei"),
        ("TR", "der Türkei"),
        ("US", "den USA"),
        ("ZA", "Südafrika"),
    ];
    NAMES
        .iter()
        .find(|(c, _)| *c == code)
        .map_or(code, |(_, name)| name)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Event {
    Test,
    /// The target price of the rule, if known.
    Target(Option<i64>),
    /// The lowest price before, if known.
    Low(Option<i64>),
}

/// What one message reports; every channel formats it in its own way.
#[derive(Debug)]
pub(crate) struct Alert {
    pub(crate) event: Event,
    pub(crate) game: String,
    pub(crate) cents: i64,
    pub(crate) estimate: bool,
    pub(crate) shop: Option<String>,
    pub(crate) region: Option<String>,
    pub(crate) country: Option<String>,
    pub(crate) url: Option<String>,
}

impl Alert {
    pub(crate) fn test() -> Self {
        Self {
            event: Event::Test,
            game: String::new(),
            cents: 0,
            estimate: false,
            shop: None,
            region: None,
            country: None,
            url: None,
        }
    }

    /// "KeyHunter: Wunschpreis erreicht · 24,90 €".
    pub(super) fn title(&self) -> String {
        match self.event {
            Event::Test => "KeyHunter: Testnachricht".into(),
            Event::Target(_) => format!("KeyHunter: Wunschpreis erreicht · {}", euro(self.cents)),
            Event::Low(_) => format!("KeyHunter: Neuer Tiefstpreis · {}", euro(self.cents)),
        }
    }

    /// "24,90 € bei Eneba (Global, gültig in Deutschland)".
    fn offer(&self) -> String {
        let mut text = euro(self.cents);
        if self.estimate {
            text.push_str(" (geschätzter Gesamtpreis)");
        }
        if let Some(shop) = &self.shop {
            text.push_str(&format!(" bei {shop}"));
        }
        let place: Vec<String> = [
            self.region.clone(),
            self.country
                .as_deref()
                .map(|c| format!("gültig in {}", country_name(c))),
        ]
        .into_iter()
        .flatten()
        .collect();
        if !place.is_empty() {
            text.push_str(&format!(" ({})", place.join(", ")));
        }
        text
    }

    /// The message in plain text, without the link.
    pub(super) fn text(&self) -> String {
        let game = &self.game;
        match self.event {
            Event::Test => "Das ist eine Testnachricht von KeyHunter. Dieser Kanal ist richtig eingerichtet: \
                Hier kommen deine Preisalarme an, zum Beispiel „Spiel X ist bei deinem Wunschpreis angekommen“."
                .into(),
            Event::Target(target) => {
                let mut text = format!("„{game}“ ist bei deinem Wunschpreis angekommen: {}.", self.offer());
                if let Some(target) = target {
                    text.push_str(&format!(" Ziel: {}.", euro(target)));
                }
                text
            }
            Event::Low(previous) => {
                let mut text = format!("„{game}“ hat einen neuen Tiefstpreis: {}.", self.offer());
                if let Some(previous) = previous {
                    text.push_str(&format!(" Bisher am günstigsten: {}.", euro(previous)));
                }
                text
            }
        }
    }

    /// ntfy tag (shown as an emoji).
    pub(super) fn tag(&self) -> &'static str {
        match self.event {
            Event::Test => "white_check_mark",
            Event::Target(_) => "moneybag",
            Event::Low(_) => "chart_with_downwards_trend",
        }
    }

    /// The shop offer and its label ("Zum Angebot bei Eneba").
    pub(super) fn link(&self) -> Option<(&str, String)> {
        let url = self.url.as_deref()?;
        let label = match &self.shop {
            Some(shop) => format!("Zum Angebot bei {shop}"),
            None => "Zum Angebot".into(),
        };
        Some((url, label))
    }

    /// Body of the generic webhook (docs/notifications.md).
    pub(super) fn json(&self) -> Value {
        let price = (self.event != Event::Test).then_some(self.cents);
        let (event, target, previous) = match self.event {
            Event::Test => ("test", None, None),
            Event::Target(target) => ("target_reached", target, None),
            Event::Low(previous) => ("new_low", None, previous),
        };
        json!({
            "event": event,
            "title": self.title(),
            "message": self.text(),
            "game": (event != "test").then_some(&self.game),
            "price_cents": price,
            "price": price.map(euro),
            "target_cents": target,
            "previous_low_cents": previous,
            "estimate": self.estimate,
            "shop": self.shop,
            "region": self.region,
            "country": self.country,
            "url": self.url,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::notify::testing::*;
    #[test]
    fn messages_are_german_and_name_price_shop_region_and_target() {
        let alert = forza();
        assert_eq!(alert.title(), "KeyHunter: Wunschpreis erreicht · 24,90 €");
        assert_eq!(
            alert.text(),
            "„Forza Horizon 5“ ist bei deinem Wunschpreis angekommen: 24,90 € bei Eneba (Global, gültig in Deutschland). Ziel: 25,00 €."
        );
        let low = Alert {
            event: Event::Low(Some(2600)),
            estimate: true,
            region: None,
            country: Some("XK".into()),
            ..forza()
        };
        assert_eq!(low.title(), "KeyHunter: Neuer Tiefstpreis · 24,90 €");
        assert_eq!(
            low.text(),
            "„Forza Horizon 5“ hat einen neuen Tiefstpreis: 24,90 € (geschätzter Gesamtpreis) bei Eneba (gültig in XK). Bisher am günstigsten: 26,00 €."
        );
        let test = Alert::test();
        assert_eq!(test.title(), "KeyHunter: Testnachricht");
        assert!(
            test.text()
                .starts_with("Das ist eine Testnachricht von KeyHunter.")
        );
        assert!(test.link().is_none());
        assert_eq!(euro(123_456), "1.234,56 €");
        assert_eq!(euro(5), "0,05 €");
        assert_eq!(euro(100_000_000), "1.000.000,00 €");
        assert_eq!(
            forza().link(),
            Some((
                "https://www.eneba.com/de/xbox-forza-horizon-5-key-global",
                "Zum Angebot bei Eneba".into()
            ))
        );
    }
}
