// /kill-cache: drop the service worker and caches, then go home. A file, not inline (CSP).
(async function(){
  var s = document.getElementById('status');
  try {
    if ('serviceWorker' in navigator) {
      var regs = await navigator.serviceWorker.getRegistrations();
      for (var r of regs) { await r.unregister(); }
      s.textContent += ' Unregistered ' + regs.length + ' service worker(s).';
    }
    if ('caches' in window) {
      var keys = await caches.keys();
      for (var k of keys) { await caches.delete(k); }
      s.textContent += ' Deleted ' + keys.length + ' cache(s).';
    }
    s.textContent += ' Redirecting...';
    setTimeout(function(){ window.location.href = '/'; }, 1500);
  } catch(e) {
    s.textContent = 'Error: ' + e.message + ' — try force-closing the app and reopening.';
  }
})();
