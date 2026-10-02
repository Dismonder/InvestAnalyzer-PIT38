import React, { useEffect, useRef } from 'react';
import {
  AreaSeries,
  CandlestickSeries,
  ColorType,
  CrosshairMode,
  HistogramSeries,
  LineSeries,
  TickMarkType,
  createChart,
  type IChartApi,
  type ISeriesApi,
  type UTCTimestamp,
} from 'lightweight-charts';
import { opisSwiecy, przygotujDaneWykresu, type PunktWykresu, type SzczegolySwiecy, type TypWykresu } from '../services/daneWykresuGieldowego';

interface WykresGieldowyProps {
  punkty: PunktWykresu[];
  typ: TypWykresu;
  /** Ile sekund historii pokazac na starcie (od ostatniej swiecy); starsza jest o przesuniecie w lewo. */
  widoczneSekundy: number;
  /** Zmiana klucza (walor, interwal, zakres) ustawia okno widoku od nowa; samo odswiezenie danych - nie. */
  kluczWidoku: string;
  ciemny: boolean;
  wysokosc?: number;
}

type SeriaCeny = ISeriesApi<'Candlestick'> | ISeriesApi<'Line'> | ISeriesApi<'Area'>;

/**
 * Wykres gieldowy: przeciaganie mysza przesuwa w czasie, kolko powieksza,
 * podwojne klikniecie osi przywraca skale. Cala dostepna historia jest juz
 * w pamieci, wiec przesuwanie w lewo nie czeka na siec.
 */
