# Investment Tax Engine

Deterministyczny, fail-closed i w pełni audytowalny silnik podatkowy (PIT-38) pod operacje giełdowe i brokerskie.

Zaimplementowany zgodnie z Modelem Architektury Produkcyjnej (Immutable Pipeline, Canonical Ledger, Strict FIFO Mode po przeliczeniu do PLN, API fallbacki).

## Użycie
Silnik może być uruchamiany w trzech trybach kontroli ryzyka błędów:
1. `STRICT` - używany w systemach produkcyjnych (wymaga zgadzającego się audytu FX oraz zmapowań symboli - brak przeliczania przy błędach)
2. `SAFE` - tryb roboczy pozwalający na weak dopasowania
3. `EXPLORATORY` - tryb testowy
    
## Etapy przetwarzania (Pipeline)
1. parse
2. normalize 
3. merge 
4. reconcile 
5. tax_fx 
6. fifo 
7. export
