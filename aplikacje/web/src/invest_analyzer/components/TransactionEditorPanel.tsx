import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useZamknijEscape } from '../../shared/useZamknijEscape';
import { AlertTriangle, PencilLine, RefreshCcw, Save, Trash2, X } from 'lucide-react';
import {
  createEmptyRecordValues,
  type RekordEdycyjny,
  type TypRekorduEdycji,
  bruttoAutomatycznePoZmianie,
  czyBruttoZIloczynu,
  updateTradeFieldValues,
  validateEditableRecordValues,
} from '../services/transactionOverrides';
import { etykietaTypuRekordu } from '../services/transactionEditor';
import { shouldHydrateEditorDraft } from '../services/editorDraft';
import type { SzkicEdytoraTransakcji } from '../services/overrideHistory';

export interface TransactionEditorActionPayload {
  recordType: TypRekorduEdycji;
  baseRecordId: string | null;
  manualRecordId: string;
  values: Record<string, string | null>;
}

export type TransactionEditorContext =
  | {
      mode: 'edit';
      record: RekordEdycyjny;
    }
  | {
      mode: 'new';
      recordType: TypRekorduEdycji;
      manualRecordId: string;
    };

interface TransactionEditorPanelProps {
  isOpen: boolean;
  context: TransactionEditorContext | null;
  draft: SzkicEdytoraTransakcji | null;
  onClose: () => void;
  onDraftChange: (draft: SzkicEdytoraTransakcji | null) => void;
  onSave: (payload: TransactionEditorActionPayload) => Promise<void> | void;
  onDelete: (payload: TransactionEditorActionPayload) => Promise<void> | void;
  onReset: (payload: TransactionEditorActionPayload) => Promise<void> | void;
  onRestore: (payload: TransactionEditorActionPayload) => Promise<void> | void;
}

function cloneValues(values: Record<string, string | null>): Record<string, string | null> {
  return Object.fromEntries(Object.entries(values).map(([key, value]) => [key, value ?? '']));
}

function normalizeValues(values: Record<string, string | null>, emptyValue: string | null): Record<string, string | null> {
  return Object.fromEntries(Object.entries(values).map(([key, value]) => [key, value === '' ? emptyValue : value]));
}

function poleOpisowe(fieldName: string): string {
  const labels: Record<string, string> = {
    date: 'Data',
    symbol: 'Ticker',
    isin: 'ISIN',
    side: 'Strona',
    quantity: 'Ilość',
    price: 'Cena',
    gross_amount: 'Kwota brutto',
    trade_currency: 'Waluta transakcji',
    commission: 'Prowizja',
    commission_currency: 'Waluta prowizji',
    settlement_date: 'Data rozliczenia',
    comment: 'Komentarz',
    message: 'Wiadomość',
    instrument_class: 'Klasa instrumentu',
    instrument_type_code: 'Kod typu instrumentu',
    market_id: 'Rynek',
    country: 'Kraj',
    event_kind: 'Typ zdarzenia',
    amount: 'Kwota',
    currency: 'Waluta',
    grant_market_value: 'Wartość rynkowa przy przyznaniu',
    promotion_basis: 'Podstawa promocji',
  };
  return labels[fieldName] || fieldName;
}

function InputField({
  label,
  value,
  onChange,
  type = 'text',
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  type?: string;
  placeholder?: string;
}) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">{label}</span>
      <input
        type={type}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        className="w-full rounded-2xl border border-gray-200 bg-white px-3 py-2.5 text-sm text-gray-900 outline-none transition focus:border-blue-500 dark:border-gray-700 dark:bg-gray-900 dark:text-white"
      />
    </label>
  );
}

function tekstWartosci(value: string | null | undefined): string {
  if (value === null || value === undefined || value === '') {
    return '—';
  }
  return value;
}

