#!/usr/bin/env python3
"""One-time migration: extract CSS/JS from index.html into static/ modules."""
from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
INDEX = ROOT / "index.html"
STATIC = ROOT / "static"


def extract_style(html: str) -> str:
    m = re.search(r"<style>(.*?)</style>", html, re.DOTALL)
    return m.group(1).strip() if m else ""


def extract_scripts(html: str) -> list[tuple[str, str]]:
    """Return list of (comment_label, script_content) for inline scripts after </head>."""
    body_idx = html.find("<body>")
    rest = html[body_idx:]
    scripts = []
    for m in re.finditer(r"<!--([^>]*)-->\s*<script>(.*?)</script>", rest, re.DOTALL):
        label = m.group(1).strip()
        content = m.group(2).strip()
        scripts.append((label, content))
    return scripts


def split_css(css: str) -> dict[str, str]:
    """Split CSS into module files by comment sections."""
    lines = css.splitlines()
    modules: dict[str, list[str]] = {
        "features/editor.css": [],
        "features/shell.css": [],
        "features/file-browser.css": [],
        "features/resources.css": [],
        "features/quiz.css": [],
        "features/teacher-dashboard.css": [],
        "features/admin.css": [],
        "legacy.css": [],
    }
    current = "legacy.css"
    for line in lines:
        low = line.lower()
        if "codemirror" in low or "editor disabled" in low or "eagle-completions" in low or "csv-editor" in low or "editor-content-stack" in low or "teacher-stream" in low or "teacher-pane-toggle" in low:
            current = "features/editor.css"
        elif "#output" in low or "shell-" in low or ".sys-msg" in low:
            current = "features/shell.css"
        elif "file-tree" in low or "file-sidebar" in low or "embedded-file-browser" in low or "workspace-tab" in low or "submission-scoring" in low:
            current = "features/file-browser.css"
        elif "assignment" in low or "chat-" in low or ".msg" in low or "notes-toolbar" in low or "ai-toolbar" in low or "skill-" in low or "mastery-" in low or "quiz-lock" in low or "question-" in low or "score-report" in low:
            if "teacher-dash" in low or "teacher-roster" in low or "teacher-reports" in low or "teacher-split" in low or "teacher-panel" in low:
                current = "features/teacher-dashboard.css"
            elif "question-" in low or "quiz-" in low or "code-read" in low:
                current = "features/quiz.css"
            else:
                current = "features/resources.css"
        elif "teacher-dash" in low or "teacher-roster" in low or "teacher-reports" in low:
            current = "features/teacher-dashboard.css"
        elif "admin-users" in low or "server-health" in low or "users-table" in low:
            current = "features/admin.css"
        elif ".btn" in low or ".modal" in low or ".ctx-menu" in low or ".tab-btn" in low or ".copy-btn" in low or "guest-badge" in low or "live-indicator" in low or "assignment-score-badge" in low:
            current = "legacy.css"
        elif ":root" in low or "light-mode" in low:
            continue  # skip — handled in tokens.css
        modules[current].append(line)
    return {k: "\n".join(v).strip() + "\n" for k, v in modules.items() if v}


