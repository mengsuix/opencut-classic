import { describe, expect, test } from "bun:test";
import { BaseNode } from "../nodes/base-node";
import { CodeRenderNode } from "../nodes/code-render-node";
import {
	buildTransitionFromParams,
	getCustomTransitionWindow,
} from "@/timeline/transition";

function transition() {
	return new CodeRenderNode({
		mode: "transition",
		code: "function render() {}",
		codeParams: {},
		inputs: [new BaseNode(), new BaseNode()],
		timeOffset: 12233,
		duration: 1000,
		trimStart: 0,
		trimEnd: 0,
		transform: { scaleX: 1, scaleY: 1, rotate: 0, position: { x: 0, y: 0 } },
		opacity: 1,
		inputTimeRanges: [
			{ startTime: 5000, endTime: 12733 },
			{ startTime: 12733, endTime: 18000 },
		],
	});
}

describe("non-destructive code transition", () => {
	test("reads and renders the same centered window as the bridge", () => {
		const config = buildTransitionFromParams({
			params: {
				"transition.type": "custom",
				"transition.code": "function render() {}",
				"transition.duration": 1,
				"transition.layout": "center",
			},
		});
		expect(config.layout).toBe("center");
		expect(
			getCustomTransitionWindow({
				outgoingStartTime: 5000,
				outgoingDuration: 7733,
				duration: 1000,
				layout: config.layout,
			}),
		).toEqual({ startTime: 12233, endTime: 13233 });
	});

	test("holds B's first frame before the cut while A keeps playing", () => {
		const node = transition();
		expect(node.getInputTime({ index: 0, time: 12500 })).toBe(12500);
		expect(node.getInputTime({ index: 1, time: 12500 })).toBe(12733);
	});

	test("holds A's last frame after the cut while B keeps playing", () => {
		const node = transition();
		expect(node.getInputTime({ index: 0, time: 13000 })).toBe(12732);
		expect(node.getInputTime({ index: 1, time: 13000 })).toBe(13000);
	});

	test("never samples A at the first frame of the next shot", () => {
		const node = transition();
		expect(node.getInputTime({ index: 0, time: 12733 })).toBeLessThan(12733);
		expect(node.getInputTime({ index: 1, time: 12733 })).toBe(12733);
	});

	test("restores ordinary timeline sampling at both endpoints and outside", () => {
		const node = transition();
		for (const time of [11000, 12233, 13233, 14000]) {
			expect(node.getInputTime({ index: 0, time })).toBe(time);
			expect(node.getInputTime({ index: 1, time })).toBe(time);
		}
	});
});
