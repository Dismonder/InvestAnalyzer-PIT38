import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { EngineHistoryRow } from "../../../aplikacje/web/src/invest_analyzer/hooks/useTaxEngineRun.ts";
import {
  EngineTransactionHistory,
  getTransactionDossierAiContexts,
} from "../../../aplikacje/web/src/invest_analyzer/components/EngineTransactionHistory.tsx";
import type { DefenseWorkbenchItem } from "../../../aplikacje/web/src/invest_analyzer/services/defenseWorkbench.ts";
import type { BrokerActionWorkbenchItem } from "../../../aplikacje/web/src/invest_analyzer/services/brokerActionWorkbench.ts";

function row(
  row_id: string,
  row_kind: string,
  parent_row_id: string | null = null,
  overrides: Partial<EngineHistoryRow> = {},
): EngineHistoryRow {
  return {
    row_id,
    parent_row_id,
    row_kind,
    display_date: "2026-04-24T10:00:00.000Z",
    transaction_id: row_id,
    ticker: row_id.toUpperCase(),
    read_only: false,
    ...overrides,
  } as EngineHistoryRow;
}

test("EngineTransactionHistory renderuje dziecko tylko raz", () => {
  const markup = renderToStaticMarkup(
    <EngineTransactionHistory
      rows={[
        row("parent-1", "TRADE", null, { side: "BUY" }),
        row("child-1", "ALLOCATED_COST", "parent-1", { read_only: true }),
      ]}
      searchTerm=""
      typeFilter="all"
      uiComplexityMode="expert"
      pinnedTransactionLinks={[]}
      onOpenEditor={() => undefined}
      onPinTransaction={() => undefined}
      onUnpinTransaction={() => undefined}
    />,
  );

  assert.equal(markup.includes("parent-1"), true);
  assert.equal(markup.match(/child-1/g)?.length || 0, 1);
});

test("EngineTransactionHistory pokazuje Edytuj tylko dla edytowalnych rekordów", () => {
  const markup = renderToStaticMarkup(
    <EngineTransactionHistory
      rows={[
        row("editable-1", "TRADE", null, {
          side: "BUY",
          base_record_id: "editable-base-1",
          manual_record_id: "editable-manual-1",
          read_only: false,
          details: { can_edit: true, edit_record_id: "editable-manual-1" },
        }),
        row("fx-1", "PRIVATE_CASH_FX", null, {
          read_only: true,
          details: { ui_row_source: "private_cash_fx_view", can_edit: false },
        }),
        row("child-1", "ALLOCATED_COST", "editable-1", {
          read_only: true,
          details: { can_edit: false },
        }),
      ]}
      searchTerm=""
      typeFilter="all"
      uiComplexityMode="expert"
      pinnedTransactionLinks={[]}
      onOpenEditor={() => undefined}
      onPinTransaction={() => undefined}
      onUnpinTransaction={() => undefined}
    />,
  );

  assert.equal(markup.includes("title=\"Edytuj\""), true);
  assert.equal(markup.includes("Przewalutowanie z widoku FX"), true);
  assert.equal(markup.includes("Koszt alokowany"), true);
});

test("EngineTransactionHistory blokuje akcje zmiany po zamknieciu roku", () => {
  const markup = renderToStaticMarkup(
    <EngineTransactionHistory
      rows={[
        row("editable-1", "TRADE", null, {
          side: "BUY",
          base_record_id: "editable-base-1",
          manual_record_id: "editable-manual-1",
          read_only: false,
          details: { can_edit: true, edit_record_id: "editable-manual-1" },
        }),
      ]}
      searchTerm=""
      typeFilter="all"
      isReadOnly
      readOnlyReason="Rok 2025 jest zamknięty. Otwórz rok ponownie, aby zmieniać historię."
      pinnedTransactionLinks={[]}
      onOpenEditor={() => undefined}
      onPinTransaction={() => undefined}
      onUnpinTransaction={() => undefined}
    />,
  );

  assert.equal(markup.includes("Rok 2025 jest zamknięty"), true);
  assert.equal(markup.includes("title=\"Edytuj\""), false);
  assert.equal(markup.includes("title=\"Przypnij\""), false);
});

