from __future__ import annotations

import json
from dataclasses import asdict
from pathlib import Path

import pandas as pd

from ..models.core import EngineRunResult
from .audit_json import redact_payload
from .fifo_view import fifo_rows_as_dicts, split_by_filing_year
from .komorki import neutralizuj_formule


# Twardy limit pojedynczej komorki w formacie XLSX.
EXCEL_MAX_CELL_LENGTH = 32767
_TRUNCATION_NOTE = " […ucieto, pelna tresc w eksporcie JSON]"


def _fit_cell(value: object) -> object:
    """Przycina zbyt dluga tresc, zostawiajac widoczny slad przyciecia.

    Bez tego openpyxl obcina komorke po cichu i pakiet dowodowy traci koncowke
    tresci, nie sygnalizujac tego czytelnikowi. Struktury zagniezdzone pandas
    zamienia na napis dopiero przy zapisie, wiec trzeba je zmierzyc tutaj.
    """
    if isinstance(value, (list, dict, tuple, set)):
        value = _json_cell(_join_cell(value) if isinstance(value, (list, set, tuple)) else value)
    # Tekst zaczynajacy sie od "=" openpyxl zapisalby jako formule.
    value = neutralizuj_formule(value)
    if not isinstance(value, str) or len(value) <= EXCEL_MAX_CELL_LENGTH:
        return value
    keep = EXCEL_MAX_CELL_LENGTH - len(_TRUNCATION_NOTE)
    return value[:keep] + _TRUNCATION_NOTE


def rows_or_empty(rows: list[dict], columns: list[str] | None = None) -> pd.DataFrame:
    if rows:
        return pd.DataFrame([{neutralizuj_formule(key): _fit_cell(value) for key, value in row.items()} for row in rows])
    return pd.DataFrame(columns=columns or [])


def _join_cell(value: object) -> object:
    if isinstance(value, list):
        return " | ".join(str(item) for item in value)
    if isinstance(value, set):
        return " | ".join(str(item) for item in sorted(value))
    return value


def _json_cell(value: object) -> str:
    if value is None:
        return ""
    return json.dumps(value, ensure_ascii=False, default=str)


def _flatten_cost_defense_rows(rows: list[dict]) -> list[dict]:
    flattened: list[dict] = []
    for row in rows:
        linked_trade = row.get("linked_trade") or {}
        flattened.append(
            {
                "cost_id": row.get("cost_id"),
                "kind": row.get("kind"),
                "amount_pln": row.get("amount_pln"),
                "currency": row.get("currency"),
                "policy_level": row.get("policy_level"),
                "risk_level": row.get("risk_level"),
                "risk_level_key": row.get("risk_level_key"),
                "defense_status": row.get("defense_status"),
                "defense_status_label_pl": row.get("defense_status_label_pl"),
                "defense_status_source": row.get("defense_status_source"),
                "user_note": row.get("user_note"),
                "evidence_confirmed": row.get("evidence_confirmed"),
                "checked_at": row.get("checked_at"),
                "included_in_filing_package": row.get("included_in_filing_package"),
                "evidence_id": row.get("evidence_id"),
                "evidence_level": row.get("evidence_level"),
                "reason": row.get("reason"),
                "source_id": row.get("source_id"),
                "allocation_target": row.get("allocation_target"),
                "linked_trade_id": linked_trade.get("trade_id"),
                "linked_trade_date": row.get("linked_trade_date") or linked_trade.get("executed_at"),
                "linked_trade_symbol": linked_trade.get("symbol"),
                "linked_trade_side": linked_trade.get("side"),
                "linked_trade_executed_at": linked_trade.get("executed_at"),
                "linked_trade_source": linked_trade.get("source_name"),
                "missing_evidence": _join_cell(row.get("missing_evidence")),
                "user_action_label": row.get("user_action_label"),
                "amount_reconciliation": _json_cell(row.get("amount_reconciliation")),
                "legal_basis": _join_cell(row.get("legal_basis")),
                "legal_sources": _join_cell(
                    [
                        f"{source.get('label')}: {source.get('url')}"
                        for source in row.get("legal_sources", [])
                        if isinstance(source, dict)
                    ]
                ),
                "tax_argument_pl": row.get("tax_argument_pl"),
                "recommended_evidence": _join_cell(row.get("recommended_evidence")),
                "source_refs": _join_cell(row.get("source_refs")),
                "audit_notes": _join_cell(row.get("audit_notes")),
                "requires_user_documentation": row.get("requires_user_documentation"),
            }
        )
    return flattened


def _audit_appendix_summary_rows(appendix: dict) -> list[dict]:
    return [
        {
            "section": "issues",
            "record_count": len(appendix.get("issues", [])),
            "description": "Pelna lista problemow jest w arkuszu Issues oraz w audytowym JSON.",
        },
        {
            "section": "cost_decisions",
            "record_count": len(appendix.get("cost_decisions", [])),
            "description": "Pelna lista decyzji kosztowych jest w arkuszu Cost_Policy_Decisions.",
        },
        {
            "section": "aggressive_cost_defense",
            "record_count": len(appendix.get("aggressive_cost_defense", [])),
            "description": "Szczegolowe uzasadnienia sa w arkuszu Aggressive_Cost_Defense.",
        },
        {
            "section": "defense_evidence_links",
            "record_count": len(appendix.get("defense_evidence_links", [])),
            "description": "Graf dowodowy kosztow aggressive_user jest w arkuszu Defense_Evidence_Links.",
        },
        {
            "section": "defense_readiness",
            "record_count": 1 if appendix.get("defense_readiness") else 0,
            "description": "Gotowosc dowodowa planu aggressive_user jest w arkuszu Defense_Readiness.",
        },
        {
            "section": "tax_calculation_ledger",
            "record_count": len((appendix.get("tax_calculation_ledger") or {}).get("rows", [])),
            "description": "Pelny slad kalkulacji podatku jest w arkuszu Tax_Calculation_Ledger.",
        },
        {
            "section": "tax_trace_index",
            "record_count": len(appendix.get("tax_trace_index", [])),
            "description": "Indeks sciezek kwot jest w arkuszu Tax_Trace_Index.",
        },
        {
            "section": "source_manifest_v2",
            "record_count": len(appendix.get("source_manifest_v2", [])),
            "description": "Manifest plikow zrodlowych jest w arkuszu Source_Manifest.",
        },
        {
            "section": "import_intelligence_report",
            "record_count": len((appendix.get("import_intelligence_report") or {}).get("sources", [])),
            "description": "Rozpoznanie importu, duplikaty i braki sa w arkuszu Import_Intelligence.",
        },
        {
            "section": "no_overpay_audit",
            "record_count": len((appendix.get("no_overpay_audit") or {}).get("candidateCosts", [])),
            "description": "Audyt kosztow, ktore moga obnizac podatek, jest w arkuszu No_Overpay_Audit.",
        },
        {
            "section": "defense_case_file",
            "record_count": 1 if appendix.get("defense_case_file") else 0,
            "description": "Plik sprawy obronnej kosztow jest w arkuszu Defense_Case_File.",
        },
        {
            "section": "broker_file_control_tower",
            "record_count": 1 if appendix.get("broker_file_control_tower") else 0,
            "description": "Centrum kontroli plikow brokera jest w arkuszach Coverage_Matrix, No_Overpay_Audit_v2 i Defense_Case_File_v2.",
        },
        {
            "section": "coverage_matrix",
            "record_count": len(appendix.get("coverage_matrix", [])),
            "description": "Macierz kompletnosci danych brokera i NBP jest w arkuszu Coverage_Matrix.",
        },
        {
            "section": "no_overpay_audit_v2",
            "record_count": len((appendix.get("no_overpay_audit_v2") or {}).get("candidateCosts", [])),
            "description": "Rozszerzony audyt kosztow potencjalnie obnizajacych podatek jest w arkuszu No_Overpay_Audit_v2.",
        },
        {
            "section": "defense_case_file_v2",
            "record_count": len((appendix.get("defense_case_file_v2") or {}).get("defenseChains", [])),
            "description": "Lancuch dowodowy kosztow aggressive_user jest w arkuszu Defense_Case_File_v2.",
        },
        {
            "section": "legal_basis_registry",
            "record_count": len(appendix.get("legal_basis_registry", [])),
            "description": "Lokalny rejestr podstaw prawnych audytu jest w arkuszu Legal_Basis.",
        },
        {
            "section": "result_delta_report",
            "record_count": len((appendix.get("result_delta_report") or {}).get("rows", [])),
            "description": "Porownanie biezacego wyniku z poprzednim snapshotem jest w arkuszu Result_Delta_Report.",
        },
        {
            "section": "defense_gap_summary",
            "record_count": len((appendix.get("defense_gap_summary") or {}).get("gaps", [])),
            "description": "Uzytkowe braki dowodowe sa w arkuszu Defense_Gap_Summary.",
        },
        {
            "section": "pit_submission_readiness",
            "record_count": len((appendix.get("pit_submission_readiness") or {}).get("checklist", [])),
            "description": "Kontrola przed zlozeniem PIT jest w arkuszu PIT_Submission_Checklist.",
        },
        {
            "section": "pit_case_file",
            "record_count": 1 if appendix.get("pit_case_file") else 0,
            "description": "Odtwarzalny case file raportu PIT jest w arkuszu PIT_Case_File.",
        },
        {
            "section": "result_health_check",
            "record_count": 1 if appendix.get("result_health_check") else 0,
            "description": "Kontrola zaufania do wyniku i aktywnych zrodel PIT jest w arkuszu Result_Health_Check.",
        },
        {
            "section": "source_trust_summary",
            "record_count": len((appendix.get("source_trust_summary") or {}).get("items", [])),
            "description": "Warstwa zaufania do zrodel jest w arkuszu Source Trust.",
        },
        {
            "section": "storage_smoke_report",
            "record_count": 1 if appendix.get("storage_smoke_report") else 0,
            "description": "Smoke test realnego storage jest w metadanych audytu.",
        },
        {
            "section": "nbp_coverage_report",
            "record_count": len((appendix.get("nbp_coverage_report") or {}).get("missing", [])),
            "description": "Pokrycie kursow NBP jest w arkuszu NBP Coverage.",
        },
        {
            "section": "no_overpay_audit_v3",
            "record_count": sum(len(section.get("items", [])) for section in (appendix.get("no_overpay_audit_v3") or {}).get("sections", []) if isinstance(section, dict)),
            "description": "No Overpay Guard v3 jest w arkuszu No Overpay Guard.",
        },
        {
            "section": "defense_vault_summary",
            "record_count": len((appendix.get("defense_vault_summary") or {}).get("items", [])),
            "description": "Defense Vault jest w arkuszu Defense Vault.",
        },
        {
            "section": "advisor_review_pack",
            "record_count": 1 if appendix.get("advisor_review_pack") else 0,
            "description": "Pakiet dla doradcy jest eksportowany jako JSON/MD/HTML.",
        },
        {
            "section": "memorandum_aggressive_user",
            "record_count": 1 if appendix.get("memorandum_aggressive_user") else 0,
            "description": "Memorandum dla doradcy podatkowego jest w arkuszu Aggressive_Memorandum.",
        },
        {
            "section": "tax_advisor_brief",
            "record_count": 1 if appendix.get("tax_advisor_brief") else 0,
            "description": "Skrot dla doradcy podatkowego jest w arkuszu Tax_Advisor_Brief oraz pliku Markdown/JSON.",
        },
        {
            "section": "legal_safety_notice",
            "record_count": 1 if appendix.get("legal_safety_notice") else 0,
            "description": appendix.get("legal_safety_notice", ""),
        },
    ]


