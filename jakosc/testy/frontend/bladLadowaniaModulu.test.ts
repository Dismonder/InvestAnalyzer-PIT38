import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ErrorBoundary,
  czyBladLadowaniaModulu,
  moznaPrzeladowacPoBledzieModulu,
} from '../../../aplikacje/web/src/invest_analyzer/components/ErrorBoundary.tsx';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

test('brakujacy modul przy dzialajacym serwerze nie petli przeladowan co 2 s', () => {
  const pamiec = new Map<string, string>();
  const magazyn = { getItem: (k: string) => pamiec.get(k) ?? null, setItem: (k: string, v: string) => void pamiec.set(k, v) };
  assert.equal(moznaPrzeladowacPoBledzieModulu(magazyn, 1_000_000), true);
  assert.equal(moznaPrzeladowacPoBledzieModulu(magazyn, 1_002_000), false);
  assert.equal(moznaPrzeladowacPoBledzieModulu(magazyn, 1_061_000), true);
});

test('bez dzialajacego sessionStorage nie ma automatycznego przeladowania', () => {
  const zepsuty = { getItem: () => { throw new Error('SecurityError'); }, setItem: () => undefined };
  assert.equal(moznaPrzeladowacPoBledzieModulu(zepsuty, 1), false);
});

test('fallback błędu modułu zawsze pozwala ręcznie odświeżyć stronę', () => {
  const boundary = new ErrorBoundary({ children: null });
  boundary.state = {
    hasError: true,
    error: new TypeError('Failed to fetch dynamically imported module'),
    recoveryBusy: false,
    recoveryMessage: null,
  };
  const markup = renderToStaticMarkup(boundary.render());
  assert.match(markup, /Nie udało się załadować części aplikacji/);
  assert.match(markup, /Odśwież stronę/);
  assert.doesNotMatch(markup, /odświeży się sama/i);
});

test('zatrzymany serwer to nie uszkodzone dane: ekran nie moze proponowac kasowania decyzji', () => {
  assert.equal(
    czyBladLadowaniaModulu(
      new TypeError('Failed to fetch dynamically imported module: http://localhost:3000/src/portfel/components/TaxDashboard.tsx'),
    ),
    true,
  );
  assert.equal(czyBladLadowaniaModulu(new Error('Loading chunk 12 failed.')), true);
  assert.equal(czyBladLadowaniaModulu(new TypeError('error loading dynamically imported module')), true);
});

test('prawdziwy blad danych nadal prowadzi do ekranu odzyskiwania', () => {
  assert.equal(czyBladLadowaniaModulu(new SyntaxError('Unexpected token } in JSON at position 10')), false);
  assert.equal(czyBladLadowaniaModulu(new TypeError("Cannot read properties of undefined (reading 'map')")), false);
  assert.equal(czyBladLadowaniaModulu(null), false);
});
