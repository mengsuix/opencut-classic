import { create } from "zustand";
import type { SoundEffect, SavedSound } from "@/sounds/types";
import {
	BUILTIN_SOUNDS,
	type BuiltinSound,
	type SoundCategory,
} from "@/sounds/builtin-sounds";
import { storageService } from "@/services/storage/service";
import { toast } from "sonner";
import { EditorCore } from "@/core";
import { t } from "@/i18n";
import { buildLibraryAudioElement } from "@/timeline/element-utils";
import { mediaTimeFromSeconds } from "@/wasm";

export type SoundCategoryFilter = SoundCategory | "all";

function builtinToSoundEffect({ sound }: { sound: BuiltinSound }): SoundEffect {
	const url = `/sounds/${sound.file}`;
	return {
		id: sound.id,
		name: sound.name,
		description: "",
		url,
		previewUrl: url,
		downloadUrl: url,
		duration: sound.duration,
		filesize: 0,
		type: "audio",
		channels: 0,
		bitrate: 0,
		bitdepth: 0,
		samplerate: 0,
		username: sound.author,
		tags: [sound.category],
		license: sound.license,
		created: "",
		downloads: 0,
		rating: 0,
		ratingCount: 0,
	};
}

export const BUILTIN_SOUND_EFFECTS: SoundEffect[] = BUILTIN_SOUNDS.map(
	(sound) => builtinToSoundEffect({ sound }),
);

interface SoundsStore {
	activeCategory: SoundCategoryFilter;
	scrollPosition: number;
	savedSounds: SavedSound[];
	isSavedSoundsLoaded: boolean;
	isLoadingSavedSounds: boolean;
	savedSoundsError: string | null;

	setActiveCategory: ({ category }: { category: SoundCategoryFilter }) => void;
	setScrollPosition: ({ position }: { position: number }) => void;
	addSoundToTimeline: ({ sound }: { sound: SoundEffect }) => Promise<boolean>;
	loadSavedSounds: () => Promise<void>;
	saveSoundEffect: ({
		soundEffect,
	}: {
		soundEffect: SoundEffect;
	}) => Promise<void>;
	removeSavedSound: ({ soundId }: { soundId: number }) => Promise<void>;
	isSoundSaved: ({ soundId }: { soundId: number }) => boolean;
	toggleSavedSound: ({
		soundEffect,
	}: {
		soundEffect: SoundEffect;
	}) => Promise<void>;
	clearSavedSounds: () => Promise<void>;
}

export const useSoundsStore = create<SoundsStore>((set, get) => ({
	activeCategory: "all",
	scrollPosition: 0,
	savedSounds: [],
	isSavedSoundsLoaded: false,
	isLoadingSavedSounds: false,
	savedSoundsError: null,

	setActiveCategory: ({ category }) => set({ activeCategory: category }),
	setScrollPosition: ({ position }) => set({ scrollPosition: position }),

	loadSavedSounds: async () => {
		if (get().isSavedSoundsLoaded) return;

		try {
			set({ isLoadingSavedSounds: true, savedSoundsError: null });
			const savedSoundsData = await storageService.loadSavedSounds();
			set({
				savedSounds: savedSoundsData.sounds,
				isSavedSoundsLoaded: true,
				isLoadingSavedSounds: false,
			});
		} catch (error) {
			const errorMessage =
				error instanceof Error
					? error.message
					: t("assets.loadSavedSoundsFailed");
			set({
				savedSoundsError: errorMessage,
				isLoadingSavedSounds: false,
			});
			console.error("Failed to load saved sounds:", error);
		}
	},

	saveSoundEffect: async ({ soundEffect }) => {
		try {
			await storageService.saveSoundEffect({ soundEffect });

			const savedSoundsData = await storageService.loadSavedSounds();
			set({ savedSounds: savedSoundsData.sounds });
		} catch (error) {
			const errorMessage =
				error instanceof Error ? error.message : t("assets.saveSoundFailed");
			set({ savedSoundsError: errorMessage });
			toast.error(t("assets.saveSoundFailed"));
			console.error("Failed to save sound:", error);
		}
	},

	removeSavedSound: async ({ soundId }) => {
		try {
			await storageService.removeSavedSound({ soundId });

			set((state) => ({
				savedSounds: state.savedSounds.filter((sound) => sound.id !== soundId),
			}));
		} catch (error) {
			const errorMessage =
				error instanceof Error ? error.message : t("assets.removeSoundFailed");
			set({ savedSoundsError: errorMessage });
			toast.error(t("assets.removeSoundFailed"));
			console.error("Failed to remove sound:", error);
		}
	},

	isSoundSaved: ({ soundId }) => {
		const { savedSounds } = get();
		return savedSounds.some((sound) => sound.id === soundId);
	},

	toggleSavedSound: async ({ soundEffect }) => {
		const { isSoundSaved, saveSoundEffect, removeSavedSound } = get();

		if (isSoundSaved({ soundId: soundEffect.id })) {
			await removeSavedSound({ soundId: soundEffect.id });
		} else {
			await saveSoundEffect({ soundEffect });
		}
	},

	clearSavedSounds: async () => {
		try {
			await storageService.clearSavedSounds();
			set({
				savedSounds: [],
				savedSoundsError: null,
			});
		} catch (error) {
			const errorMessage =
				error instanceof Error
					? error.message
					: t("assets.clearSoundsFailed");
			set({ savedSoundsError: errorMessage });
			toast.error(t("assets.clearSoundsFailed"));
			console.error("Failed to clear saved sounds:", error);
		}
	},

	addSoundToTimeline: async ({ sound }) => {
		const audioUrl = sound.previewUrl;
		if (!audioUrl) {
			toast.error(t("assets.soundFileUnavailable"));
			return false;
		}

		try {
			const editor = EditorCore.getInstance();
			const currentTime = editor.playback.getCurrentTime();

			const response = await fetch(audioUrl);
			if (!response.ok)
				throw new Error(`Failed to download audio: ${response.statusText}`);

			const arrayBuffer = await response.arrayBuffer();
			const audioContext = new AudioContext();
			const buffer = await audioContext.decodeAudioData(arrayBuffer);

			const element = buildLibraryAudioElement({
				sourceUrl: audioUrl,
				name: sound.name,
				duration: mediaTimeFromSeconds({ seconds: sound.duration }),
				startTime: currentTime,
				buffer,
			});

			editor.timeline.insertElement({
				placement: { mode: "auto", trackType: "audio" },
				element,
			});
			return true;
		} catch (error) {
			console.error("Failed to add sound to timeline:", error);
			console.error(
				"[debug] ctor:",
				error?.constructor?.name,
				"type:",
				(error as Event)?.type,
				"message:",
				(error as Error)?.message,
				"stack:",
				(error as Error)?.stack,
			);
			toast.error(
				error instanceof Error ? error.message : t("assets.addSoundFailed"),
				{ id: `sound-${sound.id}` },
			);
			return false;
		}
	},
}));
