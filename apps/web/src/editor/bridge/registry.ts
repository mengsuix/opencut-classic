import type { EditorCore } from "@/core";
import { mediaTimeFromSeconds, mediaTimeToSeconds, type MediaTime } from "@/wasm";
import { DEFAULTS } from "@/timeline/defaults";
import { VOLUME_DB_MIN } from "@/timeline/audio-constants";
import {
	buildEffectElement,
	type CreateTimelineElement,
	type TrackType,
} from "@/timeline";
import type { InsertElementParams } from "@/commands/timeline/element/insert-element";
import { CanvasRenderer } from "@/services/renderer/canvas-renderer";
import { effectsRegistry } from "@/effects";
import { graphicsRegistry, registerDefaultGraphics } from "@/graphics";
import { buildDefaultMaskInstance, getMaskDefinitionsForMenu } from "@/masks";
import type { Mask, MaskType } from "@/masks/types";
import type { FreeformPathPoint } from "@/masks/freeform/path";
import { canvasRectToMaskParams } from "@/masks/canvas-rect";
import {
	getVisibleElementsWithBounds,
	type ElementBounds,
} from "@/preview/element-bounds";
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
import { TEXT_PRESETS, getTextPreset } from "@/text/presets";
import { EFFECTS_COMPOSITION_GUIDE } from "@/effects/guide";
import { normalizeGraphicElementInput } from "./insert-validation";
import { validateElementPatchRootKeys } from "./patch-validation";
import { useUserMarksStore } from "@/editor/user-marks-store";

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

function clampNumberArg({
	value,
	fallback,
	min,
	max,
}: {
	value: unknown;
	fallback: number;
	min: number;
	max: number;
}): number {
	if (typeof value !== "number" || !Number.isFinite(value)) {
		return fallback;
	}
	return Math.max(min, Math.min(max, value));
}

