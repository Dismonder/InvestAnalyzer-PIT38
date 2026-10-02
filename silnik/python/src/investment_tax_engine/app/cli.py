from __future__ import annotations

import argparse
import json
import os
import re
import sys
import traceback
from dataclasses import asdict
from decimal import Decimal, InvalidOperation
from pathlib import Path

import pandas as pd

from investment_tax_engine import __version__ as ENGINE_VERSION
from investment_tax_engine.app.engine import InvestmentTaxEngine
from investment_tax_engine.app.canonical_storage_history import build_canonical_storage_history
from investment_tax_engine.app.source_resolver import (
    _is_excluded,
    normalize_excluded_files,
    resolve_storage_sources,
)
from investment_tax_engine.storage import (
    build_canonical_tax_input,
    build_tax_input_build_report,
    build_transaction_intelligence,
    write_transaction_intelligence_outputs,
)
from investment_tax_engine.models.core import (
    BrokerFileActionOverride,
    DefenseEvidenceOverride,
    EngineConfig,
    FundingCostEvent,
    InputBundle,
    PriorYearLoss,
    TaxFilingRequest,
    TransactionOverride,
    UserOverrides,
)


# Kontrakt sidecara. Rust zapisuje request.json i odczytuje result.json albo
# error.json; obie strony odrzucaja plik o niezgodnej nazwie schematu.
REQUEST_CONTRACT_VERSION = "investanalyzer.analysis-request.v1"
RESULT_CONTRACT_VERSION = "investanalyzer.analysis-result.v1"

# Zachowane dla czytelnosci starszych wywolan w obrebie modulu.
CONTRACT_VERSION = RESULT_CONTRACT_VERSION


def env_flag(name: str, *, default: bool = False) -> bool:
    raw_value = os.environ.get(name)
    if raw_value is None:
        return default
    return raw_value.strip().lower() in {"1", "true", "yes", "y", "on"}


def default_storage_dir(args: argparse.Namespace | None = None) -> Path:
    explicit_storage_dir = (getattr(args, "storage_dir", "") or "").strip() if args else ""
    if explicit_storage_dir:
        return Path(explicit_storage_dir)
    for parent in [Path.cwd(), *Path.cwd().parents]:
        candidate = parent / "dane" / "pliki"
        if candidate.exists():
            return candidate
    candidate = Path.cwd().parent / "storage"
    return candidate if candidate.exists() else Path.cwd() / "storage"


class BladDanychWejsciowych(ValueError):
    """Blad we wpisie uzytkownika (ustawienia podatkowe), a nie awaria silnika."""


WSKAZOWKA_BLEDU_WPISU = "Popraw ten wpis w ustawieniach podatkowych („Dokumenty i silnik”) i przelicz ponownie."


def parse_decimal_arg(value: object, *, field_name: str) -> Decimal:
    normalized = str(value).strip().replace("\u00a0", "").replace(" ", "")
    if "," in normalized and "." in normalized:
        if normalized.rfind(",") > normalized.rfind("."):
            normalized = normalized.replace(".", "").replace(",", ".")
        else:
            normalized = normalized.replace(",", "")
    else:
        normalized = normalized.replace(",", ".")

    try:
        return Decimal(normalized)
    except InvalidOperation as exc:
        raise BladDanychWejsciowych(
            f"Nieprawidłowa liczba {value!r} (pole {field_name}) - wpisz samą liczbę, np. 40,50."
        ) from exc


def _rok_z_zadania(payload: dict) -> str:
    """Rok podatkowy z pliku zadania - bez wartosci domyslnej.

    `str(payload.get("year") or "2025")` liczylo caly PIT za 2025 rok, gdy
    zadanie nie podalo roku: filtr transakcji, kursy NBP i reguly braly sie
    z niewlasciwego okresu.
    """
    surowy = str(payload.get("year") or "").strip()
    if not surowy.isdigit():
        raise ValueError(
            "Request file has no tax year (field 'year'); the engine will not assume one."
        )
    return surowy


def _waluta_oplaty(wartosc: object, identyfikator: str) -> str:
    """Waluta oplaty finansowania. Bez niej nie ma kursu NBP.

    `str(payload.get("currency") or "PLN")` znaczylo, ze oplata w dolarach bez
    podanej waluty pomniejszala dochod o te sama liczbe zlotych.
    """
    tekst = str(wartosc or "").strip().upper()
    if not tekst:
        raise BladDanychWejsciowych(
            f"Opłata finansowania {identyfikator} nie ma waluty - bez niej nie da się wybrać kursu NBP. "
            "Wpisz kod waluty, np. PLN albo USD."
        )
    if not re.fullmatch(r"[A-Z]{3}", tekst):
        raise BladDanychWejsciowych(
            f"Opłata finansowania {identyfikator}: waluta {tekst!r} - wpisz trzyliterowy kod, np. PLN albo USD."
        )
    return tekst


# Rok na poczatku jest jednoznaczny takze z ukosnikiem albo kropka (2026/04/03) -
# tak zapisywalo stare pole tekstowe warsztatu.
_DATA_ISO = re.compile(r"(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[T ].*)?")
_DATA_PL = re.compile(r"(\d{1,2})\.(\d{1,2})\.(\d{4})")


def _data_oplaty(wartosc: object, identyfikator: str) -> pd.Timestamp:
    """Data oplaty finansowania wpisana przez uzytkownika.

    `pd.Timestamp("03.04.2026")` daje 4 marca: polski zapis dnia i miesiaca
    czytany po amerykansku przesuwal kurs NBP i okno zakupow sfinansowanych
    oplata. Przyjmujemy tylko formaty jednoznaczne - RRRR-MM-DD i DD.MM.RRRR.
    """
    tekst = str(wartosc or "").strip()
    iso = _DATA_ISO.fullmatch(tekst)
    polska = _DATA_PL.fullmatch(tekst)
    try:
        if iso:
            return pd.Timestamp(int(iso[1]), int(iso[2]), int(iso[3]))
        if polska:
            return pd.Timestamp(int(polska[3]), int(polska[2]), int(polska[1]))
    except ValueError:
        pass
    raise BladDanychWejsciowych(
        f"Opłata finansowania {identyfikator}: data {tekst!r} jest nieczytelna - wpisz ją jako "
        "RRRR-MM-DD, np. 2026-04-03."
    )


