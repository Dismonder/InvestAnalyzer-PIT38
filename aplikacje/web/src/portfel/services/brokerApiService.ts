import { apiFetch } from "./apiTransport";
import { BinanceOrderLookupResult, BrokerAccount, BrokerConnectionTestResult, BrokerOrderPayload, BrokerOrderResult, BrokerSyncResult, Transaction } from '../types';

export interface BrokerGuideInfo {
  brokerType: BrokerAccount['brokerType'];
  title: string;
  subtitle: string;
  badge: string;
  badgeColor: string;
  requiredFields: Array<{
    key: string;
    label: string;
    placeholder: string;
    type: 'text' | 'password' | 'select';
    options?: Array<{ value: string; label: string }>;
    help: string;
  }>;
  steps: string[];
  securityNotes: string;
  officialDocUrl: string;
}

export const BROKER_GUIDES: Record<string, BrokerGuideInfo> = {
  IBKR: {
    brokerType: 'IBKR',
    title: 'Interactive Brokers (IBKR Flex Web Service)',
    subtitle: 'Automatyczny import transakcji, dywidend i prowizji przez oficjalną usługę Flex Query',
    badge: 'Oficjalne API XML/REST',
    badgeColor: 'bg-red-600 text-white',
    requiredFields: [
      {
        key: 'apiKey',
        label: 'Flex Web Service Token',
        placeholder: 'np. 12345678901234567890',
        type: 'password',
        help: 'Wygenerowany w Portalu Klienta IBKR: Performance & Reports -> Flex Queries -> Flex Web Service Configuration',
      },
      {
        key: 'queryId',
        label: 'Flex Query ID (Numer Raportu)',
        placeholder: 'np. 984521',
        type: 'text',
        help: 'Identyfikator stworzonego zapytania Flex Query zawierającego Trade Confirmations & Cash Transactions',
      },
      {
        key: 'accountNumber',
        label: 'Numer Konta IBKR (opcjonalnie)',
        placeholder: 'np. U8849201',
        type: 'text',
        help: 'Twój numer rachunku maklerskiego w IBKR',
      },
    ],
    steps: [
      'Zaloguj się do Interactive Brokers Client Portal (ibkr.com).',
      'Przejdź do: Performance & Reports -> Flex Queries.',
      'Kliknij ikonę koła zębatego obok "Flex Web Service" i włącz usługę, kopiując unikalny "Current Token".',
      'Utwórz nowy "Custom Flex Query" zaznaczając sekcje: Trades (Executions), Dividends (Cash Transactions) oraz Open Positions.',
      'Zapisz zapytanie i skopiuj jego "Query ID". Wklej Token i Query ID poniżej.',
    ],
    securityNotes:
      'Klucz Flex Web Service ma uprawnienia WYŁĄCZNIE do odczytu historii raportów (Read-Only). Nie umożliwia składania zleceń ani transferu środków.',
    officialDocUrl: 'https://www.interactivebrokers.com/en/software/am/am/reports/flex_web_service.htm',
  },
  BINANCE: {
    brokerType: 'BINANCE',
    title: 'Binance Crypto Spot API v3',
    subtitle: 'Bezpośrednia synchronizacja transakcji spotowych, par krypto-fiat oraz historii prowizji',
    badge: 'HMAC-SHA256 Live Feed',
    badgeColor: 'bg-amber-500 text-slate-950 font-bold',
    requiredFields: [
      {
        key: 'apiKey',
        label: 'Binance API Key',
        placeholder: 'Wklej publiczny klucz API Key...',
        type: 'text',
        help: 'Wygenerowany w panelu API Management w Binance z zaznaczoną opcją "Enable Reading"',
      },
      {
        key: 'apiSecret',
        label: 'Binance API Secret',
        placeholder: 'Wklej tajny klucz API Secret...',
        type: 'password',
        help: 'Klucz prywatny HMAC-SHA256 wygenerowany wraz z kluczem publicznym',
      },
      {
        key: 'accountNumber',
        label: 'Nazwa / Identyfikator konta (opcjonalnie)',
        placeholder: 'np. Binance-Spot-Główne',
        type: 'text',
        help: 'Oznaczenie konta w Twoim portfelu',
      },
    ],
    steps: [
      'Zaloguj się na Binance.com i przejdź do Profil -> Zarządzanie API (API Management).',
      'Kliknij "Utwórz API" (Typ: Wygenerowany przez system) i nadaj mu etykietę, np. "PortfolioTaxLive".',
      'Potwierdź kodem 2FA.',
      'W uprawnieniach upewnij się, że zaznaczone jest TYLKO "Włącz odczyt" (Enable Reading). Zostaw odznaczone "Włącz handel" oraz "Wypłaty".',
      'Skopiuj API Key oraz API Secret i wklej w formularzu.',
    ],
    securityNotes:
      'Zalecamy ograniczenie uprawnień wyłącznie do Odczytu (Read-Only). Nigdy nie włączaj uprawnień wypłat ani transferów.',
    officialDocUrl: 'https://binance-docs.github.io/apidocs/spot/en/',
  },
  FREEDOM24: {
    brokerType: 'FREEDOM24',
    title: 'Freedom24 (Tradernet API & Wielometodowa Autoryzacja)',
    subtitle: 'Synchronizacja pozycji akcji USA/UE, euroobligacji, not strukturyzowanych, opcji i dywidend z Freedom24',
    badge: 'Tradernet API Multi-Auth',
    badgeColor: 'bg-blue-600 text-white',
    requiredFields: [
      {
        key: 'apiKey',
        label: 'Freedom24 Public API Key',
        placeholder: '32 znaki z panelu Tradernet API',
        type: 'text',
        help: 'Dostępny w ustawieniach konta Freedom24 -> Bezpieczeństwo i API',
      },
      {
        key: 'apiSecret',
        label: 'Freedom24 Secret Key',
        placeholder: '40 znaków z panelu Tradernet API',
        type: 'password',
        help: 'Tajny klucz do podpisywania zapytań HMAC-SHA256',
      },
      {
        key: 'accountNumber',
        label: 'Adres E-mail / Numer Konta',
        placeholder: 'np. twoj-email@przyklad.pl lub FR24-9021',
        type: 'text',
        help: 'Identyfikator logowania do konta Freedom24',
      },
    ],
    steps: [
      'Metoda 1 (Klucze API V2): Zaloguj się na tradernet.com -> Ustawienia -> Dostęp API -> Wygeneruj klucz publiczny i prywatny.',
      'Metoda 2 (E-mail + Hasło + SMS): Wybierz zakładkę E-mail + SMS i kliknij "Wyślij SMS", aby otworzyć sesję z kodem 2FA.',
      'Metoda 3 (Token SID): Wklej aktywny identyfikator sesji SID pobrany z ciasteczka lub nagłówków przeglądarki.',
      'Metoda 4 (Konto Demo): Wybierz tryb demo, aby bezpiecznie przetestować notowania i kalkulację portfela w środowisku sandbox.',
      'Metoda 5 (Raport Offline): Zaimportuj plik wyciągu operacji (CSV/PDF) z panelu Freedom24 bez wprowadzania poświadczeń.',
    ],
    securityNotes: 'Klucze API są przechowywane wyłącznie lokalnie w Twojej przeglądarce i służą do bezpiecznego odczytu danych PIT-38.',
    officialDocUrl: 'https://freedom24.com/tradernet-api',
  },
  XTB: {
    brokerType: 'XTB',
    title: 'XTB Brokerage (xStation5 xAPI)',
    subtitle: 'Bezpośrednia komunikacja z serwerami X-Trade Brokers przez protokół xAPI JSON-RPC',
    badge: 'xAPI v2 Protocol',
    badgeColor: 'bg-emerald-700 text-white',
    requiredFields: [
      {
        key: 'accountNumber',
        label: 'Login / ID Konta xStation',
        placeholder: 'np. 1234567 lub XTB-894120',
        type: 'text',
        help: 'Numer rachunku rzeczywistego lub demo w XTB',
      },
      {
        key: 'apiSecret',
        label: 'Hasło API / Token xAPI',
        placeholder: 'Hasło dostępowe do API xStation...',
        type: 'password',
        help: 'Hasło wygenerowane dla połączenia xAPI w panelu Pokój Inwestora',
      },
      {
        key: 'apiServerType',
        label: 'Typ Środowiska XTB',
        placeholder: 'REAL',
        type: 'select',
        options: [
          { value: 'REAL', label: 'Konto Rzeczywiste (Real Server)' },
          { value: 'DEMO', label: 'Konto Demonstracyjne (Demo Server)' },
        ],
        help: 'Wybierz serwer odpowiedni dla Twojego rachunku',
      },
    ],
    steps: [
      'Zaloguj się do Pokoju Inwestora na xtb.com.',
      'Przejdź do zakładki Narzędzia -> Dostęp API / xAPI.',
      'Wygeneruj hasło dostępowe do protokołu xAPI dla swojego rachunku maklerskiego.',
      'Wpisz numer konta (Login) oraz hasło API w formularzu i przetestuj połączenie.',
    ],
    securityNotes:
      'Aplikacja pobiera historię zamkniętych zleceń (akcje PLN/GPW, ETF-y zagraniczne, CFD) w celach podatkowych i analitycznych.',
    officialDocUrl: 'http://developers.xstore.pro/',
  },
  REVOLUT: {
    brokerType: 'REVOLUT',
    title: 'Revolut Trading & Crypto',
    subtitle: 'Import i automatyczna synchronizacja zestawień Revolut Trading (USD/EUR) oraz krypto',
    badge: 'Statement Sync',
    badgeColor: 'bg-purple-600 text-white',
    requiredFields: [
      {
        key: 'accountNumber',
        label: 'Identyfikator Konta Revolut',
        placeholder: 'np. REV-Trading-01',
        type: 'text',
        help: 'Identyfikator konta maklerskiego Revolut',
      },
    ],
    steps: [
      'W aplikacji Revolut przejdź do zakładki Inwestycje -> Więcej (...) -> Wyciągi.',
      'Pobierz miesięczne lub roczne zestawienie operacji handlowych.',
      'Możesz wkleić dane wyciągu lub użyć szybkiego importu CSV w aplikacji.',
    ],
    securityNotes: 'Dane są przetwarzane lokalnie w przeglądarce i walidowane z kursami NBP T-1.',
    officialDocUrl: 'https://www.revolut.com/',
  },
  EMAKLER: {
    brokerType: 'EMAKLER',
    title: 'mBank eMakler (GPW / Akcje Polskie)',
    subtitle: 'Rozliczanie transakcji GPW, obligacji i funduszy ETF z rachunku maklerskiego mBanku',
    badge: 'GPW Broker Direct',
    badgeColor: 'bg-amber-700 text-white',
    requiredFields: [
      {
        key: 'accountNumber',
        label: 'Numer Rachunku Inwestycyjnego mBank',
        placeholder: 'np. mB-GPW-9021',
        type: 'text',
        help: 'Twój numer rachunku w usłudze eMakler',
      },
    ],
    steps: [
      'Zaloguj się do serwisu transakcyjnego mBanku i wejdź w eMakler -> Historia -> Transakcje.',
      'Wygeneruj zestawienie operacji dla wybranego roku podatkowego.',
      'Skorzystaj z wbudowanego parsera wyciągów mBank lub synchronizuj stan konta.',
    ],
    securityNotes: 'Automatyczne przeliczanie prowizji maklerskich i rozliczeń KUP.',
    officialDocUrl: 'https://www.mbank.pl/indywidualny/inwestycje/emakler/',
  },
};

