"""Kolejnosc powodow w raporcie niekompletnych rekordow nie zalezy od ziarna haszowania.

Petla iterowala po set(): ten sam wynik dawal miedzy przebiegami rozna kolejnosc
kluczy w "reasons" (tresc bez zmian, ale pliki wynikowe nie byly identyczne
bajt w bajt, co utrudnia porownania przy audytach).
"""

import json
import os
import subprocess
import sys

import investment_tax_engine
from investment_tax_engine.storage.transaction_intelligence import build_canonical_tax_input_summary


def _podsumowanie() -> dict:
    rekord = {
        "canonical_record_status": "incomplete",
        "source": {"filename": "wyciag.csv"},
        "validation_errors": ["missing_instrument", "missing_currency", "missing_instrument"],
    }
    return build_canonical_tax_input_summary({"records": [rekord, dict(rekord)]})


def test_powody_w_kolejnosci_pierwszego_wystapienia():
    grupa = _podsumowanie()["incompleteRecordsBySource"][0]
    assert list(grupa["reasons"]) == ["missing_instrument", "missing_currency"]
    assert grupa["reasons"] == {"missing_instrument": 2, "missing_currency": 2}


def test_kolejnosc_taka_sama_przy_roznych_ziarnach_haszowania():
    kod = (
        "import json;"
        "from investment_tax_engine.storage.transaction_intelligence import build_canonical_tax_input_summary as b;"
        "r={'canonical_record_status':'incomplete','source':{'filename':'w.csv'},"
        "'validation_errors':['missing_currency','missing_instrument','missing_date','unknown_operation']};"
        "print(json.dumps(list(b({'records':[r]})['incompleteRecordsBySource'][0]['reasons'])))"
    )
    wyniki = set()
    for ziarno in ("1", "2", "3", "4", "5"):
        # Podproces musi znalezc pakiet jak biezacy test, niezaleznie od tego,
        # czy runner ustawia PYTHONPATH (npm run test:python go nie ustawia).
        src = os.path.dirname(os.path.dirname(investment_tax_engine.__file__))
        sciezka = os.pathsep.join(filter(None, [src, os.environ.get("PYTHONPATH")]))
        env = {**os.environ, "PYTHONHASHSEED": ziarno, "PYTHONPATH": sciezka}
        wynik = subprocess.run([sys.executable, "-c", kod], capture_output=True, text=True, env=env, check=True)
        wyniki.add(wynik.stdout.strip())
    assert len(wyniki) == 1, wyniki
    assert json.loads(wyniki.pop()) == ["missing_currency", "missing_instrument", "missing_date", "unknown_operation"]
