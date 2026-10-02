"""Deduplikacja transakcji nie moze scalac zapisow z roznych rachunkow ani roznych transakcji o tym samym numerze.

I6: rachunki rozdzielamy tylko wtedy, gdy wystepuja razem w jakims wspolnym pliku
    (wspolna przestrzen identyfikatorow). Gdy kazdy rachunek jest tylko w swoim pliku,
    nie zgadujemy - zostaja oba zapisy i powstaje blokujacy konflikt
    OVERLAPPING_SOURCE_ACCOUNT_AMBIGUOUS (ten sam rachunek bywa zapisany w dwoch formatach).
I7: numer transakcji jest unikalny tylko w obrebie rachunku i waloru - ten sam numer
    z innego rachunku albo dla innego waloru nie oznacza duplikatu.
Rachunek nieznany po jednej stronie zostawia dotychczasowe zachowanie (echo API vs XLSX).
"""

from __future__ import annotations

from investment_tax_engine.app.canonical_tax_input_adapter import deduplicate_trade_events

AMBIGUOUS = "OVERLAPPING_SOURCE_ACCOUNT_AMBIGUOUS"


def _zapis(
    event_id: str,
    plik: str,
    *,
    parser: str = "json",
    ticker: str = "XYZ.US",
    data: str = "2026-04-20",
    ilosc: str | None = "10",
    cena: str | None = "100",
    strona: str = "1",
    trade_id=None,
    rachunek: str | None = None,
):
    payload = {"operation": strona}
    if rachunek is not None:
        payload["account"] = rachunek
    if trade_id is not None:
        payload["id"] = trade_id
    amounts = {"currency": "USD"}
    if ilosc is not None:
        amounts["quantity"] = ilosc
    if cena is not None:
        amounts["price"] = cena
    return {
        "event_id": event_id,
        "event_kind": "trade",
        "source": {"filename": plik, "parser": parser},
        "identity": {"trade_id": trade_id},
        "instrument": {"ticker": ticker},
        "amounts": amounts,
        "date": {"trade_date": data},
        "raw": {"raw_payload": payload},
    }


def _id_zdarzen(zachowane) -> set[str]:
    return {event["event_id"] for event in zachowane}


def _konflikty(odrzucone, kod=AMBIGUOUS):
    return [row for row in odrzucone if row.get("code") == kod]


# --- I6 ---------------------------------------------------------------------------


def test_rachunki_wystepujace_razem_w_jednym_pliku_sa_rozdzielone():
    """Plik zawierajacy oba rachunki dowodzi, ze rachunki sa rozroznialne."""
    zdarzenia = [
        _zapis("api-a", "api.json", rachunek="ACC-A"),
        _zapis("api-b", "api.json", rachunek="ACC-B"),
        _zapis("xlsx-a", "arkusz.xlsx", parser="broker_transactions_xlsx", rachunek="ACC-A"),
        _zapis("xlsx-b", "arkusz.xlsx", parser="broker_transactions_xlsx", rachunek="ACC-B"),
    ]

    zachowane, odrzucone = deduplicate_trade_events(zdarzenia)

    assert _id_zdarzen(zachowane) == {"api-a", "api-b"}
    assert _konflikty(odrzucone) == []
    assert len(odrzucone) == 2


def test_dwa_takie_same_zakupy_na_rachunkach_tylko_w_swoich_plikach_zostaja_z_konfliktem():
    zdarzenia = [
        _zapis("a", "rachunek_a.json", rachunek="ACC-A", trade_id="A-1"),
        _zapis("b", "rachunek_b.json", rachunek="ACC-B", trade_id="B-1"),
    ]

    zachowane, odrzucone = deduplicate_trade_events(zdarzenia)

    assert _id_zdarzen(zachowane) == {"a", "b"}
    konflikty = _konflikty(odrzucone)
    assert len(konflikty) == 1
    assert konflikty[0]["symbol"] == "XYZ"
    assert {konflikty[0]["kept_file"], konflikty[0]["dropped_file"]} == {"rachunek_a.json", "rachunek_b.json"}
    assert sorted(konflikty[0]["accounts"]) == ["ACCA", "ACCB"]


def test_alias_rachunku_w_dwoch_formatach_nie_jest_zgadywany():
    """U123 i U123.TRD to moze ten sam rachunek - zapisy zostaja i uzytkownik wyklucza jeden plik."""
    zdarzenia = [
        _zapis("api", "api.json", rachunek="U123"),
        _zapis("xlsx", "arkusz.xlsx", parser="broker_transactions_xlsx", rachunek="U123.TRD"),
    ]

    zachowane, odrzucone = deduplicate_trade_events(zdarzenia)

    assert _id_zdarzen(zachowane) == {"api", "xlsx"}
    assert len(_konflikty(odrzucone)) == 1


