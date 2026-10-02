from __future__ import annotations

import bisect
import csv
import json
import os
import re
import time
from datetime import date, timedelta
from decimal import Decimal, InvalidOperation
from functools import lru_cache
from pathlib import Path
from typing import Iterable

import pandas as pd
import requests

from ..interfaces.fx import FxProvider
from ..models.core import EngineConfig, FxCoverageGap, FxLookupResult


D = Decimal


# Najdluzsza przerwa w publikacji tabeli A to weekend ze swietami. W archiwum
# uzytkownika najwieksza wynosi 6 dni (23 -> 29 grudnia 2025), wiec dziesiec dni
# zostawia zapas na kazdy uklad swiat, a jednoczesnie nie przepusci dziury
# liczonej w tygodniach czy miesiacach.
MAX_RATE_STALENESS_DAYS = 10


def _wielkanoc(rok: int) -> date:
    """Niedziela Wielkanocna w kalendarzu gregorianskim (algorytm Meeusa/Jonesa/Butchera)."""
    a = rok % 19
    b, c = divmod(rok, 100)
    d, e = divmod(b, 4)
    f = (b + 8) // 25
    g = (b - f + 1) // 3
    h = (19 * a + b - d - g + 15) % 30
    i, k = divmod(c, 4)
    l = (32 + 2 * e + 2 * i - h - k) % 7
    m = (a + 11 * h + 22 * l) // 451
    miesiac, dzien = divmod(h + l - 7 * m + 114, 31)
    return date(rok, miesiac, dzien + 1)


@lru_cache(maxsize=None)
def swieta_ustawowe(rok: int) -> frozenset[date]:
    """Dni ustawowo wolne od pracy (ustawa z 18 stycznia 1951 r. o dniach wolnych od pracy)."""
    wielkanoc = _wielkanoc(rok)
    dni = {
        date(rok, 1, 1),
        date(rok, 5, 1),
        date(rok, 5, 3),
        date(rok, 8, 15),
        date(rok, 11, 1),
        date(rok, 11, 11),
        date(rok, 12, 25),
        date(rok, 12, 26),
        wielkanoc,
        wielkanoc + timedelta(days=1),
        wielkanoc + timedelta(days=49),  # Zielone Swiatki
        wielkanoc + timedelta(days=60),  # Boze Cialo
    }
    if rok >= 2011:
        dni.add(date(rok, 1, 6))
    if rok >= 2025:
        dni.add(date(rok, 12, 24))
    if rok == 2018:
        dni.add(date(2018, 11, 12))
    return frozenset(dni)


def dzien_publikacji_nbp(dzien: date) -> bool:
    """Czy NBP publikuje tego dnia tabele A: dzien roboczy, czyli nie weekend i nie swieto."""
    return dzien.weekday() < 5 and dzien not in swieta_ustawowe(dzien.year)


