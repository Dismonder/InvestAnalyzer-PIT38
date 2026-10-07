# Zabezpieczenie wersji online (hosting Cloudflare, strona projektu, serwer lokalny) — projekt 2026-10-07

Polecenie użytkownika: „zabezpiecz wszystko, co jest na stronie: cookies i prawo, hakerzy, luki — napraw to wszystko”.
Praca autonomiczna (bez pytań w trakcie); założenia poniżej są jawne i odwracalne.

## Zakres i założenia

* **W zakresie:** Worker `investanalyzer-app` (PWA + `/api/*`), Worker `investanalyzer-strona` (strona projektu),
  service worker, front w przeglądarce, lokalny serwer Express (ten sam front na `127.0.0.1`), zależności npm,
  polityka prywatności i informacja o przechowywaniu danych w urządzeniu (RODO + art. 399 PKE), higiena repozytorium.
* **Poza zakresem:** wersja desktop (Tauri ma własny CSP), integracje brokerów (w hostingu ukryte), własna domena.
* **Założenia:** plan darmowy Cloudflare bez płatnych usług (żadnego KV/D1/R2); brak logowania — aplikacja nie
  przetwarza danych na serwerze; administratorem danych jest autor („Dismonder”), bez publikowania adresu e-mail
  (użytkownik dopisze kontakt sam); brak zgody na cookies nie jest potrzebny, bo nie ma cookies, a localStorage
  służy wyłącznie świadczeniu usługi żądanej przez użytkownika (wyjątek z art. 399 ust. 3 PKE) — wystarczy jasna
  informacja w polityce.

## Rozwiązanie (warstwy)

1. **Worker `/api/*`** (`src/hosting/apiHostowane.ts`, `worker.ts`): ścisła walidacja wejścia (ticker, `q`,
   `currency`, `date`, `range`, `interval`, długość URL), metody tylko `GET`/`HEAD` (`OPTIONS` → 204, inne → 405),
   odmowa żądań `Sec-Fetch-Site: cross-site` (obce strony nie użyją proxy przez przeglądarkę), limity żądań per IP
   przez binding `ratelimits` (GA, darmowy): notowania 120/min, całość API 300/min → 429 z `Retry-After`,
   kanoniczne klucze pamięci brzegowej (tylko znane parametry, posortowane) — koniec zatruwania i omijania cache
   śmieciowymi parametrami, limit rozmiaru odpowiedzi dostawcy (4 MiB), nagłówki bezpieczeństwa na każdej
   odpowiedzi API, `try/catch` na szczycie z neutralnym 500. `preview_urls: false` (stare wersje nie są publiczne).
2. **Pliki statyczne** (`public/_headers`, obsługiwane przez Workers Static Assets): CSP bez `unsafe-eval`
   (`script-src 'self'`, `connect-src 'self'`, `frame-ancestors 'none'`), HSTS, `nosniff`, `Referrer-Policy`,
   `Permissions-Policy`, COOP/CORP, `Cache-Control` dla `sw.js`/`index.html` (bez trwałego cache) i `assets/*`
   (immutable). `security.txt`. Service worker zapisuje tylko odpowiedzi `ok` i `type: basic`.
3. **Strona projektu** (`narzedzia/skrypty/zbuduj-strone.mjs`): `_headers` z CSP, w której skrypty inline są
   dopuszczone po skrócie SHA-256 liczonym przy budowie (zero `unsafe-inline` dla skryptów), te same nagłówki co w
   aplikacji, `security.txt`, strona polityki prywatności i link w stopce.
4. **Polityka prywatności** (`docs/prywatnosc.html`, jedno źródło): publikowana w obu Workerach
   (wtyczka Vite kopiuje do wydania aplikacji, skrypt strony kopiuje do wydania strony); link z karty „Wersja na
   telefon” i z Ustawień → Dane oraz ze stopki strony projektu.
5. **Serwer lokalny Express:** `x-powered-by` wyłączone, CSP i `Permissions-Policy`/COOP na HTML (łagodniejsza
   `connect-src`, bo lokalnie front może rozmawiać z brokerami), reszta nagłówków już była.
6. **Zależności:** `npm audit fix` (express/qs/body-parser/proxy-addr/source-map-js), `xlsx` z oficjalnego
   wydania SheetJS 0.20.x (npm ma tylko 0.18.5 z dwiema podatnościami), Dependabot (`.github/dependabot.yml`).
   `wrangler`/`miniflare`/`sharp` — tylko narzędzie deweloperskie, nie trafia do Workera; zostaje (naprawa = downgrade).

## Weryfikacja

`npm run lint`, `npm test` (nowe testy: walidacja, 405/403/429, klucze cache, nagłówki, limit rozmiaru,
service worker), `npm run build`, `npm run perf:bundle`, `wrangler dev` w przeglądarce: nagłówki na `/`, `/sw.js`,
`/assets/*`, `/api/*`; konsola bez naruszeń CSP po przejściu ekranów; `strona:build` + skrót CSP zgodny ze skryptami.
