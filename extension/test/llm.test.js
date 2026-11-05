const fs = require("fs");
const path = require("path");
const vm = require("vm");

const context = { console, globalThis: {} };
context.globalThis = context;
vm.createContext(context);
vm.runInContext(fs.readFileSync(path.join(__dirname, "../src/llm.js"), "utf8"), context);
const { chatUrl, parseTranslations } = context.MuyiLlm;

if (chatUrl("https://api.deepseek.com/v1") !== "https://api.deepseek.com/v1/chat/completions") {
  throw new Error("base url");
}
if (chatUrl("https://example.com/v1/chat/completions/") !== "https://example.com/v1/chat/completions") {
  throw new Error("full url");
}
const parsed = parseTranslations('```json\n{"translations":["甲","乙"]}\n```', 2);
if (!parsed || parsed.join("|") !== "甲|乙") throw new Error("fence");
if (parseTranslations('{"translations":["只有一行"]}', 2) !== null) throw new Error("length");
console.log("extension llm tests ok");
