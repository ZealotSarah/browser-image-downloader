/* Selection of complete video files; manifests are not downloadable videos. */
globalThis.VideoDownloads = (() => {
  function videoUrl(raw, site) {
    if (typeof raw !== "string") return null;
    try {
      const url = new URL(raw.replace(/^\/\//, "https://").replace(/^http:/i, "https:"));
      const host = site === "instagram" ? /(^|\.)(cdninstagram\.com|fbcdn\.net)$/i
        : /(^|\.)(weibocdn\.com|weibo\.com|sinaimg\.cn)$/i;
      if (url.protocol !== "https:" || !host.test(url.hostname) || /\.(m3u8|mpd|m4s)(?:$|\/)/i.test(url.pathname)) return null;
      return url.href;
    } catch { return null; }
  }

  function best(candidates, site) {
    const valid = candidates.map(candidate => ({ ...candidate, width: Number(candidate.width),
      height: Number(candidate.height), url: videoUrl(candidate.url, site) }))
      .filter(candidate => candidate.url && Number.isFinite(candidate.width) && Number.isFinite(candidate.height) &&
        candidate.width > 0 && candidate.height > 0 && (!candidate.mime || /^video\/mp4(?:;|$)/i.test(candidate.mime)) &&
        candidate.video_codecs !== "none" && candidate.audio_codecs !== "none");
    valid.sort((a, b) => b.width * b.height - a.width * a.height ||
      (Number(b.fps) || 0) - (Number(a.fps) || 0) || (Number(b.bitrate) || 0) - (Number(a.bitrate) || 0));
    return valid[0] || null;
  }

  function instagramPostId(raw) {
    try {
      const url = new URL(raw);
      return url.hostname === "www.instagram.com"
        ? url.pathname.match(/^\/(?:[A-Za-z0-9._]+\/)?(?:p|reel|reels)\/([A-Za-z0-9_-]+)\/?$/)?.[1] || null : null;
    } catch { return null; }
  }

  function parseInstagram(data, postId) {
    const media = data.items?.find(item => item.code === postId ||
      String(item.pk || item.id || "").split("_")[0] === InstagramImages.mediaIdFromPostId(postId));
    if (!media) throw new Error("接口没有返回目标帖子");
    const videos = [];
    let missing = 0;
    for (const item of media.carousel_media || [media]) {
      if (item.media_type !== 2) continue;
      const selected = best(item.video_versions || [], "instagram");
      if (selected) videos.push({ id: String(item.pk || item.id || videos.length + 1), ...selected });
      else missing++;
    }
    return { postId, author: media.user?.username || "未知作者", userId: String(media.user?.pk || ""), videos, missing };
  }

  function weiboMedia(status) {
    const mixed = (status?.mix_media_info?.items || []).filter(item => item.type === "video")
      .map(item => ({ id: item.data?.object_id, info: item.data?.media_info }));
    if (mixed.length) return mixed;
    return status?.page_info?.media_info ? [{ id: status.page_info.object_id, info: status.page_info.media_info }] : [];
  }

  function parseWeibo(status) {
    let source = status;
    if (!weiboMedia(source).length && status.retweeted_status) source = status.retweeted_status;
    const videos = [];
    const seen = new Set();
    let missing = 0;
    for (const { id, info } of weiboMedia(source)) {
      const candidates = (info?.playback_list || []).map(entry => entry.play_info).filter(Boolean);
      // Older responses expose labeled MP4 URLs instead of playback_list.
      for (const [key, raw] of Object.entries(info || {})) {
        if (!/^stream_url|^mp4_/i.test(key) || typeof raw !== "string") continue;
        const url = videoUrl(raw, "weibo");
        if (!url) continue;
        const dimensions = new URL(url).searchParams.get("template")?.match(/^(\d+)x(\d+)$/);
        if (dimensions) candidates.push({ url, width: Number(dimensions[1]), height: Number(dimensions[2]) });
      }
      const selected = best(candidates, "weibo");
      if (!selected) { missing++; continue; }
      const identity = String(id || selected.url);
      if (seen.has(identity)) continue;
      seen.add(identity);
      videos.push({ id: identity, ...selected });
    }
    return { postId: String(source.idstr || source.id || status.idstr || status.id || ""),
      author: String(source.user?.screen_name || "未知博主"),
      userId: String(source.user?.idstr || source.user?.id || "unknown"), videos, missing };
  }

  return { videoUrl, best, instagramPostId, parseInstagram, parseWeibo };
})();
