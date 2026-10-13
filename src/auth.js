import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import session from 'express-session';
import {
  userCount,
  findUserByEmail,
  findUserById,
  createUser,
  getSessionStore,
} from './db.js';

const SESSION_SECRET =
  process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');

class SqliteSessionStore extends session.Store {
  constructor() {
    super();
    this.store = getSessionStore();
  }

  get(sid, cb) {
    try {
      cb(null, this.store.get(sid) || null);
    } catch (err) {
      cb(err);
    }
  }

  set(sid, sess, cb) {
    try {
      const maxAge = sess.cookie?.maxAge || 7 * 24 * 60 * 60 * 1000;
      this.store.set(sid, sess, maxAge);
      cb(null);
    } catch (err) {
      cb(err);
    }
  }

  destroy(sid, cb) {
    try {
      this.store.destroy(sid);
      cb(null);
    } catch (err) {
      cb(err);
    }
  }

  touch(sid, sess, cb) {
    this.set(sid, sess, cb);
  }
}

export function createSessionMiddleware() {
  return session({
    store: new SqliteSessionStore(),
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    name: 'wa_baileys_sid',
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      maxAge: 7 * 24 * 60 * 60 * 1000,
    },
  });
}

export function publicUser(user) {
  if (!user) return null;
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    createdAt: user.created_at,
  };
}

export async function registerSuperAdmin({ email, password, name }) {
  if (userCount() > 0) {
    const err = new Error('Pendaftaran ditutup. Super admin sudah ada.');
    err.status = 403;
    throw err;
  }
  const passwordHash = await bcrypt.hash(password, 12);
  const user = createUser({
    id: crypto.randomUUID(),
    email: String(email).trim().toLowerCase(),
    passwordHash,
    name: String(name || email).trim(),
    role: 'super_admin',
  });
  return publicUser(user);
}

export async function loginUser({ email, password }) {
  const user = findUserByEmail(String(email).trim().toLowerCase());
  if (!user) {
    const err = new Error('Email atau password salah');
    err.status = 401;
    throw err;
  }
  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) {
    const err = new Error('Email atau password salah');
    err.status = 401;
    throw err;
  }
  return publicUser(user);
}

export function requireAuth(req, res, next) {
  if (!req.session?.userId) {
    return res.status(401).json({
      success: false,
      message: 'Unauthorized: silakan login',
    });
  }
  const user = findUserById(req.session.userId);
  if (!user) {
    req.session.destroy(() => {});
    return res.status(401).json({
      success: false,
      message: 'Unauthorized: sesi tidak valid',
    });
  }
  req.user = user;
  next();
}

export function requireSuperAdmin(req, res, next) {
  requireAuth(req, res, () => {
    if (req.user.role !== 'super_admin') {
      return res.status(403).json({
        success: false,
        message: 'Forbidden: hanya super admin',
      });
    }
    next();
  });
}

export function isRegistrationOpen() {
  return userCount() === 0;
}

export { SESSION_SECRET };
