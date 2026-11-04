const blobUrls = new Map();
const webpSources = new Map();

async function readImageRanges(url, options, response, type, size) {
  const chunkSize = 4 * 1024 * 1024;
  const etag = response.headers.get("etag");
  const chunks = [];
  for (let start = 0; start < size; start += chunkSize) {
    const end = Math.min(start + chunkSize, size) - 1;
    const part = await fetch(url, { ...options, headers: {
      Range: `bytes=${start}-${end}`,
      ...(etag && !etag.startsWith("W/") ? { "If-Range": etag } : {})
    } });
    if (part.status !== 206 || part.headers.get("content-range") !== `bytes ${start}-${end}/${size}` ||
      part.headers.get("content-type") !== type || (etag && part.headers.get("etag") !== etag)) {
      await part.body?.cancel();
      throw new Error("微博原图分段响应不匹配，无法保存完整图片");
    }
    const chunk = await part.blob();
    if (chunk.size !== end - start + 1) throw new Error("微博原图分段读取不完整");
    chunks.push(chunk);
  }
  return new Blob(chunks, { type });
}

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
    let signal;
    (async () => {
      const live = message.kind === "live";
      const video = message.kind === "video";
      const url = video ? VideoDownloads.videoUrl(message.url, message.site) : live
        ? WeiboImages.livePhotoUrl({ type: "livephoto", video: message.url })
        : message.site === "x" ? XDownloads.imageUrl(message.url) : message.site === "instagram" ? InstagramImages.imageUrl(message.url) : WeiboImages.imageUrl(message.url);
      if (!url) throw new Error("媒体地址无效");
      let blob = message.kind === "png" ? webpSources.get(url) : null;
      let type = blob?.type || "";
      if (!blob) {
        signal = AbortSignal.timeout(video || message.site === "weibo" ? 180000 : 25000);
        const weiboImage = message.site === "weibo" && message.kind === "image";
        const options = { signal,
          ...(video ? { credentials: "include" } : {}),
          ...(weiboImage ? { cache: "no-store" } : {}) };
        const response = await fetch(url, options).catch(error => {
          const alternate = weiboImage && WeiboImages.alternateImageUrl(url);
          if (!alternate || signal.aborted || error.name !== "TypeError") throw error;
          return fetch(alternate, options);
        });
        const finalUrl = !live && message.site !== "instagram" && WeiboImages.imageUrl(response.url);
        if (finalUrl && new URL(finalUrl).pathname === "/images/default_d_h_large.gif") {
          sendResponse({ ok: false, blocked: true, error: "微博已屏蔽这张图片" });
          return;
        }
        if (!response.ok) throw new Error(`${video ? "视频" : "图片"}站返回 HTTP ${response.status}${video && response.status === 403 ? "，链接可能过期或来源验证失败，请刷新微博后重试" : ""}`);
        type = response.headers.get("content-type") || "";
        if (video ? !/^(video\/mp4|application\/octet-stream)(?:;|$)/i.test(type)
          : live ? !/^(video\/|application\/(octet-stream|quicktime))/i.test(type)
          : !type.toLowerCase().startsWith("image/")) {
          throw new Error(video ? `视频地址返回了非 MP4 内容（${type || "未知类型"}），未保存；请刷新微博后重试` : live ? "动态文件地址返回了非视频内容" : "图片站返回了非图片内容");
        }
        try {
          blob = await response.blob();
        } catch (error) {
          const size = Number(response.headers.get("content-length"));
          if (!weiboImage || error.name !== "TypeError" || signal.aborted || response.status !== 200 ||
            !Number.isSafeInteger(size) || size <= 4 * 1024 * 1024) throw error;
          const rangeUrl = WeiboImages.imageUrl(response.url);
          if (!rangeUrl) throw error;
          blob = await readImageRanges(rangeUrl, options, response, type, size);
        }
        if (video) {
          const header = new Uint8Array(await blob.slice(0, 12).arrayBuffer());
          if (header.length < 12 || String.fromCharCode(...header.slice(4, 8)) !== "ftyp") {
            throw new Error("视频响应没有 MP4 文件头，可能是错误网页，未保存");
          }
          blob = blob.slice(0, blob.size, "video/mp4");
        }
      }
      if (["instagram", "x"].includes(message.site) && /^image\/webp(?:;|$)/i.test(type)) {
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
      sendResponse({ ok: true, blobUrl, extension: video ? ".mp4" : extension ? `.${extension.replace("jpeg", "jpg")}` : "" });
    })().catch(error => sendResponse({
      ok: false,
      networkError: error.name === "TypeError" && !signal?.aborted && error.message === "Failed to fetch",
      error: signal?.aborted ? "媒体文件读取超时，请检查网络后重试" : error.message
    }));
    return true;
  }
  return false;
});
