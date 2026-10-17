importScripts("lib.js", "instagram-lib.js", "video-lib.js", "x-lib.js");

const MENU_ID = "download-post-media";
const DEFAULT_SETTINGS = { instagramSubfolder: "Instagram图片", instagramVideoSubfolder: "Instagram视频",
  xSubfolder: "X图片", xVideoSubfolder: "X视频", groupByAuthor: true };
let operation = Promise.resolve();
let creatingOffscreen = null;

function runSerial(work) {
  operation = operation.then(work).catch(error => console.error("微博原图下载：", error));
}

async function getJob() {
  return (await chrome.storage.local.get("job")).job || null;
}

async function showBadge(job) {
  const running = job?.status === "running";
  const failed = job?.images.filter(image => image.state === "failed").length || 0;
  const done = job?.images.filter(image => image.state === "complete").length || 0;
  const skipped = job?.images.filter(image => image.state === "skipped").length || 0;
  await chrome.action.setBadgeText({ text: running ? String(done) : failed ? "!" : skipped && !done ? "–" : job ? "✓" : "" });
  await chrome.action.setBadgeBackgroundColor({ color: failed ? "#c83b32" : "#288447" });
}

async function saveJob(job) {
  await chrome.storage.local.set({ job });
  await showBadge(job);
}

async function toast(tabId, text) {
  if (!tabId) return;
  try { await chrome.tabs.sendMessage(tabId, { type: "TOAST", text }); } catch { /* Tab may have closed. */ }
}

async function setImageReferrers(images, site = "weibo") {
  const existing = await chrome.declarativeNetRequest.getSessionRules();
  const urls = [...new Set(images.map(image => image.url))];
  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: existing.map(rule => rule.id),
    addRules: urls.map((url, index) => ({
      id: index + 1,
      priority: 1,
      action: {
        type: "modifyHeaders",
        requestHeaders: [{ header: "referer", operation: "set", value: site === "x" ? "https://x.com/" : site === "instagram" ? "https://www.instagram.com/" : "https://weibo.com/" }]
      },
      condition: { urlFilter: `|${url}|`, requestMethods: ["get"] }
    }))
  });
}

async function ensureOffscreen() {
  const url = chrome.runtime.getURL("offscreen.html");
  const contexts = await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"], documentUrls: [url] });
  if (contexts.length) return;
  if (!creatingOffscreen) {
    creatingOffscreen = chrome.offscreen.createDocument({
      url: "offscreen.html", reasons: ["BLOBS"],
      justification: "验证图片和微博视频，生成可下载文件"
    }).finally(() => { creatingOffscreen = null; });
  }
  await creatingOffscreen;
}

async function fetchImageBlob(image, token) {
  await ensureOffscreen();
  const response = await chrome.runtime.sendMessage({ target: "offscreen", type: "FETCH_IMAGE", url: image.url, kind: image.kind, site: image.site, token });
  if (!response?.ok) {
    const error = new Error(response?.error || "无法获取媒体文件");
    error.blocked = Boolean(response?.blocked);
    throw error;
  }
  image.extension = response.extension;
  return response.blobUrl;
}

async function releaseImageBlob(token) {
  if (!token) return;
  try { await chrome.runtime.sendMessage({ target: "offscreen", type: "RELEASE_IMAGE", token }); }
  catch { /* The offscreen document may already have closed. */ }
}

async function closeOffscreen() {
  const contexts = await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] });
  if (contexts.length) await chrome.offscreen.closeDocument();
}

