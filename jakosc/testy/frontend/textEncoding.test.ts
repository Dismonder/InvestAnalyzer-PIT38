import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { decodeStorageText } from "../../../aplikacje/web/src/invest_analyzer/services/textEncoding.ts";
import { archiwumKursowNbp } from "../zestawWejsciowy.ts";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

test("plik w UTF-8 zostaje odczytany jako UTF-8", () => {
  const bytes = new TextEncoder().encode("pełny numer tabeli");

  assert.deepEqual(decodeStorageText(bytes), { text: "pełny numer tabeli", encoding: "utf-8" });
});

test("znacznik BOM nie trafia do treści", () => {
  const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode("kurs średni")]);

  assert.deepEqual(decodeStorageText(bytes), { text: "kurs średni", encoding: "utf-8" });
});

test("polskie znaki z archiwum NBP nie zamieniają się w znaki zastępcze", () => {
  // 0xB3 to "ł" w Windows-1250; response.text() robiło z niego "�".
  const bytes = new Uint8Array([0x70, 0x65, 0xb3, 0x6e, 0x79]);

  assert.deepEqual(decodeStorageText(bytes), { text: "pełny", encoding: "windows-1250" });
});

test("próbka nagłówka CSV w Windows-1250 zachowuje kolumnę Ilość", () => {
  const bytes = new Uint8Array([...'Data;Symbol;Ilo'.split('').map((znak) => znak.charCodeAt(0)), 0x9c, 0xe6, ...new TextEncoder().encode(';Cena')]);

  const decoded = decodeStorageText(bytes);

  assert.equal(decoded.encoding, "windows-1250");
  assert.equal(decoded.text, "Data;Symbol;Ilość;Cena");
});

test("cały polski alfabet mapuje się poprawnie", () => {
  const lower = new Uint8Array([0xb9, 0xe6, 0xea, 0xb3, 0xf1, 0xf3, 0x9c, 0x9f, 0xbf]);
  const upper = new Uint8Array([0xa5, 0xc6, 0xca, 0xa3, 0xd1, 0xd3, 0x8c, 0x8f, 0xaf]);

  assert.equal(decodeStorageText(lower).text, "ąćęłnóśźż".replace("n", "ń"));
  assert.equal(decodeStorageText(upper).text, "ĄĆĘŁNÓŚŹŻ".replace("N", "Ń"));
});

test("czysty ASCII czyta się jako UTF-8", () => {
  const bytes = new TextEncoder().encode("date;currency;rate");

  assert.deepEqual(decodeStorageText(bytes), { text: "date;currency;rate", encoding: "utf-8" });
});

test("archiwum NBP w cp1250 czyta się bez znaków zastępczych", () => {
  // Test kończył się cichym `return`, gdy prywatnego archiwum nie było na dysku -
  // czyli na każdym świeżym klonie i w CI nie sprawdzał niczego. Zestaw
  // syntetyczny ma ten sam układ nagłówka i to samo kodowanie.
  const { sciezka } = archiwumKursowNbp();
  const bytes = new Uint8Array(readFileSync(sciezka));

  const decoded = decodeStorageText(bytes);

  assert.equal(decoded.encoding, "windows-1250");
  assert.equal(decoded.text.includes("�"), false, "żaden znak nie może być zastępczy");
  assert.equal(decoded.text.includes("pełny numer tabeli"), true);
});

test("wszystkie 256 bajtów czyta się tak samo w przeglądarce i w powłoce desktop", () => {
  // Obie warstwy czytają te same pliki. Rozjazd choćby na jednym bajcie znaczy,
  // że ten sam wyciąg wygląda inaczej zależnie od tego, jak uruchomiono program.
  const rustSource = readFileSync(
    path.join(repoRoot, "aplikacje", "komputerowa", "tauri", "src", "security", "text_encoding.rs"),
    "utf8",
  );
  const start = rustSource.indexOf("const CP1250_HIGH: [char; 128] = [");
  assert.ok(start >= 0, "nie znaleziono tabeli w powłoce desktop");
  const literal = rustSource.slice(start, rustSource.indexOf("];", start));
  const rustTable = [...literal.matchAll(/'\\u\{([0-9a-f]{4})\}'/g)].map((m) => parseInt(m[1], 16));

  assert.equal(rustTable.length, 128, "tabela musi mieć 128 pozycji");

  const divergent: string[] = [];
  for (let byte = 0x80; byte <= 0xff; byte += 1) {
    const fromWeb = decodeStorageText(new Uint8Array([byte])).text.codePointAt(0);
    const fromDesktop = rustTable[byte - 0x80];
    if (fromWeb !== fromDesktop) {
      divergent.push(`0x${byte.toString(16)}: web U+${fromWeb?.toString(16)} vs desktop U+${fromDesktop.toString(16)}`);
    }
  }

  assert.deepEqual(divergent, [], "obie warstwy muszą dawać ten sam znak dla każdego bajtu");
});

test("bajty ASCII czyta się tak samo w obu warstwach", () => {
  for (const byte of [0x00, 0x09, 0x41, 0x7f]) {
    assert.equal(decodeStorageText(new Uint8Array([byte, 0xb3])).text.codePointAt(0), byte);
  }
});
