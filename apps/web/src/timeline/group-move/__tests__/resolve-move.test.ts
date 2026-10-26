import { describe, expect, mock, test } from "bun:test";
import type {
	SceneTracks,
	TextElement,
	TextTrack,
	VideoTrack,
} from "@/timeline";
import type { GroupMember, MoveGroup } from "@/timeline/group-move/types";
// `MediaTime` is a branded integer-tick number; the test only needs the brand.
import type { MediaTime } from "@/wasm";

// bun's first `.wasm` import per process crashes (bun 1.2.18), taking down
// whichever test file loads `@/wasm` first. These functions are plain integer
// arithmetic — mock them so this suite is hermetic.
//
// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- test-side construction of the branded tick type; the real constructors live in `@/wasm`, which is mocked below.
const asTicks = (value: number): MediaTime => value as MediaTime;

mock.module("@/wasm", () => ({
	ZERO_MEDIA_TIME: asTicks(0),
	addMediaTime: ({ a, b }: { a: MediaTime; b: MediaTime }) => asTicks(a + b),
	subMediaTime: ({ a, b }: { a: MediaTime; b: MediaTime }) => asTicks(a - b),
	maxMediaTime: ({ a, b }: { a: MediaTime; b: MediaTime }) =>
		a > b ? a : b,
}));

const { resolveGroupMove } = await import(
	"@/timeline/group-move/resolve-move"
);

function ticks(value: number): MediaTime {
	return asTicks(value);
}

const ZERO_TICKS = asTicks(0);

// resolve-move only reads `id`, `startTime`, `duration`, `type` off elements —
// the rest of the element payload is irrelevant to track resolution.
function buildTextElement({
	id,
	startTime,
	duration,
}: {
	id: string;
	startTime: number;
	duration: number;
}): TextElement {
	// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- partial element payload: resolve-move only touches id/startTime/duration/type.
	return {
		id,
		type: "text",
		name: id,
		startTime: ticks(startTime),
		duration: ticks(duration),
		trimStart: ZERO_TICKS,
		trimEnd: ZERO_TICKS,
	} as unknown as TextElement;
}

function buildTextTrack({
	id,
	elements,
}: {
	id: string;
	elements: TextElement[];
}): TextTrack {
	return { id, name: id, type: "text", hidden: false, elements };
}

function buildTracks({ overlay }: { overlay: TextTrack[] }): SceneTracks {
	const main: VideoTrack = {
		id: "main",
		name: "main",
		type: "video",
		muted: false,
		hidden: false,
		elements: [],
	};
	return { overlay, main, audio: [] };
}

function buildTextMember({
	trackId,
	elementId,
	duration,
	timeOffset,
	sectionIndex,
	displayIndex,
}: {
	trackId: string;
	elementId: string;
	duration: number;
	timeOffset: number;
	sectionIndex: number;
	displayIndex: number;
}): GroupMember {
	return {
		trackId,
		elementId,
		elementType: "text",
		duration: ticks(duration),
		timeOffset: ticks(timeOffset),
		trackSection: "overlay",
		sectionIndex,
		displayIndex,
	};
}

