(() => {
  const XDownloads = globalThis.XDownloads;
  let lastContext = null;
  function rememberContext(event) {
    const target = event.target instanceof Element ? event.target : event.target?.parentElement;
    const card = target?.closest('article[data-testid="tweet"]');
    const player = target?.closest('video, [data-testid="videoPlayer"], [data-testid="videoComponent"], [role="dialog"]');
    let postId = null;
    // A quoted post's timestamp must not replace the enclosing post's ID.
    for (const time of card?.querySelectorAll("time") || []) {
      if (time.closest('article[data-testid="tweet"]') !== card) continue;
      postId = XDownloads.postIdFromUrl(time.closest("a[href]")?.href);
      if (postId) break;
    }
    if (card && !postId) {
      const ids = new Set(Array.from(card.querySelectorAll("a[href]"), link => XDownloads.postIdFromUrl(link.href)).filter(Boolean));
      if (ids.size === 1) postId = [...ids][0];
    }
    // Media viewers can render the player outside the tweet article.
    if (!card && player) postId = XDownloads.postIdFromUrl(location.href);
    const scope = card || player;
    const mediaIds = [];
    for (const media of [scope, ...scope?.querySelectorAll('video[poster], img[src], [style*="background-image"]') || []]) {
      if (!media) continue;
      const id = XDownloads.videoMediaId(media.getAttribute?.("poster") || media.getAttribute?.("src") ||
        media.getAttribute?.("style") || "");
      if (id && !mediaIds.includes(id)) mediaIds.push(id);
    }
    lastContext = scope && postId ? { card: scope, postId, mediaIds, pageUrl: location.href, time: Date.now() } : null;
  }
  document.addEventListener("contextmenu", rememberContext, true);
  document.addEventListener("pointerdown", event => {
    if (event.button === 2) rememberContext(event);
  }, true);

  async function resolvePost(message) {
    let context = lastContext;
    if (!context?.card.isConnected || context.pageUrl !== location.href || Date.now() - context.time > 30000) {
      // Chrome's native media menu may not dispatch a DOM contextmenu event.
      const postId = message.pageUrl === location.href &&
        (XDownloads.postIdFromUrl(message.linkUrl) || XDownloads.postIdFromUrl(message.pageUrl));
      if (!postId) throw new Error("无法定位 X 帖子（0.4.16）：请打开原帖详情页后右键下载");
      context = { postId, mediaIds: [] };
    }
    const post = await new Promise(resolve => {
      const requestId = crypto.randomUUID();
      const listener = event => {
        if (event.source !== window || event.origin !== location.origin || event.data?.type !== "BID_X_RESPONSE" || event.data.requestId !== requestId) return;
        clearTimeout(timer);
        window.removeEventListener("message", listener);
        resolve(event.data.post);
      };
      const timer = setTimeout(() => { window.removeEventListener("message", listener); resolve(null); }, 1500);
      window.addEventListener("message", listener);
      window.postMessage({ type: "BID_X_REQUEST", requestId, postId: context.postId, mediaIds: context.mediaIds }, location.origin);
    });
    if (!post || post.postId !== context.postId) throw new Error("尚未取得这篇 X 帖子的媒体数据，请刷新页面，等待帖子加载后重试");
    const missing = post.videoMissing + post.pictureMissing;
    if (!post.videos?.length && !post.pictures?.length && !missing) throw new Error("这篇 X 帖子没有图片或视频");
    return { ...post, missing, imageMissing: post.pictureMissing };
  }

  function toast(text) {
    document.getElementById("x-images-toast")?.remove();
    const node = document.createElement("div");
    node.id = "x-images-toast";
    node.textContent = text;
    Object.assign(node.style, { position: "fixed", bottom: "24px", right: "24px", zIndex: "2147483647",
      maxWidth: "360px", padding: "12px 16px", borderRadius: "8px", background: "#242424", color: "#fff", font: "14px/1.5 sans-serif" });
    document.documentElement.append(node);
    setTimeout(() => node.remove(), 6000);
  }
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "RESOLVE_MEDIA") {
      resolvePost(message).then(data => sendResponse({ ok: true, data }))
        .catch(error => sendResponse({ ok: false, error: error.message }));
      return true;
    }
    if (message?.type === "TOAST") toast(message.text);
    return false;
  });
})();
