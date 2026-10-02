# Schematy PIT-38(18)

Pobrane 2026-09-13 z Centralnego Repozytorium Wzorów. Adresy oryginalne:

| plik | adres |
| --- | --- |
| `schemat.xsd` | http://crd.gov.pl/wzor/2025/10/09/13914/schemat.xsd |
| `PIT_ZG8_Z38_v1-0E.xsd` | http://crd.gov.pl/xml/schematy/dziedzinowe/mf/2023/10/18/eD/PITZGZ38/PIT_ZG(8)_Z38_v1-0E.xsd |
| `StrukturyDanych_v12-0E.xsd` | http://crd.gov.pl/xml/schematy/dziedzinowe/mf/2022/09/13/eD/DefinicjeTypy/StrukturyDanych_v12-0E.xsd |
| `KodyUrzedowSkarbowychExWUS_v8-0E.xsd` | http://crd.gov.pl/xml/schematy/dziedzinowe/mf/2021/12/23/eD/KodyUrzedowSkarbowychExWUS/KodyUrzedowSkarbowychExWUS_v8-0E.xsd |
| `KodyKrajow_v13-0E.xsd` | http://crd.gov.pl/xml/schematy/dziedzinowe/mf/2023/09/06/eD/KodyKrajow/KodyKrajow_v13-0E.xsd |

Pliki są tu po to, żeby test `jakosc/testy/frontend/schematPit38.test.ts`
sprawdzał wygenerowaną deklarację wobec prawdziwego schematu, a nie wobec
oczekiwań przepisanych do testu. Wcześniej eksport miał zmyśloną przestrzeń
nazw, brakujące elementy wymagane i wymyślone nazwy pozycji załącznika PIT/ZG
— i żaden test tego nie łapał.

`schemaLocation` w plikach wskazuje na oryginalne adresy; test czyta je
po nazwie pliku, więc nie sięga do sieci.

## Kiedy odświeżyć

Gdy Ministerstwo Finansów opublikuje nowszy wzór PIT-38. Listę wzorów widać
w lustrze repozytorium: <https://crd.e-instytucja.pl/index.php?r=wzor/index>
(szukaj „PIT-38"); na `podatki.gov.pl` spis struktur XML kończy się na
wariancie 14 z 2019 r.

Pobranie pliku wystarczy — numer wariantu i wersję schematu test odczytuje
z atrybutów `kodSystemowy` i `wersjaSchemy`, więc rozjazd z tablicą wzorów
w `xmlExporter.ts` sam się ujawni.
