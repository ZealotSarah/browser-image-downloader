const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const context = vm.createContext({ URL });
vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "instagram-lib.js"), "utf8"), context);
const lib = context.InstagramImages;

test("Instagram 图片选择页面提供的最大宽度版本", () => {
  const image = {
    src: "https://scontent.cdninstagram.com/photo-small.jpg",
    srcset: "https://scontent.cdninstagram.com/photo-small.jpg 320w, https://scontent.cdninstagram.com/photo-large.jpg 1080w"
  };
  assert.equal(lib.bestImageUrl(image), "https://scontent.cdninstagram.com/photo-large.jpg");
});

test("只接受 Instagram 帖子和图片 CDN 地址", () => {
  assert.equal(lib.postIdFromUrl("https://www.instagram.com/p/Cx_12-3/?img_index=2"), "Cx_12-3");
  assert.equal(lib.postIdFromUrl("https://www.instagram.com/the_world.cosplay/p/DeTzM24THMU/"), "DeTzM24THMU");
  assert.equal(lib.postIdFromUrl("https://www.instagram.com/p/DeTzM24THMU/c/123/"), null);
  assert.equal(lib.postIdFromUrl("https://www.instagram.com/reel/Cx_12-3/"), null);
  assert.equal(lib.imageUrl("https://instagram.fabc1-1.fna.fbcdn.net/photo.jpg"), "https://instagram.fabc1-1.fna.fbcdn.net/photo.jpg");
  assert.equal(lib.imageUrl("https://example.com/photo.jpg"), null);
  assert.equal(lib.imageUrl("http://scontent.cdninstagram.com/photo.jpg"), null);
});

test("帖子编号转换保留超过 Number 精度的媒体 ID", () => {
  assert.equal(lib.mediaIdFromPostId("BAAAAAAAAAA"), "1152921504606846976");
  assert.throws(() => lib.mediaIdFromPostId("bad/id"), /无效/);
});

test("接口候选按像素面积选择，同尺寸优先 JPEG，保留签名参数", () => {
  const result = lib.parseMedia({ items: [{ code: "ABC", media_type: 1, user: { username: "author" },
    image_versions2: { candidates: [
      { url: "https://scontent.cdninstagram.com/small.jpg", width: 1080, height: 1080 },
      { url: "https://scontent.cdninstagram.com/full.webp", width: 1440, height: 1800 },
      { url: "https://scontent.cdninstagram.com/full.jpg?signature=keep", width: 1440, height: 1800 },
      { url: "https://example.com/invalid.jpg", width: 9000, height: 9000 }
    ] } }] }, "ABC");
  assert.equal(result.pictures[0].url, "https://scontent.cdninstagram.com/full.jpg?signature=keep");
  assert.equal(result.pictures[0].width, 1440);
  assert.equal(result.qualitySource, "media");
});

test("大尺寸 WebP 优先于小尺寸 JPEG，不为改格式牺牲分辨率", () => {
  const result = lib.parseMedia({ items: [{ code: "ABC", media_type: 1, image_versions2: { candidates: [
    { url: "https://scontent.cdninstagram.com/small.jpg", width: 1080, height: 1080 },
    { url: "https://scontent.cdninstagram.com/full.webp", width: 1440, height: 1440 }
  ] } }] }, "ABC");
  assert.match(result.pictures[0].url, /full.webp$/);
});

test("轮播保持图片顺序，跳过视频封面，统计缺失图片且拒绝其他帖子", () => {
  const photo = id => ({ pk: id, media_type: 1, image_versions2: { candidates: [
    { url: `https://scontent.cdninstagram.com/${id}.jpg`, width: 1440, height: 1800 }
  ] } });
  const result = lib.parseMedia({ items: [{ code: "ABC", carousel_media: [
    photo("2"), { ...photo("video"), media_type: 2 }, { media_type: 1 }, photo("1")
  ] }] }, "ABC");
  assert.deepEqual(Array.from(result.pictures, picture => picture.id), ["2", "1"]);
  assert.equal(result.missing, 1);
  assert.throws(() => lib.parseMedia({ items: [{ code: "other" }] }, "ABC"), /目标帖子/);
});