def _defense_readiness_rows(appendix: dict | None) -> list[dict]:
    readiness = (appendix or {}).get("defense_readiness") or {}
    if not isinstance(readiness, dict):
        return []
    rows = []
    scalar_keys = [
        "score",
        "totalAggressiveItems",
        "completeItems",
        "missingEvidenceItems",
        "highRiskItems",
    ]
    for key in scalar_keys:
        rows.append({"metric": key, "value": readiness.get(key), "details": ""})
    rows.append({"metric": "status_counts", "value": "", "details": _json_cell(readiness.get("status_counts"))})
    rows.append({"metric": "kind_totals_pln", "value": "", "details": _json_cell(readiness.get("kind_totals_pln"))})
    rows.append({"metric": "duplicate_cost_ids", "value": "", "details": _join_cell(readiness.get("duplicate_cost_ids"))})
    for warning in readiness.get("blockingWarnings", []) or []:
        rows.append({"metric": "blocking_warning", "value": "", "details": warning})
    for item in readiness.get("actionItems", []) or []:
        rows.append(
            {
                "metric": "action_item",
                "value": item.get("costId"),
                "details": _json_cell(item),
            }
        )
    return rows


def _defense_evidence_link_rows(appendix: dict | None) -> list[dict]:
    rows: list[dict] = []
    for link in (appendix or {}).get("defense_evidence_links", []) or []:
        if not isinstance(link, dict):
            continue
        rows.append(
            {
                "evidence_id": link.get("evidenceId"),
                "cost_id": link.get("costId"),
                "source_record_id": link.get("sourceRecordId"),
                "source_file": link.get("sourceFile"),
                "raw_row_ref": link.get("rawRowRef"),
                "linked_trade_ids": _join_cell(link.get("linkedTradeIds")),
                "amount_pln": link.get("amountPln"),
                "defense_status": link.get("defenseStatus"),
                "defense_status_source": link.get("defenseStatusSource"),
                "user_note": link.get("userNote"),
                "evidence_confirmed": link.get("evidenceConfirmed"),
                "checked_at": link.get("checkedAt"),
                "included_in_filing_package": link.get("includedInFilingPackage"),
                "missing_evidence": _join_cell(link.get("missingEvidence")),
                "user_action_label": link.get("userActionLabel"),
                "risk_level": link.get("riskLevel"),
                "tax_impact": link.get("taxImpact"),
                "amount_reconciliation": _json_cell(link.get("amountReconciliation")),
            }
        )
    return rows


def _aggressive_memorandum_rows(appendix: dict | None) -> list[dict]:
    memorandum = (appendix or {}).get("memorandum_aggressive_user") or (appendix or {}).get("aggressive_user_memorandum")
    if not memorandum:
        return []
    return [{"line_no": index + 1, "text": line} for index, line in enumerate(str(memorandum).splitlines())]


def _result_health_check_rows(appendix: dict | None) -> list[dict]:
    health = (appendix or {}).get("result_health_check") or {}
    if not isinstance(health, dict) or not health:
        return []
    rows: list[dict] = [
        {"section": "summary", "field": "status", "value": health.get("status"), "details": health.get("headline")},
        {"section": "summary", "field": "recognized_storage_file_count", "value": health.get("recognizedStorageFileCount"), "details": ""},
        {"section": "summary", "field": "tax_history_row_count", "value": health.get("taxHistoryRowCount"), "details": ""},
        {"section": "summary", "field": "sell_row_count", "value": health.get("sellRowCount"), "details": ""},
        {"section": "summary", "field": "revenue_pln", "value": health.get("revenuePln"), "details": ""},
        {"section": "summary", "field": "cost_pln", "value": health.get("costPln"), "details": ""},
    ]
    source_ids = health.get("activeTaxSourceIds") or []
    source_labels = health.get("activeTaxSourceLabels") or []
    for index, label in enumerate(source_labels):
        rows.append(
            {
                "section": "active_tax_source",
                "field": source_ids[index] if index < len(source_ids) else "",
                "value": label,
                "details": "",
            }
        )
    for reason in health.get("reasons") or []:
        rows.append({"section": "reason", "field": "", "value": reason, "details": ""})
    return rows


