import test from "node:test";
import assert from "node:assert/strict";

import {
  BASE32_ALPHABET,
  base32Encode,
  base32Decode,
  generateSecret,
  buildTotpUri,
  generateHotpCode,
  generateTotpCode,
  verifyTotpCode,
  normalizeBackupCode,
  hashBackupCode,
  generateBackupCodes,
  verifyBackupCode,
  verifySessionUnlock,
  verifyUnlockSession,
} from "../../../aplikacje/web/src/portfel/services/totp.ts";
import { TwoFactorState } from "../../../aplikacje/web/src/portfel/types.ts";

// ============================================================================
// 1. Testy Base32 (RFC 4648, bez paddingu)
// ============================================================================

test("base32Encode koduje wektory testowe z RFC 4648 (bez paddingu)", () => {
  const encoder = new TextEncoder();

  assert.equal(base32Encode(encoder.encode("")), "");
  assert.equal(base32Encode(encoder.encode("f")), "MY");
  assert.equal(base32Encode(encoder.encode("fo")), "MZXQ");
  assert.equal(base32Encode(encoder.encode("foo")), "MZXW6");
  assert.equal(base32Encode(encoder.encode("foob")), "MZXW6YQ");
  assert.equal(base32Encode(encoder.encode("fooba")), "MZXW6YTB");
  assert.equal(base32Encode(encoder.encode("foobar")), "MZXW6YTBOI");
});

test("base32Decode dekoduje poprawnie wektory testowe z RFC 4648", () => {
  const decoder = new TextDecoder();

  assert.equal(decoder.decode(base32Decode("")), "");
  assert.equal(decoder.decode(base32Decode("MY")), "f");
  assert.equal(decoder.decode(base32Decode("MZXQ")), "fo");
  assert.equal(decoder.decode(base32Decode("MZXW6")), "foo");
  assert.equal(decoder.decode(base32Decode("MZXW6YQ")), "foob");
  assert.equal(decoder.decode(base32Decode("MZXW6YTB")), "fooba");
  assert.equal(decoder.decode(base32Decode("MZXW6YTBOI")), "foobar");
});

test("base32Decode ignoruje wielkość liter, spacje, myślniki i padding '='", () => {
  const decoder = new TextDecoder();

  // Małe litery
  assert.equal(decoder.decode(base32Decode("mzxw6ytboi")), "foobar");
  // Ze spacjami i myślnikami
  assert.equal(decoder.decode(base32Decode("MZXW-6YTB OI")), "foobar");
  // Z paddingiem RFC 4648 '='
  assert.equal(decoder.decode(base32Decode("MY======")), "f");
  assert.equal(decoder.decode(base32Decode("MZXQ====")), "fo");
  assert.equal(decoder.decode(base32Decode("MZXW6===")), "foo");
  assert.equal(decoder.decode(base32Decode("MZXW6YQ=")), "foob");
});

test("base32Decode rzuca błąd dla niedozwolonych znaków", () => {
  assert.throws(() => base32Decode("MZXW8"), /Nieprawidłowy znak Base32/);
  assert.throws(() => base32Decode("MZXW9"), /Nieprawidłowy znak Base32/);
  assert.throws(() => base32Decode("MZXW!"), /Nieprawidłowy znak Base32/);
});

test("generateSecret generuje bezpieczny losowy sekret Base32 o właściwej długości", () => {
  // Domyślnie 20 bajtów = 160 bitów = 32 znaki Base32
  const secret1 = generateSecret();
  const secret2 = generateSecret();

  assert.equal(secret1.length, 32);
  assert.equal(secret2.length, 32);
  assert.notEqual(secret1, secret2, "kolejne sekrety muszą być unikalne");

  // Wszystkie znaki muszą należeć do alfabetu Base32
  for (const ch of secret1) {
    assert.ok(BASE32_ALPHABET.includes(ch), `znak ${ch} musi należeć do alfabetu Base32`);
  }

  // Opcjonalna niestandardowa długość
  const secret10 = generateSecret(10); // 10 bajtów = 80 bitów = 16 znaków
  assert.equal(secret10.length, 16);
});

