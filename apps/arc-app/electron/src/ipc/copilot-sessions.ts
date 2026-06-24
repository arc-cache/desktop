/**
 * Native Copilot IPC handler.
 *
 * This bridges the desktop app to ARC's Copilot SDK app-server. The server
 * speaks the same item-based protocol shape as Codex, so the renderer can reuse
 * the Codex UI adapter while keeping Copilot as a first-class native engine.
 */

import { BrowserWindow, ipcMain } from "electron";
import { spawn, spawnSync } from "child_process";
import crypto from "crypto";
import path from "path";
import { log } from "../lib/logger";
import { safeSend } from "../lib/safe-send";
import { CodexRpcClient } from "../lib/codex-rpc";
import { reportError } from "../lib/error-utils";
import { captureEvent } from "../lib/local-events";
import { beginArcTurn, finishArcTurn, recordCodexLikeNotification } from "../lib/arc-host";
import { childProcessEnv, electronNodeEnv } from "../lib/electron-node";
import { getArcRuntimeCandidates, resolveArcAppServerPath } from "../lib/arc-runtime";
import {
  isFatalProviderError,
  markUtilityProviderUnavailable,
} from "../lib/provider-health";
import { isSupportedServerRequestMethod, pickModelId } from "@shared/lib/codex-helpers";

import type {
  CodexServerNotification,
  CodexModel,
  CodexModelListResponse,
  CodexAccountResponse,
  CodexThreadStartResponse,
  CodexThreadResumeResponse,
  CodexTurnStartResponse,
  CodexInitializeResponse,
  CodexItemStartedNotification,
  CodexItemCompletedNotification,
} from "@shared/types/codex";

interface CopilotSession {
  rpc: CodexRpcClient;
  internalId: string;
  threadId: string | null;
  activeTurnId: string | null;
  eventCounter: number;
  cwd: string;
  model?: string;
  approvalPolicy?: string;
  sandbox?: string;
  fatalFailureReason?: string;
}

type CopilotAccountResponse = CodexAccountResponse & {
  authMode?: "copilot" | "ollama";
  authError?: string;
  authGuidance?: string;
  quotaExceeded?: boolean;
  quotaMessage?: string;
  copilotAuthStatus?: {
    isAuthenticated?: boolean;
    statusMessage?: string;
    login?: string;
    host?: string;
  };
};

const copilotSessions = new Map<string, CopilotSession>();

function isCopilotQuotaText(message: string | undefined): boolean {
  return /quota|quota_exceeded|402|used all .*copilot.*requests|copilot free chat requests|chat requests for the month|upgrade your plan for access to premium models/i.test(message ?? "");
}

export function getCopilotSessionModel(internalId: string): string | undefined {
  return copilotSessions.get(internalId)?.model;
}

function getArcAppServerPath(): string {
  const serverPath = resolveArcAppServerPath({ fromDir: __dirname });
  if (!serverPath) {
    throw new Error(`ARC app-server not found. Tried: ${getArcRuntimeCandidates({ fromDir: __dirname }).map((candidate) => path.join(candidate, "app-server.js")).join(", ")}`);
  }
  return serverPath;
}

function spawnCopilotAppServer(cwd: string) {
  const serverPath = getArcAppServerPath();
  return spawn(process.execPath, [serverPath], {
    stdio: ["pipe", "pipe", "pipe"],
    cwd,
    env: electronNodeEnv({
      ARC_APP_MEMORY: "off",
      ARC_APP_RUNNER: "copilot",
      RUST_LOG: process.env.RUST_LOG ?? "warn",
    }),
  });
}

function shortId(value: unknown, length = 8): string {
  return typeof value === "string" ? value.slice(0, length) : "n/a";
}

function shouldLogFullToolEvent(
  method: string,
  params: CodexItemStartedNotification | CodexItemCompletedNotification,
): boolean {
  if (method !== "item/started" && method !== "item/completed") return false;
  const { item } = params;
  return (
    item.type === "commandExecution" ||
    item.type === "fileChange" ||
    item.type === "mcpToolCall" ||
    item.type === "webSearch" ||
    item.type === "imageView"
  );
}

