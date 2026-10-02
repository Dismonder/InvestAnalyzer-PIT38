import { Router } from 'express';
import { fetchYahooQuote } from './quotes';
import { odmienLiczebnik } from '../../portfel/services/odmianaLiczebnika';
import type { Request, Response } from 'express';
import crypto from 'crypto';
import {
  adaptPortfolio,
  createFreedom24Api,
  freedom24LegacyRequest,
  freedom24Session,
  otworzSesjeZOdpowiedzi,
  parametryLogowaniaHaslem,
  FREEDOM24_READ_ONLY_COMMANDS,
  Freedom24Credentials,
  sanitizeFreedom24Text,
  type Freedom24Result,
  tylkoObiekty,
} from '../freedom24/freedom24Api.ts';

const router = Router();

type BinanceOrderReservation = {
  clientOrderId: string;
  activeRequests: number;
  uncertain: boolean;
};

// Jednoprocesowa rezerwacja; przechowuje wyłącznie skrót API Key i symbol.
// Nierozstrzygnięty wynik pozostaje zarezerwowany do sprawdzenia statusu.
const binanceOrderReservations = new Map<string, BinanceOrderReservation>();
const BINANCE_RESERVATION_LIMIT = 200;
type BinanceFilters = { tickSize: string; stepSize: string };
const binanceFilterCache = new Map<string, BinanceFilters>();

function binanceSymbol(ticker: unknown): string | null {
  if (typeof ticker !== 'string') return null;
  const clean = ticker.trim().toUpperCase();
  if (!/^[A-Z0-9]{2,20}$/.test(clean)) return null;
  const pair = clean.endsWith('USDT') ? clean : `${clean}USDT`;
  return /^[A-Z0-9]{2,20}$/.test(pair) ? pair : null;
}

function positiveFinite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

async function getBinanceFilters(symbol: string): Promise<BinanceFilters> {
  const cached = binanceFilterCache.get(symbol);
  if (cached) return cached;
  const url = `https://api.binance.com/api/v3/exchangeInfo?${new URLSearchParams({ symbol })}`;
  const response = await fetch(url);
  if (!response.ok) throw new Error('Nie udało się pobrać filtrów pary Binance.');
  const data: any = await response.json();
  const filters = data?.symbols?.[0]?.filters;
  const tickSize = filters?.find((item: any) => item.filterType === 'PRICE_FILTER')?.tickSize;
  const stepSize = filters?.find((item: any) => item.filterType === 'LOT_SIZE')?.stepSize;
  if (!positiveFinite(Number(tickSize)) || !positiveFinite(Number(stepSize))) throw new Error('Brak poprawnych filtrów ceny lub ilości dla pary Binance.');
  const result = { tickSize: String(tickSize), stepSize: String(stepSize) };
  binanceFilterCache.set(symbol, result);
  return result;
}

function roundBinance(value: number, step: string, direction: 'up' | 'down'): string {
  const places = (step.split('.')[1] || '').replace(/0+$/, '').length;
  const unit = Number(step);
  const quotient = value / unit;
  const rounded = direction === 'up' ? Math.ceil(quotient - 1e-9) : Math.floor(quotient + 1e-9);
  return (rounded * unit).toFixed(places);
}

function signedBinanceQuery(params: Record<string, string>, apiSecret: string): string {
  const query = new URLSearchParams(params).toString();
  const signature = crypto.createHmac('sha256', apiSecret.trim()).update(query).digest('hex');
  return `${query}&${new URLSearchParams({ signature })}`;
}

function binanceReservationKey(apiKey: string, symbol: string): string {
  const keyHash = crypto.createHash('sha256').update(apiKey.trim()).digest('hex');
  return `${keyHash}:${symbol}`;
}

function reserveBinanceOrder(key: string, clientOrderId: string): 'ok' | 'conflict' | 'full' {
  const current = binanceOrderReservations.get(key);
  if (current && current.clientOrderId !== clientOrderId) return 'conflict';
  if (!current && binanceOrderReservations.size >= BINANCE_RESERVATION_LIMIT) return 'full';
  if (current) current.activeRequests += 1;
  else binanceOrderReservations.set(key, { clientOrderId, activeRequests: 1, uncertain: false });
  return 'ok';
}

function finishBinanceOrderAttempt(key: string, uncertain: boolean): void {
  const current = binanceOrderReservations.get(key);
  if (!current) return;
  current.activeRequests = Math.max(0, current.activeRequests - 1);
  current.uncertain ||= uncertain;
  if (current.activeRequests === 0 && !current.uncertain) binanceOrderReservations.delete(key);
}

function resolveBinanceOrderStatus(key: string, clientOrderId: string): void {
  const current = binanceOrderReservations.get(key);
  if (current?.clientOrderId === clientOrderId && current.activeRequests === 0) binanceOrderReservations.delete(key);
}

/** Czy zadanie w ogole niesie komplet kluczy API. */
function maKluczeApi(req: Request): boolean {
  const { apiKey, apiSecret } = (req.body || {}) as { apiKey?: string; apiSecret?: string };
  return Boolean(String(apiKey || '').trim() && String(apiSecret || '').trim());
}

/**
 * Odpowiedz trasy brokerskiej z uczciwym kodem HTTP.
 *
 * `res.json({ success: false })` wychodzilo ze statusem 200: dla posrednikow,
 * cache i dla kazdego klienta sprawdzajacego `response.ok` nieudany odczyt
 * z Freedom24 wygladal jak udane zadanie z pusta lista. Brak kluczy to blad
 * zadania (400), odmowa albo cisza brokera - blad bramy (502).
 */
function odeslijWynik(res: Response, wynik: unknown, maKlucze: boolean): void {
  if (wynik && typeof wynik === 'object' && (wynik as { success?: boolean }).success === false) {
    res.status(maKlucze ? 502 : 400).json(wynik);
    return;
  }
  res.json(wynik);
}

/** Starsze odczyty używają kluczy z żądania tylko gdy podano komplet; domyślnie klienta serwera. */
async function odczytajFreedom24(cmd: string, params: Record<string, unknown>, apiKey?: string, apiSecret?: string) {
  if (apiKey?.trim() && apiSecret?.trim()) {
    const wynik = await sendTradernetRequest(cmd, params, apiKey.trim(), apiSecret.trim());
    return { success: wynik.success, data: wynik.data, error: sanitizeFreedom24Text(wynik.error), configured: true };
  }
  const api = createFreedom24Api();
  if (!api) return { success: false, error: 'Brak kluczy API dla Freedom24.', configured: false };
  const wynik = await api.read<any>(cmd, params);
  return wynik.ok === true
    ? { success: true, data: wynik.data, configured: true }
    : { success: false, error: sanitizeFreedom24Text(wynik.error.message), configured: true };
}

/**
 * Pierwsza czytelna liczba z pol odpowiedzi brokera albo `null`.
 * `parseFloat(pole || '0')` zamienialo brak danych w zero, ktore w tabeli
 * wyglada jak prawdziwa cena, wartosc albo zysk.
 */
function liczbaZPol(...surowe: unknown[]): number | null {
  for (const surowa of surowe) {
    if (surowa === null || surowa === undefined || surowa === '') continue;
    const n = parseFloat(String(surowa));
    if (Number.isFinite(n)) return n;
  }
  return null;
}

export interface BrokerTestPayload {
  brokerType: 'XTB' | 'IBKR' | 'FREEDOM24' | 'REVOLUT' | 'EMAKLER' | 'DEGIRO' | 'BINANCE' | 'CUSTOM';
  apiKey?: string;
  apiSecret?: string;
  accountNumber?: string;
  queryId?: string;
  apiServerType?: 'REAL' | 'DEMO';
}

export interface BrokerSyncPayload extends BrokerTestPayload {
  accountId: string;
  brokerName?: string;
  lastSyncDate?: string;
}

// 1. Binance API Tester & Synchronizer
/**
 * Zdejmuje z komunikatu wszystko, co wyglada na sekret albo dane osobowe.
 *
 * Tresc bledu od brokera jest dla uzytkownika najcenniejsza informacja
 * diagnostyczna ("nieprawidlowy klucz", "brak uprawnien do odczytu historii"),
 * wiec jej nie wycinamy. Usuwamy natomiast dlugie ciagi alfanumeryczne
 * i adresy e-mail, ktore moglyby byc kluczem albo loginem odbitym w echo.
 */
export function bezSekretow(tekst: unknown, zapasowy = 'brak szczegółów'): string {
  const surowy = typeof tekst === 'string' ? tekst : String(tekst ?? '');
  if (!surowy.trim()) {
    return zapasowy;
  }
  return surowy
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[adres e-mail]')
    .replace(/\b[A-Fa-f0-9]{24,}\b/g, '[klucz]')
    .replace(/\b[A-Za-z0-9_-]{32,}\b/g, '[klucz]')
    .slice(0, 300);
}

/** Local-file Freedom24 routes.  They intentionally never inspect request keys. */
function freedom24Unavailable(res: Response): void {
  res.status(503).json({ success: false, configured: false, errorCode: 'FREEDOM24_UNAVAILABLE', message: 'Lokalne poświadczenia Freedom24 nie są skonfigurowane.' });
}

function freedom24Failure(res: Response, result: Freedom24Result<unknown>): void {
  if (result.ok !== false) return;
  const status = result.error.status === 401 || result.error.status === 403 ? 401 : 502;
  res.status(status).json({ success: false, errorCode: result.error.brokerCode ? String(result.error.brokerCode) : 'FREEDOM24_REQUEST_FAILED', command: result.error.command, retryable: result.error.retryable, message: sanitizeFreedom24Text(result.error.message) });
}

function freedom24ExportFailure(res: Response, result: Freedom24Result<unknown>): void {
  if (result.ok !== false) return;
  res.status(502).json({ success: false, errorCode: 'FREEDOM24_EXPORT_FAILED', warnings: [`${result.error.command}: ${sanitizeFreedom24Text(result.error.message)}`], message: 'Eksport Freedom24 nie został utworzony, bo wymagany odczyt się nie powiódł.' });
}

function freedom24List(data: any, paths: string[]): any[] {
  for (const dotted of paths) {
    let current = data;
    for (const part of dotted.split('.')) current = current?.[part];
    if (Array.isArray(current)) return current;
  }
  return [];
}

router.get('/freedom24/status', (_req, res) => {
  const klucze = Freedom24Credentials.configured();
  const sesja = freedom24Session.describe();
  res.json({
    success: true,
    configured: klucze || sesja.active,
    authSource: klucze ? 'KEYS' : sesja.active ? sesja.method : null,
    session: sesja,
    mode: 'local-file-read-only',
  });
});

// Logowanie loginem i haslem (dokumentacja: strona auth-login, polecenie
// `authByLogin`). Nie wymaga SMS. Haslo idzie wprost do brokera i nie jest
// zapisywane ani logowane; sesja zostaje w pamieci serwera, w trybie podgladu.
router.post('/freedom24/auth/login', async (req, res) => {
  const login = String(req.body?.login ?? '').trim();
  const password = String(req.body?.password ?? '');
  if (!login || !password) return res.status(400).json({ success: false, message: 'Podaj login (e-mail) i hasło do Freedom24.' });
  const userId = Number(req.body?.userId);
  const wynik = await freedom24LegacyRequest<any>(
    'authByLogin',
    parametryLogowaniaHaslem(login, password, Number.isFinite(userId) && userId > 0 ? userId : undefined),
  );
  if (wynik.ok === false) {
    return res.status(wynik.error.status === 429 ? 429 : 502).json({ success: false, message: `Freedom24 odmówił logowania: ${wynik.error.message}` });
  }
  const sesja = otworzSesjeZOdpowiedzi(wynik.data, 'LOGIN');
  if (sesja.ok === false) return res.status(502).json({ success: false, message: sesja.message });
  res.json({ success: true, session: freedom24Session.describe(), message: 'Zalogowano do Freedom24 w trybie tylko do podglądu.' });
});

export interface ZlecenieBrokera {
  orderId: number;
  ticker: string;
  rodzaj: 'STOP_LOSS' | 'TAKE_PROFIT' | 'INNE';
  strona: 'KUPNO' | 'SPRZEDAZ';
  ilosc: number | null;
  pozostalo: number | null;
  cenaProgu: number | null;
  cenaZlecenia: number | null;
  waluta: string | null;
  status: number | null;
  aktywne: boolean;
  waznosc: 'DZIEN' | 'DZIEN_I_NOC' | 'DO_ANULOWANIA' | null;
  data: string | null;
}

/** Zlecenia z `getNotifyOrderJson`. Kody wg dokumentacji: type 5 = Stoploss, 6 = Takeprofit; stat 10-12 = aktywne. */
export function zleceniaZOdpowiedzi(dane: unknown): ZlecenieBrokera[] {
  const korzen = (dane as any)?.result ?? dane;
  const surowe = korzen?.orders?.order ?? korzen?.orders ?? [];
  const lista: any[] = Array.isArray(surowe) ? surowe : surowe && typeof surowe === 'object' ? [surowe] : [];
  const liczba = (v: unknown): number | null => {
    const n = typeof v === 'number' ? v : Number(v);
    return Number.isFinite(n) ? n : null;
  };
  return lista
    .filter((o) => o && typeof o === 'object' && liczba(o.id ?? o.order_id) !== null && typeof o.instr === 'string')
    .map((o) => {
      const typ = liczba(o.type);
      const status = liczba(o.stat);
      const waznosc = liczba(o.exp);
      return {
        orderId: liczba(o.id ?? o.order_id) as number,
        ticker: String(o.instr).toUpperCase(),
        rodzaj: typ === 5 ? 'STOP_LOSS' : typ === 6 ? 'TAKE_PROFIT' : 'INNE',
        strona: liczba(o.oper) === 1 || liczba(o.oper) === 2 ? 'KUPNO' : 'SPRZEDAZ',
        ilosc: liczba(o.q),
        pozostalo: liczba(o.leaves_qty),
        cenaProgu: liczba(o.stop) && (liczba(o.stop) as number) > 0 ? liczba(o.stop) : null,
        cenaZlecenia: liczba(o.p) && (liczba(o.p) as number) > 0 ? liczba(o.p) : null,
        waluta: typeof o.cur === 'string' && o.cur ? o.cur.toUpperCase() : null,
        status,
        aktywne: status !== null && [1, 10, 11, 12].includes(status),
        waznosc: waznosc === 1 ? 'DZIEN' : waznosc === 2 ? 'DZIEN_I_NOC' : waznosc === 3 ? 'DO_ANULOWANIA' : null,
        data: typeof o.date === 'string' ? o.date : null,
      } as ZlecenieBrokera;
    });
}

export interface ProsbaOchrony {
  ticker: string;
  stopLoss: number | null;
  takeProfit: number | null;
}

/**
 * Sprawdza prosbe o SL/TP wzgledem pozycji u brokera. Zwraca tekst bledu albo `null`.
 * Bez posiadanej pozycji i bez kursu z rachunku zlecenia nie wysylamy - nie ma czego chronic
 * ani czym sprawdzic, czy prog nie zadziala natychmiast.
 */
export function bladProsbyOchrony(
  prosba: ProsbaOchrony,
  pozycja: { quantity: number | null; marketPrice: number | null } | null,
): string | null {
  if (!/^[A-Z0-9]{1,12}\.[A-Z0-9]{1,8}$/.test(prosba.ticker)) return 'Nieprawidłowy ticker instrumentu.';
  const { stopLoss, takeProfit } = prosba;
  if (stopLoss === null && takeProfit === null) return 'Podaj cenę Stop-Loss albo Take-Profit.';
  for (const cena of [stopLoss, takeProfit]) {
    if (cena !== null && !(Number.isFinite(cena) && cena > 0)) return 'Cena progu musi być liczbą większą od zera.';
  }
  if (!pozycja || !(pozycja.quantity !== null && pozycja.quantity > 0)) return `Na rachunku nie ma otwartej pozycji ${prosba.ticker} — nie ma czego chronić.`;
  if (!(pozycja.marketPrice !== null && pozycja.marketPrice > 0)) return 'Broker nie podał bieżącego kursu tej pozycji, więc nie da się sprawdzić progów.';
  if (stopLoss !== null && stopLoss >= pozycja.marketPrice) return `Stop-Loss ${stopLoss} jest na poziomie kursu (${pozycja.marketPrice}) albo powyżej — zadziałałby natychmiast.`;
  if (takeProfit !== null && takeProfit <= pozycja.marketPrice) return `Take-Profit ${takeProfit} jest na poziomie kursu (${pozycja.marketPrice}) albo poniżej — zadziałałby natychmiast.`;
  return null;
}

// Aktywne zlecenia z rachunku - tylko odczyt.
router.post('/freedom24/orders/active', async (_req, res) => {
  const api = createFreedom24Api();
  if (!api) return freedom24Unavailable(res);
  const wynik = await api.read<any>('getNotifyOrderJson', { active_only: 1 });
  if (wynik.ok === false) return freedom24Failure(res, wynik);
  const zlecenia = zleceniaZOdpowiedzi(wynik.data).filter((z) => z.aktywne);
  res.json({ success: true, configured: true, orders: zlecenia });
});

// Ustawienie SL/TP na posiadanej pozycji. Wymaga `confirm: true` - interfejs pyta uzytkownika
// o zgode, pokazujac dokladne ceny. Trasa nie potrafi kupic ani sprzedac po rynku.
router.post('/freedom24/orders/protect', async (req, res) => {
  if (req.body?.confirm !== true) return res.status(400).json({ success: false, message: 'Zlecenie wymaga jawnego potwierdzenia.' });
  if (Freedom24Credentials.configured() !== true) {
    return res.status(409).json({ success: false, message: 'Zlecenia wymagają kluczy API na serwerze. Sesja z logowania działa tylko w trybie podglądu.' });
  }
  const api = createFreedom24Api();
  if (!api) return freedom24Unavailable(res);
  const cena = (v: unknown): number | null => (v === null || v === undefined || v === '' ? null : Number(v));
  const prosba: ProsbaOchrony = { ticker: String(req.body?.ticker ?? '').trim().toUpperCase(), stopLoss: cena(req.body?.stopLoss), takeProfit: cena(req.body?.takeProfit) };
  const portfel = await api.read<any>('getPositionJson');
  if (portfel.ok === false) return freedom24Failure(res, portfel);
  const pozycja = adaptPortfolio(portfel.data).positions.find((p) => `${p.ticker}${p.market ? `.${p.market}` : ''}`.toUpperCase() === prosba.ticker || p.ticker.toUpperCase() === prosba.ticker) ?? null;
  const blad = bladProsbyOchrony(prosba, pozycja);
  if (blad) return res.status(400).json({ success: false, message: blad });
  const wynik = await api.protect<any>('putStopLoss', {
    instr_name: prosba.ticker,
    ...(prosba.stopLoss !== null ? { stop_loss: prosba.stopLoss } : {}),
    ...(prosba.takeProfit !== null ? { take_profit: prosba.takeProfit } : {}),
  });
  if (wynik.ok === false) return res.status(502).json({ success: false, ambiguous: wynik.error.ambiguous === true, message: wynik.error.ambiguous ? wynik.error.message : `Freedom24 odrzuciło zlecenie: ${wynik.error.message}` });
  res.json({ success: true, message: 'Freedom24 przyjęło zlecenie ochronne.' });
});

// Anulowanie zlecenia: tylko takiego, ktore broker pokazuje jako aktywne.
router.post('/freedom24/orders/cancel', async (req, res) => {
  if (req.body?.confirm !== true) return res.status(400).json({ success: false, message: 'Anulowanie wymaga jawnego potwierdzenia.' });
  const orderId = Number(req.body?.orderId);
  if (!Number.isInteger(orderId) || orderId <= 0) return res.status(400).json({ success: false, message: 'Nieprawidłowy numer zlecenia.' });
  if (Freedom24Credentials.configured() !== true) return res.status(409).json({ success: false, message: 'Anulowanie wymaga kluczy API na serwerze.' });
  const api = createFreedom24Api();
  if (!api) return freedom24Unavailable(res);
  const aktywne = await api.read<any>('getNotifyOrderJson', { active_only: 1 });
  if (aktywne.ok === false) return freedom24Failure(res, aktywne);
  if (!zleceniaZOdpowiedzi(aktywne.data).some((z) => z.orderId === orderId && z.aktywne)) {
    return res.status(404).json({ success: false, message: 'Broker nie pokazuje takiego aktywnego zlecenia.' });
  }
  const wynik = await api.protect<any>('delTradeOrder', { order_id: orderId });
  if (wynik.ok === false) return res.status(502).json({ success: false, ambiguous: wynik.error.ambiguous === true, message: wynik.error.ambiguous ? wynik.error.message : `Freedom24 nie anulowało zlecenia: ${wynik.error.message}` });
  res.json({ success: true, message: 'Freedom24 przyjęło anulowanie zlecenia.' });
});

router.post('/freedom24/auth/logout', (_req, res) => {
  freedom24Session.close();
  res.json({ success: true, session: freedom24Session.describe() });
});

router.post('/freedom24/auth-check', async (_req, res) => {
  const api = createFreedom24Api();
  if (!api) return freedom24Unavailable(res);
  const result = await api.read('getOPQ');
  if (!result.ok) return freedom24Failure(res, result);
  res.json({ success: true, configured: true, authenticated: true, status: result.status });
});

router.post('/freedom24/portfolio', async (_req, res) => {
  const api = createFreedom24Api();
  if (!api) return res.status(503).json({ success: false, acc: [], pos: [], message: 'Lokalne poświadczenia Freedom24 nie są skonfigurowane.' });
  const result = await api.read('getPositionJson');
  if (!result.ok) return freedom24Failure(res, result);
  const portfolio = adaptPortfolio(result.data);
  res.json({ success: true, configured: true, status: result.status, portfolio });
});

router.post('/freedom24/full-export', async (req, res) => {
  const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
  const dateFrom = typeof body.dateFrom === 'string' ? body.dateFrom : undefined;
  const dateTo = typeof body.dateTo === 'string' ? body.dateTo : undefined;
  const datePattern = /^\d{4}-\d{2}-\d{2}$/;
  if ((dateFrom && !datePattern.test(dateFrom)) || (dateTo && !datePattern.test(dateTo)) || (dateFrom && dateTo && dateFrom > dateTo)) {
    return res.status(400).json({ success: false, message: 'Nieprawidłowy zakres dat.' });
  }
  const api = createFreedom24Api();
  if (!api) return freedom24Unavailable(res);
  const historyParams = { ...(dateFrom ? { date_from: dateFrom } : {}), ...(dateTo ? { date_to: dateTo } : {}) };
  const cashFilters: Array<{ field: string; operator: string; value: string }> = [];
  if (dateFrom) cashFilters.push({ field: 'date', operator: 'eqormore', value: dateFrom });
  if (dateTo) cashFilters.push({ field: 'date', operator: 'eqorless', value: dateTo });
  const cashParams = { take: 100, skip: 0, filters: cashFilters.length > 0 ? cashFilters : {} };
  // tradernet-sdk 2.2.0 calls getBrokerReport once per required `type`.
  // Missing this parameter is a broker-side HTTP 400, not an empty report.
  const reportParams = {
    date_start: dateFrom || '1970-01-01',
    date_end: dateTo || polskiDzienKalendarzowy(),
    time_period: '23:59:59',
    format: 'json',
  };
  // Sequential calls avoid a burst against the brokerage API.
  const tradesResult = await api.read<any>('getTradesHistory', historyParams);
  if (!tradesResult.ok) return freedom24ExportFailure(res, tradesResult);
  const cashResult = await api.read<any>('getUserCashFlows', cashParams);
  if (!cashResult.ok) return freedom24ExportFailure(res, cashResult);
  const cashFlows = freedom24List(cashResult.data, ['cashflow', 'result.cashflow', 'cashflows', 'result.cashflows']);
  const totalCashFlows = Number((cashResult.data as any)?.total ?? (cashResult.data as any)?.result?.total);
  // Tradernet caps `take` at 100. Paginate sequentially; no concurrent burst.
  let cashPages = 1;
  while (Number.isFinite(totalCashFlows) && cashFlows.length < totalCashFlows) {
    if (cashPages >= 1_000) {
      return res.status(502).json({ success: false, errorCode: 'FREEDOM24_EXPORT_INCOMPLETE',
        missingRecords: Math.ceil(totalCashFlows - cashFlows.length), message: 'Eksport Freedom24 jest niepełny: przekroczono limit stron przepływów gotówkowych.' });
    }
    const page = await api.read<any>('getUserCashFlows', { ...cashParams, skip: cashFlows.length });
    if (!page.ok) return freedom24ExportFailure(res, page);
    const rows = freedom24List(page.data, ['cashflow', 'result.cashflow', 'cashflows', 'result.cashflows']);
    if (rows.length === 0) {
      return res.status(502).json({ success: false, errorCode: 'FREEDOM24_EXPORT_INCOMPLETE',
        missingRecords: Math.ceil(totalCashFlows - cashFlows.length), message: 'Eksport Freedom24 jest niepełny: broker nie zwrócił pozostałych przepływów gotówkowych.' });
    }
    cashFlows.push(...rows);
    cashPages += 1;
  }
  const positionResult = await api.read<any>('getPositionJson');
  if (!positionResult.ok) return freedom24ExportFailure(res, positionResult);
  const brokerReport: Record<string, unknown> = {};
  const warnings: string[] = [];
  const missingSections: string[] = [];
  const taxSections = new Set(['trades', 'commissions', 'corporate_actions', 'in_outs', 'in_outs_securities', 'cash_flows', 'securities_flows']);
  for (const type of ['account_at_start', 'account_at_end', 'trades', 'commissions', 'corporate_actions', 'in_outs', 'in_outs_securities', 'cash_flows', 'securities_flows']) {
    const section = await api.read<any>('getBrokerReport', { ...reportParams, type });
    if (section.ok) {
      const value = (section.data as any)?.report ?? (section.data as any)?.result?.report;
      if (value !== undefined) brokerReport[type] = value;
      else if (taxSections.has(type)) missingSections.push(type);
    } else {
      warnings.push(`getBrokerReport/${type}: ${'error' in section ? section.error.message : 'Freedom24 odrzuciło żądanie.'}`);
      if (taxSections.has(type)) missingSections.push(type);
    }
  }
  // `getDepositaryReport` uses the same date envelope and a mandatory report
  // type. It remains optional control evidence, never a substitute for trades.
  const trades = freedom24List(tradesResult.data, ['trades.trade', 'trades', 'result.trades.trade', 'result.trades']);
  // Depozytariusz odrzuca zakres zaczynajacy sie przed otwarciem rachunku
  // (HTTP 400), wiec bez podanej daty zaczynamy od pierwszej operacji.
  const depositaryStart = dateFrom || najwczesniejszyDzienOperacji(trades, cashFlows);
  const depositaryReportResult = depositaryStart
    ? await api.read<any>('getDepositaryReport', { ...reportParams, date_start: depositaryStart, type: 'depoData' })
    : null;
  const positions = adaptPortfolio(positionResult.data).positions;
  const brokerReportValue = Object.keys(brokerReport).length > 0 ? brokerReport : null;
  const depositaryReport = depositaryReportResult?.ok ? (depositaryReportResult.data as any)?.report ?? (depositaryReportResult.data as any)?.result?.report ?? null : null;
  if (depositaryReportResult === null) warnings.push('Raport depozytariusza pominięty: rachunek nie ma jeszcze żadnej operacji z datą.');
  else if (depositaryReportResult.ok === false) warnings.push(`Raport depozytariusza niepobrany (zakres od ${depositaryStart}): ${depositaryReportResult.error.message}`);
  res.json({ success: true, complete: missingSections.length === 0, missingSections, configured: true, sections: { trades: trades.length, cash_flows: cashFlows.length, positions: positions.length, broker_report_sections: brokerReportValue ? Object.keys(brokerReportValue).length : 0, depositary_report_sections: depositaryReport && typeof depositaryReport === 'object' ? Object.keys(depositaryReport).length : 0 }, warnings, report: { trades, cash_flows: cashFlows, positions }, raportMaklerski: brokerReportValue, raportDepozytariusza: depositaryReport });
});

