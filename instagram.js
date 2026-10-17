(() => {
  let lastContext = null;

  function postCard(target) {
    const article = target?.closest("article");
    if (article) return article;
    const postId = VideoDownloads.instagramPostId(location.href);
    if (!postId) return null;
    // Detail pages may use only divs. Stop before reaching other posts.
    for (let node = target; node; node = node.parentElement) {
      const ids = [...node.querySelectorAll("a[href]")]
        .map(link => VideoDownloads.instagramPostId(link.href)).filter(Boolean);
      if (ids.some(id => id !== postId)) return null;
      if (ids.includes(postId) && node.querySelector("img, video")) return node;
      if (node.matches("main, [role='main']") && node.querySelectorAll("video").length === 1) return node;
    }
    return null;
  }

  document.addEventListener("contextmenu", event => {
    const target = event.target instanceof Element ? event.target : event.target?.parentElement;
    const card = postCard(target);
    lastContext = card ? { card, pageUrl: location.href, time: Date.now() } : null;
  }, true);

  function postIdFor(card) {
    const parse = VideoDownloads.instagramPostId;
    for (const link of card.querySelectorAll('a[href]')) {
      const id = parse(link.href);
      if (id) return id;
    }
    return parse(location.href);
  }

  function collectPictures(card, pictures, seen) {
    for (const image of card.querySelectorAll("img")) {
      const box = image.getBoundingClientRect();
      if (box.width < 200 || box.height < 150 || image.closest("header") || image.getAttribute("aria-hidden") === "true" || image.parentElement?.querySelector("video")) continue;
      if (image.closest("a[href*='/stories/']")) continue;
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

  async function resolvePost() {
    const context = lastContext;
    if (!context?.card.isConnected || context.pageUrl !== location.href || Date.now() - context.time > 30000) {
      throw new Error("未找到右键所在的 Instagram 帖子，请在帖子图片上重试");
    }
    const { card } = context;
    const postId = postIdFor(card);
    if (!postId) throw new Error("无法确认这篇 Instagram 帖子的链接");
    let qualityWarning;
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
      if (card.querySelector("video") || /\/(?:reel|reels)\//.test(location.pathname || "")) {
        throw new Error(`无法获取最高规格视频：${error.message}`);
      }
      qualityWarning = `高清帖子数据不可用（${error.message}），本次仅保存页面最大图，清晰度可能较低，也无法确认是否遗漏视频。`;
    }
    const authorLink = [...card.querySelectorAll("header a[href], a[href]")].find(link =>
      /^\/[A-Za-z0-9._]+\/?$/.test(new URL(link.href).pathname));
    const author = authorLink ? new URL(authorLink.href).pathname.split("/")[1] : "未知作者";
    const pictures = [];
    const seen = new Set();
    for (let step = 0; step < 30; step++) {
      collectPictures(card, pictures, seen);
      const next = nextButton(card);
      if (!next) break;
      next.click();
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    collectPictures(card, pictures, seen);
    if (!pictures.length) throw new Error("这篇 Instagram 帖子没有可下载的图片");
    return { postId, author, userId: author, pictures, videos: [], missing: 0, imageMissing: 0, videoMissing: 0, qualitySource: "page", qualityWarning };
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
