import test from "node:test";
import assert from "node:assert/strict";

import {
  buildDisplayLogEntries,
  countBlockingDisplayLogs,
} from "../../../aplikacje/web/src/invest_analyzer/services/displayLogs.ts";
import type { LogEntry } from "../../../aplikacje/web/src/invest_analyzer/types.ts";

function log(overrides: Partial<LogEntry>): LogEntry {
  return {
    id: overrides.id || "log-1",
    timestamp: overrides.timestamp || "2026-05-13T12:00:00.000Z",
    level: overrides.level || "info",
    stage: overrides.stage || "AUTO_IMPORT",
    message: overrides.message || "test",
    details: overrides.details,
  };
}

test("buildDisplayLogEntries neutralizuje stary fałszywy błąd Traderzy.xlsx", () => {
  const [entry] = buildDisplayLogEntries([
    log({
      level: "error",
      message: "Błąd importu pliku Traderzy.xlsx",
      details: "Nie rozpoznano formatu pliku brokera.",
    }),
  ]);

  assert.equal(entry.displayLevel, "info");
  assert.equal(entry.userFacingKind, "technical_info");
  assert.match(entry.displayMessage, /podsumowanie brokera\/analitykę/i);
  assert.match(entry.displayMessage, /kontekstu źródeł/i);
  assert.equal(countBlockingDisplayLogs([entry]), 0);
});

test("buildDisplayLogEntries zostawia realny błąd transakcyjny jako blokujący", () => {
  const [entry] = buildDisplayLogEntries([
    log({
      level: "error",
      message: "Błąd importu pliku broken.json",
      details: "Nieprawidłowy JSON w pliku storage.",
    }),
  ]);

  assert.equal(entry.displayLevel, "error");
  assert.equal(entry.userFacingKind, "blocking_error");
  assert.equal(countBlockingDisplayLogs([entry]), 1);
});

test("buildDisplayLogEntries odróżnia dowody i kontrolę pomocniczą od błędów", () => {
  const entries = buildDisplayLogEntries([
    log({ level: "info", message: "Pominięto Stawki.pdf: plik jest tylko dowodem." }),
    log({ level: "info", message: "Pominięto raport depozytariusza: służy do kontroli pozycji." }),
  ]);

  assert.deepEqual(entries.map((entry) => entry.userFacingKind), ["technical_info", "optional_review"]);
  assert.deepEqual(entries.map((entry) => entry.displayLevel), ["info", "info"]);
  assert.equal(countBlockingDisplayLogs(entries), 0);
});

