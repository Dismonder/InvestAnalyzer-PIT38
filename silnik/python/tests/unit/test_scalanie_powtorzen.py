"""Ta sama transakcja opisana w kilku plikach to jedna transakcja.

Na rachunku uzytkownika ta sama operacja przychodzila z dziewieciu plikow
(eksport API, reczne raporty brokera, arkusze) i wchodzila do rozliczenia po
kilka razy - 2573 rekordy przy 1408 rzeczywistych transakcjach.
"""

from investment_tax_engine.app.canonical_tax_input_adapter import deduplicate_trade_events
from investment_tax_engine.app.engine import InvestmentTaxEngine
from investment_tax_engine.models.core import EngineConfig


def _zdarzenie(event_id, plik, parser, ticker, data, ilosc, cena, strona="1", trade_id=None):
    return {
        "event_id": event_id,
        "event_kind": "trade",
        "source": {"filename": plik, "parser": parser},
        "identity": {"trade_id": trade_id},
        "instrument": {"ticker": ticker},
        "amounts": {"quantity": ilosc, "price": cena, "currency": "USD"},
        "date": {"trade_date": data},
        "raw": {"raw_payload": {"operation": strona}},
    }


def test_ta_sama_transakcja_z_dwoch_plikow_liczy_sie_raz():
    zdarzenia = [
        _zdarzenie("a", "eksport.json", "broker_report_json", "NBIS.US", "2026-04-20", "20", "156.00"),
        _zdarzenie("b", "arkusz.xlsx", "spreadsheet", "NBIS", "2026-04-20", "20", "156.00"),
    ]

    zachowane, odrzucone = deduplicate_trade_events(zdarzenia)

    assert len(zachowane) == 1, "ta sama transakcja w dwoch plikach to jedna transakcja"
    assert len(odrzucone) == 1


def test_dwa_wypelnienia_tego_samego_zlecenia_w_jednym_pliku_zostaja():
    # Dwie identyczne transakcje w JEDNYM wyciagu to naprawde dwie transakcje.
    zdarzenia = [
        _zdarzenie("a", "eksport.json", "broker_report_json", "NBIS.US", "2026-04-20", "20", "156.00"),
        _zdarzenie("b", "eksport.json", "broker_report_json", "NBIS.US", "2026-04-20", "20", "156.00"),
        _zdarzenie("c", "arkusz.xlsx", "spreadsheet", "NBIS", "2026-04-20", "20", "156.00"),
    ]

    zachowane, _ = deduplicate_trade_events(zdarzenia)

    assert len(zachowane) == 2, "maksimum z jednego pliku, nie suma"


def test_rozne_transakcje_nie_sa_scalane():
    zdarzenia = [
        _zdarzenie("a", "eksport.json", "broker_report_json", "NBIS.US", "2026-04-20", "20", "156.00"),
        _zdarzenie("b", "eksport.json", "broker_report_json", "NBIS.US", "2026-04-20", "20", "157.00"),
        _zdarzenie("c", "eksport.json", "broker_report_json", "INTC.US", "2026-04-20", "20", "156.00"),
    ]

    zachowane, odrzucone = deduplicate_trade_events(zdarzenia)

    assert len(zachowane) == 3
    assert odrzucone == []


def test_ta_sama_transakcja_pod_dniem_zawarcia_i_dniem_ksiegowania():
    """Jeden plik zapisuje transakcje pod dniem gieldy, drugi pod dniem ksiegowania.

    Na rachunku uzytkownika dotyczylo to 22 z 542 transakcji: ta sama sprzedaz
    NBIS liczyla sie dwa razy (54 sztuki zamiast 27), a nadmiarowa polowa
    wchodzila do rozliczenia jako sprzedaz bez pokrycia z zerowym kosztem.
    """
    zdarzenia = [
        _zdarzenie("a", "eksport.json", "broker_report_json", "NBIS.US", "2025-06-04", "27", "40.60", "2"),
        _zdarzenie("b", "kopia.json", "broker_report_json", "NBIS", "2025-06-05", "27", "40.60", "2"),
    ]

    zachowane, odrzucone = deduplicate_trade_events(zdarzenia)

    assert len(zachowane) == 1, "dzien zawarcia i dzien ksiegowania to jedna transakcja"
    assert len(odrzucone) == 1


def test_dwie_takie_same_transakcje_w_jednym_pliku_w_kolejnych_dniach_zostaja():
    # Ten sam plik, dwa kolejne dni - to naprawde dwie transakcje.
    zdarzenia = [
        _zdarzenie("a", "eksport.json", "broker_report_json", "NBIS.US", "2025-06-04", "27", "40.60", "2"),
        _zdarzenie("b", "eksport.json", "broker_report_json", "NBIS.US", "2025-06-05", "27", "40.60", "2"),
    ]

    zachowane, _ = deduplicate_trade_events(zdarzenia)

    assert len(zachowane) == 2


