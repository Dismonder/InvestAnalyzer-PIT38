"""Zestaw plikow wejsciowych dla testow silnika.

Prawdziwe wyciagi leza w `dane/pliki` i sa wylaczone z repozytorium, bo zawieraja
dane osobowe wlasciciela. Testy oparte wprost na nich konczyly sie na swiezym
klonie zielono, nie sprawdzajac niczego - `pytest.mark.skipif` albo `return` na
poczatku ciala wylaczaly szesnascie testow, w tym jedyny pelny przebieg PIT.

Ten modul wybiera zestaw: prywatny, gdy jest kompletny, a w przeciwnym razie
syntetyczny z `jakosc/dane-testowe` (buduje go
`narzedzia/skrypty/zbuduj_dane_testowe.py`). Dzieki temu te same testy
wykonuja sie zawsze - lokalnie na prawdziwych danych, na czystym klonie na
wymyslonych.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]
PRIVATE_ROOT = REPO_ROOT / "dane" / "pliki"
SYNTHETIC_ROOT = REPO_ROOT / "jakosc" / "dane-testowe"


@dataclass(frozen=True)
class ZestawWejsciowy:
    """Sciezki do plikow w rolach, jakich oczekuje silnik."""

    root: Path
    api_json: Path
    trades_v1: Path
    trades_legacy: Path
    tradernet_table: Path
    broker_json: Path
    depo_json: Path
    nbp_csv: tuple[Path, ...]
    tariff_pdf: Path
    prywatny: bool

    @property
    def opis(self) -> str:
        return "prawdziwe wyciagi uzytkownika" if self.prywatny else "zestaw syntetyczny"


def _private_set() -> ZestawWejsciowy | None:
    """Zestaw uzytkownika, o ile lezy komplet plikow."""
    depo_matches = sorted(PRIVATE_ROOT.glob("broker_*@*.json"))
    named = {
        "api_json": PRIVATE_ROOT / "pelny_zrzut_api_transakcje.json",
        "trades_v1": PRIVATE_ROOT / "Tradesv1.xlsx",
        "trades_legacy": PRIVATE_ROOT / "Trades (1).xlsx",
        "tradernet_table": PRIVATE_ROOT / "tradernet_tablev1.xlsx",
        "broker_json": PRIVATE_ROOT / "historia_transakcji.json",
        "tariff_pdf": PRIVATE_ROOT / "Stawki.pdf",
    }
    nbp = (PRIVATE_ROOT / "archiwum_tab_a_2025.csv", PRIVATE_ROOT / "archiwum_tab_a_2026.csv")
    if not depo_matches or not all(path.exists() for path in (*named.values(), *nbp)):
        return None
    return ZestawWejsciowy(root=PRIVATE_ROOT, depo_json=depo_matches[0], nbp_csv=nbp, prywatny=True, **named)


def _synthetic_set() -> ZestawWejsciowy | None:
    named = {
        "api_json": SYNTHETIC_ROOT / "api-zrzut.json",
        "trades_v1": SYNTHETIC_ROOT / "wyciag-v1.xlsx",
        "trades_legacy": SYNTHETIC_ROOT / "wyciag-stary.xlsx",
        "tradernet_table": SYNTHETIC_ROOT / "tabela-brokera.xlsx",
        "broker_json": SYNTHETIC_ROOT / "historia-brokera.json",
        "depo_json": SYNTHETIC_ROOT / "kontrola-pozycji.json",
        "tariff_pdf": SYNTHETIC_ROOT / "Stawki-przykladowe.pdf",
    }
    nbp = (SYNTHETIC_ROOT / "archiwum_tab_a_2025.csv", SYNTHETIC_ROOT / "archiwum_tab_a_2026.csv")
    if not all(path.exists() for path in (*named.values(), *nbp)):
        return None
    return ZestawWejsciowy(root=SYNTHETIC_ROOT, nbp_csv=nbp, prywatny=False, **named)


def zestaw_wejsciowy() -> ZestawWejsciowy:
    """Zestaw do uzycia w testach. Brak obu konczy sie bledem, nie pominieciem.

    Milczace pominiecie bylo dokladnie tym, co ukrywalo brak pokrycia - jesli
    znika takze zestaw syntetyczny, testy maja o tym powiedziec.

    `INVEST_TEST_FIXTURES=syntetyczny` wymusza zestaw syntetyczny, zeby dalo sie
    sprawdzic zachowanie swiezego klonu bez kasowania wlasnych plikow.
    """
    wymuszony = os.environ.get("INVEST_TEST_FIXTURES", "").strip().lower()
    if wymuszony in {"syntetyczny", "synthetic"}:
        chosen = _synthetic_set()
        if chosen is None:
            raise RuntimeError(
                "Wymuszono zestaw syntetyczny, ale go nie ma. Zbuduj go poleceniem: "
                "python narzedzia/skrypty/zbuduj_dane_testowe.py"
            )
        return chosen

    chosen = _private_set() or _synthetic_set()
    if chosen is None:
        raise RuntimeError(
            "Brak zestawu wejsciowego do testow. Zbuduj syntetyczny poleceniem: "
            "python narzedzia/skrypty/zbuduj_dane_testowe.py"
        )
    return chosen


ZESTAW = zestaw_wejsciowy()
