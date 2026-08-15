"""Release gate for documentation on changed public pipeline APIs."""

from __future__ import annotations

import importlib.util
from pathlib import Path
import unittest


ROOT = Path(__file__).parents[1]
SPEC = importlib.util.spec_from_file_location(
    "check_documentation_coverage",
    ROOT / "devscripts" / "check_documentation_coverage.py",
)
assert SPEC is not None and SPEC.loader is not None
CHECKER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(CHECKER)


class DocumentationCoverageTests(unittest.TestCase):
    """Keep changed Python/TypeScript public symbols above the 90% gate."""

    def test_changed_public_api_documentation_coverage(self) -> None:
        """Every tracked release API should retain its docstring or JSDoc."""
        report = CHECKER.documentation_report()

        self.assertGreaterEqual(
            report["coverage_percent"],
            report["minimum_percent"],
            report["missing"],
        )


if __name__ == "__main__":
    unittest.main()
