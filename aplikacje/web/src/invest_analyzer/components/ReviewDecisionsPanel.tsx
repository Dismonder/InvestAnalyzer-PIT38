import React from 'react';
import { odmienLiczebnik } from '../../portfel/services/odmianaLiczebnika';
import { getBrowserTaxSettingsStorage } from '../services/taxEngineConfig';
import {
  buildBonusContestShareProposal,
  czyPozycjaRozstrzygnieta,
  REVIEW_DECISION_LABELS,
  REVIEW_KIND_LABELS,
  readReviewDecisions,
  mergeAndSaveReviewDecisions,
  setReviewDecision,
  type ReviewDecisionKind,
  type ReviewDecision,
  type ReviewQueueItem,
} from '../services/reviewDecisions';
import { StorageService } from '../services/storage';

interface ReviewDecisionsPanelProps {
  queue: ReviewQueueItem[];
  selectedYear: number;
  disabled?: boolean;
  /** Przeliczenie po zapisaniu decyzji - gotowość ocenia wyłącznie silnik. */
  onRecalculate: () => void;
  onOpenHistorySearch?: (query: string) => void;
}

/**
 * „Co wymaga decyzji”: lista zdarzeń, których silnik nie rozstrzyga sam,
 * z miejscem na decyzję. Bez tego panelu raport blokował pakiet i odsyłał do
 * historii, w której tych zdarzeń w ogóle nie było.
 */
