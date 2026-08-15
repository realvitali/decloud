// ===== Module: projects =====
// ─── Projects: Home Cards + Detail ────────────────────────
const projectCache = {};  // id -> { github, vercel, ts }

function buildProjectsSection() {
  const container = document.getElementById('projects-list');
  if (!container) return;
  if (PROJECTS.length === 0) {
    container.innerHTML = `
      <div class="empty-state projects-empty">
        <div class="empty-icon">🗂️</div>
        <h3>No projects yet</h3>
        <p>Projects gives you live cards for your repos — commits, PRs, issues, deploys.</p>
        <p class="empty-hint">Add a project in static/js/modules/core.js (PROJECTS array)</p>
        <p class="empty-hint">Needs the gh CLI authenticated for GitHub data</p>
      </div>`;
    const divider = document.getElementById('projects-divider');
    if (divider) divider.style.display = '';
    return;
  }
  container.innerHTML = PROJECTS.map(p => {
    const stackBadges = p.stack.slice(0, 4).map(s => `<span class="tech-badge">${s}</span>`).join('');
    const extraCount = p.stack.length > 4 ? `<span class="tech-badge">+${p.stack.length - 4}</span>` : '';
    return `
      <div class="project-card" onclick="openProject('${p.id}')">
        <div class="project-card-header">
          <div class="project-card-icon" style="color:${p.color};background:${hexToRgba(p.color, 0.1)}">${ICONS.layers}</div>
          <div class="project-card-title">
            <div class="project-card-name">${p.name}</div>
            <a class="project-card-domain" href="https://${p.domain}" target="_blank" onclick="event.stopPropagation()">${p.domain}</a>
          </div>
          <div class="project-card-status loading" id="pcard-status-${p.id}">${ICONS.refresh}</div>
        </div>
        <div class="project-card-stack">${stackBadges}${extraCount}</div>
        <div class="project-card-footer" id="pcard-footer-${p.id}">
          ${ICONS.clock}<span class="project-card-commit-msg">Loading...</span>
        </div>
      </div>
    `;
  }).join('');
}

