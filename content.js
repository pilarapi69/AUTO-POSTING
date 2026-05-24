// content.js — automation script untuk halaman Meta Business Suite
// "Jadwalkan postingan massal"
//
// Mendukung pesan:
//   - PING                    → balas { ok: true }
//   - INIT_SESSION { options} → siapkan halaman; tampilkan badge "Auto Posting Active"
//   - PROCESS_JOB  { job }    → kerjakan satu postingan dari awal sampai jadwal di-set
//
// Catatan: TIDAK MENGKLIK tombol "Terbitkan" di bagian bawah. Itu dilakukan manual oleh user.

(() => {
  if (window.__autoPostingContentLoaded) return;
  window.__autoPostingContentLoaded = true;

  const INDO_MONTHS_SHORT = [
    "Jan", "Feb", "Mar", "Apr", "Mei", "Jun",
    "Jul", "Agu", "Sep", "Okt", "Nov", "Des",
  ];
  const INDO_MONTHS_FULL = [
    "Januari", "Februari", "Maret", "April", "Mei", "Juni",
    "Juli", "Agustus", "September", "Oktober", "November", "Desember",
  ];

  /** Sleep ms */
  const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

  /** Wait sampai predicate truthy atau timeout */
  async function waitFor(predicate, { timeout = 15000, interval = 150, label = "" } = {}) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      try {
        const v = await predicate();
        if (v) return v;
      } catch {}
      await sleep(interval);
    }
    throw new Error(`Timeout menunggu ${label || "kondisi"} (${timeout}ms)`);
  }

  /** Cari semua elemen yang text-nya cocok */
  function findAllByText(text, opts = {}) {
    const root = opts.root || document.body;
    const exact = !!opts.exact;
    const lc = text.toLowerCase().trim();
    const result = [];
    const it = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT, {
      acceptNode: (node) => {
        if (!(node instanceof HTMLElement)) return NodeFilter.FILTER_SKIP;
        // skip script/style
        const tag = node.tagName;
        if (tag === "SCRIPT" || tag === "STYLE") return NodeFilter.FILTER_REJECT;
        // gunakan innerText (untuk text yg terlihat) tapi cek juga aria-label
        const t = (node.innerText || node.textContent || "").trim().toLowerCase();
        const aria = (node.getAttribute("aria-label") || "").trim().toLowerCase();
        const match = exact
          ? t === lc || aria === lc
          : t.includes(lc) || aria.includes(lc);
        if (match) {
          // prefer leaf-est match: only accept if no descendant matches deeper
          return NodeFilter.FILTER_ACCEPT;
        }
        return NodeFilter.FILTER_SKIP;
      },
    });
    let n;
    while ((n = it.nextNode())) result.push(n);
    return result;
  }

  /** Ambil match terdalam */
  function findInnermostByText(text, opts = {}) {
    const all = findAllByText(text, opts);
    if (!all.length) return null;
    // Sort by depth desc
    all.sort((a, b) => depth(b) - depth(a));
    return all[0];
  }

  function depth(el) {
    let d = 0, n = el;
    while (n && n !== document.body) { d++; n = n.parentElement; }
    return d;
  }

  /** Naik ke elemen interaktif (button / role=button) terdekat */
  function climbToClickable(el) {
    let n = el;
    while (n && n !== document.body) {
      const role = n.getAttribute?.("role");
      const tag = n.tagName;
      if (tag === "BUTTON" || tag === "A" || role === "button" || role === "link") return n;
      n = n.parentElement;
    }
    return el;
  }

  /** Set nilai input/textarea ala React (native setter) */
  function setNativeValue(el, value) {
    const proto = el instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
    if (setter) setter.call(el, value);
    else el.value = value;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  /** Untuk contenteditable */
  function setContentEditable(el, text) {
    el.focus();
    // pilih semua + delete
    document.execCommand("selectAll", false, null);
    document.execCommand("delete", false, null);
    // insert text (mempertahankan baris dengan execCommand insertText)
    document.execCommand("insertText", false, text);
    el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
  }

  /** Klik manusia: dispatch pointer/mouse events */
  function realClick(el) {
    const rect = el.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    const opts = { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y, button: 0 };
    el.dispatchEvent(new PointerEvent("pointerover", opts));
    el.dispatchEvent(new PointerEvent("pointerenter", opts));
    el.dispatchEvent(new PointerEvent("pointerdown", opts));
    el.dispatchEvent(new MouseEvent("mousedown", opts));
    el.dispatchEvent(new PointerEvent("pointerup", opts));
    el.dispatchEvent(new MouseEvent("mouseup", opts));
    el.dispatchEvent(new MouseEvent("click", opts));
  }

  /** Cari kontainer baris (row) postingan.
   *  Strategi: setiap textarea dengan placeholder "Tulis sesuatu..." = satu row.
   *  Container row = ancestor terkecil yang juga berisi tombol "Tambahkan foto/video".
   *  Fallback: anchor dari tombol "Tambahkan foto/video" jika tidak ada textarea (mis. UI bahasa lain).
   */
  function getPostRows() {
    /** @type {HTMLElement[]} */
    const rows = [];
    const seen = new Set();

    const textareas = Array.from(document.querySelectorAll("textarea")).filter((ta) => {
      const ph = (ta.placeholder || "").toLowerCase();
      // utamakan placeholder "tulis sesuatu", tapi terima juga textarea lain yg terlihat
      const rect = ta.getBoundingClientRect();
      const visible = rect.width > 100 && rect.height > 20;
      return visible && (ph.includes("tulis sesuatu") || ph.includes("write") || ph === "");
    });

    const addMediaButtons = findAllByText("Tambahkan foto/video");

    for (const ta of textareas) {
      let n = ta;
      for (let i = 0; i < 25 && n && n !== document.body; i++) {
        const containsAddMedia = addMediaButtons.some((b) => n.contains(b));
        if (containsAddMedia) {
          if (!seen.has(n)) {
            seen.add(n);
            rows.push(n);
          }
          break;
        }
        n = n.parentElement;
      }
    }

    // Fallback: gunakan tombol "Tambahkan foto/video" sebagai anchor
    if (!rows.length) {
      for (const b of addMediaButtons) {
        let n = b;
        for (let i = 0; i < 25 && n && n !== document.body; i++) {
          if (
            n.querySelector?.("textarea, [contenteditable='true']") ||
            (n.innerText && n.innerText.toLowerCase().includes("terbitkan"))
          ) {
            if (!seen.has(n)) {
              seen.add(n);
              rows.push(n);
            }
            break;
          }
          n = n.parentElement;
        }
      }
    }

    // Sort by visual top (fallback to doc order)
    rows.sort((a, b) => {
      const ar = a.getBoundingClientRect();
      const br = b.getBoundingClientRect();
      if (ar.top !== br.top) return ar.top - br.top;
      const pos = a.compareDocumentPosition(b);
      if (pos & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
      if (pos & Node.DOCUMENT_POSITION_PRECEDING) return 1;
      return 0;
    });
    return rows;
  }

  /** Cari tombol "Tambahkan postingan" (tombol hijau di kanan bawah) */
  function findAddPostButton() {
    const candidates = findAllByText("Tambahkan postingan");
    // Pilih candidate yang TIDAK ada di dalam row (artinya tombol global), prioritas yang punya role button
    let best = null;
    let bestScore = -Infinity;
    for (const c of candidates) {
      const clickable = climbToClickable(c);
      const tag = clickable.tagName;
      const role = clickable.getAttribute("role");
      let score = 0;
      if (tag === "BUTTON" || role === "button") score += 3;
      // Posisi di bawah → koordinat besar
      const rect = clickable.getBoundingClientRect();
      score += rect.top / 1000;
      // Hindari menangkap "Jadwalkan postingan massal" header
      const t = (clickable.innerText || "").toLowerCase();
      if (t.includes("massal") || t.includes("jadwalkan postingan")) score -= 5;
      if (score > bestScore) {
        bestScore = score;
        best = clickable;
      }
    }
    return best;
  }

  /** Apakah row sudah memiliki media (preview) */
  function rowHasMedia(row) {
    if (!row) return false;
    // heuristik 1: ada img/video preview di area row
    const imgs = row.querySelectorAll("img");
    for (const img of imgs) {
      const r = img.getBoundingClientRect();
      if (r.width >= 40 && r.height >= 40 && !img.src.includes("static.xx.fbcdn")) {
        return true;
      }
    }
    if (row.querySelector("video")) return true;
    // heuristik 2: tombol "Tambahkan foto/video" hilang dari row → media sudah ada
    const stillHasAddBtn = findAllByText("Tambahkan foto/video", { root: row }).length > 0;
    if (!stillHasAddBtn) return true;
    return false;
  }

  /** Apakah row sudah berisi teks */
  function rowHasText(row) {
    const ta = row.querySelector("textarea");
    if (ta && ta.value && ta.value.trim().length > 0) return true;
    const ce = row.querySelector("[contenteditable='true']");
    if (ce && (ce.innerText || ce.textContent || "").trim().length > 0) return true;
    return false;
  }

  /** Apakah row "kosong" (siap diisi) */
  function rowIsEmpty(row) {
    return !rowHasMedia(row) && !rowHasText(row);
  }

  /** Cari input[type=file] yang relevan untuk row ini.
   *  Strategi:
   *   1. Cari di dalam DOM row
   *   2. Click "Tambahkan foto/video" dengan hook pada HTMLInputElement.prototype.click +
   *      MutationObserver untuk mendeteksi input baru yang ter-mount global
   *   3. (Fallback) jika overlay/modal muncul, klik "Pilih dari komputer" / "From your computer"
   */
  async function findFileInputForRow(row, { timeout = 10000 } = {}) {
    // 1) row-scoped
    const inRow = row.querySelector('input[type="file"]');
    if (inRow) return inRow;

    // 2) click hook + mutation observer
    return await new Promise((resolve, reject) => {
      let done = false;
      const origClick = HTMLInputElement.prototype.click;

      const cleanup = () => {
        try { HTMLInputElement.prototype.click = origClick; } catch {}
        try { observer.disconnect(); } catch {}
        clearTimeout(timer);
      };
      const finish = (input, source) => {
        if (done) return;
        done = true;
        cleanup();
        log(`file input ditemukan via ${source}`);
        resolve(input);
      };

      // Patch prototype: intercept ketika halaman memanggil input.click()
      HTMLInputElement.prototype.click = function () {
        if (!done && this.type === "file") {
          finish(this, "prototype-click hook");
          return; // suppress OS file dialog
        }
        return origClick.call(this);
      };

      // Snapshot input file global sebelum klik (agar bisa deteksi yang baru)
      const before = new Set(document.querySelectorAll('input[type="file"]'));

      const observer = new MutationObserver((mutations) => {
        for (const m of mutations) {
          for (const node of m.addedNodes) {
            if (node.nodeType !== 1) continue;
            const el = /** @type {Element} */ (node);
            const found =
              (el.matches?.('input[type="file"]') ? el : null) ||
              el.querySelector?.('input[type="file"]');
            if (found && !before.has(found)) {
              finish(/** @type {HTMLInputElement} */ (found), "mutation observer");
              return;
            }
          }
        }
      });
      observer.observe(document.body, { childList: true, subtree: true });

      const timer = setTimeout(async () => {
        if (done) return;
        // 3) Fallback: cek apakah ada overlay "Pilih dari komputer" / dialog upload
        const uploadKeywords = [
          "Pilih dari komputer",
          "Unggah dari komputer",
          "Unggah",
          "Upload from computer",
          "From your computer",
          "Upload",
        ];
        let clickedUpload = false;
        for (const kw of uploadKeywords) {
          const els = findAllByText(kw);
          if (els.length) {
            // pilih yg paling kecil (deepest)
            els.sort((a, b) => depth(b) - depth(a));
            const target = climbToClickable(els[0]);
            log(`mencoba klik fallback upload: "${kw}"`);
            realClick(target);
            clickedUpload = true;
            break;
          }
        }
        if (clickedUpload) {
          // beri waktu mount input baru
          await sleep(800);
          // observer & hook tetap aktif sebentar lagi
          setTimeout(() => {
            if (done) return;
            // Cek snapshot ulang
            const all = Array.from(document.querySelectorAll('input[type="file"]'));
            const fresh = all.filter((i) => !before.has(i));
            if (fresh.length) finish(fresh[0], "after fallback upload click");
            else {
              cleanup();
              if (!done) {
                done = true;
                reject(
                  new Error(
                    "Timeout menunggu file input ter-mount (" +
                      timeout +
                      "ms). Fallback klik upload sudah dicoba."
                  )
                );
              }
            }
          }, 1500);
        } else {
          cleanup();
          done = true;
          reject(
            new Error(
              "Timeout menunggu file input ter-mount (" +
                timeout +
                "ms). Klik 'Tambahkan foto/video' tidak men-trigger input.click()."
            )
          );
        }
      }, timeout);

      // Trigger button "Tambahkan foto/video" di row
      const addBtn = findAllByText("Tambahkan foto/video", { root: row })[0];
      if (!addBtn) {
        cleanup();
        done = true;
        reject(new Error("Tombol 'Tambahkan foto/video' tidak ditemukan di row"));
        return;
      }
      const clickable = climbToClickable(addBtn);
      log("klik tombol Tambahkan foto/video");
      realClick(clickable);
    });
  }

  /** Set file ke input + dispatch change ala React */
  function setInputFiles(input, files) {
    const dt = new DataTransfer();
    for (const f of files) dt.items.add(f);
    const proto = HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "files")?.set;
    if (setter) setter.call(input, dt.files);
    else input.files = dt.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }

  /** Upload file untuk row */
  async function uploadFilesToRow(row, files) {
    const input = await findFileInputForRow(row, { timeout: 10000 });
    setInputFiles(input, files);
    log(`set ${files.length} file ke input (name=${input.name || "-"}, accept=${input.accept || "-"})`);
    // Tunggu hingga preview muncul atau overlay tertutup
    try {
      await waitFor(() => rowHasMedia(row), { timeout: 30000, label: "preview media" });
    } catch (e) {
      log("warning: preview media belum terdeteksi, lanjut: " + e.message);
    }
    // Jika ada overlay/modal yang masih terbuka karena fallback, tutup ESC
    document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  }

  /** Isi caption ke row */
  async function fillCaptionInRow(row, caption) {
    // Coba textarea terlebih dulu
    let ta = row.querySelector("textarea");
    if (!ta) {
      // fallback contenteditable
      const ce = row.querySelector("[contenteditable='true']");
      if (ce) {
        setContentEditable(ce, caption);
        return;
      }
      throw new Error("Tidak menemukan input teks pada row");
    }
    ta.focus();
    setNativeValue(ta, caption);
  }

  /** Klik tombol dropdown "Terbitkan s..." pada row */
  async function openScheduleDropdown(row) {
    const candidates = Array.from(row.querySelectorAll("button, [role='button']"));
    let btn = null;
    for (const c of candidates) {
      const t = (c.innerText || c.textContent || "").trim().toLowerCase();
      const aria = (c.getAttribute("aria-label") || "").toLowerCase();
      if (t.startsWith("terbitkan") || aria.includes("terbitkan")) {
        // pastikan ini bukan tombol global "Terbitkan" di footer
        const rect = c.getBoundingClientRect();
        const rowRect = row.getBoundingClientRect();
        if (rect.top >= rowRect.top - 5 && rect.bottom <= rowRect.bottom + 5) {
          btn = c;
          break;
        }
      }
    }
    if (!btn) throw new Error("Tombol dropdown jadwal tidak ditemukan pada row");
    realClick(btn);
    // Tunggu popover muncul (ada teks "Jadwalkan" DAN "Terbitkan sekarang")
    const popover = await waitFor(() => {
      const candidates = findAllByText("Jadwalkan");
      for (const el of candidates) {
        let n = el;
        for (let i = 0; i < 12 && n && n !== document.body; i++) {
          const txt = (n.innerText || "").toLowerCase();
          if (txt.includes("jadwalkan") && txt.includes("terbitkan sekarang")) {
            return n;
          }
          n = n.parentElement;
        }
      }
      return null;
    }, { timeout: 5000, label: "popover jadwal" });
    return popover;
  }

  /** Pilih tab "Jadwalkan" di popover */
  async function selectScheduleTab(popover) {
    let tabs = findAllByText("Jadwalkan", { root: popover, exact: true });
    if (!tabs.length) tabs = findAllByText("Jadwalkan", { root: popover });
    if (!tabs.length) throw new Error("Tab Jadwalkan tidak ditemukan di popover");
    // Pilih kandidat terdalam (paling kecil) yang clickable
    tabs.sort((a, b) => depth(b) - depth(a));
    const clickable = climbToClickable(tabs[0]);
    realClick(clickable);
    // Tunggu field tanggal muncul
    await waitFor(() => {
      const inputs = popover.querySelectorAll("input");
      return inputs.length >= 2;
    }, { timeout: 5000, label: "field tanggal/waktu" });
  }

  /** Set tanggal & waktu di popover */
  async function setScheduleDateTime(popover, dateObj) {
    const inputs = Array.from(popover.querySelectorAll("input"));
    if (inputs.length < 2) throw new Error("Field tanggal/waktu tidak lengkap");

    // Identifikasi: input pertama = tanggal, kedua = waktu (berdasarkan ordering & placeholder/aria)
    let dateInput = null, timeInput = null;
    for (const inp of inputs) {
      const v = (inp.value || "") + " " + (inp.getAttribute("aria-label") || "") + " " + (inp.placeholder || "");
      const low = v.toLowerCase();
      if (!dateInput && (/\b\d{1,2}[\/\s\-]\d{1,2}|\b(?:jan|feb|mar|apr|mei|jun|jul|agu|sep|okt|nov|des)/.test(low) || low.includes("tanggal") || low.includes("date"))) {
        dateInput = inp;
      } else if (!timeInput && (/\d{1,2}:\d{2}/.test(low) || low.includes("waktu") || low.includes("time"))) {
        timeInput = inp;
      }
    }
    if (!dateInput) dateInput = inputs[0];
    if (!timeInput) timeInput = inputs[inputs.length - 1];
    if (dateInput === timeInput && inputs.length >= 2) timeInput = inputs[1];

    const dd = dateObj.getDate();
    const mm = dateObj.getMonth();
    const yyyy = dateObj.getFullYear();
    const HH = String(dateObj.getHours()).padStart(2, "0");
    const MM = String(dateObj.getMinutes()).padStart(2, "0");

    // Format kandidat untuk tanggal (coba beberapa)
    const dateCandidates = [
      `${dd} ${INDO_MONTHS_SHORT[mm]} ${yyyy}`,
      `${dd} ${INDO_MONTHS_FULL[mm]} ${yyyy}`,
      `${String(dd).padStart(2, "0")}/${String(mm + 1).padStart(2, "0")}/${yyyy}`,
      `${yyyy}-${String(mm + 1).padStart(2, "0")}-${String(dd).padStart(2, "0")}`,
    ];

    let dateOk = false;
    for (const val of dateCandidates) {
      try {
        dateInput.focus();
        setNativeValue(dateInput, val);
        await sleep(120);
        if ((dateInput.value || "").trim() !== "") {
          dateOk = true;
          break;
        }
      } catch {}
    }
    if (!dateOk) {
      // Last resort: simulasi typing
      dateInput.focus();
      try { dateInput.select?.(); } catch {}
      const val = dateCandidates[0];
      setNativeValue(dateInput, val);
    }

    // Set waktu
    timeInput.focus();
    setNativeValue(timeInput, `${HH}:${MM}`);

    // Blur agar form mendaftarkan perubahan
    dateInput.dispatchEvent(new Event("blur", { bubbles: true }));
    timeInput.dispatchEvent(new Event("blur", { bubbles: true }));
    await sleep(150);
  }

  /** Klik tombol "Perbarui" di popover */
  async function clickPerbarui(popover) {
    const candidates = findAllByText("Perbarui", { root: popover });
    if (!candidates.length) throw new Error("Tombol Perbarui tidak ditemukan");
    const btn = climbToClickable(candidates[0]);
    realClick(btn);
    // Tunggu popover hilang
    await waitFor(() => !document.body.contains(popover) || popover.offsetParent === null, {
      timeout: 5000, label: "popover tertutup",
    }).catch(() => {});
  }

  /** Klik tombol global "Tambahkan postingan" dan tunggu row baru muncul */
  async function addNewPostRow() {
    const before = getPostRows().length;
    const btn = findAddPostButton();
    if (!btn) throw new Error("Tombol 'Tambahkan postingan' tidak ditemukan");
    realClick(btn);
    await waitFor(() => getPostRows().length > before, {
      timeout: 5000, label: "row baru muncul",
    });
    await sleep(150);
  }

  // ---------- UI Badge ----------
  let badge = null;
  function showBadge() {
    if (badge) return;
    badge = document.createElement("div");
    badge.id = "auto-posting-badge";
    badge.textContent = "Auto Posting · Active";
    document.body.appendChild(badge);
  }
  function setBadgeText(text) {
    if (!badge) showBadge();
    if (badge) badge.textContent = text;
  }

  // ---------- Logging ----------
  function log(...args) {
    try {
      console.log("[AutoPosting]", ...args);
    } catch {}
  }

  // ---------- Job runner ----------
  /** State per session */
  const session = {
    skipExisting: true,
    processedCount: 0,
  };

  async function processJob(message) {
    const { job, index, total } = message;
    setBadgeText(`Auto Posting · ${index + 1}/${total}`);

    // Rebuild File objects
    const files = job.files.map((f) => {
      const blob = new Blob([f.buffer], { type: f.type || guessType(f.name) });
      return new File([blob], f.name, { type: blob.type, lastModified: f.lastModified || Date.now() });
    });

    // Tentukan target row
    let row = null;
    if (session.skipExisting && session.processedCount === 0) {
      // Pakai row pertama yang masih kosong, jika ada
      const rows = getPostRows();
      row = rows.find(rowIsEmpty) || null;
    }
    if (!row) {
      // Tambah row baru jika perlu
      const rows = getPostRows();
      const lastRow = rows[rows.length - 1];
      if (!lastRow || !rowIsEmpty(lastRow)) {
        await addNewPostRow();
      }
      const after = getPostRows();
      row = after[after.length - 1];
    }
    if (!row) throw new Error("Tidak bisa menentukan row target");

    // Scroll ke row
    row.scrollIntoView({ block: "center", behavior: "smooth" });
    await sleep(200);

    // Upload media
    await uploadFilesToRow(row, files);

    // Isi caption
    await fillCaptionInRow(row, job.caption);
    await sleep(100);

    // Set jadwal (jika ada)
    if (job.scheduledAt) {
      const dt = new Date(job.scheduledAt);
      const popover = await openScheduleDropdown(row);
      await selectScheduleTab(popover);
      await setScheduleDateTime(popover, dt);
      await clickPerbarui(popover);
    }

    session.processedCount += 1;
    return { ok: true, message: "OK" };
  }

  function guessType(name) {
    const m = name.toLowerCase().match(/\.([a-z0-9]+)$/);
    if (!m) return "application/octet-stream";
    const map = {
      jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif",
      webp: "image/webp", bmp: "image/bmp", heic: "image/heic", heif: "image/heif", tiff: "image/tiff",
      mp4: "video/mp4", mov: "video/quicktime", m4v: "video/x-m4v", webm: "video/webm",
      mkv: "video/x-matroska", avi: "video/x-msvideo", "3gp": "video/3gpp",
    };
    return map[m[1]] || "application/octet-stream";
  }

  // ---------- Message handler ----------
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || !msg.type) return;

    if (msg.type === "PING") {
      sendResponse({ ok: true, where: "content" });
      return;
    }

    if (msg.type === "INIT_SESSION") {
      session.skipExisting = !!msg.options?.skipExisting;
      session.processedCount = 0;
      showBadge();
      sendResponse({ ok: true });
      return;
    }

    if (msg.type === "PROCESS_JOB") {
      processJob(msg)
        .then((res) => sendResponse(res))
        .catch((err) => {
          log("PROCESS_JOB error:", err);
          sendResponse({ ok: false, error: err?.message || String(err) });
        });
      return true; // async
    }
  });

  // ---------- Debug helper ----------
  // Pasang di window agar user bisa cek state dari DevTools console.
  window.__autoPostingDebug = function () {
    const rows = getPostRows();
    const addBtn = findAddPostButton();
    const fileInputs = Array.from(document.querySelectorAll('input[type="file"]'));
    return {
      rowCount: rows.length,
      rows: rows.map((r, i) => ({
        index: i,
        rect: r.getBoundingClientRect(),
        hasMedia: rowHasMedia(r),
        hasText: rowHasText(r),
        textareaPresent: !!r.querySelector("textarea"),
        addMediaBtnPresent: findAllByText("Tambahkan foto/video", { root: r }).length > 0,
      })),
      addPostButton: addBtn ? { tag: addBtn.tagName, text: addBtn.innerText } : null,
      fileInputCount: fileInputs.length,
      fileInputs: fileInputs.map((i) => ({
        accept: i.accept,
        name: i.name,
        multiple: i.multiple,
        rect: i.getBoundingClientRect(),
        attachedToDom: document.body.contains(i),
      })),
      url: location.href,
      version: "1.1.0",
    };
  };

  log("content script loaded v1.1.0 on", location.href);
})();
