import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { redactSensitiveText } from "../dist/redact.js";
import { buildInjectionPlan } from "../dist/retrieval.js";
import { loadCapsules, saveCapsule } from "../dist/store.js";

function withCache(fn) {
  return async () => {
    const root = await mkdtemp(join(tmpdir(), "arc-public-test-"));
    const previousCache = process.env.AGENT_RUN_CACHE_DIR;
    const previousSidecar = process.env.AGENT_RUN_CACHE_MODEL_SIDECAR;
    const previousConsult = process.env.AGENT_RUN_CACHE_CONSULT_COMMAND;
    const previousLocalObserver = process.env.AGENT_RUN_CACHE_LOCAL_OBSERVER;
    const previousEmbeddingEndpoint = process.env.AGENT_RUN_CACHE_EMBEDDING_ENDPOINT;
    const previousLocalEmbeddingEndpoint = process.env.AGENT_RUN_CACHE_LOCAL_EMBEDDING_ENDPOINT;
    const previousLocalEmbeddings = process.env.AGENT_RUN_CACHE_LOCAL_EMBEDDINGS;

    process.env.AGENT_RUN_CACHE_DIR = join(root, ".agent-run-cache");
    process.env.AGENT_RUN_CACHE_MODEL_SIDECAR = "off";
    process.env.AGENT_RUN_CACHE_LOCAL_OBSERVER = "off";
    delete process.env.AGENT_RUN_CACHE_CONSULT_COMMAND;
    delete process.env.AGENT_RUN_CACHE_EMBEDDING_ENDPOINT;
    delete process.env.AGENT_RUN_CACHE_LOCAL_EMBEDDING_ENDPOINT;
    delete process.env.AGENT_RUN_CACHE_LOCAL_EMBEDDINGS;

    try {
      await fn(root);
    } finally {
      restoreEnv("AGENT_RUN_CACHE_DIR", previousCache);
      restoreEnv("AGENT_RUN_CACHE_MODEL_SIDECAR", previousSidecar);
      restoreEnv("AGENT_RUN_CACHE_CONSULT_COMMAND", previousConsult);
      restoreEnv("AGENT_RUN_CACHE_LOCAL_OBSERVER", previousLocalObserver);
      restoreEnv("AGENT_RUN_CACHE_EMBEDDING_ENDPOINT", previousEmbeddingEndpoint);
      restoreEnv("AGENT_RUN_CACHE_LOCAL_EMBEDDING_ENDPOINT", previousLocalEmbeddingEndpoint);
      restoreEnv("AGENT_RUN_CACHE_LOCAL_EMBEDDINGS", previousLocalEmbeddings);
      await rm(root, { recursive: true, force: true });
    }
  };
}

function restoreEnv(name, value) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

test("redaction handles generic secret assignment names", () => {
  const input = [
    "SERVICE_TOKEN=secret-token-value",
    "\"PROJECT_API_KEY\": \"secret-api-key\"",
    "WORKSPACE_PASSWORD='secret-password'",
  ].join("\n");
  const redacted = redactSensitiveText(input);

  assert.equal(redacted.includes("secret-token-value"), false);
  assert.equal(redacted.includes("secret-api-key"), false);
  assert.equal(redacted.includes("secret-password"), false);
  assert.match(redacted, /SERVICE_TOKEN=<token>/);
  assert.match(redacted, /"PROJECT_API_KEY": <token>/);
  assert.match(redacted, /WORKSPACE_PASSWORD=<token>/);
});

test("retrieval honors a consult decline without local fallback", withCache(async (workspace) => {
  const consult = join(workspace, "declining-consult.cjs");
  const consultInput = join(workspace, "declining-consult-input.json");
  await writeFile(consult, `
const fs = require("fs");
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.resume();
process.stdin.on("end", () => {
  fs.writeFileSync(${JSON.stringify(consultInput)}, input);
  console.log(JSON.stringify({
    applies: false,
    reason: "The current request explicitly asks not to run the saved workflow."
  }));
});
`, "utf8");
  process.env.AGENT_RUN_CACHE_CONSULT_COMMAND = `${process.execPath} ${consult}`;

  const saved = await saveCapsule({
    runner: "codex",
    workspace,
    sourceSessionId: "seed",
    reusable: true,
    confidence: 0.9,
    title: "Generate release notes",
    summary: "Build concise release notes from a local changelog.",
    reuseWhen: ["generate release notes", "summarize changelog"],
    doNotReuseWhen: [],
    evidence: ["A previous run read CHANGELOG.md and produced a release summary."],
    provenance: ["CHANGELOG.md"],
    nextRunInstruction: "Read the current changelog and summarize only the requested release section.",
    workflow: {
      purpose: "Generate release notes from repository-local source text.",
      parameters: ["release section"],
      bindingSources: ["CHANGELOG.md"],
      steps: ["Read the changelog.", "Find the requested section.", "Summarize the user-facing changes."],
      commands: ["sed -n '1,160p' CHANGELOG.md"],
      successCriteria: ["The answer cites only entries from the requested section."],
      failedAttempts: [],
      validationProbe: ["test -f CHANGELOG.md"]
    }
  }, workspace);

  const plan = await buildInjectionPlan(
    "do not generate release notes; just tell me what file you would inspect",
    workspace,
    { runner: "codex" }
  );

  assert.equal(plan.shouldInject, false);
  assert.equal(plan.source, "sidecar");
  assert.match(plan.reason, /not to run/);

  const reloaded = (await loadCapsules(workspace)).find((capsule) => capsule.id === saved?.id);
  assert.equal(reloaded?.useCount, 0);

  const payload = JSON.parse(await readFile(consultInput, "utf8"));
  assert.equal(payload.capsules.length, 1);
  assert.equal(payload.capsules[0].id, saved?.id);
  assert.equal(payload.capsules[0].sourceSessionIds, undefined);
  assert.equal(payload.capsules[0].evidence, undefined);
  assert.equal(payload.capsules[0].bindingSnapshots, undefined);
  assert.equal(payload.capsules[0].embedding, undefined);
  assert.equal(payload.capsules[0].graph, undefined);
}));

test("app-server resumes Copilot SDK only after prior provider history exists", async () => {
  const { shouldResumeCopilotSdkSession } = await import(`../dist/app-server.js?resume=${Date.now()}`);

  assert.equal(shouldResumeCopilotSdkSession({ turns: [] }, "turn-current"), false);
  assert.equal(shouldResumeCopilotSdkSession({
    turns: [
      {
        id: "turn-current",
        items: [
          { type: "userMessage", content: [{ type: "text", text: "first prompt" }] },
          { type: "commandExecution", status: "inProgress" }
        ]
      }
    ]
  }, "turn-current"), false);
  assert.equal(shouldResumeCopilotSdkSession({
    turns: [
      {
        id: "turn-previous",
        items: [
          { type: "userMessage", content: [{ type: "text", text: "previous prompt" }] },
          { type: "agentMessage", text: "previous answer" }
        ]
      },
      {
        id: "turn-current",
        items: [
          { type: "userMessage", content: [{ type: "text", text: "follow up" }] }
        ]
      }
    ]
  }, "turn-current"), true);
});
