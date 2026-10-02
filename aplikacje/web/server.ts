import path from "path";
import {
  createInvestAnalyzerServer,
  formatServerHostForLog,
  resolveServerHost,
  resolveServerPort,
} from "./src/server/createInvestAnalyzerServer.ts";
import { getWebDistRoot } from "./src/server/workspacePaths.ts";

const repoRoot = process.cwd();

const PORT = resolveServerPort(3000);
const HOST = resolveServerHost();
const app = createInvestAnalyzerServer({
  serveStatic: true,
  staticDir: getWebDistRoot(repoRoot),
  workspaceRoot: repoRoot,
});

app.listen(PORT, HOST, () => {
  console.log(`Server running on http://${formatServerHostForLog(HOST)}:${PORT}`);
});
