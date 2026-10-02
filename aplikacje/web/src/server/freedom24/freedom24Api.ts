import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/** Only commands that cannot alter a Freedom24 account are reachable here. */
export const FREEDOM24_READ_ONLY_COMMANDS = new Set([
  'getOPQ',
  'getPositionJson',
  'getTradesHistory',
  'getNotifyOrderJson',
  'getUserCashFlows',
  'getBrokerReport',
  'getDepositaryReport',
  'getSecurityInfo',
  'getMarketStatus',
  // Dane rynkowe: depesze i ranking sesji. Nie dotycza rachunku i niczego nie zmieniaja.
  'getNewsList',
  'getTopSecurities',
  // Dokumentowane odczyty historii, dyspozycji, list i danych rynkowych.
  'getOrdersHistory',
  'getClientCpsHistory',
  'getCpsFiles',
  'getUserStockLists',
  'getOptionsByMktNameAndBaseAsset',
  'getHloc',
]);

/** Jedyne polecenia zmieniajace cokolwiek u brokera: SL/TP na posiadanej pozycji i anulowanie zlecenia. */
export const FREEDOM24_PROTECTIVE_COMMANDS = new Set(['putStopLoss', 'delTradeOrder']);

export type Freedom24SafeError = {
  status?: number;
  brokerCode?: string | number;
  command: string;
  retryable: boolean;
  ambiguous?: boolean;
  message: string;
};

export type Freedom24Result<T> = { ok: true; data: T; status: number } | { ok: false; error: Freedom24SafeError };

type Credentials = { publicKey: string; privateKey: string };

/**
 * The default is deliberately a local, ignored directory.  The two legacy
 * names are accepted only to let existing Windows installs migrate without
 * copying a secret through a browser or an environment variable.
 */
export class Freedom24Credentials {
  static directory(): string {
    return process.env.FREEDOM24_CREDENTIALS_DIR || path.resolve(process.cwd(), 'dane', 'API');
  }

  static configured(directory = this.directory()): boolean {
    return this.findPair(directory) !== null;
  }

  static load(directory = this.directory()): Credentials | null {
    const pair = this.findPair(directory);
    if (!pair) return null;
    try {
      const publicKey = fs.readFileSync(pair.publicPath, 'utf8').trim();
      const privateKey = fs.readFileSync(pair.privatePath, 'utf8').trim();
      return publicKey && privateKey ? { publicKey, privateKey } : null;
    } catch {
      return null;
    }
  }

  private static findPair(directory: string): { publicPath: string; privatePath: string } | null {
    const candidates: Array<[string, string]> = [
      ['public', 'private'],
      ['public key.txt', 'private key.txt'],
    ];
    for (const [publicName, privateName] of candidates) {
      const publicPath = path.join(directory, publicName);
      const privatePath = path.join(directory, privateName);
      if (fs.existsSync(publicPath) && fs.existsSync(privatePath)) return { publicPath, privatePath };
    }
    return null;
  }
}

