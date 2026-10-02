import type express from "express";

/**
 * Express 4 nie przechwytuje odrzucen z async handlerow: wyjatek po `await`
 * (np. nieoczekiwany ksztalt odpowiedzi brokera) zostawial zadanie bez
 * odpowiedzi, a nieobsluzone odrzucenie od Node 15 konczy caly proces serwera.
 *
 * Po zarejestrowaniu wszystkich tras owijamy kazdy handler tak, by odrzucona
 * obietnica trafila do `next(error)`, a stamtad do koncowej obslugi bledu.
 * Routery sa modulami wspoldzielonymi miedzy instancjami serwera (testy),
 * wiec owiniete funkcje sa oznaczane i nie owijane drugi raz.
 */
const OWINIETY = Symbol("owinietyHandlerAsync");

type Handler = ((req: express.Request, res: express.Response, next: express.NextFunction) => unknown) & { [OWINIETY]?: true };
interface Warstwa { handle: Handler & { stack?: Warstwa[] }; route?: { stack: Warstwa[] } }

function owin(handler: Handler): Handler {
  // Obsluga bledow (4 argumenty) i funkcje juz owiniete zostaja bez zmian.
  if (handler[OWINIETY] || handler.length >= 4) return handler;
  const owiniety: Handler = function (this: unknown, req, res, next) {
    const wynik = handler.call(this, req, res, next);
    if (wynik && typeof (wynik as Promise<unknown>).catch === "function") {
      (wynik as Promise<unknown>).catch(next);
    }
    return wynik;
  };
  owiniety[OWINIETY] = true;
  return owiniety;
}

function przejdz(stos: Warstwa[] | undefined): void {
  for (const warstwa of stos ?? []) {
    if (warstwa.route) {
      for (const krok of warstwa.route.stack) krok.handle = owin(krok.handle);
    } else if (Array.isArray(warstwa.handle?.stack)) {
      przejdz(warstwa.handle.stack);
    } else if (typeof warstwa.handle === "function") {
      warstwa.handle = owin(warstwa.handle);
    }
  }
}

export function zabezpieczTrasyAsync(app: express.Express): void {
  przejdz((app as unknown as { _router?: { stack: Warstwa[] } })._router?.stack);
}

/** Koncowa obsluga bledu: 500 z JSON-em, bez tresci wyjatku (moze zawierac dane). */
export function koncowaObslugaBledu(
  error: unknown,
  req: express.Request,
  res: express.Response,
  next: express.NextFunction,
): void {
  if (res.headersSent) {
    next(error);
    return;
  }
  console.error(`[serwer] Nieobsluzony blad trasy ${req.method} ${req.path}:`, error);
  res.status(500).json({ success: false, error: "Wewnętrzny błąd serwera. Szczegóły w logu serwera." });
}
