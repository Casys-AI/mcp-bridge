/**
 * Demo: Telegram Bot with agentic LLM loop + PML tools.
 *
 * The bot discovers MCP tools, lets the LLM decide which to call
 * (with correct params), and sends the results back via Telegram.
 *
 * Also starts a resource server that proxies ui:// resources from PML,
 * injecting bridge.js for bi-directional WebSocket communication in
 * Telegram Mini Apps.
 *
 * Usage:
 *   TELEGRAM_BOT_TOKEN=xxx OPENAI_API_KEY=xxx \
 *     deno run --allow-net --allow-env examples/demo-bot/start.ts
 */

import { TelegramBot } from "./telegram-bot.ts";
import { PmlClient, buildExecuteCode } from "./pml-client.ts";
import { startResourceServer } from "../../src/resource-server/server.ts";

// ---------------------------------------------------------------------------
// Config from env
// ---------------------------------------------------------------------------

const botToken = Deno.env.get("TELEGRAM_BOT_TOKEN");
const openaiApiKey = Deno.env.get("OPENAI_API_KEY");

if (!botToken || !openaiApiKey) {
  console.error(`
  ERROR: Missing required environment variables.

  Usage:
    TELEGRAM_BOT_TOKEN=xxx OPENAI_API_KEY=xxx \\
      deno run --allow-net --allow-env examples/demo-bot/start.ts

  Optional:
    PML_URL            PML serve URL (default: http://localhost:3004)
    PML_DASHBOARD_URL  PML dashboard URL for UI resources (default: http://localhost:8081)
    OPENAI_MODEL       LLM model (default: gpt-5-mini)
    WEBHOOK_URL        Webhook URL (if set, uses webhook mode)
    BOT_PORT           Webhook server port (default: 4001)
    BRIDGE_PORT        Resource server port for UI proxy (default: 4000)
  `);
  Deno.exit(1);
}

const pmlUrl = Deno.env.get("PML_URL") ?? "http://localhost:3004";
const pmlDashboardUrl = Deno.env.get("PML_DASHBOARD_URL") ?? "http://localhost:8081";
const webhookUrl = Deno.env.get("WEBHOOK_URL");
const openaiModel = Deno.env.get("OPENAI_MODEL");
const bridgePort = parseInt(Deno.env.get("BRIDGE_PORT") ?? "4000", 10);

// ---------------------------------------------------------------------------
// Resource server — proxies ui:// resources from PML with bridge.js injection
// ---------------------------------------------------------------------------

const pmlForProxy = new PmlClient(pmlUrl, true);

