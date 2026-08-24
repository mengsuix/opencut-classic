"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { getVideoFrames, quantizeFrameTime } from "./video-frame-cache";

/**
 * Scrolling changes the visible window continuously; decoding on every frame of
 * a drag would queue hundreds of passes. Wait until motion settles so a drag
 * costs one batch. Already-decoded frames still render immediately.
 */
const DECODE_DEBOUNCE_MS = 180;

export interface FilmstripTile {
	/** Offset from the element's left edge, in pixels. */
	leftPx: number;
	widthPx: number;
	/** Source time this tile represents, in seconds. */
	sourceTime: number;
	url: string;
}

/**
 * Builds a filmstrip covering only `windowLeftPx..windowRightPx` of an element
 * that spans `0..elementWidthPx`.
 *
 * The element itself keeps its true (possibly millions of pixels) width for hit
 * testing, but only the intersected window is turned into tiles. That decouples
 * rasterization cost from media duration and keeps every thumbnail at its native
 * resolution instead of being stretched across a huge box.
 */
export function useWindowedFilmstrip({
	mediaId,
	file,
	sourceStartSec,
	sourceEndSec,
	elementWidthPx,
	windowLeftPx,
	windowRightPx,
	tileWidthPx,
}: {
	mediaId: string;
	file: File | undefined;
	sourceStartSec: number;
	sourceEndSec: number;
	elementWidthPx: number;
	windowLeftPx: number;
	windowRightPx: number;
	tileWidthPx: number;
}): FilmstripTile[] {
	// Tile boundaries are anchored to a global grid so that scrolling shifts which
	// tiles are visible without changing where existing tiles start — otherwise
	// every scroll frame would resample at new offsets and never hit the cache.
	const layout = useMemo(() => {
		if (
			elementWidthPx <= 0 ||
			tileWidthPx <= 0 ||
			sourceEndSec <= sourceStartSec
		) {
			return [];
		}

		const clampedLeft = Math.max(0, windowLeftPx);
		const clampedRight = Math.min(elementWidthPx, windowRightPx);
		if (clampedRight <= clampedLeft) return [];

		const firstIndex = Math.floor(clampedLeft / tileWidthPx);
		const lastIndex = Math.ceil(clampedRight / tileWidthPx) - 1;
		const sourceSpan = sourceEndSec - sourceStartSec;

		const tiles: Array<Omit<FilmstripTile, "url">> = [];
		for (let index = firstIndex; index <= lastIndex; index += 1) {
			const leftPx = index * tileWidthPx;
			if (leftPx >= elementWidthPx) break;
			const widthPx = Math.min(tileWidthPx, elementWidthPx - leftPx);
			// Sample the tile's midpoint so the image represents what it covers.
			const progress = (leftPx + widthPx / 2) / elementWidthPx;
			tiles.push({
				leftPx,
				widthPx,
				sourceTime: quantizeFrameTime({
					time: sourceStartSec + sourceSpan * progress,
				}),
			});
		}
		return tiles;
	}, [
		elementWidthPx,
		tileWidthPx,
		sourceStartSec,
		sourceEndSec,
		windowLeftPx,
		windowRightPx,
	]);

	/**
	 * Resolved frame URLs keyed by quantized source time, retained across window
	 * changes so panning back over a visited region paints instantly.
	 *
	 * Entries only hold a reference to a data URL already owned by the shared
	 * frame cache, so this map's own footprint is negligible and needs no pruning.
	 */
	const [resolvedFrames, setResolvedFrames] = useState<Map<number, string>>(
		() => new Map(),
	);

	// Mirror of `resolvedFrames` for use inside effects, written after commit so
	// nothing mutates a ref during render.
	const resolvedRef = useRef<Map<number, string>>(resolvedFrames);
	useEffect(() => {
		resolvedRef.current = resolvedFrames;
	}, [resolvedFrames]);

	const requestedTimes = useMemo(
		() => layout.map((tile) => tile.sourceTime),
		[layout],
	);
	// Collapses the array identity into a stable primitive for the deps list.
	const requestKey = requestedTimes.join(",");

	useEffect(() => {
		if (!file || requestedTimes.length === 0) return;

		let active = true;
		const timer = setTimeout(() => {
			const missing = requestedTimes.filter(
				(time) => !resolvedRef.current.has(time),
			);
			if (missing.length === 0) return;

			const promises = getVideoFrames({ mediaId, file, times: missing });
			promises.forEach((promise, index) => {
				const time = missing[index];
				void promise.then((url) => {
					if (!active || !url) return;
					setResolvedFrames((current) => {
						if (current.get(time) === url) return current;
						const next = new Map(current);
						next.set(time, url);
						return next;
					});
				});
			});
		}, DECODE_DEBOUNCE_MS);

		return () => {
			active = false;
			clearTimeout(timer);
		};
	}, [mediaId, file, requestKey, requestedTimes]);

	return useMemo(
		() =>
			layout.map((tile) => ({
				...tile,
				url: resolvedFrames.get(tile.sourceTime) ?? "",
			})),
		[layout, resolvedFrames],
	);
}
