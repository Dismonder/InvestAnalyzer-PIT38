from __future__ import annotations

import json
from dataclasses import dataclass, field
from hashlib import sha256
from pathlib import Path
from typing import Any, Iterable

import pandas as pd
from .spreadsheet_safety import validate_spreadsheet_zip


BROKER_REPORT_SECTIONS = {
    "trades",
    "cash_flows",
    "cash_in_outs",
    "commissions",
    "corporate_actions",
    "securities_in_outs",
    "in_outs_securities",
}
DEPOSITARY_SECTIONS = {"depoData", "depo_at_end", "mkt_prices", "securities_flows", "depo_at_start"}
IGNORED_DIRS = {"node_modules", "wydania", "out", "backups", ".pytest_cache", ".venv", "__pycache__"}


@dataclass
class BrokerStorageResolvedSource:
    source_id: str
    filename: str
    relative_path: str
    path: str
    role: str
    detected_type: str
    score: int
    reason: str
    hash: str = ""
    sections: list[str] = field(default_factory=list)
    record_counts: dict[str, int] = field(default_factory=dict)
    date_range: dict[str, str | None] = field(default_factory=lambda: {"from": None, "to": None})
    warnings: list[str] = field(default_factory=list)
    errors: list[str] = field(default_factory=list)

    def to_manifest_dict(self) -> dict[str, Any]:
        return {
            "sourceId": self.source_id,
            "filename": self.filename,
            "relativePath": self.relative_path,
            "hash": self.hash,
            "detectedType": self.detected_type,
            "sections": list(self.sections),
            "recordCounts": dict(self.record_counts),
            "dateRange": dict(self.date_range),
            "contributesToCanonicalInput": True,
            # Bez tego pola `_build_result_health_check` nie widzialo zadnego
            # zrodla podatkowego (`source.get("contributesToTax") is True`),
            # wiec kontrola zaufania pokazywala zero zrodel obok rozliczenia
            # policzonego z wyciagow brokera.
            "contributesToTax": self.role == "transaction_source",
            "warnings": list(self.warnings),
            "errors": list(self.errors),
            "sourceResolutionRole": self.role,
            "sourceResolutionReason": self.reason,
            "sourceResolutionScore": self.score,
        }

    def to_preview_dict(self) -> dict[str, Any]:
        return {
            "sourceId": self.source_id,
            "filename": self.filename,
            "relativePath": self.relative_path,
            "role": self.role,
            "detectedType": self.detected_type,
            "score": self.score,
            "reason": self.reason,
            "hash": self.hash,
            "sections": list(self.sections),
            "recordCounts": dict(self.record_counts),
            "dateRange": dict(self.date_range),
            "warnings": list(self.warnings),
            "errors": list(self.errors),
        }


@dataclass
class BrokerStorageResolution:
    storage_dir: str
    mode: str
    sources: list[BrokerStorageResolvedSource]
    # Pliki wylaczone przez uzytkownika. Zmieniaja wynik, wiec pakiet dowodowy
    # musi je wymieniac - inaczej nie da sie wyjasnic, czemu kwota jest inna.
    excluded_files: list[str] = field(default_factory=list)
    # Pliki pominiete jako kopia innego pliku o identycznej zawartosci. Nie sa
    # bledem - policzenie obu podwoiloby podatek - ale ich brak w mapie zrodel
    # trzeba umiec wyjasnic, wiec wedruja osobno razem z oryginalem.
    duplicate_files: list[dict[str, str]] = field(default_factory=list)

    def to_audit_dict(self) -> dict[str, Any]:
        transaction_sources = [
            source
            for source in self.sources
            if source.role in {"transaction_source", "transaction_report"}
        ]
        return {
            "storageDir": self.storage_dir,
            "mode": self.mode,
            "activePolicy": "canonical_stream",
            "summary": {
                "sourceCount": len(self.sources),
                "transactionSourceCount": len(transaction_sources),
                "contextSourceCount": len([source for source in self.sources if source.role in {"evidence", "analytics", "reconciliation", "data_context", "nbp_rates"}]),
                "excludedFileCount": len(self.excluded_files),
                "duplicateFileCount": len(self.duplicate_files),
            },
            "excludedFiles": list(self.excluded_files),
            "duplicateFiles": list(self.duplicate_files),
            "transactionSources": [source.to_preview_dict() for source in transaction_sources],
            "sources": [source.to_preview_dict() for source in sorted(self.sources, key=lambda source: (source.role, source.filename))],
            "recommendedActions": [],
        }

    def to_source_manifest_entries(self) -> list[dict[str, Any]]:
        return [source.to_manifest_dict() for source in self.sources]


