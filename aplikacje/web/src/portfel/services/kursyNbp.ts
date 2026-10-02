/**
 * Biezace kursy NBP dla wyceny portfela.
 *
 * Wyceny w PLN liczyly sie wczesniej po kursach wpisanych w kod: 3.95 za dolara
 * i 4.25 za euro w panelu portfela i na wykresach, a w oknie alertow po stalej
 * 4.05 uzywanej dla kazdej waluty bez wyjatku. Kursy `USD/PLN` i `EUR/PLN`,
 * ktore te miejsca probowaly odczytac z notowan, nigdy w nich nie wystepowaly,
 * wiec stala byla uzywana zawsze. Przy kursie NBP 3.71 za dolara portfel
 * pokazywal wartosc zawyzona o kilka procent - liczba wygladala wiarygodnie i
 * nic nie zdradzalo, ze jest wzieta z powietrza.
 *
 * Tutaj kurs pochodzi z tabeli NBP (przez wlasna trase serwera). Gdy go nie ma,
 * zwracamy `null`, a widok pokazuje kreske zamiast przeliczonej kwoty.
 */

import { useEffect, useState } from 'react';
import { getNBPRateForDate } from './nbpService';
import { dzisiajLokalnie } from './formularzTransakcji';
import type { CurrencyCode } from '../types';

/** Waluty, w ktorych prowadzone sa rachunki obslugiwane przez aplikacje. */
const WALUTY_WYCENY: CurrencyCode[] = ['USD', 'EUR', 'GBP', 'CHF', 'CAD', 'NOK', 'SEK', 'JPY'];

export type KursyWycenyPLN = Partial<Record<CurrencyCode, number | null>>;

/** Przelicza kwote na zlote. Zwraca `null`, gdy kurs jest nieznany. */
export function naPLN(
  kwota: number,
  waluta: string | undefined,
  kursy: KursyWycenyPLN
): number | null {
  if (!waluta || waluta === 'PLN') return kwota;
  const kurs = kursy[waluta as CurrencyCode];
  if (typeof kurs !== 'number') return null;
  return kwota * kurs;
}

/**
 * Pobiera kursy raz przy zamontowaniu widoku i trzyma je w stanie.
 *
 * `getNBPRateForDate` ma wlasny bufor, wiec kolejne widoki nie generuja nowych
 * zapytan do serwera.
 */
export function useKursyNbp(): KursyWycenyPLN {
  const [kursy, setKursy] = useState<KursyWycenyPLN>({});

  useEffect(() => {
    let aktualne = true;
    const dzisiaj = dzisiajLokalnie();

    void Promise.all(
      WALUTY_WYCENY.map(async (waluta) => {
        const kurs = await getNBPRateForDate(waluta, dzisiaj);
        return [waluta, kurs ? kurs.mid : null] as const;
      })
    ).then((pary) => {
      if (!aktualne) return;
      setKursy(Object.fromEntries(pary) as KursyWycenyPLN);
    });

    return () => {
      aktualne = false;
    };
  }, []);

  return kursy;
}
