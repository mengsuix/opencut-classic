import { describe, expect, mock, test } from "bun:test";

// `bun test` cannot load the wasm bundle, so the pure integer-tick helpers are
// mocked. The mock must be registered before the dynamic import below —
// mock.module is not hoisted ahead of static imports for aliased specifiers.
mock.module("@/wasm", () => ({
	TICKS_PER_SECOND: 1000,
	ZERO_MEDIA_TIME: 0,
}));

const { ZoomController } = await import(
	"@/timeline/controllers/zoom-controller"
);
const { ZERO_MEDIA_TIME } = await import("@/wasm");

import type { ZoomConfig } from "@/timeline/controllers/zoom-controller";

const MIN_ZOOM = 0.5;
const MAX_ZOOM = 8;

function buildController({ initialZoom }: { initialZoom?: number } = {}) {
	const config: ZoomConfig = {
		minZoom: MIN_ZOOM,
		maxZoom: MAX_ZOOM,
		getContainerEl: () => null,
		getTracksScrollEl: () => null,
		getRulerScrollEl: () => null,
		getCurrentPlayheadTime: () => ZERO_MEDIA_TIME,
		seek: () => {},
		setTimelineViewState: () => {},
	};

	return new ZoomController({ configRef: { current: config }, initialZoom });
}

describe("ZoomController", () => {
	test("falls back to the fit zoom when the persisted zoom is not a number", () => {
		const controller = buildController({ initialZoom: Number.NaN });

		expect(controller.zoomLevel).toBe(MIN_ZOOM);
	});

	test("never adopts a corrupted zoom restored after mount", () => {
		const controller = buildController();

		controller.reconcileInitialAndMinZoom({
			minZoom: MIN_ZOOM,
			maxZoom: MAX_ZOOM,
			initialZoom: Number.NaN,
		});

		expect(Number.isFinite(controller.zoomLevel)).toBe(true);
		expect(controller.zoomLevel).toBe(MIN_ZOOM);
	});

	test("keeps the current zoom when an update is not a number", () => {
		const controller = buildController({ initialZoom: 2 });

		controller.setZoomLevel(Number.NaN);
		expect(controller.zoomLevel).toBe(2);

		controller.setZoomLevel(4);
		expect(controller.zoomLevel).toBe(4);
	});
});
