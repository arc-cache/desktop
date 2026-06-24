import { spawn } from "node:child_process";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { resolve } from "node:path";

import { loadMemoryEvents } from "./ledger.js";
import { PANEL_HTML } from "./panel-html.js";
import { cacheDir, memoryEventsPath, memoryPath, workspaceRoot } from "./paths.js";
import { buildInjectionPlan } from "./retrieval.js";
import { debug, loadCapsules, updateCapsuleMetadata } from "./store.js";

export interface PanelOptions {
  workspace?: string;
  port?: number;
  host?: string;
}

export interface PanelHandle {
  url: string;
  port: number;
  server: Server;
  close(): Promise<void>;
}

const DEFAULT_PORT = 4517;

export async function startPanel(options: PanelOptions = {}): Promise<PanelHandle> {
  const workspace = options.workspace ?? workspaceRoot();
  const host = options.host ?? "127.0.0.1";
  const server = createServer((request, response) => {
    handleRequest(request, response, workspace).catch((error) => {
      sendJson(response, 500, { error: error instanceof Error ? error.message : String(error) });
    });
  });
  const requested = options.port ?? DEFAULT_PORT;
  const port = await listen(server, host, requested);
  const url = `http://${host}:${port}/`;
  await debug("panel.started", { url, workspace }, workspace);
  return {
    url,
    port,
    server,
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  };
}

export async function runPanel(args: string[], workspace: string): Promise<number> {
  const portFlag = args.indexOf("--port");
  const port = portFlag >= 0 ? Number(args[portFlag + 1]) : undefined;
  if (portFlag >= 0 && (!Number.isInteger(port) || port! < 0 || port! > 65535)) {
    throw new Error("Usage: arc panel [--port <number>] [--no-open]");
  }
  const handle = await startPanel({ workspace, port });
  console.log(`ARC memory panel: ${handle.url}`);
  console.log(`workspace: ${workspace}`);
  console.log("Press Ctrl+C to stop.");
  if (!args.includes("--no-open") && process.platform === "darwin") {
    spawn("open", [handle.url], { stdio: "ignore", detached: true }).unref();
  }
  await new Promise<void>((resolve) => {
    process.once("SIGINT", () => resolve());
    process.once("SIGTERM", () => resolve());
  });
  await handle.close();
  return 0;
}

async function handleRequest(request: IncomingMessage, response: ServerResponse, workspace: string): Promise<void> {
  const url = new URL(request.url ?? "/", "http://localhost");
  const path = url.pathname;
  const requestWorkspace = workspaceForRequest(url, workspace);
  // The ARC app renderer fetches this API from its own origin; the server only
  // listens on loopback and serves per-repo memory, so a wide-open CORS policy
  // exposes nothing that local processes could not already read from disk.
  if (request.method === "OPTIONS") {
    response.writeHead(204, {
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET, POST, OPTIONS",
      "access-control-allow-headers": "content-type"
    });
    response.end();
    return;
  }
  if (request.method === "GET" && (path === "/" || path === "/index.html")) {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    response.end(PANEL_HTML);
    return;
  }
  if (request.method === "GET" && path === "/api/status") {
    const [capsules, events] = await Promise.all([loadCapsules(requestWorkspace), loadMemoryEvents(requestWorkspace)]);
    sendJson(response, 200, {
      workspace: requestWorkspace,
      cacheDir: cacheDir(requestWorkspace),
      memoryPath: memoryPath(requestWorkspace),
      memoryEventsPath: memoryEventsPath(requestWorkspace),
      capsuleCount: capsules.length,
      eventCount: events.length,
      generatedAt: new Date().toISOString()
    });
    return;
  }
  if (request.method === "GET" && path === "/api/capsules") {
    sendJson(response, 200, { capsules: await loadCapsules(requestWorkspace) });
    return;
  }
  if (request.method === "GET" && path === "/api/events") {
    const limit = boundedLimit(url.searchParams.get("limit"));
    const events = await loadMemoryEvents(requestWorkspace);
    sendJson(response, 200, { total: events.length, events: events.slice(-limit).reverse() });
    return;
  }
  if (request.method === "GET" && path === "/api/probe") {
    const prompt = (url.searchParams.get("prompt") ?? "").trim();
    if (!prompt) {
      sendJson(response, 400, { error: "Missing prompt query parameter" });
      return;
    }
    sendJson(response, 200, await probeInjection(prompt, requestWorkspace));
    return;
  }
  if (request.method === "POST" && path.startsWith("/api/capsules/")) {
    const id = decodeURIComponent(path.slice("/api/capsules/".length));
    const body = await readJsonBody(request);
    const patch: Record<string, unknown> = {};
    if (typeof body.status === "string") patch.status = body.status;
    if (typeof body.privacyLabel === "string") patch.privacyLabel = body.privacyLabel;
    if (!Object.keys(patch).length) {
      sendJson(response, 400, { error: "Provide status and/or privacyLabel" });
      return;
    }
    const updated = await updateCapsuleMetadata(id, patch, requestWorkspace);
    if (!updated) {
      sendJson(response, 404, { error: `No capsule matches ${id}` });
      return;
    }
    sendJson(response, 200, { capsule: updated });
    return;
  }
  sendJson(response, 404, { error: `Not found: ${request.method} ${path}` });
}

function workspaceForRequest(url: URL, fallback: string): string {
  const requested = url.searchParams.get("workspace")?.trim();
  return requested ? resolve(requested) : fallback;
}

// The probe is a fast local "what would inject for this prompt" check; the
// strong-model consult is forced off so it never burns quota or blocks the UI.
async function probeInjection(prompt: string, workspace: string) {
  const previous = process.env.AGENT_RUN_CACHE_MODEL_SIDECAR;
  process.env.AGENT_RUN_CACHE_MODEL_SIDECAR = "off";
  try {
    return await buildInjectionPlan(prompt, workspace);
  } finally {
    if (previous === undefined) delete process.env.AGENT_RUN_CACHE_MODEL_SIDECAR;
    else process.env.AGENT_RUN_CACHE_MODEL_SIDECAR = previous;
  }
}

function boundedLimit(value: string | null): number {
  const limit = Number(value ?? 200);
  if (!Number.isFinite(limit) || limit <= 0) return 200;
  return Math.min(Math.floor(limit), 2000);
}

async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > 1024 * 1024) throw new Error("Request body too large");
    chunks.push(chunk as Buffer);
  }
  if (!chunks.length) return {};
  const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Expected a JSON object body");
  return parsed as Record<string, unknown>;
}

function sendJson(response: ServerResponse, status: number, payload: unknown): void {
  if (response.headersSent) {
    response.end();
    return;
  }
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "access-control-allow-origin": "*"
  });
  response.end(JSON.stringify(payload));
}

async function listen(server: Server, host: string, port: number): Promise<number> {
  try {
    return await listenOnce(server, host, port);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (port !== 0 && (code === "EADDRINUSE" || code === "EACCES")) {
      return listenOnce(server, host, 0);
    }
    throw error;
  }
}

function listenOnce(server: Server, host: string, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      server.removeListener("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.removeListener("error", onError);
      resolve((server.address() as AddressInfo).port);
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });
}