def _file_hash(path: Path) -> str:
    if not path.exists() or not path.is_file():
        return ""
    digest = sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _source_id(path: Path, storage_dir: Path) -> str:
    try:
        relative = path.relative_to(storage_dir)
    except ValueError:
        relative = path.name
    return f"storage:{sha256(str(relative).lower().encode('utf-8')).hexdigest()[:12]}"


def _safe_relative(path: Path, storage_dir: Path) -> str:
    try:
        return str(path.relative_to(storage_dir)).replace("\\", "/")
    except ValueError:
        return path.name


def _date_range(values: list[Any]) -> dict[str, str | None]:
    dates: list[pd.Timestamp] = []
    for value in values:
        if value is None or value == "":
            continue
        try:
            timestamp = pd.Timestamp(value)
        except Exception:
            continue
        if not pd.isna(timestamp):
            dates.append(timestamp.normalize())
    if not dates:
        return {"from": None, "to": None}
    return {"from": str(min(dates).date()), "to": str(max(dates).date())}


def _collect_json_dates(payload: Any) -> list[Any]:
    keys = {"date", "executed_at", "exchange_time", "settlement_date", "date_start", "date_end", "pay_d", "trade_d_exch"}
    dates: list[Any] = []

    def visit(value: Any) -> None:
        if isinstance(value, dict):
            for key, inner in value.items():
                if key in keys:
                    dates.append(inner)
                if isinstance(inner, (dict, list)):
                    visit(inner)
        elif isinstance(value, list):
            for item in value[:5000]:
                visit(item)

    visit(payload)
    return dates


def _flatten_json_lists(value: Any) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    if isinstance(value, list):
        rows.extend(item for item in value if isinstance(item, dict))
    elif isinstance(value, dict):
        for inner in value.values():
            rows.extend(_flatten_json_lists(inner))
    return rows


def _json_source(path: Path, storage_dir: Path) -> BrokerStorageResolvedSource:
    errors: list[str] = []
    warnings: list[str] = []
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except Exception as exc:
        # Nazwy tych eksportow identyfikuja historie nawet wtedy, gdy tresc
        # jest uszkodzona. Czytnik ponowi odczyt i zglosi blad do bramki.
        known_history = {
            "historia_transakcji.json": "legacy_broker_history_json",
            "pelny_zrzut_api_transakcje.json": "local_broker_history_json",
        }
        history_type = known_history.get(path.name.lower())
        return _base_source(
            path,
            storage_dir,
            detected_type=history_type or "json_unreadable",
            role="transaction_source" if history_type else "evidence",
            score=0,
            reason=f"Plik JSON nie został sparsowany: {exc}",
            errors=[str(exc)],
        )

    sections = list(payload.keys()) if isinstance(payload, dict) else []
    rows = _flatten_json_lists(payload)
    keys = set(sections)
    date_range = _date_range(_collect_json_dates(payload))

    if isinstance(payload, list):
        detected_type = "legacy_broker_history_json"
        if path.name.lower() == "historia_transakcji.json":
            role = "transaction_source"
            score = 80
            reason = "Plik historii transakcji rozpoznany jako źródło rekordów."
        elif path.name.lower() == "pelny_zrzut_api_transakcje.json":
            detected_type = "local_broker_history_json"
            role = "transaction_source"
            score = 70
            reason = "Zrzut lokalny rozpoznany jako źródło rekordów."
        else:
            role = "data_context"
            score = 45
            reason = "Lista JSON traktowana jako źródło zapasowe lub dowód."
    elif keys & DEPOSITARY_SECTIONS:
        detected_type = "depositary_report_json"
        role = "reconciliation"
        score = 65 + len(keys & DEPOSITARY_SECTIONS) * 5
        reason = "Raport depozytariusza służy do kontroli pozycji i diagnostyki."
    elif "trades" in keys and keys.intersection(BROKER_REPORT_SECTIONS - {"trades"}):
        detected_type = "broker_report_json"
        role = "transaction_source"
        score = 100 + len(keys & BROKER_REPORT_SECTIONS) * 8
        reason = "Raport brokera rozpoznany jako źródło rekordów do danych kanonicznych."
    else:
        detected_type = "json"
        role = "data_context"
        score = 35
        reason = "Plik JSON rozpoznany jako źródło zapasowe lub materiał dowodowy."

    return _base_source(
        path,
        storage_dir,
        detected_type=detected_type,
        role=role,
        score=score,
        reason=reason,
        sections=sections,
        record_counts={
            "rows": len(rows),
            "sections": len(sections),
            "trades": _count_json_section(payload, "trades"),
            "cash_flows": _count_json_section(payload, "cash_flows"),
            "cash_in_outs": _count_json_section(payload, "cash_in_outs"),
        },
        date_range=date_range,
        warnings=warnings,
        errors=errors,
    )


