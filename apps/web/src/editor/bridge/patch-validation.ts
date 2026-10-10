// Root-level fields that actually exist on TimelineElement. Anything else
// (e.g. a nested "transform" object or root "x"/"y") would be silently
// merged yet never read by the renderer, so reject it explicitly.
const ELEMENT_PATCH_ROOT_KEYS = new Set([
	"id",
	"name",
	"type",
	"duration",
	"startTime",
	"trimStart",
	"trimEnd",
	"sourceDuration",
	"params",
	"mediaId",
	"sourceType",
	"sourceUrl",
	"buffer",
	"isSourceAudioEnabled",
	"hidden",
	"retime",
	"effects",
	"masks",
	"stickerId",
	"intrinsicWidth",
	"intrinsicHeight",
	"definitionId",
	"effectType",
]);

export function validateElementPatchRootKeys(
	patch: Record<string, unknown>,
): void {
	if ("animations" in patch) {
		throw new Error(
			"update_elements does not accept animations — use keyframes.upsert / keyframes.retime / keyframes.remove instead (absolute timeline seconds).",
		);
	}
	const unknownKeys = Object.keys(patch).filter(
		(key) => !ELEMENT_PATCH_ROOT_KEYS.has(key),
	);
	if (unknownKeys.length > 0) {
		throw new Error(
			`Unknown element patch field(s): ${unknownKeys.join(", ")}. ` +
				'Position/scale/rotation live inside patch.params as flat keys, e.g. { params: { "transform.positionX": 120, "transform.positionY": 680 } }.',
		);
	}
}