class LocalCsvNbpProvider(FxProvider):
    provider_name = "NBP_CSV"
    # Zna komplet dat publikacji, wiec moze rozstrzygnac o pokryciu zakresu.
    reports_coverage = True

    def __init__(self, csv_paths: Iterable[Path]) -> None:
        self.df: pd.DataFrame | None = None
        self.available_dates: list[pd.Timestamp] = []
        # Indeksy zamiast przeszukiwania: wczesniej kazde wyszukanie liczylo max()
        # i przegladalo cale archiwum dat oraz cala ramke kursow.
        self._wiersz_daty: dict[pd.Timestamp, int] = {}
        self._kolumny_walut: dict[str, tuple[str, int]] = {}
        self._load_many(csv_paths)

    def _load_many(self, csv_paths: Iterable[Path]) -> None:
        frames: list[pd.DataFrame] = []
        for path in csv_paths:
            if path.exists():
                frames.append(self._load_single(path))
        if not frames:
            return
        frame = pd.concat(frames, ignore_index=True).drop_duplicates(subset=["data"]).sort_values("data")
        self.df = frame.reset_index(drop=True)
        self.available_dates = list(self.df["data"])
        self._wiersz_daty = {data: indeks for indeks, data in enumerate(self.available_dates)}

    def _load_single(self, path: Path) -> pd.DataFrame:
        with open(path, "r", encoding="cp1250", errors="replace", newline="") as handle:
            rows = list(csv.reader(handle, delimiter=";"))

        # Tabela A konczy kazdy wiersz srednikiem, wiec csv.reader zwraca na
        # koncu puste pole. Bezwarunkowe `[:-1]` gubilo jednak ostatnia walute
        # w archiwum zapisanym bez tego srednika (np. po edycji w arkuszu) -
        # kurs znikal cicho, jako "currency column missing from CSV archive".
        header = rows[0][:-1] if rows[0] and rows[0][-1].strip() == "" else rows[0]
        width = len(header)
        body: list[list[str]] = []
        for row in rows[2:]:
            if row and str(row[0]).strip().isdigit() and len(str(row[0]).strip()) == 8:
                body.append(row[:width])

        df = pd.DataFrame(body, columns=header)
        if "data" not in df.columns and "dane" in df.columns:
            df = df.rename(columns={"dane": "data"})
        df["data"] = pd.to_datetime(df["data"], format="%Y%m%d")
        for column in df.columns:
            if column in {"data", "nr tabeli", "pełny numer tabeli"}:
                continue
            df[column] = pd.to_numeric(df[column].astype(str).str.replace(",", ".", regex=False), errors="coerce")
        return df

    def _find_column(self, currency: str) -> tuple[str, int]:
        if self.df is None:
            raise KeyError("CSV archive is empty")
        normalized = currency.upper().strip()
        if normalized == "PLN":
            return "PLN", 1
        if normalized in self._kolumny_walut:
            return self._kolumny_walut[normalized]
        for column in self.df.columns:
            for mnoznik in (1, 100, 10000):
                if column == f"{mnoznik}{normalized}":
                    self._kolumny_walut[normalized] = (column, mnoznik)
                    return column, mnoznik
        raise KeyError(f"Currency column not available in CSV archive: {currency}")

    def previous_available_date(self, tax_event_date: pd.Timestamp) -> pd.Timestamp:
        if not self.available_dates:
            raise KeyError("CSV archive has no dates")
        target = pd.Timestamp(tax_event_date).normalize() - pd.Timedelta(days=1)
        archive_end = self.available_dates[-1]
        if target > archive_end:
            raise KeyError(
                f"CSV archive ends on {archive_end.date()} before required NBP lookup target "
                f"{target.date()}"
            )
        pozycja = bisect.bisect_right(self.available_dates, target)
        if pozycja == 0:
            raise KeyError(f"No CSV rate available before {tax_event_date.date()}")

        found = self.available_dates[pozycja - 1]
        staleness = (target - found).days
        if staleness > MAX_RATE_STALENESS_DAYS:
            # Cofanie sie do ostatniego dnia publikacji ma obsluzyc weekend i
            # swieta. Bez gornej granicy obsluguje tez dziure w srodku archiwum:
            # przy archiwum zlozonym z rocznikow 2024 i 2026 transakcja z lipca
            # 2025 dostawala kurs z 31 grudnia 2024, sprzed 196 dni, i nic tego
            # nie zglaszalo. Odmowa przekazuje zapytanie dalej - do API NBP albo
            # do bramki, ktora zatrzyma rozliczenie.
            raise KeyError(
                f"CSV archive has no rate within {MAX_RATE_STALENESS_DAYS} days before "
                f"{tax_event_date.date()}; nearest is {found.date()} ({staleness} days earlier). "
                "Archiwum kursow jest niekompletne w tym okresie."
            )
        # Granica swiezosci nie odroznia weekendu od brakujacego wiersza: archiwum
        # bez tabeli z roboczego poniedzialku dawalo wtorkowej sprzedazy kurs
        # piatkowy, a art. 11a wymaga kursu z ostatniego dnia roboczego przed
        # przychodem. Odmowa przekazuje zapytanie do API NBP albo do bramki.
        pominiety = self._pominiety_dzien_publikacji(pozycja - 1, target)
        if pominiety is not None:
            raise KeyError(
                f"Archiwum kursow NBP nie ma tabeli z dnia roboczego {pominiety.date()} "
                f"(ostatnia wczesniejsza: {found.date()}), a jest ona potrzebna dla zdarzenia z "
                f"{pd.Timestamp(tax_event_date).date()}. Uzupelnij archiwum albo wlacz pobieranie kursow z API NBP."
            )
        return found

    def _numer_tabeli(self, indeks: int) -> int | None:
        """Numer tabeli w roku z kolumny `nr tabeli` ("67" albo "067/A/NBP/2025")."""
        if self.df is None or "nr tabeli" not in self.df.columns:
            return None
        dopasowanie = re.match(r"\s*(\d+)", str(self.df.at[indeks, "nr tabeli"]))
        return int(dopasowanie.group(1)) if dopasowanie else None

    def _pominiety_dzien_publikacji(self, indeks: int, target: pd.Timestamp) -> pd.Timestamp | None:
        """Pierwszy dzien roboczy po tabeli z archiwum i nie pozniej niz `target`.

        Taki dzien oznacza brakujacy wiersz archiwum - chyba ze numeracja tabel
        to wyklucza. Numery tabel sa w roku kolejne, wiec nastepny wiersz z
        numerem wiekszym o jeden dowodzi, ze NBP nic w tym czasie nie opublikowal
        (dzien wolny spoza kalendarza ustawowego), i kurs z archiwum jest wlasciwy.
        """
        znaleziony = self.available_dates[indeks]
        dzien = znaleziony + pd.Timedelta(days=1)
        while dzien <= target:
            if dzien_publikacji_nbp(dzien.date()):
                break
            dzien += pd.Timedelta(days=1)
        else:
            return None
        nastepny = indeks + 1
        if nastepny < len(self.available_dates) and self.available_dates[nastepny].year == znaleziony.year:
            numer = self._numer_tabeli(indeks)
            numer_nastepnej = self._numer_tabeli(nastepny)
            if numer is not None and numer_nastepnej == numer + 1:
                return None
        return dzien

    def get_rate(self, currency: str, tax_event_date: pd.Timestamp) -> FxLookupResult:
        normalized = currency.upper().strip()
        tax_event_date = pd.Timestamp(tax_event_date).normalize()
        if normalized == "PLN":
            return FxLookupResult(
                currency="PLN",
                tax_event_date=tax_event_date,
                fx_date=tax_event_date,
                rate=D("1"),
                source=self.provider_name,
            )
        if self.df is None:
            raise KeyError("CSV archive is empty")

        fx_date = self.previous_available_date(tax_event_date)
        column, multiplier = self._find_column(normalized)
        indeks = self._wiersz_daty.get(fx_date)
        if indeks is None:
            raise KeyError(f"CSV row missing for {fx_date.date()}")
        value = self.df.at[indeks, column]
        if pd.isna(value):
            raise KeyError(f"CSV rate missing for {normalized} on {fx_date.date()}")
        rate = D(str(value)) / D(str(multiplier))
        return FxLookupResult(
            currency=normalized,
            tax_event_date=tax_event_date,
            fx_date=fx_date,
            rate=rate,
            source=self.provider_name,
        )

    def coverage_report(
        self,
        start_date: pd.Timestamp,
        end_date: pd.Timestamp,
        currencies: set[str],
    ) -> list[FxCoverageGap]:
        gaps: list[FxCoverageGap] = []
        start = pd.Timestamp(start_date).normalize()
        end = pd.Timestamp(end_date).normalize()
        if self.df is None or self.df.empty:
            for currency in sorted(currencies):
                if currency.upper() == "PLN":
                    continue
                gaps.append(
                    FxCoverageGap(
                        currency=currency.upper(),
                        start_date=start,
                        end_date=end,
                        provider_name=self.provider_name,
                        reason="Archiwum CSV jest puste",
                    )
                )
            return gaps

        archive_start = min(self.available_dates)
        archive_end = max(self.available_dates)
        for currency in sorted(currencies):
            normalized = currency.upper()
            if normalized == "PLN":
                continue
            try:
                self._find_column(normalized)
            except KeyError:
                gaps.append(
                    FxCoverageGap(
                        currency=normalized,
                        start_date=start,
                        end_date=end,
                        provider_name=self.provider_name,
                        reason="W archiwum CSV brakuje kolumny z walutą",
                    )
                )
                continue
            if start < archive_start or end > archive_end:
                gaps.append(
                    FxCoverageGap(
                        currency=normalized,
                        start_date=start,
                        end_date=end,
                        provider_name=self.provider_name,
                        reason="Zakres dat wykracza poza dane w archiwum CSV",
                    )
                )
        return gaps


