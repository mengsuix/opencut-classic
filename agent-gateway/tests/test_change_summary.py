import unittest

from app.editor_bridge import format_change_summary


class ChangeSummaryTest(unittest.TestCase):
    def test_empty_log_has_no_summary(self):
        self.assertEqual(format_change_summary([]), "")

    def test_groups_successful_changes_and_failures(self):
        log = [
            {"ok": True, "category": "added"},
            {"ok": True, "category": "modified"},
            {"ok": True, "category": "modified"},
            {"ok": True, "category": "removed"},
            {"ok": False, "error": "invalid HTML"},
        ]
        self.assertEqual(
            format_change_summary(log),
            "\n\n实际执行记录：新增 1 项、修改 2 项、删除 1 项、1 项失败（未应用）。",
        )

    def test_failed_operation_is_not_counted_as_success(self):
        log = [{"ok": False, "category": "modified", "error": "rejected"}]
        self.assertEqual(
            format_change_summary(log),
            "\n\n实际执行记录：1 项失败（未应用）。",
        )


if __name__ == "__main__":
    unittest.main()
