from __future__ import annotations

import hashlib
import json
from datetime import datetime, timezone
from decimal import Decimal, ROUND_CEILING, ROUND_HALF_UP
from typing import Any

from investment_tax_engine.tax.pit_zg import UNKNOWN_COUNTRY, build_pit_zg_rows, foreign_capital_tax_credit, symbole_bez_kraju
from investment_tax_engine.models.core import (
    CanonicalTrade,
    EngineRunResult,
    Issue,
    TaxCalculationReport,
    TaxFilingDraft,
    TaxFormField,
    TaxFilingPackage,
    TaxFilingRequest,
    TaxJustificationMemo,
    TaxScenarioProjection,
    TransactionHistoryRow,
)


STANDARD_LEGAL_BASIS = [
    "Ustawa o PIT art. 30b - przychody z odplatnego zbycia papierow wartosciowych rozliczane w PIT-38.",
    "Ustawa o PIT art. 22 ust. 1 - koszt wymaga zwiazku z osiagnieciem, zachowaniem albo zabezpieczeniem zrodla przychodu.",
    "Ustawa o PIT art. 23 ust. 1 pkt 38 - wydatki na nabycie papierow wartosciowych sa rozpoznawane przy ich odplatnym zbyciu.",
]

LEGAL_SOURCE_URLS = [
    {
        "label": "Ministerstwo Finansow - PIT-38 za 2025 rok",
        "url": "https://www.podatki.gov.pl/twoj-e-pit/pit-38-za-2025-rok/",
    },
    {
        "label": "Ministerstwo Finansow - broszura PIT-38 za 2025 r.",
        "url": "https://www.podatki.gov.pl/media/11079/broszura-do-pit-38-za-2025-r.pdf",
    },
    {
        "label": "Ministerstwo Finansow - zbycie akcji i zasady PIT-38",
        "url": "https://www.podatki.gov.pl/podatki-osobiste/pit/informacje-podstawowe/co-jest-opodatkowane/zbycie-akcji/",
    },
    {
        "label": "ELI/Sejm - ustawa o podatku dochodowym od osob fizycznych",
        "url": "https://eli.gov.pl/eli/DU/1991/350/ogl",
    },
]

LEGAL_BASIS_REGISTRY = [
    {
        "basisId": "pit_38_2025",
        "label": "PIT-38 za 2025 rok",
        "source": "podatki.gov.pl",
        "url": "https://www.podatki.gov.pl/twoj-e-pit/pit-38-za-2025-rok/",
        "scope": "formularz i rozliczenie dochodow z kapitalow pienieznych",
        "riskNote": "Rejestr jest warstwa opisowa audytu; nie zmienia kwot PIT.",
    },
    {
        "basisId": "share_sale",
        "label": "Zbycie akcji",
        "source": "podatki.gov.pl",
        "url": "https://www.podatki.gov.pl/podatki-osobiste/pit/informacje-podstawowe/co-jest-opodatkowane/zbycie-akcji/",
        "scope": "przychody z odplatnego zbycia papierow wartosciowych",
        "riskNote": "Koszty musza miec zwiazek z transakcjami i dowod zrodlowy.",
    },
    {
        "basisId": "costs",
        "label": "Koszty uzyskania przychodow",
        "source": "Ustawa o PIT",
        "url": "https://eli.gov.pl/eli/DU/1991/350/ogl",
        "scope": "zwiazek kosztu z osiagnieciem, zachowaniem albo zabezpieczeniem zrodla przychodu",
        "riskNote": "Pozycje aggressive_user wymagaja mocniejszego opisu i dowodow.",
    },
    {
        "basisId": "prior_year_loss",
        "label": "Straty z lat ubieglych",
        "source": "Ustawa o PIT",
        "url": "https://eli.gov.pl/eli/DU/1991/350/ogl",
        "scope": "odliczenie zrealizowanych strat podatkowych zgodnie z limitem i rokiem podatkowym",
        "riskNote": "Dotyczy strat podatkowych, nie niezrealizowanych strat portfela.",
    },
    {
        "basisId": "nbp_fx",
        "label": "Kursy NBP",
        "source": "NBP / Ustawa o PIT",
        "url": "https://nbp.pl/statystyka-i-sprawozdawczosc/kursy/",
        "scope": "przeliczenie walut w audytowalnym sladzie kursowym",
        "riskNote": "Brak kursu wymaga kontroli gotowosci, bo wynik nie jest odtwarzalny.",
    },
]


LEGAL_BASIS_BY_KIND = {
    "TRADE_COMMISSION": STANDARD_LEGAL_BASIS
    + [
        "Prowizja maklerska jest bezposrednim kosztem transakcji i powinna byc powiazana z konkretnym zleceniem lub raportem brokera.",
    ],
    "ALLOCATED_COST": STANDARD_LEGAL_BASIS
    + [
        "Koszt alokowany musi miec jawny klucz podzialu, identyfikator kosztu zrodlowego i transakcje, do ktorej zostal przypisany.",
    ],
    "FX_CONVERSION_SPREAD_COST": STANDARD_LEGAL_BASIS
    + [
        "Koszt przewalutowania moze byc ujmowany w planie aggressive_user tylko przy bezposrednim zwiazku przewalutowania z zakupem inwestycyjnym.",
    ],
    "PRIVATE_CASH_FX_INVESTMENT_LOSS": STANDARD_LEGAL_BASIS
    + [
        "Ujemna roznica private cash FX jest ujeciem agresywnym: wymaga trace od wplaty lub posiadanej waluty do pozniejszego zakupu inwestycyjnego.",
    ],
    "BANK_FUNDING_FEE": STANDARD_LEGAL_BASIS
    + [
        "Prowizja bankowa za zasilenie rachunku inwestycyjnego jest ujmowana tylko, gdy dokument wskazuje zwiazek z finansowaniem zakupow.",
    ],
    "FUNDING_TRANSFER_FEE": STANDARD_LEGAL_BASIS
    + [
        "Koszt transferu srodkow wymaga dowodu przelewu i alokacji do transakcji inwestycyjnych.",
    ],
    "INVESTMENT_INTEREST": STANDARD_LEGAL_BASIS
    + [
        "Odsetki lub oplaty finansowania inwestycji wymagaja dowodu zadluzenia, dat naliczenia i powiazania z pozycjami inwestycyjnymi.",
    ],
    "NEGATIVE_BALANCE_INTEREST": STANDARD_LEGAL_BASIS
    + [
        "Odsetki od ujemnego salda moga byc kosztem scenariuszowym tylko w zakresie, w jakim finansowaly inwestycje, a nie prywatne przeplywy.",
    ],
}


RISK_LEVEL_BY_KIND = {
    "TRADE_COMMISSION": "NISKIE",
    "ALLOCATED_COST": "SREDNIE",
    "FX_CONVERSION_SPREAD_COST": "PODWYZSZONE",
    "PRIVATE_CASH_FX_INVESTMENT_LOSS": "WYSOKIE",
    "BANK_FUNDING_FEE": "PODWYZSZONE",
    "FUNDING_TRANSFER_FEE": "PODWYZSZONE",
    "INVESTMENT_INTEREST": "PODWYZSZONE",
    "NEGATIVE_BALANCE_INTEREST": "PODWYZSZONE",
}


RECOMMENDED_EVIDENCE_BY_KIND = {
    "TRADE_COMMISSION": [
        "raport brokera z identyfikatorem zlecenia i prowizja",
        "historia transakcji z dane, tickerem, iloscia i waluta",
    ],
    "FX_CONVERSION_SPREAD_COST": [
        "dowod przewalutowania i kurs brokera",
        "kurs NBP D-1 dla waluty kosztu",
        "powiazanie przewalutowania z zakupem inwestycyjnym",
    ],
    "PRIVATE_CASH_FX_INVESTMENT_LOSS": [
        "dowod wplaty lub posiadania waluty z dane i kwota",
        "kurs zrodlowy oraz kurs uzycia srodkow przy zakupie",
        "trace pokazujacy, ze strata kursowa dotyczy srodkow uzytych do konkretnego zakupu",
        "identyfikator transakcji kupna, do ktorej przypisano ujemna roznice kursowa",
    ],
    "BANK_FUNDING_FEE": [
        "potwierdzenie prowizji bankowej",
        "dowod zasilenia rachunku inwestycyjnego",
        "alokacja prowizji do zakupow finansowanych tym zasileniem",
    ],
    "FUNDING_TRANSFER_FEE": [
        "potwierdzenie oplaty transferowej",
        "identyfikator przelewu lub wplaty",
        "alokacja do transakcji inwestycyjnych",
    ],
    "INVESTMENT_INTEREST": [
        "raport naliczenia odsetek lub oplaty od ujemnego salda",
        "saldo/zadluzenie w dniu naliczenia",
        "powiazanie finansowania z pozycjami inwestycyjnymi",
    ],
    "NEGATIVE_BALANCE_INTEREST": [
        "raport brokera z oplata od ujemnego salda",
        "saldo ujemne i waluta salda",
        "lista transakcji finansowanych ujemnym saldem",
    ],
}


TAX_ARGUMENT_BY_KIND = {
    "TRADE_COMMISSION": (
        "Koszt jest bezposrednio zwiazany z transakcja papierow wartosciowych, dlatego stanowi element kosztu "
        "rozpoznawanego razem ze zbyciem instrumentu."
    ),
    "FX_CONVERSION_SPREAD_COST": (
        "Ujecie agresywne: koszt przewalutowania jest traktowany jako wydatek konieczny do doprowadzenia srodkow "
        "do waluty zakupu inwestycyjnego, pod warunkiem zachowania bezposredniego trace."
    ),
    "PRIVATE_CASH_FX_INVESTMENT_LOSS": (
        "Ujecie agresywne: ujemna roznica private cash FX jest ujmowana tylko wtedy, gdy system potrafi wskazac "
        "konkretna wplate lub posiadane srodki, kurs zrodlowy, kurs uzycia oraz zakup inwestycyjny, ktory te srodki sfinansowaly."
    ),
    "BANK_FUNDING_FEE": (
        "Ujecie agresywne: prowizja bankowa jest kosztem finansowania inwestycji tylko w udokumentowanej czesci "
        "alokowanej do zakupow, a nie ogolnym kosztem prywatnego rachunku."
    ),
    "FUNDING_TRANSFER_FEE": (
        "Ujecie agresywne: oplata transferowa jest ujmowana jako koszt doprowadzenia srodkow do rachunku inwestycyjnego, "
        "jesli istnieje dowod zasilenia i alokacji do zakupow."
    ),
    "INVESTMENT_INTEREST": (
        "Koszt scenariuszowy: odsetki finansowania moga zmniejszac wynik tylko w zakresie zwiazanym z finansowaniem inwestycji, "
        "bez traktowania splaty kapitalu pozyczki jako kosztu PIT."
    ),
    "NEGATIVE_BALANCE_INTEREST": (
        "Koszt scenariuszowy: oplata od ujemnego salda jest ujmowana tylko wtedy, gdy ujemne saldo finansowalo inwestycje "
        "i jest udokumentowane raportem brokera."
    ),
}

DEFENSE_STATUS_LABELS_PL = {
    "complete": "Kompletne dowody",
    "needs_user_evidence": "Wymaga zachowania dowodow uzytkownika",
    "missing_link": "Brak powiazania z transakcja",
    "high_risk_review": "WYSOKIE ryzyko - wymaga przegladu",
}

ENGINE_DEFENSE_STATUS_SOURCE_PL = "z silnika"
LOCAL_DEFENSE_STATUS_SOURCE_PL = "potwierdzone lokalnie przez użytkownika"

COST_KIND_LABELS_PL = {
    "ALLOCATED_COST": "Koszt alokowany",
    "BANK_FUNDING_FEE": "Prowizja bankowa za zasilenie",
    "FUNDING_TRANSFER_FEE": "Opłata transferowa zasilenia",
    "FX_CONVERSION_SPREAD_COST": "Koszt spreadu przewalutowania",
    "INVESTMENT_INTEREST": "Odsetki od salda ujemnego",
    "NEGATIVE_BALANCE_INTEREST": "Odsetki od salda ujemnego",
    "PRIVATE_CASH_FX_INVESTMENT_LOSS": "Strata FX środków inwestycyjnych",
    "TRADE_COMMISSION": "Prowizja transakcyjna",
}

KINDS_REQUIRING_TRADE_LINK = {
    "ALLOCATED_COST",
    "BANK_FUNDING_FEE",
    "FUNDING_TRANSFER_FEE",
    "FX_CONVERSION_SPREAD_COST",
    "PRIVATE_CASH_FX_INVESTMENT_LOSS",
    "TRADE_COMMISSION",
}

KINDS_REQUIRING_FINANCING_EVIDENCE = {
    "INVESTMENT_INTEREST",
    "NEGATIVE_BALANCE_INTEREST",
}

STATUS_SCORE_WEIGHTS = {
    "complete": Decimal("100"),
    "needs_user_evidence": Decimal("65"),
    "missing_link": Decimal("0"),
    "high_risk_review": Decimal("35"),
}


def _to_decimal(value: object) -> Decimal:
    return Decimal(str(value or "0"))


def _positions_for_realized_row(result: EngineRunResult, sell_trade_id: str) -> tuple[str, str] | None:
    sell_trade: CanonicalTrade | None = result.merge_result.ledger.trades_by_id.get(sell_trade_id)
    instrument_class = (sell_trade.instrument_class if sell_trade is not None else "").upper()

    if instrument_class == "STRUCTURED_PRODUCT":
        return ("25", "26")
    if instrument_class in {"FX", "REPO"}:
        return None
    if instrument_class in {"EQUITY", "OTHER", ""}:
        return ("23", "24")
    if instrument_class == "DERIVATIVE":
        return ("27", "28")
    return ("23", "24")


# Wartosci wpisywane do PIT-38 zaokragla sie w gore od polowy (art. 63 par. 1
# Ordynacji podatkowej). Bez podania trybu quantize uzywa domyslnego kontekstu
# Pythona, czyli ROUND_HALF_EVEN - a wtedy podstawa 12 344,50 zl trafialaby do
# formularza jako 12 344 zamiast 12 345. Pozostale moduly silnika
# (fifo_engine, funding_cost_allocator) juz uzywaja ROUND_HALF_UP, wiec brak
# trybu tutaj powodowal dodatkowo dwa rozne wyniki dla tej samej kwoty.
def _q2(value: Decimal) -> Decimal:
    return value.quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)


def _q0(value: Decimal) -> Decimal:
    return value.quantize(Decimal("1"), rounding=ROUND_HALF_UP)


def _q2_up(value: Decimal) -> Decimal:
    """Zaokraglenie do pelnych groszy w gore.

    Art. 63 par. 1a Ordynacji podatkowej i broszura MF do PIT-38: reszta
    czesci G idzie do pelnych zlotych, ale zryczaltowany podatek z art. 30a
    ust. 1 pkt 1-3 (odsetki od pozyczek, od papierow wartosciowych i od
    srodkow na rachunku) zaokragla sie do pelnych groszy w gore. Dywidendy to
    pkt 4, wiec ich ten wyjatek nie obejmuje.
    """
    return value.quantize(Decimal("0.01"), rounding=ROUND_CEILING)


def _decimal_text(value: Decimal | None) -> str | None:
    if value is None:
        return None
    return str(_q2(value))


def _timestamp_text(value: object) -> str | None:
    if value is None:
        return None
    if hasattr(value, "isoformat"):
        return value.isoformat()
    return str(value)


def _date_text(value: object) -> str | None:
    text = _timestamp_text(value)
    if not text:
        return None
    if "T" in text:
        return text.split("T", 1)[0]
    if " " in text:
        return text.split(" ", 1)[0]
    return text[:10] if len(text) >= 10 else text


def _cost_kind_label_pl(kind: object) -> str:
    key = str(kind or "UNKNOWN")
    return COST_KIND_LABELS_PL.get(key, key.replace("_", " ").title())


def _linked_trade_summary(result: EngineRunResult, trade_id: str | None) -> dict[str, Any] | None:
    if not trade_id:
        return None
    trade = result.merge_result.ledger.trades_by_id.get(trade_id)
    if trade is None:
        return {
            "trade_id": trade_id,
            "matched": False,
            "warning": "Nie znaleziono transakcji bazowej w ledgerze.",
        }
    return {
        "trade_id": trade.trade_id,
        "matched": True,
        "order_id": trade.order_id,
        "symbol": trade.symbol,
        "side": trade.side,
        "quantity": str(trade.quantity),
        "trade_currency": trade.trade_currency,
        "gross_amount": str(trade.gross_amount),
        "gross_amount_pln": _decimal_text(trade.gross_amount_pln),
        "buy_total_cost_pln": _decimal_text(trade.buy_total_cost_pln),
        "sell_net_revenue_pln": _decimal_text(trade.sell_net_revenue_pln),
        "executed_at": _timestamp_text(trade.executed_at),
        "tax_event_date": _timestamp_text(trade.tax_event_date),
        "source_name": trade.source_name,
        "source_record_id": trade.source_record_id,
    }


def _risk_level(kind: str, aggressive_only: bool) -> str:
    if kind in RISK_LEVEL_BY_KIND:
        return RISK_LEVEL_BY_KIND[kind]
    return "PODWYZSZONE" if aggressive_only else "SREDNIE"


def _legal_basis(kind: str) -> list[str]:
    return LEGAL_BASIS_BY_KIND.get(kind, STANDARD_LEGAL_BASIS)


def _recommended_evidence(kind: str) -> list[str]:
    return RECOMMENDED_EVIDENCE_BY_KIND.get(
        kind,
        [
            "raport zrodlowy z identyfikatorem rekordu",
            "dowod kwoty i waluty kosztu",
            "uzasadnienie zwiazku kosztu z przychodem inwestycyjnym",
        ],
    )


def _missing_evidence(
    *,
    kind: str,
    source_id: str | None,
    linked_trade: dict[str, Any] | None,
    requires_user_documentation: bool,
) -> list[str]:
    missing: list[str] = []
    if not source_id:
        missing.append("brak identyfikatora zrodlowego kosztu")
    if kind in KINDS_REQUIRING_TRADE_LINK and not (linked_trade and linked_trade.get("matched")):
        missing.append("brak powiazania kosztu z konkretna transakcja inwestycyjna")
    if kind in KINDS_REQUIRING_FINANCING_EVIDENCE:
        missing.append("dowod naliczenia odsetek, saldo ujemne i zwiazek finansowania z inwestycjami")
    if requires_user_documentation:
        missing.append("potwierdzenie dokumentow zrodlowych trzeba zachowac poza aplikacja")
    if kind in {"BANK_FUNDING_FEE", "FUNDING_TRANSFER_FEE"}:
        missing.append("potwierdzenie przelewu, prowizji i alokacji do zakupow")
    if kind in {"PRIVATE_CASH_FX_INVESTMENT_LOSS", "FX_CONVERSION_SPREAD_COST"}:
        missing.append("potwierdzenie kursow, przewalutowania i trace do zakupu")
    return list(dict.fromkeys(missing))


def _defense_status(
    *,
    kind: str,
    risk_level: str,
    linked_trade: dict[str, Any] | None,
    requires_user_documentation: bool,
) -> str:
    if kind in KINDS_REQUIRING_TRADE_LINK and not (linked_trade and linked_trade.get("matched")):
        return "missing_link"
    if risk_level == "WYSOKIE":
        return "high_risk_review"
    if kind in KINDS_REQUIRING_FINANCING_EVIDENCE:
        return "needs_user_evidence"
    if requires_user_documentation:
        return "needs_user_evidence"
    return "complete"


def _amount_reconciliation(
    *,
    decision: Any,
    item: Any | None,
) -> dict[str, str | None]:
    amount_pln = _decimal_text(decision.amount_pln)
    source_amount = str(item.amount_foreign) if item else None
    source_currency = item.currency if item else None
    source_amount_pln = _decimal_text(item.amount_pln) if item else None
    notes = list(item.notes) if item else []
    return {
        "decision_amount_pln": amount_pln,
        "source_amount": source_amount,
        "source_currency": source_currency,
        "source_amount_pln": source_amount_pln,
        "summary": (
            f"Kwota w pakiecie wynika z decyzja kosztowa {decision.cost_id}: {amount_pln} PLN; "
            f"rekord zrodlowy: {source_amount or 'brak'} {source_currency or ''}."
        ),
        "notes": " | ".join(notes) if notes else None,
    }


def _tax_argument(kind: str, aggressive_only: bool) -> str:
    if kind in TAX_ARGUMENT_BY_KIND:
        return TAX_ARGUMENT_BY_KIND[kind]
    if aggressive_only:
        return (
            "Ujecie agresywne: koszt wymaga bezposredniego dowodu poniesienia, zwiazku z inwestycja "
            "oraz trace do konkretnych transakcji lub zdarzen w ledgerze."
        )
    return "Koszt jest ujmowany zgodnie z decyzja policy silnik i dostepnym dowodem zrodlowym."


def _risk_level_key(risk_level: str) -> str:
    normalized = (risk_level or "").upper()
    if normalized == "WYSOKIE":
        return "high"
    if normalized in {"PODWYZSZONE", "SREDNIE"}:
        return "medium"
    return "low"


def _user_action_label(*, kind: str, defense_status: str, source_id: str | None) -> str:
    source_text = f" źródła {source_id}" if source_id else ""
    if defense_status == "missing_link":
        return (
            f"Uzupełnij powiązanie kosztu{source_text} z konkretnym zakupem albo sprzedażą, "
            "albo oznacz koszt jako niewliczany w planie agresywnym."
        )
    if kind in KINDS_REQUIRING_FINANCING_EVIDENCE:
        return (
            f"Zachowaj dowód naliczenia odsetek{source_text}, historię salda ujemnego i opis, "
            "które inwestycje były finansowane tym saldem."
        )
    if kind in {"BANK_FUNDING_FEE", "FUNDING_TRANSFER_FEE"}:
        return (
            f"Zachowaj potwierdzenie przelewu i prowizji{source_text} oraz opis alokacji kosztu do zakupów inwestycyjnych."
        )
    if kind in {"PRIVATE_CASH_FX_INVESTMENT_LOSS", "FX_CONVERSION_SPREAD_COST"}:
        return (
            f"Zachowaj potwierdzenie wpłaty, przewalutowania i użycia środków{source_text} do zakupu inwestycyjnego."
        )
    if defense_status == "high_risk_review":
        return "Sprawdź pozycję z doradcą i zachowaj pełny komplet dowodów przed złożeniem PIT."
    if defense_status == "needs_user_evidence":
        return f"Uzupełnij lub zachowaj dowody źródłowe kosztu{source_text} przed złożeniem PIT."
    return "Brak wymaganej akcji; zachowaj standardowe dokumenty źródłowe."


def _build_action_item(entry: dict[str, Any]) -> dict[str, Any]:
    return {
        "costId": entry.get("cost_id"),
        "kind": entry.get("kind"),
        "amountPln": entry.get("amount_pln"),
        "sourceRecordId": entry.get("source_id"),
        "defenseStatus": entry.get("defense_status"),
        "riskLevel": _risk_level_key(str(entry.get("risk_level") or "")),
        "userActionLabel": entry.get("user_action_label"),
        "missingEvidence": entry.get("missing_evidence") or [],
    }


def _build_missing_link_warning(entry: dict[str, Any]) -> str:
    cost_id = entry.get("cost_id") or "koszt"
    source_id = entry.get("source_id") or "brak identyfikatora źródła"
    kind = entry.get("kind") or "UNKNOWN"
    amount = entry.get("amount_pln") or "0.00"
    return (
        f"{cost_id}: nie ustalono automatycznie powiązanej transakcji dla kosztu {kind} "
        f"ze źródła {source_id} na kwotę {amount} PLN. "
        "Uzupełnij link do zakupu/sprzedaży albo wyłącz koszt z planu agresywnego."
    )


def _build_cost_defense_entries(result: EngineRunResult) -> list[dict[str, Any]]:
    items_by_id = {item.cost_id: item for item in result.cost_items}
    entries: list[dict[str, Any]] = []
    emitted_cost_ids: set[str] = set()
    for decision in result.cost_decisions:
        if not decision.included:
            continue
        if decision.cost_id in emitted_cost_ids:
            continue
        emitted_cost_ids.add(decision.cost_id)
        item = items_by_id.get(decision.cost_id)
        kind = decision.kind
        aggressive_only = bool(decision.aggressive_only or (item.is_aggressive_only if item else False))
        allocation_target = item.allocation_target if item else None
        source_id = item.source_id if item else None
        notes = list(item.notes) if item else []
        policy_tags = sorted(item.policy_tags) if item else []
        source_refs = [source_id] if source_id else []
        if item and item.allocation_target:
            source_refs.append(item.allocation_target)
        risk_level = _risk_level(kind, aggressive_only)
        linked_trade = _linked_trade_summary(result, allocation_target)
        requires_user_documentation = aggressive_only or decision.evidence_level.upper() not in {"DIRECT", "STRONG"}
        defense_status = _defense_status(
            kind=kind,
            risk_level=risk_level,
            linked_trade=linked_trade,
            requires_user_documentation=requires_user_documentation,
        )
        missing_evidence = _missing_evidence(
            kind=kind,
            source_id=source_id,
            linked_trade=linked_trade,
            requires_user_documentation=requires_user_documentation,
        )

        entries.append(
            {
                "cost_id": decision.cost_id,
                "kind": kind,
                "included": decision.included,
                "amount_pln": _decimal_text(decision.amount_pln),
                "amount_foreign": str(item.amount_foreign) if item else None,
                "currency": item.currency if item else None,
                "tax_event_date": _timestamp_text(item.tax_event_date) if item else None,
                "source_id": source_id,
                "allocation_target": allocation_target,
                "linked_trade": linked_trade,
                "linked_trade_id": linked_trade.get("trade_id") if linked_trade else None,
                "linked_trade_date": linked_trade.get("executed_at") if linked_trade else None,
                "linked_trade_symbol": linked_trade.get("symbol") if linked_trade else None,
                "policy_level": "AGGRESSIVE_ONLY" if aggressive_only else decision.policy_level,
                "risk_level": risk_level,
                "reason": decision.reason,
                "evidence_level": decision.evidence_level,
                "legal_basis": _legal_basis(kind),
                "legal_sources": LEGAL_SOURCE_URLS,
                "tax_argument_pl": _tax_argument(kind, aggressive_only),
                "recommended_evidence": _recommended_evidence(kind),
                "source_refs": source_refs,
                "policy_tags": policy_tags,
                "audit_notes": notes,
                "requires_user_documentation": requires_user_documentation,
                "defense_status": defense_status,
                "defense_status_label_pl": DEFENSE_STATUS_LABELS_PL[defense_status],
                "missing_evidence": missing_evidence,
                "user_action_label": _user_action_label(kind=kind, defense_status=defense_status, source_id=source_id),
                "risk_level_key": _risk_level_key(risk_level),
                "evidence_id": f"EVIDENCE-{decision.cost_id}",
                "amount_reconciliation": _amount_reconciliation(decision=decision, item=item),
            }
        )
    return entries