def write_tokens_css() -> None:
    (STATIC / "css").mkdir(parents=True, exist_ok=True)
    (STATIC / "css" / "features").mkdir(parents=True, exist_ok=True)
    tokens = '''/* EagleIDE Design Tokens — Liquid Glass */
:root {
  /* Brand */
  --columbia-blue: #a5c8f0;
  --eagle-red: #c62828;
  --bg-dark: #1e1e1e;
  --text-light: #eaeaea;
  --panel-dark: #141414;
  --panel-mid: #222;

  /* Glass surface */
  --glass-blur: 24px;
  --glass-saturate: 180%;
  --glass-bg: rgba(255, 255, 255, 0.06);
  --glass-bg-elevated: rgba(255, 255, 255, 0.10);
  --glass-border: rgba(255, 255, 255, 0.12);
  --glass-border-highlight: rgba(255, 255, 255, 0.22);
  --glass-shadow: 0 8px 32px rgba(0, 0, 0, 0.24);
  --glass-inset: inset 0 1px 0 rgba(255, 255, 255, 0.08);

  /* Spacing & radius */
  --space-1: 4px;
  --space-2: 8px;
  --space-3: 12px;
  --space-4: 16px;
  --space-5: 20px;
  --space-6: 24px;
  --space-8: 32px;
  --radius-sm: 8px;
  --radius-md: 10px;
  --radius-lg: 16px;
  --touch-min: 44px;
  --topbar-h: 52px;
  --tool-tray-h: 44px;

  /* Semantic theme — dark (default) */
  --theme-bg: #141414;
  --theme-panel: var(--glass-bg);
  --theme-panel-hdr: var(--glass-bg-elevated);
  --theme-border: rgba(255, 255, 255, 0.14);
  --theme-border-mid: rgba(255, 255, 255, 0.08);
  --theme-text: #eaeaea;
  --theme-text-dim: #aaa;
  --theme-input-bg: rgba(0, 0, 0, 0.35);
  --theme-btn: rgba(255, 255, 255, 0.08);
  --theme-btn-hover: rgba(255, 255, 255, 0.14);
  --theme-secondary: rgba(255, 255, 255, 0.12);
  --theme-shell-bg: rgba(12, 12, 12, 0.55);
  --theme-shell-text: #dcdcdc;
  --theme-tab-bg: rgba(0, 0, 0, 0.25);
  --theme-tab-btn: rgba(255, 255, 255, 0.06);
  --theme-topbar: linear-gradient(90deg, rgba(165, 200, 240, 0.75), rgba(127, 178, 235, 0.75));
  --theme-topbar-txt: #0b2540;
  --theme-output-bg: rgba(8, 8, 8, 0.5);
  --theme-cm-bg: rgba(20, 20, 20, 0.45);
  --theme-splitter-a: rgba(255, 255, 255, 0.08);
  --theme-splitter-b: rgba(255, 255, 255, 0.04);
  --theme-bg-image: url(/api/background_dark);

  --splitter-size: 4px;
  --vsplitter-size: 4px;
  --shell-size: 35%;
  --left-width: 50%;
  --teacher-pane-size: 50%;
  --splitter-hit: 16px;

  --cm-font-size: 14px;
  --indent-ch: 4;
  --indent-tabs: 4;

  --transition-fast: 150ms ease-out;
  --transition-panel: 250ms cubic-bezier(0.4, 0, 0.2, 1);
}

body.light-mode {
  --glass-bg: rgba(255, 255, 255, 0.55);
  --glass-bg-elevated: rgba(255, 255, 255, 0.72);
  --glass-border: rgba(255, 255, 255, 0.65);
  --glass-border-highlight: rgba(255, 255, 255, 0.85);
  --glass-shadow: 0 8px 32px rgba(16, 32, 64, 0.12);
  --glass-inset: inset 0 1px 0 rgba(255, 255, 255, 0.9);

  --theme-bg: #f0f2f5;
  --theme-panel: var(--glass-bg);
  --theme-panel-hdr: var(--glass-bg-elevated);
  --theme-border: rgba(0, 0, 0, 0.1);
  --theme-border-mid: rgba(0, 0, 0, 0.06);
  --theme-text: #1a2030;
  --theme-text-dim: #555;
  --theme-input-bg: rgba(255, 255, 255, 0.85);
  --theme-btn: rgba(255, 255, 255, 0.6);
  --theme-btn-hover: rgba(255, 255, 255, 0.85);
  --theme-secondary: rgba(0, 0, 0, 0.06);
  --theme-shell-bg: rgba(240, 242, 246, 0.75);
  --theme-shell-text: #1a2030;
  --theme-tab-bg: rgba(255, 255, 255, 0.5);
  --theme-tab-btn: rgba(255, 255, 255, 0.65);
  --theme-topbar: linear-gradient(90deg, rgba(165, 200, 240, 0.88), rgba(100, 160, 230, 0.88));
  --theme-topbar-txt: #0b2540;
  --theme-output-bg: rgba(238, 240, 245, 0.8);
  --theme-cm-bg: rgba(255, 255, 255, 0.7);
  --theme-splitter-a: rgba(0, 0, 0, 0.08);
  --theme-splitter-b: rgba(0, 0, 0, 0.04);
  --theme-bg-image: url(/api/background);
  --bg-dark: #f0f2f5;
  --text-light: #1a2030;
  --panel-dark: #f0f2f5;
  --panel-mid: #dde3ed;
}

@media (max-width: 1200px) {
  :root { --glass-blur: 16px; }
}

@media (prefers-reduced-transparency: reduce) {
  :root {
    --glass-blur: 0px;
    --glass-saturate: 100%;
    --theme-panel: rgba(30, 30, 30, 0.92);
    --theme-panel-hdr: rgba(24, 24, 24, 0.96);
  }
  body.light-mode {
    --theme-panel: rgba(255, 255, 255, 0.96);
    --theme-panel-hdr: rgba(248, 249, 252, 0.98);
  }
}
'''
    (STATIC / "css" / "tokens.css").write_text(tokens, encoding="utf-8")


