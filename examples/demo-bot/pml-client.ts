/**
 * PML Client — Connects to a PML serve instance via JSON-RPC.
 *
 * Provides discover() and execute() for tool routing.
 * Handles PML's approval workflow (integrity checks, HIL) automatically.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PmlTool {
  readonly name: string;
  readonly description: string;
  /** Present on capabilities (e.g. "crypto:uuid"). */
  readonly call_name?: string;
  /** Tool ID — "server_id:tool_name" for MCP tools. */
  readonly id?: string;
  /** MCP server ID (e.g. "std"). */
  readonly server_id?: string;
  readonly input_schema?: Record<string, unknown>;
  readonly score?: number;
  readonly code_snippet?: string;
}

/** Get the callable name from a tool (works for both tools and capabilities). */
export function getToolCallName(tool: PmlTool): string {
  if (tool.call_name) return tool.call_name;
  if (tool.server_id && tool.name) return `${tool.server_id}:${tool.name}`;
  if (tool.id) return tool.id;
  return tool.name;
}

export interface PmlDiscoverResult {
  readonly results: PmlTool[];
  readonly meta: {
    readonly query: string;
    readonly total_found: number;
    readonly returned_count: number;
  };
}

export interface PmlExecuteResult {
  /** The final text result from the tool execution. */
  readonly text: string;
  /** Whether the tool has an associated UI (_meta.ui). */
  readonly hasUi: boolean;
  /** The UI resource URI if available (e.g. ui://mcp-std/json-viewer). */
  readonly uiResourceUri?: string;
  /** Workflow ID (= traceId per ADR-065) for fetching execution trace from API. */
  readonly workflowId?: string;
}

/** Execution trace — mirrors the dashboard's ExecutionTrace shape. */
export interface ExecutionTrace {
  id: string;
  success: boolean;
  durationMs: number;
  priority?: number;
  errorMessage?: string | null;
  taskResults: TaskResultEntry[];
}

/** A single task result within a trace. */
export interface TaskResultEntry {
  taskId: string;
  tool: string;
  success: boolean;
  durationMs: number;
  layerIndex?: number;
  isFused?: boolean;
  logicalOperations?: Array<{ toolId: string; durationMs?: number }>;
  isCapabilityCall?: boolean;
  nestedTools?: string[];
  loopId?: string;
  loopIteration?: number;
  loopType?: string;
  loopCondition?: string;
  bodyTools?: string[];
}

interface PmlRpcResponse {
  readonly jsonrpc: "2.0";
  readonly id: string;
  readonly result?: {
    readonly content: Array<{ readonly type: string; readonly text: string }>;
    readonly isError?: boolean;
  };
  readonly error?: {
    readonly code: number;
    readonly message: string;
  };
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export class PmlClient {
  private readonly baseUrl: string;
  private reqCounter = 0;
  private debug = false;

  constructor(baseUrl: string, debug = false) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.debug = debug;
  }

  private log(...args: unknown[]): void {
    if (this.debug) {
      console.log("[PmlClient]", ...args);
    }
  }

  /** Discover tools relevant to an intent. Only returns real MCP tools (not capabilities). */
  async discover(intent: string, limit = 5): Promise<PmlDiscoverResult> {
    const rpc = await this.callTool("discover", {
      intent,
      limit,
      filter: { type: "tool" },
    });

    const text = rpc.result?.content?.[0]?.text;
    if (!text) {
      return { results: [], meta: { query: intent, total_found: 0, returned_count: 0 } };
    }
    return JSON.parse(text) as PmlDiscoverResult;
  }

  /**
   * Execute code via PML.
   * Automatically handles approval_required workflows (integrity, HIL).
   * Returns the final tool result with UI metadata.
   */
  async execute(code: string, intent: string): Promise<PmlExecuteResult> {
    const MAX_APPROVALS = 5;
    let attempts = 0;
    let rpc = await this.callTool("execute", { code, intent });

    // Auto-approve loop (integrity checks, tool hash changes, etc.)
    while (attempts < MAX_APPROVALS) {
      if (rpc.error) {
        throw new Error(`PML execute error: ${rpc.error.message}`);
      }

      const rawText = rpc.result?.content?.[0]?.text ?? "";
      if (!rawText) {
        return { text: "", hasUi: false };
      }

      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(rawText);
      } catch {
        return { text: rawText, hasUi: false };
      }

      // Check if PML needs approval (integrity check, HIL checkpoint, tool permission)
      const workflowId = this.findApprovalWorkflowId(parsed);
      if (workflowId) {
        this.log(`Auto-approving workflow ${workflowId} (attempt ${attempts + 1})`);
        attempts++;
        rpc = await this.callTool("execute", {
          continue_workflow: {
            workflow_id: workflowId,
            approved: true,
          },
        });
        continue;
      }

      // Check if result is null/empty after approval — re-execute original code
      if (parsed.status === "success" && parsed.result === null && attempts > 0) {
        this.log("Result null after approval — re-executing original code");
        attempts++;
        rpc = await this.callTool("execute", { code, intent });
        continue;
      }

      // We have a final result — extract the tool output
      return this.extractResult(parsed);
    }

