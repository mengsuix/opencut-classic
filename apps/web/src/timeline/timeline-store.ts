/**
 * UI state for the timeline
 * For core logic, use EditorCore instead.
 */

import { create } from "zustand";
import { persist } from "zustand/middleware";

interface TimelineStore {
	snappingEnabled: boolean;
	toggleSnapping: () => void;
	rippleEditingEnabled: boolean;
	toggleRippleEditing: () => void;
	expandedElementIds: Set<string>;
	toggleElementExpanded: (elementId: string) => void;
	collapsedTrackIds: string[];
	toggleTrackCollapsed: (trackId: string) => void;
}

export const useTimelineStore = create<TimelineStore>()(
	persist(
		(set) => ({
			snappingEnabled: true,

			toggleSnapping: () => {
				set((state) => ({ snappingEnabled: !state.snappingEnabled }));
			},

			rippleEditingEnabled: false,

			toggleRippleEditing: () => {
				set((state) => ({
					rippleEditingEnabled: !state.rippleEditingEnabled,
				}));
			},

			collapsedTrackIds: [],

			toggleTrackCollapsed: (trackId) => {
				set((state) => ({
					collapsedTrackIds: state.collapsedTrackIds.includes(trackId)
						? state.collapsedTrackIds.filter((id) => id !== trackId)
						: [...state.collapsedTrackIds, trackId],
				}));
			},

			expandedElementIds: new Set<string>(),

			toggleElementExpanded: (elementId) => {
				set((state) => {
					const next = new Set(state.expandedElementIds);
					if (next.has(elementId)) {
						next.delete(elementId);
					} else {
						next.add(elementId);
					}
					return { expandedElementIds: next };
				});
			},
		}),
		{
			name: "timeline-store",
			version: 1,
			migrate: (persistedState) => {
				const state =
					typeof persistedState === "object" && persistedState !== null
						? persistedState
						: null;
				const snappingEnabled =
					state && "snappingEnabled" in state
						? state.snappingEnabled
						: undefined;
				const rippleEditingEnabled =
					state && "rippleEditingEnabled" in state
						? state.rippleEditingEnabled
						: undefined;
				return {
					snappingEnabled:
						typeof snappingEnabled === "boolean" ? snappingEnabled : true,
					rippleEditingEnabled:
						typeof rippleEditingEnabled === "boolean"
							? rippleEditingEnabled
							: false,
					collapsedTrackIds: [],
				};
			},
			partialize: (state) => ({
				snappingEnabled: state.snappingEnabled,
				rippleEditingEnabled: state.rippleEditingEnabled,
				collapsedTrackIds: state.collapsedTrackIds,
			}),
		},
	),
);
