from __future__ import annotations

import json
import os
import re
from dataclasses import asdict, replace
from decimal import Decimal
from hashlib import sha256
from pathlib import Path
from time import perf_counter
from typing import Any

import pandas as pd

from investment_tax_engine.app.history_projection import build_transaction_history_rows
from investment_tax_engine.app.canonical_tax_input_adapter import (
    CANONICAL_TAX_INPUT_EVENT_SOURCE,
    CANONICAL_TAX_INPUT_TRADE_SOURCE,
    build_parsed_sources_from_canonical_tax_input,
    canonical_tax_input_has_engine_records,
    BLOCKING_NOTE_SHARE_COUNT,
    symbol_bez_rynku,
    zgodne_kwoty_wykupu,
    zgodne_waluty_wykupu,
)
from investment_tax_engine.app.manual_overrides import apply_manual_overrides
from investment_tax_engine.export.audit_json import export_audit_json
from investment_tax_engine.tax.crypto_engine import czy_prowizja_w_walucie_wirtualnej, oblicz_czesc_e, czy_wymiana_krypto_na_krypto
from investment_tax_engine.export.workbook import export_workbook
from investment_tax_engine.merge.depo_reconcile import (
    build_supplemental_depo_records,
    load_depo_payload,
    reconcile_fifo_lots_vs_depo,
    reconcile_positions_vs_depo,
)
from investment_tax_engine.merge.merge_engine import (
    build_dataset_from_ledger,
    merge_dataset,
    upsert_event,
    upsert_trade,
)
from investment_tax_engine.merge.reconcile import reconcile_sources
from investment_tax_engine.models.core import (
    CanonicalDataset,
    CanonicalEvent,
    CanonicalTrade,
    EngineConfig,
    EngineRunResult,
    InputBundle,
    Issue,
    Ledger,
    MergeResult,
    UserOverrides,
    ValidationSummary,
)
from investment_tax_engine.normalize.events import (
    normalize_tradernet_event,
)
from investment_tax_engine.normalize.trades import (
    DATE_KEYS,
    determine_trade_currency,
    normalize_trade_row,
    ustal_kolejnosc_dat,
)
from investment_tax_engine.normalize.trades import operation_code, operation_review_kind, tolerancja_kwoty_transakcji
from investment_tax_engine.parsers.api_json import ApiJsonParser
from investment_tax_engine.parsers.broker_json import BrokerJsonParser
from investment_tax_engine.parsers.broker_report_json import BrokerReportJsonParser
from investment_tax_engine.parsers.broker_xml import BrokerXmlParser
from investment_tax_engine.parsers.legacy_excel import LegacyExcelParser
from investment_tax_engine.parsers.tradernet_table_excel import TradernetTableParser
from investment_tax_engine.parsers.v1_excel import V1ExcelParser
from investment_tax_engine.tax.fifo_engine import build_fifo_tax_rows
from investment_tax_engine.tax.cost_policy_engine import apply_tax_plan, extract_cost_items
from investment_tax_engine.tax.filing_package import generate_tax_filing_package, populate_form_summary
from investment_tax_engine.tax.fx_engine import (
    enrich_merge_result_with_fx,
    resolve_event_tax_event_date,
    resolve_trade_tax_event_date,
)
from investment_tax_engine.tax.nbp_provider import build_fx_provider
from investment_tax_engine.ai.pdf_tariff_extractor import extract_daily_margin_rates
from investment_tax_engine.tax.financing_ledger import (
    build_financing_ledger,
    check_rates_against_tariff,
    mark_open_episodes,
    summarize_financing_ledger,
)
from investment_tax_engine.tax.policies import PLAN_TO_SCENARIO
from investment_tax_engine.tax.pit38_engine import build_pit38_views, compute_audit_hash
from investment_tax_engine.tax.pit_zg import UNKNOWN_COUNTRY, build_pit_zg_rows, symbole_bez_kraju
from investment_tax_engine.validation.category_coverage import (
    build_category_coverage_issues,
    coverage_summary,
)
from investment_tax_engine.validation.quality_gates import build_quality_report


def is_trade_like_row(row: dict[str, Any]) -> bool:
    trade_keys = {"id", "order_id", "q", "p", "v", "Numer", "Quantity", "Cena", "Kwota"}
    return bool(trade_keys.intersection(row.keys()))

