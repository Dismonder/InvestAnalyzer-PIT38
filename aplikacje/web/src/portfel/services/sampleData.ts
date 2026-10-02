import { BrokerAccount, Transaction, PriceAlert, TwoFactorState, BrokerOrder } from '../types';

// Clean initial empty state for all users - strictly no fake accounts or fake transactions
export const INITIAL_ACCOUNTS: BrokerAccount[] = [];

export const INITIAL_TRANSACTIONS: Transaction[] = [];

export const INITIAL_ALERTS: PriceAlert[] = [];

export const INITIAL_BROKER_ORDERS: BrokerOrder[] = [];

// Stan poczatkowy jest pusty: sekret i kody zapasowe powstaja dopiero przy wlaczaniu 2FA
// (services/totp.ts). Staly sekret w kodzie oznaczalby, ze kazda instalacja ma ten sam klucz.
export const INITIAL_2FA: TwoFactorState = {
  isEnabled: false,
  secret: '',
  qrCodeUrl: '',
  backupCodes: [],
  isLocked: false,
};

// Known demo IDs for filtering legacy mock data
export const DEMO_ACCOUNT_IDS = new Set([
  'acc_xtb_pln',
  'acc_ibkr_usd',
  'acc_freedom24',
  'acc_revolut',
  'acc_emakler',
  'acc_binance',
]);

export const DEMO_TRANSACTION_IDS = new Set([
  'tx_01', 'tx_02', 'tx_03', 'tx_04', 'tx_05', 'tx_06', 'tx_07', 'tx_08', 'tx_09', 'tx_10',
  'tx_11', 'tx_12', 'tx_13', 'tx_14', 'tx_15', 'tx_demo_01', 'tx_demo_02', 'tx_demo_03',
  'tx_demo_04', 'tx_demo_05', 'tx_demo_06'
]);
