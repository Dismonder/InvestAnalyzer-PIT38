from __future__ import annotations

import pandas as pd
from typing import Protocol
from investment_tax_engine.models.core import FxCoverageGap, FxLookupResult

class FxProvider(Protocol):
    provider_name: str

    # Czy dostawca potrafi rozstrzygnac o pokryciu calego zakresu dat.
    # Dostawca, ktory tego nie potrafi, zwraca z coverage_report pusta liste -
    # a pusta lista nie moze byc czytana jako "pokrywam wszystko", bo kasowalaby
    # luki zgloszone przez archiwum lokalne.
    reports_coverage: bool

    def get_rate(self, currency: str, tax_event_date: pd.Timestamp) -> FxLookupResult:
        ...

    def coverage_report(
        self,
        start_date: pd.Timestamp,
        end_date: pd.Timestamp,
        currencies: set[str],
    ) -> list[FxCoverageGap]:
        ...
