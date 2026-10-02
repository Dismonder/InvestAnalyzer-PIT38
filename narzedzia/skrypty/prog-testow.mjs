/**
 * Prog wykonanych testow.
 *
 * Testy wpiete w prywatne wyciagi konczyly sie na swiezym klonie zielono, nie
 * sprawdzajac niczego: `pytest.mark.skipif` i `return` na poczatku ciala
 * wylaczaly szesnascie z nich, a `verify` i tak przechodzil. Sam fakt "zero
 * bledow" niczego nie dowodzi, jesli nie wiadomo, ile testow sie wykonalo.
 *
 * Stad dwie asercje po kazdym przebiegu: zadnego pominietego testu i nie mniej
 * niz `prog` zdanych. Prog stoi nieco ponizej biezacej liczby, zeby zwykle
 * przepisanie testu go nie ruszalo, ale zniknieciecie calego pliku - juz tak.
 */
export function sprawdzProgTestow({ nazwa, zdane, pominiete, prog }) {
  const bledy = [];
  if (!Number.isFinite(zdane)) {
    bledy.push(`nie udalo sie odczytac liczby wykonanych testow (${nazwa}) - zmienil sie format raportu?`);
  } else if (zdane < prog) {
    bledy.push(
      `${nazwa}: wykonano ${zdane} testow, prog wynosi ${prog}. ` +
        'Albo testy zniknely, albo zostaly po cichu pominiete.',
    );
  }
  if (pominiete > 0) {
    bledy.push(
      `${nazwa}: ${pominiete} testow pominieto. Pominiecie zalezne od plikow lokalnych ` +
        'jest dokladnie ta awaria, ktora ten prog ma wykrywac - zbuduj zestaw syntetyczny ' +
        '(python narzedzia/skrypty/zbuduj_dane_testowe.py) zamiast pomijac test.',
    );
  }
  if (bledy.length > 0) {
    for (const blad of bledy) console.error(`  error: ${blad}`);
    process.exit(1);
  }
  console.log(`  ${nazwa}: ${zdane} testow wykonanych, 0 pominietych (prog ${prog}).`);
}
