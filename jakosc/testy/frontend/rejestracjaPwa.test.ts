import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ODSTEP_SPRAWDZANIA_AKTUALIZACJI_MS,
  WIADOMOSC_POMIN_OCZEKIWANIE,
  czyOdswiezycPoZmianieKontrolera,
  czyProsicOPrzejecie,
  czyRejestrowacServiceWorker,
  czySprawdzicAktualizacje,
  podlaczAktualizacje,
} from '../../../aplikacje/web/src/shared/rejestracjaPwa.ts';

const zSW = { navigator: { serviceWorker: {} } };

test('service worker rejestruje sie tylko w wydaniu produkcyjnym na https albo localhost', () => {
  assert.equal(czyRejestrowacServiceWorker({ ...zSW, location: { protocol: 'https:', hostname: 'app.example' } }, true), true);
  assert.equal(czyRejestrowacServiceWorker({ ...zSW, location: { protocol: 'http:', hostname: 'localhost' } }, true), true);
  assert.equal(czyRejestrowacServiceWorker({ ...zSW, location: { protocol: 'http:', hostname: '192.168.0.5' } }, true), false, 'http poza localhost: przegladarka i tak odmowi');
  assert.equal(czyRejestrowacServiceWorker({ ...zSW, location: { protocol: 'https:', hostname: 'app.example' } }, false), false, 'serwer deweloperski nie ma sw.js');
});

test('desktop (Tauri) i przegladarka bez service workera nie rejestruja', () => {
  assert.equal(czyRejestrowacServiceWorker({ ...zSW, location: { protocol: 'tauri:', hostname: 'localhost' } }, true), false);
  assert.equal(czyRejestrowacServiceWorker({ ...zSW, location: { protocol: 'http:', hostname: 'tauri.localhost' } }, true), false);
  assert.equal(czyRejestrowacServiceWorker({ ...zSW, __TAURI_INTERNALS__: {}, location: { protocol: 'https:', hostname: 'x' } }, true), false);
  assert.equal(czyRejestrowacServiceWorker({ navigator: {}, location: { protocol: 'https:', hostname: 'x' } }, true), false);
});

test('reguly aktualizacji: prosba o przejecie tylko przy aktualizacji, jedno odswiezenie, sprawdzanie co godzine', () => {
  assert.equal(czyProsicOPrzejecie('installed', true), true);
  assert.equal(czyProsicOPrzejecie('installed', false), false, 'pierwsza instalacja: nie ma czego pomijac');
  assert.equal(czyProsicOPrzejecie('activated', true), false);
  assert.equal(czyOdswiezycPoZmianieKontrolera(true, false), true);
  assert.equal(czyOdswiezycPoZmianieKontrolera(true, true), false, 'tylko raz');
  assert.equal(czyOdswiezycPoZmianieKontrolera(false, false), false, 'pierwsze przejecie nie zmienia kodu strony');
  assert.equal(czySprawdzicAktualizacje(true, 10_000_000, 10_000_000 - ODSTEP_SPRAWDZANIA_AKTUALIZACJI_MS), true);
  assert.equal(czySprawdzicAktualizacje(true, 10_000_000, 10_000_000 - 1000), false);
  assert.equal(czySprawdzicAktualizacje(false, 10_000_000, 0), false);
});

/** Atrapa service workera z przelaczanym stanem. */
function atrapaWorkera(stan = 'installing') {
  const nasluchy: Array<() => void> = [];
  const wiadomosci: unknown[] = [];
  return {
    state: stan,
    addEventListener: (_typ: string, f: () => void) => { nasluchy.push(f); },
    postMessage: (w: unknown) => { wiadomosci.push(w); },
    zmienStan(nowy: string) { this.state = nowy; nasluchy.forEach((f) => f()); },
    wiadomosci,
  };
}