test("EngineTransactionHistory może renderować akcje jako same ikonki", () => {
  const markup = renderToStaticMarkup(
    <EngineTransactionHistory
      rows={[
        row("editable-1", "TRADE", null, {
          side: "BUY",
          base_record_id: "editable-base-1",
          manual_record_id: "editable-manual-1",
          read_only: false,
          details: { can_edit: true, edit_record_id: "editable-manual-1" },
        }),
      ]}
      searchTerm=""
      typeFilter="all"
      actionButtonMode="icon"
      uiComplexityMode="expert"
      pinnedTransactionLinks={[]}
      onOpenEditor={() => undefined}
      onPinTransaction={() => undefined}
      onUnpinTransaction={() => undefined}
    />,
  );

  assert.equal(markup.includes("sr-only"), true);
  assert.equal(markup.includes("title=\"Edytuj\""), true);
});

test("getTransactionDossierAiContexts dopasowuje kontekst AI po event_id z lineage", () => {
  const dossier = {
    canonical_transaction_id: "dossier-1",
    lineage: {
      raw_records: [
        { event_id: "event:cash-1" },
        { event_id: "event:trade-1" },
      ],
    },
  };
  const contexts = getTransactionDossierAiContexts(dossier, [
    {
      source_event_id: "event:cash-1",
      summary_pl: "AI rozpoznała prowizję z komentarza.",
      detected_context_type: "trade_commission",
      validation_status: "accepted",
    },
    {
      source_event_id: "event:other",
      summary_pl: "Niepowiązany kontekst.",
    },
  ]);

  assert.equal(contexts.length, 1);
  assert.equal(contexts[0].summary_pl, "AI rozpoznała prowizję z komentarza.");
});

test("EngineTransactionHistory pokazuje szybki podgląd po rozwinięciu rekordu", () => {
  const markup = renderToStaticMarkup(
    <EngineTransactionHistory
      rows={[
        row("editable-1", "TRADE", null, {
          side: "BUY",
          base_record_id: "editable-base-1",
          manual_record_id: "editable-manual-1",
          read_only: false,
          details: { can_edit: true, edit_record_id: "editable-manual-1" },
        }),
      ]}
      searchTerm=""
      typeFilter="all"
      pinnedTransactionLinks={[]}
      onOpenEditor={() => undefined}
      onPinTransaction={() => undefined}
      onUnpinTransaction={() => undefined}
    />,
  );

  assert.equal(markup.includes("Szczegóły"), true);
});

test("EngineTransactionHistory rozwija i oznacza rekord wskazany przez deep-link", () => {
  const markup = renderToStaticMarkup(
    <EngineTransactionHistory
      rows={[
        row("target-row-1", "TRADE", null, {
          side: "BUY",
          comment: "Rekord do podświetlenia",
        }),
      ]}
      searchTerm=""
      typeFilter="all"
      focusRowId="target-row-1"
      uiComplexityMode="expert"
      pinnedTransactionLinks={[]}
      onOpenEditor={() => undefined}
      onPinTransaction={() => undefined}
      onUnpinTransaction={() => undefined}
    />,
  );

  assert.equal(markup.includes("Szybki podgląd rekordu"), true);
  assert.equal(markup.includes("Rekord do podświetlenia"), true);
  assert.equal(markup.includes("ring-2"), true);
});

