/**
 * Service worker PWA (aplikacje/web/sw.szablon.js) uruchomiony w atrapie srodowiska:
 * powloka pod kluczem `/` bez znacznika przekierowania, zapas SPA nie podmienia
 * paczek, nawigacja bez sieci dostaje powloke, wiadomosc POMIN_OCZEKIWANIE dziala.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const ORIGIN = 'https://app.example';
const SZABLON = readFileSync(path.resolve('aplikacje/web/sw.szablon.js'), 'utf8');

type Nasluch = (zdarzenie: any) => void;

function kluczUrl(wejscie: unknown): string {
  if (typeof wejscie === 'string') return new URL(wejscie, ORIGIN).href;
  if (wejscie instanceof URL) return wejscie.href;
  return new URL((wejscie as { url: string }).url, ORIGIN).href;
}

function atrapaCaches() {
  const magazyny = new Map<string, Map<string, Response>>();
  const open = async (nazwa: string) => {
    if (!magazyny.has(nazwa)) magazyny.set(nazwa, new Map());
    const m = magazyny.get(nazwa)!;
    return {
      match: async (klucz: unknown) => m.get(kluczUrl(klucz))?.clone(),
      put: async (klucz: unknown, odpowiedz: Response) => { m.set(kluczUrl(klucz), odpowiedz); },
      keys: async () => [...m.keys()],
    };
  };
  return {
    caches: { open, keys: async () => [...magazyny.keys()], delete: async (n: string) => magazyny.delete(n) },
    magazyny,
  };
}

const html = (tresc: string, init: ResponseInit = {}) =>
  new Response(tresc, { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' }, ...init });
const js = (tresc: string) => new Response(tresc, { status: 200, headers: { 'Content-Type': 'text/javascript' } });
/** Odpowiedz, ktora przeszla przez przekierowanie (jak `/index.html` -> `/` w hostingu). */
function przekierowana(odpowiedz: Response): Response {
  Object.defineProperty(odpowiedz, 'redirected', { value: true });
  Object.defineProperty(odpowiedz, 'type', { value: 'basic' });
  return odpowiedz;
}
function podstawowa(odpowiedz: Response): Response {
  Object.defineProperty(odpowiedz, 'type', { value: 'basic' });
  return odpowiedz;
}

function uruchomServiceWorker(fetchFn: (wejscie: unknown) => Promise<Response>, pliki: string[]) {
  const nasluchy: Record<string, Nasluch[]> = {};
  let pominieto = 0;
  const self = {
    addEventListener: (typ: string, f: Nasluch) => { (nasluchy[typ] ??= []).push(f); },
    location: { origin: ORIGIN },
    clients: { claim: async () => undefined },
    skipWaiting: () => { pominieto++; },
  };
  const { caches, magazyny } = atrapaCaches();
  const zrodlo = SZABLON.replaceAll('__WERSJA__', 'test').replaceAll('__PLIKI__', JSON.stringify(pliki));
  new Function('self', 'caches', 'fetch', zrodlo)(self, caches, fetchFn);
  const wyslij = async (typ: string, zdarzenie: Record<string, unknown>) => {
    let oczekiwanie: Promise<unknown> | undefined;
    let odpowiedz: Promise<Response> | undefined;
    for (const f of nasluchy[typ] ?? []) {
      f({ ...zdarzenie, waitUntil: (p: Promise<unknown>) => { oczekiwanie = p; }, respondWith: (p: Promise<Response>) => { odpowiedz = p; } });
    }
    await oczekiwanie;
    return odpowiedz ? await odpowiedz : undefined;
  };
  const nawigacja = (sciezka: string) => wyslij('fetch', { request: { method: 'GET', url: `${ORIGIN}${sciezka}`, mode: 'navigate' } });
  const zasob = (sciezka: string) => wyslij('fetch', { request: { method: 'GET', url: `${ORIGIN}${sciezka}`, mode: 'no-cors' } });
  const pamiec = () => magazyny.get('investanalyzer-test') ?? new Map<string, Response>();
  return { wyslij, nawigacja, zasob, pamiec, pominieto: () => pominieto };
}