def _tax_advisor_brief_rows(appendix: dict | None) -> list[dict]:
    brief = (appendix or {}).get("tax_advisor_brief") or {}
    if not isinstance(brief, dict) or not brief:
        return []
    rows: list[dict] = []
    for key, value in (brief.get("summary") or {}).items():
        rows.append({"section": "summary", "field": key, "value": value, "details": ""})
    health = brief.get("result_health_check") or {}
    if isinstance(health, dict):
        rows.append(
            {
                "section": "result_health_check",
                "field": "status",
                "value": health.get("status"),
                "details": health.get("headline"),
            }
        )
        for reason in health.get("reasons") or []:
            rows.append({"section": "result_health_check", "field": "reason", "value": reason, "details": ""})
    for source in brief.get("active_tax_sources") or []:
        if not isinstance(source, dict):
            continue
        rows.append(
            {
                "section": "active_tax_source",
                "field": source.get("source_id"),
                "value": source.get("filename"),
                "details": _json_cell({"role": source.get("role"), "record_counts": source.get("record_counts")}),
            }
        )
    for cost in brief.get("aggressive_costs") or []:
        if not isinstance(cost, dict):
            continue
        rows.append(
            {
                "section": "aggressive_cost",
                "field": cost.get("cost_id"),
                "value": cost.get("amount_pln"),
                "details": _json_cell(
                    {
                        "label": cost.get("label"),
                        "risk_level": cost.get("risk_level"),
                        "defense_status": cost.get("defense_status"),
                        "missing_evidence": cost.get("missing_evidence"),
                    }
                ),
            }
        )
    for item in brief.get("evidence_to_keep") or []:
        if isinstance(item, dict):
            rows.append({"section": "evidence_to_keep", "field": item.get("id"), "value": item.get("label"), "details": item.get("user_action")})
    for question in brief.get("advisor_questions") or []:
        rows.append({"section": "advisor_question", "field": "", "value": question, "details": ""})
    if brief.get("legal_notice"):
        rows.append({"section": "legal_notice", "field": "", "value": brief.get("legal_notice"), "details": ""})
    return rows


def _source_trust_rows(appendix: dict | None) -> list[dict]:
    summary = (appendix or {}).get("source_trust_summary") or {}
    if not isinstance(summary, dict) or not summary:
        return []
    rows: list[dict] = []
    for item in summary.get("items") or []:
        if not isinstance(item, dict):
            continue
        rows.append(
            {
                "source_id": item.get("source_id"),
                "file_name": item.get("file_name"),
                "file_type": item.get("file_type"),
                "detected_role": item.get("detected_role"),
                "usage_status": item.get("usage_status"),
                "tax_years_detected": _join_cell(item.get("tax_years_detected")),
                "file_hash": item.get("file_hash"),
                "record_counts": _json_cell(item.get("record_counts")),
                "quality": _json_cell(item.get("quality")),
                "review_reasons": _join_cell(item.get("review_reasons")),
                "warnings": _join_cell(item.get("warnings")),
            }
        )
    return rows


def _source_trust_active_rows(appendix: dict | None) -> list[dict]:
    return [
        row
        for row in _source_trust_rows(appendix)
        if row.get("usage_status") == "transaction_source"
    ]


def _source_trust_candidate_rows(appendix: dict | None) -> list[dict]:
    """Zrodla rozpoznane, ale niezasilajace rejestru transakcji.

    Dopelnienie arkusza "Active Sources". Odpowiada na pytanie audytowe
    "dlaczego ten plik nie zostal policzony" - kazdy wiersz niesie
    usage_status oraz powody przegladu i ostrzezenia.
    """
    return [
        row
        for row in _source_trust_rows(appendix)
        if row.get("usage_status") != "transaction_source"
    ]



def _financing_ledger_rows(result) -> list[dict]:
    """Epizody finansowania ujemnego salda: pozyczony kapital i jego koszt.

    Jeden wiersz na epizod, od dnia powstania dlugu do dnia uregulowania.
    """
    ledger = getattr(result, "financing_ledger", None) or {}
    rows: list[dict] = []
    for episode in ledger.get("episodes") or []:
        if not isinstance(episode, dict):
            continue
        rows.append(
            {
                "episode_id": episode.get("episode_id"),
                "currency": episode.get("currency"),
                "opened_on": episode.get("opened_on"),
                "last_charged_on": episode.get("last_charged_on"),
                "settled_on": episode.get("settled_on"),
                "is_open": episode.get("is_open"),
                "charged_days": episode.get("charged_days"),
                "total_interest": episode.get("total_interest"),
                "total_interest_pln": episode.get("total_interest_pln"),
                "daily_rate_used": episode.get("daily_rate_used"),
                "peak_principal": episode.get("peak_principal"),
                "average_principal": episode.get("average_principal"),
                "principal_source": episode.get("principal_source"),
            }
        )
    return rows


def _no_overpay_audit_v3_rows(appendix: dict | None) -> list[dict]:
    audit = (appendix or {}).get("no_overpay_audit_v3") or {}
    if not isinstance(audit, dict) or not audit:
        return []
    rows: list[dict] = []
    for section in audit.get("sections") or []:
        if not isinstance(section, dict):
            continue
        for item in section.get("items") or []:
            if not isinstance(item, dict):
                continue
            rows.append(
                {
                    "section_id": section.get("section_id"),
                    "section_title": section.get("title_pl"),
                    "item_id": item.get("item_id"),
                    "decision": item.get("decision"),
                    "amount_pln": item.get("amount_pln"),
                    "currency_original": item.get("currency_original"),
                    "confidence": item.get("confidence"),
                    "evidence_status": item.get("evidence_status"),
                    "linked_record_ids": _join_cell(item.get("linked_record_ids")),
                    "reason_pl": item.get("reason_pl"),
                    "advisor_question_pl": item.get("advisor_question_pl"),
                    "duplicate_risk": _json_cell(item.get("duplicate_risk")),
                }
            )
    return rows


def _defense_vault_rows(appendix: dict | None) -> list[dict]:
    vault = (appendix or {}).get("defense_vault_summary") or {}
    if not isinstance(vault, dict) or not vault:
        return []
    rows: list[dict] = []
    for item in vault.get("items") or []:
        if not isinstance(item, dict):
            continue
        file_ref = item.get("file_ref") or {}
        rows.append(
            {
                "evidence_id": item.get("evidence_id"),
                "title": item.get("title"),
                "evidence_type": item.get("evidence_type"),
                "status": item.get("status"),
                "file_name": file_ref.get("file_name") if isinstance(file_ref, dict) else "",
                "file_hash": file_ref.get("file_hash") if isinstance(file_ref, dict) else "",
                "linked_record_ids": _join_cell(item.get("linked_record_ids")),
                "linked_source_ids": _join_cell(item.get("linked_source_ids")),
                "linked_no_overpay_item_ids": _join_cell(item.get("linked_no_overpay_item_ids")),
                "user_note": item.get("user_note"),
                "checklist": _json_cell(item.get("checklist")),
            }
        )
    return rows


def _advisor_review_pack_rows(appendix: dict | None) -> list[dict]:
    pack = (appendix or {}).get("advisor_review_pack") or {}
    if not isinstance(pack, dict) or not pack:
        return []
    rows: list[dict] = []
    for key, value in (pack.get("result") or {}).items():
        rows.append({"section": "result", "field": key, "value": value, "details": ""})
    health = pack.get("health") or {}
    if isinstance(health, dict):
        rows.append({"section": "health", "field": "status", "value": health.get("status"), "details": health.get("headline")})
        for reason in health.get("reasons") or []:
            rows.append({"section": "health", "field": "reason", "value": reason, "details": ""})
    for question in (pack.get("risk_summary") or {}).get("advisor_questions") or []:
        rows.append({"section": "advisor_question", "field": "", "value": question, "details": ""})
    for source in pack.get("files") or []:
        if isinstance(source, dict):
            rows.append(
                {
                    "section": "file",
                    "field": source.get("source_id"),
                    "value": source.get("file_name"),
                    "details": _json_cell({"usage_status": source.get("usage_status"), "file_hash": source.get("file_hash")}),
                }
            )
    return rows


def _nbp_coverage_rows(appendix: dict | None) -> list[dict]:
    report = (appendix or {}).get("nbp_coverage_report") or {}
    if not isinstance(report, dict) or not report:
        return []
    rows = [
        {"section": "summary", "field": "status", "value": report.get("status"), "details": ""},
        {"section": "summary", "field": "required_rates", "value": report.get("required_rates"), "details": ""},
        {"section": "summary", "field": "found_rates", "value": report.get("found_rates"), "details": ""},
        {"section": "summary", "field": "missing_rates", "value": report.get("missing_rates"), "details": ""},
    ]
    for missing in report.get("missing") or []:
        if isinstance(missing, dict):
            rows.append(
                {
                    "section": "missing",
                    "field": missing.get("currency"),
                    "value": missing.get("date"),
                    "details": _json_cell(missing),
                }
            )
    return rows


