/*
 * Real-browser check for the X post locator.
 * Serves a faithful X-like page over https://x.com:<port> (host mapped to
 * 127.0.0.1), loads the real x-lib.js / x-capture.js / x.js, then dispatches
 * genuine contextmenu / pointermove events through CDP.
 *
 *   node tools/x-browser-check.mjs
 */
import { spawn, execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { createServer } from "node:https";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TMP = join(ROOT, "tools", ".tmp");
const PORT = 8443;
const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const DEBUG_PORT = 9333;

const POSTS = {
  "1111111111111111111": { author: "a_se_ase", photos: ["AAA"], video: true },
  "2222222222222222222": { author: "photos_only", photos: ["BBB", "CCC"] },
  // Present in the page DOM but never returned by the API response.
  "3333333333333333333": { author: "page_only", photos: ["DDD"] }
};

function tweetResult(id, config) {
  const media = config.photos.map((name, index) => ({
    type: "photo", id_str: String(index + 1),
    media_url_https: `https://pbs.twimg.com/media/${name}.jpg`
  }));
  if (config.video) media.push({
    type: "video", id_str: "9", media_url_https: "https://pbs.twimg.com/media/AAA.jpg",
    video_info: { variants: [
      { content_type: "video/mp4", url: "https://video.twimg.com/ext_tw_video/1/pu/vid/640x360/low.mp4", bitrate: 832000 },
      { content_type: "video/mp4", url: "https://video.twimg.com/ext_tw_video/1/pu/vid/1280x720/high.mp4", bitrate: 2176000 }
    ] }
  });
  return { data: { tweetResult: { result: {
    __typename: "Tweet", rest_id: id,
    core: { user_results: { result: { __typename: "User", rest_id: "42",
      core: { screen_name: config.author }, legacy: { screen_name: config.author } } } },
    legacy: { id_str: id, extended_entities: { media } }
  } } } };
}

const API_BODY = JSON.stringify({ data: { thread: Object.entries(POSTS)
  .filter(([id]) => id !== "3333333333333333333")
  .map(([id, config]) => tweetResult(id, config)) } });

function page(id) {
  const config = POSTS[id];
  const photos = config.photos.map((name, index) =>
    `<a href="/${config.author}/status/${id}/photo/${index + 1}" class="photo"><img src="https://pbs.twimg.com/media/${name}.jpg?format=jpg&name=small"></a>`).join("");
  return `<article data-testid="tweet" data-post="${id}">
    <div data-testid="User-Name"><a href="/${config.author}"><span>${config.author}</span></a></div>
    ${id === "2222222222222222222" ? "" : `<a href="/${config.author}/status/${id}"><time datetime="2026-11-20T06:00:00.000Z">2h</time></a>`}
    <div data-testid="tweetPhoto">${photos}</div>
    ${config.video ? `<div data-testid="videoPlayer"><video></video></div>` : ""}
  </article>`;
}

const HTML = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>x</title>
<style>body{margin:0;font:16px sans-serif}article{display:block;width:520px;margin:12px;border:1px solid #ccc}
img{width:180px;height:120px;display:block}#blank{height:220px;background:#eee}</style></head>
<body>
<div id="feed">${Object.keys(POSTS).map(page).join("")}</div>
<div id="blank">空白区域</div>
<div id="grid"><a href="/a_se_ase/status/1111111111111111111/photo/1"><img id="grid-img" src="https://pbs.twimg.com/media/AAA.jpg?format=jpg&name=small"></a></div>
<script src="/video-lib.js"></script>
<script>
  window.__listeners = [];
  window.chrome = { runtime: { onMessage: { addListener(fn) { window.__listeners.push(fn); } } } };
  window.__fire = (selector, type = "contextmenu") => {
    const node = document.querySelector(selector);
    if (!node) throw new Error("missing " + selector);
    const rect = node.getBoundingClientRect();
    const x = Math.round(rect.left + rect.width / 2);
    const y = Math.round(rect.top + rect.height / 2);
    node.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y }));
    return { x, y };
  };
  window.__resolve = () => new Promise(res => window.__listeners[0]({ type: "RESOLVE_MEDIA" }, {}, res));
  window.__ready = false;
</script>
<script src="/x-lib.js"></script>
<script src="/x-capture.js"></script>
<script src="/x.js"></script>
<script>
  // Runs after the observers are installed, like X's own timeline request.
  fetch("/i/api/graphql/hash/TweetDetail", { headers: { accept: "application/json" } })
    .then(response => response.json())
    .then(() => { window.__ready = true; })
    .catch(error => { window.__fetchError = String(error); });
