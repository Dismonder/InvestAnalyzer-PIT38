/**
 * Synchronizacja z brokerem nie tworzy transakcji, ktorych nie bylo.
 *
 * Binance: saldo bez pokrycia w historii bylo dopisywane do listy transakcji
 * jako zakup dokonany DZIS, po cenie 1 USD, z zerowa prowizja. Saldo 0,5 BTC
 * dostawalo koszt nabycia 0,50 USD - portfel pokazywal kilkadziesiat tysiecy
 * dolarow zysku, a rozliczenie podatku bralo te liczbe za prawde.
 *
 * IBKR: otwarta pozycja bez transakcji w raporcie stawala sie zakupem
 * z dzisiejsza data. Data decyduje o kursie NBP i o roku podatkowym.
 *
 * W obu przypadkach odpowiedz brzmiala "Pobrano wszystkie dane".
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  syncBinanceTrades,
  syncIBKRTrades,
  syncFreedom24Trades,
} from '../../../aplikacje/web/src/server/routes/brokers.ts';

const DZIS = new Date().toISOString().slice(0, 10);

/** Podmienia fetch na tablice odpowiedzi dobieranych po fragmencie adresu. */
function zPodmienionymFetch(
  odpowiedzi: Array<{ gdy: string; odpowiedz: () => Response }>,
  cialo: () => Promise<void>
) {
  const oryginalny = globalThis.fetch;
  globalThis.fetch = (async (wejscie: any) => {
    const adres = String(wejscie);
    const trafienie = odpowiedzi.find((o) => adres.includes(o.gdy));
    if (trafienie) return trafienie.odpowiedz();
    if (adres.includes('/api/v3/exchangeInfo')) {
      return json({ symbols: [{ symbol: 'BTCUSDT', baseAsset: 'BTC', quoteAsset: 'USDT' }] });
    }
    throw new Error(`nieoczekiwane zapytanie: ${adres.slice(0, 60)}`);
  }) as typeof fetch;
  return cialo().finally(() => {
    globalThis.fetch = oryginalny;
  });
}

const json = (dane: unknown) =>
  new Response(JSON.stringify(dane), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });

test('saldo Binance bez historii nie staje sie dzisiejszym zakupem po 1 USD', async () => {
  await zPodmienionymFetch(
    [
      {
        gdy: '/api/v3/account',
        odpowiedz: () => json({ balances: [{ asset: 'BTC', free: '0.5', locked: '0' }] }),
      },
      { gdy: '/api/v3/myTrades', odpowiedz: () => json([]) },
    ],
    async () => {
      const wynik: any = await syncBinanceTrades({
        accountId: 'a1',
        apiKey: 'k',
        apiSecret: 's',
      } as any);

      assert.equal(wynik.syncedTransactions.length, 0, 'saldo to nie transakcja');
      assert.ok(
        !wynik.syncedTransactions.some((t: any) => t.pricePerUnit === 1),
        'cena 1 USD byla wartoscia zastepcza, nie notowaniem'
      );
      assert.ok(Array.isArray(wynik.ostrzezenia) && wynik.ostrzezenia.length > 0);
      assert.match(wynik.ostrzezenia.join(' '), /0\.5 BTC/);
      assert.doesNotMatch(
        String(wynik.message),
        /wszystkie dane/i,
        'komunikat nie moze twierdzic, ze pobrano wszystko'
      );
    }
  );
});

test('prawdziwa transakcja Binance przechodzi bez zmian', async () => {
  await zPodmienionymFetch(
    [
      { gdy: '/api/v3/account', odpowiedz: () => json({ balances: [] }) },
      {
        gdy: 'symbol=BTCUSDT',
        odpowiedz: () =>
          json([
            {
              id: 7,
              orderId: 9,
              isBuyer: true,
              time: Date.parse('2024-03-05T10:00:00Z'),
              qty: '0.25',
              price: '61000',
              commission: '0.1',
              commissionAsset: 'USDT',
            },
          ]),
      },
      { gdy: '/api/v3/myTrades', odpowiedz: () => json([]) },
    ],
    async () => {
      const wynik: any = await syncBinanceTrades({
        accountId: 'a1',
        apiKey: 'k',
        apiSecret: 's',
      } as any);

      const kupno = wynik.syncedTransactions.find((t: any) => t.ticker === 'BTC');
      assert.ok(kupno, 'transakcja z API musi zostac');
      assert.equal(kupno.date, '2024-03-05', 'data pochodzi z API, nie z dzisiaj');
      assert.equal(kupno.pricePerUnit, 61000);
    }
  );
});

