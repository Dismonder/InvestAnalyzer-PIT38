import React, { useState, useEffect } from 'react';
import { X, FileText, Download, CheckCircle2, Clock, AlertCircle, RefreshCw, ShieldCheck, FileCheck } from 'lucide-react';
import { freedom24ExtendedService } from '../services/freedom24ExtendedService';
import { useZamknijEscape } from '../../shared/useZamknijEscape';

interface Freedom24CpsModalProps {
  isOpen: boolean;
  onClose: () => void;
}

// Zamkniete okno odmontowuje tresc zamiast wracac z niej przed hookami -
// inaczej efekty (nasluch Escape, fokus) nie byly sprzatane po zamknieciu.
export const Freedom24CpsModal: React.FC<Freedom24CpsModalProps> = (props) =>
  props.isOpen ? <Freedom24CpsModalTresc {...props} /> : null;

const Freedom24CpsModalTresc: React.FC<Freedom24CpsModalProps> = ({ onClose }) => {
  const refOkna = useZamknijEscape(true, onClose);

  const [cpsList, setCpsList] = useState<any[]>([]);
  const [selectedStatus, setSelectedStatus] = useState<number | undefined>(undefined);
  const [isLoading, setIsLoading] = useState(false);
  const [downloadingId, setDownloadingId] = useState<number | null>(null);

  const loadCps = async (status?: number) => {
    setIsLoading(true);
    const data = await freedom24ExtendedService.fetchCpsHistory({ cps_status: status });
    setCpsList(data);
    setIsLoading(false);
  };

  useEffect(() => {
    loadCps(selectedStatus);
  }, [selectedStatus]);

  const handleDownloadPdf = async (id: number) => {
    setDownloadingId(id);
    try {
      const files = await freedom24ExtendedService.fetchCpsFiles(id);
      if (files && files.length > 0) {
        const f = files[0];
        // Create downloadable link from base64
        const rawBase64 = (f.file || '').replace(/^base64=/, '').trim();
        const byteCharacters = atob(rawBase64);
        const byteNumbers = new Array(byteCharacters.length);
        for (let i = 0; i < byteCharacters.length; i++) {
          byteNumbers[i] = byteCharacters.charCodeAt(i);
        }
        const byteArray = new Uint8Array(byteNumbers);
        const blob = new Blob([byteArray], { type: f.mime || 'application/pdf' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = f.file_name || `dokument_cps_${id}.pdf`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      }
    } catch {
      // safe fallback
    } finally {
      setDownloadingId(null);
    }
  };

  return (
    <div ref={refOkna} tabIndex={-1} role="dialog" aria-modal="true" aria-label="Historia Dyspozycji i Dokumenty CPS Freedom24" className="outline-none fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4 bg-slate-950/70 backdrop-blur-xs animate-in fade-in duration-200">
      <div className="relative w-full max-w-4xl max-h-[92vh] bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl shadow-2xl overflow-hidden flex flex-col">
        {/* Header */}
        <div className="p-4 sm:p-5 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between bg-slate-50/70 dark:bg-slate-900/70">
          <div className="flex items-center gap-3">
            <div className="p-2.5 rounded-xl bg-blue-500/10 text-blue-600 dark:text-blue-400 border border-blue-500/20">
              <FileCheck className="w-5 h-5" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-base sm:text-lg font-bold text-slate-900 dark:text-white">
                  Historia Dyspozycji i Dokumenty CPS Freedom24
                </h2>
                <span className="text-xs px-2.5 py-0.5 rounded-full bg-blue-100 dark:bg-blue-950 text-blue-700 dark:text-blue-300 font-semibold font-mono">
                  getClientCpsHistory & getCpsFiles
                </span>
              </div>
              <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                Oficjalne potwierdzenia operacji walutowych, dyspozycji depozytowych oraz certyfikaty podatkowe
              </p>
            </div>
          </div>

          <button
            aria-label="Zamknij"
            onClick={onClose}
            className="p-2 rounded-lg text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors cursor-pointer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Status Filters Bar */}
        <div className="px-4 sm:px-6 py-3 border-b border-slate-100 dark:border-slate-800 flex items-center justify-between gap-2 flex-wrap bg-slate-50/40 dark:bg-slate-900/40">
          <div className="flex items-center gap-1.5 overflow-x-auto scrollbar-none text-xs">
            {[
              { id: undefined, label: 'Wszystkie dyspozycje' },
              { id: 3, label: '🟢 Zrealizowane pomyślnie' },
              { id: 1, label: '🟡 W trakcie realizacji' },
              { id: 2, label: '🔴 Odrzucone' },
            ].map((tab) => (
              <button
                key={String(tab.id)}
                onClick={() => setSelectedStatus(tab.id)}
                className={`px-3 py-1 rounded-lg font-medium whitespace-nowrap transition-all cursor-pointer ${
                  selectedStatus === tab.id
                    ? 'bg-blue-600 text-white font-bold shadow-xs'
                    : 'bg-white dark:bg-slate-800 text-slate-600 dark:text-slate-300 border border-slate-200 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-750'
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>

          <button
            onClick={() => loadCps(selectedStatus)}
            disabled={isLoading}
            className="p-1.5 rounded-lg text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors cursor-pointer"
            title="Odśwież listę dyspozycji"
          >
            <RefreshCw className={`w-4 h-4 ${isLoading ? 'animate-spin' : ''}`} />
          </button>
        </div>

        {/* CPS Orders List */}
        <div className="flex-1 overflow-y-auto p-4 sm:p-5">
          {isLoading ? (
            <div className="py-16 text-center text-slate-400 text-xs flex flex-col items-center justify-center gap-2">
              <RefreshCw className="w-5 h-5 text-blue-500 animate-spin" />
              <span>Pobieranie historii dyspozycji CPS z Tradernet API...</span>
            </div>
          ) : (
            <div className="space-y-3">
              {/* Pola, ktorych broker nie podal, sa teraz puste zamiast dostawac
                  losowy numer, staly typ 10160 i dzisiejsza date. Ekran musi
                  pokazac brak, a nie "Invalid Date". */}
              {cpsList.map((item, indeks) => (
                <div
                  key={item.id ?? `bez-numeru-${indeks}`}
                  className="p-4 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 flex flex-col sm:flex-row sm:items-center justify-between gap-3 shadow-2xs hover:border-slate-300 dark:hover:border-slate-700 transition-all"
                >
                  <div className="space-y-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-bold text-xs font-mono text-slate-900 dark:text-white">
                        {item.id !== undefined ? `ID #${item.id}` : 'bez numeru'}
                      </span>
                      {item.type_doc_id !== undefined && (
                        <span className="text-[10px] px-2 py-0.5 rounded bg-slate-100 dark:bg-slate-800 text-slate-500 font-mono">
                          Typ #{item.type_doc_id}
                        </span>
                      )}
                      <span
                        className={`text-[10px] px-2 py-0.5 rounded font-semibold ${
                          item.status_c === 3
                            ? 'bg-emerald-100 dark:bg-emerald-950/60 text-emerald-700 dark:text-emerald-300'
                            : item.status_c === 1
                            ? 'bg-amber-100 dark:bg-amber-950/60 text-amber-700 dark:text-amber-300'
                            : 'bg-rose-100 dark:bg-rose-950/60 text-rose-700 dark:text-rose-300'
                        }`}
                      >
                        {item.status_label}
                      </span>
                    </div>

                    <h4 className="font-bold text-xs sm:text-sm text-slate-900 dark:text-white">
                      {item.name || 'Dokument bez nazwy'}
                    </h4>

                    <div className="text-[11px] text-slate-400 flex items-center gap-3 font-mono">
                      <span>
                        Data zgłoszenia:{' '}
                        {item.date_crt && !Number.isNaN(Date.parse(item.date_crt))
                          ? new Date(item.date_crt).toLocaleString('pl-PL')
                          : 'nieznana'}
                      </span>
                      <span>Konto: {item.owner_login || 'nieznane'}</span>
                    </div>
                  </div>

                  <button
                    onClick={() => item.id !== undefined && handleDownloadPdf(item.id)}
                    disabled={downloadingId === item.id || item.id === undefined}
                    title={item.id === undefined ? 'Broker nie podał numeru dokumentu.' : undefined}
                    className="px-3.5 py-2 rounded-xl bg-blue-50 dark:bg-blue-950/60 text-blue-600 dark:text-blue-400 border border-blue-200 dark:border-blue-800 hover:bg-blue-100 dark:hover:bg-blue-900/80 text-xs font-semibold flex items-center gap-1.5 transition-all cursor-pointer shrink-0 shadow-xs"
                  >
                    {downloadingId === item.id ? (
                      <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                    ) : (
                      <Download className="w-3.5 h-3.5" />
                    )}
                    <span>Pobierz PDF</span>
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="p-3 sm:p-4 border-t border-slate-200 dark:border-slate-800 bg-slate-50/80 dark:bg-slate-900/80 flex items-center justify-between">
          <div className="flex items-center gap-2 text-xs text-slate-500">
            <ShieldCheck className="w-4 h-4 text-emerald-500 shrink-0" />
            <span>Dokumenty generowane bezpośrednio z repozytorium plików brokera Freedom24.</span>
          </div>

          <button
            onClick={onClose}
            className="px-5 py-2 rounded-xl bg-blue-600 hover:bg-blue-500 text-white text-xs sm:text-sm font-semibold transition-all shadow-sm cursor-pointer"
          >
            Zamknij
          </button>
        </div>
      </div>
    </div>
  );
};