function summarizeNotification(notification: CodexServerNotification): string {
  switch (notification.method) {
    case "turn/started":
      return `turn/started turn=${shortId(notification.params.turn.id, 12)}`;
    case "turn/completed": {
      const { turn } = notification.params;
      return `turn/completed turn=${shortId(turn.id, 12)} status=${turn.status}`;
    }
    case "item/started":
    case "item/completed": {
      const { item } = notification.params;
      const status = "status" in item ? ` status=${item.status}` : "";
      const cmd = "command" in item ? ` cmd="${String(item.command).split("\n")[0].slice(0, 80)}"` : "";
      return `${notification.method} type=${item.type} id=${shortId(item.id, 12)}${status}${cmd}`;
    }
    case "item/agentMessage/delta":
      return `item/agentMessage/delta id=${shortId(notification.params.itemId, 12)} len=${notification.params.delta.length}`;
    case "item/commandExecution/outputDelta":
      return `item/commandExecution/outputDelta id=${shortId(notification.params.itemId, 12)} len=${notification.params.delta.length}`;
    case "error":
      return `error message="${notification.params.error.message.slice(0, 180)}"`;
    default:
      return notification.method;
  }
}

function runtimeParams(): Record<string, unknown> | undefined {
  const provider = process.env.ARC_APP_PROVIDER?.trim();
  const model = process.env.ARC_APP_MODEL?.trim();
  const providerBaseUrl = process.env.ARC_APP_PROVIDER_BASE_URL?.trim() || process.env.ARC_APP_BASE_URL?.trim();
  if (!provider && !model && !providerBaseUrl) return undefined;
  return {
    ...(provider ? { provider } : {}),
    ...(model ? { model } : {}),
    ...(providerBaseUrl ? { providerBaseUrl } : {}),
  };
}

function needsCopilotAuth(account: CopilotAccountResponse | null | undefined): boolean {
  if (!account || account.authMode === "ollama") return false;
  if (account.quotaExceeded || isCopilotQuotaText(account.quotaMessage) || isCopilotQuotaText(account.authError)) return false;
  if (account.requiresOpenaiAuth) return true;
  if (account.authError) return true;
  return account.copilotAuthStatus?.isAuthenticated === false;
}

function copilotAuthFailureMessage(account: CopilotAccountResponse | null | undefined): string {
  return account?.authGuidance
    || account?.authError
    || account?.copilotAuthStatus?.statusMessage
    || "Copilot is not signed in for this machine. Run `copilot` in a terminal and `/login`, then retry. On Linux, run that inside the Linux user account that launches ARC.";
}

