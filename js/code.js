/* ============================================================
   VR Mover · Source Code page — code.js
   Fetches each source file, renders it with line numbers and
   highlight.js syntax colouring, and wires Copy / Download.
   ============================================================ */
(function () {
  'use strict';

  const FILES = [
    {
      id: 'lib',
      path: '../js/vr-mover.js',
      name: 'vr-mover.js',
      icon: '📜',
      lang: 'javascript',
      group: null,
      desc: 'All-in-one JavaScript reproduction of the VR Mover core (LLM, STT, timing, rounds).',
    },
    {
      id: 'sys',
      path: '../prompts/original/system_api_original.txt',
      name: 'System prompt (paper)',
      file: 'system_api_original.txt',
      icon: '🧠',
      lang: null,
      group: 'Original prompts (paper)',
      desc: 'Verbatim system prompt used in the paper\u2019s Unity project.',
    },
    {
      id: 'usr',
      path: '../prompts/original/user_fewshot_original.txt',
      name: 'User few-shot (paper)',
      file: 'user_fewshot_original.txt',
      icon: '💬',
      lang: null,
      views: [['json', 'JSON'], ['plain', 'Plain text']],
      group: 'Original prompts (paper)',
      desc: 'Verbatim few-shot user example pinned at the start of the conversation.',
    },
    {
      id: 'ast',
      path: '../prompts/original/assistant_fewshot_original.txt',
      name: 'Assistant few-shot (paper)',
      file: 'assistant_fewshot_original.txt',
      icon: '🤖',
      lang: null,
      wrap: true,
      group: 'Original prompts (paper)',
      desc: 'Verbatim few-shot assistant reply demonstrating the expected API-call output.',
    },
  ];

  const $ = (id) => document.getElementById(id);
  const fileListEl = $('file-list');
  const lineNumsEl = $('line-nums');
  const codeEl = $('code-el');
  const titleEl = $('viewer-title');
  const descEl = $('viewer-desc');
  const loadingEl = $('loading');
  const codeWrapEl = $('code-wrap');
  const mdWrapEl = $('md-wrap');
  const viewModeEl = $('view-mode');

  const cache = new Map(); // id -> raw text
  let current = null;      // current FILES entry

  // Plain-text files (the .txt prompts) have no syntax language. highlight.js
  // is disabled for them; instead they can be read as Markdown or plain text.
  const isText = (f) => !f.lang;
  const MODE_KEY = 'vrmover_code_viewmode';
  let viewMode = localStorage.getItem(MODE_KEY) === 'plain' ? 'plain' : 'markdown';

  /* ── File list ─────────────────────────────────────────── */
  function buildFileList() {
    let lastGroup = null;
    for (const f of FILES) {
      if (f.group && f.group !== lastGroup) {
        const g = document.createElement('div');
        g.className = 'file-group';
        g.textContent = f.group;
        fileListEl.appendChild(g);
        lastGroup = f.group;
      }
      const btn = document.createElement('button');
      btn.className = 'file-item';
      btn.id = 'file-' + f.id;
      btn.innerHTML =
        `<span class="f-icon">${f.icon}</span>` +
        `<span class="f-name">${f.name}</span>` +
        `<span class="f-meta" id="meta-${f.id}"></span>`;
      btn.addEventListener('click', () => show(f));
      fileListEl.appendChild(btn);
    }
  }

  /* ── Viewer ────────────────────────────────────────────── */
  async function show(f) {
    current = f;
    document.querySelectorAll('.file-item').forEach((el) => el.classList.remove('active'));
    $('file-' + f.id)?.classList.add('active');
    titleEl.textContent = f.file || f.name;
    descEl.textContent = f.desc || '';

    let text = cache.get(f.id);
    if (text === undefined) {
      codeWrapEl.hidden = true;
      mdWrapEl.hidden = true;
      loadingEl.hidden = false;
      try {
        const res = await fetch(f.path);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        text = await res.text();
        cache.set(f.id, text);
      } catch (err) {
        text = `Failed to load ${f.path}: ${err.message}\n` +
               `(If you opened this page from the local filesystem, serve it over HTTP instead.)`;
        cache.set(f.id, text);
      }
      loadingEl.hidden = true;
      if (current !== f) return; // user switched files while loading
    }
    render(f, text);
  }

  // View modes available for a text file: default Markdown/Plain; the JSON
  // few-shot offers JSON/Plain instead.
  const viewsOf = (f) => f.views ?? [['markdown', 'Markdown'], ['plain', 'Plain text']];

  function render(f, text) {
    const textFile = isText(f);

    // The render-mode switch only applies to the .txt prompt files.
    viewModeEl.hidden = !textFile;
    const views = viewsOf(f);
    const mode = textFile && views.some(([k]) => k === viewMode) ? viewMode : views[0][0];
    if (textFile) syncModeButtons(views, mode);

    const asMarkdown = textFile && mode === 'markdown' && window.marked;

    if (asMarkdown) {
      // Render the prompt as Markdown (headings, lists, inline code).
      mdWrapEl.innerHTML = marked.parse(text, { breaks: false, gfm: true });
      mdWrapEl.hidden = false;
      codeWrapEl.hidden = true;
      mdWrapEl.scrollTop = 0;
    } else {
      // Code / JSON (highlighted) or plain text, with line numbers.
      const lang = f.lang || (mode === 'json' ? 'json' : null);
      if (lang && window.hljs) {
        codeEl.innerHTML = hljs.highlight(text, { language: lang }).value;
        codeEl.className = 'hljs';
      } else {
        codeEl.textContent = text;
        codeEl.className = '';
      }
      // Files with very long single lines (assistant few-shot) soft-wrap;
      // the gutter is hidden there since numbers can't align to wrapped lines.
      const wrap = !!f.wrap && !lang;
      codeWrapEl.classList.toggle('wrap', wrap);
      const n = text.split('\n').length;
      const frag = document.createDocumentFragment();
      for (let i = 1; i <= n; i++) {
        const s = document.createElement('span');
        s.textContent = i;
        frag.appendChild(s);
      }
      lineNumsEl.replaceChildren(frag);
      mdWrapEl.hidden = true;
      codeWrapEl.hidden = false;
      codeWrapEl.scrollTop = 0;
    }

    // Line-count badge (shown only on the active file via CSS).
    const meta = $('meta-' + f.id);
    if (meta) meta.textContent = text.split('\n').length + ' L';
  }

  function syncModeButtons(views, mode) {
    const btns = [$('vm-md'), $('vm-plain')];
    views.forEach(([key, label], i) => {
      const b = btns[i];
      if (!b) return;
      b.textContent = label;
      b.dataset.mode = key;
      b.classList.toggle('active', key === mode);
    });
  }

  function setViewMode(mode) {
    viewMode = mode;
    localStorage.setItem(MODE_KEY, mode);
    if (current) {
      const text = cache.get(current.id);
      if (text !== undefined) render(current, text);
    }
  }

  /* ── Copy / Download ───────────────────────────────────── */
  $('btn-copy').addEventListener('click', async () => {
    if (!current) return;
    const text = cache.get(current.id);
    if (text === undefined) return;
    try {
      await navigator.clipboard.writeText(text);
      const btn = $('btn-copy');
      btn.classList.add('copied');
      btn.textContent = '✓ Copied';
      setTimeout(() => { btn.classList.remove('copied'); btn.textContent = '⧉ Copy'; }, 1500);
    } catch {
      /* clipboard unavailable (insecure context) */
    }
  });

  $('btn-download').addEventListener('click', () => {
    if (!current) return;
    const text = cache.get(current.id);
    if (text === undefined) return;
    const filename = current.file || current.path.split('/').pop();
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  });

  /* ── Render-mode switch (labels/modes set per file) ────── */
  $('vm-md').addEventListener('click', (e) => setViewMode(e.currentTarget.dataset.mode || 'markdown'));
  $('vm-plain').addEventListener('click', (e) => setViewMode(e.currentTarget.dataset.mode || 'plain'));

  /* ── Theme (synced with the project page) ──────────────── */
  function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('theme', theme);
    $('theme-icon').textContent = theme === 'dark' ? '☀️' : '🌙';
    // Swap the highlight.js colour scheme to match.
    $('hljs-dark').disabled = theme !== 'dark';
    $('hljs-light').disabled = theme === 'dark';
  }
  function currentTheme() {
    return document.documentElement.getAttribute('data-theme')
        || localStorage.getItem('theme')
        || (window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  }
  applyTheme(currentTheme());
  $('theme-toggle').addEventListener('click', () =>
    applyTheme(currentTheme() === 'dark' ? 'light' : 'dark'));
  window.addEventListener('storage', (e) => {
    if (e.key === 'theme' && e.newValue) applyTheme(e.newValue);
  });

  /* ── Init ──────────────────────────────────────────────── */
  buildFileList();
  show(FILES[0]);
})();
