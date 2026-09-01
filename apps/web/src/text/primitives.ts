import type { TextCanvasContext, TextBlockMeasurement } from "@/text/layout";
import { DEFAULTS } from "@/timeline/defaults";
import { clamp } from "@/utils/math";
import { CORNER_RADIUS_MAX, CORNER_RADIUS_MIN } from "./background";
import {
	drawTextDecoration,
	getTextBackgroundRect,
	measureTextBlock,
	setCanvasLetterSpacing,
} from "./layout";
import type {
	ResolvedTextGradient,
	ResolvedTextShadow,
	ResolvedTextStroke,
} from "./style";
import { FONT_SIZE_SCALE_REFERENCE } from "./typography";

export type TextAlign = "left" | "center" | "right";
export type TextFontWeight = "normal" | "bold";
export type TextFontStyle = "normal" | "italic";
export type TextDecoration = "none" | "underline" | "line-through";

export interface TextLayoutParams {
	content: string;
	fontSize: number;
	fontFamily: string;
	fontWeight: TextFontWeight;
	fontStyle: TextFontStyle;
	textAlign: TextAlign;
	textDecoration?: TextDecoration;
	letterSpacing?: number;
	lineHeight?: number;
}

export interface ResolvedTextLayout {
	scaledFontSize: number;
	fontString: string;
	letterSpacing: number;
	lineHeightPx: number;
	fontSizeRatio: number;
	textAlign: TextAlign;
	textDecoration: TextDecoration;
}

export interface MeasuredTextLayout extends ResolvedTextLayout {
	lines: string[];
	lineMetrics: TextMetrics[];
	block: TextBlockMeasurement;
}

export interface ResolvedTextBackgroundLike {
	enabled: boolean;
	color: string;
	paddingX: number;
	paddingY: number;
	offsetX: number;
	offsetY: number;
	cornerRadius: number;
}

export function quoteFontFamily({ fontFamily }: { fontFamily: string }): string {
	return `"${fontFamily.replace(/"/g, '\\"')}"`;
}

export function buildTextFontString({
	fontFamily,
	fontWeight,
	fontStyle,
	scaledFontSize,
}: {
	fontFamily: string;
	fontWeight: TextFontWeight;
	fontStyle: TextFontStyle;
	scaledFontSize: number;
}): string {
	return `${fontStyle} ${fontWeight} ${scaledFontSize}px ${quoteFontFamily({ fontFamily })}, sans-serif`;
}

export function resolveTextLayout({
	text,
	canvasHeight,
}: {
	text: TextLayoutParams;
	canvasHeight: number;
}): ResolvedTextLayout {
	const scaledFontSize =
		text.fontSize * (canvasHeight / FONT_SIZE_SCALE_REFERENCE);
	const fontWeight = text.fontWeight === "bold" ? "bold" : "normal";
	const fontStyle = text.fontStyle === "italic" ? "italic" : "normal";
	const letterSpacing = text.letterSpacing ?? DEFAULTS.text.letterSpacing;
	const lineHeightPx =
		scaledFontSize * (text.lineHeight ?? DEFAULTS.text.lineHeight);
	const fontSizeRatio = text.fontSize / 15;

	return {
		scaledFontSize,
		fontString: buildTextFontString({
			fontFamily: text.fontFamily,
			fontWeight,
			fontStyle,
			scaledFontSize,
		}),
		letterSpacing,
		lineHeightPx,
		fontSizeRatio,
		textAlign: text.textAlign,
		textDecoration: text.textDecoration ?? "none",
	};
}

export function measureTextLayout({
	text,
	canvasHeight,
	ctx,
}: {
	text: TextLayoutParams;
	canvasHeight: number;
	ctx: TextCanvasContext;
}): MeasuredTextLayout {
	const resolvedLayout = resolveTextLayout({ text, canvasHeight });
	const lines = text.content.split("\n");

	ctx.save();
	ctx.font = resolvedLayout.fontString;
	ctx.textBaseline = "middle";
	setCanvasLetterSpacing({
		ctx,
		letterSpacingPx: resolvedLayout.letterSpacing,
	});
	const lineMetrics = lines.map((line) => ctx.measureText(line));
	ctx.restore();

	const block = measureTextBlock({
		lineMetrics,
		lineHeightPx: resolvedLayout.lineHeightPx,
	});

	return {
		...resolvedLayout,
		lines,
		lineMetrics,
		block,
	};
}

