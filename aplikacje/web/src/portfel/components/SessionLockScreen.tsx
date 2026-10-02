import React, { useState } from 'react';
import { TwoFactorState, Language } from '../types';
import { getTranslation } from '../i18n/translations';
import { Lock, Shield, KeyRound, ArrowRight, AlertCircle } from 'lucide-react';
import { verifySessionUnlock } from '../services/totp';

interface SessionLockScreenProps {
  twoFactor: TwoFactorState;
  language: Language;
  onUnlock: (code: string) => boolean | Promise<boolean>;
}

export const SessionLockScreen: React.FC<SessionLockScreenProps> = ({
  twoFactor,
  language,
  onUnlock,
}) => {
  const t = getTranslation(language);
  const [code, setCode] = useState('');
  const [error, setError] = useState('');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    const cleanCode = code.trim();
    if (!cleanCode) return;

    try {
      const verification = await verifySessionUnlock(cleanCode, twoFactor);
      if (!verification.valid) {
        setError('Nieprawidłowy kod weryfikacyjny lub kod zapasowy.');
        return;
      }

      const success = await onUnlock(cleanCode);
      if (!success) {
        setError('Nieprawidłowy kod weryfikacyjny lub kod zapasowy.');
      }
    } catch {
      setError('Nieprawidłowy kod weryfikacyjny lub kod zapasowy.');
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/90 backdrop-blur-md">
      <div className="w-full max-w-md bg-white dark:bg-slate-900 rounded-3xl border border-slate-200 dark:border-slate-800 shadow-2xl p-8 text-center space-y-6 animate-in fade-in zoom-in-95 duration-200">
        <div className="w-16 h-16 rounded-2xl bg-blue-100 dark:bg-blue-950/80 text-blue-600 dark:text-blue-400 flex items-center justify-center mx-auto shadow-inner">
          <Lock className="w-8 h-8" />
        </div>

        <div className="space-y-1">
          <h2 className="text-xl font-bold text-slate-900 dark:text-white">
            {t.sessionLocked}
          </h2>
          <p className="text-xs text-slate-500 dark:text-slate-400">
            Dostęp do Twojego portfela i deklaracji podatkowych jest chroniony weryfikacją dwuetapową 2FA.
          </p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-2">
              {t.enterTotpCode}
            </label>
            <input
              type="text"
              required
              autoFocus
              placeholder="000000"
              maxLength={9}
              value={code}
              onChange={(e) => setCode(e.target.value)}
              className="w-full text-center tracking-[0.4em] font-mono text-2xl py-3 px-4 rounded-2xl bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>

          {error && (
            <div className="p-3 rounded-xl bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-800 text-rose-600 text-xs flex items-center justify-center gap-1.5">
              <AlertCircle className="w-4 h-4 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          <button
            type="submit"
            className="w-full py-3 rounded-2xl bg-blue-600 hover:bg-blue-700 text-white font-semibold text-sm shadow-md shadow-blue-500/20 flex items-center justify-center gap-2 transition-all cursor-pointer"
          >
            <span>{t.verifyUnlock}</span>
            <ArrowRight className="w-4 h-4" />
          </button>
        </form>

        <div className="text-[11px] text-slate-400 pt-2 border-t border-slate-100 dark:border-slate-800">
          Wskazówka: Możesz również użyć 8-cyfrowego kodu zapasowego (np. 8941-2094).
        </div>
      </div>
    </div>
  );
};
