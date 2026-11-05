import type { ServerConfig, Session, Settings } from "./types";

function headers(settings: Settings): HeadersInit {
  const value: Record<string, string> = { "Content-Type": "application/json" };
  if (settings.appToken.trim()) value.Authorization = `Bearer ${settings.appToken.trim()}`;
  return value;
}

async function readError(response: Response): Promise<string> {
  try {
    const body = await response.json();
    return body.detail || `请求失败（HTTP ${response.status}）`;
  } catch {
    return `请求失败（HTTP ${response.status}）`;
  }
}

export async function fetchConfig(): Promise<ServerConfig> {
  const response = await fetch("/api/config");
  if (!response.ok) throw new Error(await readError(response));
  return response.json();
}

export async function fetchCaptions(url: string, lang: string, settings: Settings): Promise<Session> {
  const response = await fetch("/api/captions", {
    method: "POST",
    headers: headers(settings),
    body: JSON.stringify({ url, lang }),
  });
  if (!response.ok) throw new Error(await readError(response));
  return response.json();
}

export async function importCaptions(
  url: string,
  filename: string,
  content: string,
  settings: Settings,
): Promise<Session> {
  const response = await fetch("/api/import", {
    method: "POST",
    headers: headers(settings),
    body: JSON.stringify({ url, filename, content }),
  });
  if (!response.ok) throw new Error(await readError(response));
  return response.json();
}

export async function uploadCookies(content: string, settings: Settings): Promise<void> {
  const response = await fetch("/api/cookies", {
    method: "POST",
    headers: headers(settings),
    body: JSON.stringify({ content }),
  });
  if (!response.ok) throw new Error(await readError(response));
}

export async function deleteCookies(settings: Settings): Promise<void> {
  const response = await fetch("/api/cookies", { method: "DELETE", headers: headers(settings) });
  if (!response.ok) throw new Error(await readError(response));
}

export type TranslateEvent =
  | { event: "meta"; data: { total: number; cached: number } }
  | { event: "progress"; data: { done: number; total: number } }
  | { event: "cue"; data: { i: number; translation: string } }
  | { event: "done"; data: { translated: number; cached: number } }
  | { event: "error"; data: { message: string } };

export async function streamTranslate(
  session: Session,
  settings: Settings,
  onEvent: (event: TranslateEvent) => void,
  signal: AbortSignal,
): Promise<void> {
  const useOwn = !settings.useServerKey;
  const response = await fetch("/api/translate", {
    method: "POST",
    headers: headers(settings),
    signal,
    body: JSON.stringify({
      targetLang: settings.targetLang,
      sourceLang: session.track?.language || "",
      cues: session.cues.map((cue) => ({ i: cue.i, text: cue.text })),
      baseUrl: useOwn ? settings.apiBase : "",
      apiKey: useOwn ? settings.apiKey : "",
      model: useOwn ? settings.model : "",
      extraPrompt: settings.extraPrompt,
    }),
  });
  if (!response.ok || !response.body) throw new Error(await readError(response));

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const chunks = buffer.split("\n\n");
    buffer = chunks.pop() || "";
    for (const chunk of chunks) {
      if (!chunk.trim()) continue;
      const lines = chunk.split("\n");
      const eventLine = lines.find((line) => line.startsWith("event:"));
      const data = lines
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim())
        .join("\n");
      if (!data) continue;
      const event = (eventLine ? eventLine.slice(6).trim() : "message") as TranslateEvent["event"];
      onEvent({ event, data: JSON.parse(data) } as TranslateEvent);
    }
  }
}
