import { useKursyNbp, naPLN } from '../services/kursyNbp';
import { useZamknijEscape } from '../../shared/useZamknijEscape';
import { formatLiczba } from '../services/nbpService';
import { odmienLiczebnik } from '../services/odmianaLiczebnika';
import { klikalny } from '../../shared/klikalny';
import { formatujProcentZmiany, zmianaLubNull } from '../services/formatNotowania';
import { ocenProgi, progOdKursu } from '../services/progiOchronne';
import { iloscZlecenia } from '../services/iloscZlecenia';
import { pozycjaTickeraDoInformacji, wybierzPozycjeRachunku } from '../services/pozycjaRachunku';
import { wycenPozycje } from '../services/wycenaPozycji';
import { apiFetch } from '../services/apiTransport';
import {
  getPendingBinanceOrder,
  getPendingBinanceOrders,
  removePendingBinanceOrder,
  reserveBinanceOrder,
  type BinanceOrderParameters,
  type PendingBinanceOrder,
} from '../services/binanceOrderRetry';
import React, { useState, useMemo } from 'react';
import {
  PriceAlert,
  LiveMarketQuote,
  CurrencyCode,
  Language,
  OpenPosition,
  BrokerAccount,
  BrokerOrder,
  BrokerOrderPayload,
  BinanceOrderLookupResult,
} from '../types';
import { getTranslation } from '../i18n/translations';
import { pushNotificationService } from '../services/pushNotificationService';
import { czyTrybHostowany } from '../../shared/trybHostingu';
import { calculatePriceAlertExpiry, findPriceAlertQuote, isPriceAlertExpired } from '../services/priceAlertLogic';
import {
  Bell,
  Plus,
  Trash2,
  AlertTriangle,
  Volume2,
  TrendingUp,
  TrendingDown,
  Clock,
  ShieldAlert,
  Target,
  ShieldCheck,
  Zap,
  Scale,
  RefreshCw,
  Info,
  Check,
  Edit3,
  Server,
  Activity,
  Layers,
  CheckCircle2,
  XCircle,
  Radio,
  ExternalLink,
  Lock,
} from 'lucide-react';

interface PriceAlertsModalProps {
  alerts: PriceAlert[];
  quotes: Record<string, LiveMarketQuote>;
  openPositions?: OpenPosition[];
  accounts?: BrokerAccount[];
  brokerOrders?: BrokerOrder[];
  language: Language;
  initialTicker?: string;
  initialAccountId?: string;
  onAddAlert: (alert: Omit<PriceAlert, 'id' | 'createdAt' | 'isTriggered'>) => void;
  onUpdateAlert?: (alert: PriceAlert) => void;
  onDeleteAlert: (id: string) => void;
  onToggleAlert: (id: string) => void;
  onSelectTickerForChart?: (ticker: string) => void;
  onCreateBrokerOrder?: (
    account: BrokerAccount,
    orderPayload: Omit<BrokerOrderPayload, 'accountId' | 'brokerType' | 'apiKey' | 'apiSecret' | 'accountNumber' | 'apiServerType'>
  ) => Promise<{ success: boolean; ambiguous?: boolean; orderId?: string; clientOrderId?: string; message: string }>;
  onCheckBinanceOrder?: (account: BrokerAccount, ticker: string, clientOrderId: string) => Promise<BinanceOrderLookupResult>;
  onCancelBrokerOrder?: (orderId: string, accountId: string, ticker?: string, confirm?: true) => Promise<{ success: boolean; message: string }>;
}

type ExpiryOption = '1d' | '3d' | '7d' | '14d' | '30d' | '90d' | 'never';

interface ZlecenieBrokeraWidok {
  orderId: number;
  ticker: string;
  rodzaj: 'STOP_LOSS' | 'TAKE_PROFIT' | 'INNE';
  strona: 'KUPNO' | 'SPRZEDAZ';
  ilosc: number | null;
  cenaProgu: number | null;
  cenaZlecenia: number | null;
  waluta: string | null;
  waznosc: 'DZIEN' | 'DZIEN_I_NOC' | 'DO_ANULOWANIA' | null;
  data: string | null;
}

