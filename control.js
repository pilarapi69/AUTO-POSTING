// control.js — panel kontrol Auto Posting

/** @typedef {{ files: File[], caption: string, scheduledAt: Date|null }} Job */

const ui = {
  tabSelect: /** @type {HTMLSelectElement} */ (document.getElementById("tab-select")),
  refreshTabs: document.getElementById("refresh-tabs"),
  tabHint: document.getElementById("tab-hint"),

  mediaInput: /** @type {HTMLInputElement} */ (document.getElementById("media-input")),
  mediaSummary: document.getElementById("media-summary"),

  captionInput: /** @type {HTMLInputElement} */ (document.getElementById("caption-input")),
  captionSummary: document.getElementById("caption-summary"),

  scheduleStart: /** @type {HTMLInputElement} */ (document.getElementById("schedule-start")),
  scheduleInterval: /** @type {HTMLInputElement} */ (document.getElementById("schedule-interval")),
  scheduleSkipExisting: /** @type {HTMLInputElement} */ (document.getElementById("schedule-skip-existing")),

  warnCard: document.getElementById("step-warn"),
  warnSummary: document.getElementById("warn-summary"),
  warnList: document.getElementById("warn-list"),
  autoCompress: /** @type {HTMLInputElement} */ (document.getElementById("auto-compress")),

  previewList: document.getElementById("preview-list"),

  btnStart: /** @type {HTMLButtonElement} */ (document.getElementById("btn-start")),
  btnStop: /** @type {HTMLButtonElement} */ (document.getElementById("btn-stop")),
  progressFill: document.getElementById("progress-fill"),
  progressLabel: document.getElementById("progress-label"),

  log: document.getElementById("log"),
};

/** State */
const state = {
  /** @type {Array<{name:string, files:File[]}>} */
  postsMedia: [],
  /** @type {string[]} */
  captions: [],
  /** @type {chrome.tabs.Tab|null} */
  selectedTab: null,
  running: false,
  abortRequested: false,
};

const MEDIA_EXTS = new Set([
  ".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp", ".heic", ".heif", ".tiff",
  ".mp4", ".mov", ".m4v", ".webm", ".mkv", ".avi", ".3gp",
]);

const IMAGE_EXTS = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp", ".tiff"]);
const VIDEO_EXTS = new Set([".mp4", ".mov", ".m4v", ".webm", ".mkv", ".avi", ".3gp"]);

// Limit Meta untuk foto: 10 MB. Pakai safety margin ~9.5 MB.
const META_PHOTO_LIMIT = 10 * 1024 * 1024;
const SAFE_TARGET = 9.5 * 1024 * 1024;
const MAX_DIMENSION = 2048;

function formatSize(bytes) {
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
  return (bytes / (1024 * 1024)).toFixed(2) + " MB";
}

function isImage(file) {
  return IMAGE_EXTS.has(ext(file.name));
}
function isVideo(file) {
  return VIDEO_EXTS.has(ext(file.name));
}

function ext(name) {
  const i = name.lastIndexOf(".");
  return i >= 0 ? name.substring(i).toLowerCase() : "";
}

function isMedia(file) {
  return MEDIA_EXTS.has(ext(file.name));
}

function naturalCompare(a, b) {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
}

