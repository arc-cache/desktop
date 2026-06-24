import { ipcMain } from "electron";
import { log } from "../lib/logger";
import { getSDK, clientAppEnv } from "../lib/sdk";
import { extractErrorMessage, reportError } from "../lib/error-utils";
import { gitExec } from "../lib/git-exec";
import { getClaudeBinaryPath } from "../lib/claude-binary";
import { childProcessEnv } from "../lib/electron-node";
import {
  getUtilityProviderUnavailableReason,
  isFatalProviderError,
  markUtilityProviderUnavailable,
  type UtilityProvider,
} from "../lib/provider-health";

function firstNonEmptyLine(text: string): string | undefined {
  for (const line of text.split(/\r?\n/g)) {
    const trimmed = line.trim();
    if (trimmed.length > 0) return trimmed;
  }
  return undefined;
}

interface OneShotSdkQueryOptions {
  timeoutMs?: number;
  model?: string;
  extraOptions?: Record<string, unknown>;
}

/** Fire a one-shot SDK query and return the first-line result. */
async function oneShotSdkQuery(
  prompt: string,
  cwd: string,
  logLabel: string,
  options?: OneShotSdkQueryOptions,
): Promise<{ result?: string; error?: string }> {
  const timeoutMs = options?.timeoutMs ?? 60000;
  const model = options?.model?.trim() || "haiku";
  const startedAt = Date.now();
  log(logLabel, `one-shot:start cwd=${cwd} model=${model} prompt_len=${prompt.length} timeout_ms=${timeoutMs}`);

  try {
    const query = await getSDK();
    const cliPath = await getClaudeBinaryPath();
    if (cliPath) {
      log("SDK_CLI_PATH", `${logLabel} path=${cliPath}`);
    } else {
      log("SDK_CLI_PATH", `${logLabel} unresolved; relying on SDK fallback`);
    }
    let eventCount = 0;
    let lastEventType = "none";
    let lastResultSubtype = "none";
    let assistantText = "";
    let lastStderr = "";
    let timedOut = false;

    const q = query({
      prompt,
      options: {
        ...options?.extraOptions,
        cwd,
        model,
        maxTurns: 1,
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        persistSession: false,
        pathToClaudeCodeExecutable: cliPath,
        env: childProcessEnv(clientAppEnv()),
        stderr: (data: string) => {
          const trimmed = data.trim();
          if (!trimmed) return;
          lastStderr = trimmed;
          log(`${logLabel}_STDERR`, trimmed);
        },
      },
    });

    const timeout = setTimeout(() => {
      timedOut = true;
      log(`${logLabel}_TIMEOUT`, `one-shot timed out after ${timeoutMs}ms`);
      try {
        q.close();
      } catch {
        // ignore cleanup errors
      }
    }, timeoutMs);

    try {
      for await (const msg of q) {
        eventCount += 1;
        const m = msg as Record<string, unknown>;
        if (typeof m.type === "string") {
          lastEventType = m.type;
        }

        if (m.type === "assistant") {
          const message = m.message;
          const content = (
            message &&
            typeof message === "object" &&
            "content" in message &&
            Array.isArray((message as { content?: unknown }).content)
          )
            ? (message as { content: unknown[] }).content
            : [];
          for (const block of content) {
            if (!block || typeof block !== "object") continue;
            const maybeType = "type" in block ? (block as { type?: unknown }).type : undefined;
            const maybeText = "text" in block ? (block as { text?: unknown }).text : undefined;
            if (maybeType === "text" && typeof maybeText === "string") {
              assistantText += maybeText;
            }
          }
          continue;
        }

        if (m.type === "result") {
          if (typeof m.subtype === "string") {
            lastResultSubtype = m.subtype;
          }
          clearTimeout(timeout);

          const rawResult = typeof m.result === "string" ? m.result : "";
          const chosen = firstNonEmptyLine(rawResult) ?? firstNonEmptyLine(assistantText);
          if (!chosen) {
            const elapsed = Date.now() - startedAt;
            log(
              `${logLabel}_ERR`,
              `empty result subtype=${lastResultSubtype} elapsed_ms=${elapsed} events=${eventCount} last_event=${lastEventType} stderr="${lastStderr || "none"}"`,
            );
            return { error: "empty result" };
          }

          const elapsed = Date.now() - startedAt;
          log(logLabel, `Generated subtype=${lastResultSubtype} elapsed_ms=${elapsed} text="${chosen}"`);
          return { result: chosen };
        }
      }
    } catch (err) {
      clearTimeout(timeout);
      const errMsg = reportError(`${logLabel}_QUERY_ERR`, err, { context: "one-shot-query" });
      const elapsed = Date.now() - startedAt;
      log(
        `${logLabel}_ERR`,
        `${errMsg} elapsed_ms=${elapsed} events=${eventCount} last_event=${lastEventType} stderr="${lastStderr || "none"}"`,
      );
      return { error: errMsg };
    }

    clearTimeout(timeout);
    const elapsed = Date.now() - startedAt;
    if (timedOut) {
      return { error: `Timed out after ${timeoutMs}ms` };
    }
    const fallback = firstNonEmptyLine(assistantText);
    if (fallback) {
      log(logLabel, `Generated fallback elapsed_ms=${elapsed} text="${fallback}"`);
      return { result: fallback };
    }
    log(
      `${logLabel}_ERR`,
      `No result received elapsed_ms=${elapsed} events=${eventCount} last_event=${lastEventType} last_result=${lastResultSubtype} stderr="${lastStderr || "none"}"`,
    );
    return { error: "No result received" };
  } catch (err) {
    const errMsg = reportError(`${logLabel}_SPAWN_ERR`, err, { context: "one-shot-spawn" });
    return { error: errMsg };
  }
}