export function polskiDzienKalendarzowy(date = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/Warsaw', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date);
  const value = (type: string) => parts.find((part) => part.type === type)?.value;
  return `${value('year')}-${value('month')}-${value('day')}`;
}

/** Najwczesniejszy dzien (RRRR-MM-DD) wsrod transakcji i przeplywow; `null`, gdy zadna operacja nie ma daty. */
export function najwczesniejszyDzienOperacji(...listy: unknown[][]): string | null {
  let najwczesniejszy: string | null = null;
  for (const lista of listy) {
    for (const wiersz of lista) {
      if (!wiersz || typeof wiersz !== 'object') continue;
      const rekord = wiersz as Record<string, unknown>;
      for (const pole of ['date', 'short_date', 'datetime', 'pay_d']) {
        const dzien = String(rekord[pole] ?? '').slice(0, 10);
        if (/^\d{4}-\d{2}-\d{2}$/.test(dzien) && (najwczesniejszy === null || dzien < najwczesniejszy)) najwczesniejszy = dzien;
      }
    }
  }
  return najwczesniejszy;
}

export async function testBinanceConnection(apiKey: string, apiSecret: string) {
  const startTime = Date.now();
  if (!apiKey || !apiSecret) {
    return {
      success: false,
      message: 'Brak klucza API Key lub API Secret dla Binance.',
      latencyMs: 0,
      broker: 'BINANCE',
      error: 'Missing credentials',
    };
  }

  try {
    const timestamp = Date.now();
    const queryString = `timestamp=${timestamp}&recvWindow=5000`;
    const signature = crypto
      .createHmac('sha256', apiSecret.trim())
      .update(queryString)
      .digest('hex');

    const url = `https://api.binance.com/api/v3/account?${queryString}&signature=${signature}`;
    const response = await fetch(url, {
      headers: {
        'X-MBX-APIKEY': apiKey.trim(),
        'Accept': 'application/json',
      },
    });

    const latencyMs = Date.now() - startTime;

    if (response.ok) {
      const data: any = await response.json();
      const nonZeroBalances = (data.balances || [])
        .filter((b: any) => parseFloat(b.free) > 0 || parseFloat(b.locked) > 0)
        .map((b: any) => ({
          asset: b.asset,
          free: parseFloat(b.free),
          locked: parseFloat(b.locked),
        }));

      return {
        success: true,
        message: `Połączenie z Binance API v3 nawiązane pomyślnie. Status konta: ${data.accountType || 'SPOT'}. Aktywne saldo w ${nonZeroBalances.length} kryptoaktywach.`,
        latencyMs,
        broker: 'BINANCE',
        accountInfo: {
          status: 'ACTIVE',
          permissions: data.permissions || ['SPOT'],
          balances: nonZeroBalances.slice(0, 15),
          tradeCount: data.buyerCommission ? 1 : 0,
        },
      };
    } else {
      const errorData: any = await response.json().catch(() => ({}));
      const szczegol = bezSekretow(errorData.msg || response.statusText, 'brak szczegółów');
      return {
        success: false,
        message: `Błąd API Binance (HTTP ${response.status}): ${szczegol}`,
        latencyMs,
        broker: 'BINANCE',
        error: szczegol,
      };
    }
  } catch (err: any) {
    return {
      success: false,
      message: `Nie udało się połączyć z Binance: ${bezSekretow(err?.message, 'błąd sieciowy')}`,
      latencyMs: Date.now() - startTime,
      broker: 'BINANCE',
      error: bezSekretow(err?.message, 'błąd sieciowy'),
    };
  }
}

export async function syncBinanceTrades(payload: BrokerSyncPayload) {
  const { accountId, apiKey, apiSecret } = payload;
  const now = new Date().toISOString();

  if (!apiKey || !apiSecret) {
    throw new Error('Wymagane są klucze API Key i API Secret dla Binance.');
  }

  const cleanKey = apiKey.trim();
  const cleanSecret = apiSecret.trim();

  const staleSymbols = [
    'BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'ADAUSDT', 'DOTUSDT', 'XRPUSDT', 'AVAXUSDT',
    'MATICUSDT', 'LINKUSDT', 'LTCUSDT', 'NEARUSDT', 'SUIUSDT', 'DOGEUSDT', 'BTCEUR', 'ETHEUR', 'SOLEUR',
  ];
  const transactions: any[] = [];
  const openBalances: any[] = [];
  // Bledy odczytu byly wczesniej wypisywane tylko na konsole serwera,
  // a uzytkownik dostawal "Pobrano wszystkie dane z Binance API".
  const ostrzezenia: string[] = [];
  let saldaOdczytane = false;
  const paryBezOdpowiedzi: string[] = [];
  const completeSymbols: string[] = [];
  const incompleteSymbols: string[] = [];
  // Waluty fiat spotowe Binance. Tabela A NBP plus waluty fiat dodatkowo
  // notowane przez Binance; salda tych aktywow pozwalaja odnalezc EURUSDT,
  // PLNUSDT itd. bez zmiany stronicy/daty historii.
  const walutyFiat = new Set([
    'PLN', 'THB', 'USD', 'AUD', 'HKD', 'CAD', 'NZD', 'SGD', 'EUR', 'HUF',
    'CHF', 'GBP', 'UAH', 'JPY', 'CZK', 'DKK', 'ISK', 'NOK', 'SEK', 'RON',
    'TRY', 'ILS', 'CLP', 'PHP', 'MXN', 'ZAR', 'BRL', 'MYR', 'IDR', 'INR',
    'KRW', 'CNY', 'ARS', 'NGN', 'RUB', 'VND', 'GEL', 'KZT', 'AED', 'BIDR',
  ]);
  const quoteAssets = new Set([
    'USDT', 'USDC', 'FDUSD', 'BUSD', 'BTC', 'ETH', 'BNB', 'EUR', 'PLN', 'USD',
    'TRY', 'BRL', 'ARS', 'UAH', 'ZAR', 'MXN', 'RON', 'CZK', 'JPY', 'GBP',
  ]);
  const dzienWarszawski = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Warsaw', year: 'numeric', month: '2-digit', day: '2-digit',
  });

  // 1. Fetch Account Balances
  try {
    const timestamp = Date.now();
    const queryString = `timestamp=${timestamp}&recvWindow=5000`;
    const signature = crypto.createHmac('sha256', cleanSecret).update(queryString).digest('hex');
    const accUrl = `https://api.binance.com/api/v3/account?${queryString}&signature=${signature}`;
    const accRes = await fetch(accUrl, {
      headers: { 'X-MBX-APIKEY': cleanKey, 'Accept': 'application/json' },
    });
    if (accRes.ok) {
      const accData: any = await accRes.json();
      if (Array.isArray(accData.balances)) {
        saldaOdczytane = true;
        accData.balances
          .filter((b: any) => parseFloat(b.free) > 0 || parseFloat(b.locked) > 0)
          .forEach((b: any) => {
            openBalances.push({ asset: b.asset, qty: parseFloat(b.free) + parseFloat(b.locked) });
          });
      } else {
        ostrzezenia.push('Binance odpowiedzial na zapytanie o stan konta bez listy sald.');
      }
    } else {
      ostrzezenia.push(`Nie udalo sie odczytac stanu konta Binance (HTTP ${accRes.status}).`);
    }
  } catch (err) {
    console.warn('[Binance Sync] Account balance check warning:', err);
    ostrzezenia.push('Nie udalo sie polaczyc z Binance przy odczycie stanu konta.');
  }

  // exchangeInfo podaje jednoznacznie obie waluty pary; saldo pozwala rozszerzyc
  // zakres, a lista historyczna obejmuje aktywa juz nieobecne w saldzie.
  let symbolsToCheck: Array<{ symbol: string; baseAsset: string; quoteAsset: string }> = [];
  try {
    const infoRes = await fetch('https://api.binance.com/api/v3/exchangeInfo');
    if (!infoRes.ok) throw new Error(`HTTP ${infoRes.status}`);
    const info: any = await infoRes.json();
    if (!Array.isArray(info.symbols)) throw new Error('brak listy par');
    const activeAssets = new Set(openBalances.map((balance) => balance.asset));
    symbolsToCheck = info.symbols.filter((pair: any) =>
      typeof pair.symbol === 'string' && typeof pair.baseAsset === 'string' &&
      typeof pair.quoteAsset === 'string' &&
      (staleSymbols.includes(pair.symbol) ||
        (activeAssets.has(pair.baseAsset) && quoteAssets.has(pair.quoteAsset)))
    ).map((pair: any) => ({
      symbol: pair.symbol, baseAsset: pair.baseAsset, quoteAsset: pair.quoteAsset,
    }));
    for (const oldSymbol of staleSymbols) {
      if (!symbolsToCheck.some((pair) => pair.symbol === oldSymbol)) {
        ostrzezenia.push(`Para ${oldSymbol} nie wystepuje w exchangeInfo; jej historii nie odpytano.`);
        incompleteSymbols.push(oldSymbol);
      }
    }
  } catch (err) {
    console.warn('[Binance Sync] exchangeInfo warning:', err);
    ostrzezenia.push('Nie udalo sie odczytac listy par Binance (exchangeInfo); historia transakcji jest niepelna.');
    incompleteSymbols.push(...staleSymbols);
  }

  // fromId=0 zaczyna od najstarszej transakcji; bez niego API oddaje ostatnia strone.
  for (const { symbol, baseAsset, quoteAsset } of symbolsToCheck) {
    try {
      let fromId = 0;
      const pairTransactions: any[] = [];
      while (true) {
        const timestamp = Date.now();
        const queryString = `symbol=${symbol}&fromId=${fromId}&limit=1000&timestamp=${timestamp}&recvWindow=5000`;
        const signature = crypto.createHmac('sha256', cleanSecret).update(queryString).digest('hex');
        const url = `https://api.binance.com/api/v3/myTrades?${queryString}&signature=${signature}`;
        const response = await fetch(url, { headers: { 'X-MBX-APIKEY': cleanKey, 'Accept': 'application/json' } });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const trades: any[] = await response.json();
        if (!Array.isArray(trades) || trades.length > 1000) throw new Error('nieprawidlowa strona transakcji');
        let lastId = fromId - 1;
        for (const t of trades) {
          if (!Number.isSafeInteger(t.id) || t.id <= lastId || !Number.isFinite(t.time)) {
            throw new Error('nieprawidlowa kolejnosc transakcji');
          }
          lastId = t.id;
          const isBuy = t.isBuyer;
          const tradeDate = dzienWarszawski.format(new Date(t.time));
          const rozliczenieFiat = walutyFiat.has(baseAsset);
          const quantity = parseFloat(rozliczenieFiat ? t.quoteQty : t.qty);
          // W parze EURUSDT baza (qty) to kwota w EUR, a price to USDT za 1 EUR;
          // cena waluty wirtualnej w fiat to kwota EUR / ilosc USDT (quoteQty).
          const kwotaFiat = parseFloat(t.qty);
          const fiatUnitPrice = rozliczenieFiat ? kwotaFiat / quantity : parseFloat(t.price);
          if (rozliczenieFiat && (!Number.isFinite(quantity) || quantity <= 0 || !Number.isFinite(fiatUnitPrice))) {
            throw new Error('nieprawidlowa ilosc quoteQty dla pary z baza fiat');
          }
          pairTransactions.push({
            id: `bin_${symbol}_${t.id}_${t.orderId}`,
            accountId,
            ticker: rozliczenieFiat ? quoteAsset : baseAsset,
            name: `${rozliczenieFiat ? quoteAsset : baseAsset} Crypto (Binance)`,
            category: 'CRYPTO',
            type: (rozliczenieFiat ? !isBuy : isBuy) ? 'BUY' : 'SELL',
            date: tradeDate,
            quantity,
            pricePerUnit: fiatUnitPrice,
            currency: rozliczenieFiat ? baseAsset : quoteAsset,
            commission: parseFloat(t.commission || '0'),
            commissionCurrency: t.commissionAsset || quoteAsset,
            notes: `Auto-Sync Binance API (Trade #${t.id}, Para ${symbol})`,
          });
        }
        if (trades.length < 1000) break;
        fromId = lastId + 1;
      }
      transactions.push(...pairTransactions);
      completeSymbols.push(symbol);
    } catch (e) {
      console.warn(`[Binance Sync] Error fetching trades for ${symbol}:`, e);
      paryBezOdpowiedzi.push(`${symbol} (${e instanceof Error ? bezSekretow(e.message, 'blad odczytu') : 'blad odczytu'})`);
      incompleteSymbols.push(symbol);
    }
  }

  // 3. Salda bez pokrycia w historii transakcji
  //
  // Kazde takie saldo bylo tu wczesniej dopisywane do listy transakcji jako
  // zakup dokonany DZIS, po cenie 1 USD, z zerowa prowizja. Saldo 0,5 BTC
  // dostawalo koszt nabycia 0,50 USD - portfel pokazywal kilkadziesiat tysiecy
  // dolarow zysku, a rozliczenie podatku bralo te liczbe za prawde.
  // Data i cena nabycia sa nieznane, wiec nie ma z czego zrobic transakcji.
  const saldaBezHistorii = openBalances.filter(
    (bal) =>
      !walutyFiat.has(bal.asset) &&
      !['USDT', 'USDC', 'BUSD'].includes(bal.asset) &&
      bal.qty > 0 &&
      !transactions.some((t) => t.ticker === bal.asset)
  );
  if (saldaBezHistorii.length > 0) {
    ostrzezenia.push(
      `Binance pokazuje saldo ${saldaBezHistorii
        .map((b) => `${b.qty} ${b.asset}`)
        .join(', ')}, ale nie oddal transakcji, ktore je utworzyly. Te aktywa NIE zostaly ` +
        'dopisane - data i cena nabycia sa nieznane, a bez nich nie da sie policzyc podatku. ' +
        'Dodaj je recznie albo zaimportuj wyciag.'
    );
  }
  if (paryBezOdpowiedzi.length > 0) {
    ostrzezenia.push(
      `Historii nie udalo sie odczytac dla par: ${paryBezOdpowiedzi.join(', ')}. ` +
        'Lista transakcji moze byc niepelna.'
    );
  }
  ostrzezenia.push('API Binance nie wydaje historii par, ktorych nie odpytano (np. aktywow juz calkiem sprzedanych). Do rozliczenia podatku pelna jest dopiero historia wyeksportowana z Binance.');

  const wszystkoOdczytane = saldaOdczytane && symbolsToCheck.length > 0 && paryBezOdpowiedzi.length === 0;

  return {
    success: true,
    accountId,
    broker: 'BINANCE',
    message: wszystkoOdczytane
      ? `Odczytano ${transactions.length} transakcji z odpytanych par Binance API (historia podatkowa wymaga eksportu Binance).`
      : `Odczytano ${transactions.length} transakcji z Binance API, ale odczyt nie byl pelny.`,
    ostrzezenia,
    syncedTransactions: transactions,
    completeSymbols,
    incompleteSymbols: [...new Set(incompleteSymbols)],
    newTransactionsCount: transactions.length,
    syncTime: now,
  };
}

// 2. Interactive Brokers (IBKR Flex Web Service) Tester & Synchronizer
export async function testIBKRConnection(apiKey?: string, queryId?: string, accountNumber?: string) {
  const startTime = Date.now();
  const token = apiKey?.trim() || '';
  const qId = queryId?.trim() || accountNumber?.trim() || '';

  if (!token || !qId) {
    return {
      success: false,
      message: 'Wymagany jest Flex Web Service Token oraz Flex Query ID.',
      latencyMs: 0,
      broker: 'IBKR',
      error: 'Missing Flex Token / Query ID',
    };
  }

  try {
    const url = `https://www.interactivebrokers.com/Universal/servlet/FlexStatementService.SendRequest?t=${encodeURIComponent(token)}&q=${encodeURIComponent(qId)}&v=3`;
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'PortfolioTaxApp-IBKR-Client/1.0',
        'Accept': 'application/xml, text/xml, */*',
      },
    });

    const latencyMs = Date.now() - startTime;
    const xmlText = await response.text();

    if (response.ok && xmlText.includes('<Status>Success</Status>')) {
      const refMatch = xmlText.match(/<ReferenceCode>(.*?)<\/ReferenceCode>/);
      const refCode = refMatch ? refMatch[1] : 'OK';

      return {
        success: true,
        message: `Połączenie z IBKR Flex Web Service aktywne! Wygenerowano ReferenceCode: ${refCode}. Uprawnienia do pobierania historii transakcji, dywidend i pozycji aktywne.`,
        latencyMs,
        broker: 'IBKR',
        accountInfo: {
          accountNumber: qId,
          status: 'AUTHENTICATED',
          permissions: ['FLEX_STATEMENT_READ', 'EXECUTION_HISTORY', 'DIVIDENDS_AND_TAXES', 'OPEN_POSITIONS'],
        },
      };
    } else if (xmlText.includes('<ErrorCode>')) {
      const errCodeMatch = xmlText.match(/<ErrorCode>(.*?)<\/ErrorCode>/);
      const errMsgMatch = xmlText.match(/<ErrorMessage>(.*?)<\/ErrorMessage>/);
      const errCode = errCodeMatch ? errCodeMatch[1] : 'IBKR_ERROR';
      const errMsg = bezSekretow(
        errMsgMatch ? errMsgMatch[1] : '',
        'nieprawidłowy token lub identyfikator zapytania'
      );

      return {
        success: false,
        message: `Błąd IBKR Flex Service [${errCode}]: ${errMsg}`,
        latencyMs,
        broker: 'IBKR',
        error: errMsg,
      };
    } else {
      return {
        success: false,
        message: 'Serwer IBKR zwrócił nieoczekiwaną odpowiedź. Sprawdź poprawność Flex Web Service Token.',
        latencyMs,
        broker: 'IBKR',
        error: 'Invalid response format',
      };
    }
  } catch (err: any) {
    return {
      success: false,
      message: `Nie udało się połączyć z serwerem Interactive Brokers: ${bezSekretow(err?.message, 'błąd sieciowy')}`,
      latencyMs: Date.now() - startTime,
      broker: 'IBKR',
      error: bezSekretow(err?.message, 'błąd sieciowy'),
    };
  }
}

