import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import { fileURLToPath } from 'url';
import {defineConfig, type Plugin} from 'vite';
import { createHash } from 'crypto';
import { readFileSync } from 'fs';

const webRoot = path.dirname(fileURLToPath(import.meta.url));

/** Pliki z public/ wchodzace do pamieci service workera obok paczek z wydania. */
const PLIKI_POWLOKI = ['/', '/index.html', '/motyw.js', '/manifest.webmanifest', '/ikony/ikona.svg', '/ikony/ikona-192.png'];

/**
 * Buduje /sw.js z szablonu sw.szablon.js: wstawia odcisk wydania (skrot nazw
 * wszystkich paczek) i liste plikow do zapamietania. Odcisk zmienia sie z kazda
 * zmiana kodu, wiec przegladarka instaluje nowy service worker i czysci stara pamiec.
 */
function serviceWorkerPwa(): Plugin {
  return {
    name: 'investanalyzer-service-worker',
    apply: 'build',
    generateBundle(_opcje, paczka) {
      const pliki = Object.values(paczka)
        .filter((wpis) => wpis.type === 'chunk' || wpis.fileName.endsWith('.css'))
        .map((wpis) => `/${wpis.fileName}`)
        .sort();
      const wersja = createHash('sha256').update(pliki.join('|')).digest('hex').slice(0, 12);
      const szablon = readFileSync(path.join(webRoot, 'sw.szablon.js'), 'utf8');
      this.emitFile({
        type: 'asset',
        fileName: 'sw.js',
        source: szablon
          .replaceAll('__WERSJA__', wersja)
          .replaceAll('__PLIKI__', JSON.stringify([...PLIKI_POWLOKI, ...pliki], null, 2)),
      });
    },
  };
}

