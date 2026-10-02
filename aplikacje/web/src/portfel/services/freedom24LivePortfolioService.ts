import { apiFetch } from "./apiTransport";
import type { PozycjaBrokera } from "./pozycjeBrokera";
export interface Freedom24AccountBalance {
  curr: string;
  /** Kurs waluty rachunku względem waluty bazowej brokera; nie jest kwotą USD. */
  currval: number | null;
  /** `null`, gdy broker nie podal kwoty - zero znaczyloby puste saldo. */
  s: number | null;
  forecast_in: number;
  forecast_out: number;
  t2_in: number;
  t2_out: number;
}

export interface Freedom24LivePosition {
  i: string;
  name: string;
  name2?: string;
  /** `null`, gdy broker nie podal ilosci. */
  q: number | null;
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

export interface Freedom24PortfolioLiveResponse {
  success: boolean;
  acc: Freedom24AccountBalance[];
  pos: Freedom24LivePosition[];
  cached?: boolean;
  /** Powod braku danych - pokazywany zamiast wymyslonych kwot. */
  message?: string;
}

/** Odstep miedzy odswiezeniami portfela na zywo. */
const ODSTEP_ODSWIEZANIA_MS = 30_000;

export const freedom24LivePortfolioService = {
  /**
   * Pozycje rachunku do zestawienia z FIFO silnika. `null`, gdy broker nie
   * odpowiedzial - brak odpowiedzi to nie jest "pusty rachunek".
   */
  async fetchBrokerPositions(): Promise<PozycjaBrokera[] | null> {
    try {
      // Status jest lokalny (czy serwer ma pliki z kluczami) - bez kluczy nie
      // wysylamy do brokera nic.
      const status = await apiFetch('/api/brokers/freedom24/status');
      const stan = await status.json();
      if (!status.ok || stan?.configured !== true) return null;
      const res = await apiFetch('/api/brokers/freedom24/portfolio', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      const data = await res.json();
      if (!res.ok || !data?.success || !Array.isArray(data.portfolio?.positions)) return null;
      return data.portfolio.positions
        .filter((pozycja: any) => typeof pozycja?.ticker === 'string' && pozycja.ticker.trim() !== '')
        .map((pozycja: any) => ({
          ticker: pozycja.ticker,
          market: typeof pozycja.market === 'string' ? pozycja.market : null,
          quantity: typeof pozycja.quantity === 'number' && Number.isFinite(pozycja.quantity) ? pozycja.quantity : null,
          currency: typeof pozycja.currency === 'string' ? pozycja.currency : '',
          marketPrice:
            typeof pozycja.marketPrice === 'number' && Number.isFinite(pozycja.marketPrice) ? pozycja.marketPrice : null,
        }));
    } catch {
      return null;
    }
  },

  async fetchLivePortfolio(): Promise<Freedom24PortfolioLiveResponse> {
    try {
      const res = await apiFetch('/api/brokers/freedom24/portfolio', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      const data = await res.json();
      if (data?.success && data.portfolio) {
        return {
          success: true,
          acc: data.portfolio.balances.map((balance: any) => ({
            curr: balance.currency,
            currval: balance.exchangeRate,
            s: typeof balance.amount === 'number' ? balance.amount : null,
            forecast_in: 0,
            forecast_out: 0,
            t2_in: 0,
            t2_out: 0,
          })),
          pos: data.portfolio.positions.map((position: any) => ({
            i: position.market ? `${position.ticker}.${position.market}` : position.ticker,
            name: position.ticker,
            q: typeof position.quantity === 'number' ? position.quantity : null,
            curr: position.currency,
            currval: null,
            mkt_price: position.marketPrice,
            market_value: position.marketValue,
            bal_price_a: position.averagePrice,
            price_a: position.averagePrice,
            open_bal: null,
            profit_price: null,
            profit_close: position.profit,
            close_price: 0,
            acc_pos_id: 0,
            instr_id: 0,
            issue_nb: position.isin ?? undefined,
          })),
          cached: false,
        };
      }
      if (data?.message) return { success: false, message: data.message, acc: [], pos: [], cached: false };
    } catch (e: any) {
      console.warn('[Freedom24 LivePortfolio] Error:', e.message);
    }

    // Zaden wymyslony portfel. Wczesniej brak kluczy albo awaria API konczyly
    // sie zwrotem zaszytego portfela demonstracyjnego na 44 168 USD - razem
    // z pozycjami, ktorych uzytkownik nigdy nie mial. W aplikacji, ktora liczy
    // podatek, taka liczba na ekranie jest gorsza niz jej brak.
    return {
      success: false,
      message:
        'Brak danych z Freedom24. Uzupełnij klucze API w zakładce Rachunki albo sprawdź połączenie.',
      acc: [],
      pos: [],
      cached: false,
    };
  },

  /**
   * Podglad portfela na zywo.
   *
   * Wczesniej ta funkcja otwierala WebSocket do `wss://wss.freedom24.com/` bez
   * zadnego uwierzytelnienia i wysylala tam `["portfolio"]`. Tradernet wymaga
   * podpisanej sesji, wiec polaczenie nigdy nie zwracalo danych - konczylo sie
   * bledem w konsoli przy kazdym wejsciu na zakladke, takze u kogos, kto w ogole
   * nie podal kluczy. Do tego socket nie mial obslugi `onerror`/`onclose`, wiec
   * blad szedl prosto do konsoli przegladarki jako nieobsluzony.
   *
   * Podpisu nie da sie zrobic w przegladarce bez wystawienia sekretu na strone,
   * dlatego dane ida przez wlasna trase serwera, ktora podpisuje zadanie po
   * swojej stronie. Bez kluczy nie ma odpytywania w kolko: jedna odpowiedz z
   * informacja, czego brakuje, i cisza do czasu uzupelnienia kluczy.
   */
  subscribeLivePortfolio(
    onData: (data: Freedom24PortfolioLiveResponse) => void,
    _apiKey?: string,
    _apiSecret?: string
  ): () => void {
    let zatrzymany = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const pobierz = async (): Promise<void> => {
      const dane = await this.fetchLivePortfolio();
      // Odpowiedz, ktora dotarla po odmontowaniu komponentu, nie moze juz
      // ustawiac jego stanu.
      if (zatrzymany) return;
      onData(dane);
      // Odstep liczony od konca poprzedniego pobrania, a nie na sztywnym
      // interwale: przy wolnej odpowiedzi setInterval potrafil ustawic w
      // kolejce kilka zadan naraz.
      timer = setTimeout(pobierz, ODSTEP_ODSWIEZANIA_MS);
    };

    void pobierz();

    return () => {
      zatrzymany = true;
      if (timer) clearTimeout(timer);
    };
  },
};
