import type { ParamValues } from "@/params";
import { findTrackInSceneTracks } from "./track-element-update";
import type { SceneTracks, TimelineElement } from "./types";

/**
 * Param keys shared across all elements of a linked text track.
 * Excludes "content" (each caption has its own text); everything else that
 * affects appearance — including transform — stays consistent track-wide.
 */
export const LINKED_TEXT_STYLE_PARAM_KEYS: readonly string[] = [
	"fontFamily",
	"fontSize",
	"color",
	"textAlign",
	"fontWeight",
	"fontStyle",
	"textDecoration",
	"letterSpacing",
	"lineHeight",
	"background.enabled",
	"background.color",
	"background.cornerRadius",
	"background.paddingX",
	"background.paddingY",
	"background.offsetX",
	"background.offsetY",
	"stroke.enabled",
	"stroke.color",
	"stroke.width",
	"shadow.enabled",
	"shadow.color",
	"shadow.blur",
	"shadow.offsetX",
	"shadow.offsetY",
	"gradient.enabled",
	"gradient.color",
	"gradient.angle",
	"animIn.type",
	"animIn.duration",
	"transform.positionX",
	"transform.positionY",
	"transform.scaleX",
	"transform.scaleY",
	"transform.rotate",
];

export interface LinkedStyleUpdateEntry {
	trackId: string;
	elementId: string;
	patch: Partial<TimelineElement>;
}

/**
 * Expands element updates so that text style changes on a linked text track
 * are mirrored to every sibling element on that track. Only keys whose value
 * actually changed (vs. the element's committed params) are propagated, so
 * untouched per-element values are never stomped.
 */
export function expandLinkedTextStyleUpdates({
	tracks,
	updates,
}: {
	tracks: SceneTracks;
	updates: readonly LinkedStyleUpdateEntry[];
}): LinkedStyleUpdateEntry[] {
	const expanded: LinkedStyleUpdateEntry[] = [...updates];

	for (const entry of updates) {
		const patchParams = entry.patch.params;
		if (!patchParams) continue;

		const track = findTrackInSceneTracks({
			tracks,
			trackId: entry.trackId,
		});
		if (!track || track.type !== "text" || !track.linkedStyle) continue;

		const sourceElement = track.elements.find(
			(element) => element.id === entry.elementId,
		);
		if (!sourceElement) continue;

		const changedParams: ParamValues = {};
		for (const key of LINKED_TEXT_STYLE_PARAM_KEYS) {
			if (!(key in patchParams)) continue;
			if (Object.is(patchParams[key], sourceElement.params[key])) continue;
			changedParams[key] = patchParams[key];
		}
		if (Object.keys(changedParams).length === 0) continue;

		for (const sibling of track.elements) {
			if (sibling.id === entry.elementId) continue;
			expanded.push({
				trackId: entry.trackId,
				elementId: sibling.id,
				patch: { params: { ...changedParams } },
			});
		}
	}

	return expanded;
}
