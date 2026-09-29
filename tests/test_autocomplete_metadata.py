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

    def test_python_module_members_and_keyword_help_are_cataloged(self):
        module_entries = {
            owner: {row["name"] for row in self.rows if row["owner"] == owner}
            for owner in ("csv", "json", "random")
        }
        self.assertTrue({"reader", "writer", "DictReader", "DictWriter"}.issubset(module_entries["csv"]))
        self.assertTrue({"dump", "dumps", "load", "loads"}.issubset(module_entries["json"]))
        self.assertTrue({"choice", "randint", "random", "sample", "shuffle"}.issubset(module_entries["random"]))

        keywords = {row["name"]: row for row in self.rows if row["owner"] == "keyword"}
        self.assertTrue({"if", "elif", "else", "for", "while", "in", "not", "and", "or"}.issubset(keywords))
        for name in ("if", "for", "while", "in", "not", "and", "or"):
            self.assertGreaterEqual(len(keywords[name]["description"]), 75)

    def test_object_math_and_chart_helpers_are_cataloged(self):
        expected = {
            "csv.DictReader": {"fieldnames", "line_num"},
            "csv.DictWriter": {"writeheader", "writerow", "writerows"},
            "dict": {"get", "items", "keys", "values"},
            "math": {"pi", "sin", "sqrt", "isclose"},
            "statistics": {"mean", "median", "stdev"},
            "numpy": {"array", "zeros", "linspace"},
            "numpy.ndarray": {"reshape", "shape", "sum"},
            "matplotlib.pyplot": {"plot", "subplots", "xlabel", "show"},
            "matplotlib.axes.Axes": {"plot", "set_title"},
            "sqlite3.Connection": {"cursor", "execute", "commit"},
        }
        for owner, required in expected.items():
            found = {row["name"] for row in self.rows if row["owner"] == owner}
            self.assertTrue(required.issubset(found), f"Missing {owner}: {required - found}")

    def test_catalog_api_and_client_asset_are_wired(self):
        app_source = (BASE_DIR / "app.py").read_text(encoding="utf-8")
        page = (BASE_DIR / "index.html").read_text(encoding="utf-8")
        client_source = (BASE_DIR / "static" / "js" / "autocomplete.js").read_text(encoding="utf-8")
        self.assertIn('@app.get("/api/autocomplete/catalog")', app_source)
        self.assertRegex(page, r'/static/js/autocomplete\.js\?v=[^" ]+')
        self.assertIn("cache: 'no-store'", client_source)
        self.assertIn('metadata = catalogIndex(payload.entries);', client_source)
        self.assertIn('schedule();', client_source)


if __name__ == "__main__":
    unittest.main()
