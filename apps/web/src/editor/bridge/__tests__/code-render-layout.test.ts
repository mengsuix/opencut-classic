import { describe, expect, mock, test } from "bun:test";
import type { VideoElement } from "@/timeline/types";

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

const { computeSplitCenterLayout, isSameSourceCut } =
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
		startTime: startTime * TICKS,
		duration: duration * TICKS,
		trimStart: trimStart * TICKS,
		trimEnd: trimEnd * TICKS,
		sourceDuration: sourceDuration * TICKS,
		...(rate === undefined ? {} : { retime: { rate } }),
		params: {},
	};
}

function expectSourceWindowMatchesDuration(element: VideoElement): void {
	const rate = element.retime?.rate ?? 1;
	const sourceSpan =
		element.sourceDuration! - element.trimStart - element.trimEnd;
	expect(sourceSpan / rate).toBeCloseTo(element.duration);
}

describe("isSameSourceCut", () => {
	test("uses the source axis for constant-rate video", () => {
		const outgoing = video({
			id: "a",
			startTime: 0,
			duration: 5,
			trimStart: 0,
			trimEnd: 10,
			sourceDuration: 20,
			rate: 2,
		});
		const incoming = video({
			id: "b",
			startTime: 5,
			duration: 5,
			trimStart: 10,
			trimEnd: 0,
			sourceDuration: 20,
			rate: 2,
		});
		expect(isSameSourceCut({ outgoing, incoming })).toBe(true);
	});
});

describe("computeSplitCenterLayout", () => {
	test("keeps source windows consistent and reports the following-element shift", () => {
		const outgoing = video({
			id: "a",
			startTime: 0,
			duration: 5,
			trimStart: 0,
			trimEnd: 5,
		});
		const incoming = video({
			id: "b",
			startTime: 5,
			duration: 5,
			trimStart: 5,
			trimEnd: 0,
		});
		const result = computeSplitCenterLayout({
			outgoing,
			incoming,
			duration: 2,
		});
		const nextOutgoing = { ...outgoing, ...result.outgoingPatch };
		const nextIncoming = { ...incoming, ...result.incomingPatch };

		expect(nextOutgoing.duration).toBe(4000);
		expect(nextOutgoing.trimEnd).toBe(6000);
		expect(nextIncoming.startTime).toBe(4000);
		expect(nextIncoming.trimStart).toBe(6000);
		expect(nextIncoming.duration).toBe(4000);
		expect(result.followingStartDelta).toBe(2000);
		expectSourceWindowMatchesDuration(nextOutgoing);
		expectSourceWindowMatchesDuration(nextIncoming);
		expect(
			nextIncoming.startTime +
				nextIncoming.duration +
				result.followingStartDelta,
		).toBe(incoming.startTime + incoming.duration);
	});

	test("consumes incoming tail handles before shortening duration", () => {
		const outgoing = video({
			id: "a",
			startTime: 0,
			duration: 5,
			trimStart: 0,
			trimEnd: 5,
		});
		const incoming = video({
			id: "b",
			startTime: 5,
			duration: 3,
			trimStart: 5,
			trimEnd: 2,
		});
		const result = computeSplitCenterLayout({
			outgoing,
			incoming,
			duration: 2,
		});
		const nextIncoming = { ...incoming, ...result.incomingPatch };

		expect(nextIncoming.trimEnd).toBe(1000);
		expect(nextIncoming.duration).toBe(3000);
		expect(result.followingStartDelta).toBe(1000);
		expectSourceWindowMatchesDuration(nextIncoming);
	});

	test("converts timeline seconds to source seconds at 2x speed", () => {
		const outgoing = video({
			id: "a",
			startTime: 0,
			duration: 5,
			trimStart: 0,
			trimEnd: 10,
			sourceDuration: 20,
			rate: 2,
		});
		const incoming = video({
			id: "b",
			startTime: 5,
			duration: 5,
			trimStart: 10,
			trimEnd: 0,
			sourceDuration: 20,
			rate: 2,
		});
		const result = computeSplitCenterLayout({
			outgoing,
			incoming,
			duration: 2,
		});
		const nextOutgoing = { ...outgoing, ...result.outgoingPatch };
		const nextIncoming = { ...incoming, ...result.incomingPatch };

		expect(nextOutgoing.trimEnd).toBe(12000);
		expect(nextIncoming.trimStart).toBe(12000);
		expectSourceWindowMatchesDuration(nextOutgoing);
		expectSourceWindowMatchesDuration(nextIncoming);
	});

	test("rejects an outgoing element that cannot contain the adjusted transition", () => {
		const outgoing = video({
			id: "a",
			startTime: 0,
			duration: 1.2,
			trimStart: 0,
			trimEnd: 8.8,
		});
		const incoming = video({
			id: "b",
			startTime: 1.2,
			duration: 2,
			trimStart: 1.2,
			trimEnd: 6.8,
		});
		expect(() =>
			computeSplitCenterLayout({ outgoing, incoming, duration: 1 }),
		).toThrow(/1.5 times/);
	});
});
