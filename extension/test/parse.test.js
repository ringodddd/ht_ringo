const fs = require("fs");
const path = require("path");
const vm = require("vm");

const context = { console, globalThis: {} };
context.globalThis = context;
vm.createContext(context);
vm.runInContext(fs.readFileSync(path.join(__dirname, "../src/parse.js"), "utf8"), context);
const { parseJson3, parseVtt, parseSrt, chooseTrack, activeCueIndex } = context.MuyiParse;

const fixtures = path.join(__dirname, "../../backend/tests/fixtures");
const json3 = parseJson3(fs.readFileSync(path.join(fixtures, "sample.json3"), "utf8"));
assert(json3.map((cue) => cue.text).join("|") === "Hello there.|General Kenobi.|A surprise.", json3);
assert(json3[1].end === 7.6, json3[1]);
assert(json3[2].end === 9.6, json3[2]);

const vtt = parseVtt(fs.readFileSync(path.join(fixtures, "rolling.vtt"), "utf8"));
assert(vtt.map((cue) => cue.text).join("|") === "hello there|how are you", vtt);
assert(vtt[1].end === 5.5, vtt[1]);

const srt = parseSrt(fs.readFileSync(path.join(fixtures, "sample.srt"), "utf8"));
assert(srt.map((cue) => cue.text).join("|") === "First line.|Second & last.", srt);

const tracks = [
  { language: "en", auto: true },
  { language: "zh-CN", auto: false },
  { language: "fr", auto: false },
];
assert(chooseTrack(tracks, "auto").language === "zh-CN");
assert(chooseTrack(tracks, "en").auto === true);
assert(chooseTrack(tracks, "ja") === null);
assert(activeCueIndex(srt, 1.2) === 0);
assert(activeCueIndex(srt, 0) === -1);

function assert(condition, detail) {
  if (!condition) {
    console.error(detail);
    throw new Error("parse test failed");
  }
}

console.log("extension parse tests ok");