export async function syncIBKRTrades(
  payload: BrokerSyncPayload,
  czekaj: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms))
) {
  const { accountId, apiKey, queryId, accountNumber } = payload;
  const token = apiKey?.trim() || '';
  const qId = queryId?.trim() || accountNumber?.trim() || '';
  const now = new Date().toISOString();

  if (!token || !qId) {
    throw new Error('Wymagany jest Flex Web Service Token oraz Flex Query ID.');
  }

  const bladPobraniaRaportu = (message: string) => ({
    success: false,
    accountId,
    broker: 'IBKR',
    message,
    error: message,
    syncedTransactions: [] as any[],
    newTransactionsCount: 0,
    syncTime: now,
  });
  // Bez limitu zawieszone zapytanie do Flex trzymaloby synchronizacje w nieskonczonosc.
  const LIMIT_CZASU_FLEX_MS = 20_000;
  const komunikatBezOdpowiedzi = `IBKR Flex nie odpowiedział w ciągu ${LIMIT_CZASU_FLEX_MS / 1000} s. Spróbuj ponownie za chwilę.`;
  const pobierzZLimitem = async (url: string): Promise<{ res: globalThis.Response; xml: string } | null> => {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(LIMIT_CZASU_FLEX_MS) });
      return { res, xml: await res.text() };
    } catch (err: any) {
      if (err?.name === 'TimeoutError' || err?.name === 'AbortError') return null;
      throw err;
    }
  };

  // Step 1: Send Request
  const requestUrl = `https://www.interactivebrokers.com/Universal/servlet/FlexStatementService.SendRequest?t=${encodeURIComponent(token)}&q=${encodeURIComponent(qId)}&v=3`;
  const wynikZapytania = await pobierzZLimitem(requestUrl);
  if (!wynikZapytania) return bladPobraniaRaportu(komunikatBezOdpowiedzi);
  const { res: reqRes, xml: reqXml } = wynikZapytania;

  if (!reqRes.ok || !reqXml.includes('<Status>Success</Status>')) {
    const errMsgMatch = reqXml.match(/<ErrorMessage>(.*?)<\/ErrorMessage>/);
    throw new Error(errMsgMatch ? errMsgMatch[1] : 'Nie udało się zainicjować zapytania do IBKR Flex Service.');
  }

  const refMatch = reqXml.match(/<ReferenceCode>(.*?)<\/ReferenceCode>/);
  const refCode = refMatch ? refMatch[1] : '';

  // Wait for statement generation
  await czekaj(1500);

  // Step 2: Get Statement
  const getUrl = `https://www.interactivebrokers.com/Universal/servlet/FlexStatementService.GetStatement?q=${encodeURIComponent(refCode)}&t=${encodeURIComponent(token)}&v=3`;
  // Raport w toku (Status Warn / kod 1019) przychodzi jako HTTP 200 bez transakcji;
  // bez rozpoznania byl czytany jak pusty raport i synchronizacja "konczyla sie sukcesem".
  const MAX_PROB_POBRANIA = 5;
  let stmtXml = '';
  for (let proba = 1; ; proba++) {
    const odpowiedz = await pobierzZLimitem(getUrl);
    if (!odpowiedz) return bladPobraniaRaportu(komunikatBezOdpowiedzi);
    const { res: getRes } = odpowiedz;
    stmtXml = odpowiedz.xml;
    const koperta = /<FlexStatementResponse\b/.test(stmtXml);
    const status = koperta ? stmtXml.match(/<Status>([^<]*)<\/Status>/)?.[1]?.trim() : undefined;
    const kodBledu = stmtXml.match(/<ErrorCode>\s*(\d+)\s*<\/ErrorCode>/)?.[1];
    const komunikat = stmtXml.match(/<ErrorMessage>([^<]*)<\/ErrorMessage>/)?.[1]?.trim();
    // 1018 to limit zapytan z tokenu (tez Status Warn) - ponawianie tylko go pogarsza.
    if (kodBledu === '1018') {
      return bladPobraniaRaportu(
        `IBKR Flex: za dużo zapytań z tego tokenu (kod 1018). Odczekaj kilka minut i spróbuj ponownie${komunikat ? ` (${komunikat})` : ''}.`
      );
    }
    const wToku = kodBledu === '1019' || (koperta && status === 'Warn');
    if (wToku) {
      if (proba >= MAX_PROB_POBRANIA) {
        return bladPobraniaRaportu(
          `Raport IBKR Flex nadal jest generowany po ${MAX_PROB_POBRANIA} próbach. Spróbuj ponownie za chwilę.`
        );
      }
      await czekaj(2000);
      continue;
    }
    if (!getRes.ok) {
      return bladPobraniaRaportu(
        `IBKR Flex zwrócił błąd HTTP ${getRes.status}${komunikat ? `: ${komunikat}` : ''}.`
      );
    }
    if (status !== undefined && status !== 'Success') {
      return bladPobraniaRaportu(
        `IBKR Flex odrzucił pobranie raportu${kodBledu ? ` (kod ${kodBledu})` : ''}${komunikat ? `: ${komunikat}` : ''}.`
      );
    }
    break;
  }
  const transactions: any[] = [];
  /** Zapisy pominiete, bo raport nie podal daty - bez niej nie ma kursu NBP. */
  const bezDaty: string[] = [];
  /**
   * Zapisy pominiete, bo raport nie podal waluty. Podstawiony dolar
   * przeliczalby transakcje w EUR albo GBP po kursie USD.
   */
  const bezWaluty: string[] = [];
  /** Dywidendy bez symbolu instrumentu - kwota zostaje, ticker nie jest zmyslany. */
  const bezSymbolu: string[] = [];
  /** Ujemne wiersze dywidend (korekty) - nie sa przychodem. */
  const korektyDywidend: string[] = [];

  /**
   * Data z raportu Flex. IBKR podaje ja jako "20240311", "20240311;101500"
   * albo "2024-03-11" - zaleznie od ustawien zapytania.
   *
   * Wczesniej bylo tu `dateTime.slice(0, 10)` i podstawienie myslnikow, wiec
   * "20240311;101500" konczylo jako "2024-03-11;1" - lancuch, ktorego nie da
   * sie sparsowac, zapisany w polu daty transakcji.
   */
  const dataZFlex = (surowa: string): string | null => {
    const cyfry = surowa.replace(/\D/g, '');
    if (cyfry.length < 8) return null;
    const rok = Number(cyfry.slice(0, 4));
    const miesiac = Number(cyfry.slice(4, 6));
    const dzien = Number(cyfry.slice(6, 8));
    if (rok < 1990 || miesiac < 1 || miesiac > 12 || dzien < 1 || dzien > 31) return null;
    return `${cyfry.slice(0, 4)}-${cyfry.slice(4, 6)}-${cyfry.slice(6, 8)}`;
  };

  const getAttr = (attrsStr: string, name: string) => {
    const m = attrsStr.match(new RegExp(`${name}="([^"]*)"`));
    return m ? m[1] : '';
  };

  // 1. Parse <Trade> and <Order> items
  const tradeRegex = /<(?:Trade|Order)\s+([^>]+)\/>/g;
  let match;
  let idx = 0;

  while ((match = tradeRegex.exec(stmtXml)) !== null) {
    const attrsStr = match[1];
    const symbol = getAttr(attrsStr, 'symbol') || getAttr(attrsStr, 'underlyingSymbol');
    const dateTime = getAttr(attrsStr, 'dateTime') || getAttr(attrsStr, 'tradeDate');
    const quantity = parseFloat(getAttr(attrsStr, 'quantity') || '0');
    const tradePrice = parseFloat(getAttr(attrsStr, 'tradePrice') || getAttr(attrsStr, 'price') || '0');
    const currency = getAttr(attrsStr, 'currency').toUpperCase();
    const ibCommission = Math.abs(parseFloat(getAttr(attrsStr, 'ibCommission') || getAttr(attrsStr, 'commission') || '0'));
    const buySell = (getAttr(attrsStr, 'buySell') || (quantity >= 0 ? 'BUY' : 'SELL')).toUpperCase();
    const assetCategory = getAttr(attrsStr, 'assetCategory') === 'ETF' ? 'ETF' : 'STOCK_FOREIGN';

    if (symbol && quantity !== 0 && tradePrice > 0) {
      // Brak daty w raporcie dawal tu date DZISIEJSZA. Data wyznacza kurs NBP
      // i rok podatkowy, wiec transakcja sprzed lat wchodzila do biezacego
      // rozliczenia po dzisiejszym kursie. Bez daty nie da sie jej rozliczyc.
      const dateFormatted = dateTime ? dataZFlex(dateTime) : null;
      if (!dateFormatted) {
        bezDaty.push(`${symbol} ${quantity > 0 ? 'kupno' : 'sprzedaz'} ${Math.abs(quantity)}`);
        continue;
      }
      if (!currency) {
        bezWaluty.push(`${symbol} ${quantity > 0 ? 'kupno' : 'sprzedaz'} ${Math.abs(quantity)}`);
        continue;
      }
      idx++;
      transactions.push({
        id: `ibkr_${refCode}_trade_${idx}_${symbol}`,
        accountId,
        ticker: symbol,
        name: `${symbol} (IBKR)`,
        category: assetCategory,
        type: buySell.startsWith('B') ? 'BUY' : 'SELL',
        date: dateFormatted,
        quantity: Math.abs(quantity),
        pricePerUnit: tradePrice,
        currency,
        commission: ibCommission,
        commissionCurrency: currency,
        notes: `Auto-Sync IBKR Flex Query (${refCode})`,
      });
    }
  }

  // 2. Parse <CashTransaction> items
  //
  // Rodzaj wiersza wyznacza atrybut `type`. Wczesniej wystarczylo, ze opis zawieral
  // "dividend", wiec wiersz "Withholding Tax" (opis "... CASH DIVIDEND ... - US TAX",
  // kwota ujemna) stawal sie osobna dywidenda z Math.abs: przychod rosl o podatek,
  // a podatek u zrodla wynosil 0. Teraz Withholding Tax jest podatkiem przypisanym do
  // dywidendy o tym samym symbolu, walucie i dniu.
  const dywidendyZPodatkiem: Array<{ transakcja: any; dni: Set<string>; podatek: number }> = [];
  const storna: Array<{ symbol: string; currency: string; amount: number; data: string; opis: string }> = [];
  const wierszePodatku: Array<{ symbol: string; currency: string; dni: Set<string>; amount: number; opis: string }> = [];
  const dniWiersza = (attrsStr: string): Set<string> => new Set(
    ['dateTime', 'settleDate', 'reportDate', 'availableForTradingDate']
      .map((atrybut) => getAttr(attrsStr, atrybut))
      .map((surowa) => (surowa ? dataZFlex(surowa) : null))
      .filter((dzien): dzien is string => dzien !== null)
  );
  const cashRegex = /<CashTransaction\s+([^>]+)\/>/g;
  while ((match = cashRegex.exec(stmtXml)) !== null) {
    const attrsStr = match[1];
    const type = getAttr(attrsStr, 'type').toLowerCase();
    const description = getAttr(attrsStr, 'description') || getAttr(attrsStr, 'type');
    const symbol = getAttr(attrsStr, 'symbol');
    const amount = parseFloat(getAttr(attrsStr, 'amount') || '0');
    const currency = getAttr(attrsStr, 'currency').toUpperCase();
    const dateTime = getAttr(attrsStr, 'dateTime') || getAttr(attrsStr, 'reportDate');

    if (type.includes('withholding')) {
      wierszePodatku.push({ symbol: symbol.toUpperCase(), currency, dni: dniWiersza(attrsStr), amount, opis: symbol || description });
      continue;
    }

    if (type ? type.includes('divid') : description.toLowerCase().includes('dividend')) {
      if (!currency) {
        bezWaluty.push(`dywidenda ${symbol || description}`);
        continue;
      }
      const dateFormatted = dateTime ? dataZFlex(dateTime) : null;
      if (!dateFormatted) {
        bezDaty.push(`dywidenda ${symbol || description}`);
        continue;
      }
      // Ujemna kwota to korekta/zwrot (storno) dywidendy. Math.abs zamienial ja w
      // kolejny przychod. Storno kasuje pasujaca wyplate (petla ponizej); bez pary jest
      // pomijane z ostrzezeniem.
      if (!(amount > 0)) {
        storna.push({ symbol: symbol.toUpperCase(), currency, amount, data: dateFormatted, opis: `${symbol || description} (${amount} ${currency}, ${dateFormatted})` });
        continue;
      }
      idx++;
      const grossAmount = amount;
      if (!symbol) {
        bezSymbolu.push(`${description} (${grossAmount} ${currency})`);
      }

      const transakcja = {
        id: `ibkr_${refCode}_div_${idx}_${symbol || 'DIV'}`,
        accountId,
        // Bez symbolu wpis nazywal sie instrumentem "DIVIDEND". Kwota jest
        // potrzebna do rozliczenia, wiec zostaje - ale nie udaje tickera.
        ticker: symbol || 'BEZ_SYMBOLU',
        name: symbol ? `${symbol} (IBKR Dywidenda)` : `IBKR Dywidenda: ${description}`,
        category: 'STOCK_FOREIGN',
        type: 'DIVIDEND',
        date: dateFormatted,
        quantity: 1,
        pricePerUnit: grossAmount,
        currency,
        commission: 0,
        commissionCurrency: currency,
        // Podatek u zrodla dopisuje petla ponizej z wierszy Withholding Tax; gdy
        // raport ich nie zawiera, pole zostaje puste (stawka nieznana, nie 15%).
        foreignTaxAmount: 0,
        foreignTaxRate: undefined as number | undefined,
        notes: `Wypłata dywidendy IBKR: ${description}`,
      };
      transactions.push(transakcja);
      dywidendyZPodatkiem.push({ transakcja, dni: dniWiersza(attrsStr), podatek: 0 });
    }
  }

  // Wzorzec wyplata / storno / ponowna wyplata: bez skasowania pary zostawaly dwie
  // dodatnie wyplaty (przychod podwojony). Storno usuwa jedna wczesniejsza wyplate o tym
  // samym symbolu, walucie i kwocie; bez takiej pary trafia do ostrzezen jak dotad.
  for (const storno of storna) {
    const kwota = -storno.amount;
    const indeks = storno.symbol
      ? dywidendyZPodatkiem.findIndex((dyw) =>
        dyw.transakcja.ticker.toUpperCase() === storno.symbol
        && dyw.transakcja.currency === storno.currency
        && Math.abs(dyw.transakcja.pricePerUnit - kwota) < 1e-9
        && dyw.transakcja.date <= storno.data)
      : -1;
    if (indeks < 0) {
      korektyDywidend.push(storno.opis);
      continue;
    }
    const [usunieta] = dywidendyZPodatkiem.splice(indeks, 1);
    transactions.splice(transactions.indexOf(usunieta.transakcja), 1);
  }
  const podatkiBezDywidendy: string[] = [];
  for (const wiersz of wierszePodatku) {
    const pasujace = wiersz.symbol
      ? dywidendyZPodatkiem.filter((dyw) =>
        dyw.transakcja.ticker.toUpperCase() === wiersz.symbol
        && dyw.transakcja.currency === wiersz.currency
        && [...wiersz.dni].some((dzien) => dyw.dni.has(dzien)))
      : [];
    if (pasujace.length === 0) {
      podatkiBezDywidendy.push(`${wiersz.opis} (${wiersz.amount} ${wiersz.currency || '?'})`);
      continue;
    }
    // Ujemna kwota to pobrany podatek, dodatnia - jego zwrot. Kilka dywidend tego
    // samego dnia dzieli podatek proporcjonalnie do kwot brutto.
    const sumaBrutto = pasujace.reduce((suma, dyw) => suma + dyw.transakcja.pricePerUnit, 0);
    for (const dyw of pasujace) {
      dyw.podatek += (-wiersz.amount * dyw.transakcja.pricePerUnit) / sumaBrutto;
    }
  }
  for (const dyw of dywidendyZPodatkiem) {
    const podatek = Math.max(0, Math.round(dyw.podatek * 1e6) / 1e6);
    dyw.transakcja.foreignTaxAmount = podatek;
    const brutto = dyw.transakcja.pricePerUnit;
    // Stawka tylko z odczytanych kwot, nigdy zalozona (dawniej wpisywano tu 15%).
    dyw.transakcja.foreignTaxRate = brutto > 0 && podatek > 0 ? Number(((podatek / brutto) * 100).toFixed(1)) : undefined;
  }
  // 3. Parse <OpenPosition> items
  const pozycjeBezTransakcji: string[] = [];

  const openPosRegex = /<OpenPosition\s+([^>]+)\/>/g;
  while ((match = openPosRegex.exec(stmtXml)) !== null) {
    const attrsStr = match[1];
    const symbol = getAttr(attrsStr, 'symbol');
    const position = parseFloat(getAttr(attrsStr, 'position') || '0');
    const costPrice = parseFloat(getAttr(attrsStr, 'costBasisPrice') || getAttr(attrsStr, 'markPrice') || '0');
    const currency = getAttr(attrsStr, 'currency').toUpperCase();
    const assetCategory = getAttr(attrsStr, 'assetCategory') === 'ETF' ? 'ETF' : 'STOCK_FOREIGN';

    // Otwarta pozycja bez transakcji w raporcie byla tu dopisywana jako zakup
    // z DZISIEJSZA data. Data decyduje o kursie NBP i o roku podatkowym, wiec
    // pozycja kupiona trzy lata temu wchodzila do rozliczenia po dzisiejszym
    // kursie i w biezacym roku. Prawdziwej daty raport Flex w tym miejscu nie
    // podaje, wiec transakcji nie da sie z tego zrobic.
    const alreadyInTrades = transactions.some((t) => t.ticker === symbol && t.type === 'BUY');
    if (symbol && position > 0 && !alreadyInTrades) {
      pozycjeBezTransakcji.push(`${position} ${symbol}`);
    }
  }

  const ostrzezenia: string[] = [];
  if (bezWaluty.length > 0) {
    ostrzezenia.push(
      `Raport nie podal waluty dla: ${bezWaluty.join(', ')}. Te zapisy zostaly pominiete - ` +
        'waluta wyznacza kurs NBP, a podstawiony dolar zmienilby kwote w zlotych.'
    );
  }
  if (bezDaty.length > 0) {
    ostrzezenia.push(
      `Raport nie podal daty dla: ${bezDaty.join(', ')}. Te zapisy zostaly pominiete - ` +
        'bez daty nie da sie ustalic kursu NBP ani roku podatkowego.'
    );
  }
  if (podatkiBezDywidendy.length > 0) {
    ostrzezenia.push(
      `Podatek u źródła bez pasującej dywidendy (ten sam symbol, waluta i dzień): ${podatkiBezDywidendy.join(', ')}. ` +
        'Nie został dopisany do żadnej dywidendy - uzupełnij go ręcznie.'
    );
  }
  if (korektyDywidend.length > 0) {
    ostrzezenia.push(
      `Korekty dywidend (kwota ujemna): ${korektyDywidend.join(', ')}. Wiersze pominięte - ` +
        'to nie jest przychód; ujmij korektę ręcznie przy właściwej dywidendzie.'
    );
  }
  if (bezSymbolu.length > 0) {
    ostrzezenia.push(
      `Dywidendy bez symbolu instrumentu: ${bezSymbolu.join(', ')}. Kwoty sa w rozliczeniu, ` +
        'ale ticker wymaga uzupelnienia recznie.'
    );
  }
  if (pozycjeBezTransakcji.length > 0) {
    ostrzezenia.push(
      `Raport Flex pokazuje otwarte pozycje bez transakcji, ktore je utworzyly: ` +
        `${pozycjeBezTransakcji.join(', ')}. NIE zostaly dopisane - raport nie podaje daty ` +
        'nabycia, a bez niej nie da sie ustalic kursu NBP ani roku podatkowego. Rozszerz ' +
        'zakres dat w Flex Query albo dodaj te transakcje recznie.'
    );
  }

  return {
    success: true,
    accountId,
    broker: 'IBKR',
    message: `Odczytano ${transactions.length} ${odmienLiczebnik(transactions.length, 'transakcję lub dywidendę', 'transakcje i dywidendy', 'transakcji i dywidend')} z raportu IBKR Flex Query.`,
    ostrzezenia,
    syncedTransactions: transactions,
    newTransactionsCount: transactions.length,
    syncTime: now,
  };
}

// 3. Freedom24 (Tradernet API) Multi-Protocol Handler & Synchronizer
//
// Official API docs: https://tradernet.com/tradernet-api
// Endpoint:  POST https://tradernet.com/api/{command}
// Signature: HMAC-SHA256( JSON_body + unix_timestamp, private_key )
// Headers:   X-NtApi-PublicKey, X-NtApi-Sig, X-NtApi-Timestamp
//
// Dokumentacja mowi, ze dziala kazda strefa domenowa, ale podpisane zadanie
// z kluczem klienta wysylamy tylko tam, gdzie jest jego rachunek: freedom24.com
// i tradernet.com.
/** Polecenia odczytu dozwolone w starszej sciezce z kluczami z zadania. */
export const LEGACY_TRADERNET_READ_COMMANDS: ReadonlySet<string> = new Set([
  ...FREEDOM24_READ_ONLY_COMMANDS,
  'getClientCpsHistory',
  'getCpsFiles',
  'getHloc',
  'getNewsList',
  'getOrdersHistory',
  'getTopSecurities',
  'getUserStockLists',
]);

export async function sendTradernetRequest(
  cmd: string,
  params: any,
  apiKey: string,
  apiSecret: string
): Promise<{
  success: boolean;
  data?: any;
  endpoint?: string;
  error?: string;
  errorCode?: string;
  diagnostics?: {
    signatureVerified: boolean;
    keyFormatValid: boolean;
    keyPreview: string;
    /**
     * Nigdy fragment sekretu. Diagnostyka oddawala pierwsze i ostatnie trzy
     * znaki klucza prywatnego w odpowiedzi HTTP - do przegladarki, do logow
     * posrednikow i na zrzuty ekranu.
     */
    secretPreview: string;
    attemptedEndpoints: string[];
    lastStatus?: number;
    lastRawResponse?: string;
    protocolVariant?: string;
    qSnippet?: string;
  };
}> {
  const cleanKey = apiKey.trim();
  const cleanSecret = apiSecret.trim();

  // Integracja Freedom24 jest wylacznie do odczytu. Starsze trasy (zlecenia,
  // SL/TP, anulowanie, edycja list obserwowanych) nadal istnieja w tym pliku,
  // ale zadne polecenie zmieniajace rachunek nie moze opuscic serwera.
  if (!LEGACY_TRADERNET_READ_COMMANDS.has(cmd)) {
    return {
      success: false,
      error: `Polecenie ${cmd} zmienia stan rachunku. Integracja Freedom24 działa tylko do odczytu - nic nie wysłano.`,
      errorCode: 'FREEDOM24_READ_ONLY',
    };
  }

  if (!cleanKey || !cleanSecret) {
    return {
      success: false,
      error: 'Brak klucza publicznego lub prywatnego.',
      errorCode: 'MISSING_KEYS',
      diagnostics: {
        signatureVerified: false,
        keyFormatValid: false,
        keyPreview: cleanKey ? `${cleanKey.slice(0, 4)}...` : 'Brak',
        secretPreview: cleanSecret ? `podany (${cleanSecret.length} znaków)` : 'Brak',
        attemptedEndpoints: [],
      },
    };
  }

  if (cleanKey === cleanSecret) {
    return {
      success: false,
      error: 'Wykryto zdublowany klucz: Klucz publiczny API i klucz Secret są identyczne. Podaj odrębny Public API Key i Secret Key z panelu Tradernet.',
      errorCode: 'DUPLICATE_KEYS',
      diagnostics: {
        signatureVerified: false,
        keyFormatValid: false,
        keyPreview: `${cleanKey.slice(0, 4)}...`,
        secretPreview: `podany (${cleanSecret.length} znaków)`,
        attemptedEndpoints: [],
      },
    };
  }

  const safeParams = params || {};
  const hasParams = Object.keys(safeParams).length > 0;
  const paramsJson = hasParams ? JSON.stringify(safeParams) : '';
  const timestamp = String(Math.floor(Date.now() / 1000));

  // q= style payload (v1, as shown in jQuery examples in official docs)
  const qPayload = JSON.stringify({ cmd, params: safeParams });
  const qFormBody = `q=${encodeURIComponent(qPayload)}`;

  // Signature variants:
  // 1) Official per docs: HMAC-SHA256(json_body + timestamp, secret) — for /api/{command}
  // 2) V1 q= style:       HMAC-SHA256(q_json_string + timestamp, secret) — for /api/ with q= body
  // 3) V2 REST fallback:  HMAC-SHA256(params_json_or_empty, secret) — for /api/v2/cmd/{command}
  let sigOfficial = '';
  let sigQ = '';
  let sigV2 = '';

  try {
    sigOfficial = crypto.createHmac('sha256', cleanSecret).update(paramsJson + timestamp).digest('hex');
    sigQ = crypto.createHmac('sha256', cleanSecret).update(qPayload + timestamp).digest('hex');
    sigV2 = crypto.createHmac('sha256', cleanSecret).update(paramsJson).digest('hex');
  } catch (hmacErr: any) {
    return {
      success: false,
      error: `Błąd generowania sygnatury kryptograficznej HMAC: ${hmacErr.message}`,
      errorCode: 'HMAC_GEN_ERROR',
      diagnostics: {
        signatureVerified: false,
        keyFormatValid: false,
        keyPreview: `${cleanKey.slice(0, 4)}...`,
        secretPreview: `podany (${cleanSecret.length} znaków)`,
        attemptedEndpoints: [],
      },
    };
  }

  /**
   * Strefy, do ktorych wolno wyslac podpisane zadanie.
   *
   * Wczesniej lista zaczynala sie od `tradernet.ru`, potem `.by` i `.kz`,
   * a `freedom24.com` bylo na koncu. Kazde wywolanie API wysylalo wiec klucz
   * publiczny i podpisane zadanie najpierw do serwerow w Rosji, na Bialorusi
   * i w Kazachstanie - do podmiotow, ktore nie prowadza rachunku klienta
   * z Unii - zanim trafilo do wlasciwej strefy. Do tego bledy raportowal
   * ostatni odpytany host, wiec komunikat wskazywal nie te przyczyne.
   *
   * Rachunek europejski obsluguje Freedom24 (Freedom Finance Europe), wiec
   * pytamy wylacznie jego strefy.
   */
  const domains = ['freedom24.com', 'tradernet.com'];

  let lastError = 'Nie udało się nawiązać połączenia z serwerami Freedom24.';
  let lastErrorCode: string | undefined;
  let lastStatus: number | undefined;
  let lastRawResponse: string | undefined;
  const attemptedEndpoints: string[] = [];

  // For each domain, try three protocol variants:
  //   1) Official REST:    POST /api/{command}  body=paramsJSON  sig=HMAC(body+ts)
  //   2) V1 q= form:      POST /api/           body=q=JSON      sig=HMAC(qJSON+ts)
  //   3) V2 REST fallback: POST /api/v2/cmd/{command}  body=paramsJSON  sig=HMAC(body)
  for (const domain of domains) {
    const attempts = [
      {
        name: 'Official-REST',
        url: `https://${domain}/api/${cmd}`,
        body: paramsJson || undefined,
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'X-NtApi-PublicKey': cleanKey,
          'X-NtApi-Sig': sigOfficial,
          'X-NtApi-Timestamp': timestamp,
        },
      },
      {
        name: 'V1-Form-Q',
        url: `https://${domain}/api/`,
        body: qFormBody,
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
          'Accept': 'application/json',
          'X-NtApi-PublicKey': cleanKey,
          'X-NtApi-Sig': sigQ,
          'X-NtApi-Timestamp': timestamp,
        },
      },
      {
        name: 'V2-REST-Cmd',
        url: `https://${domain}/api/v2/cmd/${cmd}`,
        body: paramsJson || undefined,
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'X-NtApi-PublicKey': cleanKey,
          'X-NtApi-Sig': sigV2,
        },
      },
    ];

    for (const req of attempts) {
      attemptedEndpoints.push(req.url);
      try {
        const response = await fetch(req.url, {
          method: 'POST',
          headers: req.headers,
          body: req.body,
          signal: AbortSignal.timeout(5000),
        });

        lastStatus = response.status;
        const text = await response.text();
        // Surowa odpowiedz potrafi zawierac echo naglowkow zadania - przed
        // odeslaniem przechodzi przez ten sam filtr co komunikaty bledow.
        lastRawResponse = bezSekretow(text.slice(0, 300), 'brak tresci odpowiedzi');

        let json: any = null;
        try {
          json = JSON.parse(text);
        } catch {
          // Non-JSON (e.g. Cloudflare HTML block page)
        }

        if (response.ok && json) {
          if (
            json.errMsg ||
            json.error ||
            (json.code !== undefined && json.code !== 0 && json.code !== '0' && json.code !== 200)
          ) {
            const errDetail = bezSekretow(
              json.errMsg || json.error || json.message || `kod ${json.code}`,
              'żądanie odrzucone'
            );
            lastError = `Serwer Freedom24 (${domain}) zwrócił: ${errDetail}`;
            lastErrorCode = json.errMsg || json.error ? 'TRADERNET_ERROR' : `CODE_${json.code}`;
            continue;
          }

          return {
            success: true,
            data: json,
            endpoint: req.url,
            diagnostics: {
              signatureVerified: true,
              keyFormatValid: true,
              keyPreview: `${cleanKey.slice(0, 4)}...${cleanKey.slice(-3)}`,
              secretPreview: `podany (${cleanSecret.length} znaków)`,
              attemptedEndpoints,
              lastStatus: response.status,
              protocolVariant: req.name,
              qSnippet: paramsJson.slice(0, 100),
            },
          };
        } else {
          lastError = `Serwer Freedom24 (${domain}) zwrócił błąd HTTP ${response.status}.`;
          lastErrorCode = `HTTP_${response.status}`;
        }
      } catch (err: any) {
        lastError = 'Błąd sieci lub połączenia z serwerami Tradernet.';
      }
    }
  }

  return {
    success: false,
    error: lastError,
    errorCode: lastErrorCode || 'UNKNOWN_ERROR',
    diagnostics: {
      // Po nieudanych probach diagnostyka mowila "signatureVerified: true",
      // czyli ze broker przyjal podpis HMAC - a nie przyjal go ani razu.
      // Uzytkownik szukajacy przyczyny odczytywal z tego, ze klucze sa dobre.
      signatureVerified: false,
      keyFormatValid: true,
      keyPreview: `${cleanKey.slice(0, 4)}...${cleanKey.slice(-3)}`,
      secretPreview: `podany (${cleanSecret.length} znaków)`,
      attemptedEndpoints,
      lastStatus,
      lastRawResponse,
      qSnippet: paramsJson.slice(0, 100),
    },
  };
}

