/** Recorded Python execution playback for students, teachers, and administrators. */
(function () {
  'use strict';

  let state = 'idle';
  let trace = null;
  let pendingTrace = null;
  let pendingError = '';
  let chunks = [];
  let filteredIndexes = [];
  let position = 0;
  let lineHandle = null;
  let narrationWidget = null;
  let originalReadOnly = false;
  let autoplayTimer = null;
  let autoplayActive = false;
  let autoplayDelaySeconds = 1;

  const MIN_AUTOPLAY_SECONDS = 0.5;
  const MAX_AUTOPLAY_SECONDS = 5;
  const AUTOPLAY_STEP_SECONDS = 0.5;

  const $ = (id) => document.getElementById(id);

  function clampStepDelay(value) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return 1;
    return Math.min(MAX_AUTOPLAY_SECONDS, Math.max(MIN_AUTOPLAY_SECONDS, Math.round(numeric * 2) / 2));
  }

  function findPlaybackPosition(indexes, targetTraceIndex) {
    const target = Number(targetTraceIndex);
    if (!Array.isArray(indexes) || !indexes.length || !Number.isInteger(target)) return -1;
    const position = indexes.findIndex((index) => index >= target);
    return position >= 0 ? position : indexes.length - 1;
  }

  function ctx() {
    return window.EagleIDE?.getContext?.() || {};
  }

  function escapeHtml(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function setStatus(message, kind = '') {
    const element = $('stepModeStatus');
    if (!element) return;
    element.textContent = message || '';
    element.classList.toggle('is-error', kind === 'error');
    element.classList.toggle('is-exception', kind === 'exception');
  }

  function updateLaunchButton() {
    const button = $('stepModeBtn');
    if (!button) return;
    button.classList.toggle('is-active', state === 'playback');
    if (state === 'generating') {
      button.textContent = '⏹';
      button.title = 'Stop Step Mode trace';
      button.setAttribute('aria-label', 'Stop Step Mode trace');
    } else if (state === 'playback') {
      button.textContent = '👣';
      button.title = 'Exit Step Mode and return to editing';
      button.setAttribute('aria-label', 'Exit Step Mode');
    } else {
      button.textContent = '👣';
      button.title = 'Start Step Mode';
      button.setAttribute('aria-label', 'Start Step Mode');
    }
  }

  function showPanel() {
    const panel = $('stepModePanel');
    if (panel) panel.hidden = false;
  }

  function clearEditorDecoration() {
    const editor = window.eagleEditor;
    if (editor && lineHandle) {
      try { editor.removeLineClass(lineHandle, 'background', 'cm-step-line'); } catch {}
    }
    if (narrationWidget) {
      try { narrationWidget.clear(); } catch {}
    }
    lineHandle = null;
    narrationWidget = null;
  }

  function setEditorPlaybackLocked(locked) {
    const editor = window.eagleEditor;
    if (!editor) return;
    if (locked) {
      originalReadOnly = editor.getOption('readOnly');
      editor.setOption('readOnly', 'nocursor');
    } else {
      editor.setOption('readOnly', originalReadOnly || false);
    }
  }

  function buildNarrationBubble(step) {
    const bubble = document.createElement('aside');
    bubble.className = `step-narration-bubble${step.event === 'exception' ? ' is-exception' : ''}`;
    bubble.setAttribute('role', 'note');
    bubble.setAttribute('aria-live', 'polite');

    const title = document.createElement('span');
    title.className = 'step-narration-title';
    title.textContent = step.event === 'exception' ? 'Exception explanation' : 'Code narrator';
    bubble.appendChild(title);

    const explanation = document.createElement('div');
    explanation.textContent = step.narration || 'Execute this step.';
    bubble.appendChild(explanation);

    if (step.source) {
      const code = document.createElement('code');
      code.className = 'step-narration-code';
      code.textContent = step.source;
      bubble.appendChild(code);
    }

    const tips = step.exception?.troubleshooting;
    if (Array.isArray(tips) && tips.length) {
      const list = document.createElement('ol');
      list.className = 'step-narration-help';
      tips.forEach((tip) => {
        const item = document.createElement('li');
        item.textContent = String(tip || '');
        list.appendChild(item);
      });
      bubble.appendChild(list);
    }
    return bubble;
  }

  function highlightStep(step) {
    clearEditorDecoration();
    const editor = window.eagleEditor;
    if (!editor || !step) return;
    const maxLine = Math.max(0, editor.lineCount() - 1);
    const line = Math.max(0, Math.min(maxLine, Number(step.line || 1) - 1));
    try {
      lineHandle = editor.addLineClass(line, 'background', 'cm-step-line');
      const bubble = buildNarrationBubble(step);
      narrationWidget = editor.addLineWidget(line, bubble, {
        above: false,
        coverGutter: false,
        noHScroll: true,
        showIfHidden: true,
      });
      editor.scrollIntoView({ line, ch: 0 }, 90);
      editor.refresh();
    } catch (error) {
      console.warn('Could not display Step Mode marker.', error);
    }
  }

  function renderVariables(step) {
    const host = $('stepModeVariables');
    if (!host) return;
    const rows = [...(step.locals || []), ...(step.globals || [])];
    const seen = new Set(rows.map((row) => String(row.name || '')));
    (trace?.definedItems || []).forEach((item) => {
      const name = String(item?.name || '');
      if (!name || seen.has(name)) return;
      rows.push(item);
      seen.add(name);
    });
    const changed = new Set(step.changed || []);
    if (!rows.length) {
      host.innerHTML = '<div class="step-variable-empty">No visible variables at this step.</div>';
      return;
    }
    host.innerHTML = `
      <table class="step-variable-table">
        <thead><tr><th>Name</th><th>Type</th><th>Value</th></tr></thead>
        <tbody>${rows.map((row) => `
          <tr class="step-variable-row${changed.has(row.name) ? ' is-changed' : ''}">
            <td><strong>${escapeHtml(row.name)}</strong><br><span class="step-variable-scope">${escapeHtml(row.scope)}</span></td>
            <td>${escapeHtml(row.type)}</td>
            <td>${escapeHtml(row.value)}</td>
          </tr>`).join('')}</tbody>
      </table>`;
  }

  function renderExecution(step) {
    const host = $('stepModeExecution');
    if (!host) return;
    const eventLabel = {
      line: 'Line', call: 'Function call', return: 'Function return', input: 'Recorded input', exception: 'Exception',
    }[step.event] || step.event;
    const input = step.input
      ? `<div><strong>Recorded input:</strong> ${escapeHtml(step.input.value)}${step.input.prompt ? `<br><span>${escapeHtml(step.input.prompt)}</span>` : ''}</div>`
      : '';
    const returned = step.returnValue !== undefined
      ? `<div><strong>Returned:</strong> <code>${escapeHtml(step.returnValue)}</code></div>`
      : '';
    const exception = step.exception ? `
      <div class="step-exception-card">
        <strong>${escapeHtml(step.exception.type)}:</strong> ${escapeHtml(step.exception.message)}
        ${(step.exception.troubleshooting || []).length ? '<div>See the narrator bubble for troubleshooting steps.</div>' : ''}
      </div>` : '';
    const callChoice = step.event === 'call' && step.supportsStepChoice ? `
      <div class="step-call-choice">
        <button class="btn secondary" id="stepModeIntoBtn" type="button">Step into</button>
        <button class="btn secondary" id="stepModeOverBtn" type="button"${step.canStepOver ? '' : ' disabled'}>Step over</button>
        <div class="step-call-note${step.hasException ? ' is-blocked' : ''}">
          ${step.hasException
            ? 'Step over is blocked because this recorded call raised an exception. Step into it to see where the error occurred.'
            : 'Choose whether to inspect this user-defined code or continue in its caller.'}
        </div>
      </div>` : '';
    host.innerHTML = `
      <div><strong>${escapeHtml(eventLabel)}</strong> · line ${Number(step.line || 1)}</div>
      <div>Function: <code>${escapeHtml(step.qualifiedFunction || step.function || '<module>')}</code> · call depth ${Number(step.depth || 0)}</div>
      ${input}${returned}${exception}${callChoice}`;
    $('stepModeIntoBtn')?.addEventListener('click', stepIntoCurrentCall);
    $('stepModeOverBtn')?.addEventListener('click', stepOverCurrentCall);
  }

  function selectStepIndexes(steps, mode) {
    const all = (Array.isArray(steps) ? steps : []).map((_step, index) => index);
    if (mode !== 'function') return all;
    const selected = all.filter((index) => ['call', 'return', 'input', 'exception'].includes(steps[index]?.event));
    return selected.length ? selected : all;
  }

  function updateFilteredIndexes(reset = false) {
    if (!trace) {
      filteredIndexes = [];
      return;
    }
    const mode = $('stepModeGranularity')?.value || 'line';
    filteredIndexes = selectStepIndexes(trace.steps, mode);
    if (reset) position = 0;
    position = Math.max(0, Math.min(position, Math.max(0, filteredIndexes.length - 1)));
  }

  function renderCurrentStep() {
    if (!trace || !filteredIndexes.length) {
      $('stepModeCounter').textContent = 'Step 0 of 0';
      $('stepModePreviousBtn').disabled = true;
      $('stepModeNextBtn').disabled = true;
      setStatus('This program completed without producing traceable Python statements.');
      return;
    }
    const step = trace.steps[filteredIndexes[position]];
    $('stepModeCounter').textContent = `Step ${position + 1} of ${filteredIndexes.length}`;
    $('stepModePreviousBtn').disabled = position <= 0;
    $('stepModeNextBtn').disabled = position >= filteredIndexes.length - 1;
    $('stepModeDetails').hidden = false;
    renderVariables(step);
    renderExecution(step);
    highlightStep(step);
    ctx().setShellOutput?.(String(trace.output || '').slice(0, Number(step.outputLength || 0)));
    if (step.event === 'call' && step.supportsStepChoice) {
      if (autoplayActive) stopAutoplay();
      if (step.hasException) {
        setStatus('Step over is unavailable because this call raised an exception. Step into the call to inspect it.', 'exception');
      } else {
        setStatus('Choose Step into to inspect this code, or Step over to continue in the caller.');
      }
    } else if (step.event === 'exception') {
      setStatus(`${step.exception?.type || 'Exception'} ended the program. Use the narration and captured values to troubleshoot it.`, 'exception');
    } else if (step.event === 'input') {
      setStatus('This input was captured during execution. Playback will not request another value.');
    } else if (trace.truncated && position === filteredIndexes.length - 1) {
      setStatus('The trace reached its safety limit. The recorded steps remain available.');
    } else if (autoplayActive) {
      setStatus(`Autoplay is advancing every ${autoplayDelaySeconds.toFixed(1)} seconds. It pauses at user-defined calls and exceptions.`);
    } else {
      setStatus('Use the arrow buttons or keyboard arrows to move through the recorded execution.');
    }
  }

  function move(delta, options = {}) {
    if (state !== 'playback' || !filteredIndexes.length) return;
    if (!options.fromAutoplay) stopAutoplay();
    const next = Math.max(0, Math.min(filteredIndexes.length - 1, position + delta));
    if (next === position) return;
    position = next;
    renderCurrentStep();
  }

  function jumpToTraceIndex(traceIndex) {
    const targetPosition = findPlaybackPosition(filteredIndexes, Number(traceIndex));
    if (targetPosition < 0) return;
    stopAutoplay();
    position = targetPosition;
    renderCurrentStep();
  }

  function stepIntoCurrentCall() {
    move(1);
  }

  function stepOverCurrentCall() {
    const step = trace?.steps?.[filteredIndexes[position]];
    if (!step?.canStepOver || !Number.isInteger(Number(step.stepOverIndex))) return;
    jumpToTraceIndex(Number(step.stepOverIndex));
  }

  function updateAutoplayControls() {
    const button = $('stepModeAutoBtn');
    const unavailable = state !== 'playback';
    if (button) {
      button.textContent = autoplayActive ? '⏸ Pause' : '▶ Auto';
      button.title = autoplayActive ? 'Pause autoplay' : 'Start autoplay';
      button.setAttribute('aria-label', button.title);
      button.classList.toggle('is-playing', autoplayActive);
      button.disabled = unavailable;
    }
    if ($('stepModeSpeed')) $('stepModeSpeed').textContent = `${autoplayDelaySeconds.toFixed(1)}s`;
    if ($('stepModeFasterBtn')) $('stepModeFasterBtn').disabled = unavailable || autoplayDelaySeconds <= MIN_AUTOPLAY_SECONDS;
    if ($('stepModeSlowerBtn')) $('stepModeSlowerBtn').disabled = unavailable || autoplayDelaySeconds >= MAX_AUTOPLAY_SECONDS;
  }

  function stopAutoplay() {
    if (autoplayTimer !== null) clearTimeout(autoplayTimer);
    autoplayTimer = null;
    autoplayActive = false;
    updateAutoplayControls();
  }

  function scheduleAutoplay() {
    if (autoplayTimer !== null) clearTimeout(autoplayTimer);
    autoplayTimer = null;
    if (!autoplayActive || state !== 'playback' || !filteredIndexes.length) return;
    const step = trace?.steps?.[filteredIndexes[position]];
    if (position >= filteredIndexes.length - 1) {
      stopAutoplay();
      setStatus('Autoplay reached the end of the recorded execution.');
      return;
    }
    if (step?.event === 'exception' || (step?.event === 'call' && step.supportsStepChoice)) {
      stopAutoplay();
      return;
    }
    autoplayTimer = setTimeout(() => {
      autoplayTimer = null;
      if (!autoplayActive) return;
      move(1, { fromAutoplay: true });
      scheduleAutoplay();
    }, autoplayDelaySeconds * 1000);
  }

  function toggleAutoplay() {
    if (state !== 'playback' || !filteredIndexes.length) return;
    if (autoplayActive) {
      stopAutoplay();
      renderCurrentStep();
      return;
    }
    if (position >= filteredIndexes.length - 1) position = 0;
    const step = trace?.steps?.[filteredIndexes[position]];
    if (step?.event === 'call' && step.supportsStepChoice) {
      setStatus('Choose Step into or Step over before starting autoplay.');
      return;
    }
    autoplayActive = true;
    updateAutoplayControls();
    renderCurrentStep();
    scheduleAutoplay();
  }

  function adjustAutoplaySpeed(deltaSeconds) {
    autoplayDelaySeconds = clampStepDelay(autoplayDelaySeconds + Number(deltaSeconds || 0));
    updateAutoplayControls();
    if (state !== 'playback') return;
    if (autoplayActive) {
      renderCurrentStep();
      scheduleAutoplay();
    } else {
      setStatus(`Autoplay will advance every ${autoplayDelaySeconds.toFixed(1)} seconds.`);
    }
  }

  function decodeTrace(encoded) {
    const binary = atob(encoded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    const payload = JSON.parse(new TextDecoder('utf-8').decode(bytes));
    if (!payload || payload.version !== 1 || !Array.isArray(payload.steps)) throw new Error('Invalid trace payload');
    return payload;
  }

  function activateTrace(payload) {
    trace = payload;
    pendingTrace = null;
    pendingError = '';
    state = 'playback';
    position = 0;
    setEditorPlaybackLocked(true);
    showPanel();
    $('stepModeDetails').hidden = false;
    updateFilteredIndexes(true);
    updateLaunchButton();
    updateAutoplayControls();
    renderCurrentStep();
  }

  async function start() {
    if (state === 'generating') {
      ctx().stopStepTrace?.();
      return;
    }
    if (state === 'playback') {
      exit();
      return;
    }
    const context = ctx();
    const snapshot = context.getEditorSnapshot?.();
    if (!snapshot) return;
    const language = String(snapshot.language || '').toLowerCase();
    if (!language.includes('python')) {
      showPanel();
      setStatus('Step Mode currently supports Python files. JavaScript support is planned next.', 'error');
      return;
    }
    if (!String(snapshot.code || '').trim()) {
      showPanel();
      setStatus('Add some Python code before starting Step Mode.', 'error');
      return;
    }
    exit({ preservePanel: true });
    state = 'generating';
    chunks = [];
    pendingTrace = null;
    pendingError = '';
    showPanel();
    $('stepModeDetails').hidden = true;
    setStatus('Recording one sandboxed execution… If input is requested, enter it in the shell and press Send.');
    updateLaunchButton();
    updateAutoplayControls();
    const started = await context.startStepTrace?.(snapshot);
    if (!started) {
      state = 'idle';
      setStatus('Step Mode could not start because another program is running.', 'error');
      updateLaunchButton();
    }
  }

  function exit(options = {}) {
    stopAutoplay();
    clearEditorDecoration();
    if (state === 'playback') setEditorPlaybackLocked(false);
    state = 'idle';
    trace = null;
    pendingTrace = null;
    pendingError = '';
    chunks = [];
    filteredIndexes = [];
    position = 0;
    $('stepModeDetails')?.setAttribute('hidden', '');
    if (!options.preservePanel) $('stepModePanel')?.setAttribute('hidden', '');
    updateLaunchButton();
    updateAutoplayControls();
  }

  function onRunnerFinished() {
    if (state !== 'generating') return;
    if (pendingTrace) {
      activateTrace(pendingTrace);
      return;
    }
    state = 'idle';
    updateLaunchButton();
    setStatus(pendingError || 'Step Mode stopped before a trace was ready.', pendingError ? 'error' : '');
  }

  function bindSocket() {
    const socket = window.eagleSocket;
    if (!socket || socket.__stepModeBound) return;
    socket.__stepModeBound = true;
    socket.on('trace_chunk', (message) => {
      if (state !== 'generating') return;
      const index = Number(message?.index);
      const total = Number(message?.total);
      if (!Number.isInteger(index) || index < 0 || !Number.isInteger(total) || total < 1 || index >= total) return;
      if (index === 0) chunks = new Array(total);
      chunks[index] = String(message?.data || '');
    });
    socket.on('trace_ready', (message) => {
      if (state !== 'generating') return;
      const expected = Number(message?.chunks || 0);
      try {
        if (!expected || chunks.length !== expected || chunks.some((chunk) => typeof chunk !== 'string')) {
          throw new Error('Missing trace data');
        }
        pendingTrace = decodeTrace(chunks.join(''));
        setStatus('Trace recorded. Preparing playback…');
      } catch (error) {
        pendingError = 'Step Mode could not decode the recorded execution.';
        setStatus(pendingError, 'error');
      }
    });
    socket.on('trace_error', (message) => {
      if (state !== 'generating') return;
      pendingError = String(message?.error || 'Step Mode could not record this execution.');
      setStatus(pendingError, 'error');
    });
  }

  function bindUi() {
    $('stepModeBtn')?.addEventListener('click', start);
    $('stepModePreviousBtn')?.addEventListener('click', () => move(-1));
    $('stepModeNextBtn')?.addEventListener('click', () => move(1));
    $('stepModeAutoBtn')?.addEventListener('click', toggleAutoplay);
    $('stepModeSlowerBtn')?.addEventListener('click', () => adjustAutoplaySpeed(AUTOPLAY_STEP_SECONDS));
    $('stepModeFasterBtn')?.addEventListener('click', () => adjustAutoplaySpeed(-AUTOPLAY_STEP_SECONDS));
    $('stepModeRestartBtn')?.addEventListener('click', () => {
      stopAutoplay();
      position = 0;
      renderCurrentStep();
    });
    $('stepModeExitBtn')?.addEventListener('click', () => exit());
    $('stepModeGranularity')?.addEventListener('change', () => {
      stopAutoplay();
      updateFilteredIndexes(true);
      renderCurrentStep();
    });
    document.addEventListener('keydown', (event) => {
      if (state !== 'playback' || event.altKey || event.ctrlKey || event.metaKey) return;
      const tag = String(event.target?.tagName || '').toLowerCase();
      const isCodeMirrorInput = !!event.target?.closest?.('.CodeMirror');
      if (tag === 'select' || (['input', 'textarea'].includes(tag) && event.target?.id !== 'stdin' && !isCodeMirrorInput)) return;
      if (event.key === 'ArrowLeft') {
        event.preventDefault();
        move(-1);
      } else if (event.key === 'ArrowRight') {
        event.preventDefault();
        move(1);
      } else if (event.key === 'ArrowUp') {
        event.preventDefault();
        adjustAutoplaySpeed(-AUTOPLAY_STEP_SECONDS);
      } else if (event.key === 'ArrowDown') {
        event.preventDefault();
        adjustAutoplaySpeed(AUTOPLAY_STEP_SECONDS);
      }
    });
    bindSocket();
    window.addEventListener('eagle-socket-ready', bindSocket);
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { clampStepDelay, findPlaybackPosition, selectStepIndexes };
    return;
  }

  window.StepMode = {
    start,
    exit,
    move,
    onRunnerFinished,
    isActive: () => state !== 'idle',
    getState: () => state,
  };

  bindUi();
})();
