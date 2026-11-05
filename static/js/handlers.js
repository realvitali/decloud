// ===== handlers.js — the page's former inline event handlers =====
// The Content-Security-Policy forbids inline script (onclick="…"), so markup says
// data-onclick="<key>" and the code lives here. Add new ones the same way:
// a short unique key in the markup, and its function below. `this` is the element.
const PAGE_HANDLERS = {
  cb7a51e3: function (event) { saveSongMeta(+this.closest('.song-edit').dataset.idx, true); },  // click
  cb7a51e1: function (event) { toggleMusicSearch(true); },  // click
  cb7a51e2: function (event) { toggleMusicSearch(false); },  // click
  c0445bf6: function (event) { runCmd('ls -la'); },  // click
  c0579e50: function (event) { showChatHistory(); },  // click
  c060108d: function (event) { modelsCancel(this.dataset.id); },  // click
  c07d541f: function (event) { previewVoice(); },  // click
  c088daee: function (event) { runCmd('nvidia-smi'); },  // click
  c09d44e8: function (event) { toggleBookmarkList(); },  // click
  c0aef1a9: function (event) { musicGenGenerate(); },  // click
  c0d860ba: function (event) { switchSettingsTab('st-tab-voice'); },  // click
  c0e71525: function (event) { labRemove(this.dataset.id, this.dataset.name); },  // click
  c0f5182d: function (event) { event.stopPropagation();osintLoadScans(this.dataset.id); },  // click
  c0fb260d: function (event) { togglePlay(); },  // click
  c1213646: function (event) { seekMusic(event); },  // click
  c125c21e: function (event) { loginGo(); },  // click
  c138aa96: function (event) { musicGenDelete(this.dataset.id); },  // click
  c158f606: function (event) { onboardingSkip(); },  // click
  c1692308: function (event) { chatRemoveModel(this.dataset.m); },  // click
  c1a5cac5: function (event) { labSaveLook({ name: document.getElementById('lab-look-name').value.trim() }); },  // click
  c1b95bd0: function (event) { clearVoiceMemory(); },  // click
  c2190445: function (event) { loginPress('6'); },  // click
  c22391d5: function (event) { setVoiceMode('text'); },  // click
  c23686d1: function (event) { osintCreateProfile(); },  // click
  c2702efb: function (event) { runTermCmd(); },  // click
  c28063f1: function (event) { labShowCode(); },  // click
  c2a66ef1: function (event) { askSummaryQuestion(); },  // click
  c2c5d75b: function (event) { openComfyImage(this.dataset.url); },  // click
  c2e727c8: function (event) { sendVoiceTextMessage(); },  // click
  c2efd28a: function (event) { voiceBackendChanged(); },  // change
  c2f8587c: function (event) { labRename(this.dataset.id); },  // click
  c31e07b4: function (event) { chatCancelPull(this.dataset.id); },  // click
  c351370d: function (event) { musicSearch(); },  // click
  c3c48883: function (event) { setTheme('light'); },  // click
  c3d6c1d7: function (event) { labAnswer(this.dataset.id, false); },  // click
  c3e356eb: function (event) { labShare(!document.getElementById('system-screen').classList.contains('lab-share')); },  // click
  c4067256: function (event) { loadComfyStatus(); },  // click
  c41381ac: function (event) { requestMicPermission(); },  // click
  c41b4ed3: function (event) { event.stopPropagation(); toggleJob(this.dataset.id, !this.previousElementSibling.checked, this.dataset.profile); },  // click
  c41cfede: function (event) { startUpdateFromNotice(); },  // click
  c48b3acd: function (event) { closeSettings(); },  // click
  c49c78d7: function (event) { onboardingNext(); },  // click
  c49cf235: function (event) { toggleMute(); },  // click
  c4a5cf4c: function (event) { switchSettingsTab('st-tab-telemetry'); },  // click
  c4f9f2d8: function (event) { saveVoiceConfig(); },  // change
  c4ff67f2: function (event) { toggleLegosAddSpread(); },  // click
  c51bd3af: function (event) { runCmd('uptime'); },  // click
  c570a98b: function (event) { saveVoiceConfig(); },  // click
  c576c1bb: function (event) { onboardingPrev(); },  // click
  c58066e5: function (event) { labDiscover(); },  // click
  c5b47f6f: function (event) { switchJournalTab('journal-tab-voice'); },  // click
  c5d84ce8: function (event) { performUpdate(); },  // click
  c5e7c742: function (event) { hideChatHistory(event); },  // click
  c5fc7507: function (event) { loginPress('8'); },  // click
  c630dcea: function (event) { stopGeneration(); },  // click
  c63c74c9: function (event) { loginPress('9'); },  // click
  c64bd9a7: function (event) { labCopyBox(this); },  // click
  c6575841: function (event) { loadChatLibrary(); },  // change
  c65e8448: function (event) { labMenu(this); },  // click
  c6ac63a3: function (event) { forceRefresh(); },  // click
  c6af51d6: function (event) { changePin(); },  // click
  c6ce4730: function (event) { labAction(this.dataset.id, 'unload-model', this.dataset.t); },  // click
  c6d55428: function (event) { event.stopPropagation(); },  // click
  c6e4dcec: function (event) { goHome(); },  // click
  c6f13035: function (event) { event.stopPropagation();osintRunScan(this.dataset.id, true); },  // click
  c6fe321a: function (event) { document.getElementById('song-details-modal').style.display='none'; },  // click
  c707483c: function (event) { onChapterDropdownChange(this.value); },  // change
  c70af266: function (event) { toggleBookAudio(); },  // click
  c70bba1d: function (event) { playMusic(+this.dataset.idx); },  // click
  c72d5f12: function (event) { labAddDevice(); },  // click
  c74a04ac: function (event) { toggleChipGraph(this.dataset.key); },  // click
  c768d331: function (event) { window.open('https://github.com/realvitali/decloud/issues/new', '_blank'); },  // click
  c76e3fea: function (event) { switchSettingsTab('st-tab-logs'); },  // click
  c7830917: function (event) { setVoiceMode('voice'); },  // click
  c791ef5a: function (event) { toggleDeleteMode(); },  // click
  c797b9ca: function (event) { runCmd('free -h'); },  // click
  c79cf015: function (event) { checkAuth(); },  // click
  c7aa96c8: function (event) { sortBooks(this.value); },  // change
  c7ad40b9: function (event) { chatPull(this.dataset.m); },  // click
  c7addac0: function (event) { toggleVoice(); },  // click
  c7ae456b: function (event) { togglePlayMusic(); },  // click
  c7c43e12: function (event) { runCmd('tailscale status'); },  // click
  c7e02dfb: function (event) { openSettingsForBook(currentBook); },  // click
  c7e4d5d6: function (event) { labAction(this.dataset.id, 'restart-container', this.dataset.t); },  // click
  c7e99733: function (event) { loginPress('2'); },  // click
  c7fa6003: function (event) { toggleOsintCard(this.dataset.id); },  // click
  c80f5e32: function (event) { clearNotifications(); },  // click
  c82a9526: function (event) { exportTelemetry(); },  // click
  c8363924: function (event) { gotoBookmark(+this.dataset.i); },  // click
  c84c618b: function (event) { labResetKey(); },  // click
  c8536e80: function (event) { openProject(this.dataset.id); },  // click
  c87674c5: function (event) { labOpenAdd(); },  // click
  c8779f89: function (event) { exportLogs(); },  // click
  c87afb79: function (event) { labCloseMenu(); labOpenLook(); },  // click
  c883b732: function (event) { voiceCloudProviderChanged(); },  // change
  c8b22f3b: function (event) { labSetShareable(this.checked); },  // change
  c8c78e35: function (event) { rescanUniverse(); },  // click
  c8d6b216: function (event) { openBook(this.dataset.id, this.dataset.title, this.dataset.author); },  // click
  c8f8f534: function (event) { closeScanModal(); },  // click
  c903ac88: function (event) { savePaths(); },  // click
  c91abead: function (event) { setExperimentalApps(this.checked); },  // change
  c92278f7: function (event) { switchJournalTab('journal-tab-universe'); },  // click
  c9625c8e: function (event) { labPair(this.dataset.ip, +this.dataset.port); },  // click
  c97ff5e9: function (event) { openOllamaChat(this.dataset.id); },  // click
  c996e1c8: function (event) { handleWordTap(this, +this.dataset.idx); },  // click
  c9a26aa9: function (event) { installVoice(); },  // click
  c9a53f4e: function (event) { switchSettingsTab('st-tab-about'); },  // click
  c9d4f5fe: function (event) { switchTerminalMode('interactive'); },  // click
  c9deac74: function (event) { ollamaDevice = this.value; renderOllamaInfo(); },  // change
  c9e6ff2c: function (event) { pullOllamaModel(); },  // click
  c9ee5f32: function (event) { checkForUpdates(true); },  // click
  c9f6db8b: function (event) { closeScanModal(event); },  // click
  ca0df7c8: function (event) { switchSummaryTab('chapter'); },  // click
  ca1972b7: function (event) { openApp(this.dataset.appId); },  // click
  ca30327d: function (event) { labRenameStart(); },  // click
  ca3655d8: function (event) { prevChapter(); },  // click
  ca48106a: function (event) { toggleAgentDetail(this.dataset.id); },  // click
  ca57cb34: function (event) { deleteBookmark(+this.dataset.i); },  // click
  ca602549: function (event) { musicGenCheckStatus(); },  // click
  ca63a0ad: function (event) { newOllamaChat(); },  // click
  ca63c710: function (event) { switchSummaryTab('sofar'); },  // click
  ca806024: function (event) { loginPress('1'); },  // click
  cab66ad9: function (event) { turnReaderPage(1); },  // click
  cadeb8c8: function (event) { labCloseSheet(); },  // click
  cae1a198: function (event) { nextSong(); },  // click
  cb3c86ad: function (event) { switchTerminalMode('quick'); },  // click
  cb570769: function (event) { comfyStart(); },  // click
  cb57655f: function (event) { loginPress('4'); },  // click
  cb8eb6c3: function (event) { loadBooks(); },  // click
  cb8f387e: function (event) { openSummary(); },  // click
  cbae66cf: function (event) { stopOllama(); },  // click
  cbc2c70f: function (event) { seekTo(event); },  // click
  cbe3776a: function (event) { closeSummary(); },  // click
  cbfd3dc4: function (event) { addUniversePerson(); },  // click
  cc02d4d1: function (event) { chatPull(document.getElementById('chat-lib-custom').value.trim()); },  // click
  cc1125af: function (event) { event.stopPropagation();osintDeleteProfile(this.dataset.id); },  // click
  cc2f034e: function (event) { labSaveLook({ accent: this.dataset.v }); },  // click
  cc32b340: function (event) { prevSong(); },  // click
  cc39d5bd: function (event) { event.stopPropagation(); showSongDetails(+this.closest('.music-tile').dataset.idx); },  // click
  cc73744d: function (event) { nextChapter(); },  // click
  cc73b073: function (event) { runCmd('who'); },  // click
  cc7c1e86: function (event) { switchSettingsTab('st-tab-paths'); },  // click
  cc980e1e: function (event) { setTheme('auto'); },  // click
  cccec6d6: function (event) { osintViewResults(this.dataset.id); },  // click
  ccd3c40b: function (event) { toggleChatHistory(); },  // click
  ccde407f: function (event) { toggleNotifications(); },  // click
  cce8b14e: function (event) { modelsDownload(this.dataset.repo, this.dataset.file); },  // click
  ccee1ba0: function (event) { comfyGenerate(); },  // click
  ccfbde95: function (event) { loginBack(); },  // click
  cd269771: function (event) { osintLoadScan(this.dataset.id); },  // click
  cd42c5bc: function (event) { performRollback(); },  // click
  cd84f2ac: function (event) { loginPress('5'); },  // click
  cd854e06: function (event) { reopenOnboarding(); },  // click
  cd90efef: function (event) { startVoiceJournal(); },  // click
  cd99111f: function (event) { setTheme('dark'); },  // click
  cd9ed946: function (event) { labUpdateAgent(this.dataset.id, this); },  // click
  cdb70302: function (event) { showScreen('book-screen'); loadBooks(); },  // click
  cdcf4b21: function (event) { runCmd('hostname'); },  // click
  cdd807b4: function (event) { startGeneration(); },  // click
  cdef0de4: function (event) { hideChatHistory(); },  // click
  cdf0fb91: function (event) { installOllama(); },  // click
  cdf4c09e: function (event) { loginPress('0'); },  // click
  ce102b9c: function (event) { labGetModels(this.dataset.id); },  // click
  ce262274: function (event) { onOllamaModelChange(this.value); },  // change
  ce6cf49c: function (event) { addBrickFromSpread(+this.dataset.rows, +this.dataset.cols, +this.dataset.color); },  // click
  ce7044ef: function (event) { labSaveLook({ font: this.dataset.v }); },  // click
  ce7f0a97: function (event) { labCloseMenu(); labOpenAdd(); },  // click
  ce80a430: function (event) { switchSettingsTab('st-tab-appearance'); },  // click
  ce982209: function (event) { turnReaderPage(-1); },  // click
  ce9dbe9c: function (event) { event.stopPropagation();osintRunScan(this.dataset.id); },  // click
  cea87b9d: function (event) { sendOllamaMessage(); },  // click
  ceb86689: function (event) { labOpenDevice(this.dataset.id); },  // click
  ceff8cab: function (event) { labAnswer(this.dataset.id, true); },  // click
  cf2861dd: function (event) { musicGenAgain(this.dataset.id); },  // click
  cf369059: function (event) { labStartAdd(this.dataset.ip, this.dataset.name); },  // click
  cf388b45: function (event) { labGoPage(+this.dataset.p); },  // click
  cf5d0898: function (event) { musicDownload(this.dataset.id, this); },  // click
  cf600aec: function (event) { loginPress('7'); },  // click
  cf604f75: function (event) { setBookFontSize(this.value); },  // change
  cf62089e: function (event) { closeVoice(); },  // click
  cf833bc6: function (event) { labAddPhone(this.dataset.ip, this); },  // click
  cf95be22: function (event) { event.stopPropagation(); openSettingsForBook(this.dataset.id); },  // click
  cf9c046a: function (event) { runCmd('df -h'); },  // click
  cfb69b14: function (event) { saveHermesHome(); },  // click
  cfc72e0f: function (event) { toggleCapabilities(); },  // click
  cfddb0ac: function (event) { selectVoice(this.dataset.id); },  // click
  cfe534d2: function (event) { labSaveLook({ view: this.dataset.v }); },  // click
  cfe8c404: function (event) { loginPress('3'); },  // click
  cfea1072: function (event) { switchSettingsTab('st-tab-network'); },  // click
  e53397a9: function (event) { this.closest('.book-tile-cover').classList.add('cover-fallback'); },  // error
  ee677121: function (event) { this.parentElement.classList.add('cover-fallback');this.remove(); },  // error
  k56b336e: function (event) { if(event.key === 'Enter' || event.key === ' ') { event.preventDefault(); this.click(); }; },  // keydown
  kc0fa567: function (event) { if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();sendVoiceTextMessage();}; },  // keydown
  l31e1587: function (event) { this.style.opacity=1; },  // load
  lea99a7f: function (event) { if(this.naturalWidth>1)this.style.opacity=1; },  // load
  t366851d: function (event) { if(this.open) loadModels('image'); },  // toggle
  t940ee5b: function (event) { if(this.open) loadChatLibrary(); },  // toggle
  td1b932e: function (event) { if(this.open) loadModels('music'); },  // toggle
};

(function () {
  // Bubbling events: run handlers from the target up, like inline handlers did;
  // event.stopPropagation() in one stops the ones above it.
  const BUBBLING = ['change', 'click', 'keydown'];
  // Non-bubbling ones (load, error, toggle…) only ever fire on the element itself.
  const DIRECT = ['error', 'load', 'toggle'];
  const run = (el, ev, event) => {
    const fn = PAGE_HANDLERS[el.getAttribute('data-on' + ev)];
    if (fn && fn.call(el, event) === false) event.preventDefault();
  };
  BUBBLING.forEach(ev => document.addEventListener(ev, (event) => {
    for (let el = event.target; el && el.nodeType === 1; el = el.parentElement) {
      if (el.hasAttribute('data-on' + ev)) run(el, ev, event);
      if (event.cancelBubble) break;
    }
  }));
  DIRECT.forEach(ev => document.addEventListener(ev, (event) => {
    const el = event.target;
    if (el && el.nodeType === 1 && el.hasAttribute('data-on' + ev)) run(el, ev, event);
  }, true));
})();
