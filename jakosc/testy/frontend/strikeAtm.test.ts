import test from "node:test";
import assert from "node:assert/strict";

import { strikeAtm } from "../../../aplikacje/web/src/portfel/services/strikeAtm.ts";

test("strikeAtm: tania akcja ma jeden kontrakt ATM, nie kilka w promieniu 2,5 USD", () => {
  assert.equal(strikeAtm([8, 9, 10, 11, 12], 10.3), 10);
});

test("strikeAtm: droga akcja z krokiem 10 USD tez ma kontrakt ATM", () => {
  assert.equal(strikeAtm([480, 490, 500, 510], 496), 500);
});

test("strikeAtm: bez ceny bazowej albo kontraktow nie ma ATM", () => {
  assert.equal(strikeAtm([100, 110], null), null);
  assert.equal(strikeAtm([], 100), null);
});