test('instalacja: powloka pod `/` zapisana jako czysta kopia (bez redirected), brakujacy plik pomijany bez bledu', async () => {
  const sw = uruchomServiceWorker(async (wejscie) => {
    const sciezka = new URL(kluczUrl(wejscie)).pathname;
    if (sciezka === '/') return przekierowana(html('<div id="root"></div>'));
    if (sciezka === '/motyw.js') return podstawowa(js('/*motyw*/'));
    return podstawowa(new Response('nie ma', { status: 404 }));
  }, ['/', '/motyw.js', '/ikony/brak.png']);
  await sw.wyslij('install', {});
  const pamiec = sw.pamiec();
  assert.deepEqual([...pamiec.keys()].sort(), [`${ORIGIN}/`, `${ORIGIN}/motyw.js`]);
  const powloka = pamiec.get(`${ORIGIN}/`)!;
  assert.equal(powloka.redirected, false, 'kopia bez znacznika przekierowania nadaje sie na zapas nawigacji');
  assert.equal(await powloka.clone().text(), '<div id="root"></div>');
});

test('nawigacja bez sieci dostaje powloke spod `/`; trasa SPA online zapisuje powloke pod `/`, strona osobna pod soba', async () => {
  let online = true;
  const sw = uruchomServiceWorker(async (wejscie) => {
    if (!online) throw new TypeError('Failed to fetch');
    const sciezka = new URL(kluczUrl(wejscie)).pathname;
    if (sciezka === '/prywatnosc') return podstawowa(html('<h1>Prywatność</h1>'));
    return podstawowa(html(`<div id="root" data-trasa="${sciezka}"></div>`));
  }, ['/']);
  await sw.wyslij('install', {});
  await sw.nawigacja('/portfel');
  await sw.nawigacja('/prywatnosc');
  assert.deepEqual([...sw.pamiec().keys()].sort(), [`${ORIGIN}/`, `${ORIGIN}/prywatnosc`], 'trasa /portfel nie tworzy wlasnego wpisu');
  assert.match(await sw.pamiec().get(`${ORIGIN}/`)!.clone().text(), /data-trasa="\/portfel"/, 'powloka odswiezona z ostatniej nawigacji');

  online = false;
  const bezSieci = await sw.nawigacja('/pit38');
  assert.equal(bezSieci!.status, 200);
  assert.match(await bezSieci!.text(), /id="root"/);
  const polityka = await sw.nawigacja('/prywatnosc');
  assert.match(await polityka!.text(), /Prywatność/);
  const nieznana = await sw.nawigacja('/nieznana-strona-osobna.html');
  assert.equal(nieznana!.status, 200, 'kazda inna nawigacja dostaje powloke SPA');
});

test('zapas SPA (HTML) za brakujaca paczke nie trafia do pamieci pod /assets/*; prawdziwa paczka tak', async () => {
  const sw = uruchomServiceWorker(async (wejscie) => {
    const sciezka = new URL(kluczUrl(wejscie)).pathname;
    if (sciezka === '/assets/stary-hash.js') return podstawowa(html('<div id="root"></div>'));
    if (sciezka === '/assets/nowy-hash.js') return podstawowa(js('export {}'));
    return podstawowa(new Response('', { status: 404 }));
  }, []);
  await sw.wyslij('install', {});
  const zapas = await sw.zasob('/assets/stary-hash.js');
  assert.equal(zapas!.status, 200, 'odpowiedz sieci wraca do przegladarki bez zmian');
  const paczka = await sw.zasob('/assets/nowy-hash.js');
  assert.equal(await paczka!.text(), 'export {}');
  assert.deepEqual([...sw.pamiec().keys()], [`${ORIGIN}/assets/nowy-hash.js`], 'HTML nie zostal zapamietany jako paczka');
});

test('zadania /api i inne niz GET nie sa przechwytywane; POMIN_OCZEKIWANIE wywoluje skipWaiting', async () => {
  let wywolan = 0;
  const sw = uruchomServiceWorker(async () => { wywolan++; return podstawowa(js('')); }, []);
  assert.equal(await sw.wyslij('fetch', { request: { method: 'GET', url: `${ORIGIN}/api/quotes?tickers=NBIS`, mode: 'cors' } }), undefined);
  assert.equal(await sw.wyslij('fetch', { request: { method: 'POST', url: `${ORIGIN}/cokolwiek`, mode: 'cors' } }), undefined);
  assert.equal(await sw.wyslij('fetch', { request: { method: 'GET', url: 'https://obca.example/x.js', mode: 'no-cors' } }), undefined);
  assert.equal(wywolan, 0);
  await sw.wyslij('message', { data: { typ: 'POMIN_OCZEKIWANIE' } });
  await sw.wyslij('message', { data: { typ: 'INNE' } });
  assert.equal(sw.pominieto(), 1);
});
