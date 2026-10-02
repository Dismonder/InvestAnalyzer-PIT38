from __future__ import annotations

from collections import Counter

from ..models.core import InputBundle, Issue, MergeResult


def reconcile_sources(merge_result: MergeResult, bundle: InputBundle) -> MergeResult:
    ledger = merge_result.ledger
    source_counter = Counter(trade.source_name for trade in ledger.trades_by_id.values())
    event_counter = Counter(event.source_name for event in ledger.events_by_id.values())

    if bundle.broker_json_path is None or not bundle.broker_json_path.exists():
        ledger.issues.append(
            Issue(
                code="BROKER_JSON_NOT_SUPPLIED",
                severity="INFO",
                stage="RECONCILE",
                scope_type="ENGINE",
                scope_id="broker_json",
                message="Nie dodano pliku JSON brokera, więc kontrola bez warstwy zbiorczej nie została wykonana. Sprawdź pliki w Dokumenty i silnik.",
                blocking=False,
            )
        )

    if bundle.broker_xml_path is None:
        ledger.issues.append(
            Issue(
                code="BROKER_XML_NOT_SUPPLIED",
                severity="INFO",
                stage="RECONCILE",
                scope_type="ENGINE",
                scope_id="broker_xml",
                message="Nie dodano pliku XML brokera, więc pominięto kontrolę zgodności XML. Sprawdź pliki w Dokumenty i silnik.",
                blocking=False,
            )
        )

    merge_result.reconciliation_summary.update(
        {
            "trade_sources": dict(source_counter),
            "event_sources": dict(event_counter),
            "broker_json_supplied": bool(bundle.broker_json_path and bundle.broker_json_path.exists()),
            "broker_xml_supplied": bool(bundle.broker_xml_path and bundle.broker_xml_path.exists()),
        }
    )
    merge_result.canonical_dataset = merge_result.canonical_dataset.__class__(
        trades=merge_result.canonical_dataset.trades,
        events=merge_result.canonical_dataset.events,
        issues=tuple(ledger.issues),
        metadata={**merge_result.canonical_dataset.metadata, **merge_result.reconciliation_summary},
    )
    return merge_result
