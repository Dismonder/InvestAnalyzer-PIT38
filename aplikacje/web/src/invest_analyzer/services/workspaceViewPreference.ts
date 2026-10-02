import type { WorkspaceTargetView } from './workspaceReadiness';

export const WORKSPACE_VIEW_STORAGE_KEY = 'investAnalyzerCurrentView';

export const VALID_WORKSPACE_VIEWS: WorkspaceTargetView[] = [
  'pulpit',
  'centrum_pracy',
  'historia_transakcji',
  'raport_roczny',
  'import_danych',
];

export const DEFAULT_WORKSPACE_VIEW: WorkspaceTargetView = 'raport_roczny';

export function getInitialWorkspaceView(storage: Pick<Storage, 'getItem'> | null | undefined): WorkspaceTargetView {
  const stored = storage?.getItem(WORKSPACE_VIEW_STORAGE_KEY);
  return VALID_WORKSPACE_VIEWS.includes(stored as WorkspaceTargetView)
    ? (stored as WorkspaceTargetView)
    : DEFAULT_WORKSPACE_VIEW;
}
