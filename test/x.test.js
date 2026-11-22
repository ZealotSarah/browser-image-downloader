const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

/* Minimal DOM good enough for the selectors x.js uses. */
function matchSimple(element, selector) {
  const parsed = selector.trim().match(/^([a-zA-Z0-9-]*)((?:\[[^\]]+\])*)$/);
  if (!parsed) throw new Error(`Unsupported selector: ${selector}`);
  const [, tag, attrs] = parsed;
  if (tag && element.tagName !== tag.toUpperCase()) return false;
  for (const token of attrs.match(/\[[^\]]+\]/g) || []) {
    const [, name, operator, raw] = token.match(/^\[([^\]*=^$]+)(?:(\*=|\^=|=)([\s\S]*))?\]$/);
    const actual = element.getAttribute(name);
    if (actual === null) return false;
    if (!operator) continue;
    const value = String(raw).replace(/^"(.*)"$/, "$1");
    if (operator === "=" && actual !== value) return false;
    if (operator === "*=" && !actual.includes(value)) return false;
    if (operator === "^=" && !actual.startsWith(value)) return false;
  }
  return true;
}

function matchSelector(element, selector) {
  const parts = selector.trim().split(/\s+/);
  if (!matchSimple(element, parts[parts.length - 1])) return false;
  let index = parts.length - 2;
  let node = element.parentElement;
  while (index >= 0) {
    if (!node) return false;
    if (matchSimple(node, parts[index])) index--;
    node = node.parentElement;
  }
  return true;
}

class Element {
  constructor(tag, attrs = {}, children = []) {
    this.tagName = tag.toUpperCase();
    this.attrs = { ...attrs };
    this.children = [];
    this.parentElement = null;
    this.isConnected = true;
    for (const child of children) this.append(child);
  }
  append(child) {
    child.parentElement = this;
    this.children.push(child);
    return child;
  }
  getAttribute(name) {
    return Object.prototype.hasOwnProperty.call(this.attrs, name) ? this.attrs[name] : null;
  }
  get src() { return this.getAttribute("src") || ""; }
  get currentSrc() { return this.getAttribute("src") || ""; }
  get href() { return this.getAttribute("href") || ""; }
  get pathname() {
    try { return new URL(this.href).pathname; } catch { return ""; }
  }
  get descendants() {
    const list = [];
    const walk = node => {
      for (const child of node.children) {
        list.push(child);
        walk(child);
      }
    };
    walk(this);
    return list;
  }
  querySelectorAll(selector) {
    const parts = selector.split(",").map(part => part.trim());
    return this.descendants.filter(element => parts.some(part => matchSelector(element, part)));
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  closest(selector) {
    const parts = selector.split(",").map(part => part.trim());
    let node = this;
    while (node) {
      if (parts.some(part => matchSelector(node, part))) return node;
      node = node.parentElement;
    }
    return null;
  }
  remove() {
    const parent = this.parentElement;
    if (parent) parent.children = parent.children.filter(child => child !== this);
    this.parentElement = null;
  }
}

const el = (tag, attrs = {}, children = []) => new Element(tag, attrs, children);

function buildCard(config = {}) {
  const id = config.id || "2123043074771214373";
  const author = config.author || "a_se_ase";
  const href = `https://x.com/${author}/status/${id}`;
  const article = el("article", { "data-testid": "tweet" });
  article.append(el("div", { "data-testid": "User-Name" }, [el("a", { href: `https://x.com/${author}` }, [el("span")])]));
  if (!config.noTime) article.append(el("a", { href }, [el("time")]));
  const photos = config.photos || [];
  if (photos.length) {
    article.append(el("div", { "data-testid": "tweetPhoto" }, photos.map((name, index) =>
      el("a", { href: `${href}/photo/${index + 1}` }, [el("img", { src: `https://pbs.twimg.com/media/${name}?format=jpg&name=small` })]))));
  } else if (config.noTime && !config.video) {
    // A media grid link without a timestamp: only the photo link identifies the post.
    article.append(el("a", { href: `${href}/photo/1` }, [el("div")]));
  }
  if (config.video) article.append(el("div", { "data-testid": "videoPlayer" }, [el("video")]));
  if (config.quote) {
    article.append(el("div", { role: "link" }, [config.quote]));
  }
  return article;
}

function quoteImage(statusUrl, name) {
  return el("a", { href: statusUrl }, [el("img", { src: `https://pbs.twimg.com/media/${name}?format=jpg&name=small` })]);
}

function loadX(config = {}) {
  const url = config.url || "https://x.com/home";
  const location = new URL(url);
  const posts = config.posts || {};
  const handlers = { contextmenu: null, pointermove: null };
  const root = el("html", {}, config.children || []);
  const clock = { now: config.now || Date.now() };

  const document = {
    documentElement: root,
    addEventListener(type, callback) { handlers[type] = callback; },
    removeEventListener() {},
    querySelectorAll(selector) { return root.querySelectorAll(selector); },
    querySelector(selector) { return root.querySelector(selector); },
    getElementById() { return null; },
    createElement(tag) { return el(tag); },
    elementFromPoint() { return config.pointElement || null; }
  };

  const window = {
    addEventListener(type, callback) { if (type === "message") handlers.message = callback; },
    removeEventListener(type, callback) { if (type === "message" && handlers.message === callback) handlers.message = null; },
    postMessage(message) {
      const listener = handlers.message;
      if (!listener) return;
      listener({ source: window, origin: location.origin,
        data: { type: "BID_X_RESPONSE", requestId: message.requestId, post: posts[message.postId] || null } });
    }
  };

  let runtimeListener;
  const context = vm.createContext({ URL, Element, window, document, location, setTimeout, clearTimeout,
    Date: { now: () => clock.now },
    crypto: { randomUUID: () => "request" },
    chrome: { runtime: { onMessage: { addListener(callback) { runtimeListener = callback; } } } } });
  for (const file of ["video-lib.js", "x-lib.js", "x.js"]) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, "..", file), "utf8"), context);
  }

  return {
    clock,
    card: (config.children || [])[0],
    contextmenu(target, point = { x: 10, y: 10 }) {
      handlers.contextmenu({ target, clientX: point.x, clientY: point.y });
    },
    pointermove(target, point = { x: 10, y: 10 }) {
      handlers.pointermove({ target, clientX: point.x, clientY: point.y });
    },
    send: type => new Promise(resolve => runtimeListener({ type }, {}, resolve))
  };
}

