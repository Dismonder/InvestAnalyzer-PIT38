import type { LiveMarketQuote, PriceAlert } from '../types';

export const PRICE_ALERT_MAX_QUOTE_AGE_MS = 15 * 60 * 1000;

const MARKET_SUFFIXES = ['.CRPT', '.PL', '.US', '.EU', '.DE', '.UK', '.L', '.PA', '.TO', '.WA'];

export function normalizeAlertTicker(ticker: string): string {
  const normalized = ticker.trim().toUpperCase();
  const suffix = MARKET_SUFFIXES.find((item) => normalized.endsWith(item));
  return suffix ? normalized.slice(0, -suffix.length) : normalized;
}

export function findPriceAlertQuote(
  ticker: string,
  quotes: Record<string, LiveMarketQuote>,
): LiveMarketQuote | undefined {
  const entries = Object.entries(quotes);
  const exact = entries.find(([key, quote]) => key.toUpperCase() === ticker.trim().toUpperCase() || quote.ticker.toUpperCase() === ticker.trim().toUpperCase());
  if (exact) return exact[1];

  const base = normalizeAlertTicker(ticker);
  const candidates = new Map<string, LiveMarketQuote>();
  for (const [key, quote] of entries) {
    if (normalizeAlertTicker(quote.ticker || key) === base) candidates.set(quote.ticker.toUpperCase(), quote);
  }
  return candidates.size === 1 ? candidates.values().next().value : undefined;
}

export function isPriceAlertExpired(alert: Pick<PriceAlert, 'expiresAt'>, now: number): boolean {
  return Boolean(alert.expiresAt && new Date(alert.expiresAt).getTime() <= now);
}

export function buildPriceAlertMessage(alert: PriceAlert, quote: LiveMarketQuote): string {
  if (alert.condition === 'ABOVE') {
    return `Kurs ${quote.ticker} wzrósł powyżej celu ${alert.targetPrice} ${quote.currency} (aktualnie: ${quote.price} ${quote.currency})`;
  }
  if (alert.condition === 'BELOW') {
    return `Kurs ${quote.ticker} spadł poniżej poziomu ${alert.targetPrice} ${quote.currency} (aktualnie: ${quote.price} ${quote.currency})`;
  }
  if (alert.condition === 'PERCENT_CHANGE_UP') {
    return `Znaczący wzrost ${quote.ticker}: zmiana 24h +${quote.changePercent24h}% (próg: +${alert.percentageThreshold}%)`;
  }
  return `Znaczący spadek ${quote.ticker}: zmiana 24h ${quote.changePercent24h}% (próg: -${alert.percentageThreshold}%)`;
}

export interface PriceAlertEvaluation {
  quote?: LiveMarketQuote;
  currencyMismatch: boolean;
  updatedAlert?: PriceAlert;
}

export function evaluatePriceAlert(
  alert: PriceAlert,
  quotes: Record<string, LiveMarketQuote>,
  now: number,
  maxQuoteAgeMs = PRICE_ALERT_MAX_QUOTE_AGE_MS,
): PriceAlertEvaluation {
  const quote = findPriceAlertQuote(alert.ticker, quotes);
  const currencyMismatch = Boolean(quote && quote.currency !== alert.currency);
  if (!alert.isActive || alert.isTriggered || isPriceAlertExpired(alert, now) || !quote || currencyMismatch) {
    return { quote, currencyMismatch };
  }

  const quotedAt = new Date(quote.lastUpdated).getTime();
  if (!Number.isFinite(quotedAt) || now - quotedAt > maxQuoteAgeMs || quotedAt > now) {
    return { quote, currencyMismatch };
  }

  const threshold = Math.abs(alert.percentageThreshold ?? 0);
  // Brak zmiany dziennej u dostawcy (null) nie jest zmiana 0: alert procentowy nie ma wtedy na czym sie oprzec.
  const zmiana = quote.changePercent24h;
  const maZmiane = typeof zmiana === 'number' && Number.isFinite(zmiana);
  const triggered = alert.condition === 'ABOVE'
    ? quote.price >= alert.targetPrice
    : alert.condition === 'BELOW'
      ? quote.price <= alert.targetPrice
      : alert.condition === 'PERCENT_CHANGE_UP'
        ? alert.percentageThreshold !== undefined && maZmiane && zmiana >= threshold
        : alert.percentageThreshold !== undefined && maZmiane && zmiana <= -threshold;

  if (!triggered) return { quote, currencyMismatch };

  const message = buildPriceAlertMessage(alert, quote);
  return {
    quote,
    currencyMismatch,
    updatedAlert: { ...alert, isTriggered: true, triggeredAt: new Date(now).toISOString(), message },
  };
}

export function updatePriceAlert(current: PriceAlert, updated: PriceAlert): PriceAlert {
  const rearmed = current.condition !== updated.condition
    || current.targetPrice !== updated.targetPrice
    || current.percentageThreshold !== updated.percentageThreshold
    // Inny walor albo waluta to nowy alert - stan wyzwolenia poprzedniego nie obowiazuje.
    || current.ticker.trim().toUpperCase() !== updated.ticker.trim().toUpperCase()
    || current.currency !== updated.currency;
  if (!rearmed) return { ...updated, isTriggered: current.isTriggered, triggeredAt: current.triggeredAt, message: current.message };
  return { ...updated, isTriggered: false, triggeredAt: undefined, message: undefined };
}

export function togglePriceAlert(alert: PriceAlert): PriceAlert {
  return { ...alert, isActive: !alert.isActive };
}

export function calculatePriceAlertExpiry(option: '1d' | '3d' | '7d' | '14d' | '30d' | '90d' | 'never', now: number): string | undefined {
  if (option === 'never') return undefined;
  const days: Record<Exclude<typeof option, 'never'>, number> = {
    '1d': 1, '3d': 3, '7d': 7, '14d': 14, '30d': 30, '90d': 90,
  };
  return new Date(now + days[option] * 24 * 60 * 60 * 1000).toISOString();
}
