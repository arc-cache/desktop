#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const distAppServer = join(repoRoot, "dist", "app-server.js");

async function main() {
  const options = parseArgs(process.argv.slice(2));

  if (!existsSync(distAppServer)) {
    fail("dist/app-server.js is missing. Run `npm run build` before the live verifier.");
  }

  const ollamaCheck = spawnSync("ollama", ["--version"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
  if (ollamaCheck.status !== 0) {
    fail("ollama is not available on PATH. Install/start Ollama before running this verifier.");
  }

  const workspace = options.workspace || await mkdtemp(join(tmpdir(), "arc-app-ollama-"));
  const cacheDir = join(workspace, ".agent-run-cache");
  let child;

  try {
    await prepareWorkspace(workspace);
    process.env.AGENT_RUN_CACHE_DIR = cacheDir;
    process.env.AGENT_RUN_CACHE_MODEL_SIDECAR = options.sidecar;
    process.env.AGENT_RUN_CACHE_SIDECAR_COPILOT_COMMAND = `ollama launch copilot --model ${quoteCommandArg(options.model)}`;

    const { saveCapsule } = await import(pathToFileURL(join(repoRoot, "dist", "store.js")).href);
    const capsule = await saveCapsule({
      runner: "copilot",
      workspace,
      sourceSessionId: "arc-app-ollama-seed",
      reusable: true,
      confidence: 0.99,
      title: "Smoke test folder workflow",
      summary: "For test folder orientation, inspect the test directory before broad rediscovery.",
      reuseWhen: ["what is in the test folder", "test folder", "tests in this repo"],
      doNotReuseWhen: ["the prompt is unrelated to repository tests"],
      evidence: ["The repo contains test/public-regression.test.js."],
      provenance: [],
      nextRunInstruction: "List test/ and inspect test/public-regression.test.js only if the user asks for test details.",
      workflow: {
        purpose: "Orient on the test folder.",
        parameters: [],
        bindingSources: ["test/", "test/public-regression.test.js"],
        steps: ["List the test directory.", "Use public-regression.test.js as the focused test file when explaining coverage."],
        commands: [],
        successCriteria: ["The answer names public-regression.test.js from current files."],
        failedAttempts: [],
        validationProbe: ["ls -R test/"]
      }
    }, workspace);
    assert(capsule, "failed to seed the verifier capsule");

    const client = new AppServerClient(spawn(process.execPath, [distAppServer], {
      cwd: workspace,
      env: {
        ...process.env,
        AGENT_RUN_CACHE_DIR: cacheDir,
        AGENT_RUN_CACHE_LOCAL_OBSERVER: "builtin",
        AGENT_RUN_CACHE_MODEL_SIDECAR: options.sidecar,
        AGENT_RUN_CACHE_SIDECAR_COPILOT_COMMAND: `ollama launch copilot --model ${quoteCommandArg(options.model)}`,
        ARC_APP_SESSION_ID: "arc-app-ollama-live",
        ARC_APP_RUNNER: "copilot",
        ARC_APP_PROVIDER: "ollama",
        ARC_APP_PROVIDER_BASE_URL: options.baseUrl,
        ARC_APP_MODEL: options.model,
        ARC_APP_REVIEW: "auto",
        ARC_APP_FAKE: "0"
      },
      stdio: ["pipe", "pipe", "pipe"]
    }), options.timeoutMs);
    child = client.child;

    await client.request("initialize", {});
    client.notify("initialized", {});
    const started = await client.request("thread/start", { cwd: workspace });
    const threadId = stringAt(started, ["thread", "id"]);
    assert(threadId, "app-server did not create a thread");

    await client.request("turn/start", {
      threadId,
      input: [{ type: "text", text: options.prompt }]
    });
    await client.waitForEvent("turn/completed", (params) => stringAt(params, ["turn", "threadId"]) === threadId);

    const read = await client.request("thread/read", { threadId });
    const thread = recordAt(read, ["thread"]);
    const items = arrayAt(thread, ["turns"]).flatMap((turn) => arrayAt(turn, ["items"]));
    const arcMemory = items.filter((item) => item?.type === "arcMemory");
    const assistantText = items
      .filter((item) => item?.type === "agentMessage")
      .map((item) => String(item.text ?? ""))
      .join("\n");
    const toolItems = items.filter((item) => item?.type === "commandExecution");
    const ledger = await readJsonl(join(cacheDir, "memory-events.jsonl"));

    assert(arcMemory.some((item) => String(item.status) === "injected"), "no injected ARC memory item was persisted");
    // Memory is automatic: the timeline only carries a review item when capsules
    // were saved. The review itself must have run, which the ledger records.
    assert(!arcMemory.some((item) => String(item.status) === "waiting"), "server emitted a review card; review is automatic now");
    assert(
      ledger.some((event) => ["capsule.checkpointed", "capsule.finalized", "capsule.rejected"].includes(String(event.type))),
      "ledger has no evidence that the automatic review ran"
    );
    assert(/public-regression\.test\.js/i.test(assistantText), "assistant answer did not mention public-regression.test.js");
    assert(toolItems.length > 0, "runner did not emit any tool activity");
    assert(ledger.some((event) => event.type === "capsule.injected"), "ledger missing capsule.injected");
    assert(ledger.some((event) => event.type === "runner.completed"), "ledger missing runner.completed");

    console.log(JSON.stringify({
      ok: true,
      workspace,
      model: options.model,
      provider: "ollama",
      sidecar: options.sidecar,
      threadId,
      events: client.eventCount,
      itemTypes: items.map((item) => item.type),
      memory: arcMemory.map((item) => ({
        title: item.title,
        status: item.status,
        text: String(item.text ?? "").slice(0, 160)
      })),
      assistant: assistantText.slice(0, 400)
    }, null, 2));
    await client.close();
  } catch (error) {
    if (child && !child.killed) child.kill("SIGTERM");
    console.error(`ARC desktop Ollama verification failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  } finally {
    if (!options.keep && !options.workspace) {
      await rm(workspace, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

function parseArgs(args) {
  const parsed = {
    model: process.env.ARC_VERIFY_MODEL || "gemma4:31b-cloud",
    baseUrl: process.env.ARC_VERIFY_BASE_URL || "http://localhost:11434/v1",
    prompt: process.env.ARC_VERIFY_PROMPT || "what is in the test folder",
    sidecar: process.env.ARC_VERIFY_SIDECAR || "off",
    timeoutMs: Number(process.env.ARC_VERIFY_TIMEOUT_MS || 180000),
    workspace: "",
    keep: false
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--model") parsed.model = args[++index] || parsed.model;
    else if (arg === "--base-url") parsed.baseUrl = args[++index] || parsed.baseUrl;
    else if (arg === "--prompt") parsed.prompt = args[++index] || parsed.prompt;
    else if (arg === "--sidecar") parsed.sidecar = args[++index] || parsed.sidecar;
    else if (arg === "--timeout-ms") parsed.timeoutMs = Number(args[++index] || parsed.timeoutMs);
    else if (arg === "--workspace") parsed.workspace = resolve(args[++index] || "");
    else if (arg === "--keep") parsed.keep = true;
    else if (arg === "--help" || arg === "-h") usage();
    else fail(`unknown option: ${arg}`);
  }
  if (!parsed.model) fail("--model is required");
  if (!["off", "copilot"].includes(parsed.sidecar)) fail("--sidecar must be off or copilot");
  if (!Number.isFinite(parsed.timeoutMs) || parsed.timeoutMs <= 0) fail("--timeout-ms must be a positive number");
  return parsed;
}

function usage() {
  console.log(`Usage:
  npm run verify:desktop:ollama -- [options]

Options:
  --model <name>         Default: gemma4:31b-cloud
  --base-url <url>       Default: http://localhost:11434/v1
  --prompt <text>        Default: what is in the test folder
  --sidecar off|copilot  Default: off
  --timeout-ms <ms>      Default: 180000
  --workspace <dir>      Use an existing workspace instead of a temp repo
  --keep                 Keep the temp workspace after the run
`);
  process.exit(0);
}

async function prepareWorkspace(workspace) {
  await mkdir(join(workspace, "test"), { recursive: true });
  await writeFileIfMissing(join(workspace, "package.json"), JSON.stringify({
    name: "arc-app-ollama-verify",
    private: true,
    type: "module",
    scripts: { test: "node --test test/*.test.js" }
  }, null, 2) + "\n", "utf8");
  await writeFileIfMissing(join(workspace, "test", "public-regression.test.js"), `import test from "node:test";
import assert from "node:assert/strict";

test("public smoke", () => {
  assert.equal(1 + 1, 2);
});
`, "utf8");
}

async function writeFileIfMissing(path, contents, encoding) {
  if (existsSync(path)) return;
  await writeFile(path, contents, encoding);
}

class AppServerClient {
  nextId = 1;
  pending = new Map();
  waiters = [];
  buffer = "";
  stderr = "";
  eventCount = 0;

  constructor(child, timeoutMs) {
    this.child = child;
    this.timeoutMs = timeoutMs;
    child.stdout.on("data", (chunk) => this.acceptStdout(Buffer.from(chunk).toString("utf8")));
    child.stderr.on("data", (chunk) => {
      this.stderr += Buffer.from(chunk).toString("utf8");
    });
    child.on("exit", () => {
      const error = new Error(`app-server exited early${this.stderr.trim() ? `: ${this.stderr.trim()}` : ""}`);
      for (const pending of this.pending.values()) pending.reject(error);
      this.pending.clear();
      for (const waiter of this.waiters.splice(0)) {
        clearTimeout(waiter.timer);
        waiter.reject(error);
      }
    });
  }

  request(method, params) {
    const id = this.nextId++;
    const promise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`timed out waiting for ${method}${this.stderr.trim() ? `: ${this.stderr.trim()}` : ""}`));
      }, this.timeoutMs);
      this.pending.set(id, {
        resolve(value) {
          clearTimeout(timer);
          resolve(value);
        },
        reject(error) {
          clearTimeout(timer);
          reject(error);
        }
      });
    });
    this.write({ id, method, params });
    return promise;
  }

  notify(method, params) {
    this.write({ method, params });
  }

  waitForEvent(method, predicate) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const index = this.waiters.findIndex((waiter) => waiter.resolve === resolve);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(new Error(`timed out waiting for event ${method}${this.stderr.trim() ? `: ${this.stderr.trim()}` : ""}`));
      }, this.timeoutMs);
      this.waiters.push({ method, predicate, resolve, reject, timer });
    });
  }

  async close() {
    if (!this.child.killed) this.child.kill("SIGTERM");
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 1000);
      this.child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  acceptStdout(chunk) {
    this.buffer += chunk;
    for (;;) {
      const newline = this.buffer.indexOf("\n");
      if (newline < 0) break;
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (line) this.acceptLine(line);
    }
  }

  acceptLine(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      this.stderr += `\nnon-json app-server output: ${line}`;
      return;
    }
    if (message.id && this.pending.has(message.id)) {
      const pending = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message || JSON.stringify(message.error)));
      else pending.resolve(message.result || {});
      return;
    }
    if (message.method) {
      this.eventCount += 1;
      for (const waiter of [...this.waiters]) {
        if (waiter.method === message.method && waiter.predicate(recordValue(message.params))) {
          clearTimeout(waiter.timer);
          this.waiters.splice(this.waiters.indexOf(waiter), 1);
          waiter.resolve(recordValue(message.params));
        }
      }
    }
  }

  write(value) {
    this.child.stdin.write(`${JSON.stringify(value)}\n`);
  }
}

async function readJsonl(path) {
  if (!existsSync(path)) return [];
  return (await readFile(path, "utf8"))
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function recordAt(value, path) {
  let current = value;
  for (const key of path) current = current?.[key];
  return recordValue(current);
}

function arrayAt(value, path) {
  let current = value;
  for (const key of path) current = current?.[key];
  return Array.isArray(current) ? current : [];
}

function stringAt(value, path) {
  let current = value;
  for (const key of path) current = current?.[key];
  return typeof current === "string" ? current : "";
}

function recordValue(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function quoteCommandArg(value) {
  if (/^[A-Za-z0-9_./:@+-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function fail(message) {
  console.error(`ARC desktop Ollama verification failed: ${message}`);
  process.exit(1);
}

await main();
