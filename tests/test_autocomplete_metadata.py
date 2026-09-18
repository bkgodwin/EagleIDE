import csv
import unittest
from pathlib import Path


BASE_DIR = Path(__file__).resolve().parents[1]


class AutocompleteMetadataTestCase(unittest.TestCase):
    def setUp(self):
        with (BASE_DIR / "autocomplete_metadata.csv").open(newline="", encoding="utf-8") as handle:
            self.rows = list(csv.DictReader(handle))

    def test_python_string_list_and_file_catalog_is_complete(self):
        expected = {
            "str": {
                "capitalize", "casefold", "center", "count", "encode", "endswith", "expandtabs",
                "find", "format", "format_map", "index", "isalnum", "isalpha", "isascii",
                "isdecimal", "isdigit", "isidentifier", "islower", "isnumeric", "isprintable",
                "isspace", "istitle", "isupper", "join", "ljust", "lower", "lstrip", "maketrans",
                "partition", "removeprefix", "removesuffix", "replace", "rfind", "rindex", "rjust",
                "rpartition", "rsplit", "rstrip", "split", "splitlines", "startswith", "strip",
                "swapcase", "title", "translate", "upper", "zfill",
            },
            "list": {"append", "clear", "copy", "count", "extend", "index", "insert", "pop", "remove", "reverse", "sort"},
            "file": {"close", "detach", "fileno", "flush", "isatty", "read", "readable", "readline", "readlines", "reconfigure", "seek", "seekable", "tell", "truncate", "writable", "write", "writelines"},
        }
        for owner, methods in expected.items():
            found = {row["name"] for row in self.rows if row["owner"] == owner and row["kind"] == "method"}
            self.assertEqual(found, methods)

    def test_each_catalog_entry_has_editable_help_fields(self):
        self.assertGreaterEqual(len(self.rows), 145)
        for row in self.rows:
            self.assertEqual(row["language"], "python")
            self.assertTrue(row["owner"])
            self.assertTrue(row["name"])
            self.assertTrue(row["kind"])
            self.assertTrue(row["returns"])
            self.assertTrue(row["description"])
            if row["kind"] in {"function", "method"}:
                self.assertTrue(row["signature"])

        builtin_names = {row["name"] for row in self.rows if row["owner"] == "builtin"}
        self.assertEqual(len(builtin_names), 70)
        self.assertTrue({"open", "print", "len", "range", "zip"}.issubset(builtin_names))

    def test_catalog_api_and_client_asset_are_wired(self):
        app_source = (BASE_DIR / "app.py").read_text(encoding="utf-8")
        page = (BASE_DIR / "index.html").read_text(encoding="utf-8")
        self.assertIn('@app.get("/api/autocomplete/catalog")', app_source)
        self.assertIn('/static/js/autocomplete.js', page)


if __name__ == "__main__":
    unittest.main()
