const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

function loadBackground(pictures = [1, 2, 3, 4].map(number => ({ url: `https://wx1.sinaimg.cn/large/${number}.jpg` })), blockedUrl = null, webp = false, videoData = null, downloadMime = "video/mp4") {
  const files = name => fs.readFileSync(path.join(__dirname, "..", name), "utf8");
  const listeners = {};
  const stored = {};
  const started = [];
  const messages = [];
  const menus = [];
  let sessionRules = [];
  let offscreenOpen = false;
  const blobs = new Set();
  let nextId = 1;
  const chrome = {
    storage: { local: {
      async get(key) { return { [key]: stored[key] }; },
      async set(values) { Object.assign(stored, structuredClone(values)); }
    } },
    action: { async setBadgeText() {}, async setBadgeBackgroundColor() {} },
    tabs: { async sendMessage(tabId, message) {
      messages.push(message);
      if (message.type === "RESOLVE_WEIBO_VIDEOS" || message.type === "RESOLVE_INSTAGRAM_VIDEOS") {
        return { ok: true, data: { postId: "post1", author: "博主", userId: "42", missing: 0, videos: videoData } };
      }
      if (message.type === "RESOLVE_POST" || message.type === "RESOLVE_INSTAGRAM_POST") return { ok: true, data: {
        postId: "post1", author: "博主", userId: "42", missing: 0,
        pictures
      } };
    } },
    downloads: {
      async download(options) { if (!videoData) assert.match(options.url, /^blob:chrome-extension:/); started.push(options); return nextId++; },
      async search() { return [{ mime: videoData ? downloadMime : "image/jpeg" }]; },
      async removeFile() {},
      onChanged: { addListener(callback) { listeners.downloadChanged = callback; } }
    },
    declarativeNetRequest: {
      async getSessionRules() { return sessionRules; },
      async updateSessionRules({ removeRuleIds, addRules }) {
        sessionRules = sessionRules.filter(rule => !removeRuleIds.includes(rule.id)).concat(addRules);
      }
    },
    contextMenus: {
      async removeAll() {}, create(menu) { menus.push(menu); },
      onClicked: { addListener(callback) { listeners.menuClicked = callback; } }
    },
    runtime: {
      getURL(name) { return `chrome-extension://test/${name}`; },
      async getContexts() { return offscreenOpen ? [{}] : []; },
      async sendMessage(message) {
        if (message.type === "FETCH_IMAGE") {
          assert.equal(sessionRules.length, pictures.reduce((count, picture) => count + 1 + Number(Boolean(picture.liveUrl)), 0));
          if (message.url === blockedUrl) return { ok: false, blocked: true, error: "微博已屏蔽这张图片" };
          blobs.add(message.token);
          return { ok: true, blobUrl: `blob:chrome-extension://test/${message.token}`,
            extension: webp ? message.kind === "png" ? ".png" : ".webp" : undefined };
        }
        if (message.type === "RELEASE_IMAGE") {
          blobs.delete(message.token);
          return { ok: true };
        }
      },
      onInstalled: { addListener(callback) { listeners.installed = callback; } },
      onStartup: { addListener(callback) { listeners.startup = callback; } }
    },
    offscreen: {
      async createDocument() { offscreenOpen = true; },
      async closeDocument() { offscreenOpen = false; }
    }
  };
  const context = vm.createContext({ chrome, URL, crypto: { randomUUID: () => "job1" }, console });
  context.importScripts = (...names) => names.forEach(name => vm.runInContext(files(name), context));
  vm.runInContext(files("background.js"), context);
  return { context, listeners, stored, started, messages, menus, getSessionRules: () => sessionRules, getBlobs: () => blobs, isOffscreenOpen: () => offscreenOpen };
}

test("一次只启动三张图片，完成后补位并汇总结果", async () => {
  const app = loadBackground();
  app.listeners.menuClicked({ menuItemId: "download-weibo-originals" }, { id: 7 });
  await vm.runInContext("operation", app.context);
  assert.equal(app.started.length, 3);
  assert.equal(app.getBlobs().size, 3);
  assert.equal(app.getSessionRules().length, 4);
  assert.equal(app.getSessionRules()[0].action.requestHeaders[0].value, "https://weibo.com/");
  assert.equal(app.getSessionRules()[0].condition.urlFilter, "|https://wx1.sinaimg.cn/large/1.jpg|");
  assert.equal(app.stored.job.status, "running");
  assert.match(app.started[0].filename, /^微博原图\/博主_42\/\d{8}_post1_01\.jpg$/);

  app.listeners.downloadChanged({ id: 1, state: { current: "complete" } });
  await vm.runInContext("operation", app.context);
  assert.equal(app.started.length, 4);

  for (const id of [2, 3, 4]) {
    app.listeners.downloadChanged({ id, state: { current: "complete" } });
    await vm.runInContext("operation", app.context);
  }
  assert.equal(app.stored.job.status, "done");
  assert.equal(app.getSessionRules().length, 0);
  assert.equal(app.getBlobs().size, 0);
  assert.equal(app.isOffscreenOpen(), false);
  assert.equal(app.stored.job.images.filter(image => image.state === "complete").length, 4);
  assert.ok(app.messages.some(message => message.type === "TOAST" && message.text.includes("成功 4 个文件")));
});

