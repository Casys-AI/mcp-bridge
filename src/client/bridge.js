/**
 * MCP Apps Bridge — Client-side runtime.
 *
 * Injected by the resource server into MCP App HTML pages.
 * Intercepts postMessage calls from the MCP App class, routes them
 * to the resource server via WebSocket, and dispatches responses
 * back as MessageEvents.
 *
 * Query parameters (set by the resource server on the <script> tag):
 *   - platform: "telegram" | "line"
 *   - session: session ID (created by the resource server)
 *
 * @module bridge.js
 */
(function () {
  "use strict";

  // ---------------------------------------------------------------------------
  // Read configuration from script tag query params
  // ---------------------------------------------------------------------------

  var currentScript = document.currentScript;
  if (!currentScript) {
    console.error("[bridge.js] Cannot find own <script> element.");
    return;
  }

  var scriptUrl = new URL(currentScript.src);
  var PLATFORM = scriptUrl.searchParams.get("platform") || "unknown";
  var SESSION_ID = scriptUrl.searchParams.get("session");
  if (!SESSION_ID) {
    console.error("[bridge.js] Missing 'session' query parameter.");
    return;
  }

  var WS_BASE = scriptUrl.origin;
  var WS_URL = WS_BASE.replace(/^http/, "ws") + "/bridge?session=" + SESSION_ID;
  var DEBUG = scriptUrl.searchParams.get("debug") === "1";

  function log() {
    if (DEBUG) {
      console.log.apply(console, ["[bridge.js]"].concat(Array.prototype.slice.call(arguments)));
    }
  }

  log("Platform:", PLATFORM, "Session:", SESSION_ID);

  // ---------------------------------------------------------------------------
  // JSON-RPC helpers
  // ---------------------------------------------------------------------------

  function isJsonRpc(msg) {
    return msg && typeof msg === "object" && msg.jsonrpc === "2.0";
  }

  function isRequest(msg) {
    return "method" in msg && "id" in msg;
  }

  function isResponse(msg) {
    return ("result" in msg || "error" in msg) && "id" in msg;
  }

  // ---------------------------------------------------------------------------
  // Platform detection: Telegram theme
  // ---------------------------------------------------------------------------

  function getTelegramTheme() {
    var tg = window.Telegram && window.Telegram.WebApp;
    if (!tg) {
      return {
        theme: "light",
        styles: { variables: {} },
        platform: "mobile",
      };
    }

    var isDark = tg.colorScheme === "dark";
    var tp = tg.themeParams || {};
    var variables = {};
    var keys = Object.keys(tp);
    for (var i = 0; i < keys.length; i++) {
      variables["--tg-" + keys[i].replace(/_/g, "-")] = tp[keys[i]];
    }

    return {
      theme: isDark ? "dark" : "light",
      styles: { variables: variables },
      platform: "mobile",
      locale: tg.initDataUnsafe && tg.initDataUnsafe.user
        ? tg.initDataUnsafe.user.language_code
        : undefined,
    };
  }

  // ---------------------------------------------------------------------------
  // Request tracking (for matching responses to outgoing requests)
  // ---------------------------------------------------------------------------

  var pendingRequests = {}; // id -> { resolve, reject, timer }
  var REQUEST_TIMEOUT_MS = 30000;
  var appInitialized = false;
  var earlyNotifications = []; // notifications received before ui/initialize

  function trackRequest(id) {
    return new Promise(function (resolve, reject) {
      var timer = setTimeout(function () {
        delete pendingRequests[id];
        reject(new Error("Request " + id + " timed out after " + REQUEST_TIMEOUT_MS + "ms"));
      }, REQUEST_TIMEOUT_MS);

      pendingRequests[id] = { resolve: resolve, reject: reject, timer: timer };
    });
  }

  function resolveRequest(id, result) {
    var entry = pendingRequests[id];
    if (entry) {
      clearTimeout(entry.timer);
      delete pendingRequests[id];
      entry.resolve(result);
    }
  }

  function rejectRequest(id, error) {
    var entry = pendingRequests[id];
    if (entry) {
      clearTimeout(entry.timer);
      delete pendingRequests[id];
      entry.reject(error);
    }
  }

  // ---------------------------------------------------------------------------
  // ui/initialize handler (synthesized locally)
  // ---------------------------------------------------------------------------

  function handleInitialize(requestId) {
    var hostCtx = getTelegramTheme();

    var response = {
      jsonrpc: "2.0",
      id: requestId,
      result: {
        protocolVersion: "2025-11-25",
        hostInfo: {
          name: "@casys/mcp-apps-bridge",
          version: "0.1.0",
        },
        hostCapabilities: {
          serverTools: { listChanged: false },
          serverResources: { listChanged: false },
          logging: {},
          openLinks: {},
        },
        hostContext: hostCtx,
      },
    };

    dispatchToApp(response);

    // App is now ready — flush any notifications received before init
    appInitialized = true;
    if (earlyNotifications.length > 0) {
      log("Flushing", earlyNotifications.length, "early notification(s)");
      for (var i = 0; i < earlyNotifications.length; i++) {
        dispatchToApp(earlyNotifications[i]);
      }
      earlyNotifications = [];
    }
  }

  // ---------------------------------------------------------------------------
  // Dispatch to App (via MessageEvent on window)
  // ---------------------------------------------------------------------------

  function dispatchToApp(message) {
    log("-> App:", message.method || ("id" in message ? "response#" + message.id : "?"));
    // Use real postMessage so event.source === window (=== window.parent in standalone).
    // The MCP Apps SDK checks event.source — dispatchEvent leaves it null.
    // Use the script origin as targetOrigin instead of "*" to prevent message leaking.
    _realPostMessage(message, scriptUrl.origin);
  }

  // ---------------------------------------------------------------------------
  // WebSocket connection
  // ---------------------------------------------------------------------------

  var ws = null;
  var reconnectAttempts = 0;
  var MAX_RECONNECT = 5;
  var authenticated = false;

  function connectWs() {
    log("Connecting to", WS_URL);
    ws = new WebSocket(WS_URL);

    ws.onopen = function () {
      log("WebSocket connected");
      reconnectAttempts = 0;

      // Send auth immediately if Telegram SDK is available
      var tg = window.Telegram && window.Telegram.WebApp;
      if (tg && tg.initData) {
        log("Sending Telegram auth...");
        ws.send(JSON.stringify({ type: "auth", initData: tg.initData }));
      } else {
        // No Telegram SDK — server will decide if auth is required
        log("No Telegram SDK, dispatching ready without auth");
        authenticated = true;
        window.dispatchEvent(new CustomEvent("mcp-bridge-ready", {
          detail: { platform: PLATFORM, session: SESSION_ID },
        }));
      }
    };

    ws.onmessage = function (event) {
      try {
        var msg = JSON.parse(event.data);
        // Handle auth responses (non-JSON-RPC)
        if (msg && msg.type === "auth_ok") {
          log("Authenticated, userId:", msg.userId);
          authenticated = true;
          window.dispatchEvent(new CustomEvent("mcp-bridge-ready", {
            detail: { platform: PLATFORM, session: SESSION_ID, userId: msg.userId },
          }));
          return;
        }

        if (msg && msg.type === "auth_error") {
          console.error("[bridge.js] Authentication failed:", msg.error);
          window.dispatchEvent(new CustomEvent("mcp-bridge-auth-error", {
            detail: { error: msg.error },
          }));
          return;
        }

        if (!isJsonRpc(msg)) return;

        // Responses: resolve tracked requests
        if (isResponse(msg)) {
          if ("error" in msg) {
            rejectRequest(msg.id, msg.error);
          } else {
            resolveRequest(msg.id, msg.result);
          }
          // The trackRequest().then() will call dispatchToApp
          return;
        }

        // Notifications from server
        if ("method" in msg && !("id" in msg)) {
          if (!appInitialized) {
            log("Queuing early notification:", msg.method);
            earlyNotifications.push(msg);
          } else {
            dispatchToApp(msg);
          }
        }
      } catch (err) {
        console.warn("[bridge.js] Failed to parse WS message:", err);
      }
    };

    ws.onclose = function () {
      log("WebSocket disconnected");
      ws = null;
      if (reconnectAttempts < MAX_RECONNECT) {
        reconnectAttempts++;
        var delay = Math.min(1000 * Math.pow(2, reconnectAttempts - 1), 10000);
        log("Reconnecting in", delay, "ms (attempt", reconnectAttempts + ")");
        setTimeout(connectWs, delay);
      }
    };

    ws.onerror = function () {
      log("WebSocket error");
    };
  }

  function sendToServer(message) {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      console.warn("[bridge.js] WebSocket not connected. Dropping message:", message);
      return;
    }
    if (!authenticated) {
      console.warn("[bridge.js] Not authenticated yet. Dropping message:", message);
      return;
    }
    ws.send(JSON.stringify(message));
  }

  // ---------------------------------------------------------------------------
  // Intercept postMessage (App -> Bridge)
  // ---------------------------------------------------------------------------

  // Save the REAL postMessage before we monkey-patch it.
  // Used by dispatchToApp() so that event.source === window,
  // which the MCP Apps SDK checks (event.source === window.parent).
  var _realPostMessage = window.postMessage.bind(window);

  var originalPostMessage = window.parent !== window
    ? window.parent.postMessage.bind(window.parent)
    : null;

  function interceptPostMessage() {
    if (window.parent === window) {
      // Not in a frame — intercept window.postMessage instead for standalone mode
      log("Intercepting window.postMessage (standalone mode)");
      var origSelf = window.postMessage.bind(window);
      window.postMessage = function (message, targetOrigin, transfer) {
        if (isJsonRpc(message)) {
          handleOutgoing(message);
        } else {
          origSelf(message, targetOrigin, transfer);
        }
      };
      return;
    }

    log("Intercepting window.parent.postMessage (iframe mode)");
    window.parent.postMessage = function (message, targetOrigin, transfer) {
      if (isJsonRpc(message)) {
        handleOutgoing(message);
      } else if (originalPostMessage) {
        originalPostMessage(message, targetOrigin, transfer);
      }
    };
  }

  function handleOutgoing(message) {
    log("<- App:", message.method || "response");

    // ui/initialize — handle locally
    if (message.method === "ui/initialize" && "id" in message) {
      handleInitialize(message.id);
      return;
    }

    // ui/open-link — handle locally via Telegram API or fallback
    if (message.method === "ui/open-link" && "id" in message) {
      var url = message.params && message.params.url;
      if (url) {
        var tg = window.Telegram && window.Telegram.WebApp;
        if (tg && tg.openLink) {
          tg.openLink(url);
        } else {
          window.open(url, "_blank");
        }
      }
      dispatchToApp({ jsonrpc: "2.0", id: message.id, result: {} });
      return;
    }

    // Forward to resource server via WebSocket
    sendToServer(message);

    // Track requests for response matching
    if (isRequest(message)) {
      trackRequest(message.id)
        .then(function (result) {
          dispatchToApp({ jsonrpc: "2.0", id: message.id, result: result });
        })
        .catch(function (err) {
          dispatchToApp({
            jsonrpc: "2.0",
            id: message.id,
            error: { code: -32603, message: err.message || String(err) },
          });
        });
    }
  }

  // ---------------------------------------------------------------------------
  // Telegram lifecycle events
  // ---------------------------------------------------------------------------

  function setupTelegramEvents() {
    var tg = window.Telegram && window.Telegram.WebApp;
    if (!tg) return;

    // Tell Telegram we're ready
    tg.ready();
    if (!tg.isExpanded) tg.expand();

    // Theme changes
    if (typeof tg.onEvent === "function") {
      tg.onEvent("themeChanged", function () {
        var ctx = getTelegramTheme();
        dispatchToApp({
          jsonrpc: "2.0",
          method: "ui/notifications/host-context-changed",
          params: { theme: ctx.theme, styles: ctx.styles },
        });
      });

      tg.onEvent("viewportChanged", function () {
        dispatchToApp({
          jsonrpc: "2.0",
          method: "ui/notifications/host-context-changed",
          params: {
            containerDimensions: {
              width: window.innerWidth,
              height: tg.viewportStableHeight || window.innerHeight,
            },
          },
        });
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Boot
  // ---------------------------------------------------------------------------

  interceptPostMessage();
  connectWs();

  if (PLATFORM === "telegram") {
    setupTelegramEvents();
  }

  log("Bridge initialized for", PLATFORM);
})();
