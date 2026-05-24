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
});
