import type { Cue } from "./types";

export function formatTime(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const secs = whole % 60;
  if (hours > 0) return `${hours}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
  return `${minutes}:${String(secs).padStart(2, "0")}`;
}

function srtStamp(seconds: number): string {
  const millis = Math.max(0, Math.round(seconds * 1000));
  const hours = Math.floor(millis / 3_600_000);
  const minutes = Math.floor((millis % 3_600_000) / 60_000);
  const secs = Math.floor((millis % 60_000) / 1000);
  const ms = millis % 1000;
  const pad = (value: number, size = 2) => String(value).padStart(size, "0");
  return `${pad(hours)}:${pad(minutes)}:${pad(secs)},${pad(ms, 3)}`;
}

export function toSrt(cues: Cue[], bilingual: boolean): string {
  const blocks: string[] = [];
  let number = 1;
  for (const cue of cues) {
    const original = cue.text.trim();
    const translation = (cue.translation || "").trim();
    const line = bilingual
      ? [original, translation].filter(Boolean).join("\n")
      : translation || original;
    if (!line) continue;
    blocks.push(`${number}\n${srtStamp(cue.start)} --> ${srtStamp(cue.end)}\n${line}\n`);
    number += 1;
  }
  return blocks.join("\n");
}

export function downloadText(filename: string, text: string) {
  const blob = new Blob([text], { type: "application/x-subrip;charset=utf-8" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = filename;
  link.click();
  URL.revokeObjectURL(link.href);
}

export function activeCueIndex(cues: Cue[], time: number): number {
  let lo = 0;
  let hi = cues.length - 1;
  let answer = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (cues[mid].start <= time + 0.05) {
      answer = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  if (answer < 0) return -1;
  if (time <= cues[answer].end + 0.25) return answer;
  return -1;
}

export const DEMO_CUES: Cue[] = [
  { i: 0, start: 0.4, end: 3.4, text: "This is a demo timeline, not the words in the picture." },
  { i: 1, start: 3.4, end: 7.2, text: "Paste a YouTube link and read its captions on your own machine." },
  { i: 2, start: 7.2, end: 11.2, text: "Translation goes through the API token you already pay for." },
  { i: 3, start: 11.2, end: 15.0, text: "Bilingual lines stay pinned to the bottom of the frame." },
  { i: 4, start: 15.0, end: 18.6, text: "If YouTube blocks the server, use the browser extension or import an SRT." },
];
