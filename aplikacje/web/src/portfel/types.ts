export type CurrencyCode = 'PLN' | 'USD' | 'EUR' | 'GBP' | 'CHF' | 'CAD' | 'NOK' | 'SEK' | 'JPY'
  | 'BTC' | 'ETH' | 'SOL' | 'ADA' | 'XRP' | 'DOGE' | 'DOT' | 'AVAX' | 'MATIC' | 'LTC'
  | 'BCH' | 'LINK' | 'UNI' | 'ATOM' | 'XLM' | 'TRX' | 'ETC' | 'FIL' | 'NEAR' | 'ALGO'
  | 'USDT' | 'USDC' | 'BUSD' | 'DAI' | 'TUSD' | 'BNB' | 'FDUSD' | 'USDP' | 'PYUSD'
  | 'EURC' | 'EURI' | 'AEUR' | 'XUSD' | 'SUI' | 'TON' | 'SHIB' | 'PEPE'
  | 'AAVE' | 'ARB' | 'OP' | 'APT' | 'INJ' | 'RENDER' | 'POL' | 'WIF' | 'BONK'
  | 'FET' | 'ICP' | 'HBAR' | 'VET' | 'USDD' | 'RLUSD';

export type AssetCategory = 'STOCK_PL' | 'STOCK_FOREIGN' | 'ETF' | 'CRYPTO' | 'BOND';

export type TransactionType = 'BUY' | 'SELL' | 'DIVIDEND' | 'FEE';

export interface BrokerAccount {
  id: string;
  name: string;
  brokerType: 'XTB' | 'IBKR' | 'FREEDOM24' | 'REVOLUT' | 'EMAKLER' | 'DEGIRO' | 'BINANCE' | 'CUSTOM';
  currency: CurrencyCode;
  accountNumber?: string;
  color: string;
  apiKey?: string;
  apiSecret?: string;
  apiServerType?: 'REAL' | 'DEMO';
  queryId?: string; // For IBKR Flex Query ID
  freedom24AuthMethod?: 'API_KEYS' | 'LOGIN_PASSWORD' | 'SMS_SESSION' | 'SESSION_TOKEN' | 'DEMO' | 'STATEMENT';
  sid?: string;
  loginEmail?: string;
  password?: string;
  smsCode?: string;
  isApiConnected?: boolean;
  lastSyncAt?: string;
  autoSync?: boolean;
  statusMessage?: string;
  lastError?: string;
  lastErrorCode?: string;
  lastSyncStatus?: 'SUCCESS' | 'ERROR' | 'IDLE' | 'SYNCING';
  diagnostics?: {
    endpoint?: string;
    protocolVariant?: string;
    testedAt?: string;
    latencyMs?: number;
    signatureVerified?: boolean;
    keyFormatValid?: boolean;
    keyPreview?: string;
    details?: string;
  };
}

export interface BrokerConnectionTestResult {
  success: boolean;
  message: string;
  latencyMs?: number;
  broker: string;
  accountInfo?: {
    accountNumber?: string;
    currency?: string;
    status?: string;
    permissions?: string[];
    balances?: Array<{ asset: string; free: number; locked: number }>;
    tradeCount?: number;
  };
  error?: string;
  errorCode?: string;
  diagnostics?: {
    endpoint?: string;
    protocolVariant?: string;
    signatureVerified?: boolean;
    keyFormatValid?: boolean;
    keyPreview?: string;
    attemptedEndpoints?: string[];
    requestSnippet?: string;
    details?: string;
  };
}

export interface BrokerSyncResult {
  success: boolean;
  accountId: string;
  broker: string;
  message: string;
  syncedTransactions: Transaction[];
  newTransactionsCount: number;
  syncTime: string;
  /**
   * Czego odczyt nie objal: pominiete salda i pozycje bez daty nabycia,
   * pary bez odpowiedzi. Wczesniej takie braki widzial tylko log serwera,
   * a uzytkownik czytal "Pobrano wszystkie dane".
  */
  ostrzezenia?: string[];
  /** Pary Binance, dla których wszystkie strony historii odczytano poprawnie. */
  completeSymbols?: string[];
  /** Pary Binance pominięte albo odczytane niekompletnie. */
  incompleteSymbols?: string[];
  error?: string;
  errorCode?: string;
  diagnostics?: {
    endpoint?: string;
    protocolVariant?: string;
    signatureVerified?: boolean;
    attemptedEndpoints?: string[];
    details?: string;
  };
}