function formatDateForInput(d) {
  // ISO with local offset trimmed to minutes (yyyy-MM-ddTHH:mm)
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function formatHuman(d) {
  if (!d) return "—";
  const opts = { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" };
  return new Intl.DateTimeFormat("id-ID", opts).format(d);
}

function log(msg, kind = "info") {
  const line = document.createElement("p");
  line.className = `line ${kind}`;
  const ts = new Date().toLocaleTimeString("id-ID", { hour12: false });
  line.textContent = `[${ts}] ${msg}`;
  ui.log.appendChild(line);
  ui.log.scrollTop = ui.log.scrollHeight;
}

function setProgress(done, total, label) {
  const pct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;
  ui.progressFill.style.width = `${pct}%`;
  ui.progressLabel.textContent = label || (total > 0 ? `${done}/${total} (${pct}%)` : "Idle");
}

// ---------- Tab discovery ----------
async function loadTabs() {
  ui.tabSelect.innerHTML = "<option value=''>— Memuat —</option>";
  const resp = await new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: "FIND_BUSINESS_TAB" }, resolve);
  });
  const tabs = resp?.all ?? [];
  if (!tabs.length) {
    ui.tabSelect.innerHTML = "<option value=''>(Tidak ditemukan tab business.facebook.com)</option>";
    ui.tabHint.textContent = "Buka halaman Meta Business Suite di tab terpisah, lalu klik refresh.";
    ui.tabHint.className = "hint error";
    state.selectedTab = null;
    refreshStartEnabled();
    return;
  }
  ui.tabHint.textContent = "";
  ui.tabHint.className = "hint";
  ui.tabSelect.innerHTML = "";
  for (const t of tabs) {
    const opt = document.createElement("option");
    opt.value = String(t.id);
    const title = t.title ? t.title.slice(0, 70) : "(tanpa judul)";
    opt.textContent = `${title}`;
    opt.dataset.url = t.url || "";
    ui.tabSelect.appendChild(opt);
  }
  // Default: tab paling cocok
  const preferred = resp?.tab ?? tabs[0];
  ui.tabSelect.value = String(preferred.id);
  state.selectedTab = preferred;
  refreshStartEnabled();
}

ui.refreshTabs.addEventListener("click", () => loadTabs().catch((e) => log("Gagal memuat tab: " + e, "err")));

ui.tabSelect.addEventListener("change", async () => {
  const id = Number(ui.tabSelect.value);
  if (!id) {
    state.selectedTab = null;
  } else {
    try {
      state.selectedTab = await chrome.tabs.get(id);
    } catch {
      state.selectedTab = null;
    }
  }
  refreshStartEnabled();
});

// ---------- Folder media ----------
ui.mediaInput.addEventListener("change", () => {
  const files = Array.from(ui.mediaInput.files || []);
  // Group by top-level subfolder name (relative to chosen root)
  // file.webkitRelativePath: "rootFolderName/sub/file.jpg" atau "rootFolderName/file.jpg"
  /** @type {Map<string, File[]>} */
  const groups = new Map();
  /** @type {File[]} */
  const flat = [];
  for (const f of files) {
    if (!isMedia(f)) continue;
    const rel = /** @type {any} */ (f).webkitRelativePath || f.name;
    const parts = rel.split("/");
    if (parts.length <= 2) {
      // direct child of root → single-media post
      flat.push(f);
    } else {
      const groupName = parts.slice(1, parts.length - 1).join("/");
      if (!groups.has(groupName)) groups.set(groupName, []);
      groups.get(groupName).push(f);
    }
  }

  /** @type {Array<{name:string, files:File[]}>} */
  let posts = [];
  if (groups.size > 0) {
    posts = Array.from(groups.entries())
      .sort((a, b) => naturalCompare(a[0], b[0]))
      .map(([name, fs]) => ({
        name,
        files: fs.slice().sort((a, b) => naturalCompare(a.name, b.name)),
      }));
    // Also add direct files as their own posts after subfolders, if any
    for (const f of flat.sort((a, b) => naturalCompare(a.name, b.name))) {
      posts.push({ name: f.name, files: [f] });
    }
  } else {
    posts = flat
      .sort((a, b) => naturalCompare(a.name, b.name))
      .map((f) => ({ name: f.name, files: [f] }));
  }

  state.postsMedia = posts;

  const totalFiles = posts.reduce((n, p) => n + p.files.length, 0);
  if (!posts.length) {
    ui.mediaSummary.textContent = "Tidak ada media yang valid.";
    ui.mediaSummary.classList.add("error");
  } else {
    ui.mediaSummary.textContent = `${posts.length} postingan · ${totalFiles} media`;
    ui.mediaSummary.classList.remove("error");
  }
  renderWarnings();
  renderPreview();
  refreshStartEnabled();
});

ui.autoCompress.addEventListener("change", renderWarnings);

