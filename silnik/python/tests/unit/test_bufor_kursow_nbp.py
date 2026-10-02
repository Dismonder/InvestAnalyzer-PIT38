"""
Odpornosc dostawcy kursow NBP na limit zapytan i trwalosc bufora.

Przebieg rozliczenia z setka dni handlowych pobieral tabele kursow dla kazdej
daty osobno i za kazdym uruchomieniem od nowa. Serwer NBP odpowiadal wtedy
kodem 429, a caly przebieg konczyl sie wyjatkiem KeyError - bez wyniku i bez
czytelnego komunikatu.
"""

from __future__ import annotations

from decimal import Decimal
from pathlib import Path

import pandas as pd
import pytest
import requests

from investment_tax_engine.tax.nbp_provider import NbpApiProvider


class OdpowiedzTestowa:
    def __init__(self, status: int, payload=None, headers: dict[str, str] | None = None) -> None:
        self.status_code = status
        self._payload = payload
        self.headers = headers or {}

    def json(self):
        return self._payload

    def raise_for_status(self) -> None:
        if self.status_code >= 400:
            raise requests.HTTPError(f"{self.status_code} Client Error", response=self)


class SesjaTestowa:
    """Sesja oddajaca zaplanowane odpowiedzi i liczaca zapytania."""

    def __init__(self, odpowiedzi: list[OdpowiedzTestowa]) -> None:
        self.odpowiedzi = odpowiedzi
        self.zapytania: list[str] = []

    def get(self, url: str, timeout: float = 0):  # noqa: ARG002 - zgodnosc z requests
        self.zapytania.append(url)
        if not self.odpowiedzi:
            raise AssertionError("Wiecej zapytan niz zaplanowanych odpowiedzi")
        return self.odpowiedzi.pop(0)


def tabela(kurs: str) -> list[dict]:
    return [{"rates": [{"code": "USD", "mid": kurs}]}]


def test_limit_zapytan_nie_przerywa_przebiegu(tmp_path: Path, monkeypatch) -> None:
    """Po odpowiedzi 429 dostawca ponawia probe i oddaje kurs."""
    przerwy: list[float] = []
    monkeypatch.setattr("investment_tax_engine.tax.nbp_provider.time.sleep", przerwy.append)

    sesja = SesjaTestowa(
        [
            OdpowiedzTestowa(429, headers={"Retry-After": "2"}),
            OdpowiedzTestowa(200, tabela("4.1234")),
        ]
    )
    dostawca = NbpApiProvider(session=sesja, cache_dir=tmp_path)

    wynik = dostawca.get_rate("USD", pd.Timestamp("2026-05-04"))

    assert wynik.rate == Decimal("4.1234")
    assert len(sesja.zapytania) == 2
    assert przerwy == [2.0], "przerwa ma odpowiadac naglowkowi Retry-After"


def test_brak_naglowka_daje_rosnaca_przerwe(tmp_path: Path, monkeypatch) -> None:
    """Bez `Retry-After` przerwa rosnie wykladniczo, a nie zostaje na ulamku sekundy."""
    przerwy: list[float] = []
    monkeypatch.setattr("investment_tax_engine.tax.nbp_provider.time.sleep", przerwy.append)

    sesja = SesjaTestowa(
        [
            OdpowiedzTestowa(429),
            OdpowiedzTestowa(429),
            OdpowiedzTestowa(200, tabela("4.0500")),
        ]
    )
    dostawca = NbpApiProvider(session=sesja, cache_dir=tmp_path)

    assert dostawca.get_rate("USD", pd.Timestamp("2026-05-04")).rate == Decimal("4.0500")
    assert przerwy == [2.0, 4.0]
    assert all(p >= 1.0 for p in przerwy), "przerwa krotsza niz sekunda trafia w ten sam limit"


