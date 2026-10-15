const form = document.getElementById("settings-form");
const subfolder = document.getElementById("subfolder");
const instagramSubfolder = document.getElementById("instagram-subfolder");
const weiboVideoSubfolder = document.getElementById("weibo-video-subfolder");
const instagramVideoSubfolder = document.getElementById("instagram-video-subfolder");
const groupByAuthor = document.getElementById("group-by-author");
const message = document.getElementById("message");

chrome.storage.local.get("settings").then(({ settings }) => {
  subfolder.value = settings?.downloadSubfolder ?? "微博原图";
  instagramSubfolder.value = settings?.instagramSubfolder ?? "Instagram图片";
  weiboVideoSubfolder.value = settings?.weiboVideoSubfolder ?? "微博视频";
  instagramVideoSubfolder.value = settings?.instagramVideoSubfolder ?? "Instagram视频";
  groupByAuthor.checked = settings?.groupByAuthor ?? true;
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const downloadSubfolder = WeiboImages.normalizeSubfolder(subfolder.value);
    const instagramFolder = WeiboImages.normalizeSubfolder(instagramSubfolder.value);
    const weiboVideoFolder = WeiboImages.normalizeSubfolder(weiboVideoSubfolder.value);
    const instagramVideoFolder = WeiboImages.normalizeSubfolder(instagramVideoSubfolder.value);
    await chrome.storage.local.set({ settings: { downloadSubfolder, instagramSubfolder: instagramFolder,
      weiboVideoSubfolder: weiboVideoFolder, instagramVideoSubfolder: instagramVideoFolder, groupByAuthor: groupByAuthor.checked } });
    subfolder.value = downloadSubfolder;
    instagramSubfolder.value = instagramFolder;
    weiboVideoSubfolder.value = weiboVideoFolder;
    instagramVideoSubfolder.value = instagramVideoFolder;
    message.textContent = "设置已保存";
    message.className = "success";
  } catch (error) {
    message.textContent = error.message;
    message.className = "error";
  }
});
