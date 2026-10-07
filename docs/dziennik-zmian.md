# Dziennik zmian sesji dopracowania (od 2026-10-01)

Format: data · kto · co · plik(i) · stan weryfikacji. Najnowsze na górze.

- 2026-10-07 · wdrożenie obu Workerów (`hosting:deploy`, `strona:deploy`) na polecenie
  użytkownika; produkcja sprawdzona curlem i w przeglądarce (nagłówki, brak cookies, 400/405/403/501, krypto przez
  `SOL-USD`, pamięć brzegowa, service worker aktywny, CSP strony ze skrótami). Szczegóły: README, sekcja o wersji online.
- 2026-10-07 · dwie poprawki przed wdrożeniem:
  kryptowaluty w API hostingu pytane u Yahoo jako para z dolarem (`SOL-USD`), nie goły symbol akcji
  (`shared/symbolDostawcy.ts`: `KRYPTOWALUTY`, `symbolYahooKrypto`; `apiHostowane.ts`); powłoka PWA tylko pod `/`
  (hosting przekierowuje `/index.html` → `/`), service worker zapisuje czyste kopie bez `redirected`
  (`sw.szablon.js`, `vite.config.ts`). Testy: `serviceWorker.test.ts` ×4, krypto w `apiHostowane`; razem 1042 PASS.
- 2026-10-07 · druga runda po triażu audytu: Worker — wspólne walidatory `shared/walidacjaNotowan.ts`, budżet
  subrequestów (44/50, pominięte instrumenty jawnie w `staleTickers`), biała lista walut NBP, `force` jako świeżość ≤ 5 s,
  limit notowań po chybieniu pamięci, klucz IPv6 /64, `same-site` → 403 (testy ×32); SW — kontrola typu treści, strony
  osobne pod własnym kluczem; PWA — przepływ aktualizacji (`POMIN_OCZEKIWANIE`, jedno odświeżenie przy schowanej karcie,
  `update()` ≤ 1/h); `trybHostingu` bez pętli przeładowań; `marketDataService` — odstęp ≥ 10 s w hostingu i wstrzymanie
  po 429 (`Retry-After`); `czyszczenieDanych.ts` — „Wyczyść wszystko” czyści localStorage/sessionStorage/IndexedDB i
  przeładowuje; rachunki w hostingu bez zapisu kluczy API; tekst 2FA zgodny z prawdą; Express — `same-site` 403,
  `server.cjs` 404, walidacja `quotes.ts`/`nbp.ts`, limity czasu, czyszczenie `%TEMP%` silnika; Vite `server.fs.deny`;
  `security.txt` z kanałem GitHub Security Advisories, `head_sampling_rate: 0.25`, polityka (cookie techniczne
  Cloudflare, próbkowanie, 2FA), `docs/index.html` (guard kotwic, stopka ©), README, `engines.node`. Weryfikacja:
  tsc PASS, 1037 testów PASS, build/perf/strona:build PASS, `wrangler dev` 8788/8787 w przeglądarce (400 walut,
  świeżość `force`, 150× trafień bez 429, SW klucze, CSP strony). Nie wdrożono.
- 2026-10-07 · zabezpieczenie wersji
  online. Worker: walidacja wejścia, `GET`/`HEAD` tylko (405/204), 403 dla `Sec-Fetch-Site: cross-site`, limity per IP
  (`ratelimits` 300/min i 120/min → 429), kanoniczne klucze cache, limit 4 MiB odpowiedzi dostawcy, nagłówki API,
  `try/catch` → 500, `preview_urls: false` (`src/hosting/apiHostowane.ts`, `worker.ts`, `wrangler.jsonc`; testy
  `apiHostowane` ×19). Statyczne: `public/_headers` (CSP `script-src 'self'`, HSTS, nosniff, Permissions-Policy, COOP/CORP,
  cache), `public/.well-known/security.txt`, service worker zapisuje tylko `ok` + `basic` (`sw.szablon.js`). Prawo:
  polityka prywatności `docs/prywatnosc.html` (brak cookies, art. 399 ust. 3 PKE, logi Cloudflare 3 dni, RODO) — w
  wydaniu aplikacji przez wtyczkę w `vite.config.ts`, linki w `PortfelApp.tsx` i `InvestSettingsPanel.tsx`, stopka
  `docs/index.html`. Strona: `zbuduj-strone.mjs` generuje `_headers` z CSP po skrótach SHA-256 skryptów inline i
  `security.txt`. Express: `x-powered-by` off, Permissions-Policy/COOP/CORP, CSP w trybie wydania. Zależności: `xlsx`
  → SheetJS 0.20.3 z cdn.sheetjs.com, `npm audit fix` (express 4.22.3 i spółka), `.github/dependabot.yml`.
  Weryfikacja: lint PASS, 1021 testów PASS, build/perf/strona:build PASS, `wrangler dev` 8788/8787 w przeglądarce:
  nagłówki, 400/405/429, SW, CSP bez naruszeń. Nie wdrożono (decyzja użytkownika). Spec:
  `docs/superpowers/specs/2026-10-07-zabezpieczenie-hostingu-design.md`.