def test_rozne_ilosci_na_rachunkach_tylko_w_swoich_plikach_daja_tylko_konflikt_rachunkow():
    zdarzenia = [
        _zapis("a", "rachunek_a.json", rachunek="ACC-A", ilosc="10"),
        _zapis("b", "rachunek_b.json", rachunek="ACC-B", ilosc="5"),
    ]

    zachowane, odrzucone = deduplicate_trade_events(zdarzenia)

    assert _id_zdarzen(zachowane) == {"a", "b"}
    assert len(_konflikty(odrzucone)) == 1


def test_rozne_ilosci_tego_samego_rachunku_w_dwoch_plikach_sa_konfliktem_zrodel():
    zdarzenia = [
        _zapis("a", "api.json", rachunek="ACC-A", ilosc="10"),
        _zapis("b", "raport.json", parser="broker_report_json", rachunek="ACC-A", ilosc="5"),
    ]

    _, odrzucone = deduplicate_trade_events(zdarzenia)

    assert _konflikty(odrzucone, "OVERLAPPING_SOURCE_QUANTITY_CONFLICT")
    assert _konflikty(odrzucone) == []


def test_ten_sam_rachunek_zapisany_inaczej_to_nadal_duplikat():
    zdarzenia = [
        _zapis("a", "api.json", rachunek="ACC-123 456"),
        _zapis("b", "arkusz.xlsx", parser="broker_transactions_xlsx", rachunek="acc123456"),
    ]

    zachowane, odrzucone = deduplicate_trade_events(zdarzenia)

    assert _id_zdarzen(zachowane) == {"a"}
    assert len(odrzucone) == 1


def test_rachunek_nieznany_po_jednej_stronie_zachowuje_dzisiejsze_echo():
    """Arkusz XLSX bez kolumny rachunku jest echem eksportu API - musi zniknac."""
    zdarzenia = [
        _zapis("api", "api.json", rachunek="ACC-A"),
        _zapis("xlsx", "arkusz.xlsx", parser="broker_transactions_xlsx"),
    ]

    zachowane, odrzucone = deduplicate_trade_events(zdarzenia)

    assert _id_zdarzen(zachowane) == {"api"}
    assert len(odrzucone) == 1


# --- I7 ---------------------------------------------------------------------------


def test_ten_sam_numer_transakcji_na_rozroznialnych_rachunkach_to_dwie_transakcje():
    zdarzenia = [
        _zapis("a", "wspolny.json", rachunek="ACC-A", trade_id="123", cena="100"),
        _zapis("b", "wspolny.json", rachunek="ACC-B", trade_id="123", cena="105"),
    ]

    zachowane, odrzucone = deduplicate_trade_events(zdarzenia)

    assert _id_zdarzen(zachowane) == {"a", "b"}
    assert odrzucone == []


def test_ten_sam_numer_na_rachunkach_tylko_w_swoich_plikach_zostaje_z_konfliktem():
    zdarzenia = [
        _zapis("a", "rachunek_a.json", rachunek="ACC-A", trade_id="123", cena="100"),
        _zapis("b", "rachunek_b.json", rachunek="ACC-B", trade_id="123", cena="105"),
    ]

    zachowane, odrzucone = deduplicate_trade_events(zdarzenia)

    assert _id_zdarzen(zachowane) == {"a", "b"}
    assert len(_konflikty(odrzucone)) == 1


def test_ten_sam_numer_transakcji_dla_roznych_walorow_to_dwie_transakcje():
    zdarzenia = [
        _zapis("a", "api_1.json", ticker="AAA.US", trade_id="123"),
        _zapis("b", "api_2.json", ticker="BBB.US", trade_id="123", cena="55"),
    ]

    zachowane, odrzucone = deduplicate_trade_events(zdarzenia)

    assert _id_zdarzen(zachowane) == {"a", "b"}
    assert odrzucone == []


def test_ten_sam_numer_transakcji_przy_roznej_stronie_to_dwie_transakcje():
    zdarzenia = [
        _zapis("kupno", "api_1.json", trade_id="123", strona="1"),
        _zapis("sprzedaz", "api_2.json", trade_id="123", strona="2", cena="120"),
    ]

    zachowane, _ = deduplicate_trade_events(zdarzenia)

    assert _id_zdarzen(zachowane) == {"kupno", "sprzedaz"}


