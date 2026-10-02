/**
 * Niepelny eksport Freedom24 (serwer: success:true, complete:false) nie moze
 * nadpisac zapisanego, kompletnego raportu, ktory czyta silnik podatkowy.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { pobierzKompletZFreedom24 } from '../../../aplikacje/web/src/portfel/services/freedom24Komplet.ts';
import { runtimeApi } from '../../../aplikacje/web/src/invest_analyzer/services/runtimeApi.ts';
import type { BrokerAccount } from '../../../aplikacje/web/src/portfel/types.ts';

const konto = { brokerType: 'FREEDOM24' } as unknown as BrokerAccount;

async function zAtrapami(
  odpowiedz: Record<string, unknown>,
  uruchom: (zapisy: string[][]) => Promise<void>
) {
  const oryginalnyFetch = globalThis.fetch;
  const oryginalnyImport = runtimeApi.importFilesToStorage;
  const zapisy: string[][] = [];
  globalThis.fetch = (async () => new Response(JSON.stringify(odpowiedz), { status: 200 })) as typeof fetch;
  runtimeApi.importFilesToStorage = (async (pliki: Array<{ fileName: string }>) => {
    zapisy.push(pliki.map((plik) => plik.fileName));
    return { imported: [], skipped: [], failed: [], warnings: [] };
  }) as unknown as typeof runtimeApi.importFilesToStorage;
  try {
    await uruchom(zapisy);
  } finally {
    globalThis.fetch = oryginalnyFetch;
    runtimeApi.importFilesToStorage = oryginalnyImport;
  }
}

const raport = { trades: [{ q: 1 }], cash_flows: [], positions: [] };

test('niepelny raport maklerski nie nadpisuje zapisanych plikow i wymienia brakujace sekcje', async () => {
  await zAtrapami(
    {
      success: true, complete: false, missingSections: ['commissions', 'in_outs'],
      report: raport, raportMaklerski: { trades: [] }, raportDepozytariusza: { depo: [] },
    },
    async (zapisy) => {
      await assert.rejects(
        () => pobierzKompletZFreedom24(konto),
        /Nie zapisano raportu maklerskiego: Freedom24 nie zwróciło sekcji commissions, in_outs; spróbuj ponownie/
      );
      assert.deepEqual(zapisy, [], 'zadne pliki nie moga zostac zapisane');
    }
  );
});

test('brak sekcji pozycji w odpowiedzi jest bledem przed zapisem, a nie TypeError po nim', async () => {
  await zAtrapami(
    { success: true, complete: true, missingSections: [], report: { trades: [], cash_flows: [], positions: null } },
    async (zapisy) => {
      await assert.rejects(() => pobierzKompletZFreedom24(konto), /pozycji/);
      assert.deepEqual(zapisy, [], 'nic nie moze zostac zapisane');
    }
  );
});

test('kompletny eksport zapisuje raport glowny, maklerski i depozytariusza', async () => {
  await zAtrapami(
    {
      success: true, complete: true, missingSections: [],
      report: raport, raportMaklerski: { trades: [] }, raportDepozytariusza: { depo: [] },
    },
    async (zapisy) => {
      const wynik = await pobierzKompletZFreedom24(konto);
      assert.equal(zapisy.length, 1);
      assert.equal(zapisy[0].length, 3);
      assert.deepEqual(wynik.brakujaceSekcje, []);
    }
  );
});
