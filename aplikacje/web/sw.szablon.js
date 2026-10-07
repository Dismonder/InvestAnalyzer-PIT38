/* Service worker aplikacji InvestAnalyzer (PWA).
 *
 * Plik jest szablonem: wtyczka w vite.config.ts podstawia znaczniki WERSJA (odcisk
 * wydania) i PLIKI (lista plikow z wydania) i zapisuje go jako /sw.js.
 *
 * Zasady:
 *  - do pamieci trafiaja tylko odpowiedzi 200 z tego samego originu (type 'basic')
 *    o oczekiwanym typie tresci: zapas SPA (index.html oddawany przez hosting za
 *    brakujacy plik) nigdy nie zastepuje paczki JS/CSS ani ikony;
 *  - zapisywana jest czysta kopia odpowiedzi (bez znacznika `redirected`): hosting
 *    odpowiada na `/index.html` przekierowaniem na `/`, a przekierowana odpowiedz
 *    oddana nawigacji konczy sie bledem sieci zamiast startem bez sieci;
 *  - /api/* i zadania inne niz GET ida prosto do sieci; notowan ani danych nigdy
 *    nie trzymamy w pamieci service workera (dane uzytkownika sa w localStorage
 *    i IndexedDB, nie tutaj);
 *  - nawigacja: najpierw siec, bez sieci zapasowa powloka spod klucza `/`; strony
 *    osobne (polityka prywatnosci) maja wlasny wpis i nie nadpisuja powloki;
 *  - /assets/* (nazwy z odciskiem): najpierw pamiec, brak -> siec i zapis;
 *  - reszta plikow z tej samej domeny: pamiec, a w tle odswiezenie.
 */
const WERSJA = '__WERSJA__';
const PAMIEC = `investanalyzer-${WERSJA}`;
const PLIKI = __PLIKI__;

/** Klucz powloki aplikacji (kazda trasa SPA oddaje ten sam dokument). */
const KLUCZ_POWLOKI = '/';
/** Strony HTML, ktore nie sa powloka aplikacji (maja wlasny wpis w pamieci). */
const STRONY_OSOBNE = ['/prywatnosc', '/prywatnosc.html'];

/** Tylko wlasna, udana odpowiedz nadaje sie do pamieci. */
const doPamieci = (odpowiedz) => Boolean(odpowiedz) && odpowiedz.ok && odpowiedz.type === 'basic';
const typTresci = (odpowiedz) => (odpowiedz.headers.get('content-type') || '').toLowerCase();
const toHtml = (odpowiedz) => typTresci(odpowiedz).startsWith('text/html');
/** Kopia odpowiedzi do pamieci: ta sama tresc i naglowki, bez `redirected` i `url` przekierowania. */
const czystaKopia = (odpowiedz) => new Response(odpowiedz.clone().body, { status: odpowiedz.status, statusText: odpowiedz.statusText, headers: odpowiedz.headers });

self.addEventListener('install', (zdarzenie) => {
  zdarzenie.waitUntil((async () => {
    const pamiec = await caches.open(PAMIEC);
    // Pojedynczy brak pliku nie moze zablokowac instalacji calosci.
    await Promise.allSettled(PLIKI.map(async (plik) => {
      const odpowiedz = await fetch(new Request(new URL(plik, self.location.origin), { cache: 'reload' }));
      if (!doPamieci(odpowiedz)) return;
      await pamiec.put(plik, czystaKopia(odpowiedz));
    }));
  })());
});

self.addEventListener('activate', (zdarzenie) => {
  zdarzenie.waitUntil((async () => {
    const nazwy = await caches.keys();
    await Promise.all(nazwy.filter((nazwa) => nazwa.startsWith('investanalyzer-') && nazwa !== PAMIEC).map((nazwa) => caches.delete(nazwa)));
    await self.clients.claim();
  })());
});

// Rejestracja (shared/rejestracjaPwa.ts) prosi nowa wersje o przejecie od razu,
// zeby poprawki (takze bezpieczenstwa) nie czekaly na zamkniecie wszystkich kart.
// Wiadomosci przychodza tylko od okien tego samego originu.
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
    zdarzenie.respondWith(nawigacja(zadanie, adres));
    return;
  }
  if (adres.pathname.startsWith('/assets/')) {
    zdarzenie.respondWith(najpierwPamiec(zadanie));
    return;
  }
  zdarzenie.respondWith(pamiecIOdswiezenie(zadanie));
});

async function nawigacja(zadanie, adres) {
  const osobna = STRONY_OSOBNE.includes(adres.pathname);
  try {
    const zSieci = await fetch(zadanie);
    if (doPamieci(zSieci) && toHtml(zSieci)) {
      const pamiec = await caches.open(PAMIEC);
      // Powloka SPA pod jednym kluczem; strona osobna pod wlasnym adresem,
      // zeby nie podmienic powloki.
      pamiec.put(osobna ? adres.pathname : KLUCZ_POWLOKI, czystaKopia(zSieci)).catch(() => {});
    }
    return zSieci;
  } catch {
    const pamiec = await caches.open(PAMIEC);
    const zapas = await pamiec.match(osobna ? adres.pathname : KLUCZ_POWLOKI);
    return zapas || new Response('Brak połączenia i brak zapisanej kopii aplikacji.', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  }
}

async function najpierwPamiec(zadanie) {
  const pamiec = await caches.open(PAMIEC);
  const zPamieci = await pamiec.match(zadanie);
  if (zPamieci) return zPamieci;
  const zSieci = await fetch(zadanie);
  // Paczka wydania nigdy nie jest HTML - taka odpowiedz to zapas SPA za brakujacy plik.
  if (doPamieci(zSieci) && !toHtml(zSieci)) pamiec.put(zadanie, czystaKopia(zSieci)).catch(() => {});
  return zSieci;
}

async function pamiecIOdswiezenie(zadanie) {
  const pamiec = await caches.open(PAMIEC);
  const zPamieci = await pamiec.match(zadanie);
  const odswiezenie = fetch(zadanie).then((zSieci) => {
    if (doPamieci(zSieci) && !toHtml(zSieci)) pamiec.put(zadanie, czystaKopia(zSieci)).catch(() => {});
    return zSieci;
  }).catch(() => null);
  if (zPamieci) return zPamieci;
  const zSieci = await odswiezenie;
  return zSieci || new Response('', { status: 504 });
}
