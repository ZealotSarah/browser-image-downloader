/* Observe page-owned API responses without copying request credentials.
   This file must stay self-contained: a file listed in two content_scripts
   entries (one MAIN, one isolated) is only injected into one world, so the
   main-world script cannot share video-lib.js or x-lib.js with x.js. */
(() => {
  const XDownloads = globalThis.XDownloads;
  const posts = new Map();

  function isTweetApi(raw) {
    try {
      const url = new URL(raw, location.href);
      return url.origin === location.origin && /^\/i\/api\/(graphql\/|2\/|1\.1\/)/.test(url.pathname);
    } catch { return false; }
  }

  function isTweet(value) {
    const legacy = value && value.legacy;
    if (!legacy || typeof legacy !== "object") return false;
    if (!value.rest_id && !legacy.id_str) return false;
    // User objects also carry legacy.id_str; posts carry text or media.
    return typeof legacy.full_text === "string" || Boolean(legacy.extended_entities?.media || legacy.entities?.media);
  }

  // Keep only what x-lib.js parses, so the bridge stays small in memory.
  function mediaItem(media) {
    const item = { id_str: media.id_str, type: media.type, media_url_https: media.media_url_https };
    if (media.video_info?.variants) {
      item.video_info = { variants: media.video_info.variants.map(variant =>
        ({ url: variant.url, content_type: variant.content_type, bitrate: variant.bitrate })) };
    }
    return item;
  }

  function trim(tweet) {
    const legacy = tweet.legacy;
    const media = legacy.extended_entities?.media || legacy.entities?.media || [];
    const user = tweet.core?.user_results?.result;
    const screenName = user?.core?.screen_name || user?.legacy?.screen_name;
    return {
      rest_id: String(tweet.rest_id || legacy.id_str),
      legacy: { id_str: legacy.id_str, user_id_str: legacy.user_id_str,
        entities: { media: media.map(mediaItem) } },
      core: screenName ? { user_results: { result: { rest_id: String(user.rest_id || ""),
        core: { screen_name: screenName } } } } : undefined
    };
  }

  function capture(data) {
    const stack = [data];
    while (stack.length) {
      const value = stack.pop();
      if (!value || typeof value !== "object") continue;
      if (isTweet(value)) {
        const post = trim(value);
        posts.delete(post.rest_id);
        posts.set(post.rest_id, post);
      }
      stack.push(...Object.values(value).filter(child => child && typeof child === "object"));
    }
    for (const video of XDownloads.collectVideos(data)) videos.set(video.id, video);
    while (posts.size > 200) posts.delete(posts.keys().next().value);
    while (videos.size > 400) videos.delete(videos.keys().next().value);
  }

  const originalFetch = window.fetch;
  window.fetch = function (...args) {
    return originalFetch.apply(this, args).then(response => {
      if (isTweetApi(typeof args[0] === "string" ? args[0] : args[0]?.url)) {
        try { response.clone().json().then(capture).catch(() => {}); } catch { /* Non-JSON response. */ }
      }
      return response;
    });
  };
  const open = XMLHttpRequest.prototype.open;
  const send = XMLHttpRequest.prototype.send;
  const urls = new WeakMap();
  XMLHttpRequest.prototype.open = function (method, url, ...args) {
    urls.set(this, url);
    return open.call(this, method, url, ...args);
  };
  XMLHttpRequest.prototype.send = function (...args) {
    if (isTweetApi(urls.get(this))) this.addEventListener("load", () => {
      try { capture(this.responseType === "json" ? this.response : JSON.parse(this.responseText)); }
      catch { /* Response is not tweet JSON. */ }
    }, { once: true });
    return send.apply(this, args);
  };
  window.addEventListener("message", event => {
    if (event.source !== window || event.origin !== location.origin || event.data?.type !== "BID_X_REQUEST") return;
    const { requestId, postId, mediaIds = [] } = event.data;
    if (typeof requestId !== "string" || requestId.length > 100 || !/^\d+$/.test(postId)) return;
    const post = posts.get(postId);
    if (!post) {
      window.postMessage({ type: "BID_X_RESPONSE", requestId, post: null }, location.origin);
      return;
    }
    const matched = Array.isArray(mediaIds) ? mediaIds.slice(0, 8).map(id => videos.get(id)).filter(Boolean) : [];
    const known = new Set(post.videos.map(video => video.id));
    const recovered = matched.filter(video => !known.has(video.id));
    window.postMessage({ type: "BID_X_RESPONSE", requestId, post: { ...post,
      videos: [...post.videos, ...recovered], videoMissing: Math.max(0, post.videoMissing - recovered.length) } }, location.origin);
  });
})();
