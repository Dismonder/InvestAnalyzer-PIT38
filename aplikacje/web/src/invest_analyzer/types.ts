export type TransactionType = 
  | 'buy' | 'sell' | 'deposit' | 'withdrawal' | 'fee' | 'dividend' | 'tax' 
  | 'currency_buy' | 'currency_sell' | 'deposit_open' | 'deposit_close'
  | 'position_open' | 'position_close' | 'swap' | 'block' | 'unblock' | 'maturity' | 'other'
  | 'gift_certificate' | 'trade_cancellation' | 'blockchain' | 'partial_maturity'
  | 'initial_margin' | 'fund_payment' | 'blik' | 'sbp' | 'digital_assets'
  | 'stock_dividend' | 'merger' | 'tax_agent' | 'stock_dividend_compensation'
  | 'conversion' | 'coupon' | 'variation_margin' | 'unblock_commission'
  | 'rights_distribution' | 'agent_reward' | 'payments_to_customer'
  | 'dvp' | 'sepa' | 'card' | 'agent_trade' | 'kassa' | 'commission_rebates'
  | 'recurrent_subscription' | 'dividend_compensation' | 'card_conversion_settlement'
  | 'sepa_instant' | 'swift' | 'spin_off' | 'split' | 'debt_coverage' | 'icc_commission'
  | 'system' | 'deposit_compensation' | 'storn_correction' | 'cashout' | 'crypto_withdrawal'
  | 'dividend_net' | 'interest';

export interface CpsFile {
  fileName: string;
  mime: string;
  extension: string;
  base64: string;
}

export interface Transaction {
  id: string;
  date: string; // ISO string
  account?: string;
  transactionId?: string; // trade_id or cps_id
  ticker?: string;
  isin?: string;
  type: TransactionType;
  originalTypeStr?: string;
  quantity?: number;
  price?: number;
  currency: string;
  amount: number;
  profit?: number;
  exchangeRate?: number;
  profitPln?: number;
  fee?: number;
  margin?: number; // Odsetki depozytowe pobrane/oddane w transakcji
  settlementDate?: string;
  comment?: string;
  fileId?: string; // Plik źródłowy albo identyfikator lokalnego importu
  
  // Pola pomocnicze z lokalnych raportów brokerskich / Tradernet
  cpsDocId?: number; // Powiązane z ORDER_TYPES
  statusId?: number; // Powiązane z ORDER_STATUSES
  signatureTypeId?: number; // Powiązane z SIGNATURE_TYPES
  rawApiCode?: string; // Surowy kod operacji z raportu, np. 'tax_agent'
  message?: string; // Szczegółowa wiadomość z historii zamówień
  attachedFiles?: CpsFile[]; // Pliki dowodowe z lokalnego raportu
}

export interface UserPortfolioData {
  rev: number;
  initMargin: number;
  activeSessions: number;
  // Inne pola z getOPQ mogą być tu mapowane
}

export interface ExchangeRate {
  date: string;
  currency: string;
  rate: number;
  rateType?: 'average' | 'bid' | 'ask';
}

export interface DailyBalance {
  date: string;
  balance: number;
  balancePln: number;
  pnl: number;
  pnlPln: number;
}

export interface YearlyStats {
  year: number;
  startBalance: number;
  endBalance: number;
  totalDeposits: number;
  totalWithdrawals: number;
  pnl: number;
  pnlPln: number;
  fees: number;
  feesPln: number;
  taxes: number;
  taxesPln: number;
  dividends: number;
  dividendsPln: number;
  netProfitPln: number;
  transactionCount: number;
  stockPnlPln?: number;
  currencyPnlPln?: number;
  depositPnlPln?: number;
}

export interface LogEntry {
  id: string;
  timestamp: string;
  level: 'info' | 'warn' | 'error';
  stage: 'LOAD FILE' | 'PARSE DATA' | 'CLASSIFY TRANSACTION' | 'CALCULATE BALANCE' | 'CALCULATE PROFIT' | 'VALIDATE DATA' | 'END PROCESS' | 'DEBUG PANEL' | 'CLEANUP' | 'ENGINE' | 'WARSTWA OVERRIDE' | 'AUTO_IMPORT';
  message: string;
  details?: unknown;
}

export interface ValidationResult {
  isValid: boolean;
  errors: string[];
  warnings: string[];
}

export interface FileInfo {
  name: string;
  type: string;
  size: number;
  loadedAt: string;
  recordCount: number;
  status: 'success' | 'error' | 'warning';
  isEnabled?: boolean;
}
