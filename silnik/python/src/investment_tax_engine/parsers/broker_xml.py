from __future__ import annotations

import xml.etree.ElementTree as ET
from pathlib import Path
from typing import Any

from ..interfaces.parsers import Parser


class BrokerXmlParser(Parser):
    source_name = "BROKER_XML"

    def parse(self, path: Path) -> list[dict[str, Any]]:
        if not path.exists():
            return []

        root = ET.fromstring(path.read_text(encoding="utf-8"))
        rows: list[dict[str, Any]] = []
        for node in root.findall(".//node"):
            row: dict[str, Any] = {}
            for child in node:
                row[child.tag] = child.text
            if row:
                rows.append(row)
        return rows