export interface Transaction {
  id: string;
  accountId: string;
  ticker: string;
  name: string;
  category: AssetCategory;
  type: TransactionType;
  date: string; // YYYY-MM-DD or YYYY-MM-DDTHH:mm:ss
  quantity: number;
  pricePerUnit: number;
  currency: CurrencyCode;
  commission: number;
  commissionCurrency: CurrencyCode;
  notes?: string;
  // Foreign tax withheld for dividends (WHT in %)
  foreignTaxRate?: number;
  foreignTaxAmount?: number;
  // Custom NBP rate override if desired
  customExchangeRate?: number;
  customExchangeRateDate?: string;
  customExchangeRateTable?: string;
  /** Skad pochodzi wpis: z przebiegu silnika (dokumenty) czy dopisany recznie. */
  zrodlo?: 'SILNIK' | 'RECZNA';
  /** Wiersz z dokumentow brokera - poprawia sie go w historii silnika, nie tutaj. */
  tylkoOdczyt?: boolean;
  /** Kwota w PLN policzona przez silnik. */
  kwotaPLN?: number;
}

export interface NBPRate {
  currency: CurrencyCode;
  code: string;
  table: string;
  no: string;
  effectiveDate: string;
  mid: number;
}

export interface OpenLotDetail {
  buyTransactionId: string;
  buyDate: string;
  remainingQty: number;
  initialQty: number;
  pricePerUnit: number;
  currency: CurrencyCode;
  exchangeRate: number;
  exchangeDate: string;
  exchangeTable: string;
  costPLN: number;
  commissionPLN: number;
  /** Prowizja zakupu przypadająca na otwartą część partii, w walucie prowizji. */
  commissionOrig?: number;
  commissionCurrency?: CurrencyCode;
  accountId: string;
}

export interface OpenPosition {
  ticker: string;
  name: string;
  category: AssetCategory;
  currency: CurrencyCode;
  totalQuantity: number;
  avgBuyPrice: number;
  avgBuyPricePLN: number;
  totalCostPLN: number;
  openLotsCount: number;
  lots: OpenLotDetail[];
  accountIds: string[];
}

export interface MatchedBuyLot {
  buyTransactionId: string;
  buyDate: string;
  buyQuantity: number;
  buyPricePerUnit: number;
  buyCurrency: CurrencyCode;
  buyCommissionShare: number;
  buyExchangeRate: number;
  buyExchangeDate: string;
  buyExchangeTable: string;
  buyCostPLN: number;
  buyCommissionPLN: number;
  totalCostPLN: number;
}

export interface TaxRealizedGain {
  id: string;
  sellTransactionId: string;
  ticker: string;
  name: string;
  category: AssetCategory;
  accountId: string;
  sellDate: string;
  sellQuantity: number;
  sellPricePerUnit: number;
  sellCurrency: CurrencyCode;
  sellCommission: number;
  sellCommissionPLN: number;
  sellExchangeRate: number;
  sellExchangeDate: string;
  sellExchangeTable: string;
  revenuePLN: number;
  costPLN: number;
  profitPLN: number;
  taxYear: number;
  matchedBuyLots: MatchedBuyLot[];
}

export interface DividendTaxItem {
  id: string;
  transactionId: string;
  ticker: string;
  name: string;
  accountId: string;
  date: string;
  grossAmount: number;
  currency: CurrencyCode;
  exchangeRate: number;
  exchangeDate: string;
  exchangeTable: string;
  grossPLN: number;
  foreignTaxRate: number; // e.g. 15%
  foreignTaxPLN: number; // zapłacony podatek u źródła
    polishTaxDuePLN?: number; // wartość z silnika
    taxToPayInPolandPLN?: number; // kwota z silnika; brak wyniku oznacza brak liczby
  taxYear: number;
}

/**
 * Wynik rozliczenia podatkowego pokazywany na ekranach.
 *
 * Produkuje go `engineBridge.calculateTaxesWithEngine` na podstawie przebiegu
 * silnika. Typ stal wczesniej w `taxCalculator.ts` razem z druga, rownolegla
 * implementacja rozliczenia, ktorej nic juz nie wywolywalo.
 */
export interface TaxCalculationResult {
  realizedGains: TaxRealizedGain[];
  dividends: DividendTaxItem[];
  yearSummaries: Map<number, TaxYearSummary>;
  openPositions: OpenPosition[];
  unmatchedSalesWarnings: {
    transaction: Transaction;
    missingQuantity: number;
  }[];
  /** Ocena silnika: czy rozliczenie jest gotowe do zlozenia. Brak = nie wiadomo. */
  gotoweDoZlozenia?: boolean | null;
}

