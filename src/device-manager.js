import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  Browsers,
  generateWAMessageFromContent,
  isJidGroup,
  generateMessageIDV2,
} from '@whiskeysockets/baileys';
import pino from 'pino';
import qrcode from 'qrcode';
import qrcodeTerminal from 'qrcode-terminal';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import {
  ROOT,
  listDevices,
  findDeviceById,
  updateDevice,
  createDevice,
  userCount,
  listUsers,
} from './db.js';
import {
  AUTO_REPLY_PING,
  AUTO_UNIQUE_FOOTER,
  TYPING_DELAY_MIN_MS,
  TYPING_DELAY_MAX_MS,
  QUEUE_COOLDOWN_MIN_MS,
  QUEUE_COOLDOWN_MAX_MS,
  sleep,
  randomBetween,
  generateRefCode,
  generateApiKey,
} from './helpers.js';

const AUTH_ROOT = path.join(ROOT, 'auth_info', 'devices');
const LEGACY_AUTH = path.join(ROOT, 'auth_info_baileys');

function authDirFor(deviceId) {
  return path.join(AUTH_ROOT, deviceId);
}

function createRuntime(deviceId) {
  return {
    deviceId,
    sock: null,
    status: 'disconnected',
    qr: null,
    user: null,
    isInitializing: false,
    reconnectAttempts: 0,
    reconnectTimer: null,
    messageQueue: [],
    isProcessingQueue: false,
    totalSentCount: 0,
    recentMessages: [],
    sentMessageStore: new Map(),
  };
}

class DeviceManager {
  constructor() {
    /** @type {Map<string, ReturnType<typeof createRuntime>>} */
    this.runtimes = new Map();
  }

  getRuntime(deviceId) {
    if (!this.runtimes.has(deviceId)) {
      this.runtimes.set(deviceId, createRuntime(deviceId));
    }
    return this.runtimes.get(deviceId);
  }

  persistStatus(deviceId, status, phone = undefined) {
    const fields = { status };
    if (phone !== undefined) fields.phone = phone;
    try {
      updateDevice(deviceId, fields);
    } catch (_) {}
  }

  getStatus(deviceId) {
    const rt = this.getRuntime(deviceId);
    return {
      deviceId,
      status: rt.status,
      user: rt.user,
      qr: rt.qr,
      queue: {
        pending: rt.messageQueue.length,
        isProcessing: rt.isProcessingQueue,
        totalSent: rt.totalSentCount,
        antiBanConfig: {
          autoUniqueFooter: AUTO_UNIQUE_FOOTER,
          typingDelayMs: `${TYPING_DELAY_MIN_MS}-${TYPING_DELAY_MAX_MS}`,
          cooldownDelayMs: `${QUEUE_COOLDOWN_MIN_MS}-${QUEUE_COOLDOWN_MAX_MS}`,
        },
      },
      messages: rt.recentMessages,
    };
  }

  addMessageLog(rt, entry) {
    rt.recentMessages.unshift({
      id: entry.id || Date.now().toString(),
      from: entry.from,
      pushName: entry.pushName || '-',
      text: entry.text,
      fromMe: Boolean(entry.fromMe),
      timestamp: new Date().toISOString(),
    });
    if (rt.recentMessages.length > 30) rt.recentMessages.pop();
  }

  saveMessageToStore(rt, keyId, messageObj) {
    if (!keyId || !messageObj) return;
    rt.sentMessageStore.set(keyId, messageObj);
    if (rt.sentMessageStore.size > 200) {
      const firstKey = rt.sentMessageStore.keys().next().value;
      rt.sentMessageStore.delete(firstKey);
    }
  }

  scheduleReconnect(deviceId, delayMs) {
    const rt = this.getRuntime(deviceId);
    if (rt.reconnectTimer) clearTimeout(rt.reconnectTimer);
    rt.reconnectTimer = setTimeout(() => {
      rt.reconnectTimer = null;
      this.start(deviceId);
    }, delayMs);
  }

