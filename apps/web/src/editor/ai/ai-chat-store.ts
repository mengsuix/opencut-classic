/**
 * AI 对话面板状态（移植 infer-web useChat 的 SSE 消费模式为 zustand）。
 * 面板打开即创建/恢复会话并连接云端编辑器桥，关闭即断开。
 */

import { create } from "zustand";
import {
	getEditorWsUrl,
	interruptAgent,
	isAgentEnabled,
	openAgentSession,
	sendAgentMessage,
} from "./agent-client";

export interface AiChatMessage {
	role: "user" | "assistant" | "system";
	content: string;
	timestamp: number;
}

interface AiChatReferenceBase {
	/** 会话内稳定且不复用的引用标识，同时作为用户可见编号。 */
	refId: string;
	name: string;
}

export interface MediaChatReference extends AiChatReferenceBase {
	kind: "media";
	mediaId: string;
	type: string;
	duration?: number | null;
}

export interface ElementChatReference extends AiChatReferenceBase {
	kind: "element";
	trackId: string;
	elementId: string;
	trackType: string;
	type: string | null;
	startTime: number;
	duration: number;
	mediaId?: string;
	text?: string;
}

export interface CanvasChatReference extends AiChatReferenceBase {
	kind: "canvas";
	left: number;
	top: number;
	right: number;
	bottom: number;
	time: number;
}

export interface TimeRangeChatReference extends AiChatReferenceBase {
	kind: "time-range";
	startTime: number;
	endTime: number;
}

export type AiChatReference =
	| MediaChatReference
	| ElementChatReference
	| CanvasChatReference
	| TimeRangeChatReference;

export type AiChatReferenceInput =
	| Omit<MediaChatReference, "refId">
	| Omit<ElementChatReference, "refId">
	| Omit<CanvasChatReference, "refId">
	| Omit<TimeRangeChatReference, "refId">;

interface AiChatState {
	isOpen: boolean;
	sessionId: string | null;
	messages: AiChatMessage[];
	input: string;
	sending: boolean;
	loading: boolean;
	streamingText: string;
	toolStatus: string;
	/** 本轮请求开始时间戳（ms），用于展示等待秒数；非发送中为 null */
	sendStartedAt: number | null;
	references: AiChatReference[];

	togglePanel: ({ projectId }: { projectId: string }) => void;
	setInput: ({ value }: { value: string }) => void;
	addReference: ({ reference }: { reference: AiChatReferenceInput }) => void;
	removeReference: ({ refId }: { refId: string }) => void;
	clearReferences: (options?: { resetNumbering?: boolean }) => void;
	sendMessage: () => Promise<void>;
	abort: () => void;
	newSession: ({ projectId }: { projectId: string }) => void;
}

let abortController: AbortController | null = null;
let abortedByUser = false;
let bridgeCleanup: (() => void) | null = null;

function nowSeconds(): number {
	return Date.now() / 1000;
}

const REFERENCE_PREFIXES: Record<AiChatReference["kind"], string> = {
	media: "M",
	element: "E",
	canvas: "C",
	"time-range": "T",
};

const nextReferenceNumbers: Record<AiChatReference["kind"], number> = {
	media: 1,
	element: 1,
	canvas: 1,
	"time-range": 1,
};

function resetReferenceNumbering() {
	nextReferenceNumbers.media = 1;
	nextReferenceNumbers.element = 1;
	nextReferenceNumbers.canvas = 1;
	nextReferenceNumbers["time-range"] = 1;
}

/** 页面刷新恢复同一会话时，沿用历史消息中的最大编号，避免重复指代。 */
function retainReferenceNumbering(contents: string[]) {
	for (const content of contents) {
		for (const match of content.matchAll(/^\[([MECT])(\d+)\]/gm)) {
			const kind =
				match[1] === "M"
					? "media"
					: match[1] === "E"
						? "element"
						: match[1] === "C"
							? "canvas"
							: "time-range";
			nextReferenceNumbers[kind] = Math.max(
				nextReferenceNumbers[kind],
				Number(match[2]) + 1,
			);
		}
	}
}

function formatSeconds(value: number): string {
	return `${Number(value.toFixed(3))}s`;
}