function makeFilename(job, image, settings) {
  const parts = [];
  if (job.site === "weibo") {
    parts.push("微博", WeiboImages.safeSegment(job.author), image.kind === "video" ? "视频" : "图片");
  } else {
    const subfolder = WeiboImages.normalizeSubfolder(image.kind === "video"
      ? job.site === "x" ? settings.xVideoSubfolder : settings.instagramVideoSubfolder
      : job.site === "x" ? settings.xSubfolder : settings.instagramSubfolder);
    if (subfolder) parts.push(subfolder);
    if (settings.groupByAuthor) parts.push(WeiboImages.safeSegment(job.author));
  }
  const date = new Date(job.createdAt);
  const day = `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, "0")}${String(date.getDate()).padStart(2, "0")}`;
  const number = String(image.index + 1).padStart(2, "0");
  const postId = WeiboImages.safeSegment(job.postId, job.site === "instagram" ? "帖子" : "微博");
  parts.push(`${day}_${postId}_${number}${image.extension || WeiboImages.extensionFromUrl(image.url)}`);
  return parts.join("/");
}

function mediaKey(job, image) {
  const url = new URL(image.url);
  const quality = ["template", "label", "format", "name", "stp"].map(name => [name, url.searchParams.get(name)]);
  return JSON.stringify([job.site, job.postId, image.kind, url.pathname, quality,
    image.width || 0, image.height || 0, image.fps || 0, image.bitrate || 0]);
}

async function rememberDownload(job, image, id) {
  const { completedMedia = {} } = await chrome.storage.local.get("completedMedia");
  const key = mediaKey(job, image);
  delete completedMedia[key];
  completedMedia[key] = { id, extension: image.extension || WeiboImages.extensionFromUrl(image.url) };
  for (const oldKey of Object.keys(completedMedia).slice(0, -2000)) delete completedMedia[oldKey];
  await chrome.storage.local.set({ completedMedia });
  image.savedDownloadId = id;
}

async function existingDownload(job, image) {
  const { completedMedia = {} } = await chrome.storage.local.get("completedMedia");
  const record = completedMedia[mediaKey(job, image)];
  if (!record) return null;
  const [item] = await chrome.downloads.search({ id: record.id });
  return item?.state === "complete" && item.exists === true ? record : null;
}

async function importPreviousDownloads(previous, settings) {
  if (!previous) return;
  for (const image of previous.images.filter(item => item.state === "complete")) {
    let item;
    if (image.savedDownloadId != null) [item] = await chrome.downloads.search({ id: image.savedDownloadId });
    else {
      const filename = makeFilename(previous, image, settings).split("/").pop();
      const dot = filename.lastIndexOf(".");
      if (dot < 0) continue;
      const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const matches = await chrome.downloads.search({ state: "complete", exists: true,
        filenameRegex: `[/\\\\]${escape(filename.slice(0, dot))}(?: \\([0-9]+\\))?${escape(filename.slice(dot))}$` });
      item = matches.find(candidate => candidate.byExtensionId === chrome.runtime.id);
    }
    if (item?.state === "complete" && item.exists === true) await rememberDownload(previous, image, item.id);
  }
}

function queuePngCopy(job, image) {
  if (["instagram", "x"].includes(image.site) && image.kind === "image" && image.extension === ".webp" &&
    !job.images.some(item => item.index === image.index && item.kind === "png")) {
    job.images.splice(job.images.indexOf(image) + 1, 0, {
      index: image.index, kind: "png", url: image.url, site: image.site, width: image.width, height: image.height,
      state: "queued", attempts: 0, downloadId: null, error: ""
    });
  }
}

async function finishIfDone(job) {
  if (job.images.some(image => ["queued", "starting", "downloading"].includes(image.state))) return;
  job.status = "done";
  await saveJob(job);
  try { await setImageReferrers([]); } catch (error) { console.error("清理图片下载规则失败：", error); }
  try { await closeOffscreen(); } catch (error) { console.error("关闭图片处理页面失败：", error); }
  const done = job.images.filter(image => image.state === "complete").length;
  const skipped = job.images.filter(image => image.state === "skipped").length;
  const existing = job.images.filter(image => image.state === "existing").length;
  const failed = job.images.filter(image => image.state === "failed").length + job.missing;
  const reason = job.qualityWarning || job.images.find(image => image.state === "failed")?.error ||
    (job.imageMissing ? `${job.imageMissing} 个原图或 Live 地址未能解析，未开始下载` : "");
  await toast(job.tabId, `帖子媒体下载完成：成功 ${done} 个文件${existing ? `，已存在 ${existing} 个文件跳过` : ""}${skipped ? `，跳过 ${skipped} 张屏蔽图` : ""}，失败 ${failed} 个文件。${failed && reason ? `原因：${reason.slice(0, 140)}。` : ""}点击插件图标查看详情。`);
}

