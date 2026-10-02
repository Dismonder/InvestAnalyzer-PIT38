from __future__ import annotations

from dataclasses import dataclass, field
from decimal import Decimal
from pathlib import Path
from typing import Any, Literal, Optional

import pandas as pd

D = Decimal

Severity = Literal["INFO", "WARNING", "ERROR", "CRITICAL"]
RunMode = Literal["STRICT", "SAFE", "EXPLORATORY"]
FinalStatus = Literal["SUCCESS", "SUCCESS_WITH_WARNINGS", "CALCULATION_BLOCKED", "FAILED"]
MatchStrength = Literal["EXACT", "STRONG", "WEAK", "AMBIGUOUS", "NONE"]


@dataclass(frozen=True)
class Money:
    amount: Decimal
    currency: str


@dataclass
class CalculationTrace:
    result_field: str
    formula: str
    inputs: list[dict[str, str]]
    output_value: str
    notes: list[str] = field(default_factory=list)


@dataclass
class Issue:
    code: str
    severity: str
    stage: str
    scope_type: str
    scope_id: str
    message: str
    details: dict[str, Any] = field(default_factory=dict)
    blocking: bool = False
    source_refs: list[dict[str, Any]] = field(default_factory=list)
    policy_decision: str | None = None


@dataclass
class ValidationSummary:
    errors: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)
    issues: list[Issue] = field(default_factory=list)


@dataclass
class FxCoverageGap:
    currency: str
    start_date: pd.Timestamp
    end_date: pd.Timestamp
    provider_name: str
    reason: str


@dataclass
class QualityGateResult:
    filing_ready: bool
    final_status: str
    blocking_issues: list[Issue] = field(default_factory=list)
    warning_issues: list[Issue] = field(default_factory=list)
    informational_issues: list[Issue] = field(default_factory=list)
    metrics: dict[str, int] = field(default_factory=dict)


@dataclass
class PriorYearLoss:
    tax_year: int
    amount_pln: Decimal
    remaining_pln: Decimal
    accepted: bool = True
    # CLI ustawia False, gdy w starszym wpisie brak jawnego salda.
    remaining_confirmed: bool = True


@dataclass
class UserOverrides:
    manual_fx_overrides: dict[str, Decimal] = field(default_factory=dict)
    conditional_cost_ids: set[str] = field(default_factory=set)
    prior_year_losses: list[PriorYearLoss] = field(default_factory=list)
    # Koszty nabycia walut wirtualnych nieodliczone w poprzednich latach
    # (art. 22 ust. 16 ustawy o PIT). Silnik nie zna rozliczen sprzed okresu
    # objetego danymi, wiec te kwote podaje uzytkownik.
    crypto_costs_carried_forward_pln: Decimal = Decimal("0.00")
    funding_cost_events: list["FundingCostEvent"] = field(default_factory=list)
    transaction_overrides: list["TransactionOverride"] = field(default_factory=list)


@dataclass
class TransactionOverride:
    override_id: str
    mode: str
    record_type: str
    base_record_id: str | None
    manual_record_id: str
    deleted: bool
    values: dict[str, str | None] = field(default_factory=dict)
    updated_at: str = ""
    created_at: str = ""
    comment: str | None = None
    source_label: str | None = None


@dataclass
class EditableRecordDiff:
    field_name: str
    original_value: str | None
    current_value: str | None


@dataclass
class EditableRecordValidationState:
    is_valid: bool = True
    status: str = "VALID"
    errors: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)


@dataclass
class EditableRecordProjection:
    base_record_id: str | None
    manual_record_id: str
    record_type: str
    overlay_status: str
    deleted: bool
    original_values: dict[str, str | None] = field(default_factory=dict)
    current_values: dict[str, str | None] = field(default_factory=dict)
    modified_fields: list[str] = field(default_factory=list)
    validation_state: EditableRecordValidationState = field(default_factory=EditableRecordValidationState)
    diffs: list[EditableRecordDiff] = field(default_factory=list)
    title: str | None = None
    ticker: str | None = None
    display_date: Optional[pd.Timestamp] = None
    source_name: str | None = None


