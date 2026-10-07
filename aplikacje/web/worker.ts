/**
 * Worker Cloudflare dla hostowanej wersji aplikacji (plan darmowy: pliki statyczne
 * z `wydania/web` i lekkie API notowan bez zadnych platnych uslug).
 *
 * `/api/*` obsluguje `apiHostowane` (notowania Yahoo, kursy NBP, wyszukiwarka) z
 * limitami zadan per adres IP (bindingi `ratelimits` z wrangler.jsonc - darmowe);
 * reszta tras idzie do plikow statycznych z zapasem `index.html` dla aplikacji
 * jednostronicowej (ustawienie `not_found_handling` w wrangler.jsonc). Naglowki
 * bezpieczenstwa plikow statycznych (CSP, HSTS, nosniff...) podaje `public/_headers`;
 * odpowiedzi API dostaja swoje w `apiHostowane`.
 */
import { obsluzApiHostowane, type OgranicznikZadan } from './src/hosting/apiHostowane';

/** Binding Rate Limiting API Workers (https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/). */
interface BindingLimitu {
  limit(opcje: { key: string }): Promise<{ success: boolean }>;
}

interface Env {
  ASSETS: { fetch(request: Request): Promise<Response> };
  /** Limit dla calego /api (300/min per IP); brak bindingu = bez limitu (np. testy). */
  LIMIT_API?: BindingLimitu;
  /** Limit dla tras odpytujacych Yahoo (120/min per IP). */
  LIMIT_NOTOWAN?: BindingLimitu;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
      return obsluzApiHostowane(request, {
        fetch: globalThis.fetch.bind(globalThis),
        cache: pamiecBrzegowa(),
        ip: request.headers.get('CF-Connecting-IP') ?? undefined,
        limity: { api: ogranicznik(env.LIMIT_API), notowania: ogranicznik(env.LIMIT_NOTOWAN) },
      });
    }
    return env.ASSETS.fetch(request);
  },
};

/** Pamiec podreczna brzegu (Cache API) - jest w Workerze i `wrangler dev`, nie ma jej w testach. */
function pamiecBrzegowa(): Cache | undefined {
  const magazyn = (globalThis as { caches?: { default?: Cache } }).caches;
  return magazyn?.default;
}

/** Binding limitu jako czysta funkcja; brak bindingu (stary wrangler, testy) = bez limitu. */
function ogranicznik(binding: BindingLimitu | undefined): OgranicznikZadan | undefined {
  if (!binding) return undefined;
  return async (klucz) => (await binding.limit({ key: klucz })).success;
}
