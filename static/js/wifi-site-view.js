/* Meter-based camera and construction helpers for the Wi-Fi drawing surface. */
(function (root) {
  'use strict';

  const MIN_SCALE = 0.0000001;
  const MAX_SCALE = 128;
  const clampScale = scale => Math.max(MIN_SCALE, Math.min(MAX_SCALE, scale));
  const clamp = (value, limit) => Math.max(-limit, Math.min(limit, value));

  function screenToWorld(camera, point) {
    return { x: camera.x + point.x / camera.scale, y: camera.y + point.y / camera.scale };
  }

  function worldToScreen(camera, point) {
    return { x: (point.x - camera.x) * camera.scale, y: (point.y - camera.y) * camera.scale };
  }

  function placeWorldPoint(world, screen, scale) {
    scale = clampScale(scale);
    return { x: world.x - screen.x / scale, y: world.y - screen.y / scale, scale };
  }

  function zoomAt(camera, screen, factor) {
    return placeWorldPoint(screenToWorld(camera, screen), screen, camera.scale * factor);
  }

  function bounds(points) {
    if (!points.length) return null;
    const first = points[0];
    const result = { left: first.x, top: first.y, right: first.x, bottom: first.y };
    for (const { x, y } of points) {
      result.left = Math.min(x, result.left);
      result.top = Math.min(y, result.top);
      result.right = Math.max(x, result.right);
      result.bottom = Math.max(y, result.bottom);
    }
    return result;
  }

  function viewportBounds(camera, width, height, margin = 0) {
    return {
      left: camera.x - margin / camera.scale, top: camera.y - margin / camera.scale,
      right: camera.x + (width + margin) / camera.scale, bottom: camera.y + (height + margin) / camera.scale,
    };
  }

  function fitCamera(rect, width, height) {
    const { left, top, right, bottom } = rect || { left: 0, top: 0, right: 40, bottom: 28 };
    const padding = Math.min(100, width * 0.22, height * 0.22);
    const scale = Math.min(38, (width - padding) / Math.max(8, right - left),
      (height - padding) / Math.max(8, bottom - top));
    return placeWorldPoint({ x: (left + right) / 2, y: (top + bottom) / 2 }, { x: width / 2, y: height / 2 }, scale);
  }

  function gridSpacing(scale, base) {
    // A 1–2–5 scale keeps the grid readable at both room and campus zoom.
    const required = 14 / (scale * base);
    const power = 10 ** Math.floor(Math.log10(required));
    const factor = [1, 2, 5, 10].find(value => value * power >= required);
    return factor * power * base;
  }

  function scaleBar(scale, displayUnit, target = 92) {
    const limit = target / (scale * displayUnit);
    const power = 10 ** Math.floor(Math.log10(limit));
    const factor = [5, 2, 1].find(value => value * power <= limit) || 1;
    return factor * power * displayUnit;
  }

  function snapConstruction(point, { origin, orthogonal, endpoints = [], exclude, tolerance = 0, step = 0 }) {
    const fixed = origin && orthogonal ? (Math.abs(point.x - origin.x) >= Math.abs(point.y - origin.y) ? 'y' : 'x') : '';
    const aligned = fixed ? { ...point, [fixed]: origin[fixed] } : point;
    let distance = tolerance * tolerance;
    let closest = null;
    for (const end of endpoints) {
      if ((exclude && end.wallId === exclude) || (fixed && Math.abs(end[fixed] - origin[fixed]) > 0.0001)) continue;
      const gap = (end.x - aligned.x) ** 2 + (end.y - aligned.y) ** 2;
      if (gap <= distance) {
        distance = gap;
        closest = end;
      }
    }
    if (closest) return { point: { x: closest.x, y: closest.y }, joined: true };
    const snapped = step
      ? { x: Math.round(aligned.x / step) * step, y: Math.round(aligned.y / step) * step }
      : { ...aligned };
    if (fixed) snapped[fixed] = origin[fixed];
    return { point: snapped, joined: false };
  }

  const view = { clamp, screenToWorld, worldToScreen, placeWorldPoint, zoomAt, bounds, viewportBounds,
    fitCamera, gridSpacing, scaleBar, snapConstruction };
  if (typeof module === 'object' && module.exports) module.exports = view;
  else root.WifiSiteView = view;
})(globalThis);