    throw new Error(`PML execute: too many approval rounds (${MAX_APPROVALS})`);
  }

  /**
   * Detect if a PML response needs approval, regardless of format.
   *
   * Handles:
   * 1. Top-level: { status: "approval_required", workflow_id: "..." }
   * 2. Embedded in arrays: { palette: [{ approvalRequired: true, workflowId: "..." }] }
   * 3. Direct embedded: { approvalRequired: true, workflowId: "..." }
   */
  private findApprovalWorkflowId(data: Record<string, unknown>): string | null {
    // Format 1: top-level approval_required
    if (data.status === "approval_required" && data.workflow_id) {
      return data.workflow_id as string;
    }

    // Format 2 & 3: scan values for approvalRequired objects
    const scan = (obj: unknown): string | null => {
      if (!obj || typeof obj !== "object") return null;
      if (Array.isArray(obj)) {
        for (const item of obj) {
          const wid = scan(item);
          if (wid) return wid;
        }
        return null;
      }
      const rec = obj as Record<string, unknown>;
      if (rec.approvalRequired === true && rec.workflowId) {
        return rec.workflowId as string;
      }
      for (const val of Object.values(rec)) {
        const wid = scan(val);
        if (wid) return wid;
      }
      return null;
    };

    return scan(data);
  }

  /**
   * Extract tool result and UI metadata from PML execute response.
   *
   * PML execute can return different formats:
   * - { status: "success", result: { content: [...], _meta: { ui: {...} } } }
   * - { executionTimeMs: N, result: { state: {...} } }
   * - Direct content text
   */
  private extractResult(data: Record<string, unknown>): PmlExecuteResult {
    const workflowId = data.workflow_id as string | undefined;

    // Format 1: { status: "success", result: { content: [...], _meta: { ui } } }
    if (data.status === "success" && data.result) {
      const result = data.result as Record<string, unknown>;
      const meta = result._meta as Record<string, unknown> | undefined;
      const ui = meta?.ui as Record<string, unknown> | undefined;
      const content = result.content as Array<{ type: string; text: string }> | undefined;

      if (content && Array.isArray(content)) {
        const textContent = content.find((c) => c.type === "text");
        return {
          text: textContent?.text ?? JSON.stringify(content),
          hasUi: !!ui,
          uiResourceUri: ui?.resourceUri as string | undefined,
          workflowId,
        };
      }

      // result is the value itself (no content wrapper)
      return {
        text: JSON.stringify(result, null, 2),
        hasUi: !!ui,
        uiResourceUri: ui?.resourceUri as string | undefined,
        workflowId,
      };
    }

    // Format 2: execution metadata — try to dig into result.state
    if (data.executionTimeMs !== undefined && data.result) {
      const innerResult = data.result as Record<string, unknown>;
      if (innerResult.state) {
        return {
          text: JSON.stringify(innerResult.state, null, 2),
          hasUi: false,
          workflowId,
        };
      }
    }

    // Fallback: stringify the whole thing
    return {
      text: JSON.stringify(data, null, 2),
      hasUi: false,
      workflowId,
    };
  }

  /**
   * Read a resource by URI (e.g. ui://mcp-std/json-viewer).
   * Returns the raw text content, or null if not found.
   */
  async readResource(uri: string): Promise<string | null> {
    const id = `bot-${++this.reqCounter}-${Date.now()}`;

    const response = await fetch(`${this.baseUrl}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id,
        method: "resources/read",
        params: { uri },
      }),
    });

    if (!response.ok) {
      this.log(`readResource HTTP error (${response.status})`);
      return null;
    }

    const data = await response.json();
    if (data.error) {
      this.log(`readResource error: ${data.error.message}`);
      return null;
    }

    // MCP resources/read returns { contents: [{ uri, text, mimeType }] }
    const contents = data.result?.contents;
    if (Array.isArray(contents) && contents.length > 0) {
      return contents[0].text ?? null;
    }

    return null;
  }

  /** Call a PML tool via JSON-RPC. */
  private async callTool(
    name: string,
    args: Record<string, unknown>,
  ): Promise<PmlRpcResponse> {
    const id = `bot-${++this.reqCounter}-${Date.now()}`;

    const response = await fetch(`${this.baseUrl}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id,
        method: "tools/call",
        params: { name, arguments: args },
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`PML HTTP error (${response.status}): ${text}`);
    }

    return await response.json();
  }
}

/**
 * Parse "namespace:action" into mcp.namespace.action() code.
 *
 * Validates that namespace and action are safe JavaScript identifiers
 * to prevent code injection via crafted tool names.
 */
const JS_IDENTIFIER = /^[a-zA-Z_$][a-zA-Z0-9_$]*$/;

export function buildExecuteCode(
  callName: string,
  args: Record<string, unknown>,
): string {
  const idx = callName.indexOf(":");
  const namespace = idx === -1 ? "std" : callName.slice(0, idx);
  const action = idx === -1 ? callName : callName.slice(idx + 1);

  if (!JS_IDENTIFIER.test(namespace) || !JS_IDENTIFIER.test(action)) {
    throw new Error(
      `[buildExecuteCode] Invalid tool name: "${callName}". ` +
      "Namespace and action must be valid JS identifiers.",
    );
  }

  return `return await mcp.${namespace}.${action}(${JSON.stringify(args)})`;
}
