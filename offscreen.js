const blobUrls = new Map();

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
        : WeiboImages.imageUrl(message.url);
      if (!url) throw new Error("媒体地址无效");
      const response = await fetch(url, { signal: AbortSignal.timeout(25000) });
      if (!response.ok) throw new Error(`图片站返回 HTTP ${response.status}`);
      const type = response.headers.get("content-type") || "";
      if (live ? !/^(video\/|application\/(octet-stream|quicktime))/i.test(type)
        : !type.toLowerCase().startsWith("image/")) {
        throw new Error(live ? "动态文件地址返回了非视频内容" : "图片站返回了非图片内容");
      }
      const blob = await response.blob();
      const blobUrl = URL.createObjectURL(blob);
      blobUrls.set(message.token, blobUrl);
      sendResponse({ ok: true, blobUrl });
    })().catch(error => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  return false;
});
