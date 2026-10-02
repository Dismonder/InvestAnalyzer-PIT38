import { Router } from 'express';
// Kalendarz dni roboczych (zasada T-1) jest wspolny z przegladarka.
import { getLastBusinessDayBefore, getPreviousDayStr, isPolishBusinessDay } from '../../shared/kalendarzPl';

export { getLastBusinessDayBefore, getPreviousDayStr, isPolishBusinessDay };

const router = Router();

// In-memory NBP Rate Cache (immutable, persistent for server uptime)
export interface CachedNBPRate {
  currency: string;
  code: string;
  table: string;
  no: string;
  effectiveDate: string;
  mid: number;
}

const nbpRateCache = new Map<string, CachedNBPRate>();
// Cache trzyma date, ktorej tabela dotyczy. Bez tego zapytanie o konkretny
// dzien dostawalo tabele "najnowsza", jesli ktos pobral ja w ostatniej minucie.
let latestNBPTableCache: { table: any; cachedAt: number; dlaDaty: string } | null = null;

// Fetch official NBP exchange rate for currency and date (T-1 tax rule)
export async function fetchOfficialNBPRate(currency: string, transactionDate: string): Promise<CachedNBPRate> {
  const curr = currency.toUpperCase();
  if (curr === 'PLN') {
    return {
      currency: 'PLN',
      code: 'PLN',
      table: 'A',
      no: 'BRAK/PLN',
      effectiveDate: transactionDate.slice(0, 10),
      mid: 1.0,
    };
  }

  // T-1 principle: Last Polish banking business day preceding the transaction
  let targetDate = getLastBusinessDayBefore(transactionDate);
  const cacheKey = `${curr}_${targetDate}`;

  if (nbpRateCache.has(cacheKey)) {
    return nbpRateCache.get(cacheKey)!;
  }

  // Try fetching directly for target date; if 404 (unexpected holiday/closure), step back day by day
  let attempts = 0;
  let bledySieci = 0;
  let currentDate = targetDate;
  while (attempts < 7) {
    try {
      const url = `https://api.nbp.pl/api/exchangerates/rates/a/${curr.toLowerCase()}/${currentDate}/?format=json`;
      const response = await fetch(url, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(3000),
      });

      if (response.ok) {
        const data: any = await response.json();
        if (data && data.rates && data.rates.length > 0) {
          const rateInfo = data.rates[0];
          const result: CachedNBPRate = {
            currency: curr,
            code: curr,
            table: data.table || 'A',
            no: rateInfo.no,
            effectiveDate: rateInfo.effectiveDate,
            mid: rateInfo.mid,
          };
          nbpRateCache.set(cacheKey, result);
          return result;
        }
      }
      if (response.status !== 404) {
        // 404 znaczy "NBP nie publikowal tego dnia" - wtedy cofniecie sie
        // o dzien jest wlasciwe. Kazda inna odpowiedz to blad serwera,
        // a nie swieto: cofanie sie po niej dawalo kurs z innego dnia
        // niz wymagany przez art. 11a ust. 2, bez sladu w odpowiedzi.
        throw new Error(
          `Serwer NBP zwrocil HTTP ${response.status} dla ${curr} na dzien ${currentDate}.`
        );
      }
    } catch (err: any) {
      console.warn(`[NBP] Failed to fetch rate for ${curr} on ${currentDate}`, err);
      bledySieci++;
      if (bledySieci >= 2) {
        throw new Error(
          `Nie udalo sie pobrac kursu NBP dla ${curr} na dzien ${targetDate}: ${err?.message || 'blad polaczenia'}. ` +
            'Kurs nie zostal podstawiony z innego dnia.'
        );
      }
      // Pierwszy blad moze byc chwilowy - probujemy jeszcze raz ten sam dzien.
      continue;
    }

    // Step back 1 day and retry if NBP did not publish on that specific day
    currentDate = getPreviousDayStr(currentDate);
    attempts++;
  }

  // Brak kursu to brak kursu.
  //
  // Wczesniej w tym miejscu powstawal kurs wyliczony z daty: stala bazowa dla
  // waluty plus przesuniecie z reszty z dzielenia liczby z daty, do tego
  // zmyslony numer tabeli w rodzaju "137/A/NBP/2026". Taka odpowiedz szla dalej
  // z etykieta `source: 'NBP_API_OFFICIAL'` i podstawa prawna art. 11a, a
  // uzytkownik przepisywal wymyslony kurs do deklaracji podatkowej. Lepiej
  // powiedziec wprost, ze kursu nie udalo sie pobrac.
  throw new Error(
    `Nie udało się pobrać kursu NBP dla ${curr} na dzień ${targetDate}. Sprawdź połączenie z api.nbp.pl i spróbuj ponownie.`
  );
}

