#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { WebSocketServer, WebSocket } from "ws";

const wss = new WebSocketServer({
  port: 3002,
  host: "0.0.0.0",
  verifyClient: () => true,
});
console.error("WebSocket server started on port 3002");

// Keep connections alive with server-side ping every 25s
const SERVER_PING_INTERVAL = 25000;
wss.on("connection", (ws) => {
  console.error("Extension connected");
  (ws as any).isAlive = true;

  ws.on("pong", () => { (ws as any).isAlive = true; });
  ws.on("message", (data) => {
    try {
      const msg = JSON.parse(data.toString());
      // Ignore keep-alive pings from extension
      if (msg.type === "ping") return;
    } catch (e) {}
  });
  ws.on("close", () => { console.error("Extension disconnected"); });
});

// Server-side heartbeat: ping all clients, drop dead ones
const heartbeat = setInterval(() => {
  wss.clients.forEach((ws) => {
    if ((ws as any).isAlive === false) {
      console.error("Dropping dead connection");
      return ws.terminate();
    }
    (ws as any).isAlive = false;
    ws.ping();
  });
}, SERVER_PING_INTERVAL);

const server = new Server(
  {
    name: "opencode-brower",
    version: "opencode beta-2a",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

async function callExtension(method: string, params: any) {
  return new Promise((resolve, reject) => {
    const id = Math.random().toString(36).substring(7);
    const message = JSON.stringify({ id, method, params });

    let sent = false;
    wss.clients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) {
        sent = true;
        const listener = (data: any) => {
          try {
            const response = JSON.parse(data.toString());
            // Ignore keep-alive pings
            if (response.type === "ping") return;
            if (response.id === id) {
              client.removeListener("message", listener);
              if (response.error) reject(new Error(response.error));
              else resolve(response.result);
            }
          } catch (e) {}
        };
        client.on("message", listener);
        client.send(message);
      }
    });

    if (!sent) {
      reject(new Error("No extension connected"));
      return;
    }

    setTimeout(() => {
      reject(new Error("Timeout waiting for extension response"));
    }, 30000);
  });
}

const TOOLS = [
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
    description: "Get info about the Opencode Brower extension itself",
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
};

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return { tools: TOOLS };
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

  try {
    const method = name.replace(/^chrome_/, "");
    const result = await callExtension(method, args || {});
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
