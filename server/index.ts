#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { WebSocketServer, WebSocket } from "ws";

const WS_PORT = parseInt(process.env.OPENCODE_BROWSER_PORT || "3002", 10);
const WS_HOST = process.env.OPENCODE_BROWSER_HOST || "0.0.0.0";

// System-one decision model endpoint (Jev/TypeSafe API shape: POST {endpoint}
// with {model, state, questions} -> {model, answers, usage}). Works with any
// provider exposing this same contract, e.g. https://api.typesafe.ai/v1/systemone
// or a self-hosted Laya instance at http://127.0.0.1:8008/v1/systemone.
const DECISION_ENDPOINT = process.env.DECISION_ENDPOINT || "";
const DECISION_API_KEY = process.env.DECISION_API_KEY || "";
const DECISION_MODEL = process.env.DECISION_MODEL || "jev-latest";
const DECISION_TIMEOUT_MS = parseInt(process.env.DECISION_TIMEOUT_MS || "5000", 10);
const DECISION_CONFIGURED = Boolean(DECISION_ENDPOINT && DECISION_API_KEY);

interface SystemOneQuestion {
  type: "choice" | "score" | "noul";
  instructions: string;
  criteria?: Record<string, string> | string[];
}

interface SystemOneAnswer {
  type: "choice" | "score" | "noul";
  choice?: string;
  score?: number;
  noul?: number;
  probabilities?: Record<string, number>;
  confidence?: number;
}

interface SystemOneResponse {
  model: string;
  answers: Record<string, SystemOneAnswer>;
  usage?: { input_tokens: number; output_tokens: number };
}

async function callSystemOne(
  state: string | Record<string, unknown> | unknown[],
  questions: Record<string, SystemOneQuestion>
): Promise<{ response: SystemOneResponse; latency_ms: number }> {
  if (!DECISION_ENDPOINT) {
    throw new Error(
      "DECISION_ENDPOINT is not set. Point it at a system-one decision endpoint " +
      "(e.g. DECISION_ENDPOINT=https://api.typesafe.ai/v1/systemone or " +
      "DECISION_ENDPOINT=http://127.0.0.1:8008/v1/systemone) to use chrome_rank_candidates."
    );
  }

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (DECISION_API_KEY) headers["Authorization"] = `Bearer ${DECISION_API_KEY}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DECISION_TIMEOUT_MS);

  const t0 = Date.now();
  try {
    const res = await fetch(DECISION_ENDPOINT, {
      method: "POST",
      headers,
      body: JSON.stringify({ model: DECISION_MODEL, state, questions }),
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`System-one endpoint returned ${res.status}: ${text.slice(0, 200)}`);
    }

    const data = (await res.json()) as SystemOneResponse;
    return { response: data, latency_ms: Date.now() - t0 };
  } catch (err: any) {
    clearTimeout(timer);
    if (err.name === "AbortError") {
      throw new Error(`System-one endpoint timed out after ${DECISION_TIMEOUT_MS}ms (${DECISION_ENDPOINT}). Is it running?`);
    }
    throw new Error(`Failed to reach system-one endpoint (${DECISION_ENDPOINT}): ${err.message}`);
  }
}

const wss = new WebSocketServer({
  port: WS_PORT,
  host: WS_HOST,
  verifyClient: () => true,
});

// clientId -> connection meta. Each Chrome profile runs its own extension
// service worker, so N profiles = N clients on one server.
const clients = new Map<string, { ws: WebSocket; label: string; version: string; connectedAt: number }>();
const wsToClient = new Map<WebSocket, string>();

function listClients() {
  return [...clients.entries()].map(([clientId, m]) => ({
    clientId,
    label: m.label,
    version: m.version,
    connectedAt: new Date(m.connectedAt).toISOString(),
    open: m.ws.readyState === WebSocket.OPEN,
  }));
}

wss.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EADDRINUSE") {
    console.error(
      `[opencode-browser] Port ${WS_PORT} already in use. ` +
      `Another instance may be running. ` +
      `Set OPENCODE_BROWSER_PORT env var to use a different port, ` +
      `then update the extension endpoint to match (ws://127.0.0.1:<port>).`
    );
    // Do NOT exit — MCP stdio transport still works; tools will return
    // "No extension connected" until the port frees up or is changed.
  } else {
    console.error("[opencode-browser] WebSocket server error:", err.message);
  }
});

wss.on("listening", () => {
  console.error(`[opencode-browser] WebSocket server started on ws://${WS_HOST}:${WS_PORT}`);
});

// Keep connections alive with server-side ping every 25s
const SERVER_PING_INTERVAL = 25000;
wss.on("connection", (ws) => {
  (ws as any).isAlive = true;

  ws.on("pong", () => { (ws as any).isAlive = true; });
  ws.on("message", (data) => {
    try {
      const msg = JSON.parse(data.toString());
      // Ignore keep-alive pings from extension
      if (msg.type === "ping") return;
      if (msg.type === "hello" && msg.clientId) {
        const clientId = String(msg.clientId);
        const previous = clients.get(clientId);
        // Same clientId reconnected on a new socket:drop the stale mapping and close the old socket so it cant leak or clobber the new entry.
        if (previous && previous.ws !== ws) {
          wsToClient.delete(previous.ws);
          try { previous.ws.terminate(); } catch {}
        }
        clients.set(clientId, {
          ws,
          label: String(msg.label || ""),
          version: String(msg.version || ""),
          connectedAt: Date.now(),
        });
        wsToClient.set(ws, clientId);
        console.error(`Extension connected: ${msg.label || "(unnamed)"} [${clientId.slice(0, 8)}] (${clients.size} total)`);  
      return;
      }
    } catch (e) {}
  });
  ws.on("close", () => {
    const id = wsToClient.get(ws);
    if (id) {
      // Only remove the registry entry if it still points at THIS socket.
      // A late close from a replaced socket must not evict the new one.
      if (clients.get(id)?.ws === ws) {
        clients.delete(id);
        console.error(`Extension disconnected: [${String(id).slice(0, 8)}] (${clients.size} remaining)`);
      } else {
        console.error(`Stale extension socket closed: [${String(id).slice(0, 8)}]`);
      }
      wsToClient.delete(ws);
    } else {
      console.error("Extension disconnected (unidentified)");
    }
  });
});

// Server-side heartbeat: ping all clients, drop dead ones
const heartbeat = setInterval(() => {
  for (const [id, m] of clients) {
    const ws = m.ws;
    if ((ws as any).isAlive === false) {
      console.error(`Dropping dead connection: [${String(id).slice(0, 8)}]`);
      if (clients.get(id)?.ws === ws) {
        clients.delete(id);
      }
      wsToClient.delete(ws);
      try { ws.terminate(); } catch {}
      continue;
    }
    (ws as any).isAlive = false;
    try { ws.ping(); } catch {}
  }
  // Also sweep raw sockets that never sent hello
  wss.clients.forEach((ws) => {
    if (!wsToClient.has(ws) && (ws as any).isAlive === false) {
      try { ws.terminate(); } catch {}
    }
  });
}, SERVER_PING_INTERVAL);

const server = new Server(
  {
    name: "opencode-browser",
    version: "opencode 0.0.8",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

async function callExtension(method: string, params: any) {
  return new Promise((resolve, reject) => {
    const { clientId, _clientId, target, ...forwardParams } = params || {};
    const targetId: string | undefined = clientId || _clientId || target;
    const id = Math.random().toString(36).substring(7);
    const message = JSON.stringify({ id, method, params: forwardParams });

    const sendTo = (client: WebSocket): boolean => {
      if (client.readyState !== WebSocket.OPEN) return false;
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        client.removeListener("message", listener);
        reject(new Error("Timeout waiting for extension response"));
      }, 30000);
      const listener = (data: any) => {
        try {
          const response = JSON.parse(data.toString());
          // Ignore keep-alive pings / hellos
          if (response.type === "ping" || response.type === "hello") return;
          if (response.id === id) {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            client.removeListener("message", listener);
            if (response.error) reject(new Error(response.error));
            else resolve(response.result);
          }
        } catch (e) {}
      };
      client.on("message", listener);
      client.send(message);
      return true;
    };

    if (targetId) {
      const meta = clients.get(targetId);
      if (!meta) {
        const available = listClients().map((c) => `${c.label || "(unnamed)"} [${c.clientId.slice(0, 8)}]`).join(", ") || "none";
        reject(new Error(`Unknown clientId "${targetId}". Connected: ${available}. Call chrome_list_clients for full IDs.`));
        return;
      }
      if (!sendTo(meta.ws)) {
        reject(new Error(`Extension client "${targetId}" is not connected (socket not open).`));
      }
      return;
    }

    const open = [...clients.values()].filter((m) => m.ws.readyState === WebSocket.OPEN);
    if (open.length === 0) {
      reject(new Error(`No Chrome extension connected. Ensure opencode-browser extension is installed and connected to ws://127.0.0.1:${WS_PORT} (check the extension popup).`));
      return;
    }
    if (open.length > 1) {
      const available = listClients().map((c) => `${c.label || "(unnamed)"} [${c.clientId}]`).join(", ");
      reject(new Error(`Multiple Chrome profiles connected (${open.length}): ${available}. Pass {"clientId": "<id>"} (see chrome_list_clients) to target one.`));
      return;
    }
    sendTo(open[0].ws);
  });
}

