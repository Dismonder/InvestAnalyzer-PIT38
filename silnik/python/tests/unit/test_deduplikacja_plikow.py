"""Pliki o identycznej zawartosci nie moga liczyc sie dwa razy.

Ten sam wyciag wgrany pod dwiema nazwami podwajal przychod, koszt i podatek.
Uzytkownikowi latwo o taka pomylke: broker generuje ten sam raport, a nazwa
pliku bierze sie z daty pobrania.
"""

from __future__ import annotations

import json
from pathlib import Path

from investment_tax_engine.app.source_resolver import resolve_storage_sources


def zapisz(katalog: Path, nazwa: str, tresc: dict) -> None:
    (katalog / nazwa).write_text(json.dumps(tresc), encoding="utf-8")


WYCIAG = {
    "trades": [
        {
            "Symbol": "AAPL.US",
            "Side": "BUY",
            "Quantity": 10,
            "Cena": 150.0,
            "Kwota": 1500.0,
            "Currency": "USD",
            "date": "2024-02-05T15:30:00",
        }
    ],
    "cash_flows": [],
}


def test_kopia_pliku_jest_pomijana(tmp_path: Path) -> None:
    zapisz(tmp_path, "wyciag.json", WYCIAG)
    zapisz(tmp_path, "wyciag_kopia.json", WYCIAG)

    wynik = resolve_storage_sources(tmp_path)

    przyjete = [zrodlo.relative_path for zrodlo in wynik.sources]
    assert przyjete == ["wyciag.json"], f"przyjeto {przyjete}"


def test_pominiecie_jest_widoczne_w_ostrzezeniu(tmp_path: Path) -> None:
    """Plik nie moze znikac po cichu - uzytkownik ma wiedziec, ze byl duplikat."""
    zapisz(tmp_path, "wyciag.json", WYCIAG)
    zapisz(tmp_path, "wyciag_kopia.json", WYCIAG)

    wynik = resolve_storage_sources(tmp_path)
    ostrzezenia = " ".join(wynik.sources[0].warnings)
    assert "wyciag_kopia.json" in ostrzezenia
    assert "podwoiloby" in ostrzezenia


def test_rozne_pliki_zostaja_oba(tmp_path: Path) -> None:
    inny = {**WYCIAG, "trades": [{**WYCIAG["trades"][0], "Quantity": 20}]}
    zapisz(tmp_path, "wyciag.json", WYCIAG)
    zapisz(tmp_path, "wyciag_inny.json", inny)

    wynik = resolve_storage_sources(tmp_path)
    assert len(wynik.sources) == 2, "rozna zawartosc to dwa rozne zrodla"


def test_puste_pliki_o_tej_samej_tresci_zostaja(tmp_path: Path) -> None:
    """Dwa puste wyciagi nie maja czego podwoic, a ich znikniecie mylilo obraz
    magazynu - uzytkownik widzialby mniej plikow, niz wgral."""
    pusty = {"trades": [], "cash_flows": []}
    zapisz(tmp_path, "pusty_a.json", pusty)
    zapisz(tmp_path, "pusty_b.json", pusty)

    wynik = resolve_storage_sources(tmp_path)
    assert len(wynik.sources) == 2


def test_pominiety_duplikat_jest_wymieniony_w_audycie(tmp_path):
    """
    Pominiety duplikat musi byc widoczny z nazwy.

    Plik o identycznej zawartosci nie wchodzi do rozliczenia, bo policzenie obu
    podwoiloby przychod, koszt i podatek. Jego brak w mapie zrodel trzeba jednak
    umiec wyjasnic - inaczej wyglada jak plik, ktorego silnik nie rozpoznal.
    """
    tresc = json.dumps(
        {
            "trades": [
                {
                    "date": "2025-03-04",
                    "Symbol": "AAPL",
                    "Side": "BUY",
                    "Quantity": 10,
                    "Cena": 100,
                    "Kwota": 1000,
                    "Currency": "USD",
                    "Commission": 1,
                    "Commission Currency": "USD",
                    "account": "ACC",
                }
            ]
        }
    )
    (tmp_path / "wyciag.json").write_text(tresc, encoding="utf-8")
    (tmp_path / "wyciag-kopia.json").write_text(tresc, encoding="utf-8")

    wynik = resolve_storage_sources(tmp_path)

    assert len(wynik.duplicate_files) == 1
    wpis = wynik.duplicate_files[0]
    assert wpis["file"] in {"wyciag.json", "wyciag-kopia.json"}
    assert wpis["duplicate_of"] in {"wyciag.json", "wyciag-kopia.json"}
    assert wpis["file"] != wpis["duplicate_of"]

    audyt = wynik.to_audit_dict()
    assert audyt["summary"]["duplicateFileCount"] == 1
    assert audyt["duplicateFiles"] == wynik.duplicate_files
