/* Paint cached world tiles into a single viewport-sized coverage canvas. */
(function () {
  'use strict';

  const model = window.WifiSiteModel;
  const tileKey = ({ x, y, level }) => `${level}:${x}:${y}`;

  function sameRadios(before, after) {
    return before === after || (before.length === after.length && before.every((ap, i) => {
      const next = after[i];
      return ap.x === next.x && ap.y === next.y && ap.mount === next.mount
        && ap.angle === next.angle && ap.power_db === next.power_db;
    }));
  }

  function create(canvas, setUpdating) {
    const context = canvas.getContext('2d');
    const cache = new Map();
    let layout;
    let areas = [];
    let view;
    let revision = 0;
    let workerRevision = -1;
    let worker;
    let workerFailed = false;
    let fallback;
    let pending;
    let queue = [];
    let frame = 0;
    let cacheLimit = 192;

    function invalidate() {
      if (!frame) frame = requestAnimationFrame(paint);
    }

    function setPlan(next) {
      if (layout && layout.walls === next.walls && layout.openings === next.openings && layout.band === next.band
          && layout.decor === next.decor && sameRadios(layout.access_points, next.access_points)) return;
      layout = next;
      revision += 1;
      areas = model.heatAreas(next.access_points, next.band);
      fallback = null;
      cache.clear();
      queue = [];
      invalidate();
    }

    function setView(camera, width, height, enabled) {
      if (view?.camera === camera && view.width === width && view.height === height && view.enabled === enabled) return;
      view = { camera, width, height, enabled };
      queue = [];
      invalidate();
    }

    function clear() {
      revision += 1;
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
      worker?.terminate();
      worker = layout = view = pending = fallback = null;
      workerRevision = -1;
      queue = [];
      areas = [];
      cache.clear();
      canvas.hidden = true;
      canvas.width = canvas.height = 1;
      setUpdating(false);
    }

    function tilesInView(level, bounds) {
      const size = model.tileSize(level);
      const left = Math.floor(bounds.left / size), top = Math.floor(bounds.top / size);
      const right = Math.ceil(bounds.right / size), bottom = Math.ceil(bounds.bottom / size);
      const centerX = (bounds.left + bounds.right) / (2 * size);
      const centerY = (bounds.top + bounds.bottom) / (2 * size);
      const tiles = [];
      for (let y = top; y < bottom; y += 1) {
        for (let x = left; x < right; x += 1) {
          const tile = { x, y, level };
          if (model.tileHasCoverage(areas, tile)) {
            tiles.push({ tile, distance: (x + 0.5 - centerX) ** 2 + (y + 0.5 - centerY) ** 2 });
          }
        }
      }
      return tiles.sort((a, b) => a.distance - b.distance).map(item => item.tile);
    }

    function rectangle(tile, camera, ratio) {
      const bounds = model.tileBounds(tile);
      const scale = camera.scale * ratio;
      return {
        left: Math.round((bounds.left - camera.x) * scale),
        top: Math.round((bounds.top - camera.y) * scale),
        right: Math.round((bounds.right - camera.x) * scale),
        bottom: Math.round((bounds.bottom - camera.y) * scale),
      };
    }

    function draw(entry, rect, clearUnder) {
      const { left, top, right, bottom } = rect;
      const width = right - left, height = bottom - top;
      if (width <= 0 || height <= 0 || right < 0 || bottom < 0 || left > canvas.width || top > canvas.height) return;
      if (clearUnder) context.clearRect(left, top, width, height);
      if (!entry.image) return;
      // Sample one pixel across each edge, then clip to shared device-pixel bounds.
      const gutterX = width * model.PADDING / model.SAMPLES;
      const gutterY = height * model.PADDING / model.SAMPLES;
      context.save();
      context.beginPath();
      context.rect(left, top, width, height);
      context.clip();
      context.drawImage(entry.image, left - gutterX, top - gutterY, width + 2 * gutterX, height + 2 * gutterY);
      context.restore();
    }

    function paint() {
      frame = 0;
      if (!view || !layout) return;
      const { camera, width, height, enabled } = view;
      if (!enabled || !areas.length || !width || !height) {
        canvas.hidden = true;
        setUpdating(false);
        return;
      }
      const ratio = Math.min(window.devicePixelRatio || 1, 2, Math.sqrt(4_000_000 / (width * height)));
      const w = Math.ceil(width * ratio), h = Math.ceil(height * ratio);
      if (canvas.width !== w) canvas.width = w;
      if (canvas.height !== h) canvas.height = h;
      context.clearRect(0, 0, w, h);
      context.imageSmoothingEnabled = true;
      canvas.hidden = false;

      const level = model.tileLevel(camera.scale);
      const bounds = window.WifiSiteView.viewportBounds(camera, width, height);
      const tiles = tilesInView(level, bounds);
      const missing = tiles.filter(tile => !cache.has(tileKey(tile)));
      queue = missing.filter(tile => !pending || pending.revision !== revision || pending.key !== tileKey(tile));
      cacheLimit = Math.max(192, tiles.length * 3);

      if (missing.length) {
        const previousLevels = new Set();
        for (const entry of cache.values()) {
          const difference = Math.abs(entry.tile.level - level);
          if (entry.image && difference > 0 && difference <= 2) previousLevels.add(entry.tile.level);
        }
        const previous = [...previousLevels].sort((a, b) => Math.abs(a - level) - Math.abs(b - level))[0];
        for (const entry of cache.values()) {
          if (entry.tile.level === previous) draw(entry, rectangle(entry.tile, camera, ratio), false);
        }
      }
      for (const tile of tiles) {
        const key = tileKey(tile);
        const entry = cache.get(key);
        if (!entry) continue;
        cache.delete(key);
        cache.set(key, entry);
        draw(entry, rectangle(tile, camera, ratio), missing.length > 0);
      }
      setUpdating(missing.length > 0);
      requestTile();
    }

    function tileReady(data) {
      if (pending?.revision !== data.revision || pending.key !== tileKey(data.tile)) return;
      pending = null;
      if (data.revision === revision && view?.enabled) {
        let image = null;
        if (data.pixels) {
          const size = model.SAMPLES + model.PADDING * 2;
          image = document.createElement('canvas');
          image.width = image.height = size;
          image.getContext('2d').putImageData(new ImageData(data.pixels, size, size), 0, 0);
        }
        cache.set(tileKey(data.tile), { tile: data.tile, image });
        while (cache.size > cacheLimit) cache.delete(cache.keys().next().value);
      }
      invalidate();
      requestTile();
    }

    function requestTile() {
      if (pending || !queue.length) return;
      const tile = queue.shift();
      const job = { revision, tile };
      pending = { ...job, key: tileKey(tile) };
      if (!worker && !workerFailed) {
        try {
          const source = new Worker('/static/js/wifi-site-worker.js?v=20261113-design');
          worker = source;
          source.onmessage = ({ data }) => { if (worker === source) tileReady(data); };
          source.onerror = () => {
            if (worker !== source) return;
            source.terminate();
            worker = pending = null;
            workerFailed = true;
            invalidate();
          };
        } catch {
          workerFailed = true;
        }
      }
      if (worker) {
        if (workerRevision !== revision) {
          worker.postMessage({ revision, plan: layout });
          workerRevision = revision;
        }
        worker.postMessage(job);
      } else {
        requestAnimationFrame(() => {
          if (job.revision !== revision || !view?.enabled) { tileReady(job); return; }
          fallback ||= model.createHeatSource(layout);
          tileReady({ ...job, pixels: fallback(tile) });
        });
      }
    }

    return { setPlan, setView, clear };
  }

  window.WifiSiteHeatmap = { create };
})();
