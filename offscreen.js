const blobUrls = new Map();
const webpSources = new Map();

async function toPng(blob) {
  const bitmap = await createImageBitmap(blob);
  try {
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    canvas.getContext("2d").drawImage(bitmap, 0, 0);
    return await canvas.convertToBlob({ type: "image/png" });
  } finally {
    bitmap.close();
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.target !== "offscreen") return false;

  if (message.type === "RELEASE_IMAGE") {
    const url = blobUrls.get(message.token);
    if (url) URL.revokeObjectURL(url);
    blobUrls.delete(message.token);
    sendResponse({ ok: true });
    return false;
  }

  if (message.type === "FETCH_IMAGE") {
    (async () => {
      const live = message.kind === "live";
      const url = live
        ? WeiboImages.livePhotoUrl({ type: "livephoto", video: message.url })
        : message.site === "instagram" ? InstagramImages.imageUrl(message.url) : WeiboImages.imageUrl(message.url);
      if (!url) throw new Error("媒体地址无效");
      let blob = message.kind === "png" ? webpSources.get(url) : null;
      let type = blob?.type || "";
      if (!blob) {
        const response = await fetch(url, { signal: AbortSignal.timeout(25000) });
        const finalUrl = !live && message.site !== "instagram" && WeiboImages.imageUrl(response.url);
        if (finalUrl && new URL(finalUrl).pathname === "/images/default_d_h_large.gif") {
          sendResponse({ ok: false, blocked: true, error: "微博已屏蔽这张图片" });
          return;
        }
        if (!response.ok) throw new Error(`图片站返回 HTTP ${response.status}`);
        type = response.headers.get("content-type") || "";
        if (live ? !/^(video\/|application\/(octet-stream|quicktime))/i.test(type)
          : !type.toLowerCase().startsWith("image/")) {
          throw new Error(live ? "动态文件地址返回了非视频内容" : "图片站返回了非图片内容");
        }
        blob = await response.blob();
      }
      if (message.site === "instagram" && /^image\/webp(?:;|$)/i.test(type)) {
        if (message.kind === "png") {
          blob = await toPng(blob);
          type = blob.type;
          webpSources.delete(url);
        } else {
          webpSources.set(url, blob);
        }
      } else if (message.kind === "png") {
        throw new Error("PNG 副本的源文件不是 WebP，请重新下载帖子");
      }
      const blobUrl = URL.createObjectURL(blob);
      blobUrls.set(message.token, blobUrl);
      const extension = /^image\/(jpeg|png|webp|gif|avif|bmp)/i.exec(type)?.[1];
      sendResponse({ ok: true, blobUrl, extension: extension ? `.${extension.replace("jpeg", "jpg")}` : "" });
    })().catch(error => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  return false;
});
