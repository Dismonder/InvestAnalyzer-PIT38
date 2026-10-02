import React from 'react';
import {
  RefreshCw,
  PlusCircle,
  Trash2,
} from 'lucide-react';
import { Language } from '../types';
import {
  UstawieniaOptymalizacji,
  POZYCJE_KOSZTOWE,
  odczytajUstawienia,
  zapiszUstawienia,
  zapiszZmianeUstawien,
  liczbaAktywnychPozycji,
  przywrocMaksymalnaOptymalizacje,
  PlanPodatkowy,
} from '../services/optymalizacjaPodatkowa';
import { nowyWpisPit8c, poprawnaKwotaPit8c } from '../services/pit8c';
import { firstUnusedPriorLossYear, isPriorLossYearAvailable, readCryptoCostsForYear, readLegacyCryptoCosts, saveCryptoCostsForYear } from '../../invest_analyzer/services/taxEngineConfig';
import { readTaxYearClosure } from '../../invest_analyzer/services/yearClosure';
import { odczytajWynikSilnika, subskrybujWynikSilnika } from '../../invest_analyzer/services/ostatniWynikSilnika';

export interface OptymalizacjaPanelProps {
  language: Language;
  selectedYear?: number;
  onZmiana?: (u: UstawieniaOptymalizacji) => void;
}