def _liczba_zapisow(record_counts: dict[str, int]) -> int:
    """JSON podaje "rows"; arkusze XLSX/CSV - liczbe wierszy per arkusz albo "csv"."""
    if "rows" in record_counts:
        return int(record_counts["rows"] or 0)
    return sum(int(value or 0) for key, value in record_counts.items() if key != "sections")


def _count_json_section(payload: Any, section: str) -> int:
    if not isinstance(payload, dict) or section not in payload:
        return 0
    return len(_flatten_json_lists(payload[section]))


def _spreadsheet_source(path: Path, storage_dir: Path) -> BrokerStorageResolvedSource:
    lower = path.name.lower()
    if "traderzy" in lower:
        detected_type = "traders_xlsx"
        role = "analytics"
        score = 25
        reason = "Plik podsumowujący brokera; dowód/analityka, bez tworzenia transakcji."
    elif "ruchy" in lower or "got" in lower or "tradernet_table" in lower:
        detected_type = "cash_flows_xlsx"
        role = "data_context"
        score = 70 if "tradernet_tablev1" in lower else 55
        reason = "Arkusz ruchów gotówki rozpoznany jako źródło rekordów pomocniczych."
    elif "transakcje" in lower or "trades" in lower:
        detected_type = "broker_transactions_xlsx"
        role = "transaction_source"
        score = 75 if "tradesv1" in lower or "trades (1)" in lower else 60
        reason = "Arkusz transakcji rozpoznany jako źródło rekordów."
    elif "archiwum_tab_a" in lower:
        detected_type = "nbp_archive"
        role = "nbp_rates"
        score = 90
        reason = "Archiwum kursów NBP rozpoznane jako źródło danych walutowych."
    else:
        detected_type = "spreadsheet"
        role = "data_context"
        score = 25
        reason = "Arkusz rozpoznany jako źródło zapasowe lub dowód."

    record_counts: dict[str, int] = {}
    sections: list[str] = []
    date_range = {"from": None, "to": None}
    warnings: list[str] = []
    if path.suffix.lower() == ".csv":
        try:
            preview = pd.read_csv(path, nrows=500)
            sections = ["csv"]
            record_counts["csv"] = int(len(preview.index))
            date_values: list[Any] = []
            for column in preview.columns:
                if str(column).lower() in {"data", "date", "execution time", "czas", "trade date"}:
                    date_values.extend(preview[column].dropna().tolist())
            date_range = _date_range(date_values)
        except Exception as exc:
            warnings.append(f"Nie odczytano podgladu CSV: {exc}")
        return _base_source(
            path,
            storage_dir,
            detected_type=detected_type,
            role=role,
            score=score,
            reason=reason,
            sections=sections,
            record_counts=record_counts,
            date_range=date_range,
            warnings=warnings,
        )
    try:
        validate_spreadsheet_zip(path)
        excel = pd.ExcelFile(path)
        sections = list(excel.sheet_names)
        for sheet_name in sections[:8]:
            preview = pd.read_excel(path, sheet_name=sheet_name, nrows=500)
            record_counts[sheet_name] = int(len(preview.index))
            date_values: list[Any] = []
            for column in preview.columns:
                if str(column).lower() in {"data", "date", "execution time", "czas", "trade date"}:
                    date_values.extend(preview[column].dropna().tolist())
            sheet_range = _date_range(date_values)
            if sheet_range["from"] or sheet_range["to"]:
                date_range = _merge_ranges(date_range, sheet_range)
    except Exception as exc:
        warnings.append(f"Nie odczytano podgladu arkusza: {exc}")

    return _base_source(
        path,
        storage_dir,
        detected_type=detected_type,
        role=role,
        score=score,
        reason=reason,
        sections=sections,
        record_counts=record_counts,
        date_range=date_range,
        warnings=warnings,
    )


