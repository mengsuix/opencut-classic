import type {
	ElementAnimations,
	MaskParamPath,
} from "@/animation/types";
import type { BaseMaskParams } from "@/masks/types";
import type { ParamValue } from "@/params";
import { removeElementKeyframe } from "./keyframes";
import { resolveAnimationPathValueAtTime } from "./resolve";

export const MASK_PARAM_PATH_PREFIX = "masks.";
export const MASK_PARAM_PATH_SUFFIX = ".params.";

export function buildMaskParamPath({
	maskId,
	paramKey,
}: {
	maskId: string;
	paramKey: string;
}): MaskParamPath {
	return `${MASK_PARAM_PATH_PREFIX}${maskId}${MASK_PARAM_PATH_SUFFIX}${paramKey}`;
}

export function isMaskParamPath(
	propertyPath: string,
): propertyPath is MaskParamPath {
	return (
		propertyPath.startsWith(MASK_PARAM_PATH_PREFIX) &&
		propertyPath.includes(MASK_PARAM_PATH_SUFFIX)
	);
}

export function parseMaskParamPath({
	propertyPath,
}: {
	propertyPath: string;
}): { maskId: string; paramKey: string } | null {
	if (!isMaskParamPath(propertyPath)) {
		return null;
	}

	const withoutPrefix = propertyPath.slice(MASK_PARAM_PATH_PREFIX.length);
	const separatorIndex = withoutPrefix.indexOf(MASK_PARAM_PATH_SUFFIX);
	if (separatorIndex <= 0) {
		return null;
	}

	const maskId = withoutPrefix.slice(0, separatorIndex);
	const paramKey = withoutPrefix.slice(
		separatorIndex + MASK_PARAM_PATH_SUFFIX.length,
	);
	if (!maskId || !paramKey) {
		return null;
	}

	return { maskId, paramKey };
}

export function resolveMaskParamsAtTime<TParams extends BaseMaskParams>({
	maskId,
	params,
	animations,
	localTime,
}: {
	maskId: string;
	params: TParams;
	animations: ElementAnimations | undefined;
	localTime: number;
}): TParams {
	const safeLocalTime = Math.max(0, localTime);
	const resolved: Record<string, ParamValue> = {};

	for (const [paramKey, staticValue] of Object.entries(params)) {
		const path = buildMaskParamPath({ maskId, paramKey });
		resolved[paramKey] =
			animations?.[path] &&
			(typeof staticValue === "number" ||
				typeof staticValue === "string" ||
				typeof staticValue === "boolean")
				? resolveAnimationPathValueAtTime({
						animations,
						propertyPath: path,
						localTime: safeLocalTime,
						fallbackValue: staticValue,
					})
				: (staticValue as ParamValue);
	}

	return resolved as unknown as TParams;
}

export function removeMaskParamKeyframe({
	animations,
	maskId,
	paramKey,
	keyframeId,
}: {
	animations: ElementAnimations | undefined;
	maskId: string;
	paramKey: string;
	keyframeId: string;
}): ElementAnimations | undefined {
	return removeElementKeyframe({
		animations,
		propertyPath: buildMaskParamPath({ maskId, paramKey }),
		keyframeId,
	});
}
