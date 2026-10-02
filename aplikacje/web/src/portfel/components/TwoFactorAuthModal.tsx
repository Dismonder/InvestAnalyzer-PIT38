import React, { useState, useEffect } from 'react';
import { TwoFactorState, Language } from '../types';
import { getTranslation } from '../i18n/translations';
import {
  Shield,
  ShieldCheck,
  Lock,
  Unlock,
  Key,
  QrCode,
  Copy,
  Check,
  AlertCircle,
  Smartphone,
} from 'lucide-react';
import { kodQrJakoDataUri, adresOtpauth } from '../services/kodQr';
import {
  generateSecret,
  generateBackupCodes,
  verifyTotpCode,
  saveTwoFactorCredentials,
  clearTwoFactorCredentials,
  hashBackupCode,
} from '../services/totp';

interface TwoFactorAuthModalProps {
  twoFactor: TwoFactorState;
  language: Language;
  onToggle2FA: (enable: boolean, updatedState?: Partial<TwoFactorState>) => void;
  onVerifyAndUnlock: (code: string) => boolean | Promise<boolean>;
  onLockSession: () => void;
}

export const TwoFactorAuthModal: React.FC<TwoFactorAuthModalProps> = ({
  twoFactor,
  language,
  onToggle2FA,
  onVerifyAndUnlock,
  onLockSession,
}) => {
  const t = getTranslation(language);
  const [copiedKey, setCopiedKey] = useState(false);
  const [verifyCode, setVerifyCode] = useState('');
  const [errorMsg, setErrorMsg] = useState('');
  const [successMsg, setSuccessMsg] = useState('');

  // Stan nowo generowanej konfiguracji 2FA dla procesu włączania
  const [setupSecret, setSetupSecret] = useState('');
  const [setupQrUrl, setSetupQrUrl] = useState('');
  const [setupBackupCodes, setSetupBackupCodes] = useState<string[]>([]);
  const [setupBackupHashes, setSetupBackupHashes] = useState<string[]>([]);

  // Zainicjalizuj unikalny losowy sekret Base32 i kody zapasowe przy włączaniu 2FA
  useEffect(() => {
    if (!twoFactor.isEnabled && !setupSecret) {
      const newSecret = generateSecret(20);
      // Prawdziwy, skanowalny kod QR z adresem otpauth. Wczesniej bylo tu tylko
      // ozdobne tlo z napisem "OCHRONA TOTP 2FA" - instrukcja kazala je
      // zeskanowac, a nie dalo sie tego zrobic zadna aplikacja. Kod powstaje w
      // przegladarce, wiec sekret nigdzie nie wychodzi.
      const newQrUrl = kodQrJakoDataUri(
        adresOtpauth(newSecret, 'PIT38TaxAdvisor', 'portfel-inwestora')
      );
      setSetupSecret(newSecret);
      setSetupQrUrl(newQrUrl);

      generateBackupCodes(4).then(({ plainCodes, hashedCodes }) => {
        setSetupBackupCodes(plainCodes);
        setSetupBackupHashes(hashedCodes);
      });
    }
  }, [twoFactor.isEnabled, setupSecret]);

  const displaySecret = twoFactor.isEnabled
    ? twoFactor.secret
    : setupSecret || twoFactor.secret;

  const displayQrUrl = twoFactor.isEnabled
    ? twoFactor.qrCodeUrl
    : setupQrUrl || twoFactor.qrCodeUrl;

  const displayBackupCodes =
    twoFactor.backupCodes && twoFactor.backupCodes.length > 0
      ? twoFactor.backupCodes
      : setupBackupCodes;

  const handleCopyKey = () => {
    navigator.clipboard.writeText(displaySecret);
    setCopiedKey(true);
    setTimeout(() => setCopiedKey(false), 2500);
  };

  const handleEnableSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMsg('');

    if (verifyCode.length !== 6 || !/^\d{6}$/.test(verifyCode)) {
      setErrorMsg('Wprowadź poprawny 6-cyfrowy kod z aplikacji Authenticator.');
      return;
    }

    const activeSecret = setupSecret || twoFactor.secret;
    const isValid = await verifyTotpCode(verifyCode, activeSecret, { window: 1 });

    if (!isValid) {
      setErrorMsg('Nieprawidłowy kod weryfikacyjny TOTP. Sprawdź czas w telefonie i spróbuj ponownie.');
      return;
    }

    // Wygeneruj hashe kodów zapasowych jeśli jeszcze nie były gotowe
    const finalBackupCodes = setupBackupCodes.length > 0 ? setupBackupCodes : twoFactor.backupCodes;
    const finalHashes =
      setupBackupHashes.length > 0
        ? setupBackupHashes
        : await Promise.all(finalBackupCodes.map((c) => hashBackupCode(c)));

    // Zapisz sekret i hashe w magazynie lokalnym
    saveTwoFactorCredentials({
      secret: activeSecret,
      backupCodeHashes: finalHashes,
      backupCodes: finalBackupCodes,
      qrCodeUrl: displayQrUrl,
    });

    onToggle2FA(true, {
      isEnabled: true,
      secret: activeSecret,
      qrCodeUrl: displayQrUrl,
      backupCodes: finalBackupCodes,
      backupCodeHashes: finalHashes,
      isLocked: false,
    });

    setSuccessMsg('✅ Dwuetapowa weryfikacja 2FA została pomyślnie aktywowana!');
    setVerifyCode('');
  };

  const handleDisable2FA = () => {
    clearTwoFactorCredentials();
    onToggle2FA(false, {
      isEnabled: false,
      isLocked: false,
    });
    setSuccessMsg('2FA zostało wyłączone.');
    setSetupSecret('');
    setSetupQrUrl('');
    setSetupBackupCodes([]);
    setSetupBackupHashes([]);
  };

  return (
    <div id="two-factor-auth-container" className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 bg-white dark:bg-slate-900 p-5 sm:p-6 rounded-2xl border border-slate-200 dark:border-slate-800 shadow-sm">
        <div>
          <h1 className="text-xl sm:text-2xl font-bold text-slate-900 dark:text-white flex items-center gap-2">
            <Shield className="w-6 h-6 text-blue-600" />
            <span>{t.twoFactorTitle}</span>
          </h1>
          <p className="text-xs sm:text-sm text-slate-500 dark:text-slate-400 mt-1">
            {t.twoFactorDesc}
          </p>
        </div>

        <div className="flex items-center gap-3">
          {twoFactor.isEnabled && (
            <button
              onClick={onLockSession}
              className="flex items-center gap-2 px-3.5 py-2 text-xs font-semibold rounded-xl bg-amber-50 dark:bg-amber-950/40 text-amber-700 dark:text-amber-300 border border-amber-200 dark:border-amber-800 hover:bg-amber-100 transition-all cursor-pointer"
            >
              <Lock className="w-4 h-4" />
              <span>{t.lockSession}</span>
            </button>
          )}

          <div
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-xl border text-xs font-semibold ${
              twoFactor.isEnabled
                ? 'bg-emerald-50 dark:bg-emerald-950/40 border-emerald-200 dark:border-emerald-800 text-emerald-700 dark:text-emerald-300'
                : 'bg-slate-100 dark:bg-slate-800 border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300'
            }`}
          >
            {twoFactor.isEnabled ? <ShieldCheck className="w-4 h-4" /> : <Shield className="w-4 h-4" />}
            <span>{twoFactor.isEnabled ? t.enabled : t.disabled}</span>
          </div>
        </div>
      </div>

      {successMsg && (
        <div className="p-4 rounded-xl bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-200 dark:border-emerald-800 text-emerald-700 dark:text-emerald-300 text-xs font-semibold">
          {successMsg}
        </div>
      )}

      {/* Main 2FA Configuration Card */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Step 1 & QR Code */}
        <div className="bg-white dark:bg-slate-900 p-5 sm:p-6 rounded-2xl border border-slate-200 dark:border-slate-800 shadow-sm space-y-4">
          <div className="flex items-center gap-2 pb-3 border-b border-slate-100 dark:border-slate-800">
            <Smartphone className="w-5 h-5 text-blue-600" />
            <h2 className="font-bold text-slate-900 dark:text-white text-base">
              1. Zeskanuj Kod w Aplikacji TOTP
            </h2>
          </div>

          <p className="text-xs text-slate-600 dark:text-slate-400">
            Otwórz aplikację Google Authenticator, Microsoft Authenticator lub 1Password na smartfonie i zeskanuj poniższy kod QR:
          </p>

          <div className="flex flex-col sm:flex-row items-center gap-5 p-4 rounded-2xl bg-slate-50 dark:bg-slate-800/40 border border-slate-200 dark:border-slate-700">
            <div className="p-2 bg-white rounded-xl shadow-xs shrink-0">
              {displayQrUrl ? (
                <img
                  src={displayQrUrl}
                  alt="Kod QR do aplikacji uwierzytelniającej"
                  className="w-36 h-36 rounded-lg"
                  referrerPolicy="no-referrer"
                />
              ) : (
                // Pusty `src` kazal przegladarce pobrac cala strone jeszcze raz
                // i konczyl sie ostrzezeniem w konsoli. Gdy kodu nie ma, lepiej
                // wprost powiedziec, co zrobic.
                <div className="w-36 h-36 rounded-lg bg-slate-100 dark:bg-slate-800 flex items-center justify-center p-3 text-center text-[11px] text-slate-500 dark:text-slate-400">
                  Kod QR pojawi się po wygenerowaniu nowego klucza — wyłącz i włącz 2FA ponownie.
                </div>
              )}
            </div>

            <div className="space-y-2 text-xs w-full">
              <div className="font-semibold text-slate-700 dark:text-slate-300">
                {t.manualSecretKey}
              </div>
              <div className="flex items-center gap-2 p-2 rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 font-mono text-xs text-slate-900 dark:text-white">
                <span className="truncate">{displaySecret}</span>
                <button
                  onClick={handleCopyKey}
                  className="p-1 hover:text-blue-600 text-slate-400 transition-colors ml-auto cursor-pointer"
                  title="Kopiuj klucz"
                >
                  {copiedKey ? <Check className="w-4 h-4 text-emerald-500" /> : <Copy className="w-4 h-4" />}
                </button>
              </div>
              <p className="text-[11px] text-slate-400">
                Wpisz ten kod ręcznie, jeśli nie możesz zeskanować kodu aparatem.
              </p>
            </div>
          </div>
        </div>

        {/* Step 2 & Activation Verification Form */}
        <div className="bg-white dark:bg-slate-900 p-5 sm:p-6 rounded-2xl border border-slate-200 dark:border-slate-800 shadow-sm space-y-4">
          <div className="flex items-center gap-2 pb-3 border-b border-slate-100 dark:border-slate-800">
            <Key className="w-5 h-5 text-blue-600" />
            <h2 className="font-bold text-slate-900 dark:text-white text-base">
              2. Weryfikacja i Aktywacja Ochrony
            </h2>
          </div>

          {!twoFactor.isEnabled ? (
            <form onSubmit={handleEnableSubmit} className="space-y-4 text-xs">
              <p className="text-slate-600 dark:text-slate-400">
                Wpisz wygenerowany 6-cyfrowy kod z aplikacji na telefonie, aby potwierdzić konfigurację:
              </p>

              <div>
                <label className="block font-semibold text-slate-700 dark:text-slate-300 mb-1.5">
                  6-cyfrowy kod TOTP (np. 123456):
                </label>
                <input aria-label="6-cyfrowy kod TOTP (np. 123456)"
                  type="text"
                  maxLength={6}
                  required
                  placeholder="000000"
                  value={verifyCode}
                  onChange={(e) => setVerifyCode(e.target.value.replace(/\D/g, ''))}
                  className="w-full text-center tracking-[0.5em] font-mono text-xl py-2.5 px-4 rounded-xl bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>

              {errorMsg && (
                <div className="p-3 rounded-xl bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-800 text-rose-600 text-xs">
                  {errorMsg}
                </div>
              )}

              <button
                type="submit"
                className="w-full py-2.5 rounded-xl bg-blue-600 hover:bg-blue-700 text-white font-semibold shadow-xs transition-all cursor-pointer"
              >
                {t.enable2FA}
              </button>
            </form>
          ) : (
            <div className="space-y-4 text-xs">
              <div className="p-4 rounded-xl bg-emerald-50 dark:bg-emerald-950/30 border border-emerald-200 dark:border-emerald-800 text-emerald-800 dark:text-emerald-200 flex items-start gap-2.5">
                <ShieldCheck className="w-5 h-5 text-emerald-600 shrink-0 mt-0.5" />
                <div>
                  <div className="font-bold">Ochrona dwuetapowa jest aktywna</div>
                  <div className="text-[11px] text-emerald-700 dark:text-emerald-300 mt-0.5">
                    Wszystkie dane podatkowe, transakcje oraz eksporty raportów są zabezpieczone Twoim kluczem TOTP.
                  </div>
                </div>
              </div>

              {/* Backup codes */}
              <div>
                <div className="font-semibold text-slate-800 dark:text-slate-200 mb-2">
                  {t.backupCodes}
                </div>
                <div className="grid grid-cols-2 gap-2">
                  {displayBackupCodes.map((code, idx) => (
                    <div
                      key={idx}
                      className="p-2 text-center rounded-lg bg-slate-100 dark:bg-slate-800 font-mono text-slate-800 dark:text-slate-200 border border-slate-200 dark:border-slate-700 text-xs"
                    >
                      {code}
                    </div>
                  ))}
                </div>
              </div>

              <button
                onClick={handleDisable2FA}
                className="w-full py-2 rounded-xl bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-800 text-rose-600 hover:bg-rose-100 font-semibold transition-all cursor-pointer"
              >
                {t.disable2FA}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
