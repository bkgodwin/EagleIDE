const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

test('a connected classroom LAN delivers a ping with advanced inspection loaded', () => {
  const document = { getElementById: () => null, querySelectorAll: () => [] };
  const window = {
    addEventListener() {},
    EagleIDE: { getContext: () => ({ currentConfig: {} }) },
  };
  const context = vm.createContext({ document, window, console });
  for (const script of ['network-sim.js', 'network-sim-advanced.js']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../static/js', script), 'utf8'), context);
  }
  const simulator = window.NetworkSim;
  const state = simulator.getState();
  state.topology = {
    devices: ['pc1', 'pc2'].map((id, index) => ({
      id, name: id, type: 'pc', config: { ...simulator.defaultConfig('pc'), ip: `192.168.10.${11 + index}` },
    })),
    links: [{ id: 'link-1', source: 'pc1', target: 'pc2', source_port: 'LAN1', target_port: 'LAN1', kind: 'ethernet' }],
  };
  const result = simulator.simulatePacket('pc1', 'pc2');
  assert.equal(result.allowed, true, result.reason);
  assert.equal(result.layers.hops, 1);
});