async function pump(job) {
  const { settings: savedSettings } = await chrome.storage.local.get("settings");
  const settings = { ...DEFAULT_SETTINGS, ...savedSettings };
  while (job.status === "running" && job.images.filter(image => image.state === "starting" || image.state === "downloading").length < 3) {
    const image = job.images.find(item => item.state === "queued" &&
      !(item.site === "weibo" && item.kind === "video" && job.images.some(active =>
        active.site === "weibo" && active.kind === "video" && ["starting", "downloading"].includes(active.state))));
    if (!image) break;
    image.state = "starting";
    image.attempts++;
    await saveJob(job);
    try {
      const existing = await existingDownload(job, image);
      if (existing) {
        image.state = "existing";
        image.extension = existing.extension;
        image.savedDownloadId = existing.id;
        queuePngCopy(job, image);
        await saveJob(job);
        continue;
      }
      const token = `${job.id}-${image.index}-${image.kind}-${image.attempts}`;
      let downloadUrl;
      if (image.kind === "video" && image.site !== "weibo") {
        downloadUrl = VideoDownloads.videoUrl(image.url, image.site);
        if (!downloadUrl) throw new Error("视频地址无效或为不支持的分片流");
        image.extension = ".mp4";
      } else {
        image.blobToken = token;
        downloadUrl = await fetchImageBlob(image, token);
      }
      const id = await chrome.downloads.download({
        url: downloadUrl,
        filename: makeFilename(job, image, settings),
        saveAs: false,
        conflictAction: "uniquify"
      });
      image.downloadId = id;
      image.state = "downloading";
      queuePngCopy(job, image);
    } catch (error) {
      await releaseImageBlob(image.blobToken);
      image.blobToken = null;
      image.error = error.message;
      image.state = error.blocked ? "skipped" : image.attempts < 2 ? "queued" : "failed";
    }
    await saveJob(job);
  }
  await finishIfDone(job);
}

async function startDownload(tab, site = "weibo") {
  const previous = await getJob();
  if (previous?.status === "running") {
    await toast(tab.id, "已有一篇帖子正在下载，请等待完成后再试。");
    return;
  }
  let response;
  try {
    response = await chrome.tabs.sendMessage(tab.id, { type: "RESOLVE_MEDIA" });
  } catch {
    await toast(tab.id, "无法读取当前页面，请刷新页面后重试。");
    return;
  }
  if (!response?.ok) {
    await toast(tab.id, response?.error || "无法定位这篇帖子。");
    return;
  }

  const data = response.data;
  const { settings: savedSettings } = await chrome.storage.local.get("settings");
  await importPreviousDownloads(previous, { ...DEFAULT_SETTINGS, ...savedSettings });
  const media = [...(data.pictures || []).map(picture => ({ ...picture, kind: "image" })),
    ...(data.videos || []).map(video => ({ ...video, kind: "video" }))];
  const images = media.flatMap((picture, index) => [
    { index, kind: picture.kind, url: picture.url, site, width: picture.width, height: picture.height,
      fps: picture.fps, bitrate: picture.bitrate },
    ...(picture.liveUrl ? [{ index, kind: "live", url: picture.liveUrl, site }] : [])
  ].map(file => ({ ...file, state: "queued", attempts: 0, downloadId: null, error: "" })));
  const job = {
    id: crypto.randomUUID(), tabId: tab.id, postId: data.postId, site, mediaType: "auto",
    author: data.author, userId: data.userId, createdAt: Date.now(),
    missing: data.missing, imageMissing: data.imageMissing, videoMissing: data.videoMissing, images, status: "running",
    qualitySource: data.qualitySource, qualityWarning: data.qualityWarning
  };
  await saveJob(job);
  await toast(tab.id, `已识别 ${data.pictures?.length || 0} 张图片、${data.videos?.length || 0} 个视频，开始下载。${job.missing ? `另有 ${job.missing} 个媒体文件不可用。` : ""}${job.qualityWarning || ""}`);
  try {
    await setImageReferrers(images, site);
  } catch (error) {
    for (const image of images) {
      image.state = "failed";
      image.error = `无法配置图片下载请求：${error.message}`;
    }
    await finishIfDone(job);
    return;
  }
  await pump(job);
}

