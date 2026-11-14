/* Observe page-owned API responses without copying request credentials. */
(() => {
  const XDownloads = globalThis.XDownloads;
  const posts = new Map();
  const videos = new Map();
  function isTweetApi(raw) {
    try {
      const url = new URL(raw, location.href);
      return url.origin === location.origin && /^\/i\/api\/(graphql\/|2\/timeline\/)/.test(url.pathname);
    } catch { return false; }
  }
  function capture(data) {
    for (const post of XDownloads.collectPosts(data)) {
      posts.delete(post.postId);
      posts.set(post.postId, post);
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
