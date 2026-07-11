import re
import unittest
from pathlib import Path


BASE_DIR = Path(__file__).resolve().parents[1]


def _css_without_comments(path: Path) -> str:
    raw = path.read_text(encoding="utf-8")
    return re.sub(r"/\*.*?\*/", "", raw, flags=re.DOTALL)


class LayoutStaticTestCase(unittest.TestCase):
    def test_layout_stylesheets_have_balanced_blocks(self):
        paths = [
            BASE_DIR / "static/css/base.css",
            BASE_DIR / "static/css/layout.css",
            BASE_DIR / "static/css/features/shell.css",
            BASE_DIR / "static/css/legacy.css",
        ]
        for path in paths:
            with self.subTest(path=path.name):
                css = _css_without_comments(path)
                self.assertEqual(css.count("{"), css.count("}"))

    def test_app_is_viewport_contained_without_legacy_fixed_height(self):
        base = _css_without_comments(BASE_DIR / "static/css/base.css")
        layout = _css_without_comments(BASE_DIR / "static/css/layout.css")
        legacy = _css_without_comments(BASE_DIR / "static/css/legacy.css")

        self.assertRegex(base, r"html\s*\{[^}]*overflow:\s*hidden")
        self.assertRegex(base, r"body\s*\{[^}]*height:\s*100%[^}]*overflow:\s*hidden")
        self.assertRegex(layout, r"\.app-shell\s*\{[^}]*--app-height|\.app-shell\s*\{[^}]*var\(--app-height")
        self.assertNotIn("calc(100vh - 60px)", legacy)
        self.assertNotIn("min-height:400px", legacy.replace(" ", ""))

    def test_shell_has_one_bounded_scroll_surface(self):
        shell = _css_without_comments(BASE_DIR / "static/css/features/shell.css")

        self.assertRegex(shell, r"#shellPanel\s*>\s*\.content\s*\{[^}]*overflow:\s*hidden")
        self.assertRegex(shell, r"#output\s*\{[^}]*height:\s*auto[^}]*min-height:\s*0[^}]*overflow:\s*auto")
        self.assertIn("touch-action: pan-x pan-y", shell)

    def test_touch_viewport_sync_does_not_scroll_the_page(self):
        layout_js = (BASE_DIR / "static/js/layout.js").read_text(encoding="utf-8")
        app_core = (BASE_DIR / "static/js/app-core.js").read_text(encoding="utf-8")

        self.assertIn("window.visualViewport", layout_js)
        self.assertIn("--app-height", layout_js)
        self.assertNotIn("scrollIntoView", layout_js)
        self.assertIn("output.scrollTop = output.scrollHeight", layout_js)
        self.assertIn("outputEl.scrollTop = outputEl.scrollHeight", app_core)


if __name__ == "__main__":
    unittest.main()
