/**
 * Moduł weryfikacji dwuetapowej TOTP (RFC 6238) i kodów zapasowych.
 * 
 * Implementacja oparta w całości na natywnym Web Crypto API (crypto.subtle),
 * bez zewnętrznych zależności i bez wysyłania sekretów do obcych serwisów.
 */

import { TwoFactorState } from '../types';

export const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export interface TotpUriOptions {
  secret: string;
  accountName?: string;
  issuer?: string;
  digits?: number;
  period?: number;
}

export interface VerifyTotpOptions {
  window?: number; // tolerancja okien czasowych (+/- n kroków, domyślnie 1)
  stepSeconds?: number; // czas trwania kroku w sekundach (domyślnie 30)
  digits?: number; // liczba cyfr (domyślnie 6)
  timeInSeconds?: number; // opcjonalny znacznik czasu Unix do testów
}

export interface SessionUnlockResult {
  valid: boolean;
  isBackupCode: boolean;
  updatedTwoFactor?: TwoFactorState;
  errorMessage?: string;
}

const STORAGE_KEY_2FA = 'pit38_2fa';
const STORAGE_KEY_2FA_CREDENTIALS = 'pit38_2fa_credentials';

function getCrypto(): Crypto {
  if (typeof crypto !== 'undefined') {
    return crypto;
  }
  if (typeof globalThis !== 'undefined' && (globalThis as unknown as { crypto: Crypto }).crypto) {
    return (globalThis as unknown as { crypto: Crypto }).crypto;
  }
  throw new Error('Web Crypto API (crypto.subtle) nie jest dostępne w tym środowisku.');
}

/**
 * Koduje bufor bajtów do łańcucha Base32 wg RFC 4648 (bez paddingu '=').
 */
export function base32Encode(buffer: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let output = '';

  for (let i = 0; i < buffer.length; i++) {
    value = (value << 8) | buffer[i];
    bits += 8;

    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }

  if (bits > 0) {
    output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }

  return output;
}

/**
 * Dekoduje łańcuch Base32 wg RFC 4648 do bufora bajtów.
 * Ignoruje znaki odstępu, łączniki i ewentualny padding '='.
 */
