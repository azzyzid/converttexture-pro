# Security

- Password tidak disimpan dalam bentuk plaintext.
- Password di-hash menggunakan Node.js `scrypt` dengan salt unik.
- Session ditandatangani menggunakan secret acak yang dibuat dan disimpan server-side.
- Cookie session memakai `HttpOnly`, `Secure`, dan `SameSite=Strict`.
- Endpoint write memeriksa origin yang sama.
- Login, registrasi, perubahan password, pembuatan job, dan update job memiliki rate limit.
- Source function berada di luar publish directory sehingga tidak dapat diunduh sebagai file statis.
- File resource pack diproses pada browser dan tidak dikirim ke backend.

Ganti password administrator segera setelah login pertama.
