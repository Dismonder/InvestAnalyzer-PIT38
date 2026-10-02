/**
 * engineBridge.ts — most łączący portfel UI z silnikiem Python.
 *
 * Konwertuje Transaction[] z portfela na format broker_report_json,
 * importuje plik do storage, uruchamia silnik podatkowy i mapuje
 * wynik TaxEngineResponse → TaxCalculationResult.
 *
 * UWAGI O LUKACH:
 * - Kryptowaluty: silnik ma pola crypto_revenue / crypto_cost, ale
 *   kalkulator portfelowy klasyfikuje krypto po polu `category`.
 *   Silnik nie otrzymuje tej kategorii w trades (pole nie istnieje
 *   w schemacie broker_report_json). Wynik krypto będzie zerowy,
 *   chyba że silnik sam rozpozna instrument jako krypto z suffixu.
 * - Strata z lat ubiegłych: silnik używa priorYearLosses z
 *   TaxEngineRequest — portfel ich nie przekazuje (nie ma UI do ich
 *   wpisania). Pole lossCarryforward nie będzie wypełnione.
 * - Prowizja kupna w walucie innej niż waluta transakcji: silnik
 *   rozpoznaje pole commission_currency, ale broker_report_json
 *   nie ma takiego klucza. Prowizja jest wysyłana w walucie transakcji.
 * - PIT-8C: silnik wyznacza część polską, pozostałą i pola formularza.
 * - brokerBreakdowns: silnik nie grupuje wyniku per account,
 *   więc pole brokerBreakdowns będzie puste.
 */

import type {
  Transaction,
  BrokerAccount,
  TaxRealizedGain,
  DividendTaxItem,
  TaxYearSummary,
  OpenPosition,
  OpenLotDetail,
  MatchedBuyLot,
  AssetCategory,
  CurrencyCode,
  TaxCalculationResult,
} from '../types';
import type { TaxEngineResponse } from '../../invest_analyzer/hooks/useTaxEngineRun';
import type { TaxEngineJobStatus } from '../../invest_analyzer/services/runtimeApi.types';
import { odczytajUstawienia } from './optymalizacjaPodatkowa';
import { wystawiaPit8c } from './pit8c';
import type { WpisPit8c } from './optymalizacjaPodatkowa';
import { runtimeApi } from '../../invest_analyzer/services/runtimeApi';
import { przygotujZadanieSilnika } from '../../invest_analyzer/services/taxEngineRequestFactory';
import { odczytajWynikSilnika, opublikujWynikSilnika } from '../../invest_analyzer/services/ostatniWynikSilnika';
import { PRZEDROSTEK_REKORDU_PORTFELA } from './reczneTransakcje';
import { KONTO_MAGAZYNU_SILNIKA, RACHUNEK_NIEUSTALONY } from './pozycjaRachunku';

// ---------------------------------------------------------------------------
// Stałe
// ---------------------------------------------------------------------------

/** Nazwa historyczna zachowana dla diagnostyki; most nie zapisuje już tego pliku. */
const STORAGE_FILENAME = 'portfel_reczne_transakcje.json';


/**
 * Interwał odpytywania statusu job'a silnika (ms).
 */
const POLL_INTERVAL_MS = 600;
// Gorna granica czekania na silnik. Bez niej petla odpytywania krecila sie bez
// konca: gdy proces silnika utknal albo zniknal, interfejs pokazywal "przelicza"
// w nieskonczonosc i nie dalo sie odroznic dlugiego przebiegu od awarii.
const MAKSYMALNY_CZAS_PRZEBIEGU_MS = 10 * 60 * 1000;
// Po kolejnych nieudanych odpytaniach statusu odpuszczamy - serwer moze byc
// zatrzymany, a kazda proba i tak konczy sie wyjatkiem.
const DOZWOLONE_BLEDY_ODPYTANIA = 5;

// ---------------------------------------------------------------------------
// 0. Kontrola danych wejsciowych
// ---------------------------------------------------------------------------

/**
 * Transakcja, ktorej nie wolno wyslac do silnika.
 *
 * Powod jest praktyczny: JSON.stringify zamienia NaN i Infinity na null, a
 * silnik pomija pole null bez slowa. Jedna zepsuta liczba z importu CSV
 * potrafila wiec cicho wyzerowac kwote transakcji i przekłamac podatek.
 * Lepiej zatrzymac przeliczenie i powiedziec, ktory wpis jest do poprawy.
 */
export interface ProblemTransakcji {
  id: string;
  ticker: string;
  pole: string;
  powod: string;
}

// Powyzej tego rzedu liczba zmiennoprzecinkowa traci grosze, wiec kwota
// przestaje byc wiarygodna dla rozliczenia.
const MAKSYMALNA_KWOTA = 1e15;

function liczbaPoprawna(wartosc: unknown): wartosc is number {
  return typeof wartosc === 'number' && Number.isFinite(wartosc) && Math.abs(wartosc) < MAKSYMALNA_KWOTA;
}

function dataPoprawna(wartosc: unknown): boolean {
  if (typeof wartosc !== 'string' || wartosc.trim() === '') return false;
  const znacznik = Date.parse(wartosc);
  if (Number.isNaN(znacznik)) return false;
  const rok = new Date(znacznik).getUTCFullYear();
  return rok >= 1990 && rok <= new Date().getUTCFullYear() + 1;
}

/** Zwraca liste problemow; pusta lista oznacza dane gotowe do wyslania. */
export function sprawdzTransakcje(transactions: Transaction[]): ProblemTransakcji[] {
  const problemy: ProblemTransakcji[] = [];
  const dodaj = (tx: Transaction, pole: string, powod: string) => {
    problemy.push({ id: tx.id || '(bez identyfikatora)', ticker: tx.ticker || '(bez tickera)', pole, powod });
  };

  for (const tx of transactions) {
    if (!dataPoprawna(tx.date)) {
      dodaj(tx, 'data', 'brak daty albo data poza zakresem 1990 - rok przyszły');
    }
    if (!tx.currency || !/^[A-Za-z]{3}$/.test(tx.currency)) {
      dodaj(tx, 'waluta', 'waluta musi być trzyliterowym kodem, np. USD');
    }
    if (!liczbaPoprawna(tx.pricePerUnit) || tx.pricePerUnit < 0) {
      dodaj(tx, 'cena', 'cena musi być liczbą nieujemną');
    }
    if (tx.commission !== undefined && (!liczbaPoprawna(tx.commission) || tx.commission < 0)) {
      dodaj(tx, 'prowizja', 'prowizja musi być liczbą nieujemną');
    }

    if (tx.type === 'BUY' || tx.type === 'SELL') {
      if (!tx.ticker || !tx.ticker.trim()) {
        dodaj(tx, 'ticker', 'transakcja kupna i sprzedaży musi wskazywać walor');
      }
      if (!liczbaPoprawna(tx.quantity) || tx.quantity <= 0) {
        dodaj(tx, 'ilość', 'ilość musi być liczbą większą od zera');
      }
    }

    if (tx.type === 'DIVIDEND') {
      if (!tx.ticker || !tx.ticker.trim()) {
        // Bez symbolu silnik nie przypisze kraju, wiec dywidenda nie trafi
        // do zalacznika PIT/ZG, a bramka pokrycia zablokuje rozliczenie.
        dodaj(tx, 'ticker', 'dywidenda musi wskazywać walor - inaczej nie da się ustalić kraju do PIT/ZG');
      }
      const brutto = (liczbaPoprawna(tx.quantity) && tx.quantity > 0 ? tx.quantity : 1) * (tx.pricePerUnit || 0);
      if (tx.foreignTaxAmount !== undefined) {
        if (!liczbaPoprawna(tx.foreignTaxAmount) || tx.foreignTaxAmount < 0) {
          dodaj(tx, 'podatek u źródła', 'kwota podatku musi być liczbą nieujemną');
        } else if (brutto > 0 && tx.foreignTaxAmount > brutto) {
          dodaj(tx, 'podatek u źródła', 'podatek nie może być większy od dywidendy brutto');
        }
      }
      if (tx.foreignTaxRate !== undefined && (!liczbaPoprawna(tx.foreignTaxRate) || tx.foreignTaxRate < 0 || tx.foreignTaxRate > 100)) {
        dodaj(tx, 'stawka podatku', 'stawka musi mieścić się w przedziale 0 - 100');
      }
    }
  }

  return problemy;
}

/** Komunikat dla uzytkownika: co poprawic i gdzie. */
export function opiszProblemy(problemy: ProblemTransakcji[]): string {
  const pierwsze = problemy.slice(0, 5).map((p) => `${p.ticker} (${p.id}): ${p.pole} - ${p.powod}`);
  const reszta = problemy.length > pierwsze.length ? `\n…oraz ${problemy.length - pierwsze.length} kolejnych.` : '';
  return `Nie wysłano danych do silnika, bo ${problemy.length} wpisów ma błędy:\n${pierwsze.join('\n')}${reszta}`;
}

// ---------------------------------------------------------------------------
// 1. Konwersja WEJŚCIA: Transaction[] → broker_report_json
// ---------------------------------------------------------------------------

/**
 * Nazwy pol nie sa dowolne - to aliasy, ktore czyta normalizator silnika:
 *  - transakcje: normalize/trades.py, funkcja to_canonical_trade
 *      symbol      <- instr_nm | Tickery | ticker | Ticker | Symbol
 *      ilosc       <- q | Quantity | quantity
 *      cena        <- p | Cena | price
 *      kwota       <- v | summ | Kwota | Gross Amount | Value   (BEZ niej silnik
 *                     nie policzy przychodu ani kosztu - wychodzi 0,00)
 *      strona      <- operation | oper | side | Side | type | Type | Rodzaj zlecenia
 *      prowizja    <- commission | Oplata | Fee | Commission
 *      rachunek    <- account | Rachunek  (po tym polu FIFO rozdziela brokerow)
 *  - zdarzenia: normalize/events.py
 *      rodzaj      <- Rodzaj zlecenia | type | type_code_name | type_code | name
 *                     (pole "kind" NIE jest czytane)
 *      komentarz   <- Komentarz | comment | message | description
 *      kwota       <- Kwota | amount | sum
 *      waluta      <- waluta | currency | curr
 */
