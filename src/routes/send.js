import { Router } from 'express';
import { findDeviceByApiKey } from '../db.js';
import { deviceManager } from '../device-manager.js';
import {
  formatJid,
  makeMessageUnique,
  ensureClickableUrl,
  buildVerificationMessage,
} from '../helpers.js';

const router = Router();

export function requireDeviceApiKey(req, res, next) {
  const providedKey =
    req.headers['x-api-key'] || req.query.api_key || req.body?.api_key;
  if (!providedKey) {
    return res.status(401).json({
      success: false,
      message: 'Unauthorized: X-API-Key (per device) wajib',
    });
  }
  const device = findDeviceByApiKey(String(providedKey));
  if (!device) {
    return res.status(401).json({
      success: false,
      message: 'Unauthorized: API Key tidak valid',
    });
  }
  req.device = device;
  next();
}

router.use(requireDeviceApiKey);

router.get('/status', (req, res) => {
  const status = deviceManager.getStatus(req.device.id);
  res.json({
    success: true,
    deviceId: req.device.id,
    deviceName: req.device.name,
    status: status.status,
    user: status.user,
    qr: status.qr,
    uptimeSeconds: Math.floor(process.uptime()),
    queue: status.queue,
    timestamp: new Date().toISOString(),
  });
});

router.get('/messages', (req, res) => {
  const status = deviceManager.getStatus(req.device.id);
  res.json({
    success: true,
    deviceId: req.device.id,
    messages: status.messages,
  });
});

router.post('/send-message', async (req, res) => {
  try {
    const rawTarget = req.body.phone || req.body.number || req.body.to;
    const textContent = req.body.message || req.body.text;
    if (!rawTarget || !textContent) {
      return res.status(400).json({
        success: false,
        message: 'Parameter "phone" (atau "number") dan "message" wajib diisi.',
      });
    }

    const rt = deviceManager.getStatus(req.device.id);
    if (rt.status !== 'connected' && rt.status !== 'connecting') {
      return res.status(503).json({
        success: false,
        message: `WhatsApp belum terhubung (status: ${rt.status}).`,
      });
    }

    const jid = formatJid(rawTarget);
    const buttonUrl = ensureClickableUrl(
      req.body.buttonUrl || req.body.url || req.body.link || ''
    );
    const buttonText = req.body.buttonText || 'Buka Aplikasi PPRA';
    const footerText = req.body.footer || 'Sehatlink - PPRA';
    const finalMessage = buttonUrl
      ? String(textContent).trim()
      : makeMessageUnique(textContent, Boolean(req.body.noFooter));
    const shouldRunAsync =
      Boolean(req.body.async) || rt.queue.pending >= 2;

    const result = await deviceManager.enqueueMessage(req.device.id, {
      jid,
      text: finalMessage,
      label: 'API Outgoing',
      buttonUrl,
      buttonText,
      footerText,
      waitForSend: !shouldRunAsync,
    });

    return res.status(shouldRunAsync ? 202 : 200).json({
      success: true,
      message: shouldRunAsync
        ? `Pesan dimasukkan ke antrean aman (posisi ke-${result.queuePosition})`
        : 'Pesan berhasil dikirim dengan proteksi Anti-Ban',
      data: result,
    });
  } catch (error) {
    console.error('[Send Message Error]', error);
    return res.status(500).json({
      success: false,
      message: 'Gagal mengirim pesan',
      error: error.message,
    });
  }
});

router.post('/send-verification', async (req, res) => {
  try {
    const rawTarget = req.body.phone || req.body.number || req.body.to;
    if (!rawTarget) {
      return res.status(400).json({
        success: false,
        message: 'Parameter "phone" (nomor WhatsApp tujuan) wajib diisi.',
      });
    }

    const rt = deviceManager.getStatus(req.device.id);
    if (rt.status !== 'connected' && rt.status !== 'connecting') {
      return res.status(503).json({
        success: false,
        message: `WhatsApp belum terhubung (status: ${rt.status}).`,
      });
    }

    const jid = formatJid(rawTarget);
    const formattedText = buildVerificationMessage(req.body);
    const rawType = String(req.body.type || 'request').toLowerCase();
    const notifType =
      rawType === 'result' || rawType === 'hasil'
        ? 'Notif Hasil Verifikasi'
        : rawType === 'reminder' || rawType === 'pengingat' || rawType === 'sla'
          ? 'Pengingat Verifikasi 2 Jam'
          : 'Notif Pengajuan Antibiotik';

    const buttonUrl = ensureClickableUrl(
      req.body.buttonUrl || req.body.url || req.body.link || ''
    );
    const defaultBtnText =
      rawType === 'result' || rawType === 'hasil'
        ? 'Lihat Hasil Verifikasi'
        : rawType === 'reminder' || rawType === 'pengingat' || rawType === 'sla'
          ? 'Verifikasi Sekarang'
          : 'Buka Aplikasi PPRA';
    const buttonText = req.body.buttonText || defaultBtnText;
    const footerText = req.body.footer || 'Sehatlink - PPRA';
    const shouldRunAsync =
      Boolean(req.body.async) || rt.queue.pending >= 2;

    const result = await deviceManager.enqueueMessage(req.device.id, {
      jid,
      text: formattedText,
      label: notifType,
      buttonUrl,
      buttonText,
      footerText,
      waitForSend: !shouldRunAsync,
    });

    return res.status(shouldRunAsync ? 202 : 200).json({
      success: true,
      message: shouldRunAsync
        ? `${notifType} masuk antrean (posisi ke-${result.queuePosition})`
        : `${notifType} berhasil dikirim`,
      data: { ...result, previewText: formattedText },
    });
  } catch (error) {
    console.error('[Send Verification Error]', error);
    return res.status(500).json({
      success: false,
      message: 'Gagal mengirim notifikasi verifikasi',
      error: error.message,
    });
  }
});

router.post('/check-number', async (req, res) => {
  try {
    const rawTarget = req.body.phone || req.body.number;
    if (!rawTarget) {
      return res.status(400).json({
        success: false,
        message: 'Parameter "phone" wajib diisi.',
      });
    }
    const rt = deviceManager.getRuntime(req.device.id);
    if (rt.status !== 'connected' || !rt.sock) {
      return res.status(503).json({
        success: false,
        message: 'WhatsApp belum terhubung.',
      });
    }
    const jid = formatJid(rawTarget);
    const [result] = await rt.sock.onWhatsApp(jid);
    return res.json({
      success: true,
      exists: Boolean(result?.exists),
      jid: result?.jid || jid,
      deviceId: req.device.id,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: 'Gagal memeriksa nomor',
      error: error.message,
    });
  }
});

router.post('/logout', async (req, res) => {
  try {
    await deviceManager.logout(req.device.id);
    return res.json({
      success: true,
      message: 'Sesi berhasil direset. QR Code baru sedang dibuat.',
      deviceId: req.device.id,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: 'Gagal logout sesi',
      error: error.message,
    });
  }
});

export default router;