test("Live Photo 的 JPG 和 MOV 使用相同序号分别下载", async () => {
  const video = "https://video.weibo.com/media/play?livephoto=https%3A%2F%2Flivephoto.us.sinaimg.cn%2Fclip.mov";
  const app = loadBackground([{ url: "https://wx1.sinaimg.cn/large/a.jpg", liveUrl: video }]);
  app.listeners.menuClicked({ menuItemId: "download-weibo-originals" }, { id: 7 });
  await vm.runInContext("operation", app.context);
  assert.equal(app.started.length, 2);
  assert.match(app.started[0].filename, /_01\.jpg$/);
  assert.match(app.started[1].filename, /_01\.mov$/);
  assert.equal(app.getSessionRules().length, 2);
  for (const id of [1, 2]) {
    app.listeners.downloadChanged({ id, state: { current: "complete" } });
    await vm.runInContext("operation", app.context);
  }
  assert.equal(app.stored.job.status, "done");
  assert.equal(app.stored.job.images.filter(image => image.state === "complete").length, 2);
});

test("屏蔽占位图直接跳过，其余图片照常下载", async () => {
  const blockedUrl = "https://wx2.sinaimg.cn/large/blocked.jpg";
  const app = loadBackground([
    { url: blockedUrl },
    { url: "https://wx1.sinaimg.cn/large/normal.jpg" }
  ], blockedUrl);
  app.listeners.menuClicked({ menuItemId: "download-weibo-originals" }, { id: 7 });
  await vm.runInContext("operation", app.context);
  assert.equal(app.stored.job.images[0].state, "skipped");
  assert.equal(app.stored.job.images[0].attempts, 1);
  assert.equal(app.started.length, 1);
  assert.match(app.started[0].filename, /_02\.jpg$/);
  app.listeners.downloadChanged({ id: 1, state: { current: "complete" } });
  await vm.runInContext("operation", app.context);
  assert.equal(app.stored.job.status, "done");
  assert.ok(app.messages.some(message => message.type === "TOAST" && message.text.includes("跳过 1 张屏蔽图")));
});

test("Instagram 使用独立菜单、目录和来源信息", async () => {
  const app = loadBackground([{ url: "https://scontent.cdninstagram.com/photo.jpg" }]);
  app.listeners.menuClicked({ menuItemId: "download-instagram-images" }, { id: 7 });
  await vm.runInContext("operation", app.context);
  assert.ok(app.messages.some(message => message.type === "RESOLVE_INSTAGRAM_POST"));
  assert.equal(app.getSessionRules()[0].action.requestHeaders[0].value, "https://www.instagram.com/");
  assert.match(app.started[0].filename, /^Instagram图片\/博主\/\d{8}_post1_01\.jpg$/);
  app.listeners.downloadChanged({ id: 1, state: { current: "complete" } });
  await vm.runInContext("operation", app.context);
  assert.equal(app.stored.job.status, "done");
});

test("Instagram WebP 同时保存同序号 PNG，两个下载使用独立 Blob 并分别完成", async () => {
  const app = loadBackground([{ url: "https://scontent.cdninstagram.com/photo.webp" }], null, true);
  app.listeners.menuClicked({ menuItemId: "download-instagram-images" }, { id: 7 });
  await vm.runInContext("operation", app.context);
  assert.equal(app.started.length, 2);
  assert.match(app.started[0].filename, /_01\.webp$/);
  assert.match(app.started[1].filename, /_01\.png$/);
  assert.notEqual(app.started[0].url, app.started[1].url);
  for (const id of [1, 2]) {
    app.listeners.downloadChanged({ id, state: { current: "complete" } });
    await vm.runInContext("operation", app.context);
  }
  assert.equal(app.stored.job.status, "done");
  assert.equal(app.stored.job.images.filter(image => image.state === "complete").length, 2);
  assert.equal(app.getBlobs().size, 0);
});

test("视频菜单在播放器右键可用，使用直链下载、独立视频目录和站点来源", async () => {
  for (const site of ["weibo", "instagram"]) {
    const url = site === "weibo" ? "https://f.video.weibocdn.com/4k.mp4" : "https://scontent.cdninstagram.com/4k.mp4";
    const app = loadBackground([], null, false, [{ url, width: 3840, height: 2160 }]);
    app.listeners.installed();
    await vm.runInContext("operation", app.context);
    assert.ok(app.menus.find(menu => menu.id === `download-${site}-videos`).contexts.includes("video"));
    app.listeners.menuClicked({ menuItemId: `download-${site}-videos` }, { id: 7 });
    await vm.runInContext("operation", app.context);
    assert.equal(app.started[0].url, url);
    assert.match(app.started[0].filename, site === "weibo" ? /^微博视频\/博主_42\/.*_01.mp4$/ : /^Instagram视频\/博主\/.*_01.mp4$/);
    assert.equal(app.isOffscreenOpen(), false);
    assert.equal(app.stored.job.images[0].width, 3840);
    assert.equal(app.getSessionRules()[0].action.requestHeaders[0].value, site === "weibo" ? "https://weibo.com/" : "https://www.instagram.com/");
    app.listeners.downloadChanged({ id: 1, state: { current: "complete" } });
    await vm.runInContext("operation", app.context);
    assert.equal(app.stored.job.status, "done");
    assert.equal(app.stored.job.images[0].state, "complete");
  }
});

test("视频下载拒绝把图片、音频或分片清单当作成功 MP4", async () => {
  for (const mime of ["image/jpeg", "audio/mp4", "application/vnd.apple.mpegurl", "text/html"]) {
    const app = loadBackground([], null, false, [{ url: "https://f.video.weibocdn.com/file.mp4", width: 1920, height: 1080 }], mime);
    app.listeners.menuClicked({ menuItemId: "download-weibo-videos" }, { id: 7 });
    await vm.runInContext("operation", app.context);
    app.listeners.downloadChanged({ id: 1, state: { current: "complete" } });
    await vm.runInContext("operation", app.context);
    assert.equal(app.stored.job.images[0].state, "failed");
    assert.match(app.stored.job.images[0].error, /完整 MP4/);
  }
});