test("EngineTransactionHistory w trybie prostym nie pokazuje inline szybkiego podglądu", () => {
  const markup = renderToStaticMarkup(
    <EngineTransactionHistory
      rows={[
        row("target-row-1", "TRADE", null, {
          side: "BUY",
          comment: "Rekord do podświetlenia",
        }),
      ]}
      searchTerm=""
      typeFilter="all"
      focusRowId="target-row-1"
      pinnedTransactionLinks={[]}
      onOpenEditor={() => undefined}
      onPinTransaction={() => undefined}
      onUnpinTransaction={() => undefined}
    />,
  );

  assert.equal(markup.includes("Szybki podgląd rekordu"), false);
  assert.equal(markup.includes("Szczegóły"), true);
  assert.equal(markup.includes("ring-2"), true);
  assert.equal(markup.includes('data-motion="history-row"'), true);
});

test("EngineTransactionHistory simple pokazuje wyciąg operacji bez akcji eksperckich", () => {
  const markup = renderToStaticMarkup(
    <EngineTransactionHistory
      rows={[
        row("editable-1", "TRADE", null, {
          side: "BUY",
          base_record_id: "editable-base-1",
          manual_record_id: "editable-manual-1",
          read_only: false,
          details: { can_edit: true, edit_record_id: "editable-manual-1" },
        }),
      ]}
      searchTerm=""
      typeFilter="all"
      pinnedTransactionLinks={[]}
      onOpenEditor={() => undefined}
      onPinTransaction={() => undefined}
      onUnpinTransaction={() => undefined}
    />,
  );

  assert.equal(markup.includes("title=\"Edytuj\""), false);
  assert.equal(markup.includes("title=\"Przypnij\""), false);
  assert.equal(markup.includes("Ilość"), false);
  assert.equal(markup.includes("Kwota PLN"), false);
  assert.equal(markup.includes("Wpływ na PIT / status"), true);
  assert.equal(markup.includes("Szczegóły"), true);
});

test("EngineTransactionHistory pokazuje wpływ podatkowy zamiast samego Edytowalny", () => {
  const markup = renderToStaticMarkup(
    <EngineTransactionHistory
      rows={[
        row("tech-1", "CASH_MOVEMENT", null, {
          read_only: false,
          details: {
            can_edit: true,
            edit_record_id: "tech-1",
            tax_impact_kind: "TECHNICAL_ONLY",
            tax_impact_label_pl: "Techniczne - nie liczone w PIT",
            editability_label: "Można edytować",
          },
        }),
      ]}
      searchTerm=""
      typeFilter="all"
      taxImpactFilter="all"
      uiComplexityMode="expert"
      showTechnicalRows
      pinnedTransactionLinks={[]}
      onOpenEditor={() => undefined}
      onPinTransaction={() => undefined}
      onUnpinTransaction={() => undefined}
    />,
  );

  assert.equal(markup.includes("Techniczne - nie liczone w PIT"), true);
  assert.equal(markup.includes("Można edytować"), true);
  assert.equal(markup.includes(">Edytowalny<"), false);
});

test("EngineTransactionHistory w widoku Wszystko pokazuje pełną kanoniczną historię storage", () => {
  const markup = renderToStaticMarkup(
    <EngineTransactionHistory
      rows={[
        row("trade-1", "TRADE", null, {
          logical_world: "equity_tax",
          details: { tax_impact_kind: "PIT_COUNTED" },
        }),
        row("technical-1", "CASH_MOVEMENT", null, {
          logical_world: "diagnostic_only",
          details: {
            tax_impact_kind: "TECHNICAL_ONLY",
            tax_impact_label_pl: "Techniczne - nie liczone w PIT",
          },
        }),
      ]}
      searchTerm=""
      typeFilter="all"
      historyViewMode="all"
      pinnedTransactionLinks={[]}
      onOpenEditor={() => undefined}
      onPinTransaction={() => undefined}
      onUnpinTransaction={() => undefined}
    />,
  );

  assert.equal(markup.includes("trade-1"), true);
  assert.equal(markup.includes("technical-1"), true);
});