def _merge_ranges(left: dict[str, str | None], right: dict[str, str | None]) -> dict[str, str | None]:
    starts = [value for value in [left.get("from"), right.get("from")] if value]
    ends = [value for value in [left.get("to"), right.get("to")] if value]
    return {"from": min(starts) if starts else None, "to": max(ends) if ends else None}


def _base_source(
    path: Path,
    storage_dir: Path,
    *,
    detected_type: str,
    role: str,
    score: int,
    reason: str,
    sections: list[str] | None = None,
    record_counts: dict[str, int] | None = None,
    date_range: dict[str, str | None] | None = None,
    warnings: list[str] | None = None,
    errors: list[str] | None = None,
) -> BrokerStorageResolvedSource:
    return BrokerStorageResolvedSource(
        source_id=_source_id(path, storage_dir),
        filename=path.name,
        relative_path=_safe_relative(path, storage_dir),
        path=str(path),
        role=role,
        detected_type=detected_type,
        score=score,
        reason=reason,
        hash=_file_hash(path),
        sections=sections or [],
        record_counts=record_counts or {},
        date_range=date_range or {"from": None, "to": None},
        warnings=warnings or [],
        errors=errors or [],
    )


def _pdf_source(path: Path, storage_dir: Path) -> BrokerStorageResolvedSource:
    return _base_source(
        path,
        storage_dir,
        detected_type="fee_schedule_pdf",
        role="evidence",
        score=30,
        reason="PDF z taryfą/prowizjami jest dowodem, nie źródłem kalkulacji.",
    )


def _iter_storage_files(storage_dir: Path) -> list[Path]:
    files: list[Path] = []
    for path in storage_dir.rglob("*"):
        if not path.is_file():
            continue
        parts = {part.lower() for part in path.relative_to(storage_dir).parts[:-1]}
        if parts & IGNORED_DIRS:
            continue
        if path.name.startswith("."):
            continue
        files.append(path)
    return sorted(files, key=lambda item: str(item).lower())


def normalize_excluded_files(values: Iterable[str] | None) -> set[str]:
    """Nazwy wylaczonych plikow w postaci porownywalnej ze sciezka wzgledna.

    Uzytkownik wskazuje plik z listy w aplikacji, wiec dostajemy raz sama nazwe,
    raz sciezke z podkatalogiem i raz z ukosnikami w druga strone. Porownanie
    dziala na malych literach i ukosnikach uniksowych; dopuszczamy tez sama
    nazwe pliku, zeby wylaczenie z listy dzialalo bez znajomosci podkatalogu.
    """
    normalized: set[str] = set()
    for value in values or ():
        text = str(value or "").strip().replace("\\", "/").strip("/")
        if text:
            normalized.add(text.lower())
    return normalized


def _is_excluded(relative_path: str, excluded: set[str]) -> bool:
    if not excluded:
        return False
    normalized = relative_path.replace("\\", "/").strip("/").lower()
    return normalized in excluded or normalized.rsplit("/", 1)[-1] in excluded


