// background.js — service worker
// Membuka panel kontrol (window terpisah) saat icon extension diklik,
// dan merelay pesan antara panel kontrol dan content script di tab Meta Business Suite.

const CONTROL_URL = chrome.runtime.getURL("control.html");
const CONTROL_WIN_KEY = "autoPosting.controlWindowId";

// Buka / fokus ke control window
async function openControlWindow() {
  const stored = await chrome.storage.session.get(CONTROL_WIN_KEY);
  const existingId = stored[CONTROL_WIN_KEY];

  if (existingId) {
    try {
      const win = await chrome.windows.get(existingId, { populate: false });
      if (win) {
        await chrome.windows.update(existingId, { focused: true, state: "normal" });
        return win;
      }
    } catch (e) {
      // window sudah tertutup, lanjut buat baru
    }
  }

  const win = await chrome.windows.create({
    url: CONTROL_URL,
    type: "popup",
    width: 520,
    height: 760,
    focused: true,
  });
  await chrome.storage.session.set({ [CONTROL_WIN_KEY]: win.id });
  return win;
}

chrome.action.onClicked.addListener(() => {
  openControlWindow().catch((err) => console.error("Failed to open control window:", err));
});

chrome.windows.onRemoved.addListener(async (windowId) => {
  const stored = await chrome.storage.session.get(CONTROL_WIN_KEY);
  if (stored[CONTROL_WIN_KEY] === windowId) {
    await chrome.storage.session.remove(CONTROL_WIN_KEY);
  }
});

