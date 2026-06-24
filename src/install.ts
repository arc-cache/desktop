import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { workspaceRoot } from "./paths.js";

export async function installCopilotPromptHook(workspace = workspaceRoot()): Promise<string> {
  const file = join(workspace, ".github", "hooks", "agent-run-cache.json");
  await mkdir(dirname(file), { recursive: true });
  const cli = join(dirname(fileURLToPath(import.meta.url)), "cli.js");
  const command = `${JSON.stringify(process.execPath)} ${JSON.stringify(cli)} hook copilot`;
  const hooks = {
    version: 1,
    hooks: {
      userPromptSubmitted: [{ type: "command", command: `${command} UserPromptSubmit`, timeoutSec: 20 }],
      sessionEnd: [{ type: "command", command: `${command} SessionEnd`, timeoutSec: 20 }]
    }
  };
  await writeFile(file, `${JSON.stringify(hooks, null, 2)}\n`, "utf8");
  return file;
}
