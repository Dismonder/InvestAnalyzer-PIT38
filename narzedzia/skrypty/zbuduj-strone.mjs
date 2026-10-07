// Kopiuje do wydania/strona tylko to, co ma byc publiczne: docs/index.html, docs/prywatnosc.html
// i docs/zrzuty. Reszta docs/ (kontekst sesji, dziennik, kontrakty) zostaje poza serwerem.
//
// Do wydania trafia tez `_headers` (Workers Static Assets czyta go z katalogu wydania):
// CSP, w ktorej skrypty i style inline sa dopuszczone wylacznie po skrocie SHA-256
// policzonym tutaj z tresci plikow - zadnego 'unsafe-inline' dla skryptow - oraz
// komplet naglowkow bezpieczenstwa i `.well-known/security.txt`.
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync, statSync } from 'node:fs';
import path from 'node:path';

const repo = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..', '..');
const cel = path.join(repo, 'wydania', 'strona');
rmSync(cel, { recursive: true, force: true });
mkdirSync(path.join(cel, '.well-known'), { recursive: true });
cpSync(path.join(repo, 'docs', 'index.html'), path.join(cel, 'index.html'));
cpSync(path.join(repo, 'docs', 'prywatnosc.html'), path.join(cel, 'prywatnosc.html'));
// Do wydania ida wylacznie obrazy; manifesty .json, notatki i cokolwiek innego w docs/zrzuty zostaje w repo.
const OBRAZ = /\.(png|jpe?g|webp|avif|gif|svg)$/i;
cpSync(path.join(repo, 'docs', 'zrzuty'), path.join(cel, 'zrzuty'), { recursive: true, filter: (zrodlo) => statSync(zrodlo).isDirectory() || OBRAZ.test(zrodlo) });
writeFileSync(path.join(cel, '404.html'), '<!doctype html><meta charset="utf-8"><title>Nie znaleziono</title><p>Nie ma takiej strony. <a href="/">Strona projektu InvestAnalyzer</a></p>\n');

/** Skroty CSP ('sha256-...') wszystkich blokow <script> bez src i <style> w pliku HTML. */
export function skrotyCsp(html) {
  const skrot = (tresc) => `'sha256-${createHash('sha256').update(tresc, 'utf8').digest('base64')}'`;
  const zbierz = (wzor) => [...html.matchAll(wzor)].map((m) => skrot(m[1]));
  return {
    skrypty: zbierz(/<script(?![^>]*\ssrc=)[^>]*>([\s\S]*?)<\/script>/gi),
    style: zbierz(/<style[^>]*>([\s\S]*?)<\/style>/gi),
    zdarzeniaInline: /\son[a-z]+\s*=/i.test(html) || /javascript:/i.test(html),
  };
}

/** CSP strony statycznej: tylko wlasne zasoby, skrypty/style inline po skrocie. */
export function politykaCsp({ skrypty, style }) {
  const scriptSrc = skrypty.length ? skrypty.join(' ') : "'none'";
  const styleSrc = ["'self'", ...style].join(' ');
  return `default-src 'self'; script-src ${scriptSrc}; style-src ${styleSrc}; img-src 'self' data:; font-src 'self'; `
    + "connect-src 'self'; object-src 'none'; frame-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'; upgrade-insecure-requests";
}

const WSPOLNE_NAGLOWKI = [
  'Strict-Transport-Security: max-age=31536000; includeSubDomains',
  'X-Content-Type-Options: nosniff',
  'X-Frame-Options: DENY',
  'Referrer-Policy: strict-origin-when-cross-origin',
  'Permissions-Policy: accelerometer=(), camera=(), display-capture=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), midi=(), payment=(), publickey-credentials-get=(), serial=(), usb=(), xr-spatial-tracking=()',
  'Cross-Origin-Opener-Policy: same-origin',
  'Cross-Origin-Resource-Policy: same-origin',
  'X-Permitted-Cross-Domain-Policies: none',
];

const strony = [
  { plik: 'index.html', sciezki: ['/', '/index.html'] },
  { plik: 'prywatnosc.html', sciezki: ['/prywatnosc', '/prywatnosc.html'] },
  { plik: '404.html', sciezki: ['/404.html'] },
];

const bloki = [`/*\n${WSPOLNE_NAGLOWKI.map((n) => `  ${n}`).join('\n')}`];
for (const strona of strony) {
  const html = readFileSync(path.join(cel, strona.plik), 'utf8');
  const skroty = skrotyCsp(html);
  if (skroty.zdarzeniaInline) {
    throw new Error(`${strona.plik}: atrybuty on*= albo adresy javascript: nie przejda przez CSP - przenies je do bloku <script>.`);
  }
  const csp = politykaCsp(skroty);
  for (const sciezka of strona.sciezki) {
    bloki.push(`${sciezka}\n  Content-Security-Policy: ${csp}\n  Cache-Control: no-cache, must-revalidate`);
  }
}
bloki.push('/zrzuty/*\n  Cache-Control: public, max-age=86400');
writeFileSync(path.join(cel, '_headers'), `${bloki.join('\n\n')}\n`);

writeFileSync(path.join(cel, '.well-known', 'security.txt'), [
  'Contact: https://github.com/Dismonder/InvestAnalyzer-PIT38/security/advisories/new',
  'Contact: https://github.com/Dismonder',
  'Expires: 2027-10-07T00:00:00.000Z',
  'Preferred-Languages: pl, en',
  'Canonical: https://investanalyzer-strona.dismonder.workers.dev/.well-known/security.txt',
  'Policy: https://investanalyzer-strona.dismonder.workers.dev/prywatnosc',
  '',
].join('\n'));

const rozmiar = statSync(path.join(cel, 'index.html')).size;
console.log(`Strona zbudowana w ${cel}: index.html ${rozmiar} B, prywatnosc.html, _headers (CSP ze skrotami), security.txt`);
