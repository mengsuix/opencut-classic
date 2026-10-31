"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useCommittedRef } from "@/hooks/use-committed-ref";
import type {
	BoxSelectionSnapshot,
	ResolveIntersections,
	SelectionBoxBounds,
} from "@/selection/types";

/** Pointer travel before a press on empty space turns into a box select. */
const BOX_SELECT_THRESHOLD_PX = 5;

interface BoxSelectSession<TId> extends BoxSelectionSnapshot<TId> {
	startPos: { x: number; y: number };
	isActive: boolean;
	isAdditive: boolean;
}

interface ActiveSelectionBox {
	bounds: SelectionBoxBounds | null;
}

function getSelectionBoxBounds({
	container,
	startPos,
	currentPos,
}: {
	container: HTMLElement;
	startPos: { x: number; y: number };
	currentPos: { x: number; y: number };
}): SelectionBoxBounds {
	const containerRect = container.getBoundingClientRect();
	const startX = startPos.x - containerRect.left;
	const startY = startPos.y - containerRect.top;
	const currentX = currentPos.x - containerRect.left;
	const currentY = currentPos.y - containerRect.top;

	return {
		left: Math.min(startX, currentX),
		top: Math.min(startY, currentY),
		width: Math.abs(currentX - startX),
		height: Math.abs(currentY - startY),
	};
}

interface UseBoxSelectOptions<TId> {
	containerRef: React.RefObject<HTMLElement | null>;
	resolveIntersections: ResolveIntersections<TId>;
	selectedIds: TId[];
	anchorId: TId | null;
	onSelectionChange: (state: {
		intersectedIds: TId[];
		initialSelectedIds: TId[];
		initialAnchorId: TId | null;
		isAdditive: boolean;
	}) => void;
	shouldStartSelection?: (event: React.MouseEvent<Element>) => boolean;
	getIsAdditiveSelection?: (event: React.MouseEvent<Element>) => boolean;
	isEnabled?: boolean;
}

/**
 * The gesture session lives outside React; only an *active* box (pointer moved
 * past the threshold) is state. A plain click on empty space used to set state
 * on mousedown, on every pre-threshold mousemove and again on mouseup — each one
 * re-rendering the owner (the whole timeline) for a gesture that draws nothing.
 * Options are read through a ref so `handleMouseDown` stays referentially stable
 * and doesn't defeat memoization of the components it is passed to.
 */
export function useBoxSelect<TId>(options: UseBoxSelectOptions<TId>) {
	const optionsRef = useCommittedRef(options);
	const [activeBox, setActiveBox] = useState<ActiveSelectionBox | null>(null);
	const justFinishedSelectingRef = useRef(false);
	const endSessionRef = useRef<(() => void) | null>(null);

	useEffect(() => () => endSessionRef.current?.(), []);

	const handleMouseDown = useCallback(
		(event: React.MouseEvent<Element>) => {
			const {
				containerRef,
				shouldStartSelection,
				getIsAdditiveSelection,
				isEnabled = true,
				selectedIds,
				anchorId,
			} = optionsRef.current;
			const canStartSelection = shouldStartSelection
				? shouldStartSelection(event)
				: true;
			if (!isEnabled || event.button !== 0 || !canStartSelection) {
				return;
			}

			endSessionRef.current?.();

			const container = containerRef.current;
			const session: BoxSelectSession<TId> = {
				startPos: { x: event.clientX, y: event.clientY },
				isActive: false,
				isAdditive: getIsAdditiveSelection
					? getIsAdditiveSelection(event)
					: event.ctrlKey || event.metaKey,
				initialSelectedIds: selectedIds,
				initialAnchorId: anchorId,
			};

			const previousBodyUserSelect = document.body.style.userSelect;
			const previousContainerUserSelect = container?.style.userSelect ?? "";
			let didApplyUserSelect = false;
			// Deferred past the current event dispatch: writing body styles here
			// would invalidate style for the whole document, and the next layout
			// read in a sibling handler (the timeline's seek reads the ruler rect
			// on the same mousedown) would force a full recalc.
			queueMicrotask(() => {
				if (endSessionRef.current !== endSession) return;
				didApplyUserSelect = true;
				document.body.style.userSelect = "none";
				if (container) {
					container.style.userSelect = "none";
				}
			});

			const handleMouseMove = ({ clientX, clientY }: MouseEvent) => {
				if (!session.isActive) {
					const deltaX = Math.abs(clientX - session.startPos.x);
					const deltaY = Math.abs(clientY - session.startPos.y);
					if (
						deltaX <= BOX_SELECT_THRESHOLD_PX &&
						deltaY <= BOX_SELECT_THRESHOLD_PX
					) {
						return;
					}
					session.isActive = true;
				}

				const currentPos = { x: clientX, y: clientY };
				setActiveBox({
					bounds: container
						? getSelectionBoxBounds({
								container,
								startPos: session.startPos,
								currentPos,
							})
						: null,
				});

				const { resolveIntersections, onSelectionChange } = optionsRef.current;
				onSelectionChange({
					intersectedIds: resolveIntersections({
						startPos: session.startPos,
						currentPos,
					}),
					initialSelectedIds: session.initialSelectedIds,
					initialAnchorId: session.initialAnchorId,
					isAdditive: session.isAdditive,
				});
			};

			const endSession = () => {
				window.removeEventListener("mousemove", handleMouseMove);
				window.removeEventListener("mouseup", handleMouseUp);
				if (didApplyUserSelect) {
					document.body.style.userSelect = previousBodyUserSelect;
					if (container) {
						container.style.userSelect = previousContainerUserSelect;
					}
				}
				if (endSessionRef.current === endSession) {
					endSessionRef.current = null;
				}
			};

			const handleMouseUp = () => {
				if (session.isActive) {
					justFinishedSelectingRef.current = true;
					requestAnimationFrame(() => {
						justFinishedSelectingRef.current = false;
					});
					setActiveBox(null);
				}
				endSession();
			};

			window.addEventListener("mousemove", handleMouseMove);
			window.addEventListener("mouseup", handleMouseUp);
			endSessionRef.current = endSession;
		},
		[optionsRef],
	);

	const shouldIgnoreClick = useCallback(() => {
		return justFinishedSelectingRef.current;
	}, []);

	const selectionBox = useMemo(
		() => (activeBox?.bounds ? { bounds: activeBox.bounds } : null),
		[activeBox],
	);

	return {
		selectionBox,
		handleMouseDown,
		isSelecting: activeBox !== null,
		shouldIgnoreClick,
	};
}
