const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

async function resolve(status, original = status) {
  let onContext;
  let listener;
  let requests = 0;
  const card = { isConnected: true, getAttribute: () => "123" };
  class Element { closest() { return card; } }
  const context = vm.createContext({ URL, Element,
    location: { href: "https://weibo.com/42/123" },
    document: { addEventListener(type, callback) { onContext = callback; } },
    fetch: async () => { requests++; return { ok: true, json: async () => requests === 1 ? status : original }; },
    chrome: { runtime: { onMessage: { addListener(callback) { listener = callback; } } } }
  });
  for (const file of ["lib.js", "video-lib.js", "content.js"]) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, "..", file), "utf8"), context);
  }
  onContext({ target: new Element() });
  const result = await new Promise(done => listener({ type: "RESOLVE_MEDIA" }, {}, done));
  return { result, requests };
}
const video = { playback_list: [{ play_info: { url: "https://f.video.weibocdn.com/video.mp4", width: 1920, height: 1080 } }] };
const photo = { pic_ids: ["a"], pic_infos: { a: { largest: { url: "https://wx1.sinaimg.cn/large/a.jpg" } } } };

test("微博统一入口一次读取，自动下载混合帖图片与视频", async () => {
  const { result, requests } = await resolve({ idstr: "123", ...photo, page_info: { media_info: video } });
  assert.equal(result.ok, true);
  assert.equal(requests, 1);
  assert.equal(result.data.pictures.length, 1);
  assert.equal(result.data.videos.length, 1);
});

test("微博自有媒体不混入转发媒体，无自有媒体才整体使用原微博", async () => {
  const original = { idstr: "456", user: { screen_name: "original" }, page_info: { media_info: video } };
  const own = (await resolve({ idstr: "123", ...photo, retweeted_status: original })).result;
  assert.equal(own.data.pictures.length, 1);
  assert.equal(own.data.videos.length, 0);
  const repost = (await resolve({ idstr: "123", retweeted_status: original })).result;
  assert.equal(repost.data.postId, "456");
  assert.equal(repost.data.author, "original");
  assert.equal(repost.data.videos.length, 1);
});

test("转发外层镜像视频、原微博内层含三张图片时同时返回全部媒体", async () => {
  const pictures = {
    pic_ids: ["a", "b", "c"],
    pic_infos: Object.fromEntries(["a", "b", "c"].map(id => [id, { largest: { url: `https://wx2.sinaimg.cn/large/${id}.jpg` } }]))
  };
  for (const mirrored of [
    { page_info: { media_info: video } },
    { mix_media_info: { items: [{ type: "video", data: { object_id: "video-id", media_info: video } }] } }
  ]) {
    const { result, requests } = await resolve({ idstr: "outer", user: { screen_name: "reposter" }, ...mirrored,
      retweeted_status: { idstr: "original", user: { screen_name: "author", idstr: "42" }, ...pictures } });
    assert.equal(result.ok, true);
    assert.equal(requests, 1);
    assert.equal(result.data.pictures.length, 3);
    assert.equal(result.data.videos.length, 1);
    assert.equal(result.data.author, "author");
    assert.equal(result.data.postId, "original");
    assert.equal(result.data.missing, 0);
  }
});

test("原微博已经包含视频时不重复加入转发层镜像视频", async () => {
  const { result } = await resolve({ page_info: { media_info: video },
    retweeted_status: { idstr: "original", ...photo, page_info: { media_info: video } } });
  assert.equal(result.data.pictures.length, 1);
  assert.equal(result.data.videos.length, 1);
});

test("转发者自带图片和视频时不混入原微博图片", async () => {
  const { result } = await resolve({ idstr: "outer", user: { screen_name: "reposter" },
    ...photo, page_info: { media_info: video },
    retweeted_status: { idstr: "original", user: { screen_name: "author" },
      pic_ids: ["other"], pic_infos: { other: { largest: { url: "https://wx2.sinaimg.cn/large/other.jpg" } } } } });
  assert.equal(result.data.pictures.length, 1);
  assert.match(result.data.pictures[0].url, /\/a.jpg$/);
  assert.equal(result.data.videos.length, 1);
  assert.equal(result.data.author, "reposter");
  assert.equal(result.data.postId, "outer");
});

test("转发摘要仅含原图 ID 而缺少原图地址时请求原微博详情补齐", async () => {
  const original = { idstr: "456", user: { screen_name: "author" }, ...photo };
  const { result, requests } = await resolve({ idstr: "123", page_info: { media_info: video },
    retweeted_status: { idstr: "456", pic_ids: ["a"] } }, original);
  assert.equal(requests, 2);
  assert.equal(result.data.pictures.length, 1);
  assert.equal(result.data.videos.length, 1);
  assert.equal(result.data.missing, 0);
});

test("转发外层只镜像图片 ID 时，按 ID 归属确认后补齐原微博图片", async () => {
  const original = { idstr: "456", user: { screen_name: "author" }, ...photo };
  const { result } = await resolve({ idstr: "123", pic_ids: ["a"], page_info: { media_info: video },
    retweeted_status: { idstr: "456" } }, original);
  assert.equal(result.data.postId, "456");
  assert.equal(result.data.author, "author");
  assert.equal(result.data.pictures.length, 1);
  assert.equal(result.data.videos.length, 1);
});

test("补全详情失败时保留视频并显示原图缺失原因，不声称保存失败", async () => {
  const { result } = await resolve({ idstr: "123", page_info: { media_info: video },
    retweeted_status: { idstr: "456", pic_ids: ["a"] } }, { error: "Forbidden" });
  assert.equal(result.data.pictures.length, 0);
  assert.equal(result.data.videos.length, 1);
  assert.equal(result.data.imageMissing, 1);
  assert.match(result.data.qualityWarning, /图片详情补全失败.*Forbidden/);
});