function setupCopilotHandlers(
  rpc: CodexRpcClient,
  session: CopilotSession,
  internalId: string,
  getMainWindow: () => BrowserWindow | null,
): void {
  rpc.onStderr = (text) => {
    log("copilot", `[stderr:${internalId.slice(0, 8)}] ${text.slice(0, 500)}`);
  };

  rpc.onNotification = (msg) => {
    const notification = msg as CodexServerNotification;
    session.eventCounter++;
    log("copilot", `[evt:${internalId.slice(0, 8)}] #${session.eventCounter} ${summarizeNotification(notification)}`);
    if (
      (notification.method === "item/started" || notification.method === "item/completed") &&
      shouldLogFullToolEvent(notification.method, notification.params)
    ) {
      log("COPILOT_EVENT_FULL", {
        session: internalId.slice(0, 8),
        method: notification.method,
        item: notification.params.item,
      });
    }

    if (notification.method === "error") {
      const message = notification.params.error.message;
      if (isFatalProviderError("copilot", message)) {
        session.fatalFailureReason = message;
        markUtilityProviderUnavailable("copilot", message);
      }
    }

    if (notification.method === "turn/started") {
      session.activeTurnId = notification.params.turn.id;
    } else if (notification.method === "turn/completed") {
      session.activeTurnId = null;
    }
    recordCodexLikeNotification("copilot", internalId, notification, (notice) => {
      safeSend(getMainWindow, "copilot:event", {
        _sessionId: internalId,
        method: "arc/memory",
        params: notice,
      });
    });

    safeSend(getMainWindow, "copilot:event", {
      _sessionId: internalId,
      method: notification.method,
      params: notification.params,
    });

    if (
      notification.method === "turn/completed" &&
      notification.params.turn.status === "failed" &&
      session.fatalFailureReason
    ) {
      setImmediate(() => {
        if (copilotSessions.get(internalId) !== session) return;
        log("copilot", `Closing fatal failed session ${internalId}: ${session.fatalFailureReason}`);
        session.rpc.destroy();
        copilotSessions.delete(internalId);
      });
    }
  };

  rpc.onServerRequest = (msg) => {
    log("copilot", `[srvreq:${internalId.slice(0, 8)}] ${msg.method} id=${msg.id}`);
    if (isSupportedServerRequestMethod(msg.method)) {
      safeSend(getMainWindow, "copilot:approval_request", {
        _sessionId: internalId,
        rpcId: msg.id,
        method: msg.method,
        ...(msg.params as Record<string, unknown>),
      });
    } else {
      rpc.respondToServerError(msg.id, -32601, `Unsupported server request: ${msg.method}`);
    }
  };

  rpc.onExit = (code, signal) => {
    log("copilot", `Process exited: code=${code} signal=${signal} session=${internalId}`);
    void finishArcTurn("copilot", internalId, "failed").then((notice) => {
      if (!notice) return;
      safeSend(getMainWindow, "copilot:event", {
        _sessionId: internalId,
        method: "arc/memory",
        params: notice,
      });
    });
    session.activeTurnId = null;
    copilotSessions.delete(internalId);
    safeSend(getMainWindow, "copilot:exit", {
      _sessionId: internalId,
      code,
      signal,
    });
  };
}

async function initializeSession(
  internalId: string,
  cwd: string,
  getMainWindow: () => BrowserWindow | null,
  options: { readAccount?: boolean } = {},
): Promise<{ rpc: CodexRpcClient; session: CopilotSession; account: CopilotAccountResponse | null }> {
  const proc = spawnCopilotAppServer(cwd);
  if (!proc.pid) throw new Error("Failed to spawn ARC Copilot app-server process");
  log("copilot", `Spawned app-server pid=${proc.pid} session=${internalId}`);

  const rpc = new CodexRpcClient(proc, { processLabel: "Copilot" });
  const session: CopilotSession = {
    rpc,
    internalId,
    threadId: null,
    activeTurnId: null,
    eventCounter: 0,
    cwd,
  };
  copilotSessions.set(internalId, session);
  setupCopilotHandlers(rpc, session, internalId, getMainWindow);

  await rpc.request<CodexInitializeResponse>("initialize", {
    clientInfo: { name: "ARC", title: "ARC", version: "1.0.0" },
    capabilities: { experimentalApi: true },
  });
  rpc.notify("initialized", {});
  const account = options.readAccount === false
    ? null
    : await rpc.request<CopilotAccountResponse>("account/read", { refreshToken: false, cwd });
  return { rpc, session, account };
}