/** Render warning card untuk file > 10MB. */
function renderWarnings() {
  const oversized = [];
  const oversizedVideos = [];
  for (const post of state.postsMedia) {
    for (const f of post.files) {
      if (f.size > META_PHOTO_LIMIT) {
        if (isVideo(f)) oversizedVideos.push(f);
        else oversized.push(f);
      }
    }
  }
  if (oversized.length + oversizedVideos.length === 0) {
    ui.warnCard.classList.add("hidden");
    return;
  }
  ui.warnCard.classList.remove("hidden");
  const compressEnabled = ui.autoCompress.checked;
  const imgCount = oversized.length;
  const vidCount = oversizedVideos.length;
  const parts = [];
  if (imgCount) {
    parts.push(
      compressEnabled
        ? `${imgCount} foto > 10MB akan di-compress otomatis ke JPEG saat upload.`
        : `${imgCount} foto > 10MB — Meta akan tolak (centang auto-compress).`
    );
  }
  if (vidCount) {
    parts.push(`${vidCount} video > 10MB — compress manual dulu (extension tidak compress video).`);
  }
  ui.warnSummary.textContent = parts.join(" ");

  ui.warnList.innerHTML = "";
  const all = [...oversized, ...oversizedVideos].slice(0, 30);
  for (const f of all) {
    const li = document.createElement("li");
    const isImg = isImage(f);
    if (isImg && compressEnabled) li.classList.add("ok");
    const sizeLabel = formatSize(f.size) + (isImg && compressEnabled ? " → ~9.5MB" : " ✖");
    li.innerHTML = `<span class="name">${escapeHtml(f.name)}</span><span class="size">${escapeHtml(sizeLabel)}</span>`;
    ui.warnList.appendChild(li);
  }
  if (oversized.length + oversizedVideos.length > 30) {
    const li = document.createElement("li");
    li.innerHTML = `<span class="name muted">… dan ${oversized.length + oversizedVideos.length - 30} file lain</span>`;
    ui.warnList.appendChild(li);
  }
}

/** Compress image file via Canvas → JPEG, iterative quality/scale reduction. */
async function compressImage(file, opts = {}) {
  const target = opts.target || SAFE_TARGET;
  const maxDim = opts.maxDim || MAX_DIMENSION;

  // Load image (handle HEIC etc. via createImageBitmap fallback)
  let bitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch (e) {
    // Fallback: HTMLImageElement via blob URL
    const url = URL.createObjectURL(file);
    try {
      bitmap = await new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = (ev) => reject(new Error("Image load failed: " + (ev?.message || "")));
        img.src = url;
      });
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  const origW = bitmap.width || bitmap.naturalWidth;
  const origH = bitmap.height || bitmap.naturalHeight;
  if (!origW || !origH) throw new Error("Tidak bisa baca dimensi gambar");

  // Iterative: turunkan scale & quality sampai size cukup
  let scale = 1;
  // Start dari max dimension
  const maxOf = Math.max(origW, origH);
  if (maxOf > maxDim) scale = maxDim / maxOf;

  let quality = 0.88;
  for (let attempt = 0; attempt < 8; attempt++) {
    const w = Math.max(1, Math.round(origW * scale));
    const h = Math.max(1, Math.round(origH * scale));
    const canvas = (typeof OffscreenCanvas !== "undefined")
      ? new OffscreenCanvas(w, h)
      : Object.assign(document.createElement("canvas"), { width: w, height: h });
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Canvas 2D context tidak tersedia");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(bitmap, 0, 0, w, h);

    let blob;
    if (canvas.convertToBlob) {
      blob = await canvas.convertToBlob({ type: "image/jpeg", quality });
    } else {
      blob = await new Promise((resolve, reject) => {
        canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("toBlob null"))), "image/jpeg", quality);
      });
    }
    if (blob.size <= target) {
      // Convert blob → File dengan nama .jpg
      const newName = file.name.replace(/\.[^.]+$/, "") + ".jpg";
      return new File([blob], newName, { type: "image/jpeg", lastModified: file.lastModified || Date.now() });
    }
    // Tidak cukup, kurangi scale & quality
    if (quality > 0.55) quality -= 0.1;
    else scale *= 0.85;
  }
  throw new Error(`Gagal compress "${file.name}" di bawah ${formatSize(target)}`);
}

