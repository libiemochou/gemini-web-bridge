// Gemini 网页桥接 - 页面脚本（运行在 gemini.google.com 里）
// 职责：收到任务 → 在页面里自动输入并发送 → 抓回答 → 回传后台脚本
// 注意：选择器可能随 Google 改版失效；脚本会把"哪个选择器还能匹配"上报给桥接程序，方便排查
(() => {
  if (window.__gwBridgeLoaded) return;
  window.__gwBridgeLoaded = true;

  const SEL = {
    input: [
      'rich-textarea .ql-editor[contenteditable="true"]',
      'rich-textarea [contenteditable="true"]',
      '.text-input-field [contenteditable="true"]',
      'div[contenteditable="true"][role="textbox"]',
      'textarea',
    ],
    send: [
      'button[aria-label*="Send" i]',
      'button[aria-label*="发送"]',
      'button.send-button',
      'button[mattooltip*="Send" i]',
    ],
    newChat: [
      'a[aria-label*="New chat" i][href="/app"]',
      'a[aria-label*="New chat" i]',
      'button[aria-label*="New chat" i]',
      'button[aria-label*="新对话"]',
      'button[aria-label*="发起新对话"]',
      'expandable-button[aria-label*="New chat" i]',
    ],
    download: [
      'button[aria-label*="Download" i]',
      'button[aria-label*="下载"]',
      'button[mattooltip*="Download" i]',
      'button[mattooltip*="下载"]',
      'button[data-test-id*="download" i]',
      'button[class*="download" i]',
      '[role="button"][aria-label*="Download" i]',
    ],
    response: [
      'model-response',
      'message-content',
      '.model-response-text',
      '.response-container',
    ],
  };

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const qa = (s) => { try { return [...document.querySelectorAll(s)]; } catch (e) { return []; } };
  const pick = (list) => {
    for (const s of list) {
      const el = qa(s)[0];
      if (el) return { el: el, sel: s };
    }
    return { el: null, sel: null };
  };

  let busy = false;
  const queue = [];

  function sendToBg(msg) {
    try {
      const p = chrome.runtime.sendMessage(msg);
      if (p && p.catch) p.catch(() => {});
    } catch (e) { /* 扩展被停用等情况，忽略 */ }
  }

  // ---------- 自检：把各选择器命中数量上报 ----------
  function diag() {
    const d = { url: location.href, title: document.title, hits: {} };
    for (const group of Object.keys(SEL)) {
      d.hits[group] = {};
      for (const s of SEL[group]) d.hits[group][s] = qa(s).length;
    }
    d.contenteditables = qa('[contenteditable="true"]').length;
    d.textareas = qa('textarea').length;
    d.buttons = qa('button').length;
    // 把页面上能点的控件长相抓出来（用于定位"新对话"等按钮）
    d.controls = [];
    const nodes = document.querySelectorAll('button, [role="button"], a[href], [aria-label], [mattooltip]');
    for (const n of nodes) {
      const label = n.getAttribute("aria-label") || n.getAttribute("mattooltip") || n.getAttribute("title") || "";
      const txt = (n.innerText || "").trim().slice(0, 30);
      if (!label && !txt) continue;
      d.controls.push({
        tag: n.tagName.toLowerCase(),
        label: label.slice(0, 40),
        txt: txt,
        href: n.getAttribute("href") || ""
      });
      if (d.controls.length >= 60) break;
    }
    // 发送按钮/输入框的实时状态（排查"发不出去"用）
    try {
      const btn = pick(SEL.send).el;
      const inp = pick(SEL.input).el;
      d.sendState = {
        btn: btn ? { disabled: !!btn.disabled, aria: btn.getAttribute("aria-disabled") || "" } : null,
        inputChars: inp ? editorText(inp).length : -1,
        via: lastSendVia,
      };
    } catch (e) { d.sendState = String(e); }
    // 整页扫一遍大图（排查"生成了但抓不到"用）
    try {
      const imgs = [];
      collectImages(document.body, imgs, 0);
      d.deepImgs = imgs.map((s) => String(s).slice(0, 60));
    } catch (e) { d.deepImgs = String(e); }
    // 最后一条回答里的按钮清单（找"下载"按钮用）
    try {
      const list = responseNodes();
      const node = list[list.length - 1];
      d.respBtns = [];
      if (node) {
        const scope = node.closest(".response-container") || node;
        for (const b of scope.querySelectorAll("button, [role='button']")) {
          d.respBtns.push({
            label: (b.getAttribute("aria-label") || b.getAttribute("mattooltip") || "").slice(0, 40),
            txt: (b.innerText || "").trim().slice(0, 16),
            cls: String(b.className || "").slice(0, 50),
          });
          if (d.respBtns.length >= 25) break;
        }
      }
    } catch (e) { d.respBtns = String(e); }
    return d;
  }

  // ---------- 页面操作 ----------
  async function ensureFreshChat() {
    const { el } = pick(SEL.newChat);
    if (!el) return;
    el.click();
    // 等旧对话内容从页面上清干净（= 新对话就绪），最多约 10 秒
    for (let i = 0; i < 25; i++) {
      const hasInput = !!pick(SEL.input).el;
      if (hasInput && responseNodes().length === 0) break;
      await sleep(400);
    }
    await sleep(500);
  }

  function editorText(el) {
    if (el.tagName === "TEXTAREA") return el.value || "";
    return el.innerText || el.textContent || "";
  }

  function norm(s) {
    return (s || "")
      .replace(/[\u201c\u201d]/g, '"')
      .replace(/[\u2018\u2019]/g, "'")
      .replace(/\s+/g, " ")
      .trim();
  }

  function textLanded(el, text) {
    if (!el || !el.isConnected) return false;
    const want = norm(text);
    if (!want) return true;
    const got = norm(editorText(el));
    return got.includes(want.slice(0, 40)) && got.includes(want.slice(-40));
  }

  function clearInput(el) {
    if (el.tagName === "TEXTAREA") {
      el.value = "";
      el.dispatchEvent(new Event("input", { bubbles: true }));
      return;
    }
    document.execCommand("selectAll", false, null);
    document.execCommand("delete", false, null);
  }

  async function waitLanded(el, text) {
    for (let i = 0; i < 6; i++) {
      if (textLanded(el, text)) return true;
      await sleep(200);
    }
    return textLanded(el, text);
  }

  async function typePrompt(text) {
    const { el } = pick(SEL.input);
    if (!el) throw new Error("找不到输入框（页面结构可能变了——看桥接程序的自检数据）");
    el.click();
    el.focus();
    await sleep(300);

    // 方案一：模拟"粘贴"——大段文字最快，换行也能完整保留
    clearInput(el);
    await sleep(150);
    try {
      const dt = new DataTransfer();
      dt.setData("text/plain", text);
      el.dispatchEvent(new ClipboardEvent("paste", {
        bubbles: true, cancelable: true, clipboardData: dt
      }));
    } catch (e) { /* 不支持就往下走 */ }
    if (await waitLanded(el, text)) return;

    // 方案二：逐行输入（粘贴没生效时的稳妥做法）
    clearInput(el);
    await sleep(150);
    el.focus();
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (i > 0 && !document.execCommand("insertLineBreak")) {
        document.execCommand("insertParagraph");
      }
      if (lines[i]) document.execCommand("insertText", false, lines[i]);
    }
    if (await waitLanded(el, text)) return;

    // 方案三：直接塞 + 手动事件（最后手段）
    clearInput(el);
    await sleep(150);
    el.textContent = text;
    el.dispatchEvent(new InputEvent("input", {
      bubbles: true, inputType: "insertText", data: text
    }));
    if (await waitLanded(el, text)) return;

    throw new Error("文字只进去了一部分（输入框没吃下整段内容）");
  }

  let lastSendVia = "";

  function inputEmpty() {
    const { el } = pick(SEL.input);
    return !el || !editorText(el).trim();
  }

  function clickFull(el) {
    const opts = { bubbles: true, cancelable: true, view: window };
    try { el.dispatchEvent(new PointerEvent("pointerdown", opts)); } catch (e) {}
    el.dispatchEvent(new MouseEvent("mousedown", opts));
    try { el.dispatchEvent(new PointerEvent("pointerup", opts)); } catch (e) {}
    el.dispatchEvent(new MouseEvent("mouseup", opts));
    el.dispatchEvent(new MouseEvent("click", opts));
  }

  function fireEnter(el) {
    for (const type of ["keydown", "keypress", "keyup"]) {
      el.dispatchEvent(new KeyboardEvent(type, {
        key: "Enter", code: "Enter", keyCode: 13, which: 13,
        bubbles: true, cancelable: true
      }));
    }
  }

  async function clickSend() {
    if (inputEmpty()) throw new Error("输入框里没有内容，发不出去");
    // 按钮和回车交替重试，直到输入框真的被清空（= 确实发出去了）
    for (let round = 0; round < 12; round++) {
      const { el: btn } = pick(SEL.send);
      if (btn && !btn.disabled && btn.getAttribute("aria-disabled") !== "true") {
        clickFull(btn);
        for (let i = 0; i < 4; i++) {
          await sleep(350);
          if (inputEmpty()) { lastSendVia = "按钮"; return; }
        }
      }
      const { el: inp } = pick(SEL.input);
      if (inp) {
        inp.click();
        inp.focus();
        await sleep(120);
        fireEnter(inp);
        for (let i = 0; i < 4; i++) {
          await sleep(350);
          if (inputEmpty()) { lastSendVia = "回车"; return; }
        }
      }
    }
    throw new Error("消息一直发不出去（输入框里还留着字）。点一下 Gemini 页面再试一次。");
  }

  function responseNodes() {
    for (const s of SEL.response) {
      const list = qa(s);
      if (list.length) return list;
    }
    return [];
  }

  // 深层找图：穿透 Shadow DOM，画布也能兜底（生成的图可能藏在奇怪的地方）
  function collectImages(root, out, depth, opts) {
    opts = opts || {};
    if (!root || (depth || 0) > 6 || out.length >= 6) return;
    let nodes = [];
    try { nodes = root.querySelectorAll("img, canvas"); } catch (e) {}
    for (const n of nodes) {
      try {
        if (n.tagName === "CANVAS") {
          if ((n.width || 0) >= 100 && (n.height || 0) >= 100) {
            try {
              const u = n.toDataURL("image/png");
              if (u && !out.includes(u)) out.push(u);
            } catch (e) { /* 画布被污染就算了 */ }
          }
          continue;
        }
        const src = n.currentSrc || n.src || "";
        if (!src || !/^(https?:|blob:|data:)/.test(src)) continue;
        if (opts.blobOnly && !/^(blob:|data:)/.test(src)) continue;
        if (src.includes("avatar") || src.includes("icon")) continue;
        const r = n.getBoundingClientRect ? n.getBoundingClientRect() : { width: 999 };
        if (r.width && r.width < 80) continue;
        if ((n.naturalWidth || 0) > 0 && n.naturalWidth < 64) continue;
        if (!out.includes(src)) out.push(src);
      } catch (e) {}
      if (out.length >= 6) break;
    }
    let all = [];
    try { all = root.querySelectorAll("*"); } catch (e) {}
    for (const el of all) {
      if (el.shadowRoot) collectImages(el.shadowRoot, out, (depth || 0) + 1, opts);
      if (out.length >= 6) return;
    }
  }

  function extractAnswer(node, wide) {
    const md = node.querySelector(".markdown") || node.querySelector("message-content") || node;
    const text = (md.innerText || "").trim();
    const images = [];
    // 搜索范围放大到整个回答容器（图不一定在 model-response 里面）
    const scope = node.closest(".response-container") || node;
    collectImages(scope, images, 0, {});
    if (wide) {
      // 生图任务：整页再兜一遍，只认 blob:/data:（页面图标/头像都是 https，自动排除）；
      // 但"任务开始前就存在的图"（贴进去的参考图、接续模式里的旧图）不算结果
      const all = [];
      collectImages(document.body, all, 0, { blobOnly: true });
      for (const s of all) {
        if (!preBlobSrcs.has(s)) images.push(s);
      }
    }
    return { text: text, images: images.slice(0, 6) };
  }

  // "下载完整尺寸"按钮只有图真的画完、配好下载通道才会出现。
  // 渲染中的半成品预览图也能"稳定"好几秒，光看图稳不稳会把半成品当结果——
  // 所以生图任务拿这个按钮当"确实画完了"的硬信号。
  function hasDownloadButton(node) {
    const scope = node.closest(".response-container") || node;
    for (const s of SEL.download) {
      try { if (scope.querySelector(s)) return true; } catch (e) {}
    }
    return false;
  }

  // 生成中的占位回答（实测原文："正在创建您的图片"）——这时候画的还是参考图/半成品，
  // 且卡片上照样带下载按钮，只有等这段占位文字被真回答换掉才算数
  const CREATING_RE = /正在(创建|生成|绘制)|Creating your image|Generating your image/i;

  async function waitForAnswer(baseline, wantImage) {
    let node = null;
    const t0 = Date.now();
    while (Date.now() - t0 < 45000) {
      const list = responseNodes();
      if (list.length > baseline) {
        node = list[list.length - 1];
        break;
      }
      await sleep(400);
    }
    if (!node) return null;
    // 等回答"定型"：文字+图片连续几次不变就算答完
    // 生图任务特殊：文字常先到、图几秒后才出——必须真的等到图才能收工
    // 注意：每次都重新取"最后一条回答"的元素——页面重新渲染后旧元素会作废
    let lastSig = null;
    let stable = 0;
    const deadline = Date.now() + (wantImage ? 150000 : 240000);
    while (Date.now() < deadline) {
      const list = responseNodes();
      const cur = list[list.length - 1] || node;
      const a = extractAnswer(cur, !!wantImage);
      const sig = a.text + "\u0001" + a.images.join(",");
      if ((a.text || a.images.length) && sig === lastSig) {
        stable++;
        const creating = wantImage && CREATING_RE.test(a.text);
        // 生图任务：必须等"这张新回答自己的下载按钮"出现才算画完——
        // 生成中的占位卡片也能稳定几十秒，绝不能给宽限提前放行（旧图/参考图就是这么漏出去的）
        if (stable >= 3 && (!wantImage || (a.images.length && !creating && hasDownloadButton(cur)))) return a;
      } else {
        stable = 0;
        lastSig = sig;
      }
      await sleep(1200);
    }
    const listEnd = responseNodes();
    const lastNode = listEnd[listEnd.length - 1] || node;
    const a = extractAnswer(lastNode, !!wantImage);
    if (wantImage && !hasDownloadButton(lastNode)) {
      // 顶到超时也没见下载按钮：只回文字（拒答）就如实报，带着图的多半是旧图，宁可报超时
      return (a.text && !a.images.length) ? a : null;
    }
    return (a.text || a.images.length) ? a : null;
  }

  // 图片转 base64（blob: 链接离开页面就失效，必须在页面里当场抓走）
  async function imagesToBase64(urls) {
    const out = [];
    for (const u of (urls || []).slice(0, 4)) {
      try {
        const resp = await fetch(u, { credentials: "include" });
        if (!resp.ok) continue;
        const blob = await resp.blob();
        if (!/^image\//.test(blob.type || "")) continue;
        const dataUrl = await new Promise((res, rej) => {
          const fr = new FileReader();
          fr.onload = () => res(String(fr.result || ""));
          fr.onerror = () => rej(new Error("图片读取失败"));
          fr.readAsDataURL(blob);
        });
        const comma = dataUrl.indexOf(",");
        if (comma > 0) out.push({ mime: blob.type, b64: dataUrl.slice(comma + 1) });
      } catch (e) { /* 单张失败不影响其他 */ }
    }
    return out;
  }

  function b64ToBytes(b64) {
    const bin = atob(b64 || "");
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return arr;
  }

  // 把图片"贴"进输入框（模拟粘贴一个文件）；返回现场证据
  async function attachImage(task) {
    const { el } = pick(SEL.input);
    if (!el) throw new Error("找不到输入框");
    el.click();
    el.focus();
    await sleep(300);
    const bytes = b64ToBytes(task.b64);
    if (!bytes.length) throw new Error("图片数据是空的");
    const file = new File([bytes], task.name || "image.jpg", { type: task.mime || "image/jpeg" });
    const dt = new DataTransfer();
    dt.items.add(file);
    el.dispatchEvent(new ClipboardEvent("paste", {
      bubbles: true, cancelable: true, clipboardData: dt
    }));
    await sleep(2500);
    const btn = pick(SEL.send).el;
    const blobImgs = [...document.querySelectorAll("img")]
      .filter((i) => /^(blob:|data:)/.test(i.currentSrc || i.src || ""))
      .filter((i) => (i.getBoundingClientRect().width || 0) > 40);
    const sendEnabled = !!(btn && !btn.disabled && btn.getAttribute("aria-disabled") !== "true");
    return {
      ok: sendEnabled || blobImgs.length > 0,
      sendEnabled: sendEnabled,
      previewImgs: blobImgs.length,
      editorChars: editorText(el).length,
    };
  }

  // 点"下载完整尺寸"：对话里显示的只是压缩预览，下载通道拿到的才是原图
  async function clickDownloadButtons() {
    const list = responseNodes();
    const node = list[list.length - 1];
    if (!node) return false;
    const scope = node.closest(".response-container") || node;
    // 先把鼠标"放"到图卡上，让悬浮按钮现身
    const img = scope.querySelector("img");
    if (img) {
      for (const t of ["pointerover", "mouseover", "mouseenter", "mousemove"]) {
        try { img.dispatchEvent(new MouseEvent(t, { bubbles: true })); } catch (e) {}
      }
      await sleep(600);
    }
    let clicked = 0;
    for (const s of SEL.download) {
      let btns = [];
      try { btns = scope.querySelectorAll(s); } catch (e) {}
      for (const b of btns) {
        clickFull(b);
        clicked++;
        await sleep(900);
        if (clicked >= 2) return true;   // 一次任务最多触发两张，防手滑
      }
      if (clicked) return true;
    }
    return clicked > 0;
  }

  // ---------- 接续模式：连着的生图任务共用一段对话，不攒新对话 ----------
  let lastImagePath = "";    // 上次生图任务所在的对话
  let lastImageAt = 0;       // 上次生图任务完成时间
  const REUSE_WINDOW_MS = 2 * 3600 * 1000;   // 2 小时内的连单共用一段
  const REUSE_MAX_RESPONSES = 12;            // 但也别让一段对话太长

  async function ensureChatForTask(isImageTask) {
    const samePath = !!lastImagePath && location.pathname === lastImagePath;
    const reusable = !!isImageTask && samePath
                     && (Date.now() - lastImageAt) < REUSE_WINDOW_MS
                     && responseNodes().length > 0
                     && responseNodes().length < REUSE_MAX_RESPONSES;
    if (reusable) {
      await sleep(400);   // 接着上一段继续，不点"新对话"
    } else {
      await ensureFreshChat();
    }
  }

  // 任务开跑前"拍张照"：登记页面上已存在的图（参考图/旧图），找结果时一律不算数
  let preBlobSrcs = new Set();

  function snapshotPreImages() {
    const cur = [];
    collectImages(document.body, cur, 0, { blobOnly: true });
    preBlobSrcs = new Set(cur);
  }

  // ---------- 任务处理 ----------
  async function doTask(task) {
    const wantImage = task.want === "image" || task.action === "img2img";
    if (task.action === "attach") {
      // 只上传不发送：把一张本地图片"贴"进 Gemini 输入框（图生图的地基）
      await ensureFreshChat();
      const r = await attachImage(task);
      sendToBg({ type: "gw-result", id: task.id,
                 text: JSON.stringify({ sendEnabled: r.sendEnabled, previewImgs: r.previewImgs, editorChars: r.editorChars }),
                 images: [] });
      return;
    }
    if (task.action === "download-last") {
      // 只下载不生成：直接点当前页面上最后一条回答里的"下载完整尺寸"
      const ok = await clickDownloadButtons();
      if (!ok) throw new Error("没找到下载按钮（当前页面上的回答里可能没有图）");
      sendToBg({ type: "gw-result", id: task.id, text: "", images: [], downloaded: true });
      return;
    }
    await ensureChatForTask(wantImage);
    if (task.action === "img2img") {
      // 一条龙图生图：先把参考图贴进去，再打字发送——同一个对话里完成
      const r = await attachImage(task);
      if (!r.ok) throw new Error("参考图没贴进去：" + JSON.stringify(r));
    }
    if (wantImage) snapshotPreImages();   // 登记贴进去的参考图/旧图，之后不算结果
    const baseline = responseNodes().length;   // 发送前先数好，防止回答来得太快漏检
    await typePrompt(task.prompt);
    // 打字完成、发送之前的现场自检（顺便抓发送按钮的真实长相）
    sendToBg({ type: "gw-diag", data: diag() });
    await clickSend();
    const answer = await waitForAnswer(baseline, wantImage);
    if (!answer) throw new Error("没等到回答（超时，或页面结构变了——看桥接程序的自检数据）");
    let images = [];
    if (answer.images && answer.images.length) {
      images = await imagesToBase64(answer.images);   // 预览版兜底（很快，防下载通道翻车）
    }
    let downloaded = false;
    if (wantImage) {
      // 再走"下载完整尺寸"通道拿原图（对话里的图是压缩预览，清晰度差很多）
      downloaded = await clickDownloadButtons();
    }
    sendToBg({ type: "gw-result", id: task.id, text: answer.text, images: images, downloaded: downloaded });
    if (wantImage) {
      lastImagePath = location.pathname;   // 记下这段对话，下一单接着用
      lastImageAt = Date.now();
    }
  }

  async function processQueue() {
    if (busy) return;
    busy = true;
    try {
      while (queue.length) {
        const t = queue.shift();
        try {
          await doTask(t);
        } catch (e) {
          sendToBg({ type: "gw-result", id: t.id, error: String((e && e.message) || e) });
        }
        sendToBg({ type: "gw-diag", data: diag() });
      }
    } finally {
      busy = false;
    }
  }

  // ---------- 启动 ----------
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg && msg.type === "gw-ask" && msg.task) {
      queue.push(msg.task);
      sendResponse({ accepted: true });
      processQueue();
    }
    return false;
  });

  // 心跳（保后台活着）+ 定期上报自检数据
  setInterval(() => {
    sendToBg({ type: "gw-keepalive" });
    sendToBg({ type: "gw-diag", data: diag() });
  }, 15000);
  sendToBg({ type: "gw-page-ready" });   // 告诉后台：这个页面是新加载的
  sendToBg({ type: "gw-diag", data: diag() });
  setTimeout(() => sendToBg({ type: "gw-diag", data: diag() }), 6000);
})();
