const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "manifest.json"), "utf8"));
const entries = manifest.content_scripts || [];

test("首页里同名脚本不会被两个 content_scripts 共用", () => {
  // Chrome injects a file only once per extension, so a script listed in both a
  // MAIN-world entry and an isolated entry never reaches the isolated world;
  // that is what left x.js without XDownloads.
  for (let i = 0; i < entries.length; i++) {
    for (let j = i + 1; j < entries.length; j++) {
      const a = entries[i];
      const b = entries[j];
      const samePage = a.matches.some(pattern => b.matches.includes(pattern));
      if (!samePage) continue;
      const shared = a.js.filter(file => b.js.includes(file));
      assert.deepEqual(shared, [], `条目 ${i} 与 ${j} 在同一页面共用脚本：${shared.join("、")}`);
    }
  }
});

test("X 的 MAIN world 脚本自包含，只依赖自身", () => {
  const main = entries.find(entry => entry.world === "MAIN");
  assert.ok(main, "缺少 MAIN world 条目");
  assert.deepEqual(main.js, ["x-capture.js"]);
  const source = fs.readFileSync(path.join(__dirname, "..", "x-capture.js"), "utf8");
  assert.doesNotMatch(source, /XDownloads\.|VideoDownloads\./);
});

test("X 的隔离世界脚本按依赖顺序加载并注册消息监听", () => {
  const isolated = entries.find(entry => !entry.world && entry.js.includes("x.js"));
  assert.ok(isolated, "缺少 X 隔离世界条目");
  assert.deepEqual(isolated.js, ["video-lib.js", "x-lib.js", "x.js"]);
});

test("Instagram 隔离世界条目按依赖顺序加载", () => {
  const entry = entries.find(item => !item.world && item.js.includes("instagram.js"));
  assert.ok(entry, "缺少 Instagram 条目");
  assert.deepEqual(entry.js, ["instagram-lib.js", "video-lib.js", "instagram.js"]);
});

test("offscreen 页面加载了下载所需的全部脚本", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "offscreen.html"), "utf8");
  const loaded = [...html.matchAll(/<script src="([^"]+)"/g)].map(match => match[1]);
  for (const file of ["lib.js", "instagram-lib.js", "video-lib.js", "x-lib.js", "offscreen.js"]) {
    assert.ok(loaded.includes(file), `offscreen.html 缺少 ${file}`);
  }
});
