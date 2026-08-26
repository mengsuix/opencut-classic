import type { EditorCore } from "@/core";
import { mediaTimeFromSeconds, mediaTimeToSeconds, type MediaTime } from "@/wasm";
import { DEFAULTS } from "@/timeline/defaults";
import type { CreateTimelineElement, TrackType } from "@/timeline";
import type { InsertElementParams } from "@/commands/timeline/element/insert-element";
import { CanvasRenderer } from "@/services/renderer/canvas-renderer";
import { effectsRegistry } from "@/effects";
import { buildDefaultMaskInstance, getMaskDefinitionsForMenu } from "@/masks";
import type { Mask, MaskType } from "@/masks/types";
import type { FreeformPathPoint } from "@/masks/freeform/path";
import { generateUUID } from "@/utils/id";
import type { AnimationInterpolation } from "@/animation/types";
import type { RetimeConfig } from "@/timeline/types";
import { extractTimelineAudio } from "@/media/mediabunny";
import { decodeAudioToFloat32 } from "@/media/audio";
import { processMediaAssets } from "@/media/processing";
import { transcriptionService } from "@/services/transcription/service";
import { buildCaptionChunks } from "@/transcription/caption";
import { DEFAULT_TRANSCRIPTION_SAMPLE_RATE } from "@/transcription/audio";
import { insertCaptionChunksAsTextTrack } from "@/subtitles/insert";
import type { SubtitleCue } from "@/subtitles/types";
import type {
	TranscriptionLanguage,
	TranscriptionModelId,
} from "@/transcription/types";
import type { ExportOptions } from "@/export";
import { storageService } from "@/services/storage/service";

export interface BridgeElementRef {
	trackId: string;
	elementId: string;
}

export interface BridgeCommandContext {
	editor: EditorCore;
	args: Record<string, unknown>;
}

export interface BridgeCommandDef {
	description: string;
	args?: Record<string, string>;
	run: (context: BridgeCommandContext) => unknown | Promise<unknown>;
}

const toTicks = (seconds: number): MediaTime =>
	mediaTimeFromSeconds({ seconds });

const toSeconds = (time: MediaTime): number => mediaTimeToSeconds({ time });

const TIME_PATCH_KEYS = new Set([
	"startTime",
	"duration",
	"trimStart",
	"trimEnd",
]);

function convertTimePatch(
	patch: Record<string, unknown>,
): Record<string, unknown> {
	const converted: Record<string, unknown> = { ...patch };
	for (const key of TIME_PATCH_KEYS) {
		if (typeof converted[key] === "number") {
			converted[key] = toTicks(converted[key] as number);
		}
	}
	return converted;
}

function requireString(value: unknown, name: string): string {
	if (typeof value !== "string" || value.length === 0) {
		throw new Error(`Missing or invalid argument: ${name}`);
	}
	return value;
}

function requireNumber(value: unknown, name: string): number {
	if (typeof value !== "number" || Number.isNaN(value)) {
		throw new Error(`Missing or invalid argument: ${name}`);
	}
	return value;
}

function requireElementRefs(value: unknown): BridgeElementRef[] {
	if (!Array.isArray(value)) {
		throw new Error("Missing or invalid argument: elements");
	}
	return value.map((item) => {
		const ref = item as Partial<BridgeElementRef>;
		if (typeof ref?.trackId !== "string" || typeof ref?.elementId !== "string") {
			throw new Error("Each element ref needs trackId and elementId");
		}
		return { trackId: ref.trackId, elementId: ref.elementId };
	});
}

function resolveElementRefs(
	editor: EditorCore,
	value: unknown,
): BridgeElementRef[] {
	if (value === "$selection") {
		const selected = editor.selection.getSelectedElements();
		if (selected.length === 0) {
			throw new Error(
				'No elements are selected in the editor. Ask the user to select elements on the timeline first, or pass explicit element refs. Use the "selection.describe" command to inspect the current selection.',
			);
		}
		return selected.map((ref) => ({
			trackId: ref.trackId,
			elementId: ref.elementId,
		}));
	}
	return requireElementRefs(value);
}

function serializeElement(element: Record<string, unknown>) {
	return {
		...element,
		startTime: toSeconds(element.startTime as MediaTime),
		duration: toSeconds(element.duration as MediaTime),
		trimStart: toSeconds(element.trimStart as MediaTime),
		trimEnd: toSeconds(element.trimEnd as MediaTime),
	};
}

function serializeTrack(track: Record<string, unknown>) {
	const elements = (track.elements as Record<string, unknown>[]) ?? [];
	return { ...track, elements: elements.map(serializeElement) };
}

function findElement(
	editor: EditorCore,
	trackId: string,
	elementId: string,
): Record<string, unknown> {
	const tracks = editor.scenes.getActiveSceneOrNull()?.tracks;
	if (!tracks) {
		throw new Error("No active scene");
	}
	const allTracks = [tracks.main, ...tracks.overlay, ...tracks.audio] as Array<{
		id: string;
		elements: Array<{ id: string }>;
	}>;
	const track = allTracks.find((item) => item.id === trackId);
	if (!track) {
		throw new Error(`Track not found: ${trackId}`);
	}
	const element = track.elements.find((item) => item.id === elementId);
	if (!element) {
		throw new Error(`Element not found: ${elementId} on track ${trackId}`);
	}
	return element as unknown as Record<string, unknown>;
}

function findTrackAndElement(
	editor: EditorCore,
	trackId: string,
	elementId: string,
): { trackType: string; element: Record<string, unknown> } | null {
	const tracks = editor.scenes.getActiveSceneOrNull()?.tracks;
	if (!tracks) {
		return null;
	}
	const allTracks = [tracks.main, ...tracks.overlay, ...tracks.audio] as Array<{
		id: string;
		type: string;
		elements: Array<{ id: string }>;
	}>;
	const track = allTracks.find((item) => item.id === trackId);
	const element = track?.elements.find((item) => item.id === elementId);
	if (!track || !element) {
		return null;
	}
	return {
		trackType: track.type,
		element: element as unknown as Record<string, unknown>,
	};
}

function sanitizeJson<T>(value: T): T {
	return JSON.parse(JSON.stringify(value));
}

const KEYFRAME_INTERPOLATIONS: AnimationInterpolation[] = [
	"linear",
	"hold",
	"bezier",
];

function requireInterpolation(
	value: unknown,
	allowed: string[],
): AnimationInterpolation {
	if (value === undefined) {
		return "linear";
	}
	if (typeof value !== "string" || !allowed.includes(value)) {
		throw new Error(
			`Invalid interpolation: ${String(value)}. Allowed: ${allowed.join(", ")}`,
		);
	}
	return value as AnimationInterpolation;
}

