from __future__ import annotations

import sys
from pathlib import Path

import pytest


ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "src"

if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))


FIXTURE_ROOT = ROOT.parents[1] / "dane" / "pliki"


@pytest.fixture(autouse=True)
def bez_kopii_w_dane_out(monkeypatch):
    """Testy nie nadpisuja kopii wynikow aplikacji w dane/out.

    build_bundle bez storage_dir szuka magazynu od katalogu roboczego w gore, trafia na
    prawdziwe dane/pliki i kopiowal wyniki warstwy transakcji do dane/out przy kazdym
    przebiegu testow.
    """
    monkeypatch.setenv("INVEST_BEZ_KOPII_OUT", "1")


@pytest.fixture(autouse=True)
def bufor_kursow_poza_domem(tmp_path_factory, monkeypatch):
    """
    Kazdy przebieg testow dostaje wlasny katalog bufora kursow NBP.

    Dostawca kursow trzyma pobrane tabele na dysku, zeby kolejne uruchomienia
    silnika nie odpytywaly serwera NBP od nowa. Bez tej izolacji testy czytalyby
    i zapisywaly bufor uzytkownika: wynik zalezalby od tego, co ktos wczesniej
    policzyl na tej maszynie, a test o awarii sieci moglby w ogole nie dojsc do
    polaczenia.
    """
    monkeypatch.setenv("INVEST_NBP_CACHE", str(tmp_path_factory.mktemp("bufor-nbp")))