function buildTextFillStyle({
	ctx,
	layout,
	textColor,
	gradient,
}: {
	ctx: TextCanvasContext;
	layout: MeasuredTextLayout;
	textColor: string;
	gradient?: ResolvedTextGradient | null;
}): string | CanvasGradient {
	if (!gradient || layout.block.maxWidth <= 0 || layout.block.height <= 0) {
		return textColor;
	}
	const alignToLeft: Record<TextAlign, number> = {
		left: 0,
		center: -layout.block.maxWidth / 2,
		right: -layout.block.maxWidth,
	};
	const centerX = alignToLeft[layout.textAlign] + layout.block.maxWidth / 2;
	const radians = (gradient.angle * Math.PI) / 180;
	const dirX = Math.cos(radians);
	const dirY = Math.sin(radians);
	const halfLength =
		(layout.block.maxWidth * Math.abs(dirX) +
			layout.block.height * Math.abs(dirY)) /
		2;
	const gradientFill = ctx.createLinearGradient(
		centerX - dirX * halfLength,
		-dirY * halfLength,
		centerX + dirX * halfLength,
		dirY * halfLength,
	);
	gradientFill.addColorStop(0, textColor);
	gradientFill.addColorStop(1, gradient.color);
	return gradientFill;
}

function clearCanvasShadow({ ctx }: { ctx: TextCanvasContext }): void {
	ctx.shadowColor = "transparent";
	ctx.shadowBlur = 0;
	ctx.shadowOffsetX = 0;
	ctx.shadowOffsetY = 0;
}

export interface TextCharRenderState {
	opacityFactor: number;
	scaleFactor: number;
}

function drawTextPerChar({
	ctx,
	layout,
	stroke,
	charStateAt,
	textBaseline,
}: {
	ctx: TextCanvasContext;
	layout: MeasuredTextLayout;
	stroke?: ResolvedTextStroke | null;
	charStateAt: (index: number) => TextCharRenderState;
	textBaseline: CanvasTextBaseline;
}): void {
	// Canvas letterSpacing only applies between chars of a single draw call, so
	// per-char draws measure with spacing 0 and advance the cursor manually.
	setCanvasLetterSpacing({ ctx, letterSpacingPx: 0 });
	const spacing = layout.letterSpacing;

	let charIndex = 0;
	for (let index = 0; index < layout.lines.length; index++) {
		const lineY = index * layout.lineHeightPx - layout.block.visualCenterOffset;
		const lineWidth = layout.lineMetrics[index].width;
		const alignToLeft: Record<TextAlign, number> = {
			left: 0,
			center: -lineWidth / 2,
			right: -lineWidth,
		};
		let cursorX = alignToLeft[layout.textAlign];

		for (const char of Array.from(layout.lines[index])) {
			const state = charStateAt(charIndex);
			charIndex += 1;
			const charWidth = ctx.measureText(char).width;
			const charCenterX = cursorX + charWidth / 2;
			cursorX += charWidth + spacing;

			if (state.opacityFactor <= 0.001 || state.scaleFactor <= 0.001) {
				continue;
			}

			ctx.save();
			ctx.textAlign = "left";
			ctx.textBaseline = textBaseline;
			ctx.globalAlpha *= state.opacityFactor;
			ctx.translate(charCenterX, lineY);
			ctx.scale(state.scaleFactor, state.scaleFactor);
			if (stroke) {
				ctx.strokeText(char, -charWidth / 2, 0);
			}
			ctx.fillText(char, -charWidth / 2, 0);
			ctx.restore();
		}
	}
}

