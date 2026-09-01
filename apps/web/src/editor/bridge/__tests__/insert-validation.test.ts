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

const fakeEditor = {
	scenes: {
		getActiveScene: () => ({
			tracks: {
				overlay: [],
				main: { id: "main", type: "video", elements: [] },
				audio: [],
			},
		}),
	},
	timeline: { updateTracks: mock() },
	media: { getAssets: () => [] },
	project: { getActiveOrNull: () => null, updateSettings: mock() },
};

mock.module("@/core", () => ({
	EditorCore: { getInstance: () => fakeEditor },
}));

const { normalizeGraphicElementInput } = await import("../insert-validation");
const { InsertElementCommand } =
	await import("@/commands/timeline/element/insert-element");

describe("normalizeGraphicElementInput", () => {
	test("rejects a graphic without definitionId", () => {
		expect(() =>
			normalizeGraphicElementInput({ type: "graphic", duration: 5 }),
		).toThrow(/element\.definitionId/);
	});

	test("rejects an unknown graphic definitionId", () => {
		expect(() =>
			normalizeGraphicElementInput({
				type: "graphic",
				definitionId: "circle",
			}),
		).toThrow(/rectangle, ellipse, polygon, star/);
	});

	test("fills defaults for a valid graphic", () => {
		const element = normalizeGraphicElementInput({
			type: "graphic",
			definitionId: "rectangle",
		});

		expect(element).toMatchObject({
			type: "graphic",
			definitionId: "rectangle",
		});
		expect(element.params).toMatchObject({
			"transform.positionX": 0,
			"transform.positionY": 0,
		});
	});
});

describe("InsertElementCommand", () => {
	test("rejects a stale explicit track ID without mutating the timeline", () => {
		const command = new InsertElementCommand({
			element: {
				type: "text",
				name: "Text",
				startTime: 0,
				duration: 1,
				trimStart: 0,
				trimEnd: 0,
				params: { content: "hello" },
			} as never,
			placement: { mode: "explicit", trackId: "stale-track" },
		});

		expect(() => command.execute()).toThrow("Track not found: stale-track");
		expect(fakeEditor.timeline.updateTracks).not.toHaveBeenCalled();
	});
});