const TOOLS = [
  {
    name: "chrome_list_clients",
    description:
      "List connected Chrome profiles (extension clients) with clientId and label. When multiple profiles are connected, pass {\"clientId\": \"<id>\"} to any chrome_* tool to target one.",
    inputSchema: { type: "object", properties: {} },
  },
  // TABS VIEWING & QUERYING
  {
    name: "chrome_list_tabs",
    description:
      "List all open tabs in Chrome with their id, title, url, active status, window, pinned, muted, audible states",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "chrome_get_active_tab",
    description: "Get info about the currently active tab",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "chrome_get_tab_info",
    description: "Get detailed info about a specific tab by its id",
    inputSchema: {
      type: "object",
      properties: { tabId: { type: "number", description: "Tab ID" } },
      required: ["tabId"],
    },
  },
  {
    name: "chrome_search_tabs",
    description: "Search open tabs by title or URL keyword",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string", description: "Search term" } },
      required: ["query"],
    },
  },

  // TAB MANAGEMENT
  {
    name: "chrome_navigate",
    description: "Navigate a tab to a URL. Optionally specify tabId; defaults to active tab",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string" },
        tabId: { type: "number", description: "Target tab ID (optional)" },
      },
      required: ["url"],
    },
  },
  {
    name: "chrome_new_tab",
    description: "Open a new tab, optionally with a URL",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string" },
        active: { type: "boolean", description: "Make it active (default true)" },
      },
    },
  },
  {
    name: "chrome_close_tab",
    description: "Close a tab by id (defaults to active tab)",
    inputSchema: {
      type: "object",
      properties: { tabId: { type: "number" } },
    },
  },
  {
    name: "chrome_close_tabs",
    description: "Close multiple tabs by their ids",
    inputSchema: {
      type: "object",
      properties: {
        tabIds: { type: "array", items: { type: "number" }, description: "Array of tab IDs" },
      },
      required: ["tabIds"],
    },
  },
  {
    name: "chrome_switch_tab",
    description: "Switch to (focus) a specific tab by id",
    inputSchema: {
      type: "object",
      properties: { tabId: { type: "number" } },
      required: ["tabId"],
    },
  },
  {
    name: "chrome_duplicate_tab",
    description: "Duplicate a tab (defaults to active tab)",
    inputSchema: {
      type: "object",
      properties: { tabId: { type: "number" } },
    },
  },
  {
    name: "chrome_pin_tab",
    description: "Pin or unpin a tab",
    inputSchema: {
      type: "object",
      properties: {
        tabId: { type: "number" },
        pinned: { type: "boolean", description: "true to pin, false to unpin (default true)" },
      },
    },
  },
  {
    name: "chrome_mute_tab",
    description: "Mute or unmute a tab",
    inputSchema: {
      type: "object",
      properties: {
        tabId: { type: "number" },
        muted: { type: "boolean", description: "true to mute, false to unmute (default true)" },
      },
    },
  },
  {
    name: "chrome_reload_tab",
    description: "Reload a tab",
    inputSchema: {
      type: "object",
      properties: {
        tabId: { type: "number" },
        bypassCache: { type: "boolean" },
      },
    },
  },
  {
    name: "chrome_move_tab",
    description: "Move a tab to a different position or window",
    inputSchema: {
      type: "object",
      properties: {
        tabId: { type: "number" },
        index: { type: "number" },
        windowId: { type: "number" },
      },
      required: ["tabId", "index"],
    },
  },

  // WINDOWS
  {
    name: "chrome_list_windows",
    description: "List all open Chrome windows with their id, state, focused, tab count",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "chrome_new_window",
    description: "Open a new browser window",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string" },
        incognito: { type: "boolean" },
        state: { type: "string", enum: ["normal", "minimized", "maximized", "fullscreen"] },
      },
    },
  },
  {
    name: "chrome_close_window",
    description: "Close a browser window",
    inputSchema: {
      type: "object",
      properties: { windowId: { type: "number" } },
      required: ["windowId"],
    },
  },

  // SCREENSHOT
  {
    name: "chrome_screenshot",
    description: "Take a screenshot of the visible area of the current tab. Returns a base64 data URL.",
    inputSchema: {
      type: "object",
      properties: {
        format: { type: "string", enum: ["png", "jpeg"] },
        quality: { type: "number", description: "JPEG quality 0-100" },
        windowId: { type: "number" },
      },
    },
  },

  // PAGE INTERACTION
  {
    name: "chrome_click",
    description: "Click an element by CSS selector in the current (or specified) tab",
    inputSchema: {
      type: "object",
      properties: {
        selector: { type: "string" },
        tabId: { type: "number" },
      },
      required: ["selector"],
    },
  },
  {
    name: "chrome_type",
    description: "Type text into an input element by CSS selector",
    inputSchema: {
      type: "object",
      properties: {
        selector: { type: "string" },
        text: { type: "string" },
        tabId: { type: "number" },
        simulate: { type: "boolean", description: "Simulate key-by-key typing (default false)" },
      },
      required: ["selector", "text"],
    },
  },
  {
    name: "chrome_hover",
    description: "Hover over an element by CSS selector",
    inputSchema: {
      type: "object",
      properties: { selector: { type: "string" }, tabId: { type: "number" } },
      required: ["selector"],
    },
  },
  {
    name: "chrome_select",
    description: "Select an option in a <select> element",
    inputSchema: {
      type: "object",
      properties: {
        selector: { type: "string" },
        value: { type: "string" },
        tabId: { type: "number" },
      },
      required: ["selector", "value"],
    },
  },
  {
    name: "chrome_scroll",
    description: "Scroll the page or an element by x/y pixels",
    inputSchema: {
      type: "object",
      properties: {
        x: { type: "number" },
        y: { type: "number" },
        selector: { type: "string", description: "Scroll a specific element (optional)" },
        tabId: { type: "number" },
      },
    },
  },
  {
    name: "chrome_scroll_to",
    description: "Scroll an element into view by CSS selector",
    inputSchema: {
      type: "object",
      properties: { selector: { type: "string" }, tabId: { type: "number" } },
      required: ["selector"],
    },
  },
  {
    name: "chrome_key_press",
    description: "Dispatch a keyboard event (e.g. 'Enter', 'Escape', 'Tab') on the page or element",
    inputSchema: {
      type: "object",
      properties: {
        key: { type: "string", description: "Key name e.g. 'Enter', 'Escape', 'ArrowDown'" },
        selector: { type: "string", description: "Target element (optional, defaults to focused element)" },
        tabId: { type: "number" },
      },
      required: ["key"],
    },
  },
  {
    name: "chrome_wait_for_element",
    description: "Wait until a CSS selector appears in the DOM",
    inputSchema: {
      type: "object",
      properties: {
        selector: { type: "string" },
        timeout: { type: "number", description: "Max wait in ms (default 5000)" },
        tabId: { type: "number" },
      },
      required: ["selector"],
    },
  },

  // PAGE CONTENT
  {
    name: "chrome_get_content",
    description: "Get the visible text content of the current (or specified) tab's page",
    inputSchema: {
      type: "object",
      properties: { tabId: { type: "number" } },
    },
  },
  {
    name: "chrome_get_html",
    description: "Get the outer HTML of an element (or full page if no selector given)",
    inputSchema: {
      type: "object",
      properties: {
        selector: { type: "string" },
        tabId: { type: "number" },
      },
    },
  },
  {
    name: "chrome_get_element_info",
    description: "Get detailed info about a DOM element: tag, id, class, text, attributes, bounding box, visibility",
    inputSchema: {
      type: "object",
      properties: { selector: { type: "string" }, tabId: { type: "number" } },
      required: ["selector"],
    },
  },
  {
    name: "chrome_find_elements",
    description: "Find all elements matching a CSS selector and return their properties",
    inputSchema: {
      type: "object",
      properties: {
        selector: { type: "string" },
        limit: { type: "number", description: "Max results (default 50)" },
        tabId: { type: "number" },
      },
      required: ["selector"],
    },
  },
  {
    name: "chrome_get_page_info",
    description: "Get page metadata: title, URL, scroll position, viewport size, links, meta description",
    inputSchema: {
      type: "object",
      properties: { tabId: { type: "number" } },
    },
  },
  {
    name: "chrome_execute_script",
    description: "Execute arbitrary JavaScript in the current (or specified) tab with full DOM access",
    inputSchema: {
      type: "object",
      properties: {
        code: { type: "string" },
        tabId: { type: "number" },
        allFrames: { type: "boolean" },
      },
      required: ["code"],
    },
  },

  // NAVIGATION HISTORY
  {
    name: "chrome_go_back",
    description: "Navigate back in the current tab's history",
    inputSchema: {
      type: "object",
      properties: { tabId: { type: "number" } },
    },
  },
  {
    name: "chrome_go_forward",
    description: "Navigate forward in the current tab's history",
    inputSchema: {
      type: "object",
      properties: { tabId: { type: "number" } },
    },
  },
  {
    name: "chrome_go_home",
    description: "Navigate the active tab to the new tab page",
    inputSchema: { type: "object", properties: {} },
  },

  // COOKIES
  {
    name: "chrome_get_cookies",
    description: "Get all cookies for a given URL",
    inputSchema: {
      type: "object",
      properties: { url: { type: "string" } },
      required: ["url"],
    },
  },
  {
    name: "chrome_set_cookie",
    description: "Set a cookie for a URL",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string" },
        name: { type: "string" },
        value: { type: "string" },
        domain: { type: "string" },
        path: { type: "string" },
        secure: { type: "boolean" },
        httpOnly: { type: "boolean" },
      },
      required: ["url", "name", "value"],
    },
  },
  {
    name: "chrome_delete_cookie",
    description: "Delete a specific cookie",
    inputSchema: {
      type: "object",
      properties: { url: { type: "string" }, name: { type: "string" } },
      required: ["url", "name"],
    },
  },

  // LOCAL STORAGE
  {
    name: "chrome_get_local_storage",
    description: "Get localStorage value(s) from the current page",
    inputSchema: {
      type: "object",
      properties: {
        key: { type: "string", description: "Specific key (omit to get all)" },
        tabId: { type: "number" },
      },
    },
  },
  {
    name: "chrome_set_local_storage",
    description: "Set a localStorage value on the current page",
    inputSchema: {
      type: "object",
      properties: {
        key: { type: "string" },
        value: { type: "string" },
        tabId: { type: "number" },
      },
      required: ["key", "value"],
    },
  },
  {
    name: "chrome_clear_local_storage",
    description: "Clear all localStorage on the current page",
    inputSchema: {
      type: "object",
      properties: { tabId: { type: "number" } },
    },
  },

  // HISTORY & BOOKMARKS
  {
    name: "chrome_get_history",
    description: "Search browser history by text query",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        maxResults: { type: "number" },
        startTime: { type: "number", description: "Start time in ms epoch" },
      },
    },
  },
  {
    name: "chrome_add_bookmark",
    description: "Add a bookmark",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string" },
        url: { type: "string" },
        parentId: { type: "string" },
      },
      required: ["title", "url"],
    },
  },
  {
    name: "chrome_search_bookmarks",
    description: "Search bookmarks by title or URL",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        limit: { type: "number" },
      },
      required: ["query"],
    },
  },
  {
    name: "chrome_get_bookmarks",
    description: "Get all bookmarks in a flat list",
    inputSchema: { type: "object", properties: {} },
  },

  // DOWNLOADS
  {
    name: "chrome_download",
    description: "Download a file from a URL",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string" },
        filename: { type: "string" },
        saveAs: { type: "boolean" },
      },
      required: ["url"],
    },
  },
  {
    name: "chrome_list_downloads",
    description: "List recent downloads",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number" },
        state: { type: "string", enum: ["in_progress", "interrupted", "complete"] },
      },
    },
  },

  // TAB GROUPS
  {
    name: "chrome_group_tabs",
    description: "Group tabs together, optionally with a title and color",
    inputSchema: {
      type: "object",
      properties: {
        tabIds: { type: "array", items: { type: "number" } },
        title: { type: "string" },
        color: {
          type: "string",
          enum: ["grey", "blue", "red", "yellow", "green", "pink", "purple", "cyan", "orange"],
        },
      },
      required: ["tabIds"],
    },
  },
  {
    name: "chrome_ungroup_tabs",
    description: "Ungroup tabs",
    inputSchema: {
      type: "object",
      properties: { tabIds: { type: "array", items: { type: "number" } } },
      required: ["tabIds"],
    },
  },

  // NOTIFICATIONS
  {
    name: "chrome_notify",
    description: "Show a desktop notification",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string" },
        message: { type: "string" },
      },
      required: ["message"],
    },
  },

  // ZOOM
  {
    name: "chrome_set_zoom",
    description: "Set zoom level of a tab (1.0 = 100%)",
    inputSchema: {
      type: "object",
      properties: {
        zoom: { type: "number" },
        tabId: { type: "number" },
      },
      required: ["zoom"],
    },
  },
  {
    name: "chrome_get_zoom",
    description: "Get current zoom level of a tab",
    inputSchema: {
      type: "object",
      properties: { tabId: { type: "number" } },
    },
  },

  // CLIPBOARD
  {
    name: "chrome_write_clipboard",
    description: "Write text to the clipboard",
    inputSchema: {
      type: "object",
      properties: { text: { type: "string" }, tabId: { type: "number" } },
      required: ["text"],
    },
  },
  {
    name: "chrome_read_clipboard",
    description: "Read text from the clipboard",
    inputSchema: {
      type: "object",
      properties: { tabId: { type: "number" } },
    },
  },

  // EXTENSION META
  {
    name: "chrome_get_extension_info",
    description: "Get info about the Opencode Brower extension itself, including author metadata",
    inputSchema: { type: "object", properties: {} },
  },

  // DEVTOOLS / DEBUGGER (CDP)
  {
    name: "chrome_debug_attach",
    description: "Attach Chrome DevTools Protocol debugger to a tab. Enables Console, Network, Runtime, Performance domains for capturing logs and requests.",
    inputSchema: {
      type: "object",
      properties: { tabId: { type: "number" } },
    },
  },
  {
    name: "chrome_debug_detach",
    description: "Detach the debugger from a tab",
    inputSchema: {
      type: "object",
      properties: { tabId: { type: "number" } },
    },
  },
  {
    name: "chrome_debug_get_logs",
    description: "Get captured console logs from a debugged tab (console.log, warn, error, info)",
    inputSchema: {
      type: "object",
      properties: {
        tabId: { type: "number" },
        limit: { type: "number", description: "Max number of logs to return (default 100)" },
        level: { type: "string", description: "Filter by level: log, warn, error, info" },
      },
    },
  },
  {
    name: "chrome_debug_clear_logs",
    description: "Clear captured console logs for a tab",
    inputSchema: {
      type: "object",
      properties: { tabId: { type: "number" } },
    },
  },
  {
    name: "chrome_debug_get_network",
    description: "Get captured network requests (XHR, Fetch, etc.) from a debugged tab",
    inputSchema: {
      type: "object",
      properties: {
        tabId: { type: "number" },
        limit: { type: "number", description: "Max results (default 100)" },
        filter: { type: "string", description: "Filter URLs containing this string" },
      },
    },
  },
  {
    name: "chrome_debug_clear_network",
    description: "Clear captured network log for a tab",
    inputSchema: {
      type: "object",
      properties: { tabId: { type: "number" } },
    },
  },
  {
    name: "chrome_debug_get_response_body",
    description: "Get the response body of a captured network request by requestId",
    inputSchema: {
      type: "object",
      properties: {
        requestId: { type: "string" },
        tabId: { type: "number" },
      },
      required: ["requestId"],
    },
  },
  {
    name: "chrome_debug_eval",
    description: "Evaluate JavaScript in the page context via CDP Runtime.evaluate (bypasses sandbox, supports await)",
    inputSchema: {
      type: "object",
      properties: {
        code: { type: "string" },
        tabId: { type: "number" },
      },
      required: ["code"],
    },
  },
  {
    name: "chrome_debug_get_performance",
    description: "Get performance metrics from a debugged tab (JS heap, DOM nodes, layout count, etc.)",
    inputSchema: {
      type: "object",
      properties: { tabId: { type: "number" } },
    },
  },
  {
    name: "chrome_debug_get_dom_snapshot",
    description: "Capture a full DOM snapshot including layout, paint order, and bounding rects",
    inputSchema: {
      type: "object",
      properties: { tabId: { type: "number" } },
    },
  },
  {
    name: "chrome_debug_set_breakpoint",
    description: "Set a JavaScript breakpoint by URL and line number via CDP Debugger",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string" },
        line: { type: "number" },
        column: { type: "number" },
        tabId: { type: "number" },
      },
      required: ["url", "line"],
    },
  },
  {
    name: "chrome_debug_remove_breakpoint",
    description: "Remove a JavaScript breakpoint by breakpointId",
    inputSchema: {
      type: "object",
      properties: {
        breakpointId: { type: "string" },
        tabId: { type: "number" },
      },
      required: ["breakpointId"],
    },
  },
  {
    name: "chrome_debug_get_cookies",
    description: "Get ALL cookies including HttpOnly ones via CDP Network.getAllCookies",
    inputSchema: {
      type: "object",
      properties: { tabId: { type: "number" } },
    },
  },
  {
    name: "chrome_debug_set_xhr_breakpoint",
    description: "Set an XHR/Fetch breakpoint to pause when a URL pattern is requested",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "URL pattern to break on (empty = all XHR)" },
        tabId: { type: "number" },
      },
    },
  },
  {
    name: "chrome_debug_emulate_device",
    description: "Emulate a mobile device (screen size, user agent, DPR)",
    inputSchema: {
      type: "object",
      properties: {
        width: { type: "number", description: "Screen width in px (default 375)" },
        height: { type: "number", description: "Screen height in px (default 812)" },
        deviceScaleFactor: { type: "number", description: "DPR (default 2)" },
        mobile: { type: "boolean" },
        userAgent: { type: "string" },
        tabId: { type: "number" },
      },
    },
  },
  {
    name: "chrome_debug_emulate_network",
    description: "Throttle network speed to emulate different conditions",
    inputSchema: {
      type: "object",
      properties: {
        preset: { type: "string", enum: ["offline", "slow3g", "fast3g", "none"], description: "Preset throttle condition" },
        offline: { type: "boolean" },
        download: { type: "number", description: "Download in bytes/sec" },
        upload: { type: "number", description: "Upload in bytes/sec" },
        latency: { type: "number", description: "Latency in ms" },
        tabId: { type: "number" },
      },
    },
  },
  {
    name: "chrome_debug_block_urls",
    description: "Block specific URL patterns from loading (ads, tracking, API calls)",
    inputSchema: {
      type: "object",
      properties: {
        urls: { type: "array", items: { type: "string" }, description: "URL patterns to block" },
        tabId: { type: "number" },
      },
      required: ["urls"],
    },
  },
  {
    name: "chrome_debug_get_storage",
    description: "Get DOM storage (localStorage/sessionStorage) for a specific origin via CDP",
    inputSchema: {
      type: "object",
      properties: {
        origin: { type: "string", description: "Security origin e.g. https://example.com" },
        isLocal: { type: "boolean", description: "true = localStorage, false = sessionStorage (default true)" },
        tabId: { type: "number" },
      },
      required: ["origin"],
    },
  },
  {
    name: "chrome_debug_send_command",
    description: "Send a raw Chrome DevTools Protocol (CDP) command for advanced debugging",
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string", description: "CDP method e.g. 'Network.enable', 'DOM.getDocument'" },
        commandParams: { type: "object", description: "Parameters for the CDP command" },
        tabId: { type: "number" },
      },
      required: ["command"],
    },
  },

  // ACCESSIBILITY
  {
    name: "chrome_get_accessibility_tree",
    description: "Get the full accessibility tree of the page via CDP AX (useful for finding elements by label/role)",
    inputSchema: {
      type: "object",
      properties: {
        tabId: { type: "number" },
        limit: { type: "number", description: "Max nodes to return (default 200)" },
      },
    },
  },
  {
    name: "chrome_find_accessible_nodes",
    description: "Find accessibility nodes by name/label and/or role (button, textbox, link, etc.)",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Text/label to search for" },
        role: { type: "string", description: "ARIA role to filter by e.g. button, textbox, link" },
        limit: { type: "number" },
        tabId: { type: "number" },
      },
    },
  },

  // VISUAL / OC
  {
    name: "chrome_visual_click",
    description: "Click at specific X/Y screen coordinates via CDP Input (useful when CSS selector is unavailable)",
    inputSchema: {
      type: "object",
      properties: {
        x: { type: "number", description: "X coordinate in pixels" },
        y: { type: "number", description: "Y coordinate in pixels" },
        tabId: { type: "number" },
      },
      required: ["x", "y"],
    },
  },
  {
    name: "chrome_ocr_page",
    description: "Extract all visible text from the page with bounding box coordinates (like OCR)",
    inputSchema: {
      type: "object",
      properties: {
        tabId: { type: "number" },
        limit: { type: "number", description: "Max text nodes (default 500)" },
      },
    },
  },
  {
    name: "chrome_find_text_on_screen",
    description: "Find text on the visible page and return its screen coordinates for visual clicking",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Text to find on screen" },
        exact: { type: "boolean", description: "Exact match (default false)" },
        tabId: { type: "number" },
      },
      required: ["query"],
    },
  },

  // NETWORK INTERCEPT / MOCK
  {
    name: "chrome_intercept_request",
    description: "Intercept all network requests matching a URL pattern via CDP Fetch. Captured requests available via debug_get_network.",
    inputSchema: {
      type: "object",
      properties: {
        urlPattern: { type: "string", description: "URL pattern to intercept e.g. '*/api/*'" },
        tabId: { type: "number" },
      },
    },
  },
  {
    name: "chrome_mock_response",
    description: "Mock the response of a specific URL with custom status, headers, and body",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "Exact URL to mock" },
        status: { type: "number", description: "HTTP status code (default 200)" },
        headers: { type: "object", description: "Response headers" },
        body: { description: "Response body (string or object)" },
      },
      required: ["url"],
    },
  },
  {
    name: "chrome_modify_headers",
    description: "Automatically modify request headers for all matching requests (add auth tokens, change User-Agent, etc.)",
    inputSchema: {
      type: "object",
      properties: {
        urlPattern: { type: "string", description: "URL pattern to match" },
        headers: { type: "object", description: "Headers to add/override" },
        tabId: { type: "number" },
      },
      required: ["headers"],
    },
  },

  // SESSION
  {
    name: "chrome_save_session",
    description: "Save the current session (cookies + localStorage) for later restoration",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Session name/key to save as" },
        tabId: { type: "number" },
      },
      required: ["name"],
    },
  },
  {
    name: "chrome_restore_session",
    description: "Restore a previously saved session (cookies + localStorage)",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Session name/key to restore" },
        tabId: { type: "number" },
      },
      required: ["name"],
    },
  },

  // EVENTS & DOM WATCH
  {
    name: "chrome_subscribe_events",
    description: "Subscribe to DOM events (click, input, submit, etc.) and log them for later retrieval via get_workflow_context",
    inputSchema: {
      type: "object",
      properties: {
        events: {
          type: "array", items: { type: "string" },
          description: "List of events to listen to (default: click, input, submit, change, keydown)"
        },
        tabId: { type: "number" },
      },
    },
  },
  {
    name: "chrome_watch_dom_changes",
    description: "Watch for DOM mutations (added/removed elements, attribute changes) via MutationObserver",
    inputSchema: {
      type: "object",
      properties: {
        selector: { type: "string", description: "Root element to observe (default: document.body)" },
        limit: { type: "number", description: "Max mutations to store (default 500)" },
        tabId: { type: "number" },
      },
    },
  },

  // IFRAMES
  {
    name: "chrome_list_iframes",
    description: "List all iframes on the current page with src, id, name, and dimensions",
    inputSchema: {
      type: "object",
      properties: { tabId: { type: "number" } },
    },
  },
  {
    name: "chrome_switch_iframe",
    description: "Execute JavaScript code inside a specific iframe by frame index",
    inputSchema: {
      type: "object",
      properties: {
        frameIndex: { type: "number", description: "Index of the iframe (0-based)" },
        code: { type: "string", description: "JavaScript to execute inside the iframe" },
        tabId: { type: "number" },
      },
      required: ["frameIndex"],
    },
  },

  // FILE UPLOAD
  {
    name: "chrome_upload_file",
    description: "Set files on a file input element via CDP DOM.setFileInputFiles",
    inputSchema: {
      type: "object",
      properties: {
        selector: { type: "string", description: "CSS selector of the file input element" },
        files: { type: "array", items: { type: "string" }, description: "Array of absolute file paths to upload" },
        tabId: { type: "number" },
      },
      required: ["selector", "files"],
    },
  },

  // PERMISSIONS
  {
    name: "chrome_grant_permissions",
    description: "Grant browser permissions to the current origin (geolocation, camera, microphone, notifications, etc.)",
    inputSchema: {
      type: "object",
      properties: {
        permissions: {
          type: "array", items: { type: "string" },
          description: "Permissions to grant e.g. ['geolocation', 'camera', 'microphone', 'notifications']"
        },
        tabId: { type: "number" },
      },
      required: ["permissions"],
    },
  },

  // VIRTUAL AUTHENTICATOR
  {
    name: "chrome_virtual_authenticator",
    description: "Add/remove a virtual WebAuthn authenticator for testing passkey/FIDO2 flows",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["enable", "add", "remove"], description: "Action to perform" },
        protocol: { type: "string", enum: ["ctap2", "u2f"], description: "Authenticator protocol (default ctap2)" },
        transport: { type: "string", enum: ["usb", "nfc", "ble", "internal"], description: "Transport (default usb)" },
        authenticatorId: { type: "string", description: "ID for remove action" },
        hasResidentKey: { type: "boolean" },
        hasUserVerification: { type: "boolean" },
        isUserVerified: { type: "boolean" },
        tabId: { type: "number" },
      },
      required: ["action"],
    },
  },

  // WORKFLOW CONTEXT
  {
    name: "chrome_get_workflow_context",
    description: "Get a comprehensive snapshot of the current page state: forms, buttons, inputs, event log, mutation log — ideal for AI workflow planning",
    inputSchema: {
      type: "object",
      properties: { tabId: { type: "number" } },
    },
  },

  // HAR EXPORT
  {
    name: "chrome_export_har",
    description: "Export all captured network requests as a HAR (HTTP Archive) file",
    inputSchema: {
      type: "object",
      properties: { tabId: { type: "number" } },
    },
  },

  // REPLAY REQUEST
  {
    name: "chrome_replay_request",
    description: "Re-send any HTTP request with custom method, headers, and body directly from the page context",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string" },
        method: { type: "string", description: "HTTP method (default GET)" },
        headers: { type: "object" },
        body: { type: "string" },
        tabId: { type: "number" },
      },
      required: ["url"],
    },
  },

  // TOOL GRAPH
  {
    name: "chrome_get_tool_graph",
    description: "CALL THIS FIRST before any task. Returns the optimal tool graph: which tools to use for a given intent, their cost, prerequisites, and which tools to AVOID to save tokens. Prevents redundant tool calls.",
    inputSchema: {
      type: "object",
      properties: {
        intent: { type: "string", description: "What you are trying to do in plain text e.g. 'read page content', 'click a button', 'capture network requests'" },
        tools: { type: "array", items: { type: "string" }, description: "Optional: filter graph to specific tool names" },
      },
    },
  },

  {
    name: "chrome_rank_candidates",
    description:
      "Rank a short list of candidates (buttons, links, form fields, network requests, text " +
      "matches, etc.) against a plain-text intent, using a fast system-one decision model " +
      "(Jev/TypeSafe API shape) instead of reading them yourself. Use this AFTER " +
      "chrome_get_workflow_context, chrome_find_elements, chrome_debug_get_network, or " +
      "chrome_find_text_on_screen return multiple ambiguous matches and you need to pick the " +
      "one that best fits the intent. Returns the best candidate plus a confidence score in a " +
      "single fast call. Requires DECISION_ENDPOINT to be configured on the server; if it isn't, " +
      "this tool returns a clear error.",
    inputSchema: {
      type: "object",
      properties: {
        intent: {
          type: "string",
          description: "Plain-text description of what you're looking for, e.g. 'the submit order button' or 'a request that returned an error'",
        },
        candidates: {
          type: "array",
          description:
            "List of candidates to choose from, each as a short label/description string " +
            "(e.g. element text, a selector plus context, or a request URL). Keep each entry " +
            "concise — long entries eat into the model's context budget and hurt accuracy.",
          items: { type: "string" },
        },
        top_k: {
          type: "number",
          description: "Return this many top candidates ranked by probability instead of just the best one (default 1)",
        },
      },
      required: ["intent", "candidates"],
    },
  },
  {
    name: "chrome_double_click",
    description: "Double click an element by CSS selector or at specific coordinates",
    inputSchema: {
      type: "object",
      properties: {
        selector: { type: "string", description: "CSS selector (optional if x/y provided)" },
        x: { type: "number", description: "X coordinate for visual double click" },
        y: { type: "number", description: "Y coordinate for visual double click" },
        tabId: { type: "number" },
      },
    },
  },
  {
    name: "chrome_right_click",
    description: "Right click an element to open context menu",
    inputSchema: {
      type: "object",
      properties: {
        selector: { type: "string", description: "CSS selector (optional if x/y provided)" },
        x: { type: "number", description: "X coordinate" },
        y: { type: "number", description: "Y coordinate" },
        tabId: { type: "number" },
      },
    },
  },
  {
    name: "chrome_middle_click",
    description: "Middle click (open in new tab)",
    inputSchema: {
      type: "object",
      properties: {
        selector: { type: "string", description: "CSS selector (optional if x/y provided)" },
        x: { type: "number", description: "X coordinate" },
        y: { type: "number", description: "Y coordinate" },
        tabId: { type: "number" },
      },
    },
  },
  {
    name: "chrome_drag_drop",
    description: "Drag and drop from element A to element B or coordinates",
    inputSchema: {
      type: "object",
      properties: {
        fromSelector: { type: "string", description: "Source element selector" },
        toSelector: { type: "string", description: "Target element selector" },
        fromX: { type: "number", description: "Source X coordinate" },
        fromY: { type: "number", description: "Source Y coordinate" },
        toX: { type: "number", description: "Target X coordinate" },
        toY: { type: "number", description: "Target Y coordinate" },
        tabId: { type: "number" },
      },
    },
  },
  {
    name: "chrome_keyboard_shortcut",
    description: "Execute keyboard shortcuts like Ctrl+C, Ctrl+V, Ctrl+A, etc.",
    inputSchema: {
      type: "object",
      properties: {
        shortcut: { type: "string", description: "Shortcut like 'Ctrl+C', 'Ctrl+V', 'Ctrl+A', 'Ctrl+Z', 'Ctrl+S'" },
        tabId: { type: "number" },
      },
      required: ["shortcut"],
    },
  },

  // WAIT TOOLS
  {
    name: "chrome_wait_for_navigation",
    description: "Wait for page navigation to complete after clicking a link",
    inputSchema: {
      type: "object",
      properties: {
        timeout: { type: "number", description: "Max wait in ms (default 30000)" },
        tabId: { type: "number" },
      },
    },
  },
  {
    name: "chrome_wait_for_network_idle",
    description: "Wait until no network requests for N milliseconds",
    inputSchema: {
      type: "object",
      properties: {
        idleTime: { type: "number", description: "Idle time in ms (default 500)" },
        timeout: { type: "number", description: "Max wait in ms (default 30000)" },
        tabId: { type: "number" },
      },
    },
  },

  // SCREENSHOT TOOLS
  {
    name: "chrome_screenshot_element",
    description: "Take screenshot of a specific element",
    inputSchema: {
      type: "object",
      properties: {
        selector: { type: "string", description: "CSS selector of element" },
        format: { type: "string", enum: ["png", "jpeg"] },
        quality: { type: "number", description: "JPEG quality 0-100" },
        tabId: { type: "number" },
      },
      required: ["selector"],
    },
  },
  {
    name: "chrome_screenshot_fullpage",
    description: "Take full page screenshot (scrolls and stitches)",
    inputSchema: {
      type: "object",
      properties: {
        format: { type: "string", enum: ["png", "jpeg"] },
        quality: { type: "number", description: "JPEG quality 0-100" },
        tabId: { type: "number" },
      },
    },
  },
  {
    name: "chrome_pdf_print",
    description: "Save current page as PDF",
    inputSchema: {
      type: "object",
      properties: {
        landscape: { type: "boolean", description: "Landscape orientation" },
        displayHeaderFooter: { type: "boolean" },
        printBackground: { type: "boolean", description: "Print background graphics" },
        scale: { type: "number", description: "Scale 0.1-2.0 (default 1)" },
        paperWidth: { type: "number", description: "Paper width in inches" },
        paperHeight: { type: "number", description: "Paper height in inches" },
        marginTop: { type: "number", description: "Top margin in inches" },
        marginBottom: { type: "number", description: "Bottom margin in inches" },
        marginLeft: { type: "number", description: "Left margin in inches" },
        marginRight: { type: "number", description: "Right margin in inches" },
        tabId: { type: "number" },
      },
    },
  },

  // CSS INJECTION
  {
    name: "chrome_inject_css",
    description: "Inject CSS stylesheet into the page",
    inputSchema: {
      type: "object",
      properties: {
        css: { type: "string", description: "CSS code to inject" },
        tabId: { type: "number" },
      },
      required: ["css"],
    },
  },
  {
    name: "chrome_remove_css",
    description: "Remove previously injected CSS",
    inputSchema: {
      type: "object",
      properties: {
        cssId: { type: "string", description: "ID of injected CSS to remove" },
        tabId: { type: "number" },
      },
      required: ["cssId"],
    },
  },

  // TEXT SELECTION
  {
    name: "chrome_select_text",
    description: "Select/highlight text on the page",
    inputSchema: {
      type: "object",
      properties: {
        selector: { type: "string", description: "Element containing text to select" },
        startOffset: { type: "number", description: "Start character offset" },
        endOffset: { type: "number", description: "End character offset" },
        tabId: { type: "number" },
      },
      required: ["selector"],
    },
  },
  {
    name: "chrome_get_selected_text",
    description: "Get currently selected/highlighted text",
    inputSchema: {
      type: "object",
      properties: {
        tabId: { type: "number" },
      },
    },
  },
  {
    name: "chrome_focus_element",
    description: "Focus an element without clicking",
    inputSchema: {
      type: "object",
      properties: {
        selector: { type: "string", description: "CSS selector" },
        tabId: { type: "number" },
      },
      required: ["selector"],
    },
  },
  {
    name: "chrome_clear_input",
    description: "Clear an input field",
    inputSchema: {
      type: "object",
      properties: {
        selector: { type: "string", description: "CSS selector of input" },
        tabId: { type: "number" },
      },
      required: ["selector"],
    },
  },
  {
    name: "chrome_mock_geolocation",
    description: "Mock GPS location for testing",
    inputSchema: {
      type: "object",
      properties: {
        latitude: { type: "number", description: "Latitude coordinate" },
        longitude: { type: "number", description: "Longitude coordinate" },
        accuracy: { type: "number", description: "Accuracy in meters (default 100)" },
        tabId: { type: "number" },
      },
      required: ["latitude", "longitude"],
    },
  },
  {
    name: "chrome_mock_timezone",
    description: "Override timezone of the page",
    inputSchema: {
      type: "object",
      properties: {
        timezoneId: { type: "string", description: "IANA timezone ID e.g. 'America/New_York', 'Asia/Tokyo'" },
        tabId: { type: "number" },
      },
      required: ["timezoneId"],
    },
  },
  {
    name: "chrome_mock_locale",
    description: "Override locale/language of the page",
    inputSchema: {
      type: "object",
      properties: {
        locale: { type: "string", description: "Locale code e.g. 'en-US', 'ja-JP', 'fr-FR'" },
        tabId: { type: "number" },
      },
      required: ["locale"],
    },
  },
  {
    name: "chrome_mock_battery",
    description: "Mock battery status API",
    inputSchema: {
      type: "object",
      properties: {
        charging: { type: "boolean", description: "Is battery charging" },
        chargingTime: { type: "number", description: "Seconds until fully charged" },
        dischargingTime: { type: "number", description: "Seconds until empty" },
        level: { type: "number", description: "Battery level 0.0-1.0" },
        tabId: { type: "number" },
      },
      required: ["charging", "level"],
    },
  },
  {
    name: "chrome_mock_media_type",
    description: "Override CSS media type (print/screen)",
    inputSchema: {
      type: "object",
      properties: {
        mediaType: { type: "string", enum: ["screen", "print"], description: "Media type" },
        tabId: { type: "number" },
      },
      required: ["mediaType"],
    },
  },
  {
    name: "chrome_emulate_vision",
    description: "Emulate vision deficiencies (color blindness, blurred vision)",
    inputSchema: {
      type: "object",
      properties: {
        type: { 
          type: "string", 
          enum: ["none", "achromatopsia", "blurredVision", "deuteranopia", "protanopia", "tritanopia"],
          description: "Vision deficiency type"
        },
        tabId: { type: "number" },
      },
      required: ["type"],
    },
  },
  {
    name: "chrome_cpu_throttle",
    description: "Throttle CPU to simulate slower devices",
    inputSchema: {
      type: "object",
      properties: {
        rate: { type: "number", description: "Throttle rate (1 = no throttle, 4 = 4x slowdown)" },
        tabId: { type: "number" },
      },
      required: ["rate"],
    },
  },
  {
    name: "chrome_mock_date_time",
    description: "Override Date.now() for deterministic testing",
    inputSchema: {
      type: "object",
      properties: {
        timestamp: { type: "number", description: "Unix timestamp in milliseconds" },
        freeze: { type: "boolean", description: "Freeze time at this value" },
        tabId: { type: "number" },
      },
      required: ["timestamp"],
    },
  },
  {
    name: "chrome_modify_response_body",
    description: "Modify response body before page receives it",
    inputSchema: {
      type: "object",
      properties: {
        urlPattern: { type: "string", description: "URL pattern to match" },
        newBody: { type: "string", description: "New response body" },
        tabId: { type: "number" },
      },
      required: ["urlPattern", "newBody"],
    },
  },
  {
    name: "chrome_get_ws_frames",
    description: "Capture WebSocket frames",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number", description: "Max frames to return (default 100)" },
        tabId: { type: "number" },
      },
    },
  },
  {
    name: "chrome_set_extra_headers",
    description: "Add extra HTTP headers to all requests",
    inputSchema: {
      type: "object",
      properties: {
        headers: { type: "object", description: "Headers to add" },
        tabId: { type: "number" },
      },
      required: ["headers"],
    },
  },
  {
    name: "chrome_get_request_body",
    description: "Get POST body of a sent request",
    inputSchema: {
      type: "object",
      properties: {
        requestId: { type: "string", description: "Request ID from debug_get_network" },
        tabId: { type: "number" },
      },
      required: ["requestId"],
    },
  }
  ,
  {
    name: "chrome_profiling_start",
    description: "Start CPU profiling",
    inputSchema: {
      type: "object",
      properties: {
        tabId: { type: "number" },
      },
    },
  },
  {
    name: "chrome_profiling_stop",
    description: "Stop CPU profiling and get profile data",
    inputSchema: {
      type: "object",
      properties: {
        tabId: { type: "number" },
      },
    },
  },
  {
    name: "chrome_heap_snapshot",
    description: "Take a heap snapshot for memory analysis",
    inputSchema: {
      type: "object",
      properties: {
        tabId: { type: "number" },
      },
    },
  },
  {
    name: "chrome_trace_start",
    description: "Start tracing (Timeline/Performance recording)",
    inputSchema: {
      type: "object",
      properties: {
        categories: { type: "array", items: { type: "string" }, description: "Trace categories" },
        tabId: { type: "number" },
      },
    },
  },
  {
    name: "chrome_trace_stop",
    description: "Stop tracing and get trace events",
    inputSchema: {
      type: "object",
      properties: {
        tabId: { type: "number" },
      },
    },
  },
  {
    name: "chrome_pause_on_exception",
    description: "Pause debugger on exceptions",
    inputSchema: {
      type: "object",
      properties: {
        state: { type: "string", enum: ["none", "uncaught", "all"], description: "When to pause" },
        tabId: { type: "number" },
      },
      required: ["state"],
    },
  },
  {
    name: "chrome_debugger_resume",
    description: "Resume execution after debugger pause",
    inputSchema: {
      type: "object",
      properties: {
        tabId: { type: "number" },
      },
    },
  },
  {
    name: "chrome_debugger_step_over",
    description: "Step over current line",
    inputSchema: {
      type: "object",
      properties: {
        tabId: { type: "number" },
      },
    },
  },
  {
    name: "chrome_debugger_step_into",
    description: "Step into function call",
    inputSchema: {
      type: "object",
      properties: {
        tabId: { type: "number" },
      },
    },
  },
  {
    name: "chrome_debugger_step_out",
    description: "Step out of current function",
    inputSchema: {
      type: "object",
      properties: {
        tabId: { type: "number" },
      },
    },
  },
  {
    name: "chrome_get_call_frames",
    description: "Get call stack when paused",
    inputSchema: {
      type: "object",
      properties: {
        tabId: { type: "number" },
      },
    },
  },
  {
    name: "chrome_evaluate_on_call_frame",
    description: "Evaluate expression in paused call frame",
    inputSchema: {
      type: "object",
      properties: {
        callFrameId: { type: "string", description: "Call frame ID" },
        expression: { type: "string", description: "Expression to evaluate" },
        tabId: { type: "number" },
      },
      required: ["callFrameId", "expression"],
    },
  },
  {
    name: "chrome_get_script_source",
    description: "Get source code of a script",
    inputSchema: {
      type: "object",
      properties: {
        scriptId: { type: "string", description: "Script ID" },
        tabId: { type: "number" },
      },
      required: ["scriptId"],
    },
  },
  {
    name: "chrome_live_edit_script",
    description: "Live edit JavaScript without reload",
    inputSchema: {
      type: "object",
      properties: {
        scriptId: { type: "string", description: "Script ID to edit" },
        scriptSource: { type: "string", description: "New script source" },
        tabId: { type: "number" },
      },
      required: ["scriptId", "scriptSource"],
    },
  },
  {
    name: "chrome_call_function_on",
    description: "Call function on remote object",
    inputSchema: {
      type: "object",
      properties: {
        objectId: { type: "string", description: "Remote object ID" },
        functionDeclaration: { type: "string", description: "Function to call" },
        arguments: { type: "array", description: "Function arguments" },
        tabId: { type: "number" },
      },
      required: ["objectId", "functionDeclaration"],
    },
  },
  {
    name: "chrome_get_properties",
    description: "Get properties of a remote object",
    inputSchema: {
      type: "object",
      properties: {
        objectId: { type: "string", description: "Remote object ID" },
        ownProperties: { type: "boolean", description: "Only own properties" },
        tabId: { type: "number" },
      },
      required: ["objectId"],
    },
  },
  {
    name: "chrome_compile_script",
    description: "Check JavaScript syntax without executing",
    inputSchema: {
      type: "object",
      properties: {
        expression: { type: "string", description: "JavaScript code to compile" },
        sourceURL: { type: "string", description: "Source URL for error reporting" },
        tabId: { type: "number" },
      },
      required: ["expression"],
    },
  }
  ,
  {
    name: "chrome_get_indexeddb",
    description: "Read IndexedDB data from the page",
    inputSchema: {
      type: "object",
      properties: {
        databaseName: { type: "string", description: "Database name" },
        objectStoreName: { type: "string", description: "Object store name" },
        tabId: { type: "number" },
      },
      required: ["databaseName", "objectStoreName"],
    },
  },
  {
    name: "chrome_get_session_storage",
    description: "Read sessionStorage from the page",
    inputSchema: {
      type: "object",
      properties: {
        key: { type: "string", description: "Specific key (omit to get all)" },
        tabId: { type: "number" },
      },
    },
  },
  {
    name: "chrome_get_cache_storage",
    description: "Read Service Worker cache storage",
    inputSchema: {
      type: "object",
      properties: {
        cacheName: { type: "string", description: "Cache name" },
        tabId: { type: "number" },
      },
      required: ["cacheName"],
    },
  },
  {
    name: "chrome_get_security_state",
    description: "Get HTTPS security state and certificate info",
    inputSchema: {
      type: "object",
      properties: {
        tabId: { type: "number" },
      },
    },
  },
  {
    name: "chrome_ignore_cert_errors",
    description: "Ignore SSL certificate errors",
    inputSchema: {
      type: "object",
      properties: {
        ignore: { type: "boolean", description: "true to ignore, false to restore" },
        tabId: { type: "number" },
      },
      required: ["ignore"],
    },
  },
  {
    name: "chrome_set_color_scheme",
    description: "Force dark or light mode",
    inputSchema: {
      type: "object",
      properties: {
        scheme: { type: "string", enum: ["light", "dark", "no-preference"], description: "Color scheme" },
        tabId: { type: "number" },
      },
      required: ["scheme"],
    },
  },
  {
    name: "chrome_highlight_element",
    description: "Highlight element on screen (for debugging)",
    inputSchema: {
      type: "object",
      properties: {
        selector: { type: "string", description: "CSS selector" },
        color: { type: "string", description: "Highlight color (default red)" },
        tabId: { type: "number" },
      },
      required: ["selector"],
    },
  },
  {
    name: "chrome_hide_element",
    description: "Hide or show element",
    inputSchema: {
      type: "object",
      properties: {
        selector: { type: "string", description: "CSS selector" },
        hide: { type: "boolean", description: "true to hide, false to show" },
        tabId: { type: "number" },
      },
      required: ["selector", "hide"],
    },
  },
  {
    name: "chrome_dom_set_attribute",
    description: "Set DOM attribute via CDP",
    inputSchema: {
      type: "object",
      properties: {
        selector: { type: "string", description: "CSS selector" },
        name: { type: "string", description: "Attribute name" },
        value: { type: "string", description: "Attribute value" },
        tabId: { type: "number" },
      },
      required: ["selector", "name", "value"],
    },
  },
  {
    name: "chrome_dom_remove_node",
    description: "Remove DOM node",
    inputSchema: {
      type: "object",
      properties: {
        selector: { type: "string", description: "CSS selector" },
        tabId: { type: "number" },
      },
      required: ["selector"],
    },
  },

  {
    name: "chrome_stealth_enable",
    description: "Enable anti-fingerprint stealth spoofs on a tab via MAIN-world injection and CDP. Each flag toggles one vector independently.",
    inputSchema: {
      type: "object",
      properties: {
        tabId: { type: "number" },
        webdriver: { type: "boolean" },
        chromeRuntime: { type: "boolean" },
        plugins: { type: "boolean" },
        languages: { type: "boolean", default: true },
        hardwareConcurrency: { type: "number" },
        deviceMemory: { type: "number" },
        vendor: { type: "string" },
        platform: { type: "string" },
        canvasNoise: { type: "boolean" },
        webglVendor: { type: "boolean" },
        webglRenderer: { type: "string" },
        webglVendorString: { type: "string" },
        audioNoise: { type: "boolean" },
        fontSpoof: { type: "boolean" },
        codecs: { type: "boolean" },
        permissions: { type: "boolean" },
        outerSize: { type: "boolean" },
        seed: { type: "number" },
        persist: { type: "boolean", default: true },
      },
    },
  },
  {
    name: "chrome_stealth_disable",
    description: "Disable and remove all stealth spoofs on a tab",
    inputSchema: {
      type: "object",
      properties: {
        tabId: { type: "number" },
      },
    },
  },
  {
    name: "chrome_stealth_status",
    description: "Get active stealth flags and seed for a tab",
    inputSchema: {
      type: "object",
      properties: {
        tabId: { type: "number" },
      },
    },
  },

  {
    name: "chrome_set_proxy",
    description: "Set browser proxy",
    inputSchema: {
      type: "object",
      properties: {
        mode: { type: "string", enum: ["direct", "fixed_servers", "pac_script"] },
        proxyForHttp: { type: "string" },
        proxyForHttps: { type: "string" },
        proxyForFtp: { type: "string" },
        bypassList: { type: "array", items: { type: "string" } },
        pacUrl: { type: "string" },
        pacScript: { type: "string" },
      },
    },
  },
  {
    name: "chrome_clear_proxy",
    description: "Clear proxy to direct",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "chrome_get_proxy",
    description: "Get proxy config",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "chrome_set_webrtc_policy",
    description: "Prevent WebRTC IP leak",
    inputSchema: {
      type: "object",
      properties: {
        policy: { type: "string", enum: ["default", "disable_non_proxied_udp", "proxy_only"], description: "WebRTC policy" },
      },
      required: ["policy"],
    },
  },
  {
    name: "chrome_get_webrtc_policy",
    description: "Get WebRTC policy",
    inputSchema: { type: "object", properties: {} },
  },

  {
    name: "chrome_handle_dialog",
    description: "Handle JavaScript dialog (alert, confirm, prompt)",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["accept", "dismiss"] },
        promptText: { type: "string" },
        tabId: { type: "number" },
      },
      required: ["action"],
    },
  },
  {
    name: "chrome_fill_form",
    description: "Fill multiple form fields in one call",
    inputSchema: {
      type: "object",
      properties: {
        fields: { type: "array", items: { type: "object", properties: { selector: { type: "string" }, value: { type: "string" } } } },
        submitSelector: { type: "string" },
        tabId: { type: "number" },
      },
      required: ["fields"],
    },
  },
  {
    name: "chrome_check",
    description: "Check a checkbox",
    inputSchema: {
      type: "object",
      properties: {
        selector: { type: "string" },
        tabId: { type: "number" },
      },
      required: ["selector"],
    },
  },
  {
    name: "chrome_uncheck",
    description: "Uncheck a checkbox",
    inputSchema: {
      type: "object",
      properties: {
        selector: { type: "string" },
        tabId: { type: "number" },
      },
      required: ["selector"],
    },
  },
  {
    name: "chrome_wait_for_text",
    description: "Wait for text to appear on page",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        timeout: { type: "number", default: 5000 },
        exact: { type: "boolean" },
        tabId: { type: "number" },
      },
      required: ["query"],
    },
  },
  {
    name: "chrome_verify_element_visible",
    description: "Verify element is visible",
    inputSchema: {
      type: "object",
      properties: {
        selector: { type: "string" },
        tabId: { type: "number" },
      },
      required: ["selector"],
    },
  },
  {
    name: "chrome_verify_text_visible",
    description: "Verify text is visible on page",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        tabId: { type: "number" },
      },
      required: ["query"],
    },
  },
  {
    name: "chrome_verify_value",
    description: "Verify input value matches expected",
    inputSchema: {
      type: "object",
      properties: {
        selector: { type: "string" },
        expected: { type: "string" },
        tabId: { type: "number" },
      },
      required: ["selector", "expected"],
    },
  },
  {
    name: "chrome_generate_locator",
    description: "Generate Playwright locator string for element",
    inputSchema: {
      type: "object",
      properties: {
        selector: { type: "string" },
        tabId: { type: "number" },
      },
      required: ["selector"],
    },
  },

  {
    name: "chrome_lighthouse_audit",
    description: "Heuristic audit, not full Google Lighthouse. Returns accessibility, SEO, best-practices scores.",
    inputSchema: {
      type: "object",
      properties: {
        tabId: { type: "number" },
        device: { type: "string", enum: ["desktop", "mobile"], default: "desktop" },
        categories: { type: "array", items: { type: "string" }, default: ["accessibility", "seo", "best-practices"] },
      },
    },
  },
  {
    name: "chrome_performance_insight",
    description: "Get performance insights including Core Web Vitals estimates",
    inputSchema: {
      type: "object",
      properties: {
        tabId: { type: "number" },
      },
    },
  },

  {
    name: "chrome_screencast_start",
    description: "Start screencast recording",
    inputSchema: {
      type: "object",
      properties: {
        tabId: { type: "number" },
        quality: { type: "number", default: 80 },
        maxFrames: { type: "number", default: 60 },
      },
    },
  },
  {
    name: "chrome_screencast_stop",
    description: "Stop screencast recording",
    inputSchema: {
      type: "object",
      properties: {
        tabId: { type: "number" },
      },
    },
  },
  {
    name: "chrome_resize_page",
    description: "Resize page viewport",
    inputSchema: {
      type: "object",
      properties: {
        width: { type: "number" },
        height: { type: "number" },
        tabId: { type: "number" },
      },
      required: ["width", "height"],
    },
  },
  {
    name: "chrome_emulate",
    description: "Unified device emulation",
    inputSchema: {
      type: "object",
      properties: {
        viewportWidth: { type: "number" },
        viewportHeight: { type: "number" },
        deviceScaleFactor: { type: "number" },
        mobile: { type: "boolean" },
        userAgent: { type: "string" },
        locale: { type: "string" },
        timezone: { type: "string" },
        colorScheme: { type: "string", enum: ["light", "dark"] },
        tabId: { type: "number" },
      },
    },
  },
  {
    name: "chrome_mouse_move",
    description: "Move mouse to coordinates",
    inputSchema: {
      type: "object",
      properties: {
        x: { type: "number" },
        y: { type: "number" },
        tabId: { type: "number" },
      },
      required: ["x", "y"],
    },
  },
  {
    name: "chrome_mouse_down",
    description: "Press mouse button",
    inputSchema: {
      type: "object",
      properties: {
        button: { type: "string", enum: ["left", "right", "middle"], default: "left" },
        tabId: { type: "number" },
      },
    },
  },
  {
    name: "chrome_mouse_up",
    description: "Release mouse button",
    inputSchema: {
      type: "object",
      properties: {
        button: { type: "string", enum: ["left", "right", "middle"], default: "left" },
        tabId: { type: "number" },
      },
    },
  },
  {
    name: "chrome_mouse_wheel",
    description: "Scroll mouse wheel",
    inputSchema: {
      type: "object",
      properties: {
        deltaX: { type: "number" },
        deltaY: { type: "number" },
        tabId: { type: "number" },
      },
    },
  },
  {
    name: "chrome_click_at",
    description: "Click at coordinates",
    inputSchema: {
      type: "object",
      properties: {
        x: { type: "number" },
        y: { type: "number" },
        tabId: { type: "number" },
      },
      required: ["x", "y"],
    },
  },

  {
    name: "chrome_heap_summary",
    description: "Get heap summary",
    inputSchema: {
      type: "object",
      properties: {
        tabId: { type: "number" },
      },
    },
  },
  {
    name: "chrome_heap_query_objects",
    description: "Query heap objects by class name",
    inputSchema: {
      type: "object",
      properties: {
        className: { type: "string" },
        tabId: { type: "number" },
      },
      required: ["className"],
    },
  },

  {
    name: "chrome_cookie_clear",
    description: "Clear all cookies for URL",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string" },
      },
      required: ["url"],
    },
  },
  {
    name: "chrome_localstorage_list",
    description: "List localStorage keys",
    inputSchema: {
      type: "object",
      properties: {
        tabId: { type: "number" },
      },
    },
  },
  {
    name: "chrome_localstorage_delete",
    description: "Delete localStorage key",
    inputSchema: {
      type: "object",
      properties: {
        key: { type: "string" },
        tabId: { type: "number" },
      },
      required: ["key"],
    },
  },
  {
    name: "chrome_sessionstorage_set",
    description: "Set sessionStorage value",
    inputSchema: {
      type: "object",
      properties: {
        key: { type: "string" },
        value: { type: "string" },
        tabId: { type: "number" },
      },
      required: ["key", "value"],
    },
  },
  {
    name: "chrome_sessionstorage_get",
    description: "Get sessionStorage value",
    inputSchema: {
      type: "object",
      properties: {
        key: { type: "string" },
        tabId: { type: "number" },
      },
    },
  },
  {
    name: "chrome_sessionstorage_delete",
    description: "Delete sessionStorage key",
    inputSchema: {
      type: "object",
      properties: {
        key: { type: "string" },
        tabId: { type: "number" },
      },
      required: ["key"],
    },
  },
  {
    name: "chrome_sessionstorage_clear",
    description: "Clear sessionStorage",
    inputSchema: {
      type: "object",
      properties: {
        tabId: { type: "number" },
      },
    },
  },
  {
    name: "chrome_route_list",
    description: "List mock routes",
    inputSchema: {
      type: "object",
      properties: {
        tabId: { type: "number" },
      },
    },
  },
  {
    name: "chrome_unroute",
    description: "Remove mock route",
    inputSchema: {
      type: "object",
      properties: {
        urlPattern: { type: "string" },
        tabId: { type: "number" },
      },
      required: ["urlPattern"],
    },
  },
  {
    name: "chrome_network_state_set",
    description: "Set network offline/online state",
    inputSchema: {
      type: "object",
      properties: {
        offline: { type: "boolean" },
        tabId: { type: "number" },
      },
      required: ["offline"],
    },
  },
  {
    name: "chrome_get_network_request",
    description: "Get network request by ID",
    inputSchema: {
      type: "object",
      properties: {
        requestId: { type: "string" },
        tabId: { type: "number" },
      },
      required: ["requestId"],
    },
  },
  {
    name: "chrome_indexeddb_list",
    description: "List IndexedDB databases",
    inputSchema: {
      type: "object",
      properties: {
        tabId: { type: "number" },
      },
    },
  },
  {
    name: "chrome_indexeddb_clear",
    description: "Clear IndexedDB object store",
    inputSchema: {
      type: "object",
      properties: {
        databaseName: { type: "string" },
        objectStoreName: { type: "string" },
        tabId: { type: "number" },
      },
      required: ["databaseName", "objectStoreName"],
    },
  },

  {
    name: "chrome_list_extensions",
    description: "List installed extensions",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "chrome_enable_extension",
    description: "Enable extension",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
      },
      required: ["id"],
    },
  },
  {
    name: "chrome_disable_extension",
    description: "Disable extension",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
      },
      required: ["id"],
    },
  },
  {
    name: "chrome_reload_extension",
    description: "Reload extension",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
      },
      required: ["id"],
    },
  },
  {
    name: "chrome_trigger_extension_action",
    description: "Trigger extension action",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
      },
      required: ["id"],
    },
  },
  {
    name: "chrome_pwa_check",
    description: "Check PWA installability",
    inputSchema: {
      type: "object",
      properties: {
        tabId: { type: "number" },
      },
    },
  },
  {
    name: "chrome_list_webmcp_tools",
    description: "List WebMCP tools on page",
    inputSchema: {
      type: "object",
      properties: {
        tabId: { type: "number" },
      },
    },
  },
  {
    name: "chrome_execute_webmcp_tool",
    description: "Execute WebMCP tool",
    inputSchema: {
      type: "object",
      properties: {
        toolName: { type: "string" },
        params: { type: "object" },
        tabId: { type: "number" },
      },
      required: ["toolName"],
    },
  },

  {
    name: "chrome_screenshot_element",
    description: "Take screenshot of specific element. Returns base64 image.",
    inputSchema: {
      type: "object",
      properties: {
        selector: { type: "string" },
        format: { type: "string", enum: ["png", "jpeg"] },
        quality: { type: "number" },
        tabId: { type: "number" },
      },
      required: ["selector"],
    },
  },
  {
    name: "chrome_screenshot_fullpage",
    description: "Take full page screenshot. Returns base64 image.",
    inputSchema: {
      type: "object",
      properties: {
        format: { type: "string", enum: ["png", "jpeg"] },
        quality: { type: "number" },
        tabId: { type: "number" },
      },
    },
  },
  {
    name: "chrome_pdf_print",
    description: "Print page to PDF. Returns base64 PDF.",
    inputSchema: {
      type: "object",
      properties: {
        landscape: { type: "boolean" },
        displayHeaderFooter: { type: "boolean" },
        printBackground: { type: "boolean" },
        scale: { type: "number" },
        paperWidth: { type: "number" },
        paperHeight: { type: "number" },
        marginTop: { type: "number" },
        marginBottom: { type: "number" },
        marginLeft: { type: "number" },
        marginRight: { type: "number" },
        tabId: { type: "number" },
      },
    },
  }
];