def _audit_metadata_rows(result: EngineRunResult, appendix: dict | None) -> list[dict]:
    return [
        {"field": "audit_hash", "value": result.audit_hash, "details": ""},
        {"field": "silnik_version", "value": (result.performance_profile or {}).get("silnik_version") or "current", "details": ""},
        {"field": "contract_version", "value": "pit_trust_os_v1", "details": ""},
        {"field": "storage_version", "value": "v2_pit_trust_os", "details": ""},
        {"field": "result_health_status", "value": ((appendix or {}).get("result_health_check") or {}).get("status"), "details": ""},
        {"field": "storage_smoke_status", "value": ((appendix or {}).get("storage_smoke_report") or {}).get("status"), "details": ""},
    ]


def _tax_calculation_ledger_rows(appendix: dict | None) -> list[dict]:
    ledger = (appendix or {}).get("tax_calculation_ledger") or {}
    rows: list[dict] = []
    for row in ledger.get("rows", []) or []:
        if not isinstance(row, dict):
            continue
        rows.append(
            {
                "line_id": row.get("line_id"),
                "section": row.get("section"),
                "label": row.get("label"),
                "amount_pln": row.get("amount_pln"),
                "source": row.get("source"),
                "tax_effect": row.get("tax_effect"),
                "formula": row.get("formula"),
                "inputs": _json_cell(row.get("inputs")),
                "notes": _join_cell(row.get("notes")),
            }
        )
    return rows


def _tax_trace_index_rows(appendix: dict | None) -> list[dict]:
    rows: list[dict] = []
    for entry in (appendix or {}).get("tax_trace_index", []) or []:
        if not isinstance(entry, dict):
            continue
        rows.append(
            {
                "trace_id": entry.get("trace_id"),
                "kind": entry.get("kind"),
                "label": entry.get("label"),
                "amount_pln": entry.get("amount_pln"),
                "ledger_row_ids": _join_cell(entry.get("ledger_row_ids")),
                "evidence_ids": _join_cell(entry.get("evidence_ids")),
                "checklist_item_ids": _join_cell(entry.get("checklist_item_ids")),
                "source_record_ids": _join_cell(entry.get("source_record_ids")),
                "tax_impact_kind": entry.get("tax_impact_kind"),
                "risk_level": entry.get("risk_level"),
                "explanation_pl": entry.get("explanation_pl"),
            }
        )
    return rows


def _result_delta_report_rows(appendix: dict | None) -> list[dict]:
    report = (appendix or {}).get("result_delta_report") or {}
    rows: list[dict] = [
        {
            "line_id": "__SUMMARY__",
            "label": report.get("summary"),
            "change_type": report.get("status"),
            "previous_amount_pln": "",
            "current_amount_pln": "",
            "delta_pln": "",
            "reason": "Benchmark uzytkownika jest diagnostyczny i nie wymusza wyniku.",
        }
    ] if report else []
    for row in report.get("rows", []) or []:
        if not isinstance(row, dict):
            continue
        rows.append(
            {
                "line_id": row.get("line_id"),
                "label": row.get("label"),
                "change_type": row.get("change_type"),
                "previous_amount_pln": row.get("previous_amount_pln"),
                "current_amount_pln": row.get("current_amount_pln"),
                "delta_pln": row.get("delta_pln"),
                "reason": row.get("reason"),
            }
        )
    return rows


def _defense_gap_summary_rows(appendix: dict | None) -> list[dict]:
    summary = (appendix or {}).get("defense_gap_summary") or {}
    rows: list[dict] = []
    for gap in summary.get("gaps", []) or []:
        if not isinstance(gap, dict):
            continue
        rows.append(
            {
                "cost_id": gap.get("cost_id"),
                "kind": gap.get("kind"),
                "defense_status": gap.get("defense_status"),
                "risk_level": gap.get("risk_level"),
                "source_id": gap.get("source_id"),
                "linked_trade_id": gap.get("linked_trade_id"),
                "missing_evidence": _join_cell(gap.get("missing_evidence")),
                "user_action_label": gap.get("user_action_label"),
            }
        )
    if not rows and summary:
        rows.append(
            {
                "cost_id": "__SUMMARY__",
                "kind": "",
                "defense_status": "",
                "risk_level": "",
                "source_id": "",
                "linked_trade_id": "",
                "missing_evidence": f"Braki: {summary.get('total_gaps', 0)}",
                "user_action_label": _json_cell(summary.get("by_status")),
            }
        )
    return rows


def _pit_submission_checklist_rows(appendix: dict | None) -> list[dict]:
    readiness = (appendix or {}).get("pit_submission_readiness") or {}
    if not isinstance(readiness, dict):
        return []
    rows: list[dict] = [
        {
            "id": "__SUMMARY__",
            "severity": "",
            "category": "",
            "label": f"Werdykt: {readiness.get('verdict')}",
            "user_action": (
                (readiness.get("recommendedAction") or {}).get("userAction")
                if isinstance(readiness.get("recommendedAction"), dict)
                else ""
            ),
            "linked_cost_id": "",
            "linked_row_id": "",
            "source_id": "",
            "score": readiness.get("score"),
            "generated_at": readiness.get("generatedAt"),
        }
    ]
    for item in readiness.get("checklist", []) or []:
        if not isinstance(item, dict):
            continue
        rows.append(
            {
                "id": item.get("id"),
                "severity": item.get("severity"),
                "category": item.get("category"),
                "label": item.get("label"),
                "user_action": item.get("userAction"),
                "linked_cost_id": item.get("linkedCostId"),
                "linked_row_id": item.get("linkedRowId"),
                "source_id": item.get("sourceId"),
                "score": "",
                "generated_at": readiness.get("generatedAt"),
            }
        )
    return rows


def _pit_case_file_rows(appendix: dict | None) -> list[dict]:
    case_file = (appendix or {}).get("pit_case_file") or {}
    if not isinstance(case_file, dict):
        return []
    rows: list[dict] = []
    scalar_keys = [
        "case_file_id",
        "generated_at",
        "tax_year",
        "plan_used",
        "filing_profile",
        "primary_scenario",
        "audit_hash",
        "status",
        "filing_ready",
        "reproducible",
        "reproducibility_status",
        "input_fingerprint",
        "calculation_fingerprint",
    ]
    for key in scalar_keys:
        rows.append({"field": key, "value": case_file.get(key), "details": ""})
    for key, value in (case_file.get("package_sections") or {}).items():
        rows.append({"field": f"package_sections.{key}", "value": value, "details": ""})
    for artifact in case_file.get("included_artifacts", []) or []:
        rows.append({"field": "included_artifact", "value": artifact, "details": ""})
    for instruction in case_file.get("replay_instructions_pl", []) or []:
        rows.append({"field": "replay_instruction", "value": "", "details": instruction})
    for warning in case_file.get("warnings", []) or []:
        rows.append({"field": "warning", "value": "", "details": warning})
    return rows


def _source_manifest_rows(appendix: dict | None) -> list[dict]:
    rows: list[dict] = []
    for source in (appendix or {}).get("source_manifest_v2", []) or []:
        if not isinstance(source, dict):
            continue
        record_counts = source.get("recordCounts") or {}
        date_range = source.get("dateRange") or {}
        rows.append(
            {
                "source_id": source.get("sourceId"),
                "filename": source.get("filename"),
                "hash": source.get("hash"),
                "detected_type": source.get("detectedType"),
                "sections": _join_cell(source.get("sections")),
                "rows": record_counts.get("rows"),
                "trade_like_rows": record_counts.get("trade_like_rows"),
                "event_like_rows": record_counts.get("event_like_rows"),
                "date_from": date_range.get("from"),
                "date_to": date_range.get("to"),
                "contributes_to_tax": source.get("contributesToTax"),
                "warnings": _join_cell(source.get("warnings")),
                "errors": _join_cell(source.get("errors")),
            }
        )
    return rows


