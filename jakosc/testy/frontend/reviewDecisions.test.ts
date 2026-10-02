/**
 * E2E-01: zdarzenia czekające na decyzję muszą dać się rozstrzygnąć w interfejsie.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { createMemoryStorageSource } from '../../../aplikacje/web/src/invest_analyzer/services/taxEngineConfig.ts';
import { ReviewDecisionsPanel } from '../../../aplikacje/web/src/invest_analyzer/components/ReviewDecisionsPanel.tsx';
import {
  readReviewDecisions,
  readReviewQueue,
  buildBonusContestShareProposal,
  czyPozycjaRozstrzygnieta,
  saveReviewDecisions,
  setReviewDecision,
} from '../../../aplikacje/web/src/invest_analyzer/services/reviewDecisions.ts';

test('decyzja jest zapisywana, cofana i odporna na śmieci w magazynie', () => {
  const magazyn = createMemoryStorageSource();
  let decyzje = setReviewDecision([], 'stock_award|2025-02-01|PTON|1||', 'handled_manually', '2026-09-21T00:00:00.000Z');
  decyzje = setReviewDecision(decyzje, 'commission|2026-03-01||| 2.4|USD', 'no_tax_effect', '2026-09-21T00:00:00.000Z');
  saveReviewDecisions(magazyn, decyzje);
  assert.equal(readReviewDecisions(magazyn).length, 2);

  const poCofnieciu = setReviewDecision(readReviewDecisions(magazyn), 'stock_award|2025-02-01|PTON|1||', null);
  assert.deepEqual(poCofnieciu.map((d) => d.decision), ['no_tax_effect']);

  magazyn.setItem('reviewDecisions:v1', JSON.stringify([{ decisionKey: 'x', decision: 'odblokuj_wszystko' }, null, 7]));
  assert.deepEqual(readReviewDecisions(magazyn), []);
  magazyn.setItem('reviewDecisions:v1', '{zepsute');
  assert.deepEqual(readReviewDecisions(magazyn), []);
});

test('wybór rachunku PIT-8C przechodzi przez magazyn decyzji', () => {
  const magazyn = createMemoryStorageSource();
  const key = 'pit8c_source:import/unknown.xlsx';
  saveReviewDecisions(magazyn, setReviewDecision([], key, 'pit8c_account'));
  assert.equal(readReviewDecisions(magazyn)[0].decision, 'pit8c_account');
  saveReviewDecisions(magazyn, setReviewDecision(readReviewDecisions(magazyn), key, 'no_pit8c_account'));
  assert.equal(readReviewDecisions(magazyn)[0].decision, 'no_pit8c_account');
});

test('propozycja akcji bonusowej zachowuje brak wartości zamiast wpisywać zero', () => {
  const proposal = buildBonusContestShareProposal({
    decision_key: 'award-1', kind: 'stock_award', date: '2025-01-21', symbol: 'PTON.US',
    quantity: '1', amount: null, currency: 'USD', comment: 'WELCOME5', blocks_filing: true,
    decision: null, source_files: [], occurrences: 1,
  });
  assert.ok(proposal);
  assert.equal(proposal.values.grant_market_value, null);
  assert.equal(proposal.values.promotion_basis, 'WELCOME5');
  assert.equal(proposal.recordType, 'BONUS_CONTEST_SHARE');
});

test('kolejka pochodzi z odpowiedzi silnika; brak pola to pusta lista, nie błąd', () => {
  assert.deepEqual(readReviewQueue(null), []);
  assert.deepEqual(readReviewQueue({ canonical_tax_input_consumption_runtime: {} }), []);
  const kolejka = readReviewQueue({
    canonical_tax_input_consumption_runtime: {
      reviewQueue: [{ decision_key: 'k', kind: 'stock_award', blocks_filing: true, source_files: [], occurrences: 3 }, 'śmieć'],
    },
  });
  assert.equal(kolejka.length, 1);
  assert.equal(kolejka[0].occurrences, 3);
});

test('wskazówka FIFO pojawia się wyłącznie dla zdarzenia zmieniającego liczbę akcji', () => {
  const base = {
    kind: 'corporate_action', date: '2025-01-21', symbol: 'AAPL.US', quantity: null,
    amount: null, currency: null, comment: null, blocks_filing: true, decision: null,
    source_files: [], occurrences: 1,
  };
  const markup = renderToStaticMarkup(React.createElement(ReviewDecisionsPanel, {
    queue: [
      { ...base, decision_key: 'split', changes_share_count: true },
      { ...base, decision_key: 'other', changes_share_count: false },
      { ...base, decision_key: 'legacy' },
    ],
    selectedYear: 2025,
    onRecalculate: () => undefined,
  }));
  assert.equal(markup.match(/Podział lub scalenie akcji nie jest przychodem/g)?.length, 1);
  assert.ok(markup.includes('kwota bez zmian'));
  assert.equal(markup.match(/Sprawdziłem: nie wpływa na PIT/g)?.length, 3);
  assert.equal(markup.match(/Ująłem ręcznie w historii \(np\. akcja bonusowa z kosztem\)/g)?.length, 3);
});

const NOTATKA_PODZIALU = 'Podział lub scalenie akcji zmienia koszt nabycia - skoryguj partie w Historii i oznacz zdarzenie jako „Ująłem ręcznie w historii”.';
const pozycjaNiewystarczajaca = {
  decision_key: 'split-sold', kind: 'corporate_action', date: '2026-01-21', symbol: 'AAPL.US', quantity: null,
  amount: null, currency: null, comment: null, blocks_filing: true, decision: 'no_tax_effect',
  source_files: [], occurrences: 1, changes_share_count: true, blocks_when_sold: true,
  decision_insufficient: true, blocking_note: NOTATKA_PODZIALU,
};

test('decyzja „bez wpływu” nie rozstrzyga pozycji, którą silnik uznał za niewystarczającą', () => {
  assert.equal(czyPozycjaRozstrzygnieta(pozycjaNiewystarczajaca, 'no_tax_effect'), false);
  assert.equal(czyPozycjaRozstrzygnieta(pozycjaNiewystarczajaca, 'handled_manually'), true);
  assert.equal(czyPozycjaRozstrzygnieta(pozycjaNiewystarczajaca, undefined), false);
  // Pozycja bez flagi (starszy silnik) zachowuje dotychczasowe zachowanie.
  const zwykla = { ...pozycjaNiewystarczajaca, decision_insufficient: undefined, blocking_note: undefined };
  assert.equal(czyPozycjaRozstrzygnieta(zwykla, 'no_tax_effect'), true);
  assert.equal(czyPozycjaRozstrzygnieta({ ...zwykla, kind: 'pit8c_source' }, 'no_tax_effect'), false);
  assert.equal(czyPozycjaRozstrzygnieta({ ...zwykla, kind: 'pit8c_source' }, 'pit8c_account'), true);
});

test('panel pokazuje uwagę silnika i nie liczy niewystarczającej decyzji jako rozstrzygniętej', () => {
  const zapis = new Map<string, string>([['reviewDecisions:v1', JSON.stringify([
    { decisionKey: 'split-sold', decision: 'no_tax_effect', updatedAt: '2026-09-21T00:00:00.000Z' },
  ])]]);
  const poprzedni = globalThis.localStorage;
  globalThis.localStorage = {
    getItem: (klucz: string) => zapis.get(klucz) ?? null,
    setItem: (klucz: string, wartosc: string) => { zapis.set(klucz, wartosc); },
  } as Storage;
  try {
    const markup = renderToStaticMarkup(React.createElement(ReviewDecisionsPanel, {
      queue: [pozycjaNiewystarczajaca, { ...pozycjaNiewystarczajaca, decision_key: 'ok', decision_insufficient: false, blocking_note: undefined }],
      selectedYear: 2026,
      onRecalculate: () => undefined,
    }));
    assert.ok(markup.includes('Podział lub scalenie akcji zmienia koszt nabycia'));
    assert.ok(markup.includes('Zapisana decyzja nie wystarcza'));
    // Obie pozycje blokują, żadna nie jest rozstrzygnięta: druga nie ma decyzji, pierwsza ma niewystarczającą.
    assert.ok(markup.includes('2 z 2 zdarzeń'));
  } finally {
    globalThis.localStorage = poprzedni;
  }
});