function hexToRgba(hex, alpha) {
  const h = hex.replace('#', '');
  const r = parseInt(h.substring(0, 2), 16);
  const g = parseInt(h.substring(2, 4), 16);
  const b = parseInt(h.substring(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

async function refreshProjectCards() {
  for (const p of PROJECTS) {
    try {
      const [gh, vercel] = await Promise.allSettled([
        fetch(`/api/projects/${p.id}/github`).then(r => r.json()),
        fetch(`/api/projects/${p.id}/vercel`).then(r => r.json()),
      ]);
      const ghData = gh.status === 'fulfilled' ? gh.value : null;
      const vercelData = vercel.status === 'fulfilled' ? vercel.value : null;
      projectCache[p.id] = { github: ghData, vercel: vercelData, ts: Date.now() };
      updateProjectCard(p.id, ghData, vercelData);
    } catch (e) {
      console.error('project refresh failed', p.id, e);
    }
  }
}

function updateProjectCard(id, gh, vercel) {
  const statusEl = document.getElementById(`pcard-status-${id}`);
  const footerEl = document.getElementById(`pcard-footer-${id}`);
  if (!statusEl || !footerEl) return;

  // Deploy status badge
  let statusHtml = '';
  if (vercel && vercel.status === 'ready') {
    statusHtml = `<span class="project-card-status deployed">${ICONS.check} Live</span>`;
  } else if (vercel && vercel.status === 'error') {
    statusHtml = `<span class="project-card-status pending">${ICONS.alert} Error</span>`;
  } else if (vercel && vercel.authed === false) {
    // Vercel not connected — show deploy unknown but don't error
    statusHtml = `<span class="project-card-status deployed">${ICONS.check} Deployed</span>`;
  } else {
    statusHtml = `<span class="project-card-status deployed">${ICONS.check} Deployed</span>`;
  }
  statusEl.outerHTML = statusHtml;

  // Latest commit footer
  if (gh && gh.commits && gh.commits.length > 0) {
    const c = gh.commits[0];
    const time = c.date ? relTime(c.date) : '';
    footerEl.innerHTML = `${ICONS.gitCommit}<span class="project-card-commit-msg">${escapeHtml(c.message)}</span><span style="color:var(--text-faint);flex-shrink:0">${time}</span>`;
  } else if (gh && gh.error) {
    footerEl.innerHTML = `${ICONS.alert}<span class="project-card-commit-msg">GitHub: ${escapeHtml(gh.error)}</span>`;
  } else {
    footerEl.innerHTML = `${ICONS.clock}<span class="project-card-commit-msg">No commits</span>`;
  }
}

function escapeHtml(s) {
  if (!s) return '';
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function openProject(id) {
  const p = PROJECTS.find(x => x.id === id);
  if (!p) return;
  location.hash = `#project/${id}`;
  renderProjectDetail(p);
  showScreen('project-screen');
}

// When Projects icon tapped (no specific project) — show first project or a list
function openProjectList() {
  if (PROJECTS.length === 1) {
    openProject(PROJECTS[0].id);
  } else {
    // Render a chooser on the project screen
    const c = document.getElementById('project-detail-content');
    c.innerHTML = `<div class="project-section-title">Select a project</div>` +
      PROJECTS.map(p => `
        <div class="project-card" onclick="openProject('${p.id}')">
          <div class="project-card-header">
            <div class="project-card-icon" style="color:${p.color};background:${hexToRgba(p.color, 0.1)}">${ICONS.layers}</div>
            <div class="project-card-title">
              <div class="project-card-name">${p.name}</div>
              <span class="project-card-domain" style="cursor:pointer">${p.domain}</span>
            </div>
          </div>
          <div class="project-card-stack">${p.stack.slice(0, 4).map(s => `<span class="tech-badge">${s}</span>`).join('')}</div>
        </div>
      `).join('');
    showScreen('project-screen');
  }
}

async function renderProjectDetail(p) {
  const titleEl = document.getElementById('screen-title-project');
  if (titleEl) {
    titleEl.innerHTML = `<span class="screen-title-icon">${ICONS.layers}</span> ${escapeHtml(p.name)}`;
  }
  const c = document.getElementById('project-detail-content');
  const stackBadges = p.stack.map(s => `<span class="tech-badge">${s}</span>`).join('');

  c.innerHTML = `
    <div class="project-detail-header">
      <div class="project-detail-title-row">
        <div class="project-detail-icon" style="color:${p.color};background:${hexToRgba(p.color, 0.1)}">${ICONS.layers}</div>
        <div>
          <div class="project-detail-name">${escapeHtml(p.name)}</div>
          ${p.label ? `<div style="font-size:12px;color:var(--text-dim);margin-bottom:2px">${escapeHtml(p.label)}</div>` : ''}
          <a class="project-detail-domain" href="https://${p.domain}" target="_blank">${p.domain}</a>
        </div>
      </div>
      <div class="project-detail-stats">
        <div class="project-stat"><div class="project-stat-num" id="pstat-commits">--</div><div class="project-stat-label">Commits</div></div>
        <div class="project-stat"><div class="project-stat-num" id="pstat-prs">--</div><div class="project-stat-label">Open PRs</div></div>
        <div class="project-stat"><div class="project-stat-num" id="pstat-issues">--</div><div class="project-stat-label">Issues</div></div>
      </div>
      <div class="project-card-stack">${stackBadges}</div>
      <div class="project-detail-links">
        <a class="project-link-btn" href="https://github.com/${p.repo}" target="_blank">${ICONS.gitHub} GitHub</a>
        <a class="project-link-btn" href="https://${p.domain}" target="_blank">${ICONS.server} Live Site</a>
      </div>
    </div>
    <div class="project-section-title">Recent Commits</div>
    <div class="project-card-body" id="project-commits"><div class="project-loading">Loading commits...</div></div>
  `;

  // Fetch live data
  loadProjectDetail(p);
}

async function loadProjectDetail(p) {
  try {
    const res = await fetch(`/api/projects/${p.id}/github`);
    const data = await res.json();
    if (data.error) {
      document.getElementById('project-commits').innerHTML = `<div class="project-empty">${escapeHtml(data.error)}</div>`;
      return;
    }

    // Stats
    const commitsEl = document.getElementById('pstat-commits');
    const prsEl = document.getElementById('pstat-prs');
    const issuesEl = document.getElementById('pstat-issues');
    if (commitsEl) commitsEl.textContent = data.commit_count ?? (data.commits ? data.commits.length : '--');
    if (prsEl) prsEl.textContent = data.open_prs !== undefined ? data.open_prs : '--';
    if (issuesEl) issuesEl.textContent = data.open_issues !== undefined ? data.open_issues : '--';

    // Commits list
    const commitsEl2 = document.getElementById('project-commits');
    if (commitsEl2) {
      if (data.commits && data.commits.length > 0) {
        commitsEl2.innerHTML = data.commits.slice(0, 10).map(c => {
          const avatar = c.author_avatar
            ? `<img class="commit-avatar" src="${escapeHtml(c.author_avatar)}" alt="" width="24" height="24">`
            : `<div class="commit-avatar"></div>`;
          return `
            <div class="commit-row">
              ${avatar}
              <div class="commit-body">
                <div class="commit-msg">${escapeHtml(c.message)}</div>
                <div class="commit-meta">
                  <span class="commit-author">${escapeHtml(c.author || '')}</span>
                  <span>${c.date ? relTime(c.date) : ''}</span>
                  ${c.sha ? `<span style="color:var(--text-faint);font-family:monospace">${c.sha.substring(0,7)}</span>` : ''}
                </div>
              </div>
            </div>
          `;
        }).join('');
      } else {
        commitsEl2.innerHTML = `<div class="project-empty">No commits found</div>`;
      }
    }
  } catch (e) {
    const el = document.getElementById('project-commits');
    if (el) el.innerHTML = `<div class="project-empty">Failed to load GitHub data</div>`;
  }
}

