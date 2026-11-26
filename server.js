
require('dotenv').config();

const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const path = require('path');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const session = require('express-session');
const MongoStore = require('connect-mongo');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = Number(process.env.PORT) || 3000;
const MONGODB_URI = process.env.MONGODB_URI;
const SESSION_SECRET = process.env.SESSION_SECRET;

app.disable('x-powered-by');

if (process.env.NODE_ENV === 'production') {
  app.set('trust proxy', 1);
}

// ==========================================
// SECURITY AND MIDDLEWARE
// ==========================================

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      ...helmet.contentSecurityPolicy.getDefaultDirectives(),
      'script-src': ["'self'", "'unsafe-inline'"],
      'style-src': ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      'img-src': ["'self'", 'data:', 'https:']
    }
  }
}));

app.use(express.urlencoded({
  extended: false,
  limit: '10kb'
}));

app.use(express.json({
  limit: '20kb'
}));

// Express 5 leaves req.body undefined when nothing was parsed; keep it an object
app.use((req, res, next) => {
  if (!req.body) req.body = {};
  next();
});

const applicationLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 5,
  standardHeaders: 'draft-8',
  legacyHeaders: false
});

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: {
    error: 'Too many sign-in attempts. Try again later.'
  }
});

const messageLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 30,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: {
    error: 'You are sending messages too quickly. Please wait.'
  }
});

// ==========================================
// DATABASE MODELS
// ==========================================

const UserSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
    trim: true,
    maxlength: 80
  },

  email: {
    type: String,
    required: true,
    unique: true,
    lowercase: true,
    trim: true
  },

  passwordHash: {
    type: String,
    required: true,
    select: false
  },

  role: {
    type: String,
    enum: ['student', 'teacher', 'principal', 'proprietor', 'proprietress', 'admin'],
    default: 'student'
  },

  className: {
    type: String,
    default: ''
  },

  active: {
    type: Boolean,
    default: true
  }
}, {
  timestamps: true
});

const ConversationSchema = new mongoose.Schema({
  title: {
    type: String,
    trim: true,
    maxlength: 80,
    default: ''
  },

  type: {
    type: String,
    enum: ['group', 'announcement', 'direct'],
    required: true
  },

  members: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  }],

  className: {
    type: String,
    default: ''
  },

  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },

  lastMessage: {
    type: String,
    default: ''
  },

  lastMessageAt: {
    type: Date,
    default: Date.now
  }
}, {
  timestamps: true
});

const MessageSchema = new mongoose.Schema({
  conversation: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Conversation',
    required: true,
    index: true
  },

  sender: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },

  body: {
    type: String,
    required: true,
    trim: true,
    maxlength: 1000
  }
}, {
  timestamps: true
});

MessageSchema.index({
  conversation: 1,
  createdAt: -1
});

const User = mongoose.model('User', UserSchema);
const Conversation = mongoose.model('Conversation', ConversationSchema);
const Message = mongoose.model('Message', MessageSchema);

// ==========================================
// SESSION CONFIGURATION
// ==========================================

if (!SESSION_SECRET || SESSION_SECRET.length < 32) {
  throw new Error('SESSION_SECRET must be at least 32 characters.');
}

if (!MONGODB_URI) {
  throw new Error('MONGODB_URI is missing.');
}

const sessionMiddleware = session({
  name: 'christower.sid',

  secret: SESSION_SECRET,

  resave: false,

  saveUninitialized: false,

  store: MongoStore.create({
    mongoUrl: MONGODB_URI,
    collectionName: 'sessions',
    ttl: 60 * 60 * 24 * 7
  }),

  cookie: {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 1000 * 60 * 60 * 8
  }
});

app.use(sessionMiddleware);
io.engine.use(sessionMiddleware);

// ==========================================
// GENERAL HELPERS
// ==========================================

function clean(value, max = 120) {
  return String(value || '').trim().slice(0, max);
}

function publicUser(user) {
  return {
    id: String(user._id),
    name: user.name,
    email: user.email,
    role: user.role,
    className: user.className || ''
  };
}

function validId(id) {
  return mongoose.isValidObjectId(id);
}