function getElementMasks(
	editor: EditorCore,
	trackId: string,
	elementId: string,
): Mask[] {
	const element = findElement(editor, trackId, elementId);
	return (element.masks as Mask[] | undefined) ?? [];
}

function buildSelectionState(editor: EditorCore) {
	return {
		kind: editor.selection.getActiveSelectionKind(),
		elements: editor.selection.getSelectedElements(),
		keyframes: editor.selection.getSelectedKeyframes(),
		maskPoints: editor.selection.getSelectedMaskPointSelection(),
	};
}

function buildEditorState(editor: EditorCore) {
	const project = editor.project.getActiveOrNull();
	const scenes = editor.scenes.getScenes();
	const activeScene = editor.scenes.getActiveSceneOrNull();
	const tracks = activeScene?.tracks ?? null;

	return {
		project: project
			? {
					id: project.metadata.id,
					name: project.metadata.name,
					settings: project.settings,
				}
			: null,
		scenes: scenes.map((scene) => ({ id: scene.id, name: scene.name })),
		activeSceneId: activeScene?.id ?? null,
		duration: toSeconds(editor.timeline.getTotalDuration()),
		playback: {
			time: toSeconds(editor.playback.getCurrentTime()),
			isPlaying: editor.playback.getIsPlaying(),
			volume: editor.playback.getVolume(),
			muted: editor.playback.isMuted(),
		},
		selection: buildSelectionState(editor),
		history: {
			canUndo: editor.command.canUndo(),
			canRedo: editor.command.canRedo(),
		},
		tracks: tracks
			? {
					main: serializeTrack(
						tracks.main as unknown as Record<string, unknown>,
					),
					overlay: tracks.overlay.map((track) =>
						serializeTrack(track as unknown as Record<string, unknown>),
					),
					audio: tracks.audio.map((track) =>
						serializeTrack(track as unknown as Record<string, unknown>),
					),
				}
			: null,
		mediaAssets: editor.media.getAssets().map((asset) => ({
			id: asset.id,
			name: asset.name,
			type: asset.type,
			duration: asset.duration,
			width: asset.width,
			height: asset.height,
			fps: asset.fps,
		})),
	};
}

function insertAndSelect(
	editor: EditorCore,
	element: CreateTimelineElement,
	placement: InsertElementParams["placement"],
): { selected: BridgeElementRef[] } {
	editor.timeline.insertElement({ element, placement });
	return {
		selected: editor.selection.getSelectedElements() as BridgeElementRef[],
	};
}

