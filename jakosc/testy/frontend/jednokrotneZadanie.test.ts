import test from 'node:test';
import assert from 'node:assert/strict';

import { wykonajJednokrotnie } from '../../../aplikacje/web/src/portfel/services/jednokrotneZadanie.ts';

test('pomija równoległe wysłanie formularza, ale zwalnia blokadę po zakończeniu', async () => {
  const blokada = { current: false };
  let zakoncz!: (wartosc: string) => void;
  let wywolania = 0;
  const pierwsze = wykonajJednokrotnie(blokada, () => {
    wywolania += 1;
    return new Promise<string>((resolve) => { zakoncz = resolve; });
  });

  assert.equal(await wykonajJednokrotnie(blokada, async () => {
    wywolania += 1;
    return 'drugie';
  }), undefined);
  assert.equal(wywolania, 1);

  zakoncz('pierwsze');
  assert.equal(await pierwsze, 'pierwsze');
  assert.equal(await wykonajJednokrotnie(blokada, async () => 'ponowione'), 'ponowione');
});

test('zwalnia blokadę, gdy akcja formularza odrzuci promise', async () => {
  const blokada = { current: false };
  const blad = new Error('odrzucone');

  await assert.rejects(wykonajJednokrotnie(blokada, async () => { throw blad; }), blad);
  assert.equal(blokada.current, false);
  assert.equal(await wykonajJednokrotnie(blokada, async () => 'ponowione'), 'ponowione');
});
