import { readFile } from "node:fs/promises";
import { basename, extname } from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
	CallToolRequestSchema,
	ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { WebSocketServer, type WebSocket } from "ws";

const PORT = Number(process.env.OPENCUT_MCP_PORT ?? 7331);
const DEFAULT_TIMEOUT_MS = 120_000;

const COMMAND_TIMEOUTS: Record<string, number> = {
	"subtitles.transcribe": 900_000,
	"media.import": 600_000,
	"export.start": 1_800_000,
};

const MEDIA_MIME_BY_EXTENSION: Record<string, string> = {
	".mp4": "video/mp4",
	".mov": "video/quicktime",
	".webm": "video/webm",
	".mkv": "video/x-matroska",
	".m4v": "video/mp4",
	".mp3": "audio/mpeg",
	".wav": "audio/wav",
	".m4a": "audio/mp4",
	".aac": "audio/aac",
	".ogg": "audio/ogg",
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".webp": "image/webp",
	".gif": "image/gif",
};

async function loadMediaFile(path: string) {
	const extension = extname(path).toLowerCase();
	const mimeType = MEDIA_MIME_BY_EXTENSION[extension];
	if (!mimeType) {
		throw new Error(
			`Unsupported media extension: ${extension || "(none)"}. Supported: ${Object.keys(MEDIA_MIME_BY_EXTENSION).join(", ")}`,
		);
	}
	const buffer = await readFile(path);
	return {
		name: basename(path),
		mimeType,
		dataBase64: buffer.toString("base64"),
	};
}

interface EditorInfo {
	projectId: string | null;
	projectName: string | null;
}

interface PendingRequest {
	resolve: (result: unknown) => void;
	reject: (error: Error) => void;
	timer: ReturnType<typeof setTimeout>;
}

let editorSocket: WebSocket | null = null;
let editorInfo: EditorInfo | null = null;
const pending = new Map<string, PendingRequest>();
let nextRequestId = 1;

const wss = new WebSocketServer({ host: "127.0.0.1", port: PORT });

wss.on("error", (error: NodeJS.ErrnoException) => {
	if (error.code === "EADDRINUSE") {
		console.error(
			`[opencut-mcp] Port ${PORT} is already in use. Another MCP server instance is probably running.`,
		);
		process.exit(1);
	}
	console.error("[opencut-mcp] WebSocket server error:", error);
});

wss.on("connection", (socket, request) => {
	const origin = request.headers.origin ?? "";
	if (origin && !/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) {
		socket.close(1008, "Origin not allowed");
		return;
	}
	if (editorSocket) {
		socket.close(1013, "Another editor is already connected");
		return;
	}

	editorSocket = socket;
	editorInfo = null;
	console.error("[opencut-mcp] Editor connected");

	socket.on("message", (data) => {
		let message: Record<string, unknown>;
		try {
			message = JSON.parse(String(data));
		} catch {
			return;
		}

		if (message.type === "hello" && message.role === "editor") {
			editorInfo = {
				projectId: (message.projectId as string | null) ?? null,
				projectName: (message.projectName as string | null) ?? null,
			};
			return;
		}

		if (message.type === "response") {
			const entry = pending.get(message.id as string);
			if (!entry) return;
			pending.delete(message.id as string);
			clearTimeout(entry.timer);
			if (message.ok) {
				entry.resolve(message.result);
			} else {
				entry.reject(new Error(String(message.error ?? "Unknown editor error")));
			}
		}
	});

	socket.on("close", () => {
		if (editorSocket !== socket) return;
		editorSocket = null;
		editorInfo = null;
		console.error("[opencut-mcp] Editor disconnected");
		for (const [id, entry] of pending) {
			clearTimeout(entry.timer);
			entry.reject(new Error("Editor disconnected"));
			pending.delete(id);
		}
	});
});

function callEditor(command: string, args?: Record<string, unknown>) {
	if (!editorSocket) {
		return Promise.reject(
			new Error(
				"No editor connected. Open the OpenCut editor page in the browser; it connects to this bridge automatically.",
			),
		);
	}
	const id = `req-${nextRequestId++}`;
	const socket = editorSocket;
	const timeoutMs = COMMAND_TIMEOUTS[command] ?? DEFAULT_TIMEOUT_MS;
	return new Promise<unknown>((resolve, reject) => {
		const timer = setTimeout(() => {
			pending.delete(id);
			reject(new Error(`Editor command timed out: ${command}`));
		}, timeoutMs);
		pending.set(id, { resolve, reject, timer });
		socket.send(JSON.stringify({ type: "request", id, command, args: args ?? {} }));
	});
}

