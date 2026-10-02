/**
 * Panel optymalizacji podatkowej.
 *
 * Testujemy dwie rzeczy, ktore realnie moga sie zepsuc: czy panel pokazuje
 * wszystkie kategorie kosztow razem z podstawa prawna (bez tego uzytkownik nie
 * wie, co wlacza) i czy stan przelacznikow idzie z zapisanych ustawien, a nie
 * z wartosci wpisanych na sztywno w widoku.
 */

import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { closeTaxYear } from "../../../aplikacje/web/src/invest_analyzer/services/yearClosure.ts";
import { opublikujWynikSilnika, uniewaznijWynikiSilnika } from "../../../aplikacje/web/src/invest_analyzer/services/ostatniWynikSilnika.ts";
import type { TaxEngineResponse } from "../../../aplikacje/web/src/invest_analyzer/hooks/useTaxEngineRun.ts";

import { OptymalizacjaPanel } from "../../../aplikacje/web/src/portfel/components/OptymalizacjaPanel.tsx";
import {
  POZYCJE_KOSZTOWE,
  USTAWIENIA_DOMYSLNE,
  odczytajUstawienia,
  przywrocMaksymalnaOptymalizacje,
  zapiszUstawienia,
} from "../../../aplikacje/web/src/portfel/services/optymalizacjaPodatkowa.ts";

/** Node nie ma localStorage, a serwis sie na nim opiera. */
function podstawMagazyn(): Map<string, string> {
  const dane = new Map<string, string>();
  (globalThis as unknown as { localStorage: Storage }).localStorage = {
    getItem: (klucz: string) => dane.get(klucz) ?? null,
    setItem: (klucz: string, wartosc: string) => {
      dane.set(klucz, String(wartosc));
    },
    removeItem: (klucz: string) => {
      dane.delete(klucz);
    },
    clear: () => dane.clear(),
    key: () => null,
    length: 0,
  } as unknown as Storage;
  return dane;
}

test("panel wymienia wszystkie kategorie kosztow razem z podstawa prawna", () => {
  podstawMagazyn();
  const markup = renderToStaticMarkup(<OptymalizacjaPanel language="pl" />);

  for (const pozycja of POZYCJE_KOSZTOWE) {
    assert.ok(
      markup.includes(pozycja.nazwa),
      `brak kategorii "${pozycja.nazwa}" - uzytkownik nie zobaczy, co wlacza`,
    );
    assert.ok(
      markup.includes(pozycja.podstawa.slice(0, 24)),
      `brak podstawy prawnej dla "${pozycja.nazwa}"`,
    );
  }
  assert.ok(markup.includes("W-8BEN"), "panel musi wyjaśniać formularz W-8BEN");
  assert.ok(!markup.includes('Złożyłem formularz W-8BEN'), 'informacja nie może udawać przełącznika rozliczenia');
});

test('przywrócenie planu i przełączników zachowuje wpisane dane', () => {
  const wpisane = {
    ...USTAWIENIA_DOMYSLNE,
    plan: 'conservative_user' as const,
    odsetki: false,
    maW8BEN: false,
    informacjePit8c: [{ id: 'pit', taxYear: 2026, revenuePln: '450', costsPln: '200' }],
    stratyZLatUbieglych: [{ id: 'strata', taxYear: 2024, amountPln: '123' }],
    oplatyFinansowania: [{ id: 'opłata', amount: '40', currency: 'PLN', date: '2026-01-01', depositId: '', depositAmount: '0', evidenceNote: '' }],
    kosztyKryptoZLatUbieglych: '789,50',
  };
  const wynik = przywrocMaksymalnaOptymalizacje(wpisane);
  assert.equal(wynik.plan, USTAWIENIA_DOMYSLNE.plan);
  assert.equal(wynik.odsetki, true);
  assert.equal(wynik.maW8BEN, false);
  for (const klucz of ['informacjePit8c', 'stratyZLatUbieglych', 'oplatyFinansowania', 'kosztyKryptoZLatUbieglych'] as const) {
    assert.deepEqual(wynik[klucz], wpisane[klucz]);
  }
});

test("stan przelacznikow idzie z zapisanych ustawien, a nie z wartosci w widoku", () => {
  podstawMagazyn();
  zapiszUstawienia({
    ...USTAWIENIA_DOMYSLNE,
    odsetki: false,
    oplatyRachunku: false,
  });

  const markup = renderToStaticMarkup(<OptymalizacjaPanel language="pl" />);
  const zaznaczone = (markup.match(/checked=""/g) || []).length;
  const wszystkie = (markup.match(/type="checkbox"/g) || []).length;

  assert.ok(wszystkie >= POZYCJE_KOSZTOWE.length, "kazda kategoria potrzebuje przelacznika");
  assert.ok(
    zaznaczone < wszystkie,
    "dwie kategorie sa wylaczone, wiec nie wszystkie przelaczniki moga byc zaznaczone",
  );
});