def load_defense_evidence_overrides(path: str) -> list[DefenseEvidenceOverride]:
    if not path:
        return []
    overrides_path = Path(path)
    if not overrides_path.exists():
        return []
    raw_payload = json.loads(overrides_path.read_text(encoding="utf-8"))
    if not isinstance(raw_payload, list):
        return []

    allowed_statuses = {"complete", "needs_user_evidence", "missing_link", "high_risk_review"}
    overrides: list[DefenseEvidenceOverride] = []
    for payload in raw_payload:
        if not isinstance(payload, dict):
            continue
        evidence_id = str(payload.get("evidenceId") or payload.get("evidence_id") or "").strip()
        defense_status = str(payload.get("defenseStatus") or payload.get("defense_status") or "").strip()
        if not evidence_id or defense_status not in allowed_statuses:
            continue
        linked_trade_ids = payload.get("linkedTradeIds") or payload.get("linked_trade_ids") or []
        overrides.append(
            DefenseEvidenceOverride(
                evidence_id=evidence_id,
                defense_status=defense_status,
                linked_trade_ids=[str(value) for value in linked_trade_ids] if isinstance(linked_trade_ids, list) else [],
                updated_at=str(payload.get("updatedAt") or payload.get("updated_at") or ""),
                user_note=(
                    str(payload.get("userNote") or payload.get("user_note"))
                    if (payload.get("userNote") or payload.get("user_note")) is not None
                    else None
                ),
                evidence_confirmed=bool(payload.get("evidenceConfirmed") or payload.get("evidence_confirmed") or False),
                checked_at=(
                    str(payload.get("checkedAt") or payload.get("checked_at"))
                    if (payload.get("checkedAt") or payload.get("checked_at")) is not None
                    else None
                ),
                included_in_filing_package=bool(
                    payload.get("includedInFilingPackage") or payload.get("included_in_filing_package") or False
                ),
            )
        )
    return overrides


def load_broker_file_action_overrides(path: str) -> list[BrokerFileActionOverride]:
    if not path:
        return []
    overrides_path = Path(path)
    if not overrides_path.exists():
        return []
    raw_payload = json.loads(overrides_path.read_text(encoding="utf-8"))
    if not isinstance(raw_payload, list):
        return []

    allowed_statuses = {"open", "resolved", "ignored"}
    overrides: list[BrokerFileActionOverride] = []
    for payload in raw_payload:
        if not isinstance(payload, dict):
            continue
        action_id = str(payload.get("actionId") or payload.get("action_id") or "").strip()
        status = str(payload.get("status") or "").strip()
        user_note = payload.get("userNote") or payload.get("user_note")
        if not action_id or status not in allowed_statuses:
            continue
        if status == "ignored" and not str(user_note or "").strip():
            continue
        overrides.append(
            BrokerFileActionOverride(
                action_id=action_id,
                status=status,
                updated_at=str(payload.get("updatedAt") or payload.get("updated_at") or ""),
                user_note=str(user_note).strip() if user_note is not None and str(user_note).strip() else None,
                linked_row_id=(
                    str(payload.get("linkedRowId") or payload.get("linked_row_id"))
                    if (payload.get("linkedRowId") or payload.get("linked_row_id")) is not None
                    else None
                ),
            )
        )
    return overrides


def _json_default(value: object) -> object:
    """Zbiory jako posortowane listy; reszta tekstem.

    `default=str` zamienial zbior (np. policy_tags) w napis "{'a', 'b'}" o
    kolejnosci zaleznej od procesu - ten sam przebieg dawal rozny wynik.
    """
    if isinstance(value, (set, frozenset)):
        return sorted(value, key=str)
    return str(value)


def parse_prior_year_loss_payload(payload: dict) -> PriorYearLoss | None:
    loss_year = payload.get("taxYear") or payload.get("tax_year")
    amount = payload.get("amountPln") or payload.get("amount_pln") or payload.get("amount")
    if not loss_year or not amount:
        return None

    def kwota(wartosc: object, opis: str) -> Decimal:
        try:
            return parse_decimal_arg(wartosc, field_name=opis)
        except BladDanychWejsciowych as blad:
            raise BladDanychWejsciowych(
                f"Strata za {loss_year}: {opis} {wartosc!r} nie jest liczbą - wpisz np. 1234,56."
            ) from blad

    amount_pln = kwota(amount, "kwota straty")
    if amount_pln == 0:
        return None
    # Minus przed kwota straty zamienial odliczenie w doliczenie do dochodu.
    if amount_pln < 0:
        raise BladDanychWejsciowych(
            f"Strata za {loss_year}: kwota {amount!r} musi być dodatnia - wpisz wysokość straty bez minusa."
        )
    remaining_raw = payload.get("remainingPln", payload.get("remaining_pln"))
    remaining_confirmed = remaining_raw is not None and str(remaining_raw).strip() != ""
    remaining_pln = kwota(remaining_raw, "pozostało do odliczenia") if remaining_confirmed else amount_pln
    if remaining_pln < 0 or remaining_pln > amount_pln:
        raise BladDanychWejsciowych(
            f"Strata za {loss_year}: pozostało do odliczenia {remaining_raw!r} - kwota musi mieścić się "
            f"między 0 a kwotą straty ({amount_pln})."
        )
    accepted = payload.get("accepted")
    return PriorYearLoss(
        tax_year=int(loss_year), amount_pln=amount_pln, remaining_pln=remaining_pln,
        accepted=True if accepted is None else bool(accepted),
        remaining_confirmed=remaining_confirmed,
    )


