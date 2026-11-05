importScripts("llm.js");

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || message.type !== "translate-batch") return undefined;
  globalThis.MuyiLlm.translateBatch(message.payload)
    .then((translations) => sendResponse({ translations }))
    .catch((error) => sendResponse({ error: error.message || String(error) }));
  return true;
});
