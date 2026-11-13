/* Render classroom coverage off the UI thread. */
'use strict';

importScripts('/static/js/wifi-site-model.js?v=20261113-plan');

let revision;
let renderTile;
self.onmessage = ({ data }) => {
  if (data.plan) {
    revision = data.revision;
    renderTile = self.WifiSiteModel.createHeatSource(data.plan);
    return;
  }
  const pixels = revision === data.revision ? renderTile(data.tile) : null;
  self.postMessage({ revision: data.revision, tile: data.tile, pixels }, pixels ? [pixels.buffer] : []);
};
