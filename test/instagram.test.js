const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

/* Minimal DOM good enough for the selectors instagram.js uses. */
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
    const value = String(raw).replace(/^"(.*)"$/, "$1").replace(/^'(.*)'$/, "$1");
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
  get srcset() { return this.getAttribute("srcset") || ""; }
  get href() { return this.getAttribute("href") || ""; }
  get disabled() { return this.getAttribute("disabled") === "true"; }
  getBoundingClientRect() {
    return { width: Number(this.getAttribute("data-w") || 500), height: Number(this.getAttribute("data-h") || 500) };
  }
  get descendants() {
    const list = [];
    const walk = node => {
      for (const child of node.children) { list.push(child); walk(child); }
    };
    walk(this);
    return list;
  }
  querySelectorAll(selector) {
    const parts = selector.split(",").map(part => part.trim());
    return this.descendants.filter(element => parts.some(part => matchSelector(element, part)));
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  matches(selector) {
    return selector.split(",").map(part => part.trim()).some(part => matchSimple(this, part));
  }
  closest(selector) {
    const parts = selector.split(",").map(part => part.trim());
    let node = this;
    while (node) {
      if (parts.some(part => matchSelector(node, part))) return node;
      node = node.parentElement;
    }
    return null;
  }
}

const el = (tag, attrs = {}, children = []) => new Element(tag, attrs, children);

function photo(name, attrs = {}) {
  return el("img", { src: `https://scontent.cdninstagram.com/${name}.webp`, ...attrs });
}

/* One feed post: image linked to its permalink plus an author link. */
function postCard({ id = "ABC", author = "author", photos = ["page"], video = false, href = null } = {}) {
  const article = el("article", { "data-testid": "post" });
  const link = el("a", { href: href || `https://www.instagram.com/p/${id}/` });
  for (const name of photos) link.append(photo(name));
  if (video) link.append(el("video", { src: "https://scontent.cdninstagram.com/v.mp4" }));
  article.append(link);
  article.append(el("header", {}, [el("a", { href: `https://www.instagram.com/${author}/` })]));
  return article;
}

function loadInstagram({ fetch, children = [], url = "https://www.instagram.com/p/ABC/", pointElement = null, now } = {}) {
  const handlers = { contextmenu: null, pointermove: null };
  const clock = { now: now || 1_700_000_000_000 };
  const root = el("html", {}, children);
  const location = new URL(url);
  let runtimeListener;

  const document = {
    documentElement: root,
    body: root,
    addEventListener(type, callback) { handlers[type] = callback; },
    removeEventListener() {},
    querySelectorAll(selector) { return root.querySelectorAll(selector); },
    querySelector(selector) { return root.querySelector(selector); },
    getElementById() { return null; },
    createElement(tag) { return el(tag); },
    elementFromPoint() { return pointElement; }
  };

  const context = vm.createContext({ URL, AbortSignal, Element, fetch, document, location,
    setTimeout, clearTimeout,
    Date: { now: () => clock.now },
    chrome: { runtime: { onMessage: { addListener(callback) { runtimeListener = callback; } } } }
  });
  for (const name of ["instagram-lib.js", "video-lib.js", "instagram.js"]) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, "..", name), "utf8"), context);
  }

  return {
    clock,
    document,
    root,
    contextmenu(target, point = { x: 10, y: 10 }) {
      handlers.contextmenu({ target, clientX: point.x, clientY: point.y });
    },
    pointermove(target, point = { x: 10, y: 10 }) {
      handlers.pointermove({ target, clientX: point.x, clientY: point.y });
    },
    send: () => new Promise(resolve => runtimeListener({ type: "RESOLVE_MEDIA" }, {}, resolve))
  };
}

const mediaResponse = items => async () => ({ ok: true, json: async () => ({ items }) });

test("使用当前登录会话读取高清接口", async () => {
  const article = postCard({});
  const app = loadInstagram({ children: [article], fetch: mediaResponse([{ code: "ABC", media_type: 1,
    image_versions2: { candidates: [{ url: "https://scontent.cdninstagram.com/hd.jpg", width: 2048, height: 2048 }] } }]) });
  app.contextmenu(article.querySelector("img"));
  const result = await app.send();
  assert.equal(result.ok, true);
  assert.equal(result.data.qualitySource, "media");
  assert.equal(result.data.pictures[0].width, 2048);
});

