/**
 * Mapowanie tickera z zapisu brokera na symbol dostawcy notowan (Yahoo). Wspolne dla
 * serwera web (routes/quotes.ts) i transportu desktopowego (apiTransport.ts), zeby
 * ten sam ticker dawal to samo notowanie w obu wersjach aplikacji.
 */

// Known symbol mappings for Polish GPW, European ETFs, US stocks, and global assets
export const SYMBOL_MAP: Record<string, { yahooSymbol: string; name: string; category: string; currency: string; source: string; brokers?: string[] }> = {
  // Polish GPW (WSE) - WIG20, mWIG40, sWIG80
  CDR: { yahooSymbol: 'CDR.WA', name: 'CD Projekt S.A.', category: 'STOCK_PL', currency: 'PLN', source: 'GPW', brokers: ['XTB', 'EMAKLER', 'IBKR', 'FREEDOM24', 'DEGIRO'] },
  PKN: { yahooSymbol: 'PKN.WA', name: 'ORLEN S.A.', category: 'STOCK_PL', currency: 'PLN', source: 'GPW', brokers: ['XTB', 'EMAKLER', 'IBKR', 'FREEDOM24', 'DEGIRO'] },
  DNP: { yahooSymbol: 'DNP.WA', name: 'Dino Polska S.A.', category: 'STOCK_PL', currency: 'PLN', source: 'GPW', brokers: ['XTB', 'EMAKLER', 'IBKR', 'FREEDOM24', 'DEGIRO'] },
  PKO: { yahooSymbol: 'PKO.WA', name: 'PKO Bank Polski S.A.', category: 'STOCK_PL', currency: 'PLN', source: 'GPW', brokers: ['XTB', 'EMAKLER', 'IBKR', 'FREEDOM24', 'DEGIRO'] },
  PZU: { yahooSymbol: 'PZU.WA', name: 'PZU S.A.', category: 'STOCK_PL', currency: 'PLN', source: 'GPW', brokers: ['XTB', 'EMAKLER', 'IBKR', 'FREEDOM24', 'DEGIRO'] },
  KGH: { yahooSymbol: 'KGH.WA', name: 'KGHM Polska Miedź S.A.', category: 'STOCK_PL', currency: 'PLN', source: 'GPW', brokers: ['XTB', 'EMAKLER', 'IBKR', 'FREEDOM24', 'DEGIRO'] },
  ALE: { yahooSymbol: 'ALE.WA', name: 'Allegro.eu S.A.', category: 'STOCK_PL', currency: 'PLN', source: 'GPW', brokers: ['XTB', 'EMAKLER', 'IBKR', 'FREEDOM24', 'DEGIRO'] },
  LPP: { yahooSymbol: 'LPP.WA', name: 'LPP S.A.', category: 'STOCK_PL', currency: 'PLN', source: 'GPW', brokers: ['XTB', 'EMAKLER', 'IBKR', 'FREEDOM24', 'DEGIRO'] },
  SPL: { yahooSymbol: 'SPL.WA', name: 'Santander Bank Polska S.A.', category: 'STOCK_PL', currency: 'PLN', source: 'GPW', brokers: ['XTB', 'EMAKLER', 'IBKR', 'FREEDOM24', 'DEGIRO'] },
  PEO: { yahooSymbol: 'PEO.WA', name: 'Bank Pekao S.A.', category: 'STOCK_PL', currency: 'PLN', source: 'GPW', brokers: ['XTB', 'EMAKLER', 'IBKR', 'FREEDOM24', 'DEGIRO'] },
  JSW: { yahooSymbol: 'JSW.WA', name: 'JSW S.A.', category: 'STOCK_PL', currency: 'PLN', source: 'GPW', brokers: ['XTB', 'EMAKLER', 'IBKR', 'FREEDOM24', 'DEGIRO'] },
  PGE: { yahooSymbol: 'PGE.WA', name: 'PGE Polska Grupa Energetyczna', category: 'STOCK_PL', currency: 'PLN', source: 'GPW', brokers: ['XTB', 'EMAKLER', 'IBKR', 'FREEDOM24', 'DEGIRO'] },
  KRU: { yahooSymbol: 'KRU.WA', name: 'KRUK S.A.', category: 'STOCK_PL', currency: 'PLN', source: 'GPW', brokers: ['XTB', 'EMAKLER', 'IBKR', 'FREEDOM24', 'DEGIRO'] },
  MBK: { yahooSymbol: 'MBK.WA', name: 'mBank S.A.', category: 'STOCK_PL', currency: 'PLN', source: 'GPW', brokers: ['XTB', 'EMAKLER', 'IBKR', 'FREEDOM24', 'DEGIRO'] },
  XTB: { yahooSymbol: 'XTB.WA', name: 'XTB S.A.', category: 'STOCK_PL', currency: 'PLN', source: 'GPW', brokers: ['XTB', 'EMAKLER', 'IBKR', 'FREEDOM24', 'DEGIRO'] },
  ALR: { yahooSymbol: 'ALR.WA', name: 'Alior Bank S.A.', category: 'STOCK_PL', currency: 'PLN', source: 'GPW', brokers: ['XTB', 'EMAKLER', 'IBKR', 'FREEDOM24', 'DEGIRO'] },
  BDX: { yahooSymbol: 'BDX.WA', name: 'Budimex S.A.', category: 'STOCK_PL', currency: 'PLN', source: 'GPW', brokers: ['XTB', 'EMAKLER', 'IBKR', 'FREEDOM24', 'DEGIRO'] },
  KTY: { yahooSymbol: 'KTY.WA', name: 'Grupa Kęty S.A.', category: 'STOCK_PL', currency: 'PLN', source: 'GPW', brokers: ['XTB', 'EMAKLER', 'IBKR', 'FREEDOM24', 'DEGIRO'] },
  TPE: { yahooSymbol: 'TPE.WA', name: 'Tauron Polska Energia S.A.', category: 'STOCK_PL', currency: 'PLN', source: 'GPW', brokers: ['XTB', 'EMAKLER', 'IBKR', 'FREEDOM24', 'DEGIRO'] },
  '11B': { yahooSymbol: '11B.WA', name: '11 bit studios S.A.', category: 'STOCK_PL', currency: 'PLN', source: 'GPW', brokers: ['XTB', 'EMAKLER', 'IBKR', 'FREEDOM24', 'DEGIRO'] },
  TEN: { yahooSymbol: 'TEN.WA', name: 'Ten Square Games S.A.', category: 'STOCK_PL', currency: 'PLN', source: 'GPW', brokers: ['XTB', 'EMAKLER', 'IBKR', 'FREEDOM24', 'DEGIRO'] },
  GPW: { yahooSymbol: 'GPW.WA', name: 'GPW w Warszawie S.A.', category: 'STOCK_PL', currency: 'PLN', source: 'GPW', brokers: ['XTB', 'EMAKLER', 'IBKR', 'FREEDOM24', 'DEGIRO'] },
  TEXT: { yahooSymbol: 'TXT.WA', name: 'Text S.A. (LiveChat)', category: 'STOCK_PL', currency: 'PLN', source: 'GPW', brokers: ['XTB', 'EMAKLER', 'IBKR', 'FREEDOM24', 'DEGIRO'] },
  DOM: { yahooSymbol: 'DOM.WA', name: 'Dom Development S.A.', category: 'STOCK_PL', currency: 'PLN', source: 'GPW', brokers: ['XTB', 'EMAKLER', 'IBKR', 'FREEDOM24', 'DEGIRO'] },
  
  // European ETFs (UCITS - XETRA / Euronext / London)
  VWCE: { yahooSymbol: 'VWCE.DE', name: 'Vanguard FTSE All-World UCITS ETF', category: 'ETF', currency: 'EUR', source: 'FREEDOM24', brokers: ['XTB', 'IBKR', 'FREEDOM24', 'REVOLUT', 'EMAKLER', 'DEGIRO'] },
  EUNL: { yahooSymbol: 'EUNL.DE', name: 'iShares Core MSCI World UCITS ETF', category: 'ETF', currency: 'EUR', source: 'TRADINGVIEW', brokers: ['XTB', 'IBKR', 'FREEDOM24', 'REVOLUT', 'EMAKLER', 'DEGIRO'] },
  SXR8: { yahooSymbol: 'SXR8.DE', name: 'iShares Core S&P 500 UCITS ETF', category: 'ETF', currency: 'EUR', source: 'TRADINGVIEW', brokers: ['XTB', 'IBKR', 'FREEDOM24', 'REVOLUT', 'EMAKLER', 'DEGIRO'] },
  QDVE: { yahooSymbol: 'QDVE.DE', name: 'iShares S&P 500 Information Tech ETF', category: 'ETF', currency: 'EUR', source: 'FREEDOM24', brokers: ['XTB', 'IBKR', 'FREEDOM24', 'REVOLUT', 'EMAKLER', 'DEGIRO'] },
  IUSN: { yahooSymbol: 'IUSN.DE', name: 'iShares MSCI World Small Cap UCITS ETF', category: 'ETF', currency: 'EUR', source: 'FREEDOM24', brokers: ['XTB', 'IBKR', 'FREEDOM24', 'REVOLUT', 'EMAKLER', 'DEGIRO'] },
  IS3N: { yahooSymbol: 'IS3N.DE', name: 'iShares Core MSCI EM IMI UCITS ETF', category: 'ETF', currency: 'EUR', source: 'FREEDOM24', brokers: ['XTB', 'IBKR', 'FREEDOM24', 'REVOLUT', 'EMAKLER', 'DEGIRO'] },
  VAGF: { yahooSymbol: 'VAGF.DE', name: 'Vanguard Global Aggregate Bond UCITS ETF', category: 'BOND', currency: 'EUR', source: 'TRADINGVIEW', brokers: ['XTB', 'IBKR', 'FREEDOM24', 'DEGIRO'] },
  
  // US Stocks & ETFs
  NVDA: { yahooSymbol: 'NVDA', name: 'NVIDIA Corporation', category: 'STOCK_FOREIGN', currency: 'USD', source: 'FREEDOM24', brokers: ['XTB', 'IBKR', 'FREEDOM24', 'REVOLUT', 'EMAKLER', 'DEGIRO'] },
  AAPL: { yahooSymbol: 'AAPL', name: 'Apple Inc.', category: 'STOCK_FOREIGN', currency: 'USD', source: 'TRADINGVIEW', brokers: ['XTB', 'IBKR', 'FREEDOM24', 'REVOLUT', 'EMAKLER', 'DEGIRO'] },
  MSFT: { yahooSymbol: 'MSFT', name: 'Microsoft Corporation', category: 'STOCK_FOREIGN', currency: 'USD', source: 'FREEDOM24', brokers: ['XTB', 'IBKR', 'FREEDOM24', 'REVOLUT', 'EMAKLER', 'DEGIRO'] },
  TSLA: { yahooSymbol: 'TSLA', name: 'Tesla Inc.', category: 'STOCK_FOREIGN', currency: 'USD', source: 'TRADINGVIEW', brokers: ['XTB', 'IBKR', 'FREEDOM24', 'REVOLUT', 'EMAKLER', 'DEGIRO'] },
  AMZN: { yahooSymbol: 'AMZN', name: 'Amazon.com Inc.', category: 'STOCK_FOREIGN', currency: 'USD', source: 'FREEDOM24', brokers: ['XTB', 'IBKR', 'FREEDOM24', 'REVOLUT', 'EMAKLER', 'DEGIRO'] },
  GOOGL: { yahooSymbol: 'GOOGL', name: 'Alphabet Inc. Class A', category: 'STOCK_FOREIGN', currency: 'USD', source: 'TRADINGVIEW', brokers: ['XTB', 'IBKR', 'FREEDOM24', 'REVOLUT', 'EMAKLER', 'DEGIRO'] },
  META: { yahooSymbol: 'META', name: 'Meta Platforms Inc.', category: 'STOCK_FOREIGN', currency: 'USD', source: 'TRADINGVIEW', brokers: ['XTB', 'IBKR', 'FREEDOM24', 'REVOLUT', 'EMAKLER', 'DEGIRO'] },
  PLTR: { yahooSymbol: 'PLTR', name: 'Palantir Technologies Inc.', category: 'STOCK_FOREIGN', currency: 'USD', source: 'FREEDOM24', brokers: ['XTB', 'IBKR', 'FREEDOM24', 'REVOLUT', 'EMAKLER', 'DEGIRO'] },
  AMD: { yahooSymbol: 'AMD', name: 'Advanced Micro Devices Inc.', category: 'STOCK_FOREIGN', currency: 'USD', source: 'FREEDOM24', brokers: ['XTB', 'IBKR', 'FREEDOM24', 'REVOLUT', 'EMAKLER', 'DEGIRO'] },
  INTC: { yahooSymbol: 'INTC', name: 'Intel Corporation', category: 'STOCK_FOREIGN', currency: 'USD', source: 'TRADINGVIEW', brokers: ['XTB', 'IBKR', 'FREEDOM24', 'REVOLUT', 'EMAKLER', 'DEGIRO'] },
  NFLX: { yahooSymbol: 'NFLX', name: 'Netflix Inc.', category: 'STOCK_FOREIGN', currency: 'USD', source: 'TRADINGVIEW', brokers: ['XTB', 'IBKR', 'FREEDOM24', 'REVOLUT', 'EMAKLER', 'DEGIRO'] },
  DIS: { yahooSymbol: 'DIS', name: 'The Walt Disney Company', category: 'STOCK_FOREIGN', currency: 'USD', source: 'TRADINGVIEW', brokers: ['XTB', 'IBKR', 'FREEDOM24', 'REVOLUT', 'EMAKLER', 'DEGIRO'] },
  BABA: { yahooSymbol: 'BABA', name: 'Alibaba Group Holding Ltd.', category: 'STOCK_FOREIGN', currency: 'USD', source: 'FREEDOM24', brokers: ['XTB', 'IBKR', 'FREEDOM24', 'REVOLUT', 'EMAKLER', 'DEGIRO'] },
  COIN: { yahooSymbol: 'COIN', name: 'Coinbase Global Inc.', category: 'STOCK_FOREIGN', currency: 'USD', source: 'TRADINGVIEW', brokers: ['XTB', 'IBKR', 'FREEDOM24', 'REVOLUT', 'EMAKLER', 'DEGIRO'] },
  MSTR: { yahooSymbol: 'MSTR', name: 'MicroStrategy Inc.', category: 'STOCK_FOREIGN', currency: 'USD', source: 'FREEDOM24', brokers: ['XTB', 'IBKR', 'FREEDOM24', 'REVOLUT', 'EMAKLER', 'DEGIRO'] },
  UBER: { yahooSymbol: 'UBER', name: 'Uber Technologies Inc.', category: 'STOCK_FOREIGN', currency: 'USD', source: 'TRADINGVIEW', brokers: ['XTB', 'IBKR', 'FREEDOM24', 'REVOLUT', 'EMAKLER', 'DEGIRO'] },
  PYPL: { yahooSymbol: 'PYPL', name: 'PayPal Holdings Inc.', category: 'STOCK_FOREIGN', currency: 'USD', source: 'TRADINGVIEW', brokers: ['XTB', 'IBKR', 'FREEDOM24', 'REVOLUT', 'EMAKLER', 'DEGIRO'] },
  CRM: { yahooSymbol: 'CRM', name: 'Salesforce Inc.', category: 'STOCK_FOREIGN', currency: 'USD', source: 'FREEDOM24', brokers: ['XTB', 'IBKR', 'FREEDOM24', 'REVOLUT', 'EMAKLER', 'DEGIRO'] },
  ORCL: { yahooSymbol: 'ORCL', name: 'Oracle Corporation', category: 'STOCK_FOREIGN', currency: 'USD', source: 'FREEDOM24', brokers: ['XTB', 'IBKR', 'FREEDOM24', 'REVOLUT', 'EMAKLER', 'DEGIRO'] },
  ADBE: { yahooSymbol: 'ADBE', name: 'Adobe Inc.', category: 'STOCK_FOREIGN', currency: 'USD', source: 'TRADINGVIEW', brokers: ['XTB', 'IBKR', 'FREEDOM24', 'REVOLUT', 'EMAKLER', 'DEGIRO'] },
  CSCO: { yahooSymbol: 'CSCO', name: 'Cisco Systems Inc.', category: 'STOCK_FOREIGN', currency: 'USD', source: 'TRADINGVIEW', brokers: ['XTB', 'IBKR', 'FREEDOM24', 'REVOLUT', 'EMAKLER', 'DEGIRO'] },
  QCOM: { yahooSymbol: 'QCOM', name: 'Qualcomm Inc.', category: 'STOCK_FOREIGN', currency: 'USD', source: 'FREEDOM24', brokers: ['XTB', 'IBKR', 'FREEDOM24', 'REVOLUT', 'EMAKLER', 'DEGIRO'] },
  AVGO: { yahooSymbol: 'AVGO', name: 'Broadcom Inc.', category: 'STOCK_FOREIGN', currency: 'USD', source: 'FREEDOM24', brokers: ['XTB', 'IBKR', 'FREEDOM24', 'REVOLUT', 'EMAKLER', 'DEGIRO'] },
  TSM: { yahooSymbol: 'TSM', name: 'Taiwan Semiconductor Manufacturing', category: 'STOCK_FOREIGN', currency: 'USD', source: 'FREEDOM24', brokers: ['XTB', 'IBKR', 'FREEDOM24', 'REVOLUT', 'EMAKLER', 'DEGIRO'] },
  ASML: { yahooSymbol: 'ASML', name: 'ASML Holding N.V.', category: 'STOCK_FOREIGN', currency: 'USD', source: 'FREEDOM24', brokers: ['XTB', 'IBKR', 'FREEDOM24', 'REVOLUT', 'EMAKLER', 'DEGIRO'] },
  ARM: { yahooSymbol: 'ARM', name: 'Arm Holdings plc', category: 'STOCK_FOREIGN', currency: 'USD', source: 'FREEDOM24', brokers: ['XTB', 'IBKR', 'FREEDOM24', 'REVOLUT', 'EMAKLER', 'DEGIRO'] },
  SMCI: { yahooSymbol: 'SMCI', name: 'Super Micro Computer Inc.', category: 'STOCK_FOREIGN', currency: 'USD', source: 'FREEDOM24', brokers: ['XTB', 'IBKR', 'FREEDOM24', 'REVOLUT', 'EMAKLER', 'DEGIRO'] },
  CRWD: { yahooSymbol: 'CRWD', name: 'CrowdStrike Holdings Inc.', category: 'STOCK_FOREIGN', currency: 'USD', source: 'FREEDOM24', brokers: ['XTB', 'IBKR', 'FREEDOM24', 'REVOLUT', 'EMAKLER', 'DEGIRO'] },
  PANW: { yahooSymbol: 'PANW', name: 'Palo Alto Networks Inc.', category: 'STOCK_FOREIGN', currency: 'USD', source: 'FREEDOM24', brokers: ['XTB', 'IBKR', 'FREEDOM24', 'REVOLUT', 'EMAKLER', 'DEGIRO'] },
  'BRK.B': { yahooSymbol: 'BRK-B', name: 'Berkshire Hathaway Inc. Class B', category: 'STOCK_FOREIGN', currency: 'USD', source: 'TRADINGVIEW', brokers: ['XTB', 'IBKR', 'FREEDOM24', 'REVOLUT', 'EMAKLER', 'DEGIRO'] },
  JPM: { yahooSymbol: 'JPM', name: 'JPMorgan Chase & Co.', category: 'STOCK_FOREIGN', currency: 'USD', source: 'TRADINGVIEW', brokers: ['XTB', 'IBKR', 'FREEDOM24', 'REVOLUT', 'EMAKLER', 'DEGIRO'] },
  V: { yahooSymbol: 'V', name: 'Visa Inc. Class A', category: 'STOCK_FOREIGN', currency: 'USD', source: 'TRADINGVIEW', brokers: ['XTB', 'IBKR', 'FREEDOM24', 'REVOLUT', 'EMAKLER', 'DEGIRO'] },
  MA: { yahooSymbol: 'MA', name: 'Mastercard Inc.', category: 'STOCK_FOREIGN', currency: 'USD', source: 'TRADINGVIEW', brokers: ['XTB', 'IBKR', 'FREEDOM24', 'REVOLUT', 'EMAKLER', 'DEGIRO'] },
  KO: { yahooSymbol: 'KO', name: 'The Coca-Cola Company', category: 'STOCK_FOREIGN', currency: 'USD', source: 'TRADINGVIEW', brokers: ['XTB', 'IBKR', 'FREEDOM24', 'REVOLUT', 'EMAKLER', 'DEGIRO'] },
  PEP: { yahooSymbol: 'PEP', name: 'PepsiCo Inc.', category: 'STOCK_FOREIGN', currency: 'USD', source: 'TRADINGVIEW', brokers: ['XTB', 'IBKR', 'FREEDOM24', 'REVOLUT', 'EMAKLER', 'DEGIRO'] },
  MCD: { yahooSymbol: 'MCD', name: 'McDonald\'s Corporation', category: 'STOCK_FOREIGN', currency: 'USD', source: 'TRADINGVIEW', brokers: ['XTB', 'IBKR', 'FREEDOM24', 'REVOLUT', 'EMAKLER', 'DEGIRO'] },
  WMT: { yahooSymbol: 'WMT', name: 'Walmart Inc.', category: 'STOCK_FOREIGN', currency: 'USD', source: 'TRADINGVIEW', brokers: ['XTB', 'IBKR', 'FREEDOM24', 'REVOLUT', 'EMAKLER', 'DEGIRO'] },
  COST: { yahooSymbol: 'COST', name: 'Costco Wholesale Corporation', category: 'STOCK_FOREIGN', currency: 'USD', source: 'TRADINGVIEW', brokers: ['XTB', 'IBKR', 'FREEDOM24', 'REVOLUT', 'EMAKLER', 'DEGIRO'] },
  LLY: { yahooSymbol: 'LLY', name: 'Eli Lilly and Company', category: 'STOCK_FOREIGN', currency: 'USD', source: 'TRADINGVIEW', brokers: ['XTB', 'IBKR', 'FREEDOM24', 'REVOLUT', 'EMAKLER', 'DEGIRO'] },
  JNJ: { yahooSymbol: 'JNJ', name: 'Johnson & Johnson', category: 'STOCK_FOREIGN', currency: 'USD', source: 'TRADINGVIEW', brokers: ['XTB', 'IBKR', 'FREEDOM24', 'REVOLUT', 'EMAKLER', 'DEGIRO'] },
  XOM: { yahooSymbol: 'XOM', name: 'Exxon Mobil Corporation', category: 'STOCK_FOREIGN', currency: 'USD', source: 'TRADINGVIEW', brokers: ['XTB', 'IBKR', 'FREEDOM24', 'REVOLUT', 'EMAKLER', 'DEGIRO'] },
  VOO: { yahooSymbol: 'VOO', name: 'Vanguard S&P 500 ETF', category: 'ETF', currency: 'USD', source: 'TRADINGVIEW', brokers: ['IBKR', 'FREEDOM24', 'DEGIRO'] },
  SPY: { yahooSymbol: 'SPY', name: 'SPDR S&P 500 ETF Trust', category: 'ETF', currency: 'USD', source: 'TRADINGVIEW', brokers: ['IBKR', 'FREEDOM24', 'DEGIRO'] },
  QQQ: { yahooSymbol: 'QQQ', name: 'Invesco QQQ Trust (Nasdaq-100)', category: 'ETF', currency: 'USD', source: 'TRADINGVIEW', brokers: ['IBKR', 'FREEDOM24', 'DEGIRO'] },
  SCHD: { yahooSymbol: 'SCHD', name: 'Schwab U.S. Dividend Equity ETF', category: 'ETF', currency: 'USD', source: 'TRADINGVIEW', brokers: ['IBKR', 'FREEDOM24'] },
  GLD: { yahooSymbol: 'GLD', name: 'SPDR Gold Shares', category: 'ETF', currency: 'USD', source: 'TRADINGVIEW', brokers: ['XTB', 'IBKR', 'FREEDOM24', 'REVOLUT', 'DEGIRO'] },
  SLV: { yahooSymbol: 'SLV', name: 'iShares Silver Trust', category: 'ETF', currency: 'USD', source: 'TRADINGVIEW', brokers: ['XTB', 'IBKR', 'FREEDOM24', 'REVOLUT', 'DEGIRO'] },
};

