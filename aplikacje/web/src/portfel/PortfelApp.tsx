import React, { useState, useEffect, useMemo, useCallback, useRef, Suspense } from 'react';
import { leniwyZPonowieniem } from '../shared/leniwyZPonowieniem';
import { formatLiczba } from './services/nbpService';
import { ErrorBoundary } from '../invest_analyzer/components/ErrorBoundary';
import { czyOdmowaHostingu } from '../shared/kodyHostingu';
import { czyTrybHostowany } from '../shared/trybHostingu';
import { OczekiwanieNaOkno } from '../shared/OczekiwanieNaOkno';
import { taxResultFreshness } from '../invest_analyzer/services/taxResultFreshness';
import { przygotujZadanieSilnika } from '../invest_analyzer/services/taxEngineRequestFactory';
import { odczytajUstawienia } from './services/optymalizacjaPodatkowa';
import { oczyscZlecenia } from './services/zleceniaBrokera';
import { oczyscRachunki } from './services/rachunkiBrokera';
import { oczyscTransakcje } from './services/transakcjePortfela';
import {
  BrokerAccount,
  Transaction,
  PriceAlert,
  TwoFactorState,
  Language,
  LiveMarketQuote,
  BrokerOrder,
  BrokerOrderPayload,
  CurrencyCode,
  OpenPosition,
} from './types';
import {
  INITIAL_ACCOUNTS,
  INITIAL_TRANSACTIONS,
  INITIAL_ALERTS,
  INITIAL_2FA,
  INITIAL_BROKER_ORDERS,
} from './services/sampleData';
import type { TaxCalculationResult } from './types';
import { marketDataService } from './services/marketDataService';
import { odmienLiczebnik } from './services/odmianaLiczebnika';
import { czyUtworzycRachunekDlaTransakcji, dzisiajLokalnie, podpowiedzZamknieciaPozycji } from './services/formularzTransakcji';
import { trescPotwierdzeniaUsunieciaRachunku } from './services/usuwanieRachunku';
import { pushNotificationService, AppNotification } from './services/pushNotificationService';
import { togglePriceAlert, updatePriceAlert } from './services/priceAlertLogic';
import { brokerApiService } from './services/brokerApiService';
import { BottomNavbar } from './components/BottomNavbar';
import { SessionLockScreen } from './components/SessionLockScreen';
import { MarketStatusBar } from './components/MarketStatusBar';
import { verifySessionUnlock } from './services/totp';
import { subskrybujWynikSilnika, uniewaznijWynikiSilnika } from '../invest_analyzer/services/ostatniWynikSilnika';
import { czyKopiaZApiFreedom24, podzielTransakcjeLokalne } from './services/reczneTransakcje';
import { zestawPozycjeZBrokerem, type PozycjaBrokera } from './services/pozycjeBrokera';
import { mergeBinanceSyncedTransactions } from './services/binanceSyncMerge';
import { mergeSyncedTransactions } from './services/syncTransactionMerge';
import { KOD_NIEDOSTEPNE_W_DESKTOPIE } from './services/apiTransport';
import { polaRachunkuPoSynchronizacji, rodzajPoBleduKompletu, rodzajWynikuSynchronizacji, wynikZKompletem, type WynikSynchronizacjiRachunku } from './services/statusSynchronizacji';
import type { WynikPortfelaZSilnika } from './services/engineBridge';
// Z malego modulu, nie z engineBridge: statyczny import mostu silnika wciagal go do
// pakietu startowego, choc nizej jest ladowany dynamicznie.
import { pozycjeNaRachunku, RACHUNEK_NIEUSTALONY } from './services/pozycjaRachunku';
import {
  odczytajZMagazynu,
  uszkodzoneWpisyMagazynu,
  jestTablicaWpisow,
  jestObiektem,
  zapiszWMagazynie,
  obserwujBledyZapisu,
  useSynchronizowanaLista,
  useZapisWMagazynie,
} from './services/magazynPrzegladarki';
import {
  odczytajJezyk,
  odczytajMotyw,
  odczytajZakladke,
  odczytajRok,
  odczytajTickerWykresu,
  odczytajJezykSilnika,
  odczytajMotywSilnika,
  zapiszJezykWszedzie,
  zapiszMotywWszedzie,
  ZDARZENIE_PREFERENCJI,
} from './services/preferencesBridge';


// Kazda zakladka to osobna paczka pobierana dopiero przy wejsciu. Wczesniej
// caly interfejs - razem z wykresami, alertami i warsztatem silnika - siedzial
// w pakiecie startowym i przekraczal prog wydajnosci projektu.
const PortfolioDashboard = leniwyZPonowieniem(() => import('./components/PortfolioDashboard'), (modul) => modul.PortfolioDashboard);
const TaxDashboard = leniwyZPonowieniem(() => import('./components/TaxDashboard'), (modul) => modul.TaxDashboard);
const FifoDetailsTable = leniwyZPonowieniem(() => import('./components/FifoDetailsTable'), (modul) => modul.FifoDetailsTable);
const TransactionHistory = leniwyZPonowieniem(() => import('./components/TransactionHistory'), (modul) => modul.TransactionHistory);
const BrokerAccountsManager = leniwyZPonowieniem(() => import('./components/BrokerAccountsManager'), (modul) => modul.BrokerAccountsManager);
const RealTimeCharts = leniwyZPonowieniem(() => import('./components/RealTimeCharts'), (modul) => modul.RealTimeCharts);
const PriceAlertsModal = leniwyZPonowieniem(() => import('./components/PriceAlertsModal'), (modul) => modul.PriceAlertsModal);
const TwoFactorAuthModal = leniwyZPonowieniem(() => import('./components/TwoFactorAuthModal'), (modul) => modul.TwoFactorAuthModal);
const AddTransactionModal = leniwyZPonowieniem(() => import('./components/AddTransactionModal'), (modul) => modul.AddTransactionModal);
const ImportTransactionsModal = leniwyZPonowieniem(() => import('./components/ImportTransactionsModal'), (modul) => modul.ImportTransactionsModal);
const ManageFavoritesModal = leniwyZPonowieniem(() => import('./components/ManageFavoritesModal'), (modul) => modul.ManageFavoritesModal);
const OptymalizacjaPanel = leniwyZPonowieniem(() => import('./components/OptymalizacjaPanel'), (modul) => modul.OptymalizacjaPanel);
const InvestAnalyzerApp = leniwyZPonowieniem(() => import('../invest_analyzer/App'));

/** Zaslona na czas pobierania paczki zakladki - w stylu reszty aplikacji. */
function LadowanieWidoku({ language }: { language: Language }) {
  return (
    <div role="status" className="flex items-center justify-center gap-3 py-24 text-sm text-slate-600 dark:text-slate-300">
      <span aria-hidden="true" className="h-8 w-8 animate-spin rounded-full border-2 border-blue-500 border-t-transparent" />
      <span>{language === 'en' ? 'Loading view…' : 'Wczytywanie widoku…'}</span>
    </div>
  );
}

function oczyscAlerty(lista: PriceAlert[]): PriceAlert[] {
  // Tylko prawdziwe alerty uzytkownika z poprawnym tickerem - bez demo, fake i mock.
  return lista.filter(
    (a) =>
      a &&
      a.id &&
      typeof a.ticker === 'string' &&
      a.ticker.trim().length > 0 &&
      typeof a.targetPrice === 'number' &&
      !a.id.startsWith('demo_') &&
      !a.id.startsWith('fake_') &&
      !a.id.includes('mock')
  );
}

