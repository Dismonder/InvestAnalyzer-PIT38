import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  BACKUP_LIMIT,
  isBackupId,
  listBackupSnapshots,
  readBackupSnapshot,
  writeBackupSnapshot,
} from "../../../aplikacje/web/src/server/backupStore.ts";

function makeRoot(): string {
  return mkdtempSync(path.join(tmpdir(), "ia-backupy-"));
}

test("identyfikator kopii nie może wyprowadzić poza katalog kopii", () => {
  assert.equal(isBackupId("kopia-20260906-101500.json"), true);
  assert.equal(isBackupId("../sekret.json"), false);
  assert.equal(isBackupId("kopia-../../sekret.json"), false);
  assert.equal(isBackupId("inny-plik.json"), false);
  assert.equal(isBackupId("kopia-.json"), false);
  assert.equal(isBackupId("kopia-20260906.txt"), false);
});

test("odczyt kopii odrzuca identyfikator spoza wzorca", () => {
  const root = makeRoot();

  assert.throws(() => readBackupSnapshot(root, "../sekret.json"), /Nieprawidłowy identyfikator/);
});

test("zapisana kopia daje się odczytać w całości", () => {
  const root = makeRoot();
  const snapshot = {
    kind: "investanalyzer-backup",
    version: 2,
    createdAt: "2026-09-06T10:15:00.000Z",
    local: { priorYearLossEntries: '[{"taxYear":2024}]' },
    offline: { transactionOverrides: [{ overrideId: "OV-1" }] },
  };

  const stored = writeBackupSnapshot(root, snapshot, new Date("2026-09-06T10:15:00Z"));

  assert.equal(isBackupId(stored.id), true);
  assert.equal(stored.createdAt, "2026-09-06T10:15:00.000Z");
  assert.deepEqual(readBackupSnapshot(root, stored.id), snapshot);
});

test("lista kopii pomija pliki, których aplikacja nie zapisała", () => {
  const root = makeRoot();
  writeBackupSnapshot(root, { createdAt: "2026-01-01T00:00:00.000Z" }, new Date("2026-01-01T00:00:00Z"));
  writeFileSync(path.join(root, "notatka.txt"), "nie kopia", "utf8");
  writeFileSync(path.join(root, "sekret.json"), "{}", "utf8");

  const listed = listBackupSnapshots(root);

  assert.equal(listed.length, 1);
  assert.equal(listed[0].createdAt, "2026-01-01T00:00:00.000Z");
});

test("najnowsza kopia jest pierwsza na liście", () => {
  const root = makeRoot();
  writeBackupSnapshot(root, { createdAt: "2026-01-01T00:00:00.000Z" }, new Date("2026-01-01T00:00:00Z"));
  writeBackupSnapshot(root, { createdAt: "2026-05-05T00:00:00.000Z", n: 2 }, new Date("2026-05-05T00:00:00Z"));

  const listed = listBackupSnapshots(root);

  assert.equal(listed[0].createdAt, "2026-05-05T00:00:00.000Z");
  assert.equal(listed[1].createdAt, "2026-01-01T00:00:00.000Z");
});

test("katalog kopii nie rośnie bez końca", () => {
  const root = makeRoot();
  for (let index = 0; index < BACKUP_LIMIT + 5; index += 1) {
    const moment = new Date(Date.UTC(2026, 0, 1, 0, 0, index));
    writeBackupSnapshot(root, { createdAt: moment.toISOString(), n: index }, moment);
  }

  assert.equal(listBackupSnapshots(root).length, BACKUP_LIMIT);
  assert.equal(readdirSync(root).length, BACKUP_LIMIT);
});

test("uszkodzony plik kopii nie wywraca listy, tylko traci datę", () => {
  const root = makeRoot();
  const stored = writeBackupSnapshot(root, { createdAt: "2026-01-01T00:00:00.000Z" }, new Date("2026-01-01T00:00:00Z"));
  writeFileSync(path.join(root, stored.id), "{to nie jest json", "utf8");

  const listed = listBackupSnapshots(root);

  assert.equal(listed.length, 1);
  assert.equal(listed[0].createdAt, stored.id, "bez czytelnej daty zostaje nazwa pliku");
  assert.equal(readFileSync(path.join(root, stored.id), "utf8"), "{to nie jest json");
});

