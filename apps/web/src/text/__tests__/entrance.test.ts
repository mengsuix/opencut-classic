/* eslint-disable @typescript-eslint/no-unsafe-type-assertion -- fixtures build TextElement via assertions because only .params is read */
import { describe, expect, test } from "bun:test";
import type { TextElement } from "@/timeline";
import {
	buildTextCharStateAt,
	buildTextEntranceFromElement,
	buildTextLoopFromElement,
	countTextChars,
	getTextCharProgress,
	isPerCharEntranceType,
	resolveTextCharAnim,
	resolveTextEntranceAtTime,
	resolveTextLoopAtTime,
	TEXT_SHAKE_AMPLITUDE,
	truncateTextContent,
} from "../entrance";

function buildElement({
	params,
}: {
	params: TextElement["params"];
}): TextElement {
	return { params } as TextElement;
}

describe("buildTextEntranceFromElement", () => {
	test("defaults to none when params are missing", () => {
		const config = buildTextEntranceFromElement({
			element: buildElement({ params: {} }),
		});
		expect(config).toEqual({ type: "none", duration: 0.5 });
	});

	test("falls back to none for unknown type values", () => {
		const config = buildTextEntranceFromElement({
			element: buildElement({
				params: { "animIn.type": "spiral", "animIn.duration": 2 },
			}),
		});
		expect(config).toEqual({ type: "none", duration: 2 });
	});

	test("reads configured type and duration", () => {
		const config = buildTextEntranceFromElement({
			element: buildElement({
				params: { "animIn.type": "typewriter", "animIn.duration": 1.5 },
			}),
		});
		expect(config).toEqual({ type: "typewriter", duration: 1.5 });
	});
});

describe("resolveTextEntranceAtTime", () => {
	test("none and non-positive duration stay idle", () => {
		const idle = {
			opacityFactor: 1,
			scaleFactor: 1,
			visibleRatio: null,
		};
		expect(
			resolveTextEntranceAtTime({
				config: { type: "none", duration: 1 },
				localTime: 0.2,
			}),
		).toEqual(idle);
		expect(
			resolveTextEntranceAtTime({
				config: { type: "fade", duration: 0 },
				localTime: 0.2,
			}),
		).toEqual(idle);
	});

	test("fade ramps opacity linearly and clamps at both ends", () => {
		const config = { type: "fade" as const, duration: 1 };
		expect(
			resolveTextEntranceAtTime({ config, localTime: 0 }).opacityFactor,
		).toBe(0);
		expect(
			resolveTextEntranceAtTime({ config, localTime: 0.5 }).opacityFactor,
		).toBe(0.5);
		expect(
			resolveTextEntranceAtTime({ config, localTime: 2 }).opacityFactor,
		).toBe(1);
	});

	test("pop starts at near-zero scale and settles at 1", () => {
		const config = { type: "pop" as const, duration: 0.5 };
		expect(
			resolveTextEntranceAtTime({ config, localTime: 0 }).scaleFactor,
		).toBeCloseTo(0.0001, 3);
		expect(
			resolveTextEntranceAtTime({ config, localTime: 1 }).scaleFactor,
		).toBe(1);
	});

	test("typewriter reports visible ratio without touching opacity or scale", () => {
		const config = { type: "typewriter" as const, duration: 2 };
		const state = resolveTextEntranceAtTime({ config, localTime: 1 });
		expect(state.visibleRatio).toBe(0.5);
		expect(state.opacityFactor).toBe(1);
		expect(state.scaleFactor).toBe(1);
	});
});