def write_base_css() -> None:
    base = '''/* Base reset, typography, glass utility, motion, focus */
*, *::before, *::after { box-sizing: border-box; }

html {
  -webkit-text-size-adjust: 100%;
  height: 100%;
}

body {
  margin: 0;
  min-height: 100%;
  background: var(--theme-bg);
  color: var(--theme-text);
  font-family: 'Inter', system-ui, -apple-system, 'Segoe UI', Roboto, Ubuntu, Cantarell, 'Noto Sans', Arial, sans-serif;
  font-size: 14px;
  line-height: 1.45;
  background-image: var(--theme-bg-image);
  background-attachment: fixed;
  background-size: cover;
  background-position: center;
  background-repeat: no-repeat;
}

.glass-surface {
  background: var(--glass-bg);
  backdrop-filter: blur(var(--glass-blur)) saturate(var(--glass-saturate));
  -webkit-backdrop-filter: blur(var(--glass-blur)) saturate(var(--glass-saturate));
  border: 1px solid var(--glass-border);
  box-shadow: var(--glass-shadow), var(--glass-inset);
}

@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
  }
}

:focus-visible {
  outline: 2px solid var(--columbia-blue);
  outline-offset: 2px;
}

.skeleton {
  background: linear-gradient(90deg, var(--theme-secondary) 25%, var(--theme-btn-hover) 50%, var(--theme-secondary) 75%);
  background-size: 200% 100%;
  animation: skeleton-shimmer 1.2s ease-in-out infinite;
  border-radius: var(--radius-sm);
  min-height: 1em;
}

@keyframes skeleton-shimmer {
  0% { background-position: 200% 0; }
  100% { background-position: -200% 0; }
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

@keyframes pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.8; }
}

@keyframes exception-help-flash {
  0%, 100% { background: #8b1c1c; box-shadow: 0 0 0 rgba(255, 0, 0, 0); }
  50% { background: #ff2e2e; box-shadow: 0 0 12px rgba(255, 46, 46, 0.9); }
}

input[type=file] { display: none; }

pre { position: relative; }

.tab-pane:not(.active) {
  content-visibility: auto;
  contain-intrinsic-size: 0 400px;
}
'''
    (STATIC / "css" / "base.css").write_text(base, encoding="utf-8")


