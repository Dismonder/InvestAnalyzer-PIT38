from __future__ import annotations

from decimal import Decimal
from pathlib import Path

import pandas as pd
import pytest
import requests

from zestaw_wejsciowy import zestaw_wejsciowy

from investment_tax_engine.models.core import FxLookupResult
from investment_tax_engine.tax.nbp_provider import (
    MAX_RATE_STALENESS_DAYS,
    CompositeFxProvider,
    LocalCsvNbpProvider,
    NbpApiProvider,
)


# Archiwum kursow: prawdziwe, gdy jest na dysku, inaczej syntetyczne.
NBP_2025_FIXTURE = zestaw_wejsciowy().nbp_csv[0]
FIXTURE_ROOT = NBP_2025_FIXTURE.parent
def test_local_csv_provider_uses_previous_business_day_lookup():
    provider = LocalCsvNbpProvider([NBP_2025_FIXTURE])

    lookup = provider.get_rate("USD", pd.Timestamp("2025-01-27"))

    assert lookup.currency == "USD"
    assert lookup.fx_date == pd.Timestamp("2025-01-24")
    assert lookup.rate > 0

def test_local_csv_provider_reports_2026_coverage_gap_when_only_2025_archive_exists():
    provider = LocalCsvNbpProvider([NBP_2025_FIXTURE])

    gaps = provider.coverage_report(
        pd.Timestamp("2026-01-02"),
        pd.Timestamp("2026-01-22"),
        {"USD", "EUR"},
    )

    assert gaps
    assert {gap.currency for gap in gaps} == {"USD", "EUR"}
    assert all(gap.reason == "Zakres dat wykracza poza dane w archiwum CSV" for gap in gaps)


def test_composite_provider_suppresses_csv_gap_when_api_fallback_can_cover(tmp_path: Path):
    csv_path = tmp_path / "partial_2026.csv"
    csv_path.write_text(
        "\n".join(
            [
                "dane;nr tabeli;pełny numer tabeli;1USD;1EUR;",
                ";",
                "20260423;080/A/NBP/2026;080/A/NBP/2026;3,7500;4,2500;",
            ]
        ),
        encoding="cp1250",
    )
    csv_provider = LocalCsvNbpProvider([csv_path])

    class FakeApiProvider:
        provider_name = "NBP_API"
        # Atrapa faktycznie zbadala zakres i stwierdzila pelne pokrycie, wiec
        # deklaruje to wprost. Prawdziwy NbpApiProvider tego nie potrafi i ma
        # reports_coverage = False, przez co jego pusta lista nie kasuje luk.
        reports_coverage = True

        def get_rate(self, currency: str, tax_event_date: pd.Timestamp) -> FxLookupResult:
            return FxLookupResult(
                currency=currency.upper(),
                tax_event_date=pd.Timestamp(tax_event_date).normalize(),
                fx_date=pd.Timestamp("2026-04-27"),
                rate=Decimal("3.6293"),
                source=self.provider_name,
            )

        def coverage_report(
            self,
            start_date: pd.Timestamp,
            end_date: pd.Timestamp,
            currencies: set[str],
        ):
            return []

    provider = CompositeFxProvider([csv_provider, FakeApiProvider()], coverage_provider=csv_provider)

    assert provider.coverage_report(
        pd.Timestamp("2026-04-24"),
        pd.Timestamp("2026-04-28"),
        {"USD", "EUR"},
    ) == []
    lookup = provider.get_rate("USD", pd.Timestamp("2026-04-28"))
    assert lookup.source == "NBP_API"
    assert lookup.fx_date == pd.Timestamp("2026-04-27")


def test_nbp_api_provider_reports_network_failure_as_controlled_lookup_error(tmp_path):
    class TimeoutSession:
        def get(self, *_args, **_kwargs):
            raise requests.Timeout("network timeout")

    # Wlasny katalog bufora. Bez niego dostawca siegnalby po wspolny bufor na
    # dysku i - majac tam juz tabele z tego dnia - w ogole nie probowalby polaczenia,
    # wiec test o awarii sieci nie mialby czego sprawdzic.
    provider = NbpApiProvider(session=TimeoutSession(), retry_count=0, cache_dir=tmp_path)

    try:
        provider.get_rate("USD", pd.Timestamp("2026-04-28"))
    except KeyError as exc:
        assert "NBP API request failed" in str(exc)
        assert "network timeout" in str(exc)
    else:
        raise AssertionError("Expected controlled NBP API lookup failure")


