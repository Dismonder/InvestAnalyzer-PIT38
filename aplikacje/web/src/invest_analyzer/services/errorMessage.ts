export function getErrorMessage(error: unknown, fallback = 'Wystąpił nieznany błąd.'): string {
  if (error instanceof Error && error.message.trim()) {
    return error.message;
  }

  if (typeof error === 'string' && error.trim()) {
    return error;
  }

  return fallback;
}
