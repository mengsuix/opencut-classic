import type { ParamValues } from "@/params";

export const MAX_CODE_RENDER_CODE_LENGTH = 50_000;
export const MAX_CODE_RENDER_PARAMS = 64;
export const MAX_CODE_RENDER_PARAMS_JSON_LENGTH = 16_384;

export const CODE_EFFECT_CODE_KEY = "code.effect";
export const CODE_EFFECT_PARAMS_PREFIX = "code.effect.param.";

export function buildCodeEffectFromParams({ params }: { params: ParamValues }) {
	const code = params[CODE_EFFECT_CODE_KEY];
	const codeParams = Object.fromEntries(
		Object.entries(params)
			.filter(
				([key, value]) =>
					key.startsWith(CODE_EFFECT_PARAMS_PREFIX) && value !== "",
			)
			.slice(0, MAX_CODE_RENDER_PARAMS)
			.map(([key, value]) => [
				key.slice(CODE_EFFECT_PARAMS_PREFIX.length),
				value,
			]),
	);
	return {
		code: typeof code === "string" ? code : "",
		codeParams,
	};
}
