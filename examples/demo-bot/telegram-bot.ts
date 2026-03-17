/**
 * Telegram Bot — Agentic loop powered by LLM + PML tools.
 *
 * Flow per message:
 *   1. Discover relevant MCP tools via PML
 *   2. Send user message + tool definitions to LLM (OpenAI tool_use)
 *   3. LLM either calls a tool (with correct args) or asks user a question
 *   4. If tool_call → execute via PML → feed result back to LLM → loop
 *   5. If text → send to Telegram user
 *
 * Supports webhook and polling modes.
 */

import { PmlClient, buildExecuteCode, getToolCallName } from "./pml-client.ts";
import type { PmlTool, PmlExecuteResult, TaskResultEntry } from "./pml-client.ts";
import { LlmClient } from "./llm-client.ts";
import type { LlmMessage, LlmTool, LlmToolCall } from "./llm-client.ts";
import type { ToolResultData } from "../../src/resource-server/server.ts";

// Re-export so other example files can still import from here if needed
export type { ToolResultData };

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TelegramBotConfig {
  readonly botToken: string;
  readonly pmlUrl: string;
  readonly bridgeBaseUrl: string;
  readonly openaiApiKey: string;
  readonly openaiModel?: string;
  readonly debug?: boolean;
  readonly discoverLimit?: number;
  /** Max LLM turns per user message (tool calls + responses). */
  readonly maxAgentTurns?: number;
  /** PML cloud API URL for fetching traces (e.g. "https://pml.casys.ai"). */
  readonly cloudApiUrl?: string;
  /** API key for cloud API (x-api-key header). */
  readonly cloudApiKey?: string;
  /**
   * Store a tool result server-side and return an opaque reference ID.
   * Used to pass tool results to the MCP App via WebSocket push.
   */
  readonly storeToolResult?: (result: ToolResultData) => string;
}

interface TelegramUpdate {
  readonly update_id: number;
  readonly message?: TelegramMessage;
  readonly callback_query?: {
    readonly id: string;
    readonly data?: string;
    readonly message?: TelegramMessage;
  };
}

interface TelegramMessage {
  readonly message_id: number;
  readonly chat: { readonly id: number };
  readonly from?: { readonly id: number; readonly first_name?: string; readonly username?: string };
  readonly text?: string;
  readonly date: number;
}

interface InlineKeyboardButton {
  readonly text: string;
  readonly url?: string;
  readonly web_app?: { readonly url: string };
  readonly callback_data?: string;
}

// Per-chat conversation state for multi-turn
interface ChatState {
  messages: LlmMessage[];
  tools: PmlTool[];
  lastActivity: number;
  /** Tracked tool calls for trace building. */
  toolCalls: TaskResultEntry[];
  /** Current DAG layer (incremented per LLM turn with tool calls). */
  currentLayer: number;
  /** Timestamp when the agent loop started. */
  loopStartedAt: number;
  /** Last workflow_id from PML execute response (= traceId per ADR-065). */
  lastWorkflowId?: string;
}

// ---------------------------------------------------------------------------
// Bot
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `Tu es un assistant connecte a PML (Procedural Memory Layer) via des outils MCP.

## Comment ca marche
Les outils fournis sont les plus pertinents pour la demande de l'utilisateur.
Ils ont ete selectionnes par recherche semantique sur l'intent. Utilise-les directement.
Chaque outil peut etre un outil MCP brut (psql_query, read_file, git_status...)
ou une capability apprise — tu les appelles de la meme maniere.

## Regles
- Appelle les outils DIRECTEMENT — ne dis jamais "je vais utiliser l'outil X"
- Pour les questions de donnees, appelle les outils pertinents
- Pour les questions conversationnelles (salut, explique-moi...), reponds directement sans outil
- Si un outil necessite des parametres manquants, pose UNE question courte
- Reponds TOUJOURS en francais, de maniere concise
- N'invente jamais de donnees — utilise les outils
- Si un outil echoue, rapporte l'erreur telle quelle
- Sois concis : rapporte le resultat, pas plus`;