def _apply_defense_evidence_overrides(
    entries: list[dict[str, Any]],
    request: TaxFilingRequest,
) -> list[dict[str, Any]]:
    overrides = {
        override.evidence_id: override
        for override in (request.defense_evidence_overrides or [])
        if override.evidence_id
    }
    if not overrides:
        for entry in entries:
            entry.setdefault("defense_status_source", ENGINE_DEFENSE_STATUS_SOURCE_PL)
        return entries

    for entry in entries:
        entry.setdefault("defense_status_source", ENGINE_DEFENSE_STATUS_SOURCE_PL)
        evidence_id = str(entry.get("evidence_id") or "")
        override = overrides.get(evidence_id)
        if override is None:
            continue

        entry["defense_status"] = override.defense_status
        entry["defense_status_label_pl"] = DEFENSE_STATUS_LABELS_PL.get(override.defense_status, override.defense_status)
        entry["defense_status_source"] = LOCAL_DEFENSE_STATUS_SOURCE_PL
        entry["user_override_updated_at"] = override.updated_at
        entry["user_note"] = override.user_note
        entry["evidence_confirmed"] = override.evidence_confirmed
        entry["checked_at"] = override.checked_at
        entry["included_in_filing_package"] = override.included_in_filing_package
        entry["user_override_linked_trade_ids"] = list(override.linked_trade_ids)
        if override.linked_trade_ids and not entry.get("linked_trade_id"):
            entry["linked_trade_id"] = override.linked_trade_ids[0]
        if override.defense_status == "complete":
            entry["missing_evidence"] = []
            entry["user_action_label"] = "Dowód oznaczony lokalnie jako zebrany. Zachowaj dokument poza aplikacją."
        elif override.user_note:
            entry["user_action_label"] = override.user_note
    return entries


def _build_defense_evidence_links(entries: list[dict[str, Any]]) -> list[dict[str, Any]]:
    links: list[dict[str, Any]] = []
    for entry in entries:
        linked_trade_ids: list[str] = []
        linked_trade = entry.get("linked_trade") or {}
        if linked_trade.get("matched") and linked_trade.get("trade_id"):
            linked_trade_ids.append(str(linked_trade["trade_id"]))
        for trade_id in entry.get("user_override_linked_trade_ids") or []:
            trade_id_text = str(trade_id)
            if trade_id_text and trade_id_text not in linked_trade_ids:
                linked_trade_ids.append(trade_id_text)
        source_id = entry.get("source_id") or entry.get("cost_id") or ""
        links.append(
            {
                "evidenceId": entry.get("evidence_id") or f"EVIDENCE-{entry.get('cost_id')}",
                "costId": entry.get("cost_id"),
                "sourceRecordId": source_id,
                "sourceFile": None,
                "rawRowRef": source_id,
                "linkedTradeIds": linked_trade_ids,
                "amountPln": entry.get("amount_pln"),
                "defenseStatus": entry.get("defense_status"),
                "defenseStatusSource": entry.get("defense_status_source") or ENGINE_DEFENSE_STATUS_SOURCE_PL,
                "missingEvidence": entry.get("missing_evidence") or [],
                "userActionLabel": entry.get("user_action_label"),
                "riskLevel": entry.get("risk_level_key") or _risk_level_key(str(entry.get("risk_level") or "")),
                "taxImpact": "Koszt wpływa na plan aggressive_user" if entry.get("included") else "Koszt nieuwzględniony",
                "amountReconciliation": entry.get("amount_reconciliation"),
                "userNote": entry.get("user_note"),
                "evidenceConfirmed": entry.get("evidence_confirmed"),
                "checkedAt": entry.get("checked_at"),
                "includedInFilingPackage": entry.get("included_in_filing_package"),
            }
        )
    return links


def _context_for_defense_entry(entry: dict[str, Any]) -> dict[str, str | None]:
    kind = str(entry.get("kind") or "")
    allocation_target = str(entry.get("allocation_target") or entry.get("linked_trade_id") or "")
    if kind in KINDS_REQUIRING_FINANCING_EVIDENCE or "negative_cash_balance" in allocation_target or "saldo-ujemne" in allocation_target:
        currency = entry.get("currency")
        context_date = _date_text(entry.get("tax_event_date"))
        parts = allocation_target.replace("saldo-ujemne-", "negative_cash_balance:").replace("-", ":").split(":")
        if "negative_cash_balance" in parts:
            try:
                marker_index = parts.index("negative_cash_balance")
                if len(parts) > marker_index + 1:
                    currency = currency or parts[marker_index + 1]
                if len(parts) > marker_index + 4:
                    context_date = "-".join(parts[marker_index + 2 : marker_index + 5])
                elif len(parts) > marker_index + 2:
                    context_date = parts[marker_index + 2]
            except ValueError:
                pass
        return {
            "label": "Kontekst finansowania",
            "id": allocation_target or f"negative_cash_balance:{entry.get('currency') or ''}:{context_date or ''}",
            "date": context_date,
            "symbol": None,
            "currency": str(currency or entry.get("currency") or ""),
        }

    linked_trade = entry.get("linked_trade") or {}
    if linked_trade.get("matched") and linked_trade.get("trade_id"):
        return {
            "label": "Powiązana transakcja",
            "id": str(linked_trade.get("trade_id") or ""),
            "date": _date_text(linked_trade.get("executed_at") or entry.get("linked_trade_date")),
            "symbol": str(linked_trade.get("symbol") or entry.get("linked_trade_symbol") or ""),
            "currency": str(entry.get("currency") or ""),
        }

    return {
        "label": "Brak automatycznego powiązania",
        "id": str(entry.get("allocation_target") or entry.get("source_id") or entry.get("cost_id") or ""),
        "date": _date_text(entry.get("tax_event_date")),
        "symbol": str(entry.get("linked_trade_symbol") or ""),
        "currency": str(entry.get("currency") or ""),
    }


def _group_key_for_defense_entry(entry: dict[str, Any], context: dict[str, str | None]) -> str:
    kind = str(entry.get("kind") or "UNKNOWN")
    if kind in KINDS_REQUIRING_FINANCING_EVIDENCE:
        return f"{kind}:{context.get('currency') or entry.get('currency') or 'UNKNOWN'}"
    if kind == "PRIVATE_CASH_FX_INVESTMENT_LOSS":
        return f"{kind}:{entry.get('source_id') or context.get('id') or 'UNKNOWN'}"
    if kind in {"BANK_FUNDING_FEE", "FUNDING_TRANSFER_FEE"}:
        return f"{kind}:{entry.get('source_id') or _date_text(entry.get('tax_event_date')) or 'UNKNOWN'}"
    return f"{kind}:{entry.get('defense_status') or 'UNKNOWN'}"


def _rollup_defense_status(statuses: list[str]) -> str:
    for status in ("missing_link", "high_risk_review", "needs_user_evidence", "complete"):
        if status in statuses:
            return status
    return statuses[0] if statuses else "needs_user_evidence"


def _rollup_risk_level(levels: list[str]) -> str:
    if "high" in levels:
        return "high"
    if "medium" in levels:
        return "medium"
    return "low"


def _build_defense_evidence_groups(entries: list[dict[str, Any]]) -> list[dict[str, Any]]:
    groups: dict[str, dict[str, Any]] = {}
    for entry in entries:
        context = _context_for_defense_entry(entry)
        key = _group_key_for_defense_entry(entry, context)
        group = groups.setdefault(
            key,
            {
                "group_id": f"DEF-GROUP-{key}",
                "kind": entry.get("kind"),
                "label_pl": _cost_kind_label_pl(entry.get("kind")),
                "amount_pln_decimal": Decimal("0.00"),
                "cost_ids": [],
                "source_record_ids": [],
                "missing_evidence": [],
                "statuses": [],
                "risk_levels": [],
                "dates": [],
                "context_label": context.get("label"),
                "context_ids": [],
                "items": [],
            },
        )
        group["amount_pln_decimal"] += _to_decimal(entry.get("amount_pln"))
        if entry.get("cost_id"):
            group["cost_ids"].append(str(entry["cost_id"]))
        if entry.get("source_id"):
            group["source_record_ids"].append(str(entry["source_id"]))
        if context.get("id"):
            group["context_ids"].append(str(context["id"]))
        if context.get("date"):
            group["dates"].append(str(context["date"]))
        group["statuses"].append(str(entry.get("defense_status") or "needs_user_evidence"))
        group["risk_levels"].append(str(entry.get("risk_level_key") or _risk_level_key(str(entry.get("risk_level") or ""))))
        group["missing_evidence"].extend(str(value) for value in entry.get("missing_evidence") or [] if value)
        group["items"].append(
            {
                "cost_id": entry.get("cost_id"),
                "amount_pln": entry.get("amount_pln"),
                "source_id": entry.get("source_id"),
                "tax_event_date": _date_text(entry.get("tax_event_date")),
                "context_label": context.get("label"),
                "context_id": context.get("id"),
                "context_date": context.get("date"),
                "defense_status": entry.get("defense_status"),
            }
        )

    output: list[dict[str, Any]] = []
    for group in groups.values():
        dates = sorted(set(group.pop("dates")))
        statuses = group.pop("statuses")
        risk_levels = group.pop("risk_levels")
        status = _rollup_defense_status(statuses)
        amount_decimal = group.pop("amount_pln_decimal")
        group["cost_ids"] = sorted(set(group["cost_ids"]))
        group["source_record_ids"] = sorted(set(group["source_record_ids"]))
        group["context_ids"] = sorted(set(group["context_ids"]))
        group["missing_evidence"] = sorted(set(group["missing_evidence"]))
        group["item_count"] = len(group["items"])
        group["amount_pln"] = _decimal_text(amount_decimal)
        group["date_from"] = dates[0] if dates else None
        group["date_to"] = dates[-1] if dates else None
        group["defense_status"] = status
        group["defense_status_label_pl"] = DEFENSE_STATUS_LABELS_PL.get(status, status)
        group["risk_level"] = _rollup_risk_level(risk_levels)
        output.append(group)
    output.sort(key=lambda group: (str(group.get("kind") or ""), str(group.get("date_from") or ""), str(group.get("group_id") or "")))
    return output


NO_OVERPAY_COST_KINDS = {
    "ALLOCATED_COST",
    "ACCOUNT_FEE",
    "BANK_FUNDING_FEE",
    "CUSTODY_FEE",
    "FUNDING_TRANSFER_FEE",
    "FX_CONVERSION_SPREAD_COST",
    "INVESTMENT_INTEREST",
    "NEGATIVE_BALANCE_INTEREST",
    "OTHER_INVESTMENT_COST",
    "PRIVATE_CASH_FX_INVESTMENT_LOSS",
    "TRADE_COMMISSION",
    "TRANSFER_FEE",
}

AGGRESSIVE_COST_COVERAGE_KINDS = {
    "BANK_FUNDING_FEE",
    "FUNDING_TRANSFER_FEE",
    "FX_CONVERSION_SPREAD_COST",
    "INVESTMENT_INTEREST",
    "NEGATIVE_BALANCE_INTEREST",
    "PRIVATE_CASH_FX_INVESTMENT_LOSS",
    "TRANSFER_FEE",
}


def _source_manifest_v2(result: EngineRunResult) -> list[dict[str, Any]]:
    metadata = getattr(result.merge_result.ledger, "metadata", {}) or {}
    manifests = metadata.get("source_manifest_v2") or []
    normalized = [entry for entry in manifests if isinstance(entry, dict)]
    if normalized:
        return normalized

    source_registry = metadata.get("source_registry") or []
    normalized = [
        _source_registry_entry_to_manifest(entry)
        for entry in source_registry
        if isinstance(entry, dict)
    ]
    normalized = [entry for entry in normalized if entry]
    if normalized:
        return normalized

    storage_manifest = metadata.get("normalized_storage_manifest") or []
    normalized = [
        _normalized_storage_entry_to_manifest(entry)
        for entry in storage_manifest
        if isinstance(entry, dict)
    ]
    return [entry for entry in normalized if entry]


def _source_registry_role_to_manifest_role(role: str, pit_impact: str = "") -> str:
    normalized_role = role.strip().lower()
    normalized_impact = pit_impact.strip().lower()
    if normalized_role in {"transaction_source", "transaction_report", "pit_active", "primary_tax", "pit_candidate", "candidate_tax"} or normalized_impact in {"active", "candidate"}:
        return "transaction_source"
    if normalized_role in {"nbp_rates", "baseline_support"}:
        return "nbp_rates" if normalized_role == "nbp_rates" else "data_context"
    if normalized_role in {"cash_context", "supplemental", "context_only", "data_context"}:
        return "data_context"
    if normalized_role in {"position_reconciliation", "reconciliation"}:
        return "reconciliation"
    if normalized_role == "analytics":
        return "analytics"
    if normalized_role == "evidence":
        return "evidence"
    return "unknown"


def _source_registry_entry_to_manifest(entry: dict[str, Any]) -> dict[str, Any]:
    source_id = str(entry.get("source_id") or entry.get("sourceId") or entry.get("file_sha256") or "").strip()
    filename = str(entry.get("filename") or entry.get("original_filename") or entry.get("stored_path") or source_id).strip()
    if not source_id and not filename:
        return {}
    source_role = str(entry.get("source_role") or entry.get("final_role") or "")
    pit_impact = str(entry.get("pit_impact") or "")
    record_count = int(entry.get("record_count") or entry.get("used_record_count") or 0)
    record_counts = {"records": record_count}
    for source_key, target_key in [
        ("used_record_count", "used"),
        ("rejected_record_count", "rejected"),
        ("context_record_count", "context"),
        ("needs_review_count", "needs_review"),
    ]:
        value = entry.get(source_key)
        if value is not None:
            record_counts[target_key] = int(value or 0)
    manifest_role = _source_registry_role_to_manifest_role(source_role, pit_impact)
    return {
        "sourceId": source_id or f"storage:{filename}",
        "filename": filename,
        "relativePath": entry.get("relative_path") or entry.get("stored_path") or filename,
        "hash": entry.get("file_sha256"),
        "detectedType": entry.get("detected_type") or entry.get("mime_type") or source_role or "unknown",
        "sections": [],
        "recordCounts": record_counts,
        "contributesToCanonicalInput": True,
        # Wpisane na sztywno `False` znaczylo, ze zaden plik nigdy nie jest
        # zrodlem podatkowym: `_build_result_health_check` liczy `active_sources`
        # po tym polu, wiec kontrola zaufania pokazywala zero zrodel obok
        # rozliczenia policzonego z trzech wyciagow brokera, a raport
        # rozpoznania dopisywal "Brak rozpoznanego pliku z rekordami
        # podatkowymi" przy komplecie danych.
        "contributesToTax": manifest_role == "transaction_source",
        "fileRole": source_role or None,
        "warnings": entry.get("warnings") or [],
        "errors": entry.get("errors") or [],
        "sourceResolutionRole": manifest_role,
        "sourceResolutionReason": entry.get("reason") or None,
        "sourceResolutionScore": 100 if manifest_role in {"transaction_source", "nbp_rates"} else None,
    }


def _normalized_storage_entry_to_manifest(entry: dict[str, Any]) -> dict[str, Any]:
    parser = entry.get("deterministic_parser") if isinstance(entry.get("deterministic_parser"), dict) else {}
    final_role = str(entry.get("final_role") or "")
    pit_impact = str(entry.get("pit_impact") or "")
    filename = str(entry.get("original_filename") or entry.get("stored_path") or entry.get("file_sha256") or "").strip()
    if not filename:
        return {}
    manifest_role = _source_registry_role_to_manifest_role(final_role, pit_impact)
    return {
        "sourceId": f"storage:{str(entry.get('file_sha256') or filename)[:12]}",
        "filename": filename,
        "relativePath": entry.get("stored_path") or filename,
        "hash": entry.get("file_sha256"),
        "detectedType": entry.get("mime_type") or final_role or "unknown",
        "sections": [],
        "recordCounts": {"records": int(parser.get("records_count") or 0)},
        "contributesToCanonicalInput": True,
        # Wpisane na sztywno `False` znaczylo, ze zaden plik nigdy nie jest
        # zrodlem podatkowym: `_build_result_health_check` liczy `active_sources`
        # po tym polu, wiec kontrola zaufania pokazywala zero zrodel obok
        # rozliczenia policzonego z trzech wyciagow brokera, a raport
        # rozpoznania dopisywal "Brak rozpoznanego pliku z rekordami
        # podatkowymi" przy komplecie danych.
        "contributesToTax": manifest_role == "transaction_source",
        "fileRole": final_role or None,
        "warnings": parser.get("warnings") or [],
        "errors": parser.get("errors") or [],
        "sourceResolutionRole": manifest_role,
        "sourceResolutionReason": entry.get("reason") or None,
        "sourceResolutionScore": 100 if manifest_role in {"transaction_source", "nbp_rates"} else None,
    }


def _import_intelligence_report(result: EngineRunResult, source_manifest_v2: list[dict[str, Any]]) -> dict[str, Any]:
    metadata = getattr(result.merge_result.ledger, "metadata", {}) or {}
    report = metadata.get("import_intelligence_report")
    if isinstance(report, dict):
        normalized = dict(report)
        normalized.setdefault("sources", source_manifest_v2)
        normalized.setdefault("duplicates", [])
        normalized.setdefault("conflicts", [])
        normalized.setdefault("missingExpectedSections", [])
        normalized.setdefault("recommendedActions", [])
        return normalized

    missing_expected: list[str] = []
    if not any(source.get("contributesToTax") for source in source_manifest_v2):
        missing_expected.append("Brak rozpoznanego pliku z rekordami podatkowymi.")
    return {
        "sources": source_manifest_v2,
        "duplicates": [],
        "conflicts": [],
        "missingExpectedSections": missing_expected,
        "recommendedActions": [
            "Dodaj raport transakcyjny brokera albo sprawdź format pliku."
            for _ in missing_expected[:1]
        ],
    }


def _source_file_role(source: dict[str, Any]) -> str:
    role = str(source.get("sourceResolutionRole") or source.get("role") or "").strip()
    detected_type = str(source.get("detectedType") or "").lower()
    if "nbp" in detected_type or "archive" in detected_type:
        return "nbp_rates"
    if role in {"transaction_source"}:
        return "transaction_source"
    if role == "candidate_tax":
        return "transaction_report"
    if role in {"supplemental", "fallback", "data_context", "duplicate"}:
        return "data_context" if role != "duplicate" else "duplicate"
    if role == "reconciliation":
        return "reconciliation"
    if role in {"evidence", "analytics"}:
        return role
    if source.get("contributesToCanonicalInput", source.get("contributesToTax")) is True:
        return "transaction_source"
    if source.get("contributesToCanonicalInput", source.get("contributesToTax")) is False:
        return "evidence"
    return "raw_data"


def _auto_file_recognition_report(source_manifest_v2: list[dict[str, Any]]) -> dict[str, Any]:
    by_file_key: dict[str, dict[str, Any]] = {}
    role_priority = {
        "transaction_source": 90,
        "nbp_rates": 80,
        "transaction_report": 70,
        "data_context": 60,
        "reconciliation": 50,
        "evidence": 40,
        "analytics": 35,
        "duplicate": 10,
        "raw_data": 0,
    }
    for source in source_manifest_v2:
        file_role = _source_file_role(source)
        detected_type = str(source.get("detectedType") or "unknown")
        filename = source.get("filename") or source.get("relativePath") or source.get("sourceId")
        entry = {
            "sourceId": source.get("sourceId"),
            "filename": filename,
            "detectedType": detected_type,
            "fileRole": file_role,
            "hash": source.get("hash"),
            "sections": source.get("sections") or [],
            "recordCounts": source.get("recordCounts") or {},
            "dateRange": source.get("dateRange"),
            "contributesToCanonicalInput": bool(source.get("contributesToCanonicalInput", source.get("contributesToTax"))),
            "warnings": source.get("warnings") or [],
            "errors": source.get("errors") or [],
            "reason": source.get("sourceResolutionReason") or source.get("reason"),
        }
        key = str(source.get("relativePath") or filename or source.get("sourceId") or "").replace("\\", "/").lower()
        previous = by_file_key.get(key)
        if previous is None or role_priority.get(file_role, 0) >= role_priority.get(str(previous.get("fileRole")), 0):
            if previous is not None:
                entry["sections"] = sorted(set([*previous.get("sections", []), *entry.get("sections", [])]))
                merged_counts = dict(previous.get("recordCounts") or {})
                merged_counts.update(entry.get("recordCounts") or {})
                entry["recordCounts"] = merged_counts
                entry["warnings"] = [*previous.get("warnings", []), *entry.get("warnings", [])]
                entry["errors"] = [*previous.get("errors", []), *entry.get("errors", [])]
            by_file_key[key] = entry

    sources = sorted(by_file_key.values(), key=lambda entry: str(entry.get("filename") or ""))
    role_counts: dict[str, int] = {}
    type_counts: dict[str, int] = {}
    for source in sources:
        file_role = str(source.get("fileRole") or "raw_data")
        detected_type = str(source.get("detectedType") or "unknown")
        role_counts[file_role] = role_counts.get(file_role, 0) + 1
        type_counts[detected_type] = type_counts.get(detected_type, 0) + 1
    return {
        "sources": sources,
        "summary": {
            "recognizedSourceCount": len(sources),
            "transactionSourceCount": role_counts.get("transaction_source", 0),
            "transactionReportCount": role_counts.get("transaction_report", 0),
            "evidenceSourceCount": role_counts.get("evidence", 0),
            "reconciliationSourceCount": role_counts.get("reconciliation", 0),
            "analyticsSourceCount": role_counts.get("analytics", 0),
            "nbpRateSourceCount": role_counts.get("nbp_rates", 0),
            "rawDataSourceCount": role_counts.get("raw_data", 0),
            "roleCounts": role_counts,
            "detectedTypeCounts": type_counts,
        },
    }


def _history_row_value(row: TransactionHistoryRow, field_name: str) -> str:
    value = getattr(row, field_name, None)
    return str(value or "").strip()


def _build_result_health_check(
    result: EngineRunResult,
    *,
    source_manifest_v2: list[dict[str, Any]],
    auto_file_recognition_report: dict[str, Any],
) -> dict[str, Any]:
    active_sources = [
        source
        for source in source_manifest_v2
        if source.get("contributesToTax") is True or _source_file_role(source) == "primary_tax"
    ]
    recognized_count = int(
        ((auto_file_recognition_report.get("summary") or {}).get("recognizedSourceCount"))
        or len(auto_file_recognition_report.get("sources") or [])
        or len(source_manifest_v2)
        or 0
    )
    tax_rows = [
        row
        for row in result.transaction_history_rows
        if _history_row_value(row, "tax_impact_kind") == "PIT_COUNTED"
        or _history_row_value(row, "logical_world") == "equity_tax"
        or _history_row_value(row, "row_kind") == "TRADE"
    ]
    sell_count = sum(1 for row in result.transaction_history_rows if _history_row_value(row, "side").upper() == "SELL")
    scenario = _primary_scenario_result(result)
    revenue = (
        _to_decimal(scenario.total_revenue_pln)
        if scenario is not None
        else _summary_decimal(result, "pit38_rounded_revenue_pln", art30b_key="pit38_rounded_revenue_pln")
    )
    cost = (
        _to_decimal(scenario.total_cost_pln)
        if scenario is not None
        else _summary_decimal(result, "pit38_rounded_cost_pln", art30b_key="pit38_rounded_cost_pln")
    )

    reasons: list[str] = []
    review_reasons: list[str] = []
    checks: list[dict[str, Any]] = []

    def add_check(check_id: str, status: str, severity: str, message: str) -> None:
        checks.append(
            {
                "check_id": check_id,
                "status": status,
                "severity": severity,
                "message_pl": message,
            }
        )

    add_check(
        "transaction_source_exists",
        "pass" if active_sources else "warn",
        "info" if active_sources else "warning",
        "Źródło transakcyjne jest oznaczone w audycie."
        if active_sources
        else "Brak jawnie oznaczonego źródła transakcyjnego w audycie źródeł.",
    )
    add_check(
        "storage_loaded",
        "pass" if recognized_count > 0 else "warn",
        "info" if recognized_count > 0 else "warning",
        f"Rozpoznano {recognized_count} plików w inwentarzu źródeł."
        if recognized_count > 0
        else "Nie rozpoznano plików w inwentarzu źródeł.",
    )
    add_check(
        "non_zero_activity",
        "pass" if not (sell_count > 0 and revenue == 0) else "warn",
        "info" if not (sell_count > 0 and revenue == 0) else "warning",
        "Aktywność podatkowa i kwoty PIT wyglądają spójnie."
        if not (sell_count > 0 and revenue == 0)
        else "Historia zawiera sprzedaże, ale przychód PIT wynosi 0 zł.",
    )
    add_check(
        "audit_hash_present",
        "pass" if result.audit_hash else "warn",
        "info" if result.audit_hash else "warning",
        "Audit hash jest obecny." if result.audit_hash else "Brak audit hash w wyniku.",
    )
    if not active_sources and (recognized_count > 0 or tax_rows):
        reasons.append("Brak jawnie oznaczonego źródła transakcyjnego w audycie źródeł.")
    if sell_count > 0 and revenue == 0:
        reasons.append("Historia zawiera sprzedaże, ale przychód PIT wynosi 0 zł.")

    for issue in result.merge_result.ledger.issues:
        if str(issue.severity).upper() in {"ERROR", "CRITICAL"}:
            review_reasons.append(issue.message or issue.code)

    nbp_gap_count = _liczba_brakow_kursow(result)
    add_check(
        "nbp_coverage",
        "pass" if nbp_gap_count == 0 else "warn",
        "info" if nbp_gap_count == 0 else "warning",
        "Kursy NBP są kompletne dla rekordów wejściowych."
        if nbp_gap_count == 0
        else f"Brakuje {nbp_gap_count} zakresów kursów NBP potrzebnych do rekordów wejściowych.",
    )
    add_check(
        "ledger_consistency",
        "pass" if not review_reasons else "warn",
        "info" if not review_reasons else "warning",
        "Ledger nie ma krytycznych niespójności."
        if not review_reasons
        else "Ledger ma niespójności zapisane jako diagnostyka.",
    )

    status = "ok"
    if review_reasons or reasons:
        status = "needs_review"

    active_labels = [
        str(source.get("filename") or source.get("relativePath") or source.get("sourceId") or "źródło danych")
        for source in active_sources
    ]
    return {
        "status": status,
        "headline": {
            "ok": "Dane źródłowe wyglądają spójnie.",
            "needs_review": "Wynik wymaga kontroli źródeł danych.",
        }[status],
        "reasons": list(dict.fromkeys([*review_reasons, *reasons])),
        "review_reasons": list(dict.fromkeys([*review_reasons, *reasons])),
        "activeTaxSourceIds": [
            str(source.get("sourceId"))
            for source in active_sources
            if source.get("sourceId")
        ],
        "activeTaxSourceLabels": active_labels,
        "recognizedStorageFileCount": recognized_count,
        "taxHistoryRowCount": len(tax_rows),
        "sellRowCount": sell_count,
        "revenuePln": _decimal_text(revenue),
        "costPln": _decimal_text(cost),
        "suspicious_zero_result": bool(sell_count > 0 and revenue == 0),
        "checks": checks,
        "warnings": list(dict.fromkeys(reasons)),
    }