def test_kupno_z_jednego_pliku_nie_usuwa_sprzedazy_z_drugiego():
    zdarzenia = [
        _zdarzenie("kupno", "api.json", "json", "ABC.US", "2025-06-10", "2", "10", "1"),
        _zdarzenie("sprzedaz", "raport.json", "broker_report_json", "ABC.US", "2025-06-10", "2", "12", "2"),
    ]

    zachowane, odrzucone = deduplicate_trade_events(zdarzenia)

    assert {row["event_id"] for row in zachowane} == {"kupno", "sprzedaz"}
    assert odrzucone == []


def test_rozna_ziarnistosc_z_ta_sama_iloscia_nie_jest_konfliktem():
    zdarzenia = [
        _zdarzenie("zbiorcza", "api.json", "json", "ABC.US", "2025-06-10", "4", "10", "2"),
        _zdarzenie("wypelnienie-1", "raport.json", "broker_report_json", "ABC.US", "2025-06-10", "2", "9", "2"),
        _zdarzenie("wypelnienie-2", "raport.json", "broker_report_json", "ABC.US", "2025-06-10", "2", "11", "2"),
    ]

    zachowane, odrzucone = deduplicate_trade_events(zdarzenia)

    assert [row["event_id"] for row in zachowane] == ["zbiorcza"]
    assert len(odrzucone) == 2
    assert not any(row.get("code") == "OVERLAPPING_SOURCE_QUANTITY_CONFLICT" for row in odrzucone)


def test_rozna_ilosc_zrodla_blokuje_gotowosc_zeznania():
    zdarzenia = [
        _zdarzenie("api", "api.json", "json", "ABC.US", "2025-06-10", "4", "10", "2"),
        _zdarzenie("raport", "raport.json", "broker_report_json", "ABC.US", "2025-06-10", "5", "11", "2"),
    ]

    _, odrzucone = deduplicate_trade_events(zdarzenia)
    engine = InvestmentTaxEngine(EngineConfig())
    issues = engine._canonical_source_conflict_issues({"sourceQuantityConflicts": odrzucone})
    report = engine.resolve_quality(issues)

    assert len(issues) == 1
    assert issues[0].severity == "ERROR"
    assert issues[0].details["kept_quantity"] == "4"
    assert issues[0].details["dropped_quantity"] == "5"
    assert issues[0].details["kept_file"] == "api.json"
    assert issues[0].details["dropped_file"] == "raport.json"
    assert issues[0].details["side"] == "SELL"
    assert report.filing_ready is False


def test_kontrola_ilosci_widzi_czesciowe_pokrycie_przed_scaleniem_wypelnien():
    zdarzenia = [
        _zdarzenie("api-1", "api.json", "json", "ABC.US", "2025-06-10", "2", "10", "2"),
        _zdarzenie("api-2", "api.json", "json", "ABC.US", "2025-06-10", "2", "10", "2"),
        _zdarzenie("raport", "raport.json", "broker_report_json", "ABC.US", "2025-06-10", "2", "10", "2"),
    ]

    zachowane, odrzucone = deduplicate_trade_events(zdarzenia)
    konflikty = [row for row in odrzucone if row.get("code") == "OVERLAPPING_SOURCE_QUANTITY_CONFLICT"]

    assert len(zachowane) == 2
    assert len(konflikty) == 1
    assert konflikty[0]["kept_quantity"] == "4"
    assert konflikty[0]["dropped_quantity"] == "2"


def test_podsumowanie_zgrupowano_nie_jest_konfliktem_ilosci():
    """Raport brokera za caly okres ma wiersz "Zgrupowano": suma sprzedazy waloru
    ze srednia cena, przypieta do jednego dnia. To nie jest transakcja tego dnia,
    wiec nie wolno porownywac jej ilosci z pojedynczymi zapisami innych plikow."""
    agregat = _zdarzenie("g", "raport_okres.json", "broker_report_json", "NBIS", "2025-02-10", "3098", "141.00305681", "2")
    agregat["raw"]["raw_payload"].update({"id": "Zgrupowano", "date": "Zgrupowano"})
    zdarzenia = [
        _zdarzenie("a", "eksport.json", "broker_report_json", "NBIS.US", "2025-02-10", "3", "41.07", "2", trade_id="T-1"),
        agregat,
    ]

    zachowane, odrzucone = deduplicate_trade_events(zdarzenia)

    assert not any(row.get("code") == "OVERLAPPING_SOURCE_QUANTITY_CONFLICT" for row in odrzucone)
    assert [event["event_id"] for event in zachowane] == ["a"], "agregat nie wchodzi do rozliczenia"


def _konflikty(odrzucone):
    return [row for row in odrzucone if row.get("code") == "OVERLAPPING_SOURCE_QUANTITY_CONFLICT"]


