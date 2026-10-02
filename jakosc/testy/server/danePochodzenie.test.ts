/**
 * Odpowiedzi Freedom24 musza mowic, skad pochodza.
 *
 * Trzy przypadki naprawione w tej turze:
 *  - /freedom24/auth/verify-sms nie wysylala zadnego zapytania, a dowolny
 *    niepusty kod dostawal wymyslony `sid_<czas>_<Math.random()>` i komunikat
 *    "Sesja Freedom24 zostala pomyslnie uwierzytelniona i otwarta";
 *  - /freedom24/auth/request-sms konczyla kazda sciezke `success: true`,
 *    takze po bledzie sieci, i tlumaczyla to na sztywno jako "WAF 403";
 *  - wykaz instrumentow i godzin sesji wpisany w kod wracal z `cached: true`,
 *    czyli jako odczyt z pamieci podrecznej brokera.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';

import brokersRouter, {
  getFreedom24SecurityInfo,
  getFreedom24MarketStatus,
  getFreedom24PortfolioLive,
  getFreedom24CpsHistory,
  getFreedom24OrdersHistory,
  getFreedom24TopSecurities,
} from '../../../aplikacje/web/src/server/routes/brokers.ts';

// Testy tego pliku podstawiaja `fetch` i nie moga uzyc prawdziwych kluczy
// z dane/API. Skrypt npm ustawia te flage, ale plik ma dzialac tak samo
// uruchomiony bezposrednio (`node --test`).
process.env.FREEDOM24_DISABLE_LIVE = '1';

async function zSerwerem<T>(uzyj: (adres: string) => Promise<T>): Promise<T> {
  const app = express();
  app.use(express.json());
  app.use('/api/brokers', brokersRouter);
  const serwer = app.listen(0);
  await new Promise<void>((gotowe) => serwer.once('listening', () => gotowe()));
  const port = (serwer.address() as AddressInfo).port;
  try {
    return await uzyj(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((gotowe) => serwer.close(() => gotowe()));
  }
}

async function wyslij(adres: string, sciezka: string, dane: unknown) {
  const odpowiedz = await fetch(`${adres}${sciezka}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(dane),
  });
  return { status: odpowiedz.status, tresc: (await odpowiedz.json()) as Record<string, unknown> };
}

test('weryfikacja kodu SMS bez identyfikatora kodu nie udaje otwartej sesji', async () => {
  // Polecenie `authBySms` wymaga `authCodeId` z kroku zamowienia SMS-a.
  // Bez niego nie ma czego weryfikowac - i nie wolno oddac zadnego `sid`.
  await zSerwerem(async (adres) => {
    const { status, tresc } = await wyslij(adres, '/api/brokers/freedom24/auth/verify-sms', {
      smsCode: '033333',
    });

    assert.equal(status, 400, 'brak authCodeId to blad zadania');
    assert.equal(tresc.success, false);
    assert.equal(tresc.errorCode, 'BRAK_AUTH_CODE_ID');
    assert.ok(!('sid' in tresc), 'nie wolno oddawac wymyslonego identyfikatora sesji');
    assert.doesNotMatch(
      String(tresc.message),
      /uwierzytelnion|otwarta/i,
      'komunikat nie moze twierdzic, ze sesja powstala'
    );
  });
});

test('sesja SMS powstaje tylko z SID od brokera', async () => {
  const oryginalny = globalThis.fetch;
  globalThis.fetch = (async (wejscie: any, opcje: any) => {
    if (String(wejscie).includes('freedom24.com') || String(wejscie).includes('tradernet.')) {
      return new Response(JSON.stringify({ errMsg: 'wrong code', code: 4 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return oryginalny(wejscie, opcje);
  }) as typeof fetch;

  try {
    await zSerwerem(async (adres) => {
      const { status, tresc } = await wyslij(adres, '/api/brokers/freedom24/auth/verify-sms', {
        smsCode: '033333',
        authCodeId: 123456789,
      });

      assert.equal(status, 502);
      assert.equal(tresc.success, false);
      assert.equal(tresc.errorCode, 'SMS_VERIFY_FAILED');
      assert.ok(!('sid' in tresc), 'odmowa brokera nie moze dac identyfikatora sesji');
      assert.match(String(tresc.message), /NIE została otwarta/);
    });
  } finally {
    globalThis.fetch = oryginalny;
  }
});

test('pusty kod SMS nadal jest bledem wejscia, nie brakiem obslugi', async () => {
  await zSerwerem(async (adres) => {
    const { status, tresc } = await wyslij(adres, '/api/brokers/freedom24/auth/verify-sms', {
      smsCode: '   ',
    });
    assert.equal(status, 400);
    assert.equal(tresc.success, false);
  });
});

test('prosba o kod SMS nie zglasza sukcesu, gdy nie da sie polaczyc', async () => {
  // Podmieniamy fetch tak, jak zachowuje sie zerwane polaczenie.
  const oryginalny = globalThis.fetch;
  const doBrokera = 'https://freedom24.com/api/';
  globalThis.fetch = (async (wejscie: any, opcje: any) => {
    if (String(wejscie).startsWith(doBrokera)) {
      throw new TypeError('fetch failed');
    }
    return oryginalny(wejscie, opcje);
  }) as typeof fetch;

  try {
    await zSerwerem(async (adres) => {
      const { status, tresc } = await wyslij(adres, '/api/brokers/freedom24/auth/request-sms', {
        tel: '+48123456789',
      });

      assert.equal(status, 502);
      assert.equal(tresc.success, false);
      assert.equal(tresc.errorCode, 'SMS_REQUEST_FAILED');
      assert.match(String(tresc.message), /nie zostal zamowiony/i);
      assert.doesNotMatch(
        String(tresc.message),
        /WAF 403/,
        'przyczyna nie moze byc zgadnieta - blad sieci to nie blokada WAF'
      );
    });
  } finally {
    globalThis.fetch = oryginalny;
  }
});

test('odmowa brokera po HTTP 200 nie jest sukcesem', async () => {
  const oryginalny = globalThis.fetch;
  globalThis.fetch = (async (wejscie: any, opcje: any) => {
    if (String(wejscie).startsWith('https://freedom24.com/api/')) {
      return new Response(JSON.stringify({ errMsg: 'unknown login' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return oryginalny(wejscie, opcje);
  }) as typeof fetch;

  try {
    await zSerwerem(async (adres) => {
      const { status, tresc } = await wyslij(adres, '/api/brokers/freedom24/auth/request-sms', {
        tel: '+48123456789',
      });
      assert.equal(status, 502);
      assert.equal(tresc.success, false);
      assert.match(String(tresc.message), /unknown login/);
    });
  } finally {
    globalThis.fetch = oryginalny;
  }
});

test('prosba przyjeta przez brokera jest sukcesem', async () => {
  const oryginalny = globalThis.fetch;
  globalThis.fetch = (async (wejscie: any, opcje: any) => {
    if (String(wejscie).startsWith('https://freedom24.com/api/')) {
      return new Response(JSON.stringify({ code: 0, auth_code_id: 987654321, auth_code_length: 6 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return oryginalny(wejscie, opcje);
  }) as typeof fetch;

  try {
    await zSerwerem(async (adres) => {
      const { status, tresc } = await wyslij(adres, '/api/brokers/freedom24/auth/request-sms', {
        tel: '+48123456789',
      });
      assert.equal(status, 200);
      assert.equal(tresc.success, true);
      assert.equal(tresc.authCodeId, 987654321, 'klient musi dostac authCodeId do weryfikacji');
    });
  } finally {
    globalThis.fetch = oryginalny;
  }
});

test('opis instrumentu z wykazu lokalnego jest tak oznaczony', async () => {
  const wynik = await getFreedom24SecurityInfo('NVDA');

  assert.equal(wynik.success, true);
  assert.equal(wynik.zrodlo, 'wykaz-lokalny', 'nie wolno tego podawac jako odczytu z Freedom24');
  assert.ok(!('cached' in wynik), '"cached" sugerowalo pamiec podreczna brokera');
  assert.match(String(wynik.message), /nie z Freedom24/i);
});

test('kryptowaluty nie dostaja wymyslonego ISIN-u', async () => {
  for (const symbol of ['BTC', 'ETH']) {
    const wynik = await getFreedom24SecurityInfo(symbol);
    assert.equal(wynik.success, true, `${symbol} powinien byc w wykazie`);
    assert.equal(
      wynik.securityInfo?.isin,
      undefined,
      `${symbol} nie ma ISIN-u, a w polu ISIN stal wpis typu CRPT-BTC-001`
    );
  }
});

test('nieznany instrument to brak odpowiedzi, nie opis zastepczy', async () => {
  const wynik = await getFreedom24SecurityInfo('ZZZQQQ');
  assert.equal(wynik.success, false);
  assert.equal(wynik.securityInfo, undefined);
});

test('statusy sesji policzone z zegara sa oznaczone jako lokalne', async () => {
  const wynik = await getFreedom24MarketStatus(undefined, undefined, '*');

  assert.equal(wynik.zrodlo, 'zegar-lokalny');
  assert.ok(!('cached' in wynik), '"cached" sugerowalo odczyt z pamieci podrecznej brokera');
  assert.ok(wynik.markets.length > 0);
});

test('saldo bez kursu przeliczenia nie liczy sie jak dolary', async () => {
  // `parseFloat(a.currval || '1')` znaczylo, ze 10 000 PLN wchodzilo do sumy
  // portfela jako 10 000 USD - prawie czterokrotne zawyzenie.
  const oryginalny = globalThis.fetch;
  globalThis.fetch = (async (wejscie: any) => {
    if (!/tradernet\.|freedom24\.com/.test(String(wejscie))) {
      throw new Error('nieoczekiwane zapytanie');
    }
    return new Response(
      JSON.stringify({
        result: {
          ps: {
            key: 'konto-testowe',
            acc: [
              { curr: 'USD', currval: '1', s: '500' },
              { curr: 'PLN', s: '10000' },
            ],
            pos: [],
          },
        },
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  }) as typeof fetch;

  try {
    const wynik: any = await getFreedom24PortfolioLive('klucz', 'sekret');

    assert.equal(wynik.success, true);
    assert.equal(wynik.totalValueUSD, 500, 'saldo PLN bez kursu nie moze wejsc do sumy w USD');
    assert.equal(
      wynik.acc.find((a: any) => a.curr === 'USD').currval,
      1,
      'USD ma kurs 1 z definicji, takze gdy broker nie poda pola currval'
    );
    assert.match(String(wynik.pominietoWWycenie), /10000 PLN/);
    assert.equal(wynik.acc.find((a: any) => a.curr === 'PLN').currval, null);
  } finally {
    globalThis.fetch = oryginalny;
  }
});

test('brak identyfikatora konta nie staje sie nazwa "Freedom24 User"', async () => {
  const oryginalny = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ result: { ps: { acc: [], pos: [] } } }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })) as typeof fetch;

  try {
    const wynik: any = await getFreedom24PortfolioLive('klucz', 'sekret');
    assert.notEqual(wynik.userEmail, 'Freedom24 User');
    assert.equal(wynik.userEmail, '');
  } finally {
    globalThis.fetch = oryginalny;
  }
});

test('saldo USD bez pola currval nadal wchodzi do sumy', async () => {
  // Odrzucanie salda dolarowego, bo broker nie podal kursu USD->USD, bylo
  // regresem wprowadzonym razem z poprawka na kurs 1 dla obcych walut.
  const oryginalny = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        result: { ps: { key: 'k', acc: [{ curr: 'USD', s: '500' }], pos: [] } },
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    )) as typeof fetch;

  try {
    const wynik: any = await getFreedom24PortfolioLive('klucz', 'sekret');
    assert.equal(wynik.totalValueUSD, 500);
    assert.equal(wynik.pominietoWWycenie, undefined, 'nie ma czego pomijac');
  } finally {
    globalThis.fetch = oryginalny;
  }
});

/** Podmienia fetch na jedna odpowiedz Tradernet. */
function zOdpowiedziaTradernet<T>(dane: unknown, cialo: () => Promise<T>): Promise<T> {
  const oryginalny = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(dane), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })) as typeof fetch;
  return cialo().finally(() => {
    globalThis.fetch = oryginalny;
  });
}