def test_ten_sam_numer_i_walor_w_odleglych_dniach_z_inna_cena_to_dwie_transakcje():
    zdarzenia = [
        _zapis("a", "api_1.json", trade_id="123", data="2025-03-03"),
        _zapis("b", "api_2.json", trade_id="123", data="2026-04-20", cena="130"),
    ]

    zachowane, _ = deduplicate_trade_events(zdarzenia)

    assert _id_zdarzen(zachowane) == {"a", "b"}


def test_ten_sam_numer_walor_strona_i_rachunek_nadal_sa_duplikatem():
    zdarzenia = [
        _zapis("a", "api.json", trade_id="123", rachunek="ACC-A"),
        _zapis("b", "raport.json", parser="broker_report_json", ticker="XYZ", trade_id="123/777", rachunek="ACC-A"),
    ]

    zachowane, odrzucone = deduplicate_trade_events(zdarzenia)

    assert _id_zdarzen(zachowane) == {"a"}
    assert len(odrzucone) == 1


def test_ten_numer_z_dniem_zawarcia_i_dniem_ksiegowania_nadal_jest_duplikatem():
    zdarzenia = [
        _zapis("a", "api.json", trade_id="123", data="2025-06-04"),
        _zapis("b", "raport.json", parser="broker_report_json", trade_id="123", data="2025-06-05"),
    ]

    zachowane, _ = deduplicate_trade_events(zdarzenia)

    assert _id_zdarzen(zachowane) == {"a"}


def test_piatek_gieldy_i_wtorek_po_swiecie_z_data_rozliczenia_to_ten_sam_numer():
    """Plik z sama data rozliczenia (T+2, poniedzialek swiateczny) nie moze podwoic dochodu."""
    zdarzenia = [
        _zapis("gielda", "api.json", trade_id="123", data="2026-04-03"),
        _zapis("rozliczenie", "raport.json", parser="broker_report_json", trade_id="123", data="2026-04-07",
               ilosc=None, cena=None),
    ]

    zachowane, odrzucone = deduplicate_trade_events(zdarzenia)

    assert _id_zdarzen(zachowane) == {"gielda"}
    assert len(odrzucone) == 1


def test_ten_sam_numer_ilosc_i_cena_przy_odleglej_dacie_to_duplikat():
    """Zgodna ilosc i cena rozstrzygaja - daty nie porownujemy."""
    zdarzenia = [
        _zapis("a", "api.json", trade_id="123", data="2026-04-03"),
        _zapis("b", "raport.json", parser="broker_report_json", trade_id="123", data="2026-04-20"),
    ]

    zachowane, _ = deduplicate_trade_events(zdarzenia)

    assert _id_zdarzen(zachowane) == {"a"}


def test_ten_sam_numer_bez_ilosci_i_ceny_przy_dacie_ponad_pieciu_dni_roboczych_to_dwie_transakcje():
    zdarzenia = [
        _zapis("a", "api.json", trade_id="123", data="2026-04-03", ilosc=None, cena=None),
        _zapis("b", "raport.json", parser="broker_report_json", trade_id="123", data="2026-04-20", ilosc=None, cena=None),
    ]

    zachowane, _ = deduplicate_trade_events(zdarzenia)

    assert _id_zdarzen(zachowane) == {"a", "b"}


def test_niejednoznaczny_rachunek_blokuje_rozliczenie_i_wskazuje_wykluczenie_pliku():
    from investment_tax_engine.app.canonical_tax_input_adapter import build_parsed_sources_from_canonical_tax_input
    from investment_tax_engine.app.engine import InvestmentTaxEngine
    from investment_tax_engine.validation.quality_gates import BLOCKING_GATE_CODES

    def _rekord(event_id, plik, rachunek):
        zapis = _zapis(event_id, plik, rachunek=rachunek, data="2026-04-20")
        zapis["amounts"]["gross"] = "1000"
        zapis["source"]["relative_path"] = plik
        return zapis

    wejscie = {
        "schema_version": "canonical_tax_input.v2",
        "records": [_rekord("a", "api.json", "U123"), _rekord("b", "arkusz.xlsx", "U123.TRD")],
    }

    _, raport = build_parsed_sources_from_canonical_tax_input(wejscie, tax_year=2026)

    assert raport["consumedTradeEvents"] == 2
    problemy = InvestmentTaxEngine._canonical_source_conflict_issues(raport)
    assert [problem.code for problem in problemy] == [AMBIGUOUS]
    assert problemy[0].blocking is True
    assert AMBIGUOUS in BLOCKING_GATE_CODES
    assert "Dokumenty i silnik" in problemy[0].message
    assert "wyłącz" in problemy[0].message
