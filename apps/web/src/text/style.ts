/**
 * Text style (stroke / shadow / gradient) types.
 * User-facing sizes are stored in the same reference units as fontSize
 * (scaled by canvasHeight / FONT_SIZE_SCALE_REFERENCE at resolve time).
 */
export interface TextStrokeStyle {
	enabled: boolean;
	color: string;
	width: number;
}

export interface TextShadowStyle {
	enabled: boolean;
	color: string;
	blur: number;
	offsetX: number;
	offsetY: number;
}

export interface TextGradientStyle {
	enabled: boolean;
	/** Second gradient stop; the first stop is the text color. */
	color: string;
	/** Degrees. 0 = left→right, 90 = top→bottom. */
	angle: number;
}

export interface TextStyleParams {
	stroke: TextStrokeStyle;
	shadow: TextShadowStyle;
	gradient: TextGradientStyle;
}

/** Style with sizes converted to canvas-local pixels; null when disabled. */
export interface ResolvedTextStroke {
	color: string;
	width: number;
}

export interface ResolvedTextShadow {
	color: string;
	blur: number;
	offsetX: number;
	offsetY: number;
}

export interface ResolvedTextGradient {
	color: string;
	angle: number;
}

export interface ResolvedTextStyle {
	stroke: ResolvedTextStroke | null;
	shadow: ResolvedTextShadow | null;
	gradient: ResolvedTextGradient | null;
}

export function resolveTextStyle({
	style,
	scale,
}: {
	style: TextStyleParams;
	scale: number;
}): ResolvedTextStyle {
	return {
		stroke:
			style.stroke.enabled && style.stroke.width > 0
				? { color: style.stroke.color, width: style.stroke.width * scale }
				: null,
		shadow: style.shadow.enabled
			? {
					color: style.shadow.color,
					blur: style.shadow.blur * scale,
					offsetX: style.shadow.offsetX * scale,
					offsetY: style.shadow.offsetY * scale,
				}
			: null,
		gradient: style.gradient.enabled
			? { color: style.gradient.color, angle: style.gradient.angle }
			: null,
	};
}
