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
    extraPrompt: document.querySelector("#extraPrompt").value,
  };
}

function fill(settings) {
  for (const id of fields) {
    if (settings[id] != null) document.querySelector(`#${id}`).value = settings[id];
  }
  document.querySelector("#translationBelow").checked = settings.translationBelow !== false;
}

chrome.storage.local.get("muyi-settings").then((stored) => {
  fill(stored["muyi-settings"] || { translationBelow: true, displayMode: "bilingual", targetLang: "zh-Hans", sourceLang: "auto" });
});

document.querySelector("#save").addEventListener("click", async () => {
  const status = document.querySelector("#status");
  const settings = readForm();
  if (!settings.apiBase || !settings.apiKey || !settings.model) {
    status.textContent = "Base URL、API Key 和模型都要填。";
    return;
  }
  try {
    new URL(settings.apiBase);
  } catch {
    status.textContent = "Base URL 不是合法地址。";
    return;
  }
  await chrome.storage.local.set({ "muyi-settings": settings });
  status.textContent = "已保存。用 Safari 打开一个有字幕的视频就会开始翻译。";
});
