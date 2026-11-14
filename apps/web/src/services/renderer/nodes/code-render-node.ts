import type { ParamValues } from "@/params";
import { BaseNode, type AnyBaseNode } from "./base-node";
import type { ResolvedVisualNodeState, VisualNodeParams } from "./visual-node";

export type CodeRenderMode = "generator" | "effect" | "transition";

export type CodeRenderNodeParams = VisualNodeParams & {
	mode: CodeRenderMode;
	code: string;
	codeParams: ParamValues;
	inputTimeRanges?: Array<{ startTime: number; endTime: number }>;
};

export type ResolvedCodeRenderNodeState = {
	progress: number;
	time: number;
	duration: number;
	visual: ResolvedVisualNodeState | null;
};

export class CodeRenderNode extends BaseNode<
	CodeRenderNodeParams,
	ResolvedCodeRenderNodeState
> {
	constructor({
		inputs,
		...params
	}: CodeRenderNodeParams & { inputs: AnyBaseNode[] }) {
		super(params);
		for (const input of inputs) this.add(input);
	}

	getInputTime({ index, time }: { index: number; time: number }): number {
		const range = this.params.inputTimeRanges?.[index];
		if (
			this.params.mode !== "transition" ||
			!range ||
			time <= this.params.timeOffset ||
			time >= this.params.timeOffset + this.params.duration
		) {
			return time;
		}
		return Math.max(range.startTime, Math.min(time, range.endTime - 1));
	}

	get source() {
		return this.children[0];
	}

	get outgoing() {
		return this.children[0];
	}

	get incoming() {
		return this.children[1];
	}
}
