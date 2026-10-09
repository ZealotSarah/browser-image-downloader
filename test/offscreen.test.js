const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

function loadOffscreen(fetchResponse) {
  const files = name => fs.readFileSync(path.join(__dirname, "..", name), "utf8");
  let listener;
  const revoked = [];
  class Url extends URL {}
  Url.createObjectURL = () => "blob:chrome-extension://test/image";
  Url.revokeObjectURL = url => revoked.push(url);
  const context = vm.createContext({
    URL: Url,
    AbortSignal,
    fetch: async () => fetchResponse,
    chrome: { runtime: { onMessage: { addListener(callback) { listener = callback; } } } }
  });
  vm.runInContext(files("lib.js"), context);
  vm.runInContext(files("offscreen.js"), context);
  const send = message => new Promise(resolve => listener({ target: "offscreen", ...message }, {}, resolve));
  return { send, revoked };
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
