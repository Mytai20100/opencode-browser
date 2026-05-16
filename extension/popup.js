// Load saved endpoint
chrome.storage.local.get(['endpoint', 'enabled'], (result) => {
  if (result.endpoint) {
    document.getElementById('endpoint').value = result.endpoint;
    document.getElementById('ws-url').textContent = result.endpoint;
  }
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
    if (!toggle.checked) return; // don't update if manually disconnected
    if (response && response.connected) {
      dot.classList.add('connected');
      text.textContent = 'Connected';
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
  chrome.storage.local.set({ enabled });
  if (enabled) {
    chrome.runtime.sendMessage({ type: 'RECONNECT', endpoint });
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
  document.getElementById('ws-url').textContent = endpoint;
  chrome.storage.local.set({ endpoint }, () => {
    const toggle = document.getElementById('connect-toggle');
    if (toggle.checked) {
      chrome.runtime.sendMessage({ type: 'RECONNECT', endpoint });
    }
  });
});

// Poll status every 2s
updateStatus();
setInterval(updateStatus, 2000);
