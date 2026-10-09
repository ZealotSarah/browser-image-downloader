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
      const url = WeiboImages.imageUrl(message.url);
      if (!url) throw new Error("图片地址无效");
      const response = await fetch(url, { signal: AbortSignal.timeout(25000) });
      if (!response.ok) throw new Error(`图片站返回 HTTP ${response.status}`);
      const type = response.headers.get("content-type") || "";
      if (!type.toLowerCase().startsWith("image/")) throw new Error("图片站返回了非图片内容");
      const blob = await response.blob();
      const blobUrl = URL.createObjectURL(blob);
      blobUrls.set(message.token, blobUrl);
      sendResponse({ ok: true, blobUrl });
    })().catch(error => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  return false;
});
