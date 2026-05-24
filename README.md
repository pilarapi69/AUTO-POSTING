# Auto Posting · Meta Business Suite

Chrome extension untuk otomasi penjadwalan postingan massal di halaman **Jadwalkan postingan massal** Meta Business Suite. Pilih folder media + file caption `.txt`, klik START, biarkan extension mengisi tiap baris postingan. Tombol **Terbitkan** tetap diklik manual oleh Anda.

> Bahasa antarmuka: Indonesia. Selector menggunakan teks Bahasa Indonesia sesuai UI Meta Business Suite (`Tambahkan postingan`, `Tambahkan foto/video`, `Tulis sesuatu…`, `Terbitkan s…`, `Jadwalkan`, `Perbarui`).

## Fitur

- Pilih folder media (foto/video) dari komputer.
- Pilih file caption `.txt` (caption per post dipisahkan baris `---`).
- Pengaturan waktu jadwal mulai + interval (menit) — waktu tiap post dihitung otomatis.
- Subfolder = satu post dengan multi-media. File top-level = satu post per file.
- Preview lengkap pasangan media ↔ caption ↔ waktu sebelum START.
- Progress bar + log realtime di panel kontrol.
- Badge floating "Auto Posting · Active" di halaman target.
- Tombol **Terbitkan** tetap manual (sesuai permintaan: default klik manual).

## Instalasi (Load Unpacked)

1. Buka Chrome → `chrome://extensions`.
2. Aktifkan **Developer mode** (kanan atas).
3. Klik **Load unpacked**.
4. Pilih folder `AUTO-POSTING` (folder ini).
5. Icon Auto Posting akan muncul di toolbar.

## Cara Pakai

1. Buka **Meta Business Suite** → halaman **Jadwalkan postingan massal** (bulk composer).
2. Klik icon Auto Posting → muncul panel kontrol.
3. **Step 1 — Tab**: pilih tab Meta Business Suite (default otomatis terpilih).
4. **Step 2 — Folder Media**: klik **Pilih Folder**.
   - File langsung di dalam folder → satu post per file.
   - Subfolder di dalam folder → satu post per subfolder dengan semua media di dalamnya.
   - Urutan: alfabet natural (`01.jpg`, `02.jpg`, `10.jpg`).
5. **Step 3 — File Caption**: klik **Pilih File TXT**. Format:
   ```
   Caption postingan pertama.
   Bisa multi-baris.
   ---
   Caption postingan kedua.
   ---
   Caption ketiga.
   ```
   Pemisah `---` di baris tersendiri. Jika tidak ada `---`, baris kosong ganda juga diterima; jika tidak ada keduanya, tiap baris = satu caption.
6. **Step 4 — Jadwal**: atur **Mulai dari** dan **Interval (menit)**. Default: 30 menit dari sekarang, interval 60 menit.
7. **Step 5 — Preview**: cek pasangan media ↔ caption ↔ waktu.
8. Klik **START**. Extension akan:
   1. Klik **Tambahkan postingan** (untuk post #2 ke atas).
   2. Upload media otomatis.
   3. Isi teks otomatis.
   4. Klik dropdown **Terbitkan s…** → pilih **Jadwalkan**.
   5. Set tanggal + waktu.
   6. Klik **Perbarui**.
9. Setelah selesai, **periksa hasil** lalu klik tombol **Terbitkan** di pojok kanan bawah secara manual.

## Catatan

- Selector menggunakan teks UI (Bahasa Indonesia). Pastikan bahasa Meta Business Suite Anda diatur ke Bahasa Indonesia agar selector cocok.
- Jika UI Meta berubah, lihat console (`Inspect` → tab `Console`) untuk pesan `[AutoPosting] ...`.
- Tombol **STOP** menghentikan loop setelah job yang sedang berjalan selesai.
- Extension TIDAK pernah mengklik tombol **Terbitkan** global — itu adalah aksi final yang harus dikonfirmasi user.

## Struktur File

```
AUTO-POSTING/
├── manifest.json        # Manifest V3
├── background.js        # Service worker: buka panel kontrol, relay
├── control.html/.css/.js# Panel kontrol (window terpisah)
├── content.js/.css      # Automation script di halaman business.facebook.com
├── icons/               # Icon 16/48/128 px
└── README.md
```

## Troubleshooting

| Gejala | Penyebab umum | Solusi |
|--------|---------------|--------|
| "Tidak ada tab business.facebook.com" | Belum buka Meta Business Suite | Buka halaman bulk composer dulu, klik refresh tab di panel. |
| "Tombol Tambahkan postingan tidak ditemukan" | Bahasa UI bukan Indonesia / halaman belum siap | Reload halaman dan tunggu sampai siap. Pastikan bahasa = Indonesia. |
| Media tidak ter-upload | Format tidak didukung Meta | Cek ekstensi file. Meta umumnya menerima JPG/PNG/MP4/MOV. |
| Tanggal tidak terisi | Field tanggal pakai format berbeda | Lihat log di console. File `content.js` (`setScheduleDateTime`) mencoba beberapa format; sesuaikan jika perlu. |

## Lisensi

MIT