/**
 * Sufiks rynku w zapisie brokera (Tradernet/Freedom24) -> sufiks dostawcy
 * notowan. Pusty napis znaczy "rynek USA, dostawca nie uzywa sufiksu".
 * `NBIS.US` szlo do dostawcy doslownie, a on zna ten papier jako `NBIS` -
 * pozycja z rachunku nie miala przez to wyceny. Rynek zostaje rozrozniony:
 * `VOD.US` to `VOD`, a `VOD.L` to nadal `VOD.L`.
 */
const SUFIKSY_BROKERA: Record<string, string> = {
  US: '',
  PL: '.WA',
  WA: '.WA',
  UK: '.L',
  L: '.L',
  DE: '.DE',
  PA: '.PA',
  TO: '.TO',
};

/** Symbole do sprobowania u dostawcy notowan, w kolejnosci. */
export function kandydaciSymboluDostawcy(ticker: string): string[] {
  const upperTicker = ticker.trim().toUpperCase();
  if (!upperTicker) return [];
  const mapping = SYMBOL_MAP[upperTicker];
  if (mapping) return [mapping.yahooSymbol];

  const kropka = upperTicker.lastIndexOf('.');
  if (kropka > 0) {
    const baza = upperTicker.slice(0, kropka);
    const sufiks = upperTicker.slice(kropka + 1);
    if (sufiks in SUFIKSY_BROKERA) {
      // Znany rynek: dokladnie jeden symbol, bez zgadywania innych gield.
      const bazowe = SYMBOL_MAP[baza];
      if (sufiks === 'US' && bazowe && !bazowe.yahooSymbol.includes('.')) return [bazowe.yahooSymbol];
      return [`${baza}${SUFIKSY_BROKERA[sufiks]}`];
    }
    // Nieznany sufiks (np. nota DGT4016.JUN26): tylko zapis doslowny.
    return [upperTicker];
  }
  return [upperTicker, `${upperTicker}.WA`, `${upperTicker}.DE`, `${upperTicker}.L`];
}
