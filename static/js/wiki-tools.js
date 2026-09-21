(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.WikiTools = api;
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict';

  const MAX_UINT32 = 0xffffffff;

  function fail(message) {
    throw new Error(message);
  }

  function groupBits(value) {
    return String(value || '').replace(/(.{8})(?=.)/g, '$1.');
  }

  function bitWidth(value) {
    if (value <= 0xff) return 8;
    if (value <= 0xffff) return 16;
    return 32;
  }

  function calculateBinary(direction, rawInput) {
    const mode = direction === 'binary-to-decimal' ? direction : 'decimal-to-binary';
    const input = String(rawInput ?? '').trim();
    if (!input) fail(mode === 'decimal-to-binary' ? 'Enter a decimal whole number.' : 'Enter a binary number.');

    let decimal;
    let enteredBinary = '';
    if (mode === 'decimal-to-binary') {
      if (!/^\d+$/.test(input)) fail('Decimal input may contain only the digits 0 through 9.');
      decimal = Number(input);
      if (!Number.isSafeInteger(decimal)) fail('Enter a decimal whole number.');
      if (decimal > MAX_UINT32) fail('The largest supported 32-bit value is 4,294,967,295.');
    } else {
      enteredBinary = input.replace(/[\s._-]+/g, '');
      if (!/^[01]+$/.test(enteredBinary)) fail('Binary input may contain only 0s and 1s.');
      if (enteredBinary.length > 32) fail('Binary input cannot be longer than 32 bits.');
      decimal = parseInt(enteredBinary, 2);
    }

    const width = mode === 'binary-to-decimal'
      ? (enteredBinary.length <= 8 ? 8 : enteredBinary.length <= 16 ? 16 : 32)
      : bitWidth(decimal);
    const binary = decimal.toString(2).padStart(width, '0');
    const bits = [...binary].map((bit, index) => {
      const exponent = width - index - 1;
      const placeValue = 2 ** exponent;
      return { bit: Number(bit), exponent, placeValue, contribution: Number(bit) * placeValue };
    });
    const contributions = bits.filter(item => item.bit === 1);
    const sum = contributions.length
      ? contributions.map(item => item.placeValue.toLocaleString('en-US')).join(' + ')
      : '0';
    return {
      mode,
      decimal,
      binary,
      groupedBinary: groupBits(binary),
      width,
      bits,
      contributions,
      sum,
    };
  }

  function parseIPv4(rawInput) {
    const input = String(rawInput ?? '').trim();
    if (!input) fail('Enter an IPv4 address, such as 192.168.1.25.');
    if (/\s/.test(input)) fail('IPv4 addresses cannot contain spaces.');
    const parts = input.split('.');
    if (parts.length !== 4) fail(`An IPv4 address needs exactly four octets separated by dots; ${parts.length} ${parts.length === 1 ? 'was' : 'were'} provided.`);
    return parts.map((part, index) => {
      const position = index + 1;
      if (!part) fail(`Octet ${position} is missing.`);
      if (!/^\d+$/.test(part)) fail(`Octet ${position} (“${part}”) must contain only decimal digits.`);
      if (part.length > 1 && part.startsWith('0')) fail(`Octet ${position} has a leading zero; enter ${Number(part)} instead of ${part}.`);
      const value = Number(part);
      if (value > 255) fail(`Octet ${position} is ${value}; each octet must be between 0 and 255.`);
      return value;
    });
  }

  function octetsToNumber(octets) {
    return (octets[0] * 0x1000000) + (octets[1] * 0x10000) + (octets[2] * 0x100) + octets[3];
  }

  function numberToIPv4(value) {
    const unsigned = Number(value) >>> 0;
    return [
      Math.floor(unsigned / 0x1000000),
      Math.floor(unsigned / 0x10000) % 256,
      Math.floor(unsigned / 0x100) % 256,
      unsigned % 256,
    ].join('.');
  }

  function maskNumber(prefix) {
    if (prefix === 0) return 0;
    return (MAX_UINT32 << (32 - prefix)) >>> 0;
  }

  function formatMask(prefix) {
    const numericPrefix = Number(prefix);
    if (!Number.isInteger(numericPrefix) || numericPrefix < 0 || numericPrefix > 32) fail('Subnet prefix must be between /0 and /32.');
    return `${numberToIPv4(maskNumber(numericPrefix))}/${numericPrefix}`;
  }

  function classifyIPv4(octets) {
    const [a, b, c, d] = octets;
    if (a === 255 && b === 255 && c === 255 && d === 255) return 'Limited broadcast';
    if (a === 0) return 'Reserved (current network)';
    if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) return 'Private';
    if (a === 100 && b >= 64 && b <= 127) return 'Shared address space';
    if (a === 127) return 'Loopback';
    if (a === 169 && b === 254) return 'Link-local';
    if (a === 192 && b === 0 && c === 2) return 'Documentation';
    if (a === 198 && (b === 18 || b === 19)) return 'Benchmark testing';
    if (a === 198 && b === 51 && c === 100) return 'Documentation';
    if (a === 203 && b === 0 && c === 113) return 'Documentation';
    if (a >= 224 && a <= 239) return 'Multicast';
    if (a >= 240) return 'Reserved / experimental';
    return 'Public';
  }

  function ipClass(firstOctet) {
    if (firstOctet <= 127) return 'A';
    if (firstOctet <= 191) return 'B';
    if (firstOctet <= 223) return 'C';
    if (firstOctet <= 239) return 'D (multicast)';
    return 'E (experimental)';
  }

  function calculateSubnet(rawIp, rawPrefix) {
    const octets = parseIPv4(rawIp);
    const prefix = Number(rawPrefix);
    if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) fail('Select a subnet prefix between /0 and /32.');
    const ipNumber = octetsToNumber(octets);
    const mask = maskNumber(prefix);
    const wildcard = (MAX_UINT32 ^ mask) >>> 0;
    const network = (ipNumber & mask) >>> 0;
    const broadcast = (network | wildcard) >>> 0;
    const totalAddresses = 2 ** (32 - prefix);
    const usableHosts = prefix >= 31 ? totalAddresses : Math.max(0, totalAddresses - 2);
    const firstUsable = prefix === 32 ? network : prefix === 31 ? network : network + 1;
    const lastUsable = prefix === 32 ? network : prefix === 31 ? broadcast : broadcast - 1;
    const ipBinary = octets.map(value => value.toString(2).padStart(8, '0')).join('');
    const maskBinary = mask.toString(2).padStart(32, '0');
    const wildcardBinary = wildcard.toString(2).padStart(32, '0');
    const networkBinary = network.toString(2).padStart(32, '0');
    const broadcastBinary = broadcast.toString(2).padStart(32, '0');
    return {
      ip: octets.join('.'),
      prefix,
      network: numberToIPv4(network),
      broadcast: numberToIPv4(broadcast),
      usableRange: prefix === 32 ? numberToIPv4(network) : `${numberToIPv4(firstUsable)} – ${numberToIPv4(lastUsable)}`,
      totalAddresses,
      usableHosts,
      subnetMask: numberToIPv4(mask),
      wildcardMask: numberToIPv4(wildcard),
      binarySubnetMask: groupBits(maskBinary),
      ipClass: ipClass(octets[0]),
      ipType: classifyIPv4(octets),
      ipBinary,
      maskBinary,
      wildcardBinary,
      networkBinary,
      broadcastBinary,
    };
  }

  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function formatNumber(value) {
    return Number(value).toLocaleString('en-US');
  }

  function resultRow(label, value) {
    const row = element('div', 'wiki-tool-result-row');
    row.append(element('dt', '', label), element('dd', '', value));
    return row;
  }

  function renderPlaceValues(target, result) {
    const wrap = element('section', 'wiki-tool-work-panel');
    wrap.append(element('h3', '', `${result.width}-bit place-value table`));
    wrap.append(element('p', 'wiki-tool-help', 'Each 1 contributes its place value. Each 0 contributes nothing.'));
    for (let start = 0; start < result.bits.length; start += 8) {
      const group = result.bits.slice(start, start + 8);
      const tableWrap = element('div', 'wiki-tool-table-scroll');
      const table = element('table', 'wiki-bit-table');
      const body = document.createElement('tbody');
      const addRow = (label, values, className = '') => {
        const row = document.createElement('tr');
        const heading = element('th', '', label);
        heading.scope = 'row';
        row.appendChild(heading);
        values.forEach(value => row.appendChild(element('td', className, value)));
        body.appendChild(row);
      };
      addRow('Power', group.map(item => `2${item.exponent.toString().replace(/\d+/g, match => match)}`), 'wiki-power-cell');
      const powerCells = body.lastElementChild.querySelectorAll('td');
      group.forEach((item, index) => {
        powerCells[index].textContent = '';
        powerCells[index].append(document.createTextNode('2'), Object.assign(document.createElement('sup'), { textContent: String(item.exponent) }));
      });
      addRow('Value', group.map(item => formatNumber(item.placeValue)));
      addRow('Bit', group.map(item => String(item.bit)), 'wiki-bit-value');
      addRow('Adds', group.map(item => formatNumber(item.contribution)), 'wiki-bit-contribution');
      table.appendChild(body);
      tableWrap.appendChild(table);
      wrap.appendChild(tableWrap);
    }
    target.appendChild(wrap);
  }

  function renderBinaryResult(target, result) {
    target.replaceChildren();
    const summary = element('section', 'wiki-tool-result-card');
    summary.append(element('div', 'wiki-tool-result-kicker', 'Result'));
    const resultGrid = element('dl', 'wiki-tool-result-grid');
    resultGrid.append(
      resultRow('Decimal', formatNumber(result.decimal)),
      resultRow('Binary', result.groupedBinary),
      resultRow('Width shown', `${result.width} bits`),
    );
    summary.appendChild(resultGrid);
    target.appendChild(summary);
    renderPlaceValues(target, result);

    const steps = element('section', 'wiki-tool-work-panel');
    steps.append(element('h3', '', 'Worked steps'));
    const list = element('ol', 'wiki-tool-steps');
    if (result.mode === 'decimal-to-binary') {
      list.appendChild(element('li', '', `Use ${result.width} place values because ${formatNumber(result.decimal)} fits within ${result.width} bits.`));
      list.appendChild(element('li', '', 'Starting with the largest place value, write 1 when that value can be subtracted; otherwise write 0.'));
      list.appendChild(element('li', '', `The selected place values are ${result.sum}.`));
      list.appendChild(element('li', '', `${result.sum} = ${formatNumber(result.decimal)}, so the binary answer is ${result.groupedBinary}.`));
    } else {
      list.appendChild(element('li', '', `Read the ${result.width} displayed bits from right to left as powers of 2.`));
      list.appendChild(element('li', '', 'Multiply every place value by its bit (0 or 1).'));
      list.appendChild(element('li', '', `Add the non-zero contributions: ${result.sum}.`));
      list.appendChild(element('li', '', `${result.sum} = ${formatNumber(result.decimal)} in decimal.`));
    }
    steps.appendChild(list);
    target.appendChild(steps);
  }

  function mountBinary(host) {
    host.className = 'wiki-tool-app wiki-binary-tool';
    const intro = element('p', 'wiki-tool-intro', 'Convert unsigned values up to 32 bits and see exactly how every bit contributes to the answer.');
    const switcher = element('div', 'wiki-tool-switcher');
    switcher.setAttribute('role', 'group');
    switcher.setAttribute('aria-label', 'Conversion direction');
    const decimalButton = element('button', 'is-active', 'Decimal → Binary');
    const binaryButton = element('button', '', 'Binary → Decimal');
    decimalButton.type = binaryButton.type = 'button';
    const form = element('form', 'wiki-tool-form');
    const label = element('label', 'wiki-tool-field');
    const labelText = element('span', '', 'Decimal value');
    const input = document.createElement('input');
    input.type = 'text';
    input.inputMode = 'numeric';
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.placeholder = 'Example: 226';
    input.setAttribute('aria-describedby', 'wikiBinaryHint wikiBinaryError');
    const hint = element('small', '', 'Enter a whole number from 0 to 4,294,967,295.');
    hint.id = 'wikiBinaryHint';
    label.append(labelText, input, hint);
    const submit = element('button', 'btn run wiki-tool-submit', 'Convert');
    submit.type = 'submit';
    const error = element('div', 'wiki-tool-error');
    error.id = 'wikiBinaryError';
    error.setAttribute('role', 'alert');
    const output = element('div', 'wiki-tool-output');
    output.setAttribute('aria-live', 'polite');
    let mode = 'decimal-to-binary';

    const setMode = nextMode => {
      mode = nextMode;
      const decimalMode = mode === 'decimal-to-binary';
      decimalButton.classList.toggle('is-active', decimalMode);
      binaryButton.classList.toggle('is-active', !decimalMode);
      decimalButton.setAttribute('aria-pressed', String(decimalMode));
      binaryButton.setAttribute('aria-pressed', String(!decimalMode));
      labelText.textContent = decimalMode ? 'Decimal value' : 'Binary value';
      input.placeholder = decimalMode ? 'Example: 226' : 'Example: 11100010';
      hint.textContent = decimalMode
        ? 'Enter a whole number from 0 to 4,294,967,295.'
        : 'Enter up to 32 bits. Spaces, dots, underscores, and dashes are ignored.';
      input.value = '';
      error.textContent = '';
      output.replaceChildren();
      input.focus();
    };
    decimalButton.addEventListener('click', () => setMode('decimal-to-binary'));
    binaryButton.addEventListener('click', () => setMode('binary-to-decimal'));
    form.addEventListener('submit', event => {
      event.preventDefault();
      try {
        const result = calculateBinary(mode, input.value);
        error.textContent = '';
        input.removeAttribute('aria-invalid');
        renderBinaryResult(output, result);
      } catch (problem) {
        output.replaceChildren();
        error.textContent = problem.message;
        input.setAttribute('aria-invalid', 'true');
        input.focus();
      }
    });
    switcher.append(decimalButton, binaryButton);
    form.append(label, submit);
    host.append(intro, switcher, form, error, output);
  }

  function renderBitField(bits, prefix) {
    const field = element('div', 'wiki-subnet-bits');
    [...bits].forEach((bit, index) => {
      const cell = element('span', index < prefix ? 'is-network' : 'is-host', bit);
      cell.title = `Bit ${index + 1}: ${index < prefix ? 'network' : 'host'}`;
      if (index > 0 && index % 8 === 0) cell.classList.add('is-octet-start');
      field.appendChild(cell);
    });
    return field;
  }

  function bitwiseRow(label, bits, prefix, operator = '') {
    const row = element('div', 'wiki-subnet-work-row');
    row.append(element('strong', '', label), renderBitField(bits, prefix));
    if (operator) row.appendChild(element('span', 'wiki-subnet-operator', operator));
    return row;
  }

  function renderSubnetResult(target, result) {
    target.replaceChildren();
    const summary = element('section', 'wiki-tool-result-card');
    summary.append(element('div', 'wiki-tool-result-kicker', 'Network result'));
    const grid = element('dl', 'wiki-tool-result-grid wiki-subnet-results');
    [
      ['IP address', result.ip],
      ['Network address', result.network],
      ['Usable host range', result.usableRange],
      ['Broadcast address', result.broadcast],
      ['Total addresses', formatNumber(result.totalAddresses)],
      ['Usable hosts', formatNumber(result.usableHosts)],
      ['Subnet mask', result.subnetMask],
      ['Wildcard mask', result.wildcardMask],
      ['Binary subnet mask', result.binarySubnetMask],
      ['IP class', result.ipClass],
      ['CIDR notation', `/${result.prefix}`],
      ['IP type', result.ipType],
    ].forEach(([label, value]) => grid.appendChild(resultRow(label, value)));
    summary.appendChild(grid);
    target.appendChild(summary);

    const bitPanel = element('section', 'wiki-tool-work-panel');
    bitPanel.append(element('h3', '', '32-bit address field'));
    const legend = element('div', 'wiki-subnet-legend');
    legend.append(element('span', 'is-network', `Network bits (${result.prefix})`), element('span', 'is-host', `Host bits (${32 - result.prefix})`));
    const bitScroll = element('div', 'wiki-subnet-bit-scroll');
    bitScroll.appendChild(renderBitField(result.ipBinary, result.prefix));
    bitPanel.append(legend, bitScroll);
    target.appendChild(bitPanel);

    const work = element('section', 'wiki-tool-work-panel');
    work.append(element('h3', '', 'Bitwise work'));
    const networkWork = element('div', 'wiki-subnet-work');
    networkWork.append(
      bitwiseRow('IP address', result.ipBinary, result.prefix),
      bitwiseRow('AND mask', result.maskBinary, result.prefix, 'AND'),
      bitwiseRow('Network', result.networkBinary, result.prefix, '='),
    );
    const broadcastWork = element('div', 'wiki-subnet-work');
    broadcastWork.append(
      bitwiseRow('Network', result.networkBinary, result.prefix),
      bitwiseRow('OR wildcard', result.wildcardBinary, result.prefix, 'OR'),
      bitwiseRow('Broadcast', result.broadcastBinary, result.prefix, '='),
    );
    const explanation = element('ol', 'wiki-tool-steps');
    explanation.append(
      element('li', '', `The first ${result.prefix} bits are the network portion; the remaining ${32 - result.prefix} bits identify hosts.`),
      element('li', '', `IP AND subnet mask keeps the network bits and clears host bits, producing ${result.network}.`),
      element('li', '', `Network OR wildcard sets every host bit to 1, producing ${result.broadcast}.`),
      element('li', '', result.prefix >= 31
        ? `A /${result.prefix} has ${formatNumber(result.usableHosts)} usable ${result.usableHosts === 1 ? 'address' : 'addresses'} under point-to-point/single-host rules.`
        : `Exclude the network and broadcast addresses to leave ${formatNumber(result.usableHosts)} usable hosts.`),
    );
    work.append(networkWork, broadcastWork, explanation);
    target.appendChild(work);
  }

  function mountSubnet(host) {
    host.className = 'wiki-tool-app wiki-subnet-tool';
    const intro = element('p', 'wiki-tool-intro', 'Enter an IPv4 address and choose a subnet mask to calculate the network, broadcast, and usable host range—with the binary work shown below.');
    const form = element('form', 'wiki-tool-form wiki-subnet-form');
    const ipLabel = element('label', 'wiki-tool-field');
    ipLabel.appendChild(element('span', '', 'IPv4 address'));
    const input = document.createElement('input');
    input.type = 'text';
    input.inputMode = 'decimal';
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.placeholder = '193.186.4.226';
    input.setAttribute('aria-describedby', 'wikiSubnetHint wikiSubnetError');
    const hint = element('small', '', 'Use four decimal octets, each from 0 to 255.');
    hint.id = 'wikiSubnetHint';
    ipLabel.append(input, hint);
    const maskLabel = element('label', 'wiki-tool-field');
    maskLabel.appendChild(element('span', '', 'Subnet mask'));
    const select = document.createElement('select');
    select.setAttribute('aria-label', 'Subnet mask');
    for (let prefix = 0; prefix <= 32; prefix += 1) {
      const option = document.createElement('option');
      option.value = String(prefix);
      option.textContent = formatMask(prefix);
      option.selected = prefix === 24;
      select.appendChild(option);
    }
    maskLabel.appendChild(select);
    const submit = element('button', 'btn run wiki-tool-submit', 'Calculate subnet');
    submit.type = 'submit';
    const error = element('div', 'wiki-tool-error');
    error.id = 'wikiSubnetError';
    error.setAttribute('role', 'alert');
    const output = element('div', 'wiki-tool-output');
    output.setAttribute('aria-live', 'polite');
    form.addEventListener('submit', event => {
      event.preventDefault();
      try {
        const result = calculateSubnet(input.value, select.value);
        error.textContent = '';
        input.removeAttribute('aria-invalid');
        renderSubnetResult(output, result);
      } catch (problem) {
        output.replaceChildren();
        error.textContent = problem.message;
        input.setAttribute('aria-invalid', 'true');
        input.focus();
      }
    });
    form.append(ipLabel, maskLabel, submit);
    host.append(intro, form, error, output);
  }

  function mount(host, node) {
    if (!host) return;
    host.replaceChildren();
    if (node?.tool_type === 'binary-converter') mountBinary(host);
    else if (node?.tool_type === 'ipv4-subnet') mountSubnet(host);
    else host.appendChild(element('p', 'wiki-tool-error', 'This wiki tool type is not available.'));
  }

  function unmount(host) {
    if (host) host.replaceChildren();
  }

  return Object.freeze({
    calculateBinary,
    calculateSubnet,
    formatMask,
    parseIPv4,
    mount,
    unmount,
  });
});
