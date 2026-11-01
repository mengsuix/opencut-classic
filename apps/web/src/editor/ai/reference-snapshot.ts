import type { EditorCore } from "@/core";
import type { TimelineElement, TimelineTrack } from "@/timeline/types";
import { mediaTimeToSeconds } from "@/wasm";

export function findTimelineElement({
	editor,
	trackId,
	elementId,
}: {
	editor: EditorCore;
	trackId: string;
	elementId: string;
}): { trackType: TimelineTrack["type"]; element: TimelineElement } | null {
	const tracks = editor.scenes.getActiveSceneOrNull()?.tracks;
	if (!tracks) return null;
	const allTracks: TimelineTrack[] = [
		tracks.main,
		...tracks.overlay,
		...tracks.audio,
	];
	const track = allTracks.find((item) => item.id === trackId);
	const element = track?.elements.find((item) => item.id === elementId);
	return track && element ? { trackType: track.type, element } : null;
}

export function describeSelectedElements(editor: EditorCore) {
	return editor.selection.getSelectedElements().map((ref) => {
		const found = findTimelineElement({
			editor,
			trackId: ref.trackId,
			elementId: ref.elementId,
		});
		if (!found) {
			return { ...ref, error: "element not found" };
		}
		const { element } = found;
		const content = element.params.content;
		const effects = "effects" in element ? element.effects : null;
		const masks = "masks" in element ? element.masks : null;
		return {
			trackId: ref.trackId,
			elementId: ref.elementId,
			trackType: found.trackType,
			type: element.type,
			name: element.name,
			startTime: mediaTimeToSeconds({ time: element.startTime }),
			duration: mediaTimeToSeconds({ time: element.duration }),
			...(typeof content === "string" ? { text: content } : {}),
			...("mediaId" in element && typeof element.mediaId === "string"
				? { mediaId: element.mediaId }
				: {}),
			...("muted" in element && typeof element.muted === "boolean"
				? { muted: element.muted }
				: {}),
			...("hidden" in element && typeof element.hidden === "boolean"
				? { hidden: element.hidden }
				: {}),
			effectCount: Array.isArray(effects) ? effects.length : 0,
			maskCount: Array.isArray(masks) ? masks.length : 0,
		};
	});
}
