import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Zestaw plikow wejsciowych dla testow - odpowiednik `tests/zestaw_wejsciowy.py`.
 *
 * Prawdziwe wyciagi leza w `dane/pliki` i nie trafiaja do repozytorium, bo maja
 * dane osobowe. Testy oparte wprost na nich konczyly sie na swiezym klonie
 * zielono, nie sprawdzajac niczego - `return` na poczatku ciala wylaczal je po
 * cichu. Tu wybor jest jawny: prywatny zestaw, gdy jest, inaczej syntetyczny
 * z `jakosc/dane-testowe` (buduje go `narzedzia/skrypty/zbuduj_dane_testowe.py`).
 */
export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

const PRIVATE_ROOT = path.join(REPO_ROOT, "dane", "pliki");
const SYNTHETIC_ROOT = path.join(REPO_ROOT, "jakosc", "dane-testowe");

const WYMUSZONY = (process.env.INVEST_TEST_FIXTURES ?? "").trim().toLowerCase();
const WYMUSZONO_SYNTETYCZNY = WYMUSZONY === "syntetyczny" || WYMUSZONY === "synthetic";

/** Archiwum kursow NBP w cp1250: prawdziwe, gdy jest na dysku, inaczej syntetyczne. */
export function archiwumKursowNbp(): { sciezka: string; prywatny: boolean } {
  const prywatne = path.join(PRIVATE_ROOT, "archiwum_tab_a_2025.csv");
  if (!WYMUSZONO_SYNTETYCZNY && existsSync(prywatne)) {
    return { sciezka: prywatne, prywatny: true };
  }
  const syntetyczne = path.join(SYNTHETIC_ROOT, "archiwum_tab_a_2025.csv");
  if (!existsSync(syntetyczne)) {
    // Brak obu zestawow ma zatrzymac test, a nie go wyciszyc.
    throw new Error(
      "Brak archiwum kursow do testow. Zbuduj zestaw syntetyczny poleceniem: " +
        "python narzedzia/skrypty/zbuduj_dane_testowe.py",
    );
  }
  return { sciezka: syntetyczne, prywatny: false };
}
