import unittest

from trace_support import SourceNarrator


class SourceNarratorTestCase(unittest.TestCase):
    def test_file_and_csv_operations_name_the_resource_mode_and_operation(self):
        source = (
            "import csv as csv_tools\n"
            "with open('scores.csv', 'r', encoding='utf-8', newline='') as source_file:\n"
            "    reader = csv_tools.DictReader(source_file, delimiter=';')\n"
            "    first_line = source_file.readline()\n"
            "with open('results.csv', 'w', newline='') as output_file:\n"
            "    writer = csv.DictWriter(output_file, fieldnames=['name', 'score'])\n"
            "    writer.writeheader()\n"
            "    writer.writerow({'name': 'Ada', 'score': 10})\n"
        )
        narrator = SourceNarrator(source)

        opening = narrator.describe_line(2)
        self.assertIn("'scores.csv'", opening)
        self.assertIn("mode 'r'", opening)
        self.assertIn("read an existing file", opening)
        self.assertIn("encoding 'utf-8'", opening)
        self.assertIn("closes the file automatically", opening)
        self.assertIn("dictionary keyed by column heading", narrator.describe_line(3))
        self.assertIn("delimiter=';'", narrator.describe_line(3))
        self.assertIn("next line", narrator.describe_line(4))
        self.assertIn("create or replace", narrator.describe_line(5))
        self.assertIn("column order", narrator.describe_line(6))
        self.assertIn("header row", narrator.describe_line(7))
        self.assertIn("one CSV row", narrator.describe_line(8))

    def test_imported_calls_stay_outside_trace_and_super_and_dunders_are_explained(self):
        source = (
            "import math as maths\n"
            "answer = maths.sqrt(81)\n"
            "class Child(Parent):\n"
            "    def __init__(self, name):\n"
            "        super().__init__(name)\n"
            "    def __str__(self):\n"
            "        return self.name\n"
        )
        narrator = SourceNarrator(source)

        imported = narrator.describe_line(2)
        self.assertIn("math.sqrt", imported)
        self.assertIn("does not enter imported library code", imported)
        self.assertIn("initializer", narrator.describe_line(4))
        self.assertIn("parent class initializer", narrator.describe_line(5))
        self.assertIn("friendly text", narrator.describe_line(6))
        items = {item["name"]: item["type"] for item in narrator.defined_items}
        self.assertEqual(items["maths"], "imported module")
        self.assertEqual(items["Child"], "class")
        self.assertEqual(items["Child.__init__"], "special method")
        self.assertEqual(items["Child.__str__"], "special method")


if __name__ == "__main__":
    unittest.main()
