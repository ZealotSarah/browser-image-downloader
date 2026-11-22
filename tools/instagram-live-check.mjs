/* Load the real unpacked extension, open a real Instagram post, right-click the
   largest image and drive the real message path through the background worker. */
import { spawn } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";

const ROOT = "E:/browser-image-downloader";
const PROFILE = `${ROOT}/tools/.live-ig/profile`;
const PORT = 9351;
const URL_ = process.argv[2] || "https://www.instagram.com/instagram/";

rmSync(`${ROOT}/tools/.live-ig`, { recursive: true, force: true });
mkdirSync(PROFILE, { recursive: true });

const chrome = spawn("C:/Program Files/Google/Chrome/Application/chrome.exe", [
  "--headless=new", `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`,
  "--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36",
  "--enable-unsafe-extension-debugging", "--no-first-run", "--disable-gpu",
  "--window-size=1400,1400", "about:blank"
], { stdio: "ignore" });

let version = null;
for (let i = 0; i < 120; i++) {
  try { version = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json(); break; } catch { await new Promise(r => setTimeout(r, 100)); }
}
const ws = new WebSocket(version.webSocketDebuggerUrl);
await new Promise(r => ws.addEventListener("open", r));
let id = 0;
const pending = new Map();
const exceptions = [];
ws.addEventListener("message", e => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result ?? { error: m.error }); pending.delete(m.id); return; }
  if (m.method === "Runtime.exceptionThrown") {
    const d = m.params.exceptionDetails;
    exceptions.push(`${d.exception?.description || d.text} @ ${(d.url || "").split("/").pop()}:${d.lineNumber}`);
  }
});
const send = (method, params = {}, sessionId) => new Promise(res => {
  const mid = ++id; pending.set(mid, res);
  ws.send(JSON.stringify({ id: mid, method, params, sessionId }));
});
const sleep = ms => new Promise(r => setTimeout(r, ms));

const loaded = await send("Extensions.loadUnpacked", { path: ROOT.replace(/\//g, "\\") });
const extId = loaded.id;
console.log("EXT", extId);

const { targetId } = await send("Target.createTarget", { url: URL_ });
const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
await send("Runtime.enable", {}, sessionId);
await send("Page.enable", {}, sessionId);
await sleep(9000);

const page = await send("Runtime.evaluate", {
  expression: `JSON.stringify({ href: location.href,
    articles: document.querySelectorAll('article').length,
    postLinks: document.querySelectorAll('a[href*="/p/"]').length,
    imgs: document.querySelectorAll('img').length,
    text: document.body.innerText.slice(0, 160) })`,
  returnByValue: true }, sessionId);
console.log("PAGE", page.result?.value);

let swTarget = null;
for (let i = 0; i < 40 && !swTarget; i++) {
  const t = await send("Target.getTargets");
  swTarget = t.targetInfos?.find(x => x.type === "service_worker" && x.url.includes(extId));
  if (!swTarget) await sleep(250);
}
if (!swTarget) throw new Error(`no service worker for ${extId}`);
const sw = await send("Target.attachToTarget", { targetId: swTarget.targetId, flatten: true });
await send("Runtime.enable", {}, sw.sessionId);

const clicked = await send("Runtime.evaluate", {
  expression: `(() => {
    const images = [...document.querySelectorAll("img")]
      .map(img => ({ img, box: img.getBoundingClientRect() }))
      .filter(entry => entry.box.width > 200 && entry.box.height > 150)
      .sort((a, b) => b.box.width * b.box.height - a.box.width * a.box.height);
    if (!images.length) return "no-large-image";
    const { img, box } = images[0];
    const x = Math.round(box.left + box.width / 2), y = Math.round(box.top + box.height / 2);
    img.dispatchEvent(new MouseEvent("pointermove", { bubbles: true, clientX: x, clientY: y }));
    img.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: x, clientY: y }));
    return JSON.stringify({ src: (img.currentSrc || img.src).slice(0, 90), w: Math.round(box.width), h: Math.round(box.height) });
  })()`, returnByValue: true }, sessionId);
console.log("RIGHT-CLICK", clicked.result?.value);

const result = await send("Runtime.evaluate", {
  expression: `chrome.tabs.query({}).then(tabs => {
    const tab = tabs.find(t => t.url && t.url.includes("instagram.com")) || tabs[0];
    return chrome.tabs.sendMessage(tab.id, { type: "RESOLVE_MEDIA" })
      .then(r => JSON.stringify(r)).catch(e => "SEND-MESSAGE ERR " + e.message);
  })`, returnByValue: true, awaitPromise: true }, sw.sessionId);
const raw = result.result?.value || "";
let summary = raw;
try {
  const parsed = JSON.parse(raw);
  summary = parsed.ok
    ? `ok postId=${parsed.data.postId} author=${parsed.data.author} pictures=${parsed.data.pictures.length} ` +
      `videos=${parsed.data.videos.length} source=${parsed.data.qualitySource} missing=${parsed.data.missing}`
    : `fail ${parsed.error}`;
} catch { /* Keep the raw value when it is not JSON. */ }
console.log("RESOLVE", summary);

console.log("EXCEPTIONS", exceptions.length ? "" : "(none)");
for (const x of exceptions.slice(0, 10)) console.log("  ", x);

chrome.kill();
ws.close();
process.exit(0);
