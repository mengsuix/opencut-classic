/* eslint-disable @typescript-eslint/no-unsafe-type-assertion, opencut/prefer-object-params -- Isolated MCP fixtures supply only the editor surface used by each handler. */
import { describe, expect, mock, test } from "bun:test";
import type { EditorCore } from "@/core";
import type { SceneTracks, VideoElement } from "@/timeline/types";
import type { MediaTime } from "@/wasm";

mock.module("@/services/renderer/compositor/wasm-compositor", () => ({
	wasmCompositor: {},
}));
mock.module("opencut-wasm", () => ({ formatTimecode: () => "" }));
mock.module("@/editor/ai/reference-snapshot", () => ({
	describeSelectedElements: () => [],
}));
let currentEditor: EditorCore;
mock.module("@/core", () => ({
	EditorCore: { getInstance: () => currentEditor },
}));
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
	clampMediaTime: ({
		time,
		min,
		max,
	}: {
		time: number;
		min: number;
		max: number;
	}) => Math.min(max, Math.max(min, time)),
	roundFrameTime: ({ time }: { time: number }) => time,
	roundFrameTicks: ({ ticks }: { ticks: number }) => ticks,
	snapSeekMediaTime: ({ time }: { time: number }) => time,
	lastFrameMediaTime: ({ duration }: { duration: number }) => duration - 1,
	parseMediaTimecode: () => null,
}));
const { BRIDGE_COMMANDS } = await import("../registry");
const { registerDefaultMasks } = await import("@/masks");
const { UpsertKeyframeCommand } =
	await import("@/commands/timeline/element/keyframes/upsert-keyframe");
const { ReplaceRangeCommand } =
	await import("@/commands/timeline/element/replace-range");
const { resolveMaskParamsAtTime } =
	await import("@/animation/mask-param-channel");
const { coerceParamValue, getParamNumericRange } = await import("@/params");
import type { Command } from "@/commands/base-command";
registerDefaultMasks();

function video(id: string, startTime = 5000): VideoElement {
	return {
		id,
		name: id,
		type: "video",
		mediaId: "source",
		params: {},
		startTime: startTime as MediaTime,
		duration: 2000 as MediaTime,
		trimStart: (startTime - 5000) as MediaTime,
		trimEnd: 0 as MediaTime,
	};
}
function fixture(elements: VideoElement[]) {
	const tracks: SceneTracks = {
		main: {
			id: "main",
			name: "main",
			type: "video",
			muted: false,
			hidden: false,
			elements,
		},
		overlay: [],
		audio: [],
	};
	const scene = { id: "scene", tracks };
	const writes = mock(
		({
			updates,
		}: {
			updates: Array<{ elementId: string; patch: Partial<VideoElement> }>;
		}) => {
			for (const update of updates) {
				const index = tracks.main.elements.findIndex(
					(e) => e.id === update.elementId,
				);
				const element = tracks.main.elements[index];
				tracks.main.elements[index] = {
					...element,
					...update.patch,
					params: { ...element.params, ...update.patch.params },
				};
			}
		},
	);
	const curves = mock(() => {});
	const execute = mock(({ command }: { command: Command }) =>
		command.execute(),
	);
	const upsert = mock(
		({
			keyframes,
		}: {
			keyframes: ConstructorParameters<typeof UpsertKeyframeCommand>[0][];
		}) => {
			for (const keyframe of keyframes)
				new UpsertKeyframeCommand(keyframe).execute();
		},
	);
	const project = {
		metadata: { id: "test", name: "test" },
		settings: { canvasSize: { width: 1280, height: 720 }, fps: 30 },
	};
	const editor = {
		scenes: {
			getActiveSceneOrNull: () => scene,
			getActiveScene: () => scene,
			getScenes: () => [scene],
		},
		project: { getActiveOrNull: () => project },
		timeline: {
			updateElements: writes,
			getTotalDuration: () => 9000,
			updateTracks: (next: SceneTracks) => {
				scene.tracks = next;
			},
			upsertKeyframes: upsert,
			updateKeyframeCurves: curves,
		},
		playback: {
			getCurrentTime: () => 0,
			getIsPlaying: () => false,
			getVolume: () => 1,
			isMuted: () => false,
		},
		selection: {
			getActiveSelectionKind: () => null,
			getSelectedElements: () => [],
			getSelectedKeyframes: () => [],
			getSelectedMaskPointSelection: () => null,
		},
		command: { canUndo: () => false, canRedo: () => false, execute },
		media: {
			getAssets: () => [
				{
					id: "source",
					name: "source",
					type: "video",
					duration: 100,
					width: 1280,
					height: 720,
				},
			],
		},
	} as unknown as EditorCore;
	currentEditor = editor;
	const run = (command: string, args: Record<string, unknown> = {}) =>
		BRIDGE_COMMANDS[command].run({ editor, args });
	return { tracks, writes, curves, run, editor, upsert, execute };
}