const POST_ID = "2123043074771214373";

// The main-world bridge forwards the raw response, so tests feed raw posts.
function rawPost({ id = POST_ID, author = "a_se_ase", photos = ["AAA"], video = false } = {}) {
  const media = photos.map((name, index) => ({ id_str: `${index + 1}`, type: "photo",
    media_url_https: `https://pbs.twimg.com/media/${name}?format=jpg&name=small` }));
  if (video) media.push({ id_str: "v1", type: "video", media_url_https: "https://pbs.twimg.com/amplify_video_thumb/1/img/a.jpg",
    video_info: { variants: [
      { url: "https://video.twimg.com/ext_tw_video/1/pu/vid/480x270/a.mp4", content_type: "video/mp4", bitrate: 320000 },
      { url: "https://video.twimg.com/ext_tw_video/1/pu/vid/1280x720/b.mp4", content_type: "video/mp4", bitrate: 2176000 }
    ] } });
  return { rest_id: id, legacy: { id_str: id, user_id_str: "1", full_text: "中秋快乐",
      extended_entities: { media } },
    core: { user_results: { result: { rest_id: "1", core: { screen_name: author } } } } };
}

test("X 信息流右键帖子：按卡片时间链接定位并返回接口媒体", async () => {
  const card = buildCard({ photos: ["AAA"] });
  const app = loadX({ children: [card], posts: { [POST_ID]: rawPost() } });
  app.contextmenu(card.querySelector("img"));
  const result = await app.send("RESOLVE_MEDIA");
  assert.equal(result.ok, true);
  assert.equal(result.data.postId, POST_ID);
  assert.equal(result.data.pictures.length, 1);
  assert.equal(result.data.missing, 0);
});

test("X 图片查看器没有帖子卡片时按图片链接或详情页地址定位", async () => {
  const status = `https://x.com/a_se_ase/status/${POST_ID}`;
  for (const options of [
    { url: `${status}/photo/1`, children: [], pointElement: el("a", { href: `${status}/photo/1` }, [el("img", { src: "https://pbs.twimg.com/media/AAA?format=jpg" })]) },
    { url: `${status}/photo/1`, children: [] },
    { url: status, children: [] }
  ]) {
    const app = loadX({ ...options, posts: { [POST_ID]: rawPost() } });
    app.contextmenu(options.pointElement || el("div"));
    const result = await app.send("RESOLVE_MEDIA");
    assert.equal(result.ok, true, JSON.stringify(options.url));
    assert.equal(result.data.postId, POST_ID);
  }
});

test("X 媒体卡片缺少时间链接时用唯一的图片链接定位", async () => {
  const card = buildCard({ noTime: true });
  const app = loadX({ children: [card], posts: { [POST_ID]: rawPost() } });
  app.contextmenu(card.querySelector("div"));
  const result = await app.send("RESOLVE_MEDIA");
  assert.equal(result.ok, true);
  assert.equal(result.data.postId, POST_ID);
});

test("X 信息流右键空白处且无归属时明确提示重新右键", async () => {
  const card = buildCard({});
  const app = loadX({ children: [card, el("div")], posts: { [POST_ID]: rawPost() } });
  app.contextmenu(card.querySelector("time"));
  // Right-clicking blank space afterwards must not reuse the previous post.
  app.contextmenu(el("div"));
  const result = await app.send("RESOLVE_MEDIA");
  assert.equal(result.ok, false);
  assert.match(result.error, /未找到右键所在的 X 帖子/);
});

