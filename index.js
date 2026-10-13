import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  Browsers,
  proto,
  generateWAMessageFromContent,
  normalizeMessageContent,
  isJidGroup,
  generateMessageIDV2,
} from '@whiskeysockets/baileys';
import express from 'express';
import pino from 'pino';
import qrcode from 'qrcode';
import qrcodeTerminal from 'qrcode-terminal';
import dotenv from 'dotenv';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.PORT || 3001;
const API_KEY = process.env.API_KEY || '';
const WEBHOOK_URL = process.env.WEBHOOK_URL || '';
const AUTO_REPLY_PING = process.env.AUTO_REPLY_PING !== 'false';
const AUTO_UNIQUE_FOOTER = process.env.AUTO_UNIQUE_FOOTER !== 'false';
const TYPING_DELAY_MIN_MS = Number(process.env.TYPING_DELAY_MIN_MS) || 1000;
const TYPING_DELAY_MAX_MS = Number(process.env.TYPING_DELAY_MAX_MS) || 2200;
const QUEUE_COOLDOWN_MIN_MS = Number(process.env.QUEUE_COOLDOWN_MIN_MS) || 2000;
const QUEUE_COOLDOWN_MAX_MS = Number(process.env.QUEUE_COOLDOWN_MAX_MS) || 4000;

const AUTH_DIR = path.join(__dirname, 'auth_info_baileys');

// Cegah proses Node.js mati jika terjadi error jaringan sesaat (ECONNRESET / ETIMEDOUT)
process.on('uncaughtException', (err) => {
  console.error('[Guard] Uncaught Exception:', err?.message || err);
});
process.on('unhandledRejection', (reason) => {
  console.error('[Guard] Unhandled Rejection:', reason?.message || reason);
});

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// State management
let sock = null;
let connectionStatus = 'disconnected'; // 'disconnected' | 'connecting' | 'scan_qr' | 'connected'
let qrCodeDataUrl = null;
let connectedUser = null;
let isInitializing = false;
let reconnectAttempts = 0;
let reconnectTimer = null;
const recentMessages = [];

// Cache pesan keluar sederhana di memori untuk melayani retry enkripsi WhatsApp
const sentMessageStore = new Map();
function saveMessageToStore(keyId, messageObj) {
  if (!keyId || !messageObj) return;
  sentMessageStore.set(keyId, messageObj);
  if (sentMessageStore.size > 200) {
    const firstKey = sentMessageStore.keys().next().value;
    sentMessageStore.delete(firstKey);
  }
}