test("zapis ustawien przezywa ponowny odczyt", () => {
  podstawMagazyn();
  zapiszUstawienia({ ...USTAWIENIA_DOMYSLNE, kosztyFinansowania: false, maW8BEN: false });

  const odczytane = odczytajUstawienia();
  assert.equal(odczytane.kosztyFinansowania, false);
  assert.equal(odczytane.maW8BEN, false);
  assert.equal(odczytane.odsetki, true, "pozostale ustawienia zostaja bez zmian");
  assert.equal(odczytane.plan, "aggressive_user");
});

test("panel pokazuje stary koszt bez roku i podpowiada poz. 40 poprzedniego wyniku", () => {
  const store = podstawMagazyn();
  store.set("cryptoCostsCarriedForward", "1000.00");
  store.set("cryptoCostsCarriedForwardByYear", '{"2026":"400.00"}');
  opublikujWynikSilnika(2025, "synthetic", {
    success: true, annual_summary: { tax_year: "2025" },
    crypto_part_e: { costs_carried_out_pln: "400.00" },
  } as TaxEngineResponse);
  try {
    const markup = renderToStaticMarkup(<OptymalizacjaPanel language="pl" selectedYear={2026} />);
    assert.match(markup, /Dawna kwota bez przypisanego roku: 1000\.00 PLN/);
    assert.match(markup, /Wynik silnika za 2025: poz\. 40 = 400\.00 PLN/);
    assert.match(markup, /Poz\. 38 za rok 2026/);
    assert.match(markup, /value="400\.00"/);
  } finally {
    uniewaznijWynikiSilnika();
  }
});

test("panel blokuje edycję strat i kosztu krypto po zamknięciu roku", () => {
  const store = podstawMagazyn();
  store.set("priorYearLossEntries", '[{"id":"l1","taxYear":2024,"amountPln":"1000","remainingPln":"400"}]');
  store.set("cryptoCostsCarriedForwardByYear", '{"2026":"400.00"}');
  closeTaxYear(localStorage, {
    case_file_id: "case-2026", generated_at: "2026-09-01T10:00:00.000Z", tax_year: "2026",
    plan_used: "aggressive_user", audit_hash: "audit", reproducible: true,
    reproducibility_status: "complete", input_fingerprint: "input", calculation_fingerprint: "calc",
  });
  const markup = renderToStaticMarkup(<OptymalizacjaPanel language="pl" selectedYear={2026} />);
  assert.match(markup, /Otwórz rok ponownie, aby zmienić straty z lat ubiegłych/);
  assert.match(markup, /Otwórz rok ponownie, aby zmienić koszt krypto/);
  assert.match(markup, /disabled=""[^>]*value="400\.00"/);
});

test("domyslnie wlaczone sa wszystkie kategorie kosztow", () => {
  for (const pozycja of POZYCJE_KOSZTOWE) {
    assert.equal(
      USTAWIENIA_DOMYSLNE[pozycja.klucz],
      true,
      `kategoria "${pozycja.nazwa}" ma byc domyslnie wlaczona`,
    );
  }
});

test("plan i wpisy z warsztatu wygrywaja z kopia panelu - zapis panelu ich nie cofa", () => {
  const store = podstawMagazyn();
  // Panel zapisany wczesniej: plan agresywny i jedna oplata finansowania.
  zapiszUstawienia({
    ...USTAWIENIA_DOMYSLNE,
    oplatyFinansowania: [{ id: "stara", amount: "40", currency: "PLN", date: "2026-01-01", depositId: "", depositAmount: "0", evidenceNote: "" }],
  });
  // Potem uzytkownik zmienia plan, wylacza odsetki i usuwa oplate w warsztacie ("Dokumenty i silnik").
  store.set("taxCalculationPlan", "conservative_user");
  store.set("includeInterestCosts", "false");
  store.set("fundingFeeEntries", "[]");

  const odczytane = odczytajUstawienia();
  assert.equal(odczytane.plan, "conservative_user");
  assert.equal(odczytane.odsetki, false);
  assert.deepEqual(odczytane.oplatyFinansowania, []);

  // Dopisanie PIT-8C w panelu nie przywraca starego planu ani usunietej oplaty.
  zapiszUstawienia({ ...odczytane, informacjePit8c: [{ id: "pit", taxYear: 2026, revenuePln: "450", costsPln: "200" }] }, false);
  assert.equal(store.get("taxCalculationPlan"), "conservative_user");
  assert.equal(store.get("includeInterestCosts"), "false");
  assert.equal(store.get("fundingFeeEntries"), "[]");
  assert.equal(odczytajUstawienia().informacjePit8c.length, 1, "PIT-8C nadal pochodzi z panelu");
});

test("pierwsze otwarcie panelu przejmuje plan warsztatu, takze zapisany starsza nazwa", () => {
  const store = podstawMagazyn();
  store.set("taxCalculationPlan", "balanced_user");
  assert.equal(odczytajUstawienia().plan, "balanced_user");
  store.set("taxCalculationPlan", "defensible");
  assert.equal(odczytajUstawienia().plan, "balanced_user");
  store.set("taxCalculationPlan", "conservative");
  assert.equal(odczytajUstawienia().plan, "conservative_user");
  store.set("taxCalculationPlan", "nieznany");
  assert.equal(odczytajUstawienia().plan, "aggressive_user");
});
