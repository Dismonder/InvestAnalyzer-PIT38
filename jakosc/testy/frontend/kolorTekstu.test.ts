import test from "node:test";
import assert from "node:assert/strict";

import { kolorTekstuNa } from "../../../aplikacje/web/src/shared/kolorTekstu.ts";

test("kolorTekstuNa: jasne kolory rachunku dostaja ciemny tekst, ciemne - bialy", () => {
  assert.equal(kolorTekstuNa("#f59e0b"), "#0f172a"); // bursztyn: bialy mial 2,1:1
  assert.equal(kolorTekstuNa("#10b981"), "#0f172a"); // zielen: bialy mial 2,5:1
  assert.equal(kolorTekstuNa("#1d4ed8"), "#ffffff");
  assert.equal(kolorTekstuNa("#EF4444"), "#0f172a");
  assert.equal(kolorTekstuNa("#000"), "#ffffff");
  assert.equal(kolorTekstuNa("rgb(1,2,3)"), "#ffffff"); // nieznany zapis - jak dotad
});