def write_layout_enhancements() -> None:
    layout = '''/* App shell, layout grid, responsive, tablet navigation */

.app-shell {
  display: flex;
  flex-direction: column;
  min-height: 100vh;
}

.topbar-primary {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  padding: var(--space-2) var(--space-4);
  min-height: var(--topbar-h);
  background: var(--theme-topbar);
  color: var(--theme-topbar-txt);
  font-weight: 700;
  letter-spacing: 0.3px;
  backdrop-filter: blur(var(--glass-blur)) saturate(var(--glass-saturate));
  -webkit-backdrop-filter: blur(var(--glass-blur)) saturate(var(--glass-saturate));
  border-bottom: 1px solid var(--glass-border);
  position: sticky;
  top: 0;
  z-index: 200;
}

.topbar-primary .brand { display: flex; gap: var(--space-2); align-items: center; min-width: 0; }
.topbar-primary .brand > div:first-child {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 220px;
  font-weight: 800;
}

.topbar-primary-center {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex: 1;
  min-width: 0;
  justify-content: center;
}

.topbar-primary-actions {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex-shrink: 0;
}

.tool-tray {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex-wrap: wrap;
  padding: var(--space-2) var(--space-4);
  min-height: var(--tool-tray-h);
  background: var(--glass-bg-elevated);
  backdrop-filter: blur(var(--glass-blur)) saturate(var(--glass-saturate));
  -webkit-backdrop-filter: blur(var(--glass-blur)) saturate(var(--glass-saturate));
  border-bottom: 1px solid var(--theme-border-mid);
  z-index: 190;
}

.tool-tray.collapsed { display: none; }

.tool-tray-toggle {
  display: none;
}

.file-chip {
  max-width: 200px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: 500;
  font-size: 12px;
  padding: 4px 10px;
  border-radius: 999px;
  background: rgba(0, 0, 0, 0.15);
  border: 1px solid var(--glass-border);
  color: var(--theme-topbar-txt);
}

body.light-mode .file-chip { background: rgba(255, 255, 255, 0.45); }

.role-menu { position: relative; }
.role-menu-panel {
  display: none;
  position: absolute;
  top: calc(100% + 6px);
  right: 0;
  min-width: 200px;
  padding: var(--space-2);
  border-radius: var(--radius-md);
  z-index: 300;
  flex-direction: column;
  gap: 4px;
}
.role-menu.open .role-menu-panel { display: flex; }
.role-menu-panel .btn { width: 100%; justify-content: flex-start; }

.outer {
  display: grid;
  grid-template-columns: var(--left-width) var(--vsplitter-size) 1fr;
  grid-template-rows: 1fr;
  gap: var(--space-3);
  padding: var(--space-3);
  flex: 1;
  min-height: 0;
  height: calc(100vh - var(--topbar-h) - var(--tool-tray-h));
  overflow: hidden;
}

body.tool-tray-collapsed .outer {
  height: calc(100vh - var(--topbar-h));
}

.panel {
  background: var(--theme-panel);
  border: 1px solid var(--glass-border);
  border-radius: var(--radius-lg);
  overflow: hidden;
  display: flex;
  flex-direction: column;
  min-height: 0;
  backdrop-filter: blur(var(--glass-blur)) saturate(var(--glass-saturate));
  -webkit-backdrop-filter: blur(var(--glass-blur)) saturate(var(--glass-saturate));
  box-shadow: var(--glass-shadow), var(--glass-inset);
}

.panel header {
  background: var(--theme-panel-hdr);
  color: var(--columbia-blue);
  padding: var(--space-2) var(--space-3);
  border-bottom: 1px solid var(--theme-border-mid);
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
}

.panel header h3 { margin: 0; font-size: 14px; color: var(--columbia-blue); }
.panel .content {
  flex: 1;
  min-height: 0;
  overflow: auto;
  overscroll-behavior: contain;
  -webkit-overflow-scrolling: touch;
}

#rightStackPanel .content { overflow: auto; }
#rightColumn { overflow: hidden; }

.outer.no-sidebar #editorPanel { grid-column: 1 / 2; }
.outer.no-sidebar #hsplitter { grid-column: 2 / 3; }
.outer.no-sidebar #rightColumn { grid-column: 3 / 4; }
.outer #editorPanel, .outer #hsplitter, .outer #rightColumn { grid-row: 1 / 2; }

.rightstack {
  display: grid;
  grid-template-rows: var(--shell-size) var(--splitter-size) 1fr;
  grid-template-columns: 1fr;
  height: 100%;
  min-height: 0;
  overflow: hidden;
}

.rightstack .panel { min-height: 0; overflow: hidden; display: flex; flex-direction: column; }

.vsplitter, .hsplitter, .editor-stream-splitter {
  position: relative;
  cursor: row-resize;
  user-select: none;
  touch-action: none;
  background: transparent;
  border: none;
}

.hsplitter { cursor: col-resize; border-radius: var(--radius-lg); }

.vsplitter::before, .hsplitter::before, .editor-stream-splitter::before {
  content: "";
  position: absolute;
  z-index: 1;
}

.vsplitter::before, .editor-stream-splitter::before {
  left: 0; right: 0;
  top: calc(-1 * var(--splitter-hit));
  height: calc(var(--splitter-size) + 2 * var(--splitter-hit));
}

.hsplitter::before {
  top: 0; bottom: 0;
  left: calc(-1 * var(--splitter-hit));
  width: calc(var(--vsplitter-size) + 2 * var(--splitter-hit));
}

.vsplitter::after, .hsplitter::after, .editor-stream-splitter::after {
  content: "";
  position: absolute;
  background: var(--glass-border-highlight);
  border-radius: 999px;
  pointer-events: none;
  box-shadow: 0 0 8px rgba(165, 200, 240, 0.25);
}

.vsplitter::after, .editor-stream-splitter::after {
  left: 50%; top: 50%;
  transform: translate(-50%, -50%);
  width: 48px; height: 4px;
}

.hsplitter::after {
  left: 50%; top: 50%;
  transform: translate(-50%, -50%);
  width: 4px; height: 48px;
}

.vsplitter { grid-row: 2 / 3; grid-column: 1; }
.hsplitter { grid-column: 2 / 3; grid-row: 1 / 2; }

.edge-toggle, .shell-fab, .teacher-pane-toggle {
  backdrop-filter: blur(var(--glass-blur)) saturate(var(--glass-saturate));
  -webkit-backdrop-filter: blur(var(--glass-blur)) saturate(var(--glass-saturate));
}

.edge-toggle {
  position: fixed;
  top: calc(var(--topbar-h) + var(--tool-tray-h) + 35vh);
  transform: translateY(-50%);
  z-index: 250;
  width: 48px;
  height: 48px;
  border: 1px solid var(--glass-border);
  background: var(--theme-panel-hdr);
  color: var(--theme-text);
  font-size: 18px;
  border-radius: 50%;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  box-shadow: var(--glass-shadow);
  transition: transform var(--transition-fast), background var(--transition-fast);
}

.edge-toggle:active { transform: translateY(-50%) scale(0.94); }
#rightEdgeToggleBtn { right: 12px; }

.shell-fab {
  position: absolute;
  bottom: var(--space-3);
  right: var(--space-3);
  width: 44px;
  height: 44px;
  border-radius: 50%;
  border: 1px solid var(--glass-border);
  background: var(--theme-panel-hdr);
  color: var(--theme-text);
  cursor: pointer;
  z-index: 5;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 16px;
  box-shadow: var(--glass-shadow);
}

#shellPanel { position: relative; }

/* Tablet panel switcher */
.tablet-panel-nav {
  display: none;
  position: fixed;
  bottom: 0;
  left: 0;
  right: 0;
  z-index: 280;
  padding: var(--space-2) var(--space-3);
  gap: var(--space-2);
  background: var(--glass-bg-elevated);
  backdrop-filter: blur(var(--glass-blur)) saturate(var(--glass-saturate));
  -webkit-backdrop-filter: blur(var(--glass-blur)) saturate(var(--glass-saturate));
  border-top: 1px solid var(--glass-border);
  justify-content: space-around;
}

.tablet-panel-nav button {
  flex: 1;
  min-height: var(--touch-min);
  border: 1px solid transparent;
  border-radius: var(--radius-md);
  background: transparent;
  color: var(--theme-text-dim);
  font-weight: 700;
  font-size: 13px;
  cursor: pointer;
}

.tablet-panel-nav button.active {
  background: var(--theme-secondary);
  color: var(--columbia-blue);
  border-color: var(--glass-border);
}

.tablet-resources-nav {
  display: none;
}

@media (max-width: 1200px) {
  .tool-tray-toggle { display: inline-flex; }
  .workspace-rail {
    display: flex;
    flex-direction: column;
    gap: 4px;
    padding: var(--space-2);
    border-right: 1px solid var(--theme-border-mid);
    background: var(--theme-panel-hdr);
    flex-shrink: 0;
  }
  #editorPanel header { flex-wrap: wrap; }
  .workspace-tabs { margin-left: 0; }
  .tablet-resources-nav {
    display: flex;
    position: sticky;
    bottom: 0;
    padding: var(--space-2);
    gap: var(--space-1);
    background: var(--theme-panel-hdr);
    border-top: 1px solid var(--theme-border-mid);
    overflow-x: auto;
    flex-wrap: nowrap;
  }
  .tablet-resources-nav .tab-btn { flex-shrink: 0; min-height: var(--touch-min); }
  body.tablet-mode .tablet-panel-nav { display: flex; }
  body.tablet-mode .outer {
    grid-template-columns: 1fr !important;
    grid-template-rows: 1fr;
    padding-bottom: calc(var(--touch-min) + var(--space-4));
  }
  body.tablet-mode .hsplitter { display: none; }
  body.tablet-mode #editorPanel,
  body.tablet-mode #rightColumn { grid-column: 1 !important; grid-row: 1 !important; }
  body.tablet-mode.panel-editor #rightColumn { display: none; }
  body.tablet-mode.panel-shell #editorPanel,
  body.tablet-mode.panel-shell #rightStackPanel { display: none; }
  body.tablet-mode.panel-shell #rightColumn { display: block !important; }
  body.tablet-mode.panel-shell #shellPanel { display: flex !important; }
  body.tablet-mode.panel-shell .vsplitter { display: none; }
  body.tablet-mode.panel-resources #editorPanel { display: none; }
  body.tablet-mode.panel-resources #rightColumn { display: block !important; }
  body.tablet-mode.panel-resources #shellPanel { display: none !important; }
  body.tablet-mode.panel-resources .vsplitter { display: none; }
  body.tablet-mode.panel-resources #rightStackPanel { display: flex !important; }
  .teacher-dash-modal .modal-content { flex-direction: column; }
  .teacher-dash-sidebar { width: 100%; flex-direction: row; overflow-x: auto; border-right: none; border-bottom: 1px solid var(--theme-border-mid); }
  .teacher-dash-nav { flex-direction: row; flex-wrap: nowrap; padding: var(--space-2); }
  .teacher-dash-navbtn { flex-shrink: 0; min-height: var(--touch-min); }
  .teacher-dash-close-area { display: none; }
}

@media (max-width: 1000px) {
  .outer { grid-template-columns: 1fr !important; }
  .hsplitter { display: none; }
}

@media (max-width: 1366px) {
  .tool-tray { gap: var(--space-1); }
  .btn, .tab-btn, .workspace-tab-btn, .file-action-btn { min-height: 40px; }
  .file-tree-item { padding-top: 9px; padding-bottom: 9px; }
}

@media (pointer: coarse) {
  .btn, .tab-btn, .workspace-tab-btn, .file-action-btn, .file-tree-item {
    min-height: var(--touch-min);
  }
  .file-select-checkbox { width: 22px; height: 22px; }
  :root { --splitter-hit: 20px; }
}

body.guest-mode #rightStackPanel { display: none !important; }
body.guest-mode .vsplitter { display: none !important; }
body.guest-mode #rightstack { grid-template-rows: 1fr !important; }
body.guest-mode #shellPanel { grid-row: 1 / 2 !important; }
body.guest-mode #workspaceFilesTabBtn { display: none !important; }

body.right-collapsed #rightColumn { display: none !important; }
body.right-collapsed #hsplitter { display: none !important; }
body.right-collapsed .outer.no-sidebar { grid-template-columns: 1fr !important; }
body.right-collapsed .outer.no-sidebar #editorPanel { grid-column: 1 / 2; }

body.shell-hidden #shellPanel { display: none !important; }
body.shell-hidden .vsplitter { display: none !important; }
body.shell-hidden .rightstack { grid-template-rows: 1fr !important; }
body.shell-hidden #rightStackPanel { grid-row: 1 / 2 !important; }

body.guest-mode .tool-tray .guest-hidden { display: none !important; }
'''
    (STATIC / "css" / "layout.css").write_text(layout, encoding="utf-8")


