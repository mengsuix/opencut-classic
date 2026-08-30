/* eslint-disable @typescript-eslint/no-unsafe-type-assertion -- fixtures build TextElement via assertions because only .params is read */
import { describe, expect, test } from "bun:test";
import type { TextElement } from "@/timeline";
import {
	buildTextEntranceFromElement,
	countTextChars,
	resolveTextEntranceAtTime,
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
