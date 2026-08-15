import { describe, expect, test } from "bun:test";
import type { VideoElement, VideoTrack } from "@/timeline";
import { planFollowerPush, planFollowerPushLeft } from "@/ripple";
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

// A[0,100] B[100,200] C[200,300]
const A = buildVideoElement({ id: "a", startTime: 0, duration: 100 });
const B = buildVideoElement({ id: "b", startTime: 100, duration: 100 });
const C = buildVideoElement({ id: "c", startTime: 200, duration: 100 });

function planAnchorA({
	track,
	newStartTime,
	originalStartTime = 0,
}: {
	track: VideoTrack;
	newStartTime: number;
	originalStartTime?: number;
}) {
	return planFollowerPush({
		track,
		anchorElementId: "a",
		anchorNewStartTime: mediaTime({ ticks: newStartTime }),
		anchorOriginalStartTime: mediaTime({ ticks: originalStartTime }),
		anchorDuration: mediaTime({ ticks: 100 }),
	});
}

describe("planFollowerPush", () => {
	test("pushes the chain when the rightward move overlaps the right neighbor", () => {
		// A moves to [50,150], overlapping B at 100 → push by 150-100=50.
		const plan = planAnchorA({
			track: buildTrack([A, B, C]),
			newStartTime: 50,
		});

		expect(plan).toEqual({
			afterTime: mediaTime({ ticks: 100 }),
			shiftAmount: mediaTime({ ticks: 50 }),
		});
	});

	test("returns null when the move stays clear of the right neighbor", () => {
		// A moves to [20,120]... overlaps; use [0,100]→[30,130]? still overlaps.
		// A small rightward move that still fits before B is impossible here
		// since A.duration == 100 and B starts at 100, so use a shorter anchor.
		const shortA = buildVideoElement({ id: "a", startTime: 0, duration: 40 });
		const plan = planFollowerPush({
			track: buildTrack([shortA, B, C]),
			anchorElementId: "a",
			anchorNewStartTime: mediaTime({ ticks: 50 }),
			anchorOriginalStartTime: ZERO_MEDIA_TIME,
			anchorDuration: mediaTime({ ticks: 40 }),
		});

		expect(plan).toBeNull();
	});

	test("returns null for leftward moves", () => {
		const movedB = buildVideoElement({ id: "b", startTime: 100, duration: 100 });
		const plan = planFollowerPush({
			track: buildTrack([A, movedB, C]),
			anchorElementId: "b",
			anchorNewStartTime: mediaTime({ ticks: 50 }),
			anchorOriginalStartTime: mediaTime({ ticks: 100 }),
			anchorDuration: mediaTime({ ticks: 100 }),
		});

		expect(plan).toBeNull();
	});

	test("skips the anchor itself when computing overlap", () => {
		// Anchor's own span at its new position must not count as a follower.
		const plan = planAnchorA({
			track: buildTrack([A, B, C]),
			newStartTime: 10,
		});

		expect(plan).toEqual({
			afterTime: mediaTime({ ticks: 100 }),
			shiftAmount: mediaTime({ ticks: 10 }),
		});
	});

	test("includes a straddling follower in the shift boundary", () => {
		// Gap track: A[0,50] B[60,160]; A moves to [70,120] → B straddles the
		// new span, push boundary is B.start=60, shift=120-60=60.
		const gapA = buildVideoElement({ id: "a", startTime: 0, duration: 50 });
		const gapB = buildVideoElement({ id: "b", startTime: 60, duration: 100 });
		const plan = planFollowerPush({
			track: buildTrack([gapA, gapB]),
			anchorElementId: "a",
			anchorNewStartTime: mediaTime({ ticks: 70 }),
			anchorOriginalStartTime: ZERO_MEDIA_TIME,
			anchorDuration: mediaTime({ ticks: 50 }),
		});

		expect(plan).toEqual({
			afterTime: mediaTime({ ticks: 60 }),
			shiftAmount: mediaTime({ ticks: 60 }),
		});
	});
});

describe("planFollowerPushLeft", () => {
	test("pushes the left chain when the leftward move overlaps it", () => {
		// A[5,15] B[15,25]: drag B left to 12 → overlap A (end 15 > 12),
		// shift = 15-12 = 3, boundary = B's original start.
		const shiftedA = buildVideoElement({ id: "a", startTime: 5, duration: 10 });
		const movedB = buildVideoElement({ id: "b", startTime: 15, duration: 10 });
		const plan = planFollowerPushLeft({
			track: buildTrack([shiftedA, movedB]),
			anchorElementId: "b",
			anchorNewStartTime: mediaTime({ ticks: 12 }),
			anchorOriginalStartTime: mediaTime({ ticks: 15 }),
			anchorDuration: mediaTime({ ticks: 10 }),
		});

		expect(plan).toEqual({
			beforeTime: mediaTime({ ticks: 15 }),
			shiftAmount: mediaTime({ ticks: 3 }),
		});
	});

	test("returns null when the push would cross the timeline start", () => {
		// A[0,10] B[10,20]: drag B left to 5 → would push A below 0.
		const plan = planFollowerPushLeft({
			track: buildTrack([A, B]),
			anchorElementId: "b",
			anchorNewStartTime: mediaTime({ ticks: 5 }),
			anchorOriginalStartTime: mediaTime({ ticks: 10 }),
			anchorDuration: mediaTime({ ticks: 10 }),
		});

		expect(plan).toBeNull();
	});

	test("returns null for rightward moves and non-overlapping leftward moves", () => {
		const rightward = planFollowerPushLeft({
			track: buildTrack([A, B]),
			anchorElementId: "b",
			anchorNewStartTime: mediaTime({ ticks: 15 }),
			anchorOriginalStartTime: mediaTime({ ticks: 10 }),
			anchorDuration: mediaTime({ ticks: 10 }),
		});
		expect(rightward).toBeNull();

		const shortA = buildVideoElement({ id: "a", startTime: 0, duration: 5 });
		const clearLeftward = planFollowerPushLeft({
			track: buildTrack([shortA, B]),
			anchorElementId: "b",
			anchorNewStartTime: mediaTime({ ticks: 8 }),
			anchorOriginalStartTime: mediaTime({ ticks: 10 }),
			anchorDuration: mediaTime({ ticks: 10 }),
		});
		expect(clearLeftward).toBeNull();
	});
});