def build_bundle(
    args: argparse.Namespace,
) -> InputBundle:
    storage_dir = default_storage_dir(args)
    source_selection_mode = "canonical_stream"
    # Pliki wylaczone w aplikacji nie moga wejsc ani do strumienia kanonicznego,
    # ani do jawnych sciezek ponizej - inaczej wylaczenie dzialaloby polowicznie.
    excluded_files = normalize_excluded_files(getattr(args, "exclude_file", []) or [])
    source_resolution = resolve_storage_sources(
        storage_dir, mode=source_selection_mode, excluded_files=excluded_files
    )
    if excluded_files:
        print(
            "UWAGA: pominieto pliki wylaczone przez uzytkownika: "
            + ", ".join(sorted(source_resolution.excluded_files)),
            file=sys.stderr,
        )

    def _default_if_active(path: Path | None) -> Path | None:
        """Domyslna sciezka w magazynie, o ile plik nie zostal wylaczony."""
        if path is None or not excluded_files:
            return path
        try:
            relative = path.resolve().relative_to(storage_dir.resolve()).as_posix()
        except (ValueError, OSError):
            relative = path.name
        return None if _is_excluded(relative, excluded_files) else path
    canonical_storage_history = build_canonical_storage_history(
        source_resolution.sources,
        tax_year=int(getattr(args, "year", 0) or 0) or None,
    )
    ai_normalizer_enabled = env_flag("INVEST_AI_NORMALIZER_ENABLED") or str(
        getattr(args, "ai_normalizer_enabled", "")
    ).lower() == "true"
    transaction_intelligence = build_transaction_intelligence(
        source_resolution.sources,
        tax_year=int(getattr(args, "year", 0) or 0) or None,
        ai_enabled=ai_normalizer_enabled,
    )
    # Plik obciety limitem wierszy oznacza rozliczenie na niepelnym zbiorze.
    # Bez tego sygnalu strata czesci transakcji przechodzi bez sladu.
    for truncated in transaction_intelligence.get("sources_at_row_limit", []):
        print(
            "UWAGA: plik {filename} osiagnal limit {limit} wierszy - czesc zapisow mogla nie wejsc "
            "do rozliczenia.".format(**truncated),
            file=sys.stderr,
        )
    # Plik, ktorego nie dalo sie odczytac, nie moze zniknac po cichu - jego
    # transakcje nie weszly do rozliczenia.
    for nieczytelny in transaction_intelligence.get("sources_unreadable", []):
        print(
            "UWAGA: nie udalo sie odczytac pliku {filename} ({error}) - jego zapisy nie weszly "
            "do rozliczenia.".format(**nieczytelny),
            file=sys.stderr,
        )
    transaction_intelligence["canonical_storage_history"] = canonical_storage_history.get("rows", [])
    transaction_intelligence["storage_lineage_index"] = canonical_storage_history.get("lineageIndex", {})
    canonical_tax_input = build_canonical_tax_input(transaction_intelligence)
    transaction_intelligence["canonical_tax_input"] = canonical_tax_input
    transaction_intelligence["canonical_tax_input_summary"] = canonical_tax_input.get("summary") or {}
    transaction_intelligence["tax_input_build_report"] = build_tax_input_build_report(canonical_tax_input)
    output_dir = Path(args.out_dir)
    # Kopia wynikow w dane/out dla magazynu dane/pliki - ten sam tekst, serializowany raz.
    storage_out_dir = storage_dir.parent / "out" if storage_dir.name.lower() == "pliki" else None
    mirror_dirs = (
        [storage_out_dir]
        if storage_out_dir is not None
        and storage_out_dir.resolve() != output_dir.resolve()
        and not getattr(args, "bez_kopii_out", False)
        and os.environ.get("INVEST_BEZ_KOPII_OUT", "").strip().lower() not in {"1", "true", "tak", "yes"}
        else []
    )
    write_transaction_intelligence_outputs(transaction_intelligence, output_dir, mirror_dirs)
    canonical_tax_input_path = output_dir / "canonical_tax_input.json"
    canonical_tax_input_mode = (
        getattr(args, "canonical_tax_input_mode", "")
        or os.environ.get("INVEST_CANONICAL_TAX_INPUT_MODE")
        or "required"
    ).strip().lower()
    if canonical_tax_input_mode not in {"off", "prefer", "required"}:
        canonical_tax_input_mode = "required"

    api_json_path = Path(args.api_json) if args.api_json else _default_if_active(storage_dir / "pelny_zrzut_api_transakcje.json")
    trades_v1_path = Path(args.trades_v1) if args.trades_v1 else _default_if_active(storage_dir / "Tradesv1.xlsx")
    trades_legacy_path = Path(args.trades_legacy) if args.trades_legacy else _default_if_active(storage_dir / "Trades (1).xlsx")
    tradernet_table_path = Path(args.tradernet_table) if args.tradernet_table else _default_if_active(storage_dir / "tradernet_tablev1.xlsx")
    broker_json_path = Path(args.broker_json) if args.broker_json else _default_if_active(storage_dir / "historia_transakcji.json")
    broker_xml_path = Path(args.broker_xml) if args.broker_xml else None
    depo_json_default = next(
        (
            path
            for path in storage_dir.glob("broker_*.json")
            if path.name != "historia_transakcji.json" and _default_if_active(path) is not None
        ),
        None,
    )
    depo_json_path = Path(args.depo_json) if args.depo_json else depo_json_default
    nbp_csv_paths = (
        [Path(value) for value in args.nbp_csv]
        if args.nbp_csv
        else [path for path in storage_dir.glob("archiwum_tab_a_*.csv") if _default_if_active(path) is not None]
    )
    user_overrides = UserOverrides()
    # Straty z lat ubieglych podaje uzytkownik - silnik nie zna rozliczen sprzed
    # zakresu wgranych plikow. Limit ustawowy nakladany jest pozniej, w pit38_engine.
    przeniesione_krypto = str(getattr(args, "crypto_costs_carried_forward", "") or "").strip()
    if przeniesione_krypto:
        user_overrides.crypto_costs_carried_forward_pln = parse_decimal_arg(
            przeniesione_krypto, field_name="crypto_costs_carried_forward"
        )
        # Koszt ujemny obnizalby koszty czesci E i podnosil dochod z walut wirtualnych.
        if user_overrides.crypto_costs_carried_forward_pln < 0:
            raise BladDanychWejsciowych(
                f"Koszty walut wirtualnych z lat ubiegłych (poz. 38): kwota {przeniesione_krypto!r} "
                "nie może być ujemna - przepisz poz. 40 zeznania za poprzedni rok bez minusa."
            )

    for raw_payload in getattr(args, "prior_year_loss_json", []) or []:
        loss = parse_prior_year_loss_payload(json.loads(raw_payload))
        if loss is not None:
            user_overrides.prior_year_losses.append(loss)

    # Koszty, ktore uzytkownik swiadomie wskazal do ujecia mimo domyslnej
    # polityki planu. Kazdy trafia do audytu z powodem "included_by_user_decision".
    for cost_id in getattr(args, "conditional_cost_id", []) or []:
        cleaned = str(cost_id).strip()
        if cleaned:
            user_overrides.conditional_cost_ids.add(cleaned)

    # Reczna korekta kursu: "USD:2026-05-11=3.9812". Dziala tylko przy jawnie
    # wlaczonym nbp_allow_manual_override, bo kurs ustawowy to kurs NBP z dnia
    # roboczego poprzedzajacego zdarzenie, a nie liczba wpisana przez podatnika.
    for raw_override in getattr(args, "manual_fx_override", []) or []:
        text = str(raw_override).strip()
        if not text or "=" not in text:
            continue
        key, _, value = text.partition("=")
        key = key.strip()
        if not key:
            continue
        user_overrides.manual_fx_overrides[key] = parse_decimal_arg(
            value.strip(), field_name="manual_fx_override"
        )

    funding_fee_json = getattr(args, "funding_fee_json", [])
    if funding_fee_json:
        for raw_payload in funding_fee_json:
            payload = json.loads(raw_payload)
            amount = payload.get("amount")
            date = payload.get("date")
            funding_event_id = str(
                payload.get("id")
                or payload.get("funding_event_id")
                or payload.get("fundingEventId")
                or "BANK-FUNDING-FEE"
            )
            brak_kwoty = amount is None or not str(amount).strip()
            brak_daty = date is None or not str(date).strip()
            # Wiersz calkiem pusty nie niesie oplaty. Kwota bez daty albo data bez
            # kwoty to wpis, ktory uzytkownik chcial dodac - pominiety po cichu
            # zostawilby rozliczenie bez kosztu, o ktorym nikt nie wie.
            if brak_kwoty and brak_daty:
                continue
            if brak_daty:
                raise BladDanychWejsciowych(
                    f"Opłata finansowania {funding_event_id}: podano kwotę {str(amount).strip()!r}, ale brakuje daty - "
                    "wpisz datę jako RRRR-MM-DD, np. 2026-04-03, albo usuń wpis."
                )
            if brak_kwoty:
                raise BladDanychWejsciowych(
                    f"Opłata finansowania {funding_event_id}: podano datę {str(date).strip()!r}, ale brakuje kwoty - "
                    "wpisz kwotę opłaty albo usuń wpis."
                )
            user_overrides.funding_cost_events.append(
                FundingCostEvent(
                    funding_event_id=funding_event_id,
                    amount=parse_decimal_arg(amount, field_name="funding_fee_amount"),
                    # Oplata w dolarach bez podanej waluty odliczala sie jak
                    # zlotowka 1:1, z pominieciem kursu NBP.
                    currency=_waluta_oplaty(payload.get("currency"), funding_event_id),
                    date=_data_oplaty(date, funding_event_id),
                    linked_deposit_id=str(payload.get("depositId") or payload.get("linkedDepositId") or "") or None,
                    source="CLI_USER_OVERRIDE",
                    evidence_note=str(payload.get("evidenceNote") or "") or None,
                    deposit_amount=(
                        parse_decimal_arg(payload.get("depositAmount"), field_name="funding_fee_deposit_amount")
                        if payload.get("depositAmount")
                        else None
                    ),
                    source_refs=[f"CLI_USER_OVERRIDE:{funding_event_id}"],
                )
            )

    transaction_overrides_json_path = getattr(args, "transaction_overrides_json_path", "")
    if transaction_overrides_json_path:
        overrides_path = Path(transaction_overrides_json_path)
        if overrides_path.exists():
            raw_overrides = json.loads(overrides_path.read_text(encoding="utf-8"))
            for payload in raw_overrides:
                if not isinstance(payload, dict):
                    continue
                user_overrides.transaction_overrides.append(
                    TransactionOverride(
                        override_id=str(payload.get("overrideId") or payload.get("override_id") or payload.get("manualRecordId") or "override"),
                        mode=str(payload.get("mode") or "override"),
                        record_type=str(payload.get("recordType") or payload.get("record_type") or "TRADE"),
                        base_record_id=(str(payload.get("baseRecordId")) if payload.get("baseRecordId") is not None else None),
                        manual_record_id=str(payload.get("manualRecordId") or payload.get("manual_record_id") or payload.get("overrideId") or "manual"),
                        deleted=bool(payload.get("deleted")),
                        values={
                            str(key): (None if value is None else str(value))
                            for key, value in dict(payload.get("values") or {}).items()
                        },
                        updated_at=str(payload.get("updatedAt") or payload.get("updated_at") or ""),
                        created_at=str(payload.get("createdAt") or payload.get("created_at") or ""),
                        comment=(str(payload.get("comment")) if payload.get("comment") is not None else None),
                        source_label=(str(payload.get("sourceLabel")) if payload.get("sourceLabel") is not None else None),
                    )
                )
    elif bool(args.funding_fee_amount) != bool(args.funding_fee_date):
        # Jak przy --funding-fee-json: polowa wpisu nie moze wypasc po cichu.
        brak = "daty (--funding-fee-date)" if args.funding_fee_amount else "kwoty (--funding-fee-amount)"
        raise BladDanychWejsciowych(f"Opłacie finansowania brakuje {brak}.")
    elif args.funding_fee_amount and args.funding_fee_date:
        user_overrides.funding_cost_events.append(
            FundingCostEvent(
                funding_event_id=args.funding_fee_id or "BANK-FUNDING-FEE",
                amount=parse_decimal_arg(args.funding_fee_amount, field_name="funding_fee_amount"),
                currency=_waluta_oplaty(
                    args.funding_fee_currency, args.funding_fee_id or "BANK-FUNDING-FEE"
                ),
                date=_data_oplaty(args.funding_fee_date, args.funding_fee_id or "BANK-FUNDING-FEE"),
                linked_deposit_id=args.funding_fee_deposit_id or None,
                source="CLI_USER_OVERRIDE",
                evidence_note=args.funding_fee_evidence_note or None,
                deposit_amount=(
                    parse_decimal_arg(args.funding_fee_deposit_amount, field_name="funding_fee_deposit_amount")
                    if args.funding_fee_deposit_amount
                    else None
                ),
                source_refs=[f"CLI_USER_OVERRIDE:{args.funding_fee_id or 'BANK-FUNDING-FEE'}"],
            )
        )

    return InputBundle(
        api_json_path=api_json_path,
        trades_v1_path=trades_v1_path,
        trades_legacy_path=trades_legacy_path,
        tradernet_table_path=tradernet_table_path,
        broker_json_path=broker_json_path if broker_json_path and broker_json_path.exists() else None,
        broker_xml_path=broker_xml_path,
        depo_json_path=depo_json_path if depo_json_path and depo_json_path.exists() else None,
        nbp_csv_paths=nbp_csv_paths,
        tariff_pdf_path=next(
            (path for path in sorted(storage_dir.glob("[Ss]tawki*.pdf")) if _default_if_active(path)),
            None,
        ),
        output_dir=output_dir,
        user_overrides=user_overrides,
        metadata={
            "source_selection_mode": source_selection_mode,
            "candidate_source_paths_by_id": {},
            "source_resolution_preview": source_resolution.to_audit_dict(),
            "source_resolution_manifest_entries": source_resolution.to_source_manifest_entries(),
            "candidate_source_runs": [],
            "candidate_transaction_preview_rows": [],
            "canonical_storage_history_rows": canonical_storage_history.get("rows", []),
            "storage_lineage_index": canonical_storage_history.get("lineageIndex", {}),
            "canonical_storage_history_summary": canonical_storage_history.get("summary", {}),
            "source_registry": transaction_intelligence.get("source_registry", []),
            "normalized_storage_manifest": transaction_intelligence.get("normalized_storage_manifest", []),
            "normalized_events": transaction_intelligence.get("normalized_events", []),
            "ai_document_classification": transaction_intelligence.get("ai_document_classification", []),
            "ai_column_mappings": transaction_intelligence.get("ai_column_mappings", []),
            "ai_extracted_context": transaction_intelligence.get("ai_extracted_context", []),
            "ai_validation_report": transaction_intelligence.get("ai_validation_report", {}),
            "transaction_dossiers": transaction_intelligence.get("transaction_dossiers", []),
            "transaction_dossier_summary": transaction_intelligence.get("transaction_dossier_summary", {}),
            "transaction_conflicts": transaction_intelligence.get("transaction_conflicts", []),
            "evidence_index": transaction_intelligence.get("evidence_index", []),
            "field_source_map": transaction_intelligence.get("field_source_map", {}),
            "canonical_tax_input": transaction_intelligence.get("canonical_tax_input", {}),
            "canonical_tax_input_summary": transaction_intelligence.get("canonical_tax_input_summary", {}),
            "sources_unreadable": transaction_intelligence.get("sources_unreadable", []),
            "tax_input_build_report": transaction_intelligence.get("tax_input_build_report", {}),
            "canonical_tax_input_path": str(canonical_tax_input_path),
            "canonical_tax_input_mode": canonical_tax_input_mode,
            "review_decisions": _load_review_decisions(args),
            "canonical_tax_input_consumption": {
                "inputFile": "canonical_tax_input.json",
                "recordPath": "records",
                "aiCandidatePath": "records.ai_candidates",
                "adapter": "selects_complete_buy_sell_records",
            },
        },
    )


