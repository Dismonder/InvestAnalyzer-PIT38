import type { Transaction } from '../types';

/** Obrot roku w jednej walucie: wartosc kupna + wartosc sprzedazy (ilosc x cena), bez prowizji. */
export interface ObrotWaluty {
  waluta: string;
  kupno: number;
  sprzedaz: number;
  razem: number;
  liczbaKupna: number;
  liczbaSprzedazy: number;
}

export interface ObrotRoku {
  rok: number;
  waluty: ObrotWaluty[];
  /** Transakcje kupna/sprzedazy z roku, ktorych nie dalo sie wliczyc (brak ilosci, ceny albo waluty). */
  pominiete: number;
}

/**
 * Obrot liczony osobno dla kazdej waluty - kwot w USD, EUR i PLN nie wolno
 * dodawac bez kursu. Transakcja bez ilosci, ceny albo waluty nie jest zgadywana:
 * trafia do licznika `pominiete`, zeby suma nie udawala kompletnej.
 */
export function obliczObrotRoku(transakcje: Transaction[], rok: number): ObrotRoku {
  const wgWaluty = new Map<string, ObrotWaluty>();
  let pominiete = 0;
  for (const tx of transakcje) {
    if (tx.type !== 'BUY' && tx.type !== 'SELL') continue;
    if (Number(String(tx.date ?? '').slice(0, 4)) !== rok) continue;
    const waluta = String(tx.currency ?? '').trim().toUpperCase();
    const ilosc = Number(tx.quantity);
    const cena = Number(tx.pricePerUnit);
    if (!/^[A-Z]{3}$/.test(waluta) || !Number.isFinite(ilosc) || !Number.isFinite(cena) || ilosc <= 0 || cena <= 0) {
      pominiete += 1;
      continue;
    }
    let wiersz = wgWaluty.get(waluta);
    if (!wiersz) {
      wiersz = { waluta, kupno: 0, sprzedaz: 0, razem: 0, liczbaKupna: 0, liczbaSprzedazy: 0 };
      wgWaluty.set(waluta, wiersz);
    }
    const wartosc = ilosc * cena;
    if (tx.type === 'BUY') {
      wiersz.kupno += wartosc;
      wiersz.liczbaKupna += 1;
    } else {
      wiersz.sprzedaz += wartosc;
      wiersz.liczbaSprzedazy += 1;
    }
    wiersz.razem += wartosc;
  }
  return { rok, waluty: [...wgWaluty.values()].sort((a, b) => b.razem - a.razem), pominiete };
}