export interface TaxYearSummary {
  year: number;
  /**
   * Rok jest znany z danych, ale silnik jeszcze go nie przeliczyl. Interfejs
   * pokazuje wtedy kreske zamiast zer - zero podatku wygladajace jak wynik
   * rozliczenia jest gorsze niz brak liczby.
   */
  nieobliczony?: boolean;
  revenuePLN: number; // Przychód łączny (Część C)
  costsPLN: number; // Koszty uzyskania przychodów (Część C)
  incomePLN: number; // Dochód (Przychód - Koszty) jeśli > 0
  lossPLN: number; // Strata jeśli Koszty > Przychód
  taxDuePLN: number; // Należny podatek 19% z dochodu
  taxBeforeCreditPLN?: number; // Poz. 33, przed odliczeniem podatku zagranicznego
  taxBasePLN?: number; // Poz. 31, pełne złote z silnika
  pit8cRevenuePLN?: number; // Poz. 20 - kwota do wpisania w zeznaniu
  pit8cCostsPLN?: number; // Poz. 21 - kwota do wpisania w zeznaniu
  /**
   * Skad wzialy sie kwoty poz. 20 i 21.
   *
   * `informacja` - przepisane z otrzymanego PIT-8C (tak wypelnia sie wiersz 1
   * czesci C). `transakcje` - policzone przez aplikacje z operacji na
   * rachunkach polskich brokerow, czyli wartosc do porownania z informacja,
   * a nie kwota, ktora broker zglosil urzedowi.
   */
  pit8cZrodlo?: 'informacja' | 'transakcje';
  /** Kwoty policzone z transakcji - do porownania, gdy poz. 20 i 21 sa z informacji. */
  pit8cWyliczonyPrzychodPLN?: number;
  pit8cWyliczoneKosztyPLN?: number;
  foreignRevenuePLN?: number; // Poz. 22 (przychody bez PIT-8C, w tym zagraniczne)
  foreignCostsPLN?: number; // Poz. 23 (koszty do poz. 22)
  /**
   * Numery pozycji za broszurą MF do PIT-38 (za 2025 r.):
   * https://www.podatki.gov.pl/media/g5ebnm2e/broszura-do-pit-38-za-2025-r.pdf
   * Część E zaczyna się od poz. 36, a nie od 34 - poz. 34 i 35 należą jeszcze
   * do części D (podatek zapłacony za granicą i podatek należny z art. 30b
   * ust. 1). Numeracja 34-38 pochodzi z PIT-38(14) z 2019 r., przed dodaniem
   * wiersza ulgi IPO (poz. 24-25), który przesunął dalsze pozycje o dwa.
   */
  cryptoRevenuePLN?: number; // Poz. 36 (przychód ze zbycia walut wirtualnych)
  cryptoCostsPLN?: number; // Poz. 37 + 38 razem (koszty roku i z lat ubiegłych)
  cryptoCostsCurrentYearPLN?: number; // Poz. 37 (koszty poniesione w roku)
  cryptoCostsCarriedInPLN?: number; // Poz. 38 (koszty z lat ubiegłych)
  cryptoIncomePLN?: number; // Poz. 39 (dochód z części E)
  cryptoLossPLN?: number; // Poz. 40 (koszty do przeniesienia na rok następny)
  cryptoTaxDuePLN?: number; // Poz. 45 (podatek należny z części F)
  /** Załącznik PIT/ZG z silnika: państwo (z ISIN), dochód i podatek zapłacony za granicą. */
  pitZgRows?: Array<{ country: string; incomePLN: number; foreignTaxPLN: number }>;
  /**
   * Poz. 30: straty z lat ubiegłych faktycznie odliczone. Liczy je silnik
   * (`art30b.prior_year_loss_used_pln`) i tylko z nią podstawa opodatkowania
   * w poz. 31 wychodzi z różnicy poz. 28 - poz. 30.
   */
  priorYearLossUsedPLN?: number;
  dividendGrossPLN: number;
  dividendForeignTaxPLN: number;
  dividendCreditUsedPLN?: number; // Poz. 48 po limicie odliczenia
  dividendPolishTaxDuePLN: number;
  dividendTaxToPayPLN: number;
  totalTaxToPayPLN: number;
  formTaxToPayPLN?: number; // Poz. 51 z projekcji pakietu, jeśli dostępna
  transactionCount: number;
  brokerBreakdowns: {
    accountId: string;
    accountName: string;
    brokerType: string;
    revenuePLN: number;
    costsPLN: number;
    incomePLN: number;
    lossPLN: number;
  }[];
}