// TOOL GRAPH (server-side, no extension needed)
const TOOL_GRAPH: Record<string, {
  description: string;
  intent: string[];
  requires?: string[];
  next?: string[];
  avoid?: string[];
  cost: "low" | "medium" | "high";
}> = {
  // Observation (cheap, always prefer first)
  chrome_get_active_tab:    { description: "Get current tab info", intent: ["what tab am I on", "current url", "current tab"], cost: "low", next: ["chrome_get_content","chrome_get_page_info","chrome_screenshot"] },
  chrome_list_tabs:         { description: "List all open tabs", intent: ["how many tabs", "find tab", "list tabs", "all tabs open"], cost: "low", next: ["chrome_switch_tab","chrome_close_tab"] },
  chrome_get_page_info:     { description: "Title, URL, links, meta", intent: ["page title", "page url", "links on page", "meta description"], cost: "low", next: ["chrome_get_content","chrome_find_elements"] },
  chrome_get_content:       { description: "Full visible text of page", intent: ["read page", "page text", "what does page say", "extract text", "scrape"], cost: "low", avoid: ["chrome_get_html"] },
  chrome_get_workflow_context: { description: "Forms, buttons, inputs snapshot — use BEFORE interacting with a page", intent: ["plan interaction", "find form", "find button", "what inputs exist", "how to fill form"], cost: "low", next: ["chrome_click","chrome_type","chrome_find_accessible_nodes"] },
  chrome_find_elements:     { description: "Find matching DOM elements", intent: ["find elements", "query selector", "list buttons", "list links"], cost: "low" },
  chrome_get_element_info:  { description: "Info about one element", intent: ["is element visible", "element position", "element attributes"], cost: "low" },
  chrome_list_iframes:      { description: "List all iframes", intent: ["iframes on page", "embedded frames"], cost: "low", next: ["chrome_switch_iframe"] },
  chrome_get_accessibility_tree: { description: "Full AX tree for finding by label/role", intent: ["find by label", "accessible name", "aria role"], cost: "medium", avoid: ["chrome_find_elements"] },
  chrome_find_accessible_nodes:  { description: "Find AX node by name and role", intent: ["find button by label", "find input by name", "click button named"], cost: "medium", next: ["chrome_visual_click"] },
  chrome_ocr_page:          { description: "All text with bounding boxes", intent: ["find text position", "where is text on screen"], cost: "medium", avoid: ["chrome_screenshot"] },
  chrome_find_text_on_screen: { description: "Find text and get click coordinates", intent: ["click text", "find text on screen", "where is button"], cost: "medium", next: ["chrome_visual_click"] },

  // Navigation (medium cost)
  chrome_navigate:          { description: "Go to URL", intent: ["open url", "go to", "navigate to", "open website"], cost: "low", next: ["chrome_wait_for_element","chrome_get_page_info"] },
  chrome_new_tab:           { description: "Open new tab", intent: ["open new tab", "new tab", "open in new tab"], cost: "low" },
  chrome_switch_tab:        { description: "Focus a tab by ID", intent: ["switch to tab", "go to tab"], cost: "low", requires: ["chrome_list_tabs"] },
  chrome_go_back:           { description: "Browser back", intent: ["go back", "previous page"], cost: "low" },
  chrome_go_forward:        { description: "Browser forward", intent: ["go forward", "next page"], cost: "low" },
  chrome_reload_tab:        { description: "Reload tab", intent: ["reload", "refresh page"], cost: "low" },

  // Interaction (medium cost — always prefer get_workflow_context first)
  chrome_click:             { description: "Click by CSS selector", intent: ["click button", "click link", "press button"], cost: "low", requires: ["chrome_get_workflow_context"], avoid: ["chrome_visual_click"] },
  chrome_type:              { description: "Type into input by selector", intent: ["type text", "fill input", "enter text in field"], cost: "low", requires: ["chrome_get_workflow_context"] },
  chrome_key_press:         { description: "Press a key (Enter, Escape)", intent: ["press enter", "press escape", "submit form"], cost: "low" },
  chrome_hover:             { description: "Hover over element", intent: ["hover", "mouse over", "tooltip"], cost: "low" },
  chrome_select:            { description: "Select dropdown option", intent: ["select option", "choose dropdown"], cost: "low" },
  chrome_scroll:            { description: "Scroll page by pixels", intent: ["scroll down", "scroll up"], cost: "low" },
  chrome_wait_for_element:  { description: "Wait for element to appear", intent: ["wait for load", "wait for element", "page loading"], cost: "low", next: ["chrome_click","chrome_get_content"] },
  chrome_visual_click:      { description: "Click by X/Y coordinates", intent: ["click coordinate", "click position"], cost: "medium", avoid: ["chrome_click"], requires: ["chrome_find_text_on_screen"] },
  chrome_upload_file:       { description: "Set files on file input", intent: ["upload file", "attach file"], cost: "medium", requires: ["chrome_debug_attach"] },
  chrome_switch_iframe:     { description: "Execute code inside iframe", intent: ["interact iframe", "iframe content"], cost: "medium", requires: ["chrome_list_iframes"] },

  // Screenshot (expensive — avoid unless visual check needed)
  chrome_screenshot:        { description: "Screenshot of visible tab", intent: ["take screenshot", "capture page", "see page visually"], cost: "high", avoid: ["chrome_get_content","chrome_get_page_info"] },

  // Debug tools (require attach first)
  chrome_debug_attach:      { description: "Attach CDP debugger", intent: ["debug tab", "capture network", "read console", "monitor requests"], cost: "medium", next: ["chrome_debug_get_network","chrome_debug_get_logs","chrome_debug_get_performance"] },
  chrome_debug_get_logs:    { description: "Read console logs", intent: ["console log", "js error", "read logs"], cost: "low", requires: ["chrome_debug_attach"] },
  chrome_debug_get_network: { description: "List captured network requests", intent: ["api calls", "network requests", "xhr", "fetch calls"], cost: "low", requires: ["chrome_debug_attach"] },
  chrome_debug_get_response_body: { description: "Read response body of request", intent: ["api response", "response body", "what did api return"], cost: "low", requires: ["chrome_debug_attach","chrome_debug_get_network"] },
  chrome_debug_eval:        { description: "Eval JS via CDP (async-safe)", intent: ["run async js", "await in page", "bypass csp"], cost: "medium", requires: ["chrome_debug_attach"], avoid: ["chrome_execute_script"] },
  chrome_debug_get_performance: { description: "JS heap, DOM node count, layout metrics", intent: ["performance", "memory usage", "page metrics"], cost: "medium", requires: ["chrome_debug_attach"] },
  chrome_debug_emulate_device: { description: "Mobile device emulation", intent: ["mobile view", "responsive test", "iphone view"], cost: "medium", requires: ["chrome_debug_attach"] },
  chrome_debug_emulate_network: { description: "Throttle network", intent: ["slow network", "offline test", "3g simulation"], cost: "medium", requires: ["chrome_debug_attach"] },
  chrome_debug_block_urls:  { description: "Block URL patterns", intent: ["block ads", "block tracker", "block request"], cost: "medium", requires: ["chrome_debug_attach"] },
  chrome_debug_get_cookies: { description: "Get all cookies incl HttpOnly", intent: ["httponly cookie", "session cookie", "all cookies"], cost: "low", requires: ["chrome_debug_attach"], avoid: ["chrome_get_cookies"] },
  chrome_intercept_request: { description: "Intercept requests via CDP Fetch", intent: ["intercept api", "intercept request"], cost: "medium", requires: ["chrome_debug_attach"] },
  chrome_mock_response:     { description: "Mock a URL response", intent: ["mock api", "fake response"], cost: "low", requires: ["chrome_intercept_request"] },
  chrome_modify_headers:    { description: "Auto-modify request headers", intent: ["add auth header", "change user agent", "modify request"], cost: "medium", requires: ["chrome_debug_attach"] },
  chrome_export_har:        { description: "Export HAR archive", intent: ["export network log", "har file"], cost: "low", requires: ["chrome_debug_attach","chrome_debug_get_network"] },
  chrome_replay_request:    { description: "Re-send HTTP request", intent: ["replay api", "resend request", "test api"], cost: "medium" },

  // Session
  chrome_save_session:      { description: "Save cookies+localStorage", intent: ["save login", "save session", "bookmark session"], cost: "low" },
  chrome_restore_session:   { description: "Restore saved session", intent: ["restore login", "load session"], cost: "low" },

  // Events / DOM watch
  chrome_subscribe_events:  { description: "Listen to DOM events", intent: ["watch events", "detect clicks", "monitor input"], cost: "low" },
  chrome_watch_dom_changes: { description: "Watch DOM mutations", intent: ["watch dom", "detect changes", "mutation observer"], cost: "low" },
  // Permissions / Auth
  chrome_grant_permissions: { description: "Grant origin permissions", intent: ["allow camera", "allow location", "grant permission"], cost: "medium", requires: ["chrome_debug_attach"] },
  chrome_virtual_authenticator: { description: "WebAuthn virtual authenticator", intent: ["test passkey", "fido2 test", "webauthn"], cost: "medium", requires: ["chrome_debug_attach"] },

  // Storage
  chrome_get_cookies:       { description: "Get cookies for URL", intent: ["get cookies", "cookie value"], cost: "low" },
  chrome_get_local_storage: { description: "Read localStorage", intent: ["localstorage", "local storage value"], cost: "low" },
  chrome_get_history:       { description: "Search browser history", intent: ["browser history", "visited sites"], cost: "low" },

  chrome_stealth_enable:    { description: "Anti-fingerprint spoofs with per-vector toggles", intent: ["stealth", "hide webdriver", "spoof canvas", "spoof webgl", "anti bot", "fingerprint", "hide automation"], cost: "medium", requires: ["chrome_debug_attach"], next: ["chrome_stealth_status", "chrome_navigate"] },
  chrome_stealth_disable:   { description: "Remove stealth spoofs", intent: ["disable stealth", "remove spoof"], cost: "low" },
  chrome_stealth_status:    { description: "Active stealth flags", intent: ["stealth status", "stealth config"], cost: "low" },

  chrome_set_proxy:         { description: "Set browser proxy", intent: ["set proxy", "proxy server", "socks5", "http proxy", "rotate ip"], cost: "medium", next: ["chrome_get_proxy"] },
  chrome_clear_proxy:       { description: "Clear proxy to direct", intent: ["clear proxy", "disable proxy", "direct connection"], cost: "low" },
  chrome_get_proxy:         { description: "Get proxy config", intent: ["proxy status", "proxy config"], cost: "low" },
  chrome_set_webrtc_policy: { description: "Prevent WebRTC IP leak", intent: ["webrtc leak", "hide ip", "webrtc policy"], cost: "low", requires: ["chrome_set_proxy"] },

  chrome_handle_dialog:     { description: "Handle JavaScript dialog", intent: ["handle dialog", "alert", "confirm", "prompt"], cost: "low" },
  chrome_fill_form:         { description: "Fill multiple form fields", intent: ["fill form", "batch fill", "fill multiple"], cost: "low" },
  chrome_check:             { description: "Check checkbox", intent: ["check checkbox"], cost: "low" },
  chrome_uncheck:           { description: "Uncheck checkbox", intent: ["uncheck checkbox"], cost: "low" },
  chrome_wait_for_text:     { description: "Wait for text on page", intent: ["wait for text"], cost: "low" },
  chrome_verify_element_visible: { description: "Verify element visible", intent: ["assert visible", "verify element"], cost: "low" },
  chrome_verify_text_visible: { description: "Verify text visible", intent: ["assert text", "verify text"], cost: "low" },
  chrome_verify_value:      { description: "Verify input value", intent: ["assert value", "verify value"], cost: "low" },
  chrome_generate_locator:  { description: "Generate Playwright locator", intent: ["generate locator", "playwright code"], cost: "low" },

  chrome_lighthouse_audit:  { description: "Heuristic audit for accessibility, SEO, best-practices", intent: ["lighthouse", "audit", "accessibility score", "seo score"], cost: "medium", requires: ["chrome_debug_attach"] },
  chrome_performance_insight: { description: "Performance insights and Core Web Vitals", intent: ["performance insight", "core web vitals", "lcp", "cls"], cost: "medium", requires: ["chrome_debug_attach"] },

  chrome_screencast_start:  { description: "Start screencast recording", intent: ["record video", "screencast"], cost: "medium", requires: ["chrome_debug_attach"] },
  chrome_screencast_stop:   { description: "Stop screencast recording", intent: ["stop screencast"], cost: "low" },
  chrome_resize_page:       { description: "Resize page viewport", intent: ["resize window", "viewport size"], cost: "low" },
  chrome_emulate:           { description: "Unified device emulation", intent: ["emulate device", "unified emulate"], cost: "medium", requires: ["chrome_debug_attach"] },
  chrome_mouse_move:        { description: "Move mouse to coordinates", intent: ["mouse move"], cost: "medium", requires: ["chrome_debug_attach"] },
  chrome_mouse_down:        { description: "Press mouse button", intent: ["mouse down"], cost: "medium", requires: ["chrome_debug_attach"] },
  chrome_mouse_up:          { description: "Release mouse button", intent: ["mouse up"], cost: "medium", requires: ["chrome_debug_attach"] },
  chrome_mouse_wheel:       { description: "Scroll mouse wheel", intent: ["mouse wheel"], cost: "medium", requires: ["chrome_debug_attach"] },
  chrome_click_at:          { description: "Click at coordinates", intent: ["click coordinate", "coordinate click"], cost: "medium", requires: ["chrome_debug_attach"] },

  chrome_heap_summary:      { description: "Get heap summary", intent: ["heap summary", "memory usage"], cost: "medium", requires: ["chrome_debug_attach"] },
  chrome_heap_query_objects: { description: "Query heap objects", intent: ["heap objects", "query objects"], cost: "medium", requires: ["chrome_debug_attach"] },

  chrome_cookie_clear:      { description: "Clear cookies for URL", intent: ["clear cookies"], cost: "low" },
  chrome_localstorage_list: { description: "List localStorage keys", intent: ["list localstorage"], cost: "low" },
  chrome_localstorage_delete: { description: "Delete localStorage key", intent: ["delete localstorage"], cost: "low" },
  chrome_sessionstorage_set: { description: "Set sessionStorage value", intent: ["set sessionstorage"], cost: "low" },
  chrome_sessionstorage_get: { description: "Get sessionStorage value", intent: ["get sessionstorage"], cost: "low" },
  chrome_sessionstorage_delete: { description: "Delete sessionStorage key", intent: ["delete sessionstorage"], cost: "low" },
  chrome_sessionstorage_clear: { description: "Clear sessionStorage", intent: ["clear sessionstorage"], cost: "low" },
  chrome_route_list:        { description: "List mock routes", intent: ["list mocks", "list routes"], cost: "low" },
  chrome_unroute:           { description: "Remove mock route", intent: ["remove mock", "unroute"], cost: "low" },
  chrome_network_state_set: { description: "Set network state", intent: ["offline", "network state"], cost: "low", requires: ["chrome_debug_attach"] },
  chrome_get_network_request: { description: "Get network request by ID", intent: ["get request"], cost: "low", requires: ["chrome_debug_attach"] },
  chrome_indexeddb_list:    { description: "List IndexedDB databases", intent: ["list indexeddb"], cost: "low" },
  chrome_indexeddb_clear:   { description: "Clear IndexedDB store", intent: ["clear indexeddb"], cost: "low" },

  chrome_list_extensions:   { description: "List installed extensions", intent: ["list extensions"], cost: "low" },
  chrome_enable_extension:  { description: "Enable extension", intent: ["enable extension"], cost: "low" },
  chrome_disable_extension: { description: "Disable extension", intent: ["disable extension"], cost: "low" },
  chrome_reload_extension:  { description: "Reload extension", intent: ["reload extension"], cost: "low" },
  chrome_trigger_extension_action: { description: "Trigger extension action", intent: ["trigger action"], cost: "low" },
  chrome_pwa_check:         { description: "Check PWA installability", intent: ["pwa check", "installable"], cost: "medium", requires: ["chrome_debug_attach"] },
  chrome_list_webmcp_tools: { description: "List WebMCP tools", intent: ["webmcp", "list tools"], cost: "low" },
  chrome_execute_webmcp_tool: { description: "Execute WebMCP tool", intent: ["webmcp execute"], cost: "medium" },

  chrome_screenshot_element: { description: "Screenshot of element", intent: ["screenshot element"], cost: "high", requires: ["chrome_debug_attach"] },
  chrome_screenshot_fullpage: { description: "Full page screenshot", intent: ["full page screenshot"], cost: "high", requires: ["chrome_debug_attach"] },
  chrome_pdf_print:         { description: "Print to PDF", intent: ["pdf print", "print page"], cost: "high", requires: ["chrome_debug_attach"] },
};

