const test = require('node:test');
const assert = require('node:assert/strict');

const tools = require('../static/js/wiki-tools.js');

test('decimal and binary conversions support the full unsigned 32-bit range', () => {
  const decimal = tools.calculateBinary('decimal-to-binary', '4294967295');
  assert.equal(decimal.width, 32);
  assert.equal(decimal.binary, '1'.repeat(32));
  assert.equal(decimal.decimal, 4294967295);
  assert.equal(decimal.contributions.length, 32);

  const binary = tools.calculateBinary('binary-to-decimal', '1100 0011');
  assert.equal(binary.decimal, 195);
  assert.equal(binary.binary, '11000011');
  assert.equal(binary.sum, '128 + 64 + 2 + 1');
});

test('binary conversion reports precise validation errors', () => {
  assert.throws(
    () => tools.calculateBinary('decimal-to-binary', '4294967296'),
    /largest supported 32-bit value/,
  );
  assert.throws(
    () => tools.calculateBinary('binary-to-decimal', `${'1'.repeat(32)}0`),
    /cannot be longer than 32 bits/,
  );
  assert.throws(() => tools.calculateBinary('binary-to-decimal', '10201'), /only 0s and 1s/);
});

test('IPv4 subnet calculation matches the reference /24 result', () => {
  const result = tools.calculateSubnet('193.186.4.226', 24);
  assert.deepEqual({
    network: result.network,
    range: result.usableRange,
    broadcast: result.broadcast,
    total: result.totalAddresses,
    usable: result.usableHosts,
    mask: result.subnetMask,
    wildcard: result.wildcardMask,
    binaryMask: result.binarySubnetMask,
    ipClass: result.ipClass,
    type: result.ipType,
  }, {
    network: '193.186.4.0',
    range: '193.186.4.1 – 193.186.4.254',
    broadcast: '193.186.4.255',
    total: 256,
    usable: 254,
    mask: '255.255.255.0',
    wildcard: '0.0.0.255',
    binaryMask: '11111111.11111111.11111111.00000000',
    ipClass: 'C',
    type: 'Public',
  });
});

test('subnet edge prefixes use point-to-point and single-host rules', () => {
  const pointToPoint = tools.calculateSubnet('10.0.0.9', 31);
  assert.equal(pointToPoint.network, '10.0.0.8');
  assert.equal(pointToPoint.broadcast, '10.0.0.9');
  assert.equal(pointToPoint.usableRange, '10.0.0.8 – 10.0.0.9');
  assert.equal(pointToPoint.usableHosts, 2);

  const host = tools.calculateSubnet('192.168.2.7', 32);
  assert.equal(host.network, '192.168.2.7');
  assert.equal(host.usableRange, '192.168.2.7');
  assert.equal(host.usableHosts, 1);
});

test('IPv4 validation identifies the invalid octet and reason', () => {
  assert.throws(() => tools.calculateSubnet('192.168.400.1', 24), /Octet 3 is 400/);
  assert.throws(() => tools.calculateSubnet('192.168.1', 24), /exactly four octets/);
  assert.throws(() => tools.calculateSubnet('192.168.one.1', 24), /Octet 3.*decimal digits/);
  assert.throws(() => tools.calculateSubnet('192.168.001.1', 24), /Octet 3 has a leading zero/);
});

test('mask options include full dotted decimal and CIDR notation', () => {
  assert.equal(tools.formatMask(0), '0.0.0.0/0');
  assert.equal(tools.formatMask(24), '255.255.255.0/24');
  assert.equal(tools.formatMask(32), '255.255.255.255/32');
});
