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

/** 用户从素材面板引用的素材，发送时拼进消息文本 */
export interface AiChatReference {
	id: string;
	name: string;
	type: string;
	duration?: number | null;
}

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
	addReference: ({ reference }: { reference: AiChatReference }) => void;
	removeReference: ({ id }: { id: string }) => void;
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

function formatReferenceLine({
	reference,
	index,
}: {
	reference: AiChatReference;
	index: number;
}): string {
	const parts = [`「${reference.name}」`, reference.type];
	if (reference.duration != null) {
		parts.push(`${Math.round(reference.duration * 10) / 10}s`);
	}
	parts.push(`id:${reference.id}`);
	return `${index + 1}. ${parts.join(" ")}`;
}

/** 引用块拼在用户消息开头；语义与查看方式由 system prompt 规则 12 承载，此处只留数据 */
function buildReferencesBlock(references: AiChatReference[]): string {
	const lines = references.map((reference, index) =>
		formatReferenceLine({ reference, index }),
	);
	return ["我引用的素材：", ...lines].join("\n");
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

	/** 消费 SSE 流；返回本轮是否收到过 result 事件（false 说明流被中断/异常结束） */
	const consumeSSEStream = async (
		reader: ReadableStreamDefaultReader<Uint8Array>,
	): Promise<boolean> => {
		const decoder = new TextDecoder();
		let buffer = "";
		let currentEvent = "";
		let sawResult = false;

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
		return sawResult;
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
			references: [],
		});
		try {
			const session = await openAgentSession({ projectId, forceNew });
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
			void initSession({ projectId, forceNew: true });
		},

		setInput: ({ value }) => set({ input: value }),

		addReference: ({ reference }) =>
			set((state) =>
				state.references.some((item) => item.id === reference.id)
					? state
					: { references: [...state.references, reference] },
			),

		removeReference: ({ id }) =>
			set((state) => ({
				references: state.references.filter((item) => item.id !== id),
			})),

		sendMessage: async () => {
			const { input, sending, sessionId, references } = get();
			const message = input.trim();
			if (!message || sending || !sessionId) return;

			const fullMessage = references.length
				? `${buildReferencesBlock(references)}\n${message}`
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
			let failed = false;
			try {
				abortController = new AbortController();
				const res = await sendAgentMessage({
					sessionId,
					message: fullMessage,
					signal: abortController.signal,
				});
				const reader = res.body?.getReader();
				if (reader) sawResult = await consumeSSEStream(reader);
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
				// 流已结束但没收到 result：连接中断/被截断，明确告知用户，避免"静默结束"
				if (!sawResult && !failed && !abortedByUser) {
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
