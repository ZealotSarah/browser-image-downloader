/* Load the real unpacked extension, open a real post, and drive the real
   context-menu message path through the background service worker.
   `--fake-api` intercepts one X graphql response so the main-world capture
   bridge can be verified end to end. */
import { spawn } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";

const ROOT = "E:/browser-image-downloader";
const PROFILE = `${ROOT}/tools/.live/profile`;
const PORT = 9341;
const POST = process.argv[2]?.startsWith("http") ? process.argv[2] : "https://x.com/a_se_ase/status/2123043074771214373";
const FAKE_API = process.argv.includes("--fake-api");

rmSync(`${ROOT}/tools/.live`, { recursive: true, force: true });
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
const send = (method, params = {}, sessionId) => new Promise(res => {
  const mid = ++id; pending.set(mid, res);
  ws.send(JSON.stringify({ id: mid, method, params, sessionId }));
});
ws.addEventListener("message", e => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result ?? { error: m.error }); pending.delete(m.id); return; }
  if (m.method === "Runtime.exceptionThrown") {
    const d = m.params.exceptionDetails;
    exceptions.push(`${d.exception?.description || d.text} @ ${(d.url || "").split("/").pop()}:${d.lineNumber}`);
  }
  if (m.method === "Fetch.requestPaused") {
    send("Fetch.fulfillRequest", {
      requestId: m.params.requestId, responseCode: 200,
      responseHeaders: [{ name: "content-type", value: "application/json" }],
      body: Buffer.from(JSON.stringify(fakeTweetResponse())).toString("base64")
    }, m.sessionId);
  }
});
const sleep = ms => new Promise(r => setTimeout(r, ms));

function fakeTweetResponse() {
  const postId = "2123043074771214373";
  return { data: { tweetResult: { result: {
    __typename: "Tweet", rest_id: postId,
    core: { user_results: { result: { __typename: "User", rest_id: "9001",
      core: { screen_name: "a_se_ase" }, legacy: { screen_name: "a_se_ase" } } } },
    legacy: { id_str: postId, user_id_str: "9001", full_text: "中秋快乐",
      extended_entities: { media: [
        { id_str: "1", type: "photo", media_url_https: "https://pbs.twimg.com/media/HXaQahnWMAE9KUY?format=jpg&name=small" },
        { id_str: "2", type: "video", media_url_https: "https://pbs.twimg.com/amplify_video_thumb/1/img/x.jpg",
          video_info: { variants: [
            { url: "https://video.twimg.com/ext_tw_video/1/pu/vid/480x270/a.mp4", content_type: "video/mp4", bitrate: 320000 },
            { url: "https://video.twimg.com/ext_tw_video/1/pu/vid/1280x720/b.mp4", content_type: "video/mp4", bitrate: 2176000 },
            { url: "https://video.twimg.com/ext_tw_video/1/pu/pl/a.m3u8", content_type: "application/x-mpegURL" }
          ] } }
      ] } }
  } } } };
}

const loaded = await send("Extensions.loadUnpacked", { path: ROOT.replace(/\//g, "\\") });
const extId = loaded.id;
console.log("EXT", extId, FAKE_API ? "(fake api)" : "");

const { targetId } = await send("Target.createTarget", { url: POST });
const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
await send("Runtime.enable", {}, sessionId);
await send("Page.enable", {}, sessionId);
for (let i = 0; i < 60; i++) {
  const r = await send("Runtime.evaluate", {
    expression: `document.readyState === "complete" && document.querySelectorAll('article').length > 0`,
    returnByValue: true }, sessionId);
  if (r.result?.value) break;
  await sleep(500);
}
await sleep(2500);

const page = await send("Runtime.evaluate", {
  expression: `JSON.stringify({ href: location.href, articles: document.querySelectorAll('article').length })`,
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

if (FAKE_API) {
  await send("Fetch.enable", { patterns: [{ urlPattern: "*i/api/graphql*" }] }, sessionId);
  const fired = await send("Runtime.evaluate", {
    expression: `fetch("/i/api/graphql/hash/TweetDetail", { headers: { accept: "application/json" } })
      .then(r => r.json()).then(j => "ok " + JSON.stringify(j).length).catch(e => "err " + e.message)`,
    returnByValue: true, awaitPromise: true }, sessionId);
  console.log("FAKE-FETCH", fired.result?.value);
  await sleep(600);
}

await send("Runtime.evaluate", {
  expression: `(() => {
    const card = document.querySelector('article[data-testid="tweet"]') || document.querySelector('article');
    const node = card.querySelector('[data-testid="tweetText"]') || card;
    const r = node.getBoundingClientRect();
    const x = Math.round(r.left + r.width / 2), y = Math.round(r.top + r.height / 2);
    node.dispatchEvent(new MouseEvent("pointermove", { bubbles: true, clientX: x, clientY: y }));
    node.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: x, clientY: y }));
    return "right-clicked";
  })()`, returnByValue: true }, sessionId);

const result = await send("Runtime.evaluate", {
  expression: `chrome.tabs.query({}).then(tabs => {
    const tab = tabs.find(t => t.url && t.url.includes("/status/")) || tabs[0];
    return chrome.tabs.sendMessage(tab.id, { type: "RESOLVE_MEDIA" })
      .then(r => JSON.stringify(r)).catch(e => "SEND-MESSAGE ERR " + e.message);
  })`, returnByValue: true, awaitPromise: true }, sw.sessionId);
console.log("RESOLVE", result.result?.value);

console.log("EXCEPTIONS", exceptions.length ? "" : "(none)");
for (const x of exceptions.slice(0, 10)) console.log("  ", x);

chrome.kill();
ws.close();
process.exit(0);