export class TelegramBot {
  private readonly config: TelegramBotConfig;
  private readonly pml: PmlClient;
  private readonly llm: LlmClient;
  private readonly chatStates = new Map<number, ChatState>();
  private pollingOffset = 0;
  private pollingActive = false;

  constructor(config: TelegramBotConfig) {
    this.config = config;
    this.pml = new PmlClient(config.pmlUrl, config.debug);
    this.llm = new LlmClient({
      apiKey: config.openaiApiKey,
      model: config.openaiModel ?? "gpt-5-mini",
    });
  }

  private log(...args: unknown[]): void {
    if (this.config.debug) {
      console.log("[TelegramBot]", ...args);
    }
  }

  // -------------------------------------------------------------------------
  // Telegram API
  // -------------------------------------------------------------------------

  private async api(method: string, body?: Record<string, unknown>): Promise<unknown> {
    const url = `https://api.telegram.org/bot${this.config.botToken}/${method}`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json();
    if (!data.ok) {
      this.log(`API error (${method}):`, data.description);
    }
    return data.result;
  }

  async sendMessage(
    chatId: number,
    text: string,
    options?: {
      parseMode?: "Markdown" | "HTML";
      replyMarkup?: { inline_keyboard: InlineKeyboardButton[][] };
    },
  ): Promise<void> {
    // Telegram limit: 4096 chars
    const truncated = text.length > 4000
      ? text.slice(0, 4000) + "\n... (tronque)"
      : text;
    await this.api("sendMessage", {
      chat_id: chatId,
      text: truncated,
      parse_mode: options?.parseMode ?? "HTML",
      reply_markup: options?.replyMarkup,
    });
  }

  async sendChatAction(chatId: number, action = "typing"): Promise<void> {
    await this.api("sendChatAction", { chat_id: chatId, action });
  }

  // -------------------------------------------------------------------------
  // Webhook
  // -------------------------------------------------------------------------

  async setWebhook(url: string): Promise<void> {
    await this.api("setWebhook", { url });
    this.log("Webhook set to:", url);
  }

  async deleteWebhook(): Promise<void> {
    await this.api("deleteWebhook");
    this.log("Webhook deleted");
  }

  async handleWebhook(request: Request): Promise<Response> {
    try {
      const update: TelegramUpdate = await request.json();
      await this.processUpdate(update);
      return new Response("ok", { status: 200 });
    } catch (err) {
      this.log("Webhook error:", err);
      return new Response("ok", { status: 200 });
    }
  }

  // -------------------------------------------------------------------------
  // Polling
  // -------------------------------------------------------------------------

  async startPolling(): Promise<void> {
    this.pollingActive = true;
    await this.deleteWebhook();
    this.log("Polling started");

    while (this.pollingActive) {
      try {
        const updates = await this.api("getUpdates", {
          offset: this.pollingOffset,
          timeout: 30,
        }) as TelegramUpdate[] | undefined;

        if (updates && updates.length > 0) {
          for (const update of updates) {
            this.pollingOffset = update.update_id + 1;
            await this.processUpdate(update);
          }
        }
      } catch (err) {
        this.log("Polling error:", err);
        await new Promise((r) => setTimeout(r, 5000));
      }
    }
  }

  stopPolling(): void {
    this.pollingActive = false;
  }

  // -------------------------------------------------------------------------
  // Message processing — Agentic loop
  // -------------------------------------------------------------------------

  private async processUpdate(update: TelegramUpdate): Promise<void> {
    if (update.message?.text) {
      await this.processMessage(update.message);
    }
  }

