import test from 'node:test';
import assert from 'node:assert/strict';

import {
  polaRachunkuPoSynchronizacji,
  rodzajPoBleduKompletu,
  rodzajWynikuSynchronizacji,
} from '../../../aplikacje/web/src/portfel/services/statusSynchronizacji.ts';

const poprzedni = { lastSyncAt: '2026-01-01T00:00:00.000Z', isApiConnected: false };
const TERAZ = '2026-09-29T10:00:00.000Z';

test('sukces ustawia lastSyncAt i status SUCCESS', () => {
  const pola = polaRachunkuPoSynchronizacji({ success: true, message: 'ok' }, poprzedni, TERAZ);
  assert.equal(pola.lastSyncAt, TERAZ);
  assert.equal(pola.lastSyncStatus, 'SUCCESS');
  assert.equal(pola.isApiConnected, true);
  assert.equal(pola.lastError, undefined);
});

test('blad nie przesuwa lastSyncAt i daje ERROR z komunikatem', () => {
  const pola = polaRachunkuPoSynchronizacji({ success: false, error: 'odrzucono', message: 'x', errorCode: 'AUTH' }, poprzedni, TERAZ);
  assert.equal(pola.lastSyncAt, poprzedni.lastSyncAt);
  assert.equal(pola.lastSyncStatus, 'ERROR');
  assert.equal(pola.lastError, 'odrzucono');
  assert.equal(pola.lastErrorCode, 'AUTH');
});

test('rachunek bez publicznego API dostaje IDLE, nie ERROR, i nie ma bledu', () => {
  const wynik = { success: false, message: 'brak API', errorCode: 'BRAK_PUBLICZNEGO_API' };
  assert.equal(rodzajWynikuSynchronizacji(wynik), 'BEZ_API');
  const pola = polaRachunkuPoSynchronizacji(wynik, poprzedni, TERAZ);
  assert.equal(pola.lastSyncStatus, 'IDLE');
  assert.equal(pola.lastError, undefined);
  assert.equal(pola.lastSyncAt, poprzedni.lastSyncAt);
  // Kod desktopu przekazuje wywolujacy.
  assert.equal(rodzajWynikuSynchronizacji({ success: false, errorCode: 'NIEDOSTEPNE_W_DESKTOPIE' }), 'BLAD');
  assert.equal(rodzajWynikuSynchronizacji({ success: false, errorCode: 'NIEDOSTEPNE_W_DESKTOPIE' }, ['NIEDOSTEPNE_W_DESKTOPIE']), 'BEZ_API');
});

test('nieudane pobranie kompletu Freedom24 zmienia sukces rachunku w blad (zbiorcza nie jest zielona)', () => {
  // Transakcje z API sie udaly, ale magazyn silnika nie zostal odswiezony kompletem.
  assert.equal(rodzajPoBleduKompletu('SUKCES'), 'BLAD');
  // Inne wyniki zostaja: rachunek bez API nie jest bledem kompletu, blad nie robi sie lepszy.
  assert.equal(rodzajPoBleduKompletu('BEZ_API'), 'BEZ_API');
  assert.equal(rodzajPoBleduKompletu('BLAD'), 'BLAD');
});

import { stanBleduKarty, wynikZKompletem } from '../../../aplikacje/web/src/portfel/services/statusSynchronizacji.ts';

test('blad kompletu Freedom24 zmienia sukces synchronizacji w ERROR z poprzednim lastSyncAt', () => {
  const wynik = wynikZKompletem({ success: true, message: 'ok' }, 'HTTP 502');
  assert.equal(wynik.success, false);
  const pola = polaRachunkuPoSynchronizacji(wynik, poprzedni, TERAZ);
  assert.equal(pola.lastSyncStatus, 'ERROR');
  assert.equal(pola.lastSyncAt, poprzedni.lastSyncAt);
  assert.match(pola.lastError ?? '', /HTTP 502/);
  // Bez bledu kompletu wynik zostaje, a porazka synchronizacji nie jest nadpisywana.
  const ok = { success: true, message: 'ok' };
  assert.equal(wynikZKompletem(ok, null), ok);
  const porazka = { success: false, message: 'x', error: 'y' };
  assert.equal(wynikZKompletem(porazka, 'HTTP 502'), porazka);
});

test('udany test API nie zaslania bledu synchronizacji na karcie rachunku', () => {
  const rachunek = { lastSyncStatus: 'ERROR' as const, lastError: 'komplet nie pobrany', lastErrorCode: 'KOMPLET_NIEPELNY', statusMessage: 'x', diagnostics: undefined };
  const stan = stanBleduKarty(rachunek, { success: true, message: 'Połączenie działa' }, false);
  assert.equal(stan.maBlad, true);
  assert.equal(stan.komunikat, 'komplet nie pobrany');
  assert.equal(stan.kod, 'KOMPLET_NIEPELNY');
  // Nieudany test jest pokazywany, a rachunek bez bledow z udanym testem jest czysty.
  assert.equal(stanBleduKarty({ lastSyncStatus: 'SUCCESS' }, { success: false, error: 'odrzucono' }, false).komunikat, 'odrzucono');
  assert.equal(stanBleduKarty({ lastSyncStatus: 'SUCCESS' }, { success: true, message: 'ok' }, false).maBlad, false);
  assert.equal(stanBleduKarty(rachunek, undefined, true).maBlad, false);
});