- 2026-10-02 · Codex · publikacja: nowe publiczne repozytorium `Dismonder/InvestAnalyzer-PIT38` z czystą kopią
  źródeł w jednym commicie (bez `STATE.md`, `docs/kontekst-sesji.md` i `docs/archiwum/`; stare prywatne `Dismonder/InvestAnalyzer`
  ma w historii `out/*` z wynikami rozliczenia, dlatego nie nadaje się do upublicznienia), wydanie `v0.2.0` z ZIP-em wersji
  przenośnej i instrukcją instalacji; strona projektu `docs/index.html` przebudowana przez Codex (HTML5, animowane tło,
  odsłanianie sekcji, liczniki, jasny/ciemny motyw, menu mobilne, lightbox `<dialog>`, 48,8 kB, bez zależności zewnętrznych,
  bez wzmianek o STATE.md) i wdrożona `strona:deploy`. Weryfikacja: `assert:no-private-data` i skan poświadczeń na kopii PASS,
  `strona:build` PASS, 1366 px i 375 px bez przepełnień.
- 2026-10-02 · dopracowanie wyglądu na telefonie (S25, 360 px): nagłówki sekcji `h1`/`h2` mniejsze poniżej 640 px
  (reguła poza warstwami Tailwinda w `index.css`), odstępy między kartami 16 px zamiast 24, zakładki alokacji
  (`AllocationCharts.tsx`) przewijane poziomo zamiast łamania w 3 wiersze, przyciski roku/eksportu PIT-38
  (`TaxDashboard.tsx`) i akcje rejestru transakcji (`TransactionHistory.tsx`) w siatce 2 kolumn, filtry pozycji (`HoldingsTable.tsx`) na całą szerokość, karta „Źródło”
  w hostingu zwarta (mały przycisk „Przelicz”) i tylko na portfelu, PIT-38 i rejestrze. Przegląd S25 po zmianach:
  `logs/przeglad-cdp/wyniki-s25-v2`.
- 2026-10-02 · wersja online dostosowana pod telefon (test: Samsung Galaxy S25, 360×780 CSS, DPR 3, dotyk,
  harness `logs/przeglad-cdp/plan-s25.mjs` — 8 ekranów + menu „Więcej”, jasny i ciemny motyw, pomiar przepełnień
  i celów dotykowych): `src/shared/trybHostingu.ts` (rozpoznanie hostingu po `*.workers.dev` albo sondzie `/api/health`);
  w hostingu pozycje portfela liczy przeglądarka — `portfel/services/pozycjeLokalne.ts` (FIFO per ticker+rachunek, koszt
  PLN po NBP T-1 z API hostingu, partie bez kursu liczone jako pominięte; kwoty PIT-38 zostają „nieobliczone”), bo bez
  silnika pulpit był pusty („Brak otwartych pozycji”); panele Freedom24 (inspektor, wiadomości), pasek sesji giełdowych,
  zakładka „Uzbrojone w API Brokera” i zakładka „Dokumenty i silnik” znikają w hostingu; karta informacyjna skrócona
  do dwóch linii z „OK” (zapamiętane w `pit38_hosting_info_ukryta`); przyciski nagłówka ≥ 40 px, przycisk rozwijania
  sesji ≥ 36 px, `MarketStatusBar` z `min-w-0`/`truncate` (na 360 px chevron spadał do drugiego wiersza); `index.css`:
  `height: 100dvh`, `touch-action: manipulation` i bez podświetlenia dotknięcia na ekranach dotykowych.
  Dodatkowo: karta „Źródło” w hostingu mówi „rachunek w przeglądarce” (bez przycisku silnika), rejestr transakcji
  na ekranach < 640 px startuje w widoku kafelków (zapisany wybór ma pierwszeństwo), na ekranach dotykowych każdy
  przycisk ma min. 36 px wysokości (`index.css`, bez przełączników). Testy: `pozycjeLokalne` ×5, `trybHostingu` ×3.
