// ===== Module: universe =====
let universeNodes = [];
let universeEdges = [];
let universeCanvas = null;
let universeCtx = null;
let universeAnim = null;

async function loadUniverse() {
  try {
    const resp = await fetch('/api/universe/data');
    const data = await resp.json();
    if (data.error) {
      showUniverseEmpty();
      return;
    }
    universeNodes = data.nodes || [];
    universeEdges = data.edges || [];
    if (universeNodes.length === 0) {
      showUniverseEmpty();
      return;
    }
    drawUniverse();
  } catch (e) {
    console.error('Universe load error:', e);
    showUniverseEmpty();
  }
}

function showUniverseEmpty() {
  const canvas = document.getElementById('universe-canvas');
  if (canvas) {
    const parent = canvas.parentElement;
    // Remove any previous empty state so re-loads never stack duplicates
    parent.querySelectorAll('.empty-state').forEach(el => el.remove());
    canvas.style.display = 'none';
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.innerHTML = `
      <div class="empty-icon">🌌</div>
      <h3>Your Universe is empty</h3>
      <p>Universe maps people and entities from your files into an interactive knowledge graph.</p>
      <p class="empty-hint">Set DECLOUD_OSINT_DIR in .env to point to your data folder</p>
      <p class="empty-hint">Then add files with names, emails, or org info to scan</p>
    `;
    parent.appendChild(empty);
  }
}

