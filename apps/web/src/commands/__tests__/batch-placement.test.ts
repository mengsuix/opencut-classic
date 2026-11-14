/* eslint-disable @typescript-eslint/no-unsafe-type-assertion, opencut/prefer-object-params -- Isolated test fixtures use branded ticks and compact positional builders. */
import { describe, expect, mock, test } from "bun:test";
import type { SceneTracks, VideoElement } from "@/timeline/types";
import type { MediaTime } from "@/wasm";

mock.module("@/wasm", () => ({
	TICKS_PER_SECOND: 1000,
	ZERO_MEDIA_TIME: 0,
	mediaTime: ({ ticks }: { ticks: number }) => ticks,
	mediaTimeFromSeconds: ({ seconds }: { seconds: number }) => seconds * 1000,
	mediaTimeToSeconds: ({ time }: { time: number }) => time / 1000,
	roundMediaTime: ({ time }: { time: number }) => Math.round(time),
	addMediaTime: ({ a, b }: { a: number; b: number }) => a + b,
	subMediaTime: ({ a, b }: { a: number; b: number }) => a - b,
	maxMediaTime: ({ a, b }: { a: number; b: number }) => Math.max(a, b),
	minMediaTime: ({ a, b }: { a: number; b: number }) => Math.min(a, b),
}));
let tracks: SceneTracks;
const editor = {
	scenes: { getActiveScene: () => ({ tracks }) },
	timeline: {
		updateTracks: (next: SceneTracks) => {
			tracks = next;
		},
	},
};
mock.module("@/core", () => ({ EditorCore: { getInstance: () => editor } }));
const { MoveElementCommand } =
	await import("../timeline/element/move-elements");
const { UpdateElementsCommand } =
	await import("../timeline/element/update-elements");

function video(id: string, startTime = 0): VideoElement {
	return {
		id,
		name: id,
		type: "video",
		mediaId: "source",
		params: {},
		startTime: startTime as MediaTime,
		duration: 2000 as MediaTime,
		trimStart: 0 as MediaTime,
		trimEnd: 0 as MediaTime,
	};
}
function track(id: string, elements: VideoElement[]) {
	return {
		id,
		name: id,
		type: "video" as const,
		muted: false,
		hidden: false,
		elements,
	};
}
function move(
	elementId: string,
	sourceTrackId: string,
	targetTrackId: string,
	newStartTime = 0,
) {
	return {
		elementId,
		sourceTrackId,
		targetTrackId,
		newStartTime: newStartTime as MediaTime,
	};
}

describe("atomic batch placement", () => {
	test("swaps clips across occupied tracks and undoes in one command", () => {
		tracks = {
			main: track("main", []),
			overlay: [track("a", [video("A")]), track("b", [video("B")])],
			audio: [],
		};
		const before = tracks;
		const command = new MoveElementCommand({
			moves: [move("A", "a", "b"), move("B", "b", "a")],
		});
		command.execute();
		expect(tracks.overlay.map((t) => t.elements.map((e) => e.id))).toEqual([
			["B"],
			["A"],
		]);
		command.undo();
		expect(tracks).toBe(before);
	});

	test("allows a three-track cycle", () => {
		tracks = {
			main: track("main", []),
			overlay: [
				track("a", [video("A")]),
				track("b", [video("B")]),
				track("c", [video("C")]),
			],
			audio: [],
		};
		new MoveElementCommand({
			moves: [move("A", "a", "b"), move("B", "b", "c"), move("C", "c", "a")],
		}).execute();
		expect(tracks.overlay.map((t) => t.elements.map((e) => e.id))).toEqual([
			["C"],
			["A"],
			["B"],
		]);
	});

	test("still rejects a stationary obstacle and overlapping incoming clips atomically", () => {
		tracks = {
			main: track("main", []),
			overlay: [
				track("a", [video("A")]),
				track("b", [video("B")]),
				track("c", [video("C")]),
			],
			audio: [],
		};
		const before = tracks;
		expect(() =>
			new MoveElementCommand({ moves: [move("A", "a", "b")] }).execute(),
		).toThrow(/overlaps/);
		expect(tracks).toBe(before);
		expect(() =>
			new MoveElementCommand({
				moves: [move("A", "a", "c"), move("B", "b", "c"), move("C", "c", "a")],
			}).execute(),
		).toThrow(/overlaps/);
		expect(tracks).toBe(before);
	});

	test("main-track position swaps are independent of input order", () => {
		const updates = [
			{
				trackId: "main",
				elementId: "A",
				patch: { startTime: 2000 as MediaTime },
			},
			{ trackId: "main", elementId: "B", patch: { startTime: 0 as MediaTime } },
		];
		for (const batch of [updates, updates.slice().reverse()]) {
			tracks = {
				main: track("main", [video("A"), video("B", 2000)]),
				overlay: [],
				audio: [],
			};
			const before = tracks;
			const command = new UpdateElementsCommand({ updates: batch });
			command.execute();
			expect(tracks.main.elements.map((e) => [e.id, e.startTime])).toEqual([
				["A", 2000 as MediaTime],
				["B", 0 as MediaTime],
			]);
			command.undo();
			expect(tracks).toBe(before);
		}
	});

	test("single main update at an equal start keeps prior normalization regardless of id order", () => {
		tracks = {
			main: track("main", [video("Z"), video("A", 2000)]),
			overlay: [],
			audio: [],
		};
		new UpdateElementsCommand({
			updates: [
				{
					trackId: "main",
					elementId: "Z",
					patch: { startTime: 2000 as MediaTime },
				},
			],
		}).execute();
		expect(tracks.main.elements[0].startTime).toBe(0 as MediaTime);
		expect(tracks.main.elements[1].startTime).toBe(2000 as MediaTime);
	});

	test("keeps single-element main normalization and rejects final overlap atomically", () => {
		tracks = {
			main: track("main", [video("A"), video("B", 2000)]),
			overlay: [],
			audio: [],
		};
		const before = tracks;
		expect(() =>
			new UpdateElementsCommand({
				updates: [
					{
						trackId: "main",
						elementId: "B",
						patch: { startTime: 1000 as MediaTime },
					},
				],
			}).execute(),
		).toThrow(/overlaps/);
		expect(tracks).toBe(before);
		new UpdateElementsCommand({
			updates: [
				{
					trackId: "main",
					elementId: "A",
					patch: { startTime: 500 as MediaTime },
				},
			],
		}).execute();
		expect(tracks.main.elements[0].startTime).toBe(0 as MediaTime);
	});
});
