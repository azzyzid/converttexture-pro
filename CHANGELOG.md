# Changelog

## 2.2.0 — Netlify authentication fix

- Memperbaiki error registrasi `Request failed (404)` di Netlify.
- Menambahkan backend Netlify Functions untuk seluruh endpoint `/api/*`.
- Menambahkan penyimpanan persisten server-side dengan Netlify Blobs.
- Admin dibuat otomatis pada request API pertama.
- Password memakai salted `scrypt` hash.
- Session memakai cookie HttpOnly, Secure, dan SameSite Strict.
- Menambahkan rate limit login, registrasi, password, dan update job.
- Menambahkan routing API dan SPA fallback melalui `netlify.toml` dan `_redirects`.
- Login, registrasi, quota, queue, activity log, dan admin management kini berfungsi di Netlify.

## 2.1.0 — Resource-pack optimizer presets

- Menambahkan preset Low/Zalith, Medium, dan High.
- Menambahkan downscale, palette reduction, file cleanup, dan proteksi font/glyph/GUI.
