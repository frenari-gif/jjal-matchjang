"use client";

import { ReactNode, useEffect, useRef } from "react";

const BGM_TRACKS = {
  lobby: "/audio/Cardboard Thunder.mp3",
  game: "/audio/Croatian Rhapsody.mp3"
} as const;
const CLICK_SRC = "/audio/Click Sound.mp3";
const SOUND_STORAGE = "jjal-matchjang:sound-settings";

type BgmTrack = keyof typeof BGM_TRACKS;

type SoundSettings = {
  bgmVolume: number;
  sfxVolume: number;
  muted: boolean;
};

const DEFAULT_SOUND_SETTINGS: SoundSettings = {
  bgmVolume: 40,
  sfxVolume: 70,
  muted: false
};

export function SoundProvider({ children }: { children: ReactNode }) {
  const settingsRef = useRef<SoundSettings>(DEFAULT_SOUND_SETTINGS);
  const bgmRef = useRef<HTMLAudioElement | null>(null);
  const clickRef = useRef<HTMLAudioElement | null>(null);
  const bgmSrcRef = useRef<string>(BGM_TRACKS.lobby);
  const bgmStartedRef = useRef(false);
  const missingBgmRef = useRef(false);
  const missingClickRef = useRef(false);
  const lastClickAtRef = useRef(0);

  useEffect(() => {
    settingsRef.current = loadSoundSettings();
    bgmRef.current = createBgm(BGM_TRACKS.lobby);
    bgmRef.current.loop = true;
    bgmRef.current.preload = "auto";
    clickRef.current = new Audio(CLICK_SRC);
    clickRef.current.preload = "auto";
    applyVolumes();

    function handleSettings(event: Event) {
      const detail = (event as CustomEvent<Partial<SoundSettings>>).detail || {};
      settingsRef.current = normalizeSoundSettings({ ...settingsRef.current, ...detail });
      saveSoundSettings(settingsRef.current);
      applyVolumes();
      void ensureBgmStarted();
    }

    function handleBgmTrack(event: Event) {
      const detail = (event as CustomEvent<{ track?: BgmTrack }>).detail || {};
      const nextSrc = detail.track ? BGM_TRACKS[detail.track] : BGM_TRACKS.lobby;
      switchBgm(nextSrc || BGM_TRACKS.lobby);
    }

    function handleInteraction() {
      void ensureBgmStarted();
    }

    function handleClick(event: MouseEvent) {
      const target = event.target instanceof Element ? event.target : null;
      if (!target?.closest("button, a, [data-click-sound]")) return;
      void ensureBgmStarted();
      playClickSound();
    }

    window.addEventListener("jjal-sound-settings", handleSettings as EventListener);
    window.addEventListener("jjal-bgm-track", handleBgmTrack as EventListener);
    window.addEventListener("jjal-play-click", playClickSound);
    window.addEventListener("pointerdown", handleInteraction, { once: true });
    window.addEventListener("keydown", handleInteraction, { once: true });
    document.addEventListener("click", handleClick, true);

    return () => {
      window.removeEventListener("jjal-sound-settings", handleSettings as EventListener);
      window.removeEventListener("jjal-bgm-track", handleBgmTrack as EventListener);
      window.removeEventListener("jjal-play-click", playClickSound);
      document.removeEventListener("click", handleClick, true);
      bgmRef.current?.pause();
      bgmRef.current = null;
      clickRef.current = null;
    };

    function applyVolumes() {
      const settings = settingsRef.current;
      const bgmVolume = settings.muted ? 0 : settings.bgmVolume / 100;
      const clickVolume = settings.muted ? 0 : settings.sfxVolume / 100;
      if (bgmRef.current) {
        bgmRef.current.volume = bgmVolume;
        bgmRef.current.muted = settings.muted || bgmVolume <= 0;
      }
      if (clickRef.current) {
        clickRef.current.volume = clickVolume;
        clickRef.current.muted = settings.muted || clickVolume <= 0;
      }
      if (settings.muted || settings.bgmVolume <= 0) {
        bgmRef.current?.pause();
      }
    }

    function createBgm(src: string) {
      const audio = new Audio(src);
      audio.loop = true;
      audio.preload = "auto";
      return audio;
    }

    function switchBgm(src: string) {
      if (bgmSrcRef.current === src) {
        void ensureBgmStarted();
        return;
      }

      const shouldResume = bgmStartedRef.current && !settingsRef.current.muted && settingsRef.current.bgmVolume > 0;
      bgmRef.current?.pause();
      bgmRef.current = createBgm(src);
      bgmSrcRef.current = src;
      bgmStartedRef.current = false;
      missingBgmRef.current = false;
      applyVolumes();
      if (shouldResume) void ensureBgmStarted();
    }

    async function ensureBgmStarted() {
      const settings = settingsRef.current;
      const bgm = bgmRef.current;
      if (!bgm || missingBgmRef.current || settings.muted || settings.bgmVolume <= 0) return;
      if (bgmStartedRef.current && !bgm.paused) return;
      try {
        await bgm.play();
        bgmStartedRef.current = true;
      } catch {
        missingBgmRef.current = true;
      }
    }

    function playClickSound() {
      const now = Date.now();
      const settings = settingsRef.current;
      const click = clickRef.current;
      if (!click || missingClickRef.current || settings.muted || settings.sfxVolume <= 0) return;
      if (now - lastClickAtRef.current < 80) return;
      lastClickAtRef.current = now;
      try {
        click.currentTime = 0;
        void click.play().catch(() => {
          missingClickRef.current = true;
        });
      } catch {
        missingClickRef.current = true;
      }
    }
  }, []);

  return <>{children}</>;
}

export function loadSoundSettings(): SoundSettings {
  if (typeof window === "undefined") return DEFAULT_SOUND_SETTINGS;
  try {
    const saved = window.localStorage.getItem(SOUND_STORAGE);
    if (!saved) return DEFAULT_SOUND_SETTINGS;
    return normalizeSoundSettings(JSON.parse(saved));
  } catch {
    return DEFAULT_SOUND_SETTINGS;
  }
}

export function saveSoundSettings(settings: SoundSettings) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(SOUND_STORAGE, JSON.stringify(normalizeSoundSettings(settings)));
}

export function broadcastSoundSettings(settings: SoundSettings) {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent("jjal-sound-settings", {
    detail: normalizeSoundSettings(settings)
  }));
}

export function broadcastBgmTrack(track: BgmTrack) {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent("jjal-bgm-track", {
    detail: { track }
  }));
}

function normalizeSoundSettings(value: Partial<SoundSettings>): SoundSettings {
  return {
    bgmVolume: clampVolume(value.bgmVolume, DEFAULT_SOUND_SETTINGS.bgmVolume),
    sfxVolume: clampVolume(value.sfxVolume, DEFAULT_SOUND_SETTINGS.sfxVolume),
    muted: Boolean(value.muted)
  };
}

function clampVolume(value: unknown, fallback: number) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(100, Math.max(0, Math.round(parsed)));
}