describe("resolveGroupMove", () => {
	test("same-track members follow the anchor onto the same existing track", () => {
		const track1 = buildTextTrack({
			id: "t1",
			elements: [
				buildTextElement({ id: "A", startTime: 0, duration: 5 }),
				buildTextElement({ id: "B", startTime: 10, duration: 5 }),
			],
		});
		const track2 = buildTextTrack({ id: "t2", elements: [] });
		const tracks = buildTracks({ overlay: [track1, track2] });

		const anchor = buildTextMember({
			trackId: "t1",
			elementId: "A",
			duration: 5,
			timeOffset: 0,
			sectionIndex: 0,
			displayIndex: 0,
		});
		const memberB = buildTextMember({
			trackId: "t1",
			elementId: "B",
			duration: 5,
			timeOffset: 10,
			sectionIndex: 0,
			displayIndex: 0,
		});
		const group: MoveGroup = { anchor, members: [anchor, memberB] };

		const result = resolveGroupMove({
			group,
			tracks,
			anchorStartTime: ticks(20),
			target: { kind: "existingTrack", anchorTargetTrackId: "t2" },
		});

		expect(result).not.toBeNull();
		expect(result?.createTracks).toEqual([]);
		expect(
			result?.moves.map((move) => ({
				elementId: move.elementId,
				targetTrackId: move.targetTrackId,
				newStartTime: move.newStartTime,
			})),
		).toEqual([
			{ elementId: "A", targetTrackId: "t2", newStartTime: ticks(20) },
			{ elementId: "B", targetTrackId: "t2", newStartTime: ticks(30) },
		]);
	});

	test("same-track members share a single new track instead of one each", () => {
		const track1 = buildTextTrack({
			id: "t1",
			elements: [
				buildTextElement({ id: "A", startTime: 0, duration: 5 }),
				buildTextElement({ id: "B", startTime: 10, duration: 5 }),
			],
		});
		const tracks = buildTracks({ overlay: [track1] });

		const anchor = buildTextMember({
			trackId: "t1",
			elementId: "A",
			duration: 5,
			timeOffset: 0,
			sectionIndex: 0,
			displayIndex: 0,
		});
		const memberB = buildTextMember({
			trackId: "t1",
			elementId: "B",
			duration: 5,
			timeOffset: 10,
			sectionIndex: 0,
			displayIndex: 0,
		});
		const group: MoveGroup = { anchor, members: [anchor, memberB] };

		const result = resolveGroupMove({
			group,
			tracks,
			anchorStartTime: ticks(0),
			target: {
				kind: "newTracks",
				anchorInsertIndex: 1,
				newTrackIds: ["nA", "nB"],
			},
		});

		expect(result).not.toBeNull();
		expect(result?.createTracks).toEqual([
			{ id: "nA", type: "text", index: 1 },
		]);
		const targetByElementId = new Map(
			result?.moves.map((move) => [move.elementId, move.targetTrackId]),
		);
		expect(targetByElementId.get("A")).toBe("nA");
		expect(targetByElementId.get("B")).toBe("nA");
	});

	test("members on different tracks keep their relative offset (anchor up one → all up one)", () => {
		const track1 = buildTextTrack({ id: "t1", elements: [] });
		const track2 = buildTextTrack({
			id: "t2",
			elements: [buildTextElement({ id: "A", startTime: 0, duration: 5 })],
		});
		const track3 = buildTextTrack({
			id: "t3",
			elements: [buildTextElement({ id: "B", startTime: 0, duration: 5 })],
		});
		const tracks = buildTracks({ overlay: [track1, track2, track3] });

		const anchor = buildTextMember({
			trackId: "t2",
			elementId: "A",
			duration: 5,
			timeOffset: 0,
			sectionIndex: 1,
			displayIndex: 1,
		});
		const memberB = buildTextMember({
			trackId: "t3",
			elementId: "B",
			duration: 5,
			timeOffset: 0,
			sectionIndex: 2,
			displayIndex: 2,
		});
		const group: MoveGroup = { anchor, members: [anchor, memberB] };

		const result = resolveGroupMove({
			group,
			tracks,
			anchorStartTime: ticks(0),
			target: { kind: "existingTrack", anchorTargetTrackId: "t1" },
		});

		expect(result).not.toBeNull();
		const targetByElementId = new Map(
			result?.moves.map((move) => [move.elementId, move.targetTrackId]),
		);
		// A moves t2→t1, so B follows t3→t2 — distinct tracks, no split apart.
		expect(targetByElementId.get("A")).toBe("t1");
		expect(targetByElementId.get("B")).toBe("t2");
		expect(result?.createTracks).toEqual([]);
	});
});