interface BrokerReportTrade {
  date: string;
  Symbol: string;
  Side: 'BUY' | 'SELL';
  Quantity: number;
  Cena: number;
  Kwota: number;
  Currency: string;
  Commission: number;
  'Commission Currency': string;
  account: string;
  comment?: string;
  /**
   * Znacznik rodzaju instrumentu. Waluty wirtualne rozliczaja sie w czesci E
   * PIT-38 wedlug innych regul, wiec silnik musi je odroznic - bez tego symbol
   * w rodzaju BTCUSDT wpada do kolejki FIFO czesci C, czyli do zlej sekcji.
   * Aplikacja zna kategorie instrumentu, wiec podaje ja wprost.
   */
  instr_type_c?: string;
}

interface BrokerReportCashFlow {
  date: string;
  Symbol: string;
  /**
   * Rodzaj zdarzenia po polsku, bo normalize/classify.py rozpoznaje dywidende
   * po czlonie "dywid" w rodzaju albo po slowie "dividend" w komentarzu.
   * Wypelniamy oba warunki naraz, zeby klasyfikacja nie zalezala od jezyka.
   */
  type: string;
  amount: number;
  currency: string;
  account: string;
  comment: string;
}

interface BrokerReportJson {
  trades: BrokerReportTrade[];
  cash_flows: BrokerReportCashFlow[];
}

/**
 * Buduje mapę accountId → unikalny identyfikator konta brokera.
 *
 * Silnik partycjonuje FIFO po polu `account` w trades — każda
 * unikalna wartość tworzy oddzielną kolejkę. Dzięki temu
 * partie tego samego tickera u różnych brokerów nie mieszają się.
 *
 * Normalizer (`normalize/trades.py`) czyta pole `account` (alias:
 * "Rachunek") i zapisuje je jako `account_id` w CanonicalTrade.
 */
function buildAccountMap(accounts: BrokerAccount[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const acc of accounts) {
    // Używamy brokerType + id, żeby uniknąć kolizji nazw
    const label = `${acc.brokerType}_${acc.id}`;
    map.set(acc.id, label);
  }
  return map;
}

/**
 * Zamienia datę ISO (z opcjonalnym T i godziną) na YYYY-MM-DD.
 */
function toDateOnly(dateStr: string): string {
  return dateStr.slice(0, 10);
}

/**
 * Konwertuje transakcje portfela na obiekt broker_report_json
 * rozpoznawany przez silnik.
 *
 * Logika klasyfikacji:
 * - BUY / SELL → sekcja "trades", pole side BUY/SELL
 * - DIVIDEND → sekcja "cash_flows", kind DIVIDEND
 *   + jeśli foreignTaxAmount > 0, dodatkowy wpis kind TAX (ujemna kwota)
 * - FEE → sekcja "cash_flows", kind FEE
 *
 * Dywidenda MUSI mieć ticker w polu `ticker` cash_flow — inaczej
 * silnik nie przypisze kraju (classify.py: infer_country_from_symbol).
 * Dodatkowo wpisujemy symbol w `comment` jako duplikat bezpieczeństwa.
 */
export function transactionsToEngineInput(
  transactions: Transaction[],
  accounts: BrokerAccount[],
): BrokerReportJson {
  const accountMap = buildAccountMap(accounts);
  const trades: BrokerReportTrade[] = [];
  const cashFlows: BrokerReportCashFlow[] = [];

  for (const tx of transactions) {
    const accountLabel = accountMap.get(tx.accountId) ?? tx.accountId;
    const dateOnly = toDateOnly(tx.date);

    if (tx.type === 'BUY' || tx.type === 'SELL') {
      trades.push({
        date: tx.date,
        Symbol: tx.ticker,
        Side: tx.type,
        Quantity: tx.quantity,
        Cena: tx.pricePerUnit,
        Kwota: tx.quantity * tx.pricePerUnit,
        Currency: tx.currency,
        Commission: tx.commission || 0,
        'Commission Currency': tx.commissionCurrency || tx.currency,
        account: accountLabel,
        comment: tx.notes || undefined,
        instr_type_c: tx.category === 'CRYPTO' ? 'CRYPTO'
          : tx.category === 'ETF' ? 'ETF'
            : tx.category === 'BOND' ? 'BOND' : 'STOCK',
      });
    } else if (tx.type === 'DIVIDEND') {
      const grossAmount =
        tx.quantity && tx.quantity > 0 ? tx.pricePerUnit * tx.quantity : tx.pricePerUnit;

      // Komentarz musi zawierac ticker (silnik wyciaga z niego kraj do PIT/ZG)
      // oraz slowo "dividend" - patrz opis aliasow wyzej.
      cashFlows.push({
        date: tx.date,
        Symbol: tx.ticker,
        type: 'Dywidenda',
        amount: grossAmount,
        currency: tx.currency,
        account: accountLabel,
        comment: `${tx.ticker} dividend${tx.notes ? ` ${tx.notes}` : ''}`,
      });

      const taxAmount = tx.foreignTaxAmount ?? (grossAmount * (tx.foreignTaxRate ?? 0)) / 100;
      if (taxAmount > 0) {
        cashFlows.push({
          date: tx.date,
          Symbol: tx.ticker,
          // Silnik szuka czlonu "podatk" - mianownik "podatek" go NIE zawiera,
          // dlatego rodzaj musi byc w dopelniaczu ("podatku").
          type: 'Pobranie podatku u zrodla',
          amount: -taxAmount,
          currency: tx.currency,
          account: accountLabel,
          comment: `${tx.ticker} withholding tax`,
        });
      }
    } else if (tx.type === 'FEE') {
      cashFlows.push({
        date: tx.date,
        Symbol: tx.ticker || '',
        type: 'Oplata',
        amount: -(tx.commission || tx.pricePerUnit || 0),
        currency: tx.currency,
        account: accountLabel,
        comment: `${tx.ticker || ''} fee${tx.notes ? ` ${tx.notes}` : ''}`.trim(),
      });
    }
  }

  return { trades, cash_flows: cashFlows };
}

// ---------------------------------------------------------------------------
// 2. Uruchomienie silnika
// ---------------------------------------------------------------------------