test('dyspozycja o nieznanym statusie nie jest "zrealizowana pomyslnie"', async () => {
  // Brak statusu dawal kod 3 i etykiete "Zrealizowane pomyslnie", brak numeru
  // Math.random(), brak typu stala 10160, a brak daty - chwile zapytania.
  await zOdpowiedziaTradernet({ cps: [{ name: 'Dyspozycja' }] }, async () => {
    const wynik: any = await getFreedom24CpsHistory({}, 'klucz', 'sekret');
    const pozycja = wynik.cps[0];

    assert.equal(pozycja.status_c, undefined);
    assert.equal(pozycja.status_label, 'Status nieznany');
    assert.equal(pozycja.id, undefined, 'numer dokumentu nadaje broker, nie Math.random()');
    assert.equal(pozycja.type_doc_id, undefined, 'typ 10160 byl wpisany w kod');
    assert.equal(pozycja.date_crt, undefined, 'data zgloszenia to nie chwila zapytania');
  });
});

test('zlecenie bez numeru, daty i statusu nie dostaje ich z aplikacji', async () => {
  await zOdpowiedziaTradernet(
    { orders: { order: [{ instr_nm: 'NVDA.US', q: '5', p: '200' }] } },
    async () => {
      const wynik: any = await getFreedom24OrdersHistory('klucz', 'sekret');
      const zlecenie = wynik.orders[0];

      assert.equal(zlecenie.ticker, 'NVDA');
      assert.equal(zlecenie.id, undefined);
      assert.equal(zlecenie.date, undefined, 'data zlozenia to nie chwila zapytania');
      assert.equal(zlecenie.status, undefined, 'statusu nie wolno zgadywac z ilosci wykonanej');
      assert.equal(zlecenie.currency, undefined, 'waluta USD byla wartoscia zastepcza');
    }
  );
});

