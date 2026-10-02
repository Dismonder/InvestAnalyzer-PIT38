import { apiFetch } from "./apiTransport";
import { LiveMarketQuote, AssetCategory, CurrencyCode } from '../types';
import type { BrokerSupportedAsset } from '../data/brokerAssetsDatabase';

export type { BrokerSupportedAsset };

// Katalog instrumentow (ok. 30 kB kodu) jest potrzebny dopiero w katalogu spolek
// i przy awaryjnym wyszukiwaniu bez serwera. Statyczny import wciagal go do
// pakietu startowego przez dolna nawigacje, ktora importuje ten serwis.
const katalogInstrumentow = (): Promise<BrokerSupportedAsset[]> =>
  import('../data/brokerAssetsDatabase').then((modul) => modul.ALL_BROKER_SUPPORTED_ASSETS);

/**
 * Propozycja listy obserwowanych - wylacznie dla przycisku "przywroc domyslne".
 * Nie jest juz lista startowa ani nie dokleja sie do zapytan: aplikacja pytala
 * w kolko o te dwanascie instrumentow takze u kogos, kto nie ma zadnego z nich.
 */
export const DEFAULT_FAVORITE_TICKERS: string[] = [
  'NVDA',
  'AAPL',
  'MSFT',
  'TSLA',
  'VOO',
  'VWCE',
  'CDR',
  'PKN',
  'DNP',
  'BTC',
  'ETH',
  'SOL',
];

/**
 * Notowania startowe: zadnych.
 *
 * Stala tu tablica dwunastu instrumentow z cenami wpisanymi w kod, znacznikiem
 * `lastUpdated` ustawianym na chwile uruchomienia i polem `source` mowiacym
 * "FREEDOM24" albo "TRADINGVIEW". Wygladaly wiec jak notowania pobrane przed
 * sekunda, a byly wymyslone - i szly wprost do wyceny portfela
 * (PortfolioDashboard liczy wartosc pozycji z `quote.price`). Uzytkownik
 * widzial zysk albo strate policzona z ceny, ktorej nikt nie pobral.
 *
 * Teraz do czasu pierwszej udanej odpowiedzi zrodla nie ma zadnego notowania,
 * a pozycja bez notowania jest wylaczona z sum i oznaczona na ekranie - tak
 * samo jak pozycja bez kursu NBP.
 */
const BRAK_NOTOWAN: Record<string, LiveMarketQuote> = {};

export interface StreamSpeedOption {
  label: string;
  shortLabel: string;
  value: number; // in milliseconds
  description: string;
}

export const STREAM_SPEED_OPTIONS: StreamSpeedOption[] = [
  { label: 'Ultra Live (2s)', shortLabel: '2s', value: 2000, description: 'Najwyższa częstotliwość odświeżania' },
  { label: 'Błyskawiczne (3s - Domyślne)', shortLabel: '3s', value: 3000, description: 'Optymalne dla limitów API' },
  { label: 'Szybkie (5s)', shortLabel: '5s', value: 5000, description: 'Zrównoważone odświeżanie' },
  { label: 'Standardowe (10s)', shortLabel: '10s', value: 10000, description: 'Klasyczne tempo giełdowe' },
  { label: 'Oszczędne (30s)', shortLabel: '30s', value: 30000, description: 'Minimalne zużycie danych i baterii' },
];

export const DEFAULT_STREAM_INTERVAL_MS = 3000; // 3 seconds - maximum safe speed for Yahoo & Binance APIs

type QuoteUpdateListener = (quotes: Record<string, LiveMarketQuote>) => void;
type FavoritesListener = (favorites: string[]) => void;
type StreamStateListener = (state: { isStreaming: boolean; intervalMs: number; isFetching: boolean; lastFetchedAt: string | null }) => void;

const KLUCZ_OBSERWOWANYCH = 'pit38_favorite_tickers';
/**
 * Notowanie z serwera lub transportu desktopowego zapisujemy dopiero po sprawdzeniu:
 * bez skonczonej ceny i waluty to nie notowanie, a brakujace pola, na ktorych widoki
 * wolaja .toFixed/.length, dostaja bezpieczne wartosci (brak zmiany dziennej to null, nie 0).
 */
