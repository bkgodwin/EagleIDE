/* Wall openings and the plan's locked reference image. */
(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const model = window.WifiSiteModel;
  const cable = window.WifiCablingModel;

  function create(ctx) {
    let painted;
    let openingsRef, wallsRef, selection;
    let first, second;
    let request = 0;
    const background = () => ctx.plan()?.background;
    const height = image => image.width * image.pixel_height / image.pixel_width;

    function wallPoint(raw) {
      return cable.closestWall(raw, ctx.plan().walls, Math.min(3, 18 / ctx.scale()));
    }
    function anchors(item) {
      const wall = ctx.walls().get(item.wall_id);
      if (!wall) return [];
      const half = item.width / (2 * wall.length);
      return [cable.pointAt(wall, item.t - half), cable.pointAt(wall, item.t + half)];
    }
    function place(kind, raw) {
      const hit = wallPoint(raw);
      if (!hit) { ctx.hint('Choose a spot on a wall.'); return; }
      const wall = ctx.walls().get(hit.wall_id);
      const width = kind === 'door' ? 1 : 1.5;
      if (wall.length < width) { ctx.hint('Choose a longer wall for this opening.'); return; }
      const half = width / (2 * wall.length);
      const t = Math.max(half, Math.min(1 - half, hit.t));
      if (ctx.add('openings', [{ id: ctx.id(kind), wall_id: hit.wall_id, kind, width, t, material: kind === 'door' ? 'wood' : 'glass' }])) {
        ctx.changeTool('select');
      }
    }
    function validate(plan) {
      const walls = new Map(plan.walls.map(wall => [wall.id, Math.hypot(wall.b.x - wall.a.x, wall.b.y - wall.a.y)]));
      const ranges = new Map();
      for (const item of plan.openings) {
        const length = walls.get(item.wall_id);
        const start = item.t * length - item.width / 2, end = item.t * length + item.width / 2;
        if (!length || start < -0.0001 || end > length + 0.0001) return 'The door or window must fit on its wall.';
        if (!ranges.has(item.wall_id)) ranges.set(item.wall_id, []);
        ranges.get(item.wall_id).push([start, end]);
      }
      for (const spans of ranges.values()) {
        spans.sort((a, b) => a[0] - b[0]);
        if (spans.some(([start], i) => i && start < spans[i - 1][1] - 0.0001)) return 'Doors and windows cannot overlap.';
      }
      return '';
    }
    function markup(item, ghost = false) {
      const [a, b] = anchors(item);
      if (!a) return '';
      const cls = (item.kind === 'door' ? 'wifi-door' : 'wifi-window')
        + (ctx.walls().get(item.wall_id)?.material === 'reinforced_concrete' ? ' is-reinforced' : '');
      const style = ghost ? ' wifi-opening-ghost' : item.id === ctx.selected() ? ' is-selected' : '';
      const attr = ghost ? '' : `data-wifi-object="${ctx.escape(item.id)}"`;
      let geometry = '';
      if (item.kind === 'door') {
        const nx = -(b.y - a.y), ny = b.x - a.x;
        geometry = `<path class="wifi-door-swing" d="M ${b.x} ${b.y} A ${item.width} ${item.width} 0 0 1 ${a.x + nx} ${a.y + ny} L ${a.x} ${a.y}"/>`;
      } else {
        const nx = -(b.y - a.y) * 0.055 / item.width, ny = (b.x - a.x) * 0.055 / item.width;
        geometry = ctx.line({ x: a.x + nx, y: a.y + ny }, { x: b.x + nx, y: b.y + ny }, 'class="wifi-window-rail"')
          + ctx.line({ x: a.x - nx, y: a.y - ny }, { x: b.x - nx, y: b.y - ny }, 'class="wifi-window-rail"');
      }
      return `<g class="wifi-opening ${cls}${style}" ${attr}><title>${model.OPENINGS[item.kind][item.material].name}</title>
        ${ctx.line(a, b, 'class="wifi-opening-gap"')}${geometry}${ctx.line(a, b, 'class="wifi-opening-hit"')}</g>`;
    }
    function draw() {
      const plan = ctx.plan();
      if (openingsRef !== plan.openings || wallsRef !== plan.walls || selection !== ctx.selected()) {
        openingsRef = plan.openings;
        wallsRef = plan.walls;
        selection = ctx.selected();
        $('wifiOpenings').innerHTML = plan.openings.map(item => markup(item)).join('');
      }
      const image = background();
      if (painted === image) return;
      const el = $('wifiBackgroundImage');
      if (image) {
        if (painted?.image !== image.image) el.setAttribute('href', `data:image/jpeg;base64,${image.image}`);
        for (const [key, value] of Object.entries({ x: image.x, y: image.y, width: image.width, height: height(image) })) el.setAttribute(key, value);
      } else el.removeAttribute('href');
      painted = image;
    }
    function inspector(item) {
      const wall = ctx.walls().get(item.wall_id);
      const materials = Object.entries(model.OPENINGS[item.kind]).map(([key, value]) => [key, value.name]);
      return `<label>Material<select data-wifi-opening="material">${ctx.choices(materials, item.material)}</select></label>
        <label>Width (${ctx.plan().units})<input type="number" step="any" data-wifi-opening="width" value="${ctx.number(item.width)}"></label>
        <label>Center from wall start (${ctx.plan().units})<input type="number" step="any" data-wifi-opening="offset" value="${ctx.number(wall.length * item.t)}"></label>`;
    }
    function edit(item, input) {
      const field = input.dataset.wifiOpening;
      const length = ctx.walls().get(item.wall_id).length;
      const value = input.valueAsNumber;
      const next = { ...item };
      if (field === 'material') next.material = input.value;
      else if (field === 'width' && Number.isFinite(value)) next.width = Math.max(0.3, Math.min(8, ctx.toMeters(value)));
      else if (field === 'offset' && Number.isFinite(value)) next.t = Math.max(0, Math.min(1, ctx.toMeters(value) / length));
      ctx.replace('openings', next);
      input.value = field === 'material' ? (ctx.plan().openings.find(opening => opening.id === item.id).material)
        : ctx.number(field === 'width' ? ctx.plan().openings.find(opening => opening.id === item.id).width : length * ctx.plan().openings.find(opening => opening.id === item.id).t);
    }
    function slide(item, point) {
      const wall = ctx.walls().get(item.wall_id);
      const hit = cable.closestWall(point, [wall], Infinity);
      const half = item.width / (2 * wall.length);
      return { ...item, t: Math.max(half, Math.min(1 - half, hit.t)) };
    }
    async function importFile(file) {
      if (!file) return;
      if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || file.size > 16_000_000) {
        $('wifiBackgroundStatus').textContent = 'Choose a PNG, JPEG, or WebP image under 16 MB.';
        return;
      }
      const project = ctx.project(), generation = ++request;
      $('wifiBackgroundStatus').textContent = 'Preparing the floor plan…';
      let source;
      try {
        source = await createImageBitmap(file);
        const scale = Math.min(1, 2400 / Math.max(source.width, source.height));
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(source.width * scale));
        canvas.height = Math.max(1, Math.round(source.height * scale));
        const graphics = canvas.getContext('2d', { alpha: false });
        graphics.fillStyle = 'white';
        graphics.fillRect(0, 0, canvas.width, canvas.height);
        graphics.drawImage(source, 0, 0, canvas.width, canvas.height);
        let image = '';
        for (const quality of [0.88, 0.74, 0.55, 0.35]) {
          image = canvas.toDataURL('image/jpeg', quality).split(',')[1] || '';
          if (image && image.length <= 600000) break;
        }
        if (!image || image.length > 600000) throw new Error('Image is too detailed');
        if (generation !== request || project !== ctx.project()) return;
        const box = ctx.initialImageBounds(canvas.width, canvas.height);
        ctx.updateBackground({ ...box, image, pixel_width: canvas.width, pixel_height: canvas.height });
        $('wifiBackgroundStatus').textContent = 'Image added. Set its width or calibrate with two points.';
      } catch {
        if (generation === request && project === ctx.project()) $('wifiBackgroundStatus').textContent = 'Could not import this image. Try a smaller floor plan.';
      } finally { source?.close(); }
    }
    function backgroundControls() {
      const image = background();
      $('wifiBackgroundFields').hidden = $('wifiBackgroundMove').hidden = $('wifiBackgroundRemove').hidden = !image;
      $('wifiBackgroundImport').textContent = image ? 'Replace Image' : 'Add Image';
      for (const unit of $('wifiBackgroundPanel').querySelectorAll('[data-wifi-unit]')) unit.textContent = `(${ctx.plan().units})`;
      if (!image) return;
      for (const input of $('wifiBackgroundPanel').querySelectorAll('[data-wifi-background]')) input.value = ctx.number(image[input.dataset.wifiBackground]);
      $('wifiBackgroundHeight').value = ctx.fmt(height(image));
    }
    function resetCalibration() {
      first = second = null;
      $('wifiBackgroundCalibration').hidden = true;
      $('wifiBackgroundDistance').value = '';
    }
    function calibrationPoint(point) {
      const image = background();
      if (!image || point.x < image.x || point.x > image.x + image.width || point.y < image.y || point.y > image.y + height(image)) {
        ctx.hint('Choose a point inside the background image.');
        return;
      }
      if (!first) { first = point; ctx.hint('Choose the second point along a known distance.'); }
      else if (cable.distance(first, point) >= 0.001) {
        second = point;
        ctx.showPanel('background');
        $('wifiBackgroundCalibration').hidden = false;
        $('wifiBackgroundDistance').focus();
      }
      ctx.frame();
    }
    function calibrate(event) {
      event.preventDefault();
      const image = background();
      const factor = ctx.toMeters($('wifiBackgroundDistance').valueAsNumber) / cable.distance(first, second);
      if (!Number.isFinite(factor) || image.width * factor < 0.1 || image.width * factor > 10000) {
        $('wifiBackgroundStatus').textContent = 'Enter a distance that keeps the image width between 0.1 m and 10,000 m.';
        return;
      }
      ctx.updateBackground({ ...image, width: image.width * factor,
        x: ctx.coordinate(first.x + (image.x - first.x) * factor), y: ctx.coordinate(first.y + (image.y - first.y) * factor) });
      resetCalibration();
      ctx.changeTool('select');
      ctx.showPanel('background');
      $('wifiBackgroundStatus').textContent = 'Image scale updated.';
    }
    function calibrationMarkup() {
      return (first ? ctx.dot(first, 5, 'wifi-cursor') : '') + (second ? ctx.line(first, second, 'class="wifi-preview-line"') + ctx.dot(second, 5, 'wifi-cursor') : '');
    }
    function reset() {
      painted = openingsRef = wallsRef = selection = null;
      request += 1;
      $('wifiBackgroundImage').removeAttribute('href');
      $('wifiBackgroundStatus').textContent = 'Import a PNG, JPEG, or WebP floor plan.';
      resetCalibration();
    }
    function init() {
      $('wifiBackgroundImport').addEventListener('click', () => $('wifiBackgroundFile').click());
      $('wifiBackgroundFile').addEventListener('change', event => { importFile(event.target.files[0]); event.target.value = ''; });
      $('wifiBackgroundRemove').addEventListener('click', () => {
        ctx.updateBackground(null);
        $('wifiBackgroundStatus').textContent = 'Image removed. You can undo this change.';
      });
      $('wifiBackgroundMove').addEventListener('click', () => {
        ctx.changeTool('background-move');
        ctx.hint('Drag to move the background. Click Background to return to its settings.');
      });
      $('wifiBackgroundCalibrate').addEventListener('click', () => {
        resetCalibration();
        ctx.changeTool('background-scale');
        ctx.hint('Choose two points on the image whose real-world distance you know.');
      });
      $('wifiBackgroundCalibration').addEventListener('submit', calibrate);
      $('wifiBackgroundPanel').addEventListener('change', event => {
        const key = event.target.dataset.wifiBackground;
        const value = event.target.valueAsNumber;
        const image = background();
        if (key && image && Number.isFinite(value)) {
          const meters = ctx.toMeters(value);
          ctx.updateBackground({ ...image, [key]: key === 'width' ? Math.max(0.1, Math.min(10000, meters)) : ctx.coordinate(meters) });
        }
        if (key) backgroundControls();
      });
    }
    return { init, reset, draw, place, validate, markup, anchors, slide, inspector, edit, height,
      backgroundControls, calibrationPoint, calibrationMarkup, resetCalibration };
  }

  window.WifiSiteStructure = { create };
})();
