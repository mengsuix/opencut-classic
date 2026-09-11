import { t } from "@/i18n";
import type { ParamDefinition } from "@/params";
import { applyAlignedStroke } from "../stroke";
import { STROKE_ALIGN_PARAM, type GraphicStrokeAlign } from "./shared";
import type { GraphicDefinition } from "../types";

interface ArrowParams {
	fill: string;
	stroke: string;
	strokeWidth: number;
	strokeAlign: GraphicStrokeAlign;
	length: number;
	headSize: number;
	thickness: number;
}

const ARROW_PARAMS: ParamDefinition<keyof ArrowParams & string>[] = [
	{
		key: "fill",
		get label() { return t("properties.fill"); },
		type: "color",
		default: "#ffffff",
	},
	{
		key: "stroke",
		get label() { return t("properties.color"); },
		type: "color",
		default: "#000000",
		group: "stroke",
	},
	{
		key: "strokeWidth",
		get label() { return t("properties.width"); },
		type: "number",
		default: 0,
		min: 0,
		max: 64,
		step: 1,
		shortLabel: "W",
		group: "stroke",
	},
	STROKE_ALIGN_PARAM,
	{
		key: "length",
		get label() { return t("properties.arrowLength"); },
		type: "number",
		default: 80,
		min: 10,
		max: 100,
		step: 1,
		shortLabel: "L",
	},
	{
		key: "headSize",
		get label() { return t("properties.arrowHeadSize"); },
		type: "number",
		default: 40,
		min: 0,
		max: 100,
		step: 1,
		shortLabel: "H",
	},
	{
		key: "thickness",
		get label() { return t("properties.arrowThickness"); },
		type: "number",
		default: 15,
		min: 1,
		max: 100,
		step: 1,
		shortLabel: "T",
	},
];

function clampPercent({ value, fallback }: { value: number; fallback: number }): number {
	if (!Number.isFinite(value)) return fallback;
	return Math.max(0, Math.min(100, value));
}

/**
 * Arrow pointing right along the X axis, centered in the source canvas.
 * Rotate the element (transform.rotate) to aim it; headSize 0 degenerates to
 * a plain bar, which covers the "line/underline" use case without a second
 * definition.
 */
export const arrowGraphicDefinition: GraphicDefinition = {
	id: "arrow",
	get name() { return t("properties.graphicArrow"); },
	keywords: ["arrow", "pointer", "line", "underline", "箭头", "指向", "直线"],
	params: ARROW_PARAMS,
	render({ ctx, params, width, height }) {
		const fill = String(params.fill ?? "#ffffff");
		const stroke = String(params.stroke ?? "#000000");
		const strokeWidth = Math.max(0, Number(params.strokeWidth ?? 0));
		const strokeAlign = (params.strokeAlign ?? "center") as GraphicStrokeAlign;
		const inset = strokeAlign === "center" ? strokeWidth / 2 : 0;
		const drawWidth = Math.max(1, width - inset * 2);
		const drawHeight = Math.max(1, height - inset * 2);

		const lengthPercent = clampPercent({
			value: Number(params.length ?? 80),
			fallback: 80,
		});
		const headPercent = clampPercent({
			value: Number(params.headSize ?? 40),
			fallback: 40,
		});
		const thicknessPercent = clampPercent({
			value: Number(params.thickness ?? 15),
			fallback: 15,
		});

		const cx = inset + drawWidth / 2;
		const cy = inset + drawHeight / 2;
		const totalLength = Math.max(1, drawWidth * (lengthPercent / 100));
		const headLength = totalLength * (headPercent / 100);
		const shaftThickness = Math.max(
			1,
			drawHeight * (thicknessPercent / 100),
		);
		// Head must be at least as wide as the shaft so the outline never
		// pinches inward at the barbs.
		const headWidth = Math.min(
			drawHeight,
			Math.max(shaftThickness, headLength * 1.2),
		);

		const startX = cx - totalLength / 2;
		const endX = cx + totalLength / 2;
		const barbX = endX - headLength;
		const halfShaft = shaftThickness / 2;
		const halfHead = headWidth / 2;

		ctx.clearRect(0, 0, width, height);
		const path = new Path2D();
		path.moveTo(startX, cy - halfShaft);
		path.lineTo(barbX, cy - halfShaft);
		path.lineTo(barbX, cy - halfHead);
		path.lineTo(endX, cy);
		path.lineTo(barbX, cy + halfHead);
		path.lineTo(barbX, cy + halfShaft);
		path.lineTo(startX, cy + halfShaft);
		path.closePath();
		ctx.fillStyle = fill;
		ctx.fill(path);

		if (strokeWidth > 0) {
			applyAlignedStroke({
				ctx,
				path,
				strokeWidth,
				strokeAlign,
				strokeColor: stroke,
			});
		}
	},
};
