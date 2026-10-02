# A13 — przypadki PIT-38(18), stan po F26

Wszystkie kwoty i kursy w testach są syntetyczne. W silniku Python nie ma osobnego parsera Freedom24; parsery JSON, arkuszy i raportu brokera zachowują pole operacji, nie mapując splitu na kupno/sprzedaż. Zestaw syntetyczny używa `buy`/`sell`; testy normalizatora obejmują też `1`/`2`, `b`/`s`, `purchase`, `kupno` i `sprzedaż`.

| Przypadek | Ręczne wyliczenie | Wynik F26 |
|---|---|---|
| BTC za 2000 USDT | przychód 0 zł, podatek 0 zł | Część E = 0; pełny przebieg bez kursu NBP USDT i bez blokady |
| Prowizja swapu w USD | 0,50 USD × 4 = 2 zł kosztu | Kurs NBP pobrany dla prowizji fiat; koszt E = 2 zł |
| Prowizja swapu w BTC | brak wiarygodnej wyceny w PLN | koszt 0 zł i ostrzeżenie `CRYPTO_SWAP_COMMISSION_NO_FX`, bez blokady |
| Split 2:1 | zakup 10 za 400 zł; sprzedaż 10 za 600 zł: koszt 200, podatek 76 zł | pakiet blokowany, rekord splitu nie tworzy partii FIFO |
| Odwrotny split 1:2 | zakup 20 za 800 zł; sprzedaż 10 za 600 zł: koszt 800, podatek 0 zł | pakiet blokowany, rekord splitu nie tworzy partii FIFO |

Strona jest rozpoznawana tylko dla `1`, `buy`, `b`, `purchase`, `kupno`, `zakup` (także tekst zawierający `buy` lub `kup`) oraz `2`, `sell`, `s`, `sprzedaż`, `sprzedaz` (także tekst zawierający `sell` lub `sprzeda`). Każdy jawny inny kod blokuje rekord z instrumentem i niezerową ilością. Brak kodu blokuje tylko kompletną transakcję, nie niekompletny snapshot pozycji. Blokują m.in. `split`, `reverse_split`, transfery papierów i inne nieznane kody; komunikat wylicza rekordy, zaleca ręczną korektę ilości splitu oraz poprawienie strony, ręczne ujęcie lub dodanie zdarzenia w Historii. Ścieżka kanoniczna i normalizacja stosują tę samą klasyfikację.

Nierozstrzygnięta kwestia A13: podatek WHT 30% USA pozostaje sporny; silnik ogranicza zaliczenie do 150 zł przy polskim podatku 190 zł. Koszt krypto przeniesiony z 2025 do 2026 pozostaje naprawiony: 1600 zł kosztu, 2400 zł dochodu i 456 zł podatku.

Weryfikacja: Python 552 testy — zaliczone, 0 pominiętych; `npm run lint` — zaliczone. `npm test`: 619 testów, 616 zaliczonych, 3 niezaliczone, 0 pominiętych; porażki dotyczą testów eksportu XML krypto (pola 36–40). Test z podstawionym `fetch` dla timeoutu Binance przechodzi. Dodano 5 goldenów (w tym oba splity) oraz testy bramki kanonicznej i spójności normalizacji.