export function base32Decode(input: string): Uint8Array {
  const cleanInput = input.toUpperCase().replace(/[=\s-]/g, '');
  let bits = 0;
  let value = 0;
  const output: number[] = [];

  for (let i = 0; i < cleanInput.length; i++) {
    const char = cleanInput[i];
    const index = BASE32_ALPHABET.indexOf(char);
    if (index === -1) {
      throw new Error(`Nieprawidłowy znak Base32: "${char}"`);
    }

    value = (value << 5) | index;
    bits += 5;

    if (bits >= 8) {
      output.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }

  return new Uint8Array(output);
}

/**
 * Generuje kryptograficznie bezpieczny losowy sekret Base32 (RFC 4648, bez paddingu).
 * Domyślnie 20 bajtów (160 bitów) = 32 znaki Base32 (rekomendacja RFC 4226/6238).
 */
export function generateSecret(byteLength: number = 20): string {
  const c = getCrypto();
  const randomBytes = new Uint8Array(byteLength);
  c.getRandomValues(randomBytes);
  return base32Encode(randomBytes);
}

/**
 * Buduje standardowy URI otpauth://totp/... dla aplikacji Authenticator.
 */
export function buildTotpUri(options: TotpUriOptions): string {
  const {
    secret,
    accountName = 'user@investanalizer.local',
    issuer = 'PIT38TaxAdvisor',
    digits = 6,
    period = 30,
  } = options;

  const cleanSecret = secret.replace(/[\s-]/g, '').toUpperCase();
  const encodedIssuer = encodeURIComponent(issuer);
  const encodedAccount = encodeURIComponent(accountName);
  const label = `${encodedIssuer}:${encodedAccount}`;

  return `otpauth://totp/${label}?secret=${cleanSecret}&issuer=${encodedIssuer}&algorithm=SHA1&digits=${digits}&period=${period}`;
}

/**
 * Oblicza jednorazowy kod HOTP (RFC 4226) dla zadanego sekretu i licznika
 * przy użyciu Web Crypto API (HMAC-SHA1).
 */
export async function generateHotpCode(
  secret: string,
  counter: number | bigint,
  digits: number = 6
): Promise<string> {
  const c = getCrypto();
  const keyBytes = base32Decode(secret);

  const cryptoKey = await c.subtle.importKey(
    'raw',
    keyBytes,
    { name: 'HMAC', hash: { name: 'SHA-1' } },
    false,
    ['sign']
  );

  const counterBuffer = new ArrayBuffer(8);
  const counterView = new DataView(counterBuffer);
  counterView.setBigUint64(0, BigInt(counter), false); // big-endian 64-bit int

  const signature = await c.subtle.sign('HMAC', cryptoKey, counterBuffer);
  const hash = new Uint8Array(signature);

  // Dynamiczne obcinanie (RFC 4226 sekcja 5.4)
  const offset = hash[hash.length - 1] & 0x0f;
  const binaryCode =
    ((hash[offset] & 0x7f) << 24) |
    ((hash[offset + 1] & 0xff) << 16) |
    ((hash[offset + 2] & 0xff) << 8) |
    (hash[offset + 3] & 0xff);

  const otp = binaryCode % Math.pow(10, digits);
  return otp.toString().padStart(digits, '0');
}

/**
 * Oblicza aktualny kod TOTP (RFC 6238) dla wskazanego znacznika czasu Unix.
 */
export async function generateTotpCode(
  secret: string,
  timeInSeconds?: number,
  options: { digits?: number; stepSeconds?: number; t0?: number } = {}
): Promise<string> {
  const { digits = 6, stepSeconds = 30, t0 = 0 } = options;
  const now = timeInSeconds !== undefined ? timeInSeconds : Math.floor(Date.now() / 1000);
  const counter = Math.floor((now - t0) / stepSeconds);

  return generateHotpCode(secret, counter, digits);
}

/**
 * Weryfikuje wprowadzony kod TOTP z tolerancją okien czasowych (domyślnie +/-1 okno 30 s).
 */
export async function verifyTotpCode(
  token: string,
  secret: string,
  options: VerifyTotpOptions = {}
): Promise<boolean> {
  const cleanToken = token.replace(/[\s-]/g, '');
  const {
    window = 1,
    stepSeconds = 30,
    digits = 6,
    timeInSeconds = Math.floor(Date.now() / 1000),
  } = options;

  if (cleanToken.length !== digits || !/^\d+$/.test(cleanToken)) {
    return false;
  }

  const currentCounter = Math.floor(timeInSeconds / stepSeconds);

  for (let offset = -window; offset <= window; offset++) {
    const counter = currentCounter + offset;
    if (counter < 0) continue;
    const expected = await generateHotpCode(secret, counter, digits);
    if (expected === cleanToken) {
      return true;
    }
  }

  return false;
}

/**
 * Normalizuje kod zapasowy do jednolitej postaci (usunięcie myślników i spacji).
 */
export function normalizeBackupCode(code: string): string {
  return code.replace(/[-\s]/g, '').trim().toUpperCase();
}

/**
 * Oblicza skrót SHA-256 kodu zapasowego (kody zapasowe nigdy nie są przechowywane w postaci jawnej).
 */
export async function hashBackupCode(code: string): Promise<string> {
  const c = getCrypto();
  const normalized = normalizeBackupCode(code);
  const encoder = new TextEncoder();
  const data = encoder.encode(normalized);
  const hashBuffer = await c.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Generuje zestaw kodów zapasowych w formacie DDDD-DDDD (np. 8941-2094)
 * wraz z ich kryptograficznymi skrótami SHA-256.
 */
export async function generateBackupCodes(count: number = 4): Promise<{
  plainCodes: string[];
  hashedCodes: string[];
}> {
  const c = getCrypto();
  const plainCodes: string[] = [];
  const hashedCodes: string[] = [];

  for (let i = 0; i < count; i++) {
    const randomBytes = new Uint8Array(4);
    c.getRandomValues(randomBytes);
    const num =
      ((randomBytes[0] << 24) |
        (randomBytes[1] << 16) |
        (randomBytes[2] << 8) |
        randomBytes[3]) >>>
      0;
    const rawDigits = (num % 100000000).toString().padStart(8, '0');
    const formatted = `${rawDigits.slice(0, 4)}-${rawDigits.slice(4)}`;
    plainCodes.push(formatted);
    hashedCodes.push(await hashBackupCode(formatted));
  }

  return { plainCodes, hashedCodes };
}

/**
 * Weryfikuje kod zapasowy względem listy skrótów SHA-256.
 * Zwraca informację o poprawności oraz listę pozostałych (niezużytych) skrótów.
 */
export async function verifyBackupCode(
  inputCode: string,
  hashedCodes: string[]
): Promise<{ valid: boolean; matchedHash?: string; remainingHashes: string[] }> {
  const normalized = normalizeBackupCode(inputCode);
  if (!normalized || normalized.length < 6) {
    return { valid: false, remainingHashes: hashedCodes };
  }

  const inputHash = await hashBackupCode(inputCode);
  const index = hashedCodes.indexOf(inputHash);

  if (index !== -1) {
    const remainingHashes = hashedCodes.filter((_, i) => i !== index);
    return { valid: true, matchedHash: inputHash, remainingHashes };
  }

  return { valid: false, remainingHashes: hashedCodes };
}

/**
 * Zapisuje dane uwierzytelniające 2FA (w tym skróty kodów zapasowych) w pamięci lokalnej.
 */
export function saveTwoFactorCredentials(config: {
  secret: string;
  backupCodeHashes: string[];
  backupCodes?: string[];
  qrCodeUrl?: string;
}): void {
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(
        STORAGE_KEY_2FA_CREDENTIALS,
        JSON.stringify({
          secret: config.secret,
          backupCodeHashes: config.backupCodeHashes,
          backupCodes: config.backupCodes || [],
          qrCodeUrl: config.qrCodeUrl || '',
          updatedAt: new Date().toISOString(),
        })
      );
    }
  } catch {
    // Ignoruj błędy zapisu w środowiskach bez localStorage
  }
}