  private async processMessage(message: TelegramMessage): Promise<void> {
    const chatId = message.chat.id;
    const text = message.text ?? "";
    const userName = message.from?.first_name ?? "User";

    this.log(`Message from ${userName}: "${text.slice(0, 80)}"`);

    if (text === "/start") {
      this.chatStates.delete(chatId);
      await this.sendMessage(chatId, [
        `Salut ${this.escapeHtml(userName)} !`,
        "",
        "Je suis connecte a des outils MCP. Demande-moi quelque chose !",
        "",
        "Exemples :",
        "- genere un uuid",
        "- donne une palette de couleurs pour le bleu",
        "- cree des donnees de test",
        "- quelle heure est-il ?",
      ].join("\n"));
      return;
    }

    if (text === "/reset") {
      this.chatStates.delete(chatId);
      await this.sendMessage(chatId, "Conversation reinitialise.");
      return;
    }

    await this.sendChatAction(chatId);

    try {
      await this.agentLoop(chatId, text);
    } catch (err) {
      this.log("Error:", err);
      const errorMsg = err instanceof Error ? err.message : String(err);
      await this.sendMessage(chatId, `Erreur: ${this.escapeHtml(errorMsg)}`);
    }
  }

  /**
   * Core agentic loop:
   * 1. Discover tools matching the intent
   * 2. Build LLM tool definitions from PML tools
   * 3. Call LLM with conversation history + tools
   * 4. If LLM returns tool_calls → execute via PML → feed results back → loop
   * 5. If LLM returns text → send to user
   */
  private async agentLoop(chatId: number, userText: string): Promise<void> {
    const maxTurns = this.config.maxAgentTurns ?? 5;

    // Get or create chat state
    let state = this.chatStates.get(chatId);

    // Discover tools for this message
    const limit = this.config.discoverLimit ?? 8;
    const discovered = await this.pml.discover(userText, limit);
    const validTools = discovered.results.filter((t) => t.server_id);
    this.log(`Discovered ${validTools.length} valid tools`);

    if (!state || validTools.length > 0) {
      // New conversation or refresh tools
      const llmTools = this.pmlToolsToLlm(validTools);
      state = {
        messages: [{ role: "system", content: SYSTEM_PROMPT }],
        tools: validTools,
        lastActivity: Date.now(),
        toolCalls: [],
        currentLayer: 0,
        loopStartedAt: Date.now(),
      };
      this.chatStates.set(chatId, state);
      state.messages.push({ role: "user", content: userText });

      // Agentic turns — force tool call on first turn ("required"), then "auto"
      for (let turn = 0; turn < maxTurns; turn++) {
        await this.sendChatAction(chatId);
        const toolChoice = turn === 0 ? "required" as const : "auto" as const;
        const response = await this.llm.chat(state.messages, llmTools, toolChoice);
        state.messages.push(response.assistantMessage);
        state.lastActivity = Date.now();

        if (response.finishReason === "stop") {
          if (response.text) {
            await this.sendFinalResponse(chatId, state, response.text);
          }
          return;
        }

        // LLM wants to call tools
        if (response.toolCalls.length > 0) {
          await this.handleToolCalls(chatId, state, response.toolCalls, validTools);
        }
      }

      await this.sendMessage(chatId, "J'ai atteint la limite de tours. Reformule ta demande.");
    } else {
      // Continue existing conversation (user answering a follow-up question)
      state.messages.push({ role: "user", content: userText });
      state.lastActivity = Date.now();
      state.toolCalls = [];
      state.currentLayer = 0;
      state.loopStartedAt = Date.now();
      const llmTools = this.pmlToolsToLlm(state.tools);

      for (let turn = 0; turn < maxTurns; turn++) {
        await this.sendChatAction(chatId);
        const toolChoice = turn === 0 ? "required" as const : "auto" as const;
        const response = await this.llm.chat(state.messages, llmTools, toolChoice);
        state.messages.push(response.assistantMessage);

        if (response.finishReason === "stop") {
          if (response.text) {
            await this.sendFinalResponse(chatId, state, response.text);
          }
          return;
        }

        if (response.toolCalls.length > 0) {
          await this.handleToolCalls(chatId, state, response.toolCalls, state.tools);
        }
      }

      await this.sendMessage(chatId, "J'ai atteint la limite de tours. Reformule ta demande.");
    }

    // Cleanup old states (> 10 min)
    const now = Date.now();
    for (const [id, s] of this.chatStates) {
      if (now - s.lastActivity > 10 * 60 * 1000) {
        this.chatStates.delete(id);
      }
    }
  }