function readElementNumberParam({
	element,
	key,
	fallback,
}: {
	element: Record<string, unknown>;
	key: string;
	fallback: number;
}): number {
	const params = element.params as Record<string, unknown> | undefined;
	const value = params?.[key];
	return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/**
 * Bounds of an element visible at the playhead. Layout and attention commands
 * need resolved geometry, which the renderer only produces for elements
 * present at the current time.
 */
function getVisibleElementBounds({
	editor,
	trackId,
	elementId,
}: {
	editor: EditorCore;
	trackId: string;
	elementId: string;
}): { canvasSize: { width: number; height: number }; bounds: ElementBounds } {
	const scene = editor.scenes.getActiveSceneOrNull();
	const project = editor.project.getActiveOrNull();
	if (!scene || !project) {
		throw new Error("No active scene or project");
	}
	const canvasSize = project.settings.canvasSize;
	const withBounds = getVisibleElementsWithBounds({
		tracks: scene.tracks,
		currentTime: editor.playback.getCurrentTime(),
		canvasSize,
		mediaAssets: editor.media.getAssets(),
	});
	const target = withBounds.find(
		(item) => item.trackId === trackId && item.elementId === elementId,
	);
	if (!target) {
		throw new Error(
			`Element ${elementId} is not visible at the playhead. Seek onto it first (playback.seek), then retry.`,
		);
	}
	return { canvasSize, bounds: target.bounds };
}

interface LayoutSlot {
	left: number;
	top: number;
	right: number;
	bottom: number;
}

/**
 * Canvas-fraction rects for each layout preset, in assignment order.
 * Picture-in-picture slots keep the canvas aspect ratio (same fraction of
 * width and height); grid slots tile the canvas evenly.
 */
function buildLayoutSlots({
	preset,
	padding,
	pipScale,
	pipMargin,
}: {
	preset: string;
	padding: number;
	pipScale: number;
	pipMargin: number;
}): LayoutSlot[] | null {
	const inset = (slot: LayoutSlot): LayoutSlot => ({
		left: slot.left + padding,
		top: slot.top + padding,
		right: slot.right - padding,
		bottom: slot.bottom - padding,
	});

	const corners: Record<string, LayoutSlot> = {
		"pip-tl": {
			left: pipMargin,
			top: pipMargin,
			right: pipMargin + pipScale,
			bottom: pipMargin + pipScale,
		},
		"pip-tr": {
			left: 1 - pipMargin - pipScale,
			top: pipMargin,
			right: 1 - pipMargin,
			bottom: pipMargin + pipScale,
		},
		"pip-bl": {
			left: pipMargin,
			top: 1 - pipMargin - pipScale,
			right: pipMargin + pipScale,
			bottom: 1 - pipMargin,
		},
		"pip-br": {
			left: 1 - pipMargin - pipScale,
			top: 1 - pipMargin - pipScale,
			right: 1 - pipMargin,
			bottom: 1 - pipMargin,
		},
	};
	if (preset in corners) {
		return [inset(corners[preset])];
	}

	if (preset === "split-h") {
		return [
			inset({ left: 0, top: 0, right: 0.5, bottom: 1 }),
			inset({ left: 0.5, top: 0, right: 1, bottom: 1 }),
		];
	}
	if (preset === "split-v") {
		return [
			inset({ left: 0, top: 0, right: 1, bottom: 0.5 }),
			inset({ left: 0, top: 0.5, right: 1, bottom: 1 }),
		];
	}
	if (preset === "grid-2x2" || preset === "grid-3x3") {
		const columns = preset === "grid-2x2" ? 2 : 3;
		const slots: LayoutSlot[] = [];
		for (let row = 0; row < columns; row++) {
			for (let column = 0; column < columns; column++) {
				slots.push(
					inset({
						left: column / columns,
						top: row / columns,
						right: (column + 1) / columns,
						bottom: (row + 1) / columns,
					}),
				);
			}
		}
		return slots;
	}
	return null;
}

const SEQUENCE_SIGNATURE_SIZE = 16;
const SEQUENCE_DEDUPE_THRESHOLD = 2.0;
const MAX_SEQUENCE_FRAMES = 24;

/**
 * 16×16 grayscale signature used to spot near-identical frames. Luma only
 * (not a structural hash) so small content changes — a new line of code, a
 * bullet appearing on a slide — stay visible, matching how the eye reads
 * screen recordings.
 */
function buildGraySignature({
	source,
}: {
	source: HTMLCanvasElement;
}): Uint8Array {
	const size = SEQUENCE_SIGNATURE_SIZE;
	const temp = document.createElement("canvas");
	temp.width = size;
	temp.height = size;
	const ctx = temp.getContext("2d");
	if (!ctx) {
		return new Uint8Array(size * size);
	}
	ctx.drawImage(source, 0, 0, source.width, source.height, 0, 0, size, size);
	const data = ctx.getImageData(0, 0, size, size).data;
	const gray = new Uint8Array(size * size);
	for (let index = 0; index < gray.length; index++) {
		const offset = index * 4;
		gray[index] =
			(data[offset] * 0.299 +
				data[offset + 1] * 0.587 +
				data[offset + 2] * 0.114) |
			0;
	}
	return gray;
}

/** Mean absolute per-pixel difference between two grayscale signatures. */
function frameDelta({ a, b }: { a: Uint8Array; b: Uint8Array }): number {
	if (a.length === 0 || a.length !== b.length) {
		return Number.POSITIVE_INFINITY;
	}
	let sum = 0;
	for (let index = 0; index < a.length; index++) {
		sum += Math.abs(a[index] - b[index]);
	}
	return sum / a.length;
}

function formatClock({ seconds }: { seconds: number }): string {
	const total = Math.max(0, seconds);
	// Split into whole seconds and tenths first: formatting the fractional part
	// with toFixed would render 59.95s as "0:60.0" instead of "1:00.0".
	const whole = Math.floor(total);
	const hours = Math.floor(whole / 3600);
	const minutes = Math.floor((whole - hours * 3600) / 60);
	const secs = whole - hours * 3600 - minutes * 60;
	const tenths = Math.floor((total - whole) * 10);
	const time = `${minutes}:${String(secs).padStart(2, "0")}.${tenths}`;
	return hours > 0 ? `${hours}:${time.padStart(7, "0")}` : time;
}

/**
 * Compose sampled frames into one labelled grid image. A single sheet keeps
 * the agent's image cost flat regardless of how many frames survived dedupe.
 */
function buildContactSheet({
	frames,
	cellWidth,
	cellHeight,
}: {
	frames: Array<{ time: number; canvas: HTMLCanvasElement }>;
	cellWidth: number;
	cellHeight: number;
}): HTMLCanvasElement {
	const columns = Math.max(
		1,
		Math.min(frames.length, Math.ceil(Math.sqrt(frames.length))),
	);
	const rows = Math.ceil(frames.length / columns);
	const gap = 4;
	const labelHeight = 18;
	const sheet = document.createElement("canvas");
	sheet.width = columns * cellWidth + (columns - 1) * gap;
	sheet.height = rows * (cellHeight + labelHeight) + (rows - 1) * gap;
	const ctx = sheet.getContext("2d");
	if (!ctx) {
		throw new Error("Failed to create contact sheet context");
	}
	ctx.fillStyle = "#111111";
	ctx.fillRect(0, 0, sheet.width, sheet.height);

	frames.forEach((frame, index) => {
		const column = index % columns;
		const row = Math.floor(index / columns);
		const x = column * (cellWidth + gap);
		const y = row * (cellHeight + labelHeight + gap);
		ctx.drawImage(frame.canvas, x, y, cellWidth, cellHeight);
		ctx.fillStyle = "#000000";
		ctx.fillRect(x, y + cellHeight, cellWidth, labelHeight);
		ctx.fillStyle = "#ffffff";
		ctx.font = "12px monospace";
		ctx.textBaseline = "middle";
		ctx.fillText(
			formatClock({ seconds: frame.time }),
			x + 6,
			y + cellHeight + labelHeight / 2,
		);
	});
	return sheet;
}

function buildSelectionState(editor: EditorCore) {
	return {
		kind: editor.selection.getActiveSelectionKind(),
		elements: editor.selection.getSelectedElements(),
		keyframes: editor.selection.getSelectedKeyframes(),
		maskPoints: editor.selection.getSelectedMaskPointSelection(),
	};
}

function describeSelection(editor: EditorCore) {
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
			...(typeof params.content === "string" ? { text: params.content } : {}),
			...(typeof element.mediaId === "string"
				? { mediaId: element.mediaId }
				: {}),
			...(typeof element.muted === "boolean" ? { muted: element.muted } : {}),
			...(typeof element.hidden === "boolean"
				? { hidden: element.hidden }
				: {}),
			effectCount: Array.isArray(element.effects) ? element.effects.length : 0,
			maskCount: Array.isArray(element.masks) ? element.masks.length : 0,
		};
	});
	return {
		...buildSelectionState(editor),
		elements,
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
		selection: describeSelection(editor),
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
		trackOrder: tracks
			? [...tracks.overlay, tracks.main, ...tracks.audio].map((track, row) => ({
					row,
					id: track.id,
					type: track.type,
					name: track.name,
				}))
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
			"Add a text element with sensible defaults. Returns the inserted element ref. Text style params include stroke.enabled/stroke.color/stroke.width, shadow.enabled/shadow.color/shadow.blur/shadow.offsetX/shadow.offsetY, gradient.enabled/gradient.color/gradient.angle, and entrance animation animIn.type (none|fade|pop|typewriter) + animIn.duration (seconds).",
		args: {
			content: "string",
			startTime: "seconds?",
			duration: "seconds?",
			trackId: "string? (omit for auto placement)",
			preset: "string? (text style preset key, see text.list_presets)",
			params: "object? (override any text params, e.g. fontSize, color; applied after preset)",
		},
		run: ({ editor, args }) => {
			const base = structuredClone(DEFAULTS.text.element);
			const preset =
				typeof args.preset === "string"
					? getTextPreset({ key: args.preset })
					: null;
			if (args.preset != null && !preset) {
				throw new Error(
					`Unknown text preset: ${String(args.preset)}. Use text.list_presets to discover valid keys.`,
				);
			}
			const element = {
				...base,
				startTime: toTicks(Number(args.startTime ?? 0)),
				duration:
					args.duration != null ? toTicks(Number(args.duration)) : base.duration,
				params: {
					...base.params,
					...(preset?.params ?? {}),
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

	"text.list_presets": {
		description:
			"List text style presets (花字模板) with their param bundles. Apply when adding via timeline.add_text preset arg, or to an existing element via text.apply_preset.",
		run: () => ({
			presets: TEXT_PRESETS.map((preset) => ({
				key: preset.key,
				name: preset.name,
				params: sanitizeJson(preset.params),
			})),
		}),
	},

	"text.apply_preset": {
		description:
			"Apply a text style preset to an existing text element (see text.list_presets).",
		args: {
			trackId: "string",
			elementId: "string",
			preset: "string",
			pushHistory: "boolean? (default true)",
		},
		run: ({ editor, args }) => {
			const preset = getTextPreset({
				key: requireString(args.preset, "preset"),
			});
			if (!preset) {
				throw new Error(
					`Unknown text preset: ${String(args.preset)}. Use text.list_presets to discover valid keys.`,
				);
			}
			const trackId = requireString(args.trackId, "trackId");
			const elementId = requireString(args.elementId, "elementId");
			const tracks = editor.scenes.getActiveSceneOrNull()?.tracks;
			let elementType: string | null = null;
			if (tracks) {
				for (const track of [...tracks.overlay, tracks.main, ...tracks.audio]) {
					for (const candidate of track.elements) {
						if (candidate.id === elementId) {
							elementType = candidate.type;
						}
					}
				}
			}
			if (elementType !== "text") {
				throw new Error(`Element ${elementId} is not a text element`);
			}
			editor.timeline.updateElements({
				updates: [
					{
						trackId,
						elementId,
						patch: { params: { ...preset.params } },
					},
				],
				...(typeof args.pushHistory === "boolean"
					? { pushHistory: args.pushHistory }
					: {}),
			});
			return { applied: preset.key };
		},
	},

	"graphics.list": {
		description:
			"List all registered graphic definitions and their parameters. Use a returned id as element.definitionId when inserting a graphic.",
		run: () => {
			registerDefaultGraphics();
			return {
				graphics: graphicsRegistry.getAll().map((definition) => ({
					id: definition.id,
					name: definition.name,
					keywords: definition.keywords,
					params: sanitizeJson(definition.params),
				})),
			};
		},
	},

	"timeline.insert_element": {
		description:
			"Insert a raw timeline element (times in seconds). For media elements pass mediaId from mediaAssets. Graphic elements require element.definitionId from graphics.list. Returns the inserted element ref.",
		args: {
			element:
				"CreateTimelineElement with seconds for startTime/duration/trimStart/trimEnd. For type:'graphic', include definitionId from graphics.list; params are optional.",
			placement:
				"{ mode: 'explicit', trackId } | { mode: 'auto', trackType? } (default auto)",
		},
		run: ({ editor, args }) => {
			const raw = args.element as Record<string, unknown> | undefined;
			if (!raw || typeof raw.type !== "string") {
				throw new Error("Missing or invalid argument: element");
			}
			const converted = convertTimePatch(raw);
			const element = normalizeGraphicElementInput(
				converted,
			) as unknown as CreateTimelineElement;
			const placement = (args.placement ??
				({ mode: "auto" } as const)) as InsertElementParams["placement"];
			return insertAndSelect(editor, element, placement);
		},
	},

	"timeline.update_elements": {
		description:
			'Patch elements. Visual props go in patch.params as flat keys, e.g. { params: { "transform.positionX": 120, "transform.positionY": 680, "opacity": 0.5 } }; time fields (startTime/duration/trimStart/trimEnd, seconds) at patch root. Unknown root fields are rejected.',
		args: {
			updates: "[{ trackId, elementId, patch }]",
			pushHistory: "boolean? (default true)",
		},
		run: ({ editor, args }) => {
			const updates = (
				args.updates as Array<Record<string, unknown>> | undefined
			)?.map((update) => {
				const rawPatch = (update.patch ?? {}) as Record<string, unknown>;
				validateElementPatchRootKeys(rawPatch);
				return {
					trackId: requireString(update.trackId, "updates[].trackId"),
					elementId: requireString(update.elementId, "updates[].elementId"),
					patch: convertTimePatch(rawPatch),
				};
			});
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

	"timeline.freeze_frame": {
		description:
			"Freeze a video at a point in time: splits the element, inserts a frozen still segment of `duration` seconds (default 3) holding the frame at `time` (seconds, default: current playhead), and ripples the remainder right. Frozen segments are muted and can be extended by trimming.",
		args: {
			trackId: "string",
			elementId: "string",
			time: "seconds? (default: playhead)",
			duration: "seconds? (default: 3)",
		},
		run: ({ editor, args }) => {
			editor.timeline.freezeFrame({
				trackId: requireString(args.trackId, "trackId"),
				elementId: requireString(args.elementId, "elementId"),
				time:
					typeof args.time === "number"
						? toTicks(args.time)
						: editor.playback.getCurrentTime(),
				...(typeof args.duration === "number"
					? { duration: toTicks(args.duration) }
					: {}),
			});
			return { frozen: true };
		},
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
		run: ({ editor }) => describeSelection(editor),
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

	"marks.get": {
		description:
			"Get the user's visual marks for pointing at regions: canvasRects = rects the user drew on the preview (each with a numeric id shown on the rect, plus canvas fractions 0~1, top-left origin — the same coordinate system as masks.set_canvas_rect, usable directly as its rect; includes the playhead time in seconds it was drawn at), timeRanges = time ranges the user marked on the timeline (each with a numeric id shown on the band; seconds; numbered separately from canvasRects). The user can mark several of each and may point at one by its number; both are empty arrays when nothing is marked.",
		run: () => {
			const { canvasRects, timeRanges } = useUserMarksStore.getState();
			return { canvasRects, timeRanges };
		},
	},

	"marks.clear": {
		description:
			"Clear user marks (after consuming them) — canvasRects (preview regions) and/or timeRanges (timeline ranges).",
		args: { target: "'canvasRects' | 'timeRanges' | 'all' (default 'all')" },
		run: ({ args }) => {
			const target =
				typeof args.target === "string" && args.target ? args.target : "all";
			const store = useUserMarksStore.getState();
			if (target === "all") {
				store.clearCanvasRects();
				store.clearTimeRanges();
			} else if (target === "canvasRects") {
				store.clearCanvasRects();
			} else if (target === "timeRanges") {
				store.clearTimeRanges();
			} else {
				throw new Error(
					`Invalid target: ${target}. Use 'canvasRects', 'timeRanges' or 'all'.`,
				);
			}
			return { cleared: target };
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

	"history.jumpTo": {
		description:
			"Jump to a specific history position by undoing/redoing as needed. targetLength = number of commands that remain applied: 0 undoes everything, history.length keeps all applied. To undo the entry at index i from history.list, jump to targetLength = i. Always call history.list first to choose the position.",
		args: { targetLength: "number" },
		run: ({ editor, args }) => {
			editor.command.jumpTo({
				targetLength: requireNumber(args.targetLength, "targetLength"),
			});
			return {
				appliedCount: editor.command.getHistory().length,
				redoCount: editor.command.getRedoStack().length,
			};
		},
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

	"preview.capture_sequence": {
		description:
			"Sample several frames across a time range in ONE call and return a single contact sheet: a grid of frames, each labelled with its timestamp. Near-identical consecutive frames are dropped by default (16×16 grayscale mean-absolute-difference), so static stretches collapse into one frame. Use this to understand a clip's structure cheaply; follow up with preview.capture when one moment needs full detail.",
		args: {
			start: "seconds? (default 0)",
			end: "seconds? (default project duration)",
			count: "number? (frames to sample before dedupe, default 9, max 24)",
			timestamps:
				"number[]? (explicit sample times in seconds; overrides start/end/count)",
			dedupe: "boolean? (default true)",
			cellWidth: "number? (px width of each cell, default 320)",
		},
		run: async ({ editor, args }) => {
			const renderTree = editor.renderer.getRenderTree();
			const project = editor.project.getActiveOrNull();
			if (!renderTree || !project) {
				throw new Error(
					"Preview is not ready. Make sure the editor page with the preview panel is open.",
				);
			}
			const durationTicks = editor.timeline.getTotalDuration();
			if (durationTicks === 0) {
				throw new Error("Project is empty");
			}
			const durationSeconds = toSeconds(durationTicks as MediaTime);
			const lastFrameTime = editor.timeline.getLastFrameTime();

			const rawTimestamps = args.timestamps;
			let times: number[];
			if (Array.isArray(rawTimestamps) && rawTimestamps.length > 0) {
				times = rawTimestamps.map((value) =>
					requireNumber(value, "timestamps[]"),
				);
			} else {
				const start = clampNumberArg({
					value: args.start,
					fallback: 0,
					min: 0,
					max: durationSeconds,
				});
				const end = clampNumberArg({
					value: args.end,
					fallback: durationSeconds,
					min: 0,
					max: durationSeconds,
				});
				if (end <= start) {
					throw new Error("end must be greater than start");
				}
				const rawCount =
					typeof args.count === "number" && Number.isFinite(args.count)
						? args.count
						: 9;
				const count = Math.round(rawCount);
				// Reject instead of silently clamping: a caller that asked for 100
				// frames must not be told it got them when only 24 were sampled.
				if (count < 1 || count > MAX_SEQUENCE_FRAMES) {
					throw new Error(
						`count must be between 1 and ${MAX_SEQUENCE_FRAMES}, got ${rawCount}`,
					);
				}
				// Midpoints of equal slices: stays inside each slice and avoids
				// landing exactly on a cut.
				times = Array.from(
					{ length: count },
					(_, index) => start + ((end - start) * (index + 0.5)) / count,
				);
			}
			if (times.length > MAX_SEQUENCE_FRAMES) {
				throw new Error(
					`Too many timestamps: ${times.length} (max ${MAX_SEQUENCE_FRAMES})`,
				);
			}
			times = [
				...new Set(
					times.map((time) => Math.max(0, Math.min(time, durationSeconds))),
				),
			].sort((a, b) => a - b);

			const dedupe = args.dedupe !== false;
			const cellWidth = Math.round(
				clampNumberArg({
					value: args.cellWidth,
					fallback: 320,
					min: 120,
					max: 640,
				}),
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
			const cellHeight = Math.max(
				1,
				Math.round((cellWidth * canvasSize.height) / canvasSize.width),
			);

			const sampled: Array<{
				time: number;
				canvas: HTMLCanvasElement;
				signature: Uint8Array;
			}> = [];
			for (const time of times) {
				const renderTime = Math.min(toTicks(time), lastFrameTime);
				await renderer.renderToCanvas({
					node: renderTree,
					time: renderTime,
					targetCanvas: canvas,
				});
				const cell = document.createElement("canvas");
				cell.width = cellWidth;
				cell.height = cellHeight;
				const cellContext = cell.getContext("2d");
				if (!cellContext) {
					throw new Error("Failed to create cell canvas context");
				}
				cellContext.drawImage(canvas, 0, 0, cellWidth, cellHeight);
				sampled.push({
					time,
					canvas: cell,
					signature: buildGraySignature({ source: cell }),
				});
			}

			// Compare against the last KEPT frame (not the previous one) so slow
			// fades collapse while gradual content changes survive.
			const kept: typeof sampled = [];
			if (dedupe && sampled.length > 0) {
				kept.push(sampled[0]);
				let lastSignature = sampled[0].signature;
				for (const frame of sampled.slice(1)) {
					if (
						frameDelta({ a: frame.signature, b: lastSignature }) <=
						SEQUENCE_DEDUPE_THRESHOLD
					) {
						continue;
					}
					kept.push(frame);
					lastSignature = frame.signature;
				}
			} else {
				kept.push(...sampled);
			}

			const sheet = buildContactSheet({ frames: kept, cellWidth, cellHeight });
			return {
				dataUrl: sheet.toDataURL("image/jpeg", 0.85),
				width: sheet.width,
				height: sheet.height,
				sampled: sampled.length,
				kept: kept.length,
				dropped: sampled.length - kept.length,
				frames: kept.map((frame) => Number(frame.time.toFixed(2))),
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

	"keyframes.set_loop": {
		description:
			"Enable or disable looping on an element's scalar animation channel. When looping, the keyframed cycle repeats for the element's whole lifetime; make the first and last keyframe values equal for a seamless loop.",
		args: {
			trackId: "string",
			elementId: "string",
			propertyPath: "string",
			loop: "boolean",
		},
		run: ({ editor, args }) => {
			if (typeof args.loop !== "boolean") {
				throw new Error("Missing or invalid argument: loop");
			}
			editor.timeline.setKeyframeLoop({
				trackId: requireString(args.trackId, "trackId"),
				elementId: requireString(args.elementId, "elementId"),
				propertyPath: requireString(args.propertyPath, "propertyPath"),
				loop: args.loop,
			});
			return { updated: true };
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

	"effects.guide": {
		description:
			"Get the effects composition playbook: how to build looks (glow, shake, vignette, echo, karaoke text, glitch, old film, color wash, ...) by composing built-in effects, masks, keyframes, blend modes and text style params. Call this before attempting complex visual styling.",
		run: () => ({ guide: EFFECTS_COMPOSITION_GUIDE }),
	},

	"effects.add": {
		description:
			"Add an effect to a visual element with default params. Returns the new effectId. Use effects.list to discover effectType values. The effect follows its clip; for a full-screen look covering a span of the timeline use effects.add_layer instead.",
		args: { trackId: "string", elementId: "string", effectType: "string" },
		run: ({ editor, args }) => ({
			effectId: editor.timeline.addClipEffect({
				trackId: requireString(args.trackId, "trackId"),
				elementId: requireString(args.elementId, "elementId"),
				effectType: requireString(args.effectType, "effectType"),
			}),
		}),
	},

	"effects.add_layer": {
		description:
			"Add a standalone scene-effect layer: a full-screen look applied to the composited picture (all layers below it) during its time window, instead of following a single clip. Use this for atmosphere covering a span of the timeline (glow, glitch, blur, old film, vignette). For per-clip effects that move with one element, use effects.add. Returns the selected element ref.",
		args: {
			effectType: "string",
			startTime: "number (seconds)",
			duration: "number? (seconds, default 30)",
		},
		run: ({ editor, args }) => {
			const effectType = requireString(args.effectType, "effectType");
			if (!effectsRegistry.has(effectType)) {
				throw new Error(`Unknown effectType: ${effectType}`);
			}
			const element = buildEffectElement({
				effectType,
				startTime: toTicks(requireNumber(args.startTime, "startTime")),
				...(typeof args.duration === "number"
					? { duration: toTicks(args.duration) }
					: {}),
			});
			return insertAndSelect(editor, element, {
				mode: "auto",
				trackType: "effect",
			});
		},
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
			"List all mask types (rectangle, ellipse, star, freeform, ...) with their parameter definitions. Box-like masks use element-center-origin coords: centerX/centerY are offsets from the element center in element-size units (0=center, +0.5=right/bottom edge, -0.5=left/top edge); width/height are fractions of element size (1=full).",
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
			"Add a mask with default params to an element (shape masks start as a centered box covering ~60% of the element's short side). Returns the new maskId. Use masks.list to discover maskType values, then masks.set_canvas_rect to place the mask over a canvas region.",
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
		description:
			"Patch a mask's params. Box-like masks (rectangle/ellipse/...): centerX/centerY are offsets from the element CENTER in element-size units (0=center, +0.5=right/bottom edge, -0.5=left/top edge), width/height are fractions of element size (1=full). To position a mask from a preview screenshot, prefer masks.set_canvas_rect (takes a canvas-fraction rect with top-left origin) instead of raw params.",
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

	"masks.set_canvas_rect": {
		description:
			"Position a box-like mask (rectangle/ellipse/heart/diamond/star/cinematic-bars) over a canvas region. rect = { left, top, right, bottom } as canvas fractions (0~1) with top-left origin — the same mental model as estimating a region from a preview screenshot. Converts to the mask's center-origin params internally (handles element scale/offset/rotation). The element must be visible at the playhead — seek onto it first (playback.seek).",
		args: {
			trackId: "string",
			elementId: "string",
			maskId: "string",
			rect: "{ left, top, right, bottom } — canvas fractions, top-left origin",
		},
		run: ({ editor, args }) => {
			const trackId = requireString(args.trackId, "trackId");
			const elementId = requireString(args.elementId, "elementId");
			const maskId = requireString(args.maskId, "maskId");
			const rect = args.rect as Record<string, unknown> | undefined;
			if (!rect || typeof rect !== "object") {
				throw new Error("Missing or invalid argument: rect");
			}
			const left = requireNumber(rect.left, "rect.left");
			const top = requireNumber(rect.top, "rect.top");
			const right = requireNumber(rect.right, "rect.right");
			const bottom = requireNumber(rect.bottom, "rect.bottom");
			if (right <= left || bottom <= top) {
				throw new Error("rect must satisfy right > left and bottom > top");
			}

			const masks = getElementMasks(editor, trackId, elementId);
			const mask = masks.find((item) => item.id === maskId);
			if (!mask) {
				throw new Error(`Mask not found: ${maskId}`);
			}
			const maskParams = mask.params as unknown as Record<string, unknown>;
			if (
				typeof maskParams.centerX !== "number" ||
				typeof maskParams.width !== "number"
			) {
				throw new Error(
					`Mask type "${mask.type}" has no box params (centerX/centerY/width/height). Use masks.update_params or masks.freeform_set_path instead.`,
				);
			}

			const scene = editor.scenes.getActiveSceneOrNull();
			const project = editor.project.getActiveOrNull();
			if (!scene || !project) {
				throw new Error("No active scene or project");
			}
			const canvasSize = project.settings.canvasSize;
			const withBounds = getVisibleElementsWithBounds({
				tracks: scene.tracks,
				currentTime: editor.playback.getCurrentTime(),
				canvasSize,
				mediaAssets: editor.media.getAssets(),
			});
			const target = withBounds.find(
				(item) => item.trackId === trackId && item.elementId === elementId,
			);
			if (!target) {
				throw new Error(
					`Element ${elementId} is not visible at the playhead. Seek onto the element first (playback.seek), then retry.`,
				);
			}
			const nextParams = canvasRectToMaskParams({
				rect: { left, top, right, bottom },
				bounds: target.bounds,
				canvasSize,
			});

			const nextMasks = masks.map((item) =>
				item.id === maskId
					? { ...item, params: { ...item.params, ...nextParams } }
					: item,
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
			return { updated: true, params: nextParams };
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

	"attention.spotlight": {
		description:
			"Magnify a detail for attention: duplicates the element onto a new top track, scales it by `zoom`, and clips it with a mask around the focus point so only the enlarged detail shows through while the rest of the frame keeps its original size. The element must be visible at the playhead (seek onto it first). Returns the duplicated element ref — edit or delete that element to change or remove the spotlight.",
		args: {
			trackId: "string",
			elementId: "string",
			centerX: "number 0~1? (focus point as a canvas fraction, default 0.5)",
			centerY: "number 0~1? (default 0.5)",
			zoom: "number 1.1~5? (default 1.8)",
			size: "number 0.05~1? (spotlight region size, fraction of the canvas short side, default 0.35)",
			shape: "'ellipse' | 'rectangle'? (default ellipse)",
			feather: "number 0~200? (mask feather in canvas px, default 0)",
		},
		run: ({ editor, args }) => {
			const trackId = requireString(args.trackId, "trackId");
			const elementId = requireString(args.elementId, "elementId");
			const centerX = clampNumberArg({
				value: args.centerX,
				fallback: 0.5,
				min: 0,
				max: 1,
			});
			const centerY = clampNumberArg({
				value: args.centerY,
				fallback: 0.5,
				min: 0,
				max: 1,
			});
			const zoom = clampNumberArg({
				value: args.zoom,
				fallback: 1.8,
				min: 1.1,
				max: 5,
			});
			const size = clampNumberArg({
				value: args.size,
				fallback: 0.35,
				min: 0.05,
				max: 1,
			});
			const shape: MaskType =
				args.shape === "rectangle" ? "rectangle" : "ellipse";
			const feather = clampNumberArg({
				value: args.feather,
				fallback: 0,
				min: 0,
				max: 200,
			});

			const { canvasSize, bounds } = getVisibleElementBounds({
				editor,
				trackId,
				elementId,
			});
			const source = findElement(editor, trackId, elementId);

			const focusX = centerX * canvasSize.width;
			const focusY = centerY * canvasSize.height;
			// Pin the focus point in place: the enlarged copy's centre must
			// shift by (focus - centre) * (1 - zoom).
			const deltaX = (focusX - bounds.cx) * (1 - zoom);
			const deltaY = (focusY - bounds.cy) * (1 - zoom);

			const duplicated = editor.timeline.duplicateElements({
				elements: [{ trackId, elementId }],
			});
			const copy = duplicated[0];
			if (!copy) {
				throw new Error("Failed to duplicate the element for the spotlight");
			}

			const baseScaleX = readElementNumberParam({
				element: source,
				key: "transform.scaleX",
				fallback: 1,
			});
			const baseScaleY = readElementNumberParam({
				element: source,
				key: "transform.scaleY",
				fallback: 1,
			});
			const basePositionX = readElementNumberParam({
				element: source,
				key: "transform.positionX",
				fallback: 0,
			});
			const basePositionY = readElementNumberParam({
				element: source,
				key: "transform.positionY",
				fallback: 0,
			});

			const halfExtent =
				(size * Math.min(canvasSize.width, canvasSize.height)) / 2;
			const maskParams = canvasRectToMaskParams({
				rect: {
					left: (focusX - halfExtent) / canvasSize.width,
					top: (focusY - halfExtent) / canvasSize.height,
					right: (focusX + halfExtent) / canvasSize.width,
					bottom: (focusY + halfExtent) / canvasSize.height,
				},
				bounds: {
					cx: bounds.cx + deltaX,
					cy: bounds.cy + deltaY,
					width: bounds.width * zoom,
					height: bounds.height * zoom,
					rotation: bounds.rotation,
				},
				canvasSize,
			});

			const newMask = buildDefaultMaskInstance({ maskType: shape });
			const nextMask = {
				...newMask,
				params: {
					...newMask.params,
					...maskParams,
					...(feather > 0 ? { feather } : {}),
				},
			} as Mask;
			const copyElement = findElement(editor, copy.trackId, copy.elementId);
			const existingMasks = (copyElement.masks as Mask[] | undefined) ?? [];

			editor.timeline.updateElements({
				updates: [
					{
						trackId: copy.trackId,
						elementId: copy.elementId,
						patch: {
							params: {
								"transform.scaleX": baseScaleX * zoom,
								"transform.scaleY": baseScaleY * zoom,
								"transform.positionX": basePositionX + deltaX,
								"transform.positionY": basePositionY + deltaY,
							},
							masks: [...existingMasks, nextMask],
						} as never,
					},
				],
			});

			return {
				spotlight: copy,
				zoom,
				focus: { centerX, centerY },
				region: { size, shape },
			};
		},
	},

	"layout.apply": {
		description:
			"Arrange visual elements into a layout preset: picture-in-picture corners (pip-tl/tr/bl/br), split screen (split-h/split-v) or grids (grid-2x2/grid-3x3). Each element is scaled to cover its slot and clipped with a rectangle mask so it cannot spill into neighbouring slots. Elements must be visible at the playhead (seek onto them first); the element count must match the preset. Returns the slot assigned to each element.",
		args: {
			preset:
				"'pip-tl'|'pip-tr'|'pip-bl'|'pip-br'|'split-h'|'split-v'|'grid-2x2'|'grid-3x3'",
			elements: '[{ trackId, elementId }] | "$selection"',
			padding: "number 0~0.2? (gap fraction inside each slot, default 0.02)",
			pipScale:
				"number 0.15~0.6? (pip slot size as a fraction of the canvas, default 0.35)",
			pipMargin: "number 0~0.3? (pip distance from the canvas edge, default 0.05)",
		},
		run: ({ editor, args }) => {
			const preset = requireString(args.preset, "preset");
			const padding = clampNumberArg({
				value: args.padding,
				fallback: 0.02,
				min: 0,
				max: 0.2,
			});
			const pipScale = clampNumberArg({
				value: args.pipScale,
				fallback: 0.35,
				min: 0.15,
				max: 0.6,
			});
			const pipMargin = clampNumberArg({
				value: args.pipMargin,
				fallback: 0.05,
				min: 0,
				max: 0.3,
			});
			const refs = resolveElementRefs(editor, args.elements);

			const slots = buildLayoutSlots({
				preset,
				padding,
				pipScale,
				pipMargin,
			});
			if (!slots) {
				throw new Error(`Unknown layout preset: ${preset}`);
			}
			if (refs.length !== slots.length) {
				throw new Error(
					`Preset "${preset}" needs exactly ${slots.length} element(s), got ${refs.length}`,
				);
			}

			const updates = refs.map((ref, index) => {
				const { canvasSize, bounds } = getVisibleElementBounds({
					editor,
					trackId: ref.trackId,
					elementId: ref.elementId,
				});
				const slot = slots[index];
				const slotWidth = (slot.right - slot.left) * canvasSize.width;
				const slotHeight = (slot.bottom - slot.top) * canvasSize.height;
				const slotCenterX =
					((slot.left + slot.right) / 2) * canvasSize.width;
				const slotCenterY =
					((slot.top + slot.bottom) / 2) * canvasSize.height;

				// Cover the slot (crop the overflow with the mask below).
				const cover = Math.max(
					slotWidth / bounds.width,
					slotHeight / bounds.height,
				);
				const element = findElement(editor, ref.trackId, ref.elementId);
				const baseScaleX = readElementNumberParam({
					element,
					key: "transform.scaleX",
					fallback: 1,
				});
				const baseScaleY = readElementNumberParam({
					element,
					key: "transform.scaleY",
					fallback: 1,
				});
				const basePositionX = readElementNumberParam({
					element,
					key: "transform.positionX",
					fallback: 0,
				});
				const basePositionY = readElementNumberParam({
					element,
					key: "transform.positionY",
					fallback: 0,
				});

				const maskParams = canvasRectToMaskParams({
					rect: slot,
					bounds: {
						cx: slotCenterX,
						cy: slotCenterY,
						width: bounds.width * cover,
						height: bounds.height * cover,
						rotation: bounds.rotation,
					},
					canvasSize,
				});

				const existingMasks = (element.masks as Mask[] | undefined) ?? [];
				const existingRect = existingMasks.find(
					(mask) => mask.type === "rectangle",
				);
				// Reuse an existing rectangle mask so re-applying a layout does
				// not stack clips on top of each other.
				const nextMasks = existingRect
					? existingMasks.map((mask) =>
							mask.id === existingRect.id
								? {
										...mask,
										params: { ...mask.params, ...maskParams },
									}
								: mask,
						)
					: [
							...existingMasks,
							(() => {
								const newMask = buildDefaultMaskInstance({
									maskType: "rectangle",
								});
								return {
									...newMask,
									params: { ...newMask.params, ...maskParams },
								} as Mask;
							})(),
						];

				return {
					trackId: ref.trackId,
					elementId: ref.elementId,
					patch: {
						params: {
							"transform.scaleX": baseScaleX * cover,
							"transform.scaleY": baseScaleY * cover,
							"transform.positionX": basePositionX + (slotCenterX - bounds.cx),
							"transform.positionY": basePositionY + (slotCenterY - bounds.cy),
						},
						masks: nextMasks,
					} as never,
				};
			});

			editor.timeline.updateElements({ updates });

			return {
				preset,
				assigned: refs.map((ref, index) => ({
					element: ref,
					slot: slots[index],
				})),
			};
		},
	},

	"audio.duck": {
		description:
			"Duck an audio element (typically background music) under spoken segments: writes volume keyframes that drop by `amountDb` inside each range and return to the original level outside, with `fade` seconds of attack/release. Ranges are timeline seconds — derive them from the narration element's span or from subtitles.transcribe output.",
		args: {
			trackId: "string",
			elementId: "string",
			ranges: "[{ start, end }] (seconds, timeline time)",
			amountDb: "number 3~40? (how much to duck, default 12)",
			fade: "number 0.05~2? (attack/release seconds, default 0.3)",
		},
		run: ({ editor, args }) => {
			const trackId = requireString(args.trackId, "trackId");
			const elementId = requireString(args.elementId, "elementId");
			const rawRanges = args.ranges;
			if (!Array.isArray(rawRanges) || rawRanges.length === 0) {
				throw new Error("Missing or invalid argument: ranges");
			}
			const amountDb = clampNumberArg({
				value: args.amountDb,
				fallback: 12,
				min: 3,
				max: 40,
			});
			const fade = clampNumberArg({
				value: args.fade,
				fallback: 0.3,
				min: 0.05,
				max: 2,
			});

			const element = findElement(editor, trackId, elementId);
			const baseVolume = readElementNumberParam({
				element,
				key: "volume",
				fallback: 0,
			});
			const duckedVolume = Math.max(VOLUME_DB_MIN, baseVolume - amountDb);

			const keyframes: Array<{
				trackId: string;
				elementId: string;
				propertyPath: "volume";
				time: MediaTime;
				value: number;
				interpolation: AnimationInterpolation;
			}> = [];
			for (const raw of rawRanges) {
				const range = raw as { start?: unknown; end?: unknown };
				const start = requireNumber(range?.start, "ranges[].start");
				const end = requireNumber(range?.end, "ranges[].end");
				if (end <= start) {
					throw new Error("Each range must satisfy end > start");
				}
				keyframes.push(
					{
						trackId,
						elementId,
						propertyPath: "volume",
						time: toTicks(Math.max(0, start - fade)),
						value: baseVolume,
						interpolation: "linear",
					},
					{
						trackId,
						elementId,
						propertyPath: "volume",
						time: toTicks(start),
						value: duckedVolume,
						interpolation: "linear",
					},
					{
						trackId,
						elementId,
						propertyPath: "volume",
						time: toTicks(end),
						value: duckedVolume,
						interpolation: "linear",
					},
					{
						trackId,
						elementId,
						propertyPath: "volume",
						time: toTicks(end + fade),
						value: baseVolume,
						interpolation: "linear",
					},
				);
			}

			editor.timeline.upsertKeyframes({ keyframes });
			return {
				keyframes: keyframes.length,
				baseVolumeDb: baseVolume,
				duckedVolumeDb: duckedVolume,
			};
		},
	},
};