</script></body></html>`;

function ensureCert() {
  mkdirSync(TMP, { recursive: true });
  const key = join(TMP, "key.pem");
  const cert = join(TMP, "cert.pem");
  if (!existsSync(key) || !existsSync(cert)) {
    execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "2",
      "-keyout", key, "-out", cert, "-subj", "/CN=x.com",
      "-addext", "subjectAltName=DNS:x.com,DNS:www.x.com"], { stdio: "ignore" });
  }
  return { key: readFileSync(key), cert: readFileSync(cert) };
}

function serve() {
  const types = { ".js": "text/javascript; charset=utf-8", ".html": "text/html; charset=utf-8" };
  const server = createServer(ensureCert(), (request, response) => {
    const path = new URL(request.url, "https://x.com").pathname;
    if (path === "/") return response.writeHead(200, { "content-type": types[".html"] }).end(HTML);
    if (path.startsWith("/i/api/graphql/")) {
      return response.writeHead(200, { "content-type": "application/json" }).end(API_BODY);
    }
    const file = join(ROOT, path);
    if (!file.startsWith(ROOT) || !existsSync(file)) return response.writeHead(404).end("no");
    return response.writeHead(200, { "content-type": types["." + path.split(".").pop()] || "text/plain" })
      .end(readFileSync(file));
  });
  return new Promise(done => server.listen(PORT, "127.0.0.1", () => done(server)));
}

function connect(url) {
  return new Promise((done, fail) => {
    const socket = new WebSocket(url);
    const pending = new Map();
    let counter = 0;
    socket.addEventListener("message", event => {
      const message = JSON.parse(event.data);
      if (message.id && pending.has(message.id)) {
        const job = pending.get(message.id);
        pending.delete(message.id);
        if (message.error) job.fail(new Error(message.error.message));
        else job.done(message.result);
      }
    });
    socket.addEventListener("open", () => done({
      send(method, params = {}, sessionId) {
        return new Promise((res, rej) => {
          const id = ++counter;
          pending.set(id, { done: res, fail: rej });
          socket.send(JSON.stringify({ id, method, params, sessionId }));
        });
      },
      close() { socket.close(); }
    }));
    socket.addEventListener("error", () => fail(new Error("CDP 连接失败")));
  });
}

async function waitFor(check, label) {
  for (let i = 0; i < 100; i++) {
    if (await check()) return;
    await new Promise(done => setTimeout(done, 100));
  }
  throw new Error(`等待超时：${label}`);
}

const results = [];
function check(name, condition, detail) {
  results.push({ name, ok: Boolean(condition), detail });
  console.log(`${condition ? "ok  " : "FAIL"} ${name}${condition ? "" : ` -> ${JSON.stringify(detail)}`}`);
}

const server = await serve();
const profile = join(TMP, "profile");
const chrome = spawn(CHROME, [
  "--headless=new", `--remote-debugging-port=${DEBUG_PORT}`, `--user-data-dir=${profile}`,
  "--host-resolver-rules=MAP x.com 127.0.0.1", "--no-proxy-server", "--ignore-certificate-errors",
  "--no-first-run", "--no-default-browser-check", "--disable-gpu", "about:blank"
], { stdio: "ignore" });

try {
  let version = null;
  await waitFor(async () => {
    try {
      version = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`)).json();
      return true;
    } catch { return false; }
  }, "启动 Chrome");
  const browser = await connect(version.webSocketDebuggerUrl);
  const { targetId } = await browser.send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await browser.send("Target.attachToTarget", { targetId, flatten: true });
  const evaluate = async expression => {
    const { result, exceptionDetails } = await browser.send("Runtime.evaluate",
      { expression, awaitPromise: true, returnByValue: true }, sessionId);
    if (exceptionDetails) throw new Error(exceptionDetails.exception?.description || exceptionDetails.text);
    return result.value;
  };

  await browser.send("Page.enable", {}, sessionId);
  await browser.send("Page.navigate", { url: `https://x.com:${PORT}/` }, sessionId);
  await waitFor(async () => {
    try { return await evaluate("document.readyState === 'complete' && window.__ready === true"); }
    catch { return false; }
  }, "页面与接口响应");
  check("页面通过 x-capture 观察接口响应", await evaluate("typeof window.__fetchError === 'undefined'"), await evaluate("window.__fetchError"));

  const resolveAfter = async fire => {
    await evaluate(fire);
    return evaluate("window.__resolve()");
  };

  const feed = await resolveAfter(`window.__fire('article[data-post="1111111111111111111"] img')`);
  check("信息流右键：定位帖子并取得图片+视频", feed?.ok && feed.data.postId === "1111111111111111111" &&
    feed.data.videos.length === 1 && /1280x720/.test(feed.data.videos[0].url), feed);

  const gallery = await resolveAfter(`window.__fire('article[data-post="2222222222222222222"] img')`);
  check("无时间链接的媒体卡片仍定位准确", gallery?.ok && gallery.data.postId === "2222222222222222222" &&
    gallery.data.pictures.length === 2, gallery);

  const grid = await resolveAfter(`window.__fire('#grid-img')`, "grid");
  check("独立图片层（无帖子卡片）按链接定位", grid?.ok && grid.data.postId === "1111111111111111111", grid);

  const blank = await resolveAfter(`window.__fire("#blank")`);
  check("空白处右键给出可操作提示", blank?.ok === false && /未找到右键所在的 X 帖子/.test(blank.error), blank);

  const hover = await resolveAfter(`window.__fire('article[data-post="1111111111111111111"] video', "pointermove")`);
  check("仅指针停留（播放器在 iframe 内）也能定位", hover?.ok && hover.data.postId === "1111111111111111111", hover);

  const pageOnly = await resolveAfter(`window.__fire('article[data-post="3333333333333333333"] img')`);
  check("接口未返回该帖时改用页面图片兜底", pageOnly?.ok && pageOnly.data.postId === "3333333333333333333" &&
    pageOnly.data.pictures.length === 1 && /name=orig/.test(pageOnly.data.pictures[0].url), pageOnly);

  const rerender = await resolveAfter(`(() => {
    window.__fire('article[data-post="1111111111111111111"] img');
    document.querySelector('article[data-post="1111111111111111111"]').remove();
    return 1;
  })()`);
  check("卡片被移除（页面重渲染）后仍能定位", rerender?.ok && rerender.data.postId === "1111111111111111111", rerender);

  browser.close();
} finally {
  chrome.kill();
  server.close();
}

const failed = results.filter(item => !item.ok);
console.log(`\n${results.length - failed.length}/${results.length} 项通过`);
process.exit(failed.length ? 1 : 0);
