/**
 * Generator kodow QR (ISO/IEC 18004), tryb bajtowy, poziom korekcji M.
 *
 * Ekran 2FA prosil o zeskanowanie kodu QR, a pokazywal ozdobna grafike z napisem
 * "OCHRONA TOTP 2FA" - nie dalo sie jej zeskanowac zadna aplikacja
 * uwierzytelniajaca. Jedyna droga bylo przepisanie klucza recznie, a po
 * aktywacji znikal takze klucz.
 *
 * Kod powstaje tutaj, w przegladarce. Sekret nie jest nigdzie wysylany - to
 * wazniejsze niz wygoda gotowej biblioteki, bo zewnetrzny generator obrazkow
 * dostalby caly klucz TOTP uzytkownika w adresie zadania.
 *
 * Obsluzone wersje 1-10 mieszcza adres `otpauth://` z zapasem.
 */

/** Liczba wszystkich slow kodowych w danej wersji symbolu (wersje 1-10). */
const SLOWA_KODOWE_RAZEM = [26, 44, 70, 100, 134, 172, 196, 242, 292, 346];

/**
 * Uklad blokow dla poziomu korekcji M: slowa korekcyjne na blok oraz grupy
 * blokow w postaci [liczba blokow, slowa danych w bloku].
 */
const UKLAD_BLOKOW_M: { slowaKorekcji: number; grupy: [number, number][] }[] = [
  { slowaKorekcji: 10, grupy: [[1, 16]] },
  { slowaKorekcji: 16, grupy: [[1, 28]] },
  { slowaKorekcji: 26, grupy: [[1, 44]] },
  { slowaKorekcji: 18, grupy: [[2, 32]] },
  { slowaKorekcji: 24, grupy: [[2, 43]] },
  { slowaKorekcji: 16, grupy: [[4, 27]] },
  { slowaKorekcji: 18, grupy: [[4, 31]] },
  { slowaKorekcji: 22, grupy: [[2, 38], [2, 39]] },
  { slowaKorekcji: 22, grupy: [[3, 36], [2, 37]] },
  { slowaKorekcji: 26, grupy: [[4, 43], [1, 44]] },
];

/** Srodki wzorcow wyrownania dla wersji 1-10. */
const SRODKI_WYROWNANIA: number[][] = [
  [],
  [6, 18],
  [6, 22],
  [6, 26],
  [6, 30],
  [6, 34],
  [6, 22, 38],
  [6, 24, 42],
  [6, 26, 46],
  [6, 28, 50],
];

// --- Arytmetyka w ciele Galois GF(256), wielomian pierwotny 0x11D -----------

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);

(function zbudujTablice() {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
})();

function mnozenieGF(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  return EXP[LOG[a] + LOG[b]];
}

/** Wielomian generujacy kod Reeda-Solomona o zadanej liczbie slow korekcyjnych. */
function wielomianGenerujacy(stopien: number): Uint8Array {
  let wynik = new Uint8Array([1]);
  for (let i = 0; i < stopien; i++) {
    const nowy = new Uint8Array(wynik.length + 1);
    for (let j = 0; j < wynik.length; j++) {
      nowy[j] ^= wynik[j];
      nowy[j + 1] ^= mnozenieGF(wynik[j], EXP[i]);
    }
    wynik = nowy;
  }
  return wynik;
}

/** Slowa korekcyjne dla jednego bloku danych. */
function slowaKorekcyjne(dane: Uint8Array, ile: number): Uint8Array {
  const generator = wielomianGenerujacy(ile);
  const reszta = new Uint8Array(dane.length + ile);
  reszta.set(dane);
  for (let i = 0; i < dane.length; i++) {
    const wiodacy = reszta[i];
    if (wiodacy === 0) continue;
    for (let j = 0; j < generator.length; j++) {
      reszta[i + j] ^= mnozenieGF(generator[j], wiodacy);
    }
  }
  return reszta.slice(dane.length);
}

// --- Strumien bitow ---------------------------------------------------------

class StrumienBitow {
  private bity: number[] = [];

  dopisz(wartosc: number, dlugosc: number): void {
    for (let i = dlugosc - 1; i >= 0; i--) {
      this.bity.push((wartosc >>> i) & 1);
    }
  }