// Auth is enforced: Telegram injects initData when opening a web_app button.
// bridge.js sends { type: "auth", initData } on WS connect.
// The server validates the HMAC-SHA256 signature before accepting tool calls.
const resourceServer = startResourceServer({
  assetDirectories: {},
  platform: "telegram",
  telegramBotToken: botToken,
  csp: {
    scriptSources: ["https://telegram.org"],
    connectSources: [`ws://localhost:${bridgePort}`, "wss://pml.casys.ai"],
    frameAncestors: [
      "https://web.telegram.org",
      "https://desktop-app.telegram.org",
    ],
  },
  options: {
    resourceServerPort: bridgePort,
    debug: true,
  },
  onHttpRequest: async (request: Request) => {
    const url = new URL(request.url);

    // Trace viewer: GET /trace-viewer?ref=xxx
    if (url.pathname === "/trace-viewer" && request.method === "GET") {
      try {
        const traceViewerPath = new URL("../trace-viewer/index.html", import.meta.url);
        const html = await (await fetch(traceViewerPath)).text();
        return { html };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.log(`[TraceViewer] Error loading HTML: ${msg}`);
        return new Response("Trace viewer not found", { status: 500 });
      }
    }

    // Proxy ui:// resources from PML dashboard: GET /ui?uri=ui://...
    if (url.pathname === "/ui" && request.method === "GET") {
      const uri = url.searchParams.get("uri");
      if (!uri || !uri.startsWith("ui://")) {
        return new Response("Missing or invalid ?uri parameter", { status: 400 });
      }

      // Fetch HTML from the PML dashboard API (not MCP JSON-RPC)
      const apiUrl = `${pmlDashboardUrl}/api/ui/resource?uri=${encodeURIComponent(uri)}`;
      console.log(`[UIProxy] Fetching ${uri} from ${apiUrl}`);

      try {
        const res = await fetch(apiUrl);
        if (!res.ok) {
          const errText = await res.text();
          console.log(`[UIProxy] Dashboard returned ${res.status}: ${errText.slice(0, 100)}`);
          return new Response(`Resource not found: ${uri}`, { status: 404 });
        }

        const html = await res.text();

        // The server automatically handles ?ref= and attaches
        // tool-result notifications — no manual handling needed here.
        return { html };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.log(`[UIProxy] Fetch error: ${msg}`);
        return new Response(`Failed to fetch resource: ${msg}`, { status: 502 });
      }
    }

    return null;
  },
  onMessage: async (_session, message) => {
    console.log(`[Bridge] Received:`, JSON.stringify(message).slice(0, 200));
    // Forward JSON-RPC tool calls from the Mini App webview to PML
    if ("method" in message && "id" in message) {
      const req = message as { method: string; id: string | number; params?: Record<string, unknown> };
      if (req.method === "tools/call") {
        const toolName = req.params?.name as string | undefined;
        const args = req.params?.arguments as Record<string, unknown> | undefined;

        if (toolName) {
          console.log(`[Bridge→PML] tools/call: ${toolName}`);
          try {
            const code = buildExecuteCode(toolName, args ?? {});
            const result = await pmlForProxy.execute(code, toolName);

            return {
              jsonrpc: "2.0" as const,
              id: req.id,
              result: {
                content: [{ type: "text", text: result.text }],
              },
            };
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            return {
              jsonrpc: "2.0" as const,
              id: req.id,
              error: { code: -32603, message: msg },
            };
          }
        }
      }
    }
    return null;
  },
});

// BRIDGE_URL overrides the public-facing URL (e.g. https://pml.casys.ai)
// The resource server still runs locally; Caddy/nginx proxies /ui to it.
const bridgeBaseUrl = Deno.env.get("BRIDGE_URL") ?? resourceServer.baseUrl;

// ---------------------------------------------------------------------------
// Start bot
// ---------------------------------------------------------------------------

const bot = new TelegramBot({
  botToken,
  pmlUrl,
  bridgeBaseUrl,
  openaiApiKey,
  openaiModel,
  cloudApiUrl: Deno.env.get("API_URL") ?? "http://localhost:3003",
  debug: true,
  storeToolResult: (result) => resourceServer.storeToolResult(result),
});

if (webhookUrl) {
  await bot.setWebhook(webhookUrl);
  const port = parseInt(Deno.env.get("BOT_PORT") ?? "4001", 10);

  // deno-lint-ignore no-explicit-any
  (Deno as any).serve({ port }, async (request: Request) => {
    const url = new URL(request.url);
    if (url.pathname === "/bot/webhook" && request.method === "POST") {
      return await bot.handleWebhook(request);
    }
    if (url.pathname === "/health") {
      return new Response("ok", { status: 200 });
    }
    return new Response("not found", { status: 404 });
  });

  console.log(`
====================================
  PML Bot — Webhook Mode (LLM Agent)
====================================

  Webhook:  ${webhookUrl}
  PML:      ${pmlUrl}
  Bridge:   ${bridgeBaseUrl}
  Model:    ${openaiModel ?? "gpt-5-mini"}
  Bot Port: ${port}

  UI proxy: ${bridgeBaseUrl}/ui?uri=ui://...

====================================
`);
} else {
  console.log(`
====================================
  PML Bot — Polling Mode (LLM Agent)
====================================

  PML:      ${pmlUrl}
  Bridge:   ${bridgeBaseUrl}
  Model:    ${openaiModel ?? "gpt-5-mini"}

  UI proxy: ${bridgeBaseUrl}/ui?uri=ui://...
  Waiting for messages...

====================================
`);

  await bot.startPolling();
}
