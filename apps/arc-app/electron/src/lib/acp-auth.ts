import type { ACPAuthMethod } from "@shared/types/acp";

function toRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? value as Record<string, unknown> : null;
}

function extractMessage(err: unknown): string {
  if (typeof err === "string") return err;
  if (err instanceof Error) return err.message;
  const record = toRecord(err);
  if (typeof record?.message === "string") return record.message;
  return String(err);
}

export function normalizeAcpAuthMethods(methods: unknown): ACPAuthMethod[] {
  if (!Array.isArray(methods)) return [];
  const normalized: ACPAuthMethod[] = [];
  for (const raw of methods) {
    const record = toRecord(raw);
    if (!record || typeof record.id !== "string" || typeof record.name !== "string") continue;
    const description = typeof record.description === "string" ? record.description : null;
    const type = typeof record.type === "string" ? record.type : undefined;
    if (type === "env_var") {
      const vars = Array.isArray(record.vars)
        ? record.vars.flatMap((entry) => {
            const varRecord = toRecord(entry);
            if (!varRecord || typeof varRecord.name !== "string") return [];
            return [{
              name: varRecord.name,
              label: typeof varRecord.label === "string" ? varRecord.label : null,
              optional: varRecord.optional === true,
              secret: varRecord.secret !== false,
            }];
          })
        : [];
      normalized.push({
        id: record.id,
        name: record.name,
        description,
        type: "env_var",
        vars,
        link: typeof record.link === "string" ? record.link : null,
      });
      continue;
    }
    if (type === "terminal") {
      normalized.push({
        id: record.id,
        name: record.name,
        description,
        type: "terminal",
        args: Array.isArray(record.args) ? record.args.filter((arg): arg is string => typeof arg === "string") : [],
        env: toRecord(record.env)
          ? Object.fromEntries(Object.entries(record.env as Record<string, unknown>).filter(([, value]) => typeof value === "string")) as Record<string, string>
          : {},
      });
      continue;
    }
    normalized.push({
      id: record.id,
      name: record.name,
      description,
    });
  }
  return normalized;
}

export function getAcpRequestError(err: unknown): { code?: number; data?: unknown; message: string } {
  const record = toRecord(err);
  return {
    code: typeof record?.code === "number" ? record.code : undefined,
    data: record?.data,
    message: extractMessage(err),
  };
}

export function extractAuthRequired(err: unknown, fallbackMethods: ACPAuthMethod[] = []): ACPAuthMethod[] | null {
  const requestError = getAcpRequestError(err);
  const isAuthRequired = requestError.code === -32000 || /authentication required/i.test(requestError.message);
  if (!isAuthRequired) return null;

  const dataRecord = toRecord(requestError.data);
  const authMethods = normalizeAcpAuthMethods(dataRecord?.authMethods);
  return authMethods.length > 0 ? authMethods : fallbackMethods;
}

export function getAuthGuidance(agentName: string, authMethods: ACPAuthMethod[]): string | null {
  const usesCursorLogin = authMethods.some((method) => method.id === "cursor_login");
  if (!usesCursorLogin && !/cursor/i.test(agentName)) return null;
  return "Cursor authentication may require running `cursor-agent login` first.";
}

export function buildAuthRequiredError(agentName: string, authMethods: ACPAuthMethod[]): string {
  const guidance = getAuthGuidance(agentName, authMethods);
  return guidance ? `Authentication required. ${guidance}` : "Authentication required.";
}