test("接口被限流时回退页面图并提示画质降级", async () => {
  const article = postCard({});
  const app = loadInstagram({ children: [article], fetch: async () => ({ ok: false, status: 429 }) });
  app.contextmenu(article.querySelector("img"));
  const result = await app.send();
  assert.equal(result.ok, true);
  assert.equal(result.data.qualitySource, "page");
  assert.match(result.data.qualityWarning, /清晰度可能较低/);
  assert.equal(result.data.pictures[0].url, "https://scontent.cdninstagram.com/page.webp");
});

test("无 article 的详情页通过帖子链接定位并保存页面图", async () => {
  const wrapper = el("div", {}, [el("a", { href: "https://www.instagram.com/p/ABC/" }, [photo("detail")]),
    el("header", {}, [el("a", { href: "https://www.instagram.com/author/" })])]);
  const app = loadInstagram({ children: [wrapper], fetch: async () => ({ ok: false, status: 403 }) });
  app.contextmenu(wrapper.querySelector("img"));
  const result = await app.send();
  assert.equal(result.ok, true);
  assert.equal(result.data.postId, "ABC");
  assert.match(result.data.pictures[0].url, /detail\.webp$/);
});

test("详情页下方推荐帖不会被当作当前帖子", async () => {
  const current = postCard({ id: "ABC" });
  const other = postCard({ id: "XYZ" });
  const list = el("main", {}, [el("div", {}, [current]), el("div", {}, [other])]);
  const app = loadInstagram({ children: [list], fetch: async () => { throw new Error("不应请求接口"); } });
  app.contextmenu(current.querySelector("img"));
  const result = await app.send();
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.data.postId, "ABC");
});

test("视频请求读取 video_versions，不混入图片或页面播放流", async () => {
  const article = postCard({ photos: [], video: true });
  const app = loadInstagram({ children: [article], fetch: mediaResponse([{ code: "ABC", media_type: 2,
    video_versions: [{ url: "https://scontent.cdninstagram.com/video.mp4", width: 1920, height: 1080 }] }]) });
  app.contextmenu(article.querySelector("video"));
  const result = await app.send();
  assert.equal(result.ok, true);
  assert.equal(result.data.videos[0].width, 1920);
});

test("混合帖一次请求同时取得图片和视频", async () => {
  const article = postCard({});
  let requests = 0;
  const app = loadInstagram({ children: [article], fetch: async () => {
    requests++;
    return { ok: true, json: async () => ({ items: [{ code: "ABC", carousel_media: [
      { media_type: 1, image_versions2: { candidates: [{ url: "https://scontent.cdninstagram.com/photo.jpg", width: 1440, height: 960 }] } },
      { media_type: 2, image_versions2: { candidates: [{ url: "https://scontent.cdninstagram.com/cover.jpg", width: 1440, height: 960 }] },
        video_versions: [{ url: "https://scontent.cdninstagram.com/video.mp4", width: 1920, height: 1080 }] }
    ] }] }) };
  } });
  app.contextmenu(article.querySelector("img"));
  const result = await app.send();
  assert.equal(result.ok, true);
  assert.equal(requests, 1);
  assert.equal(result.data.pictures.length, 1);
  assert.equal(result.data.videos.length, 1);
});

test("右键后地址栏多出 img_index 参数仍能定位", async () => {
  const article = postCard({});
  const app = loadInstagram({ children: [article], url: "https://www.instagram.com/p/ABC/?img_index=2",
    fetch: async () => ({ ok: false, status: 403 }) });
  app.contextmenu(article.querySelector("img"));
  const result = await app.send();
  assert.equal(result.ok, true);
  assert.equal(result.data.postId, "ABC");
});

test("卡片被页面重渲染后仍按记录的帖子继续", async () => {
  const article = postCard({});
  const app = loadInstagram({ children: [article], fetch: mediaResponse([{ code: "ABC", media_type: 1,
    image_versions2: { candidates: [{ url: "https://scontent.cdninstagram.com/hd.jpg", width: 1080, height: 1080 }] } }]) });
  app.contextmenu(article.querySelector("img"));
  article.isConnected = false;
  const result = await app.send();
  assert.equal(result.ok, true);
  assert.equal(result.data.postId, "ABC");
});

