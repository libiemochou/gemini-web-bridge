// Gemini 网页桥接 - 后台脚本
// 职责：①长轮询本地桥接程序拿任务 ②转给 Gemini 页面里的 content.js ③把结果回传
// 说明：页面脚本受网页 CSP/CORS 限制，所有对 localhost 的请求都从这里走
const BASE = "http://127.0.0.1:8080";

let pumping = false;
let pageBusy = false;
let openedByUs = false;   // 这个 Gemini 标签页是不是我们开的（是的话干完活关掉）
let dlTaskId = null;               // 生图任务：等"下载完整尺寸"的文件落地
const ourDownloads = new Map();    // 下载id -> 归属任务id（登记时钉死，防张冠李戴）
let busyTaskId = null;             // 正在跑的任务（看门狗用）
let busyTimer = null;              // 跑太久/页面被刷新的兜底
let busyTicks = 0;                 // 干活期间的心跳计数（防后台休眠）

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function ensureGeminiTab() {
  const tabs = await chrome.tabs.query({ url: "https://gemini.google.com/*" });
  if (tabs && tabs.length) {
    // 别让浏览器把这个标签页"内存回收"掉（回收会杀掉插件脚本、任务断线）
    try { await chrome.tabs.update(tabs[0].id, { autoDiscardable: false }); } catch (e) {}
    return tabs[0];
  }
  // 平时不占浏览器：需要干活时才开（后台标签页），干完自动关
  try {
    const tab = await chrome.tabs.create({ url: "https://gemini.google.com/app", active: false });
    try { await chrome.tabs.update(tab.id, { autoDiscardable: false }); } catch (e) {}
    openedByUs = true;
    return tab;
  } catch (e) {
    return null;
  }
}

async function sendTaskToTab(tabId, task) {
  // 新开的页面要等它把插件脚本加载起来，最多等约 45 秒
  for (let i = 0; i < 45; i++) {
    try {
      const resp = await chrome.tabs.sendMessage(tabId, { type: "gw-ask", task: task });
      if (resp && resp.accepted) return true;
    } catch (e) { /* 还没加载好，继续等 */ }
    await sleep(1000);
  }
  return false;
}

async function bringTabForward(tab) {
  // 后台标签会被浏览器冻结渲染，导致"发出去了但页面不更新"。
  // 干活期间把页面切到前台，干完自然有人（用户或我们的关闭逻辑）收场。
  try {
    await chrome.tabs.update(tab.id, { active: true });
    if (tab.windowId != null) {
      await chrome.windows.update(tab.windowId, { focused: true });
    }
  } catch (e) { /* 切不过去就凑合在后台干 */ }
}

async function postResult(id, text, error, images, downloaded) {
  try {
    await fetch(BASE + "/x/result", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: id, text: text, error: error || null,
        images: images || [], downloaded: !!downloaded
      })
    });
  } catch (e) {
    // 桥接程序没开，等下一轮
  }
}

