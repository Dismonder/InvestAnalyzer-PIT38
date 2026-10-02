/* Service worker aplikacji InvestAnalyzer (PWA).
 *
 * Plik jest szablonem: wtyczka w vite.config.ts podstawia znaczniki WERSJA (odcisk
 * wydania) i PLIKI (lista plikow z wydania) i zapisuje go jako /sw.js.
 *
 * Zasady:
 *  - /api/* i zadania inne niz GET ida prosto do sieci; notowan ani danych nigdy
 *    nie trzymamy w pamieci service workera (dane uzytkownika sa w localStorage
 *    i IndexedDB, nie tutaj).
 *  - nawigacja: najpierw siec, bez sieci zapasowy index.html z pamieci;
 *  - /assets/* (nazwy z odciskiem): najpierw pamiec, brak -> siec i zapis;
 *  - reszta plikow z tej samej domeny: pamiec, a w tle odswiezenie.
 */
const WERSJA = '__WERSJA__';
const PAMIEC = `investanalyzer-${WERSJA}`;
const PLIKI = __PLIKI__;

self.addEventListener('install', (zdarzenie) => {
  zdarzenie.waitUntil((async () => {
    const pamiec = await caches.open(PAMIEC);
    // Pojedynczy brak pliku nie moze zablokowac instalacji calosci.
    await Promise.allSettled(PLIKI.map((plik) => pamiec.add(new Request(plik, { cache: 'reload' }))));
  })());
});

self.addEventListener('activate', (zdarzenie) => {
  zdarzenie.waitUntil((async () => {
    const nazwy = await caches.keys();
    await Promise.all(nazwy.filter((nazwa) => nazwa.startsWith('investanalyzer-') && nazwa !== PAMIEC).map((nazwa) => caches.delete(nazwa)));
    await self.clients.claim();
  })());
});

self.addEventListener('message', (zdarzenie) => {
  if (zdarzenie.data && zdarzenie.data.typ === 'POMIN_OCZEKIWANIE') self.skipWaiting();
});

self.addEventListener('fetch', (zdarzenie) => {
  const zadanie = zdarzenie.request;
  if (zadanie.method !== 'GET') return;
  const adres = new URL(zadanie.url);
  if (adres.origin !== self.location.origin) return;
  if (adres.pathname === '/api' || adres.pathname.startsWith('/api/')) return;

  if (zadanie.mode === 'navigate') {
    zdarzenie.respondWith(nawigacja(zadanie));
    return;
  }
  if (adres.pathname.startsWith('/assets/')) {
    zdarzenie.respondWith(najpierwPamiec(zadanie));
    return;
  }
  zdarzenie.respondWith(pamiecIOdswiezenie(zadanie));
});

async function nawigacja(zadanie) {
  try {
    const zSieci = await fetch(zadanie);
    if (zSieci.ok) {
      const pamiec = await caches.open(PAMIEC);
      pamiec.put('/index.html', zSieci.clone()).catch(() => {});
    }
    return zSieci;
  } catch {
    const pamiec = await caches.open(PAMIEC);
    const zapas = (await pamiec.match('/index.html')) || (await pamiec.match('/'));
    return zapas || new Response('Brak połączenia i brak zapisanej kopii aplikacji.', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  }
}

async function najpierwPamiec(zadanie) {
  const pamiec = await caches.open(PAMIEC);
  const zPamieci = await pamiec.match(zadanie);
  if (zPamieci) return zPamieci;
  const zSieci = await fetch(zadanie);
  if (zSieci.ok) pamiec.put(zadanie, zSieci.clone()).catch(() => {});
  return zSieci;
}

async function pamiecIOdswiezenie(zadanie) {
  const pamiec = await caches.open(PAMIEC);
  const zPamieci = await pamiec.match(zadanie);
  const odswiezenie = fetch(zadanie).then((zSieci) => {
    if (zSieci.ok) pamiec.put(zadanie, zSieci.clone()).catch(() => {});
    return zSieci;
  }).catch(() => null);
  if (zPamieci) return zPamieci;
  const zSieci = await odswiezenie;
  return zSieci || new Response('', { status: 504 });
}