export const PriceAlertsModal: React.FC<PriceAlertsModalProps> = ({
  alerts,
  quotes,
  openPositions = [],
  accounts = [],
  brokerOrders = [],
  language,
  initialTicker,
  initialAccountId,
  onAddAlert,
  onUpdateAlert,
  onDeleteAlert,
  onToggleAlert,
  onSelectTickerForChart,
  onCreateBrokerOrder,
  onCheckBinanceOrder,
  onCancelBrokerOrder,
}) => {
  // Hosting (telefon): zlecenia w API brokera wymagaja serwera - zakladka i sekcja znikaja.
  const trybHostowany = czyTrybHostowany();
  const t = getTranslation(language);
  const kursyNbp = useKursyNbp();
  const [activeTabFilter, setActiveTabFilter] = useState<'all' | 'alerts' | 'broker_orders'>(() => {
    return (localStorage.getItem('pit38_alerts_filter_tab') as 'all' | 'alerts' | 'broker_orders') || 'all';
  });
  const [showAddForm, setShowAddForm] = useState(false);
  const [editingAlert, setEditingAlert] = useState<PriceAlert | null>(null);
  const refOknaAlertu = useZamknijEscape(showAddForm, () => { setShowAddForm(false); setEditingAlert(null); });
  const [pushStatus, setPushStatus] = useState<string>(pushNotificationService.getPermissionStatus());

  // Add/Edit Alert Form state
  // Zadnych walorow ani cen wpisanych na sztywno: formularz startuje od waloru z portfela
  // i jego prawdziwego kursu, a bez nich - pusty.
  const [ticker, setTicker] = useState('');
  const [targetPrice, setTargetPrice] = useState('');
  const [condition, setCondition] = useState<PriceAlert['condition']>('ABOVE');
  const [alertType, setAlertType] = useState<'PRICE' | 'STOP_LOSS' | 'TAKE_PROFIT'>('PRICE');
  const [percentageThreshold, setPercentageThreshold] = useState('3.0');
  const [expiryOption, setExpiryOption] = useState<ExpiryOption>('7d');

  // Stop-Loss & Take-Profit Calculator / Manager state
  const [selectedSlTpTicker, setSelectedSlTpTicker] = useState<string>(() => {
    if (initialTicker) return initialTicker;
    if (openPositions.length > 0) return openPositions[0].ticker;
    return '';
  });
  const [selectedAccountId, setSelectedAccountId] = useState<string>(() => {
    if (initialAccountId) return initialAccountId;
    if (accounts.length > 0) return accounts[0].id;
    return '';
  });
  const [orderQuantity, setOrderQuantity] = useState<string>(() => {
    const initPos = wybierzPozycjeRachunku(
      openPositions,
      initialTicker || (openPositions[0]?.ticker ?? ''),
      initialAccountId || accounts[0]?.id || '',
    );
    return initPos ? initPos.totalQuantity.toString() : '10';
  });
  const [executionMode, setExecutionMode] = useState<'BROKER_API' | 'LOCAL_ALERT'>(() => {
    return (localStorage.getItem('pit38_alerts_exec_mode') as 'BROKER_API' | 'LOCAL_ALERT') || 'BROKER_API';
  });
  const [isSubmittingOrder, setIsSubmittingOrder] = useState<boolean>(false);
  const [cancellingOrderId, setCancellingOrderId] = useState<string | null>(null);
  const [pendingBinanceReview, setPendingBinanceReview] = useState<PendingBinanceOrder | null>(null);

  // Pozycje dochodza dopiero po wyniku silnika. Wybrany walor musi istniec w portfelu albo
  // w notowaniach - inaczej lista pokazuje pierwsza pozycje, a rachunek liczy sie dla czegos innego.
  React.useEffect(() => {
    const znany = openPositions.some((p) => p.ticker === selectedSlTpTicker) || Boolean(quotes[selectedSlTpTicker]);
    if (!znany && openPositions.length > 0) {
      setSelectedSlTpTicker(openPositions[0].ticker);
      const pos = wybierzPozycjeRachunku(openPositions, openPositions[0].ticker, selectedAccountId);
      if (pos) setOrderQuantity(pos.totalQuantity.toString());
    }
  }, [openPositions, quotes, selectedSlTpTicker, selectedAccountId]);

  // Synchronize when initialTicker or initialAccountId changes
  React.useEffect(() => {
    if (initialTicker) {
      setSelectedSlTpTicker(initialTicker);
      const pos = wybierzPozycjeRachunku(openPositions, initialTicker, initialAccountId || '');
      if (pos) {
        setOrderQuantity(pos.totalQuantity.toString());
        if (pos.lots && pos.lots.length > 0 && pos.lots[0].accountId) {
          setSelectedAccountId(pos.lots[0].accountId);
        } else if (pos.accountIds && pos.accountIds.length > 0) {
          setSelectedAccountId(pos.accountIds[0]);
        }
      }
    }
  }, [initialTicker, openPositions]);

  React.useEffect(() => {
    if (initialAccountId) {
      setSelectedAccountId(initialAccountId);
    }
  }, [initialAccountId]);

  React.useEffect(() => {
    localStorage.setItem('pit38_alerts_filter_tab', activeTabFilter);
  }, [activeTabFilter]);

  React.useEffect(() => {
    localStorage.setItem('pit38_alerts_exec_mode', executionMode);
  }, [executionMode]);

  const [slPercent, setSlPercent] = useState<number>(5); // -5% default SL
  const [tpPercent, setTpPercent] = useState<number>(15); // +15% default TP
  const [customSlPrice, setCustomSlPrice] = useState<string>('');
  const [customTpPrice, setCustomTpPrice] = useState<string>('');
  const [slTpExpiry, setSlTpExpiry] = useState<ExpiryOption>('30d');
  const [slTpSuccessMessage, setSlTpSuccessMessage] = useState<string | null>(null);

  const quoteList: LiveMarketQuote[] = Object.values(quotes);

  // Ta sama wycena co w tabeli portfela: brak notowania albo kursu to brak wyceny, a nie cena zakupu.
  const wycenionePozycje = useMemo(() => wycenPozycje(openPositions, quotes, kursyNbp), [openPositions, quotes, kursyNbp]);

  // Auto update order quantity when ticker changes
  const activePosition = wybierzPozycjeRachunku(openPositions, selectedSlTpTicker, selectedAccountId);
  const activeAccount = accounts.find((a) => a.id === selectedAccountId);
  const freedom24ReadOnly = activeAccount?.brokerType === 'FREEDOM24';
  // Serwer sklada zlecenia wylacznie dla Binance; Freedom24 jest celowo tylko do
  // odczytu, a XTB i IBKR odpowiadaja 501. Bez tego ekran obiecywal "uzbrajanie
  // w API brokera", ktorego nie ma.
  const brokerPrzyjmujeZlecenia = activeAccount?.brokerType === 'BINANCE' || activeAccount?.brokerType === 'FREEDOM24';

  React.useEffect(() => {
    const odczytajWpis = () => {
      if (!activeAccount || activeAccount.brokerType !== 'BINANCE') {
        setPendingBinanceReview(null);
        return;
      }
      try {
        setPendingBinanceReview(getPendingBinanceOrder(activeAccount.id, selectedSlTpTicker) || null);
      } catch {
        setPendingBinanceReview(null);
      }
    };
    odczytajWpis();
    globalThis.window?.addEventListener('storage', odczytajWpis);
    return () => globalThis.window?.removeEventListener('storage', odczytajWpis);
  }, [activeAccount?.id, activeAccount?.brokerType, selectedSlTpTicker]);

  React.useEffect(() => {
    try {
      for (const pending of getPendingBinanceOrders()) {
        const appearedOnOrderList = brokerOrders.some((order) =>
          order.brokerType === 'BINANCE' && order.accountId === pending.accountId &&
          order.clientOrderId === pending.clientOrderId && order.status !== 'PENDING'
        );
        if (appearedOnOrderList) {
          removePendingBinanceOrder(pending.accountId, pending.ticker);
          setPendingBinanceReview((current) => current?.clientOrderId === pending.clientOrderId ? null : current);
        }
      }
    } catch {
      // Brak dostępu do localStorage blokuje składanie zleceń dalej w handlerze.
    }
  }, [brokerOrders]);
  // SL/TP to zlecenia u brokera. Alerty sa osobna funkcja (przycisk "Nowy Alert") i nie powstaja tutaj.
  const trybRealizacji: 'BROKER_API' | 'LOCAL_ALERT' = 'BROKER_API';

  // Prawdziwe aktywne zlecenia z rachunku Freedom24 (odczyt z brokera, nie z pamieci aplikacji).
  const [zleceniaBrokera, setZleceniaBrokera] = useState<ZlecenieBrokeraWidok[] | null>(null);
  const [bladZlecen, setBladZlecen] = useState<string | null>(null);
  const [ladowanieZlecen, setLadowanieZlecen] = useState(false);
  const odswiezZlecenia = React.useCallback(async () => {
    if (activeAccount?.brokerType !== 'FREEDOM24') {
      setZleceniaBrokera(null);
      return;
    }
    setLadowanieZlecen(true);
    try {
      const res = await apiFetch('/api/brokers/freedom24/orders/active', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      const data = await res.json().catch(() => null);
      if (res.ok && data?.success && Array.isArray(data.orders)) {
        setZleceniaBrokera(data.orders);
        setBladZlecen(null);
      } else {
        setBladZlecen(data?.message || `Nie udało się odczytać zleceń (HTTP ${res.status}).`);
      }
    } catch {
      setBladZlecen('Brak połączenia z serwerem aplikacji.');
    } finally {
      setLadowanieZlecen(false);
    }
  }, [activeAccount?.brokerType]);
  React.useEffect(() => {
    void odswiezZlecenia();
  }, [odswiezZlecenia]);

  const anulujZlecenieBrokera = async (zlecenie: ZlecenieBrokeraWidok) => {
    const opis = `${zlecenie.rodzaj === 'STOP_LOSS' ? 'Stop-Loss' : zlecenie.rodzaj === 'TAKE_PROFIT' ? 'Take-Profit' : 'zlecenie'} ${zlecenie.ticker} (${zlecenie.cenaProgu ?? zlecenie.cenaZlecenia ?? '?'} ${zlecenie.waluta ?? ''})`;
    if (!globalThis.window?.confirm(`Anulować u brokera: ${opis}?\n\nTo prawdziwa operacja na rachunku Freedom24.`)) return;
    let ambiguous = false;
    try {
      const res = await apiFetch('/api/brokers/freedom24/orders/cancel', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ orderId: zlecenie.orderId, confirm: true }) });
      const data = await res.json().catch(() => null);
      ambiguous = data?.ambiguous === true || data === null;
      setSlTpSuccessMessage(ambiguous ? 'Nie wiadomo, czy Freedom24 przyjął polecenie — sprawdź listę zleceń, zanim spróbujesz ponownie' : data?.message || (res.ok ? 'Anulowano.' : `Anulowanie nie powiodło się (HTTP ${res.status}).`));
    } catch {
      ambiguous = true;
      setSlTpSuccessMessage('Nie wiadomo, czy Freedom24 przyjął polecenie — sprawdź listę zleceń, zanim spróbujesz ponownie');
    } finally {
      await odswiezZlecenia();
      if (!ambiguous) setTimeout(() => setSlTpSuccessMessage(null), 7000);
    }
  };

  const handleRequestPush = async () => {
    const granted = await pushNotificationService.requestPermission();
    setPushStatus(granted ? 'granted' : 'denied');
    if (granted) {
      pushNotificationService.sendPushNotification(
        '🔔 Powiadomienia Push Włączone!',
        'Będziesz otrzymywać natychmiastowe alerty o zmianach cen akcji i kryptowalut.',
        'SUCCESS'
      );
    }
  };

  const handleTestNotification = () => {
    pushNotificationService.sendPushNotification(
      '🧪 Test Alertu Cenowego',
      'System powiadomień działa prawidłowo. Otrzymasz alert, gdy kurs przekroczy zadany poziom.',
      'INFO'
    );
  };

  const handleTickerChange = (newTicker: string) => {
    setTicker(newTicker);
    const q = findPriceAlertQuote(newTicker, quotes);
    if (q) {
      setTargetPrice(q.price.toFixed(2));
    }
  };

  const calculateExpiryDate = (option: ExpiryOption): string | undefined => {
    return calculatePriceAlertExpiry(option, Date.now());
  };

  const handleOpenAddModal = () => {
    setEditingAlert(null);
    const domyslny = openPositions[0]?.ticker ?? Object.keys(quotes)[0] ?? '';
    setTicker(domyslny);
    const q = findPriceAlertQuote(domyslny, quotes);
    setTargetPrice(q ? q.price.toFixed(2) : '');
    setCondition('ABOVE');
    setAlertType('PRICE');
    setPercentageThreshold('3.0');
    setExpiryOption('7d');
    setShowAddForm(true);
  };

  const handleOpenEditModal = (alert: PriceAlert) => {
    setEditingAlert(alert);
    setTicker(alert.ticker);
    setTargetPrice(alert.targetPrice.toString());
    setCondition(alert.condition);
    setAlertType(alert.alertType || 'PRICE');
    setPercentageThreshold(alert.percentageThreshold?.toString() || '3.0');
    setExpiryOption(alert.expiresAt ? '7d' : 'never');
    setShowAddForm(true);
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const q = findPriceAlertQuote(ticker, quotes);

    if (editingAlert && onUpdateAlert) {
      onUpdateAlert({
        ...editingAlert,
        ticker,
        targetPrice: parseFloat(targetPrice) || 0,
        currency: q?.currency ?? editingAlert.currency,
        condition,
        alertType,
        percentageThreshold: condition.includes('PERCENT') ? parseFloat(percentageThreshold) : undefined,
        expiresAt: calculateExpiryDate(expiryOption),
      });
    } else {
      onAddAlert({
        ticker,
        targetPrice: parseFloat(targetPrice) || 0,
        currency: q?.currency ?? 'USD',
        condition,
        alertType,
        percentageThreshold: condition.includes('PERCENT') ? parseFloat(percentageThreshold) : undefined,
        isActive: true,
        expiresAt: calculateExpiryDate(expiryOption),
      });
    }

    setShowAddForm(false);
    setEditingAlert(null);
  };

  // Helper to check if alert has expired
  const isAlertExpired = (alert: PriceAlert): boolean => {
    return isPriceAlertExpired(alert, Date.now());
  };

  // Helper to get time remaining text
  const getExpiryDetails = (alert: PriceAlert) => {
    if (!alert.expiresAt) {
      return { text: 'Bezterminowy', status: 'infinite' as const };
    }
    const expiryTime = new Date(alert.expiresAt).getTime();
    const now = Date.now();
    const diffMs = expiryTime - now;

    if (diffMs <= 0) {
      return {
        text: `Wygasł (${new Date(alert.expiresAt).toLocaleDateString('pl-PL')})`,
        status: 'expired' as const,
        date: new Date(alert.expiresAt).toLocaleDateString('pl-PL'),
      };
    }

    const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
    const diffDays = Math.floor(diffHours / 24);

    if (diffDays > 0) {
      return {
        text: `Wygasa za: ${diffDays} ${odmienLiczebnik(diffDays, 'dzień', 'dni', 'dni')} (${new Date(alert.expiresAt).toLocaleDateString('pl-PL')})`,
        status: diffDays <= 2 ? ('warning' as const) : ('active' as const),
        date: new Date(alert.expiresAt).toLocaleDateString('pl-PL'),
      };
    }

    return {
      // Ostatnia godzina to "< 1 h", a nie "0h", ktore wygladalo na wygasly alert.
      text: `Wygasa za: ${diffHours > 0 ? `${diffHours} h` : '< 1 h'} (${new Date(alert.expiresAt).toLocaleTimeString('pl-PL', { hour: '2-digit', minute: '2-digit' })})`,
      status: 'warning' as const,
      date: new Date(alert.expiresAt).toLocaleDateString('pl-PL'),
    };
  };

  // Renew an expired alert for +7 days
  const handleRenewAlert = (alert: PriceAlert) => {
    const newExpiry = calculateExpiryDate('7d');
    if (onUpdateAlert) {
      onUpdateAlert({
        ...alert,
        isActive: true,
        isTriggered: false,
        expiresAt: newExpiry,
      });
    } else {
      onDeleteAlert(alert.id);
      onAddAlert({
        ticker: alert.ticker,
        targetPrice: alert.targetPrice,
        currency: alert.currency,
        condition: alert.condition,
        alertType: alert.alertType,
        percentageThreshold: alert.percentageThreshold,
        isActive: true,
        expiresAt: newExpiry,
      });
    }
  };

  // SL / TP Selected Asset computation
  // Bez notowania wybranego waloru wchodzila tu cena NVDA, a gdy i jej nie
  // bylo - 100 USD. Ta wymyslona liczba wyznaczala progi SL/TP i szla
  // w zleceniu do brokera.
  const activeSlTpQuote = quotes[selectedSlTpTicker] || null;
  // Waluta pochodzi z notowania albo z otwartej pozycji; bez zadnego z nich
  // nie wiadomo, w czym wyrazic prog - i alert nie powstaje.
  const walutaSlTp: CurrencyCode | null =
    activeSlTpQuote?.currency
    ?? pozycjaTickeraDoInformacji(openPositions, selectedSlTpTicker, selectedAccountId)?.currency
    ?? null;

  const currentPrice: number | null = activeSlTpQuote ? activeSlTpQuote.price : null;
  // Progi liczymy od AKTUALNEGO kursu. Liczone od ceny zakupu dawaly przy stratnej
  // pozycji stop-loss powyzej rynku (253,40 przy kursie 223,54), a podpowiedz w polu
  // pokazywala juz inna liczbe, bo byla liczona od kursu.
  const basePrice: number | null = currentPrice;

  /** Liczba albo myslnik - nigdy podstawiona cena. */
  const kwotaLubBrak = (wartosc: number | null): string =>
    wartosc === null ? '—' : formatLiczba(wartosc);

  // Calculate actual SL price & TP price
  const calculatedSlPrice = useMemo(() => {
    if (customSlPrice && parseFloat(customSlPrice) > 0) {
      return parseFloat(customSlPrice);
    }
    if (basePrice === null) return null;
    return progOdKursu(basePrice, slPercent, 'SL');
  }, [customSlPrice, basePrice, slPercent]);

  const calculatedTpPrice = useMemo(() => {
    if (customTpPrice && parseFloat(customTpPrice) > 0) {
      return parseFloat(customTpPrice);
    }
    if (basePrice === null) return null;
    return progOdKursu(basePrice, tpPercent, 'TP');
  }, [customTpPrice, basePrice, tpPercent]);

  // Risk / Reward Ratio - liczony tylko wtedy, gdy znany jest aktualny kurs.
  const { rrr: rrrRatio, blad: bladProgow } = ocenProgi(currentPrice, calculatedSlPrice, calculatedTpPrice);
  // Pasek ryzyko/zysk: udzial ryzyka wynika wprost z RRR; bez poprawnych progow - pol na pol.
  const udzialRyzyka = rrrRatio === null ? 50 : Math.max(10, Math.min(85, (1 / (1 + rrrRatio)) * 100));

  // Distance from current price to SL & TP
  const distanceToSlPct =
    currentPrice !== null && currentPrice !== 0 && calculatedSlPrice !== null
      ? ((currentPrice - calculatedSlPrice) / currentPrice) * 100
      : null;
  const distanceToTpPct =
    currentPrice !== null && currentPrice !== 0 && calculatedTpPrice !== null
      ? ((calculatedTpPrice - currentPrice) / currentPrice) * 100
      : null;

  const sprawdzNiepewneZlecenie = async (
    account: BrokerAccount,
    pending: PendingBinanceOrder,
  ): Promise<'found' | 'not-found' | 'uncertain'> => {
    if (!onCheckBinanceOrder) {
      setPendingBinanceReview(pending);
      setSlTpSuccessMessage('Nie można teraz sprawdzić statusu. Sprawdź zlecenia w Binance przed kolejną próbą.');
      return 'uncertain';
    }
    let wynik: BinanceOrderLookupResult;
    try {
      wynik = await onCheckBinanceOrder(account, pending.ticker, pending.clientOrderId);
    } catch {
      wynik = { success: false, found: false, message: 'Nie udało się sprawdzić statusu zlecenia Binance.' };
    }

    if (wynik.success && wynik.found) {
      try {
        removePendingBinanceOrder(pending.accountId, pending.ticker);
        setPendingBinanceReview(null);
      } catch {
        setPendingBinanceReview(pending);
        setSlTpSuccessMessage(`Binance potwierdził zlecenie ${wynik.order?.orderId || pending.clientOrderId} (${wynik.order?.status || 'status nieznany'}), ale nie udało się usunąć wpisu blokady. Nie wysłano nowego zlecenia.`);
        return 'uncertain';
      }
      setSlTpSuccessMessage(`Zlecenie istnieje w Binance: nr ${wynik.order?.orderId || pending.clientOrderId}, status ${wynik.order?.status || 'nieznany'}. Nie wysłano nowego zlecenia.`);
      return 'found';
    }

    if (wynik.success && !wynik.found && wynik.definitive) {
      try {
        removePendingBinanceOrder(pending.accountId, pending.ticker);
        setPendingBinanceReview(null);
      } catch {
        setPendingBinanceReview(pending);
        setSlTpSuccessMessage('Binance nie znalazł zlecenia, ale nie udało się usunąć wpisu blokady. Ponów sprawdzenie przed kolejną próbą.');
        return 'uncertain';
      }
      setSlTpSuccessMessage('Binance potwierdził, że zlecenie nie istnieje. Możesz ponowić wysłanie.');
      return 'not-found';
    }

    setPendingBinanceReview(pending);
    setSlTpSuccessMessage(`${wynik.message} Nie wysłano nowego zlecenia.`);
    return 'uncertain';
  };

  const ponowSprawdzenieZleceniaBinance = async () => {
    if (!pendingBinanceReview || !activeAccount || activeAccount.brokerType !== 'BINANCE') return;
    setIsSubmittingOrder(true);
    try {
      await sprawdzNiepewneZlecenie(activeAccount, pendingBinanceReview);
    } finally {
      setIsSubmittingOrder(false);
    }
  };

  // Handler to execute or set dual SL/TP
  const handleExecuteProtection = async () => {
    const expiresAt = calculateExpiryDate(slTpExpiry);

    if (!activeAccount) {
      setSlTpSuccessMessage('Nie znaleziono rachunku. Wybierz rachunek przed wysłaniem zlecenia.');
      setTimeout(() => setSlTpSuccessMessage(null), 6000);
      return;
    }

    if (trybRealizacji === 'BROKER_API' && !brokerPrzyjmujeZlecenia) {
      setSlTpSuccessMessage('Ten broker nie przyjmuje zleceń z aplikacji (obsługiwane: Freedom24, Binance).');
      setTimeout(() => setSlTpSuccessMessage(null), 6000);
      return;
    }

    if (calculatedSlPrice === null || calculatedTpPrice === null || walutaSlTp === null) {
      setSlTpSuccessMessage(
        `Brak notowania dla ${selectedSlTpTicker} - nie ma z czego policzyć progów SL/TP. Wpisz własne kursy.`
      );
      setTimeout(() => setSlTpSuccessMessage(null), 6000);
      return;
    }

    const sl = parseFloat(calculatedSlPrice.toFixed(2));
    const tp = parseFloat(calculatedTpPrice.toFixed(2));

    if (activeAccount.brokerType === 'FREEDOM24') {
      const zgoda = globalThis.window?.confirm(
        `Wysłać do Freedom24 PRAWDZIWE zlecenie ochronne?\n\n${selectedSlTpTicker}\nStop-Loss: ${sl} ${walutaSlTp}\nTake-Profit: ${tp} ${walutaSlTp}\n\nZlecenie obejmie posiadaną pozycję i zastąpi dotychczasowe SL/TP tego waloru.`,
      );
      if (!zgoda) return;
      setIsSubmittingOrder(true);
      let ambiguous = false;
      try {
        const res = await apiFetch('/api/brokers/freedom24/orders/protect', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ticker: selectedSlTpTicker, stopLoss: sl, takeProfit: tp, confirm: true }),
        });
        const data = await res.json().catch(() => null);
        ambiguous = data?.ambiguous === true || data === null;
        setSlTpSuccessMessage(ambiguous ? 'Nie wiadomo, czy Freedom24 przyjął polecenie — sprawdź listę zleceń, zanim spróbujesz ponownie' : data?.message || (res.ok ? 'Freedom24 przyjęło zlecenie.' : `Zlecenie nie zostało przyjęte (HTTP ${res.status}).`));
      } catch {
        ambiguous = true;
        setSlTpSuccessMessage('Nie wiadomo, czy Freedom24 przyjął polecenie — sprawdź listę zleceń, zanim spróbujesz ponownie');
      } finally {
        setIsSubmittingOrder(false);
        if (!ambiguous) setTimeout(() => setSlTpSuccessMessage(null), 8000);
        await odswiezZlecenia();
      }
      return;
    }

    if (!onCreateBrokerOrder) return;
    const qty = iloscZlecenia(orderQuantity);
    if (qty === null) {
      setSlTpSuccessMessage('Podaj poprawną ilość większą od zera. Zlecenie nie zostało wysłane.');
      return;
    }
    const binance = activeAccount.brokerType === 'BINANCE';
    let existingPending: PendingBinanceOrder | undefined;
    if (binance) {
      try {
        existingPending = getPendingBinanceOrder(activeAccount.id, selectedSlTpTicker);
      } catch {
        setSlTpSuccessMessage('Nie można odczytać trwałego rejestru zleceń. Nie wysłano zlecenia Binance.');
        return;
      }
      if (existingPending) {
        setIsSubmittingOrder(true);
        const status = await sprawdzNiepewneZlecenie(activeAccount, existingPending);
        setIsSubmittingOrder(false);
        if (status !== 'not-found') return;
      }
    }
    let brokerQuantity = qty;
    let brokerStop = sl;
    let brokerLimit = parseFloat((sl * 0.99).toFixed(2));
    let brokerQuantityText = String(brokerQuantity);
    let brokerStopText = String(brokerStop);
    let brokerLimitText = String(brokerLimit);
    if (binance) {
      try {
        const previewResponse = await apiFetch('/api/brokers/orders/preview', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ticker: selectedSlTpTicker, action: 'SELL', quantity: qty,
            stopPrice: calculatedSlPrice, limitPrice: calculatedSlPrice * 0.99 }),
        });
        const preview = await previewResponse.json();
        if (!previewResponse.ok || !preview.success) {
          setSlTpSuccessMessage(preview.message || 'Nie udało się pobrać kroków zlecenia Binance.');
          return;
        }
        brokerQuantity = Number(preview.quantity);
        brokerStop = Number(preview.stopPrice);
        brokerLimit = Number(preview.limitPrice);
        brokerQuantityText = String(preview.quantity);
        brokerStopText = String(preview.stopPrice);
        brokerLimitText = String(preview.limitPrice);
      } catch {
        setSlTpSuccessMessage('Nie udało się pobrać kroków zlecenia Binance.');
        return;
      }
    }
    const confirmedExpiry = expiresAt;
    const zgoda = globalThis.window?.confirm(
      `Wysłać do brokera ${activeAccount.name} zlecenie sprzedaży ${brokerQuantityText} szt. ${selectedSlTpTicker}?\n` +
      `Stop-Loss: ${brokerStopText} ${walutaSlTp}\n` +
      (binance ? `Cena limit: ${brokerLimitText} ${walutaSlTp}\n` : '') +
      (binance ? 'Take-Profit: NIE zostanie złożony\n' : `Take-Profit: ${tp} ${walutaSlTp}\n`) +
      `Typ: OCO_BRACKET (Binance składa tylko STOP_LOSS_LIMIT)\n` +
      `Ważne do: ${confirmedExpiry ?? 'bez terminu'}`
    );
    if (!zgoda) return;
    setIsSubmittingOrder(true);
    let clientOrderId: string | undefined;
    let orderExpiresAt = expiresAt;
    let pendingOrder: PendingBinanceOrder | undefined;
    if (binance) {
      try {
        // Ponowne odczytanie po oknie potwierdzenia uwzględnia wpis utworzony w innej karcie.
        const appearedWhileConfirming = getPendingBinanceOrder(activeAccount.id, selectedSlTpTicker);
        if (appearedWhileConfirming) {
          const status = await sprawdzNiepewneZlecenie(activeAccount, appearedWhileConfirming);
          if (status !== 'not-found') {
            setIsSubmittingOrder(false);
            return;
          }
        }
        const parameters: BinanceOrderParameters = {
          quantity: brokerQuantity,
          stopPrice: brokerStop,
          limitPrice: brokerLimit,
          currency: walutaSlTp,
          expiresAt: confirmedExpiry,
        };
        pendingOrder = reserveBinanceOrder(activeAccount.id, selectedSlTpTicker, parameters);
        clientOrderId = pendingOrder.clientOrderId;
        orderExpiresAt = pendingOrder.parameters.expiresAt;
        setPendingBinanceReview(pendingOrder);
      } catch {
        setIsSubmittingOrder(false);
        setSlTpSuccessMessage('Nie udało się zapisać trwałej blokady zlecenia. Nie wysłano zlecenia Binance.');
        return;
      }
    }
    let ambiguous = false;
    try {
      const res = await onCreateBrokerOrder(activeAccount, {
        confirm: true,
        ...(binance ? { newClientOrderId: clientOrderId } : {}),
        ticker: selectedSlTpTicker,
        orderType: 'OCO_BRACKET',
        action: 'SELL',
        quantity: brokerQuantity,
        stopPrice: brokerStop,
        ...(binance ? { limitPrice: pendingOrder?.parameters.limitPrice } : {}),
        takeProfitPrice: binance ? undefined : tp,
        currency: walutaSlTp,
        expiresAt: orderExpiresAt,
      });
      ambiguous = binance && res.ambiguous === true;
      if (ambiguous) {
        if (pendingOrder) setPendingBinanceReview(pendingOrder);
        setSlTpSuccessMessage('Nie wiadomo, czy Binance przyjął zlecenie — sprawdź zlecenia w Binance przed ponowieniem.');
      } else {
        if (binance && pendingOrder) {
          try {
            removePendingBinanceOrder(activeAccount.id, selectedSlTpTicker);
            setPendingBinanceReview(null);
          } catch {
            setPendingBinanceReview(pendingOrder);
            setSlTpSuccessMessage('Binance zwrócił wynik, ale nie udało się usunąć wpisu blokady. Sprawdź zlecenia przed kolejną próbą.');
            return;
          }
        }
        setSlTpSuccessMessage(res.success ? `Broker ${activeAccount.name} przyjął zlecenie${res.orderId ? ` nr ${res.orderId}` : ''}. ${binance ? 'Złożono tylko Stop-Loss; Take-Profit NIE został złożony.' : ''}` : `Broker odrzucił zlecenie: ${res.message}`);
      }
    } catch (err: any) {
      ambiguous = binance;
      if (ambiguous) {
        if (pendingOrder) setPendingBinanceReview(pendingOrder);
        setSlTpSuccessMessage('Nie wiadomo, czy Binance przyjął zlecenie — sprawdź zlecenia w Binance przed ponowieniem.');
      } else {
        setSlTpSuccessMessage(`Błąd połączenia z serwerem: ${err.message || 'nieznany'}`);
      }
    } finally {
      setIsSubmittingOrder(false);
      if (!ambiguous) setTimeout(() => setSlTpSuccessMessage(null), 6000);
      await odswiezZlecenia();
    }
  };

  const handleCancelOrder = async (order: BrokerOrder) => {
    if (!onCancelBrokerOrder) return;
    const numer = order.orderId || order.id;
    const rachunek = accounts.find((a) => a.id === order.accountId);
    if (!globalThis.window?.confirm(`Anulować u brokera zlecenie nr ${numer} dla ${order.ticker} na rachunku ${rachunek?.name ?? order.accountId}?`)) return;
    setCancellingOrderId(order.id);
    try {
      const res = await onCancelBrokerOrder(numer, order.accountId, order.ticker, true);
      if (!res.success) setSlTpSuccessMessage(res.message);
    } finally {
      setCancellingOrderId(null);
    }
  };

  const armedOrders = brokerOrders.filter((o) => o.status === 'ARMED');

  return (
    <div id="price-alerts-container" className="space-y-5">
      {/* Top Banner - Compact & Narrow */}
      {/* Przyciski zawijaja sie i schodza pod tytul: w oknie 640-700 px sztywna grupa wypychala
          "Nowy Alert" poza ekran, a tytul sciskala do jednego slowa w wierszu. */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-3 bg-white dark:bg-slate-900 px-4 py-3 sm:px-5 sm:py-3.5 rounded-xl border border-slate-200 dark:border-slate-800 shadow-xs">
        <div className="min-w-0">
          <h1 className="text-lg sm:text-xl font-bold text-slate-900 dark:text-white flex items-center gap-2">
            <Bell className="w-5 h-5 text-blue-600 shrink-0" />
            <span>Alerty Cenowe i Progi Ochronne</span>
          </h1>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
            Alerty cenowe w aplikacji oraz — osobno — prawdziwe zlecenia Stop-Loss / Take-Profit na rachunku brokera.
          </p>
        </div>

        <div className="flex min-w-0 flex-wrap items-center gap-1.5 sm:gap-2 self-start md:self-center md:justify-end lg:shrink-0">
          {pushStatus !== 'granted' ? (
            <button
              onClick={handleRequestPush}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg bg-amber-500 hover:bg-amber-400 text-amber-950 shadow-xs transition-all duration-150 cursor-pointer active:scale-[0.98]"
            >
              <span className="relative flex h-2 w-2">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-white opacity-75" />
                <span className="relative inline-flex rounded-full h-2 w-2 bg-white" />
              </span>
              <span>{t.enableBrowserPush}</span>
            </button>
          ) : (
            <div className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-emerald-500/10 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300 border border-emerald-500/20 text-xs font-semibold select-none">
              <span className="relative flex h-2 w-2">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
                <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500" />
              </span>
              <span>{t.pushActive}</span>
            </div>
          )}

          <button
            onClick={handleTestNotification}
            className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium rounded-lg bg-slate-100 hover:bg-slate-200 dark:bg-slate-800 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-200 border border-slate-200/80 dark:border-slate-700/80 transition-all cursor-pointer"
            title="Wyślij testowe powiadomienie z dźwiękiem"
          >
            <Volume2 className="w-3.5 h-3.5 text-slate-500 dark:text-slate-400" />
            <span className="hidden sm:inline">Test Dźwięku</span>
          </button>

          <button
            onClick={handleOpenAddModal}
            className="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-semibold rounded-lg bg-blue-600 hover:bg-blue-500 text-white shadow-xs transition-all cursor-pointer active:scale-[0.98]"
          >
            <Plus className="w-3.5 h-3.5" />
            <span>Nowy Alert</span>
          </button>
        </div>
      </div>

      {/* Filter Tabs between All, App Alerts, and Real Broker Armed Orders */}
      <div className="flex items-center gap-2 border-b border-slate-200 dark:border-slate-800 pb-2 overflow-x-auto">
        <button
          onClick={() => setActiveTabFilter('all')}
          className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors cursor-pointer flex items-center gap-1.5 whitespace-nowrap shrink-0 ${
            activeTabFilter === 'all'
              ? 'bg-blue-600 text-white shadow-xs'
              : 'text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800'
          }`}
        >
          <Layers className="w-3.5 h-3.5" />
          <span>Wszystkie ({alerts.length + brokerOrders.length})</span>
        </button>

        {!trybHostowany && (
        <button
          onClick={() => setActiveTabFilter('broker_orders')}
          className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors cursor-pointer flex items-center gap-1.5 whitespace-nowrap shrink-0 ${
            activeTabFilter === 'broker_orders'
              ? 'bg-emerald-700 text-white shadow-xs'
              : 'text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800'
          }`}
        >
          <Server className="w-3.5 h-3.5 text-emerald-300" />
          <span>Uzbrojone w API Brokera ({armedOrders.length})</span>
        </button>
        )}

        <button
          onClick={() => setActiveTabFilter('alerts')}
          className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors cursor-pointer flex items-center gap-1.5 whitespace-nowrap shrink-0 ${
            activeTabFilter === 'alerts'
              ? 'bg-slate-800 dark:bg-slate-700 text-white shadow-xs'
              : 'text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800'
          }`}
        >
          <Bell className="w-3.5 h-3.5" />
          <span>Alerty Aplikacji ({alerts.length})</span>
        </button>
      </div>

      {/* ========================================================================= */}
      {/* SEKCJA 1: UZBROJONE ZLECENIA W API BROKERA (LIVE REAL-TIME ORDERS) */}
      {/* ========================================================================= */}
      {!trybHostowany && (activeTabFilter === 'all' || activeTabFilter === 'broker_orders') && brokerOrders.length > 0 && (
        <div className="space-y-3">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-0.5 text-xs text-slate-500 dark:text-slate-400 px-1">
            <span className="font-semibold text-emerald-700 dark:text-emerald-400 flex items-center gap-1.5">
              <Server className="w-4 h-4" />
              <span>Aktywne Zlecenia Ochronne w API Brokerów (Real-Time Protection Engine)</span>
            </span>
            <span className="text-[11px] font-mono text-slate-400">
              Egzekucja bezpośrednio na serwerach giełdowych
            </span>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3.5">
            {brokerOrders.map((order) => {
              const quote = quotes[order.ticker.toUpperCase()];
              const isArmed = order.status === 'ARMED';
              const isExecuted = order.status === 'EXECUTED';
              const isCancelled = order.status === 'CANCELLED';

              const currentP = quote?.price;
              const stopDist = currentP && order.stopPrice ? ((currentP - order.stopPrice) / currentP) * 100 : null;
              const tpDist = currentP && order.takeProfitPrice ? ((order.takeProfitPrice - currentP) / currentP) * 100 : null;

              return (
                <div
                  key={order.id}
                  className={`min-w-0 p-4 rounded-xl border transition-all flex flex-col justify-between space-y-3 ${
                    isExecuted
                      ? 'bg-emerald-50/60 dark:bg-emerald-950/30 border-emerald-300 dark:border-emerald-800'
                      : isCancelled
                      ? 'bg-slate-50 dark:bg-slate-900/40 border-slate-200 dark:border-slate-800 opacity-60'
                      : 'bg-white dark:bg-slate-900 border-blue-200 dark:border-blue-900/80 shadow-xs hover:border-blue-300'
                  }`}
                >
                  <div className="space-y-2">
                    {/* Top Row: Ticker + Broker Tag + Status */}
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                        <button
                          onClick={() => onSelectTickerForChart?.(order.ticker)}
                          className="min-w-0 break-all text-left font-bold text-base text-slate-900 dark:text-white hover:text-blue-600 transition-colors font-mono cursor-pointer"
                        >
                          {order.ticker}
                        </button>
                        <span className="shrink-0 whitespace-nowrap px-2 py-0.5 rounded text-[10px] font-bold bg-blue-100 dark:bg-blue-950 text-blue-700 dark:text-blue-300 border border-blue-200 dark:border-blue-800">
                          {order.brokerType} API
                        </span>
                      </div>

                      {isArmed && (
                        <span className="shrink-0 whitespace-nowrap inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-bold bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300 border border-emerald-300">
                          <span className="relative flex h-1.5 w-1.5">
                            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
                            <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-emerald-500" />
                          </span>
                          UZBROJONE
                        </span>
                      )}
                      {isExecuted && (
                        <span className="shrink-0 whitespace-nowrap px-2 py-0.5 rounded text-[10px] font-bold bg-purple-100 text-purple-800 dark:bg-purple-950 dark:text-purple-300">
                          PRÓG OSIĄGNIĘTY
                        </span>
                      )}
                      {isCancelled && (
                        <span className="shrink-0 whitespace-nowrap px-2 py-0.5 rounded text-[10px] font-bold bg-slate-200 text-slate-700 dark:bg-slate-800 dark:text-slate-400">
                          ANULOWANE
                        </span>
                      )}
                    </div>

                    {/* Order Details */}
                    <div className="text-xs space-y-1 bg-slate-50 dark:bg-slate-800/60 p-2.5 rounded-lg border border-slate-200/80 dark:border-slate-700/60 font-mono">
                      <div className="flex justify-between text-slate-600 dark:text-slate-300">
                        <span>Typ zlecenia:</span>
                        <span className="font-bold text-slate-900 dark:text-white">
                          {order.orderType === 'OCO_BRACKET' ? 'OCO Bracket (SL + TP)' : order.orderType}
                        </span>
                      </div>
                      <div className="flex justify-between text-slate-600 dark:text-slate-300">
                        <span>Ilość (Wolumen):</span>
                        <span className="font-semibold">{order.quantity} szt.</span>
                      </div>
                      {order.stopPrice && (
                        <div className="flex justify-between text-rose-600 dark:text-rose-400">
                          <span>Próg Stop-Loss:</span>
                          <span className="font-bold">{formatLiczba(order.stopPrice)} {order.currency}</span>
                        </div>
                      )}
                      {order.takeProfitPrice && (
                        <div className="flex justify-between text-emerald-600 dark:text-emerald-400">
                          <span>Próg Take-Profit:</span>
                          <span className="font-bold">{formatLiczba(order.takeProfitPrice)} {order.currency}</span>
                        </div>
                      )}
                    </div>

                    {/* Live Quote & Real-Time Distance Tracking */}
                    {quote && isArmed && (
                      <div className="p-2 rounded-lg bg-blue-50/50 dark:bg-blue-950/30 border border-blue-200/60 dark:border-blue-900/40 text-[11px] font-mono space-y-1">
                        <div className="flex justify-between text-slate-700 dark:text-slate-300">
                          <span>Kurs na żywo:</span>
                          <span className="font-bold">{formatLiczba(quote.price)} {quote.currency}</span>
                        </div>
                        {stopDist !== null && (
                          <div className="flex justify-between text-rose-600">
                            <span>Dystans do SL:</span>
                            <span className="font-semibold">-{formatLiczba(stopDist)}%</span>
                          </div>
                        )}
                        {tpDist !== null && (
                          <div className="flex justify-between text-emerald-600">
                            <span>Dystans do TP:</span>
                            <span className="font-semibold">+{formatLiczba(tpDist)}%</span>
                          </div>
                        )}
                      </div>
                    )}

                    {/* Server Message or Order ID */}
                    <div className="text-[10px] text-slate-400 truncate flex items-center justify-between">
                      <span>ID: {order.orderId || order.id}</span>
                      <span>{new Date(order.createdAt).toLocaleTimeString('pl-PL')}</span>
                    </div>
                  </div>

                  {/* Actions */}
                  {isArmed && (
                    <div className="pt-2 border-t border-slate-100 dark:border-slate-800">
                      <button
                        onClick={() => handleCancelOrder(order)}
                        disabled={cancellingOrderId === order.id}
                        className="w-full py-1.5 px-3 rounded-lg text-xs font-semibold bg-rose-50 hover:bg-rose-100 dark:bg-rose-950/60 dark:hover:bg-rose-900/60 text-rose-700 dark:text-rose-300 border border-rose-200 dark:border-rose-800 transition-colors flex items-center justify-center gap-1.5 cursor-pointer disabled:opacity-50"
                      >
                        {cancellingOrderId === order.id ? (
                          <>
                            <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                            <span>Wycofywanie z API...</span>
                          </>
                        ) : (
                          <>
                            <XCircle className="w-3.5 h-3.5" />
                            <span>Anuluj Zlecenie w API Brokera</span>
                          </>
                        )}
                      </button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* ========================================================================= */}
      {/* SEKCJA 2: ALERTY APLIKACJI (NOTIFICATION ALERTS) */}
      {/* ========================================================================= */}
      {(activeTabFilter === 'all' || activeTabFilter === 'alerts') && (
        <div className="space-y-3">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-0.5 text-xs text-slate-500 dark:text-slate-400 px-1">
            <span className="font-semibold text-slate-700 dark:text-slate-200">
              Alerty Aplikacji & Monitorowanie Kursów ({alerts.length})
            </span>
            <span className="text-[11px]">
              Wygasłe alerty automatycznie przestają generować powiadomienia
            </span>
          </div>

          {alerts.length === 0 ? (
            <div className="p-8 text-center bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-800 text-sm text-slate-500">
              Brak zdefiniowanych alertów. Kliknij <b>Nowy Alert</b> lub skorzystaj z poniższego modułu Stop-Loss & Take-Profit.
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3.5">
              {alerts.map((alert) => {
                const quote = findPriceAlertQuote(alert.ticker, quotes);
                const currencyMismatch = quote && quote.currency !== alert.currency;
                const expired = isAlertExpired(alert);
                const expiryDetails = getExpiryDetails(alert);

                return (
                  <div
                    key={alert.id}
                    className={`min-w-0 p-4 rounded-xl border transition-all flex flex-col justify-between space-y-3 ${
                      expired
                        ? 'bg-slate-50/80 dark:bg-slate-900/40 border-slate-200 dark:border-slate-800 opacity-65 grayscale-[25%]'
                        : alert.isTriggered
                        ? 'bg-amber-50/70 dark:bg-amber-950/30 border-amber-300 dark:border-amber-700/80'
                        : alert.isActive
                        ? 'bg-white dark:bg-slate-900 border-slate-200 dark:border-slate-800 hover:border-slate-300 dark:hover:border-slate-700 shadow-2xs'
                        : 'bg-slate-50 dark:bg-slate-800/40 border-slate-200 dark:border-slate-800 opacity-60'
                    }`}
                  >
                    <div>
                      {/* Card Top: Ticker, Type Tag & Action Buttons (Edit + Delete) */}
                      {/* Dlugi symbol (np. opcja Freedom24) lamie sie w karcie; wczesniej wypychal
                          przyciski edycji i usuwania poza karte, a caly widok poza ekran. */}
                      <div className="flex items-start justify-between gap-2">
                        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                          <button
                            onClick={() => onSelectTickerForChart?.(alert.ticker)}
                            className="min-w-0 break-all text-left font-bold text-base text-slate-900 dark:text-white hover:text-blue-600 transition-colors font-mono cursor-pointer"
                            title="Pokaż wykres świecowy tego instrumentu"
                          >
                            {alert.ticker}
                          </button>

                          {/* Alert Type Badge */}
                          {alert.alertType === 'STOP_LOSS' && (
                            <span className="shrink-0 whitespace-nowrap text-[10px] font-semibold px-1.5 py-0.5 rounded bg-rose-100 dark:bg-rose-950/80 text-rose-700 dark:text-rose-300 border border-rose-200 dark:border-rose-800 flex items-center gap-1">
                              <ShieldAlert className="w-3 h-3 text-rose-600" />
                              <span>Stop-Loss</span>
                            </span>
                          )}
                          {alert.alertType === 'TAKE_PROFIT' && (
                            <span className="shrink-0 whitespace-nowrap text-[10px] font-semibold px-1.5 py-0.5 rounded bg-emerald-100 dark:bg-emerald-950/80 text-emerald-700 dark:text-emerald-300 border border-emerald-200 dark:border-emerald-800 flex items-center gap-1">
                              <Target className="w-3 h-3 text-emerald-600" />
                              <span>Take-Profit</span>
                            </span>
                          )}
                          {(!alert.alertType || alert.alertType === 'PRICE') && (
                            <span className="shrink-0 whitespace-nowrap text-[10px] font-medium px-1.5 py-0.5 rounded bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 border border-slate-200 dark:border-slate-700">
                              Cenowy
                            </span>
                          )}
                        </div>

                        <div className="flex shrink-0 items-center gap-1">
                          <button
                            onClick={() => handleOpenEditModal(alert)}
                            className="p-1 text-slate-400 hover:text-blue-600 transition-colors cursor-pointer rounded hover:bg-blue-50 dark:hover:bg-blue-950/40"
                            title="Edytuj parametry alertu"
                          >
                            <Edit3 className="w-4 h-4" />
                          </button>

                          <button
                            onClick={() => onDeleteAlert(alert.id)}
                            className="p-1 text-slate-400 hover:text-rose-600 transition-colors cursor-pointer rounded hover:bg-rose-50 dark:hover:bg-rose-950/40"
                            title="Usuń alert"
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        </div>
                      </div>

                      {/* Current Market Price Reference */}
                      {quote && (
                        <div className="mt-1 text-[11px] font-mono text-slate-500 dark:text-slate-400 flex items-center gap-2">
                          <span>Aktualny kurs: <b className="text-slate-800 dark:text-slate-200">{formatLiczba(quote.price)} {quote.currency}</b></span>
                          <span className={(zmianaLubNull(quote.changePercent24h) ?? 0) >= 0 ? 'text-emerald-700 dark:text-emerald-400' : 'text-rose-700 dark:text-rose-400'}>
                            ({formatujProcentZmiany(quote.changePercent24h)})
                          </span>
                        </div>
                      )}
                      {currencyMismatch && (
                        <div role="status" className="mt-1 text-[11px] font-medium text-amber-700 dark:text-amber-300">
                          Waluta notowania inna niż waluta alertu ({quote.currency} / {alert.currency}); alert nie zostanie wyzwolony.
                        </div>
                      )}

                      {/* Trigger Condition Text */}
                      <div className="mt-2.5 text-xs space-y-1.5">
                        <div className="font-medium text-slate-800 dark:text-slate-200 flex items-center gap-1.5">
                          {alert.condition === 'ABOVE' && (
                            <>
                              <TrendingUp className="w-3.5 h-3.5 text-emerald-500 shrink-0" />
                              <span>Wyzwól powyżej: <b>{formatLiczba(alert.targetPrice)} {alert.currency}</b></span>
                            </>
                          )}
                          {alert.condition === 'BELOW' && (
                            <>
                              <TrendingDown className="w-3.5 h-3.5 text-rose-500 shrink-0" />
                              <span>Wyzwól poniżej: <b>{formatLiczba(alert.targetPrice)} {alert.currency}</b></span>
                            </>
                          )}
                          {alert.condition === 'PERCENT_CHANGE_UP' && (
                            <>
                              <TrendingUp className="w-3.5 h-3.5 text-emerald-500 shrink-0" />
                              <span>Wzrost 24h o ponad <b>+{alert.percentageThreshold}%</b></span>
                            </>
                          )}
                          {alert.condition === 'PERCENT_CHANGE_DOWN' && (
                            <>
                              <TrendingDown className="w-3.5 h-3.5 text-rose-500 shrink-0" />
                              <span>Spadek 24h o ponad <b>-{alert.percentageThreshold}%</b></span>
                            </>
                          )}
                        </div>

                        {/* Triggered Status Message */}
                        {alert.isTriggered && alert.triggeredAt && (
                          <div className="p-2 rounded-lg bg-amber-100/70 dark:bg-amber-900/40 text-amber-900 dark:text-amber-200 text-[11px] font-medium flex items-center gap-1.5 mt-2 border border-amber-200 dark:border-amber-800">
                            <AlertTriangle className="w-3.5 h-3.5 shrink-0 text-amber-600" />
                            <span>{alert.message || `Wyzwolono: ${new Date(alert.triggeredAt).toLocaleTimeString('pl-PL')}`}</span>
                          </div>
                        )}
                      </div>
                    </div>

                    {/* Card Bottom: Validity / Expiry Bar & Toggle / Renew Button */}
                    <div className="space-y-2 pt-2.5 border-t border-slate-100 dark:border-slate-800 text-xs">
                      {/* Expiration Indicator */}
                      <div className="flex items-center justify-between gap-1 text-[11px]">
                        <div className="flex items-center gap-1.5">
                          <Clock className={`w-3.5 h-3.5 ${
                            expired
                              ? 'text-slate-400'
                              : expiryDetails.status === 'warning'
                              ? 'text-amber-500'
                              : 'text-blue-500'
                          }`} />
                          <span className={`font-medium ${
                            expired
                              ? 'text-rose-600 dark:text-rose-400 line-through'
                              : expiryDetails.status === 'warning'
                              ? 'text-amber-700 dark:text-amber-400'
                              : 'text-slate-600 dark:text-slate-300'
                          }`}>
                            {expiryDetails.text}
                          </span>
                        </div>

                        {/* Status Tag */}
                        {expired ? (
                          <span className="px-1.5 py-0.5 rounded bg-rose-100 dark:bg-rose-950/80 text-rose-700 dark:text-rose-300 text-[10px] font-bold">
                            Wygasł
                          </span>
                        ) : (
                          <span className="text-[10px] text-slate-400">
                            Od: {new Date(alert.createdAt).toLocaleDateString('pl-PL')}
                          </span>
                        )}
                      </div>

                      {/* Action Controls */}
                      <div className="flex items-center justify-between pt-1">
                        {expired ? (
                          <button
                            onClick={() => handleRenewAlert(alert)}
                            className="w-full inline-flex items-center justify-center gap-1.5 py-1 px-2.5 rounded-lg bg-blue-50 hover:bg-blue-100 dark:bg-blue-950/60 dark:hover:bg-blue-900/60 text-blue-700 dark:text-blue-300 font-semibold text-xs transition-colors cursor-pointer border border-blue-200 dark:border-blue-800"
                          >
                            <RefreshCw className="w-3 h-3" />
                            <span>Odnów ważność (+7 dni)</span>
                          </button>
                        ) : (
                          <>
                            <span className="text-[10px] text-slate-400">
                              {alert.isActive ? 'Monitorowanie aktywne' : 'Wstrzymany'}
                            </span>
                            <button
                              onClick={() => onToggleAlert(alert.id)}
                              className={`px-2.5 py-1 rounded-lg font-semibold text-[11px] cursor-pointer transition-colors ${
                                alert.isActive
                                  ? 'bg-blue-100 dark:bg-blue-900/60 text-blue-700 dark:text-blue-300 hover:bg-blue-200 dark:hover:bg-blue-800'
                                  : 'bg-slate-200 dark:bg-slate-700 text-slate-600 dark:text-slate-400 hover:bg-slate-300 dark:hover:bg-slate-600'
                              }`}
                            >
                              {alert.isActive ? 'Aktywny' : 'Wznów'}
                            </button>
                          </>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* ========================================================================= */}
      {/* SEKCJA 3: PANEL STOP-LOSS & TAKE-PROFIT Z INTEGRACJĄ API BROKERA */}
      {/* ========================================================================= */}
      <div className="mt-8 pt-6 border-t border-slate-200 dark:border-slate-800 space-y-4">
        {/* Lista rozwijana ma szerokosc swojej najdluzszej pozycji. Obok tytulu (od 640 px) dluga
            nazwa rachunku albo waloru wypychala pola poza ekran i sciskala tytul do jednego slowa
            w wierszu. Do 1024 px pola leza pod tytulem i dziela jego szerokosc, a wyzej maja stala. */}
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-3">
          <div className="min-w-0">
            <h2 className="text-base sm:text-lg font-bold text-slate-900 dark:text-white flex items-center gap-2">
              <ShieldCheck className="shrink-0 w-5 h-5 text-emerald-600" />
              <span>Progi Stop-Loss (SL) i Take-Profit (TP)</span>
            </h2>
            <span className="text-xs text-slate-500 dark:text-slate-400">
              Zlecenia ochronne wysyłane do brokera po Twoim potwierdzeniu. Progi liczone od aktualnego kursu.
            </span>
          </div>

          {/* Quick Selectors: Account & Instrument */}
          <div className="flex min-w-0 w-full lg:w-auto flex-wrap sm:flex-nowrap items-center gap-2 lg:flex-none">
            {/* Account Selector */}
            <div className="flex min-w-0 basis-full sm:basis-0 sm:flex-1 lg:flex-none items-center gap-1.5">
              <span className="shrink-0 text-xs text-slate-500 font-medium">Broker:</span>
              <select
                aria-label="Broker"
                value={selectedAccountId}
                disabled={accounts.length === 0}
                onChange={(e) => {
                  setSelectedAccountId(e.target.value);
                  // Ilosc z pozycji wybranego rachunku, a nie pierwszej po tickerze.
                  const pos = wybierzPozycjeRachunku(openPositions, selectedSlTpTicker, e.target.value);
                  if (pos) setOrderQuantity(pos.totalQuantity.toString());
                }}
                className="min-w-0 w-full lg:w-48 xl:w-56 px-2.5 py-1.5 text-xs font-semibold bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg text-slate-800 dark:text-slate-200 focus:outline-none focus:ring-1 focus:ring-blue-500 cursor-pointer disabled:cursor-not-allowed"
              >
                {accounts.length === 0 && <option value="">Brak podłączonych rachunków</option>}
                {accounts.map((acc) => (
                  <option key={acc.id} value={acc.id}>
                    {acc.name} ({acc.brokerType}) {acc.isApiConnected ? '🟢 API' : '⚪ CSV'}
                  </option>
                ))}
              </select>
            </div>

            {/* Instrument Selector */}
            <div className="flex min-w-0 basis-full sm:basis-0 sm:flex-1 lg:flex-none items-center gap-1.5">
              <span className="shrink-0 text-xs text-slate-500 font-medium">Walor:</span>
              <select
                aria-label="Walor"
                value={selectedSlTpTicker}
                onChange={(e) => {
                  setSelectedSlTpTicker(e.target.value);
                  setCustomSlPrice('');
                  setCustomTpPrice('');
                  const pos = wybierzPozycjeRachunku(openPositions, e.target.value, selectedAccountId);
                  if (pos) setOrderQuantity(pos.totalQuantity.toString());
                }}
                className="min-w-0 w-full lg:w-56 xl:w-64 px-2.5 py-1.5 text-xs font-semibold bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg text-slate-800 dark:text-slate-200 focus:outline-none focus:ring-1 focus:ring-blue-500 cursor-pointer"
              >
                {openPositions.length > 0 && (
                  <optgroup label="Otwarte pozycje w portfelu">
                    {/* Jedna opcja na ticker; ilosc z pozycji wybranego rachunku. */}
                    {openPositions
                      .filter((pos, i) => openPositions.findIndex((p) => p.ticker === pos.ticker) === i)
                      .map((unikalna) => {
                        const pos = wybierzPozycjeRachunku(openPositions, unikalna.ticker, selectedAccountId);
                        return (
                          <option key={unikalna.ticker} value={unikalna.ticker}>
                            {unikalna.ticker} - {unikalna.name} ({pos ? `${pos.totalQuantity} szt.` : 'brak na tym rachunku'})
                          </option>
                        );
                      })}
                  </optgroup>
                )}
                <optgroup label="Wszystkie instrumenty giełdowe">
                  {quoteList.map((q) => (
                    <option key={q.ticker} value={q.ticker}>
                      {q.ticker} - {q.name} ({formatLiczba(q.price)} {q.currency})
                    </option>
                  ))}
                </optgroup>
              </select>
            </div>
          </div>
        </div>

        {/* Success Banner if alerts/orders created */}
        {slTpSuccessMessage && (
          <div className="p-3 rounded-xl bg-emerald-50 dark:bg-emerald-950/60 border border-emerald-200 dark:border-emerald-800 text-emerald-800 dark:text-emerald-200 text-xs font-medium flex items-center gap-2 animate-in fade-in">
            <Check className="w-4 h-4 text-emerald-600 shrink-0" />
            <span>{slTpSuccessMessage}</span>
          </div>
        )}

        {pendingBinanceReview && activeAccount?.brokerType === 'BINANCE' && (
          <div role="alert" className="p-3 rounded-xl bg-amber-50 dark:bg-amber-950/50 border border-amber-300 dark:border-amber-800 text-amber-900 dark:text-amber-100 text-xs space-y-2">
            <div>
              Nierozstrzygnięte zlecenie Binance dla {pendingBinanceReview.ticker}, ilość {pendingBinanceReview.parameters.quantity},
              {' '}zapisane {new Date(pendingBinanceReview.createdAt).toLocaleString()}. Sprawdź zlecenia w Binance przed kolejną próbą.
            </div>
            <button
              type="button"
              onClick={() => void ponowSprawdzenieZleceniaBinance()}
              disabled={isSubmittingOrder}
              className="px-3 py-1.5 rounded-lg bg-amber-700 hover:bg-amber-800 text-white font-semibold disabled:opacity-50 cursor-pointer"
            >
              {isSubmittingOrder ? 'Sprawdzanie…' : 'Sprawdź zlecenie w Binance'}
            </button>
          </div>
        )}

        {activeAccount?.brokerType === 'FREEDOM24' && (
          <div data-testid="zlecenia-brokera" className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-3">
            <div className="flex items-center justify-between gap-2">
              <span className="font-bold text-xs text-slate-800 dark:text-slate-200">
                Aktywne zlecenia na rachunku Freedom24{zleceniaBrokera ? ` (${zleceniaBrokera.length})` : ''}
              </span>
              <button type="button" onClick={() => void odswiezZlecenia()} disabled={ladowanieZlecen} className="text-[11px] font-semibold text-blue-600 dark:text-blue-400 disabled:opacity-50 cursor-pointer">
                {ladowanieZlecen ? 'Odczyt…' : 'Odśwież'}
              </button>
            </div>
            {bladZlecen ? (
              <p className="mt-2 text-[11px] text-amber-700 dark:text-amber-300">{bladZlecen}</p>
            ) : zleceniaBrokera === null ? (
              <p className="mt-2 text-[11px] text-slate-500">Odczyt zleceń z brokera…</p>
            ) : zleceniaBrokera.length === 0 ? (
              <p className="mt-2 text-[11px] text-slate-500">Broker nie pokazuje żadnych aktywnych zleceń.</p>
            ) : (
              <div className="mt-2 overflow-x-auto">
                <table className="w-full text-[11px]">
                  <thead className="text-slate-500">
                    <tr className="text-left">
                      <th className="py-1 pr-3 font-medium">Walor</th>
                      <th className="py-1 pr-3 font-medium">Rodzaj</th>
                      <th className="py-1 pr-3 font-medium">Strona</th>
                      <th className="py-1 pr-3 font-medium text-right">Ilość</th>
                      <th className="py-1 pr-3 font-medium text-right">Próg</th>
                      <th className="py-1 pr-3 font-medium text-right">Cena zlecenia</th>
                      <th className="py-1 pr-3 font-medium">Ważność</th>
                      <th className="py-1 font-medium text-right">Nr</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody className="font-mono text-slate-800 dark:text-slate-200">
                    {zleceniaBrokera.map((z) => (
                      <tr key={z.orderId} className="border-t border-slate-100 dark:border-slate-800">
                        <td className="py-1.5 pr-3 font-bold">{z.ticker}</td>
                        <td className="py-1.5 pr-3">{z.rodzaj === 'STOP_LOSS' ? 'Stop-Loss' : z.rodzaj === 'TAKE_PROFIT' ? 'Take-Profit' : 'inne'}</td>
                        <td className="py-1.5 pr-3">{z.strona === 'KUPNO' ? 'kupno' : 'sprzedaż'}</td>
                        <td className="py-1.5 pr-3 text-right">{z.ilosc ?? '—'}</td>
                        <td className="py-1.5 pr-3 text-right">{z.cenaProgu !== null ? `${z.cenaProgu} ${z.waluta ?? ''}` : '—'}</td>
                        <td className="py-1.5 pr-3 text-right">{z.cenaZlecenia !== null ? `${z.cenaZlecenia} ${z.waluta ?? ''}` : '—'}</td>
                        <td className="py-1.5 pr-3">{z.waznosc === 'DO_ANULOWANIA' ? 'do anulowania' : z.waznosc === 'DZIEN' ? 'dzień' : z.waznosc === 'DZIEN_I_NOC' ? 'dzień + noc' : '—'}</td>
                        <td className="py-1.5 text-right text-slate-500">{z.orderId}</td>
                        <td className="py-1.5 pl-3 text-right">
                          <button type="button" onClick={() => void anulujZlecenieBrokera(z)} className="rounded-md border border-rose-300 px-2 py-0.5 font-sans font-semibold text-rose-700 hover:bg-rose-50 dark:border-rose-800 dark:text-rose-300 dark:hover:bg-rose-950/40 cursor-pointer">
                            Anuluj
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        {/* ========================================================================= */}
        {/* INTERAKTYWNA LISTA POZYCJI Z PORTFELA DO BEZPOŚREDNIEGO UZBROJENIA SL/TP */}
        {/* ========================================================================= */}
        {openPositions.length > 0 && (
          <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-900/50 overflow-hidden space-y-2 p-3 sm:p-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className="p-1 rounded-md bg-blue-100 dark:bg-blue-950 text-blue-600 dark:text-blue-400">
                  <Layers className="w-3.5 h-3.5" />
                </span>
                <span className="font-bold text-xs text-slate-800 dark:text-slate-200">
                  Aktywne Pozycje w Twoim Portfelu ({openPositions.length}) — Wybierz walor do uzbrojenia ochrony
                </span>
              </div>
              <span className="text-[11px] font-mono text-slate-400">
                Kliknij wiersz, aby załadować parametry do kalkulatora
              </span>
            </div>

            <div className="overflow-x-auto rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900">
              <table className="w-full text-left text-xs font-sans">
                <thead className="bg-slate-100 dark:bg-slate-800/80 text-slate-600 dark:text-slate-300 font-semibold border-b border-slate-200 dark:border-slate-800">
                  <tr>
                    <th className="py-2 px-3">Walor (Ticker)</th>
                    <th className="py-2 px-3">Rachunek Maklerski</th>
                    <th className="py-2 px-3 text-right">Ilość w Portfelu</th>
                    <th className="py-2 px-3 text-right">Śr. Cena Zakupu</th>
                    <th className="py-2 px-3 text-right">Kurs Live</th>
                    <th className="py-2 px-3 text-right">Zysk / Strata (P&L)</th>
                    <th className="py-2 px-3 text-center">Status Ochrony SL/TP</th>
                    <th className="py-2 px-3 text-center">Akcja</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                  {wycenionePozycje.map((pos, wierszNr) => {
                    // Silnik tworzy osobna pozycje dla pary ticker-rachunek - zaznaczony jest jeden wiersz.
                    const isSelected = openPositions[wierszNr] === activePosition;
                    const quote = pos.quote;
                    // Brak notowania to brak notowania. Podstawienie ceny zakupu
                    // pokazywalo ja jako "Kurs Live" ze zmiana +0,00% - wygladalo
                    // to na papier, ktorego kurs stoi w miejscu, a nie na papier
                    // bez danych.
                    const maNotowanie = pos.maNotowanie;
                    const livePrice = pos.currentPriceOrig;
                    // Notowanie bez zmiany dziennej to "nie wiem", nie zielone +0.00%.
                    const change24h =
                      typeof quote?.changePercent24h === 'number' && Number.isFinite(quote.changePercent24h)
                        ? quote.changePercent24h
                        : null;
                    // Wynik tylko z prawdziwej wyceny (notowanie w swojej walucie + kurs NBP tej waluty).
                    // Bez notowania nie ma wyniku: cena zakupu dawala fikcyjny zysk z samego przelicznika.
                    const pnlPLN = pos.maWycene ? pos.unrealizedPLN : null;
                    const isProfit = (pnlPLN ?? 0) >= 0;

                    // Check if order already armed for this ticker
                    const activeOrder = brokerOrders.find(
                      (o) => o.ticker.toUpperCase() === pos.ticker.toUpperCase() && o.status === 'ARMED'
                    );
                    const hasAlert = alerts.some((a) => a.ticker.toUpperCase() === pos.ticker.toUpperCase() && a.isActive);

                    // Determine primary account for this position
                    const primaryAccId = pos.lots && pos.lots.length > 0 ? pos.lots[0].accountId : pos.accountIds[0];
                    const acc = accounts.find((a) => a.id === primaryAccId) || accounts[0];

                    return (
                      <tr
                        key={`${pos.ticker}|${primaryAccId ?? ''}|${wierszNr}`}
                        aria-selected={isSelected}
                        {...klikalny(() => {
                          setSelectedSlTpTicker(pos.ticker);
                          if (primaryAccId) setSelectedAccountId(primaryAccId);
                          setOrderQuantity(pos.totalQuantity.toString());
                          setCustomSlPrice('');
                          setCustomTpPrice('');
                        }, { wiersz: true })}
                        className={`transition-all duration-150 cursor-pointer ${
                          isSelected
                            ? 'bg-blue-50/90 dark:bg-blue-950/60 font-medium'
                            : 'hover:bg-slate-50 dark:hover:bg-slate-800/50'
                        }`}
                      >
                        <td className="py-2.5 px-3">
                          <div className="flex items-center gap-2">
                            <span className="font-bold font-mono text-slate-900 dark:text-white">
                              {pos.ticker}
                            </span>
                            <span className="text-[10px] text-slate-500 truncate max-w-[120px]">
                              {pos.name}
                            </span>
                          </div>
                        </td>

                        <td className="py-2.5 px-3">
                          <div className="flex items-center gap-1.5">
                            {acc && (
                              <span
                                className="w-2 h-2 rounded-full shrink-0"
                                style={{ backgroundColor: acc.color || '#3B82F6' }}
                              />
                            )}
                            <span className="font-semibold text-slate-800 dark:text-slate-200 truncate max-w-[130px]">
                              {acc ? acc.name : 'Główny'}
                            </span>
                            <span className="text-[10px] font-mono opacity-70">
                              ({acc?.brokerType || 'CUSTOM'})
                            </span>
                          </div>
                        </td>

                        <td className="py-2.5 px-3 text-right font-mono font-semibold text-slate-800 dark:text-slate-200">
                          {pos.totalQuantity.toLocaleString('pl-PL', { maximumFractionDigits: 6 })} szt.
                        </td>

                        <td className="py-2.5 px-3 text-right font-mono text-slate-600 dark:text-slate-400">
                          {formatLiczba(pos.avgBuyPrice)} {pos.currency}
                        </td>

                        <td className="py-2.5 px-3 text-right font-mono">
                          {maNotowanie ? (
                            <>
                              <div className="font-semibold text-slate-900 dark:text-white">
                                {formatLiczba(livePrice)} {quote?.currency ?? ''}
                              </div>
                              {change24h !== null ? (
                                <span
                                  className={`text-[10px] font-semibold ${
                                    change24h >= 0 ? 'text-emerald-500' : 'text-rose-500'
                                  }`}
                                >
                                  {change24h >= 0 ? '+' : ''}{formatLiczba(change24h)}%
                                </span>
                              ) : (
                                <span className="text-[10px] font-semibold text-slate-400">zmiana: —</span>
                              )}
                            </>
                          ) : (
                            <>
                              <div className="font-semibold text-slate-400">—</div>
                              <span className="text-[10px] font-semibold text-slate-400">brak notowania</span>
                            </>
                          )}
                        </td>

                        <td className="py-2.5 px-3 text-right font-mono">
                          <span
                            className={`font-semibold ${
                              !maNotowanie
                                ? 'text-slate-400'
                                : isProfit
                                ? 'text-emerald-600 dark:text-emerald-400'
                                : 'text-rose-600 dark:text-rose-400'
                            }`}
                            title={
                              pnlPLN !== null
                                ? undefined
                                : maNotowanie
                                  ? 'Brak kursu NBP dla waluty notowania — nie można przeliczyć wyniku.'
                                  : 'Brak notowania — nie ma z czego policzyć wyniku.'
                            }
                          >
                            {pnlPLN === null ? '— PLN' : `${isProfit ? '+' : ''}${formatLiczba(pnlPLN)} PLN`}
                          </span>
                        </td>

                        <td className="py-2.5 px-3 text-center">
                          {activeOrder ? (
                            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-bold bg-emerald-100 dark:bg-emerald-950 text-emerald-800 dark:text-emerald-300 border border-emerald-300 dark:border-emerald-800">
                              <ShieldCheck className="w-3 h-3 text-emerald-600" />
                              <span>API: SL {activeOrder.stopPrice == null ? '—' : formatLiczba(activeOrder.stopPrice)}</span>
                            </span>
                          ) : hasAlert ? (
                            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-bold bg-blue-100 dark:bg-blue-950 text-blue-800 dark:text-blue-300">
                              <Bell className="w-3 h-3 text-blue-600" />
                              <span>Alert Cenowy</span>
                            </span>
                          ) : (
                            <span className="text-[10px] text-slate-400">
                              Brak ochrony
                            </span>
                          )}
                        </td>

                        <td className="py-2.5 px-3 text-center">
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              setSelectedSlTpTicker(pos.ticker);
                              if (primaryAccId) setSelectedAccountId(primaryAccId);
                              setOrderQuantity(pos.totalQuantity.toString());
                              setCustomSlPrice('');
                              setCustomTpPrice('');
                            }}
                            className={`px-2.5 py-1 rounded-lg text-xs font-semibold transition-all cursor-pointer ${
                              isSelected
                                ? 'bg-blue-600 text-white shadow-2xs'
                                : 'bg-slate-100 dark:bg-slate-800 text-blue-600 dark:text-blue-400 hover:bg-blue-100 dark:hover:bg-blue-900/60'
                            }`}
                          >
                            {isSelected ? 'Wybrany' : 'Konfiguruj SL/TP'}
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* SL / TP Interactive Control Panel */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          {/* Column 1: Stop-Loss (SL) Setup */}
          <div className="p-4 rounded-xl bg-rose-50/50 dark:bg-rose-950/20 border border-rose-200 dark:border-rose-900/60 space-y-3.5">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-1.5 text-rose-700 dark:text-rose-300 font-bold text-sm">
                <ShieldAlert className="w-4 h-4" />
                <span>Poziom Stop-Loss (SL)</span>
              </div>
              <span className="text-[11px] font-mono text-rose-700 dark:text-rose-400 font-semibold">
                Ochrona Kapitału
              </span>
            </div>

            <div className="space-y-2">
              <div className="flex items-center justify-between text-xs">
                <span className="text-slate-600 dark:text-slate-400">Próg spadku:</span>
                <div className="flex items-center gap-1">
                  {[3, 5, 8, 10, 15].map((pct) => (
                    <button
                      key={pct}
                      type="button"
                      onClick={() => {
                        setSlPercent(pct);
                        setCustomSlPrice('');
                      }}
                      className={`px-2 py-0.5 rounded text-[11px] font-mono font-semibold cursor-pointer transition-all ${
                        slPercent === pct && !customSlPrice
                          ? 'bg-rose-700 text-white shadow-xs'
                          : 'bg-white dark:bg-slate-800 text-slate-700 dark:text-slate-300 border border-slate-200 dark:border-slate-700 hover:bg-rose-100 dark:hover:bg-rose-900/40'
                      }`}
                    >
                      -{pct}%
                    </button>
                  ))}
                </div>
              </div>

              {/* Custom SL Price input */}
              <div className="pt-1">
                <label className="block text-[11px] font-medium text-slate-600 dark:text-slate-400 mb-1">
                  Własny kurs Stop-Loss ({walutaSlTp ?? '?'}):
                </label>
                <input
                  type="number"
                  step="0.01"
                  placeholder={currentPrice === null ? 'Wpisz kurs' : `Np. ${(currentPrice * 0.95).toFixed(2)}`}
                  value={customSlPrice}
                  onChange={(e) => setCustomSlPrice(e.target.value)}
                  className="w-full px-2.5 py-1.5 rounded-lg bg-white dark:bg-slate-900 border border-rose-200 dark:border-rose-800 text-xs font-mono font-bold text-rose-700 dark:text-rose-300 focus:outline-none focus:ring-1 focus:ring-rose-500"
                />
              </div>

              {/* SL Result Card */}
              <div className="p-2.5 rounded-lg bg-white/80 dark:bg-slate-900/80 border border-rose-200/80 dark:border-rose-900/40 text-xs space-y-1">
                <div className="flex items-center justify-between">
                  <span className="text-slate-500">Cena wyzwalająca SL:</span>
                  <span className="font-mono font-bold text-rose-600 dark:text-rose-400 text-sm">
                    {kwotaLubBrak(calculatedSlPrice)} {walutaSlTp ?? ''}
                  </span>
                </div>
                <div className="flex items-center justify-between text-[11px] text-slate-500">
                  <span>Odległość od aktualnego kursu:</span>
                  <span className="font-mono text-rose-600 font-semibold">
                    {distanceToSlPct === null ? '—' : `${formatLiczba(-distanceToSlPct)}%`}
                  </span>
                </div>
                {activePosition && (
                  <div className="flex items-center justify-between text-[11px] text-slate-500 pt-0.5 border-t border-slate-100 dark:border-slate-800">
                    <span>Maksymalna strata pozycji:</span>
                    <span className="font-mono font-semibold text-rose-600">
                      {currentPrice === null || calculatedSlPrice === null
                        ? '—'
                        : `${formatLiczba(-(currentPrice - calculatedSlPrice) * activePosition.totalQuantity)} ${walutaSlTp ?? ''}`}
                    </span>
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Column 2: Take-Profit (TP) Setup */}
          <div className="p-4 rounded-xl bg-emerald-50/50 dark:bg-emerald-950/20 border border-emerald-200 dark:border-emerald-900/60 space-y-3.5">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-1.5 text-emerald-700 dark:text-emerald-300 font-bold text-sm">
                <Target className="w-4 h-4" />
                <span>Poziom Take-Profit (TP)</span>
              </div>
              <span className="text-[11px] font-mono text-emerald-700 dark:text-emerald-400 font-semibold">
                Realizacja Zysku
              </span>
            </div>

            <div className="space-y-2">
              <div className="flex items-center justify-between text-xs">
                <span className="text-slate-600 dark:text-slate-400">Próg zysku:</span>
                <div className="flex items-center gap-1">
                  {[10, 15, 25, 50, 100].map((pct) => (
                    <button
                      key={pct}
                      type="button"
                      onClick={() => {
                        setTpPercent(pct);
                        setCustomTpPrice('');
                      }}
                      className={`px-2 py-0.5 rounded text-[11px] font-mono font-semibold cursor-pointer transition-all ${
                        tpPercent === pct && !customTpPrice
                          ? 'bg-emerald-700 text-white shadow-xs'
                          : 'bg-white dark:bg-slate-800 text-slate-700 dark:text-slate-300 border border-slate-200 dark:border-slate-700 hover:bg-emerald-100 dark:hover:bg-emerald-900/40'
                      }`}
                    >
                      +{pct}%
                    </button>
                  ))}
                </div>
              </div>

              {/* Custom TP Price input */}
              <div className="pt-1">
                <label className="block text-[11px] font-medium text-slate-600 dark:text-slate-400 mb-1">
                  Własny kurs Take-Profit ({walutaSlTp ?? '?'}):
                </label>
                <input
                  type="number"
                  step="0.01"
                  placeholder={currentPrice === null ? 'Wpisz kurs' : `Np. ${(currentPrice * 1.15).toFixed(2)}`}
                  value={customTpPrice}
                  onChange={(e) => setCustomTpPrice(e.target.value)}
                  className="w-full px-2.5 py-1.5 rounded-lg bg-white dark:bg-slate-900 border border-emerald-200 dark:border-emerald-800 text-xs font-mono font-bold text-emerald-700 dark:text-emerald-300 focus:outline-none focus:ring-1 focus:ring-emerald-500"
                />
              </div>

              {/* TP Result Card */}
              <div className="p-2.5 rounded-lg bg-white/80 dark:bg-slate-900/80 border border-emerald-200/80 dark:border-emerald-900/40 text-xs space-y-1">
                <div className="flex items-center justify-between">
                  <span className="text-slate-500">Cena wyzwalająca TP:</span>
                  <span className="font-mono font-bold text-emerald-600 dark:text-emerald-400 text-sm">
                    {kwotaLubBrak(calculatedTpPrice)} {walutaSlTp ?? ''}
                  </span>
                </div>
                <div className="flex items-center justify-between text-[11px] text-slate-500">
                  <span>Odległość od aktualnego kursu:</span>
                  <span className="font-mono text-emerald-600 font-semibold">
                    {distanceToTpPct === null ? '—' : `${distanceToTpPct >= 0 ? '+' : ''}${formatLiczba(distanceToTpPct)}%`}
                  </span>
                </div>
                {activePosition && (
                  <div className="flex items-center justify-between text-[11px] text-slate-500 pt-0.5 border-t border-slate-100 dark:border-slate-800">
                    <span>Docelowy zysk pozycji:</span>
                    <span className="font-mono font-semibold text-emerald-600">
                      {currentPrice === null || calculatedTpPrice === null
                        ? '—'
                        : `+${formatLiczba((calculatedTpPrice - currentPrice) * activePosition.totalQuantity)} ${walutaSlTp ?? ''}`}
                    </span>
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Column 3: Execution Settings, Quantity & 1-Click Launch */}
          <div className="p-4 rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 space-y-3.5 flex flex-col justify-between">
            <div>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-1.5 font-bold text-slate-800 dark:text-slate-200 text-sm">
                  <Scale className="w-4 h-4 text-blue-600" />
                  <span>Wskaźnik Risk / Reward (RRR)</span>
                </div>
                <span className={`px-2 py-0.5 rounded text-[11px] font-mono font-bold ${
                  rrrRatio !== null && rrrRatio >= 2
                    ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300'
                    : rrrRatio !== null && rrrRatio >= 1
                    ? 'bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300'
                    : 'bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300'
                }`}>
                  1 : {rrrRatio === null ? '—' : formatLiczba(rrrRatio)}
                </span>
              </div>

              {/* Visual Gauge Channel */}
              <div className="mt-2.5 space-y-1">
                <div className="flex justify-between text-[10px] font-mono text-slate-500">
                  <span className="text-rose-700 dark:text-rose-400 font-semibold">SL: {kwotaLubBrak(calculatedSlPrice)}</span>
                  <span className="text-slate-800 dark:text-slate-200 font-bold">Akt: {kwotaLubBrak(currentPrice)}</span>
                  <span className="text-emerald-700 dark:text-emerald-400 font-semibold">TP: {kwotaLubBrak(calculatedTpPrice)}</span>
                </div>

                <div className="h-2.5 w-full rounded-full bg-slate-100 dark:bg-slate-800 flex overflow-hidden p-0.5 border border-slate-200 dark:border-slate-700">
                  <div
                    style={{ width: `${udzialRyzyka}%` }}
                    className="bg-rose-500 rounded-l-full h-full"
                  />
                  <div
                    style={{ width: `${100 - udzialRyzyka}%` }}
                    className="bg-emerald-500 rounded-r-full h-full"
                  />
                </div>
              </div>

              {/* Quantity & Expiry Controls */}
              <div className="mt-3 grid grid-cols-2 gap-2 text-xs">
                <div>
                  <label className="block text-[11px] text-slate-500 mb-1 font-medium">
                    Wolumen (sztuk):
                  </label>
                  <div className="flex items-center gap-1">
                    <input
                      aria-label="Wolumen (sztuk)"
                      type="number"
                      min="0.001"
                      step="any"
                      value={orderQuantity}
                      onChange={(e) => setOrderQuantity(e.target.value)}
                      className="w-full px-2 py-1 rounded bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-xs font-mono font-bold text-slate-800 dark:text-slate-200 focus:outline-none"
                    />
                    {activePosition && (
                      <button
                        type="button"
                        onClick={() => setOrderQuantity(activePosition.totalQuantity.toString())}
                        className="px-1.5 py-1 text-[10px] font-semibold bg-slate-200 dark:bg-slate-700 rounded text-slate-700 dark:text-slate-300 hover:bg-slate-300 cursor-pointer"
                        title="Ustaw pełną pozycję z portfela"
                      >
                        MAX
                      </button>
                    )}
                  </div>
                </div>

                <div>
                  <label className="block text-[11px] text-slate-500 mb-1 font-medium">
                    Ważność zlecenia:
                  </label>
                  <select aria-label="Ważność zlecenia"
                    value={slTpExpiry}
                    onChange={(e) => setSlTpExpiry(e.target.value as ExpiryOption)}
                    className="w-full px-2 py-1 text-[11px] rounded bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-300 cursor-pointer"
                  >
                    <option value="7d">7 dni</option>
                    <option value="14d">14 dni</option>
                    <option value="30d">30 dni (GTC)</option>
                    <option value="90d">90 dni</option>
                    <option value="never">Bezterminowo</option>
                  </select>
                </div>
              </div>

            </div>

            {/* Launch Button */}
            <div className="pt-2">
                            {bladProgow && (
                <div className="rounded-lg border border-rose-300 bg-rose-50 px-3 py-2 text-[11px] font-semibold text-rose-800 dark:border-rose-800 dark:bg-rose-950/40 dark:text-rose-200">
                  {bladProgow}
                </div>
              )}
<button
                type="button"
                onClick={handleExecuteProtection}
                disabled={isSubmittingOrder || !brokerPrzyjmujeZlecenia || bladProgow !== null || calculatedSlPrice === null || calculatedTpPrice === null}
                className="w-full py-2 px-3 rounded-lg bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-500 hover:to-indigo-500 text-white text-xs font-bold shadow-xs flex items-center justify-center gap-2 cursor-pointer transition-all active:scale-[0.98] disabled:opacity-50"
              >
                {isSubmittingOrder ? (
                  <>
                    <RefreshCw className="w-4 h-4 animate-spin" />
                    <span>Wysyłanie do brokera…</span>
                  </>
                ) : trybRealizacji === 'BROKER_API' ? (
                  <>
                    <Zap className="w-4 h-4 text-amber-300" />
                    <span>Wyślij zlecenie SL / TP do brokera ({activeAccount?.name ?? '—'})</span>
                  </>
                ) : (
                  <>
                    <Bell className="w-4 h-4 text-white" />
                    <span>Aktywuj Alerty SL / TP w Aplikacji</span>
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Add / Edit Alert Modal */}
      {showAddForm && (
        <div ref={refOknaAlertu} tabIndex={-1} role="dialog" aria-modal="true" aria-label="Alert cenowy" className="outline-none fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-xs">
          <div className="w-full max-w-md max-h-[90vh] overflow-y-auto bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 shadow-2xl p-6 space-y-4 animate-in fade-in zoom-in-95 duration-150">
            <div className="flex items-center justify-between">
              <h2 className="text-base font-bold text-slate-900 dark:text-white flex items-center gap-2">
                {editingAlert ? (
                  <>
                    <Edit3 className="w-4 h-4 text-blue-600" />
                    <span>Edytuj Alert Cenowy ({editingAlert.ticker})</span>
                  </>
                ) : (
                  <>
                    <Bell className="w-4 h-4 text-blue-600" />
                    <span>Nowy Alert Cenowy</span>
                  </>
                )}
              </h2>
              <button
                onClick={() => {
                  setShowAddForm(false);
                  setEditingAlert(null);
                }}
                className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 text-lg leading-none cursor-pointer"
              >
                ✕
              </button>
            </div>

            <form onSubmit={handleSubmit} className="space-y-3.5 text-xs">
              <div>
                <label className="block text-slate-700 dark:text-slate-300 font-medium mb-1">
                  Wybierz Spółkę / Ticker
                </label>
                <select aria-label="Wybierz Spółkę / Ticker"
                  value={ticker}
                  onChange={(e) => handleTickerChange(e.target.value)}
                  className="w-full px-3 py-2 rounded-xl bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-900 dark:text-white focus:outline-none"
                >
                  {quoteList.map((q) => (
                    <option key={q.ticker} value={q.ticker}>
                      {q.ticker} - {q.name} (Aktualnie: {formatLiczba(q.price)} {q.currency})
                    </option>
                  ))}
                </select>
              </div>

              {/* Typ Alertu */}
              <div>
                <label className="block text-slate-700 dark:text-slate-300 font-medium mb-1">
                  Kategoria Alertu
                </label>
                <div className="grid grid-cols-3 gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      setAlertType('PRICE');
                      setCondition('ABOVE');
                    }}
                    className={`py-1.5 px-2 rounded-lg text-[11px] font-semibold border transition-all cursor-pointer ${
                      alertType === 'PRICE'
                        ? 'bg-blue-50 dark:bg-blue-950/60 border-blue-500 text-blue-600 dark:text-blue-400'
                        : 'bg-slate-50 dark:bg-slate-800 border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-400'
                    }`}
                  >
                    Zwykły
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setAlertType('STOP_LOSS');
                      setCondition('BELOW');
                    }}
                    className={`py-1.5 px-2 rounded-lg text-[11px] font-semibold border transition-all cursor-pointer ${
                      alertType === 'STOP_LOSS'
                        ? 'bg-rose-50 dark:bg-rose-950/60 border-rose-500 text-rose-600 dark:text-rose-400'
                        : 'bg-slate-50 dark:bg-slate-800 border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-400'
                    }`}
                  >
                    Stop-Loss
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setAlertType('TAKE_PROFIT');
                      setCondition('ABOVE');
                    }}
                    className={`py-1.5 px-2 rounded-lg text-[11px] font-semibold border transition-all cursor-pointer ${
                      alertType === 'TAKE_PROFIT'
                        ? 'bg-emerald-50 dark:bg-emerald-950/60 border-emerald-500 text-emerald-600 dark:text-emerald-400'
                        : 'bg-slate-50 dark:bg-slate-800 border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-400'
                    }`}
                  >
                    Take-Profit
                  </button>
                </div>
              </div>

              <div>
                <label className="block text-slate-700 dark:text-slate-300 font-medium mb-1">
                  Warunek Wyzwolenia
                </label>
                <select aria-label="Warunek Wyzwolenia"
                  value={condition}
                  onChange={(e) => setCondition(e.target.value as PriceAlert['condition'])}
                  className="w-full px-3 py-2 rounded-xl bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-900 dark:text-white focus:outline-none"
                >
                  <option value="ABOVE">Cena wzrośnie powyżej poziomu (Kurs &gt;= Docelowy)</option>
                  <option value="BELOW">Cena spadnie poniżej poziomu (Kurs &lt;= Docelowy)</option>
                  <option value="PERCENT_CHANGE_UP">Wzrost zmiany 24h o co najmniej +X%</option>
                  <option value="PERCENT_CHANGE_DOWN">Spadek zmiany 24h o co najmniej -X%</option>
                </select>
              </div>

              {condition.includes('PERCENT') ? (
                <div>
                  <label className="block text-slate-700 dark:text-slate-300 font-medium mb-1">
                    Próg zmiany 24h (%)
                  </label>
                  <input aria-label="Próg zmiany 24h (%)"
                    type="number"
                    step="0.1"
                    required
                    value={percentageThreshold}
                    onChange={(e) => setPercentageThreshold(e.target.value)}
                    className="w-full px-3 py-2 rounded-xl bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-900 dark:text-white focus:outline-none"
                  />
                </div>
              ) : (
                <div>
                  <label className="block text-slate-700 dark:text-slate-300 font-medium mb-1">
                    Cena Docelowa ({quotes[ticker]?.currency || 'USD'})
                  </label>
                  <input
                    aria-label={`Cena docelowa (${quotes[ticker]?.currency || 'USD'})`}
                    type="number"
                    step="0.01"
                    required
                    value={targetPrice}
                    onChange={(e) => setTargetPrice(e.target.value)}
                    className="w-full px-3 py-2 rounded-xl bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-900 dark:text-white focus:outline-none"
                  />
                </div>
              )}

              {/* Okres Ważności */}
              <div>
                <label className="block text-slate-700 dark:text-slate-300 font-medium mb-1">
                  Ważność Alertu (Czas Wygaśnięcia)
                </label>
                <select aria-label="Ważność Alertu (Czas Wygaśnięcia)"
                  value={expiryOption}
                  onChange={(e) => setExpiryOption(e.target.value as ExpiryOption)}
                  className="w-full px-3 py-2 rounded-xl bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-900 dark:text-white focus:outline-none cursor-pointer"
                >
                  <option value="1d">1 dzień (24h)</option>
                  <option value="3d">3 dni</option>
                  <option value="7d">7 dni (1 tydzień)</option>
                  <option value="14d">14 dni (2 tygodnie)</option>
                  <option value="30d">30 dni (1 miesiąc)</option>
                  <option value="90d">90 dni (3 miesiące)</option>
                  <option value="never">Bezterminowo</option>
                </select>
              </div>

              <div className="flex items-center justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => {
                    setShowAddForm(false);
                    setEditingAlert(null);
                  }}
                  className="px-4 py-2 rounded-xl text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 font-semibold cursor-pointer"
                >
                  Anuluj
                </button>
                <button
                  type="submit"
                  className="px-4 py-2 rounded-xl bg-blue-600 hover:bg-blue-700 text-white font-semibold shadow-xs cursor-pointer"
                >
                  {editingAlert ? 'Zapisz Zmiany' : 'Aktywuj Alert'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
