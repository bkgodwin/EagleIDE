/* Render the full site in a bounded offscreen frame, independent of the editor camera. */
(function () {
  'use strict';

  function layout(bounds, marks) {
    const width = Math.max(1, bounds.right - bounds.left), height = Math.max(1, bounds.bottom - bounds.top);
    const margin = 25;
    const extent = scale => {
      const rect = { left: -6, right: width * scale + 6, top: -6, bottom: height * scale + 6 };
      for (const mark of marks) {
        const x = (mark.x - bounds.left) * scale, y = (mark.y - bounds.top) * scale;
        rect.left = Math.min(rect.left, x - mark.left);
        rect.right = Math.max(rect.right, x + mark.right);
        rect.top = Math.min(rect.top, y - mark.top);
        rect.bottom = Math.max(rect.bottom, y + mark.bottom);
      }
      return rect;
    };
    const fit = (w, h) => {
      let lo = 0, hi = Math.min(w / width, h / height, 110);
      for (let i = 0; i < 24; i += 1) {
        const scale = (lo + hi) / 2, rect = extent(scale);
        if (rect.right - rect.left + margin * 2 <= w && rect.bottom - rect.top + margin * 2 <= h) lo = scale;
        else hi = scale;
      }
      return lo;
    };
    const scale = Math.max(fit(1020, 1190), fit(1340, 840));
    const rect = extent(scale);
    return { scale, width: Math.max(190, Math.ceil(rect.right - rect.left + margin * 2)),
      height: Math.max(85, Math.ceil(rect.bottom - rect.top + margin * 2)),
      x: bounds.left + (rect.left - margin) / scale, y: bounds.top + (rect.top - margin) / scale };
  }

  function stylesheet() {
    return Array.from(document.styleSheets).filter(sheet => sheet.href?.includes('/features/wifi-site.css'))
      .flatMap(sheet => Array.from(sheet.cssRules).map(rule => rule.cssText)).join('\n');
  }

  function svgImage(frame, content, styles, ratio) {
    const { width, height, x, y, scale } = frame;
    const markup = `<svg xmlns="http://www.w3.org/2000/svg" width="${width * ratio}" height="${height * ratio}"
      viewBox="${x} ${y} ${width / scale} ${height / scale}">
      <style><![CDATA[${styles}
        .wifi-marker { transform: scale(${1 / scale}); }
        .wifi-wall { stroke-width: ${4 * ratio}; }
        .wifi-wall-reinforced_concrete { stroke-width: ${8 * ratio}; }
        .wifi-opening-gap { stroke-width: ${5 * ratio}; }
        .wifi-opening.is-reinforced .wifi-opening-gap { stroke-width: ${9 * ratio}; }
        .wifi-window-rail, .wifi-door-swing { stroke-width: ${1.5 * ratio}; }
        .wifi-wire { vector-effect: non-scaling-stroke; }
      ]]></style>${content}</svg>`;
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(new Blob([markup], { type: 'image/svg+xml;charset=utf-8' }));
      const image = new Image();
      image.onload = () => { URL.revokeObjectURL(url); resolve(image); };
      image.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Could not render the floor plan.')); };
      image.src = url;
    });
  }

  async function heatLayer(frame, plan) {
    if (!plan?.access_points.length) return null;
    const canvas = document.createElement('canvas');
    let painter;
    try {
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Coverage is taking too long to export. Turn it off and try again.')), 18000);
        painter = window.WifiSiteHeatmap.create(canvas, updating => {
          if (!updating) { clearTimeout(timeout); resolve(); }
        });
        painter.setPlan(plan);
        painter.setView(frame, frame.width, frame.height, true);
      });
      const copy = document.createElement('canvas');
      copy.width = canvas.width;
      copy.height = canvas.height;
      copy.getContext('2d').drawImage(canvas, 0, 0);
      return copy;
    } finally { painter?.clear(); }
  }

  async function render({ bounds, plan, background, surfaces, groups, coverage }) {
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    const layers = groups.map(group => {
      const copy = group.cloneNode(true);
      copy.querySelectorAll('title, .wifi-selected-wall, .wifi-wall-hit, .wifi-opening-hit, .wifi-wire-hit, .wifi-decor-hit').forEach(node => node.remove());
      copy.querySelectorAll('.is-selected, .wifi-moving-source').forEach(node => node.classList.remove('is-selected', 'wifi-moving-source'));
      copy.querySelectorAll('[data-wifi-bundle-length]').forEach(node => { node.style.visibility = ''; });
      return copy;
    });
    const marks = [];
    for (const layer of layers) for (const marker of layer.querySelectorAll('.wifi-marker')) {
      const point = marker.parentElement.getAttribute('transform')?.match(/translate\(([^ ]+) ([^)]+)\)/);
      if (!point) continue;
      const mark = { x: Number(point[1]), y: Number(point[2]), left: 20, right: 24, top: 22, bottom: 16 };
      for (const label of marker.querySelectorAll('text')) {
        ctx.font = '700 13px system-ui, sans-serif';
        const width = ctx.measureText(label.textContent).width + 4;
        if (label.getAttribute('text-anchor') === 'middle') { mark.left = Math.max(mark.left, width / 2); mark.right = Math.max(mark.right, width / 2); }
        else mark.right = Math.max(mark.right, Number(label.getAttribute('x') || 0) + width);
      }
      marks.push(mark);
    }
    const frame = layout(bounds || { left: 0, top: 0, right: 24, bottom: 16 }, marks);
    const { width, height } = frame;
    const ratio = Math.min(2, Math.floor(2500 / Math.max(width, height) * 100) / 100, Math.sqrt(4_900_000 / (width * height)));
    canvas.width = Math.floor(width * ratio);
    canvas.height = Math.floor(height * ratio);
    const styles = stylesheet();
    // XML serialization preserves inline styles and the embedded reference image.
    const serialize = node => new XMLSerializer().serializeToString(node);
    const behind = (background?.hasAttribute('href') ? `<g opacity=".58">${serialize(background)}</g>` : '')
      + Array.from(surfaces.children).map(serialize).join('');
    const [under, heat, over] = await Promise.all([svgImage(frame, behind, styles, ratio), heatLayer(frame, coverage),
      svgImage(frame, layers.map(serialize).join(''), styles, ratio)]);
    ctx.setTransform(canvas.width / width, 0, 0, canvas.height / height, 0, 0);
    ctx.fillStyle = plan.background_color || '#ffffff';
    ctx.fillRect(0, 0, width, height);
    for (const image of [under, heat, over]) if (image) ctx.drawImage(image, 0, 0, width, height);
    const unit = plan.units === 'ft' ? .3048 : 1;
    const meters = window.WifiSiteView.scaleBar(frame.scale, unit, Math.min(90, width / 3));
    const length = meters * frame.scale;
    ctx.fillStyle = '#172d40';
    ctx.strokeStyle = '#172d40';
    ctx.font = '600 11px system-ui, sans-serif';
    const label = `${Number((meters / unit).toPrecision(3))} ${plan.units}`;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(12, height - 21, length + ctx.measureText(label).width + 22, 17);
    ctx.fillStyle = '#172d40';
    ctx.fillText(label, 24 + length, height - 8);
    ctx.beginPath(); ctx.moveTo(17, height - 15); ctx.lineTo(17, height - 10);
    ctx.lineTo(17 + length, height - 10); ctx.lineTo(17 + length, height - 15); ctx.stroke();
    let encoded = canvas.toDataURL('image/jpeg', .91).split(',')[1];
    if (encoded.length > 2_400_000) encoded = canvas.toDataURL('image/jpeg', .7).split(',')[1];
    return encoded;
  }

  window.WifiSiteExport = { render };
})();
