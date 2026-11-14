/* eslint-disable @typescript-eslint/no-unsafe-type-assertion, opencut/prefer-object-params -- The resolver fixture substitutes native Canvas and minimal browser renderer types. */
import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { createCanvas, type Canvas } from "@napi-rs/canvas";
import type { MediaTime } from "@/wasm";
import type { VideoElement } from "@/timeline/types";
import type { CanvasRenderer } from "../canvas-renderer";

mock.module("@/wasm", () => ({
	TICKS_PER_SECOND: 1000,
	ZERO_MEDIA_TIME: 0,
	mediaTime: ({ ticks }: { ticks: number }) => ticks,
	mediaTimeFromSeconds: ({ seconds }: { seconds: number }) => seconds * 1000,
	mediaTimeToSeconds: ({ time }: { time: number }) => {
		if (!Number.isInteger(time))
			throw new Error("WASM MediaTime requires integer ticks");
		return time / 1000;
	},
	roundMediaTime: ({ time }: { time: number }) => Math.round(time),
	addMediaTime: ({ a, b }: { a: number; b: number }) => a + b,
	subMediaTime: ({ a, b }: { a: number; b: number }) => a - b,
	maxMediaTime: ({ a, b }: { a: number; b: number }) => Math.max(a, b),
	minMediaTime: ({ a, b }: { a: number; b: number }) => Math.min(a, b),
}));

const decodedCanvases: Canvas[] = [];
const requests: Array<{ time: number; prefetch: boolean }> = [];
mock.module("@/services/video-cache/service", () => ({
	videoCache: {
		getFrameAt: async ({
			time,
			prefetch,
		}: {
			time: number;
			prefetch: boolean;
		}) => {
			requests.push({ time, prefetch });
			const canvas = createCanvas(80, 40);
			const ctx = canvas.getContext("2d");
			ctx.fillStyle = time < 2 ? "red" : "blue";
			ctx.fillRect(0, 0, 80, 40);
			decodedCanvases.push(canvas);
			return { canvas, timestamp: time, duration: 1 / 30 };
		},
	},
}));

const { buildScene } = await import("../scene-builder");
const { resolveRenderTree } = await import("../resolve");
const { CodeRenderNode } = await import("../nodes/code-render-node");
const { resolveEffectiveAudioGain } = await import("@/timeline/audio-state");
const originalOffscreenCanvas = globalThis.OffscreenCanvas;
beforeAll(() => {
	globalThis.OffscreenCanvas = class {
		constructor(width: number, height: number) {
			return createCanvas(width, height);
		}
	} as unknown as typeof OffscreenCanvas;
});
afterAll(() => {
	globalThis.OffscreenCanvas = originalOffscreenCanvas;
});

function video(id: string, startTime: number): VideoElement {
	return {
		id,
		name: id,
		type: "video",
		mediaId: "source",
		startTime: startTime as MediaTime,
		duration: 2000 as MediaTime,
		trimStart: startTime as MediaTime,
		trimEnd: (4000 - startTime - 2000) as MediaTime,
		sourceDuration: 4000 as MediaTime,
		isSourceAudioEnabled: true,
		params:
			id === "a"
				? {
						"transition.type": "custom",
						"transition.duration": 1,
						"transition.layout": "center",
						"transition.code": "function render() {}",
					}
				: {},
	};
}

function scene({
	gap = 0,
	duration = 1,
	third = false,
	layout = "center",
	rate = 1,
} = {}) {
	const a = video("a", 0);
	a.params["transition.duration"] = duration;
	a.params["transition.layout"] = layout;
	if (rate !== 1) a.retime = { rate };
	const b = video("b", 2000 + gap);
	const elements = [a, b];
	if (third) {
		b.params = { ...a.params };
		elements.push({
			...video("c", 4000),
			sourceDuration: 6000 as MediaTime,
			trimEnd: 0 as MediaTime,
		});
	}
	return buildScene({
		canvasSize: { width: 80, height: 40 },
		duration: third ? 6000 : 4000,
		background: { type: "color", color: "#000000" },
		tracks: {
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
		},
		mediaAssets: [
			{
				id: "source",
				name: "source",
				type: "video",
				file: new File([], "source.mp4"),
				url: "blob:source",
			},
		],
	});
}

