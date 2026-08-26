import { EditorCore } from "@/core";
import { BRIDGE_COMMANDS } from "./registry";

const BRIDGE_PORT = process.env.NEXT_PUBLIC_OPENCUT_MCP_PORT ?? "7331";
const BRIDGE_URL = `ws://127.0.0.1:${BRIDGE_PORT}`;
const RECONNECT_DELAY_MS = 3000;

interface BridgeRequest {
	type: "request";
	id: string;
	command: string;
	args?: Record<string, unknown>;
}

function createBridgeConnection({ url }: { url: string }): () => void {
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

		try {
			socket = new WebSocket(url);
		} catch {
			scheduleReconnect();
			return;
		}

		socket.onopen = () => {
			const editor = EditorCore.getInstance();
			const project = editor.project.getActiveOrNull();
			socket?.send(
				JSON.stringify({
					type: "hello",
					role: "editor",
					projectId: project?.metadata.id ?? null,
					projectName: project?.metadata.name ?? null,
				}),
			);
			console.info("[command-bridge] Connected to agent bridge");
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
			scheduleReconnect();
		};

		socket.onerror = () => {
			socket?.close();
		};
	};

	connect();

	return () => {
		closed = true;
		if (reconnectTimer !== null) {
			window.clearTimeout(reconnectTimer);
		}
		socket?.close();
	};
}

/** 本地开发模式：连接本机 MCP server（packages/mcp-server，ws://127.0.0.1:7331） */
export function startEditorCommandBridge(): () => void {
	return createBridgeConnection({ url: BRIDGE_URL });
}

/** 云端模式：AI 面板打开后连接 Agent Gateway（wss://.../ws/editor?session_id=...） */
export function startCloudEditorBridge({ url }: { url: string }): () => void {
	return createBridgeConnection({ url });
}