/** Compress + serialize files untuk satu post sebelum kirim. */
async function preparePostFiles(post, compress) {
  const out = [];
  for (const f of post.files) {
    let final = f;
    if (compress && isImage(f) && f.size > META_PHOTO_LIMIT) {
      try {
        log(`Compressing ${f.name} (${formatSize(f.size)})…`, "warn");
        final = await compressImage(f);
        log(`  → ${final.name} ${formatSize(final.size)}`, "ok");
      } catch (e) {
        log(`Compress gagal untuk ${f.name}: ${e.message}. Pakai file asli (kemungkinan Meta tolak).`, "err");
      }
    } else if (compress && isVideo(f) && f.size > META_PHOTO_LIMIT) {
      log(`Video ${f.name} > 10MB — dikirim apa adanya (compress manual jika perlu).`, "warn");
    }
    const buf = await final.arrayBuffer();
    out.push({ name: final.name, type: final.type, lastModified: final.lastModified || Date.now(), buffer: buf });
  }
  return out;
}

// ---------- File caption ----------
ui.captionInput.addEventListener("change", async () => {
  const file = ui.captionInput.files?.[0];
  if (!file) {
    state.captions = [];
    ui.captionSummary.textContent = "Belum dipilih";
    renderPreview();
    refreshStartEnabled();
    return;
  }
  const text = await file.text();
  state.captions = parseCaptions(text);
  ui.captionSummary.textContent = `${file.name} · ${state.captions.length} caption`;
  renderPreview();
  refreshStartEnabled();
});

/** @param {string} text */
function parseCaptions(text) {
  // Normalisasi line endings
  const t = text.replace(/\r\n?/g, "\n");
  // Pisah dengan "---" pada baris tersendiri ATAU baris kosong ganda
  let parts;
  if (/^\s*-{3,}\s*$/m.test(t)) {
    parts = t.split(/\n\s*-{3,}\s*\n/);
  } else if (/\n\s*\n/.test(t)) {
    parts = t.split(/\n\s*\n+/);
  } else {
    // tiap baris = caption
    parts = t.split(/\n/);
  }
  return parts.map((s) => s.trim()).filter((s) => s.length > 0);
}

// ---------- Preview ----------
function getScheduledTimes() {
  /** @type {Array<Date|null>} */
  const out = [];
  const startStr = ui.scheduleStart.value;
  const interval = Math.max(1, Number(ui.scheduleInterval.value || 60));
  const count = state.postsMedia.length;
  if (!startStr || isNaN(new Date(startStr).getTime())) {
    for (let i = 0; i < count; i++) out.push(null);
    return out;
  }
  const start = new Date(startStr);
  for (let i = 0; i < count; i++) {
    out.push(new Date(start.getTime() + i * interval * 60_000));
  }
  return out;
}

function renderPreview() {
  ui.previewList.innerHTML = "";
  const count = Math.max(state.postsMedia.length, state.captions.length);
  if (count === 0) {
    const li = document.createElement("li");
    li.className = "empty";
    li.textContent = "Belum ada data preview.";
    ui.previewList.appendChild(li);
    return;
  }
  const times = getScheduledTimes();
  const usable = Math.min(state.postsMedia.length, state.captions.length);
  for (let i = 0; i < count; i++) {
    const li = document.createElement("li");
    const post = state.postsMedia[i];
    const cap = state.captions[i];
    li.innerHTML = `
      <div class="idx">${i + 1}</div>
      <div class="info">
        <div class="title">${escapeHtml(post ? `${post.name}${post.files.length > 1 ? ` (${post.files.length} file)` : ""}` : "— (tidak ada media)")}</div>
        <div class="sub">${escapeHtml(cap ? truncate(cap, 80) : "— (tidak ada caption)")}</div>
      </div>
      <div class="when">${formatHuman(times[i])}</div>
    `;
    if (i >= usable) li.style.opacity = "0.55";
    ui.previewList.appendChild(li);
  }
}