function customNode(root: ReturnType<typeof scene>) {
	const node = root.children.find((child) => child instanceof CodeRenderNode);
	if (!(node instanceof CodeRenderNode))
		throw new Error("Missing custom transition node");
	return node;
}

const renderer = { width: 80, height: 40 } as CanvasRenderer;
const pixel = (source: CanvasImageSource) =>
	Array.from(
		(source as OffscreenCanvas).getContext("2d")!.getImageData(0, 0, 1, 1).data,
	);

describe("code transition scene and real resolver", () => {
	test("builds a centered window and keeps original source ranges", () => {
		const node = customNode(scene());
		expect(node.params.timeOffset).toBe(1500);
		expect(node.params.duration).toBe(1000);
		expect(node.params.inputTimeRanges).toEqual([
			{ startTime: 0, endTime: 2000 },
			{ startTime: 2000, endTime: 4000 },
		]);
	});

	test("resolves two different same-source frames before and after the cut", async () => {
		for (const time of [1750, 2250]) {
			requests.length = 0;
			const node = customNode(scene());
			await resolveRenderTree({ node, renderer, time, requestId: Symbol() });
			expect(node.resolved?.progress).toBe((time - 1500) / 1000);
			expect(requests.map((item) => item.time)).toEqual(
				time < 2000 ? [1.75, 2] : [1.999, 2.25],
			);
			expect(requests.every((item) => item.prefetch === false)).toBe(true);
			const a = node.outgoing.resolved as { source: CanvasImageSource };
			const b = node.incoming.resolved as { source: CanvasImageSource };
			expect(pixel(a.source)).toEqual([255, 0, 0, 255]);
			expect(pixel(b.source)).toEqual([0, 0, 255, 255]);
			for (const canvas of decodedCanvases) {
				const ctx = canvas.getContext("2d");
				ctx.fillStyle = "green";
				ctx.fillRect(0, 0, 80, 40);
			}
			expect(pixel(a.source)).toEqual([255, 0, 0, 255]);
			expect(pixel(b.source)).toEqual([0, 0, 255, 255]);
		}
	});

	test("does not wrap a non-adjacent cut or an inactive transition", () => {
		expect(
			scene({ gap: 1000 }).children.some(
				(node) => node instanceof CodeRenderNode,
			),
		).toBe(false);
		expect(
			scene({ duration: 0 }).children.some(
				(node) => node instanceof CodeRenderNode,
			),
		).toBe(false);
	});

	test("slow source holds retain sub-tick precision without calling integer-only WASM", async () => {
		requests.length = 0;
		const node = customNode(scene({ rate: 0.5 }));
		await resolveRenderTree({
			node,
			renderer,
			time: 2250,
			requestId: Symbol(),
		});
		expect(requests[0].time).toBe(0.9995);
		expect(requests[0].time).toBeLessThan(1);
	});

	test("cut layout restores the original gap instead of reading earlier B handles", async () => {
		const node = customNode(scene({ gap: 20, layout: "cut" }));
		requests.length = 0;
		await resolveRenderTree({
			node,
			renderer,
			time: 1999,
			requestId: Symbol(),
		});
		expect(requests.map((item) => item.time)).toEqual([1.999, 2.02]);
		requests.length = 0;
		await resolveRenderTree({
			node,
			renderer,
			time: 2000,
			requestId: Symbol(),
		});
		expect(node.incoming.resolved).toBeNull();
		expect(requests).toHaveLength(0);
		await resolveRenderTree({
			node,
			renderer,
			time: 2020,
			requestId: Symbol(),
		});
		expect(requests.map((item) => item.time)).toEqual([2.02]);
	});

	test("does not alter source audio gain during the transition", () => {
		const element = video("a", 0);
		for (const localTime of [0, 1.5, 1.75, 1.999]) {
			expect(resolveEffectiveAudioGain({ element, localTime })).toBe(
				resolveEffectiveAudioGain({
					element: { ...element, params: {} },
					localTime,
				}),
			);
		}
	});

	test("keeps both custom transitions in a three-clip chain", () => {
		const node = customNode(scene({ third: true }));
		expect(node.incoming).toBeInstanceOf(CodeRenderNode);
		expect(
			(node.incoming as InstanceType<typeof CodeRenderNode>).params.timeOffset,
		).toBe(3500);
	});
});
