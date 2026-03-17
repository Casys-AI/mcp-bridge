/**
 * LLM Client — OpenAI-compatible chat completions with tool_use.
 *
 * Stateless: caller manages conversation history per chat.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface LlmTool {
  readonly type: "function";
  readonly function: {
    readonly name: string;
    readonly description: string;
    readonly parameters: Record<string, unknown>;
  };
}

export interface LlmMessage {
  readonly role: "system" | "user" | "assistant" | "tool";
  readonly content?: string | null;
  readonly tool_calls?: LlmToolCall[];
  readonly tool_call_id?: string;
}

export interface LlmToolCall {
  readonly id: string;
  readonly type: "function";
  readonly function: {
    readonly name: string;
    readonly arguments: string;
  };
}

export interface LlmResponse {
  /** "stop" = text reply, "tool_calls" = wants to call tools */
  readonly finishReason: "stop" | "tool_calls";
  /** Text content (when finishReason = "stop") */
  readonly text: string | null;
  /** Tool calls (when finishReason = "tool_calls") */
  readonly toolCalls: LlmToolCall[];
  /** Full assistant message (for appending to history) */
  readonly assistantMessage: LlmMessage;
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export class LlmClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly model: string;

  constructor(options: {
    apiKey: string;
    baseUrl?: string;
    model?: string;
  }) {
    this.apiKey = options.apiKey;
    this.baseUrl = (options.baseUrl ?? "https://api.openai.com/v1").replace(/\/$/, "");
    this.model = options.model ?? "gpt-5-mini";
  }

  /**
   * Chat completion with optional tools.
   * Returns the assistant's response (text or tool calls).
   */
  async chat(
    messages: LlmMessage[],
    tools?: LlmTool[],
    toolChoice?: "auto" | "required",
  ): Promise<LlmResponse> {
    const body: Record<string, unknown> = {
      model: this.model,
      messages,
    };

    if (tools && tools.length > 0) {
      body.tools = tools;
      body.tool_choice = toolChoice ?? "auto";
    }

    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`LLM API error (${res.status}): ${errText}`);
    }

    const data = await res.json();
    const choice = data.choices?.[0];
    if (!choice) {
      throw new Error("LLM returned no choices");
    }

    const msg = choice.message;
    const finishReason = choice.finish_reason === "tool_calls" ? "tool_calls" : "stop";

    return {
      finishReason,
      text: msg.content ?? null,
      toolCalls: msg.tool_calls ?? [],
      assistantMessage: {
        role: "assistant",
        content: msg.content ?? null,
        tool_calls: msg.tool_calls,
      },
    };
  }
}