// Anti-Ban Queue State
const messageQueue = [];
let isProcessingQueue = false;
let totalSentCount = 0;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomBetween(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function generateRefCode() {
  return crypto.randomBytes(3).toString('hex').toUpperCase();
}

function getTimeGreeting() {
  const hour = new Date().getHours();
  if (hour >= 4 && hour < 11) return 'Selamat Pagi';
  if (hour >= 11 && hour < 15) return 'Selamat Siang';
  if (hour >= 15 && hour < 18) return 'Selamat Sore';
  return 'Selamat Malam';
}

function formatWIBTimestamp(date = new Date()) {
  return new Intl.DateTimeFormat('id-ID', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(date);
}

/**
 * Mencegah gelar dokter seperti "Sp.MK", "Sp.PD", "Sp.PA", "Sp.PK"
 * terdeteksi oleh WhatsApp sebagai link domain negara (.mk, .pa, .pk)
 */
function sanitizeDoctorTitle(str) {
  if (!str) return '';
  return String(str).replace(/\.([A-Za-z])/g, '.\u200B$1');
}

/**
 * Pastikan URL dapat diklik di WhatsApp:
 * WhatsApp hanya mengaktifkan link klik jika hostname memiliki TLD resmi (.id, .com, .io, dll).
 * Untuk environment lokal (localhost / 127.0.0.1), gunakan wildcard DNS "127.0.0.1.nip.io"
 * yang otomatis mengarah ke 127.0.0.1 di browser namun 100% bisa diklik di WhatsApp.
 */
function ensureClickableUrl(rawUrl) {
  if (!rawUrl) return '';
  return String(rawUrl)
    .trim()
    .replace(/^http:\/\/(localhost|127\.0\.0\.1)(?=:|$|\/)/i, 'http://127.0.0.1.nip.io')
    .replace(/^https:\/\/(localhost|127\.0\.0\.1)(?=:|$|\/)/i, 'https://127.0.0.1.nip.io');
}

/**
 * Menambahkan footer unik (Ref ID + Waktu hingga detik) agar pesan dengan
 * template yang sama tidak memiliki hash identik di algoritma anti-spam WhatsApp
 */
function makeMessageUnique(rawText, disableUnique = false) {
  const cleanText = String(rawText || '').trim();
  if (disableUnique || !AUTO_UNIQUE_FOOTER) {
    return cleanText;
  }
  if (cleanText.includes('Ref ID:') || cleanText.includes('Ref:')) {
    return cleanText;
  }
  const ref = generateRefCode();
  const timeStr = formatWIBTimestamp();
  return `${cleanText}\n\n_Ref ID: #${ref} • ${timeStr}_`;
}

/**
 * Bersihkan teks catatan multi-baris agar tetap satu baris rapi
 * dan tidak memicu auto-numbered-list yang merusak indentasi di WhatsApp
 */
function formatCleanNotes(rawNotes) {
  if (!rawNotes) return '';
  return String(rawNotes)
    .split(/\r?\n+/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join('; ')
    .replace(/\s{2,}/g, ' ');
}

/**
 * Builder Template Ringkas, Simple & Profesional dengan Brand "Sehatlink - PPRA":
 * 1. Pengajuan Antibiotik Baru (type: 'request')
 * 2. Pengingat Verifikasi Sebelum 2 Jam / SLA (type: 'reminder')
 * 3. Hasil Terverifikasi (type: 'result')
 *
 * Jika terdapat URL (payload.url / payload.link), URL tidak ditampilkan mentah di body,
 * melainkan dirender sebagai tombol interaktif native WhatsApp (cta_url) dengan footer "Sehatlink - PPRA".
 */
function buildVerificationMessage(payload) {
  const type = String(payload.type || 'request').toLowerCase();
  const nama = sanitizeDoctorTitle(
    payload.recipientName ||
      payload.nama_penerima ||
      payload.nama ||
      'Dokter / Petugas'
  );
  const nomor =
    payload.referenceNo ||
    payload.nomor ||
    payload.no_pengajuan ||
    `PPRA-${randomBetween(100, 999)}`;
  const pasien = payload.pasien || payload.patientName || '';
  const ruangan = payload.ruangan || payload.roomName || '';
  const antibiotik =
    payload.antibiotik ||
    payload.regimen ||
    payload.category ||
    payload.jenis ||
    payload.perihal ||
    'Antimikroba Restriksi';
  const pemohon = sanitizeDoctorTitle(
    payload.requesterName || payload.pemohon || payload.pengaju || 'DPJP'
  );
  const catatan = formatCleanNotes(payload.notes || payload.catatan || '');
  const targetUrl = ensureClickableUrl(payload.url || payload.link || '');

  const ref = generateRefCode();
  const timeStr = formatWIBTimestamp();
  const footerLine = `_Sehatlink - PPRA • ${timeStr} (#${ref})_`;

  // 1. TEMPLATE PENGAJUAN ANTIBIOTIK BARU (SIMPLE & RINGKAS)
  if (type === 'request' || type === 'permintaan') {
    const lines = [
      '🔔 *Pengajuan Antibiotik PPRA*',
      '',
      `Yth. *${nama}*,`,
      'Terdapat pengajuan antibiotik baru yang menunggu verifikasi:',
      '',
      `• *No. Pengajuan:* \`${nomor}\``,
    ];

    if (pasien) {
      lines.push(`• *Pasien:* ${pasien}`);
    }
    if (ruangan) {
      lines.push(`• *Ruangan:* ${ruangan}`);
    }
    lines.push(`• *Antibiotik:* ${antibiotik}`);
    lines.push(`• *DPJP:* ${pemohon}`);

    if (!targetUrl) {
      lines.push('');
      lines.push(footerLine);
    }

    return lines.join('\n');
  }

  // 2. TEMPLATE PENGINGAT VERIFIKASI SEBELUM 2 JAM / SLA (SIMPLE & RINGKAS)
  if (type === 'reminder' || type === 'pengingat' || type === 'sla') {
    const sisaWaktu = payload.remainingTime || payload.sisa_waktu || '±30 menit';
    const targetSla = payload.slaTarget || payload.target_sla || '2 jam';

    const lines = [
      '⏰ *Pengingat Verifikasi PPRA*',
      '',
      `Yth. *${nama}*,`,
      `Pengajuan antibiotik berikut belum diverifikasi dan mendekati batas waktu ${targetSla} (Sisa waktu: *${sisaWaktu}*):`,
      '',
      `• *No. Pengajuan:* \`${nomor}\``,
    ];

    if (pasien) {
      lines.push(`• *Pasien:* ${pasien}`);
    }
    if (ruangan) {
      lines.push(`• *Ruangan:* ${ruangan}`);
    }
    lines.push(`• *Antibiotik:* ${antibiotik}`);
    lines.push(`• *DPJP:* ${pemohon}`);
    lines.push('');
    lines.push('Mohon segera ditindaklanjuti pada aplikasi PPRA.');

    if (!targetUrl) {
      lines.push('');
      lines.push(footerLine);
    }

    return lines.join('\n');
  }

  // 3. TEMPLATE HASIL TERVERIFIKASI (SIMPLE & RINGKAS)
  const rawStatus = String(payload.status || 'disetujui').toLowerCase();
  const verifikator = sanitizeDoctorTitle(
    payload.verifierName || payload.verifikator || 'Komite PPRA'
  );

  let statusLabel = 'DISETUJUI';
  let headerIcon = '✅';

  if (rawStatus.includes('tolak') || rawStatus === 'rejected') {
    statusLabel = 'DITOLAK';
    headerIcon = '❌';
  } else if (rawStatus.includes('revisi') || rawStatus === 'revision') {
    statusLabel = 'PERLU REVISI';
    headerIcon = '⚠️';
  } else if (rawStatus.includes('penyesuaian') || rawStatus.includes('modified')) {
    statusLabel = 'DISETUJUI (PENYESUAIAN)';
    headerIcon = '🔄';
  }

  const lines = [
    `${headerIcon} *Hasil Verifikasi PPRA*`,
    '',
    `Yth. *${nama}*,`,
    'Pengajuan penggunaan antibiotik berikut telah diverifikasi:',
    '',
    `• *No. Pengajuan:* \`${nomor}\``,
  ];

  if (pasien) {
    lines.push(`• *Pasien:* ${pasien}`);
  }
  if (ruangan) {
    lines.push(`• *Ruangan:* ${ruangan}`);
  }
  lines.push(`• *Antibiotik:* ${antibiotik}`);
  lines.push(`• *Status:* *${statusLabel}*`);
  lines.push(`• *Verifikator:* ${verifikator}`);
  if (catatan && catatan !== '-' && catatan !== 'Telaah klinis selesai.') {
    lines.push(`• *Catatan:* ${catatan}`);
  }

  if (!targetUrl) {
    lines.push('');
    lines.push(footerLine);
  }

  return lines.join('\n');
}

function addMessageLog(entry) {
  recentMessages.unshift({
    id: entry.id || Date.now().toString(),
    from: entry.from,
    pushName: entry.pushName || '-',
    text: entry.text,
    fromMe: Boolean(entry.fromMe),
    timestamp: new Date().toISOString(),
  });
  if (recentMessages.length > 30) {
    recentMessages.pop();
  }
}

/**
 * Format nomor telepon ke format JID WhatsApp (contoh: 0812xxx -> 62812xxx@s.whatsapp.net)
 */
function formatJid(input) {
  if (!input) return '';
  const raw = String(input).trim();
  if (raw.endsWith('@s.whatsapp.net') || raw.endsWith('@g.us')) {
    return raw;
  }
  let digits = raw.replace(/[^0-9]/g, '');
  if (digits.startsWith('08')) {
    digits = '62' + digits.slice(1);
  } else if (digits.startsWith('8')) {
    digits = '62' + digits;
  }
  return `${digits}@s.whatsapp.net`;
}

/**
 * Kirim pesan interaktif WhatsApp dengan tombol URL (cta_url) dan footer brand "Sehatlink - PPRA".
 * Menginjeksi binary node `biz` -> `interactive` -> `native_flow (v=9, name=mixed)` dan `bot (biz_bot=1)`
 * agar tombol dirender penuh pada WhatsApp pribadi (1:1) maupun grup.
 */
async function sendInteractiveCtaUrl(
  jid,
  {
    text,
    footer = 'Sehatlink - PPRA',
    buttonText = 'Buka Aplikasi PPRA',
    buttonUrl,
  }
) {
  const interactiveMessage = {
    nativeFlowMessage: {
      buttons: [
        {
          name: 'cta_url',
          buttonParamsJson: JSON.stringify({
            display_text: buttonText,
            url: buttonUrl,
            merchant_url: buttonUrl,
          }),
        },
      ],
    },
    body: { text },
    footer: { text: footer },
  };

  const userJid = sock.authState?.creds?.me?.id || sock.user?.id;
  const fullMsg = generateWAMessageFromContent(
    jid,
    { interactiveMessage },
    {
      logger: sock.logger,
      userJid,
      messageId:
        typeof generateMessageIDV2 === 'function'
          ? generateMessageIDV2(userJid)
          : undefined,
      timestamp: new Date(),
    }
  );

  const isPrivate =
    typeof isJidGroup === 'function'
      ? !isJidGroup(jid)
      : !jid.endsWith('@g.us');

  const additionalNodes = [
    {
      tag: 'biz',
      attrs: {},
      content: [
        {
          tag: 'interactive',
          attrs: { type: 'native_flow', v: '1' },
          content: [
            {
              tag: 'native_flow',
              attrs: { v: '9', name: 'mixed' },
            },
          ],
        },
      ],
    },
  ];

  if (isPrivate) {
    additionalNodes.push({ tag: 'bot', attrs: { biz_bot: '1' } });
  }

  await sock.relayMessage(jid, fullMsg.message, {
    messageId: fullMsg.key.id,
    additionalAttributes: {},
    additionalNodes,
  });

  if (sock.config?.emitOwnEvents && isPrivate) {
    process.nextTick(() => {
      if (sock.processingMutex?.mutex && sock.upsertMessage) {
        sock.processingMutex.mutex(() => sock.upsertMessage(fullMsg, 'append'));
      }
    });
  }

  return fullMsg;
}

/**
 * Worker pemroses antrean pesan dengan simulasi mengetik (typing) & jeda acak (anti-ban)
 */
async function processMessageQueue() {
  if (isProcessingQueue) return;
  isProcessingQueue = true;

  while (messageQueue.length > 0) {
    const job = messageQueue[0];

    try {
      // Jika sedang reconnecting sesaat, tunggu hingga 6 detik sebelum menyerah
      if (connectionStatus !== 'connected' || !sock) {
        let waited = 0;
        while ((connectionStatus !== 'connected' || !sock) && waited < 6000) {
          await sleep(500);
          waited += 500;
        }
      }

      if (connectionStatus !== 'connected' || !sock) {
        throw new Error(`WhatsApp belum terhubung (status: ${connectionStatus})`);
      }

      // 1. Simulasi sedang mengetik (composing)
      const typingMs = randomBetween(TYPING_DELAY_MIN_MS, TYPING_DELAY_MAX_MS);
      try {
        await sock.sendPresenceUpdate('composing', job.jid);
      } catch (_) {}

      await sleep(typingMs);

      try {
        await sock.sendPresenceUpdate('paused', job.jid);
      } catch (_) {}

      // 2. Kirim pesan: gunakan Interactive CTA URL Button jika buttonUrl tersedia, fallback ke teks biasa
      let sentMsgId = null;
      if (job.buttonUrl) {
        try {
          const fullMsg = await sendInteractiveCtaUrl(job.jid, {
            text: job.text,
            footer: job.footerText || 'Sehatlink - PPRA',
            buttonText: job.buttonText || 'Buka Aplikasi PPRA',
            buttonUrl: job.buttonUrl,
          });
          sentMsgId = fullMsg?.key?.id;
          saveMessageToStore(sentMsgId, fullMsg?.message);
        } catch (interactiveErr) {
          console.warn(
            `[Interactive Button Fallback] (${job.jid}):`,
            interactiveErr.message
          );
          const fallbackText = `${job.text}\n\n↗ *${job.buttonText || 'Buka Aplikasi PPRA'}:*\n${job.buttonUrl}\n\n_${job.footerText || 'Sehatlink - PPRA'}_`;
          const result = await sock.sendMessage(job.jid, { text: fallbackText });
          sentMsgId = result?.key?.id;
          saveMessageToStore(sentMsgId, result?.message || { conversation: fallbackText });
        }
      } else {
        const result = await sock.sendMessage(job.jid, { text: job.text });
        sentMsgId = result?.key?.id;
        saveMessageToStore(sentMsgId, result?.message || { conversation: job.text });
      }
      totalSentCount += 1;

      addMessageLog({
        id: sentMsgId || job.jobId,
        from: job.jid.replace('@s.whatsapp.net', ''),
        pushName: job.label || 'Notifikasi Keluar',
        text: job.buttonUrl
          ? `${job.text}\n\n${job.footerText || 'Sehatlink - PPRA'}\n[ ↗ ${job.buttonText || 'Buka Aplikasi PPRA'} -> ${job.buttonUrl} ]`
          : job.text,
        fromMe: true,
      });

      if (job.resolve) {
        job.resolve({
          jobId: job.jobId,
          to: job.jid,
          messageId: sentMsgId,
          typingDelayMs: typingMs,
        });
      }
    } catch (err) {
      console.error(`[Queue Send Error] (${job.jid}):`, err.message);
      if (job.reject) {
        job.reject(err);
      }
    }

    messageQueue.shift();

    // 3. Jika masih ada pesan berikutnya di antrean, beri jeda acak (cooldown)
    if (messageQueue.length > 0) {
      const cooldownMs = randomBetween(
        QUEUE_COOLDOWN_MIN_MS,
        QUEUE_COOLDOWN_MAX_MS
      );
      await sleep(cooldownMs);
    }
  }

  isProcessingQueue = false;
}

/**
 * Masukkan pesan ke antrean pengiriman aman
 */
function enqueueMessage({
  jid,
  text,
  label = 'API Outgoing',
  buttonUrl = '',
  buttonText = 'Buka Aplikasi PPRA',
  footerText = 'Sehatlink - PPRA',
  waitForSend = true,
}) {
  const jobId = `MSG-${Date.now()}-${generateRefCode()}`;
  const position = messageQueue.length + 1;

  if (!waitForSend) {
    messageQueue.push({
      jobId,
      jid,
      text,
      label,
      buttonUrl,
      buttonText,
      footerText,
    });
    processMessageQueue();
    return Promise.resolve({
      queued: true,
      jobId,
      queuePosition: position,
      to: jid,
    });
  }

  return new Promise((resolve, reject) => {
    messageQueue.push({
      jobId,
      jid,
      text,
      label,
      buttonUrl,
      buttonText,
      footerText,
      resolve,
      reject,
    });
    processMessageQueue();
  });
}

function scheduleReconnect(delayMs) {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
  }
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectToWhatsApp();
  }, delayMs);
}

