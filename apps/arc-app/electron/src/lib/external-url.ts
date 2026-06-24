import { shell } from "electron";

const ALLOWED_EXTERNAL_PROTOCOLS = new Set(["http:", "https:", "mailto:"]);

export function isAllowedExternalUrl(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl);
    return ALLOWED_EXTERNAL_PROTOCOLS.has(url.protocol);
  } catch {
    return false;
  }
}

export async function openExternalUrl(rawUrl: string): Promise<{ ok: true } | { error: string }> {
  if (!isAllowedExternalUrl(rawUrl)) {
    return { error: "Blocked external URL scheme" };
  }

  await shell.openExternal(rawUrl);
  return { ok: true };
}