function requireAuth(req, res, next) {
  if (!req.session.userId) {
    return res.status(401).json({
      error: 'Please sign in to continue.'
    });
  }

  next();
}

async function getActiveUser(req) {
  if (!req.session.userId) return null;

  return User.findOne({
    _id: req.session.userId,
    active: true
  });
}

function requireRole(...roles) {
  return async (req, res, next) => {
    try {
      const user = await getActiveUser(req);

      if (!user) {
        return res.status(401).json({
          error: 'Your account is inactive or your session has expired.'
        });
      }

      if (!roles.includes(user.role)) {
        return res.status(403).json({
          error: 'You do not have permission to perform this action.'
        });
      }

      req.currentUser = user;
      next();
    } catch (error) {
      next(error);
    }
  };
}

const requireStaff = requireRole('teacher', 'principal', 'proprietor', 'proprietress', 'admin');
const requireAdmin = requireRole('admin');

function normalizeChannelKey(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function isTeachersCornerConversation(conversation) {
  return normalizeChannelKey(conversation?.title) === 'teacherscorner';
}

function isClassConversationForUser(user, conversation) {
  if (!user?.className || !conversation) return false;
  if (!['group', 'announcement'].includes(conversation.type)) return false;

  const userClass = normalizeChannelKey(user.className);
  const conversationClass = normalizeChannelKey(conversation.className);
  if (conversationClass && conversationClass === userClass) return true;

  // Older groups/notices may target a whole section (JSS/SSS),
  // while student accounts are assigned to individual classes (JSS 1/SS 2).
  if (conversationClass === 'jss' && userClass.startsWith('jss')) return true;
  if (conversationClass === 'sss' && userClass.startsWith('ss')) return true;

  // Support older class groups whose class is encoded in the title
  // (for example, "SS2 Students") instead of the className field.
  const title = normalizeChannelKey(conversation.title);
  return conversation.type === 'group' && Boolean(userClass && title.includes(userClass));
}

async function canAccessConversation(user, conversation) {
  if (!user || !conversation) return false;

  if (isTeachersCornerConversation(conversation)) {
    return user.role === 'teacher' || user.role === 'admin';
  }

  if (user.role === 'admin') return true;

  // Teachers need to see school groups and announcements created before
  // their account was added. Direct/private conversations remain member-only.
  if (user.role === 'teacher' && ['group', 'announcement'].includes(conversation.type)) {
    return true;
  }

  if (user.role === 'student' && isClassConversationForUser(user, conversation)) {
    return true;
  }

  return (conversation.members || []).some(member => {
    const memberId = member?._id || member;
    return String(memberId) === String(user._id);
  });
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, character => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  })[character]);
}

// ==========================================
// STATIC WEBSITE
// ==========================================

app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'Cis.html'));
});

// ==========================================
// EMAIL CONFIGURATION — BREVO HTTPS API
// Works on Render Free because it uses HTTPS, not SMTP ports.
// ==========================================

async function sendAdmissionEmail({ subject, text }) {
  const required = [
    'BREVO_API_KEY',
    'BREVO_SENDER_EMAIL',
    'SCHOOL_EMAIL'
  ];
  const missing = required.filter(key => !process.env[key]);

  if (missing.length) {
    throw new Error(`Missing email configuration: ${missing.join(', ')}`);
  }

  const response = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: {
      'accept': 'application/json',
      'api-key': process.env.BREVO_API_KEY,
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      sender: {
        name: 'Christower International School',
        email: process.env.BREVO_SENDER_EMAIL
      },
      to: [{ email: process.env.SCHOOL_EMAIL }],
      subject,
      textContent: text
    }),
    signal: AbortSignal.timeout(20000)
  });

  if (!response.ok) {
    const details = await response.text();
    // Do not print the API key or request headers to logs.
    throw new Error(`Brevo API returned ${response.status}: ${details.slice(0, 500)}`);
  }

  return response.json().catch(() => ({}));
}

const allowedClasses = new Set([
  'Nursery',
  'Primary',
  'JSS',
  'SSS',
  'JSS 1',
  'JSS 2',
  'JSS 3',
  'SS 1',
  'SS 2',
  'SS 3'
]);