  /**
   * Execute LLM tool calls via PML and add results to conversation history.
   * Also tracks each call for trace building.
   */
  private async handleToolCalls(
    chatId: number,
    state: ChatState,
    toolCalls: LlmToolCall[],
    pmlTools: PmlTool[],
  ): Promise<void> {
    const layerIndex = state.currentLayer;

    for (const tc of toolCalls) {
      // Refresh typing indicator (Telegram expires it after ~5s)
      await this.sendChatAction(chatId);
      const toolName = tc.function.name;
      let args: Record<string, unknown>;
      try {
        args = JSON.parse(tc.function.arguments);
      } catch {
        args = {};
      }

      this.log(`LLM tool_call: ${toolName}(${JSON.stringify(args)})`);

      // Find the PML tool
      const pmlTool = pmlTools.find(
        (t) => this.llmToolName(t) === toolName,
      );

      if (!pmlTool) {
        state.messages.push({
          role: "tool",
          tool_call_id: tc.id,
          content: JSON.stringify({ error: `Unknown tool: ${toolName}` }),
        });
        continue;
      }

      // Execute via PML
      const callName = getToolCallName(pmlTool);
      const code = buildExecuteCode(callName, args);
      this.log(`Executing: ${code}`);

      const startMs = Date.now();
      try {
        const result = await this.pml.execute(code, toolName);
        const durationMs = Date.now() - startMs;
        this.log(`Result: hasUi=${result.hasUi}, workflowId=${result.workflowId}, text=${result.text.slice(0, 80)}`);

        // Capture workflowId (= traceId) for real trace fetching
        if (result.workflowId) {
          state.lastWorkflowId = result.workflowId;
        }

        // Track for trace
        state.toolCalls.push({
          taskId: tc.id,
          tool: callName,
          success: true,
          durationMs,
          layerIndex,
        });

        // Add tool result to conversation
        state.messages.push({
          role: "tool",
          tool_call_id: tc.id,
          content: result.text || "OK (no output)",
        });

        // If tool has UI, store for keyboard later
        if (result.hasUi) {
          (state as unknown as Record<string, unknown>)._lastUiResult = result;
        }
      } catch (err) {
        const durationMs = Date.now() - startMs;
        const msg = err instanceof Error ? err.message : String(err);
        this.log(`Execute error: ${msg}`);

        // Track failed call
        state.toolCalls.push({
          taskId: tc.id,
          tool: callName,
          success: false,
          durationMs,
          layerIndex,
        });

        state.messages.push({
          role: "tool",
          tool_call_id: tc.id,
          content: JSON.stringify({ error: msg }),
        });
      }
    }

    // Advance layer for next round of tool calls
    state.currentLayer++;
  }

  // -------------------------------------------------------------------------
  // Tool conversion: PML → LLM format
  // -------------------------------------------------------------------------

  private pmlToolsToLlm(tools: PmlTool[]): LlmTool[] {
    return tools.map((t) => ({
      type: "function" as const,
      function: {
        name: this.llmToolName(t),
        description: t.description,
        parameters: t.input_schema ?? { type: "object", properties: {} },
      },
    }));
  }

  /** Create a safe LLM tool name from PML tool (alphanumeric + underscores). */
  private llmToolName(tool: PmlTool): string {
    const callName = getToolCallName(tool);
    return callName.replace(/[^a-zA-Z0-9_]/g, "_");
  }

  // -------------------------------------------------------------------------
  // Response with UI button
  // -------------------------------------------------------------------------

