import test from "node:test";
import assert from "node:assert/strict";

import { downsampleDailyBalancesForChart } from "../../../aplikacje/web/src/invest_analyzer/services/chartData.ts";
import type { DailyBalance } from "../../../aplikacje/web/src/invest_analyzer/types.ts";

function point(index: number): DailyBalance {
  const date = new Date(Date.UTC(2025, 0, index + 1)).toISOString().slice(0, 10);
  return {
    date,
    balance: index,
    balancePln: index * 10,
    pnl: index * 2,
    pnlPln: index * 20,
  };
}

test("downsampleDailyBalancesForChart nie zmienia małych serii", () => {
  const points = [point(0), point(1), point(2)];

  assert.equal(downsampleDailyBalancesForChart(points, 3), points);
});

test("downsampleDailyBalancesForChart ogranicza duże serie i zachowuje krańce", () => {
  const points = Array.from({ length: 1000 }, (_, index) => point(index));
  const result = downsampleDailyBalancesForChart(points, 120);

  assert.ok(result.length <= 120);
  assert.equal(result[0], points[0]);
  assert.equal(result[result.length - 1], points[points.length - 1]);

  const dates = result.map((row) => row.date);
  assert.deepEqual([...dates].sort(), dates);
});

