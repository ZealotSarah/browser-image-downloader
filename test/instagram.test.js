const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

function loadInstagram(fetch, detail = false, recommendation = false) {
  let contextmenu;
  let listener;
  const card = {
    isConnected: true,
    querySelector: () => ({}),
    querySelectorAll(selector) {
      if (selector === "img") return [{
        src: "https://scontent.cdninstagram.com/page.webp", srcset: "",
        getBoundingClientRect: () => ({ width: 500, height: 500 }),
        closest: () => null, getAttribute: () => null
      }];
      if (selector === "button") return [];
      return [{ href: `https://www.instagram.com/author/p/${recommendation ? "other" : "ABC"}/` }];
    }
  };
  class Element {
    closest() { return detail ? null : card; }
    querySelectorAll() { return []; }
    get parentElement() { return card; }
  }
  const context = vm.createContext({ URL, AbortSignal, fetch, Element, setTimeout,
    location: { href: "https://www.instagram.com/p/ABC/" },
    document: { addEventListener(type, callback) { contextmenu = callback; } },
    chrome: { runtime: { onMessage: { addListener(callback) { listener = callback; } } } }
  });
  for (const name of ["instagram-lib.js", "instagram.js"]) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, "..", name), "utf8"), context);
  }
  contextmenu({ target: new Element() });
  return () => new Promise(resolve => listener({ type: "RESOLVE_INSTAGRAM_POST" }, {}, resolve));
}

test("使用当前登录会话读取高清接口，无需操作轮播", async () => {
  const resolve = loadInstagram(async (url, options) => {
    assert.match(url, /^\/api\/v1\/media\/\d+\/info\/$/);
    assert.equal(options.credentials, "include");
    return { ok: true, json: async () => ({ items: [{ code: "ABC", media_type: 1,
      image_versions2: { candidates: [{ url: "https://scontent.cdninstagram.com/hd.jpg", width: 2048, height: 2048 }] }
    }] }) };
  });
  const response = await resolve();
  assert.equal(response.ok, true);
  assert.equal(response.data.qualitySource, "media");
  assert.equal(response.data.pictures[0].width, 2048);
});

test("接口被限流或超时时回退页面图并明确提示画质降级", async () => {
  for (const fetch of [async () => ({ ok: false, status: 429 }), async () => { throw new Error("timeout"); }]) {
    const response = await loadInstagram(fetch)();
    assert.equal(response.ok, true);
    assert.equal(response.data.qualitySource, "page");
    assert.match(response.data.qualityWarning, /清晰度可能较低/);
    assert.equal(response.data.pictures[0].url, "https://scontent.cdninstagram.com/page.webp");
  }
});

test("无 article 的详情页通过作者帖子链接定位并下载 WebP", async () => {
  const response = await loadInstagram(async () => ({ ok: false, status: 403 }), true)();
  assert.equal(response.ok, true);
  assert.equal(response.data.postId, "ABC");
  assert.equal(response.data.pictures.length, 1);
  assert.match(response.data.pictures[0].url, /page.webp$/);
});

test("详情页下方推荐帖不能被当作当前帖子下载", async () => {
  const response = await loadInstagram(async () => { throw new Error("不应请求接口"); }, true, true)();
  assert.equal(response.ok, false);
  assert.match(response.error, /未找到右键/);
});
