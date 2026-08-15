// ===== Module: osint =====
async function loadOsintProfiles() {
  try {
    const r = await fetch('/api/osint/profiles');
    const profiles = await r.json();
    const container = document.getElementById('osint-profiles-list');
    if (!profiles.length) {
      container.innerHTML = '<div class="osint-empty">No profiles yet. Add one above.</div>';
      return;
    }
    container.innerHTML = profiles.map(p => `
      <div class="osint-profile-card" data-id="${p.id}" onclick="toggleOsintCard('${p.id}')">
        <div class="osint-profile-header">
          <div class="osint-profile-name">${escapeHtml(p.name)}</div>
          <div class="osint-profile-chevron">&#9662;</div>
        </div>
        <div class="osint-profile-info">
          ${p.data.email ? `<span>${escapeHtml(p.data.email)}</span>` : ''}
          ${p.data.phone ? `<span>${escapeHtml(p.data.phone)}</span>` : ''}
          ${p.data.usernames?.length ? `<span>${escapeHtml(p.data.usernames.join(', '))}</span>` : ''}
        </div>
        <div class="osint-profile-expanded" id="expand-${p.id}" style="display:none">
          <div class="osint-profile-actions">
            <button onclick="event.stopPropagation();osintRunScan('${p.id}')" class="osint-scan-btn">Scan</button>
            <button onclick="event.stopPropagation();osintRunScan('${p.id}', true)" class="osint-scan-btn deep">Deep Scan</button>
            <button onclick="event.stopPropagation();osintLoadScans('${p.id}')" class="osint-scan-btn">History</button>
            <button onclick="event.stopPropagation();osintDeleteProfile('${p.id}')" class="osint-scan-btn delete">Delete</button>
          </div>
          <div class="osint-profile-scans" id="scans-${p.id}"></div>
        </div>
      </div>
    `).join('');
  } catch (e) {
    console.error('OSINT profiles error:', e);
  }
}

async function osintCreateProfile() {
  const name = document.getElementById('osint-name').value.trim();
  if (!name) return;
  const usernames = document.getElementById('osint-usernames').value.trim()
    .split(',').map(s => s.trim()).filter(Boolean);
  const info = {
    full_name: name,
    email: document.getElementById('osint-email').value.trim(),
    phone: document.getElementById('osint-phone').value.trim(),
    address: document.getElementById('osint-address').value.trim(),
    usernames,
  };
  try {
    await fetch('/api/osint/profiles', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, info }),
    });
    document.getElementById('osint-name').value = '';
    document.getElementById('osint-email').value = '';
    document.getElementById('osint-phone').value = '';
    document.getElementById('osint-address').value = '';
    document.getElementById('osint-usernames').value = '';
    loadOsintProfiles();
  } catch (e) {
    console.error('Create profile error:', e);
  }
}

// Track running scans
let osintActiveScans = {};  // profileId -> {status, startedAt, progress, eta}

function toggleOsintCard(id) {
  const el = document.getElementById('expand-' + id);
  if (el) el.style.display = el.style.display === 'none' ? 'block' : 'none';
}

async function osintDeleteProfile(id) {
  if (!confirm('Delete this profile?')) return;
  try {
    await fetch(`/api/osint/profiles/${id}`, { method: 'DELETE' });
    loadOsintProfiles();
  } catch (e) {
    alert('Delete failed: ' + e.message);
  }
}

// Show scan modal
function openScanModal() {
  document.getElementById('osint-scan-modal').style.display = 'flex';
}

function closeScanModal(event) {
  if (event && event.target !== document.getElementById('osint-scan-modal')) return;
  document.getElementById('osint-scan-modal').style.display = 'none';
}

function formatEta(seconds) {
  if (seconds < 60) return Math.round(seconds) + 's';
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return m + 'm ' + s + 's';
}

