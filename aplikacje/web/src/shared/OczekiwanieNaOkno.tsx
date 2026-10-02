import React, { useId } from 'react';
import { useZamknijEscape } from './useZamknijEscape';

/** Widoczny i mozliwy do anulowania stan doczytywania leniwego okna. */
export function OczekiwanieNaOkno({ onClose, language }: { onClose: () => void; language: 'pl' | 'en' }) {
  const ref = useZamknijEscape(true, onClose);
  const id = useId();
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div ref={ref} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby={id}
        className="w-full max-w-sm rounded-2xl border border-slate-200 bg-white p-6 text-center text-slate-900 shadow-xl dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100">
        <div role="status" className="flex items-center justify-center gap-3">
          <span aria-hidden="true" className="h-5 w-5 animate-spin rounded-full border-2 border-blue-500 border-t-transparent" />
          <p id={id}>{language === 'en' ? 'Loading window…' : 'Wczytywanie okna…'}</p>
        </div>
        <button type="button" onClick={onClose}
          className="mt-5 rounded-lg border border-slate-300 px-4 py-2 text-sm font-semibold hover:bg-slate-100 dark:border-slate-600 dark:hover:bg-slate-800">
          {language === 'en' ? 'Cancel' : 'Anuluj'}
        </button>
      </div>
    </div>
  );
}
