(() => {
  let lastContext = null;
  document.addEventListener("contextmenu", event => {
    const target = event.target instanceof Element ? event.target : event.target?.parentElement;
    const card = target?.closest('article[data-testid="tweet"]');
    let postId = null;
    // A quoted post's timestamp must not replace the enclosing post's ID.
    for (const time of card?.querySelectorAll("time") || []) {
      if (time.closest('article[data-testid="tweet"]') !== card) continue;
      postId = XDownloads.postIdFromUrl(time.closest("a[href]")?.href);
      if (postId) break;
    }
    lastContext = card && postId ? { card, postId, pageUrl: location.href, time: Date.now() } : null;
  }, true);

  async function resolvePost() {
    const context = lastContext;
    if (!context?.card.isConnected || context.pageUrl !== location.href || Date.now() - context.time > 30000) {
      throw new Error("未找到右键所在的 X 帖子，请在帖子内容区域重试");
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
      window.postMessage({ type: "BID_X_REQUEST", requestId, postId: context.postId }, location.origin);
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
      resolvePost().then(data => sendResponse({ ok: true, data }))
        .catch(error => sendResponse({ ok: false, error: error.message }));
      return true;
    }
    if (message?.type === "TOAST") toast(message.text);
    return false;
  });
})();
