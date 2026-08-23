import { Popover, PopoverContent } from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { HugeiconsIcon } from "@hugeicons/react";
import { Undo02Icon, Redo02Icon } from "@hugeicons/core-free-icons";
import { useEditor } from "@/editor/use-editor";
import { historyLabel } from "@/editor/history-labels";
import { cn } from "@/utils/ui";

function relativeTime({ timestamp }: { timestamp: number }): string {
	const seconds = Math.floor((Date.now() - timestamp) / 1000);
	if (seconds < 5) return "刚刚";
	if (seconds < 60) return `${seconds} 秒前`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes} 分钟前`;
	const date = new Date(timestamp);
	const hours = String(date.getHours()).padStart(2, "0");
	const minutesStr = String(date.getMinutes()).padStart(2, "0");
	return `${hours}:${minutesStr}`;
}

function HistoryEntryRow({
	label,
	source,
	timestamp,
	targets,
	dimmed,
	onClick,
}: {
	label: string;
	source: "user" | "agent";
	timestamp: number;
	targets?: string[];
	dimmed: boolean;
	onClick: () => void;
}) {
	const targetText =
		targets && targets.length > 0
			? targets.length > 1
				? `${targets[0]} 等 ${targets.length} 项`
				: targets[0]
			: null;
	return (
		<button
			type="button"
			onClick={onClick}
			className={cn(
				"hover:bg-accent flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm",
				dimmed && "opacity-50",
			)}
		>
			<span className="flex-1 truncate">
				{historyLabel(label)}
				{targetText && (
					<span className="text-muted-foreground"> · {targetText}</span>
				)}
			</span>
			{source === "agent" && (
				<span className="bg-primary/15 text-primary shrink-0 rounded px-1 text-[10px]">
					AI
				</span>
			)}
			<span className="text-muted-foreground shrink-0 text-xs">
				{relativeTime({ timestamp })}
			</span>
		</button>
	);
}

export function HistoryPopover({ children }: { children: React.ReactNode }) {
	const editor = useEditor();
	const history = useEditor((e) => [...e.command.getHistory()]);
	const redoStack = useEditor((e) => [...e.command.getRedoStack()]);
	// redoStack is a stack: the last entry is the next one to redo.
	const redoDisplay = [...redoStack].reverse();

	return (
		<Popover>
			{children}
			<PopoverContent className="w-72 p-0" align="start">
				<div className="flex items-center justify-between border-b px-3 py-1.5">
					<span className="text-sm font-medium">编辑历史</span>
					<div className="flex items-center gap-1">
						<Button
							variant="text"
							size="icon"
							disabled={history.length === 0}
							onClick={() => editor.command.undo()}
							title="撤销"
						>
							<HugeiconsIcon icon={Undo02Icon} />
						</Button>
						<Button
							variant="text"
							size="icon"
							disabled={redoStack.length === 0}
							onClick={() => editor.command.redo()}
							title="重做"
						>
							<HugeiconsIcon icon={Redo02Icon} />
						</Button>
					</div>
				</div>
				<ScrollArea className="max-h-80">
					{history.length === 0 && redoDisplay.length === 0 ? (
						<p className="text-muted-foreground px-3 py-4 text-sm">
							暂无编辑记录
						</p>
					) : (
						<div className="py-1">
							{redoDisplay.map((entry, index) => (
								<HistoryEntryRow
									key={`redo-${entry.timestamp}-${index}`}
									label={entry.label}
									source={entry.source}
									timestamp={entry.timestamp}
									targets={entry.targets}
									dimmed={true}
									onClick={() =>
										editor.command.jumpTo({
											targetLength: history.length + index + 1,
										})
									}
								/>
							))}
							{redoDisplay.length > 0 && (
								<div className="text-muted-foreground flex items-center gap-2 px-3 py-1 text-xs">
									<div className="bg-border h-px flex-1" />
									当前位置
									<div className="bg-border h-px flex-1" />
								</div>
							)}
							{[...history].reverse().map((entry, reversedIndex) => {
								const index = history.length - 1 - reversedIndex;
								return (
									<HistoryEntryRow
										key={`history-${entry.timestamp}-${index}`}
										label={entry.label}
										source={entry.source}
										timestamp={entry.timestamp}
										targets={entry.targets}
										dimmed={false}
										onClick={() =>
											editor.command.jumpTo({ targetLength: index })
										}
									/>
								);
							})}
						</div>
					)}
				</ScrollArea>
				<p className="text-muted-foreground border-t px-3 py-1.5 text-xs">
					点击条目回到该操作之前；点击灰色条目重做
				</p>
			</PopoverContent>
		</Popover>
	);
}