export function znormalizujNotowanie(surowe: unknown, ticker: string): LiveMarketQuote | null {
  if (!surowe || typeof surowe !== 'object') return null;
  const q = surowe as Partial<LiveMarketQuote>;
  if (typeof q.price !== 'number' || !Number.isFinite(q.price) || typeof q.currency !== 'string' || !q.currency) return null;
  const liczbaLubNull = (wartosc: unknown): number | null =>
    typeof wartosc === 'number' && Number.isFinite(wartosc) ? wartosc : null;
  return {
    ...q,
    ticker: typeof q.ticker === 'string' && q.ticker ? q.ticker : ticker,
    name: typeof q.name === 'string' && q.name ? q.name : ticker,
    price: q.price,
    currency: q.currency,
    change24h: liczbaLubNull(q.change24h),
    changePercent24h: liczbaLubNull(q.changePercent24h),
    high24h: liczbaLubNull(q.high24h),
    low24h: liczbaLubNull(q.low24h),
    volume24h: liczbaLubNull(q.volume24h),
    sparkline: Array.isArray(q.sparkline) ? q.sparkline : [],
  } as LiveMarketQuote;
}

function znormalizujNotowania(surowe: unknown): Record<string, LiveMarketQuote> {
  const wynik: Record<string, LiveMarketQuote> = {};
  if (!surowe || typeof surowe !== 'object') return wynik;
  for (const [ticker, q] of Object.entries(surowe as Record<string, unknown>)) {
    const notowanie = znormalizujNotowanie(q, ticker);
    if (notowanie) wynik[ticker] = notowanie;
  }
  return wynik;
}
/** Limit serwera dla GET /api/quotes (MAX_TICKEROW_NA_ZADANIE w routes/quotes.ts). */
const MAX_TICKEROW_W_ZAPYTANIU = 100;

class MarketDataEngine {
  private quotes: Record<string, LiveMarketQuote> = { ...BRAK_NOTOWAN };
  private listeners: Set<QuoteUpdateListener> = new Set();
  private favoritesListeners: Set<FavoritesListener> = new Set();
  private stateListeners: Set<StreamStateListener> = new Set();
  private intervalId: number | null = null;
  private streamingIntervalMs: number = DEFAULT_STREAM_INTERVAL_MS;
  private isStreaming = true;
  private isFetching = false;
  private ostatnieZadanie = 0;
  private lastFetchedAt: string | null = null;
  private favoriteTickers: string[] = [];
  /** Instrumenty z otwartych pozycji portfela. */
  private portfolioTickers: string[] = [];
  /** Instrumenty, o ktore ktos jawnie zapytal w tej sesji (np. wykres). */
  private requestedTickers: Set<string> = new Set();

  constructor() {
    // Load favorite tickers from localStorage or default
    this.favoriteTickers = this.odczytajObserwowane();

    // Druga karta zmienia te sama liste: zdarzenie storage odswieza pamiec tej karty,
    // zeby jej pozniejszy zapis nie kasowal cudzych zmian.
    if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
      window.addEventListener('storage', (event: StorageEvent) => {
        if (event.key === null || event.key === KLUCZ_OBSERWOWANYCH) this.wczytajObserwowaneZMagazynu();
      });
    }

    // Load saved stream interval
    try {
      const savedInterval = localStorage.getItem('pit38_quotes_interval_ms');
      if (savedInterval) {
        const parsed = parseInt(savedInterval, 10);
        if (!isNaN(parsed) && parsed >= 2000 && parsed <= 60000) {
          this.streamingIntervalMs = parsed;
        }
      }
    } catch {
      this.streamingIntervalMs = DEFAULT_STREAM_INTERVAL_MS;
    }

