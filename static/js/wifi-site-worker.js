/* Render classroom coverage off the UI thread. */
'use strict';

importScripts('/static/js/wifi-site-model.js?v=20261112-site');

self.onmessage = ({ data }) => {
  const { columns, rows, pixels } = self.WifiSiteModel.heatmap(data.plan);
  self.postMessage({ id: data.id, columns, rows, pixels }, [pixels.buffer]);
};
