import { harvestSession } from "./copilot.js";
import { recordMemoryEvent } from "./ledger.js";
import { buildInjectionPlan } from "./retrieval.js";
import { debug } from "./store.js";
import { workspaceRoot } from "./paths.js";

export async function handleCopilotHook(hookName: string): Promise<Record<string, unknown>> {
  try {
    if (process.env.AGENT_RUN_CACHE_IN_SIDECAR === "1") return {};
    const payload = await readStdinJson();
    const input = (payload.input && typeof payload.input === "object" ? payload.input : payload) as Record<string, unknown>;
    const cwd = typeof input.cwd === "string" ? input.cwd : typeof payload.cwd === "string" ? payload.cwd : process.cwd();
    const workspace = workspaceRoot(cwd);
    const sessionId = String(input.sessionId ?? payload.sessionId ?? "unknown");

    if (hookName === "UserPromptSubmit") {
      const prompt = typeof input.prompt === "string" ? input.prompt : "";
      if (!prompt || prompt.includes("Agent Run Cache sidecar note:") || prompt.includes("Agent Run Cache consult:")) return {};
      const plan = await buildInjectionPlan(prompt, workspace, { runner: "copilot" });
      if (!plan.shouldInject) {
        await debug("hook.user_prompt.no_context", { sessionId, reason: plan.reason }, workspace);
        return {};
      }
      await debug("hook.user_prompt.context", { sessionId, reason: plan.reason, source: plan.source }, workspace);
      await recordMemoryEvent({
        type: "capsule.injected",
        workspace,
        sessionId,
        capsuleId: plan.capsule?.id,
        details: {
          source: plan.source,
          reason: plan.reason,
          title: plan.capsule?.title,
          injected: true,
          used: "unknown",
          helped: "unknown"
        }
      });
      return {
        additionalContext: plan.message,
        modifiedPrompt: `${plan.message}\n\nUser task:\n${prompt}`
      };
    }

    if (hookName === "SessionEnd" && sessionId !== "unknown") {
      await harvestSession(sessionId, workspace).catch((error) => debug("hook.session_end.harvest_failed", { sessionId, error: String(error) }, workspace));
    }
    return {};
  } catch (error) {
    await debug("hook.failed", { hookName, error: String(error) }).catch(() => undefined);
    return {};
  }
}

async function readStdinJson(): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
}