def test_provider_without_coverage_reporting_does_not_cancel_archive_gaps():
    """Pusta lista od dostawcy, ktory pokrycia nie bada, nie znaczy "pokrywam wszystko".

    Przy domyslnie wlaczonym fallbacku na API bramka kursowa nie mogla przez to
    zadzialac ani razu.
    """
    import pandas as pd

    from investment_tax_engine.models.core import FxCoverageGap
    from investment_tax_engine.tax.nbp_provider import CompositeFxProvider

    start = pd.Timestamp("2026-01-01")
    end = pd.Timestamp("2026-04-30")

    class ArchiveWithGap:
        provider_name = "NBP_CSV"
        reports_coverage = True

        def get_rate(self, currency, tax_event_date):  # pragma: no cover - nieuzywane w tescie
            raise KeyError(currency)

        def coverage_report(self, start_date, end_date, currencies):
            return [
                FxCoverageGap(
                    currency="USD",
                    start_date=start_date,
                    end_date=end_date,
                    provider_name=self.provider_name,
                    reason="Zakres dat wykracza poza dane w archiwum CSV",
                )
            ]

    class ApiWithoutCoverageReporting:
        provider_name = "NBP_API"
        reports_coverage = False

        def get_rate(self, currency, tax_event_date):  # pragma: no cover - nieuzywane w tescie
            raise KeyError(currency)

        def coverage_report(self, start_date, end_date, currencies):
            return []

    composite = CompositeFxProvider([ArchiveWithGap(), ApiWithoutCoverageReporting()])
    gaps = composite.coverage_report(start, end, {"USD"})

    assert [gap.currency for gap in gaps] == ["USD"]


def test_manual_fx_override_is_ignored_until_explicitly_enabled():
    """Kurs ustawowy to kurs NBP - korekta reczna wymaga swiadomej zgody."""
    from investment_tax_engine.models.core import EngineConfig, UserOverrides
    from investment_tax_engine.tax.nbp_provider import ManualOverrideProvider, build_fx_provider

    overrides = UserOverrides(manual_fx_overrides={"USD:2026-05-11": Decimal("3.9812")})
    config = EngineConfig(user_overrides=overrides, nbp_allow_api_fallback=False)

    provider = build_fx_provider(config, csv_paths=[])

    assert not any(isinstance(item, ManualOverrideProvider) for item in provider.providers)


def test_manual_fx_override_takes_precedence_when_enabled():
    """Dopisana na koncu lancucha korekta nigdy nie mogla niczego skorygowac."""
    from investment_tax_engine.models.core import EngineConfig, UserOverrides
    from investment_tax_engine.tax.nbp_provider import ManualOverrideProvider, build_fx_provider

    overrides = UserOverrides(manual_fx_overrides={"USD:2026-05-11": Decimal("3.9812")})
    config = EngineConfig(
        user_overrides=overrides,
        nbp_allow_manual_override=True,
        nbp_allow_api_fallback=False,
    )

    provider = build_fx_provider(config, csv_paths=[])

    assert isinstance(provider.providers[0], ManualOverrideProvider)
    lookup = provider.get_rate("USD", pd.Timestamp("2026-05-11"))
    assert lookup.rate == Decimal("3.9812")
    assert "MANUAL_OVERRIDE" in lookup.source


def _archive_with_a_hole(tmp_path: Path) -> Path:
    """Archiwum zlozone z dwoch rocznikow, bez roku posrodku."""
    rows = ["data;1USD", ";dolar amerykanski"]
    for day in range(20, 32):
        rows.append(f"202412{day:02d};4,0000")
    for day in range(2, 10):
        rows.append(f"202601{day:02d};4,5000")
    path = tmp_path / "archiwum_dziura.csv"
    path.write_bytes(("\n".join(rows) + "\n").encode("cp1250"))
    return path