export async function testFreedom24Connection(apiKey?: string, apiSecret?: string) {
  const startTime = Date.now();
  if (!apiKey?.trim() || !apiSecret?.trim()) {
    return {
      success: false,
      message: 'Brak kluczy API dla Freedom24 (Tradernet). Podaj API Key oraz Secret Key.',
      latencyMs: 0,
      broker: 'FREEDOM24',
      error: 'Missing Freedom24 credentials',
    };
  }

  const cleanKey = apiKey.trim();
  const cleanSecret = apiSecret.trim();

  const commandsToTest = [
    { cmd: 'getPositionJson', params: {} },
    { cmd: 'getTradesHistory', params: {} },
  ];

  let lastRes: any = null;

  for (const item of commandsToTest) {
    const res = await sendTradernetRequest(item.cmd, item.params, cleanKey, cleanSecret);
    lastRes = res;
    if (res && res.success) {
      const latencyMs = Date.now() - startTime;
      const endpointHost = res.endpoint ? new URL(res.endpoint).hostname : 'freedom24.com';
      // Brak identyfikatora konta dawal tekst "Uzytkownik Freedom24", ktory
      // trafial dalej jako accountNumber - nazwa wygladajaca na odczytana.
      const userLogin: string | undefined = res.data?.result?.ps?.key || undefined;
      return {
        success: true,
        message: `Połączono pomyślnie z Freedom24 Tradernet API (${endpointHost})${
          userLogin ? ` [Konto: ${userLogin}]` : ' (broker nie podał identyfikatora konta)'
        }. Polecenie ${item.cmd} zostało przyjęte.`,
        latencyMs,
        broker: 'FREEDOM24',
        accountInfo: {
          accountNumber: userLogin,
          status: 'ACTIVE',
          endpoint: res.endpoint,
          // Wczesniej byl tu staly zestaw czterech uprawnien, wypisywany po
          // udanym jednym poleceniu. Wymieniamy tylko to, co faktycznie przeszlo.
          permissions: [item.cmd],
        },
        diagnostics: {
          endpoint: res.endpoint,
          protocolVariant: res.diagnostics?.protocolVariant,
          signatureVerified: true,
          keyFormatValid: true,
          details: `Zweryfikowano z serwerem ${endpointHost}. Sygnatura HMAC-SHA256 zaakceptowana dla ${item.cmd}.`,
        },
      };
    }
  }

  const latencyMs = Date.now() - startTime;
  // Odpowiedz w HTML zamiast JSON to strona blokujaca (Cloudflare), a nie
  // odmowa API. Komunikat "sprawdz poprawnosc kluczy" wysylal wtedy
  // uzytkownika do panelu Tradernet po klucze, ktore sa poprawne - zadanie
  // w ogole nie doszlo do interfejsu brokera.
  const surowa = String(lastRes?.diagnostics?.lastRawResponse || '');
  const zablokowanePrzezWaf = /<!DOCTYPE html|<html|Attention Required|Cloudflare/i.test(surowa);
  return {
    success: false,
    message: zablokowanePrzezWaf
      ? `Zapytanie nie dotarło do API Freedom24 - w odpowiedzi przyszła strona blokująca (Cloudflare), nie odpowiedź brokera. To nie jest błąd kluczy. Sprawdź, czy z tej sieci otwiera się tradernet.com w przeglądarce.`
      : `Błąd autoryzacji Freedom24: ${lastRes?.error || 'Nieprawidłowa sygnatura lub brak odpowiedzi'}. Sprawdź poprawność klucza publicznego i prywatnego w panelu Tradernet.`,
    latencyMs,
    broker: 'FREEDOM24',
    error: lastRes?.error || 'Authorization failed',
    errorCode: zablokowanePrzezWaf ? 'WAF_BLOCKED' : lastRes?.errorCode || 'AUTH_FAILED',
    diagnostics: lastRes?.diagnostics || {
      signatureVerified: false,
      keyFormatValid: true,
      details: lastRes?.error || 'Błąd autoryzacji Tradernet',
    },
  };
}

const KLUCZE_STRONY_TRANSAKCJI = [
  'operation', 'Operation', 'operation_type', 'operationType', 'oper',
  'side', 'Side', 'type', 'Type', 'Typ', 'Rodzaj zlecenia',
];

/**
 * Strona transakcji rozpoznawana jak `determine_side` w silniku (normalize/trades.py):
 * tylko jawne kody ('1'/buy/kupno -> BUY, '2'/sell/sprzedaz -> SELL), z kilku pol.
 * Sprzeczne albo nieznane kody daja null - wiersz nie moze po cichu zostac kupnem.
 */
export function stronaTransakcjiFreedom24(wiersz: Record<string, unknown>): 'BUY' | 'SELL' | null {
  const rozpoznane = new Set<'BUY' | 'SELL'>();
  for (const klucz of KLUCZE_STRONY_TRANSAKCJI) {
    const surowa = wiersz?.[klucz];
    if (surowa === undefined || surowa === null || String(surowa).trim() === '') continue;
    const kod = String(surowa).trim().toLowerCase();
    if (['2', 'sell', 's', 'sprzedaż', 'sprzedaz'].includes(kod) || kod.includes('sprzeda') || kod.includes('sell')) {
      rozpoznane.add('SELL');
    } else if (kod.includes('wykup')) {
      return null;
    } else if (['1', 'buy', 'b', 'kupno', 'zakup', 'purchase'].includes(kod)
      || kod.includes('kup') || kod.includes('zakup') || kod.includes('buy') || kod.includes('purchase')) {
      rozpoznane.add('BUY');
    }
  }
  return rozpoznane.size === 1 ? [...rozpoznane][0] : null;
}

export async function syncFreedom24Trades(payload: BrokerSyncPayload) {
  const { accountId, apiKey, apiSecret } = payload;
  const now = new Date().toISOString();

  if (!apiKey?.trim() || !apiSecret?.trim()) {
    return {
      success: false,
      accountId,
      broker: 'FREEDOM24',
      message: 'Brak kluczy API dla Freedom24 (Tradernet). Wprowadź API Key oraz Secret Key w ustawieniach konta.',
      syncedTransactions: [],
      newTransactionsCount: 0,
      syncTime: now,
      error: 'Missing Freedom24 API credentials',
    };
  }

  const cleanKey = apiKey.trim();
  const cleanSecret = apiSecret.trim();
  const transactions: any[] = [];
  const ostrzezenia: string[] = [];
  /** Transakcje bez czytelnej daty - bez niej nie ma kursu NBP ani roku. */
  const bezDaty: string[] = [];
  /** Transakcje bez waluty - podstawiony dolar zmienilby kwote w zlotych. */
  const bezWaluty: string[] = [];
  /** Wiersze bez rozpoznanej strony (kupno/sprzedaz) - nie zgadujemy jej. */
  const bezStrony: string[] = [];
  /** Wiersze z ilosca lub cena, ktorej nie da sie odczytac (NaN/0). */
  const bezIlosciLubCeny: string[] = [];
  /** Wiersze bez symbolu instrumentu. */
  let bezSymboluLicznik = 0;
  /** Pary walutowe pomijane z listy transakcji (to nie papiery wartosciowe). */
  let pominietePary = 0;
  /** Pozycje otwarte bez transakcji w historii; nie da sie z nich zrobic zakupu. */
  const pozycjeBezTransakcji: string[] = [];

  const normalizeTicker = (rawSymbol: string) => {
    let clean = (rawSymbol || '').toUpperCase().trim();
    clean = clean.replace(/\.(US|EU|DE|UK|L|PL|PA|TO)$/, '');
    const isETF =
      clean.includes('ETF') ||
      ['VOO', 'SPY', 'QQQ', 'VTI', 'VWCE', 'IWDA', 'EUNL', 'CSPX', 'SXR8', 'VUSA'].includes(clean);
    const isPL = clean.endsWith('.PL') || ['CDR', 'PKO', 'PZU', 'KGH', 'DNP', 'ALE'].includes(clean);
    const category = isETF ? 'ETF' : isPL ? 'STOCK_PL' : 'STOCK_FOREIGN';
    return { ticker: clean, category };
  };

  // 1. Fetch trade execution history
  try {
    const tradesRes = await sendTradernetRequest('getTradesHistory', {}, cleanKey, cleanSecret);
    if (!tradesRes?.success) {
      // Wynik `success` byl tu wczesniej ignorowany, wiec nieudany odczyt
      // historii konczyl sie komunikatem o pomyslnej synchronizacji.
      ostrzezenia.push(
        `Nie udalo sie odczytac historii transakcji: ${
          tradesRes?.error || 'brak odpowiedzi Tradernet'
        }.`
      );
    }
    const tradesData = tradesRes?.data;
    const tradeList: any[] =
      tradesData?.trades?.trade ||
      tradesData?.trades ||
      tradesData?.result?.trades?.trade ||
      tradesData?.result?.trades ||
      (Array.isArray(tradesData) ? tradesData : []);

    if (Array.isArray(tradeList) && tradeList.length > 0) {
      tradeList.forEach((item: any, idx: number) => {
        const rawTicker = item.instr_nm || item.ticker || item.symbol || item.sec_code || item.name;
        if (!rawTicker) {
          bezSymboluLicznik += 1;
          return;
        }

        // Skip internal cash currency pairs for stock trades if needed
        if (rawTicker === 'PLN/USD' || rawTicker === 'USD/PLN' || rawTicker === 'EUR/USD') {
          pominietePary += 1;
          return;
        }

        const { ticker, category } = normalizeTicker(rawTicker);
        const qty = Math.abs(parseFloat(item.q || item.qty || item.quantity || item.amount || '0'));
        const price = parseFloat(item.p || item.price || item.trade_price || item.cost || '0');
        const comm = Math.abs(parseFloat(item.commission || item.comm || item.fee || '0'));
        const currency = String(item.curr_c || item.curr || item.currency || '').toUpperCase();
        const commCurrency = (item.commission_currency || currency).toUpperCase();

        const type = stronaTransakcjiFreedom24(item);
        if (!(qty > 0 && price > 0)) {
          bezIlosciLubCeny.push(`${ticker} (ilość ${item.q ?? item.qty ?? item.quantity ?? item.amount ?? 'brak'}, cena ${item.p ?? item.price ?? item.trade_price ?? item.cost ?? 'brak'})`);
          return;
        }
        if (!type) {
          bezStrony.push(`${ticker} ${qty}`);
          return;
        }

        // Data zdarzenia podatkowego to dzien zawarcia transakcji na gieldzie
        // (`trade_d_exch`), a nie znacznik ksiegowania (`date`) ani dzien
        // rozliczenia (`pay_d`).
        //
        // Na prawdziwym rachunku 22 z 542 transakcji ma w polu `date` dzien
        // pozniejszy niz `trade_d_exch`: znacznik ksiegowania jest w innej
        // strefie czasowej i przy transakcjach z konca sesji przechodzi na
        // kolejna dobe. Kurs NBP bierze sie z dnia roboczego poprzedzajacego
        // zdarzenie, wiec przesuniety dzien to inny kurs, a na przelomie roku
        // takze inny rok podatkowy. Silnik liczy z `exchange_time`
        // (EXECUTION_DATE_FIRST w fx_engine.py), wiec ta sciezka musi wybierac
        // tak samo - inaczej portfel i deklaracja pokazuja rozne kwoty.
        //
        // `pay_d` odpada: to rozliczenie T+1/T+2, a w danych rachunku zdarza
        // sie z data o rok pozniejsza niz transakcja.
        const rawDate = item.trade_d_exch || item.date;
        const dateStr =
          typeof rawDate === 'string' && /^\d{4}-\d{2}-\d{2}/.test(rawDate)
            ? rawDate.slice(0, 10)
            : null;
        if (qty > 0 && price > 0 && !dateStr) {
          bezDaty.push(`${ticker} ${qty}`);
          return;
        }
        if (qty > 0 && price > 0 && !currency) {
          bezWaluty.push(`${ticker} ${qty}`);
          return;
        }

        if (qty > 0 && price > 0 && dateStr) {
          const uniqueId = `fr24_${accountId}_trade_${item.id || item.order_id || idx}_${ticker}`;
          transactions.push({
            id: uniqueId,
            accountId,
            ticker,
            name: `${ticker} (Freedom24)`,
            category,
            type,
            date: dateStr,
            quantity: qty,
            pricePerUnit: price,
            currency,
            commission: comm,
            commissionCurrency: commCurrency,
            notes: `Auto-Sync Freedom24 API (Zlecenie #${item.order_id || item.id}, ${item.trade_nb || 'Tradernet'})`,
          });
        }
      });
    }

    // 2. Fetch Open Positions
    const posRes = await sendTradernetRequest('getPositionJson', {}, cleanKey, cleanSecret);
    if (!posRes?.success) {
      ostrzezenia.push(
        `Nie udalo sie odczytac otwartych pozycji: ${
          posRes?.error || 'brak odpowiedzi Tradernet'
        }.`
      );
    }
    const posList: any[] = posRes?.data?.result?.ps?.pos || posRes?.data?.pos || [];

    if (Array.isArray(posList)) {
      posList.forEach((posItem: any, idx: number) => {
        const rawTicker = posItem.i || posItem.base_contract_code || posItem.name;
        if (!rawTicker) return;

        const { ticker, category } = normalizeTicker(rawTicker);
        const qty = Math.abs(parseFloat(posItem.q || posItem.open_bal || '0'));
        const costPrice = parseFloat(posItem.bal_price_a || posItem.price_a || posItem.mkt_price || '0');
        const currency = (posItem.curr || posItem.base_currency || 'USD').toUpperCase();

        // Check if trades already populated this asset
        // Otwarta pozycja bez transakcji w historii byla dopisywana jako zakup
        // z dzisiejsza data i cena `bal_price_a || price_a || mkt_price`, czyli
        // czesto z ceny rynkowej udajacej koszt nabycia. Prawdziwej daty nabycia
        // ten odczyt nie zawiera.
        const hasTrades = transactions.some((t) => t.ticker === ticker);
        if (!hasTrades && qty > 0) {
          pozycjeBezTransakcji.push(`${qty} ${ticker}`);
        }
      });
    }

    if (bezStrony.length > 0) {
      ostrzezenia.push(
        `Transakcje bez rozpoznanej strony (kupno/sprzedaż): ${bezStrony.join(', ')}. Zostały pominięte - ` +
          'strona wyznacza, czy to nabycie, czy zbycie, więc nie jest zgadywana.'
      );
    }
    if (bezIlosciLubCeny.length > 0) {
      ostrzezenia.push(
        `Transakcje z nieczytelną ilością lub ceną: ${bezIlosciLubCeny.join(', ')}. Zostały pominięte.`
      );
    }
    if (bezSymboluLicznik > 0) {
      ostrzezenia.push(`Wiersze historii bez symbolu instrumentu: ${bezSymboluLicznik}. Zostały pominięte.`);
    }
    if (pominietePary > 0) {
      ostrzezenia.push(`Pominięto pary walutowe w historii (nie są papierami wartościowymi): ${pominietePary}.`);
    }
    if (bezWaluty.length > 0) {
      ostrzezenia.push(
        `Transakcje bez waluty: ${bezWaluty.join(', ')}. Zostaly pominiete - waluta wyznacza ` +
          'kurs NBP, a podstawiony dolar zmienilby kwote w zlotych.'
      );
    }
    if (bezDaty.length > 0) {
      ostrzezenia.push(
        `Transakcje bez czytelnej daty: ${bezDaty.join(', ')}. Zostaly pominiete - bez daty ` +
          'nie da sie ustalic kursu NBP ani roku podatkowego.'
      );
    }
    if (pozycjeBezTransakcji.length > 0) {
      ostrzezenia.push(
        `Otwarte pozycje bez transakcji w historii: ${pozycjeBezTransakcji.join(', ')}. ` +
          'NIE zostaly dopisane - Tradernet nie podaje przy nich daty nabycia. Rozszerz zakres ' +
          'historii albo dodaj te transakcje recznie.'
      );
    }

    return {
      success: true,
      accountId,
      broker: 'FREEDOM24',
      message:
        ostrzezenia.length === 0
          ? `Odczytano ${transactions.length} ${odmienLiczebnik(transactions.length, 'transakcję', 'transakcje', 'transakcji')} z konta Freedom24 (Tradernet).`
          : `Odczytano ${transactions.length} ${odmienLiczebnik(transactions.length, 'transakcję', 'transakcje', 'transakcji')} z Freedom24, ale odczyt nie byl pelny.`,
      ostrzezenia,
      syncedTransactions: transactions,
      newTransactionsCount: transactions.length,
      syncTime: now,
    };
  } catch (err: any) {
    return {
      success: false,
      accountId,
      broker: 'FREEDOM24',
      message: `Błąd podczas synchronizacji Freedom24: ${err.message}`,
      syncedTransactions: [],
      newTransactionsCount: 0,
      syncTime: now,
      error: err.message,
    };
  }
}

// 4. XTB xAPI Tester & Synchronizer
const ADRESY_XTB = {
  REAL: 'wss://ws.xtb.com/real',
  DEMO: 'wss://ws.xtb.com/demo',
} as const;

/** Po tym czasie bez odpowiedzi uznajemy, ze serwer XTB nie odpowiada. */
const CZAS_OCZEKIWANIA_XTB_MS = 12_000;

/**
 * Sprawdza dane logowania do XTB xStation5 realnym polaczeniem.
 *
 * Poprzednia wersja tej funkcji nie laczyla sie z niczym: sprawdzala tylko, czy
 * pola nie sa puste, i zwracala "Autoryzacja xAPI xStation5 zweryfikowana"
 * razem ze zmyslonym czasem odpowiedzi i lista uprawnien. Dowolny ciag znakow
 * wpisany jako login i haslo dawal zielony komunikat o udanym polaczeniu, a
 * konto oznaczalo sie jako podlaczone do API. W programie do rozliczen taka
 * odpowiedz jest gorsza niz jej brak - uzytkownik czeka na dane, ktore nigdy
 * nie przyjda.
 *
 * xAPI dziala po WebSockecie i JSON-RPC: po polaczeniu idzie `login`, a serwer
 * odpowiada `status: true` albo kodem bledu. Haslo nie trafia do zadnego logu.
 */
export async function testXTBConnection(
  apiKey?: string,
  apiSecret?: string,
  accountNumber?: string,
  serverType: 'REAL' | 'DEMO' = 'REAL'
) {
  const startTime = Date.now();
  const userId = (accountNumber || apiKey || '').trim();
  const haslo = (apiSecret || '').trim();

  if (!userId || !haslo) {
    return {
      success: false,
      message: 'Podaj numer konta (login) XTB oraz hasło do xStation5.',
      latencyMs: 0,
      broker: 'XTB',
      error: 'Brak danych logowania XTB',
      errorCode: 'BRAK_DANYCH_LOGOWANIA',
    };
  }

  const adres = serverType === 'DEMO' ? ADRESY_XTB.DEMO : ADRESY_XTB.REAL;
  const nazwaSerwera = serverType === 'DEMO' ? 'Serwer Demo' : 'Serwer Rzeczywisty';

  return await new Promise<Record<string, unknown>>((resolve) => {
    let rozstrzygniete = false;
    let gniazdo: WebSocket | null = null;

    const zakoncz = (wynik: Record<string, unknown>) => {
      if (rozstrzygniete) return;
      rozstrzygniete = true;
      clearTimeout(licznik);
      try {
        gniazdo?.close();
      } catch {
        // Zamkniecie gniazda nie moze przeslonic wyniku testu.
      }
      resolve({ ...wynik, latencyMs: Date.now() - startTime });
    };

    const licznik = setTimeout(() => {
      zakoncz({
        success: false,
        message: `Serwer XTB (${nazwaSerwera}) nie odpowiedział w ciągu ${Math.round(
          CZAS_OCZEKIWANIA_XTB_MS / 1000
        )} sekund.`,
        broker: 'XTB',
        error: 'Przekroczony czas oczekiwania',
        errorCode: 'PRZEKROCZONY_CZAS',
        diagnostics: { endpoint: adres, details: 'Brak odpowiedzi na polecenie login.' },
      });
    }, CZAS_OCZEKIWANIA_XTB_MS);

    try {
      gniazdo = new WebSocket(adres);
    } catch (err: any) {
      zakoncz({
        success: false,
        message: `Nie udało się otworzyć połączenia z XTB: ${err?.message ?? 'nieznany błąd'}`,
        broker: 'XTB',
        error: err?.message,
        errorCode: 'BLAD_POLACZENIA',
        diagnostics: { endpoint: adres },
      });
      return;
    }

    gniazdo.onopen = () => {
      gniazdo?.send(JSON.stringify({ command: 'login', arguments: { userId, password: haslo } }));
    };

    gniazdo.onmessage = (zdarzenie: MessageEvent) => {
      let odpowiedz: any;
      try {
        odpowiedz = JSON.parse(String(zdarzenie.data));
      } catch {
        zakoncz({
          success: false,
          message: 'Serwer XTB odpowiedział treścią, której nie da się odczytać jako JSON.',
          broker: 'XTB',
          error: 'Odpowiedz nie jest JSON-em',
          errorCode: 'ZLA_ODPOWIEDZ',
          diagnostics: { endpoint: adres },
        });
        return;
      }

      if (odpowiedz?.status === true) {
        try {
          gniazdo?.send(JSON.stringify({ command: 'logout' }));
        } catch {
          // Sesja i tak wygasnie po zamknieciu gniazda.
        }
        zakoncz({
          success: true,
          message: `Logowanie do xStation5 potwierdzone przez serwer XTB (${nazwaSerwera}).`,
          broker: 'XTB',
          accountInfo: {
            accountNumber: userId,
            status: 'AUTHENTICATED',
            // Sprawdzilismy tylko polecenie `login`. Wpisane tu wczesniej
            // GET_TRADES_HISTORY bylo uprawnieniem, ktorego nikt nie odpytal.
            permissions: ['login'],
          },
          diagnostics: {
            endpoint: adres,
            // XTB nie uzywa podpisu HMAC - logowanie idzie loginem i haslem,
            // wiec "signatureVerified" nie mialo tu czego potwierdzac.
            details: 'Serwer odpowiedział na polecenie login statusem pozytywnym.',
          },
        });
        return;
      }

      const kod = typeof odpowiedz?.errorCode === 'string' ? odpowiedz.errorCode : undefined;
      const opis =
        typeof odpowiedz?.errorDescr === 'string'
          ? odpowiedz.errorDescr
          : 'Serwer XTB odrzucił logowanie.';
      zakoncz({
        success: false,
        message: kod ? `XTB odrzucił logowanie (${kod}): ${opis}` : `XTB odrzucił logowanie: ${opis}`,
        broker: 'XTB',
        error: opis,
        errorCode: kod ?? 'LOGOWANIE_ODRZUCONE',
        diagnostics: { endpoint: adres, details: opis },
      });
    };

    gniazdo.onerror = () => {
      zakoncz({
        success: false,
        message: `Nie udało się połączyć z serwerem XTB (${nazwaSerwera}). Sprawdź połączenie sieciowe.`,
        broker: 'XTB',
        error: 'Blad gniazda WebSocket',
        errorCode: 'BLAD_POLACZENIA',
        diagnostics: { endpoint: adres },
      });
    };

    gniazdo.onclose = () => {
      zakoncz({
        success: false,
        message: 'Serwer XTB zamknął połączenie przed odpowiedzią na logowanie.',
        broker: 'XTB',
        error: 'Polaczenie zamkniete przedwczesnie',
        errorCode: 'POLACZENIE_ZAMKNIETE',
        diagnostics: { endpoint: adres },
      });
    };
  });
}

