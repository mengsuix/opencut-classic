import { graphicsRegistry, registerDefaultGraphics } from "@/graphics";
import { buildGraphicElement } from "@/timeline/element-utils";
import { canElementGoOnTrack } from "@/timeline/placement";
import type { ElementType } from "@/timeline";
import type { InsertElementParams } from "@/commands/timeline/element/insert-element";
import type { ParamValues } from "@/params";
import { ZERO_MEDIA_TIME, type MediaTime } from "@/wasm";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function normalizeGraphicElementInput(
	element: Record<string, unknown>,
): Record<string, unknown> {
	if (element.type !== "graphic") {
		return element;
	}

	const definitionId = element.definitionId;
	if (typeof definitionId !== "string" || definitionId.length === 0) {
		throw new Error(
			"Graphic elements require element.definitionId. Use graphics.list to discover valid definition IDs.",
		);
	}

	registerDefaultGraphics();
	if (!graphicsRegistry.has(definitionId)) {
		const available = graphicsRegistry
			.getAll()
			.map((definition) => definition.id)
			.join(", ");
		throw new Error(
			`Unknown graphic definitionId "${definitionId}". Available: ${available}. Use graphics.list to discover graphic definitions.`,
		);
	}

	const rawParams = element.params;
	if (rawParams !== undefined && !isRecord(rawParams)) {
		throw new Error("Graphic element params must be an object");
	}

	const defaults = buildGraphicElement({
		definitionId,
		name: typeof element.name === "string" ? element.name : undefined,
		startTime:
			typeof element.startTime === "number"
				? (element.startTime as MediaTime)
				: ZERO_MEDIA_TIME,
		params: rawParams as Partial<ParamValues> | undefined,
	});
	const { params: _rawParams, ...elementWithoutParams } = element;

	return {
		...defaults,
		...elementWithoutParams,
		params: defaults.params,
	};
}

/**
 * Bridge 调用方（agent）可能给 auto 放置传一个与元素类型不兼容的
 * trackType（如 graphic 元素传 trackType:"video"）。核心命令层会拒绝并
 * 静默失败，导致 agent 误以为插入成功。这里在 bridge 入口把不兼容的
 * trackType 丢掉，回退为按元素类型自动选轨。
 */
export function coerceAutoPlacement({
	elementType,
	placement,
}: {
	elementType: string;
	placement: InsertElementParams["placement"];
}): InsertElementParams["placement"] {
	if (
		placement.mode === "auto" &&
		placement.trackType &&
		!canElementGoOnTrack({
			elementType: elementType as ElementType,
			trackType: placement.trackType,
		})
	) {
		console.warn(
			`[command-bridge] ${elementType} elements cannot be placed on ${placement.trackType} tracks; ignoring trackType and auto-placing on a compatible track`,
		);
		return { mode: "auto" };
	}
	return placement;
}