export const OptymalizacjaPanel: React.FC<OptymalizacjaPanelProps> = ({ language, onZmiana, selectedYear = new Date().getFullYear() - 1 }) => {
  const [ustawienia, setUstawienia] = React.useState<UstawieniaOptymalizacji>(() => odczytajUstawienia());
  const bazaRef = React.useRef(ustawienia);
  React.useEffect(() => {
    const odswiez = () => { const aktualne = odczytajUstawienia(); bazaRef.current = aktualne; setUstawienia(aktualne); };
    const storage = (event: StorageEvent) => { if (!event.key || event.key === 'pit38_optymalizacja') odswiez(); };
    window.addEventListener('storage', storage);
    window.addEventListener('tax-input-changed', odswiez);
    return () => { window.removeEventListener('storage', storage); window.removeEventListener('tax-input-changed', odswiez); };
  }, []);
  const [cryptoCost, setCryptoCost] = React.useState(() => readCryptoCostsForYear(localStorage, selectedYear));
  const [, setResultVersion] = React.useState(0);
  React.useEffect(() => setCryptoCost(readCryptoCostsForYear(localStorage, selectedYear)), [selectedYear]);
  React.useEffect(() => subskrybujWynikSilnika(() => setResultVersion((version) => version + 1)), []);
  const closure = readTaxYearClosure(localStorage, selectedYear);
  const isClosed = closure?.status === 'closed' || closure?.status === 'submitted';
  const legacyCryptoCost = readLegacyCryptoCosts(localStorage) || ustawienia.kosztyKryptoZLatUbieglych.trim();
  const previousResult = odczytajWynikSilnika(selectedYear - 1)?.odpowiedz as
    | { crypto_part_e?: { costs_carried_out_pln?: string | number } } | undefined;
  const previousCarry = previousResult?.crypto_part_e?.costs_carried_out_pln;

  const updateUstawienia = React.useCallback((nowe: Partial<UstawieniaOptymalizacji>) => {
    if ('stratyZLatUbieglych' in nowe && isClosed) return;
    setUstawienia(() => {
      const u = zapiszZmianeUstawien(nowe);
      bazaRef.current = u;
      onZmiana?.(u);
      return u;
    });
  }, [onZmiana, isClosed]);

  // Nowy obiekt wpisu zamiast `n[idx].pole = ...`: kopia tablicy byla plytka,
  // wiec przypisanie zmienialo obiekt z poprzedniego stanu (i ten przekazany
  // wczesniej przez onZmiana).
  const zmienOplate = (idx: number, zmiana: Partial<UstawieniaOptymalizacji['oplatyFinansowania'][number]>) => {
    updateUstawienia({
      oplatyFinansowania: ustawienia.oplatyFinansowania.map((oplata, i) => (i === idx ? { ...oplata, ...zmiana } : oplata)),
    });
  };

  const saveCryptoCost = (amount: string) => {
    if (isClosed) return;
    setCryptoCost(amount);
    saveCryptoCostsForYear(localStorage, selectedYear, amount);
    onZmiana?.(ustawienia);
  };

  const handlePrzywroc = () => {
    updateUstawienia(przywrocMaksymalnaOptymalizacje(ustawienia));
  };

  const aktywnych = liczbaAktywnychPozycji(ustawienia);

  const riskColors = {
    niskie: 'bg-emerald-50 text-emerald-700 ring-emerald-600/20 dark:bg-emerald-900/30 dark:text-emerald-400',
    srednie: 'bg-amber-50 text-amber-700 ring-amber-600/20 dark:bg-amber-900/30 dark:text-amber-400',
    wyzsze: 'bg-rose-50 text-rose-700 ring-rose-600/20 dark:bg-rose-900/30 dark:text-rose-400',
  };
  const ETYKIETY_RYZYKA = { niskie: 'niskie', srednie: 'średnie', wyzsze: 'wyższe' } as const;

  return (
    <div className="space-y-6">
      {/* 1. Nagłówek */}
      <div className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 shadow-sm p-5 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-bold text-slate-900 dark:text-white">Optymalizacja Podatkowa</h2>
          <p className="text-sm text-slate-500 dark:text-slate-400 mt-1">Aktywne pozycje kosztowe: <strong className="text-slate-900 dark:text-white">{aktywnych}</strong></p>
        </div>
        <button onClick={handlePrzywroc} className="rounded-xl px-4 py-2 text-sm font-semibold border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 transition flex items-center gap-2">
          <RefreshCw className="w-4 h-4" />
          Przywróć maksymalną optymalizację
        </button>
      </div>

      {/* 2. Plany */}
      <div className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 shadow-sm p-5 space-y-4">
        <h3 className="font-semibold text-slate-900 dark:text-white">Plan optymalizacji silnika</h3>
        <div className="flex flex-wrap gap-2">
          {(['aggressive_user', 'balanced_user', 'conservative_user'] as PlanPodatkowy[]).map((plan) => (
            <button
              key={plan}
              onClick={() => updateUstawienia({ plan })}
              className={`rounded-xl px-4 py-2 text-sm font-semibold transition ${ustawienia.plan === plan ? 'bg-blue-600 text-white hover:bg-blue-500' : 'border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800'}`}
            >
              {plan === 'aggressive_user' ? 'Agresywny' : plan === 'balanced_user' ? 'Zrównoważony' : 'Konserwatywny'}
            </button>
          ))}
        </div>
        <p className="text-sm text-slate-500 dark:text-slate-400">
          Wybór planu decyduje, jak silnik kwalifikuje domyślne pozycje przed zaaplikowaniem ręcznych wyjątków.
        </p>
      </div>

      {/* 3. Lista przełączników */}
      <div className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 shadow-sm p-5 space-y-4">
        <h3 className="font-semibold text-slate-900 dark:text-white">Koszty uzyskania przychodu (KUP)</h3>
        <div className="space-y-3">
          {POZYCJE_KOSZTOWE.map((pozycja) => (
            <label key={pozycja.klucz} className="flex items-start gap-4 p-4 border border-slate-200 dark:border-slate-700 rounded-xl cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-800/50 transition">
              <input
                type="checkbox"
                checked={ustawienia[pozycja.klucz]}
                onChange={(e) => updateUstawienia({ [pozycja.klucz]: e.target.checked })}
                className="mt-1.5 w-4 h-4 rounded border-slate-300 text-blue-600 focus:ring-blue-600"
              />
              <div className="flex-1 space-y-1">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-medium text-slate-900 dark:text-white">{pozycja.nazwa}</span>
                  <span className={`inline-flex items-center rounded-full px-2.5 py-1 text-xs font-semibold ring-1 ${riskColors[pozycja.ryzyko]}`}>
                    Ryzyko: {ETYKIETY_RYZYKA[pozycja.ryzyko]}
                  </span>
                </div>
                <p className="text-sm text-slate-500 dark:text-slate-400">{pozycja.opis}</p>
                <p className="text-xs text-slate-400 font-mono mt-1">Podstawa: {pozycja.podstawa}</p>
              </div>
            </label>
          ))}
        </div>
      </div>

      {/* 4. Formularz W-8BEN */}
      <div className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 shadow-sm p-5">
        <div>
          <div>
            <span className="font-medium text-slate-900 dark:text-white">Informacja o formularzu W-8BEN</span>
            <p className="text-sm text-slate-500 dark:text-slate-400 mt-1">Z formularzem USA pobiera 15% i całość jest odliczalna w Polsce; bez niego pobiera 30%, a odliczyć można tylko 15% - resztę odzyskuje się od amerykańskiego urzędu.</p>
            <p className="text-sm text-slate-500 dark:text-slate-400 mt-1">Rozliczenie opiera się na faktycznie pobranym podatku i limicie stawki umownej.</p>
          </div>
        </div>
      </div>

      {/* 5. Koszty finansowania */}
      <div className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 shadow-sm p-5 space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <h3 className="font-semibold text-slate-900 dark:text-white">Opłaty z tytułu finansowania</h3>
          <button
            onClick={() => updateUstawienia({
              oplatyFinansowania: [...ustawienia.oplatyFinansowania, { id: Date.now().toString(), amount: '0', currency: 'PLN', date: '', depositId: '', depositAmount: '0', evidenceNote: '' }]
            })}
            className="rounded-xl px-4 py-2 text-sm font-semibold border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 transition flex items-center gap-2 self-start sm:self-auto"
          >
            <PlusCircle className="w-4 h-4" /> Dodaj wpis
          </button>
        </div>
        {ustawienia.oplatyFinansowania.map((oplata, idx) => (
          <div key={oplata.id || idx} className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-6 gap-3 items-center p-4 border border-slate-200 dark:border-slate-700 rounded-xl bg-slate-50 dark:bg-slate-800/20">
            <label className="flex flex-col gap-1 text-xs text-slate-600 dark:text-slate-300">Kwota opłaty<input type="text" value={oplata.amount} onChange={(e) => { zmienOplate(idx, { amount: e.target.value }); }} className="w-full border border-slate-300 dark:border-slate-600 rounded-lg p-2 text-sm bg-white dark:bg-slate-900 text-slate-900 dark:text-white" placeholder="Kwota (np. 120,50)" /></label>
            <label className="flex flex-col gap-1 text-xs text-slate-600 dark:text-slate-300">Waluta<input type="text" value={oplata.currency} onChange={(e) => { zmienOplate(idx, { currency: e.target.value }); }} className="w-full border border-slate-300 dark:border-slate-600 rounded-lg p-2 text-sm bg-white dark:bg-slate-900 text-slate-900 dark:text-white" placeholder="Waluta" /></label>
            <label className="flex flex-col gap-1 text-xs text-slate-600 dark:text-slate-300">Data<input type="date" value={oplata.date} onChange={(e) => { zmienOplate(idx, { date: e.target.value }); }} className="w-full border border-slate-300 dark:border-slate-600 rounded-lg p-2 text-sm bg-white dark:bg-slate-900 text-slate-900 dark:text-white" /></label>
            <label className="flex flex-col gap-1 text-xs text-slate-600 dark:text-slate-300">ID depozytu<input type="text" value={oplata.depositId || ''} onChange={(e) => { zmienOplate(idx, { depositId: e.target.value }); }} className="w-full border border-slate-300 dark:border-slate-600 rounded-lg p-2 text-sm bg-white dark:bg-slate-900 text-slate-900 dark:text-white" placeholder="ID Depozytu" /></label>
            <label className="flex flex-col gap-1 text-xs text-slate-600 dark:text-slate-300">Kwota depozytu<input type="text" value={oplata.depositAmount || ''} onChange={(e) => { zmienOplate(idx, { depositAmount: e.target.value }); }} className="w-full border border-slate-300 dark:border-slate-600 rounded-lg p-2 text-sm bg-white dark:bg-slate-900 text-slate-900 dark:text-white" placeholder="Kwota depozytu" /></label>
            <div className="flex gap-2 items-end">
              <label className="flex flex-col gap-1 text-xs text-slate-600 dark:text-slate-300 flex-1 min-w-0">Notatka<input type="text" value={oplata.evidenceNote || ''} onChange={(e) => { zmienOplate(idx, { evidenceNote: e.target.value }); }} className="w-full border border-slate-300 dark:border-slate-600 rounded-lg p-2 text-sm bg-white dark:bg-slate-900 text-slate-900 dark:text-white flex-1 min-w-0" placeholder="Notatka" /></label>
              <button onClick={() => { const n = [...ustawienia.oplatyFinansowania]; n.splice(idx, 1); updateUstawienia({ oplatyFinansowania: n }); }} className="p-2 text-rose-600 hover:bg-rose-50 dark:hover:bg-rose-900/30 rounded-lg transition shrink-0" title="Usuń"><Trash2 className="w-5 h-5" /></button>
            </div>
          </div>
        ))}
      </div>

      {/* 6. Straty z lat ubiegłych */}
      <div className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 shadow-sm p-5 space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <h3 className="font-semibold text-slate-900 dark:text-white">Straty z lat ubiegłych</h3>
          <button
            disabled={isClosed || firstUnusedPriorLossYear(ustawienia.stratyZLatUbieglych, selectedYear) === undefined}
            onClick={() => {
              const freeYear = firstUnusedPriorLossYear(ustawienia.stratyZLatUbieglych, selectedYear);
              if (freeYear !== undefined) updateUstawienia({
                stratyZLatUbieglych: [...ustawienia.stratyZLatUbieglych, { id: Date.now().toString(), taxYear: freeYear, amountPln: '' }]
              });
            }}
            className="rounded-xl px-4 py-2 text-sm font-semibold border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 transition flex items-center gap-2 self-start sm:self-auto"
          >
            <PlusCircle className="w-4 h-4" /> Dodaj stratę
          </button>
        </div>
        {isClosed && <p className="text-xs text-amber-700">Otwórz rok ponownie, aby zmienić straty z lat ubiegłych.</p>}
        {ustawienia.stratyZLatUbieglych.map((strata, idx) => (
          <div key={strata.id || idx} className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-3 items-end p-4 border border-slate-200 dark:border-slate-700 rounded-xl bg-slate-50 dark:bg-slate-800/20">
            <label className="flex flex-col gap-1 text-xs text-slate-600 dark:text-slate-300">Rok straty<input type="number" disabled={isClosed} value={strata.taxYear} onChange={(e) => { const year = Number(e.target.value); if (!isPriorLossYearAvailable(ustawienia.stratyZLatUbieglych, year, idx)) return; const n = [...ustawienia.stratyZLatUbieglych]; n[idx] = { ...strata, taxYear: year }; updateUstawienia({ stratyZLatUbieglych: n }); }} className="w-full border border-slate-300 dark:border-slate-600 rounded-lg p-2 text-sm bg-white dark:bg-slate-900 text-slate-900 dark:text-white" placeholder="Rok podatkowy" /></label>
            <label className="flex flex-col gap-1 text-xs text-slate-600 dark:text-slate-300">Kwota straty (PLN)<input type="text" disabled={isClosed} value={strata.amountPln} onChange={(e) => { const n = [...ustawienia.stratyZLatUbieglych]; n[idx] = { ...strata, amountPln: e.target.value }; updateUstawienia({ stratyZLatUbieglych: n }); }} className="w-full border border-slate-300 dark:border-slate-600 rounded-lg p-2 text-sm bg-white dark:bg-slate-900 text-slate-900 dark:text-white" placeholder="Kwota (PLN)" /></label>
            <label className="text-xs text-slate-600 dark:text-slate-300">Pozostało do odliczenia (po zeznaniach za lata poprzednie)
              <input type="text" inputMode="decimal" disabled={isClosed} value={strata.remainingPln ?? ''} onChange={(e) => { const n = [...ustawienia.stratyZLatUbieglych]; n[idx] = { ...strata, remainingPln: e.target.value }; updateUstawienia({ stratyZLatUbieglych: n }); }} className="block w-full border border-slate-300 dark:border-slate-600 rounded-lg p-2 text-sm bg-white dark:bg-slate-900 text-slate-900 dark:text-white" placeholder="Potwierdź saldo" />
            </label>
            <div className="flex justify-end">
              <button disabled={isClosed} onClick={() => { const n = [...ustawienia.stratyZLatUbieglych]; n.splice(idx, 1); updateUstawienia({ stratyZLatUbieglych: n }); }} className="p-2 text-rose-600 hover:bg-rose-50 dark:hover:bg-rose-900/30 rounded-lg transition" title="Usuń"><Trash2 className="w-5 h-5" /></button>
            </div>
          </div>
        ))}
      </div>

      {/* 7. Informacje PIT-8C (poz. 20 i 21) */}
      <div className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 shadow-sm p-5 space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-4">
          <div>
            <h3 className="font-semibold text-slate-900 dark:text-white">Informacje PIT-8C</h3>
            <p className="mt-1 text-sm text-slate-500 dark:text-slate-400 leading-relaxed">
              Do poz. 20 i 21 zeznania wpisuje się kwoty z poz. 35 i 36 otrzymanej informacji
              PIT-8C, a nie wynik własnego rachunku — to je urząd porównuje z zeznaniem.
              Bez wpisu aplikacja policzy tę część z transakcji na rachunkach polskich brokerów
              i oznaczy ją jako wyliczoną. Kilka informacji za ten sam rok sumuje się.
            </p>
          </div>
          <button
            onClick={() => updateUstawienia({
              informacjePit8c: [
                ...ustawienia.informacjePit8c,
                nowyWpisPit8c(selectedYear, Date.now().toString()),
              ],
            })}
            className="rounded-xl px-4 py-2 text-sm font-semibold border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 transition flex items-center gap-2 self-start sm:self-auto shrink-0"
          >
            <PlusCircle className="w-4 h-4" /> Dodaj PIT-8C
          </button>
        </div>
        {ustawienia.informacjePit8c.map((wpis, idx) => (
          <div key={wpis.id || idx} className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-5 gap-3 items-center p-4 border border-slate-200 dark:border-slate-700 rounded-xl bg-slate-50 dark:bg-slate-800/20">
            <label className="flex flex-col gap-1 text-xs text-slate-600 dark:text-slate-300">Rok podatkowy<input type="number" value={wpis.taxYear} onChange={(e) => { const n = [...ustawienia.informacjePit8c]; n[idx] = { ...n[idx], taxYear: Number(e.target.value) }; updateUstawienia({ informacjePit8c: n }); }} className="w-full border border-slate-300 dark:border-slate-600 rounded-lg p-2 text-sm bg-white dark:bg-slate-900 text-slate-900 dark:text-white" placeholder="Rok podatkowy" /></label>
            <label className="flex flex-col gap-1 text-xs text-slate-600 dark:text-slate-300">Wystawca<input type="text" value={wpis.issuer || ''} onChange={(e) => { const n = [...ustawienia.informacjePit8c]; n[idx] = { ...n[idx], issuer: e.target.value }; updateUstawienia({ informacjePit8c: n }); }} className="w-full border border-slate-300 dark:border-slate-600 rounded-lg p-2 text-sm bg-white dark:bg-slate-900 text-slate-900 dark:text-white" placeholder="Wystawca (np. XTB)" /></label>
            <label className="flex flex-col gap-1 text-xs text-slate-600 dark:text-slate-300">Poz. 35 — przychód<input type="text" inputMode="decimal" value={wpis.revenuePln} onChange={(e) => { const n = [...ustawienia.informacjePit8c]; n[idx] = { ...n[idx], revenuePln: e.target.value }; updateUstawienia({ informacjePit8c: n }); }} className="w-full border border-slate-300 dark:border-slate-600 rounded-lg p-2 text-sm bg-white dark:bg-slate-900 text-slate-900 dark:text-white font-mono" placeholder="Poz. 35 — przychód" /></label>
            <label className="flex flex-col gap-1 text-xs text-slate-600 dark:text-slate-300">Poz. 36 — koszty<input type="text" inputMode="decimal" value={wpis.costsPln} onChange={(e) => { const n = [...ustawienia.informacjePit8c]; n[idx] = { ...n[idx], costsPln: e.target.value }; updateUstawienia({ informacjePit8c: n }); }} className="w-full border border-slate-300 dark:border-slate-600 rounded-lg p-2 text-sm bg-white dark:bg-slate-900 text-slate-900 dark:text-white font-mono" placeholder="Poz. 36 — koszty" /></label>
            {(!poprawnaKwotaPit8c(wpis.revenuePln) || !poprawnaKwotaPit8c(wpis.costsPln)) && (
              <p className="text-xs font-semibold text-rose-700 dark:text-rose-300 sm:col-span-2 md:col-span-4" role="alert">
                Wpis PIT-8C jest niepełny lub nieprawidłowy — nie zostanie użyty; silnik zablokuje rozliczenie, dopóki go nie poprawisz.
              </p>
            )}
            <div className="flex justify-end">
              <button onClick={() => { const n = [...ustawienia.informacjePit8c]; n.splice(idx, 1); updateUstawienia({ informacjePit8c: n }); }} className="p-2 text-rose-600 hover:bg-rose-50 dark:hover:bg-rose-900/30 rounded-lg transition" title="Usuń"><Trash2 className="w-5 h-5" /></button>
            </div>
          </div>
        ))}
      </div>

      {/* 8. Koszty krypto z lat ubiegłych (część E) */}
      <div className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 shadow-sm p-5 space-y-3">
        <h3 className="font-semibold text-slate-900 dark:text-white">
          Koszty nabycia krypto z lat ubiegłych
        </h3>
        <p className="text-sm text-slate-500 dark:text-slate-400 leading-relaxed">
          Część E rządzi się inną regułą niż część C: nadwyżka wydatków na nabycie walut
          wirtualnych nad przychodem nie jest stratą, tylko przechodzi na kolejny rok
          (art. 22 ust. 16 ustawy o PIT). Wpisz tu kwotę nieodliczoną w poprzednich latach —
          silnik nie zna rozliczeń sprzed okresu objętego Twoimi plikami. Poz. 38 roku {selectedYear} powinna odpowiadać poz. 40 zeznania za {selectedYear - 1}.
        </p>
        {isClosed && <p className="text-xs text-amber-700">Otwórz rok ponownie, aby zmienić koszt krypto dla tego roku.</p>}
        {legacyCryptoCost && <div role="alert" className="text-sm text-amber-700">
          Dawna kwota bez przypisanego roku: {legacyCryptoCost} PLN. Nie jest używana w obliczeniach.
          <button type="button" disabled={isClosed} onClick={() => {
            saveCryptoCost(legacyCryptoCost);
            localStorage.setItem('cryptoCostsCarriedForward', '');
            updateUstawienia({ kosztyKryptoZLatUbieglych: '' });
          }} className="ml-2 underline">Przypisz do roku {selectedYear}</button>
        </div>}
        {previousCarry !== undefined && <p className="text-sm text-slate-600 dark:text-slate-300">
          Wynik silnika za {selectedYear - 1}: poz. 40 = {previousCarry} PLN.
          <button type="button" disabled={isClosed} onClick={() => saveCryptoCost(String(previousCarry))} className="ml-2 underline">Użyj tej kwoty dla roku {selectedYear}</button>
        </p>}
        <label className="block text-sm text-slate-700 dark:text-slate-200">Poz. 38 za rok {selectedYear}
        <input
          type="text"
          inputMode="decimal"
          value={cryptoCost}
          disabled={isClosed}
          onChange={(e) => saveCryptoCost(e.target.value)}
          placeholder="np. 12500.00"
          className="w-full sm:w-64 border border-slate-300 dark:border-slate-600 rounded-lg p-2 text-sm bg-white dark:bg-slate-900 text-slate-900 dark:text-white font-mono"
        />
        </label>
      </div>
    </div>
  );
};
