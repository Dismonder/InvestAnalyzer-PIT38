export function safeImportFileName(file: File): string {
  const rawName = String(file.name || 'plik').trim().replace(/^["']|["']$/g, '');
  const leafName = rawName.replace(/\\/g, '/').split('/').filter(Boolean).pop() || rawName || 'plik';
  const sanitized = leafName
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim();
  return sanitized || 'plik';
}

export function normalizeImportFile(file: File): File {
  const safeName = safeImportFileName(file);
  if (safeName === file.name) {
    return file;
  }
  return new File([file], safeName, {
    type: file.type,
    lastModified: file.lastModified,
  });
}
