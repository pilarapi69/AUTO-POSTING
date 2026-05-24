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
