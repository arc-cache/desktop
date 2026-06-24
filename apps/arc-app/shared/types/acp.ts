// ACP event types for renderer (what main process forwards via IPC)

export interface ACPSessionEvent {
  _sessionId: string;
  sessionId: string;
  update: ACPSessionUpdate;
}

export type ACPSessionUpdate =
  | ACPAgentMessageChunk
  | ACPAgentThoughtChunk
  | ACPUserMessageChunk
  | ACPToolCall
  | ACPToolCallUpdate
  | ACPPlan
  | ACPUsageUpdate
  | ACPSessionInfoUpdate
  | ACPCurrentModeUpdate
  | ACPConfigOptionUpdate
  | ACPAvailableCommandsUpdate;

export interface ACPAgentMessageChunk { sessionUpdate: "agent_message_chunk"; content: { type: string; text?: string } }
export interface ACPAgentThoughtChunk { sessionUpdate: "agent_thought_chunk"; content: { type: string; text?: string } }
export interface ACPUserMessageChunk { sessionUpdate: "user_message_chunk"; content: { type: string; text?: string } }
export interface ACPToolCall {
  sessionUpdate: "tool_call"; toolCallId: string; title: string; kind?: string; status: string;
  locations?: Array<{ path: string; line?: number }>; content?: unknown[]; rawInput?: unknown; rawOutput?: unknown;
}
export interface ACPToolCallUpdate {
  sessionUpdate: "tool_call_update"; toolCallId: string; status?: string;
  content?: unknown[]; rawOutput?: unknown; locations?: Array<{ path: string; line?: number }>;
  /** Some ACP agents (e.g. OpenCode) include rawInput and kind in tool_call_update events */
  rawInput?: unknown; kind?: string; title?: string;
}
export interface ACPPlan { sessionUpdate: "plan"; entries: Array<{ content: string; status: string; priority?: string }> }
export interface ACPUsageUpdate { sessionUpdate: "usage_update"; size?: number; used?: number; cost?: { amount: number; currency: string } }
export interface ACPSessionInfoUpdate { sessionUpdate: "session_info_update"; title?: string }
export interface ACPCurrentModeUpdate { sessionUpdate: "current_mode_update"; currentModeId: string }
export interface ACPConfigOptionUpdate { sessionUpdate: "config_option_update"; configOptions: ACPConfigOption[] }
export interface ACPAvailableCommand {
  name: string;
  description: string;
  input?: { hint?: string };
}

export interface ACPAvailableCommandsUpdate { sessionUpdate: "available_commands_update"; availableCommands: ACPAvailableCommand[] }

// ACP Session Config Option types (model, mode, thought_level, etc.)
export interface ACPConfigOption {
  id: string;
  name: string;
  category?: "model" | "mode" | "thought_level" | string | null;
  type: "select";
  currentValue: string;
  options: ACPConfigSelectOption[] | ACPConfigSelectGroup[];
}

export interface ACPConfigSelectOption {
  value: string;
  name: string;
  description?: string | null;
}

export interface ACPConfigSelectGroup {
  group: string;
  name: string;
  options: ACPConfigSelectOption[];
}

export interface ACPPermissionEvent {
  _sessionId: string;
  requestId: string;
  sessionId: string;
  toolCall: {
    toolCallId: string;
    title: string;
    kind?: string;
    status?: string;
    rawInput?: unknown;
  };
  options: Array<{
    optionId: string;
    name: string;
    kind: "allow_once" | "allow_always" | "reject_once" | "reject_always";
  }>;
}

export interface ACPTurnCompleteEvent {
  _sessionId: string;
  stopReason: string;
  usage?: { inputTokens?: number; outputTokens?: number } | null;
}

export interface ACPAuthEnvVar {
  name: string;
  label?: string | null;
  optional?: boolean;
  secret?: boolean;
}

interface ACPAuthMethodBase {
  id: string;
  name: string;
  description?: string | null;
}

export interface ACPAuthMethodAgent extends ACPAuthMethodBase {
  type?: "agent";
}

export interface ACPAuthMethodEnvVar extends ACPAuthMethodBase {
  type: "env_var";
  vars: ACPAuthEnvVar[];
  link?: string | null;
}

export interface ACPAuthMethodTerminal extends ACPAuthMethodBase {
  type: "terminal";
  args?: string[];
  env?: Record<string, string>;
}

export type ACPAuthMethod =
  | ACPAuthMethodAgent
  | ACPAuthMethodEnvVar
  | ACPAuthMethodTerminal;

export interface ACPStatusInfo {
  name: string;
  status: string;
}

export interface ACPStartSuccessResult {
  sessionId: string;
  agentSessionId?: string;
  agentName?: string;
  configOptions?: ACPConfigOption[];
  mcpStatuses?: ACPStatusInfo[];
}

export interface ACPStartAuthRequiredResult {
  authRequired: true;
  sessionId: string;
  agentName?: string;
  authMethods: ACPAuthMethod[];
}

export interface ACPStartErrorResult {
  error?: string;
  cancelled?: boolean;
}

export type ACPStartResult =
  | ACPStartSuccessResult
  | ACPStartAuthRequiredResult
  | ACPStartErrorResult;

export interface ACPAuthenticateResult {
  ok?: boolean;
  authRequired?: boolean;
  sessionId?: string;
  agentSessionId?: string;
  agentName?: string;
  authMethods?: ACPAuthMethod[];
  configOptions?: ACPConfigOption[];
  mcpStatuses?: ACPStatusInfo[];
  error?: string;
}