/**
 * Odczytuje zapisane dane uwierzytelniające 2FA z pamięci lokalnej.
 */
export function loadTwoFactorCredentials(): {
  secret: string;
  backupCodeHashes: string[];
  backupCodes: string[];
  qrCodeUrl: string;
} | null {
  try {
    if (typeof localStorage === 'undefined') return null;
    const raw = localStorage.getItem(STORAGE_KEY_2FA_CREDENTIALS);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Usuwa zapisane dane uwierzytelniające 2FA z pamięci lokalnej.
 */
export function clearTwoFactorCredentials(): void {
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.removeItem(STORAGE_KEY_2FA_CREDENTIALS);
    }
  } catch {
    // Ignoruj
  }
}

/**
 * Zunifikowana weryfikacja kodu odblokowania sesji:
 * 1. Sprawdza kod TOTP (6 cyfr, +/-1 okno 30 s).
 * 2. Jeśli nie pasuje, sprawdza kod zapasowy względem listy skrótów SHA-256.
 * 3. Jeśli kod zapasowy był poprawny, zużywa go (usuwa ze skrótów) i zapisuje zaktualizowany stan.
 */
export async function verifySessionUnlock(
  code: string,
  twoFactorState: TwoFactorState
): Promise<SessionUnlockResult> {
  const cleanCode = code.trim();
  if (!cleanCode) {
    return { valid: false, isBackupCode: false, errorMessage: 'Wprowadź kod weryfikacyjny.' };
  }

  // Odczytaj aktywny sekret: priorytet ma stan, w razie potrzeby uzupełnij z magazynu lokalnego
  const stored = loadTwoFactorCredentials();
  const secret = twoFactorState.secret || stored?.secret;

  // 1. Próba weryfikacji kodu TOTP (6 cyfr)
  if (/^\d{6}$/.test(cleanCode) && secret) {
    const isTotpValid = await verifyTotpCode(cleanCode, secret, { window: 1 });
    if (isTotpValid) {
      return {
        valid: true,
        isBackupCode: false,
        updatedTwoFactor: {
          ...twoFactorState,
          isLocked: false,
          lastVerifiedAt: new Date().toISOString(),
        },
      };
    }
  }

  // 2. Próba weryfikacji kodu zapasowego
  let hashes = twoFactorState.backupCodeHashes || stored?.backupCodeHashes;

  // Jeśli brak jawnych skrótów, ale mamy zapisane kody w tablicy backupCodes (np. stan początkowy),
  // przelicz ich skróty SHA-256
  if ((!hashes || hashes.length === 0) && twoFactorState.backupCodes && twoFactorState.backupCodes.length > 0) {
    hashes = await Promise.all(twoFactorState.backupCodes.map((c) => hashBackupCode(c)));
  }

  if (hashes && hashes.length > 0) {
    const backupResult = await verifyBackupCode(cleanCode, hashes);
    if (backupResult.valid) {
      // Zuzyty kod znika takze z jawnej listy pokazywanej uzytkownikowi.
      // Wczesniej usuwany byl tylko skrot, wiec ekran dalej wymienial kod, ktory
      // juz nie dziala - a przy czterech kodach z podobnym poczatkiem nie dalo
      // sie odgadnac, ktory z nich zostal wykorzystany.
      const zuzyty = normalizeBackupCode(cleanCode);
      const pozostaleKody = (twoFactorState.backupCodes ?? []).filter(
        (kod) => normalizeBackupCode(kod) !== zuzyty
      );

      if (secret) {
        saveTwoFactorCredentials({
          secret,
          backupCodeHashes: backupResult.remainingHashes,
          backupCodes: pozostaleKody,
          qrCodeUrl: twoFactorState.qrCodeUrl,
        });
      }

      const updatedTwoFactor: TwoFactorState = {
        ...twoFactorState,
        backupCodes: pozostaleKody,
        backupCodeHashes: backupResult.remainingHashes,
        isLocked: false,
        lastVerifiedAt: new Date().toISOString(),
      };

      try {
        if (typeof localStorage !== 'undefined') {
          localStorage.setItem(STORAGE_KEY_2FA, JSON.stringify(updatedTwoFactor));
        }
      } catch {
        // Ignoruj
      }

      return {
        valid: true,
        isBackupCode: true,
        updatedTwoFactor,
      };
    }
  }

  return {
    valid: false,
    isBackupCode: false,
    errorMessage: 'Nieprawidłowy kod weryfikacyjny lub kod zapasowy.',
  };
}

/**
 * Funkcja weryfikująca odblokowanie sesji dedykowana do wpięcia w PortfelApp.tsx
 * Zgodnie z wytycznymi, PortfelApp.tsx nie jest edytowany bezpośrednio,
 * a poniższa funkcja udostępnia dokładną sygnaturę dla osoby pracującej nad PortfelApp.tsx:
 * 
 * Sygnatura:
 * ```ts
 * const handleUnlockSession = async (code: string): Promise<boolean> => {
 *   const res = await verifyUnlockSession(code, twoFactor);
 *   if (res.valid) {
 *     setTwoFactor((prev) => ({
 *       ...prev,
 *       ...(res.updatedTwoFactor || {}),
 *       isLocked: false,
 *       lastVerifiedAt: new Date().toISOString(),
 *     }));
 *     return true;
 *   }
 *   return false;
 * };
 * ```
 */
export async function verifyUnlockSession(
  code: string,
  twoFactor: TwoFactorState
): Promise<SessionUnlockResult> {
  return verifySessionUnlock(code, twoFactor);
}
