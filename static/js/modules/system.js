// ===== Module: system =====
function fmtBytes(n) {
  if (n == null) return 'N/A';
  const g = 1024 * 1024 * 1024;
  if (n >= g) return (n / g).toFixed(1) + ' GB';
  return (n / (1024 * 1024)).toFixed(0) + ' MB';
}

async function loadSystem() {
  try {
    const r = await fetch('/api/system');
    const d = await r.json();
    const temps = d.temps && Object.keys(d.temps).length > 0
      ? Object.entries(d.temps).map(([k,v]) => v.map(s => `${s.label||k}: ${s.current}°C`).join('<br>')).join('')
      : 'N/A';
    const specs = [
      ['OS', d.os || 'N/A'],
      ['Kernel', d.os_kernel || 'N/A'],
      ['CPU', d.cpu_model || 'N/A'],
      ['Cores', d.cpu_cores != null ? d.cpu_cores : 'N/A'],
      ['GPU', d.gpu || 'N/A'],
      ['RAM', d.ram_total ? fmtBytes(d.ram_total) : 'N/A'],
      ['Disk', d.disk_total ? fmtBytes(d.disk_total) : 'N/A'],
      ['Host', d.hostname || 'N/A'],
    ];
    const specRows = specs.map(([k, v]) =>
      `<div class="spec-row"><span class="spec-key">${k}</span><span class="spec-val">${v}</span></div>`
    ).join('');
    document.getElementById('system-content').innerHTML = `
      <div class="spec-tile">
        <div class="spec-tile-head">System Specs</div>
        <div class="spec-tile-body">${specRows}</div>
      </div>
      <div class="stat-card"><div class="stat-label">CPU</div><div class="stat-value">${d.cpu_percent}%</div>
        <div class="stat-bar"><div class="stat-bar-fill" style="width:${d.cpu_percent}%;background:${d.cpu_percent>80?'var(--red)':'var(--green)'}"></div></div></div>
      <div class="stat-card"><div class="stat-label">Memory</div><div class="stat-value">${d.ram_percent}%</div>
        <div class="stat-bar"><div class="stat-bar-fill" style="width:${d.ram_percent}%;background:${d.ram_percent>80?'var(--red)':'var(--accent)'}"></div></div></div>
      <div class="stat-card"><div class="stat-label">Disk</div><div class="stat-value">${d.disk_percent}%</div>
        <div class="stat-bar"><div class="stat-bar-fill" style="width:${d.disk_percent}%;background:${d.disk_percent>80?'var(--red)':'var(--orange)'}"></div></div></div>
      <div class="stat-card"><div class="stat-label">Uptime</div><div class="stat-value" style="font-size:20px">${d.uptime}</div>
        <div style="font-size:13px;color:var(--text-dim);margin-top:4px">${d.hostname}</div></div>
      <div class="stat-card"><div class="stat-label">Temps</div><div style="font-size:15px;line-height:1.8">${temps}</div></div>
    `;
  } catch { document.getElementById('system-content').innerHTML = '<p style="color:var(--red)">Failed to load system info.</p>'; }
}

// ─── Ollama Chat ─────────────────────────────────────────
