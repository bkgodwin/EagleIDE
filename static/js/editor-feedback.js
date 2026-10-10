/* Local, bounded editing hints. This never executes or sends student code. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.EagleEditorFeedback = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';
  const MAX_SOURCE = 100000;
  const MAX_MARKS = 1000;
  const OPEN = '([{', CLOSE = ')]}';
  const PY_BLOCK = /^(?:async\s+)?(?:if|elif|else|while|for|def|class|try|except|finally|with|match|case)\b/;
  const PY_RUNTIME_NAMES = new Set('ArithmeticError AssertionError AttributeError BaseException BaseExceptionGroup BlockingIOError BrokenPipeError BufferError BytesWarning ChildProcessError ConnectionAbortedError ConnectionError ConnectionRefusedError ConnectionResetError DeprecationWarning EOFError Ellipsis EncodingWarning EnvironmentError Exception ExceptionGroup False FileExistsError FileNotFoundError FloatingPointError FutureWarning GeneratorExit IOError ImportError ImportWarning IndentationError IndexError InterruptedError IsADirectoryError KeyError KeyboardInterrupt LookupError MemoryError ModuleNotFoundError NameError None NotADirectoryError NotImplemented NotImplementedError OSError OverflowError PendingDeprecationWarning PermissionError ProcessLookupError PythonFinalizationError RecursionError ReferenceError ResourceWarning RuntimeError RuntimeWarning StopAsyncIteration StopIteration SyntaxError SyntaxWarning SystemError SystemExit TabError TimeoutError True TypeError UnboundLocalError UnicodeDecodeError UnicodeEncodeError UnicodeError UnicodeTranslateError UnicodeWarning UserWarning ValueError Warning WindowsError ZeroDivisionError abs aiter all anext any ascii bin bool breakpoint bytearray bytes callable chr classmethod compile complex copyright credits delattr dict dir divmod enumerate eval exec exit filter float format frozenset getattr globals hasattr hash help hex id input int isinstance issubclass iter len license list locals map max memoryview min next object oct open ord pow print property quit range repr reversed round set setattr slice sorted staticmethod str sum super tuple type vars zip __name__ __doc__ __file__ __package__ __annotations__ __builtins__ __debug__ __import__'.split(' '));
  const JS_BUILTINS = new Set(('Array Boolean console Date document fetch JSON Map Math Number Object parseFloat parseInt Promise RegExp Set String window globalThis Infinity NaN undefined Error TypeError RangeError SyntaxError Symbol BigInt WeakMap WeakSet Intl Reflect Proxy Uint8Array').split(' '));
  const JS_KEYWORDS = new Set('as async await break case catch class const continue debugger default delete do else export extends false finally for from function get if import in instanceof let new null of return set static super switch this throw true try typeof var void while with yield'.split(' '));

  function modeName(mode) {
    const name = String(typeof mode === 'object' ? mode.name : mode || '').toLowerCase();
    if (name.includes('python')) return 'python';
    if (name.includes('javascript')) return 'javascript';
    if (name.includes('css')) return 'css';
    return 'html';
  }

  // Keep positions unchanged while excluding strings, comments and JS regex literals.
  // In the browser CodeMirror's language tokens provide the authoritative mask.
  function maskSource(source, language) {
    const chars = source.split('');
    const hide = (start, end) => {
      for (let i = start; i < end; i++) if (chars[i] !== '\n') chars[i] = ' ';
    };
    const strings = [];
    for (let i = 0; i < source.length;) {
      const start = i, char = source[i];
      if ((language === 'python' && char === '#') || (language !== 'python' && source.slice(i, i + 2) === '//')) {
        const end = source.indexOf('\n', i);
        i = end < 0 ? source.length : end;
        hide(start, i);
      } else if (language !== 'python' && source.slice(i, i + 2) === '/*') {
        const end = source.indexOf('*/', i + 2);
        i = end < 0 ? source.length : end + 2;
        hide(start, i);
      } else if ('"\'`'.includes(char)) {
        const triple = language === 'python' && source.slice(i, i + 3) === char.repeat(3);
        const delimiter = triple ? char.repeat(3) : char;
        i += delimiter.length;
        let closed = false;
        while (i < source.length) {
          if (source[i] === '\\') { i += 2; continue; }
          if (source.slice(i, i + delimiter.length) === delimiter) { i += delimiter.length; closed = true; break; }
          if (source[i] === '\n' && !triple && char !== '`') break;
          i++;
        }
        strings.push({ start, end: Math.min(i, source.length), closed, delimiter });
        hide(start, Math.min(i, source.length));
      } else if (language === 'javascript' && char === '/' && /(?:^|[=(:,!\[{};?]|\breturn)\s*$/.test(source.slice(Math.max(0, i - 30), i))) {
        i++;
        let inClass = false;
        while (i < source.length && source[i] !== '\n') {
          if (source[i] === '\\') { i += 2; continue; }
          if (source[i] === '[') inClass = true;
          if (source[i] === ']') inClass = false;
          if (source[i++] === '/' && !inClass) break;
        }
        hide(start, i);
      } else i++;
    }
    return { masked: chars.join(''), strings };
  }

  function offsetsFor(source) {
    const offsets = [0];
    for (let i = 0; i < source.length; i++) if (source[i] === '\n') offsets.push(i + 1);
    return offsets;
  }

  function positionAt(offsets, index) {
    let low = 0, high = offsets.length;
    while (low + 1 < high) {
      const middle = (low + high) >> 1;
      if (offsets[middle] <= index) low = middle; else high = middle;
    }
    return { line: low, ch: index - offsets[low] };
  }

  function indentColumns(line, tabSize) {
    let column = 0;
    for (const char of line.match(/^[\t ]*/)[0]) column = char === '\t' ? column + tabSize - column % tabSize : column + 1;
    return column;
  }

  function blockColon(text) {
    let depth = 0;
    for (let index = 0; index < text.length; index++) {
      if (OPEN.includes(text[index])) depth++;
      else if (CLOSE.includes(text[index])) depth--;
      else if (text[index] === ':' && depth === 0) return index;
    }
    return -1;
  }

  function commaParts(text) {
    const parts = [];
    let depth = 0, start = 0;
    for (let index = 0; index < text.length; index++) {
      if (OPEN.includes(text[index])) depth++;
      else if (CLOSE.includes(text[index])) depth--;
      else if (text[index] === ',' && depth === 0) { parts.push(text.slice(start, index)); start = index + 1; }
    }
    parts.push(text.slice(start));
    return parts;
  }

  function analyze(source, language, autocomplete, tokenMask, tabSize = 4) {
    const result = { source, language, offsets: offsetsFor(source), diagnostics: [], brackets: [], openLines: [], guides: [], names: new Set(), builtins: new Set(), tooLarge: source.length > MAX_SOURCE };
    if (result.tooLarge) return result;
    const lexical = maskSource(source, language);
    const masked = result.masked = tokenMask ?? lexical.masked;
    const report = (start, end, message, severity = 'error') => {
      if (result.diagnostics.length < 100) result.diagnostics.push({ start, end: Math.max(start + 1, end), message, severity });
    };
    // HTML contains embedded languages; its delimiters cannot be treated as one program.
    if (language === 'html') return result;
    const stack = [];
    for (let index = 0; index < masked.length; index++) {
      const char = masked[index];
      if (OPEN.includes(char)) stack.push({ start: index, char });
      else if (CLOSE.includes(char)) {
        const top = stack[stack.length - 1];
        if (top && OPEN.indexOf(top.char) === CLOSE.indexOf(char)) {
          stack.pop();
          result.brackets.push({ ...top, end: index, closed: true });
        } else {
          report(index, index + 1, `Unexpected '${char}'. Check for a missing '${OPEN[CLOSE.indexOf(char)]}' or a mismatched bracket.`);
          if (!top) result.brackets.push({ start: index, char, end: source.length, closed: false, orphan: true });
        }
      }
    }
    stack.forEach(item => {
      result.brackets.push({ ...item, end: source.length, closed: false });
      report(item.start, item.start + 1, `Unclosed '${item.char}'. Add '${CLOSE[OPEN.indexOf(item.char)]}' to finish this group.`);
    });
    // Token masks exclude multiline literals; only trust the lexer for strings when
    // its opening quote is also classified as a string by the language mode.
    const openStrings = lexical.strings.filter(item => !item.closed && (!tokenMask || tokenMask[item.start] === ' '));
    openStrings.forEach(item => {
      report(item.start, item.start + item.delimiter.length, `Unclosed string. Add a matching ${item.delimiter} quote.`);
    });

    const lines = masked.split('\n');
    // Full-width backgrounds cover every visible row in an unfinished construct.
    // Merge ranges once so viewport updates stay linear in visible rows.
    const openDepth = new Int32Array(lines.length + 1);
    [...result.brackets.filter(item => !item.closed && !item.orphan), ...openStrings].forEach(item => {
      const from = positionAt(result.offsets, item.start).line;
      const to = positionAt(result.offsets, Math.max(item.start, item.end - (item.delimiter ? 1 : 0))).line;
      openDepth[from]++; openDepth[to + 1]--;
    });
    let openCount = 0;
    for (let line = 0; line < lines.length; line++) {
      openCount += openDepth[line]; result.openLines[line] = openCount > 0;
    }
    // A difference array avoids rescanning every bracket on every source line.
    const continuation = new Int32Array(lines.length + 1);
    result.brackets.forEach(item => {
      if (item.orphan) return;
      const from = positionAt(result.offsets, item.start).line, to = positionAt(result.offsets, item.end).line;
      if (to > from) { continuation[from + 1]++; continuation[to + 1]--; }
    });
    let depth = 0;
    for (let line = 0; line < lines.length; line++) { depth += continuation[line]; continuation[line] = depth; }
    if (language === 'python') {
      const blocks = [];
      let pendingHeader = null;
      for (let line = 0; line < lines.length; line++) {
        const text = lines[line], trimmed = text.trim();
        if (!trimmed) continue;
        const indent = indentColumns(text, tabSize);
        if (continuation[line]) {
          blocks.forEach(block => { block.last = line; });
          if (pendingHeader && trimmed.endsWith(':')) {
            blocks.push({ line: pendingHeader.line, last: line, indent: pendingHeader.indent });
            pendingHeader = null;
          }
          continue;
        }
        pendingHeader = null;
        while (blocks.length && indent <= blocks[blocks.length - 1].indent) {
          const block = blocks.pop();
          if (block.last > block.line) result.guides.push({ from: block.line + 1, to: block.last, column: block.indent });
        }
        blocks.forEach(block => { block.last = line; });
        if (PY_BLOCK.test(trimmed)) {
          const colon = blockColon(trimmed);
          if (colon >= 0) {
            if (!trimmed.slice(colon + 1).trim()) blocks.push({ line, last: line, indent });
          } else if (continuation[line + 1] || /\\$/.test(trimmed)) pendingHeader = { line, indent };
          else {
            report(result.offsets[line] + Math.max(0, text.trimEnd().length - 1), result.offsets[line] + text.trimEnd().length, "A Python block header needs ':' at the end.");
          }
        }
      }
      blocks.forEach(block => {
        if (block.last > block.line) result.guides.push({ from: block.line + 1, to: block.last, column: block.indent });
      });
    }
    result.brackets.forEach(item => {
      if (item.orphan) return;
      const from = positionAt(result.offsets, item.start).line, to = positionAt(result.offsets, item.end).line;
      if (to > from) result.guides.push({ from: from + 1, to, column: indentColumns(lines[from], tabSize) });
    });

    if (language !== 'python' && language !== 'javascript') return result;
    // Reuse the completion catalog for user symbols, with strings/comments masked.
    const symbols = language === 'python' ? autocomplete?.analyzePython(masked) : autocomplete?.analyzeJavascript(masked);
    for (const kind of ['variables', 'functions', 'classes']) (symbols?.[kind] || []).forEach(item => result.names.add(item.name));
    for (const collection of [symbols?.methods, symbols?.attributes, symbols?.objectAttributes]) {
      collection?.forEach(items => items.forEach(item => result.names.add(item.name)));
    }
    const builtins = language === 'python' ? [...(autocomplete?.PYTHON_BUILTINS || []), ...(autocomplete?.PYTHON_KEYWORDS || []), ...PY_RUNTIME_NAMES] : [...JS_BUILTINS, ...JS_KEYWORDS];
    result.builtins = new Set(builtins);

    // Extra bindings cover tuple assignment, parameters, comprehensions and aliases.
    // These hints intentionally do not claim to perform full scope/type analysis.
    const known = new Set([...result.names, ...builtins]);
    const bind = text => {
      for (const match of text.matchAll(/[A-Za-z_$][\w$]*/g)) { known.add(match[0]); result.names.add(match[0]); }
    };
    if (language === 'python') {
      for (const match of masked.matchAll(/\b(?:def|class)\s+([A-Za-z_]\w*)/g)) bind(match[1]);
      for (const match of masked.matchAll(/\bdef\s+\w+\s*\(([^)]*)\)/g)) {
        match[1].split(',').forEach(param => bind((param.match(/^\s*\*{0,2}([A-Za-z_]\w*)/) || [])[1] || ''));
      }
      for (const match of masked.matchAll(/\bfor\s+([\w\s,]+?)\s+in\b/g)) bind(match[1]);
      for (const match of masked.matchAll(/\b(?:as|global|nonlocal)\s+([\w, ]+)/g)) bind(match[1]);
      for (const match of masked.matchAll(/(?:^|[\n;])\s*\(?([A-Za-z_]\w*(?:\s*,\s*\*?[A-Za-z_]\w*)*)\)?\s*(?::[^=\n]+)?=(?!=)/g)) bind(match[1]);
      for (const match of masked.matchAll(/\bimport\s+([^\n;]+)/g)) bind(match[1]);
      for (const match of masked.matchAll(/\bimport\s*\(([^)]*)\)/g)) bind(match[1]);
      for (const match of masked.matchAll(/\b([A-Za-z_]\w*)\s*:=/g)) bind(match[1]);
      // Dynamic namespaces and pattern bindings make lexical name hints unreliable.
      const dynamic = /\b(?:exec|eval|globals|locals|lambda|match|case)\b|\bimport\s+\*/.test(masked);
      if (!dynamic) {
        for (const match of masked.matchAll(/[A-Za-z_]\w*/g)) {
          const name = match[0], start = match.index, end = start + name.length;
          if (known.has(name) || /[\w.]/.test(masked[start - 1] || '') || /^\s*=(?!=)/.test(masked.slice(end))) continue;
          const pos = positionAt(result.offsets, start);
          if (/^\s*(?:from|import)\b/.test(lines[pos.line]) || /^(?:r|u|b|f|fr|rf|br|rb)$/i.test(name) && /["']/.test(source[end] || '')) continue;
          result.names.add(name);
          report(start, end, `'${name}' may be undefined. Check the spelling and define or import it before use.`, 'warning');
        }
      }
    } else {
      for (const match of masked.matchAll(/\b(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/g)) bind(match[1]);
      for (const match of masked.matchAll(/\b(?:const|let|var)\s+([^;]+)/g)) {
        commaParts(match[1]).forEach(part => bind((part.match(/^\s*([A-Za-z_$][\w$]*)/) || [])[1] || ''));
      }
      for (const match of masked.matchAll(/\b(?:const|let|var)\s+[\[{]([^\]}]*)[\]}]/g)) {
        // Destructured aliases use the name after ':'; ordinary properties bind themselves.
        match[1].split(',').forEach(part => bind((part.split(':').pop().match(/^\s*(?:\.\.\.)?([A-Za-z_$][\w$]*)/) || [])[1] || ''));
      }
      for (const match of masked.matchAll(/\bfunction\s*[\w$]*\s*\(([^)]*)\)|\(([^)]*)\)\s*=>|\b([A-Za-z_$][\w$]*)\s*=>/g)) {
        (match[1] || match[2] || match[3] || '').split(',').forEach(param => {
          if (/^\s*[\[{]/.test(param)) bind(param.split('=')[0]);
          else bind((param.match(/^\s*(?:\.\.\.)?([A-Za-z_$][\w$]*)/) || [])[1] || '');
        });
      }
      for (const match of masked.matchAll(/\b([A-Za-z_$][\w$]*)\s*\(([^)]*)\)\s*\{/g)) {
        if (JS_KEYWORDS.has(match[1])) continue;
        bind(match[1]);
        match[2].split(',').forEach(param => bind(param.split('=')[0]));
      }
      for (const match of masked.matchAll(/\bcatch\s*\(([^)]*)\)|\bimport\s+([^;\n]+)/g)) bind(match[1] || match[2]);
      for (const match of masked.matchAll(/\bimport\s+([\s\S]*?)\bfrom\b/g)) bind(match[1]);
      const dynamic = /\b(?:eval|with)\b/.test(masked);
      if (!dynamic) {
        for (const match of masked.matchAll(/[A-Za-z_$][\w$]*/g)) {
          const name = match[0], start = match.index, end = start + name.length;
          const before = masked.slice(Math.max(0, start - 20), start);
          if (known.has(name) || /[\w$]/.test(masked[start - 1] || '') || /\.\s*$/.test(before) || /^\s*(?:[:=](?!=))/.test(masked.slice(end))) continue;
          result.names.add(name);
          report(start, end, `'${name}' may be undefined. Check the spelling and declare or import it before use.`, 'warning');
        }
      }
    }
    return result;
  }

  function occurrences(model, index, selection = '') {
    if (model.tooLarge) return [];
    let needle = selection, wholeWord = false;
    if (!needle) {
      const masked = model.masked || '';
      let start = index, end = index;
      while (start > 0 && /[\w$]/.test(masked[start - 1])) start--;
      while (end < masked.length && /[\w$]/.test(masked[end])) end++;
      needle = masked.slice(start, end);
      if (!needle || !model.names.has(needle) || model.builtins.has(needle)) return [];
      wholeWord = true;
    }
    if (!needle.trim() || needle.length > 1000) return [];
    const haystack = wholeWord ? model.masked : model.source;
    const ranges = [];
    for (let offset = 0; ranges.length < MAX_MARKS;) {
      const start = haystack.indexOf(needle, offset);
      if (start < 0) break;
      const end = start + needle.length;
      if (!wholeWord || (!/[\w$]/.test(haystack[start - 1] || '') && !/[\w$]/.test(haystack[end] || ''))) ranges.push({ start, end });
      offset = end;
    }
    return ranges;
  }

  function bracketRange(model, index) {
    if (model.tooLarge) return null;
    const adjacent = model.brackets.filter(item => item.start === index || item.start + 1 === index || item.closed && (item.end === index || item.end + 1 === index));
    const enclosing = model.brackets.filter(item => item.start < index && item.end >= index);
    const candidates = adjacent.length ? adjacent : enclosing;
    return candidates.sort((a, b) => (a.end - a.start) - (b.end - b.start))[0] || null;
  }

  function attach(cm, options = {}) {
    const doc = options.document || (typeof document !== 'undefined' ? document : null);
    const autocomplete = options.autocomplete || (typeof window !== 'undefined' ? window.EagleAutocomplete : null);
    let model = null, sourceTimer = null, cursorTimer = null, generation = 0;
    let issueMarks = [], cursorMarks = [], spaceMarks = [], openLineHandles = [], activeLine = null;
    const wrapper = cm.getWrapperElement();
    const status = doc.createElement('button');
    status.type = 'button'; status.className = 'eagle-editor-status';
    status.setAttribute('aria-expanded', 'false');
    status.setAttribute('aria-label', 'Editor hints');
    const panel = doc.createElement('div');
    panel.className = 'eagle-editor-hints'; panel.hidden = true;
    panel.setAttribute('role', 'region'); panel.setAttribute('aria-label', 'Editor hints');
    wrapper.append(status, panel);
    const clear = marks => { marks.forEach(mark => mark.clear()); marks.length = 0; };
    const mark = (ranges, collection, className) => ranges.forEach(item => {
      collection.push(cm.markText(positionAt(model.offsets, item.start), positionAt(model.offsets, item.end), { className, title: item.message }));
    });
    function updateActiveLine() {
      const line = cm.getCursor().line;
      if (activeLine != null && cm.getLineNumber(activeLine) === line) return;
      if (activeLine != null) cm.removeLineClass(activeLine, 'background', 'eagle-active-line');
      activeLine = cm.addLineClass(line, 'background', 'eagle-active-line');
    }
    function clearOpenLines() {
      openLineHandles.forEach(handle => cm.removeLineClass(handle, 'background', 'eagle-open-range-line'));
      openLineHandles = [];
    }
    function updateCursor() {
      if (!model || model.source !== cm.getValue()) return;
      cm.operation(() => {
        clear(cursorMarks);
        const cursor = cm.getCursor(), index = model.offsets[cursor.line] + cursor.ch;
        const selection = cm.getSelection();
        // Multiple selections have no single unambiguous occurrence target.
        if (cm.listSelections().length !== 1) return;
        mark(occurrences(model, index, selection), cursorMarks, 'eagle-occurrence');
        if (!selection) {
          const range = bracketRange(model, index);
          if (range) mark([{ start: range.start, end: range.closed ? range.end + 1 : range.end }], cursorMarks, 'eagle-bracket-range');
        }
      });
    }
    function updateSpaces() {
      clear(spaceMarks);
      clearOpenLines();
      const viewport = cm.getViewport();
      cm.operation(() => {
        let count = 0;
        for (let line = viewport.from; line < Math.min(viewport.to, viewport.from + MAX_MARKS) && count < MAX_MARKS; line++) {
          if (model?.openLines[line]) openLineHandles.push(cm.addLineClass(line, 'background', 'eagle-open-range-line'));
          const prefix = (cm.getLine(line) || '').match(/^[\t ]*/)[0];
          for (const match of prefix.matchAll(/ +/g)) {
            if (count++ >= MAX_MARKS) break;
            spaceMarks.push(cm.markText({ line, ch: match.index }, { line, ch: match.index + match[0].length }, { className: 'eagle-indent-spaces', title: 'Leading spaces: use Tab for indentation in EagleIDE.' }));
          }
        }
      });
    }
    function renderStatus() {
      panel.textContent = '';
      const issues = model.diagnostics;
      status.textContent = model.tooLarge ? 'Hints paused: large file' : issues.length ? `${issues.length} editor hint${issues.length === 1 ? '' : 's'}` : 'No editor hints';
      status.title = 'Local editing hints; run your program to check it fully.';
      if (!issues.length) {
        const empty = doc.createElement('p');
        empty.textContent = model.tooLarge ? 'Live analysis pauses above 100,000 characters. Leading-space warnings remain available.' : 'No common issues found. Run your program to check it fully.';
        panel.appendChild(empty);
      }
      issues.forEach(item => {
        const pos = positionAt(model.offsets, item.start), button = doc.createElement('button');
        button.type = 'button'; button.className = `eagle-hint-${item.severity}`;
        button.textContent = `Line ${pos.line + 1}: ${item.message}`;
        button.addEventListener('click', () => {
          if (model.source !== cm.getValue()) return;
          if (typeof window !== 'undefined') window.EagleEditorBehavior?.unfoldLine(cm, pos.line);
          cm.setCursor(pos); cm.scrollIntoView(pos, 60); cm.focus();
        });
        panel.appendChild(button);
      });
    }
    function rebuild() {
      sourceTimer = null;
      const source = cm.getValue(), language = modeName(cm.getOption('mode'));
      let tokenMask;
      if (source.length <= MAX_SOURCE) {
        tokenMask = source.split('');
        let offset = 0;
        for (let line = 0; line < cm.lineCount(); line++) {
          for (const token of cm.getLineTokens(line, true)) {
            if (/(?:comment|string)/.test(token.type || '')) for (let ch = token.start; ch < token.end; ch++) tokenMask[offset + ch] = ' ';
          }
          offset += cm.getLine(line).length + 1;
        }
        tokenMask = tokenMask.join('');
      }
      model = analyze(source, language, autocomplete, tokenMask, cm.getOption('tabSize') || 4);
      cm.operation(() => {
        clear(issueMarks);
        for (const severity of ['error', 'warning']) mark(model.diagnostics.filter(item => item.severity === severity), issueMarks, `eagle-diagnostic-${severity}`);
        updateSpaces(); updateActiveLine(); updateCursor();
      });
      renderStatus();
      cm.refresh();
    }
    function invalidate() {
      generation++;
      clearTimeout(sourceTimer); clearTimeout(cursorTimer);
      cm.operation(() => { clear(issueMarks); clear(cursorMarks); clear(spaceMarks); clearOpenLines(); updateActiveLine(); });
      model = null;
      panel.hidden = true; status.setAttribute('aria-expanded', 'false'); status.textContent = 'Checking…';
      sourceTimer = setTimeout(rebuild, 180);
    }
    cm.on('changes', invalidate);
    cm.on('optionChange', (_cm, option) => { if (option === 'mode' || option === 'tabSize') invalidate(); });
    cm.on('cursorActivity', () => {
      // Caret guidance is immediate, including while source analysis is pending.
      updateActiveLine();
      clearTimeout(cursorTimer);
      const current = generation;
      cursorTimer = setTimeout(() => { if (generation === current) updateCursor(); }, 40);
    });
    cm.on('viewportChange', () => { if (model) updateSpaces(); });
    cm.on('renderLine', (_cm, line, element) => {
      if (!model || model.tooLarge) return;
      const lineNumber = cm.getLineNumber(line);
      const columns = new Set(model.guides.filter(guide => lineNumber >= guide.from && lineNumber <= guide.to).map(guide => guide.column));
      element.style.backgroundImage = [...columns].slice(0, 32).map(column => {
        const x = 4 + column * cm.defaultCharWidth();
        return `linear-gradient(to right, transparent ${x}px, var(--eagle-block-guide) ${x}px, var(--eagle-block-guide) ${x + 1}px, transparent ${x + 1}px)`;
      }).join(',');
    });
    // Consume Insert before CodeMirror's built-in toggleOverwrite binding.
    cm.addKeyMap({ Insert: editor => editor.toggleOverwrite(false) });
    cm.on('keydown', (_cm, event) => {
      if (event.key === 'Insert' && !event.ctrlKey && !event.altKey && !event.metaKey && !event.shiftKey) { event.preventDefault(); cm.toggleOverwrite(false); }
    });
    status.addEventListener('click', () => { panel.hidden = !panel.hidden; status.setAttribute('aria-expanded', String(!panel.hidden)); });
    panel.addEventListener('keydown', event => { if (event.key === 'Escape') { panel.hidden = true; status.setAttribute('aria-expanded', 'false'); status.focus(); } });
    rebuild();
    return { rebuild, getModel: () => model };
  }
  return { MAX_SOURCE, modeName, maskSource, analyze, occurrences, bracketRange, positionAt, attach };
});