class InvestmentTaxEngine:
    def __init__(self, config: EngineConfig) -> None:
        self.config = config

    def validate_input_bundle(self, bundle: InputBundle) -> ValidationSummary:
        summary = ValidationSummary()
        canonical_mode = str(bundle.metadata.get("canonical_tax_input_mode") or "prefer").lower()
        has_canonical_engine_input = canonical_tax_input_has_engine_records(
            bundle.metadata.get("canonical_tax_input") if isinstance(bundle.metadata, dict) else None
        ) and canonical_mode in {"prefer", "required"}
        if canonical_mode == "required":
            if not has_canonical_engine_input:
                summary.warnings.append(
                    "canonical_tax_input.json is required but has no complete calculation records. "
                    "Import remains accepted; the result needs mapping or review before calculations can run."
                )
                summary.issues.append(
                    Issue(
                        # Kod jest w INPUT_INTEGRITY_GATE_CODES, ale bramka
                        # przepuszcza tylko ERROR i CRITICAL - z waga WARNING
                        # rozliczenie z pustego pliku konczylo sie podatkiem
                        # 0 zl i pakietem gotowym do urzedu. Import nadal jest
                        # przyjmowany (blocking=False), pakiet - nie.
                        code="CANONICAL_TAX_INPUT_EMPTY",
                        severity="ERROR",
                        stage="VALIDATE",
                        scope_type="FILE",
                        scope_id="canonical_tax_input.json",
                        message=(
                            "Plik canonical_tax_input.json jest wymaganym wejściem silnika, ale nie zawiera "
                            "kompletnych rekordów do obliczeń. Nie użyto starszego parsera zapasowego. Otwórz Dokumenty i silnik, aby poprawić mapowanie lub dane."
                        ),
                        blocking=False,
                    )
                )
        else:
            required = {
                "api_json_path": bundle.api_json_path,
                "trades_v1_path": bundle.trades_v1_path,
                "trades_legacy_path": bundle.trades_legacy_path,
                "tradernet_table_path": bundle.tradernet_table_path,
            }
            for name, path in required.items():
                # Sciezka bywa pusta, gdy uzytkownik wylaczyl plik z rozliczenia.
                if not has_canonical_engine_input and (path is None or not path.exists()):
                    summary.errors.append(f"Missing required input: {name} -> {path}")
                    summary.issues.append(
                        Issue(
                            code="MISSING_REQUIRED_INPUT",
                            severity="CRITICAL",
                            stage="VALIDATE",
                            scope_type="FILE",
                            scope_id=str(path),
                            message=f"Brakuje wymaganego pliku wejściowego: {name}. Otwórz Dokumenty i silnik i dodaj plik do rozliczenia.",
                            blocking=False,
                        )
                    )

        if not bundle.nbp_csv_paths:
            summary.warnings.append("No NBP CSV archives were supplied. Engine will rely on configured fallbacks.")
        else:
            for path in bundle.nbp_csv_paths:
                if not path.exists():
                    summary.errors.append(f"Missing NBP CSV archive: {path}")
                    summary.issues.append(
                        Issue(
                            code="MISSING_REQUIRED_INPUT",
                            severity="CRITICAL",
                            stage="VALIDATE",
                            scope_type="FILE",
                            scope_id=str(path),
                            message="Skonfigurowane archiwum CSV NBP nie istnieje. Otwórz Dokumenty i silnik i wskaż poprawne archiwum kursów.",
                            blocking=False,
                        )
                    )
        return summary

    def _merge_user_overrides_from_bundle(self, bundle: InputBundle) -> UserOverrides:
        config_overrides = self.config.user_overrides
        bundle_overrides = bundle.user_overrides
        return UserOverrides(
            manual_fx_overrides={**config_overrides.manual_fx_overrides, **bundle_overrides.manual_fx_overrides},
            conditional_cost_ids=set(config_overrides.conditional_cost_ids) | set(bundle_overrides.conditional_cost_ids),
            prior_year_losses=[*config_overrides.prior_year_losses, *bundle_overrides.prior_year_losses],
            # Pole gubilo sie przy scalaniu: koszt krypto przeniesiony z lat
            # ubieglych (CLI --crypto-costs-carried-forward, ustawienie w aplikacji)
            # spadal do zera, a czesc E liczyla podatek od calego przychodu -
            # ze statusem gotowym do zlozenia. Wartosc z zadania ma pierwszenstwo.
            crypto_costs_carried_forward_pln=(
                bundle_overrides.crypto_costs_carried_forward_pln
                or config_overrides.crypto_costs_carried_forward_pln
            ),
            funding_cost_events=[*config_overrides.funding_cost_events, *bundle_overrides.funding_cost_events],
            transaction_overrides=[*config_overrides.transaction_overrides, *bundle_overrides.transaction_overrides],
        )

    def parse_sources(self, bundle: InputBundle) -> list[dict[str, Any]]:
        canonical_mode = str(bundle.metadata.get("canonical_tax_input_mode") or "prefer").lower()
        if canonical_mode in {"prefer", "required"}:
            parsed_from_canonical, consumption_report = build_parsed_sources_from_canonical_tax_input(
                bundle.metadata.get("canonical_tax_input") if isinstance(bundle.metadata, dict) else None,
                canonical_mode=canonical_mode,
                tax_year=self.config.tax_year,
                review_decisions=bundle.metadata.get("review_decisions") if isinstance(bundle.metadata, dict) else None,
            )
            bundle.metadata["canonical_tax_input_consumption_runtime"] = consumption_report
            if parsed_from_canonical:
                return parsed_from_canonical
            if canonical_mode == "required":
                return []

        parser_specs = [
            ("API_JSON_FULL", ApiJsonParser(), bundle.api_json_path),
            ("TRADES_V1", V1ExcelParser(), bundle.trades_v1_path),
            ("TRADES_LEGACY", LegacyExcelParser(), bundle.trades_legacy_path),
            ("TRADERNET_TABLE", TradernetTableParser(), bundle.tradernet_table_path),
            ("BROKER_JSON", BrokerJsonParser(), bundle.broker_json_path),
            ("BROKER_XML", BrokerXmlParser(), bundle.broker_xml_path),
        ]

        parsed: list[dict[str, Any]] = []
        for source_name, parser, path in parser_specs:
            if path is None or not path.exists():
                continue
            parsed.append(
                {
                    "source": source_name,
                    "source_file": str(path),
                    "source_sheet": "sheet1",
                    "rows": parser.parse(path),
                }
            )
        return parsed

    def _source_id(self, source_name: str, source_file: str) -> str:
        path = Path(source_file)
        fingerprint = sha256(str(path).lower().encode("utf-8")).hexdigest()[:10]
        return f"src:{source_name.lower()}:{fingerprint}"

    def _file_hash(self, source_file: str) -> str:
        path = Path(source_file)
        if not path.exists() or not path.is_file():
            return ""
        digest = sha256()
        with path.open("rb") as handle:
            for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                digest.update(chunk)
        return digest.hexdigest()

    def _detect_source_type(self, source_name: str, source_file: str) -> str:
        suffix = Path(source_file).suffix.lower()
        if source_name == "BROKER_REPORT_JSON":
            return "fresh_broker_report_json"
        if source_name == "BROKER_JSON":
            return "local_broker_report_json"
        if source_name == "BROKER_XML":
            return "local_broker_report_xml"
        if source_name in {"TRADES_V1", "TRADES_LEGACY"}:
            return "broker_trades_excel"
        if source_name == "TRADERNET_TABLE":
            return "broker_cashflow_excel"
        if source_name == "API_JSON_FULL":
            return "local_broker_history_json"
        if suffix in {".xlsx", ".xls"}:
            return "spreadsheet"
        if suffix == ".json":
            return "json"
        if suffix == ".xml":
            return "xml"
        return "unknown"

    def _json_sections(self, source_file: str) -> list[str]:
        path = Path(source_file)
        if path.suffix.lower() != ".json" or not path.exists():
            return []
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
        except Exception:
            return []
        if not isinstance(payload, dict):
            return []
        sections: list[str] = []
        for key, value in payload.items():
            if isinstance(value, (list, dict)):
                sections.append(str(key))
        return sections

    def _row_date_range(self, rows: list[dict[str, Any]]) -> dict[str, str | None]:
        date_keys = (
            "date",
            "Data",
            "Date",
            "datetime",
            "executed_at",
            "exchange_time",
            "settlement_date",
            "Data rozliczenia",
            "Execution time",
        )
        dates: list[pd.Timestamp] = []
        for row in rows:
            for key in date_keys:
                value = row.get(key)
                if value is None or value == "":
                    continue
                try:
                    parsed = pd.Timestamp(value)
                except Exception:
                    continue
                if not pd.isna(parsed):
                    dates.append(parsed.normalize())
                    break
        if not dates:
            return {"from": None, "to": None}
        return {"from": str(min(dates).date()), "to": str(max(dates).date())}

    def _row_record_key(self, row: dict[str, Any]) -> str | None:
        for key in ("id", "order_id", "trade_id", "Numer", "Number", "source_record_id"):
            value = row.get(key)
            if value is not None and value != "":
                return str(value)
        return None

    def _build_source_manifest(self, parsed: list[dict[str, Any]]) -> list[dict[str, Any]]:
        manifests: list[dict[str, Any]] = []
        for entry in parsed:
            source_name = str(entry.get("source") or "")
            source_file = str(entry.get("source_file") or "")
            rows = [row for row in entry.get("rows", []) if isinstance(row, dict)]
            trade_like_rows = sum(1 for row in rows if is_trade_like_row(row))
            event_like_rows = len(rows) - trade_like_rows
            sections = self._json_sections(source_file) or [str(entry.get("source_sheet") or "sheet1")]
            warnings: list[str] = []
            errors: list[str] = []
            if not rows:
                warnings.append("Plik zostal rozpoznany, ale parser nie zwrocil rekordow.")
            if trade_like_rows == 0 and event_like_rows == 0:
                warnings.append("Brak rekordow wplywajacych na dalszy pipeline.")
            manifests.append(
                {
                    "sourceId": self._source_id(source_name, source_file),
                    "filename": Path(source_file).name,
                    "hash": self._file_hash(source_file),
                    "detectedType": self._detect_source_type(source_name, source_file),
                    "sections": sections,
                    "recordCounts": {
                        "rows": len(rows),
                        "trade_like_rows": trade_like_rows,
                        "event_like_rows": event_like_rows,
                    },
                    "dateRange": self._row_date_range(rows),
                    "contributesToTax": bool(
                        trade_like_rows or source_name in {"TRADERNET_TABLE", "BROKER_JSON", "BROKER_XML", "BROKER_REPORT_JSON"}
                    ),
                    "warnings": warnings,
                    "errors": errors,
                }
            )
        return manifests

    def _build_import_intelligence_report(
        self,
        parsed: list[dict[str, Any]],
        source_manifest: list[dict[str, Any]],
    ) -> dict[str, Any]:
        keys_by_record: dict[str, list[str]] = {}
        for entry in parsed:
            source_file = str(entry.get("source_file") or "")
            source_name = str(entry.get("source") or "")
            source_id = self._source_id(source_name, source_file)
            for row in entry.get("rows", []) or []:
                if not isinstance(row, dict):
                    continue
                record_key = self._row_record_key(row)
                if record_key:
                    keys_by_record.setdefault(record_key, []).append(source_id)
        duplicates = [
            {"record_key": record_key, "sources": sorted(set(sources))}
            for record_key, sources in sorted(keys_by_record.items())
            if len(set(sources)) > 1
        ]
        missing_expected = []
        if not any(manifest.get("contributesToTax") for manifest in source_manifest):
            missing_expected.append("Brak pliku z rekordami podatkowymi lub transakcyjnymi.")
        return {
            "sources": source_manifest,
            "duplicates": duplicates,
            "conflicts": [],
            "missingExpectedSections": missing_expected,
            "recommendedActions": [
                "Sprawdz duplikaty rekordow miedzy plikami brokera przed zlozeniem PIT."
                for _ in duplicates[:1]
            ],
        }

    def normalize(self, parsed: list[dict[str, Any]], validation: ValidationSummary | None = None) -> CanonicalDataset:
        trades = []
        events = []
        unrecognized_operation_records: list[dict[str, Any]] = []
        issues = list(validation.issues if validation is not None else [])
        source_manifest = self._build_source_manifest(parsed)
        metadata = {
            "parsed_sources": [entry["source"] for entry in parsed],
            "source_manifest_v2": source_manifest,
            "import_intelligence_report": self._build_import_intelligence_report(parsed, source_manifest),
        }

        for entry in parsed:
            source_name = entry["source"]
            source_file = entry["source_file"]
            source_sheet = entry["source_sheet"]
            rows = entry["rows"]
            # Data z ukosnikiem ("03/04/2025") jest niejednoznaczna, a jej kolejnosc
            # (DD/MM czy MM/DD) wynika z calego pliku - jak w magazynie. Czytana
            # wiersz po wierszu dawala w pliku amerykanskim inny dzien i kurs NBP,
            # a zdarzenia nie dostawaly kolejnosci wcale. Zrodla kanoniczne dostaly
            # ja juz w magazynie.
            if source_name not in {CANONICAL_TAX_INPUT_TRADE_SOURCE, CANONICAL_TAX_INPUT_EVENT_SOURCE}:
                try:
                    kolejnosc_dat = ustal_kolejnosc_dat(
                        wartosc
                        for row in rows
                        if isinstance(row, dict)
                        for klucz in (*DATE_KEYS, "datetime", "Data rozliczenia", "Execution time", "Date")
                        for wartosc in [row.get(klucz)]
                        if wartosc is not None
                    )
                except ValueError as exc:
                    issues.append(
                        Issue(
                            code="SOURCE_INPUT_READ_FAILED", severity="ERROR", stage="NORMALIZE",
                            scope_type="SOURCE", scope_id=Path(source_file).name or source_name,
                            message=(
                                f"Nie udało się odczytać dat z pliku {Path(source_file).name or source_name}: {exc} "
                                "Plik nie wszedł do rozliczenia. Popraw go w Dokumenty i silnik."
                            ),
                            blocking=True,
                        )
                    )
                    continue
                if kolejnosc_dat is not None:
                    rows = [
                        {**row, "kolejnosc_dat_pliku": kolejnosc_dat}
                        if isinstance(row, dict) and not row.get("kolejnosc_dat_pliku")
                        else row
                        for row in rows
                    ]
            for index, row in enumerate(rows, start=1):
                try:
                    # Wykup noty w `corporate_actions` nie jest zwykłym
                    # komentarzem: broker podaje liczbę sztuk, kwotę wykupu,
                    # datę i walutę. Zapisujemy go jako SELL, aby zamknął FIFO
                    # i trafił do PIT za rok wykupu. Pozostałe corporate actions
                    # nadal są tylko zdarzeniami wymagającymi decyzji.
                    if (
                        source_name == "BROKER_REPORT_JSON"
                        and row.get("broker_report_section") == "corporate_actions"
                        and str(row.get("type") or "").strip().lower() in {"termin zapadalności", "maturity", "redemption"}
                    ):
                        maturity_row = {
                            **row,
                            "id": f"BROKER-MATURITY-{row.get('corporate_action_id') or row.get('id') or index}",
                            "side": "SELL",
                            "q": row.get("q_on_ex_date"),
                            "p": row.get("amount_per_one"),
                            "v": row.get("amount"),
                            "Currency": row.get("currency"),
                            "date": row.get("date") or row.get("ex_date"),
                        }
                        trades.append(
                            normalize_trade_row(
                                maturity_row,
                                source_name=source_name,
                                source_file=source_file,
                                source_sheet=source_sheet,
                            )
                        )
                    elif source_name in {"TRADERNET_TABLE", CANONICAL_TAX_INPUT_EVENT_SOURCE} or (
                        source_name == "BROKER_REPORT_JSON"
                        and row.get("broker_report_row_type") == "FRESH_BROKER_REPORT_EVENT"
                    ):
                        events.append(
                            normalize_tradernet_event(
                                row,
                                source_name=source_name,
                                source_file=source_file,
                                source_sheet=source_sheet,
                            )
                        )
                    elif source_name == "BROKER_REPORT_JSON" and row.get("broker_report_row_type") != "FRESH_BROKER_REPORT_TRADE":
                        continue
                    elif is_trade_like_row(row):
                        trade = normalize_trade_row(
                            row,
                            source_name=source_name,
                            source_file=source_file,
                            source_sheet=source_sheet,
                        )
                        trades.append(trade)
                        operation_value = operation_code(row)
                        has_instrument = (bool(trade.symbol) and trade.symbol != "UNKNOWN") or bool(trade.isin)
                        has_quantity = trade.quantity != 0
                        complete_except_operation = (
                            any((trade.executed_at, trade.exchange_time, trade.settlement_date))
                            and determine_trade_currency(row, trade.symbol)[1] == "CERTAIN"
                            and (trade.price != 0 or trade.gross_amount != 0)
                        )
                        if (
                            trade.side == "UNKNOWN"
                            and has_instrument
                            and has_quantity
                            and (bool(operation_value) or complete_except_operation)
                        ):
                            unrecognized_operation_records.append({
                                "source": Path(source_file).name or source_name,
                                "record_id": trade.trade_id,
                                "operation_code": operation_value,
                                "ticker": trade.symbol,
                                "quantity": str(trade.quantity),
                            })
                    else:
                        issues.append(
                            Issue(
                                code="UNMATCHED_EVENT_ROW",
                                severity="WARNING",
                                stage="NORMALIZE",
                                scope_type="FILE",
                                scope_id=f"{source_name}:{index}",
                                message="Nie udało się rozpoznać wiersza pliku jako transakcji ani zdarzenia, więc nie wchodzi do rozliczenia. Sprawdź ten wiersz w pliku źródłowym.",
                                blocking=False,
                            )
                        )
                except Exception as exc:
                    issues.append(
                        Issue(
                            code="NORMALIZE_ERROR",
                            severity="ERROR",
                            stage="NORMALIZE",
                            scope_type="FILE",
                            scope_id=f"{source_name}:{index}",
                                message=(
                                    f"Nie udało się przetworzyć pliku {Path(source_file).name}, wiersz {index}. "
                                    "Sprawdź ten wiersz w pliku źródłowym albo usuń plik z magazynu. "
                                    f"Szczegóły błędu: {exc}"
                                ),
                            blocking=False,
                        )
                    )

        if unrecognized_operation_records:
            metadata["unrecognized_operation_records"] = unrecognized_operation_records

        return CanonicalDataset(
            trades=tuple(trades),
            events=tuple(events),
            issues=tuple(issues),
            metadata=metadata,
        )

    def _attach_bundle_metadata(self, dataset: CanonicalDataset, bundle: InputBundle) -> CanonicalDataset:
        if not bundle.metadata:
            return dataset
        metadata = {**dataset.metadata, **bundle.metadata}
        resolver_sources = [
            entry
            for entry in (bundle.metadata.get("source_resolution_manifest_entries") or [])
            if isinstance(entry, dict)
        ]
        if resolver_sources:
            by_id: dict[str, dict[str, Any]] = {}
            for entry in [*(dataset.metadata.get("source_manifest_v2") or []), *resolver_sources]:
                if not isinstance(entry, dict):
                    continue
                key = str(entry.get("sourceId") or entry.get("filename") or len(by_id))
                by_id[key] = {**by_id.get(key, {}), **entry}
            metadata["source_manifest_v2"] = list(by_id.values())
            intelligence = dict(metadata.get("import_intelligence_report") or {})
            intelligence["sources"] = metadata["source_manifest_v2"]
            metadata["import_intelligence_report"] = intelligence
        return CanonicalDataset(
            trades=dataset.trades,
            events=dataset.events,
            issues=dataset.issues,
            metadata=metadata,
        )

    def merge(self, dataset: CanonicalDataset) -> MergeResult:
        return merge_dataset(dataset, self.config)

    def _depo_report_matches_tax_year(self, payload: dict[str, Any]) -> bool:
        if self.config.tax_year is None:
            return False
        end_value = payload.get("date_end") or payload.get("account_at_end", {}).get("date")
        if not end_value:
            return False
        try:
            return pd.Timestamp(end_value).year == self.config.tax_year
        except Exception:
            return False

    def _depo_report_matches_input_horizon(self, merge_result: MergeResult, payload: dict[str, Any]) -> bool:
        report_end_value = payload.get("date_end") or payload.get("account_at_end", {}).get("date")
        if not report_end_value:
            return False
        try:
            report_end = pd.Timestamp(report_end_value).normalize()
        except Exception:
            return False

        latest_dates: list[pd.Timestamp] = []
        for trade in merge_result.ledger.trades_by_id.values():
            candidate = trade.exchange_time or trade.executed_at or trade.settlement_date
            if candidate is not None:
                latest_dates.append(pd.Timestamp(candidate).normalize())
        for event in merge_result.ledger.events_by_id.values():
            if event.effective_at is not None:
                latest_dates.append(pd.Timestamp(event.effective_at).normalize())
        if not latest_dates:
            return False
        return max(latest_dates) <= report_end

    def reconcile(self, merge_result: MergeResult, bundle: InputBundle) -> tuple[MergeResult, list[dict[str, Any]]]:
        merge_result = reconcile_sources(merge_result, bundle)
        depo_rows: list[dict[str, Any]] = []
        depo_payload = load_depo_payload(bundle.depo_json_path)

        if depo_payload is not None:
            supplemental_trades, supplemental_events = build_supplemental_depo_records(
                depo_payload,
                source_file=str(bundle.depo_json_path or ""),
            )
            for trade in supplemental_trades:
                # Wykup zapisany juz jako sprzedaz (z raportu maklerskiego albo
                # z historii transakcji) nie moze zamknac tej samej pozycji drugi
                # raz - druga sprzedaz nie mialaby pokrycia w FIFO. Echo wykupu ma
                # cene albo kwote wykupu; zwykla sprzedaz tej samej ilosci z tych
                # dni to inna transakcja i nie moze ukryc wykupu pozostalych sztuk.
                if str(trade.trade_id).startswith("DEPO-MATURITY-") and any(
                    other.side == "SELL"
                    and other.trade_id != trade.trade_id
                    and str(other.symbol).split(".")[0].upper() == str(trade.symbol).split(".")[0].upper()
                    and other.quantity == trade.quantity
                    and (other.tax_event_date or other.executed_at) is not None
                    and (trade.tax_event_date or trade.executed_at) is not None
                    and abs(
                        (
                            (other.tax_event_date or other.executed_at).date()
                            - (trade.tax_event_date or trade.executed_at).date()
                        ).days
                    )
                    <= 3
                    and zgodne_waluty_wykupu(other.trade_currency, trade.trade_currency)
                    and (
                        zgodne_kwoty_wykupu(abs(other.price or 0) or None, abs(trade.price or 0) or None)
                        or zgodne_kwoty_wykupu(abs(other.gross_amount or 0) or None, abs(trade.gross_amount or 0) or None)
                    )
                    for other in merge_result.ledger.trades_by_id.values()
                ):
                    continue
                upsert_trade(merge_result.ledger, trade)
            for event in supplemental_events:
                upsert_event(merge_result.ledger, event)
            merge_result.canonical_dataset = build_dataset_from_ledger(merge_result.ledger)
            merge_result.reconciliation_summary["depo_supplemental_trade_count"] = len(supplemental_trades)
            merge_result.reconciliation_summary["depo_supplemental_event_count"] = len(supplemental_events)

            if self._depo_report_matches_tax_year(depo_payload) and self._depo_report_matches_input_horizon(merge_result, depo_payload):
                depo_rows = reconcile_positions_vs_depo(
                    merge_result.ledger,
                    depo_payload,
                    aggregate_tolerance=self.config.aggregate_tolerance,
                )
                # Drugie uzgodnienie, z innego zrodla: partie pozostale w
                # rejestrze FIFO. Suma kupna i sprzedazy moze zgadzac sie z
                # brokerem, a rejestr partii - nie, bo zna akcje przyznane,
                # wykupy i sprzedaze bez pokrycia. To wlasnie rejestr niesie
                # podstawe kosztowa, wiec jego rozjazd zmienia kwote podatku.
                fifo_rows_reconciliation = reconcile_fifo_lots_vs_depo(
                    merge_result.ledger,
                    depo_payload,
                    self.config,
                    aggregate_tolerance=self.config.aggregate_tolerance,
                )
                merge_result.reconciliation_summary["fifo_ledger_reconciliation_rows"] = len(
                    fifo_rows_reconciliation
                )
                merge_result.reconciliation_summary["fifo_ledger_reconciliation"] = fifo_rows_reconciliation
            else:
                merge_result.ledger.issues.append(
                    Issue(
                        code="DEPO_RECONCILIATION_SKIPPED",
                        severity="INFO",
                        stage="RECONCILE",
                        scope_type="ENGINE",
                        scope_id="depo_json",
                        message="Pominięto kontrolę stanu końcowego DePo, ponieważ zakres raportu nie obejmuje wybranego roku podatkowego. Sprawdź raport w Dokumenty i silnik.",
                        blocking=False,
                    )
                )
        else:
            merge_result.ledger.issues.append(
                Issue(
                    code="DEPO_JSON_NOT_SUPPLIED",
                    severity="INFO",
                    stage="RECONCILE",
                    scope_type="ENGINE",
                    scope_id="depo_json",
                    message="Nie dodano raportu DePo/kontrolnego, więc pominięto uzgodnienie pozycji. Dodaj raport w Dokumenty i silnik.",
                    blocking=False,
                )
            )

        self._ujednolic_symbole(merge_result.ledger)
        merge_result.canonical_dataset = build_dataset_from_ledger(merge_result.ledger)
        merge_result.reconciliation_summary["depo_reconciliation_rows"] = len(depo_rows)
        return merge_result, depo_rows

    _SUFIKS_RYNKU = re.compile(r"^(?P<baza>[A-Z0-9]+)\.(?P<rynek>US|EU|DE|UK|L|PL|PA|TO|WA|CRPT)$")

    def _ujednolic_symbole(self, ledger) -> None:
        """Ten sam walor zapisany raz jako `NBIS`, raz jako `NBIS.US`, to jeden walor.

        FIFO dopasowuje sprzedaz do zakupow po symbolu. Gdy jeden plik zapisuje
        walor z sufiksem rynku, a drugi bez, sprzedaz nie znajduje swoich partii
        i wchodzi do rozliczenia jako sprzedaz bez pokrycia z ZEROWYM kosztem.
        Na rachunku uzytkownika bylo tak z NBIS: 201 sztuk, 167 840,57 PLN
        przychodu bez kosztu, co zawyzalo dochod z 100 tys. do 268 tys. PLN.

        Laczymy tylko wtedy, gdy baza wystepuje z DOKLADNIE jednym sufiksem -
        `VOD.L` i `VOD.US` to dwa rozne notowania i nie wolno ich scalic.
        """
        symbole = {str(getattr(trade, "symbol", "") or "").upper() for trade in ledger.trades_by_id.values()}
        symbole |= {str(getattr(event, "symbol", "") or "").upper() for event in ledger.events_by_id.values()}
        sufiksy_bazy: dict[str, set[str]] = {}
        for symbol in symbole:
            dopasowanie = self._SUFIKS_RYNKU.match(symbol)
            if dopasowanie:
                sufiksy_bazy.setdefault(dopasowanie.group("baza"), set()).add(symbol)
        mapowanie = {
            baza: next(iter(pelne))
            for baza, pelne in sufiksy_bazy.items()
            if len(pelne) == 1 and baza in symbole
        }
        if not mapowanie:
            return
        for zbior in (ledger.trades_by_id.values(), ledger.events_by_id.values()):
            for wpis in zbior:
                symbol = str(getattr(wpis, "symbol", "") or "").upper()
                if symbol in mapowanie:
                    wpis.symbol = mapowanie[symbol]
        ledger.issues.append(
            Issue(
                code="SYMBOL_SPELLING_UNIFIED",
                severity="INFO",
                stage="MERGE",
                scope_type="ENGINE",
                scope_id="symbols",
                message=(
                    "Ujednolicono pisownie walorow zapisanych z sufiksem rynku i bez niego: "
                    + ", ".join(f"{baza} -> {pelny}" for baza, pelny in sorted(mapowanie.items()))
                ),
                blocking=False,
            )
        )

    def _resolve_trade_horizon_date(self, trade: CanonicalTrade) -> pd.Timestamp | None:
        try:
            return resolve_trade_tax_event_date(trade, self.config)
        except Exception:
            for candidate in (trade.exchange_time, trade.executed_at, trade.settlement_date):
                if candidate is not None:
                    return candidate.normalize()
        return None

    def _trade_amount_mismatch_issues(self, trades: list[CanonicalTrade]) -> list[Issue]:
        issues: list[Issue] = []
        for trade in trades:
            mismatch = trade.amount_mismatch
            if not mismatch or trade.instrument_class != "EQUITY":
                continue
            if trade.quantity > 0 and trade.price > 0:
                if abs(trade.gross_amount - trade.quantity * trade.price) <= tolerancja_kwoty_transakcji(trade.quantity):
                    continue
            date = self._resolve_trade_horizon_date(trade)
            blocking = trade.side == "SELL" and (self.config.tax_year is None or date is not None and date.year == self.config.tax_year)
            issues.append(Issue(
                code="TRADE_AMOUNT_MISMATCH",
                severity="ERROR" if blocking else "WARNING",
                stage="NORMALIZE",
                scope_type="TRADE",
                scope_id=trade.trade_id,
                message=(
                    f"Transakcja {trade.trade_id} ({trade.side}): kwota z pola {mismatch['source_field']} "
                    f"to {mismatch['reported_amount']} {mismatch['currency']}, a liczba sztuk razy cena "
                    f"to {mismatch['quantity_times_price']} {mismatch['currency']} "
                    f"(prowizja {mismatch['commission']} {mismatch['commission_currency']}). "
                    "Różnica wymaga sprawdzenia w źródle."
                ),
                details=mismatch,
                blocking=blocking,
            ))
        return issues

    def _eskaluj_niezgodnosc_zuzytych_zakupow(self, issues: list[Issue], fifo_rows: list) -> None:
        """Niezgodna kwota zakupu blokuje, gdy jego partia FIFO poszla do sprzedazy w roku rozliczenia.

        Kwota zakupu jest podstawa kosztu w FIFO: zakup 10 x 10 zl z wykazana kwota 120 zl
        i sprzedaz za 200 zl dawaly dochod 80 zl zamiast 100 zl. Niesprzedane partie
        (albo sprzedane w innym roku) zostaja ostrzezeniem. Wywolywane po FIFO;
        id sprzedazy nigdy nie jest buy_trade_id, wiec dotyczy to wylacznie zakupow.
        """
        zuzyte = {
            row.buy_trade_id
            for row in fifo_rows
            if self.config.tax_year is None
            or (row.sell_tax_date is not None and pd.Timestamp(row.sell_tax_date).year == self.config.tax_year)
        }
        for issue in issues:
            if issue.code == "TRADE_AMOUNT_MISMATCH" and not issue.blocking and issue.scope_id in zuzyte:
                issue.severity = "ERROR"
                issue.blocking = True
                issue.message += " Partia tego zakupu została sprzedana w roku rozliczenia, więc błędna kwota zmienia koszt i dochód."

    def _resolve_event_horizon_date(self, event: CanonicalEvent) -> pd.Timestamp | None:
        try:
            return resolve_event_tax_event_date(event, self.config)
        except Exception:
            if event.effective_at is not None:
                return event.effective_at.normalize()
        return None

    def _detect_tax_years(self, merge_result: MergeResult) -> list[int]:
        """Lata podatkowe obecne w danych wejsciowych.

        Wybor roku w interfejsie potrzebuje tej listy zanim powstanie pakiet
        rozliczeniowy - bez niej mozna bylo wybrac wylacznie rok biezacy, wiec
        rozliczenie roku wczesniejszego bylo nieosiagalne z aplikacji.
        Lista powstaje przed zawezeniem do horyzontu wybranego roku.
        """
        years: set[int] = set()
        for trade in merge_result.canonical_dataset.trades:
            horizon = self._resolve_trade_horizon_date(trade)
            if horizon is not None:
                years.add(int(horizon.year))
        for event in merge_result.canonical_dataset.events:
            horizon = self._resolve_event_horizon_date(event)
            if horizon is not None:
                years.add(int(horizon.year))
        return sorted(years)

    def _include_issue_for_tax_year(
        self,
        issue: Issue,
        trade_ids: set[str],
        event_ids: set[str],
        tax_year: int,
    ) -> bool:
        if issue.scope_type == "TRADE":
            return issue.scope_id in trade_ids
        if issue.scope_type == "EVENT":
            return issue.scope_id in event_ids
        if issue.scope_type == "YEAR":
            try:
                return int(issue.scope_id) <= tax_year
            except ValueError:
                return True
        return True

    def _restrict_to_tax_year_horizon(self, merge_result: MergeResult) -> MergeResult:
        tax_year = self.config.tax_year
        if tax_year is None:
            return merge_result

        filtered_trades = [
            trade
            for trade in merge_result.canonical_dataset.trades
            if (self._resolve_trade_horizon_date(trade) is None or self._resolve_trade_horizon_date(trade).year <= tax_year)
        ]
        filtered_events = [
            event
            for event in merge_result.canonical_dataset.events
            if (self._resolve_event_horizon_date(event) is None or self._resolve_event_horizon_date(event).year <= tax_year)
        ]
        filtered_trade_ids = {trade.trade_id for trade in filtered_trades}
        filtered_event_ids = {event.event_id for event in filtered_events}
        filtered_issues = [
            issue
            for issue in merge_result.ledger.issues
            if self._include_issue_for_tax_year(issue, filtered_trade_ids, filtered_event_ids, tax_year)
        ]

        ledger = Ledger(
            issues=list(filtered_issues),
            metadata={**merge_result.ledger.metadata, "tax_year_horizon": tax_year},
        )
        for trade in filtered_trades:
            ledger.trades_by_id[trade.trade_id] = trade
            ledger.index_by_symbol.setdefault(trade.symbol, set()).add(trade.trade_id)
            if trade.order_id:
                ledger.index_by_order_id.setdefault(trade.order_id, set()).add(trade.trade_id)

        for event in filtered_events:
            ledger.events_by_id[event.event_id] = event
            if event.symbol:
                ledger.index_by_symbol.setdefault(event.symbol, set()).add(event.event_id)

        for trade in filtered_trades:
            horizon_date = self._resolve_trade_horizon_date(trade)
            if horizon_date is not None:
                ledger.index_by_date.setdefault(str(horizon_date.date()), set()).add(trade.trade_id)

        for event in filtered_events:
            horizon_date = self._resolve_event_horizon_date(event)
            if horizon_date is not None:
                ledger.index_by_date.setdefault(str(horizon_date.date()), set()).add(event.event_id)

        filtered_dataset = CanonicalDataset(
            trades=tuple(filtered_trades),
            events=tuple(filtered_events),
            issues=tuple(filtered_issues),
            metadata={**merge_result.canonical_dataset.metadata, "tax_year_horizon": tax_year},
        )
        return MergeResult(
            ledger=ledger,
            canonical_dataset=filtered_dataset,
            unmatched_trades=[trade_id for trade_id in merge_result.unmatched_trades if trade_id in filtered_trade_ids],
            unmatched_events=[event_id for event_id in merge_result.unmatched_events if event_id in filtered_event_ids],
            reconciliation_summary={**merge_result.reconciliation_summary, "tax_year_horizon": tax_year},
        )

    def _manual_fx_override_issues(self) -> list[Issue]:
        """Reczna korekta kursu musi byc widoczna w pakiecie dowodowym.

        Kurs ustawowy to kurs NBP z dnia roboczego poprzedzajacego zdarzenie
        (art. 11a ust. 2 ustawy o PIT). Podmiana go wlasna liczba jest odstepstwem
        i nie moze przechodzic bez sladu - wczesniej rozliczenie z podmienionymi
        kursami konczylo sie statusem SUCCESS bez jednej wzmianki.
        """
        overrides = self.config.user_overrides.manual_fx_overrides
        if not overrides or not self.config.nbp_allow_manual_override:
            return []

        issues: list[Issue] = []
        undated = sorted(key for key in overrides if ":" not in str(key))
        if undated:
            issues.append(
                Issue(
                    code="MANUAL_FX_OVERRIDE_WITHOUT_DATE",
                    severity="ERROR",
                    stage="TAX_FX",
                    scope_type="ENGINE",
                    scope_id=",".join(undated),
                    message=(
                            "Ręczna korekta kursu wymaga wskazania dnia, którego dotyczy — wpis "
                            f"{', '.join(undated)} nie został użyty. Poprawny format to WALUTA:RRRR-MM-DD."
                    ),
                    details={"keys": undated},
                    blocking=False,
                    policy_decision="statutory_rate_is_per_event_day",
                )
            )

        dated = sorted(key for key in overrides if ":" in str(key))
        if dated:
            issues.append(
                Issue(
                    code="MANUAL_FX_OVERRIDE_APPLIED",
                    severity="WARNING",
                    stage="TAX_FX",
                    scope_type="ENGINE",
                    scope_id=f"{len(dated)}",
                    message=(
                        f"Rozliczenie uzywa {len(dated)} recznie podanych kursow zamiast kursu NBP: "
                        + ", ".join(f"{key}={overrides[key]}" for key in dated[:10])
                        + ("..." if len(dated) > 10 else "")
                        + ". Kurs ustawowy to kurs NBP z dnia roboczego poprzedzajacego zdarzenie."
                    ),
                    details={"overrides": {key: str(overrides[key]) for key in dated}},
                    blocking=False,
                    policy_decision="manual_rate_is_a_documented_deviation",
                )
            )
        return issues

    def _detect_fx_horizon(self, merge_result: MergeResult) -> tuple[pd.Timestamp | None, pd.Timestamp | None, set[str]]:
        dates: list[pd.Timestamp] = []
        currencies: set[str] = set()

        for trade in merge_result.ledger.trades_by_id.values():
            if trade.side == "UNKNOWN":
                continue
            # Ta sama data co w reszcie silnika. Wlasny lancuch `or` dawal dla
            # transakcji bez tax_event_date inny dzien niz reszta rachunku,
            # wiec zakres sprawdzania kursow NBP mogl ominac dzien transakcji.
            tax_event_date = self._resolve_trade_horizon_date(trade)
            if tax_event_date is not None:
                dates.append(pd.Timestamp(tax_event_date).normalize())
            crypto_swap = czy_wymiana_krypto_na_krypto(trade)
            if trade.trade_currency and not crypto_swap:
                currencies.add(trade.trade_currency.upper())
            commission_amount = trade.commission or Decimal("0")
            # Prowizja w krypto (BNB, nabyta waluta) nie ma kursu NBP i nie jest
            # wyceniana - sprawdzanie jej pokrycia dawalo falszywa luke kursowa.
            if (
                trade.commission_currency
                and not czy_prowizja_w_walucie_wirtualnej(trade)
                and (not crypto_swap or commission_amount != 0)
            ):
                currencies.add(trade.commission_currency.upper())

        for event in merge_result.ledger.events_by_id.values():
            event_date = event.tax_event_date or event.effective_at
            if event_date is not None:
                dates.append(pd.Timestamp(event_date).normalize())
            if event.currency:
                currencies.add(event.currency.upper())

        if not dates:
            return None, None, currencies
        return min(dates), max(dates), currencies

    def apply_fx(self, merge_result: MergeResult, bundle: InputBundle):
        fx_provider = build_fx_provider(self.config, bundle.nbp_csv_paths or [])
        merge_result.ledger.issues.extend(self._manual_fx_override_issues())
        start_date, end_date, currencies = self._detect_fx_horizon(merge_result)
        coverage_gaps = []
        if start_date is not None and end_date is not None and currencies:
            coverage_gaps = fx_provider.coverage_report(start_date, end_date, currencies)
            for gap in coverage_gaps:
                merge_result.ledger.issues.append(
                    Issue(
                        code="NBP_COVERAGE_GAP",
                        severity="CRITICAL",
                        stage="TAX_FX",
                        scope_type="ENGINE",
                        scope_id=f"{gap.currency}:{gap.start_date.date()}:{gap.end_date.date()}",
                        message=f"Brak kursu NBP dla waluty {gap.currency}: {gap.reason}. Uzupełnij kurs w Dokumenty i silnik.",
                        details={
                            "currency": gap.currency,
                            "start_date": str(gap.start_date.date()),
                            "end_date": str(gap.end_date.date()),
                            "provider_name": gap.provider_name,
                            "reason": gap.reason,
                        },
                        blocking=False,
                        source_refs=[{"source": gap.provider_name, "currency": gap.currency}],
                        policy_decision="local_csv_coverage_required_for_filing_ready",
                    )
                )

        merge_result = enrich_merge_result_with_fx(merge_result, fx_provider, self.config)
        return merge_result, coverage_gaps, fx_provider

    def compute_tax(self, merge_result: MergeResult, plan_cost_totals: dict[str, Any]) -> tuple[list, dict[str, Any]]:
        bonus_grants = [
            event
            for event in merge_result.ledger.events_by_id.values()
            if event.event_kind == "BONUS_CONTEST_SHARE"
        ]
        fifo_rows, issues = build_fifo_tax_rows(
            list(merge_result.ledger.trades_by_id.values()),
            self.config,
            bonus_grants=bonus_grants,
        )
        if self.config.run_mode != "STRICT":
            for issue in issues:
                if issue.code in {"BUY_WITHOUT_PLN_COST", "SELL_WITHOUT_PLN_REVENUE"}:
                    issue.blocking = False
        merge_result.ledger.issues.extend(issues)
        merge_result.canonical_dataset = build_dataset_from_ledger(merge_result.ledger)
        annual_payload = build_pit38_views(merge_result, fifo_rows, self.config, plan_cost_totals)
        return fifo_rows, annual_payload

    def _annotate_plan_quality(self, merge_result: MergeResult, cost_items, cost_decisions) -> None:
        selected_plan = self.config.tax_plan.selected_plan
        aggressive_items = [
            item
            for item in cost_items
            if item.is_aggressive_only and any(
                decision.cost_id == item.cost_id and decision.plan_name == selected_plan and decision.included
                for decision in cost_decisions
            )
        ]
        if aggressive_items:
            merge_result.ledger.issues.append(
                Issue(
                    code="AGGRESSIVE_PLAN_HAS_UNCERTAIN_ITEMS",
                    severity="INFO",
                    stage="QUALITY",
                    scope_type="ENGINE",
                    scope_id=selected_plan,
                    message="Wybrany plan uwzględnia koszty dostępne tylko w wariancie agresywnym. Sprawdź ich podstawę w Dokumenty i silnik.",
                    details={"count": len(aggressive_items)},
                    blocking=False,
                )
            )
        weak_items = [item for item in aggressive_items if item.evidence_level == "WEAK"]
        if weak_items:
            merge_result.ledger.issues.append(
                Issue(
                    code="AGGRESSIVE_COST_WITH_WEAK_EVIDENCE",
                    severity="WARNING",
                    stage="QUALITY",
                    scope_type="ENGINE",
                    scope_id=selected_plan,
                    message="Wariant agresywny zawiera koszty słabo powiązane z dokumentami. Sprawdź je w Dokumenty i silnik.",
                    details={"count": len(weak_items)},
                    blocking=False,
                )
            )
        if any(item.kind in {"FX_CONVERSION_SPREAD_COST", "PRIVATE_CASH_FX_INVESTMENT_LOSS"} for item in aggressive_items):
            merge_result.ledger.issues.append(
                Issue(
                    code="AGGRESSIVE_FX_COST_INCLUDED",
                    severity="INFO",
                    stage="QUALITY",
                    scope_type="ENGINE",
                    scope_id=selected_plan,
                    message="Wariant agresywny uwzględnia koszt przewalutowania albo stratę z prywatnej wymiany walut. Sprawdź ten koszt w Dokumenty i silnik.",
                    blocking=False,
                )
            )

    def _annotate_plan_summary(self, annual_payload: dict, cost_decisions, primary_scenario: str, filing_profile: str) -> None:
        selected_plan = self.config.tax_plan.selected_plan
        selected_decisions = [
            decision
            for decision in cost_decisions
            if decision.plan_name == selected_plan and decision.included
        ]
        summary = annual_payload["summary"]
        summary["primary_scenario"] = primary_scenario
        summary["filing_profile"] = filing_profile
        summary["cost_scope"] = {
            "aggressive_user": "szeroki",
            "balanced_user": "umiarkowany",
            "conservative_user": "waski",
        }.get(selected_plan, "szeroki")
        summary["include_fx_conversion_costs"] = (
            "tak"
            if any(
                decision.kind in {
                    "FX_CONVERSION_FEE",
                    "FX_CONVERSION_SPREAD_COST",
                    "PRIVATE_CASH_FX_INVESTMENT_LOSS",
                }
                for decision in selected_decisions
            )
            else "nie"
        )
        summary["include_interest_costs"] = (
            "tak"
            if any(decision.kind in {"NEGATIVE_CASH_INTEREST", "INVESTMENT_INTEREST"} for decision in selected_decisions)
            else "nie"
        )
        summary["include_account_costs"] = (
            "tak"
            if any(decision.kind in {"ACCOUNT_FEE", "CUSTODY_FEE", "TRANSFER_FEE", "OTHER_INVESTMENT_COST"} for decision in selected_decisions)
            else "nie"
        )
        summary["include_bank_funding_fee"] = (
            "tak"
            if any(decision.kind == "BANK_FUNDING_FEE" for decision in selected_decisions)
            else "nie"
        )
        summary["funding_fee_allocation_mode"] = self.config.tax_plan.funding_fee_allocation_mode
        summary["aggressive_only_items"] = str(sum(1 for decision in selected_decisions if decision.aggressive_only))

    def _refresh_annual_payload_hash(self, annual_payload: dict) -> None:
        # Ta sama funkcja, co przy pierwszym wyliczeniu w pit38_engine - druga
        # kopia listy kluczy zdazyla juz zgubic rejestr strat z lat ubieglych.
        annual_payload["audit_hash"] = compute_audit_hash(annual_payload)

    def build_reports(self, result: EngineRunResult, output_dir: Path) -> tuple[list[Path], list[dict[str, Any]]]:
        paths: list[Path] = []
        export_stages: list[dict[str, Any]] = []
        export_mode = os.environ.get("INVEST_TAX_EXPORT_MODE", "full").strip().lower()
        if export_mode not in {"full", "minimal"}:
            export_mode = "full"

        if export_mode == "minimal":
            export_stages.append(
                {
                    "stage": "exports.workbook",
                    "duration_ms": 0.0,
                    "skipped": True,
                    "mode": export_mode,
                }
            )
        else:
            stage_started_at = perf_counter()
            paths.extend(export_workbook(result, output_dir))
            export_stages.append(
                {
                    "stage": "exports.workbook",
                    "duration_ms": round((perf_counter() - stage_started_at) * 1000, 3),
                    "mode": export_mode,
                }
            )

        stage_started_at = perf_counter()
        paths.extend(export_audit_json(result, output_dir, additional_artifacts=paths))
        export_stages.append(
            {
                "stage": "exports.audit_json",
                "duration_ms": round((perf_counter() - stage_started_at) * 1000, 3),
                "mode": export_mode,
            }
        )
        return paths, export_stages

    def resolve_quality(self, issues: list[Issue]):
        return build_quality_report(issues)

    @staticmethod
    def _canonical_input_integrity_issues(metadata: dict[str, Any]) -> list[Issue]:
        issues: list[Issue] = []
        summary = metadata.get("canonical_tax_input_summary") or {}
        incomplete = int(summary.get("incompleteRecordCount") or 0)
        if incomplete:
            breakdown = summary.get("incompleteRecordsBySource") or []
            details = "; ".join(
                f"{entry.get('filename')}: {entry.get('count')} "
                f"({', '.join(f'{reason}={count}' for reason, count in sorted((entry.get('reasons') or {}).items()))})"
                for entry in breakdown
            )
            issues.append(Issue(
                code="INCOMPLETE_RECORDS_SKIPPED", severity="INFO", stage="VALIDATE",
                scope_type="ENGINE", scope_id="canonical_tax_input",
                message=f"{incomplete} niekompletnych wierszy nie weszło do rozliczenia. Plik → liczba → przyczyny: {details}. Otwórz wskazane pozycje w Historii transakcji i uzupełnij dane.",
                blocking=False,
            ))
        blocking_incomplete = int(summary.get("blockingIncompleteRecordCount") or 0)
        unknown_records: list[dict[str, Any]] = []
        seen_unknown_records: set[tuple[str, str, str]] = set()
        for record in [
            *(summary.get("unrecognizedOperationRecords") or []),
            *(metadata.get("unrecognized_operation_records") or []),
        ]:
            if not isinstance(record, dict):
                continue
            normalized_record = {
                "source": str(record.get("source") or "unknown"),
                "record_id": str(record.get("record_id") or record.get("event_id") or "unknown"),
                "operation_code": str(record.get("operation_code") or ""),
                "ticker": str(record.get("ticker") or ""),
                "quantity": str(record.get("quantity") or ""),
            }
            key = (
                normalized_record["source"],
                normalized_record["record_id"],
                normalized_record["operation_code"],
            )
            if key not in seen_unknown_records:
                seen_unknown_records.add(key)
                unknown_records.append(normalized_record)
        if blocking_incomplete or unknown_records:
            total = max(blocking_incomplete, len(unknown_records)) if unknown_records else blocking_incomplete
            message = (
                f"{total} transakcji z instrumentem i ilością nie weszło do rozliczenia z powodu braku daty, ceny/kwoty, waluty lub nierozpoznanej strony kupna/sprzedaży."
            )
            if unknown_records:
                refs = [
                    f"{row['source']}:{row['record_id']} [{row['operation_code'] or 'brak kodu'}]"
                    for row in unknown_records[:25]
                ]
                extra = f" (+{len(unknown_records) - 25} dalszych)" if len(unknown_records) > 25 else ""
                has_split = any(operation_review_kind(row["operation_code"]) == "split" for row in unknown_records)
                has_reverse_split = any(operation_review_kind(row["operation_code"]) == "reverse_split" for row in unknown_records)
                message += " Rekordy do rozstrzygnięcia: " + ", ".join(refs) + extra + "."
                if has_split or has_reverse_split:
                    message += " Split/odwrotny split: popraw ilości ręcznie."
                message += " Popraw kod operacji albo potwierdź ręczne ujęcie/dodaj zdarzenie w Historii."
            issues.append(Issue(
                code="INCOMPLETE_TRANSACTION_SKIPPED", severity="ERROR", stage="VALIDATE",
                scope_type="ENGINE", scope_id="canonical_tax_input",
                message=message,
                details={
                    "blocking_incomplete_record_count": blocking_incomplete,
                    "unrecognized_operation_records": unknown_records,
                },
                blocking=True,
                policy_decision="resolve_operation_or_confirm_manual_history_entry",
            ))
        for failed_source in metadata.get("sources_unreadable") or []:
            issues.append(Issue(
                code="SOURCE_INPUT_READ_FAILED", severity="ERROR", stage="VALIDATE",
                scope_type="SOURCE", scope_id=str(failed_source.get("filename") or "unknown"),
                message=f"Nie udało się odczytać pliku {failed_source.get('filename')}: {failed_source.get('error')}. Sprawdź plik w Dokumenty i silnik.",
                blocking=True,
            ))
        return issues

    @staticmethod
    def _zwolnij_akcje_przyznane_spoza_roku(
        consumption_report: dict[str, Any] | None,
        merge_result: MergeResult,
        tax_year: int | None,
    ) -> None:
        """Akcje przyznane spoza roku rozliczenia blokuja tylko przez FIFO.

        Przyznanie zmienia PIT-38 za dany rok wylacznie kosztem partii zuzytej
        przez sprzedaz w tym roku. Akcje przyznane i sprzedane w latach
        wczesniejszych (albo przyznane po roku rozliczenia) nie moga zmienic
        jego kwot, a blokowaly gotowosc kazdego roku. Zostaja ostrzezeniem.
        Rejestr zawiera juz transakcje reczne, wiec reczna sprzedaz tez sie liczy.
        """
        if not isinstance(consumption_report, dict) or tax_year is None:
            return
        kolejka = consumption_report.get("reviewQueue")
        if not isinstance(kolejka, list):
            return
        sprzedane_w_roku, isiny_w_roku = InvestmentTaxEngine._waloru_sprzedane_w_roku(merge_result, tax_year)
        zwolnione = 0
        for pozycja in kolejka:
            if not isinstance(pozycja, dict) or pozycja.get("kind") != "stock_award" or not pozycja.get("blocks_filing"):
                continue
            data = str(pozycja.get("date") or "")
            walor = symbol_bez_rynku(pozycja.get("symbol"))
            # Bez daty albo symbolu nie wiadomo, ktorego roku dotyczy - blokuje dalej.
            if not data[:4].isdigit() or not walor:
                continue
            rok = int(data[:4])
            isin = str(pozycja.get("isin") or "").strip().upper()
            sprzedany = walor in sprzedane_w_roku or (isin and isin in isiny_w_roku)
            if rok > tax_year or (rok < tax_year and not sprzedany):
                pozycja["blocks_filing"] = False
                zwolnione += 1
        if not zwolnione:
            return
        InvestmentTaxEngine._przelicz_liczniki_kolejki_decyzji(consumption_report, kolejka)

    @staticmethod
    def _waloru_sprzedane_w_roku(merge_result: MergeResult, tax_year: int) -> tuple[set[str], set[str]]:
        """Symbole (bez sufiksu rynku) i ISIN-y sprzedane w roku rozliczenia wg rejestru z transakcjami recznymi."""
        sprzedaze_w_roku = [
            trade
            for trade in merge_result.ledger.trades_by_id.values()
            if (trade.side or "").upper() == "SELL"
            and trade.tax_event_date is not None
            and pd.Timestamp(trade.tax_event_date).year == tax_year
        ]
        symbole = {symbol_bez_rynku(trade.symbol) for trade in sprzedaze_w_roku}
        # Zmiana tickera zwykle zostawia ISIN - walor sprzedany pod nowym symbolem
        # tez moze zuzyc w FIFO partie z przyznania.
        isiny = {
            str(trade.isin or "").strip().upper() for trade in sprzedaze_w_roku if str(trade.isin or "").strip()
        }
        return symbole, isiny

    @staticmethod
    def _przelicz_liczniki_kolejki_decyzji(consumption_report: dict[str, Any], kolejka: list[Any]) -> None:
        blokujace: dict[str, int] = {}
        ostrzegawcze: dict[str, int] = {}
        for pozycja in kolejka:
            if not isinstance(pozycja, dict):
                continue
            if pozycja.get("decision") and not pozycja.get("decision_insufficient"):
                continue
            cel = blokujace if pozycja.get("blocks_filing") else ostrzegawcze
            rodzaj = str(pozycja.get("kind") or "")
            cel[rodzaj] = cel.get(rodzaj, 0) + int(pozycja.get("occurrences") or 1)
        consumption_report["recordsAwaitingUserDecisionBlockingByKind"] = dict(sorted(blokujace.items()))
        consumption_report["recordsAwaitingUserDecisionWarningByKind"] = dict(sorted(ostrzegawcze.items()))

    @staticmethod
    def _zablokuj_zmiany_liczby_akcji_przy_sprzedazy_recznej(
        consumption_report: dict[str, Any] | None,
        merge_result: MergeResult,
        tax_year: int | None,
    ) -> None:
        """Zdarzenie korporacyjne sprzed roku blokuje tez, gdy walor sprzedano tylko recznie.

        Adapter ocenia sprzedaze z pliku wejsciowego, a rejestr zawiera jeszcze
        transakcje reczne. Nierozstrzygniete zdarzenie korporacyjne (podzial,
        bonus, spin-off...) zmienia koszt kazdej sprzedazy tego waloru w roku
        rozliczenia, wiec sprzedaz z Historii tez zaostrza je do blokady. Tak samo
        decyzja "nie wplywa na PIT" przy zmianie liczby akcji sprzedanego waloru
        przestaje wystarczac - zwalnia tylko "ujalem recznie w historii".
        """
        if not isinstance(consumption_report, dict) or tax_year is None:
            return
        kolejka = consumption_report.get("reviewQueue")
        if not isinstance(kolejka, list):
            return
        sprzedane_w_roku, isiny_w_roku = InvestmentTaxEngine._waloru_sprzedane_w_roku(merge_result, tax_year)
        zaostrzone = 0
        for pozycja in kolejka:
            if not isinstance(pozycja, dict) or pozycja.get("kind") != "corporate_action":
                continue
            data = str(pozycja.get("date") or "")
            rok = int(data[:4]) if data[:4].isdigit() else None
            walor = symbol_bez_rynku(pozycja.get("symbol"))
            isin = str(pozycja.get("isin") or "").strip().upper()
            sprzedany = bool((walor and walor in sprzedane_w_roku) or (isin and isin in isiny_w_roku))
            decyzja = pozycja.get("decision")
            if decyzja:
                if (
                    pozycja.get("changes_share_count")
                    and decyzja != "handled_manually"
                    and not pozycja.get("decision_insufficient")
                    and (rok is None or rok <= tax_year)
                    and (sprzedany or not (walor or isin))
                ):
                    pozycja["decision_insufficient"] = True
                    pozycja["blocks_filing"] = True
                    pozycja["blocking_note"] = BLOCKING_NOTE_SHARE_COUNT
                    zaostrzone += 1
                continue
            if pozycja.get("blocks_filing") or not pozycja.get("blocks_when_sold"):
                continue
            if sprzedany:
                pozycja["blocks_filing"] = True
                zaostrzone += 1
        if zaostrzone:
            InvestmentTaxEngine._przelicz_liczniki_kolejki_decyzji(consumption_report, kolejka)

    @staticmethod
    def _canonical_source_conflict_issues(consumption_report: dict[str, Any] | None) -> list[Issue]:
        if not isinstance(consumption_report, dict):
            return []
        issues: list[Issue] = []
        for conflict in consumption_report.get("sourceQuantityConflicts", []):
            if conflict.get("code") == "OVERLAPPING_SOURCE_ACCOUNT_AMBIGUOUS":
                issues.append(
                    Issue(
                        code="OVERLAPPING_SOURCE_ACCOUNT_AMBIGUOUS",
                        severity="ERROR",
                        stage="CANONICAL_INPUT",
                        scope_type="ENGINE",
                        scope_id=f"{conflict['symbol']}:{conflict['day']}:{conflict['side']}",
                        message=(
                            f"Pliki {conflict['kept_file']} i {conflict['dropped_file']} opisują tę samą transakcję "
                            f"{conflict['symbol']} {conflict['day']} {conflict['side']} na rachunkach "
                            f"{' i '.join(str(konto) for konto in conflict.get('accounts', []))}, ale żaden plik nie zawiera "
                            "obu rachunków naraz, więc silnik nie wie, czy to dwa rachunki, czy jeden zapisany w dwóch formatach. "
                            "Oba zapisy zostały zachowane i mogą podwoić przychód. Otwórz Dokumenty i silnik i wyłącz z rozliczenia "
                            "plik, który powtarza transakcje drugiego (wykluczenie pliku), albo ujednolij zapis rachunku w pliku, "
                            "po czym przelicz rozliczenie."
                        ),
                        details=conflict,
                        blocking=True,
                    )
                )
                continue
            if conflict.get("code") != "OVERLAPPING_SOURCE_QUANTITY_CONFLICT":
                continue
            issues.append(
                Issue(
                    code="OVERLAPPING_SOURCE_QUANTITY_CONFLICT",
                    severity="ERROR",
                    stage="CANONICAL_INPUT",
                    scope_type="ENGINE",
                    scope_id=f"{conflict['symbol']}:{conflict['day']}:{conflict['side']}",
                    message=(
                        f"Rozna ilosc {conflict['symbol']} "
                        f"{conflict['day']}"
                        f"{'' if conflict.get('day_to', conflict['day']) == conflict['day'] else ' - ' + conflict['day_to']}"
                        f" {conflict['side']}: "
                        f"{conflict['kept_file']} ({conflict['kept_quantity']}) i "
                        f"{conflict['dropped_file']} ({conflict['dropped_quantity']})."
                    ),
                    details=conflict,
                    blocking=True,
                )
            )
        return issues

    def _pit_zg_country_issues(self, result: EngineRunResult) -> list[Issue]:
        """Sprzedaz bez ustalonego panstwa zrodla dochodu."""
        selected_year = self.config.tax_year
        rows = [
            row
            for row in (result.fifo_rows or [])
            if selected_year is None or getattr(row.sell_tax_date, "year", None) == selected_year
        ]
        if not rows:
            return []
        trades_by_id = result.merge_result.ledger.trades_by_id
        nierozpoznane = [
            entry
            for entry in build_pit_zg_rows(rows, trades_by_id)
            if entry["country"] == UNKNOWN_COUNTRY
            and (entry["income_pln"] != 0 or entry["foreign_tax_pln"] != 0)
        ]
        symbole = symbole_bez_kraju(rows, trades_by_id) if nierozpoznane else []
        return [
            Issue(
                code="PIT_ZG_COUNTRY_UNKNOWN",
                severity="ERROR",
                stage="TAX",
                scope_type="ENGINE",
                scope_id="PIT/ZG",
                message=(
                    f"{entry['row_count']} sprzedaży o dochodzie {entry['income_pln']} zł nie ma "
                    "ustalonego państwa źródła (brak ISIN). Załącznik PIT/ZG składa się odrębnie "
                    "dla każdego państwa, więc te pozycje trzeba przypisać ręcznie"
                    + (f": {', '.join(symbole)}." if symbole else ".")
                    + " W raporcie rocznym otwórz „Sprawdź kontrolę PIT” i uzupełnij pole „Kraj” przy symbolu (dwuliterowy kod, np. CY), albo wpisz ISIN w Historii transakcji. Po przeliczeniu blokada zniknie."
                ),
                details={"symbols": symbole},
                blocking=True,
            )
            for entry in nierozpoznane
        ]

    def _split_issues(self, issues: list[Issue], quality_report) -> tuple[list[Issue], list[Issue]]:
        actionable_keys = {
            (issue.code, issue.scope_id, issue.message)
            for issue in [*quality_report.blocking_issues, *quality_report.warning_issues]
        }
        actionable: list[Issue] = []
        informational: list[Issue] = []
        for issue in issues:
            key = (issue.code, issue.scope_id, issue.message)
            if key in actionable_keys or issue.severity in {"WARNING", "ERROR", "CRITICAL"} or issue.blocking:
                actionable.append(issue)
            else:
                informational.append(issue)
        return actionable, informational

    def run(self, bundle: InputBundle) -> EngineRunResult:
        original_config = self.config
        self.config = replace(self.config, user_overrides=self._merge_user_overrides_from_bundle(bundle))
        try:
            return self._run_with_current_config(bundle)
        finally:
            self.config = original_config

    def _run_with_current_config(self, bundle: InputBundle) -> EngineRunResult:
        run_started_at = perf_counter()
        performance_stages: list[dict[str, Any]] = []

        def record_stage(stage: str, started_at: float) -> None:
            performance_stages.append(
                {
                    "stage": stage,
                    "duration_ms": round((perf_counter() - started_at) * 1000, 3),
                }
            )

        stage_started_at = perf_counter()
        validation = self.validate_input_bundle(bundle)
        record_stage("validate", stage_started_at)

        stage_started_at = perf_counter()
        parsed = self.parse_sources(bundle)
        record_stage("parse", stage_started_at)

        stage_started_at = perf_counter()
        normalized = self.normalize(parsed, validation)
        normalized = self._attach_bundle_metadata(normalized, bundle)
        record_stage("normalize", stage_started_at)

        stage_started_at = perf_counter()
        merge_result = self.merge(normalized)
        record_stage("merge", stage_started_at)

        merge_result.ledger.issues.extend(
            self._canonical_input_integrity_issues(merge_result.ledger.metadata)
        )

        stage_started_at = perf_counter()
        merge_result, depo_reconciliation = self.reconcile(merge_result, bundle)
        record_stage("reconcile", stage_started_at)

        stage_started_at = perf_counter()
        merge_result, editable_records = apply_manual_overrides(
            merge_result,
            self.config.user_overrides.transaction_overrides,
            self.config,
        )
        merge_result.ledger.metadata["tax_years_detected"] = self._detect_tax_years(merge_result)
        merge_result = self._restrict_to_tax_year_horizon(merge_result)
        merge_result.ledger.issues.extend(
            self._trade_amount_mismatch_issues(list(merge_result.ledger.trades_by_id.values()))
        )
        record_stage("manual_overrides_and_horizon", stage_started_at)

        # Waluty wirtualne rozliczaja sie w czesci E PIT-38 wedlug innych regul
        # niz papiery: wydatek na nabycie jest kosztem w roku poniesienia,
        # niezaleznie od sprzedazy, i nie stosuje sie do nich kolejki FIFO
        # (art. 22 ust. 14-15 ustawy o PIT). Silnik tego nie liczy, ale musi
        # o tym powiedziec glosno: wczesniej symbol z gieldy krypto wpadal do
        # klasy EQUITY i byl rozliczany jak akcje, czyli w zlej sekcji
        # deklaracji. Teraz jest wydzielony i zgloszony.
        transakcje_krypto = [
            trade
            for trade in merge_result.ledger.trades_by_id.values()
            if trade.logical_world == "crypto_tax"
        ]
        if transakcje_krypto:
            symbole = sorted({trade.symbol for trade in transakcje_krypto})
            merge_result.ledger.issues.append(
                Issue(
                    code="CRYPTO_SEPARATE_PART_E",
                    severity="INFO",
                    stage="VALIDATE",
                    scope_type="ENGINE",
                    scope_id="crypto_tax",
                    message=(
                        f"Wykryto {len(transakcje_krypto)} transakcji na walutach wirtualnych "
                        f"({', '.join(symbole[:5])}). Są wyłączone z części C i rozliczone "
                        "w części E (koszt w roku poniesienia, bez FIFO). Sprawdź dane w Historii transakcji."
                    ),
                    blocking=False,
                )
            )

        stage_started_at = perf_counter()
        merge_result, coverage_gaps, fx_provider = self.apply_fx(merge_result, bundle)
        record_stage("nbp_fx", stage_started_at)

        stage_started_at = perf_counter()
        cost_items, funding_fee_allocations, cost_issues = extract_cost_items(merge_result, self.config, fx_provider)
        merge_result.ledger.issues.extend(cost_issues)
        cost_decisions, plan_cost_totals = apply_tax_plan(cost_items, self.config)
        self._annotate_plan_quality(merge_result, cost_items, cost_decisions)
        record_stage("cost_policy", stage_started_at)

        stage_started_at = perf_counter()
        fifo_rows, annual_payload = self.compute_tax(merge_result, plan_cost_totals)
        self._eskaluj_niezgodnosc_zuzytych_zakupow(merge_result.ledger.issues, fifo_rows)
        record_stage("fifo_and_tax", stage_started_at)

        # Czesc E formularza: waluty wirtualne. Liczona osobno od czesci C, bo
        # rzadzi sie innymi regulami - patrz tax/crypto_engine.py. Musi powstac
        # PRZED ocena jakosci: gdy operacji krypto nie da sie wycenic, zglasza
        # niespojnosc blokujaca, a ta liczona po bramkach nie zatrzymalaby
        # niczego - wynik wychodzil jako gotowy do zlozenia.
        crypto_wynik, crypto_issues = oblicz_czesc_e(
            merge_result,
            tax_year=self.config.tax_year,
            costs_carried_in_pln=self.config.user_overrides.crypto_costs_carried_forward_pln,
        )
        merge_result.ledger.issues.extend(crypto_issues)

        stage_started_at = perf_counter()
        quality_report = self.resolve_quality(merge_result.ledger.issues)
        actionable_issues, informational_issues = self._split_issues(merge_result.ledger.issues, quality_report)
        selected_plan = self.config.tax_plan.selected_plan
        primary_scenario = PLAN_TO_SCENARIO.get(selected_plan, "aggressive_user")
        filing_profile = "AGGRESSIVE" if selected_plan == "aggressive_user" else "STANDARD"
        self._annotate_plan_summary(annual_payload, cost_decisions, primary_scenario, filing_profile)
        self._refresh_annual_payload_hash(annual_payload)
        record_stage("summary_and_hash", stage_started_at)

        stage_started_at = perf_counter()
        transaction_history_rows = build_transaction_history_rows(
            trades=list(merge_result.ledger.trades_by_id.values()),
            events=list(merge_result.ledger.events_by_id.values()),
            funding_fee_allocations=funding_fee_allocations,
            fifo_rows=fifo_rows,
            tax_year=self.config.tax_year,
        )
        record_stage("history_projection", stage_started_at)

        stage_started_at = perf_counter()
        events_for_financing = list(merge_result.ledger.events_by_id.values())
        financing_episodes, financing_issues = build_financing_ledger(events_for_financing)
        # Horyzont danych to najpozniejsze zdarzenie w zbiorze. Epizod siegajacy
        # tej granicy moze trwac nadal - brak kolejnych naliczen nie dowodzi splaty.
        event_dates = [
            event.tax_event_date or event.effective_at
            for event in events_for_financing
            if (event.tax_event_date or event.effective_at) is not None
        ]
        data_horizon = max(event_dates) if event_dates else None
        financing_issues.extend(mark_open_episodes(financing_episodes, data_horizon=data_horizon))
        # Taryfa jest kontrola spojnosci: rozjazd ze stawka uzyta w naliczeniach
        # zglaszamy jako ostrzezenie, bo to cennik moze byc nieaktualny.
        if bundle.tariff_pdf_path is not None and bundle.tariff_pdf_path.exists():
            tariff_rates = extract_daily_margin_rates(bundle.tariff_pdf_path)
            if tariff_rates:
                financing_issues.extend(check_rates_against_tariff(financing_episodes, tariff_rates))
            elif financing_episodes:
                financing_issues.append(
                    Issue(
                        code="TARIFF_RATES_NOT_READ",
                        severity="WARNING",
                        stage="FINANCING_LEDGER",
                        scope_type="ENGINE",
                        scope_id=bundle.tariff_pdf_path.name,
                        message=(
                            f"Nie udało się odczytać dziennej stawki z taryfy {bundle.tariff_pdf_path.name}, "
                            "więc nie można porównać z nią naliczeń za ujemne saldo."
                        ),
                        details={"tariff_file": bundle.tariff_pdf_path.name},
                        blocking=False,
                        policy_decision="tariff_check_is_advisory",
                    )
                )
        merge_result.ledger.issues.extend(financing_issues)
        financing_ledger = summarize_financing_ledger(financing_episodes, tax_year=self.config.tax_year)
        record_stage("financing_ledger", stage_started_at)

        result = EngineRunResult(
            status=quality_report.final_status,
            filing_ready=quality_report.filing_ready,
            config=self.config,
            canonical_dataset=merge_result.canonical_dataset,
            merge_result=merge_result,
            filing_profile=filing_profile,
            plan_used=selected_plan,
            fifo_rows=fifo_rows,
            crypto_part_e=crypto_wynik.to_dict(),
            dividends_view=annual_payload["dividends_view"],
            foreign_tax_view=annual_payload["foreign_tax_view"],
            private_cash_fx_view=annual_payload["private_cash_fx_view"],
            financing_comparison=annual_payload["financing_comparison"],
            scenario_results=annual_payload["scenario_results"],
            cost_items=cost_items,
            cost_decisions=cost_decisions,
            funding_fee_allocations=funding_fee_allocations,
            primary_scenario=primary_scenario,
            annual_summary=annual_payload["summary"],
            quality_report=quality_report,
            fx_coverage_gaps=coverage_gaps,
            depo_reconciliation=depo_reconciliation,
            financing_ledger=financing_ledger,
            actionable_issues=actionable_issues,
            informational_issues=informational_issues,
            transaction_history_rows=transaction_history_rows,
            editable_records=editable_records,
            audit_hash=annual_payload["audit_hash"],
        )
        populate_form_summary(result)
        self._refresh_annual_payload_hash(annual_payload)
        result.audit_hash = annual_payload["audit_hash"]
        consumption_report = (
            bundle.metadata.get("canonical_tax_input_consumption_runtime")
            if isinstance(bundle.metadata, dict)
            else None
        )
        self._zwolnij_akcje_przyznane_spoza_roku(consumption_report, merge_result, self.config.tax_year)
        self._zablokuj_zmiany_liczby_akcji_przy_sprzedazy_recznej(
            consumption_report, merge_result, self.config.tax_year
        )
        held_for_review = (
            consumption_report.get("recordsHeldForReviewByKind")
            if isinstance(consumption_report, dict)
            else None
        )
        held_for_review_blocking = (
            consumption_report.get("recordsAwaitingUserDecisionBlockingByKind")
            if isinstance(consumption_report, dict)
            else None
        )
        held_for_review_warning = (
            consumption_report.get("recordsAwaitingUserDecisionWarningByKind")
            if isinstance(consumption_report, dict)
            else None
        )
        post_result_issues: list[Issue] = []
        post_result_issues.extend(self._canonical_source_conflict_issues(consumption_report))
        if isinstance(held_for_review, dict) and held_for_review:
            # Zdarzenia korporacyjne i akcje przyznane wymagaja rozstrzygniecia,
            # jak wplywaja na koszt nabycia. Silnik ich nie zgaduje, ale do tej
            # pory znikaly bez sladu - uzytkownik nie mial skad wiedziec, ze
            # czekaja na jego decyzje.
            total_held = sum(int(count) for count in held_for_review.values())
            blocking_by_kind = (
                {str(kind): int(count) for kind, count in held_for_review_blocking.items()}
                if isinstance(held_for_review_blocking, dict)
                else {}
            )
            warning_by_kind = (
                {str(kind): int(count) for kind, count in held_for_review_warning.items()}
                if isinstance(held_for_review_warning, dict)
                else dict(held_for_review)
            )
            blocking_total = sum(blocking_by_kind.values())
            # Po decyzjach uzytkownika licza sie tylko zdarzenia nadal otwarte.
            pending_by_kind: dict[str, int] = {}
            if isinstance(held_for_review_warning, dict):
                for kinds in (blocking_by_kind, warning_by_kind):
                    for kind, count in kinds.items():
                        pending_by_kind[kind] = pending_by_kind.get(kind, 0) + count
            else:
                pending_by_kind = {str(kind): int(count) for kind, count in held_for_review.items()}
            total_held = sum(pending_by_kind.values())
        else:
            total_held = 0
        zmiany_liczby_akcji = [
            pozycja
            for pozycja in (consumption_report.get("reviewQueue") if isinstance(consumption_report, dict) else None) or []
            if isinstance(pozycja, dict)
            and pozycja.get("kind") == "corporate_action"
            and pozycja.get("blocks_filing")
            and (not pozycja.get("decision") or pozycja.get("decision_insufficient"))
        ]
        if total_held > 0:
            post_result_issues.append(
                Issue(
                    code="RECORDS_AWAITING_USER_DECISION",
                    severity="CRITICAL" if blocking_total else "WARNING",
                    stage="CANONICAL_INPUT",
                    scope_type="ENGINE",
                    scope_id="canonical_tax_input.json",
                    message=(
                        f"{total_held} zapisów czeka na Twoją decyzję i nie weszło do rozliczenia: "
                        + ", ".join(f"{kind} {count}" for kind, count in sorted(pending_by_kind.items()))
                        + (". Co najmniej " + str(blocking_total) + " moze zmienic PIT za wybrany rok; rozstrzygnij je w raporcie rocznym (lista: Co wymaga decyzji)."
                           if blocking_total else ". To ostrzezenie nie zmienia gotowosci PIT dla wybranego roku.")
                        + (
                            " Zdarzenia korporacyjne (podział, scalenie, akcje bonusowe, spin-off, fuzja) bez wystarczającej decyzji: "
                            + ", ".join(
                                f"{pozycja.get('symbol') or 'walor nieznany'} ({pozycja.get('date') or 'bez daty'})"
                                for pozycja in zmiany_liczby_akcji
                            )
                            + ". Do czasu decyzji koszt nabycia partii FIFO tego waloru liczy się ze starej liczby akcji "
                            "- rozstrzygnij w przeglądzie (Co wymaga decyzji)."
                            + (
                                " " + BLOCKING_NOTE_SHARE_COUNT
                                if any(pozycja.get("decision_insufficient") for pozycja in zmiany_liczby_akcji)
                                else ""
                            )
                            if zmiany_liczby_akcji
                            else ""
                        )
                    ),
                    details={
                        "held_for_review_by_kind": dict(held_for_review),
                        "blocking_by_kind": blocking_by_kind,
                        "warning_by_kind": warning_by_kind,
                        "blocking_count": blocking_total,
                        "corporate_actions_awaiting_decision": [
                            {"symbol": pozycja.get("symbol"), "date": pozycja.get("date")}
                            for pozycja in zmiany_liczby_akcji
                        ],
                        "resolution_target": "review_queue",
                        "decisions_applied": (
                            consumption_report.get("reviewDecisionsApplied")
                            if isinstance(consumption_report, dict)
                            else 0
                        ),
                    },
                    blocking=blocking_total > 0,
                    policy_decision="user_decision_required_for_tax_relevant_corporate_actions",
                )
            )

        # Strata wyliczona z danych nie obniza podatku sama z siebie, ale
        # uzytkownik musi o niej wiedziec - inaczej po cichu traci odliczenie,
        # ktore mu przysluguje.
        for entry in annual_payload.get("prior_year_loss_ledger", []) or []:
            if entry.get("status") != "AUTO_NEEDS_CONFIRMATION":
                continue
            post_result_issues.append(
                Issue(
                    code="PRIOR_YEAR_LOSS_NEEDS_CONFIRMATION",
                    severity="WARNING",
                    stage="PIT38",
                    scope_type="ENGINE",
                    scope_id=str(entry.get("tax_year")),
                    message=(
                        f"Dane wskazują stratę {entry.get('loss_pln')} zł za {entry.get('tax_year')}. "
                        "Nie obniża ona podatku automatycznie, bo silnik nie wie, czy została wykazana "
                        "w PIT-38 za tamten rok ani ile z niej już odliczono. Jeśli tak było, wpisz ją "
                        "w ustawieniach strat z lat ubieglych."
                    ),
                    details={
                        "tax_year": entry.get("tax_year"),
                        "loss_pln": entry.get("loss_pln"),
                        "source": entry.get("source"),
                    },
                    blocking=False,
                    policy_decision="engine_does_not_know_what_was_filed",
                )
            )

        post_result_issues.extend(build_category_coverage_issues(result, consumption_report))
        # PIT/ZG sklada sie odrebnie dla kazdego panstwa uzyskania dochodu, wiec
        # sprzedaz, ktorej panstwa nie da sie ustalic, blokuje wypelnienie
        # zalacznika. Silnik tego nie zgadnie - ISIN bywa pusty przy produktach
        # strukturyzowanych - ale musi o tym powiedziec.
        post_result_issues.extend(self._pit_zg_country_issues(result))
        result.category_coverage = coverage_summary(result, consumption_report)
        # Kazda niespojnosc dopisana po zlozeniu wyniku musi przejsc przez bramki
        # jeszcze raz - inaczej widac ja tylko wtedy, gdy zamowiono pakiet
        # rozliczeniowy, bo dopiero on wymusza ponowna ocene jakosci.
        if post_result_issues:
            result.merge_result.ledger.issues.extend(post_result_issues)
            result.quality_report = self.resolve_quality(result.merge_result.ledger.issues)
            result.filing_ready = result.quality_report.filing_ready
            result.status = result.quality_report.final_status
            result.actionable_issues, result.informational_issues = self._split_issues(
                result.merge_result.ledger.issues,
                result.quality_report,
            )

        if self.config.tax_filing_request is not None:
            stage_started_at = perf_counter()
            result.tax_filing_package = generate_tax_filing_package(result, self.config.tax_filing_request)
            result.quality_report = self.resolve_quality(result.merge_result.ledger.issues)
            result.filing_ready = result.quality_report.filing_ready
            result.status = result.quality_report.final_status
            result.actionable_issues, result.informational_issues = self._split_issues(
                result.merge_result.ledger.issues,
                result.quality_report,
            )
            record_stage("filing_package", stage_started_at)

        result.performance_profile = {
            "total_ms": round((perf_counter() - run_started_at) * 1000, 3),
            "tax_year": self.config.tax_year,
            "stages": list(performance_stages),
        }

        stage_started_at = perf_counter()
        result.exported_files, export_stages = self.build_reports(result, bundle.output_dir)
        performance_stages.extend(export_stages)
        record_stage("exports", stage_started_at)
        result.performance_profile = {
            "total_ms": round((perf_counter() - run_started_at) * 1000, 3),
            "tax_year": self.config.tax_year,
            "stages": performance_stages,
        }
        return result