def _import_intelligence_rows(appendix: dict | None) -> list[dict]:
    report = (appendix or {}).get("import_intelligence_report") or {}
    rows: list[dict] = []
    for source in report.get("sources", []) or []:
        if not isinstance(source, dict):
            continue
        rows.append(
            {
                "kind": "source",
                "id": source.get("sourceId"),
                "label": source.get("filename"),
                "severity": "",
                "details": _json_cell(source),
                "user_action": "",
            }
        )
    for duplicate in report.get("duplicates", []) or []:
        if not isinstance(duplicate, dict):
            continue
        rows.append(
            {
                "kind": "duplicate",
                "id": duplicate.get("record_key"),
                "label": "Potencjalny duplikat rekordu",
                "severity": "warning",
                "details": _json_cell(duplicate),
                "user_action": "Sprawdź, czy rekord nie został dostarczony w kilku plikach brokera.",
            }
        )
    for conflict in report.get("conflicts", []) or []:
        if not isinstance(conflict, dict):
            continue
        rows.append(
            {
                "kind": "conflict",
                "id": conflict.get("record_key") or conflict.get("id"),
                "label": "Konflikt źródeł",
                "severity": "warning",
                "details": _json_cell(conflict),
                "user_action": "Zweryfikuj zwycięskie źródło lub dodaj override.",
            }
        )
    for missing in report.get("missingExpectedSections", []) or []:
        rows.append(
            {
                "kind": "missing",
                "id": "",
                "label": missing,
                "severity": "warning",
                "details": "",
                "user_action": "Dodaj brakujący plik lub sprawdź format importu.",
            }
        )
    for action in report.get("recommendedActions", []) or []:
        rows.append(
            {
                "kind": "recommended_action",
                "id": "",
                "label": action,
                "severity": "info",
                "details": "",
                "user_action": action,
            }
        )
    return rows


def _no_overpay_audit_rows(appendix: dict | None) -> list[dict]:
    audit = (appendix or {}).get("no_overpay_audit") or {}
    rows: list[dict] = []
    summary = audit.get("summary") or {}
    if audit:
        rows.append(
            {
                "kind": "summary",
                "id": "__SUMMARY__",
                "label": f"Confidence score: {audit.get('confidenceScore')}",
                "amount_pln": "",
                "status": "",
                "included": "",
                "source_id": "",
                "details": _json_cell(summary),
                "recommended_action": _join_cell(audit.get("recommendedActions")),
            }
        )
    for cost in audit.get("candidateCosts", []) or []:
        if not isinstance(cost, dict):
            continue
        rows.append(
            {
                "kind": "candidate_cost",
                "id": cost.get("costId"),
                "label": cost.get("labelPl") or cost.get("kind"),
                "amount_pln": cost.get("amountPln"),
                "status": cost.get("status"),
                "included": cost.get("included"),
                "source_id": cost.get("sourceId"),
                "details": _json_cell(cost),
                "recommended_action": "",
            }
        )
    for duplicate in audit.get("duplicateRisks", []) or []:
        if not isinstance(duplicate, dict):
            continue
        rows.append(
            {
                "kind": "duplicate_risk",
                "id": duplicate.get("record_key"),
                "label": "Ryzyko duplikatu",
                "amount_pln": "",
                "status": "do_sprawdzenia",
                "included": "",
                "source_id": _join_cell(duplicate.get("sources")),
                "details": _json_cell(duplicate),
                "recommended_action": "Sprawdź, czy koszt lub transakcja nie są podwójnie policzone.",
            }
        )
    for evidence in audit.get("missingEvidence", []) or []:
        if not isinstance(evidence, dict):
            continue
        rows.append(
            {
                "kind": "missing_evidence",
                "id": evidence.get("evidenceId"),
                "label": evidence.get("costId"),
                "amount_pln": "",
                "status": evidence.get("defenseStatus"),
                "included": "",
                "source_id": evidence.get("sourceRecordId"),
                "details": _json_cell(evidence.get("missingEvidence")),
                "recommended_action": evidence.get("userActionLabel"),
            }
        )
    for row in audit.get("technicalRows", []) or []:
        if not isinstance(row, dict):
            continue
        rows.append(
            {
                "kind": "technical_row",
                "id": row.get("rowId"),
                "label": row.get("label"),
                "amount_pln": row.get("amountPln"),
                "status": "technical_only",
                "included": False,
                "source_id": row.get("sourceRecordId"),
                "details": _json_cell(row),
                "recommended_action": "Rekord audytowy; nie liczony w PIT.",
            }
        )
    return rows


def _defense_case_file_rows(appendix: dict | None) -> list[dict]:
    case_file = (appendix or {}).get("defense_case_file") or {}
    rows: list[dict] = []
    if not isinstance(case_file, dict):
        return rows
    for key, value in (case_file.get("summary") or {}).items():
        rows.append({"section": "summary", "id": key, "label": key, "details": value, "user_action": ""})
    for source in case_file.get("sourceManifests", []) or []:
        rows.append(
            {
                "section": "source",
                "id": source.get("sourceId") if isinstance(source, dict) else "",
                "label": source.get("filename") if isinstance(source, dict) else "",
                "details": _json_cell(source),
                "user_action": "",
            }
        )
    for group in case_file.get("defenseGroups", []) or []:
        if not isinstance(group, dict):
            continue
        rows.append(
            {
                "section": "defense_group",
                "id": group.get("group_id"),
                "label": group.get("label_pl") or group.get("kind"),
                "details": _json_cell(
                    {
                        "amount_pln": group.get("amount_pln"),
                        "date_from": group.get("date_from"),
                        "date_to": group.get("date_to"),
                        "status": group.get("defense_status"),
                        "risk": group.get("risk_level"),
                        "cost_ids": group.get("cost_ids"),
                    }
                ),
                "user_action": _join_cell(group.get("missing_evidence")),
            }
        )
    for action in case_file.get("recommendedActions", []) or []:
        rows.append({"section": "recommended_action", "id": "", "label": action, "details": "", "user_action": action})
    return rows


def _coverage_matrix_rows(appendix: dict | None) -> list[dict]:
    rows: list[dict] = []
    for entry in (appendix or {}).get("coverage_matrix", []) or []:
        if not isinstance(entry, dict):
            continue
        rows.append(
            {
                "area": entry.get("area"),
                "label": entry.get("label"),
                "status": entry.get("status"),
                "record_count": entry.get("recordCount"),
                "issue_count": entry.get("issueCount"),
                "source_ids": _join_cell(entry.get("sourceIds")),
                "recommendation": entry.get("recommendation"),
            }
        )
    return rows


def _no_overpay_audit_v2_rows(appendix: dict | None) -> list[dict]:
    audit = (appendix or {}).get("no_overpay_audit_v2") or {}
    rows: list[dict] = []
    if not isinstance(audit, dict):
        return rows
    rows.append(
        {
            "kind": "summary",
            "id": "__SUMMARY__",
            "label": "No Overpay Guard v2",
            "amount_pln": "",
            "status": "",
            "risk": "",
            "details": _json_cell(audit.get("summary") or {}),
            "user_action": _join_cell(audit.get("recommendedActions")),
        }
    )
    for cost in audit.get("candidateCosts", []) or []:
        if not isinstance(cost, dict):
            continue
        rows.append(
            {
                "kind": "candidate_cost",
                "id": cost.get("costId"),
                "label": cost.get("labelPl") or cost.get("kind"),
                "amount_pln": cost.get("amountPln"),
                "status": cost.get("status"),
                "risk": "",
                "details": _json_cell(cost),
                "user_action": "",
            }
        )
    for cost in audit.get("potentiallyMissedCosts", []) or []:
        if not isinstance(cost, dict):
            continue
        rows.append(
            {
                "kind": "potentially_missed_cost",
                "id": cost.get("costId"),
                "label": cost.get("labelPl") or cost.get("kind"),
                "amount_pln": cost.get("amountPln"),
                "status": cost.get("overpayRisk") or cost.get("status"),
                "risk": "evidence",
                "details": _json_cell(cost),
                "user_action": cost.get("userAction"),
            }
        )
    for duplicate in audit.get("duplicateRisks", []) or []:
        if not isinstance(duplicate, dict):
            continue
        rows.append(
            {
                "kind": "duplicate_risk",
                "id": duplicate.get("record_key") or duplicate.get("key"),
                "label": "Ryzyko duplikatu",
                "amount_pln": "",
                "status": "do_sprawdzenia",
                "risk": "duplicate",
                "details": _json_cell(duplicate),
                "user_action": "Sprawdz, czy koszt lub transakcja nie sa podwojnie policzone.",
            }
        )
    return rows


