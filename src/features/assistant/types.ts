export type AssistantProvider = "openai" | "anthropic";
export type AssistantPermission = "readOnly" | "controlled" | "fullAccess";

export interface McpStatus {
  running: boolean;
  port: number;
  url: string | null;
  tokenMasked: string | null;
}

export interface ToolSummary {
  name: string;
  description: string;
  tier: "readOnly" | "controlled";
}

export interface AssistantStatus {
  apiKeyConfigured: boolean;
  provider: AssistantProvider;
  baseUrl: string;
  effectiveBaseUrl: string;
  model: string;
  permission: AssistantPermission;
  loopbackEndpoint: boolean;
  ready: boolean;
  mcp: McpStatus;
  tools: ToolSummary[];
}

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface ToolTraceItem {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  tier: string;
  status: "executed" | "approved" | "denied" | "blocked" | "error";
  summary: string;
}

export interface PendingToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  description: string;
}

export interface PendingContinuation {
  provider: string;
  providerMessages: unknown[];
  completedResults: unknown[];
  pendingCalls: PendingToolCall[];
  round: number;
}

export interface AssistantTurnResponse {
  reply: string;
  traces: ToolTraceItem[];
  pendingApprovals: PendingToolCall[];
  continuation: PendingContinuation | null;
  model: string;
  provider: string;
}
