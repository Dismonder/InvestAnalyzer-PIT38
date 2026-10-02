"""
Rozliczenie walut wirtualnych - czesc E formularza PIT-38.

Waluty wirtualne rzadza sie innymi regulami niz papiery wartosciowe i dlatego
maja w formularzu osobna czesc:

* **Wymiana waluty wirtualnej na inna walute wirtualna nie jest przychodem**
  (art. 17 ust. 1f ustawy o PIT). Zamiana BTC na USDT nie rodzi podatku, mimo
  ze na wyciagu z gieldy wyglada jak zwykla sprzedaz. Stablecoiny sa walutami
  wirtualnymi, wiec para BTC/USDT to wlasnie taka wymiana.
* **Wydatek na nabycie jest kosztem w roku poniesienia**, niezaleznie od tego,
  czy cokolwiek sprzedano (art. 22 ust. 14). Nie stosuje sie kolejki FIFO.
* **Koszty niepokryte przychodem przechodza na rok nastepny** (art. 22 ust. 16),
  a nie staja sie strata do odliczenia od dochodow z akcji.
* Dochod opodatkowany jest stawka 19% (art. 30b ust. 1a).

Silnik dotad tylko wykrywal te transakcje i wylaczal je z czesci C, zostawiajac
uzytkownika z komunikatem "rozlicz osobno". Ten modul liczy czesc E.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from decimal import Decimal, ROUND_HALF_UP
from typing import Any

import pandas as pd

from ..models.core import CanonicalTrade, Issue, MergeResult
from ..normalize.classify import WALUTY_URZEDOWE, WALUTY_WIRTUALNE

Q2 = Decimal("0.01")
Q0 = Decimal("1")
STAWKA = Decimal("0.19")



def q2(wartosc: Decimal) -> Decimal:
    return Decimal(wartosc).quantize(Q2, rounding=ROUND_HALF_UP)


def q0(wartosc: Decimal) -> Decimal:
    return Decimal(wartosc).quantize(Q0, rounding=ROUND_HALF_UP)


@dataclass
class WierszKrypto:
    """Pojedyncza operacja na walutach wirtualnych w ujeciu czesci E."""

    trade_id: str
    symbol: str
    side: str
    tax_event_date: str
    quantity: Decimal
    counter_currency: str
    amount_pln: Decimal
    commission_pln: Decimal
    kind: str  # REVENUE | COST | CRYPTO_SWAP | BRAK_KURSU | NIEZNANA_STRONA
    reason: str


@dataclass
class WynikCzesciE:
    """Wynik czesci E: pola formularza i slad, z czego powstaly."""

    tax_year: int | None
    revenue_pln: Decimal = Decimal("0.00")
    costs_current_year_pln: Decimal = Decimal("0.00")
    costs_carried_in_pln: Decimal = Decimal("0.00")
    total_costs_pln: Decimal = Decimal("0.00")
    income_pln: Decimal = Decimal("0.00")
    costs_carried_out_pln: Decimal = Decimal("0.00")
    tax_19_pln: Decimal = Decimal("0.00")
    trade_count: int = 0
    swap_count: int = 0
    #: Operacje pominiete, bo nie da sie ich wycenic albo zaklasyfikowac.
    #: Ich kwoty NIE wchodza do przychodu ani do kosztow - zamiast cichego
    #: zera deklaracja dostaje niespojnosc blokujaca.
    skipped_no_fx_count: int = 0
    skipped_unknown_side_count: int = 0
    rows: list[WierszKrypto] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {
            "tax_year": str(self.tax_year) if self.tax_year is not None else "ALL",
            # Poz. 36 formularza: przychod z odplatnego zbycia walut wirtualnych.
            # Numeracja za broszura MF do PIT-38 za 2025 r.; poz. 34-38 to
            # numery z PIT-38(14) z 2019 r., przed dodaniem wiersza ulgi IPO.
            "revenue_pln": str(self.revenue_pln),
            # Poz. 37: koszty poniesione w roku podatkowym.
            "costs_current_year_pln": str(self.costs_current_year_pln),
            # Poz. 38: koszty z lat ubieglych nieodliczone w poprzednich latach.
            "costs_carried_in_pln": str(self.costs_carried_in_pln),
            # Poz. 37 + 38: koszty uzyskania przychodu razem.
            "total_costs_pln": str(self.total_costs_pln),
            # Poz. 39: dochod.
            "income_pln": str(self.income_pln),
            # Poz. 40: koszty do potracenia w roku nastepnym.
            "costs_carried_out_pln": str(self.costs_carried_out_pln),
            # Poz. 43 i 45: podatek nalezny z czesci F.
            "tax_19_pln": str(self.tax_19_pln),
            "trade_count": self.trade_count,
            "swap_count": self.swap_count,
            "skipped_no_fx_count": self.skipped_no_fx_count,
            "skipped_unknown_side_count": self.skipped_unknown_side_count,
            "rows": [
                {
                    "trade_id": wiersz.trade_id,
                    "symbol": wiersz.symbol,
                    "side": wiersz.side,
                    "tax_event_date": wiersz.tax_event_date,
                    "quantity": str(wiersz.quantity),
                    "counter_currency": wiersz.counter_currency,
                    "amount_pln": str(wiersz.amount_pln),
                    "commission_pln": str(wiersz.commission_pln),
                    "kind": wiersz.kind,
                    "reason": wiersz.reason,
                }
                for wiersz in self.rows
            ],
        }


def waluta_przeciwstawna(trade: CanonicalTrade) -> str:
    """
    Czym zaplacono albo co otrzymano w tej operacji.

    Gielda zapisuje pare bez separatora (``BTCUSDT``) albo podaje sam symbol i
    walute rozliczenia osobno. Rozstrzygniecie jest istotne, bo decyduje, czy
    operacja w ogole jest przychodem: zaplata w stablecoinie to wymiana krypto
    na krypto, a zaplata w zlotowce albo dolarze - zbycie podlegajace podatkowi.
    """
    symbol = (trade.symbol or "").strip().upper()
    rdzen = symbol.replace("-", "").replace("/", "").replace("_", "")

    kandydaci = sorted(WALUTY_WIRTUALNE | WALUTY_URZEDOWE, key=len, reverse=True)
    for kandydat in kandydaci:
        if len(rdzen) > len(kandydat) and rdzen.endswith(kandydat):
            baza = rdzen[: -len(kandydat)]
            if baza in WALUTY_WIRTUALNE:
                return kandydat

    return (trade.trade_currency or "").strip().upper()


def czy_wymiana_krypto_na_krypto(trade: CanonicalTrade) -> bool:
    """Obie strony operacji sa walutami wirtualnymi (art. 17 ust. 1f)."""
    return waluta_przeciwstawna(trade) in WALUTY_WIRTUALNE


def _kwota_pln(trade: CanonicalTrade) -> Decimal:
    """Wartosc operacji w zlotych po kursie NBP z dnia poprzedzajacego."""
    kwota = trade.gross_amount or Decimal("0")
    if (trade.trade_currency or "").upper() == "PLN":
        return q2(abs(kwota))
    kurs = trade.gross_fx_rate or Decimal("0")
    return q2(abs(kwota) * kurs)


def czy_prowizja_w_walucie_wirtualnej(trade: CanonicalTrade) -> bool:
    """Prowizja transakcji czesci E pobrana w krypto (BNB albo nabyta waluta).

    Taka prowizja zostaje niewyceniona (0 zl z ostrzezeniem): NBP nie publikuje
    jej kursu, a wycena kursem kwoty transakcji dawala liczbe bez sensu.
    """
    if trade.logical_world != "crypto_tax":
        return False
    waluta_prowizji = (trade.commission_currency or "").strip().upper()
    if not waluta_prowizji:
        return False
    symbol = (trade.symbol or "").strip().upper().replace("/", "").replace("-", "").replace("_", "")
    przeciwstawna = (trade.trade_currency or "").strip().upper()
    baza = symbol[:-len(przeciwstawna)] if przeciwstawna and symbol.endswith(przeciwstawna) and len(symbol) > len(przeciwstawna) else symbol
    return waluta_prowizji in WALUTY_WIRTUALNE or waluta_prowizji == baza


def _prowizja_pln(trade: CanonicalTrade) -> Decimal:
    prowizja = trade.commission or Decimal("0")
    if not prowizja:
        return Decimal("0.00")
    waluta_prowizji = (trade.commission_currency or "").upper()
    przeciwstawna = (trade.trade_currency or "").upper()
    if czy_prowizja_w_walucie_wirtualnej(trade):
        return Decimal("0.00")
    if waluta_prowizji == "PLN":
        return q2(abs(prowizja))
    kurs = trade.commission_fx_rate
    if not kurs and waluta_prowizji == przeciwstawna:
        kurs = trade.gross_fx_rate
    kurs = kurs or Decimal("0")
    return q2(abs(prowizja) * kurs)


def oblicz_czesc_e(
    merge_result: MergeResult,
    *,
    tax_year: int | None,
    costs_carried_in_pln: Decimal = Decimal("0.00"),
) -> tuple[WynikCzesciE, list[Issue]]:
    """
    Liczy czesc E PIT-38 z transakcji na walutach wirtualnych.

    ``costs_carried_in_pln`` to koszty nabycia z lat ubieglych, ktorych nie dalo
    sie odliczyc, bo przewyzszaly przychod (art. 22 ust. 16). Podaje je
    uzytkownik, bo silnik nie zna rozliczen sprzed okresu objetego danymi.
    """
    wynik = WynikCzesciE(tax_year=tax_year, costs_carried_in_pln=q2(costs_carried_in_pln))
    issues: list[Issue] = []

    transakcje = [
        trade
        for trade in merge_result.ledger.trades_by_id.values()
        if trade.logical_world == "crypto_tax"
    ]

    przychod = Decimal("0.00")
    koszty = Decimal("0.00")

    prowizje_swap = Decimal("0.00")
    transakcje_bez_kursu_prowizji = 0
    nieznane_waluty: set[str] = set()
    nieznane_transakcje: list[tuple[str, str, str]] = []
    fiat_as_crypto: set[str] = set()

    for trade in sorted(transakcje, key=lambda t: (t.tax_event_date or pd.Timestamp.min, t.trade_id)):
        if trade.tax_event_date is None:
            continue
        rok = int(pd.Timestamp(trade.tax_event_date).year)
        if tax_year is not None and rok != tax_year:
            continue

        waluta = waluta_przeciwstawna(trade)
        # Gielda moze zapisac walute fiat jako baze pary (np. EURUSDT).
        # Jesli portfel nie odwrocil tej pary, symbol sam jest fiat, a waluta
        # rozliczenia jest krypto: nie wolno uznac tego za neutralny swap.
        symbol = (trade.symbol or "").strip().upper()
        symbol_compact = symbol.replace("/", "").replace("-", "").replace("_", "")
        # Sam prefiks nie wystarcza: "USDT" zaczyna sie od "USD", a to uczciwa
        # waluta wirtualna. Fiat jako baza to caly symbol albo fiat + znana waluta.
        symbol_fiat_base = None
        if symbol_compact not in WALUTY_WIRTUALNE:
            for fiat in sorted(WALUTY_URZEDOWE, key=len, reverse=True):
                reszta = symbol_compact[len(fiat):]
                if symbol_compact.startswith(fiat) and (not reszta or reszta in WALUTY_WIRTUALNE | WALUTY_URZEDOWE):
                    symbol_fiat_base = fiat
                    break
        if symbol_fiat_base and (trade.trade_currency or "").strip().upper() in WALUTY_WIRTUALNE:
            fiat_as_crypto.add(symbol_fiat_base)
            wynik.rows.append(
                WierszKrypto(
                    trade_id=trade.trade_id,
                    symbol=trade.symbol,
                    side=(trade.side or "").upper(),
                    tax_event_date=pd.Timestamp(trade.tax_event_date).date().isoformat(),
                    quantity=trade.quantity or Decimal("0"),
                    counter_currency=waluta,
                    amount_pln=Decimal("0.00"),
                    commission_pln=Decimal("0.00"),
                    kind="FIAT_AS_CRYPTO",
                    reason=(
                        f"Symbol {trade.symbol} jest waluta tradycyjna, a waluta rozliczenia "
                        f"{trade.trade_currency} jest wirtualna. Transakcja zostala pominieta; "
                        "popraw strone pary Binance na zbycie/nabycie waluty wirtualnej za fiat."
                    ),
                )
            )
            continue
        if waluta not in WALUTY_WIRTUALNE | WALUTY_URZEDOWE:
            nieznane_waluty.add(waluta or '(pusta)')
            nieznane_transakcje.append((
                trade.symbol or "(brak symbolu)",
                pd.Timestamp(trade.tax_event_date).date().isoformat() if trade.tax_event_date is not None else "(brak daty)",
                trade.trade_id,
            ))
            continue
        kwota = _kwota_pln(trade)
        prowizja = _prowizja_pln(trade)
        strona = (trade.side or "").upper()
        data = pd.Timestamp(trade.tax_event_date).date().isoformat()

        if prowizja == 0 and (trade.commission or Decimal("0")) != 0:
            transakcje_bez_kursu_prowizji += 1

        if waluta in WALUTY_WIRTUALNE:
            wynik.swap_count += 1
            # Sama wymiana nie jest przychodem, ale prowizja zaplacona przy niej
            # to wydatek na nabycie waluty wirtualnej i jest kosztem (art. 22
            # ust. 14). Dotad przepadala razem z cala operacja.
            if prowizja > 0:
                koszty += prowizja
                prowizje_swap += prowizja
            wynik.rows.append(
                WierszKrypto(
                    trade_id=trade.trade_id,
                    symbol=trade.symbol,
                    side=strona,
                    tax_event_date=data,
                    quantity=trade.quantity or Decimal("0"),
                    counter_currency=waluta,
                    amount_pln=kwota,
                    commission_pln=prowizja,
                    kind="CRYPTO_SWAP",
                    reason=(
                        "Wymiana waluty wirtualnej na inną walutę wirtualną nie stanowi przychodu "
                        "(art. 17 ust. 1f ustawy o PIT). Prowizja wchodzi do kosztów części E."
                    ),
                )
            )
            continue

        # Bez kursu NBP kwota w zlotych wychodzila 0,00 - operacja za 10 000 USD
        # znikala z deklaracji, a ostrzezenie bylo nieblokujace. Zamiast
        # wpisywac zero, ktore wyglada jak policzona kwota, wykluczamy operacje
        # z sum i zglaszamy niespojnosc zatrzymujaca pakiet.
        if (trade.trade_currency or "").upper() != "PLN" and not trade.gross_fx_rate:
            wynik.skipped_no_fx_count += 1
            wynik.rows.append(
                WierszKrypto(
                    trade_id=trade.trade_id,
                    symbol=trade.symbol,
                    side=strona,
                    tax_event_date=data,
                    quantity=trade.quantity or Decimal("0"),
                    counter_currency=waluta,
                    amount_pln=Decimal("0.00"),
                    commission_pln=Decimal("0.00"),
                    kind="BRAK_KURSU",
                    reason=(
                        "Brak kursu NBP dla waluty rozliczenia — operacja nie została "
                        "wyceniona i nie wchodzi do części E. Uzupełnij kurs NBP z dnia roboczego poprzedzającego transakcję."
                    ),
                )
            )
            continue

        # Kolejka `else` przypisywala kazda nierozpoznana strone do kosztow
        # nabycia, wiec operacja z pustym albo nieznanym `side` obnizala podatek
        # o 19% swojej wartosci. Liczymy wylacznie BUY i SELL.
        if strona not in {"BUY", "SELL"}:
            wynik.skipped_unknown_side_count += 1
            wynik.rows.append(
                WierszKrypto(
                    trade_id=trade.trade_id,
                    symbol=trade.symbol,
                    side=strona,
                    tax_event_date=data,
                    quantity=trade.quantity or Decimal("0"),
                    counter_currency=waluta,
                    amount_pln=kwota,
                    commission_pln=prowizja,
                    kind="NIEZNANA_STRONA",
                    reason=(
                        "Nie rozpoznano strony operacji, więc nie wiadomo, czy to przychód, "
                        "czy koszt. Operacja nie wchodzi do części E. Popraw stronę w edytorze transakcji w Historii transakcji."
                    ),
                )
            )
            continue

        wynik.trade_count += 1
        if strona == "SELL":
            # Przychod brutto; prowizja od zbycia jest osobnym kosztem
            # (art. 22 ust. 14).
            przychod += kwota
            koszty += prowizja
            wynik.rows.append(
                WierszKrypto(
                    trade_id=trade.trade_id,
                    symbol=trade.symbol,
                    side=strona,
                    tax_event_date=data,
                    quantity=trade.quantity or Decimal("0"),
                    counter_currency=waluta,
                    amount_pln=kwota,
                    commission_pln=prowizja,
                    kind="REVENUE",
                    reason="Zbycie waluty wirtualnej za środki płatnicze — przychód części E.",
                )
            )
        else:
            koszty += kwota + prowizja
            wynik.rows.append(
                WierszKrypto(
                    trade_id=trade.trade_id,
                    symbol=trade.symbol,
                    side=strona,
                    tax_event_date=data,
                    quantity=trade.quantity or Decimal("0"),
                    counter_currency=waluta,
                    amount_pln=kwota,
                    commission_pln=prowizja,
                    kind="COST",
                    reason=(
                        "Wydatek na nabycie waluty wirtualnej — koszt roku poniesienia "
                        "niezależnie od sprzedaży (art. 22 ust. 14)."
                    ),
                )
            )

    if nieznane_waluty:
        issues.append(Issue(
            code="CRYPTO_COUNTER_CURRENCY_UNKNOWN",
            severity="ERROR",
            stage="TAX",
            scope_type="ENGINE",
            scope_id="crypto_tax",
            message=("Nieznana waluta rozliczenia w transakcjach krypto: "
                     f"{', '.join(sorted(nieznane_waluty))}. Transakcje: "
                     + "; ".join(f"{symbol}, {data}, ID {trade_id}" for symbol, data, trade_id in nieznane_transakcje[:10])
                     + ". W Historii transakcji otwórz edytor transakcji i popraw parę lub walutę rozliczenia."),
            details={"trade_ids": [trade_id for _, _, trade_id in nieznane_transakcje]},
            blocking=True,
        ))

    if fiat_as_crypto:
        issues.append(Issue(
            code="CRYPTO_FIAT_ASSET_MISCLASSIFIED",
            severity="ERROR",
            stage="TAX",
            scope_type="ENGINE",
            scope_id="crypto_tax",
            message=(
                "Transakcje krypto mają symbol waluty tradycyjnej i walutę rozliczenia "
                f"wirtualną ({', '.join(sorted(fiat_as_crypto))}). Dotyczy: "
                + "; ".join(f"{row.symbol}, {row.tax_event_date}, ID {row.trade_id}" for row in wynik.rows if row.kind == "FIAT_AS_CRYPTO")
                + ". W Historii transakcji otwórz edytor transakcji i popraw parę, stronę lub walutę."
            ),
            details={"trade_ids": [row.trade_id for row in wynik.rows if row.kind == "FIAT_AS_CRYPTO"]},
            blocking=True,
        ))

    if transakcje_bez_kursu_prowizji:
        issues.append(
            Issue(
                code="CRYPTO_SWAP_COMMISSION_NO_FX",
                severity="WARNING",
                stage="TAX",
                scope_type="ENGINE",
                scope_id="crypto_tax",
                message=(
                    f"Dla {transakcje_bez_kursu_prowizji} transakcji części E nie udało się przeliczyć prowizji na złote — "
                    "zwykle dlatego, że pobrano ją w walucie wirtualnej. Kwoty te nie weszły do kosztów części E."
                ),
                blocking=False,
            )
        )

    wynik.revenue_pln = q2(przychod)
    wynik.costs_current_year_pln = q2(koszty)
    wynik.total_costs_pln = q2(koszty + wynik.costs_carried_in_pln)

    # Nadwyzka kosztow nie jest strata do odliczenia od dochodow z papierow -
    # przechodzi na rok nastepny w ramach samej czesci E (art. 22 ust. 16).
    if wynik.total_costs_pln > wynik.revenue_pln:
        wynik.income_pln = Decimal("0.00")
        wynik.costs_carried_out_pln = q2(wynik.total_costs_pln - wynik.revenue_pln)
    else:
        wynik.income_pln = q2(wynik.revenue_pln - wynik.total_costs_pln)
        wynik.costs_carried_out_pln = Decimal("0.00")

    # Podatek od dochodu z czesci E zaokragla sie do pelnych zlotych, tak jak
    # pozostale kwoty deklaracji (art. 63 par. 1 Ordynacji podatkowej).
    wynik.tax_19_pln = q0(q2(q0(wynik.income_pln) * STAWKA))

    if wynik.skipped_no_fx_count:
        issues.append(
            Issue(
                code="CRYPTO_FX_RATE_MISSING",
                severity="ERROR",
                stage="TAX",
                scope_type="ENGINE",
                scope_id="crypto_tax",
                message=(
                    "Brakuje kursu NBP dla następujących operacji krypto: "
                    + "; ".join(f"{row.symbol}, {row.tax_event_date}, ID {row.trade_id}" for row in wynik.rows if row.kind == "BRAK_KURSU")
                    + ". Kwoty nie weszły do części E. W Historii transakcji otwórz edytor transakcji i uzupełnij kurs NBP z dnia roboczego poprzedzającego transakcję."
                ),
                details={"trade_ids": [row.trade_id for row in wynik.rows if row.kind == "BRAK_KURSU"]},
                blocking=True,
            )
        )

    if wynik.skipped_unknown_side_count:
        issues.append(
            Issue(
                code="CRYPTO_SIDE_UNKNOWN",
                severity="ERROR",
                stage="TAX",
                scope_type="ENGINE",
                scope_id="crypto_tax",
                message=(
                    "Nie rozpoznano strony następujących operacji krypto (kupno/sprzedaż): "
                    + "; ".join(f"{row.symbol}, {row.tax_event_date}, ID {row.trade_id}" for row in wynik.rows if row.kind == "NIEZNANA_STRONA")
                    + ". W Historii transakcji otwórz edytor transakcji i popraw stronę, parę lub walutę."
                ),
                details={"trade_ids": [row.trade_id for row in wynik.rows if row.kind == "NIEZNANA_STRONA"]},
                blocking=True,
            )
        )

    if wynik.costs_carried_out_pln > 0:
        issues.append(
            Issue(
                code="CRYPTO_COSTS_CARRIED_FORWARD",
                severity="INFO",
                stage="TAX",
                scope_type="ENGINE",
                scope_id="crypto_tax",
                message=(
                    f"Koszty nabycia walut wirtualnych przewyższają przychód o "
                    f"{wynik.costs_carried_out_pln} PLN. Nadwyżka przechodzi na rok następny "
                    "(art. 22 ust. 16 ustawy o PIT) — wpisz ją w ustawieniach przyszłego rozliczenia."
                ),
                blocking=False,
            )
        )

    return wynik, issues
