import { effectsRegistry } from "../registry";
import { blurEffectDefinition } from "./blur";
import { chromaKeyEffectDefinition } from "./chroma-key";
import { colorAdjustEffectDefinition } from "./color-adjust";
import { filterEffectDefinition } from "./filter";
import { pixelateEffectDefinition } from "./pixelate";
import { sharpenEffectDefinition } from "./sharpen";
import { vignetteEffectDefinition } from "./vignette";

const defaultEffects = [
	blurEffectDefinition,
	colorAdjustEffectDefinition,
	chromaKeyEffectDefinition,
	sharpenEffectDefinition,
	pixelateEffectDefinition,
	vignetteEffectDefinition,
	filterEffectDefinition,
];

export function registerDefaultEffects(): void {
	for (const definition of defaultEffects) {
		if (effectsRegistry.has(definition.type)) {
			continue;
		}
		effectsRegistry.register({
			key: definition.type,
			definition,
		});
	}
}
