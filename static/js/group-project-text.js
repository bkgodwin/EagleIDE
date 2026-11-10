(() => {
  'use strict';
  const width = p => typeof p === 'string' ? p.length : Math.abs(p);
  const append = (parts, part) => {
    if (!part) return;
    const last = parts.at(-1);
    if (typeof last === typeof part && (typeof part === 'string' || Math.sign(last) === Math.sign(part))) {
      parts[parts.length - 1] += part;
    } else parts.push(part);
  };
  function stream(parts) {
    let i = 0, part = parts[0] || 0;
    return {
      get part() { return part; },
      take(n = width(part)) {
        const piece = typeof part === 'string' ? part.slice(0, n) : Math.sign(part) * n;
        part = typeof part === 'string' ? part.slice(n) : part - piece;
        if (!part) part = parts[++i] || 0;
        return piece;
      },
    };
  }
  const base = parts => parts.reduce((n, p) => n + (typeof p === 'number' ? width(p) : 0), 0);
  function transform(parts, over, before = false) {
    if (base(parts) !== base(over)) throw new Error('Shared edit bases differ');
    const a = stream(parts), b = stream(over), result = [];
    while (a.part || b.part) {
      if (typeof a.part === 'string' && (before || typeof b.part !== 'string')) append(result, a.take());
      else if (typeof b.part === 'string') append(result, b.take().length);
      else {
        const n = Math.min(width(a.part), width(b.part));
        const left = a.take(n), right = b.take(n);
        if (right > 0) append(result, left);
      }
    }
    return result;
  }
  function compose(first, second) {
    const a = stream(first), b = stream(second), result = [];
    while (a.part || b.part) {
      if (typeof b.part === 'string') append(result, b.take());
      else if (typeof a.part === 'number' && a.part < 0) append(result, a.take());
      else {
        const n = Math.min(width(a.part), width(b.part));
        if (!n) throw new Error('Shared edit lengths differ');
        const left = a.take(n), right = b.take(n);
        if (right > 0) append(result, left);
        else if (typeof left === 'number') append(result, right);
      }
    }
    return result;
  }
  function apply(source, parts) {
    if (base(parts) !== source.length) throw new Error('Shared file revision is out of date');
    let offset = 0, result = '';
    for (const part of parts) {
      if (typeof part === 'string') result += part;
      else {
        if (part > 0) result += source.slice(offset, offset + part);
        offset += width(part);
      }
    }
    return result;
  }
  function inverse(source, parts) {
    let offset = 0;
    const result = [];
    for (const part of parts) {
      if (typeof part === 'string') append(result, -part.length);
      else {
        append(result, part > 0 ? part : source.slice(offset, offset - part));
        offset += width(part);
      }
    }
    return result;
  }
  const splice = (length, start, end, text) => [start, start - end, text, length - end].filter(Boolean);
  function diff(before, after) {
    let start = 0, end = 0;
    while (start < Math.min(before.length, after.length) && before[start] === after[start]) start++;
    if (/[\uDC00-\uDFFF]/.test(before[start] || '')) start--;
    while (end < Math.min(before.length, after.length) - start && before.at(-end - 1) === after.at(-end - 1)) end++;
    if (end && /[\uDC00-\uDFFF]/.test(before[before.length - end] || '')) end--;
    return splice(before.length, start, before.length - end, after.slice(start, after.length - end));
  }
  function edits(parts) {
    const result = [];
    let offset = 0, current;
    for (const part of parts) {
      if (typeof part === 'number' && part > 0) {
        offset += part;
        current = null;
      } else {
        if (!current) result.push(current = {start:offset, end:offset, text:''});
        if (typeof part === 'string') current.text += part;
        else current.end = offset -= part;
      }
    }
    return result;
  }
  function mapPosition(position, parts) {
    let old = 0, next = 0;
    for (const part of parts) {
      if (typeof part === 'string') next += part.length;
      else {
        if (position < old + width(part)) return next + (part > 0 ? position - old : 0);
        old += width(part);
        if (part > 0) next += part;
      }
    }
    return next;
  }
  function mapSpans(spans, parts, author) {
    const result = [];
    let old = 0, next = 0, i = 0;
    const mark = (from, to, id) => {
      if (result.at(-1)?.[1] === from && result.at(-1)[2] === id) result.at(-1)[1] = to;
      else result.push([from, to, id]);
    };
    for (const part of parts) {
      if (typeof part === 'string') {
        if (author) mark(next, next + part.length, author);
        next += part.length;
        continue;
      }
      const end = old + width(part);
      while (i < spans.length && spans[i][0] < end) {
        const [start, stop, person] = spans[i];
        if (part > 0 && stop > old) mark(next + Math.max(old, start) - old, next + Math.min(stop, end) - old, person);
        if (stop > end) break;
        i++;
      }
      old = end;
      if (part > 0) next += part;
    }
    return result.slice(0, 16000);
  }
  function rebaseUndo(stack, remote) {
    for (let index = stack.length - 1; index >= 0; index--) {
      const inverse = stack[index];
      stack[index] = transform(inverse, remote);
      remote = transform(remote, inverse, true);
    }
  }
  const api = {append, apply, compose, diff, edits, inverse, mapPosition, mapSpans, rebaseUndo, splice, transform};
  if (typeof module !== 'undefined') module.exports = api;
  else window.GroupProjectText = api;
})();
