import type { ParamValues } from "@/params";
import { BaseNode, type AnyBaseNode } from "./base-node";
import type { ResolvedVisualNodeState, VisualNodeParams } from "./visual-node";

export type CodeRenderMode = "generator" | "effect" | "transition";

export type CodeRenderNodeParams = VisualNodeParams & {
	mode: CodeRenderMode;
	code: string;
	codeParams: ParamValues;
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