server.setRequestHandler(ListToolsRequestSchema, async () => {
  const tools = DECISION_CONFIGURED
    ? TOOLS
    : TOOLS.filter((t) => t.name !== "chrome_rank_candidates");
  return { tools };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  // Tool Graph: handled server-side, no extension needed
  if (name === "chrome_get_tool_graph") {
    const intent = (args?.intent as string || "").toLowerCase();
    const filterTools = args?.tools as string[] | undefined;

    type GraphEntry = typeof TOOL_GRAPH[keyof typeof TOOL_GRAPH];
    let graph: Record<string, GraphEntry> = filterTools
      ? Object.fromEntries(filterTools.map(t => [t, TOOL_GRAPH[t as keyof typeof TOOL_GRAPH]]).filter(([,v]) => v))
      : TOOL_GRAPH;

    // If intent provided, score and rank by relevance
    if (intent) {
      const scored = Object.entries(graph)
        .map(([tool, info]) => {
          const typedInfo = info as GraphEntry;
          const score = typedInfo.intent.reduce((s: number, kw: string) =>
            s + (intent.includes(kw) ? 2 : kw.split(" ").some((w: string) => intent.includes(w)) ? 1 : 0), 0);
          return { tool, score, info: typedInfo };
        })
        .filter(e => e.score > 0)
        .sort((a, b) => b.score - a.score);

      const result = {
        intent,
        recommended: scored.slice(0, 5).map(e => ({
          tool: e.tool,
          description: e.info.description,
          cost: e.info.cost,
          requires: e.info.requires || [],
          next: e.info.next || [],
          avoid: e.info.avoid || [],
        })),
        avoid_these: scored.flatMap(e => e.info.avoid || []).filter((v,i,a) => a.indexOf(v) === i),
        execution_order: scored
          .slice(0, 5)
          .sort((a, b) => {
            const costs: Record<string, number> = { low: 0, medium: 1, high: 2 };
            return costs[a.info.cost] - costs[b.info.cost];
          })
          .map(e => e.tool),
      };
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }

    // No intent — return full graph summary
    const summary = Object.entries(graph).map(([tool, info]) => {
      const typedInfo = info as GraphEntry;
      return {
        tool,
        description: typedInfo.description,
        cost: typedInfo.cost,
        intent_keywords: typedInfo.intent,
        requires: typedInfo.requires || [],
        avoid: typedInfo.avoid || [],
        next: typedInfo.next || [],
      };
    });
    return { content: [{ type: "text", text: JSON.stringify(summary, null, 2) }] };
  }

  // Client list: handled server-side, no extension needed
  if (name === "chrome_list_clients") {
    return { content: [{ type: "text", text: JSON.stringify(listClients(), null, 2) }] };
  }

  // System-one candidate ranking: handled server-side, no extension needed
  if (name === "chrome_rank_candidates") {
    if (!DECISION_CONFIGURED) {
      return {
        content: [{
          type: "text",
          text: "Error: chrome_rank_candidates is disabled. Set DECISION_ENDPOINT and " +
                "DECISION_API_KEY in the server environment to enable it.",
        }],
        isError: true,
      };
    }

    const intent = (args?.intent as string) || "";
    const candidates = (args?.candidates as string[]) || [];
    const topK = (args?.top_k as number) || 1;

    if (!intent) {
      return { content: [{ type: "text", text: "Error: intent is required" }], isError: true };
    }
    if (!candidates.length) {
      return { content: [{ type: "text", text: "Error: candidates array is empty" }], isError: true };
    }
    if (candidates.length > 50) {
      return {
        content: [{
          type: "text",
          text: `Error: ${candidates.length} candidates exceeds the practical limit (~50). ` +
                `Filter the list down first, or split into batches.`,
        }],
        isError: true,
      };
    }

    const criteria: Record<string, string> = {};
    candidates.forEach((c, i) => { criteria[`c${i}`] = c; });

    try {
      const { response, latency_ms } = await callSystemOne(intent, {
        best_match: {
          type: "choice",
          instructions: intent,
          criteria,
        },
      });

      const answer = response.answers?.best_match || {};
      const probs: Record<string, number> = answer.probabilities || {};

      const ranked = Object.entries(probs)
        .sort(([, a], [, b]) => b - a)
        .slice(0, topK)
        .map(([key, prob]) => ({
          candidate: criteria[key],
          index: parseInt(key.slice(1), 10),
          probability: prob,
        }));

      const output = {
        intent,
        model: response.model,
        best: ranked[0] || null,
        ranked: topK > 1 ? ranked : undefined,
        confidence: answer.confidence,
        usage: response.usage,
        latency_ms,
      };

      return { content: [{ type: "text", text: JSON.stringify(output, null, 2) }] };
    } catch (err: any) {
      return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
    }
  }

  try {
    const method = name.replace(/^chrome_/, "");
    const result = await callExtension(method, args || {});
    
    if (name === "chrome_screenshot" || name === "chrome_screenshot_element" || name === "chrome_screenshot_fullpage") {
      const match = String(result).match(/^data:image\/(png|jpeg);base64,(.+)$/);
      if (match) {
        return { content: [{ type: "image", data: match[2], mimeType: `image/${match[1]}` }] };
      }
    }
    
    if (name === "chrome_pdf_print") {
      const match = String(result).match(/^data:application\/pdf;base64,(.+)$/);
      if (match) {
        return { content: [{ type: "resource", resource: { uri: "output.pdf", mimeType: "application/pdf", blob: match[1] } }] };
      }
    }
    
    return { content: [{ type: "text", text: String(result) }] };
  } catch (error: any) {
    return {
      content: [{ type: "text", text: `Error: ${error.message}` }],
      isError: true,
    };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("MCP server connected via Stdio");

process.on("exit", () => clearInterval(heartbeat));