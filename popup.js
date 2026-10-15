const summary = document.getElementById("summary");
const errors = document.getElementById("errors");

document.getElementById("open-options").addEventListener("click", () => chrome.runtime.openOptionsPage());

async function render() {
  const { job } = await chrome.storage.local.get("job");
  errors.replaceChildren();
  if (!job) {
    summary.textContent = "在微博或 Instagram 帖子上右键，选择图片或最高规格视频下载菜单。";
    return;
  }
  const complete = job.images.filter(image => image.state === "complete").length;
  const skipped = job.images.filter(image => image.state === "skipped").length;
  const failed = job.images.filter(image => image.state === "failed").length + job.missing;
  const total = job.images.length + job.missing;
  summary.textContent = `${job.author} · ${job.status === "running" ? "下载中" : "已完成"}：${complete}/${total} 个文件成功${skipped ? `，${skipped} 张屏蔽图跳过` : ""}，${failed} 个文件失败`;
  if (job.mediaType === "video") {
    summary.textContent += "。规格：接口可用的最高规格完整视频。";
    summary.textContent += job.images.map(video =>
      `视频 ${video.index + 1}：${video.width}×${video.height}${video.fps ? ` · ${video.fps} fps` : ""}${video.bitrate ? ` · ${video.bitrate} bit/s` : ""}`
    ).join("；");
  } else if (job.site === "instagram") {
    summary.textContent += job.qualitySource === "media" ? "。画质：帖子接口最大尺寸。" : "。画质：页面最大尺寸。";
    summary.textContent += "WebP 同时保存原文件和 PNG 副本。";
    if (job.qualityWarning) addError(job.qualityWarning);
  }
  if (job.missing) addError(job.mediaType === "video"
    ? `${job.missing} 个视频没有可确认规格的完整文件，分片流及分离音视频暂不支持`
    : `${job.missing} 个图片或 Live 动态文件地址不可用`);
  for (const image of job.images.filter(item => item.state === "failed")) {
    addError(image.kind === "video" ? `视频 ${image.index + 1}：${image.error}` : `第 ${image.index + 1} 张${image.kind === "png" ? "的 PNG 副本" : image.kind === "live" ? "的 Live 动态文件" : job.site === "instagram" ? "图片" : "的原图"}：${image.error}`);
  }
}

function addError(text) {
  const item = document.createElement("li");
  item.textContent = text;
  errors.append(item);
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.job) render();
});
render();
