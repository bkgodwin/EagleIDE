/* Saved editor colors and CodeMirror measurement lifecycle. Classic script. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.EagleEditorAppearance = api;
  if (typeof document !== 'undefined') api.init();
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';
  const colors = (background, foreground, keyword, definition, variable, string, number, comment, type) =>
    ({ background, foreground, keyword, definition, variable, string, number, comment, type,
       builtin:type, atom:type, property:variable, variable2:variable, operator:foreground, meta:keyword,
       attribute:variable, tag:keyword, qualifier:type, bracket:foreground, string2:string });
  const schemes = {
    'eagle-dark': { label: 'Eagle · Dark', mode: 'dark', colors: colors('#1e2229', '#dde4ed', '#c792ea', '#f1d488', '#9cdbff', '#e8a782', '#b5cea8', '#90ab89', '#82b4ee') },
    'ocean-dark': { label: 'Ocean · Dark', mode: 'dark', colors: colors('#0d2233', '#e0efff', '#cbb2ff', '#ffe0a3', '#9edfff', '#9ee1ce', '#ffc4a3', '#96afc3', '#b8caff') },
    'accessible-dark': { label: 'Blue & Gold · Dark (color vision friendly)', mode: 'dark', colors: colors('#161b22', '#f1f3f5', '#ffdb80', '#99d4ff', '#e5e9f0', '#eaca91', '#c8b6ff', '#a8b1bd', '#9bd8ed') },
    'mono-dark': { label: 'High contrast · Dark (minimal color)', mode: 'dark', colors: colors('#101010', '#f5f5f5', '#ffffff', '#eeeeee', '#f5f5f5', '#d4d4d4', '#ffffff', '#bcbcbc', '#ffffff') },
    'eagle-light': { label: 'Eagle · Light', mode: 'light', colors: colors('#f8fafc', '#253247', '#8243a3', '#795913', '#145e90', '#a1441a', '#326b45', '#526c4d', '#215dba') },
    'paper-light': { label: 'Paper · Light', mode: 'light', colors: colors('#fffbed', '#30312e', '#744097', '#735012', '#175a83', '#923f25', '#326543', '#626453', '#345e99') },
    'accessible-light': { label: 'Blue & Gold · Light (color vision friendly)', mode: 'light', colors: colors('#ffffff', '#222b36', '#765500', '#005b99', '#293340', '#75521c', '#58419a', '#58616b', '#00647a') },
    'mono-light': { label: 'High contrast · Light (minimal color)', mode: 'light', colors: colors('#ffffff', '#171717', '#000000', '#111111', '#171717', '#383838', '#000000', '#595959', '#000000') },
    // September 21 (e811099) used CodeMirror's Monokai/default themes.
    // Preserve their token categories; contrast is still adjusted for readability.
    'legacy-dark': { label: 'Legacy dark (September)', mode: 'dark', legacy:true, colors: {
      ...colors('#272822', '#f8f8f2', '#f92672', '#fd971f', '#f8f8f2', '#e6db74', '#ae81ff', '#75715e', '#66d9ef'),
      builtin:'#66d9ef', atom:'#ae81ff', property:'#a6e22e', attribute:'#a6e22e', variable2:'#9effff', meta:'#f8f8f2', string2:'#f8f8f2'} },
    'legacy-light': { label: 'Legacy light (September)', mode: 'light', legacy:true, colors: {
      ...colors('#ffffff', '#000000', '#770088', '#0000ff', '#000000', '#aa1111', '#116644', '#aa5500', '#008855'),
      builtin:'#3300aa', atom:'#221199', variable2:'#0055aa', meta:'#555555', attribute:'#0000cc',
      tag:'#117700', qualifier:'#555555', bracket:'#999977', string2:'#ff5500'} },
    'midnight-dark': { label: 'Midnight · Dark blue', mode:'dark', colors: colors('#111c32', '#e0e9ff', '#c6b1ef', '#e8d19d', '#9dd4ed', '#b3d8b8', '#dfb1ae', '#9baec7', '#a6baf3') },
    'forest-dark': { label: 'Forest · Dark green', mode:'dark', colors: colors('#17251f', '#dfe9df', '#c7b5e5', '#e2c58d', '#a4d4bb', '#c9d996', '#ddba93', '#98b5a0', '#9dbfdf') },
    'graphite-dark': { label: 'Graphite · Grey', mode:'dark', colors: colors('#26282c', '#e5e6e9', '#c5b5d9', '#e0c99d', '#b0cedb', '#c9d1a0', '#d4b6a8', '#a6acae', '#b0bfe0') },
    'alpine-dark': { label: 'Alpine · Dark', mode:'dark', colors: colors('#102b25', '#e4eee8', '#c6b8dd', '#e2c99c', '#a3d8c4', '#cad9a8', '#deb59c', '#9bbcaf', '#a7cbd9') },
  };
  const defaults = () => ({ scheme: 'auto', backgrounds: { dark: '', light: '' } });
  function normalize(value) {
    return { scheme: value?.scheme === 'auto' || Object.hasOwn(schemes, value?.scheme) ? value.scheme : 'auto',
      backgrounds: Object.fromEntries(['dark', 'light'].map(mode => [mode, /^#[0-9a-f]{6}$/i.test(value?.backgrounds?.[mode] || '') ? value.backgrounds[mode].toLowerCase() : ''])) };
  }
  function rgb(hex) { return [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16)); }
  function luminance(hex) {
    return rgb(hex).map(c => c / 255).map(c => c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4)
      .reduce((sum, c, i) => sum + c * [.2126, .7152, .0722][i], 0);
  }
  function contrast(a, b) { const x = luminance(a), y = luminance(b); return (Math.max(x, y) + .05) / (Math.min(x, y) + .05); }
  function readable(color, background) {
    if (contrast(color, background) >= 4.5) return color;
    const target = contrast('#ffffff', background) > contrast('#000000', background) ? 255 : 0;
    const original = rgb(color);
    for (let step = 1; step <= 20; step++) {
      const next = '#' + original.map(c => Math.round(c + (target - c) * step / 20).toString(16).padStart(2, '0')).join('');
      if (contrast(next, background) >= 4.5) return next;
    }
    return target ? '#ffffff' : '#000000';
  }
  function palette(value, light) {
    const preferences = normalize(value);
    const scheme = schemes[preferences.scheme] || schemes[light ? 'eagle-light' : 'eagle-dark'];
    const background = preferences.backgrounds[scheme.mode] || scheme.colors.background;
    const result = { ...scheme.colors, background, mode: scheme.mode };
    for (const key of Object.keys(scheme.colors)) if (key !== 'background') result[key] = readable(result[key], background);
    const chain = scheme === schemes['eagle-dark'] ? ['#a1e6b3','#80ce99','#62b480','#4d9c6c'] :
      [result.variable, result.definition, result.type, result.variable2];
    chain.forEach((color, i) => { result[`member${i + 1}`] = readable(color, background); });
    return result;
  }

  function mix(a, b, amount) {
    const target = rgb(b);
    return '#' + rgb(a).map((c,i) => Math.round(c + (target[i]-c)*amount).toString(16).padStart(2,'0')).join('');
  }
  function workspacePalette(value, light) {
    // The custom override belongs only to editors, never other workspace areas.
    const p = palette({...normalize(value), backgrounds:{dark:'',light:''}}, light);
    const popup = mix(p.background,p.foreground,.08);
    return {background:p.background, foreground:readable(p.foreground,popup), accent:readable(p.variable,popup),
      muted:readable(p.comment,popup), popup,
      input:mix(p.background,p.mode === 'dark' ? '#000000' : '#ffffff',.12),
      files:mix(p.background,'#000000',p.mode === 'dark' ? .08 : .015),
      shell:mix(p.background,'#000000',p.mode === 'dark' ? .18 : .04),
      resources:mix(p.background,p.foreground,.025), header:mix(p.background,p.foreground,.055)};
  }

  function memberDepth(prefix) {
    const chain = prefix.slice(-4096).match(/(?:\b[A-Za-z_]\w*\s*\.\s*)+$/);
    return chain ? Math.min(4, (chain[0].match(/\./g) || []).length) : /\.\s*$/.test(prefix) ? 1 : 0;
  }

  // CodeMirror normally measures gutters synchronously. Refresh only at digit
  // boundaries and external geometry changes; never on every keystroke/update.
  function attachGeometry(cm, env = window) {
    const wrapper = cm.getWrapperElement();
    let digits = String(cm.lineCount()).length, frame = null, disposed = false;
    function schedule() {
      if (frame !== null || disposed) return;
      frame = env.requestAnimationFrame(() => {
        frame = null;
        if (!wrapper.clientWidth || !wrapper.clientHeight || disposed) return;
        const scroll = cm.getScrollInfo();
        cm.refresh();
        cm.scrollTo(scroll.left, scroll.top);
      });
    }
    const changed = () => {
      const next = String(cm.lineCount()).length;
      if (digits !== next) { digits = next; schedule(); }
    };
    const observer = env.ResizeObserver ? new env.ResizeObserver(schedule) : null;
    observer?.observe(wrapper);
    cm.on('changes', changed);
    cm.on('swapDoc', schedule);
    env.addEventListener('resize', schedule);
    env.document?.fonts?.addEventListener?.('loadingdone', schedule);
    env.document?.fonts?.ready?.then(schedule);
    schedule();
    return () => {
      disposed = true; observer?.disconnect();
      if (frame !== null) env.cancelAnimationFrame(frame);
      cm.off('changes', changed); cm.off('swapDoc', schedule);
      env.removeEventListener('resize', schedule);
      env.document?.fonts?.removeEventListener?.('loadingdone', schedule);
    };
  }

  function installHighlighting(CM) {
    for (const name of ['python','javascript']) {
      const original = CM.modes[name];
      if (!original) continue;
      CM.defineMode(name, (config, options) => {
        const base = original(config, options);
        return { ...base, token(stream, state) {
          const style = base.token(stream, state);
          if (config.eagleLegacyColors || !/(?:^|\s)(?:variable(?:-2)?|property|builtin|def)(?:\s|$)/.test(style || '')) return style;
          const prefix = stream.string.slice(0, stream.start);
          const suffix = stream.string.slice(stream.pos);
          if (/\bclass\s+$/.test(prefix)) return `${style} eagle-type`;
          if (style.includes('def')) return style;
          const depth = memberDepth(prefix);
          if (depth) return `${style} eagle-member-${depth}${/^\s*\(/.test(suffix) ? ' eagle-call' : ''}`;
          if (/^\s*\(/.test(suffix)) return `${style} eagle-call`;
          if (/^\s*=(?!=)/.test(suffix) && /[(,]\s*$/.test(prefix)) return `${style} eagle-parameter`;
          if (/^(?:int|float|str|bool|bytes|list|dict|set|tuple|None|Any|Optional|Union|Callable|ClassVar|InitVar|Self|Literal|[A-Z][a-z]\w*)$/.test(stream.current())) return `${style} eagle-type`;
          return style;
        } };
      });
    }
  }

  let saved = defaults(), draft = defaults(), identity = '', headers = null, generation = 0, edited = false, saving = false;
  const panels = [];
  function lightMode() { return document.body.classList.contains('light-mode'); }
  function apply(cm, preferences = saved) {
    const wrapper = cm.getWrapperElement();
    const p = palette(preferences, lightMode());
    const normalized = normalize(preferences);
    const legacy = !!schemes[normalized.scheme]?.legacy;
    if (wrapper.dataset.editorLegacy !== String(legacy)) {
      wrapper.dataset.editorLegacy = String(legacy);
      cm.setOption('eagleLegacyColors', legacy);
      const mode = cm.getOption?.('mode');
      if (mode) cm.setOption('mode', mode);
    }
    cm.setOption('theme', 'eagle');
    wrapper.dataset.editorMode = contrast('#000000', p.background) > contrast('#ffffff', p.background) ? 'light' : 'dark';
    Object.entries(p).forEach(([key, value]) => { if (key !== 'mode') wrapper.style.setProperty(`--editor-${key}`, value); });
  }
  function applyAll() {
    document.querySelectorAll('.CodeMirror').forEach(wrapper => { if (wrapper.CodeMirror) apply(wrapper.CodeMirror, wrapper.closest('[data-editor-appearance]') ? draft : saved); });
    const p = palette(saved, lightMode());
    const workspace = workspacePalette(saved, lightMode());
    Object.entries(workspace).forEach(([key,value]) => document.body.style?.setProperty(`--workspace-${key}`,value));
    for (const [id, background] of [['editorPanel',workspace.files],['shellPanel',workspace.shell],['rightStackPanel',workspace.resources]]) {
      const panel = document.getElementById(id);
      if (!panel) continue;
      const vars = {bg:background, panel:background, 'panel-hdr':workspace.header, text:workspace.foreground,
        'text-dim':workspace.muted, 'shell-bg':workspace.shell, 'shell-text':workspace.foreground,
        'output-bg':background, 'input-bg':workspace.input, 'tab-bg':workspace.header,
        'tab-btn':workspace.input, btn:workspace.input, 'btn-hover':workspace.header, secondary:workspace.header,
        border:mix(background,workspace.foreground,.25), 'border-mid':mix(background,workspace.foreground,.15)};
      Object.entries(vars).forEach(([key,value]) => panel.style.setProperty(`--theme-${key}`,value));
      panel.style.setProperty('--columbia-blue',workspace.accent);
    }
    for (const id of ['editor', 'teacherStreamEditor']) {
      const ta = document.getElementById(id);
      if (ta) { ta.style.background = p.background; ta.style.color = p.foreground; }
    }
    syncPanels();
  }
  function syncPanels() {
    const p = palette(draft, lightMode());
    for (const panel of panels) {
      panel.querySelector('select').value = draft.scheme;
      panel.querySelector('input[type=color]').value = p.background;
      panel.querySelector('[data-background-label]').textContent = `${p.mode === 'dark' ? 'Dark' : 'Light'} editor background`;
      panel.querySelector('[data-appearance-save]').disabled = !identity || saving;
    }
  }
  function status(message) { panels.forEach(panel => { panel.querySelector('[role=status]').textContent = message; }); }
  const cacheKey = () => `eagle-editor-appearance-v1:${identity}`;
  async function contextChanged() {
    const c = window.EagleIDE?.getContext?.() || {};
    const next = c.ADMIN_TOKEN ? 'admin' : c.currentUser?.email || c.currentTeacher?.email || '';
    const nextHeaders = c.WIKI_MANAGER_TOKEN ? { 'X-Wiki-Manager-Token': c.WIKI_MANAGER_TOKEN } : c.ADMIN_TOKEN ? { 'X-Admin-Token': c.ADMIN_TOKEN } : c.USER_TOKEN ? { 'X-User-Token': c.USER_TOKEN } : c.TEACHER_TOKEN ? { 'X-Teacher-Token': c.TEACHER_TOKEN } : null;
    const signature = JSON.stringify(nextHeaders);
    if (next === identity && signature === JSON.stringify(headers)) return;
    const ticket = ++generation;
    identity = next; headers = nextHeaders; saved = defaults(); edited = false; saving = false;
    if (identity) try { saved = normalize(JSON.parse(localStorage.getItem(cacheKey()))); } catch {}
    draft = normalize(saved); applyAll(); status('');
    if (!headers || !identity) return;
    const loadRevision = editRevision;
    try {
      const response = await fetch('/api/auth/editor-preferences', { headers, signal: AbortSignal.timeout(10000) });
      const data = await response.json();
      if (ticket !== generation || edited || loadRevision !== editRevision) return;
      if (!response.ok || !data.ok) throw new Error('load');
      saved = normalize(data.preferences); draft = normalize(saved); applyAll();
      try { localStorage.setItem(cacheKey(), JSON.stringify(saved)); } catch {}
    } catch { if (ticket === generation) status('Could not load account colors. Cached colors are in use.'); }
  }
  async function save() {
    if (!headers || saving) return;
    const ticket = generation, value = normalize(draft), revision = ++editRevision;
    saving = true;
    panels.forEach(panel => { panel.querySelector('[data-appearance-save]').disabled = true; });
    status('Saving…');
    try {
      const response = await fetch('/api/auth/editor-preferences', { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(value), signal: AbortSignal.timeout(10000) });
      const data = await response.json();
      if (ticket !== generation) return;
      if (!response.ok || !data.ok) throw new Error('save');
      saved = normalize(data.preferences);
      if (revision === editRevision) { draft = normalize(saved); edited = false; }
      applyAll();
      try { localStorage.setItem(cacheKey(), JSON.stringify(saved)); } catch {}
      status(revision === editRevision ? 'Editor colors saved to your account.' : 'Colors saved. Save again to keep your latest preview.');
    } catch { if (ticket === generation) status('Could not save colors. Your preview is kept; try Save editor colors again.'); }
    finally { if (ticket === generation) { saving = false; syncPanels(); } }
  }
  let editRevision = 0;
  function init() {
    if (window.CodeMirror) {
      installHighlighting(window.CodeMirror);
      const tracked = new Map();
      window.CodeMirror.defineInitHook(cm => {
        apply(cm);
        const dispose = attachGeometry(cm);
        tracked.set(cm.getWrapperElement(), dispose);
      });
      // Notebook editors are mounted on demand and removed when a block closes.
      // Release observers/global listeners even when removal bypasses toTextArea.
      new MutationObserver(() => {
        tracked.forEach((dispose, wrapper) => { if (!wrapper.isConnected) { dispose(); tracked.delete(wrapper); } });
      }).observe(document.body, { childList: true, subtree: true });
    }
    document.querySelectorAll('[data-editor-appearance]').forEach((panel, index) => {
      panels.push(panel);
      const id = `editor-colors-${index}`;
      panel.innerHTML = `<h3>Workspace colors</h3><p>Choose colors for the editor, Files, Shell and Resources. Colors save to your account for future sessions.</p>
        <label for="${id}-scheme">Syntax color scheme</label><select id="${id}-scheme"><option value="auto">Follow page theme (Eagle)</option>${Object.entries(schemes).map(([key, scheme]) => `<option value="${key}">${scheme.label}</option>`).join('')}</select>
        <div class="editor-background-control"><label for="${id}-background" data-background-label>Editor background</label><input id="${id}-background" type="color" value="#1e2229"><button class="btn secondary" type="button" data-background-reset>Use scheme background</button></div>
        <p class="editor-colors-help">Each profile supplies a default editor background and matching workspace tones. The background override changes only editors. Legacy restores September token colors with readable contrast. Blue &amp; Gold avoids red/green distinctions; High contrast uses minimal color. Dark and light overrides are saved separately.</p>
        <div class="editor-color-preview" aria-label="Read-only Python color preview"></div><button class="btn run" type="button" data-appearance-save>Save editor colors</button><p role="status" aria-live="polite"></p>`;
      const preview = panel.querySelector('.editor-color-preview');
      if (window.CodeMirror) window.CodeMirror(preview, { value: 'from dataclasses import dataclass\n\n# A typed record and function contract\n@dataclass\nclass Student:\n    name: str\n    score: float = 95.5\n\ndef welcome(student: Student) -> str:\n    return f"Hello, {student.name}!"\n\nprint(welcome(Student("Eagle")))', mode: 'python', readOnly: 'nocursor', lineNumbers: true, cursorBlinkRate: -1, dragDrop: false, viewportMargin: 20 });
      else preview.textContent = 'class Student:\n    name: str\n    score: float = 95.5';
      const update = () => {
        edited = true; editRevision++;
        panels.forEach(p => { const cm = p.querySelector('.CodeMirror')?.CodeMirror; if (cm) apply(cm, draft); });
        syncPanels(); status('Preview updated. Save editor colors to apply.');
      };
      panel.querySelector('select').addEventListener('change', event => { draft.scheme = event.target.value; update(); });
      panel.querySelector('input').addEventListener('input', event => { draft.backgrounds[palette(draft, lightMode()).mode] = event.target.value; update(); });
      panel.querySelector('[data-background-reset]').addEventListener('click', () => { draft.backgrounds[palette(draft, lightMode()).mode] = ''; update(); });
      panel.querySelector('[data-appearance-save]').addEventListener('click', save);
    });
    window.addEventListener('eagle-context-updated', contextChanged);
    syncPanels();
    contextChanged();
  }
  return { schemes, normalize, palette, workspacePalette, memberDepth, contrast, attachGeometry, installHighlighting, apply, applyAll, init };
});
