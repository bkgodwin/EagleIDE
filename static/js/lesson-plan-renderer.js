(function () {
  'use strict';

  const DAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'];

  function safeMarkdown(markdown) {
    const source = String(markdown || '').trim();
    if (!source) return '';
    const rendered = window.marked?.parse ? window.marked.parse(source) : source.replace(/\n/g, '<br>');
    return window.DOMPurify?.sanitize ? window.DOMPurify.sanitize(rendered) : '';
  }

  function dayLabel(day, isoDate) {
    const parsed = new Date(`${isoDate}T12:00:00`);
    const dateText = Number.isNaN(parsed.valueOf())
      ? ''
      : parsed.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    return { name: day.charAt(0).toUpperCase() + day.slice(1), date: dateText };
  }

  function addStandardTooltip(button, standard) {
    button.title = standard.description || standard.standard_id || '';
    button.addEventListener('pointerenter', () => {
      const tooltip = document.getElementById('wikiStandardDescriptionTooltip');
      if (!tooltip || !standard.description) return;
      tooltip.textContent = standard.description;
      tooltip.hidden = false;
      const rect = button.getBoundingClientRect();
      tooltip.style.left = `${Math.min(rect.left, window.innerWidth - 340)}px`;
      tooltip.style.top = `${Math.min(rect.bottom + 8, window.innerHeight - tooltip.offsetHeight - 8)}px`;
    });
    button.addEventListener('pointerleave', () => {
      const tooltip = document.getElementById('wikiStandardDescriptionTooltip');
      if (tooltip) tooltip.hidden = true;
    });
  }

  function positionStandardsPopover(details) {
    const summary = details.querySelector('summary');
    const list = details.querySelector('.lesson-plan-standards-list');
    if (!summary || !list || !details.open || document.body.classList.contains('lesson-plan-printing') || window.matchMedia?.('print')?.matches) return;
    const rect = summary.getBoundingClientRect();
    const width = Math.min(380, Math.max(230, rect.width + 80));
    const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8));
    list.style.width = `${width}px`;
    list.style.left = `${left}px`;
    list.style.right = 'auto';
    const roomBelow = window.innerHeight - rect.bottom;
    if (roomBelow >= 210 || roomBelow >= rect.top) {
      list.style.top = `${Math.min(rect.bottom + 5, window.innerHeight - 8)}px`;
      list.style.bottom = 'auto';
    } else {
      list.style.top = 'auto';
      list.style.bottom = `${Math.max(8, window.innerHeight - rect.top + 5)}px`;
    }
  }

  function closeScreenStandards(except = null) {
    if (document.body.classList.contains('lesson-plan-printing') || window.matchMedia?.('print')?.matches) return;
    document.querySelectorAll('.lesson-plan-standards-popout[open]').forEach((details) => {
      if (details !== except) details.open = false;
    });
  }

  function standardsPopover(dayName, standards) {
    const details = document.createElement('details');
    details.className = 'lesson-plan-standards-popout';
    const summary = document.createElement('summary');
    summary.textContent = `${standards.length} standard${standards.length === 1 ? '' : 's'}`;
    summary.setAttribute('aria-label', `Show ${standards.length} standards for ${dayName}`);
    details.appendChild(summary);
    const list = document.createElement('div');
    list.className = 'lesson-plan-standards-list';
    standards.forEach((standard, index) => {
      const item = document.createElement('div');
      item.className = 'lesson-plan-standard-row';
      if (index >= 12) item.classList.add('lesson-plan-standard-overflow');
      const tag = document.createElement('button');
      tag.type = 'button';
      tag.className = 'wiki-standard-id';
      tag.textContent = standard.standard_id || 'Standard';
      addStandardTooltip(tag, standard);
      const description = document.createElement('span');
      description.textContent = standard.description || '';
      item.append(tag, description);
      list.appendChild(item);
    });
    if (standards.length > 12) {
      const more = document.createElement('div');
      more.className = 'lesson-plan-standard-more';
      more.textContent = `+ ${standards.length - 12} more`;
      list.appendChild(more);
    }
    details.appendChild(list);
    details.addEventListener('toggle', () => {
      if (!details.open) return;
      closeScreenStandards(details);
      positionStandardsPopover(details);
    });
    return details;
  }

  function render(host, data, options = {}) {
    if (!host) return;
    host.textContent = '';
    host.classList.add('lesson-plan-render-host');
    const plan = data?.plan;
    if (!plan) {
      const empty = document.createElement('div');
      empty.className = 'lesson-plan-empty';
      empty.innerHTML = '<strong>No plan published for this week.</strong><span>Use the previous-week button to view an earlier plan.</span>';
      host.appendChild(empty);
      return;
    }

    const frame = document.createElement('article');
    frame.className = `lesson-plan-frame${options.embed ? ' lesson-plan-frame--embed' : ''}`;
    const header = document.createElement('header');
    header.className = 'lesson-plan-frame-header';
    const heading = document.createElement('div');
    const title = document.createElement('h1');
    title.textContent = data.class?.name || 'Class Lesson Plan';
    const week = document.createElement('p');
    const monday = new Date(`${plan.week_start}T12:00:00`);
    const friday = new Date(monday);
    friday.setDate(friday.getDate() + 4);
    week.textContent = `Week of ${monday.toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' })} - ${friday.toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' })}`;
    heading.append(title, week);
    header.appendChild(heading);
    frame.appendChild(header);

    const grid = document.createElement('div');
    grid.className = 'lesson-plan-week-grid';
    DAYS.forEach((day) => {
      const item = plan.days?.[day] || {};
      const label = dayLabel(day, item.date);
      const column = document.createElement('section');
      column.className = 'lesson-plan-day';
      const dayHeader = document.createElement('header');
      dayHeader.innerHTML = `<strong>${label.name}</strong><time datetime="${item.date || ''}">${label.date}</time>`;
      const scroll = document.createElement('div');
      scroll.className = 'lesson-plan-day-scroll';
      const content = document.createElement('div');
      content.className = 'lesson-plan-markdown wiki-markdown';
      content.innerHTML = safeMarkdown(item.markdown);
      if (!String(item.markdown || '').trim()) content.innerHTML = '<p class="lesson-plan-day-empty">No activities listed.</p>';
      scroll.appendChild(content);
      if (item.wiki_pages?.length || item.external_links?.length) {
        const resources = document.createElement('div');
        resources.className = 'lesson-plan-resources';
        const caption = document.createElement('strong');
        caption.textContent = item.external_links?.length ? 'Resources' : 'Wiki content';
        resources.appendChild(caption);
        item.wiki_pages.forEach((page) => {
          const link = document.createElement('a');
          link.href = page.url || `/wiki/${encodeURIComponent(page.slug || '')}`;
          link.textContent = page.title || 'Wiki page';
          if (options.publicPage) link.target = '_blank';
          if (options.publicPage) link.rel = 'noopener';
          resources.appendChild(link);
        });
        (item.external_links || []).forEach((resource) => {
          const link = document.createElement('a');
          link.href = resource.url;
          link.textContent = resource.title || resource.url;
          link.target = '_blank';
          link.rel = 'noopener';
          resources.appendChild(link);
        });
        scroll.appendChild(resources);
      }
      column.append(dayHeader, scroll);
      if (item.standards?.length) column.appendChild(standardsPopover(label.name, item.standards));
      grid.appendChild(column);
    });
    frame.appendChild(grid);

    if (String(plan.notes_markdown || '').trim()) {
      const notes = document.createElement('footer');
      notes.className = 'lesson-plan-notes';
      const label = document.createElement('strong');
      label.textContent = 'Additional notes';
      const content = document.createElement('div');
      content.className = 'lesson-plan-markdown wiki-markdown';
      content.innerHTML = safeMarkdown(plan.notes_markdown);
      notes.append(label, content);
      frame.appendChild(notes);
    }
    host.appendChild(frame);
  }

  window.LessonPlanRenderer = { DAYS, createStandardsPopover: standardsPopover, render, safeMarkdown };
  window.addEventListener('resize', () => closeScreenStandards());
  window.addEventListener('scroll', (event) => {
    if (event.target?.closest?.('.lesson-plan-standards-list')) return;
    closeScreenStandards();
  }, true);
})();
