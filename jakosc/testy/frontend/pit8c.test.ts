/**
 * Skad biora sie kwoty poz. 20 i 21 zeznania PIT-38.
 *
 * Do wiersza 1 czesci C wpisuje sie kwoty z poz. 35 i 36 otrzymanej informacji
 * PIT-8C - to je urzad porownuje z zeznaniem. Aplikacja potrafi policzyc te
 * czesc z transakcji, ale wlasny rachunek nie jest tym, co broker zglosil.
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  kwotaZWpisu,
  kwotaTekstowaZWpisu,
  poprawnaKwotaPit8c,
  kwotyPit8cDlaRoku,
  nowyWpisPit8c,
  wystawiaPit8c,
} from "../../../aplikacje/web/src/portfel/services/pit8c.ts";
import type { WpisPit8c } from "../../../aplikacje/web/src/portfel/services/optymalizacjaPodatkowa.ts";

const wpis = (nadpisania: Partial<WpisPit8c> = {}): WpisPit8c => ({
  id: "1",
  taxYear: 2026,
  revenuePln: "30000",
  costsPln: "20000",
  ...nadpisania,
});

test("wpisana informacja PIT-8C ma pierwszenstwo przed wlasnym rachunkiem", () => {
  const wynik = kwotyPit8cDlaRoku([wpis()], 2026, { przychod: 29990, koszty: 20010 });

  assert.equal(wynik.przychod, 30000);
  assert.equal(wynik.koszty, 20000);
  assert.equal(wynik.zrodlo, "informacja");
  // Wlasny rachunek zostaje do porownania, a nie znika.
  assert.equal(wynik.wyliczonyPrzychod, 29990);
  assert.equal(wynik.wyliczoneKoszty, 20010);
});

test("bez wpisu kwoty pochodza z transakcji i sa tak oznaczone", () => {
  const wynik = kwotyPit8cDlaRoku([], 2026, { przychod: 29990, koszty: 20010 });

  assert.equal(wynik.przychod, 29990);
  assert.equal(wynik.zrodlo, "transakcje");
  assert.equal(wynik.wyliczonyPrzychod, undefined);
});

test("kilka informacji za ten sam rok sumuje sie", () => {
  const wynik = kwotyPit8cDlaRoku(
    [
      wpis({ id: "a", issuer: "XTB", revenuePln: "30000", costsPln: "20000" }),
      wpis({ id: "b", issuer: "mBank", revenuePln: "5000", costsPln: "4000" }),
    ],
    2026
  );

  assert.equal(wynik.przychod, 35000);
  assert.equal(wynik.koszty, 24000);
});

test("wpis wypelniony do polowy nie staje sie deklaracja z zerem", () => {
  // Sam przychod bez kosztow dawalby poz. 21 = 0, czyli zadeklarowane
  // "nie mialem kosztow" - a to zwykle znaczy tylko niedokonczony wpis.
  const wynik = kwotyPit8cDlaRoku([wpis({ costsPln: "" })], 2026, { przychod: 100, koszty: 50 });

  assert.equal(wynik.zrodlo, "transakcje");
  assert.equal(wynik.przychod, 100);
  assert.equal(wynik.koszty, 50);
});

test("informacja z innego roku nie wchodzi do rozliczenia", () => {
  const wynik = kwotyPit8cDlaRoku([wpis({ taxYear: 2025 })], 2026, { przychod: 100, koszty: 50 });

  assert.equal(wynik.zrodlo, "transakcje");
  assert.equal(wynik.przychod, 100);
});

test("bez wpisu i bez rachunku pola zostaja puste, a nie zerowe", () => {
  const wynik = kwotyPit8cDlaRoku([], 2026);

  assert.equal(wynik.przychod, undefined);
  assert.equal(wynik.koszty, undefined);
  assert.equal(wynik.zrodlo, undefined);
});

test("kwota przepisana z formularza znosi przecinek i spacje", () => {
  assert.equal(kwotaZWpisu("12 500,50"), 12500.5);
  assert.equal(kwotaZWpisu("30000"), 30000);
  // Pusty i niepoprawny wpis to brak kwoty, a nie zero - zero wygladaloby
  // jak zadeklarowane "nic".
  assert.equal(kwotaZWpisu(""), undefined);
  assert.equal(kwotaZWpisu("   "), undefined);
  assert.equal(kwotaZWpisu("brak"), undefined);
  assert.equal(kwotaZWpisu(undefined), undefined);
  assert.equal(kwotaTekstowaZWpisu("1 234,56"), "1234.56");
  assert.equal(kwotaTekstowaZWpisu("1.234,56"), "1234.56");
  assert.equal(kwotaTekstowaZWpisu("1234,56"), "1234.56");
  assert.equal(kwotaTekstowaZWpisu("1,234.56"), "1234.56");
  assert.equal(poprawnaKwotaPit8c("1.234"), false);
  assert.equal(kwotaTekstowaZWpisu("1.234"), "1.234");
  assert.equal(poprawnaKwotaPit8c("-1.00"), false);
});

test("PIT-8C wystawiaja polscy platnicy, a nie brokerzy zagraniczni", () => {
  assert.equal(wystawiaPit8c("XTB"), true);
  assert.equal(wystawiaPit8c("EMAKLER"), true);
  assert.equal(wystawiaPit8c("IBKR"), false);
  assert.equal(wystawiaPit8c("FREEDOM24"), false);
  assert.equal(wystawiaPit8c("DEGIRO"), false);
  assert.equal(wystawiaPit8c(undefined), false);
});

test("nowy wpis PIT-8C dostaje wybrany rok rozliczenia, a nie poprzedni rok kalendarzowy", () => {
  // Silnik dostaje tylko wpisy z taxYear rownym wybranemu rokowi (taxEngineRequestFactory).
  const wpisZaRok = nowyWpisPit8c(2026, "n1");
  assert.equal(wpisZaRok.taxYear, 2026);
  assert.equal(nowyWpisPit8c(2023, "n2").taxYear, 2023);
  assert.deepEqual(wpisZaRok, { id: "n1", taxYear: 2026, revenuePln: "", costsPln: "", issuer: "" });
});