@dataclass
class TaxPlanConfig:
    selected_plan: str = "aggressive_user"
    include_fx_conversion_costs: bool = True
    include_bank_funding_fees: bool = True
    include_account_fees: bool = True
    include_interest_costs: bool = True
    include_misc_investment_costs: bool = True
    block_weak_cost_links_in_strict_mode: bool = True
    funding_fee_allocation_mode: str = "proportional_first_batch"
    pit8c_entries: list[dict[str, Any]] = field(default_factory=list)
    pit8c_sell_trade_ids: set[str] = field(default_factory=set)
    pit8c_no_sell_trade_ids: set[str] = field(default_factory=set)
    pit8c_source_decisions: dict[str, str] = field(default_factory=dict)


@dataclass
class CostEvidence:
    evidence_level: str
    source_ids: list[str] = field(default_factory=list)
    notes: list[str] = field(default_factory=list)


@dataclass
class CostItem:
    cost_id: str
    kind: str
    amount_foreign: Decimal
    currency: str
    tax_event_date: pd.Timestamp | None
    amount_pln: Decimal
    source_id: str
    policy_tags: set[str] = field(default_factory=set)
    evidence_level: str = "DIRECT"
    allocation_target: str | None = None
    included_in_plan: set[str] = field(default_factory=set)
    is_aggressive_only: bool = False
    derived_cost: bool = False
    notes: list[str] = field(default_factory=list)


@dataclass
class CostDecision:
    cost_id: str
    plan_name: str
    included: bool
    reason: str
    evidence_level: str
    amount_pln: Decimal
    kind: str
    aggressive_only: bool = False
    included_in_plans: set[str] = field(default_factory=set)
    policy_level: str = "STANDARD"
    blocking_issue: bool = False


@dataclass
class FundingCostEvent:
    funding_event_id: str
    amount: Decimal
    currency: str
    date: pd.Timestamp
    linked_deposit_id: str | None
    source: str
    evidence_note: str | None = None
    deposit_amount: Decimal | None = None
    amount_pln: Decimal | None = None
    deposit_amount_pln: Decimal | None = None
    source_refs: list[str] = field(default_factory=list)


@dataclass
class FundingFeeAllocation:
    allocation_id: str
    funding_event_id: str
    trade_id: str
    symbol: str
    allocated_amount_pln: Decimal
    basis_amount_pln: Decimal
    allocation_ratio: Decimal
    method: str
    deposit_id: str | None = None
    deposit_amount: Decimal | None = None
    original_amount: Decimal | None = None
    original_currency: str | None = None
    evidence_note: str | None = None
    source_refs: list[str] = field(default_factory=list)


@dataclass
class TaxFilingDraft:
    tax_year: int
    form_type: str
    filing_mode: str
    package_scope: str
    main_fields: dict[str, Decimal]
    plan_used: str
    filing_ready: bool
    form_fields: list["TaxFormField"] = field(default_factory=list)
    scenario_projections: dict[str, "TaxScenarioProjection"] = field(default_factory=dict)
    # Zalacznik PIT/ZG, po jednym na panstwo uzyskania dochodu. Broszura MF do
    # PIT-38 wymaga go dla dochodow z art. 30b uzyskanych za granica, wiec bez
    # niego rozliczenie z zagranicznego rachunku jest niekompletne.
    pit_zg_attachments: list[dict] = field(default_factory=list)


@dataclass
class TaxFormField:
    section: str
    position: str
    label: str
    value: Decimal | str | None
    note: str | None = None
    manual_entry: bool = False
    value_type: str = "money"


@dataclass
class TaxScenarioProjection:
    scenario_name: str
    revenue_pln: Decimal
    cost_pln: Decimal
    income_pln: Decimal
    rounded_base_pln: Decimal
    silnik_tax_pln: Decimal
    rounded_tax_from_base_pln: Decimal
    tax_due_pln: Decimal
    gross_dividend_pln: Decimal
    foreign_dividend_tax_pln: Decimal
    foreign_tax_credit_pln: Decimal
    # Nadwyzka podatku zaplaconego u zrodla ponad polskie 19%. Formularz nie ma
    # dla niej pozycji - po prostu przepada - ale uzytkownik ma prawo wiedziec,
    # ile stracil, wiec niesiemy ja obok pol formularza.
    foreign_tax_excess_pln: Decimal = Decimal("0.00")
    form_fields: list[TaxFormField] = field(default_factory=list)


