import express from 'express';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { createSessionMiddleware } from './src/auth.js';
import { deviceManager } from './src/device-manager.js';
import authRoutes from './src/routes/auth.js';
import usersRoutes from './src/routes/users.js';
import devicesRoutes from './src/routes/devices.js';
import sendRoutes from './src/routes/send.js';

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3012;

process.on('uncaughtException', (err) => {
  console.error('[Guard] Uncaught Exception:', err?.message || err);
});
process.on('unhandledRejection', (reason) => {
  console.error('[Guard] Unhandled Rejection:', reason?.message || reason);
});

const app = express();

// Di belakang Apache/Cloudflare, trust proxy agar secure cookie bekerja
app.set('trust proxy', 1);

app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(createSessionMiddleware());

app.use('/api/auth', authRoutes);
app.use('/api/users', usersRoutes);
app.use('/api/devices', devicesRoutes);
// External send API — autentikasi via X-API-Key per device
app.use('/api', sendRoutes);

app.use(express.static(path.join(__dirname, 'public')));

app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, async () => {
  console.log(`🚀 WA Baileys multi-device di http://localhost:${PORT}`);
  try {
    const migrated = deviceManager.migrateLegacyAuth();
    if (migrated) {
      console.log(`[Boot] Legacy auth migrated to device ${migrated.id}`);
    }
    await deviceManager.startAll();
    console.log('[Boot] Semua device dijalankan');
  } catch (err) {
    console.error('[Boot] Gagal start devices:', err.message);
  }
});
