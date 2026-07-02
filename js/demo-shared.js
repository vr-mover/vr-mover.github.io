/* ============================================================
   VR Mover · demo-shared.js
   UI glue shared VERBATIM by the 2D (demo.js) and 3D (demo3d.js)
   demos — provider presets for the settings dialog and the
   voice-input (STT) module. The LLM/round/timing ENGINE lives in
   vr-mover.js; this file only holds page chrome the two demos
   would otherwise duplicate. Demo-specific behaviour is injected
   through the hooks of createVoiceInput().
   ============================================================ */

const $ = (id) => document.getElementById(id);

/* ── Provider presets (settings → 🔑 quick-start) ─────────────
   All OpenAI-compatible chat endpoints. gpt-4o is the default
   for OpenAI / OpenRouter / Azure; Claude uses Anthropic's
   OpenAI-compatible endpoint (browser CORS is handled by
   LLMCore via the anthropic-dangerous-direct-browser-access
   header). */
export const PROVIDERS = {
  openai: {
    base: 'https://api.openai.com/v1', model: 'gpt-4o', auth: 'bearer',
    keyUrl: 'https://platform.openai.com/api-keys',
    note: 'Most capable models. Requires a paid account with billing enabled.',
    links: [['Create API key', 'https://platform.openai.com/api-keys'], ['Pricing', 'https://openai.com/api/pricing/']],
  },
  openrouter: {
    base: 'https://openrouter.ai/api/v1', model: 'openai/gpt-4o', auth: 'bearer',
    keyUrl: 'https://openrouter.ai/keys',
    note: 'One key for many models. Several are free — pick a model id ending in “:free” (e.g. meta-llama/llama-3.3-70b-instruct:free).',
    links: [['Create API key', 'https://openrouter.ai/keys'], ['Browse free models', 'https://openrouter.ai/models?max_price=0']],
  },
  azure: {
    base: 'https://YOUR-RESOURCE.openai.azure.com/openai/v1', model: 'gpt-4o', auth: 'api-key',
    keyUrl: 'https://portal.azure.com/',
    note: 'Azure OpenAI (v1 endpoint): replace YOUR-RESOURCE with your resource name and deploy gpt-4o. Auth uses the api-key header.',
    links: [['Azure OpenAI docs', 'https://learn.microsoft.com/azure/ai-services/openai/'], ['Portal', 'https://portal.azure.com/']],
  },
  moonshot: {
    base: 'https://api.moonshot.cn/v1', model: 'moonshot-v1-8k', auth: 'bearer',
    keyUrl: 'https://platform.moonshot.cn/console/api-keys',
    note: 'Kimi / Moonshot models. International users: use https://api.moonshot.ai/v1 and platform.moonshot.ai.',
    links: [['Create API key (CN)', 'https://platform.moonshot.cn/console/api-keys'], ['International', 'https://platform.moonshot.ai/console/api-keys']],
  },
  siliconflow: {
    base: 'https://api.siliconflow.cn/v1', model: 'Qwen/Qwen2.5-7B-Instruct', auth: 'bearer',
    keyUrl: 'https://cloud.siliconflow.cn/account/ak',
    note: 'Free tier across many open models (Qwen, GLM, DeepSeek…). Sign up, then create an API key.',
    links: [['Create API key', 'https://cloud.siliconflow.cn/account/ak'], ['Model list', 'https://cloud.siliconflow.cn/models']],
  },
  anthropic: {
    base: 'https://api.anthropic.com/v1', model: 'claude-sonnet-5', auth: 'bearer',
    keyUrl: 'https://console.anthropic.com/settings/keys',
    note: 'Claude via Anthropic’s OpenAI-compatible endpoint — strong spatial reasoning. Browser access is enabled automatically.',
    links: [['Create API key', 'https://console.anthropic.com/settings/keys'], ['Model list', 'https://docs.anthropic.com/en/docs/about-claude/models']],
  },
};

/** Autofill the settings form from a provider preset (same field ids on both demo pages). */
export function applyProviderPreset(key) {
  const p = PROVIDERS[key];
  const noteEl = $('s-provider-note'), linkBox = $('s-provider-link'), getKey = $('s-getkey-link');
  if (!p) {
    if (noteEl) noteEl.textContent = 'Choose a provider above to autofill the Base URL & model, with a link to create a key.';
    if (linkBox) linkBox.innerHTML = '';
    if (getKey) getKey.href = 'https://openrouter.ai/keys';
    return;
  }
  $('s-baseurl').value = p.base;
  $('s-model').value = p.model;
  $('s-auth').value = p.auth;
  if (noteEl) noteEl.textContent = p.note;
  if (getKey) getKey.href = p.keyUrl;
  if (linkBox) linkBox.innerHTML = p.links.map(([l, u]) => `<a href="${u}" target="_blank" rel="noopener noreferrer">${l} →</a>`).join('');
}