@dataclass
class TaxCalculationReport:
    sections: list[dict[str, Any]]
    totals: dict[str, Decimal]
    issues: list[dict[str, Any]]


@dataclass
class TaxJustificationMemo:
    title: str
    summary: str
    assumptions: list[str]
    cost_categories: list[dict[str, Any]]
    fx_rules: list[str]
    policy_notes: list[str]
    evidence_summary: list[str]


@dataclass
class TaxFilingPackage:
    draft: TaxFilingDraft
    calculation: TaxCalculationReport | None = None
    justification: TaxJustificationMemo | None = None
    audit_appendix: dict[str, Any] | None = None


@dataclass
class DefenseEvidenceOverride:
    evidence_id: str
    defense_status: str
    linked_trade_ids: list[str] = field(default_factory=list)
    updated_at: str = ""
    user_note: str | None = None
    evidence_confirmed: bool = False
    checked_at: str | None = None
    included_in_filing_package: bool = False


@dataclass
class BrokerFileActionOverride:
    action_id: str
    status: str
    updated_at: str = ""
    user_note: str | None = None
    linked_row_id: str | None = None


@dataclass
class TaxFilingRequest:
    package_scope: str = "numbers_only"
    filing_mode: str = "ORIGINAL"
    defense_evidence_overrides: list[DefenseEvidenceOverride] = field(default_factory=list)
    broker_file_action_overrides: list[BrokerFileActionOverride] = field(default_factory=list)


@dataclass
class CanonicalTrade:
    trade_id: str
    order_id: Optional[str]
    trade_number: Optional[str]

    symbol: str
    isin: Optional[str]
    side: str
    instrument_type_code: Optional[str]
    instrument_class: str
    market_id: Optional[str]

    quantity: Decimal
    price: Decimal
    gross_amount: Decimal
    trade_currency: str

    commission: Decimal
    commission_currency: str
    broker_reported_profit: Optional[Decimal]

    executed_at: Optional[pd.Timestamp]
    exchange_time: Optional[pd.Timestamp]
    settlement_date: Optional[pd.Timestamp]
    confirm_time: Optional[pd.Timestamp]

    otc: bool
    repo_close: Optional[bool]
    base_contract_code: Optional[str]
    current_position_qty_after_trade: Optional[Decimal]

    source_name: str
    source_priority: int
    source_record_id: str
    match_strength: str = "EXACT"

    account_id: Optional[str] = None
    source_file: str = ""
    source_sheet: str = ""
    source_row_id: str = ""
    record_type: str = "TRADE"
    certainty_status: str = "CERTAIN"
    review_status: str = "UNREVIEWED"
    amount_mismatch: dict[str, Any] | None = None

    tax_event_date: Optional[pd.Timestamp] = None
    gross_fx_date: Optional[pd.Timestamp] = None
    gross_fx_rate: Optional[Decimal] = None
    commission_fx_date: Optional[pd.Timestamp] = None
    commission_fx_rate: Optional[Decimal] = None

    gross_amount_pln: Optional[Decimal] = None
    commission_pln: Optional[Decimal] = None
    buy_total_cost_pln: Optional[Decimal] = None
    sell_gross_revenue_pln: Optional[Decimal] = None
    sell_net_revenue_pln: Optional[Decimal] = None

    acquisition_mode: str = "STANDARD"
    tax_cost_policy: str = "STANDARD"
    logical_world: str = "equity_tax"
    cost_bucket: Optional[str] = None
    cost_class: str = "CERTAIN"
    country: Optional[str] = None
    # Kraj wpisany przez uzytkownika w edytorze transakcji. `country` wypelnia
    # parser z koncowki symbolu (kraj notowania), wiec nie nadaje sie do PIT/ZG.
    user_country: Optional[str] = None

    original_amount: Optional[Decimal] = None
    original_currency: Optional[str] = None
    original_event_date: Optional[pd.Timestamp] = None
    amount_pln: Optional[Decimal] = None
    nbp_rate: Optional[Decimal] = None
    nbp_rate_date: Optional[pd.Timestamp] = None
    comment: Optional[str] = None
    message: Optional[str] = None

    evidence_refs: list[str] = field(default_factory=list)
    decision_trace_refs: list[str] = field(default_factory=list)
    sources: list[str] = field(default_factory=list)
    source_links: list[dict[str, Any]] = field(default_factory=list)
    attached_event_ids: list[str] = field(default_factory=list)
    traces: list[CalculationTrace] = field(default_factory=list)
    overlay_status: str = "ORIGINAL"
    manual_record_id: str | None = None
    is_modified: bool = False
    is_new: bool = False
    modified_fields: list[str] = field(default_factory=list)
    original_snapshot: dict[str, Any] = field(default_factory=dict)
    current_snapshot: dict[str, Any] = field(default_factory=dict)
    status: str = "RAW"


