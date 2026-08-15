/**
 * Settings App Module
 * Manages theme, devices, telemetry, logs
 */

const SettingsApp = {
  init() {
    // Called once at startup if needed
  },
  
  load() {
    console.log('📋 Loading Settings...');
    this.loadTheme();
    this.loadDevices();
    this.loadTelemetry();
    this.loadLogs();
  },
  
  unload() {
    // Cleanup if needed
  },
  
  loadTheme() {
    const theme = localStorage.getItem('decloud-theme') || 'auto';
    const radios = document.querySelectorAll('input[name="theme"]');
    radios.forEach(r => r.checked = r.value === theme);
  },
  
  setTheme(mode) {
    localStorage.setItem('decloud-theme', mode);
    document.documentElement.setAttribute('data-theme', mode === 'auto' ? '' : mode);
    fetch('/api/settings/theme', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ theme: mode })
    }).catch(e => console.warn('Theme save failed:', e));
  },
  
  switchTab(tabId) {
    document.querySelectorAll('.settings-tab-content').forEach(el => el.classList.remove('active'));
    document.querySelectorAll('.settings-tab').forEach(el => el.classList.remove('active'));
    
    const content = document.getElementById(`settings-${tabId}`);
    const tab = document.querySelector(`[data-tab="${tabId}"]`);
    
    if (content) content.classList.add('active');
    if (tab) tab.classList.add('active');
  },
  
  async loadDevices() {
    try {
      const res = await fetch('/api/devices');
      const devices = await res.json();
      const list = document.getElementById('devices-list');
      if (list) {
        list.innerHTML = devices.map(d => `
          <div class="device-item">
            <div class="device-name">${d.name || d.ip}</div>
            <div class="device-meta">Last seen: ${d.last_seen} | IP: ${d.ip}</div>
          </div>
        `).join('') || '<div class="device-item">No devices yet</div>';
      }
    } catch (e) {
      console.warn('Devices load failed:', e);
    }
  },
  
  async loadTelemetry() {
    try {
      const res = await fetch('/api/telemetry/app-usage');
      const data = await res.json();
      const stats = document.getElementById('usage-stats');
      if (stats && data.per_app) {
        const sorted = Object.entries(data.per_app).sort((a, b) => b[1].opens - a[1].opens);
        stats.innerHTML = sorted.map(([name, info]) => `
          <div class="usage-item">
            <div class="usage-item-name">${name}</div>
            <div class="usage-item-stats">${info.opens} opens · ${Math.round(info.total_time / 60)}m</div>
          </div>
        `).join('') || '<div class="usage-item">No usage data</div>';
      }
    } catch (e) {
      console.warn('Telemetry load failed:', e);
    }
  },
  
  async loadLogs() {
    try {
      const res = await fetch('/api/logs?limit=20');
      const logs = await res.json();
      const list = document.getElementById('logs-list');
      if (list) {
        list.innerHTML = logs.map(l => `
          <div class="log-item ${l.level || 'info'}">
            [${l.timestamp}] ${l.message}
          </div>
        `).join('') || '<div class="log-item">No logs</div>';
      }
    } catch (e) {
      console.warn('Logs load failed:', e);
    }
  },
  
  exportTelemetry() {
    window.location = '/api/telemetry/export';
  },
  
  exportLogs() {
    window.location = '/api/logs/export';
  }
};

// Auto-register when loaded
appRegistry.register('settings', SettingsApp);
console.log('✓ Settings module loaded');
