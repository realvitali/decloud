// ===== Module: onboarding =====
// First-run walkthrough for new DeCloud users.
// Shows on first open (localStorage 'decloud_onboarded'), walks through
// Tailscale setup, phone PWA install, and app configuration.

var ONBOARDING_STEPS = 5; // 0=welcome, 1=features, 2=security, 3=phone, 4=done
var onboardingCurrentStep = 0;

function initOnboarding() {
  var overlay = document.getElementById('onboarding-overlay');
  if (!overlay) return;
  // Only show if not yet onboarded
  if (localStorage.getItem('decloud_onboarded') === '1') {
    overlay.style.display = 'none';
    return;
  }
  // Show the overlay
  overlay.style.display = 'flex';
  onboardingCurrentStep = 0;
  buildProgressDots();
  generateOnboardingQRs();
  showOnboardingStep(0);
}

function buildProgressDots() {
  var bar = document.getElementById('onboarding-progress');
  if (!bar) return;
  bar.innerHTML = '';
  for (var i = 0; i < ONBOARDING_STEPS; i++) {
    var dot = document.createElement('div');
    dot.className = 'onboarding-progress-dot';
    bar.appendChild(dot);
  }
}

function showOnboardingStep(step) {
  onboardingCurrentStep = step;
  // Show/hide step divs
  var steps = document.querySelectorAll('.onboarding-step');
  steps.forEach(function(s) { s.classList.remove('active'); });
  var target = document.querySelector('.onboarding-step[data-step="' + step + '"]');
  if (target) target.classList.add('active');

  // Update progress dots
  var dots = document.querySelectorAll('.onboarding-progress-dot');
  dots.forEach(function(d, i) {
    d.classList.remove('completed', 'active');
    if (i < step) d.classList.add('completed');
    else if (i === step) d.classList.add('active');
  });

  // Update nav buttons
  var nextBtn = document.getElementById('onboarding-next');
  var prevBtn = document.getElementById('onboarding-prev');
  var skipBtn = document.getElementById('onboarding-skip');

  // Next button text: 0="Get Started", 1-3="Next", 4="Finish"
  var labels = ['Get Started', 'Next', 'Next', 'Next', 'Finish'];
  if (nextBtn) nextBtn.textContent = labels[step] || 'Next';

  // Back button: show on step > 0
  if (prevBtn) prevBtn.style.display = step > 0 ? '' : 'none';

  // Skip button: hide on last step
  if (skipBtn) skipBtn.style.display = step < ONBOARDING_STEPS - 1 ? '' : 'none';
}

function onboardingNext() {
  if (onboardingCurrentStep >= ONBOARDING_STEPS - 1) {
    onboardingFinish();
    return;
  }
  showOnboardingStep(onboardingCurrentStep + 1);
}

function onboardingPrev() {
  if (onboardingCurrentStep > 0) {
    showOnboardingStep(onboardingCurrentStep - 1);
  }
}

function onboardingSkip() {
  finishOnboarding(true);
}

function onboardingFinish() {
  finishOnboarding(false);
}

function finishOnboarding(skipped) {
  localStorage.setItem('decloud_onboarded', '1');
  var overlay = document.getElementById('onboarding-overlay');
  if (overlay) {
    overlay.style.display = 'none';
  }
}

/**
 * Re-open the onboarding flow (called from Settings).
 * Clears the flag and re-initializes.
 */
function reopenOnboarding() {
  localStorage.removeItem('decloud_onboarded');
  // If currently in settings, go home first
  if (typeof goHome === 'function') {
    goHome();
  }
  initOnboarding();
}

/**
 * Generate QR codes for the onboarding steps.
 * Uses api.qrserver.com as a simple img-based QR (one-time flow, no deps).
 */
function generateOnboardingQRs() {
  // Tailscale download QR
  var tailscaleContainer = document.getElementById('qr-tailscale');
  if (tailscaleContainer && !tailscaleContainer.hasChildNodes()) {
    var url1 = 'https://tailscale.com/download';
    var img1 = document.createElement('img');
    img1.src = 'https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=' + encodeURIComponent(url1);
    img1.alt = 'QR: ' + url1;
    img1.loading = 'lazy';
    tailscaleContainer.appendChild(img1);
  }

  // Phone PWA QR — current origin
  var phoneContainer = document.getElementById('qr-phone');
  if (phoneContainer && !phoneContainer.hasChildNodes()) {
    var pageUrl = window.location.origin;
    var img2 = document.createElement('img');
    img2.src = 'https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=' + encodeURIComponent(pageUrl);
    img2.alt = 'QR: ' + pageUrl;
    img2.loading = 'lazy';
    phoneContainer.appendChild(img2);
  }

  // Show the URL hint
  var hint = document.getElementById('onboarding-url-hint');
  if (hint) {
    hint.textContent = window.location.origin;
  }
}

/**
 * Generic QR generator (kept for API compatibility / future use).
 * Currently uses api.qrserver.com img fallback.
 */
function generateQR(text, size) {
  var s = size || 200;
  var img = document.createElement('img');
  img.src = 'https://api.qrserver.com/v1/create-qr-code/?size=' + s + 'x' + s + '&data=' + encodeURIComponent(text);
  img.width = s;
  img.height = s;
  img.alt = 'QR code';
  return img;
}

// ─── Boot ───────────────────────────────────────────────
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initOnboarding);
} else {
  initOnboarding();
}