export function ReviewDecisionsPanel({
  queue,
  selectedYear,
  disabled,
  onRecalculate,
  onOpenHistorySearch,
}: ReviewDecisionsPanelProps) {
  const [decisions, setDecisions] = React.useState(() => readReviewDecisions(getBrowserTaxSettingsStorage()));
  const base = React.useRef<ReviewDecision[]>(decisions);
  const [dirty, setDirty] = React.useState(false);
  const [showAll, setShowAll] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [pendingProposals, setPendingProposals] = React.useState<Map<string, ReviewQueueItem>>(() => new Map());

  const byKey = React.useMemo(() => new Map(decisions.map((entry) => [entry.decisionKey, entry.decision])), [decisions]);
  const blocking = queue.filter((item) => item.blocks_filing);
  const visible = showAll ? queue : blocking;
  const openBlocking = blocking.filter((item) => !czyPozycjaRozstrzygnieta(item, byKey.get(item.decision_key))).length;

  const zapisane = new Map(base.current.map((entry) => [entry.decisionKey, entry.decision]));
  const zmienione =
    [...new Set([...byKey.keys(), ...zapisane.keys()])].filter((key) => byKey.get(key) !== zapisane.get(key)).length +
    [...pendingProposals.keys()].filter((key) => byKey.get(key) === zapisane.get(key)).length;

  if (queue.length === 0) return null;

  // Klikniecia tylko zaznaczaja. Zapis i przeliczenie (ok. pol minuty) robi
  // dopiero przycisk na dole, wiec mozna rozstrzygnac kilka zdarzen naraz.
  const choose = (decisionKey: string, decision: ReviewDecisionKind | null) => {
    setDecisions(setReviewDecision(decisions, decisionKey, decision));
    setPendingProposals((current) => {
      if (!current.has(decisionKey)) return current;
      const next = new Map(current);
      next.delete(decisionKey);
      return next;
    });
    setDirty(true);
  };

  const toggleBonusProposal = (item: ReviewQueueItem) => {
    if (pendingProposals.has(item.decision_key)) {
      choose(item.decision_key, null);
      return;
    }
    if (!buildBonusContestShareProposal(item)) return;
    setDecisions(setReviewDecision(decisions, item.decision_key, 'handled_manually'));
    setPendingProposals((current) => new Map(current).set(item.decision_key, item));
    setDirty(true);
  };

  const saveAndRecalculate = async () => {
    setSaving(true);
    try {
      for (const item of pendingProposals.values()) {
        const proposal = buildBonusContestShareProposal(item);
        if (proposal) await StorageService.upsertTransactionOverride(proposal);
      }
      const merged = mergeAndSaveReviewDecisions(getBrowserTaxSettingsStorage(), base.current, decisions);
      base.current = merged;
      setDecisions(merged);
      setPendingProposals(new Map());
      setDirty(false);
      onRecalculate();
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="mt-3 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-100">
      <p className="font-semibold">
        {blocking.length > 0
          ? `Co wymaga decyzji: ${openBlocking} z ${blocking.length} zdarzeń mogących zmienić PIT za ${selectedYear} czeka na rozstrzygnięcie.`
          : `Nic z tej listy nie zmienia PIT za ${selectedYear} - ${queue.length} ${odmienLiczebnik(queue.length, 'zdarzenie czeka', 'zdarzenia czekają', 'zdarzeń czeka')} tylko na przegląd (ostrzeżenia).`}
      </p>
      <p className="mt-1 text-xs">
        Sprzedaże z niepotwierdzonego źródła wymagają wskazania rachunku; wybór przenosi ich przychód i koszt do odpowiedniej części formularza.
        Pozostałe zdarzenia NIE weszły do rozliczenia - silnik nie zgaduje kosztu akcji przyznanych ani skutków zdarzeń
        korporacyjnych. Decyzja o pozostałych zdarzeniach nie zmienia kwot: potwierdza ich sprawdzenie i trafia do audytu.
        Akcje przyznane z kosztem dodaj w Historii jako „akcja bonusowa”, a tutaj oznacz „ująłem ręcznie”.
      </p>
      <div className="mt-2 max-h-80 space-y-2 overflow-y-auto pr-1">
        {visible.map((item) => {
          const stored = byKey.get(item.decision_key);
          const current = item.kind === 'pit8c_source'
            ? (stored === 'pit8c_account' || stored === 'no_pit8c_account' ? stored : null)
            : (stored === 'no_tax_effect' || stored === 'handled_manually' ? stored : null);
          // Silnik uznal zapisana decyzje za niewystarczajaca: blokada zostaje, pozycja nie jest rozstrzygnieta.
          const niewystarcza = current !== null && item.blocks_filing && !czyPozycjaRozstrzygnieta(item, current);
          return (
            <div
              key={item.decision_key}
              className="rounded-md border border-amber-200 bg-white p-2 text-xs text-gray-800 dark:border-amber-900 dark:bg-gray-900 dark:text-gray-100"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="font-semibold">
                  {REVIEW_KIND_LABELS[item.kind] || item.kind}
                  {item.symbol ? ` · ${item.symbol}` : ''}
                  {item.date ? ` · ${item.date}` : ' · bez daty'}
                </div>
                <div className="font-mono text-[11px] text-gray-600 dark:text-gray-300">
                  {item.quantity ? `${item.quantity} szt.` : ''}
                  {item.quantity && item.amount ? ' · ' : ''}
                  {item.amount ? `${item.amount} ${item.currency || '(waluta nieznana)'}` : ''}
                </div>
              </div>
              {item.comment && <div className="mt-1 text-[11px] text-gray-500 dark:text-gray-400">{item.comment}</div>}
              <div className="mt-1 text-[11px] text-gray-500 dark:text-gray-400">
                {item.blocks_filing ? 'Blokuje gotowość rozliczenia' : 'Ostrzeżenie (inny rok)'} · pliki: {item.source_files.length}
                {item.occurrences > 1 ? ` · to samo zdarzenie w ${item.occurrences} zapisach` : ''}
              </div>
              {item.blocking_note && (
                <p role="alert" className="mt-2 rounded-md border border-rose-300 bg-rose-50 p-2 text-xs font-medium text-rose-900 dark:border-rose-800 dark:bg-rose-950/40 dark:text-rose-100">
                  {niewystarcza ? 'Zapisana decyzja nie wystarcza. ' : ''}{item.blocking_note}
                </p>
              )}
              {item.changes_share_count === true && (
                <p className="mt-2 rounded-md border border-amber-300 bg-amber-50 p-2 text-xs font-medium text-amber-950 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-100">
                  Podział lub scalenie akcji nie jest przychodem, ale zmienia liczbę akcji w partiach FIFO. Jeśli masz ten walor albo sprzedajesz go po tej dacie, popraw ilość i cenę zakupów sprzed zdarzenia w Historii transakcji (kwota bez zmian) i wybierz »Ująłem ręcznie w historii«. »Nie wpływa na PIT« wybierz tylko, gdy nie masz już tego waloru.
                </p>
              )}
              <div className="mt-2 flex flex-wrap gap-2">
                {item.kind === 'stock_award' && (
                  <button
                    type="button"
                    disabled={disabled}
                    onClick={() => toggleBonusProposal(item)}
                    className="rounded-md border border-blue-500 bg-blue-600 px-2 py-1 text-[11px] font-semibold text-white hover:bg-blue-700 disabled:opacity-50"
                  >
                    {pendingProposals.has(item.decision_key) ? '✓ Propozycja akcji bonusowej zaznaczona' : 'Zatwierdź propozycję akcji bonusowej'}
                  </button>
                )}
                {((item.kind === 'pit8c_source' ? ['pit8c_account', 'no_pit8c_account'] : ['no_tax_effect', 'handled_manually']) as ReviewDecisionKind[]).map((kind) => (
                  <button
                    key={kind}
                    type="button"
                    disabled={disabled}
                    onClick={() => choose(item.decision_key, current === kind ? null : kind)}
                    className={`rounded-md border px-2 py-1 text-[11px] font-semibold transition disabled:opacity-50 ${
                      current === kind
                        ? (niewystarcza ? 'border-rose-600 bg-rose-600 text-white' : 'border-emerald-700 bg-emerald-700 text-white')
                        : 'border-amber-400 bg-white text-amber-900 hover:bg-amber-100 dark:bg-gray-900 dark:text-amber-200'
                    }`}
                  >
                    {current === kind ? (niewystarcza ? '⚠ ' : '✓ ') : ''}
                    {REVIEW_DECISION_LABELS[kind]}
                  </button>
                ))}
                {current && (
                  <button
                    type="button"
                    disabled={disabled}
                    onClick={() => choose(item.decision_key, null)}
                    className="rounded-md border border-gray-300 px-2 py-1 text-[11px] font-semibold text-gray-700 hover:bg-gray-100 disabled:opacity-50 dark:border-gray-700 dark:text-gray-200 dark:hover:bg-gray-800"
                  >
                    Cofnij decyzję
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button
          type="button"
          disabled={disabled || saving || !dirty}
          onClick={() => void saveAndRecalculate()}
          className="rounded-md bg-amber-700 px-3 py-1.5 text-xs font-bold text-white hover:bg-amber-800 disabled:opacity-50"
        >
          {dirty ? `Zapisz decyzje i przelicz (${zmienione})` : 'Zapisz decyzje i przelicz'}
        </button>
        {queue.length > blocking.length && (
          <button
            type="button"
            onClick={() => setShowAll((value) => !value)}
            className="rounded-md border border-amber-400 bg-white px-3 py-1.5 text-xs font-semibold text-amber-900 hover:bg-amber-100 dark:bg-gray-900 dark:text-amber-200"
          >
            {showAll ? 'Pokaż tylko blokujące' : `Pokaż też ostrzeżenia (${queue.length - blocking.length})`}
          </button>
        )}
        {onOpenHistorySearch && (
          <button
            type="button"
            onClick={() => onOpenHistorySearch('BONUS_CONTEST_SHARE')}
            className="rounded-md border border-amber-400 bg-white px-3 py-1.5 text-xs font-semibold text-amber-900 hover:bg-amber-100 dark:bg-gray-900 dark:text-amber-200"
          >
            Historia: dodaj akcję bonusową z kosztem
          </button>
        )}
      </div>
    </div>
  );
}