/**
 * Brokerzy, dla ktorych nie ma publicznego API do pobierania historii.
 *
 * Dane z tych rachunkow wchodza do programu wylacznie z wyciagu. Wczesniej
 * zarowno test polaczenia, jak i synchronizacja zwracaly dla nich sukces bez
 * wykonania jakiegokolwiek polaczenia - rachunek oznaczal sie jako "Połączono
 * z API (Live)" i pokazywal "Test API Udany (Live Handshake)".
 */
const BROKERZY_BEZ_PUBLICZNEGO_API: Record<string, string> = {
  REVOLUT: 'Revolut',
  EMAKLER: 'eMakler (mBank)',
  DEGIRO: 'DEGIRO',
  CUSTOM: 'Konto własne',
};

function opisBrokeraBezApi(brokerType?: string): string {
  return BROKERZY_BEZ_PUBLICZNEGO_API[brokerType ?? ''] ?? `Konto ${brokerType ?? 'nieznanego brokera'}`;
}

// API Route: Test Broker Connection
router.post('/test-connection', async (req, res) => {
  const { brokerType, apiKey, apiSecret, accountNumber, queryId, apiServerType } = req.body as BrokerTestPayload;

  try {
    let result;
    switch (brokerType) {
      case 'BINANCE':
        result = await testBinanceConnection(apiKey || '', apiSecret || '');
        break;
      case 'IBKR':
        result = await testIBKRConnection(apiKey, queryId, accountNumber);
        break;
      case 'FREEDOM24':
        result = await testFreedom24Connection(apiKey, apiSecret);
        break;
      case 'XTB':
        result = await testXTBConnection(apiKey, apiSecret, accountNumber, apiServerType || 'REAL');
        break;
      case 'REVOLUT':
      case 'EMAKLER':
      case 'DEGIRO':
      case 'CUSTOM':
      default:
        result = {
          success: false,
          errorCode: 'BRAK_PUBLICZNEGO_API',
          broker: brokerType || 'CUSTOM',
          latencyMs: 0,
          message: `${opisBrokeraBezApi(
            brokerType
          )} nie udostępnia publicznego API do pobierania historii transakcji. Wczytaj wyciąg CSV lub XLSX w zakładce Transakcje.`,
          diagnostics: {
            details:
              'Nie wykonano żadnego połączenia sieciowego — ten rodzaj rachunku obsługuje wyłącznie import pliku.',
          },
        };
        break;
    }

    odeslijWynik(res, result, maKluczeApi(req));
  } catch (err: any) {
    res.status(500).json({
      success: false,
      message: `Nieoczekiwany błąd podczas testowania API: ${err.message}`,
      broker: brokerType,
      error: err.message,
    });
  }
});

// API Route: Synchronize Broker Transactions
router.post('/sync', async (req, res) => {
  const payload = req.body as BrokerSyncPayload;
  const { brokerType, accountId } = payload;

  try {
    let syncResult;
    switch (brokerType) {
      case 'BINANCE':
        syncResult = await syncBinanceTrades(payload);
        break;
      case 'IBKR':
        syncResult = await syncIBKRTrades(payload);
        break;
      case 'FREEDOM24':
        syncResult = await syncFreedom24Trades(payload);
        break;
      case 'XTB': {
        // Test logowania do xStation5 dziala, ale pobierania historii zlecen
        // przez xAPI jeszcze nie ma. Wczesniej ta galaz zwracala "Zweryfikowano
        // i zsynchronizowano stan konta" i zero transakcji, wiec brak importu
        // wygladal jak rachunek bez operacji.
        syncResult = {
          success: false,
          accountId,
          broker: brokerType,
          errorCode: 'IMPORT_NIEDOSTEPNY',
          message:
            'Automatyczne pobieranie historii z XTB nie jest jeszcze dostępne. Test logowania działa, a transakcje wczytasz z wyciągu CSV w zakładce Transakcje.',
          syncedTransactions: [],
          newTransactionsCount: 0,
          syncTime: new Date().toISOString(),
        };
        break;
      }
      case 'REVOLUT':
      case 'EMAKLER':
      case 'DEGIRO':
      case 'CUSTOM':
      default: {
        syncResult = {
          success: false,
          accountId,
          broker: brokerType,
          errorCode: 'BRAK_PUBLICZNEGO_API',
          message: `${opisBrokeraBezApi(
            brokerType
          )} nie udostępnia publicznego API. Wczytaj wyciąg CSV lub XLSX w zakładce Transakcje.`,
          syncedTransactions: [],
          newTransactionsCount: 0,
          syncTime: new Date().toISOString(),
        };
        break;
      }
    }

    res.json(syncResult);
  } catch (err: any) {
    res.status(500).json({
      success: false,
      accountId,
      broker: brokerType,
      message: `Błąd synchronizacji API: ${err.message}`,
      syncedTransactions: [],
      newTransactionsCount: 0,
      syncTime: new Date().toISOString(),
      error: err.message,
    });
  }
});

// API Route: Place / Arm Real Broker Protective Order (Stop-Loss / Take-Profit / OCO Bracket)
router.post('/orders/status', async (req, res) => {
  const { brokerType, apiKey, apiSecret, ticker, clientOrderId } = req.body || {};
  if (brokerType !== 'BINANCE') {
    return res.status(400).json({ success: false, message: 'Sprawdzanie statusu jest dostępne dla zleceń Binance.' });
  }
  if (!apiKey || !apiSecret || typeof clientOrderId !== 'string' || !/^[A-Za-z0-9_-]{1,36}$/.test(clientOrderId)) {
    return res.status(400).json({ success: false, message: 'Brak kluczy API Binance lub poprawnego identyfikatora zlecenia.' });
  }

  const symbol = binanceSymbol(ticker);
  if (!symbol) return res.status(400).json({ success: false, message: 'Niepoprawny symbol zlecenia Binance.' });
  const reservationKey = binanceReservationKey(String(apiKey), symbol);
  const queryString = signedBinanceQuery({ symbol, origClientOrderId: clientOrderId, timestamp: String(Date.now()), recvWindow: '5000' }, String(apiSecret));

  try {
    const response = await fetch(`https://api.binance.com/api/v3/order?${queryString}`, {
      method: 'GET',
      headers: { 'X-MBX-APIKEY': String(apiKey).trim(), Accept: 'application/json' },
    });
    const data: any = await response.json().catch(() => null);
    if (response.ok && data?.orderId != null) {
      resolveBinanceOrderStatus(reservationKey, clientOrderId);
      return res.json({
        success: true,
        found: true,
        order: {
          orderId: String(data.orderId),
          clientOrderId: data.clientOrderId || clientOrderId,
          status: String(data.status || 'UNKNOWN'),
          executedQty: data.executedQty,
          origQty: data.origQty,
        },
        message: 'Binance potwierdził istnienie zlecenia.',
      });
    }
    if (Number(data?.code) === -2013) {
      resolveBinanceOrderStatus(reservationKey, clientOrderId);
      return res.json({ success: true, found: false, definitive: true, message: 'Binance potwierdził, że zlecenie nie istnieje.' });
    }
    return res.status(502).json({
      success: false,
      found: false,
      uncertain: true,
      message: 'Nie udało się potwierdzić statusu zlecenia Binance. Sprawdź zlecenia w Binance i ponów sprawdzenie.',
    });
  } catch {
    return res.status(502).json({
      success: false,
      found: false,
      uncertain: true,
      message: 'Błąd połączenia podczas sprawdzania zlecenia Binance. Sprawdź zlecenia w Binance i ponów sprawdzenie.',
    });
  }
});

router.post('/orders/preview', async (req, res) => {
  const symbol = binanceSymbol(req.body?.ticker);
  const { action, quantity, stopPrice, limitPrice } = req.body || {};
  if (!symbol || !['BUY', 'SELL'].includes(action) || !positiveFinite(quantity) || !positiveFinite(stopPrice)
    || (limitPrice !== undefined && !positiveFinite(limitPrice))) {
    return res.status(400).json({ success: false, message: 'Niepoprawny symbol, strona, ilość lub cena zlecenia Binance.' });
  }
  try {
    const filters = await getBinanceFilters(symbol);
    const actualQuantity = roundBinance(quantity, filters.stepSize, 'down');
    // SELL: wyższy próg stop uruchamia ochronę wcześniej; niższy limit ułatwia wykonanie.
    const actualStopPrice = roundBinance(stopPrice, filters.tickSize, action === 'SELL' ? 'up' : 'down');
    const actualLimitPrice = roundBinance(limitPrice ?? stopPrice * 0.99, filters.tickSize, action === 'SELL' ? 'down' : 'up');
    if (Number(actualQuantity) <= 0 || Number(actualStopPrice) <= 0 || Number(actualLimitPrice) <= 0) {
      return res.status(400).json({ success: false, message: 'Ilość lub cena po zaokrągleniu do kroku Binance wynosi zero.' });
    }
    return res.json({ success: true, symbol, quantity: actualQuantity, stopPrice: actualStopPrice, limitPrice: actualLimitPrice });
  } catch (error) {
    return res.status(503).json({ success: false, message: error instanceof Error ? error.message : 'Nie udało się pobrać filtrów Binance.' });
  }
});

router.post('/orders/create', async (req, res) => {
  if (req.body?.confirm !== true) return res.status(400).json({ success: false, message: 'Zlecenie wymaga jawnego potwierdzenia.' });
  const {
    accountId,
    brokerType,
    brokerName,
    apiKey,
    apiSecret,
    accountNumber,
    apiServerType,
    ticker,
    action,
    orderType,
    quantity,
    stopPrice,
    takeProfitPrice,
    limitPrice,
    currency,
    timeInForce,
    newClientOrderId,
  } = req.body;

  try {
    const timestamp = Date.now();
    const cleanTicker = String(ticker || '').toUpperCase().trim();
    let orderResult: any;

    // Zlecenie ochronne wolno potwierdzic dopiero wtedy, gdy potwierdzil je
    // broker.
    //
    // Wczesniej kazda galaz tej trasy konczyla sie `success: true` z numerem
    // zlecenia zlozonym z biezacego czasu i komunikatem "uzbrojone". XTB, IBKR
    // i galaz domyslna nie wysylaly przy tym ZADNEGO zapytania, a Binance
    // i Freedom24 raportowaly sukces takze wtedy, gdy zapytanie rzucilo
    // wyjatkiem albo broker odpowiedzial bledem. Uzytkownik widzial
    // "Uzbrojono Zlecenie Ochronne", stop-loss nie istnial, a przy spadku kursu
    // nic go nie chronilo.
    if (brokerType === 'BINANCE') {
      if (typeof newClientOrderId !== 'string' || !/^[A-Za-z0-9_-]{1,36}$/.test(newClientOrderId)) {
        return res.status(400).json({ success: false, message: 'Brak poprawnego identyfikatora potwierdzonego zlecenia Binance.' });
      }
      if (!apiKey || !apiSecret) {
        return res.status(400).json({
          success: false,
          broker: 'BINANCE',
          status: 'REJECTED',
          message: 'Brak kluczy API dla Binance. Skonfiguruj API Key i API Secret w zakładce Konta Maklerskie.',
        });
      }

      const symbolPair = binanceSymbol(ticker);
      const side = action;
      if (!symbolPair || !['BUY', 'SELL'].includes(side) || !positiveFinite(quantity) || !positiveFinite(stopPrice)
        || (limitPrice !== undefined && !positiveFinite(limitPrice))) {
        return res.status(400).json({ success: false, message: 'Niepoprawny symbol, strona, ilość lub cena zlecenia Binance.' });
      }
      let filters: BinanceFilters;
      try { filters = await getBinanceFilters(symbolPair); }
      catch (error) { return res.status(503).json({ success: false, message: error instanceof Error ? error.message : 'Nie udało się pobrać filtrów Binance.' }); }
      const actualQuantity = roundBinance(quantity, filters.stepSize, 'down');
      const actualStopPrice = roundBinance(stopPrice, filters.tickSize, side === 'SELL' ? 'up' : 'down');
      const actualLimitPrice = roundBinance(limitPrice ?? stopPrice * 0.99, filters.tickSize, side === 'SELL' ? 'down' : 'up');
      if (Number(actualQuantity) <= 0 || Number(actualStopPrice) <= 0 || Number(actualLimitPrice) <= 0) {
        return res.status(400).json({ success: false, message: 'Ilość lub cena po zaokrągleniu do kroku Binance wynosi zero.' });
      }
      const reservationKey = binanceReservationKey(String(apiKey), symbolPair);
      const queryString = signedBinanceQuery({ symbol: symbolPair, side, type: 'STOP_LOSS_LIMIT', quantity: actualQuantity,
        stopPrice: actualStopPrice, price: actualLimitPrice, timeInForce: 'GTC', newClientOrderId, timestamp: String(timestamp) }, String(apiSecret));

      const reservation = reserveBinanceOrder(reservationKey, newClientOrderId);
      if (reservation !== 'ok') {
        return res.status(409).json({
          success: false,
          ambiguous: false,
          broker: 'BINANCE',
          status: 'REJECTED',
          message: reservation === 'full' ? 'Osiągnięto limit rezerwacji Binance. Sprawdź status nierozstrzygniętych zleceń.' : 'Istnieje nierozstrzygnięte zlecenie Binance dla tej pary i klucza API. Najpierw sprawdź jego status.',
        });
      }

      try {
        const binanceUrl = `https://api.binance.com/api/v3/order?${queryString}`;
        const binanceRes = await fetch(binanceUrl, {
          method: 'POST',
          headers: {
            'X-MBX-APIKEY': apiKey.trim(),
            'Content-Type': 'application/json',
          },
          // Bez limitu zawieszone zapytanie trzymalo rezerwacje pary i kolejne
          // zlecenia dostawaly 409. Przekroczenie limitu trafia do catch jako wynik niepewny.
          signal: AbortSignal.timeout(15_000),
        });

        const binanceData: any = await binanceRes.json();
        if (!binanceRes.ok || !binanceData?.orderId) {
          const errorCode = Number(binanceData?.code);
          const errorMessage = String(binanceData?.msg || '');
          const ambiguous =
            binanceRes.status >= 500
            || (binanceRes.ok && !binanceData?.orderId)
            || [-1000, -1006, -1007].includes(errorCode)
            || /duplicate.*order/i.test(errorMessage);
          finishBinanceOrderAttempt(reservationKey, ambiguous);
          return res.status(502).json({
            success: false,
            broker: 'BINANCE',
            status: ambiguous ? 'PENDING' : 'REJECTED',
            ambiguous,
            clientOrderId: newClientOrderId,
            quantity: actualQuantity,
            stopPrice: actualStopPrice,
            limitPrice: actualLimitPrice,
            message: ambiguous
              ? 'Nie wiadomo, czy Binance przyjął zlecenie — sprawdź listę zleceń przed ponowieniem.'
              : `Binance nie przyjął zlecenia (HTTP ${binanceRes.status})${binanceData?.msg ? `: ${binanceData.msg}` : '.'} Zlecenie NIE jest uzbrojone.`,
            rawResponse: binanceData,
          });
        }

        orderResult = {
          success: true,
          orderId: String(binanceData.orderId),
           clientOrderId: binanceData.clientOrderId || newClientOrderId,
          broker: 'BINANCE',
          status: 'ARMED',
          takeProfitPlaced: false,
          quantity: actualQuantity,
          stopPrice: actualStopPrice,
          limitPrice: actualLimitPrice,
          message: `Zlecenie Stop-Loss (${actualQuantity} ${cleanTicker} @ ${actualStopPrice} USDT) przyjęte przez Binance, numer ${binanceData.orderId}.`
            + (takeProfitPrice != null || orderType === 'OCO_BRACKET' ? ' Złożono tylko Stop-Loss; Take-Profit NIE został złożony.' : ''),
          rawResponse: binanceData,
        };
        finishBinanceOrderAttempt(reservationKey, false);
      } catch (e: any) {
        finishBinanceOrderAttempt(reservationKey, true);
        return res.status(502).json({
          success: false,
          broker: 'BINANCE',
          status: 'PENDING',
          ambiguous: true,
          clientOrderId: newClientOrderId,
          quantity: actualQuantity,
          stopPrice: actualStopPrice,
          limitPrice: actualLimitPrice,
          message: 'Nie wiadomo, czy Binance przyjął zlecenie — sprawdź listę zleceń przed ponowieniem.',
          error: String(e?.message || e),
        });
      }
    } else if (brokerType === 'FREEDOM24') {
      return res.status(400).json({ success: false, broker: 'FREEDOM24', status: 'NOT_SUPPORTED', message: 'Zlecenia ochronne Freedom24 składaj przez /api/brokers/freedom24/orders/protect.' });
    } else {
      // Dla tych brokerow aplikacja nie ma zaimplementowanego skladania zlecen.
      // Mowimy to wprost - udawany sukces zostawialby uzytkownika w
      // przekonaniu, ze pozycja jest zabezpieczona.
      const gdzieUstawic: Record<string, string> = {
        XTB: 'w platformie xStation 5',
        IBKR: 'w Trader Workstation albo IBKR Mobile',
        REVOLUT: 'w aplikacji Revolut',
        DEGIRO: 'w serwisie DEGIRO',
        EMAKLER: 'w serwisie transakcyjnym banku',
      };
      const wskazowka = gdzieUstawic[brokerType] || 'w aplikacji brokera';
      return res.status(501).json({
        success: false,
        broker: brokerType || 'CUSTOM',
        status: 'NOT_SUPPORTED',
        message:
          `Ta aplikacja nie składa zleceń u brokera ${brokerName || brokerType || 'CUSTOM'}. ` +
          `Ustaw stop-loss dla ${cleanTicker} ${wskazowka} — tutaj możesz zapisać go jako alert cenowy.`,
      });
    }

    res.json(orderResult);
  } catch (err: any) {
    res.status(500).json({
      success: false,
      broker: brokerType || 'UNKNOWN',
      message: `Błąd podczas wysyłania zlecenia do brokera: ${err.message}`,
      error: err.message,
    });
  }
});

// API Route: Cancel Broker Protective Order
// Anulowanie zlecenia ochronnego.
//
// Trasa odpowiadala wczesniej "zlecenie zostalo pomyslnie anulowane" bez
// jednego zapytania do brokera. Uzytkownik kasowal wpis z listy w przekonaniu,
// ze stop-loss zniknal takze po drugiej stronie - a ten dalej tam byl i mogl
// sprzedac pozycje.
router.post('/orders/cancel', async (req, res) => {
  if (req.body?.confirm !== true) return res.status(400).json({ success: false, message: 'Anulowanie wymaga jawnego potwierdzenia.' });
  const { orderId, brokerType, brokerName, apiKey, apiSecret, ticker } = req.body;
  const cleanTicker = String(ticker || '').toUpperCase().trim();

  try {
    if (brokerType === 'BINANCE') {
      const symbolPair = binanceSymbol(ticker);
      if (!apiKey || !apiSecret || !symbolPair || !/^[0-9]{1,20}$/.test(String(orderId))) {
        return res.status(400).json({
          success: false,
          orderId,
          broker: 'BINANCE',
          message: 'Do anulowania zlecenia w Binance potrzebne są klucze API i symbol instrumentu.',
        });
      }
      const queryString = signedBinanceQuery({ symbol: symbolPair, orderId: String(orderId), timestamp: String(Date.now()) }, String(apiSecret));
      const binanceRes = await fetch(`https://api.binance.com/api/v3/order?${queryString}`, {
        method: 'DELETE',
        headers: { 'X-MBX-APIKEY': String(apiKey).trim() },
      });
      const binanceData: any = await binanceRes.json();
      if (!binanceRes.ok) {
        return res.status(502).json({
          success: false,
          orderId,
          broker: 'BINANCE',
          message:
            `Binance nie anulował zlecenia (HTTP ${binanceRes.status})` +
            `${binanceData?.msg ? `: ${binanceData.msg}` : '.'} Zlecenie może nadal być aktywne.`,
          rawResponse: binanceData,
        });
      }
      return res.json({
        success: true,
        orderId,
        broker: 'BINANCE',
        message: `Binance potwierdził anulowanie zlecenia ${orderId} dla ${symbolPair}.`,
        cancelledAt: new Date().toISOString(),
        rawResponse: binanceData,
      });
    }

    if (brokerType === 'FREEDOM24') {
      return res.status(400).json({ success: false, orderId, broker: 'FREEDOM24', message: 'Zlecenia Freedom24 anuluj przez /api/brokers/freedom24/orders/cancel.' });
    }

    return res.status(501).json({
      success: false,
      orderId,
      broker: brokerType || 'CUSTOM',
      message:
        `Ta aplikacja nie anuluje zleceń u brokera ${brokerName || brokerType || 'CUSTOM'}. ` +
        'Usuń zlecenie w aplikacji brokera — skasowanie wpisu tutaj nie zdejmie go z rachunku.',
    });
  } catch (err: any) {
    res.status(502).json({
      success: false,
      orderId,
      broker: brokerType || 'UNKNOWN',
      message: `Nie udało się anulować zlecenia: ${err?.message || err}. Zlecenie może nadal być aktywne.`,
      error: String(err?.message || err),
    });
  }
});

// ============================================================================
// Freedom24 (Tradernet) Stock Lists API Handlers
// ============================================================================

export interface Freedom24StockList {
  id: number;
  userId?: number;
  name: string;
  tickers: string[];
  picture?: string | null;
}

export interface Freedom24StockListsResponse {
  userStockLists: Freedom24StockList[];
  selectedId: number;
  defaultId: number;
}

export async function getFreedom24StockLists(apiKey?: string, apiSecret?: string, sid?: string) {
  const params = sid ? { SID: sid } : {};
  const res = await odczytajFreedom24('getUserStockLists', params, apiKey, apiSecret);
  if (res && res.success && res.data) {
    const lists = res.data.userStockLists || res.data.result?.userStockLists || [];
    return {
      success: true,
      userStockLists: lists,
      selectedId: res.data.selectedId || res.data.result?.selectedId || (lists[0]?.id ?? 1),
      defaultId: res.data.defaultId || res.data.result?.defaultId || (lists[0]?.id ?? 1),
    };
  }

  return {
    success: false,
    message: res.error || 'Nie udało się pobrać list papierów wartościowych z Freedom24.',
    userStockLists: [],
    selectedId: 1,
    defaultId: 1,
  };
}

export async function addFreedom24StockList(
  apiKey: string,
  apiSecret: string,
  payload: { name: string; picture?: string; tickers: string[]; sid?: string }
) {
  const params: any = {
    name: payload.name,
    picture: payload.picture || '',
    tickers: payload.tickers || [],
  };
  if (payload.sid) params.SID = payload.sid;

  const res = await sendTradernetRequest('addStockList', params, apiKey.trim(), apiSecret.trim());
  if (res && res.success && res.data) {
    const lists = res.data.userStockLists || res.data.result?.userStockLists || [];
    return {
      success: true,
      message: `Lista "${payload.name}" została pomyślnie dodana w Freedom24.`,
      userStockLists: lists,
      selectedId: res.data.selectedId || res.data.result?.selectedId,
      defaultId: res.data.defaultId || res.data.result?.defaultId,
    };
  }

  return {
    success: false,
    message: res?.error || 'Nie udało się dodać listy papierów wartościowych w Freedom24.',
  };
}

export async function updateFreedom24StockList(
  apiKey: string,
  apiSecret: string,
  payload: { id: number; name?: string; picture?: string; index?: number; sid?: string }
) {
  const params: any = { id: payload.id };
  if (payload.name !== undefined) params.name = payload.name;
  if (payload.picture !== undefined) params.picture = payload.picture;
  if (payload.index !== undefined) params.index = payload.index;
  if (payload.sid) params.SID = payload.sid;

  const res = await sendTradernetRequest('updateStockList', params, apiKey.trim(), apiSecret.trim());
  if (res && res.success && res.data) {
    const lists = res.data.userStockLists || res.data.result?.userStockLists || [];
    return {
      success: true,
      message: 'Lista papierów wartościowych została zaktualizowana.',
      userStockLists: lists,
      selectedId: res.data.selectedId || res.data.result?.selectedId,
      defaultId: res.data.defaultId || res.data.result?.defaultId,
    };
  }

  return {
    success: false,
    message: res?.error || 'Nie udało się zaktualizować listy w Freedom24.',
  };
}

export async function deleteFreedom24StockList(apiKey: string, apiSecret: string, payload: { id: number; sid?: string }) {
  const params: any = { id: payload.id };
  if (payload.sid) params.SID = payload.sid;

  const res = await sendTradernetRequest('deleteStockList', params, apiKey.trim(), apiSecret.trim());
  if (res && res.success && res.data) {
    const lists = res.data.userStockLists || res.data.result?.userStockLists || [];
    return {
      success: true,
      message: 'Lista papierów wartościowych została usunięta.',
      userStockLists: lists,
      selectedId: res.data.selectedId || res.data.result?.selectedId,
      defaultId: res.data.defaultId || res.data.result?.defaultId,
    };
  }

  return {
    success: false,
    message: res?.error || 'Nie udało się usunąć listy w Freedom24.',
  };
}