def test_a_hole_in_the_middle_of_the_archive_is_refused_not_papered_over(tmp_path):
    """Cofanie sie do ostatniej publikacji ma obsluzyc weekend, nie brak rocznika.

    Bez gornej granicy transakcja z lipca 2025 dostawala kurs z 31 grudnia 2024 -
    sprzed 195 dni - i nic tego nie zglaszalo. Odmowa przekazuje zapytanie do
    kolejnego dostawcy albo do bramki, ktora zatrzyma rozliczenie.
    """
    provider = LocalCsvNbpProvider([_archive_with_a_hole(tmp_path)])

    with pytest.raises(KeyError) as failure:
        provider.previous_available_date(pd.Timestamp("2025-07-15"))

    assert "niekompletne" in str(failure.value)


def test_a_date_next_to_the_archived_days_still_resolves(tmp_path):
    provider = LocalCsvNbpProvider([_archive_with_a_hole(tmp_path)])

    assert provider.previous_available_date(pd.Timestamp("2026-01-08")) == pd.Timestamp("2026-01-07")


def test_a_holiday_cluster_is_still_within_the_bound():
    """Swieta ustawione obok weekendu nie moga wypasc poza granice swiezosci.

    Wczesniej test wpisywal daty z archiwum uzytkownika (23 -> 29 grudnia 2025),
    wiec na innym archiwum albo pekal, albo nie sprawdzal niczego. Regula jest
    ogolna: najdluzsza przerwa w publikacji tabeli A miesci sie w granicy, a
    kazdy dzien po przerwie dostaje kurs z dnia sprzed niej.
    """
    provider = LocalCsvNbpProvider([NBP_2025_FIXTURE])
    dates = provider.available_dates

    przerwy = [
        (poprzednia, kolejna, (kolejna - poprzednia).days)
        for poprzednia, kolejna in zip(dates, dates[1:])
    ]
    najdluzsza = max(przerwy, key=lambda przerwa: przerwa[2])

    assert najdluzsza[2] > 3, "archiwum bez skupiska swiatecznego nie sprawdza cofania sie"
    assert najdluzsza[2] <= MAX_RATE_STALENESS_DAYS, (
        f"przerwa {najdluzsza[0].date()} -> {najdluzsza[1].date()} przekracza granice swiezosci"
    )
    # Dzien po przerwie musi siegnac po kurs sprzed niej, a nie odmowic.
    assert provider.previous_available_date(najdluzsza[1] + pd.Timedelta(days=1)) == najdluzsza[1]
    assert provider.previous_available_date(najdluzsza[1]) == najdluzsza[0]


def test_every_business_day_of_the_real_archive_still_has_a_rate():
    """Ograniczenie nie moze zepsuc dnia, ktory dzialal przed zmiana."""
    provider = LocalCsvNbpProvider([NBP_2025_FIXTURE])
    first, last = provider.available_dates[0], provider.available_dates[-1]

    refused = []
    for day in pd.date_range(first + pd.Timedelta(days=1), last):
        try:
            provider.previous_available_date(day)
        except KeyError:
            refused.append(day.date())

    assert refused == [], f"te dni straciły kurs: {refused[:5]}"


def _archiwum(tmp_path: Path, wiersze: list[tuple[str, str, str | None]], nazwa: str = "archiwum.csv") -> Path:
    """Archiwum tabeli A: (data RRRRMMDD, kurs USD, numer tabeli albo None - bez kolumny numeru)."""
    z_numerami = any(numer is not None for _, _, numer in wiersze)
    naglowek = "data;1USD;nr tabeli;" if z_numerami else "data;1USD;"
    linie = [naglowek, ";dolar amerykanski;"]
    for dzien, kurs, numer in wiersze:
        linie.append(f"{dzien};{kurs};{numer};" if z_numerami else f"{dzien};{kurs};")
    path = tmp_path / nazwa
    path.write_bytes(("\n".join(linie) + "\n").encode("cp1250"))
    return path


def test_brak_wiersza_z_roboczego_poniedzialku_nie_daje_kursu_piatkowego(tmp_path):
    """Art. 11a: kurs z ostatniego dnia roboczego przed przychodem, nie z dnia wczesniejszego.

    Archiwum bez tabeli z poniedzialku 7.04.2025 dawalo wtorkowej sprzedazy kurs
    piatkowy - w granicy swiezosci, wiec nic tego nie zglaszalo.
    """
    provider = LocalCsvNbpProvider([
        _archiwum(tmp_path, [("20250404", "4,0000", "066"), ("20250408", "5,1000", "068")]),
    ])

    with pytest.raises(KeyError) as failure:
        provider.get_rate("USD", pd.Timestamp("2025-04-08"))

    assert "2025-04-07" in str(failure.value)