function utilityEngineOrder(requestedEngine?: UtilityProvider, sessionId?: string): UtilityProvider[] {
  const requested = requestedEngine ?? "claude";
  const engines: UtilityProvider[] = [];
  const add = (engine: UtilityProvider) => {
    if (engine === "acp" && !sessionId) return;
    if (!engines.includes(engine)) engines.push(engine);
  };

  add(requested);
  // Codex is the preferred packaged fallback for non-Codex utility work because
  // it matches the app-server protocol and avoids retrying a failed Copilot quota.
  add("codex");
  add("claude");
  return engines;
}

async function runUtilityTextWithFallback(options: {
  prompt: string;
  cwd: string;
  requestedEngine?: UtilityProvider;
  sessionId?: string;
  logLabel: "TITLE_GEN" | "COMMIT_MSG_GEN";
  timeoutMs: number;
  claudeModel?: string;
  claudeExtraOptions?: Record<string, unknown>;
}): Promise<{ text?: string; engine?: UtilityProvider; error?: string }> {
  const errors: string[] = [];

  for (const engine of utilityEngineOrder(options.requestedEngine, options.sessionId)) {
    const unavailable = getUtilityProviderUnavailableReason(engine);
    if (unavailable) {
      log(options.logLabel, `Skipping ${engine}: provider temporarily unavailable (${unavailable.slice(0, 160)})`);
      errors.push(`${engine}: ${unavailable}`);
      continue;
    }

    try {
      const text = await runUtilityTextForEngine(engine, options);
      log(options.logLabel, `${engine} generated: "${text}"`);
      return { text, engine };
    } catch (err) {
      const message = extractErrorMessage(err);
      errors.push(`${engine}: ${message}`);
      if (isFatalProviderError(engine, message)) {
        markUtilityProviderUnavailable(engine, message);
      }
      log(options.logLabel, `${engine} utility failed: ${message}`);
    }
  }

  return { error: errors.join("; ") || "No utility provider available" };
}

async function runUtilityTextForEngine(
  engine: UtilityProvider,
  options: {
    prompt: string;
    cwd: string;
    sessionId?: string;
    logLabel: "TITLE_GEN" | "COMMIT_MSG_GEN";
    timeoutMs: number;
    claudeModel?: string;
    claudeExtraOptions?: Record<string, unknown>;
  },
): Promise<string> {
  if (engine === "acp") {
    if (!options.sessionId) throw new Error("ACP utility prompt requires an active session.");
    const { acpUtilityPrompt } = await import("../lib/acp-utility-prompt");
    const raw = await acpUtilityPrompt(options.sessionId, options.prompt);
    const text = firstNonEmptyLine(raw) ?? "";
    if (!text) throw new Error("empty result");
    return text;
  }

  if (engine === "codex") {
    const { getCodexSessionModel } = await import("./codex-sessions");
    const preferredModel = options.sessionId ? getCodexSessionModel(options.sessionId) : undefined;
    const { codexUtilityPrompt } = await import("../lib/codex-utility-prompt");
    const raw = await codexUtilityPrompt(options.prompt, options.cwd, options.logLabel, {
      timeoutMs: options.timeoutMs,
      model: preferredModel,
    });
    const text = firstNonEmptyLine(raw) ?? "";
    if (!text) throw new Error("empty result");
    return text;
  }

  if (engine === "copilot") {
    const { getCopilotSessionModel } = await import("./copilot-sessions");
    const preferredModel = options.sessionId ? getCopilotSessionModel(options.sessionId) : undefined;
    const { copilotUtilityPrompt } = await import("../lib/copilot-utility-prompt");
    const raw = await copilotUtilityPrompt(options.prompt, options.cwd, options.logLabel, {
      timeoutMs: options.timeoutMs,
      model: preferredModel,
    });
    const text = firstNonEmptyLine(raw) ?? "";
    if (!text) throw new Error("empty result");
    return text;
  }

  const { result, error } = await oneShotSdkQuery(options.prompt, options.cwd, options.logLabel, {
    timeoutMs: options.timeoutMs,
    model: options.claudeModel ?? "haiku",
    extraOptions: options.claudeExtraOptions,
  });
  if (!result) throw new Error(error ?? "empty result");
  return result;
}

