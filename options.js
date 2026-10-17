const form = document.getElementById("settings-form");
const instagramSubfolder = document.getElementById("instagram-subfolder");
const instagramVideoSubfolder = document.getElementById("instagram-video-subfolder");
const xSubfolder = document.getElementById("x-subfolder");
const xVideoSubfolder = document.getElementById("x-video-subfolder");
const groupByAuthor = document.getElementById("group-by-author");
const message = document.getElementById("message");

chrome.storage.local.get("settings").then(({ settings }) => {
  instagramSubfolder.value = settings?.instagramSubfolder ?? "Instagram图片";
  instagramVideoSubfolder.value = settings?.instagramVideoSubfolder ?? "Instagram视频";
  xSubfolder.value = settings?.xSubfolder ?? "X图片";
  xVideoSubfolder.value = settings?.xVideoSubfolder ?? "X视频";
  groupByAuthor.checked = settings?.groupByAuthor ?? true;
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const instagramFolder = WeiboImages.normalizeSubfolder(instagramSubfolder.value);
    const instagramVideoFolder = WeiboImages.normalizeSubfolder(instagramVideoSubfolder.value);
    const xFolder = WeiboImages.normalizeSubfolder(xSubfolder.value);
    const xVideoFolder = WeiboImages.normalizeSubfolder(xVideoSubfolder.value);
    await chrome.storage.local.set({ settings: { instagramSubfolder: instagramFolder,
      instagramVideoSubfolder: instagramVideoFolder,
      xSubfolder: xFolder, xVideoSubfolder: xVideoFolder, groupByAuthor: groupByAuthor.checked } });
    instagramSubfolder.value = instagramFolder;
    instagramVideoSubfolder.value = instagramVideoFolder;
    xSubfolder.value = xFolder;
    xVideoSubfolder.value = xVideoFolder;
    message.textContent = "设置已保存";
    message.className = "success";
  } catch (error) {
    message.textContent = error.message;
    message.className = "error";
  }
});
