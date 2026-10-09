/* Shared CodeMirror editing behavior. Keep indentation and folding testable without a browser. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.EagleEditorBehavior = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  const PYTHON_BLOCK = /^\s*(?:async\s+)?(?:if|elif|else|while|for|def|class|try|except|finally|with|match|case)\b.*:\s*(?:#.*)?$/;

  function nextPythonIndent(line, cursorCh) {
    const source = String(line || '');
    if (!source.trim()) return { clearBlankLine: true, text: '\n' };
    const base = source.match(/^[\t ]*/)[0];
    const before = source.slice(0, cursorCh);
    const blockStart = /:\s*(?:#.*)?$/.test(before) && PYTHON_BLOCK.test(source);
    return { clearBlankLine: false, text: `\n${base}${blockStart ? '\t' : ''}` };
  }

  function enter(cm) {
    const mode = String(cm.getOption('mode') || '').toLowerCase();
    if (!mode.includes('python') || cm.somethingSelected?.()) {
      cm.execCommand('newlineAndIndent');
      return;
    }
    const cursor = cm.getCursor();
    const line = cm.getLine(cursor.line);
    const next = nextPythonIndent(line, cursor.ch);
    if (next.clearBlankLine) {
      cm.replaceRange('\n', { line: cursor.line, ch: 0 }, { line: cursor.line, ch: line.length }, '+input');
      cm.setCursor({ line: cursor.line + 1, ch: 0 });
    } else {
      cm.replaceSelection(next.text, 'end', '+input');
    }
  }

  function normalizePastedIndentation(text) {
    const source = String(text ?? '');
    const lines = source.split('\n');
    const counts = lines
      .filter(line => line.trim())
      .map(line => (line.match(/^ +/) || [''])[0].length)
      .filter(count => count > 0);
    if (!counts.length || Math.max(...counts) < 2) return source;
    const gcd = (left, right) => right ? gcd(right, left % right) : left;
    const common = counts.reduce(gcd);
    const unit = common >= 2 ? Math.min(4, common) : (counts.every(count => count % 4 === 0) ? 4 : 0);
    if (!unit) return source;
    return lines.map(line => {
      const spaces = (line.match(/^ +/) || [''])[0].length;
      if (spaces < unit) return line;
      return '\t'.repeat(Math.floor(spaces / unit)) + ' '.repeat(spaces % unit) + line.slice(spaces);
    }).join('\n');
  }

  function foldRange(cm, start, codeMirror) {
    const mode = String(cm.getOption('mode') || '').toLowerCase();
    if (mode.includes('python')) {
      if (!PYTHON_BLOCK.test(cm.getLine(start.line) || '')) return null;
      return codeMirror.fold?.indent?.(cm, start) || null;
    }
    return codeMirror.fold?.auto?.(cm, start) || null;
  }

  function unfoldLine(cm, line) {
    if (!cm?.findMarksAt || !Number.isInteger(line) || line < 0) return;
    // A line may sit inside several nested folds. Clear only folds that hide it.
    for (let pass = 0; pass < 32; pass += 1) {
      const folds = cm.findMarksAt({ line, ch: 0 }).filter(mark => mark.__isFold);
      if (!folds.length) break;
      folds.forEach(mark => mark.clear());
    }
    cm.scrollIntoView?.({ line, ch: 0 }, 80);
  }

  return { nextPythonIndent, normalizePastedIndentation, enter, foldRange, unfoldLine };
});
