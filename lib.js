/* Shared, DOM-independent helpers. */
globalThis.WeiboImages = (() => {
  const IMAGE_HOST = /(^|\.)sinaimg\.cn$/i;

  function imageUrl(value) {
    const raw = typeof value === "string" ? value : value?.url;
    if (!raw) return null;
    try {
      const url = new URL(raw.startsWith("//") ? `https:${raw}` : raw);
      return url.protocol === "https:" && IMAGE_HOST.test(url.hostname) ? url.href : null;
    } catch {
      return null;
    }
  }

  function originalUrl(info) {
    if (!info || typeof info !== "object") return null;
    const raw = imageUrl(info.original) || imageUrl(info.largest);
    if (!raw) return null;
    const url = new URL(raw);
    // Weibo may label an orj1080-sized image as "original" in post data.
    url.pathname = url.pathname.replace(/^\/orj1080\//i, "/large/");
    return url.href;
  }

  function livePhotoUrl(info) {
    if (info?.type !== "livephoto" || typeof info.video !== "string") return null;
    try {
      const raw = info.video.startsWith("//") ? `https:${info.video}` : info.video.replace(/^http:/i, "https:");
      const url = new URL(raw);
      if (url.protocol !== "https:") return null;
      if (url.hostname === "video.weibo.com" && url.pathname === "/media/play" && url.searchParams.has("livephoto")) return url.href;
      if (IMAGE_HOST.test(url.hostname) && /\.(mov|mp4)$/i.test(url.pathname)) return url.href;
    } catch { /* Invalid video URL. */ }
    return null;
  }

  function parseStatus(status) {
    let source = status;
    if (!hasPictures(source) && source?.retweeted_status) source = source.retweeted_status;
    const pictures = [];
    const seen = new Set();
    let missing = 0;

    function add(id, info) {
      const url = originalUrl(info);
      if (!url) {
        missing++;
        return;
      }
      const key = String(id || url);
      if (seen.has(key)) return;
      seen.add(key);
      const liveUrl = livePhotoUrl(info);
      if (info?.type === "livephoto" && !liveUrl) missing++;
      pictures.push({ id: key, url, ...(liveUrl ? { liveUrl } : {}) });
    }

    const mixedPictures = (source?.mix_media_info?.items || []).filter(item =>
      item?.type === "pic" || (!item?.type && item?.data?.object_type !== "video"));
    if (mixedPictures.length) {
      for (const item of mixedPictures) {
        const id = item.data?.pic_id || item.data?.pid || item.data?.id;
        const info = item.data?.pic_info || item.data;
        add(id, originalUrl(info) ? info : source.pic_infos?.[id] || info);
      }
    } else if (Array.isArray(source?.pic_ids) && source.pic_ids.length) {
      for (const id of source.pic_ids) add(id, source.pic_infos?.[id]);
    } else if (Array.isArray(source?.pics) && source.pics.length) {
      for (const pic of source.pics) {
        if (pic?.type === "video") continue;
        add(pic?.pid, pic);
      }
    }

    return {
      author: String(source?.user?.screen_name || status?.user?.screen_name || "未知博主"),
      userId: String(source?.user?.idstr || source?.user?.id || status?.user?.idstr || status?.user?.id || "unknown"),
      pictures,
      missing
    };
  }

  function hasPictures(status) {
    return Boolean(status && (
      status.pic_ids?.length || status.pics?.length || status.mix_media_info?.items?.length
    ));
  }

  function safeSegment(value, fallback = "未命名") {
    const cleaned = String(value || "")
      .replace(/[<>:"/\\|?*\x00-\x1F]/g, "_")
      .trim()
      .slice(0, 80)
      .replace(/[. ]+$/g, "");
    if (!cleaned || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(cleaned)) return fallback;
    return cleaned;
  }

  function normalizeSubfolder(value) {
    const name = String(value || "").trim();
    if (!name) return "";
    if (name === "." || name === ".." || /[/\\]/.test(name)) {
      throw new Error("下载子文件夹只能填写一个文件夹名称");
    }
    return safeSegment(name, "微博原图");
  }

  function extensionFromUrl(raw) {
    try {
      const url = new URL(raw);
      const nested = url.searchParams.get("livephoto");
      const path = nested ? new URL(nested.startsWith("//") ? `https:${nested}` : nested).pathname : url.pathname;
      const match = path.match(/\.(jpe?g|png|gif|webp|bmp|avif|mov|mp4)$/i);
      return match ? `.${match[1].toLowerCase().replace("jpeg", "jpg")}` : "";
    } catch {
      return "";
    }
  }

  function postIdFromUrl(raw) {
    try {
      const url = new URL(raw);
      if (!/^(www\.)?weibo\.com$/.test(url.hostname)) return null;
      return url.pathname.match(/^\/\d+\/([A-Za-z0-9]+)(?:\/|$)/)?.[1]
        || url.pathname.match(/^\/detail\/([A-Za-z0-9]+)(?:\/|$)/)?.[1]
        || null;
    } catch {
      return null;
    }
  }

  return { imageUrl, originalUrl, livePhotoUrl, parseStatus, safeSegment, normalizeSubfolder, extensionFromUrl, postIdFromUrl };
})();
