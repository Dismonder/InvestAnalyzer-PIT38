export function shouldHydrateEditorDraft(params: {
  currentRecordKey: string | null;
  hydratedRecordKey: string | null;
}): boolean {
  if (!params.currentRecordKey) {
    return false;
  }
  return params.hydratedRecordKey !== params.currentRecordKey;
}