test('pusty eksport z powodu bledu nie jest udanym eksportem', async () => {
  // Eksport konczyl sie `success: true` takze wtedy, gdy zawiodly wszystkie
  // trzy odczyty - z pustymi sekcjami i zdaniem "Freedom24 nie zwrocilo
  // zadnych operacji w podanym zakresie dat", ktore uzytkownik czyta jako
  // potwierdzenie, ze nie ma czego rozliczac. Test przechodzi prawdziwa sciezka
  // trasy: syntetyczne klucze w katalogu tymczasowym i podstawiony fetch, ktory
  // odrzuca kazde polaczenie z brokerem (wczesniej trasa miala na ten test
  // gotowa odpowiedz w kodzie produkcyjnym).
  const katalogKluczy = fs.mkdtempSync(path.join(os.tmpdir(), 'f24-klucze-syntetyczne-'));
  fs.writeFileSync(path.join(katalogKluczy, 'public'), 'syntetyczny-klucz-publiczny');
  fs.writeFileSync(path.join(katalogKluczy, 'private'), 'syntetyczny-klucz-prywatny');
  const poprzednie = {
    katalog: process.env.FREEDOM24_CREDENTIALS_DIR,
    integracja: process.env.FREEDOM24_INTEGRATION,
    wylaczone: process.env.FREEDOM24_DISABLE_LIVE,
  };
  process.env.FREEDOM24_CREDENTIALS_DIR = katalogKluczy;
  process.env.FREEDOM24_INTEGRATION = '1';
  delete process.env.FREEDOM24_DISABLE_LIVE;
  const oryginalny = globalThis.fetch;
  let proby = 0;
  globalThis.fetch = (async (wejscie: any, opcje: any) => {
    if (/tradernet\.|freedom24\.com/.test(String(wejscie))) {
      proby += 1;
      throw new TypeError('fetch failed');
    }
    return oryginalny(wejscie, opcje);
  }) as typeof fetch;

  try {
    await zSerwerem(async (adres) => {
      const { status, tresc } = await wyslij(adres, '/api/brokers/freedom24/full-export', {});

      assert.ok(proby > 0, 'trasa naprawde probowala odczytu (podstawiony fetch)');
      assert.equal(status, 502);
      assert.equal(tresc.success, false);
      assert.equal(tresc.errorCode, 'FREEDOM24_EXPORT_FAILED');
      assert.doesNotMatch(
        JSON.stringify(tresc.warnings ?? []),
        /nie zwróciło żadnych operacji/,
        '"nie ma operacji" wolno powiedziec tylko po udanym odczycie'
      );
    });
  } finally {
    globalThis.fetch = oryginalny;
    for (const [klucz, wartosc] of [
      ['FREEDOM24_CREDENTIALS_DIR', poprzednie.katalog],
      ['FREEDOM24_INTEGRATION', poprzednie.integracja],
      ['FREEDOM24_DISABLE_LIVE', poprzednie.wylaczone],
    ] as const) {
      if (wartosc === undefined) delete process.env[klucz];
      else process.env[klucz] = wartosc;
    }
    fs.rmSync(katalogKluczy, { recursive: true, force: true });
  }
});

