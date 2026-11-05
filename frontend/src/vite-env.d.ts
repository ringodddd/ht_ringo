/// <reference types="vite/client" />

interface YTPlayer {
  destroy: () => void;
  playVideo: () => void;
  pauseVideo: () => void;
  seekTo: (seconds: number, allowSeekAhead: boolean) => void;
  getCurrentTime: () => number;
  getPlayerState: () => number;
}

interface Window {
  YT?: {
    Player: new (element: HTMLElement, options: unknown) => YTPlayer;
    PlayerState: { PLAYING: number; PAUSED: number };
  };
  onYouTubeIframeAPIReady?: () => void;
}
