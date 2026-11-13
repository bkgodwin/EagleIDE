/* Load large, optional EagleIDE features only when the user opens them. */
(function () {
  'use strict';

  const definitions = {
    adminCleanup: ['/static/js/admin-cleanup.js?v=20261109-history'],
    externalToolsAdmin: ['/static/js/external-tools-admin.js?v=20261020-storage-1'],
    eagleLab: ['/static/js/lab-report-content.js?v=20261103', '/static/js/eagle-lab.js?v=20261103', '/static/js/lab-manual.js?v=20261103', '/static/js/lab-report-editor.js?v=20261103'],
    network: [
      '/static/js/network-sim.js?v=20261113-design',
      '/static/js/network-sim-advanced.js?v=20261113-hub',
    ],
    wifiSite: [
      '/static/css/features/wifi-site.css?v=20261113-design',
      '/static/js/wifi-site-model.js?v=20261113-design',
      '/static/js/wifi-site-design.js?v=20261113-design',
      '/static/js/wifi-site-view.js?v=20261112-open-canvas',
      '/static/js/wifi-site-heatmap.js?v=20261113-design',
      '/static/js/wifi-cabling-model.js?v=20261113-design',
      '/static/js/wifi-site-cabling.js?v=20261113-hub',
      '/static/js/wifi-site-structure.js?v=20261113-design',
      '/static/js/wifi-site-example.js?v=20261113-hub',
      '/static/js/wifi-site-export.js?v=20261113-design',
      '/static/js/wifi-site.js?v=20261113-design',
    ],
    wikiTools: [
      '/static/css/features/wiki-tools.css?v=20260921-1',
      '/static/js/wiki-tools.js?v=20260921-1',
    ],
  };
  const pending = new Map();

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const existing = document.querySelector(`script[data-eagle-feature-src="${src}"]`);
      if (existing?.dataset.loaded === 'true') {
        resolve();
        return;
      }
      if (existing) {
        existing.addEventListener('load', resolve, { once: true });
        existing.addEventListener('error', () => reject(new Error(`Could not load ${src}`)), { once: true });
        return;
      }
      const script = document.createElement('script');
      script.src = src;
      script.async = true;
      script.dataset.eagleFeatureSrc = src;
      script.addEventListener('load', () => {
        script.dataset.loaded = 'true';
        resolve();
      }, { once: true });
      script.addEventListener('error', () => {
        script.remove();
        reject(new Error(`Could not load ${src}`));
      }, { once: true });
      document.head.appendChild(script);
    });
  }

  function loadStylesheet(href) {
    return new Promise((resolve, reject) => {
      const existing = document.querySelector(`link[data-eagle-feature-href="${href}"]`);
      if (existing?.dataset.loaded === 'true') {
        resolve();
        return;
      }
      if (existing) {
        existing.addEventListener('load', resolve, { once: true });
        existing.addEventListener('error', () => reject(new Error(`Could not load ${href}`)), { once: true });
        return;
      }
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = href;
      link.dataset.eagleFeatureHref = href;
      link.addEventListener('load', () => {
        link.dataset.loaded = 'true';
        resolve();
      }, { once: true });
      link.addEventListener('error', () => {
        link.remove();
        reject(new Error(`Could not load ${href}`));
      }, { once: true });
      document.head.appendChild(link);
    });
  }

  function loadAsset(src) {
    return src.includes('.css?') || src.endsWith('.css') ? loadStylesheet(src) : loadScript(src);
  }

  function load(name) {
    if (!definitions[name]) return Promise.reject(new Error(`Unknown EagleIDE feature: ${name}`));
    if (name === 'network' && window.NetworkSim && window.NetworkSimAdvanced) return Promise.resolve();
    if (name === 'eagleLab' && window.EagleLab && window.LabReportEditor && window.LabManual) return Promise.resolve();
    if (name === 'wikiTools' && window.WikiTools) return Promise.resolve();
    if (pending.has(name)) return pending.get(name);
    const request = definitions[name]
      .reduce((chain, src) => chain.then(() => loadAsset(src)), Promise.resolve())
      .catch(error => {
        pending.delete(name);
        throw error;
      });
    pending.set(name, request);
    return request;
  }

  async function openNetwork(trigger, options) {
    window.WikiReader?.disposeActiveContent?.();
    if (trigger) {
      trigger.disabled = true;
      trigger.setAttribute('aria-busy', 'true');
    }
    try {
      await load('network');
      await window.NetworkSim?.show?.(options || {});
    } catch (error) {
      console.error('Network Lab failed to load:', error);
      window.alert('Network Lab could not be loaded. Refresh the page and try again.');
    } finally {
      if (trigger) {
        trigger.disabled = false;
        trigger.removeAttribute('aria-busy');
      }
    }
  }

  async function openEagleLab(trigger, options) {
    window.WikiReader?.disposeActiveContent?.();
    if (trigger) { trigger.disabled = true; trigger.setAttribute('aria-busy', 'true'); }
    try {
      await load('eagleLab');
      await window.EagleLab?.show?.(options || {});
    } catch (error) {
      console.error('Eagle Lab failed to load:', error);
      window.alert('Eagle Lab could not be loaded. Refresh the page and try again.');
    } finally {
      if (trigger) { trigger.disabled = false; trigger.removeAttribute('aria-busy'); }
    }
  }

  async function openLabReport(assignmentId, assignment) {
    await load('eagleLab');
    return window.EagleLab?.openReportById?.(assignmentId, assignment);
  }

  const networkTriggerSelector = '#networkViewBtn, #wikiHeroNetworkBtn, #settingsOpenNetworkSimBtn';
  const eagleLabTriggerSelector = '#eagleLabViewBtn, [data-view="dash-eagle-lab"], [data-admin-settings-section="eagle-lab"]';
  document.addEventListener('pointerover', event => {
    if (event.target.closest?.(networkTriggerSelector)) load('network').catch(() => {});
    if (event.target.closest?.(eagleLabTriggerSelector)) load('eagleLab').catch(() => {});
  }, { passive: true, capture: true });
  document.addEventListener('focusin', event => {
    if (event.target.closest?.(networkTriggerSelector)) load('network').catch(() => {});
    if (event.target.closest?.(eagleLabTriggerSelector)) load('eagleLab').catch(() => {});
  }, true);
  document.addEventListener('click', event => {
    const trigger = event.target.closest?.('#eagleLabViewBtn');
    if (!trigger || window.EagleLab) return;
    event.preventDefault(); event.stopImmediatePropagation(); openEagleLab(trigger);
  }, true);
  document.addEventListener('click', event => {
    if (!event.target.closest?.('[data-admin-settings-section="eagle-lab"]')) return;
    load('eagleLab').then(() => window.EagleLab?.loadAdmin?.()).catch(() => {});
  }, true);
  document.addEventListener('click', event => {
    const trigger = event.target.closest?.(networkTriggerSelector);
    if (!trigger || (window.NetworkSim && window.NetworkSimAdvanced)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (trigger.id === 'settingsOpenNetworkSimBtn') {
      const modal = document.getElementById('adminSettingsModal');
      if (modal) modal.style.display = 'none';
    }
    openNetwork(trigger);
  }, true);

  window.EagleFeatures = Object.freeze({
    load,
    openNetwork,
    openEagleLab,
    openLabReport,
    isLoaded: name => (
      (name === 'network' && !!window.NetworkSim && !!window.NetworkSimAdvanced)
      || (name === 'eagleLab' && !!window.EagleLab)
      || (name === 'wikiTools' && !!window.WikiTools)
    ),
  });
})();