  get dlugosc(): number {
    return this.bity.length;
  }

  naBajty(): Uint8Array {
    const bajty = new Uint8Array(Math.ceil(this.bity.length / 8));
    this.bity.forEach((bit, i) => {
      if (bit) bajty[i >>> 3] |= 0x80 >>> (i & 7);
    });
    return bajty;
  }
}

/** Najmniejsza wersja mieszczaca dane w trybie bajtowym na poziomie M. */
export function dobierzWersje(dlugoscDanych: number): number {
  for (let wersja = 1; wersja <= 10; wersja++) {
    const uklad = UKLAD_BLOKOW_M[wersja - 1];
    const slowaDanych = uklad.grupy.reduce((suma, [ile, na]) => suma + ile * na, 0);
    const bityNaglowka = 4 + (wersja <= 9 ? 8 : 16);
    if (bityNaglowka + dlugoscDanych * 8 <= slowaDanych * 8) return wersja;
  }
  throw new Error('Dane są zbyt długie dla kodu QR w obsługiwanych wersjach 1-10.');
}

/** Slowa kodowe symbolu: dane z wypelnieniem, korekcja, przeplot blokow. */
export function zbudujSlowaKodowe(dane: Uint8Array, wersja: number): Uint8Array {
  const uklad = UKLAD_BLOKOW_M[wersja - 1];
  const slowaDanychRazem = uklad.grupy.reduce((suma, [ile, na]) => suma + ile * na, 0);

  const strumien = new StrumienBitow();
  strumien.dopisz(0b0100, 4); // tryb bajtowy
  strumien.dopisz(dane.length, wersja <= 9 ? 8 : 16);
  dane.forEach((bajt) => strumien.dopisz(bajt, 8));

  const pojemnoscBitow = slowaDanychRazem * 8;
  strumien.dopisz(0, Math.min(4, pojemnoscBitow - strumien.dlugosc)); // zakonczenie
  if (strumien.dlugosc % 8 !== 0) strumien.dopisz(0, 8 - (strumien.dlugosc % 8));

  const bajtyDanych = Array.from(strumien.naBajty());
  const wypelniacze = [0xec, 0x11];
  let i = 0;
  while (bajtyDanych.length < slowaDanychRazem) {
    bajtyDanych.push(wypelniacze[i++ % 2]);
  }

  const blokiDanych: Uint8Array[] = [];
  const blokiKorekcji: Uint8Array[] = [];
  let pozycja = 0;
  for (const [ileBlokow, slowNaBlok] of uklad.grupy) {
    for (let b = 0; b < ileBlokow; b++) {
      const blok = Uint8Array.from(bajtyDanych.slice(pozycja, pozycja + slowNaBlok));
      pozycja += slowNaBlok;
      blokiDanych.push(blok);
      blokiKorekcji.push(slowaKorekcyjne(blok, uklad.slowaKorekcji));
    }
  }

  const wynik: number[] = [];
  const najdluzszyBlok = Math.max(...blokiDanych.map((b) => b.length));
  for (let kolumna = 0; kolumna < najdluzszyBlok; kolumna++) {
    for (const blok of blokiDanych) {
      if (kolumna < blok.length) wynik.push(blok[kolumna]);
    }
  }
  for (let kolumna = 0; kolumna < uklad.slowaKorekcji; kolumna++) {
    for (const blok of blokiKorekcji) {
      wynik.push(blok[kolumna]);
    }
  }
  return Uint8Array.from(wynik);
}

// --- Budowa macierzy --------------------------------------------------------

type Macierz = { modul: Int8Array; zajete: Uint8Array; rozmiar: number };

function pustaMacierz(rozmiar: number): Macierz {
  return { modul: new Int8Array(rozmiar * rozmiar), zajete: new Uint8Array(rozmiar * rozmiar), rozmiar };
}

function ustaw(m: Macierz, x: number, y: number, ciemny: boolean, funkcyjny = true): void {
  m.modul[y * m.rozmiar + x] = ciemny ? 1 : 0;
  if (funkcyjny) m.zajete[y * m.rozmiar + x] = 1;
}

