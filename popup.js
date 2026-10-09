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
  const failed = job.images.filter(image => image.state === "failed").length + job.missing;
  const total = job.images.length + job.missing;
  summary.textContent = `${job.author} · ${job.status === "running" ? "下载中" : "已完成"}：${complete}/${total} 张成功，${failed} 张失败`;
  if (job.missing) addError(`${job.missing} 张图片没有可确认的原图地址`);
  for (const image of job.images.filter(item => item.state === "failed")) {
    addError(`第 ${image.index + 1} 张：${image.error}`);
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