def domyslny_katalog_bufora() -> Path | None:
    """
    Katalog trwalego bufora tabel NBP.

    Zmienna `INVEST_NBP_CACHE` pozwala wskazac wlasne miejsce; bez niej bufor
    ladzie w katalogu podrecznym uzytkownika. Gdy nic nie da sie ustalic, bufor
    na dysku jest wylaczony i zostaje sam bufor w pamieci przebiegu.
    """
    wskazany = os.environ.get("INVEST_NBP_CACHE")
    if wskazany:
        return Path(wskazany)
    podreczny = os.environ.get("XDG_CACHE_HOME")
    if podreczny:
        return Path(podreczny) / "investanalyzer" / "nbp"
    dom = os.environ.get("HOME") or os.environ.get("USERPROFILE")
    if dom:
        return Path(dom) / ".cache" / "investanalyzer" / "nbp"
    return None


class NbpApiProvider(FxProvider):
    provider_name = "NBP_API"
    # Nie odpytuje calego zakresu z gory, wiec nie rozstrzyga o pokryciu.
    reports_coverage = False
    base_url = "https://api.nbp.pl/api/exchangerates/tables/A"

    def __init__(
        self,
        timeout_seconds: float = 15.0,
        session: requests.Session | None = None,
        *,
        use_cache: bool = True,
        retry_count: int = 4,
        retry_backoff_seconds: float = 0.5,
        cache_dir: Path | None = None,
    ) -> None:
        self.timeout_seconds = timeout_seconds
        self.session = session or requests.Session()
        self.use_cache = use_cache
        self.retry_count = max(0, retry_count)
        self.retry_backoff_seconds = max(0.0, retry_backoff_seconds)
        self.table_cache: dict[str, dict[str, Decimal]] = {}
        # Dni bez tabeli (weekend, swieto - NBP odpowiada 404). Bez tej pamieci
        # kazde cofanie sie przez weekend pytalo o sobote i niedziele od nowa:
        # ok. 360 zapytan i 9 s na kazdy przebieg prawdziwego rachunku.
        self.dni_bez_tabeli: set[str] = set()
        self.cache_dir = cache_dir if cache_dir is not None else domyslny_katalog_bufora()

    def _sciezka_bufora(self, key: str) -> Path | None:
        """Plik bufora dla tabeli z danego dnia."""
        if not self.use_cache or self.cache_dir is None:
            return None
        return self.cache_dir / f"tabela-A-{key}.json"

    def _z_bufora_na_dysku(self, key: str) -> dict[str, Decimal] | None:
        sciezka = self._sciezka_bufora(key)
        if sciezka is None or not sciezka.is_file():
            return None
        try:
            surowe = json.loads(sciezka.read_text(encoding="utf-8"))
            return {str(kod).upper(): D(str(wartosc)) for kod, wartosc in surowe.items()}
        except (OSError, ValueError, InvalidOperation):
            # Uszkodzony plik bufora ma byc pominiety, a nie przerwac rozliczenie.
            return None

    def _do_bufora_na_dysku(self, key: str, rates: dict[str, Decimal]) -> None:
        sciezka = self._sciezka_bufora(key)
        if sciezka is None:
            return
        try:
            sciezka.parent.mkdir(parents=True, exist_ok=True)
            # Nazwa pliku tymczasowego musi byc unikalna dla procesu. Przy stalej
            # nazwie dwa przebiegi silnika liczace ten sam dzien pisza do tego
            # samego pliku i os.replace moze przeniesc tresc sklejona z obu.
            tymczasowy = sciezka.with_suffix(f".json.{os.getpid()}.tmp")
            tymczasowy.write_text(
                json.dumps({kod: str(wartosc) for kod, wartosc in rates.items()}, ensure_ascii=False),
                encoding="utf-8",
            )
            os.replace(tymczasowy, sciezka)
        except OSError:
            # Brak miejsca albo prawa tylko do odczytu nie moga zatrzymac rozliczenia.
            pass

    def _sciezka_braku(self, key: str) -> Path | None:
        """Znacznik dnia, dla ktorego NBP nie opublikowal tabeli."""
        sciezka = self._sciezka_bufora(key)
        return sciezka.with_suffix(".brak") if sciezka is not None else None

    def _zapamietaj_brak_tabeli(self, key: str, day: pd.Timestamp) -> None:
        if not self.use_cache:
            return
        self.dni_bez_tabeli.add(key)
        # Na dysk trafia tylko brak sprzed tygodnia: tabele z ostatnich dni moze
        # jeszcze nie byc (publikacja ok. poludnia), a stary dzien bez tabeli
        # to dzien wolny, ktory juz sie nie zmieni.
        if pd.Timestamp(day).normalize() >= pd.Timestamp.now().normalize() - pd.Timedelta(days=7):
            return
        sciezka = self._sciezka_braku(key)
        if sciezka is None:
            return
        try:
            sciezka.parent.mkdir(parents=True, exist_ok=True)
            tymczasowy = sciezka.with_suffix(f".brak.{os.getpid()}.tmp")
            tymczasowy.write_text("404", encoding="utf-8")
            os.replace(tymczasowy, sciezka)
        except OSError:
            pass

    def _czas_przerwy(self, response: requests.Response | None, attempt: int) -> float:
        """
        Ile czekac przed kolejna proba.

        Przy odpowiedzi 429 NBP prosi o zwolnienie tempa. Poprzednia przerwa
        (0,25 s i 0,5 s) byla na to za krotka, wiec obie proby trafialy w ten sam
        limit i caly przebieg konczyl sie wyjatkiem KeyError z tracebackiem
        zamiast wynikiem. Teraz przerwa rosnie wykladniczo, a gdy serwer poda
        naglowek `Retry-After`, czekamy dokladnie tyle, ile prosi.
        """
        if response is not None and response.status_code == 429:
            naglowek = response.headers.get("Retry-After")
            if naglowek:
                try:
                    return min(30.0, max(1.0, float(naglowek)))
                except ValueError:
                    pass
            return min(30.0, 2.0 * (2 ** attempt))
        return self.retry_backoff_seconds * (attempt + 1)

    def _fetch_table_for_day(self, day: pd.Timestamp) -> dict[str, Decimal]:
        key = pd.Timestamp(day).normalize().date().isoformat()
        if self.use_cache and key in self.table_cache:
            return self.table_cache[key]
        if self.use_cache and key in self.dni_bez_tabeli:
            raise KeyError(f"NBP API table missing for {key}")
        znacznik_braku = self._sciezka_braku(key)
        if znacznik_braku is not None and znacznik_braku.is_file():
            self.dni_bez_tabeli.add(key)
            raise KeyError(f"NBP API table missing for {key}")

        # Kurs z przeszlosci juz sie nie zmieni, wiec bufor na dysku przezywa
        # kolejne przebiegi. Bez niego kazde uruchomienie pobieralo tabele dla
        # kazdej daty od nowa - przy rozliczeniu z setka dni handlowych to setka
        # zapytan na przebieg i szybkie wejscie w limit serwera NBP.
        z_dysku = self._z_bufora_na_dysku(key)
        if z_dysku is not None:
            if self.use_cache:
                self.table_cache[key] = z_dysku
            return z_dysku

        payload = None
        attempts = self.retry_count + 1
        for attempt in range(attempts):
            response = None
            try:
                response = self.session.get(f"{self.base_url}/{key}/?format=json", timeout=self.timeout_seconds)
                if response.status_code == 404:
                    self._zapamietaj_brak_tabeli(key, day)
                    raise KeyError(f"NBP API table missing for {key}")
                response.raise_for_status()
                payload = response.json()
                break
            except KeyError:
                raise
            except (requests.RequestException, ValueError) as exc:
                if attempt >= attempts - 1:
                    raise KeyError(f"NBP API request failed for {key}: {exc}") from exc
                przerwa = self._czas_przerwy(response, attempt)
                if przerwa > 0:
                    time.sleep(przerwa)
        if not payload:
            raise KeyError(f"NBP API empty response for {key}")

        rates: dict[str, Decimal] = {}
        for row in payload[0].get("rates", []):
            code = str(row["code"]).upper()
            try:
                kurs = D(str(row["mid"]))
            except InvalidOperation as exc:
                raise ValueError(f"Invalid NBP API rate for {code} on {key}") from exc
            # Kurs zero albo ujemny nie istnieje. Przyjety w ciemno przelicza
            # kazda kwote w tej walucie na 0,00 PLN i - co gorsza - zostaje
            # w buforze na dysku jako "pobrany kurs".
            if kurs <= 0:
                raise ValueError(f"Invalid NBP API rate for {code} on {key}: {kurs}")
            rates[code] = kurs
        # Pusta tabela to nie jest odpowiedz, ktora wolno utrwalic. Zapisana raz
        # zostawala na dysku na zawsze: kazde pozniejsze pytanie o ten dzien
        # konczylo sie brakiem waluty i silnik nie probowal juz pobrac tabeli.
        if not rates:
            # Swiadomie ValueError, a nie KeyError: KeyError znaczy w tej klasie
            # "tego dnia nie ma tabeli" i uruchamia cofanie sie o dzien wstecz.
            # Pusta tabela w dniu roboczym to awaria po stronie serwisu, a nie
            # dzien wolny - cofniecie sie dalo by kurs z niewlasciwej daty.
            raise ValueError(f"NBP API returned no rates for {key}")
        if self.use_cache:
            self.table_cache[key] = rates
            self._do_bufora_na_dysku(key, rates)
        return rates

    def get_rate(self, currency: str, tax_event_date: pd.Timestamp) -> FxLookupResult:
        normalized = currency.upper().strip()
        tax_event_date = pd.Timestamp(tax_event_date).normalize()
        if normalized == "PLN":
            return FxLookupResult(
                currency="PLN",
                tax_event_date=tax_event_date,
                fx_date=tax_event_date,
                rate=D("1"),
                source=self.provider_name,
            )

        target = tax_event_date - pd.Timedelta(days=1)
        for _ in range(15):
            try:
                rates = self._fetch_table_for_day(target)
                if normalized not in rates:
                    raise KeyError(f"NBP API table A does not include {normalized} on {target.date()}")
                return FxLookupResult(
                    currency=normalized,
                    tax_event_date=tax_event_date,
                    fx_date=target,
                    rate=rates[normalized],
                    source=self.provider_name,
                )
            except KeyError as exc:
                message = str(exc)
                if "NBP API request failed" in message or "NBP API empty response" in message:
                    raise
                target = target - pd.Timedelta(days=1)
        raise KeyError(f"NBP API rate missing for {normalized} before {tax_event_date.date()}")

    def coverage_report(
        self,
        start_date: pd.Timestamp,
        end_date: pd.Timestamp,
        currencies: set[str],
    ) -> list[FxCoverageGap]:
        return []