function updateScanModal() {
  const container = document.getElementById('osint-scan-modal-body');
  const active = Object.entries(osintActiveScans);
  
  if (!active.length) {
    container.innerHTML = '<div class="osint-empty">No active scans</div>';
    return;
  }

  let html = '';
  for (const [pid, scan] of active) {
    const elapsed = (Date.now() - scan.startedAt) / 1000;
    let statusText = '';
    let progressBar = '';
    
    if (scan.status === 'done') {
      statusText = `Done — ${scan.exposures || 0} exposures`;
      progressBar = `<div class="osint-progress-bar"><div class="osint-progress-fill" style="width:100%;background:#22c55e"></div></div>`;
    } else if (scan.status === 'error') {
      statusText = `Error: ${scan.error || 'failed'}`;
      progressBar = `<div class="osint-progress-bar"><div class="osint-progress-fill" style="width:100%;background:#ef4444"></div></div>`;
    } else if (scan.status === 'scanning') {
      const elapsedShow = formatEta(elapsed);
      // ETA estimate: ~20s per site, ~15 sites for standard, ~22 for deep
      const totalTime = scan.deep ? 330 : 300;
      const remaining = Math.max(0, totalTime - elapsed);
      const pct = Math.min(95, (elapsed / totalTime) * 100);
      statusText = `Scanning... ${elapsedShow} elapsed, ~${formatEta(remaining)} remaining`;
      progressBar = `<div class="osint-progress-bar"><div class="osint-progress-fill" style="width:${pct}%"></div></div>`;
    } else {
      statusText = scan.status || 'Starting...';
      progressBar = `<div class="osint-progress-bar"><div class="osint-progress-fill" style="width:5%"></div></div>`;
    }

    html += `
      <div class="osint-scan-task">
        <div class="osint-scan-task-header">
          <span class="osint-scan-task-name">${escapeHtml(scan.name)}</span>
          <span class="osint-scan-task-status">${statusText}</span>
        </div>
        ${progressBar}
        ${scan.status === 'done' ? `<button class="osint-scan-view-btn" onclick="osintViewResults('${pid}')">View Results</button>` : ''}
      </div>
    `;
  }
  container.innerHTML = html;
}

let osintPollInterval = null;

function startScanPolling() {
  if (osintPollInterval) return;
  osintPollInterval = setInterval(updateScanModal, 1000);
}

function stopScanPolling() {
  if (osintPollInterval) {
    clearInterval(osintPollInterval);
    osintPollInterval = null;
  }
}

async function osintRunScan(profileId, deep = false) {
  // Get profile name
  const profile = osintActiveScans[profileId];
  let profileName = profileId;
  try {
    const r = await fetch(`/api/osint/profiles/${profileId}`);
    const p = await r.json();
    profileName = p.name || profileId;
  } catch (e) {}

  // Mark as scanning
  osintActiveScans[profileId] = {
    status: 'scanning',
    startedAt: Date.now(),
    name: profileName,
    deep: deep,
    exposures: 0,
  };
  openScanModal();
  updateScanModal();
  startScanPolling();

  try {
    const r = await fetch('/api/osint/scan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profile_id: profileId, deep }),
    });
    const data = await r.json();

    if (data.error) {
      osintActiveScans[profileId].status = 'error';
      osintActiveScans[profileId].error = data.error;
    } else {
      osintActiveScans[profileId].status = 'done';
      osintActiveScans[profileId].exposures = data.results?.summary?.total_results || 0;
      osintActiveScans[profileId].results = data.results;
    }
    updateScanModal();
    
    // Stop polling if all scans are done
    const allDone = Object.values(osintActiveScans).every(s => s.status === 'done' || s.status === 'error');
    if (allDone) stopScanPolling();
  } catch (e) {
    osintActiveScans[profileId].status = 'error';
    osintActiveScans[profileId].error = e.message;
    updateScanModal();
  }
}

