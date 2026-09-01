import { effectsRegistry } from "../registry";
import { blurEffectDefinition } from "./blur";
import { channelShiftEffectDefinition } from "./channel-shift";
import { chromaKeyEffectDefinition } from "./chroma-key";
import { colorAdjustEffectDefinition } from "./color-adjust";
import { distortWaveEffectDefinition } from "./distort-wave";
import { edgeGlowEffectDefinition } from "./edge-glow";
import { filterEffectDefinition } from "./filter";
import { glowEffectDefinition } from "./glow";
import { noiseEffectDefinition } from "./noise";
import { pixelateEffectDefinition } from "./pixelate";
import { sharpenEffectDefinition } from "./sharpen";
import { swirlEffectDefinition } from "./swirl";
import { vignetteEffectDefinition } from "./vignette";

const defaultEffects = [
	blurEffectDefinition,
	colorAdjustEffectDefinition,
	chromaKeyEffectDefinition,
	channelShiftEffectDefinition,
	sharpenEffectDefinition,
	pixelateEffectDefinition,
	edgeGlowEffectDefinition,
	glowEffectDefinition,
	distortWaveEffectDefinition,
	swirlEffectDefinition,
	noiseEffectDefinition,
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