export interface TradernetKeyValidationResult {
  valid: boolean;
  warnings: string[];
  error?: string;
  diagnostics: {
    apiKeyLength: number;
    apiSecretLength: number;
    apiKeyPreview: string;
    apiSecretPreview: string;
    hasWhitespace: boolean;
    hasQuotes: boolean;
    isKeyHexOrBase64: boolean;
    isSecretHexOrBase64: boolean;
    possibleKeySwap: boolean;
  };
}

/**
 * Validates Tradernet / Freedom24 API key pairs and checks format, pairing, and potential input errors
 */
export function validateTradernetCredentials(apiKey?: string, apiSecret?: string): TradernetKeyValidationResult {
  const cleanKey = (apiKey || '').trim();
  const cleanSecret = (apiSecret || '').trim();
  const rawKey = apiKey || '';
  const rawSecret = apiSecret || '';

  const hasWhitespace = /\s/.test(rawKey) || /\s/.test(rawSecret);
  const hasQuotes = /['"`]/.test(rawKey) || /['"`]/.test(rawSecret);
  const isKeyHexOrBase64 = /^[a-zA-Z0-9_-]+$/.test(cleanKey);
  const isSecretHexOrBase64 = /^[a-zA-Z0-9_+=/-]+$/.test(cleanSecret);

  const warnings: string[] = [];
  let error: string | undefined;

  if (hasWhitespace) {
    warnings.push('Klucz API lub Secret zawiera niewidoczne białe znaki/spacje – zostały automatycznie oczyszczone.');
  }
  if (hasQuotes) {
    warnings.push('Wykryto cudzysłowy w polu klucza – usuń wszelkie znaki \' lub " skopiowane z instrukcji.');
  }

  // Length heuristics: Tradernet keys are usually 16-64 chars
  if (cleanKey.length > 0 && cleanKey.length < 8) {
    warnings.push(`Klucz API jest bardzo krótki (${cleanKey.length} znaków). Standardowy klucz Tradernet ma co najmniej 16-32 znaki.`);
  }
  if (cleanSecret.length > 0 && cleanSecret.length < 8) {
    warnings.push(`Klucz Secret jest bardzo krótki (${cleanSecret.length} znaków). Standardowy klucz Secret Tradernet ma 32-64 znaki.`);
  }

  // Check possible key swap (e.g. user pasted secret in public key field or both are identical)
  let possibleKeySwap = false;
  if (cleanKey.length > 0 && cleanSecret.length > 0 && cleanKey === cleanSecret) {
    possibleKeySwap = true;
    error = 'Klucz Publiczny i Klucz Prywatny (Secret) są identyczne. Podaj odrębny klucz API Key oraz Secret Key wygenerowany w Tradernet.';
  }

  const valid = Boolean(cleanKey && cleanSecret && !error);

  const apiKeyPreview = cleanKey.length > 6 ? `${cleanKey.slice(0, 4)}...${cleanKey.slice(-3)}` : (cleanKey ? '***' : 'Brak');
  const apiSecretPreview = cleanSecret.length > 6 ? `${cleanSecret.slice(0, 3)}...${cleanSecret.slice(-3)}` : (cleanSecret ? '***' : 'Brak');

  return {
    valid,
    warnings,
    error,
    diagnostics: {
      apiKeyLength: cleanKey.length,
      apiSecretLength: cleanSecret.length,
      apiKeyPreview,
      apiSecretPreview,
      hasWhitespace,
      hasQuotes,
      isKeyHexOrBase64,
      isSecretHexOrBase64,
      possibleKeySwap,
    },
  };
}

class BrokerApiService {
  /**
   * Test connection to broker API with rich diagnostics and error logging
   */
  /**
   * Rachunek bez API to nie awaria - nie ma powodu zglaszac tego w konsoli jako
   * bledu. W diagnostyce liczy sie to, co rzeczywiscie poszlo nie tak.
   */
  private czyBrakApi(kod?: string): boolean {
    return kod === 'BRAK_PUBLICZNEGO_API' || kod === 'IMPORT_NIEDOSTEPNY';
  }

  async testConnection(account: Partial<BrokerAccount>): Promise<BrokerConnectionTestResult> {
    const broker = account.brokerType || 'UNKNOWN';
    const startTime = performance.now();

    // Freedom24 production credentials live exclusively in local server files.
    // Do not validate, log, or serialize stale browser-stored values.
    if (broker === 'FREEDOM24') {
      try {
        const response = await apiFetch('/api/brokers/freedom24/auth-check', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
        });
        const data = await response.json();
        return {
          success: Boolean(data.success && data.authenticated),
          broker: 'FREEDOM24',
          message: data.success ? 'Uwierzytelnienie Freedom24 potwierdzone (lokalne klucze serwera).' : data.message,
          error: data.success ? undefined : data.message,
          errorCode: data.errorCode,
          latencyMs: Math.round(performance.now() - startTime),
        };
      } catch {
        return { success: false, broker: 'FREEDOM24', message: 'Nie udało się połączyć z lokalnym serwerem Freedom24.', error: 'Błąd sieci lokalnego serwera', latencyMs: Math.round(performance.now() - startTime) };
      }
    }

    console.group(`[BrokerApiService] 📡 Test Połączenia API: ${broker}`);
    console.log(`[BrokerApiService] Identyfikator konta:`, account.id || 'nowe_konto');
    console.log(`[BrokerApiService] Typ serwera:`, account.apiServerType || 'REAL');

    try {
      const response = await apiFetch('/api/brokers/test-connection', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          brokerType: account.brokerType,
          apiKey: account.apiKey?.trim(),
          apiSecret: account.apiSecret?.trim(),
          accountNumber: account.accountNumber?.trim(),
          queryId: account.queryId?.trim(),
          apiServerType: account.apiServerType || 'REAL',
        }),
      });

      const latencyMs = Math.round(performance.now() - startTime);
      const data = await response.json();

      if (data.success) {
        console.log(`[BrokerApiService] ✅ Sukces (${latencyMs}ms):`, data.message);
        if (data.diagnostics) {
          console.log(`[BrokerApiService] Diagnostyka serwera:`, data.diagnostics);
        }
      } else if (this.czyBrakApi(data.errorCode)) {
        console.info(`[BrokerApiService] ℹ️ Rachunek bez API (${latencyMs}ms):`, data.message);
      } else {
        console.error(`[BrokerApiService] ❌ Błąd odpowiedzi (${latencyMs}ms):`, {
          message: data.message,
          error: data.error,
          errorCode: data.errorCode,
          diagnostics: data.diagnostics,
        });
      }

      console.groupEnd();
      return {
        ...data,
        latencyMs: data.latencyMs ?? latencyMs,
      };
    } catch (err: any) {
      const latencyMs = Math.round(performance.now() - startTime);
      console.error(`[BrokerApiService] 💥 Błąd sieciowy podczas testu (${latencyMs}ms):`, err);
      console.groupEnd();
      return {
        success: false,
        message: `Błąd sieciowy podczas testowania połączenia: ${err.message}`,
        broker,
        error: err.message,
        diagnostics: {
          details: `Wyjątek sieciowy klienta: ${err.message}`,
        },
      };
    }
  }

  /**
   * Synchronize broker trades / executions via API with detailed diagnostics
   */
  async syncAccount(account: BrokerAccount): Promise<BrokerSyncResult> {
    const startTime = performance.now();

    if (account.brokerType === 'FREEDOM24') {
      const test = await this.testConnection({ brokerType: 'FREEDOM24' });
      return {
        success: test.success,
        accountId: account.id,
        broker: 'FREEDOM24',
        message: test.success ? 'Połączenie potwierdzone; pobieranie kompletu odbędzie się z lokalnych poświadczeń serwera.' : test.message,
        syncedTransactions: [],
        newTransactionsCount: 0,
        syncTime: new Date().toISOString(),
        error: test.error,
        errorCode: test.errorCode,
      };
    }
    console.group(`[BrokerApiService] 🔄 Synchronizacja Transakcji: ${account.name} (${account.brokerType})`);

    try {
      const response = await apiFetch('/api/brokers/sync', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          accountId: account.id,
          brokerType: account.brokerType,
          brokerName: account.name,
          ...(account.brokerType === 'IBKR' ? {
            apiKey: account.apiKey?.trim(),
            accountNumber: account.accountNumber?.trim(),
            queryId: account.queryId?.trim(),
          } : {}),
          ...(account.brokerType === 'BINANCE' ? {
            apiKey: account.apiKey?.trim(),
            apiSecret: account.apiSecret?.trim(),
            accountNumber: account.accountNumber?.trim(),
          } : {}),
          apiServerType: account.apiServerType || 'REAL',
          lastSyncDate: account.lastSyncAt,
        }),
      });

      const latencyMs = Math.round(performance.now() - startTime);
      const data = await response.json();

      if (data.success) {
        console.log(`[BrokerApiService] ✅ Pomyślnie zsynchronizowano ${data.syncedTransactions?.length || 0} pozycji (${latencyMs}ms).`);
        if (data.diagnostics) {
          console.log(`[BrokerApiService] Diagnostyka:`, data.diagnostics);
        }
      } else if (this.czyBrakApi(data.errorCode)) {
        console.info(`[BrokerApiService] ℹ️ Rachunek bez API (${latencyMs}ms):`, data.message);
      } else {
        console.error(`[BrokerApiService] ❌ Błąd synchronizacji (${latencyMs}ms):`, {
          message: data.message,
          error: data.error,
          errorCode: data.errorCode,
          diagnostics: data.diagnostics,
        });
      }

      console.groupEnd();
      return data;
    } catch (err: any) {
      const latencyMs = Math.round(performance.now() - startTime);
      console.error(`[BrokerApiService] 💥 Wyjątek sieciowy podczas synchronizacji (${latencyMs}ms):`, err);
      console.groupEnd();
      return {
        success: false,
        accountId: account.id,
        broker: account.brokerType,
        message: `Błąd podczas synchronizacji API: ${err.message}`,
        syncedTransactions: [],
        newTransactionsCount: 0,
        syncTime: new Date().toISOString(),
        error: err.message,
        diagnostics: {
          details: `Wyjątek klienta: ${err.message}`,
        },
      };
    }
  }

  /**
   * Place / Arm real protective Stop-Loss / Take-Profit order on connected broker
   */
  async createOrder(account: BrokerAccount, order: Omit<BrokerOrderPayload, 'accountId' | 'brokerType' | 'apiKey' | 'apiSecret' | 'accountNumber' | 'apiServerType'>): Promise<BrokerOrderResult> {
    if (account.brokerType === 'FREEDOM24') {
      return {
        success: false,
        broker: 'FREEDOM24',
        status: 'REJECTED',
        message: 'Zlecenia ochronne Freedom24 składaj przez potwierdzoną ścieżkę Freedom24 w oknie SL/TP.',
      };
    }
    try {
      const response = await apiFetch('/api/brokers/orders/create', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          confirm: order.confirm,
          newClientOrderId: order.newClientOrderId,
          accountId: account.id,
          brokerType: account.brokerType,
          brokerName: account.name,
          apiKey: account.apiKey,
          apiSecret: account.apiSecret,
          accountNumber: account.accountNumber,
          apiServerType: account.apiServerType || 'REAL',
          ticker: order.ticker,
          action: order.action,
          orderType: order.orderType,
          quantity: order.quantity,
          stopPrice: order.stopPrice,
          takeProfitPrice: order.takeProfitPrice,
          limitPrice: order.limitPrice,
          currency: order.currency,
          expiresAt: order.expiresAt,
          timeInForce: order.timeInForce || 'GTC',
        }),
      });

      const data = await response.json();
      return data;
    } catch (err: any) {
      const ambiguous = account.brokerType === 'BINANCE';
      return {
        success: false,
        broker: account.brokerType,
        status: ambiguous ? 'PENDING' : 'REJECTED',
        ...(ambiguous ? { ambiguous: true } : {}),
        message: ambiguous
          ? 'Nie wiadomo, czy Binance przyjął zlecenie — sprawdź listę zleceń przed ponowieniem.'
          : `Błąd podczas wysyłania zlecenia: ${err.message}`,
        error: err.message,
      };
    }
  }

  async checkBinanceOrder(account: BrokerAccount, ticker: string, clientOrderId: string): Promise<BinanceOrderLookupResult> {
    try {
      const response = await apiFetch('/api/brokers/orders/status', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          brokerType: account.brokerType,
          apiKey: account.apiKey,
          apiSecret: account.apiSecret,
          ticker,
          clientOrderId,
        }),
      });
      const data = await response.json();
      return {
        success: response.ok && data.success === true,
        found: data.found === true,
        definitive: data.definitive === true,
        order: data.order,
        message: data.message || 'Nie udało się potwierdzić statusu zlecenia Binance.',
      };
    } catch {
      return {
        success: false,
        found: false,
        message: 'Błąd połączenia podczas sprawdzania zlecenia Binance. Sprawdź zlecenia w Binance i ponów sprawdzenie.',
      };
    }
  }

  /**
   * Cancel protective order on broker
   */
  async cancelOrder(orderId: string, account: BrokerAccount, ticker?: string, confirm?: true): Promise<{ success: boolean; message: string }> {
    if (account.brokerType === 'FREEDOM24') {
      return { success: false, message: 'Zlecenia Freedom24 anuluj przez potwierdzoną listę aktywnych zleceń Freedom24.' };
    }
    try {
      const response = await apiFetch('/api/brokers/orders/cancel', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          confirm,
          orderId,
          accountId: account.id,
          brokerType: account.brokerType,
          brokerName: account.name,
          // Bez kluczy serwer nie ma czym anulowac zlecenia u brokera i moze
          // tylko powiedziec, ze go nie anulowal.
          apiKey: account.apiKey,
          apiSecret: account.apiSecret,
          ticker,
        }),
      });

      const data = await response.json();
      return data;
    } catch (err: any) {
      return {
        success: false,
        message: `Błąd podczas anulowania zlecenia: ${err.message}`,
      };
    }
  }

  /**
   * Get guide for broker
   */
  getBrokerGuide(brokerType: string): BrokerGuideInfo | undefined {
    return BROKER_GUIDES[brokerType];
  }
}

export const brokerApiService = new BrokerApiService();
