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

  /** Native setter helper (per-tag). Tracker.setValue di React menggunakan
   *  property descriptor pada prototype. Setting via setter ini diikuti dispatch
   *  InputEvent membuat React onChange terpicu DAN state-nya ter-sync. */
  function setNativeProtoValue(el, value) {
    let proto;
    if (el instanceof HTMLTextAreaElement) proto = HTMLTextAreaElement.prototype;
    else if (el instanceof HTMLInputElement) proto = HTMLInputElement.prototype;
    else proto = null;
    if (proto) {
      const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
      if (setter) { setter.call(el, value); return true; }
    }
    try { el.value = value; return true; } catch { return false; }
  }

  /** Dispatch beforeinput dengan inputType=insertText. Cara native untuk
   *  Lexical/React contenteditable menerima text input. TIDAK pakai
   *  ClipboardEvent karena di Meta itu memicu error 'getIn' di internal
   *  Lexical/Immutable state. */
  function dispatchBeforeInputText(el, text, inputType = "insertText") {
    try { el.focus(); } catch {}
    try {
      const evt = new InputEvent("beforeinput", {
        inputType,
        data: text,
        bubbles: true,
        cancelable: true,
      });
      return el.dispatchEvent(evt);
    } catch {
      return false;
    }
  }

  /** Hapus seluruh isi input/textarea/contenteditable, dgn event yang React-aware. */
  function clearTextField(el) {
    try { el.focus(); } catch {}
    if (el.tagName === "TEXTAREA" || el.tagName === "INPUT") {
      // Select all
      try { el.setSelectionRange?.(0, (el.value || "").length); } catch {}
      try { el.select?.(); } catch {}
      // beforeinput \u2192 setter \u2192 input event chain
      try {
        el.dispatchEvent(new InputEvent("beforeinput", {
          inputType: "deleteContentBackward", bubbles: true, cancelable: true,
        }));
      } catch {}
      setNativeProtoValue(el, "");
      try {
        el.dispatchEvent(new InputEvent("input", {
          inputType: "deleteContentBackward", bubbles: true,
        }));
      } catch {}
      try { el.dispatchEvent(new Event("change", { bubbles: true })); } catch {}
    } else {
      // contenteditable
      try {
        const sel = window.getSelection();
        if (sel) {
          const range = document.createRange();
          range.selectNodeContents(el);
          sel.removeAllRanges();
          sel.addRange(range);
        }
        document.execCommand("delete", false, null);
      } catch {}
    }
  }

  /** Fill teks ke input/textarea/contenteditable dengan event React-compatible.
   *  Strategy:
   *   - contenteditable (Lexical): dispatch beforeinput(insertText). Lexical
   *     onBeforeInput menerima ini dgn aman dan update internal model.
   *   - textarea/input: native setter + InputEvent(input) - React onChange
   *     terpicu via fiber tracker. */
  function fillTextField(el, text) {
    if (!el) return false;
    try { el.focus(); } catch {}

    const isText = el.tagName === "TEXTAREA" || el.tagName === "INPUT";
    const readVal = () => isText ? (el.value || "") : (el.textContent || "");

    // Step 1: Clear existing content
    clearTextField(el);

    if (isText) {
      // beforeinput \u2192 setter \u2192 input event
      try {
        el.dispatchEvent(new InputEvent("beforeinput", {
          inputType: "insertText", data: text, bubbles: true, cancelable: true,
        }));
      } catch {}
      setNativeProtoValue(el, text);
      try {
        el.dispatchEvent(new InputEvent("input", {
          inputType: "insertText", data: text, bubbles: true,
        }));
      } catch {
        el.dispatchEvent(new Event("input", { bubbles: true }));
      }
      try { el.dispatchEvent(new Event("change", { bubbles: true })); } catch {}
    } else {
      // contenteditable (Lexical-like): dispatch beforeinput insertText.
      // Lexical akan handle insertion ke internal model + render.
      dispatchBeforeInputText(el, text, "insertText");
      // Beri sedikit waktu lalu verifikasi
      // (Verifikasi async tidak bisa di sync function; trust Lexical to insert)
      // Last resort kalau Lexical tidak insert: pakai execCommand
      if (!el.textContent || !el.textContent.includes(text)) {
        try { document.execCommand("insertText", false, text); } catch {}
      }
      try {
        el.dispatchEvent(new InputEvent("input", {
          inputType: "insertText", data: text, bubbles: true,
        }));
      } catch {}
    }

    return readVal().includes(text);
  }

  /** Set value ke spinbutton (role=spinbutton, biasanya untuk jam/menit Meta).
   *  Strategy: native setter + InputEvent. Jika tidak nyangkut, pakai keyboard
   *  arrow simulation utk increment/decrement dari nilai current ke target. */
  function setSpinbutton(el, targetValue) {
    if (!el) return false;
    try { el.focus(); } catch {}
    const t = String(targetValue);
    // Try native setter first
    setNativeProtoValue(el, t);
    try {
      el.dispatchEvent(new InputEvent("input", {
        inputType: "insertReplacementText", data: t, bubbles: true,
      }));
    } catch {
      el.dispatchEvent(new Event("input", { bubbles: true }));
    }
    try { el.dispatchEvent(new Event("change", { bubbles: true })); } catch {}
    try { el.dispatchEvent(new FocusEvent("blur", { bubbles: true })); } catch {}
    return true;
  }

  /** Klik manusia: dispatch pointer/mouse events (di isolated world) */
  function realClick(el) {
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    const opts = {
      bubbles: true, cancelable: true, composed: true, view: window,
      clientX: x, clientY: y, screenX: x, screenY: y,
      button: 0, buttons: 1, detail: 1,
    };
    const popts = { ...opts, pointerType: "mouse", pointerId: 1, isPrimary: true, pressure: 0.5 };
    el.dispatchEvent(new PointerEvent("pointerover", popts));
    el.dispatchEvent(new PointerEvent("pointerenter", popts));
    el.dispatchEvent(new MouseEvent("mouseover", opts));
    el.dispatchEvent(new MouseEvent("mouseenter", opts));
    el.dispatchEvent(new PointerEvent("pointerdown", popts));
    el.dispatchEvent(new MouseEvent("mousedown", opts));
    el.dispatchEvent(new PointerEvent("pointerup", popts));
    el.dispatchEvent(new MouseEvent("mouseup", opts));
    el.dispatchEvent(new MouseEvent("click", opts));
  }

  // ---------- MAIN WORLD bridge (lewat background service worker) ----------
  // Konversi ArrayBuffer → base64 (chunked agar tidak overflow stack)
  function abToBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    const CHUNK = 0x8000;
    let str = "";
    for (let i = 0; i < bytes.length; i += CHUNK) {
      str += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    }
    return btoa(str);
  }
  async function filesToSpecs(files) {
    const out = [];
    for (const f of files) {
      const buf = await f.arrayBuffer();
      out.push({
        name: f.name,
        type: f.type || guessType(f.name),
        lastModified: f.lastModified || Date.now(),
        b64: abToBase64(buf),
      });
    }
    return out;
  }

  /** Trigger element.click() di MAIN world (lewat background → chrome.scripting). */
  async function clickInMainWorld(el) {
    if (!el) return false;
    const tag = "__ap_click_" + Math.random().toString(36).slice(2);
    el.setAttribute("data-ap-click", tag);
    try {
      const res = await chrome.runtime.sendMessage({
        type: "CLICK_IN_MAIN_WORLD",
        selector: '[data-ap-click="' + tag + '"]',
      });
      log("main-world click result:", res?.res);
      return !!res?.ok;
    } catch (e) {
      log("main-world click error:", String(e));
      return false;
    } finally {
      try { el.removeAttribute("data-ap-click"); } catch {}
    }
  }

  /** Set input[type=file].files di MAIN world. */
  async function setFilesInMainWorld(input, files) {
    if (!input) return false;
    const tag = "__ap_input_" + Math.random().toString(36).slice(2);
    input.setAttribute("data-ap-input", tag);
    try {
      const specs = await filesToSpecs(files);
      const res = await chrome.runtime.sendMessage({
        type: "SET_FILES_IN_MAIN_WORLD",
        selector: '[data-ap-input="' + tag + '"]',
        files: specs,
      });
      log("main-world set-files result:", res?.res);
      return !!(res?.ok && res?.res?.ok);
    } catch (e) {
      log("main-world set-files error:", String(e));
      return false;
    } finally {
      try { input.removeAttribute("data-ap-input"); } catch {}
    }
  }

  /** Install patch session permanent (idempotent). */
  async function installSessionPatch() {
    try {
      const res = await chrome.runtime.sendMessage({ type: "INSTALL_SESSION_PATCH" });
      log("session patch install:", res?.res);
      return res?.ok === true;
    } catch (e) {
      log("install session patch error:", String(e));
      return false;
    }
  }

  /** Uninstall (deaktivasi) patch session. */
  async function uninstallSessionPatch() {
    try {
      await chrome.runtime.sendMessage({ type: "UNINSTALL_SESSION_PATCH" });
    } catch {}
  }

  /** Upload v2: pre-queue files ke patch + klik tombol via main world + tunggu consumed flag. */
  async function uploadV2(button, files, opts = {}) {
    if (!button) return { ok: false, error: "button null" };
    const tag = "__ap_upload_" + Math.random().toString(36).slice(2);
    button.setAttribute("data-ap-upload", tag);
    try {
      const specs = await filesToSpecs(files);
      const res = await chrome.runtime.sendMessage({
        type: "UPLOAD_V2",
        buttonSelector: '[data-ap-upload="' + tag + '"]',
        files: specs,
        timeoutMs: opts.timeout || 8000,
      });
      log("upload-v2 result:", res?.res);
      const frameResult = res?.res?.[0]?.result;
      if (frameResult && frameResult.ok) {
        return { ok: true, consumed: frameResult.consumed };
      }
      return { ok: false, error: frameResult?.error || "unknown error" };
    } catch (e) {
      log("upload-v2 error:", String(e));
      return { ok: false, error: String(e) };
    } finally {
      try { button.removeAttribute("data-ap-upload"); } catch {}
    }
  }

  /** Dispatch trusted drop di MAIN world. */
  async function dropFilesInMainWorld(target, files) {
    if (!target) return false;
    const tag = "__ap_drop_" + Math.random().toString(36).slice(2);
    target.setAttribute("data-ap-drop", tag);
    try {
      const specs = await filesToSpecs(files);
      const res = await chrome.runtime.sendMessage({
        type: "DROP_FILES_IN_MAIN_WORLD",
        selector: '[data-ap-drop="' + tag + '"]',
        files: specs,
      });
      log("main-world drop result:", res?.res);
      return !!(res?.ok && res?.res?.ok);
    } catch (e) {
      log("main-world drop error:", String(e));
      return false;
    } finally {
      try { target.removeAttribute("data-ap-drop"); } catch {}
    }
  }

  /** Klik full power: synthetic events + native .click() di main world. */
  async function ultraClick(el) {
    if (!el) return;
    try { el.scrollIntoView({ block: "center" }); } catch {}
    await sleep(60);
    const clickable = climbToClickable(el);
    realClick(clickable);
    await clickInMainWorld(clickable);
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

  /** Simulasi drag-drop file ke elemen target. Banyak composer Meta menerima drop event. */
  function dispatchDropOnElement(target, files) {
    const dt = new DataTransfer();
    for (const f of files) dt.items.add(f);
    const rect = target.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    const make = (type) =>
      new DragEvent(type, {
        bubbles: true,
        cancelable: true,
        composed: true,
        dataTransfer: dt,
        clientX: x,
        clientY: y,
      });
    target.dispatchEvent(make("dragenter"));
    target.dispatchEvent(make("dragover"));
    target.dispatchEvent(make("drop"));
  }

  /** Cari modal aktif (yang baru ditambahkan ke DOM) */
  function findActiveModal() {
    // role=dialog terlebih dulu
    const dialogs = Array.from(document.querySelectorAll('[role="dialog"]'));
    // Filter yang visible & on-top
    const visible = dialogs.filter((d) => {
      const r = d.getBoundingClientRect();
      return r.width > 100 && r.height > 100 && d.offsetParent !== null;
    });
    if (visible.length) {
      // ambil yang terakhir di doc order
      visible.sort((a, b) => {
        const pos = a.compareDocumentPosition(b);
        if (pos & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
        if (pos & Node.DOCUMENT_POSITION_PRECEDING) return 1;
        return 0;
      });
      return visible[visible.length - 1];
    }
    return null;
  }

  /** Cari tombol "Tambahkan foto/video" yang clickable di row (deepest text element → climb ke role=button). */
  function findAddMediaButton(row) {
    const addBtn = findInnermostByText("Tambahkan foto/video", { root: row });
    if (!addBtn) return null;
    return climbToClickable(addBtn);
  }

  /** Coba klik tombol upload di dalam modal aktif */
  async function clickUploadInModal(modal) {
    const uploadKeywords = [
      "Pilih dari komputer",
      "Unggah dari komputer",
      "Pilih file",
      "Pilih foto",
      "Unggah foto",
      "Unggah video",
      "Upload from computer",
      "From your computer",
      "Choose from computer",
      "Browse",
      "Telusuri",
      "Unggah",
      "Upload",
    ];
    for (const kw of uploadKeywords) {
      const els = findAllByText(kw, { root: modal });
      if (els.length) {
        els.sort((a, b) => depth(b) - depth(a));
        const target = climbToClickable(els[0]);
        log(`ultraClick kandidat upload di modal: "${kw}"`);
        await ultraClick(target);
        return kw;
      }
    }
    return null;
  }

  /** Race: tunggu media muncul di row ATAU dialog error muncul. */
  async function waitForUploadOutcome(row, timeoutMs = 30000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (rowHasMedia(row)) return { hasMedia: true, rejected: false };
      const closed = await closeFileReadErrorDialog();
      if (closed.closed) {
        return { hasMedia: false, rejected: true, reason: closed.reason };
      }
      await sleep(300);
    }
    return { hasMedia: false, rejected: false };
  }

  /** Deteksi & tutup dialog error "Tidak Bisa Membaca File" / "Cannot read file" */
  async function closeFileReadErrorDialog() {
    const errorKeywords = [
      "Tidak Bisa Membaca File",
      "tidak bisa diunggah",
      "tidak dapat diunggah",
      "Cannot read file",
      "couldn\u2019t be uploaded",
      "couldn't be uploaded",
      "Foto harus berukuran kurang dari",
      "Photo must be smaller",
    ];
    const dialogs = Array.from(document.querySelectorAll('[role="dialog"], [role="alertdialog"]'));
    for (const d of dialogs) {
      const r = d.getBoundingClientRect();
      if (r.width < 50 || r.height < 50 || d.offsetParent === null) continue;
      const txt = (d.innerText || "").toLowerCase();
      const hit = errorKeywords.some((kw) => txt.includes(kw.toLowerCase()));
      if (!hit) continue;
      log("error dialog terdeteksi, mencoba tutup");
      const closeKeywords = ["Tutup", "OK", "Oke", "Close", "Dismiss", "Batal", "Cancel"];
      for (const kw of closeKeywords) {
        const btns = findAllByText(kw, { root: d });
        if (btns.length) {
          btns.sort((a, b) => depth(b) - depth(a));
          const target = climbToClickable(btns[0]);
          await ultraClick(target);
          await sleep(200);
          return { closed: true, reason: txt.substring(0, 500) };
        }
      }
      pressEscape();
      await sleep(200);
      return { closed: true, reason: txt.substring(0, 500), via: "escape" };
    }
    return { closed: false };
  }

  /** Dump isi modal/halaman untuk diagnosis */
  function dumpModalState() {
    const modal = findActiveModal();
    const fileInputs = Array.from(document.querySelectorAll('input[type="file"]'));
    const buttons = modal
      ? Array.from(modal.querySelectorAll('button, [role="button"]')).map((b) => ({
          text: (b.innerText || "").trim().substring(0, 60),
          aria: b.getAttribute("aria-label"),
        }))
      : null;
    return { modalFound: !!modal, buttons, fileInputCount: fileInputs.length };
  }

  /** Cari input[type=file] yang baru muncul setelah suatu aksi. */
  function watchForFileInput({ timeout = 8000 } = {}) {
    return new Promise((resolve) => {
      let done = false;
      const before = new Set(document.querySelectorAll('input[type="file"]'));

      const cleanup = () => {
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

      // Poll dulu: kalau sudah ada di DOM, langsung resolve
      const existing = document.querySelector('input[type="file"]');
      if (existing) {
        finish(existing, "existing-input snapshot");
        return;
      }

      const observer = new MutationObserver(() => {
        // pendekatan lebih aman: scan ulang dokumen, ambil yang "baru"
        const all = Array.from(document.querySelectorAll('input[type="file"]'));
        for (const inp of all) {
          if (!before.has(inp)) {
            finish(inp, "mutation observer");
            return;
          }
        }
      });
      observer.observe(document.body, { childList: true, subtree: true });

      const timer = setTimeout(() => {
        if (!done) {
          done = true;
          cleanup();
          resolve(null);
        }
      }, timeout);
    });
  }

  /** Set files via main world + dispatch change/input. Fallback ke isolated world. */
  async function setFilesEverywhere(input, files) {
    const ok = await setFilesInMainWorld(input, files);
    if (!ok) {
      log("setFilesInMainWorld gagal, fallback ke isolated world");
      setInputFiles(input, files);
    }
  }

  /** Upload file untuk row. Pakai UPLOAD_V2 (session patch permanent).
   *   1) Cari tombol "Tambahkan foto/video" di row → pre-queue files ke patch → klik tombol → patch consume
   *   2) Fallback: kalau ada modal upload di dalam, klik tombol upload di modal & ulang flow
   *   3) Fallback terakhir: drop files trusted via main world
   */
  async function uploadFilesToRow(row, files) {
    // === Step 1: combo main-world ===
    const addBtn = findAddMediaButton(row);
    if (!addBtn) throw new Error("Tombol 'Tambahkan foto/video' tidak ditemukan di row");

    log("step 1: UPLOAD_V2 (session patch)");
    let res = await uploadV2(addBtn, files, { timeout: 8000 });
    if (res.ok) {
      log(`step 1 berhasil, file di-set ke input via patch`);
      // Tunggu preview muncul ATAU error dialog Meta muncul (race)
      const verdict = await waitForUploadOutcome(row, 30000);
      pressEscape();
      if (verdict.rejected) {
        throw new Error("Meta tolak file: " + (verdict.reason || "format/size tidak valid"));
      }
      if (!verdict.hasMedia) {
        log("warning preview media: tidak terlihat, lanjut");
      }
      return;
    }
    log("step 1 gagal: " + res.error);

    // Sebelum lanjut step lain, cek/tutup error dialog yang mungkin muncul
    await closeFileReadErrorDialog();

    // === Step 2: cek modal, klik tombol upload di dalam modal, ulangi ===
    const modal = findActiveModal();
    if (modal) {
      log("step 2: modal terdeteksi setelah step 1, scan tombol upload");
      const uploadKeywords = [
        "Pilih dari komputer",
        "Unggah dari komputer",
        "Pilih file",
        "Pilih foto",
        "Unggah foto",
        "Unggah video",
        "Upload from computer",
        "From your computer",
        "Choose from computer",
        "Browse",
        "Telusuri",
        "Unggah",
        "Upload",
      ];
      for (const kw of uploadKeywords) {
        const els = findAllByText(kw, { root: modal });
        if (!els.length) continue;
        els.sort((a, b) => depth(b) - depth(a));
        const target = climbToClickable(els[0]);
        log(`step 2: coba kombo via tombol modal "${kw}"`);
        res = await uploadV2(target, files, { timeout: 8000 });
        if (res.ok) {
          log(`step 2 berhasil, file di-set ke input via patch`);
          const verdict = await waitForUploadOutcome(row, 30000);
          pressEscape();
          if (verdict.rejected) {
            throw new Error("Meta tolak file: " + (verdict.reason || "format/size tidak valid"));
          }
          return;
        }
      }
    }

    // === Step 3: drag-drop trusted ke row ===
    log("step 3: drag-drop trusted via main world");
    const dropOk = await dropFilesInMainWorld(row, files);
    if (dropOk) {
      try {
        await waitFor(() => rowHasMedia(row), { timeout: 15000, label: "preview media (drop)" });
        pressEscape();
        return;
      } catch (e) {
        log("step 3 preview tidak muncul: " + e.message);
      }
    }

    // Diagnosis akhir
    const diag = dumpModalState();
    log("DIAGNOSIS upload gagal:", diag);
    pressEscape();
    throw new Error(
      "Gagal upload media. Modal: " +
        (diag.modalFound ? "YA (" + (diag.buttons?.length || 0) + " tombol)" : "TIDAK") +
        ", file inputs di DOM: " +
        diag.fileInputCount +
        ". Detail: " +
        (res?.error || "-") +
        ". Cek console."
    );
  }

  function pressEscape() {
    try {
      const opts = { key: "Escape", code: "Escape", keyCode: 27, which: 27, bubbles: true };
      document.body.dispatchEvent(new KeyboardEvent("keydown", opts));
      document.body.dispatchEvent(new KeyboardEvent("keyup", opts));
    } catch {}
  }

  /** Isi caption ke row */
  async function fillCaptionInRow(row, caption) {
    // Prioritas: rich-editor (Lexical/contenteditable) dulu, baru textarea polos.
    // Jika hanya kita target textarea sementara Meta render placeholder via
    // Lexical state, placeholder akan tetap tampil overlay & React state empty.
    let target =
      row.querySelector("[role='textbox'][contenteditable='true']") ||
      row.querySelector("[contenteditable='true']") ||
      row.querySelector("textarea");
    if (!target) throw new Error("Tidak menemukan input teks pada row");
    log("fill caption target:", target.tagName,
        "role=", target.getAttribute("role"),
        "contenteditable=", target.getAttribute("contenteditable"));
    fillTextField(target, caption);
    // Beri sedikit waktu agar React/Lexical update state
    await sleep(120);
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
    await ultraClick(btn);
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

  /** Cari semua input field jadwal di seluruh dokumen (date, jam, menit).
   *  Filter by visibility + placeholder/aria pattern. Tidak rely pada
   *  reference popover yang bisa stale setelah Meta re-render. */
  function findScheduleInputsInDocument() {
    const all = Array.from(document.querySelectorAll("input"));
    return all.filter((i) => {
      const rect = i.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return false;
      const ph = (i.placeholder || "").toLowerCase();
      const aria = (i.getAttribute("aria-label") || "").toLowerCase();
      const role = (i.getAttribute("role") || "").toLowerCase();
      return (
        ph.includes("dd") || ph.includes("mm") || ph.includes("yyyy") ||
        aria === "jam" || aria.includes("hour") || aria === "h" ||
        aria === "menit" || aria.includes("minute") || aria === "min" || aria === "m" ||
        aria.includes("tanggal") || aria.includes("date") ||
        role === "spinbutton"
      );
    });
  }

  /** Pilih tab "Jadwalkan" di popover */
  async function selectScheduleTab(popover) {
    let tabs = findAllByText("Jadwalkan", { root: popover, exact: true });
    if (!tabs.length) tabs = findAllByText("Jadwalkan", { root: popover });
    if (!tabs.length) {
      // popover ref bisa stale; coba dari seluruh dokumen
      tabs = findAllByText("Jadwalkan", { exact: true });
      if (!tabs.length) tabs = findAllByText("Jadwalkan");
    }
    if (!tabs.length) throw new Error("Tab Jadwalkan tidak ditemukan di popover");
    // Pilih kandidat terdalam (paling kecil) yang clickable
    tabs.sort((a, b) => depth(b) - depth(a));
    const clickable = climbToClickable(tabs[0]);
    await ultraClick(clickable);
    // Tunggu field tanggal muncul: query dari document, bukan dari popover
    // (popover bisa di-remount oleh Meta saat tab switch).
    await waitFor(() => {
      const sched = findScheduleInputsInDocument();
      return sched.length >= 2;
    }, { timeout: 8000, label: "field tanggal/waktu" });
  }

  /** Set tanggal & waktu di popover.
   *  Meta layout (May 2026): 1 date input (placeholder "dd/mm/yyyy") + 2 spinbutton
   *  inputs terpisah (aria-label "jam" + "menit"). Query dari document agar
   *  tidak terkena stale popover reference. */
  async function setScheduleDateTime(popover, dateObj) {
    // Coba dari popover dulu, jika kosong fallback ke document-wide search
    let inputs = Array.from(popover.querySelectorAll("input"));
    if (inputs.length < 2) inputs = findScheduleInputsInDocument();
    log("schedule inputs found:", inputs.length, inputs.map((i) => ({
      type: i.type,
      role: i.getAttribute("role"),
      placeholder: i.placeholder,
      aria: i.getAttribute("aria-label"),
      value: i.value,
      ariaNow: i.getAttribute("aria-valuenow"),
    })));
    if (inputs.length < 2) throw new Error("Field tanggal/waktu tidak lengkap");

    let dateInput = null, jamInput = null, menitInput = null;
    for (const inp of inputs) {
      const aria = (inp.getAttribute("aria-label") || "").toLowerCase();
      const placeholder = (inp.placeholder || "").toLowerCase();
      const role = (inp.getAttribute("role") || "").toLowerCase();
      // Date input: placeholder "dd/mm/yyyy" atau pola tanggal
      if (!dateInput && (placeholder.includes("dd") || placeholder.includes("mm") || placeholder.includes("yyyy") ||
          aria.includes("tanggal") || aria.includes("date"))) {
        dateInput = inp;
        continue;
      }
      // Jam (hour) spinbutton
      if (!jamInput && (aria === "jam" || aria.includes("hour") || aria === "h")) {
        jamInput = inp;
        continue;
      }
      // Menit (minute) spinbutton
      if (!menitInput && (aria === "menit" || aria.includes("minute") || aria === "min" || aria === "m")) {
        menitInput = inp;
        continue;
      }
    }
    // Fallback heuristic kalau aria-label berbeda
    if (!dateInput) dateInput = inputs[0];
    const spinbuttons = inputs.filter((i) => i.getAttribute("role") === "spinbutton" && i !== dateInput);
    if (!jamInput && spinbuttons[0]) jamInput = spinbuttons[0];
    if (!menitInput && spinbuttons[1]) menitInput = spinbuttons[1];
    // Last resort: kalau hanya 2 input (date + 1 time gabungan)
    const has2Spinbuttons = !!(jamInput && menitInput);

    log("schedule picked:",
        "date=", dateInput && { val: dateInput.value, aria: dateInput.getAttribute("aria-label"), placeholder: dateInput.placeholder },
        "jam=", jamInput && { val: jamInput.value, aria: jamInput.getAttribute("aria-label"), role: jamInput.getAttribute("role") },
        "menit=", menitInput && { val: menitInput.value, aria: menitInput.getAttribute("aria-label"), role: menitInput.getAttribute("role") });

    const dd = dateObj.getDate();
    const mm = dateObj.getMonth();
    const yyyy = dateObj.getFullYear();
    const HH = String(dateObj.getHours()).padStart(2, "0");
    const MM = String(dateObj.getMinutes()).padStart(2, "0");

    // --- DATE ---
    // Format kandidat untuk tanggal. dd/mm/yyyy paling kompatibel sesuai placeholder Meta.
    const dateCandidates = [
      `${String(dd).padStart(2, "0")}/${String(mm + 1).padStart(2, "0")}/${yyyy}`,
      `${dd}/${mm + 1}/${yyyy}`,
      `${dd} ${INDO_MONTHS_SHORT[mm]} ${yyyy}`,
      `${dd} ${INDO_MONTHS_FULL[mm]} ${yyyy}`,
      `${yyyy}-${String(mm + 1).padStart(2, "0")}-${String(dd).padStart(2, "0")}`,
    ];

    let dateOk = false;
    for (const val of dateCandidates) {
      try {
        fillTextField(dateInput, val);
        await sleep(220);
        const got = (dateInput.value || "").trim();
        log(`try date "${val}" -> input.value="${got}"`);
        if (got !== "") {
          dateOk = true;
          break;
        }
      } catch (e) {
        log(`set date "${val}" error:`, String(e));
      }
    }
    if (!dateOk) log("WARN: semua format tanggal gagal di-set");

    // Commit date (Enter + blur)
    try {
      dateInput.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true }));
      dateInput.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true }));
      dateInput.dispatchEvent(new FocusEvent("blur", { bubbles: true }));
    } catch {}
    await sleep(120);

    // --- TIME ---
    if (has2Spinbuttons) {
      // Set jam (hour) sebagai integer (Meta menerima 1-2 digit)
      const hourVal = String(dateObj.getHours());
      const minVal = String(dateObj.getMinutes());
      setSpinbutton(jamInput, hourVal);
      await sleep(140);
      log(`set jam "${hourVal}" -> input.value="${jamInput.value || ""}" ariaNow="${jamInput.getAttribute("aria-valuenow")}"`);
      setSpinbutton(menitInput, minVal);
      await sleep(140);
      log(`set menit "${minVal}" -> input.value="${menitInput.value || ""}" ariaNow="${menitInput.getAttribute("aria-valuenow")}"`);

      // Commit dengan blur
      try {
        jamInput.dispatchEvent(new FocusEvent("blur", { bubbles: true }));
        menitInput.dispatchEvent(new FocusEvent("blur", { bubbles: true }));
      } catch {}
    } else {
      // Legacy: 1 input time "HH:MM"
      const fallbackTimeInput = jamInput || inputs[inputs.length - 1];
      if (fallbackTimeInput && fallbackTimeInput !== dateInput) {
        const timeVal = `${HH}:${MM}`;
        fillTextField(fallbackTimeInput, timeVal);
        await sleep(180);
        log(`set time fallback "${timeVal}" -> input.value="${fallbackTimeInput.value || ""}"`);
        try { fallbackTimeInput.dispatchEvent(new FocusEvent("blur", { bubbles: true })); } catch {}
      }
    }
    await sleep(220);
  }

  /** Klik tombol "Perbarui" di popover */
  async function clickPerbarui(popover) {
    const candidates = findAllByText("Perbarui", { root: popover });
    if (!candidates.length) throw new Error("Tombol Perbarui tidak ditemukan");
    const btn = climbToClickable(candidates[0]);
    await ultraClick(btn);
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
    await ultraClick(btn);
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

  // ArrayBuffer hilang lewat chrome.tabs.sendMessage (JSON serialization),
  // jadi control.js kirim b64. Decode di sini.
  function b64ToBytes(b64) {
    const bin = atob(b64);
    const len = bin.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  }

  async function processJob(message) {
    const { job, index, total } = message;
    setBadgeText(`Auto Posting · ${index + 1}/${total}`);

    // Rebuild File objects dari base64
    const files = job.files.map((f) => {
      // Backward compat: kalau ada buffer ArrayBuffer (legacy), pakai itu;
      // tapi sekarang yang aktif adalah f.b64
      let bytes;
      if (f.b64) {
        bytes = b64ToBytes(f.b64);
      } else if (f.buffer) {
        bytes = f.buffer;
      } else {
        throw new Error(`File ${f.name}: tidak ada payload (b64/buffer) \u2014 message serialization issue`);
      }
      const type = f.type || guessType(f.name);
      const blob = new Blob([bytes], { type });
      const file = new File([blob], f.name, { type: blob.type, lastModified: f.lastModified || Date.now() });
      log(`rebuild file: ${f.name} \u2192 ${file.size} bytes, type=${file.type}`);
      return file;
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

  // ---------- Floating panel overlay (iframe) ----------
  const PANEL_ID = "__autoPostingPanel";

  function togglePanel() {
    const existing = document.getElementById(PANEL_ID);
    if (existing) {
      const visible = existing.style.display !== "none";
      existing.style.display = visible ? "none" : "block";
      return;
    }
    createPanel();
  }

  function createPanel() {
    const wrap = document.createElement("div");
    wrap.id = PANEL_ID;
    wrap.style.cssText = [
      "position:fixed",
      "top:80px",
      "right:24px",
      "width:420px",
      "height:min(720px, calc(100vh - 100px))",
      "z-index:2147483647",
      "background:#fff",
      "border:1px solid rgba(15,23,42,0.12)",
      "border-radius:14px",
      "box-shadow:0 18px 48px rgba(15,23,42,0.22), 0 2px 6px rgba(15,23,42,0.08)",
      "overflow:hidden",
      "display:flex",
      "flex-direction:column",
      "font-family:-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
    ].join(";");

    const bar = document.createElement("div");
    bar.style.cssText = [
      "display:flex",
      "align-items:center",
      "gap:8px",
      "padding:8px 10px",
      "background:linear-gradient(135deg,#4f46e5,#7c3aed)",
      "color:#fff",
      "cursor:move",
      "user-select:none",
      "flex-shrink:0",
    ].join(";");
    bar.innerHTML = `
      <div style="display:flex;align-items:center;gap:8px;flex:1">
        <div style="width:22px;height:22px;border-radius:6px;background:rgba(255,255,255,0.18);display:grid;place-items:center">
          <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"></polygon></svg>
        </div>
        <span style="font-weight:600;font-size:12.5px;letter-spacing:-0.01em">Auto Posting</span>
      </div>
      <button data-act="min" title="Minimize" style="background:transparent;border:none;color:#fff;cursor:pointer;padding:4px 6px;border-radius:6px;font-size:14px;line-height:1">\u2013</button>
      <button data-act="close" title="Tutup" style="background:transparent;border:none;color:#fff;cursor:pointer;padding:4px 6px;border-radius:6px;font-size:14px;line-height:1">\u2715</button>
    `;
    wrap.appendChild(bar);

    const iframe = document.createElement("iframe");
    iframe.src = chrome.runtime.getURL("control.html");
    iframe.style.cssText = "border:0;width:100%;flex:1;background:#f6f8fb;display:block";
    iframe.setAttribute("allow", "clipboard-read; clipboard-write");
    wrap.appendChild(iframe);

    document.body.appendChild(wrap);

    // Buttons
    bar.querySelector('[data-act="min"]').addEventListener("click", (e) => {
      e.stopPropagation();
      const minimized = iframe.style.display === "none";
      iframe.style.display = minimized ? "block" : "none";
      wrap.style.height = minimized ? "min(720px, calc(100vh - 100px))" : "auto";
    });
    bar.querySelector('[data-act="close"]').addEventListener("click", (e) => {
      e.stopPropagation();
      wrap.remove();
    });

    // Drag
    let dragging = false;
    let startX = 0, startY = 0, startLeft = 0, startTop = 0;
    bar.addEventListener("mousedown", (e) => {
      if (e.target.closest("button")) return;
      dragging = true;
      const rect = wrap.getBoundingClientRect();
      startX = e.clientX;
      startY = e.clientY;
      startLeft = rect.left;
      startTop = rect.top;
      wrap.style.right = "auto";
      wrap.style.left = startLeft + "px";
      wrap.style.top = startTop + "px";
      document.body.style.userSelect = "none";
    });
    document.addEventListener("mousemove", (e) => {
      if (!dragging) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      wrap.style.left = Math.max(0, Math.min(window.innerWidth - 80, startLeft + dx)) + "px";
      wrap.style.top = Math.max(0, Math.min(window.innerHeight - 40, startTop + dy)) + "px";
    });
    document.addEventListener("mouseup", () => {
      if (!dragging) return;
      dragging = false;
      document.body.style.userSelect = "";
    });
  }

  // ---------- Message handler ----------
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || !msg.type) return;

    if (msg.type === "PING") {
      sendResponse({ ok: true, where: "content" });
      return;
    }

    if (msg.type === "TOGGLE_PANEL") {
      togglePanel();
      sendResponse({ ok: true });
      return;
    }

    if (msg.type === "INIT_SESSION") {
      session.skipExisting = !!msg.options?.skipExisting;
      session.processedCount = 0;
      showBadge();
      // Install patch session permanen (intercept SEMUA input.click() selama session aktif)
      installSessionPatch().then((ok) => {
        log("session patch ready:", ok);
        sendResponse({ ok: true, patch: ok });
      });
      return true; // async
    }

    if (msg.type === "END_SESSION") {
      uninstallSessionPatch().finally(() => sendResponse({ ok: true }));
      return true;
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
      version: "1.13.0",
    };
  };

  log("content script loaded v1.13.0 on", location.href);
})();
