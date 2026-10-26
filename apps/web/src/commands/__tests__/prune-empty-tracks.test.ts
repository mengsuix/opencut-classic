import { describe, expect, mock, test } from "bun:test";

const TICKS = 1000;
mock.module("@/wasm", () => ({
	TICKS_PER_SECOND: TICKS,
	ZERO_MEDIA_TIME: 0,
	mediaTime: ({ ticks }: { ticks: number }) => ticks,
	mediaTimeFromSeconds: ({ seconds }: { seconds: number }) => seconds * TICKS,
	mediaTimeToSeconds: ({ time }: { time: number }) => time / TICKS,
	roundMediaTime: ({ time }: { time: number }) => Math.round(time),
	addMediaTime: ({ a, b }: { a: number; b: number }) => a + b,
	subMediaTime: ({ a, b }: { a: number; b: number }) => a - b,
	maxMediaTime: ({ a, b }: { a: number; b: number }) => Math.max(a, b),
	minMediaTime: ({ a, b }: { a: number; b: number }) => Math.min(a, b),
}));

// Command modules import EditorCore only to execute; mocking it keeps the
// heavy manager chain out. The raw wasm package cannot initialize under bun
// test, so mock it too for any transitive module-level import.
mock.module("@/core", () => ({
	EditorCore: { getInstance: () => ({}) },
}));
mock.module("opencut-wasm", () => ({
	formatTimecode: () => "",
}));

// Dynamic imports: static imports are hoisted above the mock.module calls,
// so the commands must be imported only after the mocks are registered.
// NOTE: split-elements / ripple-shift-elements are not imported here — their
// "@/timeline" / "@/animation" barrel chains need @/wasm exports that other
// test files' earlier @/wasm mocks (shared bun module registry) don't
// provide. Their pruneEmptyTracks=false is the base-class default, which the
// MoveElementCommand case below covers.
const { BatchCommand } = await import("../batch-command");
const { AddTrackCommand } = await import("../timeline/track/add-track");
const { DeleteElementsCommand } = await import(
	"../timeline/element/delete-elements"
);
const { MoveElementCommand } = await import(
	"../timeline/element/move-elements"
);

// Empty-track pruning is opt-in: only commands that can leave a track empty
// may prune. Anything else (rename, mute, lock, add-track...) must not, so a
// manually added empty track survives unrelated edits.
describe("pruneEmptyTracks opt-in", () => {
	test("DeleteElementsCommand opts in", () => {
		expect(new DeleteElementsCommand({ elements: [] }).pruneEmptyTracks).toBe(
			true,
		);
	});

	test("AddTrackCommand does not prune — the new track starts empty", () => {
		expect(new AddTrackCommand({ type: "video" }).pruneEmptyTracks).toBe(false);
	});

	test("moving never empties a track intentionally — it does not prune", () => {
		expect(new MoveElementCommand({ moves: [] }).pruneEmptyTracks).toBe(false);
	});

	test("BatchCommand prunes when any child opts in", () => {
		expect(
			new BatchCommand([new AddTrackCommand({ type: "audio" })])
				.pruneEmptyTracks,
		).toBe(false);
		expect(
			new BatchCommand([
				new AddTrackCommand({ type: "audio" }),
				new DeleteElementsCommand({ elements: [] }),
			]).pruneEmptyTracks,
		).toBe(true);
	});
});
