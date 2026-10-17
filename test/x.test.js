const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

function loadX(post) {
  let contextmenu;
  let runtimeListener;
  let messageListener;
  const card = { isConnected: true, querySelectorAll: () => [time] };
  const time = { closest: selector => selector.startsWith("article") ? card : { href: "https://x.com/author/status/123" } };
  class Element { closest() { return card; } }
  const window = {
    addEventListener(type, callback) { messageListener = callback; },
    removeEventListener() { messageListener = null; },
    postMessage(message) { messageListener({ source: window, origin: "https://x.com",
      data: { type: "BID_X_RESPONSE", requestId: message.requestId, post } }); }
  };
  const context = vm.createContext({ URL, Element, window, setTimeout, clearTimeout,
    crypto: { randomUUID: () => "request" }, location: { href: "https://x.com/home", origin: "https://x.com" },
    document: { addEventListener(type, callback) { contextmenu = callback; } },
    chrome: { runtime: { onMessage: { addListener(callback) { runtimeListener = callback; } } } }
  });
  for (const file of ["x-lib.js", "x.js"]) vm.runInContext(fs.readFileSync(path.join(__dirname, "..", file), "utf8"), context);
  contextmenu({ target: new Element() });
  return type => new Promise(resolve => runtimeListener({ type }, {}, resolve));
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

test("X 未捕获帖子或返回其他帖子时拒绝下载并提示刷新", async () => {
  for (const post of [null, { postId: "456" }]) {
    const result = await loadX(post)("RESOLVE_MEDIA");
    assert.equal(result.ok, false);
    assert.match(result.error, /刷新页面/);
  }
});