- 2026-10-02 · aplikacja online jako PWA na telefon, bez kosztów (Cloudflare Workers, plan darmowy, bez KV/D1):
  Worker `aplikacje/web/worker.ts` + `src/hosting/apiHostowane.ts` (notowania i historia Yahoo, kursy NBP, wyszukiwarka,
  wykaz; pamięć brzegowa 10/60/300/3600 s; reszta tras 501 `NIEDOSTEPNE_W_HOSTINGU`), `aplikacje/web/wrangler.jsonc`
  (assets `wydania/web`, SPA, `run_worker_first: /api/*`, `.assetsignore` chowa `server.cjs`); PWA: `public/manifest.webmanifest`,
  ikony `public/ikony/` (SVG + PNG 180/192/512 + maskowalna), `sw.szablon.js` → `sw.js` z wtyczki w `vite.config.ts`
  (odcisk wydania + lista paczek; nawigacja network-first, `/assets` cache-first, `/api` bez pamięci), rejestracja
  `src/shared/rejestracjaPwa.ts` (tylko produkcja, https/localhost, nie Tauri), meta w `index.html`; czyste pomocniki
  Yahoo przeniesione do `src/shared/notowaniaYahoo.ts` (reeksport z `routes/quotes.ts`); `src/shared/kodyHostingu.ts`
  i spokojna karta „Wersja na telefon i przeglądarkę” w `PortfelApp.tsx` zamiast czerwonego błędu silnika; skrypty
  `hosting:dev` (8788, konfiguracja `web-hosting`) i `hosting:deploy`; link na stronie projektu i w README.
  Adres: https://investanalyzer-app.dismonder.workers.dev · testy: `apiHostowane` ×9, `rejestracjaPwa` ×2, `kodyHostingu` ×2.
- 2026-10-01 · strona projektu na Cloudflare Workers (statyczne pliki): `aplikacje/strona/wrangler.jsonc`,
  `narzedzia/skrypty/zbuduj-strone.mjs` (do `wydania/strona` trafia tylko index.html, zrzuty i 404), skrypty
  `strona:build`, `strona:dev`, `strona:deploy`; adres https://investanalyzer-strona.dismonder.workers.dev · wrangler 4.145.
- 2026-10-01 · Codex gpt-6.1-sol · GitHub: stare zarchiwizowane repo przemianowane na `InvestAnalyzer-archiwum-2026-08`,
  nowe prywatne `Dismonder/InvestAnalyzer` z `main` (fast-forward z `fuzja/portfel-i-podatki`), opis i tematy;
  README jako wizytówka (recenzja flash: poprawione poz. 49, manifest migracji, redakcja); strona projektu
  `docs/index.html` (GitHub Pages z /docs wymaga planu płatnego albo repo publicznego — opublikowana jako artefakt);
  zrzuty `docs/zrzuty/` z serwera na syntetycznych plikach (`logs/przeglad-cdp/serwer-syntetyczny.mjs`,
  konfiguracja `web-syntetyczny`).
- 2026-10-01 · Codex gpt-6.1-sol · wydanie `InvestAnalyzer-Komputerowa-v0.2.0-20261001-0701`: desktop:portable,
  portable smoke, oba assert, perf:bundle PASS; odcisk `dane/out` identyczny. Bramki lokalne: lint,
  990 testów, build, perf:bundle PASS (464,9 / 2743,5 kB); przegląd flash reguły rachunków bez zastrzeżeń.
- 2026-10-01 · decyzje długoterminowe: filtry demo nie kasują danych po rodzinie id; `engineBridge`
  zostaje ładowany po starcie; progi perf:bundle 500/2900; Codex tylko `gpt-6.1-sol` (aliasy w AgentTools) ·
  STATE.md, memory, globalne instrukcje.
- 2026-10-01 · Codex gpt-6.1-sol · filtry demo chronią dane użytkownika: transakcje odsiewane tylko po
  własnym id, rachunki o dawnym id demo zachowane z kluczem, numerem lub oczyszczoną transakcją;
  odczyt transakcji przed rachunkami i stabilny filtr synchronizacji z aktualną listą transakcji ·
  `aplikacje/web/src/portfel/services/rachunkiBrokera.ts`, `transakcjePortfela.ts`, `PortfelApp.tsx`,
  `jakosc/testy/frontend/rachunkiBrokera.test.ts`, `transakcjePortfela.test.ts` · RED→GREEN (3 regresje,
  8 testów PASS), lint PASS, 990 testów PASS, build PASS.
- 2026-10-01 · Codex gpt-6.1-sol · budżet początkowego JS 560→500 kB chroni start przed wyciekiem
  zależności; łączny 2750→2900 kB uwzględnia rozwój modułów kwarantanny i ponowień;
  wyszukanie `2750` nie wykazało drugiej definicji limitu · `narzedzia/skrypty/perf-bundle.mjs` ·
  perf:bundle PASS (początkowy 464,9 kB, łączny 2743,5 kB). Build i pomiar wykonane w kopii roboczej
  poza projektem, aby nie zmieniać jego `wydania/`; bez commita i zmian w `dane/`.