export function register(): void {
  ipcMain.handle("claude:generate-title", async (_event, {
    message,
    cwd,
    engine,
    sessionId,
  }: {
    message: string;
    cwd?: string;
    engine?: "claude" | "acp" | "codex" | "copilot";
    sessionId?: string; // ACP internalId when engine === "acp"
  }) => {
    const truncatedMsg = message.length > 500 ? message.slice(0, 500) + "..." : message;
    const prompt = `Generate a very short title (3-7 words) for a chat that starts with this message. Reply with ONLY the title, no quotes, no punctuation at the end.\n\nMessage: ${truncatedMsg}`;

    log("TITLE_GEN", `engine=${engine ?? "claude"} session=${sessionId?.slice(0, 8) ?? "none"} msg="${truncatedMsg.slice(0, 80)}..."`);

    const result = await runUtilityTextWithFallback({
      prompt,
      cwd: cwd || process.cwd(),
      requestedEngine: engine,
      sessionId: engine && engine !== "claude" ? sessionId : undefined,
      logLabel: "TITLE_GEN",
      timeoutMs: 20000,
      claudeModel: "haiku",
    });
    return { title: result.text, error: result.error };
  });

  ipcMain.handle("git:generate-commit-message", async (_event, {
    cwd,
    engine,
    sessionId,
  }: {
    cwd: string;
    engine?: "claude" | "acp" | "codex" | "copilot";
    sessionId?: string; // ACP internalId when engine === "acp"
  }) => {
    try {
      let diff = "";
      let diffSource: "staged" | "working" | "status" | "none" = "none";
      try {
        diff = (await gitExec(["diff", "--staged"], cwd)).trim();
        if (diff) diffSource = "staged";
      } catch {
        diff = "";
      }
      if (!diff) {
        try {
          diff = (await gitExec(["diff"], cwd)).trim();
          if (diff) diffSource = "working";
        } catch {
          diff = "";
        }
      }
      if (!diff) {
        try {
          diff = (await gitExec(["status", "--short"], cwd)).trim();
          if (diff) diffSource = "status";
        } catch {
          diff = "";
        }
      }
      if (!diff) return { error: "No changes to describe" };

      const maxChars = 500000;
      const truncated = diff.length > maxChars ? diff.slice(0, maxChars) + "\n... (truncated)" : diff;

      const prompt = `Generate a commit message for the following diff. Follow any CLAUDE.md instructions for commit message format and style. Reply with ONLY the commit message, nothing else.\n\n${truncated}`;

      log(
        "COMMIT_MSG_GEN",
        `engine=${engine ?? "claude"} diff_chars=${diff.length} diff_source=${diffSource} cwd=${cwd}`,
      );

      const result = await runUtilityTextWithFallback({
        prompt,
        cwd,
        requestedEngine: engine,
        sessionId: engine && engine !== "claude" ? sessionId : undefined,
        logLabel: "COMMIT_MSG_GEN",
        timeoutMs: 60000,
        claudeModel: "haiku",
        claudeExtraOptions: {
          systemPrompt: { type: "preset", preset: "claude_code" },
          settingSources: ["project", "user", "local"],
        },
      });
      return { message: result.text, error: result.error };
    } catch (err) {
      const errMsg = reportError("COMMIT_MSG_GEN_ERR", err, { context: "spawn" });
      return { error: errMsg };
    }
  });
}
