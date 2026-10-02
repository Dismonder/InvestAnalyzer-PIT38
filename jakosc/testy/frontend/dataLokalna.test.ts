import test from "node:test";
import assert from "node:assert/strict";

import { dataIstnieje } from "../../../aplikacje/web/src/portfel/services/xmlExporter.ts";
import { dzisiajLokalnie } from "../../../aplikacje/web/src/portfel/services/formularzTransakcji.ts";

// Kilka minut po polnocy czasu lokalnego. W strefie na wschod od UTC (Polska)
// `toISOString()` daje wtedy jeszcze wczorajsza date.
const tuzPoPolnocy = new Date(2026, 0, 1, 0, 30);

test("dzisiaj liczone jest wg czasu lokalnego, nie UTC", () => {
  assert.equal(dzisiajLokalnie(tuzPoPolnocy), "2026-01-01");
});

test("data urodzenia rowna dzisiejszej jest dopuszczalna tuz po polnocy", () => {
  assert.equal(dataIstnieje("2026-01-01", tuzPoPolnocy), true);
  assert.equal(dataIstnieje("2026-01-02", tuzPoPolnocy), false);
});
