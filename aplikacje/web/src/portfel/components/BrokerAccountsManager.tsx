import React, { useState } from 'react';
import { useZamknijEscape } from '../../shared/useZamknijEscape';
import { kolorTekstuNa } from '../../shared/kolorTekstu';
import { apiFetch } from '../services/apiTransport';
import {
  BrokerAccount,
  BrokerConnectionTestResult,
  BrokerSyncResult,
  CurrencyCode,
  Language,
  Transaction,
} from '../types';
import { getTranslation } from '../i18n/translations';
import { brokerApiService, BROKER_GUIDES, BrokerGuideInfo } from '../services/brokerApiService';
import { stanBleduKarty } from '../services/statusSynchronizacji';
import {
  Building2,
  Plus,
  RefreshCw,
  Key,
  CheckCircle2,
  AlertCircle,
  AlertTriangle,
  XCircle,
  Trash2,
  Edit,
  Shield,
  Zap,
  Globe,
  Lock,
  ExternalLink,
  Info,
  HelpCircle,
  Activity,
  Check,
  X,
  Server,
  ChevronDown,
  ChevronUp,
  Smartphone,
  KeyRound,
  FileSpreadsheet,
  PlayCircle,
  Send,
  FileText,
} from 'lucide-react';

interface BrokerAccountsManagerProps {
  accounts: BrokerAccount[];
  language: Language;
  onAddAccount: (acc: Omit<BrokerAccount, 'id'>) => void;
  onUpdateAccount: (acc: BrokerAccount) => void;
  onDeleteAccount: (id: string) => void;
  onSyncAccount: (id: string) => Promise<void>;
  onSyncAllAccounts?: () => Promise<void>;
  onImportTransactions?: (txs: Transaction[]) => void;
  onClearAllTransactions?: () => void;
  onResetAllData?: () => void;
  syncingAccountId: string | null;
  isSyncingAll?: boolean;
}

