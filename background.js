// background.js — service worker
// Panel kontrol di-inject sebagai floating iframe di halaman Meta Business Suite
// (truly "menyatu di dalam browser" — tidak ada window/side panel terpisah).
// Background: handle klik icon \u2192 toggle panel di active tab, relay pesan main-world.

async function ensureContentScript(tabId) {
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
  } catch (e) {
    // sudah ter-load atau halaman tidak match; lanjut
  }
}

async function togglePanelOnTab(tab) {
  if (!tab) return;
  const url = tab.url || "";
  const isMeta = /https:\/\/([a-z0-9-]+\.)*facebook\.com\//i.test(url);
  if (!isMeta) {
    // Buka tab Meta Business Suite jika belum ada
    await chrome.tabs.create({
      url: "https://business.facebook.com/latest/posts/scheduled_posts?asset_id=&task=POST_MANAGEMENT",
      active: true,
    });
    return;
  }
  await ensureContentScript(tab.id);
  try {
    await chrome.tabs.sendMessage(tab.id, { type: "TOGGLE_PANEL" });
  } catch (e) {
    console.error("TOGGLE_PANEL failed:", e);
  }
}

chrome.action.onClicked.addListener((tab) => {
  togglePanelOnTab(tab).catch((err) => console.error(err));
});

// Relay pesan. Iframe panel mengirim ke background via chrome.runtime.sendMessage;
// background menangani: FIND_BUSINESS_TAB, PING_CONTENT, GET_HOST_TAB,
// CLICK_IN_MAIN_WORLD, SET_FILES_IN_MAIN_WORLD, DROP_FILES_IN_MAIN_WORLD,
// UPLOAD_VIA_BUTTON_CLICK.
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

  if (msg.type === "GET_HOST_TAB") {
    // Dipanggil dari iframe panel — return tab tempat iframe hidup.
    const tab = sender.tab;
    if (!tab) {
      sendResponse({ ok: false, error: "no host tab" });
      return;
    }
    sendResponse({ ok: true, tab: { id: tab.id, url: tab.url, title: tab.title } });
    return;
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

  // Patch sudah ter-install via inject.js (document_start, MAIN world).
  // INSTALL_SESSION_PATCH cuma activate.
  if (msg.type === "INSTALL_SESSION_PATCH") {
    const tabId = msg.tabId || sender.tab?.id;
    if (!tabId) {
      sendResponse({ ok: false, error: "missing tabId" });
      return;
    }
    chrome.scripting
      .executeScript({
        target: { tabId },
        world: "MAIN",
        func: () => {
          if (!window.__autoPostingPatched) {
            console.warn("[AutoPosting:patch] activate called but patch not installed yet (inject.js might not have run)");
            return { ok: false, error: "inject.js patch not loaded" };
          }
          window.__autoPostingState.active = true;
          console.log("[AutoPosting:patch] ACTIVATED via INSTALL_SESSION_PATCH");
          return { ok: true, alreadyInstalled: true };
        },
      })
      .then((res) => sendResponse({ ok: true, res }))
      .catch((err) => sendResponse({ ok: false, error: String(err) }));
    return true;
  }

  // Deactivate patch (tetap installed tapi tidak intercept lagi)
  if (msg.type === "UNINSTALL_SESSION_PATCH") {
    const tabId = msg.tabId || sender.tab?.id;
    if (!tabId) {
      sendResponse({ ok: false, error: "missing tabId" });
      return;
    }
    chrome.scripting
      .executeScript({
        target: { tabId },
        world: "MAIN",
        func: () => {
          if (window.__autoPostingState) {
            window.__autoPostingState.active = false;
            console.log("[AutoPosting:patch] DEACTIVATED");
          }
          return { ok: true };
        },
      })
      .then((res) => sendResponse({ ok: true, res }))
      .catch((err) => sendResponse({ ok: false, error: String(err) }));
    return true;
  }

  // Pre-queue files untuk patch + klik tombol + tunggu consumed
  if (msg.type === "UPLOAD_V2") {
    const tabId = msg.tabId || sender.tab?.id;
    const buttonSelector = msg.buttonSelector;
    const fileSpecs = msg.files;
    const timeoutMs = msg.timeoutMs || 8000;
    if (!tabId || !buttonSelector || !Array.isArray(fileSpecs)) {
      sendResponse({ ok: false, error: "missing args" });
      return;
    }
    chrome.scripting
      .executeScript({
        target: { tabId },
        world: "MAIN",
        func: (btnSel, specs, tmo) => {
          return new Promise((resolve) => {
            if (!window.__autoPostingPatched) {
              resolve({ ok: false, error: "session patch not installed" });
              return;
            }
            const st = window.__autoPostingState;
            st.active = true;
            st.nextFiles = specs;
            st.consumed = false;
            st.lastError = null;

            const btn = document.querySelector(btnSel);
            if (!btn) {
              resolve({ ok: false, error: "button not found: " + btnSel });
              return;
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
              resolve({ ok: false, error: "click error: " + String(e) });
              return;
            }

            // Poll consumed flag
            const start = Date.now();
            const tick = () => {
              if (st.consumed) {
                resolve({ ok: true, consumed: true });
                return;
              }
              if (st.lastError) {
                resolve({ ok: false, error: "patch error: " + st.lastError });
                return;
              }
              if (Date.now() - start >= tmo) {
                st.nextFiles = null;
                resolve({ ok: false, error: "consumed flag not set in " + tmo + "ms" });
                return;
              }
              setTimeout(tick, 80);
            };
            tick();
          });
        },
        args: [buttonSelector, fileSpecs, timeoutMs],
      })
      .then((res) => sendResponse({ ok: true, res }))
      .catch((err) => sendResponse({ ok: false, error: String(err) }));
    return true;
  }

  // (Legacy) Upload kombo per-row, patch temporary.
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
