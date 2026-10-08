// ===== Module: system — neofetch-style panel =====
// Big OS logo (inline SVG, colorized per distro), spec lines, live gauges.
// Fits one phone screen; expands gracefully on desktop.

// ── OS logo registry (compact SVG shapes on a 48x48 viewBox) ──
const OS_LOGOS = {
  ubuntu: { color: '#e95420', svg: '<circle cx="24" cy="24" r="20" fill="currentColor"/><circle cx="24" cy="10" r="4" fill="#fff"/><circle cx="12.5" cy="31" r="4" fill="#fff"/><circle cx="35.5" cy="31" r="4" fill="#fff"/>' },
  debian: { color: '#d70a53', svg: '<path fill="currentColor" d="M24 4c9 5 14 12 13 22-1 9-7 16-14 17C13 42 7 34 8 25 9 14 15 8 24 4z"/><path fill="#fff" opacity=".9" d="M22 14c-3 4-5 9-4 15 1 4 3 7 6 8-4-1-7-5-8-9-1-6 2-11 6-14z"/>' },
  fedora: { color: '#294172', svg: '<path fill="currentColor" d="M24 3C12 3 3 12 3 24s9 21 21 21 21-9 21-21S36 3 24 3z"/><path fill="#fff" d="M14 26c6-1 9-4 10-10 1 6 4 9 10 10-6 1-9 4-10 10-1-6-4-9-10-10z"/>' },
  arch: { color: '#1793d1', svg: '<path fill="currentColor" d="M24 4l13 32c-4-2-6-3-9-3-1-4-2-6-4-8-2 2-3 4-4 8-3 0-5 1-9 3L24 4z"/>' },
  mint: { color: '#87cf3e', svg: '<path fill="currentColor" d="M12 8h8v18c0 3 2 5 5 5h4V8h8v20c0 7-5 12-12 12h-1c-7 0-12-5-12-12V8z"/>' },
  manjaro: { color: '#35bf5c', svg: '<path fill="currentColor" d="M6 6h10v26h6V16h6v16h6V6h10v36H6z"/>' },
  pop: { color: '#48b9c7', svg: '<circle cx="24" cy="24" r="20" fill="currentColor"/><path fill="#fff" d="M17 16h5l7 16h-5l-7-16zm7 0h5l-3 7-3-7z"/>' },
  raspbian: { color: '#c51a4a', svg: '<circle cx="24" cy="24" r="20" fill="currentColor"/><path fill="#3f7f3f" d="M16 30c2 4 6 6 8 6s6-2 8-6c-2 2-5 3-8 3s-6-1-8-3z"/>' },
  windows: { color: '#0078d4', svg: '<path fill="currentColor" d="M5 9l15-2v14H5V9zm0 29l15 2V23H5v15zm17 2l17 3V23H22v17zm0-32v15h17V6l-17 2z"/>' },
  darwin: { color: '#a3a3a3', svg: '<path fill="currentColor" d="M31 12c-2 1-4 1-6 0-3-1-6 0-8 2-4 4-4 12 0 18 2 3 4 5 6 5 2-1 4-1 6 0 2 1 4-1 6-4 1-2 2-3 2-4-3-2-4-5-3-8 1-2 2-4 4-5-2-3-4-4-7-4zm-4-6c1-2 3-4 5-4 1 3-1 6-5 6 0-1 0-2 0-2z" transform="scale(.9) translate(3,1)"/>' },
};

function osLogoKey(os, kernel) {
  const s = (os + ' ' + (kernel || '')).toLowerCase();
  if (/raspbian|raspberry/.test(s)) return 'raspbian';
  if (/ubuntu/.test(s)) return 'ubuntu';
  if (/debian/.test(s)) return 'debian';
  if (/fedora/.test(s)) return 'fedora';
  if (/arch|cachyos|endeavour/.test(s)) return 'arch';
  if (/mint/.test(s)) return 'mint';
  if (/manjaro/.test(s)) return 'manjaro';
  if (/pop/.test(s)) return 'pop';
  if (/windows/.test(s)) return 'windows';
  if (/darwin|macos|mac os/.test(s)) return 'darwin';
  return 'arch';
}

function fmtSpeed(bps) {
  if (bps > 1e6) return (bps / 1e6).toFixed(1) + ' MB/s';
  if (bps > 1e3) return (bps / 1e3).toFixed(0) + ' KB/s';
  return bps + ' B/s';
}

