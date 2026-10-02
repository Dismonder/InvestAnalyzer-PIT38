import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  CockpitStatusHero,
  DisclosureSection,
  InsightDrawer,
  IssueSeverityBadge,
  MetricStrip,
  ProgressStepRail,
  RecommendedActionCard,
  SourceRolePill,
} from "../../../aplikacje/web/src/invest_analyzer/components/cockpit/CockpitUi.tsx";

test("CockpitStatusHero pokazuje status, metryki i najważniejszą akcję bez ciężkich szczegółów", () => {
  const markup = renderToStaticMarkup(
    <CockpitStatusHero
      eyebrow="Samocheck PIT"
      title="Gotowe, zachowaj dowody"
      summary="Raport jest policzony, pozostały dowody do zachowania."
      tone="evidence"
      metrics={[
        { label: "Blokady", value: "0" },
        { label: "Dowody", value: "2" },
        { label: "Kontrole", value: "1" },
      ]}
      action={<RecommendedActionCard title="Zachowaj dowód FX" description="Potwierdź przewalutowanie." ctaLabel="Przejdź" />}
    />,
  );

  assert.equal(markup.includes("Samocheck PIT"), true);
  assert.equal(markup.includes("Gotowe, zachowaj dowody"), true);
  assert.equal(markup.includes("Zachowaj dowód FX"), true);
  assert.equal(markup.includes("Blokady"), true);
  assert.equal(markup.includes("Dowody"), true);
});

test("InsightDrawer renderuje prawy panel szczegółów tylko po otwarciu", () => {
  const closedMarkup = renderToStaticMarkup(
    <InsightDrawer open={false} title="Szczegóły" onClose={() => undefined}>
      Ukryta treść
    </InsightDrawer>,
  );
  const openMarkup = renderToStaticMarkup(
    <InsightDrawer
      open
      title="Szczegóły kosztu"
      subtitle="Co to znaczy i jak naprawić"
      sections={[
        { title: "Co to znaczy", content: "Koszt wymaga dowodu." },
        { title: "Jak naprawić", content: "Zachowaj potwierdzenie." },
      ]}
      actions={[
        { label: "Przejdź do historii", variant: "primary" },
        { label: "Zamknij", variant: "secondary" },
      ]}
      onClose={() => undefined}
    >
      Raw ID: COST-1
    </InsightDrawer>,
  );

  assert.equal(closedMarkup.includes("Ukryta treść"), false);
  assert.equal(openMarkup.includes("Szczegóły kosztu"), true);
  assert.equal(openMarkup.includes('data-motion="insight-drawer-backdrop"'), true);
  assert.equal(openMarkup.includes('data-motion="insight-drawer"'), true);
  assert.equal(openMarkup.includes('data-motion="insight-drawer-section"'), true);
  assert.equal(openMarkup.includes("Co to znaczy"), true);
  assert.equal(openMarkup.includes("Raw ID: COST-1"), true);
  assert.equal(openMarkup.includes("Przejdź do historii"), true);
  assert.equal(openMarkup.includes("Zamknij"), true);
});

test("Cockpit primitives renderują spójne skróty, kroki, role źródeł i zwijane szczegóły", () => {
  const markup = renderToStaticMarkup(
    <div>
      <MetricStrip metrics={[{ label: "Przychód", value: "233 501,85 zł" }, { label: "Koszt", value: "231 968,42 zł" }]} />
      <ProgressStepRail steps={[{ id: "dane", label: "Dane", status: "ready", count: 0 }, { id: "evidence", label: "Dowody", status: "evidence", count: 2 }]} />
      <SourceRolePill role="primary_tax" label="Liczy PIT" />
      <SourceRolePill role="evidence" label="Dowód" />
      <IssueSeverityBadge severity="blocking" label="Blokada" />
      <DisclosureSection title="Szczegóły audytu" summary="Pełne informacje są schowane." defaultOpen={false}>
        Pełny JSON audytu
      </DisclosureSection>
    </div>,
  );

  assert.equal(markup.includes("Przychód"), true);
  assert.equal(markup.includes("Dane"), true);
  assert.equal(markup.includes("Liczy PIT"), true);
  assert.equal(markup.includes("Dowód"), true);
  assert.equal(markup.includes("Blokada"), true);
  assert.equal(markup.includes("Szczegóły audytu"), true);
  assert.equal(markup.includes("Pełny JSON audytu"), false);
});