def _load_review_decisions(args: argparse.Namespace) -> dict[str, str]:
    """Decyzje uzytkownika o zdarzeniach czekajacych na rozstrzygniecie.

    Plik: lista obiektow {"decisionKey": ..., "decision": ...}. Blad odczytu nie
    moze po cichu odblokowac rozliczenia, wiec daje pusty zestaw decyzji.
    """
    from investment_tax_engine.app.canonical_tax_input_adapter import normalize_review_decisions

    inline = getattr(args, "review_decisions", None)
    if isinstance(inline, dict):
        return normalize_review_decisions(inline)
    raw_path = str(getattr(args, "review_decisions_json_path", "") or "").strip()
    if not raw_path:
        return {}
    path = Path(raw_path)
    if not path.exists():
        return {}
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    if isinstance(payload, dict):
        return normalize_review_decisions(payload)
    decisions: dict[str, str] = {}
    for entry in payload if isinstance(payload, list) else []:
        if isinstance(entry, dict):
            key = str(entry.get("decisionKey") or entry.get("decision_key") or "").strip()
            if key:
                decisions[key] = str(entry.get("decision") or "")
    return normalize_review_decisions(decisions)


def _open_lots_payload(result: object) -> list[dict[str, object]]:
    """Otwarte partie FIFO z tych samych transakcji, z ktorych powstal PIT-38."""
    from investment_tax_engine.tax.fifo_engine import open_lots_detail

    ledger = getattr(getattr(result, "merge_result", None), "ledger", None)
    if ledger is None:
        return []
    bonus_grants = [
        event for event in ledger.events_by_id.values() if event.event_kind == "BONUS_CONTEST_SHARE"
    ]
    return open_lots_detail(
        list(ledger.trades_by_id.values()),
        getattr(result, "config", None),
        bonus_grants=bonus_grants,
    )


