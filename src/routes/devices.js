import { Router } from 'express';
import crypto from 'crypto';
import { requireAuth } from '../auth.js';
import {
  listDevices,
  findDeviceById,
  createDevice,
  updateDevice,
  deleteDevice,
} from '../db.js';
import { deviceManager } from '../device-manager.js';
import {
  generateApiKey,
  formatJid,
  makeMessageUnique,
  ensureClickableUrl,
  buildVerificationMessage,
} from '../helpers.js';

const router = Router();

router.use(requireAuth);

function canAccessDevice(user, device) {
  if (!device) return false;
  if (user.role === 'super_admin') return true;
  return device.owner_user_id === user.id;
}

function maskKey(apiKey) {
  if (!apiKey || apiKey.length < 12) return '••••';
  return `${apiKey.slice(0, 6)}…${apiKey.slice(-4)}`;
}

function serializeDevice(
  device,
  { revealKey = false, revealWebhookSecret = false, runtime = null } = {}
) {
  const status = runtime || deviceManager.getStatus(device.id);
  return {
    id: device.id,
    name: device.name,
    ownerUserId: device.owner_user_id,
    ownerEmail: device.owner_email,
    ownerName: device.owner_name,
    phone: status.user?.phone || device.phone || null,
    status: status.status || device.status,
    apiKeyMasked: maskKey(device.api_key),
    apiKey: revealKey ? device.api_key : undefined,
    webhookUrl: device.webhook_url || null,
    webhookSecretMasked: device.webhook_secret
      ? maskKey(device.webhook_secret)
      : null,
    webhookSecret: revealWebhookSecret ? device.webhook_secret || null : undefined,
    qr: status.qr || null,
    user: status.user || null,
    queue: status.queue || null,
    createdAt: device.created_at,
  };
}

router.get('/', (req, res) => {
  const all = req.user.role === 'super_admin';
  const devices = listDevices({
    ownerUserId: req.user.id,
    all,
  });
  res.json({
    success: true,
    devices: devices.map((d) => serializeDevice(d)),
  });
});

router.post('/', (req, res) => {
  const name = String(req.body?.name || '').trim() || 'WhatsApp Device';
  const id = crypto.randomUUID();
  const apiKey = generateApiKey();
  const device = createDevice({
    id,
    name,
    ownerUserId: req.user.id,
    apiKey,
  });
  deviceManager.start(id);
  res.status(201).json({
    success: true,
    message: 'Device dibuat. Simpan API key — hanya ditampilkan sekali.',
    device: serializeDevice(device, { revealKey: true }),
  });
});

router.get('/:id', (req, res) => {
  const device = findDeviceById(req.params.id);
  if (!canAccessDevice(req.user, device)) {
    return res.status(404).json({ success: false, message: 'Device tidak ditemukan' });
  }
  const full = listDevices({ all: true }).find((d) => d.id === device.id) || device;
  return res.json({
    success: true,
    device: serializeDevice(full),
  });
});

router.get('/:id/status', (req, res) => {
  const device = findDeviceById(req.params.id);
  if (!canAccessDevice(req.user, device)) {
    return res.status(404).json({ success: false, message: 'Device tidak ditemukan' });
  }
  const status = deviceManager.getStatus(device.id);
  return res.json({
    success: true,
    ...status,
    uptimeSeconds: Math.floor(process.uptime()),
    timestamp: new Date().toISOString(),
  });
});

router.get('/:id/messages', (req, res) => {
  const device = findDeviceById(req.params.id);
  if (!canAccessDevice(req.user, device)) {
    return res.status(404).json({ success: false, message: 'Device tidak ditemukan' });
  }
  const status = deviceManager.getStatus(device.id);
  return res.json({ success: true, messages: status.messages });
});

router.patch('/:id', (req, res) => {
  const device = findDeviceById(req.params.id);
  if (!canAccessDevice(req.user, device)) {
    return res.status(404).json({ success: false, message: 'Device tidak ditemukan' });
  }
  const fields = {};
  if (req.body?.name !== undefined) {
    const name = String(req.body.name || '').trim();
    if (!name) {
      return res.status(400).json({ success: false, message: 'Nama wajib diisi' });
    }
    fields.name = name;
  }
  if (req.body?.webhookUrl !== undefined || req.body?.webhook_url !== undefined) {
    const raw = req.body.webhookUrl ?? req.body.webhook_url;
    fields.webhook_url =
      raw === null || raw === '' ? null : String(raw).trim();
  }
  let revealWebhookSecret = false;
  if (
    req.body?.webhookSecret !== undefined ||
    req.body?.webhook_secret !== undefined
  ) {
    const raw = req.body.webhookSecret ?? req.body.webhook_secret;
    fields.webhook_secret =
      raw === null || raw === '' ? null : String(raw).trim();
    revealWebhookSecret = Boolean(fields.webhook_secret);
  }
  if (!Object.keys(fields).length) {
    return res.status(400).json({
      success: false,
      message: 'Tidak ada field yang diubah (name, webhookUrl, webhookSecret).',
    });
  }
  const updated = updateDevice(device.id, fields);
  return res.json({
    success: true,
    device: serializeDevice(updated, { revealWebhookSecret }),
  });
});

