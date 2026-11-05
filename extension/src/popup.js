const fields = ["apiBase", "apiKey", "model", "targetLang", "sourceLang", "displayMode", "extraPrompt"];

function readForm() {
  return {
    apiBase: document.querySelector("#apiBase").value.trim(),
    apiKey: document.querySelector("#apiKey").value.trim(),
    model: document.querySelector("#model").value.trim(),
    targetLang: document.querySelector("#targetLang").value,
    sourceLang: document.querySelector("#sourceLang").value,
    displayMode: document.querySelector("#displayMode").value,
    translationBelow: document.querySelector("#translationBelow").checked,
    fontScale: Number(document.querySelector("#fontScale").value),
    extraPrompt: document.querySelector("#extraPrompt").value,
  };
}

function fill(settings) {
  for (const id of fields) {
    if (settings[id] != null) document.querySelector(`#${id}`).value = settings[id];
  }
  document.querySelector("#translationBelow").checked = settings.translationBelow !== false;
  document.querySelector("#fontScale").value = String(settings.fontScale || 1);
  document.querySelector("#scaleOut").textContent = Number(settings.fontScale || 1).toFixed(1);
}

document.querySelector("#fontScale").addEventListener("input", (event) => {
  document.querySelector("#scaleOut").textContent = Number(event.target.value).toFixed(1);
});

chrome.storage.local.get("muyi-settings").then((stored) => fill(stored["muyi-settings"] || { translationBelow: true, fontScale: 1 }));

document.querySelector("#save").addEventListener("click", async () => {
  const status = document.querySelector("#status");
  const settings = readForm();
  if (!settings.apiBase || !settings.apiKey || !settings.model) {
    status.textContent = "Base URL、API Key 和模型都要填。";
    return;
  }
  let origin = "";
  try {
    origin = new URL(settings.apiBase).origin;
  } catch {
    status.textContent = "Base URL 不是合法地址。";
    return;
  }
  const granted = await chrome.permissions.request({ origins: [`${origin}/*`] });
  if (!granted) {
    status.textContent = "没有允许访问这个接口，翻译请求发不出去。";
    return;
  }
  await chrome.storage.local.set({ "muyi-settings": settings });
  status.textContent = "已保存。打开一个有字幕的视频就会开始翻译。";
});