  /**
   * Send the LLM's final text response, with a Mini App button
   * if any tool during the conversation had _meta.ui.
   * Also sends a "View Trace" button when tool calls were tracked.
   */
  private async sendFinalResponse(
    chatId: number,
    state: ChatState,
    text: string,
  ): Promise<void> {
    const lastUi = (state as unknown as Record<string, unknown>)._lastUiResult as PmlExecuteResult | undefined;
    const buttons: InlineKeyboardButton[] = [];

    // Tool UI button (if any tool had _meta.ui)
    if (lastUi?.hasUi && lastUi.uiResourceUri) {
      const encodedUri = encodeURIComponent(lastUi.uiResourceUri);
      let uiUrl = `${this.config.bridgeBaseUrl}/ui?uri=${encodedUri}`;

      if (this.config.storeToolResult) {
        const ref = this.config.storeToolResult({
          content: [{ type: "text", text: lastUi.text }],
        });
        uiUrl += `&ref=${ref}`;
        this.log(`Stored tool result ref=${ref} for UI push`);
      }

      if (uiUrl.startsWith("https://")) {
        buttons.push({ text: "Ouvrir dans l'app", web_app: { url: uiUrl } });
      } else {
        buttons.push({ text: "Ouvrir le resultat", url: uiUrl });
      }
      delete (state as unknown as Record<string, unknown>)._lastUiResult;
    }

    // Trace viewer button (when any tool calls were tracked)
    if (state.toolCalls.length > 0 && this.config.storeToolResult) {
      const trace = await this.fetchOrBuildTrace(state);
      const ref = this.config.storeToolResult({
        content: [{ type: "text", text: JSON.stringify(trace) }],
      });

      const traceUrl = `${this.config.bridgeBaseUrl}/trace-viewer?ref=${ref}`;
      const tr = trace as { taskResults?: unknown[]; durationMs?: number };
      this.log(`Stored trace ref=${ref} (${tr.taskResults?.length ?? "?"} tasks, ${tr.durationMs ?? "?"}ms)`);

      if (traceUrl.startsWith("https://")) {
        buttons.push({ text: "\uD83D\uDD0D Trace", web_app: { url: traceUrl } });
      } else {
        buttons.push({ text: "\uD83D\uDD0D Trace", url: traceUrl });
      }
    }

    const keyboard = buttons.length > 0
      ? { inline_keyboard: [buttons] }
      : undefined;

    await this.sendMessage(chatId, this.escapeHtml(text), {
      replyMarkup: keyboard,
    });
  }

  /**
   * Fetch real execution trace from PML cloud API, or fall back to synthetic trace.
   * Uses the workflowId (= traceId per ADR-065) captured during tool execution.
   */
  private async fetchOrBuildTrace(state: ChatState): Promise<Record<string, unknown>> {
    // Try fetching real trace from cloud API (with retry — TraceSyncer flushes async)
    if (state.lastWorkflowId && this.config.cloudApiUrl) {
      const url = `${this.config.cloudApiUrl}/api/traces/${state.lastWorkflowId}`;
      const headers: Record<string, string> = {};
      if (this.config.cloudApiKey) {
        headers["x-api-key"] = this.config.cloudApiKey;
      }

      for (let attempt = 0; attempt < 3; attempt++) {
        if (attempt > 0) {
          this.log(`Trace fetch retry ${attempt}/2 (waiting ${attempt}s)...`);
          await new Promise((r) => setTimeout(r, attempt * 1000));
        }
        try {
          this.log(`Fetching real trace: ${url}`);
          const resp = await fetch(url, { headers });

          if (resp.ok) {
            const trace = await resp.json();
            if (trace.taskResults) {
              this.log(`Got real trace: ${trace.taskResults.length} tasks, ${trace.durationMs}ms`);
              return trace;
            }
          } else if (resp.status === 404 && attempt < 2) {
            continue; // Trace not yet flushed, retry
          } else {
            this.log(`Trace fetch failed: ${resp.status} ${resp.statusText}`);
            break;
          }
        } catch (err) {
          this.log(`Trace fetch error: ${err}`);
          break;
        }
      }
    }

    // Fallback: build synthetic trace from tracked tool calls
    const totalDuration = Date.now() - state.loopStartedAt;
    const allOk = state.toolCalls.every((tc) => tc.success);

    return {
      id: `trace-${Date.now().toString(36)}`,
      success: allOk,
      durationMs: totalDuration,
      priority: 0,
      taskResults: state.toolCalls,
    };
  }

  // -------------------------------------------------------------------------
  // Formatting
  // -------------------------------------------------------------------------

  private escapeHtml(text: string): string {
    return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }
}
