import { generateUUID } from "@/utils/id";
import { buildDefaultParamValues } from "@/params/registry";
import { effectsRegistry } from "./registry";
import type { ParamValues } from "@/params";
import type { Effect, EffectDefinition, EffectPass } from "@/effects/types";
import { VISUAL_ELEMENT_TYPES } from "@/timeline";

export { effectsRegistry } from "./registry";
export { registerDefaultEffects } from "./definitions";

export function resolveEffectPasses({
	definition,
	effectParams,
	width,
	height,
	time,
}: {
	definition: EffectDefinition;
	effectParams: ParamValues;
	width: number;
	height: number;
	time: number;
}): EffectPass[] {
	if (definition.renderer.buildPasses) {
		return definition.renderer.buildPasses({ effectParams, width, height, time });
	}
	return definition.renderer.passes.map((pass) => ({
		shader: pass.shader,
		uniforms: pass.uniforms({ effectParams, width, height, time }),
	}));
}

export const EFFECT_TARGET_ELEMENT_TYPES = VISUAL_ELEMENT_TYPES;

export function buildDefaultEffectInstance({
	effectType,
}: {
	effectType: string;
}): Effect {
	const definition = effectsRegistry.get(effectType);
	const params: ParamValues = buildDefaultParamValues(definition.params);

	return {
		id: generateUUID(),
		type: effectType,
		params,
		enabled: true,
	};
}

/**
 * Compact one-line summary of an effect instance for dense UI such as
 * timeline clips (e.g. `15` for blur intensity). Uses the first numeric
 * parameter, which is the primary control for most effects (intensity,
 * amount, size...). Returns null when there is nothing worth showing.
 */
export function buildEffectParamSummary({
	definition,
	params,
}: {
	definition: EffectDefinition;
	params: ParamValues;
}): string | null {
	const numberParam = definition.params.find(
		(param) => param.type === "number",
	);
	if (!numberParam) return null;
	const value = params[numberParam.key];
	if (typeof value !== "number" || Number.isNaN(value)) return null;
	return String(Math.round(value * 100) / 100);
}
