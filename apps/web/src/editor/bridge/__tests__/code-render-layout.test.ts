import { describe, expect, mock, test } from "bun:test";
import type { VideoElement } from "@/timeline/types";
import type { MediaTime } from "@/wasm";

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

const { resolveCodeTransitionLayout, isSameSourceCut } =
	await import("../code-render-layout");

function video({
	id,
	startTime,
	duration,
	trimStart,
	trimEnd,
	sourceDuration = 10,
	rate,
}: {
	id: string;
	startTime: number;
	duration: number;
	trimStart: number;
	trimEnd: number;
	sourceDuration?: number;
	rate?: number;
}): VideoElement {
	return {
		id,
		type: "video",
		mediaId: "media-1",
		name: id,
		startTime: (startTime * TICKS) as MediaTime,
		duration: (duration * TICKS) as MediaTime,
		trimStart: (trimStart * TICKS) as MediaTime,
		trimEnd: (trimEnd * TICKS) as MediaTime,
		sourceDuration: (sourceDuration * TICKS) as MediaTime,
		...(rate === undefined ? {} : { retime: { rate } }),
		params: {},
	};
}

const outgoing = video({
	id: "a",
	startTime: 5,
	duration: 7.7333,
	trimStart: 24.45,
	trimEnd: 10,
	sourceDuration: 42.1833,
});
const incoming = video({
	id: "b",
	startTime: 12.7333,
	duration: 5,
	trimStart: 32.1833,
	trimEnd: 5,
	sourceDuration: 42.1833,
});

describe("isSameSourceCut", () => {
	test("uses the source axis for constant-rate video", () => {
		const a = video({
			id: "a",
			startTime: 0,
			duration: 5,
			trimStart: 0,
			trimEnd: 10,
			sourceDuration: 20,
			rate: 2,
		});
		const b = video({
			id: "b",
			startTime: 5,
			duration: 5,
			trimStart: 10,
			trimEnd: 0,
			sourceDuration: 20,
			rate: 2,
		});
		expect(isSameSourceCut({ outgoing: a, incoming: b })).toBe(true);
	});
});

describe("resolveCodeTransitionLayout", () => {
	test("centers a same-source cut without modifying clips", () => {
		const before = structuredClone({ outgoing, incoming });
		const result = resolveCodeTransitionLayout({
			outgoing,
			incoming,
			duration: 1,
		});
		expect(result.layout).toBe("center");
		expect(result.startTime).toBeCloseTo(12.2333 * TICKS);
		expect(result.endTime).toBeCloseTo(13.2333 * TICKS);
		expect({ outgoing, incoming }).toEqual(before);
	});

	test("accepts a non-destructive cut for the same source", () => {
		const result = resolveCodeTransitionLayout({
			outgoing,
			incoming,
			duration: 1,
			layout: "cut",
		});
		expect(result.layout).toBe("cut");
		expect(result.startTime).toBeCloseTo(11.7333 * TICKS);
		expect(result.endTime).toBeCloseTo(12.7333 * TICKS);
	});

	test("keeps split-center as a non-destructive alias", () => {
		expect(
			resolveCodeTransitionLayout({
				outgoing,
				incoming,
				duration: 1,
				layout: "split-center",
			}),
		).toEqual(
			resolveCodeTransitionLayout({
				outgoing,
				incoming,
				duration: 1,
				layout: "center",
			}),
		);
	});

	test("keeps cut as auto for different sources", () => {
		expect(
			resolveCodeTransitionLayout({
				outgoing,
				incoming: { ...incoming, mediaId: "another" },
				duration: 1,
			}).layout,
		).toBe("cut");
	});

	test("supports centered transitions for image inputs", () => {
		const a = { ...outgoing, type: "image" as const };
		const b = { ...incoming, type: "image" as const };
		expect(
			resolveCodeTransitionLayout({
				outgoing: a,
				incoming: b,
				duration: 1,
				layout: "center",
			}).startTime,
		).toBeCloseTo(12.2333 * TICKS);
	});

	test("rejects unknown layouts without changing clips", () => {
		expect(() =>
			resolveCodeTransitionLayout({
				outgoing,
				incoming,
				duration: 1,
				layout: "other",
			}),
		).toThrow(/layout/);
	});
});