- 2026-10-01 · Codex sol (gpt-6.1-sol) · wydanie `InvestAnalyzer-Komputerowa-v0.2.0-20261001-0642`: desktop:portable PASS
  (161 s), portable smoke PASS, assert:no-retired-integrations PASS, odcisk `dane/out` przed/po identyczny.
  assert:no-private-data FAIL przez ścieżkę profilu w `docs/kontekst-sesji.md` → ścieżkę usunięto, bramka PASS.
- 2026-10-01 · pomocnik ponawia pod adresem z dopiskiem `?ponow=<czas>` (Chrome pamięta nieudane
  pobranie modułu i ten sam adres odrzuca bez sieci — potwierdzone CDP: E2 odrzuca, E3 z dopiskiem ładuje);
  API `leniwyZPonowieniem(importer, wybierz)` z przeciążeniami, 23 miejsca użycia przepisane ·
  `shared/leniwyZPonowieniem.tsx`, PortfelApp, invest_analyzer/App, PortfolioDashboard, RealTimeCharts,
  BottomNavbar, test pomocnika (3) · lint PASS, 987 testów PASS, build PASS, perf:bundle PASS
  (initial 464,7 kB, łączny 2743,4 kB); CDP: P3a okno Ulubione otwiera się po przywróceniu serwera,
  P3b zakładka Alerty wraca bez odświeżenia.
- 2026-10-01 · po przeglądzie flash: opłata `FEE` z importu CSV ma pusty symbol — filtr ją przepuszcza ·
  `services/transakcjePortfela.ts`, test · 3 testy PASS; CDP: opłata zostaje w magazynie.
- 2026-10-01 · CDP P1/P2: zgoda bez kopii (odmowa nic nie usuwa, zgoda czyści i przeładowuje),
  panel kwarantanny w Ustawieniach → Dane (lista, brak sekretu na ekranie, „Usuń wszystkie”, 375 px bez
  przepełnienia) · zrzuty `logs/dopracowanie-*.jpg`, harness `logs/przeglad-cdp/`.
- 2026-10-01 · Codex sol · walidacja transakcji i rachunków przy odczycie oraz synchronizacji magazynu;
  uszkodzone wpisy nie wywracają powłoki, a filtry demo działają jak dotąd ·
  `aplikacje/web/src/portfel/PortfelApp.tsx`, `aplikacje/web/src/portfel/services/transakcjePortfela.ts`,
  `aplikacje/web/src/portfel/services/rachunkiBrokera.ts`, `jakosc/testy/frontend/transakcjePortfela.test.ts`,
  `jakosc/testy/frontend/rachunkiBrokera.test.ts` · testy RED→GREEN, lint PASS, 986 testów PASS.
- 2026-10-01 · Codex sol · odciążenie pakietu startowego: lekkie stałe rachunku i katalog instrumentów
  pobierany po otwarciu widoku z ochroną przed spóźnioną odpowiedzią ·
  `aplikacje/web/src/portfel/components/PortfolioDashboard.tsx`,
  `aplikacje/web/src/portfel/components/portfolio/HoldingsTable.tsx`,
  `aplikacje/web/src/portfel/components/StockSearchCatalog.tsx`,
  `aplikacje/web/src/portfel/components/ManageFavoritesModal.tsx` · lint PASS, 986 testów PASS.
- 2026-10-01 · `ErrorBoundary.componentDidCatch` woła `zwolnijOdrzuconeLeniwe()` — odrzucone
  okno/zakładka pobierane od nowa dopiero po przyjęciu błędu przez granicę ·
  `invest_analyzer/components/ErrorBoundary.tsx` · test pomocnika PASS, lint PASS; przeglądarka — do powtórzenia.
- 2026-10-01 · pomocnik `leniwyZPonowieniem` zamiast `React.lazy` (13 okien/zakładek w PortfelApp,
  6 w invest_analyzer/App, okna opcji w PortfolioDashboard i RealTimeCharts, MoreNavMenu) ·
  `shared/leniwyZPonowieniem.tsx`, `jakosc/testy/frontend/leniwyZPonowieniem.test.ts` · 981 testów PASS,
  build PASS, perf:bundle PASS (initial 464,0 kB, łączny 2742,8 kB).
- 2026-10-01 · sonda CDP: zepsuta transakcja wywraca powłokę (do naprawy, zob. kontekst-sesji.md);
  `engineBridge` i `brokerAssetsDatabase` nadal ładowane na starcie (do naprawy).
- 2026-09-30 (poprzednia sesja, niezacommitowane) · zgoda bez kopii w panelu błędu, panel kwarantanny,
  `oczyscZlecenia`, `pozycjaRachunku.ts` jako lekki moduł stałych, leniwy katalog instrumentów,
  `viewport-fit=cover` · testy 979 PASS.
