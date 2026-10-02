import test from "node:test";
import assert from "node:assert/strict";

import { formatCurrency, formatLiczba } from "../../../aplikacje/web/src/portfel/services/nbpService.ts";

const bezTwardychSpacji = (tekst: string) => tekst.replace(/[  ]/g, " ");

test("formatLiczba: polski przecinek dziesietny i spacja tysiecy, jak formatCurrency", () => {
  assert.equal(formatLiczba(12.345), "12,35");
  assert.equal(formatLiczba(-0.5), "-0,50");
  assert.equal(bezTwardychSpacji(formatLiczba(12345.6)), "12 345,60");
  assert.equal(bezTwardychSpacji(formatLiczba(12345.6, 0)), "12 346");
  assert.equal(bezTwardychSpacji(formatCurrency(12345.6, "USD", 0)), "12 346 USD");
  // Ten sam formatter dla kolejnych wywolan nie zmienia wyniku.
  assert.equal(formatLiczba(1.005, 2), formatLiczba(1.005, 2));
});
