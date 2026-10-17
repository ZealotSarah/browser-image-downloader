const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

function loadOffscreen(fetchResponse, graphics = {}) {
  const files = name => fs.readFileSync(path.join(__dirname, "..", name), "utf8");
  let listener;
  const revoked = [];
  const savedBlobs = [];
  class Url extends URL {}
  Url.createObjectURL = blob => { savedBlobs.push(blob); return "blob:chrome-extension://test/image"; };
  Url.revokeObjectURL = url => revoked.push(url);
  const context = vm.createContext({
    URL: Url,
    AbortSignal,
    ...graphics,
    fetch: async () => fetchResponse,
    chrome: { runtime: { onMessage: { addListener(callback) { listener = callback; } } } }
  });
  vm.runInContext(files("lib.js"), context);
  vm.runInContext(files("instagram-lib.js"), context);
  vm.runInContext(files("video-lib.js"), context);
  vm.runInContext(files("x-lib.js"), context);
  vm.runInContext(files("offscreen.js"), context);
  const send = message => new Promise(resolve => listener({ target: "offscreen", ...message }, {}, resolve));
  return { send, revoked, savedBlobs };
}

test("仅将图片响应转为 Blob URL，任务完成后释放", async () => {
  const app = loadOffscreen({
    ok: true, headers: { get: () => "image/jpeg" },
    blob: async () => new Blob(["image"], { type: "image/jpeg" })
  });
  const result = await app.send({ type: "FETCH_IMAGE", token: "1", url: "https://wx1.sinaimg.cn/large/a.jpg" });
  assert.equal(result.ok, true);
  assert.equal(result.blobUrl, "blob:chrome-extension://test/image");
  await app.send({ type: "RELEASE_IMAGE", token: "1" });
  assert.deepEqual(app.revoked, ["blob:chrome-extension://test/image"]);
});

test("拒绝图片站返回的 HTML 错误页", async () => {
  const app = loadOffscreen({ ok: true, headers: { get: () => "text/html" } });
  const result = await app.send({ type: "FETCH_IMAGE", token: "1", url: "https://wx1.sinaimg.cn/large/a.jpg" });
  assert.equal(result.ok, false);
  assert.match(result.error, /非图片/);
});

test("新浪图片跳转到屏蔽占位图时不生成下载文件", async () => {
  const app = loadOffscreen({
    ok: false,
    status: 403,
    url: "https://wx2.sinaimg.cn/images/default_d_h_large.gif#101",
    headers: { get: () => "image/gif" },
    blob: async () => { throw new Error("屏蔽图不应读取为 Blob"); }
  });
  const result = await app.send({
    type: "FETCH_IMAGE", kind: "image", token: "1",
    url: "https://wx2.sinaimg.cn/large/0074cU6vgy1ihkuro7vz4j323u35shdt.jpg"
  });
  assert.equal(result.ok, false);
  assert.equal(result.blocked, true);
});

test("Live Photo 接受 MOV 响应，拒绝错误网页", async () => {
  const url = "https://video.weibo.com/media/play?livephoto=https%3A%2F%2Flivephoto.us.sinaimg.cn%2Fclip.mov";
  const app = loadOffscreen({
    ok: true, headers: { get: () => "application/octet-stream" },
    blob: async () => new Blob(["mov"], { type: "application/octet-stream" })
  });
  assert.equal((await app.send({ type: "FETCH_IMAGE", kind: "live", token: "1", url })).ok, true);
  const bad = loadOffscreen({ ok: true, headers: { get: () => "text/html" } });
  const result = await bad.send({ type: "FETCH_IMAGE", kind: "live", token: "2", url });
  assert.equal(result.ok, false);
  assert.match(result.error, /非视频/);
});

test("Instagram CDN 图片可保存，其他站点地址被拒绝", async () => {
  const app = loadOffscreen({
    ok: true, headers: { get: () => "image/webp" },
    blob: async () => new Blob(["image"], { type: "image/webp" })
  });
  const result = await app.send({ type: "FETCH_IMAGE", site: "instagram", kind: "image", token: "1",
    url: "https://scontent.cdninstagram.com/photo.jpg" });
  assert.equal(result.ok, true);
  assert.equal(result.extension, ".webp");
  const rejected = await app.send({ type: "FETCH_IMAGE", site: "instagram", kind: "image", token: "2",
    url: "https://example.com/photo.jpg" });
  assert.equal(rejected.ok, false);
});

