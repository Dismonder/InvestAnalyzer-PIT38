import { apiFetch } from "./apiTransport";
export interface Freedom24HlocPoint {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
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

export interface Freedom24NewsItem {
  id: number;
  title: string;
  source: string;
  date: string;
  tickers: string[];
  summary: string;
  url?: string;
}

/**
 * Powod, dla ktorego ostatnio odebrane dane sa przykladowe zamiast pochodzic
 * z Freedom24. Null oznacza dane prawdziwe. Widzety czytaja to po pobraniu,
 * zeby podpisac liste - bez tego zaszyte ceny i depesze wygladaly jak biezace.
 */
export const ostatnieDanePogladowe: { topSecurities: string | null; news: string | null } = {
  topSecurities: null,
  news: null,
};

export const freedom24ExtendedService = {
  async fetchHloc(
    ticker: string,
    interval: string = 'D',
    count: number = 60,
    apiKey?: string,
    apiSecret?: string
  ): Promise<Freedom24HlocPoint[]> {
    try {
      const res = await apiFetch('/api/brokers/freedom24/hloc', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ticker, interval, count, apiKey, apiSecret }),
      });
      const data = await res.json();
      // Bez poswiadczen serwer odsyla przebieg wyliczony lokalnie (demoData).
      // To nie sa notowania - jak w fetchTopSecurities zwracamy brak danych.
      if (data && data.success && !data.demoData && Array.isArray(data.points)) {
        return data.points;
      }
    } catch (e: any) {
      console.warn('[Freedom24 HLOC] Error:', e.message);
    }
    return [];
  },

  async fetchTopSecurities(
    type: 'gainers' | 'losers' | 'volume' = 'gainers',
    apiKey?: string,
    apiSecret?: string
  ): Promise<Freedom24TopSecurity[]> {
    try {
      const res = await apiFetch('/api/brokers/freedom24/top-securities', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type, apiKey, apiSecret }),
      });
      const data = await res.json();
      if (data && data.success && Array.isArray(data.securities)) {
        // Serwer oznacza dane przykladowe osobna flaga - inaczej lista zaszyta
        // w kodzie wygladalaby jak biezacy ranking sesji.
        ostatnieDanePogladowe.topSecurities = data.demoData
          ? String(data.demoReason || 'Dane przykładowe.')
          : null;
        // Przykladowych cen nie pokazujemy wcale: NBIS po 34,20 USD obok
        // prawdziwej pozycji po ~222 USD wprowadza w blad mimo paska z opisem.
        return data.demoData ? [] : data.securities;
      }
    } catch (e: any) {
      console.warn('[Freedom24 TopSecurities] Error:', e.message);
    }
    ostatnieDanePogladowe.topSecurities = null;
    return [];
  },

  /** Najnowsze depesze oraz depesze dla podanych spolek (tickery z portfela). Klucze zna tylko serwer. */
  async fetchNewsFeed(
    count: number = 10,
    tickers: string[] = [],
  ): Promise<{ news: Freedom24NewsItem[]; newsByTicker: Record<string, Freedom24NewsItem[]>; problem: string | null }> {
    try {
      const res = await apiFetch('/api/brokers/freedom24/news', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ count, tickers }),
      });
      const data = await res.json();
      if (data && data.success && Array.isArray(data.news)) {
        ostatnieDanePogladowe.news = null;
        return {
          news: data.news,
          newsByTicker: data.newsByTicker && typeof data.newsByTicker === 'object' ? data.newsByTicker : {},
          problem: data.configured === false ? String(data.message || 'Brak kluczy Freedom24 na serwerze.') : null,
        };
      }
      return { news: [], newsByTicker: {}, problem: String(data?.message || 'Freedom24 nie zwróciło wiadomości.') };
    } catch (e: any) {
      return { news: [], newsByTicker: {}, problem: `Brak połączenia z serwerem aplikacji: ${e.message}` };
    }
  },

  async fetchNews(count: number = 10): Promise<Freedom24NewsItem[]> {
    return (await this.fetchNewsFeed(count)).news;
  },

  async fetchCashFlows(dateFrom?: string, dateTo?: string, apiKey?: string, apiSecret?: string) {
    try {
      const res = await apiFetch('/api/brokers/freedom24/cashflows', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dateFrom, dateTo, apiKey, apiSecret }),
      });
      const data = await res.json();
      // Pusta lista po nieudanym odczycie znaczylaby "nie bylo wyplat", a to
      // przy rozliczeniu podatku zupelnie co innego niz "nie udalo sie
      // sprawdzic". Funkcja nie ma dzis wywolan - kontrakt ma byc uczciwy,
      // zanim ktos ja podepnie.
      if (!data?.success) {
        throw new Error(data?.message || 'Freedom24 nie oddało przepływów pieniężnych.');
      }
      return data.cashflows || [];
    } catch (e: any) {
      console.warn('[Freedom24 CashFlows] Error:', e.message);
      throw e;
    }
  },

  /**
   * @param underlyingPrice notowanie znane ekranowi. Bez niego serwer nie ma
   *   skad wziac ceny bazowej - wczesniej podstawial tabele wpisana w kod
   *   albo 150 USD, wiec BTC dostawal lancuch strike'ow wokol 150 dolarow.
   */
  async fetchOptionsChain(
    ticker: string,
    expiration?: string,
    apiKey?: string,
    apiSecret?: string,
    underlyingPrice?: number | null
  ) {
    try {
      const res = await apiFetch('/api/brokers/freedom24/options', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ticker, expiration, apiKey, apiSecret, underlyingPrice }),
      });
      const data = await res.json();
      return data;
    } catch (e: any) {
      console.warn('[Freedom24 Options] Error:', e.message);
      return null;
    }
  },

  async fetchOrdersHistory(statusFilter: 'ALL' | 'ACTIVE' = 'ALL', apiKey?: string, apiSecret?: string) {
    try {
      const res = await apiFetch('/api/brokers/freedom24/orders-history', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ statusFilter, apiKey, apiSecret }),
      });
      const data = await res.json();
      return data.orders || [];
    } catch (e: any) {
      console.warn('[Freedom24 OrdersHistory] Error:', e.message);
      return [];
    }
  },

  async fetchCpsHistory(
    payload: {
      cpsDocId?: number;
      id?: number;
      date_from?: string;
      date_to?: string;
      limit?: number;
      offset?: number;
      cps_status?: number;
      sid?: string;
    } = {},
    apiKey?: string,
    apiSecret?: string
  ) {
    try {
      const res = await apiFetch('/api/brokers/freedom24/cps/history', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...payload, apiKey, apiSecret }),
      });
      const data = await res.json();
      return data.cps || [];
    } catch (e: any) {
      console.warn('[Freedom24 CpsHistory] Error:', e.message);
      return [];
    }
  },

  async fetchCpsFiles(id: number, internal_id?: number, sid?: string, apiKey?: string, apiSecret?: string) {
    try {
      const res = await apiFetch('/api/brokers/freedom24/cps/files', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, internal_id, sid, apiKey, apiSecret }),
      });
      const data = await res.json();
      return data.files || [];
    } catch (e: any) {
      console.warn('[Freedom24 CpsFiles] Error:', e.message);
      return [];
    }
  },
};
