#!/usr/bin/env python3
"""Transform index.html: external CSS/JS, app shell HTML."""
from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
INDEX = ROOT / "index.html"
JS_DIR = ROOT / "static" / "js"


NEW_HEAD_LINKS = '''  <link rel="stylesheet" href="/static/css/main.css">
'''

TOPBAR_OLD = re.compile(
    r'<header class="topbar">.*?</header>',
    re.DOTALL,
)

TOPBAR_NEW = '''  <div class="app-shell">
  <header class="topbar topbar-primary" id="topbarPrimary">
    <div class="brand"><div>EagleIDE</div></div>
    <div class="topbar-primary-center">
      <button class="btn run" id="runBtn">Run ▶</button>
      <button class="btn exception-help-btn" id="exceptionHelpBtn" title="Troubleshooting Assistant" aria-label="Open troubleshooting assistant">🛠️ Help</button>
      <span class="file-chip" id="activeFileChip"><span id="activeFileName"></span></span>
      <span id="editorLiveIndicator" class="live-indicator chip chip--live">Live</span>
      <span class="guest-badge chip" id="guestBadge">Guest</span>
    </div>
    <div class="topbar-primary-actions">
      <button class="btn btn--admin" id="loginBtn" title="Login">Sign In</button>
      <div class="role-menu" id="roleMenu">
        <button class="btn btn--ghost btn--icon secondary" id="roleMenuBtn" type="button" aria-haspopup="true" aria-expanded="false" title="Account menu" style="display:none;">⋯</button>
        <div class="role-menu-panel glass-surface" id="roleMenuPanel">
          <button class="btn btn--admin admin" id="teacherDashboardBtn" title="Teacher Dashboard" style="display:none;">📋 Dashboard</button>
          <button class="btn btn--admin admin" id="adminUsersBtn" title="User Management" style="display:none;">👥 Users</button>
          <button class="btn btn--admin admin" id="serverHealthBtn" title="Server Health" style="display:none;">🖥️ Server Health</button>
          <button class="btn btn--admin admin" id="adminSettingsBtn" title="Admin Settings" style="display:none;">⚙ Settings</button>
          <button class="btn btn--danger stop" id="signOutBtn" title="Sign out" style="display:none;">Sign Out</button>
        </div>
      </div>
    </div>
  </header>
  <div class="tool-tray" id="toolTray">
    <button class="btn btn--ghost tool-tray-toggle" id="toolTrayToggle" type="button" aria-expanded="true" aria-label="Toggle editor tools">Tools ▾</button>
    <div class="control-group" id="modeSelectorWrap">
      <span class="control-label">Mode</span>
      <select id="languageSelector" class="select">
        <option value="auto">Auto</option>
        <option value="python">Python</option>
        <option value="javascript">JavaScript</option>
        <option value="html">HTML</option>
      </select>
    </div>
    <button class="btn secondary" id="themeToggleBtn" title="Toggle light/dark mode">🌙</button>
    <div class="control-group">
      <span class="control-label">A</span>
      <input id="fontRange" type="range" min="12" max="40" value="14" step="1" class="font-range">
      <span id="fontVal" class="font-val">14</span>
    </div>
    <button class="btn secondary" id="guidesBtn" title="Show/Hide indent guides">Guides: On</button>
    <button class="btn secondary" id="autocompleteBtn" title="Toggle autocomplete">Autocomplete: On</button>
    <div id="classSelectorWrap" class="guest-hidden">
      <div class="class-selector-row">
        <span class="control-label">Class</span>
        <select id="classSelector" class="select"></select>
      </div>
    </div>
    <button class="btn secondary guest-hidden" id="streamingToggleBtn" title="Toggle code streaming to students" style="display:none;">📡 Streaming: Off</button>
  </div>'''

TABLET_NAV = '''
  <nav class="tablet-panel-nav" id="tabletPanelNav" aria-label="Panel switcher">
    <button type="button" data-panel="editor" class="active">Editor</button>
    <button type="button" data-panel="shell">Shell</button>
    <button type="button" data-panel="resources">Resources</button>
  </nav>
  <div class="action-sheet" id="fileActionSheet" aria-hidden="true">
    <div class="action-sheet-panel glass-surface" id="fileActionSheetPanel"></div>
  </div>
'''

SCRIPT_MAP = [
    ("editor-init.js", "Editor init"),
    ("markdown.js", "Shared Markdown render helpers"),
    ("state-socket.js", "App state & sockets"),
    ("app-main.js", "Config load & apply + splitters + font & guides controls + admin + AI & Assistant"),
]


def extract_scripts(html: str) -> dict[str, str]:
    out: dict[str, str] = {}
    for fname, label in SCRIPT_MAP:
        pat = rf"<!--\s*{re.escape(label)}\s*-->\s*<script>(.*?)</script>"
        m = re.search(pat, html, re.DOTALL)
        if m:
            out[fname] = m.group(1).strip() + "\n"
    return out


