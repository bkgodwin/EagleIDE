/* Local edit bookkeeping. Only pasted editor ranges are sent with file saves. */
(() => {
  'use strict';
  const LIMIT = 512;
  function normalize(ranges) {
    const result = [];
    for (const [start, end] of ranges.filter(r => r[0] < r[1]).sort((a,b) => a[0] - b[0])) {
      const last = result.at(-1);
      if (last && start <= last[1]) last[1] = Math.max(last[1], end);
      else result.push([start,end]);
    }
    return result.slice(0,LIMIT);
  }
  function edit(ranges, from, to, inserted, paste) {
    const delta = inserted - (to - from), next = [];
    for (const [start,end] of ranges) {
      if (start < from) next.push([start,Math.min(end,from)]);
      if (end > to) next.push([Math.max(start,to) + delta,end + delta]);
    }
    if (paste && inserted) next.push([from,from + inserted]);
    return normalize(next);
  }
  function configure(bridge) {
    const histories = new WeakMap();
    const file = () => bridge.enabled() ? bridge.file() : null;
    const apply = (from,to,text,paste,removed = '',origin = '') => {
      const current = file();
      if (!current) return;
      const ranges = current.pasteRanges || [], history = histories.get(current) || [];
      // Remember bounded deleted fragments and their ranges so undo/redo can
      // restore provenance without inspecting the clipboard.
      const deleted = ranges.map(([start,end]) => [Math.max(start,from)-from,Math.min(end,to)-from]).filter(([start,end]) => start < end);
      if (removed.length && removed.length <= 65536) {
        history.push({text:removed,from,ranges:deleted});
        while(history.length > 64 || history.reduce((sum,r) => sum+r.text.length,0) > 262144) history.shift();
      }
      let next = edit(ranges,from,to,text.length,paste);
      if (origin === 'undo' || origin === 'redo' || origin === 'historyUndo' || origin === 'historyRedo') {
        const prior = history.findLast(record => record.from === from && record.text === text);
        if(prior) next = normalize([...next,...prior.ranges.map(([start,end]) => [start+from,end+from])]);
      }
      histories.set(current,history);
      current.pasteRanges=next;
    };
    const cm = window.eagleEditor;
    if (cm?.on) {
      cm.on('beforeChange', (_cm,change) => {
        if (change.origin === 'setValue') return;
        apply(cm.indexFromPos(change.from),cm.indexFromPos(change.to),(change.text || []).join('\n'),change.origin === 'paste',cm.getRange(change.from,change.to),change.origin);
      });
    } else {
      const ta = document.getElementById('editor');
      let before = null;
      ta?.addEventListener('beforeinput', event => {before = {value:ta.value,paste:event.inputType === 'insertFromPaste',origin:event.inputType};});
      ta?.addEventListener('keydown', event => {if(event.key === 'Tab' || event.key === 'Enter') before={value:ta.value,paste:false};},true);
      // Capture also covers the Python indentation normalizer's synthetic input.
      ta?.addEventListener('paste', () => {before = {value:ta.value,paste:true};},true);
      ta?.addEventListener('input', () => {
        if (!before) return;
        const old = before.value, value = ta.value;
        let start = 0, suffix = 0;
        while (start < Math.min(old.length,value.length) && old[start] === value[start]) start++;
        while (suffix < Math.min(old.length,value.length) - start && old[old.length - suffix - 1] === value[value.length - suffix - 1]) suffix++;
        apply(start,old.length - suffix,value.slice(start,value.length - suffix),before.paste,old.slice(start,old.length-suffix),before.origin);
        before = null;
      });
    }
  }
  window.FileProvenance = {configure,edit,normalize};
})();
