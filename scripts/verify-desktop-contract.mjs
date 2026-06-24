#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const distAppServer = join(repoRoot, "dist", "app-server.js");

async function main() {
  if (!existsSync(distAppServer)) {
    fail("dist/app-server.js is missing. Run `npm run build` first.");
  }

  const workspace = await mkdtemp(join(tmpdir(), "arc-app-contract-"));
  const otherWorkspace = await mkdtemp(join(tmpdir(), "arc-app-contract-other-"));
  const cacheDir = join(workspace, ".agent-run-cache");
  let client;
  try {
    await prepareWorkspace(workspace);
    await prepareWorkspace(otherWorkspace);
    const { saveCapsule } = await import(pathToFileURL(join(repoRoot, "dist", "store.js")).href);
    await saveCapsule({
      runner: "copilot",
      workspace,
      sourceSessionId: "desktop-contract-seed",
      reusable: true,
      confidence: 0.99,
      title: "Smoke test folder workflow",
      summary: "For test folder orientation, inspect the test directory before broad rediscovery.",
      reuseWhen: ["what is in the test folder", "test folder"],
      doNotReuseWhen: [],
      evidence: ["The verifier workspace contains test/public-regression.test.js."],
      provenance: [],
      nextRunInstruction: "List test/ and identify public-regression.test.js.",
      workflow: {
        purpose: "Orient on the test folder.",
        parameters: [],
        bindingSources: ["test/", "test/public-regression.test.js"],
        steps: ["List test/.", "Read public-regression.test.js if details are needed."],
        commands: [],
        successCriteria: ["The answer names the test files."],
        failedAttempts: [],
        validationProbe: ["ls -R test/"]
      }
    }, workspace);

    client = new AppServerClient(spawn(process.execPath, [distAppServer], {
      cwd: workspace,
      env: {
        ...process.env,
        AGENT_RUN_CACHE_DIR: cacheDir,
        AGENT_RUN_CACHE_MODEL_SIDECAR: "off",
        AGENT_RUN_CACHE_LOCAL_OBSERVER: "builtin",
        AGENT_RUN_CACHE_START_FAKE_RESPONSE: "The test folder contains public-regression.test.js.",
        ARC_APP_SESSION_ID: "desktop-contract",
        ARC_APP_RUNNER: "copilot",
        ARC_APP_PROVIDER: "ollama",
        ARC_APP_PROVIDER_BASE_URL: "http://localhost:11434/v1",
        ARC_APP_MODEL: "gemma4:31b-cloud",
        ARC_APP_REVIEW: "auto",
        ARC_APP_FAKE: "1"
      },
      stdio: ["pipe", "pipe", "pipe"]
    }), 30000);

    await client.request("initialize", {});
    client.notify("initialized", {});
    const projectResponse = await client.request("project/read", { cwd: workspace });
    const project = recordAt(projectResponse, ["project"]);
    const projectPath = stringAt(projectResponse, ["project", "path"]);
    const projectChanges = arrayAt(project, ["changes"]);
    assert.equal(stringAt(projectResponse, ["project", "name"]), workspace.split("/").filter(Boolean).at(-1));
    assert(projectChanges.some((change) => change.path === "test/public-regression.test.js"), "project/read did not report untracked test/public-regression.test.js");
    const projectList = await client.request("project/list", { cwd: workspace });
    assert(
      arrayAt(projectList, ["data"]).some((entry) => entry.path === projectPath),
      "project/list did not include the current workspace"
    );
    const models = await client.request("model/list", {});
    const account = await client.request("account/read", {});
    const memory = await client.request("memory/read", { cwd: workspace });
    assert(arrayAt(models, ["data"]).some((entry) => entry.id === "gemma4:31b-cloud"), "model/list did not expose the configured model");
    assert.equal(stringAt(account, ["authMode"]), "ollama");
    assert.equal(numberAt(memory, ["count"]), 1, "memory/read did not report the seeded capsule store size");

    const first = await client.request("thread/start", { cwd: workspace });
    const threadId = stringAt(first, ["thread", "id"]);
    assert(threadId, "thread/start did not return a thread id");
    const accessModeUpdate = await client.request("thread/access-mode/set", { threadId, accessMode: "full-access" });
    assert.equal(stringAt(accessModeUpdate, ["accessMode"]), "full-access", "thread/access-mode/set did not update access mode");
    const turn = await client.request("turn/start", {
      threadId,
      input: [{ type: "text", text: "what is in the test folder" }],
      approvalPolicy: "on-request",
      sandboxPolicy: { type: "workspaceWrite" },
      runtime: { provider: "ollama", model: "gemma4:31b-cloud" }
    });
    assert.equal(stringAt(turn, ["turn", "accessMode"]), "on-request");
    await client.waitForEvent("turn/completed", (params) => stringAt(params, ["turn", "threadId"]) === threadId);

    const read = await client.request("thread/read", { threadId });
    const thread = recordAt(read, ["thread"]);
    const items = arrayAt(thread, ["turns"]).flatMap((entry) => arrayAt(entry, ["items"]));
    const kinds = items.map((item) => item.type);
    const memoryItems = items.filter((item) => item.type === "arcMemory");
    const assistantText = items.filter((item) => item.type === "agentMessage").map((item) => String(item.text ?? "")).join("\n");
    const list = await client.request("thread/list", { cwd: workspace });
    const projectListAfterTurn = await client.request("project/list", { cwd: workspace });
    const otherProjectResponse = await client.request("project/open", { cwd: otherWorkspace });
    const otherProjectPath = stringAt(otherProjectResponse, ["project", "path"]);
    const second = await client.request("thread/start", { cwd: otherWorkspace });
    const secondThreadId = stringAt(second, ["thread", "id"]);
    const workspaceThreads = await client.request("thread/list", { cwd: workspace });
    const otherThreads = await client.request("thread/list", { cwd: otherWorkspace });
    const projectListAfterSecondProject = await client.request("project/list", { cwd: otherWorkspace });
    const persisted = JSON.parse(await readFile(join(cacheDir, "app-threads.json"), "utf8"));
    const persistedGlobalThreads = JSON.parse(await readFile(join(cacheDir, "app", "threads.json"), "utf8"));
    const persistedProjects = JSON.parse(await readFile(join(cacheDir, "app", "projects.json"), "utf8"));
    const ledger = await readJsonl(join(cacheDir, "memory-events.jsonl"));

    assert(kinds.includes("userMessage"), "server did not persist a user message item");
    assert(kinds.includes("agentMessage"), "server did not persist an assistant message item");
    assert(memoryItems.some((item) => item.status === "injected"), "server did not emit injected ARC memory");
    // Memory is automatic: the chat timeline must not carry review cards. The
    // fake turn saves nothing, so no review item may exist at all.
    assert(!memoryItems.some((item) => item.status === "waiting"), "server emitted a review card; review is automatic now");
    assert(!memoryItems.some((item) => ["no_capsule", "skipped", "failed"].includes(String(item.status))), "server emitted a non-saved review outcome into the timeline");
    assert(!memoryItems.some((item) => String(item.status) === "none"), "server emitted a 'Memory context: none' card; no-injection turns must stay quiet");
    assert(/public-regression\.test\.js/i.test(assistantText), "fake assistant text was not persisted");
    assert(arrayAt(list, ["data"]).some((entry) => entry.id === threadId), "thread/list did not include the created thread");
    assert(
      arrayAt(projectListAfterTurn, ["data"]).some((entry) => entry.path === projectPath && entry.threadCount >= 1),
      "project/list did not report the current workspace thread count"
    );
    assert(
      arrayAt(workspaceThreads, ["data"]).some((entry) => entry.id === threadId) &&
      !arrayAt(workspaceThreads, ["data"]).some((entry) => entry.id === secondThreadId),
      "thread/list for the current workspace was not project-scoped"
    );
    assert(
      arrayAt(otherThreads, ["data"]).some((entry) => entry.id === secondThreadId) &&
      !arrayAt(otherThreads, ["data"]).some((entry) => entry.id === threadId),
      "thread/list for the second workspace was not project-scoped"
    );
    assert(
      arrayAt(projectListAfterSecondProject, ["data"]).some((entry) => entry.path === projectPath) &&
      arrayAt(projectListAfterSecondProject, ["data"]).some((entry) => entry.path === otherProjectPath),
      "project/list did not preserve both workspaces"
    );
    assert.equal(
      stringAt(otherProjectResponse, ["project", "name"]),
      otherWorkspace.split("/").filter(Boolean).at(-1),
      "project/open did not return a concrete project record"
    );
    assert(persisted.some((entry) => entry.id === threadId), "app-threads.json did not persist the created thread");
    assert(persistedGlobalThreads.some((entry) => entry.id === threadId), "app threads store did not persist the current workspace thread");
    assert(persistedGlobalThreads.some((entry) => entry.id === secondThreadId), "app threads store did not persist the second workspace thread");
    assert(persistedProjects.some((entry) => entry.path === projectPath), "projects.json did not persist the current workspace");
    assert(persistedProjects.some((entry) => entry.path === otherProjectPath), "projects.json did not persist the second workspace");
    assert(ledger.some((entry) => entry.type === "turn.started"), "ledger missing turn.started");
    assert(ledger.some((entry) => entry.type === "runner.completed"), "ledger missing runner.completed");

    console.log(JSON.stringify({
      ok: true,
      workspace,
      threadId,
      project: {
        name: project.name,
        branch: project.branch,
        commit: project.commit,
        changes: projectChanges.slice(0, 5)
      },
      secondProject: {
        path: otherProjectPath,
        threadId: secondThreadId
      },
      itemTypes: kinds,
      memory: memoryItems.map((item) => ({ title: item.title, status: item.status })),
      assistant: assistantText
    }, null, 2));
  } finally {
    await client?.close();
    await rm(workspace, { recursive: true, force: true }).catch(() => undefined);
    await rm(otherWorkspace, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function prepareWorkspace(workspace) {
  await writeFile(join(workspace, "package.json"), JSON.stringify({
    name: "arc-app-contract",
    private: true,
    type: "module"
  }, null, 2) + "\n", "utf8");
  await run(["init"], workspace);
  await run(["config", "user.name", "ARC Verifier"], workspace);
  await run(["config", "user.email", "arc-verifier@example.invalid"], workspace);
  await run(["add", "package.json"], workspace);
  await run(["commit", "-m", "initial"], workspace);

  await mkdir(join(workspace, "test"), { recursive: true });
  await writeFile(join(workspace, "test", "public-regression.test.js"), "export const smoke = true;\n", "utf8");
}

async function run(args, cwd) {
  await new Promise((resolve, reject) => {
    const child = spawn("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += Buffer.from(chunk).toString("utf8");
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`git ${args.join(" ")} failed${stderr.trim() ? `: ${stderr.trim()}` : ""}`));
    });
  });
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
    if (!message.method) return;
    this.eventCount += 1;
    for (const waiter of [...this.waiters]) {
      if (waiter.method === message.method && waiter.predicate(recordValue(message.params))) {
        clearTimeout(waiter.timer);
        this.waiters.splice(this.waiters.indexOf(waiter), 1);
        waiter.resolve(recordValue(message.params));
      }
    }
  }

  write(value) {
    this.child.stdin.write(`${JSON.stringify(value)}\n`);
  }
}

async function readJsonl(path) {
  if (!existsSync(path)) return [];
  return (await readFile(path, "utf8")).split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
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

function numberAt(value, path) {
  let current = value;
  for (const key of path) current = current?.[key];
  return typeof current === "number" ? current : NaN;
}

function recordValue(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function fail(message) {
  console.error(`ARC desktop contract verification failed: ${message}`);
  process.exit(1);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

assert.equal = (actual, expected) => {
  if (actual !== expected) throw new Error(`expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
};

await main().catch((error) => {
  console.error(`ARC desktop contract verification failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