test("同时保留 WebP 原始字节并使用相同源生成全尺寸透明 PNG", async () => {
  const source = new Blob(["original webp bytes"], { type: "image/webp" });
  let reads = 0;
  let closed = false;
  const bitmap = { width: 1440, height: 960, close() { closed = true; } };
  const app = loadOffscreen({ ok: true, headers: { get: () => "image/webp" }, blob: async () => { reads++; return source; } }, {
    createImageBitmap: async blob => { assert.equal(blob, source); return bitmap; },
    OffscreenCanvas: class {
      constructor(width, height) { assert.equal(width, 1440); assert.equal(height, 960); }
      getContext(type) {
        assert.equal(type, "2d");
        return { drawImage(image, x, y) { assert.equal(image, bitmap); assert.equal(x, 0); assert.equal(y, 0); } };
      }
      async convertToBlob(options) { assert.equal(options.type, "image/png"); return new Blob(["png"], { type: "image/png" }); }
    }
  });
  const base = { type: "FETCH_IMAGE", site: "instagram", url: "https://scontent.cdninstagram.com/photo.webp" };
  assert.equal((await app.send({ ...base, kind: "image", token: "original" })).extension, ".webp");
  assert.equal(app.savedBlobs[0], source);
  assert.equal((await app.send({ ...base, kind: "png", token: "png" })).extension, ".png");
  assert.equal(app.savedBlobs[1].type, "image/png");
  assert.equal(reads, 1);
  assert.equal(closed, true);
});

test("PNG 编码失败仍保留 WebP，释放解码位图并单独报告失败", async () => {
  let closed = false;
  const app = loadOffscreen({ ok: true, headers: { get: () => "image/webp" },
    blob: async () => new Blob(["webp"], { type: "image/webp" }) }, {
    createImageBitmap: async () => ({ width: 2, height: 2, close() { closed = true; } }),
    OffscreenCanvas: class {
      getContext() { return { drawImage() {} }; }
      async convertToBlob() { throw new Error("PNG 编码失败"); }
    }
  });
  const base = { type: "FETCH_IMAGE", site: "instagram", url: "https://scontent.cdninstagram.com/photo.webp" };
  assert.equal((await app.send({ ...base, kind: "image", token: "original" })).ok, true);
  const result = await app.send({ ...base, kind: "png", token: "png" });
  assert.equal(result.ok, false);
  assert.match(result.error, /PNG 编码失败/);
  assert.equal(closed, true);
  assert.equal(app.savedBlobs.length, 1);
});

test("X orig 图片按实际格式保存，拒绝头像及站外地址", async () => {
  const app = loadOffscreen({ ok: true, headers: { get: () => "image/jpeg" },
    blob: async () => new Blob(["image"], { type: "image/jpeg" }) });
  const message = { type: "FETCH_IMAGE", site: "x", kind: "image", token: "x" };
  const result = await app.send({ ...message, url: "https://pbs.twimg.com/media/photo?format=jpg&name=orig" });
  assert.equal(result.ok, true);
  assert.equal(result.extension, ".jpg");
  assert.equal((await app.send({ ...message, url: "https://pbs.twimg.com/profile_images/avatar.jpg" })).ok, false);
});

test("微博视频在保存前验证 MIME 与 MP4 文件头，再生成 mp4 Blob", async () => {
  const source = new Blob([new Uint8Array([0, 0, 0, 20, 102, 116, 121, 112, 105, 115, 111, 109, 0, 0, 0, 0])], { type: "video/mp4" });
  const app = loadOffscreen({ ok: true, headers: { get: () => "video/mp4" }, blob: async () => source });
  const result = await app.send({ type: "FETCH_IMAGE", site: "weibo", kind: "video", token: "video",
    url: "https://f.video.weibocdn.com/video.mp4?template=1280x720.25.0" });
  assert.equal(result.ok, true);
  assert.equal(result.extension, ".mp4");
  assert.equal(app.savedBlobs[0].type, "video/mp4");
  assert.deepEqual(new Uint8Array(await app.savedBlobs[0].arrayBuffer()), new Uint8Array(await source.arrayBuffer()));
});

test("微博视频错误 HTML、伪装二进制和 403 均不生成可下载文件", async () => {
  const message = { type: "FETCH_IMAGE", site: "weibo", kind: "video", token: "video", url: "https://f.video.weibocdn.com/video.mp4" };
  for (const type of ["text/html", "application/octet-stream", "video/mp4"]) {
    const app = loadOffscreen({ ok: true, headers: { get: () => type }, blob: async () => new Blob(["<html>Forbidden</html>"], { type }) });
    const result = await app.send(message);
    assert.equal(result.ok, false);
    assert.match(result.error, /未保存/);
    assert.equal(app.savedBlobs.length, 0);
  }
  const denied = await loadOffscreen({ ok: false, status: 403 }).send(message);
  assert.match(denied.error, /HTTP 403.*刷新微博/);
});
