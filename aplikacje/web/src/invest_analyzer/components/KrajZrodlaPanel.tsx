import React from 'react';
import { StorageService } from '../services/storage';
import { createTransactionOverride, type NadpisanieTransakcji } from '../services/transactionOverrides';
import type { EngineEditableRecord } from '../hooks/useTaxEngineRun';
import { KODY_KRAJOW_MF } from '../../portfel/data/kodyKrajowMf';

/**
 * Nadpisania sprzedaży instrumentu z krajem źródła dochodu (załącznik PIT/ZG).
 *
 * Wykup noty bez ISIN (np. DGT4016.JUN26) jest sprzedażą złożoną przez silnik ze
 * zdarzenia wykupu - nie ma go na liście historii, więc użytkownik nie mógł wpisać
 * kraju w edytorze i blokada PIT/ZG zostawała na zawsze. Nadpisanie niesie pełne
 * wartości rekordu (jak zapis z edytora) i ten sam identyfikator, więc późniejsza
 * edycja tego rekordu nie tworzy drugiego nadpisania.
 */
export function nadpisaniaKrajuZrodla(
  records: EngineEditableRecord[],
  symbol: string,
  kraj: string,
): NadpisanieTransakcji[] {
  const kod = kraj.trim().toUpperCase();
  const walor = symbol.trim().toUpperCase();
  if (!KODY_KRAJOW_MF.has(kod) || !walor) return [];
  return records
    .filter((record) =>
      record.record_type === 'TRADE'
      && !record.deleted
      // Sprzedaz dodana recznie nie ma rekordu bazowego - poprawia sie ja jako
      // ten sam nowy rekord, inaczej jej blokada PIT/ZG zostawala na zawsze.
      && (Boolean(record.base_record_id) || (record.overlay_status === 'NEW' && Boolean(record.manual_record_id)))
      && String(record.current_values?.symbol || '').trim().toUpperCase() === walor
      && String(record.current_values?.side || '').trim().toUpperCase() === 'SELL')
    .map((record) => createTransactionOverride({
      recordType: 'TRADE',
      mode: record.base_record_id ? 'override' : 'new',
      baseRecordId: record.base_record_id || null,
      manualRecordId: record.manual_record_id || `kraj-zrodla-${record.base_record_id}`,
      values: { ...record.current_values, country: kod },
      sourceLabel: 'Kraj źródła z kontroli PIT/ZG',
    }));
}

export function KrajZrodlaPanel({
  symbols,
  records,
  disabled,
  onRecalculate,
}: {
  symbols: string[];
  records: EngineEditableRecord[];
  disabled?: boolean;
  onRecalculate: () => void;
}) {
  const [kraje, setKraje] = React.useState<Record<string, string>>({});
  const [komunikat, setKomunikat] = React.useState<string | null>(null);
  const [zapisywanie, setZapisywanie] = React.useState(false);

  if (symbols.length === 0) return null;

  const zapisz = async () => {
    const wpisane = symbols.filter((symbol) => (kraje[symbol] || '').trim());
    const niepoprawne = wpisane.filter((symbol) => !KODY_KRAJOW_MF.has(kraje[symbol].trim().toUpperCase()));
    if (niepoprawne.length > 0) {
      setKomunikat(`Nieznany kod kraju dla: ${niepoprawne.join(', ')}. Wpisz dwuliterowy kod państwa emitenta (np. CY, LU, NL).`);
      return;
    }
    const nadpisania = wpisane.flatMap((symbol) => nadpisaniaKrajuZrodla(records, symbol, kraje[symbol]));
    if (nadpisania.length === 0) {
      setKomunikat('Nie znaleziono sprzedaży tych instrumentów w wyniku silnika - uzupełnij kraj w Historii transakcji.');
      return;
    }
    setZapisywanie(true);
    try {
      for (const nadpisanie of nadpisania) await StorageService.upsertTransactionOverride(nadpisanie);
      setKomunikat(null);
      onRecalculate();
    } finally {
      setZapisywanie(false);
    }
  };

  return (
    <div className="mt-3 space-y-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm dark:border-amber-900/60 dark:bg-amber-950/20" data-testid="kraj-zrodla-panel">
      <p className="font-semibold">Kraj źródła dochodu do załącznika PIT/ZG</p>
      {symbols.map((symbol) => (
        <label key={symbol} className="flex flex-wrap items-center gap-2">
          <span className="font-mono">{symbol}</span>
          <input
            value={kraje[symbol] || ''}
            maxLength={2}
            placeholder="np. CY"
            aria-label={`Kraj źródła dla ${symbol}`}
            disabled={disabled || zapisywanie}
            onChange={(event) => setKraje((obecne) => ({ ...obecne, [symbol]: event.target.value.toUpperCase() }))}
            className="w-20 rounded border border-gray-300 px-2 py-1 font-mono uppercase dark:border-gray-700 dark:bg-gray-900"
          />
        </label>
      ))}
      <p className="text-xs text-gray-600 dark:text-gray-300">
        Kod państwa emitenta (ISO, dwie litery). Zapis dodaje korektę sprzedaży w Historii transakcji - można ją tam cofnąć.
      </p>
      {komunikat && <p className="text-xs text-rose-700 dark:text-rose-300">{komunikat}</p>}
      <button
        type="button"
        disabled={disabled || zapisywanie}
        onClick={() => { void zapisz(); }}
        className="rounded bg-amber-700 px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50"
      >
        {zapisywanie ? 'Zapisywanie…' : 'Zapisz kraj i przelicz'}
      </button>
    </div>
  );
}
