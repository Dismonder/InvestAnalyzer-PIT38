import test from "node:test";
import assert from "node:assert/strict";

import { klikalny } from "../../../aplikacje/web/src/shared/klikalny.ts";

function klawisz(key: string, naSobie = true) {
  const element = {};
  let zatrzymano = false;
  return {
    zdarzenie: {
      key,
      target: naSobie ? element : {},
      currentTarget: element,
      preventDefault: () => { zatrzymano = true; },
    } as any,
    zatrzymano: () => zatrzymano,
  };
}

test("klikalny: fokus, rola przycisku i aktywacja Enter/Spacja", () => {
  let wywolania = 0;
  const atrybuty = klikalny(() => { wywolania += 1; }, { wybrany: true });
  assert.equal(atrybuty.role, "button");
  assert.equal(atrybuty.tabIndex, 0);
  assert.equal(atrybuty["aria-pressed"], true);

  const enter = klawisz("Enter");
  atrybuty.onKeyDown(enter.zdarzenie);
  const spacja = klawisz(" ");
  atrybuty.onKeyDown(spacja.zdarzenie);
  atrybuty.onKeyDown(klawisz("a").zdarzenie);
  assert.equal(wywolania, 2);
  assert.equal(spacja.zatrzymano(), true, "spacja nie przewija strony");
});

test("klikalny: klawisz z elementu wewnatrz nie aktywuje kafelka", () => {
  let wywolania = 0;
  const atrybuty = klikalny(() => { wywolania += 1; });
  atrybuty.onKeyDown(klawisz("Enter", false).zdarzenie);
  assert.equal(wywolania, 0);
  assert.equal("aria-pressed" in atrybuty, false);
});

test("klikalny: wiersz tabeli zachowuje swoja role", () => {
  const atrybuty = klikalny(() => {}, { wiersz: true });
  assert.equal("role" in atrybuty, false);
  assert.equal(atrybuty.tabIndex, 0);
});