// Relay pesan (opsional). Control panel mengirim langsung ke tab via chrome.tabs.sendMessage,
// jadi background hanya menangani actions seperti "FIND_BUSINESS_TAB" dan "PING".
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.type) return;

  if (msg.type === "FIND_BUSINESS_TAB") {
    chrome.tabs
      .query({ url: ["https://business.facebook.com/*", "https://*.facebook.com/*"] })
      .then(async (tabs) => {
        // Prioritaskan tab dengan URL yang mengandung 'composer' / 'bulk'
        const ranked = tabs
          .map((t) => ({
            tab: t,
            score:
              (t.url && t.url.includes("composer") ? 2 : 0) +
              (t.url && t.url.toLowerCase().includes("bulk") ? 2 : 0) +
              (t.active ? 1 : 0),
          }))
          .sort((a, b) => b.score - a.score);
        sendResponse({ ok: true, tab: ranked[0]?.tab ?? null, all: tabs });
      })
      .catch((err) => sendResponse({ ok: false, error: String(err) }));
    return true; // async
  }

  if (msg.type === "PING_CONTENT") {
    const tabId = msg.tabId;
    chrome.tabs
      .sendMessage(tabId, { type: "PING" })
      .then((res) => sendResponse({ ok: true, res }))
      .catch((err) => sendResponse({ ok: false, error: String(err) }));
    return true;
  }

  // Click .click() di MAIN world (untuk bypass isTrusted check / React main-world listeners)
  if (msg.type === "CLICK_IN_MAIN_WORLD") {
    const tabId = msg.tabId || sender.tab?.id;
    const selector = msg.selector;
    if (!tabId || !selector) {
      sendResponse({ ok: false, error: "missing tabId or selector" });
      return;
    }
    chrome.scripting
      .executeScript({
        target: { tabId },
        world: "MAIN",
        func: (sel) => {
          const els = document.querySelectorAll(sel);
          const out = [];
          for (const el of els) {
            try {
              if (typeof el.focus === "function") el.focus();
              el.click();
              out.push({ ok: true, tag: el.tagName, role: el.getAttribute("role") });
            } catch (e) {
              out.push({ ok: false, err: String(e) });
            }
          }
          return { count: els.length, results: out };
        },
        args: [selector],
      })
      .then((res) => sendResponse({ ok: true, res }))
      .catch((err) => sendResponse({ ok: false, error: String(err) }));
    return true;
  }

  // Set input[type=file].files di MAIN world via DataTransfer (bypass isolated world boundary)
  if (msg.type === "SET_FILES_IN_MAIN_WORLD") {
    const tabId = msg.tabId || sender.tab?.id;
    const selector = msg.selector;
    const fileSpecs = msg.files; // [{name, type, lastModified, b64}]
    if (!tabId || !selector || !Array.isArray(fileSpecs)) {
      sendResponse({ ok: false, error: "missing tabId/selector/files" });
      return;
    }
    chrome.scripting
      .executeScript({
        target: { tabId },
        world: "MAIN",
        func: (sel, specs) => {
          function b64ToBytes(b64) {
            const bin = atob(b64);
            const len = bin.length;
            const bytes = new Uint8Array(len);
            for (let i = 0; i < len; i++) bytes[i] = bin.charCodeAt(i);
            return bytes;
          }
          const input = document.querySelector(sel);
          if (!input) return { ok: false, error: "input not found in main world" };
          try {
            const dt = new DataTransfer();
            for (const s of specs) {
              const bytes = b64ToBytes(s.b64);
              const blob = new Blob([bytes], { type: s.type || "application/octet-stream" });
              const file = new File([blob], s.name, {
                type: blob.type,
                lastModified: s.lastModified || Date.now(),
              });
              dt.items.add(file);
            }
            const proto = HTMLInputElement.prototype;
            const setter = Object.getOwnPropertyDescriptor(proto, "files")?.set;
            if (setter) setter.call(input, dt.files);
            else input.files = dt.files;
            input.dispatchEvent(new Event("change", { bubbles: true }));
            input.dispatchEvent(new Event("input", { bubbles: true }));
            return { ok: true, count: dt.files.length };
          } catch (e) {
            return { ok: false, error: String(e) };
          }
        },
        args: [selector, fileSpecs],
      })
      .then((res) => sendResponse({ ok: true, res }))
      .catch((err) => sendResponse({ ok: false, error: String(err) }));
    return true;
  }

  // Upload kombo: patch HTMLInputElement.prototype.click di MAIN world,
  // klik tombol "Tambahkan foto/video", intercept input.click() yg dipanggil halaman,
  // set files via DataTransfer + dispatch change, lalu restore.
  // Semua dalam satu execution agar atomik.
  if (msg.type === "UPLOAD_VIA_BUTTON_CLICK") {
    const tabId = msg.tabId || sender.tab?.id;
    const buttonSelector = msg.buttonSelector;
    const fileSpecs = msg.files;
    const interceptTimeoutMs = msg.interceptTimeoutMs || 5000;
    if (!tabId || !buttonSelector || !Array.isArray(fileSpecs)) {
      sendResponse({ ok: false, error: "missing tabId/buttonSelector/files" });
      return;
    }
    chrome.scripting
      .executeScript({
        target: { tabId },
        world: "MAIN",
        func: (btnSel, specs, timeoutMs) => {
          return new Promise((resolve) => {
            const origClick = HTMLInputElement.prototype.click;
            let done = false;
            const log = (...a) => {
              try { console.log("[AutoPosting:main]", ...a); } catch {}
            };
            const cleanup = () => {
              try { HTMLInputElement.prototype.click = origClick; } catch {}
            };
            const finish = (result) => {
              if (done) return;
              done = true;
              cleanup();
              resolve(result);
            };

            function b64ToBytes(b64) {
              const bin = atob(b64);
              const len = bin.length;
              const bytes = new Uint8Array(len);
              for (let i = 0; i < len; i++) bytes[i] = bin.charCodeAt(i);
              return bytes;
            }
            function buildFiles() {
              const dt = new DataTransfer();
              for (const s of specs) {
                const bytes = b64ToBytes(s.b64);
                const blob = new Blob([bytes], { type: s.type || "application/octet-stream" });
                const file = new File([blob], s.name, {
                  type: blob.type,
                  lastModified: s.lastModified || Date.now(),
                });
                dt.items.add(file);
              }
              return dt;
            }
            function setFilesOn(input) {
              try {
                const dt = buildFiles();
                const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "files")?.set;
                if (setter) setter.call(input, dt.files);
                else input.files = dt.files;
                input.dispatchEvent(new Event("change", { bubbles: true }));
                input.dispatchEvent(new Event("input", { bubbles: true }));
                return { ok: true, count: dt.files.length };
              } catch (e) {
                return { ok: false, error: String(e) };
              }
            }

            // Patch prototype.click — intercept saat halaman panggil input.click()
            HTMLInputElement.prototype.click = function () {
              if (!done && this.type === "file") {
                log("intercepted input.click()", { name: this.name, accept: this.accept });
                const res = setFilesOn(this);
                if (res.ok) {
                  finish({ ok: true, intercepted: true, source: "prototype-click", inputAccept: this.accept || null, count: res.count });
                } else {
                  finish({ ok: false, intercepted: true, source: "prototype-click", error: res.error });
                }
                return; // suppress OS dialog
              }
              return origClick.call(this);
            };

            // Juga pasang MutationObserver: kalau halaman mount input baru tanpa panggil .click()
            const beforeInputs = new Set(document.querySelectorAll('input[type="file"]'));
            const observer = new MutationObserver(() => {
              if (done) return;
              const all = Array.from(document.querySelectorAll('input[type="file"]'));
              for (const inp of all) {
                if (!beforeInputs.has(inp)) {
                  log("mutation observer found new file input");
                  const res = setFilesOn(inp);
                  observer.disconnect();
                  if (res.ok) finish({ ok: true, intercepted: false, source: "mutation-observer", count: res.count });
                  else finish({ ok: false, intercepted: false, source: "mutation-observer", error: res.error });
                  return;
                }
              }
            });
            try { observer.observe(document.body, { childList: true, subtree: true }); } catch {}

            const btn = document.querySelector(btnSel);
            if (!btn) {
              try { observer.disconnect(); } catch {}
              return finish({ ok: false, error: "button not found in main world: " + btnSel });
            }

            // Full event sequence + native .click()
            try {
              const rect = btn.getBoundingClientRect();
              const cx = rect.left + rect.width / 2;
              const cy = rect.top + rect.height / 2;
              const opts = {
                bubbles: true, cancelable: true, composed: true, view: window,
                clientX: cx, clientY: cy, screenX: cx, screenY: cy,
                button: 0, buttons: 1, detail: 1,
              };
              const popts = { ...opts, pointerType: "mouse", pointerId: 1, isPrimary: true, pressure: 0.5 };
              btn.dispatchEvent(new PointerEvent("pointerover", popts));
              btn.dispatchEvent(new PointerEvent("pointerenter", popts));
              btn.dispatchEvent(new MouseEvent("mouseover", opts));
              btn.dispatchEvent(new MouseEvent("mouseenter", opts));
              btn.dispatchEvent(new PointerEvent("pointerdown", popts));
              btn.dispatchEvent(new MouseEvent("mousedown", opts));
              btn.dispatchEvent(new PointerEvent("pointerup", popts));
              btn.dispatchEvent(new MouseEvent("mouseup", opts));
              btn.dispatchEvent(new MouseEvent("click", opts));
              try { btn.focus?.(); } catch {}
              try { btn.click(); } catch {}
            } catch (e) {
              log("button click error:", String(e));
            }

            setTimeout(() => {
              if (!done) {
                try { observer.disconnect(); } catch {}
                finish({ ok: false, error: "input.click() tidak ter-intercept dalam " + timeoutMs + "ms" });
              }
            }, timeoutMs);
          });
        },
        args: [buttonSelector, fileSpecs, interceptTimeoutMs],
      })
      .then((res) => sendResponse({ ok: true, res }))
      .catch((err) => sendResponse({ ok: false, error: String(err) }));
    return true;
  }

  // Drop files di MAIN world (untuk trusted DragEvent)
  if (msg.type === "DROP_FILES_IN_MAIN_WORLD") {
    const tabId = msg.tabId || sender.tab?.id;
    const selector = msg.selector;
    const fileSpecs = msg.files;
    if (!tabId || !selector || !Array.isArray(fileSpecs)) {
      sendResponse({ ok: false, error: "missing args" });
      return;
    }
    chrome.scripting
      .executeScript({
        target: { tabId },
        world: "MAIN",
        func: (sel, specs) => {
          function b64ToBytes(b64) {
            const bin = atob(b64);
            const len = bin.length;
            const bytes = new Uint8Array(len);
            for (let i = 0; i < len; i++) bytes[i] = bin.charCodeAt(i);
            return bytes;
          }
          const target = document.querySelector(sel);
          if (!target) return { ok: false, error: "target not found" };
          try {
            const dt = new DataTransfer();
            for (const s of specs) {
              const bytes = b64ToBytes(s.b64);
              const blob = new Blob([bytes], { type: s.type || "application/octet-stream" });
              const file = new File([blob], s.name, {
                type: blob.type,
                lastModified: s.lastModified || Date.now(),
              });
              dt.items.add(file);
            }
            const rect = target.getBoundingClientRect();
            const cx = rect.left + rect.width / 2;
            const cy = rect.top + rect.height / 2;
            const opts = {
              bubbles: true,
              cancelable: true,
              composed: true,
              dataTransfer: dt,
              clientX: cx,
              clientY: cy,
            };
            target.dispatchEvent(new DragEvent("dragenter", opts));
            target.dispatchEvent(new DragEvent("dragover", opts));
            target.dispatchEvent(new DragEvent("drop", opts));
            return { ok: true };
          } catch (e) {
            return { ok: false, error: String(e) };
          }
        },
        args: [selector, fileSpecs],
      })
      .then((res) => sendResponse({ ok: true, res }))
      .catch((err) => sendResponse({ ok: false, error: String(err) }));
    return true;
  }
});
