import { Router } from 'express';
import {
  isRegistrationOpen,
  registerSuperAdmin,
  loginUser,
  requireAuth,
  publicUser,
} from '../auth.js';
import { findUserById } from '../db.js';
import { deviceManager } from '../device-manager.js';

const router = Router();

router.get('/bootstrap', (_req, res) => {
  res.json({
    success: true,
    registrationOpen: isRegistrationOpen(),
  });
});

router.post('/register', async (req, res) => {
  try {
    const { email, password, name } = req.body || {};
    if (!email || !password) {
      return res.status(400).json({
        success: false,
        message: 'Email dan password wajib diisi',
      });
    }
    if (String(password).length < 8) {
      return res.status(400).json({
        success: false,
        message: 'Password minimal 8 karakter',
      });
    }
    const user = await registerSuperAdmin({ email, password, name });
    req.session.userId = user.id;

    // Migrasi auth lama (jika ada) setelah superadmin pertama ada
    const migrated = deviceManager.migrateLegacyAuth();
    if (migrated) {
      deviceManager.start(migrated.id);
    }

    return res.status(201).json({
      success: true,
      message: 'Super admin berhasil dibuat. Pendaftaran publik ditutup.',
      user,
      migratedDevice: migrated
        ? { id: migrated.id, apiKey: migrated.apiKey }
        : null,
    });
  } catch (err) {
    return res.status(err.status || 500).json({
      success: false,
      message: err.message || 'Gagal mendaftar',
    });
  }
});

router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) {
      return res.status(400).json({
        success: false,
        message: 'Email dan password wajib diisi',
      });
    }
    const user = await loginUser({ email, password });
    req.session.userId = user.id;
    return res.json({ success: true, user });
  } catch (err) {
    return res.status(err.status || 500).json({
      success: false,
      message: err.message || 'Gagal login',
    });
  }
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => {
    res.clearCookie('wa_baileys_sid');
    res.json({ success: true, message: 'Logged out' });
  });
});

router.get('/me', requireAuth, (req, res) => {
  res.json({
    success: true,
    user: publicUser(findUserById(req.session.userId)),
  });
});

export default router;