/** Compact, recursively sorted JSON: the exact string is both sent and signed. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

export class Freedom24Signer {
  constructor(private readonly privateKey: string) {}

  sign(payload: string, timestamp: string): string {
    return crypto.createHmac('sha256', this.privateKey).update(payload + timestamp).digest('hex');
  }
}

const SECRET_FIELD = /(authorization|api[-_]?key|token|secret|signature|sig|private.?key|cookie)/i;
export function sanitizeFreedom24Text(value: unknown, fallback = 'Błąd komunikacji z Freedom24.'): string {
  const source = typeof value === 'string' ? value : String(value ?? '');
  if (!source.trim()) return fallback;
  return source
    .replace(/(["']?[-\w]*(?:authorization|api[-_]?key|token|secret|signature|sig|private.?key|cookie)[-\w]*["']?\s*[:=]\s*)[^,\s}"']+/gi, '$1[redacted]')
    .replace(/\b[A-Za-z0-9_-]{24,}\b/g, '[redacted]')
    // Broker potrafi odbić numer klienta w zwykłym komunikacie błędu.
    // To również dana rachunku, choć nie przypomina klucza API.
    .replace(/(client\s+['\"]?)[A-Za-z0-9_-]+(['\"]?)/gi, '$1[redacted]$2')
    .replace(/\b\d{6,}\b/g, '[redacted]')
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[redacted]')
    .slice(0, 240);
}

function errorMessage(payload: unknown): { code?: string | number; message?: string } {
  if (!payload || typeof payload !== 'object') return {};
  const row = payload as Record<string, unknown>;
  const code = row.code ?? row.errorCode;
  const message = row.errMsg ?? row.error ?? row.message;
  return { code: typeof code === 'string' || typeof code === 'number' ? code : undefined,
    message: typeof message === 'string' ? sanitizeFreedom24Text(message) : undefined };
}

function freedom24FailureMessage(status: number, brokerMessage: string | undefined, invalidJsonMessage: string, parsed: unknown): string {
  if (brokerMessage) return brokerMessage;
  if (status === 401 || status === 403) {
    return `Freedom24 odrzuciło uwierzytelnienie (HTTP ${status}) — klucze API są nieważne, usunięte albo wygasły. Wprowadź nowe klucze w ustawieniach rachunku.`;
  }
  return parsed === null ? invalidJsonMessage : 'Freedom24 odrzuciło żądanie.';
}

export class Freedom24HttpClient {
  readonly baseUrl = 'https://freedom24.com';
  constructor(private readonly credentials: Credentials, private readonly timeoutMs = 10_000, private readonly retries = 1) {}

  async post<T>(command: string, params: Record<string, unknown>, allowRetry = true): Promise<Freedom24Result<T>> {
    const payload = canonicalJson(params);
    const signer = new Freedom24Signer(this.credentials.privateKey);
    let last: Freedom24SafeError | undefined;
    const maxRetries = allowRetry ? this.retries : 0;
    const ambiguousMessage = 'Nie wiadomo, czy Freedom24 przyjął polecenie — sprawdź listę zleceń, zanim spróbujesz ponownie';
    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      const timestamp = String(Math.floor(Date.now() / 1000));
      const signal = AbortSignal.timeout(this.timeoutMs);
      try {
        const response = await fetch(`${this.baseUrl}/api/${encodeURIComponent(command)}`, {
          method: 'POST',
          headers: {
            Accept: 'application/json',
            'Content-Type': 'application/json',
            'X-NtApi-PublicKey': this.credentials.publicKey,
            'X-NtApi-Timestamp': timestamp,
            'X-NtApi-Sig': signer.sign(payload, timestamp),
          },
          body: payload,
          signal,
        });
        const text = await response.text();
        let parsed: unknown;
        try { parsed = JSON.parse(text); } catch { parsed = null; }
        const broker = errorMessage(parsed);
        const brokerFailure = broker.code !== undefined && broker.code !== 0 && broker.code !== '0' && broker.code !== 200;
        if (response.ok && parsed !== null && !brokerFailure && !broker.message) return { ok: true, data: parsed as T, status: response.status };
        const retryable = response.status === 429 || response.status >= 500;
        const ambiguous = !allowRetry && (retryable || (response.ok && parsed === null));
        last = { status: response.status, brokerCode: broker.code, command, retryable: allowRetry && retryable,
          ...(ambiguous ? { ambiguous: true } : {}),
          message: ambiguous ? ambiguousMessage : freedom24FailureMessage(response.status, broker.message, 'Odpowiedź Freedom24 nie jest poprawnym JSON.', parsed) };
        if (!retryable || attempt === maxRetries) return { ok: false, error: last };
        const retryAfter = Number(response.headers.get('retry-after'));
        await new Promise((resolve) => setTimeout(resolve, Math.min(Number.isFinite(retryAfter) ? retryAfter * 1000 : 250, 1_000)));
      } catch (cause) {
        const timeout = cause instanceof Error && cause.name === 'TimeoutError';
        last = { command, retryable: allowRetry, ...(!allowRetry ? { ambiguous: true } : {}),
          message: !allowRetry ? ambiguousMessage : timeout ? 'Przekroczono limit czasu Freedom24.' : 'Błąd sieci podczas połączenia z Freedom24.' };
        if (attempt === maxRetries) return { ok: false, error: last };
      }
    }
    return { ok: false, error: last ?? { command, retryable: false, message: 'Nieznany błąd Freedom24.' } };
  }
}

export class Freedom24ApiClient {
  constructor(private readonly http: Freedom24HttpClient) {}
  read<T>(command: string, params: Record<string, unknown> = {}): Promise<Freedom24Result<T>> {
    if (!FREEDOM24_READ_ONLY_COMMANDS.has(command)) {
      return Promise.resolve({ ok: false, error: { command, retryable: false, message: 'Polecenie nie jest dozwolone w integracji tylko-do-odczytu.' } });
    }
    return this.http.post<T>(command, params);
  }

  /**
   * Zlecenia ochronne na ISTNIEJACEJ pozycji: ustawienie SL/TP i anulowanie zlecenia.
   * Osobna, waska lista - kupno, sprzedaz, przelewy i przewalutowania nie sa tu
   * dozwolone w ogole. Wywolywane wylacznie po jawnym potwierdzeniu uzytkownika.
   */
  protect<T>(command: string, params: Record<string, unknown>): Promise<Freedom24Result<T>> {
    if (!FREEDOM24_PROTECTIVE_COMMANDS.has(command)) {
      return Promise.resolve({ ok: false, error: { command, retryable: false, message: 'To polecenie nie jest zleceniem ochronnym - aplikacja go nie wysyła.' } });
    }
    return this.http.post<T>(command, params, false);
  }
}

