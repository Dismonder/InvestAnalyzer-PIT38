import test from 'node:test';
import assert from 'node:assert/strict';
import { czyRejestrowacServiceWorker } from '../../../aplikacje/web/src/shared/rejestracjaPwa.ts';

const zSW = { navigator: { serviceWorker: {} } };

test('service worker rejestruje sie tylko w wydaniu produkcyjnym na https albo localhost', () => {
  assert.equal(czyRejestrowacServiceWorker({ ...zSW, location: { protocol: 'https:', hostname: 'app.example' } }, true), true);
  assert.equal(czyRejestrowacServiceWorker({ ...zSW, location: { protocol: 'http:', hostname: 'localhost' } }, true), true);
  assert.equal(czyRejestrowacServiceWorker({ ...zSW, location: { protocol: 'http:', hostname: '192.168.0.5' } }, true), false, 'http poza localhost: przegladarka i tak odmowi');
  assert.equal(czyRejestrowacServiceWorker({ ...zSW, location: { protocol: 'https:', hostname: 'app.example' } }, false), false, 'serwer deweloperski nie ma sw.js');
});

test('desktop (Tauri) i przegladarka bez service workera nie rejestruja', () => {
  assert.equal(czyRejestrowacServiceWorker({ ...zSW, location: { protocol: 'tauri:', hostname: 'localhost' } }, true), false);
  assert.equal(czyRejestrowacServiceWorker({ ...zSW, location: { protocol: 'http:', hostname: 'tauri.localhost' } }, true), false);
  assert.equal(czyRejestrowacServiceWorker({ ...zSW, __TAURI_INTERNALS__: {}, location: { protocol: 'https:', hostname: 'x' } }, true), false);
  assert.equal(czyRejestrowacServiceWorker({ navigator: {}, location: { protocol: 'https:', hostname: 'x' } }, true), false);
});
