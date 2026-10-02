/**
 * Testy generatora kodow QR uzywanego na ekranie 2FA.
 *
 * Skroty macierzy pochodza z przebiegu porownanego modul po module z niezalezna
 * implementacja (biblioteka `qrcode` w Pythonie, poziom korekcji M, tryb
 * bajtowy, wymuszona ta sama maska). Zgodnosc potwierdzono dla wszystkich
 * obslugiwanych wersji 1-10. Jesli ktorys skrot przestanie sie zgadzac, znaczy
 * to, ze symbol zmienil ksztalt - i trzeba go ponownie sprawdzic wobec
 * niezaleznej implementacji, a nie tylko podmienic oczekiwana wartosc.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  macierzKoduQr,
  kodQrJakoDataUri,
  adresOtpauth,
} from "../../../aplikacje/web/src/portfel/services/kodQr.ts";

function skrotMacierzy(tresc: string): { rozmiar: number; skrot: string } {
  const macierz = macierzKoduQr(tresc);
  const tekst = macierz.map((wiersz) => wiersz.map((c) => (c ? "1" : "0")).join("")).join("\n");
  return {
    rozmiar: macierz.length,
    skrot: createHash("sha256").update(tekst).digest("hex").slice(0, 32),
  };
}

test("symbole zgadzaja sie co do modulu z niezalezna implementacja", () => {
  assert.deepEqual(skrotMacierzy("HELLO WORLD"), {
    rozmiar: 21,
    skrot: "2d21897bf5a7ac606d02da07bdd5e7f0",
  });

  // Domena example.com jest zarezerwowana norma RFC 2606 - bramka danych
  // prywatnych odrzuca adresy w domenach, ktore ktos moze naprawde miec.
  // Symbol sprawdzony niezaleznym dekoderem (OpenCV QRCodeDetector): odczyt
  // zwraca doslownie ten sam adres otpauth.
  assert.deepEqual(skrotMacierzy(adresOtpauth("JBSWY3DPEHPK3PXP", "Test", "a@example.com")), {
    rozmiar: 45,
    skrot: "002f1b44de83696caafed49aab7b4908",
  });

  assert.deepEqual(
    skrotMacierzy(adresOtpauth("5XVGZPZPQFSVPRAZBDTPIF7H46XRBFTH", "PIT38TaxAdvisor", "inwestor")),
    { rozmiar: 49, skrot: "89fc60b3b61a142e88cf3cfcd18dba0e" }
  );
});

test("wzorce pozycji i modul ciemny stoja tam, gdzie wymaga tego norma", () => {
  const macierz = macierzKoduQr(adresOtpauth("JBSWY3DPEHPK3PXP", "Test", "a@example.com"));
  const n = macierz.length;

  for (const [px, py] of [
    [0, 0],
    [n - 7, 0],
    [0, n - 7],
  ]) {
    for (let y = 0; y < 7; y++) {
      for (let x = 0; x < 7; x++) {
        const naObwodzie = x === 0 || x === 6 || y === 0 || y === 6;
        const wSrodku = x >= 2 && x <= 4 && y >= 2 && y <= 4;
        assert.equal(
          macierz[py + y][px + x],
          naObwodzie || wSrodku,
          `wzorzec pozycji (${px},${py}) modul (${x},${y})`
        );
      }
    }
  }

  assert.equal(macierz[n - 8][8], true, "modul na (8, n-8) musi byc ciemny");

  for (let i = 8; i < n - 8; i++) {
    assert.equal(macierz[6][i], i % 2 === 0, `wzorzec czasu w wierszu 6, kolumna ${i}`);
    assert.equal(macierz[i][6], i % 2 === 0, `wzorzec czasu w kolumnie 6, wiersz ${i}`);
  }
});

test("dobor wersji rosnie z dlugoscia tresci, a za dluga tresc jest odrzucana", () => {
  const krotka = macierzKoduQr("a").length;
  const dluga = macierzKoduQr("a".repeat(200)).length;
  assert.ok(dluga > krotka, "dluzsza tresc wymaga wiekszego symbolu");
  assert.throws(() => macierzKoduQr("a".repeat(300)), /zbyt długie/i);
});

test("obraz jest lokalnym Data URI bez zapytan do obcych serwerow", () => {
  const tresc = adresOtpauth("JBSWY3DPEHPK3PXP", "PIT38TaxAdvisor", "portfel");
  const uri = kodQrJakoDataUri(tresc);
  const svg = decodeURIComponent(uri.slice("data:image/svg+xml;utf8,".length));

  assert.ok(uri.startsWith("data:image/svg+xml;utf8,"));
  // Jedyny adres w pliku to przestrzen nazw SVG - identyfikator, nie zasob do
  // pobrania. Poza nim obraz nie moze wskazywac na nic z zewnatrz, bo sekret
  // TOTP trafilby wtedy w cudze rece.
  const adresy = svg.match(/https?:\/\/[^"']+/g) ?? [];
  assert.deepEqual(adresy, ["http://www.w3.org/2000/svg"]);
  assert.ok(!svg.includes("<image"), "brak osadzonych obrazow zewnetrznych");
  assert.ok(!svg.includes("href"), "brak odwolan przez href");

  // Cicha strefa: cztery moduly marginesu z kazdej strony.
  const modulow = macierzKoduQr(tresc).length;
  assert.ok(
    svg.includes(`viewBox="0 0 ${modulow + 8} ${modulow + 8}"`),
    `viewBox ma obejmowac ${modulow} modulow i po cztery moduly marginesu`
  );
});

test("adres otpauth ma pola wymagane przez aplikacje uwierzytelniajace", () => {
  const adres = adresOtpauth("JBSWY3DPEHPK3PXP", "PIT38TaxAdvisor", "jan@example.com");

  assert.ok(adres.startsWith("otpauth://totp/"));
  const parametry = new URL(adres).searchParams;
  assert.equal(parametry.get("secret"), "JBSWY3DPEHPK3PXP");
  assert.equal(parametry.get("issuer"), "PIT38TaxAdvisor");
  assert.equal(parametry.get("algorithm"), "SHA1");
  assert.equal(parametry.get("digits"), "6");
  assert.equal(parametry.get("period"), "30");
  assert.ok(adres.includes(encodeURIComponent("PIT38TaxAdvisor:jan@example.com")));
});
