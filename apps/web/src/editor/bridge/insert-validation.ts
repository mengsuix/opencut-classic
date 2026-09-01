import { graphicsRegistry, registerDefaultGraphics } from "@/graphics";
import { buildGraphicElement } from "@/timeline/element-utils";
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
