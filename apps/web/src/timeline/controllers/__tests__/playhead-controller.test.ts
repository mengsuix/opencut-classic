import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("@/wasm", () => ({
	TICKS_PER_SECOND: 1000,
	mediaTime: ({ ticks }: { ticks: number }) => ticks,
	snapSeekMediaTime: ({ time }: { time: number }) => time,
}));
mock.module("@/timeline/snapping", () => ({
	buildTimelineSnapPoints: () => [],
	getTimelineSnapThresholdInTicks: () => 0,
	resolveTimelineSnap: ({ targetTime }: { targetTime: number }) => ({
		snapPoint: null,
		snappedTime: targetTime,
	}),
}));
mock.module("@/timeline/bookmarks/index", () => ({
	getBookmarkSnapPoints: () => [],
}));
mock.module("@/timeline/element-snap-source", () => ({
	getElementEdgeSnapPoints: () => [],
}));
mock.module("@/timeline/animation-snap-points", () => ({
	getAnimationKeyframeSnapPointsForTimeline: () => [],
}));
mock.module("@/timeline", () => ({
	getCenteredLineLeft: ({ centerPixel }: { centerPixel: number }) => centerPixel,
	timelineTimeToPixels: ({ time }: { time: number }) => time,
	timelineTimeToSnappedPixels: ({ time }: { time: number }) => time,
}));
mock.module("@/timeline/scale", () => ({
	BASE_TIMELINE_PIXELS_PER_SECOND: 100,
	TIMELINE_ZOOM_MIN: 0.1,
	TIMELINE_ZOOM_MAX: 100,
	MAX_TIMELINE_WIDTH_PX: 2_000_000,
}));

const { PlayheadController } = await import(
	"@/timeline/controllers/playhead-controller"
);
const { mediaTime } = await import("@/wasm");
import type { PlayheadConfig } from "@/timeline/controllers/playhead-controller";
import type { MediaTime } from "@/wasm";

type Listener = (event: { clientX: number }) => void;

const listeners = { mousemove: new Set<Listener>(), mouseup: new Set<Listener>() };
const rafCallbacks = new Map<number, FrameRequestCallback>();
const originalDescriptors = new Map<string, PropertyDescriptor | undefined>();
let nextRafId = 1;

function replaceGlobal({ name, value }: { name: string; value: unknown }): void {
	originalDescriptors.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
	Object.defineProperty(globalThis, name, { configurable: true, value });
}

function flushRaf(): void {
	const callbacks = [...rafCallbacks.values()];
	rafCallbacks.clear();
	for (const callback of callbacks) callback(0);
}

function fire({ type, clientX }: { type: keyof typeof listeners; clientX: number }): void {
	for (const listener of listeners[type]) listener({ clientX });
}

function buildController() {
	const seeks: MediaTime[] = [];
	const viewStates: MediaTime[] = [];
	const order: string[] = [];
	const ruler = { getBoundingClientRect: () => ({ left: 0 }) };
	const config: PlayheadConfig = {
		zoomLevel: 1,
		duration: mediaTime({ ticks: 100_000 }),
		getActiveProjectFps: () => ({ numerator: 30, denominator: 1 }),
		isShiftHeld: () => false,
		getIsPlaying: () => false,
		// The controller only needs the ruler's left coordinate in these tests.
		// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
		getRulerEl: () => ruler as HTMLDivElement,
		getRulerScrollEl: () => null,
		getTracksScrollEl: () => null,
		getPlayheadEl: () => null,
		getSceneTracks: () => {
			throw new Error("Snap sources are mocked");
		},
		getSceneBookmarks: () => [],
		seek: (time) => {
			seeks.push(time);
			order.push(`seek:${time}`);
		},
		setScrubbing: (isScrubbing) => order.push(`scrubbing:${isScrubbing}`),
		setTimelineViewState: ({ playheadTime }) => viewStates.push(playheadTime),
	};
	const controller = new PlayheadController({ configRef: { current: config } });
	// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
	controller.onPlayheadMouseDown({
		clientX: 0,
		preventDefault: () => {},
		stopPropagation: () => {},
	} as never);
	return { controller, seeks, viewStates, order };
}

beforeEach(() => {
	listeners.mousemove.clear();
	listeners.mouseup.clear();
	rafCallbacks.clear();
	nextRafId = 1;
	replaceGlobal({
		name: "window",
		value: {
			addEventListener: (type: keyof typeof listeners, listener: Listener) =>
				listeners[type].add(listener),
			removeEventListener: (type: keyof typeof listeners, listener: Listener) =>
				listeners[type].delete(listener),
		},
	});
	replaceGlobal({
		name: "requestAnimationFrame",
		value: (callback: FrameRequestCallback) => {
			const id = nextRafId++;
			rafCallbacks.set(id, callback);
			return id;
		},
	});
	replaceGlobal({
		name: "cancelAnimationFrame",
		value: (id: number) => rafCallbacks.delete(id),
	});
});

afterEach(() => {
	for (const [name, descriptor] of originalDescriptors) {
		if (descriptor) Object.defineProperty(globalThis, name, descriptor);
		else Reflect.deleteProperty(globalThis, name);
	}
	originalDescriptors.clear();
});

describe("PlayheadController scrub scheduling", () => {
	test("coalesces mousemoves to the latest position and skips duplicate times", () => {
		const { controller, seeks } = buildController();
		fire({ type: "mousemove", clientX: 100 });
		fire({ type: "mousemove", clientX: 200 });
		expect(seeks).toEqual([0]);

		flushRaf();
		expect(seeks).toEqual([0, 2000]);

		fire({ type: "mousemove", clientX: 200 });
		flushRaf();
		expect(seeks).toEqual([0, 2000]);
		controller.destroy();
	});

	test("flushes the pending position before ending scrubbing", () => {
		const { controller, seeks, viewStates, order } = buildController();
		fire({ type: "mousemove", clientX: 100 });
		fire({ type: "mouseup", clientX: 100 });

		expect(seeks).toEqual([0, 1000]);
		expect(viewStates).toEqual([1000]);
		expect(order.indexOf("seek:1000")).toBeLessThan(
			order.indexOf("scrubbing:false"),
		);
		expect(rafCallbacks.size).toBe(0);
		controller.destroy();
	});

	test("destroy cancels a pending frame and removes listeners", () => {
		const { controller, seeks } = buildController();
		fire({ type: "mousemove", clientX: 100 });
		controller.destroy();
		flushRaf();

		expect(seeks).toEqual([0]);
		expect(listeners.mousemove.size).toBe(0);
		expect(listeners.mouseup.size).toBe(0);
	});
});