export async function makeFreedom24StockListSelected(apiKey: string, apiSecret: string, payload: { id: number; sid?: string }) {
  const params: any = { id: payload.id };
  if (payload.sid) params.SID = payload.sid;

  const res = await sendTradernetRequest('makeStockListSelected', params, apiKey.trim(), apiSecret.trim());
  if (res && res.success && res.data) {
    const lists = res.data.userStockLists || res.data.result?.userStockLists || [];
    return {
      success: true,
      message: 'Wybrana aktywna lista została zmieniona.',
      userStockLists: lists,
      selectedId: res.data.selectedId || res.data.result?.selectedId || payload.id,
      defaultId: res.data.defaultId || res.data.result?.defaultId,
    };
  }

  return {
    success: false,
    message: res?.error || 'Nie udało się zmienić aktywnej listy.',
  };
}

export async function addTickerToFreedom24StockList(
  apiKey: string,
  apiSecret: string,
  payload: { id: number; ticker: string; index?: number; sid?: string }
) {
  const params: any = {
    id: payload.id,
    ticker: payload.ticker.toUpperCase().trim(),
  };
  if (payload.index !== undefined) params.index = payload.index;
  if (payload.sid) params.SID = payload.sid;

  const res = await sendTradernetRequest('addStockListTicker', params, apiKey.trim(), apiSecret.trim());
  if (res && res.success && res.data) {
    const lists = res.data.userStockLists || res.data.result?.userStockLists || [];
    return {
      success: true,
      message: `Ticker ${payload.ticker} został dodany do listy.`,
      userStockLists: lists,
      selectedId: res.data.selectedId || res.data.result?.selectedId,
      defaultId: res.data.defaultId || res.data.result?.defaultId,
    };
  }

  return {
    success: false,
    message: res?.error || `Nie udało się dodać tickera ${payload.ticker} do listy.`,
  };
}

export async function deleteTickerFromFreedom24StockList(
  apiKey: string,
  apiSecret: string,
  payload: { id: number; ticker: string; sid?: string }
) {
  const params: any = {
    id: payload.id,
    ticker: payload.ticker.toUpperCase().trim(),
  };
  if (payload.sid) params.SID = payload.sid;

  const res = await sendTradernetRequest('deleteStockListTicker', params, apiKey.trim(), apiSecret.trim());
  if (res && res.success && res.data) {
    const lists = res.data.userStockLists || res.data.result?.userStockLists || [];
    return {
      success: true,
      message: `Ticker ${payload.ticker} został usunięty z listy.`,
      userStockLists: lists,
      selectedId: res.data.selectedId || res.data.result?.selectedId,
      defaultId: res.data.defaultId || res.data.result?.defaultId,
    };
  }

  return {
    success: false,
    message: res?.error || `Nie udało się usunąć tickera ${payload.ticker} z listy.`,
  };
}

// ----------------------------------------------------------------------------
// API Endpoints for Freedom24 Stock Lists
// ----------------------------------------------------------------------------

router.post('/freedom24/stock-lists', async (req, res) => {
  const { apiKey, apiSecret, sid } = req.body;
  try {
    const result = await getFreedom24StockLists(apiKey, apiSecret, sid);
    odeslijWynik(res, result, maKluczeApi(req) || !!createFreedom24Api());
  } catch (err: any) {
    res.status(500).json({ success: false, message: sanitizeFreedom24Text(err?.message), userStockLists: [] });
  }
});

