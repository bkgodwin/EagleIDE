/* EagleIDE autocomplete analysis and popup controller. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.EagleAutocomplete = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  const MAX_ANALYSIS_LENGTH = 100000;
  const MAX_SUGGESTIONS = 200;
  const PYTHON_KEYWORDS = [
    'and', 'as', 'assert', 'async', 'await', 'break', 'case', 'class', 'continue',
    'def', 'del', 'elif', 'else', 'except', 'False', 'finally', 'for', 'from',
    'global', 'if', 'import', 'in', 'is', 'lambda', 'match', 'None', 'nonlocal',
    'not', 'or', 'pass', 'raise', 'return', 'True', 'try', 'while', 'with', 'yield'
  ];
  const PYTHON_BUILTINS = [
    'abs', 'aiter', 'all', 'anext', 'any', 'ascii', 'bin', 'bool', 'breakpoint',
    'bytearray', 'bytes', 'callable', 'chr', 'classmethod', 'compile', 'complex',
    'delattr', 'dict', 'dir', 'divmod', 'enumerate', 'eval', 'exec', 'filter',
    'float', 'format', 'frozenset', 'getattr', 'globals', 'hasattr', 'hash',
    'help', 'hex', 'id', 'input', 'int', 'isinstance', 'issubclass', 'iter',
    'len', 'list', 'locals', 'map', 'max', 'memoryview', 'min', 'next', 'object',
    'oct', 'open', 'ord', 'pow', 'print', 'property', 'range', 'repr', 'reversed',
    'round', 'set', 'setattr', 'slice', 'sorted', 'staticmethod', 'str', 'sum',
    'super', 'tuple', 'type', 'vars', 'zip'
  ];
  const JAVASCRIPT_KEYWORDS = [
    'async', 'await', 'break', 'case', 'catch', 'class', 'const', 'continue',
    'debugger', 'default', 'delete', 'do', 'else', 'export', 'extends', 'false',
    'finally', 'for', 'from', 'function', 'if', 'import', 'in', 'instanceof',
    'let', 'new', 'null', 'of', 'return', 'static', 'super', 'switch', 'this',
    'throw', 'true', 'try', 'typeof', 'undefined', 'var', 'void', 'while', 'yield'
  ];
  const JAVASCRIPT_BUILTINS = [
    'Array', 'Boolean', 'console', 'Date', 'document', 'fetch', 'JSON', 'Map',
    'Math', 'Number', 'Object', 'parseFloat', 'parseInt', 'Promise', 'RegExp',
    'Set', 'String', 'window'
  ];
  const JS_MEMBERS = {
    string: ['charAt', 'endsWith', 'includes', 'indexOf', 'match', 'repeat', 'replace', 'slice', 'split', 'startsWith', 'substring', 'toLowerCase', 'toUpperCase', 'trim'],
    array: ['filter', 'find', 'findIndex', 'flat', 'forEach', 'includes', 'join', 'map', 'pop', 'push', 'reduce', 'reverse', 'shift', 'slice', 'sort', 'splice', 'unshift'],
    object: ['assign', 'entries', 'hasOwnProperty', 'keys', 'toString', 'values'],
    console: ['clear', 'dir', 'error', 'info', 'log', 'table', 'warn'],
    math: ['abs', 'ceil', 'floor', 'max', 'min', 'pow', 'random', 'round', 'sqrt', 'trunc'],
    promise: ['catch', 'finally', 'then'],
    document: ['addEventListener', 'createElement', 'getElementById', 'querySelector', 'querySelectorAll'],
    window: ['addEventListener', 'removeEventListener', 'requestAnimationFrame', 'setInterval', 'setTimeout'],
    json: ['parse', 'stringify'],
    set: ['add', 'clear', 'delete', 'forEach', 'has'],
    map: ['clear', 'delete', 'forEach', 'get', 'has', 'set'],
    number: ['toFixed', 'toPrecision', 'toString'],
    boolean: ['toString', 'valueOf']
  };

  function leadingIndent(line) {
    const match = String(line || '').match(/^\s*/);
    return (match ? match[0] : '').replace(/\t/g, '    ').length;
  }

  function normalizeDocstring(text) {
    const lines = String(text || '').replace(/\r/g, '').split('\n');
    while (lines.length && !lines[0].trim()) lines.shift();
    while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
    const indents = lines.filter(line => line.trim()).map(leadingIndent);
    const trimBy = indents.length ? Math.min(...indents) : 0;
    return lines.map(line => line.slice(trimBy).trimEnd()).join('\n').trim();
  }

  function readPythonDocstring(lines, startIndex, parentIndent) {
    let index = startIndex;
    while (index < lines.length && !lines[index].trim()) index += 1;
    if (index >= lines.length || leadingIndent(lines[index]) <= parentIndent) return { text: '', end: startIndex - 1 };
    const first = lines[index].trim();
    const match = first.match(/^(?:[rRuUbBfF]{0,2})?(\"\"\"|''')(.*)$/);
    if (!match) return { text: '', end: startIndex - 1 };
    const quote = match[1];
    const rest = match[2];
    const sameLineEnd = rest.indexOf(quote);
    if (sameLineEnd >= 0) return { text: normalizeDocstring(rest.slice(0, sameLineEnd)), end: index };
    const collected = [rest];
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      const endAt = lines[cursor].indexOf(quote);
      if (endAt >= 0) {
        collected.push(lines[cursor].slice(0, endAt));
        return { text: normalizeDocstring(collected.join('\n')), end: cursor };
      }
      collected.push(lines[cursor]);
    }
    return { text: normalizeDocstring(collected.join('\n')), end: lines.length - 1 };
  }

  function splitPythonParams(raw) {
    const params = [];
    let current = '';
    let depth = 0;
    let quote = '';
    for (const char of String(raw || '')) {
      if (quote) {
        current += char;
        if (char === quote) quote = '';
      } else if (char === '"' || char === "'") {
        quote = char;
        current += char;
      } else if ('([{'.includes(char)) {
        depth += 1;
        current += char;
      } else if (')]}'.includes(char)) {
        depth = Math.max(0, depth - 1);
        current += char;
      } else if (char === ',' && depth === 0) {
        if (current.trim()) params.push(current.trim());
        current = '';
      } else {
        current += char;
      }
    }
    if (current.trim()) params.push(current.trim());
    return params;
  }

  function inferPythonType(value, annotation, classNames) {
    const hinted = String(annotation || '').trim().replace(/^['\"]|['\"]$/g, '');
    const simpleHint = hinted.replace(/typing\./g, '').split(/[\[|]/)[0].trim();
    if (/^(str|String)$/i.test(simpleHint)) return 'str';
    if (/^(list|List|Sequence|MutableSequence)$/i.test(simpleHint)) return 'list';
    if (/^(TextIO|TextIOWrapper|IO)$/i.test(simpleHint)) return 'file';
    if (classNames.has(simpleHint)) return simpleHint;
    const expression = String(value || '').trim();
    if (/^(?:[rubf]{0,2})?["']/i.test(expression) || /^str\s*\(/.test(expression)) return 'str';
    if (/^\[/.test(expression) || /^list\s*\(/.test(expression) || /\.split\s*\(/.test(expression)) return 'list';
    if (/^(?:open|io\.open)\s*\(/.test(expression)) return 'file';
    const constructor = expression.match(/^([A-Za-z_]\w*)\s*\(/);
    if (constructor && classNames.has(constructor[1])) return constructor[1];
    return simpleHint || '';
  }

  function createSymbol(name, kind, extra) {
    return Object.assign({ name, kind, signature: '', returns: '', description: '', owner: '' }, extra || {});
  }

  function analyzePython(source) {
    const text = String(source || '');
    const result = {
      functions: [], classes: [], variables: [], methods: new Map(),
      attributes: new Map(), objectAttributes: new Map(), varTypes: new Map(),
      classAtLine: [], tooLarge: text.length > MAX_ANALYSIS_LENGTH
    };
    if (result.tooLarge) return result;
    const lines = text.replace(/\r/g, '').split('\n');
    const classNames = new Set();
    for (const line of lines) {
      const match = line.match(/^\s*class\s+([A-Za-z_]\w*)/);
      if (match) classNames.add(match[1]);
    }
    const stack = [];
    const variableNames = new Set();
    const functionNames = new Set();
    const classSymbols = new Map();

    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      const trimmed = line.trim();
      const indent = leadingIndent(line);
      if (trimmed && !trimmed.startsWith('#')) {
        while (stack.length && indent <= stack[stack.length - 1].indent) stack.pop();
      }
      const activeClass = [...stack].reverse().find(scope => scope.type === 'class');
      result.classAtLine[index] = activeClass ? activeClass.name : '';

      const classMatch = line.match(/^\s*class\s+([A-Za-z_]\w*)\s*(?:\(([^)]*)\))?\s*:/);
      if (classMatch) {
        const doc = readPythonDocstring(lines, index + 1, indent);
        const symbol = createSymbol(classMatch[1], 'class', {
          signature: classMatch[2] ? `(${classMatch[2].trim()})` : '()',
          returns: classMatch[1], description: doc.text || `User-defined ${classMatch[1]} class.`
        });
        result.classes.push(symbol);
        classSymbols.set(symbol.name, symbol);
        if (!result.methods.has(symbol.name)) result.methods.set(symbol.name, []);
        if (!result.attributes.has(symbol.name)) result.attributes.set(symbol.name, []);
        stack.push({ type: 'class', name: symbol.name, indent });
        result.classAtLine[index] = symbol.name;
        continue;
      }

      const defMatch = line.match(/^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\((.*)\)\s*(?:->\s*([^:]+))?\s*:/);
      if (defMatch) {
        const ownerScope = [...stack].reverse().find(scope => scope.type === 'class');
        const params = splitPythonParams(defMatch[2]);
        const publicParams = ownerScope && params.length && /^(?:self|cls)(?:\s*:.*)?$/.test(params[0]) ? params.slice(1) : params;
        const doc = readPythonDocstring(lines, index + 1, indent);
        const symbol = createSymbol(defMatch[1], ownerScope ? 'method' : 'function', {
          signature: `(${publicParams.join(', ')})`,
          returns: (defMatch[3] || '').trim() || 'Any',
          description: doc.text || `User-defined ${ownerScope ? 'method' : 'function'}.`,
          owner: ownerScope ? ownerScope.name : ''
        });
        if (ownerScope) result.methods.get(ownerScope.name).push(symbol);
        else if (!functionNames.has(symbol.name)) {
          functionNames.add(symbol.name);
          result.functions.push(symbol);
        }
        if (ownerScope && symbol.name === '__init__' && classSymbols.has(ownerScope.name)) {
          classSymbols.get(ownerScope.name).signature = `(${publicParams.join(', ')})`;
        }
        publicParams.forEach(rawParam => {
          const withoutDefault = rawParam.split('=')[0].trim();
          const parts = withoutDefault.replace(/^\*{1,2}/, '').split(':');
          const paramName = (parts.shift() || '').trim();
          const annotation = parts.join(':').trim();
          if (!/^[A-Za-z_]\w*$/.test(paramName)) return;
          const typeName = inferPythonType('', annotation, classNames);
          if (typeName) result.varTypes.set(paramName, typeName);
          if (!variableNames.has(paramName)) {
            variableNames.add(paramName);
            result.variables.push(createSymbol(paramName, 'variable', {
              returns: typeName || 'Any', description: `Parameter of ${symbol.name}.`
            }));
          }
        });
        stack.push({ type: 'function', name: symbol.name, indent, owner: symbol.owner });
        continue;
      }

      const currentClass = [...stack].reverse().find(scope => scope.type === 'class');
      const selfAttr = line.match(/\b(?:self|cls)\.([A-Za-z_]\w*)\s*(?::\s*([^=]+?))?\s*=\s*(.+)$/);
      if (selfAttr && currentClass) {
        let typeName = inferPythonType(selfAttr[3], selfAttr[2], classNames);
        if (!typeName && result.varTypes.has(selfAttr[3].trim())) typeName = result.varTypes.get(selfAttr[3].trim());
        const list = result.attributes.get(currentClass.name);
        if (!list.some(item => item.name === selfAttr[1])) {
          list.push(createSymbol(selfAttr[1], 'attribute', {
            returns: typeName || 'Any', owner: currentClass.name,
            description: `Instance attribute defined on ${currentClass.name}.`
          }));
        }
      }

      const objectAttr = line.match(/\b([A-Za-z_]\w*)\.([A-Za-z_]\w*)\s*(?::\s*([^=]+?))?\s*=\s*(.+)$/);
      if (objectAttr && !/^(?:self|cls)$/.test(objectAttr[1])) {
        if (!result.objectAttributes.has(objectAttr[1])) result.objectAttributes.set(objectAttr[1], []);
        const list = result.objectAttributes.get(objectAttr[1]);
        if (!list.some(item => item.name === objectAttr[2])) {
          let attributeType = inferPythonType(objectAttr[4], objectAttr[3], classNames);
          if (!attributeType && result.varTypes.has(objectAttr[4].trim())) attributeType = result.varTypes.get(objectAttr[4].trim());
          list.push(createSymbol(objectAttr[2], 'attribute', {
            returns: attributeType || 'Any',
            owner: objectAttr[1], description: `Attribute assigned on ${objectAttr[1]}.`
          }));
        }
      }

      const assignment = line.match(/^\s*([A-Za-z_]\w*)\s*(?::\s*([^=]+?))?\s*=\s*(?!=)(.+)$/);
      if (assignment && !PYTHON_KEYWORDS.includes(assignment[1])) {
        const name = assignment[1];
        let typeName = inferPythonType(assignment[3], assignment[2], classNames);
        if (!typeName && result.varTypes.has(assignment[3].trim())) typeName = result.varTypes.get(assignment[3].trim());
        if (!typeName) {
          const calledName = assignment[3].trim().match(/^([A-Za-z_]\w*)\s*\(/)?.[1];
          typeName = result.functions.find(item => item.name === calledName)?.returns || '';
          if (typeName === 'Any') typeName = '';
        }
        if (typeName) result.varTypes.set(name, typeName);
        const currentFunction = [...stack].reverse().find(scope => scope.type === 'function');
        if (currentClass && !currentFunction) {
          const classAttrs = result.attributes.get(currentClass.name);
          if (!classAttrs.some(item => item.name === name)) {
            classAttrs.push(createSymbol(name, 'attribute', {
              returns: typeName || 'Any', owner: currentClass.name,
              description: `Class attribute defined on ${currentClass.name}.`
            }));
          }
        }
        if (!variableNames.has(name)) {
          variableNames.add(name);
          result.variables.push(createSymbol(name, 'variable', {
            returns: typeName || 'Any',
            description: typeName ? `User variable inferred as ${typeName}.` : 'User-defined variable.'
          }));
        }
      }

      const withFile = line.match(/^\s*(?:async\s+)?with\s+(?:open|io\.open)\s*\([^)]*\)\s+as\s+([A-Za-z_]\w*)/);
      if (withFile) {
        result.varTypes.set(withFile[1], 'file');
        if (!variableNames.has(withFile[1])) {
          variableNames.add(withFile[1]);
          result.variables.push(createSymbol(withFile[1], 'variable', {
            returns: 'file', description: 'File variable opened by a context manager.'
          }));
        }
      }

      const forMatch = line.match(/^\s*for\s+([A-Za-z_]\w*)\s+in\b/);
      if (forMatch && !variableNames.has(forMatch[1])) {
        variableNames.add(forMatch[1]);
        result.variables.push(createSymbol(forMatch[1], 'variable', { returns: 'Any', description: 'Loop variable.' }));
      }
      const importMatch = line.match(/^\s*(?:import\s+([A-Za-z_]\w*)|from\s+\S+\s+import\s+([A-Za-z_]\w*))/);
      const imported = importMatch && (importMatch[1] || importMatch[2]);
      if (imported && !variableNames.has(imported)) {
        variableNames.add(imported);
        result.variables.push(createSymbol(imported, 'module', { returns: 'module', description: 'Imported module or symbol.' }));
      }
    }
    return result;
  }

  function inferJavascriptType(value) {
    const expression = String(value || '').trim();
    if (/^["'`]/.test(expression) || /^String\s*\(/.test(expression)) return 'string';
    if (/^\[/.test(expression) || /^(?:new\s+)?Array\s*\(/.test(expression)) return 'array';
    if (/^\{/.test(expression) || /^(?:new\s+)?Object\s*\(/.test(expression)) return 'object';
    if (/^(?:true|false)\b/.test(expression)) return 'boolean';
    if (/^-?\d/.test(expression) || /^Number\s*\(/.test(expression)) return 'number';
    if (/^(?:new\s+)?Promise\b/.test(expression)) return 'promise';
    if (/^new\s+Set\b/.test(expression)) return 'set';
    if (/^new\s+Map\b/.test(expression)) return 'map';
    return '';
  }

  function analyzeJavascript(source) {
    const result = { functions: [], classes: [], variables: [], varTypes: new Map(), tooLarge: String(source || '').length > MAX_ANALYSIS_LENGTH };
    if (result.tooLarge) return result;
    const names = new Set();
    String(source || '').split(/\r?\n/).forEach(line => {
      const func = line.match(/^\s*(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*(\([^)]*\))/);
      if (func) result.functions.push(createSymbol(func[1], 'function', { signature: func[2], returns: 'Any', description: 'User-defined JavaScript function.' }));
      const cls = line.match(/^\s*class\s+([A-Za-z_$][\w$]*)/);
      if (cls) result.classes.push(createSymbol(cls[1], 'class', { signature: '()', returns: cls[1], description: 'User-defined JavaScript class.' }));
      const variable = line.match(/^\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?:=\s*(.+?);?\s*)?$/);
      if (variable) {
        const typeName = inferJavascriptType(variable[2]);
        if (typeName) result.varTypes.set(variable[1], typeName);
        if (!names.has(variable[1])) {
          names.add(variable[1]);
          result.variables.push(createSymbol(variable[1], 'variable', { returns: typeName || 'Any', description: 'User-defined JavaScript variable.' }));
        }
        if (variable[2] && /(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/.test(variable[2])) {
          result.functions.push(createSymbol(variable[1], 'function', { signature: '(…)', returns: 'Any', description: 'User-defined arrow function.' }));
        }
      }
    });
    return result;
  }

  function isInsideCommentOrString(line, cursorCh) {
    let quote = '';
    let escaped = false;
    for (let index = 0; index < cursorCh; index += 1) {
      const char = line[index];
      if (escaped) { escaped = false; continue; }
      if (char === '\\' && quote) { escaped = true; continue; }
      if (quote) {
        if (char === quote) quote = '';
      } else if (char === '"' || char === "'" || char === '`') {
        quote = char;
      } else if (char === '#') {
        return true;
      } else if (char === '/' && line[index + 1] === '/') {
        return true;
      }
    }
    return !!quote;
  }

  function contextAt(line, cursorCh) {
    const before = String(line || '').slice(0, cursorCh);
    if (isInsideCommentOrString(String(line || ''), cursorCh)) return null;
    const attr = before.match(/((?:[A-Za-z_$][\w$]*|(?:[rubf]{0,2})?["'][^"']*["']|\[[^\]]*\]))\.((?:[A-Za-z_$][\w$]*)?)$/i);
    if (attr) {
      return { mode: 'member', object: attr[1], partial: attr[2], fromCh: cursorCh - attr[2].length };
    }
    const token = before.match(/([A-Za-z_$][\w$]*)$/);
    if (!token) return null;
    return { mode: 'global', object: '', partial: token[1], fromCh: cursorCh - token[1].length };
  }

  function catalogIndex(entries) {
    const index = new Map();
    for (const raw of Array.isArray(entries) ? entries : []) {
      const item = createSymbol(String(raw.name || ''), String(raw.kind || 'method'), raw);
      if (!item.name) continue;
      const key = `${String(item.language || 'python').toLowerCase()}|${String(item.owner || '').toLowerCase()}|${item.name}`;
      index.set(key, item);
    }
    return index;
  }

  function detailFor(index, language, owner, name, fallback) {
    const found = index.get(`${language}|${String(owner || '').toLowerCase()}|${name}`);
    return found ? Object.assign({}, found) : Object.assign(createSymbol(name, fallback.kind, fallback), fallback);
  }

  function buildSuggestionSet(options) {
    const language = options.language === 'javascript' ? 'javascript' : 'python';
    const context = options.context;
    if (!context) return [];
    const analysis = options.analysis || (language === 'python' ? analyzePython('') : analyzeJavascript(''));
    const index = options.catalog instanceof Map ? options.catalog : catalogIndex(options.catalog);
    const partial = String(context.partial || '').toLowerCase();
    const results = [];
    const seen = new Set();
    const add = item => {
      if (!item || !item.name || seen.has(item.name) || !item.name.toLowerCase().startsWith(partial)) return;
      seen.add(item.name);
      results.push(item);
    };

    if (context.mode === 'member') {
      if (language === 'python') {
        let owner = '';
        const objectName = context.object;
        if (/^(?:[rubf]{0,2})?["']/i.test(objectName)) owner = 'str';
        else if (/^\[/.test(objectName)) owner = 'list';
        else if (objectName === 'self' || objectName === 'cls') owner = options.currentClass || '';
        else owner = analysis.varTypes.get(objectName) || (analysis.methods.has(objectName) ? objectName : '');
        for (const entry of index.values()) {
          if (entry.language === 'python' && String(entry.owner).toLowerCase() === String(owner).toLowerCase()) add(Object.assign({}, entry));
        }
        (analysis.methods.get(owner) || []).forEach(add);
        (analysis.attributes.get(owner) || []).forEach(add);
        (analysis.objectAttributes.get(objectName) || []).forEach(add);
      } else {
        const aliases = { console: 'console', Math: 'math', document: 'document', window: 'window', JSON: 'json' };
        const owner = analysis.varTypes.get(context.object) || aliases[context.object] || '';
        (JS_MEMBERS[owner] || []).forEach(name => add(createSymbol(name, 'method', {
          signature: '(…)', returns: 'Any', owner,
          description: `JavaScript ${owner || 'object'} member.`
        })));
      }
    } else {
      analysis.functions.forEach(add);
      analysis.classes.forEach(add);
      analysis.variables.forEach(add);
      const keywords = language === 'python' ? PYTHON_KEYWORDS : JAVASCRIPT_KEYWORDS;
      const builtins = language === 'python' ? PYTHON_BUILTINS : JAVASCRIPT_BUILTINS;
      keywords.forEach(name => add(detailFor(index, language, 'keyword', name, {
        name, kind: 'keyword', returns: '—', description: `${language === 'python' ? 'Python' : 'JavaScript'} language keyword.`
      })));
      builtins.forEach(name => add(detailFor(index, language, 'builtin', name, {
        name, kind: 'function', signature: '(…)', returns: 'Any', description: `${language === 'python' ? 'Python' : 'JavaScript'} built-in.`
      })));
    }

    return results.sort((left, right) => {
      const rank = { function: 0, method: 0, class: 1, variable: 2, attribute: 2, module: 3, keyword: 4 };
      const leftExact = left.name.toLowerCase() === partial ? 0 : 1;
      const rightExact = right.name.toLowerCase() === partial ? 0 : 1;
      if (leftExact !== rightExact) return leftExact - rightExact;
      const kindDiff = (rank[left.kind] ?? 5) - (rank[right.kind] ?? 5);
      return kindDiff || left.name.localeCompare(right.name);
    }).slice(0, MAX_SUGGESTIONS);
  }

  function iconFor(kind) {
    return ({ function: 'ƒ', method: 'M', class: 'C', variable: 'V', attribute: 'A', module: 'M', keyword: 'K' })[kind] || '•';
  }

  function createEngine(cm, options) {
    const settings = options || {};
    const doc = settings.document || (typeof document !== 'undefined' ? document : null);
    const win = settings.window || (typeof window !== 'undefined' ? window : null);
    const request = settings.fetch || (win && win.fetch ? win.fetch.bind(win) : null);
    const debounceMs = Number.isFinite(settings.debounceMs) ? settings.debounceMs : 90;
    let active = settings.enabled !== false;
    let timer = null;
    let popup = null;
    let listNode = null;
    let detailsNode = null;
    let suggestions = [];
    let selectedIndex = 0;
    let visibleContext = null;
    let analysisCache = null;
    let analysisSource = null;
    let analysisLanguage = null;
    let metadata = new Map();
    let catalogPromise = null;
    let catalogAbort = null;

    function language() {
      return String(cm.getOption('mode') || '').toLowerCase().includes('javascript') ? 'javascript' : 'python';
    }

    function loadCatalog() {
      if (!active || metadata.size || catalogPromise || !request) return catalogPromise;
      catalogAbort = typeof AbortController !== 'undefined' ? new AbortController() : null;
      const fetchOptions = catalogAbort ? { signal: catalogAbort.signal, cache: 'force-cache' } : { cache: 'force-cache' };
      catalogPromise = request('/api/autocomplete/catalog', fetchOptions)
        .then(response => response.ok ? response.json() : Promise.reject(new Error('catalog unavailable')))
        .then(payload => { if (active) metadata = catalogIndex(payload.entries); })
        .catch(() => {})
        .finally(() => { catalogPromise = null; catalogAbort = null; });
      return catalogPromise;
    }

    function ensurePopup() {
      if (popup || !doc) return;
      popup = doc.createElement('div');
      popup.className = 'eagle-completion-popup hidden';
      popup.setAttribute('role', 'presentation');
      listNode = doc.createElement('div');
      listNode.className = 'eagle-completions';
      listNode.setAttribute('role', 'listbox');
      detailsNode = doc.createElement('aside');
      detailsNode.className = 'completion-details';
      detailsNode.setAttribute('aria-live', 'polite');
      popup.appendChild(listNode);
      popup.appendChild(detailsNode);
      doc.body.appendChild(popup);
    }

    function hide() {
      if (popup) popup.classList.add('hidden');
      suggestions = [];
      selectedIndex = 0;
      visibleContext = null;
    }

    function updateDetails() {
      const item = suggestions[selectedIndex];
      if (!item || !detailsNode) return;
      detailsNode.textContent = '';
      const heading = doc.createElement('div');
      heading.className = 'completion-detail-heading';
      heading.textContent = item.owner ? `${item.owner}.${item.name}` : item.name;
      const kind = doc.createElement('div');
      kind.className = 'completion-detail-kind';
      kind.textContent = item.kind || 'completion';
      const signature = doc.createElement('code');
      signature.className = 'completion-detail-signature';
      signature.textContent = `${item.name}${item.signature || ''}`;
      const returns = doc.createElement('div');
      returns.className = 'completion-detail-returns';
      returns.textContent = `Returns: ${item.returns || 'Any'}`;
      const description = doc.createElement('div');
      description.className = 'completion-detail-description';
      description.textContent = item.description || 'No description available.';
      detailsNode.append(heading, kind, signature, returns, description);
    }

    function select(index) {
      if (!suggestions.length) return;
      selectedIndex = (index + suggestions.length) % suggestions.length;
      listNode.querySelectorAll('.completion-item').forEach((node, itemIndex) => {
        node.classList.toggle('selected', itemIndex === selectedIndex);
        node.setAttribute('aria-selected', itemIndex === selectedIndex ? 'true' : 'false');
      });
      listNode.querySelectorAll('.completion-item')[selectedIndex]?.scrollIntoView({ block: 'nearest' });
      updateDetails();
    }

    function position(coords) {
      if (!popup || !win) return;
      popup.classList.remove('details-left');
      popup.style.left = `${Math.max(8, coords.left)}px`;
      popup.style.top = `${coords.bottom + 3}px`;
      const rect = popup.getBoundingClientRect();
      if (rect.right > win.innerWidth - 8) {
        if (coords.left > rect.width + 8) popup.classList.add('details-left');
        popup.style.left = `${Math.max(8, Math.min(coords.left, win.innerWidth - rect.width - 8))}px`;
      }
      const nextRect = popup.getBoundingClientRect();
      if (nextRect.bottom > win.innerHeight - 8) {
        popup.style.top = `${Math.max(8, coords.top - nextRect.height - 3)}px`;
      }
    }

    function show(items, context, cursor) {
      ensurePopup();
      if (!popup || !items.length) { hide(); return; }
      suggestions = items;
      selectedIndex = 0;
      visibleContext = { line: cursor.line, cursorCh: cursor.ch, fromCh: context.fromCh, mode: context.mode, object: context.object };
      listNode.textContent = '';
      items.forEach((item, index) => {
        const row = doc.createElement('div');
        row.className = `completion-item${index === 0 ? ' selected' : ''}`;
        row.setAttribute('role', 'option');
        row.setAttribute('aria-selected', index === 0 ? 'true' : 'false');
        const icon = doc.createElement('span');
        icon.className = `completion-icon icon-${item.kind}`;
        icon.textContent = iconFor(item.kind);
        const label = doc.createElement('span');
        label.className = 'completion-label';
        label.textContent = item.name;
        const type = doc.createElement('span');
        type.className = 'completion-type';
        type.textContent = item.owner || item.returns || '';
        row.append(icon, label, type);
        row.addEventListener('mouseenter', () => select(index));
        row.addEventListener('mousedown', event => {
          event.preventDefault();
          apply(item);
        });
        listNode.appendChild(row);
      });
      updateDetails();
      popup.classList.remove('hidden');
      position(cm.cursorCoords(cursor, 'page'));
    }

    function currentAnalysis(source, currentLanguage) {
      if (analysisSource === source && analysisLanguage === currentLanguage && analysisCache) return analysisCache;
      analysisSource = source;
      analysisLanguage = currentLanguage;
      analysisCache = currentLanguage === 'javascript' ? analyzeJavascript(source) : analyzePython(source);
      return analysisCache;
    }

    function check() {
      if (!active) return;
      const cursor = cm.getCursor();
      if (cm.somethingSelected && cm.somethingSelected()) { hide(); return; }
      const context = contextAt(cm.getLine(cursor.line), cursor.ch);
      if (!context) { hide(); return; }
      const currentLanguage = language();
      const source = cm.getValue();
      const analysis = currentAnalysis(source, currentLanguage);
      const items = buildSuggestionSet({
        language: currentLanguage, context, analysis, catalog: metadata,
        currentClass: currentLanguage === 'python' ? (analysis.classAtLine[cursor.line] || '') : ''
      });
      show(items, context, cursor);
    }

    function schedule() {
      if (!active) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => { timer = null; check(); }, debounceMs);
    }

    function apply(item) {
      if (!item || !visibleContext) return;
      const cursor = cm.getCursor();
      const context = contextAt(cm.getLine(cursor.line), cursor.ch);
      if (!context || cursor.line !== visibleContext.line || context.fromCh !== visibleContext.fromCh || context.mode !== visibleContext.mode || context.object !== visibleContext.object) {
        hide();
        return;
      }
      cm.replaceRange(item.name, { line: cursor.line, ch: context.fromCh }, cursor, '+autocomplete');
      hide();
      cm.focus();
    }

    function setEnabled(enabled) {
      active = !!enabled;
      if (!active) {
        if (timer) clearTimeout(timer);
        timer = null;
        if (catalogAbort) catalogAbort.abort();
        catalogAbort = null;
        catalogPromise = null;
        analysisCache = null;
        analysisSource = null;
        hide();
      } else {
        loadCatalog();
      }
    }

    cm.on('inputRead', () => {
      if (!active) return;
      hide();
      schedule();
    });
    cm.on('change', (_instance, change) => {
      if (!active || change?.origin === '+autocomplete') return;
      analysisCache = null;
      analysisSource = null;
      hide();
    });
    cm.on('cursorActivity', () => {
      if (!active || !visibleContext) return;
      const cursor = cm.getCursor();
      const context = contextAt(cm.getLine(cursor.line), cursor.ch);
      if (!context || cursor.line !== visibleContext.line || cursor.ch !== visibleContext.cursorCh || context.fromCh !== visibleContext.fromCh || context.mode !== visibleContext.mode || context.object !== visibleContext.object) hide();
    });
    cm.on('scroll', hide);
    cm.on('blur', () => { if (visibleContext) hide(); });
    cm.on('optionChange', (_instance, option) => { if (option === 'mode') { analysisCache = null; hide(); } });
    cm.on('keydown', (_instance, event) => {
      if (!active || !suggestions.length) return;
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        select(selectedIndex + (event.key === 'ArrowDown' ? 1 : -1));
      } else if (event.key === 'Enter' || event.key === 'Tab') {
        event.preventDefault();
        apply(suggestions[selectedIndex]);
      } else if (event.key === 'Escape') {
        event.preventDefault();
        hide();
      }
    });
    if (doc) doc.addEventListener('mousedown', event => { if (popup && !popup.contains(event.target)) hide(); });
    if (win) win.addEventListener('resize', hide);
    if (active) loadCatalog();

    return { setEnabled, check, hide, isEnabled: () => active, getSuggestions: () => suggestions.slice() };
  }

  return {
    MAX_ANALYSIS_LENGTH, PYTHON_KEYWORDS, PYTHON_BUILTINS,
    analyzePython, analyzeJavascript, contextAt, catalogIndex,
    buildSuggestionSet, createEngine
  };
});
