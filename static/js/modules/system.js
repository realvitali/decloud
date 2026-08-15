// ===== Module: system =====
async function loadSystem() {
  try {
    const r = await fetch('/api/system');
    const d = await r.json();
    const temps = d.temps && Object.keys(d.temps).length > 0
      ? Object.entries(d.temps).map(([k,v]) => v.map(s => `${s.label||k}: ${s.current}°C`).join('<br>')).join('')
      : 'N/A';
    document.getElementById('system-content').innerHTML = `
      <div class="stat-card"><div class="stat-label">CPU</div><div class="stat-value">${d.cpu_percent}%</div>
        <div class="stat-bar"><div class="stat-bar-fill" style="width:${d.cpu_percent}%;background:${d.cpu_percent>80?'var(--red)':'var(--green)'}"></div></div></div>
      <div class="stat-card"><div class="stat-label">Memory</div><div class="stat-value">${d.ram_percent}%</div>
        <div class="stat-bar"><div class="stat-bar-fill" style="width:${d.ram_percent}%;background:${d.ram_percent>80?'var(--red)':'var(--accent)'}"></div></div></div>
      <div class="stat-card"><div class="stat-label">Disk</div><div class="stat-value">${d.disk_percent}%</div>
        <div class="stat-bar"><div class="stat-bar-fill" style="width:${d.disk_percent}%;background:${d.disk_percent>80?'var(--red)':'var(--orange)'}"></div></div></div>
      <div class="stat-card"><div class="stat-label">Host</div><div class="stat-value" style="font-size:20px">${d.hostname}</div>
        <div style="font-size:13px;color:var(--text-dim);margin-top:4px">Uptime: ${d.uptime}</div></div>
      <div class="stat-card"><div class="stat-label">Temps</div><div style="font-size:15px;line-height:1.8">${temps}</div></div>
    `;
  } catch { document.getElementById('system-content').innerHTML = '<p style="color:var(--red)">Failed to load system info.</p>'; }
}

// ─── Ollama Chat ─────────────────────────────────────────
