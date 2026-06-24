/**
 * Renderer-side local event helpers.
 *
 * ARC public builds do not send product analytics or exception reports to a
 * remote service. These helpers remain as compatibility no-ops so feature code
 * does not need telemetry-specific branching.
 */

export function capture(_event: string, _properties?: Record<string, unknown>): void {
  // Intentionally empty: no remote analytics.
}

export function captureException(error: Error, properties?: Record<string, unknown>): void {
  console.error("[captureException]", properties ?? {}, error);
}

/**
 * Log a warning to the console and return the extracted message.
 *
 * Renderer-side equivalent of the main process `reportError()` helper.
 *
 * @returns The extracted error message string (for use in UI state).
 */
export function reportError(
  label: string,
  err: unknown,
  context?: Record<string, unknown>,
): string {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`[${label}]`, err);

  const error = err instanceof Error ? err : new Error(message);
  captureException(error, { label, ...context });

  return message;
}
