# opencode-browser

[![npm version](https://img.shields.io/npm/v/@mytai20100/opencode-browser?label=mcp-server&color=blue)](https://www.npmjs.com/package/@mytai20100/opencode-browser)
[![extension version](https://img.shields.io/badge/extension-beta--1a-blue)](https://github.com/mytai20100/opencode-browser)
[![language](https://img.shields.io/badge/language-JavaScript-yellow)](https://github.com/mytai20100/opencode-browser)
[![license](https://img.shields.io/badge/license-MIT-green)](./server/LICENSE)
[![Package npm](https://github.com/Mytai20100/opencode-brower/actions/workflows/build.yml/badge.svg?event=status)](https://github.com/Mytai20100/opencode-brower/actions/workflows/build.yml)
[![Build](https://github.com/Mytai20100/opencode-brower/actions/workflows/build-e.yml/badge.svg)](https://github.com/Mytai20100/opencode-brower/actions/workflows/build-e.yml)

Chrome automation plugin for [OpenCode](https://opencode.ai) via WebSocket and Chrome Extension. Gives AI agents **105+ tools** covering tabs, CDP debugging, network interception, visual clicking, session management, accessibility, advanced mouse/keyboard control, testing & mocking, profiling, and more.

## How it works

The system has two parts that talk to each other over a local WebSocket connection:

- **MCP Server** — a Node.js process that OpenCode connects to via stdio. It exposes all tools to the AI agent and forwards commands over WebSocket to the extension.
- **Chrome Extension** — a Manifest V3 service worker that receives commands from the MCP server and executes them inside the browser using Chrome APIs and CDP.

```
OpenCode  <-- stdio -->  MCP Server  <-- WebSocket :3002 -->  Chrome Extension  <-- Chrome APIs -->  Browser
```

## Demo

**Extension popup** — configure the WebSocket endpoint and toggle the connection:

![Extension popup](./img/extension.png)

**Demo** — OpenCode controlling Chrome in real time:

![Demo](./img/demo.gif)

## Installation

### 1. Install the MCP server

```bash
npm install -g @mytai20100/opencode-browser
```

Or run directly with npx (no install needed):

```bash
npx @mytai20100/opencode-browser
```

### 2. Register with OpenCode

Add the server to your OpenCode config (`~/.config/opencode/config.json` or `opencode.json` at project root):

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "browsermcp": {
      "type": "local",
      "command": ["opencode-browser"],
      "enabled": true
    }
  }
}
```

### 3. Install the Chrome extension

1. Download or clone this repository.
2. Open Chrome and go to `chrome://extensions`.
3. Enable **Developer mode** (top-right toggle).
4. Click **Load unpacked** and select the `extension/` folder.

### 4. Connect

Click the extension icon in the Chrome toolbar. The default endpoint is `ws://localhost:3002`. If the MCP server is running on a different machine or port, enter the correct address (e.g. `ws://192.168.1.62:3002`) and click **Save Endpoint**. The status indicator turns orange when connected.

## Running locally from source

If you want to run the MCP server from a local clone instead of installing from npm:

```bash
git clone https://github.com/mytai20100/opencode-browser
cd opencode-browser/server
npm install
npm run build
```

Then point OpenCode at the local build by using the absolute path to `dist/index.js` in your config:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "browsermcp": {
      "type": "local",
      "command": ["node", "/absolute/path/to/opencode-browser/server/dist/index.js"],
      "enabled": true
    }
  }
}
```

Replace `/absolute/path/to/opencode-browser` with the actual path where you cloned the repo. On macOS and Linux you can get it by running `pwd` inside the `server/` folder. On Windows use the full path with backslashes, e.g. `C:\\Users\\you\\opencode-browser\\server\\dist\\index.js`.

After saving the config, restart OpenCode. The MCP server will start automatically whenever OpenCode launches.

For the extension, load the `extension/` folder from the cloned repo the same way as the regular install: `chrome://extensions` > Developer mode > Load unpacked > select `extension/`.

## Prompt tips

A few patterns that get the most out of the **105+ available tools**:

**Always start with the tool graph.** Before any multi-step task, ask the agent to call `chrome_get_tool_graph` with a plain description of the goal. This gives it an ordered execution plan and tells it which tools to skip, saving unnecessary calls.

```
Use chrome_get_tool_graph with intent "fill in the login form and submit"
```

**Use `chrome_get_workflow_context` before interacting with a page.** It gives the agent a snapshot of all forms, inputs, and buttons so it can build accurate CSS selectors before clicking or typing anything.

```
Before clicking anything, call chrome_get_workflow_context to map the page first.
```

**Attach the debugger early when working with APIs.** If the task involves reading network traffic, attach CDP at the start so requests are captured from the beginning.

```
Attach the debugger to the current tab, then navigate to the page and capture all API calls.
```

**Prefer `chrome_get_content` over `chrome_get_html` for reading pages.** It returns clean visible text without markup, which is faster and uses fewer tokens. Only reach for `chrome_get_html` when you need the raw DOM structure.

**Use `chrome_find_text_on_screen` + `chrome_visual_click` as a fallback.** When a button has no reliable CSS selector, find its text on screen first, then click the returned coordinates.

```
Find the text "Submit Order" on screen and click it visually.
```

**Save sessions to avoid re-logging in.** After a successful login, call `chrome_save_session` with a name. Restore it at the start of future tasks to skip the authentication flow entirely.

```
Save the current session as "prod-login" after logging in.
```

**Mock API responses for testing.** Use `chrome_intercept_request` and `chrome_mock_response` together to inject fake data without touching the backend.

```
Intercept all requests to /api/orders and return a mocked empty array.
```

## Tools reference

All tools are prefixed with `chrome_`. The agent can call `chrome_get_tool_graph` with a plain-text intent to get an optimized execution plan before starting any task — this prevents redundant calls and saves tokens.

### Tabs — viewing and querying

| Tool | Description |
|------|-------------|
| `chrome_list_tabs` | List all open tabs with id, title, url, active, pinned, muted, audible states |
| `chrome_get_active_tab` | Get info about the currently active tab |
| `chrome_get_tab_info` | Get detailed info about a specific tab by id |
| `chrome_search_tabs` | Search open tabs by title or URL keyword |

### Tabs — management

| Tool | Description |
|------|-------------|
| `chrome_navigate` | Navigate a tab to a URL (defaults to active tab) |
| `chrome_new_tab` | Open a new tab, optionally with a URL |
| `chrome_close_tab` | Close a tab by id (defaults to active tab) |
| `chrome_close_tabs` | Close multiple tabs by id array |
| `chrome_switch_tab` | Focus a specific tab by id |
| `chrome_duplicate_tab` | Duplicate a tab |
| `chrome_pin_tab` | Pin or unpin a tab |
| `chrome_mute_tab` | Mute or unmute a tab |
| `chrome_reload_tab` | Reload a tab, optionally bypassing cache |
| `chrome_move_tab` | Move a tab to a different position or window |

### Windows

| Tool | Description |
|------|-------------|
| `chrome_list_windows` | List all open windows with id, state, focused, tab count |
| `chrome_new_window` | Open a new browser window (supports incognito) |
| `chrome_close_window` | Close a browser window by id |

### Screenshot

| Tool | Description |
|------|-------------|
| `chrome_screenshot` | Capture the visible area as a base64 PNG or JPEG |
| `chrome_screenshot_element` | Capture a specific element by CSS selector |
| `chrome_screenshot_fullpage` | Capture full page with scrolling and stitching |
| `chrome_pdf_print` | Save current page as PDF with custom options |

### Page interaction

| Tool | Description |
|------|-------------|
| `chrome_click` | Click an element by CSS selector |
| `chrome_double_click` | Double click an element by selector or coordinates |
| `chrome_right_click` | Right click to open context menu |
| `chrome_middle_click` | Middle click (open in new tab) |
| `chrome_drag_drop` | Drag and drop from element A to B |
| `chrome_type` | Type text into an input element by CSS selector |
| `chrome_hover` | Hover over an element by CSS selector |
| `chrome_select` | Select an option in a `<select>` element |
| `chrome_scroll` | Scroll the page or a specific element by x/y pixels |
| `chrome_scroll_to` | Scroll an element into view |
| `chrome_key_press` | Dispatch a keyboard event (Enter, Escape, Tab, etc.) |
| `chrome_keyboard_shortcut` | Execute keyboard shortcuts (Ctrl+C, Ctrl+V, Ctrl+A, etc.) |
| `chrome_wait_for_element` | Wait until a CSS selector appears in the DOM |
| `chrome_wait_for_navigation` | Wait for page navigation to complete |
| `chrome_wait_for_network_idle` | Wait until no network requests for N milliseconds |
| `chrome_focus_element` | Focus an element without clicking |
| `chrome_clear_input` | Clear an input field |
| `chrome_select_text` | Select/highlight text on the page |
| `chrome_get_selected_text` | Get currently selected text |

### Page content

| Tool | Description |
|------|-------------|
| `chrome_get_content` | Get the full visible text of the page |
| `chrome_get_html` | Get outer HTML of an element or the full page |
| `chrome_get_element_info` | Get tag, class, text, attributes, bounding box, visibility |
| `chrome_find_elements` | Find all elements matching a CSS selector |
| `chrome_get_page_info` | Get title, URL, scroll position, viewport, links, meta |
| `chrome_execute_script` | Execute arbitrary JavaScript with full DOM access |

### Navigation history

| Tool | Description |
|------|-------------|
| `chrome_go_back` | Navigate back in the tab's history |
| `chrome_go_forward` | Navigate forward in the tab's history |
| `chrome_go_home` | Navigate the active tab to the new tab page |

### Cookies

| Tool | Description |
|------|-------------|
| `chrome_get_cookies` | Get all cookies for a given URL |
| `chrome_set_cookie` | Set a cookie for a URL |
| `chrome_delete_cookie` | Delete a specific cookie |

### Local storage

| Tool | Description |
|------|-------------|
| `chrome_get_local_storage` | Get localStorage value(s) from the current page |
| `chrome_set_local_storage` | Set a localStorage value on the current page |
| `chrome_clear_local_storage` | Clear all localStorage on the current page |
| `chrome_get_session_storage` | Get sessionStorage value(s) from the current page |

### History and bookmarks

| Tool | Description |
|------|-------------|
| `chrome_get_history` | Search browser history by text query |
| `chrome_add_bookmark` | Add a bookmark |
| `chrome_search_bookmarks` | Search bookmarks by title or URL |
| `chrome_get_bookmarks` | Get all bookmarks in a flat list |

### Downloads

| Tool | Description |
|------|-------------|
| `chrome_download` | Download a file from a URL |
| `chrome_list_downloads` | List recent downloads, optionally filtered by state |

### Tab groups

| Tool | Description |
|------|-------------|
| `chrome_group_tabs` | Group tabs with an optional title and color |
| `chrome_ungroup_tabs` | Remove tabs from a group |

### CDP debugging

These tools require calling `chrome_debug_attach` first.

| Tool | Description |
|------|-------------|
| `chrome_debug_attach` | Attach the CDP debugger to a tab |
| `chrome_debug_detach` | Detach the debugger from a tab |
| `chrome_debug_get_logs` | Get captured console logs (log, warn, error, info) |
| `chrome_debug_clear_logs` | Clear captured console logs |
| `chrome_debug_get_network` | Get captured network requests (XHR, Fetch, etc.) |
| `chrome_debug_clear_network` | Clear the captured network log |
| `chrome_debug_get_response_body` | Get the response body of a captured request by requestId |
| `chrome_debug_eval` | Evaluate JavaScript via CDP (async-safe, bypasses sandbox) |
| `chrome_debug_get_performance` | Get JS heap, DOM node count, layout metrics |
| `chrome_debug_get_dom_snapshot` | Full DOM snapshot with layout and bounding rects |
| `chrome_debug_set_breakpoint` | Set a JS breakpoint by URL and line number |
| `chrome_debug_remove_breakpoint` | Remove a JS breakpoint by id |
| `chrome_debug_get_cookies` | Get all cookies including HttpOnly ones via CDP |
| `chrome_debug_set_xhr_breakpoint` | Break on XHR/Fetch matching a URL pattern |
| `chrome_debug_emulate_device` | Emulate a mobile device (screen, user agent, DPR) |
| `chrome_debug_emulate_network` | Throttle network (offline, slow3g, fast3g) |
| `chrome_debug_block_urls` | Block URL patterns from loading |
| `chrome_debug_get_storage` | Get localStorage/sessionStorage for a specific origin |
| `chrome_debug_send_command` | Send a raw CDP command for advanced debugging |

### Network interception and mocking

| Tool | Description |
|------|-------------|
| `chrome_intercept_request` | Intercept requests matching a URL pattern via CDP Fetch |
| `chrome_mock_response` | Mock a URL response with custom status, headers, and body |
| `chrome_modify_headers` | Automatically add or override request headers |
| `chrome_export_har` | Export all captured requests as a HAR archive |
| `chrome_replay_request` | Re-send an HTTP request with custom method, headers, body |

### Accessibility

| Tool | Description |
|------|-------------|
| `chrome_get_accessibility_tree` | Get the full AX tree via CDP |
| `chrome_find_accessible_nodes` | Find AX nodes by label and/or ARIA role |

### Visual interaction

| Tool | Description |
|------|-------------|
| `chrome_visual_click` | Click at specific X/Y coordinates via CDP Input |
| `chrome_ocr_page` | Extract all visible text with bounding box coordinates |
| `chrome_find_text_on_screen` | Find text on screen and return its coordinates |

### Session management

| Tool | Description |
|------|-------------|
| `chrome_save_session` | Save current cookies and localStorage under a name |
| `chrome_restore_session` | Restore a previously saved session |

### Events and DOM watching

| Tool | Description |
|------|-------------|
| `chrome_subscribe_events` | Subscribe to DOM events (click, input, submit, etc.) |
| `chrome_watch_dom_changes` | Watch DOM mutations via MutationObserver |

### Iframes

| Tool | Description |
|------|-------------|
| `chrome_list_iframes` | List all iframes on the page |
| `chrome_switch_iframe` | Execute JavaScript inside a specific iframe by index |

### Miscellaneous

| Tool | Description |
|------|-------------|
| `chrome_notify` | Show a desktop notification |
| `chrome_set_zoom` | Set the zoom level of a tab |
| `chrome_get_zoom` | Get the current zoom level of a tab |
| `chrome_write_clipboard` | Write text to the clipboard |
| `chrome_read_clipboard` | Read text from the clipboard |
| `chrome_upload_file` | Set files on a file input element via CDP |
| `chrome_grant_permissions` | Grant browser permissions to an origin |
| `chrome_virtual_authenticator` | Add/remove a virtual WebAuthn authenticator |
| `chrome_get_extension_info` | Get info about the extension itself |
| `chrome_get_workflow_context` | Snapshot of forms, buttons, inputs, and event log |
| `chrome_get_tool_graph` | Get optimal tool execution plan for a given intent |

### CSS & Styling

| Tool | Description |
|------|-------------|
| `chrome_inject_css` | Inject CSS stylesheet into the page |
| `chrome_remove_css` | Remove previously injected CSS by ID |
| `chrome_set_color_scheme` | Force dark or light mode |

### Testing & Mocking

| Tool | Description |
|------|-------------|
| `chrome_mock_geolocation` | Mock GPS location for testing |
| `chrome_mock_timezone` | Override timezone of the page |
| `chrome_mock_locale` | Override locale/language |
| `chrome_mock_battery` | Mock battery status API |
| `chrome_mock_media_type` | Override CSS media type (print/screen) |
| `chrome_emulate_vision` | Emulate vision deficiencies (color blindness, blurred vision) |
| `chrome_cpu_throttle` | Throttle CPU to simulate slower devices |
| `chrome_mock_date_time` | Override Date.now() for deterministic testing |
| `chrome_modify_response_body` | Modify response body before page receives it |
| `chrome_get_ws_frames` | Capture WebSocket frames |
| `chrome_set_extra_headers` | Add extra HTTP headers to all requests |
| `chrome_get_request_body` | Get POST body of a sent request |

### Advanced Debugging & Profiling

| Tool | Description |
|------|-------------|
| `chrome_profiling_start` | Start CPU profiling |
| `chrome_profiling_stop` | Stop CPU profiling and get profile data |
| `chrome_heap_snapshot` | Take a heap snapshot for memory analysis |
| `chrome_trace_start` | Start tracing (Timeline/Performance recording) |
| `chrome_trace_stop` | Stop tracing and get trace events |
| `chrome_pause_on_exception` | Pause debugger on exceptions (all/uncaught/none) |
| `chrome_debugger_resume` | Resume execution after debugger pause |
| `chrome_debugger_step_over` | Step over current line |
| `chrome_debugger_step_into` | Step into function call |
| `chrome_debugger_step_out` | Step out of current function |
| `chrome_get_call_frames` | Get call stack when paused |
| `chrome_evaluate_on_call_frame` | Evaluate expression in paused call frame |
| `chrome_get_script_source` | Get source code of a script |
| `chrome_live_edit_script` | Live edit JavaScript without reload |
| `chrome_call_function_on` | Call function on remote object |
| `chrome_get_properties` | Get properties of a remote object |
| `chrome_compile_script` | Check JavaScript syntax without executing |

### Storage & Security

| Tool | Description |
|------|-------------|
| `chrome_get_indexeddb` | Read IndexedDB data from the page |
| `chrome_get_cache_storage` | Read Service Worker cache storage |
| `chrome_get_security_state` | Get HTTPS security state and certificate info |
| `chrome_ignore_cert_errors` | Ignore SSL certificate errors |

### DOM Manipulation

| Tool | Description |
|------|-------------|
| `chrome_highlight_element` | Highlight element on screen for debugging |
| `chrome_hide_element` | Hide or show element |
| `chrome_dom_set_attribute` | Set DOM attribute via CDP |
| `chrome_dom_remove_node` | Remove DOM node |

## Tool graph

Before starting any multi-step task, call `chrome_get_tool_graph` with a plain-text description of what you want to accomplish. It returns a ranked list of recommended tools, their cost (`low` / `medium` / `high`), prerequisites, suggested next steps, and tools to avoid. This is especially useful for agents that might otherwise make redundant or expensive calls.

```
intent: "capture network requests from the login page"
-> recommended: chrome_debug_attach -> chrome_navigate -> chrome_debug_get_network
-> avoid: chrome_screenshot, chrome_get_html
```

## Requirements

- Node.js 22 or later
- Google Chrome (or a Chromium-based browser that supports Manifest V3)
- OpenCode 1.0 or later

## Troubleshooting

### Connection lost

If you see connection errors:

1. **Check extension status** — verify the opencode-browser extension is enabled in Chrome.
2. **Re-enable extension** — if you disabled it, re-enable it and retry the browser action immediately.
3. **Check browser is running** — ensure Chrome or Edge is actually open.
4. **Retry after readiness** — the MCP server does not add extra backoff delay, so the next attempt can run right away.
5. **Restart only if needed** — restart OpenCode only if the browser stays unavailable after retrying.

The extension will display messages like `[Opencode-browser] Connecting...` in the popup while it attempts to reconnect.

### Extension not loading

1. **Check file location** — ensure the `extension/` folder is in the correct directory.
2. **Check Developer mode** — it must be enabled at `chrome://extensions`.
3. **Check syntax** — ensure the JavaScript files have no syntax errors.
4. **Check logs** — open the service worker DevTools from `chrome://extensions` and look for initialization errors.

### Tools not available in OpenCode

1. **Check MCP server status** — ensure the MCP server started without errors (`npx @mytai20100/opencode-browser`).
2. **Check config** — verify your `opencode.json` has the correct MCP configuration.
3. **Restart OpenCode** — try restarting after any configuration change.
4. **Check Node.js** — run `node --version` to confirm Node.js 22 or later is installed.

## Development

### Building from source

```bash
git clone https://github.com/mytai20100/opencode-browser
cd opencode-browser/server
npm install
npm run build
```

To run locally during development:

```bash
npm run dev
```

To test changes to the extension, reload it at `chrome://extensions` after editing `extension/background.js` or `extension/popup.js`.

## Contributing

Contributions are welcome.

1. Fork the repository.
2. Create a feature branch.
3. Make your changes.
4. Submit a pull request.

## Resources

- [OpenCode Documentation](https://opencode.ai/docs/)
- [OpenCode MCP Servers](https://opencode.ai/docs/mcp-servers/)
- [Chrome DevTools Protocol](https://chromedevtools.github.io/devtools-protocol/)
- [npm package](https://www.npmjs.com/package/@mytai20100/opencode-browser)

## Support

- Plugin issues: [opencode-browser GitHub](https://github.com/mytai20100/opencode-browser)
- OpenCode issues: [OpenCode GitHub](https://github.com/anomalyco/opencode)

## Changelog

See [CHANGELOG-MCP.md](CHANGELOG-MCP.md) for a detailed list of changes.

### v0.0.2

  - Advanced mouse: double_click, right_click, middle_click, drag_drop
  - Keyboard shortcuts: keyboard_shortcut (Ctrl+C, Ctrl+V, Ctrl+A, etc.)
  - Wait tools: wait_for_navigation, wait_for_network_idle
  - Screenshots: screenshot_element, screenshot_fullpage, pdf_print
  - CSS injection: inject_css, remove_css
  - Text selection: select_text, get_selected_text, focus_element, clear_input
  - Emulation: mock_geolocation, mock_timezone, mock_locale, mock_battery, mock_media_type, emulate_vision, cpu_throttle
  - Network & time: mock_date_time, modify_response_body, get_ws_frames, set_extra_headers, get_request_body
  - Profiling: profiling_start, profiling_stop, heap_snapshot, trace_start, trace_stop
  - Debugger control: pause_on_exception, debugger_resume, debugger_step_over, debugger_step_into, debugger_step_out, get_call_frames
  - Runtime inspection: evaluate_on_call_frame, get_script_source, live_edit_script, call_function_on, get_properties, compile_script
  - Storage: get_indexeddb, get_session_storage, get_cache_storage
  - Security: get_security_state, ignore_cert_errors
  - DOM manipulation: set_color_scheme, highlight_element, hide_element, dom_set_attribute, dom_remove_node

### v0.0.1 — initial release

- 94 Chrome automation tools via WebSocket and Chrome Extension
- Full CDP support: debug, network intercept, eval, DOM snapshots
- Tab management: list, switch, new, close, group, pin, mute
- Page interaction: click, type, hover, scroll, key press, visual click by X/Y
- Network tools: intercept, mock response, modify headers, replay request, export HAR
- Session management: save and restore cookies and localStorage
- Accessibility: full AX tree, find by label and role
- OCR: extract text with bounding box coordinates
- WebAuthn virtual authenticator for passkey and FIDO2 testing
- Tool graph: smart execution planner for AI agents

## License

[MIT License](./LICENSE)
