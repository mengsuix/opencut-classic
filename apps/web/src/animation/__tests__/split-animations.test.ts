import { describe, expect, mock, test } from "bun:test";

// `bun test` cannot load the wasm bundle; mock the integer-tick helpers before
// the dynamic imports below (same pattern as loop-extrapolation tests).
mock.module("@/wasm", () => ({
	TICKS_PER_SECOND: 1000,
	ZERO_MEDIA_TIME: 0,
	mediaTime: ({ ticks }: { ticks: number }) => ticks,
	roundMediaTime: ({ time }: { time: number }) => Math.round(time),
	addMediaTime: ({ a, b }: { a: number; b: number }) => a + b,
	subMediaTime: ({ a, b }: { a: number; b: number }) => a - b,
	maxMediaTime: ({ a, b }: { a: number; b: number }) => Math.max(a, b),
	minMediaTime: ({ a, b }: { a: number; b: number }) => Math.min(a, b),
}));

const { splitAnimationsAtTime } = await import("@/animation/keyframes");

import type {
	ElementAnimations,
	ScalarAnimationChannel,
	ScalarAnimationKey,
} from "@/animation/types";
import type { MediaTime } from "@/wasm";

function key(id: string, time: number, value: number): ScalarAnimationKey {
	return {
		id,
		time: time as MediaTime,
		value,
		segmentToNext: "bezier",
		tangentMode: "flat",
	};
}

function scaleChannel(keys: ScalarAnimationKey[]): ScalarAnimationChannel {
	return { keys };
}

function channelOf(
	animations: ElementAnimations | undefined,
	path: string,
): ScalarAnimationChannel | undefined {
	const data = animations?.[path] as ScalarAnimationChannel | undefined;
	return data && Array.isArray(data.keys) ? data : undefined;
}

/**
 * 线上事故还原（会话 713e6b73）：元素 startTime=18.35s，推近关键帧在局部
 * 3.03/3.138/3.438s，split 于局部 4.51s（时间线 22.86s）。实测右段出现了
 * 同 id 但 time≈19.84s 的错位 key（≈ splitTime − keyTime 的镜像值），
 * 即 agent 观察到的 "sign-flipped onto the wrong segment"。
 * TICKS_PER_SECOND mock 为 1000：3.03s → 3030 ticks。
 */
describe("splitAnimationsAtTime", () => {
	const animations: ElementAnimations = {
		"transform.scaleX": scaleChannel([
			key("k1", 3030, 1),
			key("k2", 3138, 1.06),
			key("k3", 3438, 1),
		]),
	};

	test("keys left of the cut stay in the left half with original times", () => {
		const { leftAnimations, rightAnimations } = splitAnimationsAtTime({
			animations,
			splitTime: 4510 as MediaTime,
			shouldIncludeSplitBoundary: true,
		});

		const left = channelOf(leftAnimations, "transform.scaleX");
		const right = channelOf(rightAnimations, "transform.scaleX");

		expect(left?.keys.map((k) => k.id)).toEqual(
			expect.arrayContaining(["k1", "k2", "k3"]),
		);
		// 原始时间必须原样保留（局部时间域不变）
		expect(left?.keys.find((k) => k.id === "k1")?.time).toBe(3030);
		expect(left?.keys.find((k) => k.id === "k2")?.time).toBe(3138);
		expect(left?.keys.find((k) => k.id === "k3")?.time).toBe(3438);

		// 右段绝不能出现这些 key（线上事故：同 id 出现在右段且时间镜像）
		expect(right?.keys.map((k) => k.id) ?? []).not.toContain("k1");
		expect(right?.keys.map((k) => k.id) ?? []).not.toContain("k2");
		expect(right?.keys.map((k) => k.id) ?? []).not.toContain("k3");
		// 右段唯一允许存在的是切点边界 key（time=0）
		for (const k of right?.keys ?? []) {
			expect(k.time).toBe(0);
		}
	});

	test("keys right of the cut move to the right half, shifted by splitTime", () => {
		const withRight: ElementAnimations = {
			"transform.scaleX": scaleChannel([
				key("a", 1000, 1),
				key("b", 5000, 2),
			]),
		};
		const { leftAnimations, rightAnimations } = splitAnimationsAtTime({
			animations: withRight,
			splitTime: 2000 as MediaTime,
			shouldIncludeSplitBoundary: true,
		});

		const left = channelOf(leftAnimations, "transform.scaleX");
		const right = channelOf(rightAnimations, "transform.scaleX");
		expect(left?.keys.map((k) => k.id)).toContain("a");
		expect(left?.keys.map((k) => k.id)).not.toContain("b");
		const movedB = right?.keys.find((k) => k.id === "b");
		expect(movedB?.time).toBe(3000); // 5000 - 2000
	});

	test("sequential splits never leak left-side keys into deeper right halves", () => {
		// 第一次 split 4.51s，第二次 split 作用在右段的局部 0.9s（时间线 23.76s）
		const first = splitAnimationsAtTime({
			animations,
			splitTime: 4510 as MediaTime,
			shouldIncludeSplitBoundary: true,
		});
		const second = splitAnimationsAtTime({
			animations: first.rightAnimations,
			splitTime: 900 as MediaTime,
			shouldIncludeSplitBoundary: true,
		});

		const deepestRight = channelOf(second.rightAnimations, "transform.scaleX");
		const ids = deepestRight?.keys.map((k) => k.id) ?? [];
		expect(ids).not.toContain("k1");
		expect(ids).not.toContain("k2");
		expect(ids).not.toContain("k3");
		// 所有 key 时间必须 ≥0 且语义上来自边界插入（time=0）
		for (const k of deepestRight?.keys ?? []) {
			expect(k.time).toBe(0);
		}
	});

	test("no key may ever land at splitTime − keyTime (mirror bug signature)", () => {
		// 对任意切点，产出 key 的时间只能是：原始时间（左段）、原时间−splitTime
		// （右段）、splitTime（左边界）、0（右边界）。镜像值 splitTime − keyTime
		// 是事故的指纹，显式拒绝。
		for (const splitAt of [1000, 3030, 4510]) {
			const { leftAnimations, rightAnimations } = splitAnimationsAtTime({
				animations,
				splitTime: splitAt as MediaTime,
				shouldIncludeSplitBoundary: true,
			});
			const originals = new Set([3030, 3138, 3438]);
			for (const k of channelOf(leftAnimations, "transform.scaleX")?.keys ??
				[]) {
				if (!originals.has(k.time)) {
					expect([splitAt]).toContain(k.time); // 仅允许边界 key
				}
			}
			for (const k of channelOf(rightAnimations, "transform.scaleX")?.keys ??
				[]) {
				if (k.time !== 0) {
					expect([3030 - splitAt, 3138 - splitAt, 3438 - splitAt]).toContain(
						k.time,
					);
				}
			}
		}
	});
});
