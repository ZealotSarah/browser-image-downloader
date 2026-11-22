(() => {
  const CONTEXT_TTL = 5 * 60 * 1000;
  const HOVER_TTL = 10 * 60 * 1000;
  const POST_LINK = 'a[href*="/p/"], a[href*="/reel/"], a[href*="/reels/"]';
  // Media outside a post card (viewer, player overlay) still belongs to the
  // post the pointer was over, so those right-clicks keep the hover record.
  const MEDIA = "img, video, [role='dialog']";

  let lastContext = null;
  let lastHover = null;

  const elementOf = target => target instanceof Element ? target : target?.parentElement || null;
  const currentPath = () => location.pathname || "/";

  function parsePostId(raw) {
    try { return VideoDownloads.instagramPostId(raw); } catch { return null; }
  }

  function postIdFromCard(card) {
    if (!card || typeof card.querySelectorAll !== "function") return null;
    for (const link of card.querySelectorAll(POST_LINK)) {
      const id = parsePostId(link.href);
      if (id) return id;
    }
    return null;
  }

  function findCard(node) {
    if (!node || typeof node.closest !== "function") return null;
    const article = node.closest("article");
    if (article) return article;
    const pageId = parsePostId(location.href);
    // Detail pages and viewers may use only divs, so climb until the container
    // owns exactly one post and stop before reaching a list of posts.
    for (let el = node; el && typeof el.querySelectorAll === "function"; el = el.parentElement) {
      // The document root always "owns" every post on the page.
      if (el === document.documentElement || el === document.body) break;
      const ids = new Set();
      for (const link of el.querySelectorAll(POST_LINK)) {
        const id = parsePostId(link.href);
        if (id) ids.add(id);
      }
      if (ids.size > 1) return null;
      if (ids.size === 1) {
        const [id] = [...ids];
        if (pageId && id !== pageId) return null;
        if (el.querySelector("img, video")) return el;
        continue;
      }
      // Reels and story-style viewers carry no post link of their own.
      if (el.matches?.("main, [role='main'], div[role='dialog']") && el.querySelector("img, video") &&
        el.querySelectorAll("video").length <= 1) return el;
    }
    return null;
  }

  function soleArticle() {
    if (typeof document.querySelectorAll !== "function") return null;
    const articles = document.querySelectorAll("article");
    return articles.length === 1 ? articles[0] : null;
  }

  function cardForPost(postId) {
    if (!postId || typeof document.querySelectorAll !== "function") return null;
    for (const article of document.querySelectorAll("article")) {
      if (postIdFromCard(article) === postId) return article;
    }
    return null;
  }

  function record(node, point) {
    const card = findCard(node);
    const link = typeof node?.closest === "function" ? node.closest(POST_LINK) : null;
    return {
      card,
      postId: postIdFromCard(card) || parsePostId(link?.href) || null,
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
    if (node?.closest?.(MEDIA) && lastHover) {
      lastHover.time = Date.now();
      lastHover.point = lastContext.point;
      lastHover.path = lastContext.path;
      return;
    }
    lastHover = null;
  }, true);

  // Embedded viewers swallow the right-click, so remember the post the pointer
  // was last over and fall back to it.
  document.addEventListener("pointermove", event => {
    const card = findCard(elementOf(event.target));
    if (!card) return;
    const point = { x: event.clientX, y: event.clientY };
    if (lastHover?.card === card) {
      lastHover.time = Date.now();
      lastHover.point = point;
      return;
    }
    lastHover = { card, postId: postIdFromCard(card), point, path: currentPath(), time: Date.now() };
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
      push(list, postIdFromCard(card) || context.postId, card || context.card);
      const under = context.point && typeof document.elementFromPoint === "function"
        ? findCard(elementOf(document.elementFromPoint(context.point.x, context.point.y))) : null;
      push(list, postIdFromCard(under), under);
    }
    if (lastHover?.path === currentPath() && Date.now() - lastHover.time <= HOVER_TTL) {
      const card = lastHover.card?.isConnected ? lastHover.card : null;
      push(list, postIdFromCard(card) || lastHover.postId, card || lastHover.card);
    }
    push(list, parsePostId(location.href), null);
    // Attach a page container to link-only candidates so the page fallback works.
    const container = list.find(item => item.card)?.card || soleArticle();
    for (const item of list) if (!item.card) item.card = container || null;
    return list;
  }

  function collectPictures(card, postId, pictures, seen) {
    for (const image of card.querySelectorAll("img")) {
      const box = image.getBoundingClientRect();
      if (box.width < 200 || box.height < 150 || image.closest("header") || image.getAttribute("aria-hidden") === "true" || image.parentElement?.querySelector("video")) continue;
      if (image.closest("a[href*='/stories/']")) continue;
      // Photos that link to a different post are recommendations, not this one.
      const linkId = parsePostId(image.closest("a[href]")?.href);
      if (linkId && linkId !== postId) continue;
      const url = InstagramImages.bestImageUrl(image);
      if (!url || seen.has(url)) continue;
      seen.add(url);
      pictures.push({ id: String(pictures.length + 1), url });
    }
  }

  function nextButton(card) {
    return [...card.querySelectorAll("button")].find(button =>
      !button.disabled && /^(next|next photo|下一[张張步页頁])$/i.test(
        button.getAttribute("aria-label") || button.querySelector("svg[aria-label]")?.getAttribute("aria-label") || ""
      ));
  }

  function authorFromPath() {
    // Profile-based permalinks look like /<user>/p/<id>/.
    const match = location.pathname.match(/^\/([A-Za-z0-9._]+)\/(?:p|reel|reels)\//);
    return match && !/^(p|reel|reels)$/i.test(match[1]) ? match[1] : null;
  }

  async function pageMedia(postId, card) {
    if (!card) throw new Error("无法获取这篇 Instagram 帖子的媒体数据：请刷新页面，等帖子加载完成后重试");
    const authorLink = [...card.querySelectorAll("header a[href], a[href]")].find(link => {
      try { return /^\/[A-Za-z0-9._]+\/?$/.test(new URL(link.href).pathname); } catch { return false; }
    });
    let author = "未知作者";
    try { if (authorLink) author = new URL(authorLink.href).pathname.split("/")[1]; }
    catch { /* Keep the placeholder author. */ }
    if (author === "未知作者" && authorFromPath()) author = authorFromPath();
    const pictures = [];
    const seen = new Set();
    for (let step = 0; step < 30; step++) {
      collectPictures(card, postId, pictures, seen);
      const next = nextButton(card);
      if (!next) break;
      next.click();
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    collectPictures(card, postId, pictures, seen);
    if (!pictures.length) throw new Error("这篇 Instagram 帖子没有可下载的图片");
    return { postId, author, userId: author, pictures, videos: [], missing: 0, imageMissing: 0, videoMissing: 0, qualitySource: "page" };
  }

  async function fetchMedia(postId, card) {
    try {
      const mediaId = InstagramImages.mediaIdFromPostId(postId);
      const response = await fetch(`/api/v1/media/${mediaId}/info/`, {
        credentials: "include", headers: { "X-IG-App-ID": "936619743392459" },
        signal: AbortSignal.timeout(10000)
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const json = await response.json();
      const data = InstagramImages.parseMedia(json, postId);
      const videos = VideoDownloads.parseInstagram(json, postId);
      if (!data.pictures.length && !videos.videos.length && !data.missing && !videos.missing) throw new Error("这篇 Instagram 帖子没有可下载的图片或视频");
      return { ...data, videos: videos.videos, missing: data.missing + videos.missing,
        imageMissing: data.missing, videoMissing: videos.missing };
    } catch (error) {
      if (!card) throw new Error(`无法获取这篇 Instagram 帖子的媒体数据（${error.message}）：请刷新页面后重试`);
      // A reel is video-only, so the API is the only usable source.
      if (/\/(?:reel|reels)\//.test(location.pathname || "")) throw new Error(`无法获取最高规格视频：${error.message}`);
      // A photo post can still be saved from the page, so try that before
      // concluding the post is a video we cannot fetch.
      const qualityWarning = `高清帖子数据不可用（${error.message}），本次仅保存页面最大图，清晰度可能较低，也无法确认是否遗漏视频。`;
      try {
        return { ...await pageMedia(postId, card), qualityWarning };
      } catch (pageError) {
        if (card.querySelector("video")) throw new Error(`无法获取最高规格视频：${error.message}`);
        throw pageError;
      }
    }
  }

  async function resolvePost() {
    const list = candidates();
    if (!list.length) throw new Error("未找到右键所在的 Instagram 帖子：请在帖子的图片或视频上右键后重试");
    let lastError = null;
    for (const { id, card } of list) {
      const target = card?.isConnected ? card : cardForPost(id);
      try {
        return await fetchMedia(id, target);
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError || new Error("无法确认这篇 Instagram 帖子的链接");
  }

  function toast(message) {
    document.getElementById("instagram-images-toast")?.remove();
    const node = document.createElement("div");
    node.id = "instagram-images-toast";
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
    if (message?.type === "RESOLVE_MEDIA") {
      resolvePost().then(data => sendResponse({ ok: true, data }))
        .catch(error => sendResponse({ ok: false, error: error.message }));
      return true;
    }
    if (message?.type === "TOAST") toast(message.text);
    return false;
  });
})();
