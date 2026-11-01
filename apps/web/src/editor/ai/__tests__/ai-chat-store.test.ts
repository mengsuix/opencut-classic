import { beforeEach, describe, expect, test } from "bun:test";
import {
	buildReferencesBlock,
	useAiChatStore,
} from "@/editor/ai/ai-chat-store";

beforeEach(() => {
	useAiChatStore.getState().clearReferences({ resetNumbering: true });
});

describe("unified agent references", () => {
	test("assigns typed stable labels without reuse after removal or send-style clearing", () => {
		const store = useAiChatStore.getState();
		store.addReference({
			reference: { kind: "media", mediaId: "m1", name: "素材", type: "video" },
		});
		store.addReference({
			reference: { kind: "media", mediaId: "m2", name: "素材二", type: "image" },
		});
		store.addReference({
			reference: {
				kind: "element",
				trackId: "v1",
				elementId: "e1",
				trackType: "video",
				type: "video",
				name: "片段",
				startTime: 1,
				duration: 2,
			},
		});
		store.addReference({
			reference: {
				kind: "canvas",
				name: "画面区域",
				left: 0.1,
				top: 0.2,
				right: 0.3,
				bottom: 0.4,
				time: 5,
			},
		});
		store.addReference({
			reference: { kind: "time-range", name: "时间范围", startTime: 3, endTime: 8 },
		});

		expect(useAiChatStore.getState().references.map((ref) => ref.refId)).toEqual([
			"M1",
			"M2",
			"E1",
			"C1",
			"T1",
		]);

		store.removeReference({ refId: "M1" });
		store.addReference({
			reference: { kind: "media", mediaId: "m3", name: "素材三", type: "audio" },
		});
		expect(useAiChatStore.getState().references.at(-1)?.refId).toBe("M3");

		store.clearReferences();
		store.addReference({
			reference: { kind: "media", mediaId: "m4", name: "素材四", type: "video" },
		});
		expect(useAiChatStore.getState().references[0].refId).toBe("M4");

		store.clearReferences({ resetNumbering: true });
		store.addReference({
			reference: { kind: "media", mediaId: "m5", name: "素材五", type: "video" },
		});
		expect(useAiChatStore.getState().references[0].refId).toBe("M1");
	});

	test("refreshes an existing element snapshot while preserving its label", () => {
		const store = useAiChatStore.getState();
		const reference = {
			kind: "element" as const,
			trackId: "v1",
			elementId: "e1",
			trackType: "video",
			type: "video",
			name: "片段",
			startTime: 1,
			duration: 2,
		};
		store.addReference({ reference });
		useAiChatStore.getState().addReference({
			reference: { ...reference, startTime: 4 },
		});

		expect(useAiChatStore.getState().references).toHaveLength(1);
		expect(useAiChatStore.getState().references[0]).toMatchObject({
			refId: "E1",
			startTime: 4,
		});
	});

	test("serializes complete M/E/C/T snapshots", () => {
		const store = useAiChatStore.getState();
		store.addReference({
			reference: { kind: "media", mediaId: "m1", name: "素材", type: "video", duration: 12 },
		});
		store.addReference({
			reference: {
				kind: "element",
				trackId: "v1",
				elementId: "e1",
				trackType: "video",
				type: "video",
				name: "片段",
				startTime: 1,
				duration: 2,
				mediaId: "m1",
			},
		});
		store.addReference({
			reference: {
				kind: "canvas",
				name: "画面区域",
				left: 0.1,
				top: 0.2,
				right: 0.3,
				bottom: 0.4,
				time: 5,
			},
		});
		store.addReference({
			reference: { kind: "time-range", name: "时间范围", startTime: 3, endTime: 8 },
		});

		const block = buildReferencesBlock(useAiChatStore.getState().references);
		expect(block).toContain("[M1] 素材「素材」 type=video duration=12s mediaId=m1");
		expect(block).toContain("trackId=v1 elementId=e1 range=1s~3s mediaId=m1");
		expect(block).toContain("[C1] 画布区域 time=5s rect=[0.1,0.2,0.3,0.4]");
		expect(block).toContain("[T1] 时间范围 start=3s end=8s");
	});
});
