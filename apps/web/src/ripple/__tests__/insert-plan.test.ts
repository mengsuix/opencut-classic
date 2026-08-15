import { describe, expect, test } from "bun:test";
import type { VideoElement, VideoTrack } from "@/timeline";
import { planRippleInsert } from "@/ripple";
import { mediaTime, ZERO_MEDIA_TIME } from "@/wasm";

function buildVideoElement({
	id,
	startTime,
	duration,
}: {
	id: string;
	startTime: number;
	duration: number;
}): VideoElement {
	return {
		id,
		type: "video",
		name: id,
		startTime: mediaTime({ ticks: startTime }),
		duration: mediaTime({ ticks: duration }),
		trimStart: ZERO_MEDIA_TIME,
		trimEnd: ZERO_MEDIA_TIME,
		mediaId: `media-${id}`,
		params: {
			"transform.positionX": 0,
			"transform.positionY": 0,
			"transform.scaleX": 1,
			"transform.scaleY": 1,
			"transform.rotate": 0,
			opacity: 1,
			volume: 1,
			muted: false,
		},
	};
}

function buildTrack(elements: VideoElement[]): VideoTrack {
	return {
		id: "track-1",
		type: "video",
		name: "Main Track",
		elements,
		muted: false,
		hidden: false,
	};
}

const A = buildVideoElement({ id: "a", startTime: 0, duration: 100 });
const B = buildVideoElement({ id: "b", startTime: 100, duration: 100 });

describe("planRippleInsert", () => {
	test("inserts at a seam without splitting", () => {
		const plan = planRippleInsert({
			track: buildTrack([A, B]),
			requestedInsertTime: mediaTime({ ticks: 100 }),
			elementDuration: mediaTime({ ticks: 50 }),
		});

		expect(plan).toEqual({
			insertTime: mediaTime({ ticks: 100 }),
			splitElementId: null,
			shiftAmount: mediaTime({ ticks: 50 }),
		});
	});

	test("splits the element under the insert point", () => {
		const plan = planRippleInsert({
			track: buildTrack([A, B]),
			requestedInsertTime: mediaTime({ ticks: 150 }),
			elementDuration: mediaTime({ ticks: 50 }),
		});

		expect(plan).toEqual({
			insertTime: mediaTime({ ticks: 150 }),
			splitElementId: "b",
			shiftAmount: mediaTime({ ticks: 50 }),
		});
	});

	test("inserts at the track head without splitting", () => {
		const plan = planRippleInsert({
			track: buildTrack([A, B]),
			requestedInsertTime: mediaTime({ ticks: 0 }),
			elementDuration: mediaTime({ ticks: 50 }),
		});

		expect(plan).toEqual({
			insertTime: mediaTime({ ticks: 0 }),
			splitElementId: null,
			shiftAmount: mediaTime({ ticks: 50 }),
		});
	});

	test("snaps the insert point to a nearby element edge", () => {
		const plan = planRippleInsert({
			track: buildTrack([A, B]),
			requestedInsertTime: mediaTime({ ticks: 105 }),
			elementDuration: mediaTime({ ticks: 50 }),
			snapTolerance: 10,
		});

		expect(plan).toEqual({
			insertTime: mediaTime({ ticks: 100 }),
			splitElementId: null,
			shiftAmount: mediaTime({ ticks: 50 }),
		});
	});

	test("does not snap when the edge is beyond tolerance", () => {
		const plan = planRippleInsert({
			track: buildTrack([A, B]),
			requestedInsertTime: mediaTime({ ticks: 120 }),
			elementDuration: mediaTime({ ticks: 50 }),
			snapTolerance: 10,
		});

		expect(plan).toEqual({
			insertTime: mediaTime({ ticks: 120 }),
			splitElementId: "b",
			shiftAmount: mediaTime({ ticks: 50 }),
		});
	});

	test("returns null when nothing needs to shift", () => {
		const plan = planRippleInsert({
			track: buildTrack([A, B]),
			requestedInsertTime: mediaTime({ ticks: 200 }),
			elementDuration: mediaTime({ ticks: 50 }),
		});

		expect(plan).toBeNull();
	});

	test("returns null for non-positive duration", () => {
		const plan = planRippleInsert({
			track: buildTrack([A, B]),
			requestedInsertTime: mediaTime({ ticks: 100 }),
			elementDuration: ZERO_MEDIA_TIME,
		});

		expect(plan).toBeNull();
	});
});
