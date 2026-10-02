/**
 * Decyzje użytkownika o zdarzeniach, których silnik nie rozstrzyga sam.
 *
 * Akcje przyznane, zdarzenia korporacyjne i prowizje oznaczone do przeglądu
 * nie wchodzą do rozliczenia i - jeśli mogą zmienić PIT za wybrany rok -
 * blokują gotowość. Do tej pory raport mówił „uzupełnij decyzje”, ale nie było
 * gdzie ich podjąć. Decyzja nie zmienia rachunku (zdarzenie i tak jest poza
 * nim): potwierdza, że użytkownik je sprawdził, i zostaje w audycie przebiegu.
 */

import type { KeyValueStorageSource } from './taxEngineConfig';
import { mergeStoredLists } from './mergeStoredLists';
import { createTransactionOverride, type NadpisanieTransakcji } from './transactionOverrides';

export type ReviewDecisionKind = 'no_tax_effect' | 'handled_manually' | 'pit8c_account' | 'no_pit8c_account';

export interface ReviewDecision {
  decisionKey: string;
  decision: ReviewDecisionKind;
  updatedAt: string;
}

/** Pozycja kolejki zwracana przez silnik (`reviewQueue`). */
export interface ReviewQueueItem {
  decision_key: string;
  kind: string;
  date: string | null;
  symbol: string | null;
  quantity: string | null;
  amount: string | null;
  currency: string | null;
  comment: string | null;
  blocks_filing: boolean;
  decision: string | null;
  source_files: string[];
  occurrences: number;
  changes_share_count?: boolean;
  /** Zdarzenie zmienia liczbe akcji walorow sprzedanych w roku - tylko "Ujalem recznie" je zwalnia. */
  blocks_when_sold?: boolean;
  /** Zapisana decyzja nie wystarcza do odblokowania (silnik nadal blokuje pozycje). */
  decision_insufficient?: boolean;
  /** Wyjasnienie blokady po polsku, od silnika. */
  blocking_note?: string;
}

export const REVIEW_DECISIONS_KEY = 'reviewDecisions:v1';

export const REVIEW_DECISION_LABELS: Record<ReviewDecisionKind, string> = {
  no_tax_effect: 'Sprawdziłem: nie wpływa na PIT',
  handled_manually: 'Ująłem ręcznie w historii (np. akcja bonusowa z kosztem)',
  pit8c_account: 'Rachunek wystawiający PIT-8C',
  no_pit8c_account: 'Rachunek bez PIT-8C',
};

export const REVIEW_KIND_LABELS: Record<string, string> = {
  stock_award: 'Akcje przyznane',
  corporate_action: 'Zdarzenie korporacyjne',
  commission: 'Prowizja / opłata',
  security_flow: 'Ruch papierów',
  pit8c_source: 'Pochodzenie sprzedaży PIT-8C',
};

function normalize(value: unknown): ReviewDecision | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const decisionKey = typeof record.decisionKey === 'string' ? record.decisionKey.trim() : '';
  const decision = record.decision;
  if (!decisionKey || !['no_tax_effect', 'handled_manually', 'pit8c_account', 'no_pit8c_account'].includes(String(decision))) return null;
  return {
    decisionKey,
    decision: decision as ReviewDecisionKind,
    updatedAt: typeof record.updatedAt === 'string' ? record.updatedAt : new Date(0).toISOString(),
  };
}

export function readReviewDecisions(storage: KeyValueStorageSource): ReviewDecision[] {
  const raw = storage.getItem(REVIEW_DECISIONS_KEY);
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return (parsed.map(normalize).filter(Boolean) as ReviewDecision[]).sort((a, b) =>
      a.decisionKey.localeCompare(b.decisionKey),
    );
  } catch {
    return [];
  }
}

export function saveReviewDecisions(storage: KeyValueStorageSource, decisions: ReviewDecision[]): void {
  storage.setItem(REVIEW_DECISIONS_KEY, JSON.stringify(decisions.map(normalize).filter(Boolean)));
  globalThis.window?.dispatchEvent(new Event('tax-input-changed'));
}

export function mergeAndSaveReviewDecisions(
  storage: KeyValueStorageSource, base: ReviewDecision[], local: ReviewDecision[],
): ReviewDecision[] {
  const merged = mergeStoredLists(base, local, readReviewDecisions(storage), (entry) => entry.decisionKey);
  saveReviewDecisions(storage, merged);
  return merged;
}

/** `decision: null` cofa decyzję - zdarzenie wraca do kolejki. */
export function setReviewDecision(
  decisions: ReviewDecision[],
  decisionKey: string,
  decision: ReviewDecisionKind | null,
  now: string = new Date().toISOString(),
): ReviewDecision[] {
  const rest = decisions.filter((entry) => entry.decisionKey !== decisionKey);
  return decision ? [...rest, { decisionKey, decision, updatedAt: now }] : rest;
}

/**
 * Czy zapisana decyzja rozstrzyga pozycje. "Bez wplywu na podatek" nie rozstrzyga
 * pozycji, ktora silnik oznaczyl decision_insufficient - blokada zostaje, a
 * interfejs nie moze pokazywac jej jako zalatwionej. Logiki decyzji nie zmienia:
 * odczytuje tylko to, co orzekl silnik.
 */
export function czyPozycjaRozstrzygnieta(item: ReviewQueueItem, decision: string | null | undefined): boolean {
  if (item.kind === 'pit8c_source') return decision === 'pit8c_account' || decision === 'no_pit8c_account';
  if (decision === 'handled_manually') return true;
  return decision === 'no_tax_effect' && item.decision_insufficient !== true;
}

/** Kolejka z odpowiedzi silnika; brak pola znaczy „silnik jej nie podał”. */
export function readReviewQueue(engineResult: unknown): ReviewQueueItem[] {
  const runtime = (engineResult as { canonical_tax_input_consumption_runtime?: { reviewQueue?: unknown } } | null)
    ?.canonical_tax_input_consumption_runtime;
  const queue = runtime?.reviewQueue;
  return Array.isArray(queue)
    ? (queue.filter((row) => row && typeof row === 'object' && typeof (row as ReviewQueueItem).decision_key === 'string') as ReviewQueueItem[])
    : [];
}

/**
 * Propozycja nie jest jeszcze kosztem: brakująca wartość rynkowa pozostaje
 * pusta, nigdy nie jest zastępowana zerem. Po zatwierdzeniu przez użytkownika
 * trafia do istniejącej warstwy transactionOverrides.
 */
export function buildBonusContestShareProposal(item: ReviewQueueItem): NadpisanieTransakcji | null {
  if (item.kind !== 'stock_award' || !item.symbol || !item.date || !item.quantity) return null;
  const knownMarketValue = item.amount && Number.isFinite(Number(String(item.amount).replace(',', '.')))
    ? item.amount
    : null;
  const promotion = /(?:WELCOME5|promo|contest)/i.test(item.comment || '') ? 'WELCOME5' : '';
  return createTransactionOverride({
    recordType: 'BONUS_CONTEST_SHARE',
    mode: 'new',
    baseRecordId: null,
    manualRecordId: `bonus-award-${item.decision_key}`,
    sourceLabel: 'Propozycja z raportu Freedom24',
    comment: item.comment || undefined,
    values: {
      date: item.date,
      symbol: item.symbol,
      quantity: item.quantity,
      grant_market_value: knownMarketValue,
      currency: item.currency || null,
      promotion_basis: promotion || null,
      comment: item.comment || null,
      message: null,
      country: null,
    },
  });
}