describe("MCP method contracts", () => {
	test("rejects a second mask before writing state", () => {
		const { tracks, writes, run } = fixture([video("a")]);
		const args = { trackId: "main", elementId: "a", maskType: "rectangle" };
		run("masks.add", args);
		expect(writes).toHaveBeenCalledTimes(1);
		expect(() => run("masks.add", args)).toThrow(/Only one mask/);
		expect(writes).toHaveBeenCalledTimes(1);
		expect(tracks.main.elements[0].masks).toHaveLength(1);
	});

	test("lists mask ranges in raw storage units, not UI percent", () => {
		const { run } = fixture([]);
		const result = run("masks.list") as {
			masks: Array<{
				type: string;
				params: Array<{
					key: string;
					max?: number;
					min?: number;
					displayMultiplier?: number;
				}>;
			}>;
		};
		const params = result.masks.find(
			(mask) => mask.type === "rectangle",
		)!.params;
		const centerX = params.find((param) => param.key === "centerX")!;
		expect(centerX.max).toBe(1);
		expect(centerX.min).toBe(-1);
		expect(centerX.displayMultiplier).toBeUndefined();
	});

	test("returns curve handles in seconds and round-trips their offsets", () => {
		const element = video("a");
		const key = {
			id: "key",
			time: 1000 as MediaTime,
			value: 0.5,
			segmentToNext: "bezier" as const,
			tangentMode: "broken" as const,
			leftHandle: { dt: -250 as MediaTime, dv: -0.1 },
			rightHandle: { dt: 500 as MediaTime, dv: 0.2 },
		};
		element.animations = {
			opacity: { keys: [key] },
			"effects.color.params.tint": { r: { keys: [key] } },
		};
		const { run, curves } = fixture([element]);
		type SerializedKey = {
			time: number;
			leftHandle: { dt: number; dv: number };
			rightHandle: { dt: number; dv: number };
		};
		const state = run("state.get") as {
			tracks: {
				main: {
					elements: Array<{
						animations: {
							opacity: { keys: SerializedKey[] };
							"effects.color.params.tint": { r: { keys: SerializedKey[] } };
						};
					}>;
				};
			};
		};
		const animations = state.tracks.main.elements[0].animations;
		const serialized = animations.opacity.keys[0];
		expect(serialized.time).toBe(6);
		expect(serialized.leftHandle).toEqual({ dt: -0.25, dv: -0.1 });
		expect(serialized.rightHandle).toEqual({ dt: 0.5, dv: 0.2 });
		expect(
			animations["effects.color.params.tint"].r.keys[0].leftHandle.dt,
		).toBe(-0.25);
		run("keyframes.update_curves", {
			keyframes: [
				{
					trackId: "main",
					elementId: "a",
					propertyPath: "opacity",
					componentKey: "value",
					keyframeId: "key",
					patch: {
						leftHandle: serialized.leftHandle,
						rightHandle: serialized.rightHandle,
					},
				},
			],
		});
		const written = (
			curves.mock.calls as unknown as Array<
				[{ keyframes: Array<{ patch: unknown }> }]
			>
		)[0][0].keyframes[0].patch;
		expect(written).toEqual({
			leftHandle: key.leftHandle,
			rightHandle: key.rightHandle,
		});
	});

	test("real code_render handler centers a same-source cut without moving clips", () => {
		const { tracks, writes, run } = fixture([
			video("a"),
			video("b", 7000),
			video("c", 9000),
		]);
		const before = tracks.main.elements.map((e) => [
			e.startTime,
			e.duration,
			e.trimStart,
			e.trimEnd,
		]);
		const result = run("code_render.apply", {
			mode: "transition",
			trackId: "main",
			elementId: "a",
			duration: 1,
			code: "function render(ctx, frame) {}",
		}) as { layout: string; startTime: number; endTime: number };
		expect(result).toMatchObject({
			layout: "center",
			startTime: 6.5,
			endTime: 7.5,
		});
		expect(
			tracks.main.elements.map((e) => [
				e.startTime,
				e.duration,
				e.trimStart,
				e.trimEnd,
			]),
		).toEqual(before);
		expect(writes).toHaveBeenCalledTimes(1);
		expect(tracks.main.elements[0].params["transition.layout"]).toBe("center");
	});

	test("mask keyframes preserve stored fractions through the real command and resolver", () => {
		const { run, editor, upsert } = fixture([video("a")]);
		const { maskId } = run("masks.add", {
			trackId: "main",
			elementId: "a",
			maskType: "rectangle",
		}) as { maskId: string };
		const propertyPath = `masks.${maskId}.params.width`;
		run("keyframes.upsert", {
			keyframes: [
				{
					trackId: "main",
					elementId: "a",
					propertyPath,
					time: 5,
					value: 0.2,
					interpolation: "linear",
				},
				{
					trackId: "main",
					elementId: "a",
					propertyPath,
					time: 7,
					value: 0.8,
					interpolation: "linear",
				},
			],
		});
		expect(upsert).toHaveBeenCalledTimes(1);
		const element = editor.scenes.getActiveScene().tracks.main.elements[0];
		const mask = element.masks![0];
		if (mask.type !== "rectangle") throw new Error("Unexpected mask type");
		for (const [localTime, width] of [
			[0, 0.2],
			[1000, 0.5],
			[2000, 0.8],
		]) {
			expect(
				resolveMaskParamsAtTime({
					maskId,
					params: mask.params,
					animations: element.animations,
					localTime,
				}).width,
			).toBeCloseTo(width);
		}
	});

	test("percent ranges are storage-space and ordinary numeric params are unchanged", () => {
		const param = {
			key: "x",
			label: "X",
			type: "number" as const,
			default: 0,
			min: -100,
			max: 100,
			step: 1,
			displayMultiplier: 100,
		};
		expect(getParamNumericRange({ param })).toEqual({
			min: -1,
			max: 1,
			step: 0.01,
		});
		expect(coerceParamValue({ param, value: -0.495 })).toBeLessThan(-0.48);
		expect(coerceParamValue({ param, value: 0.8 })).toBeCloseTo(0.8);
		expect(
			coerceParamValue({ param: { ...param, displayMultiplier: 1 }, value: 8 }),
		).toBe(8);
		expect(coerceParamValue({ param, value: Infinity })).toBeNull();
	});

	test("invalid keyframe paths and values reject the whole batch before writes", () => {
		for (const invalid of [
			{ propertyPath: "masks.missing.params.width", value: 0.5 },
			{ propertyPath: "opacity", value: "bad" },
			{ propertyPath: "opacity", value: Infinity },
			{ propertyPath: "transform.positionX", value: null },
		]) {
			const { run, upsert, editor } = fixture([video("a")]);
			const before = editor.scenes.getActiveScene().tracks;
			const key = {
				trackId: "main",
				elementId: "a",
				time: 5,
				propertyPath: "opacity",
				value: 0.5,
			};
			expect(() =>
				run("keyframes.upsert", { keyframes: [key, { ...key, ...invalid }] }),
			).toThrow();
			expect(upsert).not.toHaveBeenCalled();
			expect(editor.scenes.getActiveScene().tracks).toBe(before);
		}
	});

	test("identity patches reject before mutation and sourceDuration is written in seconds", () => {
		const { run, writes, tracks } = fixture([video("a")]);
		for (const patch of [{ id: "new" }, { type: "image" }]) {
			expect(() =>
				run("timeline.update_elements", {
					updates: [{ trackId: "main", elementId: "a", patch }],
				}),
			).toThrow(/Unknown element patch/);
		}
		expect(writes).not.toHaveBeenCalled();
		run("timeline.update_elements", {
			updates: [
				{ trackId: "main", elementId: "a", patch: { sourceDuration: 10 } },
			],
		});
		expect(tracks.main.elements[0].sourceDuration).toBe(10000 as MediaTime);
	});

	test("replacement source duration never inherits the previous asset and undo restores it", () => {
		for (const sourceDuration of [1000 as MediaTime, undefined]) {
			const original = {
				...video("a"),
				sourceDuration: 100000 as MediaTime,
				trimEnd: 98000 as MediaTime,
			};
			const { editor } = fixture([original]);
			const before = editor.scenes.getActiveScene().tracks;
			const command = new ReplaceRangeCommand({
				trackId: "main",
				elementId: "a",
				rangeStart: 5500 as MediaTime,
				rangeEnd: 6500 as MediaTime,
				mediaId: "replacement",
				sourceDuration,
			});
			command.execute();
			const inserted = editor.scenes
				.getActiveScene()
				.tracks.main.elements.find(
					(e) => e.id === command.getInsertedElement()!.elementId,
				)!;
			expect(inserted).toMatchObject({
				sourceDuration,
				trimStart: 0,
				trimEnd: 0,
				duration: 1000,
			});
			command.undo();
			expect(editor.scenes.getActiveScene().tracks).toBe(before);
		}
	});

	test("spotlight inserts a muted same-time top layer with one undo", () => {
		const { run, editor, execute } = fixture([video("a")]);
		editor.playback.getCurrentTime = () => 6000 as MediaTime;
		const before = editor.scenes.getActiveScene().tracks;
		const result = run("attention.spotlight", {
			trackId: "main",
			elementId: "a",
			zoom: 2,
		}) as { spotlight: { trackId: string; elementId: string } };
		const top = editor.scenes.getActiveScene().tracks.overlay[0];
		expect(top.id).toBe(result.spotlight.trackId);
		expect(top.elements[0]).toMatchObject({
			id: result.spotlight.elementId,
			startTime: 5000,
			duration: 2000,
			params: { muted: true, "transform.scaleX": 2 },
		});
		const copy = top.elements[0];
		if (copy.type !== "video") throw new Error("Expected video spotlight");
		expect(copy.masks).toHaveLength(1);
		expect(execute).toHaveBeenCalledTimes(1);
		execute.mock.calls[0][0].command.undo();
		expect(editor.scenes.getActiveScene().tracks).toBe(before);
	});

	test("fractional-tick transition windows report the exact renderer times", () => {
		const { run } = fixture([video("a"), video("b", 7000)]);
		const result = run("code_render.apply", {
			mode: "transition",
			trackId: "main",
			elementId: "a",
			duration: 0.1234567,
			code: "function render() {}",
		}) as { startTime: number; endTime: number };
		expect(result.startTime).toBeCloseTo(7 - 0.1234567 / 2, 10);
		expect(result.endTime).toBeCloseTo(7 + 0.1234567 / 2, 10);
	});

	test("live HTML contract points Canvas2D to code_render", () => {
		expect(BRIDGE_COMMANDS["timeline.add_html"].description).toContain(
			"use code_render for live Canvas2D",
		);
	});
});
