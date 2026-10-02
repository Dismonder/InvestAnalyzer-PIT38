import { createServer as createViteServer } from "vite";
import { createServer as createHttpServer } from "http";
import path from "path";
import { fileURLToPath } from "url";
import {
  createInvestAnalyzerServer,
  formatServerHostForLog,
  resolveServerHost,
  resolveServerPort,
} from "./src/server/createInvestAnalyzerServer.ts";

const webRoot = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(webRoot, "../..");

const viteWatchIgnored = [
  "**/out/**",
  "**/silnik/python/out/**",
  "**/dane/pliki/**",
  "**/tmp/**",
  "**/dane/tymczasowe/**",
  "**/silnik/python/tmp/**",
  "**/wydania/**",
  "**/.pytest_cache/**",
];

async function startDevServer() {
  const PORT = resolveServerPort(3000);
  const HOST = resolveServerHost();
  const app = createInvestAnalyzerServer({ workspaceRoot: repoRoot });

  // HMR idzie tym samym gniazdem co aplikacja.
  //
  // Przy `hmr: false` Vite i tak wstrzykiwal do strony swojego klienta z portem
  // 24678, na ktorym nic nie nasluchiwalo: konsola zapelniala sie bledami
  // "WebSocket connection failed" przy kazdym uruchomieniu i zaslanialy one
  // bledy samej aplikacji. Osobny port bywa tez zajety albo odciety przez
  // zapore. Przekazanie serwera HTTP do `hmr.server` sprawia, ze polaczenie
  // idzie przez port aplikacji - jeden port dziala albo nie dziala w calosci.
  const httpServer = createHttpServer(app);

  const vite = await createViteServer({
    root: webRoot,
    configFile: path.join(webRoot, "vite.config.ts"),
    server: {
      middlewareMode: true,
      hmr: process.env.DISABLE_HMR === "true" ? false : { server: httpServer },
      watch: {
        ignored: viteWatchIgnored,
      },
    },
    appType: "spa",
  });

  app.use(vite.middlewares);
  httpServer.listen(PORT, HOST, () => {
    console.log(`Server running on http://${formatServerHostForLog(HOST)}:${PORT}`);
  });
}

startDevServer();
