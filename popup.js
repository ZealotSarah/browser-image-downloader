const summary = document.getElementById("summary");
const errors = document.getElementById("errors");
const copyImages = document.getElementById("copy-images");
const copyVideos = document.getElementById("copy-videos");
const copyStatus = document.getElementById("copy-status");
let currentJobId = null;
let copying = false;

async function copyFiles(kind) {
  copying = true;
  copyImages.disabled = copyVideos.disabled = true;
  copyStatus.textContent = "正在复制文件…";
  try {
    const result = await chrome.runtime.sendMessage({ type: "COPY_POST_FILES", kind, jobId: currentJobId });
    if (!result?.ok) throw new Error(result?.error || "复制失败，请重新打开插件重试");
    copyStatus.textContent = `已复制 ${result.count} 个文件，到 QQ／微信群聊按 Ctrl+V 粘贴，再确认发送。`;
  } catch (error) {
    copyStatus.textContent = error.message;
  } finally {
    copying = false;
    await render();
  }
}

copyImages.addEventListener("click", () => copyFiles("image"));
copyVideos.addEventListener("click", () => copyFiles("video"));

document.getElementById("open-options").addEventListener("click", () => chrome.runtime.openOptionsPage());

async function render() {
  const { job } = await chrome.storage.local.get("job");
  currentJobId = job?.id || null;
  copyImages.disabled = copying || !job || job.status === "running" || !job.images.some(image => image.kind === "image");
  copyVideos.disabled = copying || !job || job.status === "running" || !job.images.some(image => image.kind === "video");
  errors.replaceChildren();
  if (!job) {
    summary.textContent = "在微博、Instagram 或 X 帖子上右键，选择“下载这篇帖子的图片和视频”，自动识别并保存。";
    return;
  }
  const complete = job.images.filter(image => image.state === "complete").length;
  const skipped = job.images.filter(image => image.state === "skipped").length;
  const existing = job.images.filter(image => image.state === "existing").length;
  const failed = job.images.filter(image => image.state === "failed").length + job.missing;
  const total = job.images.length + job.missing;
  summary.textContent = `${job.author} · ${job.status === "running" ? "下载中" : "已完成"}：${complete}/${total} 个文件成功${existing ? `，${existing} 个文件已存在并跳过` : ""}${skipped ? `，${skipped} 张屏蔽图跳过` : ""}，${failed} 个文件失败`;
  const videos = job.images.filter(item => item.kind === "video");
  const hasPictures = job.images.some(item => item.kind === "image");
  if (videos.length) {
    summary.textContent += "。规格：接口可用的最高规格完整视频。";
    summary.textContent += videos.map(video =>
      `视频 ${video.index + 1}：${video.width}×${video.height}${video.fps ? ` · ${video.fps} fps` : ""}${video.bitrate ? ` · ${video.bitrate} bit/s` : ""}`
    ).join("；");
  }
  if (hasPictures && ["instagram", "x"].includes(job.site)) {
    summary.textContent += job.site === "x" ? "。画质：X orig 尺寸。" : job.qualitySource === "media" ? "。画质：帖子接口最大尺寸。" : "。画质：页面最大尺寸。";
    summary.textContent += "WebP 同时保存原文件和 PNG 副本。";
  }
  if (job.qualityWarning) addError(job.qualityWarning);
  if (job.imageMissing) addError(`${job.imageMissing} 个原图或 Live 动态文件地址未能解析，未开始下载`);
  if (job.videoMissing) addError(`${job.videoMissing} 个视频没有可确认规格的完整文件，分片流及分离音视频暂不支持`);
  if (job.missing && !job.imageMissing && !job.videoMissing) addError(`${job.missing} 个媒体地址未能解析，未开始下载`);
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
