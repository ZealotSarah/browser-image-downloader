globalThis.XDownloads = (() => {
  function postIdFromUrl(raw) {
    try {
      const url = new URL(raw);
      if (!/^(www\.)?(x|twitter)\.com$/i.test(url.hostname)) return null;
      return url.pathname.match(/^\/(?:[A-Za-z0-9_]+|i\/web)\/status\/(\d+)(?:\/(?:photo|video)\/\d+)?\/?$/)?.[1] || null;
    } catch { return null; }
  }

  function imageUrl(raw) {
    try {
      const url = new URL(raw);
      if (url.protocol !== "https:" || url.hostname !== "pbs.twimg.com" || !url.pathname.startsWith("/media/")) return null;
      const extension = url.pathname.match(/\.(jpe?g|png|webp)$/i);
      const format = url.searchParams.get("format") || extension?.[1]?.toLowerCase();
      if (!/^(jpg|jpeg|png|webp)$/.test(format || "")) return null;
      if (extension) url.pathname = url.pathname.slice(0, -extension[0].length);
      url.searchParams.set("format", format === "jpeg" ? "jpg" : format);
      url.searchParams.set("name", "orig");
      return url.href;
    } catch { return null; }
  }

  function parseTweet(tweet) {
    const legacy = tweet.legacy;
    const postId = String(tweet.rest_id || legacy?.id_str || "");
    if (!legacy || !/^\d+$/.test(postId)) return null;
    const user = tweet.core?.user_results?.result;
    const author = user?.core?.screen_name || user?.legacy?.screen_name;
    if (!author) return null;
    const pictures = [];
    const videos = [];
    let pictureMissing = 0;
    let videoMissing = 0;
    for (const media of legacy.extended_entities?.media || legacy.entities?.media || []) {
      if (media.type === "photo") {
        const url = imageUrl(media.media_url_https);
        if (url) pictures.push({ id: String(media.id_str || pictures.length + 1), url });
        else pictureMissing++;
      } else if (media.type === "video" || media.type === "animated_gif") {
        const variants = (media.video_info?.variants || []).filter(variant => variant.content_type === "video/mp4").map(variant => {
          const dimensions = variant.url?.match(/\/(\d+)x(\d+)\//);
          return { url: variant.url, width: Number(dimensions?.[1]), height: Number(dimensions?.[2]),
            bitrate: variant.bitrate || 0, mime: variant.content_type };
        });
        const selected = VideoDownloads.best(variants, "x");
        if (selected) videos.push({ id: String(media.id_str || videos.length + 1), ...selected });
        else videoMissing++;
      }
    }
    return { postId, author, userId: String(user.rest_id || legacy.user_id_str || author), pictures, videos,
      pictureMissing, videoMissing, qualitySource: "media" };
  }

  function collectPosts(data) {
    const posts = new Map();
    const stack = [data];
    while (stack.length) {
      const value = stack.pop();
      if (!value || typeof value !== "object") continue;
      const parsed = parseTweet(value);
      if (parsed) posts.set(parsed.postId, parsed);
      stack.push(...Object.values(value).filter(child => child && typeof child === "object"));
    }
    return [...posts.values()];
  }

  return { postIdFromUrl, imageUrl, parseTweet, collectPosts };
})();
