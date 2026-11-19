/* Concept checks and graded submissions for assigned Infra Sim labs. */
(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  function create({ escape, mutate, advance }) {
    const host = document.createElement('section');
    host.className = 'wifi-lab-assessment';
    host.hidden = true;
    $('wifiStarterChecklist').append(host);
    const dialog = document.createElement('dialog');
    dialog.className = 'wifi-lab-quiz';
    dialog.setAttribute('aria-labelledby', 'wifiLabQuestionTitle');
    $('wifiWorkspace').append(dialog);
    let current, progress, shown, busy = false, feedback;
    function open(data) {
      close();
      if (!data?.assessment) return;
      current = data;
      update(data.progress);
    }
    function render() {
      if (!current) return;
      const a = progress.assessment;
      const limit = a.allowance ? String(a.allowance) : 'Unlimited';
      host.hidden = false;
      host.innerHTML = `<strong>${a.preview ? 'Teacher preview' : a.submitted ? 'Submitted · ' + a.latest.score + '%' : 'Current score estimate · ' + a.score + '%'}</strong>
        <p>${a.objectives_complete}/${a.objectives_total} objectives · ${a.questions_correct}/${a.questions_total} questions correct</p>
        <p>${a.attempts} / ${limit} submissions used. Network objectives contribute 70%, questions 30%.</p>
        <p>Question answers are final for this attempt.</p>
        ${!a.preview && !a.submitted ? '<button class="btn run" type="button" data-lab-submit>Submit Lab</button>' : ''}
        ${a.submitted ? `<button class="btn run" type="button" data-lab-next${a.allowance && a.attempts >= a.allowance ? ' disabled' : ''}>Start Another Attempt</button>` : ''}
        ${a.answers?.length ? `<details><summary>Review question feedback</summary>${a.answers.map(answer =>
          `<p><strong>${escape(answer.prompt)}</strong><br>${answer.correct ? 'Correct.' : 'Incorrect.'} ${escape(answer.explanation)}</p>`).join('')}</details>` : ''}
        <p class="wifi-lab-status" role="status"></p>`;
    }
    function update(data) {
      if (!current) return;
      progress = data;
      render();
      if (data.quiz && !dialog.open && !busy && shown !== data.quiz.id && !data.assessment.submitted) showQuestion();
    }
    function showQuestion() {
      if (!current || !progress.quiz || dialog.open || progress.assessment.submitted) return;
      const q = progress.quiz;
      shown = q.id;
      feedback = null;
      dialog.innerHTML = `<form><header><h2 id="wifiLabQuestionTitle">Concept check</h2>
        <button class="wifi-control" type="button" data-quiz-close aria-label="Close question">×</button></header>
        <fieldset><legend>${escape(q.prompt)}</legend>
        ${q.options.map(option => `<label><input type="radio" name="answer" value="${escape(option.id)}" required>
          <span>${escape(option.text)}</span></label>`).join('')}</fieldset>
        <p>Choose one answer. It will be scored for this attempt when you submit it.</p>
        <div class="wifi-lab-feedback" role="status"></div>
        <footer><button class="btn run" type="submit">Submit Answer</button>
          <button class="btn secondary" type="button" data-quiz-continue hidden>Continue</button></footer></form>`;
      dialog.showModal();
      dialog.querySelector('input').focus({ preventScroll: true });
    }
    dialog.addEventListener('click', event => {
      if (event.target.closest('[data-quiz-close]')) dialog.close();
      if (event.target.closest('[data-quiz-continue]')) {
        dialog.close();
        advance();
        if (progress.quiz && progress.quiz.id !== shown) showQuestion();
      }
    });
    dialog.addEventListener('submit', async event => {
      event.preventDefault();
      if (busy || feedback) return;
      const selected = dialog.querySelector('input:checked');
      if (!selected) return;
      const question = progress.quiz.id;
      busy = true;
      const submit = dialog.querySelector('[type="submit"]');
      submit.disabled = true;
      try {
        const result = await mutate('answer', { question, choice: selected.value });
        if (!result) return;
        feedback = result.feedback;
        for (const input of dialog.querySelectorAll('input')) input.disabled = true;
        const output = dialog.querySelector('.wifi-lab-feedback');
        output.textContent = (feedback.correct ? 'Correct. ' : 'Incorrect. ') + feedback.explanation;
        output.dataset.correct = String(feedback.correct);
        submit.hidden = true;
        dialog.querySelector('[data-quiz-continue]').hidden = false;
        dialog.querySelector('[data-quiz-continue]').focus({ preventScroll: true });
      } catch (error) {
        dialog.querySelector('.wifi-lab-feedback').textContent = error.message;
      } finally {
        busy = false;
        submit.disabled = false;
      }
    });
    host.addEventListener('click', async event => {
      const action = event.target.closest('[data-lab-submit]') ? 'submit' : event.target.closest('[data-lab-next]') ? 'next' : '';
      if (!action || busy) return;
      if (action === 'submit' && !window.confirm('Submit this design and the recorded question answers? This uses one submission. Incomplete objectives receive no credit.')) return;
      if (action === 'next' && !window.confirm('Start another attempt from the lab’s starting floor plan? Your submitted score will be kept.')) return;
      busy = true;
      try { await mutate(action); } catch (error) {
        host.querySelector('.wifi-lab-status').textContent = error.message;
      } finally { busy = false; }
    });
    function close() {
      current = progress = shown = feedback = null;
      busy = false;
      host.hidden = true;
      if (dialog.open) dialog.close();
    }
    return { open, close, update, showQuestion, suspend: () => { if (dialog.open) dialog.close(); } };
  }
  window.WifiLabAssessment = { create };
})();
