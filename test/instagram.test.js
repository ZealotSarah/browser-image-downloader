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
    matches: () => false,
    querySelector: selector => selector === "video" ? null : ({}),
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
    matches() { return false; }
    closest() { return detail ? null : card; }
    querySelectorAll() { return []; }
    get parentElement() { return card; }
  }
  const context = vm.createContext({ URL, AbortSignal, fetch, Element, setTimeout,
    location: { href: "https://www.instagram.com/p/ABC/" },
    document: { addEventListener(type, callback) { contextmenu = callback; } },
    chrome: { runtime: { onMessage: { addListener(callback) { listener = callback; } } } }
  });
  for (const name of ["instagram-lib.js", "video-lib.js", "instagram.js"]) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, "..", name), "utf8"), context);
  }
  contextmenu({ target: new Element() });
  return () => new Promise(resolve => listener({ type: "RESOLVE_MEDIA" }, {}, resolve));
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

test("视频请求读取 video_versions，不混入图片或使用页面播放流", async () => {
  const response = await loadInstagram(async () => ({ ok: true, json: async () => ({ items: [{ code: "ABC", media_type: 2,
    video_versions: [{ url: "https://scontent.cdninstagram.com/video.mp4", width: 1920, height: 1080 }] }] }) }))
    ();
  assert.equal(response.ok, true);
  assert.equal(response.data.videos[0].width, 1920);
  assert.equal(response.data.pictures.length, 0);
});

test("Instagram 混合帖一次 API 请求同时取得图片视频，不下载视频封面", async () => {
  let requests = 0;
  const response = await loadInstagram(async () => {
    requests++;
    return { ok: true, json: async () => ({ items: [{ code: "ABC", carousel_media: [
      { media_type: 1, image_versions2: { candidates: [{ url: "https://scontent.cdninstagram.com/photo.jpg", width: 1440, height: 960 }] } },
      { media_type: 2, image_versions2: { candidates: [{ url: "https://scontent.cdninstagram.com/cover.jpg", width: 1440, height: 960 }] },
        video_versions: [{ url: "https://scontent.cdninstagram.com/video.mp4", width: 1920, height: 1080 }] }
    ] }] }) };
  })();
  assert.equal(response.ok, true);
  assert.equal(requests, 1);
  assert.equal(response.data.pictures.length, 1);
  assert.equal(response.data.videos.length, 1);
  assert.equal(response.data.missing, 0);
});

test("统一入口接口失败时明确提示页面回退及无法核实视频", async () => {
  const response = await loadInstagram(async () => ({ ok: false, status: 429 }))();
  assert.equal(response.ok, true);
  assert.match(response.data.qualityWarning, /429.*无法确认是否遗漏视频/);
});