test('nieudany odczyt par Binance jest zglaszany, a nie przemilczany', async () => {
  await zPodmienionymFetch(
    [
      { gdy: '/api/v3/account', odpowiedz: () => json({ balances: [] }) },
      { gdy: '/api/v3/myTrades', odpowiedz: () => new Response('nope', { status: 418 }) },
    ],
    async () => {
      const wynik: any = await syncBinanceTrades({
        accountId: 'a1',
        apiKey: 'k',
        apiSecret: 's',
      } as any);

      assert.match(wynik.ostrzezenia.join(' '), /HTTP 418/);
      assert.doesNotMatch(String(wynik.message), /wszystkie dane/i);
    }
  );
});

test('otwarta pozycja IBKR nie staje sie dzisiejszym zakupem', async () => {
  const raport = `<FlexQueryResponse>
    <OpenPosition symbol="MSFT" position="12" costBasisPrice="300" currency="USD" assetCategory="STK" />
  </FlexQueryResponse>`;

  await zPodmienionymFetch(
    [
      {
        gdy: 'FlexStatementService.SendRequest',
        odpowiedz: () =>
          new Response('<FlexStatementResponse><Status>Success</Status><ReferenceCode>111</ReferenceCode><Url>https://ibkr.test/get</Url></FlexStatementResponse>'),
      },
      { gdy: 'ibkr.test/get', odpowiedz: () => new Response(raport) },
      { gdy: 'GetStatement', odpowiedz: () => new Response(raport) },
    ],
    async () => {
      const wynik: any = await syncIBKRTrades({
        accountId: 'a2',
        apiKey: 't',
        queryId: 'q',
      } as any);

      assert.ok(
        !wynik.syncedTransactions.some((t: any) => t.date === DZIS),
        'zaden zapis nie moze dostac dzisiejszej daty w zastepstwie prawdziwej'
      );
      assert.match(wynik.ostrzezenia.join(' '), /12 MSFT/);
      assert.doesNotMatch(String(wynik.message), /wszystkie dane/i);
    }
  );
});

test('transakcja IBKR bez daty jest pomijana, a nie datowana na dzis', async () => {
  const raport = `<FlexQueryResponse>
    <Trade symbol="AAPL" quantity="10" tradePrice="180" currency="USD" buySell="BUY" />
    <Trade symbol="MSFT" quantity="5" tradePrice="400" currency="USD" buySell="BUY" dateTime="20240311;101500" />
  </FlexQueryResponse>`;

  await zPodmienionymFetch(
    [
      {
        gdy: 'FlexStatementService.SendRequest',
        odpowiedz: () =>
          new Response('<FlexStatementResponse><Status>Success</Status><ReferenceCode>222</ReferenceCode></FlexStatementResponse>'),
      },
      { gdy: 'GetStatement', odpowiedz: () => new Response(raport) },
    ],
    async () => {
      const wynik: any = await syncIBKRTrades({
        accountId: 'a3',
        apiKey: 't',
        queryId: 'q',
      } as any);

      const tickery = wynik.syncedTransactions.map((t: any) => t.ticker);
      assert.ok(!tickery.includes('AAPL'), 'zapis bez daty nie moze wejsc do rozliczenia');
      assert.ok(tickery.includes('MSFT'), 'zapis z data ma zostac');
      assert.equal(
        wynik.syncedTransactions.find((t: any) => t.ticker === 'MSFT').date,
        '2024-03-11'
      );
      assert.match(wynik.ostrzezenia.join(' '), /AAPL/);
    }
  );
});

