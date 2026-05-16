# Opencode Brower — Skill agent

## Non-Negotiable Rules (MUST follow)

1. **CALL `chrome_get_tool_graph` FIRST** before any complex task. It returns exactly which tools to use, in what order, and which to avoid — no extension call needed, costs <50 tokens.
2. **NEVER** call "defensive" tools (snapshot, screenshot, get_html) unless visual inspection is genuinely required.
3. **NEVER re-call** a tool whose result is already available in the current session (e.g. if `list_tabs` already ran, reuse the tabId — do not call again).
4. **Prefer low cost first**: `low → medium → high`.
5. **NEVER close a user's tab** unless explicitly requested.

---

## Standard Decision Flow

```
Receive task
    │
    ▼
chrome_get_tool_graph(intent="describe what you want to do")
    │
    ├─ execution_order: [tool_1, tool_2, ...]   ← follow this order
    ├─ avoid_these: [...]                        ← DO NOT call these
    └─ recommended[0].requires: [...]            ← satisfy prerequisites first
    │
    ▼
Call tools in order — STOP as soon as you have enough information
```

---

## Cheat Sheet: Intent → Optimal Tool

### Reading page content
```
CORRECT:  chrome_get_content            → full visible text (1 call)
CORRECT:  chrome_get_page_info          → title, url, links, meta (1 call)
WRONG:    chrome_get_html               → too heavy, only use when raw HTML is needed
WRONG:    chrome_screenshot + OCR       → wasteful, use get_content instead
```

### Interacting with a page (click / type)
```
CORRECT:  chrome_get_workflow_context   → get forms/buttons/inputs snapshot (1 call)
          → then chrome_click / chrome_type with the selector from output

WRONG:    chrome_find_elements → chrome_get_element_info → chrome_click  (3 calls → redundant)
WRONG:    chrome_screenshot to "see" the page before clicking
```

### Finding a hard-to-locate element
```
Try in order (stop when found):
1. chrome_get_workflow_context          (selectors are in the output)
2. chrome_find_accessible_nodes         (search by label/role)
3. chrome_find_text_on_screen           (search by visible text)
4. chrome_visual_click(x, y)            (coordinate click — last resort)
```

### Monitoring API / Network traffic
```
CORRECT:
1. chrome_debug_attach                  (enable CDP)
2. [perform actions on the page]
3. chrome_debug_get_network             (read captured requests)
4. chrome_debug_get_response_body(id)   (read body only if needed)

WRONG:  chrome_execute_script fetch(...) → cannot capture background requests
WRONG:  chrome_replay_request before obtaining URL from debug_get_network
```

### Reading Console Logs
```
CORRECT:
1. chrome_debug_attach
2. [trigger the action that causes the error]
3. chrome_debug_get_logs(level="error")

WRONG:  chrome_execute_script("console.log(...)") → cannot read past logs
```

### Managing multiple tabs
```
CORRECT:
1. chrome_list_tabs                     → get full list + tabIds
2. chrome_switch_tab(tabId)             → focus the tab
   OR
2. chrome_search_tabs(query)            → find tab by name (when many tabs open)

WRONG:  chrome_get_active_tab followed by chrome_list_tabs (duplicate info, 2 calls)
```

### Getting Cookies (including HttpOnly)
```
CORRECT (standard):   chrome_get_cookies(url)
CORRECT (HttpOnly):
1. chrome_debug_attach
2. chrome_debug_get_cookies             → returns all cookies incl. HttpOnly

WRONG:  chrome_execute_script("document.cookie") → HttpOnly cookies are invisible
```

### Session management (save / restore login)
```
CORRECT:
1. chrome_save_session(name="myapp")    → saves cookies + localStorage
   Later:
2. chrome_restore_session(name="myapp") → restores saved data
3. chrome_reload_tab                    → applies the session

WRONG:  setting cookies one by one with chrome_set_cookie (too many calls)
```

### Mobile / responsive testing
```
CORRECT:
1. chrome_debug_attach
2. chrome_debug_emulate_device(width=375, height=812)
3. chrome_screenshot                    → only when visual confirmation is needed

WRONG:  chrome_screenshot before emulation (meaningless)
```

---