function formatReferenceLine(reference: AiChatReference): string {
	const name = reference.name.replace(/\s+/g, " ");
	switch (reference.kind) {
		case "media":
			return [
				`[${reference.refId}] 素材「${name}」`,
				`type=${reference.type}`,
				reference.duration != null
					? `duration=${formatSeconds(reference.duration)}`
					: null,
				`mediaId=${reference.mediaId}`,
			]
				.filter(Boolean)
				.join(" ");
		case "element":
			return [
				`[${reference.refId}] 时间线元素「${name}」`,
				`type=${reference.type ?? "unknown"}`,
				`trackId=${reference.trackId}`,
				`elementId=${reference.elementId}`,
				`range=${formatSeconds(reference.startTime)}~${formatSeconds(reference.startTime + reference.duration)}`,
				reference.mediaId ? `mediaId=${reference.mediaId}` : null,
			]
				.filter(Boolean)
				.join(" ");
		case "canvas":
			return `[${reference.refId}] 画布区域 time=${formatSeconds(reference.time)} rect=[${[reference.left, reference.top, reference.right, reference.bottom].join(",")}]`;
		case "time-range":
			return `[${reference.refId}] 时间范围 start=${formatSeconds(reference.startTime)} end=${formatSeconds(reference.endTime)}`;
	}
}

/** 引用块包含发送时的完整快照，后续选区或标记变化不会改变本轮指代。 */
export function buildReferencesBlock(references: AiChatReference[]): string {
	return [
		"本次引用（编号是唯一指代，内容均为发送时快照）：",
		...references.map(formatReferenceLine),
	].join("\n");
}