export const BRIDGE_COMMANDS: Record<string, BridgeCommandDef> = {
	"commands.list": {
		description: "List all available bridge commands with argument hints.",
		run: () =>
			Object.entries(BRIDGE_COMMANDS).map(([name, def]) => ({
				name,
				description: def.description,
				args: def.args ?? {},
			})),
	},

	"state.get": {
		description: "Get the full editor state (times in seconds).",
		run: ({ editor }) => buildEditorState(editor),
	},

	"timeline.add_track": {
		description: "Add a track. Returns the new track id.",
		args: { type: "TrackType (e.g. video, audio, text)", index: "number?" },
		run: ({ editor, args }) => ({
			trackId: editor.timeline.addTrack({
				type: requireString(args.type, "type") as TrackType,
				...(typeof args.index === "number" ? { index: args.index } : {}),
			}),
		}),
	},

	"timeline.remove_track": {
		description: "Remove a track and all its elements.",
		args: { trackId: "string" },
		run: ({ editor, args }) => {
			editor.timeline.removeTrack({
				trackId: requireString(args.trackId, "trackId"),
			});
			return { removed: true };
		},
	},

	"timeline.add_text": {
		description:
			"Add a text element with sensible defaults. Returns the inserted element ref.",
		args: {
			content: "string",
			startTime: "seconds?",
			duration: "seconds?",
			trackId: "string? (omit for auto placement)",
			params: "object? (override any text params, e.g. fontSize, color)",
		},
		run: ({ editor, args }) => {
			const base = structuredClone(DEFAULTS.text.element);
			const element = {
				...base,
				startTime: toTicks(Number(args.startTime ?? 0)),
				duration:
					args.duration != null ? toTicks(Number(args.duration)) : base.duration,
				params: {
					...base.params,
					...((args.params as Record<string, unknown> | undefined) ?? {}),
					content: String(args.content ?? base.params.content),
				},
			} as unknown as CreateTimelineElement;
			const placement: InsertElementParams["placement"] =
				typeof args.trackId === "string"
					? { mode: "explicit", trackId: args.trackId }
					: { mode: "auto", trackType: "text" };
			return insertAndSelect(editor, element, placement);
		},
	},

	"timeline.insert_element": {
		description:
			"Insert a raw timeline element (times in seconds). For media elements pass mediaId from mediaAssets. Returns the inserted element ref.",
		args: {
			element: "CreateTimelineElement with seconds for startTime/duration/trimStart/trimEnd",
			placement: "{ mode: 'explicit', trackId } | { mode: 'auto', trackType? } (default auto)",
		},
		run: ({ editor, args }) => {
			const raw = args.element as Record<string, unknown> | undefined;
			if (!raw || typeof raw.type !== "string") {
				throw new Error("Missing or invalid argument: element");
			}
			const element = convertTimePatch(
				raw,
			) as unknown as CreateTimelineElement;
			const placement = (args.placement ??
				({ mode: "auto" } as const)) as InsertElementParams["placement"];
			return insertAndSelect(editor, element, placement);
		},
	},

	"timeline.update_elements": {
		description:
			"Patch elements (e.g. params like volume, opacity, transform.*, or time fields in seconds).",
		args: {
			updates: "[{ trackId, elementId, patch }]",
			pushHistory: "boolean? (default true)",
		},
		run: ({ editor, args }) => {
			const updates = (
				args.updates as Array<Record<string, unknown>> | undefined
			)?.map((update) => ({
				trackId: requireString(update.trackId, "updates[].trackId"),
				elementId: requireString(update.elementId, "updates[].elementId"),
				patch: convertTimePatch(
					(update.patch ?? {}) as Record<string, unknown>,
				),
			}));
			if (!updates || updates.length === 0) {
				throw new Error("Missing or invalid argument: updates");
			}
			editor.timeline.updateElements({
				updates: updates as never,
				...(typeof args.pushHistory === "boolean"
					? { pushHistory: args.pushHistory }
					: {}),
			});
			return { updated: updates.length };
		},
	},

	"timeline.split_elements": {
		description:
			"Split elements at a time (seconds). Returns the right-side element refs.",
		args: {
			elements: '[{ trackId, elementId }] | "$selection" (current selection)',
			splitTime: "seconds",
			retainSide: "'both' | 'left' | 'right'? (default both)",
		},
		run: ({ editor, args }) => ({
			rightSide: editor.timeline.splitElements({
				elements: resolveElementRefs(editor, args.elements),
				splitTime: toTicks(requireNumber(args.splitTime, "splitTime")),
				...(typeof args.retainSide === "string"
					? { retainSide: args.retainSide as "both" | "left" | "right" }
					: {}),
			}),
		}),
	},

	"timeline.trim_element": {
		description:
			"Trim an element's source range and/or move/resize it (seconds).",
		args: {
			elementId: "string",
			trimStart: "seconds?",
			trimEnd: "seconds?",
			startTime: "seconds?",
			duration: "seconds?",
			pushHistory: "boolean?",
		},
		run: ({ editor, args }) => {
			editor.timeline.updateElementTrim({
				elementId: requireString(args.elementId, "elementId"),
				trimStart: toTicks(requireNumber(args.trimStart, "trimStart")),
				trimEnd: toTicks(requireNumber(args.trimEnd, "trimEnd")),
				...(typeof args.startTime === "number"
					? { startTime: toTicks(args.startTime) }
					: {}),
				...(typeof args.duration === "number"
					? { duration: toTicks(args.duration) }
					: {}),
				...(typeof args.pushHistory === "boolean"
					? { pushHistory: args.pushHistory }
					: {}),
			});
			return { trimmed: true };
		},
	},

	"timeline.move_elements": {
		description:
			"Move elements between tracks and/or to a new start time (seconds).",
		args: {
			moves: "[{ sourceTrackId, targetTrackId, elementId, newStartTime }]",
			createTracks: "[{ id, type, index }]?",
		},
		run: ({ editor, args }) => {
			const rawMoves = args.moves as Array<Record<string, unknown>> | undefined;
			if (!rawMoves || rawMoves.length === 0) {
				throw new Error("Missing or invalid argument: moves");
			}
			editor.timeline.moveElements({
				moves: rawMoves.map((move) => ({
					sourceTrackId: requireString(move.sourceTrackId, "sourceTrackId"),
					targetTrackId: requireString(move.targetTrackId, "targetTrackId"),
					elementId: requireString(move.elementId, "elementId"),
					newStartTime: toTicks(requireNumber(move.newStartTime, "newStartTime")),
				})),
				...(Array.isArray(args.createTracks)
					? { createTracks: args.createTracks as never }
					: {}),
			});
			return { moved: rawMoves.length };
		},
	},

	"timeline.delete_elements": {
		description: "Delete elements from the timeline.",
		args: {
			elements: '[{ trackId, elementId }] | "$selection" (current selection)',
		},
		run: ({ editor, args }) => {
			editor.timeline.deleteElements({
				elements: resolveElementRefs(editor, args.elements),
			});
			return { deleted: true };
		},
	},

	"timeline.duplicate_elements": {
		description: "Duplicate elements. Returns the new element refs.",
		args: {
			elements: '[{ trackId, elementId }] | "$selection" (current selection)',
		},
		run: ({ editor, args }) => ({
			duplicated: editor.timeline.duplicateElements({
				elements: resolveElementRefs(editor, args.elements),
			}),
		}),
	},

	"timeline.toggle_muted": {
		description: "Toggle mute on audio-capable elements.",
		args: {
			elements: '[{ trackId, elementId }] | "$selection" (current selection)',
		},
		run: ({ editor, args }) => {
			editor.timeline.toggleElementsMuted({
				elements: resolveElementRefs(editor, args.elements),
			});
			return { toggled: true };
		},
	},

	"timeline.toggle_visibility": {
		description: "Toggle visibility on hideable elements.",
		args: {
			elements: '[{ trackId, elementId }] | "$selection" (current selection)',
		},
		run: ({ editor, args }) => {
			editor.timeline.toggleElementsVisibility({
				elements: resolveElementRefs(editor, args.elements),
			});
			return { toggled: true };
		},
	},

	"timeline.toggle_track_mute": {
		description: "Toggle mute on a whole track.",
		args: { trackId: "string" },
		run: ({ editor, args }) => {
			editor.timeline.toggleTrackMute({
				trackId: requireString(args.trackId, "trackId"),
			});
			return { toggled: true };
		},
	},

	"timeline.toggle_source_audio_separation": {
		description:
			"Toggle source audio separation on an audio-capable element (e.g. vocals/instrumental).",
		args: { trackId: "string", elementId: "string" },
		run: ({ editor, args }) => {
			editor.timeline.toggleSourceAudioSeparation({
				trackId: requireString(args.trackId, "trackId"),
				elementId: requireString(args.elementId, "elementId"),
			});
			return { toggled: true };
		},
	},

	"timeline.toggle_track_visibility": {
		description: "Toggle visibility on a whole track.",
		args: { trackId: "string" },
		run: ({ editor, args }) => {
			editor.timeline.toggleTrackVisibility({
				trackId: requireString(args.trackId, "trackId"),
			});
			return { toggled: true };
		},
	},

	"timeline.toggle_track_linked_style": {
		description:
			"Toggle linked caption style on a text track. While linked, text style edits (font, size, color, background) and transform edits (position, scale, rotate) on one element apply to every element on the track.",
		args: { trackId: "string" },
		run: ({ editor, args }) => {
			editor.timeline.toggleTrackLinkedStyle({
				trackId: requireString(args.trackId, "trackId"),
			});
			return { toggled: true };
		},
	},

	"timeline.retime_element": {
		description:
			"Set playback speed on a media element. Omit retime (or pass null) to reset to normal speed.",
		args: {
			trackId: "string",
			elementId: "string",
			retime: "{ rate: number (1 = normal, 2 = 2x, 0.5 = half), maintainPitch?: boolean } | null",
			pushHistory: "boolean? (default true)",
		},
		run: ({ editor, args }) => {
			editor.timeline.updateElementRetime({
				trackId: requireString(args.trackId, "trackId"),
				elementId: requireString(args.elementId, "elementId"),
				...(args.retime != null
					? { retime: args.retime as RetimeConfig }
					: {}),
				...(typeof args.pushHistory === "boolean"
					? { pushHistory: args.pushHistory }
					: {}),
			});
			return { updated: true };
		},
	},

	"scenes.toggle_bookmark": {
		description: "Toggle a scene bookmark at a time (seconds).",
		args: { time: "seconds" },
		run: async ({ editor, args }) => {
			await editor.scenes.toggleBookmark({
				time: toTicks(requireNumber(args.time, "time")),
			});
			return { toggled: true };
		},
	},

	"scenes.update_bookmark": {
		description:
			"Update a bookmark's note, color or duration (seconds) at a given time (seconds).",
		args: {
			time: "seconds",
			updates: "{ note?: string, color?: string, duration?: seconds }",
		},
		run: async ({ editor, args }) => {
			const updates = args.updates as Record<string, unknown> | undefined;
			if (!updates || typeof updates !== "object") {
				throw new Error("Missing or invalid argument: updates");
			}
			const converted = { ...updates };
			if (typeof converted.duration === "number") {
				converted.duration = toTicks(converted.duration);
			}
			await editor.scenes.updateBookmark({
				time: toTicks(requireNumber(args.time, "time")),
				updates: converted as never,
			});
			return { updated: true };
		},
	},

	"scenes.move_bookmark": {
		description: "Move a bookmark from one time to another (seconds).",
		args: { fromTime: "seconds", toTime: "seconds" },
		run: async ({ editor, args }) => {
			await editor.scenes.moveBookmark({
				fromTime: toTicks(requireNumber(args.fromTime, "fromTime")),
				toTime: toTicks(requireNumber(args.toTime, "toTime")),
			});
			return { moved: true };
		},
	},

	"subtitles.transcribe": {
		description:
			"Transcribe the timeline audio with the local Whisper model, generate captions and insert them as a new text track. Long-running: the model downloads on first use. Returns the new track id and caption count.",
		args: {
			language: "BCP-47 code or 'auto'? (default auto)",
			modelId: "TranscriptionModelId? (default project default)",
		},
		run: async ({ editor, args }) => {
			const audioBlob = await extractTimelineAudio({
				tracks: editor.scenes.getActiveScene().tracks,
				mediaAssets: editor.media.getAssets(),
				totalDuration: editor.timeline.getTotalDuration(),
			});
			const { samples } = await decodeAudioToFloat32({
				audioBlob,
				sampleRate: DEFAULT_TRANSCRIPTION_SAMPLE_RATE,
			});
			const language =
				typeof args.language === "string" && args.language !== "auto"
					? (args.language as TranscriptionLanguage)
					: undefined;
			const result = await transcriptionService.transcribe({
				audioData: samples,
				...(language ? { language } : {}),
				...(typeof args.modelId === "string"
					? { modelId: args.modelId as TranscriptionModelId }
					: {}),
			});
			const captions = buildCaptionChunks({ segments: result.segments });
			const trackId = insertCaptionChunksAsTextTrack({ editor, captions });
			if (!trackId) {
				throw new Error("No captions were generated from the transcription");
			}
			return { trackId, captionCount: captions.length };
		},
	},

	"subtitles.insert": {
		description:
			"Insert caption cues as a new subtitle text track (times in seconds).",
		args: {
			captions: "[{ text, startTime, duration, style? }]",
		},
		run: ({ editor, args }) => {
			const captions = args.captions as SubtitleCue[] | undefined;
			if (!Array.isArray(captions) || captions.length === 0) {
				throw new Error("Missing or invalid argument: captions");
			}
			const trackId = insertCaptionChunksAsTextTrack({ editor, captions });
			if (!trackId) {
				throw new Error("Failed to insert captions");
			}
			return { trackId, captionCount: captions.length };
		},
	},

	"media.remove": {
		description:
			"Remove media assets from the project. Undoable; timeline elements referencing removed assets may fail to render.",
		args: { assetIds: "string[]" },
		run: ({ editor, args }) => {
			const ids = args.assetIds;
			if (!Array.isArray(ids) || ids.length === 0) {
				throw new Error("Missing or invalid argument: assetIds");
			}
			editor.media.removeMediaAssets({
				projectId: editor.project.getActive().metadata.id,
				ids: ids.map((id) => requireString(id, "assetIds[]")),
			});
			return { removed: ids.length };
		},
	},

	"media.import": {
		description:
			"Import a media file into the project (sent by the MCP bridge as base64). Returns the imported asset ids.",
		args: {
			name: "string (file name)",
			dataBase64: "string",
			mimeType: "string?",
		},
		run: async ({ editor, args }) => {
			const name = requireString(args.name, "name");
			const dataBase64 = requireString(args.dataBase64, "dataBase64");
			const binary = atob(dataBase64);
			const bytes = new Uint8Array(binary.length);
			for (let index = 0; index < binary.length; index++) {
				bytes[index] = binary.charCodeAt(index);
			}
			const file = new File(
				[bytes],
				name,
				typeof args.mimeType === "string" ? { type: args.mimeType } : {},
			);
			const processed = await processMediaAssets({ files: [file] });
			const projectId = editor.project.getActive().metadata.id;
			const imported: Array<{ id: string; name: string; type: string }> = [];
			for (const asset of processed) {
				const added = await editor.media.addMediaAsset({
					projectId,
					asset,
				});
				if (added) {
					imported.push({ id: added.id, name: added.name, type: added.type });
				}
			}
			if (imported.length === 0) {
				throw new Error("Media import produced no assets");
			}
			return { assets: imported };
		},
	},

	"export.start": {
		description:
			"Render and export the active project. The rendered file downloads in the browser when finished. Long-running for long timelines.",
		args: {
			format: "'mp4' | 'webm' (default mp4)",
			quality: "'low' | 'medium' | 'high' | 'source'? (default high)",
			fps: "number?",
			includeAudio: "boolean? (default true)",
		},
		run: async ({ editor, args }) => {
			const options: ExportOptions = {
				format: (args.format as ExportOptions["format"]) ?? "mp4",
				quality: (args.quality as ExportOptions["quality"]) ?? "high",
				...(typeof args.fps === "number" ? { fps: args.fps as never } : {}),
				includeAudio: args.includeAudio !== false,
			};
			const result = await editor.renderer.exportProject({ options });
			if (!result.success || !result.buffer) {
				throw new Error(result.error ?? "Export failed");
			}
			const project = editor.project.getActive();
			const safeName =
				project.metadata.name.replace(/[<>:"/\\|?*]/g, "-").trim() ||
				"export";
			const blob = new Blob([result.buffer], {
				type: `video/${options.format}`,
			});
			const objectUrl = URL.createObjectURL(blob);
			const anchor = document.createElement("a");
			anchor.href = objectUrl;
			anchor.download = `${safeName}.${options.format}`;
			anchor.click();
			setTimeout(() => URL.revokeObjectURL(objectUrl), 10_000);
			return { success: true, filename: anchor.download };
		},
	},

	"export.status": {
		description:
			"Get the current export state: whether an export is running and its progress (0-1).",
		run: ({ editor }) => {
			const state = editor.project.getExportState();
			return {
				isExporting: state.isExporting,
				progress: state.progress,
				result: sanitizeJson(state.result),
			};
		},
	},

	"export.cancel": {
		description: "Cancel the running export.",
		run: ({ editor }) => {
			editor.project.cancelExport();
			return { cancelled: true };
		},
	},

	"selection.get": {
		description:
			"Get the current selection (ids only): elements, keyframes and mask points. Use selection.describe for full details.",
		run: ({ editor }) => buildSelectionState(editor),
	},

	"selection.describe": {
		description:
			'Describe the current selection in detail: selected elements with track type, element type, name, timing (seconds) and text content, plus selected keyframes and mask points. Use this to understand what "the selected part" refers to.',
		run: ({ editor }) => {
			const elements = editor.selection.getSelectedElements().map((ref) => {
				const found = findTrackAndElement(editor, ref.trackId, ref.elementId);
				if (!found) {
					return { ...ref, error: "element not found" };
				}
				const { element } = found;
				const params = (element.params ?? {}) as Record<string, unknown>;
				return {
					trackId: ref.trackId,
					elementId: ref.elementId,
					trackType: found.trackType,
					type: (element.type as string | undefined) ?? null,
					name: (element.name as string | undefined) ?? null,
					startTime: toSeconds(element.startTime as MediaTime),
					duration: toSeconds(element.duration as MediaTime),
					...(typeof params.content === "string"
						? { text: params.content }
						: {}),
					...(typeof element.mediaId === "string"
						? { mediaId: element.mediaId }
						: {}),
					...(typeof element.muted === "boolean"
						? { muted: element.muted }
						: {}),
					...(typeof element.hidden === "boolean"
						? { hidden: element.hidden }
						: {}),
					effectCount: Array.isArray(element.effects)
						? element.effects.length
						: 0,
					maskCount: Array.isArray(element.masks) ? element.masks.length : 0,
				};
			});
			return {
				...buildSelectionState(editor),
				elements,
			};
		},
	},

	"selection.set": {
		description: "Replace the current selection.",
		args: { elements: "[{ trackId, elementId }]" },
		run: ({ editor, args }) => {
			editor.selection.setSelectedElements({
				elements: requireElementRefs(args.elements),
			});
			return { selected: editor.selection.getSelectedElements() };
		},
	},

	"selection.clear": {
		description: "Clear the selection.",
		run: ({ editor }) => {
			editor.selection.clearSelection();
			return { selected: [] };
		},
	},

	"playback.play": {
		description: "Start playback.",
		run: ({ editor }) => {
			editor.playback.play();
			return { isPlaying: true };
		},
	},

	"playback.pause": {
		description: "Pause playback.",
		run: ({ editor }) => {
			editor.playback.pause();
			return { isPlaying: false };
		},
	},

	"playback.seek": {
		description: "Seek the playhead to a time (seconds).",
		args: { time: "seconds" },
		run: ({ editor, args }) => {
			editor.playback.seek({
				time: toTicks(requireNumber(args.time, "time")),
			});
			return { time: toSeconds(editor.playback.getCurrentTime()) };
		},
	},

	"playback.set_volume": {
		description: "Set preview volume (0-1).",
		args: { volume: "number 0-1" },
		run: ({ editor, args }) => {
			editor.playback.setVolume({
				volume: requireNumber(args.volume, "volume"),
			});
			return { volume: editor.playback.getVolume() };
		},
	},

	"playback.toggle_mute": {
		description: "Toggle preview mute.",
		run: ({ editor }) => {
			editor.playback.toggleMute();
			return { muted: editor.playback.isMuted() };
		},
	},

	"history.undo": {
		description:
			"Undo the last command. Returns the label of the undone command.",
		run: ({ editor }) => {
			const entry = editor.command.undo();
			return {
				undone: entry?.label ?? null,
				canUndo: editor.command.canUndo(),
			};
		},
	},

	"history.redo": {
		description:
			"Redo the last undone command. Returns the label of the redone command.",
		run: ({ editor }) => {
			const entry = editor.command.redo();
			return {
				redone: entry?.label ?? null,
				canRedo: editor.command.canRedo(),
			};
		},
	},

	"history.list": {
		description:
			"List the undo history (oldest first) with command labels, affected element names (targets), sources (user/agent) and timestamps, plus the number of redoable commands.",
		run: ({ editor }) => ({
			history: editor.command.getHistory().map((entry, index) => ({
				index,
				label: entry.label,
				targets: entry.targets ?? [],
				source: entry.source,
				timestamp: entry.timestamp,
			})),
			redoCount: editor.command.getRedoStack().length,
		}),
	},

	"scenes.list": {
		description: "List scenes and the active scene id.",
		run: ({ editor }) => ({
			scenes: editor.scenes
				.getScenes()
				.map((scene) => ({ id: scene.id, name: scene.name })),
			activeSceneId: editor.scenes.getActiveSceneOrNull()?.id ?? null,
		}),
	},

	"scenes.create": {
		description: "Create a scene. Returns the new scene id.",
		args: { name: "string" },
		run: async ({ editor, args }) => ({
			sceneId: await editor.scenes.createScene({
				name: requireString(args.name, "name"),
				isMain: false,
			}),
		}),
	},

	"scenes.switch": {
		description: "Switch the active scene.",
		args: { sceneId: "string" },
		run: async ({ editor, args }) => {
			await editor.scenes.switchToScene({
				sceneId: requireString(args.sceneId, "sceneId"),
			});
			return { activeSceneId: editor.scenes.getActiveSceneOrNull()?.id };
		},
	},

	"scenes.rename": {
		description: "Rename a scene.",
		args: { sceneId: "string", name: "string" },
		run: async ({ editor, args }) => {
			await editor.scenes.renameScene({
				sceneId: requireString(args.sceneId, "sceneId"),
				name: requireString(args.name, "name"),
			});
			return { renamed: true };
		},
	},

	"scenes.delete": {
		description: "Delete a scene (main scene cannot be deleted).",
		args: { sceneId: "string" },
		run: async ({ editor, args }) => {
			await editor.scenes.deleteScene({
				sceneId: requireString(args.sceneId, "sceneId"),
			});
			return { deleted: true };
		},
	},

	"project.rename": {
		description: "Rename the active project.",
		args: { name: "string" },
		run: async ({ editor, args }) => {
			const project = editor.project.getActive();
			await editor.project.renameProject({
				id: project.metadata.id,
				name: requireString(args.name, "name"),
			});
			return { renamed: true };
		},
	},

	"project.list": {
		description: "List all saved projects (id, name, updatedAt).",
		run: async () => {
			const metadata = await storageService.loadAllProjectsMetadata();
			return {
				projects: metadata.map((project) => ({
					id: project.id,
					name: project.name,
					updatedAt: project.updatedAt,
				})),
			};
		},
	},

	"project.open": {
		description:
			"Open another saved project in this editor page by id. The bridge session stays connected. Use project.list to discover ids.",
		args: { projectId: "string" },
		run: async ({ editor, args }) => {
			await editor.project.loadProject({
				id: requireString(args.projectId, "projectId"),
			});
			const project = editor.project.getActive();
			return {
				projectId: project.metadata.id,
				projectName: project.metadata.name,
			};
		},
	},

	"project.update_settings": {
		description:
			"Update project settings (e.g. canvasSize, fps, background).",
		args: { settings: "Partial<ProjectSettings>" },
		run: ({ editor, args }) => {
			if (!args.settings || typeof args.settings !== "object") {
				throw new Error("Missing or invalid argument: settings");
			}
			editor.project.updateSettings({
				settings: args.settings as never,
			});
			return { updated: true };
		},
	},

	"media.list": {
		description: "List imported media assets.",
		run: ({ editor }) => ({
			assets: editor.media.getAssets().map((asset) => ({
				id: asset.id,
				name: asset.name,
				type: asset.type,
				duration: asset.duration,
				width: asset.width,
				height: asset.height,
				fps: asset.fps,
			})),
		}),
	},

	"preview.capture": {
		description:
			"Capture a preview frame as a downscaled JPEG data URL. Renders at the given time (seconds) or the current playhead.",
		args: { time: "seconds?" },
		run: async ({ editor, args }) => {
			const renderTree = editor.renderer.getRenderTree();
			const project = editor.project.getActiveOrNull();
			if (!renderTree || !project) {
				throw new Error(
					"Preview is not ready. Make sure the editor page with the preview panel is open.",
				);
			}
			const duration = editor.timeline.getTotalDuration();
			if (duration === 0) {
				throw new Error("Project is empty");
			}

			const renderTime = Math.min(
				typeof args.time === "number"
					? toTicks(args.time)
					: editor.playback.getCurrentTime(),
				editor.timeline.getLastFrameTime(),
			);

			const { canvasSize, fps } = project.settings;
			const renderer = new CanvasRenderer({
				width: canvasSize.width,
				height: canvasSize.height,
				fps,
			});
			const canvas = document.createElement("canvas");
			canvas.width = canvasSize.width;
			canvas.height = canvasSize.height;
			await renderer.renderToCanvas({
				node: renderTree,
				time: renderTime,
				targetCanvas: canvas,
			});

			// 降采样到长边 1280 并输出 JPEG：全尺寸 PNG base64 后会超过
			// agent SDK 1MB 消息缓冲上限，且视觉模型本身会再缩放
			const MAX_EDGE = 1280;
			const scale = Math.min(
				1,
				MAX_EDGE / Math.max(canvas.width, canvas.height),
			);
			const outWidth = Math.round(canvas.width * scale);
			const outHeight = Math.round(canvas.height * scale);
			let source = canvas;
			if (scale < 1) {
				const small = document.createElement("canvas");
				small.width = outWidth;
				small.height = outHeight;
				const ctx = small.getContext("2d");
				if (!ctx) {
					throw new Error("Failed to create downscale canvas context");
				}
				ctx.drawImage(canvas, 0, 0, outWidth, outHeight);
				source = small;
			}

			return {
				dataUrl: source.toDataURL("image/jpeg", 0.85),
				width: outWidth,
				height: outHeight,
				time: toSeconds(renderTime as MediaTime),
			};
		},
	},

	"keyframes.upsert": {
		description:
			"Create or update element animation keyframes. Times in seconds, relative to the timeline (not element-local).",
		args: {
			keyframes:
				"[{ trackId, elementId, propertyPath, time, value, interpolation?, keyframeId? }] (interpolation: linear|hold|bezier; pass keyframeId to update an existing keyframe)",
		},
		run: ({ editor, args }) => {
			const raw = args.keyframes as Array<Record<string, unknown>> | undefined;
			if (!raw || raw.length === 0) {
				throw new Error("Missing or invalid argument: keyframes");
			}
			editor.timeline.upsertKeyframes({
				keyframes: raw.map((keyframe) => ({
					trackId: requireString(keyframe.trackId, "keyframes[].trackId"),
					elementId: requireString(keyframe.elementId, "keyframes[].elementId"),
					propertyPath: requireString(
						keyframe.propertyPath,
						"keyframes[].propertyPath",
					),
					time: toTicks(requireNumber(keyframe.time, "keyframes[].time")),
					value: keyframe.value as never,
					interpolation: requireInterpolation(
						keyframe.interpolation,
						KEYFRAME_INTERPOLATIONS,
					),
					...(typeof keyframe.keyframeId === "string"
						? { keyframeId: keyframe.keyframeId }
						: {}),
				})),
			});
			return { upserted: raw.length };
		},
	},

	"keyframes.remove": {
		description:
			"Remove keyframes. The element's value at the current playhead is preserved as a static value.",
		args: {
			keyframes: "[{ trackId, elementId, propertyPath, keyframeId }]",
		},
		run: ({ editor, args }) => {
			const raw = args.keyframes as Array<Record<string, unknown>> | undefined;
			if (!raw || raw.length === 0) {
				throw new Error("Missing or invalid argument: keyframes");
			}
			editor.timeline.removeKeyframes({
				keyframes: raw.map((keyframe) => ({
					trackId: requireString(keyframe.trackId, "keyframes[].trackId"),
					elementId: requireString(keyframe.elementId, "keyframes[].elementId"),
					propertyPath: requireString(
						keyframe.propertyPath,
						"keyframes[].propertyPath",
					),
					keyframeId: requireString(
						keyframe.keyframeId,
						"keyframes[].keyframeId",
					),
				})),
			});
			return { removed: raw.length };
		},
	},

	"keyframes.retime": {
		description: "Move a keyframe to a new time (seconds).",
		args: {
			trackId: "string",
			elementId: "string",
			propertyPath: "string",
			keyframeId: "string",
			time: "seconds",
		},
		run: ({ editor, args }) => {
			editor.timeline.retimeKeyframe({
				trackId: requireString(args.trackId, "trackId"),
				elementId: requireString(args.elementId, "elementId"),
				propertyPath: requireString(args.propertyPath, "propertyPath"),
				keyframeId: requireString(args.keyframeId, "keyframeId"),
				time: toTicks(requireNumber(args.time, "time")),
			});
			return { retimed: true };
		},
	},

	"keyframes.update_curves": {
		description:
			"Update keyframe bezier curve handles. Handle dt values are in seconds.",
		args: {
			keyframes:
				"[{ trackId, elementId, propertyPath, componentKey, keyframeId, patch }]",
		},
		run: ({ editor, args }) => {
			const raw = args.keyframes as Array<Record<string, unknown>> | undefined;
			if (!raw || raw.length === 0) {
				throw new Error("Missing or invalid argument: keyframes");
			}
			editor.timeline.updateKeyframeCurves({
				keyframes: raw.map((keyframe) => {
					const patch = { ...(keyframe.patch as Record<string, unknown>) };
					for (const handleKey of ["leftHandle", "rightHandle"] as const) {
						const handle = patch[handleKey] as
							| { dt?: number; dv?: number }
							| null
							| undefined;
						if (handle && typeof handle.dt === "number") {
							patch[handleKey] = { ...handle, dt: toTicks(handle.dt) };
						}
					}
					return {
						trackId: requireString(keyframe.trackId, "keyframes[].trackId"),
						elementId: requireString(
							keyframe.elementId,
							"keyframes[].elementId",
						),
						propertyPath: requireString(
							keyframe.propertyPath,
							"keyframes[].propertyPath",
						),
						componentKey: requireString(
							keyframe.componentKey,
							"keyframes[].componentKey",
						),
						keyframeId: requireString(
							keyframe.keyframeId,
							"keyframes[].keyframeId",
						),
						patch: patch as never,
					};
				}),
			});
			return { updated: raw.length };
		},
	},

	"effects.list": {
		description:
			"List all registered effect types with their parameter definitions (key, type, default, min, max, options).",
		run: () => ({
			effects: effectsRegistry.getAll().map((definition) => ({
				type: definition.type,
				name: definition.name,
				keywords: definition.keywords,
				params: sanitizeJson(definition.params),
			})),
		}),
	},

	"effects.add": {
		description:
			"Add an effect to a visual element with default params. Returns the new effectId. Use effects.list to discover effectType values.",
		args: { trackId: "string", elementId: "string", effectType: "string" },
		run: ({ editor, args }) => ({
			effectId: editor.timeline.addClipEffect({
				trackId: requireString(args.trackId, "trackId"),
				elementId: requireString(args.elementId, "elementId"),
				effectType: requireString(args.effectType, "effectType"),
			}),
		}),
	},

	"effects.remove": {
		description: "Remove an effect from an element.",
		args: { trackId: "string", elementId: "string", effectId: "string" },
		run: ({ editor, args }) => {
			editor.timeline.removeClipEffect({
				trackId: requireString(args.trackId, "trackId"),
				elementId: requireString(args.elementId, "elementId"),
				effectId: requireString(args.effectId, "effectId"),
			});
			return { removed: true };
		},
	},

	"effects.update_params": {
		description: "Patch an effect's params on an element.",
		args: {
			trackId: "string",
			elementId: "string",
			effectId: "string",
			params: "Partial param values",
			pushHistory: "boolean? (default true)",
		},
		run: ({ editor, args }) => {
			if (!args.params || typeof args.params !== "object") {
				throw new Error("Missing or invalid argument: params");
			}
			editor.timeline.updateClipEffectParams({
				trackId: requireString(args.trackId, "trackId"),
				elementId: requireString(args.elementId, "elementId"),
				effectId: requireString(args.effectId, "effectId"),
				params: args.params as never,
				...(typeof args.pushHistory === "boolean"
					? { pushHistory: args.pushHistory }
					: {}),
			});
			return { updated: true };
		},
	},

	"effects.toggle": {
		description: "Enable or disable an effect on an element.",
		args: { trackId: "string", elementId: "string", effectId: "string" },
		run: ({ editor, args }) => {
			editor.timeline.toggleClipEffect({
				trackId: requireString(args.trackId, "trackId"),
				elementId: requireString(args.elementId, "elementId"),
				effectId: requireString(args.effectId, "effectId"),
			});
			return { toggled: true };
		},
	},

	"effects.reorder": {
		description: "Reorder the effect stack on an element.",
		args: {
			trackId: "string",
			elementId: "string",
			fromIndex: "number",
			toIndex: "number",
		},
		run: ({ editor, args }) => {
			editor.timeline.reorderClipEffects({
				trackId: requireString(args.trackId, "trackId"),
				elementId: requireString(args.elementId, "elementId"),
				fromIndex: requireNumber(args.fromIndex, "fromIndex"),
				toIndex: requireNumber(args.toIndex, "toIndex"),
			});
			return { reordered: true };
		},
	},

	"effects.upsert_keyframe": {
		description:
			"Animate an effect param over time. Time in seconds; interpolation: linear|hold.",
		args: {
			trackId: "string",
			elementId: "string",
			effectId: "string",
			paramKey: "string",
			time: "seconds",
			value: "number",
			interpolation: "'linear' | 'hold'?",
			keyframeId: "string? (update existing)",
		},
		run: ({ editor, args }) => {
			editor.timeline.upsertEffectParamKeyframe({
				trackId: requireString(args.trackId, "trackId"),
				elementId: requireString(args.elementId, "elementId"),
				effectId: requireString(args.effectId, "effectId"),
				paramKey: requireString(args.paramKey, "paramKey"),
				time: toTicks(requireNumber(args.time, "time")),
				value: requireNumber(args.value, "value"),
				interpolation: requireInterpolation(args.interpolation, [
					"linear",
					"hold",
				]) as "linear" | "hold",
				...(typeof args.keyframeId === "string"
					? { keyframeId: args.keyframeId }
					: {}),
			});
			return { upserted: true };
		},
	},

	"effects.remove_keyframe": {
		description: "Remove an effect param keyframe.",
		args: {
			trackId: "string",
			elementId: "string",
			effectId: "string",
			paramKey: "string",
			keyframeId: "string",
		},
		run: ({ editor, args }) => {
			editor.timeline.removeEffectParamKeyframe({
				trackId: requireString(args.trackId, "trackId"),
				elementId: requireString(args.elementId, "elementId"),
				effectId: requireString(args.effectId, "effectId"),
				paramKey: requireString(args.paramKey, "paramKey"),
				keyframeId: requireString(args.keyframeId, "keyframeId"),
			});
			return { removed: true };
		},
	},

	"masks.list": {
		description:
			"List all mask types (rectangle, ellipse, star, freeform, ...) with their parameter definitions.",
		run: () => ({
			masks: getMaskDefinitionsForMenu().map((definition) => ({
				type: definition.type,
				name: definition.name,
				params: sanitizeJson(definition.params),
			})),
		}),
	},

	"masks.add": {
		description:
			"Add a mask with default params to an element. Returns the new maskId. Use masks.list to discover maskType values.",
		args: { trackId: "string", elementId: "string", maskType: "string" },
		run: ({ editor, args }) => {
			const trackId = requireString(args.trackId, "trackId");
			const elementId = requireString(args.elementId, "elementId");
			const mask = buildDefaultMaskInstance({
				maskType: requireString(args.maskType, "maskType") as MaskType,
			});
			const existing = getElementMasks(editor, trackId, elementId);
			editor.timeline.updateElements({
				updates: [
					{
						trackId,
						elementId,
						patch: { masks: [...existing, mask] } as never,
					},
				],
			});
			return { maskId: mask.id };
		},
	},

	"masks.remove": {
		description: "Remove a mask from an element.",
		args: { trackId: "string", elementId: "string", maskId: "string" },
		run: ({ editor, args }) => {
			editor.timeline.removeMask({
				trackId: requireString(args.trackId, "trackId"),
				elementId: requireString(args.elementId, "elementId"),
				maskId: requireString(args.maskId, "maskId"),
			});
			return { removed: true };
		},
	},

	"masks.toggle_inverted": {
		description: "Invert a mask (show outside instead of inside).",
		args: { trackId: "string", elementId: "string", maskId: "string" },
		run: ({ editor, args }) => {
			editor.timeline.toggleMaskInverted({
				trackId: requireString(args.trackId, "trackId"),
				elementId: requireString(args.elementId, "elementId"),
				maskId: requireString(args.maskId, "maskId"),
			});
			return { toggled: true };
		},
	},

	"masks.update_params": {
		description: "Patch a mask's params (e.g. feather, centerX, centerY).",
		args: {
			trackId: "string",
			elementId: "string",
			maskId: "string",
			params: "Partial mask params",
		},
		run: ({ editor, args }) => {
			const trackId = requireString(args.trackId, "trackId");
			const elementId = requireString(args.elementId, "elementId");
			const maskId = requireString(args.maskId, "maskId");
			if (!args.params || typeof args.params !== "object") {
				throw new Error("Missing or invalid argument: params");
			}
			const masks = getElementMasks(editor, trackId, elementId);
			if (!masks.some((mask) => mask.id === maskId)) {
				throw new Error(`Mask not found: ${maskId}`);
			}
			const nextMasks = masks.map((mask) =>
				mask.id === maskId
					? {
							...mask,
							params: {
								...mask.params,
								...(args.params as Record<string, unknown>),
							},
						}
					: mask,
			);
			editor.timeline.updateElements({
				updates: [
					{
						trackId,
						elementId,
						patch: { masks: nextMasks } as never,
					},
				],
			});
			return { updated: true };
		},
	},

	"masks.freeform_set_path": {
		description:
			"Replace a freeform mask's bezier point path. Each point: { x, y, inX?, inY?, outX?, outY? } — x/y is the anchor, in/out are the bezier handles (default to the anchor for sharp corners). Coordinates are relative to the element, in canvas pixels. Existing points keep their id if provided; new ids are generated otherwise. Closed state is corrected automatically.",
		args: {
			trackId: "string",
			elementId: "string",
			maskId: "string",
			points: "[{ id?, x, y, inX?, inY?, outX?, outY? }]",
			closed: "boolean?",
		},
		run: ({ editor, args }) => {
			const trackId = requireString(args.trackId, "trackId");
			const elementId = requireString(args.elementId, "elementId");
			const maskId = requireString(args.maskId, "maskId");
			const rawPoints = args.points;
			if (!Array.isArray(rawPoints) || rawPoints.length === 0) {
				throw new Error("Missing or invalid argument: points");
			}
			const points: FreeformPathPoint[] = rawPoints.map((raw) => {
				const point = raw as Partial<FreeformPathPoint>;
				if (typeof point?.x !== "number" || typeof point?.y !== "number") {
					throw new Error("Each point needs numeric x and y");
				}
				return {
					id: typeof point.id === "string" ? point.id : generateUUID(),
					x: point.x,
					y: point.y,
					inX: typeof point.inX === "number" ? point.inX : point.x,
					inY: typeof point.inY === "number" ? point.inY : point.y,
					outX: typeof point.outX === "number" ? point.outX : point.x,
					outY: typeof point.outY === "number" ? point.outY : point.y,
				};
			});

			const masks = getElementMasks(editor, trackId, elementId);
			const target = masks.find((mask) => mask.id === maskId);
			if (!target) {
				throw new Error(`Mask not found: ${maskId}`);
			}
			if (target.type !== "freeform") {
				throw new Error(`Mask ${maskId} is not a freeform mask`);
			}
			const closed =
				typeof args.closed === "boolean"
					? args.closed
					: target.params.closed && points.length >= 3;

			const nextMasks = masks.map((mask) =>
				mask.id === maskId && mask.type === "freeform"
					? { ...mask, params: { ...mask.params, path: points, closed } }
					: mask,
			);
			editor.timeline.updateElements({
				updates: [
					{
						trackId,
						elementId,
						patch: { masks: nextMasks } as never,
					},
				],
			});
			return { pointCount: points.length, closed };
		},
	},

	"masks.freeform_delete_points": {
		description:
			"Delete specific points from a freeform mask by point id. The mask's closed state is corrected automatically.",
		args: {
			trackId: "string",
			elementId: "string",
			maskId: "string",
			pointIds: "string[]",
		},
		run: ({ editor, args }) => {
			const pointIds = args.pointIds;
			if (!Array.isArray(pointIds) || pointIds.length === 0) {
				throw new Error("Missing or invalid argument: pointIds");
			}
			editor.timeline.deleteFreeformPathMaskPoints({
				trackId: requireString(args.trackId, "trackId"),
				elementId: requireString(args.elementId, "elementId"),
				maskId: requireString(args.maskId, "maskId"),
				pointIds: pointIds.map((pointId) =>
					requireString(pointId, "pointIds[]"),
				),
			});
			return { deleted: pointIds.length };
		},
	},
};
