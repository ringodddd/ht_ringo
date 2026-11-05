export type DisplayMode = "bilingual" | "translation" | "original";

export type Settings = {
  apiBase: string;
  apiKey: string;
  model: string;
  targetLang: string;
  displayMode: DisplayMode;
  translationBelow: boolean;
  fontScale: number;
  extraPrompt: string;
  useServerKey: boolean;
  appToken: string;
};

export type Track = {
  language: string;
  name: string;
  auto: boolean;
};

export type Cue = {
  i: number;
  start: number;
  end: number;
  text: string;
  translation?: string;
};

export type Session = {
  videoId: string;
  title: string;
  author: string;
  duration: number;
  track: Track | null;
  available: Track[];
  cues: Cue[];
  source: string;
};

export type ServerConfig = {
  mock: boolean;
  hasServerKey: boolean;
  serverModel: string;
  serverBaseHost: string;
  hasCookies: boolean;
  appTokenRequired: boolean;
};

export const LANGUAGES: { id: string; label: string }[] = [
  { id: "zh-Hans", label: "简体中文" },
  { id: "zh-Hant", label: "繁体中文" },
  { id: "en", label: "英语" },
  { id: "ja", label: "日语" },
  { id: "ko", label: "韩语" },
  { id: "es", label: "西班牙语" },
  { id: "fr", label: "法语" },
  { id: "de", label: "德语" },
  { id: "ru", label: "俄语" },
  { id: "pt", label: "葡萄牙语" },
  { id: "vi", label: "越南语" },
  { id: "th", label: "泰语" },
  { id: "id", label: "印尼语" },
  { id: "ar", label: "阿拉伯语" },
];