function atrapaSrodowiska(zKontrolerem: boolean) {
  const zdarzenia: Record<string, Array<() => void>> = {};
  const nasluch = (typ: string, f: () => void) => { (zdarzenia[typ] ??= []).push(f); };
  const wywolaj = (typ: string) => (zdarzenia[typ] ?? []).forEach((f) => f());
  let przeladowania = 0;
  let czas = 1_000_000;
  const dokument = { visibilityState: 'visible', addEventListener: nasluch };
  const kontener = { controller: zKontrolerem ? ({} as ServiceWorker) : null, addEventListener: nasluch };
  let aktualizacje = 0;
  const rejestracja = {
    waiting: null as ServiceWorker | null,
    installing: null as ServiceWorker | null,
    addEventListener: nasluch,
    update: async () => { aktualizacje++; },
  };
  return {
    rejestracja, dokument, kontener, wywolaj,
    srodowisko: { kontener, dokument, przeladuj: () => { przeladowania++; }, teraz: () => czas },
    przeladowania: () => przeladowania, aktualizacje: () => aktualizacje, przesunCzas: (ms: number) => { czas += ms; },
  };
}

test('aktualizacja: nowa wersja dostaje POMIN_OCZEKIWANIE, strona odswieza sie raz po schowaniu karty', () => {
  const s = atrapaSrodowiska(true);
  podlaczAktualizacje(s.rejestracja, s.srodowisko);
  const nowy = atrapaWorkera();
  s.rejestracja.installing = nowy as unknown as ServiceWorker;
  s.wywolaj('updatefound');
  nowy.zmienStan('installed');
  assert.deepEqual(nowy.wiadomosci, [WIADOMOSC_POMIN_OCZEKIWANIE]);

  s.wywolaj('controllerchange');
  assert.equal(s.przeladowania(), 0, 'widoczna karta: odswiezenie czeka na schowanie, zeby nie przerwac wpisywania');
  s.dokument.visibilityState = 'hidden';
  s.wywolaj('visibilitychange');
  assert.equal(s.przeladowania(), 1);
  s.wywolaj('controllerchange');
  s.wywolaj('visibilitychange');
  assert.equal(s.przeladowania(), 1, 'tylko jedno odswiezenie');
});

test('aktualizacja przy schowanej karcie odswieza od razu; pierwsza instalacja nie odswieza wcale', () => {
  const schowana = atrapaSrodowiska(true);
  podlaczAktualizacje(schowana.rejestracja, schowana.srodowisko);
  schowana.dokument.visibilityState = 'hidden';
  schowana.wywolaj('controllerchange');
  assert.equal(schowana.przeladowania(), 1);

  const pierwsza = atrapaSrodowiska(false);
  podlaczAktualizacje(pierwsza.rejestracja, pierwsza.srodowisko);
  const nowy = atrapaWorkera();
  pierwsza.rejestracja.installing = nowy as unknown as ServiceWorker;
  pierwsza.wywolaj('updatefound');
  nowy.zmienStan('installed');
  assert.deepEqual(nowy.wiadomosci, [], 'bez kontrolera nie ma kogo pomijac');
  pierwsza.wywolaj('controllerchange');
  pierwsza.dokument.visibilityState = 'hidden';
  pierwsza.wywolaj('visibilitychange');
  assert.equal(pierwsza.przeladowania(), 0);
});

test('czekajaca wersja z poprzedniej wizyty dostaje prosbe od razu; sprawdzanie aktualizacji najwyzej raz na godzine', () => {
  const s = atrapaSrodowiska(true);
  const czekajacy = atrapaWorkera('installed');
  s.rejestracja.waiting = czekajacy as unknown as ServiceWorker;
  podlaczAktualizacje(s.rejestracja, s.srodowisko);
  assert.deepEqual(czekajacy.wiadomosci, [WIADOMOSC_POMIN_OCZEKIWANIE]);

  s.dokument.visibilityState = 'visible';
  s.wywolaj('visibilitychange');
  assert.equal(s.aktualizacje(), 0, 'tuz po starcie nie ma sensu sprawdzac');
  s.przesunCzas(ODSTEP_SPRAWDZANIA_AKTUALIZACJI_MS);
  s.wywolaj('visibilitychange');
  assert.equal(s.aktualizacje(), 1);
  s.wywolaj('visibilitychange');
  assert.equal(s.aktualizacje(), 1, 'kolejny powrot w tej samej godzinie nie sprawdza');
});
