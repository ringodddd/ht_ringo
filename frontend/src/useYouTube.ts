import { useEffect, useRef, useState } from "react";

let apiPromise: Promise<void> | null = null;

function loadYouTubeApi(): Promise<void> {
  if (window.YT?.Player) return Promise.resolve();
  if (apiPromise) return apiPromise;
  apiPromise = new Promise((resolve, reject) => {
    const previous = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      previous?.();
      resolve();
    };
    const script = document.createElement("script");
    script.src = "https://www.youtube.com/iframe_api";
    script.onerror = () => reject(new Error("iframe_api"));
    document.head.appendChild(script);
  });
  return apiPromise;
}

export function useYouTube(videoId: string) {
  const hostRef = useRef<HTMLDivElement>(null);
  const playerRef = useRef<YTPlayer | null>(null);
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);
  const [time, setTime] = useState(0);
  const [playing, setPlaying] = useState(false);

  useEffect(() => {
    if (!videoId) {
      setReady(false);
      setFailed(false);
      setTime(0);
      setPlaying(false);
      return;
    }
    const host = hostRef.current;
    if (!host) return;
    let cancelled = false;
    let poll = 0;
    let failTimer = 0;
    setReady(false);
    setFailed(false);
    setTime(0);
    setPlaying(false);

    const mount = () => {
      if (cancelled || !hostRef.current || !window.YT?.Player) return;
      hostRef.current.replaceChildren();
      const slot = document.createElement("div");
      hostRef.current.appendChild(slot);
      playerRef.current = new window.YT.Player(slot, {
        videoId,
        width: "100%",
        height: "100%",
        host: "https://www.youtube-nocookie.com",
        playerVars: {
          rel: 0,
          modestbranding: 1,
          cc_load_policy: 0,
          iv_load_policy: 3,
          playsinline: 1,
          origin: window.location.origin,
        },
        events: {
          onReady: (event: { target: YTPlayer }) => {
            if (cancelled) return;
            setReady(true);
            setFailed(false);
            event.target.playVideo();
          },
          onError: () => {
            if (!cancelled) setFailed(true);
          },
          onStateChange: (event: { data: number }) => {
            if (cancelled || !window.YT) return;
            setPlaying(event.data === window.YT.PlayerState.PLAYING);
          },
        },
      });
    };

    loadYouTubeApi().then(mount).catch(() => {
      if (!cancelled) setFailed(true);
    });
    failTimer = window.setTimeout(() => {
      if (cancelled) return;
      try {
        const current = playerRef.current?.getCurrentTime?.();
        if (typeof current !== "number") setFailed(true);
      } catch {
        setFailed(true);
      }
    }, 9000);
    poll = window.setInterval(() => {
      try {
        const current = playerRef.current?.getCurrentTime?.();
        if (typeof current === "number" && !Number.isNaN(current)) setTime(current);
      } catch {
        /* 播放器还没准备好 */
      }
    }, 100);

    return () => {
      cancelled = true;
      window.clearInterval(poll);
      window.clearTimeout(failTimer);
      try {
        playerRef.current?.destroy();
      } catch {
        /* 播放器可能还没建好 */
      }
      playerRef.current = null;
    };
  }, [videoId]);

  const seekTo = (seconds: number) => {
    playerRef.current?.seekTo(Math.max(0, seconds), true);
    setTime(Math.max(0, seconds));
  };

  const toggle = () => {
    const player = playerRef.current;
    if (!player || !window.YT) return;
    if (player.getPlayerState() === window.YT.PlayerState.PLAYING) player.pauseVideo();
    else player.playVideo();
  };

  return { hostRef, ready, failed, time, playing, seekTo, toggle };
}