// Official NBP Rate Endpoint (Art. 11a ust. 1 i 3 ustawy o PIT - T-1 Rule)
router.get('/rate', async (req, res) => {
  const currencyParam = req.query.currency;
  const dateParam = req.query.date;
  if (typeof currencyParam !== 'string' || !currencyParam.trim() ||
      typeof dateParam !== 'string' || !dateParam.trim()) {
    return res.status(400).json({ success: false, error: 'Podaj walutę (currency) i datę transakcji (date).' });
  }
  const currency = currencyParam.trim().toUpperCase();
  const date = dateParam.trim();

  try {
    const rate = await fetchOfficialNBPRate(currency, date);
    res.json({
      success: true,
      data: rate,
      legalBasis: 'Art. 11a ust. 1 i 3 ustawy o PIT (Zasada T-1)',
      requestedDate: date,
      appliedTableDate: rate.effectiveDate,
      source: 'NBP_API_OFFICIAL',
    });
  } catch (err: any) {
    // 503, a nie 500: zrodlo kursu jest chwilowo niedostepne, samo zapytanie
    // bylo poprawne. Klient pokazuje to uzytkownikowi zamiast podstawiac kurs.
    res.status(503).json({
      success: false,
      error: err.message,
      currency,
      requestedDate: date,
    });
  }
});

// Official NBP Table A (All foreign currencies)
router.get('/table-a', async (req, res) => {
  const now = Date.now();
  const dateParam = (req.query.date as string) || '';
  if (
    latestNBPTableCache &&
    latestNBPTableCache.dlaDaty === dateParam &&
    now - latestNBPTableCache.cachedAt < 60000
  ) {
    return res.json({ success: true, ...latestNBPTableCache.table, source: 'CACHE' });
  }

  let powod = 'Serwer NBP nie odpowiedzial.';
  try {
    const url = dateParam
      ? `https://api.nbp.pl/api/exchangerates/tables/a/${dateParam}/?format=json`
      : `https://api.nbp.pl/api/exchangerates/tables/a/?format=json`;

    const response = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(5000),
    });
    if (response.ok) {
      const data: any = await response.json();
      if (Array.isArray(data) && data.length > 0) {
        const tableData = data[0];
        const payload = {
          table: tableData.table,
          no: tableData.no,
          effectiveDate: tableData.effectiveDate,
          rates: tableData.rates,
          timestamp: new Date().toISOString(),
        };
        latestNBPTableCache = { table: payload, cachedAt: now, dlaDaty: dateParam };
        return res.json({ success: true, ...payload, source: 'NBP_API_OFFICIAL' });
      }
      powod = 'Serwer NBP odpowiedzial, ale nie oddal tabeli.';
    } else {
      powod = `Serwer NBP zwrocil HTTP ${response.status}.`;
    }
  } catch (err: any) {
    console.warn('[NBP Table A] Error fetching from NBP:', err);
    powod = 'Nie udalo sie polaczyc z api.nbp.pl.';
  }

  // Bylo tu jedenascie kursow wpisanych w kod z numerem tabeli "157/A/NBP/2026"
  // i data 2026-08-14, oddawanych jako `success: true` pod biezacym znacznikiem
  // czasu. Ta sama wartosc zastepcza, ktora usunieto juz z fetchOfficialNBPRate,
  // stala w drugiej trasie tego samego pliku. Kurs NBP przelicza cala
  // deklaracje - zmyslony kurs to zmyslony podatek.
  res.status(502).json({
    success: false,
    errorCode: 'NBP_TABLE_UNAVAILABLE',
    message: `${powod} Tabela kursow NBP nie zostala pobrana - aplikacja nie podstawia wlasnych kursow.`,
  });
});

// NBP Historical Rates for Charts and Audits
router.get('/history', async (req, res) => {
  const currency = ((req.query.currency as string) || 'USD').toLowerCase();
  const days = parseInt((req.query.days as string) || '30', 10);
  const count = Math.min(Math.max(days, 5), 90);

  try {
    const url = `https://api.nbp.pl/api/exchangerates/rates/a/${currency}/last/${count}/?format=json`;
    const response = await fetch(url, { headers: { Accept: 'application/json' } });
    if (response.ok) {
      const data: any = await response.json();
      return res.json({
        success: true,
        currency: data.code,
        rates: data.rates,
        source: 'NBP_API_OFFICIAL',
      });
    }
  } catch (err: any) {
    console.warn('[NBP History] Error:', err);
  }

  res.status(500).json({ success: false, error: 'Could not fetch NBP history' });
});

export default router;
