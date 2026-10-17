import crypto from 'crypto';

export const AUTO_UNIQUE_FOOTER = process.env.AUTO_UNIQUE_FOOTER !== 'false';
export const TYPING_DELAY_MIN_MS = Number(process.env.TYPING_DELAY_MIN_MS) || 1000;
export const TYPING_DELAY_MAX_MS = Number(process.env.TYPING_DELAY_MAX_MS) || 2200;
export const QUEUE_COOLDOWN_MIN_MS = Number(process.env.QUEUE_COOLDOWN_MIN_MS) || 2000;
export const QUEUE_COOLDOWN_MAX_MS = Number(process.env.QUEUE_COOLDOWN_MAX_MS) || 4000;
export const AUTO_REPLY_PING = process.env.AUTO_REPLY_PING !== 'false';

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function randomBetween(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

export function generateRefCode() {
  return crypto.randomBytes(3).toString('hex').toUpperCase();
}

export function generateApiKey() {
  return crypto.randomBytes(32).toString('hex');
}

export function formatWIBTimestamp(date = new Date()) {
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

export function sanitizeDoctorTitle(str) {
  if (!str) return '';
  return String(str).replace(/\.([A-Za-z])/g, '.\u200B$1');
}

export function ensureClickableUrl(rawUrl) {
  if (!rawUrl) return '';
  return String(rawUrl)
    .trim()
    .replace(/^http:\/\/(localhost|127\.0\.0\.1)(?=:|$|\/)/i, 'http://127.0.0.1.nip.io')
    .replace(/^https:\/\/(localhost|127\.0\.0\.1)(?=:|$|\/)/i, 'https://127.0.0.1.nip.io');
}

export function makeMessageUnique(rawText, disableUnique = false) {
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

export function formatCleanNotes(rawNotes) {
  if (!rawNotes) return '';
  return String(rawNotes)
    .split(/\r?\n+/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join('; ')
    .replace(/\s{2,}/g, ' ');
}

export function formatJid(input) {
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

export function buildVerificationMessage(payload) {
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

  if (type === 'request' || type === 'permintaan') {
    const lines = [
      '🔔 *Pengajuan Antibiotik PPRA*',
      '',
      `Yth. *${nama}*,`,
      'Terdapat pengajuan antibiotik baru yang menunggu verifikasi:',
      '',
      `• *No. Pengajuan:* \`${nomor}\``,
    ];
    if (pasien) lines.push(`• *Pasien:* ${pasien}`);
    if (ruangan) lines.push(`• *Ruangan:* ${ruangan}`);
    lines.push(`• *Antibiotik:* ${antibiotik}`);
    lines.push(`• *DPJP:* ${pemohon}`);
    if (!targetUrl) {
      lines.push('');
      lines.push(footerLine);
    }
    return lines.join('\n');
  }

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
    if (pasien) lines.push(`• *Pasien:* ${pasien}`);
    if (ruangan) lines.push(`• *Ruangan:* ${ruangan}`);
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
  if (pasien) lines.push(`• *Pasien:* ${pasien}`);
  if (ruangan) lines.push(`• *Ruangan:* ${ruangan}`);
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