function validPhone(phone) {
  return /^\+?[0-9][0-9\s()-]{7,18}$/.test(phone);
}

// ==========================================
// ADMISSIONS FORM
// ==========================================

app.post(
  '/submit-application',
  applicationLimiter,
  async (req, res) => {
    // The website form asks for JSON; a plain browser form post still gets redirected
    const wantsJson = String(req.get('accept') || '').includes('application/json');

    if (clean(req.body.website, 200)) {
      if (wantsJson) return res.json({ ok: true });
      return res.redirect(303, '/?application=success#apply');
    }

    const parentName = clean(req.body.parent_name, 100);
    const phone = clean(req.body.phone, 30);
    const childName = clean(req.body.child_name, 100);
    const age = Number(clean(req.body.child_age, 3));
    const classApplyingFor = clean(req.body.class_applying_for, 30);
    const message = clean(req.body.message, 1500);

    const errors = [];

    if (parentName.length < 2) {
      errors.push("Enter the parent or guardian's name.");
    }

    if (!validPhone(phone)) {
      errors.push('Enter a valid phone number.');
    }

    if (childName.length < 2) {
      errors.push("Enter the child's name.");
    }

    if (!Number.isInteger(age) || age < 2 || age > 18) {
      errors.push('Enter a valid child age between 2 and 18.');
    }

    if (!allowedClasses.has(classApplyingFor)) {
      errors.push('Select a valid class.');
    }

    if (errors.length) {
      if (wantsJson) return res.status(400).json({ ok: false, errors });

      return res.status(400).send(`
        <!DOCTYPE html>
        <html lang="en">
        <head>
          <meta charset="UTF-8">
          <title>Check your application</title>
        </head>
        <body>
          <h1>Please check your details</h1>
          <ul>
            ${errors.map(error => `<li>${escapeHtml(error)}</li>`).join('')}
          </ul>
          <a href="/#apply">Return to application form</a>
        </body>
        </html>
      `);
    }

    try {
      await sendAdmissionEmail({
        subject: 'New school admission enquiry',
        text: [
          'New admission enquiry — Christower International School',
          '',
          `Parent/guardian: ${parentName}`,
          `Phone: ${phone}`,
          `Child: ${childName}`,
          `Child age: ${age}`,
          `Class: ${classApplyingFor}`,
          '',
          'Message:',
          message || '(No additional message)'
        ].join('\n')
      });

      if (wantsJson) return res.json({ ok: true });
      return res.redirect(303, '/?application=success#apply');
    } catch (error) {
      console.error('Application email failed:', error.message);
      if (wantsJson) return res.status(502).json({ ok: false });
      return res.redirect(303, '/?application=error#apply');
    }
  }
);

// ==========================================
// AUTHENTICATION
// ==========================================

app.post('/api/auth/login', authLimiter, async (req, res, next) => {
  try {
    const email = clean(req.body.email, 160).toLowerCase();
    const password = String(req.body.password || '');

    if (!email || !password || password.length > 200) {
      return res.status(400).json({
        error: 'Enter your school email and password.'
      });
    }

    const user = await User.findOne({
      email
    }).select('+passwordHash');

    if (
      !user ||
      !user.active ||
      !(await bcrypt.compare(password, user.passwordHash))
    ) {
      return res.status(401).json({
        error: 'Email or password is incorrect.'
      });
    }

    await new Promise((resolve, reject) => {
      req.session.regenerate(error => {
        if (error) reject(error);
        else resolve();
      });
    });

    req.session.userId = String(user._id);

    await new Promise((resolve, reject) => {
      req.session.save(error => {
        if (error) reject(error);
        else resolve();
      });
    });

    res.json({
      success: true,
      user: publicUser(user)
    });

  } catch (error) {
    next(error);
  }
});

app.get('/api/auth/me', requireAuth, async (req, res, next) => {
  try {
    const user = await getActiveUser(req);

    if (!user) {
      return req.session.destroy(() => {
        res.clearCookie('christower.sid');
        res.status(401).json({
          error: 'Account is inactive.'
        });
      });
    }

    res.json({
      success: true,
      user: publicUser(user)
    });

  } catch (error) {
    next(error);
  }
});