test('dywidenda bez podatku u zrodla nie dostaje stawki 15%', async () => {
  const raport = `<FlexQueryResponse>
    <CashTransaction type="Dividends" description="AAPL CASH DIVIDEND" symbol="AAPL" amount="42" currency="USD" dateTime="20240520" />
    <CashTransaction type="Dividends" description="MSFT CASH DIVIDEND" symbol="MSFT" amount="100" currency="USD" dateTime="20240521" />
    <CashTransaction type="Withholding Tax" description="MSFT CASH DIVIDEND - US TAX" symbol="MSFT" amount="-15" currency="USD" dateTime="20240521" />
  </FlexQueryResponse>`;

  await zPodmienionymFetch(
    [
      {
        gdy: 'FlexStatementService.SendRequest',
        odpowiedz: () =>
          new Response('<FlexStatementResponse><Status>Success</Status><ReferenceCode>333</ReferenceCode></FlexStatementResponse>'),
      },
      { gdy: 'GetStatement', odpowiedz: () => new Response(raport) },
    ],
    async () => {
      const wynik: any = await syncIBKRTrades({
        accountId: 'a4',
        apiKey: 't',
        queryId: 'q',
      } as any);

      const bezPodatku = wynik.syncedTransactions.find((t: any) => t.ticker === 'AAPL');
      assert.ok(bezPodatku, 'dywidenda ma zostac w rozliczeniu');
      assert.equal(bezPodatku.foreignTaxAmount, 0);
      assert.equal(
        bezPodatku.foreignTaxRate,
        undefined,
        'brak odczytanego podatku to nie jest stawka 15%'
      );

      const zPodatkiem = wynik.syncedTransactions.find((t: any) => t.ticker === 'MSFT');
      assert.equal(zPodatkiem.foreignTaxAmount, 15);
      assert.equal(zPodatkiem.foreignTaxRate, 15, 'stawka policzona z odczytanych kwot zostaje');
    }
  );
});

test('data IBKR z godzina po sredniku nie zostaje w polu daty', async () => {
  // "20240311;101500" konczylo wczesniej jako "2024-03-11;1" - slice(0,10)
  // ucinal lancuch w srodku, a podstawienie myslnikow nie sprzatalo reszty.
  const raport = `<FlexQueryResponse>
    <Trade symbol="TSLA" quantity="3" tradePrice="200" currency="USD" buySell="BUY" dateTime="20240311;101500" />
    <Trade symbol="AMZN" quantity="2" tradePrice="150" currency="USD" buySell="BUY" dateTime="2024-04-02" />
  </FlexQueryResponse>`;

  await zPodmienionymFetch(
    [
      {
        gdy: 'FlexStatementService.SendRequest',
        odpowiedz: () =>
          new Response('<FlexStatementResponse><Status>Success</Status><ReferenceCode>444</ReferenceCode></FlexStatementResponse>'),
      },
      { gdy: 'GetStatement', odpowiedz: () => new Response(raport) },
    ],
    async () => {
      const wynik: any = await syncIBKRTrades({
        accountId: 'a5',
        apiKey: 't',
        queryId: 'q',
      } as any);

      for (const t of wynik.syncedTransactions) {
        assert.match(t.date, /^\d{4}-\d{2}-\d{2}$/, `zla data: ${t.date}`);
        assert.ok(!Number.isNaN(Date.parse(t.date)), `nieparsowalna data: ${t.date}`);
      }
      assert.equal(
        wynik.syncedTransactions.find((t: any) => t.ticker === 'TSLA').date,
        '2024-03-11'
      );
      assert.equal(
        wynik.syncedTransactions.find((t: any) => t.ticker === 'AMZN').date,
        '2024-04-02'
      );
    }
  );
});