/**
 * Inisialisasi koneksi Baileys WhatsApp dengan tuning stabilitas tinggi
 */
async function connectToWhatsApp() {
  if (isInitializing) return;
  isInitializing = true;

  try {
    if (sock?.ev) {
      try {
        sock.ev.removeAllListeners();
      } catch (_) {}
    }

    connectionStatus = 'connecting';
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

    let version = [2, 3000, 1015901307];
    try {
      const latest = await fetchLatestBaileysVersion();
      if (latest?.version) {
        version = latest.version;
      }
    } catch (_) {}

    sock = makeWASocket({
      version,
      logger: pino({ level: 'silent' }),
      printQRInTerminal: false,
      auth: state,
      browser: Browsers.macOS('Desktop'),
      syncFullHistory: false,
      markOnlineOnConnect: false,
      generateHighQualityLinkPreview: false,
      keepAliveIntervalMs: 25000,
      connectTimeoutMs: 60000,
      defaultQueryTimeoutMs: 60000,
      retryRequestDelayMs: 2000,
      getMessage: async (key) => {
        if (key?.id && sentMessageStore.has(key.id)) {
          return sentMessageStore.get(key.id);
        }
        return { conversation: 'Notifikasi PPRA' };
      },
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        connectionStatus = 'scan_qr';
        qrCodeDataUrl = await qrcode.toDataURL(qr);
        console.log('\n================================================');
        console.log('📱 Scan QR Code di bawah ini atau buka:');
        console.log(`🌐 http://localhost:${PORT}`);
        console.log('================================================\n');
        qrcodeTerminal.generate(qr, { small: true });
      }

      if (connection === 'close') {
        qrCodeDataUrl = null;
        connectedUser = null;
        const statusCode = lastDisconnect?.error?.output?.statusCode;

        console.log(`[Baileys] Koneksi terputus (kode: ${statusCode}).`);

        if (statusCode === DisconnectReason.loggedOut) {
          console.log(
            '[Baileys] Sesi logout dari HP terdeteksi. Menghapus kredensial lama...'
          );
          connectionStatus = 'disconnected';
          reconnectAttempts = 0;
          if (fs.existsSync(AUTH_DIR)) {
            fs.rmSync(AUTH_DIR, { recursive: true, force: true });
          }
          scheduleReconnect(1500);
        } else if (statusCode === DisconnectReason.restartRequired) {
          console.log(
            '[Baileys] Restart diperlukan setelah pairing, menyambungkan ulang seketika...'
          );
          connectionStatus = 'connecting';
          reconnectAttempts = 0;
          scheduleReconnect(300);
        } else {
          reconnectAttempts += 1;
          const delayMs = Math.min(10000, 2000 * Math.min(reconnectAttempts, 5));
          console.log(
            `[Baileys] Menyambungkan ulang otomatis dalam ${delayMs}ms (percobaan ke-${reconnectAttempts})...`
          );
          connectionStatus = 'connecting';
          scheduleReconnect(delayMs);
        }
      } else if (connection === 'open') {
        reconnectAttempts = 0;
        connectionStatus = 'connected';
        qrCodeDataUrl = null;
        const rawId = sock.user?.id || '';
        const phone = rawId.split(':')[0].split('@')[0];
        connectedUser = {
          id: rawId,
          phone,
          name: sock.user?.name || 'WhatsApp User',
        };
        console.log(
          `[Baileys] ✅ Terhubung stabil sebagai ${connectedUser.name} (${connectedUser.phone})`
        );

        if (messageQueue.length > 0) {
          processMessageQueue();
        }
      }
    });

    sock.ev.on('messages.upsert', async (event) => {
      if (event.type !== 'notify') return;

      for (const msg of event.messages) {
        if (!msg.message) continue;
        const remoteJid = msg.key.remoteJid;
        if (!remoteJid || remoteJid === 'status@broadcast') continue;

        const text =
          msg.message.conversation ||
          msg.message.extendedTextMessage?.text ||
          msg.message.imageMessage?.caption ||
          msg.message.videoMessage?.caption ||
          '';

        if (!text) continue;

        const senderPhone = remoteJid.replace('@s.whatsapp.net', '');
        addMessageLog({
          id: msg.key.id,
          from: senderPhone,
          pushName: msg.pushName || '-',
          text,
          fromMe: msg.key.fromMe,
        });

        if (!msg.key.fromMe) {
          console.log(`[Pesan Masuk] Dari ${msg.pushName || senderPhone}: ${text}`);

          if (AUTO_REPLY_PING && text.trim().toLowerCase() === '!ping') {
            await sock.sendMessage(
              remoteJid,
              { text: 'Pong! 🏓 Gateway WhatsApp Baileys PPRA aktif & stabil.' },
              { quoted: msg }
            );
          }

          if (WEBHOOK_URL) {
            fetch(WEBHOOK_URL, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                id: msg.key.id,
                from: senderPhone,
                jid: remoteJid,
                pushName: msg.pushName || null,
                message: text,
                timestamp: msg.messageTimestamp,
              }),
            }).catch((err) => {
              console.error('[Webhook Error]', err.message);
            });
          }
        }
      }
    });
  } catch (err) {
    console.error('[Baileys Init Error]', err);
    connectionStatus = 'disconnected';
    scheduleReconnect(4000);
  } finally {
    isInitializing = false;
  }
}