    // Tab focus & visibility change listener: immediately fetch fresh quotes when user refocuses tab
    if (typeof window !== 'undefined') {
      // Przy powrocie do karty przychodza oba zdarzenia naraz - jedno pobranie wystarczy.
      let ostatniaAktywacja = 0;
      const odswiezPoAktywacji = () => {
        const teraz = Date.now();
        if (!this.isStreaming || teraz - ostatniaAktywacja < 1000) return;
        ostatniaAktywacja = teraz;
        this.fetchRealQuotes(undefined, true);
      };
      window.addEventListener('focus', odswiezPoAktywacji);
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') odswiezPoAktywacji();
      });
    }

    // Defer initial quotes fetch slightly so React hydration and network settle
    if (typeof window !== 'undefined') {
      window.setTimeout(() => {
        this.fetchRealQuotes(undefined, true);
      }, 50);
    } else {
      this.fetchRealQuotes(undefined, true);
    }

    // Load saved streaming enabled state
    try {
      const savedStreaming = localStorage.getItem('pit38_streaming_active');
      if (savedStreaming !== null) {
        this.isStreaming = savedStreaming !== 'false';
      }
    } catch {
      // ignore
    }

    // Start streaming real-time polling if enabled
    if (this.isStreaming) {
      this.startStreaming();
    }
  }

  // --- FAVORITES MANAGEMENT ---

  public getFavorites(): string[] {
    return [...this.favoriteTickers];
  }

  /** Portfel zglasza, co uzytkownik faktycznie trzyma - te notowania sa potrzebne. */
  public setPortfolioTickers(tickers: string[]) {
    const czyste = Array.from(new Set(tickers.map((t) => t.trim().toUpperCase()).filter(Boolean))).sort();
    if (czyste.join(',') === this.portfolioTickers.join(',')) return;
    this.portfolioTickers = czyste;
    if (czyste.length > 0) this.fetchRealQuotes(czyste, true);
  }

  /** Pelna lista instrumentow do odpytania: portfel, obserwowane, jawnie zadane. */
  public getTrackedTickers(): string[] {
    return Array.from(new Set([...this.portfolioTickers, ...this.favoriteTickers, ...this.requestedTickers]));
  }

  public isFavorite(ticker: string): boolean {
    return this.favoriteTickers.includes(ticker.toUpperCase());
  }

  /**
   * Biezaca lista z localStorage (nie z pamieci tej karty). Zapisana lista - takze
   * pusta - jest decyzja uzytkownika. Gdy magazyn jest niedostepny, zostaje pamiec.
   */
  private odczytajObserwowane(): string[] {
    try {
      const zapisane = localStorage.getItem(KLUCZ_OBSERWOWANYCH);
      if (!zapisane) return [];
      const parsed = JSON.parse(zapisane);
      return Array.isArray(parsed)
        ? parsed.filter((ticker): ticker is string => typeof ticker === 'string' && ticker.trim() !== '')
        : [];
    } catch {
      return [...this.favoriteTickers];
    }
  }

  /** Zmiana z innej karty: podmienia liste w pamieci bez ponownego zapisu. */
  private wczytajObserwowaneZMagazynu() {
    const lista = this.odczytajObserwowane();
    if (lista.join(',') === this.favoriteTickers.join(',')) return;
    this.favoriteTickers = lista;
    this.notifyFavorites();
    this.fetchRealQuotes(lista, true);
  }

  public toggleFavorite(ticker: string): boolean {
    const formatted = ticker.trim().toUpperCase();
    if (!formatted) return false;

    // Zmiana jednego tickera wzgledem AKTUALNEGO stanu magazynu, nie listy z pamieci karty.
    const biezace = this.odczytajObserwowane().map((t) => t.trim().toUpperCase());
    let updated: string[];
    let isNowFav: boolean;

    if (biezace.includes(formatted)) {
      updated = biezace.filter((t) => t !== formatted);
      isNowFav = false;
    } else {
      updated = [...biezace, formatted];
      isNowFav = true;
    }

    this.setFavorites(updated);
    return isNowFav;
  }

  public setFavorites(tickers: string[]) {
    const cleanList = Array.from(new Set(tickers.map((t) => t.trim().toUpperCase()).filter(Boolean)));
    this.favoriteTickers = cleanList;
    try {
      localStorage.setItem(KLUCZ_OBSERWOWANYCH, JSON.stringify(cleanList));
    } catch (e) {
      console.warn('Could not save favorites to localStorage', e);
    }
    this.notifyFavorites();
    // Fetch quotes for any newly added favorites immediately
    this.fetchRealQuotes(cleanList, true);
  }

  public subscribeFavorites(listener: FavoritesListener): () => void {
    this.favoritesListeners.add(listener);
    listener(this.getFavorites());
    return () => {
      this.favoritesListeners.delete(listener);
    };
  }

  private notifyFavorites() {
    const favs = this.getFavorites();
    this.favoritesListeners.forEach((fn) => fn(favs));
  }

  // --- STREAMING SPEED & STATE ---

  public getStreamingInterval(): number {
    return this.streamingIntervalMs;
  }

  public setStreamingInterval(ms: number) {
    const safeMs = Math.max(2000, Math.min(ms, 60000));
    this.streamingIntervalMs = safeMs;
    try {
      localStorage.setItem('pit38_quotes_interval_ms', safeMs.toString());
    } catch {
      // ignore
    }
    // Restart interval with new duration
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
      if (this.isStreaming) {
        this.startStreaming();
      }
    }
    this.notifyState();
  }

  public subscribeState(listener: StreamStateListener): () => void {
    this.stateListeners.add(listener);
    listener({
      isStreaming: this.isStreaming,
      intervalMs: this.streamingIntervalMs,
      isFetching: this.isFetching,
      lastFetchedAt: this.lastFetchedAt,
    });
    return () => {
      this.stateListeners.delete(listener);
    };
  }

  private notifyState() {
    const state = {
      isStreaming: this.isStreaming,
      intervalMs: this.streamingIntervalMs,
      isFetching: this.isFetching,
      lastFetchedAt: this.lastFetchedAt,
    };
    this.stateListeners.forEach((fn) => fn(state));
  }

  // --- REAL MARKET QUOTES API FETCHING ---

  public async fetchRealQuotes(tickersToFetch?: string[], force: boolean = false): Promise<Record<string, LiveMarketQuote>> {
    if (this.isFetching && !force) {
      return this.getQuotes();
    }

    const numerZadania = ++this.ostatnieZadanie;
    this.isFetching = true;
    this.notifyState();

    try {
      // Tylko to, co uzytkownik ma w portfelu, obserwuje albo o co jawnie
      // zapytal. Bez sztywnej listy i bez kluczy zebranych wczesniej notowan.
      for (const ticker of tickersToFetch || []) {
        const czysty = ticker.trim().toUpperCase();
        if (czysty) this.requestedTickers.add(czysty);
      }
      const allTickers = this.getTrackedTickers();
      if (allTickers.length === 0) {
        return this.getQuotes();
      }

      // Serwer odrzuca zapytanie z ponad 100 tickerami (400), wiec dluzsza lista
      // idzie paczkami. Nieudana paczka nie przerywa pozostalych.
      const zebrane: Record<string, LiveMarketQuote> = {};
      for (let start = 0; start < allTickers.length; start += MAX_TICKEROW_W_ZAPYTANIU) {
        const paczka = allTickers.slice(start, start + MAX_TICKEROW_W_ZAPYTANIU);
        const tickersParam = encodeURIComponent(paczka.join(','));
        const url = `/api/quotes?tickers=${tickersParam}${force ? '&force=true' : ''}`;

        const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
        const timeoutId = controller ? window.setTimeout(() => controller.abort(), 6000) : null;
        try {
          // apiFetch: w zbudowanym desktopie nie ma serwera Node pod /api/quotes.
          const response = await apiFetch(url, {
            headers: { Accept: 'application/json' },
            signal: controller ? controller.signal : undefined,
          });
          if (response.ok) {
            const data = await response.json();
            if (data.success && data.quotes) Object.assign(zebrane, znormalizujNotowania(data.quotes));
          }
        } catch {
          // Siec albo limit czasu tej paczki: zostaje poprzedni stan jej notowan.
        } finally {
          if (timeoutId) window.clearTimeout(timeoutId);
        }
      }

      const ceny = Object.values(zebrane) as Array<{ stale?: boolean } | null>;
      if (numerZadania === this.ostatnieZadanie && ceny.length > 0) {
        // Merge real live quotes into state
        this.quotes = {
          ...this.quotes,
          ...zebrane,
        };
        // Pusta mapa (wszystko nieudane) ani same ceny z zapasu (awaria dostawcy)
        // nie sa swiezym odczytem, ktory mozna pokazac jako czas ostatniego pobrania.
        const wszystkieNieaktualne = ceny.every((cena) => cena?.stale === true);
        if (!wszystkieNieaktualne) this.lastFetchedAt = new Date().toISOString();
        this.notify();
      }
      return this.getQuotes();    } catch {
      // Quietly maintain cached state during background network changes or cold start
      return this.getQuotes();
    } finally {
      if (numerZadania === this.ostatnieZadanie) {
        this.isFetching = false;
        this.notifyState();
      }
    }
  }

  public isWatchlisted(ticker: string): boolean {
    return this.favoriteTickers.includes(ticker.trim().toUpperCase());
  }

  public addToWatchlist(ticker: string): boolean {
    const formatted = ticker.trim().toUpperCase();
    const biezace = this.odczytajObserwowane();
    if (!biezace.includes(formatted)) {
      this.setFavorites([...biezace, formatted]);
      this.fetchSingleTicker(formatted, true);
      return true;
    }
    return false;
  }

  public removeFromWatchlist(ticker: string): boolean {
    const formatted = ticker.trim().toUpperCase();
    const biezace = this.odczytajObserwowane();
    if (biezace.includes(formatted)) {
      this.setFavorites(biezace.filter((f) => f !== formatted));
      return true;
    }
    return false;
  }

  public getWatchlist(): string[] {
    return this.getFavorites();
  }

  public async fetchSingleTicker(ticker: string, force: boolean = false): Promise<LiveMarketQuote | null> {
    const formatted = ticker.trim().toUpperCase();
    try {
      const res = await apiFetch(`/api/quote/${encodeURIComponent(formatted)}${force ? '?force=true' : ''}`);
      if (res.ok) {
        const data = await res.json();
        const notowanie = data.success && data.quote ? znormalizujNotowanie(data.quote, formatted) : null;
        if (notowanie) {
          this.quotes[formatted] = notowanie;
          this.notify();
          return notowanie;
        }
      }
    } catch (err) {
      console.error(`Error fetching single quote for ${ticker}:`, err);
    }
    return this.quotes[formatted] || null;
  }

  public getQuotes(): Record<string, LiveMarketQuote> {
    return { ...this.quotes };
  }

  public getQuote(ticker: string): LiveMarketQuote | undefined {
    return this.quotes[ticker.toUpperCase()];
  }

  public getLastFetchedAt(): string | null {
    return this.lastFetchedAt;
  }

  public getIsFetching(): boolean {
    return this.isFetching;
  }

  public subscribe(listener: QuoteUpdateListener): () => void {
    this.listeners.add(listener);
    listener(this.getQuotes());
    return () => {
      this.listeners.delete(listener);
    };
  }

  public setStreaming(enabled: boolean) {
    this.isStreaming = enabled;
    try {
      localStorage.setItem('pit38_streaming_active', enabled ? 'true' : 'false');
    } catch {
      // ignore
    }
    if (enabled && !this.intervalId) {
      this.startStreaming();
      this.fetchRealQuotes(undefined, true);
    } else if (!enabled && this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    this.notifyState();
  }

  public getIsStreaming(): boolean {
    return this.isStreaming;
  }

  public addCustomQuote(quote: LiveMarketQuote) {
    this.quotes[quote.ticker.toUpperCase()] = quote;
    this.notify();
  }

  public async fetchHistoricalCandles(ticker: string, range: string = '1d', interval: string = '15m') {
    const formatted = ticker.trim().toUpperCase();
    try {
      const res = await apiFetch(`/api/history/${encodeURIComponent(formatted)}?range=${range}&interval=${interval}`, {
        signal: AbortSignal.timeout ? AbortSignal.timeout(5000) : undefined,
      });
      if (res.ok) {
        const data = await res.json();
        if (data && data.success && data.data && Array.isArray(data.data.points) && data.data.points.length > 0) {
          return data.data;
        }
      }
    } catch {
      // Fallback below
    }

    // Przebieg poglądowy liczy sie wokol ostatniej znanej ceny. Bez niej
    // `|| 100.0` rysowalo wykres wokol stu jednostek - liczby, ktora z tym
    // instrumentem nie ma nic wspolnego.
    const currentQuote = this.quotes[formatted];
    const basePrice = currentQuote?.price;
    if (basePrice === undefined || !(basePrice > 0)) {
      return {
        ticker: formatted,
        range,
        interval,
        points: [],
        synthetic: true,
        syntheticReason:
          'Brak połączenia ze źródłem notowań i brak ostatniej znanej ceny tego instrumentu — nie ma wokół czego narysować wykresu.',
      };
    }
    const now = Date.now();
    
    let count = 40;
    let stepMs = 24 * 3600 * 1000;
    if (range === '1d') {
      count = interval === '1m' ? 60 : interval === '5m' ? 48 : interval === '15m' ? 32 : 24;
      stepMs = interval === '1m' ? 60 * 1000 : interval === '5m' ? 5 * 60 * 1000 : interval === '15m' ? 15 * 60 * 1000 : 3600 * 1000;
    } else if (range === '5d') {
      count = 50;
      stepMs = 2 * 3600 * 1000;
    } else if (range === '1mo') {
      count = 60;
      stepMs = 12 * 3600 * 1000;
    } else if (range === '6mo') {
      count = 90;
      stepMs = 2 * 24 * 3600 * 1000;
    } else if (range === '1y') {
      count = 120;
      stepMs = 3 * 24 * 3600 * 1000;
    }

    const points = [];

    for (let i = count; i >= 0; i--) {
      const ts = now - i * stepMs;
      const d = new Date(ts);
      const isIntradaySingleDay = range === '1d';
      const isIntradayMultiDay = (range === '5d' || range === '1mo' || range === '6mo' || range === '1y') && (interval === '1m' || interval === '5m' || interval === '15m' || interval === '1h');
      
      let dateStr = d.toLocaleDateString('pl-PL', { day: 'numeric', month: 'numeric' });
      if (isIntradaySingleDay) {
        dateStr = d.toLocaleTimeString('pl-PL', { hour: '2-digit', minute: '2-digit' });
      } else if (isIntradayMultiDay) {
        dateStr = `${d.toLocaleDateString('pl-PL', { day: 'numeric', month: 'numeric' })} ${d.toLocaleTimeString('pl-PL', { hour: '2-digit', minute: '2-digit' })}`;
      }

      const wave = Math.sin((count - i) * 0.35) * (basePrice * 0.015);
      const close = Number((basePrice - (i * 0.001 * basePrice) + wave).toFixed(2));
      points.push({
        timestamp: ts,
        date: dateStr,
        open: Number((close * 0.998).toFixed(2)),
        high: Number((close * 1.005).toFixed(2)),
        low: Number((close * 0.995).toFixed(2)),
        close,
        volume: 20000,
      });
    }

    // Znacznik jest obowiazkowy: to przebieg wyliczony z ostatniej znanej ceny,
    // a nie notowania z gieldy. Wykres bez tej informacji wygladal identycznie
    // jak prawdziwy, wiec nie dalo sie odroznic awarii zrodla od spokojnej sesji.
    return {
      ticker: formatted,
      range,
      interval,
      points,
      synthetic: true,
      syntheticReason: 'Brak połączenia ze źródłem notowań. Wykres jest poglądowy.',
    };
  }

  public async fetchAllSupportedAssets(): Promise<BrokerSupportedAsset[]> {
    try {
      const res = await apiFetch('/api/supported-assets');
      if (res.ok) {
        const data = await res.json();
        if (data.success && Array.isArray(data.assets)) {
          return data.assets;
        }
      }
    } catch (err) {
      console.warn('[marketDataService] Failed to fetch supported assets API, falling back to local list:', err);
    }
    return katalogInstrumentow();
  }

  public async searchTickers(query: string): Promise<BrokerSupportedAsset[]> {
    const cleanQ = query.trim();
    if (!cleanQ) {
      return katalogInstrumentow();
    }

    try {
      const res = await apiFetch(`/api/search-tickers?q=${encodeURIComponent(cleanQ)}`);
      if (res.ok) {
        const data = await res.json();
        if (data.success && Array.isArray(data.results)) {
          return data.results;
        }
      }
    } catch (err) {
      console.warn(`[marketDataService] Search API error for "${query}":`, err);
    }

    // Fallback client-side search across ALL_BROKER_SUPPORTED_ASSETS
    const upper = cleanQ.toUpperCase();
    return (await katalogInstrumentow()).filter(
      (a) =>
        a.ticker.toUpperCase().includes(upper) ||
        a.name.toUpperCase().includes(upper) ||
        (a.isin && a.isin.toUpperCase().includes(upper)) ||
        a.exchange.toUpperCase().includes(upper)
    );
  }

  private startStreaming() {
    if (this.intervalId) return;
    // Odpytywanie co ok. 3 sekundy, ale tylko przy widocznej karcie.
    //
    // Wczesniej `setInterval` chodzil niezaleznie od tego, czy ktos patrzy na
    // aplikacje: karta schowana w tle wysylala 1200 zapytan na godzine, budzila
    // laptopa i zuzywala limit dostawcy notowan na dane, ktorych nikt nie
    // widzial. Przy powrocie na karte i tak pobieramy swieze notowania, bo robi
    // to nasluch `visibilitychange`.
    this.intervalId = window.setInterval(() => {
      if (!this.isStreaming) return;
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      this.fetchRealQuotes();
    }, this.streamingIntervalMs);
  }

  private notify() {
    const snapshot = this.getQuotes();
    this.listeners.forEach((fn) => fn(snapshot));
  }
}

export const marketDataService = new MarketDataEngine();
