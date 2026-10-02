from __future__ import annotations

from decimal import Decimal, ROUND_HALF_UP

import pandas as pd

from investment_tax_engine.interfaces.fx import FxProvider
from investment_tax_engine.models.core import CostItem, Issue, MergeResult


Q2 = Decimal("0.01")


def q2(value: Decimal) -> Decimal:
    return value.quantize(Q2, rounding=ROUND_HALF_UP)


# Ile dni po przewalutowaniu szukamy zakupu sfinansowanego tymi srodkami.
# Poza tym oknem zwiazek z przychodem trudno obronic przed urzedem.
OKNO_UZYCIA_SRODKOW_DNI = 3


def rozbij_pare_walutowa(symbol: str) -> tuple[str, str] | None:
    """Rozklada zapis pary na walute bazowa i kwotowana, np. "USD/PLN"."""
    tekst = (symbol or "").strip().upper().replace("\\", "/")
    for separator in ("/", "-", "_"):
        if separator in tekst:
            czlony = [czlon.strip() for czlon in tekst.split(separator) if czlon.strip()]
            if len(czlony) == 2 and all(len(czlon) == 3 for czlon in czlony):
                return czlony[0], czlony[1]
    if len(tekst) == 6 and tekst.isalpha():
        return tekst[:3], tekst[3:]
    return None


def _wykorzystana_kwota(
    pozostale_zakupy: dict[str, Decimal],
    zakupy: list,
    tax_event_date: pd.Timestamp,
    kwota_nabyta: Decimal,
    waluta_nabyta: str,
) -> Decimal:
    """Przypisz zakupy do wymiany najwyzej raz, do wysokosci nabytej waluty."""
    deadline = pd.Timestamp(tax_event_date).normalize() + pd.Timedelta(days=OKNO_UZYCIA_SRODKOW_DNI)
    used_amount = Decimal("0.00")
    for trade in zakupy:
        if (trade.trade_currency or "").upper() != waluta_nabyta.upper():
            continue
        if not (pd.Timestamp(tax_event_date).normalize() <= trade.tax_event_date.normalize() <= deadline):
            continue
        available = pozostale_zakupy[trade.trade_id]
        assigned = min(available, kwota_nabyta - used_amount)
        pozostale_zakupy[trade.trade_id] -= assigned
        used_amount += assigned
        if used_amount >= kwota_nabyta:
            break
    return used_amount