test("EngineTransactionHistory pokazuje techniczne rekordy po włączeniu przełącznika albo w trybie Techniczne", () => {
  const technicalRow = row("technical-1", "CASH_MOVEMENT", null, {
    logical_world: "diagnostic_only",
    details: {
      tax_impact_kind: "TECHNICAL_ONLY",
      tax_impact_label_pl: "Techniczne - nie liczone w PIT",
    },
  });

  const enabledMarkup = renderToStaticMarkup(
    <EngineTransactionHistory
      rows={[technicalRow]}
      searchTerm=""
      typeFilter="all"
      historyViewMode="all"
      showTechnicalRows
      pinnedTransactionLinks={[]}
      onOpenEditor={() => undefined}
      onPinTransaction={() => undefined}
      onUnpinTransaction={() => undefined}
    />,
  );
  const technicalModeMarkup = renderToStaticMarkup(
    <EngineTransactionHistory
      rows={[technicalRow]}
      searchTerm=""
      typeFilter="all"
      historyViewMode="technical"
      pinnedTransactionLinks={[]}
      onOpenEditor={() => undefined}
      onPinTransaction={() => undefined}
      onUnpinTransaction={() => undefined}
    />,
  );

  assert.equal(enabledMarkup.includes("technical-1"), true);
  assert.equal(technicalModeMarkup.includes("technical-1"), true);
});

test("EngineTransactionHistory pokazuje kandydatów w pełnej historii i izoluje ich w trybie kandydatów", () => {
  const candidateRow = row("candidate-preview-1", "CANDIDATE_PREVIEW", null, {
    read_only: true,
    tax_impact_kind: "ANALYTICAL_ONLY",
    tax_impact_label_pl: "Podgląd - nie liczy PIT",
    details: {
      candidate_preview: true,
      candidate_source_id: "storage:candidate",
      does_affect_pit: false,
    },
  });
  const activeMarkup = renderToStaticMarkup(
    <EngineTransactionHistory
      rows={[row("trade-1", "TRADE", null, { logical_world: "equity_tax" }), candidateRow]}
      searchTerm=""
      typeFilter="all"
      historyViewMode="all"
      pinnedTransactionLinks={[]}
      onOpenEditor={() => undefined}
      onPinTransaction={() => undefined}
      onUnpinTransaction={() => undefined}
    />,
  );
  const candidateMarkup = renderToStaticMarkup(
    <EngineTransactionHistory
      rows={[row("trade-1", "TRADE", null, { logical_world: "equity_tax" }), candidateRow]}
      searchTerm=""
      typeFilter="all"
      historyViewMode="candidate"
      pinnedTransactionLinks={[]}
      onOpenEditor={() => undefined}
      onPinTransaction={() => undefined}
      onUnpinTransaction={() => undefined}
    />,
  );

  assert.equal(activeMarkup.includes("candidate-preview-1"), true);
  assert.equal(candidateMarkup.includes("candidate-preview-1"), true);
  assert.equal(candidateMarkup.includes("Podgląd - nie liczy PIT"), true);
  assert.equal(candidateMarkup.includes("trade-1"), false);
});

test("EngineTransactionHistory filtruje po statusie dowodowym", () => {
  const markup = renderToStaticMarkup(
    <EngineTransactionHistory
      rows={[
        row("complete-1", "TRADE", null, {
          defense_status: "complete",
          details: { defense_status: "complete" },
        }),
        row("missing-1", "PRIVATE_CASH_FX", null, {
          defense_status: "missing_link",
          details: { defense_status: "missing_link" },
        }),
      ]}
      searchTerm=""
      typeFilter="all"
      defenseStatusFilter="missing_link"
      pinnedTransactionLinks={[]}
      onOpenEditor={() => undefined}
      onPinTransaction={() => undefined}
      onUnpinTransaction={() => undefined}
    />,
  );

  assert.equal(markup.includes("missing-1"), true);
  assert.equal(markup.includes("complete-1"), false);
});

