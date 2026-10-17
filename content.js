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

  async function fetchStatus(id) {
    const response = await fetch(`/ajax/statuses/show?id=${encodeURIComponent(id)}&locale=zh-CN&isGetLongText=true`, {
      credentials: "same-origin",
      headers: { Accept: "application/json", "X-Requested-With": "XMLHttpRequest" }
    });
    if (!response.ok) throw new Error(`微博详情获取失败（HTTP ${response.status}），请检查登录状态`);
    const status = await response.json();
    if (status?.error) throw new Error(`微博详情获取失败：${status.error}`);
    return status;
  }

  function pictureIds(status) {
    return [...(status.pic_ids || []), ...(status.pics || []).map(pic => pic.pid || pic.pic_id || pic.id),
      ...(status.mix_media_info?.items || []).filter(item => item.type === "pic")
        .map(item => item.data?.pic_id || item.data?.pid || item.data?.id)].filter(Boolean).map(String);
  }

  async function resolvePost() {
    const context = lastContext;
    if (!context?.id || !context.card.isConnected || context.pageUrl !== location.href || Date.now() - context.time > 30000) {
      throw new Error("未找到右键所在的微博，请在微博内容区域重试");
    }

    const status = await fetchStatus(context.id);
    // Retweet responses can mirror the original video on the outer status,
    // while keeping its photos only inside retweeted_status.
    const ownPictures = status.pic_ids?.length || status.pics?.some(pic => pic?.type !== "video") ||
      status.mix_media_info?.items?.some(item => item?.type === "pic");
    let useRetweet = Boolean(status.retweeted_status && !ownPictures);
    let source = { ...(useRetweet ? status.retweeted_status : status), retweeted_status: null };
    let pictures = WeiboImages.parseStatus(source);
    let qualityWarning;
    const original = status.retweeted_status;
    const originalId = original?.idstr || original?.id || original?.mblogid;
    if (originalId && pictures.missing) {
      try {
        const complete = await fetchStatus(originalId);
        if (original.idstr && String(complete.idstr || complete.id) !== String(original.idstr)) throw new Error("返回的原微博编号不匹配");
        if (!useRetweet) {
          const ids = pictureIds(source);
          const originalIds = new Set(pictureIds(complete));
          if (!ids.length || !ids.every(id => originalIds.has(id))) throw new Error("无法确认缺失图片属于原微博，保留当前帖媒体");
          useRetweet = true;
        }
        source = { ...complete, retweeted_status: null };
        pictures = WeiboImages.parseStatus(source);
      } catch (error) {
        qualityWarning = `原微博图片详情补全失败：${error.message}`;
      }
    }
    let videos = VideoDownloads.parseWeibo(source);
    if (useRetweet && !videos.videos.length && !videos.missing) {
      videos = VideoDownloads.parseWeibo({ ...status, retweeted_status: null });
    }
    const missing = pictures.missing + videos.missing;
    if (!pictures.pictures.length && !videos.videos.length && !missing) throw new Error("这篇微博没有可下载的图片或视频");
    return { ...pictures, videos: videos.videos, missing, imageMissing: pictures.missing, videoMissing: videos.missing, qualityWarning,
      postId: String(source.idstr || source.id || context.id) };
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
    if (message?.type === "RESOLVE_MEDIA") {
      resolvePost().then(data => sendResponse({ ok: true, data }))
        .catch(error => sendResponse({ ok: false, error: error.message }));
      return true;
    }
    if (message?.type === "TOAST") toast(message.text);
    return false;
  });
})();
