/**
 * Virtual Linux-style shell commands (workspace-scoped, no server shell access).
 */
(function () {
  'use strict';

  let deps = null;
  const commandHistory = [];
  let historyBrowseIndex = -1;
  let historyDraft = '';

  const HELP_TEXT = `EagleIDE shell commands (virtual — only your workspace files):

Navigation
  pwd                 Show current directory (/ is your home folder)
  cd [directory]      Change directory (supports .., ., ~, and /paths)
  ls                  List files and folders here

Files
  cat <file>          Print file contents
  touch <file>        Create an empty file
  mkdir <directory>   Create a folder
  nano <file>         Open a file in the editor
  rm <file>           Delete a file
  rm -r <directory>   Delete a folder and everything inside it

Programs
  python3 <file.py>   Run a Python file
  python <file.py>    Same as python3
  node <file.js>      Run a JavaScript file

Other
  echo <text>         Print text
  whoami              Show your signed-in username
  clear               Clear shell output
  help                Show this message

Shell commands work when no program is running. Input during a run goes to your program.
Use the Up/Down arrow keys to recall previous commands.`;

  function tokenize(line) {
    const tokens = [];
    let cur = '';
    let quote = null;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (quote) {
        if (ch === quote) quote = null;
        else cur += ch;
      } else if (ch === '"' || ch === "'") {
        quote = ch;
      } else if (/\s/.test(ch)) {
        if (cur) {
          tokens.push(cur);
          cur = '';
        }
      } else {
        cur += ch;
      }
    }
    if (cur) tokens.push(cur);
    return tokens;
  }

  function displayPath(internalPath) {
    if (!internalPath) return '/';
    return '/' + internalPath;
  }

  function normalizePath(path) {
    return String(path || '').replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '');
  }

  function pathEquals(a, b) {
    return normalizePath(a).toLowerCase() === normalizePath(b).toLowerCase();
  }

  function resolvePath(arg, cwd) {
    if (arg == null || arg === '' || arg === '~' || arg === '/') return { path: '' };
    let raw = String(arg).replace(/\\/g, '/');
    if (raw.startsWith('/')) {
      raw = raw.slice(1);
    } else {
      const base = normalizePath(cwd || '');
      raw = base ? `${base}/${raw}` : raw;
    }
    const parts = [];
    for (const seg of raw.split('/')) {
      if (!seg || seg === '.') continue;
      if (seg === '..') {
        if (!parts.length) return { error: 'cd: permission denied: beyond home directory' };
        parts.pop();
      } else if (seg.includes('..')) {
        return { error: 'path: invalid path' };
      } else {
        parts.push(seg);
      }
    }
    return { path: parts.join('/') };
  }

  function findItem(path) {
    if (!deps?.findItemByPath) return null;
    return deps.findItemByPath(path);
  }

  function listItems(cwd) {
    if (!deps?.getItemsAtPath || !deps?.getFileTree) return [];
    return deps.getItemsAtPath(deps.getFileTree(), normalizePath(cwd));
  }

  function itemApiPath(item, fallbackPath) {
    const fromItem = normalizePath(item?.path || '');
    if (fromItem) return fromItem;
    return normalizePath(fallbackPath || '');
  }

  function findInDirectory(parentPath, baseName, typeFilter) {
    const siblings = listItems(parentPath);
    return siblings.find((entry) => {
      if (typeFilter && entry.type !== typeFilter) return false;
      return pathEquals(entry.name, baseName) || pathEquals(entry.path, baseName);
    }) || null;
  }

  function resolveEntry(name, cwd) {
    const cwdNorm = normalizePath(cwd);
    const resolved = resolvePath(name, cwdNorm);
    if (resolved.error) return { error: resolved.error };

    let item = findItem(resolved.path);
    const baseName = resolved.path.includes('/')
      ? resolved.path.slice(resolved.path.lastIndexOf('/') + 1)
      : resolved.path;
    const parentPath = resolved.path.includes('/')
      ? resolved.path.slice(0, resolved.path.lastIndexOf('/'))
      : '';

    if (!item) {
      item = findInDirectory(parentPath, baseName);
    }
    if (!item) {
      return { error: `${name}: No such file or directory` };
    }

    return {
      item,
      apiPath: itemApiPath(item, resolved.path),
    };
  }

  function resolveFolder(target, cwd) {
    if (!target || target === '~' || target === '/') return { path: '' };
    const resolved = resolvePath(target, cwd);
    if (resolved.error) return { error: resolved.error };
    if (!resolved.path) return { path: '' };

    let item = findItem(resolved.path);
    if (!item) {
      const baseName = resolved.path.split('/').pop();
      const parentPath = resolved.path.includes('/')
        ? resolved.path.slice(0, resolved.path.lastIndexOf('/'))
        : '';
      item = findInDirectory(parentPath, baseName, 'folder');
    }
    if (!item || item.type !== 'folder') {
      return { error: `cd: ${target}: No such file or directory` };
    }
    return { path: itemApiPath(item, resolved.path) };
  }

  async function ensureTreeLoaded() {
    if (deps?.ensureFileTree) await deps.ensureFileTree();
  }

  function out(text) {
    deps?.appendOut?.(text.endsWith('\n') ? text : `${text}\n`);
  }

  function err(text) {
    out(text);
  }

  function requireAuth() {
    if (deps?.isAuthenticated?.()) return true;
    err('shell: sign in to use workspace commands (type help for more)');
    return false;
  }

  function rememberCommand(line) {
    const trimmed = String(line ?? '').trim();
    if (!trimmed) return;
    if (commandHistory[commandHistory.length - 1] !== trimmed) commandHistory.push(trimmed);
    if (commandHistory.length > 100) commandHistory.shift();
    historyBrowseIndex = -1;
    historyDraft = '';
  }

  function cmdPwd() {
    out(displayPath(deps.getCwd?.() || ''));
  }

  function cmdCd(args) {
    const target = args[0] || '~';
    const result = resolveFolder(target, deps.getCwd?.() || '');
    if (result.error) {
      err(result.error);
      return;
    }
    deps.setCwd?.(result.path);
  }

  function cmdLs() {
    const cwd = deps.getCwd?.() || '';
    const items = listItems(cwd);
    if (!items.length) return;
    const lines = items.map((item) => {
      const suffix = item.type === 'folder' ? '/' : '';
      return item.name + suffix;
    });
    out(lines.join('  '));
  }

  async function cmdCat(args) {
    const name = args[0];
    if (!name) {
      err('cat: missing operand');
      return;
    }
    const result = resolveEntry(name, deps.getCwd?.() || '');
    if (result.error) {
      err(result.error);
      return;
    }
    const { item, apiPath } = result;
    if (item.type === 'folder') {
      err(`cat: ${item.name}: Is a directory`);
      return;
    }
    try {
      const res = await fetch('/api/files/read?path=' + encodeURIComponent(apiPath), {
        headers: deps.getAuthHeaders?.() || {},
      });
      const j = await res.json().catch(() => ({}));
      if (!j?.ok) {
        err(j?.error || 'cat: could not read file');
        return;
      }
      const content = String(j.content ?? '');
      if (!content) return;
      out(content.endsWith('\n') ? content.slice(0, -1) : content);
    } catch {
      err('cat: network error');
    }
  }

  async function cmdTouch(args) {
    const name = args[0];
    if (!name) {
      err('touch: missing file operand');
      return;
    }
    const resolved = resolvePath(name, deps.getCwd?.() || '');
    if (resolved.error) {
      err(resolved.error);
      return;
    }
    if (findItem(resolved.path) || findInDirectory(
      resolved.path.includes('/') ? resolved.path.slice(0, resolved.path.lastIndexOf('/')) : '',
      resolved.path.includes('/') ? resolved.path.slice(resolved.path.lastIndexOf('/') + 1) : resolved.path
    )) {
      return;
    }
    const fileName = resolved.path.includes('/')
      ? resolved.path.slice(resolved.path.lastIndexOf('/') + 1)
      : resolved.path;
    const parent = resolved.path.includes('/')
      ? resolved.path.slice(0, resolved.path.lastIndexOf('/'))
      : '';
    try {
      const res = await fetch('/api/files/create', {
        method: 'POST',
        headers: deps.getJsonHeaders?.() || {},
        body: JSON.stringify({ name: fileName, type: 'file', parent }),
      });
      const j = await res.json().catch(() => ({}));
      if (!j?.ok) err(j?.error || 'touch: could not create file');
      else await deps.loadFileTree?.();
    } catch {
      err('touch: network error');
    }
  }

  async function cmdMkdir(args) {
    const name = args[0];
    if (!name) {
      err('mkdir: missing operand');
      return;
    }
    const resolved = resolvePath(name, deps.getCwd?.() || '');
    if (resolved.error) {
      err(resolved.error);
      return;
    }
    const parentPath = resolved.path.includes('/')
      ? resolved.path.slice(0, resolved.path.lastIndexOf('/'))
      : '';
    const folderName = resolved.path.includes('/')
      ? resolved.path.slice(resolved.path.lastIndexOf('/') + 1)
      : resolved.path;
    if (findItem(resolved.path) || findInDirectory(parentPath, folderName, 'folder')) {
      err(`mkdir: cannot create directory '${name}': File exists`);
      return;
    }
    try {
      const res = await fetch('/api/files/create', {
        method: 'POST',
        headers: deps.getJsonHeaders?.() || {},
        body: JSON.stringify({ name: folderName, type: 'folder', parent: parentPath }),
      });
      const j = await res.json().catch(() => ({}));
      if (!j?.ok) err(j?.error || 'mkdir: could not create directory');
      else await deps.loadFileTree?.();
    } catch {
      err('mkdir: network error');
    }
  }

  async function cmdNano(args) {
    const name = args[0];
    if (!name) {
      err('nano: missing operand');
      return;
    }
    const result = resolveEntry(name, deps.getCwd?.() || '');
    if (result.error) {
      err(result.error);
      return;
    }
    const { item, apiPath } = result;
    if (item.type === 'folder') {
      err(`nano: ${item.name}: Is a directory`);
      return;
    }
    await deps.openFile?.({ ...item, path: apiPath });
    out(`[Opened ${item.name} in editor]`);
  }

  async function cmdRm(tokens) {
    let recursive = false;
    const paths = [];
    for (const t of tokens) {
      if (t === '-r' || t === '-rf' || t === '-fr') recursive = true;
      else paths.push(t);
    }
    if (!paths.length) {
      err('rm: missing operand');
      return;
    }
    for (const name of paths) {
      const result = resolveEntry(name, deps.getCwd?.() || '');
      if (result.error) {
        err(`rm: cannot remove '${name}': No such file or directory`);
        continue;
      }
      const { item, apiPath } = result;
      if (item.type === 'folder' && !recursive) {
        err(`rm: cannot remove '${name}': Is a directory`);
        continue;
      }
      try {
        const res = await fetch('/api/files/delete', {
          method: 'DELETE',
          headers: deps.getJsonHeaders?.() || {},
          body: JSON.stringify({ path: apiPath }),
        });
        const j = await res.json().catch(() => ({}));
        if (!j?.ok) err(j?.error || `rm: cannot remove '${name}'`);
        else await deps.onItemDeleted?.({ ...item, path: apiPath });
      } catch {
        err('rm: network error');
      }
    }
    await deps.loadFileTree?.();
  }

  async function cmdRunProgram(cmd, args) {
    const name = args[0];
    if (!name) {
      err(`${cmd}: missing operand`);
      return;
    }
    const result = resolveEntry(name, deps.getCwd?.() || '');
    if (result.error) {
      err(result.error);
      return;
    }
    const { item, apiPath } = result;
    if (item.type === 'folder') {
      err(`${cmd}: ${item.name}: Is a directory`);
      return;
    }
    const lower = item.name.toLowerCase();
    if (cmd.startsWith('python') && !lower.endsWith('.py')) {
      err(`${cmd}: '${item.name}' is not a Python file (.py)`);
      return;
    }
    if (cmd === 'node' && !lower.endsWith('.js')) {
      err(`node: '${item.name}' is not a JavaScript file (.js)`);
      return;
    }
    const language = cmd === 'node' ? 'javascript' : 'python';
    const ok = await deps.runFile?.({ ...item, path: apiPath }, language);
    if (!ok) err(`${cmd}: could not start program`);
  }

  function cmdEcho(args) {
    out(args.join(' ') || '');
  }

  function cmdWhoami() {
    const user = deps.getCurrentUser?.();
    const name = user?.name || user?.email || 'guest';
    out(name);
  }

  function cmdClear() {
    deps.clearShell?.();
  }

  function cmdHelp() {
    out(HELP_TEXT);
  }

  async function dispatch(tokens, rawLine) {
    if (!tokens.length) return true;
    const cmd = tokens[0];
    const args = tokens.slice(1);

    if (cmd === 'help' || cmd === '?') {
      cmdHelp();
      return true;
    }
    if (cmd === 'clear') {
      cmdClear();
      return true;
    }
    if (!requireAuth()) return true;
    const treeOk = await ensureTreeLoaded();
    if (treeOk === false) {
      err('shell: could not load workspace files');
      return true;
    }

    switch (cmd) {
      case 'pwd':
        cmdPwd();
        break;
      case 'cd':
        cmdCd(args);
        break;
      case 'ls':
        cmdLs();
        break;
      case 'cat':
        await cmdCat(args);
        break;
      case 'touch':
        await cmdTouch(args);
        break;
      case 'mkdir':
        await cmdMkdir(args);
        break;
      case 'nano':
        await cmdNano(args);
        break;
      case 'rm':
        await cmdRm(args);
        break;
      case 'python3':
      case 'python':
      case 'node':
        await cmdRunProgram(cmd, args);
        break;
      case 'echo':
        cmdEcho(args);
        break;
      case 'whoami':
        cmdWhoami();
        break;
      default:
        err(`${cmd}: command not found (type help)`);
    }
    rememberCommand(rawLine);
    return true;
  }

  function bindStdin(stdinEl, getRuntimeState) {
    if (!stdinEl || stdinEl.__shellHistoryBound) return;
    stdinEl.__shellHistoryBound = true;

    stdinEl.addEventListener('keydown', (e) => {
      const state = getRuntimeState?.() || {};
      const shellMode = window.ShellCommands.shouldHandle(
        !!state.isProgramRunning,
        !!state.waitingForUserInput
      );
      if (!shellMode) return;

      if (e.key === 'ArrowUp') {
        if (!commandHistory.length) return;
        e.preventDefault();
        e.stopImmediatePropagation();
        if (historyBrowseIndex === -1) {
          historyDraft = stdinEl.value;
          historyBrowseIndex = commandHistory.length - 1;
        } else if (historyBrowseIndex > 0) {
          historyBrowseIndex--;
        }
        stdinEl.value = commandHistory[historyBrowseIndex] || '';
        return;
      }
      if (e.key === 'ArrowDown') {
        if (historyBrowseIndex === -1) return;
        e.preventDefault();
        e.stopImmediatePropagation();
        if (historyBrowseIndex >= commandHistory.length - 1) {
          historyBrowseIndex = -1;
          stdinEl.value = historyDraft;
          historyDraft = '';
          return;
        }
        historyBrowseIndex++;
        stdinEl.value = commandHistory[historyBrowseIndex] || '';
      }
    }, true);

    document.getElementById('shellPanel')?.addEventListener('click', () => {
      try { stdinEl.focus(); } catch {}
    });
  }

  window.ShellCommands = {
    init(api) {
      deps = api;
    },
    bindStdin,
    getPromptDisplay() {
      return `${displayPath(deps?.getCwd?.() || '')} $ `;
    },
    shouldHandle(isProgramRunning, waitingForUserInput) {
      if (waitingForUserInput) return false;
      if (isProgramRunning) return false;
      return true;
    },
    async handle(line) {
      const trimmed = String(line ?? '').trim();
      if (!trimmed) return true;
      return dispatch(tokenize(trimmed), trimmed);
    },
    HELP_TEXT,
  };
})();
