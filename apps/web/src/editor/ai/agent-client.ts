/**
 * Agent Gateway API client：会话打开、SSE 消息发送、打断、token 缓存。
 * 未配置 NEXT_PUBLIC_AGENT_GATEWAY_URL 时 AI 功能整体关闭。
 */

import { z } from "zod";

const tokenResponseSchema = z.object({ token: z.string() });

const historyMessageSchema = z.object({
	role: z.enum(["user", "assistant", "system"]),
	content: z.string(),
	created_at: z.number(),
});

const sessionResponseSchema = z.object({
	session_id: z.string(),
	history: z.array(historyMessageSchema),
});

const errorResponseSchema = z.object({ detail: z.string().optional() });

export type AgentHistoryMessage = z.infer<typeof historyMessageSchema>;

export interface AgentSession {
	sessionId: string;
	history: AgentHistoryMessage[];
}

const GATEWAY_URL = process.env.NEXT_PUBLIC_AGENT_GATEWAY_URL;

export function isAgentEnabled(): boolean {
	return Boolean(GATEWAY_URL);
}

function gatewayUrl(): string {
	if (!GATEWAY_URL) {
		throw new Error("未配置 NEXT_PUBLIC_AGENT_GATEWAY_URL");
	}
	return GATEWAY_URL;
}

let tokenCache: { token: string; fetchedAt: number } | null = null;
const TOKEN_CACHE_MS = 5 * 60 * 1000;

async function getGatewayToken(): Promise<string> {
	if (tokenCache && Date.now() - tokenCache.fetchedAt < TOKEN_CACHE_MS) {
		return tokenCache.token;
	}
	const res = await fetch("/api/agent/gateway-token");
	if (!res.ok) {
		throw new Error("未登录或登录已过期");
	}
	const data = tokenResponseSchema.parse(await res.json());
	tokenCache = { token: data.token, fetchedAt: Date.now() };
	return data.token;
}

async function agentFetch({
	path,
	init = {},
}: {
	path: string;
	init?: RequestInit;
}): Promise<Response> {
	const token = await getGatewayToken();
	return fetch(`${gatewayUrl()}${path}`, {
		...init,
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${token}`,
			...init.headers,
		},
	});
}

async function errorDetail(res: Response): Promise<string> {
	const parsed = errorResponseSchema.safeParse(await res.json().catch(() => ({})));
	return parsed.success && parsed.data.detail
		? parsed.data.detail
		: `请求失败 (${res.status})`;
}

export async function openAgentSession({
	projectId,
	forceNew = false,
}: {
	projectId: string;
	forceNew?: boolean;
}): Promise<AgentSession> {
	const res = await agentFetch({
		path: "/api/agent/sessions",
		init: {
			method: "POST",
			body: JSON.stringify({ project_id: projectId, force_new: forceNew }),
		},
	});
	if (!res.ok) throw new Error(await errorDetail(res));
	const data = sessionResponseSchema.parse(await res.json());
	return { sessionId: data.session_id, history: data.history };
}

/** 返回原始 Response，由调用方消费 SSE 流 */
export async function sendAgentMessage({
	sessionId,
	message,
	signal,
}: {
	sessionId: string;
	message: string;
	signal: AbortSignal;
}): Promise<Response> {
	const res = await agentFetch({
		path: `/api/agent/sessions/${sessionId}/messages`,
		init: {
			method: "POST",
			body: JSON.stringify({ message }),
			signal,
		},
	});
	if (!res.ok) throw new Error(await errorDetail(res));
	return res;
}

export async function interruptAgent({
	sessionId,
}: {
	sessionId: string;
}): Promise<void> {
	await agentFetch({
		path: `/api/agent/sessions/${sessionId}/interrupt`,
		init: { method: "POST" },
	}).catch(() => {});
}

export function buildEditorWsUrl({
	sessionId,
	token,
}: {
	sessionId: string;
	token: string;
}): string {
	const wsBase = gatewayUrl().replace(/^http/, "ws");
	return `${wsBase}/ws/editor?session_id=${sessionId}&token=${encodeURIComponent(token)}`;
}

export async function getEditorWsUrl({
	sessionId,
}: {
	sessionId: string;
}): Promise<string> {
	const token = await getGatewayToken();
	return buildEditorWsUrl({ sessionId, token });
}
