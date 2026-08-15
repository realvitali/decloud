// ===== Module: desktop =====
var isDesktop = false;
var desktopFocusIdx = 0;

function detectDesktop() {
  isDesktop = window.matchMedia("(pointer: fine)").matches && window.innerWidth >= 900;
  document.body.classList.toggle("desktop-mode", isDesktop);
  if (isDesktop) {
    desktopFocusIdx = 0;
    updateDesktopFocus();
  }
}

function updateDesktopFocus() {
  if (!isDesktop) return;
  var icons = document.querySelectorAll(".app-icon");
  icons.forEach(function(el, i) {
    el.classList.toggle("desktop-focus", i === desktopFocusIdx);
  });
}

function desktopNavigate(dx, dy) {
  if (!isDesktop) return;
  var icons = document.querySelectorAll(".app-icon");
  var n = icons.length;
  var cols = 4;
  if (window.innerWidth >= 1200) cols = 6;
  else if (window.innerWidth >= 900) cols = 5;
  var row = Math.floor(desktopFocusIdx / cols);
  var col = desktopFocusIdx % cols;
  if (dx !== 0) {
    col = (col + dx + cols) % cols;
    var newIdx = row * cols + col;
    if (newIdx >= n) newIdx = col;
    desktopFocusIdx = Math.min(newIdx, n - 1);
  }
  if (dy !== 0) {
    var newRow = row + dy;
    var newIdx2 = newRow * cols + col;
    if (newIdx2 >= n) newIdx2 = desktopFocusIdx;
    if (newRow < 0) newIdx2 = desktopFocusIdx;
    desktopFocusIdx = Math.max(0, Math.min(newIdx2, n - 1));
  }
  updateDesktopFocus();
}

document.addEventListener("keydown", function(e) {
  if (!isDesktop) return;
  var tag = (e.target.tagName || "").toLowerCase();
  if (tag === "input" || tag === "textarea") return;
  var termActive = document.getElementById("terminal-screen") && document.getElementById("terminal-screen").classList.contains("active");
  if (termActive) return;

  var homeActive = document.getElementById("home-screen") && document.getElementById("home-screen").classList.contains("active");
  if (!homeActive) {
    if (e.key === "Escape") { goHome(); e.preventDefault(); }
    return;
  }

  switch(e.key) {
    case "ArrowLeft": desktopNavigate(-1, 0); e.preventDefault(); break;
    case "ArrowRight": desktopNavigate(1, 0); e.preventDefault(); break;
    case "ArrowUp": desktopNavigate(0, -1); e.preventDefault(); break;
    case "ArrowDown": desktopNavigate(0, 1); e.preventDefault(); break;
    case "Enter":
      var icons = document.querySelectorAll(".app-icon");
      var app = icons[desktopFocusIdx];
      if (app) {
        var appId = app.dataset.appId;
        if (appId) openApp(appId);
      }
      e.preventDefault();
      break;
    case "Escape": goHome(); e.preventDefault(); break;
  }
});

window.addEventListener("resize", detectDesktop);
detectDesktop();

// ─── Music Player ───────────────────────────────────────
