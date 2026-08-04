# ConvertTexture Pro v2.2

Toolkit resource pack Minecraft berbasis browser dengan backend Netlify Functions untuk login, registrasi, kuota, queue, dan admin dashboard.

## Fitur

- Version Converter untuk `pack_format`, CustomModelData legacy, dan item-model 1.21.4+.
- Optimize Tools dengan preset Low/Zalith 128px, Medium 256px, dan High 512px.
- Bedrock & Geyser converter untuk icon/item 2D dan custom mappings.
- Login dan registrasi aman.
- Password di-hash menggunakan `scrypt` dan salt unik.
- Session disimpan dalam cookie HttpOnly, Secure, dan SameSite Strict.
- Plan Free: 1 proses setiap 4 hari.
- Queue monitor dan activity log seluruh user.
- Admin dashboard untuk plan, disable account, dan reset quota.
- File resource pack tetap diproses di browser; backend hanya menyimpan akun, metadata job, kuota, dan log.

## Backend Netlify

Versi ini memakai:

- `netlify/functions/api.mjs` untuk seluruh endpoint `/api/*`.
- Netlify Blobs sebagai penyimpanan server-side persisten.
- `netlify.toml` untuk publish directory, Functions, routing API, SPA fallback, dan security headers.

Tidak perlu membuat MySQL, Supabase, atau database eksternal.

## Deploy dari GitHub ke Netlify

Pastikan struktur repository memiliki file berikut:

```text
converttexture-pro/
├─ netlify.toml
├─ package.json
├─ netlify/
│  └─ functions/
│     └─ api.mjs
└─ public/
   ├─ index.html
   ├─ app.js
   ├─ tools.js
   ├─ styles.css
   ├─ _redirects
   └─ vendor/jszip.min.js
```

Pengaturan Netlify:

```text
Base directory: kosong
Build command: npm run check
Publish directory: public
Functions directory: netlify/functions
```

Setelah commit ke GitHub, buka Netlify lalu pilih **Deploys → Trigger deploy → Clear cache and deploy site**.

Tes backend setelah deploy:

```text
https://DOMAIN-KAMU.netlify.app/api/health
```

Jika benar, halaman tersebut mengembalikan JSON dengan `ok: true` dan storage `Netlify Blobs`.

## Administrator

Akun administrator dibuat otomatis ketika endpoint API pertama kali dipanggil. Kredensial awal tidak ditampilkan di website atau README. Segera ganti password melalui menu akun setelah login pertama.

Untuk mengganti username/password sebelum akun admin pertama kali dibuat, tambahkan environment variable di Netlify:

```env
ADMIN_USERNAME=nama-admin
ADMIN_PASSWORD=password-kuat
```

## Pemeriksaan source

```bash
npm install
npm run check
```

## Catatan

`server.js` tetap tersedia sebagai backend lokal/hosting Node alternatif. Ketika deploy di Netlify, backend yang digunakan adalah `netlify/functions/api.mjs` dan data tersimpan di Netlify Blobs.
