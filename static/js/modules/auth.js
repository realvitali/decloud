// ===== Module: auth =====
// Passcode login screen logic — checks auth on load, shows login if needed.

let _loginPin = '';
let _loginBusy = false;
const _LOGIN_PIN_MAX = 10;  // keypad supports 6–10 digits; longer passcodes via UI only

// Check auth on page load — show login screen or main app
(async function checkAuthOnLoad() {
  try {
    const r = await fetch('/api/auth/check');
    const d = await r.json();
    if (d.authenticated) {
      // Already authenticated — stash the CSRF token for state-changing calls
      if (d.csrf) sessionStorage.setItem('decloud_csrf', d.csrf);
      hideLoginScreen();
    } else {
      // Need to log in
      showLoginScreen();
    }
  } catch (e) {
    // If auth check fails (network error, etc.), assume not authenticated
    // but only show login if we get a clear 401
    console.warn('Auth check failed:', e);
  }
})();

function showLoginScreen() {
  const login = document.getElementById('login-screen');
  if (login) login.style.display = 'flex';
  // Hide all app screens
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  renderLoginDots();
}

function hideLoginScreen() {
  const login = document.getElementById('login-screen');
  if (login) login.style.display = 'none';
  // Show home screen
  const home = document.getElementById('home-screen');
  if (home) home.classList.add('active');
}

function renderLoginDots() {
  const dots = document.getElementById('login-dots');
  if (!dots) return;
  dots.innerHTML = '';
  for (let i = 0; i < Math.max(_loginPin.length, 1); i++) {
    const span = document.createElement('span');
    span.className = 'login-dot' + (i < _loginPin.length ? ' filled' : '');
    dots.appendChild(span);
  }
}

function loginPress(key) {
  if (_loginBusy) return;
  if (_loginPin.length >= _LOGIN_PIN_MAX) return;
  _loginPin += key;
  renderLoginDots();
  // Clear any previous error
  const err = document.getElementById('login-error');
  if (err) err.classList.remove('show');
}

function loginGo() {
  if (_loginBusy) return;
  if (_loginPin.length < 6) {
    loginFail('Passcode is at least 6 digits');
    return;
  }
  submitLogin();
}

function loginBack() {
  if (_loginBusy) return;
  if (_loginPin.length > 0) {
    _loginPin = _loginPin.slice(0, -1);
    renderLoginDots();
    const err = document.getElementById('login-error');
    if (err) err.classList.remove('show');
  }
}

async function submitLogin() {
  _loginBusy = true;
  const err = document.getElementById('login-error');
  try {
    const r = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pin: _loginPin }),
    });
    const d = await r.json();
    if (r.ok && d.ok) {
      // Store the session token (not the PIN) for the cross-origin Bearer
      // fallback and the CSRF token for state-changing requests.
      // The PIN must never live in browser storage.
      if (d.session) {
        sessionStorage.setItem('decloud_session', d.session);
      }
      if (d.csrf) {
        sessionStorage.setItem('decloud_csrf', d.csrf);
      }
      // Success — reload to get the main app with auth cookie set
      window.location.reload();
      return;
    }
    // Failed — show error and shake
    loginFail(d.error || 'Invalid passcode');
  } catch (e) {
    loginFail('Network error — try again');
  }
}

function loginFail(msg) {
  _loginBusy = false;
  _loginPin = '';
  renderLoginDots();
  const err = document.getElementById('login-error');
  if (err) {
    err.textContent = msg;
    err.classList.add('show');
  }
  // Shake the card
  const card = document.querySelector('.login-card');
  if (card) {
    card.classList.remove('shake');
    void card.offsetWidth; // trigger reflow to restart animation
    card.classList.add('shake');
  }
  // Haptic feedback
  if (navigator.vibrate) navigator.vibrate(100);
}

async function logout() {
  try {
    await fetch('/api/auth/logout', { method: 'POST' });
  } catch (e) {
    console.warn('Logout request failed:', e);
  }
  sessionStorage.removeItem('decloud_session');
  sessionStorage.removeItem('decloud_csrf');
  window.location.reload();
}

// Expose for inline onclick handlers
window.logout = logout;
window.loginPress = loginPress;
window.loginBack = loginBack;
window.loginGo = loginGo;