async function pump() {
  if (pumping) return;
  pumping = true;
  try {
    while (true) {
      if (pageBusy) {
        // 干活期间保持一点网络活动，防止 MV3 后台被浏览器休眠、内存状态丢失
        busyTicks++;
        if (busyTicks % 20 === 0) {
          fetch(BASE + "/x/status", { cache: "no-store" }).catch(() => {});
        }
        await sleep(1000);
        continue;
      }
      let r;
      try {
        r = await fetch(BASE + "/x/poll", { cache: "no-store" });
      } catch (e) {
        await sleep(3000);
        continue;
      }
      if (r.status === 204) continue;
      if (!r.ok) {
        await sleep(2000);
        continue;
      }
      let task;
      try {
        task = await r.json();
      } catch (e) {
        continue;
      }
      if (!task || !task.id) continue;
      // 签收：防止任务被"已经死掉的旧轮询线"接走没人干活（12 秒没签收服务端会重发）
      fetch(BASE + "/x/ack", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: task.id })
      }).catch(() => {});

      const tab = await ensureGeminiTab();
      if (!tab) {
        await postResult(task.id, null,
          "打不开 Gemini 页面。检查：浏览器是否可用？梯子是否开着？");
        continue;
      }
      await bringTabForward(tab);
      const ok = await sendTaskToTab(tab.id, task);
      if (ok) {
        pageBusy = true;
        busyTaskId = task.id;
        clearTimeout(busyTimer);
        busyTimer = setTimeout(() => {
          if (pageBusy) {
            postResult(busyTaskId, null, "任务疑似中断（页面被刷新或卡死），请再试一次");
            pageBusy = false;
            busyTaskId = null;
          }
        }, 360000);
        if (task.want === "image" || task.action === "download-last") dlTaskId = task.id;
      } else {
        await postResult(task.id, null,
          "Gemini 页面加载不出来（等太久了）。检查梯子/网络，然后再试一次。");
        if (openedByUs) {
          try { await chrome.tabs.remove(tab.id); } catch (e) {}
          openedByUs = false;
        }
      }
    }
  } finally {
    pumping = false;
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg) return;
  if (msg.type === "gw-result") {
    pageBusy = false;
    clearTimeout(busyTimer);
    busyTaskId = null;
    postResult(msg.id, msg.text, msg.error, msg.images, msg.downloaded).then(() => {
      // 临时开的干活页面，用完就收（只有自己开的才关）
      if (openedByUs && sender && sender.tab && sender.tab.id != null) {
        chrome.tabs.remove(sender.tab.id).catch(() => {});
        openedByUs = false;
      }
    });
    sendResponse({ ok: true });
  } else if (msg.type === "gw-page-ready") {
    // 页面（重新）加载 = 之前派给旧页面的任务已经死了，别把队列卡住
    pageBusy = false;
    busyTaskId = null;
    clearTimeout(busyTimer);
    pump();
    sendResponse({ ok: true });
  } else if (msg.type === "gw-keepalive") {
    // 页面心跳：防止后台被浏览器回收，顺带确保轮询活着
    pump();
    sendResponse({ ok: true });
  } else if (msg.type === "gw-diag") {
    const payload = msg.data || {};
    // 附上最近的浏览器下载记录（排查"下载按钮点了不落地"的第一手证据）
    const post = () => fetch(BASE + "/x/diag", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    }).catch(() => {});
    try {
      chrome.downloads.search({ limit: 8, orderBy: ["-startTime"] }, (items) => {
        payload.recentDownloads = (items || []).map((d) => ({
          file: String(d.filename || "").slice(0, 140),
          url: String(d.url || "").slice(0, 100),
          finalUrl: String(d.finalUrl || "").slice(0, 100),
          state: d.state,
          error: d.error || "",
          when: d.startTime || ""
        }));
        post();
      });
    } catch (e) {
      post();
    }
    sendResponse({ ok: true });
  }
  return false;
});

// ---------- "下载完整尺寸"通道：按浏览器默认存到"下载"文件夹，只登记不搬家 ----------
chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
  try {
    const fn = item.filename || "";
    const ref = item.referrer || "";
    const isImage = String(item.mime || "").indexOf("image/") === 0;
    const isGemini = /gemini/i.test(fn) || /gemini\.google\.com/.test(ref)
                     || /gemini\.google\.com/.test(String(item.url || ""));
    if (dlTaskId && (isImage || isGemini)) {
      ourDownloads.set(item.id, dlTaskId);   // 登记时就把"这一单归谁"钉死
    }
  } catch (e) {}
  suggest();   // 保存位置和文件名都用浏览器的默认（就是"下载"文件夹）
});

chrome.downloads.onChanged.addListener((delta) => {
  if (!delta.state || delta.state.current !== "complete") return;
  if (!ourDownloads.has(delta.id)) return;
  const tid = ourDownloads.get(delta.id);
  ourDownloads.delete(delta.id);
  chrome.downloads.search({ id: delta.id }, (items) => {
    const it = items && items[0];
    if (it && it.filename && tid) {
      fetch(BASE + "/x/dl", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: tid, file: it.filename })   // 报给它原本那一单
      }).catch(() => {});
      if (dlTaskId === tid) dlTaskId = null;
    }
  });
});

// 后台每次被唤醒都确保轮询在跑
pump();