function czyCiemny(m: Macierz, x: number, y: number): boolean {
  return m.modul[y * m.rozmiar + x] === 1;
}

function wstawWzorzecPozycji(m: Macierz, lewy: number, gorny: number): void {
  for (let y = -1; y <= 7; y++) {
    for (let x = -1; x <= 7; x++) {
      const px = lewy + x;
      const py = gorny + y;
      if (px < 0 || py < 0 || px >= m.rozmiar || py >= m.rozmiar) continue;
      const naObwodzie = (x >= 0 && x <= 6 && (y === 0 || y === 6)) || (y >= 0 && y <= 6 && (x === 0 || x === 6));
      const wSrodku = x >= 2 && x <= 4 && y >= 2 && y <= 4;
      ustaw(m, px, py, naObwodzie || wSrodku);
    }
  }
}

/**
 * Osiemnastobitowa informacja o wersji: numer wersji i 12 bitow korekcji BCH
 * (wielomian 0x1F25). Wymagana dla wersji 7 i wyzszych.
 */
function informacjaOWersji(wersja: number): number {
  let reszta = wersja;
  for (let i = 0; i < 12; i++) {
    reszta = (reszta << 1) ^ ((reszta >>> 11) * 0x1f25);
  }
  return ((wersja << 12) | reszta) & 0x3ffff;
}

function wstawWzorcePomocnicze(m: Macierz, wersja: number): void {
  wstawWzorzecPozycji(m, 0, 0);
  wstawWzorzecPozycji(m, m.rozmiar - 7, 0);
  wstawWzorzecPozycji(m, 0, m.rozmiar - 7);

  for (let i = 8; i < m.rozmiar - 8; i++) {
    const ciemny = i % 2 === 0;
    ustaw(m, i, 6, ciemny);
    ustaw(m, 6, i, ciemny);
  }

  const srodki = SRODKI_WYROWNANIA[wersja - 1];
  for (const sx of srodki) {
    for (const sy of srodki) {
      const naWzorcuPozycji =
        (sx <= 8 && sy <= 8) || (sx <= 8 && sy >= m.rozmiar - 9) || (sx >= m.rozmiar - 9 && sy <= 8);
      if (naWzorcuPozycji) continue;
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          const skrajny = Math.max(Math.abs(dx), Math.abs(dy));
          ustaw(m, sx + dx, sy + dy, skrajny !== 1);
        }
      }
    }
  }

  // Pola informacji o formacie rezerwujemy, wartosci wpisujemy po wyborze maski.
  for (let i = 0; i <= 8; i++) {
    if (i !== 6) {
      ustaw(m, i, 8, false);
      ustaw(m, 8, i, false);
    }
  }
  // W lewym dolnym rogu format zajmuje siedem modulow (wiersze n-1 do n-7).
  // Osmy, na wysokosci n-8, to modul zawsze ciemny - rezerwowanie osmiu pol
  // gasilo go i symbol przestawal byc zgodny z norma.
  for (let i = 0; i < 7; i++) {
    ustaw(m, 8, m.rozmiar - 1 - i, false);
  }
  for (let i = 0; i < 8; i++) {
    ustaw(m, m.rozmiar - 1 - i, 8, false);
  }
  ustaw(m, 8, m.rozmiar - 8, true); // modul zawsze ciemny

  // Od wersji 7 symbol niesie osiemnastobitowa informacje o wersji w dwoch
  // blokach 3x6 - przy lewym dolnym i prawym gornym wzorcu pozycji. Bez nich
  // dane wchodzily na te pola i caly dalszy rozklad modulow sie przesuwal, wiec
  // kod byl nieczytelny dla kazdego skanera.
  if (wersja >= 7) {
    const informacja = informacjaOWersji(wersja);
    for (let i = 0; i < 18; i++) {
      const ciemny = ((informacja >>> i) & 1) === 1;
      const wzdluz = Math.floor(i / 3);
      const wpoprzek = m.rozmiar - 11 + (i % 3);
      ustaw(m, wzdluz, wpoprzek, ciemny);
      ustaw(m, wpoprzek, wzdluz, ciemny);
    }
  }
}