export function createFreedom24Api(): Freedom24ApiClient | null {
  // Normal unit tests must never accidentally read a developer's real keys.
  // The dedicated integration runner explicitly opts in.
  if (process.env.FREEDOM24_DISABLE_LIVE === '1') return null;
  // Runner testow Node uruchamia kazdy plik w procesie potomnym: tam nie ma
  // `--test` ani w argv, ani w execArgv, jest za to NODE_TEST_CONTEXT. Samo
  // sprawdzanie flagi przepuszczalo testy uruchomione poza skryptem npm do
  // prawdziwego API z kluczami dewelopera.
  const procesTestu = process.argv.includes('--test') || process.execArgv.includes('--test')
    || Boolean(process.env.NODE_TEST_CONTEXT);
  if (procesTestu && process.env.FREEDOM24_INTEGRATION !== '1') return null;
  const credentials = Freedom24Credentials.load();
  if (credentials) return new Freedom24ApiClient(new Freedom24HttpClient(credentials));
  // Bez kluczy w pliku: sesja otwarta loginem albo kodem SMS (tylko w pamieci serwera).
  const session = freedom24Session.current();
  return session ? new Freedom24ApiClient(new Freedom24SessionHttpClient(session.sid)) : null;
}

/**
 * Sesja uzytkownika (SID) z `authByLogin` / `authBySms`. Zyje wylacznie w
 * pamieci procesu serwera: nie trafia do przegladarki, na dysk ani do logow,
 * znika po restarcie i po 12 godzinach. Haslo nie jest nigdzie zapamietywane.
 */
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
type Freedom24SessionMethod = 'LOGIN' | 'SMS';
let activeSession: { sid: string; method: Freedom24SessionMethod; openedAt: number } | null = null;
export const freedom24Session = {
  open(sid: string, method: Freedom24SessionMethod, now = Date.now()): void {
    activeSession = { sid, method, openedAt: now };
  },
  close(): void {
    activeSession = null;
  },
  current(now = Date.now()): { sid: string; method: Freedom24SessionMethod; openedAt: number } | null {
    if (activeSession && now - activeSession.openedAt > SESSION_TTL_MS) activeSession = null;
    return activeSession;
  },
  /** Opis dla interfejsu - bez identyfikatora sesji. */
  describe(now = Date.now()): { active: boolean; method: Freedom24SessionMethod | null; openedAt: string | null } {
    const session = freedom24Session.current(now);
    return { active: session !== null, method: session ? session.method : null, openedAt: session ? new Date(session.openedAt).toISOString() : null };
  },
};