export const useAiChatStore = create<AiChatState>()((set, get) => {
	const pushMessage = (message: AiChatMessage) =>
		set((state) => ({ messages: [...state.messages, message] }));

	const commitStreamingText = (suffix = "") => {
		const text = get().streamingText;
		if (!text) return;
		pushMessage({
			role: "assistant",
			content: text + suffix,
			timestamp: nowSeconds(),
		});
		set({ streamingText: "" });
	};

	const handleSSEEvent = ({
		event,
		data,
	}: {
		event: string;
		data: Record<string, unknown>;
	}) => {
		if (event === "text" && typeof data.text === "string") {
			set((state) => ({
				streamingText: state.streamingText + data.text,
				toolStatus: "",
			}));
		} else if (event === "thinking") {
			commitStreamingText();
			set({ toolStatus: "思考中..." });
		} else if (event === "tool_use") {
			commitStreamingText();
			const tool = typeof data.tool === "string" ? data.tool : "工具";
			const summary =
				typeof data.summary === "string" && data.summary
					? ` → ${data.summary}`
					: "";
			set({ toolStatus: `正在执行: ${tool}${summary}` });
		} else if (event === "result") {
			commitStreamingText();
			set({ toolStatus: "" });
		} else if (event === "error") {
			commitStreamingText();
			pushMessage({
				role: "system",
				content: `错误: ${String(data.error ?? "未知错误")}`,
				timestamp: nowSeconds(),
			});
			set({ toolStatus: "" });
		}
	};

	/** 消费 SSE 流；返回本轮是否收到过 result / error 事件 */
	const consumeSSEStream = async (
		reader: ReadableStreamDefaultReader<Uint8Array>,
	): Promise<{ sawResult: boolean; sawError: boolean }> => {
		const decoder = new TextDecoder();
		let buffer = "";
		let currentEvent = "";
		let sawResult = false;
		let sawError = false;

		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			buffer += decoder.decode(value, { stream: true });
			const lines = buffer.split("\n");
			buffer = lines.pop() ?? "";

			for (const line of lines) {
				if (line.startsWith("event: ")) {
					currentEvent = line.slice(7).trim();
				} else if (line.startsWith("data: ")) {
					try {
						handleSSEEvent({
							event: currentEvent,
							data: JSON.parse(line.slice(6)),
						});
						if (currentEvent === "result") sawResult = true;
						if (currentEvent === "error") sawError = true;
					} catch {
						// 忽略单行解析错误
					}
					currentEvent = "";
				} else if (line.trim() === "") {
					currentEvent = "";
				}
			}
		}
		commitStreamingText();
		return { sawResult, sawError };
	};

	const connectEditorBridge = async ({ sessionId }: { sessionId: string }) => {
		bridgeCleanup?.();
		bridgeCleanup = null;
		try {
			const url = await getEditorWsUrl({ sessionId });
			const { startCloudEditorBridge } = await import("../bridge/client");
			bridgeCleanup = startCloudEditorBridge({ url });
		} catch (error) {
			console.warn("[ai-chat] 编辑器桥连接失败:", error);
		}
	};

	const initSession = async ({
		projectId,
		forceNew,
	}: {
		projectId: string;
		forceNew: boolean;
	}) => {
		set({
			loading: true,
			messages: [],
			sessionId: null,
			streamingText: "",
			input: "",
			toolStatus: "",
		});
		try {
			const session = await openAgentSession({ projectId, forceNew });
			retainReferenceNumbering(
				session.history
					.filter((message) => message.role === "user")
					.map((message) => message.content),
			);
			set({
				sessionId: session.sessionId,
				messages: session.history.map((msg) => ({
					role: msg.role,
					content: msg.content,
					timestamp: msg.created_at,
				})),
			});
			await connectEditorBridge({ sessionId: session.sessionId });
		} catch (error) {
			pushMessage({
				role: "system",
				content: `连接 AI 服务失败: ${error instanceof Error ? error.message : String(error)}`,
				timestamp: nowSeconds(),
			});
		} finally {
			set({ loading: false });
		}
	};

	return {
		isOpen: false,
		sessionId: null,
		messages: [],
		input: "",
		sending: false,
		loading: false,
		streamingText: "",
		toolStatus: "",
		sendStartedAt: null,
		references: [],

		togglePanel: ({ projectId }) => {
			if (get().isOpen) {
				abortController?.abort();
				abortController = null;
				bridgeCleanup?.();
				bridgeCleanup = null;
				set({
					isOpen: false,
					streamingText: "",
					toolStatus: "",
					references: [],
				});
				return;
			}
			set({ isOpen: true });
			if (!isAgentEnabled()) {
				pushMessage({
					role: "system",
					content: "AI 功能未配置（缺少 NEXT_PUBLIC_AGENT_GATEWAY_URL）",
					timestamp: nowSeconds(),
				});
				return;
			}
			void initSession({ projectId, forceNew: false });
		},

		newSession: ({ projectId }) => {
			abortController?.abort();
			abortController = null;
			get().clearReferences({ resetNumbering: true });
			void initSession({ projectId, forceNew: true });
		},

		setInput: ({ value }) => set({ input: value }),

		addReference: ({ reference }) =>
			set((state) => {
				const existingIndex = state.references.findIndex((item) => {
					if (item.kind !== reference.kind) return false;
					if (reference.kind === "media" && item.kind === "media") {
						return item.mediaId === reference.mediaId;
					}
					if (reference.kind === "element" && item.kind === "element") {
						return (
							item.trackId === reference.trackId &&
							item.elementId === reference.elementId
						);
					}
					return false;
				});
				if (existingIndex >= 0) {
					const references = [...state.references];
					references[existingIndex] = {
						...reference,
						refId: references[existingIndex].refId,
					} as AiChatReference;
					return { references };
				}
				const refId = `${REFERENCE_PREFIXES[reference.kind]}${nextReferenceNumbers[reference.kind]++}`;
				return {
					references: [...state.references, { ...reference, refId } as AiChatReference],
				};
			}),

		removeReference: ({ refId }) =>
			set((state) => ({
				references: state.references.filter((item) => item.refId !== refId),
			})),

		clearReferences: ({ resetNumbering = false } = {}) => {
			if (resetNumbering) resetReferenceNumbering();
			set({ references: [] });
		},

		sendMessage: async () => {
			const { input, sending, sessionId, references } = get();
			const message = input.trim();
			if (!message || sending || !sessionId) return;

			const fullMessage = references.length
				? `${buildReferencesBlock(references)}\n\n用户指令：\n${message}`
				: message;

			pushMessage({
				role: "user",
				content: fullMessage,
				timestamp: nowSeconds(),
			});
			// 立即给出等待提示：首 token 到达前（长上下文可达 1-2 分钟）界面不能空着
			// references 随快照一并清空：窗口期新增的引用不会被误清（与 input 策略一致，失败不恢复）
			set({
				input: "",
				references: [],
				sending: true,
				streamingText: "",
				toolStatus: "思考中...",
				sendStartedAt: Date.now(),
			});

			let sawResult = false;
			let sawError = false;
			let failed = false;
			try {
				abortController = new AbortController();
				const res = await sendAgentMessage({
					sessionId,
					message: fullMessage,
					signal: abortController.signal,
				});
				const reader = res.body?.getReader();
				if (reader) {
					const streamState = await consumeSSEStream(reader);
					sawResult = streamState.sawResult;
					sawError = streamState.sawError;
				}
			} catch (error) {
				failed = true;
				if (error instanceof DOMException && error.name === "AbortError") {
					if (abortedByUser) commitStreamingText("\n\n_(已停止)_");
				} else {
					commitStreamingText();
					pushMessage({
						role: "system",
						content: `发送失败: ${error instanceof Error ? error.message : String(error)}`,
						timestamp: nowSeconds(),
					});
				}
			} finally {
				// 流已结束但没收到 result 也没收到 error：连接中断/被截断，明确告知用户，避免"静默结束"
				if (!sawResult && !sawError && !failed && !abortedByUser) {
					pushMessage({
						role: "system",
						content: "连接中断：未收到完整回复，请重试",
						timestamp: nowSeconds(),
					});
				}
				set({ sending: false, toolStatus: "", sendStartedAt: null });
				abortController = null;
				abortedByUser = false;
			}
		},

		abort: () => {
			const { sending, sessionId } = get();
			if (!abortController || !sending) return;
			abortedByUser = true;
			if (sessionId) void interruptAgent({ sessionId });
			abortController.abort();
			abortController = null;
		},
	};
});
