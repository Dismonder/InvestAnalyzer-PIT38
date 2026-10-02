import test from 'node:test';
import assert from 'node:assert/strict';

import { eksportKwarantanny, listaKwarantanny, usunZKwarantanny } from '../../../aplikacje/web/src/invest_analyzer/services/kwarantanna.ts';

function magazyn(start: Record<string, string>) {
  const dane = new Map(Object.entries(start));
  return {
    dane,
    get length() { return dane.size; },
    key: (i: number) => [...dane.keys()][i] ?? null,
    getItem: (k: string) => dane.get(k) ?? null,
    removeItem: (k: string) => { dane.delete(k); },
  };
}

const paczka = JSON.stringify({ createdAt: '2026-09-30T10:00:00.000Z', entries: [
  { key: 'pit38_accounts', value: '[{"id":"acc","apiKey":"SEKRET"' },
  { key: 'fundingFeeEntries', value: '{"niedomkniete":' },
] });

test('lista pokazuje paczki panelu błędu i wpisy odłożone przy odczycie, pomijając resztę magazynu', () => {
  const m = magazyn({
    pit38_transactions: '[]',
    'investAnalyzer:recovery-quarantine:1790000000000': paczka,
    'investAnalyzer:recovery-quarantine:1790000005000': '{zepsuta paczka',
    'pit38_alerts:uszkodzony': '[{"id":',
    'inna-aplikacja:profil': '{obce',
  });
  const lista = listaKwarantanny(m);
  // Najnowsze na gorze: czas z tresci paczki (30.09) wygrywa z czasem w kluczu (21.09).
  assert.deepEqual(lista.map((p) => p.klucz), [
    'investAnalyzer:recovery-quarantine:1790000000000',
    'investAnalyzer:recovery-quarantine:1790000005000',
    'pit38_alerts:uszkodzony',
  ]);
  assert.deepEqual(lista[0], {
    klucz: 'investAnalyzer:recovery-quarantine:1790000000000', rodzaj: 'panel-bledu',
    utworzono: '2026-09-30T10:00:00.000Z', wpisy: ['pit38_accounts', 'fundingFeeEntries'], znaki: paczka.length,
  });
  assert.equal(lista[1].utworzono, new Date(1790000005000).toISOString(), 'czas z klucza, gdy paczka nieczytelna');
  assert.deepEqual(lista[1].wpisy, ['(nieczytelna paczka)']);
  assert.deepEqual(lista[2], { klucz: 'pit38_alerts:uszkodzony', rodzaj: 'odczyt', utworzono: null, wpisy: ['pit38_alerts'], znaki: 7 });
});

test('eksport oddaje surową treść bez zmian, a usuwanie nie rusza niczego poza kwarantanną', () => {
  const m = magazyn({
    pit38_transactions: '[]',
    'investAnalyzer:recovery-quarantine:1790000000000': paczka,
    'pit38_alerts:uszkodzony': '[{"id":',
  });
  const plik = JSON.parse(eksportKwarantanny(m, ['investAnalyzer:recovery-quarantine:1790000000000', 'brak-takiego', 'pit38_alerts:uszkodzony']));
  assert.equal(plik.rodzaj, 'investanalyzer-kwarantanna');
  assert.deepEqual(plik.wpisy, [
    { klucz: 'investAnalyzer:recovery-quarantine:1790000000000', wartosc: paczka },
    { klucz: 'pit38_alerts:uszkodzony', wartosc: '[{"id":' },
  ]);

  assert.equal(usunZKwarantanny(m, ['pit38_transactions', 'investAnalyzer:recovery-quarantine:1790000000000', 'brak-takiego']), 1);
  assert.deepEqual([...m.dane.keys()], ['pit38_transactions', 'pit38_alerts:uszkodzony']);
});

test('panel kwarantanny nie renderuje się przy pustej kwarantannie, a z wpisami pokazuje je bez surowej treści', async () => {
  const React = (await import('react')).default;
  const { renderToStaticMarkup } = await import('react-dom/server');
  const { KwarantannaPanel } = await import('../../../aplikacje/web/src/invest_analyzer/components/KwarantannaPanel.tsx');
  const pusty = magazyn({ pit38_transactions: '[]' });
  assert.equal(renderToStaticMarkup(React.createElement(KwarantannaPanel, { magazyn: pusty as unknown as Storage })), '');

  const zWpisami = magazyn({ 'investAnalyzer:recovery-quarantine:1790000000000': paczka });
  const markup = renderToStaticMarkup(React.createElement(KwarantannaPanel, { magazyn: zWpisami as unknown as Storage }));
  assert.match(markup, /Kwarantanna nieczytelnych wpisów/);
  assert.match(markup, /pit38_accounts, fundingFeeEntries/);
  assert.match(markup, /2 wpisy/);
  assert.doesNotMatch(markup, /SEKRET/, 'surowa treść (z sekretem) nie trafia na ekran');
  assert.match(markup, /Pobierz/);
  assert.match(markup, /Usuń/);
});
