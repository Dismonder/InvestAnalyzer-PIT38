use std::borrow::Cow;

/// Tabela Windows-1250 dla bajtow 0x80-0xFF. Wygenerowana z kodeka cp1250,
/// wiec odwzorowanie jest dokladne, a nie przepisane recznie.
/// U+FFFD stoi tam, gdzie strona kodowa nie definiuje znaku.
/// Tabela Windows-1250 dla bajtow 0x80-0xFF, wedlug indeksu WHATWG - tego
/// samego, ktorego uzywa TextDecoder('windows-1250') w przegladarce, zeby obie
/// warstwy czytaly ten sam plik tak samo.
///
/// Piec pozycji (0x81, 0x83, 0x88, 0x90, 0x98) nie ma znaku w kodeku cp1250
/// Pythona - WHATWG odwzorowuje je na znaki sterujace C1 o tym samym numerze
/// i tak robimy tutaj. W plikach brokera nie wystepuja; chodzi o to, zeby
/// desktop i przegladarka nie roznily sie ani na jednym bajcie.
const CP1250_HIGH: [char; 128] = [
    '\u{20ac}', '\u{0081}', '\u{201a}', '\u{0083}', '\u{201e}', '\u{2026}', '\u{2020}', '\u{2021}',
    '\u{0088}', '\u{2030}', '\u{0160}', '\u{2039}', '\u{015a}', '\u{0164}', '\u{017d}', '\u{0179}',
    '\u{0090}', '\u{2018}', '\u{2019}', '\u{201c}', '\u{201d}', '\u{2022}', '\u{2013}', '\u{2014}',
    '\u{0098}', '\u{2122}', '\u{0161}', '\u{203a}', '\u{015b}', '\u{0165}', '\u{017e}', '\u{017a}',
    '\u{00a0}', '\u{02c7}', '\u{02d8}', '\u{0141}', '\u{00a4}', '\u{0104}', '\u{00a6}', '\u{00a7}',
    '\u{00a8}', '\u{00a9}', '\u{015e}', '\u{00ab}', '\u{00ac}', '\u{00ad}', '\u{00ae}', '\u{017b}',
    '\u{00b0}', '\u{00b1}', '\u{02db}', '\u{0142}', '\u{00b4}', '\u{00b5}', '\u{00b6}', '\u{00b7}',
    '\u{00b8}', '\u{0105}', '\u{015f}', '\u{00bb}', '\u{013d}', '\u{02dd}', '\u{013e}', '\u{017c}',
    '\u{0154}', '\u{00c1}', '\u{00c2}', '\u{0102}', '\u{00c4}', '\u{0139}', '\u{0106}', '\u{00c7}',
    '\u{010c}', '\u{00c9}', '\u{0118}', '\u{00cb}', '\u{011a}', '\u{00cd}', '\u{00ce}', '\u{010e}',
    '\u{0110}', '\u{0143}', '\u{0147}', '\u{00d3}', '\u{00d4}', '\u{0150}', '\u{00d6}', '\u{00d7}',
    '\u{0158}', '\u{016e}', '\u{00da}', '\u{0170}', '\u{00dc}', '\u{00dd}', '\u{0162}', '\u{00df}',
    '\u{0155}', '\u{00e1}', '\u{00e2}', '\u{0103}', '\u{00e4}', '\u{013a}', '\u{0107}', '\u{00e7}',
    '\u{010d}', '\u{00e9}', '\u{0119}', '\u{00eb}', '\u{011b}', '\u{00ed}', '\u{00ee}', '\u{010f}',
    '\u{0111}', '\u{0144}', '\u{0148}', '\u{00f3}', '\u{00f4}', '\u{0151}', '\u{00f6}', '\u{00f7}',
    '\u{0159}', '\u{016f}', '\u{00fa}', '\u{0171}', '\u{00fc}', '\u{00fd}', '\u{0163}', '\u{02d9}',
];

/// Nazwa kodowania uzytego przy odczycie - trafia do interfejsu, zeby bylo
/// widac, skad wzielo sie brzmienie polskich znakow.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TextEncoding {
    Utf8,
    Cp1250,
}

impl TextEncoding {
    pub fn as_str(self) -> &'static str {
        match self {
            TextEncoding::Utf8 => "utf-8",
            TextEncoding::Cp1250 => "windows-1250",
        }
    }
}

fn decode_cp1250(bytes: &[u8]) -> String {
    bytes
        .iter()
        .map(|byte| {
            if *byte < 0x80 {
                *byte as char
            } else {
                CP1250_HIGH[(*byte - 0x80) as usize]
            }
        })
        .collect()
}

