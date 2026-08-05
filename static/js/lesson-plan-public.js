(function () {
  'use strict';

  const embed = location.pathname.startsWith('/lesson-plans/embed/');
  const printExport = location.pathname.startsWith('/lesson-plans/print/');
  const token = decodeURIComponent(location.pathname.split('/').filter(Boolean).pop() || '');
  const params = new URLSearchParams(location.search);
  const state = { week: params.get('week') || '', data: null, printing: printExport || params.get('print') === '1' };
  const $ = (id) => document.getElementById(id);

  async function load(week = '') {
    $('publicLessonPlanStatus').textContent = 'Loading lesson plan…';
    try {
      const query = week ? `?week=${encodeURIComponent(week)}` : '';
      const endpoint = printExport
        ? `/api/lesson-plans/print/${encodeURIComponent(token)}`
        : `/api/lesson-plans/public/${encodeURIComponent(token)}${query}`;
      const response = await fetch(endpoint, { headers: { Accept: 'application/json' } });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data.ok) throw new Error(data.error || 'Lesson plan unavailable.');
      state.data = data;
      state.week = data.selected_week;
      document.title = `${data.class?.name || 'Class'} - Weekly Lesson Plan`;
      $('publicLessonPlanStatus').textContent = '';
      window.LessonPlanRenderer.render($('publicLessonPlanHost'), data, { embed, publicPage: true });
      $('publicLessonPlanPrevious').disabled = !data.previous_week;
      $('publicLessonPlanNext').disabled = !data.next_week;
      if (!printExport) {
        const nextUrl = new URL(location.href);
        nextUrl.searchParams.set('week', state.week);
        if (!state.printing) nextUrl.searchParams.delete('print');
        history.replaceState({}, '', nextUrl);
      }
      if (state.printing) {
        state.printing = false;
        requestAnimationFrame(() => setTimeout(() => window.print(), 250));
      }
    } catch (error) {
      $('publicLessonPlanStatus').textContent = error.message || 'Lesson plan unavailable.';
      $('publicLessonPlanStatus').classList.add('is-error');
      window.LessonPlanRenderer.render($('publicLessonPlanHost'), { plan: null });
    }
  }

  function attach() {
    document.body.classList.toggle('lesson-plan-embed-page', embed);
    document.body.classList.toggle('lesson-plan-print-export-page', printExport);
    $('publicLessonPlanPrevious').addEventListener('click', () => state.data?.previous_week && load(state.data.previous_week));
    $('publicLessonPlanNext').addEventListener('click', () => state.data?.next_week && load(state.data.next_week));
    $('publicLessonPlanCurrent').addEventListener('click', () => load(state.data?.current_week || ''));
    $('publicLessonPlanPrint').addEventListener('click', () => window.print());
    window.addEventListener('beforeprint', () => {
      document.body.classList.add('lesson-plan-printing');
      document.querySelectorAll('.lesson-plan-standards-popout').forEach((details) => {
        details.dataset.printWasOpen = details.open ? '1' : '0';
        details.open = true;
      });
    });
    window.addEventListener('afterprint', () => {
      document.body.classList.remove('lesson-plan-printing');
      document.querySelectorAll('.lesson-plan-standards-popout').forEach((details) => {
        if (details.dataset.printWasOpen !== '1') details.open = false;
        delete details.dataset.printWasOpen;
      });
    });
  }

  attach();
  load(state.week);
})();
