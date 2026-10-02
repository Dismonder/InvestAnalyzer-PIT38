import test from "node:test";
import assert from "node:assert/strict";

import {
  buildAutoCheckGuide,
  type AutoCheckGuideInput,
} from "../../../aplikacje/web/src/invest_analyzer/services/autoCheckGuide.ts";

const baseWorkspace = {
  stages: [],
  attentionItems: [],
  metrics: [],
  overallStatus: "ready",
  recommendedAction: {
    label: "Wygeneruj pakiet",
    message: "Raport jest gotowy. Następny krok to pobranie pakietu podatkowego.",
    targetView: "raport_roczny",
  },
  taxReadiness: {
    year: 2025,
    score: 100,
    blockingIssues: 0,
    warnings: 0,
    nbpGaps: 0,
    unclassifiedEvents: 0,
  },
  settlementStatus: {
    label: "Gotowe do rozliczenia",
    message: "Silnik policzył raport.",
    kind: "ready",
    blockingCount: 0,
    evidenceCount: 0,
    reviewCount: 0,
  },
} satisfies AutoCheckGuideInput["workspaceReadiness"];

test("buildAutoCheckGuide zwraca blokadę i jedną najważniejszą akcję", () => {
  const guide = buildAutoCheckGuide({
    workspaceReadiness: {
      ...baseWorkspace,
      attentionItems: [
        {
          code: "NBP_COVERAGE_GAP",
          label: "Brak kursu NBP",
          message: "Brakuje kursu NBP dla USD.",
          severity: "ERROR",
          kind: "blocking_error",
          targetView: "raport_roczny",
        },
      ],
      settlementStatus: {
        label: "Zablokowane",
        message: "Raport ma realne blokady.",
        kind: "blocked",
        blockingCount: 1,
        evidenceCount: 0,
        reviewCount: 0,
      },
    },
  });

  assert.equal(guide.verdict, "blocked");
  assert.equal(guide.headline, "Do kontroli PIT");
  assert.equal(guide.recommendedItem?.title, "Brak kursu NBP");
  assert.equal(guide.recommendedItem?.targetView, "raport_roczny");
  assert.equal(guide.steps.find((step) => step.id === "nbp")?.status, "blocked");
});

test("buildAutoCheckGuide rozdziela dowody od kontroli pomocniczej", () => {
  const guide = buildAutoCheckGuide({
    workspaceReadiness: {
      ...baseWorkspace,
      attentionItems: [
        {
          code: "DEFENSE:COST-1",
          label: "Koszt wymaga dowodu",
          message: "Zachowaj potwierdzenie przewalutowania.",
          severity: "EVIDENCE",
          kind: "evidence_needed",
          targetView: "raport_roczny",
        },
        {
          code: "BFAQ-source-1",
          label: "Nowy raport wymaga kontroli",
          message: "Stabilny silnik nadal liczy PIT.",
          severity: "WARNING",
          kind: "optional_review",
          targetView: "import_danych",
        },
      ],
      settlementStatus: {
        label: "Gotowe, zachowaj dowody",
        message: "Raport policzony. Pozostały dowody.",
        kind: "ready_with_evidence",
        blockingCount: 0,
        evidenceCount: 1,
        reviewCount: 1,
      },
    },
  });

  assert.equal(guide.verdict, "ready_with_evidence");
  assert.equal(guide.recommendedItem?.kind, "evidence");
  assert.equal(guide.groups.evidence.length, 1);
  assert.equal(guide.groups.review.length, 1);
  assert.equal(guide.steps.find((step) => step.id === "evidence")?.status, "ready_with_evidence");
  assert.equal(guide.steps.find((step) => step.id === "broker_sources")?.status, "needs_review");
});

test("buildAutoCheckGuide uwzględnia kolejkę importu i lokalne ukrycie informacji", () => {
  const guide = buildAutoCheckGuide({
    workspaceReadiness: baseWorkspace,
    brokerFileSummary: {
      totalSources: 3,
      taxSources: 1,
      evidenceOnlySources: 2,
      missingAreas: [],
      conflictCount: 0,
      recommendedAction: "Sprawdź kandydata źródła.",
      coverageRows: [],
      sourceRows: [],
      actionRows: [
        {
          id: "BFAQ-source",
          actionId: "BFAQ-source",
          severity: "warning",
          area: "source",
          label: "Kandydat źródła wymaga kontroli",
          userAction: "Porównaj nowy raport ze stabilnym źródłem.",
          sourceIds: ["source:new"],
          relatedSourceIds: ["source:new"],
          relatedCostIds: [],
          status: "open",
          statusLabel: "Otwarte",
        },
      ],
      actionProgress: { total: 1, open: 1, resolved: 0, ignored: 0, blocking: 0, warnings: 1 },
      openActionCount: 1,
      resolvedActionCount: 0,
      ignoredActionCount: 0,
      sourceDetails: [],
      processedStorageFiles: [],
    },
    autoCheckActionOverrides: [
      {
        itemId: "broker-action:BFAQ-source",
        status: "hidden",
        updatedAt: "2026-05-14T10:00:00.000Z",
      },
    ],
  });

  assert.equal(guide.groups.review.length, 0);
  assert.equal(guide.recommendedItem?.title, "Wygeneruj pakiet");
});

