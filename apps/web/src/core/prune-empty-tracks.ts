import type { SceneTracks, TimelineTrack } from "@/timeline";

/** Removes overlay/audio tracks that are both empty and in `trackIds`.
 *  Only tracks the triggering command touched are eligible, so manually
 *  added empty tracks survive unrelated edits. Returns the input unchanged
 *  (same reference) when nothing was pruned. */
export function pruneEmptyTracksByIds({
	tracks,
	trackIds,
}: {
	tracks: SceneTracks;
	trackIds: readonly string[];
}): SceneTracks {
	const prunable = new Set(trackIds);
	const prune = <T extends TimelineTrack>(list: T[]): T[] =>
		list.filter(
			(track) => track.elements.length > 0 || !prunable.has(track.id),
		);
	const overlay = prune(tracks.overlay);
	const audio = prune(tracks.audio);
	if (
		overlay.length === tracks.overlay.length &&
		audio.length === tracks.audio.length
	) {
		return tracks;
	}
	return { ...tracks, overlay, audio };
}
