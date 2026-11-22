(() => {
  const lib = globalThis.XDownloads;
  if (!lib) {
    // Without the library nothing below can read a post, so say that plainly
    // instead of failing with a bare ReferenceError on every right-click.
    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if (message?.type === "RESOLVE_MEDIA") sendResponse({ ok: false, error: "下载脚本没有完整加载：请在扩展管理页重新加载扩展，然后刷新本页面" });
      return false;
    });
    return;
  }
  const CARD = 'article[data-testid="tweet"], article[role="article"]';
  const VIDEO = '[data-testid="videoPlayer"], [data-testid="videoComponent"], video';
  const PHOTO = '[data-testid="tweetPhoto"] img, img[src*="pbs.twimg.com/media/"]';
  // Media outside a post card (image viewer, player overlay) still belongs to
  // the post the pointer was over, so those right-clicks keep the hover record.
  const MEDIA = 'img, video, [role="dialog"], [data-testid="tweetPhoto"], [data-testid="videoPlayer"], [data-testid="videoComponent"]';
  // The page may re-render the card or reopen the media layer between the
  // right-click and the menu click, so a snapshot stays usable for minutes.
  const CONTEXT_TTL = 5 * 60 * 1000;
  const HOVER_TTL = 10 * 60 * 1000;

  const idCache = new WeakMap();
  let lastContext = null;
  let lastHover = null;

  function elementOf(target) {
    return target instanceof Element ? target : target?.parentElement || null;
  }

  function findCard(node) {
    if (!node || typeof node.closest !== "function") return null;
    return node.closest(CARD) || node.closest("article");
  }

  function ownNodes(card, selector) {
    const nodes = [];
    for (const node of card.querySelectorAll(selector)) {
      const owner = typeof node.closest === "function" ? node.closest("article") : null;
      if (!owner || owner === card) nodes.push(node);
    }
    return nodes;
  }

  function postIdFromCard(card) {
    // A quoted post's timestamp must not replace the enclosing post's ID.
    for (const time of ownNodes(card, "time")) {
      const id = lib.postIdFromUrl(time.closest("a[href]")?.href);
      if (id) return id;
    }
    const media = new Set();
    const linked = new Set();
    for (const link of ownNodes(card, 'a[href*="/status/"]')) {
      const id = lib.postIdFromUrl(link.href);
      if (!id) continue;
      linked.add(id);
      if (/\/(?:photo|video)\/\d+/.test(link.href)) media.add(id);
    }
    if (media.size === 1) return [...media][0];
    if (linked.size === 1) return [...linked][0];
    return null;
  }

  function cardId(card) {
    if (!card) return null;
    if (idCache.has(card)) return idCache.get(card);
    const id = postIdFromCard(card);
    if (id) idCache.set(card, id);
    return id;
  }

  function currentPath() {
    return `${location.origin}${location.pathname}`;
  }

  function record(node, point) {
    const card = findCard(node);
    const link = typeof node?.closest === "function" ? node.closest('a[href*="/status/"]') : null;
    return {
      card,
      postId: cardId(card) || lib.postIdFromUrl(link?.href) || null,
      point,
      path: currentPath(),
      time: Date.now()
    };
  }

  document.addEventListener("contextmenu", event => {
    const node = elementOf(event.target);
    lastContext = record(node, { x: event.clientX, y: event.clientY });
    if (lastContext.card || lastContext.postId) {
      lastHover = lastContext;
      return;
    }
    // Media outside a post card (image viewer, player overlay) still belongs to
    // the post the pointer was over, so keep that record. A right-click on plain
    // text or blank space means "not this post" and clears it.
    if (node?.closest?.(MEDIA) && lastHover) {
      lastHover.time = Date.now();
      lastHover.point = lastContext.point;
      lastHover.path = lastContext.path;
      return;
    }
    lastHover = null;
  }, true);

  // Some right-clicks never reach this frame (player overlays and embedded
  // players live in iframes), so remember the post the pointer was last over.
  document.addEventListener("pointermove", event => {
    const card = findCard(elementOf(event.target));
    if (!card) return;
    const point = { x: event.clientX, y: event.clientY };
    if (lastHover?.card === card) {
      lastHover.time = Date.now();
      lastHover.point = point;
      return;
    }
    lastHover = { card, postId: cardId(card), point, path: currentPath(), time: Date.now() };
  }, { capture: true, passive: true });

  function push(list, id, card) {
    if (!id || list.some(item => item.id === id)) return;
    list.push({ id, card: card || null });
  }

  function candidates() {
    const list = [];
    if (lastContext?.path === currentPath() && Date.now() - lastContext.time <= CONTEXT_TTL) {
      const context = lastContext;
      const card = context.card?.isConnected ? context.card : null;
      push(list, cardId(card) || context.postId, card || context.card);
      const under = context.point && typeof document.elementFromPoint === "function"
        ? findCard(elementOf(document.elementFromPoint(context.point.x, context.point.y))) : null;
      push(list, cardId(under), under);
    }
    if (lastHover?.path === currentPath() && Date.now() - lastHover.time <= HOVER_TTL) {
      const card = lastHover.card?.isConnected ? lastHover.card : null;
      push(list, cardId(card) || lastHover.postId, card || lastHover.card);
    }
    push(list, lib.postIdFromUrl(location.href), null);
    return list;
  }

  function requestPost(postId) {
    return new Promise(resolve => {
      const requestId = crypto.randomUUID();
      const finish = post => {
        clearTimeout(timer);
        window.removeEventListener("message", listener);
        resolve(post);
      };
      const listener = event => {
        if (event.source !== window || event.origin !== location.origin || event.data?.type !== "BID_X_RESPONSE" || event.data.requestId !== requestId) return;
        // The main-world bridge only forwards the raw response; parsing stays here.
        const raw = event.data.post;
        let parsed = null;
        try { parsed = raw ? lib.parseTweet(raw) : null; } catch { parsed = null; }
        finish(parsed);
      };
      const timer = setTimeout(() => finish(null), 1500);
      window.addEventListener("message", listener);
      window.postMessage({ type: "BID_X_REQUEST", requestId, postId }, location.origin);
    });
  }

  function handleFromUrl(raw) {
    try {
      const url = new URL(raw);
      if (!/^(www\.)?(x|twitter)\.com$/i.test(url.hostname)) return null;
      const [first] = url.pathname.split("/").filter(Boolean);
      if (!first || /^(i|home|explore|search|settings|notifications|messages|compose)$/i.test(first)) return null;
      return first;
    } catch { return null; }
  }

  function authorFromCard(card) {
    for (const block of card?.querySelectorAll('[data-testid="User-Name"]') || []) {
      for (const link of block.querySelectorAll("a[href]")) {
        const handle = handleFromUrl(link.href);
        if (handle) return handle;
      }
    }
    return null;
  }

  function pagePictures(card, postId) {
    const pictures = [];
    const seen = new Set();
    for (const img of card ? ownNodes(card, PHOTO) : []) {
      // A quoted post's photos link to their own post; they are not this post's media.
      const ownerId = lib.postIdFromUrl(img.closest('a[href*="/status/"]')?.href);
      if (ownerId && ownerId !== postId) continue;
      const url = lib.imageUrl(img.currentSrc || img.src || img.getAttribute("src") || "");
      if (!url || seen.has(url)) continue;
      seen.add(url);
      pictures.push({ id: String(pictures.length + 1), url });
    }
    return pictures;
  }

  // Last resort: read the media the page already renders when the post's API
  // response was not observed (reloaded extension, server-rendered timeline).
  function pageMedia(postId, card) {
    const pictures = pagePictures(card, postId);
    const hasVideo = Boolean(card && ownNodes(card, VIDEO).length);
    if (!pictures.length && !hasVideo) return null;
    const author = authorFromCard(card) || handleFromUrl(location.href) || "未知作者";
    return {
      postId,
      author,
      userId: author,
      pictures,
      videos: [],
      pictureMissing: 0,
      videoMissing: hasVideo ? 1 : 0,
      qualitySource: "page",
      qualityWarning: `未能读取帖子接口数据，已改用页面上显示的图片原图地址${hasVideo ? "；视频需要刷新页面、等帖子加载完成后重试" : ""}`
    };
  }

  function usable(post, id) {
    if (!post || post.postId !== id) return null;
    const missing = (post.videoMissing || 0) + (post.pictureMissing || 0);
    if (post.pictures?.length || post.videos?.length || missing) {
      return { ...post, missing, imageMissing: post.pictureMissing || 0 };
    }
    return null;
  }

  async function resolvePost() {
    const list = candidates();
    if (!list.length) throw new Error("未找到右键所在的 X 帖子：请在帖子的文字、图片或视频上右键后重试");
    let captured = false;
    for (const { id, card } of list) {
      const post = await requestPost(id);
      if (!post || post.postId !== id) continue;
      captured = true;
      const media = usable(post, id);
      if (media) return media;
      const fallback = pageMedia(id, card);
      if (fallback) return { ...fallback, missing: fallback.videoMissing };
    }
    if (!captured) {
      for (const { id, card } of list) {
        const fallback = pageMedia(id, card);
        if (fallback) return { ...fallback, missing: fallback.videoMissing };
      }
      throw new Error("尚未取得这篇 X 帖子的媒体数据：请刷新页面，等帖子完全加载后重试");
    }
    throw new Error("这篇 X 帖子没有图片或视频");
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
