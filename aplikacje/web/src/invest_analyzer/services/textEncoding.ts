/** Kodowanie, w ktorym udalo sie odczytac tresc pliku. */
export type StorageTextEncoding = 'utf-8' | 'windows-1250';

export interface DecodedStorageText {
  text: string;
  encoding: StorageTextEncoding;
}

const UTF8_BOM = [0xef, 0xbb, 0xbf];

function startsWithBom(bytes: Uint8Array): boolean {
  return bytes.length >= 3 && UTF8_BOM.every((byte, index) => bytes[index] === byte);
}

/**
 * Odczytuje tresc pliku z magazynu.
 *
 * `response.text()` dekoduje zawsze jako UTF-8 i zamienia kazdy inny bajt na
 * znak zastepczy. Archiwa kursow NBP sa zapisane w Windows-1250 - bajt 0xB3 to
 * "ł" - wiec naglowki traciły polskie znaki bez zadnego ostrzezenia. Silnik
 * Pythona czyta te pliki jako cp1250 od poczatku; ta funkcja wyrownuje
 * zachowanie przegladarki.
 */
export function decodeStorageText(bytes: Uint8Array): DecodedStorageText {
  const withoutBom = startsWithBom(bytes) ? bytes.subarray(UTF8_BOM.length) : bytes;
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(withoutBom), encoding: 'utf-8' };
  } catch {
    // Tresc nie jest poprawnym UTF-8. W tym zbiorze plikow oznacza to
    // Windows-1250; kazdy bajt ma tam swoj znak, wiec odczyt sie nie psuje.
    return { text: new TextDecoder('windows-1250').decode(bytes), encoding: 'windows-1250' };
  }
}
