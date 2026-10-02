import React from 'react';
import { format, parseISO } from 'date-fns';
import { Clock3, Download, History, Redo2, RotateCcw, Undo2, X } from 'lucide-react';
import { describeOverrideOperation } from '../services/overrideHistory';
import type { HistoriaOperacjiOverride, SnapshotOverride } from '../services/overrideHistory';
import { useZamknijEscape } from '../../shared/useZamknijEscape';

interface OverrideHistoryPanelProps {
  isOpen: boolean;
  operationHistory: HistoriaOperacjiOverride[];
  snapshots: SnapshotOverride[];
  undoCount: number;
  redoCount: number;
  onClose: () => void;
  onUndo: () => void;
  onRedo: () => void;
  onRestoreSnapshot: (snapshotId: string) => void;
}

function formatDate(value?: string | null): string {
  if (!value) {
    return 'Brak daty';
  }
  try {
    return format(parseISO(value), 'dd.MM.yyyy HH:mm:ss');
  } catch {
    return value;
  }
}

function reasonLabel(reason: SnapshotOverride['reason']): string {
  switch (reason) {
    case 'autosave_timer':
      return 'Backup automatyczny';
    case 'delete':
      return 'Po usunięciu';
    case 'reset':
      return 'Po resecie';
    case 'restore':
      return 'Po przywróceniu';
    case 'pin':
      return 'Po przypięciu';
    case 'unpin':
      return 'Po odpięciu';
    case 'save':
    default:
      return 'Po zapisie';
  }
}

