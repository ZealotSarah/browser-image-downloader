const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

function loadX(post, options = {}) {
  let contextmenu;
  let runtimeListener;
  let messageListener;
  const card = { isConnected: true, querySelectorAll: selector => selector === "time"
    ? options.noTime ? [] : [time] : selector === "a[href]" ? [{ href: "https://x.com/author/status/123" }] : [] };
  const time = { closest: selector => selector.startsWith("article") ? card : { href: "https://x.com/author/status/123" } };
  class Element { isConnected = true; closest(selector) { return selector.startsWith("article") ? options.outsideCard ? null : card
    : options.player ? this : null; } querySelectorAll() { return []; } }
  const window = {
    addEventListener(type, callback) { messageListener = callback; },
    removeEventListener() { messageListener = null; },
    postMessage(message) { messageListener({ source: window, origin: "https://x.com",
      data: { type: "BID_X_RESPONSE", requestId: message.requestId, post } }); }
  };
  const context = vm.createContext({ URL, Element, window, setTimeout, clearTimeout, globalThis: {},
    crypto: { randomUUID: () => "request" }, location: { href: options.pageUrl || "https://x.com/home", origin: "https://x.com" },
    document: { addEventListener(type, callback) { if (type === (options.pointerDown ? "pointerdown" : "contextmenu")) contextmenu = callback; } },
    chrome: { runtime: { onMessage: { addListener(callback) { runtimeListener = callback; } } } }
  });
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "manifest.json"), "utf8"));
  const script = manifest.content_scripts.find(script => script.matches.includes("https://x.com/*") && script.world !== "MAIN");
  for (const file of script.js) vm.runInContext(fs.readFileSync(path.join(__dirname, "..", file), "utf8"), context);
  if (!options.noEvent) contextmenu({ target: new Element(), button: 2 });
  return (type, details = {}) => new Promise(resolve => runtimeListener({ type, ...details }, {}, resolve));
}

test("X 统一入口按精确帖子 ID 同时请求图片视频并汇总缺失", async () => {
  const send = loadX({ postId: "123", author: "author", pictures: [{ url: "photo" }],
    videos: [{ url: "video" }], pictureMissing: 0, videoMissing: 1 });
  const images = await send("RESOLVE_MEDIA");
  assert.equal(images.ok, true);
  assert.equal(images.data.missing, 1);
  assert.equal(images.data.imageMissing, 0);
  assert.equal(images.data.videos.length, 1);
});

test("X 无时间戳卡片通过帖子链接定位", async () => {
  const result = await loadX({ postId: "123", videos: [{ url: "video" }], pictureMissing: 0, videoMissing: 0 },
    { noTime: true })("RESOLVE_MEDIA");
  assert.equal(result.ok, true);
});

test("X 卡片外视频弹层通过当前详情 URL 定位，右键按下也记录目标", async () => {
  for (const pointerDown of [false, true]) {
    const result = await loadX({ postId: "123", videos: [{ url: "video" }], pictureMissing: 0, videoMissing: 0 },
      { outsideCard: true, player: true, pointerDown, pageUrl: "https://x.com/author/status/123/video/1" })("RESOLVE_MEDIA");
    assert.equal(result.ok, true);
  }
});

test("X 信息流外部区域不能借用详情页 ID", async () => {
  const result = await loadX({ postId: "123" },
    { outsideCard: true, pageUrl: "https://x.com/author/status/123" })("RESOLVE_MEDIA");
  assert.equal(result.ok, false);
  assert.match(result.error, /无法定位 X 帖子/);
});

test("X 未捕获帖子或返回其他帖子时拒绝下载并提示刷新", async () => {
  for (const post of [null, { postId: "456" }]) {
    const result = await loadX(post)("RESOLVE_MEDIA");
    assert.equal(result.ok, false);
    assert.match(result.error, /刷新页面/);
  }
});

test("X 原生菜单未触发 DOM 事件时使用 Chrome 提供的详情页地址", async () => {
  const pageUrl = "https://x.com/author/status/123/video/1";
  const send = loadX({ postId: "123", videos: [{ url: "video" }], pictureMissing: 0, videoMissing: 0 },
    { noEvent: true, pageUrl });
  assert.equal((await send("RESOLVE_MEDIA", { pageUrl })).ok, true);
});

test("X 信息流原生菜单可使用帖子链接，但拒绝过时页面信息", async () => {
  const send = loadX({ postId: "123", videos: [{ url: "video" }], pictureMissing: 0, videoMissing: 0 }, { noEvent: true });
  assert.equal((await send("RESOLVE_MEDIA", { pageUrl: "https://x.com/home", linkUrl: "https://x.com/author/status/123/video/1" })).ok, true);
  assert.equal((await send("RESOLVE_MEDIA", { pageUrl: "https://x.com/author/status/123" })).ok, false);
});
