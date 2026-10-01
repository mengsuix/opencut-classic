import { EditorCore } from "@/core";
import { BRIDGE_COMMANDS } from "./registry";

const BRIDGE_PORT = process.env.NEXT_PUBLIC_OPENCUT_MCP_PORT ?? "7331";
const BRIDGE_URL = `ws://127.0.0.1:${BRIDGE_PORT}`;
const RECONNECT_DELAY_MS = 3000;
const CLIENT_ID_STORAGE_KEY = "opencut-bridge-client-id";

interface BridgeRequest {
	type: "request";
	id: string;
	command: string;
	args?: Record<string, unknown>;
}

/**
 * 页面在后台时 Chromium 会暂停 rAF：播放不推进、预览不刷新、抽帧只是旧帧。
 * 而本地桥（ws://127.0.0.1:7331）只有一个连接位，后台标签页占着它，agent 的
 * 所有命令都会落到用户看不见的实例上——所以本地桥只在页面可见时连接。
 */
function isPageVisible(): boolean {
	return typeof document === "undefined" || document.visibilityState !== "hidden";
}

/** 同一标签页复用同一个 id，便于在日志里分辨是哪个标签页占着桥。 */
function getClientId(): string {
	try {
		const existing = window.sessionStorage.getItem(CLIENT_ID_STORAGE_KEY);
		if (existing) return existing;
		const id = crypto.randomUUID();
		window.sessionStorage.setItem(CLIENT_ID_STORAGE_KEY, id);
		return id;
	} catch {
		return "unknown";
	}
}

function createBridgeConnection({
	url,
	yieldWhenHidden = false,
}: {
	url: string;
	yieldWhenHidden?: boolean;
}): () => void {
	let socket: WebSocket | null = null;
	let closed = false;
	let reconnectTimer: number | null = null;

	const scheduleReconnect = () => {
		if (closed || reconnectTimer !== null) return;
		reconnectTimer = window.setTimeout(() => {
			reconnectTimer = null;
			connect();
		}, RECONNECT_DELAY_MS);
	};

	const handleRequest = async (request: BridgeRequest) => {
		const respond = (payload: Record<string, unknown>) => {
			if (socket?.readyState === WebSocket.OPEN) {
				socket.send(JSON.stringify(payload));
			}
		};

		try {
			const definition = BRIDGE_COMMANDS[request.command];
			if (!definition) {
				throw new Error(
					`Unknown command: ${request.command}. Use commands.list to discover available commands.`,
				);
			}
			const editor = EditorCore.getInstance();
			// Attribute any commands pushed during this run to the agent in the
			// undo history. Best-effort: concurrent bridge requests may overwrite
			// each other's meta (MCP clients typically call tools sequentially).
			editor.command.currentMeta = { source: "agent", label: request.command };
			// Agent 按绝对时间操作：执行期间禁用波纹编辑，避免删除/裁剪后
			// 同轨道后续元素被自动前移（UI 开关 rippleEditingEnabled 默认开启，
			// 不隔离的话 agent 的每次删除都会意外移动无关元素）。
			const rippleWasEnabled = editor.command.isRippleEnabled;
			editor.command.isRippleEnabled = false;
			try {
				const result = await definition.run({
					editor,
					args: request.args ?? {},
				});
				respond({
					type: "response",
					id: request.id,
					ok: true,
					result: result ?? null,
				});
			} finally {
				editor.command.isRippleEnabled = rippleWasEnabled;
				editor.command.currentMeta = null;
			}
		} catch (error) {
			respond({
				type: "response",
				id: request.id,
				ok: false,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	};

	const connect = () => {
		if (closed) return;
		// 后台标签页不抢连接位（等 visibilitychange 唤醒重连）。
		if (yieldWhenHidden && !isPageVisible()) return;

		try {
			socket = new WebSocket(url);
		} catch {
			scheduleReconnect();
			return;
		}

		socket.onopen = () => {
			const editor = EditorCore.getInstance();
			const project = editor.project.getActiveOrNull();
			const clientId = getClientId();
			socket?.send(
				JSON.stringify({
					type: "hello",
					role: "editor",
					clientId,
					visible: isPageVisible(),
					projectId: project?.metadata.id ?? null,
					projectName: project?.metadata.name ?? null,
				}),
			);
			console.info(`[command-bridge] Connected to agent bridge (${clientId})`);
		};

		socket.onmessage = (event) => {
			let message: BridgeRequest;
			try {
				message = JSON.parse(String(event.data));
			} catch {
				return;
			}
			if (message.type !== "request") return;
			void handleRequest(message);
		};

		socket.onclose = () => {
			socket = null;
			// 后台标签页让位，不抢连接位（重新可见时会立刻重连）。
			if (yieldWhenHidden && !isPageVisible()) return;
			scheduleReconnect();
		};

		socket.onerror = () => {
			socket?.close();
		};
	};

	const handleVisibilityChange = () => {
		if (closed) return;
		if (document.visibilityState === "hidden") {
			// 让出唯一的连接位，避免 agent 操作到看不见的实例上。
			if (reconnectTimer !== null) {
				window.clearTimeout(reconnectTimer);
				reconnectTimer = null;
			}
			socket?.close();
			return;
		}
		if (socket) return;
		if (reconnectTimer !== null) {
			window.clearTimeout(reconnectTimer);
			reconnectTimer = null;
		}
		connect();
	};

	if (yieldWhenHidden && typeof document !== "undefined") {
		document.addEventListener("visibilitychange", handleVisibilityChange);
	}

	connect();

	return () => {
		closed = true;
		if (reconnectTimer !== null) {
			window.clearTimeout(reconnectTimer);
		}
		if (yieldWhenHidden && typeof document !== "undefined") {
			document.removeEventListener("visibilitychange", handleVisibilityChange);
		}
		socket?.close();
	};
}

/** 本地开发模式：连接本机 MCP server（packages/mcp-server，ws://127.0.0.1:7331） */
export function startEditorCommandBridge(): () => void {
	// 本地桥只有一个连接位：由可见的标签页独占，后台标签页让位。
	return createBridgeConnection({ url: BRIDGE_URL, yieldWhenHidden: true });
}

/** 云端模式：AI 面板打开后连接 Agent Gateway（wss://.../ws/editor?session_id=...） */
export function startCloudEditorBridge({ url }: { url: string }): () => void {
	// 云端按 session 隔离，且"用户切走后 agent 继续干活"是正常用法，故不让位。
	return createBridgeConnection({ url });
}
