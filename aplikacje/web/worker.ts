/**
 * Worker Cloudflare dla hostowanej wersji aplikacji (plan darmowy: pliki statyczne
 * z `wydania/web` i lekkie API notowan bez zadnych platnych uslug).
 *
 * `/api/*` obsluguje `apiHostowane` (notowania Yahoo, kursy NBP, wyszukiwarka);
 * reszta tras idzie do plikow statycznych z zapasem `index.html` dla aplikacji
 * jednostronicowej (ustawienie `not_found_handling` w wrangler.jsonc).
 */
import { obsluzApiHostowane } from './src/hosting/apiHostowane';

interface Env {
  ASSETS: { fetch(request: Request): Promise<Response> };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
      return obsluzApiHostowane(request, { fetch: globalThis.fetch.bind(globalThis), cache: pamiecBrzegowa() });
    }
    return env.ASSETS.fetch(request);
  },
};

/** Pamiec podreczna brzegu (Cache API) - jest w Workerze i `wrangler dev`, nie ma jej w testach. */
function pamiecBrzegowa(): Cache | undefined {
  const magazyn = (globalThis as { caches?: { default?: Cache } }).caches;
  return magazyn?.default;
}
