const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const context = vm.createContext({ URL });
vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "lib.js"), "utf8"), context);
const lib = context.WeiboImages;

test("按 pic_ids 顺序提取明确的原图并报告缺失", () => {
  const result = lib.parseStatus({
    user: { screen_name: "摄影师", idstr: "123" },
    pic_ids: ["a", "b", "c"],
    pic_infos: {
      a: { largest: { url: "https://wx1.sinaimg.cn/large/a.jpg" } },
      b: { thumbnail: { url: "https://wx1.sinaimg.cn/thumb180/b.jpg" } },
      c: { original: { url: "//wx2.sinaimg.cn/original/c.gif" } }
    }
  });
  assert.equal(result.author, "摄影师");
  assert.equal(result.userId, "123");
  assert.deepEqual(Array.from(result.pictures, picture => picture.id), ["a", "c"]);
  assert.equal(result.pictures[1].url, "https://wx2.sinaimg.cn/original/c.gif");
  assert.equal(result.missing, 1);
});

test("微博 original 字段中的 orj1080 地址改用完整尺寸", () => {
  const source = "https://wx1.sinaimg.cn/orj1080/005RkDaQly1ihvtybm8rmj33ls5itnpj.jpg";
  assert.equal(lib.originalUrl({ original: { url: source } }),
    "https://wx1.sinaimg.cn/large/005RkDaQly1ihvtybm8rmj33ls5itnpj.jpg");
  assert.equal(lib.originalUrl({ largest: { url: source } }),
    "https://wx1.sinaimg.cn/large/005RkDaQly1ihvtybm8rmj33ls5itnpj.jpg");
});

test("Live Photo 同时提取静态原图和对应的 MOV", () => {
  const video = "https://video.weibo.com/media/play?livephoto=https%3A%2F%2Flivephoto.us.sinaimg.cn%2Fclip.mov";
  const result = lib.parseStatus({
    pic_ids: ["a", "b"],
    pic_infos: {
      a: { type: "livephoto", largest: { url: "https://wx1.sinaimg.cn/large/a.jpg" }, video },
      b: { largest: { url: "https://wx1.sinaimg.cn/large/b.jpg" } }
    }
  });
  assert.equal(result.pictures[0].url, "https://wx1.sinaimg.cn/large/a.jpg");
  assert.equal(result.pictures[0].liveUrl, video);
  assert.equal(result.pictures[1].liveUrl, undefined);
  assert.equal(lib.extensionFromUrl(video), ".mov");
  assert.equal(lib.extensionFromUrl(`${video}%3FExpires%3D123`), ".mov");
  assert.equal(result.missing, 0);
  assert.equal(lib.livePhotoUrl({ type: "livephoto", video: "https://example.com/clip.mov" }), null);
  assert.equal(lib.livePhotoUrl({ type: "livephoto", video: "http://livephoto.us.sinaimg.cn/clip.mov" }),
    "https://livephoto.us.sinaimg.cn/clip.mov");
});

test("无自有图片的转发微博使用原微博作者和图片", () => {
  const result = lib.parseStatus({
    user: { screen_name: "转发者", idstr: "1" },
    retweeted_status: {
      user: { screen_name: "原作者", idstr: "2" },
      pic_ids: ["p"],
      pic_infos: { p: { largest: { url: "https://wx1.sinaimg.cn/large/p.png" } } }
    }
  });
  assert.equal(result.author, "原作者");
  assert.equal(result.pictures.length, 1);
});

test("混合媒体跳过视频，不接受其他站点图片", () => {
  const result = lib.parseStatus({
    mix_media_info: { items: [
      { type: "video", data: { original: { url: "https://wx1.sinaimg.cn/large/video.jpg" } } },
      { type: "pic", data: { id: "a", pic_info: { largest: { url: "https://wx1.sinaimg.cn/large/a.webp" } } } },
      { type: "pic", data: { id: "b", pic_info: { original: { url: "https://example.com/b.jpg" } } } }
    ] }
  });
  assert.equal(result.pictures.length, 1);
  assert.equal(result.missing, 1);
});

test("文件夹名称阻止路径穿越并处理非法字符", () => {
  assert.throws(() => lib.normalizeSubfolder("../other"));
  assert.throws(() => lib.normalizeSubfolder("a\\b"));
  assert.equal(lib.normalizeSubfolder("微博:原图"), "微博_原图");
  assert.equal(lib.safeSegment("CON"), "未命名");
  assert.equal(lib.normalizeSubfolder("CON.txt"), "微博原图");
  assert.equal(lib.extensionFromUrl("https://wx1.sinaimg.cn/large/a.JPEG?x=1"), ".jpg");
});

test("只识别微博帖子链接", () => {
  assert.equal(lib.postIdFromUrl("https://weibo.com/123/AbC9"), "AbC9");
  assert.equal(lib.postIdFromUrl("https://weibo.com/detail/AbC9"), "AbC9");
  assert.equal(lib.postIdFromUrl("https://weibo.com/u/123"), null);
  assert.equal(lib.postIdFromUrl("https://example.com/123/AbC9"), null);
});
