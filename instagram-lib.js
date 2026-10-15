globalThis.InstagramImages = (() => {
  function imageUrl(raw) {
    try {
      const url = new URL(raw);
      if (url.protocol !== "https:" || !/(^|\.)(cdninstagram\.com|fbcdn\.net)$/i.test(url.hostname)) return null;
      return url.href;
    } catch {
      return null;
    }
  }

  function bestImageUrl(image) {
    const candidates = (image.srcset || "").split(",").map(entry => {
      const [url, width] = entry.trim().split(/\s+/);
      return { url: imageUrl(url), width: Number.parseInt(width, 10) || 0 };
    }).filter(entry => entry.url);
    candidates.sort((a, b) => b.width - a.width);
    return candidates[0]?.url || imageUrl(image.currentSrc || image.src);
  }

  function postIdFromUrl(raw) {
    try {
      const url = new URL(raw);
      if (url.hostname !== "www.instagram.com") return null;
      return url.pathname.match(/^\/(?:[A-Za-z0-9._]+\/)?p\/([A-Za-z0-9_-]+)\/?$/)?.[1] || null;
    } catch {
      return null;
    }
  }

  function mediaIdFromPostId(postId) {
    if (!/^[A-Za-z0-9_-]+$/.test(postId)) throw new Error("帖子编号无效");
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    return [...postId].reduce((value, character) => value * 64n + BigInt(alphabet.indexOf(character)), 0n).toString();
  }

  function parseMedia(data, postId) {
    const media = data.items?.find(item => item.code === postId ||
      String(item.pk || item.id || "").split("_")[0] === mediaIdFromPostId(postId));
    if (!media) throw new Error("接口没有返回目标帖子");
    const pictures = [];
    let missing = 0;
    for (const item of media.carousel_media || [media]) {
      if (item.media_type !== 1) continue;
      const candidates = (item.image_versions2?.candidates || []).map(candidate => ({
        url: imageUrl(candidate.url), width: Number(candidate.width), height: Number(candidate.height)
      })).filter(candidate => candidate.url && candidate.width > 0 && candidate.height > 0);
      candidates.sort((a, b) => b.width * b.height - a.width * a.height ||
        Number(/\.jpe?g$/i.test(new URL(b.url).pathname)) - Number(/\.jpe?g$/i.test(new URL(a.url).pathname)));
      if (candidates.length) pictures.push({ id: String(item.pk || item.id || pictures.length + 1), ...candidates[0] });
      else missing++;
    }
    return { postId, author: media.user?.username || "未知作者", userId: String(media.user?.pk || ""),
      pictures, missing, qualitySource: "media" };
  }

  return { imageUrl, bestImageUrl, postIdFromUrl, mediaIdFromPostId, parseMedia };
})();