def patch_app_main(js: str) -> str:
    old_apply = """      if (cfg.topbar_color) {
        document.querySelector('.topbar').style.background = cfg.topbar_color;
      }"""
    new_apply = """      if (cfg.topbar_color) {
        document.documentElement.style.setProperty('--theme-topbar', cfg.topbar_color);
      }"""
    js = js.replace(old_apply, new_apply)

    old_auth = """      adminSettingsBtn.style.display = ADMIN_TOKEN ? '' : 'none';
      adminSettingsBtn.title = 'Admin Settings';
      const teacherDashboardBtn = document.getElementById('teacherDashboardBtn');
      if (teacherDashboardBtn) teacherDashboardBtn.style.display = TEACHER_TOKEN ? '' : 'none';
      if (adminUsersBtn) adminUsersBtn.style.display = ADMIN_TOKEN ? '' : 'none';
      if (serverHealthBtn) serverHealthBtn.style.display = ADMIN_TOKEN ? '' : 'none';"""
    new_auth = """      adminSettingsBtn.style.display = ADMIN_TOKEN ? '' : 'none';
      adminSettingsBtn.title = 'Admin Settings';
      const teacherDashboardBtn = document.getElementById('teacherDashboardBtn');
      if (teacherDashboardBtn) teacherDashboardBtn.style.display = TEACHER_TOKEN ? '' : 'none';
      if (adminUsersBtn) adminUsersBtn.style.display = ADMIN_TOKEN ? '' : 'none';
      if (serverHealthBtn) serverHealthBtn.style.display = ADMIN_TOKEN ? '' : 'none';
      const roleMenuBtn = document.getElementById('roleMenuBtn');
      if (roleMenuBtn) roleMenuBtn.style.display = isLoggedIn ? '' : 'none';"""
    js = js.replace(old_auth, new_auth)

    # Remove duplicate teacherDashboardBtn display if we already have it
    return js


def transform_html(html: str) -> str:
    html = re.sub(r"<style>.*?</style>\s*", "", html, count=1, flags=re.DOTALL)
    if "/static/css/main.css" not in html:
        html = html.replace("</head>", NEW_HEAD_LINKS + "</head>")

    # Defer heavy chart/pdf libs — removed from head, loaded lazily
    html = re.sub(
        r'\s*<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.3/dist/chart.umd.min.js"></script>\s*',
        "\n",
        html,
    )
    html = re.sub(
        r'\s*<script src="https://cdn.jsdelivr.net/npm/jspdf@2.5.1/dist/jspdf.umd.min.js"></script>\s*',
        "\n",
        html,
    )

    html = TOPBAR_OLD.sub(TOPBAR_NEW, html, count=1)

    # Simplify editor panel header (file name moved to topbar chip)
    html = html.replace(
        '<h3><span id="workspaceTitle">Editor</span>: <span id="activeFileName" style="color:#a5c8f0; font-weight:400;"></span><span id="editorLiveIndicator" class="live-indicator">Live</span></h3>',
        '<h3><span id="workspaceTitle">Editor</span></h3>',
    )

    # Shell FAB + hide old toggle text button styling
    html = html.replace(
        '<button class="btn secondary" id="toggleShellBtn" style="font-size:12px; padding:4px 8px;">Hide Shell ▼</button>',
        '<button class="btn secondary" id="toggleShellBtn" title="Toggle shell visibility" aria-label="Toggle shell">Hide Shell ▼</button>',
    )
    html = html.replace(
        '<div class="content"><div id="output"></div></div>',
        '<div class="content"><div id="output"></div></div>\n          <button type="button" class="shell-fab" id="shellFab" title="Toggle shell" aria-label="Toggle shell">▼</button>',
    )

    # Close app-shell before body end + tablet nav (only the real document </body>, not strings in scripts)
    if 'id="tabletPanelNav"' not in html:
        close_marker = "</body>\n</html>"
        if close_marker in html:
            html = html.replace(
                close_marker,
                TABLET_NAV + "\n  </div><!-- .app-shell -->\n</body>\n</html>",
                1,
            )

    # Extract inline scripts
    scripts = extract_scripts(html)
    JS_DIR.mkdir(parents=True, exist_ok=True)
    for fname, content in scripts.items():
        if fname == "app-main.js":
            content = patch_app_main(content)
        (JS_DIR / fname).write_text(content, encoding="utf-8")

    for fname, label in SCRIPT_MAP:
        pat = rf"<!--\s*{re.escape(label)}\s*-->\s*<script>.*?</script>\s*"
        repl = ""
        html = re.sub(pat, repl, html, count=1, flags=re.DOTALL)

    script_tags = '''
  <script src="/static/js/ui/modal.js"></script>
  <script src="/static/js/lazy-libs.js"></script>
  <script src="/static/js/layout.js"></script>
  <script src="/static/js/editor-init.js"></script>
  <script src="/static/js/markdown.js"></script>
  <script src="/static/js/state-socket.js"></script>
  <script src="/static/js/app-main.js"></script>
'''
    if "/static/js/app-main.js" not in html:
        html = html.replace("</body>", script_tags + "\n</body>")

    return html


def main() -> None:
    html = INDEX.read_text(encoding="utf-8")
    if "<style>" in html:
        new_html = transform_html(html)
        INDEX.write_text(new_html, encoding="utf-8")
        print("Updated index.html")
    else:
        print("index.html already migrated (no inline style block)")
    for p in sorted(JS_DIR.rglob("*.js")):
        print(f"  {p.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