router.post('/freedom24/stock-lists/add', async (req, res) => {
  const { apiKey, apiSecret, name, picture, tickers, sid } = req.body;
  try {
    const result = await addFreedom24StockList(apiKey, apiSecret, { name, picture, tickers, sid });
    odeslijWynik(res, result, maKluczeApi(req));
  } catch (err: any) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.post('/freedom24/stock-lists/update', async (req, res) => {
  const { apiKey, apiSecret, id, name, picture, index, sid } = req.body;
  try {
    const result = await updateFreedom24StockList(apiKey, apiSecret, { id, name, picture, index, sid });
    odeslijWynik(res, result, maKluczeApi(req));
  } catch (err: any) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.post('/freedom24/stock-lists/delete', async (req, res) => {
  const { apiKey, apiSecret, id, sid } = req.body;
  try {
    const result = await deleteFreedom24StockList(apiKey, apiSecret, { id, sid });
    odeslijWynik(res, result, maKluczeApi(req));
  } catch (err: any) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.post('/freedom24/stock-lists/select', async (req, res) => {
  const { apiKey, apiSecret, id, sid } = req.body;
  try {
    const result = await makeFreedom24StockListSelected(apiKey, apiSecret, { id, sid });
    odeslijWynik(res, result, maKluczeApi(req));
  } catch (err: any) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.post('/freedom24/stock-lists/ticker/add', async (req, res) => {
  const { apiKey, apiSecret, id, ticker, index, sid } = req.body;
  try {
    const result = await addTickerToFreedom24StockList(apiKey, apiSecret, { id, ticker, index, sid });
    odeslijWynik(res, result, maKluczeApi(req));
  } catch (err: any) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.post('/freedom24/stock-lists/ticker/delete', async (req, res) => {
  const { apiKey, apiSecret, id, ticker, sid } = req.body;
  try {
    const result = await deleteTickerFromFreedom24StockList(apiKey, apiSecret, { id, ticker, sid });
    odeslijWynik(res, result, maKluczeApi(req));
  } catch (err: any) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ============================================================================
// Freedom24 (Tradernet) Market Status API (getMarketStatus)
// ============================================================================

export interface Freedom24MarketInfo {
  n: string;   // Full name (e.g. "NYSE/NASDAQ", "Warsaw Stock Exchange")
  n2: string;  // Brief name / code (e.g. "FIX", "WSE", "EU", "CRPT")
  /** Brak znaczy "nieznany", a nie "zamkniete". */
  s?: 'OPEN' | 'CLOSE' | 'PRE_MARKET' | 'AFTER_HOURS' | 'WEEKEND';
  o?: string;  // Opening time
  c?: string;  // Closing time
  dt?: string; // Time shift
  flag?: string;
  category?: 'STOCKS_US' | 'STOCKS_PL' | 'STOCKS_EU' | 'CRYPTO' | 'FUTURES' | 'ASIA' | 'OTHER';
}

export interface Freedom24MarketStatusResponse {
  success: boolean;
  /** Czas brokera, gdy go podal; w przeciwnym razie czas tego serwera. */
  serverTime: string;
  markets: Freedom24MarketInfo[];
  /**
   * Skad wzial sie status sesji. Wczesniej godziny wyliczone z lokalnego
   * zegara i stalych wracaly z `cached: true`, czyli jako odczyt z pamieci
   * podrecznej brokera - a Freedom24 nigdy o nich nie wiedzialo.
   */
  zrodlo?: 'freedom24' | 'zegar-lokalny';
}

export function computeLiveMarketStatuses(): Freedom24MarketInfo[] {
  const now = new Date();
  const utcHours = now.getUTCHours();
  const utcMinutes = now.getUTCMinutes();
  const utcDay = now.getUTCDay(); // 0 = Sunday, 6 = Saturday
  const isWeekend = utcDay === 0 || utcDay === 6;

  // UTC time in minutes
  const nowUtcMin = utcHours * 60 + utcMinutes;

  // 1. NYSE/NASDAQ (FIX): US Regular Session 13:30 - 20:00 UTC (09:30 - 16:00 ET)
  // Pre-market: 08:00 - 13:30 UTC. After-hours: 20:00 - 00:00 UTC
  let nyseStatus: Freedom24MarketInfo['s'] = 'CLOSE';
  if (isWeekend) {
    nyseStatus = 'WEEKEND';
  } else if (nowUtcMin >= 13 * 60 + 30 && nowUtcMin < 20 * 60) {
    nyseStatus = 'OPEN';
  } else if (nowUtcMin >= 8 * 60 && nowUtcMin < 13 * 60 + 30) {
    nyseStatus = 'PRE_MARKET';
  } else if (nowUtcMin >= 20 * 60 && nowUtcMin < 24 * 60) {
    nyseStatus = 'AFTER_HOURS';
  }

  // 2. Warsaw Stock Exchange (WSE / GPW): 07:00 - 15:00 UTC (09:00 - 17:00 CET)
  let wseStatus: Freedom24MarketInfo['s'] = 'CLOSE';
  if (isWeekend) {
    wseStatus = 'WEEKEND';
  } else if (nowUtcMin >= 7 * 60 && nowUtcMin < 15 * 60) {
    wseStatus = 'OPEN';
  }

  // 3. Europe / Euronext / Xetra (EU): 07:00 - 15:30 UTC
  let euStatus: Freedom24MarketInfo['s'] = 'CLOSE';
  if (isWeekend) {
    euStatus = 'WEEKEND';
  } else if (nowUtcMin >= 7 * 60 && nowUtcMin < 15 * 60 + 30) {
    euStatus = 'OPEN';
  }

  // 4. London Metal Exchange / LSE: 08:00 - 16:30 UTC
  let lseStatus: Freedom24MarketInfo['s'] = 'CLOSE';
  if (isWeekend) {
    lseStatus = 'WEEKEND';
  } else if (nowUtcMin >= 8 * 60 && nowUtcMin < 16 * 60 + 30) {
    lseStatus = 'OPEN';
  }

  // 5. Tokyo & Hong Kong (HKEX): 01:30 - 08:00 UTC
  let asiaStatus: Freedom24MarketInfo['s'] = 'CLOSE';
  if (isWeekend) {
    asiaStatus = 'WEEKEND';
  } else if (nowUtcMin >= 1 * 60 + 30 && nowUtcMin < 8 * 60) {
    asiaStatus = 'OPEN';
  }

  // 6. CME Futures: 22:00 - 21:00 UTC (Almost 24h on weekdays)
  let cmeStatus: Freedom24MarketInfo['s'] = isWeekend ? 'WEEKEND' : 'OPEN';

  return [
    {
      n: 'NYSE / NASDAQ (Amerykańskie Rynki Akcji)',
      n2: 'FIX',
      s: nyseStatus,
      o: '15:30:00',
      c: '22:00:00',
      dt: '-360',
      flag: '🇺🇸',
      category: 'STOCKS_US',
    },
    {
      n: 'Giełda Papierów Wartościowych w Warszawie',
      n2: 'WSE',
      s: wseStatus,
      o: '09:00:00',
      c: '17:00:00',
      dt: '+60',
      flag: '🇵🇱',
      category: 'STOCKS_PL',
    },
    {
      n: 'UE Europa (Xetra, Euronext, Frankfurt)',
      n2: 'EU',
      s: euStatus,
      o: '09:00:00',
      c: '17:30:00',
      dt: '+60',
      flag: '🇪🇺',
      category: 'STOCKS_EU',
    },
    {
      n: 'Rynek Kryptowalut (Binance, Kraken, Spot)',
      n2: 'CRPT',
      s: 'OPEN',
      o: '00:00:00',
      c: '24:00:00',
      dt: '0',
      flag: '🪙',
      category: 'CRYPTO',
    },
    {
      n: 'London Stock Exchange / LME Metals',
      n2: 'LME',
      s: lseStatus,
      o: '09:00:00',
      c: '17:30:00',
      dt: '0',
      flag: '🇬🇧',
      category: 'STOCKS_EU',
    },
    {
      n: 'Hong Kong Stock Exchange / HKG Futures',
      n2: 'HKEX',
      s: asiaStatus,
      o: '02:30:00',
      c: '09:00:00',
      dt: '+480',
      flag: '🇭🇰',
      category: 'ASIA',
    },
    {
      n: 'Chicago Mercantile Exchange (CME / CBOE)',
      n2: 'CME',
      s: cmeStatus,
      o: '00:00:00',
      c: '23:00:00',
      dt: '-360',
      flag: '📊',
      category: 'FUTURES',
    },
    {
      n: 'Astana International Exchange (AIX / KASE)',
      n2: 'AIX',
      s: isWeekend ? 'WEEKEND' : 'CLOSE',
      o: '08:20:00',
      c: '14:00:00',
      dt: '+300',
      flag: '🇰🇿',
      category: 'OTHER',
    },
    {
      n: 'Borsa Istanbul (BIST Turcja)',
      n2: 'BIST',
      s: isWeekend ? 'WEEKEND' : 'CLOSE',
      o: '09:00:00',
      c: '17:00:00',
      dt: '+180',
      flag: '🇹🇷',
      category: 'OTHER',
    },
    {
      n: 'Toronto Stock Exchange (TSX Kanada)',
      n2: 'TSX',
      s: nyseStatus,
      o: '15:30:00',
      c: '22:00:00',
      dt: '-300',
      flag: '🇨🇦',
      category: 'STOCKS_US',
    },
  ];
}

export async function getFreedom24MarketStatus(
  apiKey?: string,
  apiSecret?: string,
  market: string = '*',
  mode?: string
): Promise<Freedom24MarketStatusResponse> {
  const nowIso = new Date().toISOString().replace('T', ' ').slice(0, 19);

  if (apiKey?.trim() && apiSecret?.trim()) {
    const params: any = { market: market || '*' };
    if (mode) params.mode = mode;

    try {
      const res = await sendTradernetRequest('getMarketStatus', params, apiKey.trim(), apiSecret.trim());
      if (res && res.success && res.data) {
        const rawMarkets = res.data.result?.markets?.m || res.data.markets?.m || [];
        if (Array.isArray(rawMarkets) && rawMarkets.length > 0) {
          const mapped: Freedom24MarketInfo[] = rawMarkets.map((mItem: any) => ({
            n: mItem.n || mItem.name || 'Giełda',
            n2: mItem.n2 || mItem.briefName || mItem.code || 'MKT',
            // Brak statusu nie znaczy "zamkniete", a brak godzin nie znaczy
            // "09:00-17:00". Puste pola ekran pokazuje jako nieznane.
            s: mItem.s ? (String(mItem.s).toUpperCase() as Freedom24MarketInfo['s']) : undefined,
            o: mItem.o || undefined,
            c: mItem.c || undefined,
            dt: mItem.dt !== undefined ? String(mItem.dt) : undefined,
          }));

          return {
            success: true,
            zrodlo: 'freedom24',
            serverTime: res.data.result?.markets?.t || nowIso,
            markets: mapped,
          };
        }
      }
    } catch {
      // ignore and fallback
    }
  }

  // Godziny sesji sa wpisane w kod, a status liczy sie z zegara tej maszyny.
  // To uzyteczne przyblizenie, ale nie jest to odczyt od brokera - i tak
  // musi byc opisane, bo pasek sesji wyglada identycznie w obu przypadkach.
  return {
    success: true,
    zrodlo: 'zegar-lokalny',
    serverTime: nowIso,
    markets: computeLiveMarketStatuses(),
  };
}

router.get('/freedom24/market-status', async (req, res) => {
  const { apiKey, apiSecret, market, mode } = req.query;
  try {
    const result = await getFreedom24MarketStatus(
      apiKey as string,
      apiSecret as string,
      (market as string) || '*',
      mode as string
    );
    odeslijWynik(res, result, maKluczeApi(req));
  } catch (err: any) {
    res.status(500).json({
      success: false,
      zrodlo: 'zegar-lokalny',
      serverTime: new Date().toISOString(),
      markets: computeLiveMarketStatuses(),
      error: err.message,
    });
  }
});

router.post('/freedom24/market-status', async (req, res) => {
  const { apiKey, apiSecret, market, mode } = req.body;
  try {
    const result = await getFreedom24MarketStatus(
      apiKey,
      apiSecret,
      market || '*',
      mode
    );
    odeslijWynik(res, result, maKluczeApi(req));
  } catch (err: any) {
    res.status(500).json({
      success: false,
      zrodlo: 'zegar-lokalny',
      serverTime: new Date().toISOString(),
      markets: computeLiveMarketStatuses(),
      error: err.message,
    });
  }
});

// ============================================================================
// Freedom24 (Tradernet) Security Info API (getSecurityInfo)
// ============================================================================

export interface Freedom24SecurityInfo {
  /** Numer instrumentu w Tradernet. Brak znaczy, ze broker go nie podal. */
  id?: number;
  short_name: string;
  default_ticker: string;
  nt_ticker: string;
  firstDate?: string;
  currency?: string;
  min_step?: number;
  code?: number;
  exchange?: string;
  isin?: string;
}

export interface Freedom24SecurityInfoResponse {
  success: boolean;
  /** Brak pola znaczy, ze instrumentu nie udalo sie ustalic - nie ma opisu zastepczego. */
  securityInfo?: Freedom24SecurityInfo;
  message?: string;
  /**
   * Skad pochodzi opis. Wczesniej wykaz wpisany w kod wracal z `cached: true`,
   * czyli jako odczyt z pamieci podrecznej brokera - a nigdy nie byl pobrany.
   */
  zrodlo?: 'freedom24' | 'wykaz-lokalny';
}

const KNOWN_SECURITIES_DB: Record<string, Freedom24SecurityInfo> = {
  'AAPL': { id: 2772, short_name: 'Apple Inc.', default_ticker: 'AAPL', nt_ticker: 'AAPL.US', firstDate: '02.01.1990', currency: 'USD', min_step: 0.01, code: 0, exchange: 'NASDAQ', isin: 'US0378331005' },
  'NVDA': { id: 8941, short_name: 'NVIDIA Corporation', default_ticker: 'NVDA', nt_ticker: 'NVDA.US', firstDate: '22.01.1999', currency: 'USD', min_step: 0.01, code: 0, exchange: 'NASDAQ', isin: 'US67066G1040' },
  'MSFT': { id: 2890, short_name: 'Microsoft Corporation', default_ticker: 'MSFT', nt_ticker: 'MSFT.US', firstDate: '13.03.1986', currency: 'USD', min_step: 0.01, code: 0, exchange: 'NASDAQ', isin: 'US5949181045' },
  'TSLA': { id: 14205, short_name: 'Tesla, Inc.', default_ticker: 'TSLA', nt_ticker: 'TSLA.US', firstDate: '29.06.2010', currency: 'USD', min_step: 0.01, code: 0, exchange: 'NASDAQ', isin: 'US88160R1014' },
  'INTC': { id: 40000019832, short_name: 'Intel Corp.', default_ticker: 'INTC', nt_ticker: 'INTC.US', firstDate: '02.01.1990', currency: 'USD', min_step: 0.01, code: 0, exchange: 'NASDAQ', isin: 'US4581401001' },
  'NBIS': { id: 40020427262, short_name: 'Nebius Group NV', default_ticker: 'NBIS', nt_ticker: 'NBIS.US', firstDate: '24.05.2011', currency: 'USD', min_step: 0.01, code: 0, exchange: 'NASDAQ', isin: 'NL0009805522' },
  'FRHC': { id: 31200, short_name: 'Freedom Holding Corp.', default_ticker: 'FRHC', nt_ticker: 'FRHC.US', firstDate: '15.10.2019', currency: 'USD', min_step: 0.01, code: 0, exchange: 'NASDAQ', isin: 'US3563901046' },
  'AMZN': { id: 3410, short_name: 'Amazon.com Inc.', default_ticker: 'AMZN', nt_ticker: 'AMZN.US', firstDate: '15.05.1997', currency: 'USD', min_step: 0.01, code: 0, exchange: 'NASDAQ', isin: 'US0231351067' },
  'GOOGL': { id: 6712, short_name: 'Alphabet Inc. (Class A)', default_ticker: 'GOOGL', nt_ticker: 'GOOGL.US', firstDate: '19.08.2004', currency: 'USD', min_step: 0.01, code: 0, exchange: 'NASDAQ', isin: 'US02079K3059' },
  'META': { id: 18450, short_name: 'Meta Platforms, Inc.', default_ticker: 'META', nt_ticker: 'META.US', firstDate: '18.05.2012', currency: 'USD', min_step: 0.01, code: 0, exchange: 'NASDAQ', isin: 'US30303M1027' },
  'AMD': { id: 4510, short_name: 'Advanced Micro Devices', default_ticker: 'AMD', nt_ticker: 'AMD.US', firstDate: '02.01.1990', currency: 'USD', min_step: 0.01, code: 0, exchange: 'NASDAQ', isin: 'US0079031078' },
  'PLTR': { id: 48920, short_name: 'Palantir Technologies', default_ticker: 'PLTR', nt_ticker: 'PLTR.US', firstDate: '30.09.2020', currency: 'USD', min_step: 0.01, code: 0, exchange: 'NYSE', isin: 'US69608A1088' },
  'CDR': { id: 77201, short_name: 'CD Projekt S.A.', default_ticker: 'CDR', nt_ticker: 'CDR.PL', firstDate: '01.06.2010', currency: 'PLN', min_step: 0.10, code: 0, exchange: 'GPW', isin: 'PLOPTTC00011' },
  'PKN': { id: 77202, short_name: 'ORLEN S.A.', default_ticker: 'PKN', nt_ticker: 'PKN.PL', firstDate: '26.11.1999', currency: 'PLN', min_step: 0.05, code: 0, exchange: 'GPW', isin: 'PLPKN0000018' },
  'DNP': { id: 77203, short_name: 'Dino Polska S.A.', default_ticker: 'DNP', nt_ticker: 'DNP.PL', firstDate: '21.04.2017', currency: 'PLN', min_step: 0.20, code: 0, exchange: 'GPW', isin: 'PLDINPL00011' },
  'KGH': { id: 77204, short_name: 'KGHM Polska Miedź S.A.', default_ticker: 'KGH', nt_ticker: 'KGH.PL', firstDate: '10.07.1997', currency: 'PLN', min_step: 0.10, code: 0, exchange: 'GPW', isin: 'PLKGHM000017' },
  'PKO': { id: 77205, short_name: 'PKO Bank Polski S.A.', default_ticker: 'PKO', nt_ticker: 'PKO.PL', firstDate: '10.11.2004', currency: 'PLN', min_step: 0.05, code: 0, exchange: 'GPW', isin: 'PLPKO0000016' },
  'VOO': { id: 25410, short_name: 'Vanguard S&P 500 ETF', default_ticker: 'VOO', nt_ticker: 'VOO.US', firstDate: '09.09.2010', currency: 'USD', min_step: 0.01, code: 0, exchange: 'NYSE Arca', isin: 'US9229083632' },
  'QQQ': { id: 11200, short_name: 'Invesco QQQ Trust', default_ticker: 'QQQ', nt_ticker: 'QQQ.US', firstDate: '10.03.1999', currency: 'USD', min_step: 0.01, code: 0, exchange: 'NASDAQ', isin: 'US46090E1038' },
  'SPY': { id: 10100, short_name: 'SPDR S&P 500 ETF Trust', default_ticker: 'SPY', nt_ticker: 'SPY.US', firstDate: '22.01.1993', currency: 'USD', min_step: 0.01, code: 0, exchange: 'NYSE Arca', isin: 'US78462F1030' },
  // Kryptowaluty nie maja ISIN-u. Wpisy 'CRPT-BTC-001' i 'CRPT-ETH-002' byly
  // wymyslone, a ekran notowan pokazywal je w polu "ISIN" obok prawdziwych.
  'BTC': { short_name: 'Bitcoin Spot', default_ticker: 'BTC', nt_ticker: 'BTC.CRPT', firstDate: '03.01.2009', currency: 'USD', min_step: 0.01, code: 0, exchange: 'BINANCE/CRYPTO' },
  'ETH': { short_name: 'Ethereum Spot', default_ticker: 'ETH', nt_ticker: 'ETH.CRPT', firstDate: '30.07.2015', currency: 'USD', min_step: 0.01, code: 0, exchange: 'BINANCE/CRYPTO' },
};

/** Broker dla czesci walorow oddaje date-zaslepke z 1970 r. - takiej nie pokazujemy jako debiutu. */
export function wiarygodnaDataDebiutu(wartosc: unknown): string | undefined {
  const tekst = String(wartosc ?? '').trim();
  const rok = Number(tekst.match(/(19|20)\d{2}/)?.[0]);
  return tekst && Number.isFinite(rok) && rok > 1970 ? tekst : undefined;
}

export async function getFreedom24SecurityInfo(
  ticker: string,
  apiKey?: string,
  apiSecret?: string,
  sup: boolean = true
): Promise<Freedom24SecurityInfoResponse> {
  const rawSymbol = (ticker || '').toUpperCase().trim();
  const baseSymbol = rawSymbol.replace(/\.(US|EU|PL|WA|DE|UK)$/, '');
  const tradernetSymbol = rawSymbol.includes('.') ? rawSymbol : `${rawSymbol}.US`;

  // Klucze zna tylko serwer. Przegladarka juz ich nie przysyla, wiec bez tego
  // odczytu kazdy walor dostawal opis z wykazu lokalnego - takze cudzy (NBIS
  // z numerem i ISIN-em innej spolki).
  const lokalny = createFreedom24Api();
  if (lokalny) {
    const odp = await lokalny.read<any>('getSecurityInfo', { ticker: tradernetSymbol, sup });
    const d = odp.ok === false ? null : odp.data?.result || odp.data;
    if (d && (d.id || d.short_name || d.default_ticker)) {
      const liczba = (v: unknown): number | undefined => {
        const n = parseFloat(String(v));
        return Number.isFinite(n) ? n : undefined;
      };
      return {
        success: true,
        zrodlo: 'freedom24',
        securityInfo: {
          id: liczba(d.id),
          short_name: d.short_name || d.name || baseSymbol,
          default_ticker: d.default_ticker || baseSymbol,
          nt_ticker: d.nt_ticker || tradernetSymbol,
          firstDate: wiarygodnaDataDebiutu(d.firstDate || d.first_date),
          currency: d.currency ? String(d.currency).toUpperCase() : undefined,
          min_step: liczba(d.min_step),
          code: d.code !== undefined ? d.code : undefined,
        },
      };
    }
  }

  if (apiKey?.trim() && apiSecret?.trim()) {
    try {
      const res = await sendTradernetRequest(
        'getSecurityInfo',
        { ticker: tradernetSymbol, sup },
        apiKey.trim(),
        apiSecret.trim()
      );

      if (res && res.success && res.data) {
        const d = res.data.result || res.data;
        if (d && (d.id || d.short_name || d.default_ticker)) {
          // Pola, ktorych broker nie podal, zostaja puste. Wczesniej brak
          // numeru dawal `Math.random()`, brak daty debiutu 01.01.2000,
          // brak waluty USD, a brak kroku ceny 0,01 - i wszystko to trafialo
          // na ekran jako odczyt z Freedom24.
          const liczba = (v: unknown): number | undefined => {
            const n = parseFloat(String(v));
            return Number.isFinite(n) ? n : undefined;
          };
          return {
            success: true,
            zrodlo: 'freedom24',
            securityInfo: {
              id: liczba(d.id),
              short_name: d.short_name || d.name || baseSymbol,
              default_ticker: d.default_ticker || baseSymbol,
              nt_ticker: d.nt_ticker || tradernetSymbol,
              firstDate: wiarygodnaDataDebiutu(d.firstDate || d.first_date),
              currency: d.currency ? String(d.currency).toUpperCase() : undefined,
              min_step: liczba(d.min_step),
              code: d.code !== undefined ? d.code : undefined,
            },
          };
        }
      }
    } catch {
      // fallback to master db
    }
  }

  // Lookup in Master DB
  const matched = KNOWN_SECURITIES_DB[baseSymbol] || KNOWN_SECURITIES_DB[rawSymbol];
  if (matched) {
    return {
      success: true,
      zrodlo: 'wykaz-lokalny',
      securityInfo: matched,
      message:
        'Opis pochodzi z wykazu wpisanego w aplikacje, nie z Freedom24. Numery instrumentow ' +
        'i daty debiutu moga nie zgadzac sie z danymi brokera.',
    };
  }

  // Wczesniej powstawal tu opis papieru "z powietrza": identyfikator liczony
  // z hasza symbolu, nazwa "XXX Security", data pierwszego notowania
  // 01.01.2015 i waluta zgadnieta z koncowki tickera. Wygladal jak odczyt
  // z bazy brokera.
  return {
    success: false,
    message:
      `Nie znaleziono danych instrumentu ${rawSymbol} w Freedom24 ani w lokalnym wykazie. ` +
      'Sprawdź ticker albo klucze API.',
  };
}

router.get('/freedom24/security-info', async (req, res) => {
  const { ticker, apiKey, apiSecret, sup } = req.query;
  try {
    if (!ticker) {
      // Bez tickera wracaly wczesniej dane Apple - odpowiedz wygladala na
      // poprawna i dotyczyla nie tego papieru, o ktory pytano.
      return res.status(400).json({ success: false, message: 'Podaj ticker instrumentu.' });
    }
    const result = await getFreedom24SecurityInfo(
      ticker as string,
      apiKey as string,
      apiSecret as string,
      sup !== 'false'
    );
    odeslijWynik(res, result, maKluczeApi(req));
  } catch (err: any) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.post('/freedom24/security-info', async (req, res) => {
  const { ticker, apiKey, apiSecret, sup } = req.body;
  try {
    if (!ticker) {
      return res.status(400).json({ success: false, message: 'Podaj ticker instrumentu.' });
    }
    const result = await getFreedom24SecurityInfo(ticker, apiKey, apiSecret, sup !== false);
    odeslijWynik(res, result, maKluczeApi(req));
  } catch (err: any) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ============================================================================
// Freedom24 (Tradernet) Historical Candlesticks (getHloc / quotes-get-hloc)
// ============================================================================

export interface Freedom24HlocPoint {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export async function getFreedom24Hloc(
  ticker: string,
  interval: string = 'D',
  dateFrom?: string,
  dateTo?: string,
  count: number = 60,
  apiKey?: string,
  apiSecret?: string
) {
  const cleanTicker = (ticker || '').toUpperCase().trim();
  const tradernetTicker = cleanTicker.includes('.') ? cleanTicker : `${cleanTicker}.US`;

  const res = await odczytajFreedom24('getHloc', {
    id: tradernetTicker,
    count,
    interval: interval || 'D',
    ...(dateFrom ? { date_from: dateFrom } : {}),
    ...(dateTo ? { date_to: dateTo } : {}),
  }, apiKey, apiSecret);
  if (res.configured) {
    if (!res.success) return { success: false, ticker: cleanTicker, points: [], message: res.error };

      if (res.data) {
        const rawBars = res.data.hloc || res.data.result?.hloc || [];
        if (Array.isArray(rawBars)) {
          // Slupek bez daty dostawal date dzisiejsza, a bez ceny - zero, czyli
          // zjazd wykresu do zera w dniu, ktorego broker nie przyslal.
          const points: Freedom24HlocPoint[] = tylkoObiekty(rawBars)
            .map((b: any): Freedom24HlocPoint | null => {
              const data = b.date || b.t;
              const zamkniecie = liczbaZPol(b.c, b.close);
              if (!data || zamkniecie === null) return null;
              return {
                date: String(data),
                open: liczbaZPol(b.o, b.open) ?? zamkniecie,
                high: liczbaZPol(b.h, b.high) ?? zamkniecie,
                low: liczbaZPol(b.l, b.low) ?? zamkniecie,
                close: zamkniecie,
                volume: liczbaZPol(b.v, b.volume) ?? 0,
              };
            })
            .filter((punkt): punkt is Freedom24HlocPoint => punkt !== null);

          return {
            success: true,
            ticker: cleanTicker,
            points,
          };
        }
      }
    return { success: false, ticker: cleanTicker, points: [], message: 'Freedom24 nie zwrócił świec dla tego zakresu.' };
  }

  // Generate realistic candles based on base price
  const now = Date.now();
  const points: Freedom24HlocPoint[] = [];
  let basePrice = 185.0;
  if (['NVDA', 'MSFT', 'META'].includes(cleanTicker)) basePrice = 420.0;
  if (['BTC', 'BTC.CRPT'].includes(cleanTicker)) basePrice = 64500.0;
  if (['CDR', 'PKN', 'DNP'].includes(cleanTicker)) basePrice = 140.0;

  for (let i = count; i >= 0; i--) {
    const time = new Date(now - i * 86400000);
    const dateStr = time.toISOString().slice(0, 10);
    const change = (Math.sin(i * 0.4) + (Math.random() - 0.48)) * (basePrice * 0.02);
    const close = Math.max(1, basePrice + change);
    const open = close - (Math.random() - 0.5) * (basePrice * 0.015);
    const high = Math.max(open, close) + Math.random() * (basePrice * 0.01);
    const low = Math.min(open, close) - Math.random() * (basePrice * 0.01);
    const volume = Math.floor(Math.random() * 2000000 + 500000);

    points.push({
      date: dateStr,
      open: parseFloat(open.toFixed(2)),
      high: parseFloat(high.toFixed(2)),
      low: parseFloat(low.toFixed(2)),
      close: parseFloat(close.toFixed(2)),
      volume,
    });
    basePrice = close;
  }

  // Przebieg wyliczony lokalnie, a nie notowania z gieldy. `cached: true`
  // zostalo tu obok znacznika demoData i nadal mowilo "dane prawdziwe, tylko
  // nieswieze" - to nie jest odczyt z pamieci podrecznej brokera.
  return {
    success: true,
    ticker: cleanTicker,
    points,
    demoData: true,
    demoReason: 'Brak poświadczeń Freedom24 na serwerze. Przebieg jest poglądowy.',
  };
}

router.post('/freedom24/hloc', async (req, res) => {
  const { ticker, interval, dateFrom, dateTo, count, apiKey, apiSecret } = req.body;
  try {
    const result = await getFreedom24Hloc(ticker, interval, dateFrom, dateTo, count, apiKey, apiSecret);
    odeslijWynik(res, result, maKluczeApi(req) || !!createFreedom24Api());
  } catch (err: any) {
    res.status(500).json({ success: false, message: sanitizeFreedom24Text(err?.message), points: [] });
  }
});

// ============================================================================
// Freedom24 Top Movers & Gainers (quotes-get-top-securities)
// ============================================================================

/** Tickery posiadanych spolek, o ktore wolno zapytac: forma `SYMBOL.RYNEK`, bez powtorzen, najwyzej 8. */
export function tickeryDoDepesz(wejscie: unknown): string[] {
  if (!Array.isArray(wejscie)) return [];
  const wynik: string[] = [];
  for (const pozycja of wejscie) {
    const ticker = String(pozycja ?? '').trim().toUpperCase();
    if (/^[A-Z0-9]{1,12}\.[A-Z0-9]{1,8}$/.test(ticker) && !wynik.includes(ticker)) wynik.push(ticker);
    if (wynik.length === 8) break;
  }
  return wynik;
}

/** Depesze z `getNewsList`. Pola, ktorych broker nie podal, zostaja puste - niczego nie dopisujemy. */
export function depeszeZOdpowiedzi(dane: unknown): Freedom24NewsItem[] {
  const lista = (dane as any)?.list ?? (dane as any)?.result?.list;
  if (!Array.isArray(lista)) return [];
  return lista
    .filter((wiersz) => wiersz && typeof wiersz === 'object' && String(wiersz.title ?? '').trim())
    .map((wiersz) => ({
      id: Number(wiersz.id),
      title: String(wiersz.title).trim(),
      source: String(wiersz.provider ?? wiersz.providerAlias ?? '').trim(),
      date: String(wiersz.date ?? '').trim(),
      tickers: Array.isArray(wiersz.tickers) ? wiersz.tickers.map((t: unknown) => String(t)) : [],
      summary: '',
      url: typeof wiersz.url === 'string' && /^https?:\/\//.test(wiersz.url) ? wiersz.url : undefined,
      sentiment: typeof wiersz.sentiment === 'string' ? wiersz.sentiment : undefined,
    }));
}

/** Ranking brokera to same tickery; cene i zmiane dokladamy z notowan. Spolka bez notowania odpada - bez ceny 0. */
export async function rankingZCenami(
  dane: unknown,
  wzrosty: boolean,
  notowanie: (ticker: string) => Promise<any | null>,
): Promise<Freedom24TopSecurity[]> {
  const tickery: unknown[] = (dane as any)?.tickers ?? (dane as any)?.result?.tickers ?? [];
  const nazwy = (dane as any)?.details ?? (dane as any)?.result?.details ?? {};
  const wynik: Freedom24TopSecurity[] = [];
  for (const surowy of Array.isArray(tickery) ? tickery : []) {
    const ticker = String(surowy ?? '').toUpperCase();
    if (!ticker) continue;
    const q = await notowanie(ticker).catch(() => null);
    if (!q || !(q.price > 0) || typeof q.changePercent24h !== 'number' || !q.currency) continue;
    wynik.push({
      ticker,
      name: String(nazwy?.[ticker]?.name ?? q.name ?? ticker),
      price: q.price,
      changePercent: q.changePercent24h,
      volume: typeof q.volume24h === 'number' ? q.volume24h : 0,
      currency: q.currency,
      type: wzrosty ? 'GAINER' : 'MOST_ACTIVE',
    });
  }
  return wynik;
}

export interface Freedom24TopSecurity {
  ticker: string;
  name: string;
  price: number;
  changePercent: number;
  volume: number;
  currency: string;
  type: 'GAINER' | 'LOSER' | 'MOST_ACTIVE';
}

export async function getFreedom24TopSecurities(apiKey?: string, apiSecret?: string, type: string = 'gainers') {
  if (apiKey?.trim() && apiSecret?.trim()) {
    try {
      const res = await sendTradernetRequest(
        'getTopSecurities',
        { type: type || 'gainers', count: 10 },
        apiKey.trim(),
        apiSecret.trim()
      );
      if (res && res.success && res.data) {
        const rawList = res.data.securities || res.data.result?.securities || [];
        if (Array.isArray(rawList) && rawList.length > 0) {
          // Pozycja bez ceny albo bez zmiany procentowej nie jest notowaniem.
          // Wczesniej brak zmiany dawal 0, czyli etykiete GAINER i "+0,00%".
          const czytelne: Freedom24TopSecurity[] = tylkoObiekty(rawList)
            .map((item: any): Freedom24TopSecurity | null => {
              const cena = liczbaZPol(item.price, item.ltp);
              const zmiana = liczbaZPol(item.changePercent, item.chgp);
              const ticker = item.ticker || item.i || item.name;
              if (!ticker || cena === null || zmiana === null) return null;
              return {
                ticker,
                name: item.short_name || item.name || ticker,
                price: cena,
                changePercent: zmiana,
                volume: liczbaZPol(item.volume, item.vol) ?? 0,
                currency: String(item.currency || '').toUpperCase(),
                type: zmiana >= 0 ? 'GAINER' : 'LOSER',
              };
            })
            .filter((item): item is Freedom24TopSecurity => item !== null);
          if (czytelne.length > 0) {
            return { success: true, securities: czytelne };
          }
        }
      }
    } catch {
      // fallback
    }
  }

  // Curated live market movers
  const gainers: Freedom24TopSecurity[] = [
    { ticker: 'NVDA', name: 'NVIDIA Corp', price: 128.50, changePercent: 4.82, volume: 54200000, currency: 'USD', type: 'GAINER' },
    { ticker: 'NBIS', name: 'Nebius Group', price: 34.20, changePercent: 7.15, volume: 12400000, currency: 'USD', type: 'GAINER' },
    { ticker: 'PLTR', name: 'Palantir Tech', price: 31.40, changePercent: 5.60, volume: 29800000, currency: 'USD', type: 'GAINER' },
    { ticker: 'FRHC', name: 'Freedom Holding', price: 104.20, changePercent: 3.45, volume: 450000, currency: 'USD', type: 'GAINER' },
    { ticker: 'TSLA', name: 'Tesla Inc', price: 218.90, changePercent: -2.30, volume: 41200000, currency: 'USD', type: 'LOSER' },
    { ticker: 'INTC', name: 'Intel Corp', price: 21.40, changePercent: -3.10, volume: 38900000, currency: 'USD', type: 'LOSER' },
  ];

  // Zaszyta lista z cenami. Bez znacznika wygladala jak biezacy ranking sesji.
  return {
    success: true,
    securities: gainers,
    // `cached: true` obok demoData nadal mowilo "dane brokera, tylko nieswieze".
    demoData: true,
    demoReason: 'Brak danych z Freedom24. Lista jest przykładowa, nie z bieżącej sesji.',
  };
}

router.post('/freedom24/top-securities', async (req, res) => {
  const api = createFreedom24Api();
  if (!api) return res.json({ success: true, configured: false, demoData: false, securities: [], message: 'Brak lokalnych kluczy Freedom24 na serwerze.' });
  const gainers = String(req.body?.type ?? 'gainers') === 'active' ? 0 : 1;
  const wynik = await api.read<any>('getTopSecurities', { type: 'stocks', exchange: 'usa', gainers, limit: 12 });
  if (wynik.ok === false) return res.status(502).json({ success: false, securities: [], message: wynik.error.message });
  res.json({ success: true, configured: true, demoData: false, securities: await rankingZCenami(wynik.data, gainers === 1, fetchYahooQuote) });
});

// ============================================================================
// Freedom24 Market & Company News Feed (get-news-list)
// ============================================================================

export interface Freedom24NewsItem {
  id: number;
  title: string;
  source: string;
  date: string;
  tickers: string[];
  summary: string;
  url?: string;
  sentiment?: string;
}

router.post('/freedom24/news', async (req, res) => {
  const api = createFreedom24Api();
  if (!api) return res.json({ success: true, configured: false, demoData: false, news: [], newsByTicker: {}, message: 'Brak lokalnych kluczy Freedom24 na serwerze.' });
  const ile = Math.min(Math.max(Number(req.body?.count) || 10, 1), 30);
  const tickery = tickeryDoDepesz(req.body?.tickers);
  const ogolne = await api.read<any>('getNewsList', { lang: 'pl', take: ile, skip: 0 });
  if (ogolne.ok === false) return res.status(502).json({ success: false, news: [], newsByTicker: {}, message: ogolne.error.message });
  const newsByTicker: Record<string, Freedom24NewsItem[]> = {};
  const warnings: string[] = [];
  // Po kolei, nie rownolegle - kilka spolek to kilka zapytan, nie seria.
  for (const ticker of tickery) {
    const dlaSpolki = await api.read<any>('getNewsList', { ticker, lang: 'pl', take: 5, skip: 0 });
    if (dlaSpolki.ok === false) warnings.push(`${ticker}: ${dlaSpolki.error.message}`);
    else newsByTicker[ticker] = depeszeZOdpowiedzi(dlaSpolki.data);
  }
  res.json({ success: true, configured: true, demoData: false, news: depeszeZOdpowiedzi(ogolne.data), newsByTicker, warnings });
});

// ============================================================================
// Freedom24 Cash Flows & Dividends (get-cashflows)
// ============================================================================

/**
 * Parametry ruchow pienieznych wedlug dokumentacji Tradernet.
 *
 * Polecenie nazywa sie `getUserCashFlows`, a nie `getCashflows`, i nie zna
 * parametrow `date_from`/`date_to` - zakres dat podaje sie przez `filters`
 * z polem `date` i operatorem porownania. Lista wraca pod kluczem `cashflow`
 * (liczba pojedyncza). Przez te trzy rzeczy odczyt konczyl sie pusta lista,
 * czyli "nie bylo wyplat" zamiast dywidend, prowizji i odsetek.
 */
export function parametryRuchowPienieznych(dateFrom?: string, dateTo?: string, take = 100, skip = 0) {
  const filters: Array<{ field: string; operator: string; value: string }> = [];
  if (dateFrom) filters.push({ field: 'date', operator: 'eqormore', value: dateFrom });
  if (dateTo) filters.push({ field: 'date', operator: 'eqorless', value: dateTo });
  return {
    take: Math.min(Math.max(Math.trunc(take) || 100, 1), 100),
    skip,
    filters: filters.length > 0 ? filters : {},
  };
}

export async function getFreedom24CashFlows(apiKey?: string, apiSecret?: string, dateFrom?: string, dateTo?: string) {
  const cashflows: any[] = [];
  const take = 100;
  for (let page = 0; page < 1_000; page += 1) {
    const res = await odczytajFreedom24('getUserCashFlows', parametryRuchowPienieznych(dateFrom, dateTo, take, cashflows.length), apiKey, apiSecret);
    if (!res.success || !res.data) {
      return { success: false, cashflows: [], message: `${res.error || 'Freedom24 nie zwrócił przepływów.'} To nie znaczy, że nie było wypłat.` };
    }
    const rows = wyciagnijListe(res.data, 'cashflow', 'result.cashflow', 'cashflows', 'result.cashflows');
    const total = Number(res.data.total ?? res.data.result?.total);
    if (!Array.isArray(rows)) {
      return { success: false, cashflows: [], message: 'Freedom24 zwrócił nieprawidłową stronę przepływów. To nie znaczy, że nie było wypłat.' };
    }
    if (rows.length === 0 && Number.isFinite(total) && cashflows.length < total) {
      return { success: false, cashflows: [], message: 'Eksport przepływów z Freedom24 jest niepełny. To nie znaczy, że nie było wypłat.' };
    }
    cashflows.push(...rows);
    if (Number.isFinite(total) ? cashflows.length >= total : rows.length < take) {
      return { success: true, cashflows };
    }
  }
  return { success: false, cashflows: [], message: 'Eksport przepływów z Freedom24 przekroczył limit stron. To nie znaczy, że nie było wypłat.' };
}

router.post('/freedom24/cashflows', async (req, res) => {
  const { apiKey, apiSecret, dateFrom, dateTo } = req.body;
  try {
    const result = await getFreedom24CashFlows(apiKey, apiSecret, dateFrom, dateTo);
    odeslijWynik(res, result, maKluczeApi(req) || !!createFreedom24Api());
  } catch (err: any) {
    res.status(500).json({ success: false, message: sanitizeFreedom24Text(err?.message), cashflows: [] });
  }
});

// ============================================================================
// Freedom24 Options Chain Explorer (getOptionsByMktNameAndBaseAsset)
// ============================================================================

export interface Freedom24OptionContract {
  strike: number;
  callTicker: string | null;
  callBid: number | null;
  callAsk: number | null;
  callIV: number | null;
  callDelta: number | null;
  callOpenInterest: number | null;
  putTicker: string | null;
  putBid: number | null;
  putAsk: number | null;
  putIV: number | null;
  putDelta: number | null;
  putOpenInterest: number | null;
}

export interface Freedom24OptionsChainResponse {
  success: boolean;
  ticker: string;
  /** `null`, gdy ceny instrumentu bazowego nie zna ani broker, ani ekran. */
  underlyingPrice: number | null;
  expirationDates: string[];
  selectedExpiration: string;
  contracts: Freedom24OptionContract[];
  message?: string;
}

function kodInstrumentuOpcji(ticker: string): string | null {
  const symbol = String(ticker || '').trim().toUpperCase();
  // Ekran przesyła również symbole bez sufiksu; dotychczas oznaczały rynek USA.
  if (/^[A-Z0-9]{1,12}$/.test(symbol)) return `${symbol}.US`;
  return /^[A-Z0-9]{1,12}\.US$/.test(symbol) ? symbol : null;
}

export async function getFreedom24Options(
  ticker: string,
  expiration?: string,
  apiKey?: string,
  apiSecret?: string,
  /** Notowanie instrumentu bazowego znane po stronie ekranu. */
  cenaBazowa?: number | null
): Promise<Freedom24OptionsChainResponse> {
  const tradernetTicker = kodInstrumentuOpcji(ticker);
  const cleanTicker = String(ticker || '').trim().toUpperCase().replace(/\.US$/, '');
  const cenaZnana =
    typeof cenaBazowa === 'number' && Number.isFinite(cenaBazowa) && cenaBazowa > 0
      ? cenaBazowa
      : null;
  const empty = { ticker: cleanTicker, underlyingPrice: cenaZnana, expirationDates: [], selectedExpiration: expiration || '', contracts: [] };
  if (!tradernetTicker) return { success: false, ...empty, message: 'Obsługiwany jest tylko rynek USA (.US/FIX); dla tego sufiksu nie znam kodu rynku opcji.' };

  const res = await odczytajFreedom24('getOptionsByMktNameAndBaseAsset', { ltr: 'FIX', base_contract_code: tradernetTicker }, apiKey, apiSecret);
  if (!res.success) return { success: false, ...empty, message: res.error || 'Nie udało się pobrać opcji z Freedom24.' };
  if (!Array.isArray(res.data)) return { success: false, ...empty, message: 'Freedom24 zwrócił nieprawidłową listę opcji.' };

  const rows = res.data.filter((row: any) => row && row.base_contract_code === tradernetTicker &&
    /^\d{4}-\d{2}-\d{2}$/.test(String(row.expire_date)) &&
    Number.isFinite(Number(row.strike_price)) && Number(row.strike_price) > 0 &&
    ['CALL', 'PUT'].includes(String(row.option_type).toUpperCase()) && typeof row.ticker === 'string');
  const expirationDates = [...new Set<string>(rows.map((row: any) => String(row.expire_date)))].sort();
  const selectedExpiration = expiration || expirationDates[0] || '';
  const byStrike = new Map<number, Freedom24OptionContract>();
  for (const row of rows.filter((item: any) => item.expire_date === selectedExpiration)) {
    const strike = Number(row.strike_price);
    const contract = byStrike.get(strike) ?? {
      strike, callTicker: null, callBid: null, callAsk: null, callIV: null, callDelta: null, callOpenInterest: null,
      putTicker: null, putBid: null, putAsk: null, putIV: null, putDelta: null, putOpenInterest: null,
    };
    if (String(row.option_type).toUpperCase() === 'CALL') contract.callTicker = row.ticker;
    else contract.putTicker = row.ticker;
    byStrike.set(strike, contract);
  }
  return { success: true, ticker: cleanTicker, underlyingPrice: cenaZnana, expirationDates,
    selectedExpiration, contracts: [...byStrike.values()].sort((a, b) => a.strike - b.strike) };
}

router.post('/freedom24/options', async (req, res) => {
  const { ticker, expiration, apiKey, apiSecret, underlyingPrice } = req.body;
  if (!kodInstrumentuOpcji(ticker)) {
    return res.status(400).json({ success: false, message: 'Obsługiwany jest tylko rynek USA (.US/FIX); dla tego sufiksu nie znam kodu rynku opcji.', contracts: [] });
  }
  if (!maKluczeApi(req) && !createFreedom24Api()) {
    return res.status(400).json({ success: false, message: 'Brak kluczy API dla Freedom24.', contracts: [] });
  }
  try {
    const result = await getFreedom24Options(
      ticker,
      expiration,
      apiKey,
      apiSecret,
      typeof underlyingPrice === 'number' ? underlyingPrice : null
    );
    odeslijWynik(res, result, true);
  } catch (err: any) {
    res.status(500).json({ success: false, message: sanitizeFreedom24Text(err?.message), contracts: [] });
  }
});

// ============================================================================
// Freedom24 Orders History & Active Working Orders (get-orders-history)
// ============================================================================

export interface Freedom24Order {
  /** Pola, ktorych broker moze nie podac. Brak znaczy "nieznane". */
  id?: string;
  date?: string;
  ticker: string;
  type: 'BUY' | 'SELL';
  orderType?: 'LIMIT' | 'MARKET' | 'STOP_LIMIT' | 'STOP_LOSS';
  qty: number;
  filledQty: number;
  price: number;
  stopPrice?: number;
  status?: 'ACTIVE' | 'FILLED' | 'CANCELLED';
  currency?: string;
}

export async function getFreedom24OrdersHistory(
  apiKey?: string,
  apiSecret?: string,
  statusFilter: 'ALL' | 'ACTIVE' = 'ALL'
) {
  const res = await odczytajFreedom24('getOrdersHistory', { active_only: statusFilter === 'ACTIVE' ? 1 : 0 }, apiKey, apiSecret);
  if (res.success && res.data) {
        const rawOrders = res.data.orders?.order || res.data.result?.orders || [];
        if (Array.isArray(rawOrders)) {
          // Numer zlecenia, data i status pochodza wylacznie od brokera.
          // Wczesniej brak numeru dawal Math.random(), brak daty - chwile
          // wykonania zapytania, a brak statusu byl zgadywany z ilosci
          // wykonanej: "FILLED" albo "ACTIVE" jako fakt z gieldy.
          const mapped: Freedom24Order[] = tylkoObiekty(rawOrders).map((o: any) => ({
            id: o.id || o.order_id ? String(o.id || o.order_id) : undefined,
            date: o.date || o.datetime || undefined,
            ticker: String(o.instr_nm || o.ticker || '').replace('.US', ''),
            type: (o.type === 1 || o.action === 'buy' ? 'BUY' : 'SELL') as Freedom24Order['type'],
            orderType: o.order_type
              ? (String(o.order_type).toUpperCase() as Freedom24Order['orderType'])
              : undefined,
            qty: parseFloat(o.q || o.qty || '1'),
            filledQty: parseFloat(o.filled_q || o.q_done || '0'),
            price: parseFloat(o.p || o.price || '0'),
            stopPrice: o.stop_price ? parseFloat(o.stop_price) : undefined,
            status: o.status
              ? (String(o.status).toUpperCase() as Freedom24Order['status'])
              : undefined,
            currency: o.curr || undefined,
          }));

          return {
            success: true,
            orders: mapped,
          };
        }
  }

  // Wczesniej stala tu lista przykladowych zlecen zwracana jako historia
  // uzytkownika - z numerami, cenami i statusami, ktorych nigdy nie zlozyl.
  return {
    success: false,
    orders: [],
    message: res.error || 'Freedom24 nie zwrócił historii zleceń.',
  };
}

router.post('/freedom24/orders-history', async (req, res) => {
  const { apiKey, apiSecret, statusFilter } = req.body;
  try {
    const result = await getFreedom24OrdersHistory(apiKey, apiSecret, statusFilter);
    odeslijWynik(res, result, maKluczeApi(req) || !!createFreedom24Api());
  } catch (err: any) {
    res.status(500).json({ success: false, message: sanitizeFreedom24Text(err?.message), orders: [] });
  }
});

// ============================================================================
// Freedom24 Live Portfolio & Balance (getPositionJson / portfolio-get-changes)
// ============================================================================

export interface Freedom24AccountBalance {
  curr: string;
  /** Kurs na USD; `null`, gdy broker go nie podal - wtedy saldo nie wchodzi do sumy. */
  currval: number | null;
  s: number;
  forecast_in: number;
  forecast_out: number;
  t2_in: number;
  t2_out: number;
}

export interface Freedom24LivePosition {
  i: string;
  name: string;
  name2?: string;
  q: number;
  curr: string;
  currval: number | null;
  /** `null`, gdy broker nie podal liczby - zero znaczyloby "warta zero". */
  mkt_price: number | null;
  market_value: number | null;
  bal_price_a: number | null;
  price_a: number | null;
  open_bal: number | null;
  profit_price: number | null;
  profit_close: number | null;
  close_price: number;
  acc_pos_id: number;
  instr_id: number;
  issue_nb?: string;
}

export async function getFreedom24PortfolioLive(apiKey?: string, apiSecret?: string) {
  if (apiKey?.trim() && apiSecret?.trim()) {
    try {
      const res = await sendTradernetRequest('getPositionJson', {}, apiKey.trim(), apiSecret.trim());
      if (res && res.success && res.data) {
        const ps = res.data.result?.ps || res.data.ps || res.data;
        // Brak identyfikatora konta dawal tekst "Freedom24 User" pokazywany
        // jako nazwa rachunku uzytkownika.
        const userEmail: string = ps.key || res.data.key || '';
        const rawAcc = ps.acc || [];
        const rawPos = ps.pos || [];

        /**
         * Kurs przeliczenia na USD; `null`, gdy broker go nie podal.
         * Dla samego USD kurs wynosi 1 z definicji i nie trzeba go odczytywac -
         * bez tego wyjatku saldo dolarowe bez pola `currval` wypadaloby z sumy.
         */
        const kurs = (surowy: unknown, waluta: string): number | null => {
          if (waluta === 'USD') return 1;
          const n = parseFloat(String(surowy));
          return Number.isFinite(n) && n > 0 ? n : null;
        };


        const acc: Freedom24AccountBalance[] = tylkoObiekty(rawAcc).map((a: any) => {
          const waluta = (a.curr || '').toUpperCase();
          return ({
          curr: waluta,
          // `parseFloat(a.currval || '1')` znaczylo, ze saldo w walucie bez
          // kursu liczylo sie jak dolary: 10 000 PLN wchodzilo do sumy jako
          // 10 000 USD.
          currval: kurs(a.currval, waluta),
          s: parseFloat(a.s || '0'),
          forecast_in: parseFloat(a.forecast_in || '0'),
          forecast_out: parseFloat(a.forecast_out || '0'),
          t2_in: parseFloat(a.t2_in || '0'),
          t2_out: parseFloat(a.t2_out || '0'),
          });
        });

        const pos: Freedom24LivePosition[] = tylkoObiekty(rawPos).map((p: any) => {
          const ilosc = liczbaZPol(p.q);
          const cenaRynkowa = liczbaZPol(p.mkt_price, p.price_a);
          const cenaZakupu = liczbaZPol(p.price_a);
          return {
            // Bez tickera pozycja nie jest pozycja - wczesniej stawalo tu
            // "AAPL.US" razem z ISIN-em Apple ponizej.
            i: p.i || p.ticker || '',
            name: p.name || p.name2 || p.i,
            name2: p.name2,
            q: ilosc ?? 0,
            curr: (p.curr || '').toUpperCase(),
            currval: kurs(p.currval, (p.curr || '').toUpperCase()),
            mkt_price: cenaRynkowa,
            market_value:
              liczbaZPol(p.market_value) ??
              (ilosc !== null && cenaRynkowa !== null ? ilosc * cenaRynkowa : null),
            bal_price_a: liczbaZPol(p.bal_price_a, p.price_a),
            price_a: cenaZakupu,
            open_bal:
              liczbaZPol(p.open_bal) ??
              (ilosc !== null && cenaZakupu !== null ? ilosc * cenaZakupu : null),
            profit_price: liczbaZPol(p.profit_price),
            profit_close: liczbaZPol(p.profit_close),
            close_price: liczbaZPol(p.close_price),
            acc_pos_id: p.acc_pos_id ?? 0,
            instr_id: p.instr_id ?? 0,
            issue_nb: p.issue_nb || undefined,
          };
        });

        // Do sumy w dolarach wchodzi tylko to, co da sie na dolary przeliczyc.
        const saldaBezKursu = acc.filter((a) => a.currval === null && a.s !== 0);
        const pozycjeBezWyceny = pos.filter((p) => p.market_value === null);
        const totalValueUSD =
          pos.reduce((sum, p) => sum + (p.market_value ?? 0), 0) +
          acc.reduce((sum, a) => sum + (a.currval === null ? 0 : a.s * a.currval), 0);
        const totalProfitUSD = pos.reduce((sum, p) => sum + (p.profit_close ?? 0), 0);

        return {
          success: true,
          userEmail,
          acc,
          pos,
          totalValueUSD,
          totalProfitUSD,
          pominietoWWycenie:
            saldaBezKursu.length > 0 || pozycjeBezWyceny.length > 0
              ? [
                  saldaBezKursu.length > 0
                    ? `Suma nie obejmuje sald ${saldaBezKursu
                        .map((a) => `${a.s} ${a.curr || '?'}`)
                        .join(', ')} - Freedom24 nie podalo kursu przeliczenia na USD.`
                    : null,
                  pozycjeBezWyceny.length > 0
                    ? `Suma nie obejmuje pozycji ${pozycjeBezWyceny
                        .map((p) => p.i || '?')
                        .join(', ')} - Freedom24 nie podalo ich wartosci ani ceny.`
                    : null,
                ]
                  .filter(Boolean)
                  .join(' ')
              : undefined,
        };
      }
    } catch {
      // fallback
    }
  }

  // Pusty portfel z wartoscia 0 USD nie jest odczytem - to brak odczytu.
  return {
    success: false,
    message:
      'Nie udało się pobrać pozycji z Freedom24. Wartość 0 nie oznacza pustego rachunku.',
    userEmail: '',
    acc: [],
    pos: [],
    totalValueUSD: 0,
    totalProfitUSD: 0,
  };
}

// ============================================================================
// Freedom24 CPS History & Files (getClientCpsHistory & getCpsFiles)
// ============================================================================

export interface Freedom24CpsItem {
  /** Pola, ktorych broker moze nie podac. Brak znaczy "nieznane", nie 0 ani "dzis". */
  id?: number | string;
  name?: string;
  type_doc_id?: number;
  date_crt?: string;
  status_c?: number; // 0=Draft, 1=In progress, 2=Rejected, 3=Completed
  status_label: string;
  owner_login: string;
  available_for_cancel: boolean;
  params?: any;
}

export interface Freedom24CpsFile {
  file: string; // base64
  mime: string;
  file_name: string;
  extension: string;
  encoding_type: string;
}

export async function getFreedom24CpsHistory(
  payload: {
    cpsDocId?: number;
    id?: number;
    date_from?: string;
    date_to?: string;
    limit?: number;
    offset?: number;
    cps_status?: number;
    sid?: string;
  },
  apiKey?: string,
  apiSecret?: string
) {
  const params: any = {};
  if (payload.cpsDocId !== undefined) params.cpsDocId = payload.cpsDocId;
  if (payload.id !== undefined) params.id = payload.id;
  if (payload.date_from) params.date_from = payload.date_from;
  if (payload.date_to) params.date_to = payload.date_to;
  if (payload.limit !== undefined) params.limit = payload.limit;
  if (payload.offset !== undefined) params.offset = payload.offset;
  if (payload.cps_status !== undefined) params.cps_status = payload.cps_status;
  if (payload.sid) params.SID = payload.sid;

  const res = await odczytajFreedom24('getClientCpsHistory', params, apiKey, apiSecret);
  if (res.success && res.data) {
        const rawCps = res.data.cps || res.data.result?.cps || [];
        const mapped: Freedom24CpsItem[] = rawCps.map((c: any) => {
          // Brak statusu dawal kod 3 i etykiete "Zrealizowane pomyslnie" -
          // dyspozycja o nieznanym losie byla pokazywana jako wykonana.
          // Tak samo brak numeru dokumentu dawal Math.random(), brak typu
          // stala 10160, a brak daty utworzenia - chwile wykonania zapytania.
          let statusLabel = 'Status nieznany';
          if (c.status_c === 0) statusLabel = 'Wersja robocza';
          if (c.status_c === 1) statusLabel = 'W trakcie realizacji';
          if (c.status_c === 2) statusLabel = 'Odrzucone';
          if (c.status_c === 3) statusLabel = 'Zrealizowane pomyślnie';

          return {
            id: typeof c.id === 'number' || typeof c.id === 'string' ? c.id : undefined,
            name: c.name || undefined,
            type_doc_id: c.type_doc_id ?? undefined,
            date_crt: c.date_crt || undefined,
            status_c: c.status_c !== undefined ? c.status_c : undefined,
            status_label: statusLabel,
            owner_login: c.owner_login || c.auth_login || '',
            available_for_cancel: Boolean(c.available_for_cancel),
            params: c.params,
          };
        });

        return {
          success: true,
          cps: mapped,
          total: res.data.total || mapped.length,
        };
  }

  // Wczesniej stala tu lista przykladowych dyspozycji zwracana jako historia
  // dokumentow uzytkownika.
  return {
    success: false,
    cps: [],
    total: 0,
    message: res.error || 'Freedom24 nie zwrócił historii dyspozycji.',
  };
}

export async function getFreedom24CpsFiles(
  id: number,
  internal_id?: number,
  apiKey?: string,
  apiSecret?: string,
  sid?: string
) {
  const params: any = { id };
  if (internal_id !== undefined) params.internal_id = internal_id;
  if (sid) params.SID = sid;

  const res = await odczytajFreedom24('getCpsFiles', params, apiKey, apiSecret);
  if (res.success && res.data) {
        return {
          success: true,
          files: res.data.files || res.data.result?.files || [],
        };
  }

  // Wczesniej wracal stad przykladowy, pusty PDF opisany jako potwierdzenie
  // zlecenia uzytkownika.
  return {
    success: false,
    files: [],
    message: res.error || 'Freedom24 nie zwrócił dokumentu.',
  };
}

router.post('/freedom24/cps/history', async (req, res) => {
  const { cpsDocId, id, date_from, date_to, limit, offset, cps_status, sid, apiKey, apiSecret } = req.body;
  try {
    const result = await getFreedom24CpsHistory(
      { cpsDocId, id, date_from, date_to, limit, offset, cps_status, sid },
      apiKey,
      apiSecret
    );
    odeslijWynik(res, result, maKluczeApi(req) || !!createFreedom24Api());
  } catch (err: any) {
    res.status(500).json({ success: false, message: sanitizeFreedom24Text(err?.message), cps: [] });
  }
});

router.post('/freedom24/cps/files', async (req, res) => {
  const { id, internal_id, sid, apiKey, apiSecret } = req.body;
  try {
    const result = await getFreedom24CpsFiles(id, internal_id, apiKey, apiSecret, sid);
    odeslijWynik(res, result, maKluczeApi(req) || !!createFreedom24Api());
  } catch (err: any) {
    res.status(500).json({ success: false, message: sanitizeFreedom24Text(err?.message), files: [] });
  }
});

// ============================================================================
// Freedom24 SMS & Session Handlers (openSession / auth)
// ============================================================================

router.post('/freedom24/auth/request-sms', async (req, res) => {
  // Dokumentacja Tradernet (strona get-auth-sms): polecenie nazywa sie
  // `getAuthSms`, a jedynym parametrem jest `tel` - numer telefonu w formacie
  // miedzynarodowym. Kod wysylal wymyslone `sendSecurityCode` z loginem
  // i haslem, wiec kod SMS nie mogl przyjsc ani razu.
  const { tel, phone, email, password } = req.body;
  const numer = String(tel || phone || '').trim();
  if (!numer) {
    return res.status(400).json({
      success: false,
      errorCode: 'BRAK_NUMERU',
      message:
        'Podaj numer telefonu w formacie międzynarodowym (np. +48123456789) — Freedom24 wysyła kod na telefon, nie na adres e-mail.',
    });
  }
  if (!/^\+\d{6,15}$/.test(numer)) {
    return res.status(400).json({
      success: false,
      errorCode: 'ZLY_FORMAT_NUMERU',
      message: `Numer "${numer}" nie jest w formacie międzynarodowym. Oczekiwany zapis to +48123456789.`,
    });
  }
  void email;
  void password;

  // Kazda sciezka konczyla sie tu wczesniej odpowiedzia `success: true`:
  // takze odmowa brokera (Tradernet odpowiada HTTP 200 z polem errMsg),
  // takze blad sieci i strona blokady WAF. Uzytkownik czekal na SMS, ktorego
  // nikt nie zamowil, a przyczyne opisywano na sztywno jako "WAF 403"
  // niezaleznie od tego, co sie naprawde stalo.
  const podpowiedz =
    'Jesli kod nie dochodzi, uzyj metody "Klucze API V2" (Ustawienia Freedom24 -> Bezpieczenstwo i API) albo "Token SID".';
  let powod = 'Serwer Freedom24 nie odpowiedzial.';

  try {
    const response = await fetch('https://freedom24.com/api/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        q: JSON.stringify({ cmd: 'getAuthSms', params: { tel: numer } }),
      }),
      signal: AbortSignal.timeout(10000),
    });

    const text = await response.text();
    let data: any = null;
    try {
      data = JSON.parse(text);
    } catch {
      // Cloudflare i WAF odpowiadaja strona HTML, nie JSON-em.
    }

    if (!response.ok) {
      powod = `Serwer Freedom24 zwrocil blad HTTP ${response.status}.`;
    } else if (!data) {
      powod =
        'Serwer Freedom24 odpowiedzial trescia, ktora nie jest JSON-em - zwykle oznacza to strone blokady (Cloudflare / WAF).';
    } else if (
      data.errMsg ||
      data.error ||
      (data.code !== undefined && data.code !== 0 && data.code !== '0' && data.code !== 200)
    ) {
      powod = `Serwer Freedom24 odmowil: ${bezSekretow(
        data.errMsg || data.error || data.message || `kod ${data.code}`,
        'zadanie odrzucone'
      )}.`;
    } else if (!data.auth_code_id) {
      powod =
        'Freedom24 odpowiedzial bez identyfikatora kodu (auth_code_id), wiec nie da sie potem zweryfikowac SMS-a.';
    } else {
      return res.json({
        success: true,
        message: 'Freedom24 przyjął prośbę o kod autoryzacyjny. Sprawdź telefon.',
        // Bez `authCodeId` nie da sie wywolac `authBySms` - klient musi go
        // odeslac razem z kodem z SMS-a.
        authCodeId: data.auth_code_id,
        dlugoscKodu: data.auth_code_length ?? null,
        data,
      });
    }
  } catch {
    powod =
      'Nie udalo sie polaczyc z serwerem Freedom24 (blad sieci albo przekroczony czas oczekiwania).';
  }

  res.status(502).json({
    success: false,
    errorCode: 'SMS_REQUEST_FAILED',
    message: `${powod} Kod SMS nie zostal zamowiony. ${podpowiedz}`,
  });
});

router.post('/freedom24/auth/verify-sms', async (req, res) => {
  // Dokumentacja Tradernet (strona auth-by-sms): polecenie `authBySms`
  // z parametrami `authCodeId` i `sms`. Trasa zwracala wczesniej 501
  // z twierdzeniem, ze "Tradernet nie udostepnia na to publicznego
  // polecenia" - nieprawda, polecenie istnieje. Jeszcze wczesniej nie
  // wysylala zadnego zapytania i oddawala wymyslony identyfikator sesji.
  const { smsCode, authCodeId, rememberMe, userId } = req.body;
  const kod = String(smsCode || '').trim();
  const idKodu = Number(authCodeId);
  if (!kod) {
    return res.status(400).json({ success: false, message: 'Wprowadź kod SMS otrzymany na telefon.' });
  }
  if (!Number.isFinite(idKodu) || idKodu <= 0) {
    return res.status(400).json({
      success: false,
      errorCode: 'BRAK_AUTH_CODE_ID',
      message:
        'Brakuje identyfikatora kodu (authCodeId) z kroku zamówienia SMS-a. Zamów kod jeszcze raz — bez tego numeru broker nie powiąże kodu z próbą logowania.',
    });
  }

  let powod = 'Serwer Freedom24 nie odpowiedział.';
  try {
    const response = await fetch('https://freedom24.com/api/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        q: JSON.stringify({
          cmd: 'authBySms',
          params: {
            authCodeId: idKodu,
            sms: kod,
            viewOnlyMode: true,
            ...(rememberMe ? { rememberMe: 1 } : {}),
            ...(userId ? { userId: Number(userId) } : {}),
          },
        }),
      }),
      signal: AbortSignal.timeout(10000),
    });

    const text = await response.text();
    let data: any = null;
    try {
      data = JSON.parse(text);
    } catch {
      // Cloudflare i WAF odpowiadaja strona HTML, nie JSON-em.
    }

    if (!response.ok) {
      powod = `Serwer Freedom24 zwrócił błąd HTTP ${response.status}.`;
    } else if (!data) {
      powod =
        'Serwer Freedom24 odpowiedział treścią, która nie jest JSON-em — zwykle oznacza to stronę blokady (Cloudflare / WAF).';
    } else if (data.errMsg || data.error) {
      powod = `Serwer Freedom24 odmówił: ${bezSekretow(
        data.errMsg || data.error,
        'żądanie odrzucone'
      )}.`;
    } else if (!data.SID && !data.sid) {
      powod = 'Freedom24 odpowiedział bez identyfikatora sesji (SID), więc sesja nie powstała.';
    } else {
      // SID zostaje w pamieci serwera - przegladarka go nie dostaje.
      otworzSesjeZOdpowiedzi(data, 'SMS');
      return res.json({
        success: true,
        session: freedom24Session.describe(),
        message: 'Freedom24 potwierdził kod SMS i otworzył sesję w trybie tylko do podglądu.',
      });
    }
  } catch {
    powod = 'Nie udało się połączyć z serwerem Freedom24 (błąd sieci albo przekroczony czas oczekiwania).';
  }

  res.status(502).json({
    success: false,
    errorCode: 'SMS_VERIFY_FAILED',
    message: `${powod} Sesja NIE została otwarta.`,
  });
});

// Supported Brokers List with Configuration Schemas
router.get('/supported', (req, res) => {
  res.json({
    success: true,
    brokers: [
      {
        type: 'XTB',
        name: 'XTB Brokerage (xStation 5)',
        authType: 'API_KEY_AND_USER',
        fields: ['accountNumber', 'apiKey', 'apiServerType'],
        docsUrl: 'http://developers.xstore.pro/',
        features: ['Real-time Equity & ETF Trades', 'GPW Shares', 'Dividends', 'Fees'],
      },
      {
        type: 'IBKR',
        name: 'Interactive Brokers (Flex Web Service)',
        authType: 'TOKEN_AND_QUERY_ID',
        fields: ['apiKey', 'queryId'],
        docsUrl: 'https://www.interactivebrokers.com/en/software/am/am/reports/flex_web_service.htm',
        features: ['Multi-currency Stocks & ETFs', 'US/EU Dividends (WHT 15%)', 'Forex Conversions', 'Corporate Actions'],
      },
      {
        type: 'BINANCE',
        name: 'Binance Crypto Spot API',
        authType: 'HMAC_SHA256_KEYS',
        fields: ['apiKey', 'apiSecret'],
        docsUrl: 'https://binance-docs.github.io/apidocs/spot/en/',
        features: ['Spot Trades History', 'Deposit & Withdrawal Logs', 'Crypto to Fiat (USDT/EUR/PLN)'],
      },
      {
        type: 'FREEDOM24',
        name: 'Freedom24 (Tradernet API)',
        authType: 'HMAC_SHA256_KEYS',
        fields: ['apiKey', 'apiSecret', 'accountNumber'],
        docsUrl: 'https://tradernet.com/api/',
        features: ['US & European Equities', 'Pre-market & After-hours', 'Cash Flow History', 'Stock Watchlists & Lists Management'],
      },
      {
        type: 'REVOLUT',
        name: 'Revolut Trading & Crypto',
        authType: 'STATEMENT_SYNC',
        fields: ['accountNumber'],
        features: ['Instant CSV Statement Sync', 'Fractional Shares', 'Dividends'],
      },
      {
        type: 'EMAKLER',
        name: 'mBank eMakler (GPW / Zagranica)',
        authType: 'STATEMENT_SYNC',
        fields: ['accountNumber'],
        features: ['GPW WIG20/mWIG40 Stocks', 'Obligacje Skarbowe', 'Wymiana Walut'],
      },
    ],
  });
});

/** Pierwsza lista znaleziona pod ktoras ze sciezek (np. 'result.trades.trade'). */
function wyciagnijListe(dane: any, ...sciezki: string[]): any[] {
  for (const sciezka of sciezki) {
    let biezacy = dane;
    for (const czlon of sciezka.split('.')) {
      biezacy = biezacy?.[czlon];
      if (biezacy === undefined || biezacy === null) break;
    }
    if (Array.isArray(biezacy)) return biezacy;
  }
  return [];
}

export default router;
