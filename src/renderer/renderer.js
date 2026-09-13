'use strict';
/**
 * UI logic. Runs sandboxed: all file access goes through `window.api` (see src/main/preload.js).
 * Settings rules and labels come from src/core/settings.js, shared with the main process.
 */
(() => {
  const S = window.Mp3Settings;
  const api = window.api;
  const $ = (sel) => document.querySelector(sel);

  // ---------- Small helpers ----------

  const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ESCAPES[c]);

  /** Same format as formatBytes() in src/core/files.js (kept separate because the UI can't require Node modules). */
  function formatBytes(bytes) {
    const abs = Math.abs(bytes);
    if (abs >= 2 ** 30) return `${(bytes / 2 ** 30).toFixed(2)} GB`;
    if (abs >= 2 ** 20) return `${(bytes / 2 ** 20).toFixed(1)} MB`;
    if (abs >= 2 ** 10) return `${(bytes / 2 ** 10).toFixed(0)} KB`;
    return `${bytes} B`;
  }

  const plural = (n, word) => `${n.toLocaleString()} ${word}${n === 1 ? '' : 's'}`;
  const baseName = (p) => p.split(/[\\/]/).filter(Boolean).pop() || p;
  const duration = (ms) => {
    const s = Math.max(0, Math.round(ms / 1000));
    return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
  };
  const clock = (t) => new Date(t).toLocaleTimeString([], { hour12: false });

  // ---------- Preferences (remembered between launches) ----------

  const PREFS_KEY = 'mp3bulk.prefs.v1';
  function loadPrefs() {
    try {
      const p = JSON.parse(localStorage.getItem(PREFS_KEY)) || {};
      return { settings: S.sanitizeSettings(p.settings), replace: p.replace === true, recursive: p.recursive === true };
    } catch {
      return { settings: S.defaultSettings(), replace: false, recursive: false };
    }
  }
  function savePrefs() {
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify({ settings, replace, recursive }));
    } catch { /* storage unavailable: preferences just won't persist */ }
  }

  // ---------- State ----------

  const prefs = loadPrefs();
  let settings = prefs.settings;
  let replace = prefs.replace;
  let recursive = prefs.recursive;
  let info = { trashName: 'Trash', platform: '' };
  /** Paths the user picked or dropped. */
  let sources = [];
  /** MP3s found in `sources` (from the main process). */
  let files = [];
  let scanning = false;
  /** Latest batch state from the main process, or null in setup mode. */
  let run = null;
  let renderedResults = 0;
  let renderedLog = 0;
  let logOpen = false;

  // ---------- Settings UI ----------

  const GROUPS = [
    {
      key: 'mode',
      label: () => 'Bitrate mode',
      options: () => [[null, 'Keep'], ...Object.values(S.EncodeMode).map((m) => [m.id, m.label])],
      hint: () => (settings.mode ? S.EncodeMode[settings.mode].description : 'Each file keeps its own mode'),
    },
    {
      key: 'kbps',
      label: () => ({ VBR: 'Bitrate (kbps, VBR target)', ABR: 'Bitrate (kbps, average)' }[settings.mode] || 'Bitrate (kbps)'),
      options: () => [
        [S.KEEP, 'Keep'],
        ...S.BITRATES.map((k) => [k, String(k)]),
        ...(settings.mode === 'VBR' ? [[S.V0_KBPS, S.bitrateLabel(S.V0_KBPS)]] : []),
      ],
      hint: () => 'Never raised: files already at or below this keep their bitrate',
    },
    {
      key: 'sampleRate',
      label: () => 'Sample rate (Hz)',
      options: () => [[S.KEEP, 'Keep'], ...S.SAMPLE_RATES.map((hz) => [hz, S.sampleRateLabel(hz)])],
      hint: () => 'Never upsampled',
    },
    {
      key: 'highPass',
      label: () => 'High-pass filter',
      options: () => [[false, 'Keep (off)'], [true, `On at ${S.HIGH_PASS_HZ} Hz`]],
      hint: () => 'Removes rumble below 80 Hz. Good for speech',
    },
    {
      key: 'lowPass',
      label: () => 'Low-pass filter',
      options: () => [[false, 'Keep (off)'], [true, `On at ${S.LOW_PASS_HZ.toLocaleString('en-US')} Hz`]],
      hint: () => "Uses 15 kHz or LAME's own cutoff, whichever is lower",
    },
    {
      key: 'channels',
      label: () => 'Channels',
      options: () => [[null, 'Keep'], ...['STEREO', 'JOINT', 'MONO'].map((c) => [c, S.ChannelOut[c].label])],
      hint: () => 'Mono files always stay mono',
    },
  ];

  function renderSettings() {
    $('#settings-groups').innerHTML = GROUPS.map((g) => `
      <div class="group" data-group="${g.key}">
        <div class="group-label">${esc(g.label())}</div>
        <div class="chips" role="radiogroup" aria-label="${esc(g.label())}">
          ${g.options().map(([value, label]) => {
            const selected = settings[g.key] === value;
            return `<button class="chip${selected ? ' selected' : ''}" role="radio" aria-checked="${selected}"
              data-setting="${g.key}" data-value='${esc(JSON.stringify(value))}'>${esc(label)}</button>`;
          }).join('')}
        </div>
        <div class="group-hint">${esc(g.hint())}</div>
      </div>`).join('');

    const preset = S.matchingPreset(settings);
    document.querySelectorAll('.preset').forEach((el) => {
      const on = el.dataset.preset === preset;
      el.classList.toggle('selected', on);
      el.setAttribute('aria-pressed', String(on));
    });
    $('#subtitle').textContent = S.settingsSummary(settings);
    renderActionBar();
  }

  function setSetting(key, value) {
    settings = { ...settings, [key]: value };
    // V0 only exists in VBR mode.
    if (key === 'mode' && value !== 'VBR' && settings.kbps === S.V0_KBPS) settings.kbps = S.KEEP;
    savePrefs();
    renderSettings();
  }

  // ---------- Source ----------

  async function setSources(paths) {
    if (run || !paths.length) return;
    sources = paths;
    await rescan();
  }

  async function rescan() {
    if (!sources.length) {
      files = [];
      renderSource();
      return;
    }
    scanning = true;
    renderSource();
    try {
      files = await api.scan(sources, recursive);
    } catch (e) {
      files = [];
      console.error(e);
    } finally {
      scanning = false;
      renderSource();
    }
  }

  function renderSource() {
    const has = sources.length > 0;
    const total = files.reduce((sum, f) => sum + f.size, 0);
    const single = sources.length === 1 && files.length === 1 && files[0].path === sources[0];

    $('#drop-zone').classList.toggle('has-source', has);
    $('#clear-source').hidden = !has;
    $('#source-icon').innerHTML = `<use href="#i-${single ? 'file' : 'folder'}"/>`;
    $('#source-name').textContent = !has ? 'Drop MP3s or folders here'
      : sources.length === 1 ? baseName(sources[0]) : `${sources.length} items`;
    $('#source-summary').textContent = !has ? 'or choose below'
      : scanning ? 'Looking for MP3s…'
      : files.length === 0 ? (recursive ? 'No MP3 files found' : 'No MP3 files here. Try including subfolders')
      : `${plural(files.length, 'MP3 file')} · ${formatBytes(total)}`;

    const list = $('#file-list');
    $('#file-details').hidden = files.length === 0;
    const shown = files.slice(0, 500);
    list.innerHTML = shown.map((f) => `
      <li title="${esc(f.path)}"><span>${f.relativeDir ? `<span class="dir">${esc(f.relativeDir)}/</span>` : ''}${esc(f.name)}</span>
      <span class="muted">${formatBytes(f.size)}</span></li>`).join('') +
      (files.length > shown.length ? `<li class="muted">…and ${(files.length - shown.length).toLocaleString()} more</li>` : '');
    renderActionBar();
  }

  // ---------- Action bar ----------

  function renderActionBar() {
    const running = run && !run.finished;
    $('#compress').hidden = !!run;
    $('#stop').hidden = !running;
    $('#done').hidden = !run || !run.finished;

    if (run) {
      $('#action-hint').textContent = running ? `Working on ${plural(Object.keys(run.active).length, 'file')} at a time. Originals stay untouched until each new file is verified.` : '';
      return;
    }
    const allKeep = S.sameSettings(settings, S.defaultSettings());
    $('#compress-label').textContent = files.length ? `Compress ${plural(files.length, 'file')}` : 'Compress';
    $('#compress').disabled = scanning || files.length === 0 || allKeep;
    $('#action-hint').textContent = scanning ? 'Scanning…'
      : files.length === 0 ? 'Choose a folder or MP3 files to start.'
      : allKeep ? 'Everything is set to “Keep”, so nothing would change. Pick a preset or setting.'
      : replace ? `Originals go to the ${info.trashName} after each new file is verified.`
      : 'A “ - SHRUNK” copy is saved next to each original.';
  }

  // ---------- Run view ----------

  function outcomeView(r) {
    const o = r.outcome;
    if (o.type === 'done') {
      const pct = Math.round((1 - o.newSize / o.oldSize) * 100);
      const badge = o.status === 'REPLACED' ? ['replaced', 'Replaced'] : o.status === 'KEPT_BOTH' ? ['done', 'Kept both'] : ['done', 'Done'];
      const detail = `${formatBytes(o.oldSize)} → ${formatBytes(o.newSize)} (−${pct}%) · ${S.planSummary(o.plan)} → ${o.outputName}` +
        (o.note ? `. ${o.note}` : '');
      return { badge, detail, error: false, reveal: o.outputPath };
    }
    if (o.type === 'skipped') return { badge: ['skipped', 'Skip'], detail: o.reason, error: false, reveal: r.file.path };
    return { badge: ['failed', 'Failed'], detail: `${o.message}. Original untouched.`, error: true, reveal: r.file.path };
  }

  function summarize(st) {
    const done = st.results.filter((r) => r.outcome.type === 'done');
    const activeSum = Object.values(st.active).reduce((s, a) => s + a.progress, 0);
    return {
      compressed: done.length,
      skipped: st.results.filter((r) => r.outcome.type === 'skipped').length,
      failed: st.results.filter((r) => r.outcome.type === 'failed').length,
      saved: done.reduce((s, r) => s + r.outcome.oldSize - r.outcome.newSize, 0),
      fraction: st.total ? Math.min(1, (st.results.length + activeSum) / st.total) : 1,
    };
  }

  function renderRun() {
    $('#setup-view').hidden = !!run;
    $('#run-view').hidden = !run;
    renderActionBar();
    if (!run) {
      renderedResults = 0;
      renderedLog = 0;
      $('#results').innerHTML = '';
      $('#log').innerHTML = '';
      $('#active-list').innerHTML = '';
      $('#subtitle').textContent = S.settingsSummary(settings);
      return;
    }

    const s = summarize(run);
    const pct = run.finished && !run.cancelled ? 100 : Math.floor(s.fraction * 100);
    $('#run-percent').textContent = `${pct}%`;
    $('#run-count').textContent = `${run.results.length.toLocaleString()} of ${run.total.toLocaleString()}`;
    $('#run-bar').style.width = `${pct}%`;
    $('#stat-saved').textContent = formatBytes(s.saved);
    $('#stat-compressed').textContent = s.compressed;
    $('#stat-skipped').textContent = s.skipped;
    $('#stat-failed').textContent = s.failed;
    const elapsed = (run.endedAt || Date.now()) - run.startedAt;
    $('#run-status').textContent = run.finished
      ? `${run.cancelled ? 'Stopped after' : 'Finished in'} ${duration(elapsed)}`
      : `Elapsed ${duration(elapsed)}`;
    $('#subtitle').textContent = run.finished ? (run.cancelled ? 'Stopped' : 'Finished') : 'Compressing…';

    $('#active-list').innerHTML = Object.entries(run.active).map(([, a]) => `
      <div class="active-item"><div class="row"><span>${esc(a.name)}</span><span class="muted">${Math.floor(a.progress * 100)}%</span></div>
      <div class="bar"><div class="bar-fill" style="width:${Math.floor(a.progress * 100)}%"></div></div></div>`).join('');

    // Results and log only grow, so append instead of re-rendering thousands of rows.
    const results = $('#results');
    for (; renderedResults < run.results.length; renderedResults++) {
      const r = run.results[renderedResults];
      const v = outcomeView(r);
      const li = document.createElement('li');
      li.className = 'result';
      li.innerHTML = `
        <div class="body">
          <div class="name" title="${esc(r.file.path)}">${r.file.relativeDir ? `<span class="muted">${esc(r.file.relativeDir)}/</span>` : ''}${esc(r.file.name)}</div>
          <div class="detail${v.error ? ' error' : ''}">${esc(v.detail)}</div>
        </div>
        <span class="badge ${v.badge[0]}">${v.badge[1]}</span>
        <button class="icon-button" data-reveal="${esc(v.reveal)}" title="Show in ${esc(info.fileManager || 'folder')}"><svg class="icon"><use href="#i-reveal"/></svg></button>`;
      results.appendChild(li);
    }

    $('#log-count').textContent = `(${run.log.length})`;
    if (renderedLog > run.log.length) { $('#log').innerHTML = ''; renderedLog = 0; }
    if (logOpen) {
      const log = $('#log');
      const atBottom = log.scrollTop + log.clientHeight >= log.scrollHeight - 4;
      for (; renderedLog < run.log.length; renderedLog++) {
        const line = run.log[renderedLog];
        const li = document.createElement('li');
        if (line.isError) li.className = 'error';
        li.innerHTML = `<time>${clock(line.time)}</time>${esc(line.text)}`;
        log.appendChild(li);
      }
      if (atBottom) log.scrollTop = log.scrollHeight;
    }
  }

  // ---------- Events ----------

  async function pick(kind) {
    if (run) return;
    const paths = kind === 'pickFolder' ? await api.pickFolder() : await api.pickFiles();
    await setSources(paths);
  }

  function wire() {
    $('#pick-folder').addEventListener('click', () => pick('pickFolder'));
    $('#pick-files').addEventListener('click', () => pick('pickFiles'));
    $('#clear-source').addEventListener('click', () => { sources = []; files = []; api.clear(); renderSource(); });

    const recursiveBox = $('#recursive');
    recursiveBox.checked = recursive;
    recursiveBox.addEventListener('change', () => { recursive = recursiveBox.checked; savePrefs(); rescan(); });

    $('#presets').addEventListener('click', (e) => {
      const el = e.target.closest('[data-preset]');
      if (!el) return;
      settings = { ...S.PRESETS.find((p) => p.id === el.dataset.preset).settings };
      savePrefs();
      renderSettings();
    });

    $('#settings-groups').addEventListener('click', (e) => {
      const el = e.target.closest('[data-setting]');
      if (el) setSetting(el.dataset.setting, JSON.parse(el.dataset.value));
    });

    $(replace ? '#output-replace' : '#output-copy').checked = true;
    document.querySelectorAll('input[name="output"]').forEach((el) => el.addEventListener('change', () => {
      replace = $('#output-replace').checked;
      savePrefs();
      renderActionBar();
    }));

    $('#compress').addEventListener('click', async () => {
      if (replace) {
        const dialog = $('#confirm-replace');
        dialog.showModal();
        const answer = await new Promise((resolve) => dialog.addEventListener('close', () => resolve(dialog.returnValue), { once: true }));
        if (answer !== 'ok') return;
      }
      await api.start(settings, replace);
    });
    $('#stop').addEventListener('click', () => api.cancel());
    $('#done').addEventListener('click', async () => {
      await api.dismiss();
      run = null;
      renderRun();
      rescan(); // sizes changed and new " - SHRUNK" files should not be picked up
    });

    $('#log-toggle').addEventListener('click', () => {
      logOpen = !logOpen;
      $('#log').hidden = !logOpen;
      $('#copy-log').hidden = !logOpen;
      $('#log-toggle').textContent = logOpen ? 'Hide' : 'Show';
      renderRun();
    });
    $('#copy-log').addEventListener('click', () => {
      if (!run) return;
      navigator.clipboard.writeText(run.log.map((l) => `${clock(l.time)} ${l.text}`).join('\n'));
      $('#copy-log').textContent = 'Copied';
      setTimeout(() => { $('#copy-log').textContent = 'Copy'; }, 1500);
    });

    $('#results').addEventListener('click', (e) => {
      const el = e.target.closest('[data-reveal]');
      if (el) api.reveal(el.dataset.reveal);
    });

    // Drag and drop anywhere in the window.
    let dragDepth = 0;
    const overlay = $('#drop-overlay');
    window.addEventListener('dragenter', (e) => { e.preventDefault(); if (!run && ++dragDepth === 1) overlay.hidden = false; });
    window.addEventListener('dragleave', (e) => { e.preventDefault(); if (--dragDepth <= 0) { dragDepth = 0; overlay.hidden = true; } });
    window.addEventListener('dragover', (e) => e.preventDefault());
    window.addEventListener('drop', (e) => {
      e.preventDefault();
      dragDepth = 0;
      overlay.hidden = true;
      const paths = [...e.dataTransfer.files].map((f) => api.pathForFile(f)).filter(Boolean);
      setSources(paths);
    });

    api.onState((st) => { run = st; renderRun(); });
    api.onOpenPaths((paths) => setSources(paths));
    api.onMenu((kind) => pick(kind));

    // Keep the elapsed-time counter moving between progress updates.
    setInterval(() => { if (run && !run.finished) renderRun(); }, 1000);
  }

  async function init() {
    info = await api.info();
    document.body.classList.add(info.platform === 'darwin' ? 'mac' : 'win');
    $('#replace-detail').textContent =
      `Moves the original to the ${info.trashName} after the new file is verified, then gives the new file the original name.`;
    $('#confirm-text').textContent =
      `Each original is moved to the ${info.trashName} only after its new file has been verified. You can restore originals from the ${info.trashName}.`;
    wire();
    renderSettings();
    renderSource();
    run = await api.state();
    renderRun();
  }

  init();
})();
