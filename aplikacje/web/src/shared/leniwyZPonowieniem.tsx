import React, { lazy, type ComponentType, type LazyExoticComponent } from 'react';

type ModulZDomyslnym<P> = { default: ComponentType<P> };

/** Komponenty, ktorych ostatnie doczytanie sie nie udalo - do zwolnienia po przyjeciu bledu przez granice. */
const odrzucone = new Set<() => void>();

/**
 * Zwalnia zapamietane odrzucenia, zeby nastepne wyrenderowanie pobralo paczke
 * od nowa. Wola to granica bledow po przyjeciu bledu (componentDidCatch), bo
 * dopiero wtedy odrzucenie zostalo pokazane uzytkownikowi. Zwalnianie od razu
 * w chwili odrzucenia zapetlalo pobieranie: React po odrzuceniu renderuje
 * zawieszone poddrzewo ponownie, nowy import znow sie zawieszal i blad nigdy
 * nie docieral do granicy - okno "wczytywalo sie" bez konca.
 */
export function zwolnijOdrzuconeLeniwe(): void {
  for (const zwolnij of odrzucone) zwolnij();
  odrzucone.clear();
}

/**
 * Adres paczki z komunikatu bledu przegladarki (Chrome: "Failed to fetch
 * dynamically imported module: <adres>", Firefox: "error loading dynamically
 * imported module: <adres>"). Safari nie podaje adresu - wtedy null.
 */
export function adresPaczkiZBledu(blad: unknown): string | null {
  const tresc = blad instanceof Error ? blad.message : String(blad ?? '');
  const dopasowanie = /https?:\/\/\S+?\.m?js(?:\?\S*)?(?=\s|$)/.exec(tresc);
  return dopasowanie ? dopasowanie[0] : null;
}

/** Adres z dopiskiem, ktorego przegladarka nie ma jeszcze w pamieci modulow. */
export function adresPonowienia(adres: string, teraz: number): string {
  const bezDopisku = adres.replace(/[?&]ponow=\d+/, '').replace(/\?$/, '');
  return `${bezDopisku}${bezDopisku.includes('?') ? '&' : '?'}ponow=${teraz}`;
}

let importujZAdresu = (adres: string): Promise<unknown> => import(/* @vite-ignore */ adres);

/** Tylko do testow: w Node nie da sie importowac adresu http. */
export function ustawImportZAdresuDoTestow(fn: typeof importujZAdresu | null): void {
  importujZAdresu = fn ?? ((adres) => import(/* @vite-ignore */ adres));
}

/**
 * `React.lazy` zapamietuje odrzucenie na zawsze: gdy doczytanie paczki okna
 * albo zakladki raz sie nie uda (serwer w trakcie restartu, zerwana siec),
 * kazde kolejne otwarcie rzuca ten sam blad bez ponownej proby pobrania,
 * az do odswiezenia calej strony. Tutaj odrzucony komponent zostaje
 * zapamietany tylko do chwili, gdy granica bledow przyjmie blad; potem
 * nastepne wyrenderowanie probuje pobrac paczke od nowa.
 *
 * Przegladarka tez pamieta nieudane pobranie: ten sam adres modulu odrzuca
 * natychmiast, bez zapytania do serwera (sprawdzone w Chrome). Dlatego ponowna
 * proba idzie pod adres z dopiskiem `?ponow=<czas>` wziety z komunikatu bledu;
 * wspolne zaleznosci paczki sa juz w pamieci modulow i nie duplikuja sie.
 * Udany import jest zapamietany jak dotad - bez dodatkowych pobran.
 *
 * `wybierz` wskazuje eksport z modulu (domyslnie `default`), bo przy ponowieniu
 * pod innym adresem trzeba go wybrac tak samo jak przy pierwszym imporcie.
 */
export function leniwyZPonowieniem<P extends object>(importer: () => Promise<ModulZDomyslnym<P>>): ComponentType<P>;
export function leniwyZPonowieniem<P extends object, M>(
  importer: () => Promise<M>,
  wybierz: (modul: M) => ComponentType<P>,
): ComponentType<P>;
export function leniwyZPonowieniem<P extends object, M>(
  importer: () => Promise<M>,
  wybierz: (modul: M) => ComponentType<P> = (modul) => (modul as unknown as ModulZDomyslnym<P>).default,
): ComponentType<P> {
  let zapamietany: LazyExoticComponent<ComponentType<P>> | null = null;
  let adresOstatniegoBledu: string | null = null;

  const pobierz = (): Promise<M> =>
    adresOstatniegoBledu
      ? (importujZAdresu(adresPonowienia(adresOstatniegoBledu, Date.now())) as Promise<M>)
      : importer();

  const utworz = () => {
    const biezacy = lazy(() =>
      pobierz()
        .then((modul) => ({ default: wybierz(modul) }))
        .catch((blad: unknown) => {
          adresOstatniegoBledu = adresPaczkiZBledu(blad) ?? adresOstatniegoBledu;
          odrzucone.add(() => {
            if (zapamietany === biezacy) zapamietany = null;
          });
          throw blad;
        }),
    );
    return biezacy;
  };

  function Ponawialny(props: P) {
    if (!zapamietany) zapamietany = utworz();
    const Komponent = zapamietany;
    return <Komponent {...props} />;
  }

  return Ponawialny;
}