export default defineConfig(() => {
  return {
    root: webRoot,
    plugins: [react(), tailwindcss(), serviceWorkerPwa()],
    resolve: {
      alias: {
        '@': path.resolve(webRoot, 'src'),
        // jspdf ciagnie te trzy biblioteki wylacznie dla metody doc.html(),
        // ktorej ten program nie uzywa. Podmiana na zaslepke zdejmuje okolo
        // 290 kB z wydania. Opis w samej zaslepce.
        html2canvas: path.resolve(webRoot, 'src/shared/generatorPdfBezPrzegladarki.ts'),
        canvg: path.resolve(webRoot, 'src/shared/generatorPdfBezPrzegladarki.ts'),
        dompurify: path.resolve(webRoot, 'src/shared/generatorPdfBezPrzegladarki.ts'),
      },
    },
    build: {
      outDir: path.resolve(webRoot, '../../wydania/web'),
      emptyOutDir: true,
      rollupOptions: {
        output: {
          manualChunks(id) {
            const normalizedId = id.replace(/\\/g, '/');
            // Nawigacja jest zawsze ladowana; osobna paczka trzyma rozmiar
            // kodu wejsciowego ponizej budzetu bez opozniania jej montowania.
            if (normalizedId.endsWith('/portfel/components/BottomNavbar.tsx')) {
              return 'bottom-navbar';
            }
            // Granica bledow jest wspolna dla powloki, widokow i okien. Osobna
            // paczka pozwala ja buforowac niezaleznie od kodu glownej aplikacji;
            // jej rozmiar nadal wlicza sie do budzetu calego startowego JS.
            if (normalizedId.endsWith('/invest_analyzer/components/ErrorBoundary.tsx')) {
              return 'error-boundary';
            }
            if (!normalizedId.includes('/node_modules/')) {
              return undefined;
            }
            if (
              normalizedId.includes('/node_modules/react/')
              || normalizedId.includes('/node_modules/react-dom/')
              || normalizedId.includes('/node_modules/scheduler/')
            ) {
              return 'vendor-react';
            }
            if (normalizedId.includes('/node_modules/xlsx/')) {
              return 'vendor-xlsx';
            }
            // Generator PDF jest potrzebny dopiero przy eksporcie i jest
            // wciagany wylacznie dynamicznym importem. Zadne przypisanie do
            // wspolnej paczki: wlasna regula sklejala go z modulem, ktory
            // importowal potem KAZDY widok, a wymuszenie vendor-core wsadzalo
            // go wprost do pakietu startowego. Rollup sam zrobi z niego
            // osobna paczke ladowana na zadanie.
            if (
              normalizedId.includes('/node_modules/jspdf/')
              || normalizedId.includes('/node_modules/jspdf-autotable/')
              || normalizedId.includes('/node_modules/canvg/')
              || normalizedId.includes('/node_modules/html2canvas/')
              || normalizedId.includes('/node_modules/dompurify/')
              || normalizedId.includes('/node_modules/raf/')
              || normalizedId.includes('/node_modules/rgbcolor/')
              || normalizedId.includes('/node_modules/stackblur-canvas/')
              // Zaleznosci jspdf. Bez nich tutaj trafialy do startowego
              // vendor-core (ok. 50 kB po kompresji) mimo leniwego generatora.
              || normalizedId.includes('/node_modules/fflate/')
              || normalizedId.includes('/node_modules/fast-png/')
              || normalizedId.includes('/node_modules/pako/')
              || normalizedId.includes('/node_modules/iobuffer/')
              || normalizedId.includes('/node_modules/@babel/runtime/')
            ) {
              return undefined;
            }
            // Recharts razem z calym swoim drzewem zaleznosci (redux, immer,
            // es-toolkit, decimal.js-light...). Wczesniej zaleznosci ladowaly
            // sie w startowym vendor-core, choc wykresy sa tylko w leniwych widokach.
            if (
              normalizedId.includes('/node_modules/recharts/')
              || normalizedId.includes('/node_modules/d3-')
              || normalizedId.includes('/node_modules/victory-vendor/')
              || normalizedId.includes('/node_modules/internmap/')
              || normalizedId.includes('/node_modules/@reduxjs/toolkit/')
              || normalizedId.includes('/node_modules/redux/')
              || normalizedId.includes('/node_modules/redux-thunk/')
              || normalizedId.includes('/node_modules/react-redux/')
              || normalizedId.includes('/node_modules/reselect/')
              || normalizedId.includes('/node_modules/immer/')
              || normalizedId.includes('/node_modules/es-toolkit/')
              || normalizedId.includes('/node_modules/decimal.js-light/')
              || normalizedId.includes('/node_modules/eventemitter3/')
              || normalizedId.includes('/node_modules/use-sync-external-store/')
              || normalizedId.includes('/node_modules/react-is/')
            ) {
              return 'vendor-charts';
            }
            // Wykres gieldowy jest wciagany dynamicznie z zakladki Wykresy. Bez tej
            // reguly ladowal w startowym vendor-core (+140 kB dla kazdego widoku).
            if (
              normalizedId.includes('/node_modules/lightweight-charts/')
              || normalizedId.includes('/node_modules/fancy-canvas/')
            ) {
              return undefined;
            }
            if (normalizedId.includes('/node_modules/lucide-react/')) {
              return 'vendor-icons';
            }
            // Animacje i formatowanie dat uzywaja wylacznie leniwe widoki
            // warsztatu podatkowego; w vendor-core ladowaly sie przy kazdym starcie.
            if (
              normalizedId.includes('/node_modules/motion/')
              || normalizedId.includes('/node_modules/motion-dom/')
              || normalizedId.includes('/node_modules/motion-utils/')
              || normalizedId.includes('/node_modules/framer-motion/')
            ) {
              return 'vendor-motion';
            }
            if (normalizedId.includes('/node_modules/date-fns/')) {
              return undefined;
            }
            return 'vendor-core';
          },
        },
      },
    },
    worker: {
      format: 'es',
    },
    server: {
      // HMR jest domyślnie wyłączony, żeby równoległe lokalne serwery nie blokowały portu WebSocket.
      // Wlaczone domyslnie; `DISABLE_HMR=true` wylacza. Port ustawia
      // server-dev.ts, ktory prowadzi serwer deweloperski.
      hmr: process.env.DISABLE_HMR !== 'true',
      watch: {
        ignored: [
          '**/out/**',
          '**/silnik/python/out/**',
          '**/dane/pliki/**',
          '**/tmp/**',
          '**/dane/tymczasowe/**',
          '**/silnik/python/tmp/**',
          '**/wydania/**',
          '**/.pytest_cache/**',
        ],
      },
    },
  };
});