def _project_response_for_ui(payload: dict[str, object]) -> dict[str, object]:
    """Usuwa z odpowiedzi tylko listy powtórzone w canonical_tax_input.

    Pełne dane wejściowe pozostają w artefaktach audytu. W odpowiedzi API te
    same listy są już dostępne na poziomie głównym, gdzie czyta je interfejs.
    """
    response = dict(payload)
    canonical_tax_input = response.get("canonical_tax_input")
    if not isinstance(canonical_tax_input, dict):
        return response

    compact_input = dict(canonical_tax_input)
    duplicates = (
        ("transaction_dossiers", "transaction_dossiers"),
        ("canonical_history_rows", "canonical_storage_history_rows"),
    )
    for nested_key, response_key in duplicates:
        if nested_key in compact_input and compact_input[nested_key] == response.get(response_key):
            compact_input.pop(nested_key)
    response["canonical_tax_input"] = compact_input
    return response


def run_engine(args: argparse.Namespace) -> dict[str, object]:
    config = EngineConfig(run_mode=args.run_mode.upper(), tax_year=int(args.year))
    pit8c_path = str(getattr(args, "pit8c_json_path", "") or "")
    if pit8c_path:
        try:
            entries = json.loads(Path(pit8c_path).read_text(encoding="utf-8"))
        except (OSError, ValueError) as exc:
            entries = [{"_input_error": f"Nie mozna odczytac pliku PIT-8C: {exc}"}]
        config.tax_plan.pit8c_entries = entries if isinstance(entries, list) else [{"_input_error": "PIT-8C musi byc lista wpisow"}]
    config.tax_plan.selected_plan = args.tax_plan
    if args.package_scope:
        config.tax_filing_request = TaxFilingRequest(
            package_scope=args.package_scope,
            filing_mode=args.filing_mode,
            defense_evidence_overrides=load_defense_evidence_overrides(args.defense_evidence_overrides_json_path),
            broker_file_action_overrides=load_broker_file_action_overrides(args.broker_file_action_overrides_json_path),
        )
    if args.include_fx_conversion_costs:
        config.tax_plan.include_fx_conversion_costs = args.include_fx_conversion_costs.lower() == "true"
    if args.include_bank_funding_fees:
        config.tax_plan.include_bank_funding_fees = args.include_bank_funding_fees.lower() == "true"
    if args.include_interest_costs:
        config.tax_plan.include_interest_costs = args.include_interest_costs.lower() == "true"
    if args.include_account_fees:
        config.tax_plan.include_account_fees = args.include_account_fees.lower() == "true"
    # Reczna korekta kursu wymaga swiadomej zgody: kurs ustawowy to kurs NBP z dnia
    # roboczego poprzedzajacego zdarzenie. Bez tego przelacznika korekty sa ignorowane.
    if getattr(args, "nbp_allow_manual_override", ""):
        config.nbp_allow_manual_override = str(args.nbp_allow_manual_override).lower() == "true"
    silnik = InvestmentTaxEngine(config)
    bundle = build_bundle(args)
    config.tax_plan.pit8c_sell_trade_ids = {
        override.manual_record_id
        for override in bundle.user_overrides.transaction_overrides
        if override.values.get("wystawia_pit8c") == "true" and not override.deleted
    }
    config.tax_plan.pit8c_no_sell_trade_ids = {
        override.manual_record_id
        for override in bundle.user_overrides.transaction_overrides
        if override.values.get("wystawia_pit8c") == "false" and not override.deleted
    }
    config.tax_plan.pit8c_source_decisions = dict(bundle.metadata.get("review_decisions") or {})
    if config.tax_filing_request is None and (
        config.tax_plan.pit8c_entries or config.tax_plan.pit8c_sell_trade_ids
    ):
        config.tax_filing_request = TaxFilingRequest(package_scope="draft", filing_mode=args.filing_mode)
    result = silnik.run(bundle)
    return _project_response_for_ui({
        "contract_version": CONTRACT_VERSION,
        "engine_version": ENGINE_VERSION,
        "status": result.status,
        "filing_ready": result.filing_ready,
        "plan_used": result.plan_used,
        "filing_profile": result.filing_profile,
        "primary_scenario": result.primary_scenario,
        "annual_summary": result.annual_summary,
        "art30b": result.annual_summary.get("art30b", {}),
        "art30a": result.annual_summary.get("art30a", {}),
        "quality_report": asdict(result.quality_report) if result.quality_report else None,
        "fx_coverage_gaps": [asdict(row) for row in result.fx_coverage_gaps],
        "depo_reconciliation": result.depo_reconciliation,
        "financing_ledger": result.financing_ledger,
        "cost_items": [asdict(row) for row in result.cost_items],
        "cost_decisions": [asdict(row) for row in result.cost_decisions],
        "funding_fee_allocations": [asdict(row) for row in result.funding_fee_allocations],
        "tax_filing_package": asdict(result.tax_filing_package) if result.tax_filing_package else None,
        "scenario_results": {name: asdict(value) for name, value in result.scenario_results.items()},
        "audit_hash": result.audit_hash,
        "tax_years_detected": result.merge_result.ledger.metadata.get("tax_years_detected", []),
        "category_coverage": result.category_coverage,
        "issue_count": len(result.actionable_issues),
        "informational_issue_count": len(result.informational_issues),
        "issues": [asdict(issue) for issue in result.merge_result.ledger.issues],
        "actionable_issues": [asdict(issue) for issue in result.actionable_issues],
        "informational_issues": [asdict(issue) for issue in result.informational_issues],
        # Rozbicie kazdej sprzedazy na partie FIFO oraz zestawienia dywidend
        # i podatku u zrodla. Silnik liczyl je od zawsze, ale zapisywal tylko do
        # plikow w katalogu audytu - interfejs nie mial skad wziac kosztu ani
        # kursow T-1 per sprzedaz i pokazywal zera. Pola sa dodatkowe, wiec
        # starsze odczyty wyniku dzialaja bez zmian.
        "fifo_rows": [asdict(row) for row in (result.fifo_rows or [])],
        # Otwarte partie z tego samego FIFO - stan portfela dla interfejsu.
        "open_lots": _open_lots_payload(result),
        # Czesc E: waluty wirtualne. Wczesniej silnik tylko zglaszal, ze ich nie
        # liczy, a kafelki krypto w interfejsie zostawaly puste.
        "crypto_part_e": result.crypto_part_e or {},
        "dividends_view": list(result.dividends_view or []),
        "foreign_tax_view": list(result.foreign_tax_view or []),
        "transaction_history_rows": [asdict(row) for row in result.transaction_history_rows],
        "private_cash_fx_view": [asdict(row) for row in result.private_cash_fx_view],
        "editable_records": [asdict(record) for record in result.editable_records],
        "exported_files": [str(path) for path in result.exported_files],
        "performance_profile": result.performance_profile,
        "source_resolution_preview": result.merge_result.ledger.metadata.get("source_resolution_preview"),
        "candidate_source_runs": result.merge_result.ledger.metadata.get("candidate_source_runs", []),
        "candidate_transaction_preview_rows": result.merge_result.ledger.metadata.get("candidate_transaction_preview_rows", []),
        "canonical_storage_history_rows": result.merge_result.ledger.metadata.get("canonical_storage_history_rows", []),
        "storage_lineage_index": result.merge_result.ledger.metadata.get("storage_lineage_index", {}),
        "canonical_storage_history_summary": result.merge_result.ledger.metadata.get("canonical_storage_history_summary", {}),
        "transaction_dossiers": result.merge_result.ledger.metadata.get("transaction_dossiers", []),
        "transaction_dossier_summary": result.merge_result.ledger.metadata.get("transaction_dossier_summary", {}),
        "transaction_conflicts": result.merge_result.ledger.metadata.get("transaction_conflicts", []),
        "field_source_map": result.merge_result.ledger.metadata.get("field_source_map", {}),
        "evidence_index": result.merge_result.ledger.metadata.get("evidence_index", []),
        "ai_document_classification": result.merge_result.ledger.metadata.get("ai_document_classification", []),
        "ai_column_mappings": result.merge_result.ledger.metadata.get("ai_column_mappings", []),
        "ai_extracted_context": result.merge_result.ledger.metadata.get("ai_extracted_context", []),
        "ai_validation_report": result.merge_result.ledger.metadata.get("ai_validation_report", {}),
        "source_registry": result.merge_result.ledger.metadata.get("source_registry", []),
        "normalized_storage_manifest": result.merge_result.ledger.metadata.get("normalized_storage_manifest", []),
        "normalized_events": result.merge_result.ledger.metadata.get("normalized_events", []),
        "canonical_tax_input": result.merge_result.ledger.metadata.get("canonical_tax_input", {}),
        "canonical_tax_input_summary": result.merge_result.ledger.metadata.get("canonical_tax_input_summary", {}),
        "tax_input_build_report": result.merge_result.ledger.metadata.get("tax_input_build_report", {}),
        "canonical_tax_input_path": result.merge_result.ledger.metadata.get("canonical_tax_input_path", ""),
        "canonical_tax_input_consumption": result.merge_result.ledger.metadata.get("canonical_tax_input_consumption", {}),
        "canonical_tax_input_consumption_runtime": result.merge_result.ledger.metadata.get("canonical_tax_input_consumption_runtime", {}),
    })


