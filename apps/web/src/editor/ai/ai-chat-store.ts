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

interface AiChatState {
	isOpen: boolean;
	sessionId: string | null;
	messages: AiChatMessage[];
	input: string;
	sending: boolean;
	loading: boolean;
	streamingText: string;
	toolStatus: string;

	togglePanel: ({ projectId }: { projectId: string }) => void;
	setInput: ({ value }: { value: string }) => void;
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
			set((state) => ({ streamingText: state.streamingText + data.text, toolStatus: "" }));
		} else if (event === "thinking") {
			commitStreamingText();
			set({ toolStatus: "思考中..." });
		} else if (event === "tool_use") {
			commitStreamingText();
			const tool = typeof data.tool === "string" ? data.tool : "工具";
			const summary = typeof data.summary === "string" && data.summary ? ` → ${data.summary}` : "";
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

	const consumeSSEStream = async (reader: ReadableStreamDefaultReader<Uint8Array>) => {
		const decoder = new TextDecoder();
		let buffer = "";
		let currentEvent = "";

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

		togglePanel: ({ projectId }) => {
			if (get().isOpen) {
				abortController?.abort();
				abortController = null;
				bridgeCleanup?.();
				bridgeCleanup = null;
				set({ isOpen: false, streamingText: "", toolStatus: "" });
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

		sendMessage: async () => {
			const { input, sending, sessionId } = get();
			const message = input.trim();
			if (!message || sending || !sessionId) return;

			pushMessage({ role: "user", content: message, timestamp: nowSeconds() });
			set({ input: "", sending: true, streamingText: "" });

			try {
				abortController = new AbortController();
				const res = await sendAgentMessage({
					sessionId,
					message,
					signal: abortController.signal,
				});
				const reader = res.body?.getReader();
				if (reader) await consumeSSEStream(reader);
			} catch (error) {
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
				set({ sending: false, toolStatus: "" });
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
