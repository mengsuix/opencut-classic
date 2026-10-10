import {
	Command,
	createElementSelectionResult,
	type CommandResult,
} from "@/commands/base-command";
import type { SceneTracks, TimelineElement } from "@/timeline";
import { generateUUID } from "@/utils/id";
import { EditorCore } from "@/core";
import { isRetimableElement } from "@/timeline";
import { splitAnimationsAtTime } from "@/animation";
import { getSourceSpanAtClipTime, shiftTimeRemapChannelValues } from "@/retime";
import { TICKS_PER_SECOND } from "@/wasm";
import {
	addMediaTime,
	type MediaTime,
	roundMediaTime,
	subMediaTime,
	ZERO_MEDIA_TIME,
} from "@/wasm";

/**
 * Replace range: cut [rangeStart, rangeEnd) out of an element and drop a new
 * media element into the gap — atomically (single undo step), so callers
 * (bridge/agent) never orchestrate split×2 + delete + insert by hand.
 * Animations follow the kept halves (same discipline as SplitElementsCommand);
 * keyframes inside the replaced window are discarded. The inserted element is
 * bare: no animations/effects/masks/retime inherited.
 */
export class ReplaceRangeCommand extends Command {
	private savedState: SceneTracks | null = null;
	private insertedElement: { trackId: string; elementId: string } | null = null;
	private rightElement: { trackId: string; elementId: string } | null = null;
	private readonly trackId: string;
	private readonly elementId: string;
	private readonly rangeStart: MediaTime;
	private readonly rangeEnd: MediaTime;
	private readonly mediaId: string;
	private readonly name?: string;
	private readonly sourceDuration?: MediaTime;

	constructor({
		trackId,
		elementId,
		rangeStart,
		rangeEnd,
		mediaId,
		name,
		sourceDuration,
	}: {
		trackId: string;
		elementId: string;
		rangeStart: MediaTime;
		rangeEnd: MediaTime;
		mediaId: string;
		name?: string;
		sourceDuration?: MediaTime;
	}) {
		super();
		this.trackId = trackId;
		this.elementId = elementId;
		this.rangeStart = rangeStart;
		this.rangeEnd = rangeEnd;
		this.mediaId = mediaId;
		this.name = name;
		this.sourceDuration = sourceDuration;
	}

	getInsertedElement(): { trackId: string; elementId: string } | null {
		return this.insertedElement;
	}

	getRightElement(): { trackId: string; elementId: string } | null {
		return this.rightElement;
	}