export function OverrideHistoryPanel({
  isOpen,
  operationHistory,
  snapshots,
  undoCount,
  redoCount,
  onClose,
  onUndo,
  onRedo,
  onRestoreSnapshot,
}: OverrideHistoryPanelProps) {
  useZamknijEscape(isOpen, onClose);
  if (!isOpen) {
    return null;
  }

  return (
    <>
      <div className="fixed inset-0 z-50 bg-slate-950/30 xl:hidden" onClick={onClose} />
      <aside className="fixed inset-y-0 right-0 z-50 flex w-full max-w-md flex-col border-l border-gray-200 bg-white shadow-2xl dark:border-gray-700 dark:bg-gray-900 xl:static xl:z-0 xl:max-w-none xl:rounded-3xl xl:border xl:border-gray-200 xl:shadow-sm dark:xl:border-gray-700">
        <div className="flex items-center justify-between border-b border-gray-200 px-5 py-4 dark:border-gray-700">
          <div>
            <h2 className="text-lg font-bold text-gray-900 dark:text-white">Historia zmian i kopie</h2>
            <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
              Cofaj, ponawiaj i przywracaj zapisane snapshoty warstwy ręcznych zmian.
            </p>
          </div>
          <button
            aria-label="Zamknij"
            type="button"
            onClick={onClose}
            className="inline-flex h-10 w-10 items-center justify-center rounded-2xl border border-gray-200 text-gray-500 transition hover:bg-gray-50 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800"
          >
            <X size={18} />
          </button>
        </div>

        <div className="grid grid-cols-2 gap-3 border-b border-gray-200 px-5 py-4 dark:border-gray-700">
          <button
            type="button"
            onClick={onUndo}
            disabled={undoCount === 0}
            className="inline-flex items-center justify-center gap-2 rounded-2xl bg-blue-600 px-4 py-3 text-sm font-semibold text-white transition hover:bg-blue-700 disabled:cursor-not-allowed disabled:bg-blue-300 dark:disabled:bg-blue-900/40"
          >
            <Undo2 size={16} />
            Cofnij
          </button>
          <button
            type="button"
            onClick={onRedo}
            disabled={redoCount === 0}
            className="inline-flex items-center justify-center gap-2 rounded-2xl border border-gray-200 px-4 py-3 text-sm font-semibold text-gray-700 transition hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800"
          >
            <Redo2 size={16} />
            Ponów
          </button>
          <div className="rounded-2xl bg-blue-50 px-4 py-3 dark:bg-blue-900/20">
            <p className="text-xs font-semibold uppercase tracking-wide text-blue-700 dark:text-blue-300">Operacje do cofnięcia</p>
            <p className="mt-1 text-2xl font-bold text-blue-900 dark:text-blue-200">{undoCount}</p>
          </div>
          <div className="rounded-2xl bg-gray-100 px-4 py-3 dark:bg-gray-800">
            <p className="text-xs font-semibold uppercase tracking-wide text-gray-600 dark:text-gray-400">Operacje do ponowienia</p>
            <p className="mt-1 text-2xl font-bold text-gray-900 dark:text-gray-100">{redoCount}</p>
          </div>
        </div>

        <div className="custom-scrollbar flex-1 overflow-y-auto px-5 py-5">
          <section className="space-y-4">
            <div className="flex items-center gap-2">
              <History size={16} className="text-blue-600" />
              <h3 className="text-sm font-bold uppercase tracking-wide text-gray-700 dark:text-gray-300">Ostatnie operacje</h3>
            </div>
            <div className="space-y-3">
              {operationHistory.length > 0 ? (
                [...operationHistory]
                  .reverse()
                  .map((entry) => (
                    <div key={entry.operationId} className="rounded-2xl border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-800">
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <p className="text-sm font-semibold text-gray-900 dark:text-white">{entry.description}</p>
                          <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                            {entry.recordKey || 'Cała warstwa override'}
                          </p>
                        </div>
                        <span className="inline-flex rounded-full bg-gray-100 px-2.5 py-1 text-[11px] font-semibold text-gray-700 dark:bg-gray-900 dark:text-gray-300">
                          {describeOverrideOperation(entry.kind)}
                        </span>
                      </div>
                      <div className="mt-3 inline-flex items-center gap-2 text-xs text-gray-500 dark:text-gray-400">
                        <Clock3 size={12} />
                        {formatDate(entry.createdAt)}
                      </div>
                    </div>
                  ))
              ) : (
                <div className="rounded-2xl border border-dashed border-gray-200 px-4 py-8 text-center text-sm text-gray-500 dark:border-gray-700 dark:text-gray-400">
                  Brak zapisanych operacji override.
                </div>
              )}
            </div>
          </section>

          <section className="mt-8 space-y-4">
            <div className="flex items-center gap-2">
              <Download size={16} className="text-emerald-600" />
              <h3 className="text-sm font-bold uppercase tracking-wide text-gray-700 dark:text-gray-300">Kopie zapasowe</h3>
            </div>
            <div className="space-y-3">
              {snapshots.length > 0 ? (
                snapshots.map((snapshot) => (
                  <div key={snapshot.snapshotId} className="rounded-2xl border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-800">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <p className="text-sm font-semibold text-gray-900 dark:text-white">{reasonLabel(snapshot.reason)}</p>
                        <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">{formatDate(snapshot.createdAt)}</p>
                      </div>
                      <button
                        type="button"
                        onClick={() => onRestoreSnapshot(snapshot.snapshotId)}
                        className="inline-flex items-center gap-2 rounded-xl border border-emerald-200 px-3 py-2 text-xs font-semibold text-emerald-700 transition hover:bg-emerald-50 dark:border-emerald-800 dark:text-emerald-300 dark:hover:bg-emerald-900/20"
                      >
                        <RotateCcw size={14} />
                        Przywróć
                      </button>
                    </div>
                    <dl className="mt-4 grid gap-2 text-xs text-gray-500 dark:text-gray-400">
                      <div className="grid grid-cols-[140px,1fr] gap-3">
                        <dt>Nadpisania</dt>
                        <dd className="font-medium text-gray-900 dark:text-gray-200">{snapshot.transactionOverrides.length}</dd>
                      </div>
                      <div className="grid grid-cols-[140px,1fr] gap-3">
                        <dt>Stos cofania</dt>
                        <dd className="font-medium text-gray-900 dark:text-gray-200">{snapshot.undoStack.length}</dd>
                      </div>
                      <div className="grid grid-cols-[140px,1fr] gap-3">
                        <dt>Stos ponawiania</dt>
                        <dd className="font-medium text-gray-900 dark:text-gray-200">{snapshot.redoStack.length}</dd>
                      </div>
                      <div className="grid grid-cols-[140px,1fr] gap-3">
                        <dt>Przypięcia</dt>
                        <dd className="font-medium text-gray-900 dark:text-gray-200">{snapshot.pinnedTransactionLinks.length}</dd>
                      </div>
                    </dl>
                  </div>
                ))
              ) : (
                <div className="rounded-2xl border border-dashed border-gray-200 px-4 py-8 text-center text-sm text-gray-500 dark:border-gray-700 dark:text-gray-400">
                  Brak kopii zapasowych warstwy override.
                </div>
              )}
            </div>
          </section>
        </div>
      </aside>
    </>
  );
}