export function drawMeasuredTextLayout({
	ctx,
	layout,
	textColor,
	background,
	backgroundColor,
	stroke,
	shadow,
	gradient,
	textBaseline = "middle",
	charStateAt,
}: {
	ctx: TextCanvasContext;
	layout: MeasuredTextLayout;
	textColor: string;
	background?: ResolvedTextBackgroundLike | null;
	backgroundColor?: string;
	stroke?: ResolvedTextStroke | null;
	shadow?: ResolvedTextShadow | null;
	gradient?: ResolvedTextGradient | null;
	textBaseline?: CanvasTextBaseline;
	charStateAt?: (index: number) => TextCharRenderState;
}): void {
	ctx.font = layout.fontString;
	ctx.textAlign = layout.textAlign;
	ctx.textBaseline = textBaseline;
	const fillStyle = buildTextFillStyle({ ctx, layout, textColor, gradient });
	ctx.fillStyle = fillStyle;
	setCanvasLetterSpacing({ ctx, letterSpacingPx: layout.letterSpacing });

	if (
		background?.enabled &&
		backgroundColor &&
		backgroundColor !== "transparent" &&
		layout.lines.length > 0
	) {
		const backgroundRect = getTextBackgroundRect({
			textAlign: layout.textAlign,
			block: layout.block,
			background: {
				...background,
				color: backgroundColor,
			},
			fontSizeRatio: layout.fontSizeRatio,
		});
		if (backgroundRect) {
			const p =
				clamp({
					value: background.cornerRadius,
					min: CORNER_RADIUS_MIN,
					max: CORNER_RADIUS_MAX,
				}) / 100;
			const radius =
				(Math.min(backgroundRect.width, backgroundRect.height) / 2) * p;
			ctx.fillStyle = backgroundColor;
			ctx.beginPath();
			ctx.roundRect(
				backgroundRect.left,
				backgroundRect.top,
				backgroundRect.width,
				backgroundRect.height,
				radius,
			);
			ctx.fill();
			ctx.fillStyle = fillStyle;
		}
	}

	if (shadow) {
		ctx.shadowColor = shadow.color;
		ctx.shadowBlur = shadow.blur;
		ctx.shadowOffsetX = shadow.offsetX;
		ctx.shadowOffsetY = shadow.offsetY;
	}

	// Per-char animation draws each glyph with its own opacity/scale. Text
	// decoration is skipped in this mode (per-line decoration would span
	// not-yet-visible chars).
	if (charStateAt) {
		if (stroke && layout.lines.length > 0) {
			ctx.strokeStyle = stroke.color;
			ctx.lineWidth = stroke.width;
			ctx.lineJoin = "round";
			ctx.lineCap = "round";
		}
		drawTextPerChar({
			ctx,
			layout,
			stroke: stroke && layout.lines.length > 0 ? stroke : null,
			charStateAt,
			textBaseline,
		});
		clearCanvasShadow({ ctx });
		return;
	}

	if (stroke && layout.lines.length > 0) {
		ctx.strokeStyle = stroke.color;
		ctx.lineWidth = stroke.width;
		ctx.lineJoin = "round";
		ctx.lineCap = "round";
		for (let index = 0; index < layout.lines.length; index++) {
			const lineY =
				index * layout.lineHeightPx - layout.block.visualCenterOffset;
			ctx.strokeText(layout.lines[index], 0, lineY);
		}
		// The shadow is carried by the stroke pass only, so the fill pass
		// doesn't draw a second, darker shadow on top.
		clearCanvasShadow({ ctx });
	}

	for (let index = 0; index < layout.lines.length; index++) {
		const lineY = index * layout.lineHeightPx - layout.block.visualCenterOffset;
		ctx.fillText(layout.lines[index], 0, lineY);
		clearCanvasShadow({ ctx });
		drawTextDecoration({
			ctx,
			textDecoration: layout.textDecoration,
			lineWidth: layout.lineMetrics[index].width,
			lineY,
			metrics: layout.lineMetrics[index],
			scaledFontSize: layout.scaledFontSize,
			textAlign: layout.textAlign,
		});
	}
}

export function strokeMeasuredTextLayout({
	ctx,
	layout,
	strokeColor,
	strokeWidth,
	textBaseline = "middle",
}: {
	ctx: TextCanvasContext;
	layout: MeasuredTextLayout;
	strokeColor: string;
	strokeWidth: number;
	textBaseline?: CanvasTextBaseline;
}): void {
	ctx.font = layout.fontString;
	ctx.textAlign = layout.textAlign;
	ctx.textBaseline = textBaseline;
	ctx.strokeStyle = strokeColor;
	ctx.lineWidth = strokeWidth;
	ctx.lineJoin = "round";
	ctx.lineCap = "round";
	setCanvasLetterSpacing({ ctx, letterSpacingPx: layout.letterSpacing });

	for (let index = 0; index < layout.lines.length; index++) {
		const lineY = index * layout.lineHeightPx - layout.block.visualCenterOffset;
		ctx.strokeText(layout.lines[index], 0, lineY);
	}
}
