// inject.js — runs at document_start in MAIN world.
// Tujuan: install patch HTMLInputElement.prototype.click SEBELUM Facebook bisa
// override DataTransfer/Blob/File. Patch tetap inactive (active=false) sampai
// content script kirim sinyal aktif.

(() => {
  if (window.__autoPostingPatched) return;

  const origClick = HTMLInputElement.prototype.click;
  // Save reference ke konstruktor native sebelum FB sempat tamper
  const NativeDataTransfer = window.DataTransfer;
  const NativeBlob = window.Blob;
  const NativeFile = window.File;
  const NativeEvent = window.Event;
  const NativeUint8Array = window.Uint8Array;
  const NativeAtob = window.atob;
  const NativeDataTransferItemListAdd = window.DataTransferItemList?.prototype?.add;

  window.__autoPostingState = {
    active: false,
    nextFiles: null,
    consumed: false,
    lastError: null,
  };
  window.__autoPostingOrigClick = origClick;

  function b64ToBytes(b64) {
    const bin = NativeAtob.call(window, b64);
    const len = bin.length;
    const bytes = new NativeUint8Array(len);
    for (let i = 0; i < len; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  }

  function buildFiles(specs) {
    const dt = new NativeDataTransfer();
    console.log("[AutoPosting:patch] buildFiles START, specs.length=", specs?.length);
    for (let idx = 0; idx < specs.length; idx++) {
      const s = specs[idx];
      try {
        console.log(`[AutoPosting:patch]   spec[${idx}]: name=${s?.name} type=${s?.type} b64.length=${s?.b64?.length || 0}`);
        const bytes = b64ToBytes(s.b64);
        console.log(`[AutoPosting:patch]   spec[${idx}] bytes.length=${bytes.length}`);
        const blob = new NativeBlob([bytes], { type: s.type || "application/octet-stream" });
        console.log(`[AutoPosting:patch]   spec[${idx}] blob.size=${blob.size} blob.type=${blob.type}`);
        const file = new NativeFile([blob], s.name, {
          type: blob.type,
          lastModified: s.lastModified || Date.now(),
        });
        console.log(`[AutoPosting:patch]   spec[${idx}] file.size=${file.size} file.type=${file.type} file.name=${file.name}`);
        // Pakai native add reference jika ada (hindari FB override)
        let itemResult;
        if (NativeDataTransferItemListAdd) {
          itemResult = NativeDataTransferItemListAdd.call(dt.items, file);
        } else {
          itemResult = dt.items.add(file);
        }
        console.log(`[AutoPosting:patch]   spec[${idx}] dt.items.add ->`, itemResult ? "OK" : "NULL/FAILED");
        console.log(`[AutoPosting:patch]   spec[${idx}] dt.files.length after add=${dt.files.length}`);
      } catch (e) {
        console.error(`[AutoPosting:patch]   spec[${idx}] ERROR:`, e);
      }
    }
    console.log("[AutoPosting:patch] buildFiles END, dt.files.length=", dt.files.length);
    return dt;
  }

  function setFilesOn(input, specs) {
    try {
      console.log("[AutoPosting:patch] setFilesOn input:", input.tagName, "type=", input.type, "accept=", input.accept, "name=", input.name);
      const dt = buildFiles(specs);
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "files")?.set;
      if (setter) setter.call(input, dt.files);
      else input.files = dt.files;
      console.log("[AutoPosting:patch] after setter, input.files.length=", input.files?.length);
      input.dispatchEvent(new NativeEvent("change", { bubbles: true }));
      input.dispatchEvent(new NativeEvent("input", { bubbles: true }));
      const fileMeta = [];
      for (let i = 0; i < dt.files.length; i++) {
        const f = dt.files[i];
        fileMeta.push({ name: f.name, size: f.size, type: f.type });
      }
      console.log("[AutoPosting:patch] files set:", fileMeta);
      return { ok: true, count: dt.files.length, files: fileMeta };
    } catch (e) {
      console.error("[AutoPosting:patch] setFilesOn ERROR:", e);
      return { ok: false, error: String(e) };
    }
  }

  HTMLInputElement.prototype.click = function () {
    const st = window.__autoPostingState;
    if (st && st.active && this.type === "file") {
      if (st.nextFiles && st.nextFiles.length) {
        console.log("[AutoPosting:patch] click intercept: nextFiles.length=", st.nextFiles.length);
        const res = setFilesOn(this, st.nextFiles);
        console.log("[AutoPosting:patch] intercepted input.click()", res, { name: this.name, accept: this.accept });
        st.nextFiles = null;
        st.consumed = true;
        if (!res.ok) st.lastError = res.error;
        return;
      }
      console.log("[AutoPosting:patch] suppressed input.click() (no queued files)", { name: this.name });
      return;
    }
    return window.__autoPostingOrigClick.call(this);
  };

  // Expose helper untuk UPLOAD_V2 (dipanggil dari executeScript)
  window.__autoPostingActivate = function () {
    window.__autoPostingState.active = true;
    return { ok: true, alreadyInstalled: true };
  };
  window.__autoPostingDeactivate = function () {
    if (window.__autoPostingState) window.__autoPostingState.active = false;
    return { ok: true };
  };
  window.__autoPostingSetNextFiles = function (specs) {
    window.__autoPostingState.active = true;
    window.__autoPostingState.nextFiles = specs;
    window.__autoPostingState.consumed = false;
    window.__autoPostingState.lastError = null;
  };
  window.__autoPostingGetState = function () {
    const st = window.__autoPostingState;
    return {
      active: st.active,
      consumed: st.consumed,
      nextFilesLength: st.nextFiles ? st.nextFiles.length : 0,
      lastError: st.lastError,
    };
  };

  window.__autoPostingPatched = true;
  console.log("[AutoPosting:patch] INSTALLED at document_start. Native ctors saved:",
    "DataTransfer=", typeof NativeDataTransfer,
    "Blob=", typeof NativeBlob,
    "File=", typeof NativeFile,
    "DataTransferItemList.add=", typeof NativeDataTransferItemListAdd);
})();