def _file_type_from_source(source: dict[str, Any]) -> str:
    filename = str(source.get("filename") or source.get("relativePath") or "").lower()
    for suffix in (".json", ".xlsx", ".xls", ".csv", ".pdf", ".xml"):
        if filename.endswith(suffix):
            return suffix[1:]
    return "unknown"


def _detected_role_from_source(source: dict[str, Any]) -> str:
    role = _source_file_role(source)
    detected_type = str(source.get("detectedType") or "").lower()
    filename = str(source.get("filename") or source.get("relativePath") or "").lower()
    if role in {"transaction_source", "transaction_report", "data_context"}:
        if "cash" in detected_type or "ruchy" in filename:
            return "cash_movements"
        if "nbp" in detected_type or "archiwum_tab_a" in filename:
            return "nbp_rates"
        return "broker_report" if "broker" in detected_type else "transaction_history"
    if role == "nbp_rates":
        return "nbp_rates"
    if role == "reconciliation":
        return "depository_report"
    if role == "analytics":
        return "positions_snapshot"
    if role == "evidence":
        return "evidence_document"
    return "unknown"


def _usage_status_from_role(source: dict[str, Any]) -> str:
    role = _source_file_role(source)
    errors = source.get("errors") or []
    if errors and (source.get("contributesToCanonicalInput", source.get("contributesToTax")) is True or role in {"transaction_source", "transaction_report"}):
        return "source_review"
    if role == "transaction_source":
        return "transaction_source"
    if role == "transaction_report":
        return "data_context"
    if role == "nbp_rates":
        return "nbp_rates"
    if role == "reconciliation":
        return "position_reconciliation"
    if role == "data_context":
        return "data_context"
    if role == "duplicate":
        return "duplicate_source"
    if role in {"evidence", "analytics"}:
        return "source_evidence"
    return "technical_source"


def _tax_years_from_source(source: dict[str, Any]) -> list[int]:
    years: set[int] = set()
    date_range = source.get("dateRange") or {}
    if isinstance(date_range, dict):
        for key in ("from", "to"):
            value = str(date_range.get(key) or "")
            if len(value) >= 4 and value[:4].isdigit():
                years.add(int(value[:4]))
    filename = str(source.get("filename") or source.get("relativePath") or "")
    for year in ("2024", "2025", "2026"):
        if year in filename:
            years.add(int(year))
    return sorted(years)


def _build_source_trust_summary(
    result: EngineRunResult,
    *,
    source_manifest_v2: list[dict[str, Any]],
    result_health_check: dict[str, Any],
) -> dict[str, Any]:
    items: list[dict[str, Any]] = []
    status_counts: dict[str, int] = {}
    for source in source_manifest_v2:
        source_id = str(source.get("sourceId") or source.get("filename") or source.get("relativePath") or "source:unknown")
        usage_status = _usage_status_from_role(source)
        status_counts[usage_status] = status_counts.get(usage_status, 0) + 1
        warnings = [str(value) for value in (source.get("warnings") or []) if value]
        errors = [str(value) for value in (source.get("errors") or []) if value]
        record_counts = source.get("recordCounts") if isinstance(source.get("recordCounts"), dict) else {}
        review_reasons = [*errors]
        duplicate_risk = "high" if usage_status == "duplicate_source" else ("medium" if warnings or review_reasons else "none")
        confidence = "high" if not review_reasons and usage_status not in {"ignored_no_impact", "needs_review_source"} else ("medium" if not review_reasons else "low")
        items.append(
            {
                "source_id": source_id,
                "file_name": source.get("filename") or source.get("relativePath") or source_id,
                "file_path": source.get("relativePath"),
                "file_hash": source.get("hash") or "",
                "file_type": _file_type_from_source(source),
                "detected_role": _detected_role_from_source(source),
                "usage_status": usage_status,
                "tax_years_detected": _tax_years_from_source(source),
                "broker": source.get("broker"),
                "account_id_hint": source.get("accountIdHint"),
                "record_counts": {
                    "buy": _safe_int(record_counts.get("buy") or record_counts.get("buy_rows")),
                    "sell": _safe_int(record_counts.get("sell") or record_counts.get("sell_rows")),
                    "dividend": _safe_int(record_counts.get("dividend") or record_counts.get("dividends")),
                    "interest": _safe_int(record_counts.get("interest") or record_counts.get("interests")),
                    "fee": _safe_int(record_counts.get("fee") or record_counts.get("fees")),
                    "fx": _safe_int(record_counts.get("fx") or record_counts.get("fx_rows")),
                    "cash_transfer": _safe_int(record_counts.get("cash_transfer") or record_counts.get("event_like_rows")),
                    "positions": _safe_int(record_counts.get("positions")),
                    "nbp_rates": _safe_int(record_counts.get("nbp_rates") or record_counts.get("rows")),
                    "unknown": _safe_int(record_counts.get("unknown")),
                },
                "quality": {
                    "parse_ok": len(errors) == 0,
                    "has_required_columns": source.get("hasRequiredColumns"),
                    "has_dates": bool(source.get("dateRange")),
                    "has_amounts": bool(record_counts),
                    "has_currencies": source.get("hasCurrencies"),
                    "has_transaction_ids": source.get("hasTransactionIds"),
                    "nbp_coverage_ok": _liczba_brakow_kursow(result) == 0,
                    "ledger_consistency_ok": result_health_check.get("status") != "needs_review",
                    "duplicate_risk": duplicate_risk,
                    "confidence": confidence,
                },
                "review_reasons": review_reasons,
                "warnings": warnings,
                "lineage": {
                    "imported_at": datetime.now(timezone.utc).isoformat(),
                    "parser_version": str(source.get("parserVersion") or "current"),
                    "silnik_version": str(result.performance_profile.get("silnik_version") or "current"),
                    "contract_version": "source_trust_v3",
                },
            }
        )

    transaction_sources = [item for item in items if item["usage_status"] == "transaction_source"]
    review_needed = [item for item in items if item["usage_status"] == "source_review"]
    return {
        "contract_version": "source_trust_v3",
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "tax_year": result.annual_summary.get("tax_year") or result.config.tax_year,
        "items": items,
        "summary": {
            "source_count": len(items),
            "transaction_source_count": len(transaction_sources),
            "report_source_count": len(transaction_sources),
            "review_needed_source_count": len(review_needed),
            "status_counts": status_counts,
        },
        "source_ids": [str(item["source_id"]) for item in transaction_sources],
        "review_reasons": [reason for item in review_needed for reason in item.get("review_reasons", [])],
    }


def _braki_kursow_nbp(result: EngineRunResult) -> list[Issue]:
    """Rekordy, dla ktorych kursu NBP faktycznie zabraklo.

    Luki pokrycia opisuja zakres archiwum; brak kursu dla konkretnej transakcji
    (np. brakujacy wiersz archiwum przy wylaczonym API) ich nie tworzy, wiec
    raport pokazywal "pass", a bramka blokowala rozliczenie.
    """
    return [issue for issue in result.merge_result.ledger.issues if issue.code == "NBP_RATE_NOT_FOUND"]


def _wpisy_brakow_kursow(result: EngineRunResult) -> list[dict[str, Any]]:
    """Luki zakresu archiwum i braki kursu rekordow - bez liczenia tego samego dwa razy.

    Brak kursu rekordu w walucie i dniu objetym luka zakresu to skutek tej luki:
    dopisujemy go do niej jako powiazany rekord, a osobno pokazujemy tylko braki
    spoza luk (np. brakujacy wiersz archiwum w srodku roku).
    """
    braki = _braki_kursow_nbp(result)
    przypisane: set[int] = set()
    wpisy: list[dict[str, Any]] = []
    for gap in result.fx_coverage_gaps or []:
        # Daty ISO porownuja sie poprawnie jako tekst.
        poczatek = _date_text(gap.start_date) or ""
        koniec = _date_text(gap.end_date) or ""
        powiazane: list[str] = []
        for indeks, issue in enumerate(braki):
            dzien = _date_text(issue.details.get("date"))
            if str(issue.details.get("currency") or "").upper() != gap.currency.upper() or not dzien:
                continue
            if poczatek <= dzien <= koniec:
                powiazane.append(issue.scope_id)
                przypisane.add(indeks)
        wpisy.append(
            {
                "date": _date_text(gap.start_date),
                "currency": gap.currency,
                "linked_record_ids": powiazane,
                "severity": "blocking",
                "reason": gap.reason,
                "provider": gap.provider_name,
            }
        )
    for indeks, issue in enumerate(braki):
        if indeks in przypisane:
            continue
        wpisy.append(
            {
                "date": str(issue.details.get("date") or ""),
                "currency": str(issue.details.get("currency") or ""),
                "linked_record_ids": [issue.scope_id],
                "severity": "blocking",
                "reason": issue.message,
                "provider": "NBP",
            }
        )
    return wpisy


def _liczba_brakow_kursow(result: EngineRunResult) -> int:
    return len(_wpisy_brakow_kursow(result))


def _build_nbp_coverage_report(result: EngineRunResult) -> dict[str, Any]:
    missing = _wpisy_brakow_kursow(result)
    fx_required_rows = [
        row
        for row in result.transaction_history_rows
        if str(row.currency or "").upper() not in {"", "PLN"} and not row.is_technical_only
    ]
    required_rates = max(len(fx_required_rows), len(missing))
    found_rates = max(0, required_rates - len(missing))
    status = "fail" if missing else "pass"
    return {
        "tax_year": result.annual_summary.get("tax_year") or result.config.tax_year,
        "required_rates": required_rates,
        "found_rates": found_rates,
        "missing_rates": len(missing),
        "missing": missing,
        "status": status,
    }


def _build_storage_smoke_report(
    result: EngineRunResult,
    *,
    result_health_check: dict[str, Any],
    source_trust_summary: dict[str, Any],
    nbp_coverage_report: dict[str, Any],
) -> dict[str, Any]:
    active_sources_exist = bool(source_trust_summary.get("summary", {}).get("transaction_source_count"))
    revenue = _to_decimal(result_health_check.get("revenuePln"))
    cost = _to_decimal(result_health_check.get("costPln"))
    suspicious_zero = bool(result_health_check.get("suspicious_zero_result")) or (
        int(result_health_check.get("sellRowCount") or 0) > 0 and revenue == 0 and cost == 0
    )
    warnings: list[str] = []
    errors: list[str] = []
    if not active_sources_exist:
        warnings.append("Brak rozpoznanego źródła transakcyjnego w Source Trust.")
    if suspicious_zero:
        errors.append("Wynik wygląda na podejrzane zero przy aktywności podatkowej.")
    if nbp_coverage_report.get("status") == "fail":
        errors.append("Brakuje kursów NBP wymaganych dla aktywnych danych.")
    if result_health_check.get("status") == "needs_review":
        warnings.extend(str(reason) for reason in result_health_check.get("reasons") or [])

    status = "fail" if errors else ("warn" if warnings else "pass")
    return {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "storage_loaded": bool(source_trust_summary.get("summary", {}).get("source_count")),
        "active_tax_years": sorted(
            {
                int(year)
                for item in source_trust_summary.get("items", [])
                for year in (item.get("tax_years_detected") or [])
                if str(year).isdigit()
            }
        ),
        "checks": {
            "storage_2025_has_transaction_sources": active_sources_exist if (result.annual_summary.get("tax_year") or result.config.tax_year) == 2025 else None,
            "storage_2026_has_transaction_sources": active_sources_exist if (result.annual_summary.get("tax_year") or result.config.tax_year) == 2026 else None,
            "active_sources_exist": active_sources_exist,
            "annual_summary_not_zero": not suspicious_zero,
            "helper_files_do_not_block": True,
            "nbp_sources_detected": nbp_coverage_report.get("status") != "fail",
            "defense_vault_does_not_change_tax_result": True,
        },
        "status": status,
        "warnings": list(dict.fromkeys(warnings)),
        "errors": errors,
    }


def _build_tax_advisor_brief(
    result: EngineRunResult,
    *,
    result_health_check: dict[str, Any],
    source_manifest_v2: list[dict[str, Any]],
    aggressive_cost_defense: list[dict[str, Any]],
    defense_readiness: dict[str, Any],
    pit_submission_readiness: dict[str, Any],
) -> dict[str, Any]:
    scenario = _primary_scenario_result(result)
    revenue = (
        _to_decimal(getattr(scenario, "total_revenue_pln", "0"))
        if scenario is not None
        else _summary_decimal(result, "pit38_rounded_revenue_pln", art30b_key="pit38_rounded_revenue_pln")
    )
    cost = (
        _to_decimal(getattr(scenario, "total_cost_pln", "0"))
        if scenario is not None
        else _summary_decimal(result, "pit38_rounded_cost_pln", art30b_key="pit38_rounded_cost_pln")
    )
    base = (
        _to_decimal(getattr(scenario, "taxable_base_pln", "0"))
        if scenario is not None
        else _summary_decimal(result, "pit38_income", art30b_key="pit38_income")
    )
    tax = (
        _to_decimal(getattr(scenario, "tax_19_pln", "0"))
        if scenario is not None
        else _summary_decimal(result, "tax_19_pln", art30b_key="tax_19_pln")
    )
    net = (
        _to_decimal(getattr(scenario, "net_pln", "0"))
        if scenario is not None
        else _summary_decimal(result, "net_pln")
    )
    active_sources = [
        {
            "source_id": source.get("sourceId"),
            "filename": source.get("filename") or source.get("relativePath") or source.get("sourceId"),
            "role": _source_file_role(source),
            "detected_type": source.get("detectedType"),
            "date_range": source.get("dateRange"),
            "record_counts": source.get("recordCounts") or {},
        }
        for source in source_manifest_v2
        if source.get("contributesToTax") is True or _source_file_role(source) == "primary_tax"
    ]
    source_files = [
        {
            "source_id": source.get("sourceId"),
            "filename": source.get("filename") or source.get("relativePath") or source.get("sourceId"),
            "role": _source_file_role(source),
            "contributes_to_tax": bool(source.get("contributesToTax")),
        }
        for source in source_manifest_v2
    ]
    aggressive_costs = [
        {
            "cost_id": entry.get("cost_id"),
            "kind": entry.get("kind"),
            "label": _cost_kind_label_pl(entry.get("kind")),
            "amount_pln": entry.get("amount_pln"),
            "risk_level": entry.get("risk_level") or entry.get("risk_level_key"),
            "defense_status": entry.get("defense_status"),
            "source_id": entry.get("source_id"),
            "missing_evidence": entry.get("missing_evidence") or [],
            "user_action_label": entry.get("user_action_label"),
        }
        for entry in aggressive_cost_defense
        if isinstance(entry, dict)
    ]
    checklist = pit_submission_readiness.get("checklist") or []
    evidence_to_keep = [
        {
            "id": item.get("id"),
            "label": item.get("label"),
            "user_action": item.get("userAction"),
            "severity": item.get("severity"),
            "linked_cost_id": item.get("linkedCostId"),
        }
        for item in checklist
        if isinstance(item, dict) and str(item.get("severity")) in {"evidence", "risk", "blocking"}
    ]
    risk_items = [
        {
            "cost_id": entry.get("cost_id"),
            "kind": entry.get("kind"),
            "amount_pln": entry.get("amount_pln"),
            "risk_level": entry.get("risk_level") or entry.get("risk_level_key"),
            "reason": entry.get("reason"),
        }
        for entry in aggressive_costs
        if str(entry.get("risk_level") or "").lower() in {"high", "wysokie", "podwyzszone", "podwyższone"}
    ]
    advisor_questions = [
        "Czy wskazane koszty aggressive_user mają wystarczający związek z przychodem z odpłatnego zbycia papierów wartościowych?",
        "Jakie dokumenty źródłowe należy zachować dla kosztów FX, finansowania i prowizji?",
        "Czy przyjęty zakres aktywnych źródeł PIT jest kompletny dla wybranego roku podatkowego?",
    ]
    if result_health_check.get("status") != "ok":
        advisor_questions.insert(0, "Czy wynik wymaga dodatkowej kontroli źródeł danych przed złożeniem PIT?")
    if defense_readiness.get("highRiskItems"):
        advisor_questions.append("Które pozycje wysokiego ryzyka lepiej wyłączyć albo opisać szerzej przed złożeniem deklaracji?")

    summary = {
        "tax_year": result.annual_summary.get("tax_year") or result.config.tax_year,
        "plan_used": result.plan_used,
        "primary_scenario": result.primary_scenario,
        "revenue_pln": _decimal_text(revenue),
        "cost_pln": _decimal_text(cost),
        "taxable_base_pln": _decimal_text(base),
        "tax_19_pln": _decimal_text(tax),
        "net_pln": _decimal_text(net),
    }
    markdown_lines = [
        "# Brief dla doradcy podatkowego",
        "",
        "Ten dokument jest materiałem do weryfikacji. Nie jest poradą prawną ani gwarancją akceptacji przez urząd.",
        "",
        "## Wynik PIT",
        f"- Rok: {summary['tax_year']}",
        f"- Plan: {summary['plan_used']}",
        f"- Przychód: {summary['revenue_pln']} PLN",
        f"- Koszty: {summary['cost_pln']} PLN",
        f"- Podstawa: {summary['taxable_base_pln']} PLN",
        f"- Podatek 19%: {summary['tax_19_pln']} PLN",
        f"- Netto scenariusza: {summary['net_pln']} PLN",
        "",
        "## Zaufanie do danych",
        f"- Status: {result_health_check.get('status')}",
        f"- Opis: {result_health_check.get('headline')}",
        f"- Aktywne źródła PIT: {', '.join(result_health_check.get('activeTaxSourceLabels') or []) or 'brak jawnej listy'}",
        "",
        "## Koszty aggressive_user",
        f"- Pozycje: {len(aggressive_costs)}",
        f"- Kompletne dowody: {defense_readiness.get('completeItems', 0)}",
        f"- Braki dowodowe: {defense_readiness.get('missingEvidenceItems', 0)}",
        f"- Wysokie ryzyko: {defense_readiness.get('highRiskItems', 0)}",
        "",
        "## Dowody do zachowania",
        *[f"- {item.get('label')}: {item.get('user_action')}" for item in evidence_to_keep[:25]],
        "",
        "## Pytania do doradcy",
        *[f"- {question}" for question in advisor_questions],
        "",
        "## Pliki źródłowe",
        *[f"- {source.get('filename')} ({source.get('role')})" for source in source_files[:80]],
    ]
    return {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "summary": summary,
        "result_health_check": result_health_check,
        "active_tax_sources": active_sources,
        "source_files": source_files,
        "aggressive_costs": aggressive_costs,
        "defense_readiness": defense_readiness,
        "evidence_to_keep": evidence_to_keep,
        "risks": risk_items,
        "advisor_questions": advisor_questions,
        "markdown": "\n".join(markdown_lines),
        "legal_notice": "Materiał służy do weryfikacji przez użytkownika lub doradcę podatkowego; nie stanowi porady prawnej.",
    }


def _decision_for_cost(result: EngineRunResult, cost_id: str, plan_name: str) -> Any | None:
    for decision in result.cost_decisions:
        if decision.cost_id == cost_id and decision.plan_name == plan_name:
            return decision
    return None


def _cost_item_status(cost_item: Any, decision: Any | None, plan_name: str) -> tuple[str, str, bool]:
    if decision is not None:
        if decision.included:
            return ("liczone", decision.reason, True)
        return ("pominięte", decision.reason, False)
    if plan_name in getattr(cost_item, "included_in_plan", set()):
        return ("liczone", "koszt ujęty w planie bez jawnej decyzji policy silnik", True)
    if getattr(cost_item, "is_aggressive_only", False):
        return ("do_dowodu", "koszt agresywny wymaga decyzji lub dowodu", False)
    return ("do_decyzji", "koszt nie ma jawnej decyzji dla aktywnego planu", False)


def _technical_history_rows(result: EngineRunResult) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for row in result.transaction_history_rows:
        if not (row.is_technical_only or row.tax_impact_kind == "TECHNICAL_ONLY"):
            continue
        rows.append(
            {
                "rowId": row.row_id,
                "rowKind": row.row_kind,
                "sourceRecordId": row.base_record_id or row.transaction_id,
                "sourceName": row.source_name,
                "label": row.tax_impact_label_pl or row.tax_impact_label or "Techniczne - nie liczone w PIT",
                "amountPln": _decimal_text(row.amount_pln) if row.amount_pln is not None else None,
            }
        )
    return rows


def _build_no_overpay_audit(
    result: EngineRunResult,
    *,
    import_intelligence_report: dict[str, Any],
    defense_evidence_links: list[dict[str, Any]],
) -> dict[str, Any]:
    plan_name = result.config.tax_plan.selected_plan or result.plan_used or "aggressive_user"
    candidate_costs: list[dict[str, Any]] = []
    excluded_costs: list[dict[str, Any]] = []

    for cost_item in result.cost_items:
        if cost_item.kind not in NO_OVERPAY_COST_KINDS:
            continue
        decision = _decision_for_cost(result, cost_item.cost_id, plan_name)
        status, reason, included = _cost_item_status(cost_item, decision, plan_name)
        candidate = {
            "costId": cost_item.cost_id,
            "kind": cost_item.kind,
            "labelPl": _cost_kind_label_pl(cost_item.kind),
            "amountPln": _decimal_text(cost_item.amount_pln),
            "sourceId": cost_item.source_id,
            "taxEventDate": _date_text(cost_item.tax_event_date),
            "currency": cost_item.currency,
            "included": included,
            "status": status,
            "reason": reason,
            "evidenceLevel": getattr(cost_item, "evidence_level", None),
            "allocationTarget": getattr(cost_item, "allocation_target", None),
            "derivedCost": bool(getattr(cost_item, "derived_cost", False)),
            "notes": list(getattr(cost_item, "notes", []) or []),
        }
        candidate_costs.append(candidate)
        if not included:
            excluded_costs.append(candidate)

    duplicate_risks = [
        duplicate
        for duplicate in (import_intelligence_report.get("duplicates") or [])
        if isinstance(duplicate, dict)
    ]
    missing_evidence = [
        {
            "evidenceId": link.get("evidenceId"),
            "costId": link.get("costId"),
            "sourceRecordId": link.get("sourceRecordId"),
            "defenseStatus": link.get("defenseStatus"),
            "riskLevel": link.get("riskLevel"),
            "missingEvidence": link.get("missingEvidence") or [],
            "userActionLabel": link.get("userActionLabel"),
        }
        for link in defense_evidence_links
        if isinstance(link, dict) and link.get("defenseStatus") != "complete"
    ]
    technical_rows = _technical_history_rows(result)

    recommended_actions: list[str] = []
    for cost in excluded_costs[:12]:
        recommended_actions.append(
            f"{cost['costId']}: sprawdź, czy koszt {cost['labelPl']} może zostać udokumentowany i bezpiecznie ujęty."
        )
    for item in missing_evidence[:12]:
        if item.get("userActionLabel"):
            recommended_actions.append(str(item["userActionLabel"]))
    if duplicate_risks:
        recommended_actions.append("Sprawdź duplikaty między plikami brokera, żeby nie podwoić kosztów lub transakcji.")

    penalty = len(excluded_costs) * 4 + len(missing_evidence) * 2 + len(duplicate_risks) * 8
    confidence_score = max(0, min(100, 100 - penalty))
    return {
        "candidateCosts": candidate_costs,
        "excludedCosts": excluded_costs,
        "duplicateRisks": duplicate_risks,
        "technicalRows": technical_rows,
        "missingEvidence": missing_evidence,
        "recommendedActions": list(dict.fromkeys(recommended_actions)),
        "confidenceScore": confidence_score,
        "summary": {
            "candidateCostCount": len(candidate_costs),
            "excludedCostCount": len(excluded_costs),
            "duplicateRiskCount": len(duplicate_risks),
            "technicalRowCount": len(technical_rows),
            "missingEvidenceCount": len(missing_evidence),
            "plan": plan_name,
        },
    }


def _build_aggressive_cost_coverage_audit(
    *,
    no_overpay_audit: dict[str, Any],
    defense_evidence_links: list[dict[str, Any]],
) -> dict[str, Any]:
    candidate_costs = [
        cost for cost in (no_overpay_audit.get("candidateCosts") or [])
        if isinstance(cost, dict)
    ]
    evidence_by_cost_id: dict[str, list[dict[str, Any]]] = {}
    for link in defense_evidence_links:
        if not isinstance(link, dict):
            continue
        cost_id = str(link.get("costId") or "")
        if not cost_id:
            continue
        evidence_by_cost_id.setdefault(cost_id, []).append(link)

    categories: list[dict[str, Any]] = []
    for kind in sorted(AGGRESSIVE_COST_COVERAGE_KINDS):
        costs_for_kind = [cost for cost in candidate_costs if cost.get("kind") == kind]
        included_costs = [cost for cost in costs_for_kind if bool(cost.get("included"))]
        cost_ids = [str(cost.get("costId")) for cost in costs_for_kind if cost.get("costId")]
        missing_evidence: set[str] = set()
        defense_statuses: set[str] = set()
        risk_levels: set[str] = set()
        for cost_id in cost_ids:
            for link in evidence_by_cost_id.get(cost_id, []):
                if link.get("defenseStatus"):
                    defense_statuses.add(str(link["defenseStatus"]))
                if link.get("riskLevel"):
                    risk_levels.add(str(link["riskLevel"]))
                for missing in link.get("missingEvidence") or []:
                    missing_evidence.add(str(missing))

        included_amount = sum((_to_decimal(cost.get("amountPln")) for cost in included_costs), Decimal("0"))
        recognized_amount = sum((_to_decimal(cost.get("amountPln")) for cost in costs_for_kind), Decimal("0"))
        if included_costs:
            status = "included"
            user_action = "Koszt rozpoznany i ujęty w aktywnym planie; zachowaj dowody źródłowe."
        elif costs_for_kind:
            status = "recognized_not_counted"
            user_action = "Koszt rozpoznany w danych, ale nie został ujęty w aktywnym planie; sprawdź decyzję i dowód."
        else:
            status = "not_present_in_dane"
            user_action = "Brak takiego kosztu w danych. To nie blokuje PIT, jeśli koszt nie wystąpił."

        categories.append(
            {
                "kind": kind,
                "labelPl": _cost_kind_label_pl(kind),
                "status": status,
                "candidateCount": len(costs_for_kind),
                "includedCount": len(included_costs),
                "candidateAmountPln": _decimal_text(recognized_amount),
                "includedAmountPln": _decimal_text(included_amount),
                "costIds": cost_ids,
                "defenseStatuses": sorted(defense_statuses),
                "riskLevels": sorted(risk_levels),
                "missingEvidence": sorted(missing_evidence),
                "userAction": user_action,
            }
        )

    included_count = sum(1 for category in categories if category["status"] == "included")
    recognized_not_counted = sum(1 for category in categories if category["status"] == "recognized_not_counted")
    return {
        "categories": categories,
        "summary": {
            "plan": no_overpay_audit.get("summary", {}).get("plan"),
            "categoryCount": len(categories),
            "includedCategoryCount": included_count,
            "recognizedNotCountedCategoryCount": recognized_not_counted,
            "missingCategoryCount": sum(1 for category in categories if category["status"] == "not_present_in_dane"),
            "blocksFiling": False,
        },
    }