function textResult(value: unknown) {
	return {
		content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
	};
}

function errorResult(error: unknown) {
	return {
		isError: true,
		content: [
			{
				type: "text" as const,
				text: error instanceof Error ? error.message : String(error),
			},
		],
	};
}

const TOOLS = [
	{
		name: "editor_status",
		description:
			"Check whether an OpenCut editor page is connected to this bridge and which project is open.",
		inputSchema: { type: "object", properties: {} },
	},
	{
		name: "list_commands",
		description:
			"List all editor commands available via execute_command, with argument hints. All time values are in seconds.",
		inputSchema: { type: "object", properties: {} },
	},
	{
		name: "get_editor_state",
		description:
			"Get the current editor state: project settings, scenes, tracks and elements (times in seconds), selection, playback position, undo/redo availability, and media assets.",
		inputSchema: { type: "object", properties: {} },
	},
	{
		name: "get_selection",
		description:
			'Get the current editor selection in detail: selected timeline elements (refs, track type, element type, name, timing in seconds, text content), selected keyframes and mask points. When the user refers to "the selected part/clip/选中的部分", call this first to resolve what it refers to. Commands that accept an "elements" array also accept the string "$selection" to target the current selection directly.',
		inputSchema: { type: "object", properties: {} },
	},
	{
		name: "execute_command",
		description:
			'Execute an editor command in the open OpenCut editor. Use list_commands to discover commands. All time arguments are in seconds. Every command runs through the editor\'s command system, so changes are applied to the live preview immediately and are undoable. For commands that accept an "elements" array, you may pass the string "$selection" to target the user\'s current selection (fails if nothing is selected); use the get_selection tool to see what is selected.',
		inputSchema: {
			type: "object",
			properties: {
				command: {
					type: "string",
					description: "Command name, e.g. timeline.split_elements",
				},
				args: {
					type: "object",
					description: "Command arguments; see list_commands for hints",
				},
			},
			required: ["command"],
		},
	},
	{
		name: "get_preview_frame",
		description:
			"Capture a PNG frame of the current preview. Optionally render at a specific time (seconds) instead of the current playhead position. Use this for visual feedback after making edits.",
		inputSchema: {
			type: "object",
			properties: {
				time: {
					type: "number",
					description: "Time in seconds; defaults to current playhead",
				},
			},
		},
	},
];

const server = new Server(
	{ name: "opencut-editor", version: "0.1.0" },
	{ capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
	const { name, arguments: toolArgs } = request.params;

	try {
		switch (name) {
			case "editor_status":
				return textResult({
					connected: editorSocket !== null,
					...(editorInfo ?? {}),
					port: PORT,
				});
			case "list_commands":
				return textResult(await callEditor("commands.list"));
			case "get_editor_state":
				return textResult(await callEditor("state.get"));
			case "get_selection":
				return textResult(await callEditor("selection.describe"));
			case "execute_command": {
				const command = toolArgs?.command;
				if (typeof command !== "string" || command.length === 0) {
					return errorResult(new Error("Missing required argument: command"));
				}
				const args = (
					toolArgs?.args && typeof toolArgs.args === "object"
						? { ...(toolArgs.args as Record<string, unknown>) }
						: {}
				) as Record<string, unknown>;

				if (command === "media.import") {
					const path = args.path;
					if (typeof path !== "string" || path.length === 0) {
						return errorResult(
							new Error("media.import requires args.path (local file path)"),
						);
					}
					delete args.path;
					Object.assign(args, await loadMediaFile(path));
				}

				return textResult(await callEditor(command, args));
			}
			case "get_preview_frame": {
				const time = toolArgs?.time;
				const result = (await callEditor("preview.capture", {
					...(typeof time === "number" ? { time } : {}),
				})) as { dataUrl: string; width: number; height: number; time: number };
				const base64 = result.dataUrl.replace(/^data:image\/png;base64,/, "");
				return {
					content: [
						{
							type: "text" as const,
							text: JSON.stringify({
								width: result.width,
								height: result.height,
								time: result.time,
							}),
						},
						{
							type: "image" as const,
							data: base64,
							mimeType: "image/png",
						},
					],
				};
			}
			default:
				return errorResult(new Error(`Unknown tool: ${name}`));
		}
	} catch (error) {
		return errorResult(error);
	}
});

await server.connect(new StdioServerTransport());
console.error(
	`[opencut-mcp] MCP server ready; editor bridge listening on ws://127.0.0.1:${PORT}`,
);
