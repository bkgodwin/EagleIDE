/* Protected, lazy notebook photos. Persist paths, never credentials or blob URLs. */
(() => {
  let generation = 0, observer = null, controller = null, active = 0;
  let pending = [], urls = new Map(), visible = new WeakSet();
  const validPath = path => /^images\/[^/\\]+\.(?:jpe?g|png|webp|gif)$/i.test(path || '');
  function reset() {
    generation++; observer?.disconnect(); observer = null; controller?.abort(); controller = null;
    pending = []; active = 0; urls.forEach(url => URL.revokeObjectURL(url)); urls = new Map(); visible = new WeakSet();
  }
  function clean(root) {
    root.querySelectorAll('figure[data-notebook-image]').forEach(figure => {
      figure.querySelectorAll('[data-photo-control], [data-photo-status]').forEach(node => node.remove());
      figure.querySelector('img')?.removeAttribute('src');
      figure.removeAttribute('data-photo-loading');
    });
  }
  function prune() {
    urls.forEach((url, figure) => { if (!figure.isConnected) { URL.revokeObjectURL(url); urls.delete(figure); visible.delete(figure); observer?.unobserve(figure); } });
  }
  function mount(root, { classId, studentEmail = '', headers, readOnly = false, onRemove = () => {} }) {
    reset();
    const epoch = generation, abort = new AbortController(); controller = abort;
    const request = window.EagleIDE?.connection?.request || fetch;
    async function load(figure) {
      const image = figure.querySelector('img'), status = figure.querySelector('[data-photo-status]');
      try {
        const query = new URLSearchParams({ classId, path: figure.dataset.notebookImage });
        if (studentEmail) query.set('studentEmail', studentEmail);
        const response = await request(`/api/notebook/images?${query}`, { headers, signal: abort.signal });
        if (!response.ok || !String(response.headers.get('Content-Type') || '').startsWith('image/')) throw new Error('Photo unavailable');
        const blob = await response.blob();
        if (epoch !== generation || !figure.isConnected || !visible.has(figure)) return;
        const url = URL.createObjectURL(blob); urls.set(figure, url); image.src = url;
        if (status) status.hidden = true;
      } catch (error) {
        if (epoch === generation && figure.isConnected && error.name !== 'AbortError' && status) status.textContent = 'Photo unavailable. It may have been moved or deleted in Files.';
      } finally {
        if (epoch === generation) { if (!visible.has(figure)) figure.removeAttribute('data-photo-loading'); active--; drain(); }
      }
    }
    function drain() { while (active < 2 && pending.length && epoch === generation) { const figure = pending.shift(); if (visible.has(figure) && figure.isConnected) { active++; load(figure); } else figure.removeAttribute('data-photo-loading'); } }
    function queue(figure) {
      if (epoch !== generation || figure.dataset.photoLoading) return;
      const status = figure.querySelector('[data-photo-status]'); if (status) { status.hidden = false; status.textContent = 'Loading photo…'; }
      figure.dataset.photoLoading = '1'; pending.push(figure); drain();
    }
    if (window.IntersectionObserver) observer = new IntersectionObserver(entries => {
      if (epoch !== generation) return;
      entries.forEach(entry => {
      if (entry.isIntersecting) { visible.add(entry.target); queue(entry.target); }
      else {
        visible.delete(entry.target);
        const url = urls.get(entry.target);
        if (url) { URL.revokeObjectURL(url); urls.delete(entry.target); entry.target.querySelector('img')?.removeAttribute('src'); entry.target.removeAttribute('data-photo-loading'); }
      }
      });
    }, { root: document.getElementById('studentNotebookPage'), rootMargin: '240px' });
    root.querySelectorAll('figure[data-notebook-image]').forEach(figure => {
      figure.contentEditable = 'false'; figure.classList.add('student-notebook-photo'); figure.removeAttribute('data-photo-loading');
      let image = figure.querySelector('img');
      if (!image) { image = document.createElement('img'); figure.prepend(image); }
      image.removeAttribute('src'); image.loading = 'lazy'; image.decoding = 'async';
      figure.querySelectorAll('[data-photo-control], [data-photo-status]').forEach(node => node.remove());
      const status = document.createElement('span'); status.dataset.photoStatus = '1'; status.textContent = 'Loading photo…'; figure.appendChild(status);
      if (!readOnly) {
        const remove = document.createElement('button'); remove.type = 'button'; remove.dataset.photoControl = 'remove';
        remove.textContent = 'Remove photo'; remove.title = 'Remove from this page; the image remains in your images folder';
        remove.addEventListener('click', event => { event.preventDefault(); event.stopPropagation(); const url = urls.get(figure); if (url) { URL.revokeObjectURL(url); urls.delete(figure); } visible.delete(figure); figure.remove(); onRemove(); });
        figure.appendChild(remove);
      }
      if (!validPath(figure.dataset.notebookImage)) { status.textContent = 'Photo path is invalid'; return; }
      if (observer) observer.observe(figure); else { visible.add(figure); queue(figure); }
    });
  }
  async function prepare(file) {
    if (!file || file.size > 30 * 1024 * 1024) throw new Error('Choose a photo smaller than 30 MB.');
    const url = URL.createObjectURL(file), image = new Image();
    try {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('This photo could not be opened. Try exporting it as JPEG or PNG.')), 15000);
        image.onload = () => { clearTimeout(timer); resolve(); };
        image.onerror = () => { clearTimeout(timer); reject(new Error('This photo format could not be opened. Choose JPEG or PNG.')); };
        image.src = url;
      });
      if (!image.naturalWidth || image.naturalWidth * image.naturalHeight > 25000000) throw new Error('Photo dimensions are too large.');
      const scale = Math.min(1, 1920 / Math.max(image.naturalWidth, image.naturalHeight));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(image.naturalWidth * scale)); canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
      const drawing = canvas.getContext('2d');
      if (!drawing) throw new Error('There is not enough memory to resize this photo. Try a smaller image.');
      drawing.drawImage(image, 0, 0, canvas.width, canvas.height);
      const png = file.type === 'image/png';
      const blob = await new Promise(resolve => canvas.toBlob(resolve, png ? 'image/png' : 'image/jpeg', 0.88));
      canvas.width = canvas.height = 1;
      if (!blob || blob.size > 10 * 1024 * 1024) throw new Error('This photo is too large after resizing.');
      return { blob, name: (file.name || 'photo').replace(/\.[^.]+$/, '') + (png ? '.png' : '.jpg') };
    } finally { URL.revokeObjectURL(url); image.src = ''; }
  }
  async function upload(file, classId, headers) {
    const photo = await prepare(file), form = new FormData();
    form.append('classId', classId); form.append('image', photo.blob, photo.name);
    const request = window.EagleIDE?.connection?.request || fetch;
    const response = await request('/api/notebook/images', { method: 'POST', headers, body: form });
    const data = await response.json();
    if (!data.ok) throw new Error(data.error || 'Photo could not be saved');
    if (!validPath(data.path)) throw new Error('Photo path is invalid');
    return data;
  }
  window.NotebookPhotos = { mount, reset, clean, prune, upload, validPath };
})();
