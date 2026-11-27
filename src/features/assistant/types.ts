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
  proactive: boolean;
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
  status: "executed" | "approved" | "denied" | "blocked" | "expired" | "error";
  summary: string;
}

/** Fields the backend resolves for an approval card; each has a translated label. */
export type ApprovalDetailField =
  | "instance"
  | "project"
  | "resourceType"
  | "resourceVersion"
  | "loader"
  | "serverName"
  | "serverAddress"
  | "managedServer"
  | "game"
  | "gameVersion"
  | "name"
  | "notes"
  | "category"
  | "worldFolder"
  | "fileName"
  | "memoryMode"
  | "maxMemory"
  | "minMemory"
  | "clearMinMemory"
  | "screenWidth"
  | "screenHeight"
  | "gameProxyMode"
  | "resetRuntime"
  | "retryCount"
  | "retryTask";

export interface ApprovalDetail {
  field: ApprovalDetailField;
  value: string;
  /** True when the backend could not confirm this ID or the pairing it names. */
  unresolved: boolean;
}

/** Why a call waits: Controlled mode, a tool that always asks, or the per-message write limit. */
export type ApprovalReason = "controlled" | "alwaysAsk" | "limit";

export interface PendingToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  description: string;
  details: ApprovalDetail[];
  unresolved: boolean;
  reason: ApprovalReason;
}

export interface PendingContinuation {
  provider: string;
  providerMessages: unknown[];
  completedResults: unknown[];
  pendingCalls: PendingToolCall[];
  round: number;
  wake?: boolean;
  unapprovedWrites?: number;
}

export interface AssistantTurnRequest {
  messages: ChatMessage[];
  approvedCallIds?: string[];
  deniedCallIds?: string[];
  pendingContinuation?: PendingContinuation;
  /** Set only for a prompt the launcher sends by itself; the backend keeps that turn read-only. */
  wake?: boolean;
}

export interface AssistantTurnResponse {
  reply: string;
  traces: ToolTraceItem[];
  pendingApprovals: PendingToolCall[];
  continuation: PendingContinuation | null;
  model: string;
  provider: string;
}
