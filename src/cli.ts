#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { importCopilotOtel, importCopilotTranscript, launchCopilot, harvestSession } from "./copilot.js";
import { runAcpProxy } from "./acp.js";
import { runAsk } from "./ask.js";
import { runPanel } from "./panel.js";
import { reviewEvents } from "./review.js";
import { runAppDev, runStart } from "./start.js";
import { writeDebugBundle } from "./bundle.js";
import { buildInjectionPlan } from "./retrieval.js";
import { loadCapsules, saveCapsule } from "./store.js";
import { handleCopilotHook } from "./hooks.js";
import { workspaceRoot, cacheDir, appCacheDir, desktopStatePaths, copilotTranscriptPath, debugPath } from "./paths.js";

const [command, ...args] = process.argv.slice(2);

try {
  if (!command || command === "help" || command === "--help" || command === "-h") {
    printHelp();
  } else if (command === "ask") {
    process.exit(await runAsk(args, workspaceRoot()));
  } else if (command === "start") {
    process.exit(await runStart(args, workspaceRoot()));
  } else if (command === "app-dev") {
    process.exit(await runAppDev(args, workspaceRoot()));
  } else if (command === "acp") {
    process.exit(await runAcpProxy(args));
  } else if (command === "panel") {
    process.exit(await runPanel(args, workspaceRoot()));
  } else if (command === "copilot") {
    process.exit(await launchCopilot(args));
  } else if (command === "hook") {
    const runner = args[0];
    const hookName = args[1] ?? "Unknown";
    if (runner !== "copilot") throw new Error("Only Copilot hooks are supported in this rewrite.");
    console.log(JSON.stringify(await handleCopilotHook(hookName)));
  } else if (command === "consult" || command === "inject") {
    const prompt = args.join(" ");
    console.log(JSON.stringify(await buildInjectionPlan(prompt, workspaceRoot()), null, 2));
  } else if (command === "import-copilot") {
    const path = args[0];
    if (!path) throw new Error("Usage: arc import-copilot <events.jsonl>");
    if (!existsSync(path)) throw new Error(`Input file not found: ${path}`);
    const events = await importCopilotTranscript(path);
    const sessionId = events[0]?.sessionId ?? randomUUID();
    await reviewEvents(events, workspaceRoot(), sessionId);
    console.log(`imported and reviewed ${events.length} events from ${path}`);
  } else if (command === "import-otel") {
    const path = args[0];
    if (!path) throw new Error("Usage: arc import-otel <otel.jsonl>");
    if (!existsSync(path)) throw new Error(`Input file not found: ${path}`);
    const fallbackSessionId = args[1] ?? randomUUID();
    const events = await importCopilotOtel(path, workspaceRoot(), fallbackSessionId);
    const sessionId = events[0]?.sessionId ?? fallbackSessionId;
    await reviewEvents(events, workspaceRoot(), sessionId);
    console.log(`imported and reviewed ${events.length} OTel-derived events from ${path}`);
  } else if (command === "harvest") {
    const sessionId = args[0];
    if (!sessionId) throw new Error("Usage: arc harvest <copilot-session-id>");
    const harvested = await harvestSession(sessionId);
    if (!harvested) throw new Error(`No Copilot transcript or OTel data found for session: ${sessionId}`);
    console.log(`harvested ${sessionId}`);
  } else if (command === "doctor") {
    await doctor();
  } else if (command === "reset") {
    await reset(args);
  } else if (command === "debug-bundle") {
    const result = await writeDebugBundle(args[0]);
    console.log(`wrote redacted debug bundle to ${result.path}`);
    console.log(`files: ${result.fileCount}, traces: ${result.traceCount}`);
  } else if (command === "smoke") {
    await smoke();
  } else if (command === "logs") {
    await logs(args);
  } else if (command === "setup") {
    console.log("Use the clone-first setup: npm install, npm run app:install, npm run build, npm run app:build, then npm run app:start.");
  } else {
    throw new Error(`Unknown command: ${command}`);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

async function logs(args: string[]): Promise<void> {
  const workspace = workspaceRoot();
  const file = debugPath(workspace);
  const follow = args.includes("--follow") || args.includes("-f");
  let offset = 0;
  while (true) {
    if (existsSync(file)) {
      const text = await readFile(file, "utf8");
      const next = text.slice(offset);
      offset = text.length;
      for (const line of next.split(/\r?\n/).filter(Boolean)) {
        console.log(formatLogLine(line));
      }
    }
    if (!follow) break;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

function formatLogLine(line: string): string {
  try {
    const record = JSON.parse(line) as { timestamp?: string; action?: string; details?: Record<string, unknown> };
    const time = record.timestamp ? record.timestamp.slice(11, 19) : "--:--:--";
    const action = record.action ?? "event";
    const details = record.details ? summarizeDetails(record.details) : "";
    return `[${time}] ${action}${details ? ` ${details}` : ""}`;
  } catch {
    return line;
  }
}

function summarizeDetails(details: Record<string, unknown>): string {
  const keep = ["sessionId", "reason", "source", "status", "currentGoal", "possibleReusableWork", "title", "eventCount", "total", "newEvents", "sidecarCalls"];
  const compact: Record<string, unknown> = {};
  for (const key of keep) {
    if (details[key] !== undefined) compact[key] = details[key];
  }
  return Object.keys(compact).length ? JSON.stringify(compact) : "";
}

function printHelp(): void {
  console.log(`Agent Run Cache

Usage:
  arc acp
  arc start
  arc start --provider ollama --model gemma4:31b-cloud
  arc app-dev --provider ollama --model gemma4:31b-cloud
  arc panel [--port <number>] [--no-open]
  arc reset --yes

arc acp runs ARC as an Agent Client Protocol middleware over \`copilot --acp\`. Point any ACP client (ARC desktop, Zed, JetBrains, acp-ui) at \`arc acp\` as its agent command: prompts get ARC memory injected, every turn is captured, the deterministic observer gates review, and capsules are saved automatically.

arc start opens the locally built ARC desktop workbench with the same memory engine. arc app-dev is the CLI-backed watch-mode launcher used by npm run app:dev.

arc panel serves this repo's memory in the browser: a capsule browser, the memory-event ledger, and a probe that shows what would be injected for a given prompt.

Developer/import commands still exist for captured traces, tests, and diagnostics, but they are not the normal product path.`);
}

async function reset(args: string[]): Promise<void> {
  if (!args.includes("--yes")) {
    throw new Error("Refusing to reset without confirmation. Run `arc reset --yes` to remove ARC workspace and app caches.");
  }
  const workspace = workspaceRoot();
  const targets = [
    { label: "workspace cache", path: cacheDir(workspace) },
    { label: "app cache", path: appCacheDir() },
    ...desktopStatePaths().map((path) => ({ label: "desktop state", path }))
  ];
  const removed: typeof targets = [];
  for (const target of targets) {
    const existed = existsSync(target.path);
    await rm(target.path, { recursive: true, force: true });
    if (existed) removed.push(target);
  }
  console.log("ARC reset complete");
  for (const target of removed) {
    console.log(`removed ${target.label}: ${target.path}`);
  }
  if (removed.length === 0) console.log("nothing existed on disk");
  console.log("If ARC is open, quit and reopen it so the sidebar reloads from disk.");
}

async function doctor(): Promise<void> {
  const workspace = workspaceRoot();
  const capsules = await loadCapsules(workspace);
  console.log("Agent Run Cache doctor");
  console.log(`[OK] workspace: ${workspace}`);
  console.log(`[OK] cache: ${cacheDir(workspace)}`);
  console.log(`[OK] capsules: ${capsules.length}`);
  console.log(`[INFO] copilot transcript example: ${copilotTranscriptPath("<session-id>")}`);
  const sidecar = process.env.AGENT_RUN_CACHE_MODEL_SIDECAR || "auto";
  console.log(`[INFO] sidecar: ${sidecar === "off" ? "off" : `${sidecar} (same-runner by default) unless AGENT_RUN_CACHE_REVIEWER_COMMAND is set`}`);
}

async function smoke(): Promise<void> {
  const workspace = workspaceRoot();
  // Run against an isolated temp cache so smoke never writes to the caller's
  // ./.agent-run-cache/ (which the ARC desktop app reads on launch).
  const previousCacheDir = process.env.AGENT_RUN_CACHE_DIR;
  const tempCache = await mkdtemp(join(tmpdir(), "arc-smoke-"));
  process.env.AGENT_RUN_CACHE_DIR = tempCache;
  try {
    await runSmoke(workspace);
  } finally {
    if (previousCacheDir === undefined) delete process.env.AGENT_RUN_CACHE_DIR;
    else process.env.AGENT_RUN_CACHE_DIR = previousCacheDir;
    await rm(tempCache, { recursive: true, force: true });
  }
}

async function runSmoke(workspace: string): Promise<void> {
  await saveCapsule({
    runner: "copilot",
    workspace,
    sourceSessionId: "smoke",
    reusable: true,
    confidence: 0.99,
    title: "Smoke test folder workflow",
    summary: "For test folder orientation, inspect the test directory before broad rediscovery.",
    reuseWhen: ["test folder", "public regression test", "what is in the test folder"],
    doNotReuseWhen: ["the user asks for current test results"],
    nextRunInstruction: "List the test directory and inspect the focused public test file before broad rediscovery.",
    evidence: ["offline smoke capsule"],
    provenance: [],
    workflow: {
      purpose: "Orient a future agent on the test folder.",
      parameters: ["current test folder name"],
      bindingSources: ["test/"],
      steps: ["List test/.", "Read the focused public test file if present.", "Only run tests if user asks for results."],
      commands: ["ls test"],
      successCriteria: ["The test folder contents are identified."],
      failedAttempts: [],
      validationProbe: ["Check that test/ still exists."]
    }
  }, workspace);
  const previous = process.env.AGENT_RUN_CACHE_MODEL_SIDECAR;
  process.env.AGENT_RUN_CACHE_MODEL_SIDECAR = "off";
  try {
    const plan = await buildInjectionPlan("what is in the test folder", workspace);
    console.log(`smoke: ${plan.shouldInject ? "injection yes" : "injection no"} (${plan.reason})`);
  } finally {
    if (previous === undefined) delete process.env.AGENT_RUN_CACHE_MODEL_SIDECAR;
    else process.env.AGENT_RUN_CACHE_MODEL_SIDECAR = previous;
  }
}
