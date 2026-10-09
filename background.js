importScripts("lib.js");

const MENU_ID = "download-weibo-originals";
const DEFAULT_SETTINGS = { downloadSubfolder: "微博原图", groupByAuthor: true };
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
  await chrome.action.setBadgeText({ text: running ? String(done) : failed ? "!" : job ? "✓" : "" });
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

async function setImageReferrers(images) {
  const existing = await chrome.declarativeNetRequest.getSessionRules();
  const urls = [...new Set(images.map(image => image.url))];
  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: existing.map(rule => rule.id),
    addRules: urls.map((url, index) => ({
      id: index + 1,
      priority: 1,
      action: {
        type: "modifyHeaders",
        requestHeaders: [{ header: "referer", operation: "set", value: "https://weibo.com/" }]
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
      justification: "获取带来源请求头的微博原图并生成可下载文件"
    }).finally(() => { creatingOffscreen = null; });
  }
  await creatingOffscreen;
}

async function fetchImageBlob(image, token) {
  await ensureOffscreen();
  const response = await chrome.runtime.sendMessage({ target: "offscreen", type: "FETCH_IMAGE", url: image.url, kind: image.kind, token });
  if (!response?.ok) throw new Error(response?.error || "无法获取原图");
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
  const subfolder = WeiboImages.normalizeSubfolder(settings.downloadSubfolder);
  if (subfolder) parts.push(subfolder);
  if (settings.groupByAuthor) {
    parts.push(`${WeiboImages.safeSegment(job.author)}_${WeiboImages.safeSegment(job.userId, "unknown")}`);
  }
  const date = new Date(job.createdAt);
  const day = `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, "0")}${String(date.getDate()).padStart(2, "0")}`;
  const number = String(image.index + 1).padStart(2, "0");
  const postId = WeiboImages.safeSegment(job.postId, "微博");
  parts.push(`${day}_${postId}_${number}${WeiboImages.extensionFromUrl(image.url)}`);
  return parts.join("/");
}

async function finishIfDone(job) {
  if (job.images.some(image => ["queued", "starting", "downloading"].includes(image.state))) return;
  job.status = "done";
  await saveJob(job);
  try { await setImageReferrers([]); } catch (error) { console.error("清理图片下载规则失败：", error); }
  try { await closeOffscreen(); } catch (error) { console.error("关闭图片处理页面失败：", error); }
  const done = job.images.filter(image => image.state === "complete").length;
  const failed = job.images.filter(image => image.state === "failed").length + job.missing;
  await toast(job.tabId, `微博原图下载完成：成功 ${done} 个文件，失败 ${failed} 个文件。点击插件图标查看详情。`);
}

async function pump(job) {
  const { settings: savedSettings } = await chrome.storage.local.get("settings");
  const settings = { ...DEFAULT_SETTINGS, ...savedSettings };
  while (job.status === "running" && job.images.filter(image => image.state === "starting" || image.state === "downloading").length < 3) {
    const image = job.images.find(item => item.state === "queued");
    if (!image) break;
    image.state = "starting";
    image.attempts++;
    await saveJob(job);
    try {
      const token = `${job.id}-${image.index}-${image.attempts}`;
      const blobUrl = await fetchImageBlob(image, token);
      image.blobToken = token;
      const id = await chrome.downloads.download({
        url: blobUrl,
        filename: makeFilename(job, image, settings),
        saveAs: false,
        conflictAction: "uniquify"
      });
      image.downloadId = id;
      image.state = "downloading";
    } catch (error) {
      await releaseImageBlob(image.blobToken);
      image.blobToken = null;
      image.error = error.message;
      image.state = image.attempts < 2 ? "queued" : "failed";
    }
    await saveJob(job);
  }
  await finishIfDone(job);
}

async function startDownload(tab) {
  const previous = await getJob();
  if (previous?.status === "running") {
    await toast(tab.id, "已有一篇微博正在下载，请等待完成后再试。");
    return;
  }
  let response;
  try {
    response = await chrome.tabs.sendMessage(tab.id, { type: "RESOLVE_POST" });
  } catch {
    await toast(tab.id, "无法读取微博页面，请刷新页面后重试。");
    return;
  }
  if (!response?.ok) {
    await toast(tab.id, response?.error || "无法定位这篇微博。");
    return;
  }

  const data = response.data;
  const images = data.pictures.flatMap((picture, index) => [
    { index, kind: "image", url: picture.url },
    ...(picture.liveUrl ? [{ index, kind: "live", url: picture.liveUrl }] : [])
  ].map(file => ({ ...file, state: "queued", attempts: 0, downloadId: null, error: "" })));
  const job = {
    id: crypto.randomUUID(), tabId: tab.id, postId: data.postId,
    author: data.author, userId: data.userId, createdAt: Date.now(),
    missing: data.missing, images, status: "running"
  };
  await saveJob(job);
  await toast(tab.id, `已找到 ${data.pictures.length} 张原图和 ${images.length - data.pictures.length} 个 Live 动态文件，开始下载。${job.missing ? `另有 ${job.missing} 个文件地址不可用。` : ""}`);
  try {
    await setImageReferrers(images);
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
    if (/^(text\/html|application\/json)/i.test(item?.mime || "")) {
      try { await chrome.downloads.removeFile(delta.id); } catch { /* May already be gone. */ }
      image.state = "failed";
      image.error = "原图链接返回了网页或错误信息";
    } else {
      image.state = "complete";
      image.error = "";
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
  await setImageReferrers(job.images);
  await pump(job);
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll().then(() => chrome.contextMenus.create({
    id: MENU_ID,
    title: "下载这篇微博的全部原图",
    contexts: ["page", "image", "link"],
    documentUrlPatterns: ["https://weibo.com/*", "https://www.weibo.com/*"]
  }));
  runSerial(recover);
});
chrome.runtime.onStartup.addListener(() => runSerial(recover));
chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === MENU_ID && tab?.id) runSerial(() => startDownload(tab));
});
chrome.downloads.onChanged.addListener(delta => runSerial(() => handleDownloadChange(delta)));