def write_components_enhancements() -> None:
    components = '''/* Unified components: buttons, fields, tabs, cards, chips, modals */

header.topbar, header .actions { /* legacy compat if old classes remain */ }

header .actions {
  display: flex;
  gap: var(--space-2);
  align-items: center;
  flex-wrap: wrap;
  justify-content: flex-end;
}

.signout-slot { margin-left: auto; display: flex; align-items: center; }

.control-group {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-1) var(--space-2);
  border: 1px solid var(--theme-border-mid);
  border-radius: var(--radius-md);
  background: rgba(0, 0, 0, 0.06);
}

.topbar select, .field, .select {
  appearance: none;
  -webkit-appearance: none;
  background: var(--theme-input-bg) !important;
  color: var(--theme-text) !important;
  border: 1px solid var(--theme-border-mid) !important;
  border-radius: var(--radius-sm);
  padding: var(--space-2) var(--space-3);
  font: inherit;
}

.btn {
  border: 0;
  border-radius: var(--radius-md);
  padding: var(--space-2) var(--space-4);
  font-weight: 700;
  cursor: pointer;
  background: var(--theme-btn);
  color: var(--theme-text);
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.15);
  transition: transform var(--transition-fast), box-shadow var(--transition-fast), background var(--transition-fast);
  font-size: 14px;
  line-height: 1;
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  min-height: 36px;
}

.btn:hover { transform: translateY(-1px); background: var(--theme-btn-hover); }
.btn:active { transform: translateY(0); }
.btn--primary, .run { background: var(--eagle-red); color: #fff; }
.btn--primary:hover, .run:hover { background: #b71c1c; }
.btn--danger, .stop { background: #444; color: #fff; }
.btn--ghost, .secondary { background: var(--theme-secondary); }
.btn--admin, .admin { background: #315; color: #fff; }
.btn--icon { padding: var(--space-2); min-width: 36px; justify-content: center; }

.exception-help-btn {
  min-width: 38px;
  padding: var(--space-2) var(--space-3);
  background: #8b1c1c;
  color: #fff;
  display: none;
}
.exception-help-btn:hover { background: #6d0f0f; }
.exception-help-btn.flash { animation: exception-help-flash 0.4s ease-in-out 5; }

.card, .assignment-card, .teacher-dash-class-card, .server-health-card, .teacher-panel-card, .skill-card, .score-report-item, .assignment-detail-panel {
  background: var(--theme-input-bg);
  border: 1px solid var(--theme-border-mid);
  border-radius: var(--radius-md);
  padding: var(--space-3);
}

.chip, .guest-badge, .skill-chip, .live-indicator, .assignment-score-badge {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 3px 10px;
  border-radius: 999px;
  font-size: 12px;
  font-weight: 600;
}

.guest-badge { background: var(--theme-secondary); color: var(--theme-text-dim); }

.chip--live, .live-indicator.on {
  background: var(--eagle-red);
  color: #fff;
  font-weight: 800;
  letter-spacing: 0.4px;
  text-transform: uppercase;
}

.live-indicator { display: none; margin-left: var(--space-2); }
.live-indicator.on { display: inline-flex; }

.assignment-score-badge.scored { background: #1a3a1a; color: #66bb6a; border: 1px solid #2e7d32; }
.assignment-score-badge.pending { background: #2a2a1a; color: #ffb74d; border: 1px solid #f57c00; }

.seg-tabs, .tabs {
  display: flex;
  gap: var(--space-1);
  border-bottom: 1px solid var(--theme-border-mid);
  background: var(--theme-tab-bg);
  padding: var(--space-2);
  flex-wrap: wrap;
}

.tab-btn, .workspace-tab-btn, .mastery-tabs .mastery-tab-btn {
  padding: var(--space-2) var(--space-3);
  border-radius: var(--radius-sm);
  background: var(--theme-tab-btn);
  color: var(--theme-text);
  border: 1px solid var(--theme-border);
  cursor: pointer;
  font-weight: 700;
  transition: background var(--transition-fast), color var(--transition-fast);
}

.tab-btn.active, .workspace-tab-btn.active {
  background: var(--theme-secondary);
  color: var(--columbia-blue);
}

.tab-pane { display: none; height: 100%; }
.tab-pane.active { display: block; }

.workspace-tabs { display: flex; gap: var(--space-2); margin-left: auto; margin-right: var(--space-2); }
.workspace-tab-btn { min-height: var(--touch-min); min-width: var(--touch-min); padding: var(--space-2) var(--space-4); }

.data-table, table.lb, .scores-table, .users-table, .admin-users-stats-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}

.data-table th, table.lb th, .scores-table th, .users-table th, .admin-users-stats-table th {
  color: var(--columbia-blue);
  border-bottom: 1px solid var(--theme-border-mid);
  padding: var(--space-2);
  text-align: left;
}

.data-table td, table.lb td, .scores-table td, .users-table td, .admin-users-stats-table td {
  border-bottom: 1px solid var(--theme-border-mid);
  padding: var(--space-2);
  color: var(--theme-text);
}

.modal {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.55);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 10000;
  backdrop-filter: blur(8px);
  -webkit-backdrop-filter: blur(8px);
}

.modal-content, .glass-modal .modal-content {
  background: var(--theme-panel);
  border: 1px solid var(--glass-border);
  border-radius: var(--radius-lg);
  padding: var(--space-5);
  max-width: 500px;
  width: 90%;
  max-height: 90vh;
  overflow: auto;
  backdrop-filter: blur(var(--glass-blur)) saturate(var(--glass-saturate));
  -webkit-backdrop-filter: blur(var(--glass-blur)) saturate(var(--glass-saturate));
  box-shadow: var(--glass-shadow), var(--glass-inset);
}

.modal-content h3 { margin-top: 0; color: var(--columbia-blue); }
.modal-content label { display: block; margin: var(--space-3) 0 var(--space-1); font-weight: 600; }
.modal-content input, .modal-content textarea {
  width: 100%;
  padding: var(--space-2);
  background: var(--theme-input-bg);
  color: var(--theme-text);
  border: 1px solid var(--theme-border-mid);
  border-radius: var(--radius-sm);
  font-family: inherit;
}

.modal-actions { display: flex; gap: var(--space-3); margin-top: var(--space-4); justify-content: flex-end; }

.ctx-menu {
  position: fixed;
  background: var(--theme-panel);
  border: 1px solid var(--glass-border);
  border-radius: var(--radius-sm);
  padding: var(--space-1) 0;
  min-width: 160px;
  z-index: 9999;
  box-shadow: var(--glass-shadow);
  backdrop-filter: blur(var(--glass-blur)) saturate(var(--glass-saturate));
  -webkit-backdrop-filter: blur(var(--glass-blur)) saturate(var(--glass-saturate));
}

.ctx-menu button {
  width: 100%;
  background: none;
  border: 0;
  color: var(--theme-text);
  text-align: left;
  padding: var(--space-2) var(--space-4);
  cursor: pointer;
  font-size: 14px;
  min-height: 36px;
}

.ctx-menu button:hover { background: var(--theme-secondary); }
.ctx-menu .danger { color: #ef5350; }

.file-action-btn {
  border: 0;
  border-radius: var(--radius-sm);
  padding: var(--space-2) var(--space-3);
  font-weight: 700;
  cursor: pointer;
  background: var(--theme-btn);
  color: var(--theme-text);
  font-size: 12px;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  transition: background var(--transition-fast);
}

.file-action-btn:hover { background: var(--theme-btn-hover); }
.file-action-btn.danger { background: #5a1b1b; color: #ffb3b3; }

.copy-btn {
  position: absolute;
  top: 6px;
  right: 6px;
  background: var(--theme-secondary);
  color: var(--theme-text);
  border: 1px solid var(--theme-border);
  border-radius: var(--radius-sm);
  padding: 4px 8px;
  font-size: 12px;
  cursor: pointer;
}

.msg.user, .msg--user {
  margin-left: auto;
  background: rgba(25, 50, 77, 0.85);
  color: #e6f1ff;
  border: 1px solid rgba(42, 79, 121, 0.6);
}

.msg.bot, .msg--bot {
  margin-right: auto;
  background: var(--theme-input-bg);
  color: var(--theme-text);
  border: 1px solid var(--theme-border);
}

.msg { max-width: 80%; padding: var(--space-3); border-radius: var(--radius-md); margin: 2px 0; white-space: pre-wrap; }

.action-sheet {
  display: none;
  position: fixed;
  inset: 0;
  z-index: 9998;
  background: rgba(0, 0, 0, 0.4);
  align-items: flex-end;
  justify-content: center;
}
.action-sheet.open { display: flex; }
.action-sheet-panel {
  width: 100%;
  max-width: 480px;
  padding: var(--space-4);
  border-radius: var(--radius-lg) var(--radius-lg) 0 0;
  background: var(--theme-panel);
  backdrop-filter: blur(var(--glass-blur));
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}
'''
    (STATIC / "css" / "components.css").write_text(components, encoding="utf-8")


