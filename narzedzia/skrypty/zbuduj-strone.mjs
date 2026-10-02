// Kopiuje do wydania/strona tylko to, co ma byc publiczne: docs/index.html i docs/zrzuty.
// Reszta docs/ (kontekst sesji, dziennik, kontrakty) zostaje poza serwerem.
import { cpSync, mkdirSync, rmSync, writeFileSync, statSync } from 'node:fs';
import path from 'node:path';

const repo = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..', '..');
const cel = path.join(repo, 'wydania', 'strona');
rmSync(cel, { recursive: true, force: true });
mkdirSync(cel, { recursive: true });
cpSync(path.join(repo, 'docs', 'index.html'), path.join(cel, 'index.html'));
cpSync(path.join(repo, 'docs', 'zrzuty'), path.join(cel, 'zrzuty'), { recursive: true, filter: (zrodlo) => !zrodlo.endsWith('.json') });
writeFileSync(path.join(cel, '404.html'), '<!doctype html><meta charset="utf-8"><title>Nie znaleziono</title><p>Nie ma takiej strony. <a href="/">Strona projektu InvestAnalyzer</a></p>\n');
console.log(`Strona zbudowana w ${cel}: index.html ${statSync(path.join(cel, 'index.html')).size} B`);
