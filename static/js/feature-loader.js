/* Load large, optional EagleIDE features only when the user opens them. */
(function () {
  'use strict';

  const definitions = {
    network: [
      '/static/js/network-sim.js?v=20260714-18',
      '/static/js/network-sim-advanced.js?v=20260714-4',
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
      script.addEventListener('error', () => reject(new Error(`Could not load ${src}`)), { once: true });
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
      link.addEventListener('error', () => reject(new Error(`Could not load ${href}`)), { once: true });
      document.head.appendChild(link);
    });
  }

  function loadAsset(src) {
    return src.includes('.css?') || src.endsWith('.css') ? loadStylesheet(src) : loadScript(src);
  }

  function load(name) {
    if (!definitions[name]) return Promise.reject(new Error(`Unknown EagleIDE feature: ${name}`));
    if (name === 'network' && window.NetworkSim && window.NetworkSimAdvanced) return Promise.resolve();
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
      console.error('Network Simulator failed to load:', error);
      window.alert('The Network Simulator could not be loaded. Refresh the page and try again.');
    } finally {
      if (trigger) {
        trigger.disabled = false;
        trigger.removeAttribute('aria-busy');
      }
    }
  }

  const networkTriggerSelector = '#networkViewBtn, #wikiHeroNetworkBtn, #settingsOpenNetworkSimBtn';
  document.addEventListener('pointerover', event => {
    if (event.target.closest?.(networkTriggerSelector)) load('network').catch(() => {});
  }, { passive: true, capture: true });
  document.addEventListener('focusin', event => {
    if (event.target.closest?.(networkTriggerSelector)) load('network').catch(() => {});
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
    isLoaded: name => (
      (name === 'network' && !!window.NetworkSim && !!window.NetworkSimAdvanced)
      || (name === 'wikiTools' && !!window.WikiTools)
    ),
  });
})();
