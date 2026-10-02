import { apiFetch } from "./apiTransport";
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
  serverTime: string;
  markets: Freedom24MarketInfo[];
  /** 'freedom24' - odczyt od brokera, 'zegar-lokalny' - wyliczone na miejscu. */
  zrodlo?: 'freedom24' | 'zegar-lokalny';
  /** Czas faktycznego udanego odczytu, nie ostatniej próby odświeżenia. */
  odczytanoO?: string;
  nieaktualne?: boolean;
}

const STORAGE_KEY = 'pit38_market_status_cache';

export const marketStatusService = {
  /**
   * Ostatnia zapamietana odpowiedz albo pustka.
   *
   * Wczesniej przy pustym cache wracala tu lista wpisana w kod, w ktorej NYSE
   * mial na sztywno status OPEN, a GPW CLOSE - niezaleznie od godziny i dnia.
   * Pasek sesji pokazywal wiec "NYSE OTWARTE" takze w nocy i w niedziele.
   */
  getCachedStatus(): Freedom24MarketStatusResponse {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) {
        return { ...JSON.parse(saved), nieaktualne: true };
      }
    } catch {
      // ignore
    }
    return {
      success: false,
      serverTime: '',
      markets: [],
      nieaktualne: true,
    };
  },

  saveToCache(data: Freedom24MarketStatusResponse) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    } catch {
      // ignore
    }
  },

  async fetchMarketStatuses(apiKey?: string, apiSecret?: string, market = '*', mode?: string): Promise<Freedom24MarketStatusResponse> {
    try {
      const res = await apiFetch('/api/brokers/freedom24/market-status', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apiKey, apiSecret, market, mode }),
      });
      const data = await res.json();
      if (data && data.success && Array.isArray(data.markets)) {
        const odczyt = { ...data, odczytanoO: new Date().toISOString(), nieaktualne: false };
        this.saveToCache(odczyt);
        return odczyt;
      }
    } catch (e: any) {
      console.warn('[MarketStatus API] Fallback to cache:', e.message);
    }
    return this.getCachedStatus();
  },
};