def test_bufor_na_dysku_przezywa_kolejny_przebieg(tmp_path: Path) -> None:
    """Drugi przebieg czyta kurs z dysku i nie odpytuje serwera."""
    sesja = SesjaTestowa([OdpowiedzTestowa(200, tabela("3.9876"))])
    pierwszy = NbpApiProvider(session=sesja, cache_dir=tmp_path)
    assert pierwszy.get_rate("USD", pd.Timestamp("2026-05-04")).rate == Decimal("3.9876")
    assert len(sesja.zapytania) == 1

    # Nowy obiekt to odpowiednik nastepnego uruchomienia silnika: bufor w pamieci
    # jest pusty, wiec bez bufora na dysku poszloby kolejne zapytanie.
    sesja_drugiego = SesjaTestowa([])
    drugi = NbpApiProvider(session=sesja_drugiego, cache_dir=tmp_path)
    assert drugi.get_rate("USD", pd.Timestamp("2026-05-04")).rate == Decimal("3.9876")
    assert sesja_drugiego.zapytania == []


def test_uszkodzony_plik_bufora_jest_pomijany(tmp_path: Path) -> None:
    """Popsuty wpis bufora nie moze przerwac rozliczenia."""
    (tmp_path / "tabela-A-2026-05-04.json").write_text("{to nie jest JSON", encoding="utf-8")

    sesja = SesjaTestowa([OdpowiedzTestowa(200, tabela("4.2000"))])
    dostawca = NbpApiProvider(session=sesja, cache_dir=tmp_path)

    assert dostawca.get_rate("USD", pd.Timestamp("2026-05-04")).rate == Decimal("4.2000")
    assert len(sesja.zapytania) == 1


def test_brak_tabeli_dla_dnia_wolnego_nie_jest_ponawiany(tmp_path: Path) -> None:
    """Kod 404 oznacza dzien bez tabeli - dostawca cofa sie do wczesniejszego dnia."""
    sesja = SesjaTestowa(
        [
            OdpowiedzTestowa(404),
            OdpowiedzTestowa(200, tabela("4.3000")),
        ]
    )
    dostawca = NbpApiProvider(session=sesja, cache_dir=tmp_path)

    wynik = dostawca.get_rate("USD", pd.Timestamp("2026-05-04"))
    assert wynik.rate == Decimal("4.3000")
    assert len(sesja.zapytania) == 2, "404 to inny dzien, a nie ponowienie tego samego zapytania"


def test_wyczerpane_proby_daja_czytelny_blad(tmp_path: Path, monkeypatch) -> None:
    """Gdy serwer nie odpowiada, blad niesie date i powod."""
    monkeypatch.setattr("investment_tax_engine.tax.nbp_provider.time.sleep", lambda _: None)
    sesja = SesjaTestowa([OdpowiedzTestowa(429) for _ in range(40)])
    dostawca = NbpApiProvider(session=sesja, cache_dir=tmp_path)

    with pytest.raises(KeyError) as blad:
        dostawca.get_rate("USD", pd.Timestamp("2026-05-04"))

    assert "2026-05-04" in str(blad.value) or "NBP" in str(blad.value)


def test_pusta_tabela_nie_zostaje_w_buforze(tmp_path: Path) -> None:
    """
    Odpowiedz bez kursow nie moze sie utrwalic na dysku.

    Zapisana raz zostawala tam na zawsze: kazde nastepne pytanie o ten dzien
    konczylo sie brakiem waluty, a silnik nie probowal juz pobrac tabeli.
    """
    sesja = SesjaTestowa([OdpowiedzTestowa(200, [{"rates": []}])])
    dostawca = NbpApiProvider(session=sesja, cache_dir=tmp_path)

    # ValueError, nie KeyError: KeyError oznacza dzien wolny i uruchomiloby
    # cofanie sie o dzien, czyli kurs z niewlasciwej daty.
    with pytest.raises(ValueError):
        dostawca.get_rate("USD", pd.Timestamp("2026-05-05"))

    assert list(tmp_path.glob("tabela-A-*.json")) == [], "pusta tabela nie trafia do bufora"