export default function App() {
  // Persistence state loaders - clean legacy mock data safely
  const [language, setLanguage] = useState<Language>(() => odczytajJezyk());

  const [transactions, setTransactions] = useState<Transaction[]>(() => {
    const parsed = odczytajZMagazynu<Transaction[]>(
      'pit38_transactions',
      INITIAL_TRANSACTIONS,
      jestTablicaWpisow as (wartosc: unknown) => wartosc is Transaction[]
    );
    try {
      return oczyscTransakcje(parsed);
    } catch {
      return INITIAL_TRANSACTIONS;
    }
  });

  const [accounts, setAccounts] = useState<BrokerAccount[]>(() => {
    const parsed = odczytajZMagazynu<BrokerAccount[]>(
      'pit38_accounts',
      INITIAL_ACCOUNTS,
      jestTablicaWpisow as (wartosc: unknown) => wartosc is BrokerAccount[]
    );
    try {
      // Najpierw czyscimy transakcje, bo prawdziwy wpis chroni dawny rachunek demo.
      return oczyscRachunki(parsed, transactions);
    } catch {
      return INITIAL_ACCOUNTS;
    }
  });

  const aktualneTransakcje = useRef(transactions);
  aktualneTransakcje.current = transactions;
  // Synchronizator zachowuje pierwszy filtr; ref daje mu biezace dane bez ponownego montowania.
  const oczyscAktualneRachunki = useCallback(
    (lista: BrokerAccount[]) => oczyscRachunki(lista, aktualneTransakcje.current),
    [],
  );

  const [alerts, setAlerts] = useState<PriceAlert[]>(() => {
    const parsed = odczytajZMagazynu<PriceAlert[]>(
      'pit38_alerts',
      INITIAL_ALERTS,
      jestTablicaWpisow as (wartosc: unknown) => wartosc is PriceAlert[]
    );
    try {
      // Remove any fake, demo, corrupted or mock alerts - keep only real user alerts with valid ticker
      return oczyscAlerty(parsed);
    } catch {
      return INITIAL_ALERTS;
    }
  });

  const [brokerOrders, setBrokerOrders] = useState<BrokerOrder[]>(() =>
    oczyscZlecenia(odczytajZMagazynu<BrokerOrder[]>(
      'pit38_broker_orders',
      INITIAL_BROKER_ORDERS,
      jestTablicaWpisow as (wartosc: unknown) => wartosc is BrokerOrder[]
    ))
  );

  const [twoFactor, setTwoFactor] = useState<TwoFactorState>(() => ({
    ...INITIAL_2FA,
    ...odczytajZMagazynu<Partial<TwoFactorState>>(
      'pit38_2fa',
      {},
      jestObiektem as (wartosc: unknown) => wartosc is Partial<TwoFactorState>
    ),
  }));

  const [activeTab, setActiveTab] = useState<string>(() => odczytajZakladke());

  const [selectedYear, setSelectedYear] = useState<number>(() => odczytajRok());

  const [quotes, setQuotes] = useState<Record<string, LiveMarketQuote>>(marketDataService.getQuotes());
  const [favorites, setFavorites] = useState<string[]>(marketDataService.getFavorites());
  const [notifications, setNotifications] = useState<AppNotification[]>(pushNotificationService.getNotifications());
  const [isSyncing, setIsSyncing] = useState(false);
  const [syncingAccountId, setSyncingAccountId] = useState<string | null>(null);
  const [isRefreshingQuotes, setIsRefreshingQuotes] = useState(false);

  const [selectedTickerForChart, setSelectedTickerForChart] = useState<string>(() => {
    // Bez zapamietanego wyboru wykres sam wezmie pierwszy walor z notowan - nie wpisana na sztywno NVDA.
    return odczytajTickerWykresu();
  });

  const [selectedAlertTicker, setSelectedAlertTicker] = useState<string | undefined>(undefined);
  const [selectedAlertAccountId, setSelectedAlertAccountId] = useState<string | undefined>(undefined);

  const [theme, setTheme] = useState<'dark' | 'light'>(() => odczytajMotyw());

  // Modals
  const [showAddTxModal, setShowAddTxModal] = useState(false);
  const [editingTx, setEditingTx] = useState<Transaction | null>(null);
  const [showImportModal, setShowImportModal] = useState(false);
  const [showFifoDetails, setShowFifoDetails] = useState(false);
  const [showManageFavoritesModal, setShowManageFavoritesModal] = useState(false);
  const zamknijOkna = useCallback(() => {
    setShowAddTxModal(false);
    setEditingTx(null);
    setShowImportModal(false);
    setShowManageFavoritesModal(false);
  }, []);

  // Stan przeliczenia w silniku podatkowym
  // Licznik wymusza ponowny przebieg po zmianie ustawien optymalizacji -
  // same transakcje sie wtedy nie zmieniaja, a wynik owszem.
  const [wersjaUstawien, setWersjaUstawien] = useState(0);
  // Wersja wejscia rosnie przy kazdej zmianie (wynik od razu nieaktualny), a
  // przeliczenie rusza po chwili spokoju - pisanie kwoty nie uruchamia silnika
  // przy kazdym znaku.
  const [wersjaWejscia, setWersjaWejscia] = useState(0);
  useEffect(() => {
    let odlozony: ReturnType<typeof setTimeout> | undefined;
    const uniewaznij = () => {
      setWersjaWejscia((wersja) => wersja + 1);
      if (odlozony) clearTimeout(odlozony);
      odlozony = setTimeout(() => setWersjaUstawien((wersja) => wersja + 1), 800);
    };
    window.addEventListener('tax-input-changed', uniewaznij);
    return () => {
      window.removeEventListener('tax-input-changed', uniewaznij);
      if (odlozony) clearTimeout(odlozony);
    };
  }, []);
  // Lata napotkane w danych. Silnik liczy jeden rok na przebieg i zaweza dane
  // do jego horyzontu, wiec sama lista z ostatniego wyniku sie kurczyla:
  // po przejsciu na rok wczesniejszy nowsze znikaly z przelacznika i nie dalo
  // sie do nich wrocic bez czyszczenia danych.
  const [znaneLata, setZnaneLata] = useState<number[]>(() =>
    odczytajZMagazynu<number[]>(
      'pit38_znane_lata',
      [],
      ((wartosc: unknown) => Array.isArray(wartosc) && wartosc.every((rok) => typeof rok === 'number')) as (
        wartosc: unknown
      ) => wartosc is number[]
    )
  );
  const [isCalculating, setIsCalculating] = useState(false);
  const [engineError, setEngineError] = useState<string | null>(null);
  // Wersja hostowana: krotka informacja nad widokami, chowana na stale po "OK".
  const trybHostowany = czyTrybHostowany();
  const [informacjaHostinguUkryta, setInformacjaHostinguUkryta] = useState<boolean>(() => {
    try {
      return localStorage.getItem('pit38_hosting_info_ukryta') === '1';
    } catch {
      return false;
    }
  });
  const ukryjInformacjeHostingu = useCallback(() => {
    setInformacjaHostinguUkryta(true);
    try {
      localStorage.setItem('pit38_hosting_info_ukryta', '1');
    } catch {
      // Bez magazynu informacja wroci po odswiezeniu - nieszkodliwe.
    }
  }, []);
  const [resultYear, setResultYear] = useState<number | null>(null);
  const [resultInputKey, setResultInputKey] = useState<string | null>(null);

  // Tax calculation state
  const [taxResult, setTaxResult] = useState<TaxCalculationResult>({
    realizedGains: [],
    dividends: [],
    yearSummaries: new Map(),
    openPositions: [],
    unmatchedSalesWarnings: [],
  });
  // Transakcje z przebiegu silnika (dokumenty w magazynie). `null` znaczy, ze
  // silnik jeszcze nie policzyl wybranego roku - to nie jest "zero transakcji".
  const [transakcjeSilnika, setTransakcjeSilnika] = useState<Transaction[] | null>(null);
  const [pominieteBezDanych, setPominieteBezDanych] = useState(0);
  const [wymuszeniePrzeliczenia, setWymuszeniePrzeliczenia] = useState(0);
  const ostatnieWymuszenie = React.useRef(0);
  // Stan rachunku u brokera (tylko odczyt) do potwierdzenia pozycji z FIFO.
  const [pozycjeBrokera, setPozycjeBrokera] = useState<PozycjaBrokera[] | null>(null);

  // Save to localStorage
  // Zmiana jezyka lub motywu dokonana w warsztacie silnika ma przestawic
  // rowniez powloke - inaczej dolny pasek zostaje w poprzednim ustawieniu.
  useEffect(() => {
    const zsynchronizuj = () => {
      const jezykSilnika = odczytajJezykSilnika();
      setLanguage((poprzedni) => (poprzedni === jezykSilnika ? poprzedni : jezykSilnika));
      const motywSilnika = odczytajMotywSilnika();
      setTheme((poprzedni) => (poprzedni === motywSilnika ? poprzedni : motywSilnika));
    };
    window.addEventListener(ZDARZENIE_PREFERENCJI, zsynchronizuj);
    return () => window.removeEventListener(ZDARZENIE_PREFERENCJI, zsynchronizuj);
  }, []);

  // Jezyk i motyw ida do obu magazynow, zeby warsztat silnika przelaczyl sie
  // razem z powloka - inaczej polowa aplikacji zostaje w drugim jezyku.
  // Uszkodzony wpis w magazynie przegladarki byl dotad widoczny tylko w konsoli:
  // aplikacja startowala z pusta lista transakcji, a rozliczenie pokazywalo
  // 0,00 zl bez slowa wyjasnienia. Tresc jest odlozona pod kluczem z sufiksem
  // ":uszkodzony", wiec da sie ja odzyskac.
  useEffect(() => {
    uszkodzoneWpisyMagazynu.forEach(({ klucz, powod }) =>
      pushNotificationService.sendPushNotification(
        '⚠️ Uszkodzony zapis w przeglądarce',
        `Nie udało się odczytać "${klucz}" (${powod}). Te dane NIE weszły do rozliczenia. ` +
          `Kopia została odłożona pod kluczem "${klucz}:uszkodzony".`,
        'WARNING'
      )
    );
  }, []);

  useEffect(() => obserwujBledyZapisu(() => {
    pushNotificationService.sendPushNotification(
      '⚠️ Dane NIE zostały zapisane',
      'Magazyn przeglądarki odmówił zapisu. Zmiany mogą zniknąć po odświeżeniu. Zwolnij miejsce i wyeksportuj kopię zapasową.',
      'WARNING',
    );
  }), []);

  useEffect(() => {
    zapiszJezykWszedzie(language);
  }, [language]);

  useEffect(() => {
    zapiszWMagazynie('pit38_active_tab', activeTab);
  }, [activeTab]);

  useEffect(() => {
    zapiszWMagazynie('pit38_selected_year', selectedYear.toString());
  }, [selectedYear]);

  useEffect(() => {
    zapiszWMagazynie('pit38_selected_chart_ticker', selectedTickerForChart);
  }, [selectedTickerForChart]);

  useEffect(() => {
    zapiszMotywWszedzie(theme);
  }, [theme]);

  useSynchronizowanaLista('pit38_accounts', accounts, setAccounts, oczyscAktualneRachunki);

  useSynchronizowanaLista('pit38_transactions', transactions, setTransactions, oczyscTransakcje);

  useSynchronizowanaLista('pit38_alerts', alerts, setAlerts, oczyscAlerty);

  useSynchronizowanaLista('pit38_broker_orders', brokerOrders, setBrokerOrders, oczyscZlecenia);

  useZapisWMagazynie('pit38_2fa', twoFactor);

  // Podatek liczy wylacznie silnik podatkowy (Python), a jego przebieg jest
  // JEDNYM zrodlem danych dla zakladek Portfel, PIT-38 i Transakcje. Silnik
  // czyta magazyn dokumentow, wiec pusta lista lokalna nie zwalnia z liczenia:
  // przy swiezym profilu przegladarki dokumenty brokera nadal leza w magazynie.
  const naZakladceSilnika = activeTab === 'engine';
  // Serializacja calej listy przy kazdym renderze (takze po kazdym notowaniu) kosztowala
  // kilkanascie ms przy kilku tysiacach transakcji - liczona tylko przy zmianie wejscia.
  const currentInputKey = useMemo(
    () => JSON.stringify([selectedYear, transactions, accounts, wersjaWejscia]),
    [selectedYear, transactions, accounts, wersjaWejscia],
  );
  const taxFreshness = taxResultFreshness({
    selectedYear, resultYear, currentKey: currentInputKey, resultKey: resultInputKey,
    failed: Boolean(engineError), loading: isCalculating,
  });
  const przyjmijWynik = useCallback(
    async (res: WynikPortfelaZSilnika) => {
      const { pustePodsumowanieRoku } = await import('./services/engineBridge');
      const lataZWyniku = Array.from(res.yearSummaries.keys());
      setZnaneLata((znane) => {
        const wszystkie = Array.from(new Set([...znane, ...lataZWyniku])).sort((x, y) => y - x);
        if (wszystkie.length === znane.length) return znane;
        zapiszWMagazynie('pit38_znane_lata', wszystkie);
        return wszystkie;
      });
      const uzupelnione = new Map(res.yearSummaries);
      for (const rok of [...znaneLata, ...lataZWyniku]) {
        if (!uzupelnione.has(rok)) uzupelnione.set(rok, pustePodsumowanieRoku(rok));
      }
      setTaxResult({ ...res, yearSummaries: uzupelnione });
      setResultYear(selectedYear);
      setResultInputKey(currentInputKey);
      setEngineError(null);
      setTransakcjeSilnika(res.transakcjeSilnika);
      setPominieteBezDanych(res.pominieteBezDanych);
    },
    [znaneLata, selectedYear, currentInputKey]
  );

  useEffect(() => {
    // Warsztat silnika liczy sam i publikuje wynik - portfel go odbierze
    // (subskrypcja nizej), wiec nie uruchamia rownolegle drugiego przebiegu.
    if (naZakladceSilnika) return;

    const kontroler = new AbortController();
    let aktualny = true;
    const wymus = wymuszeniePrzeliczenia !== ostatnieWymuszenie.current;
    const opoznienie = setTimeout(() => {
      ostatnieWymuszenie.current = wymuszeniePrzeliczenia;
      setIsCalculating(true);
      setEngineError(null);
      // Wersja hostowana (telefon) nie ma silnika: pozycje liczy przegladarka
      // (FIFO + NBP), kwoty PIT-38 zostaja "nieobliczone". Poza hostingiem
      // jedyna droga jest silnik - bez cichego zastepowania wyniku.
      const przebieg = czyTrybHostowany()
        ? import('./services/pozycjeLokalne').then(({ policzPortfelLokalnie }) =>
            policzPortfelLokalnie(transactions, accounts, { year: selectedYear }))
        : import('./services/engineBridge').then(({ calculateTaxesWithEngine }) =>
            calculateTaxesWithEngine(transactions, accounts, {
              year: selectedYear,
              signal: kontroler.signal,
              wymusPrzeliczenie: wymus,
            }));
      przebieg
        .then(async (res) => {
          if (!aktualny) return;
          await przyjmijWynik(res);
        })
        .catch((blad: unknown) => {
          if (!aktualny || (blad as Error)?.name === 'AbortError') return;
          // Nieudany przebieg nie moze zostawic na ekranie kwot z innego roku.
          setTransakcjeSilnika(null);
          setEngineError(
            blad instanceof Error ? blad.message : 'Silnik podatkowy nie odpowiedzial.'
          );
        })
        .finally(() => {
          if (aktualny) setIsCalculating(false);
        });
    }, 1200);

    return () => {
      aktualny = false;
      clearTimeout(opoznienie);
      kontroler.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [transactions, accounts, selectedYear, wersjaUstawien, wymuszeniePrzeliczenia, naZakladceSilnika]);

  // Wynik policzony w warsztacie ("Dokumenty i silnik") zasila te same zakladki.
  useEffect(() => {
    let aktualny = true;
    const odsubskrybuj = subskrybujWynikSilnika((wynik) => {
      if (wynik.rok !== selectedYear) return;
      import('./services/engineBridge').then(async ({ zbudujWynikPortfelaZSilnika }) => {
        if (!aktualny) return;
        const aktualneZadanie = await przygotujZadanieSilnika(selectedYear, { transakcjePortfela: transactions });
        if (!aktualny || wynik.kluczZadania !== aktualneZadanie.klucz) return;
        await przyjmijWynik(
          zbudujWynikPortfelaZSilnika(
            wynik.odpowiedz,
            wynik.rok,
            transactions,
            accounts,
            odczytajUstawienia().informacjePit8c
          )
        );
      }).catch(() => undefined);
    });
    return () => {
      aktualny = false;
      odsubskrybuj();
    };
  }, [selectedYear, transactions, accounts, przyjmijWynik]);

  // Zmiana roku: kwoty poprzedniego roku znikaja od razu, zamiast udawac wynik.
  useEffect(() => {
    setTransakcjeSilnika(null);
  }, [selectedYear]);

  // Stan rachunku Freedom24 (tylko odczyt, jedno zapytanie) - do zestawienia
  // z pozycjami wynikajacymi z transakcji. Klucze leza w plikach serwera, wiec
  // o tym, czy pytac, decyduje status serwera, a nie lista rachunkow w
  // przegladarce (przy swiezym profilu jest pusta, a rachunek istnieje).
  useEffect(() => {
    let aktualny = true;
    import('./services/freedom24LivePortfolioService').then(async ({ freedom24LivePortfolioService }) => {
      const pozycje = await freedom24LivePortfolioService.fetchBrokerPositions();
      if (aktualny) setPozycjeBrokera(pozycje);
    });
    return () => {
      aktualny = false;
    };
  }, [wymuszeniePrzeliczenia]);

  const cenyBrokera = useMemo(
    () =>
      (pozycjeBrokera ?? []).map((pozycja) => ({
        ticker: pozycja.ticker,
        price: pozycja.marketPrice ?? null,
        currency: pozycja.currency,
      })),
    [pozycjeBrokera]
  );

  const rozbieznosciZBrokerem = useMemo(
    () =>
      pozycjeBrokera && transakcjeSilnika
        ? zestawPozycjeZBrokerem(taxResult.openPositions, pozycjeBrokera)
        : [],
    [pozycjeBrokera, transakcjeSilnika, taxResult.openPositions]
  );

  // Lista zakladki "Transakcje": wiersze z przebiegu silnika plus wpisy lokalne,
  // ktorych silnik nie dostal (dywidendy, oplaty, krypto) - z powodem.
  const podzialLokalnych = useMemo(() => podzielTransakcjeLokalne(transactions), [transactions]);
  const transakcjeDoListy = useMemo(() => {
    if (!transakcjeSilnika) {
      return transactions.filter((tx) => !czyKopiaZApiFreedom24(tx));
    }
    const wSilniku = new Set(transakcjeSilnika.map((tx) => tx.id));
    const tylkoLokalne = transactions.filter((tx) => !wSilniku.has(tx.id) && !czyKopiaZApiFreedom24(tx));
    return [...transakcjeSilnika, ...tylkoLokalne].sort((x, y) => y.date.localeCompare(x.date));
  }, [transakcjeSilnika, transactions]);
  // Licznik w pasku zrodla: jedno przejscie zamiast szesciu filtrow przy kazdym
  // renderze (a PortfelApp renderuje sie przy kazdym odczycie notowan).
  const licznikiSilnika = useMemo(() => {
    const liczniki = { BUY: 0, SELL: 0, DIVIDEND: 0 };
    for (const tx of transakcjeSilnika ?? []) {
      if (tx.type === 'BUY' || tx.type === 'SELL' || tx.type === 'DIVIDEND') liczniki[tx.type] += 1;
    }
    return liczniki;
  }, [transakcjeSilnika]);

  // Notowania odpytujemy tylko dla tego, co uzytkownik ma albo obserwuje.
  useEffect(() => {
    marketDataService.setPortfolioTickers(taxResult.openPositions.map((pozycja) => pozycja.ticker));
  }, [taxResult.openPositions]);

  // Subscribe to live market data feed
  useEffect(() => {
    const unsubQuotes = marketDataService.subscribe((updatedQuotes) => {
      setQuotes(updatedQuotes);
    });
    const unsubFavs = marketDataService.subscribeFavorites((updatedFavs) => {
      setFavorites(updatedFavs);
    });
    return () => {
      unsubQuotes();
      unsubFavs();
    };
  }, []);

  // Check alerts on market data change
  useEffect(() => {
    pushNotificationService.checkPriceAlerts(alerts, quotes, (updatedAlert) => {
      setAlerts((prev) => prev.map((a) => (a.id === updatedAlert.id ? updatedAlert : a)));
    });
  }, [quotes, alerts]);

  // Real-time Broker Protective Orders execution monitoring against live quotes
  useEffect(() => {
    if (!quotes || Object.keys(quotes).length === 0) return;

    setBrokerOrders((prevOrders) => {
      let hasChanged = false;
      const updated = prevOrders.map((order) => {
        if (order.status !== 'ARMED') return order;
        const q = quotes[order.ticker.toUpperCase()];
        if (!q || !q.price) return order;

        let shouldExecute = false;
        let execMessage = '';

        if (order.stopPrice && q.price <= order.stopPrice) {
          shouldExecute = true;
          execMessage = `Kurs ${formatLiczba(q.price)} ${order.currency} zszedł do progu Stop-Loss (${formatLiczba(order.stopPrice)} ${order.currency}). Aplikacja widzi tylko notowanie - czy i po jakiej cenie broker ${order.brokerName || order.brokerType} zrealizował zlecenie, sprawdź na rachunku.`;
        } else if (order.takeProfitPrice && q.price >= order.takeProfitPrice) {
          shouldExecute = true;
          execMessage = `Kurs ${formatLiczba(q.price)} ${order.currency} doszedł do progu Take-Profit (${formatLiczba(order.takeProfitPrice)} ${order.currency}). Aplikacja widzi tylko notowanie - czy i po jakiej cenie broker ${order.brokerName || order.brokerType} zrealizował zlecenie, sprawdź na rachunku.`;
        }

        if (shouldExecute) {
          hasChanged = true;
          pushNotificationService.sendPushNotification(
            `⚡ Próg zlecenia osiągnięty (${order.ticker})`,
            execMessage,
            'WARNING'
          );
          return {
            ...order,
            status: 'EXECUTED' as const,
            message: execMessage,
          };
        }
        return order;
      });

      return hasChanged ? updated : prevOrders;
    });
  }, [quotes]);

  // Subscribe to push notifications
  useEffect(() => {
    const unsub = pushNotificationService.subscribe((items) => {
      setNotifications(items);
    });
    return () => unsub();
  }, []);

  // Favorites Handlers
  const handleToggleFavorite = (ticker: string) => {
    const isNowFav = marketDataService.toggleFavorite(ticker);
    pushNotificationService.sendPushNotification(
      isNowFav ? '⭐ Dodano do Ulubionych' : 'Usunięto z Ulubionych',
      `${ticker.toUpperCase()} ${isNowFav ? 'będzie teraz wyświetlany' : 'nie będzie już wyświetlany'} na górnym pasku notowań.`,
      'INFO'
    );
  };

  const handleSetFavorites = (tickers: string[]) => {
    marketDataService.setFavorites(tickers);
  };

  const handleRefreshQuotes = async () => {
    setIsRefreshingQuotes(true);
    await marketDataService.fetchRealQuotes(undefined, true);
    setIsRefreshingQuotes(false);
    pushNotificationService.sendPushNotification(
      '📊 Zaktualizowano Notowania',
      'Pobrano świeże, rzeczywiste kursy giełdowe i kryptowalutowe bezpośrednio z giełd.',
      'SUCCESS'
    );
  };

  const handleSelectTickerForChart = (ticker: string) => {
    setSelectedTickerForChart(ticker);
    setActiveTab('charts');
  };

  // Sync API Handlers
  const handleSyncAllApis = async () => {
    setIsSyncing(true);
    await handleSyncAllAccounts();
    await marketDataService.fetchRealQuotes();
    setIsSyncing(false);
  };

  /** Kody "rachunek nie ma API" specyficzne dla tej platformy (desktop nie ma czesci endpointow). */
  const KODY_BEZ_API_PLATFORMY = [KOD_NIEDOSTEPNE_W_DESKTOPIE];

  /**
   * Synchronizacja jednego rachunku - wspolna dla przycisku rachunku i synchronizacji zbiorczej.
   * Zbiorcza dawniej pomijala komplet Freedom24 i niewaznienie wyniku, a znacznik synchronizacji
   * ustawiala takze po bledzie. W trybie zbiorczym pojedyncze powiadomienia o wyniku zastepuje
   * podsumowanie; ostrzezenia i komplet Freedom24 sa pokazywane zawsze.
   */
  const synchronizujRachunek = async (
    acc: BrokerAccount,
    tryb: 'POJEDYNCZA' | 'ZBIORCZA',
  ): Promise<{ rodzaj: WynikSynchronizacjiRachunku; zaimportowano: number }> => {
    const accountId = acc.id;
    const pojedyncza = tryb === 'POJEDYNCZA';
    try {
      const result = await brokerApiService.syncAccount(acc);
      const now = new Date().toISOString();
      let rodzaj = rodzajWynikuSynchronizacji(result, KODY_BEZ_API_PLATFORMY);
      // Blad kompletu Freedom24 jest bledem synchronizacji, wiec status rachunku ustalamy
      // dopiero po nim (nizej), a nie zaraz po pobraniu listy transakcji.
      let komunikatBleduKompletu: string | null = null;

      let zaimportowano = 0;
      if (
        result.success && result.syncedTransactions &&
        (result.syncedTransactions.length > 0 || (acc.brokerType === 'BINANCE' && Array.isArray(result.completeSymbols)))
      ) {
        zaimportowano = result.syncedTransactions.length;
        setTransactions((prev) => {
          if (acc.brokerType === 'BINANCE' && Array.isArray(result.completeSymbols)) {
            return mergeBinanceSyncedTransactions(prev, accountId, result.syncedTransactions, result.completeSymbols);
          }
          return mergeSyncedTransactions(prev, accountId, result.syncedTransactions);
        });

        if (pojedyncza) {
          pushNotificationService.sendPushNotification(
            `✅ Synchronizacja API: ${acc.name}`,
            `Pobrano ${result.syncedTransactions.length} ${odmienLiczebnik(result.syncedTransactions.length, 'pozycję', 'pozycje', 'pozycji')} z API brokera ${acc.brokerType}.`,
            'SUCCESS'
          );
        }
      } else if (pojedyncza && result.success) {
        pushNotificationService.sendPushNotification(
          `ℹ️ Synchronizacja: ${acc.name}`,
          result.message || 'Zweryfikowano stan konta maklerskiego przez API.',
          'INFO'
        );
      } else if (pojedyncza && !result.success) {
        pushNotificationService.sendPushNotification(
          `❌ Błąd API: ${acc.name}`,
          result.message || result.error || 'Serwer brokera odrzucił żądanie synchronizacji.',
          'ALERT'
        );
      }

      // Czego odczyt nie objal. Salda i pozycje bez daty nabycia byly kiedys
      // dopisywane jako dzisiejsze zakupy - teraz sa pomijane, wiec uzytkownik
      // musi sie o nich dowiedziec, a nie tylko log serwera.
      (result.ostrzezenia ?? []).forEach((tresc) =>
        pushNotificationService.sendPushNotification(
          `⚠️ Niepełny odczyt: ${acc.name}`,
          tresc,
          'WARNING'
        )
      );
      // Sama lista transakcji nie wystarcza do rozliczenia: prowizje, oplaty,
      // odsetki, przewalutowania i podatek u zrodla siedza w przeplywach
      // pieniznych. Pobieramy komplet i oddajemy go silnikowi, bo dotad te
      // pozycje konczyly w widzetach i nie pomniejszaly dochodu.
      if (result.success && acc.brokerType === 'FREEDOM24') {
        try {
          // Modul dociagamy na zadanie - dotyczy tylko rachunkow Freedom24,
          // wiec nie ma powodu trzymac go w pakiecie startowym.
          const { pobierzKompletZFreedom24 } = await import('./services/freedom24Komplet');
          const komplet = await pobierzKompletZFreedom24(acc);
          // Brak sekcji raportu (np. zdarzen korporacyjnych) nie moze wygladac
          // jak "komplet" - zdarzenia z tej sekcji nie trafia do rozliczenia.
          if (komplet.brakujaceSekcje.length > 0) {
            pushNotificationService.sendPushNotification(
              `⚠️ Niekompletne dane z Freedom24`,
              `Zapisano ${komplet.transakcje} ${odmienLiczebnik(komplet.transakcje, 'transakcję', 'transakcje', 'transakcji')} i ${komplet.przeplywy} ${odmienLiczebnik(komplet.przeplywy, 'operację pieniężną', 'operacje pieniężne', 'operacji pieniężnych')}, ale nie udało się pobrać sekcji raportu: ${komplet.brakujaceSekcje.join(', ')}. Zdarzenia z tych sekcji mogą nie trafić do rozliczenia — ponów pobranie.`,
              'WARNING'
            );
          } else {
            pushNotificationService.sendPushNotification(
              `📥 Komplet danych z Freedom24`,
              `Zapisano ${komplet.transakcje} ${odmienLiczebnik(komplet.transakcje, 'transakcję', 'transakcje', 'transakcji')} i ${komplet.przeplywy} ${odmienLiczebnik(komplet.przeplywy, 'operację pieniężną', 'operacje pieniężne', 'operacji pieniężnych')} do rozliczenia.${komplet.ostrzezenia.length > 0 ? ` Uwagi: ${komplet.ostrzezenia.join('; ')}` : ''}`,
              'SUCCESS'
            );
          }
          // Magazyn sie zmienil: poprzedni wynik silnika opisuje stare pliki.
          uniewaznijWynikiSilnika();
          setWymuszeniePrzeliczenia((n) => n + 1);
        } catch (bladKompletu: unknown) {
          // Magazyn silnika nie zostal odswiezony: zbiorcza synchronizacja nie moze byc zielona.
          rodzaj = rodzajPoBleduKompletu(rodzaj);
          komunikatBleduKompletu = bladKompletu instanceof Error ? bladKompletu.message : 'Nie udało się pobrać pełnych danych.';
          pushNotificationService.sendPushNotification(
            `⚠️ Komplet danych z Freedom24`,
            komunikatBleduKompletu,
            'ALERT'
          );
        }
      }
      // Koncowy status rachunku: przy bledzie kompletu ERROR i poprzedni lastSyncAt.
      const wynikKoncowy = wynikZKompletem(result, komunikatBleduKompletu);
      setAccounts((prev) =>
        prev.map((a) => (a.id === accountId ? { ...a, ...polaRachunkuPoSynchronizacji(wynikKoncowy, a, now, KODY_BEZ_API_PLATFORMY) } : a))
      );
      return { rodzaj, zaimportowano };
    } catch (err: any) {
      console.warn(`Error syncing broker ${acc.name}`, err);
      setAccounts((prev) =>
        prev.map((a) =>
          a.id === accountId
            ? {
                ...a,
                lastSyncStatus: 'ERROR',
                lastError: err.message,
                statusMessage: `Błąd synchronizacji: ${err.message}`,
              }
            : a
        )
      );
      if (pojedyncza) {
        pushNotificationService.sendPushNotification(
          `❌ Błąd API: ${acc.name}`,
          `Nie udało się ukończyć synchronizacji: ${err.message}`,
          'ALERT'
        );
      }
      return { rodzaj: 'BLAD', zaimportowano: 0 };
    }
  };

  const handleSyncAccount = async (accountId: string, accountOverride?: BrokerAccount) => {
    const acc = accountOverride || accounts.find((a) => a.id === accountId);
    if (!acc) return;

    setSyncingAccountId(accountId);
    try {
      await synchronizujRachunek(acc, 'POJEDYNCZA');
    } finally {
      setSyncingAccountId(null);
    }
  };

  const handleSyncAllAccounts = async () => {
    setIsSyncing(true);
    let totalImported = 0;
    const connectedAccounts = accounts.filter((a) => a.isApiConnected);

    const rachunkiZBledem: string[] = [];
    for (const acc of connectedAccounts) {
      const { rodzaj, zaimportowano } = await synchronizujRachunek(acc, 'ZBIORCZA');
      totalImported += zaimportowano;
      if (rodzaj === 'BLAD') rachunkiZBledem.push(acc.name);
    }

    setIsSyncing(false);
    // Zielone "Zsynchronizowano konta maklerskie" wychodzilo takze wtedy, gdy
    // kazdy rachunek zwrocil blad - blad zostawal tylko w konsoli i na karcie.
    if (rachunkiZBledem.length > 0) {
      pushNotificationService.sendPushNotification(
        'Synchronizacja zakończona z błędami',
        `Nie udało się odczytać: ${rachunkiZBledem.join(', ')}. Zaktualizowano ${totalImported} ${odmienLiczebnik(totalImported, 'pozycję', 'pozycje', 'pozycji')} z pozostałych rachunków.`,
        'WARNING'
      );
    } else {
      pushNotificationService.sendPushNotification(
        '✅ Zbiorcza Synchronizacja API Zakończona',
        `Zsynchronizowano konta maklerskie. Zaktualizowano ${totalImported} ${odmienLiczebnik(totalImported, 'pozycję', 'pozycje', 'pozycji')}.`,
        'SUCCESS'
      );
    }
  };

  // Transaction CRUD
  const handleSaveTransaction = (tx: Transaction) => {
    // Ensure account exists in accounts list
    // Tylko pierwszy zapis bez zadnego rachunku dostaje rachunek domyslny formularza. Obce id
    // zostaje przy transakcji bez tworzenia fikcyjnego rachunku CUSTOM (widoki pokazuja je jako nieprzypisane).
    if (tx.accountId && czyUtworzycRachunekDlaTransakcji(tx.accountId, accounts.map((a) => a.id))) {
      setAccounts((prev) => [
        ...prev,
        {
          id: tx.accountId,
          name: 'Główny rachunek maklerski',
          brokerType: 'CUSTOM',
          currency: (tx.currency as CurrencyCode) || 'PLN',
          color: '#3B82F6',
          isApiConnected: false,
          createdAt: new Date().toISOString(),
        },
      ]);
    }

    setTransactions((prev) => {
      const exists = prev.some((t) => t.id === tx.id);
      if (exists) {
        return prev.map((t) => (t.id === tx.id ? tx : t));
      }
      return [tx, ...prev];
    });
    pushNotificationService.sendPushNotification(
      'Zapisano Transakcję',
      `Dodano/zaktualizowano transakcję dla ${tx.ticker} (${tx.type})`,
      'INFO'
    );
  };

  const handleDeleteTransaction = (id: string) => {
    setTransactions((prev) => prev.filter((t) => t.id !== id));
  };

  const handleClearAllTransactions = () => {
    setTransactions([]);
    localStorage.removeItem('pit38_transactions');
    pushNotificationService.sendPushNotification(
      'Wyczyszczono Historię',
      'Wszystkie transakcje zostały usunięte z lokalnej bazy danych.',
      'INFO'
    );
  };

  const handleResetAllData = () => {
    setAccounts([]);
    setTransactions([]);
    setAlerts([]);
    setBrokerOrders([]);
    localStorage.removeItem('pit38_accounts');
    localStorage.removeItem('pit38_transactions');
    localStorage.removeItem('pit38_alerts');
    localStorage.removeItem('pit38_broker_orders');
    pushNotificationService.sendPushNotification(
      'Wyczyszczono Wszystkie Dane',
      'Zresetowano wszystkie konta maklerskie, transakcje i alerty do stanu czystego.',
      'INFO'
    );
  };

  const handleImportTransactions = (imported: Transaction[]) => {
    // Ensure all referenced accounts exist
    const missingAccountIds = Array.from(
      new Set(imported.map((t) => t.accountId).filter((id) => id && !accounts.some((a) => a.id === id)))
    );
    if (missingAccountIds.length > 0) {
      setAccounts((prev) => [
        ...prev,
        ...missingAccountIds.map((accId) => ({
          id: accId,
          name: 'Rachunek Maklerski (' + accId + ')',
          brokerType: 'CUSTOM' as const,
          currency: 'PLN' as CurrencyCode,
          color: '#3B82F6',
          isApiConnected: false,
          createdAt: new Date().toISOString(),
        })),
      ]);
    }

    const knownIds = new Set(transactions.map((transaction) => transaction.id));
    const unique = imported.filter((transaction) => {
      if (knownIds.has(transaction.id)) return false;
      knownIds.add(transaction.id);
      return true;
    });
    const duplicateCount = imported.length - unique.length;
    setTransactions((prev) => {
      const prevIds = new Set(prev.map((transaction) => transaction.id));
      return [...unique.filter((transaction) => !prevIds.has(transaction.id)), ...prev];
    });
    pushNotificationService.sendPushNotification(
      'Zaimportowano Transakcje',
      `Dodano ${unique.length} ${odmienLiczebnik(unique.length, 'transakcję', 'transakcje', 'transakcji')}; pominięto ${duplicateCount} ${odmienLiczebnik(duplicateCount, 'duplikat', 'duplikaty', 'duplikatów')}.`,
      duplicateCount > 0 ? 'WARNING' : 'SUCCESS'
    );
  };

  const handleQuickAddWithPrefill = (prefill?: {
    ticker?: string;
    type?: 'BUY' | 'SELL';
    quantity?: number;
    category?: any;
    pricePerUnit?: number;
    currency?: CurrencyCode;
    accountId?: string;
    name?: string;
  }) => {
    if (prefill && prefill.ticker) {
      const quote = quotes[prefill.ticker.toUpperCase()];
      const dummyTx: Transaction = {
        id: '',
        accountId: prefill.accountId || accounts[0]?.id || 'acc_default',
        type: prefill.type || 'BUY',
        ticker: prefill.ticker,
        name: prefill.name || quote?.name || prefill.ticker,
        date: dzisiajLokalnie(),
        quantity: prefill.quantity || 1,
        // Bez notowania pole zostaje puste (0), zeby uzytkownik wpisal cene sam.
        // `|| 100` podstawialo cene, ktora wygladala jak prawdziwa.
        pricePerUnit: prefill.pricePerUnit !== undefined ? prefill.pricePerUnit : (quote?.price ?? 0),
        currency: prefill.currency || quote?.currency || 'USD',
        commission: 0,
        commissionCurrency: prefill.currency || quote?.currency || 'USD',
        category: prefill.category || 'STOCK_FOREIGN',
      };
      setEditingTx(dummyTx);
    } else {
      setEditingTx(null);
    }
    setShowAddTxModal(true);
  };

  // "Zamknij pozycje" otwiera formularz sprzedazy z podpowiedzia (ilosc calej pozycji, cena i waluta
  // z notowania, data lokalna) zamiast zapisywac sprzedaz od razu: sprzedaz wchodzi do PIT-38, wiec
  // cena, prowizja i data maja przejsc przez oczy uzytkownika.
  const handleInstantClosePosition = (pos: OpenPosition) => {
    const defaultAccId = pos.lots && pos.lots.length > 0 ? pos.lots[0].accountId : (pos.accountIds[0] || accounts[0]?.id || 'acc_default');
    if (!defaultAccId || defaultAccId === RACHUNEK_NIEUSTALONY) return;
    handleQuickAddWithPrefill(podpowiedzZamknieciaPozycji(pos, quotes[pos.ticker.toUpperCase()], defaultAccId));
  };

  // Broker CRUD
  const handleAddAccount = (newAcc: Omit<BrokerAccount, 'id'>) => {
    const newId = 'acc_' + Date.now();
    const acc: BrokerAccount = {
      ...newAcc,
      id: newId,
    };
    setAccounts((prev) => [...prev, acc]);

    // Auto-trigger sync if API credentials provided
    if (acc.isApiConnected && (acc.apiKey || acc.apiSecret || acc.queryId || acc.accountNumber)) {
      setTimeout(() => {
        handleSyncAccount(newId, acc);
      }, 150);
    }
  };

  const handleUpdateAccount = (updatedAcc: BrokerAccount) => {
    setAccounts((prev) => prev.map((a) => (a.id === updatedAcc.id ? updatedAcc : a)));

    // Auto-trigger sync if API credentials provided
    if (updatedAcc.isApiConnected && (updatedAcc.apiKey || updatedAcc.apiSecret || updatedAcc.queryId || updatedAcc.accountNumber)) {
      setTimeout(() => {
        handleSyncAccount(updatedAcc.id, updatedAcc);
      }, 150);
    }
  };

  const handleDeleteAccount = (id: string) => {
    const rachunek = accounts.find((a) => a.id === id);
    const liczbaTransakcji = transactions.filter((transaction) => transaction.accountId === id).length;
    // Transakcje zostaja w historii - potwierdzenie mowi wprost, co to znaczy dla PIT-8C.
    if (!globalThis.window?.confirm(trescPotwierdzeniaUsunieciaRachunku(rachunek?.name ?? id, liczbaTransakcji))) return;
    setAccounts((prev) => prev.filter((a) => a.id !== id));
  };

  // Price Alert CRUD
  const handleAddAlert = (newAlert: Omit<PriceAlert, 'id' | 'createdAt' | 'isTriggered'>) => {
    const alertItem: PriceAlert = {
      ...newAlert,
      id: 'alert_' + Date.now(),
      createdAt: new Date().toISOString(),
      isTriggered: false,
    };
    setAlerts((prev) => [alertItem, ...prev]);
    pushNotificationService.sendPushNotification(
      'Ustawiono Alert Cenowy',
      `Monitorowanie kursu ${alertItem.ticker} zostało aktywowane.`,
      'INFO'
    );
  };

  const handleDeleteAlert = (id: string) => {
    setAlerts((prev) => prev.filter((a) => a.id !== id));
  };

  const handleUpdateAlert = (updatedAlert: PriceAlert) => {
    setAlerts((prev) =>
      prev.map((a) => (a.id === updatedAlert.id ? updatePriceAlert(a, updatedAlert) : a))
    );
    pushNotificationService.sendPushNotification(
      'Zaktualizowano Alert Cenowy',
      `Parametry alertu dla ${updatedAlert.ticker} zostały pomyślnie zaktualizowane.`,
      'INFO'
    );
  };

  const handleToggleAlert = (id: string) => {
    setAlerts((prev) =>
      prev.map((a) => (a.id === id ? togglePriceAlert(a) : a))
    );
  };

  // Real Broker Protective Orders Handlers
  const handleCreateBrokerOrder = async (
    account: BrokerAccount,
    orderPayload: Omit<BrokerOrderPayload, 'accountId' | 'brokerType' | 'apiKey' | 'apiSecret' | 'accountNumber' | 'apiServerType'>
  ) => {
    const res = await brokerApiService.createOrder(account, orderPayload);
    const newOrder: BrokerOrder = {
      id: `ord_${Date.now()}_${Math.floor(Math.random() * 1000)}`,
      accountId: account.id,
      brokerType: account.brokerType,
      brokerName: account.name,
      ticker: orderPayload.ticker,
      orderType: orderPayload.orderType,
      action: orderPayload.action,
      quantity: orderPayload.quantity,
      stopPrice: orderPayload.stopPrice,
      takeProfitPrice: account.brokerType === 'BINANCE' ? undefined : orderPayload.takeProfitPrice,
      limitPrice: orderPayload.limitPrice,
      currency: orderPayload.currency,
      status: res.success ? 'ARMED' : res.ambiguous ? 'PENDING' : 'REJECTED',
      orderId: res.orderId || undefined,
      clientOrderId: res.clientOrderId || undefined,
      createdAt: new Date().toISOString(),
      expiresAt: orderPayload.expiresAt,
      message: res.message,
      isApiOrder: true,
    };

    setBrokerOrders((prev) => [newOrder, ...prev]);

    if (res.ambiguous) {
      pushNotificationService.sendPushNotification(
        `⚠️ Sprawdź stan zlecenia ${account.brokerType}`,
        res.message,
        'ALERT'
      );
    } else if (res.success) {
      pushNotificationService.sendPushNotification(
        `🛡️ Uzbrojono Zlecenie Ochronne w API Brokera (${account.brokerType})`,
        res.message,
        'SUCCESS'
      );
    } else {
      pushNotificationService.sendPushNotification(
        `❌ Błąd Zlecenia Brokera (${account.brokerType})`,
        res.message || 'Nie udało się zarejestrować zlecenia w systemie brokera.',
        'ALERT'
      );
    }

    return res;
  };

  const handleCancelBrokerOrder = async (orderId: string, accountId: string, ticker?: string, confirm?: true) => {
    const acc = accounts.find((a) => a.id === accountId);
    if (!acc) return { success: false, message: 'Nie znaleziono rachunku.' };
    const res = await brokerApiService.cancelOrder(orderId, acc, ticker, confirm);

    // Wpis znika z listy dopiero wtedy, gdy broker potwierdzil anulowanie.
    // Wczesniej znikal zawsze, wiec zlecenie ochronne dalej wisialo na
    // rachunku, a w aplikacji wygladalo na wycofane.
    setBrokerOrders((prev) =>
      prev.map((o) =>
        o.orderId === orderId || o.id === orderId
          ? {
              ...o,
              status: res.success ? ('CANCELLED' as const) : o.status,
              message: res.success
                ? `Anulowano w API Brokera: ${new Date().toLocaleTimeString('pl-PL')}`
                : res.message || 'Broker nie potwierdził anulowania — zlecenie może nadal być aktywne.',
            }
          : o
      )
    );

    if (res.success) {
      pushNotificationService.sendPushNotification(
        'Anulowano Zlecenie Ochronne',
        `Broker potwierdził wycofanie zlecenia ${orderId}.`,
        'INFO'
      );
    } else {
      pushNotificationService.sendPushNotification(
        '❌ Nie anulowano zlecenia',
        res.message || `Broker nie potwierdził wycofania zlecenia ${orderId}. Sprawdź je w aplikacji brokera.`,
        'ALERT'
      );
    }
    return res;
  };

  // 2FA Handlers
  /**
   * Wlacza albo wylacza 2FA, przyjmujac stan przygotowany przez ekran ochrony.
   *
   * Wczesniej ta funkcja przyjmowala wylacznie flage i gubila drugi argument -
   * a razem z nim sekret TOTP, adres kodu QR, kody zapasowe i ich skroty. Po
   * aktywacji pole z kluczem konfiguracyjnym bylo puste, a obrazek kodu QR nie
   * mial zrodla, wiec nie dalo sie dodac aplikacji uwierzytelniajacej inaczej
   * niz przepisujac klucz przed klknieciem przycisku.
   */
  const handleToggle2FA = (enable: boolean, stanZEkranu?: Partial<TwoFactorState>) => {
    setTwoFactor((prev) => ({
      ...prev,
      ...stanZEkranu,
      isEnabled: enable,
      isLocked: false,
    }));
  };

  const handleLockSession = () => {
    setTwoFactor((prev) => ({
      ...prev,
      isLocked: true,
    }));
  };

  // Odblokowanie sesji sprawdza prawdziwy kod TOTP (RFC 6238) albo niezuzyty
  // kod zapasowy. Wczesniej wystarczylo wpisac dowolne szesc cyfr.
  const handleUnlockSession = async (code: string): Promise<boolean> => {
    const wynik = await verifySessionUnlock(code, twoFactor);
    if (!wynik.valid) {
      return false;
    }
    setTwoFactor(
      wynik.updatedTwoFactor ?? {
        ...twoFactor,
        isLocked: false,
        lastVerifiedAt: new Date().toISOString(),
      }
    );
    return true;
  };

  return (
    <div className="h-full bg-slate-100 dark:bg-slate-950 text-slate-900 dark:text-slate-100 transition-colors duration-200 flex flex-col font-sans">
      {/* 2FA Locked Screen Barrier */}
      {twoFactor.isEnabled && twoFactor.isLocked && (
        <SessionLockScreen
          twoFactor={twoFactor}
          language={language}
          onUnlock={handleUnlockSession}
        />
      )}

      {/* Main Content Body with generous bottom scroll clearance for fixed bottom navigation */}
      {/* Warsztat silnika: import plikow brokerskich, kontrola jakosci, raport roczny
          i kopie decyzji. Ma wlasna nawigacje i wlasne przewijanie, wiec dostaje cale okno. */}
      {activeTab === 'engine' ? (
        <div className="flex-1 min-h-0 pb-20 sm:pb-24">
          <ErrorBoundary key="engine">
          <Suspense fallback={<LadowanieWidoku language={language} />}>
            <InvestAnalyzerApp />
          </Suspense>
          </ErrorBoundary>
        </div>
      ) : (
      <main key={activeTab} className="flex-1 min-h-0 overflow-y-auto custom-scrollbar">
        <div className="max-w-7xl w-full mx-auto px-4 sm:px-6 lg:px-8 py-4 sm:py-8 pb-36 sm:pb-44 space-y-4 sm:space-y-6">
        {/* Blad jednej zakladki nie zaslania aplikacji; zmiana zakladki zeruje granice. */}
        <ErrorBoundary key={activeTab}>
        <Suspense fallback={<LadowanieWidoku language={language} />}>
        {/* Global Market Statuses Live Bar - statusy z API brokera; w hostingu (telefon) nie ma skad ich wziac. */}
        {!czyTrybHostowany() && <MarketStatusBar />}

        {/* Stan silnika podatkowego: liczy albo nie wystartowal. Bez cichego
            zastepowania wyniku uproszczonym rachunkiem - lepiej powiedziec wprost. */}
        {isCalculating && (
          <div className="flex items-center gap-2 rounded-xl border border-blue-200 bg-blue-50/70 px-4 py-2.5 text-sm text-blue-800 dark:border-blue-800 dark:bg-blue-950/40 dark:text-blue-300">
            <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-blue-500 border-t-transparent" />
            <span className="font-semibold">Silnik podatkowy przelicza rozliczenie…</span>
            <span className="text-blue-700/80 dark:text-blue-400/80">FIFO, kursy NBP T-1 i bramki jakości</span>
          </div>
        )}
        {/* Wersja hostowana (telefon): brak silnika to stan zwykly, nie awaria -
            spokojna informacja zamiast czerwonego bledu z przyciskiem ponowienia. */}
        {trybHostowany && !informacjaHostinguUkryta && (
          <div role="status" className="flex items-start gap-3 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600 dark:border-slate-700 dark:bg-slate-900/60 dark:text-slate-300">
            <div className="min-w-0 flex-1">
              <span className="font-bold text-slate-800 dark:text-slate-100">Wersja na telefon.</span>{' '}
              Portfel, notowania, wykresy i alerty działają tutaj; dane zostają na tym urządzeniu. Rozliczenie PIT-38
              i import plików brokera liczy wersja Windows.
            </div>
            <button
              type="button"
              onClick={ukryjInformacjeHostingu}
              className="shrink-0 min-h-9 min-w-9 -mr-1 -my-1 rounded-lg px-2 text-xs font-semibold text-slate-500 hover:bg-slate-200/70 dark:text-slate-400 dark:hover:bg-slate-800"
              aria-label="Ukryj informację o wersji na telefon"
            >
              OK
            </button>
          </div>
        )}
        {engineError && !isCalculating && !czyOdmowaHostingu(engineError) && (
          <div className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800 dark:border-rose-800 dark:bg-rose-950/40 dark:text-rose-300">
            <div className="font-bold">Silnik podatkowy nie przeliczył rozliczenia</div>
            <div className="mt-1 font-mono text-[11px] break-words opacity-90">{engineError}</div>
            <button
              type="button"
              onClick={() => setWymuszeniePrzeliczenia((n) => n + 1)}
              className="mt-2 mr-2 rounded-lg bg-rose-600 px-3 py-1.5 text-xs font-bold text-white transition hover:bg-rose-500"
            >
              Przelicz ponownie
            </button>
            <button
              type="button"
              onClick={() => setActiveTab('engine')}
              className="mt-2 rounded-lg bg-rose-600 px-3 py-1.5 text-xs font-bold text-white transition hover:bg-rose-500"
            >
              Otwórz „Dokumenty i silnik”
            </button>
          </div>
        )}
        {taxFreshness.stale && (
          <div role="status" className="rounded-xl border border-amber-300 bg-amber-50 px-4 py-2 text-sm font-bold text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
            NIEAKTUALNE — poprzednie kwoty nie opisują bieżących danych. Przelicz ponownie przed eksportem.
          </div>
        )}

        {/* Skad pochodza liczby na zakladkach Portfel / PIT-38 / Transakcje. */}
        {!isCalculating && !engineError && transakcjeSilnika === null && (
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
            <div>
              <div className="font-bold">Silnik nie policzył jeszcze roku {selectedYear}</div>
              <div className="mt-0.5 text-xs opacity-90">
                Kwoty PIT-38 i pozycje pokazują „—”, dopóki nie ma przebiegu silnika. To nie znaczy, że podatek wynosi zero.
              </div>
            </div>
            <button
              type="button"
              onClick={() => setWymuszeniePrzeliczenia((n) => n + 1)}
              className="rounded-lg bg-amber-700 px-3 py-1.5 text-xs font-bold text-white transition hover:bg-amber-800"
            >
              Przelicz
            </button>
          </div>
        )}
        {/* Hosting (telefon): pozycje z rachunku w przegladarce, nie z silnika - inny opis, bez przycisku silnika. */}
        {/* Tylko tam, gdzie pozycje maja znaczenie (portfel, PIT-38, rejestr) - na telefonie kazda karta u gory kosztuje ekran. */}
        {!isCalculating && transakcjeSilnika !== null && trybHostowany && ['portfolio', 'tax', 'transactions'].includes(activeTab) && (
          <div className="flex items-center justify-between gap-3 rounded-xl border border-slate-200 bg-white px-3 py-2 text-[11px] sm:text-xs text-slate-600 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-300">
            <div className="min-w-0 leading-snug">
              <span className="font-semibold text-slate-900 dark:text-white">Źródło: rachunek w przeglądarce</span>
              {' · '}FIFO z {transakcjeSilnika.length} {odmienLiczebnik(transakcjeSilnika.length, 'transakcji', 'transakcji', 'transakcji')}, kursy NBP T-1
              {pominieteBezDanych > 0 && <> · {pominieteBezDanych} {odmienLiczebnik(pominieteBezDanych, 'partia bez kursu', 'partie bez kursu', 'partii bez kursu')}</>}
            </div>
            <button
              type="button"
              onClick={() => setWymuszeniePrzeliczenia((n) => n + 1)}
              className="shrink-0 min-h-9 rounded-lg border border-slate-300 px-2.5 py-1 font-semibold text-slate-700 transition hover:bg-slate-100 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800"
            >
              Przelicz
            </button>
          </div>
        )}
        {!isCalculating && transakcjeSilnika !== null && !trybHostowany && (
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-xs text-slate-600 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-300">
            <div>
              <span className="font-semibold text-slate-900 dark:text-white">Źródło: przebieg silnika za {selectedYear}</span>
              {' · '}
              {licznikiSilnika.BUY} {odmienLiczebnik(licznikiSilnika.BUY, 'zakup', 'zakupy', 'zakupów')},{' '}
              {licznikiSilnika.SELL} {odmienLiczebnik(licznikiSilnika.SELL, 'sprzedaż', 'sprzedaże', 'sprzedaży')},{' '}
              {licznikiSilnika.DIVIDEND} {odmienLiczebnik(licznikiSilnika.DIVIDEND, 'dywidenda', 'dywidendy', 'dywidend')} z dokumentów w magazynie
              {podzialLokalnych.doSilnika.length > 0 && <> · {podzialLokalnych.doSilnika.length} {odmienLiczebnik(podzialLokalnych.doSilnika.length, 'wpis ręczny', 'wpisy ręczne', 'wpisów ręcznych')} w rozliczeniu</>}
              {taxResult.gotoweDoZlozenia === false && (
                <span className="ml-1 font-semibold text-amber-700 dark:text-amber-300">
                  {' '}· silnik: rozliczenie NIE jest gotowe do złożenia (szczegóły w „Dokumenty i silnik”)
                </span>
              )}
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setActiveTab('engine')}
                className="rounded-lg border border-slate-300 px-3 py-1.5 font-semibold transition hover:bg-slate-100 dark:border-slate-700 dark:hover:bg-slate-800"
              >
                Dokumenty i silnik
              </button>
              <button
                type="button"
                onClick={() => setWymuszeniePrzeliczenia((n) => n + 1)}
                className="rounded-lg bg-blue-600 px-3 py-1.5 font-bold text-white transition hover:bg-blue-500"
              >
                Przelicz ponownie
              </button>
            </div>
          </div>
        )}
        {(pominieteBezDanych > 0 || podzialLokalnych.pominiete.some((p) => p.powod !== 'KOPIA_Z_API_BROKERA')) && (
          <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-xs text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
            {pominieteBezDanych > 0 && (
              <div>
                Pominięto na liście: {pominieteBezDanych} {odmienLiczebnik(pominieteBezDanych, 'wiersz', 'wiersze', 'wierszy')} z przebiegu silnika bez ilości, kwoty albo waluty
                (bez zgadywania wartości).
              </div>
            )}
            {podzialLokalnych.pominiete
              .filter((p) => p.powod !== 'KOPIA_Z_API_BROKERA')
              .slice(0, 5)
              .map((p) => (
                <div key={p.transakcja.id}>
                  <span className="font-semibold">
                    {p.transakcja.ticker || '(bez waloru)'} · {p.transakcja.type} · {p.transakcja.date.slice(0, 10)}
                  </span>{' '}
                  nie wchodzi do rozliczenia: {p.opis}
                </div>
              ))}
          </div>
        )}
        {activeTab === 'portfolio' && rozbieznosciZBrokerem.length > 0 && (
          <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-xs text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
            <div className="text-sm font-bold">Stan rachunku Freedom24 różni się od pozycji wynikających z transakcji</div>
            {rozbieznosciZBrokerem.map((r) => (
              <div key={`${r.ticker}-${r.rodzaj}`} className="mt-1">
                {r.opis}
              </div>
            ))}
          </div>
        )}
        {activeTab === 'portfolio' && pozycjeBrokera !== null && transakcjeSilnika !== null && rozbieznosciZBrokerem.length === 0 && pozycjeBrokera.length > 0 && (
          <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-2 text-xs text-emerald-900 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-200">
            Pozycje z transakcji zgadzają się ze stanem rachunku Freedom24 ({pozycjeBrokera.length} poz.).
          </div>
        )}

        {/* Main View: Portfel (Portfolio) */}
        {activeTab === 'portfolio' && (
          <PortfolioDashboard
            openPositions={taxResult.openPositions}
            cenyBrokera={cenyBrokera}
            danePozycjiNieznane={isCalculating || transakcjeSilnika === null}
            quotes={quotes}
            accounts={accounts}
            yearSummaries={taxResult.yearSummaries}
            selectedYear={selectedYear}
            onSelectYear={setSelectedYear}
            language={language}
            onRefreshQuotes={handleRefreshQuotes}
            isRefreshingQuotes={isRefreshingQuotes}
            onQuickAddTransaction={handleQuickAddWithPrefill}
            onInstantClosePosition={handleInstantClosePosition}
            onQuickImport={() => setShowImportModal(true)}
            onOpenPriceAlert={(ticker, accountId) => {
              if (ticker) {
                setSelectedAlertTicker(ticker);
                setSelectedAlertAccountId(accountId);
                setActiveTab('alerts');
              } else {
                setSelectedAlertTicker(undefined);
                setSelectedAlertAccountId(undefined);
                setActiveTab('alerts');
              }
            }}
            onNavigateToTab={(tab) => setActiveTab(tab)}
            onSelectTickerForChart={handleSelectTickerForChart}
            favorites={favorites}
            onToggleFavorite={handleToggleFavorite}
          />
        )}

        {activeTab === 'tax' && (
          <div className="space-y-6">
            <TaxDashboard
              gotoweDoZlozenia={taxResult.gotoweDoZlozenia}
              yearSummaries={taxFreshness.sameYear ? taxResult.yearSummaries : new Map()}
              resultStale={taxFreshness.stale}
              canExport={taxFreshness.canExport}
              selectedYear={selectedYear}
              setSelectedYear={setSelectedYear}
              realizedGains={taxResult.realizedGains}
              dividends={taxResult.dividends}
              accounts={accounts}
              transactions={transakcjeDoListy}
              language={language}
              onSyncAllApis={handleSyncAllApis}
              isSyncing={isSyncing}
              onOpenFifoDetails={() => setShowFifoDetails(!showFifoDetails)}
              onQuickAddTransaction={() => {
                setEditingTx(null);
                setShowAddTxModal(true);
              }}
              onQuickImport={() => setShowImportModal(true)}
              onNavigateToTab={(tab) => setActiveTab(tab as any)}
            />

            <OptymalizacjaPanel
              language={language}
              selectedYear={selectedYear}
              onZmiana={() => window.dispatchEvent(new Event('tax-input-changed'))}
            />

            {/* FIFO Details Schedule */}
            <FifoDetailsTable
              realizedGains={taxResult.realizedGains}
              selectedYear={selectedYear}
              accounts={accounts}
              language={language}
            />
          </div>
        )}

        {activeTab === 'transactions' && (
          <TransactionHistory
            transactions={transakcjeDoListy}
            accounts={accounts}
            language={language}
            onAddTransaction={() => {
              setEditingTx(null);
              setShowAddTxModal(true);
            }}
            onImportTransactions={() => setShowImportModal(true)}
            onDeleteTransaction={handleDeleteTransaction}
            onEditTransaction={(tx) => {
              setEditingTx(tx);
              setShowAddTxModal(true);
            }}
            onClearAllTransactions={handleClearAllTransactions}
          />
        )}

        {activeTab === 'brokers' && (
          <BrokerAccountsManager
            accounts={accounts}
            language={language}
            onAddAccount={handleAddAccount}
            onUpdateAccount={handleUpdateAccount}
            onDeleteAccount={handleDeleteAccount}
            onSyncAccount={handleSyncAccount}
            onSyncAllAccounts={handleSyncAllAccounts}
            onImportTransactions={handleImportTransactions}
            onClearAllTransactions={handleClearAllTransactions}
            onResetAllData={handleResetAllData}
            syncingAccountId={syncingAccountId}
            isSyncingAll={isSyncing}
          />
        )}

        {activeTab === 'charts' && (
          <RealTimeCharts
            quotes={quotes}
            cenyBrokera={cenyBrokera}
            realizedGains={taxResult.realizedGains}
            openPositions={selectedAlertAccountId
              ? pozycjeNaRachunku(taxResult.openPositions, selectedAlertAccountId)
              : taxResult.openPositions.filter((position) => !position.accountIds.includes(RACHUNEK_NIEUSTALONY))}
            accounts={accounts}
            language={language}
            onSetAlertForTicker={(ticker) => {
              setSelectedAlertTicker(ticker);
              setActiveTab('alerts');
            }}
            favorites={favorites}
            onToggleFavorite={handleToggleFavorite}
            onOpenManageFavorites={() => setShowManageFavoritesModal(true)}
            selectedTickerProp={selectedTickerForChart}
          />
        )}

        {activeTab === 'alerts' && (
          <PriceAlertsModal
            alerts={alerts}
            quotes={quotes}
            openPositions={taxResult.openPositions}
            accounts={accounts}
            brokerOrders={brokerOrders}
            language={language}
            initialTicker={selectedAlertTicker}
            initialAccountId={selectedAlertAccountId}
            onAddAlert={handleAddAlert}
            onUpdateAlert={handleUpdateAlert}
            onDeleteAlert={handleDeleteAlert}
            onToggleAlert={handleToggleAlert}
            onSelectTickerForChart={handleSelectTickerForChart}
            onCreateBrokerOrder={handleCreateBrokerOrder}
            onCheckBinanceOrder={(account, ticker, clientOrderId) => brokerApiService.checkBinanceOrder(account, ticker, clientOrderId)}
            onCancelBrokerOrder={handleCancelBrokerOrder}
          />
        )}

        {activeTab === 'security' && (
          <TwoFactorAuthModal
            twoFactor={twoFactor}
            language={language}
            onToggle2FA={handleToggle2FA}
            onVerifyAndUnlock={handleUnlockSession}
            onLockSession={handleLockSession}
          />
        )}
        </Suspense>
        </ErrorBoundary>
        </div>

        {/* Stopka widoczna tylko w zakladce PIT-38 */}
        {activeTab === 'tax' && (
          <footer className="w-full border-t border-slate-200 dark:border-slate-800 bg-white/70 dark:bg-slate-900/70 py-6 mb-24 text-center text-xs text-slate-500 dark:text-slate-400">
            <div className="max-w-7xl mx-auto px-4 flex flex-col sm:flex-row items-center justify-between gap-2">
              <div>
                Kalkulator Podatku Giełdowego PIT-38 • Zgodny z ustawą o podatku dochodowym od osób fizycznych
              </div>
              <div className="font-mono text-[11px] text-slate-400">
                Kursy NBP T-1 • Realne Notowania Giełdowe • Silnik FIFO w Pythonie
              </div>
            </div>
          </footer>
        )}
      </main>
      )}

      {/* Primary Bottom Navigation Bar (Options selected from the bottom) */}
      <BottomNavbar
        activeTab={activeTab}
        setActiveTab={setActiveTab}
        language={language}
        setLanguage={setLanguage}
        theme={theme}
        setTheme={setTheme}
        transactionCount={transakcjeDoListy.length}
        brokerCount={accounts.length}
        alertCount={alerts.filter((a) => a.isActive).length}
        openPositionsCount={taxResult.openPositions.length}
        notifications={notifications}
        onMarkNotificationRead={(id) => pushNotificationService.markAsRead(id)}
        onClearNotifications={() => pushNotificationService.clearAll()}
        twoFactor={twoFactor}
        onLockSession={handleLockSession}
        onUnlockModalOpen={handleLockSession}
        onQuickAddTransaction={() => {
          setEditingTx(null);
          setShowAddTxModal(true);
        }}
      />

      {/* Nieudane doczytanie okna nie moze zabierac nawigacji calej aplikacji. */}
      {(showManageFavoritesModal || showAddTxModal || showImportModal) && (
      <ErrorBoundary onDismiss={zamknijOkna}>
      <Suspense fallback={<OczekiwanieNaOkno onClose={zamknijOkna} language={language} />}>
      {/* Montowany dopiero po otwarciu: zamkniety i tak nic nie rysuje, a samo
          wyrenderowanie leniwego komponentu pobieralo jego kod przy starcie. */}
      {showManageFavoritesModal && (
        <ManageFavoritesModal
          isOpen
          onClose={() => setShowManageFavoritesModal(false)}
          favorites={favorites}
          quotes={quotes}
          onToggleFavorite={handleToggleFavorite}
          onSetFavorites={handleSetFavorites}
        />
      )}

      {/* Add / Edit Transaction Modal */}
      {showAddTxModal && (
        <AddTransactionModal
          accounts={accounts}
          language={language}
          editingTransaction={editingTx}
          onSave={handleSaveTransaction}
          onClose={() => {
            setShowAddTxModal(false);
            setEditingTx(null);
          }}
        />
      )}

      {/* Import Modal */}
      {showImportModal && (
        <ImportTransactionsModal
          accounts={accounts}
          language={language}
          onImport={handleImportTransactions}
          onClose={() => setShowImportModal(false)}
        />
      )}
      </Suspense>
      </ErrorBoundary>
      )}
    </div>
  );
}
