# WA Baileys REST API Gateway (Anti-Ban Notification Edition)

Implementasi WhatsApp Web API ringan menggunakan [`@whiskeysockets/baileys`](https://github.com/WhiskeySockets/Baileys) (tanpa Puppeteer/Chrome) dilengkapi **Anti-Ban Queue**, **Typing Indicator Simulation**, **Auto-Unique Message Footer**, dan **Template Notifikasi Verifikasi**.

**Produksi:** https://wa.rusabyte.co.id

## Fitur Proteksi Anti-Banned
1. **Smart Message Queue & Random Cooldown:** Jika banyak notifikasi ditembak bersamaan (misalnya *bulk approve* verifikasi), pesan otomatis masuk antrean dan dikirim satu per satu dengan jeda acak (`2000ms - 4000ms`).
2. **Simulasi Sedang Mengetik (`composing`):** Sebelum pesan dikirim, bot mengirimkan sinyal sedang mengetik selama `1000ms - 2200ms` layaknya manusia di WhatsApp Web.
3. **Auto-Unique Text Hash (Spintax + Footer Waktu Detik & Ref ID):** Mengacak variasi kalimat sapaan formal dan menyisipkan kode referensi unik + waktu hingga satuan detik di baris bawah (`_Ref ID: #A1B2C3 • 12 Okt 2026, 23:05:12_`) sehingga template yang sama tidak pernah terdeteksi sebagai duplikat spam.

## Cara Menjalankan (lokal)

```bash
cp .env.example .env
# isi API_KEY di .env
npm install
npm start
```

Dashboard: **http://localhost:3012**

---

## Autentikasi API (multi-app)

Semua endpoint `/api/*` memerlukan header:

```
X-API-Key: <API_KEY>
```

atau query `?api_key=<API_KEY>`.

Contoh dari aplikasi lain:

```bash
curl -X POST https://wa.rusabyte.co.id/api/send-message \
  -H "Content-Type: application/json" \
  -H "X-API-Key: YOUR_API_KEY" \
  -d '{"phone":"081234567890","message":"Halo dari app lain"}'
```

---

## Daftar Endpoint REST API

### 1. Kirim Notifikasi Verifikasi (`POST /api/send-verification`)

#### a) Permintaan Verifikasi Baru (`type: "request"`)
```bash
curl -X POST https://wa.rusabyte.co.id/api/send-verification \
  -H "Content-Type: application/json" \
  -H "X-API-Key: YOUR_API_KEY" \
  -d '{
    "phone": "081234567890",
    "type": "request",
    "nama": "dr. Budi Santoso",
    "nomor": "VER-2026-089",
    "jenis": "Verifikasi Hasil Laboratorium",
    "pemohon": "Andi Pratama",
    "catatan": "Pasien CITO IGD",
    "link": "https://simrs.contoh.id/verifikasi/89"
  }'
```

#### b) Hasil Verifikasi (`type: "result"`)
Status mendukung: `"disetujui"`, `"revisi"`, atau `"ditolak"`.
```bash
curl -X POST https://wa.rusabyte.co.id/api/send-verification \
  -H "Content-Type: application/json" \
  -H "X-API-Key: YOUR_API_KEY" \
  -d '{
    "phone": "081234567890",
    "type": "result",
    "nama": "Andi Pratama",
    "nomor": "VER-2026-089",
    "jenis": "Verifikasi Hasil Laboratorium",
    "status": "disetujui",
    "verifikator": "dr. Budi Santoso",
    "catatan": "Data hasil sudah sesuai dan tervalidasi."
  }'
```

### 2. Kirim Pesan Bebas (`POST /api/send-message`)
Otomatis melewati antrean aman dan ditambahkan *unique footer* (kecuali diberi `"noFooter": true`).
```bash
curl -X POST https://wa.rusabyte.co.id/api/send-message \
  -H "Content-Type: application/json" \
  -H "X-API-Key: YOUR_API_KEY" \
  -d '{
    "phone": "081234567890",
    "message": "Halo! Ini pesan dari WA Baileys Gateway."
  }'
```

### 3. Cek Status, QR Code & Antrean (`GET /api/status`)
```bash
curl https://wa.rusabyte.co.id/api/status \
  -H "X-API-Key: YOUR_API_KEY"
```

## Deploy

- App path di VPS: `/var/www/wa.rusabyte.co.id`
- PM2: `wa-baileys` (port `3012`) di belakang Apache reverse proxy
- CI/CD: push ke `main` menjalankan [`.github/workflows/deploy.yml`](.github/workflows/deploy.yml)
- Session WhatsApp (`auth_info_baileys/`) dan `.env` **tidak** di-overwrite saat deploy
