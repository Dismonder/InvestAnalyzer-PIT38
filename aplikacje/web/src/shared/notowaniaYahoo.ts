/**
 * Czyste pomocniki do odpowiedzi Yahoo Finance. Wspolne dla serwera Node
 * (routes/quotes.ts) i hostowanego API w Workerze Cloudflare (hosting/apiHostowane.ts):
 * oba musza tak samo liczyc pensy, sesje swiecy i zakresy, zeby ten sam ticker
 * dawal to samo notowanie w kazdej wersji aplikacji. Bez importow Node.
 */

export type SesjaSwiecy = 'PRE' | 'REGULAR' | 'POST' | 'OVERNIGHT';

/**
 * Najdluzsza historia, jaka dostawca oddaje dla interwalu w jednym zapytaniu.
 * Wykres pobiera ja raz, a przesuwanie i powiekszanie dzieje sie juz lokalnie.
 */
export function najdluzszyZakres(interval: string): string {
  if (interval === '1m') return '7d';
  if (['2m', '5m', '15m', '30m', '90m'].includes(interval)) return '60d';
  if (interval === '1h' || interval === '60m') return '730d';
  return '10y';
}

export function sekundyInterwalu(interval: string): number {
  const minuty: Record<string, number> = { '1m': 1, '2m': 2, '5m': 5, '15m': 15, '30m': 30, '1h': 60, '60m': 60, '90m': 90 };
  return (minuty[interval] ?? 15) * 60;
}

export function czyInterwalSrodsesyjny(interval: string): boolean {
  return ['1m', '2m', '5m', '15m', '30m', '1h', '60m', '90m'].includes(interval);
}

/**
 * Granice sesji regularnej jako sekundy od polnocy w czasie gieldy. Dostawca
 * podaje je dla biezacego dnia; pora dnia jest ta sama w pozostale dni zakresu.
 * `null`, gdy dostawca ich nie podal - wtedy sesji nie zgadujemy.
 */
export function graniceSesjiRegularnej(meta: any): { start: number; koniec: number; przesuniecie: number } | null {
  const regularna = meta?.currentTradingPeriod?.regular;
  const przesuniecie = Number(regularna?.gmtoffset ?? meta?.gmtoffset);
  const start = Number(regularna?.start);
  const koniec = Number(regularna?.end);
  if (![przesuniecie, start, koniec].every(Number.isFinite) || koniec <= start) return null;
  const poraDnia = (znacznik: number) => (((znacznik + przesuniecie) % 86_400) + 86_400) % 86_400;
  return { start: poraDnia(start), koniec: poraDnia(koniec), przesuniecie };
}

export function sesjaSwiecy(
  znacznikSekundy: number,
  granice: { start: number; koniec: number; przesuniecie: number } | null,
): SesjaSwiecy | null {
  if (!granice) return null;
  const pora = (((znacznikSekundy + granice.przesuniecie) % 86_400) + 86_400) % 86_400;
  if (pora < granice.start) return 'PRE';
  if (pora >= granice.koniec) return 'POST';
  return 'REGULAR';
}

/** Yahoo oznacza pensy jako GBp. W aplikacji kwota i waluta muszą być spójne. */
export function normalizePenceQuote(value: number | null | undefined, currency: unknown): number | null | undefined {
  // Yahoo stosuje oba zapisy pensów. Samo `GBP` oznacza już funty i nie może
  // być dzielone przez 100.
  const unit = String(currency).trim();
  if (unit !== 'GBp' && unit.toUpperCase() !== 'GBX') return value;
  return typeof value === 'number' && Number.isFinite(value) ? value / 100 : value;
}

export function normalizedQuoteCurrency(currency: unknown): string | null {
  if (currency === 'GBp' || String(currency).toUpperCase() === 'GBX') return 'GBP';
  return typeof currency === 'string' && currency.trim() ? currency : null;
}

/**
 * Yahoo ogranicza zakres zaleznie od interwalu: 1m tylko do 7 dni, 5m/15m do 60 dni,
 * 1h do 730 dni. Zwraca pare (interwal, zakres), ktora dostawca przyjmie.
 */
export function dopasujInterwalDoZakresu(interval: string, range: string): { interval: string; range: string } {
  let validInterval = interval;
  const validRange = range === 'max' ? najdluzszyZakres(interval) : range;
  if (validInterval === '1m') {
    if (validRange !== '1d' && validRange !== '5d' && validRange !== '7d') {
      validInterval = '5m';
      if (validRange === '6mo' || validRange === '1y') validInterval = '1h';
    }
  } else if (validInterval === '5m' || validInterval === '15m') {
    if (validRange === '6mo' || validRange === '1y') validInterval = '1h';
  }
  return { interval: validInterval, range: validRange };
}

/** Etykieta osi czasu jak na serwerze: godzina dla jednego dnia, data+godzina dla intraday wielodniowego. */
export function etykietaPunktu(ts: number, range: string, interval: string): string {
  const dateObj = new Date(ts);
  const isIntradaySingleDay = range === '1d';
  const isIntradayMultiDay = (range === '5d' || range === '1mo' || range === '6mo' || range === '1y')
    && (interval === '1m' || interval === '5m' || interval === '15m' || interval === '1h');
  if (isIntradaySingleDay) return dateObj.toLocaleTimeString('pl-PL', { hour: '2-digit', minute: '2-digit' });
  const data = dateObj.toLocaleDateString('pl-PL', { day: 'numeric', month: 'numeric' });
  if (isIntradayMultiDay) return `${data} ${dateObj.toLocaleTimeString('pl-PL', { hour: '2-digit', minute: '2-digit' })}`;
  return data;
}
