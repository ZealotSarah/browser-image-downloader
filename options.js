const form = document.getElementById("settings-form");
const subfolder = document.getElementById("subfolder");
const instagramSubfolder = document.getElementById("instagram-subfolder");
const groupByAuthor = document.getElementById("group-by-author");
const message = document.getElementById("message");

chrome.storage.local.get("settings").then(({ settings }) => {
  subfolder.value = settings?.downloadSubfolder ?? "微博原图";
  instagramSubfolder.value = settings?.instagramSubfolder ?? "Instagram图片";
  groupByAuthor.checked = settings?.groupByAuthor ?? true;
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const downloadSubfolder = WeiboImages.normalizeSubfolder(subfolder.value);
    const instagramFolder = WeiboImages.normalizeSubfolder(instagramSubfolder.value);
    await chrome.storage.local.set({ settings: { downloadSubfolder, instagramSubfolder: instagramFolder, groupByAuthor: groupByAuthor.checked } });
    subfolder.value = downloadSubfolder;
    instagramSubfolder.value = instagramFolder;
    message.textContent = "设置已保存";
    message.className = "success";
  } catch (error) {
    message.textContent = error.message;
    message.className = "error";
  }
});
