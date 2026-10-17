const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const context = vm.createContext({ URL });
for (const file of ["video-lib.js", "x-lib.js"]) vm.runInContext(fs.readFileSync(path.join(__dirname, "..", file), "utf8"), context);
const lib = context.XDownloads;
const tweet = (id = "123") => ({ rest_id: id, core: { user_results: { result: { rest_id: "42", core: { screen_name: "author" } } } },
  legacy: { extended_entities: { media: [
    { id_str: "photo", type: "photo", media_url_https: "https://pbs.twimg.com/media/photo.jpg" },
    { id_str: "video", type: "video", video_info: { variants: [
      { url: "https://video.twimg.com/vid/640x360/low.mp4?tag=1", content_type: "video/mp4", bitrate: 500000 },
      { url: "https://video.twimg.com/vid/1920x1080/high.mp4?tag=1", content_type: "video/mp4", bitrate: 3000000 },
      { url: "https://video.twimg.com/playlist.m3u8", content_type: "application/x-mpegURL" }
    ] } }
  ] } } });

test("X 和 Twitter 帖子链接及媒体详情保留精确帖子 ID，拒绝外域", () => {
  for (const host of ["x.com", "twitter.com", "www.x.com"]) {
    assert.equal(lib.postIdFromUrl(`https://${host}/author/status/1234567890123456789/photo/2`), "1234567890123456789");
  }
  assert.equal(lib.postIdFromUrl("https://x.com/i/web/status/123"), "123");
  assert.equal(lib.postIdFromUrl("https://example.com/author/status/123"), null);
  assert.equal(lib.postIdFromUrl("https://x.com/author"), null);
});

test("X 图片请求 orig 尺寸并保留格式，不下载头像或封面", () => {
  assert.equal(lib.imageUrl("https://pbs.twimg.com/media/test.jpg?name=small"), "https://pbs.twimg.com/media/test?name=orig&format=jpg");
  assert.equal(lib.imageUrl("https://pbs.twimg.com/media/test?format=webp&name=900x900"), "https://pbs.twimg.com/media/test?format=webp&name=orig");
  assert.equal(lib.imageUrl("https://pbs.twimg.com/profile_images/avatar.jpg"), null);
  assert.equal(lib.imageUrl("https://pbs.twimg.com/ext_tw_video_thumb/cover.jpg"), null);
  assert.equal(lib.imageUrl("https://example.com/media/photo.jpg"), null);
});

test("混合帖分离图片与最高规格 MP4，保留签名并支持新旧用户名结构", () => {
  const result = lib.parseTweet(tweet());
  assert.equal(result.author, "author");
  assert.equal(result.pictures.length, 1);
  assert.equal(result.videos.length, 1);
  assert.equal(result.videos[0].width, 1920);
  assert.match(result.videos[0].url, /high.mp4\?tag=1$/);
  const old = tweet();
  old.core.user_results.result = { legacy: { screen_name: "old_author" } };
  assert.equal(lib.parseTweet(old).author, "old_author");
});

test("引用帖、转帖按独立 ID 收集，不混入当前帖媒体且不导出正文及凭据", () => {
  const outer = tweet("123");
  outer.quoted_status_result = { result: tweet("456") };
  outer.legacy.full_text = "private text";
  const posts = lib.collectPosts({ data: { instructions: [{ result: outer }] }, token: "secret" });
  assert.deepEqual(Array.from(posts, post => post.postId), ["123", "456"]);
  assert.equal(posts[0].pictures.length, 1);
  assert.doesNotMatch(JSON.stringify(posts), /private text|secret/);
});

test("只有分片流、未知分辨率或站外视频时计入失败，GIF 作为 MP4 视频", () => {
  const value = tweet();
  value.legacy.extended_entities.media = [{ type: "video", video_info: { variants: [
    { content_type: "video/mp4", url: "https://video.twimg.com/unknown.mp4", bitrate: 5000 },
    { content_type: "video/mp4", url: "https://example.com/vid/1920x1080/file.mp4" }
  ] } }];
  assert.equal(lib.parseTweet(value).videoMissing, 1);
  value.legacy.extended_entities.media = tweet().legacy.extended_entities.media;
  value.legacy.extended_entities.media[1].type = "animated_gif";
  assert.equal(lib.parseTweet(value).videos.length, 1);
});
