const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const context = vm.createContext({ URL });
for (const file of ["instagram-lib.js", "video-lib.js"]) {
  vm.runInContext(fs.readFileSync(path.join(__dirname, "..", file), "utf8"), context);
}
const lib = context.VideoDownloads;
const version = (name, width, height, fps = 30, bitrate = 1000000) => ({
  url: `https://f.video.weibocdn.com/${name}.mp4?sign=keep`, width, height, fps, bitrate
});

test("最高规格依次比较分辨率、帧率和码率，保留签名", () => {
  const candidates = [version("hd", 1920, 1080, 120, 9000000), version("4k", 3840, 2160),
    version("4k60", 3840, 2160, 60), version("best", 3840, 2160, 60, 8000000)];
  assert.match(lib.best(candidates, "weibo").url, /best.mp4\?sign=keep$/);
});

test("不将音频、静音流、清晰度未知或分片清单伪装成最高规格视频", () => {
  assert.equal(lib.best([
    { ...version("silent", 3840, 2160), audio_codecs: "none" },
    { ...version("audio", 3840, 2160), video_codecs: "none" },
    { ...version("unknown", 0, 0) },
    { ...version("playlist", 3840, 2160), mime: "application/dash+xml" },
    { ...version("infinite", Infinity, 2160) }
  ], "weibo"), null);
  for (const extension of ["m3u8", "mpd", "m4s"]) {
    assert.equal(lib.videoUrl(`https://f.video.weibocdn.com/file.${extension}?sign=keep`, "weibo"), null);
  }
  assert.equal(lib.videoUrl("https://example.com/video.mp4", "weibo"), null);
  assert.equal(lib.videoUrl("https://f.video.weibocdn.com/video.mp4", "instagram"), null);
});

test("微博 playback_list 优先选择 4K 完整视频而非默认播放地址", () => {
  const result = lib.parseWeibo({ idstr: "123", user: { screen_name: "author", idstr: "42" },
    page_info: { object_id: "vid", media_info: { stream_url: version("default", 640, 360).url,
      playback_list: [version("hd", 1920, 1080), version("4k", 3840, 2160)].map(play_info => ({ play_info })) } } });
  assert.equal(result.videos.length, 1);
  assert.equal(result.videos[0].width, 3840);
  assert.equal(result.author, "author");
});

test("微博混合媒体保留视频顺序、去重，缺失规格计入失败", () => {
  const entry = id => ({ type: "video", data: { object_id: id,
    media_info: { playback_list: [{ play_info: version(id, 1920, 1080) }] } } });
  const result = lib.parseWeibo({ mix_media_info: { items: [entry("a"), { type: "pic" }, entry("a"),
    { type: "video", data: { object_id: "missing" } }, entry("b")] } });
  assert.deepEqual(Array.from(result.videos, video => video.id), ["a", "b"]);
  assert.equal(result.missing, 1);
});

test("转发微博读取原作者视频，旧 URL 的 template 提供明确分辨率", () => {
  const result = lib.parseWeibo({ idstr: "repost", retweeted_status: { idstr: "original", user: { screen_name: "author" },
    page_info: { media_info: { stream_url_hd: "//f.video.weibocdn.com/high.mp4?template=1920x1080&sign=keep" } } } });
  assert.equal(result.postId, "original");
  assert.equal(result.videos[0].width, 1920);
  assert.equal(result.author, "author");
});

test("Instagram 混合轮播只选各视频最高规格，跳过图片及封面", () => {
  const item = id => ({ pk: id, media_type: 2, video_versions: [
    { url: `https://scontent.cdninstagram.com/${id}-low.mp4`, width: 640, height: 360 },
    { url: `https://scontent.cdninstagram.com/${id}-high.mp4`, width: 1920, height: 1080 }
  ] });
  const result = lib.parseInstagram({ items: [{ code: "ABC", user: { username: "author" },
    carousel_media: [item("a"), { media_type: 1 }, { media_type: 2 }, item("b")] }] }, "ABC");
  assert.deepEqual(Array.from(result.videos, video => video.id), ["a", "b"]);
  assert.match(result.videos[0].url, /a-high.mp4$/);
  assert.equal(result.missing, 1);
  assert.throws(() => lib.parseInstagram({ items: [{ code: "other" }] }, "ABC"), /目标帖子/);
});

test("Instagram 视频链接支持 Reels、作者路径及普通帖，排除评论和 Story", () => {
  for (const pathname of ["/p/ABC/", "/reel/ABC/", "/reels/ABC/", "/author/reel/ABC/"]) {
    assert.equal(lib.instagramPostId(`https://www.instagram.com${pathname}`), "ABC");
  }
  assert.equal(lib.instagramPostId("https://www.instagram.com/p/ABC/c/123/"), null);
  assert.equal(lib.instagramPostId("https://www.instagram.com/stories/author/123/"), null);
});

test("微博实际 template 宽高后带帧率等参数时仍保留签名并识别规格", () => {
  const url = "https://f.video.weibocdn.com/o0/video.mp4?label=mp4_720p&template=1280x720.25.0&Expires=123&ssig=keep";
  const result = lib.parseWeibo({ page_info: { media_info: { stream_url_hd: url } } });
  assert.equal(result.missing, 0);
  assert.equal(result.videos[0].width, 1280);
  assert.equal(result.videos[0].height, 720);
  assert.equal(result.videos[0].url, url);
});

test("微博播放页和 CDN HTML 地址不能作为完整视频候选", () => {
  assert.equal(lib.videoUrl("https://video.weibo.com/show?fid=123", "weibo"), null);
  assert.equal(lib.videoUrl("https://f.video.weibocdn.com/error.htm", "weibo"), null);
  assert.equal(lib.videoUrl("https://weibo.com/error.html", "weibo"), null);
});