  async sendInteractiveCtaUrl(rt, jid, {
    text,
    footer = 'Sehatlink - PPRA',
    buttonText = 'Buka Aplikasi PPRA',
    buttonUrl,
  }) {
    const sock = rt.sock;
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
            content: [{ tag: 'native_flow', attrs: { v: '9', name: 'mixed' } }],
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

    return fullMsg;
  }

  async processMessageQueue(deviceId) {
    const rt = this.getRuntime(deviceId);
    if (rt.isProcessingQueue) return;
    rt.isProcessingQueue = true;

    while (rt.messageQueue.length > 0) {
      const job = rt.messageQueue[0];
      try {
        if (rt.status !== 'connected' || !rt.sock) {
          let waited = 0;
          while ((rt.status !== 'connected' || !rt.sock) && waited < 6000) {
            await sleep(500);
            waited += 500;
          }
        }
        if (rt.status !== 'connected' || !rt.sock) {
          throw new Error(`WhatsApp belum terhubung (status: ${rt.status})`);
        }

        const typingMs = randomBetween(TYPING_DELAY_MIN_MS, TYPING_DELAY_MAX_MS);
        try {
          await rt.sock.sendPresenceUpdate('composing', job.jid);
        } catch (_) {}
        await sleep(typingMs);
        try {
          await rt.sock.sendPresenceUpdate('paused', job.jid);
        } catch (_) {}

        let sentMsgId = null;
        if (job.buttonUrl) {
          try {
            const fullMsg = await this.sendInteractiveCtaUrl(rt, job.jid, {
              text: job.text,
              footer: job.footerText || 'Sehatlink - PPRA',
              buttonText: job.buttonText || 'Buka Aplikasi PPRA',
              buttonUrl: job.buttonUrl,
            });
            sentMsgId = fullMsg?.key?.id;
            this.saveMessageToStore(rt, sentMsgId, fullMsg?.message);
          } catch (interactiveErr) {
            console.warn(
              `[${deviceId}] Interactive fallback:`,
              interactiveErr.message
            );
            const fallbackText = `${job.text}\n\n↗ *${job.buttonText || 'Buka Aplikasi PPRA'}:*\n${job.buttonUrl}\n\n_${job.footerText || 'Sehatlink - PPRA'}_`;
            const result = await rt.sock.sendMessage(job.jid, {
              text: fallbackText,
            });
            sentMsgId = result?.key?.id;
            this.saveMessageToStore(
              rt,
              sentMsgId,
              result?.message || { conversation: fallbackText }
            );
          }
        } else {
          const result = await rt.sock.sendMessage(job.jid, { text: job.text });
          sentMsgId = result?.key?.id;
          this.saveMessageToStore(
            rt,
            sentMsgId,
            result?.message || { conversation: job.text }
          );
        }

        rt.totalSentCount += 1;
        this.addMessageLog(rt, {
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
            deviceId,
          });
        }
      } catch (err) {
        console.error(`[${deviceId}] Queue send error:`, err.message);
        if (job.reject) job.reject(err);
      }

      rt.messageQueue.shift();
      if (rt.messageQueue.length > 0) {
        await sleep(
          randomBetween(QUEUE_COOLDOWN_MIN_MS, QUEUE_COOLDOWN_MAX_MS)
        );
      }
    }