async function runEngine(
  year: number,
  transakcjePortfela: readonly Transaction[],
  signal?: AbortSignal,
  wymusPrzeliczenie = false,
): Promise<TaxEngineResponse> {
  // Zadanie sklada ta sama fabryka, z ktorej korzysta warsztat silnika: te
  // same ustawienia, te same reczne rekordy, ten sam wybor zrodel. Wczesniej
  // most budowal wlasne zadanie i dwie zakladki potrafily pokazac dwie kwoty.
  const przygotowane = await przygotujZadanieSilnika(year, { transakcjePortfela });
  const request = przygotowane.request;

  // Ten sam rok, te same dane i ustawienia: wynik policzony przed chwila przez
  // warsztat silnika (albo przez portfel) jest tym samym wynikiem. Drugi
  // przebieg to minuta pracy Pythona po identyczna odpowiedz.
  if (!wymusPrzeliczenie) {
    const gotowy = odczytajWynikSilnika(year);
    if (gotowy && gotowy.kluczZadania === przygotowane.klucz) {
      return gotowy.odpowiedz;
    }
  } else {
    // "Przelicz ponownie" omijalo tylko pamiec karty - serwer oddawal wynik
    // z wlasnej pamieci, wiec np. brakujacy wczoraj kurs NBP nie byl pobierany
    // drugi raz. Warsztat silnika wymusza przeliczenie tak samo. Flaga nie
    // wchodzi do klucza zadania, wiec wynik trafia pod ten sam klucz.
    request.forceRecalculate = true;
  }

  const { jobId } = await runtimeApi.startTaxEngineJob(request);

  // Polling statusu — wzorowane na useTaxEngineRun.ts
  const koniecCzekania = Date.now() + MAKSYMALNY_CZAS_PRZEBIEGU_MS;
  let bledyOdpytania = 0;

  while (true) {
    if (signal?.aborted) {
      await runtimeApi.cancelTaxEngineJob(jobId).catch(() => undefined);
      throw new DOMException('Obliczanie przerwane', 'AbortError');
    }

    if (Date.now() > koniecCzekania) {
      await runtimeApi.cancelTaxEngineJob(jobId).catch(() => undefined);
      throw new Error(
        `Silnik nie zakończył przeliczenia w ciągu ${Math.round(MAKSYMALNY_CZAS_PRZEBIEGU_MS / 60000)} minut. ` +
          'Sprawdź zakładkę „Dokumenty i silnik" — przebieg mógł utknąć na jednym z plików.'
      );
    }

    let status: TaxEngineJobStatus;
    try {
      status = await runtimeApi.getTaxEngineJobStatus(jobId);
      bledyOdpytania = 0;
    } catch (blad: unknown) {
      bledyOdpytania += 1;
      if (bledyOdpytania >= DOZWOLONE_BLEDY_ODPYTANIA) {
        throw new Error(
          'Utracono kontakt z silnikiem podatkowym. Sprawdź, czy serwer aplikacji nadal działa.'
        );
      }
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
      continue;
    }

    if (status.state === 'done') {
      const odpowiedz = (await runtimeApi.getTaxEngineJobResult(jobId)) as TaxEngineResponse;
      if (przygotowane.zatrzymajOllamePoPrzebiegu) {
        await runtimeApi.stopOllama().catch(() => undefined);
      }
      opublikujWynikSilnika(year, przygotowane.klucz, odpowiedz);
      return odpowiedz;
    }
    if (status.state === 'failed' || status.state === 'cancelled') {
      throw new Error(status.message || `Silnik zakończył job statusem ${status.state}`);
    }

    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}

// ---------------------------------------------------------------------------
// 4. Konwersja WYJSCIA: wynik silnika -> TaxCalculationResult
// ---------------------------------------------------------------------------

/**
 * Pola, ktore silnik zwraca w result.json, a ktorych nie deklaruje jeszcze
 * wspolny typ TaxEngineResponse. Zrodlo: app/cli.py (klucze fifo_rows,
 * dividends_view, foreign_tax_view) oraz tax/fifo_engine.py.
 */
interface SilnikWierszFifo {
  row_id?: string;
  symbol?: string;
  sell_trade_id?: string;
  buy_trade_id?: string;
  quantity?: string | number;
  sell_tax_date?: string;
  buy_tax_date?: string;
  sell_fx_date?: string;
  /** Cena jednostkowa sprzedazy w walucie transakcji. */
  sell_price?: number | string;
  /** Waluta transakcji sprzedazy. */
  sell_currency?: string;
  /** Kurs NBP T-1 uzyty do przeliczenia przychodu. */
  sell_fx_rate?: number | string;
  buy_fx_date?: string;
  gross_revenue_pln?: string | number;
  sell_commission_alloc_pln?: string | number;
  net_revenue_pln?: string | number;
  cost_pln?: string | number;
  pnl_pln?: string | number;
  tax_year?: number;
  /** Czy wiersz nalezy do roku, ktory silnik wlasnie rozlicza. */
  in_filing_year?: boolean;
}

interface SilnikWierszDywidendy {
  event_id?: string;
  date?: string;
  symbol?: string;
  country?: string;
  gross_dividend_foreign?: string | number;
  currency?: string;
  gross_dividend_pln?: string | number;
  withholding_tax_foreign?: string | number;
  withholding_tax_pln?: string | number;
  polish_tax_due_pln?: string | number;
  creditable_tax_pln?: string | number;
  tax_to_pay_pln?: string | number;
  /** Rachunek wiersza, jesli silnik go poda (dividends_view dzis go nie zawiera). */
  account_id?: string;
  accountId?: string;
  account?: string;
}

/** Czesc E formularza: waluty wirtualne. Zrodlo: tax/crypto_engine.py. */
interface SilnikCzescE {
  tax_year?: string;
  revenue_pln?: string | number;
  costs_current_year_pln?: string | number;
  costs_carried_in_pln?: string | number;
  total_costs_pln?: string | number;
  income_pln?: string | number;
  costs_carried_out_pln?: string | number;
  tax_19_pln?: string | number;
  trade_count?: number;
  swap_count?: number;
}

/** Otwarta partia FIFO. Zrodlo: tax/fifo_engine.py, open_lots_detail. */
interface SilnikOtwartaPartia {
  lot_id?: string;
  symbol?: string;
  origin_trade_id?: string;
  buy_trade_id?: string;
  account_id?: string;
  accountId?: string;
  account?: string;
  open_date?: string | null;
  logical_world?: string;
  quantity_open?: string | number;
  quantity_remaining?: string | number;
  unit_cost_pln?: string | number;
  cost_remaining_pln?: string | number;
  price?: string | number | null;
  currency?: string | null;
}

// Stale rachunku i filtr pozycji rachunku mieszkaja w pozycjaRachunku.ts (powloka
// potrzebuje ich przy starcie); tutaj zostaja dla dotychczasowych importow.
export { KONTO_MAGAZYNU_SILNIKA, RACHUNEK_NIEUSTALONY, pozycjeNaRachunku } from './pozycjaRachunku';

/**
 * Rachunek partii: pole silnika, transakcja ręczna o tym ID, a gdy ID wskazuje
 * transakcję spoza portfela - dokumenty w magazynie silnika (wyciągi brokera
 * mają ID z silnika, a w portfelu występują jako `silnik:<wiersz>`). Tylko partia
 * bez żadnego ID ma rachunek nieustalony.
 */
function rachunekPartii(
  jawny: string | undefined,
  idTransakcjiNabycia: string,
  transakcjePoId: Map<string, Transaction>,
): string {
  if (jawny) return jawny;
  if (!idTransakcjiNabycia) return RACHUNEK_NIEUSTALONY;
  return transakcjePoId.get(idTransakcjiNabycia)?.accountId
    ?? transakcjePoId.get(`silnik:${idTransakcjiNabycia}`)?.accountId
    ?? KONTO_MAGAZYNU_SILNIKA;
}

function indeksTransakcjiPoId(transactions: Transaction[]): Map<string, Transaction> {
  const index = new Map<string, Transaction>();
  for (const tx of transactions) {
    index.set(tx.id, tx);
    // Wiersze silnika mają prefiks UI, ale origin_trade_id wskazuje surowy row_id.
    if (tx.id.startsWith('silnik:')) index.set(tx.id.slice('silnik:'.length), tx);
    // Transakcja ręczna portfela idzie do silnika jako rekord `portfel-<id>` i pod
    // tym ID wraca w partiach. Bez tego klucza jej partia trafiała do dokumentów
    // magazynu i była dostępna do zleceń na każdym rachunku brokera.
    else index.set(`${PRZEDROSTEK_REKORDU_PORTFELA}${tx.id}`, tx);
  }
  return index;
}

interface WynikSilnika extends TaxEngineResponse {
  fifo_rows?: SilnikWierszFifo[];
  /** Otwarte partie z calego horyzontu danych, nie tylko z roku rozliczenia. */
  open_lots?: SilnikOtwartaPartia[];
  crypto_part_e?: SilnikCzescE;
  dividends_view?: SilnikWierszDywidendy[];
  foreign_tax_view?: Array<Record<string, unknown>>;
  art30b?: Record<string, unknown>;
  art30a?: Record<string, unknown>;
}

/**
 * Liczba z odpowiedzi silnika.
 *
 * `parseFloat` czyta tyle, ile zrozumie, i milczy o reszcie: "100,50" dawalo
 * 100, a "12zl" dawalo 12. Przy kwotach to cicha utrata groszy albo calej
 * czesci dziesietnej. Przecinek traktujemy jak separator dziesietny - tak samo
 * jak `kwotaZWpisu` w pit8c.ts - a tekst, ktory nie jest liczba, daje 0.
 */
function safeNum(val: string | number | null | undefined): number {
  if (val == null || val === '') return 0;
  if (typeof val === 'number') return Number.isFinite(val) ? val : 0;
  const oczyszczony = val.replace(/\s/g, '').replace(',', '.');
  if (oczyszczony === '') return 0;
  const n = Number(oczyszczony);
  return Number.isFinite(n) ? n : 0;
}

function rokZDaty(data: string | undefined): number {
  if (!data) return 0;
  const rok = Number(String(data).slice(0, 4));
  return Number.isFinite(rok) ? rok : 0;
}

/**
 * Tickery kupowane na wiecej niz jednym rachunku maklerskim.
 *
 * Silnik nie zwraca rachunku przy wierszu FIFO, wiec interfejs przypisuje go po
 * tickerze - a slownik ponizej zapamietuje pierwszy napotkany rachunek. Gdy ten
 * sam papier lezy na rachunku polskim i zagranicznym, przypisanie jest zgadywane
 * i nie wolno na nim oprzec podzialu na poz. 20-21 (PIT-8C) i 22-23.
 */
export function tickeryNaWieluRachunkach(transactions: Transaction[]): Set<string> {
  const rachunkiTickera = new Map<string, Set<string>>();
  for (const tx of transactions) {
    if (!tx.ticker || !tx.accountId) continue;
    const rachunki = rachunkiTickera.get(tx.ticker) ?? new Set<string>();
    rachunki.add(tx.accountId);
    rachunkiTickera.set(tx.ticker, rachunki);
  }
  const niejednoznaczne = new Set<string>();
  for (const [ticker, rachunki] of rachunkiTickera) {
    if (rachunki.size > 1) niejednoznaczne.add(ticker);
  }
  return niejednoznaczne;
}

/** Slownik ticker -> nazwa, kategoria i rachunek z transakcji uzytkownika. */
function opisyInstrumentow(transactions: Transaction[]) {
  const opisy = new Map<string, { name: string; category: AssetCategory; accountId: string; currency: CurrencyCode }>();
  for (const tx of transactions) {
    if (!tx.ticker || opisy.has(tx.ticker)) continue;
    opisy.set(tx.ticker, {
      name: tx.name || tx.ticker,
      category: tx.category,
      accountId: tx.accountId,
      currency: tx.currency,
    });
  }
  return opisy;
}

/**
 * Transakcje uzytkownika po kluczu ticker|data|strona. Silnik nie zwraca ceny
 * w walucie ani prowizji per wiersz FIFO, wiec te dwie wartosci bierzemy
 * z wpisu, ktory sam wyslalismy do silnika.
 */
interface ZbiorczaTransakcja {
  /** Srednia cena wazona wolumenem - silnik podaje tylko date, nie godzine. */
  pricePerUnit: number;
  currency: CurrencyCode;
  quantity: number;
  commission: number;
}

function indeksTransakcji(transactions: Transaction[]) {
  // Klucz to ticker, data i strona. Kilka transakcji tego samego waloru w jednym
  // dniu to normalna sytuacja, a wiersz FIFO z silnika niesie sama date - wiec
  // zamiast wybierac jedna z nich (poprzednia wersja brala ostatnia i mieszala
  // ilosci z prowizjami), skladamy z nich jeden zbiorczy wpis.
  const grupy = new Map<string, Transaction[]>();
  for (const tx of transactions) {
    const klucz = `${tx.ticker}|${tx.date.slice(0, 10)}|${tx.type}`;
    const grupa = grupy.get(klucz);
    if (grupa) {
      grupa.push(tx);
    } else {
      grupy.set(klucz, [tx]);
    }
  }

  const indeks = new Map<string, ZbiorczaTransakcja>();
  for (const [klucz, grupa] of grupy) {
    const ilosc = grupa.reduce((suma, tx) => suma + (tx.quantity || 0), 0);
    const wartosc = grupa.reduce((suma, tx) => suma + (tx.quantity || 0) * (tx.pricePerUnit || 0), 0);
    indeks.set(klucz, {
      pricePerUnit: ilosc > 0 ? wartosc / ilosc : grupa[0].pricePerUnit,
      currency: grupa[0].currency,
      quantity: ilosc,
      commission: grupa.reduce((suma, tx) => suma + (tx.commission || 0), 0),
    });
  }
  return indeks;
}

/**
 * Rozbicie sprzedazy na partie FIFO. Silnik zwraca jeden wiersz na pare
 * sprzedaz-zakup, wiec wiersze tej samej sprzedazy trzeba scalic.
 */
export function mapRealizedGains(response: WynikSilnika, transactions: Transaction[]): TaxRealizedGain[] {
  const wiersze = response.fifo_rows ?? [];
  const opisy = opisyInstrumentow(transactions);
  const wpisy = indeksTransakcji(transactions);
  const transakcjePoId = indeksTransakcjiPoId(transactions);
  const rachunkiSprzedazyPoTickerze = new Map<string, Set<string>>();
  for (const tx of transactions) {
    if (tx.type !== 'SELL' || !tx.accountId) continue;
    const rachunki = rachunkiSprzedazyPoTickerze.get(tx.ticker) ?? new Set<string>();
    rachunki.add(tx.accountId);
    rachunkiSprzedazyPoTickerze.set(tx.ticker, rachunki);
  }
  const poSprzedazy = new Map<string, TaxRealizedGain>();

  for (const wiersz of wiersze) {
    // Silnik dolacza tez wiersze z lat wczesniejszych, oznaczone in_filing_year.
    // Rejestr FIFO i podsumowanie danego roku musza brac tylko jego wiersze,
    // inaczej sprzedaz z poprzedniego roku pojawialaby sie w biezacym.
    if (wiersz.in_filing_year === false) {
      continue;
    }
    const idSprzedazy = wiersz.sell_trade_id || wiersz.row_id || '';
    const ticker = wiersz.symbol || 'UNKNOWN';
    const opis = opisy.get(ticker);
    const sprzedazPoId = transakcjePoId.get(idSprzedazy);
    const rachunkiTickera = rachunkiSprzedazyPoTickerze.get(ticker);
    const accountId = sprzedazPoId?.accountId
      ?? (rachunkiTickera?.size === 1 ? [...rachunkiTickera][0] : '');
    const ilosc = safeNum(wiersz.quantity);
    const kosztPln = safeNum(wiersz.cost_pln);
    const prowizjaSprzedazyPln = safeNum(wiersz.sell_commission_alloc_pln);

    let zysk = poSprzedazy.get(idSprzedazy);
    if (!zysk) {
      zysk = {
        id: idSprzedazy,
        sellTransactionId: idSprzedazy,
        ticker,
        name: opis?.name ?? ticker,
        category: opis?.category ?? 'STOCK_FOREIGN',
        accountId,
        sellDate: (wiersz.sell_tax_date || '').slice(0, 10),
        sellQuantity: 0,
        // Cena, waluta i kurs pochodza z wiersza silnika. Wczesniej staly tu
        // zera i waluta zgadywana z lokalnego rejestru, ktory dla danych z
        // wyciagu brokera jest pusty - zalacznik do deklaracji wychodzil wiec
        // z cena 0, kursem 0 i zlotowka przy papierze w dolarach.
        sellPricePerUnit: safeNum(wiersz.sell_price),
        sellCurrency: (wiersz.sell_currency || opis?.currency || 'PLN') as TaxRealizedGain['sellCurrency'],
        sellCommission: 0,
        sellCommissionPLN: 0,
        sellExchangeRate: safeNum(wiersz.sell_fx_rate),
        sellExchangeDate: (wiersz.sell_fx_date || '').slice(0, 10),
        sellExchangeTable: 'A',
        revenuePLN: 0,
        costPLN: 0,
        profitPLN: 0,
        taxYear: wiersz.tax_year || rokZDaty(wiersz.sell_tax_date),
        matchedBuyLots: [],
      };
      poSprzedazy.set(idSprzedazy, zysk);
    } else if (!zysk.accountId && accountId) {
      zysk.accountId = accountId;
    }

    const sprzedaz = wpisy.get(`${ticker}|${(wiersz.sell_tax_date || '').slice(0, 10)}|SELL`);
    if (sprzedaz) {
      // Cena i waluta z wiersza silnika maja pierwszenstwo przed srednia dzienna.
      if (safeNum(wiersz.sell_price) === 0) zysk.sellPricePerUnit = sprzedaz.pricePerUnit;
      if (!wiersz.sell_currency) zysk.sellCurrency = sprzedaz.currency;
      zysk.sellCommission = sprzedaz.commission;
      // Kurs uzyty przez silnik: przychod brutto w PLN podzielony przez wartosc
      // sprzedazy w walucie. Prowizja nie wchodzi w brutto, wiec wynik jest scisly.
      const wartoscWWalucie = ilosc * sprzedaz.pricePerUnit;
      // Kurs podany przez silnik ma pierwszenstwo - odtwarzamy go tylko wtedy,
      // gdy wiersz go nie niesie.
      if (wartoscWWalucie > 0 && safeNum(wiersz.sell_fx_rate) === 0) {
        zysk.sellExchangeRate = safeNum(wiersz.gross_revenue_pln) / wartoscWWalucie;
      }
    }

    zysk.sellQuantity += ilosc;
    zysk.revenuePLN += safeNum(wiersz.gross_revenue_pln);
    zysk.costPLN += kosztPln + prowizjaSprzedazyPln;
    zysk.profitPLN += safeNum(wiersz.pnl_pln);
    zysk.sellCommissionPLN += prowizjaSprzedazyPln;
    const dataZakupu = (wiersz.buy_tax_date || '').slice(0, 10);
    const zakup = wpisy.get(`${ticker}|${dataZakupu}|BUY`);
    const udzialProwizji =
      zakup && zakup.quantity > 0 ? (ilosc / zakup.quantity) * (zakup.commission || 0) : 0;
    // Koszt w PLN = (ilosc x cena + udzial prowizji) x kurs, wiec kurs odtwarzamy
    // dzielac koszt przez wartosc w walucie razem z prowizja.
    const podstawaWWalucie = zakup ? ilosc * zakup.pricePerUnit + udzialProwizji : 0;
    const kursZakupu = podstawaWWalucie > 0 ? kosztPln / podstawaWWalucie : 0;

    zysk.matchedBuyLots.push({
      buyTransactionId: wiersz.buy_trade_id || '',
      buyDate: dataZakupu,
      buyQuantity: ilosc,
      buyPricePerUnit: zakup ? zakup.pricePerUnit : ilosc > 0 ? kosztPln / ilosc : 0,
      buyCurrency: zakup?.currency ?? opis?.currency ?? 'PLN',
      buyCommissionShare: udzialProwizji,
      buyExchangeRate: kursZakupu,
      buyExchangeDate: (wiersz.buy_fx_date || '').slice(0, 10),
      buyExchangeTable: 'A',
      buyCostPLN: kosztPln - udzialProwizji * kursZakupu,
      buyCommissionPLN: udzialProwizji * kursZakupu,
      totalCostPLN: kosztPln,
    });
  }

  return [...poSprzedazy.values()].sort((a, b) => a.sellDate.localeCompare(b.sellDate));
}

/** Nazwa rachunku dywidendy do tabeli; rachunek nieustalony nie udaje rachunku "Główne". */
export function etykietaRachunkuDywidendy(accountId: string, accounts: readonly BrokerAccount[]): string {
  if (accountId === RACHUNEK_NIEUSTALONY) return 'Rachunek nieustalony';
  return accounts.find((a) => a.id === accountId)?.name || 'Główne';
}

/** Zestawienie dywidend z podatkiem u zrodla dopasowanym przez silnik. */
export function mapDividends(response: WynikSilnika, transactions: Transaction[]): DividendTaxItem[] {
  const opisy = opisyInstrumentow(transactions);
  const transakcjePoId = indeksTransakcjiPoId(transactions);
  const tickeryWieluRachunkow = tickeryNaWieluRachunkach(transactions);
  return (response.dividends_view ?? []).map((wiersz, index) => {
    const ticker = wiersz.symbol || '';
    const opis = opisy.get(ticker);
    // Rachunek: z wiersza silnika, potem z transakcji o tym samym event_id. Bez tego ticker
    // na jednym rachunku daje ten rachunek, a na kilku - nieustalony (nie pierwszy napotkany).
    const rachunek = wiersz.account_id || wiersz.accountId || wiersz.account
      || (wiersz.event_id ? transakcjePoId.get(wiersz.event_id)?.accountId : undefined)
      || (tickeryWieluRachunkow.has(ticker) ? RACHUNEK_NIEUSTALONY : opis?.accountId)
      || '';
    const bruttoPln = safeNum(wiersz.gross_dividend_pln);
    const bruttoWaluta = safeNum(wiersz.gross_dividend_foreign);
    const podatekZagranicznyPln = safeNum(wiersz.withholding_tax_pln);
    const podatekZagranicznyWaluta = safeNum(wiersz.withholding_tax_foreign);
    const podatekPolski = Number.isFinite(Number(wiersz.polish_tax_due_pln)) ? safeNum(wiersz.polish_tax_due_pln) : undefined;
    return {
      id: wiersz.event_id || `dywidenda-${index}`,
      transactionId: wiersz.event_id || `dywidenda-${index}`,
      ticker,
      name: opis?.name ?? ticker,
      accountId: rachunek,
      date: (wiersz.date || '').slice(0, 10),
      grossAmount: bruttoWaluta,
      currency: (wiersz.currency || 'PLN') as CurrencyCode,
      exchangeRate: bruttoWaluta > 0 ? bruttoPln / bruttoWaluta : 0,
      exchangeDate: '',
      exchangeTable: 'A',
      grossPLN: bruttoPln,
      foreignTaxRate: bruttoWaluta > 0 ? (podatekZagranicznyWaluta / bruttoWaluta) * 100 : 0,
      foreignTaxPLN: podatekZagranicznyPln,
      polishTaxDuePLN: podatekPolski,
      taxToPayInPolandPLN: Number.isFinite(Number(wiersz.tax_to_pay_pln)) ? safeNum(wiersz.tax_to_pay_pln) : undefined,
      taxYear: rokZDaty(wiersz.date),
    };
  });
}

/**
 * Pozycje z otwartych partii FIFO silnika. Partia bez waluty nabycia (akcje
 * przyznane) nie dostaje zgadywanej waluty - pozycja jest pomijana w tabeli
 * z kosztem, a jej ilosc i tak wyjdzie w zestawieniu z rachunkiem brokera.
 */
function pozycjeZOtwartychPartii(partie: SilnikOtwartaPartia[], transactions: Transaction[]): OpenPosition[] {
  const opisy = opisyInstrumentow(transactions);
  const pozycje = new Map<string, OpenPosition>();
  const transakcjePoId = indeksTransakcjiPoId(transactions);
  for (const partia of partie) {
    const swiat = (partia.logical_world || '').toLowerCase();
    if (swiat === 'private_cash_fx' || swiat === 'diagnostic_only') continue;
    const ticker = (partia.symbol || '').trim();
    const pozostalo = safeNum(partia.quantity_remaining);
    const waluta = (partia.currency || opisy.get(ticker)?.currency || '').toUpperCase();
    if (!ticker || pozostalo <= 0 || !/^[A-Z]{3}$/.test(waluta)) continue;
    const opis = opisy.get(ticker);
    // Rachunek wynika z transakcji, która utworzyła partię, lub z pola silnika.
    const idTransakcjiNabycia = partia.origin_trade_id || partia.buy_trade_id || '';
    const rachunek = rachunekPartii(partia.account_id || partia.accountId || partia.account, idTransakcjiNabycia, transakcjePoId);
    const kosztPozostalej = safeNum(partia.cost_remaining_pln);
    const transakcjaNabycia = transakcjePoId.get(idTransakcjiNabycia);
    const prowizjaPozostalej = transakcjaNabycia && transakcjaNabycia.quantity > 0
      ? (transakcjaNabycia.commission * pozostalo) / transakcjaNabycia.quantity
      : undefined;

    const kluczPozycji = `${ticker}|${rachunek}`;
    let pozycja = pozycje.get(kluczPozycji);
    if (!pozycja) {
      pozycja = {
        ticker,
        name: opis?.name ?? ticker,
        category: opis?.category ?? (waluta === 'PLN' ? 'STOCK_PL' : 'STOCK_FOREIGN'),
        currency: waluta as CurrencyCode,
        totalQuantity: 0,
        avgBuyPrice: 0,
        avgBuyPricePLN: 0,
        totalCostPLN: 0,
        openLotsCount: 0,
        lots: [],
        accountIds: [],
      };
      pozycje.set(kluczPozycji, pozycja);
    }
    pozycja.totalQuantity += pozostalo;
    pozycja.totalCostPLN += kosztPozostalej;
    pozycja.openLotsCount += 1;
    pozycja.lots.push({
      buyTransactionId: idTransakcjiNabycia || partia.lot_id || '',
      buyDate: (partia.open_date || '').slice(0, 10),
      remainingQty: pozostalo,
      initialQty: safeNum(partia.quantity_open),
      pricePerUnit: safeNum(partia.price),
      currency: waluta as CurrencyCode,
      exchangeRate: 0,
      exchangeDate: '',
      exchangeTable: 'A',
      costPLN: kosztPozostalej,
      commissionPLN: 0,
      commissionOrig: prowizjaPozostalej,
      commissionCurrency: transakcjaNabycia?.commissionCurrency,
      accountId: rachunek,
    });
    if (!pozycja.accountIds.includes(rachunek)) {
      pozycja.accountIds.push(rachunek);
    }
  }
  for (const pozycja of pozycje.values()) {
    pozycja.avgBuyPricePLN = pozycja.totalQuantity > 0 ? pozycja.totalCostPLN / pozycja.totalQuantity : 0;
    const wartoscWWalucie = pozycja.lots.reduce((suma, lot) => suma + lot.pricePerUnit * lot.remainingQty, 0);
    pozycja.avgBuyPrice = pozycja.totalQuantity > 0 ? wartoscWWalucie / pozycja.totalQuantity : 0;
  }
  return [...pozycje.values()].sort((a, b) => b.totalCostPLN - a.totalCostPLN);
}

/**
 * Pozycje otwarte liczone z danych samego silnika: kazdy zakup pomniejszony
 * o ilosci, ktore FIFO silnika juz zamknelo. Nie powtarzamy tu dopasowania
 * FIFO - czytamy jego wynik.
 */
export function mapOpenPositions(response: WynikSilnika, transactions: Transaction[]): OpenPosition[] {
  if (Array.isArray(response.open_lots)) {
    return pozycjeZOtwartychPartii(response.open_lots, transactions);
  }
  // Starszy silnik (np. niezaktualizowany sidecar desktopu) nie zwraca
  // `open_lots`. Odtworzenie z wierszy historii widzi tylko rok rozliczenia.
  const zuzyte = new Map<string, number>();
  for (const wiersz of response.fifo_rows ?? []) {
    const id = wiersz.buy_trade_id || '';
    zuzyte.set(id, (zuzyte.get(id) ?? 0) + safeNum(wiersz.quantity));
  }

  const opisy = opisyInstrumentow(transactions);
  const pozycje = new Map<string, OpenPosition>();
  const transakcjePoId = indeksTransakcjiPoId(transactions);

  for (const wiersz of response.transaction_history_rows ?? []) {
    if ((wiersz.row_kind || '').toUpperCase() !== 'TRADE') continue;
    if ((wiersz.side || '').toUpperCase() !== 'BUY') continue;
    // Przewalutowanie to nie jest pozycja w portfelu. Silnik oznacza je
    // swiatem `private_cash_fx` (classify.py:75), a mimo to wiersze PLN/USD
    // i EUR/USD wchodzily tu jako "Akcje Zagraniczne" z domyslnej kategorii:
    // w tabeli aktywow stalo 48 460 sztuk PLN/USD po 0,27 USD obok prawdziwych
    // akcji. `diagnostic_only` to operacje repo - te same wzgledy.
    const swiat = (wiersz.logical_world || '').toLowerCase();
    if (swiat === 'private_cash_fx' || swiat === 'diagnostic_only') continue;
    // Zakup bez waluty nie moze wejsc do pozycji ze zgadywana zlotowka.
    if (!wiersz.currency) continue;

    const idTransakcji = wiersz.transaction_id || wiersz.base_record_id || wiersz.row_id || '';
    const kupione = safeNum(wiersz.quantity);
    const pozostalo = kupione - (zuzyte.get(idTransakcji) ?? 0);
    if (pozostalo <= 0) continue;

    const ticker = wiersz.ticker || 'UNKNOWN';
    const opis = opisy.get(ticker);
    const kosztCalosci = safeNum(wiersz.amount_pln);
    const kosztPozostalej = kupione > 0 ? (kosztCalosci * pozostalo) / kupione : 0;

    const rachunek = rachunekPartii(
      (wiersz as typeof wiersz & { account_id?: string; accountId?: string; account?: string }).account_id ||
        (wiersz as typeof wiersz & { accountId?: string; account?: string }).accountId ||
        (wiersz as typeof wiersz & { account?: string }).account,
      idTransakcji,
      transakcjePoId,
    );
    const transakcjaNabycia = transakcjePoId.get(idTransakcji);
    const prowizjaPozostalej = transakcjaNabycia && transakcjaNabycia.quantity > 0
      ? (transakcjaNabycia.commission * pozostalo) / transakcjaNabycia.quantity
      : undefined;
    const kluczPozycji = `${ticker}|${rachunek}`;
    let pozycja = pozycje.get(kluczPozycji);
    if (!pozycja) {
      pozycja = {
        ticker,
        name: opis?.name ?? ticker,
        category: opis?.category ?? 'STOCK_FOREIGN',
        currency: (wiersz.currency || opis?.currency || 'PLN') as CurrencyCode,
        totalQuantity: 0,
        avgBuyPrice: 0,
        avgBuyPricePLN: 0,
        totalCostPLN: 0,
        openLotsCount: 0,
        lots: [],
        accountIds: [],
      };
      pozycje.set(kluczPozycji, pozycja);
    }

    pozycja.totalQuantity += pozostalo;
    pozycja.totalCostPLN += kosztPozostalej;
    pozycja.openLotsCount += 1;
    pozycja.lots.push({
      buyTransactionId: idTransakcji,
      buyDate: (wiersz.display_date || '').slice(0, 10),
      remainingQty: pozostalo,
      initialQty: kupione,
      pricePerUnit: kupione > 0 ? safeNum(wiersz.amount) / kupione : 0,
      currency: (wiersz.currency || 'PLN') as CurrencyCode,
      exchangeRate: 0,
      exchangeDate: '',
      exchangeTable: 'A',
      costPLN: kosztPozostalej,
      commissionPLN: 0,
      commissionOrig: prowizjaPozostalej,
      commissionCurrency: transakcjaNabycia?.commissionCurrency,
      accountId: rachunek,
    });
    if (!pozycja.accountIds.includes(rachunek)) {
      pozycja.accountIds.push(rachunek);
    }
  }

  for (const pozycja of pozycje.values()) {
    pozycja.avgBuyPricePLN = pozycja.totalQuantity > 0 ? pozycja.totalCostPLN / pozycja.totalQuantity : 0;
    const wartoscWWalucie = pozycja.lots.reduce((suma, lot) => suma + lot.pricePerUnit * lot.remainingQty, 0);
    pozycja.avgBuyPrice = pozycja.totalQuantity > 0 ? wartoscWWalucie / pozycja.totalQuantity : 0;
  }

  return [...pozycje.values()].sort((a, b) => b.totalCostPLN - a.totalCostPLN);
}

/**
 * Podsumowania roczne. Dla roku liczonego przez silnik bierzemy jego kwoty
 * formularza; dla pozostalych lat sumujemy wiersze FIFO i dywidendy.
 */
/** Dane spoza wyniku silnika, potrzebne do wypelnienia pol deklaracji. */
export interface OpcjePodsumowan {
  /**
   * Tickery lezace na wiecej niz jednym rachunku. Dla nich przypisanie wiersza
   * FIFO do rachunku jest zgadywane, wiec podzial na poz. 20-21 i 22-23 nie
   * powstaje.
   */
  tickeryNiejednoznaczne?: ReadonlySet<string>;
  /** Kwoty przepisane z otrzymanych informacji PIT-8C (poz. 35 i 36). */
  informacjePit8c?: readonly WpisPit8c[];
}

export function mapYearSummaries(
  response: WynikSilnika,
  year: number,
  realizedGains: TaxRealizedGain[],
  dividends: DividendTaxItem[],
  accounts: BrokerAccount[],
  _opcje: OpcjePodsumowan = {},
): Map<number, TaxYearSummary> {
  const podsumowania = new Map<number, TaxYearSummary>();

  // Czesc E dotyczy wylacznie roku, ktory silnik wlasnie policzyl. Przy innych
  // latach pola krypto zostaja puste, bo zero byloby tu zgadywaniem.
  const czescESurowa = response.crypto_part_e ?? {};
  const rokCzesciE = Number(czescESurowa.tax_year ?? year);
  const czescE = {
    przychod: safeNum(czescESurowa.revenue_pln),
    koszty: safeNum(czescESurowa.total_costs_pln),
    // Formularz rozdziela koszty roku (poz. 37) od kosztow z lat ubieglych
    // (poz. 38). Suma obu stoi w poz. 37+38, ale sama suma nie wystarczy -
    // poz. 38 przepisuje sie z zeznania za rok poprzedni.
    // Brak pola w odpowiedzi zostaje pusty. Jawne zero zablokowaloby wyliczenie
    // poz. 37 z roznicy kosztow lacznych i kosztow z lat ubieglych, wiec caly
    // koszt roku wypadlby z deklaracji.
    kosztyRoku:
      czescESurowa.costs_current_year_pln !== undefined
        ? safeNum(czescESurowa.costs_current_year_pln)
        : undefined,
    kosztyZLatUbieglych:
      czescESurowa.costs_carried_in_pln !== undefined
        ? safeNum(czescESurowa.costs_carried_in_pln)
        : undefined,
    dochod: safeNum(czescESurowa.income_pln),
    doPrzeniesienia: safeNum(czescESurowa.costs_carried_out_pln),
    podatek: safeNum(czescESurowa.tax_19_pln),
    liczbaOperacji: Number(czescESurowa.trade_count ?? 0),
  };
  const maCzescE = czescE.liczbaOperacji > 0 || czescE.przychod > 0 || czescE.koszty > 0;

  const lata = new Set<number>();
  for (const zysk of realizedGains) if (zysk.taxYear) lata.add(zysk.taxYear);
  for (const dywidenda of dividends) if (dywidenda.taxYear) lata.add(dywidenda.taxYear);
  lata.add(year);
  // Silnik liczy jeden rok na przebieg, ale mowi, jakie lata widzi w danych.
  // Bez tego przelacznik roku pokazywal wylacznie rok wlasnie policzony
  // i nie dalo sie przejsc do rozliczenia za rok wczesniejszy.
  for (const wykryty of (response.tax_years_detected ?? []) as Array<number | string>) {
    const rokWykryty = Number(wykryty);
    if (Number.isInteger(rokWykryty) && rokWykryty > 1990) {
      lata.add(rokWykryty);
    }
  }

  const roczne = (response.annual_summary ?? {}) as Record<string, unknown>;
  const art30b = (response.art30b ?? {}) as Record<string, unknown>;
  const polaFormularza = response.tax_filing_package?.draft?.form_fields ?? [];
  const polaPodsumowania = (roczne.pit38_form_fields ?? {}) as Record<string, string>;
  const pole = (pozycja: string): number | undefined => {
    const wartosc = polaFormularza.find((p) => p.position === pozycja)?.value ?? polaPodsumowania[pozycja];
    if (wartosc === undefined || wartosc === null || wartosc === '') return undefined;
    const liczba = Number(wartosc);
    return Number.isFinite(liczba) ? liczba : undefined;
  };
  const rokSilnika = Number((roczne.tax_year as string) ?? year) || year;

  for (const rok of lata) {
    const zyskiRoku = realizedGains.filter((zysk) => zysk.taxYear === rok);
    const dywidendyRoku = dividends.filter((dywidenda) => dywidenda.taxYear === rok);
    const zSilnika = rok === rokSilnika;
    // Silnik liczy jeden rok na przebieg. Dla pozostalych lat interfejs sumowal
    // kiedys wiersze FIFO i sam mnozyl przez 19% - drugi algorytm obok silnika,
    // bez kosztow finansowania, strat z lat ubieglych i limitu z art. 30a.
    // Taki rok jest "nieobliczony": ekran pokazuje "—", a wybranie roku
    // uruchamia dla niego pelny przebieg.
    if (!zSilnika) {
      podsumowania.set(rok, pustePodsumowanieRoku(rok));
      continue;
    }

    // Do pol deklaracji ida kwoty z groszami z silnika (pit38_form_*),
    // a nie total_cost_pln. Roznica nie jest kosmetyczna: total_cost_pln liczy
    // sam koszt nabycia, natomiast pole 21 obejmuje takze koszty finansowania,
    // odsetki i oplaty. Przy poprzednim mapowaniu podatek nie zgadzal sie
    // z rachunkiem (przychod - koszty) x 19%.
    const przychod = zSilnika
      ? safeNum((art30b.pit38_form_revenue_pln ?? art30b.total_revenue_pln ?? roczne.total_revenue_pln ?? art30b.pit38_rounded_revenue_pln) as string)
      : zyskiRoku.reduce((suma, zysk) => suma + zysk.revenuePLN, 0);
    const koszty = zSilnika
      ? safeNum((art30b.pit38_form_cost_pln ?? art30b.total_cost_pln ?? roczne.total_cost_pln ?? art30b.pit38_rounded_cost_pln) as string)
      : zyskiRoku.reduce((suma, zysk) => suma + zysk.costPLN, 0);
    const roznica = przychod - koszty;
    // Dochod i strate (poz. 28/29) dla roku z silnika przepisujemy z jego pol.
    // Roznica zaokraglonych pol formularza potrafi odbiec o zlotowke (91 455
    // zamiast 91 454), a dwie kwoty dla tej samej pozycji to dwa rozliczenia.
    const dochodZSilnika = zSilnika ? (art30b.pit38_form_income_pln ?? roczne.pit38_form_income_pln) : undefined;
    const strataZSilnika = zSilnika ? (art30b.pit38_form_loss_pln ?? roczne.pit38_form_loss_pln) : undefined;
    const maDochodZSilnika =
      dochodZSilnika !== undefined && dochodZSilnika !== null && dochodZSilnika !== '' &&
      strataZSilnika !== undefined && strataZSilnika !== null && strataZSilnika !== '';
    const dochod = maDochodZSilnika ? safeNum(dochodZSilnika as string) : Math.max(0, roznica);
    const strata = maDochodZSilnika ? safeNum(strataZSilnika as string) : Math.max(0, -roznica);
    const podatek = zSilnika
      ? pole('35') ?? safeNum((art30b.pit38_form_tax_due_pln ?? roczne.pit38_form_tax_due_pln ?? art30b.tax_19_pln ?? roczne.tax_19_pln) as string)
      : Math.round(Math.max(0, roznica) * 0.19);

    // Poz. 30: strata z lat ubieglych faktycznie odliczona przez silnik.
    // Bez niej podstawa opodatkowania w poz. 31 nie wychodzi z roznicy
    // poz. 28 - poz. 30 i deklaracja sie nie domyka.
    const stratyOdliczone = zSilnika
      ? safeNum(art30b.prior_year_loss_used_pln as string) ||
        safeNum(roczne.prior_year_loss_used_pln as string)
      : 0;

    const przychodFormularza = pole('26') ?? przychod;
    const kosztyFormularza = pole('27') ?? koszty;
    const dochodFormularza = pole('28') ?? dochod;
    const strataFormularza = pole('29') ?? strata;
    const odliczonaStrataFormularza = pole('30') ?? stratyOdliczone;
    const podstawaFormularza = pole('31') ?? safeNum((art30b.pit38_form_base_pln ?? roczne.pit38_form_base_pln ?? art30b.pit38_income) as string);
    const podatekPrzedOdliczeniem = pole('33') ?? safeNum((art30b.pit38_form_tax_pln ?? roczne.pit38_form_tax_pln ?? art30b.tax_19_pln) as string);
    const podatekFormularza = pole('35') ?? podatek;
    const pit8cZSilnika = art30b.pit8c_source === 'informacja' || art30b.pit8c_source === 'transakcje';
    const tylkoRachunkiBezPit8c = accounts.length > 0 && accounts.every((konto) => !wystawiaPit8c(konto.brokerType));

    // Dywidendy: kwoty bierzemy z silnika (sekcja art30a), bo tylko on stosuje
    // limit stawki umownej z art. 30a ust. 9. Interfejs odejmowal wczesniej
    // CALY podatek pobrany za granica, wiec przy 30% potraconych w USA bez
    // formularza W-8BEN wychodzila kwota nizsza niz nalezna.
    const art30a = (response.art30a ?? {}) as Record<string, unknown>;
    const zSilnikaDywidendy = zSilnika && Object.keys(art30a).length > 0;

    const dywidendyBrutto = zSilnikaDywidendy
      ? safeNum(art30a.gross_dividends_pln as string)
      : dywidendyRoku.reduce((suma, d) => suma + d.grossPLN, 0);
    const dywidendyPodatekZagraniczny = zSilnikaDywidendy
      ? safeNum(art30a.foreign_withholding_tax_pln as string)
      : dywidendyRoku.reduce((suma, d) => suma + d.foreignTaxPLN, 0);
    const dywidendyPodatekPolski = zSilnikaDywidendy
      ? safeNum(art30a.polish_tax_19_pln as string)
      : dywidendyBrutto * 0.19;
    const dywidendyDoZaplaty = zSilnikaDywidendy
      ? safeNum(art30a.gross_credit_interest_pln as string) > 0
        ? safeNum(art30a.tax_to_pay_pln as string)
        : pole('49') ?? safeNum(art30a.tax_to_pay_pln as string)
      : Math.max(0, Math.round(dywidendyPodatekPolski - dywidendyPodatekZagraniczny));

    // Sprzedaż przypisujemy po ID transakcji; niejednoznaczny brak ID pozostaje
    // bez rachunku, chyba że ticker w sprzedażach występuje tylko na jednym.
    const rozbicie: TaxYearSummary['brokerBreakdowns'] = accounts
      .map((konto) => {
        const zyskiKonta = zyskiRoku.filter((zysk) => zysk.accountId === konto.id);
        const przychodKonta = zyskiKonta.reduce((suma, zysk) => suma + zysk.revenuePLN, 0);
        const kosztyKonta = zyskiKonta.reduce((suma, zysk) => suma + zysk.costPLN, 0);
        const roznicaKonta = przychodKonta - kosztyKonta;
        return {
          accountId: konto.id,
          accountName: konto.name,
          brokerType: konto.brokerType,
          revenuePLN: przychodKonta,
          costsPLN: kosztyKonta,
          incomePLN: Math.max(0, roznicaKonta),
          lossPLN: Math.max(0, -roznicaKonta),
        };
      })
      .filter((pozycja) => pozycja.revenuePLN > 0 || pozycja.costsPLN > 0);
    // Reszta przychodu i kosztu roku, ktorej nie da sie przypisac do rachunku
    // (sprzedaz bez ID, koszt spoza wierszy FIFO) - bez niej suma rozbicia nie
    // zgadzalaby sie z rokiem.
    const kosztyPrzypisane = rozbicie.reduce((suma, pozycja) => suma + pozycja.costsPLN, 0);
    const przychodPrzypisany = rozbicie.reduce((suma, pozycja) => suma + pozycja.revenuePLN, 0);
    const kosztyNieprzypisane = Math.max(0, kosztyFormularza - kosztyPrzypisane);
    const przychodNieprzypisany = Math.max(0, przychodFormularza - przychodPrzypisany);
    if (kosztyNieprzypisane > 0.005 || przychodNieprzypisany > 0.005) {
      const wynikNieprzypisany = przychodNieprzypisany - kosztyNieprzypisane;
      rozbicie.push({
        accountId: 'unassigned',
        accountName: 'Nieprzypisane do rachunku',
        brokerType: 'UNASSIGNED',
        revenuePLN: przychodNieprzypisany,
        costsPLN: kosztyNieprzypisane,
        incomePLN: Math.max(0, wynikNieprzypisany),
        lossPLN: Math.max(0, -wynikNieprzypisany),
      });
    }

    podsumowania.set(rok, {
      year: rok,
      revenuePLN: przychodFormularza,
      costsPLN: kosztyFormularza,
      incomePLN: dochodFormularza,
      lossPLN: strataFormularza,
      taxDuePLN: podatekFormularza,
      taxBeforeCreditPLN: podatekPrzedOdliczeniem,
      taxBasePLN: podstawaFormularza,
      priorYearLossUsedPLN: odliczonaStrataFormularza,
      pit8cRevenuePLN: pole('20') ?? (pit8cZSilnika ? safeNum(art30b.pit8c_revenue_pln as string) : tylkoRachunkiBezPit8c ? 0 : undefined),
      pit8cCostsPLN: pole('21') ?? (pit8cZSilnika ? safeNum(art30b.pit8c_cost_pln as string) : tylkoRachunkiBezPit8c ? 0 : undefined),
      pit8cZrodlo: pit8cZSilnika ? (art30b.pit8c_source as 'informacja' | 'transakcje') : tylkoRachunkiBezPit8c ? 'transakcje' : undefined,
      pit8cWyliczonyPrzychodPLN: pit8cZSilnika ? safeNum(art30b.pit8c_calculated_revenue_pln as string) : tylkoRachunkiBezPit8c ? 0 : undefined,
      pit8cWyliczoneKosztyPLN: pit8cZSilnika ? safeNum(art30b.pit8c_calculated_cost_pln as string) : tylkoRachunkiBezPit8c ? 0 : undefined,
      foreignRevenuePLN: pole('22') ?? (tylkoRachunkiBezPit8c ? przychod : undefined),
      foreignCostsPLN: pole('23') ?? (tylkoRachunkiBezPit8c ? koszty : undefined),
      // Czesc E formularza liczy silnik (tax/crypto_engine.py): koszt w roku
      // poniesienia, bez kolejki FIFO, z pominieciem wymian krypto na krypto.
      // Wypelniamy tylko rok, ktorego dotyczy przebieg - dla pozostalych lat
      // silnik nie liczyl czesci E i zero bylo tu wymyslone.
      cryptoRevenuePLN: rok === rokCzesciE && maCzescE ? czescE.przychod : undefined,
      cryptoCostsPLN: rok === rokCzesciE && maCzescE ? czescE.koszty : undefined,
      cryptoCostsCurrentYearPLN: rok === rokCzesciE && maCzescE ? czescE.kosztyRoku : undefined,
      cryptoCostsCarriedInPLN: rok === rokCzesciE && maCzescE ? czescE.kosztyZLatUbieglych : undefined,
      cryptoIncomePLN: rok === rokCzesciE && maCzescE ? czescE.dochod : undefined,
      cryptoLossPLN: rok === rokCzesciE && maCzescE ? czescE.doPrzeniesienia : undefined,
      cryptoTaxDuePLN: rok === rokCzesciE && maCzescE ? czescE.podatek : undefined,
      dividendGrossPLN: dywidendyBrutto,
      dividendForeignTaxPLN: dywidendyPodatekZagraniczny,
      dividendCreditUsedPLN: pole('48') ?? safeNum(art30a.credit_used_pln as string),
      dividendPolishTaxDuePLN: dywidendyPodatekPolski,
      dividendTaxToPayPLN: dywidendyDoZaplaty,
      totalTaxToPayPLN: pole('51') ?? safeNum(roczne.pit38_form_total_tax_to_pay_pln as string),
      formTaxToPayPLN: pole('51') ?? (roczne.pit38_form_total_tax_to_pay_pln !== undefined ? safeNum(roczne.pit38_form_total_tax_to_pay_pln as string) : undefined),
      transactionCount: zyskiRoku.length + dywidendyRoku.length,
      brokerBreakdowns: rozbicie,
    });
    if (polaFormularza.length > 0 || Object.keys(polaPodsumowania).length > 0) {
      const summary = podsumowania.get(rok) as TaxYearSummary & { engineFormFields?: Record<string, number> };
      summary.engineFormFields = {
        ...Object.fromEntries(Object.entries(polaPodsumowania)
          .map(([position, value]) => [position, Number(value)] as const)
          .filter(([, value]) => Number.isFinite(value))),
        ...Object.fromEntries(polaFormularza
          .map((field) => [field.position, Number(field.value)] as const)
          .filter(([, value]) => Number.isFinite(value))),
      };
    }
    // Zalacznik PIT/ZG z silnika (panstwo z ISIN, ta sama funkcja co poz. 34).
    // Eksport XML zgadywal je z sufiksu tickera albo waluty.
    const wierszeZg = roczne.pit_zg_rows;
    if (Array.isArray(wierszeZg)) {
      const summary = podsumowania.get(rok) as TaxYearSummary;
      summary.pitZgRows = wierszeZg
        .filter((wiersz): wiersz is Record<string, unknown> => Boolean(wiersz) && typeof wiersz === 'object')
        .map((wiersz) => ({
          country: String(wiersz.country ?? ''),
          incomePLN: safeNum(wiersz.income_pln as string),
          foreignTaxPLN: safeNum(wiersz.foreign_tax_pln as string),
        }));
    }
  }

  return podsumowania;
}

/**
 * Puste podsumowanie roku, ktorego silnik jeszcze nie liczyl.
 *
 * Silnik rozlicza jeden rok na przebieg i zaweza dane do jego horyzontu, wiec
 * lista lat potrafila sie kurczyc: po przejsciu na rok wczesniejszy nowsze
 * znikaly z przelacznika i nie dalo sie do nich wrocic. Interfejs pamieta
 * napotkane lata i dla tych jeszcze nieprzeliczonych pokazuje ten wpis;
 * wybranie roku uruchamia dla niego pelny przebieg.
 */
export function pustePodsumowanieRoku(rok: number): TaxYearSummary {
  return {
    year: rok,
    nieobliczony: true,
    revenuePLN: 0,
    costsPLN: 0,
    incomePLN: 0,
    lossPLN: 0,
    taxDuePLN: 0,
    dividendGrossPLN: 0,
    dividendForeignTaxPLN: 0,
    dividendPolishTaxDuePLN: 0,
    dividendTaxToPayPLN: 0,
    totalTaxToPayPLN: 0,
    transactionCount: 0,
    brokerBreakdowns: [],
  };
}

// ---------------------------------------------------------------------------
// 5. Główna funkcja bridge'a
// ---------------------------------------------------------------------------

function liczbaLubNull(wartosc: string | number | null | undefined): number | null {
  if (wartosc === null || wartosc === undefined || wartosc === '') return null;
  const liczba = typeof wartosc === 'number' ? wartosc : Number(String(wartosc).replace(/\s/g, '').replace(',', '.'));
  return Number.isFinite(liczba) ? liczba : null;
}

function kategoriaZWiersza(swiat: string, waluta: string): AssetCategory {
  // Silnik nie zwraca kategorii portfelowej. To etykieta do filtrowania listy,
  // nie element rachunku: podatek liczy silnik po wlasnej klasyfikacji.
  if (swiat.includes('crypto')) return 'CRYPTO';
  return waluta === 'PLN' ? 'STOCK_PL' : 'STOCK_FOREIGN';
}

/**
 * Transakcje do zakladki "Transakcje" prosto z przebiegu silnika.
 *
 * Bierzemy wiersze, ktore silnik zaliczyl do rozliczenia papierow i krypto:
 * kupna, sprzedaze i dywidendy. Przewalutowania (`private_cash_fx`) i wiersze
 * diagnostyczne nie sa transakcjami portfela. Wiersz bez ilosci, kwoty albo
 * waluty zostaje pominiety i policzony - nie dostaje zera ani "USD".
 */
export function transakcjeZWynikuSilnika(
  response: Pick<TaxEngineResponse, 'transaction_history_rows'>,
  lokalne: readonly Transaction[] = [],
): { transakcje: Transaction[]; pominieteBezDanych: number } {
  const wiersze = response.transaction_history_rows ?? [];
  const lokalneWgId = new Map(lokalne.map((tx) => [`${PRZEDROSTEK_REKORDU_PORTFELA}${tx.id}`, tx]));

  const prowizje = new Map<string, { kwota: number; waluta: string }>();
  const podatkiUZrodla = new Map<string, number>();
  for (const wiersz of wiersze) {
    const rodzaj = (wiersz.row_kind || '').toUpperCase();
    const kwota = liczbaLubNull(wiersz.amount);
    if (kwota === null || !wiersz.currency) continue;
    if (rodzaj === 'TRADE_FEE' && wiersz.parent_row_id) {
      const dotad = prowizje.get(wiersz.parent_row_id);
      if (!dotad) {
        prowizje.set(wiersz.parent_row_id, { kwota: Math.abs(kwota), waluta: wiersz.currency });
      } else if (dotad.waluta === wiersz.currency) {
        dotad.kwota += Math.abs(kwota);
      }
    }
    if (rodzaj === 'TAX' && wiersz.ticker) {
      const klucz = `${wiersz.ticker}|${(wiersz.display_date || '').slice(0, 10)}|${wiersz.currency}`;
      podatkiUZrodla.set(klucz, (podatkiUZrodla.get(klucz) ?? 0) + Math.abs(kwota));
    }
  }

  const transakcje: Transaction[] = [];
  let pominieteBezDanych = 0;
  for (const wiersz of wiersze) {
    const rodzaj = (wiersz.row_kind || '').toUpperCase();
    const swiat = (wiersz.logical_world || '').toLowerCase();
    if (swiat === 'private_cash_fx' || swiat === 'diagnostic_only') continue;
    const strona = (wiersz.side || '').toUpperCase();
    const toTransakcja = rodzaj === 'TRADE' && (strona === 'BUY' || strona === 'SELL');
    const toDywidenda = rodzaj === 'DIVIDEND';
    if (!toTransakcja && !toDywidenda) continue;

    const data = (wiersz.display_date || '').trim();
    const waluta = (wiersz.currency || '').toUpperCase();
    const kwota = liczbaLubNull(wiersz.amount);
    const ticker = (wiersz.ticker || '').trim();
    if (!ticker || !/^\d{4}-\d{2}-\d{2}/.test(data) || !/^[A-Z]{3}$/.test(waluta) || kwota === null) {
      pominieteBezDanych += 1;
      continue;
    }
    const idRekordu = String(wiersz.manual_record_id || wiersz.transaction_id || wiersz.row_id);
    const lokalna = lokalneWgId.get(idRekordu);

    if (toTransakcja) {
      const ilosc = liczbaLubNull(wiersz.quantity);
      if (ilosc === null || ilosc <= 0) {
        pominieteBezDanych += 1;
        continue;
      }
      const prowizja = prowizje.get(wiersz.row_id);
      const prowizjaZeSzczegolow = liczbaLubNull(wiersz.details?.commission as string | number | null | undefined);
      const walutaProwizji =
        prowizja?.waluta ||
        (typeof wiersz.details?.commission_currency === 'string' ? wiersz.details.commission_currency : '') ||
        waluta;
      transakcje.push({
        id: lokalna ? lokalna.id : `silnik:${wiersz.row_id}`,
        accountId: lokalna ? lokalna.accountId : KONTO_MAGAZYNU_SILNIKA,
        ticker,
        name: lokalna?.name || ticker,
        category: lokalna?.category ?? kategoriaZWiersza(swiat, waluta),
        type: strona as 'BUY' | 'SELL',
        date: data.replace(' ', 'T'),
        quantity: ilosc,
        pricePerUnit: Math.abs(kwota) / ilosc,
        currency: waluta as CurrencyCode,
        // Brak wiersza prowizji znaczy "silnik nie przypisal prowizji do tej
        // transakcji"; lista pokazuje wtedy 0.00, a koszt liczy i tak silnik.
        commission: prowizja ? prowizja.kwota : prowizjaZeSzczegolow !== null ? Math.abs(prowizjaZeSzczegolow) : 0,
        commissionCurrency: walutaProwizji.toUpperCase() as CurrencyCode,
        notes: wiersz.comment || undefined,
        zrodlo: lokalna ? 'RECZNA' : 'SILNIK',
        tylkoOdczyt: !lokalna,
        kwotaPLN: liczbaLubNull(wiersz.amount_pln) ?? undefined,
      });
    } else {
      const podatek = podatkiUZrodla.get(`${ticker}|${data.slice(0, 10)}|${waluta}`);
      transakcje.push({
        id: `silnik:${wiersz.row_id}`,
        accountId: KONTO_MAGAZYNU_SILNIKA,
        ticker,
        name: ticker,
        category: kategoriaZWiersza(swiat, waluta),
        type: 'DIVIDEND',
        date: data.replace(' ', 'T'),
        quantity: 1,
        pricePerUnit: Math.abs(kwota),
        currency: waluta as CurrencyCode,
        commission: 0,
        commissionCurrency: waluta as CurrencyCode,
        foreignTaxAmount: podatek,
        notes: wiersz.comment || undefined,
        zrodlo: 'SILNIK',
        tylkoOdczyt: true,
        kwotaPLN: liczbaLubNull(wiersz.amount_pln) ?? undefined,
      });
    }
  }

  transakcje.sort((a, b) => b.date.localeCompare(a.date));
  return { transakcje, pominieteBezDanych };
}

export interface WynikPortfelaZSilnika extends TaxCalculationResult {
  /** Transakcje do zakladki "Transakcje" - z przebiegu silnika. */
  transakcjeSilnika: Transaction[];
  pominieteBezDanych: number;
  /** Rok, dla ktorego silnik policzyl kwoty. */
  rokSilnika: number;
  /** Czy silnik uznal rozliczenie za gotowe do zlozenia. */
  gotoweDoZlozenia: boolean | null;
}

/**
 * Stan zakladek Portfel / PIT-38 / Transakcje z JEDNEGO przebiegu silnika.
 *
 * Funkcja czysta: nie uruchamia silnika i nie liczy podatku drugi raz. Kwoty
 * PIT-38 sa przepisywane z `art30b` / `annual_summary` / `art30a`.
 */
export function zbudujWynikPortfelaZSilnika(
  response: TaxEngineResponse,
  year: number,
  transakcjeLokalne: readonly Transaction[],
  accounts: BrokerAccount[],
  informacjePit8c: readonly WpisPit8c[] = [],
): WynikPortfelaZSilnika {
  const wynik = response as WynikSilnika;
  const { transakcje, pominieteBezDanych } = transakcjeZWynikuSilnika(wynik, transakcjeLokalne);
  // Opisy instrumentow (nazwa, rachunek) bierzemy z transakcji silnika
  // uzupelnionych o lokalne - dzieki temu wyciag brokera tez ma opisy.
  const doOpisow: Transaction[] = [...transakcjeLokalne, ...transakcje];
  const realizedGains = mapRealizedGains(wynik, doOpisow);
  const dividends = mapDividends(wynik, doOpisow);
  const yearSummaries = mapYearSummaries(wynik, year, realizedGains, dividends, accounts, {
    tickeryNiejednoznaczne: tickeryNaWieluRachunkach(doOpisow),
    informacjePit8c,
  });
  const openPositions = mapOpenPositions(wynik, doOpisow);
  return {
    realizedGains,
    dividends,
    yearSummaries,
    openPositions,
    // Sprzedaz bez pokrycia w zakupach silnik zglasza jako problem w swoim
    // przebiegu (zakladka "Dokumenty i silnik"), a nie jako osobna liste.
    unmatchedSalesWarnings: [],
    transakcjeSilnika: transakcje,
    pominieteBezDanych,
    rokSilnika: year,
    gotoweDoZlozenia: typeof response.filing_ready === 'boolean' ? response.filing_ready : null,
  };
}

/**
 * Oblicza podatki używając silnika Python.
 *
 * Jedyna droga, którą liczy się rozliczenie. Silnik czyta magazyn dokumentów
 * (`dane/pliki`); ręczne kupna i sprzedaże z portfela jadą w żądaniu jako
 * rekordy ręczne i NIE są zapisywane do magazynu. Pusta lista lokalna nie
 * znaczy "nie ma czego liczyć" - dokumenty brokera leżą w magazynie.
 */
export async function calculateTaxesWithEngine(
  transactions: Transaction[],
  accounts: BrokerAccount[],
  options?: { year?: number; signal?: AbortSignal; wymusPrzeliczenie?: boolean },
): Promise<WynikPortfelaZSilnika> {
  const year = options?.year ?? new Date().getFullYear();
  const response = await runEngine(year, transactions, options?.signal, options?.wymusPrzeliczenie === true);

  if (response.error && !response.success) {
    throw new Error(`Silnik zwrócił błąd: ${response.error}`);
  }

  return zbudujWynikPortfelaZSilnika(response, year, transactions, accounts, odczytajUstawienia().informacjePit8c);
}

// ---------------------------------------------------------------------------
// Eksporty pomocnicze (do testów i debugowania)
// ---------------------------------------------------------------------------

export { transactionsToEngineInput as _transactionsToEngineInput };
export { STORAGE_FILENAME as _STORAGE_FILENAME };