function requireApiKey(req, res, next) {
  if (!API_KEY) return next();
  const providedKey =
    req.headers['x-api-key'] || req.query.api_key || req.body?.api_key;
  if (providedKey !== API_KEY) {
    return res.status(401).json({
      success: false,
      message: 'Unauthorized: API Key tidak valid',
    });
  }
  next();
}

// ============================================================
// REST API ENDPOINTS
// ============================================================

app.get('/api/status', requireApiKey, (req, res) => {
  res.json({
    success: true,
    status: connectionStatus,
    user: connectedUser,
    qr: qrCodeDataUrl,
    uptimeSeconds: Math.floor(process.uptime()),
    queue: {
      pending: messageQueue.length,
      isProcessing: isProcessingQueue,
      totalSent: totalSentCount,
      antiBanConfig: {
        autoUniqueFooter: AUTO_UNIQUE_FOOTER,
        typingDelayMs: `${TYPING_DELAY_MIN_MS}-${TYPING_DELAY_MAX_MS}`,
        cooldownDelayMs: `${QUEUE_COOLDOWN_MIN_MS}-${QUEUE_COOLDOWN_MAX_MS}`,
      },
    },
    timestamp: new Date().toISOString(),
  });
});

app.get('/api/messages', requireApiKey, (req, res) => {
  res.json({
    success: true,
    messages: recentMessages,
  });
});