test("sprzątanie nie usuwa kopii, która właśnie powstała", () => {
  // Gdy zegar komputera cofnął się, identyfikator nowej kopii sortuje się
  // poniżej istniejących i trafiał do usunięcia - funkcja zwracała wtedy nazwę
  // pliku, którego już nie było.
  const root = makeRoot();
  for (let index = 0; index < BACKUP_LIMIT; index += 1) {
    const moment = new Date(Date.UTC(2027, 0, 1, 0, 0, index));
    writeBackupSnapshot(root, { createdAt: moment.toISOString(), n: index }, moment);
  }

  const late = new Date(Date.UTC(2020, 0, 1, 0, 0, 0));
  const stored = writeBackupSnapshot(root, { createdAt: late.toISOString(), n: -1 }, late);

  const listed = listBackupSnapshots(root);
  assert.ok(listed.some((entry) => entry.id === stored.id), "zapisana kopia musi być na liście");
  assert.deepEqual(readBackupSnapshot(root, stored.id), { createdAt: late.toISOString(), n: -1 });
  assert.equal(listed.length, BACKUP_LIMIT);
});

test("kopia z tej samej sekundy nie nadpisuje poprzedniej po cichu", () => {
  const root = makeRoot();
  const moment = new Date(Date.UTC(2026, 4, 5, 12, 0, 0));

  const first = writeBackupSnapshot(root, { createdAt: "pierwsza", n: 1 }, moment);
  const second = writeBackupSnapshot(root, { createdAt: "druga", n: 2 }, moment);

  assert.notEqual(first.id, second.id, "dwie kopie z tej samej sekundy muszą mieć różne nazwy");
  assert.deepEqual(readBackupSnapshot(root, first.id), { createdAt: "pierwsza", n: 1 });
  assert.deepEqual(readBackupSnapshot(root, second.id), { createdAt: "druga", n: 2 });
});

test("kolejność kopii z tej samej sekundy jest liczbowa (-2 przed -10), jak w wersji desktopowej", () => {
  const root = makeRoot();
  for (const nazwa of ["kopia-20260101-120000.json", "kopia-20260101-120000-2.json", "kopia-20260101-120000-10.json", "kopia-20260101-115959.json"]) {
    writeFileSync(path.join(root, nazwa), "{}");
  }
  assert.deepEqual(listBackupSnapshots(root).map((kopia) => kopia.id), [
    "kopia-20260101-120000-10.json",
    "kopia-20260101-120000-2.json",
    "kopia-20260101-120000.json",
    "kopia-20260101-115959.json",
  ]);
});

test("rotacja po liczbowym sufiksie usuwa najstarsze kopie z tej samej sekundy, nie środkowe", () => {
  const root = makeRoot();
  const nazwy = ["kopia-20260101-120000.json", ...Array.from({ length: BACKUP_LIMIT }, (_, i) => `kopia-20260101-120000-${i + 2}.json`)];
  for (const nazwa of nazwy) writeFileSync(path.join(root, nazwa), JSON.stringify({ createdAt: nazwa }));
  const nowa = writeBackupSnapshot(root, { createdAt: "nowa", n: 1 }, new Date(2026, 0, 1, 12, 0, 0));
  assert.equal(nowa.id, `kopia-20260101-120000-${BACKUP_LIMIT + 2}.json`);
  const zostaly = new Set(listBackupSnapshots(root).map((kopia) => kopia.id));
  assert.equal(zostaly.size, BACKUP_LIMIT);
  // Usuniete zostaja dwie najstarsze (bez sufiksu i -2), a nie kopie o "najmniejszym" tekście.
  assert.equal(zostaly.has("kopia-20260101-120000.json"), false);
  assert.equal(zostaly.has("kopia-20260101-120000-2.json"), false);
  assert.equal(zostaly.has("kopia-20260101-120000-3.json"), true);
  assert.equal(zostaly.has("kopia-20260101-120000-10.json"), true);
  assert.equal(zostaly.has(nowa.id), true);
});