class ManualOverrideProvider(FxProvider):
    provider_name = "MANUAL_OVERRIDE"
    # Zna tylko kursy podane recznie, wiec nie rozstrzyga o pokryciu zakresu.
    reports_coverage = False

    def __init__(self, overrides: dict[str, Decimal]) -> None:
        self.overrides = overrides

    def _lookup(self, currency: str, tax_event_date: pd.Timestamp) -> Decimal | None:
        """Korekta obowiazuje wylacznie w dniu, dla ktorego zostala podana.

        Klucz bez daty (samo "USD") podmienial kurs we wszystkich dniach naraz.
        Art. 11a ust. 2 ustawy o PIT wiaze kurs z konkretnym dniem zdarzenia,
        wiec jedna liczba nie moze opisywac calego roku - taki zapis jest bledem
        wejscia, a nie skrotem.
        """
        normalized = currency.upper().strip()
        day = pd.Timestamp(tax_event_date).normalize().date().isoformat()
        for key in (f"{normalized}::{day}", f"{normalized}:{day}"):
            if key in self.overrides:
                return self.overrides[key]
        return None

    def undated_keys(self) -> list[str]:
        """Klucze bez daty - do zgloszenia uzytkownikowi jako blad wejscia."""
        return sorted(key for key in self.overrides if ":" not in str(key))

    def get_rate(self, currency: str, tax_event_date: pd.Timestamp) -> FxLookupResult:
        normalized = currency.upper().strip()
        tax_event_date = pd.Timestamp(tax_event_date).normalize()
        if normalized == "PLN":
            return FxLookupResult(
                currency="PLN",
                tax_event_date=tax_event_date,
                fx_date=tax_event_date,
                rate=D("1"),
                source=self.provider_name,
            )
        value = self._lookup(normalized, tax_event_date)
        if value is None:
            raise KeyError(f"Manual override missing for {normalized} on {tax_event_date.date()}")
        # Data kursu to dzien, dla ktorego uzytkownik podal korekte. Wpisywanie
        # tu D-1 upodabnialo reczna korekte do zwyklego odczytu z tabeli NBP.
        return FxLookupResult(
            currency=normalized,
            tax_event_date=tax_event_date,
            fx_date=tax_event_date,
            rate=value,
            source=self.provider_name,
        )

    def coverage_report(
        self,
        start_date: pd.Timestamp,
        end_date: pd.Timestamp,
        currencies: set[str],
    ) -> list[FxCoverageGap]:
        return []