def _build_defense_case_file(
    *,
    source_manifest_v2: list[dict[str, Any]],
    import_intelligence_report: dict[str, Any],
    no_overpay_audit: dict[str, Any],
    defense_evidence_links: list[dict[str, Any]],
    defense_evidence_groups: list[dict[str, Any]],
) -> dict[str, Any]:
    return {
        "summary": {
            "source_count": len(source_manifest_v2),
            "candidate_cost_count": len(no_overpay_audit.get("candidateCosts", []) or []),
            "excluded_cost_count": len(no_overpay_audit.get("excludedCosts", []) or []),
            "duplicate_risk_count": len(no_overpay_audit.get("duplicateRisks", []) or []),
            "missing_evidence_count": len(no_overpay_audit.get("missingEvidence", []) or []),
            "defense_group_count": len(defense_evidence_groups),
        },
        "sourceManifests": source_manifest_v2,
        "importIntelligence": {
            "missingExpectedSections": import_intelligence_report.get("missingExpectedSections", []),
            "recommendedActions": import_intelligence_report.get("recommendedActions", []),
        },
        "costEvidenceLinks": defense_evidence_links,
        "defenseGroups": defense_evidence_groups,
        "noOverpaySummary": no_overpay_audit.get("summary", {}),
        "recommendedActions": no_overpay_audit.get("recommendedActions", []),
    }


def _safe_int(value: Any) -> int:
    try:
        return int(value or 0)
    except (TypeError, ValueError):
        return 0


def _manifest_record_count(source_manifest_v2: list[dict[str, Any]], *keys: str) -> int:
    total = 0
    for source in source_manifest_v2:
        counts = source.get("recordCounts") or {}
        if not isinstance(counts, dict):
            continue
        for key in keys:
            total += _safe_int(counts.get(key))
    return total


def _coverage_entry(
    *,
    area: str,
    label: str,
    status: str,
    record_count: int,
    issue_count: int = 0,
    source_ids: list[str] | None = None,
    recommendation: str = "",
) -> dict[str, Any]:
    return {
        "area": area,
        "label": label,
        "status": status,
        "recordCount": record_count,
        "issueCount": issue_count,
        "sourceIds": source_ids or [],
        "recommendation": recommendation,
    }


def _status_for_required(record_count: int, issue_count: int = 0) -> str:
    if issue_count > 0:
        return "conflict"
    return "complete" if record_count > 0 else "missing"


def _status_for_optional(record_count: int, issue_count: int = 0) -> str:
    if issue_count > 0:
        return "conflict"
    return "complete" if record_count > 0 else "not_applicable"


def _build_coverage_matrix(
    result: EngineRunResult,
    *,
    source_manifest_v2: list[dict[str, Any]],
    import_intelligence_report: dict[str, Any],
    no_overpay_audit: dict[str, Any],
) -> list[dict[str, Any]]:
    source_ids = [str(source.get("sourceId")) for source in source_manifest_v2 if source.get("sourceId")]
    conflict_count = len(import_intelligence_report.get("conflicts") or [])
    fx_gap_count = _liczba_brakow_kursow(result)
    candidate_costs = no_overpay_audit.get("candidateCosts") or []
    missing_evidence = no_overpay_audit.get("missingEvidence") or []

    trade_count = _manifest_record_count(source_manifest_v2, "trade_like_rows", "trades", "orders")
    if not trade_count:
        trade_count = len(result.canonical_dataset.trades or [])

    event_count = _manifest_record_count(source_manifest_v2, "event_like_rows", "events")
    commission_costs = [
        cost
        for cost in candidate_costs
        if isinstance(cost, dict) and str(cost.get("kind") or "") in {"TRADE_COMMISSION", "FX_CONVERSION_SPREAD_COST", "BANK_FUNDING_FEE", "FUNDING_TRANSFER_FEE"}
    ]
    fx_costs = [
        cost
        for cost in candidate_costs
        if isinstance(cost, dict) and str(cost.get("kind") or "") in {"FX_CONVERSION_SPREAD_COST", "PRIVATE_CASH_FX_INVESTMENT_LOSS"}
    ]
    interest_costs = [
        cost
        for cost in candidate_costs
        if isinstance(cost, dict) and str(cost.get("kind") or "") in {"INVESTMENT_INTEREST", "NEGATIVE_BALANCE_INTEREST"}
    ]

    dividends_count = len(result.dividends_view or [])
    withholding_count = len(result.foreign_tax_view or [])
    corporate_count = _manifest_record_count(source_manifest_v2, "corporate_action_rows", "corporate_actions")

    return [
        _coverage_entry(
            area="transactions",
            label="Transakcje",
            status=_status_for_required(trade_count, conflict_count),
            record_count=trade_count,
            issue_count=conflict_count,
            source_ids=source_ids,
            recommendation="Dodaj raport transakcyjny brokera." if trade_count == 0 else "Transakcje sa rozpoznane.",
        ),
        _coverage_entry(
            area="commissions",
            label="Prowizje i koszty transakcyjne",
            status="complete" if commission_costs else ("partial" if trade_count else "missing"),
            record_count=len(commission_costs),
            issue_count=len(missing_evidence),
            source_ids=source_ids,
            recommendation="Sprawdz, czy raport zawiera prowizje i oplaty transakcyjne." if not commission_costs else "Koszty transakcyjne sa w audycie.",
        ),
        _coverage_entry(
            area="transfers",
            label="Transfery i zasilenia",
            status="complete" if event_count else "partial",
            record_count=event_count,
            source_ids=source_ids,
            recommendation="Transfery sa przydatne jako dowod finansowania, nawet gdy nie zmieniaja PIT.",
        ),
        _coverage_entry(
            area="fx",
            label="Przewalutowania i roznice FX",
            status="conflict" if fx_gap_count else ("complete" if fx_costs else "partial"),
            record_count=len(fx_costs),
            issue_count=fx_gap_count,
            source_ids=source_ids,
            recommendation="Uzupelnij kursy NBP lub dowody przewalutowania." if fx_gap_count or not fx_costs else "FX ma slad kosztowy.",
        ),
        _coverage_entry(
            area="dividends",
            label="Dywidendy",
            status=_status_for_optional(dividends_count),
            record_count=dividends_count,
            source_ids=source_ids,
            recommendation="Brak dywidend w danych albo obszar nie dotyczy roku." if dividends_count == 0 else "Dywidendy sa rozpoznane.",
        ),
        _coverage_entry(
            area="withholding_tax",
            label="Podatki zrodlowe",
            status=_status_for_optional(withholding_count),
            record_count=withholding_count,
            source_ids=source_ids,
            recommendation="Brak podatku zrodlowego albo obszar nie dotyczy roku." if withholding_count == 0 else "Podatki zrodlowe sa rozpoznane.",
        ),
        _coverage_entry(
            area="investment_interest",
            label="Odsetki salda ujemnego",
            status="partial" if interest_costs and missing_evidence else ("complete" if interest_costs else "not_applicable"),
            record_count=len(interest_costs),
            issue_count=len(missing_evidence),
            source_ids=source_ids,
            recommendation="Zachowaj dowody naliczenia odsetek i opis finansowania inwestycji." if interest_costs else "Brak odsetek salda ujemnego w danych.",
        ),
            _coverage_entry(
                area="nbp",
                label="Kursy NBP",
                status="missing" if fx_gap_count else "complete",
                record_count=len(getattr(result, "fx_assignments", []) or []),
                issue_count=fx_gap_count,
                recommendation="Uzupelnij brakujace kursy NBP." if fx_gap_count else "Kursy NBP nie blokuja przebiegu.",
            ),
        _coverage_entry(
            area="corporate_actions",
            label="Corporate actions",
            status=_status_for_optional(corporate_count),
            record_count=corporate_count,
            source_ids=source_ids,
            recommendation="Brak corporate actions albo obszar nie dotyczy roku." if corporate_count == 0 else "Corporate actions wymagaja kontroli reconciliation.",
        ),
    ]


def _build_broker_file_control_tower(
    *,
    source_manifest_v2: list[dict[str, Any]],
    import_intelligence_report: dict[str, Any],
    coverage_matrix: list[dict[str, Any]],
    no_overpay_audit: dict[str, Any],
) -> dict[str, Any]:
    canonical_sources = [source for source in source_manifest_v2 if source.get("contributesToCanonicalInput", source.get("contributesToTax"))]
    context_sources = [source for source in source_manifest_v2 if not source.get("contributesToCanonicalInput", source.get("contributesToTax"))]
    missing_coverage = [
        row
        for row in coverage_matrix
        if row.get("status") in {"missing", "conflict", "partial"} and row.get("area") in {"transactions", "commissions", "fx", "nbp"}
    ]
    actions = [
        *(import_intelligence_report.get("recommendedActions") or []),
        *(no_overpay_audit.get("recommendedActions") or []),
        *[
            f"{row.get('label')}: {row.get('recommendation')}"
            for row in missing_coverage
            if row.get("recommendation")
        ],
    ]
    return {
        "summary": {
            "source_count": len(source_manifest_v2),
            "canonical_source_count": len(canonical_sources),
            "context_source_count": len(context_sources),
            "duplicate_count": len(import_intelligence_report.get("duplicates") or []),
            "conflict_count": len(import_intelligence_report.get("conflicts") or []),
            "missing_coverage_count": len(missing_coverage),
            "candidate_cost_count": len(no_overpay_audit.get("candidateCosts") or []),
        },
        "sections": {
            "what_was_imported": source_manifest_v2,
            "canonical_sources": canonical_sources,
            "context_sources": context_sources,
            "missing": missing_coverage,
        },
        "recommendedActions": list(dict.fromkeys(str(action) for action in actions if action)),
    }


def _legal_refs_for_cost_kind(kind: str | None) -> list[str]:
    kind_text = str(kind or "")
    refs = ["pit_38_2025", "costs"]
    if kind_text in {"TRADE_COMMISSION", "FX_CONVERSION_SPREAD_COST", "PRIVATE_CASH_FX_INVESTMENT_LOSS"}:
        refs.append("share_sale")
    if kind_text in {"INVESTMENT_INTEREST", "NEGATIVE_BALANCE_INTEREST", "BANK_FUNDING_FEE", "FUNDING_TRANSFER_FEE"}:
        refs.append("costs")
    return list(dict.fromkeys(refs))


def _risk_for_cost(cost: dict[str, Any]) -> str:
    kind = str(cost.get("kind") or "")
    status = str(cost.get("status") or "")
    if kind in {"PRIVATE_CASH_FX_INVESTMENT_LOSS", "INVESTMENT_INTEREST", "NEGATIVE_BALANCE_INTEREST"}:
        return "high"
    if status in {"do_dowodu", "pominięte", "pominięte"} or not cost.get("included"):
        return "medium"
    return "low"


def _defense_status_for_cost(cost: dict[str, Any], evidence_by_cost: dict[str, dict[str, Any]]) -> str:
    evidence = evidence_by_cost.get(str(cost.get("costId") or ""))
    if evidence and evidence.get("defenseStatus"):
        return str(evidence["defenseStatus"])
    return "complete" if cost.get("included") else "needs_user_evidence"


def _build_no_overpay_audit_v2(
    *,
    no_overpay_audit: dict[str, Any],
    coverage_matrix: list[dict[str, Any]],
) -> dict[str, Any]:
    candidate_costs = [
        cost
        for cost in (no_overpay_audit.get("candidateCosts") or [])
        if isinstance(cost, dict)
    ]
    excluded_costs = [
        cost
        for cost in (no_overpay_audit.get("excludedCosts") or [])
        if isinstance(cost, dict)
    ]
    missing_evidence = [
        item
        for item in (no_overpay_audit.get("missingEvidence") or [])
        if isinstance(item, dict)
    ]
    duplicate_risks = [
        item
        for item in (no_overpay_audit.get("duplicateRisks") or [])
        if isinstance(item, dict)
    ]
    status_summary: dict[str, int] = {}
    for cost in candidate_costs:
        status = str(cost.get("status") or "unknown")
        status_summary[status] = status_summary.get(status, 0) + 1

    potentially_missed = []
    for cost in excluded_costs:
        enriched = dict(cost)
        enriched["overpayRisk"] = "wymaga_dowodu"
        enriched["userAction"] = (
            f"{cost.get('costId')}: zachowaj dowod kosztu {cost.get('labelPl') or cost.get('kind')} "
            "albo zostaw pozycje poza scenariuszem."
        )
        potentially_missed.append(enriched)

    return {
        "summary": {
            **(no_overpay_audit.get("summary") or {}),
            "candidateCostCount": len(candidate_costs),
            "potentiallyMissedCount": len(potentially_missed),
            "excludedCostCount": len(excluded_costs),
            "duplicateRiskCount": len(duplicate_risks),
            "technicalRowCount": len(no_overpay_audit.get("technicalRows") or []),
            "missingEvidenceCount": len(missing_evidence),
            "confidenceScore": no_overpay_audit.get("confidenceScore"),
        },
        "candidateCosts": candidate_costs,
        "potentiallyMissedCosts": potentially_missed,
        "duplicateRisks": duplicate_risks,
        "technicalRows": no_overpay_audit.get("technicalRows") or [],
        "missingEvidence": missing_evidence,
        "coverageMatrix": coverage_matrix,
        "statusSummary": status_summary,
        "recommendedActions": no_overpay_audit.get("recommendedActions") or [],
    }


NO_OVERPAY_V3_SECTION_BY_KIND = {
    "TRADE_COMMISSION": "commissions",
    "NEGATIVE_BALANCE_INTEREST": "negative_balance_interest",
    "INVESTMENT_INTEREST": "negative_balance_interest",
    "BANK_FUNDING_FEE": "bank_transfer_fees",
    "FUNDING_TRANSFER_FEE": "bank_transfer_fees",
    "FX_CONVERSION_SPREAD_COST": "fx_spread",
    "PRIVATE_CASH_FX_INVESTMENT_LOSS": "private_cash_fx_loss",
    "WITHHOLDING_TAX": "withholding_tax",
    "DIVIDEND": "dividends",
    "TRANSFER_FEE": "technical_transfers",
    "ACCOUNT_FEE": "manual_overrides",
}

NO_OVERPAY_V3_SECTION_TITLES = {
    "commissions": "Prowizje",
    "negative_balance_interest": "Odsetki od salda ujemnego",
    "bank_transfer_fees": "Opłaty za transfer i finansowanie",
    "fx_spread": "Spread przewalutowania",
    "private_cash_fx_loss": "Private cash FX loss",
    "withholding_tax": "Podatki źródłowe",
    "dividends": "Dywidendy",
    "technical_transfers": "Transfery techniczne",
    "bonus_shares": "Operacje bonusowe",
    "manual_overrides": "Korekty i pozostałe koszty",
}


def _no_overpay_v3_decision(cost: dict[str, Any]) -> str:
    if cost.get("included") is True:
        return "counted"
    status = str(cost.get("status") or "").lower()
    reason = str(cost.get("reason") or "").lower()
    if "duplicate" in status or "duplik" in reason:
        return "duplicate_risk"
    if status in {"do_dowodu", "requires_evidence"} or cost.get("evidenceLevel") in {"missing", "partial"}:
        return "requires_evidence"
    if status in {"techniczne", "technical", "not_counted_technical"}:
        return "not_counted_technical"
    if status in {"pominięte", "pominiete", "excluded"}:
        return "excluded_by_policy"
    return "candidate"


def _evidence_status_for_no_overpay(cost: dict[str, Any], evidence_by_cost: dict[str, dict[str, Any]]) -> str:
    evidence = evidence_by_cost.get(str(cost.get("costId") or ""))
    if evidence:
        status = str(evidence.get("defenseStatus") or "")
        if status == "complete":
            return "available"
        if status in {"needs_user_evidence", "missing_link"}:
            return "missing"
        if status == "high_risk_review":
            return "advisor_required"
        return "partial"
    if cost.get("included"):
        return "not_needed"
    decision = _no_overpay_v3_decision(cost)
    return "advisor_required" if decision == "advisor_review" else ("missing" if decision == "requires_evidence" else "not_needed")


def _build_no_overpay_audit_v3(
    *,
    result: EngineRunResult,
    no_overpay_audit: dict[str, Any],
    defense_evidence_links: list[dict[str, Any]],
) -> dict[str, Any]:
    evidence_by_cost = {
        str(link.get("costId")): link
        for link in defense_evidence_links
        if isinstance(link, dict) and link.get("costId")
    }
    items_by_section: dict[str, list[dict[str, Any]]] = {}
    summary_totals = {
        "counted_total_pln": Decimal("0"),
        "candidate_total_pln": Decimal("0"),
        "requires_evidence_total_pln": Decimal("0"),
        "duplicate_risk_total_pln": Decimal("0"),
        "excluded_total_pln": Decimal("0"),
    }

    for cost in no_overpay_audit.get("candidateCosts") or []:
        if not isinstance(cost, dict):
            continue
        decision = _no_overpay_v3_decision(cost)
        amount_pln = _to_decimal(cost.get("amountPln"))
        if decision == "counted":
            summary_totals["counted_total_pln"] += amount_pln
        elif decision == "candidate":
            summary_totals["candidate_total_pln"] += amount_pln
        elif decision == "requires_evidence":
            summary_totals["requires_evidence_total_pln"] += amount_pln
        elif decision == "duplicate_risk":
            summary_totals["duplicate_risk_total_pln"] += amount_pln
        else:
            summary_totals["excluded_total_pln"] += amount_pln

        kind = str(cost.get("kind") or "OTHER_INVESTMENT_COST")
        section_id = NO_OVERPAY_V3_SECTION_BY_KIND.get(kind, "manual_overrides")
        duplicate_risk = None
        if decision == "duplicate_risk":
            duplicate_risk = {
                "risk_level": "medium",
                "possible_duplicate_record_ids": [],
                "explanation_pl": "Pozycja wymaga kontroli, żeby nie podwoić kosztu.",
            }
        items_by_section.setdefault(section_id, []).append(
            {
                "item_id": str(cost.get("costId") or f"cost:{len(items_by_section.get(section_id, []))}"),
                "linked_record_ids": [str(value) for value in [cost.get("sourceId"), cost.get("allocationTarget")] if value],
                "amount_original": None,
                "currency_original": cost.get("currency"),
                "amount_pln": _decimal_text(amount_pln),
                "decision": decision,
                "confidence": "high" if cost.get("included") else "medium",
                "reason_pl": cost.get("reason") or "Pozycja sklasyfikowana przez No Overpay Guard.",
                "evidence_status": _evidence_status_for_no_overpay(cost, evidence_by_cost),
                "duplicate_risk": duplicate_risk,
                "advisor_question_pl": (
                    "Czy ten koszt ma wystarczający związek z przychodem inwestycyjnym i jest udokumentowany?"
                    if decision in {"candidate", "requires_evidence", "advisor_review"}
                    else None
                ),
            }
        )

    sections = [
        {
            "section_id": section_id,
            "title_pl": NO_OVERPAY_V3_SECTION_TITLES.get(section_id, section_id),
            "items": items,
        }
        for section_id, items in sorted(items_by_section.items())
    ]
    return {
        "tax_year": result.annual_summary.get("tax_year") or result.config.tax_year,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "summary": {key: _decimal_text(value) for key, value in summary_totals.items()},
        "sections": sections,
    }


def _defense_vault_status_from_link(link: dict[str, Any]) -> str:
    status = str(link.get("defenseStatus") or "")
    if status == "complete":
        return "available"
    if status == "high_risk_review":
        return "advisor_review"
    if status in {"needs_user_evidence", "missing_link"}:
        return "to_collect"
    if link.get("missingEvidence"):
        return "partial"
    return "not_needed"


def _build_defense_vault_summary(
    *,
    defense_evidence_links: list[dict[str, Any]],
    source_manifest_v2: list[dict[str, Any]],
) -> dict[str, Any]:
    source_by_id = {str(source.get("sourceId")): source for source in source_manifest_v2 if source.get("sourceId")}
    items: list[dict[str, Any]] = []
    status_counts: dict[str, int] = {}
    for link in defense_evidence_links:
        if not isinstance(link, dict):
            continue
        evidence_id = str(link.get("evidenceId") or link.get("costId") or f"evidence:{len(items)}")
        status = _defense_vault_status_from_link(link)
        status_counts[status] = status_counts.get(status, 0) + 1
        source_id = str(link.get("sourceRecordId") or "")
        source = source_by_id.get(source_id, {})
        items.append(
            {
                "evidence_id": evidence_id,
                "title": link.get("userActionLabel") or f"Dowód dla {link.get('costId') or evidence_id}",
                "description": link.get("taxImpact"),
                "evidence_type": "fee_confirmation" if link.get("costId") else "user_note",
                "file_ref": {
                    "path": source.get("relativePath"),
                    "file_name": source.get("filename") or link.get("sourceFile"),
                    "file_hash": source.get("hash"),
                    "last_seen_at": datetime.now(timezone.utc).isoformat(),
                },
                "status": status,
                "linked_record_ids": [str(value) for value in [link.get("sourceRecordId"), *(link.get("linkedTradeIds") or [])] if value],
                "linked_source_ids": [source_id] if source_id else [],
                "linked_no_overpay_item_ids": [str(link.get("costId"))] if link.get("costId") else [],
                "user_note": link.get("userNote"),
                "checklist": [
                    {
                        "item_id": f"{evidence_id}:source",
                        "label_pl": "Zachowaj dokument źródłowy poza aplikacją.",
                        "done": status == "available",
                    }
                ],
                "created_at": datetime.now(timezone.utc).isoformat(),
                "updated_at": link.get("checkedAt") or datetime.now(timezone.utc).isoformat(),
            }
        )
    return {
        "contract_version": "defense_vault_v1",
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "items": items,
        "summary": {
            "total": len(items),
            "available": status_counts.get("available", 0),
            "missing": status_counts.get("missing", 0),
            "to_collect": status_counts.get("to_collect", 0),
            "partial": status_counts.get("partial", 0),
            "advisor_review": status_counts.get("advisor_review", 0),
            "not_needed": status_counts.get("not_needed", 0),
            "status_counts": status_counts,
        },
    }


def _build_advisor_review_pack(
    result: EngineRunResult,
    *,
    result_health_check: dict[str, Any],
    source_trust_summary: dict[str, Any],
    no_overpay_audit_v3: dict[str, Any],
    defense_vault_summary: dict[str, Any],
    tax_advisor_brief: dict[str, Any],
) -> dict[str, Any]:
    scenario = _primary_scenario_result(result)
    summary = tax_advisor_brief.get("summary") or {}
    result_payload = {
        "revenue_pln": summary.get("revenue_pln") or (getattr(scenario, "total_revenue_pln", None) if scenario else None),
        "costs_pln": summary.get("cost_pln") or (getattr(scenario, "total_cost_pln", None) if scenario else None),
        "income_pln": summary.get("taxable_base_pln") or (getattr(scenario, "taxable_base_pln", None) if scenario else None),
        "loss_pln": result.annual_summary.get("art30b", {}).get("pit38_loss", "0"),
        "estimated_tax_pln": summary.get("tax_19_pln") or (getattr(scenario, "tax_19_pln", None) if scenario else None),
        "scenario": result.primary_scenario,
    }
    source_items = source_trust_summary.get("items") or []
    active_sources = [item for item in source_items if item.get("usage_status") == "transaction_source"]
    vault_summary = defense_vault_summary.get("summary") or {}
    return {
        "tax_year": result.annual_summary.get("tax_year") or result.config.tax_year,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "result": result_payload,
        "health": result_health_check,
        "active_sources": active_sources,
        "no_overpay_summary": no_overpay_audit_v3.get("summary") or {},
        "risk_summary": {
            "review_items": result_health_check.get("review_reasons") or [],
            "warnings": result_health_check.get("warnings") or [],
            "advisor_questions": tax_advisor_brief.get("advisor_questions") or [],
        },
        "evidence_summary": {
            "available": vault_summary.get("available", 0),
            "missing": vault_summary.get("missing", 0),
            "partial": vault_summary.get("partial", 0),
            "advisor_review": vault_summary.get("advisor_review", 0),
        },
        "files": [
            {
                "source_id": item.get("source_id"),
                "file_name": item.get("file_name"),
                "usage_status": item.get("usage_status"),
                "file_hash": item.get("file_hash"),
            }
            for item in source_items
        ],
        "audit": {
            "audit_hash": result.audit_hash,
            "silnik_version": str(result.performance_profile.get("silnik_version") or "current"),
            "contract_version": "pit_trust_os_v1",
            "storage_version": "v2_pit_trust_os",
        },
    }


def _build_defense_case_file_v2(
    *,
    defense_case_file: dict[str, Any],
    no_overpay_audit_v2: dict[str, Any],
    legal_basis_registry: list[dict[str, Any]],
) -> dict[str, Any]:
    evidence_by_cost = {
        str(link.get("costId")): link
        for link in (defense_case_file.get("costEvidenceLinks") or [])
        if isinstance(link, dict) and link.get("costId")
    }
    legal_by_id = {entry.get("basisId"): entry for entry in legal_basis_registry}
    chains: list[dict[str, Any]] = []
    for cost in no_overpay_audit_v2.get("candidateCosts") or []:
        if not isinstance(cost, dict):
            continue
        cost_id = str(cost.get("costId") or "")
        evidence = evidence_by_cost.get(cost_id, {})
        legal_refs = _legal_refs_for_cost_kind(cost.get("kind"))
        chain = {
            "costId": cost_id,
            "label": cost.get("labelPl") or _cost_kind_label_pl(str(cost.get("kind") or "")),
            "kind": cost.get("kind"),
            "amountPln": cost.get("amountPln"),
            "sourceRecordId": cost.get("sourceId") or evidence.get("sourceRecordId"),
            "sourceFile": evidence.get("sourceFile"),
            "contextLabel": cost.get("allocationTarget") or evidence.get("linkedTradeIds") or "kontekst kosztu inwestycyjnego",
            "linkedTradeIds": evidence.get("linkedTradeIds") or ([] if not cost.get("allocationTarget") else [cost.get("allocationTarget")]),
            "defenseStatus": _defense_status_for_cost(cost, evidence_by_cost),
            "riskLevel": evidence.get("riskLevel") or _risk_for_cost(cost),
            "requiredEvidence": evidence.get("missingEvidence") or cost.get("notes") or [],
            "userAction": evidence.get("userActionLabel") or (
                "Zachowaj plik zrodlowy, identyfikator rekordu i opis zwiazku kosztu z inwestycja."
            ),
            "legalBasisRefs": legal_refs,
            "legalBasis": [legal_by_id[ref] for ref in legal_refs if ref in legal_by_id],
            "chainSteps": [
                {"step": "plik", "value": evidence.get("sourceFile") or cost.get("sourceId") or "brak pliku"},
                {"step": "raw_id", "value": cost.get("sourceId") or cost_id},
                {"step": "kwota", "value": cost.get("amountPln")},
                {"step": "kontekst", "value": cost.get("allocationTarget") or evidence.get("linkedTradeIds") or "wymaga opisu"},
                {"step": "scenariusz", "value": "aggressive_user" if cost.get("included") else "kandydat poza wynikiem"},
                {"step": "dowod", "value": evidence.get("defenseStatus") or "wymaga kontroli"},
                {"step": "ryzyko", "value": evidence.get("riskLevel") or _risk_for_cost(cost)},
            ],
        }
        chains.append(chain)

    high_risk_count = sum(1 for chain in chains if chain.get("riskLevel") == "high")
    missing_evidence_count = sum(1 for chain in chains if chain.get("defenseStatus") != "complete")
    return {
        "summary": {
            **(defense_case_file.get("summary") or {}),
            "defense_chain_count": len(chains),
            "high_risk_count": high_risk_count,
            "missing_evidence_count": missing_evidence_count,
            "legal_basis_count": len(legal_basis_registry),
        },
        "defenseChains": chains,
        "groupedEvidence": defense_case_file.get("defenseGroups") or [],
        "sourceManifests": defense_case_file.get("sourceManifests") or [],
        "recommendedActions": list(
            dict.fromkeys(
                [
                    *(defense_case_file.get("recommendedActions") or []),
                    *[chain.get("userAction") for chain in chains if chain.get("defenseStatus") != "complete"],
                ]
            )
        ),
    }