// ============================================================================
// 2. Testy URI otpauth://totp/...
// ============================================================================

test("buildTotpUri poprawnie konstruuje standardowy URI", () => {
  const uri = buildTotpUri({
    secret: "JBSWY3DPEHPK3PXP",
    accountName: "jan.kowalski@example.com",
    issuer: "PIT38TaxAdvisor",
    digits: 6,
    period: 30,
  });

  assert.ok(uri.startsWith("otpauth://totp/PIT38TaxAdvisor:jan.kowalski%40example.com?"));
  assert.match(uri, /secret=JBSWY3DPEHPK3PXP/);
  assert.match(uri, /issuer=PIT38TaxAdvisor/);
  assert.match(uri, /algorithm=SHA1/);
  assert.match(uri, /digits=6/);
  assert.match(uri, /period=30/);
});

// ============================================================================
// 3. Oficjalne wektory testowe RFC 6238 (Appendix B dla HMAC-SHA1)
// ============================================================================

// Klucz testowy z RFC 6238: ciąg znaków ASCII "12345678901234567890" (20 bajtów).
// W postaci Base32: "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ".
const RFC_6238_SECRET = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";

test("obliczanie kodu TOTP (HMAC-SHA1, 8 cyfr) jest zgodne z wektorami testowymi RFC 6238 Appendix B", async () => {
  const rfcVectors8Digits = [
    { time: 59, expected: "94287082" },
    { time: 1111111109, expected: "07081804" },
    { time: 1111111111, expected: "14050471" },
    { time: 1234567890, expected: "89005924" },
    { time: 2000000000, expected: "69279037" },
    { time: 20000000000, expected: "65353130" },
  ];

  for (const v of rfcVectors8Digits) {
    const code = await generateTotpCode(RFC_6238_SECRET, v.time, { digits: 8, stepSeconds: 30 });
    assert.equal(code, v.expected, `Niezgodność dla T=${v.time}`);
  }
});

test("obliczanie kodu TOTP (HMAC-SHA1, 6 cyfr) jest zgodne z wektorami testowymi RFC 6238", async () => {
  // Wersje 6-cyfrowe to ostatnie 6 cyfr wartości 8-cyfrowych:
  const rfcVectors6Digits = [
    { time: 59, expected: "287082" },
    { time: 1111111109, expected: "081804" },
    { time: 1111111111, expected: "050471" },
    { time: 1234567890, expected: "005924" },
    { time: 2000000000, expected: "279037" },
    { time: 20000000000, expected: "353130" },
  ];

  for (const v of rfcVectors6Digits) {
    const code = await generateTotpCode(RFC_6238_SECRET, v.time, { digits: 6, stepSeconds: 30 });
    assert.equal(code, v.expected, `Niezgodność dla 6 cyfr przy T=${v.time}`);
  }
});

// ============================================================================
// 4. Weryfikacja kodu TOTP z tolerancją okien czasowych (+/- 1 okno)
// ============================================================================

test("verifyTotpCode akceptuje poprawny kod w bieżącym oknie czasowym", async () => {
  const secret = generateSecret();
  const testTime = 1700000000;
  const validCode = await generateTotpCode(secret, testTime);

  const isValid = await verifyTotpCode(validCode, secret, { timeInSeconds: testTime });
  assert.equal(isValid, true);
});