async function handleDownloadChange(delta) {
  const state = delta.state?.current;
  if (state !== "complete" && state !== "interrupted") return;
  const job = await getJob();
  if (job?.status !== "running") return;
  const image = job.images.find(item => item.downloadId === delta.id && item.state === "downloading");
  if (!image) return;

  if (state === "complete") {
    const [item] = await chrome.downloads.search({ id: delta.id });
    if (/^(text\/html|application\/json)/i.test(item?.mime || "") ||
      (image.kind === "video" && !/^(video\/mp4|application\/octet-stream)(?:;|$)/i.test(item?.mime || ""))) {
      try { await chrome.downloads.removeFile(delta.id); } catch { /* May already be gone. */ }
      image.state = "failed";
      image.error = image.kind === "video" ? "视频地址未返回完整 MP4 文件（可能为错误页、音频或分片流）" : "原图链接返回了网页或错误信息";
    } else {
      image.state = "complete";
      image.error = "";
      await rememberDownload(job, image, delta.id);
    }
  } else {
    image.error = delta.error?.current === "SERVER_FORBIDDEN"
      ? "图片站拒绝下载请求（HTTP 403）"
      : delta.error?.current || "下载中断";
    image.state = image.attempts < 2 && image.error !== "USER_CANCELED" ? "queued" : "failed";
  }
  await releaseImageBlob(image.blobToken);
  image.blobToken = null;
  image.downloadId = null;
  await saveJob(job);
  await pump(job);
}

async function recover() {
  const job = await getJob();
  await showBadge(job);
  if (job?.status !== "running") return;
  for (const image of job.images) {
    if (image.state === "starting") {
      image.state = "failed";
      image.error = "浏览器中断了下载启动，请重新下载这篇微博";
      await releaseImageBlob(image.blobToken);
      image.blobToken = null;
    } else if (image.state === "downloading") {
      const [item] = await chrome.downloads.search({ id: image.downloadId });
      if (!item || item.state === "interrupted") {
        image.state = "failed";
        image.error = item?.error || "下载已中断";
      } else if (item.state === "complete") {
        image.state = "complete";
      }
      if (image.state !== "downloading") {
        await releaseImageBlob(image.blobToken);
        image.blobToken = null;
      }
    }
  }
  await saveJob(job);
  await setImageReferrers(job.images, job.site);
  await pump(job);
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll().then(() => {
    chrome.contextMenus.create({
      id: MENU_ID,
      title: "下载这篇帖子的图片和视频",
      contexts: ["page", "image", "link", "video"],
      documentUrlPatterns: ["https://weibo.com/*", "https://www.weibo.com/*", "https://www.instagram.com/*",
        "https://x.com/*", "https://www.x.com/*", "https://twitter.com/*", "https://www.twitter.com/*"]
    });
  });
  runSerial(recover);
});
chrome.runtime.onStartup.addListener(() => runSerial(recover));
chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== MENU_ID || !tab?.id) return;
  let host;
  try { host = new URL(tab.url || info.pageUrl).hostname; } catch { return; }
  const site = /^(www\.)?weibo\.com$/.test(host) ? "weibo" : host === "www.instagram.com" ? "instagram"
    : /^(www\.)?(x|twitter)\.com$/.test(host) ? "x" : null;
  if (site) runSerial(() => startDownload(tab, site));
});
chrome.downloads.onChanged.addListener(delta => runSerial(() => handleDownloadChange(delta)));
