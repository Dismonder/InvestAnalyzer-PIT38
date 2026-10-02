/**
 * Maskowanie sekretow w komunikatach od brokerow.
 *
 * Tresc bledu od brokera jest najcenniejsza informacja diagnostyczna
 * ("nieprawidlowy klucz", "brak uprawnien"), wiec nie wolno jej wycinac -
 * bez niej uzytkownik nie wie, dlaczego polaczenie nie dziala. Usuwamy
 * natomiast wszystko, co wyglada na klucz albo login odbity w echo.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { bezSekretow, sendTradernetRequest, testFreedom24Connection } from "../../../aplikacje/web/src/server/routes/brokers.ts";

test("zwykly komunikat diagnostyczny przechodzi bez zmian", () => {
  assert.equal(
    bezSekretow("Invalid API-key, IP, or permissions for action"),
    "Invalid API-key, IP, or permissions for action",
  );
});

test("dlugi ciag szesnastkowy jest maskowany", () => {
  const wynik = bezSekretow("Key a13f10f522390e92fda7b17a95495d58 rejected");
  assert.ok(!wynik.includes("a13f10f522390e92"), "klucz nie moze wyciec");
  assert.ok(wynik.includes("[klucz]"));
  assert.ok(wynik.includes("rejected"), "reszta komunikatu zostaje");
});

test("dlugi token alfanumeryczny jest maskowany", () => {
  const wynik = bezSekretow("token=abcdefghijklmnopqrstuvwxyz0123456789 invalid");
  assert.ok(wynik.includes("[klucz]"));
  assert.ok(!wynik.includes("abcdefghijklmnopqrstuvwxyz"));
});

test("adres e-mail jest maskowany", () => {
  const wynik = bezSekretow("Konto jan.kowalski@example.com zablokowane");
  assert.ok(!wynik.includes("@example.com"));
  assert.ok(wynik.includes("[adres e-mail]"));
  assert.ok(wynik.includes("zablokowane"));
});

test("pusty komunikat dostaje wartosc zapasowa", () => {
  assert.equal(bezSekretow("", "błąd sieciowy"), "błąd sieciowy");
  assert.equal(bezSekretow(undefined, "błąd sieciowy"), "błąd sieciowy");
  assert.equal(bezSekretow("   ", "błąd sieciowy"), "błąd sieciowy");
});

test("bardzo dlugi komunikat jest przycinany", () => {
  assert.ok(bezSekretow("x".repeat(5000)).length <= 300);
});

test("krotkie identyfikatory zostaja - to nie sa sekrety", () => {
  assert.equal(bezSekretow("Kod bledu 1013"), "Kod bledu 1013");
  assert.equal(bezSekretow("AAPL.US nie istnieje"), "AAPL.US nie istnieje");
});

test('diagnostyka testu połączenia nie oddaje fragmentu sekretu', async () => {
  // `secretPreview` oddawalo pierwsze i ostatnie trzy znaki klucza prywatnego
  // w odpowiedzi HTTP - do przegladarki, do logow posrednikow i na zrzuty.
  const sekret = 'sekretny-klucz-tradernet-1234567890';
  const oryginalny = globalThis.fetch;
  globalThis.fetch = (async () => new Response('błąd', { status: 403 })) as typeof fetch;

  try {
    const wynik: any = await testFreedom24Connection('publiczny-klucz-1234', sekret);
    const tekst = JSON.stringify(wynik);

    assert.ok(!tekst.includes(sekret), 'caly sekret nie moze wyjsc w odpowiedzi');
    assert.ok(!tekst.includes(sekret.slice(0, 3)), 'ani jego poczatek');
    assert.ok(!tekst.includes(sekret.slice(-3)), 'ani jego koniec');
    assert.match(String(wynik.diagnostics?.secretPreview ?? ''), /podany/);
  } finally {
    globalThis.fetch = oryginalny;
  }
});

test('podpisane żądanie nie idzie do stref .ru, .by ani .kz', async () => {
  // Lista domen zaczynala sie od `tradernet.ru`, wiec klucz publiczny i podpis
  // szly najpierw do Rosji, Bialorusi i Kazachstanu, zanim trafily do strefy,
  // w ktorej klient z Unii ma rachunek.
  const odpytane: string[] = [];
  const oryginalny = globalThis.fetch;
  globalThis.fetch = (async (wejscie: any) => {
    odpytane.push(String(wejscie));
    return new Response('{}', { status: 500, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;

  try {
    await sendTradernetRequest('getTradesHistory', {}, 'klucz-publiczny', 'klucz-prywatny');

    assert.ok(odpytane.length > 0, 'test musi faktycznie odpytac jakis adres');
    for (const adres of odpytane) {
      assert.doesNotMatch(adres, /tradernet\.(ru|by|kz)/, `zadanie poszlo do ${adres}`);
    }
    assert.ok(
      odpytane.some((adres) => adres.includes('freedom24.com')),
      'strefa freedom24.com musi byc odpytana'
    );
  } finally {
    globalThis.fetch = oryginalny;
  }
});