test("verifyTotpCode akceptuje kod z poprzedniego i następnego okna (+/- 1 okno)", async () => {
  const secret = generateSecret();
  const testTime = 1700000000; // środek

  const codePrev = await generateTotpCode(secret, testTime - 30); // T - 1 okno (30s)
  const codeNext = await generateTotpCode(secret, testTime + 30); // T + 1 okno (30s)

  // Tolerancja domyślna window=1:
  assert.equal(
    await verifyTotpCode(codePrev, secret, { timeInSeconds: testTime, window: 1 }),
    true,
    "musi zaakceptować kod z okna T-1"
  );
  assert.equal(
    await verifyTotpCode(codeNext, secret, { timeInSeconds: testTime, window: 1 }),
    true,
    "musi zaakceptować kod z okna T+1"
  );

  // Przy braku tolerancji (window=0) kody z innych okien są odrzucane:
  assert.equal(
    await verifyTotpCode(codePrev, secret, { timeInSeconds: testTime, window: 0 }),
    false,
    "window=0 musi odrzucić T-1"
  );
  assert.equal(
    await verifyTotpCode(codeNext, secret, { timeInSeconds: testTime, window: 0 }),
    false,
    "window=0 musi odrzucić T+1"
  );
});

test("verifyTotpCode odrzuca kody spoza tolerancji (+/- 2 okna) oraz kody losowe", async () => {
  const secret = generateSecret();
  const testTime = 1700000000;

  const codeTooOld = await generateTotpCode(secret, testTime - 60); // T - 2 okna
  const codeTooNew = await generateTotpCode(secret, testTime + 60); // T + 2 okna

  assert.equal(
    await verifyTotpCode(codeTooOld, secret, { timeInSeconds: testTime, window: 1 }),
    false,
    "musi odrzucić kod starszy niż 1 okno"
  );
  assert.equal(
    await verifyTotpCode(codeTooNew, secret, { timeInSeconds: testTime, window: 1 }),
    false,
    "musi odrzucić kod nowszy niż 1 okno"
  );

  // Pozorny kod (np. 123456 lub losowe 6 cyfr)
  assert.equal(await verifyTotpCode("000000", secret, { timeInSeconds: testTime }), false);
  assert.equal(await verifyTotpCode("123456", secret, { timeInSeconds: testTime }), false);
  assert.equal(await verifyTotpCode("999999", secret, { timeInSeconds: testTime }), false);

  // Niepoprawna długość lub znaki nieliczbowe
  assert.equal(await verifyTotpCode("12345", secret, { timeInSeconds: testTime }), false);
  assert.equal(await verifyTotpCode("1234567", secret, { timeInSeconds: testTime }), false);
  assert.equal(await verifyTotpCode("abcdef", secret, { timeInSeconds: testTime }), false);
});

// ============================================================================
// 5. Testy kodów zapasowych (generowanie, hashowanie SHA-256, jednorazowość)
// ============================================================================

test("hashBackupCode oblicza powtarzalny skrót SHA-256 i ignoruje myślniki", async () => {
  const codeWithHyphen = "8941-2094";
  const codeWithoutHyphen = "89412094";

  const hash1 = await hashBackupCode(codeWithHyphen);
  const hash2 = await hashBackupCode(codeWithoutHyphen);

  assert.equal(hash1.length, 64, "skrót SHA-256 w hex ma 64 znaki");
  assert.equal(hash1, hash2, "skrót z myślnikiem i bez myślnika musi być identyczny");
});

test("generateBackupCodes generuje kody w formacie DDDD-DDDD oraz ich skróty SHA-256", async () => {
  const { plainCodes, hashedCodes } = await generateBackupCodes(4);

  assert.equal(plainCodes.length, 4);
  assert.equal(hashedCodes.length, 4);

  for (let i = 0; i < 4; i++) {
    assert.match(plainCodes[i], /^\d{4}-\d{4}$/, "format kodu to DDDD-DDDD");
    const expectedHash = await hashBackupCode(plainCodes[i]);
    assert.equal(hashedCodes[i], expectedHash);
  }
});

