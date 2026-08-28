import type {
	AnimationPath,
	ElementAnimations,
} from "@/animation/types";
import type { TimelineTrack } from "@/timeline";
import { getElementKeyframes } from "@/animation";
import { KEYFRAME_LANE_HEIGHT_PX } from "./layout";
import { t } from "@/i18n";

export interface ExpandedRow {
	propertyPath: AnimationPath;
	label: string;
}

interface PropertyGroupDefinition {
	matchesPath: (path: AnimationPath) => boolean;
}

const PROPERTY_GROUPS: PropertyGroupDefinition[] = [
	{ matchesPath: (path) => path.startsWith("transform.") || path === "opacity" },
	{ matchesPath: (path) => path === "volume" || path === "color" },
	{ matchesPath: (path) => path.startsWith("background.") },
	{ matchesPath: (path) => path.startsWith("params.") },
	{ matchesPath: (path) => path.startsWith("effects.") },
];

const PROPERTY_LABELS: Partial<Record<string, string>> = {
	get "transform.positionX"() {
		return t("timeline.propertyPositionX");
	},
	get "transform.positionY"() {
		return t("timeline.propertyPositionY");
	},
	get "transform.scaleX"() {
		return t("timeline.propertyScaleX");
	},
	get "transform.scaleY"() {
		return t("timeline.propertyScaleY");
	},
	get "transform.rotate"() {
		return t("timeline.propertyRotation");
	},
	get opacity() {
		return t("timeline.propertyOpacity");
	},
	get volume() {
		return t("timeline.propertyVolume");
	},
	get color() {
		return t("timeline.propertyColor");
	},
	get "background.color"() {
		return t("timeline.propertyBgColor");
	},
	get "background.paddingX"() {
		return t("timeline.propertyBgPadX");
	},
	get "background.paddingY"() {
		return t("timeline.propertyBgPadY");
	},
	get "background.offsetX"() {
		return t("timeline.propertyBgOffsetX");
	},
	get "background.offsetY"() {
		return t("timeline.propertyBgOffsetY");
	},
	get "background.cornerRadius"() {
		return t("timeline.propertyCornerRadius");
	},
};

export function getPropertyLabel(path: AnimationPath): string {
	if (PROPERTY_LABELS[path]) return PROPERTY_LABELS[path];
	if (path.startsWith("params.")) return path.slice("params.".length);
	if (path.startsWith("effects.")) {
		const parts = path.split(".");
		return parts[parts.length - 1];
	}
	return path;
}

export function getExpandedRows({
	animations,
}: {
	animations: ElementAnimations | undefined;
}): ExpandedRow[] {
	const keyframes = getElementKeyframes({ animations });
	const propertyPaths = [...new Set(keyframes.map((kf) => kf.propertyPath))];
	if (propertyPaths.length === 0) return [];

	const rows: ExpandedRow[] = [];

	for (const group of PROPERTY_GROUPS) {
		const groupPaths = propertyPaths.filter((path) =>
			group.matchesPath(path),
		);
		for (const path of groupPaths) {
			rows.push({ propertyPath: path, label: getPropertyLabel(path) });
		}
	}

	return rows;
}

export function getExpansionHeight({ rows }: { rows: ExpandedRow[] }): number {
	return rows.length * KEYFRAME_LANE_HEIGHT_PX;
}

export function computeTrackExpansionHeight({
	track,
	expandedElementIds,
}: {
	track: TimelineTrack;
	expandedElementIds: Set<string>;
}): number {
	let maxHeight = 0;
	for (const element of track.elements) {
		if (!expandedElementIds.has(element.id)) continue;
		const rows = getExpandedRows({ animations: element.animations });
		maxHeight = Math.max(maxHeight, getExpansionHeight({ rows }));
	}
	return maxHeight;
}

export function getTrackExpandedRows({
	track,
	expandedElementIds,
}: {
	track: TimelineTrack;
	expandedElementIds: Set<string>;
}): ExpandedRow[] {
	let maxHeight = 0;
	let maxRows: ExpandedRow[] = [];

	for (const element of track.elements) {
		if (!expandedElementIds.has(element.id)) continue;
		const rows = getExpandedRows({ animations: element.animations });
		const height = getExpansionHeight({ rows });
		if (height > maxHeight) {
			maxHeight = height;
			maxRows = rows;
		}
	}

	return maxRows;
}
