import type { CodexServerRequest, PermissionRequest } from "@/types";

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function requestToolUseId(data: CodexServerRequest): string {
  if (data.method === "item/tool/requestUserInput") {
    return data.itemId;
  }
  return text(data.itemId)
    ?? text(data.toolCallId)
    ?? `codex-permission-${String(data.rpcId)}`;
}

function approvalToolName(data: Extract<CodexServerRequest, { method: "item/commandExecution/requestApproval" | "item/fileChange/requestApproval" | "item/permissions/requestApproval" }>): string {
  const command = text(data.fullCommandText) ?? text(data.command);
  const requestedTool = text(data.toolName);
  const requestedKind = text(data.kind)?.toLowerCase();
  const normalizedTool = requestedTool?.toLowerCase();

  if (data.method === "item/commandExecution/requestApproval" || command) {
    return "Bash";
  }
  if (data.method === "item/fileChange/requestApproval") {
    return "Edit";
  }
  if (requestedKind === "read" || normalizedTool === "read" || normalizedTool === "view") {
    return "Read";
  }
  if (text(data.fileName)) {
    return "Edit";
  }
  return requestedTool ?? "Tool";
}

function approvalToolInput(data: Extract<CodexServerRequest, { method: "item/commandExecution/requestApproval" | "item/fileChange/requestApproval" | "item/permissions/requestApproval" }>): Record<string, unknown> {
  const input: Record<string, unknown> = {};
  const command = text(data.fullCommandText) ?? text(data.command);
  const fileName = text(data.fileName);
  const domain = text(data.domain);
  const url = text(data.url);
  const kind = text(data.kind);
  const accessMode = text(data.accessMode);
  const toolName = text(data.toolName);

  if (command) input.command = command;
  if (fileName) input.file_path = fileName;
  if (domain) input.domain = domain;
  if (url) input.url = url;
  if (kind) input.kind = kind;
  if (accessMode) input.accessMode = accessMode;
  if (toolName) input.toolName = toolName;

  return input;
}

export function permissionRequestFromCodexServerRequest(
  data: CodexServerRequest,
  userInputSource: string,
): PermissionRequest {
  if (data.method === "item/tool/requestUserInput") {
    return {
      requestId: String(data.rpcId),
      toolName: "AskUserQuestion",
      toolInput: {
        source: userInputSource,
        questions: data.questions.map((question) => ({
          id: question.id,
          header: question.header,
          question: question.question,
          isOther: question.isOther,
          isSecret: question.isSecret,
          options: question.options ?? undefined,
          multiSelect: false,
        })),
      },
      toolUseId: requestToolUseId(data),
      codexRpcId: data.rpcId,
    };
  }

  return {
    requestId: String(data.rpcId),
    toolName: approvalToolName(data),
    toolInput: approvalToolInput(data),
    toolUseId: requestToolUseId(data),
    codexRpcId: data.rpcId,
    ...(data.reason ? { decisionReason: data.reason } : {}),
  };
}