test("右键两分钟后仍能下载，超过五分钟后在信息流中明确提示重试", async () => {
  const article = postCard({});
  const app = loadInstagram({ children: [article], url: "https://www.instagram.com/",
    fetch: mediaResponse([{ code: "ABC", media_type: 1,
      image_versions2: { candidates: [{ url: "https://scontent.cdninstagram.com/hd.jpg", width: 1080, height: 1080 }] } }]) });
  app.contextmenu(article.querySelector("img"));
  app.clock.now += 2 * 60 * 1000;
  assert.equal((await app.send()).ok, true);

  const stale = loadInstagram({ children: [postCard({}), postCard({ id: "XYZ" })], url: "https://www.instagram.com/",
    fetch: async () => ({ ok: false, status: 403 }) });
  const card = stale.root.querySelector("article");
  stale.contextmenu(card.querySelector("img"));
  stale.clock.now += 11 * 60 * 1000;
  const expired = await stale.send();
  assert.equal(expired.ok, false);
  assert.match(expired.error, /未找到右键所在的 Instagram 帖子/);
});

test("独立图片查看器没有帖子卡片时按指针停留与地址定位", async () => {
  const article = postCard({});
  const viewer = el("div", { role: "dialog" }, [photo("viewer")]);
  const app = loadInstagram({ children: [article, viewer],
    fetch: async () => ({ ok: false, status: 403 }) });
  app.pointermove(article.querySelector("img"));
  app.contextmenu(viewer.querySelector("img"));
  const result = await app.send();
  assert.equal(result.ok, true);
  assert.equal(result.data.postId, "ABC");
});

test("空白处右键不会沿用上一篇帖子", async () => {
  const article = postCard({});
  const blank = el("div", {}, [el("span")]);
  const app = loadInstagram({ children: [article, blank], url: "https://www.instagram.com/",
    fetch: async () => ({ ok: false, status: 403 }) });
  app.contextmenu(article.querySelector("img"));
  app.contextmenu(blank.querySelector("span"));
  const result = await app.send();
  assert.equal(result.ok, false);
  assert.match(result.error, /未找到右键所在的 Instagram 帖子/);
});

test("接口失败且页面有视频时，图片帖仍先保存页面图，不误报视频错误", async () => {
  const article = postCard({});
  // The page also plays a recommendation video; that must not turn a photo post
  // into "cannot fetch the highest-quality video".
  article.append(el("div", { "data-w": "400", "data-h": "300" }, [el("video", { src: "https://scontent.cdninstagram.com/other.mp4" })]));
  const app = loadInstagram({ children: [article], fetch: async () => ({ ok: false, status: 401 }) });
  app.contextmenu(article.querySelector("img"));
  const result = await app.send();
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.data.qualitySource, "page");
  assert.equal(result.data.pictures.length, 1);
  assert.match(result.data.qualityWarning, /无法确认是否遗漏视频/);
});

test("接口失败且页面没有图片时，视频帖提示无法获取最高规格视频", async () => {
  const article = postCard({ photos: [], video: true });
  const app = loadInstagram({ children: [article], fetch: async () => ({ ok: false, status: 401 }) });
  app.contextmenu(article.querySelector("video"));
  const result = await app.send();
  assert.equal(result.ok, false);
  assert.match(result.error, /无法获取最高规格视频/);
});

test("作者昵称可从 /<user>/p/<id>/ 链接补齐", async () => {
  const wrapper = el("div", {}, [el("a", { href: "https://www.instagram.com/gengeller/p/ABC/" }, [photo("detail")])]);
  const app = loadInstagram({ children: [wrapper], url: "https://www.instagram.com/gengeller/p/ABC/",
    fetch: async () => ({ ok: false, status: 403 }) });
  app.contextmenu(wrapper.querySelector("img"));
  const result = await app.send();
  assert.equal(result.ok, true);
  assert.equal(result.data.author, "gengeller");
});

test("接口失败且页面没有卡片时提示刷新页面", async () => {
  const app = loadInstagram({ children: [], url: "https://www.instagram.com/p/ABC/",
    fetch: async () => ({ ok: false, status: 500 }) });
  app.contextmenu(el("div"));
  const result = await app.send();
  assert.equal(result.ok, false);
  assert.match(result.error, /刷新页面/);
});