def test_dzien_gieldy_i_dzien_ksiegowania_nie_sa_konfliktem_ilosci():
    """INTC na rachunku uzytkownika: eksport ma 20 szt. 29.04 i 10 szt. 30.04, raport
    10 i 20 - te same transakcje przypisane do sasiednich dni, razem po 30 sztuk."""
    zdarzenia = [
        _zdarzenie("a1", "komplet.json", "json", "INTC.US", "2026-04-29", "20", "20.10", "1", trade_id="T-1"),
        _zdarzenie("a2", "komplet.json", "json", "INTC.US", "2026-04-30", "10", "20.50", "1", trade_id="T-2"),
        _zdarzenie("b1", "raport.json", "broker_report_json", "INTC", "2026-04-29", "10", "20.10", "1"),
        _zdarzenie("b2", "raport.json", "broker_report_json", "INTC", "2026-04-30", "10", "20.10", "1"),
        _zdarzenie("b3", "raport.json", "broker_report_json", "INTC", "2026-04-30", "10", "20.50", "1"),
    ]

    _, odrzucone = deduplicate_trade_events(zdarzenia)

    assert _konflikty(odrzucone) == []


def test_plik_konczacy_sie_wczesniej_nie_jest_brakiem_transakcji():
    zdarzenia = [
        _zdarzenie("a1", "komplet.json", "json", "NBIS.US", "2026-05-04", "5", "90", "1", trade_id="T-1"),
        _zdarzenie("a2", "komplet.json", "json", "NBIS.US", "2026-06-15", "7", "95", "1", trade_id="T-2"),
        _zdarzenie("b1", "raport.json", "broker_report_json", "NBIS", "2026-05-04", "5", "90", "1"),
    ]

    _, odrzucone = deduplicate_trade_events(zdarzenia)

    assert _konflikty(odrzucone) == [], "raport konczy sie 4 maja - czerwiec jest poza wspolnym okresem"


def test_brak_transakcji_w_skupisku_dni_jest_konfliktem_z_zakresem_dat():
    zdarzenia = [
        _zdarzenie("a1", "komplet.json", "json", "NBIS.US", "2026-05-04", "10", "90", "2", trade_id="T-1"),
        _zdarzenie("a2", "komplet.json", "json", "NBIS.US", "2026-05-12", "1", "91", "2", trade_id="T-2"),
        _zdarzenie("b1", "raport.json", "broker_report_json", "NBIS", "2026-05-04", "10", "90", "2"),
        _zdarzenie("b2", "raport.json", "broker_report_json", "NBIS", "2026-05-05", "5", "92", "2"),
        _zdarzenie("b3", "raport.json", "broker_report_json", "NBIS", "2026-05-12", "1", "91", "2"),
    ]

    _, odrzucone = deduplicate_trade_events(zdarzenia)
    konflikty = _konflikty(odrzucone)

    assert len(konflikty) == 1
    assert (konflikty[0]["day"], konflikty[0]["day_to"]) == ("2026-05-04", "2026-05-05")
    assert (konflikty[0]["kept_quantity"], konflikty[0]["dropped_quantity"]) == ("10", "15")


def test_wspolny_id_nie_tworzy_falszywego_konfliktu_sumy():
    zdarzenia = [
        _zdarzenie("api-1", "api.json", "json", "ABC.US", "2025-06-10", "10", "10", "2", "ID-1"),
        _zdarzenie("api-2", "api.json", "json", "ABC.US", "2025-06-10", "5", "11", "2", "ID-2"),
        _zdarzenie("raport-1", "raport.json", "broker_report_json", "ABC.US", "2025-06-10", "10", "10", "2", "ID-1"),
        _zdarzenie("raport-2", "raport.json", "broker_report_json", "ABC.US", "2025-06-10", "5", "12", "2", "ID-3"),
    ]

    _, odrzucone = deduplicate_trade_events(zdarzenia)

    assert not any(row.get("code") == "OVERLAPPING_SOURCE_QUANTITY_CONFLICT" for row in odrzucone)


def test_piatek_i_poniedzialek_to_sasiednie_dni_bez_konfliktu():
    """Plik z data rozliczenia (T+1) przenosi piatkowa transakcje na poniedzialek."""
    zdarzenia = [
        _zdarzenie("a0", "komplet.json", "json", "NBIS.US", "2026-05-06", "2", "90", "2", trade_id="T-0"),
        _zdarzenie("a1", "komplet.json", "json", "NBIS.US", "2026-05-08", "5", "91", "2", trade_id="T-1"),
        _zdarzenie("b0", "raport.json", "broker_report_json", "NBIS", "2026-05-06", "2", "90", "2"),
        _zdarzenie("b1", "raport.json", "broker_report_json", "NBIS", "2026-05-11", "5", "91", "2"),
    ]

    _, odrzucone = deduplicate_trade_events(zdarzenia)

    assert _konflikty(odrzucone) == []


def test_nowa_transakcja_po_koncu_pliku_odniesienia_nie_jest_konfliktem():
    # Eksport konczy sie w piatek; raport ma juz transakcje z poniedzialku - to nie rozjazd.
    zdarzenia = [
        _zdarzenie("a1", "komplet.json", "json", "NBIS.US", "2026-05-08", "5", "91", "2", trade_id="T-1"),
        _zdarzenie("b1", "raport.json", "broker_report_json", "NBIS", "2026-05-08", "5", "91", "2"),
        _zdarzenie("b2", "raport.json", "broker_report_json", "NBIS", "2026-05-11", "3", "95", "2"),
    ]

    _, odrzucone = deduplicate_trade_events(zdarzenia)

    assert _konflikty(odrzucone) == []