export function register(getMainWindow: () => BrowserWindow | null): void {
  ipcMain.on("copilot:log", (_event, label: string, data: unknown) => {
    log(`COPILOT_UI:${label}`, data);
  });

  ipcMain.handle(
    "copilot:start",
    async (
      _,
      options: {
        cwd: string;
        model?: string;
        approvalPolicy?: string;
        sandbox?: "read-only" | "workspace-write" | "danger-full-access";
      },
    ) => {
      const internalId = crypto.randomUUID();
      try {
        const { rpc, session, account } = await initializeSession(internalId, options.cwd, getMainWindow);
        if (needsCopilotAuth(account)) {
          const error = copilotAuthFailureMessage(account);
          session.rpc.destroy();
          copilotSessions.delete(internalId);
          return { error, needsAuth: true, account };
        }
        if (account?.quotaExceeded || isCopilotQuotaText(account?.quotaMessage) || isCopilotQuotaText(account?.authError)) {
          const error = account?.quotaMessage || account?.authError || "Copilot quota is unavailable for this account.";
          markUtilityProviderUnavailable("copilot", error);
          session.rpc.destroy();
          copilotSessions.delete(internalId);
          return { error, needsAuth: false, quotaExceeded: true, account };
        }
        session.approvalPolicy = options.approvalPolicy;
        session.sandbox = options.sandbox;

        let models: CodexModel[] = [];
        let selectedModel: string | undefined;
        try {
          const modelResult = await rpc.request<CodexModelListResponse>("model/list", { includeHidden: false });
          models = modelResult.data ?? [];
          selectedModel = pickModelId(options.model, models);
          if (selectedModel) session.model = selectedModel;
        } catch (err) {
          reportError("COPILOT_MODEL_LIST_ERR", err, { engine: "copilot", sessionId: internalId });
        }

        const threadParams: Record<string, unknown> = {
          cwd: options.cwd,
          experimentalRawEvents: false,
          persistExtendedHistory: false,
        };
        if (selectedModel) threadParams.model = selectedModel;
        if (options.approvalPolicy) threadParams.approvalPolicy = options.approvalPolicy;
        if (options.sandbox) threadParams.sandbox = options.sandbox;

        const threadResult = await rpc.request<CodexThreadStartResponse>("thread/start", threadParams);
        session.threadId = threadResult.thread.id;

        void captureEvent("session_created", { engine: "copilot", model: selectedModel });
        return {
          sessionId: internalId,
          threadId: session.threadId,
          models,
          selectedModel,
          account,
          needsAuth: false,
        };
      } catch (err) {
        void captureEvent("session_error", { engine: "copilot", phase: "start" });
        const errMsg = reportError("COPILOT_START_ERR", err, { engine: "copilot", sessionId: internalId });
        const session = copilotSessions.get(internalId);
        if (session) {
          session.rpc.destroy();
          copilotSessions.delete(internalId);
        }
        return { error: errMsg };
      }
    },
  );

  ipcMain.handle(
    "copilot:send",
    async (
      _,
      data: {
        sessionId: string;
        text: string;
        images?: Array<{ type: "image"; url: string } | { type: "localImage"; path: string }>;
        effort?: string;
      },
    ) => {
      const session = copilotSessions.get(data.sessionId);
      if (!session) return { error: "Copilot session not found" };
      if (!session.threadId) {
        try {
          const threadResult = await session.rpc.request<CodexThreadStartResponse>("thread/start", {
            cwd: session.cwd,
            experimentalRawEvents: false,
            persistExtendedHistory: false,
          });
          session.threadId = threadResult.thread.id;
        } catch (err) {
          return { error: reportError("COPILOT_THREAD_START_ERR", err, { engine: "copilot", sessionId: data.sessionId }) };
        }
      }

      let arcTurnStarted = false;
      try {
        const arc = await beginArcTurn({
          engine: "copilot",
          sessionId: data.sessionId,
          cwd: session.cwd,
          prompt: data.text,
        });
        arcTurnStarted = !!arc.turnId;
        const input: unknown[] = [{ type: "text", text: arc.prompt }];
        if (data.images) input.push(...data.images);
        const runtime = runtimeParams();
        const turnParams: Record<string, unknown> = {
          threadId: session.threadId,
          input,
          ...(session.model ? { model: session.model } : {}),
          ...(data.effort ? { effort: data.effort } : {}),
          ...(session.approvalPolicy ? { approvalPolicy: session.approvalPolicy } : {}),
          ...(session.sandbox ? { sandbox: session.sandbox, sandboxPolicy: { type: session.sandbox } } : {}),
          ...(runtime ? { runtime } : {}),
        };
        const result = await session.rpc.request<CodexTurnStartResponse>("turn/start", turnParams);
        session.activeTurnId = result.turn.id;
        return { turnId: result.turn.id };
      } catch (err) {
        const message = reportError("COPILOT_SEND_ERR", err, { engine: "copilot", sessionId: data.sessionId });
        if (arcTurnStarted && !session.activeTurnId) {
          await finishArcTurn("copilot", data.sessionId, "failed").catch(() => undefined);
        }
        if (isFatalProviderError("copilot", message)) {
          session.fatalFailureReason = message;
          markUtilityProviderUnavailable("copilot", message);
          session.rpc.destroy();
          copilotSessions.delete(data.sessionId);
        }
        return { error: message };
      }
    },
  );

  ipcMain.handle("copilot:stop", async (_, sessionId: string) => {
    const session = copilotSessions.get(sessionId);
    if (!session) return;
    session.rpc.destroy();
    copilotSessions.delete(sessionId);
  });

  ipcMain.handle("copilot:interrupt", async (_, sessionId: string) => {
    const session = copilotSessions.get(sessionId);
    if (!session?.threadId || !session.activeTurnId) return { error: "No active turn" };
    try {
      await session.rpc.request("turn/interrupt", {
        threadId: session.threadId,
        turnId: session.activeTurnId,
      });
      return {};
    } catch (err) {
      return { error: reportError("COPILOT_INTERRUPT_ERR", err, { engine: "copilot", sessionId }) };
    }
  });

  ipcMain.handle("copilot:approval_response", async (_, data: { sessionId: string; rpcId: string | number; decision: string; acceptSettings?: unknown }) => {
    const session = copilotSessions.get(data.sessionId);
    if (!session) return { error: "Session not found" };
    try {
      const result: Record<string, unknown> = { decision: data.decision };
      if (data.acceptSettings) result.acceptSettings = data.acceptSettings;
      session.rpc.respondToServer(data.rpcId, result);
      return { ok: true };
    } catch (err) {
      return { error: reportError("COPILOT_APPROVAL_RESPONSE_ERR", err, { engine: "copilot", sessionId: data.sessionId }) };
    }
  });

  ipcMain.handle("copilot:user_input_response", async (_, data: { sessionId: string; rpcId: string | number; answers: Record<string, { answers: string[] }> }) => {
    const session = copilotSessions.get(data.sessionId);
    if (!session) return { error: "Session not found" };
    try {
      session.rpc.respondToServer(data.rpcId, { answers: data.answers });
      return { ok: true };
    } catch (err) {
      return { error: reportError("COPILOT_USER_INPUT_RESPONSE_ERR", err, { engine: "copilot", sessionId: data.sessionId }) };
    }
  });

  ipcMain.handle("copilot:server_request_error", async (_, data: { sessionId: string; rpcId: string | number; code: number; message: string }) => {
    const session = copilotSessions.get(data.sessionId);
    if (!session) return { error: "Session not found" };
    try {
      session.rpc.respondToServerError(data.rpcId, data.code, data.message);
      return { ok: true };
    } catch (err) {
      return { error: reportError("COPILOT_SERVER_REQUEST_ERROR_ERR", err, { engine: "copilot", sessionId: data.sessionId }) };
    }
  });

  ipcMain.handle("copilot:compact", async (_, sessionId: string) => {
    const session = copilotSessions.get(sessionId);
    if (!session?.threadId) return { error: "No active thread" };
    try {
      await session.rpc.request("thread/compact/start", { threadId: session.threadId });
      return {};
    } catch (err) {
      return { error: reportError("COPILOT_COMPACT_ERR", err, { engine: "copilot", sessionId }) };
    }
  });

  ipcMain.handle("copilot:list-skills", async () => ({ skills: [] }));
  ipcMain.handle("copilot:list-apps", async () => ({ apps: [] }));

  ipcMain.handle("copilot:list-models", async () => {
    for (const session of copilotSessions.values()) {
      if (session.rpc.isAlive) {
        try {
          const result = await session.rpc.request<CodexModelListResponse>("model/list", { includeHidden: false });
          return { models: result.data ?? [] };
        } catch {
          continue;
        }
      }
    }
    const internalId = crypto.randomUUID();
    try {
      const { rpc } = await initializeSession(internalId, process.cwd(), getMainWindow, { readAccount: false });
      try {
        const result = await rpc.request<CodexModelListResponse>("model/list", { includeHidden: false });
        return { models: result.data ?? [] };
      } finally {
        rpc.destroy();
        copilotSessions.delete(internalId);
      }
    } catch (err) {
      return { models: [], error: reportError("COPILOT_MODELS_SPAWN_ERR", err, { engine: "copilot" }) };
    }
  });

  ipcMain.handle("copilot:auth-status", async () => {
    for (const session of copilotSessions.values()) {
      if (session.rpc.isAlive) {
        try {
          return await session.rpc.request("account/read", { refreshToken: false });
        } catch {
          continue;
        }
      }
    }
    const internalId = crypto.randomUUID();
    try {
      const { rpc, account } = await initializeSession(internalId, process.cwd(), getMainWindow);
      rpc.destroy();
      copilotSessions.delete(internalId);
      return account;
    } catch (err) {
      const session = copilotSessions.get(internalId);
      if (session) {
        session.rpc.destroy();
        copilotSessions.delete(internalId);
      }
      return {
        account: null,
        requiresOpenaiAuth: true,
        authMode: "copilot",
        authError: reportError("COPILOT_AUTH_STATUS_ERR", err, { engine: "copilot" }),
      };
    }
  });

  ipcMain.handle("copilot:login", async () => {
    return { error: "Copilot login is handled by the GitHub Copilot runtime. Run `copilot` in a terminal and `/login`, then retry ARC. On Linux, run that inside the Linux user account that launches ARC." };
  });

  ipcMain.handle("copilot:resume", async (_, data: { cwd: string; threadId: string; model?: string; approvalPolicy?: string; sandbox?: "read-only" | "workspace-write" | "danger-full-access" }) => {
    const internalId = crypto.randomUUID();
    try {
      const { rpc, session, account } = await initializeSession(internalId, data.cwd, getMainWindow);
      if (needsCopilotAuth(account)) {
        const error = copilotAuthFailureMessage(account);
        session.rpc.destroy();
        copilotSessions.delete(internalId);
        return { error, needsAuth: true };
      }
      session.model = data.model;
      session.approvalPolicy = data.approvalPolicy;
      session.sandbox = data.sandbox;
      const threadResult = await rpc.request<CodexThreadResumeResponse>("thread/resume", {
        threadId: data.threadId,
        persistExtendedHistory: false,
        ...(data.approvalPolicy ? { approvalPolicy: data.approvalPolicy } : {}),
        ...(data.sandbox ? { sandbox: data.sandbox } : {}),
      });
      session.threadId = threadResult.thread.id;
      void captureEvent("session_revived", { engine: "copilot", success: true });
      return { sessionId: internalId, threadId: session.threadId };
    } catch (err) {
      void captureEvent("session_revived", { engine: "copilot", success: false });
      const session = copilotSessions.get(internalId);
      if (session) {
        session.rpc.destroy();
        copilotSessions.delete(internalId);
      }
      return { error: reportError("COPILOT_RESUME_ERR", err, { engine: "copilot", sessionId: internalId }) };
    }
  });

  ipcMain.handle("copilot:set-model", async (_, data: { sessionId: string; model: string }) => {
    const session = copilotSessions.get(data.sessionId);
    if (!session) return { error: "Session not found" };
    session.model = data.model;
    return {};
  });

  ipcMain.handle("copilot:set-permission-mode", async (_, data: { sessionId: string; approvalPolicy?: string | null; sandbox?: string | null }) => {
    const session = copilotSessions.get(data.sessionId);
    if (!session) return { error: "Session not found" };
    session.approvalPolicy = data.approvalPolicy ?? undefined;
    session.sandbox = data.sandbox ?? undefined;
    return { ok: true };
  });

  ipcMain.handle("copilot:version", async () => {
    const command = process.env.AGENT_RUN_CACHE_COPILOT_BIN ?? "copilot";
    const result = spawnSync(command, ["--version"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], env: childProcessEnv() });
    return { version: result.status === 0 ? result.stdout.trim() : null };
  });

  ipcMain.handle("copilot:binary-status", async () => {
    const configured = process.env.AGENT_RUN_CACHE_COPILOT_COMMAND?.trim() || process.env.AGENT_RUN_CACHE_COPILOT_BIN?.trim();
    if (configured) return { installed: true, downloading: false };
    const result = spawnSync(process.platform === "win32" ? "where" : "which", ["copilot"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], env: childProcessEnv() });
    return { installed: result.status === 0, downloading: false };
  });
}

export function stopAll(): void {
  for (const [id, session] of copilotSessions) {
    session.rpc.destroy();
    copilotSessions.delete(id);
  }
}