test("EngineTransactionHistory filtruje po nadrzędnym trybie historii", () => {
  const HistoryWithMode = EngineTransactionHistory as React.ComponentType<React.ComponentProps<typeof EngineTransactionHistory> & {
    historyViewMode?: string;
  }>;
  const markup = renderToStaticMarkup(
    <HistoryWithMode
      rows={[
        row("trade-1", "TRADE", null, {
          logical_world: "equity_tax",
        }),
        row("technical-1", "BLOCK", null, {
          logical_world: "diagnostic_only",
        }),
      ]}
      searchTerm=""
      typeFilter="all"
      historyViewMode="technical"
      pinnedTransactionLinks={[]}
      onOpenEditor={() => undefined}
      onPinTransaction={() => undefined}
      onUnpinTransaction={() => undefined}
    />,
  );

  assert.equal(markup.includes("technical-1"), true);
  assert.equal(markup.includes("trade-1"), false);
});

test("EngineTransactionHistory filtruje rekordy powiązane ze sprawami importu", () => {
  const HistoryWithMode = EngineTransactionHistory as React.ComponentType<React.ComponentProps<typeof EngineTransactionHistory> & {
    historyViewMode?: string;
    brokerActionItems?: BrokerActionWorkbenchItem[];
  }>;
  const markup = renderToStaticMarkup(
    <HistoryWithMode
      rows={[
        row("fx-row-1", "PRIVATE_CASH_FX", null, {
          transaction_id: "FX-LOSS-1",
          comment: "Potencjalna strata FX",
          details: { source_record_id: "source:evidence-pdf" },
        }),
        row("linked-row-1", "TRADE", null, {
          transaction_id: "TRADE-1",
          comment: "Rekord podpięty lokalnym override",
        }),
        row("other-row-1", "TRADE", null, {
          transaction_id: "TRADE-OTHER",
          comment: "Niepowiązana transakcja",
        }),
      ]}
      searchTerm=""
      typeFilter="all"
      historyViewMode="import_actions"
      brokerActionItems={[
        {
          actionId: "BFAQ-cost-fx-loss-1",
          severity: "warning",
          status: "open",
          label: "Potencjalna strata FX wymaga decyzji dowodowej.",
          userAction: "Dodaj dowód przewalutowania EUR/USD.",
          sourceIds: ["source:evidence-pdf"],
          costIds: ["FX-LOSS-1"],
          historySearchTerm: "FX-LOSS-1",
          linkedRowId: "linked-row-1",
        },
      ]}
      pinnedTransactionLinks={[]}
      onOpenEditor={() => undefined}
      onPinTransaction={() => undefined}
      onUnpinTransaction={() => undefined}
    />,
  );

  assert.equal(markup.includes("FX-LOSS-1"), true);
  assert.equal(markup.includes("LINKED-ROW-1"), true);
  assert.equal(markup.includes("TRADE-OTHER"), false);
});

test("EngineTransactionHistory pokazuje panel spraw importu dla rozwiniętego rekordu", () => {
  const actionItem: BrokerActionWorkbenchItem = {
    actionId: "BFAQ-cost-fx-loss-1",
    severity: "warning",
    status: "ignored",
    label: "Potencjalna strata FX wymaga decyzji dowodowej.",
    userAction: "Dodaj dowód przewalutowania EUR/USD.",
    sourceIds: ["source:evidence-pdf"],
    costIds: ["FX-LOSS-1"],
    historySearchTerm: "FX-LOSS-1",
    linkedRowId: "fx-row-1",
    userNote: "Zweryfikowane poza aplikacją, dokument w segregatorze PIT.",
    supplementalOnlyBreakdownLabel: "Odsetki/prowizje salda ujemnego: 1",
  };

  const markup = renderToStaticMarkup(
    <EngineTransactionHistory
      rows={[
        row("fx-row-1", "PRIVATE_CASH_FX", null, {
          transaction_id: "FX-LOSS-1",
          comment: "Potencjalna strata FX",
          details: { source_record_id: "source:evidence-pdf" },
        }),
      ]}
      searchTerm=""
      typeFilter="all"
      focusRowId="fx-row-1"
      uiComplexityMode="expert"
      brokerActionItems={[actionItem]}
      pinnedTransactionLinks={[]}
      onOpenEditor={() => undefined}
      onPinTransaction={() => undefined}
      onUnpinTransaction={() => undefined}
    />,
  );

  assert.equal(markup.includes("data-history-broker-action-panel=\"true\""), true);
  assert.equal(markup.includes("Sprawy importu"), true);
  assert.equal(markup.includes("Potencjalna strata FX wymaga decyzji dowodowej."), true);
  assert.equal(markup.includes("Zignorowane"), true);
  assert.equal(markup.includes("Zweryfikowane poza aplikacją"), true);
  assert.equal(markup.includes("Typy rekordów tylko pomocniczych: Odsetki/prowizje salda ujemnego: 1"), true);
  assert.equal(markup.includes("FX-LOSS-1"), true);
  assert.equal(markup.includes("source:evidence-pdf"), true);
});

