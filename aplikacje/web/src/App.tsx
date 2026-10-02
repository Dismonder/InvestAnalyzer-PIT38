/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import PortfelApp from './portfel/PortfelApp';
import { ErrorBoundary } from './invest_analyzer/components/ErrorBoundary';

/**
 * Powloka calej aplikacji: wyglad i nawigacja portfela inwestora,
 * a pod zakladka "Dokumenty i silnik" pelny warsztat silnika podatkowego.
 *
 * Granica bledu obejmuje calosc, bo awaria w dowolnym ekranie konczyla sie
 * bialym ekranem bez wyjscia. Teraz uzytkownik dostaje komunikat i przycisk
 * odzyskiwania zamiast pustej strony.
 */
export default function App() {
  return (
    <ErrorBoundary>
      <PortfelApp />
    </ErrorBoundary>
  );
}
