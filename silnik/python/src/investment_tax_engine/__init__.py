"""Silnik podatkowy InvestAnalyzera.

Wersja jest pojedynczym zrodlem prawdy dla calego silnika: raportuje ja
kontrakt sidecara (pole engine_version w result.json), profil wykonania
(silnik_version) oraz slad audytowy w pakiecie dowodowym.
"""

from __future__ import annotations

# Musi odpowiadac wersji w pyproject.toml. Pod PyInstallerem i przy
# uruchomieniu przez PYTHONPATH metadane dystrybucji nie sa dostepne.
_FALLBACK_VERSION = "0.2.0"


def _resolve_version() -> str:
    try:
        from importlib.metadata import version

        return version("investment-tax-engine")
    except Exception:
        return _FALLBACK_VERSION


__version__ = _resolve_version()

__all__ = ["__version__"]
