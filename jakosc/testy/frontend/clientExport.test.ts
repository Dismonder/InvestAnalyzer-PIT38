import test from "node:test";
import assert from "node:assert/strict";

import {
  buildCsvContent,
  flattenExportRecord,
  normalizeExportRows,
  zakodujKomorkeCsv,
} from "../../../aplikacje/web/src/shared/clientExport.ts";

test("flattenExportRecord spłaszcza zagnieżdżone obiekty do eksportu CSV", () => {
  assert.deepEqual(
    flattenExportRecord({
      id: 1,
      account: { currency: "USD", value: 74.8349 },
      tags: ["cash", "api"],
    }),
    {
      id: 1,
      "account.currency": "USD",
      "account.value": 74.8349,
      tags: "cash; api",
    },
  );
});

test("buildCsvContent używa BOM, stabilnych nagłówków i polskiego pliku CSV", () => {
  const csv = buildCsvContent([
    { id: 1, "account.currency": "USD", amount: 74.8349 },
    { id: 2, "account.currency": "EUR", note: "wpłata, test" },
  ]);

  assert.equal(csv.startsWith("﻿"), true);
  assert.equal(csv.includes("id,account.currency,amount,note"), true);
  assert.equal(csv.includes('"wpłata, test"'), true);
});

test("normalizeExportRows zachowuje pusty eksport jako jawną informację", () => {
  assert.deepEqual(normalizeExportRows([]), [{ komunikat: "Brak danych do eksportu" }]);
});

test("zakodujKomorkeCsv neutralizuje formuły w tekście, ale nie rusza liczb", () => {
  for (const znak of ["=", "+", "-", "@", "\t", "\r"]) {
    const kodowane = zakodujKomorkeCsv(`${znak}HYPERLINK("x")`);
    assert.equal(kodowane.replace(/^"/, "").startsWith("'"), true, JSON.stringify(znak));
  }
  assert.equal(zakodujKomorkeCsv("=1+1"), "'=1+1");
  assert.equal(zakodujKomorkeCsv("@SUM(A1)"), "'@SUM(A1)");
  // Liczby (także sformatowane po polsku) zostają liczbami.
  assert.equal(zakodujKomorkeCsv(-12.5), "-12.5");
  assert.equal(zakodujKomorkeCsv("-12,50", ";"), "-12,50");
  assert.equal(zakodujKomorkeCsv("+3"), "+3");
  // Cytowanie: separator, cudzysłów, nowa linia.
  assert.equal(zakodujKomorkeCsv("Dom; makler", ";"), '"Dom; makler"');
  assert.equal(zakodujKomorkeCsv("Dom; makler", ","), "Dom; makler");
  assert.equal(zakodujKomorkeCsv('a"b'), '"a""b"');
  assert.equal(zakodujKomorkeCsv("a\nb"), '"a\nb"');
  assert.equal(zakodujKomorkeCsv("=A,B"), `"'=A,B"`);
  assert.equal(zakodujKomorkeCsv(null), "");
});

test("buildCsvContent neutralizuje formuły w komórkach tekstowych", () => {
  const csv = buildCsvContent([{ nazwa: "=cmd|' /C calc'!A0", kwota: -5, opis: "zwykły" }]);
  assert.equal(csv.includes("\n'=cmd"), true);
  assert.equal(csv.endsWith(",-5,zwykły"), true);
});
