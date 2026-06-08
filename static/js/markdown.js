function renderMarkdownTo(el, text, defaultLang='python'){
      try{
        // Configure marked for GitHub-like Markdown
        marked.setOptions({
          breaks: true,
          gfm: true
        });
        // Sanitize & render
        const html = DOMPurify.sanitize(marked.parse(text || ''));
        el.innerHTML = html;

        // Post-process code blocks: force language (default python), highlight, and add copy buttons
        const blocks = el.querySelectorAll('pre > code');
        blocks.forEach(code => {
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
