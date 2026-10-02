from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from ..interfaces.parsers import Parser


class BrokerReportJsonParser(Parser):
    source_name = "BROKER_REPORT_JSON"

    TRADE_SECTIONS = {"trades"}
    EVENT_SECTIONS = {
        "commissions",
        "cash_flows",
        "cash_in_outs",
    }
    REVIEW_SECTIONS = {
        "corporate_actions",
        "securities_in_outs",
    }

    def parse(self, path: Path) -> list[dict[str, Any]]:
        if not path.exists():
            return []
        payload = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(payload, dict):
            return []

        rows: list[dict[str, Any]] = []
        for section_name in self.TRADE_SECTIONS:
            rows.extend(self._section_rows(payload.get(section_name), section_name, "FRESH_BROKER_REPORT_TRADE"))
        for section_name in self.EVENT_SECTIONS:
            rows.extend(self._section_rows(payload.get(section_name), section_name, "FRESH_BROKER_REPORT_EVENT"))
        for section_name in self.REVIEW_SECTIONS:
            rows.extend(self._section_rows(payload.get(section_name), section_name, "FRESH_BROKER_REPORT_REVIEW"))
        return rows

    def _section_rows(self, value: object, section_name: str, row_type: str) -> list[dict[str, Any]]:
        flattened = self._flatten(value)
        rows: list[dict[str, Any]] = []
        for index, row in enumerate(flattened):
            if not isinstance(row, dict):
                continue
            enriched = dict(row)
            enriched["broker_report_section"] = section_name
            enriched["broker_report_row_type"] = row_type
            enriched.setdefault("source_section", section_name)
            enriched.setdefault("source_row_type", row_type)
            enriched.setdefault("source_row_index", index)
            rows.append(enriched)
        return rows

    def _flatten(self, value: object) -> list[object]:
        if isinstance(value, list):
            rows: list[object] = []
            for item in value:
                rows.extend(self._flatten(item))
            return rows
        if isinstance(value, dict):
            if any(isinstance(inner, list) for inner in value.values()):
                rows: list[object] = []
                for inner in value.values():
                    rows.extend(self._flatten(inner))
                return rows
            return [value]
        return []