    rt.isProcessingQueue = false;
  }

  enqueueMessage(
    deviceId,
    {
      jid,
      text,
      label = 'API Outgoing',
      buttonUrl = '',
      buttonText = 'Buka Aplikasi PPRA',
      footerText = 'Sehatlink - PPRA',
      waitForSend = true,
    }
  ) {
    const rt = this.getRuntime(deviceId);
    const jobId = `MSG-${Date.now()}-${generateRefCode()}`;
    const position = rt.messageQueue.length + 1;

    if (!waitForSend) {
      rt.messageQueue.push({
        jobId,
        jid,
        text,
        label,
        buttonUrl,
        buttonText,
        footerText,
      });
      this.processMessageQueue(deviceId);
      return Promise.resolve({
        queued: true,
        jobId,
        queuePosition: position,
        to: jid,
        deviceId,
      });
    }

    return new Promise((resolve, reject) => {
      rt.messageQueue.push({
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
      this.processMessageQueue(deviceId);
    });
  }

  async start(deviceId) {
    const device = findDeviceById(deviceId);
    if (!device) {
      console.warn(`[DeviceManager] Device ${deviceId} tidak ada di DB`);
      return;
    }

    const rt = this.getRuntime(deviceId);
    if (rt.isInitializing) return;
    rt.isInitializing = true;

    const AUTH_DIR = authDirFor(deviceId);
    fs.mkdirSync(AUTH_DIR, { recursive: true });

    try {
      if (rt.sock?.ev) {
        try {
          rt.sock.ev.removeAllListeners();
        } catch (_) {}
      }

      rt.status = 'connecting';
      this.persistStatus(deviceId, 'connecting');

      const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
      let version = [2, 3000, 1015901307];
      try {
        const latest = await fetchLatestBaileysVersion();
        if (latest?.version) version = latest.version;
      } catch (_) {}

      rt.sock = makeWASocket({
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
          if (key?.id && rt.sentMessageStore.has(key.id)) {
            return rt.sentMessageStore.get(key.id);
          }
          return { conversation: 'Notifikasi PPRA' };
        },
      });

      rt.sock.ev.on('creds.update', saveCreds);

      rt.sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
          rt.status = 'scan_qr';
          this.persistStatus(deviceId, 'scan_qr');
          rt.qr = await qrcode.toDataURL(qr);
          console.log(`[${deviceId}] Scan QR untuk device "${device.name}"`);
          qrcodeTerminal.generate(qr, { small: true });
        }

        if (connection === 'close') {
          rt.qr = null;
          rt.user = null;
          const statusCode = lastDisconnect?.error?.output?.statusCode;
          console.log(`[${deviceId}] Disconnect code=${statusCode}`);

          if (statusCode === DisconnectReason.loggedOut) {
            rt.status = 'disconnected';
            this.persistStatus(deviceId, 'disconnected', null);
            rt.reconnectAttempts = 0;
            if (fs.existsSync(AUTH_DIR)) {
              fs.rmSync(AUTH_DIR, { recursive: true, force: true });
            }
            this.scheduleReconnect(deviceId, 1500);
          } else if (statusCode === DisconnectReason.restartRequired) {
            rt.status = 'connecting';
            this.persistStatus(deviceId, 'connecting');
            rt.reconnectAttempts = 0;
            this.scheduleReconnect(deviceId, 300);
          } else {
            rt.reconnectAttempts += 1;
            const delayMs = Math.min(
              10000,
              2000 * Math.min(rt.reconnectAttempts, 5)
            );
            rt.status = 'connecting';
            this.persistStatus(deviceId, 'connecting');
            this.scheduleReconnect(deviceId, delayMs);
          }
        } else if (connection === 'open') {
          rt.reconnectAttempts = 0;
          rt.status = 'connected';
          rt.qr = null;
          const rawId = rt.sock.user?.id || '';
          const phone = rawId.split(':')[0].split('@')[0];
          rt.user = {
            id: rawId,
            phone,
            name: rt.sock.user?.name || 'WhatsApp User',
          };
          this.persistStatus(deviceId, 'connected', phone);
          console.log(
            `[${deviceId}] Connected as ${rt.user.name} (${rt.user.phone})`
          );
          if (rt.messageQueue.length > 0) {
            this.processMessageQueue(deviceId);
          }
        }
      });

      rt.sock.ev.on('messages.upsert', async (event) => {
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
          this.addMessageLog(rt, {
            id: msg.key.id,
            from: senderPhone,
            pushName: msg.pushName || '-',
            text,
            fromMe: msg.key.fromMe,
          });

          if (!msg.key.fromMe) {
            if (AUTO_REPLY_PING && text.trim().toLowerCase() === '!ping') {
              await rt.sock.sendMessage(
                remoteJid,
                { text: 'Pong! 🏓 Gateway WhatsApp Baileys aktif.' },
                { quoted: msg }
              );
            }
            const deviceRow = findDeviceById(deviceId);
            const webhookUrl = deviceRow?.webhook_url
              ? String(deviceRow.webhook_url).trim()
              : '';
            if (webhookUrl) {
              const headers = { 'Content-Type': 'application/json' };
              const webhookSecret = deviceRow?.webhook_secret
                ? String(deviceRow.webhook_secret).trim()
                : '';
              if (webhookSecret) {
                headers['X-Baiwa-Device-Webhook-Secret'] = webhookSecret;
              }
              fetch(webhookUrl, {
                method: 'POST',
                headers,
                body: JSON.stringify({
                  deviceId,
                  id: msg.key.id,
                  from: senderPhone,
                  jid: remoteJid,
                  pushName: msg.pushName || null,
                  message: text,
                  timestamp: msg.messageTimestamp,
                }),
              }).catch((err) =>
                console.error(`[${deviceId}] Webhook error`, err.message)
              );
            }
          }
        }
      });
    } catch (err) {
      console.error(`[${deviceId}] Init error`, err);
      rt.status = 'disconnected';
      this.persistStatus(deviceId, 'disconnected');
      this.scheduleReconnect(deviceId, 4000);
    } finally {
      rt.isInitializing = false;
    }
  }

  async stop(deviceId) {
    const rt = this.runtimes.get(deviceId);
    if (!rt) return;
    if (rt.reconnectTimer) clearTimeout(rt.reconnectTimer);
    if (rt.sock) {
      try {
        rt.sock.ev.removeAllListeners();
        rt.sock.end?.(undefined);
      } catch (_) {}
    }
    rt.sock = null;
    rt.status = 'disconnected';
    rt.qr = null;
    rt.user = null;
    this.persistStatus(deviceId, 'disconnected');
  }

  async logout(deviceId) {
    const rt = this.getRuntime(deviceId);
    if (rt.sock) {
      await rt.sock.logout().catch(() => {});
    }
    const AUTH_DIR = authDirFor(deviceId);
    if (fs.existsSync(AUTH_DIR)) {
      fs.rmSync(AUTH_DIR, { recursive: true, force: true });
    }
    rt.status = 'disconnected';
    rt.qr = null;
    rt.user = null;
    this.persistStatus(deviceId, 'disconnected', null);
    this.scheduleReconnect(deviceId, 1000);
  }

  async remove(deviceId) {
    await this.stop(deviceId);
    const AUTH_DIR = authDirFor(deviceId);
    if (fs.existsSync(AUTH_DIR)) {
      fs.rmSync(AUTH_DIR, { recursive: true, force: true });
    }
    this.runtimes.delete(deviceId);
  }

  async startAll() {
    const devices = listDevices({ all: true });
    for (const d of devices) {
      await this.start(d.id);
    }
  }

  /**
   * Migrasi folder auth lama ke device pertama milik superadmin (jika ada).
   */
  migrateLegacyAuth() {
    if (!fs.existsSync(LEGACY_AUTH)) return null;
    const devices = listDevices({ all: true });
    if (devices.length > 0) return null;
    if (userCount() === 0) return null;

    const superAdmin =
      listUsers().find((u) => u.role === 'super_admin') || listUsers()[0];
    if (!superAdmin) return null;

    const id = crypto.randomUUID();
    const apiKey = generateApiKey();
    createDevice({
      id,
      name: 'Default (migrated)',
      ownerUserId: superAdmin.id,
      apiKey,
    });

    const dest = authDirFor(id);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.renameSync(LEGACY_AUTH, dest);
    console.log(`[DeviceManager] Migrated legacy auth → device ${id}`);
    return { id, apiKey };
  }
}

export const deviceManager = new DeviceManager();
export { authDirFor, AUTH_ROOT };