class CompositeFxProvider(FxProvider):
    provider_name = "COMPOSITE_FX"

    def __init__(self, providers: list[FxProvider], coverage_provider: FxProvider | None = None) -> None:
        self.providers = providers
        self.coverage_provider = coverage_provider or (providers[0] if providers else None)

    def get_rate(self, currency: str, tax_event_date: pd.Timestamp) -> FxLookupResult:
        last_error: Exception | None = None
        for provider in self.providers:
            try:
                return provider.get_rate(currency, tax_event_date)
            except Exception as exc:  # pragma: no cover
                last_error = exc
        if last_error is None:
            raise KeyError(f"No FX providers configured for {currency}::{tax_event_date}")
        # str(KeyError) oddaje tekst w apostrofach - do komunikatu dla uzytkownika
        # idzie sama tresc bledu.
        if isinstance(last_error, KeyError) and last_error.args and isinstance(last_error.args[0], str):
            raise KeyError(last_error.args[0])
        raise KeyError(str(last_error))

    def coverage_report(
        self,
        start_date: pd.Timestamp,
        end_date: pd.Timestamp,
        currencies: set[str],
    ) -> list[FxCoverageGap]:
        if not self.providers:
            return []

        first_provider_gaps = self.coverage_provider.coverage_report(start_date, end_date, currencies) if self.coverage_provider else []
        if not first_provider_gaps:
            return []

        # A gap reported by the preferred local archive is actionable only if no later
        # provider in the chain can cover that same currency. This keeps CSV coverage
        # warnings meaningful while allowing the NBP API fallback to handle fresh dates.
        #
        # Dostawca, ktory nie potrafi zbadac pokrycia, zwraca pusta liste - a pusta
        # lista wygladala tu jak "pokrywam wszystko" i kasowala komplet luk
        # zgloszonych przez archiwum lokalne. Przy domyslnie wlaczonym fallbacku
        # na API bramka kursowa nie mogla przez to zadzialac ani razu. Pomijamy
        # wiec dostawcow, ktorzy pokrycia nie raportuja.
        remaining: dict[str, FxCoverageGap] = {
            gap.currency.upper(): gap for gap in first_provider_gaps
        }
        for provider in self.providers:
            if provider is self.coverage_provider or not getattr(provider, "reports_coverage", False):
                continue
            provider_gaps = {
                gap.currency.upper()
                for gap in provider.coverage_report(start_date, end_date, set(remaining))
            }
            for currency in list(remaining):
                if currency not in provider_gaps:
                    remaining.pop(currency, None)
            if not remaining:
                return []

        return [remaining[currency] for currency in sorted(remaining)]