def test_brak_wiersza_bez_kolumny_numeru_tez_jest_odrzucany(tmp_path):
    provider = LocalCsvNbpProvider([
        _archiwum(tmp_path, [("20250404", "4,0000", None), ("20250408", "5,1000", None)]),
    ])

    with pytest.raises(KeyError):
        provider.previous_available_date(pd.Timestamp("2025-04-08"))


def test_kolejny_numer_tabeli_dowodzi_braku_publikacji_poza_kalendarzem(tmp_path):
    """Dzien wolny spoza kalendarza ustawowego: numeracja tabel jest ciagla, wiec kurs z piatku jest wlasciwy."""
    provider = LocalCsvNbpProvider([
        _archiwum(tmp_path, [("20250404", "4,0000", "066"), ("20250408", "5,1000", "067")]),
    ])

    lookup = provider.get_rate("USD", pd.Timestamp("2025-04-08"))

    assert lookup.fx_date == pd.Timestamp("2025-04-04")
    assert lookup.rate == Decimal("4.0000")


def test_weekend_i_poniedzialek_wielkanocny_nie_sa_luka(tmp_path):
    """Wielki Piatek jest dniem roboczym NBP, Poniedzialek Wielkanocny - nie."""
    provider = LocalCsvNbpProvider([
        _archiwum(tmp_path, [("20250418", "3,8000", None), ("20250422", "3,7000", None)]),
    ])

    assert provider.previous_available_date(pd.Timestamp("2025-04-22")) == pd.Timestamp("2025-04-18")
    assert provider.previous_available_date(pd.Timestamp("2025-04-20")) == pd.Timestamp("2025-04-18")


def test_luka_w_archiwum_przechodzi_do_api_z_wlasciwym_dniem(tmp_path):
    csv_provider = LocalCsvNbpProvider([
        _archiwum(tmp_path, [("20250404", "4,0000", "066"), ("20250408", "5,1000", "068")]),
    ])

    class ApiZTabelaPoniedzialkowa:
        provider_name = "NBP_API"
        reports_coverage = False

        def get_rate(self, currency: str, tax_event_date: pd.Timestamp) -> FxLookupResult:
            return FxLookupResult(
                currency=currency.upper(),
                tax_event_date=pd.Timestamp(tax_event_date).normalize(),
                fx_date=pd.Timestamp("2025-04-07"),
                rate=Decimal("5.0000"),
                source=self.provider_name,
            )

        def coverage_report(self, start_date, end_date, currencies):
            return []

    lookup = CompositeFxProvider([csv_provider, ApiZTabelaPoniedzialkowa()]).get_rate("USD", pd.Timestamp("2025-04-08"))

    assert (lookup.source, lookup.fx_date, lookup.rate) == ("NBP_API", pd.Timestamp("2025-04-07"), Decimal("5.0000"))


def test_kalendarz_swiat_ustawowych():
    from datetime import date

    from investment_tax_engine.tax.nbp_provider import dzien_publikacji_nbp, swieta_ustawowe

    assert {
        date(2025, 1, 6), date(2025, 4, 21), date(2025, 6, 8), date(2025, 6, 19), date(2025, 12, 24),
    } <= swieta_ustawowe(2025)
    assert {date(2026, 4, 6), date(2026, 5, 24), date(2026, 6, 4)} <= swieta_ustawowe(2026)
    # Wigilia jest dniem wolnym dopiero od 2025 r.
    assert dzien_publikacji_nbp(date(2024, 12, 24))
    assert not dzien_publikacji_nbp(date(2025, 12, 24))
    assert dzien_publikacji_nbp(date(2025, 4, 18)), "Wielki Piatek nie jest swietem ustawowym"
    assert not dzien_publikacji_nbp(date(2025, 4, 19)), "sobota"