def _stable_broker_action_id(*parts: object) -> str:
    raw = "|".join(str(part or "").strip().lower() for part in parts)
    return f"BFAQ-{hashlib.sha1(raw.encode('utf-8')).hexdigest()[:12]}"


def _broker_action_item(
    *,
    prefix: str,
    severity: str,
    area: str,
    label: str,
    user_action: str,
    source_ids: list[str] | None = None,
    cost_ids: list[str] | None = None,
    history_search_term: str | None = None,
    reason: str = "",
) -> dict[str, Any]:
    source_ids = [str(value) for value in (source_ids or []) if value]
    cost_ids = [str(value) for value in (cost_ids or []) if value]
    return {
        "action_id": _stable_broker_action_id(prefix, severity, area, label, user_action, ",".join(source_ids), ",".join(cost_ids)),
        "severity": severity if severity in {"blocking", "warning", "info"} else "warning",
        "area": area,
        "label": label,
        "user_action": user_action,
        "source_ids": source_ids,
        "cost_ids": cost_ids,
        "history_search_term": history_search_term,
        "default_status": "open",
        "reason": reason,
        "user_status": "open",
        "user_note": None,
        "linked_row_id": None,
        "status_source": "silnik",
    }


def _source_ids_from_record(record: dict[str, Any]) -> list[str]:
    values: list[str] = []
    for key in ("sourceId", "source_id", "source", "sources"):
        value = record.get(key)
        if isinstance(value, list):
            values.extend(str(item) for item in value if item)
        elif value:
            values.append(str(value))
    return list(dict.fromkeys(values))


def _record_key(record: dict[str, Any]) -> str:
    for key in ("record_key", "recordKey", "key", "id", "field"):
        value = record.get(key)
        if value:
            return str(value)
    return ""


def _build_broker_file_action_queue(
    *,
    result: EngineRunResult,
    coverage_matrix: list[dict[str, Any]],
    import_intelligence_report: dict[str, Any],
    no_overpay_audit_v2: dict[str, Any],
    defense_case_file_v2: dict[str, Any],
) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []

    def add(row: dict[str, Any]) -> None:
        rows.append(row)

    for coverage in coverage_matrix:
        status = str(coverage.get("status") or "")
        if status not in {"missing", "partial", "conflict"}:
            continue
        severity = "warning" if status == "partial" else "blocking"
        label = f"{coverage.get('label') or coverage.get('area')}: {status}"
        add(
            _broker_action_item(
                prefix="coverage",
                severity=severity,
                area=f"coverage:{coverage.get('area') or 'unknown'}",
                label=label,
                user_action=str(coverage.get("recommendation") or "Uzupelnij albo zweryfikuj ten obszar danych brokera."),
                source_ids=[str(value) for value in coverage.get("sourceIds") or []],
                history_search_term=str(coverage.get("area") or "") or None,
                reason=f"coverage_matrix:{status}",
            )
        )

    for duplicate in import_intelligence_report.get("duplicates") or []:
        if not isinstance(duplicate, dict):
            continue
        key = _record_key(duplicate)
        add(
            _broker_action_item(
                prefix="duplicate",
                severity="warning",
                area="import:duplicates",
                label=f"Duplikat rekordu brokera{f': {key}' if key else ''}",
                user_action="Sprawdz, czy ten sam rekord nie zostal wgrany z dwoch plikow brokera.",
                source_ids=_source_ids_from_record(duplicate),
                history_search_term=key or None,
                reason="import_intelligence:duplicate",
            )
        )

    for conflict in import_intelligence_report.get("conflicts") or []:
        if not isinstance(conflict, dict):
            continue
        key = _record_key(conflict)
        add(
            _broker_action_item(
                prefix="conflict",
                severity="blocking",
                area="import:conflicts",
                label=f"Konflikt danych brokera{f': {key}' if key else ''}",
                user_action="Zweryfikuj, ktory plik brokera jest autorytatywny dla tego pola albo dodaj override.",
                source_ids=_source_ids_from_record(conflict),
                history_search_term=key or None,
                reason="import_intelligence:conflict",
            )
        )

    for section in import_intelligence_report.get("missingExpectedSections") or []:
        add(
            _broker_action_item(
                prefix="missing-section",
                severity="warning",
                area="import:missing_section",
                label=f"Brak oczekiwanej sekcji: {section}",
                user_action=f"Dodaj plik zawierajacy sekcje '{section}' albo potwierdz, ze nie dotyczy tego roku.",
                reason="import_intelligence:missing_section",
            )
        )

    for cost in no_overpay_audit_v2.get("potentiallyMissedCosts") or []:
        if not isinstance(cost, dict):
            continue
        cost_id = str(cost.get("costId") or "")
        add(
            _broker_action_item(
                prefix="missed-cost",
                severity="warning",
                area="no_overpay",
                label=str(cost.get("labelPl") or cost.get("kind") or cost_id or "Potencjalnie pominięty koszt"),
                user_action=str(cost.get("userAction") or cost.get("reason") or "Sprawdz, czy koszt ma dowod i powinien obnizyc podatek."),
                source_ids=[str(cost.get("sourceId"))] if cost.get("sourceId") else [],
                cost_ids=[cost_id] if cost_id else [],
                history_search_term=cost_id or str(cost.get("sourceId") or "") or None,
                reason="no_overpay:potentially_missed_cost",
            )
        )

    for chain in defense_case_file_v2.get("defenseChains") or []:
        if not isinstance(chain, dict):
            continue
        status = str(chain.get("defenseStatus") or "")
        if status == "complete":
            continue
        cost_id = str(chain.get("costId") or "")
        add(
            _broker_action_item(
                prefix="defense",
                severity="warning",
                area="defense",
                label=f"Dowod kosztu: {chain.get('label') or cost_id}",
                user_action=str(chain.get("userAction") or "Uzupelnij dowody i opis zwiazku kosztu z inwestycja."),
                source_ids=[str(chain.get("sourceRecordId"))] if chain.get("sourceRecordId") else [],
                cost_ids=[cost_id] if cost_id else [],
                history_search_term=cost_id or str(chain.get("sourceRecordId") or "") or None,
                reason=f"defense_case_file_v2:{status or 'missing'}",
            )
        )

    for issue in getattr(result.merge_result.ledger, "issues", []) or []:
        blocking = bool(getattr(issue, "blocking", False))
        severity = "blocking" if blocking else "warning"
        code = str(getattr(issue, "code", "") or "ISSUE")
        message = str(getattr(issue, "message", "") or code)
        source_id = str(getattr(issue, "scope_id", "") or "")
        add(
            _broker_action_item(
                prefix="issue",
                severity=severity,
                area=f"issue:{getattr(issue, 'stage', 'silnik')}",
                label=message,
                user_action="Sprawdz problem silnika i zweryfikuj dane zrodlowe.",
                source_ids=[source_id] if source_id else [],
                history_search_term=source_id or code,
                reason=f"issue:{code}",
            )
        )

    deduped: dict[str, dict[str, Any]] = {}
    for row in rows:
        deduped.setdefault(str(row["action_id"]), row)
    order = {"blocking": 0, "warning": 1, "info": 2}
    return sorted(deduped.values(), key=lambda row: (order.get(str(row.get("severity")), 3), str(row.get("area")), str(row.get("label"))))


def _apply_broker_file_action_overrides(
    rows: list[dict[str, Any]],
    request: TaxFilingRequest,
) -> list[dict[str, Any]]:
    overrides = {
        override.action_id: override
        for override in request.broker_file_action_overrides
        if override.action_id and override.status in {"open", "resolved", "ignored"}
    }
    enriched: list[dict[str, Any]] = []
    for row in rows:
        item = dict(row)
        override = overrides.get(str(item.get("action_id")))
        if override and (override.status != "ignored" or (override.user_note or "").strip()):
            item["user_status"] = override.status
            item["user_note"] = override.user_note
            item["linked_row_id"] = override.linked_row_id
            item["updated_at"] = override.updated_at
            item["status_source"] = "local_user"
        enriched.append(item)
    return enriched


def _build_defense_readiness(entries: list[dict[str, Any]]) -> dict[str, Any]:
    if not entries:
        return {
            "score": 100,
            "totalAggressiveItems": 0,
            "completeItems": 0,
            "missingEvidenceItems": 0,
            "highRiskItems": 0,
            "blockingWarnings": [],
            "actionItems": [],
            "status_counts": {},
            "kind_totals_pln": {},
            "duplicate_cost_ids": [],
        }

    status_counts: dict[str, int] = {}
    kind_totals: dict[str, Decimal] = {}
    seen: set[str] = set()
    duplicate_ids: list[str] = []
    score_total = Decimal("0")
    blocking_warnings: list[str] = []
    action_items: list[dict[str, Any]] = []

    for entry in entries:
        status = str(entry.get("defense_status") or "needs_user_evidence")
        status_counts[status] = status_counts.get(status, 0) + 1
        score_total += STATUS_SCORE_WEIGHTS.get(status, Decimal("50"))
        kind = str(entry.get("kind") or "UNKNOWN")
        amount = Decimal(str(entry.get("amount_pln") or "0"))
        kind_totals[kind] = kind_totals.get(kind, Decimal("0")) + amount
        cost_id = str(entry.get("cost_id") or "")
        if cost_id in seen and cost_id not in duplicate_ids:
            duplicate_ids.append(cost_id)
        seen.add(cost_id)
        if status in {"missing_link", "needs_user_evidence", "high_risk_review"} or entry.get("missing_evidence"):
            action_items.append(_build_action_item(entry))
        if status == "missing_link":
            blocking_warnings.append(_build_missing_link_warning(entry))
        if status == "high_risk_review":
            source_id = entry.get("source_id") or "brak identyfikatora źródła"
            blocking_warnings.append(
                f"{cost_id}: wysokie ryzyko wymaga przeglądu i pełnego kompletu dowodów; źródło {source_id}."
            )

    score = int((score_total / Decimal(len(entries))).quantize(Decimal("1")))
    return {
        "score": score,
        "totalAggressiveItems": len(entries),
        "completeItems": status_counts.get("complete", 0),
        "missingEvidenceItems": status_counts.get("needs_user_evidence", 0) + status_counts.get("missing_link", 0),
        "highRiskItems": status_counts.get("high_risk_review", 0),
        "blockingWarnings": blocking_warnings,
        "actionItems": action_items,
        "status_counts": status_counts,
        "kind_totals_pln": {kind: _decimal_text(value) for kind, value in sorted(kind_totals.items())},
        "duplicate_cost_ids": duplicate_ids,
    }


def _primary_scenario_result(result: EngineRunResult):
    if result.primary_scenario and result.primary_scenario in result.scenario_results:
        return result.scenario_results[result.primary_scenario]
    summary_scenario = result.annual_summary.get("primary_scenario")
    if summary_scenario and summary_scenario in result.scenario_results:
        return result.scenario_results[str(summary_scenario)]
    if "aggressive_user" in result.scenario_results:
        return result.scenario_results["aggressive_user"]
    return next(iter(result.scenario_results.values()), None)


def _summary_decimal(result: EngineRunResult, key: str, *, art30b_key: str | None = None, default: object = "0") -> Decimal:
    art30b = result.annual_summary.get("art30b", {})
    if art30b_key and art30b_key in art30b:
        return _to_decimal(art30b.get(art30b_key))
    if key in result.annual_summary:
        return _to_decimal(result.annual_summary.get(key))
    return _to_decimal(default)


def _ledger_row(
    *,
    line_id: str,
    section: str,
    label: str,
    amount_pln: Decimal,
    source: str,
    tax_effect: str,
    formula: str,
    inputs: dict[str, Any] | None = None,
    notes: list[str] | None = None,
) -> dict[str, Any]:
    return {
        "line_id": line_id,
        "section": section,
        "label": label,
        "amount_pln": _decimal_text(amount_pln),
        "source": source,
        "tax_effect": tax_effect,
        "formula": formula,
        "inputs": inputs or {},
        "notes": notes or [],
    }


def _build_tax_calculation_ledger(result: EngineRunResult, aggressive_cost_defense: list[dict[str, Any]]) -> dict[str, Any]:
    art30b = result.annual_summary.get("art30b", {})
    scenario = _primary_scenario_result(result)
    display_revenue = _summary_decimal(result, "pit38_rounded_revenue_pln", art30b_key="pit38_rounded_revenue_pln")
    display_cost = _summary_decimal(result, "pit38_rounded_cost_pln", art30b_key="pit38_rounded_cost_pln")
    display_income = _summary_decimal(result, "pit38_income", art30b_key="pit38_income")
    prior_year_losses_used = _summary_decimal(
        result,
        "prior_year_loss_used_pln",
        art30b_key="prior_year_loss_used_pln",
    )
    if scenario is not None:
        revenue = _to_decimal(scenario.total_revenue_pln)
        cost = _to_decimal(scenario.total_cost_pln)
        income = revenue - cost
        taxes_from_dane = _to_decimal(scenario.taxes_from_dane_pln)
        tax_19 = _to_decimal(scenario.tax_19_pln)
        taxable_base = _to_decimal(scenario.taxable_base_pln)
    else:
        revenue = display_revenue
        cost = display_cost
        income = display_income
        taxes_from_dane = _summary_decimal(result, "taxes_from_dane_pln")
        tax_19 = _summary_decimal(result, "tax_19_pln", art30b_key="tax_19_pln")
        taxable_base = max(income - prior_year_losses_used, Decimal("0.00"))
    display_base_from_rounded_totals = max(display_revenue - display_cost - prior_year_losses_used, Decimal("0.00"))
    aggressive_costs = sum(
        (_to_decimal(decision.amount_pln) for decision in result.cost_decisions if decision.included and decision.aggressive_only),
        Decimal("0.00"),
    )
    rows = [
        _ledger_row(
            line_id="REVENUE_TOTAL",
            section="PIT-38",
            label="Przychody PIT-38",
            amount_pln=revenue,
            source="fifo_realized_rows",
            tax_effect="PIT_COUNTED",
            formula="Suma przychodow z odpłatnego zbycia w roku podatkowym",
            inputs={
                "scenario_total_revenue_pln": getattr(scenario, "total_revenue_pln", None),
                "display_rounded_revenue_pln": art30b.get("pit38_rounded_revenue_pln"),
            },
            notes=["Ledger używa precyzyjnej kwoty scenariusza; zaokrąglenia kart raportu są tylko prezentacją."] if scenario is not None else [],
        ),
        _ledger_row(
            line_id="COST_TOTAL",
            section="PIT-38",
            label="Koszty PIT-38",
            amount_pln=cost,
            source="fifo_realized_rows + cost_policy_engine",
            tax_effect="PIT_COUNTED",
            formula="Suma kosztow rozpoznanych w scenariuszu aktywnym",
            inputs={
                "scenario_total_cost_pln": getattr(scenario, "total_cost_pln", None),
                "display_rounded_cost_pln": art30b.get("pit38_rounded_cost_pln"),
                "scenario": getattr(scenario, "scenario_name", None),
            },
            notes=["Ledger używa precyzyjnej kwoty scenariusza; zaokrąglenia kart raportu są tylko prezentacją."] if scenario is not None else [],
        ),
        _ledger_row(
            line_id="AGGRESSIVE_COST_TOTAL",
            section="Koszty scenariuszowe",
            label="Koszty aggressive_user",
            amount_pln=aggressive_costs,
            source="cost_policy_engine",
            tax_effect="SCENARIO_COST",
            formula="Suma pozycji kosztowych included=true i aggressive_only=true",
            inputs={"cost_ids": [entry.get("cost_id") for entry in aggressive_cost_defense if entry.get("policy_level") == "AGGRESSIVE_ONLY"]},
        ),
        _ledger_row(
            line_id="PRIOR_YEAR_LOSSES_USED",
            section="Odliczenia",
            label="Odliczone straty z lat ubieglych",
            amount_pln=prior_year_losses_used,
            source="prior_year_loss_ledger",
            tax_effect="PIT_COUNTED",
            formula="Strata z lat ubieglych uzyta do pomniejszenia podstawy w roku sprzedazy",
            inputs={"annual_summary": result.annual_summary.get("prior_year_loss_used_pln")},
        ),
        _ledger_row(
            line_id="TAXABLE_BASE",
            section="PIT-38",
            label="Podstawa opodatkowania",
            amount_pln=taxable_base,
            source="pit38_engine",
            tax_effect="PIT_COUNTED",
            formula="max(przychod - koszty - odliczone straty, 0)",
            inputs={"income": _decimal_text(income), "prior_year_losses_used": _decimal_text(prior_year_losses_used)},
        ),
        _ledger_row(
            line_id="TAX_19",
            section="PIT-38",
            label="Podatek 19%",
            amount_pln=tax_19,
            source="pit38_engine",
            tax_effect="PIT_COUNTED",
            formula="Podstawa opodatkowania * 19%",
            inputs={"taxable_base": _decimal_text(taxable_base)},
        ),
        _ledger_row(
            line_id="TAXES_FROM_DATA",
            section="Podatki z danych",
            label="Podatki wykazane w danych",
            amount_pln=taxes_from_dane,
            source="canonical_events",
            tax_effect="PIT_COUNTED",
            formula="Suma podatkow rozpoznanych w danych zrodlowych",
            inputs={"annual_summary": result.annual_summary.get("taxes_from_dane_pln")},
        ),
        _ledger_row(
            line_id="NET_AFTER_TAX",
            section="Wynik",
            label="Wynik netto scenariusza",
            amount_pln=(scenario.net_pln if scenario is not None else income - tax_19 - taxes_from_dane),
            source="scenario_results",
            tax_effect="ANALYTICAL_ONLY",
            formula="Wynik brutto scenariusza - podatek 19% - podatki z danych",
            inputs={"scenario": getattr(scenario, "scenario_name", None)},
        ),
    ]

    for entry in aggressive_cost_defense:
        rows.append(
            _ledger_row(
                line_id=f"AGG_COST_{entry.get('cost_id')}",
                section="Koszty aggressive_user",
                label=str(entry.get("kind") or "Koszt aggressive_user"),
                amount_pln=_to_decimal(entry.get("amount_pln")),
                source=str(entry.get("source_id") or "cost_policy_engine"),
                tax_effect="SCENARIO_COST",
                formula="Pozycja kosztowa z grafu obrony planu aggressive_user",
                inputs={
                    "cost_id": entry.get("cost_id"),
                    "defense_status": entry.get("defense_status"),
                    "linked_trade_id": entry.get("linked_trade_id"),
                },
                notes=list(entry.get("missing_evidence") or []),
            )
        )

    return {
        "version": 1,
        "tax_year": result.annual_summary.get("tax_year") or result.config.tax_year,
        "plan_used": result.plan_used,
        "primary_scenario": getattr(scenario, "scenario_name", None) or result.primary_scenario,
        "rows": rows,
        "metadata": {
            "audit_hash": result.audit_hash,
            "benchmark_policy": "benchmark_user_is_diagnostic_only",
            "explanation": "Ledger pokazuje wynik z danych i zasad. Nie dopasowuje obliczen do historycznej kwoty benchmarkowej.",
            "display_rounded_revenue_pln": _decimal_text(display_revenue),
            "display_rounded_cost_pln": _decimal_text(display_cost),
            "display_base_from_rounded_totals_pln": _decimal_text(display_base_from_rounded_totals),
            "precise_base_pln": _decimal_text(taxable_base),
        },
    }