def build_fx_provider(config: EngineConfig, csv_paths: list[Path] | None) -> FxProvider:
    csv_provider = LocalCsvNbpProvider(csv_paths or [])
    api_enabled = config.nbp_allow_api_fallback and config.use_nbp_api_fallback
    api_provider = NbpApiProvider(use_cache=config.cache_nbp_api_responses) if api_enabled else None
    providers: list[FxProvider] = []
    if config.prefer_local_nbp_archive:
        providers.append(csv_provider)
        if api_provider is not None:
            providers.append(api_provider)
    else:
        if api_provider is not None:
            providers.append(api_provider)
        providers.append(csv_provider)
    # Korekta reczna stoi na poczatku lancucha. Dopisana na koncu odzywalaby sie
    # dopiero, gdy zawioda archiwum i API - czyli nigdy nie mogla niczego
    # skorygowac. Kanal jest domyslnie wylaczony (nbp_allow_manual_override),
    # a kazdy uzyty kurs zapisuje sie w audycie z dostawca MANUAL_OVERRIDE.
    if config.nbp_allow_manual_override and config.user_overrides.manual_fx_overrides:
        providers.insert(0, ManualOverrideProvider(config.user_overrides.manual_fx_overrides))
    return CompositeFxProvider(providers, coverage_provider=csv_provider)
