/* Lazy-load Chart.js and jsPDF when teacher dashboard reports need them */
(function () {
  'use strict';

  const libs = {
    chart: {
      src: 'https://cdn.jsdelivr.net/npm/chart.js@4.4.3/dist/chart.umd.min.js',
      integrity: 'sha384-JUh163oCRItcbPme8pYnROHQMC6fNKTBWtRG3I3I0erJkzNgL7uxKlNwcrcFKeqF',
      global: 'Chart',
      loading: null,
    },
    jspdf: {
      src: 'https://cdn.jsdelivr.net/npm/jspdf@2.5.1/dist/jspdf.umd.min.js',
      integrity: 'sha384-JcnsjUPPylna1s1fvi1u12X5qjY5OL56iySh75FdtrwhO/SWXgMjoVqcKyIIWOLk',
      global: 'jspdf',
      loading: null,
    },
  };

  function loadScript(src, integrity) {
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src;
      s.integrity = integrity;
      s.crossOrigin = "anonymous";
      s.async = true;
      s.onload = () => resolve();
      s.onerror = () => reject(new Error(`Failed to load ${src}`));
      document.head.appendChild(s);
    });
  }

  async function ensureLib(name) {
    const lib = libs[name];
    if (!lib) throw new Error(`Unknown lib: ${name}`);
    if (window[lib.global]) return window[lib.global];
    if (!lib.loading) {
      lib.loading = loadScript(lib.src, lib.integrity).then(() => window[lib.global]);
    }
    return lib.loading;
  }

  function attachLibHelpers() {
    window.EagleIDE = window.EagleIDE || {};
    window.EagleIDE.ensureChart = () => ensureLib('chart');
    window.EagleIDE.ensureJsPDF = () => ensureLib('jspdf');
  }
  attachLibHelpers();
})();