/** Jedno zapytanie w formacie `q={cmd, SID?, params}` - tak dokumentacja opisuje logowanie i sesje SID. */
export async function freedom24LegacyRequest<T>(
  command: string,
  params: Record<string, unknown>,
  sid?: string,
  timeoutMs = 10_000,
): Promise<Freedom24Result<T>> {
  try {
    const response = await fetch('https://freedom24.com/api/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({ q: JSON.stringify({ cmd: command, ...(sid ? { SID: sid } : {}), params }) }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await response.text();
    let parsed: unknown = null;
    try { parsed = JSON.parse(text); } catch { parsed = null; }
    const broker = errorMessage(parsed);
    const brokerFailure = broker.code !== undefined && broker.code !== 0 && broker.code !== '0' && broker.code !== 200;
    if (response.ok && parsed !== null && !brokerFailure && !broker.message) return { ok: true, data: parsed as T, status: response.status };
    return { ok: false, error: { status: response.status, brokerCode: broker.code, command, retryable: response.status === 429 || response.status >= 500,
      message: freedom24FailureMessage(response.status, broker.message, 'Odpowiedź Freedom24 nie jest poprawnym JSON (możliwa strona blokady).', parsed) } };
  } catch (cause) {
    const timeout = cause instanceof Error && cause.name === 'TimeoutError';
    return { ok: false, error: { command, retryable: true, message: timeout ? 'Przekroczono limit czasu Freedom24.' : 'Błąd sieci podczas połączenia z Freedom24.' } };
  }
}

export class Freedom24SessionHttpClient extends Freedom24HttpClient {
  constructor(private readonly sid: string) {
    super({ publicKey: '', privateKey: '' } as Credentials);
  }
  override post<T>(command: string, params: Record<string, unknown>): Promise<Freedom24Result<T>> {
    return freedom24LegacyRequest<T>(command, params, this.sid);
  }
}

/** Parametry logowania: zawsze tryb podgladu - aplikacja niczego na rachunku nie zmienia. */
export function parametryLogowaniaHaslem(login: string, password: string, userId?: number): Record<string, unknown> {
  return { login, password, rememberMe: 0, getAccounts: false, viewOnlyMode: true, ...(userId ? { userId } : {}) };
}

/** Otwiera sesje z odpowiedzi brokera. Wynik nie zawiera SID; blad, gdy broker nie oddal sesji. */
export function otworzSesjeZOdpowiedzi(dane: unknown, method: Freedom24SessionMethod): { ok: true } | { ok: false; message: string } {
  const row = (dane ?? {}) as Record<string, unknown>;
  const sid = typeof row.SID === 'string' ? row.SID : typeof row.sid === 'string' ? row.sid : '';
  if (!sid.trim()) return { ok: false, message: 'Freedom24 odpowiedział bez identyfikatora sesji, więc sesja nie powstała.' };
  if (row.logged === false) return { ok: false, message: 'Freedom24 nie potwierdził zalogowania.' };
  freedom24Session.open(sid.trim(), method);
  return { ok: true };
}

function asNumber(value: unknown): number | null {
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(number) ? number : null;
}

export type Freedom24Portfolio = {
  balances: Array<{ currency: string; amount: number | null; exchangeRate: number | null }>;
  positions: Array<{ ticker: string; market: string | null; isin: string | null; currency: string; quantity: number | null; marketValue: number | null; averagePrice: number | null; marketPrice: number | null; profit: number | null }>;
};

/** `currval` is a broker/base-currency exchange rate, never a USD amount. */
/**
 * Elementy listy z odpowiedzi brokera nadajace sie do odczytu. `null` albo
 * liczba w tablicy wywracaly adaptery TypeError-em (cala trasa - blad 500);
 * lista jednoelementowa bywa wysylana jako sam obiekt (jak w zleceniach).
 */
export function tylkoObiekty(lista: unknown): Record<string, any>[] {
  if (Array.isArray(lista)) return lista.filter((element) => element !== null && typeof element === 'object');
  return lista !== null && typeof lista === 'object' ? [lista as Record<string, any>] : [];
}

export function adaptPortfolio(payload: unknown): Freedom24Portfolio {
  const top = payload as Record<string, any>;
  const ps = top?.result?.ps ?? top?.ps ?? top?.data?.ps ?? top;
  const balances = tylkoObiekty(ps?.acc);
  const positions = tylkoObiekty(ps?.pos);
  return {
    balances: balances.map((item: Record<string, unknown>) => ({
      currency: String(item.curr ?? '').toUpperCase(), amount: asNumber(item.s), exchangeRate: asNumber(item.currval),
    })),
    positions: positions.map((item: Record<string, unknown>) => {
      const rawTicker = String(item.i ?? item.ticker ?? '');
      const [ticker, suffix] = rawTicker.split('.', 2);
      return { ticker, market: suffix ?? (typeof item.market === 'string' ? item.market : null), isin: typeof item.isin === 'string' ? item.isin : null,
        currency: String(item.curr ?? item.base_currency ?? '').toUpperCase(), quantity: asNumber(item.q), marketValue: asNumber(item.market_value ?? item.s),
        averagePrice: asNumber(item.bal_price_a ?? item.price_a), marketPrice: asNumber(item.mkt_price), profit: asNumber(item.profit_close) };
    }),
  };
}
