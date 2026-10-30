import { describe, expect, test } from "bun:test";
import { TIMELINE_TRACK_GAP_PX } from "../layout";
import { getTrackHeight, getTrackOffsets } from "../track-layout";

const tracks = [
	{ id: "video", type: "video" },
	{ id: "text", type: "text" },
	{ id: "graphic", type: "graphic" },
	{ id: "audio", type: "audio" },
] as const;

describe("track layout collapsing", () => {
	test("collapses only compact tracks and removes their expansion height", () => {
		const result = getTrackOffsets({
			tracks: [...tracks],
			getExtraHeight: () => 20,
			collapsedTrackIds: new Set(["video", "text", "graphic"]),
		});

		expect(getTrackHeight({ type: "video", collapsed: true })).toBe(65);
		expect(getTrackHeight({ type: "text", collapsed: true })).toBe(20);
		expect(result.offsets).toEqual([
			0,
			65 + 20 + TIMELINE_TRACK_GAP_PX,
			65 + 20 + 20 + TIMELINE_TRACK_GAP_PX * 2,
			65 + 20 + 20 + 20 + TIMELINE_TRACK_GAP_PX * 3,
		]);
		expect(result.totalHeight).toBe(
			65 + 20 + 20 + 20 + 50 + 20 + TIMELINE_TRACK_GAP_PX * 3,
		);
	});

	test("restores compact track height and expansion when expanded", () => {
		const collapsed = getTrackOffsets({
			tracks: [...tracks],
			getExtraHeight: () => 20,
			collapsedTrackIds: new Set(["text"]),
		});
		const expanded = getTrackOffsets({
			tracks: [...tracks],
			getExtraHeight: () => 20,
		});

		expect(expanded.offsets[2]! - collapsed.offsets[2]!).toBe(25);
		expect(expanded.totalHeight - collapsed.totalHeight).toBe(25);
	});
});
