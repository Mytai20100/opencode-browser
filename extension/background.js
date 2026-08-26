let socket = null;
let currentEndpoint = 'ws://localhost:3002';
let isConnected = false;
let isEnabled = true;
let reconnectTimer = null;
let pingTimer = null;

chrome.alarms.create('keepAlive', { periodInMinutes: 0.3 }); // every 18s
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'keepAlive') {
    // Just waking up the SW is enough; also re-check connection
    if (isEnabled && !isConnected) {
      clearTimeout(reconnectTimer);
      connect();
    }
  }
});

chrome.storage.local.get(['endpoint', 'enabled'], (result) => {
  if (result.endpoint) {
    currentEndpoint = result.endpoint;
  }
  isEnabled = result.enabled !== false; // default ON
  if (isEnabled) {
    connect();
  }
});

function connect() {
  if (socket && (socket.readyState === WebSocket.CONNECTING || socket.readyState === WebSocket.OPEN)) {
    return; // already connecting/connected, skip
  }
  if (socket) {
    socket.onclose = null;
    socket.onerror = null;
    try { socket.close(); } catch(e) {}
  }
  clearTimeout(reconnectTimer);
  clearInterval(pingTimer);

  console.log('Connecting to:', currentEndpoint);
  socket = new WebSocket(currentEndpoint);

  socket.onmessage = async (event) => {
    const { id, method, params } = JSON.parse(event.data);
    console.log('Received command:', method, params);

    try {
      let result;

      switch (method) {

        // TAB QUERIES

        case 'list_tabs': {
          const tabs = await chrome.tabs.query({});
          result = JSON.stringify(tabs.map(t => ({
            id: t.id,
            windowId: t.windowId,
            index: t.index,
            title: t.title,
            url: t.url,
            active: t.active,
            pinned: t.pinned,
            audible: t.audible,
            muted: t.mutedInfo?.muted,
            status: t.status,
            favIconUrl: t.favIconUrl
          })));
          break;
        }

        case 'get_active_tab': {
          const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
          if (!tab) throw new Error('No active tab');
          result = JSON.stringify({
            id: tab.id, windowId: tab.windowId, title: tab.title,
            url: tab.url, status: tab.status, index: tab.index
          });
          break;
        }

        case 'get_tab_info': {
          const tab = await chrome.tabs.get(params.tabId);
          result = JSON.stringify({
            id: tab.id, windowId: tab.windowId, title: tab.title,
            url: tab.url, status: tab.status, index: tab.index,
            pinned: tab.pinned, audible: tab.audible
          });
          break;
        }

        // TAB MANAGEMENT

        case 'navigate': {
          const targetTabId = params.tabId || (await chrome.tabs.query({ active: true, currentWindow: true }))[0]?.id;
          if (targetTabId) {
            await chrome.tabs.update(targetTabId, { url: params.url });
          } else {
            await chrome.tabs.update({ url: params.url });
          }
          result = `Navigated to ${params.url}`;
          break;
        }

        case 'new_tab': {
          const tab = await chrome.tabs.create({
            url: params.url || 'about:newtab',
            active: params.active !== false
          });
          result = JSON.stringify({ id: tab.id, url: tab.url });
          break;
        }

        case 'close_tab': {
          const tabId = params.tabId || (await chrome.tabs.query({ active: true, currentWindow: true }))[0]?.id;
          await chrome.tabs.remove(tabId);
          result = `Closed tab ${tabId}`;
          break;
        }

        case 'close_tabs': {
          await chrome.tabs.remove(params.tabIds);
          result = `Closed ${params.tabIds.length} tabs`;
          break;
        }

        case 'switch_tab': {
          await chrome.tabs.update(params.tabId, { active: true });
          await chrome.windows.update(
            (await chrome.tabs.get(params.tabId)).windowId,
            { focused: true }
          );
          result = `Switched to tab ${params.tabId}`;
          break;
        }

        case 'duplicate_tab': {
          const tabId = params.tabId || (await chrome.tabs.query({ active: true, currentWindow: true }))[0]?.id;
          const newTab = await chrome.tabs.duplicate(tabId);
          result = JSON.stringify({ id: newTab.id, url: newTab.url });
          break;
        }

        case 'pin_tab': {
          const tabId = params.tabId || (await chrome.tabs.query({ active: true, currentWindow: true }))[0]?.id;
          const tab = await chrome.tabs.update(tabId, { pinned: params.pinned !== false });
          result = `Tab ${tabId} pinned: ${tab.pinned}`;
          break;
        }

        case 'mute_tab': {
          const tabId = params.tabId || (await chrome.tabs.query({ active: true, currentWindow: true }))[0]?.id;
          await chrome.tabs.update(tabId, { muted: params.muted !== false });
          result = `Tab ${tabId} muted: ${params.muted !== false}`;
          break;
        }

        case 'reload_tab': {
          const tabId = params.tabId || (await chrome.tabs.query({ active: true, currentWindow: true }))[0]?.id;
          await chrome.tabs.reload(tabId, { bypassCache: params.bypassCache || false });
          result = `Reloaded tab ${tabId}`;
          break;
        }

        case 'move_tab': {
          await chrome.tabs.move(params.tabId, { windowId: params.windowId || -1, index: params.index });
          result = `Moved tab ${params.tabId} to index ${params.index}`;
          break;
        }

        case 'search_tabs': {
          const all = await chrome.tabs.query({});
          const q = (params.query || '').toLowerCase();
          const found = all.filter(t =>
            (t.title || '').toLowerCase().includes(q) ||
            (t.url || '').toLowerCase().includes(q)
          );
          result = JSON.stringify(found.map(t => ({ id: t.id, title: t.title, url: t.url, active: t.active })));
          break;
        }

        // WINDOWS 

        case 'list_windows': {
          const windows = await chrome.windows.getAll({ populate: true });
          result = JSON.stringify(windows.map(w => ({
            id: w.id, type: w.type, state: w.state, focused: w.focused,
            tabCount: w.tabs?.length
          })));
          break;
        }

        case 'new_window': {
          const win = await chrome.windows.create({
            url: params.url,
            incognito: params.incognito || false,
            state: params.state || 'normal'
          });
          result = JSON.stringify({ id: win.id, tabs: win.tabs?.length });
          break;
        }

        case 'close_window': {
          await chrome.windows.remove(params.windowId);
          result = `Closed window ${params.windowId}`;
          break;
        }

        // SCREENSHOTS 

        case 'screenshot': {
          const winId = params.windowId || chrome.windows.WINDOW_ID_CURRENT;
          const dataUrl = await chrome.tabs.captureVisibleTab(winId, {
            format: params.format || 'png',
            quality: params.quality || 90
          });
          result = dataUrl;
          break;
        }

        // PAGE INTERACTION

        case 'click': {
          const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
          if (!tab) throw new Error('No active tab');
          const tabId = params.tabId || tab.id;
          await chrome.scripting.executeScript({
            target: { tabId },
            func: (selector) => {
              const el = document.querySelector(selector);
              if (!el) throw new Error(`Element not found: ${selector}`);
              el.scrollIntoView({ behavior: 'smooth', block: 'center' });
              el.click();
              return `Clicked: ${selector}`;
            },
            args: [params.selector]
          });
          result = 'Click executed';
          break;
        }

        case 'type': {
          const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
          const tabId = params.tabId || tab.id;
          await chrome.scripting.executeScript({
            target: { tabId },
            func: (selector, text, simulate) => {
              const el = document.querySelector(selector);
              if (!el) throw new Error(`Element not found: ${selector}`);
              el.focus();
              if (simulate) {
                // Simulate key-by-key typing
                el.value = '';
                for (const char of text) {
                  el.value += char;
                  el.dispatchEvent(new KeyboardEvent('keydown', { key: char, bubbles: true }));
                  el.dispatchEvent(new KeyboardEvent('keypress', { key: char, bubbles: true }));
                  el.dispatchEvent(new InputEvent('input', { data: char, bubbles: true }));
                  el.dispatchEvent(new KeyboardEvent('keyup', { key: char, bubbles: true }));
                }
              } else {
                el.value = text;
                el.dispatchEvent(new Event('input', { bubbles: true }));
                el.dispatchEvent(new Event('change', { bubbles: true }));
              }
              return 'Typed';
            },
            args: [params.selector, params.text, params.simulate || false]
          });
          result = 'Type executed';
          break;
        }

        case 'hover': {
          const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
          const tabId = params.tabId || tab.id;
          await chrome.scripting.executeScript({
            target: { tabId },
            func: (selector) => {
              const el = document.querySelector(selector);
              if (!el) throw new Error(`Element not found: ${selector}`);
              el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
              el.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
              return 'Hovered';
            },
            args: [params.selector]
          });
          result = 'Hover executed';
          break;
        }

        case 'select': {
          const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
          const tabId = params.tabId || tab.id;
          await chrome.scripting.executeScript({
            target: { tabId },
            func: (selector, value) => {
              const el = document.querySelector(selector);
              if (!el) throw new Error(`Element not found: ${selector}`);
              el.value = value;
              el.dispatchEvent(new Event('change', { bubbles: true }));
              return 'Selected';
            },
            args: [params.selector, params.value]
          });
          result = 'Select executed';
          break;
        }

        case 'scroll': {
          const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
          const tabId = params.tabId || tab.id;
          await chrome.scripting.executeScript({
            target: { tabId },
            func: (x, y, selector) => {
              if (selector) {
                const el = document.querySelector(selector);
                if (el) { el.scrollBy(x || 0, y || 0); return 'Scrolled element'; }
              }
              window.scrollBy(x || 0, y || 0);
              return `Scrolled by (${x}, ${y})`;
            },
            args: [params.x || 0, params.y || 300, params.selector || null]
          });
          result = 'Scroll executed';
          break;
        }

        case 'scroll_to': {
          const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
          const tabId = params.tabId || tab.id;
          await chrome.scripting.executeScript({
            target: { tabId },
            func: (selector) => {
              const el = document.querySelector(selector);
              if (!el) throw new Error(`Element not found: ${selector}`);
              el.scrollIntoView({ behavior: 'smooth', block: 'center' });
              return 'Scrolled to element';
            },
            args: [params.selector]
          });
          result = 'Scroll to executed';
          break;
        }

        case 'key_press': {
          const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
          const tabId = params.tabId || tab.id;
          await chrome.scripting.executeScript({
            target: { tabId },
            func: (key, selector) => {
              const target = selector ? document.querySelector(selector) : document.activeElement || document.body;
              const evProps = { key, bubbles: true, cancelable: true };
              target.dispatchEvent(new KeyboardEvent('keydown', evProps));
              target.dispatchEvent(new KeyboardEvent('keypress', evProps));
              target.dispatchEvent(new KeyboardEvent('keyup', evProps));
              return `Key pressed: ${key}`;
            },
            args: [params.key, params.selector || null]
          });
          result = `Key press executed: ${params.key}`;
          break;
        }

        case 'wait_for_element': {
          const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
          const tabId = params.tabId || tab.id;
          const [{ result: found }] = await chrome.scripting.executeScript({
            target: { tabId },
            func: (selector, timeout) => {
              return new Promise((resolve) => {
                const startTime = Date.now();
                const check = () => {
                  const el = document.querySelector(selector);
                  if (el) { resolve(true); return; }
                  if (Date.now() - startTime > timeout) { resolve(false); return; }
                  setTimeout(check, 100);
                };
                check();
              });
            },
            args: [params.selector, params.timeout || 5000]
          });
          result = found ? `Element found: ${params.selector}` : `Element not found after timeout: ${params.selector}`;
          break;
        }

        // PAGE CONTENT

        case 'get_content': {
          const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
          const tabId = params.tabId || tab.id;
          const [{ result: content }] = await chrome.scripting.executeScript({
            target: { tabId },
            func: () => document.body.innerText
          });
          result = content;
          break;
        }

        case 'get_html': {
          const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
          const tabId = params.tabId || tab.id;
          const [{ result: html }] = await chrome.scripting.executeScript({
            target: { tabId },
            func: (selector) => {
              const el = selector ? document.querySelector(selector) : document.documentElement;
              return el ? el.outerHTML : null;
            },
            args: [params.selector || null]
          });
          result = html;
          break;
        }

        case 'get_element_info': {
          const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
          const tabId = params.tabId || tab.id;
          const [{ result: info }] = await chrome.scripting.executeScript({
            target: { tabId },
            func: (selector) => {
              const el = document.querySelector(selector);
              if (!el) return null;
              const rect = el.getBoundingClientRect();
              const styles = getComputedStyle(el);
              return {
                tagName: el.tagName, id: el.id, className: el.className,
                text: el.innerText?.substring(0, 500),
                value: el.value, href: el.href, src: el.src,
                visible: styles.display !== 'none' && styles.visibility !== 'hidden',
                rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
                attributes: Object.fromEntries([...el.attributes].map(a => [a.name, a.value]))
              };
            },
            args: [params.selector]
          });
          result = JSON.stringify(info);
          break;
        }

        case 'find_elements': {
          const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
          const tabId = params.tabId || tab.id;
          const [{ result: elements }] = await chrome.scripting.executeScript({
            target: { tabId },
            func: (selector, limit) => {
              const els = [...document.querySelectorAll(selector)].slice(0, limit || 50);
              return els.map((el, i) => ({
                index: i,
                tagName: el.tagName,
                id: el.id,
                className: el.className,
                text: el.innerText?.substring(0, 200),
                value: el.value,
                href: el.href,
                visible: getComputedStyle(el).display !== 'none'
              }));
            },
            args: [params.selector, params.limit || 50]
          });
          result = JSON.stringify(elements);
          break;
        }

        case 'get_page_info': {
          const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
          const tabId = params.tabId || tab.id;
          const [{ result: info }] = await chrome.scripting.executeScript({
            target: { tabId },
            func: () => ({
              title: document.title,
              url: location.href,
              readyState: document.readyState,
              scrollY: window.scrollY,
              scrollHeight: document.documentElement.scrollHeight,
              viewportHeight: window.innerHeight,
              viewportWidth: window.innerWidth,
              links: [...document.querySelectorAll('a[href]')]
                .slice(0, 100)
                .map(a => ({ text: a.innerText?.trim(), href: a.href })),
              metaDescription: document.querySelector('meta[name="description"]')?.content,
              metaTitle: document.querySelector('meta[property="og:title"]')?.content,
            })
          });
          result = JSON.stringify(info);
          break;
        }

        case 'execute_script': {
          const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
          const tabId = params.tabId || tab.id;
          const [{ result: scriptResult }] = await chrome.scripting.executeScript({
            target: { tabId, allFrames: params.allFrames || false },
            func: (code) => eval(code),
            args: [params.code]
          });
          result = JSON.stringify(scriptResult);
          break;
        }

        // STORAGE

        case 'get_cookies': {
          const cookies = await chrome.cookies.getAll({ url: params.url });
          result = JSON.stringify(cookies.map(c => ({
            name: c.name, value: c.value, domain: c.domain,
            path: c.path, secure: c.secure, httpOnly: c.httpOnly, expirationDate: c.expirationDate
          })));
          break;
        }

        case 'set_cookie': {
          await chrome.cookies.set({
            url: params.url, name: params.name, value: params.value,
            domain: params.domain, path: params.path || '/',
            secure: params.secure || false, httpOnly: params.httpOnly || false
          });
          result = `Cookie set: ${params.name}`;
          break;
        }

        case 'delete_cookie': {
          await chrome.cookies.remove({ url: params.url, name: params.name });
          result = `Cookie deleted: ${params.name}`;
          break;
        }

        case 'get_local_storage': {
          const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
          const tabId = params.tabId || tab.id;
          const [{ result: storage }] = await chrome.scripting.executeScript({
            target: { tabId },
            func: (key) => {
              if (key) return { [key]: localStorage.getItem(key) };
              const all = {};
              for (let i = 0; i < localStorage.length; i++) {
                const k = localStorage.key(i);
                all[k] = localStorage.getItem(k);
              }
              return all;
            },
            args: [params.key || null]
          });
          result = JSON.stringify(storage);
          break;
        }

        case 'set_local_storage': {
          const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
          const tabId = params.tabId || tab.id;
          await chrome.scripting.executeScript({
            target: { tabId },
            func: (key, value) => { localStorage.setItem(key, value); return 'Set'; },
            args: [params.key, params.value]
          });
          result = `localStorage set: ${params.key}`;
          break;
        }

        case 'clear_local_storage': {
          const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
          const tabId = params.tabId || tab.id;
          await chrome.scripting.executeScript({
            target: { tabId },
            func: () => { localStorage.clear(); return 'Cleared'; }
          });
          result = 'localStorage cleared';
          break;
        }

        // HISTORY & BOOKMARKS

        case 'get_history': {
          const items = await chrome.history.search({
            text: params.query || '',
            maxResults: params.maxResults || 50,
            startTime: params.startTime || (Date.now() - 7 * 24 * 60 * 60 * 1000)
          });
          result = JSON.stringify(items.map(h => ({
            id: h.id, url: h.url, title: h.title,
            visitCount: h.visitCount, lastVisitTime: h.lastVisitTime
          })));
          break;
        }

        case 'add_bookmark': {
          const node = await chrome.bookmarks.create({
            title: params.title, url: params.url, parentId: params.parentId
          });
          result = JSON.stringify({ id: node.id, title: node.title, url: node.url });
          break;
        }

        case 'search_bookmarks': {
          const nodes = await chrome.bookmarks.search(params.query || '');
          result = JSON.stringify(nodes.slice(0, params.limit || 50).map(n => ({
            id: n.id, title: n.title, url: n.url, dateAdded: n.dateAdded
          })));
          break;
        }

        case 'get_bookmarks': {
          const tree = await chrome.bookmarks.getTree();
          const flatten = (nodes) => nodes.flatMap(n => [
            { id: n.id, title: n.title, url: n.url, parentId: n.parentId },
            ...(n.children ? flatten(n.children) : [])
          ]);
          result = JSON.stringify(flatten(tree));
          break;
        }

        // DOWNLOADS

        case 'download': {
          const dlId = await chrome.downloads.download({
            url: params.url, filename: params.filename,
            saveAs: params.saveAs || false
          });
          result = JSON.stringify({ downloadId: dlId });
          break;
        }

        case 'list_downloads': {
          const items = await chrome.downloads.search({
            limit: params.limit || 20,
            state: params.state
          });
          result = JSON.stringify(items.map(d => ({
            id: d.id, filename: d.filename, url: d.url, state: d.state,
            totalBytes: d.totalBytes, receivedBytes: d.receivedBytes,
            startTime: d.startTime
          })));
          break;
        }

        // BROWSER NAVIGATION

        case 'go_back': {
          const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
          const tabId = params.tabId || tab.id;
          await chrome.scripting.executeScript({
            target: { tabId },
            func: () => { history.back(); return 'Back'; }
          });
          result = 'Navigated back';
          break;
        }

        case 'go_forward': {
          const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
          const tabId = params.tabId || tab.id;
          await chrome.scripting.executeScript({
            target: { tabId },
            func: () => { history.forward(); return 'Forward'; }
          });
          result = 'Navigated forward';
          break;
        }

        case 'go_home': {
          const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
          await chrome.tabs.update(tab.id, { url: 'chrome://newtab' });
          result = 'Navigated to new tab';
          break;
        }

        // TAB GROUPS

        case 'group_tabs': {
          const groupId = await chrome.tabs.group({ tabIds: params.tabIds });
          if (params.title || params.color) {
            await chrome.tabGroups.update(groupId, {
              title: params.title, color: params.color
            });
          }
          result = JSON.stringify({ groupId });
          break;
        }

        case 'ungroup_tabs': {
          await chrome.tabs.ungroup(params.tabIds);
          result = 'Tabs ungrouped';
          break;
        }

        // NOTIFICATIONS

        case 'notify': {
          chrome.notifications.create({
            type: 'basic',
            iconUrl: 'icon.svg',
            title: params.title || 'Opencode Brower',
            message: params.message || ''
          });
          result = 'Notification sent';
          break;
        }

        // ZOOM

        case 'set_zoom': {
          const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
          const tabId = params.tabId || tab.id;
          await chrome.tabs.setZoom(tabId, params.zoom);
          result = `Zoom set to ${params.zoom}`;
          break;
        }

        case 'get_zoom': {
          const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
          const tabId = params.tabId || tab.id;
          const zoom = await chrome.tabs.getZoom(tabId);
          result = String(zoom);
          break;
        }

        // CLIPBOARD

        case 'write_clipboard': {
          const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
          const tabId = params.tabId || tab.id;
          await chrome.scripting.executeScript({
            target: { tabId },
            func: (text) => navigator.clipboard.writeText(text),
            args: [params.text]
          });
          result = 'Clipboard written';
          break;
        }

        case 'read_clipboard': {
          const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
          const tabId = params.tabId || tab.id;
          const [{ result: text }] = await chrome.scripting.executeScript({
            target: { tabId },
            func: () => navigator.clipboard.readText()
          });
          result = text;
          break;
        }

        // EXTENSIONS INFO

        case 'get_extension_info': {
          const self = await chrome.management.getSelf();
          result = JSON.stringify({
            id: self.id, name: self.name, version: self.version,
            enabled: self.enabled, permissions: self.permissions,
            author: {
              name: "mytai20100",
              github: "https://github.com/mytai20100",
              repository: "https://github.com/mytai20100/opencode-browser",
              npm: "https://www.npmjs.com/package/@mytai20100/opencode-browser"
            }
          });
          break;
        }

        // DEVTOOLS / DEBUGGER

        case 'debug_attach': {
          const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
          const tabId = params.tabId || tab.id;
          await chrome.debugger.attach({ tabId }, '1.3');
          // Enable Console and Network domains
          await chrome.debugger.sendCommand({ tabId }, 'Console.enable');
          await chrome.debugger.sendCommand({ tabId }, 'Network.enable');
          await chrome.debugger.sendCommand({ tabId }, 'Runtime.enable');
          await chrome.debugger.sendCommand({ tabId }, 'Performance.enable');
          await chrome.debugger.sendCommand({ tabId }, 'Log.enable');
          // Store captured events per tab
          if (!self._debugLogs) self._debugLogs = {};
          if (!self._debugNetwork) self._debugNetwork = {};
          self._debugLogs[tabId] = [];
          self._debugNetwork[tabId] = [];
          chrome.debugger.onEvent.addListener((src, method, evtParams) => {
            if (src.tabId !== tabId) return;
            if (method === 'Console.messageAdded') {
              self._debugLogs[tabId].push(evtParams.message);
            }
            if (method === 'Runtime.consoleAPICalled') {
              self._debugLogs[tabId].push({
                type: evtParams.type,
                text: evtParams.args.map(a => a.value ?? a.description ?? '').join(' '),
                timestamp: evtParams.timestamp,
                stackTrace: evtParams.stackTrace
              });
            }
            if (method === 'Log.entryAdded') {
              self._debugLogs[tabId].push(evtParams.entry);
            }
            if (method === 'Network.requestWillBeSent') {
              self._debugNetwork[tabId].push({
                type: 'request', requestId: evtParams.requestId,
                url: evtParams.request.url, method: evtParams.request.method,
                headers: evtParams.request.headers,
                postData: evtParams.request.postData,
                timestamp: evtParams.timestamp
              });
            }
            if (method === 'Network.responseReceived') {
              const existing = self._debugNetwork[tabId].find(r => r.requestId === evtParams.requestId);
              if (existing) {
                existing.status = evtParams.response.status;
                existing.responseHeaders = evtParams.response.headers;
                existing.mimeType = evtParams.response.mimeType;
              }
            }
          });
          result = `Debugger attached to tab ${tabId}`;
          break;
        }

        case 'debug_detach': {
          const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
          const tabId = params.tabId || tab.id;
          await chrome.debugger.detach({ tabId });
          result = `Debugger detached from tab ${tabId}`;
          break;
        }

        case 'debug_get_logs': {
          const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
          const tabId = params.tabId || tab.id;
          const logs = (self._debugLogs || {})[tabId] || [];
          const limit = params.limit || 100;
          const filtered = params.level
            ? logs.filter(l => l.type === params.level || l.level === params.level)
            : logs;
          result = JSON.stringify(filtered.slice(-limit));
          break;
        }

        case 'debug_clear_logs': {
          const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
          const tabId = params.tabId || tab.id;
          if (self._debugLogs) self._debugLogs[tabId] = [];
          result = 'Logs cleared';
          break;
        }

        case 'debug_get_network': {
          const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
          const tabId = params.tabId || tab.id;
          const requests = (self._debugNetwork || {})[tabId] || [];
          const limit = params.limit || 100;
          const filtered = params.filter
            ? requests.filter(r => r.url.includes(params.filter))
            : requests;
          result = JSON.stringify(filtered.slice(-limit));
          break;
        }

        case 'debug_clear_network': {
          const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
          const tabId = params.tabId || tab.id;
          if (self._debugNetwork) self._debugNetwork[tabId] = [];
          result = 'Network log cleared';
          break;
        }

        case 'debug_get_response_body': {
          const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
          const tabId = params.tabId || tab.id;
          const body = await chrome.debugger.sendCommand(
            { tabId }, 'Network.getResponseBody', { requestId: params.requestId }
          );
          result = JSON.stringify(body);
          break;
        }

        case 'debug_eval': {
          // Evaluate JS in the page context via Runtime.evaluate (bypasses CSP sandbox)
          const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
          const tabId = params.tabId || tab.id;
          const evalResult = await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
            expression: params.code,
            returnByValue: true,
            awaitPromise: true
          });
          result = JSON.stringify(evalResult.result);
          break;
        }

        case 'debug_get_source': {
          // Get the source of a script via Debugger domain
          const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
          const tabId = params.tabId || tab.id;
          const src = await chrome.debugger.sendCommand({ tabId }, 'Debugger.enable');
          result = JSON.stringify(src);
          break;
        }

        case 'debug_get_performance': {
          const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
          const tabId = params.tabId || tab.id;
          const metrics = await chrome.debugger.sendCommand({ tabId }, 'Performance.getMetrics');
          result = JSON.stringify(metrics.metrics);
          break;
        }

        case 'debug_get_dom_snapshot': {
          const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
          const tabId = params.tabId || tab.id;
          const snapshot = await chrome.debugger.sendCommand({ tabId }, 'DOMSnapshot.captureSnapshot', {
            computedStyles: [], includePaintOrder: true, includeDOMRects: true
          });
          result = JSON.stringify(snapshot);
          break;
        }

        case 'debug_set_breakpoint': {
          const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
          const tabId = params.tabId || tab.id;
          await chrome.debugger.sendCommand({ tabId }, 'Debugger.enable');
          const bp = await chrome.debugger.sendCommand({ tabId }, 'Debugger.setBreakpointByUrl', {
            lineNumber: params.line,
            url: params.url,
            columnNumber: params.column || 0
          });
          result = JSON.stringify(bp);
          break;
        }

        case 'debug_remove_breakpoint': {
          const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
          const tabId = params.tabId || tab.id;
          await chrome.debugger.sendCommand({ tabId }, 'Debugger.removeBreakpoint', {
            breakpointId: params.breakpointId
          });
          result = `Breakpoint ${params.breakpointId} removed`;
          break;
        }

        case 'debug_get_cookies': {
          // Get all cookies via debugger (including HttpOnly ones)
          const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
          const tabId = params.tabId || tab.id;
          const cookieResult = await chrome.debugger.sendCommand({ tabId }, 'Network.getAllCookies');
          result = JSON.stringify(cookieResult.cookies);
          break;
        }

        case 'debug_set_xhr_breakpoint': {
          const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
          const tabId = params.tabId || tab.id;
          await chrome.debugger.sendCommand({ tabId }, 'DOMDebugger.setXHRBreakpoint', {
            url: params.url || ''
          });
          result = `XHR breakpoint set for: ${params.url || '(all)'}`;
          break;
        }

        case 'debug_emulate_device': {
          const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
          const tabId = params.tabId || tab.id;
          await chrome.debugger.sendCommand({ tabId }, 'Emulation.setDeviceMetricsOverride', {
            width: params.width || 375,
            height: params.height || 812,
            deviceScaleFactor: params.deviceScaleFactor || 2,
            mobile: params.mobile !== false,
            screenWidth: params.width || 375,
            screenHeight: params.height || 812
          });
          await chrome.debugger.sendCommand({ tabId }, 'Emulation.setUserAgentOverride', {
            userAgent: params.userAgent || 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15'
          });
          result = `Device emulation set: ${params.width || 375}x${params.height || 812}`;
          break;
        }

        case 'debug_emulate_network': {
          const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
          const tabId = params.tabId || tab.id;
          // preset: offline, slow3g, fast3g, or custom
          const presets = {
            offline: { offline: true, downloadThroughput: 0, uploadThroughput: 0, latency: 0 },
            slow3g: { offline: false, downloadThroughput: 500 * 1024 / 8, uploadThroughput: 500 * 1024 / 8, latency: 400 },
            fast3g: { offline: false, downloadThroughput: 1.6 * 1024 * 1024 / 8, uploadThroughput: 750 * 1024 / 8, latency: 150 },
            none: { offline: false, downloadThroughput: -1, uploadThroughput: -1, latency: 0 }
          };
          const conditions = presets[params.preset] || {
            offline: params.offline || false,
            downloadThroughput: params.download || -1,
            uploadThroughput: params.upload || -1,
            latency: params.latency || 0
          };
          await chrome.debugger.sendCommand({ tabId }, 'Network.emulateNetworkConditions', conditions);
          result = `Network throttle set: ${params.preset || 'custom'}`;
          break;
        }

        case 'debug_block_urls': {
          const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
          const tabId = params.tabId || tab.id;
          await chrome.debugger.sendCommand({ tabId }, 'Network.setBlockedURLs', {
            urls: params.urls || []
          });
          result = `Blocked URLs: ${(params.urls || []).join(', ')}`;
          break;
        }

        case 'debug_get_storage': {
          const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
          const tabId = params.tabId || tab.id;
          const storageResult = await chrome.debugger.sendCommand({ tabId }, 'Storage.getDOMStorageItems', {
            storageId: { securityOrigin: params.origin, isLocalStorage: params.isLocal !== false }
          });
          result = JSON.stringify(storageResult.entries);
          break;
        }

        case 'debug_send_command': {
          // Raw CDP command for advanced use
          const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
          const tabId = params.tabId || tab.id;
          const cdpResult = await chrome.debugger.sendCommand(
            { tabId }, params.command, params.commandParams || {}
          );
          result = JSON.stringify(cdpResult);
          break;
        }

        // ACCESSIBILITY

        case 'get_accessibility_tree': {
          const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
          const tabId = params.tabId || tab.id;
          await chrome.debugger.attach({ tabId }, '1.3').catch(() => {});
          const tree = await chrome.debugger.sendCommand({ tabId }, 'Accessibility.getFullAXTree', {});
          result = JSON.stringify(tree.nodes?.slice(0, params.limit || 200));
          break;
        }

        case 'find_accessible_nodes': {
          const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
          const tabId = params.tabId || tab.id;
          await chrome.debugger.attach({ tabId }, '1.3').catch(() => {});
          const tree = await chrome.debugger.sendCommand({ tabId }, 'Accessibility.getFullAXTree', {});
          const query = (params.query || '').toLowerCase();
          const role = params.role?.toLowerCase();
          const filtered = (tree.nodes || []).filter(n => {
            const nameMatch = n.name?.value?.toLowerCase().includes(query);
            const roleMatch = !role || n.role?.value?.toLowerCase() === role;
            return nameMatch && roleMatch;
          }).slice(0, params.limit || 50);
          result = JSON.stringify(filtered);
          break;
        }

        // VISUAL / OCR

        case 'visual_click': {
          // Click at specific coordinates (x, y) instead of CSS selector
          const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
          const tabId = params.tabId || tab.id;
          await chrome.debugger.attach({ tabId }, '1.3').catch(() => {});
          await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchMouseEvent', {
            type: 'mousePressed', x: params.x, y: params.y,
            button: 'left', clickCount: 1
          });
          await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchMouseEvent', {
            type: 'mouseReleased', x: params.x, y: params.y,
            button: 'left', clickCount: 1
          });
          result = `Visual click at (${params.x}, ${params.y})`;
          break;
        }

        case 'ocr_page': {
          // Extract all visible text with bounding boxes via DOM layout
          const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
          const tabId = params.tabId || tab.id;
          const [{ result: texts }] = await chrome.scripting.executeScript({
            target: { tabId },
            func: () => {
              const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
              const items = [];
              let node;
              while ((node = walker.nextNode())) {
                const text = node.textContent.trim();
                if (!text) continue;
                const parent = node.parentElement;
                if (!parent) continue;
                const rect = parent.getBoundingClientRect();
                const style = getComputedStyle(parent);
                if (style.display === 'none' || style.visibility === 'hidden' || rect.width === 0) continue;
                items.push({
                  text,
                  x: Math.round(rect.x), y: Math.round(rect.y),
                  width: Math.round(rect.width), height: Math.round(rect.height),
                  tag: parent.tagName.toLowerCase()
                });
              }
              return items;
            }
          });
          result = JSON.stringify(texts?.slice(0, params.limit || 500));
          break;
        }

        case 'find_text_on_screen': {
          const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
          const tabId = params.tabId || tab.id;
          const [{ result: found }] = await chrome.scripting.executeScript({
            target: { tabId },
            func: (query, exact) => {
              const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
              const items = [];
              let node;
              while ((node = walker.nextNode())) {
                const text = node.textContent.trim();
                const match = exact ? text === query : text.toLowerCase().includes(query.toLowerCase());
                if (!match) continue;
                const parent = node.parentElement;
                if (!parent) continue;
                const rect = parent.getBoundingClientRect();
                items.push({
                  text,
                  x: Math.round(rect.x + rect.width / 2),
                  y: Math.round(rect.y + rect.height / 2),
                  rect: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) },
                  tag: parent.tagName.toLowerCase(),
                  selector: parent.id ? `#${parent.id}` : parent.className ? `.${parent.className.split(' ')[0]}` : parent.tagName.toLowerCase()
                });
              }
              return items;
            },
            args: [params.query, params.exact || false]
          });
          result = JSON.stringify(found);
          break;
        }

        // NETWORK INTERCEPT / MOCK

        case 'intercept_request': {
          const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
          const tabId = params.tabId || tab.id;
          await chrome.debugger.attach({ tabId }, '1.3').catch(() => {});
          await chrome.debugger.sendCommand({ tabId }, 'Fetch.enable', {
            patterns: [{ urlPattern: params.urlPattern || '*', requestStage: 'Request' }]
          });
          if (!self._intercepted) self._intercepted = {};
          self._intercepted[tabId] = [];
          chrome.debugger.onEvent.addListener((src, method, evtParams) => {
            if (src.tabId !== tabId || method !== 'Fetch.requestPaused') return;
            self._intercepted[tabId].push(evtParams);
            // Auto-continue unless mock is set
            const mock = (self._mocks || {})[evtParams.request.url];
            if (mock) {
              chrome.debugger.sendCommand({ tabId }, 'Fetch.fulfillRequest', {
                requestId: evtParams.requestId,
                responseCode: mock.status || 200,
                responseHeaders: Object.entries(mock.headers || { 'Content-Type': 'application/json' })
                  .map(([name, value]) => ({ name, value })),
                body: btoa(typeof mock.body === 'string' ? mock.body : JSON.stringify(mock.body))
              });
            } else {
              chrome.debugger.sendCommand({ tabId }, 'Fetch.continueRequest', {
                requestId: evtParams.requestId
              });
            }
          });
          result = `Intercepting requests matching: ${params.urlPattern || '*'}`;
          break;
        }

        case 'mock_response': {
          if (!self._mocks) self._mocks = {};
          self._mocks[params.url] = {
            status: params.status || 200,
            headers: params.headers || { 'Content-Type': 'application/json' },
            body: params.body || '{}'
          };
          result = `Mock set for: ${params.url}`;
          break;
        }

        case 'modify_headers': {
          const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
          const tabId = params.tabId || tab.id;
          await chrome.debugger.attach({ tabId }, '1.3').catch(() => {});
          await chrome.debugger.sendCommand({ tabId }, 'Fetch.enable', {
            patterns: [{ urlPattern: params.urlPattern || '*', requestStage: 'Request' }]
          });
          chrome.debugger.onEvent.addListener(async (src, method, evtParams) => {
            if (src.tabId !== tabId || method !== 'Fetch.requestPaused') return;
            const existingHeaders = evtParams.request.headers;
            const mergedHeaders = Object.entries({ ...existingHeaders, ...(params.headers || {}) })
              .map(([name, value]) => ({ name, value }));
            await chrome.debugger.sendCommand({ tabId }, 'Fetch.continueRequest', {
              requestId: evtParams.requestId,
              headers: mergedHeaders
            });
          });
          result = `Headers modifier active for: ${params.urlPattern || '*'}`;
          break;
        }

        // SESSION

        case 'save_session': {
          const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
          const tabId = params.tabId || tab.id;
          const currentTab = await chrome.tabs.get(tabId);
          // Save all cookies + localStorage for current origin
          const url = currentTab.url;
          const origin = new URL(url).origin;
          const cookies = await chrome.cookies.getAll({ url });
          const [{ result: storage }] = await chrome.scripting.executeScript({
            target: { tabId },
            func: () => {
              const data = {};
              for (let i = 0; i < localStorage.length; i++) {
                const k = localStorage.key(i);
                data[k] = localStorage.getItem(k);
              }
              return data;
            }
          });
          const session = { url, origin, cookies, localStorage: storage, savedAt: Date.now() };
          const key = params.name || origin;
          await chrome.storage.local.set({ [`session_${key}`]: session });
          result = JSON.stringify({ saved: key, cookies: cookies.length, localStorageKeys: Object.keys(storage || {}).length });
          break;
        }

        case 'restore_session': {
          const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
          const tabId = params.tabId || tab.id;
          const key = params.name;
          const stored = await chrome.storage.local.get([`session_${key}`]);
          const session = stored[`session_${key}`];
          if (!session) throw new Error(`Session not found: ${key}`);
          // Restore cookies
          for (const cookie of session.cookies) {
            await chrome.cookies.set({
              url: session.url, name: cookie.name, value: cookie.value,
              domain: cookie.domain, path: cookie.path,
              secure: cookie.secure, httpOnly: cookie.httpOnly
            }).catch(() => {});
          }
          // Restore localStorage
          if (session.localStorage) {
            await chrome.scripting.executeScript({
              target: { tabId },
              func: (data) => {
                for (const [k, v] of Object.entries(data)) localStorage.setItem(k, v);
              },
              args: [session.localStorage]
            });
          }
          result = JSON.stringify({ restored: key, savedAt: new Date(session.savedAt).toISOString() });
          break;
        }

        // EVENTS & DOM WATCH

        case 'subscribe_events': {
          const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
          const tabId = params.tabId || tab.id;
          if (!self._eventLog) self._eventLog = {};
          self._eventLog[tabId] = [];
          await chrome.scripting.executeScript({
            target: { tabId },
            func: (events) => {
              if (!window.__ocEventLog) window.__ocEventLog = [];
              events.forEach(evt => {
                document.addEventListener(evt, (e) => {
                  window.__ocEventLog.push({
                    type: e.type,
                    target: e.target?.tagName + (e.target?.id ? `#${e.target.id}` : ''),
                    timestamp: Date.now(),
                    detail: e.detail || null
                  });
                }, { capture: true, passive: true });
              });
              return `Subscribed to: ${events.join(', ')}`;
            },
            args: [params.events || ['click', 'input', 'submit', 'change', 'keydown']]
          });
          result = `Subscribed to events: ${(params.events || ['click','input','submit','change','keydown']).join(', ')}`;
          break;
        }

        case 'watch_dom_changes': {
          const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
          const tabId = params.tabId || tab.id;
          const [{ result: watchResult }] = await chrome.scripting.executeScript({
            target: { tabId },
            func: (selector, limit) => {
              if (window.__ocMutationLog) return 'Already watching';
              window.__ocMutationLog = [];
              const target = selector ? document.querySelector(selector) : document.body;
              const observer = new MutationObserver((mutations) => {
                mutations.forEach(m => {
                  window.__ocMutationLog.push({
                    type: m.type,
                    target: m.target?.tagName + (m.target?.id ? `#${m.target.id}` : ''),
                    addedNodes: m.addedNodes.length,
                    removedNodes: m.removedNodes.length,
                    attributeName: m.attributeName,
                    oldValue: m.oldValue,
                    timestamp: Date.now()
                  });
                  if (window.__ocMutationLog.length > (limit || 500)) window.__ocMutationLog.shift();
                });
              });
              observer.observe(target, {
                childList: true, subtree: true, attributes: true,
                attributeOldValue: true, characterData: true
              });
              window.__ocObserver = observer;
              return 'DOM watch started';
            },
            args: [params.selector || null, params.limit || 500]
          });
          result = watchResult;
          break;
        }

        // IFRAMES

        case 'list_iframes': {
          const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
          const tabId = params.tabId || tab.id;
          const [{ result: frames }] = await chrome.scripting.executeScript({
            target: { tabId },
            func: () => {
              return [...document.querySelectorAll('iframe, frame')].map((f, i) => ({
                index: i,
                src: f.src,
                id: f.id,
                name: f.name,
                width: f.width,
                height: f.height,
                selector: f.id ? `#${f.id}` : `iframe:nth-of-type(${i + 1})`
              }));
            }
          });
          result = JSON.stringify(frames);
          break;
        }

        case 'switch_iframe': {
          const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
          const tabId = params.tabId || tab.id;
          const [{ result: iframeResult }] = await chrome.scripting.executeScript({
            target: { tabId, allFrames: true },
            func: (code, frameIndex) => {
              if (window.frameElement) {
                const idx = [...window.parent.document.querySelectorAll('iframe')].indexOf(window.frameElement);
                if (idx === frameIndex) return eval(code);
              }
            },
            args: [params.code || 'document.title', params.frameIndex || 0]
          });
          result = JSON.stringify(iframeResult);
          break;
        }

        // FILE UPLOAD

        case 'upload_file': {
          const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
          const tabId = params.tabId || tab.id;
          await chrome.debugger.attach({ tabId }, '1.3').catch(() => {});
          // Get the DOM node ID first
          const dom = await chrome.debugger.sendCommand({ tabId }, 'DOM.getDocument', {});
          const node = await chrome.debugger.sendCommand({ tabId }, 'DOM.querySelector', {
            nodeId: dom.root.nodeId, selector: params.selector
          });
          await chrome.debugger.sendCommand({ tabId }, 'DOM.setFileInputFiles', {
            files: params.files,
            nodeId: node.nodeId
          });
          result = `Files set on ${params.selector}: ${params.files.join(', ')}`;
          break;
        }

        // PERMISSIONS

        case 'grant_permissions': {
          const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
          const tabId = params.tabId || tab.id;
          const currentTab = await chrome.tabs.get(tabId);
          const origin = new URL(currentTab.url).origin;
          await chrome.debugger.attach({ tabId }, '1.3').catch(() => {});
          for (const permission of (params.permissions || [])) {
            await chrome.debugger.sendCommand({ tabId }, 'Browser.grantPermissions', {
              permissions: [permission],
              origin
            }).catch(() => {});
          }
          result = `Permissions granted: ${params.permissions?.join(', ')}`;
          break;
        }

        // VIRTUAL AUTHENTICATOR (WebAuthn)

        case 'virtual_authenticator': {
          const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
          const tabId = params.tabId || tab.id;
          await chrome.debugger.attach({ tabId }, '1.3').catch(() => {});
          if (params.action === 'add') {
            const auth = await chrome.debugger.sendCommand({ tabId }, 'WebAuthn.addVirtualAuthenticator', {
              options: {
                protocol: params.protocol || 'ctap2',
                transport: params.transport || 'usb',
                hasResidentKey: params.hasResidentKey || true,
                hasUserVerification: params.hasUserVerification || true,
                isUserVerified: params.isUserVerified || true,
                automaticPresenceSimulation: params.automaticPresenceSimulation !== false
              }
            });
            result = JSON.stringify(auth);
          } else if (params.action === 'remove') {
            await chrome.debugger.sendCommand({ tabId }, 'WebAuthn.removeVirtualAuthenticator', {
              authenticatorId: params.authenticatorId
            });
            result = `Authenticator removed: ${params.authenticatorId}`;
          } else if (params.action === 'enable') {
            await chrome.debugger.sendCommand({ tabId }, 'WebAuthn.enable', {});
            result = 'WebAuthn virtual environment enabled';
          }
          break;
        }

        // WORKFLOW CONTEXT

        case 'get_workflow_context': {
          const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
          const tabId = params.tabId || tab.id;
          const currentTab = await chrome.tabs.get(tabId);
          const [{ result: pageCtx }] = await chrome.scripting.executeScript({
            target: { tabId },
            func: () => ({
              forms: [...document.forms].map((f, i) => ({
                index: i, id: f.id, action: f.action, method: f.method,
                fields: [...f.elements].map(el => ({
                  name: el.name, type: el.type, value: el.value?.substring(0, 100), tagName: el.tagName
                }))
              })),
              buttons: [...document.querySelectorAll('button, [role="button"], input[type="submit"]')]
                .slice(0, 30).map(b => ({ text: b.innerText?.trim(), id: b.id, type: b.type })),
              inputs: [...document.querySelectorAll('input, textarea, select')]
                .slice(0, 30).map(el => ({
                  name: el.name, id: el.id, type: el.type,
                  placeholder: el.placeholder, value: el.value?.substring(0, 100)
                })),
              mutationLog: (window.__ocMutationLog || []).slice(-20),
              eventLog: (window.__ocEventLog || []).slice(-20),
              readyState: document.readyState,
              title: document.title, url: location.href
            })
          });
          result = JSON.stringify({ tab: { id: tabId, title: currentTab.title, url: currentTab.url }, page: pageCtx });
          break;
        }

        // HAR EXPORT

        case 'export_har': {
          const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
          const tabId = params.tabId || tab.id;
          const requests = (self._debugNetwork || {})[tabId] || [];
          const har = {
            log: {
              version: '1.2',
              creator: { name: 'Opencode Brower', version: '0.1.0' },
              entries: requests.map(r => ({
                startedDateTime: new Date(r.timestamp * 1000).toISOString(),
                time: 0,
                request: {
                  method: r.method, url: r.url,
                  httpVersion: 'HTTP/1.1', cookies: [], headers: [],
                  queryString: [], bodySize: -1, headersSize: -1,
                  postData: r.postData ? { mimeType: 'application/json', text: r.postData } : undefined
                },
                response: {
                  status: r.status || 0, statusText: '',
                  httpVersion: 'HTTP/1.1', cookies: [], headers: [],
                  content: { size: -1, mimeType: r.mimeType || '' },
                  redirectURL: '', headersSize: -1, bodySize: -1
                },
                cache: {}, timings: { send: 0, wait: 0, receive: 0 }
              }))
            }
          };
          result = JSON.stringify(har);
          break;
        }

        // REPLAY REQUEST

        case 'replay_request': {
          const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
          const tabId = params.tabId || tab.id;
          const [{ result: replayResult }] = await chrome.scripting.executeScript({
            target: { tabId },
            func: async (url, method, headers, body) => {
              const res = await fetch(url, {
                method: method || 'GET',
                headers: headers || {},
                body: ['GET', 'HEAD'].includes(method) ? undefined : body
              });
              const text = await res.text();
              return {
                status: res.status, statusText: res.statusText,
                headers: Object.fromEntries(res.headers.entries()),
                body: text.substring(0, 5000)
              };
            },
            args: [params.url, params.method || 'GET', params.headers || {}, params.body || null]
          });
          result = JSON.stringify(replayResult);
          break;
        }
        case 'double_click': {
          const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
          const tabId = params.tabId || tab.id;
          
          if (params.selector) {
            await chrome.scripting.executeScript({
              target: { tabId },
              func: (selector) => {
                const el = document.querySelector(selector);
                if (!el) throw new Error(`Element not found: ${selector}`);
                el.scrollIntoView({ behavior: 'smooth', block: 'center' });
                el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
                return 'Double clicked';
              },
              args: [params.selector]
            });
            result = `Double clicked: ${params.selector}`;
          } else if (params.x !== undefined && params.y !== undefined) {
            await chrome.debugger.attach({ tabId }, '1.3').catch(() => {});
            await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchMouseEvent', {
              type: 'mousePressed', x: params.x, y: params.y, button: 'left', clickCount: 2
            });
            await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchMouseEvent', {
              type: 'mouseReleased', x: params.x, y: params.y, button: 'left', clickCount: 2
            });
            result = `Double clicked at (${params.x}, ${params.y})`;
          }
          break;
        }

        case 'right_click': {
          const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
          const tabId = params.tabId || tab.id;
          
          if (params.selector) {
            await chrome.scripting.executeScript({
              target: { tabId },
              func: (selector) => {
                const el = document.querySelector(selector);
                if (!el) throw new Error(`Element not found: ${selector}`);
                el.scrollIntoView({ behavior: 'smooth', block: 'center' });
                el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
                return 'Right clicked';
              },
              args: [params.selector]
            });
            result = `Right clicked: ${params.selector}`;
          } else if (params.x !== undefined && params.y !== undefined) {
            await chrome.debugger.attach({ tabId }, '1.3').catch(() => {});
            await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchMouseEvent', {
              type: 'mousePressed', x: params.x, y: params.y, button: 'right', clickCount: 1
            });
            await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchMouseEvent', {
              type: 'mouseReleased', x: params.x, y: params.y, button: 'right', clickCount: 1
            });
            result = `Right clicked at (${params.x}, ${params.y})`;
          }
          break;
        }

        case 'middle_click': {
          const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
          const tabId = params.tabId || tab.id;
          
          if (params.selector) {
            await chrome.scripting.executeScript({
              target: { tabId },
              func: (selector) => {
                const el = document.querySelector(selector);
                if (!el) throw new Error(`Element not found: ${selector}`);
                el.scrollIntoView({ behavior: 'smooth', block: 'center' });
                el.dispatchEvent(new MouseEvent('auxclick', { bubbles: true, cancelable: true, button: 1 }));
                return 'Middle clicked';
              },
              args: [params.selector]
            });
            result = `Middle clicked: ${params.selector}`;
          } else if (params.x !== undefined && params.y !== undefined) {
            await chrome.debugger.attach({ tabId }, '1.3').catch(() => {});
            await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchMouseEvent', {
              type: 'mousePressed', x: params.x, y: params.y, button: 'middle', clickCount: 1
            });
            await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchMouseEvent', {
              type: 'mouseReleased', x: params.x, y: params.y, button: 'middle', clickCount: 1
            });
            result = `Middle clicked at (${params.x}, ${params.y})`;
          }
          break;
        }

        case 'drag_drop': {
          const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
          const tabId = params.tabId || tab.id;
          await chrome.debugger.attach({ tabId }, '1.3').catch(() => {});
          
          let fromX, fromY, toX, toY;
          
          if (params.fromSelector || params.toSelector) {
            const [{ result: coords }] = await chrome.scripting.executeScript({
              target: { tabId },
              func: (fromSel, toSel) => {
                const from = fromSel ? document.querySelector(fromSel) : null;
                const to = toSel ? document.querySelector(toSel) : null;
                if (fromSel && !from) throw new Error(`From element not found: ${fromSel}`);
                if (toSel && !to) throw new Error(`To element not found: ${toSel}`);
                const fromRect = from?.getBoundingClientRect();
                const toRect = to?.getBoundingClientRect();
                return {
                  fromX: fromRect ? fromRect.x + fromRect.width / 2 : null,
                  fromY: fromRect ? fromRect.y + fromRect.height / 2 : null,
                  toX: toRect ? toRect.x + toRect.width / 2 : null,
                  toY: toRect ? toRect.y + toRect.height / 2 : null
                };
              },
              args: [params.fromSelector || null, params.toSelector || null]
            });
            fromX = coords.fromX ?? params.fromX;
            fromY = coords.fromY ?? params.fromY;
            toX = coords.toX ?? params.toX;
            toY = coords.toY ?? params.toY;
          } else {
            fromX = params.fromX;
            fromY = params.fromY;
            toX = params.toX;
            toY = params.toY;
          }
          
          await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchDragEvent', {
            type: 'dragEnter', x: fromX, y: fromY, data: { items: [], dragOperationsMask: 1 }
          });
          await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchMouseEvent', {
            type: 'mousePressed', x: fromX, y: fromY, button: 'left', clickCount: 1
          });
          await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchMouseEvent', {
            type: 'mouseMoved', x: toX, y: toY, button: 'left'
          });
          await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchMouseEvent', {
            type: 'mouseReleased', x: toX, y: toY, button: 'left', clickCount: 1
          });
          result = `Dragged from (${fromX}, ${fromY}) to (${toX}, ${toY})`;
          break;
        }

        case 'keyboard_shortcut': {
          const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
          const tabId = params.tabId || tab.id;
          
          const shortcutMap = {
            'Ctrl+C': { key: 'c', ctrl: true },
            'Ctrl+V': { key: 'v', ctrl: true },
            'Ctrl+X': { key: 'x', ctrl: true },
            'Ctrl+A': { key: 'a', ctrl: true },
            'Ctrl+Z': { key: 'z', ctrl: true },
            'Ctrl+Y': { key: 'y', ctrl: true },
            'Ctrl+S': { key: 's', ctrl: true },
            'Ctrl+F': { key: 'f', ctrl: true },
            'Ctrl+P': { key: 'p', ctrl: true },
            'Ctrl+N': { key: 'n', ctrl: true },
            'Ctrl+T': { key: 't', ctrl: true },
            'Ctrl+W': { key: 'w', ctrl: true },
            'Alt+F4': { key: 'F4', alt: true },
          };
          
          const shortcut = shortcutMap[params.shortcut];
          if (!shortcut) throw new Error(`Unknown shortcut: ${params.shortcut}`);
          
          await chrome.debugger.attach({ tabId }, '1.3').catch(() => {});
          const modifiers = (shortcut.ctrl ? 2 : 0) | (shortcut.alt ? 1 : 0) | (shortcut.shift ? 8 : 0);
          
          await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchKeyEvent', {
            type: 'keyDown', key: shortcut.key, modifiers
          });
          await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchKeyEvent', {
            type: 'keyUp', key: shortcut.key, modifiers
          });
          result = `Executed shortcut: ${params.shortcut}`;
          break;
        }

        // WAIT TOOLS
        
        case 'wait_for_navigation': {
          const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
          const tabId = params.tabId || tab.id;
          const timeout = params.timeout || 30000;
          
          await chrome.debugger.attach({ tabId }, '1.3').catch(() => {});
          await chrome.debugger.sendCommand({ tabId }, 'Page.enable');
          
          const waitPromise = new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('Navigation timeout')), timeout);
            const listener = (src, method) => {
              if (src.tabId === tabId && method === 'Page.loadEventFired') {
                clearTimeout(timer);
                chrome.debugger.onEvent.removeListener(listener);
                resolve(true);
              }
            };
            chrome.debugger.onEvent.addListener(listener);
          });
          
          await waitPromise;
          result = 'Navigation completed';
          break;
        }

        case 'wait_for_network_idle': {
          const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
          const tabId = params.tabId || tab.id;
          const idleTime = params.idleTime || 500;
          const timeout = params.timeout || 30000;
          
          await chrome.debugger.attach({ tabId }, '1.3').catch(() => {});
          await chrome.debugger.sendCommand({ tabId }, 'Network.enable');
          
          let activeRequests = 0;
          let lastActivityTime = Date.now();
          
          const waitPromise = new Promise((resolve, reject) => {
            const startTime = Date.now();
            const listener = (src, method) => {
              if (src.tabId !== tabId) return;
              if (method === 'Network.requestWillBeSent') {
                activeRequests++;
                lastActivityTime = Date.now();
              }
              if (method === 'Network.loadingFinished' || method === 'Network.loadingFailed') {
                activeRequests--;
                lastActivityTime = Date.now();
              }
            };
            chrome.debugger.onEvent.addListener(listener);
            
            const checkIdle = setInterval(() => {
              if (Date.now() - startTime > timeout) {
                clearInterval(checkIdle);
                chrome.debugger.onEvent.removeListener(listener);
                reject(new Error('Network idle timeout'));
              }
              if (activeRequests === 0 && Date.now() - lastActivityTime >= idleTime) {
                clearInterval(checkIdle);
                chrome.debugger.onEvent.removeListener(listener);
                resolve(true);
              }
            }, 100);
          });
          
          await waitPromise;
          result = 'Network idle';
          break;
        }

        // SCREENSHOT TOOLS
        
        case 'screenshot_element': {
          const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
          const tabId = params.tabId || tab.id;
          await chrome.debugger.attach({ tabId }, '1.3').catch(() => {});
          
          const [{ result: rect }] = await chrome.scripting.executeScript({
            target: { tabId },
            func: (selector) => {
              const el = document.querySelector(selector);
              if (!el) throw new Error(`Element not found: ${selector}`);
              const r = el.getBoundingClientRect();
              return { x: r.x, y: r.y, width: r.width, height: r.height };
            },
            args: [params.selector]
          });
          
          const screenshot = await chrome.debugger.sendCommand({ tabId }, 'Page.captureScreenshot', {
            format: params.format || 'png',
            quality: params.quality || 90,
            clip: { x: rect.x, y: rect.y, width: rect.width, height: rect.height, scale: 1 }
          });
          result = 'data:image/' + (params.format || 'png') + ';base64,' + screenshot.data;
          break;
        }

        case 'screenshot_fullpage': {
          const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
          const tabId = params.tabId || tab.id;
          await chrome.debugger.attach({ tabId }, '1.3').catch(() => {});
          
          const metrics = await chrome.debugger.sendCommand({ tabId }, 'Page.getLayoutMetrics');
          const width = metrics.contentSize.width;
          const height = metrics.contentSize.height;
          
          await chrome.debugger.sendCommand({ tabId }, 'Emulation.setDeviceMetricsOverride', {
            width: width,
            height: height,
            deviceScaleFactor: 1,
            mobile: false
          });
          
          const screenshot = await chrome.debugger.sendCommand({ tabId }, 'Page.captureScreenshot', {
            format: params.format || 'png',
            quality: params.quality || 90,
            captureBeyondViewport: true
          });
          
          await chrome.debugger.sendCommand({ tabId }, 'Emulation.clearDeviceMetricsOverride');
          
          result = 'data:image/' + (params.format || 'png') + ';base64,' + screenshot.data;
          break;
        }

        case 'pdf_print': {
          const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
          const tabId = params.tabId || tab.id;
          await chrome.debugger.attach({ tabId }, '1.3').catch(() => {});
          
          const pdf = await chrome.debugger.sendCommand({ tabId }, 'Page.printToPDF', {
            landscape: params.landscape || false,
            displayHeaderFooter: params.displayHeaderFooter || false,
            printBackground: params.printBackground !== false,
            scale: params.scale || 1,
            paperWidth: params.paperWidth || 8.5,
            paperHeight: params.paperHeight || 11,
            marginTop: params.marginTop || 0.4,
            marginBottom: params.marginBottom || 0.4,
            marginLeft: params.marginLeft || 0.4,
            marginRight: params.marginRight || 0.4,
            preferCSSPageSize: true
          });
          
          result = 'data:application/pdf;base64,' + pdf.data;
          break;
        }

        // CSS INJECTION
        
        case 'inject_css': {
          const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
          const tabId = params.tabId || tab.id;
          
          const cssId = 'oc-injected-' + Date.now();
          await chrome.scripting.insertCSS({
            target: { tabId },
            css: params.css,
            origin: 'USER'
          });
          
          if (!self._injectedCSS) self._injectedCSS = {};
          if (!self._injectedCSS[tabId]) self._injectedCSS[tabId] = [];
          self._injectedCSS[tabId].push({ id: cssId, css: params.css });
          
          result = JSON.stringify({ cssId, injected: true });
          break;
        }

        case 'remove_css': {
          const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
          const tabId = params.tabId || tab.id;
          
          const injected = (self._injectedCSS || {})[tabId] || [];
          const item = injected.find(i => i.id === params.cssId);
          if (!item) throw new Error(`CSS ID not found: ${params.cssId}`);
          
          await chrome.scripting.removeCSS({
            target: { tabId },
            css: item.css
          });
          
          self._injectedCSS[tabId] = injected.filter(i => i.id !== params.cssId);
          result = `CSS removed: ${params.cssId}`;
          break;
        }

        // TEXT SELECTION
        
        case 'select_text': {
          const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
          const tabId = params.tabId || tab.id;
          
          await chrome.scripting.executeScript({
            target: { tabId },
            func: (selector, startOffset, endOffset) => {
              const el = document.querySelector(selector);
              if (!el) throw new Error(`Element not found: ${selector}`);
              
              const range = document.createRange();
              const textNode = el.firstChild || el;
              range.setStart(textNode, startOffset || 0);
              range.setEnd(textNode, endOffset || textNode.textContent?.length || 0);
              
              const selection = window.getSelection();
              selection.removeAllRanges();
              selection.addRange(range);
              
              return 'Text selected';
            },
            args: [params.selector, params.startOffset, params.endOffset]
          });
          
          result = 'Text selected';
          break;
        }

        case 'get_selected_text': {
          const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
          const tabId = params.tabId || tab.id;
          
          const [{ result: selectedText }] = await chrome.scripting.executeScript({
            target: { tabId },
            func: () => window.getSelection().toString()
          });
          
          result = selectedText || '';
          break;
        }

        case 'focus_element': {
          const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
          const tabId = params.tabId || tab.id;
          
          await chrome.scripting.executeScript({
            target: { tabId },
            func: (selector) => {
              const el = document.querySelector(selector);
              if (!el) throw new Error(`Element not found: ${selector}`);
              el.focus();
              return 'Element focused';
            },
            args: [params.selector]
          });
          
          result = `Focused: ${params.selector}`;
          break;
        }

        case 'clear_input': {
          const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
          const tabId = params.tabId || tab.id;
          
          await chrome.scripting.executeScript({
            target: { tabId },
            func: (selector) => {
              const el = document.querySelector(selector);
              if (!el) throw new Error(`Element not found: ${selector}`);
              el.value = '';
              el.dispatchEvent(new Event('input', { bubbles: true }));
              el.dispatchEvent(new Event('change', { bubbles: true }));
              return 'Input cleared';
            },
            args: [params.selector]
          });
          
          result = `Cleared: ${params.selector}`;
          break;
        }
        case 'mock_geolocation': {
          const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
          const tabId = params.tabId || tab.id;
          await chrome.debugger.attach({ tabId }, '1.3').catch(() => {});
          
          await chrome.debugger.sendCommand({ tabId }, 'Emulation.setGeolocationOverride', {
            latitude: params.latitude,
            longitude: params.longitude,
            accuracy: params.accuracy || 100
          });
          
          result = `Geolocation set to (${params.latitude}, ${params.longitude})`;
          break;
        }

        case 'mock_timezone': {
          const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
          const tabId = params.tabId || tab.id;
          await chrome.debugger.attach({ tabId }, '1.3').catch(() => {});
          
          await chrome.debugger.sendCommand({ tabId }, 'Emulation.setTimezoneOverride', {
            timezoneId: params.timezoneId
          });
          
          result = `Timezone set to ${params.timezoneId}`;
          break;
        }

        case 'mock_locale': {
          const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
          const tabId = params.tabId || tab.id;
          await chrome.debugger.attach({ tabId }, '1.3').catch(() => {});
          
          await chrome.debugger.sendCommand({ tabId }, 'Emulation.setLocaleOverride', {
            locale: params.locale
          });
          
          result = `Locale set to ${params.locale}`;
          break;
        }

        case 'mock_battery': {
          const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
          const tabId = params.tabId || tab.id;
          
          await chrome.scripting.executeScript({
            target: { tabId },
            func: (charging, level, chargingTime, dischargingTime) => {
              const mockBattery = {
                charging: charging,
                chargingTime: chargingTime || Infinity,
                dischargingTime: dischargingTime || Infinity,
                level: level,
                addEventListener: () => {},
                removeEventListener: () => {}
              };
              
              Object.defineProperty(navigator, 'getBattery', {
                value: () => Promise.resolve(mockBattery),
                writable: false
              });
              
              return 'Battery mocked';
            },
            args: [params.charging, params.level, params.chargingTime, params.dischargingTime]
          });
          
          result = `Battery mocked: ${params.charging ? 'charging' : 'discharging'}, level ${params.level}`;
          break;
        }

        case 'mock_media_type': {
          const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
          const tabId = params.tabId || tab.id;
          await chrome.debugger.attach({ tabId }, '1.3').catch(() => {});
          
          await chrome.debugger.sendCommand({ tabId }, 'Emulation.setEmulatedMedia', {
            media: params.mediaType
          });
          
          result = `Media type set to ${params.mediaType}`;
          break;
        }

        case 'emulate_vision': {
          const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
          const tabId = params.tabId || tab.id;
          await chrome.debugger.attach({ tabId }, '1.3').catch(() => {});
          
          await chrome.debugger.sendCommand({ tabId }, 'Emulation.setEmulatedVisionDeficiency', {
            type: params.type
          });
          
          result = `Vision deficiency emulated: ${params.type}`;
          break;
        }

        case 'cpu_throttle': {
          const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
          const tabId = params.tabId || tab.id;
          await chrome.debugger.attach({ tabId }, '1.3').catch(() => {});
          
          await chrome.debugger.sendCommand({ tabId }, 'Emulation.setCPUThrottlingRate', {
            rate: params.rate
          });
          
          result = `CPU throttled to ${params.rate}x`;
          break;
        }

        case 'mock_date_time': {
          const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
          const tabId = params.tabId || tab.id;
          
          await chrome.scripting.executeScript({
            target: { tabId },
            func: (timestamp, freeze) => {
              const originalDate = Date;
              const mockTime = timestamp;
              let offset = mockTime - originalDate.now();
              
              if (freeze) {
                Date = class extends originalDate {
                  constructor(...args) {
                    if (args.length === 0) {
                      super(mockTime);
                    } else {
                      super(...args);
                    }
                  }
                  static now() { return mockTime; }
                };
              } else {
                Date = class extends originalDate {
                  constructor(...args) {
                    if (args.length === 0) {
                      super(originalDate.now() + offset);
                    } else {
                      super(...args);
                    }
                  }
                  static now() { return originalDate.now() + offset; }
                };
              }
              
              Date.UTC = originalDate.UTC;
              Date.parse = originalDate.parse;
              
              return 'Date mocked';
            },
            args: [params.timestamp, params.freeze || false]
          });
          
          result = `Date/time mocked to ${new Date(params.timestamp).toISOString()}`;
          break;
        }

        case 'modify_response_body': {
          const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
          const tabId = params.tabId || tab.id;
          await chrome.debugger.attach({ tabId }, '1.3').catch(() => {});
          
          await chrome.debugger.sendCommand({ tabId }, 'Fetch.enable', {
            patterns: [{ urlPattern: params.urlPattern, requestStage: 'Response' }]
          });
          
          if (!self._responseModifiers) self._responseModifiers = {};
          self._responseModifiers[params.urlPattern] = params.newBody;
          
          chrome.debugger.onEvent.addListener(async (src, method, evtParams) => {
            if (src.tabId !== tabId || method !== 'Fetch.requestPaused') return;
            if (!evtParams.responseStatusCode) return;
            
            const modifier = self._responseModifiers[params.urlPattern];
            if (modifier && evtParams.request.url.includes(params.urlPattern.replace('*', ''))) {
              await chrome.debugger.sendCommand({ tabId }, 'Fetch.fulfillRequest', {
                requestId: evtParams.requestId,
                responseCode: evtParams.responseStatusCode,
                responseHeaders: evtParams.responseHeaders,
                body: btoa(modifier)
              });
            } else {
              await chrome.debugger.sendCommand({ tabId }, 'Fetch.continueRequest', {
                requestId: evtParams.requestId
              });
            }
          });
          
          result = `Response body modifier set for: ${params.urlPattern}`;
          break;
        }

        case 'get_ws_frames': {
          const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
          const tabId = params.tabId || tab.id;
          
          const frames = (self._wsFrames || {})[tabId] || [];
          result = JSON.stringify(frames.slice(-(params.limit || 100)));
          break;
        }

        case 'set_extra_headers': {
          const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
          const tabId = params.tabId || tab.id;
          await chrome.debugger.attach({ tabId }, '1.3').catch(() => {});
          
          await chrome.debugger.sendCommand({ tabId }, 'Network.setExtraHTTPHeaders', {
            headers: params.headers
          });
          
          result = `Extra headers set: ${Object.keys(params.headers).join(', ')}`;
          break;
        }

        case 'get_request_body': {
          const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
          const tabId = params.tabId || tab.id;
          
          const body = await chrome.debugger.sendCommand({ tabId }, 'Network.getRequestPostData', {
            requestId: params.requestId
          });
          
          result = body.postData || '';
          break;
        }


        case 'profiling_start': {
          const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
          const tabId = params.tabId || tab.id;
          await chrome.debugger.attach({ tabId }, '1.3').catch(() => {});
          
          await chrome.debugger.sendCommand({ tabId }, 'Profiler.enable');
          await chrome.debugger.sendCommand({ tabId }, 'Profiler.start');
          
          result = 'CPU profiling started';
          break;
        }

        case 'profiling_stop': {
          const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
          const tabId = params.tabId || tab.id;
          
          const profile = await chrome.debugger.sendCommand({ tabId }, 'Profiler.stop');
          result = JSON.stringify(profile.profile);
          break;
        }

        case 'heap_snapshot': {
          const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
          const tabId = params.tabId || tab.id;
          await chrome.debugger.attach({ tabId }, '1.3').catch(() => {});
          
          await chrome.debugger.sendCommand({ tabId }, 'HeapProfiler.enable');
          
          if (!self._heapChunks) self._heapChunks = {};
          self._heapChunks[tabId] = [];
          
          const listener = (src, method, evtParams) => {
            if (src.tabId === tabId && method === 'HeapProfiler.addHeapSnapshotChunk') {
              self._heapChunks[tabId].push(evtParams.chunk);
            }
          };
          chrome.debugger.onEvent.addListener(listener);
          
          await chrome.debugger.sendCommand({ tabId }, 'HeapProfiler.takeHeapSnapshot', {
            reportProgress: false
          });
          
          chrome.debugger.onEvent.removeListener(listener);
          
          const snapshot = self._heapChunks[tabId].join('');
          delete self._heapChunks[tabId];
          
          result = snapshot;
          break;
        }

        case 'trace_start': {
          const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
          const tabId = params.tabId || tab.id;
          await chrome.debugger.attach({ tabId }, '1.3').catch(() => {});
          
          const categories = params.categories || [
            'devtools.timeline', 'v8.execute', 'disabled-by-default-devtools.timeline',
            'disabled-by-default-devtools.timeline.frame', 'toplevel', 'blink.console',
            'blink.user_timing', 'latencyInfo', 'disabled-by-default-v8.cpu_profiler'
          ];
          
          await chrome.debugger.sendCommand({ tabId }, 'Tracing.start', {
            categories: categories.join(','),
            options: 'sampling-frequency=10000'
          });
          
          if (!self._traceEvents) self._traceEvents = {};
          self._traceEvents[tabId] = [];
          
          result = 'Tracing started';
          break;
        }

        case 'trace_stop': {
          const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
          const tabId = params.tabId || tab.id;
          
          const listener = (src, method, evtParams) => {
            if (src.tabId === tabId && method === 'Tracing.dataCollected') {
              self._traceEvents[tabId].push(...evtParams.value);
            }
          };
          chrome.debugger.onEvent.addListener(listener);
          
          await chrome.debugger.sendCommand({ tabId }, 'Tracing.end');
          
          await new Promise(resolve => setTimeout(resolve, 1000));
          
          chrome.debugger.onEvent.removeListener(listener);
          
          const events = self._traceEvents[tabId] || [];
          delete self._traceEvents[tabId];
          
          result = JSON.stringify(events);
          break;
        }

        case 'pause_on_exception': {
          const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
          const tabId = params.tabId || tab.id;
          await chrome.debugger.attach({ tabId }, '1.3').catch(() => {});
          
          await chrome.debugger.sendCommand({ tabId }, 'Debugger.enable');
          await chrome.debugger.sendCommand({ tabId }, 'Debugger.setPauseOnExceptions', {
            state: params.state
          });
          
          result = `Pause on exception set to: ${params.state}`;
          break;
        }

        case 'debugger_resume': {
          const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
          const tabId = params.tabId || tab.id;
          
          await chrome.debugger.sendCommand({ tabId }, 'Debugger.resume');
          result = 'Debugger resumed';
          break;
        }

        case 'debugger_step_over': {
          const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
          const tabId = params.tabId || tab.id;
          
          await chrome.debugger.sendCommand({ tabId }, 'Debugger.stepOver');
          result = 'Stepped over';
          break;
        }

        case 'debugger_step_into': {
          const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
          const tabId = params.tabId || tab.id;
          
          await chrome.debugger.sendCommand({ tabId }, 'Debugger.stepInto');
          result = 'Stepped into';
          break;
        }

        case 'debugger_step_out': {
          const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
          const tabId = params.tabId || tab.id;
          
          await chrome.debugger.sendCommand({ tabId }, 'Debugger.stepOut');
          result = 'Stepped out';
          break;
        }

        case 'get_call_frames': {
          const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
          const tabId = params.tabId || tab.id;
          
          if (!self._pausedCallFrames || !self._pausedCallFrames[tabId]) {
            throw new Error('Debugger not paused');
          }
          
          result = JSON.stringify(self._pausedCallFrames[tabId]);
          break;
        }

        case 'evaluate_on_call_frame': {
          const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
          const tabId = params.tabId || tab.id;
          
          const evalResult = await chrome.debugger.sendCommand({ tabId }, 'Debugger.evaluateOnCallFrame', {
            callFrameId: params.callFrameId,
            expression: params.expression
          });
          
          result = JSON.stringify(evalResult.result);
          break;
        }

        case 'get_script_source': {
          const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
          const tabId = params.tabId || tab.id;
          
          const source = await chrome.debugger.sendCommand({ tabId }, 'Debugger.getScriptSource', {
            scriptId: params.scriptId
          });
          
          result = source.scriptSource;
          break;
        }

        case 'live_edit_script': {
          const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
          const tabId = params.tabId || tab.id;
          await chrome.debugger.attach({ tabId }, '1.3').catch(() => {});
          
          await chrome.debugger.sendCommand({ tabId }, 'Debugger.enable');
          const editResult = await chrome.debugger.sendCommand({ tabId }, 'Debugger.setScriptSource', {
            scriptId: params.scriptId,
            scriptSource: params.scriptSource
          });
          
          result = JSON.stringify(editResult);
          break;
        }

        case 'call_function_on': {
          const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
          const tabId = params.tabId || tab.id;
          
          const callResult = await chrome.debugger.sendCommand({ tabId }, 'Runtime.callFunctionOn', {
            objectId: params.objectId,
            functionDeclaration: params.functionDeclaration,
            arguments: params.arguments || []
          });
          
          result = JSON.stringify(callResult.result);
          break;
        }

        case 'get_properties': {
          const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
          const tabId = params.tabId || tab.id;
          
          const props = await chrome.debugger.sendCommand({ tabId }, 'Runtime.getProperties', {
            objectId: params.objectId,
            ownProperties: params.ownProperties !== false
          });
          
          result = JSON.stringify(props.result);
          break;
        }

        case 'compile_script': {
          const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
          const tabId = params.tabId || tab.id;
          await chrome.debugger.attach({ tabId }, '1.3').catch(() => {});
          
          await chrome.debugger.sendCommand({ tabId }, 'Runtime.enable');
          const compileResult = await chrome.debugger.sendCommand({ tabId }, 'Runtime.compileScript', {
            expression: params.expression,
            sourceURL: params.sourceURL || '',
            persistScript: false
          });
          
          if (compileResult.exceptionDetails) {
            result = JSON.stringify({ 
              valid: false, 
              error: compileResult.exceptionDetails 
            });
          } else {
            result = JSON.stringify({ 
              valid: true, 
              scriptId: compileResult.scriptId 
            });
          }
          break;
        }

        case 'get_indexeddb': {
          const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
          const tabId = params.tabId || tab.id;
          await chrome.debugger.attach({ tabId }, '1.3').catch(() => {});
          
          await chrome.debugger.sendCommand({ tabId }, 'IndexedDB.enable');
          
          const data = await chrome.debugger.sendCommand({ tabId }, 'IndexedDB.requestData', {
            securityOrigin: new URL((await chrome.tabs.get(tabId)).url).origin,
            databaseName: params.databaseName,
            objectStoreName: params.objectStoreName,
            indexName: '',
            skipCount: 0,
            pageSize: 100
          });
          
          result = JSON.stringify(data.objectStoreDataEntries);
          break;
        }

        case 'get_session_storage': {
          const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
          const tabId = params.tabId || tab.id;
          
          const [{ result: storage }] = await chrome.scripting.executeScript({
            target: { tabId },
            func: (key) => {
              if (key) return { [key]: sessionStorage.getItem(key) };
              const all = {};
              for (let i = 0; i < sessionStorage.length; i++) {
                const k = sessionStorage.key(i);
                all[k] = sessionStorage.getItem(k);
              }
              return all;
            },
            args: [params.key || null]
          });
          
          result = JSON.stringify(storage);
          break;
        }

        case 'get_cache_storage': {
          const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
          const tabId = params.tabId || tab.id;
          await chrome.debugger.attach({ tabId }, '1.3').catch(() => {});
          
          await chrome.debugger.sendCommand({ tabId }, 'CacheStorage.requestCacheNames', {
            securityOrigin: new URL((await chrome.tabs.get(tabId)).url).origin
          });
          
          const entries = await chrome.debugger.sendCommand({ tabId }, 'CacheStorage.requestEntries', {
            cacheId: params.cacheName,
            skipCount: 0,
            pageSize: 100
          });
          
          result = JSON.stringify(entries.cacheDataEntries);
          break;
        }

        case 'get_security_state': {
          const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
          const tabId = params.tabId || tab.id;
          await chrome.debugger.attach({ tabId }, '1.3').catch(() => {});
          
          await chrome.debugger.sendCommand({ tabId }, 'Security.enable');
          
          if (!self._securityState) self._securityState = {};
          
          const listener = (src, method, evtParams) => {
            if (src.tabId === tabId && method === 'Security.securityStateChanged') {
              self._securityState[tabId] = evtParams;
            }
          };
          chrome.debugger.onEvent.addListener(listener);
          
          await new Promise(resolve => setTimeout(resolve, 500));
          
          chrome.debugger.onEvent.removeListener(listener);
          
          result = JSON.stringify(self._securityState[tabId] || {});
          break;
        }

        case 'ignore_cert_errors': {
          const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
          const tabId = params.tabId || tab.id;
          await chrome.debugger.attach({ tabId }, '1.3').catch(() => {});
          
          await chrome.debugger.sendCommand({ tabId }, 'Security.setIgnoreCertificateErrors', {
            ignore: params.ignore
          });
          
          result = `Certificate errors ${params.ignore ? 'ignored' : 'restored'}`;
          break;
        }

        case 'set_color_scheme': {
          const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
          const tabId = params.tabId || tab.id;
          await chrome.debugger.attach({ tabId }, '1.3').catch(() => {});
          
          await chrome.debugger.sendCommand({ tabId }, 'Emulation.setEmulatedMedia', {
            features: [{ name: 'prefers-color-scheme', value: params.scheme }]
          });
          
          result = `Color scheme set to ${params.scheme}`;
          break;
        }

        case 'highlight_element': {
          const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
          const tabId = params.tabId || tab.id;
          await chrome.debugger.attach({ tabId }, '1.3').catch(() => {});
          
          const dom = await chrome.debugger.sendCommand({ tabId }, 'DOM.getDocument', {});
          const node = await chrome.debugger.sendCommand({ tabId }, 'DOM.querySelector', {
            nodeId: dom.root.nodeId,
            selector: params.selector
          });
          
          await chrome.debugger.sendCommand({ tabId }, 'DOM.highlightNode', {
            nodeId: node.nodeId,
            highlightConfig: {
              contentColor: { r: 255, g: 0, b: 0, a: 0.3 },
              borderColor: { r: 255, g: 0, b: 0, a: 1 }
            }
          });
          
          result = `Element highlighted: ${params.selector}`;
          break;
        }

        case 'hide_element': {
          const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
          const tabId = params.tabId || tab.id;
          
          await chrome.scripting.executeScript({
            target: { tabId },
            func: (selector, hide) => {
              const el = document.querySelector(selector);
              if (!el) throw new Error(`Element not found: ${selector}`);
              el.style.display = hide ? 'none' : '';
              return hide ? 'hidden' : 'shown';
            },
            args: [params.selector, params.hide]
          });
          
          result = `Element ${params.hide ? 'hidden' : 'shown'}: ${params.selector}`;
          break;
        }

        case 'dom_set_attribute': {
          const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
          const tabId = params.tabId || tab.id;
          await chrome.debugger.attach({ tabId }, '1.3').catch(() => {});
          
          const dom = await chrome.debugger.sendCommand({ tabId }, 'DOM.getDocument', {});
          const node = await chrome.debugger.sendCommand({ tabId }, 'DOM.querySelector', {
            nodeId: dom.root.nodeId,
            selector: params.selector
          });
          
          await chrome.debugger.sendCommand({ tabId }, 'DOM.setAttributeValue', {
            nodeId: node.nodeId,
            name: params.name,
            value: params.value
          });
          
          result = `Attribute set: ${params.name}="${params.value}" on ${params.selector}`;
          break;
        }

        case 'dom_remove_node': {
          const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
          const tabId = params.tabId || tab.id;
          await chrome.debugger.attach({ tabId }, '1.3').catch(() => {});
          
          const dom = await chrome.debugger.sendCommand({ tabId }, 'DOM.getDocument', {});
          const node = await chrome.debugger.sendCommand({ tabId }, 'DOM.querySelector', {
            nodeId: dom.root.nodeId,
            selector: params.selector
          });
          
          await chrome.debugger.sendCommand({ tabId }, 'DOM.removeNode', {
            nodeId: node.nodeId
          });
          
          result = `Node removed: ${params.selector}`;
          break;
        }

        default:
          throw new Error(`Unknown method: ${method}`);
      }

      socket.send(JSON.stringify({ id, result }));

    } catch (error) {
      console.error('Command error:', error);
      socket.send(JSON.stringify({ id, error: error.message }));
    }
  };

  socket.onopen = () => {
    console.log('Connected to server');
    isConnected = true;
    // Send ping every 20s to keep the WebSocket alive on both ends
    clearInterval(pingTimer);
    pingTimer = setInterval(() => {
      if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: 'ping' }));
      }
    }, 20000);
  };
  socket.onclose = () => {
    console.log('Socket closed' + (isEnabled ? ', retrying in 3s...' : ', not retrying (disabled).'));
    isConnected = false;
    clearInterval(pingTimer);
    if (isEnabled) {
      reconnectTimer = setTimeout(connect, 3000);
    }
  };
  socket.onerror = (err) => {
    console.error('Socket error:', err);
    isConnected = false;
    clearInterval(pingTimer);
    // onclose will fire after onerror, so reconnect is handled there
  };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'RECONNECT') {
    isEnabled = true;
    currentEndpoint = message.endpoint;
    connect();
  }
  if (message.type === 'DISCONNECT') {
    isEnabled = false;
    clearTimeout(reconnectTimer);
    clearInterval(pingTimer);
    if (socket) {
      socket.onclose = null;
      socket.onerror = null;
      try { socket.close(); } catch(e) {}
      socket = null;
    }
    isConnected = false;
  }
  if (message.type === 'GET_STATUS') {
    sendResponse({ connected: isConnected });
  }
  return true;
});