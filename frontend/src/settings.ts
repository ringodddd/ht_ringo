import type { Settings } from "./types";

const KEY = "muyi.settings.v1";

export const defaultSettings: Settings = {
  apiBase: "",
  apiKey: "",
  model: "",
  targetLang: "zh-Hans",
  displayMode: "bilingual",
  translationBelow: true,
  fontScale: 1,
  extraPrompt: "",
  useServerKey: true,
  appToken: "",
};

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...defaultSettings };
    return { ...defaultSettings, ...JSON.parse(raw) };
  } catch {
    return { ...defaultSettings };
  }
}

export function saveSettings(settings: Settings) {
  localStorage.setItem(KEY, JSON.stringify(settings));
}