/* ── Voice input (Web Speech via vr-mover.js SpeechController) ─
   One implementation of the Auto/Hold mic UX both demos used to
   duplicate. Demo-specific behaviour comes in through hooks:

   createVoiceInput({
     SpeechController,          // class from vr-mover.js
     editor,                    // contenteditable command box
     sttBtn,                    // the mic <button>
     getLang, getConfirmDelay,  // () => current settings values
     serialize,                 // () => committed editor text
     canSend,                   // () => ok to auto-submit now
     deferAutoSend,             // () => true while a gesture is mid-flight (2D)
     send,                      // () => submit the round
     addRoundText,              // ({text,startMs,endMs}) => round.addText
     setStatus, toast,          // page chrome
     proposalStatusType,        // status type while speaking ('speaking' 2D / 'thinking' 3D)
   })
*/
export function createVoiceInput(cfg) {
  const {
    SpeechController, editor, sttBtn,
    getLang, getConfirmDelay, serialize, canSend, send, addRoundText,
    setStatus, toast,
    deferAutoSend = () => false,
    proposalStatusType = 'speaking',
  } = cfg;

  let stt = null, sttActive = false, voiceMode = 'auto', speechTimer = null;

  const sttSupported = () => !!(window.SpeechRecognition || window.webkitSpeechRecognition);

  /* Editor speech helpers — interim "ghost" text kept at the end of the box. */
  const interimNode = () => editor.querySelector('.interim');
  function insertAtEnd(node) {
    const ghost = interimNode();
    if (ghost) editor.insertBefore(node, ghost);
    else editor.appendChild(node);
  }
  function commitSpeechText(text) {
    clearInterim();
    insertAtEnd(document.createTextNode(text + ' '));
    editor.scrollTop = editor.scrollHeight;
  }
  function setInterim(text) {
    let ghost = interimNode();
    if (!ghost) {
      ghost = document.createElement('span');
      ghost.className = 'interim';
      ghost.contentEditable = 'false';
      editor.appendChild(ghost);
    } else if (ghost !== editor.lastChild) {
      editor.appendChild(ghost); // keep the ghost at the end
    }
    ghost.textContent = text;
    editor.scrollTop = editor.scrollHeight;
  }
  function clearInterim() { interimNode()?.remove(); }

  function clearSpeechTimer() {
    if (speechTimer) { clearTimeout(speechTimer); speechTimer = null; }
  }
  function scheduleSpeechTimer() {
    clearSpeechTimer();
    speechTimer = setTimeout(() => {
      // Don't dispatch while the user is mid-gesture — wait for it to finish.
      if (deferAutoSend()) { scheduleSpeechTimer(); return; }
      if (voiceMode !== 'auto') return;
      if (serialize() && canSend()) send();
    }, getConfirmDelay());
  }

  function startSTT() {
    if (stt) return;
    if (!sttSupported()) {
      toast(!window.isSecureContext
        ? 'Voice needs a secure page: open the https:// address — Chrome disables the mic/Speech API on plain http:// LAN URLs.'
        : 'Web Speech API unavailable here — use desktop Chrome/Edge. (On iPhone every browser, incl. Chrome, runs Safari/WebKit, which lacks it.)',
        'error');
      return;
    }
    stt = new SpeechController({
      lang: getLang(), interimResults: true, continuous: true,
      onProposal: (text) => {
        setInterim(text);
        clearSpeechTimer();
        setStatus(proposalStatusType, '🎙 speaking…');
      },
      onConfirmed: ({ text, startMs, endMs }) => {
        if (!text) return;
        addRoundText({ text, startMs, endMs });
        commitSpeechText(text);
        if (voiceMode === 'auto') { setStatus('active', '⏳ waiting…'); scheduleSpeechTimer(); }
        else setStatus('active', '🎙 holding…');
      },
      onSpeechEnd: () => { if (voiceMode === 'auto') scheduleSpeechTimer(); },
      onError: (e) => {
        if (e.error !== 'no-speech') {
          setStatus('error', '⚠ stt error');
          toast(`STT error: ${e.error ?? e.message}`, 'error');
        }
      },
    });
    stt.start();
    sttActive = true;
    sttBtn.classList.add('listening');
    setStatus('active', voiceMode === 'auto' ? '🎙 listening' : '🎙 hold to talk');
  }

  function stopSTT() {
    stt?.stop();
    stt = null;
    sttActive = false;
    sttBtn.classList.remove('listening');
    clearSpeechTimer();
    clearInterim();
    setStatus('idle', '● idle');
  }

  function setVoiceMode(mode) {
    voiceMode = mode;
    $('vm-auto')?.classList.toggle('active', mode === 'auto');
    $('vm-hold')?.classList.toggle('active', mode === 'hold');
    if (mode === 'hold' && sttActive) stopSTT(); // hold mode starts on press
    if (sttBtn) sttBtn.title = mode === 'auto'
      ? 'Toggle continuous listening (auto-submits after silence)'
      : 'Hold to talk (release to stop; submit manually)';
  }

  function setupVoice() {
    $('vm-auto')?.addEventListener('click', () => setVoiceMode('auto'));
    $('vm-hold')?.addEventListener('click', () => setVoiceMode('hold'));

    // Auto mode: click toggles. Hold mode: press starts, release stops.
    sttBtn?.addEventListener('click', () => {
      if (voiceMode !== 'auto') return;
      if (sttActive) stopSTT(); else startSTT();
    });
    sttBtn?.addEventListener('pointerdown', (e) => {
      if (voiceMode !== 'hold') return;
      e.preventDefault();
      sttBtn.setPointerCapture(e.pointerId);
      startSTT();
    });
    const holdEnd = (e) => {
      if (voiceMode !== 'hold') return;
      try { sttBtn.releasePointerCapture(e.pointerId); } catch { /* not captured */ }
      if (sttActive) {
        stt?.stop();
        stt = null;
        sttActive = false;
        sttBtn.classList.remove('listening');
        clearInterim();
        setStatus('idle', '✍ review & send');
      }
    };
    sttBtn?.addEventListener('pointerup', holdEnd);
    sttBtn?.addEventListener('pointercancel', holdEnd);
  }

  return {
    setupVoice, startSTT, stopSTT, setVoiceMode,
    isActive: () => sttActive,
    getMode: () => voiceMode,
    insertAtEnd, interimNode, commitSpeechText, setInterim, clearInterim,
  };
}