@dataclass
class CanonicalEvent:
    event_id: str
    event_kind: str
    symbol: Optional[str]
    linked_trade_id: Optional[str]

    amount: Decimal
    currency: str
    effective_at: Optional[pd.Timestamp]
    comment: Optional[str]

    source_name: str
    source_priority: int
    source_record_id: str
    match_strength: str = "NONE"
    account_id: Optional[str] = None

    source_file: str = ""
    source_sheet: str = ""
    source_row_id: str = ""
    record_type: str = "EVENT"
    certainty_status: str = "CERTAIN"
    review_status: str = "UNREVIEWED"

    tax_event_date: Optional[pd.Timestamp] = None
    fx_date: Optional[pd.Timestamp] = None
    fx_rate: Optional[Decimal] = None
    amount_pln: Optional[Decimal] = None
    logical_world: str = "diagnostic_only"
    cost_bucket: Optional[str] = None
    cost_class: str = "DIAGNOSTIC"
    country: Optional[str] = None
    original_amount: Optional[Decimal] = None
    original_currency: Optional[str] = None
    original_event_date: Optional[pd.Timestamp] = None
    nbp_rate: Optional[Decimal] = None
    nbp_rate_date: Optional[pd.Timestamp] = None
    quantity: Optional[Decimal] = None
    grant_tax_status: Optional[str] = None
    grant_market_value: Optional[Decimal] = None
    grant_value_pln: Optional[Decimal] = None
    promotion_basis: Optional[str] = None
    completeness_status: Optional[str] = None
    acquisition_mode: Optional[str] = None
    economic_cost_pln: Optional[Decimal] = None

    evidence_refs: list[str] = field(default_factory=list)
    decision_trace_refs: list[str] = field(default_factory=list)
    sources: list[str] = field(default_factory=list)
    source_links: list[dict[str, Any]] = field(default_factory=list)
    traces: list[CalculationTrace] = field(default_factory=list)
    overlay_status: str = "ORIGINAL"
    manual_record_id: str | None = None
    is_modified: bool = False
    is_new: bool = False
    modified_fields: list[str] = field(default_factory=list)
    original_snapshot: dict[str, Any] = field(default_factory=dict)
    current_snapshot: dict[str, Any] = field(default_factory=dict)
    status: str = "RAW"


@dataclass(frozen=True)
class CanonicalDataset:
    trades: tuple[CanonicalTrade, ...] = ()
    events: tuple[CanonicalEvent, ...] = ()
    issues: tuple[Issue, ...] = ()
    metadata: dict[str, Any] = field(default_factory=dict)


@dataclass
class Ledger:
    trades_by_id: dict[str, CanonicalTrade] = field(default_factory=dict)
    events_by_id: dict[str, CanonicalEvent] = field(default_factory=dict)

    index_by_order_id: dict[str, set[str]] = field(default_factory=dict)
    index_by_symbol: dict[str, set[str]] = field(default_factory=dict)
    index_by_date: dict[str, set[str]] = field(default_factory=dict)

    issues: list[Issue] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)
    metadata: dict[str, Any] = field(default_factory=dict)


@dataclass
class FxLookupResult:
    currency: str
    tax_event_date: pd.Timestamp
    fx_date: pd.Timestamp
    rate: Decimal
    source: str


@dataclass
class TaxLot:
    lot_id: str
    symbol: str
    origin_trade_id: str
    open_date: pd.Timestamp
    acquisition_mode: str
    quantity_open: Decimal
    quantity_remaining: Decimal
    unit_cost_pln: Decimal
    fx_date: pd.Timestamp
    logical_world: str = "equity_tax"
    origin_reference_kind: str = "TRADE"
    economic_unit_cost_pln: Decimal = Decimal("0.00")