function nfBar(pct, color) {
  const p = Math.max(0, Math.min(100, pct));
  return `<div class="nf-bar"><div class="nf-bar-fill" style="width:${p}%;background:${color}"></div></div>`;
}

async function loadSystem() {
  try {
    const [r, nr] = await Promise.all([
      fetch('/api/system'),
      fetch('/api/network/stats').catch(() => null),
    ]);
    const d = await r.json();
    if (d.error) throw new Error(d.error);
    const net = nr && nr.ok ? await nr.json() : null;

    const logoKey = osLogoKey(d.os, d.os_kernel);
    const logo = OS_LOGOS[logoKey];
    const osShort = (d.os || 'Unknown').replace(/ GNU\/Linux$/, '');
    const cpuShort = (d.cpu_name || '').replace(/\(R\)|\(TM\)|Processor/g, '').replace(/\s+/g, ' ').trim();

    const spec = (k, v, mono) => v ? `<div class="nf-row"><span class="nf-k">${k}</span><span class="nf-v${mono ? ' nf-mono' : ''}">${v}</span></div>` : '';

    document.getElementById('system-content').innerHTML = `
      <div class="nf-card">
        <div class="nf-head">
          <svg class="nf-logo" viewBox="0 0 48 48" style="color:${logo.color}" aria-hidden="true">${logo.svg}</svg>
          <div class="nf-id">
            <div class="nf-host">${d.hostname}</div>
            <div class="nf-os">${osShort}${d.arch ? ' · ' + d.arch : ''}</div>
          </div>
        </div>
        <div class="nf-specs">
          ${spec('OS', osShort)}
          ${spec('Kernel', d.os_kernel, true)}
          ${spec('CPU', cpuShort ? `${cpuShort} (${d.cpu_cores}T)` : d.cpu_cores + ' cores', true)}
          ${d.gpu_name ? spec('GPU', d.gpu_name, true) : ''}
          ${spec('Memory', `${(d.ram_used / 1073741824).toFixed(1)} / ${d.ram_total_gb || '—'} GB (${d.ram_percent}%)`, true)}
          ${d.swap_percent > 0 ? spec('Swap', d.swap_percent + '%') : ''}
          ${spec('Disk', `${d.disk_total_gb || '—'} GB (${d.disk_percent}%)`, true)}
          ${spec('Uptime', d.uptime, true)}
          ${(d.temps && Object.keys(d.temps).length) ? spec('Temp', Object.values(d.temps).flat().slice(0, 2).map(s => `${s.current}°C`).join(' / '), true) : ''}
          ${d.battery ? spec('Battery', d.battery.percent + '%' + (d.battery.plugged ? ' ⚡' : '')) : ''}
          ${net ? spec('Net', `↓ ${fmtSpeed(net.download_speed)}  ↑ ${fmtSpeed(net.upload_speed)}`, true) : ''}
        </div>
        <div class="nf-gauges">
          <div class="nf-gauge"><span>CPU ${d.cpu_percent}%</span>${nfBar(d.cpu_percent, d.cpu_percent > 80 ? 'var(--red)' : 'var(--green)')}</div>
          <div class="nf-gauge"><span>RAM ${d.ram_percent}%</span>${nfBar(d.ram_percent, d.ram_percent > 80 ? 'var(--red)' : '#6366f1')}</div>
          <div class="nf-gauge"><span>DISK ${d.disk_percent}%</span>${nfBar(d.disk_percent, d.disk_percent > 80 ? 'var(--red)' : 'var(--orange)')}</div>
        </div>
      </div>`;

    // Live network refresh while the panel is visible (single cheap call / 4s)
    if (net && !loadSystem._netTimer) {
      loadSystem._netTimer = setInterval(async () => {
        const card = document.querySelector('#system-content .nf-card');
        if (!card) { clearInterval(loadSystem._netTimer); loadSystem._netTimer = null; return; }
        try {
          const n = await (await fetch('/api/network/stats')).json();
          card.querySelectorAll('.nf-row').forEach((row) => {
            if (row.querySelector('.nf-k')?.textContent === 'Net')
              row.querySelector('.nf-v').textContent = `↓ ${fmtSpeed(n.download_speed)}  ↑ ${fmtSpeed(n.upload_speed)}`;
          });
        } catch {}
      }, 4000);
    }
  } catch {
    document.getElementById('system-content').innerHTML = '<p style="color:var(--red)">Failed to load system info.</p>';
  }
}

// ─── Ollama Chat ─────────────────────────────────────────