router.post('/:id/reveal-key', (req, res) => {
  const device = findDeviceById(req.params.id);
  if (!canAccessDevice(req.user, device)) {
    return res.status(404).json({ success: false, message: 'Device tidak ditemukan' });
  }
  return res.json({
    success: true,
    device: serializeDevice(device, { revealKey: true }),
  });
});

router.post('/:id/regenerate-key', (req, res) => {
  const device = findDeviceById(req.params.id);
  if (!canAccessDevice(req.user, device)) {
    return res.status(404).json({ success: false, message: 'Device tidak ditemukan' });
  }
  const apiKey = generateApiKey();
  const updated = updateDevice(device.id, { api_key: apiKey });
  return res.json({
    success: true,
    message: 'API key baru digenerate. Simpan sekarang.',
    device: serializeDevice(updated, { revealKey: true }),
  });
});

router.post('/:id/logout', async (req, res) => {
  const device = findDeviceById(req.params.id);
  if (!canAccessDevice(req.user, device)) {
    return res.status(404).json({ success: false, message: 'Device tidak ditemukan' });
  }
  await deviceManager.logout(device.id);
  return res.json({
    success: true,
    message: 'Sesi WhatsApp direset. QR baru sedang dibuat.',
  });
});

router.post('/:id/send-message', async (req, res) => {
  const device = findDeviceById(req.params.id);
  if (!canAccessDevice(req.user, device)) {
    return res.status(404).json({ success: false, message: 'Device tidak ditemukan' });
  }
  try {
    const rawTarget = req.body.phone || req.body.number || req.body.to;
    const textContent = req.body.message || req.body.text;
    if (!rawTarget || !textContent) {
      return res.status(400).json({
        success: false,
        message: 'phone dan message wajib diisi',
      });
    }
    const status = deviceManager.getStatus(device.id);
    if (status.status !== 'connected' && status.status !== 'connecting') {
      return res.status(503).json({
        success: false,
        message: `WhatsApp belum terhubung (status: ${status.status})`,
      });
    }
    const buttonUrl = ensureClickableUrl(
      req.body.buttonUrl || req.body.url || req.body.link || ''
    );
    const result = await deviceManager.enqueueMessage(device.id, {
      jid: formatJid(rawTarget),
      text: buttonUrl
        ? String(textContent).trim()
        : makeMessageUnique(textContent, Boolean(req.body.noFooter)),
      buttonUrl,
      buttonText: req.body.buttonText || 'Buka Aplikasi PPRA',
      footerText: req.body.footer || 'Sehatlink - PPRA',
      waitForSend: true,
    });
    return res.json({ success: true, message: 'Pesan terkirim', data: result });
  } catch (err) {
    return res.status(500).json({
      success: false,
      message: err.message || 'Gagal mengirim',
    });
  }
});

router.post('/:id/send-verification', async (req, res) => {
  const device = findDeviceById(req.params.id);
  if (!canAccessDevice(req.user, device)) {
    return res.status(404).json({ success: false, message: 'Device tidak ditemukan' });
  }
  try {
    const rawTarget = req.body.phone || req.body.number || req.body.to;
    if (!rawTarget) {
      return res.status(400).json({
        success: false,
        message: 'phone wajib diisi',
      });
    }
    const status = deviceManager.getStatus(device.id);
    if (status.status !== 'connected' && status.status !== 'connecting') {
      return res.status(503).json({
        success: false,
        message: `WhatsApp belum terhubung (status: ${status.status})`,
      });
    }
    const formattedText = buildVerificationMessage(req.body);
    const buttonUrl = ensureClickableUrl(
      req.body.buttonUrl || req.body.url || req.body.link || ''
    );
    const result = await deviceManager.enqueueMessage(device.id, {
      jid: formatJid(rawTarget),
      text: formattedText,
      label: 'Notif Verifikasi',
      buttonUrl,
      buttonText: req.body.buttonText || 'Buka Aplikasi PPRA',
      footerText: req.body.footer || 'Sehatlink - PPRA',
      waitForSend: true,
    });
    return res.json({
      success: true,
      message: 'Notifikasi terkirim',
      data: { ...result, previewText: formattedText },
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      message: err.message || 'Gagal mengirim',
    });
  }
});

router.delete('/:id', async (req, res) => {
  const device = findDeviceById(req.params.id);
  if (!canAccessDevice(req.user, device)) {
    return res.status(404).json({ success: false, message: 'Device tidak ditemukan' });
  }
  await deviceManager.remove(device.id);
  deleteDevice(device.id);
  return res.json({ success: true, message: 'Device dihapus' });
});

export default router;