## Cost & Priority Reference

| Cost | Tools | Notes |
|:---:|:---|:---|
| **LOW** | `get_active_tab`, `list_tabs`, `get_page_info`, `get_content`, `get_workflow_context`, `navigate`, `click`, `type`, `key_press`, `get_cookies`, `get_local_storage`, `get_history`, `debug_get_logs`, `debug_get_network`, `save_session`, `restore_session` | Call freely |
| **MEDIUM** | `debug_attach`, `debug_eval`, `find_accessible_nodes`, `ocr_page`, `find_text_on_screen`, `visual_click`, `intercept_request`, `modify_headers`, `debug_emulate_*`, `switch_iframe`, `upload_file`, `grant_permissions`, `virtual_authenticator`, `replay_request` | Use when LOW is insufficient |
| **HIGH** | `screenshot`, `debug_get_dom_snapshot`, `get_html` (full page) | Avoid — only use when visual output is truly required |

---

## Prerequisites Rules

Some tools **REQUIRE** another tool to be called first:

```
chrome_debug_attach            → required before ALL chrome_debug_* tools
chrome_list_tabs               → required before chrome_switch_tab (needs tabId)
chrome_intercept_request       → required before chrome_mock_response
chrome_debug_get_network       → required before chrome_debug_get_response_body
chrome_list_iframes            → required before chrome_switch_iframe
chrome_find_text_on_screen     → required before chrome_visual_click (needs coordinates)
chrome_get_workflow_context    → required before chrome_click/type (needs selector)
```

---

## Common Anti-patterns (AVOID)

| Anti-pattern | Correct approach |
|:---|:---|
| Calling `screenshot` to "see" the page before doing anything | Use `get_workflow_context` or `get_page_info` |
| Calling `get_html` to find a selector | Use `find_elements` or `get_workflow_context` |
| Calling `list_tabs` multiple times in one task | Cache tabId from the first call |
| Calling `execute_script` to fetch an API | Use `debug_attach` + `intercept_request` |
| Calling `find_elements` + `get_element_info` per element | Use `find_elements(limit=N)` once |
| Calling `debug_attach` multiple times for the same tab | Attach once, reuse for all debug tools |
| Closing a tab not mentioned in the request | NEVER close tabs not explicitly requested |
| Using `visual_click` before trying `click` with a selector | Selector-based `click` is always faster |
| Calling `get_accessibility_tree` (full tree) to find one element | Use `find_accessible_nodes(query, role)` |

---

## Optimized Workflow Examples

### Task: "Log into a website"
```
1. chrome_get_tool_graph(intent="login to website fill form")
2. chrome_navigate(url="https://...")
3. chrome_wait_for_element(selector="form")
4. chrome_get_workflow_context                    ← discover input selectors
5. chrome_type(selector="#email", text="...")
6. chrome_type(selector="#password", text="...")
7. chrome_click(selector="button[type=submit]")
8. chrome_wait_for_element(selector=".dashboard") ← verify success
```
**Total: 8 calls** (no screenshot, no get_html)

---

### Task: "Inspect API responses on a page"
```
1. chrome_get_tool_graph(intent="capture network api requests")
2. chrome_debug_attach
3. chrome_navigate(url="...")   ← or chrome_reload_tab
4. chrome_debug_get_network(filter="/api/")
5. chrome_debug_get_response_body(requestId="...")   ← only if body is needed
```
**Total: 4–5 calls**

---

### Task: "Click an element with no clear selector"
```
1. chrome_find_text_on_screen(query="Submit Order")
   → returns {x: 245, y: 380}
2. chrome_visual_click(x=245, y=380)
```
**Total: 2 calls** (no screenshot, no get_html)

---

## Special Notes

- **VS Code / critical user tabs:** NEVER close tabs whose URL contains `vscode`, `code-server`, or `localhost:8080` unless the user explicitly requests it.
- **When extension disconnects:** Report immediately and stop calling tools — each pending call will timeout after 30s.
- **When the task is ambiguous:** Call `chrome_get_workflow_context` first to understand the current page state before planning.
- **`debug_attach` can only be called once per tab.** Calling it again will throw — the extension silently ignores it via `.catch(() => {})`.
