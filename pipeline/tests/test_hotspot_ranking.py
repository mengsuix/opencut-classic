from types import SimpleNamespace
import unittest

from pipeline.hotspots.dedup import dedup
from pipeline.hotspots.fetch import hotspot_to_dict
from pipeline.hotspots.ranking import rank_hotspots
from pipeline.hotspots.types import Hotspot


def stat(name: str, count: int = 30):
    return SimpleNamespace(name=name, count=count, error=None)


class HotspotRankingTests(unittest.TestCase):
    def test_cross_platform_coverage_is_not_an_absolute_priority(self):
        top_rank = Hotspot("weibo", "单平台第一", "", rank=1)
        consensus = Hotspot("weibo", "跨平台靠后", "", rank=30)
        consensus._observations = [
            ("weibo", 30, None),
            ("zhihu", 30, None),
            ("douyin", 30, None),
        ]

        ranked = rank_hotspots(
            [consensus, top_rank],
            [stat("weibo"), stat("zhihu"), stat("douyin")],
        )

        self.assertIs(ranked[0], top_rank)

    def test_available_heat_breaks_rank_ties(self):
        low_heat = Hotspot("weibo", "低热度", "", rank=10, heat=1)
        high_heat = Hotspot("weibo", "高热度", "", rank=10, heat=100)

        ranked = rank_hotspots([low_heat, high_heat], [stat("weibo")])

        self.assertIs(ranked[0], high_heat)

    def test_dedup_is_stable_for_equal_ranks(self):
        first = Hotspot("z-platform", "同一个热点", "", rank=1)
        second = Hotspot("a-platform", "同一个热点", "", rank=1)

        deduped = dedup([first, second])

        self.assertIs(deduped[0], second)

    def test_dedup_preserves_observations_without_changing_output(self):
        items = [
            Hotspot("weibo", "同一个热点", "", rank=8, heat=10),
            Hotspot("zhihu", "同一个热点", "", rank=2, heat=20),
        ]

        deduped = dedup(items)

        self.assertEqual(len(getattr(deduped[0], "_observations")), 2)
        self.assertNotIn("_observations", hotspot_to_dict(deduped[0]))


if __name__ == "__main__":
    unittest.main()
