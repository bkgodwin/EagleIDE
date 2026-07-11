import re
import unittest
from collections import Counter
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import urlsplit


BASE_DIR = Path(__file__).resolve().parents[1]


class _DocumentInventory(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=False)
        self.ids = []
        self.local_assets = []
        self.tag_counts = Counter()

    def handle_starttag(self, tag, attrs):
        self.tag_counts[tag] += 1
        values = dict(attrs)
        if values.get("id"):
            self.ids.append(values["id"])
        asset = values.get("src") if tag == "script" else values.get("href") if tag == "link" else ""
        path = urlsplit(asset or "").path
        if path.startswith("/static/"):
            self.local_assets.append(path)


class StaticHtmlTestCase(unittest.TestCase):
    def setUp(self):
        self.raw = (BASE_DIR / "index.html").read_text(encoding="utf-8")
        self.parser = _DocumentInventory()
        self.parser.feed(self.raw)

    def test_document_has_single_root_sections_and_unique_ids(self):
        self.assertEqual(self.parser.tag_counts["html"], 1)
        self.assertEqual(self.parser.tag_counts["head"], 1)
        self.assertEqual(self.parser.tag_counts["body"], 1)
        duplicates = {key: count for key, count in Counter(self.parser.ids).items() if count > 1}
        self.assertEqual(duplicates, {})

    def test_all_local_script_and_style_assets_exist(self):
        missing = [path for path in self.parser.local_assets if not (BASE_DIR / path.lstrip("/")).exists()]
        self.assertEqual(missing, [])

    def test_attribute_ampersands_are_html_escaped(self):
        unescaped = re.findall(r'(?:href|src)="[^"]*&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[0-9A-Fa-f]+);)', self.raw)
        self.assertEqual(unescaped, [])


if __name__ == "__main__":
    unittest.main()