app.post('/api/auth/logout', requireAuth, (req, res) => {
  req.session.destroy(error => {
    if (error) {
      return res.status(500).json({
        error: 'Unable to sign out.'
      });
    }

    res.clearCookie('christower.sid');

    res.json({
      success: true
    });
  });
});

// ==========================================
// ADMIN ACCOUNT MANAGEMENT
// ==========================================

app.post('/api/admin/users', requireAdmin, async (req, res, next) => {
  try {
    const name = clean(req.body.name, 80);
    const email = clean(req.body.email, 160).toLowerCase();
    const password = String(req.body.password || '');

    const allowedRoles = ['student', 'teacher', 'principal', 'proprietor', 'proprietress'];
    const role = allowedRoles.includes(req.body.role)
      ? req.body.role
      : 'student';

    const className = clean(req.body.className, 30);

    if (
      name.length < 2 ||
      !/^\S+@\S+\.\S+$/.test(email) ||
      password.length < 12 ||
      password.length > 200
    ) {
      return res.status(400).json({
        error: 'Provide a valid name, email and password of at least 12 characters.'
      });
    }

    if (['student', 'teacher'].includes(role) && !className) {
      return res.status(400).json({
        error: role === 'teacher' ? 'Set the teacher class.' : 'Set the student class.'
      });
    }

    const user = await User.create({
      name,
      email,
      passwordHash: await bcrypt.hash(password, 12),
      role,
      className
    });

    res.status(201).json({
      success: true,
      user: publicUser(user)
    });

  } catch (error) {
    if (error.code === 11000) {
      return res.status(409).json({
        error: 'That email already has an account.'
      });
    }

    next(error);
  }
});

app.get('/api/admin/users', requireAdmin, async (req, res, next) => {
  try {
    const users = await User.find().sort({ name: 1 });

    res.json({
      users: users.map(publicUser)
    });

  } catch (error) {
    next(error);
  }
});

app.patch(
  '/api/admin/users/:id/status',
  requireAdmin,
  async (req, res, next) => {
    try {
      if (!validId(req.params.id)) {
        return res.status(400).json({
          error: 'Invalid account ID.'
        });
      }

      if (typeof req.body.active !== 'boolean') {
        return res.status(400).json({
          error: 'Provide a valid account status.'
        });
      }

      const user = await User.findByIdAndUpdate(
        req.params.id,
        { active: req.body.active },
        { new: true, runValidators: true }
      );

      if (!user) {
        return res.status(404).json({
          error: 'Account not found.'
        });
      }

      res.json({
        success: true,
        user: publicUser(user)
      });

    } catch (error) {
      next(error);
    }
  }
);

// ==========================================
// SCHOOL USER DIRECTORY
// ==========================================

app.get(
  '/api/users',
  requireAuth,
  async (req, res, next) => {
    try {
      const currentUser = await getActiveUser(req);

      if (!currentUser) {
        return res.status(401).json({
          error: 'Account is inactive.'
        });
      }

      const users = await User.find({
        active: true,
        _id: { $ne: currentUser._id }
      })
        .select('name role className')
        .sort({ name: 1 })
        .limit(200);

      res.json({
        users: users.map(user => ({
          id: String(user._id),
          name: user.name,
          role: user.role,
          className: user.className || ''
        }))
      });

    } catch (error) {
      next(error);
    }
  }
);

// ==========================================
// CONVERSATION LIST
// ==========================================

