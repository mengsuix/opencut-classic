import { describe, expect, test } from "bun:test";
import { canvasRectToMaskParams } from "../canvas-rect";
import {
	getBoxLikeGeometry,
	getDefaultBaseMaskParams,
	rotatePoint,
} from "../builtin/box-like";
import type { ElementBounds } from "@/preview/element-bounds";

const CANVAS = { width: 1920, height: 1080 };

/** Mirrors drawTransformedCanvas: element-local pixel -> canvas pixel. */
function localToCanvas(
	px: number,
	py: number,
	bounds: ElementBounds,
): { x: number; y: number } {
	const w = Math.abs(bounds.width);
	const h = Math.abs(bounds.height);
	const x = bounds.cx - w / 2 + px;
	const y = bounds.cy - h / 2 + py;
	const r = (bounds.rotation * Math.PI) / 180;
	return {
		x: bounds.cx + (x - bounds.cx) * Math.cos(r) - (y - bounds.cy) * Math.sin(r),
		y: bounds.cy + (x - bounds.cx) * Math.sin(r) + (y - bounds.cy) * Math.cos(r),
	};
}

/**
 * Render-pipeline closed loop: mask params -> buildPath geometry
 * (getBoxLikeGeometry) -> mask self-rotation (rotatePoint) -> element
 * transform (localToCanvas). Returns the mask rect's canvas corners in
 * TL, TR, BR, BL order.
 */
function maskCanvasCorners(
	params: ReturnType<typeof canvasRectToMaskParams>,
	bounds: ElementBounds,
): { x: number; y: number }[] {
	const w = Math.abs(bounds.width);
	const h = Math.abs(bounds.height);
	const geo = getBoxLikeGeometry({
		params: { ...getDefaultBaseMaskParams(), scale: 1, ...params },
		width: w,
		height: h,
	});
	const corners = [
		{ x: geo.centerX - geo.maskWidth / 2, y: geo.centerY - geo.maskHeight / 2 },
		{ x: geo.centerX + geo.maskWidth / 2, y: geo.centerY - geo.maskHeight / 2 },
		{ x: geo.centerX + geo.maskWidth / 2, y: geo.centerY + geo.maskHeight / 2 },
		{ x: geo.centerX - geo.maskWidth / 2, y: geo.centerY + geo.maskHeight / 2 },
	];
	return corners.map((c) => {
		const rotated = rotatePoint({
			x: c.x,
			y: c.y,
			centerX: geo.centerX,
			centerY: geo.centerY,
			rotationRad: geo.rotationRad,
		});
		return localToCanvas(rotated.x, rotated.y, bounds);
	});
}

function expectRectMatch(
	rect: { left: number; top: number; right: number; bottom: number },
	bounds: ElementBounds,
) {
	const params = canvasRectToMaskParams({ rect, bounds, canvasSize: CANVAS });
	const corners = maskCanvasCorners(params, bounds);
	const expected = [
		{ x: rect.left * CANVAS.width, y: rect.top * CANVAS.height },
		{ x: rect.right * CANVAS.width, y: rect.top * CANVAS.height },
		{ x: rect.right * CANVAS.width, y: rect.bottom * CANVAS.height },
		{ x: rect.left * CANVAS.width, y: rect.bottom * CANVAS.height },
	];
	corners.forEach((corner, i) => {
		expect(corner.x).toBeCloseTo(expected[i].x, 6);
		expect(corner.y).toBeCloseTo(expected[i].y, 6);
	});
	return params;
}

describe("canvasRectToMaskParams", () => {
	test("fullscreen video, no transform: params and closed loop", () => {
		const bounds: ElementBounds = {
			cx: 960,
			cy: 540,
			width: 1920,
			height: 1080,
			rotation: 0,
		};
		const params = expectRectMatch(
			{ left: 0.9, top: 0.05, right: 1.0, bottom: 0.15 },
			bounds,
		);
		expect(params.centerX).toBeCloseTo(0.45, 6);
		expect(params.centerY).toBeCloseTo(-0.4, 6);
		expect(params.width).toBeCloseTo(0.1, 6);
		expect(params.height).toBeCloseTo(0.1, 6);
		expect(params.rotation).toBe(0);
	});

	test("scaled and offset element", () => {
		const bounds: ElementBounds = {
			cx: 1160,
			cy: 440,
			width: 960,
			height: 540,
			rotation: 0,
		};
		expectRectMatch({ left: 0.5, top: 0.25, right: 0.75, bottom: 0.5 }, bounds);
	});

	test("rotated element stays axis-aligned on canvas", () => {
		const bounds: ElementBounds = {
			cx: 960,
			cy: 540,
			width: 1920,
			height: 1080,
			rotation: 30,
		};
		const params = expectRectMatch(
			{ left: 0.8, top: 0.02, right: 0.98, bottom: 0.12 },
			bounds,
		);
		expect(params.rotation).toBeCloseTo(330, 6);
	});

	test("rotated + scaled + offset element", () => {
		const bounds: ElementBounds = {
			cx: 700,
			cy: 600,
			width: 800,
			height: 450,
			rotation: -15,
		};
		const params = expectRectMatch(
			{ left: 0.3, top: 0.4, right: 0.6, bottom: 0.7 },
			bounds,
		);
		expect(params.rotation).toBeCloseTo(15, 6);
	});

	test("zero-size element throws", () => {
		const bounds: ElementBounds = {
			cx: 960,
			cy: 540,
			width: 0,
			height: 1080,
			rotation: 0,
		};
		expect(() =>
			canvasRectToMaskParams({
				rect: { left: 0.1, top: 0.1, right: 0.2, bottom: 0.2 },
				bounds,
				canvasSize: CANVAS,
			}),
		).toThrow("zero size");
	});
});
