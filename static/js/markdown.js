function renderMarkdownTo(el, text, defaultLang='python', options = {}){
      try{
        // Sanitize & render
        const html = DOMPurify.sanitize(marked.parse(text || '', {breaks:true, gfm:true}), options.sanitize);
        el.innerHTML = html;

        // Post-process code blocks: force language (default python), highlight, and add copy buttons
        const blocks = el.querySelectorAll('pre > code');
        Array.from(blocks).slice(0, options.maxCodeBlocks ?? blocks.length).forEach(code => {
          // If no language class present, default to python
          if (![...code.classList].some(c => c.startsWith('language-'))){
            code.classList.add('language-' + defaultLang);
          }
          // Highlight
          try { hljs.highlightElement(code); } catch {}

          // Add copy button
          const pre = code.parentElement;
          const btn = document.createElement('button');
          btn.className = 'copy-btn';
          btn.textContent = 'Copy';
          btn.addEventListener('click', async () => {
            if (options.canCopy && !options.canCopy()) {
              btn.textContent = 'Copy blocked';
              setTimeout(() => btn.textContent = 'Copy', 1200);
              return;
            }
            try{
              await navigator.clipboard.writeText(code.textContent);
              const old = btn.textContent; btn.textContent = 'Copied!';
              setTimeout(()=> btn.textContent = old, 1200);
            }catch(e){
              btn.textContent = 'Error';
              setTimeout(()=> btn.textContent = 'Copy', 1200);
            }
          });
          pre.appendChild(btn);
        });
      }catch(e){
        // Fallback to plain text
        el.textContent = text || '';
      }
    }