app.get('/api/conversations', requireAuth, async (req, res, next) => {
  try {
    const user = await getActiveUser(req);

    if (!user) {
      return res.status(401).json({
        error: 'Account is inactive.'
      });
    }

    // Ensure the shared Teachers' Corner exists before teachers/admins
    // request their inbox. The sidebar shortcut cannot open a channel that
    // has never been created in MongoDB.
    if (user.role === 'teacher' || user.role === 'admin') {
      await Conversation.findOneAndUpdate(
        { title: "Teachers' Corner", type: 'group' },
        {
          $setOnInsert: {
            title: "Teachers' Corner",
            type: 'group',
            members: [],
            createdBy: user._id,
            lastMessage: '',
            lastMessageAt: new Date()
          }
        },
        { upsert: true, new: true, setDefaultsOnInsert: true }
      );
    }

    const classKey = normalizeChannelKey(user.className);
    const classTitlePattern = classKey
      ? new RegExp(classKey.split('').map(char => char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[\\s._-]*'), 'i')
      : null;
    const broadClassNames = user.role === 'student'
      ? (classKey.startsWith('jss') ? ['JSS'] : classKey.startsWith('ss') ? ['SSS'] : [])
      : [];

    const query = user.role === 'admin'
      ? {}
      : user.role === 'teacher'
        ? {
            $or: [
              { members: user._id },
              { type: { $in: ['group', 'announcement'] } },
              { title: /^teachers'?\s*corner$/i }
            ]
          }
        : user.role === 'student'
          ? {
              $or: [
                { members: user._id },
                ...(user.className ? [{ className: user.className }] : []),
                ...broadClassNames.map(className => ({ className })),
                ...(classTitlePattern ? [
                  { type: 'group', title: classTitlePattern },
                  { type: 'group', className: classTitlePattern }
                ] : [])
              ]
            }
          : { members: user._id };

    const conversations = await Conversation.find(query)
      .populate('members', 'name role className active')
      .populate('createdBy', 'name role')
      .sort({ lastMessageAt: -1 })
      .lean();

    // Teachers and admins can see Teachers' Corner; students cannot.
    const visibleConversations = conversations.filter(conversation =>
      !isTeachersCornerConversation(conversation) ||
      user.role === 'teacher' || user.role === 'admin'
    );

    const result = visibleConversations.map(conversation => {
      const members = (conversation.members || [])
        .filter(member => member && member.active !== false)
        .map(member => ({
          id: String(member._id),
          name: member.name,
          role: member.role,
          className: member.className || ''
        }));

      const otherMember = members.find(member =>
        member.id !== String(user._id)
      );

      let title = conversation.title || '';

      if (conversation.type === 'direct') {
        title = otherMember?.name || 'Private conversation';
      }

      return {
        id: String(conversation._id),
        title,
        type: conversation.type,
        className: conversation.className || '',
        createdBy: conversation.createdBy
          ? {
              id: String(conversation.createdBy._id),
              name: conversation.createdBy.name,
              role: conversation.createdBy.role
            }
          : null,
        members,
        memberCount: members.length,
        lastMessage: conversation.lastMessage || '',
        lastMessageAt: conversation.lastMessageAt
      };
    });

    res.json({
      success: true,
      conversations: result
    });

  } catch (error) {
    next(error);
  }
});

// ==========================================
// CREATE GROUPS AND ANNOUNCEMENTS
// ==========================================

app.post(
  '/api/conversations/groups',
  requireStaff,
  async (req, res, next) => {
    try {
      const title = clean(req.body.title, 80);

      const type = req.body.type === 'announcement'
        ? 'announcement'
        : 'group';

      const className = clean(req.body.className, 30);

      if (title.length < 2) {
        return res.status(400).json({
          error: 'Enter a channel name.'
        });
      }

      if (className && !allowedClasses.has(className)) {
        return res.status(400).json({
          error: 'Invalid class.'
        });
      }

      const members = await User.find({
        active: true,
        ...(className ? { className } : {})
      }).select('_id');

      const memberIds = members.map(member => member._id);

      // Always include the staff member creating the conversation.
      if (!memberIds.some(id =>
        String(id) === String(req.currentUser._id)
      )) {
        memberIds.push(req.currentUser._id);
      }

      const conversation = await Conversation.create({
        title,
        type,
        className,
        members: memberIds,
        createdBy: req.currentUser._id
      });

      res.status(201).json({
        success: true,
        conversation: {
          id: String(conversation._id),
          title: conversation.title,
          type: conversation.type,
          className: conversation.className
        }
      });

    } catch (error) {
      next(error);
    }
  }
);

// ==========================================
// CREATE PRIVATE CONVERSATION
// ==========================================

app.post(
  '/api/conversations/direct',
  requireAuth,
  async (req, res, next) => {
    try {
      const currentUser = await getActiveUser(req);

      if (!currentUser) {
        return res.status(401).json({
          error: 'Account is inactive.'
        });
      }

      const otherId = req.body.userId;

      if (!validId(otherId)) {
        return res.status(400).json({
          error: 'Select a valid school account.'
        });
      }

      const other = await User.findOne({
        _id: otherId,
        active: true
      });

      if (!other) {
        return res.status(404).json({
          error: 'School account not found.'
        });
      }

      if (String(other._id) === String(currentUser._id)) {
        return res.status(400).json({
          error: 'You cannot start a conversation with yourself.'
        });
      }

      const ids = [
        String(currentUser._id),
        String(other._id)
      ].sort();

      let conversation = await Conversation.findOne({
        type: 'direct',
        members: {
          $all: ids,
          $size: 2
        }
      });

      if (!conversation) {
        conversation = await Conversation.create({
          type: 'direct',
          title: '',
          members: ids,
          createdBy: currentUser._id
        });
      }

      res.status(200).json({
        success: true,
        conversation: {
          id: String(conversation._id),
          type: 'direct',
          title: other.name
        }
      });

    } catch (error) {
      next(error);
    }
  }
);

// ==========================================
// LOAD MESSAGES
// ==========================================

app.get(
  '/api/conversations/:id/messages',
  requireAuth,
  async (req, res, next) => {
    try {
      if (!validId(req.params.id)) {
        return res.status(400).json({
          error: 'Invalid conversation ID.'
        });
      }

      const user = await getActiveUser(req);

      if (!user) {
        return res.status(401).json({
          error: 'Account is inactive.'
        });
      }

      const conversation = await Conversation.findById(
        req.params.id
      );

      if (!(await canAccessConversation(user, conversation))) {
        return res.status(404).json({
          error: 'Conversation not found.'
        });
      }

      const messages = await Message.find({
        conversation: conversation._id
      })
        .sort({ createdAt: -1 })
        .limit(100)
        .populate('sender', 'name role');

      messages.reverse();

      res.json({
        success: true,
        messages: messages.map(message => ({
          id: String(message._id),
          conversationId: String(conversation._id),
          body: message.body,
          createdAt: message.createdAt,
          sender: message.sender
            ? {
                id: String(message.sender._id),
                name: message.sender.name,
                role: message.sender.role
              }
            : {
                id: '',
                name: 'Unknown user',
                role: 'student'
              }
        }))
      });

    } catch (error) {
      next(error);
    }
  }
);

// ==========================================
// SEND MESSAGE
// ==========================================

app.post(
  '/api/conversations/:id/messages',
  requireAuth,
  messageLimiter,
  async (req, res, next) => {
    try {
      if (!validId(req.params.id)) {
        return res.status(400).json({
          error: 'Invalid conversation ID.'
        });
      }

      const user = await getActiveUser(req);

      if (!user) {
        return res.status(401).json({
          error: 'Account is inactive.'
        });
      }

      const conversation = await Conversation.findById(
        req.params.id
      );

      if (!(await canAccessConversation(user, conversation))) {
        return res.status(404).json({
          error: 'Conversation not found.'
        });
      }

      if (
        conversation.type === 'announcement' &&
        !['teacher', 'admin'].includes(user.role)
      ) {
        return res.status(403).json({
          error: 'Only school staff can post announcements.'
        });
      }

      const body = clean(req.body.body, 1000);

      if (!body) {
        return res.status(400).json({
          error: 'Message cannot be empty.'
        });
      }

      const message = await Message.create({
        conversation: conversation._id,
        sender: user._id,
        body
      });

      conversation.lastMessage = body;
      conversation.lastMessageAt = message.createdAt;

      await conversation.save();

      const payload = {
        id: String(message._id),
        conversationId: String(conversation._id),
        body: message.body,
        createdAt: message.createdAt,
        sender: {
          id: String(user._id),
          name: user.name,
          role: user.role
        }
      };

      // Deliver the saved message to all connected members
      // who have joined this conversation's Socket.IO room.
      io.to(String(conversation._id)).emit(
        'message:new',
        payload
      );

      // Notify connected clients to refresh their own permitted inboxes.
      // Do not broadcast the announcement body: class-targeted notices
      // must remain visible only to their conversation members.
      if (conversation.type === 'announcement') {
        io.emit('announcements:refresh');
      }

      res.status(201).json({
        success: true,
        message: payload
      });

    } catch (error) {
      next(error);
    }
  }
);

// ==========================================
// SOCKET.IO AUTHENTICATION
// ==========================================

io.use(async (socket, next) => {
  try {
    const userId = socket.request.session?.userId;

    if (!userId) {
      return next(new Error('Authentication required.'));
    }

    const user = await User.findOne({
      _id: userId,
      active: true
    });

    if (!user) {
      return next(new Error('Account unavailable.'));
    }

    socket.user = user;

    next();

  } catch (error) {
    next(error);
  }
});

// ==========================================
// SOCKET.IO CONNECTIONS
// ==========================================

io.on('connection', socket => {
  console.log(
    `Communication connected: ${socket.user.name}`
  );

  socket.on('conversation:join', async conversationId => {
    try {
      if (
        typeof conversationId !== 'string' ||
        !validId(conversationId)
      ) {
        return;
      }

      const conversation = await Conversation.findById(
        conversationId
      );

      const allowed = await canAccessConversation(
        socket.user,
        conversation
      );

      if (!allowed) {
        return;
      }

      socket.join(String(conversation._id));

      socket.emit('conversation:joined', {
        conversationId: String(conversation._id)
      });

    } catch (error) {
      console.error(
        'Socket join error:',
        error.message
      );
    }
  });

  socket.on('disconnect', () => {
    console.log(
      `Communication disconnected: ${socket.user.name}`
    );
  });
});

// ==========================================
// HEALTH CHECK
// ==========================================

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',

    database:
      mongoose.connection.readyState === 1
        ? 'connected'
        : 'disconnected',

    communication: 'enabled'
  });
});