/// Tekst pliku wraz z kodowaniem, ktore zadzialalo.
///
/// `String::from_utf8_lossy` zamienialo kazdy bajt spoza UTF-8 na znak
/// zastepczy. Archiwa kursow NBP sa zapisane w Windows-1250 - bajt 0xB3 to
/// "l z kreska" - wiec naglowki tracily polskie znaki bez zadnego ostrzezenia.
/// Silnik Pythona czyta te pliki jako cp1250 od poczatku; ta funkcja wyrownuje
/// zachowanie warstwy desktopowej.
pub fn decode_text(bytes: &[u8]) -> (String, TextEncoding) {
    // BOM UTF-8 jest jednoznaczny, wiec rozstrzyga od razu.
    if let Some(rest) = bytes.strip_prefix(&[0xEF, 0xBB, 0xBF]) {
        if let Ok(text) = std::str::from_utf8(rest) {
            return (text.to_string(), TextEncoding::Utf8);
        }
    }
    match String::from_utf8_lossy(bytes) {
        Cow::Borrowed(text) => (text.to_string(), TextEncoding::Utf8),
        // Tresc nie jest poprawnym UTF-8. W tym zbiorze plikow oznacza to
        // Windows-1250; kazdy bajt ma tam swoj znak, wiec odczyt sie nie psuje.
        Cow::Owned(_) => (decode_cp1250(bytes), TextEncoding::Cp1250),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn utf8_content_is_read_as_utf8() {
        let (text, encoding) = decode_text("pelny numer tabeli".as_bytes());

        assert_eq!(text, "pelny numer tabeli");
        assert_eq!(encoding, TextEncoding::Utf8);
    }

    #[test]
    fn utf8_with_a_bom_keeps_its_content() {
        let mut bytes = vec![0xEF, 0xBB, 0xBF];
        bytes.extend_from_slice("kurs sredni".as_bytes());

        let (text, encoding) = decode_text(&bytes);

        assert_eq!(text, "kurs sredni");
        assert_eq!(encoding, TextEncoding::Utf8);
    }

    #[test]
    fn polish_letters_from_the_nbp_archive_survive() {
        // "pelny numer tabeli" z archiwum NBP: 0xB3 to "l z kreska".
        let bytes = [b'p', b'e', 0xB3, b'n', b'y'];

        let (text, encoding) = decode_text(&bytes);

        assert_eq!(
            text, "pe\u{0142}ny",
            "bajt 0xB3 to l z kreska, nie znak zastepczy"
        );
        assert_eq!(encoding, TextEncoding::Cp1250);
    }

    #[test]
    fn every_polish_letter_maps_to_itself() {
        let bytes = [0xB9, 0xE6, 0xEA, 0xB3, 0xF1, 0xF3, 0x9C, 0x9F, 0xBF];

        let (text, _) = decode_text(&bytes);

        assert_eq!(
            text,
            "\u{0105}\u{0107}\u{0119}\u{0142}\u{0144}\u{00f3}\u{015b}\u{017a}\u{017c}"
        );
    }

    #[test]
    fn uppercase_polish_letters_map_too() {
        let bytes = [0xA5, 0xC6, 0xCA, 0xA3, 0xD1, 0xD3, 0x8C, 0x8F, 0xAF];

        let (text, _) = decode_text(&bytes);

        assert_eq!(
            text,
            "\u{0104}\u{0106}\u{0118}\u{0141}\u{0143}\u{00d3}\u{015a}\u{0179}\u{017b}"
        );
    }

    #[test]
    fn the_table_matches_the_whatwg_index_used_by_the_browser() {
        // Piec pozycji nieprzypisanych w cp1250 mapuje sie na znaki sterujace C1.
        assert_eq!(CP1250_HIGH[0x01], '\u{0081}');
        assert_eq!(CP1250_HIGH[0x03], '\u{0083}');
        assert_eq!(CP1250_HIGH[0x08], '\u{0088}');
        assert_eq!(CP1250_HIGH[0x10], '\u{0090}');
        assert_eq!(CP1250_HIGH[0x18], '\u{0098}');
        // Zaden bajt nie jest znakiem zastepczym - to znaczyloby cicha utrate.
        assert!(
            !CP1250_HIGH.contains(&'\u{fffd}'),
            "kazdy bajt Windows-1250 ma swoj znak"
        );
    }

    #[test]
    fn ascii_bytes_are_untouched_in_both_encodings() {
        let (text, encoding) = decode_text(b"date;currency;rate");

        assert_eq!(text, "date;currency;rate");
        assert_eq!(encoding, TextEncoding::Utf8);
    }
}
