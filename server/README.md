# @mytai20100/opencode-browser

> OpenCode Browser MCP — Chrome automation plugin for [OpenCode](https://opencode.ai) via WebSocket + Chrome Extension.

**50+ tools** covering tabs, CDP debugging, network intercept, visual click, session management, accessibility, and more.

---

## How it works

```
OpenCode ──MCP (stdio)──► MCP Server (Node.js) ──WebSocket:3002──► Chrome Extension
                                                                          │
                                                                    chrome.tabs
                                                                    chrome.debugger
                                                                    chrome.scripting
```

The MCP server communicates with a companion Chrome Extension via WebSocket. The extension executes commands in your real browser — using your existing logins, cookies, and profile.

---

## Installation

```bash
npm install -g @mytai20100/opencode-browser
```

Then add to your `opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "browser": {
      "type": "local",
      "command": ["opencode-browser"],
      "enabled": true
    }
  }
}
```

Load the companion Chrome Extension (see `/extension` folder), then start chatting with OpenCode.

---

## Tools (50+)

### Tabs & Windows
| Tool | Description |
|------|-------------|
| `chrome_list_tabs` | List all open tabs |
| `chrome_switch_tab` | Focus a tab by ID |
| `chrome_new_tab` | Open a new tab |
| `chrome_close_tab` | Close a tab |
| `chrome_navigate` | Navigate to URL |
| `chrome_reload_tab` | Reload a tab |
| `chrome_duplicate_tab` | Duplicate a tab |
| `chrome_pin_tab` | Pin/unpin a tab |
| `chrome_mute_tab` | Mute/unmute a tab |
| `chrome_group_tabs` | Group tabs with color/title |

### Page Interaction
| Tool | Description |
|------|-------------|
| `chrome_click` | Click by CSS selector |
| `chrome_type` | Type into an input |
| `chrome_hover` | Hover over an element |
| `chrome_select` | Select a dropdown option |
| `chrome_scroll` | Scroll the page |
| `chrome_key_press` | Press a key (Enter, Escape…) |
| `chrome_wait_for_element` | Wait for element to appear |
| `chrome_visual_click` | Click by X/Y coordinates via CDP |
| `chrome_upload_file` | Set files on file input |

### Page Content
| Tool | Description |
|------|-------------|
| `chrome_get_content` | Get visible text content |
| `chrome_get_html` | Get outer HTML |
| `chrome_get_page_info` | Title, URL, links, meta |
| `chrome_get_element_info` | Tag, class, attributes, bounding box |
| `chrome_find_elements` | Find all matching elements |
| `chrome_execute_script` | Run arbitrary JavaScript |
| `chrome_get_workflow_context` | Forms, inputs, buttons snapshot |
| `chrome_ocr_page` | All text with bounding boxes |
| `chrome_find_text_on_screen` | Find text → get click coordinates |

### CDP Debugging
| Tool | Description |
|------|-------------|
| `chrome_debug_attach` | Attach CDP debugger |
| `chrome_debug_get_logs` | Read console logs |
| `chrome_debug_get_network` | List captured network requests |
| `chrome_debug_get_response_body` | Read response body |
| `chrome_debug_eval` | Eval JS via CDP (async-safe) |
| `chrome_debug_get_performance` | JS heap, DOM nodes, layout |
| `chrome_debug_get_dom_snapshot` | Full DOM snapshot |
| `chrome_debug_emulate_device` | Mobile device emulation |
| `chrome_debug_emulate_network` | Network throttling |
| `chrome_debug_block_urls` | Block URL patterns |
| `chrome_debug_get_cookies` | Get ALL cookies incl. HttpOnly |
| `chrome_debug_send_command` | Send raw CDP command |

### Network Intercept
| Tool | Description |
|------|-------------|
| `chrome_intercept_request` | Intercept requests by URL pattern |
| `chrome_mock_response` | Mock API responses |
| `chrome_modify_headers` | Auto-modify request headers |
| `chrome_replay_request` | Re-send HTTP requests |
| `chrome_export_har` | Export HAR archive |

### Storage & Cookies
| Tool | Description |
|------|-------------|
| `chrome_get_cookies` | Get cookies for URL |
| `chrome_set_cookie` | Set a cookie |
| `chrome_delete_cookie` | Delete a cookie |
| `chrome_get_local_storage` | Read localStorage |
| `chrome_set_local_storage` | Write localStorage |
| `chrome_clear_local_storage` | Clear localStorage |

### Session
| Tool | Description |
|------|-------------|
| `chrome_save_session` | Save cookies + localStorage |
| `chrome_restore_session` | Restore saved session |

### Accessibility
| Tool | Description |
|------|-------------|
| `chrome_get_accessibility_tree` | Full AX tree |
| `chrome_find_accessible_nodes` | Find by label/role |

### Misc
| Tool | Description |
|------|-------------|
| `chrome_screenshot` | Take a screenshot |
| `chrome_write_clipboard` | Write to clipboard |
| `chrome_read_clipboard` | Read from clipboard |
| `chrome_notify` | Show desktop notification |
| `chrome_set_zoom` | Set zoom level |
| `chrome_grant_permissions` | Grant origin permissions |
| `chrome_virtual_authenticator` | WebAuthn testing |
| `chrome_get_tool_graph` | Get optimal tool execution plan |

---

## Requirements

- Node.js >= 18
- Chrome / Brave / Edge (Chromium-based)
- Companion Chrome Extension (included in `/extension`)

---

## License

MIT © 2026 mytai20100
