import { describe, expect, mock, test } from "bun:test";

// `bun test` cannot load the wasm bundle, so the pure integer-tick helpers
// are mocked. The mock must be registered before the dynamic import below —
// mock.module is not hoisted ahead of static imports for aliased specifiers.
const TICKS = 1000;
mock.module("@/wasm", () => ({
	TICKS_PER_SECOND: TICKS,
	ZERO_MEDIA_TIME: 0,
	mediaTime: ({ ticks }: { ticks: number }) => ticks,
	roundMediaTime: ({ time }: { time: number }) => Math.round(time),
	addMediaTime: ({ a, b }: { a: number; b: number }) => a + b,
	subMediaTime: ({ a, b }: { a: number; b: number }) => a - b,
	maxMediaTime: ({ a, b }: { a: number; b: number }) => Math.max(a, b),
	minMediaTime: ({ a, b }: { a: number; b: number }) => Math.min(a, b),
	clampMediaTime: ({
		time,
		min,
		max,
	}: {
		time: number;
		min: number;
		max: number;
	}) => Math.min(Math.max(time, min), max),
	roundFrameTicks: ({
		ticks,
		fps,
	}: {
		ticks: number;
		fps: { numerator: number; denominator: number };
	}) => {
		const frameTicks = (TICKS * fps.denominator) / fps.numerator;
		return Math.round(ticks / frameTicks) * frameTicks;
	},
}));

const { computeGroupResize } = await import("@/timeline/group-resize");
const { mediaTime, ZERO_MEDIA_TIME: ZERO } = await import("@/wasm");

import type { GroupResizeMember } from "@/timeline/group-resize";
import type { MediaTime } from "@/wasm";
import type { FrameRate } from "opencut-wasm";

const FPS: FrameRate = { numerator: 1, denominator: 1 };

function sec(seconds: number): MediaTime {
	return mediaTime({ ticks: seconds * TICKS });
}

function buildMember(
	overrides: Partial<GroupResizeMember> = {},
): GroupResizeMember {
	return {
		trackId: "track-1",
		elementId: "element-1",
		startTime: ZERO,
		duration: sec(5),
		trimStart: ZERO,
		trimEnd: ZERO,
		leftNeighborBound: null,
		rightNeighborBound: null,
		rightFollowers: [],
		...overrides,
	};
}

describe("computeGroupResize", () => {
	test("extending past the right neighbor pushes follower elements", () => {
		const result = computeGroupResize({
			members: [
				buildMember({
					rightNeighborBound: sec(5),
					rightFollowers: [
						{ trackId: "track-1", elementId: "follower-1", startTime: sec(5) },
						{ trackId: "track-1", elementId: "follower-2", startTime: sec(12) },
					],
				}),
			],
			side: "right",
			deltaTime: sec(3),
			fps: FPS,
		});

		const member = result.updates.find((u) => u.elementId === "element-1");
		expect(member?.patch.duration).toBe(sec(8));
		const follower1 = result.updates.find((u) => u.elementId === "follower-1");
		expect(follower1?.patch.startTime).toBe(sec(8));
		const follower2 = result.updates.find((u) => u.elementId === "follower-2");
		expect(follower2?.patch.startTime).toBe(sec(15));
	});

	test("staying within the right neighbor bound does not push followers", () => {
		const result = computeGroupResize({
			members: [
				buildMember({
					rightNeighborBound: sec(10),
					rightFollowers: [
						{ trackId: "track-1", elementId: "follower-1", startTime: sec(10) },
					],
				}),
			],
			side: "right",
			deltaTime: sec(2),
			fps: FPS,
		});

		expect(result.updates).toHaveLength(1);
		expect(result.updates[0]?.patch.duration).toBe(sec(7));
	});

	test("source duration still caps the extension and only the real overflow pushes", () => {
		const result = computeGroupResize({
			members: [
				buildMember({
					trimEnd: sec(2),
					sourceDuration: sec(7),
					rightNeighborBound: sec(5),
					rightFollowers: [
						{ trackId: "track-1", elementId: "follower-1", startTime: sec(5) },
					],
				}),
			],
			side: "right",
			deltaTime: sec(10),
			fps: FPS,
		});

		expect(result.deltaTime).toBe(sec(2));
		const member = result.updates.find((u) => u.elementId === "element-1");
		expect(member?.patch.duration).toBe(sec(7));
		expect(member?.patch.trimEnd).toBe(ZERO);
		const follower = result.updates.find((u) => u.elementId === "follower-1");
		expect(follower?.patch.startTime).toBe(sec(7));
	});

	test("left resize is still clamped by the left neighbor bound", () => {
		const result = computeGroupResize({
			members: [
				buildMember({
					startTime: sec(5),
					leftNeighborBound: sec(3),
				}),
			],
			side: "left",
			deltaTime: sec(-5),
			fps: FPS,
		});

		expect(result.updates).toHaveLength(1);
		expect(result.updates[0]?.patch.startTime).toBe(sec(3));
		expect(result.updates[0]?.patch.duration).toBe(sec(7));
	});

	test("follower pushes are deduped across members on the same track", () => {
		const result = computeGroupResize({
			members: [
				buildMember({
					elementId: "element-1",
					rightNeighborBound: sec(5),
					rightFollowers: [
						{ trackId: "track-1", elementId: "follower-1", startTime: sec(10) },
					],
				}),
				buildMember({
					elementId: "element-2",
					startTime: sec(5),
					rightNeighborBound: sec(10),
					rightFollowers: [
						{ trackId: "track-1", elementId: "follower-1", startTime: sec(10) },
					],
				}),
			],
			side: "right",
			deltaTime: sec(4),
			fps: FPS,
		});

		const followerUpdates = result.updates.filter(
			(u) => u.elementId === "follower-1",
		);
		expect(followerUpdates).toHaveLength(1);
		expect(followerUpdates[0]?.patch.startTime).toBe(sec(14));
	});
});