def test_brak_kursu_niesie_walute_i_dzien_do_bramki_i_raportu_pokrycia(tmp_path):
    """Brak kursu dla transakcji musi byc widoczny w raporcie pokrycia NBP, nie tylko w bramce."""
    from types import SimpleNamespace

    from investment_tax_engine.models.core import CanonicalDataset, CanonicalTrade, EngineConfig, Ledger, MergeResult
    from investment_tax_engine.tax.filing_package import _build_nbp_coverage_report
    from investment_tax_engine.tax.fx_engine import enrich_merge_result_with_fx

    chwila = pd.Timestamp("2025-04-08 10:00")
    sprzedaz = CanonicalTrade(
        trade_id="SELL-USD", order_id="O-1", trade_number="1", symbol="NBIS.US", isin=None, side="SELL",
        instrument_type_code="1", instrument_class="EQUITY", market_id=None, quantity=Decimal("1"),
        price=Decimal("100"), gross_amount=Decimal("100"), trade_currency="USD", commission=Decimal("0"),
        commission_currency="USD", broker_reported_profit=None, executed_at=chwila, exchange_time=chwila,
        settlement_date=None, confirm_time=None, otc=False, repo_close=None, base_contract_code=None,
        current_position_qty_after_trade=None, source_name="API_JSON_FULL", source_priority=110,
        source_record_id="SELL-USD",
    )
    merge_result = MergeResult(ledger=Ledger(trades_by_id={sprzedaz.trade_id: sprzedaz}), canonical_dataset=CanonicalDataset())
    archiwum = LocalCsvNbpProvider([
        _archiwum(tmp_path, [("20250404", "4,0000", "066"), ("20250408", "5,1000", "068")]),
    ])

    enrich_merge_result_with_fx(merge_result, CompositeFxProvider([archiwum]), EngineConfig())

    [brak] = [issue for issue in merge_result.ledger.issues if issue.code == "NBP_RATE_NOT_FOUND"]
    assert brak.details == {"currency": "USD", "date": "2025-04-08"}
    assert not brak.message.startswith("'"), "komunikat bez apostrofow z repr KeyError"
    assert "2025-04-07" in brak.message

    raport = _build_nbp_coverage_report(
        SimpleNamespace(
            fx_coverage_gaps=[],
            merge_result=merge_result,
            transaction_history_rows=[],
            annual_summary={"tax_year": 2025},
            config=EngineConfig(tax_year=2025),
        )
    )
    assert raport["status"] == "fail"
    assert raport["missing"][0]["linked_record_ids"] == ["SELL-USD"]
    assert raport["missing"][0]["currency"] == "USD"


def test_brak_kursu_w_luce_zakresu_nie_jest_liczony_drugi_raz():
    """Brak kursu rekordu w walucie i dniu objetym luka zakresu to skutek tej luki, a nie osobny brak."""
    from types import SimpleNamespace

    from investment_tax_engine.models.core import EngineConfig, FxCoverageGap, Issue
    from investment_tax_engine.tax.filing_package import _build_nbp_coverage_report, _liczba_brakow_kursow

    def brak(rekord: str, waluta: str, dzien: str) -> Issue:
        return Issue(
            code="NBP_RATE_NOT_FOUND", severity="CRITICAL", stage="TAX_FX", scope_type="TRADE", scope_id=rekord,
            message=f"brak kursu {waluta} {dzien}", details={"currency": waluta, "date": dzien}, blocking=False,
        )

    wynik = SimpleNamespace(
        fx_coverage_gaps=[
            FxCoverageGap(
                currency="USD", start_date=pd.Timestamp("2026-01-02"), end_date=pd.Timestamp("2026-12-30"),
                provider_name="NBP_CSV", reason="Zakres dat wykracza poza dane w archiwum CSV",
            )
        ],
        merge_result=SimpleNamespace(ledger=SimpleNamespace(issues=[
            brak("T-1", "USD", "2026-05-05"), brak("T-2", "USD", "2026-06-08"), brak("T-3", "EUR", "2026-06-08"),
        ])),
        transaction_history_rows=[],
        annual_summary={"tax_year": 2026},
        config=EngineConfig(tax_year=2026),
    )

    raport = _build_nbp_coverage_report(wynik)

    assert raport["missing_rates"] == 2 == _liczba_brakow_kursow(wynik)
    assert [(w["currency"], w["linked_record_ids"]) for w in raport["missing"]] == [
        ("USD", ["T-1", "T-2"]),
        ("EUR", ["T-3"]),
    ]