@dataclass
class RealizedTaxRow:
    row_id: str
    symbol: str
    sell_trade_id: str
    buy_trade_id: str
    quantity: Decimal

    sell_tax_date: pd.Timestamp
    buy_tax_date: pd.Timestamp
    sell_fx_date: pd.Timestamp
    buy_fx_date: pd.Timestamp

    gross_revenue_pln: Decimal
    sell_commission_alloc_pln: Decimal
    net_revenue_pln: Decimal
    cost_pln: Decimal
    pnl_pln: Decimal

    acquisition_mode: str
    buy_reference_kind: str = "TRADE"
    # Cena, waluta i kurs uzyte przy sprzedazy. Silnik znal je przy liczeniu, ale
    # nie przenosil do wiersza - zalacznik do deklaracji pokazywal wiec cene 0,
    # kurs 0 i walute PLN przy papierze notowanym w dolarach, czyli dokladnie te
    # dane, ktorych urzad oczekuje przy kontroli.
    sell_price: Decimal | None = None
    sell_currency: str | None = None
    sell_fx_rate: Decimal | None = None
    economic_cost_pln: Decimal | None = None
    economic_result_pln: Decimal | None = None
    grant_value_pln: Decimal | None = None
    traces: list[CalculationTrace] = field(default_factory=list)


@dataclass
class TransactionHistoryRow:
    row_id: str
    parent_row_id: str | None
    row_kind: str
    display_date: Optional[pd.Timestamp]
    transaction_id: str | None
    ticker: str | None
    base_record_id: str | None = None
    manual_record_id: str | None = None
    side: str | None = None
    quantity: Decimal | None = None
    amount: Decimal | None = None
    currency: str | None = None
    amount_pln: Decimal | None = None
    comment: str | None = None
    message: str | None = None
    source_name: str | None = None
    source_manifest_id: str | None = None
    conflict_count: int = 0
    tax_impact_label: str | None = None
    tax_impact_kind: str | None = None
    is_technical_only: bool = False
    tax_impact_label_pl: str | None = None
    defense_status: str | None = None
    evidence_count: int = 0
    missing_evidence_count: int = 0
    source_refs: list[str] = field(default_factory=list)
    provenance: list[dict[str, Any]] = field(default_factory=list)
    logical_world: str = "equity_tax"
    acquisition_mode: str | None = None
    grant_tax_status: str | None = None
    grant_value_pln: Decimal | None = None
    pit_result_pln: Decimal | None = None
    economic_result_pln: Decimal | None = None
    deposit_id: str | None = None
    deposit_amount: Decimal | None = None
    allocation_ratio: Decimal | None = None
    allocation_method: str | None = None
    overlay_status: str = "ORIGINAL"
    is_modified: bool = False
    is_new: bool = False
    modified_fields: list[str] = field(default_factory=list)
    original_snapshot: dict[str, Any] = field(default_factory=dict)
    current_snapshot: dict[str, Any] = field(default_factory=dict)
    read_only: bool = True
    details: dict[str, Any] = field(default_factory=dict)


@dataclass
class PrivateCashFxRow:
    row_id: str
    source_event_id: str
    use_reference: str
    currency: str
    quantity: Decimal
    source_fx_rate: Decimal
    use_fx_rate: Decimal
    pnl_pln: Decimal
    source_date: Optional[pd.Timestamp] = None
    use_date: Optional[pd.Timestamp] = None
    note: str = ""


@dataclass
class ScenarioResult:
    scenario_name: str
    risk_level: str
    gross_result_pln: Decimal
    taxable_base_pln: Decimal
    tax_19_pln: Decimal
    taxes_from_dane_pln: Decimal
    net_pln: Decimal
    total_revenue_pln: Decimal
    total_cost_pln: Decimal
    delta_vs_defensible_pln: Decimal = Decimal("0.00")
    additional_costs: list[str] = field(default_factory=list)
    notes: list[str] = field(default_factory=list)


@dataclass
class MergeResult:
    ledger: Ledger
    canonical_dataset: CanonicalDataset
    unmatched_trades: list[str] = field(default_factory=list)
    unmatched_events: list[str] = field(default_factory=list)
    reconciliation_summary: dict[str, Any] = field(default_factory=dict)


