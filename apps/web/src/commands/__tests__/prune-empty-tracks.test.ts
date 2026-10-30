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
// provide. Their unset pruneTrackIds is the base-class default, which the
// MoveElementCommand case below covers.
const { BatchCommand } = await import("../batch-command");
const { AddTrackCommand } = await import("../timeline/track/add-track");
const { DeleteElementsCommand } = await import(
	"../timeline/element/delete-elements"
);
const { MoveElementCommand } = await import(
	"../timeline/element/move-elements"
);
const { pruneEmptyTracksByIds } = await import("../../core/prune-empty-tracks");

// Empty-track pruning is scoped: a command lists the track ids it may have
// emptied; the reactor prunes exactly those. Anything else (rename, mute,
// lock, add-track...) lists nothing, so a manually added empty track
// survives unrelated edits.
describe("pruneTrackIds scoping", () => {
	test("DeleteElementsCommand lists the touched tracks, deduped", () => {
		expect(
			new DeleteElementsCommand({
				elements: [
					{ trackId: "t1", elementId: "e1" },
					{ trackId: "t2", elementId: "e2" },
					{ trackId: "t1", elementId: "e3" },
				],
			}).pruneTrackIds,
		).toEqual(["t1", "t2"]);
	});

	test("AddTrackCommand prunes nothing — the new track starts empty", () => {
		expect(new AddTrackCommand({ type: "video" }).pruneTrackIds).toBeUndefined();
	});

	test("moving never empties a track intentionally — it does not prune", () => {
		expect(new MoveElementCommand({ moves: [] }).pruneTrackIds).toBeUndefined();
	});

	test("BatchCommand prunes the union of its children's tracks", () => {
		expect(
			new BatchCommand([new AddTrackCommand({ type: "audio" })]).pruneTrackIds,
		).toBeUndefined();
		expect(
			new BatchCommand([
				new AddTrackCommand({ type: "audio" }),
				new DeleteElementsCommand({
					elements: [{ trackId: "t3", elementId: "e9" }],
				}),
			]).pruneTrackIds,
		).toEqual(["t3"]);
	});
});

describe("pruneEmptyTracksByIds", () => {
	const track = (id: string, elements: unknown[] = []) =>
		({ id, elements }) as never;
	const tracks = {
		overlay: [track("a", [{}]), track("empty-a"), track("empty-b")],
		main: track("main"),
		audio: [track("empty-c")],
	};

	test("prunes only listed tracks that are empty", () => {
		const result = pruneEmptyTracksByIds({
			tracks,
			trackIds: ["empty-a", "a", "main"],
		});
		expect(result.overlay.map((t: { id: string }) => t.id)).toEqual([
			"a",
			"empty-b",
		]);
		expect(result.main.id).toBe("main");
		expect(result.audio.map((t: { id: string }) => t.id)).toEqual(["empty-c"]);
	});

	test("returns the same reference when nothing is pruned", () => {
		expect(pruneEmptyTracksByIds({ tracks, trackIds: ["a"] })).toBe(tracks);
	});
});
