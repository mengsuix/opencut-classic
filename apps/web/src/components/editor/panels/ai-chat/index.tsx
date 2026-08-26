"use client";

import { useEffect, useRef } from "react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Spinner } from "@/components/ui/spinner";
import { ReactMarkdownWrapper } from "@/components/ui/react-markdown-wrapper";
import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { useAiChatStore, type AiChatMessage } from "@/editor/ai/ai-chat-store";
import { EditorCore } from "@/core";
import { cn } from "@/utils/ui";
import { PlusIcon, Square, SendHorizonal } from "lucide-react";

function getProjectId(): string | null {
	const project = EditorCore.getInstance().project.getActiveOrNull();
	return project?.metadata.id ?? null;
}

export function AiChatPanel() {
	return (
		<div className="panel bg-background flex h-full flex-col overflow-hidden rounded-sm border">
			<AiChatHeader />
			<MessageList />
			<InputArea />
		</div>
	);
}

function AiChatHeader() {
	const newSession = useAiChatStore((s) => s.newSession);
	const sending = useAiChatStore((s) => s.sending);

	return (
		<div className="flex h-10 shrink-0 items-center justify-between border-b px-3">
			<span className="text-sm font-medium">AI 剪辑助手</span>
			<TooltipProvider delayDuration={0}>
				<Tooltip>
					<TooltipTrigger asChild>
						<Button
							variant="text"
							size="icon"
							className="h-7 w-7"
							disabled={sending}
							onClick={() => {
								const projectId = getProjectId();
								if (projectId) newSession({ projectId });
							}}
							aria-label="新建对话"
						>
							<PlusIcon className="size-4" />
						</Button>
					</TooltipTrigger>
					<TooltipContent side="bottom">新建对话</TooltipContent>
				</Tooltip>
			</TooltipProvider>
		</div>
	);
}

function MessageBubble({ message }: { message: AiChatMessage }) {
	if (message.role === "system") {
		return (
			<p className="text-muted-foreground px-1 py-0.5 text-center text-xs">
				{message.content}
			</p>
		);
	}
	const isUser = message.role === "user";
	return (
		<div
			className={cn(
				"max-w-[90%] rounded-lg px-3 py-2 text-sm leading-relaxed break-words",
				isUser
					? "bg-primary text-primary-foreground self-end"
					: "bg-muted self-start",
			)}
		>
			{isUser ? (
				message.content
			) : (
				<ReactMarkdownWrapper>{message.content}</ReactMarkdownWrapper>
			)}
		</div>
	);
}

function MessageList() {
	const messages = useAiChatStore((s) => s.messages);
	const streamingText = useAiChatStore((s) => s.streamingText);
	const toolStatus = useAiChatStore((s) => s.toolStatus);
	const loading = useAiChatStore((s) => s.loading);
	const bottomRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		bottomRef.current?.scrollIntoView({ block: "end" });
	}, [messages.length, streamingText, toolStatus]);

	return (
		<ScrollArea className="min-h-0 flex-1">
			<div className="flex flex-col gap-2 p-3">
				{loading && (
					<div className="flex items-center justify-center py-6">
						<Spinner className="size-5" />
					</div>
				)}
				{!loading && messages.length === 0 && !streamingText && (
					<p className="text-muted-foreground px-1 py-6 text-center text-xs">
						用自然语言让我帮你剪辑，例如：
						<br />
						「把选中的片段从 5 秒处剪开」
						<br />
						「给视频加一个字幕轨道」
					</p>
				)}
				{messages.map((message, index) => (
					<MessageBubble key={index} message={message} />
				))}
				{streamingText && (
					<div className="bg-muted max-w-[90%] self-start rounded-lg px-3 py-2 text-sm leading-relaxed break-words">
						<ReactMarkdownWrapper>{streamingText}</ReactMarkdownWrapper>
						<span className="bg-foreground ml-0.5 inline-block h-3.5 w-1.5 animate-pulse" />
					</div>
				)}
				{toolStatus && (
					<p className="text-muted-foreground flex items-center gap-1.5 px-1 text-xs">
						<Spinner className="size-3" />
						{toolStatus}
					</p>
				)}
				<div ref={bottomRef} />
			</div>
		</ScrollArea>
	);
}

function InputArea() {
	const input = useAiChatStore((s) => s.input);
	const setInput = useAiChatStore((s) => s.setInput);
	const sendMessage = useAiChatStore((s) => s.sendMessage);
	const abort = useAiChatStore((s) => s.abort);
	const sending = useAiChatStore((s) => s.sending);
	const sessionId = useAiChatStore((s) => s.sessionId);

	return (
		<div className="shrink-0 border-t p-2">
			<div className="flex items-end gap-2">
				<Textarea
					value={input}
					onChange={(e) => setInput({ value: e.target.value })}
					onKeyDown={(e) => {
						if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
							e.preventDefault();
							void sendMessage();
						}
					}}
					placeholder="描述你想做的剪辑..."
					className="max-h-32 min-h-9 flex-1 resize-none text-sm"
					rows={1}
				/>
				{sending ? (
					<Button
						variant="secondary"
						size="icon"
						className="h-9 w-9 shrink-0"
						onClick={abort}
						aria-label="停止生成"
					>
						<Square className="size-4" />
					</Button>
				) : (
					<Button
						size="icon"
						className="h-9 w-9 shrink-0"
						disabled={!input.trim() || !sessionId}
						onClick={() => void sendMessage()}
						aria-label="发送"
					>
						<SendHorizonal className="size-4" />
					</Button>
				)}
			</div>
		</div>
	);
}
