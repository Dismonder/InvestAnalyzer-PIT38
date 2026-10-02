import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import { odczytajMotyw } from './portfel/services/preferencesBridge.ts';
import { zarejestrujServiceWorker } from './shared/rejestracjaPwa.ts';
import { sprawdzTrybHostingu } from './shared/trybHostingu.ts';
import './index.css';

// Motyw ustawiamy przed pierwszym renderem, zeby aplikacja nie mrugala jasnym
// tlem przy starcie w trybie ciemnym.
if (odczytajMotyw() === 'dark') {
  document.documentElement.classList.add('dark');
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// PWA: instalacja na telefonie i start bez sieci (tylko wydanie produkcyjne, nie desktop).
zarejestrujServiceWorker();
// Sonda /api/health: przy wlasnej domenie hostingu zapamietuje tryb, zeby widoki chowaly panele brokera.
void sprawdzTrybHostingu();