@dataclass
class EngineConfig:
    run_mode: str = "STRICT"
    trade_match_time_tolerance_hours: int = 4
    money_tolerance: Decimal = Decimal("0.02")
    aggregate_tolerance: Decimal = Decimal("0.05")

    trade_tax_date_policy: str = "EXECUTION_DATE_FIRST"
    event_tax_date_policy: str = "EFFECTIVE_DATE"
    nbp_allow_api_fallback: bool = True
    nbp_allow_manual_override: bool = False
    use_nbp_api_fallback: bool = True
    prefer_local_nbp_archive: bool = True
    cache_nbp_api_responses: bool = True

    tax_year: int | None = None
    default_scenario: str = "defensible"
    award_policy: str = "REQUIRE_EXPLICIT"
    pii_redaction_enabled: bool = True
    user_overrides: UserOverrides = field(default_factory=UserOverrides)
    tax_plan: TaxPlanConfig = field(default_factory=TaxPlanConfig)
    tax_filing_request: TaxFilingRequest | None = None


@dataclass
class InputBundle:
    api_json_path: Path
    trades_v1_path: Path
    trades_legacy_path: Path
    tradernet_table_path: Path
    broker_json_path: Path | None = None
    broker_xml_path: Path | None = None
    depo_json_path: Path | None = None
    cashflow23_path: Path | None = None
    transakcje23_path: Path | None = None
    nbp_csv_paths: list[Path] | None = None
    # Taryfa oplat brokera. Sluzy wylacznie do kontroli spojnosci naliczen za
    # ujemne saldo - stawka podana przy konkretnym naliczeniu ma pierwszenstwo.
    tariff_pdf_path: Path | None = None
    output_dir: Path = Path("./out")
    user_overrides: UserOverrides = field(default_factory=UserOverrides)
    metadata: dict[str, Any] = field(default_factory=dict)


@dataclass
class EngineRunResult:
    status: str
    filing_ready: bool
    config: EngineConfig
    canonical_dataset: CanonicalDataset
    merge_result: MergeResult
    filing_profile: str = "STANDARD"
    plan_used: str = "aggressive_user"

    fifo_rows: list[RealizedTaxRow] = field(default_factory=list)
    # Czesc E PIT-38: waluty wirtualne. Rozliczane bez kolejki FIFO, z kosztem
    # w roku poniesienia i z pominieciem wymian krypto na krypto.
    crypto_part_e: dict[str, Any] = field(default_factory=dict)
    dividends_view: list[dict[str, Any]] = field(default_factory=list)
    foreign_tax_view: list[dict[str, Any]] = field(default_factory=list)
    private_cash_fx_view: list[PrivateCashFxRow] = field(default_factory=list)
    financing_comparison: dict[str, Any] = field(default_factory=dict)
    scenario_results: dict[str, ScenarioResult] = field(default_factory=dict)
    cost_items: list[CostItem] = field(default_factory=list)
    cost_decisions: list[CostDecision] = field(default_factory=list)
    funding_fee_allocations: list[FundingFeeAllocation] = field(default_factory=list)
    primary_scenario: str = "defensible"
    annual_summary: dict[str, Any] = field(default_factory=dict)
    quality_report: QualityGateResult | None = None
    # Zestawienie wejscie-wyjscie dla kazdej kategorii zdarzen.
    category_coverage: list[dict[str, Any]] = field(default_factory=list)
    fx_coverage_gaps: list[FxCoverageGap] = field(default_factory=list)
    depo_reconciliation: list[dict[str, Any]] = field(default_factory=list)
    financing_ledger: dict[str, Any] = field(default_factory=dict)
    tax_filing_package: TaxFilingPackage | None = None
    actionable_issues: list[Issue] = field(default_factory=list)
    informational_issues: list[Issue] = field(default_factory=list)
    transaction_history_rows: list[TransactionHistoryRow] = field(default_factory=list)
    editable_records: list[EditableRecordProjection] = field(default_factory=list)

    exported_files: list[Path] = field(default_factory=list)
    audit_hash: Optional[str] = None
    performance_profile: dict[str, Any] = field(default_factory=dict)
