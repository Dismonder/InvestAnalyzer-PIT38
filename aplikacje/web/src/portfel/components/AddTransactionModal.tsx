import React, { useState, useEffect } from 'react';
import {
  Transaction,
  BrokerAccount,
  AssetCategory,
  TransactionType,
  CurrencyCode,
  Language,
} from '../types';
import { getTranslation } from '../i18n/translations';
import { getNBPRateForDate, formatLiczba } from '../services/nbpService';
import {
  DOMYSLNY_RACHUNEK_FORMULARZA,
  WALUTY_PROWIZJI,
  bladFormularzaTransakcji,
  dzisiajLokalnie,
  poczatkowaWalutaProwizji,
  podatekZrodlaDywidendy,
  walutaProwiziPoZmianieWaluty,
} from '../services/formularzTransakcji';
import { X, Calendar, DollarSign, Percent, Info } from 'lucide-react';
import { useZamknijEscape } from '../../shared/useZamknijEscape';

interface AddTransactionModalProps {
  accounts: BrokerAccount[];
  language: Language;
  editingTransaction: Transaction | null;
  onSave: (tx: Transaction) => void;
  onClose: () => void;
}

export const AddTransactionModal: React.FC<AddTransactionModalProps> = ({
  accounts,
  language,
  editingTransaction,
  onSave,
  onClose,
}) => {
  const refOkna = useZamknijEscape(true, onClose);
  const t = getTranslation(language);

  const [accountId, setAccountId] = useState(
    editingTransaction?.accountId || accounts[0]?.id || DOMYSLNY_RACHUNEK_FORMULARZA
  );
  // Puste pole zamiast wpisanej na sztywno NVDA: transakcja na przypadkowy walor zmienia podatek.
  const [ticker, setTicker] = useState(editingTransaction?.ticker || '');
  // Tak samo nazwa, ilosc, cena, prowizja i stawka podatku: wartosci przykladowe
  // (NVIDIA, 10 szt. po 135 USD, 1,50 prowizji, 15%) zapisywaly sie jako dane podatnika,
  // gdy ktos ich nie nadpisal - a kazdy walor dostawal nazwe NVIDIA Corporation.
  const [name, setName] = useState(editingTransaction?.name || '');
  const [category, setCategory] = useState<AssetCategory>(editingTransaction?.category || 'STOCK_FOREIGN');
  const [type, setType] = useState<TransactionType>(editingTransaction?.type || 'BUY');
  const [date, setDate] = useState(editingTransaction?.date || dzisiajLokalnie());
  const [bladFormularza, setBladFormularza] = useState<string | null>(null);
  const [quantity, setQuantity] = useState(editingTransaction ? String(editingTransaction.quantity) : '');
  const [pricePerUnit, setPricePerUnit] = useState(editingTransaction ? String(editingTransaction.pricePerUnit) : '');
  const [currency, setCurrency] = useState<CurrencyCode>(editingTransaction?.currency || 'USD');
  const [commission, setCommission] = useState(editingTransaction ? String(editingTransaction.commission) : '');
  const [commissionCurrency, setCommissionCurrency] = useState<CurrencyCode>(
    poczatkowaWalutaProwizji(editingTransaction, editingTransaction?.currency || 'USD')
  );
  // Waluta prowizji podaza za waluta transakcji, dopoki uzytkownik jej sam nie wybierze
  // (przy edycji: gdy zapisana waluta prowizji jest inna niz waluta transakcji).
  const [prowizjaWybranaRecznie, setProwizjaWybranaRecznie] = useState(
    Boolean(editingTransaction?.commissionCurrency && editingTransaction.commissionCurrency !== editingTransaction.currency)
  );
  const [foreignTaxRate, setForeignTaxRate] = useState(editingTransaction?.foreignTaxRate !== undefined ? String(editingTransaction.foreignTaxRate) : '');
  // Kwota podatku u zrodla (w walucie dywidendy) z wyciagu; zachowywana przy edycji, puste = ze stawki.
  const [foreignTaxAmount, setForeignTaxAmount] = useState(editingTransaction?.foreignTaxAmount !== undefined ? String(editingTransaction.foreignTaxAmount) : '');
  const [notes, setNotes] = useState(editingTransaction?.notes || '');

  // Live estimated NBP preview
  const [nbpRatePreview, setNbpRatePreview] = useState<number | null>(null);
  // Kurs moze byc niedostepny (brak sieci, api.nbp.pl nie odpowiada). Mowimy o
  // tym wprost - wczesniej w to miejsce wchodzil kurs wyliczony z daty, ktory
  // wygladal jak urzedowy.
  const [brakKursu, setBrakKursu] = useState(false);

  useEffect(() => {
    let isCurrent = true;
    if (currency === 'PLN') {
      setNbpRatePreview(1.0);
      setBrakKursu(false);
    } else {
      setBrakKursu(false);
      getNBPRateForDate(currency, date).then((rate) => {
        if (!isCurrent) return;
        setNbpRatePreview(rate ? rate.mid : null);
        setBrakKursu(rate === null);
      });
    }
    return () => {
      isCurrent = false;
    };
  }, [currency, date]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const blad = bladFormularzaTransakcji({ date, quantity, pricePerUnit });
    setBladFormularza(blad);
    if (blad) return;

    const tx: Transaction = {
      id: (editingTransaction && editingTransaction.id.trim().length > 0) ? editingTransaction.id : 'tx_' + Date.now(),
      accountId,
      ticker: ticker.toUpperCase(),
      name: name || ticker.toUpperCase(),
      category,
      type,
      date,
      quantity: parseFloat(quantity) || 0,
      pricePerUnit: parseFloat(pricePerUnit) || 0,
      currency,
      commission: parseFloat(commission) || 0,
      commissionCurrency,
      ...podatekZrodlaDywidendy(type, foreignTaxRate, foreignTaxAmount),
      notes,
    };

    onSave(tx);
    onClose();
  };

  return (
    <div ref={refOkna} tabIndex={-1} role="dialog" aria-modal="true" aria-label={editingTransaction ? 'Edytuj Transakcję' : t.addTransaction} className="outline-none fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-xs">
      <div className="w-full max-w-lg bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 shadow-2xl p-6 space-y-4 animate-in fade-in zoom-in-95 duration-150 max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between pb-3 border-b border-slate-100 dark:border-slate-800">
          <h2 className="text-base sm:text-lg font-bold text-slate-900 dark:text-white">
            {editingTransaction ? 'Edytuj Transakcję' : t.addTransaction}
          </h2>
          <button
            aria-label="Zamknij"
            onClick={onClose}
            className="p-1.5 text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 rounded-lg cursor-pointer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-3.5 text-xs">
          {/* Account and Category */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-slate-700 dark:text-slate-300 font-medium mb-1">Rachunek Maklerski</label>
              <select aria-label="Rachunek Maklerski"
                value={accountId}
                onChange={(e) => setAccountId(e.target.value)}
                className="w-full px-3 py-2 rounded-xl bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-900 dark:text-white focus:outline-none"
              >
                {accounts.length === 0 ? (
                  <option value="acc_main">Główny rachunek maklerski (PLN)</option>
                ) : (
                  accounts.map((acc) => (
                    <option key={acc.id} value={acc.id}>
                      {acc.name} ({acc.currency})
                    </option>
                  ))
                )}
              </select>
            </div>

            <div>
              <label className="block text-slate-700 dark:text-slate-300 font-medium mb-1">Kategoria Aktywa</label>
              <select aria-label="Kategoria Aktywa"
                value={category}
                onChange={(e) => setCategory(e.target.value as AssetCategory)}
                className="w-full px-3 py-2 rounded-xl bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-900 dark:text-white focus:outline-none"
              >
                <option value="STOCK_FOREIGN">Akcje Zagraniczne (USA/EU)</option>
                <option value="STOCK_PL">Akcje Polskie (GPW)</option>
                <option value="ETF">Fundusze ETF</option>
                <option value="CRYPTO">Kryptowaluty</option>
                <option value="BOND">Obligacje</option>
              </select>
            </div>
          </div>

          {/* Operation Type and Date */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-slate-700 dark:text-slate-300 font-medium mb-1">Typ Transakcji</label>
              <select aria-label="Typ Transakcji"
                value={type}
                onChange={(e) => setType(e.target.value as TransactionType)}
                className="w-full px-3 py-2 rounded-xl bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-900 dark:text-white focus:outline-none"
              >
                <option value="BUY">{t.buy}</option>
                <option value="SELL">{t.sell}</option>
                <option value="DIVIDEND">{t.dividend}</option>
                <option value="FEE">{t.fee}</option>
              </select>
            </div>

            <div>
              <label className="block text-slate-700 dark:text-slate-300 font-medium mb-1">Data Transakcji</label>
              <input aria-label="Data Transakcji"
                type="date"
                required
                max={dzisiajLokalnie()}
                value={date}
                onChange={(e) => setDate(e.target.value)}
                className="w-full px-3 py-2 rounded-xl bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-900 dark:text-white focus:outline-none"
              />
            </div>
          </div>

          {/* Ticker and Name */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-slate-700 dark:text-slate-300 font-medium mb-1">Symbol / Ticker</label>
              <input aria-label="Symbol / Ticker"
                type="text"
                required
                placeholder="np. NVDA, AAPL, CDR, BTC"
                value={ticker}
                onChange={(e) => setTicker(e.target.value.toUpperCase())}
                className="w-full px-3 py-2 rounded-xl bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-900 dark:text-white font-bold uppercase focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>

            <div>
              <label className="block text-slate-700 dark:text-slate-300 font-medium mb-1">Nazwa Spółki / Aktywa</label>
              <input aria-label="Nazwa Spółki / Aktywa"
                type="text"
                placeholder="np. NVIDIA Corp."
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="w-full px-3 py-2 rounded-xl bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-900 dark:text-white focus:outline-none"
              />
            </div>
          </div>

          {/* Quantity, Price, Currency */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div>
              <label className="block text-slate-700 dark:text-slate-300 font-medium mb-1">
                {type === 'DIVIDEND' ? 'Liczba Akcji' : 'Ilość Sztuk'}
              </label>
              <input
                aria-label={type === 'DIVIDEND' ? 'Liczba Akcji' : 'Ilość Sztuk'}
                type="number"
                step="any"
                required
                value={quantity}
                onChange={(e) => setQuantity(e.target.value)}
                className="w-full px-3 py-2 rounded-xl bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-900 dark:text-white font-mono focus:outline-none"
              />
            </div>

            <div>
              <label className="block text-slate-700 dark:text-slate-300 font-medium mb-1">
                {/* Silnik dostaje ilosc x kwote: "Kwota Dywidendy" zachecala do wpisania sumy,
                    ktora mnozona przez liczbe akcji zawyzala dywidende wielokrotnie. */}
                {type === 'DIVIDEND' ? 'Dywidenda brutto na 1 akcję' : 'Cena za Sztukę'}
              </label>
              <input
                aria-label={type === 'DIVIDEND' ? 'Dywidenda brutto na 1 akcję' : 'Cena za Sztukę'}
                type="number"
                step="any"
                required
                value={pricePerUnit}
                onChange={(e) => setPricePerUnit(e.target.value)}
                className="w-full px-3 py-2 rounded-xl bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-900 dark:text-white font-mono focus:outline-none"
              />
            </div>

            <div>
              <label className="block text-slate-700 dark:text-slate-300 font-medium mb-1">Waluta</label>
              <select aria-label="Waluta"
                value={currency}
                onChange={(e) => {
                  const nowa = e.target.value as CurrencyCode;
                  setCurrency(nowa);
                  setCommissionCurrency((biezaca) => walutaProwiziPoZmianieWaluty(nowa, biezaca, prowizjaWybranaRecznie));
                }}
                className="w-full px-3 py-2 rounded-xl bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-900 dark:text-white focus:outline-none"
              >
                <option value="PLN">PLN</option>
                <option value="USD">USD</option>
                <option value="EUR">EUR</option>
                <option value="GBP">GBP</option>
                <option value="CHF">CHF</option>
              </select>
            </div>
          </div>

          {/* Commission / Dividend WHT Tax */}
          {type === 'DIVIDEND' ? (
            <div>
              <label className="block text-slate-700 dark:text-slate-300 font-medium mb-1">
                Podatek u Źródła WHT (%)
              </label>
              <input aria-label="Podatek u Źródła WHT (%)"
                type="number"
                step="1"
                value={foreignTaxRate}
                onChange={(e) => {
                  setForeignTaxRate(e.target.value);
                  // Zmiana stawki oznacza, ze podatek ma byc liczony ze stawki, a nie z zapisanej kwoty.
                  setForeignTaxAmount('');
                }}
                placeholder="np. 15 (USA W-8BEN)"
                className="w-full px-3 py-2 rounded-xl bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-900 dark:text-white font-mono focus:outline-none"
              />
              <label className="block text-slate-700 dark:text-slate-300 font-medium mb-1 mt-3">
                Kwota podatku u źródła ({currency}) — opcjonalnie
              </label>
              <input
                aria-label={`Kwota podatku u źródła (${currency}) — opcjonalnie`}
                type="number"
                step="any"
                min="0"
                value={foreignTaxAmount}
                onChange={(e) => setForeignTaxAmount(e.target.value)}
                placeholder="puste = podatek ze stawki"
                className="w-full px-3 py-2 rounded-xl bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-900 dark:text-white font-mono focus:outline-none"
              />
              <p className="mt-1 text-[11px] text-slate-500 dark:text-slate-400">
                Kwota faktycznie pobrana (z wyciągu) ma pierwszeństwo przed stawką. Zmiana stawki czyści to pole.
              </p>
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="block text-slate-700 dark:text-slate-300 font-medium mb-1">Prowizja Maklerska</label>
                <input aria-label="Prowizja Maklerska"
                  type="number"
                  step="any"
                  value={commission}
                  onChange={(e) => setCommission(e.target.value)}
                  className="w-full px-3 py-2 rounded-xl bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-900 dark:text-white font-mono focus:outline-none"
                />
              </div>

              <div>
                <label className="block text-slate-700 dark:text-slate-300 font-medium mb-1">Waluta Prowizji</label>
                <select aria-label="Waluta Prowizji"
                  value={commissionCurrency}
                  onChange={(e) => {
                    setCommissionCurrency(e.target.value as CurrencyCode);
                    setProwizjaWybranaRecznie(true);
                  }}
                  className="w-full px-3 py-2 rounded-xl bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-900 dark:text-white focus:outline-none"
                >
                  {WALUTY_PROWIZJI.map((waluta) => (
                    <option key={waluta} value={waluta}>{waluta}</option>
                  ))}
                </select>
              </div>
            </div>
          )}

          {/* Live NBP Rate Box */}
          {currency !== 'PLN' && brakKursu && (
            <div className="p-3 rounded-xl bg-amber-50/80 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-900 flex items-start gap-1.5 text-xs text-amber-800 dark:text-amber-200">
              <Info className="w-4 h-4 text-amber-600 shrink-0" />
              <span>
                Nie udało się pobrać kursu NBP dla {currency} na dzień {date}. Transakcję możesz zapisać —
                kurs zostanie pobrany przy przeliczaniu rozliczenia.
              </span>
            </div>
          )}

          {currency !== 'PLN' && nbpRatePreview && (
            <div className="p-3 rounded-xl bg-blue-50/70 dark:bg-blue-950/30 border border-blue-100 dark:border-blue-900 flex items-center justify-between text-xs text-blue-800 dark:text-blue-200">
              <div className="flex items-center gap-1.5">
                <Info className="w-4 h-4 text-blue-600" />
                <span>Kurs NBP T-1 dla {currency} na dzień {date}:</span>
              </div>
              <span className="font-mono font-bold">{formatLiczba(nbpRatePreview, 4)} PLN</span>
            </div>
          )}

          {/* Estimated Total Calculation Preview */}
          <div className="p-3 rounded-xl bg-slate-50 dark:bg-slate-800/60 border border-slate-200 dark:border-slate-700 flex items-center justify-between text-xs">
            <span className="text-slate-600 dark:text-slate-400 font-medium">{type === 'DIVIDEND' ? 'Dywidenda brutto razem:' : 'Łączna wartość transakcji:'}</span>
            <div className="text-right font-mono font-bold text-slate-900 dark:text-white">
              <span>{formatLiczba((parseFloat(quantity) || 0) * (parseFloat(pricePerUnit) || 0))} {currency}</span>
              {currency !== 'PLN' && nbpRatePreview && (
                <span className="text-slate-400 font-normal block text-[10px]">
                  ≈ {formatLiczba((parseFloat(quantity) || 0) * (parseFloat(pricePerUnit) || 0) * nbpRatePreview)} PLN
                </span>
              )}
            </div>
          </div>

          {/* Notes */}
          <div>
            <label className="block text-slate-700 dark:text-slate-300 font-medium mb-1">Notatki / Komentarz (opcjonalne)</label>
            <input aria-label="Notatki / Komentarz (opcjonalne)"
              type="text"
              placeholder="np. Zlecenie limit, zakup partii 1"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              className="w-full px-3 py-2 rounded-xl bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-900 dark:text-white focus:outline-none"
            />
          </div>

          {bladFormularza && (
            <p role="alert" className="rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-xs font-semibold text-rose-800 dark:border-rose-900/60 dark:bg-rose-950/40 dark:text-rose-200">
              {bladFormularza}
            </p>
          )}

          <div className="flex items-center justify-end gap-2 pt-3 border-t border-slate-100 dark:border-slate-800">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 rounded-xl text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 font-semibold"
            >
              Anuluj
            </button>
            <button
              type="submit"
              className="px-4 py-2 rounded-xl bg-blue-600 hover:bg-blue-700 text-white font-semibold shadow-xs cursor-pointer"
            >
              {editingTransaction ? 'Zapisz Zmiany' : 'Dodaj do Rejestru'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