/** Odpowiedz Tradernet dobierana po poleceniu w ciele zadania. */
function tradernetFetch(poPoleceniu: Record<string, unknown>) {
  const oryginalny = globalThis.fetch;
  globalThis.fetch = (async (wejscie: any, opcje: any) => {
    const adres = String(wejscie);
    if (!/tradernet\.|freedom24\.com/.test(adres)) {
      throw new Error(`nieoczekiwane zapytanie: ${adres.slice(0, 60)}`);
    }
    const cialo = String(opcje?.body ?? '');
    const polecenie = Object.keys(poPoleceniu).find(
      (k) => cialo.includes(`"cmd":"${k}"`) || adres.endsWith(`/cmd/${k}`)
    );
    return new Response(JSON.stringify(polecenie ? poPoleceniu[polecenie] : { errMsg: 'nieznane' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;
  return () => {
    globalThis.fetch = oryginalny;
  };
}

test('otwarta pozycja Freedom24 nie staje sie dzisiejszym zakupem', async () => {
  const przywroc = tradernetFetch({
    getTradesHistory: { trades: { trade: [] } },
    getPositionJson: {
      result: { ps: { pos: [{ i: 'NVDA.US', q: '7', bal_price_a: '150', curr: 'USD' }] } },
    },
  });
  try {
    const wynik: any = await syncFreedom24Trades({
      accountId: 'f1',
      apiKey: 'klucz',
      apiSecret: 'sekret',
    } as any);

    assert.equal(wynik.syncedTransactions.length, 0, 'pozycja to nie transakcja');
    assert.match(wynik.ostrzezenia.join(' '), /7 NVDA/);
    assert.doesNotMatch(
      String(wynik.message),
      /rzeczywistych transakcji/i,
      'komunikat nie moze nazywac pozycji rzeczywista transakcja'
    );
  } finally {
    przywroc();
  }
});

test('transakcja Freedom24 bez daty jest pomijana, a prawdziwa zostaje', async () => {
  const przywroc = tradernetFetch({
    getTradesHistory: {
      trades: {
        trade: [
          { id: 1, instr_nm: 'AAPL.US', q: '10', p: '180', curr_c: 'USD', type: '1' },
          {
            id: 2,
            instr_nm: 'MSFT.US',
            q: '4',
            p: '400',
            curr_c: 'USD',
            type: '1',
            date: '2024-06-12 15:00:00',
          },
        ],
      },
    },
    getPositionJson: { result: { ps: { pos: [] } } },
  });
  try {
    const wynik: any = await syncFreedom24Trades({
      accountId: 'f2',
      apiKey: 'klucz',
      apiSecret: 'sekret',
    } as any);

    const tickery = wynik.syncedTransactions.map((t: any) => t.ticker);
    assert.deepEqual(tickery, ['MSFT'], 'tylko zapis z data wchodzi do rozliczenia');
    assert.equal(wynik.syncedTransactions[0].date, '2024-06-12');
    assert.match(wynik.ostrzezenia.join(' '), /AAPL/);
  } finally {
    przywroc();
  }
});

test('nieudany odczyt Freedom24 nie jest udana synchronizacja', async () => {
  const przywroc = tradernetFetch({});
  try {
    const wynik: any = await syncFreedom24Trades({
      accountId: 'f3',
      apiKey: 'klucz',
      apiSecret: 'sekret',
    } as any);

    assert.ok(wynik.ostrzezenia.length >= 2, 'obie proby odczytu maja byc zgloszone');
    assert.match(wynik.ostrzezenia.join(' '), /historii transakcji/i);
    assert.match(wynik.ostrzezenia.join(' '), /otwartych pozycji/i);
  } finally {
    przywroc();
  }
});

test('data transakcji to dzień zawarcia na giełdzie, nie znacznik księgowania', async () => {
  // Na prawdziwym rachunku 22 z 542 transakcji ma w polu `date` dzien pozniejszy
  // niz `trade_d_exch`: znacznik ksiegowania jest w innej strefie czasowej
  // i przy transakcjach z konca sesji przechodzi na kolejna dobe. Kurs NBP bierze
  // sie z dnia poprzedzajacego zdarzenie, wiec przesuniety dzien to inny kurs,
  // a na przelomie roku takze inny rok podatkowy.
  const przywroc = tradernetFetch({
    getTradesHistory: {
      trades: {
        trade: [
          {
            id: 1,
            instr_nm: 'NBIS.US',
            q: '15',
            p: '40.60',
            curr_c: 'USD',
            type: '1',
            date: '2025-06-05T22:59:58.000',
            trade_d_exch: '2025-06-04 16:02:40.990',
            pay_d: '2025-06-06T23:00:00.000',
          },
        ],
      },
    },
    getPositionJson: { result: { ps: { pos: [] } } },
  });

  try {
    const wynik: any = await syncFreedom24Trades({
      accountId: 'f1',
      apiKey: 'klucz',
      apiSecret: 'sekret',
    } as any);
    const transakcja = (wynik.syncedTransactions || [])[0];

    assert.ok(transakcja, 'transakcja musi zostac odczytana');
    assert.equal(transakcja.date, '2025-06-04', 'liczy sie dzien zawarcia na gieldzie');
    assert.notEqual(transakcja.date, '2025-06-05', 'znacznik ksiegowania to nie jest data zdarzenia');
    assert.notEqual(transakcja.date, '2025-06-06', 'dzien rozliczenia tez nie');
  } finally {
    przywroc();
  }
});