def _defense_case_file_v2_rows(appendix: dict | None) -> list[dict]:
    case_file = (appendix or {}).get("defense_case_file_v2") or {}
    rows: list[dict] = []
    if not isinstance(case_file, dict):
        return rows
    for key, value in (case_file.get("summary") or {}).items():
        rows.append({"section": "summary", "id": key, "label": key, "details": value, "user_action": ""})
    for chain in case_file.get("defenseChains", []) or []:
        if not isinstance(chain, dict):
            continue
        rows.append(
            {
                "section": "defense_chain",
                "id": chain.get("costId"),
                "label": chain.get("label"),
                "amount_pln": chain.get("amountPln"),
                "risk_level": chain.get("riskLevel"),
                "defense_status": chain.get("defenseStatus"),
                "source_record_id": chain.get("sourceRecordId"),
                "source_file": chain.get("sourceFile"),
                "context": chain.get("contextLabel"),
                "linked_trade_ids": _join_cell(chain.get("linkedTradeIds")),
                "required_evidence": _join_cell(chain.get("requiredEvidence")),
                "legal_basis_refs": _join_cell(chain.get("legalBasisRefs")),
                "chain_steps": _json_cell(chain.get("chainSteps")),
                "user_action": chain.get("userAction"),
            }
        )
    for action in case_file.get("recommendedActions", []) or []:
        rows.append({"section": "recommended_action", "id": "", "label": action, "details": "", "user_action": action})
    return rows


def _legal_basis_rows(appendix: dict | None) -> list[dict]:
    rows: list[dict] = []
    for entry in (appendix or {}).get("legal_basis_registry", []) or []:
        if not isinstance(entry, dict):
            continue
        rows.append(
            {
                "basis_id": entry.get("basisId"),
                "label": entry.get("label"),
                "source": entry.get("source"),
                "url": entry.get("url"),
                "scope": entry.get("scope"),
                "risk_note": entry.get("riskNote"),
            }
        )
    return rows


def _broker_file_action_queue_rows(appendix: dict | None) -> list[dict]:
    rows: list[dict] = []
    for item in (appendix or {}).get("broker_file_action_queue", []) or []:
        if not isinstance(item, dict):
            continue
        rows.append(
            {
                "action_id": item.get("action_id"),
                "severity": item.get("severity"),
                "area": item.get("area"),
                "label": item.get("label"),
                "user_action": item.get("user_action"),
                "default_status": item.get("default_status"),
                "user_status": item.get("user_status") or item.get("default_status"),
                "status_source": item.get("status_source"),
                "user_note": item.get("user_note"),
                "linked_row_id": item.get("linked_row_id"),
                "source_ids": _join_cell(item.get("source_ids")),
                "cost_ids": _join_cell(item.get("cost_ids")),
                "history_search_term": item.get("history_search_term"),
                "reason": item.get("reason"),
            }
        )
    return rows


def _quality_summary_rows(result: EngineRunResult) -> list[dict]:
    if not result.quality_report:
        return []
    report = result.quality_report
    rows = [
        {
            "section": "summary",
            "filing_ready": report.filing_ready,
            "final_status": report.final_status,
            "blocking_issue_count": len(report.blocking_issues),
            "warning_issue_count": len(report.warning_issues),
            "informational_issue_count": len(report.informational_issues),
            "metric": None,
            "value": None,
        }
    ]
    rows.extend(
        {
            "section": "metric",
            "filing_ready": report.filing_ready,
            "final_status": report.final_status,
            "blocking_issue_count": len(report.blocking_issues),
            "warning_issue_count": len(report.warning_issues),
            "informational_issue_count": len(report.informational_issues),
            "metric": key,
            "value": value,
        }
        for key, value in report.metrics.items()
    )
    return rows


