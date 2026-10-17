const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

function loadCapture() {
  const listeners = {};
  const messages = [];
  const response = { clone: () => ({ json: async () => ({ data: { tweet: {
    rest_id: "123", core: { user_results: { result: { core: { screen_name: "author" } } } },
    legacy: { full_text: "not exported", extended_entities: { media: [{ type: "photo", media_url_https: "https://pbs.twimg.com/media/test.jpg" }] } }
  } } }) }) };
  class Xhr {
    open(...args) { this.openArgs = args; }
    send(...args) { this.sendArgs = args; }
    addEventListener(type, callback) { this[type] = callback; }
  }
  const window = { fetch: async () => response,
    addEventListener(type, callback) { listeners[type] = callback; },
    postMessage(message) { messages.push(message); } };
  const context = vm.createContext({ URL, window, XMLHttpRequest: Xhr,
    location: { href: "https://x.com/home", origin: "https://x.com" } });
  for (const file of ["video-lib.js", "x-lib.js", "x-capture.js"]) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, "..", file), "utf8"), context);
  }
  const request = (postId = "123", origin = "https://x.com") => {
    listeners.message({ source: window, origin, data: { type: "BID_X_REQUEST", requestId: "request", postId } });
    return messages.at(-1);
  };
  return { window, response, Xhr, request, messages };
}

test("页面 fetch 返回原响应，仅读取当前站点的推文 API 响应", async () => {
  const app = loadCapture();
  assert.equal(await app.window.fetch("https://other.example/i/api/graphql/query"), app.response);
  await Promise.resolve();
  assert.equal(app.request().post, null);
  assert.equal(await app.window.fetch("/i/api/graphql/query/TweetDetail"), app.response);
  await Promise.resolve();
  const result = app.request();
  assert.equal(result.post.postId, "123");
  assert.equal(result.post.pictures.length, 1);
  assert.doesNotMatch(JSON.stringify(result), /not exported/);
  const count = app.messages.length;
  app.request("123", "https://other.example");
  assert.equal(app.messages.length, count);
});

test("XHR 保留原有参数及返回行为，并捕获媒体响应", () => {
  const app = loadCapture();
  const xhr = new app.Xhr();
  xhr.open("GET", "/i/api/graphql/query/TweetDetail", true);
  xhr.send(null);
  assert.deepEqual(xhr.openArgs, ["GET", "/i/api/graphql/query/TweetDetail", true]);
  assert.deepEqual(xhr.sendArgs, [null]);
  xhr.responseType = "json";
  xhr.response = { rest_id: "123", core: { user_results: { result: { legacy: { screen_name: "author" } } } }, legacy: {} };
  xhr.load();
  assert.equal(app.request().post.author, "author");
});
