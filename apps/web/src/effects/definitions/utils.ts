import { converter, parse } from "culori";

/** Scale a resolution-independent px value (authored against a 1920x1080
 * reference) into render-resolution pixels. */
export function scalePx({
	value,
	resolution,
	reference,
}: {
	value: number;
	resolution: number;
	reference: number;
}): number {
	return value * (resolution / reference);
}

export function readEffectNumber({
	params,
	key,
	fallback,
}: {
	params: Record<string, unknown>;
	key: string;
	fallback: number;
}): number {
	const raw = params[key];
	const value = typeof raw === "number" ? raw : Number.parseFloat(String(raw));
	return Number.isFinite(value) ? value : fallback;
}

const toRgb = converter("rgb");

/** Hex/css color string → [r, g, b] in 0..1 for vec4 uniform slots (.xyz). */
export function colorToRgbVec({
	color,
	fallback,
}: {
	color: unknown;
	fallback: [number, number, number];
}): [number, number, number] {
	if (typeof color !== "string") return fallback;
	const parsed = parse(color);
	const rgb = parsed ? toRgb(parsed) : null;
	if (!rgb) return fallback;
	return [rgb.r ?? 0, rgb.g ?? 0, rgb.b ?? 0];
}
