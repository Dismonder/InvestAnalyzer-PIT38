import path from "node:path";

export function getStorageRoot(workspaceRoot: string): string {
  return path.resolve(workspaceRoot, "dane", "pliki");
}

export function getPythonEngineRoot(workspaceRoot: string): string {
  return path.resolve(workspaceRoot, "silnik", "python");
}

export function getBackupsRoot(workspaceRoot: string): string {
  return path.resolve(workspaceRoot, "dane", "backupy");
}

export function getRepoTmpRoot(workspaceRoot: string): string {
  return path.resolve(workspaceRoot, "dane", "tymczasowe");
}

export function getWebDistRoot(workspaceRoot: string): string {
  return path.resolve(workspaceRoot, "wydania", "web");
}
