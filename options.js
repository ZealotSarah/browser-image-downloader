const form = document.getElementById("settings-form");
const subfolder = document.getElementById("subfolder");
const groupByAuthor = document.getElementById("group-by-author");
const message = document.getElementById("message");

chrome.storage.local.get("settings").then(({ settings }) => {
  subfolder.value = settings?.downloadSubfolder ?? "微博原图";
  groupByAuthor.checked = settings?.groupByAuthor ?? true;
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const downloadSubfolder = WeiboImages.normalizeSubfolder(subfolder.value);
    await chrome.storage.local.set({ settings: { downloadSubfolder, groupByAuthor: groupByAuthor.checked } });
    subfolder.value = downloadSubfolder;
    message.textContent = "设置已保存";
    message.className = "success";
  } catch (error) {
    message.textContent = error.message;
    message.className = "error";
  }
});