function drawUniverse() {
  const canvas = document.getElementById('universe-canvas');
  if (!canvas) return;
  // Clear any lingering empty state and bring the canvas back
  canvas.parentElement.querySelectorAll('.empty-state').forEach(el => el.remove());
  canvas.style.display = '';
  const ctx = canvas.getContext('2d');
  universeCanvas = canvas;
  universeCtx = ctx;

  // Responsive canvas
  const rect = canvas.parentElement.getBoundingClientRect();
  canvas.width = rect.width;
  canvas.height = Math.min(500, rect.width * 0.7);
  const w = canvas.width;
  const h = canvas.height;

  // Position nodes in a circle layout
  const cx = w / 2;
  const cy = h / 2;
  const maxRadius = Math.min(w, h) * 0.38;

  universeNodes.forEach((node, i) => {
    const angle = (i / universeNodes.length) * Math.PI * 2 - Math.PI / 2;
    const r = maxRadius * (0.5 + 0.5 * Math.random());
    node.x = cx + Math.cos(angle) * r;
    node.y = cy + Math.sin(angle) * r;
    node.vx = 0;
    node.vy = 0;
  });

  // Simple force simulation
  function step() {
    ctx.clearRect(0, 0, w, h);

    // Repulsion between nodes (stronger to prevent overlap)
    for (let i = 0; i < universeNodes.length; i++) {
      for (let j = i + 1; j < universeNodes.length; j++) {
        const a = universeNodes[i];
        const b = universeNodes[j];
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const dist = Math.sqrt(dx * dx + dy * dy) || 1;
        // Minimum distance based on both bubble sizes
        const minDist = Math.max(22, (a.bubble_size || 5) * 0.5) + Math.max(22, (b.bubble_size || 5) * 0.5) + 8;
        if (dist < minDist) {
          // Hard push apart when overlapping
          const force = (minDist - dist) * 0.5;
          const fx = (dx / dist) * force;
          const fy = (dy / dist) * force;
          a.vx -= fx;
          a.vy -= fy;
          b.vx += fx;
          b.vy += fy;
        }
        // Normal repulsion
        const force = 2500 / (dist * dist);
        const fx = (dx / dist) * force;
        const fy = (dy / dist) * force;
        a.vx -= fx;
        a.vy -= fy;
        b.vx += fx;
        b.vy += fy;
      }
    }

    // Attraction along edges
    universeEdges.forEach(edge => {
      const a = universeNodes.find(n => n.name === edge.source);
      const b = universeNodes.find(n => n.name === edge.target);
      if (!a || !b) return;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const dist = Math.sqrt(dx * dx + dy * dy) || 1;
      const force = (dist - 120) * 0.01;
      const fx = (dx / dist) * force;
      const fy = (dy / dist) * force;
      a.vx += fx;
      a.vy += fy;
      b.vx -= fx;
      b.vy -= fy;
    });

    // Center gravity
    universeNodes.forEach(n => {
      n.vx += (cx - n.x) * 0.002;
      n.vy += (cy - n.y) * 0.002;
      n.vx *= 0.85;
      n.vy *= 0.85;
      n.x += n.vx;
      n.y += n.vy;
    });

    // Draw edges
    universeEdges.forEach(edge => {
      const a = universeNodes.find(n => n.name === edge.source);
      const b = universeNodes.find(n => n.name === edge.target);
      if (!a || !b) return;
      ctx.strokeStyle = 'rgba(129, 140, 248, 0.2)';
      ctx.lineWidth = Math.min(2, edge.weight * 0.5);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    });

    // Draw nodes
    universeNodes.forEach(node => {
      // Bigger bubbles, min 22px so names fit inside
      const size = Math.max(22, (node.bubble_size || 5) * 0.5);
      const days = node.days_since_mention || 999;
      const opacity = Math.max(0.25, 1 - days / 60);

      // Color by category
      const colors = {
        'client': '#22c55e', 'client/potential': '#fbbf24',
        'friend/referral': '#818cf8', 'family': '#ec4899',
        'personal': '#06b6d4', 'finaldoor/member': '#a855f7',
        'contact': '#6b7280', 'unknown': '#6b7280',
      };
      const color = colors[node.category] || '#6b7280';

      // Glow
      ctx.beginPath();
      ctx.arc(node.x, node.y, size + 4, 0, Math.PI * 2);
      ctx.fillStyle = color + '20';
      ctx.fill();

      // Bubble
      ctx.beginPath();
      ctx.arc(node.x, node.y, size, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.globalAlpha = opacity;
      ctx.fill();
      ctx.globalAlpha = 1;

      // Fizzle warning ring
      if (days > 14) {
        ctx.strokeStyle = '#ef444460';
        ctx.lineWidth = 1.5;
        ctx.setLineDash([3, 3]);
        ctx.beginPath();
        ctx.arc(node.x, node.y, size + 3, 0, Math.PI * 2);
        ctx.stroke();
        ctx.setLineDash([]);
      }

      // Name inside the bubble (truncate if too long)
      const maxLen = size < 30 ? 4 : (size < 45 ? 8 : 12);
      let label = node.name;
      if (label.length > maxLen) {
        label = label.substring(0, maxLen - 1) + '...';
      }
      ctx.fillStyle = 'rgba(255,255,255,0.95)';
      ctx.font = size > 35 ? 'bold 11px system-ui' : (size > 25 ? 'bold 9px system-ui' : 'bold 8px system-ui');
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(label, node.x, node.y);

      // Days since mention (below bubble)
      if (days < 999 && days > 0) {
        ctx.fillStyle = days > 14 ? '#ef444499' : '#6b728099';
        ctx.font = '7px system-ui';
        ctx.textBaseline = 'top';
        ctx.fillText(`${days}d`, node.x, node.y + size + 3);
      }
    });

    universeAnim = requestAnimationFrame(step);
  }

  step();
}

async function rescanUniverse() {
  try {
    await fetch('/api/universe/scan', { method: 'POST' });
    await loadUniverse();
  } catch (e) {
    console.error('Rescan error:', e);
  }
}

async function addUniversePerson() {
  const input = document.getElementById('universe-add-name');
  const name = input.value.trim();
  if (!name) return;
  try {
    const resp = await fetch('/api/universe/add', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    const data = await resp.json();
    if (data.ok) {
      input.value = '';
      await loadUniverse();
    } else {
      alert(data.error || 'Failed to add');
    }
  } catch (e) {
    alert('Error: ' + e.message);
  }
}

// ─── System Monitor ──────────────────────────────────────
