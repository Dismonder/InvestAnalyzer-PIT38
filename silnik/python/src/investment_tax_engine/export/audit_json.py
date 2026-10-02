from __future__ import annotations

import json
import re
from html import escape
from dataclasses import asdict, is_dataclass
from decimal import Decimal
from pathlib import Path
from typing import Any

import pandas as pd

from ..models.core import EngineRunResult
from .komorki import ramka_bezpieczna
from .fifo_view import fifo_rows_as_dicts


EMAIL_RE = re.compile(r"([A-Z0-9._%+-]+)@([A-Z0-9.-]+\.[A-Z]{2,})", re.IGNORECASE)
PHONE_RE = re.compile(r"(?<!\w)(?:\+?\d[\d\s().-]{6,}\d)(?!\w)")

# Ciagi cyfr, ktore wygladaja jak numer telefonu, ale nim nie sa. Bez tego
# wyjatku redakcja zamazywala daty i kwoty w calym pakiecie dowodowym, czyli
# dokladnie te wartosci, ktore maja skladac sie na slad audytowy.
_ISO_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?)?$")
# Bez wiodacego plusa: sam ciag cyfr to identyfikator transakcji albo kwota,
# natomiast prefiks "+" jest mocna przeslanka numeru w formacie miedzynarodowym.
_DECIMAL_RE = re.compile(r"^-?\d+(?:[.,]\d+)?$")


def _looks_like_phone_number(candidate: str) -> bool:
    """Czy ciag jest numerem telefonu, a nie data albo kwota."""
    trimmed = candidate.strip()
    if _ISO_DATE_RE.match(trimmed) or _DECIMAL_RE.match(trimmed):
        return False
    # Numer telefonu ma od 9 do 15 cyfr (E.164). Krotsze i dluzsze ciagi cyfr
    # to w tym zbiorze identyfikatory transakcji albo kwoty.
    digits = sum(1 for char in trimmed if char.isdigit())
    return 9 <= digits <= 15


# Pelne nazwy pol, ktore niosa dane osobowe. Wczesniej byla to lista podciagow
# dopasowywanych bez granicy slowa, przez co "name" trafialo w source_name,
# plan_name, scenario_name i instrument_name, a "document" w
# require_documented_cost_evidence. Maskowany byl wiec slad dowodowy - z ktorego
# pliku pochodzi transakcja i ktory wariant rozliczenia dal ten wynik - czyli
# dokladnie to, po co pakiet audytowy powstaje.
SENSITIVE_KEY_NAMES = {
    "name",
    "full_name",
    "first_name",
    "last_name",
    "middle_name",
    "client_name",
    "account_holder",
    "account_holder_name",
    "owner_name",
    "phone",
    "phone_number",
    "email",
    "email_address",
    "document_number",
    "id_document",
    "passport",
    "passport_number",
    "identity_number",
    "national_id",
    "personal_id",
    "pesel",
    "nip",
    "address",
    "street",
    "postal_code",
}


def redact_string(value: str) -> str:
    redacted = EMAIL_RE.sub("***@***", value)
    return PHONE_RE.sub(
        lambda match: "***" if _looks_like_phone_number(match.group(0)) else match.group(0),
        redacted,
    )


def _is_sensitive_key(key: object) -> bool:
    return str(key).lower().replace("-", "_") in SENSITIVE_KEY_NAMES


def redact_payload(value: Any, enabled: bool) -> Any:
    if not enabled:
        return value
    if isinstance(value, str):
        return redact_string(value)
    if isinstance(value, list):
        return [redact_payload(item, enabled) for item in value]
    if isinstance(value, tuple):
        return [redact_payload(item, enabled) for item in value]
    if isinstance(value, dict):
        return {
            # bool dziedziczy po int, wiec bez tego wyjatku flaga polityki
            # kosztowej zamienialaby sie w "***" i wygladala na dana wrazliwa.
            key: (
                "***"
                if _is_sensitive_key(key) and isinstance(item, (str, int, float)) and not isinstance(item, bool)
                else redact_payload(item, enabled)
            )
            for key, item in value.items()
        }
    return value


class DecimalEncoder(json.JSONEncoder):
    def default(self, obj: Any) -> Any:
        if isinstance(obj, Decimal):
            return str(obj)
        if isinstance(obj, pd.Timestamp):
            return obj.isoformat()
        if isinstance(obj, set):
            return sorted(obj)
        if is_dataclass(obj):
            return asdict(obj)
        return super().default(obj)


