(() => {
  const POST_SELECTOR = 'article, .vue-feed-item, div[action-type="feed_list_item"]';
  let lastContext = null;

  function statusIdFor(card) {
    const direct = card.getAttribute("mid") || card.getAttribute("data-mid");
    if (direct && /^[A-Za-z0-9]+$/.test(direct)) return direct;
    for (const link of card.querySelectorAll("a[href]")) {
      if (link.closest(POST_SELECTOR) !== card) continue;
      const id = WeiboImages.postIdFromUrl(link.href);
      if (id) return id;
    }
    return WeiboImages.postIdFromUrl(location.href);
  }

  document.addEventListener("contextmenu", (event) => {
    const target = event.target instanceof Element ? event.target : event.target?.parentElement;
    const card = target?.closest(POST_SELECTOR);
    lastContext = card ? {
      card,
      id: statusIdFor(card),
      pageUrl: location.href,
      time: Date.now()
    } : null;
  }, true);

  async function resolvePost() {
    const context = lastContext;
    if (!context?.id || !context.card.isConnected || context.pageUrl !== location.href || Date.now() - context.time > 30000) {
      throw new Error("未找到右键所在的微博，请在微博内容区域重试");
    }

    const response = await fetch(`/ajax/statuses/show?id=${encodeURIComponent(context.id)}&locale=zh-CN&isGetLongText=true`, {
      credentials: "same-origin",
      headers: { Accept: "application/json", "X-Requested-With": "XMLHttpRequest" }
    });
    if (!response.ok) throw new Error(`微博详情获取失败（HTTP ${response.status}），请检查登录状态`);
    const status = await response.json();
    if (status?.error) throw new Error(`微博详情获取失败：${status.error}`);
    const parsed = WeiboImages.parseStatus(status);
    if (!parsed.pictures.length && !parsed.missing) throw new Error("这篇微博没有图片");
    return { postId: String(status.idstr || status.id || context.id), ...parsed };
  }

  function toast(message) {
    document.getElementById("weibo-images-toast")?.remove();
    const node = document.createElement("div");
    node.id = "weibo-images-toast";
    node.textContent = message;
    Object.assign(node.style, {
      position: "fixed", bottom: "24px", right: "24px", zIndex: "2147483647",
      maxWidth: "360px", padding: "12px 16px", borderRadius: "8px",
      background: "#242424", color: "#fff", font: "14px/1.5 sans-serif",
      boxShadow: "0 4px 18px #0005"
    });
    document.documentElement.append(node);
    setTimeout(() => node.remove(), 6000);
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "RESOLVE_POST") {
      resolvePost().then(data => sendResponse({ ok: true, data }))
        .catch(error => sendResponse({ ok: false, error: error.message }));
      return true;
    }
    if (message?.type === "TOAST") toast(message.text);
    return false;
  });
})();