def extract_fx_conversion_costs(merge_result: MergeResult, fx_provider: FxProvider) -> tuple[list[CostItem], list[Issue]]:
    items: list[CostItem] = []
    issues: list[Issue] = []
    zakupy = sorted(
        (trade for trade in merge_result.ledger.trades_by_id.values()
         if trade.logical_world == "equity_tax" and trade.side == "BUY" and trade.tax_event_date is not None),
        key=lambda trade: (trade.tax_event_date, trade.trade_id),
    )
    pozostale_zakupy = {
        trade.trade_id: max(trade.gross_amount + trade.commission, Decimal("0")) for trade in zakupy
    }

    for trade in sorted(
        merge_result.ledger.trades_by_id.values(),
        key=lambda row: (row.tax_event_date or pd.Timestamp.max, row.trade_id),
    ):
        if trade.instrument_class != "FX":
            continue
        para = rozbij_pare_walutowa(trade.symbol)
        if para is None:
            continue
        waluta_bazowa, waluta_kwotowana = para
        # Przy sprzedazy pary oddajemy walute bazowa i dostajemy kwotowana,
        # przy kupnie odwrotnie. Inwestycji szukamy w tej, ktora wpadla na
        # rachunek - u polskiego inwestora najczesciej w dolarze kupionym
        # za zlotowki.
        waluta_nabyta = waluta_kwotowana if trade.side == "SELL" else waluta_bazowa
        if trade.tax_event_date is None or trade.gross_amount_pln is None or trade.gross_fx_rate is None:
            continue
        # Zwiazek wymiany z zakupem papierow moze byc nieuchwytny: srodki bywaja
        # wymieniane z wyprzedzeniem albo zakup lezy poza zakresem wgranych
        # plikow. Takiego kosztu nie odrzucamy w ciemno - liczymy go, ale
        # zostawiamy poza planem, zeby podatnik mogl go swiadomie wskazac.
        # Wczesniejsza wersja po prostu pomijala wiersz, wiec koszt przepadal
        # bez sladu w wyniku.
        # Kurs odniesienia to relacja kursow NBP obu walut z dnia zdarzenia.
        # Zloty nie ma wlasnej tabeli - jego kurs wobec samego siebie to 1.
        #
        # Brak kursu przerywal wczesniej caly przebieg silnika wyjatkiem KeyError,
        # razem z tracebackiem w interfejsie - a chodzi tu tylko o dodatkowy,
        # opcjonalny koszt spreadu. Rozliczenie ma powstac takze wtedy, gdy tabeli
        # NBP akurat nie da sie pobrac; brakujaca pozycje odnotowujemy jako
        # ostrzezenie i liczymy dalej.
        try:
            kurs_bazowej = (
                Decimal("1")
                if waluta_bazowa == "PLN"
                else fx_provider.get_rate(waluta_bazowa, trade.tax_event_date).rate
            )
            kurs_kwotowanej = (
                Decimal("1")
                if waluta_kwotowana == "PLN"
                else fx_provider.get_rate(waluta_kwotowana, trade.tax_event_date).rate
            )
        except KeyError as blad:
            issues.append(
                Issue(
                    code="FX_CONVERSION_RATE_MISSING",
                    severity="WARNING",
                    message=(
                        f"Wymiana {trade.symbol} z {trade.tax_event_date.date()}: brak kursu NBP "
                        f"({blad}). Koszt spreadu dla tej operacji zostal pominiety, reszta "
                        "rozliczenia jest policzona."
                    ),
                    blocking=False,
                )
            )
            continue
        if kurs_kwotowanej == 0:
            continue
        benchmark_rate = kurs_bazowej / kurs_kwotowanej
        actual_rate = trade.price
        if trade.side == "SELL":
            implied_usd_cost = max((benchmark_rate - actual_rate) * trade.quantity, Decimal("0.00"))
        else:
            implied_usd_cost = max((actual_rate - benchmark_rate) * trade.quantity, Decimal("0.00"))
        implied_pln_cost = q2(implied_usd_cost * (trade.gross_fx_rate or Decimal("1.00")))
        if implied_pln_cost <= Decimal("0.00"):
            continue

        kwota_nabyta = trade.gross_amount if trade.side == "SELL" else trade.quantity
        wykorzystane = _wykorzystana_kwota(
            pozostale_zakupy, zakupy, trade.tax_event_date, kwota_nabyta, waluta_nabyta
        ) if kwota_nabyta > 0 else Decimal("0")
        udzial = wykorzystane / kwota_nabyta if kwota_nabyta > 0 else Decimal("0")
        ma_slad = wykorzystane > 0 and q2(implied_pln_cost * udzial) > 0
        if not ma_slad:
            issues.append(
                Issue(
                    code="FX_CONVERSION_COST_WITHOUT_TRACE",
                    severity="WARNING",
                    stage="COST_POLICY",
                    scope_type="TRADE",
                    scope_id=trade.trade_id,
                    message=(
                        f"Wymiana {trade.symbol}: brak potwierdzonego wykorzystania waluty "
                        f"{waluta_nabyta} na zakup papierow w ciagu {OKNO_UZYCIA_SRODKOW_DNI} dni. "
                        "Koszt pozostaje poza planem do udokumentowania."
                    ),
                    blocking=False,
                )
            )
        if ma_slad:
            implied_usd_cost *= udzial
            implied_pln_cost = q2(implied_pln_cost * udzial)

        items.append(
            CostItem(
                cost_id=f"FXC-{trade.trade_id}",
                kind="FX_CONVERSION_SPREAD_COST",
                amount_foreign=q2(implied_usd_cost),
                currency=waluta_kwotowana,
                tax_event_date=trade.tax_event_date,
                amount_pln=implied_pln_cost,
                source_id=trade.trade_id,
                policy_tags={"aggressive_only"} if ma_slad else {"aggressive_only", "wymaga_decyzji"},
                evidence_level="STRONG" if ma_slad else "WEAK",
                allocation_target=trade.trade_id,
                included_in_plan={"aggressive_user"} if ma_slad else set(),
                is_aggressive_only=True,
                derived_cost=True,
                notes=[
                    f"koszt spreadu przy wymianie {waluta_bazowa}/{waluta_kwotowana}"
                    + (
                        f" powiazany z zakupem papierow w walucie {waluta_nabyta}"
                        if ma_slad
                        else " bez potwierdzonego zakupu - do decyzji podatnika"
                    ),
                    f"wykorzystane_srodki={wykorzystane}/{kwota_nabyta} {waluta_nabyta}",
                ],
            )
        )

    return items, issues
