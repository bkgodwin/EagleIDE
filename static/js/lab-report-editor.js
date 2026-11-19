/* Teacher report sections use the same renderer as the student report. */
(function () {
  'use strict';
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const content = () => window.LabReportContent;
  const imageMarker = index => '⟦Image ' + index + '⟧';
  const markerPattern = /⟦Image (\d+)⟧/g;
  const imageToken = (id, alt) => '![' + alt.replace(/[\]\r\n]/g, ' ') + '](lab-image:' + id + ')';
  const lines = field => field.value.split(/\r?\n/).map(line => line.trim()).filter(Boolean);

  function summary(text) {
    return String(text || '').replace(content().imagePattern, '[Image]');
  }

  function createPreview(box, assignmentId) {
    let classId, cleanup, previous;
    return {
      update(name, task, questions, nextClassId) {
        const html = '<span class="lab-report-eyebrow">STUDENT PREVIEW</span><h2>' + esc(name || 'Untitled report')
          + '</h2>' + content().render(task) + content().sections(questions, {preview:true, previewId:box.className});
        if (html === previous && classId === nextClassId) return;
        const sameClass = classId === nextClassId;
        const currentImages = new Map();
        if (sameClass) {
          for (const figure of box.querySelectorAll('[data-report-image]')) {
            const key = figure.dataset.reportImage, matches = currentImages.get(key) || [];
            matches.push(figure);
            currentImages.set(key, matches);
          }
        } else {
          cleanup?.();
          cleanup = null;
        }
        const template = document.createElement('template');
        template.innerHTML = html;
        for (const figure of template.content.querySelectorAll('[data-report-image]')) {
          const existing = currentImages.get(figure.dataset.reportImage)?.shift();
          if (!existing) continue;
          existing.querySelector('img').alt = figure.querySelector('img').alt;
          figure.replaceWith(existing);
        }
        const scrollTop = box.scrollTop;
        box.replaceChildren(template.content);
        box.scrollTop = scrollTop;
        previous = html;
        classId = nextClassId;
        cleanup ||= content().mount(box, {assignmentId, classId, livePreview:true});
      },
      dispose() {
        cleanup?.();
        cleanup = null;
        classId = previous = undefined;
        box.replaceChildren();
      },
    };
  }

  function imageTools(container, textarea, getClassId, onImage) {
    const tools = document.createElement('div');
    tools.className = 'lab-editor-image-tools';
    tools.innerHTML = '<button class="btn secondary" type="button">Add image</button><input type="file" accept="image/jpeg,image/png" hidden><span role="status">JPEG / PNG · up to 5 MB</span>';
    (textarea.closest('label') || textarea).after(tools);
    const button = tools.querySelector('button'), input = tools.querySelector('input'), status = tools.querySelector('[role=status]');
    button.onclick = () => input.click();
    input.onchange = async () => {
      const file = input.files[0];
      if (!file) return;
      if (file.size > 5 * 1024 * 1024) {
        status.textContent = 'Choose an image smaller than 5 MB.';
        input.value = '';
        return;
      }
      const headers = content().headers(), classId = getClassId();
      status.textContent = 'Uploading image…';
      button.disabled = true;
      try {
        const data = new FormData();
        data.append('image', file);
        const response = await fetch('/api/lab-reports/images?class_id=' + encodeURIComponent(classId), {
          method:'POST', headers, body:data, signal:AbortSignal.timeout(30000),
        });
        const result = await response.json();
        if (!response.ok || !result.ok) throw Error(result.error || 'Image upload failed');
        if (!container.isConnected || JSON.stringify(headers) !== JSON.stringify(content().headers()) || getClassId() !== classId) return;
        const alt = file.name.replace(/\.[^.]+$/, '').replace(/[\]\r\n]/g, ' ').slice(0,200);
        status.textContent = onImage({id:result.data.id, alt});
      } catch (error) {
        status.textContent = error.message;
      } finally {
        button.disabled = false;
        input.value = '';
      }
    };
  }

  function insertImage(textarea, token) {
    // Insert at the current caret without replacing prose if a range is selected.
    textarea.setRangeText(token, textarea.selectionEnd, textarea.selectionEnd, 'end');
    textarea.dispatchEvent(new Event('input', {bubbles:true}));
  }

  function attachComposer(modal, getQuestions, assignmentId) {
    if (modal.labPreviewRefresh) return;
    const box = document.createElement('aside');
    box.className = 'lab-composer-preview';
    box.setAttribute('aria-label', 'Live lab report preview');
    modal.querySelector('.modal-content').append(box);
    const preview = createPreview(box, assignmentId);
    const classId = () => modal.querySelector('#modalAssignmentClassId')?.value || '';
    const task = modal.querySelector('#modalAssignmentTask');
    const name = modal.querySelector('#modalAssignmentName');
    imageTools(modal, task, classId, ({id, alt}) => {
      insertImage(task, '\n' + imageToken(id, alt) + '\n');
      return 'Image added. You can edit its description between [brackets].';
    });
    let timer;
    const refresh = () => {
      clearTimeout(timer);
      const enabled = modal.querySelector('#modalAssignmentType').value === 'lab_report';
      modal.classList.toggle('is-lab-composer', enabled);
      box.hidden = !enabled;
      const tab = modal.querySelector('#composer-tab-questions');
      const label = [...(tab?.childNodes || [])].find(node => node.nodeType === 3);
      if (label) label.textContent = enabled ? 'Report sections' : 'Skills & questions';
      const heading = modal.querySelector('#composer-pane-questions h4');
      if (heading) heading.textContent = enabled ? 'Build your report sections' : 'Connect skills and add a quiz';
      const attempts = modal.querySelector('#modalAssignmentMaxQuizSubmissions')?.previousElementSibling;
      if (attempts) attempts.textContent = enabled ? 'Maximum report submissions (0 = unlimited)' : 'Quiz Max Submissions (0 = unlimited)';
      const save = modal.querySelector('.modal-save-btn');
      if (save && !/Save/.test(save.textContent)) save.textContent = enabled ? 'Create report' : 'Create Assignment';
      if (enabled) preview.update(name.value, task.value, getQuestions(), classId());
      else preview.dispose();
    };
    modal.labPreviewRefresh = refresh;
    for (const field of [task, name]) {
      field.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(refresh, 180); });
    }
    modal.querySelector('#modalAssignmentType').addEventListener('change', refresh);
    modal.querySelector('#modalAssignmentClassId')?.addEventListener('change', refresh);
    const original = JSON.stringify(content().headers());
    const changed = () => { if (original !== JSON.stringify(content().headers())) modal.remove(); };
    window.addEventListener('eagle-context-updated', changed);
    const observer = new MutationObserver(() => {
      if (modal.isConnected) return;
      clearTimeout(timer);
      preview.dispose();
      window.removeEventListener('eagle-context-updated', changed);
      observer.disconnect();
    });
    observer.observe(document.body, {childList:true});
    refresh();
  }

  function open({questions, onChange, counter, index=-1, classId='', assignmentId=''}) {
    const existing = questions[index] || {type:'written', question:'', points:10, steps:[], acceptedAnswers:[]};
    const images = new Map();
    let nextImage = 1;
    const text = String(existing.question || '').replace(content().imagePattern, (_match, alt, id) => {
      const number = nextImage++;
      images.set(number, {id, alt});
      return imageMarker(number);
    });
    const modal = document.createElement('div');
    modal.className = 'modal glass-modal lab-section-editor';
    modal.style.display = 'flex';
    const action = index < 0 ? 'Add section' : 'Save section';
    modal.innerHTML = SECTION_EDITOR;
    modal.querySelector('[role=dialog]').setAttribute('aria-label', index < 0 ? 'Add report section' : 'Edit report section');
    modal.querySelector('h3').textContent = index < 0 ? 'Add section' : 'Edit section';
    const form = modal.querySelector('form'), {type, question, points, answers, steps} = form.elements;
    type.value = existing.type;
    question.value = text;
    points.value = existing.points || 10;
    answers.value = (existing.acceptedAnswers || []).join('\n');
    steps.value = (existing.steps || []).join('\n');
    form.querySelector('button[type=submit]').textContent = action;
    document.body.append(modal);

    const preview = createPreview(modal.querySelector('.lab-section-preview'), assignmentId);
    const status = form.querySelector('[data-status]');
    const gallery = form.querySelector('.lab-editor-attachments');
    let timer, previousMarkers;
    const getQuestion = () => ({
      ...existing, type:type.value,
      question:question.value.replace(markerPattern, (marker, number) => {
        const image = images.get(Number(number));
        return image ? imageToken(image.id, image.alt) : marker;
      }),
      points:type.value === 'text_box' ? 0 : Number(points.value),
      steps:type.value === 'procedure' ? lines(steps) : [],
      acceptedAnswers:type.value === 'fill_blank' ? lines(answers) : [],
    });
    const visibleImages = () => [...new Set([...question.value.matchAll(markerPattern)].map(match => Number(match[1])))].filter(id => images.has(id));
    function syncAttachments() {
      const markers = visibleImages(), key = markers.join(',');
      if (key === previousMarkers) return;
      previousMarkers = key;
      gallery.innerHTML = markers.map(id => '<div><label>Image ' + id + ' description<input data-image-alt="' + id + '" maxlength="200" value="' + esc(images.get(id).alt)
        + '"></label><button type="button" class="btn secondary" data-image-remove="' + id + '">Remove image</button></div>').join('');
      gallery.querySelectorAll('[data-image-alt]').forEach(input => {
        input.oninput = () => { images.get(Number(input.dataset.imageAlt)).alt = input.value; };
      });
      gallery.querySelectorAll('[data-image-remove]').forEach(button => {
        button.onclick = () => {
          question.value = question.value.split(imageMarker(Number(button.dataset.imageRemove))).join('');
          render();
          question.focus();
        };
      });
    }
    function render() {
      const isText = type.value === 'text_box';
      form.querySelector('[data-points]').hidden = points.disabled = isText;
      form.querySelector('[data-answers]').hidden = type.value !== 'fill_blank';
      form.querySelector('[data-steps]').hidden = type.value !== 'procedure';
      form.querySelector('[data-question-label]').textContent = isText ? 'Text box content' : 'Instructions';
      syncAttachments();
      preview.update('Section preview', '', [getQuestion()], classId);
    }
    const original = JSON.stringify(content().headers());
    const changed = () => { if (original !== JSON.stringify(content().headers())) close(); };
    window.addEventListener('eagle-context-updated', changed);
    function close() {
      clearTimeout(timer);
      preview.dispose();
      modal.remove();
      document.removeEventListener('keydown', key);
      window.removeEventListener('eagle-context-updated', changed);
    }
    function key(event) {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopImmediatePropagation();
        close();
      }
      if (event.key !== 'Tab') return;
      const items = [...modal.querySelectorAll('button,input,textarea,select')].filter(el => !el.disabled && el.getClientRects().length);
      const first = items[0], last = items.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }
    document.addEventListener('keydown', key);
    modal.querySelector('[data-cancel]').onclick = close;
    imageTools(modal, question, () => classId, image => {
      if (visibleImages().length >= 12) return 'Use at most 12 images per section.';
      const number = nextImage++;
      images.set(number, image);
      insertImage(question, imageMarker(number));
      render();
      return 'Image inserted. Move its marker to place it anywhere in the text.';
    });
    form.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(render, 180); });
    type.onchange = render;
    form.onsubmit = event => {
      event.preventDefault();
      const q = getQuestion();
      if (!q.question.trim() || q.question.length > 20000) {
        status.textContent = 'Use 1–20,000 characters for this section, including image references.';
        return;
      }
      if (q.type === 'procedure' && (!q.steps.length || q.steps.length > 50 || q.steps.some(step => step.length > 500))) {
        status.textContent = 'Add 1–50 steps of at most 500 characters.';
        return;
      }
      if (q.type === 'fill_blank' && (!q.acceptedAnswers.length || q.acceptedAnswers.length > 20 || q.acceptedAnswers.some(answer => answer.length > 500))) {
        status.textContent = 'Add 1–20 accepted answers of at most 500 characters.';
        return;
      }
      if (index < 0) {
        q.id = 'q' + Date.now() + '_' + counter.value++;
        questions.push(q);
      } else questions[index] = q;
      close();
      onChange();
    };
    render();
    question.focus();
  }

  const SECTION_EDITOR = `<section class="modal-content" role="dialog" aria-modal="true">
    <header class="workspace-modal-header"><div><h3></h3></div><button type="button" class="btn secondary" data-cancel>Cancel</button></header>
    <div class="lab-section-editor-grid"><form>
      <label>Section type<select name="type"><option value="written">Written response</option><option value="fill_blank">Fill in the blank</option><option value="procedure">Procedure checklist</option><option value="text_box">Text box</option></select></label>
      <label><span data-question-label>Instructions</span><textarea name="question" rows="6" maxlength="20000" required></textarea></label>
      <p class="lab-editor-help">Wrap commands or multiple lines in {curly braces} to make them click-to-copy. Add an image at the cursor, then move its marker anywhere in the text.</p>
      <div class="lab-editor-attachments"></div>
      <label data-points>Points<input name="points" type="number" min="1" max="10000" required></label>
      <label data-answers>Accepted answers · one per line<textarea name="answers" rows="3"></textarea><small>Matched without case or surrounding whitespace.</small></label>
      <label data-steps>Checklist steps · one per line<textarea name="steps" rows="6"></textarea><small>Every checkbox must be selected for credit. Maximum 50 steps, 500 characters per step.</small></label>
      <p role="status" data-status></p>
      <button class="btn run" type="submit"></button>
    </form><aside class="lab-section-preview" aria-label="Live section preview"></aside></div>
  </section>`;
  window.LabReportEditor = {open, attachComposer, summary};
})();
