import React, { useState, useEffect, useMemo } from 'react';
import { FileCode2, User, Building, Check, X, ShieldCheck, AlertCircle, CheckCircle2 } from 'lucide-react';
import { TaxYearSummary, TaxRealizedGain, DividendTaxItem } from '../types';
import { exportPit38XML } from '../services/xmlExporter';
import { URZEDY_SKARBOWE, czyKodUrzeduIstnieje, nazwaUrzedu } from '../data/urzedySkarbowe';
import { useZamknijEscape } from '../../shared/useZamknijEscape';

interface TaxpayerConfigModalProps {
  isOpen: boolean;
  onClose: () => void;
  summary: TaxYearSummary;
  realizedGains: TaxRealizedGain[];
  dividends: DividendTaxItem[];
}

function validatePesel(pesel: string): boolean {
  if (!/^\d{11}$/.test(pesel)) return false;
  const weights = [1, 3, 7, 9, 1, 3, 7, 9, 1, 3];
  let sum = 0;
  for (let i = 0; i < 10; i++) {
    sum += parseInt(pesel[i], 10) * weights[i];
  }
  const controlDigit = (10 - (sum % 10)) % 10;
  return controlDigit === parseInt(pesel[10], 10);
}

function validateNip(nip: string): boolean {
  const clean = nip.replace(/[\s-]/g, '');
  if (!/^\d{10}$/.test(clean)) return false;
  const weights = [6, 5, 7, 2, 3, 4, 5, 6, 7];
  let sum = 0;
  for (let i = 0; i < 9; i++) {
    sum += parseInt(clean[i], 10) * weights[i];
  }
  const controlDigit = sum % 11;
  return controlDigit === parseInt(clean[9], 10);
}