def export_workbook(result: EngineRunResult, output_dir: Path) -> list[Path]:
    output_dir.mkdir(parents=True, exist_ok=True)
    out_path = output_dir / "tax_report.xlsx"
    redact = result.config.pii_redaction_enabled

    trades_rows = redact_payload([asdict(trade) for trade in result.canonical_dataset.trades], redact)
    events_rows = redact_payload([asdict(event) for event in result.canonical_dataset.events], redact)
    issues_rows = redact_payload([asdict(issue) for issue in result.merge_result.ledger.issues], redact)
    fifo_rows = redact_payload(
        fifo_rows_as_dicts(result.fifo_rows, result.config.tax_year), redact
    )
    # Arkusz rozliczanego roku musi sumowac sie do pozycji 22 i 23 formularza;
    # wiersze innych lat sa potrzebne przy stratach, ale nie w tej sumie.
    fifo_rows_in_year, fifo_rows_other_years = split_by_filing_year(fifo_rows)
    scenario_rows = redact_payload([asdict(row) for row in result.scenario_results.values()], redact)
    private_cash_fx_rows = redact_payload([asdict(row) for row in result.private_cash_fx_view], redact)
    cost_item_rows = redact_payload([asdict(row) for row in result.cost_items], redact)
    cost_decision_rows = redact_payload([asdict(row) for row in result.cost_decisions], redact)
    funding_fee_rows = redact_payload([asdict(row) for row in result.funding_fee_allocations], redact)
    history_rows = redact_payload([asdict(row) for row in result.transaction_history_rows], redact)
    fx_conversion_rows = [row for row in cost_item_rows if str(row.get("kind", "")).startswith("FX_")]
    fx_rows = []
    for trade in result.canonical_dataset.trades:
        fx_rows.append(
            {
                "record_id": trade.trade_id,
                "record_type": "TRADE",
                "currency": trade.trade_currency,
                "tax_event_date": trade.tax_event_date,
                "fx_date": trade.gross_fx_date,
                "fx_rate": trade.gross_fx_rate,
                "commission_currency": trade.commission_currency,
                "commission_fx_date": trade.commission_fx_date,
                "commission_fx_rate": trade.commission_fx_rate,
            }
        )
    for event in result.canonical_dataset.events:
        fx_rows.append(
            {
                "record_id": event.event_id,
                "record_type": "EVENT",
                "currency": event.currency,
                "tax_event_date": event.tax_event_date,
                "fx_date": event.fx_date,
                "fx_rate": event.fx_rate,
                "commission_currency": None,
                "commission_fx_date": None,
                "commission_fx_rate": None,
            }
        )
    fx_rows = redact_payload(fx_rows, redact)

    account_cost_rows = [
        asdict(event)
        for event in result.canonical_dataset.events
        if event.logical_world in {"financing_costs", "diagnostic_only"}
    ]
    account_cost_rows = redact_payload(account_cost_rows, redact)
    quality_rows = _quality_summary_rows(result)
    coverage_rows = redact_payload([asdict(row) for row in result.fx_coverage_gaps], redact)
    depo_rows = redact_payload(result.depo_reconciliation, redact)
    annual_rows = redact_payload([result.annual_summary], redact)
    filing_draft_rows = redact_payload([asdict(result.tax_filing_package.draft)], redact) if result.tax_filing_package else []
    pit_form_field_rows = (
        redact_payload([asdict(field) for field in result.tax_filing_package.draft.form_fields], redact)
        if result.tax_filing_package
        else []
    )
    pit_form_projection_rows = (
        redact_payload(
            [
                {
                    "scenario_name": projection.scenario_name,
                    "revenue_pln": projection.revenue_pln,
                    "cost_pln": projection.cost_pln,
                    "income_pln": projection.income_pln,
                    "rounded_base_pln": projection.rounded_base_pln,
                    "silnik_tax_pln": projection.silnik_tax_pln,
                    "rounded_tax_from_base_pln": projection.rounded_tax_from_base_pln,
                    "tax_due_pln": projection.tax_due_pln,
                    "gross_dividend_pln": projection.gross_dividend_pln,
                    "foreign_dividend_tax_pln": projection.foreign_dividend_tax_pln,
                    "foreign_tax_credit_pln": projection.foreign_tax_credit_pln,
                }
                for projection in result.tax_filing_package.draft.scenario_projections.values()
            ],
            redact,
        )
        if result.tax_filing_package
        else []
    )
    calculation_rows = redact_payload(result.tax_filing_package.calculation.sections, redact) if result.tax_filing_package and result.tax_filing_package.calculation else []
    justification_rows = (
        redact_payload(
            [
                {
                    "title": result.tax_filing_package.justification.title,
                    "summary": result.tax_filing_package.justification.summary,
                    "assumptions": " | ".join(result.tax_filing_package.justification.assumptions),
                    "fx_rules": " | ".join(result.tax_filing_package.justification.fx_rules),
                    "policy_notes": " | ".join(result.tax_filing_package.justification.policy_notes),
                    "evidence_summary": " | ".join(result.tax_filing_package.justification.evidence_summary),
                }
            ],
            redact,
        )
        if result.tax_filing_package and result.tax_filing_package.justification
        else []
    )
    audit_evidence_rows = (
        redact_payload(_audit_appendix_summary_rows(result.tax_filing_package.audit_appendix), redact)
        if result.tax_filing_package and result.tax_filing_package.audit_appendix
        else []
    )
    defense_readiness_rows = (
        redact_payload(_defense_readiness_rows(result.tax_filing_package.audit_appendix), redact)
        if result.tax_filing_package and result.tax_filing_package.audit_appendix
        else []
    )
    defense_evidence_link_rows = (
        redact_payload(_defense_evidence_link_rows(result.tax_filing_package.audit_appendix), redact)
        if result.tax_filing_package and result.tax_filing_package.audit_appendix
        else []
    )
    aggressive_memorandum_rows = (
        redact_payload(_aggressive_memorandum_rows(result.tax_filing_package.audit_appendix), redact)
        if result.tax_filing_package and result.tax_filing_package.audit_appendix
        else []
    )
    result_health_check_rows = (
        redact_payload(_result_health_check_rows(result.tax_filing_package.audit_appendix), redact)
        if result.tax_filing_package and result.tax_filing_package.audit_appendix
        else []
    )
    tax_advisor_brief_rows = (
        redact_payload(_tax_advisor_brief_rows(result.tax_filing_package.audit_appendix), redact)
        if result.tax_filing_package and result.tax_filing_package.audit_appendix
        else []
    )
    source_trust_rows = (
        redact_payload(_source_trust_rows(result.tax_filing_package.audit_appendix), redact)
        if result.tax_filing_package and result.tax_filing_package.audit_appendix
        else []
    )
    active_source_rows = (
        redact_payload(_source_trust_active_rows(result.tax_filing_package.audit_appendix), redact)
        if result.tax_filing_package and result.tax_filing_package.audit_appendix
        else []
    )
    candidate_source_rows = (
        redact_payload(_source_trust_candidate_rows(result.tax_filing_package.audit_appendix), redact)
        if result.tax_filing_package and result.tax_filing_package.audit_appendix
        else []
    )
    financing_ledger_rows = redact_payload(_financing_ledger_rows(result), redact)
    no_overpay_audit_v3_rows = (
        redact_payload(_no_overpay_audit_v3_rows(result.tax_filing_package.audit_appendix), redact)
        if result.tax_filing_package and result.tax_filing_package.audit_appendix
        else []
    )
    defense_vault_rows = (
        redact_payload(_defense_vault_rows(result.tax_filing_package.audit_appendix), redact)
        if result.tax_filing_package and result.tax_filing_package.audit_appendix
        else []
    )
    advisor_review_pack_rows = (
        redact_payload(_advisor_review_pack_rows(result.tax_filing_package.audit_appendix), redact)
        if result.tax_filing_package and result.tax_filing_package.audit_appendix
        else []
    )
    nbp_coverage_report_rows = (
        redact_payload(_nbp_coverage_rows(result.tax_filing_package.audit_appendix), redact)
        if result.tax_filing_package and result.tax_filing_package.audit_appendix
        else []
    )
    audit_metadata_rows = (
        redact_payload(_audit_metadata_rows(result, result.tax_filing_package.audit_appendix), redact)
        if result.tax_filing_package and result.tax_filing_package.audit_appendix
        else []
    )
    tax_calculation_ledger_rows = (
        redact_payload(_tax_calculation_ledger_rows(result.tax_filing_package.audit_appendix), redact)
        if result.tax_filing_package and result.tax_filing_package.audit_appendix
        else []
    )
    tax_trace_index_rows = (
        redact_payload(_tax_trace_index_rows(result.tax_filing_package.audit_appendix), redact)
        if result.tax_filing_package and result.tax_filing_package.audit_appendix
        else []
    )
    source_manifest_rows = (
        redact_payload(_source_manifest_rows(result.tax_filing_package.audit_appendix), redact)
        if result.tax_filing_package and result.tax_filing_package.audit_appendix
        else []
    )
    import_intelligence_rows = (
        redact_payload(_import_intelligence_rows(result.tax_filing_package.audit_appendix), redact)
        if result.tax_filing_package and result.tax_filing_package.audit_appendix
        else []
    )
    no_overpay_audit_rows = (
        redact_payload(_no_overpay_audit_rows(result.tax_filing_package.audit_appendix), redact)
        if result.tax_filing_package and result.tax_filing_package.audit_appendix
        else []
    )
    defense_case_file_rows = (
        redact_payload(_defense_case_file_rows(result.tax_filing_package.audit_appendix), redact)
        if result.tax_filing_package and result.tax_filing_package.audit_appendix
        else []
    )
    coverage_matrix_rows = (
        redact_payload(_coverage_matrix_rows(result.tax_filing_package.audit_appendix), redact)
        if result.tax_filing_package and result.tax_filing_package.audit_appendix
        else []
    )
    no_overpay_audit_v2_rows = (
        redact_payload(_no_overpay_audit_v2_rows(result.tax_filing_package.audit_appendix), redact)
        if result.tax_filing_package and result.tax_filing_package.audit_appendix
        else []
    )
    defense_case_file_v2_rows = (
        redact_payload(_defense_case_file_v2_rows(result.tax_filing_package.audit_appendix), redact)
        if result.tax_filing_package and result.tax_filing_package.audit_appendix
        else []
    )
    legal_basis_rows = (
        redact_payload(_legal_basis_rows(result.tax_filing_package.audit_appendix), redact)
        if result.tax_filing_package and result.tax_filing_package.audit_appendix
        else []
    )
    broker_file_action_queue_rows = (
        redact_payload(_broker_file_action_queue_rows(result.tax_filing_package.audit_appendix), redact)
        if result.tax_filing_package and result.tax_filing_package.audit_appendix
        else []
    )
    result_delta_report_rows = (
        redact_payload(_result_delta_report_rows(result.tax_filing_package.audit_appendix), redact)
        if result.tax_filing_package and result.tax_filing_package.audit_appendix
        else []
    )
    defense_gap_summary_rows = (
        redact_payload(_defense_gap_summary_rows(result.tax_filing_package.audit_appendix), redact)
        if result.tax_filing_package and result.tax_filing_package.audit_appendix
        else []
    )
    pit_submission_checklist_rows = (
        redact_payload(_pit_submission_checklist_rows(result.tax_filing_package.audit_appendix), redact)
        if result.tax_filing_package and result.tax_filing_package.audit_appendix
        else []
    )
    pit_case_file_rows = (
        redact_payload(_pit_case_file_rows(result.tax_filing_package.audit_appendix), redact)
        if result.tax_filing_package and result.tax_filing_package.audit_appendix
        else []
    )
    aggressive_cost_defense_rows = (
        redact_payload(
            _flatten_cost_defense_rows(result.tax_filing_package.audit_appendix.get("aggressive_cost_defense", [])),
            redact,
        )
        if result.tax_filing_package and result.tax_filing_package.audit_appendix
        else []
    )
    annual_pit_rows = redact_payload(
        [
            {
                "tax_year": result.annual_summary.get("tax_year"),
                "plan_used": result.plan_used,
                "filing_profile": result.filing_profile,
                **result.annual_summary.get("art30b", {}),
                **{f"art30a_{key}": value for key, value in result.annual_summary.get("art30a", {}).items()},
            }
        ],
        redact,
    )

    with pd.ExcelWriter(out_path, engine="openpyxl") as writer:
        rows_or_empty(
            [
                {
                    "Status": result.status,
                    "Filing Ready": result.filing_ready,
                    "Plan Used": result.plan_used,
                    "Filing Profile": result.filing_profile,
                    "Primary Scenario": result.primary_scenario,
                    "Audit Hash": result.audit_hash,
                }
            ]
        ).to_excel(writer, sheet_name="Pipeline_Status", index=False)
        rows_or_empty([asdict(result.config.tax_plan)]).to_excel(writer, sheet_name="Plan_Config", index=False)
        rows_or_empty(issues_rows).to_excel(writer, sheet_name="Issues", index=False)
        rows_or_empty(quality_rows).to_excel(writer, sheet_name="Quality_Gates", index=False)
        rows_or_empty(trades_rows).to_excel(writer, sheet_name="Canonical_Trades", index=False)
        rows_or_empty(events_rows).to_excel(writer, sheet_name="Canonical_Events", index=False)
        rows_or_empty([result.merge_result.reconciliation_summary]).to_excel(writer, sheet_name="Source_Reconciliation", index=False)
        rows_or_empty(fx_rows).to_excel(writer, sheet_name="NBP_FX_Assignments", index=False)
        rows_or_empty(coverage_rows).to_excel(writer, sheet_name="FX_Coverage", index=False)
        rows_or_empty(depo_rows).to_excel(writer, sheet_name="DePo_Reconciliation", index=False)
        rows_or_empty(fifo_rows_in_year).to_excel(writer, sheet_name="FIFO_Realized", index=False)
        rows_or_empty(fifo_rows_other_years).to_excel(writer, sheet_name="FIFO_Other_Years", index=False)
        rows_or_empty(result.dividends_view).to_excel(writer, sheet_name="Dividends", index=False)
        rows_or_empty(result.foreign_tax_view).to_excel(writer, sheet_name="Foreign_Tax", index=False)
        rows_or_empty(account_cost_rows).to_excel(writer, sheet_name="Account_Costs", index=False)
        rows_or_empty(private_cash_fx_rows).to_excel(writer, sheet_name="Private_Cash_FX", index=False)
        rows_or_empty(fx_conversion_rows).to_excel(writer, sheet_name="FX_Conversion_Costs", index=False)
        rows_or_empty(cost_decision_rows).to_excel(writer, sheet_name="Cost_Policy_Decisions", index=False)
        rows_or_empty(funding_fee_rows).to_excel(writer, sheet_name="Funding_Fee_Allocations", index=False)
        rows_or_empty(history_rows).to_excel(writer, sheet_name="Transaction_History", index=False)
        rows_or_empty([row for row in cost_item_rows if row.get("is_aggressive_only")]).to_excel(writer, sheet_name="Aggressive_Only_Items", index=False)
        rows_or_empty(scenario_rows).to_excel(writer, sheet_name="Scenarios", index=False)
        rows_or_empty(annual_rows).to_excel(writer, sheet_name="PIT38_Summary", index=False)
        rows_or_empty(annual_pit_rows).to_excel(writer, sheet_name="Annual_PIT38_Summary", index=False)
        rows_or_empty(filing_draft_rows).to_excel(writer, sheet_name="PIT38_Draft", index=False)
        rows_or_empty(pit_form_field_rows).to_excel(writer, sheet_name="PIT_Form_Fields", index=False)
        rows_or_empty(pit_form_projection_rows).to_excel(writer, sheet_name="PIT38_Form_Projections", index=False)
        rows_or_empty(calculation_rows).to_excel(writer, sheet_name="Calculation_Report", index=False)
        rows_or_empty(justification_rows).to_excel(writer, sheet_name="Justification_Memo", index=False)
        rows_or_empty(aggressive_cost_defense_rows).to_excel(writer, sheet_name="Aggressive_Cost_Defense", index=False)
        rows_or_empty(defense_readiness_rows).to_excel(writer, sheet_name="Defense_Readiness", index=False)
        rows_or_empty(defense_evidence_link_rows).to_excel(writer, sheet_name="Defense_Evidence_Links", index=False)
        rows_or_empty(tax_calculation_ledger_rows).to_excel(writer, sheet_name="Tax_Calculation_Ledger", index=False)
        rows_or_empty(tax_trace_index_rows).to_excel(writer, sheet_name="Tax_Trace_Index", index=False)
        rows_or_empty(source_manifest_rows).to_excel(writer, sheet_name="Source_Manifest", index=False)
        rows_or_empty(import_intelligence_rows).to_excel(writer, sheet_name="Import_Intelligence", index=False)
        rows_or_empty(no_overpay_audit_rows).to_excel(writer, sheet_name="No_Overpay_Audit", index=False)
        rows_or_empty(defense_case_file_rows).to_excel(writer, sheet_name="Defense_Case_File", index=False)
        rows_or_empty(coverage_matrix_rows).to_excel(writer, sheet_name="Coverage_Matrix", index=False)
        rows_or_empty(no_overpay_audit_v2_rows).to_excel(writer, sheet_name="No_Overpay_Audit_v2", index=False)
        rows_or_empty(defense_case_file_v2_rows).to_excel(writer, sheet_name="Defense_Case_File_v2", index=False)
        rows_or_empty(broker_file_action_queue_rows).to_excel(writer, sheet_name="Broker_File_Action_Queue", index=False)
        rows_or_empty(legal_basis_rows).to_excel(writer, sheet_name="Legal_Basis", index=False)
        rows_or_empty(result_delta_report_rows).to_excel(writer, sheet_name="Result_Delta_Report", index=False)
        rows_or_empty(defense_gap_summary_rows).to_excel(writer, sheet_name="Defense_Gap_Summary", index=False)
        rows_or_empty(pit_submission_checklist_rows).to_excel(writer, sheet_name="PIT_Submission_Checklist", index=False)
        rows_or_empty(pit_case_file_rows).to_excel(writer, sheet_name="PIT_Case_File", index=False)
        rows_or_empty(result_health_check_rows).to_excel(writer, sheet_name="Result_Health_Check", index=False)
        rows_or_empty(tax_advisor_brief_rows).to_excel(writer, sheet_name="Tax_Advisor_Brief", index=False)
        rows_or_empty(aggressive_memorandum_rows).to_excel(writer, sheet_name="Aggressive_Memorandum", index=False)
        rows_or_empty(audit_evidence_rows).to_excel(writer, sheet_name="Audit_Evidence", index=False)
        rows_or_empty(annual_pit_rows).to_excel(writer, sheet_name="PIT Summary", index=False)
        rows_or_empty(active_source_rows).to_excel(writer, sheet_name="Active Sources", index=False)
        rows_or_empty(candidate_source_rows).to_excel(writer, sheet_name="Candidate Sources", index=False)
        rows_or_empty(source_trust_rows).to_excel(writer, sheet_name="Source Trust", index=False)
        rows_or_empty(no_overpay_audit_v3_rows).to_excel(writer, sheet_name="No Overpay Guard", index=False)
        rows_or_empty(defense_vault_rows).to_excel(writer, sheet_name="Defense Vault", index=False)
        rows_or_empty(advisor_review_pack_rows).to_excel(writer, sheet_name="Advisor Questions", index=False)
        rows_or_empty(nbp_coverage_report_rows).to_excel(writer, sheet_name="NBP Coverage", index=False)
        rows_or_empty(financing_ledger_rows).to_excel(writer, sheet_name="Financing Ledger", index=False)
        rows_or_empty(result_health_check_rows).to_excel(writer, sheet_name="Result Health", index=False)
        rows_or_empty(audit_metadata_rows).to_excel(writer, sheet_name="Audit Metadata", index=False)

    return [out_path]
