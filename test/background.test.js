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
  const downloadItems = new Map();
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
      if (message.type === "RESOLVE_MEDIA") return { ok: true, data: {
        postId: "post1", author: "博主", userId: "42", missing: 0,
        pictures, videos: videoData || []
      } };
    } },
    downloads: {
      async download(options) {
        if (!videoData) assert.match(options.url, /^blob:chrome-extension:/);
        started.push(options);
        const id = nextId++;
        downloadItems.set(id, { id, state: "in_progress", exists: true, byExtensionId: "test-extension",
          filename: `C:\\Downloads\\${options.filename.replaceAll("/", "\\")}`,
          mime: /\.mp4$/.test(options.filename) ? downloadMime : "image/jpeg" });
        return id;
      },
      async search(query) {
        return [...downloadItems.values()].filter(item => (query.id == null || item.id === query.id) &&
          (!query.state || item.state === query.state) && (query.exists == null || item.exists === query.exists) &&
          (!query.filenameRegex || new RegExp(query.filenameRegex).test(item.filename)));
      },
      async removeFile(id) { downloadItems.get(id).exists = false; },
      onChanged: { addListener(callback) { listeners.downloadChanged = delta => {
        if (delta.state && downloadItems.has(delta.id)) downloadItems.get(delta.id).state = delta.state.current;
        callback(delta);
      }; } }
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
      id: "test-extension",
      getURL(name) { return `chrome-extension://test/${name}`; },
      async getContexts() { return offscreenOpen ? [{}] : []; },
      async sendMessage(message) {
        if (message.type === "FETCH_IMAGE") {
          assert.equal(sessionRules.length, pictures.reduce((count, picture) => count + 1 + Number(Boolean(picture.liveUrl)), 0) + (videoData?.length || 0));
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
  return { context, listeners, stored, started, messages, menus, downloadItems, getSessionRules: () => sessionRules, getBlobs: () => blobs, isOffscreenOpen: () => offscreenOpen };
}

test("一次只启动三张图片，完成后补位并汇总结果", async () => {
  const app = loadBackground();
  app.listeners.menuClicked({ menuItemId: "download-post-media" }, { id: 7, url: "https://weibo.com/123/post1" });
  await vm.runInContext("operation", app.context);
  assert.equal(app.started.length, 3);
  assert.equal(app.getBlobs().size, 3);
  assert.equal(app.getSessionRules().length, 4);
  assert.equal(app.getSessionRules()[0].action.requestHeaders[0].value, "https://weibo.com/");
  assert.equal(app.getSessionRules()[0].condition.urlFilter, "|https://wx1.sinaimg.cn/large/1.jpg|");
  assert.equal(app.stored.job.status, "running");
  assert.match(app.started[0].filename, /^微博\/图片\/博主\/post1\/\d{8}_post1_01\.jpg$/);

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
  app.listeners.menuClicked({ menuItemId: "download-post-media" }, { id: 7, url: "https://weibo.com/123/post1" });
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
  app.listeners.menuClicked({ menuItemId: "download-post-media" }, { id: 7, url: "https://weibo.com/123/post1" });
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

test("统一菜单自动识别 Instagram，使用独立目录和来源信息", async () => {
  const app = loadBackground([{ url: "https://scontent.cdninstagram.com/photo.jpg" }]);
  app.listeners.menuClicked({ menuItemId: "download-post-media" }, { id: 7, url: "https://www.instagram.com/p/ABC/" });
  await vm.runInContext("operation", app.context);
  assert.ok(app.messages.some(message => message.type === "RESOLVE_MEDIA"));
  assert.equal(app.getSessionRules()[0].action.requestHeaders[0].value, "https://www.instagram.com/");
  assert.match(app.started[0].filename, /^Instagram\/图片\/博主\/post1\/\d{8}_post1_01\.jpg$/);
  app.listeners.downloadChanged({ id: 1, state: { current: "complete" } });
  await vm.runInContext("operation", app.context);
  assert.equal(app.stored.job.status, "done");
});

test("Instagram WebP 同时保存同序号 PNG，两个下载使用独立 Blob 并分别完成", async () => {
  const app = loadBackground([{ url: "https://scontent.cdninstagram.com/photo.webp" }], null, true);
  app.listeners.menuClicked({ menuItemId: "download-post-media" }, { id: 7, url: "https://www.instagram.com/p/ABC/" });
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

test("播放器统一菜单使用对应视频管线、独立目录和站点来源", async () => {
  for (const site of ["weibo", "instagram", "x"]) {
    const url = site === "x" ? "https://video.twimg.com/vid/3840x2160/file.mp4" : site === "weibo" ? "https://f.video.weibocdn.com/4k.mp4" : "https://scontent.cdninstagram.com/4k.mp4";
    const app = loadBackground([], null, false, [{ url, width: 3840, height: 2160 }]);
    app.listeners.installed();
    await vm.runInContext("operation", app.context);
    assert.equal(app.menus.length, 1);
    assert.ok(app.menus[0].contexts.includes("video"));
    const pageUrl = site === "x" ? "https://x.com/author/status/123" : site === "instagram" ? "https://www.instagram.com/p/ABC/" : "https://weibo.com/123/post1";
    app.listeners.menuClicked({ menuItemId: "download-post-media" }, { id: 7, url: pageUrl });
    await vm.runInContext("operation", app.context);
    if (site === "weibo") assert.match(app.started[0].url, /^blob:chrome-extension:/);
    else assert.equal(app.started[0].url, url);
    assert.match(app.started[0].filename, site === "x" ? /^X\/视频\/博主\/post1\/.*_01.mp4$/ : site === "weibo" ? /^微博\/视频\/博主\/post1\/.*_01.mp4$/ : /^Instagram\/视频\/博主\/post1\/.*_01.mp4$/);
    assert.equal(app.isOffscreenOpen(), site === "weibo");
    assert.equal(app.stored.job.images[0].width, 3840);
    assert.equal(app.getSessionRules()[0].action.requestHeaders[0].value, site === "x" ? "https://x.com/" : site === "weibo" ? "https://weibo.com/" : "https://www.instagram.com/");
    app.listeners.downloadChanged({ id: 1, state: { current: "complete" } });
    await vm.runInContext("operation", app.context);
    assert.equal(app.stored.job.status, "done");
    assert.equal(app.stored.job.images[0].state, "complete");
  }
});

test("视频下载拒绝把图片、音频或分片清单当作成功 MP4", async () => {
  for (const mime of ["image/jpeg", "audio/mp4", "application/vnd.apple.mpegurl", "text/html"]) {
    const app = loadBackground([], null, false, [{ url: "https://f.video.weibocdn.com/file.mp4", width: 1920, height: 1080 }], mime);
    app.listeners.menuClicked({ menuItemId: "download-post-media" }, { id: 7, url: "https://weibo.com/123/post1" });
    await vm.runInContext("operation", app.context);
    app.listeners.downloadChanged({ id: 1, state: { current: "complete" } });
    await vm.runInContext("operation", app.context);
    assert.equal(app.stored.job.images[0].state, "failed");
    assert.match(app.stored.job.images[0].error, /完整 MP4/);
  }
});

test("X 图片菜单复用 WebP + PNG 队列，独立作者目录和来源", async () => {
  const app = loadBackground([{ url: "https://pbs.twimg.com/media/photo?format=webp&name=orig" }], null, true);
  app.listeners.menuClicked({ menuItemId: "download-post-media" }, { id: 7, url: "https://x.com/author/status/123" });
  await vm.runInContext("operation", app.context);
  assert.ok(app.messages.some(message => message.type === "RESOLVE_MEDIA"));
  assert.equal(app.started.length, 2);
  assert.match(app.started[0].filename, /^X\/图片\/博主\/post1\/.*_01.webp$/);
  assert.match(app.started[1].filename, /^X\/图片\/博主\/post1\/.*_01.png$/);
  assert.equal(app.getSessionRules()[0].action.requestHeaders[0].value, "https://x.com/");
});

test("统一菜单一次下载混合帖图片及视频，按文件类型选择目录", async () => {
  const app = loadBackground([{ url: "https://scontent.cdninstagram.com/photo.webp" }], null, true,
    [{ url: "https://scontent.cdninstagram.com/video.mp4", width: 1920, height: 1080 }]);
  app.listeners.menuClicked({ menuItemId: "download-post-media" }, { id: 7, url: "https://www.instagram.com/p/ABC/" });
  await vm.runInContext("operation", app.context);
  assert.equal(app.messages.filter(message => message.type === "RESOLVE_MEDIA").length, 1);
  assert.equal(app.started.length, 3);
  assert.match(app.started[0].filename, /^Instagram\/图片\/博主\/post1\/.*_01.webp$/);
  assert.match(app.started[1].filename, /^Instagram\/图片\/博主\/post1\/.*_01.png$/);
  assert.match(app.started[2].filename, /^Instagram\/视频\/博主\/post1\/.*_02.mp4$/);
  for (const id of [1, 2, 3]) {
    app.listeners.downloadChanged({ id, state: { current: "complete" } });
    await vm.runInContext("operation", app.context);
  }
  assert.equal(app.stored.job.status, "done");
  assert.equal(app.stored.job.images.filter(item => item.state === "complete").length, 3);
});

test("唯一右键菜单没有子菜单，忽略旧菜单及不支持站点", async () => {
  const app = loadBackground();
  app.listeners.installed();
  await vm.runInContext("operation", app.context);
  assert.equal(app.menus.length, 1);
  assert.equal(app.menus[0].parentId, undefined);
  app.listeners.menuClicked({ menuItemId: "download-post-media" }, { id: 7, url: "https://example.com/" });
  app.listeners.menuClicked({ menuItemId: "download-weibo-videos" }, { id: 7, url: "https://weibo.com/123/post1" });
  await vm.runInContext("operation", app.context);
  assert.equal(app.started.length, 0);
});

test("微博视频逐个获取及保存，释放前不同时缓存多个大视频", async () => {
  const app = loadBackground([], null, false, [1, 2].map(id => ({ url: `https://f.video.weibocdn.com/${id}.mp4`, width: 1920, height: 1080 })));
  app.listeners.menuClicked({ menuItemId: "download-post-media" }, { id: 7, url: "https://weibo.com/42/ABC" });
  await vm.runInContext("operation", app.context);
  assert.equal(app.started.length, 1);
  assert.equal(app.getBlobs().size, 1);
  app.listeners.downloadChanged({ id: 1, state: { current: "complete" } });
  await vm.runInContext("operation", app.context);
  assert.equal(app.started.length, 2);
  assert.equal(app.getBlobs().size, 1);
  app.listeners.downloadChanged({ id: 2, state: { current: "complete" } });
  await vm.runInContext("operation", app.context);
  assert.equal(app.stored.job.status, "done");
  assert.equal(app.getBlobs().size, 0);
});

test("成功文件仍存在时跳过重复下载，删除后允许重新保存", async () => {
  const app = loadBackground([{ url: "https://wx1.sinaimg.cn/large/a.jpg" }]);
  const start = async () => {
    app.listeners.menuClicked({ menuItemId: "download-post-media" }, { id: 7, url: "https://weibo.com/42/ABC" });
    await vm.runInContext("operation", app.context);
  };
  await start();
  app.listeners.downloadChanged({ id: 1, state: { current: "complete" } });
  await vm.runInContext("operation", app.context);
  await start();
  assert.equal(app.started.length, 1);
  assert.equal(app.stored.job.images[0].state, "existing");
  assert.ok(app.messages.some(message => message.text?.includes("已存在 1 个文件跳过")));
  app.downloadItems.get(1).exists = false;
  await start();
  assert.equal(app.started.length, 2);
});

test("签名参数变化不重复下载，但更高规格视频不被旧记录拦截", async () => {
  const videos = [{ url: "https://scontent.cdninstagram.com/video.mp4?Expires=old&ssig=old", width: 1920, height: 1080 }];
  const app = loadBackground([], null, false, videos);
  const start = async () => {
    app.listeners.menuClicked({ menuItemId: "download-post-media" }, { id: 7, url: "https://www.instagram.com/p/ABC/" });
    await vm.runInContext("operation", app.context);
  };
  await start();
  app.listeners.downloadChanged({ id: 1, state: { current: "complete" } });
  await vm.runInContext("operation", app.context);
  videos[0].url = "https://scontent.cdninstagram.com/video.mp4?Expires=new&ssig=new";
  await start();
  assert.equal(app.started.length, 1);
  videos[0].width = 3840;
  videos[0].height = 2160;
  await start();
  assert.equal(app.started.length, 2);
});

test("WebP 已存在但 PNG 缺失时只补下载 PNG，不重复原文件", async () => {
  const app = loadBackground([{ url: "https://scontent.cdninstagram.com/photo.webp" }], null, true);
  const start = async () => {
    app.listeners.menuClicked({ menuItemId: "download-post-media" }, { id: 7, url: "https://www.instagram.com/p/ABC/" });
    await vm.runInContext("operation", app.context);
  };
  await start();
  for (const id of [1, 2]) {
    app.listeners.downloadChanged({ id, state: { current: "complete" } });
    await vm.runInContext("operation", app.context);
  }
  app.downloadItems.get(2).exists = false;
  await start();
  assert.equal(app.started.length, 3);
  assert.equal(app.stored.job.images[0].state, "existing");
  assert.match(app.started[2].filename, /\.png$/);
});

test("升级前最近成功任务可通过下载历史补建去重记录", async () => {
  const app = loadBackground([], null, false, [{ url: "https://f.video.weibocdn.com/video.mp4", width: 1920, height: 1080 }]);
  const start = async () => {
    app.listeners.menuClicked({ menuItemId: "download-post-media" }, { id: 7, url: "https://weibo.com/42/ABC" });
    await vm.runInContext("operation", app.context);
  };
  await start();
  app.listeners.downloadChanged({ id: 1, state: { current: "complete" } });
  await vm.runInContext("operation", app.context);
  delete app.stored.completedMedia;
  delete app.stored.job.images[0].savedDownloadId;
  await start();
  assert.equal(app.started.length, 1);
  assert.equal(app.stored.job.images[0].state, "existing");
});

test("失败的视频不写入成功记录，再次点击会重新尝试", async () => {
  const app = loadBackground([], null, false, [{ url: "https://f.video.weibocdn.com/video.mp4", width: 1920, height: 1080 }], "text/html");
  const start = async () => {
    app.listeners.menuClicked({ menuItemId: "download-post-media" }, { id: 7, url: "https://weibo.com/42/ABC" });
    await vm.runInContext("operation", app.context);
  };
  await start();
  app.listeners.downloadChanged({ id: 1, state: { current: "complete" } });
  await vm.runInContext("operation", app.context);
  assert.equal(app.stored.job.images[0].state, "failed");
  await start();
  assert.equal(app.started.length, 2);
});

test("三站固定按平台、媒体类型、博主及帖子建目录，旧设置不改变新结构", () => {
  const app = loadBackground();
  const filename = (site, kind, postId = "123") => vm.runInContext(`makeFilename({site:"${site}",author:"博主/名称",postId:"${postId}",createdAt:0},
    {kind:"${kind}",index:0,url:"https://wx1.sinaimg.cn/large/a.jpg"},
    {groupByAuthor:false,downloadSubfolder:"旧图片目录",weiboVideoSubfolder:"旧视频目录"})`, app.context);
  for (const [site, name] of [["weibo", "微博"], ["instagram", "Instagram"], ["x", "X"]]) {
    for (const kind of ["image", "png", "live", "video"]) {
      assert.ok(filename(site, kind).startsWith(`${name}/${kind === "video" ? "视频" : "图片"}/博主_名称/123/`));
      assert.ok(filename(site, kind, "456/789").startsWith(`${name}/${kind === "video" ? "视频" : "图片"}/博主_名称/456_789/`));
    }
  }
});