def resolve_storage_sources(
    storage_dir: Path,
    *,
    mode: str = "legacy_locked",
    excluded_files: Iterable[str] | None = None,
) -> BrokerStorageResolution:
    """Pliki magazynu w rolach zrodel; `excluded_files` wylacza wskazane z rozliczenia.

    Wylaczenie pliku bylo dotad wylacznie ozdoba interfejsu: przelacznik zmienial
    stan Reacta i wymuszal pelne przeliczenie tym samym zestawem plikow. Zeby
    decyzja uzytkownika cokolwiek znaczyla, musi dojsc az tutaj - i zostac
    zapisana w audycie, bo zmienia wynik podatkowy.
    """
    excluded = normalize_excluded_files(excluded_files)
    if not storage_dir.exists():
        return BrokerStorageResolution(
            storage_dir=str(storage_dir), mode=mode, sources=[], excluded_files=sorted(excluded)
        )

    sources: list[BrokerStorageResolvedSource] = []
    skipped: list[str] = []
    duplikaty: list[dict[str, str]] = []
    # Ten sam wyciag wgrany pod dwiema nazwami liczyl sie dwa razy: przychod
    # i koszt rosly dwukrotnie, a wraz z nimi podatek. Plik o identycznej
    # zawartosci pomijamy - ale tylko wtedy, gdy faktycznie niesie zapisy.
    # Dwa puste pliki nie maja czego podwoic, a ich pomijanie mylilo obraz
    # magazynu. O pominieciu mowi ostrzezenie przy pliku, ktory zostal przyjety,
    # wiec duplikat nie znika po cichu.
    przyjete_po_sumie: dict[str, BrokerStorageResolvedSource] = {}
    for path in _iter_storage_files(storage_dir):
        relative_path = path.relative_to(storage_dir).as_posix()
        if _is_excluded(relative_path, excluded):
            skipped.append(relative_path)
            continue
        suffix = path.suffix.lower()
        if suffix == ".json":
            zrodlo = _json_source(path, storage_dir)
        elif suffix in {".xlsx", ".xls", ".csv"}:
            zrodlo = _spreadsheet_source(path, storage_dir)
        elif suffix == ".pdf":
            zrodlo = _pdf_source(path, storage_dir)
        else:
            zrodlo = _base_source(
                path,
                storage_dir,
                detected_type=suffix.lstrip(".") or "unknown",
                role="data_context",
                score=10,
                reason="Plik rozpoznany tylko jako materiał pomocniczy.",
            )

        suma_kontrolna = zrodlo.hash or _file_hash(path)
        # Liczy sie liczba wierszy, a nie liczba sekcji: pusty wyciag ma jedna
        # sekcje i zero zapisow, wiec nie ma czego podwoic.
        niesie_zapisy = _liczba_zapisow(zrodlo.record_counts) > 0
        pierwszy = przyjete_po_sumie.get(suma_kontrolna) if suma_kontrolna else None
        if pierwszy is not None and niesie_zapisy:
            priorytet = lambda source: (
                source.role in {"transaction_source", "transaction_report"},
                source.score,
            )
            if priorytet(zrodlo) > priorytet(pierwszy):
                pierwszy.warnings.append(
                    f"Pominieto plik {pierwszy.relative_path} - ma identyczna zawartosc jak "
                    f"{relative_path}. Zachowano zrodlo o wyzszej wiarygodnosci."
                )
                duplikaty.append({"file": pierwszy.relative_path, "duplicate_of": relative_path})
                sources.remove(pierwszy)
                sources.append(zrodlo)
                przyjete_po_sumie[suma_kontrolna] = zrodlo
                continue
            pierwszy.warnings.append(
                f"Pominieto plik {relative_path} - ma identyczna zawartosc jak "
                f"{pierwszy.relative_path}. Policzenie obu podwoiloby transakcje."
            )
            duplikaty.append({"file": relative_path, "duplicate_of": pierwszy.relative_path})
            continue

        if suma_kontrolna and niesie_zapisy and pierwszy is None:
            przyjete_po_sumie[suma_kontrolna] = zrodlo
        sources.append(zrodlo)
    return BrokerStorageResolution(
        storage_dir=str(storage_dir),
        mode=mode,
        sources=sources,
        excluded_files=sorted(skipped),
        duplicate_files=duplikaty,
    )