function wstawDane(m: Macierz, slowa: Uint8Array): void {
  let indeksBitu = 0;
  let kierunekWGore = true;
  for (let prawa = m.rozmiar - 1; prawa > 0; prawa -= 2) {
    if (prawa === 6) prawa = 5; // kolumna wzorca czasu
    for (let krok = 0; krok < m.rozmiar; krok++) {
      const y = kierunekWGore ? m.rozmiar - 1 - krok : krok;
      for (let przesuniecie = 0; przesuniecie < 2; przesuniecie++) {
        const x = prawa - przesuniecie;
        if (m.zajete[y * m.rozmiar + x]) continue;
        const bajt = slowa[indeksBitu >>> 3];
        const bit = bajt === undefined ? 0 : (bajt >>> (7 - (indeksBitu & 7))) & 1;
        ustaw(m, x, y, bit === 1, false);
        indeksBitu++;
      }
    }
    kierunekWGore = !kierunekWGore;
  }
}

function maska(numer: number, x: number, y: number): boolean {
  switch (numer) {
    case 0: return (x + y) % 2 === 0;
    case 1: return y % 2 === 0;
    case 2: return x % 3 === 0;
    case 3: return (x + y) % 3 === 0;
    case 4: return (Math.floor(y / 2) + Math.floor(x / 3)) % 2 === 0;
    case 5: return ((x * y) % 2) + ((x * y) % 3) === 0;
    case 6: return (((x * y) % 2) + ((x * y) % 3)) % 2 === 0;
    default: return (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
  }
}

function karaZaUklad(m: Macierz): number {
  const n = m.rozmiar;
  let kara = 0;

  const policzSerie = (pobierz: (a: number, b: number) => boolean) => {
    for (let a = 0; a < n; a++) {
      let dlugosc = 1;
      for (let b = 1; b < n; b++) {
        if (pobierz(a, b) === pobierz(a, b - 1)) {
          dlugosc++;
        } else {
          if (dlugosc >= 5) kara += dlugosc - 2;
          dlugosc = 1;
        }
      }
      if (dlugosc >= 5) kara += dlugosc - 2;
    }
  };
  policzSerie((y, x) => czyCiemny(m, x, y));
  policzSerie((x, y) => czyCiemny(m, x, y));

  for (let y = 0; y < n - 1; y++) {
    for (let x = 0; x < n - 1; x++) {
      const pierwszy = czyCiemny(m, x, y);
      if (
        pierwszy === czyCiemny(m, x + 1, y) &&
        pierwszy === czyCiemny(m, x, y + 1) &&
        pierwszy === czyCiemny(m, x + 1, y + 1)
      ) {
        kara += 3;
      }
    }
  }

  const wzorzec = [true, false, true, true, true, false, true];
  const pasuje = (punkty: boolean[]) => {
    if (punkty.length !== 11) return false;
    for (let i = 0; i < 7; i++) if (punkty[i + 4] !== wzorzec[i]) return false;
    return punkty.slice(0, 4).every((p) => !p);
  };
  for (let y = 0; y < n; y++) {
    for (let x = 0; x <= n - 11; x++) {
      const poziomo: boolean[] = [];
      const pionowo: boolean[] = [];
      for (let i = 0; i < 11; i++) {
        poziomo.push(czyCiemny(m, x + i, y));
        pionowo.push(czyCiemny(m, y, x + i));
      }
      if (pasuje(poziomo)) kara += 40;
      if (pasuje(poziomo.slice().reverse())) kara += 40;
      if (pasuje(pionowo)) kara += 40;
      if (pasuje(pionowo.slice().reverse())) kara += 40;
    }
  }

  let ciemne = 0;
  for (let i = 0; i < n * n; i++) if (m.modul[i] === 1) ciemne++;
  const procent = (ciemne * 100) / (n * n);
  kara += Math.floor(Math.abs(procent - 50) / 5) * 10;

  return kara;
}

function wpiszFormat(m: Macierz, numerMaski: number): void {
  const dane = (0b00 << 3) | numerMaski; // 00 = poziom korekcji M
  let reszta = dane << 10;
  for (let i = 14; i >= 10; i--) {
    if ((reszta >>> i) & 1) reszta ^= 0b10100110111 << (i - 10);
  }
  const format = ((dane << 10) | reszta) ^ 0b101010000010010;

  for (let i = 0; i <= 5; i++) ustaw(m, 8, i, ((format >>> i) & 1) === 1);
  ustaw(m, 8, 7, ((format >>> 6) & 1) === 1);
  ustaw(m, 8, 8, ((format >>> 7) & 1) === 1);
  ustaw(m, 7, 8, ((format >>> 8) & 1) === 1);
  for (let i = 9; i < 15; i++) ustaw(m, 14 - i, 8, ((format >>> i) & 1) === 1);

  for (let i = 0; i <= 7; i++) ustaw(m, m.rozmiar - 1 - i, 8, ((format >>> i) & 1) === 1);
  for (let i = 8; i < 15; i++) ustaw(m, 8, m.rozmiar - 15 + i, ((format >>> i) & 1) === 1);
}

/** Macierz modulow kodu QR: `true` oznacza modul ciemny. */
export function macierzKoduQr(tresc: string): boolean[][] {
  const dane = new TextEncoder().encode(tresc);
  const wersja = dobierzWersje(dane.length);
  const slowa = zbudujSlowaKodowe(dane, wersja);
  const rozmiar = 17 + 4 * wersja;

  let najlepsza: Macierz | null = null;
  let najlepszaKara = Number.POSITIVE_INFINITY;

  for (let numerMaski = 0; numerMaski < 8; numerMaski++) {
    const m = pustaMacierz(rozmiar);
    wstawWzorcePomocnicze(m, wersja);
    wstawDane(m, slowa);
    for (let y = 0; y < rozmiar; y++) {
      for (let x = 0; x < rozmiar; x++) {
        if (m.zajete[y * rozmiar + x]) continue;
        if (maska(numerMaski, x, y)) m.modul[y * rozmiar + x] ^= 1;
      }
    }
    wpiszFormat(m, numerMaski);
    const kara = karaZaUklad(m);
    if (kara < najlepszaKara) {
      najlepszaKara = kara;
      najlepsza = m;
    }
  }

  const wybrana = najlepsza!;
  const wynik: boolean[][] = [];
  for (let y = 0; y < rozmiar; y++) {
    const wiersz: boolean[] = [];
    for (let x = 0; x < rozmiar; x++) wiersz.push(czyCiemny(wybrana, x, y));
    wynik.push(wiersz);
  }
  if (SLOWA_KODOWE_RAZEM[wersja - 1] !== slowa.length) {
    throw new Error('Niespójna liczba słów kodowych — kod QR nie powstał poprawnie.');
  }
  return wynik;
}

/** Kod QR jako obraz SVG w postaci Data URI, gotowy do wstawienia w `<img>`. */
export function kodQrJakoDataUri(tresc: string, rozmiarPx = 180): string {
  const macierz = macierzKoduQr(tresc);
  const modulow = macierz.length;
  const marginesModulow = 4; // cicha strefa wymagana przez norme
  const bok = modulow + marginesModulow * 2;

  const sciezka: string[] = [];
  macierz.forEach((wiersz, y) => {
    wiersz.forEach((ciemny, x) => {
      if (ciemny) sciezka.push(`M${x + marginesModulow} ${y + marginesModulow}h1v1h-1z`);
    });
  });

  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${bok} ${bok}" width="${rozmiarPx}" height="${rozmiarPx}" shape-rendering="crispEdges">` +
    `<rect width="${bok}" height="${bok}" fill="#ffffff"/>` +
    `<path d="${sciezka.join('')}" fill="#000000"/>` +
    `</svg>`;

  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

/** Adres `otpauth://` dla aplikacji uwierzytelniajacej (RFC 6238). */
export function adresOtpauth(sekret: string, wystawca: string, konto: string): string {
  const etykieta = encodeURIComponent(`${wystawca}:${konto}`);
  const parametry = new URLSearchParams({
    secret: sekret,
    issuer: wystawca,
    algorithm: 'SHA1',
    digits: '6',
    period: '30',
  });
  return `otpauth://totp/${etykieta}?${parametry.toString()}`;
}