function osintViewResults(profileId) {
  const scan = osintActiveScans[profileId];
  if (!scan || !scan.results) return;

  const s = scan.results.summary;
  let html = `
    <div class="osint-summary-grid">
      <div class="osint-stat"><span class="osint-stat-num">${s.total_results || 0}</span><span class="osint-stat-label">Total Results</span></div>
      <div class="osint-stat"><span class="osint-stat-num" style="color:#ef4444">${s.high_confidence || 0}</span><span class="osint-stat-label">High Confidence</span></div>
      <div class="osint-stat"><span class="osint-stat-num" style="color:#fbbf24">${s.medium_confidence || 0}</span><span class="osint-stat-label">Medium</span></div>
      <div class="osint-stat"><span class="osint-stat-num" style="color:#6b7280">${s.low_confidence || 0}</span><span class="osint-stat-label">Low</span></div>
      <div class="osint-stat"><span class="osint-stat-num" style="color:#22c55e">${s.opt_outs_available || 0}</span><span class="osint-stat-label">Opt-Outs</span></div>
    </div>
  `;

  // Findings with confidence scores and clickable links
  const findings = scan.results.findings || [];
  if (findings.length) {
    html += '<div class="osint-result-section"><h4>Findings</h4>';
    findings.forEach(f => {
      const confColor = f.confidence >= 70 ? '#ef4444' : f.confidence >= 40 ? '#fbbf24' : f.confidence >= 20 ? '#6b7280' : '#374151';
      const confBg = f.confidence >= 70 ? 'rgba(239,68,68,0.15)' : f.confidence >= 40 ? 'rgba(251,191,36,0.15)' : 'rgba(107,114,128,0.15)';
      html += `<div class="osint-finding-row">
        <div class="osint-finding-header">
          <span class="osint-confidence-badge" style="background:${confBg};color:${confColor}">${f.confidence_label} ${f.confidence}</span>
          <span class="osint-finding-source">${escapeHtml(f.source)}</span>
        </div>
        <a href="${escapeHtml(f.url)}" target="_blank" class="osint-finding-link">${escapeHtml(f.title || f.url)}</a>
        ${f.snippet ? `<div class="osint-finding-snippet">${escapeHtml(f.snippet)}</div>` : ''}
        ${f.opt_out && f.confidence >= 40 ? `<a href="${escapeHtml(f.opt_out)}" target="_blank" class="osint-optout">Opt Out</a>` : ''}
      </div>`;
    });
    html += '</div>';
  }

  // Manual opt-out list (deep scan)
  if (scan.results.manual_opt_outs?.length) {
    html += '<div class="osint-result-section"><h4>Manual Opt-Outs Needed</h4>';
    scan.results.manual_opt_outs.forEach(m => {
      html += `<div class="osint-broker-row">
        <span class="osint-broker-name">${escapeHtml(m.name)}</span>
        <span class="osint-badge" style="background:rgba(251,191,36,0.15);color:#fbbf24">${escapeHtml(m.difficulty)}</span>
        <a href="${escapeHtml(m.url)}" target="_blank" class="osint-optout">Opt Out</a>
      </div>`;
    });
    html += '</div>';
  }

  document.getElementById('osint-scan-modal-body').innerHTML = html;
}

async function osintLoadScans(profileId) {
  try {
    const r = await fetch(`/api/osint/scans?profile_id=${profileId}`);
    const scans = await r.json();
    const results = document.getElementById('osint-results');
    if (!scans.length) {
      results.innerHTML = '<div class="osint-empty">No scans yet.</div>';
      return;
    }
    results.innerHTML = scans.map(s => `
      <div class="osint-scan-row" onclick="osintLoadScan('${s.scan_id}')">
        <span>${s.timestamp}</span>
        <span>${s.deep ? 'DEEP' : 'standard'}</span>
        <span class="osint-badge ${s.total_exposures > 0 ? 'found' : 'safe'}">${s.total_exposures} exposures</span>
      </div>
    `).join('');
  } catch (e) {
    console.error('Load scans error:', e);
  }
}

async function osintLoadScan(scanId) {
  try {
    const r = await fetch(`/api/osint/scans/${scanId}`);
    const data = await r.json();
    const s = data.results.summary;
    document.getElementById('osint-scan-summary').innerHTML = `
      <div class="osint-summary-grid">
        <div class="osint-stat"><span class="osint-stat-num">${s.total_exposures}</span><span class="osint-stat-label">Total Exposures</span></div>
        <div class="osint-stat"><span class="osint-stat-num">${s.sites_found_on}</span><span class="osint-stat-label">Sites Found On</span></div>
        <div class="osint-stat"><span class="osint-stat-num">${s.opt_out_needed}</span><span class="osint-stat-label">Opt-Outs Needed</span></div>
      </div>
    `;
    document.getElementById('osint-results').innerHTML = '<div class="osint-empty">Loaded scan from ' + data.timestamp + '</div>';
  } catch (e) {
    console.error('Load scan error:', e);
  }
}

// ─── Universe (People Graph) ──────────────────────────