describe("exit animation (phase=out)", () => {
	test("reads animOut params", () => {
		const config = buildTextEntranceFromElement({
			element: buildElement({
				params: { "animOut.type": "fade", "animOut.duration": 2 },
			}),
			phase: "out",
		});
		expect(config).toEqual({ type: "fade", duration: 2 });
	});

	test("fade ramps opacity down over the last duration seconds", () => {
		const config = { type: "fade" as const, duration: 1 };
		expect(
			resolveTextEntranceAtTime({
				config,
				localTime: 0,
				phase: "out",
				elementDuration: 4,
			}).opacityFactor,
		).toBe(1);
		expect(
			resolveTextEntranceAtTime({
				config,
				localTime: 3.5,
				phase: "out",
				elementDuration: 4,
			}).opacityFactor,
		).toBe(0.5);
		expect(
			resolveTextEntranceAtTime({
				config,
				localTime: 4,
				phase: "out",
				elementDuration: 4,
			}).opacityFactor,
		).toBe(0);
	});

	test("typewriter shrinks the visible ratio", () => {
		const config = { type: "typewriter" as const, duration: 2 };
		expect(
			resolveTextEntranceAtTime({
				config,
				localTime: 3,
				phase: "out",
				elementDuration: 4,
			}).visibleRatio,
		).toBe(0.5);
	});

	test("out phase without elementDuration stays idle", () => {
		expect(
			resolveTextEntranceAtTime({
				config: { type: "fade", duration: 1 },
				localTime: 3,
				phase: "out",
			}),
		).toEqual({ opacityFactor: 1, scaleFactor: 1, visibleRatio: null });
	});
});

describe("loop animation", () => {
	test("reads animLoop params and falls back to none", () => {
		expect(
			buildTextLoopFromElement({
				element: buildElement({
					params: { "animLoop.type": "shake", "animLoop.duration": 2 },
				}),
			}),
		).toEqual({ type: "shake", duration: 2 });
		expect(
			buildTextLoopFromElement({
				element: buildElement({ params: { "animLoop.type": "spin" } }),
			}),
		).toEqual({ type: "none", duration: 1 });
	});

	test("pulse oscillates scale around 1", () => {
		const config = { type: "pulse" as const, duration: 1 };
		expect(resolveTextLoopAtTime({ config, localTime: 0 }).scaleFactor).toBe(1);
		expect(
			resolveTextLoopAtTime({ config, localTime: 0.25 }).scaleFactor,
		).toBeCloseTo(1.05, 5);
		expect(
			resolveTextLoopAtTime({ config, localTime: 0.75 }).scaleFactor,
		).toBeCloseTo(0.95, 5);
	});

	test("blink oscillates opacity within [0.3, 1]", () => {
		const config = { type: "blink" as const, duration: 2 };
		expect(
			resolveTextLoopAtTime({ config, localTime: 0.5 }).opacityFactor,
		).toBeCloseTo(1, 5);
		expect(
			resolveTextLoopAtTime({ config, localTime: 1.5 }).opacityFactor,
		).toBeCloseTo(0.3, 5);
	});

	test("shake offsets stay bounded and repeat every period", () => {
		const config = { type: "shake" as const, duration: 2 };
		for (const localTime of [0, 0.3, 1.1, 1.9]) {
			const state = resolveTextLoopAtTime({ config, localTime });
			expect(Math.abs(state.offsetX)).toBeLessThanOrEqual(TEXT_SHAKE_AMPLITUDE);
			expect(Math.abs(state.offsetY)).toBeLessThanOrEqual(TEXT_SHAKE_AMPLITUDE);
		}
		const first = resolveTextLoopAtTime({ config, localTime: 0.4 });
		const repeated = resolveTextLoopAtTime({ config, localTime: 2.4 });
		expect(repeated.offsetX).toBeCloseTo(first.offsetX, 10);
		expect(repeated.offsetY).toBeCloseTo(first.offsetY, 10);
	});

	test("none and non-positive duration stay idle", () => {
		const idle = { opacityFactor: 1, scaleFactor: 1, offsetX: 0, offsetY: 0 };
		expect(
			resolveTextLoopAtTime({
				config: { type: "none", duration: 1 },
				localTime: 0.5,
			}),
		).toEqual(idle);
		expect(
			resolveTextLoopAtTime({
				config: { type: "pulse", duration: 0 },
				localTime: 0.5,
			}),
		).toEqual(idle);
	});
});