test("verifyBackupCode weryfikuje poprawny kod i usuwa go z listy (jednorazowe użycie)", async () => {
  const { plainCodes, hashedCodes } = await generateBackupCodes(3);

  // Poprawny pierwszy kod
  const res1 = await verifyBackupCode(plainCodes[0], hashedCodes);
  assert.equal(res1.valid, true);
  assert.equal(res1.remainingHashes.length, 2);
  assert.ok(!res1.remainingHashes.includes(res1.matchedHash!));

  // Próba ponownego użycia tego samego kodu zapasowego musi zostać odrzucona!
  const resReuse = await verifyBackupCode(plainCodes[0], res1.remainingHashes);
  assert.equal(resReuse.valid, false, "zużyty kod zapasowy nie może zostać użyty ponownie");
  assert.equal(resReuse.remainingHashes.length, 2);

  // Nieprawidłowy kod zapasowy
  const resInvalid = await verifyBackupCode("0000-0000", res1.remainingHashes);
  assert.equal(resInvalid.valid, false);
});

// ============================================================================
// 6. Testy weryfikacji odblokowania sesji (verifySessionUnlock)
// ============================================================================

test("verifySessionUnlock odblokowuje sesję poprawnym kodem TOTP i odrzuca dowolne 6 cyfr", async () => {
  const secret = generateSecret();
  const { plainCodes, hashedCodes } = await generateBackupCodes(2);

  const mockState: TwoFactorState = {
    isEnabled: true,
    secret,
    qrCodeUrl: "data:image/svg+xml,...",
    backupCodes: plainCodes,
    backupCodeHashes: hashedCodes,
    isLocked: true,
  };

  // 1. Odrzucenie pozornych 6 cyfr (np. 123456, 111111)
  const fakeRes1 = await verifySessionUnlock("123456", mockState);
  assert.equal(fakeRes1.valid, false);

  const fakeRes2 = await verifySessionUnlock("111111", mockState);
  assert.equal(fakeRes2.valid, false);

  // 2. Akceptacja prawdziwego kodu TOTP
  const realCode = await generateTotpCode(secret);
  const realRes = await verifySessionUnlock(realCode, mockState);
  assert.equal(realRes.valid, true);
  assert.equal(realRes.isBackupCode, false);
  assert.equal(realRes.updatedTwoFactor?.isLocked, false);
});

test("verifySessionUnlock odblokowuje sesję niezużytym kodem zapasowym i blokuje ponowne użycie", async () => {
  const secret = generateSecret();
  const { plainCodes, hashedCodes } = await generateBackupCodes(2);

  let state: TwoFactorState = {
    isEnabled: true,
    secret,
    qrCodeUrl: "data:image/svg+xml,...",
    backupCodes: plainCodes,
    backupCodeHashes: hashedCodes,
    isLocked: true,
  };

  // Użycie pierwszego kodu zapasowego
  const unlockRes1 = await verifySessionUnlock(plainCodes[0], state);
  assert.equal(unlockRes1.valid, true);
  assert.equal(unlockRes1.isBackupCode, true);
  assert.equal(unlockRes1.updatedTwoFactor?.isLocked, false);

  // Aktualizujemy stan do stanu po zużyciu kodu
  state = unlockRes1.updatedTwoFactor!;
  assert.equal(state.backupCodeHashes?.length, 1);

  // Zużyty kod znika też z jawnej listy pokazywanej na ekranie. Wcześniej
  // usuwany był wyłącznie skrót, więc ekran nadal wymieniał kod, który przy
  // kolejnej blokadzie zostałby odrzucony.
  assert.deepEqual(state.backupCodes, [plainCodes[1]]);
  assert.ok(
    !state.backupCodes?.includes(plainCodes[0]),
    "zużyty kod zapasowy nie może zostać na widocznej liście"
  );

  // Próba odblokowania tym samym kodem zapasowym ponownie
  const reuseRes = await verifySessionUnlock(plainCodes[0], state);
  assert.equal(reuseRes.valid, false, "ponowne użycie zużytego kodu zapasowego musi zostać odrzucone");

  // Drugi kod zapasowy nadal działa
  const unlockRes2 = await verifySessionUnlock(plainCodes[1], state);
  assert.equal(unlockRes2.valid, true);
});

