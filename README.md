# WA Baileys REST API Gateway (Multi-Device)

WhatsApp Web API gateway berbasis [`@whiskeysockets/baileys`](https://github.com/WhiskeySockets/Baileys) dengan:

- **User hierarchy:** bootstrap Super Admin → pendaftaran ditutup → Super Admin menambah Admin
- **Multi-device:** tiap nomor WA = 1 device + 1 API key
- **Anti-ban queue** per device (typing delay + cooldown + unique footer)

**Produksi:** https://wa.rusabyte.co.id

## Bootstrap pertama

1. Buka dashboard → form **Daftar Super Admin** (hanya muncul jika belum ada user)
2. Setelah daftar, pendaftaran publik **ditutup**
3. Login → **Tambah Device** → scan QR
4. Salin **API key** device (ditampilkan sekali) untuk aplikasi eksternal
5. (Opsional) Super Admin → tab **Users** → buat Admin; tiap admin mengelola device miliknya. Super Admin melihat semua device.

## Autentikasi API eksternal

Gunakan **API key per device** (bukan key global):

```bash
curl -X POST https://wa.rusabyte.co.id/api/send-message \
  -H "Content-Type: application/json" \
  -H "X-API-Key: DEVICE_API_KEY" \
  -d '{"phone":"081234567890","message":"Halo dari app lain"}'
```

Endpoint yang sama (semua butuh `X-API-Key` device):

- `GET /api/status` — status + QR device
- `GET /api/messages`
- `POST /api/send-message`
- `POST /api/send-verification`
- `POST /api/check-number`
- `POST /api/logout`

### Inbound webhook

Saat pesan masuk (bukan `fromMe`), gateway POST JSON ke:

1. `devices.webhook_url` (per device, set via `PATCH /api/devices/:id` body `{ "webhookUrl": "..." }`), atau
2. env `WEBHOOK_URL` global

Header opsional: `X-Baiwa-Device-Webhook-Secret: $WEBHOOK_SECRET`

Payload:

```json
{
  "deviceId": "<uuid>",
  "id": "<wa-message-id>",
  "from": "62812...",
  "jid": "62812...@s.whatsapp.net",
  "pushName": "...",
  "message": "teks",
  "timestamp": 1710000000
}
```

## Menjalankan lokal

```bash
cp .env.example .env
# isi SESSION_SECRET
npm install
npm start
```

Dashboard: http://localhost:3012

Data tersimpan di `data/app.db`. Session Baileys per device di `auth_info/devices/<id>/`.

## Deploy

- Path VPS: `/var/www/wa.rusabyte.co.id`
- PM2: `wa-baileys` (port `3012`)
- Pastikan folder `data/` dan `auth_info/` **tidak dihapus** saat deploy
