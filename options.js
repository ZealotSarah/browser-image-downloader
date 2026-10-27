document.getElementById("install-command").textContent =
  `powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\\install.ps1 -ExtensionId ${chrome.runtime.id}`;