def write_json(path: Path, payload: Any) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, cls=DecimalEncoder, indent=2), encoding="utf-8")
    return path


def write_text(path: Path, payload: str) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(payload, encoding="utf-8")
    return path


def write_jsonl(path: Path, payload: list[Any], *, redact: bool) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as handle:
        for item in payload:
            handle.write(json.dumps(redact_payload(item, redact), cls=DecimalEncoder, ensure_ascii=False) + "\n")
    return path


def markdown_to_basic_html(markdown: str) -> str:
    lines = []
    for raw_line in markdown.splitlines():
        line = escape(raw_line)
        if line.startswith("# "):
            lines.append(f"<h1>{line[2:]}</h1>")
        elif line.startswith("## "):
            lines.append(f"<h2>{line[3:]}</h2>")
        elif line.startswith("- "):
            lines.append(f"<p>• {line[2:]}</p>")
        elif line.strip():
            lines.append(f"<p>{line}</p>")
        else:
            lines.append("")
    return "<!doctype html><html><head><meta charset=\"utf-8\"><title>Tax advisor brief</title></head><body>" + "\n".join(lines) + "</body></html>"


def export_audit_json(
    result: EngineRunResult,
    output_dir: Path,
    *,
    additional_artifacts: list[Path] | None = None,
) -> list[Path]:
    audit_dir = output_dir / "audit"
    redact = result.config.pii_redaction_enabled
    payloads = {
        audit_dir / "silnik_run_result.json": {
            "status": result.status,
            "filing_ready": result.filing_ready,
            "config": asdict(result.config),
            "plan_used": result.plan_used,
            "filing_profile": result.filing_profile,
            "primary_scenario": result.primary_scenario,
            "audit_hash": result.audit_hash,
            "performance_profile": result.performance_profile,
            "quality_report": asdict(result.quality_report) if result.quality_report else None,
        },
        audit_dir / "ledger.json": {
            "trades": {key: asdict(value) for key, value in result.merge_result.ledger.trades_by_id.items()},
            "events": {key: asdict(value) for key, value in result.merge_result.ledger.events_by_id.items()},
        },
        audit_dir / "issues.json": [asdict(issue) for issue in result.merge_result.ledger.issues],
        audit_dir / "actionable_issues.json": [asdict(issue) for issue in result.actionable_issues],
        audit_dir / "informational_issues.json": [asdict(issue) for issue in result.informational_issues],
        audit_dir / "fifo_rows.json": fifo_rows_as_dicts(result.fifo_rows, result.config.tax_year),
        audit_dir / "annual_summary.json": result.annual_summary,
        audit_dir / "scenarios.json": {name: asdict(value) for name, value in result.scenario_results.items()},
        audit_dir / "private_cash_fx.json": [asdict(row) for row in result.private_cash_fx_view],
        audit_dir / "cost_items.json": [asdict(item) for item in result.cost_items],
        audit_dir / "cost_policy_decisions.json": [asdict(item) for item in result.cost_decisions],
        audit_dir / "funding_fee_allocations.json": [asdict(item) for item in result.funding_fee_allocations],
        audit_dir / "transaction_history_rows.json": [asdict(item) for item in result.transaction_history_rows],
        audit_dir / "quality_report.json": asdict(result.quality_report) if result.quality_report else {},
        audit_dir / "fx_coverage.json": [asdict(row) for row in result.fx_coverage_gaps],
        audit_dir / "depo_reconciliation.json": result.depo_reconciliation,
    }
    if result.tax_filing_package is not None:
        payloads[audit_dir / "tax_filing_package.json"] = asdict(result.tax_filing_package)
    written_paths = [write_json(path, redact_payload(payload, redact)) for path, payload in payloads.items()]
    if result.tax_filing_package is not None and result.tax_filing_package.audit_appendix:
        memorandum = result.tax_filing_package.audit_appendix.get("memorandum_aggressive_user")
        if memorandum:
            memorandum_text = redact_string(str(memorandum)) if redact else str(memorandum)
            written_paths.append(write_text(audit_dir / "memorandum_aggressive_user.md", memorandum_text))
        advisor_brief = result.tax_filing_package.audit_appendix.get("tax_advisor_brief")
        if isinstance(advisor_brief, dict) and advisor_brief:
            redacted_brief = redact_payload(advisor_brief, redact)
            written_paths.append(write_json(audit_dir / "tax_advisor_brief.json", redacted_brief))
            markdown = redacted_brief.get("markdown") if isinstance(redacted_brief, dict) else None
            if markdown:
                markdown_text = str(markdown)
                written_paths.append(write_text(audit_dir / "tax_advisor_brief.md", markdown_text))
                written_paths.append(write_text(output_dir / "tax_advisor_brief.md", markdown_text))
                written_paths.append(write_text(output_dir / "tax_advisor_brief.html", markdown_to_basic_html(markdown_text)))
        advisor_review_pack = result.tax_filing_package.audit_appendix.get("advisor_review_pack")
        if isinstance(advisor_review_pack, dict) and advisor_review_pack:
            written_paths.append(write_json(output_dir / "advisor_review_pack.json", redact_payload(advisor_review_pack, redact)))
        defense_vault = result.tax_filing_package.audit_appendix.get("defense_vault_summary")
        if isinstance(defense_vault, dict) and defense_vault:
            evidence_items = defense_vault.get("items") or []
            redacted_evidence = redact_payload(evidence_items, redact)
            written_paths.append(write_json(output_dir / "evidence_checklist.json", redacted_evidence))
            checklist_xlsx = output_dir / "evidence_checklist.xlsx"
            ramka_bezpieczna(redacted_evidence).to_excel(checklist_xlsx, index=False)
            written_paths.append(checklist_xlsx)
        transaction_artifacts = {
            "source_registry.json": result.tax_filing_package.audit_appendix.get("source_registry"),
            "normalized_storage_manifest.json": result.tax_filing_package.audit_appendix.get("normalized_storage_manifest"),
            "transaction_dossiers.json": result.tax_filing_package.audit_appendix.get("transaction_dossiers"),
            "transaction_conflicts.json": result.tax_filing_package.audit_appendix.get("transaction_conflicts"),
            "evidence_index.json": result.tax_filing_package.audit_appendix.get("evidence_index"),
            "field_source_map.json": result.tax_filing_package.audit_appendix.get("field_source_map"),
            "ai_document_classification.json": result.tax_filing_package.audit_appendix.get("ai_document_classification"),
            "ai_column_mappings.json": result.tax_filing_package.audit_appendix.get("ai_column_mappings"),
            "ai_validation_report.json": result.tax_filing_package.audit_appendix.get("ai_validation_report"),
            "canonical_storage_history.json": result.tax_filing_package.audit_appendix.get("canonical_storage_history_rows"),
            "storage_lineage_index.json": result.tax_filing_package.audit_appendix.get("storage_lineage_index"),
            "canonical_tax_input.json": result.tax_filing_package.audit_appendix.get("canonical_tax_input"),
            "canonical_tax_input_summary.json": result.tax_filing_package.audit_appendix.get("canonical_tax_input_summary"),
            "tax_input_build_report.json": result.tax_filing_package.audit_appendix.get("tax_input_build_report"),
        }
        for filename, payload in transaction_artifacts.items():
            if payload:
                written_paths.append(write_json(output_dir / filename, redact_payload(payload, redact)))
        normalized_events = result.tax_filing_package.audit_appendix.get("normalized_events")
        if isinstance(normalized_events, list) and normalized_events:
            written_paths.append(write_jsonl(output_dir / "normalized_events.jsonl", normalized_events, redact=redact))
        ai_context = result.tax_filing_package.audit_appendix.get("ai_extracted_context")
        if isinstance(ai_context, list):
            written_paths.append(write_jsonl(output_dir / "ai_extracted_context.jsonl", ai_context, redact=redact))
    manifest_payload = {
        "audit_hash": result.audit_hash,
        "filing_ready": result.filing_ready,
        "result_health_status": (
            (result.tax_filing_package.audit_appendix.get("result_health_check") or {}).get("status")
            if result.tax_filing_package is not None and result.tax_filing_package.audit_appendix
            else None
        ),
        "tax_advisor_brief": bool(
            result.tax_filing_package is not None
            and result.tax_filing_package.audit_appendix
            and result.tax_filing_package.audit_appendix.get("tax_advisor_brief")
        ),
        "artifacts": [str(path) for path in [*written_paths, *(additional_artifacts or [])]],
    }
    written_paths.append(write_json(audit_dir / "artifacts_manifest.json", redact_payload(manifest_payload, redact)))
    return written_paths