def args_from_sidecar_request(payload: dict[str, object]) -> argparse.Namespace:
    overrides = payload.get("overrides") if isinstance(payload.get("overrides"), dict) else {}
    flags = payload.get("flags") if isinstance(payload.get("flags"), dict) else {}
    funding_fees = payload.get("funding_fees") if isinstance(payload.get("funding_fees"), list) else []
    os.environ["INVEST_OLLAMA_GPU_REQUIRED"] = str(flags.get("ai_normalizer_gpu_required", True)).lower()
    os.environ["INVEST_OLLAMA_GPU_CONFIRMED"] = str(flags.get("ai_normalizer_gpu_confirmed", False)).lower()
    os.environ["INVEST_OLLAMA_COMPUTE_BACKEND"] = str(flags.get("ai_normalizer_compute_backend", "unknown")).lower()
    os.environ["INVEST_OLLAMA_ALLOW_CPU_AI"] = str(flags.get("allow_cpu_ai", False)).lower()
    return argparse.Namespace(
        request="",
        year=_rok_z_zadania(payload),
        run_mode=str(payload.get("run_mode") or "SAFE"),
        api_json="",
        trades_v1="",
        trades_legacy="",
        tradernet_table="",
        broker_json="",
        broker_xml="",
        depo_json="",
        tax_plan=str(payload.get("tax_plan") or "aggressive_user"),
        package_scope=str(payload.get("package_scope") or ""),
        filing_mode=str(payload.get("filing_mode") or "ORIGINAL"),
        include_fx_conversion_costs=str(flags.get("include_fx_conversion_costs", True)).lower(),
        include_bank_funding_fees=str(flags.get("include_bank_funding_fees", True)).lower(),
        include_interest_costs=str(flags.get("include_interest_costs", True)).lower(),
        include_account_fees=str(flags.get("include_account_fees", True)).lower(),
        ai_normalizer_enabled=str(flags.get("ai_normalizer_enabled", False)).lower(),
        canonical_tax_input_mode=str(flags.get("canonical_tax_input_mode") or "required"),
        funding_fee_id="",
        funding_fee_amount="",
        funding_fee_currency="PLN",
        funding_fee_date="",
        funding_fee_deposit_id="",
        funding_fee_deposit_amount="",
        funding_fee_evidence_note="",
        funding_fee_json=[json.dumps(entry) for entry in funding_fees if isinstance(entry, dict)],
        prior_year_loss_json=[
            json.dumps(entry)
            for entry in (payload.get("prior_year_losses") or [])
            if isinstance(entry, dict)
        ],
        crypto_costs_carried_forward=str(payload.get("crypto_costs_carried_forward") or ""),
        conditional_cost_id=[
            str(entry) for entry in (payload.get("conditional_cost_ids") or []) if str(entry).strip()
        ],
        manual_fx_override=[
            f"{key}={value}" for key, value in (payload.get("manual_fx_overrides") or {}).items()
        ],
        nbp_allow_manual_override=str(flags.get("nbp_allow_manual_override", False)).lower(),
        transaction_overrides_json_path=str(overrides.get("transaction_overrides_path") or ""),
        pit8c_json_path=str(overrides.get("pit8c_path") or ""),
        review_decisions_json_path=str(overrides.get("review_decisions_path") or ""),
        review_decisions=payload.get("review_decisions") if isinstance(payload.get("review_decisions"), dict) else None,
        defense_evidence_overrides_json_path=str(overrides.get("defense_evidence_overrides_path") or ""),
        broker_file_action_overrides_json_path=str(overrides.get("broker_file_action_overrides_path") or ""),
        source_selection_mode="canonical_stream",
        selected_candidate_source_id=str(payload.get("selected_candidate_source_id") or ""),
        nbp_csv=[],
        out_dir=str(payload.get("out_dir") or "./out"),
        storage_dir=str(payload.get("storage_dir") or ""),
        # Zadanie kontrolne przez sidecar tez moze pominac kopie w dane/out.
        bez_kopii_out=bool(flags.get("bez_kopii_out", False)),
        exclude_file=[
            str(entry)
            for entry in (payload.get("excluded_files") or [])
            if str(entry).strip()
        ],
    )


