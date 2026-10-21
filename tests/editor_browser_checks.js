/* Evaluate this file in the isolated external_tools_browser_fixture.py page.
   Uses the shipped CodeMirror and CSS; creates and removes only a scratch editor. */
(async function () {
  if (location.hostname !== '127.0.0.1') throw new Error('Use the isolated local browser fixture');
  const assert = (condition, message) => { if (!condition) throw new Error(message); };
  const frame = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  await document.fonts.ready;
  const host = document.createElement('div');
  Object.assign(host.style, {position:'fixed',inset:'20px',height:'340px',zIndex:'99999'});
  document.body.append(host);
  const cm = CodeMirror(host, {mode:'python',lineNumbers:true,gutters:['CodeMirror-linenumbers','CodeMirror-foldgutter'],lineWrapping:false});
  const results = [];
  try {
    for (const font of [12,18,28]) {
      cm.getWrapperElement().style.fontSize = `${font}px`;
      cm.refresh(); // Same public refresh used by the text-size slider.
      let smallWidth = null;
      for (const count of [9,10,99,100,999,1000,1001,9999,10000,9999,999,99,9]) {
        cm.setValue(Array.from({length:count},(_,i)=>`value_${i} = ${i}`).join('\n'));
        await frame();
        cm.scrollTo(0,0);
        const wrapper = cm.getWrapperElement(), gutters = wrapper.querySelector('.CodeMirror-gutters').getBoundingClientRect();
        assert(cm.charCoords({line:0,ch:0},'page').left >= gutters.right, `Gutter covers code: ${count} lines at ${font}px`);
        const first = wrapper.querySelector('.CodeMirror-code .CodeMirror-linenumber');
        assert(first.getBoundingClientRect().right <= gutters.right, `Number escapes gutter: ${count}`);
        const row = wrapper.querySelector('.CodeMirror-code .CodeMirror-line').getBoundingClientRect();
        assert(Math.abs(first.getBoundingClientRect().top-row.top) < 1, `Number bounces vertically: ${count}`);
        if (count===9 && smallWidth===null) smallWidth=gutters.width;
        if (count<=999) assert(Math.abs(gutters.width-smallWidth)<1, `Reserved gutter shifts at ${count}`);
        cm.scrollTo(0,cm.heightAtLine(count-1,'local'));
        await frame();
        assert([...wrapper.querySelectorAll('.CodeMirror-code .CodeMirror-linenumber')].some(el=>el.textContent===String(count)), `Last number missing: ${count}`);
        results.push({font,count,width:gutters.width});
      }
    }
    host.style.display='none';cm.setValue('print("visible again")');await frame();host.style.display='block';await frame();
    assert(cm.charCoords({line:0,ch:0},'page').left >= cm.getWrapperElement().querySelector('.CodeMirror-gutters').getBoundingClientRect().right,'Hidden editor reopens with stale gutter');
    cm.setValue('from dataclasses import dataclass\n@dataclass\nclass Student:\n    name: str\n    score: float = 95.5\ndef welcome(student: Student) -> str:\n    # welcome() stays a comment\n    return "welcome()"\nprint(welcome(Student("Eagle")))');
    const tokens=Array.from({length:cm.lineCount()},(_,line)=>cm.getLineTokens(line,true)).flat();
    for(const style of ['keyword','meta','eagle-type','eagle-call','number','comment','string']) assert(tokens.some(token=>token.type?.split(' ').includes(style)),`Missing token: ${style}`);
    assert(!tokens.some(token=>/(?:string|comment)/.test(token.type||'') && /eagle-call/.test(token.type||'')),'Call highlighting leaks into strings/comments');
    const code=cm.getValue();
    assert(EagleEditorFeedback.analyze(code,'python',EagleAutocomplete).diagnostics.length===0,'Valid typed dataclass gets hints');
    assert((await fetch('/health')).ok,'Health check failed');
    return {ok:true,gutterCases:results.length,widths:results,highlighting:true,dataclassHints:true};
  } finally { host.remove(); }
})()