test("EngineTransactionHistory pokazuje panel Dowody i PIT dla powiązanego rekordu", () => {
  const evidenceItem: DefenseWorkbenchItem = {
    id: "DEFENSE:COST-1",
    groupId: "evidence",
    checklistId: "DEFENSE:COST-1",
    evidenceId: "EVIDENCE-COST-1",
    traceId: "trace:aggressive_cost:COST-1",
    label: "Brak potwierdzenia kosztu",
    userAction: "Dodaj potwierdzenie przelewu.",
    details: "Braki: potwierdzenie przelewu",
    severity: "evidence",
    category: "defense",
    sourceRecordId: "SOURCE-1",
    linkedCostId: "COST-1",
    linkedTradeIds: ["TRADE-1"],
    linkedRowId: "trade-1",
    amountPln: "24.73",
    riskLevel: "medium",
    defenseStatus: "needs_user_evidence",
    defenseStatusLabel: "Wymaga dowodu",
    missingEvidence: ["potwierdzenie przelewu"],
    localNote: "Dokument jest w segregatorze PIT.",
    evidenceConfirmed: true,
    includedInFilingPackage: true,
    localOverride: {
      evidenceId: "EVIDENCE-COST-1",
      defenseStatus: "complete",
      linkedTradeIds: ["TRADE-1"],
      linkedRowId: "trade-1",
      updatedAt: "2026-05-11T10:00:00.000Z",
      userNote: "Dokument jest w segregatorze PIT.",
      evidenceConfirmed: true,
    },
    historyTarget: {
      searchTerm: "trade-1",
      rowId: "trade-1",
    },
  };

  const markup = renderToStaticMarkup(
    <EngineTransactionHistory
      rows={[
        row("trade-1", "TRADE", null, {
          transaction_id: "TRADE-1",
          source_refs: ["SOURCE-1"],
          side: "BUY",
          details: { source_record_id: "SOURCE-1" },
        }),
      ]}
      searchTerm=""
      typeFilter="all"
      focusRowId="trade-1"
      uiComplexityMode="expert"
      defenseWorkbenchItems={[evidenceItem]}
      pinnedTransactionLinks={[]}
      onOpenEditor={() => undefined}
      onPinTransaction={() => undefined}
      onUnpinTransaction={() => undefined}
      onConfirmEvidence={() => undefined}
      onAddEvidenceNote={() => undefined}
    />,
  );

  assert.equal(markup.includes("Dowody i PIT"), true);
  assert.equal(markup.includes("data-history-evidence-panel=\"true\""), true);
  assert.equal(markup.includes("Brak potwierdzenia kosztu"), true);
  assert.equal(markup.includes("Dokument jest w segregatorze PIT."), true);
  assert.equal(markup.includes("Dowód potwierdzony lokalnie"), true);
  assert.equal(markup.includes("Oznacz dowód jako zebrany"), true);
});

