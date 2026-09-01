import { EditorCore } from "@/core";
import { Command, type CommandResult } from "@/commands/base-command";
import type { SceneTracks, TimelineElement } from "@/timeline";
import { findTrackInSceneTracks, updateElementInSceneTracks } from "@/timeline";
import { canPlaceTimeSpansOnTrack } from "@/timeline/placement";
import { applyElementUpdate } from "@/timeline/update-pipeline";

export class UpdateElementsCommand extends Command {
	private savedState: SceneTracks | null = null;
	private readonly updates: Array<{
		trackId: string;
		elementId: string;
		patch: Partial<TimelineElement>;
	}>;

	constructor({
		updates,
	}: {
		updates: Array<{
			trackId: string;
			elementId: string;
			patch: Partial<TimelineElement>;
		}>;
	}) {
		super();
		this.updates = updates;
		this.affectedElementRefs = updates.map(({ trackId, elementId }) => ({
			trackId,
			elementId,
		}));
	}

	execute(): CommandResult | undefined {
		const editor = EditorCore.getInstance();
		this.savedState = editor.scenes.getActiveScene().tracks;
		let updatedTracks = this.savedState;
		const timeChangedElementIdsByTrackId = new Map<string, Set<string>>();

		for (const updateEntry of this.updates) {
			const currentTrack = findTrackInSceneTracks({
				tracks: updatedTracks,
				trackId: updateEntry.trackId,
			});
			const currentElement = currentTrack?.elements.find(
				(element) => element.id === updateEntry.elementId,
			);
			if (!currentTrack || !currentElement) {
				continue;
			}

			const nextElement = applyElementUpdate({
				element: currentElement,
				patch: updateEntry.patch,
				context: {
					tracks: updatedTracks,
					trackId: updateEntry.trackId,
				},
			});

			if (
				nextElement.startTime !== currentElement.startTime ||
				nextElement.duration !== currentElement.duration
			) {
				const changedElementIds =
					timeChangedElementIdsByTrackId.get(updateEntry.trackId) ??
					new Set<string>();
				changedElementIds.add(updateEntry.elementId);
				timeChangedElementIdsByTrackId.set(
					updateEntry.trackId,
					changedElementIds,
				);
			}

			updatedTracks = updateElementInSceneTracks({
				tracks: updatedTracks,
				trackId: updateEntry.trackId,
				elementId: updateEntry.elementId,
				update: () => nextElement,
			});
		}

		assertNoOverlappingTimeChanges({
			tracks: updatedTracks,
			changedElementIdsByTrackId: timeChangedElementIdsByTrackId,
		});
		editor.timeline.updateTracks(updatedTracks);
		return undefined;
	}

	undo(): void {
		if (this.savedState) {
			const editor = EditorCore.getInstance();
			editor.timeline.updateTracks(this.savedState);
		}
	}
}

function assertNoOverlappingTimeChanges({
	tracks,
	changedElementIdsByTrackId,
}: {
	tracks: SceneTracks;
	changedElementIdsByTrackId: ReadonlyMap<string, ReadonlySet<string>>;
}): void {
	for (const [trackId, changedElementIds] of changedElementIdsByTrackId) {
		const track = findTrackInSceneTracks({ tracks, trackId });
		if (!track) {
			continue;
		}

		const changedElements = track.elements.filter((element) =>
			changedElementIds.has(element.id),
		);
		const stationaryElements = track.elements.filter(
			(element) => !changedElementIds.has(element.id),
		);
		if (
			!canPlaceTimeSpansOnTrack({
				track: { elements: stationaryElements },
				timeSpans: changedElements.map(({ startTime, duration }) => ({
					startTime,
					duration,
				})),
			})
		) {
			throw new Error(
				"Cannot update elements because a time range overlaps another element on the same track.",
			);
		}
	}
}