def _ledger_amounts_by_id(ledger: dict[str, Any] | list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    rows = ledger.get("rows", []) if isinstance(ledger, dict) else ledger
    output: dict[str, dict[str, Any]] = {}
    if not isinstance(rows, list):
        return output
    for row in rows:
        if not isinstance(row, dict):
            continue
        line_id = str(row.get("line_id") or "")
        if not line_id:
            continue
        output[line_id] = row
    return output


def _build_result_delta_report(result: EngineRunResult, current_ledger: dict[str, Any]) -> dict[str, Any]:
    ledger_metadata = getattr(result.merge_result.ledger, "metadata", {}) or {}
    previous = ledger_metadata.get("previous_tax_calculation_ledger")
    if not previous:
        return {
            "status": "NO_BASELINE",
            "summary": "Brak poprzedniego snapshotu audytu. Biezacy wynik nie jest dopasowywany do zadnego benchmarku.",
            "rows": [],
        }
    current_rows = _ledger_amounts_by_id(current_ledger)
    previous_rows = _ledger_amounts_by_id(previous)
    delta_rows: list[dict[str, Any]] = []
    for line_id in sorted(set(current_rows) | set(previous_rows)):
        current = current_rows.get(line_id)
        old = previous_rows.get(line_id)
        if current and old:
            current_amount = _to_decimal(current.get("amount_pln"))
            old_amount = _to_decimal(old.get("amount_pln"))
            if current_amount == old_amount:
                continue
            delta_rows.append(
                {
                    "line_id": line_id,
                    "label": current.get("label") or old.get("label") or line_id,
                    "change_type": "changed",
                    "previous_amount_pln": _decimal_text(old_amount),
                    "current_amount_pln": _decimal_text(current_amount),
                    "delta_pln": _decimal_text(current_amount - old_amount),
                    "reason": "Kwota pozycji zmienila sie wzgledem poprzedniego snapshotu.",
                }
            )
        elif current:
            current_amount = _to_decimal(current.get("amount_pln"))
            delta_rows.append(
                {
                    "line_id": line_id,
                    "label": current.get("label") or line_id,
                    "change_type": "added",
                    "previous_amount_pln": None,
                    "current_amount_pln": _decimal_text(current_amount),
                    "delta_pln": _decimal_text(current_amount),
                    "reason": "Nowa pozycja w biezacym ledgerze kalkulacji.",
                }
            )
        elif old:
            old_amount = _to_decimal(old.get("amount_pln"))
            delta_rows.append(
                {
                    "line_id": line_id,
                    "label": old.get("label") or line_id,
                    "change_type": "removed",
                    "previous_amount_pln": _decimal_text(old_amount),
                    "current_amount_pln": None,
                    "delta_pln": _decimal_text(-old_amount),
                    "reason": "Pozycja byla w poprzednim snapshotcie, ale nie wystepuje w biezacym ledgerze.",
                }
            )
    return {
        "status": "CHANGED" if delta_rows else "UNCHANGED",
        "summary": (
            f"Wykryto {len(delta_rows)} zmian pozycji kalkulacji wzgledem poprzedniego snapshotu."
            if delta_rows
            else "Brak zmian kwotowych wzgledem poprzedniego snapshotu."
        ),
        "rows": delta_rows,
    }


def _build_defense_gap_summary(readiness: dict[str, Any], entries: list[dict[str, Any]]) -> dict[str, Any]:
    by_status = dict(readiness.get("status_counts") or {})
    by_kind: dict[str, int] = {}
    gaps: list[dict[str, Any]] = []
    for entry in entries:
        status = str(entry.get("defense_status") or "needs_user_evidence")
        kind = str(entry.get("kind") or "UNKNOWN")
        if status == "complete" and not entry.get("missing_evidence"):
            continue
        by_kind[kind] = by_kind.get(kind, 0) + 1
        gaps.append(
            {
                "cost_id": entry.get("cost_id"),
                "kind": kind,
                "defense_status": status,
                "defense_status_source": entry.get("defense_status_source"),
                "risk_level": entry.get("risk_level"),
                "missing_evidence": entry.get("missing_evidence") or [],
                "user_action_label": entry.get("user_action_label"),
                "user_note": entry.get("user_note"),
                "source_id": entry.get("source_id"),
                "linked_trade_id": entry.get("linked_trade_id"),
            }
        )
    return {
        "total_gaps": len(gaps),
        "by_status": by_status,
        "by_kind": by_kind,
        "gaps": gaps,
        "action_items": readiness.get("actionItems") or [],
    }


SUBMISSION_SEVERITY_PRIORITY = {
    "blocking": 0,
    "evidence": 1,
    "risk": 2,
    "info": 3,
}


def _submission_item(
    *,
    item_id: str,
    severity: str,
    category: str,
    label: str,
    user_action: str,
    linked_cost_id: str | None = None,
    linked_row_id: str | None = None,
    source_id: str | None = None,
) -> dict[str, Any]:
    item: dict[str, Any] = {
        "id": item_id,
        "severity": severity,
        "category": category,
        "label": label,
        "userAction": user_action,
    }
    if linked_cost_id:
        item["linkedCostId"] = linked_cost_id
    if linked_row_id:
        item["linkedRowId"] = linked_row_id
    if source_id:
        item["sourceId"] = source_id
    return item


def _dedupe_submission_items(items: list[dict[str, Any]]) -> list[dict[str, Any]]:
    seen: set[str] = set()
    unique: list[dict[str, Any]] = []
    for item in items:
        item_id = str(item.get("id") or "")
        if not item_id or item_id in seen:
            continue
        seen.add(item_id)
        unique.append(item)
    return unique


def _issue_is_blocking(issue: Issue, result: EngineRunResult) -> bool:
    if result.quality_report:
        return any(
            blocked.code == issue.code
            and blocked.scope_type == issue.scope_type
            and blocked.scope_id == issue.scope_id
            for blocked in result.quality_report.blocking_issues
        )
    return bool(issue.blocking)


def _issue_submission_category(issue: Issue) -> str:
    text = f"{issue.code} {issue.stage} {issue.scope_type} {issue.message}".upper()
    if "NBP" in text or "COVERAGE_GAP" in text or ("FX" in text and "GAP" in text):
        return "nbp"
    if "RECONCILE" in text or "RECONCILIATION" in text or "DEPO" in text:
        return "reconciliation"
    return "dane_quality"


def _collect_submission_issues(result: EngineRunResult) -> list[Issue]:
    issues: list[Issue] = []
    issues.extend(result.merge_result.ledger.issues)
    issues.extend(result.actionable_issues)
    if result.quality_report:
        issues.extend(result.quality_report.blocking_issues)
        issues.extend(result.quality_report.warning_issues)
    seen: set[tuple[str, str, str]] = set()
    unique: list[Issue] = []
    for issue in issues:
        key = (str(issue.code), str(issue.scope_type), str(issue.scope_id))
        if key in seen:
            continue
        seen.add(key)
        unique.append(issue)
    return unique


def _ledger_decimal(rows_by_id: dict[str, dict[str, Any]], line_id: str) -> Decimal:
    return _to_decimal((rows_by_id.get(line_id) or {}).get("amount_pln"))


def _build_ledger_consistency_items(tax_calculation_ledger: dict[str, Any]) -> list[dict[str, Any]]:
    rows_by_id = _ledger_amounts_by_id(tax_calculation_ledger)
    if not rows_by_id:
        return [
            _submission_item(
                item_id="calculation:missing_ledger",
                severity="blocking",
                category="calculation",
                label="Brak ledgeru kalkulacji podatku w pakiecie audytowym.",
                user_action="Przelicz raport i wygeneruj pełny pakiet audytowy przed złożeniem PIT.",
            )
        ]

    revenue = _ledger_decimal(rows_by_id, "REVENUE_TOTAL")
    cost = _ledger_decimal(rows_by_id, "COST_TOTAL")
    prior_losses = _ledger_decimal(rows_by_id, "PRIOR_YEAR_LOSSES_USED")
    taxable_base = _ledger_decimal(rows_by_id, "TAXABLE_BASE")
    tax_19 = _ledger_decimal(rows_by_id, "TAX_19")
    expected_base = max(revenue - cost - prior_losses, Decimal("0.00"))
    expected_tax = _q2(taxable_base * Decimal("0.19"))
    tolerance = Decimal("0.02")
    items: list[dict[str, Any]] = []
    metadata = tax_calculation_ledger.get("metadata", {}) if isinstance(tax_calculation_ledger, dict) else {}
    display_base = _to_decimal(metadata.get("display_base_from_rounded_totals_pln"))
    if abs(taxable_base - expected_base) > tolerance:
        items.append(
            _submission_item(
                item_id="calculation:taxable_base_mismatch",
                severity="blocking",
                category="calculation",
                label=(
                    "Niespójność podstawy opodatkowania: ledger nie zgadza się z formułą "
                    "przychód - koszty - straty z lat ubiegłych."
                ),
                user_action=(
                    f"Sprawdź ledger: oczekiwana podstawa {_decimal_text(expected_base)} PLN, "
                    f"w ledgerze {_decimal_text(taxable_base)} PLN."
                ),
            )
        )
    elif abs(display_base - taxable_base) > tolerance:
        items.append(
            _submission_item(
                item_id="calculation:display_rounding_delta",
                severity="info",
                category="calculation",
                label="Różnica wynika z zaokrąglenia prezentacyjnego przychodów i kosztów.",
                user_action=(
                    f"To informacja diagnostyczna: z zaokrąglonych kart wychodzi {_decimal_text(display_base)} PLN, "
                    f"a ledger scenariusza używa precyzyjnej podstawy {_decimal_text(taxable_base)} PLN."
                ),
            )
        )
    if abs(tax_19 - expected_tax) > tolerance:
        items.append(
            _submission_item(
                item_id="calculation:tax_19_mismatch",
                severity="blocking",
                category="calculation",
                label="Niespójność podatku 19% w ledgerze kalkulacji.",
                user_action=(
                    f"Sprawdź podatek: oczekiwane {_decimal_text(expected_tax)} PLN od podstawy "
                    f"{_decimal_text(taxable_base)} PLN, w ledgerze {_decimal_text(tax_19)} PLN."
                ),
            )
        )
    return items


def _defense_gap_to_submission_item(gap: dict[str, Any]) -> dict[str, Any]:
    cost_id = str(gap.get("cost_id") or "UNKNOWN")
    status = str(gap.get("defense_status") or "needs_user_evidence")
    kind = str(gap.get("kind") or "koszt agresywny")
    source_id = str(gap.get("source_id") or "")
    missing = [str(value) for value in gap.get("missing_evidence") or [] if value]
    if status == "high_risk_review":
        return _submission_item(
            item_id=f"defense:{cost_id}",
            severity="risk",
            category="defense",
            label=f"{cost_id}: koszt {kind} ma wysokie ryzyko podatkowe.",
            user_action=(
                "Sprawdź ryzyko planu agresywnego z doradcą i zachowaj pełny komplet dowodów przed złożeniem PIT."
            ),
            linked_cost_id=cost_id,
            source_id=source_id or None,
        )
    return _submission_item(
        item_id=f"defense:{cost_id}",
        severity="evidence",
        category="defense",
        label=(
            f"{cost_id}: brakuje dowodu lub powiązania dla kosztu {kind}. "
            f"Braki: {'; '.join(missing) if missing else 'wymaga opisu użytkownika'}."
        ),
        user_action=str(gap.get("user_action_label") or "Uzupełnij dowód lub opis kosztu przed złożeniem PIT."),
        linked_cost_id=cost_id,
        linked_row_id=str(gap.get("linked_trade_id") or "") or None,
        source_id=source_id or None,
    )


def _build_pit_submission_readiness(
    result: EngineRunResult,
    *,
    tax_calculation_ledger: dict[str, Any],
    defense_gap_summary: dict[str, Any],
    result_delta_report: dict[str, Any],
) -> dict[str, Any]:
    checklist: list[dict[str, Any]] = []

    for gap in result.fx_coverage_gaps:
        gap_blocks = bool(
            result.quality_report
            and any(
                issue.code == "NBP_COVERAGE_GAP"
                and str(issue.details.get("currency") or "").upper() == gap.currency.upper()
                for issue in result.quality_report.blocking_issues
            )
        )
        checklist.append(
            _submission_item(
                item_id=f"nbp:{gap.currency}:{_timestamp_text(gap.start_date)}:{_timestamp_text(gap.end_date)}",
                severity="blocking" if gap_blocks else "info",
                category="nbp",
                label=(
                    f"Brak pełnego pokrycia kursów NBP dla {gap.currency}: "
                    f"{_timestamp_text(gap.start_date)} - {_timestamp_text(gap.end_date)}."
                ),
                user_action=(
                    "Uzupełnij archiwum kursów NBP albo zawęź/popraw dane źródłowe przed złożeniem PIT."
                    if gap_blocks else "Kurs uzyskano poza lokalnym archiwum; zachowaj źródło kursu w dokumentacji."
                ),
                source_id=gap.provider_name,
            )
        )

    for issue in _collect_submission_issues(result):
        if not _issue_is_blocking(issue, result):
            continue
        checklist.append(
            _submission_item(
                item_id=f"issue:{issue.code}:{issue.scope_type}:{issue.scope_id}",
                severity="blocking",
                category=_issue_submission_category(issue),
                label=f"{issue.code}: {issue.message}",
                user_action="Wyjaśnij problem danych albo oznacz go świadomą korektą przed złożeniem PIT.",
                linked_row_id=issue.scope_id,
            )
        )

    checklist.extend(_build_ledger_consistency_items(tax_calculation_ledger))

    for gap in defense_gap_summary.get("gaps", []) or []:
        if not isinstance(gap, dict):
            continue
        checklist.append(_defense_gap_to_submission_item(gap))

    if result_delta_report.get("status") == "CHANGED":
        checklist.append(
            _submission_item(
                item_id="calculation:result_changed_since_previous_snapshot",
                severity="info",
                category="calculation",
                label=str(result_delta_report.get("summary") or "Wynik zmienił się względem poprzedniego snapshotu."),
                user_action="Przejrzyj raport różnic, żeby rozumieć zmianę wyniku przed wysłaniem PIT.",
            )
        )

    checklist = _dedupe_submission_items(checklist)
    checklist.sort(key=lambda item: SUBMISSION_SEVERITY_PRIORITY.get(str(item.get("severity")), 99))

    if any(item.get("severity") == "blocking" for item in checklist):
        verdict = "BLOCKED"
    elif any(item.get("severity") == "evidence" for item in checklist):
        verdict = "NEEDS_EVIDENCE"
    elif any(item.get("severity") == "risk" for item in checklist):
        verdict = "READY_WITH_RISK"
    else:
        verdict = "READY"

    blocking_count = sum(1 for item in checklist if item.get("severity") == "blocking")
    evidence_count = sum(1 for item in checklist if item.get("severity") == "evidence")
    risk_count = sum(1 for item in checklist if item.get("severity") == "risk")
    info_count = sum(1 for item in checklist if item.get("severity") == "info")
    score = max(0, min(100, 100 - blocking_count * 35 - evidence_count * 12 - risk_count * 6 - info_count * 2))

    return {
        "verdict": verdict,
        "score": score,
        "recommendedAction": checklist[0] if checklist else None,
        "checklist": checklist,
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "counts": {
            "blocking": blocking_count,
            "evidence": evidence_count,
            "risk": risk_count,
            "info": info_count,
        },
    }


TRACE_KIND_BY_LEDGER_LINE = {
    "REVENUE_TOTAL": "revenue",
    "COST_TOTAL": "base_cost",
    "AGGRESSIVE_COST_TOTAL": "aggressive_cost",
    "PRIOR_YEAR_LOSSES_USED": "prior_year_loss",
    "TAXES_FROM_DATA": "tax_paid",
    "TAX_19": "rounding",
    "TAXABLE_BASE": "rounding",
    "NET_AFTER_TAX": "delta",
}


def _trace_kind_for_ledger_row(row: dict[str, Any]) -> str:
    line_id = str(row.get("line_id") or "")
    if line_id.startswith("AGG_COST_"):
        return "aggressive_cost"
    return TRACE_KIND_BY_LEDGER_LINE.get(line_id, "delta")


def _trace_cost_id_from_ledger_row(row: dict[str, Any]) -> str | None:
    inputs = row.get("inputs") if isinstance(row.get("inputs"), dict) else {}
    if inputs.get("cost_id"):
        return str(inputs["cost_id"])
    line_id = str(row.get("line_id") or "")
    if line_id.startswith("AGG_COST_"):
        return line_id.removeprefix("AGG_COST_")
    return None


def _build_tax_trace_index(
    *,
    tax_calculation_ledger: dict[str, Any],
    defense_evidence_links: list[dict[str, Any]],
    pit_submission_readiness: dict[str, Any],
    result_delta_report: dict[str, Any],
) -> list[dict[str, Any]]:
    rows = tax_calculation_ledger.get("rows", [])
    ledger_rows = [row for row in rows if isinstance(row, dict)]
    evidence_by_id = {str(link.get("evidenceId")): link for link in defense_evidence_links if link.get("evidenceId")}
    evidence_by_cost_id: dict[str, list[dict[str, Any]]] = {}
    for link in defense_evidence_links:
        cost_id = str(link.get("costId") or "")
        if cost_id:
            evidence_by_cost_id.setdefault(cost_id, []).append(link)

    checklist = pit_submission_readiness.get("checklist", []) if isinstance(pit_submission_readiness, dict) else []
    checklist_by_cost_id: dict[str, list[dict[str, Any]]] = {}
    checklist_by_row_id: dict[str, list[dict[str, Any]]] = {}
    for item in checklist:
        if not isinstance(item, dict):
            continue
        linked_cost_id = str(item.get("linkedCostId") or "")
        linked_row_id = str(item.get("linkedRowId") or "")
        if linked_cost_id:
            checklist_by_cost_id.setdefault(linked_cost_id, []).append(item)
        if linked_row_id:
            checklist_by_row_id.setdefault(linked_row_id, []).append(item)

    trace_index: list[dict[str, Any]] = []
    covered_checklist_ids: set[str] = set()
    covered_delta_ids: set[str] = set()

    for row in ledger_rows:
        line_id = str(row.get("line_id") or "")
        if not line_id:
            continue
        kind = _trace_kind_for_ledger_row(row)
        cost_id = _trace_cost_id_from_ledger_row(row)
        evidence_links = evidence_by_cost_id.get(cost_id or "", [])
        checklist_items = checklist_by_cost_id.get(cost_id or "", []) + checklist_by_row_id.get(line_id, [])
        evidence_ids = [str(link.get("evidenceId")) for link in evidence_links if link.get("evidenceId")]
        checklist_item_ids = [str(item.get("id")) for item in checklist_items if item.get("id")]
        covered_checklist_ids.update(checklist_item_ids)

        source_record_ids: list[str] = []
        for link in evidence_links:
            for value in [
                link.get("sourceRecordId"),
                link.get("rawRowRef"),
                *(link.get("linkedTradeIds") or []),
            ]:
                if value and str(value) not in source_record_ids:
                    source_record_ids.append(str(value))
        if cost_id and cost_id not in source_record_ids:
            source_record_ids.append(cost_id)
        if row.get("source") and str(row.get("source")) not in {"cost_policy_engine", "fifo_realized_rows", "fifo_realized_rows + cost_policy_engine", "pit38_engine", "canonical_events", "scenario_results", "prior_year_loss_ledger"}:
            source_record_ids.append(str(row.get("source")))

        risk_level = None
        for evidence_id in evidence_ids:
            risk_level = evidence_by_id.get(evidence_id, {}).get("riskLevel")
            if risk_level:
                break

        trace_index.append(
            {
                "trace_id": f"trace:{kind}:{line_id}",
                "kind": kind,
                "label": row.get("label") or line_id,
                "amount_pln": row.get("amount_pln"),
                "ledger_row_ids": [line_id],
                "evidence_ids": evidence_ids,
                "checklist_item_ids": checklist_item_ids,
                "source_record_ids": source_record_ids,
                "tax_impact_kind": row.get("tax_effect"),
                "risk_level": risk_level,
                "explanation_pl": (
                    f"Pozycja '{row.get('label') or line_id}' pochodzi z ledgeru podatkowego {line_id}. "
                    f"Formuła: {row.get('formula') or 'brak formuły w danych'}."
                ),
            }
        )

    for item in checklist:
        if not isinstance(item, dict):
            continue
        item_id = str(item.get("id") or "")
        if not item_id or item_id in covered_checklist_ids:
            continue
        trace_index.append(
            {
                "trace_id": f"trace:checklist:{item_id}",
                "kind": "checklist",
                "label": item.get("label") or item_id,
                "amount_pln": None,
                "ledger_row_ids": [str(item.get("linkedRowId"))] if item.get("linkedRowId") else [],
                "evidence_ids": [],
                "checklist_item_ids": [item_id],
                "source_record_ids": [str(item.get("sourceId"))] if item.get("sourceId") else [],
                "tax_impact_kind": None,
                "risk_level": "high" if item.get("severity") == "blocking" else "medium",
                "explanation_pl": str(item.get("userAction") or "Pozycja checklisty PIT wymaga weryfikacji."),
            }
        )

    delta_rows = result_delta_report.get("rows", []) if isinstance(result_delta_report, dict) else []
    for row in delta_rows:
        if not isinstance(row, dict):
            continue
        line_id = str(row.get("line_id") or "")
        delta_key = f"{line_id}:{row.get('change_type')}"
        if not line_id or delta_key in covered_delta_ids:
            continue
        covered_delta_ids.add(delta_key)
        trace_index.append(
            {
                "trace_id": f"trace:delta:{delta_key}",
                "kind": "delta",
                "label": row.get("label") or line_id,
                "amount_pln": row.get("delta_pln"),
                "ledger_row_ids": [line_id],
                "evidence_ids": [],
                "checklist_item_ids": [],
                "source_record_ids": [],
                "tax_impact_kind": None,
                "risk_level": "medium",
                "explanation_pl": str(row.get("reason") or "Pozycja zmieniła wynik względem poprzedniego snapshotu."),
            }
        )

    return trace_index


def _stable_json_hash(payload: Any) -> str:
    encoded = json.dumps(
        payload,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
        default=str,
    ).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def _build_pit_case_file(
    result: EngineRunResult,
    *,
    aggressive_cost_defense: list[dict[str, Any]],
    defense_evidence_links: list[dict[str, Any]],
    defense_readiness: dict[str, Any],
    tax_calculation_ledger: dict[str, Any],
    result_delta_report: dict[str, Any],
    defense_gap_summary: dict[str, Any],
    pit_submission_readiness: dict[str, Any],
    tax_trace_index: list[dict[str, Any]],
) -> dict[str, Any]:
    tax_year = str(result.annual_summary.get("tax_year") or result.config.tax_year or "")
    audit_hash = str(result.audit_hash or "")
    input_fingerprint = _stable_json_hash(
        {
            "tax_year": tax_year,
            "plan_used": result.plan_used,
            "filing_profile": result.filing_profile,
            "primary_scenario": result.primary_scenario,
            "annual_summary": result.annual_summary,
            "cost_decisions": [
                {
                    "cost_id": decision.cost_id,
                    "plan_name": decision.plan_name,
                    "kind": decision.kind,
                    "included": decision.included,
                    "amount_pln": decision.amount_pln,
                    "aggressive_only": decision.aggressive_only,
                    "policy_level": decision.policy_level,
                }
                for decision in result.cost_decisions
            ],
            "issue_keys": [
                {
                    "code": issue.code,
                    "severity": issue.severity,
                    "stage": issue.stage,
                    "scope_id": issue.scope_id,
                }
                for issue in result.merge_result.ledger.issues
            ],
        }
    )
    calculation_fingerprint = _stable_json_hash(
        {
            "tax_calculation_ledger": tax_calculation_ledger,
            "result_delta_report": result_delta_report,
            "defense_gap_summary": defense_gap_summary,
            "pit_submission_readiness": pit_submission_readiness,
            "tax_trace_index": tax_trace_index,
            "defense_readiness": defense_readiness,
            "defense_evidence_links": defense_evidence_links,
            "aggressive_cost_defense": aggressive_cost_defense,
        }
    )
    warnings: list[str] = []
    if not audit_hash:
        warnings.append("Brak audit_hash w przebiegu; case file używa fingerprintu kalkulacji jako identyfikatora pomocniczego.")

    package_sections = {
        "tax_calculation_ledger_rows": len((tax_calculation_ledger or {}).get("rows", [])),
        "tax_trace_entries": len(tax_trace_index or []),
        "defense_evidence_links": len(defense_evidence_links or []),
        "aggressive_cost_defense_items": len(aggressive_cost_defense or []),
        "pit_submission_checklist_items": len((pit_submission_readiness or {}).get("checklist", [])),
        "result_delta_rows": len((result_delta_report or {}).get("rows", [])),
        "defense_gaps": int((defense_gap_summary or {}).get("total_gaps", 0) or 0),
        "silnik_issues": len(result.merge_result.ledger.issues),
    }
    return {
        "case_file_id": f"pit-case:{tax_year}:{(audit_hash or calculation_fingerprint)[:12]}",
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "tax_year": tax_year,
        "plan_used": result.plan_used,
        "filing_profile": result.filing_profile,
        "primary_scenario": result.primary_scenario,
        "audit_hash": audit_hash,
        "status": result.status,
        "filing_ready": result.filing_ready,
        "reproducible": bool(tax_calculation_ledger and tax_trace_index),
        "reproducibility_status": (
            "REPRODUCIBLE_FROM_AUDIT_PACKAGE"
            if tax_calculation_ledger and tax_trace_index
            else "INCOMPLETE_AUDIT_PACKAGE"
        ),
        "input_fingerprint": input_fingerprint,
        "calculation_fingerprint": calculation_fingerprint,
        "package_sections": package_sections,
        "included_artifacts": [
            "Tax_Calculation_Ledger",
            "Tax_Trace_Index",
            "Defense_Evidence_Links",
            "PIT_Submission_Checklist",
            "Result_Delta_Report",
            "PIT_Case_File",
            "Aggressive_Memorandum",
        ],
        "replay_instructions_pl": [
            "Odtworzenie: użyj tax_filing_package.json oraz arkuszy Tax_Calculation_Ledger, Tax_Trace_Index i PIT_Submission_Checklist.",
            "Porównaj audit_hash, input_fingerprint i calculation_fingerprint z aktualnym przebiegiem.",
            "Jeżeli fingerprint się zmienił, sprawdź Result_Delta_Report oraz nowe lub usunięte wiersze ledgera.",
            "Potwierdzenia dowodów użytkownika zmieniają status checklisty, ale nie zmieniają kwot PIT.",
        ],
        "warnings": warnings,
    }


def _build_aggressive_memorandum(
    result: EngineRunResult,
    entries: list[dict[str, Any]],
    readiness: dict[str, Any],
    pit_submission_readiness: dict[str, Any] | None = None,
) -> str:
    year = result.annual_summary.get("tax_year") or result.config.tax_year or "brak roku"
    lines = [
        f"# Memorandum aggressive_user PIT-38 za {year}",
        "",
        "## Założenia",
        "- Dokument opisuje material dowodowy i argumentacje dla planu aggressive_user.",
        "- Nie jest gwarancja akceptacji przez organ podatkowy; pozycje ryzykowne wymagaja zachowania dowodow.",
        f"- Wynik bazuje na audytowanym przebiegu silnika: {result.audit_hash or 'brak hasha'}.",
        "",
        "## Podstawy prawne",
    ]
    for basis in STANDARD_LEGAL_BASIS:
        lines.append(f"- {basis}")
    lines.extend(
        [
            "",
            "## Koszty",
        ]
    )
    for entry in entries:
        linked = entry.get("linked_trade") or {}
        linked_text = (
            f"{linked.get('trade_id')} / {linked.get('symbol')} / {linked.get('executed_at')}"
            if linked
            else "brak powiazanej transakcji"
        )
        lines.append(
            f"- {entry.get('cost_id')}: {entry.get('kind')}, kwota {entry.get('amount_pln')} PLN, "
            f"status {entry.get('defense_status_label_pl')} ({entry.get('defense_status_source') or ENGINE_DEFENSE_STATUS_SOURCE_PL}), "
            f"powiazanie: {linked_text}."
        )
        if entry.get("user_note"):
            lines.append(f"  Notatka użytkownika: {entry.get('user_note')}.")
    lines.extend(
        [
            "",
            "## Ryzyka",
            f"- Wynik gotowosci obrony: {readiness.get('score')} / 100.",
            f"- Pozycje wysokiego ryzyka: {readiness.get('highRiskItems')}.",
            f"- Pozycje wymagajace uzupelnienia dowodow lub linku: {readiness.get('missingEvidenceItems')}.",
            "",
            "## Dowody",
        ]
    )
    for entry in entries:
        missing = entry.get("missing_evidence") or []
        evidence = entry.get("recommended_evidence") or []
        lines.append(f"- {entry.get('cost_id')}: zalecane dowody: {'; '.join(evidence)}.")
        if entry.get("defense_status_source") == LOCAL_DEFENSE_STATUS_SOURCE_PL:
            lines.append("  Status dowodu: potwierdzone lokalnie przez użytkownika.")
        if missing:
            lines.append(f"  Braki do sprawdzenia: {'; '.join(missing)}.")
    if pit_submission_readiness:
        lines.extend(
            [
                "",
                "## Co zachować przed złożeniem",
                f"- Werdykt kontroli PIT: {pit_submission_readiness.get('verdict')}.",
                f"- Wynik checklisty: {pit_submission_readiness.get('score')} / 100.",
            ]
        )
        for item in pit_submission_readiness.get("checklist", [])[:10]:
            lines.append(
                f"- [{item.get('severity')}/{item.get('category')}] {item.get('label')} "
                f"Akcja: {item.get('userAction')}"
            )
    return "\n".join(lines)


def _pit_zg_additional_costs_by_country(
    result: EngineRunResult, fifo_rows: list[Any], scenario_name: str | None
) -> dict[str, Decimal]:
    """Rozdziel koszty scenariusza na kraje bez zmieniania kwot PIT-38."""
    scenario_name = scenario_name or getattr(result, "primary_scenario", "")
    scenario = (getattr(result, "scenario_results", None) or {}).get(scenario_name)
    if scenario is None:
        return {}

    trades_by_id = getattr(getattr(getattr(result, "merge_result", None), "ledger", None), "trades_by_id", None) or {}
    raw_net = sum(
        (
            _to_decimal(getattr(row, "gross_revenue_pln", 0))
            - _to_decimal(getattr(row, "cost_pln", 0))
            - _to_decimal(getattr(row, "sell_commission_alloc_pln", 0))
            for row in fifo_rows
        ),
        Decimal("0.00"),
    )
    # Kwota do rozdzielenia wynika z różnicy wobec poz. 28 minus poz. 29
    # scenariusza. Różnica między informacją PIT-8C a własnym rachunkiem części
    # polskiej należy do PL - nie jest kosztem wspólnym i nie może zmieniać
    # dochodu z USA czy Holandii; na koszty dzielimy tylko resztę.
    art30b = (getattr(result, "annual_summary", None) or {}).get("art30b", {}) or {}
    pit8c_adjustment = _q2(
        (_to_decimal(art30b.get("pit8c_revenue_pln")) - _to_decimal(art30b.get("pit8c_calculated_revenue_pln")))
        - (_to_decimal(art30b.get("pit8c_cost_pln")) - _to_decimal(art30b.get("pit8c_calculated_cost_pln")))
    )
    amount_to_allocate = _q2(raw_net - _to_decimal(scenario.gross_result_pln) + pit8c_adjustment)

    costs: dict[str, Decimal] = {}
    if pit8c_adjustment:
        costs["PL"] = -pit8c_adjustment
    if amount_to_allocate == 0:
        return costs
    plan_for_scenario = {
        "aggressive_user": "aggressive_user",
        "defensible": "balanced_user",
        "conservative": "conservative_user",
    }.get(scenario_name, scenario_name)
    included_cost_ids = {
        str(getattr(decision, "cost_id", ""))
        for decision in (getattr(result, "cost_decisions", None) or [])
        if getattr(decision, "included", False)
        and getattr(decision, "plan_name", None) == plan_for_scenario
    }

    # Koszt powiazany z konkretna transakcja (alokacja finansowania zakupu albo
    # pozycja z celem wskazujacym transakcje) trafia do kraju instrumentu. Cel,
    # ktory nie jest transakcja (np. "negative_cash_balance:USD:2026-01-27" przy
    # odsetkach od ujemnego salda), nie wskazuje kraju - taki koszt idzie do puli
    # wspolnej. Wczesniej trafial do "XX": na prawdziwych danych caly koszt
    # 6 180 zl, a dochod z USA i Holandii zostawal zawyzony.
    linked_costs: dict[str, Decimal] = {}

    def link(trade_id: object, amount: Decimal) -> None:
        trade = trades_by_id.get(str(trade_id or ""))
        # Zwrot/storno oplaty ma ujemna kwote i tez nalezy do kraju transakcji:
        # pominiety zawyzalby "powiazane" koszty i przesuwal czesc kosztu innego
        # kraju na kraj zwrotu.
        if trade is None or amount == 0:
            return
        country = _country_for_pit_zg_trade(trade)
        linked_costs[country] = linked_costs.get(country, Decimal("0.00")) + amount

    for allocation in getattr(result, "funding_fee_allocations", None) or []:
        if f"FUNDING-{getattr(allocation, 'allocation_id', '')}" not in included_cost_ids:
            continue
        link(getattr(allocation, "trade_id", ""), _to_decimal(getattr(allocation, "allocated_amount_pln", 0)))

    # Alokacje finansowania sa obsluzone wyzej, wiec ich pozycje pomijamy.
    for item in getattr(result, "cost_items", None) or []:
        cost_id = str(getattr(item, "cost_id", ""))
        target = getattr(item, "allocation_target", None)
        if not target or cost_id.startswith("FUNDING-") or cost_id not in included_cost_ids:
            continue
        link(target, _to_decimal(getattr(item, "amount_pln", 0)))

    linked_sum = sum(linked_costs.values(), Decimal("0.00"))
    # Powiazane koszty o roznych znakach (koszt jednego kraju, zwrot innego) nie
    # sa skalowane: skala przesunelaby tez zwrot. Trafiaja do krajow co do grosza,
    # a reszta ze znakiem (kwota - suma powiazanych) dzieli sie wedlug przychodu.
    if any(value > 0 for value in linked_costs.values()) and any(value < 0 for value in linked_costs.values()):
        linked_total = linked_sum
    elif amount_to_allocate > 0:
        linked_total = min(linked_sum, amount_to_allocate)
    elif linked_sum < 0:
        linked_total = max(linked_sum, amount_to_allocate)
    else:
        linked_total = Decimal("0.00")
    if linked_sum != 0 and linked_total != linked_sum:
        # Nadwyzka ponad kwote scenariusza nie moze zwiekszac kosztow zalacznika.
        scale = linked_total / linked_sum
        linked_costs = {country: _q2(value * scale) for country, value in linked_costs.items()}
        residual_fix = linked_total - sum(linked_costs.values(), Decimal("0.00"))
        if residual_fix:
            linked_costs[sorted(linked_costs)[-1]] += residual_fix
    for country, value in linked_costs.items():
        costs[country] = costs.get(country, Decimal("0.00")) + value

    residual = amount_to_allocate - linked_total
    if residual == 0:
        return costs

    revenue_by_country: dict[str, Decimal] = {}
    for row in fifo_rows:
        country = _country_for_pit_zg_trade(trades_by_id.get(getattr(row, "sell_trade_id", "")))
        revenue_by_country[country] = revenue_by_country.get(country, Decimal("0.00")) + _to_decimal(
            getattr(row, "gross_revenue_pln", 0)
        )
    total_revenue = sum((max(value, Decimal("0.00")) for value in revenue_by_country.values()), Decimal("0.00"))
    if total_revenue <= 0:
        costs[UNKNOWN_COUNTRY] = costs.get(UNKNOWN_COUNTRY, Decimal("0.00")) + residual
        return costs

    # Niepowiazane koszty wspolne dzielimy proporcjonalnie do przychodow ze
    # zbycia wedlug krajow (art. 22 ust. 1 i art. 30b ust. 5a-5b). Pozycje
    # 20-35 i 51 formularza sie nie zmieniaja.
    countries = sorted(revenue_by_country)
    allocated = Decimal("0.00")
    for country in countries[:-1]:
        share = max(revenue_by_country[country], Decimal("0.00")) / total_revenue
        portion = _q2(residual * share)
        costs[country] = costs.get(country, Decimal("0.00")) + portion
        allocated += portion
    last_country = countries[-1]
    costs[last_country] = costs.get(last_country, Decimal("0.00")) + residual - allocated
    return costs


def _country_for_pit_zg_trade(trade: Any) -> str:
    """Kraj instrumentu ta sama funkcja, ktora wiersze PIT/ZG przypisuja do panstw."""
    from investment_tax_engine.tax.pit_zg import _country_of_trade

    return _country_of_trade(trade)


def _pit_zg_rows_for_result(result: EngineRunResult, scenario_name: str | None = None) -> list[dict]:
    """Wiersze zalacznika PIT/ZG dla rozliczanego roku, po jednym na panstwo.

    Zalacznik jest dodatkiem do formularza, a nie warunkiem jego policzenia,
    wiec niepelny wynik (jak w testach jednostkowych samej czesci G) ma dac
    pusta liste, nie wywrocic budowania pakietu.
    """
    selected_year = getattr(getattr(result, "config", None), "tax_year", None)
    fifo_rows = [
        row
        for row in (getattr(result, "fifo_rows", None) or [])
        if selected_year is None or getattr(getattr(row, "sell_tax_date", None), "year", None) == selected_year
    ]
    ledger = getattr(getattr(result, "merge_result", None), "ledger", None)
    trades_by_id = getattr(ledger, "trades_by_id", None) or {}
    summary = getattr(result, "annual_summary", None) or {}
    additional_costs = _pit_zg_additional_costs_by_country(result, fifo_rows, scenario_name)
    return build_pit_zg_rows(
        fifo_rows,
        trades_by_id,
        foreign_tax_view=summary.get("foreign_tax_view") or getattr(result, "foreign_tax_view", None) or (),
        dividends_view=summary.get("dividends_view") or getattr(result, "dividends_view", None) or (),
        additional_costs_by_country=additional_costs,
    )


def _czesc_e_pola(result: EngineRunResult) -> tuple[list[TaxFormField], Decimal]:
    """
    Pozycje 36-45: waluty wirtualne (czesc E) i podatek od nich (czesc F).

    Numeracja za broszura MF do PIT-38 za 2025 r. Wartosci licza sie
    w tax/crypto_engine.py; tutaj tylko przepisujemy je na pola formularza,
    pilnujac, zeby poz. 39 wychodzila z poz. 36 - (37 + 38).
    """
    # Testy skladaja atrapy wyniku bez tego pola; prawdziwy EngineRunResult ma
    # je z wartoscia domyslna.
    czesc_e = getattr(result, "crypto_part_e", None) or {}
    przychod = _q2(_to_decimal(czesc_e.get("revenue_pln")))
    koszty_roku = _q2(_to_decimal(czesc_e.get("costs_current_year_pln")))
    koszty_z_lat = _q2(_to_decimal(czesc_e.get("costs_carried_in_pln")))
    # Brak dochodu w wyniku silnika dawal poz. 39 = 0 obok przychodu 1000 zl
    # w poz. 36 - formularz przeczyl wtedy wlasnym kwotom. Gdy silnik dochodu
    # nie poda, liczymy go z pozycji formularza: 36 - (37 + 38).
    dochod = (
        _q2(_to_decimal(czesc_e.get("income_pln")))
        if czesc_e.get("income_pln") is not None
        else _q2(max(przychod - (koszty_roku + koszty_z_lat), Decimal("0")))
    )
    do_przeniesienia = _q2(_to_decimal(czesc_e.get("costs_carried_out_pln")))
    podstawa = _q0(dochod)
    # Poz. 43 ma grosze (TKwota2, jak poz. 33); do pelnych zlotych zaokragla
    # sie dopiero podatek nalezny w poz. 45 = 43 - 44.
    podatek_od_podstawy = _q2(podstawa * Decimal("0.19"))
    podatek_zagraniczny = Decimal("0.00")
    podatek = _q0(max(podatek_od_podstawy - podatek_zagraniczny, Decimal("0")))

    pola = [
        TaxFormField(section="E", position="36", label="Przychód z odpłatnego zbycia walut wirtualnych", value=przychod),
        TaxFormField(section="E", position="37", label="Koszty uzyskania przychodów poniesione w roku podatkowym", value=koszty_roku),
        TaxFormField(section="E", position="38", label="Koszty z lat ubiegłych niepotrącone w poprzednim roku", value=koszty_z_lat),
        TaxFormField(section="E", position="39", label="Dochód z walut wirtualnych", value=dochod),
        TaxFormField(section="E", position="40", label="Koszty do potrącenia w roku następnym", value=do_przeniesienia),
        TaxFormField(section="F", position="41", label="Podstawa obliczenia podatku po zaokrągleniu", value=podstawa),
        TaxFormField(section="F", position="42", label="Stawka podatku", value="19%", value_type="percent"),
        TaxFormField(section="F", position="43", label="Podatek od dochodów, o których mowa w art. 30b ust. 1a", value=podatek_od_podstawy),
        TaxFormField(section="F", position="44", label="Podatek zapłacony za granicą (art. 30b ust. 5e i 5f)", value=podatek_zagraniczny),
        TaxFormField(section="F", position="45", label="Podatek należny po zaokrągleniu", value=podatek),
    ]
    return pola, podatek


def _pit8c_linked_plan_cost(result: EngineRunResult, scenario_name: str) -> Decimal:
    """Koszty wybranego planu przypisane do sprzedazy ujetej w PIT-8C."""
    art30b = result.annual_summary.get("art30b", {})
    sell_ids = set(art30b.get("pit8c_sell_trade_ids") or ())
    if not sell_ids:
        return Decimal("0.00")
    # Koszty z informacji PIT-8C obejmuja juz prowizje maklerskie - doliczenie
    # powiazanej prowizji do poz. 21 liczyloby ja tam drugi raz.
    pomijane_rodzaje = {"TRADE_COMMISSION"} if art30b.get("pit8c_source") == "informacja" else set()
    plan_name = {
        "defensible": "balanced_user",
        "conservative": "conservative_user",
    }.get(scenario_name, scenario_name)
    included_ids = {
        decision.cost_id for decision in result.cost_decisions
        if decision.included and decision.plan_name == plan_name
    }
    return _q2(sum(
        (_to_decimal(item.amount_pln) for item in result.cost_items
         if item.cost_id in included_ids and item.allocation_target in sell_ids
         and getattr(item, "kind", None) not in pomijane_rodzaje),
        Decimal("0.00"),
    ))


def _build_scenario_projection(result: EngineRunResult, scenario_name: str) -> TaxScenarioProjection:
    scenario = result.scenario_results[scenario_name]
    art30a = result.annual_summary.get("art30a", {})
    art30b = result.annual_summary.get("art30b", {})
    revenue = _to_decimal(scenario.total_revenue_pln)
    cost = _to_decimal(scenario.total_cost_pln)
    pit8c_revenue = _to_decimal(art30b.get("pit8c_revenue_pln"))
    pit8c_cost = _to_decimal(art30b.get("pit8c_cost_pln"))
    pit8c_cost += _pit8c_linked_plan_cost(result, scenario_name)
    income = max(_to_decimal(scenario.gross_result_pln), Decimal("0"))
    loss = abs(_to_decimal(scenario.gross_result_pln)) if _to_decimal(scenario.gross_result_pln) < 0 else Decimal("0")
    # Pozycja 30 byla wpisana na sztywno jako zero, a pozycja 31 juz uwzgledniala
    # odliczenie. Formularz sie wtedy nie domykal: poz. 28 - poz. 30 nie dawalo
    # poz. 31, wiec przepisane zeznanie urzad przeliczylby na wyzsza podstawe.
    prior_losses_used = _q2(max(income - _to_decimal(scenario.taxable_base_pln), Decimal("0")))
    rounded_base = _q0(max(_to_decimal(scenario.taxable_base_pln), Decimal("0")))
    silnik_tax = _to_decimal(scenario.tax_19_pln)
    rounded_tax_from_base = _q2(rounded_base * Decimal("0.19"))
    gross_dividend = _to_decimal(art30a.get("gross_dividends_pln"))
    # Do odliczenia bierzemy kwote po limicie stawki umownej, jesli silnik ja
    # policzyl. Starsze wyniki jej nie maja, wiec wtedy zostaje kwota pobrana.
    foreign_tax_paid = _to_decimal(
        art30a.get("foreign_withholding_creditable_pln")
        if art30a.get("foreign_withholding_creditable_pln") is not None
        else art30a.get("foreign_withholding_tax_pln")
    )
    foreign_dividend_tax = _q2(gross_dividend * Decimal("0.19"))
    # Podatek zaplacony za granica odlicza sie do wysokosci polskiego podatku
    # od tego samego dochodu (metoda proporcjonalnego odliczenia). Nadwyzka -
    # gdy stawka zrodla przekracza 19% - nie zmniejsza podatku i nie ma na
    # formularzu wlasnej pozycji; po prostu przepada. Wyliczamy ja mimo to,
    # zeby pokazac ja uzytkownikowi poza formularzem.
    foreign_credit = min(foreign_tax_paid, foreign_dividend_tax)
    foreign_tax_excess = _q2(max(foreign_tax_paid - foreign_dividend_tax, Decimal("0")))
    # Roznica miedzy polskimi 19% a podatkiem zaplaconym u zrodla jest doplata
    # nalezna w Polsce. Bez niej pozycje 47 i 48 stalyby obok siebie, a ich
    # roznica nie trafialaby do zadnej sumy.
    dividend_tax_due = _q2(max(foreign_dividend_tax - foreign_credit, Decimal("0")))
    # Odsetki od wolnych srodkow: art. 30a ust. 1 pkt 3, wiec ich podatek
    # zaokragla sie do pelnych groszy w gore, a nie do pelnych zlotych.
    # Skladniki licza sie osobno i sumuja po zaokragleniu - tak jak kazda inna
    # pozycja formularza (Ordynacja art. 63 par. 1).
    gross_credit_interest = _to_decimal(art30a.get("gross_credit_interest_pln"))
    credit_interest_tax = _q2_up(gross_credit_interest * Decimal("0.19"))
    # Kazdy podatek zaokragla sie do pelnych zlotych osobno (Ordynacja podatkowa
    # art. 63 par. 1), a suma jest suma zaokraglonych pozycji formularza.
    # Zaokraglanie dopiero sumy dawalo o zlotowke wiecej: 6523,46 + 0,14 to
    # 6524, podczas gdy sam podatek z art. 30b w pozycji 35 wynosil 6523.
    # Podatek z czesci F (waluty wirtualne) jest osobna pozycja deklaracji
    # i wchodzi do kwoty do zaplaty. Bez niego poz. 51 byla nizsza od sumy
    # podatkow nalicznych w formularzu.
    czesc_e_pola, czesc_e_podatek = _czesc_e_pola(result)
    # Poz. 34: podatek zaplacony za granica od dochodow z art. 30b, ograniczony
    # limitem proporcjonalnym liczonym osobno dla kazdego panstwa. U inwestora
    # na rynku amerykanskim jest to zwykle zero - zysk ze zbycia akcji nie jest
    # tam opodatkowany u zrodla - ale pole musi istniec i byc policzone.
    pit_zg_rows = _pit_zg_rows_for_result(result, scenario_name)
    foreign_capital_tax_credit_pln = foreign_capital_tax_credit(
        pit_zg_rows, rounded_tax_from_base, income
    )
    # Poz. 35 = poz. 33 - poz. 34 (broszura MF). Wczesniej stalo tu samo
    # `_q0(rounded_tax_from_base)`: podatek zaplacony za granica wchodzil do
    # poz. 34, ale nie pomniejszal ani poz. 35, ani kwoty do zaplaty w poz. 51.
    tax_due = _q0(max(rounded_tax_from_base - foreign_capital_tax_credit_pln, Decimal("0")))
    total_tax_due = tax_due + czesc_e_podatek + _q0(dividend_tax_due) + credit_interest_tax

    return TaxScenarioProjection(
        scenario_name=scenario_name,
        revenue_pln=revenue,
        cost_pln=cost,
        income_pln=income,
        rounded_base_pln=rounded_base,
        silnik_tax_pln=silnik_tax,
        rounded_tax_from_base_pln=rounded_tax_from_base,
        tax_due_pln=tax_due,
        gross_dividend_pln=gross_dividend,
        foreign_dividend_tax_pln=foreign_dividend_tax,
        foreign_tax_credit_pln=foreign_credit,
        foreign_tax_excess_pln=foreign_tax_excess,
        form_fields=[
            # Numeracja za broszura MF do PIT-38 za 2025 r. Wiersz 1 czesci C to
            # kwoty z otrzymanej informacji PIT-8C, wiersz 2 - przychody bez tej
            # informacji (w tym zagraniczne), wiersz 3 - ulga IPO z art. 21
            # ust. 1 pkt 105a. Poz. 24 i 25 nie sa "dochodem z PIT-8C": to kwoty
            # ODEJMOWANE w poz. 26 i 27.
            TaxFormField(section="C", position="20", label="Przychody z informacji PIT-8C (jej poz. 35)", value=pit8c_revenue),
            TaxFormField(section="C", position="21", label="Koszty z informacji PIT-8C (jej poz. 36) i inne koszty do poz. 20", value=pit8c_cost),
            TaxFormField(section="C", position="22", label="Przychody bez informacji PIT-8C, w tym zagraniczne", value=revenue - pit8c_revenue),
            TaxFormField(section="C", position="23", label="Koszty uzyskania przychodów z poz. 22", value=cost - pit8c_cost),
            TaxFormField(section="C", position="24", label="Przychody objęte ulgą IPO (art. 21 ust. 1 pkt 105a)", value=Decimal("0")),
            TaxFormField(section="C", position="25", label="Koszty uzyskania przychodów z poz. 24", value=Decimal("0")),
            TaxFormField(section="C", position="26", label="Razem przychody art. 30b", value=revenue),
            TaxFormField(section="C", position="27", label="Razem koszty art. 30b", value=cost),
            TaxFormField(section="C", position="28", label="Dochód", value=income),
            TaxFormField(section="C", position="29", label="Strata", value=loss),
            TaxFormField(section="D", position="30", label="Odliczone straty z lat ubiegłych", value=prior_losses_used),
            TaxFormField(section="D", position="31", label="Podstawa opodatkowania po zaokrągleniu", value=rounded_base),
            TaxFormField(section="D", position="32", label="Stawka podatku", value="19%", value_type="percent"),
            TaxFormField(section="D", position="33", label="Podatek 19% liczony od zaokrąglonej podstawy", value=rounded_tax_from_base),
            # Poz. 34 to podatek zaplacony za granica od dochodow z art. 30b
            # ust. 5a i 5b, a nie ogolne "odliczenia od podatku". Wartosc bierze
            # sie z zalacznika PIT/ZG i jest ograniczona limitem proporcjonalnym.
            TaxFormField(section="D", position="34", label="Podatek zapłacony za granicą (art. 30b ust. 5a i 5b)", value=foreign_capital_tax_credit_pln),
            TaxFormField(section="D", position="35", label="Podatek należny po zaokrągleniu", value=tax_due),
            # Poz. 36 nalezy juz do czesci E (przychod z walut wirtualnych),
            # a nie do czesci D. Stalo tu "Podatek do zaplaty" - kwota do
            # zaplaty to poz. 51.
            *czesc_e_pola,
            TaxFormField(section="G", position="46", label="Zryczałtowany podatek (art. 29, 30, 30a) niepobrany przez płatnika, poza poz. 47 i 48", value=Decimal("0")),
            TaxFormField(section="G", position="47", label="Podatek 19% od dywidend i odsetek zagranicznych (art. 30a ust. 1 pkt 1-5)", value=_q2(foreign_dividend_tax + credit_interest_tax)),
            TaxFormField(section="G", position="48", label="Podatek zapłacony za granicą od dywidendy", value=foreign_credit),
            # Broszura MF do PIT-38: poz. 49 to "roznica pomiedzy zryczaltowanym
            # podatkiem a podatkiem zaplaconym za granica", czyli 47 - 48 - kwota
            # do doplaty. Wpisywalismy tu nadwyzke podatku zagranicznego, czyli
            # roznice liczona w druga strone; na wyciagu z 15% WHT z USA obie sa
            # niezerowe, wiec do formularza szla po prostu zla liczba.
            TaxFormField(section="G", position="49", label="Różnica między podatkiem zryczałtowanym a zapłaconym za granicą", value=_q0(dividend_tax_due) + credit_interest_tax),
            TaxFormField(section="G", position="50", label="Zaliczki przekazane spółce nieruchomościowej", value=Decimal("0")),
            TaxFormField(section="G", position="51", label="Kwota do zapłaty", value=total_tax_due),
            TaxFormField(section="G", position="52", label="Nadpłata", value=Decimal("0")),
        ],
    )


def populate_form_summary(result: EngineRunResult) -> None:
    """Udostepnij zwyklemu przebiegowi te same pozycje co projekcja pakietu."""
    scenario_name = result.primary_scenario
    if scenario_name not in result.scenario_results:
        return
    projection = _build_scenario_projection(result, scenario_name)
    # Komplet pozycji, nie wybrane. Sama poz. 31 i 45-51 wygladaly dla
    # eksportu XML jak pelna mapa formularza: brakujace poz. 20-29 dostawaly
    # zero obok dodatniej podstawy w poz. 31 (formularz sprzeczny sam ze soba).
    fields = {field.position: str(field.value) for field in projection.form_fields}
    result.annual_summary["pit38_form_fields"] = fields
    # Wiersze zalacznika PIT/ZG z tej samej funkcji co poz. 34. Eksport XML
    # ustalal panstwo sam - z sufiksu tickera albo waluty - wiec NBIS.US
    # (spolka holenderska, ISIN NL) trafial do "US", a silnik liczyl go jako NL.
    result.annual_summary["pit_zg_rows"] = [
        {
            "country": str(row["country"]),
            "income_pln": str(_q2(_to_decimal(row["income_pln"]))),
            "loss_pln": str(_q2(_to_decimal(row["loss_pln"]))),
            "foreign_tax_pln": str(_q2(_to_decimal(row["foreign_tax_pln"]))),
        }
        for row in _pit_zg_rows_for_result(result)
    ]
    result.annual_summary["pit38_form_total_tax_to_pay_pln"] = fields["51"]


def _build_fallback_projection_from_summary(result: EngineRunResult) -> TaxScenarioProjection:
    art30a = result.annual_summary.get("art30a", {})
    art30b = result.annual_summary.get("art30b", {})
    pit8c_revenue = _to_decimal(art30b.get("pit8c_revenue_pln"))
    pit8c_cost = _to_decimal(art30b.get("pit8c_cost_pln"))
    pit8c_cost += _pit8c_linked_plan_cost(result, result.primary_scenario or result.plan_used or "aggressive_user")
    revenue = _to_decimal(result.annual_summary.get("pit38_rounded_revenue_pln"))
    cost = _to_decimal(result.annual_summary.get("pit38_rounded_cost_pln"))
    income = _to_decimal(result.annual_summary.get("pit38_income"))
    loss = _to_decimal(
        result.annual_summary.get("pit38_loss")
        if result.annual_summary.get("pit38_loss") is not None
        else result.annual_summary.get("art30b", {}).get("pit38_loss")
    )
    # Pozycja 30 byla wpisana na sztywno jako zero, a pozycja 31 juz uwzgledniala
    # odliczenie. Formularz sie wtedy nie domykal: poz. 28 - poz. 30 nie dawalo
    # poz. 31, wiec przepisane zeznanie urzad przeliczylby na wyzsza podstawe.
    prior_losses_used = _q2(_to_decimal(result.annual_summary.get("prior_year_loss_used_pln")))
    rounded_base = _q0(income)
    silnik_tax = _to_decimal(result.annual_summary.get("tax_19_pln"))
    rounded_tax_from_base = _q2(rounded_base * Decimal("0.19"))
    gross_dividend = _to_decimal(art30a.get("gross_dividends_pln"))
    # Do odliczenia bierzemy kwote po limicie stawki umownej, jesli silnik ja
    # policzyl. Starsze wyniki jej nie maja, wiec wtedy zostaje kwota pobrana.
    foreign_tax_paid = _to_decimal(
        art30a.get("foreign_withholding_creditable_pln")
        if art30a.get("foreign_withholding_creditable_pln") is not None
        else art30a.get("foreign_withholding_tax_pln")
    )
    foreign_dividend_tax = _q2(gross_dividend * Decimal("0.19"))
    foreign_credit = min(foreign_tax_paid, foreign_dividend_tax)
    foreign_tax_excess = _q2(max(foreign_tax_paid - foreign_dividend_tax, Decimal("0")))
    dividend_tax_due = _q2(max(foreign_dividend_tax - foreign_credit, Decimal("0")))
    # Odsetki od wolnych srodkow: art. 30a ust. 1 pkt 3, wiec ich podatek
    # zaokragla sie do pelnych groszy w gore, a nie do pelnych zlotych.
    # Skladniki licza sie osobno i sumuja po zaokragleniu - tak jak kazda inna
    # pozycja formularza (Ordynacja art. 63 par. 1).
    gross_credit_interest = _to_decimal(art30a.get("gross_credit_interest_pln"))
    credit_interest_tax = _q2_up(gross_credit_interest * Decimal("0.19"))
    # Kazdy podatek zaokragla sie do pelnych zlotych osobno (Ordynacja podatkowa
    # art. 63 par. 1), a suma jest suma zaokraglonych pozycji formularza.
    # Zaokraglanie dopiero sumy dawalo o zlotowke wiecej: 6523,46 + 0,14 to
    # 6524, podczas gdy sam podatek z art. 30b w pozycji 35 wynosil 6523.
    # Podatek z czesci F (waluty wirtualne) jest osobna pozycja deklaracji
    # i wchodzi do kwoty do zaplaty. Bez niego poz. 51 byla nizsza od sumy
    # podatkow nalicznych w formularzu.
    czesc_e_pola, czesc_e_podatek = _czesc_e_pola(result)
    # Poz. 34: podatek zaplacony za granica od dochodow z art. 30b, ograniczony
    # limitem proporcjonalnym liczonym osobno dla kazdego panstwa. U inwestora
    # na rynku amerykanskim jest to zwykle zero - zysk ze zbycia akcji nie jest
    # tam opodatkowany u zrodla - ale pole musi istniec i byc policzone.
    pit_zg_rows = _pit_zg_rows_for_result(result)
    foreign_capital_tax_credit_pln = foreign_capital_tax_credit(
        pit_zg_rows, rounded_tax_from_base, income
    )
    # Poz. 35 = poz. 33 - poz. 34 (broszura MF). Wczesniej stalo tu samo
    # `_q0(rounded_tax_from_base)`: podatek zaplacony za granica wchodzil do
    # poz. 34, ale nie pomniejszal ani poz. 35, ani kwoty do zaplaty w poz. 51.
    tax_due = _q0(max(rounded_tax_from_base - foreign_capital_tax_credit_pln, Decimal("0")))
    total_tax_due = tax_due + czesc_e_podatek + _q0(dividend_tax_due) + credit_interest_tax

    return TaxScenarioProjection(
        scenario_name=result.primary_scenario or result.plan_used or "aggressive_user",
        revenue_pln=revenue,
        cost_pln=cost,
        income_pln=income,
        rounded_base_pln=rounded_base,
        silnik_tax_pln=silnik_tax,
        rounded_tax_from_base_pln=rounded_tax_from_base,
        tax_due_pln=tax_due,
        gross_dividend_pln=gross_dividend,
        foreign_dividend_tax_pln=foreign_dividend_tax,
        foreign_tax_credit_pln=foreign_credit,
        foreign_tax_excess_pln=foreign_tax_excess,
        form_fields=[
            # Numeracja za broszura MF do PIT-38 za 2025 r. Wiersz 1 czesci C to
            # kwoty z otrzymanej informacji PIT-8C, wiersz 2 - przychody bez tej
            # informacji (w tym zagraniczne), wiersz 3 - ulga IPO z art. 21
            # ust. 1 pkt 105a. Poz. 24 i 25 nie sa "dochodem z PIT-8C": to kwoty
            # ODEJMOWANE w poz. 26 i 27.
            TaxFormField(section="C", position="20", label="Przychody z informacji PIT-8C (jej poz. 35)", value=pit8c_revenue),
            TaxFormField(section="C", position="21", label="Koszty z informacji PIT-8C (jej poz. 36) i inne koszty do poz. 20", value=pit8c_cost),
            TaxFormField(section="C", position="22", label="Przychody bez informacji PIT-8C, w tym zagraniczne", value=revenue - pit8c_revenue),
            TaxFormField(section="C", position="23", label="Koszty uzyskania przychodów z poz. 22", value=cost - pit8c_cost),
            TaxFormField(section="C", position="24", label="Przychody objęte ulgą IPO (art. 21 ust. 1 pkt 105a)", value=Decimal("0")),
            TaxFormField(section="C", position="25", label="Koszty uzyskania przychodów z poz. 24", value=Decimal("0")),
            TaxFormField(section="C", position="26", label="Razem przychody art. 30b", value=revenue),
            TaxFormField(section="C", position="27", label="Razem koszty art. 30b", value=cost),
            TaxFormField(section="C", position="28", label="Dochód", value=income),
            # Strata roku byla tu wpisana na sztywno jako zero, chociaz
            # podsumowanie ja niesie (`pit38_loss`) - formularz przeczyl
            # wlasnym kwotom przychodu i kosztu, a strata do rozliczenia
            # w kolejnych latach znikala.
            TaxFormField(section="C", position="29", label="Strata", value=loss),
            TaxFormField(section="D", position="30", label="Odliczone straty z lat ubiegłych", value=prior_losses_used),
            TaxFormField(section="D", position="31", label="Podstawa opodatkowania po zaokrągleniu", value=rounded_base),
            TaxFormField(section="D", position="32", label="Stawka podatku", value="19%", value_type="percent"),
            TaxFormField(section="D", position="33", label="Podatek 19% liczony od zaokrąglonej podstawy", value=rounded_tax_from_base),
            # Poz. 34 to podatek zaplacony za granica od dochodow z art. 30b
            # ust. 5a i 5b, a nie ogolne "odliczenia od podatku". Wartosc bierze
            # sie z zalacznika PIT/ZG i jest ograniczona limitem proporcjonalnym.
            TaxFormField(section="D", position="34", label="Podatek zapłacony za granicą (art. 30b ust. 5a i 5b)", value=foreign_capital_tax_credit_pln),
            TaxFormField(section="D", position="35", label="Podatek należny po zaokrągleniu", value=tax_due),
            # Poz. 36 nalezy juz do czesci E (przychod z walut wirtualnych),
            # a nie do czesci D. Stalo tu "Podatek do zaplaty" - kwota do
            # zaplaty to poz. 51.
            *czesc_e_pola,
            TaxFormField(section="G", position="46", label="Zryczałtowany podatek (art. 29, 30, 30a) niepobrany przez płatnika, poza poz. 47 i 48", value=Decimal("0")),
            TaxFormField(section="G", position="47", label="Podatek 19% od dywidend i odsetek zagranicznych (art. 30a ust. 1 pkt 1-5)", value=_q2(foreign_dividend_tax + credit_interest_tax)),
            TaxFormField(section="G", position="48", label="Podatek zapłacony za granicą od dywidendy", value=foreign_credit),
            # Broszura MF do PIT-38: poz. 49 to "roznica pomiedzy zryczaltowanym
            # podatkiem a podatkiem zaplaconym za granica", czyli 47 - 48 - kwota
            # do doplaty. Wpisywalismy tu nadwyzke podatku zagranicznego, czyli
            # roznice liczona w druga strone; na wyciagu z 15% WHT z USA obie sa
            # niezerowe, wiec do formularza szla po prostu zla liczba.
            TaxFormField(section="G", position="49", label="Różnica między podatkiem zryczałtowanym a zapłaconym za granicą", value=_q0(dividend_tax_due) + credit_interest_tax),
            TaxFormField(section="G", position="50", label="Zaliczki przekazane spółce nieruchomościowej", value=Decimal("0")),
            TaxFormField(section="G", position="51", label="Kwota do zapłaty", value=total_tax_due),
            TaxFormField(section="G", position="52", label="Nadpłata", value=Decimal("0")),
        ],
    )


def _zglos_zalaczniki_bez_kraju(result: EngineRunResult) -> None:
    """Zalacznik PIT/ZG bez ustalonego panstwa zrodla zatrzymuje pakiet.

    `_country_of_trade` oddaje "XX", gdy ani ISIN, ani symbol nie wskazuja
    panstwa. Taki wiersz wchodzil do zalacznika jako kod kraju "XX", ktorego
    slownik KodyKrajow nie zna, a jego podatek powiekszal odliczenie w poz. 34.
    """
    bez_kraju = [
        row
        for row in _pit_zg_rows_for_result(result)
        if str(row.get("country") or "").upper() == UNKNOWN_COUNTRY
        and (_to_decimal(row.get("income_pln")) != 0 or _to_decimal(row.get("foreign_tax_pln")) != 0)
    ]
    if not bez_kraju:
        return
    dochod = sum((_to_decimal(row.get("income_pln")) for row in bez_kraju), Decimal("0"))
    podatek = sum((_to_decimal(row.get("foreign_tax_pln")) for row in bez_kraju), Decimal("0"))
    # Sam wiersz "XX" nie mowi, ktore transakcje poprawic - uzytkownik widzial
    # tylko kwote 160,18 zl bez symbolu noty, ktora ja dala.
    selected_year = getattr(getattr(result, "config", None), "tax_year", None)
    symbole = symbole_bez_kraju(
        [
            row
            for row in (getattr(result, "fifo_rows", None) or [])
            if selected_year is None or getattr(getattr(row, "sell_tax_date", None), "year", None) == selected_year
        ],
        getattr(getattr(getattr(result, "merge_result", None), "ledger", None), "trades_by_id", None) or {},
    )
    result.merge_result.ledger.issues.append(
        Issue(
            code="PIT_ZG_COUNTRY_UNKNOWN",
            severity="ERROR",
            stage="EXPORT",
            scope_type="ENGINE",
            scope_id="pit-zg",
            message=(
                f"{len(bez_kraju)} wiersz(y) załącznika PIT/ZG nie ma ustalonego państwa źródła "
                f"(dochód {dochod} PLN, podatek zagraniczny {podatek} PLN). Kod \"XX\" nie istnieje "
                "w słowniku KodyKrajow, a podatek z tego wiersza powiększyłby odliczenie w poz. 34. "
                "Uzupełnij ISIN albo kraj dla tych transakcji"
                + (f": {', '.join(symbole)}." if symbole else ".")
                + " W raporcie rocznym otwórz „Sprawdź kontrolę PIT” i uzupełnij pole „Kraj” przy symbolu (dwuliterowy kod, np. CY), albo wpisz ISIN w Historii transakcji. Po przeliczeniu blokada zniknie."
            ),
            details={"symbols": symbole, "income_pln": str(dochod), "foreign_tax_pln": str(podatek)},
            blocking=True,
        )
    )


def _build_draft(result: EngineRunResult, request: TaxFilingRequest) -> TaxFilingDraft:
    art30b = result.annual_summary.get("art30b", {})
    _zglos_zalaczniki_bez_kraju(result)
    scenario_projections = {
        name: _build_scenario_projection(result, name)
        for name in ("conservative", "defensible", "aggressive_user")
        if name in result.scenario_results
    }
    if not scenario_projections:
        fallback_projection = _build_fallback_projection_from_summary(result)
        scenario_projections = {fallback_projection.scenario_name: fallback_projection}
    default_projection = scenario_projections.get(result.primary_scenario) or next(iter(scenario_projections.values()))
    return TaxFilingDraft(
        tax_year=int(result.annual_summary.get("tax_year") or result.config.tax_year or 0),
        form_type="PIT-38",
        filing_mode=request.filing_mode,
        package_scope=request.package_scope,
        main_fields={
            "pit38_revenue": _to_decimal(art30b.get("pit38_rounded_revenue_pln")),
            "pit38_cost": _to_decimal(art30b.get("pit38_rounded_cost_pln")),
            "pit38_income": _to_decimal(art30b.get("pit38_income")),
            "pit38_loss": _to_decimal(art30b.get("pit38_loss")),
            "tax_19": _to_decimal(art30b.get("tax_19_pln")),
        },
        plan_used=result.plan_used,
        filing_ready=result.filing_ready,
        form_fields=list(default_projection.form_fields),
        scenario_projections=scenario_projections,
        pit_zg_attachments=[
            {
                "country": row["country"],
                # Pozycje czesci C.3 formularza PIT/ZG - tej wypelnianej do PIT-38.
                "position_29_income_pln": str(row["income_pln"]),
                "position_30_foreign_tax_pln": str(row["foreign_tax_pln"]),
                "revenue_pln": str(row["revenue_pln"]),
                "cost_pln": str(row["cost_pln"]),
                "loss_pln": str(row["loss_pln"]),
                "sale_row_count": row["row_count"],
                # Dywidendy rozliczaja sie w czesci G samego PIT-38 (art. 30a);
                # tu sa wylacznie informacyjnie, w rozbiciu na panstwa.
                "dividend_income_pln": str(row["dividend_income_pln"]),
                "dividend_foreign_tax_pln": str(row["dividend_foreign_tax_pln"]),
            }
            for row in _pit_zg_rows_for_result(result)
        ],
    )


def _build_calculation_report(
    result: EngineRunResult,
    tax_calculation_ledger: dict[str, Any] | None = None,
    result_delta_report: dict[str, Any] | None = None,
    pit_submission_readiness: dict[str, Any] | None = None,
) -> TaxCalculationReport:
    art30b = result.annual_summary.get("art30b", {})
    art30a = result.annual_summary.get("art30a", {})
    revenue = _to_decimal(art30b.get("pit38_rounded_revenue_pln"))
    cost = _to_decimal(art30b.get("pit38_rounded_cost_pln"))
    income = _to_decimal(art30b.get("pit38_income"))
    tax_19 = _to_decimal(art30b.get("tax_19_pln"))
    aggressive_costs = sum(
        (_to_decimal(decision.amount_pln) for decision in result.cost_decisions if decision.included and decision.aggressive_only),
        Decimal("0.00"),
    )
    prior_year_losses_used = _summary_decimal(
        result,
        "prior_year_loss_used_pln",
        art30b_key="prior_year_loss_used_pln",
    )
    taxes_from_dane = _to_decimal(result.annual_summary.get("taxes_from_dane_pln"))
    sections: list[dict[str, Any]] = [
        {
            "title": "Jak policzono podatek",
            "values": {
                "revenue_pln": _decimal_text(revenue),
                "cost_pln": _decimal_text(cost),
                "income_pln": _decimal_text(income),
                "aggressive_costs_pln": _decimal_text(aggressive_costs),
                "prior_year_losses_pln": _decimal_text(prior_year_losses_used),
                "taxes_from_dane_pln": _decimal_text(taxes_from_dane),
                "tax_19_pln": _decimal_text(tax_19),
            },
            "explanation": (
                "Przychód minus koszty daje podstawę art. 30b. Koszty agresywne są pokazane osobno jako część "
                "kosztów planu aggressive_user; wynik PIT pozostaje oddzielony od wyniku ekonomicznego finansowania."
            ),
        },
        {
            "title": "Przychody i koszty z odpłatnego zbycia",
            "values": art30b,
        },
        {
            "title": "Dywidendy i podatek zagraniczny",
            "values": art30a,
        },
        {
            "title": "Koszty aggressive-only",
            "values": [decision.cost_id for decision in result.cost_decisions if decision.aggressive_only and decision.included],
        },
    ]
    if tax_calculation_ledger:
        sections.append(
            {
                "title": "Ledger kalkulacji podatku",
                "values": tax_calculation_ledger.get("rows", []),
                "explanation": tax_calculation_ledger.get("metadata", {}).get(
                    "explanation",
                    "Pełny ślad kwot użytych do obliczenia wyniku.",
                ),
            }
        )
    if result_delta_report:
        sections.append(
            {
                "title": "Dlaczego wynik się zmienił",
                "values": result_delta_report,
                "explanation": (
                    "Porównanie bieżącego ledgera z poprzednim snapshotem audytu. "
                    "Benchmark użytkownika jest diagnostyczny i nie wymusza wyniku."
                ),
            }
        )
    if pit_submission_readiness:
        sections.append(
            {
                "title": "Kontrola przed złożeniem PIT",
                "values": pit_submission_readiness,
                "explanation": (
                    "Kontrola łączy ledger podatku, braki dowodowe, luki NBP i problemy jakości w jeden werdykt. "
                    "Braki dowodowe nie zmieniają matematyki, ale wskazują co zachować albo opisać przed złożeniem PIT."
                ),
            }
        )
    return TaxCalculationReport(
        sections=sections,
        totals={
            "revenue_pln": revenue,
            "cost_pln": cost,
            "tax_pln": tax_19,
        },
        issues=[
            {
                "code": issue.code,
                "severity": issue.severity,
                "message": issue.message,
            }
            for issue in result.merge_result.ledger.issues
        ],
    )


def _build_justification(
    result: EngineRunResult,
    cost_defense_entries: list[dict[str, Any]] | None = None,
) -> TaxJustificationMemo:
    if cost_defense_entries is None:
        cost_defense_entries = _build_cost_defense_entries(result)
    defense_readiness = _build_defense_readiness(cost_defense_entries)
    aggressive_notes = [
        f"{entry['cost_id']}:{entry['kind']}:ryzyko={entry['risk_level']}:dowod={entry['evidence_level']}"
        for entry in cost_defense_entries
        if entry["policy_level"] == "AGGRESSIVE_ONLY"
    ]
    return TaxJustificationMemo(
        title=f"Memorandum rozliczenia PIT-38 za {result.annual_summary.get('tax_year')}",
        summary=(
            f"Rozliczenie przygotowano wedlug planu Aggressive ({result.plan_used}) "
            "na podstawie kanonicznego ledgera, kursow NBP D-1 oraz warstwy audytowej. "
            "Pozycje agresywne wymagaja zachowania dowodow zrodlowych i trace do transakcji."
        ),
        assumptions=[
            f"Plan liczenia podatku: {result.plan_used}",
            f"Filing ready: {'tak' if result.filing_ready else 'nie'}",
            "Manualne decyzje aggressive_user sa dokumentowane jako koszt, podstawa, ryzyko i powiazanie z rekordem zrodlowym.",
        ],
        cost_categories=cost_defense_entries,
        fx_rules=[
            "Przychody i koszty przeliczono wg sredniego kursu NBP z ostatniego dnia roboczego poprzedzajacego zdarzenie podatkowe.",
            "Koszty przewalutowania i ujemne roznice private cash FX powiazane z zakupem inwestycyjnym sa ujmowane tylko dla planu aggressive_user i tylko z trace danych.",
        ],
        policy_notes=aggressive_notes,
        evidence_summary=[
            f"Issues tracked: {len(result.merge_result.ledger.issues)}",
            f"Audit hash: {result.audit_hash or 'pending'}",
            f"Defense readiness score: {defense_readiness['score']}/100",
            f"High risk defense items: {defense_readiness['highRiskItems']}",
        ],
    )


def generate_tax_filing_package(result: EngineRunResult, request: TaxFilingRequest) -> TaxFilingPackage:
    scope = request.package_scope
    draft = _build_draft(result, request)

    include_calculation = scope in {"with_calculation", "with_justification", "full"}
    include_justification = scope in {"with_justification", "full"}
    include_appendix = scope == "full"

    if include_justification and not result.filing_ready:
        result.merge_result.ledger.issues.append(
            Issue(
                code="JUSTIFICATION_GENERATED_ON_NON_READY_RESULT",
                severity="WARNING",
                stage="EXPORT",
                scope_type="ENGINE",
                scope_id=str(result.annual_summary.get("tax_year") or result.config.tax_year or "ALL"),
                message="Wygenerowano uzasadnienie dla wyniku, który nie jest gotowy do złożenia. Otwórz raport roczny i wybierz „Sprawdź kontrolę PIT”, aby przejrzeć blokady i ostrzeżenia.",
                blocking=False,
            )
        )

    aggressive_cost_defense = _apply_defense_evidence_overrides(_build_cost_defense_entries(result), request)
    defense_readiness = _build_defense_readiness(aggressive_cost_defense)
    defense_evidence_links = _build_defense_evidence_links(aggressive_cost_defense)
    defense_evidence_groups = _build_defense_evidence_groups(aggressive_cost_defense)
    tax_calculation_ledger = _build_tax_calculation_ledger(result, aggressive_cost_defense)
    result_delta_report = _build_result_delta_report(result, tax_calculation_ledger)
    defense_gap_summary = _build_defense_gap_summary(defense_readiness, aggressive_cost_defense)
    pit_submission_readiness = _build_pit_submission_readiness(
        result,
        tax_calculation_ledger=tax_calculation_ledger,
        defense_gap_summary=defense_gap_summary,
        result_delta_report=result_delta_report,
    )
    tax_trace_index = _build_tax_trace_index(
        tax_calculation_ledger=tax_calculation_ledger,
        defense_evidence_links=defense_evidence_links,
        pit_submission_readiness=pit_submission_readiness,
        result_delta_report=result_delta_report,
    )
    metadata = getattr(result.merge_result.ledger, "metadata", {}) or {}
    source_resolution_preview = metadata.get("source_resolution_preview")
    canonical_storage_history_rows = metadata.get("canonical_storage_history_rows") or []
    storage_lineage_index = metadata.get("storage_lineage_index") or {}
    canonical_storage_history_summary = metadata.get("canonical_storage_history_summary") or {}
    transaction_dossiers = metadata.get("transaction_dossiers") or []
    transaction_dossier_summary = metadata.get("transaction_dossier_summary") or {}
    transaction_conflicts = metadata.get("transaction_conflicts") or []
    field_source_map = metadata.get("field_source_map") or {}
    evidence_index = metadata.get("evidence_index") or []
    ai_document_classification = metadata.get("ai_document_classification") or []
    ai_column_mappings = metadata.get("ai_column_mappings") or []
    ai_extracted_context = metadata.get("ai_extracted_context") or []
    ai_validation_report = metadata.get("ai_validation_report") or {}
    source_registry = metadata.get("source_registry") or []
    normalized_storage_manifest = metadata.get("normalized_storage_manifest") or []
    normalized_events = metadata.get("normalized_events") or []
    canonical_tax_input = metadata.get("canonical_tax_input") or {}
    canonical_tax_input_summary = metadata.get("canonical_tax_input_summary") or {}
    tax_input_build_report = metadata.get("tax_input_build_report") or {}
    canonical_tax_input_path = metadata.get("canonical_tax_input_path") or ""
    canonical_tax_input_consumption = metadata.get("canonical_tax_input_consumption") or {}
    canonical_tax_input_consumption_runtime = metadata.get("canonical_tax_input_consumption_runtime") or {}
    source_manifest_v2 = _source_manifest_v2(result)
    auto_file_recognition_report = _auto_file_recognition_report(source_manifest_v2)
    result_health_check = _build_result_health_check(
        result,
        source_manifest_v2=source_manifest_v2,
        auto_file_recognition_report=auto_file_recognition_report,
    )
    source_trust_summary = _build_source_trust_summary(
        result,
        source_manifest_v2=source_manifest_v2,
        result_health_check=result_health_check,
    )
    nbp_coverage_report = _build_nbp_coverage_report(result)
    import_intelligence_report = _import_intelligence_report(result, source_manifest_v2)
    no_overpay_audit = _build_no_overpay_audit(
        result,
        import_intelligence_report=import_intelligence_report,
        defense_evidence_links=defense_evidence_links,
    )
    aggressive_cost_coverage_audit = _build_aggressive_cost_coverage_audit(
        no_overpay_audit=no_overpay_audit,
        defense_evidence_links=defense_evidence_links,
    )
    coverage_matrix = _build_coverage_matrix(
        result,
        source_manifest_v2=source_manifest_v2,
        import_intelligence_report=import_intelligence_report,
        no_overpay_audit=no_overpay_audit,
    )
    broker_file_control_tower = _build_broker_file_control_tower(
        source_manifest_v2=source_manifest_v2,
        import_intelligence_report=import_intelligence_report,
        coverage_matrix=coverage_matrix,
        no_overpay_audit=no_overpay_audit,
    )
    no_overpay_audit_v2 = _build_no_overpay_audit_v2(
        no_overpay_audit=no_overpay_audit,
        coverage_matrix=coverage_matrix,
    )
    no_overpay_audit_v3 = _build_no_overpay_audit_v3(
        result=result,
        no_overpay_audit=no_overpay_audit,
        defense_evidence_links=defense_evidence_links,
    )
    defense_case_file = _build_defense_case_file(
        source_manifest_v2=source_manifest_v2,
        import_intelligence_report=import_intelligence_report,
        no_overpay_audit=no_overpay_audit,
        defense_evidence_links=defense_evidence_links,
        defense_evidence_groups=defense_evidence_groups,
    )
    defense_vault_summary = _build_defense_vault_summary(
        defense_evidence_links=defense_evidence_links,
        source_manifest_v2=source_manifest_v2,
    )
    legal_basis_registry = [dict(entry) for entry in LEGAL_BASIS_REGISTRY]
    defense_case_file_v2 = _build_defense_case_file_v2(
        defense_case_file=defense_case_file,
        no_overpay_audit_v2=no_overpay_audit_v2,
        legal_basis_registry=legal_basis_registry,
    )
    broker_file_action_queue = _apply_broker_file_action_overrides(
        _build_broker_file_action_queue(
            result=result,
            coverage_matrix=coverage_matrix,
            import_intelligence_report=import_intelligence_report,
            no_overpay_audit_v2=no_overpay_audit_v2,
            defense_case_file_v2=defense_case_file_v2,
        ),
        request,
    )
    pit_case_file = _build_pit_case_file(
        result,
        aggressive_cost_defense=aggressive_cost_defense,
        defense_evidence_links=defense_evidence_links,
        defense_readiness=defense_readiness,
        tax_calculation_ledger=tax_calculation_ledger,
        result_delta_report=result_delta_report,
        defense_gap_summary=defense_gap_summary,
        pit_submission_readiness=pit_submission_readiness,
        tax_trace_index=tax_trace_index,
    )
    memorandum_aggressive_user = _build_aggressive_memorandum(
        result,
        aggressive_cost_defense,
        defense_readiness,
        pit_submission_readiness,
    )
    tax_advisor_brief = _build_tax_advisor_brief(
        result,
        result_health_check=result_health_check,
        source_manifest_v2=source_manifest_v2,
        aggressive_cost_defense=aggressive_cost_defense,
        defense_readiness=defense_readiness,
        pit_submission_readiness=pit_submission_readiness,
    )
    advisor_review_pack = _build_advisor_review_pack(
        result,
        result_health_check=result_health_check,
        source_trust_summary=source_trust_summary,
        no_overpay_audit_v3=no_overpay_audit_v3,
        defense_vault_summary=defense_vault_summary,
        tax_advisor_brief=tax_advisor_brief,
    )
    storage_smoke_report = _build_storage_smoke_report(
        result,
        result_health_check=result_health_check,
        source_trust_summary=source_trust_summary,
        nbp_coverage_report=nbp_coverage_report,
    )
    calculation = (
        _build_calculation_report(result, tax_calculation_ledger, result_delta_report, pit_submission_readiness)
        if include_calculation
        else None
    )
    justification = _build_justification(result, aggressive_cost_defense) if include_justification else None
    appendix = (
        {
            "issues": [
                {
                    "code": issue.code,
                    "severity": issue.severity,
                    "scope_id": issue.scope_id,
                }
                for issue in result.merge_result.ledger.issues
            ],
            "cost_decisions": [
                {
                    "cost_id": decision.cost_id,
                    "plan_name": decision.plan_name,
                    "kind": decision.kind,
                    "included": decision.included,
                }
                for decision in result.cost_decisions
            ],
            "aggressive_cost_defense": aggressive_cost_defense,
            "defense_evidence_links": defense_evidence_links,
            "defense_evidence_groups": defense_evidence_groups,
            "defense_readiness": defense_readiness,
            "tax_calculation_ledger": tax_calculation_ledger,
            "result_delta_report": result_delta_report,
            "defense_gap_summary": defense_gap_summary,
            "pit_submission_readiness": pit_submission_readiness,
            "tax_trace_index": tax_trace_index,
            "source_manifest_v2": source_manifest_v2,
            "source_resolution_preview": source_resolution_preview,
            "canonical_storage_history_rows": canonical_storage_history_rows,
            "storage_lineage_index": storage_lineage_index,
            "canonical_storage_history_summary": canonical_storage_history_summary,
            "transaction_dossiers": transaction_dossiers,
            "transaction_dossier_summary": transaction_dossier_summary,
            "transaction_conflicts": transaction_conflicts,
            "field_source_map": field_source_map,
            "evidence_index": evidence_index,
            "ai_document_classification": ai_document_classification,
            "ai_column_mappings": ai_column_mappings,
            "ai_extracted_context": ai_extracted_context,
            "ai_validation_report": ai_validation_report,
            "source_registry": source_registry,
            "normalized_storage_manifest": normalized_storage_manifest,
            "normalized_events": normalized_events,
            "canonical_tax_input": canonical_tax_input,
            "canonical_tax_input_summary": canonical_tax_input_summary,
            "tax_input_build_report": tax_input_build_report,
            "canonical_tax_input_path": canonical_tax_input_path,
            "canonical_tax_input_consumption": canonical_tax_input_consumption,
            "canonical_tax_input_consumption_runtime": canonical_tax_input_consumption_runtime,
            "result_health_check": result_health_check,
            "source_trust_summary": source_trust_summary,
            "storage_smoke_report": storage_smoke_report,
            "nbp_coverage_report": nbp_coverage_report,
            "auto_file_recognition_report": auto_file_recognition_report,
            "import_intelligence_report": import_intelligence_report,
            "no_overpay_audit": no_overpay_audit,
            "aggressive_cost_coverage_audit": aggressive_cost_coverage_audit,
            "defense_case_file": defense_case_file,
            "broker_file_control_tower": broker_file_control_tower,
            "broker_file_action_queue": broker_file_action_queue,
            "coverage_matrix": coverage_matrix,
            "no_overpay_audit_v2": no_overpay_audit_v2,
            "no_overpay_audit_v3": no_overpay_audit_v3,
            "defense_vault_summary": defense_vault_summary,
            "defense_case_file_v2": defense_case_file_v2,
            "legal_basis_registry": legal_basis_registry,
            "pit_case_file": pit_case_file,
            "memorandum_aggressive_user": memorandum_aggressive_user,
            "aggressive_user_memorandum": memorandum_aggressive_user,
            "tax_advisor_brief": tax_advisor_brief,
            "advisor_review_pack": advisor_review_pack,
            "legal_safety_notice": (
                "Ten zalacznik dokumentuje argumentacje i dowody dla planu aggressive_user. "
                "Nie jest gwarancja akceptacji przez organ podatkowy; pozycje o ryzyku PODWYZSZONE/WYSOKIE "
                "wymagaja szczegolnego zachowania dowodow."
            ),
        }
        if include_appendix
        else None
    )
    return TaxFilingPackage(
        draft=draft,
        calculation=calculation,
        justification=justification,
        audit_appendix=appendix,
    )