function truncate(s, n) {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

ui.scheduleStart.addEventListener("input", renderPreview);
ui.scheduleInterval.addEventListener("input", renderPreview);

// ---------- Start / Stop ----------
function refreshStartEnabled() {
  const ready =
    state.selectedTab &&
    state.postsMedia.length > 0 &&
    state.captions.length > 0 &&
    !state.running;
  ui.btnStart.disabled = !ready;
  ui.btnStop.disabled = !state.running;
}

ui.btnStart.addEventListener("click", () => {
  startAutomation().catch((e) => {
    log("Error: " + (e?.message || e), "err");
    state.running = false;
    refreshStartEnabled();
  });
});

ui.btnStop.addEventListener("click", () => {
  state.abortRequested = true;
  log("Permintaan STOP diterima — akan berhenti setelah job berjalan selesai.", "warn");
});

async function startAutomation() {
  if (!state.selectedTab) return;
  state.running = true;
  state.abortRequested = false;
  refreshStartEnabled();

  const usable = Math.min(state.postsMedia.length, state.captions.length);
  if (usable === 0) {
    log("Tidak ada job untuk dijalankan.", "warn");
    state.running = false;
    refreshStartEnabled();
    return;
  }
  const times = getScheduledTimes();
  const skipExisting = ui.scheduleSkipExisting.checked;

  log(`Mulai automasi ${usable} postingan pada tab "${state.selectedTab.title || state.selectedTab.url}"`, "info");
  setProgress(0, usable, `0/${usable}`);

  // Inject ulang content script untuk keamanan (kalau halaman dibuka sebelum extension dimuat)
  try {
    await chrome.scripting.executeScript({
      target: { tabId: state.selectedTab.id },
      files: ["content.js"],
    });
  } catch (e) {
    log("Gagal inject content script: " + e.message + " (lanjut, mungkin sudah terload)", "warn");
  }

  // Ping content script
  try {
    const pong = await chrome.tabs.sendMessage(state.selectedTab.id, { type: "PING" });
    if (!pong || !pong.ok) throw new Error("content script tidak merespons");
  } catch (e) {
    log("Content script tidak aktif di tab tsb. Pastikan halaman Meta Business Suite sudah dimuat.", "err");
    state.running = false;
    refreshStartEnabled();
    return;
  }

  // Init: minta content script siapkan halaman (skip existing kosong jika perlu)
  await chrome.tabs.sendMessage(state.selectedTab.id, {
    type: "INIT_SESSION",
    options: { skipExisting },
  });

  for (let i = 0; i < usable; i++) {
    if (state.abortRequested) {
      log("STOP diaktifkan. Menghentikan loop.", "warn");
      break;
    }

    const post = state.postsMedia[i];
    const caption = state.captions[i];
    const when = times[i];

    log(`#${i + 1}: "${truncate(caption, 60)}" — ${post.files.length} media — jadwal: ${formatHuman(when)}`, "info");
    setProgress(i, usable, `Memproses ${i + 1}/${usable}`);

    // Compress (jika perlu) + serialize files to ArrayBuffer for messaging
    const filesPayload = await preparePostFiles(post, ui.autoCompress.checked);

    let response;
    try {
      response = await chrome.tabs.sendMessage(state.selectedTab.id, {
        type: "PROCESS_JOB",
        index: i,
        total: usable,
        job: {
          files: filesPayload,
          caption,
          scheduledAt: when ? when.toISOString() : null,
        },
      });
    } catch (e) {
      log(`#${i + 1} gagal mengirim ke content: ${e.message}`, "err");
      response = { ok: false, error: e.message };
    }

    if (response?.ok) {
      log(`#${i + 1} selesai: ${response.message || "OK"}`, "ok");
    } else {
      log(`#${i + 1} ERROR: ${response?.error || "tidak diketahui"}`, "err");
      // Pertimbangan: lanjut ke berikutnya. User bisa STOP.
    }
    setProgress(i + 1, usable, `${i + 1}/${usable}`);
  }

  log("Automasi selesai. Periksa halaman, lalu klik tombol Terbitkan secara manual.", "ok");
  state.running = false;
  refreshStartEnabled();
}

// ---------- Init ----------
(function init() {
  // Default schedule start: now + 30 minutes (rounded up)
  const now = new Date();
  now.setMinutes(now.getMinutes() + 30);
  now.setSeconds(0, 0);
  ui.scheduleStart.value = formatDateForInput(now);

  loadTabs().catch((e) => log("Gagal memuat tab: " + e, "err"));
  renderPreview();
})();