export interface LiveMarketQuote {
  ticker: string;
  name: string;
  category: AssetCategory;
  price: number;
  currency: CurrencyCode;
  /** `null`, gdy zrodlo nie podalo poprzedniego zamkniecia (brak zmiany dziennej to nie zmiana 0). */
  change24h: number | null;
  changePercent24h: number | null;
  /** `null`, gdy zrodlo nie podalo zakresu dnia ani obrotu. */
  high24h: number | null;
  low24h: number | null;
  volume24h: number | null;
  /** Pusta tablica znaczy "brak szeregu", nie "plaski kurs". */
  sparkline: number[];
  lastUpdated: string;
  /**
   * Rynek, na ktorym instrument jest notowany - NIE zrodlo tych danych.
   * Ekran notowan pisal "Rzeczywiste zrodlo: FREEDOM24" dla ceny pobranej
   * z Yahoo Finance, bo to pole bierze sie z tabeli instrumentow.
   */
  source: 'FREEDOM24' | 'TRADINGVIEW' | 'BINANCE' | 'COINGECKO' | 'GPW';
  /** Serwis, ktory faktycznie oddal to notowanie. */
  dostawcaDanych?: 'YAHOO_FINANCE' | 'BINANCE' | 'COINGECKO';
}

export interface PriceAlert {
  id: string;
  ticker: string;
  targetPrice: number;
  currency: CurrencyCode;
  condition: 'ABOVE' | 'BELOW' | 'PERCENT_CHANGE_UP' | 'PERCENT_CHANGE_DOWN';
  percentageThreshold?: number;
  isActive: boolean;
  isTriggered: boolean;
  triggeredAt?: string;
  message?: string;
  createdAt: string;
  expiresAt?: string;
  alertType?: 'PRICE' | 'STOP_LOSS' | 'TAKE_PROFIT';
}

export interface BrokerOrder {
  id: string;
  accountId: string;
  brokerType: BrokerAccount['brokerType'];
  brokerName?: string;
  ticker: string;
  orderType: 'STOP_LOSS' | 'TAKE_PROFIT' | 'OCO_BRACKET' | 'STOP_LIMIT';
  action: 'SELL' | 'BUY';
  quantity: number;
  stopPrice?: number;
  limitPrice?: number;
  takeProfitPrice?: number;
  currency: CurrencyCode;
  status: 'PENDING' | 'ARMED' | 'EXECUTED' | 'CANCELLED' | 'REJECTED';
  orderId?: string;
  clientOrderId?: string;
  createdAt: string;
  expiresAt?: string;
  message?: string;
  isApiOrder: boolean;
}

export interface BrokerOrderPayload {
  confirm?: true;
  newClientOrderId?: string;
  accountId: string;
  brokerType: BrokerAccount['brokerType'];
  brokerName?: string;
  apiKey?: string;
  apiSecret?: string;
  accountNumber?: string;
  apiServerType?: 'REAL' | 'DEMO';
  ticker: string;
  action: 'SELL' | 'BUY';
  orderType: 'STOP_LOSS' | 'TAKE_PROFIT' | 'OCO_BRACKET' | 'STOP_LIMIT';
  quantity: number;
  stopPrice: number;
  takeProfitPrice?: number;
  limitPrice?: number;
  currency: CurrencyCode;
  expiresAt?: string;
  timeInForce?: 'GTC' | 'DAY';
}

export interface BrokerOrderResult {
  success: boolean;
  ambiguous?: boolean;
  orderId?: string;
  clientOrderId?: string;
  broker: string;
  status: 'ARMED' | 'EXECUTED' | 'REJECTED' | 'PENDING';
  message: string;
  rawResponse?: any;
  error?: string;
}

export interface BinanceOrderLookupResult {
  success: boolean;
  found: boolean;
  definitive?: boolean;
  order?: { orderId: string; clientOrderId: string; status: string };
  message: string;
}

export interface TwoFactorState {
  isEnabled: boolean;
  secret: string;
  qrCodeUrl: string;
  backupCodes: string[];
  backupCodeHashes?: string[];
  usedBackupCodeHashes?: string[];
  isLocked: boolean;
  lastVerifiedAt?: string;
}

export type Language = 'pl' | 'en';
export type Theme = 'dark' | 'light';