test("X 独立图片层右键时保留指针停留的帖子", async () => {
  const card = buildCard({ photos: ["AAA"] });
  const overlay = el("div", { "data-testid": "tweetPhoto" }, [el("img", { src: "https://pbs.twimg.com/media/AAA?format=jpg" })]);
  const app = loadX({ children: [card, overlay], posts: { [POST_ID]: rawPost() } });
  app.contextmenu(card.querySelector("img"));
  app.contextmenu(overlay.querySelector("img"));
  const result = await app.send("RESOLVE_MEDIA");
  assert.equal(result.ok, true);
  assert.equal(result.data.postId, POST_ID);
});

test("X 卡片被页面重渲染后仍按记录的帖子继续", async () => {
  const card = buildCard({ photos: ["AAA"] });
  const app = loadX({ children: [card], posts: { [POST_ID]: rawPost() } });
  app.contextmenu(card.querySelector("img"));
  card.isConnected = false;
  card.remove();
  const result = await app.send("RESOLVE_MEDIA");
  assert.equal(result.ok, true);
  assert.equal(result.data.postId, POST_ID);
});

test("X 右键记录过期后改用详情页地址，信息流则拒绝", async () => {
  const status = `https://x.com/a_se_ase/status/${POST_ID}`;
  const card = buildCard({});
  const details = loadX({ url: status, children: [card], posts: { [POST_ID]: rawPost() } });
  details.contextmenu(card.querySelector("time"));
  details.clock.now += 20 * 60 * 1000;
  assert.equal((await details.send("RESOLVE_MEDIA")).ok, true);

  const feedCard = buildCard({});
  const otherCard = buildCard({ id: "987654321", author: "other" });
  const feed = loadX({ children: [feedCard, otherCard], posts: { [POST_ID]: rawPost() } });
  feed.contextmenu(feedCard.querySelector("time"));
  feed.clock.now += 20 * 60 * 1000;
  const stale = await feed.send("RESOLVE_MEDIA");
  assert.equal(stale.ok, false);
  assert.match(stale.error, /未找到右键所在的 X 帖子/);
});

test("X 未取得接口数据时改用页面上已显示的图片原图", async () => {
  const card = buildCard({ photos: ["AAA", "BBB"] });
  const app = loadX({ children: [card], posts: {} });
  app.contextmenu(card.querySelector("img"));
  const result = await app.send("RESOLVE_MEDIA");
  assert.equal(result.ok, true);
  assert.equal(result.data.pictures.length, 2);
  assert.match(result.data.pictures[0].url, /name=orig/);
  assert.equal(result.data.qualitySource, "page");
  assert.match(result.data.qualityWarning, /页面上显示的图片/);
});

test("X 页面兜底遇到视频时保留图片并提示刷新后重试", async () => {
  const card = buildCard({ photos: ["AAA"], video: true });
  const app = loadX({ children: [card], posts: {} });
  app.contextmenu(card.querySelector("img"));
  const result = await app.send("RESOLVE_MEDIA");
  assert.equal(result.ok, true);
  assert.equal(result.data.pictures.length, 1);
  assert.equal(result.data.videos.length, 0);
  assert.equal(result.data.videoMissing, 1);
  assert.equal(result.data.missing, 1);
  assert.match(result.data.qualityWarning, /刷新页面/);
});

test("X 页面兜底不把引用帖的图片当成外层帖子的媒体", async () => {
  const card = buildCard({ photos: ["AAA"], quote: quoteImage("https://x.com/other/status/456/photo/1", "QUOTED") });
  const app = loadX({ children: [card], posts: {} });
  app.contextmenu(card.querySelector("img"));
  const result = await app.send("RESOLVE_MEDIA");
  assert.equal(result.ok, true);
  assert.equal(result.data.pictures.length, 1);
  assert.match(result.data.pictures[0].url, /AAA/);
});

test("X 播放器在 iframe 内未触发右键时用指针停留的帖子定位", async () => {
  const card = buildCard({ video: true });
  const app = loadX({ children: [card], posts: { [POST_ID]: rawPost({ video: true }) } });
  app.pointermove(card.querySelector("video"));
  const result = await app.send("RESOLVE_MEDIA");
  assert.equal(result.ok, true);
  assert.equal(result.data.videos.length, 1);
});

test("X 帖子确认存在但没有媒体时单独提示", async () => {
  const card = buildCard({});
  const app = loadX({ children: [card], posts: { [POST_ID]: rawPost({ photos: [] }) } });
  app.contextmenu(card.querySelector("time"));
  const result = await app.send("RESOLVE_MEDIA");
  assert.equal(result.ok, false);
  assert.match(result.error, /没有图片或视频/);
});

test("X 接口与页面都没有媒体数据时提示刷新页面", async () => {
  const card = buildCard({});
  const app = loadX({ children: [card], posts: {} });
  app.contextmenu(card.querySelector("time"));
  const result = await app.send("RESOLVE_MEDIA");
  assert.equal(result.ok, false);
  assert.match(result.error, /刷新页面/);
});