app.post('/api/send-message', requireApiKey, async (req, res) => {
  try {
    const rawTarget = req.body.phone || req.body.number || req.body.to;
    const textContent = req.body.message || req.body.text;

    if (!rawTarget || !textContent) {
      return res.status(400).json({
        success: false,
        message: 'Parameter "phone" (atau "number") dan "message" wajib diisi.',
      });
    }

    if (connectionStatus !== 'connected' && connectionStatus !== 'connecting') {
      return res.status(503).json({
        success: false,
        message: `WhatsApp belum terhubung (status saat ini: ${connectionStatus}). Silakan scan QR terlebih dahulu.`,
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
    const shouldRunAsync = Boolean(req.body.async) || messageQueue.length >= 2;

    const result = await enqueueMessage({
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

app.post('/api/send-verification', requireApiKey, async (req, res) => {
  try {
    const rawTarget = req.body.phone || req.body.number || req.body.to;
    if (!rawTarget) {
      return res.status(400).json({
        success: false,
        message: 'Parameter "phone" (nomor WhatsApp tujuan) wajib diisi.',
      });
    }

    if (connectionStatus !== 'connected' && connectionStatus !== 'connecting') {
      return res.status(503).json({
        success: false,
        message: `WhatsApp belum terhubung (status saat ini: ${connectionStatus}).`,
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

    const shouldRunAsync = Boolean(req.body.async) || messageQueue.length >= 2;

    const result = await enqueueMessage({
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
        ? `${notifType} masuk antrean pengiriman aman (posisi ke-${result.queuePosition})`
        : `${notifType} berhasil dikirim`,
      data: {
        ...result,
        previewText: formattedText,
      },
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

app.post('/api/check-number', requireApiKey, async (req, res) => {
  try {
    const rawTarget = req.body.phone || req.body.number;
    if (!rawTarget) {
      return res.status(400).json({
        success: false,
        message: 'Parameter "phone" wajib diisi.',
      });
    }

    if (connectionStatus !== 'connected' || !sock) {
      return res.status(503).json({
        success: false,
        message: 'WhatsApp belum terhubung.',
      });
    }

    const jid = formatJid(rawTarget);
    const [result] = await sock.onWhatsApp(jid);

    return res.json({
      success: true,
      exists: Boolean(result?.exists),
      jid: result?.jid || jid,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: 'Gagal memeriksa nomor',
      error: error.message,
    });
  }
});

app.post('/api/logout', requireApiKey, async (req, res) => {
  try {
    if (sock) {
      await sock.logout().catch(() => {});
    }
    if (fs.existsSync(AUTH_DIR)) {
      fs.rmSync(AUTH_DIR, { recursive: true, force: true });
    }
    connectionStatus = 'disconnected';
    qrCodeDataUrl = null;
    connectedUser = null;
    scheduleReconnect(1000);

    return res.json({
      success: true,
      message: 'Sesi berhasil direset. QR Code baru sedang dibuat.',
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: 'Gagal logout sesi',
      error: error.message,
    });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Server WA Baileys berjalan stabil di http://localhost:${PORT}`);
  connectToWhatsApp();
});
