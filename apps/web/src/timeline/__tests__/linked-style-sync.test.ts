/* eslint-disable @typescript-eslint/no-unsafe-type-assertion -- fixtures build MediaTime via assertions because the wasm runtime (mediaTime()) cannot load under bun test */
import { describe, expect, test } from "bun:test";
import type { MediaTime } from "@/wasm";
import {
	expandLinkedTextStyleUpdates,
	type LinkedStyleUpdateEntry,
} from "../linked-style-sync";
import type { SceneTracks, TextElement, TextTrack } from "../types";

function buildTextElement({
	id,
	params,
}: {
	id: string;
	params: TextElement["params"];
}): TextElement {
	return {
		id,
		name: id,
		type: "text",
		startTime: 0 as MediaTime,
		duration: 10 as MediaTime,
		trimStart: 0 as MediaTime,
		trimEnd: 0 as MediaTime,
		params,
	};
}

function buildTracks({
	linkedStyle,
}: {
	linkedStyle?: boolean;
}): SceneTracks {
	const textTrack: TextTrack = {
		id: "text-track",
		name: "Text",
		type: "text",
		hidden: false,
		...(linkedStyle ? { linkedStyle: true } : {}),
		elements: [
			buildTextElement({
				id: "caption-1",
				params: { content: "first", fontSize: 15, color: "#fff" },
			}),
			buildTextElement({
				id: "caption-2",
				params: { content: "second", fontSize: 15, color: "#fff" },
			}),
		],
	};
	return {
		overlay: [textTrack],
		main: {
			id: "main-track",
			name: "Main",
			type: "video",
			elements: [],
			muted: false,
			hidden: false,
		},
		audio: [],
	};
}

function fontSizeUpdate({ fontSize }: { fontSize: number }): LinkedStyleUpdateEntry {
	return {
		trackId: "text-track",
		elementId: "caption-1",
		patch: {
			params: { content: "first", fontSize, color: "#fff" },
		},
	};
}

describe("expandLinkedTextStyleUpdates", () => {
	test("propagates changed style keys to siblings on a linked track", () => {
		const result = expandLinkedTextStyleUpdates({
			tracks: buildTracks({ linkedStyle: true }),
			updates: [fontSizeUpdate({ fontSize: 20 })],
		});

		expect(result).toHaveLength(2);
		expect(result[1]).toEqual({
			trackId: "text-track",
			elementId: "caption-2",
			patch: { params: { fontSize: 20 } },
		});
	});

	test("propagates transform scale changes to siblings", () => {
		const result = expandLinkedTextStyleUpdates({
			tracks: buildTracks({ linkedStyle: true }),
			updates: [
				{
					trackId: "text-track",
					elementId: "caption-1",
					patch: {
						params: {
							content: "first",
							fontSize: 15,
							color: "#fff",
							"transform.scaleX": 0.5,
							"transform.scaleY": 0.5,
						},
					},
				},
			],
		});

		expect(result).toHaveLength(2);
		expect(result[1]).toEqual({
			trackId: "text-track",
			elementId: "caption-2",
			patch: { params: { "transform.scaleX": 0.5, "transform.scaleY": 0.5 } },
		});
	});

	test("does not propagate content or unchanged keys", () => {
		const result = expandLinkedTextStyleUpdates({
			tracks: buildTracks({ linkedStyle: true }),
			updates: [
				{
					trackId: "text-track",
					elementId: "caption-1",
					patch: { params: { content: "renamed", fontSize: 15 } },
				},
			],
		});

		expect(result).toHaveLength(1);
	});

	test("propagates stroke and entrance animation keys to siblings", () => {
		const result = expandLinkedTextStyleUpdates({
			tracks: buildTracks({ linkedStyle: true }),
			updates: [
				{
					trackId: "text-track",
					elementId: "caption-1",
					patch: {
						params: {
							"stroke.enabled": true,
							"stroke.color": "#000000",
							"stroke.width": 3,
							"animIn.type": "typewriter",
						},
					},
				},
			],
		});

		expect(result).toHaveLength(2);
		expect(result[1]).toEqual({
			trackId: "text-track",
			elementId: "caption-2",
			patch: {
				params: {
					"stroke.enabled": true,
					"stroke.color": "#000000",
					"stroke.width": 3,
					"animIn.type": "typewriter",
				},
			},
		});
	});

	test("does not propagate on an unlinked track", () => {
		const result = expandLinkedTextStyleUpdates({
			tracks: buildTracks({}),
			updates: [fontSizeUpdate({ fontSize: 20 })],
		});

		expect(result).toHaveLength(1);
	});

	test("ignores updates without params patches", () => {
		const result = expandLinkedTextStyleUpdates({
			tracks: buildTracks({ linkedStyle: true }),
			updates: [
				{
					trackId: "text-track",
					elementId: "caption-1",
					patch: { startTime: 5 as MediaTime },
				},
			],
		});

		expect(result).toHaveLength(1);
	});
});