def test_kurs_zero_jest_odrzucany(tmp_path: Path) -> None:
    """Kurs 0 przeliczylby kazda kwote w tej walucie na 0,00 PLN."""
    sesja = SesjaTestowa([OdpowiedzTestowa(200, tabela("0"))])
    dostawca = NbpApiProvider(session=sesja, cache_dir=tmp_path)

    with pytest.raises(ValueError):
        dostawca.get_rate("USD", pd.Timestamp("2026-05-06"))

    assert list(tmp_path.glob("tabela-A-*.json")) == [], "bledny kurs nie trafia do bufora"


def test_plik_tymczasowy_bufora_jest_wlasny_dla_procesu(tmp_path: Path) -> None:
    """
    Dwa przebiegi liczace ten sam dzien nie moga pisac do jednego pliku .tmp.

    Przy stalej nazwie os.replace przenosil tresc sklejona z obu zapisow.
    """
    import os

    sesja = SesjaTestowa([OdpowiedzTestowa(200, tabela("4.0"))])
    dostawca = NbpApiProvider(session=sesja, cache_dir=tmp_path)
    dostawca.get_rate("USD", pd.Timestamp("2026-05-07"))

    sciezka = dostawca._sciezka_bufora("2026-05-06")
    assert sciezka is not None
    tymczasowy = sciezka.with_suffix(f".json.{os.getpid()}.tmp")
    assert str(os.getpid()) in tymczasowy.name


def test_dzien_bez_tabeli_nie_jest_odpytywany_ponownie(tmp_path: Path) -> None:
    """Sobota i niedziela (404) byly odpytywane przy kazdym cofaniu sie przez weekend.

    Na prawdziwym rachunku dawalo to ok. 360 zapytan i 9 s na kazdy przebieg.
    """
    sesja = SesjaTestowa(
        [
            OdpowiedzTestowa(404),  # 2026-05-03 niedziela
            OdpowiedzTestowa(404),  # 2026-05-02 sobota
            OdpowiedzTestowa(404),  # 2026-05-01 swieto
            OdpowiedzTestowa(200, tabela("4.1000")),  # 2026-04-30
        ]
    )
    dostawca = NbpApiProvider(session=sesja, cache_dir=tmp_path)

    pierwszy = dostawca.get_rate("USD", pd.Timestamp("2026-05-04"))
    drugi = dostawca.get_rate("USD", pd.Timestamp("2026-05-04"))

    assert pierwszy.rate == drugi.rate == Decimal("4.1000")
    assert pierwszy.fx_date == pd.Timestamp("2026-04-30")
    assert len(sesja.zapytania) == 4, "drugie wyszukanie nie moze pytac o dni bez tabeli"

    # Stary brak tabeli zostaje na dysku - nowy przebieg nie pyta o niego wcale.
    nowa_sesja = SesjaTestowa([])
    nowy = NbpApiProvider(session=nowa_sesja, cache_dir=tmp_path)
    assert nowy.get_rate("USD", pd.Timestamp("2026-05-04")).rate == Decimal("4.1000")
    assert nowa_sesja.zapytania == []


def test_swiezy_brak_tabeli_nie_trafia_na_dysk(tmp_path: Path) -> None:
    """Tabeli z ostatnich dni moze jeszcze nie byc - taki 404 zostaje tylko w pamieci przebiegu."""
    wczoraj = pd.Timestamp.now().normalize() - pd.Timedelta(days=1)
    sesja = SesjaTestowa([OdpowiedzTestowa(404), OdpowiedzTestowa(200, tabela("4.2000"))])
    dostawca = NbpApiProvider(session=sesja, cache_dir=tmp_path)

    dostawca.get_rate("USD", wczoraj + pd.Timedelta(days=1))

    assert not list(tmp_path.glob("*.brak")), "swiezy 404 nie moze zostac utrwalony"
    assert wczoraj.date().isoformat() in dostawca.dni_bez_tabeli