export const TaxpayerConfigModal: React.FC<TaxpayerConfigModalProps> = ({
  isOpen,
  onClose,
  summary,
  realizedGains,
  dividends,
}) => {
  const [pesel, setPesel] = useState(() => localStorage.getItem('pit38_taxpayer_pesel') || '');
  const [firstName, setFirstName] = useState(() => localStorage.getItem('pit38_taxpayer_firstName') || '');
  const [lastName, setLastName] = useState(() => localStorage.getItem('pit38_taxpayer_lastName') || '');
  // Bez domyslnego kodu urzedu. Wpisany na sztywno 1436 nie istnieje w
  // slowniku Ministerstwa Finansow, a deklaracja z nieistniejacym kodem nie
  // przechodzi walidacji e-Deklaracji.
  const [taxOfficeCode, setTaxOfficeCode] = useState(
    () => localStorage.getItem('pit38_taxpayer_taxOfficeCode') || ''
  );
  const polePodatnika = (klucz: string) => localStorage.getItem(`pit38_taxpayer_${klucz}`) || '';
  const [birthDate, setBirthDate] = useState(() => polePodatnika('birthDate'));
  const [wojewodztwo, setWojewodztwo] = useState(() => polePodatnika('wojewodztwo'));
  const [powiat, setPowiat] = useState(() => polePodatnika('powiat'));
  const [gmina, setGmina] = useState(() => polePodatnika('gmina'));
  const [ulica, setUlica] = useState(() => polePodatnika('ulica'));
  const [nrDomu, setNrDomu] = useState(() => polePodatnika('nrDomu'));
  const [nrLokalu, setNrLokalu] = useState(() => polePodatnika('nrLokalu'));
  const [miejscowosc, setMiejscowosc] = useState(() => polePodatnika('miejscowosc'));
  const [kodPocztowy, setKodPocztowy] = useState(() => polePodatnika('kodPocztowy'));
  const [isSaved, setIsSaved] = useState(false);
  const [bladDanych, setBladDanych] = useState('');

  useEffect(() => {
    // Wyczyszczone pole musi zniknac tez z magazynu - inaczej stary PESEL
    // czy adres wracal po odswiezeniu, choc formularz pokazywal puste pole.
    const zapisz = (klucz: string, wartosc: string) => {
      if (wartosc) localStorage.setItem(`pit38_taxpayer_${klucz}`, wartosc);
      else localStorage.removeItem(`pit38_taxpayer_${klucz}`);
    };
    zapisz('pesel', pesel);
    zapisz('firstName', firstName);
    zapisz('lastName', lastName);
    zapisz('taxOfficeCode', taxOfficeCode);
    zapisz('birthDate', birthDate);
    zapisz('wojewodztwo', wojewodztwo);
    zapisz('powiat', powiat);
    zapisz('gmina', gmina);
    zapisz('ulica', ulica);
    zapisz('nrDomu', nrDomu);
    zapisz('nrLokalu', nrLokalu);
    zapisz('miejscowosc', miejscowosc);
    zapisz('kodPocztowy', kodPocztowy);
  }, [pesel, firstName, lastName, taxOfficeCode, birthDate, wojewodztwo, powiat, gmina, ulica, nrDomu, nrLokalu, miejscowosc, kodPocztowy]);

  // Kod spoza slownika MF e-Deklaracje odrzuca, wiec mowimy o tym od razu,
  // a nie dopiero przy probie wyslania pliku.
  const statusUrzedu = useMemo(() => {
    const kod = taxOfficeCode.trim();
    if (!kod) return null;
    if (!/^\d{4}$/.test(kod)) return { poprawny: false, opis: 'Kod urzędu ma cztery cyfry' };
    if (!czyKodUrzeduIstnieje(kod)) {
      return { poprawny: false, opis: 'Tego kodu nie ma w słowniku Ministerstwa Finansów' };
    }
    return { poprawny: true, opis: nazwaUrzedu(kod) ?? '' };
  }, [taxOfficeCode]);

  const peselNipStatus = useMemo(() => {
    const trimmed = pesel.trim();
    if (!trimmed) return null;
    if (trimmed.length === 11) {
      const isValid = validatePesel(trimmed);
      return { type: 'PESEL', isValid, msg: isValid ? 'Poprawna suma kontrolna PESEL' : 'Niepoprawna suma kontrolna PESEL' };
    }
    if (trimmed.length === 10) {
      const isValid = validateNip(trimmed);
      return { type: 'NIP', isValid, msg: isValid ? 'Poprawna suma kontrolna NIP' : 'Niepoprawna suma kontrolna NIP' };
    }
    return { type: 'OTHER', isValid: false, msg: 'PESEL powinien mieć 11 cyfr, a NIP 10 cyfr' };
  }, [pesel]);

  const refOkna = useZamknijEscape(isOpen, onClose);
  if (!isOpen) return null;

  const handleGenerateXML = (e: React.FormEvent) => {
    e.preventDefault();
    setBladDanych('');

    // Puste pola nie zamieniaja sie juz w "JAN KOWALSKI" z zerowym numerem
    // PESEL i przypadkowym urzedem. Deklaracja ma nosic dane podatnika, a nie
    // wartosci zastepcze, ktore wygladaja na gotowe do wyslania.
    const taxpayerData = {
      peselOrNip: pesel.trim(),
      firstName: firstName.trim().toUpperCase(),
      lastName: lastName.trim().toUpperCase(),
      birthDate: birthDate.trim(),
      taxOfficeCode: taxOfficeCode.trim(),
      wojewodztwo: wojewodztwo.trim(),
      powiat: powiat.trim(),
      gmina: gmina.trim(),
      ulica: ulica.trim(),
      nrDomu: nrDomu.trim(),
      nrLokalu: nrLokalu.trim(),
      miejscowosc: miejscowosc.trim(),
      kodPocztowy: kodPocztowy.trim(),
    };

    if (taxpayerData.taxOfficeCode && !czyKodUrzeduIstnieje(taxpayerData.taxOfficeCode)) {
      setBladDanych(
        `Kod urzędu ${taxpayerData.taxOfficeCode} nie występuje w słowniku Ministerstwa Finansów — ` +
          'e-Deklaracje odrzucą taką deklarację. Wybierz urząd z listy.'
      );
      return;
    }

    try {
      exportPit38XML(
        summary,
        realizedGains,
        dividends,
        `PIT38_${summary.year}_${taxpayerData.lastName || 'deklaracja'}.xml`,
        taxpayerData
      );
    } catch (blad) {
      setBladDanych(blad instanceof Error ? blad.message : 'Nie udało się wygenerować pliku XML.');
      return;
    }

    setIsSaved(true);
    setTimeout(() => {
      setIsSaved(false);
      onClose();
    }, 600);
  };

  return (
    <div ref={refOkna} tabIndex={-1} role="dialog" aria-modal="true" aria-label="Eksport e-Deklaracje XML (PIT-38)" className="outline-none fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/60 backdrop-blur-xs animate-in fade-in duration-150">
      <div
        id="taxpayer-config-modal"
        className="w-full max-w-lg max-h-[90vh] overflow-y-auto bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl shadow-2xl"
      >
        {/* Header */}
        <div className="p-5 border-b border-slate-200 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-800/40 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="p-2 rounded-xl bg-amber-500/10 text-amber-600 dark:text-amber-400">
              <FileCode2 className="w-5 h-5" />
            </div>
            <div>
              <h3 className="text-base font-bold text-slate-900 dark:text-white">
                Eksport e-Deklaracje XML (PIT-38)
              </h3>
              <p className="text-xs text-slate-500 dark:text-slate-400">
                Uzupełnij dane podatnika do wygenerowania oficjalnego pliku XML
              </p>
            </div>
          </div>
          <button
            aria-label="Zamknij"
            onClick={onClose}
            className="p-1.5 rounded-lg text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Content Form */}
        <form onSubmit={handleGenerateXML} className="p-5 space-y-4">
          <div className="p-3 rounded-xl bg-blue-50 dark:bg-blue-950/40 border border-blue-200 dark:border-blue-800/60 text-xs text-blue-800 dark:text-blue-300 flex items-start gap-2.5">
            <ShieldCheck className="w-4 h-4 shrink-0 text-blue-600 dark:text-blue-400 mt-0.5" />
            <p>
              Twoje dane są przetwarzane <strong>wyłącznie lokalnie w Twojej przeglądarce</strong> i nie są wysyłane na żaden zewnętrzny serwer.
            </p>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1">
                Imię podatnika
              </label>
              <div className="relative">
                <User className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
                <input
                  aria-label="Imię podatnika"
                  type="text"
                  value={firstName}
                  onChange={(e) => setFirstName(e.target.value)}
                  placeholder="np. JAN"
                  className="w-full pl-8 pr-3 py-2 text-xs rounded-xl bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-900 dark:text-white focus:ring-2 focus:ring-amber-500 uppercase font-medium"
                />
              </div>
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1">
                Nazwisko podatnika
              </label>
              <input aria-label="Nazwisko podatnika"
                type="text"
                value={lastName}
                onChange={(e) => setLastName(e.target.value)}
                placeholder="np. KOWALSKI"
                className="w-full px-3 py-2 text-xs rounded-xl bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-900 dark:text-white focus:ring-2 focus:ring-amber-500 uppercase font-medium"
              />
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1">
                PESEL lub NIP
              </label>
              <input aria-label="PESEL lub NIP"
                type="text"
                value={pesel}
                onChange={(e) => setPesel(e.target.value)}
                placeholder="np. 90010112345"
                maxLength={11}
                className="w-full px-3 py-2 text-xs rounded-xl bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-900 dark:text-white focus:ring-2 focus:ring-amber-500 font-mono"
              />
              {peselNipStatus && (
                <div
                  className={`flex items-center gap-1 mt-1 text-[10px] font-medium ${
                    peselNipStatus.isValid
                      ? 'text-emerald-600 dark:text-emerald-400'
                      : 'text-amber-600 dark:text-amber-400'
                  }`}
                >
                  {peselNipStatus.isValid ? (
                    <CheckCircle2 className="w-3 h-3 shrink-0" />
                  ) : (
                    <AlertCircle className="w-3 h-3 shrink-0" />
                  )}
                  <span>{peselNipStatus.msg}</span>
                </div>
              )}
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1">
                Kod Urzędu Skarbowego
              </label>
              <div className="relative">
                <Building className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
                <input
                  aria-label="Kod Urzędu Skarbowego"
                  type="text"
                  value={taxOfficeCode}
                  onChange={(e) => setTaxOfficeCode(e.target.value)}
                  placeholder="np. 1435"
                  maxLength={4}
                  className="w-full pl-8 pr-3 py-2 text-xs rounded-xl bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-900 dark:text-white focus:ring-2 focus:ring-amber-500 font-mono"
                />
              </div>
              {statusUrzedu && (
                <div
                  className={`flex items-center gap-1 mt-1 text-[10px] font-medium ${
                    statusUrzedu.poprawny
                      ? 'text-emerald-600 dark:text-emerald-400'
                      : 'text-amber-600 dark:text-amber-400'
                  }`}
                >
                  {statusUrzedu.poprawny ? (
                    <CheckCircle2 className="w-3 h-3 shrink-0" />
                  ) : (
                    <AlertCircle className="w-3 h-3 shrink-0" />
                  )}
                  <span>{statusUrzedu.opis}</span>
                </div>
              )}
            </div>
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-500 dark:text-slate-400 mb-1">
              Urząd skarbowy ze słownika Ministerstwa Finansów ({URZEDY_SKARBOWE.length}):
            </label>
            <select
              aria-label="Urząd skarbowy ze słownika Ministerstwa Finansów"
              value={taxOfficeCode}
              onChange={(e) => setTaxOfficeCode(e.target.value)}
              className="w-full px-3 py-2 text-xs rounded-xl bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-300 focus:ring-2 focus:ring-amber-500 cursor-pointer"
            >
              <option value="">— wybierz urząd —</option>
              {URZEDY_SKARBOWE.map((us) => (
                <option key={us.code} value={us.code}>
                  [{us.code}] {us.name}
                </option>
              ))}
            </select>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1">
                Data urodzenia
              </label>
              <input aria-label="Data urodzenia"
                type="date"
                value={birthDate}
                onChange={(e) => setBirthDate(e.target.value)}
                className="w-full px-3 py-2 text-xs rounded-xl bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-900 dark:text-white focus:ring-2 focus:ring-amber-500 font-mono"
              />
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1">
                Kod pocztowy
              </label>
              <input aria-label="Kod pocztowy"
                type="text"
                value={kodPocztowy}
                onChange={(e) => setKodPocztowy(e.target.value)}
                placeholder="00-001"
                maxLength={6}
                className="w-full px-3 py-2 text-xs rounded-xl bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-900 dark:text-white focus:ring-2 focus:ring-amber-500 font-mono"
              />
            </div>
          </div>

          <div className="p-3 rounded-xl border border-slate-200 dark:border-slate-700 space-y-3">
            <p className="text-[11px] text-slate-500 dark:text-slate-400 leading-relaxed">
              Adres zamieszkania. Schemat e-Deklaracji wymaga województwa, powiatu, gminy,
              numeru domu, miejscowości i kodu pocztowego — bez nich plik nie przejdzie
              walidacji, mimo że wygląda na kompletny.
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <input type="text" value={wojewodztwo} onChange={(e) => setWojewodztwo(e.target.value)} placeholder="Województwo" className="w-full px-3 py-2 text-xs rounded-xl bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-900 dark:text-white focus:ring-2 focus:ring-amber-500" />
              <input type="text" value={powiat} onChange={(e) => setPowiat(e.target.value)} placeholder="Powiat" className="w-full px-3 py-2 text-xs rounded-xl bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-900 dark:text-white focus:ring-2 focus:ring-amber-500" />
              <input type="text" value={gmina} onChange={(e) => setGmina(e.target.value)} placeholder="Gmina" className="w-full px-3 py-2 text-xs rounded-xl bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-900 dark:text-white focus:ring-2 focus:ring-amber-500" />
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-4 gap-3">
              <input type="text" value={miejscowosc} onChange={(e) => setMiejscowosc(e.target.value)} placeholder="Miejscowość" className="w-full px-3 py-2 text-xs rounded-xl bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-900 dark:text-white focus:ring-2 focus:ring-amber-500" />
              <input type="text" value={ulica} onChange={(e) => setUlica(e.target.value)} placeholder="Ulica (opcjonalnie)" className="w-full px-3 py-2 text-xs rounded-xl bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-900 dark:text-white focus:ring-2 focus:ring-amber-500" />
              <input type="text" value={nrDomu} onChange={(e) => setNrDomu(e.target.value)} placeholder="Nr domu" className="w-full px-3 py-2 text-xs rounded-xl bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-900 dark:text-white focus:ring-2 focus:ring-amber-500" />
              <input type="text" value={nrLokalu} onChange={(e) => setNrLokalu(e.target.value)} placeholder="Nr lokalu (opc.)" className="w-full px-3 py-2 text-xs rounded-xl bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-900 dark:text-white focus:ring-2 focus:ring-amber-500" />
            </div>
          </div>

          {bladDanych && (
            <div className="p-3 rounded-xl border border-rose-200 dark:border-rose-900/60 bg-rose-50/90 dark:bg-rose-950/40 text-rose-800 dark:text-rose-200 text-[11px] leading-relaxed">
              {bladDanych}
            </div>
          )}

          {/* Action buttons */}
          <div className="pt-3 border-t border-slate-200 dark:border-slate-800 flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              className="px-3.5 py-2 rounded-xl text-xs font-medium text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer"
            >
              Anuluj
            </button>
            <button
              type="submit"
              className="flex items-center gap-1.5 px-4 py-2 rounded-xl bg-amber-700 hover:bg-amber-800 text-white text-xs font-bold shadow-xs transition-all cursor-pointer"
            >
              {isSaved ? <Check className="w-4 h-4" /> : <FileCode2 className="w-4 h-4" />}
              <span>{isSaved ? 'Pobrano plik XML!' : 'Pobierz Plik XML'}</span>
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