def write_main_css() -> None:
    imports = '''/* EagleIDE main stylesheet */
@import url("tokens.css");
@import url("base.css");
@import url("layout.css");
@import url("components.css");
@import url("features/editor.css");
@import url("features/shell.css");
@import url("features/file-browser.css");
@import url("features/resources.css");
@import url("features/quiz.css");
@import url("features/teacher-dashboard.css");
@import url("features/admin.css");
@import url("legacy.css");
'''
    (STATIC / "css" / "main.css").write_text(imports, encoding="utf-8")


def main() -> None:
    html = INDEX.read_text(encoding="utf-8")
    css = extract_style(html)
    write_tokens_css()
    write_base_css()
    write_layout_enhancements()
    write_components_enhancements()
    modules = split_css(css)
    for rel, content in modules.items():
        path = STATIC / "css" / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding="utf-8")
    write_main_css()
    print("Created CSS modules in static/css/")
    for p in sorted((STATIC / "css").rglob("*.css")):
        print(f"  {p.relative_to(ROOT)} ({p.stat().st_size} bytes)")

    # Rebuild app-core.js from extracted parts if they exist
    ss = STATIC / "js" / "state-socket.js"
    am = STATIC / "js" / "app-main.js"
    core = STATIC / "js" / "app-core.js"
    if ss.exists() and am.exists():
        core.write_text(ss.read_text(encoding="utf-8") + "\n" + am.read_text(encoding="utf-8"), encoding="utf-8")
        print(f"Rebuilt {core.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