// ==========================================
// ERROR HANDLING
// ==========================================

app.use((err, req, res, next) => {
  console.error('Server error:', err.message);

  if (res.headersSent) {
    return next(err);
  }

  if (err.name === 'CastError') {
    return res.status(400).json({
      error: 'Invalid ID supplied.'
    });
  }

  if (err.name === 'ValidationError') {
    return res.status(400).json({
      error: 'Please check the information you submitted.'
    });
  }

  res.status(500).json({
    error: 'Something went wrong. Please try again later.'
  });
});

// ==========================================
// START SERVER
// ==========================================

async function start() {
  await mongoose.connect(MONGODB_URI);

  console.log('Connected to MongoDB.');

  const adminEmail = clean(
    process.env.ADMIN_EMAIL,
    160
  ).toLowerCase();

  const adminPassword = String(
    process.env.ADMIN_PASSWORD || ''
  );

  if (adminEmail && adminPassword.length >= 12) {
    const existingAdmin = await User.findOne({
      email: adminEmail
    });

    if (!existingAdmin) {
      await User.create({
        name: clean(
          process.env.ADMIN_NAME || 'School Administrator',
          80
        ),

        email: adminEmail,

        passwordHash: await bcrypt.hash(
          adminPassword,
          12
        ),

        role: 'admin',
        active: true
      });

      console.log('Initial administrator account created.');
    } else {
      console.log(
        'Administrator account already exists. Existing password unchanged.'
      );
    }
  }

  const missingEmailSettings = [
    'BREVO_API_KEY',
    'BREVO_SENDER_EMAIL',
    'SCHOOL_EMAIL'
  ].filter(key => !process.env[key]);

  if (missingEmailSettings.length) {
    console.warn(
      `Admission email is not configured. Missing: ${missingEmailSettings.join(', ')}`
    );
  } else {
    console.log('Brevo admission email configuration detected.');
  }

  server.listen(PORT, () => {
    console.log(
      `Christower website running on port ${PORT}`
    );

    console.log(
      `Local address: http://localhost:${PORT}`
    );
  });
}

start().catch(error => {
  console.error('Startup failed:', error.message);
  process.exit(1);
});