def write_sidecar_error(run_dir: Path, run_id: str, error_code: str, message: str, details: object | None = None) -> None:
    run_dir.mkdir(parents=True, exist_ok=True)
    payload = {
        "contract_version": CONTRACT_VERSION,
        "status": "error",
        "run_id": run_id,
        "error_code": error_code,
        "message": message,
        "details": details or {},
        "recoverable": True,
    }
    (run_dir / "error.json").write_text(json.dumps(payload, ensure_ascii=False, indent=2, default=str), encoding="utf-8")


def run_sidecar_request(request_path: str) -> int:
    path = Path(request_path)
    run_dir = path.parent
    run_id = "unknown"
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except Exception as exc:
        write_sidecar_error(run_dir, run_id, "ENGINE_INVALID_JSON", "Invalid sidecar request JSON.", {"exception": str(exc)})
        return 2

    run_id = str(payload.get("run_id") or "unknown") if isinstance(payload, dict) else "unknown"
    if not isinstance(payload, dict):
        write_sidecar_error(run_dir, run_id, "ENGINE_INVALID_JSON", "Sidecar request must be a JSON object.")
        return 2
    if str(payload.get("contract_version") or "") != REQUEST_CONTRACT_VERSION:
        write_sidecar_error(
            run_dir,
            run_id,
            "ENGINE_CONTRACT_MISMATCH",
            f"Unsupported contract version: {payload.get('contract_version')!r}. "
            f"Expected {REQUEST_CONTRACT_VERSION!r}.",
        )
        return 2

    try:
        args = args_from_sidecar_request(payload)
        output = run_engine(args)
        output.update(
            {
                "contract_version": RESULT_CONTRACT_VERSION,
                "engine_version": ENGINE_VERSION,
                "run_id": run_id,
            }
        )
        run_dir.mkdir(parents=True, exist_ok=True)
        # Bez wciec: wynik ma ok. 90 MB, a z wcieciami json uzywal wolnego kodera
        # pythonowego i plik byl o ~40% wiekszy (desktop czyta go w calosci).
        (run_dir / "result.json").write_text(
            json.dumps(output, ensure_ascii=False, default=_json_default),
            encoding="utf-8",
        )
        return 0
    except Exception as exc:
        # Desktop pokazuje tresc bledu z error.json - blad wpisu uzytkownika dostaje
        # wlasny kod i wskazowke (jak w wersji przegladarkowej), traceback idzie do szczegolow.
        blad_wpisu = isinstance(exc, BladDanychWejsciowych)
        write_sidecar_error(
            run_dir,
            run_id,
            "ENGINE_INPUT_INVALID" if blad_wpisu else "UNKNOWN_ENGINE_ERROR",
            f"{exc} {WSKAZOWKA_BLEDU_WPISU}" if blad_wpisu else str(exc),
            {"traceback": traceback.format_exc()},
        )
        return 1


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--request", default="")
    # Pliki wylaczone przez uzytkownika w aplikacji. Nazwa pliku albo sciezka
    # wzgledna magazynu; mozna podac wielokrotnie.
    parser.add_argument("--exclude-file", action="append", default=[])
    parser.add_argument("--year")
    parser.add_argument("--run-mode", default="SAFE")
    parser.add_argument("--api-json", default="")
    parser.add_argument("--trades-v1", default="")
    parser.add_argument("--trades-legacy", default="")
    parser.add_argument("--tradernet-table", default="")
    parser.add_argument("--broker-json", default="")
    parser.add_argument("--broker-xml", default="")
    parser.add_argument("--depo-json", default="")
    parser.add_argument("--tax-plan", default="aggressive_user")
    parser.add_argument("--package-scope", default="")
    parser.add_argument("--filing-mode", default="ORIGINAL")
    parser.add_argument("--include-fx-conversion-costs", default="")
    parser.add_argument("--include-bank-funding-fees", default="")
    parser.add_argument("--include-interest-costs", default="")
    parser.add_argument("--include-account-fees", default="")
    parser.add_argument("--ai-normalizer-enabled", default="")
    parser.add_argument("--canonical-tax-input-mode", default="required", choices=["off", "prefer", "required"])
    parser.add_argument("--funding-fee-id", default="")
    parser.add_argument("--funding-fee-amount", default="")
    parser.add_argument("--funding-fee-currency", default="PLN")
    parser.add_argument("--funding-fee-date", default="")
    parser.add_argument("--funding-fee-deposit-id", default="")
    parser.add_argument("--funding-fee-deposit-amount", default="")
    parser.add_argument("--funding-fee-evidence-note", default="")
    parser.add_argument("--funding-fee-json", action="append", default=[])
    parser.add_argument("--prior-year-loss-json", action="append", default=[])
    # Koszty nabycia walut wirtualnych nieodliczone w poprzednich latach.
    # Przechodza na kolejny rok w ramach czesci E (art. 22 ust. 16 ustawy o PIT).
    parser.add_argument("--crypto-costs-carried-forward", default="")
    parser.add_argument("--conditional-cost-id", action="append", default=[])
    parser.add_argument("--manual-fx-override", action="append", default=[])
    parser.add_argument("--nbp-allow-manual-override", default="")
    parser.add_argument("--transaction-overrides-json-path", default="")
    parser.add_argument("--pit8c-json-path", default="")
    parser.add_argument("--review-decisions-json-path", default="")
    parser.add_argument("--defense-evidence-overrides-json-path", default="")
    parser.add_argument("--broker-file-action-overrides-json-path", default="")
    parser.add_argument("--source-selection-mode", default="canonical_stream")
    parser.add_argument("--selected-candidate-source-id", default="")
    parser.add_argument("--nbp-csv", action="append", default=[])
    parser.add_argument("--out-dir", default="./out")
    parser.add_argument("--storage-dir", default="")
    # Przebieg kontrolny (np. porownanie z baza) nie moze nadpisywac kopii w dane/out.
    parser.add_argument("--bez-kopii-out", action="store_true")
    args = parser.parse_args()

    if args.request:
        sys.exit(run_sidecar_request(args.request))
    if not args.year:
        parser.error("--year is required unless --request is provided")

    # Awaria przebiegu wraca jako opisany blad, a nie surowy traceback.
    # Wczesniej wyjatek leciał prosto na wyjscie, serwer oddawal go z kodem 500,
    # a uzytkownik widzial w aplikacji sciezki plikow i nazwy funkcji Pythona
    # zamiast informacji, co poszlo nie tak i co z tym zrobic.
    try:
        wynik = run_engine(args)
    except Exception as blad:  # noqa: BLE001 - kazda awaria ma wrocic opisana
        print(
            json.dumps(
                {
                    "status": "ERROR",
                    "error": {
                        "code": type(blad).__name__,
                        "message": str(blad),
                        "hint": (
                            WSKAZOWKA_BLEDU_WPISU
                            if isinstance(blad, BladDanychWejsciowych)
                            else "Sprawdź połączenie z api.nbp.pl oraz komplet plików w katalogu "
                            "danych. Szczegóły techniczne są w dzienniku serwera."
                        ),
                    },
                },
                default=str,
            )
        )
        traceback.print_exc(file=sys.stderr)
        sys.exit(1)

    print(json.dumps(wynik, default=_json_default))


if __name__ == "__main__":
    main()