export function TransactionEditorPanel({
  isOpen,
  context,
  draft,
  onClose,
  onDraftChange,
  onSave,
  onDelete,
  onReset,
  onRestore,
}: TransactionEditorPanelProps) {
  const [recordType, setRecordType] = useState<TypRekorduEdycji>('TRADE');
  const [formValues, setFormValues] = useState<Record<string, string | null>>({});
  const [showValidation, setShowValidation] = useState(false);
  const hydratedRecordKeyRef = useRef<string | null>(null);
  // Kwota brutto podąża za ilością i ceną, dopóki użytkownik nie wpisze własnej.
  const bruttoZIloczynuRef = useRef(true);
  const draftTimerRef = useRef<number | null>(null);

  const selectedRecord = context?.mode === 'edit' ? context.record : null;
  const currentManualRecordId =
    context?.mode === 'edit'
      ? context.record.manualRecordId
      : context?.mode === 'new'
        ? context.manualRecordId
        : null;

  useEffect(() => {
    if (!isOpen || !context || !currentManualRecordId) {
      return;
    }

    if (!shouldHydrateEditorDraft({
      currentRecordKey: currentManualRecordId,
      hydratedRecordKey: hydratedRecordKeyRef.current,
    })) {
      return;
    }

    const szkic = draft && draft.recordKey === currentManualRecordId && draft.mode === context.mode ? draft : null;
    const baseValues = szkic
      ? szkic.values
      : context.mode === 'edit'
        ? context.record.currentValues
        : createEmptyRecordValues(context.recordType);

    setRecordType(
      szkic
        ? szkic.recordType
        : context.mode === 'edit'
          ? context.record.recordType
          : context.recordType,
    );
    setFormValues(cloneValues(baseValues));
    bruttoZIloczynuRef.current = szkic?.bruttoReczne ? false : czyBruttoZIloczynu(baseValues);
    setShowValidation(false);
    hydratedRecordKeyRef.current = currentManualRecordId;
  }, [context, currentManualRecordId, draft, isOpen]);

  useEffect(() => {
    if (!isOpen) {
      hydratedRecordKeyRef.current = null;
      if (draftTimerRef.current !== null) {
        window.clearTimeout(draftTimerRef.current);
        draftTimerRef.current = null;
      }
    }
  }, [isOpen]);

  // Escape, fokus i pulapka Tab ze wspolnego hooka okien (stos: Escape zamyka
  // tylko najwyzsze okno). Tu zostaje tylko blokada przewijania tla.
  const refEdytora = useZamknijEscape(isOpen, onClose);
  useEffect(() => {
    if (!isOpen) {
      return;
    }
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen || !context || !currentManualRecordId) {
      return;
    }
    if (draftTimerRef.current !== null) {
      window.clearTimeout(draftTimerRef.current);
    }
    draftTimerRef.current = window.setTimeout(() => {
      draftTimerRef.current = null;
      onDraftChange({
        recordKey: currentManualRecordId,
        mode: context.mode,
        recordType,
        values: normalizeValues(formValues, null),
        updatedAt: new Date().toISOString(),
        bruttoReczne: !bruttoZIloczynuRef.current,
      });
    }, 300);

    return () => {
      if (draftTimerRef.current !== null) {
        window.clearTimeout(draftTimerRef.current);
      }
    };
  }, [context, currentManualRecordId, formValues, isOpen, onDraftChange, recordType]);

  const validationState = useMemo(() => {
    if (!isOpen || !context) {
      return null;
    }
    return validateEditableRecordValues(recordType, formValues);
  }, [context, formValues, isOpen, recordType]);

  const originalValues = selectedRecord?.originalValues || {};
  const currentDiffs = useMemo(() => {
    return Array.from(new Set([...Object.keys(originalValues), ...Object.keys(formValues)]))
      .filter((fieldName) => (originalValues[fieldName] ?? null) !== (formValues[fieldName] ?? null))
      .map((fieldName) => ({
        fieldName,
        originalValue: originalValues[fieldName] ?? null,
        currentValue: formValues[fieldName] ?? null,
      }));
  }, [formValues, originalValues]);

  if (!isOpen || !context || !currentManualRecordId) {
    return null;
  }

  const isDeleted = context.mode === 'edit' ? context.record.deleted : false;
  const title =
    context.mode === 'edit'
      ? context.record.title || context.record.ticker || currentManualRecordId
      : `Nowa pozycja: ${etykietaTypuRekordu(recordType)}`;

  const updateField = (fieldName: string, value: string) => {
    if (recordType !== 'TRADE') {
      setFormValues((current) => ({ ...current, [fieldName]: value }));
      return;
    }
    const next = updateTradeFieldValues(formValues, fieldName, value, bruttoZIloczynuRef.current);
    bruttoZIloczynuRef.current = bruttoAutomatycznePoZmianie(bruttoZIloczynuRef.current, fieldName, value);
    setFormValues(next);
  };

  const handleSwitchRecordType = (nextType: TypRekorduEdycji) => {
    setRecordType(nextType);
    setFormValues(cloneValues(createEmptyRecordValues(nextType)));
    bruttoZIloczynuRef.current = true;
    setShowValidation(false);
  };

  const buildPayload = (): TransactionEditorActionPayload => ({
    recordType,
    baseRecordId: context.mode === 'edit' ? context.record.baseRecordId : null,
    manualRecordId: currentManualRecordId,
    values: normalizeValues(formValues, null),
  });

  const handleSave = async () => {
    if (!validationState) {
      return;
    }
    if (!validationState.isValid) {
      setShowValidation(true);
      return;
    }
    const rozbieznoscBrutto = validationState.warnings.find((warning) => warning.startsWith('Kwota brutto różni się'));
    if (rozbieznoscBrutto && !window.confirm(`${rozbieznoscBrutto}\n\nCzy mimo to zapisać wpis z podaną kwotą brutto?`)) {
      return;
    }
    await onSave(buildPayload());
  };

  const handleDelete = async () => {
    await onDelete(buildPayload());
  };

  const handleReset = async () => {
    await onReset(buildPayload());
  };

  const handleRestore = async () => {
    await onRestore(buildPayload());
  };

  const renderFormFields = () => {
    if (recordType === 'TRADE') {
      return (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <InputField label="Data" type="date" value={String(formValues.date || '')} onChange={(value) => updateField('date', value)} />
          <InputField label="Data rozliczenia" type="date" value={String(formValues.settlement_date || '')} onChange={(value) => updateField('settlement_date', value)} />
          <InputField label="Ticker" value={String(formValues.symbol || '')} onChange={(value) => updateField('symbol', value)} />
          <InputField label="ISIN" value={String(formValues.isin || '')} onChange={(value) => updateField('isin', value)} />
          <label className="block">
            <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">Strona</span>
            <select
              value={String(formValues.side || 'BUY')}
              onChange={(event) => updateField('side', event.target.value)}
              className="w-full rounded-2xl border border-gray-200 bg-white px-3 py-2.5 text-sm text-gray-900 outline-none transition focus:border-blue-500 dark:border-gray-700 dark:bg-gray-900 dark:text-white"
            >
              <option value="BUY">BUY</option>
              <option value="SELL">SELL</option>
            </select>
          </label>
          <InputField label="Klasa instrumentu" value={String(formValues.instrument_class || '')} onChange={(value) => updateField('instrument_class', value)} />
          <InputField label="Ilość" value={String(formValues.quantity || '')} onChange={(value) => updateField('quantity', value)} />
          <InputField label="Cena" value={String(formValues.price || '')} onChange={(value) => updateField('price', value)} />
          <InputField label="Kwota brutto" value={String(formValues.gross_amount || '')} onChange={(value) => updateField('gross_amount', value)} />
          <InputField label="Waluta transakcji" value={String(formValues.trade_currency || '')} onChange={(value) => updateField('trade_currency', value.toUpperCase())} />
          <InputField label="Prowizja" value={String(formValues.commission || '')} onChange={(value) => updateField('commission', value)} />
          <InputField label="Waluta prowizji" value={String(formValues.commission_currency || '')} onChange={(value) => updateField('commission_currency', value.toUpperCase())} />
          <InputField label="Rynek" value={String(formValues.market_id || '')} onChange={(value) => updateField('market_id', value)} />
          <InputField label="Kraj" value={String(formValues.country || '')} onChange={(value) => updateField('country', value)} />
          <InputField label="Kod typu instrumentu" value={String(formValues.instrument_type_code || '')} onChange={(value) => updateField('instrument_type_code', value)} />
          <label className="block md:col-span-2">
            <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">Komentarz</span>
            <textarea
              value={String(formValues.comment || '')}
              onChange={(event) => updateField('comment', event.target.value)}
              className="min-h-[88px] w-full rounded-2xl border border-gray-200 bg-white px-3 py-2.5 text-sm text-gray-900 outline-none transition focus:border-blue-500 dark:border-gray-700 dark:bg-gray-900 dark:text-white"
            />
          </label>
          <label className="block md:col-span-2">
            <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">Wiadomość</span>
            <textarea
              value={String(formValues.message || '')}
              onChange={(event) => updateField('message', event.target.value)}
              className="min-h-[88px] w-full rounded-2xl border border-gray-200 bg-white px-3 py-2.5 text-sm text-gray-900 outline-none transition focus:border-blue-500 dark:border-gray-700 dark:bg-gray-900 dark:text-white"
            />
          </label>
        </div>
      );
    }

    if (recordType === 'EVENT') {
      return (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <InputField label="Data" type="date" value={String(formValues.date || '')} onChange={(value) => updateField('date', value)} />
          <InputField label="Typ zdarzenia" value={String(formValues.event_kind || '')} onChange={(value) => updateField('event_kind', value)} />
          <InputField label="Ticker" value={String(formValues.symbol || '')} onChange={(value) => updateField('symbol', value)} />
          <InputField label="Kwota" value={String(formValues.amount || '')} onChange={(value) => updateField('amount', value)} />
          <InputField label="Waluta" value={String(formValues.currency || '')} onChange={(value) => updateField('currency', value.toUpperCase())} />
          <InputField label="Ilość" value={String(formValues.quantity || '')} onChange={(value) => updateField('quantity', value)} />
          <InputField label="Kraj" value={String(formValues.country || '')} onChange={(value) => updateField('country', value)} />
          <label className="block md:col-span-2">
            <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">Komentarz</span>
            <textarea
              value={String(formValues.comment || '')}
              onChange={(event) => updateField('comment', event.target.value)}
              className="min-h-[88px] w-full rounded-2xl border border-gray-200 bg-white px-3 py-2.5 text-sm text-gray-900 outline-none transition focus:border-blue-500 dark:border-gray-700 dark:bg-gray-900 dark:text-white"
            />
          </label>
          <label className="block md:col-span-2">
            <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">Wiadomość</span>
            <textarea
              value={String(formValues.message || '')}
              onChange={(event) => updateField('message', event.target.value)}
              className="min-h-[88px] w-full rounded-2xl border border-gray-200 bg-white px-3 py-2.5 text-sm text-gray-900 outline-none transition focus:border-blue-500 dark:border-gray-700 dark:bg-gray-900 dark:text-white"
            />
          </label>
        </div>
      );
    }

    return (
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <InputField label="Data przyznania" type="date" value={String(formValues.date || '')} onChange={(value) => updateField('date', value)} />
        <InputField label="Ticker" value={String(formValues.symbol || '')} onChange={(value) => updateField('symbol', value)} />
        <InputField label="Ilość" value={String(formValues.quantity || '')} onChange={(value) => updateField('quantity', value)} />
        <InputField label="Wartość rynkowa przy przyznaniu" value={String(formValues.grant_market_value || '')} onChange={(value) => updateField('grant_market_value', value)} />
        <InputField label="Waluta" value={String(formValues.currency || '')} onChange={(value) => updateField('currency', value.toUpperCase())} />
        <InputField label="Podstawa promocji" value={String(formValues.promotion_basis || '')} onChange={(value) => updateField('promotion_basis', value)} />
        <InputField label="Kraj" value={String(formValues.country || '')} onChange={(value) => updateField('country', value)} />
        <label className="block md:col-span-2">
          <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">Komentarz / dowód</span>
          <textarea
            value={String(formValues.comment || '')}
            onChange={(event) => updateField('comment', event.target.value)}
            className="min-h-[88px] w-full rounded-2xl border border-gray-200 bg-white px-3 py-2.5 text-sm text-gray-900 outline-none transition focus:border-blue-500 dark:border-gray-700 dark:bg-gray-900 dark:text-white"
          />
        </label>
      </div>
    );
  };

  return (
    <div ref={refEdytora} tabIndex={-1} role="dialog" aria-modal="true" aria-label="Edytor transakcji" className="outline-none fixed inset-0 z-50 bg-slate-950/60 backdrop-blur-sm">
      <div className="flex h-full w-full items-end justify-center p-0 md:items-center md:p-6">
        <div className="flex h-full w-full flex-col overflow-hidden bg-white shadow-2xl dark:bg-gray-950 md:h-[min(92vh,980px)] md:max-w-6xl md:rounded-[32px]">
          <div className="flex items-start justify-between gap-4 border-b border-gray-200 px-5 py-5 dark:border-gray-800 md:px-7">
            <div className="space-y-2">
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="text-2xl font-bold text-gray-900 dark:text-white">{title}</h2>
                {context.mode === 'edit' && (
                  <span className="inline-flex rounded-full bg-gray-100 px-3 py-1 text-xs font-semibold text-gray-700 dark:bg-gray-800 dark:text-gray-300">
                    {etykietaTypuRekordu(selectedRecord?.recordType || recordType)}
                  </span>
                )}
              </div>
              <div className="inline-flex items-center rounded-full bg-blue-50 px-3 py-1 text-xs font-semibold text-blue-700 dark:bg-blue-900/20 dark:text-blue-300">
                Po zapisie silnik przeliczy wyniki.
              </div>
            </div>
            <button
              aria-label="Zamknij"
              type="button"
              onClick={onClose}
              className="inline-flex h-11 w-11 items-center justify-center rounded-2xl border border-gray-200 text-gray-500 transition hover:bg-gray-50 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800"
            >
              <X size={18} />
            </button>
          </div>

          <div className="custom-scrollbar flex-1 overflow-y-auto px-5 py-5 md:px-7">
            <div className="space-y-6">
              {context.mode === 'new' && (
                <div className="rounded-3xl border border-gray-200 bg-gray-50 p-4 dark:border-gray-800 dark:bg-gray-900/60">
                  <h3 className="mb-3 text-sm font-bold uppercase tracking-wide text-gray-700 dark:text-gray-300">Typ nowej pozycji</h3>
                  <div className="flex flex-wrap gap-2">
                    {(['TRADE', 'EVENT', 'BONUS_CONTEST_SHARE'] as TypRekorduEdycji[]).map((entryType) => (
                      <button
                        key={entryType}
                        type="button"
                        onClick={() => handleSwitchRecordType(entryType)}
                        className={`rounded-2xl px-4 py-2.5 text-sm font-semibold transition ${
                          recordType === entryType
                            ? 'bg-blue-600 text-white'
                            : 'border border-gray-200 bg-white text-gray-700 hover:bg-gray-50 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-300 dark:hover:bg-gray-800'
                        }`}
                      >
                        {etykietaTypuRekordu(entryType)}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {showValidation && validationState && !validationState.isValid && (
                <div className="rounded-3xl border border-red-200 bg-red-50 p-4 dark:border-red-800/50 dark:bg-red-900/20">
                  <div className="flex items-start gap-3">
                    <AlertTriangle className="mt-0.5 text-red-700 dark:text-red-300" size={18} />
                    <div>
                      <p className="text-sm font-semibold text-red-800 dark:text-red-300">Nie można zapisać zmian.</p>
                      <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-red-700 dark:text-red-300">
                        {validationState.errors.map((error) => (
                          <li key={error}>{error}</li>
                        ))}
                      </ul>
                    </div>
                  </div>
                </div>
              )}

              {validationState?.warnings.length ? (
                <div className="rounded-3xl border border-amber-200 bg-amber-50 p-4 dark:border-amber-800/50 dark:bg-amber-900/20">
                  <ul className="list-disc space-y-1 pl-5 text-sm text-amber-700 dark:text-amber-300">
                    {validationState.warnings.map((warning) => (
                      <li key={warning}>{warning}</li>
                    ))}
                  </ul>
                </div>
              ) : null}

              <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1.4fr),minmax(320px,0.8fr)]">
                <section className="rounded-3xl border border-gray-200 bg-white p-5 dark:border-gray-800 dark:bg-gray-900/60">
                  <div className="mb-5 flex items-center gap-2">
                    <PencilLine size={18} className="text-blue-600" />
                    <h3 className="text-sm font-bold uppercase tracking-wide text-gray-700 dark:text-gray-300">Aktualna wersja</h3>
                  </div>
                  {renderFormFields()}
                </section>

                <div className="space-y-6">
                  <section className="rounded-3xl border border-gray-200 bg-white p-5 dark:border-gray-800 dark:bg-gray-900/60">
                    <h3 className="mb-4 text-sm font-bold uppercase tracking-wide text-gray-700 dark:text-gray-300">Dane z silnika</h3>
                    {context.mode === 'edit' && Object.keys(originalValues).length > 0 ? (
                      <div className="space-y-2 text-sm">
                        {Object.entries(originalValues).map(([fieldName, value]) => (
                          <div key={fieldName} className="grid grid-cols-[130px,1fr] gap-3">
                            <dt className="text-gray-500 dark:text-gray-400">{poleOpisowe(fieldName)}</dt>
                            <dd className="font-medium text-gray-900 dark:text-gray-200">{tekstWartosci(value)}</dd>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <p className="text-sm text-gray-500 dark:text-gray-400">
                        Nowa pozycja użytkownika nie ma bazowej wersji z silnika.
                      </p>
                    )}
                  </section>

                  <section className="rounded-3xl border border-gray-200 bg-white p-5 dark:border-gray-800 dark:bg-gray-900/60">
                    <h3 className="mb-4 text-sm font-bold uppercase tracking-wide text-gray-700 dark:text-gray-300">Różnice</h3>
                    {currentDiffs.length > 0 ? (
                      <div className="space-y-3">
                        {currentDiffs.map((diff) => (
                          <div key={diff.fieldName} className="rounded-2xl bg-gray-50 p-4 dark:bg-gray-950">
                            <p className="text-sm font-semibold text-gray-900 dark:text-gray-100">{poleOpisowe(diff.fieldName)}</p>
                            <div className="mt-3 grid gap-3 text-xs sm:grid-cols-2">
                              <div>
                                <p className="mb-1 font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">Wersja z silnika</p>
                                <div className="rounded-2xl bg-white px-3 py-2 text-gray-700 dark:bg-gray-800 dark:text-gray-300">
                                  {tekstWartosci(diff.originalValue)}
                                </div>
                              </div>
                              <div>
                                <p className="mb-1 font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">Wersja po zmianie</p>
                                <div className="rounded-2xl bg-blue-50 px-3 py-2 text-blue-700 dark:bg-blue-900/20 dark:text-blue-300">
                                  {tekstWartosci(diff.currentValue)}
                                </div>
                              </div>
                            </div>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <p className="text-sm text-gray-500 dark:text-gray-400">Brak różnic względem aktualnego źródła.</p>
                    )}
                  </section>
                </div>
              </div>
            </div>
          </div>

          <div className="flex shrink-0 flex-col gap-3 border-t border-gray-200 bg-white px-5 py-4 dark:border-gray-800 dark:bg-gray-950 md:flex-row md:items-center md:justify-between md:px-7">
            <div className="text-sm text-gray-500 dark:text-gray-400">
              {context.mode === 'edit'
                ? 'Edytujesz istniejącą pozycję z projekcji silnika i warstwy override.'
                : 'Dodajesz nową pozycję tylko do warstwy ręcznych zmian użytkownika.'}
            </div>
            <div className="flex flex-wrap justify-end gap-2">
              <button
                type="button"
                onClick={onClose}
                className="inline-flex items-center gap-2 rounded-2xl border border-gray-200 px-4 py-2.5 text-sm font-semibold text-gray-700 transition hover:bg-gray-50 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800"
              >
                Zamknij
              </button>
              {context.mode === 'edit' ? (
                <button
                  type="button"
                  onClick={handleReset}
                  className="inline-flex items-center gap-2 rounded-2xl border border-gray-200 px-4 py-2.5 text-sm font-semibold text-gray-700 transition hover:bg-gray-50 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800"
                >
                  <RefreshCcw size={16} />
                  Resetuj zmiany
                </button>
              ) : (
                <button
                  type="button"
                  onClick={handleDelete}
                  className="inline-flex items-center gap-2 rounded-2xl border border-red-200 px-4 py-2.5 text-sm font-semibold text-red-700 transition hover:bg-red-50 dark:border-red-800 dark:text-red-300 dark:hover:bg-red-900/20"
                >
                  <Trash2 size={16} />
                  Usuń nową transakcję
                </button>
              )}
              {context.mode === 'edit' && (
                isDeleted ? (
                  <button
                    type="button"
                    onClick={handleRestore}
                    className="inline-flex items-center gap-2 rounded-2xl border border-emerald-200 px-4 py-2.5 text-sm font-semibold text-emerald-700 transition hover:bg-emerald-50 dark:border-emerald-800 dark:text-emerald-300 dark:hover:bg-emerald-900/20"
                  >
                    <RefreshCcw size={16} />
                    Przywróć
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={handleDelete}
                    className="inline-flex items-center gap-2 rounded-2xl border border-red-200 px-4 py-2.5 text-sm font-semibold text-red-700 transition hover:bg-red-50 dark:border-red-800 dark:text-red-300 dark:hover:bg-red-900/20"
                  >
                    <Trash2 size={16} />
                    Oznacz jako usuniętą
                  </button>
                )
              )}
              <button
                type="button"
                onClick={handleSave}
                className="inline-flex items-center gap-2 rounded-2xl bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-blue-700"
              >
                <Save size={16} />
                Zapisz
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
