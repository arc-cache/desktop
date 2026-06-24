/**
 * Local event sink.
 *
 * The app keeps lightweight event call sites so feature code does not depend on
 * whether product analytics exist. Public ARC builds do not send analytics or
 * exception reports to a remote service.
 */

export async function captureEvent(
  _event: string,
  _properties?: Record<string, unknown>,
): Promise<void> {
  // Intentionally empty: no remote analytics.
}

export function captureException(
  _error: Error,
  _additionalProperties?: Record<string, unknown>,
): void {
  // Intentionally empty: errors are logged locally by reportError().
}
