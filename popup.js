const summary = document.getElementById("summary");
const errors = document.getElementById("errors");

document.getElementById("open-options").addEventListener("click", () => chrome.runtime.openOptionsPage());

async function render() {
  const { job } = await chrome.storage.local.get("job");
  errors.replaceChildren();
  if (!job) {
    summary.textContent = "在微博内容上右键，选择“下载这篇微博的全部原图”。";
    return;
  }
  const complete = job.images.filter(image => image.state === "complete").length;
  const skipped = job.images.filter(image => image.state === "skipped").length;
  const failed = job.images.filter(image => image.state === "failed").length + job.missing;
  const total = job.images.length + job.missing;
  summary.textContent = `${job.author} · ${job.status === "running" ? "下载中" : "已完成"}：${complete}/${total} 个文件成功${skipped ? `，${skipped} 张屏蔽图跳过` : ""}，${failed} 个文件失败`;
  if (job.missing) addError(`${job.missing} 个原图或 Live 动态文件地址不可用`);
  for (const image of job.images.filter(item => item.state === "failed")) {
    addError(`第 ${image.index + 1} 张${image.kind === "live" ? "的 Live 动态文件" : "的原图"}：${image.error}`);
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