describe("per-char animation", () => {
	test("per-char types are detected", () => {
		expect(isPerCharEntranceType("fade-chars")).toBe(true);
		expect(isPerCharEntranceType("pop-chars")).toBe(true);
		expect(isPerCharEntranceType("fade")).toBe(false);
	});

	test("char progress staggers sequentially and completes at 1", () => {
		expect(
			getTextCharProgress({ index: 0, totalChars: 4, overallProgress: 0.25 }),
		).toBe(1);
		expect(
			getTextCharProgress({ index: 1, totalChars: 4, overallProgress: 0.25 }),
		).toBe(0);
		expect(
			getTextCharProgress({ index: 3, totalChars: 4, overallProgress: 1 }),
		).toBe(1);
		expect(
			getTextCharProgress({ index: 1, totalChars: 4, overallProgress: 0.5 }),
		).toBe(1);
	});

	test("fade-chars resolves opacity per phase", () => {
		expect(
			resolveTextCharAnim({ type: "fade-chars", phase: "in", progress: 0.4 })
				.opacityFactor,
		).toBeCloseTo(0.4, 5);
		expect(
			resolveTextCharAnim({ type: "fade-chars", phase: "out", progress: 0.4 })
				.opacityFactor,
		).toBeCloseTo(0.6, 5);
	});

	test("buildTextCharStateAt returns null for non-per-char configs", () => {
		expect(
			buildTextCharStateAt({
				inConfig: { type: "fade", duration: 1 },
				localTime: 0.5,
				elementDuration: 4,
				totalChars: 5,
			}),
		).toBeNull();
	});

	test("buildTextCharStateAt staggers chars over the in duration", () => {
		const stateAt = buildTextCharStateAt({
			inConfig: { type: "fade-chars", duration: 2 },
			localTime: 1,
			elementDuration: 10,
			totalChars: 4,
		});
		expect(stateAt).not.toBeNull();
		expect(stateAt!(0).opacityFactor).toBe(1);
		expect(stateAt!(1).opacityFactor).toBe(1);
		expect(stateAt!(2).opacityFactor).toBe(0);
		expect(stateAt!(3).opacityFactor).toBe(0);
	});

	test("out phase shrinks chars near the element end", () => {
		const stateAt = buildTextCharStateAt({
			outConfig: { type: "pop-chars", duration: 2 },
			localTime: 9.5,
			elementDuration: 10,
			totalChars: 2,
		});
		expect(stateAt).not.toBeNull();
		expect(stateAt!(0).scaleFactor).toBeLessThan(0.2);
		// easeOutBack overshoots mid-animation, so the second char is well past
		// half-scale but not necessarily exactly 1.
		expect(stateAt!(1).scaleFactor).toBeGreaterThan(0.5);
	});
});

describe("countTextChars", () => {
	test("counts across lines without the newline characters", () => {
		expect(countTextChars({ content: "ab\ncde" })).toBe(5);
	});

	test("counts surrogate pairs as single characters", () => {
		expect(countTextChars({ content: "a👋b" })).toBe(3);
	});
});

describe("truncateTextContent", () => {
	test("returns empty string for zero visible chars", () => {
		expect(truncateTextContent({ content: "hello", visibleChars: 0 })).toBe("");
	});

	test("truncates mid-line and drops following lines", () => {
		expect(
			truncateTextContent({ content: "abc\ndef\nghi", visibleChars: 5 }),
		).toBe("abc\nde");
	});

	test("keeps full content when visible chars cover everything", () => {
		const content = "abc\ndef";
		expect(truncateTextContent({ content, visibleChars: 6 })).toBe(content);
		expect(truncateTextContent({ content, visibleChars: 100 })).toBe(content);
	});

	test("slices by code point so emoji stay intact", () => {
		expect(truncateTextContent({ content: "a👋b", visibleChars: 2 })).toBe("a👋");
	});
});
