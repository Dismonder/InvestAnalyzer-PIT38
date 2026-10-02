/**
 * Pelny lancuch: zadanie HTTP -> argumenty wiersza polecen -> silnik -> wynik.
 *
 * Koszt finansowania zakupu i straty z lat ubieglych to pozycje, ktore podaje
 * sam podatnik - nie ma ich w zadnym pliku od brokera. Kazdy z trzech etapow
 * ma wlasne nazwy pol (camelCase w interfejsie, snake_case w kontrakcie
 * sidecara, --flagi w wierszu polecen), wiec literowka w ktorymkolwiek z nich
 * konczy sie cicho: silnik liczy dalej, tylko bez tych kwot, a podatnik placi
 * wiecej i nie widzi powodu.
 *
 * Test wymaga dzialajacego interpretera Pythona z zaleznosciami silnika.
 * Gdy go nie ma, pomija sie sam zamiast falszywie oblewac.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import type { AddressInfo } from "node:net";

import { createInvestAnalyzerServer } from "../../../aplikacje/web/src/server/createInvestAnalyzerServer.ts";
import { resolvePythonExecutable } from "../../../aplikacje/web/src/server/taxEngineRuntime.ts";

const WYCIAG = {
  trades: [
    {
      Symbol: "AAPL.US",
      Side: "BUY",
      Quantity: 100,
      Cena: 150.0,
      Kwota: 15000.0,
      Commission: 10.0,
      Currency: "USD",
      date: "2024-02-05T15:30:00",
      account: "F24",
    },
    {
      Symbol: "AAPL.US",
      Side: "SELL",
      Quantity: 100,
      Cena: 200.0,
      Kwota: 20000.0,
      Commission: 10.0,
      Currency: "USD",
      date: "2024-09-10T15:30:00",
      account: "F24",
    },
  ],
  cash_flows: [{ id: "DEP-1", type: "przelew bankowy", amount: "60000.00", currency: "PLN", date: "2024-02-01" }],
};

function silnikDaSieUruchomic(workspaceRoot: string): boolean {
  try {
    const interpreter = resolvePythonExecutable(workspaceRoot);
    execFileSync(interpreter, ["-c", "import pandas, openpyxl"], { stdio: "ignore", timeout: 30_000 });
    return true;
  } catch {
    return false;
  }
}

const korzenRepozytorium = path.resolve(import.meta.dirname, "..", "..", "..");

function przygotujWarsztat(): string {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "przeplyw-kosztow-"));
  const magazyn = path.join(workspaceRoot, "dane", "pliki");
  fs.mkdirSync(magazyn, { recursive: true });
  fs.writeFileSync(path.join(magazyn, "wyciag.json"), JSON.stringify(WYCIAG), "utf-8");

  // Warsztat testowy ma wlasny magazyn, ale silnik bierzemy z repozytorium -
  // kopiujemy same zrodla, zeby nie ciagnac srodowiska wirtualnego ani wynikow.
  const silnikZrodla = path.join(korzenRepozytorium, "silnik", "python", "src");
  const silnikCel = path.join(workspaceRoot, "silnik", "python", "src");
  fs.mkdirSync(path.dirname(silnikCel), { recursive: true });
  fs.cpSync(silnikZrodla, silnikCel, { recursive: true });
  return workspaceRoot;
}

async function przelicz(workspaceRoot: string, dodatki: Record<string, unknown>): Promise<any> {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tax-flow-runtime-"));
  const app = createInvestAnalyzerServer({ workspaceRoot, runtimeRoot });
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  try {
    const odpowiedz = await fetch(`http://127.0.0.1:${port}/api/tax-engine/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        year: 2024,
        runMode: "SAFE",
        taxPlan: "aggressive_user",
        includeFxConversionCosts: true,
        includeBankFundingFees: true,
        includeInterestCosts: true,
        includeAccountFees: true,
        ...dodatki,
      }),
    });
    return await odpowiedz.json();
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((blad) => (blad ? reject(blad) : resolve()));
    });
    fs.rmSync(runtimeRoot, { recursive: true, force: true });
  }
}

test("koszt finansowania i straty z lat ubieglych docieraja z zadania az do wyniku", async (t) => {
  const workspaceRoot = przygotujWarsztat();
  if (!silnikDaSieUruchomic(workspaceRoot)) {
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
    t.skip("brak interpretera Pythona z zaleznosciami silnika");
    return;
  }

  try {
    const bezDodatkow = await przelicz(workspaceRoot, {});
    const zDodatkami = await przelicz(workspaceRoot, {
      fundingFees: [
        {
          id: "kredyt-1",
          amount: "1200.00",
          currency: "PLN",
          date: "2024-02-01",
          depositId: "DEP-1",
          depositAmount: "60000.00",
          evidenceNote: "umowa kredytu pod zakup akcji",
        },
      ],
      priorYearLosses: [{ id: "s-2023", taxYear: 2023, amountPln: "5000.00", accepted: true }],
    });
    const bezWplaty = await przelicz(workspaceRoot, {
      fundingFees: [{ id: "kredyt-bez-wplaty", amount: "1200.00", currency: "PLN", date: "2024-02-01", depositId: "BRAK-1", depositAmount: "60000.00" }],
    });

    assert.equal(bezDodatkow.success, true, `silnik nie policzyl: ${bezDodatkow.error}`);
    assert.equal(zDodatkami.success, true, `silnik nie policzyl: ${zDodatkami.error}`);
    assert.equal(bezWplaty.success, true, `silnik nie policzyl: ${bezWplaty.error}`);

    const kosztBez = Number(bezDodatkow.art30b?.pit38_rounded_cost_pln || 0);
    const kosztZ = Number(zDodatkami.art30b?.pit38_rounded_cost_pln || 0);
    assert.ok(
      kosztZ >= kosztBez + 1199,
      `koszt finansowania nie wszedl do kosztow: ${kosztBez} -> ${kosztZ}`,
    );
    assert.equal(Number(bezWplaty.art30b?.pit38_rounded_cost_pln || 0), kosztBez, "opłata bez potwierdzonej wpłaty weszła do kosztów");
    assert.equal(
      (bezWplaty.cost_items || []).some((pozycja: any) => pozycja.kind === "BANK_FUNDING_FEE"),
      false,
      "niepotwierdzona opłata nie powinna pojawić się jako koszt",
    );

    // Strata odlicza sie do wysokosci dochodu, wiec sprawdzamy, ze zostala
    // przyjeta i faktycznie wykorzystana, a nie konkretna kwote.
    assert.equal(
      Number(zDodatkami.art30b?.prior_year_losses_available_pln || 0),
      5000,
      "strata z lat ubieglych nie dotarla do silnika",
    );
    assert.ok(
      Number(zDodatkami.art30b?.prior_year_loss_used_pln || 0) > 0,
      "strata dotarla, ale nie zostala odliczona",
    );

    const podatekBez = Number(bezDodatkow.art30b?.tax_19_pln || 0);
    const podatekZ = Number(zDodatkami.art30b?.tax_19_pln || 0);
    assert.ok(podatekZ < podatekBez, `podatek nie zmalal: ${podatekBez} -> ${podatekZ}`);

    // Warsztat testowy ma byc odizolowany: silnik nie moze siegnac do magazynu
    // repozytorium. Wczesniej sciezka nie byla przekazywana i liczyl z cudzych
    // plikow niezaleznie od podanego workspaceRoot.
    const zrodla = (zDodatkami.source_registry || []).map((z: any) => z.filename ?? z.fileName);
    assert.deepEqual(zrodla, ["wyciag.json"], `silnik czytal spoza warsztatu: ${zrodla.join(", ")}`);

    const rodzajeKosztow = (zDodatkami.cost_items || []).map((pozycja: any) => pozycja.kind);
    assert.ok(
      rodzajeKosztow.includes("BANK_FUNDING_FEE"),
      `brak pozycji kosztu finansowania, sa: ${rodzajeKosztow.join(", ") || "zadnych"}`,
    );
  } finally {
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  }
});
