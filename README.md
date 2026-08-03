# ConvertTexture Pro

Website full-stack untuk mengelola resource pack Minecraft Java dan Bedrock dengan tampilan dashboard gelap seperti referensi yang diberikan.

## Fitur utama

### 1. Version Converter

- Mengubah `pack_format` sesuai versi target.
- Legacy CustomModelData → item-model `range_dispatch` untuk format 46 / Minecraft 1.21.4.
- Item-model `range_dispatch` → override CustomModelData untuk versi lama.
- Mempertahankan model, texture, font, glyph, dan namespace asli.
- Membuat laporan path yang berpotensi bermasalah.

Versi target bawaan:

- Minecraft 1.21.4 — Format 46
- Minecraft 1.21.2–1.21.3 — Format 42
- Minecraft 1.21–1.21.1 — Format 34
- Minecraft 1.20.5–1.20.6 — Format 32
- Minecraft 1.20.3–1.20.4 — Format 22
- Minecraft 1.20.2 — Format 18
- Minecraft 1.20–1.20.1 — Format 15

### 2. Optimize Tools

Preset performa siap pakai:

- **Low / Potato / Zalith** — batas texture 128px, palette agresif, shader dibuang; ditujukan untuk RAM/GPU rendah.
- **Medium / Balanced** — batas texture 256px dan kompresi seimbang untuk mayoritas HP.
- **High Quality** — batas texture 512px dengan pengurangan warna ringan.

Fitur engine:

- Menghapus file sampah seperti `.DS_Store`, `Thumbs.db`, dan `__MACOSX`.
- Minify JSON dan `.mcmeta`.
- Menghapus custom shaders secara opsional.
- Menghapus file kerja/editor seperti PSD, XCF, KRA, BLEND, Aseprite, backup, dan folder Git.
- Konsolidasi PNG identik serta memperbarui referensi JSON.
- Safe unused-texture scan untuk texture item/block custom.
- Power-of-two padding.
- Downscale texture berukuran terlalu besar.
- Palette reduction dan browser PNG re-encode.
- File asli dipertahankan apabila hasil re-encode lebih besar.
- Font, glyph, GUI, atlas, colormap, dan texture animasi dilindungi dari scaling otomatis.
- Texture entity/item/block tetap dapat di-downscale untuk menurunkan penggunaan VRAM pada perangkat lemah.
- Pipeline memberi jeda antar-batch agar browser mobile tidak mudah freeze saat memproses pack besar.

### 3. Bedrock & Geyser Converter

- Membaca override CustomModelData legacy.
- Membaca item-model sederhana 1.21.4+.
- Menghasilkan Bedrock `.mcpack` dengan manifest dan `item_texture.json`.
- Menghasilkan Geyser custom item mappings format v2.
- Output berupa satu ZIP berisi:
  - Pack `.mcpack`
  - Folder `custom_mappings/`
  - `conversion-report.json`
  - Petunjuk pemasangan

Konversi terbaik untuk icon item 2D dan model Java `generated`/`handheld`. Geometry 3D, CIT/OptiFine, shader, display entity, entity model, dan custom font Bedrock biasanya masih memerlukan penyesuaian manual.

### 4. Login, quota, queue, dan admin

- Login dan registrasi user.
- Password di-hash memakai `scrypt`.
- Session menggunakan cookie HttpOnly + SameSite Strict.
- Plan Free: maksimal 1 proses setiap 4 hari.
- Plan Pro dan Admin: unlimited.
- Queue monitor dengan progress dan log tiap pekerjaan.
- Admin dapat melihat semua pekerjaan dan aktivitas user.
- Admin dapat mengubah plan, menonaktifkan akun, dan reset quota.
- Tombol upgrade diarahkan ke WhatsApp admin `083830287126`.
- File ZIP tidak di-upload ke server; pemrosesan dilakukan di browser. Server hanya menerima metadata pekerjaan dan log.

## Menjalankan secara lokal

Syarat: Node.js 20 atau lebih baru.

```bash
npm start
```

Buka:

```text
http://localhost:3000
```

Proyek ini tidak memakai dependency npm eksternal, sehingga tidak perlu menjalankan `npm install`.

## Deployment

Versi ini membutuhkan server Node dan penyimpanan persisten untuk akun, quota, queue, serta log. Karena itu, jangan deploy sebagai website statis Netlify biasa.

Pilihan deployment:

- Render dengan `render.yaml`
- Railway
- VPS / Pterodactyl Node.js egg
- Docker menggunakan `Dockerfile`

Environment production yang wajib:

```env
NODE_ENV=production
SESSION_SECRET=random-string-yang-sangat-panjang
DATA_FILE=./data/db.json
```

Opsional ketika database masih kosong:

```env
ADMIN_USERNAME=admin-baru
ADMIN_PASSWORD=password-baru-yang-kuat
```

Folder `data/` harus dipasang pada persistent disk/volume. Jika tidak, akun dan log dapat hilang setelah redeploy atau restart container.

## Keamanan admin

Username/password admin default tidak ditampilkan pada halaman website maupun dikirim ke browser. Backend hanya menyimpan hash password. Segera gunakan menu **Ganti password** setelah login pertama.

## Menjalankan pemeriksaan syntax

```bash
npm run check
```

## Struktur

```text
converttexture-pro/
├─ public/
│  ├─ index.html
│  ├─ styles.css
│  ├─ app.js
│  ├─ tools.js
│  ├─ favicon.svg
│  └─ vendor/jszip.min.js
├─ data/
├─ server.js
├─ package.json
├─ Dockerfile
├─ render.yaml
└─ .env.example
```

## Catatan produksi

Penyimpanan JSON bawaan cocok untuk satu instance dan komunitas kecil. Untuk trafik besar atau banyak instance, pindahkan users/jobs/activity ke PostgreSQL atau database terkelola.