export const WykresGieldowy: React.FC<WykresGieldowyProps> = ({ punkty, typ, widoczneSekundy, kluczWidoku, ciemny, wysokosc = 420 }) => {
  const kontener = useRef<HTMLDivElement | null>(null);
  const wykres = useRef<IChartApi | null>(null);
  const seriaCeny = useRef<SeriaCeny | null>(null);
  const seriaWolumenu = useRef<ISeriesApi<'Histogram'> | null>(null);
  const ustawionyWidok = useRef<string | null>(null);
  const legenda = useRef<HTMLDivElement | null>(null);
  const szczegoly = useRef<Map<number, SzczegolySwiecy>>(new Map());
  const ostatniCzas = useRef<number | null>(null);

  /** Pasek pod kursorem pisany wprost do DOM - ruch myszy nie moze przerysowywac calego Reacta. */
  const pokazSzczegoly = (czas: number | null) => {
    if (!legenda.current) return;
    const wiersz = czas !== null ? szczegoly.current.get(czas) : undefined;
    legenda.current.innerHTML = wiersz ? opisSwiecy(wiersz) : '';
  };

  // 1. Wykres i serie - od nowa tylko przy zmianie typu albo motywu.
  useEffect(() => {
    if (!kontener.current) return;
    const tekst = ciemny ? '#94a3b8' : '#475569';
    const siatka = ciemny ? 'rgba(148,163,184,0.10)' : 'rgba(100,116,139,0.15)';
    const chart = createChart(kontener.current, {
      autoSize: true,
      height: wysokosc,
      layout: { background: { type: ColorType.Solid, color: 'transparent' }, textColor: tekst, fontSize: 11 },
      grid: { vertLines: { color: siatka }, horzLines: { color: siatka } },
      crosshair: { mode: CrosshairMode.Normal },
      rightPriceScale: { borderColor: siatka },
      timeScale: {
        borderColor: siatka, timeVisible: true, secondsVisible: false, rightOffset: 4,
        tickMarkFormatter: (time, typZnacznika) => {
          const data = new Date(Number(time) * 1000);
          if (typZnacznika === TickMarkType.Year) return data.toLocaleDateString('pl-PL', { year: 'numeric' });
          if (typZnacznika === TickMarkType.Month) return data.toLocaleDateString('pl-PL', { month: 'short' });
          if (typZnacznika === TickMarkType.DayOfMonth) return data.toLocaleDateString('pl-PL', { day: '2-digit', month: '2-digit' });
          return data.toLocaleTimeString('pl-PL', { hour: '2-digit', minute: '2-digit' });
        },
      },
      localization: {
        locale: 'pl-PL',
        timeFormatter: (time) => new Date(Number(time) * 1000).toLocaleString('pl-PL'),
      },
      handleScroll: { mouseWheel: true, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: false },
      handleScale: { mouseWheel: true, pinch: true, axisPressedMouseMove: true, axisDoubleClickReset: true },
    });
    wykres.current = chart;
    seriaCeny.current =
      typ === 'SWIECE'
        ? chart.addSeries(CandlestickSeries, { upColor: '#10B981', downColor: '#EF4444', borderVisible: false, wickUpColor: '#10B981', wickDownColor: '#EF4444' })
        : typ === 'LINIA'
          ? chart.addSeries(LineSeries, { color: '#3B82F6', lineWidth: 2 })
          : chart.addSeries(AreaSeries, { lineColor: '#3B82F6', topColor: 'rgba(59,130,246,0.35)', bottomColor: 'rgba(59,130,246,0.02)', lineWidth: 2 });
    seriaWolumenu.current = chart.addSeries(HistogramSeries, { priceFormat: { type: 'volume' }, priceScaleId: 'wolumen' });
    chart.priceScale('wolumen').applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
    // Biezace okno czasu na kontenerze: widac je w narzedziach i w testach przegladarkowych.
    chart.timeScale().subscribeVisibleTimeRangeChange((zakres) => {
      if (!kontener.current || !zakres) return;
      kontener.current.dataset.od = String(zakres.from);
      kontener.current.dataset.do = String(zakres.to);
    });
    // Szczegoly swiecy pod kursorem; poza wykresem - ostatnia swieca.
    chart.subscribeCrosshairMove((param) => {
      pokazSzczegoly(typeof param.time === 'number' ? param.time : ostatniCzas.current);
    });
    ustawionyWidok.current = null;
    return () => {
      chart.remove();
      wykres.current = null;
      seriaCeny.current = null;
      seriaWolumenu.current = null;
    };
  }, [typ, ciemny, wysokosc]);

  // 2. Dane - podmiana bez ruszania okna widoku, zeby odswiezenie nie zrywalo przegladania historii.
  useEffect(() => {
    const chart = wykres.current;
    if (!chart || !seriaCeny.current || !seriaWolumenu.current) return;
    const dane = przygotujDaneWykresu(punkty);
    if (typ === 'SWIECE') {
      (seriaCeny.current as ISeriesApi<'Candlestick'>).setData(dane.swiece.map((s) => ({ ...s, time: s.time as UTCTimestamp })));
    } else {
      (seriaCeny.current as ISeriesApi<'Line'>).setData(dane.linia.map((s) => ({ ...s, time: s.time as UTCTimestamp })));
    }
    seriaWolumenu.current.setData(dane.wolumen.map((s) => ({ ...s, time: s.time as UTCTimestamp })));
    szczegoly.current = dane.szczegoly;
    ostatniCzas.current = dane.linia.length > 0 ? dane.linia[dane.linia.length - 1].time : null;
    pokazSzczegoly(ostatniCzas.current);

    // 3. Okno widoku - tylko gdy zmienil sie walor, interwal albo zakres.
    const klucz = `${kluczWidoku}|${typ}`;
    if (dane.linia.length > 0 && ustawionyWidok.current !== klucz) {
      const ostatnia = dane.linia[dane.linia.length - 1].time;
      const od = Math.max(dane.linia[0].time, ostatnia - widoczneSekundy);
      chart.timeScale().setVisibleRange({ from: od as UTCTimestamp, to: ostatnia as UTCTimestamp });
      ustawionyWidok.current = klucz;
    }
  }, [punkty, typ, kluczWidoku, widoczneSekundy, ciemny, wysokosc]);

  return (
    <div className="relative w-full">
      <div
        ref={legenda}
        data-testid="wykres-szczegoly"
        className="pointer-events-none absolute left-2 top-1 z-10 flex flex-wrap items-center gap-x-3 gap-y-0.5 rounded-md bg-white/70 px-2 py-1 font-mono text-[11px] text-slate-700 backdrop-blur-sm dark:bg-slate-900/70 dark:text-slate-200"
      />
      <div ref={kontener} style={{ height: wysokosc }} className="w-full" data-testid="wykres-gieldowy" />
    </div>
  );
};

export default WykresGieldowy;
