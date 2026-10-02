/**
 * Przebiegi silnika w trybie przegladarkowym.
 *
 * Odpowiedz silnika wazy megabajty (kanoniczne wejscie, dossier transakcji,
 * wiersze historii), a przeliczenie rusza po kazdej zmianie transakcji.
 * Wpisy trzeba wiec zwalniac - inaczej rejestr rosnie przez cala sesje
 * i zjada pamiec karty. Status musi tez odpowiadac stanowi przebiegu:
 * wczesniej mowil "done" juz w pierwszej chwili, wiec wskaznik postepu
 * pokazywal 100% w trakcie liczenia.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { webRuntimeApi } from '../../../aplikacje/web/src/invest_analyzer/services/runtimeApi.web.ts';

type Odpowiedz = { success: boolean; [klucz: string]: unknown };

/** Podmienia samo uruchomienie silnika, zeby test nie potrzebowal serwera. */
function podstawPrzebieg(zwrot: () => Promise<Odpowiedz>) {
  const oryginalny = webRuntimeApi.runTaxEngine;
  (webRuntimeApi as unknown as { runTaxEngine: unknown }).runTaxEngine = zwrot;
  return () => {
    (webRuntimeApi as unknown as { runTaxEngine: unknown }).runTaxEngine = oryginalny;
  };
}

const ZADANIE = { year: 2024, runMode: 'SAFE', taxPlan: 'aggressive_user' } as never;

test('status mowi o przebiegu w toku, dopoki wynik nie jest gotowy', async () => {
  let zwolnij: (wynik: Odpowiedz) => void = () => undefined;
  const przywroc = podstawPrzebieg(
    () => new Promise<Odpowiedz>((resolve) => {
      zwolnij = resolve;
    })
  );
  try {
    const { jobId } = await webRuntimeApi.startTaxEngineJob(ZADANIE);

    const wTrakcie = await webRuntimeApi.getTaxEngineJobStatus(jobId);
    assert.equal(wTrakcie.state, 'running', 'przebieg jeszcze trwa');
    assert.ok(wTrakcie.progress < 100, 'postep nie moze pokazywac 100% w trakcie');

    zwolnij({ success: true });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const poZakonczeniu = await webRuntimeApi.getTaxEngineJobStatus(jobId);
    assert.equal(poZakonczeniu.state, 'done');
    assert.equal(poZakonczeniu.progress, 100);
  } finally {
    przywroc();
  }
});

test('odebranie wyniku zwalnia wpis z rejestru', async () => {
  const przywroc = podstawPrzebieg(async () => ({ success: true, duzo: 'danych' }));
  try {
    const { jobId } = await webRuntimeApi.startTaxEngineJob(ZADANIE);
    const wynik = await webRuntimeApi.getTaxEngineJobResult(jobId);
    assert.equal((wynik as unknown as Odpowiedz).success, true);

    await assert.rejects(
      () => webRuntimeApi.getTaxEngineJobResult(jobId),
      /Nieznany job/,
      'po odebraniu wyniku wpis nie moze zostac w pamieci',
    );
  } finally {
    przywroc();
  }
});

test('blad przebiegu tez zwalnia wpis i dociera do wywolujacego', async () => {
  const przywroc = podstawPrzebieg(async () => {
    throw new Error('silnik nie wystartowal');
  });
  try {
    const { jobId } = await webRuntimeApi.startTaxEngineJob(ZADANIE);
    await assert.rejects(() => webRuntimeApi.getTaxEngineJobResult(jobId), /silnik nie wystartowal/);
    await assert.rejects(() => webRuntimeApi.getTaxEngineJobResult(jobId), /Nieznany job/);
  } finally {
    przywroc();
  }
});

test('anulowanie usuwa wpis', async () => {
  const przywroc = podstawPrzebieg(async () => ({ success: true }));
  try {
    const { jobId } = await webRuntimeApi.startTaxEngineJob(ZADANIE);
    await webRuntimeApi.cancelTaxEngineJob(jobId);
    await assert.rejects(() => webRuntimeApi.getTaxEngineJobStatus(jobId), /Nieznany job/);
  } finally {
    przywroc();
  }
});

test('odpowiedz z pamieci serwera nie nadpisuje czasu przebiegu uzywanego do szacunku postepu', async () => {
  const KLUCZ = 'investAnalyzer:lastEngineRunMs';
  const magazyn = new Map<string, string>();
  const oryginalnyMagazyn = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (klucz: string) => magazyn.get(klucz) ?? null,
      setItem: (klucz: string, wartosc: string) => void magazyn.set(klucz, String(wartosc)),
      removeItem: (klucz: string) => void magazyn.delete(klucz),
    },
  });
  const oryginalnyFetch = globalThis.fetch;
  let zPamieci = true;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ success: true, cached: zPamieci }), { status: 200 })) as typeof fetch;
  try {
    magazyn.set(KLUCZ, '70000');
    await webRuntimeApi.runTaxEngine(ZADANIE);
    assert.equal(magazyn.get(KLUCZ), '70000', 'trafienie w pamiec serwera to nie czas liczenia');

    zPamieci = false;
    await webRuntimeApi.runTaxEngine(ZADANIE);
    assert.notEqual(magazyn.get(KLUCZ), '70000', 'prawdziwy przebieg aktualizuje szacunek');
  } finally {
    globalThis.fetch = oryginalnyFetch;
    if (oryginalnyMagazyn) Object.defineProperty(globalThis, 'localStorage', oryginalnyMagazyn);
    else delete (globalThis as { localStorage?: unknown }).localStorage;
  }
});
