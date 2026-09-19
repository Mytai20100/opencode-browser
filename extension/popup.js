// Load saved endpoint
chrome.storage.local.get(['endpoint', 'enabled', 'label', 'clientId'], (result) => {
  let endpoint = result.endpoint || 'ws://127.0.0.1:3002';
  if (endpoint.includes('localhost')) {
    endpoint = endpoint.replace('localhost', '127.0.0.1');
    chrome.storage.local.set({ endpoint });
  }
  document.getElementById('endpoint').value = endpoint;
  document.getElementById('ws-url').textContent = endpoint;
  if (result.label) document.getElementById('label').value = result.label;
  if (result.clientId) document.getElementById('client-id').textContent = result.clientId.slice(0, 8);
  // Restore toggle state
  const enabled = result.enabled !== false; // default ON
  document.getElementById('connect-toggle').checked = enabled;
  updateToggleUI(enabled);
});

function updateToggleUI(enabled) {
  const dot = document.getElementById('status-dot');
  const text = document.getElementById('status-text');
  const label = document.getElementById('toggle-label');
  label.textContent = enabled ? 'ON' : 'OFF';
  if (!enabled) {
    dot.classList.remove('connected');
    text.textContent = 'Disconnected';
    text.classList.remove('connected');
  }
}

function updateStatus() {
  chrome.runtime.sendMessage({ type: 'GET_STATUS' }, (response) => {
    const dot = document.getElementById('status-dot');
    const text = document.getElementById('status-text');
    const toggle = document.getElementById('connect-toggle');
    if (response && response.clientId) {
      document.getElementById('client-id').textContent = response.clientId.slice(0, 8);
    }
    if (!toggle.checked) return; // don't update if manually disconnected
    if (response && response.connected) {
      dot.classList.add('connected');
      text.textContent = 'Connected' + (response.label ? ` (${response.label})` : '');
      text.classList.add('connected');
    } else {
      dot.classList.remove('connected');
      text.textContent = 'Connecting...';
      text.classList.remove('connected');
    }
  });
}

// Toggle switch: connect / disconnect
document.getElementById('connect-toggle').addEventListener('change', (e) => {
  const enabled = e.target.checked;
  updateToggleUI(enabled);
  const endpoint = document.getElementById('endpoint').value;
  const label = document.getElementById('label').value.trim();
  chrome.storage.local.set({ enabled, label });
  if (enabled) {
    chrome.runtime.sendMessage({ type: 'RECONNECT', endpoint, label });
  } else {
    chrome.runtime.sendMessage({ type: 'DISCONNECT' });
    const dot = document.getElementById('status-dot');
    const text = document.getElementById('status-text');
    dot.classList.remove('connected');
    text.textContent = 'Disconnected';
    text.classList.remove('connected');
  }
});

// Save endpoint button
document.getElementById('save-btn').addEventListener('click', () => {
  const endpoint = document.getElementById('endpoint').value;
  const label = document.getElementById('label').value.trim();
  document.getElementById('ws-url').textContent = endpoint;
  chrome.storage.local.set({ endpoint, label }, () => {
    const toggle = document.getElementById('connect-toggle');
    if (toggle.checked) {
      chrome.runtime.sendMessage({ type: 'RECONNECT', endpoint, label });
    }
  });
});

// Poll status every 2s
updateStatus();
setInterval(updateStatus, 2000);
