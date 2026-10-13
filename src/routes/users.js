import { Router } from 'express';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import { requireSuperAdmin, publicUser } from '../auth.js';
import {
  listUsers,
  createUser,
  findUserById,
  findUserByEmail,
  updateUser,
  deleteUser,
} from '../db.js';

const router = Router();

router.use(requireSuperAdmin);

router.get('/', (_req, res) => {
  res.json({
    success: true,
    users: listUsers(),
  });
});

router.post('/', async (req, res) => {
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
    if (findUserByEmail(String(email).trim().toLowerCase())) {
      return res.status(409).json({
        success: false,
        message: 'Email sudah terdaftar',
      });
    }
    const passwordHash = await bcrypt.hash(password, 12);
    const user = createUser({
      id: crypto.randomUUID(),
      email: String(email).trim().toLowerCase(),
      passwordHash,
      name: String(name || email).trim(),
      role: 'admin',
    });
    return res.status(201).json({
      success: true,
      message: 'Admin berhasil dibuat',
      user: publicUser(user),
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      message: err.message || 'Gagal membuat admin',
    });
  }
});

router.patch('/:id', async (req, res) => {
  try {
    const user = findUserById(req.params.id);
    if (!user) {
      return res.status(404).json({ success: false, message: 'User tidak ditemukan' });
    }
    if (user.role === 'super_admin' && user.id !== req.user.id) {
      return res.status(403).json({
        success: false,
        message: 'Tidak dapat mengubah super admin lain',
      });
    }

    const fields = {};
    if (req.body.name !== undefined) fields.name = String(req.body.name).trim();
    if (req.body.email !== undefined) {
      fields.email = String(req.body.email).trim().toLowerCase();
    }
    if (req.body.password) {
      if (String(req.body.password).length < 8) {
        return res.status(400).json({
          success: false,
          message: 'Password minimal 8 karakter',
        });
      }
      fields.password_hash = await bcrypt.hash(req.body.password, 12);
    }

    const updated = updateUser(user.id, fields);
    return res.json({ success: true, user: publicUser(updated) });
  } catch (err) {
    return res.status(500).json({
      success: false,
      message: err.message || 'Gagal update user',
    });
  }
});

router.delete('/:id', (req, res) => {
  const user = findUserById(req.params.id);
  if (!user) {
    return res.status(404).json({ success: false, message: 'User tidak ditemukan' });
  }
  if (user.role === 'super_admin') {
    return res.status(403).json({
      success: false,
      message: 'Super admin tidak dapat dihapus',
    });
  }
  if (user.id === req.user.id) {
    return res.status(400).json({
      success: false,
      message: 'Tidak dapat menghapus akun sendiri',
    });
  }
  deleteUser(user.id);
  return res.json({ success: true, message: 'Admin dihapus' });
});

export default router;