	execute(): CommandResult | undefined {
		const editor = EditorCore.getInstance();
		this.savedState = editor.scenes.getActiveScene().tracks;
		this.insertedElement = null;
		this.rightElement = null;

		const replaceInTrack = <
			TTrack extends { id: string; elements: TimelineElement[] },
		>(
			track: TTrack,
		): TTrack => {
			if (track.id !== this.trackId) {
				return track;
			}

			const elements = track.elements.flatMap((element) => {
				if (element.id !== this.elementId) {
					return [element];
				}

				const elementStart = element.startTime;
				const elementEnd = addMediaTime({
					a: element.startTime,
					b: element.duration,
				});
				if (
					this.rangeStart <= elementStart ||
					this.rangeEnd >= elementEnd ||
					this.rangeStart >= this.rangeEnd
				) {
					return [element];
				}

				const leftVisibleDuration = subMediaTime({
					a: this.rangeStart,
					b: elementStart,
				});
				const midVisibleDuration = subMediaTime({
					a: this.rangeEnd,
					b: this.rangeStart,
				});
				const rightVisibleDuration = subMediaTime({
					a: elementEnd,
					b: this.rangeEnd,
				});

				const retimeRef = isRetimableElement(element)
					? element.retime
					: undefined;
				// Snap-once discipline (same as SplitElementsCommand): derive every
				// span from a single rounded anchor so the spans stay consistent.
				const leftSourceSpan = roundMediaTime({
					time: getSourceSpanAtClipTime({
						clipTime: leftVisibleDuration,
						retime: retimeRef,
						animations: element.animations,
					}),
				});
				const leftMidSourceSpan = roundMediaTime({
					time: getSourceSpanAtClipTime({
						clipTime: addMediaTime({
							a: leftVisibleDuration,
							b: midVisibleDuration,
						}),
						retime: retimeRef,
						animations: element.animations,
					}),
				});
				const totalSourceSpan = roundMediaTime({
					time: getSourceSpanAtClipTime({
						clipTime: element.duration,
						retime: retimeRef,
						animations: element.animations,
					}),
				});
				const midSourceSpan = subMediaTime({
					a: leftMidSourceSpan,
					b: leftSourceSpan,
				});
				const rightSourceSpan = subMediaTime({
					a: totalSourceSpan,
					b: leftMidSourceSpan,
				});

				const firstSplit = splitAnimationsAtTime({
					animations: element.animations,
					splitTime: leftVisibleDuration,
					shouldIncludeSplitBoundary: true,
				});
				const secondSplit = splitAnimationsAtTime({
					animations: firstSplit.rightAnimations,
					splitTime: midVisibleDuration,
					shouldIncludeSplitBoundary: true,
				});
				// Remap values are source offsets relative to trimStart; the right
				// piece's trimStart advances past left+mid spans.
				const rightAnimations = shiftTimeRemapChannelValues({
					animations: secondSplit.rightAnimations,
					offsetSeconds:
						-(leftSourceSpan + midSourceSpan) / TICKS_PER_SECOND,
				});

				const rightElementId = generateUUID();
				const insertedElementId = generateUUID();
				this.insertedElement = {
					trackId: track.id,
					elementId: insertedElementId,
				};
				this.rightElement = { trackId: track.id, elementId: rightElementId };

				const leftElement: TimelineElement = {
					...element,
					duration: leftVisibleDuration,
					trimEnd: addMediaTime({
						a: element.trimEnd,
						b: addMediaTime({ a: midSourceSpan, b: rightSourceSpan }),
					}),
					animations: firstSplit.leftAnimations,
					...(retimeRef !== undefined ? { retime: retimeRef } : {}),
				} as TimelineElement;

				const insertedTrimEnd =
					this.sourceDuration != null
						? (Math.max(
								0,
								subMediaTime({
									a: this.sourceDuration,
									b: midVisibleDuration,
								}),
							) as MediaTime)
						: ZERO_MEDIA_TIME;
				const { id: _id, effects: _effects, masks: _masks, ...rest } =
					element as TimelineElement & {
						effects?: unknown;
						masks?: unknown;
					};
				const insertedElement = {
					...rest,
					id: insertedElementId,
					mediaId: this.mediaId,
					startTime: this.rangeStart,
					duration: midVisibleDuration,
					trimStart: ZERO_MEDIA_TIME,
					trimEnd: insertedTrimEnd,
					retime: undefined,
					animations: undefined,
					freeze: undefined,
					name: this.name ?? `${element.name} (replaced)`,
				} as unknown as TimelineElement;

				const rightElement: TimelineElement = {
					...element,
					id: rightElementId,
					startTime: this.rangeEnd,
					duration: rightVisibleDuration,
					trimStart: addMediaTime({
						a: element.trimStart,
						b: leftMidSourceSpan,
					}),
					animations: rightAnimations,
					...(retimeRef !== undefined ? { retime: retimeRef } : {}),
				} as TimelineElement;

				return [leftElement, insertedElement, rightElement];
			});

			return { ...track, elements } as TTrack;
		};

		const updatedTracks: SceneTracks = {
			overlay: this.savedState.overlay.map((track) => replaceInTrack(track)),
			main: replaceInTrack(this.savedState.main),
			audio: this.savedState.audio.map((track) => replaceInTrack(track)),
		};

		editor.timeline.updateTracks(updatedTracks);

		if (this.insertedElement) {
			return createElementSelectionResult([this.insertedElement]);
		}
		return undefined;
	}

	undo(): void {
		if (this.savedState) {
			const editor = EditorCore.getInstance();
			editor.timeline.updateTracks(this.savedState);
		}
	}
}
