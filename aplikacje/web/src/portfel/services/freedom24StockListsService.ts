import { apiFetch } from "./apiTransport";
export interface Freedom24StockList {
  id: number;
  userId?: number;
  name: string;
  tickers: string[];
  picture?: string | null;
}

export interface Freedom24StockListsResponse {
  success: boolean;
  message?: string;
  userStockLists: Freedom24StockList[];
  selectedId: number;
  defaultId: number;
  /**
   * Skad pochodza listy: z konta Freedom24 czy tylko z tej przegladarki.
   * Bez tego pola listy wpisane w kod i zapisane lokalnie wygladaly tak samo
   * jak odczyt z konta brokera.
   */
  zrodlo?: 'freedom24' | 'lokalne';
}

const STORAGE_KEY = 'pit38_freedom24_stock_lists_cache';

export const freedom24StockListsService = {
  // Get cached lists
  /**
   * Listy zapisane w tej przegladarce albo zestaw startowy.
   *
   * Zestaw startowy to propozycja aplikacji, a nie odczyt z konta - wczesniej
   * wracal z `success: true` bez zadnego znacznika, wiec dwadziescia kilka
   * tickerow, ktorych uzytkownik nigdy nie dodal, wygladalo jak jego wlasna
   * lista obserwowanych pobrana z Freedom24.
   */
  getCachedLists(): Freedom24StockListsResponse {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) {
        const zapisane = JSON.parse(saved) as Freedom24StockListsResponse;
        return { ...zapisane, zrodlo: zapisane.zrodlo ?? 'lokalne' };
      }
    } catch {
      // ignore
    }
    return {
      success: true,
      zrodlo: 'lokalne',
      message:
        'To zestaw startowy zaproponowany przez aplikacje, nie listy z konta Freedom24.',
      userStockLists: [
        {
          id: 1,
          name: 'default',
          tickers: ['FRHC', 'TSLA', 'NBIS', 'INTC', 'NVDA', 'AAPL', 'MSFT', 'AMZN', 'GOOGL', 'META'],
          picture: null,
        },
        {
          id: 2,
          name: 'ETF & Dywidendowe',
          tickers: ['VOO', 'QQQ', 'VTI', 'SPY', 'VWCE', 'SCHD', 'JEPI'],
          picture: '📈',
        },
        {
          id: 3,
          name: 'Krypto & Tech',
          tickers: ['BTC', 'ETH', 'SOL', 'NVDA', 'AMD', 'PLTR'],
          picture: '⚡',
        },
      ],
      selectedId: 1,
      defaultId: 1,
    };
  },

  // Save to cache
  saveToCache(data: Freedom24StockListsResponse) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    } catch {
      // ignore
    }
  },

  // 1. Fetch user stock lists from Freedom24 API
  async fetchLists(apiKey?: string, apiSecret?: string, sid?: string): Promise<Freedom24StockListsResponse> {
    try {
      const res = await apiFetch('/api/brokers/freedom24/stock-lists', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apiKey, apiSecret, sid }),
      });
      const data = await res.json();
      if (data && data.success && Array.isArray(data.userStockLists) && data.userStockLists.length > 0) {
        const zBrokera: Freedom24StockListsResponse = { ...data, zrodlo: 'freedom24' };
        this.saveToCache(zBrokera);
        return zBrokera;
      }
    } catch (e: any) {
      console.warn('[Freedom24 StockLists] Offline/error fallback:', e.message);
    }
    return this.getCachedLists();
  },

  // 2. Add a new stock list
  async addList(
    name: string,
    tickers: string[],
    picture?: string,
    apiKey?: string,
    apiSecret?: string,
    sid?: string
  ): Promise<Freedom24StockListsResponse> {
    const cached = this.getCachedLists();
    const newId = Math.max(0, ...cached.userStockLists.map((l) => l.id)) + 1;
    const cleanTickers = tickers.map((t) => t.toUpperCase().trim()).filter(Boolean);

    const localNewList: Freedom24StockList = {
      id: newId,
      name,
      tickers: cleanTickers,
      picture: picture || '📁',
    };

    const updatedLists = [...cached.userStockLists, localNewList];
    // Lista powstaje najpierw w tej przegladarce. Komunikat mowil "zostala
    // utworzona" takze wtedy, gdy zapytanie do brokera sie nie udalo albo
    // nie bylo kluczy - u brokera nie powstawalo nic.
    const localResult: Freedom24StockListsResponse = {
      success: true,
      zrodlo: 'lokalne',
      message: `Lista "${name}" zapisana w tej przeglądarce (nie na koncie Freedom24).`,
      userStockLists: updatedLists,
      selectedId: newId,
      defaultId: cached.defaultId || 1,
    };
    this.saveToCache(localResult);

    if (apiKey && apiSecret) {
      try {
        const res = await apiFetch('/api/brokers/freedom24/stock-lists/add', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ apiKey, apiSecret, name, picture, tickers: cleanTickers, sid }),
        });
        const serverData = await res.json();
        if (serverData && serverData.success && serverData.userStockLists) {
          const zBrokera: Freedom24StockListsResponse = { ...serverData, zrodlo: 'freedom24' };
          this.saveToCache(zBrokera);
          return zBrokera;
        }
      } catch (e: any) {
        console.warn('[Freedom24 StockLists] Add list API error:', e.message);
      }
    }

    return localResult;
  },

  // 3. Update stock list
  async updateList(
    id: number,
    updates: { name?: string; picture?: string; index?: number },
    apiKey?: string,
    apiSecret?: string,
    sid?: string
  ): Promise<Freedom24StockListsResponse> {
    const cached = this.getCachedLists();
    const updatedLists = cached.userStockLists.map((list) => {
      if (list.id === id) {
        return {
          ...list,
          name: updates.name !== undefined ? updates.name : list.name,
          picture: updates.picture !== undefined ? updates.picture : list.picture,
        };
      }
      return list;
    });

    // `...cached` przenosilo zrodlo z poprzedniego odczytu: po nieudanym
    // zapisie w API lista dalej podawala sie za stan konta Freedom24,
    // chociaz zmiana istnieje tylko w tej przegladarce.
    const localResult: Freedom24StockListsResponse = {
      ...cached,
      userStockLists: updatedLists,
      zrodlo: 'lokalne',
      message: 'Zmiana zapisana w tej przeglądarce (nie na koncie Freedom24).',
    };
    this.saveToCache(localResult);

    if (apiKey && apiSecret) {
      try {
        const res = await apiFetch('/api/brokers/freedom24/stock-lists/update', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ apiKey, apiSecret, id, ...updates, sid }),
        });
        const serverData = await res.json();
        if (serverData && serverData.success && serverData.userStockLists) {
          const zBrokera: Freedom24StockListsResponse = { ...serverData, zrodlo: 'freedom24' };
          this.saveToCache(zBrokera);
          return zBrokera;
        }
      } catch (e: any) {
        console.warn('[Freedom24 StockLists] Update list API error:', e.message);
      }
    }

    return localResult;
  },

  // 4. Delete stock list
  async deleteList(
    id: number,
    apiKey?: string,
    apiSecret?: string,
    sid?: string
  ): Promise<Freedom24StockListsResponse> {
    const cached = this.getCachedLists();
    const updatedLists = cached.userStockLists.filter((l) => l.id !== id);
    const newSelectedId = cached.selectedId === id ? updatedLists[0]?.id || 1 : cached.selectedId;

    const localResult: Freedom24StockListsResponse = {
      success: true,
      zrodlo: 'lokalne',
      message: 'Lista usunięta w tej przeglądarce (na koncie Freedom24 mogła zostać).',
      userStockLists: updatedLists,
      selectedId: newSelectedId,
      defaultId: cached.defaultId === id ? updatedLists[0]?.id || 1 : cached.defaultId,
    };
    this.saveToCache(localResult);

    if (apiKey && apiSecret) {
      try {
        const res = await apiFetch('/api/brokers/freedom24/stock-lists/delete', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ apiKey, apiSecret, id, sid }),
        });
        const serverData = await res.json();
        if (serverData && serverData.success && serverData.userStockLists) {
          const zBrokera: Freedom24StockListsResponse = { ...serverData, zrodlo: 'freedom24' };
          this.saveToCache(zBrokera);
          return zBrokera;
        }
      } catch (e: any) {
        console.warn('[Freedom24 StockLists] Delete list API error:', e.message);
      }
    }

    return localResult;
  },

  // 5. Select active stock list
  async selectList(
    id: number,
    apiKey?: string,
    apiSecret?: string,
    sid?: string
  ): Promise<Freedom24StockListsResponse> {
    const cached = this.getCachedLists();
    const localResult: Freedom24StockListsResponse = {
      ...cached,
      selectedId: id,
      zrodlo: 'lokalne',
      message: 'Wybór listy zapisany w tej przeglądarce (nie na koncie Freedom24).',
    };
    this.saveToCache(localResult);

    if (apiKey && apiSecret) {
      try {
        const res = await apiFetch('/api/brokers/freedom24/stock-lists/select', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ apiKey, apiSecret, id, sid }),
        });
        const serverData = await res.json();
        if (serverData && serverData.success) {
          this.saveToCache(serverData);
          return serverData;
        }
      } catch (e: any) {
        console.warn('[Freedom24 StockLists] Select list API error:', e.message);
      }
    }

    return localResult;
  },

  // 6. Add ticker to stock list
  async addTicker(
    id: number,
    ticker: string,
    index?: number,
    apiKey?: string,
    apiSecret?: string,
    sid?: string
  ): Promise<Freedom24StockListsResponse> {
    const cleanTicker = ticker.toUpperCase().trim();
    const cached = this.getCachedLists();
    const updatedLists = cached.userStockLists.map((list) => {
      if (list.id === id) {
        const exists = list.tickers.some((t) => t.toUpperCase() === cleanTicker);
        if (!exists) {
          const nextTickers = [...list.tickers];
          if (index !== undefined && index >= 0 && index <= nextTickers.length) {
            nextTickers.splice(index, 0, cleanTicker);
          } else {
            nextTickers.push(cleanTicker);
          }
          return { ...list, tickers: nextTickers };
        }
      }
      return list;
    });

    // `...cached` przenosilo zrodlo z poprzedniego odczytu: po nieudanym
    // zapisie w API lista dalej podawala sie za stan konta Freedom24,
    // chociaz zmiana istnieje tylko w tej przegladarce.
    const localResult: Freedom24StockListsResponse = {
      ...cached,
      userStockLists: updatedLists,
      zrodlo: 'lokalne',
      message: 'Zmiana zapisana w tej przeglądarce (nie na koncie Freedom24).',
    };
    this.saveToCache(localResult);

    if (apiKey && apiSecret) {
      try {
        const res = await apiFetch('/api/brokers/freedom24/stock-lists/ticker/add', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ apiKey, apiSecret, id, ticker: cleanTicker, index, sid }),
        });
        const serverData = await res.json();
        if (serverData && serverData.success && serverData.userStockLists) {
          const zBrokera: Freedom24StockListsResponse = { ...serverData, zrodlo: 'freedom24' };
          this.saveToCache(zBrokera);
          return zBrokera;
        }
      } catch (e: any) {
        console.warn('[Freedom24 StockLists] Add ticker API error:', e.message);
      }
    }

    return localResult;
  },

  // 7. Delete ticker from stock list
  async deleteTicker(
    id: number,
    ticker: string,
    apiKey?: string,
    apiSecret?: string,
    sid?: string
  ): Promise<Freedom24StockListsResponse> {
    const cleanTicker = ticker.toUpperCase().trim();
    const cached = this.getCachedLists();
    const updatedLists = cached.userStockLists.map((list) => {
      if (list.id === id) {
        return {
          ...list,
          tickers: list.tickers.filter((t) => t.toUpperCase() !== cleanTicker),
        };
      }
      return list;
    });

    // `...cached` przenosilo zrodlo z poprzedniego odczytu: po nieudanym
    // zapisie w API lista dalej podawala sie za stan konta Freedom24,
    // chociaz zmiana istnieje tylko w tej przegladarce.
    const localResult: Freedom24StockListsResponse = {
      ...cached,
      userStockLists: updatedLists,
      zrodlo: 'lokalne',
      message: 'Zmiana zapisana w tej przeglądarce (nie na koncie Freedom24).',
    };
    this.saveToCache(localResult);

    if (apiKey && apiSecret) {
      try {
        const res = await apiFetch('/api/brokers/freedom24/stock-lists/ticker/delete', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ apiKey, apiSecret, id, ticker: cleanTicker, sid }),
        });
        const serverData = await res.json();
        if (serverData && serverData.success && serverData.userStockLists) {
          const zBrokera: Freedom24StockListsResponse = { ...serverData, zrodlo: 'freedom24' };
          this.saveToCache(zBrokera);
          return zBrokera;
        }
      } catch (e: any) {
        console.warn('[Freedom24 StockLists] Delete ticker API error:', e.message);
      }
    }

    return localResult;
  },
};