test('pozycja bez notowania nie jest warta zero dolarow', async () => {
  // `parseFloat(p.mkt_price || '0')` dawalo pozycji bez ceny wartosc 0 USD:
  // wypadala z sumy portfela bez sladu, a tabela pokazywala "$0.00" obok
  // zielonego "+$0.00".
  const oryginalny = globalThis.fetch;
  globalThis.fetch = (async (wejscie: any) => {
    if (!/tradernet\.|freedom24\.com/.test(String(wejscie))) {
      throw new Error('nieoczekiwane zapytanie');
    }
    return new Response(
      JSON.stringify({
        result: {
          ps: {
            key: 'konto-testowe',
            acc: [],
            pos: [
              { i: 'NVDA.US', q: '10', curr: 'USD', mkt_price: '200', market_value: '2000', profit_close: '150' },
              { i: 'CDR.WA', q: '5', curr: 'PLN' },
            ],
          },
        },
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  }) as typeof fetch;

  try {
    const wynik: any = await getFreedom24PortfolioLive('klucz', 'sekret');

    assert.equal(wynik.success, true);
    const bezCeny = wynik.pos.find((p: any) => p.i === 'CDR.WA');
    assert.equal(bezCeny.market_value, null, 'brak wartosci to null, nie 0');
    assert.equal(bezCeny.mkt_price, null);
    assert.equal(bezCeny.profit_close, null, 'brak zysku to nie jest zysk 0');
    assert.equal(wynik.totalValueUSD, 2000, 'do sumy wchodzi tylko wyceniona pozycja');
    assert.equal(wynik.totalProfitUSD, 150);
    assert.match(String(wynik.pominietoWWycenie), /CDR\.WA/, 'pominiecie musi byc nazwane');
  } finally {
    globalThis.fetch = oryginalny;
  }
});

test('walor bez zmiany procentowej nie trafia na liste wzrostow', async () => {
  // `(item.changePercent || item.chgp || 0) >= 0` znaczylo, ze brak zmiany
  // dawal etykiete GAINER i "+0,00%" obok ceny 0,00.
  const oryginalny = globalThis.fetch;
  globalThis.fetch = (async (wejscie: any) => {
    if (!/tradernet\.|freedom24\.com/.test(String(wejscie))) {
      throw new Error('nieoczekiwane zapytanie');
    }
    return new Response(
      JSON.stringify({ result: { securities: [{ ticker: 'ZZZ.US', short_name: 'Bez danych' }] } }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  }) as typeof fetch;

  try {
    const wynik: any = await getFreedom24TopSecurities('klucz', 'sekret', 'gainers');
    const bezDanych = (wynik.securities || []).find((s: any) => s.ticker === 'ZZZ.US');

    assert.equal(bezDanych, undefined, 'pozycja bez ceny i bez zmiany nie jest notowaniem');
    for (const papier of wynik.securities || []) {
      assert.ok(Number.isFinite(papier.price) && papier.price > 0, `cena ${papier.ticker} musi byc liczba`);
    }
  } finally {
    globalThis.fetch = oryginalny;
  }
});
