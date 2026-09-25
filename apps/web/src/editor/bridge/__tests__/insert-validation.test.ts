import { describe, expect, mock, spyOn, test } from "bun:test";

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

const { normalizeGraphicElementInput, coerceAutoPlacement } =
	await import("../insert-validation");
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

	test("fails silently with a null track id when an html element targets a video track", () => {
		// 复现：agent 把 HTML 特效显式放到视频轨道上，命令层 console.error
		// 后静默返回。bridge 层依赖 getTrackId()===null 识别失败，不能依赖
		// 选区（失败时选区可能残留旧元素）。
		const errorSpy = spyOn(console, "error").mockImplementation(() => {});
		const command = new InsertElementCommand({
			element: {
				type: "html",
				name: "HTML 特效",
				html: "<div data-width=\"100\" data-height=\"50\"></div>",
				intrinsicWidth: 100,
				intrinsicHeight: 50,
				startTime: 0,
				duration: 1000,
				trimStart: 0,
				trimEnd: 0,
				params: {},
			} as never,
			placement: { mode: "explicit", trackId: "main" },
		});

		expect(command.execute()).toBeUndefined();
		expect(command.getTrackId()).toBeNull();
		expect(fakeEditor.timeline.updateTracks).not.toHaveBeenCalled();
		errorSpy.mockRestore();
	});

	test("auto placement succeeds and reports a track id", () => {
		const command = new InsertElementCommand({
			element: {
				type: "text",
				name: "Text",
				startTime: 0,
				duration: 1000,
				trimStart: 0,
				trimEnd: 0,
				params: { content: "hello" },
			} as never,
			placement: { mode: "auto" },
		});

		expect(command.execute()).toBeDefined();
		expect(command.getTrackId()).not.toBeNull();
	});
});

describe("coerceAutoPlacement", () => {
	test("drops an incompatible auto trackType (graphic on video)", () => {
		const result = coerceAutoPlacement({
			elementType: "graphic",
			placement: { mode: "auto", trackType: "video" },
		});

		expect(result).toEqual({ mode: "auto" });
	});

	test("keeps a compatible auto trackType (graphic on graphic)", () => {
		const placement = { mode: "auto", trackType: "graphic" as const };
		expect(
			coerceAutoPlacement({ elementType: "graphic", placement }),
		).toEqual(placement);
	});

	test("keeps auto placement without trackType", () => {
		const placement = { mode: "auto" as const };
		expect(coerceAutoPlacement({ elementType: "text", placement })).toEqual(
			placement,
		);
	});

	test("never touches explicit placement", () => {
		const placement = { mode: "explicit" as const, trackId: "video-track" };
		expect(
			coerceAutoPlacement({ elementType: "graphic", placement }),
		).toEqual(placement);
	});
});
