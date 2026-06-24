import { log } from "./logger";

export type UtilityProvider = "claude" | "codex" | "copilot" | "acp";

interface UnavailableProvider {
  until: number;
  reason: string;
}

const DEFAULT_UNAVAILABLE_TTL_MS = 10 * 60 * 1000;
const unavailableProviders = new Map<UtilityProvider, UnavailableProvider>();

export function isFatalProviderError(provider: UtilityProvider, message: string | undefined): boolean {
  const text = message ?? "";
  if (!text.trim()) return false;

  if (/quota|quota_exceeded|402|monthly quota|chat requests for the month|used all .*requests/i.test(text)) {
    return true;
  }

  if (/requiresOpenaiAuth|not signed in|not authenticated|login required|authentication required|401|403/i.test(text)) {
    return true;
  }

  if (provider === "copilot" && /copilot.*(sign in|login|auth|quota|plan)/i.test(text)) {
    return true;
  }

  return false;
}

export function markUtilityProviderUnavailable(
  provider: UtilityProvider,
  reason: string,
  ttlMs = DEFAULT_UNAVAILABLE_TTL_MS,
): void {
  unavailableProviders.set(provider, { until: Date.now() + ttlMs, reason });
  log("UTILITY_PROVIDER", `${provider} unavailable for ${Math.round(ttlMs / 1000)}s: ${reason.slice(0, 220)}`);
}

export function getUtilityProviderUnavailableReason(provider: UtilityProvider): string | null {
  const entry = unavailableProviders.get(provider);
  if (!entry) return null;
  if (Date.now() >= entry.until) {
    unavailableProviders.delete(provider);
    return null;
  }
  return entry.reason;
}

export function clearUtilityProviderUnavailable(provider: UtilityProvider): void {
  unavailableProviders.delete(provider);
}