export const BrokerAccountsManager: React.FC<BrokerAccountsManagerProps> = ({
  accounts,
  language,
  onAddAccount,
  onUpdateAccount,
  onDeleteAccount,
  onSyncAccount,
  onSyncAllAccounts,
  onImportTransactions,
  onClearAllTransactions,
  onResetAllData,
  syncingAccountId,
  isSyncingAll = false,
}) => {
  const t = getTranslation(language);
  const [showAddModal, setShowAddModal] = useState(false);
  const [editingAccount, setEditingAccount] = useState<BrokerAccount | null>(null);
  const [showGuideModal, setShowGuideModal] = useState<string | null>(null);
  const [showResetConfirm, setShowResetConfirm] = useState(false);
  const refOknaResetu = useZamknijEscape(showResetConfirm, () => setShowResetConfirm(false));
  const refOknaRachunku = useZamknijEscape(showAddModal, () => setShowAddModal(false));
  const refOknaInstrukcji = useZamknijEscape(showGuideModal !== null, () => setShowGuideModal(null));

  // Form states
  const [name, setName] = useState('');
  const [brokerType, setBrokerType] = useState<BrokerAccount['brokerType']>('XTB');
  const [currency, setCurrency] = useState<CurrencyCode>('PLN');
  // Klucze do podpowiedzi bierzemy z rachunku zapisanego przez uzytkownika,
  // zeby nie trzymac sekretow w kodzie zrodlowym ani w zbudowanej paczce.
  const zapisanyRachunekFreedom24 = React.useMemo(
    () => accounts.find((konto) => konto.brokerType === 'FREEDOM24' && konto.apiKey && konto.apiSecret),
    [accounts]
  );

  const [accountNumber, setAccountNumber] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [apiSecret, setApiSecret] = useState('');
  const [queryId, setQueryId] = useState('');
  const [apiServerType, setApiServerType] = useState<'REAL' | 'DEMO'>('REAL');
  const [color, setColor] = useState('#10B981');
  const [autoSync, setAutoSync] = useState(true);

  // Freedom24 Multi-method Login States
  const [freedom24AuthMethod, setFreedom24AuthMethod] = useState<'API_KEYS' | 'LOGIN_PASSWORD' | 'SMS_SESSION' | 'SESSION_TOKEN' | 'DEMO' | 'STATEMENT'>('API_KEYS');
  const [freedom24Sid, setFreedom24Sid] = useState('');
  const [freedom24Email, setFreedom24Email] = useState('');
  const [freedom24Password, setFreedom24Password] = useState('');
  const [freedom24SmsCode, setFreedom24SmsCode] = useState('');
  const [isRequestingSms, setIsRequestingSms] = useState(false);
  const [smsNotice, setSmsNotice] = useState<string | null>(null);
  const [freedom24Phone, setFreedom24Phone] = useState('');
  const [smsAuthCodeId, setSmsAuthCodeId] = useState<number | null>(null);
  const [isLoggingIn, setIsLoggingIn] = useState(false);
  const [loginNotice, setLoginNotice] = useState<{ ok: boolean; text: string } | null>(null);

  // Testing connection state inside modal
  const [isTestingModalConnection, setIsTestingModalConnection] = useState(false);
  const [modalTestResult, setModalTestResult] = useState<BrokerConnectionTestResult | null>(null);

  // Card-specific test results & diagnostics toggle
  const [cardTestResults, setCardTestResults] = useState<Record<string, BrokerConnectionTestResult>>({});
  const [testingCardId, setTestingCardId] = useState<string | null>(null);
  const [expandedDetailsId, setExpandedDetailsId] = useState<string | null>(null);

  const activeGuide: BrokerGuideInfo | undefined = BROKER_GUIDES[brokerType];

  const handleOpenAdd = (type: BrokerAccount['brokerType'] = 'XTB') => {
    setBrokerType(type);
    setName(type === 'XTB' ? 'XTB Indywidualne' : type === 'IBKR' ? 'Interactive Brokers' : type === 'BINANCE' ? 'Binance Spot' : type === 'FREEDOM24' ? 'Freedom24' : 'Konto Maklerskie');
    setCurrency(type === 'BINANCE' || type === 'IBKR' || type === 'FREEDOM24' ? 'USD' : 'PLN');
    setAccountNumber('');
    setApiKey('');
    setApiSecret('');
    setQueryId('');
    setApiServerType('REAL');
    setFreedom24AuthMethod('API_KEYS');
    setFreedom24Sid('');
    setFreedom24Email('');
    setFreedom24Password('');
    setFreedom24SmsCode('');
    setSmsNotice(null);
    setColor(type === 'XTB' ? '#10B981' : type === 'IBKR' ? '#EF4444' : type === 'BINANCE' ? '#FBBF24' : type === 'FREEDOM24' ? '#3B82F6' : '#8B5CF6');
    setAutoSync(true);
    setEditingAccount(null);
    setModalTestResult(null);
    setShowAddModal(true);
  };

  const handleOpenEdit = (acc: BrokerAccount) => {
    setEditingAccount(acc);
    setName(acc.name);
    setBrokerType(acc.brokerType);
    setCurrency(acc.currency);
    setAccountNumber(acc.accountNumber || '');
    // Freedom24 credentials are server-local files; never rehydrate an old
    // browser-stored secret into a form.
    setApiKey(acc.brokerType === 'FREEDOM24' ? '' : acc.apiKey || '');
    setApiSecret(acc.brokerType === 'FREEDOM24' ? '' : acc.apiSecret || '');
    setQueryId(acc.queryId || '');
    setApiServerType(acc.apiServerType || 'REAL');
    setFreedom24AuthMethod(acc.freedom24AuthMethod || (acc.sid ? 'SESSION_TOKEN' : (acc.apiKey ? 'API_KEYS' : 'API_KEYS')));
    setFreedom24Sid(acc.sid || '');
    setFreedom24Email(acc.loginEmail || acc.accountNumber || '');
    setFreedom24Password('');
    setFreedom24SmsCode('');
    setSmsNotice(null);
    setColor(acc.color);
    setAutoSync(acc.autoSync ?? true);
    setModalTestResult(null);
    setShowAddModal(true);
  };

  // Dokumentacja Freedom24: `getAuthSms` przyjmuje numer telefonu i oddaje
  // identyfikator kodu, a `authBySms` zamienia kod z SMS-a na sesje.
  const handleRequestFreedom24Sms = async () => {
    if (!freedom24Phone.trim()) {
      setSmsNotice('Wprowadź numer telefonu przypisany do konta Freedom24 (np. +48123456789).');
      return;
    }
    setIsRequestingSms(true);
    setSmsNotice(null);
    setSmsAuthCodeId(null);
    try {
      const res = await apiFetch('/api/brokers/freedom24/auth/request-sms', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tel: freedom24Phone.trim() }),
      });
      const data = await res.json().catch(() => null);
      if (res.ok && data?.success && Number(data.authCodeId) > 0) setSmsAuthCodeId(Number(data.authCodeId));
      setSmsNotice(
        res.ok && data?.success
          ? data.message || 'Freedom24 wysłał kod. Wpisz go poniżej i kliknij „Zaloguj kodem SMS”.'
          : data?.message || `Nie udało się zamówić kodu SMS (HTTP ${res.status}).`
      );
    } catch {
      setSmsNotice('Nie udało się połączyć z serwerem aplikacji — kod SMS nie został zamówiony.');
    } finally {
      setIsRequestingSms(false);
    }
  };

  const zalogujFreedom24 = async (sciezka: string, tresc: Record<string, unknown>) => {
    setIsLoggingIn(true);
    setLoginNotice(null);
    try {
      // apiFetch: w aplikacji desktopowej zwykly fetch trafia w pliki aplikacji, nie w serwer.
      const res = await apiFetch(sciezka, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(tresc),
      });
      const data = await res.json().catch(() => null);
      const ok = Boolean(res.ok && data?.success && data?.session?.active);
      setLoginNotice({ ok, text: data?.message || (ok ? 'Sesja Freedom24 otwarta.' : `Logowanie nie powiodło się (HTTP ${res.status}).`) });
      if (ok) {
        // Hasla i kodu nie trzymamy w stanie dluzej, niz trwa logowanie.
        setFreedom24Password('');
        setFreedom24SmsCode('');
      }
    } catch {
      setLoginNotice({ ok: false, text: 'Nie udało się połączyć z serwerem aplikacji.' });
    } finally {
      setIsLoggingIn(false);
    }
  };

  const handleFreedom24PasswordLogin = () =>
    freedom24Email.trim() && freedom24Password
      ? zalogujFreedom24('/api/brokers/freedom24/auth/login', { login: freedom24Email.trim(), password: freedom24Password })
      : setLoginNotice({ ok: false, text: 'Podaj login (e-mail) i hasło do Freedom24.' });

  const handleFreedom24SmsLogin = () =>
    smsAuthCodeId && freedom24SmsCode.trim()
      ? zalogujFreedom24('/api/brokers/freedom24/auth/verify-sms', { authCodeId: smsAuthCodeId, smsCode: freedom24SmsCode.trim() })
      : setLoginNotice({ ok: false, text: 'Najpierw zamów kod SMS, potem wpisz go tutaj.' });

  const handleTestModalConnection = async () => {
    setIsTestingModalConnection(true);
    setModalTestResult(null);

    const res = await brokerApiService.testConnection({
      brokerType,
      apiKey: brokerType === 'FREEDOM24' && freedom24AuthMethod === 'SESSION_TOKEN' ? freedom24Sid : apiKey,
      apiSecret,
      accountNumber: brokerType === 'FREEDOM24' && freedom24AuthMethod === 'SMS_SESSION' ? freedom24Email : accountNumber,
      queryId,
      apiServerType: brokerType === 'FREEDOM24' && freedom24AuthMethod === 'DEMO' ? 'DEMO' : apiServerType,
    });

    setModalTestResult(res);
    setIsTestingModalConnection(false);
  };

  /** Odpowiedz mowiaca, ze dany rachunek po prostu nie ma API do odpytania. */
  const bezApi = (kod?: string): boolean =>
    kod === 'BRAK_PUBLICZNEGO_API' || kod === 'IMPORT_NIEDOSTEPNY';

  const handleTestCardConnection = async (acc: BrokerAccount) => {
    setTestingCardId(acc.id);
    const res = await brokerApiService.testConnection(acc);
    setCardTestResults((prev) => ({ ...prev, [acc.id]: res }));
    
    // Propagate test status to account object
    onUpdateAccount({
      ...acc,
      // Znacznik polaczenia ustawia wynik ostatniego testu, takze negatywny.
      // Wczesniej nieudany test zostawial poprzednia wartosc, wiec rachunek raz
      // oznaczony jako podlaczony pokazywal "Połączono z API (Live)" nawet po
      // tym, jak broker odrzucil klucze.
      isApiConnected: res.success === true,
      // Rachunek bez publicznego API nie jest w stanie bledu - dziala inaczej.
      // Zapisanie tu 'ERROR' zostawialoby na karcie czerwona plakietke "BŁĄD"
      // po kazdym odswiezeniu strony.
      lastSyncStatus: res.success ? 'SUCCESS' : bezApi(res.errorCode) ? 'IDLE' : 'ERROR',
      lastError: res.success || bezApi(res.errorCode) ? undefined : res.error || res.message,
      lastErrorCode: bezApi(res.errorCode) ? undefined : res.errorCode,
      statusMessage: res.message,
      diagnostics: res.diagnostics,
    });

    setTestingCardId(null);
  };

  const handleSave = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;

    // Wpisany klucz to jeszcze nie polaczenie. Plakietka "Połączono z API
    // (Live)" i data synchronizacji bralay sie z dlugosci tekstu w polu (>3
    // znaki) - do brokera nie szlo zadne zapytanie. Nowe konto zaczyna jako
    // niepolaczone; stan ustawia test polaczenia (`res.success === true`)
    // albo udana synchronizacja.
    const freedomData = brokerType === 'FREEDOM24' ? {
      freedom24AuthMethod,
      sid: freedom24AuthMethod === 'SESSION_TOKEN' ? freedom24Sid : undefined,
      loginEmail: freedom24AuthMethod === 'SMS_SESSION' ? freedom24Email : undefined,
      apiServerType: (freedom24AuthMethod === 'DEMO' ? 'DEMO' : apiServerType) as BrokerAccount['apiServerType'],
    } : {};

    const daneLogowaniaZmienione =
      editingAccount !== null &&
      (editingAccount.apiKey !== apiKey ||
        editingAccount.apiSecret !== apiSecret ||
        editingAccount.queryId !== queryId ||
        editingAccount.accountNumber !== accountNumber);

    if (editingAccount) {
      onUpdateAccount({
        ...editingAccount,
        name,
        brokerType,
        currency,
        accountNumber: brokerType === 'FREEDOM24' && freedom24AuthMethod === 'SMS_SESSION' ? freedom24Email : accountNumber,
        apiKey: brokerType === 'FREEDOM24' ? undefined : apiKey,
        apiSecret: brokerType === 'FREEDOM24' ? undefined : apiSecret,
        queryId,
        apiServerType,
        color,
        autoSync,
        // Zmiana danych logowania uniewaznia poprzedni wynik testu.
        isApiConnected: daneLogowaniaZmienione ? false : editingAccount.isApiConnected,
        ...freedomData,
      });
    } else {
      onAddAccount({
        name,
        brokerType,
        currency,
        accountNumber: brokerType === 'FREEDOM24' && freedom24AuthMethod === 'SMS_SESSION' ? freedom24Email : accountNumber,
        apiKey: brokerType === 'FREEDOM24' ? undefined : apiKey,
        apiSecret: brokerType === 'FREEDOM24' ? undefined : apiSecret,
        queryId,
        apiServerType,
        color,
        autoSync,
        isApiConnected: false,
        lastSyncAt: undefined,
        ...freedomData,
      });
    }
    setShowAddModal(false);
  };

  const connectedApiCount = accounts.filter((a) => a.isApiConnected).length;

  return (
    <div id="broker-accounts-container" className="space-y-6 animate-in fade-in duration-200">
      {/* Header with Stats & Quick Actions */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 bg-white dark:bg-slate-900 px-4 py-3 sm:px-5 sm:py-3.5 rounded-xl border border-slate-200 dark:border-slate-800 shadow-xs">
        <div>
          <h1 className="text-lg sm:text-xl font-bold text-slate-900 dark:text-white flex items-center gap-2">
            <Building2 className="w-5 h-5 text-blue-600 shrink-0" />
            <span>{language === 'pl' ? 'Konta Maklerskie' : 'Broker Accounts'}</span>
          </h1>
          <p className="text-xs text-slate-500 dark:text-slate-400">
            {accounts.length === 0
              ? 'Brak podłączonych kont maklerskich. Dodaj swoje konto przez API brokera.'
              : `Aktywne konta: ${accounts.length} (${connectedApiCount} z autoryzacją API)`}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-1.5 sm:gap-2 shrink-0 self-start sm:self-center">
          {onSyncAllAccounts && accounts.length > 0 && (
            <button
              id="btn-sync-all-brokers"
              onClick={onSyncAllAccounts}
              disabled={isSyncingAll}
              className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium rounded-lg bg-slate-100 hover:bg-slate-200 dark:bg-slate-800 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-200 border border-slate-200/80 dark:border-slate-700/80 transition-all cursor-pointer disabled:opacity-50"
              title="Synchronizuj wszystkie podłączone konta API"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${isSyncingAll ? 'animate-spin text-blue-600' : 'text-slate-500 dark:text-slate-400'}`} />
              <span>{isSyncingAll ? (language === 'pl' ? 'Synchronizacja...' : 'Syncing...') : (language === 'pl' ? 'Synchronizuj API' : 'Sync API')}</span>
            </button>
          )}

          {onResetAllData && (accounts.length > 0) && (
            <button
              onClick={() => setShowResetConfirm(true)}
              className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium rounded-lg bg-rose-50 hover:bg-rose-100 dark:bg-rose-950/40 dark:hover:bg-rose-900/60 text-rose-700 dark:text-rose-400 border border-rose-200/60 dark:border-rose-800/60 transition-all cursor-pointer"
              title="Wyczyść wszystkie konta i transakcje"
            >
              <Trash2 className="w-3.5 h-3.5" />
              <span>Wyczyść bazę</span>
            </button>
          )}

          <button
            id="btn-open-add-broker"
            onClick={() => handleOpenAdd('FREEDOM24')}
            className="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-semibold rounded-lg bg-blue-600 hover:bg-blue-500 text-white shadow-xs transition-all cursor-pointer active:scale-[0.98]"
          >
            <Plus className="w-3.5 h-3.5" />
            <span>{language === 'pl' ? 'Połącz Konto (API)' : 'Connect Account'}</span>
          </button>
        </div>
      </div>

      {/* Confirmation Modal for Reset */}
      {showResetConfirm && (
        <div ref={refOknaResetu} tabIndex={-1} role="dialog" aria-modal="true" aria-label="Wyczyść bazę rachunków" className="outline-none fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-xs">
          <div className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 p-6 max-w-sm w-full space-y-4 shadow-2xl">
            <h3 className="text-base font-bold text-slate-900 dark:text-white">
              Wyczyścić wszystkie dane?
            </h3>
            <p className="text-xs text-slate-600 dark:text-slate-400">
              Operacja usunie z bazy wszystkie konta maklerskie, historię transakcji i aktywne alerty.
            </p>
            <div className="flex items-center justify-end gap-2 pt-2">
              <button
                onClick={() => setShowResetConfirm(false)}
                className="px-3 py-1.5 text-xs font-medium rounded-lg bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300 hover:bg-slate-200"
              >
                Anuluj
              </button>
              <button
                onClick={() => {
                  onResetAllData?.();
                  setShowResetConfirm(false);
                }}
                className="px-3 py-1.5 text-xs font-bold rounded-lg bg-rose-600 hover:bg-rose-500 text-white"
              >
                Wyczyść Wszystko
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Empty State Onboarding */}
      {accounts.length === 0 ? (
        <div className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 p-8 sm:p-12 text-center space-y-6">
          <div className="w-16 h-16 rounded-2xl bg-blue-50 dark:bg-blue-950/50 border border-blue-200 dark:border-blue-800/60 flex items-center justify-center mx-auto text-blue-600 dark:text-blue-400">
            <Building2 className="w-8 h-8" />
          </div>
          <div className="max-w-md mx-auto space-y-2">
            <h2 className="text-lg font-bold text-slate-900 dark:text-white">
              Brak podłączonych kont maklerskich
            </h2>
            <p className="text-xs text-slate-500 dark:text-slate-400 leading-relaxed">
              Podłącz swoje rzeczywiste konto Freedom24, XTB, Interactive Brokers lub Binance, aby automatycznie pobrać transakcje, pozycje i rozliczyć podatek PIT-38 / ZG.
            </p>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 max-w-3xl mx-auto pt-2">
            <button
              onClick={() => handleOpenAdd('FREEDOM24')}
              className="p-4 rounded-xl border border-slate-200 dark:border-slate-800 hover:border-blue-500 dark:hover:border-blue-500 bg-slate-50/50 dark:bg-slate-800/50 hover:bg-blue-50/30 dark:hover:bg-blue-950/20 text-left transition-all cursor-pointer group"
            >
              <div className="font-bold text-sm text-slate-900 dark:text-white flex items-center justify-between">
                <span>Freedom24</span>
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-blue-100 dark:bg-blue-950 text-blue-800 dark:text-blue-300 font-mono">REST API</span>
              </div>
              <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-1">
                Klucze Tradernet API (Public + Secret)
              </p>
            </button>

            <button
              onClick={() => handleOpenAdd('XTB')}
              className="p-4 rounded-xl border border-slate-200 dark:border-slate-800 hover:border-emerald-500 dark:hover:border-emerald-500 bg-slate-50/50 dark:bg-slate-800/50 hover:bg-emerald-50/30 dark:hover:bg-emerald-950/20 text-left transition-all cursor-pointer group"
            >
              <div className="font-bold text-sm text-slate-900 dark:text-white flex items-center justify-between">
                <span>XTB</span>
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-100 dark:bg-emerald-950 text-emerald-800 dark:text-emerald-300 font-mono">xAPI</span>
              </div>
              <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-1">
                Login i hasło xAPI z Pokoju Inwestora
              </p>
            </button>

            <button
              onClick={() => handleOpenAdd('IBKR')}
              className="p-4 rounded-xl border border-slate-200 dark:border-slate-800 hover:border-rose-500 dark:hover:border-rose-500 bg-slate-50/50 dark:bg-slate-800/50 hover:bg-rose-50/30 dark:hover:bg-rose-950/20 text-left transition-all cursor-pointer group"
            >
              <div className="font-bold text-sm text-slate-900 dark:text-white flex items-center justify-between">
                <span>IBKR Pro</span>
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-rose-100 dark:bg-rose-950 text-rose-800 dark:text-rose-300 font-mono">Flex API</span>
              </div>
              <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-1">
                Flex Web Service Token & Query ID
              </p>
            </button>

            <button
              onClick={() => handleOpenAdd('BINANCE')}
              className="p-4 rounded-xl border border-slate-200 dark:border-slate-800 hover:border-amber-500 dark:hover:border-amber-500 bg-slate-50/50 dark:bg-slate-800/50 hover:bg-amber-50/30 dark:hover:bg-amber-950/20 text-left transition-all cursor-pointer group"
            >
              <div className="font-bold text-sm text-slate-900 dark:text-white flex items-center justify-between">
                <span>Binance</span>
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-100 dark:bg-amber-950 text-amber-800 dark:text-amber-300 font-mono">Spot v3</span>
              </div>
              <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-1">
                Klucz API Key & Secret (HMAC-256)
              </p>
            </button>
          </div>
        </div>
      ) : (
        /* Account Cards Grid */
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
        {accounts.map((acc) => {
          const isSyncingThis = syncingAccountId === acc.id || isSyncingAll;
          const isTestingThis = testingCardId === acc.id;
          const testResult = cardTestResults[acc.id];
          const isExpanded = expandedDetailsId === acc.id;

          const brakApi = bezApi(testResult?.errorCode);
          // Udany test API nie zaslania bledu synchronizacji (np. niepobranego kompletu danych).
          const { maBlad: hasError, komunikat: errorMessage, kod: errorCode, diagnostyka: diagnostics } =
            stanBleduKarty(acc, testResult, brakApi);

          return (
            <div
              key={acc.id}
              className={`min-w-0 bg-white dark:bg-slate-900 rounded-2xl border p-4 sm:p-5 shadow-xs flex flex-col justify-between space-y-4 relative overflow-hidden transition-all ${
                hasError
                  ? 'border-rose-300 dark:border-rose-800/80 shadow-rose-500/5'
                  : 'border-slate-200 dark:border-slate-800 hover:border-slate-300 dark:hover:border-slate-700'
              }`}
            >
              {/* Colored Top Accent Bar */}
              <div
                className="absolute top-0 left-0 right-0 h-1.5"
                style={{ backgroundColor: hasError ? '#EF4444' : acc.color }}
              />

              <div>
                <div className="flex items-start justify-between">
                  <div className="flex min-w-0 items-center gap-2.5">
                    <div
                      className="w-10 h-10 rounded-xl flex items-center justify-center font-bold shadow-xs shrink-0"
                      style={{ backgroundColor: hasError ? '#EF4444' : acc.color, color: kolorTekstuNa(hasError ? '#EF4444' : acc.color) }}
                    >
                      {acc.brokerType.slice(0, 3)}
                    </div>
                    <div className="min-w-0">
                      <h3 className="font-bold text-sm text-slate-900 dark:text-white flex flex-wrap items-center gap-x-1.5 gap-y-1">
                        <span className="min-w-0 break-words">{acc.name}</span>
                        {hasError && (
                          <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-bold bg-rose-100 dark:bg-rose-950 text-rose-600 border border-rose-200 dark:border-rose-800">
                            BŁĄD
                          </span>
                        )}
                      </h3>
                      <div className="break-all text-xs text-slate-400 font-mono">
                        {acc.accountNumber || 'Brak numeru ID'} • {acc.currency}
                      </div>
                    </div>
                  </div>

                  <div className="flex items-center gap-1">
                    <button
                      onClick={() => handleOpenEdit(acc)}
                      className="p-1.5 text-slate-400 hover:text-blue-600 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-lg transition-colors cursor-pointer"
                      title="Edytuj konto / klucze API"
                    >
                      <Edit className="w-3.5 h-3.5" />
                    </button>
                    <button
                      onClick={() => onDeleteAccount(acc.id)}
                      className="p-1.5 text-slate-400 hover:text-rose-600 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-lg transition-colors cursor-pointer"
                      title="Usuń konto"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>

                {/* API Status Box */}
                <div className="mt-4 p-3 rounded-xl bg-slate-50 dark:bg-slate-800/40 border border-slate-100 dark:border-slate-800 text-xs space-y-2.5">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <span className="text-slate-500 dark:text-slate-400 font-medium">Status Integracji:</span>
                    {hasError ? (
                      <span className="flex max-w-full items-center gap-1 text-rose-600 dark:text-rose-400 font-bold bg-rose-50 dark:bg-rose-950/60 px-2 py-0.5 rounded-md border border-rose-200 dark:border-rose-800">
                        <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
                        <span className="min-w-0 break-words">Błąd API{errorCode ? ` (${errorCode})` : ''}</span>
                      </span>
                    ) : acc.isApiConnected ? (
                      <span className="flex max-w-full items-center gap-1 text-emerald-600 dark:text-emerald-400 font-bold bg-emerald-50 dark:bg-emerald-950/60 px-2 py-0.5 rounded-md border border-emerald-200 dark:border-emerald-800">
                        <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />
                        <span className="min-w-0 break-words">Połączono z API (Live)</span>
                      </span>
                    ) : (
                      <span className="flex max-w-full items-center gap-1 text-slate-500 dark:text-slate-300 bg-slate-100 dark:bg-slate-800/80 px-2 py-0.5 rounded-md">
                        <AlertCircle className="w-3.5 h-3.5 shrink-0" />
                        <span className="min-w-0 break-words">Import Ręczny / CSV</span>
                      </span>
                    )}
                  </div>

                  {acc.brokerType === 'IBKR' && acc.queryId && (
                    <div className="flex items-center justify-between text-[11px] text-slate-500 font-mono">
                      <span>Flex Query ID:</span>
                      <span className="font-semibold text-slate-700 dark:text-slate-300">{acc.queryId}</span>
                    </div>
                  )}

                  {acc.brokerType === 'FREEDOM24' && (
                    <div className="flex items-center justify-between text-[11px] text-slate-500">
                      <span>Metoda Autoryzacji:</span>
                      <span className="font-semibold text-blue-600 dark:text-blue-400 font-mono">
                        {acc.freedom24AuthMethod === 'SMS_SESSION'
                          ? '📱 E-mail + SMS (2FA)'
                          : acc.freedom24AuthMethod === 'SESSION_TOKEN'
                          ? '🎫 Token Sesji (SID)'
                          : acc.freedom24AuthMethod === 'DEMO'
                          ? '🧪 Tryb Demo Sandbox'
                          : acc.freedom24AuthMethod === 'STATEMENT'
                          ? '📁 Wyciąg Offline'
                          : '🔑 Klucze API V2 (HMAC)'}
                      </span>
                    </div>
                  )}

                  {acc.lastSyncAt && (
                    <div className="text-[11px] text-slate-400 flex items-center justify-between">
                      <span>Ostatnia synchronizacja:</span>
                      <span className="font-mono">{new Date(acc.lastSyncAt).toLocaleString('pl-PL')}</span>
                    </div>
                  )}

                  {/* Visual Connection / Synchronization Error Indicator */}
                  {(hasError || brakApi) && errorMessage && (
                    <div
                      className={`p-2.5 rounded-xl border space-y-1.5 ${
                        brakApi
                          ? 'border-amber-200 dark:border-amber-900/60 bg-amber-50/90 dark:bg-amber-950/40 text-amber-900 dark:text-amber-200'
                          : 'border-rose-200 dark:border-rose-900/60 bg-rose-50/90 dark:bg-rose-950/40 text-rose-900 dark:text-rose-200'
                      }`}
                    >
                      <div
                        className={`flex items-center justify-between font-bold text-[11px] ${
                          brakApi ? 'text-amber-700 dark:text-amber-300' : 'text-rose-700 dark:text-rose-300'
                        }`}
                      >
                        <span className="flex items-center gap-1.5">
                          {brakApi ? (
                            <Info className="w-3.5 h-3.5 text-amber-600 shrink-0" />
                          ) : (
                            <XCircle className="w-3.5 h-3.5 text-rose-600 shrink-0" />
                          )}
                          <span>{brakApi ? 'Rachunek bez połączenia API' : 'Nieudana synchronizacja API'}</span>
                        </span>
                        {testResult?.latencyMs !== undefined && (
                          <span className="font-mono text-[10px] text-rose-500">{testResult.latencyMs} ms</span>
                        )}
                      </div>

                      <p
                        className={`text-[11px] leading-relaxed font-medium break-words ${
                          brakApi ? 'text-amber-800 dark:text-amber-200/90' : 'text-rose-800 dark:text-rose-200/90'
                        }`}
                      >
                        {errorMessage}
                      </p>

                      {/* Expandable Diagnostic Details */}
                      {diagnostics && (
                        <div className="pt-1">
                          <button
                            type="button"
                            onClick={() => setExpandedDetailsId(isExpanded ? null : acc.id)}
                            className="flex items-center gap-1 text-[10px] font-bold text-rose-700 dark:text-rose-400 hover:underline cursor-pointer"
                          >
                            <span>{isExpanded ? 'Ukryj szczegóły diagnostyczne' : 'Szczegóły techniczne (Diagnostyka)'}</span>
                            {isExpanded ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
                          </button>

                          {isExpanded && (
                            <div className="mt-1.5 p-2 rounded-lg bg-rose-100/60 dark:bg-rose-900/40 border border-rose-200 dark:border-rose-800 text-[10px] space-y-1 font-mono text-rose-900 dark:text-rose-200">
                              {diagnostics.signatureVerified !== undefined && (
                                <div className="flex justify-between">
                                  <span>Sygnatura HMAC:</span>
                                  <span className={diagnostics.signatureVerified ? 'text-emerald-700 dark:text-emerald-400 font-bold' : 'text-rose-700 dark:text-rose-400 font-bold'}>
                                    {diagnostics.signatureVerified ? 'Wygenerowana pomyślnie' : 'Błąd generowania'}
                                  </span>
                                </div>
                              )}
                              {diagnostics.keyPreview && (
                                <div className="flex justify-between">
                                  <span>Klucz API:</span>
                                  <span>{diagnostics.keyPreview}</span>
                                </div>
                              )}
                              {diagnostics.endpoint && (
                                <div className="flex justify-between">
                                  <span>Endpoint:</span>
                                  <span className="truncate max-w-[140px]">{diagnostics.endpoint}</span>
                                </div>
                              )}
                              {diagnostics.protocolVariant && (
                                <div className="flex justify-between">
                                  <span>Wariant protokołu:</span>
                                  <span>{diagnostics.protocolVariant}</span>
                                </div>
                              )}
                              {diagnostics.details && (
                                <div className="pt-0.5 text-slate-600 dark:text-slate-300 font-sans">
                                  {diagnostics.details}
                                </div>
                              )}
                            </div>
                          )}
                        </div>
                      )}

                      {!brakApi && (
                        <div className="pt-1 flex items-center justify-end">
                          <button
                            type="button"
                            onClick={() => handleOpenEdit(acc)}
                            className="text-[11px] font-bold text-rose-700 dark:text-rose-300 hover:text-rose-900 dark:hover:text-white underline cursor-pointer"
                          >
                            Popraw klucze API →
                          </button>
                        </div>
                      )}
                    </div>
                  )}

                  {/* Successful Test Result Banner */}
                  {testResult && testResult.success && (
                    <div className="p-2 rounded-xl text-[11px] border border-emerald-200 dark:border-emerald-800/80 bg-emerald-50 dark:bg-emerald-950/40 text-emerald-800 dark:text-emerald-300 leading-tight space-y-0.5">
                      <div className="flex items-center justify-between font-bold">
                        <span className="flex items-center gap-1.5">
                          <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600 shrink-0" />
                          <span>Test API Udany (Live Handshake)</span>
                        </span>
                        {testResult.latencyMs !== undefined && (
                          <span className="font-mono text-[10px] text-emerald-600">{testResult.latencyMs} ms</span>
                        )}
                      </div>
                      <p className="text-[10.5px] text-emerald-700 dark:text-emerald-300">{testResult.message}</p>
                    </div>
                  )}
                </div>
              </div>

              {/* Action Buttons */}
              <div className="pt-2 flex items-center gap-2">
                <button
                  onClick={() => handleTestCardConnection(acc)}
                  disabled={isTestingThis}
                  className="flex-1 flex items-center justify-center gap-1.5 py-2 px-2.5 text-xs font-semibold rounded-xl bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-300 transition-all cursor-pointer disabled:opacity-50"
                  title="Sprawdź poprawność autoryzacji z serwerem brokera"
                >
                  <Activity className={`w-3.5 h-3.5 ${isTestingThis ? 'animate-spin text-blue-500' : 'text-slate-500'}`} />
                  <span>{isTestingThis ? 'Testowanie...' : 'Testuj API'}</span>
                </button>

                <button
                  onClick={() => onSyncAccount(acc.id)}
                  disabled={isSyncingThis}
                  className="flex-1 flex items-center justify-center gap-1.5 py-2 px-2.5 text-xs font-bold rounded-xl bg-blue-600 hover:bg-blue-500 text-white shadow-xs transition-all cursor-pointer disabled:opacity-50"
                  title="Pobierz najnowsze transakcje z konta maklerskiego"
                >
                  <RefreshCw className={`w-3.5 h-3.5 ${isSyncingThis ? 'animate-spin' : ''}`} />
                  <span>{isSyncingThis ? t.syncing : t.syncNow}</span>
                </button>
              </div>
            </div>
          );
        })}
      </div>
      )}

      {/* Add / Edit Broker Modal */}
      {showAddModal && (
        <div ref={refOknaRachunku} tabIndex={-1} role="dialog" aria-modal="true" aria-label="Rachunek maklerski" className="outline-none fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-xs overflow-y-auto">
          <div className="w-full max-w-lg max-h-[90vh] overflow-y-auto bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 shadow-2xl p-5 sm:p-6 space-y-4 animate-in fade-in zoom-in-95 duration-150">
            <div className="flex items-center justify-between border-b border-slate-100 dark:border-slate-800 pb-3">
              <div className="flex items-center gap-2">
                <div
                  className="w-8 h-8 rounded-lg flex items-center justify-center font-bold text-xs shadow-xs"
                  style={{ backgroundColor: color, color: kolorTekstuNa(color) }}
                >
                  {brokerType.slice(0, 3)}
                </div>
                <h2 className="text-base sm:text-lg font-bold text-slate-900 dark:text-white">
                  {editingAccount ? 'Konfiguracja Połączenia API' : 'Połącz z Brokerem (API)'}
                </h2>
              </div>
              <button
                onClick={() => setShowAddModal(false)}
                className="p-1 rounded-lg text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={handleSave} className="space-y-4 text-xs">
              {/* Broker Type Selection */}
              <div>
                <label className="block text-slate-700 dark:text-slate-300 font-bold mb-1.5">
                  Wybierz Brokera / Platformę
                </label>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                  {[
                    { id: 'XTB', label: 'XTB', badge: 'xAPI' },
                    { id: 'IBKR', label: 'IBKR Pro', badge: 'Flex API' },
                    { id: 'BINANCE', label: 'Binance', badge: 'Spot v3' },
                    { id: 'FREEDOM24', label: 'Freedom24', badge: 'REST' },
                    { id: 'REVOLUT', label: 'Revolut', badge: 'CSV' },
                    { id: 'EMAKLER', label: 'mBank eMakler', badge: 'GPW' },
                    { id: 'DEGIRO', label: 'DEGIRO', badge: 'Log' },
                    { id: 'CUSTOM', label: 'Inny', badge: 'Własny' },
                  ].map((b) => (
                    <button
                      key={b.id}
                      type="button"
                      onClick={() => {
                        setBrokerType(b.id as any);
                        if (!editingAccount) {
                          setName(b.id === 'XTB' ? 'XTB Indywidualne' : b.id === 'IBKR' ? 'Interactive Brokers' : b.id === 'BINANCE' ? 'Binance Spot' : b.id === 'FREEDOM24' ? 'Freedom24' : 'Konto Maklerskie');
                          setColor(b.id === 'XTB' ? '#10B981' : b.id === 'IBKR' ? '#EF4444' : b.id === 'BINANCE' ? '#FBBF24' : b.id === 'FREEDOM24' ? '#3B82F6' : '#8B5CF6');
                        }
                      }}
                      className={`p-2 rounded-xl border text-left flex flex-col justify-between transition-all cursor-pointer ${
                        brokerType === b.id
                          ? 'border-blue-600 bg-blue-50/70 dark:bg-blue-950/50 text-blue-700 dark:text-blue-300 font-bold shadow-xs'
                          : 'border-slate-200 dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-800 text-slate-700 dark:text-slate-300 font-medium'
                      }`}
                    >
                      <span>{b.label}</span>
                      <span className="text-[9px] font-mono opacity-70 mt-1">{b.badge}</span>
                    </button>
                  ))}
                </div>
              </div>

              {/* Guide Info Banner for selected broker */}
              {activeGuide && (
                <div className="p-3 rounded-xl bg-blue-50/60 dark:bg-blue-950/30 border border-blue-100 dark:border-blue-900/60 text-xs space-y-2">
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex items-center gap-1.5 font-bold text-blue-700 dark:text-blue-300">
                      <Zap className="w-3.5 h-3.5" />
                      <span>{activeGuide.title}</span>
                    </div>
                    <span className={`px-2 py-0.5 rounded text-[10px] font-bold ${activeGuide.badgeColor}`}>
                      {activeGuide.badge}
                    </span>
                  </div>
                  <p className="text-slate-600 dark:text-slate-300 text-[11px] leading-relaxed">
                    {activeGuide.subtitle}
                  </p>
                  <button
                    type="button"
                    onClick={() => setShowGuideModal(brokerType)}
                    className="text-[11px] font-bold text-blue-600 dark:text-blue-400 hover:underline flex items-center gap-1 cursor-pointer"
                  >
                    <HelpCircle className="w-3.5 h-3.5" />
                    <span>Jak wygenerować klucze API dla {brokerType}? (Instrukcja krok po kroku)</span>
                  </button>
                </div>
              )}

              {/* Basic Details */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-slate-700 dark:text-slate-300 font-medium mb-1">
                    Nazwa Własna Konta
                  </label>
                  <input aria-label="Nazwa Własna Konta"
                    type="text"
                    required
                    placeholder="np. XTB Indywidualne, IBKR Pro..."
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    className="w-full px-3 py-2 rounded-xl bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                </div>

                <div>
                  <label className="block text-slate-700 dark:text-slate-300 font-medium mb-1">
                    Waluta Bazowa Rachunku
                  </label>
                  <select aria-label="Waluta Bazowa Rachunku"
                    value={currency}
                    onChange={(e) => setCurrency(e.target.value as CurrencyCode)}
                    className="w-full px-3 py-2 rounded-xl bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-900 dark:text-white focus:outline-none"
                  >
                    <option value="PLN">PLN (Polski Złoty)</option>
                    <option value="USD">USD (Dolar amerykański)</option>
                    <option value="EUR">EUR (Euro)</option>
                    <option value="GBP">GBP (Funt szterling)</option>
                    <option value="CHF">CHF (Frank szwajcarski)</option>
                  </select>
                </div>
              </div>

              {/* Dynamic Credentials Fields based on Broker */}
              <div className="p-3.5 rounded-xl bg-slate-50 dark:bg-slate-800/40 border border-slate-200 dark:border-slate-700/80 space-y-3">
                <div className="flex items-center gap-1.5 font-bold text-slate-900 dark:text-white">
                  <Key className="w-3.5 h-3.5 text-blue-600" />
                  <span>Parametry Autoryzacji API ({brokerType})</span>
                </div>

                {brokerType === 'IBKR' ? (
                  <>
                    <div>
                      <label className="block text-slate-700 dark:text-slate-300 font-medium mb-1">
                        Flex Web Service Token
                      </label>
                      <input aria-label="Flex Web Service Token"
                        type="password"
                        placeholder="Wklej unikalny Flex Token z portalu IBKR..."
                        value={apiKey}
                        onChange={(e) => setApiKey(e.target.value)}
                        className="w-full px-3 py-2 rounded-xl bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500 font-mono"
                      />
                    </div>

                    <div>
                      <label className="block text-slate-700 dark:text-slate-300 font-medium mb-1">
                        Flex Query ID (Numer Raportu)
                      </label>
                      <input aria-label="Flex Query ID (Numer Raportu)"
                        type="text"
                        placeholder="np. 984521"
                        value={queryId}
                        onChange={(e) => setQueryId(e.target.value)}
                        className="w-full px-3 py-2 rounded-xl bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-900 dark:text-white focus:outline-none font-mono"
                      />
                    </div>
                  </>
                ) : brokerType === 'BINANCE' ? (
                  <>
                    <div>
                      <label className="block text-slate-700 dark:text-slate-300 font-medium mb-1">
                        Binance API Key
                      </label>
                      <input aria-label="Binance API Key"
                        type="text"
                        placeholder="Publiczny klucz API Key..."
                        value={apiKey}
                        onChange={(e) => setApiKey(e.target.value)}
                        className="w-full px-3 py-2 rounded-xl bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-900 dark:text-white focus:outline-none font-mono"
                      />
                    </div>

                    <div>
                      <label className="block text-slate-700 dark:text-slate-300 font-medium mb-1">
                        Binance API Secret (HMAC-SHA256)
                      </label>
                      <input aria-label="Binance API Secret (HMAC-SHA256)"
                        type="password"
                        placeholder="Tajny klucz Secret..."
                        value={apiSecret}
                        onChange={(e) => setApiSecret(e.target.value)}
                        className="w-full px-3 py-2 rounded-xl bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-900 dark:text-white focus:outline-none font-mono"
                      />
                    </div>
                  </>
                ) : brokerType === 'FREEDOM24' ? (
                  <div className="space-y-3">
                    {/* Method Selector Tabs */}
                    <div>
                      <label className="block text-slate-700 dark:text-slate-300 font-bold mb-1.5">
                        Wybierz Metodę Uwierzytelnienia Freedom24:
                      </label>
                      <div className="grid grid-cols-2 sm:grid-cols-3 gap-1.5">
                        {[
                          { id: 'API_KEYS', label: 'Klucze API V2', icon: KeyRound, desc: 'Bez SMS, HMAC-SHA256' },
                          // Kod SMS nie ma dokad trafic - Tradernet nie udostepnia
                          // polecenia otwierajacego sesje kodem, wiec ta metoda
                          // nie doprowadzi do polaczenia.
                          { id: 'LOGIN_PASSWORD', label: 'Login i hasło', icon: KeyRound, desc: 'Bez SMS, tylko podgląd' },
                          { id: 'SMS_SESSION', label: 'Telefon + kod SMS', icon: Smartphone, desc: 'Bez hasła, tylko podgląd' },
                          { id: 'SESSION_TOKEN', label: 'Token SID', icon: Key, desc: 'Cookie / Session ID' },
                          { id: 'DEMO', label: 'Konto Demo', icon: PlayCircle, desc: 'Środowisko testowe' },
                          { id: 'STATEMENT', label: 'Import Pliku', icon: FileSpreadsheet, desc: 'Raport CSV (Offline)' },
                        ].map((m) => {
                          const IconComp = m.icon;
                          const isSelected = freedom24AuthMethod === m.id;
                          return (
                            <button
                              key={m.id}
                              type="button"
                              onClick={() => setFreedom24AuthMethod(m.id as any)}
                              className={`p-2 rounded-xl border text-left flex flex-col justify-between transition-all cursor-pointer ${
                                isSelected
                                  ? 'border-blue-600 bg-blue-50/80 dark:bg-blue-950/60 text-blue-700 dark:text-blue-300 font-bold shadow-xs'
                                  : 'border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-750'
                              }`}
                            >
                              <div className="flex items-center gap-1.5">
                                <IconComp className="w-3.5 h-3.5 text-blue-500 shrink-0" />
                                <span className="text-[11px]">{m.label}</span>
                              </div>
                              <span className="text-[9px] text-slate-400 dark:text-slate-400 font-normal mt-0.5">
                                {m.desc}
                              </span>
                            </button>
                          );
                        })}
                      </div>
                    </div>

                    {/* Method 1: API Keys */}
                    {freedom24AuthMethod === 'API_KEYS' && (
                      <div className="space-y-3 p-3 rounded-xl bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700">
                        <div className="flex items-center gap-2 p-2 rounded-lg bg-blue-50/70 dark:bg-blue-950/40 border border-blue-200 dark:border-blue-800">
                          <div className="text-[11px] text-slate-600 dark:text-slate-300 flex items-center gap-1.5">
                            <Shield className="w-4 h-4 text-emerald-500 shrink-0" />
                            <span><strong>Klucze lokalne serwera.</strong> Przeglądarka nie przechowuje ani nie wysyła klucza prywatnego. Użyj „Test połączenia”, aby sprawdzić status skonfigurowano / niedostępne.</span>
                          </div>
                        </div>
                      </div>
                    )}

                    {/* Method 2: SMS Session (E-mail + Hasło + SMS) */}
                    {freedom24AuthMethod === 'LOGIN_PASSWORD' && (
                      <div className="space-y-3 p-3 rounded-xl bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700">
                        <div className="text-[11px] text-slate-500 dark:text-slate-400">
                          Logowanie loginem i hasłem (polecenie <code>authByLogin</code>) — bez SMS. Sesja otwiera się w trybie
                          <strong> tylko do podglądu</strong> i żyje w pamięci serwera aplikacji (do 12 godzin lub do restartu).
                          Hasło idzie wprost do Freedom24 i nie jest nigdzie zapisywane.
                        </div>
                        <div>
                          <label className="block text-slate-700 dark:text-slate-300 font-medium mb-1">Login (e-mail konta Freedom24)</label>
                          <input aria-label="Login (e-mail konta Freedom24)" type="email" autoComplete="username" value={freedom24Email} onChange={(e) => setFreedom24Email(e.target.value)} placeholder="twoj-email@przyklad.pl" className="w-full px-3 py-2 rounded-xl bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 text-slate-900 dark:text-white focus:outline-none" />
                        </div>
                        <div>
                          <label className="block text-slate-700 dark:text-slate-300 font-medium mb-1">Hasło</label>
                          <input aria-label="Hasło" type="password" autoComplete="current-password" value={freedom24Password} onChange={(e) => setFreedom24Password(e.target.value)} placeholder="Hasło do Freedom24" className="w-full px-3 py-2 rounded-xl bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 text-slate-900 dark:text-white focus:outline-none" />
                        </div>
                        <button type="button" onClick={() => void handleFreedom24PasswordLogin()} disabled={isLoggingIn} className="w-full px-3 py-2 rounded-xl bg-blue-600 hover:bg-blue-700 text-white font-semibold disabled:opacity-50 cursor-pointer">
                          {isLoggingIn ? 'Logowanie…' : 'Zaloguj (tylko podgląd)'}
                        </button>
                        {loginNotice && (
                          <div
                            className={`p-2 rounded-lg border text-[11px] ${
                              loginNotice.ok
                                ? 'bg-emerald-50 dark:bg-emerald-950/40 border-emerald-200 dark:border-emerald-800 text-emerald-800 dark:text-emerald-200'
                                : 'bg-amber-50 dark:bg-amber-950/50 border-amber-200 dark:border-amber-800 text-amber-800 dark:text-amber-200'
                            }`}
                          >
                            {loginNotice.text}
                          </div>
                        )}
                      </div>
                    )}

                    {freedom24AuthMethod === 'SMS_SESSION' && (
                      <div className="space-y-3 p-3 rounded-xl bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700">
                        <div className="text-[11px] text-slate-500 dark:text-slate-400 flex items-center gap-1">
                          <Smartphone className="w-3.5 h-3.5 text-blue-500 shrink-0" />
                          <span>
                            Logowanie kodem SMS (polecenia <code>getAuthSms</code> → <code>authBySms</code>) — bez hasła. Sesja tylko do
                            podglądu, w pamięci serwera aplikacji.
                          </span>
                        </div>
                        <div className="flex items-end gap-2">
                          <div className="flex-1">
                            <label className="block text-slate-700 dark:text-slate-300 font-medium mb-1">Numer telefonu konta Freedom24</label>
                            <input aria-label="Numer telefonu konta Freedom24" type="tel" autoComplete="tel" value={freedom24Phone} onChange={(e) => setFreedom24Phone(e.target.value)} placeholder="+48123456789" className="w-full px-3 py-2 rounded-xl bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 text-slate-900 dark:text-white focus:outline-none" />
                          </div>
                          <button type="button" onClick={() => void handleRequestFreedom24Sms()} disabled={isRequestingSms} className="px-3 py-2 rounded-xl border border-blue-500 text-blue-600 dark:text-blue-300 font-semibold disabled:opacity-50 cursor-pointer">
                            {isRequestingSms ? 'Wysyłanie…' : 'Wyślij SMS'}
                          </button>
                        </div>
                        {smsNotice && (
                          <div className="p-2 rounded-lg bg-amber-50 dark:bg-amber-950/50 border border-amber-200 dark:border-amber-800 text-amber-800 dark:text-amber-200 text-[11px]">
                            {smsNotice}
                          </div>
                        )}
                        <div>
                          <label className="block text-slate-700 dark:text-slate-300 font-medium mb-1">Kod z SMS-a</label>
                          <input aria-label="Kod z SMS-a" inputMode="numeric" autoComplete="one-time-code" value={freedom24SmsCode} onChange={(e) => setFreedom24SmsCode(e.target.value)} placeholder="np. 033333" disabled={!smsAuthCodeId} className="w-full px-3 py-2 rounded-xl bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 text-slate-900 dark:text-white focus:outline-none disabled:opacity-50" />
                        </div>
                        <button type="button" onClick={() => void handleFreedom24SmsLogin()} disabled={isLoggingIn || !smsAuthCodeId} className="w-full px-3 py-2 rounded-xl bg-blue-600 hover:bg-blue-700 text-white font-semibold disabled:opacity-50 cursor-pointer">
                          {isLoggingIn ? 'Logowanie…' : 'Zaloguj kodem SMS (tylko podgląd)'}
                        </button>
                        {loginNotice && (
                          <div
                            className={`p-2 rounded-lg border text-[11px] ${
                              loginNotice.ok
                                ? 'bg-emerald-50 dark:bg-emerald-950/40 border-emerald-200 dark:border-emerald-800 text-emerald-800 dark:text-emerald-200'
                                : 'bg-amber-50 dark:bg-amber-950/50 border-amber-200 dark:border-amber-800 text-amber-800 dark:text-amber-200'
                            }`}
                          >
                            {loginNotice.text}
                          </div>
                        )}
                      </div>
                    )}

                    {freedom24AuthMethod === 'SESSION_TOKEN' && (
                      <div className="space-y-3 p-3 rounded-xl bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700">
                        <div className="text-[11px] text-slate-500 dark:text-slate-400 flex items-center gap-1">
                          <Key className="w-3.5 h-3.5 text-purple-500 shrink-0" />
                          <span>Wklej aktywny token sesji SID (Session ID) pobrany z ciasteczka lub żądania sieciowego Tradernet.</span>
                        </div>
                        <div>
                          <label className="block text-slate-700 dark:text-slate-300 font-medium mb-1">
                            Identyfikator Sesji SID (Cookie SID)
                          </label>
                          <input aria-label="Identyfikator Sesji SID (Cookie SID)"
                            type="password"
                            placeholder="Wklej identyfikator SID sesji..."
                            value={freedom24Sid}
                            onChange={(e) => setFreedom24Sid(e.target.value)}
                            className="w-full px-3 py-2 rounded-xl bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 text-slate-900 dark:text-white focus:outline-none font-mono"
                          />
                        </div>
                      </div>
                    )}

                    {/* Method 4: Demo Account */}
                    {freedom24AuthMethod === 'DEMO' && (
                      <div className="p-3 rounded-xl bg-emerald-50/60 dark:bg-emerald-950/30 border border-emerald-200 dark:border-emerald-800/80 text-xs space-y-2">
                        <div className="flex items-center gap-2 font-bold text-emerald-700 dark:text-emerald-300">
                          <PlayCircle className="w-4 h-4" />
                          <span>Tryb Demo / Symulator Freedom24 (Sandbox)</span>
                        </div>
                        <p className="text-slate-600 dark:text-slate-300 text-[11px]">
                          Połączenie z serwerem demonstracyjnym Tradernet Demo. Umożliwia testowanie notowań w czasie rzeczywistym, składanie zleceń symulacyjnych i kalkulację podatku bez podawania prawdziwych danych konta.
                        </p>
                      </div>
                    )}

                    {/* Method 5: Statement / CSV Import */}
                    {freedom24AuthMethod === 'STATEMENT' && (
                      <div className="p-3 rounded-xl bg-blue-50/60 dark:bg-blue-950/30 border border-blue-200 dark:border-blue-800/80 text-xs space-y-2">
                        <div className="flex items-center gap-2 font-bold text-blue-700 dark:text-blue-300">
                          <FileSpreadsheet className="w-4 h-4" />
                          <span>Bezpieczny Tryb Importu Wyciągu (100% Prywatności Offline)</span>
                        </div>
                        <p className="text-slate-600 dark:text-slate-300 text-[11px]">
                          Nie musisz podawać żadnych kluczy ani haseł. Pobierz plik wyciągu operacji (CSV / XLSX / PDF) z panelu Freedom24 i zaimportuj go bezpośrednio w zakładce <strong>„Import CSV / Raportów”</strong>.
                        </p>
                      </div>
                    )}
                  </div>
                ) : (
                  <>
                    <div>
                      <label className="block text-slate-700 dark:text-slate-300 font-medium mb-1">
                        Numer Rachunku / Login / ID
                      </label>
                      <input aria-label="Numer Rachunku / Login / ID"
                        type="text"
                        placeholder="np. XTB-894120 lub Login..."
                        value={accountNumber}
                        onChange={(e) => setAccountNumber(e.target.value)}
                        className="w-full px-3 py-2 rounded-xl bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-900 dark:text-white focus:outline-none"
                      />
                    </div>

                    {brokerType === 'XTB' && (
                      <>
                        <div>
                          <label className="block text-slate-700 dark:text-slate-300 font-medium mb-1">
                            Hasło API / Token xAPI
                          </label>
                          <input aria-label="Hasło API / Token xAPI"
                            type="password"
                            placeholder="Hasło xAPI z Pokoju Inwestora..."
                            value={apiSecret}
                            onChange={(e) => setApiSecret(e.target.value)}
                            className="w-full px-3 py-2 rounded-xl bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-900 dark:text-white focus:outline-none"
                          />
                        </div>

                        <div>
                          <label className="block text-slate-700 dark:text-slate-300 font-medium mb-1">
                            Typ Serwera XTB
                          </label>
                          <select aria-label="Typ Serwera XTB"
                            value={apiServerType}
                            onChange={(e) => setApiServerType(e.target.value as any)}
                            className="w-full px-3 py-2 rounded-xl bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-900 dark:text-white focus:outline-none"
                          >
                            <option value="REAL">Serwer Rzeczywisty (Real Account)</option>
                            <option value="DEMO">Serwer Demonstracyjny (Demo Account)</option>
                          </select>
                        </div>
                      </>
                    )}
                  </>
                )}

                {/* Test Connection Button inside Modal */}
                <div className="pt-1">
                  <button
                    type="button"
                    onClick={handleTestModalConnection}
                    disabled={isTestingModalConnection}
                    className="w-full py-2 px-3 rounded-xl bg-slate-200 dark:bg-slate-700 hover:bg-slate-300 dark:hover:bg-slate-600 text-slate-800 dark:text-slate-100 font-bold flex items-center justify-center gap-2 transition-all cursor-pointer disabled:opacity-50"
                  >
                    <Activity className={`w-3.5 h-3.5 ${isTestingModalConnection ? 'animate-spin text-blue-500' : ''}`} />
                    <span>{isTestingModalConnection ? 'Wysyłanie zapytania testowego...' : '🧪 Testuj Połączenie API Teraz'}</span>
                  </button>

                  {modalTestResult && (
                    <div
                      className={`mt-2 p-2.5 rounded-xl border text-[11px] ${
                        modalTestResult.success
                          ? 'bg-emerald-50 dark:bg-emerald-950/40 border-emerald-200 dark:border-emerald-800 text-emerald-900 dark:text-emerald-200'
                          : 'bg-rose-50 dark:bg-rose-950/40 border-rose-200 dark:border-rose-800 text-rose-900 dark:text-rose-200'
                      }`}
                    >
                      <div className="font-bold flex items-center justify-between mb-1">
                        <span>{modalTestResult.success ? '✅ Połączenie Udane' : '❌ Błąd Autoryzacji'}</span>
                        {modalTestResult.latencyMs !== undefined && <span>{modalTestResult.latencyMs} ms</span>}
                      </div>
                      <p>{modalTestResult.message}</p>
                    </div>
                  )}
                </div>
              </div>

              {/* Modal Bottom Actions */}
              <div className="flex items-center justify-end gap-2 pt-2 border-t border-slate-100 dark:border-slate-800">
                <button
                  type="button"
                  onClick={() => setShowAddModal(false)}
                  className="px-4 py-2 rounded-xl text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 font-semibold cursor-pointer"
                >
                  Anuluj
                </button>
                <button
                  type="submit"
                  className="px-5 py-2 rounded-xl bg-blue-600 hover:bg-blue-500 text-white font-bold shadow-md shadow-blue-500/20 cursor-pointer"
                >
                  {editingAccount ? 'Zapisz Zmiany' : 'Połącz i Zapisz Konto'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Guide Tutorial Modal */}
      {showGuideModal && BROKER_GUIDES[showGuideModal] && (
        <div ref={refOknaInstrukcji} tabIndex={-1} role="dialog" aria-modal="true" aria-label="Instrukcja połączenia z brokerem" className="outline-none fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-xs">
          <div className="w-full max-w-lg max-h-[90vh] overflow-y-auto bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 shadow-2xl p-6 space-y-4 animate-in fade-in zoom-in-95 duration-150">
            <div className="flex items-center justify-between border-b border-slate-100 dark:border-slate-800 pb-3">
              <div className="flex items-center gap-2">
                <Shield className="w-5 h-5 text-blue-600" />
                <h3 className="font-bold text-base text-slate-900 dark:text-white">
                  Instrukcja API: {BROKER_GUIDES[showGuideModal].title}
                </h3>
              </div>
              <button
                onClick={() => setShowGuideModal(null)}
                className="p-1 rounded-lg text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="space-y-3 text-xs">
              <div className="p-3 rounded-xl bg-blue-50 dark:bg-blue-950/40 border border-blue-200 dark:border-blue-900 text-blue-800 dark:text-blue-300">
                <span className="font-bold block mb-1">🔐 Zasada Bezpieczeństwa (Read-Only):</span>
                <span>{BROKER_GUIDES[showGuideModal].securityNotes}</span>
              </div>

              <div className="space-y-2">
                <h4 className="font-bold text-slate-900 dark:text-white">Kroki konfiguracji:</h4>
                <ol className="list-decimal pl-4 space-y-1.5 text-slate-600 dark:text-slate-300">
                  {BROKER_GUIDES[showGuideModal].steps.map((step, idx) => (
                    <li key={idx} className="leading-relaxed">
                      {step}
                    </li>
                  ))}
                </ol>
              </div>

              <div className="pt-2">
                <a
                  href={BROKER_GUIDES[showGuideModal].officialDocUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1.5 text-blue-600 dark:text-blue-400 font-bold hover:underline"
                >
                  <ExternalLink className="w-3.5 h-3.5" />
                  <span>Oficjalna dokumentacja API brokera</span>
                </a>
              </div>
            </div>

            <div className="pt-2 flex justify-end">
              <button
                onClick={() => setShowGuideModal(null)}
                className="px-4 py-2 rounded-xl bg-blue-600 hover:bg-blue-500 text-white font-bold cursor-pointer"
              >
                Rozumiem, wróć do formularza
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
