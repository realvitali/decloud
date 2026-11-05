// ===== Module: onboarding =====
// First-run walkthrough for new DeCloud users.
// Shows on first open (localStorage 'decloud_onboarded'), walks through
// phone install, and app configuration. Started only after sign-in.

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
  // Prefill the device name with the current value (if already set).
  fetch('/api/lab/prefs').then(function(r) { return r.json(); }).then(function(p) {
    var input = document.getElementById('device-name-input');
    if (input && p && p.device_name) input.value = p.device_name;
  }).catch(function() {});
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

// Skip the "open on your phone" step when already on a phone.
var ONBOARDING_PHONE_STEP = 3;
function onboardingOnPhone() {
  return window.matchMedia && window.matchMedia('(pointer: coarse) and (max-width: 820px)').matches;
}

function onboardingNext() {
  if (onboardingCurrentStep >= ONBOARDING_STEPS - 1) {
    onboardingFinish();
    return;
  }
  var next = onboardingCurrentStep + 1;
  if (next === ONBOARDING_PHONE_STEP && onboardingOnPhone()) next++;
  showOnboardingStep(next);
}

function onboardingPrev() {
  if (onboardingCurrentStep > 0) {
    var prev = onboardingCurrentStep - 1;
    if (prev === ONBOARDING_PHONE_STEP && onboardingOnPhone()) prev--;
    showOnboardingStep(prev);
  }
}

function onboardingSkip() {
  finishOnboarding(true);
}

function onboardingFinish() {
  finishOnboarding(false);
}

function finishOnboarding(skipped) {
  // Persist the lab name and this device's name (empty = keep defaults).
  var labInput = document.getElementById('lab-name-input');
  var devInput = document.getElementById('device-name-input');
  var prefs = {};
  if (labInput && labInput.value.trim()) prefs.name = labInput.value.trim();
  if (devInput && devInput.value.trim()) prefs.device_name = devInput.value.trim();
  if (Object.keys(prefs).length) {
    fetch('/api/lab/prefs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(prefs)
    }).then(function(r) {
      if (!r.ok) throw new Error('save failed');
      if (typeof refreshDeviceTitle === 'function') refreshDeviceTitle();
    }).catch(function() {
      showToast("Couldn't save the names — try again later");
    });
  }
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
 * Phone QR for the onboarding step. Rendered client-side so the address
 * never leaves the browser. A localhost address is useless on a phone, so
 * in that case we point at `./decloud qr` instead.
 */
function generateOnboardingQRs() {
  var phoneContainer = document.getElementById('qr-phone');
  var hint = document.getElementById('onboarding-url-hint');
  var host = window.location.hostname;
  var isLocal = host === 'localhost' || host === '::1' || host === '[::1]' || /^127\./.test(host);
  if (isLocal) {
    if (hint) hint.textContent = 'On your computer, run ./decloud qr to get a code your phone can scan.';
    return;
  }
  if (phoneContainer && !phoneContainer.hasChildNodes()) {
    var img = generateQR(window.location.origin, 300);
    if (img) phoneContainer.appendChild(img);
  }
  if (hint) hint.textContent = window.location.origin;
}

/** Client-side QR as a data-URL <img>; null if the lib failed to load. */
function generateQR(text, size) {
  if (typeof qrcode !== 'function') return null;
  var s = size || 200;
  var qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  var img = document.createElement('img');
  img.src = qr.createDataURL(Math.max(2, Math.floor(s / (qr.getModuleCount() + 8))), 4);
  img.width = s;
  img.height = s;
  img.style.imageRendering = 'pixelated';
  img.alt = 'QR: ' + text;
  return img;
}

// Boot: started by hideLoginScreen() (auth.js) after a successful sign-in.