test("EngineTransactionHistory nie montuje panelu dowodowego dla nierozwinietego rekordu", () => {
  const evidenceItem: DefenseWorkbenchItem = {
    id: "DEFENSE:COST-2",
    groupId: "evidence",
    checklistId: "DEFENSE:COST-2",
    evidenceId: "EVIDENCE-COST-2",
    traceId: "trace:aggressive_cost:COST-2",
    label: "Dowód ukryty do czasu rozwinięcia",
    userAction: "Dodaj dokument.",
    details: "Braki: dokument",
    severity: "evidence",
    category: "defense",
    sourceRecordId: "SOURCE-2",
    linkedCostId: "COST-2",
    linkedTradeIds: ["TRADE-2"],
    linkedRowId: "trade-2",
    amountPln: "15.68",
    riskLevel: "medium",
    defenseStatus: "needs_user_evidence",
    defenseStatusLabel: "Wymaga dowodu",
    missingEvidence: ["dokument"],
    localNote: null,
    evidenceConfirmed: false,
    includedInFilingPackage: false,
    localOverride: null,
    historyTarget: {
      searchTerm: "trade-2",
      rowId: "trade-2",
    },
  };

  const markup = renderToStaticMarkup(
    <EngineTransactionHistory
      rows={[
        row("trade-2", "TRADE", null, {
          transaction_id: "TRADE-2",
          source_refs: ["SOURCE-2"],
          side: "BUY",
          details: { source_record_id: "SOURCE-2" },
        }),
      ]}
      searchTerm=""
      typeFilter="all"
      defenseWorkbenchItems={[evidenceItem]}
      pinnedTransactionLinks={[]}
      onOpenEditor={() => undefined}
      onPinTransaction={() => undefined}
      onUnpinTransaction={() => undefined}
    />,
  );

  assert.equal(markup.includes("data-history-evidence-panel=\"true\""), false);
  assert.equal(markup.includes("Dowód ukryty do czasu rozwinięcia"), false);
});

test("EngineTransactionHistory nie renderuje od razu całej bardzo długiej historii", () => {
  const rows = Array.from({ length: 140 }, (_, index) => (
    row(`row-${String(index + 1).padStart(3, "0")}`, "TRADE", null, {
      side: "BUY",
      ticker: `TICKER-${index + 1}`,
    })
  ));

  const markup = renderToStaticMarkup(
    <EngineTransactionHistory
      rows={rows}
      searchTerm=""
      typeFilter="all"
      pinnedTransactionLinks={[]}
      onOpenEditor={() => undefined}
      onPinTransaction={() => undefined}
      onUnpinTransaction={() => undefined}
    />,
  );

  assert.equal(markup.includes("row-001"), true);
  assert.equal(markup.includes("row-140"), false);
  assert.equal(markup.includes("Pokaż kolejne wiersze"), true);
});


test("EngineTransactionHistory: pusty stan i kolejna porcja poza wierszami tabeli (telefon)", () => {
  // Tabela jest szersza od ekranu telefonu; tekst w wierszu z colSpan
  // byl wysrodkowany poza widocznym obszarem.
  const props = {
    searchTerm: "",
    typeFilter: "all" as const,
    pinnedTransactionLinks: [],
    onOpenEditor: () => undefined,
    onPinTransaction: () => undefined,
    onUnpinTransaction: () => undefined,
  };
  const pusta = renderToStaticMarkup(<EngineTransactionHistory rows={[]} {...props} />);
  assert.match(pusta, /<\/table><div[^>]*>Brak wierszy historii/);
  assert.doesNotMatch(pusta, /colSpan|colspan/);

  const dluga = renderToStaticMarkup(
    <EngineTransactionHistory
      rows={Array.from({ length: 140 }, (_, i) => row(`r-${i}`, "TRADE", null, { side: "BUY", ticker: `T-${i}` }))}
      {...props}
    />,
  );
  assert.match(dluga, /<\/table>(?:<!-- -->)?<div[^>]*><button[^>]*>Pokaż kolejne wiersze/);
});
