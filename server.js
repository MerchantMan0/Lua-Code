require('dotenv').config()
const express = require('express')
const bodyParser = require('body-parser')
const cors = require('cors')
const { MongoClient, ObjectId } = require('mongodb')
const { processSubmissionEvaluation } = require('./lib/submissionEvaluation')
const { COLLECTION_CHALLENGES, COLLECTION_SUBMISSIONS } = require('./lib/challengeSchema')

const bcrypt = require('bcrypt')
const jwt = require('jsonwebtoken')
const nodemailer = require('nodemailer')
const crypto = require('crypto')

const url = process.env.MONGODB_URI

const client = new MongoClient(url, {
  dbName: process.env.MONGODB_DB || 'Large-Project',
})

function mongoDb() {
  return client.db(process.env.MONGODB_DB || undefined)
}

function iso(d) {
  return d instanceof Date && !Number.isNaN(d.getTime()) ? d.toISOString() : null
}

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex')
}

async function buildLeaderboard(coll, matchFilter, metric, sort, page, pageSize, search) {
  const skip = (page - 1) * pageSize
 
  const pipeline = [
    { $match: { ...matchFilter, status: 'accepted' } },
    //sort by metric first, then submitted at for tie-breaking
    { $sort: { [`metrics.${metric}`]: sort, submitted_at: 1 } },
    { $group: {
      _id:           '$user_id',
      submission_id: { $first: '$_id' },
      display_name:  { $first: '$display_name' },
      metrics:       { $first: '$metrics' },
      submitted_at:  { $first: '$submitted_at' },
    }},
    //after grouping, resort
    { $sort: { [`metrics.${metric}`]: sort, submitted_at: 1 } },
  ]
 
  const allRows = await coll.aggregate(pipeline).toArray()
 
  //assign in memory
  //two users tied at rank 1 means next user is rank 3
  const ranked = []
  let currentRank = 1
  for (let i = 0; i < allRows.length; i++) {
    const row = allRows[i]
    const prev = allRows[i - 1]
 
    //tie logic
    const isTie = prev &&
      normalizeMetrics(row.metrics)[metric] === normalizeMetrics(prev.metrics)[metric] &&
      iso(row.submitted_at) === iso(prev.submitted_at)
 
    if (!isTie) currentRank = i + 1
 
    ranked.push({
      rank:          currentRank,
      submission_id: row.submission_id.toHexString(),
      user:          { id: row._id, display_name: row.display_name || row._id },
      metrics:       normalizeMetrics(row.metrics),
      submitted_at:  iso(row.submitted_at),
    })
  }
 
  const filtered = search ? ranked.filter(item => {
    const numeric = parseFloat(search)
    const nameMatch = item.user.display_name.toLowerCase().includes(search.toLowerCase())
    const metricMatch = !isNaN(numeric) && (
      item.metrics.gas          === numeric ||
      item.metrics.memory_bytes === numeric ||
      item.metrics.lines        === numeric
    )
    return nameMatch || metricMatch
  }) : ranked
 
  const total = filtered.length
  const items = filtered.slice(skip, skip + pageSize)
 
  return { items, total }
}

function normalizeMetrics(m) {
  const x = m && typeof m === 'object' ? m : {}
  return {
    gas: typeof x.gas === 'number' ? x.gas : 0,
    memory_bytes: typeof x.memory_bytes === 'number' ? x.memory_bytes : 0,
    lines: typeof x.lines === 'number' ? x.lines : 0,
  }
}

function submissionToApiDetail(doc) {
  return {
    id: doc._id.toHexString(),
    challenge_id: doc.challenge_id,
    user_id: doc.user_id,
    language: doc.language,
    status: doc.status,
    submitted_at: iso(doc.submitted_at),
    evaluated_at: doc.evaluated_at ? iso(doc.evaluated_at) : null,
    metrics: normalizeMetrics(doc.metrics),
    console: Array.isArray(doc.console) ? doc.console : [],
  }
}

function submissionToApiListItem(doc) {
  return {
    id: doc._id.toHexString(),
    challenge_id: doc.challenge_id,
    user_id: doc.user_id,
    display_name: doc.display_name != null ? String(doc.display_name) : 'unknown',
    language: doc.language,
    status: doc.status,
    submitted_at: iso(doc.submitted_at),
    metrics: normalizeMetrics(doc.metrics),
  }
}

//mailer setup
const transporter = nodemailer.createTransport({
  host:   process.env.SMTP_HOST,
  port:   parseInt(process.env.SMTP_PORT || '587', 10),
  secure: parseInt(process.env.SMTP_PORT || '587', 10) === 465,
  auth:   { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
})

async function sendVerificationEmail(toEmail, token) {
  if (!process.env.SMTP_HOST) return
  const link = `${process.env.APP_URL}/auth/verify-email?token=${token}`
  await transporter.sendMail({
    from:    process.env.EMAIL_FROM || process.env.SMTP_USER,
    to:      toEmail,
    subject: 'Verify your email',
    html:    `<h2>Welcome!</h2><p>Verify your email (expires in 24h):</p><a href="${link}">${link}</a>`,
  })
}
 
async function sendPasswordResetEmail(toEmail, token) {//work on
  if (!process.env.SMTP_HOST) return
  const link = `${process.env.FRONTEND_URL || process.env.APP_URL}/reset-password?token=${token}`
  await transporter.sendMail({
    from:    process.env.EMAIL_FROM || process.env.SMTP_USER,
    to:      toEmail,
    subject: 'Reset your password',
    html:    `<h2>Password Reset</h2><p>Reset your password (expires in 1h):</p><a href="${link}">${link}</a><p>If you did not request this, ignore this email.</p>`,
  })
}

const rateLimitStore = new Map()

//true if allowed, false if rate limited
function checkRateLimit(key, limit, windowMs) {
  const now = Date.now()
  const entry = rateLimitStore.get(key)
  if (!entry || now - entry.windowStart > windowMs) {
    rateLimitStore.set(key, { count: 1, windowStart: now })
    return true
  }
  if (entry.count >= limit) return false
  entry.count++
  return true
}

const app = express()
app.use(cors())
app.use(bodyParser.json())
app.use(bodyParser.urlencoded({ extended: true }))

const api = express.Router()
app.use('/api', api)

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader(
    'Access-Control-Allow-Headers',
    'Origin, X-Requested-With, Content-Type, Accept, Authorization',
  )
  res.setHeader(
    'Access-Control-Allow-Methods',
    'GET, POST, PATCH, DELETE, OPTIONS',
  )
  next()
})

//jwt
async function requireBearer(req, res, next) {
  const auth = req.headers.authorization
  if (!auth || !String(auth).startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Bearer token required' })
  }

  const token = auth.slice(7)

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET)

    const db = mongoDb()

    //check denylist
    const denied = await db.collection('token_denylist').findOne({ token })
    if (denied) {
      return res.status(401).json({ error: 'Token revoked' })
    }

    //check password change invalidation
    const user = await db.collection('users').findOne({ _id: new ObjectId(decoded.id) })
    if (!user) {
      return res.status(401).json({ error: 'User not found' })
    }

    if (user.password_changed_at) {
      const tokenIssuedAt = decoded.iat * 1000
      if (tokenIssuedAt < new Date(user.password_changed_at).getTime()) {
        return res.status(401).json({ error: 'Token expired due to password change' })
      }
    }

    req.user = decoded
    next()
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' })
  }
}

function parseListPagination(query) {
  const page = Math.max(1, parseInt(query.page, 10) || 1)
  const pageSize = Math.min(100, Math.max(1, parseInt(query.page_size, 10) || 20))
  return { page, pageSize }
}

function challengeToApiListItem(doc) {
  const id = doc && doc.id != null ? String(doc.id) : ''
  if (!id) return null
  const item = {
    id,
    title: doc.title != null ? String(doc.title) : id,
    week: typeof doc.week === 'number' && Number.isFinite(doc.week) ? doc.week : 1,
    status: doc.status != null ? String(doc.status) : 'open',
  }
  return item
}

/** Same shape as GET /challenges/current */
function staticChallengeDetail(challengeId) {
  return {
    id: challengeId,
    title: 'Hardest Challenge',
    description: 'Mock challenge description.',
    week: 1,
    status: 'open',
    opens_at: '9999-9-1T00:00:00.000Z',
    closes_at: '9999-9-30T23:59:59.000Z',
    timeout_ms: 30000,
  }
}

function challengeToApiDetail(doc) {
  return {
    id:          doc.id != null ? String(doc.id) : doc._id.toHexString(),
    title:       doc.title != null ? String(doc.title) : '',
    description: doc.description != null ? String(doc.description) : '',
    week:        typeof doc.week === 'number' ? doc.week : 1,
    status:      doc.status != null ? String(doc.status) : 'open',
    opens_at:    doc.opens_at ? iso(new Date(doc.opens_at)) : null,
    closes_at:   doc.closes_at ? iso(new Date(doc.closes_at)) : null,
    timeout_ms:  typeof doc.timeout_ms === 'number' ? doc.timeout_ms : 15000,
  }
}

/** Same shape as GET /challenges/{challenge_id}/leaderboard */
function staticLeaderboard(query) {
  const { page, pageSize } = parseListPagination(query)
  void (query.sort === 'desc' ? 'desc' : 'asc')
  void (['gas', 'memory_bytes', 'lines'].includes(query.metric)
    ? query.metric
    : 'gas')
  return {
    items: [
      {
        rank: 1,
        submission_id: 'submission_1',
        user: { id: 'usr_mocked', display_name: 'Mockable User' },
        metrics: { gas: 1, memory_bytes: 11, lines: 111 },
        submitted_at: '9999-9-9T12:00:00.000Z',
      },
      {
        rank: 2,
        submission_id: 'submission_2',
        user: { id: 'second_usr_mocked', display_name: 'Another Mockable User' },
        metrics: { gas: 2, memory_bytes: 22, lines: 222 },
        submitted_at: '9999-9-8T12:00:00.000Z',
      },
    ],
    page,
    page_size: pageSize,
    total: 2,
  }
}

//should work
api.post('/auth/register', async (req, res) => {
  try {
    const { email, password, username } = req.body
 
    if (!email || typeof email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: 'valid email is required' })
    }
    if (!password || typeof password !== 'string' || password.length < 8) {
      return res.status(400).json({ error: 'password must be at least 8 characters' })
    }
 
    const users = mongoDb().collection('users')
    const existing = await users.findOne({ email: email.toLowerCase() })
    if (existing) {
      return res.status(409).json({ error: 'email already registered' })
    }
 
    const hashedPassword        = await bcrypt.hash(password, 12)
    const verificationToken     = crypto.randomBytes(32).toString('hex')
    const verificationExpiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000)
 
    const result = await users.insertOne({
      email:                   email.toLowerCase(),
      password:                hashedPassword,
      username:                username || 'new_user',
      email_verified:          false,
      verification_token:      verificationToken,
      verification_expires_at: verificationExpiresAt,
    })
 
    try {
      await sendVerificationEmail(email, verificationToken)
    } catch (mailErr) {
      console.error('sendVerificationEmail failed:', mailErr)
    }
 
    return res.status(201).json({
      user_id: result.insertedId.toString(),
      message: 'Registered successfully. Check your email to verify your account.',
    })
  } catch (err) {
    console.error('POST /auth/register error:', err)
    return res.status(500).json({ error: 'Internal server error' })
  }
})

//verify email
api.get('/auth/verify-email', async (req, res) => {
  try {
    const { token } = req.query
    if (!token) return res.status(400).json({ error: 'token is required' })
 
    const users = mongoDb().collection('users')
    const user  = await users.findOne({ verification_token: token })
 
    //token not found
    if (!user) {
      // check for verified user
      return res.status(400).json({ error: 'Invalid or expired verification token. If you already verified, try logging in.' })
    }
 
    //already verified case
    if (user.email_verified) {
      return res.status(200).json({ message: 'Email already verified. You can log in.' })
    }
 
    // Token expired
    if (new Date() > new Date(user.verification_expires_at)) {
      return res.status(400).json({ error: 'Verification token has expired. Please request a new one.' })
    }
 
    //checks passed
    const updateResult = await users.updateOne(
      //update if token not expired, and user not verified
      { _id: user._id, verification_token: token, email_verified: false },
      { $set: { email_verified: true }, $unset: { verification_token: '', verification_expires_at: '' } },
    )
 
    if (updateResult.modifiedCount === 0) {
      //race condition (lol os and distributed prll knowledge)
      return res.status(200).json({ message: 'Email verified. You can now log in.' })
    }
 
    return res.status(200).json({ message: 'Email verified. You can now log in.' })
  } catch (err) {
    console.error('GET /auth/verify-email error:', err)
    return res.status(500).json({ error: 'Internal server error' })
  }
})

//resend
api.post('/auth/resend-verification', async (req, res) => {
  try {
    const { email } = req.body
    if (!email) return res.status(400).json({ error: 'email is required' })
 
    //rate limit 3 attempts per email per hr
    if (!checkRateLimit(`resend:${email.toLowerCase()}`, 3, 60 * 60 * 1000)) {
      return res.status(429).json({ error: 'Too many requests. Please wait before requesting another verification email.' })
    }
 
    const users = mongoDb().collection('users')
    const user  = await users.findOne({ email: email.toLowerCase() })
 
    // Always return 200 — don't reveal whether email exists
    if (!user || user.email_verified) {
      return res.status(200).json({ message: 'If that email exists and is unverified, a new verification email has been sent.' })
    }
 
    const verificationToken     = crypto.randomBytes(32).toString('hex')
    const verificationExpiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000)
 
    await users.updateOne(
      { _id: user._id },
      { $set: { verification_token: verificationToken, verification_expires_at: verificationExpiresAt } },
    )
 
    try {
      await sendVerificationEmail(user.email, verificationToken)
    } catch (mailErr) {
      console.error('resend sendVerificationEmail failed:', mailErr)
      return res.status(500).json({ error: 'Failed to send email. Check your SMTP config.' })
    }
 
    return res.status(200).json({ message: 'If that email exists and is unverified, a new verification email has been sent.' })
  } catch (err) {
    console.error('POST /auth/resend-verification error:', err)
    return res.status(500).json({ error: 'Internal server error' })
  }
})

api.post('/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body
    if (!email || !password) {
      return res.status(400).json({ error: 'email and password are required' })
    }
 
    const users = mongoDb().collection('users')
    const user  = await users.findOne({ email: email.toLowerCase() })
 
    //run bcrypt, prevent timing attacks
    const dummy = '$2b$12$invalidhashfortimingprotection000000000000000000000000'
    const match = await bcrypt.compare(password, user ? user.password : dummy)
 
    if (!user || !match) {
      return res.status(401).json({ error: 'Invalid email or password' })
    }
    if (!user.email_verified) {
      return res.status(403).json({ error: 'Email not verified. Check your inbox.' })
    }
 
    const access_token = jwt.sign(
      { id: user._id.toString(), email: user.email, username: user.username },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES || '7d' },
    )
 
    return res.status(200).json({ access_token, token_type: 'Bearer', expires_in: 604800 })
  } catch (err) {
    console.error('POST /auth/login error:', err)
    return res.status(500).json({ error: 'Internal server error' })
  }
})

//works
api.post('/auth/logout', requireBearer, async (req, res) => {
  try {
    const token = req.headers.authorization.slice(7)
    await mongoDb().collection('token_denylist').insertOne({
      token,
      user_id:    req.user.id,
      revoked_at: new Date(),
      expires_at: new Date(req.user.exp * 1000),
    })
    res.status(200).json({ message: 'Logged out' })
  } catch (err) {
    console.error('POST /auth/logout error:', err)
    return res.status(500).json({ error: 'Internal server error' })
  }
})

//updated
api.post('/auth/forgot-password', async (req, res) => {
  try {
    const { email } = req.body
    if (!email) return res.status(400).json({ error: 'email is required' })

    if (!checkRateLimit(`reset:${email.toLowerCase()}`, 3, 60 * 60 * 1000)) {
      return res.status(429).json({ error: 'Too many requests. Please wait before requesting another reset email.' })
    }

    const users = mongoDb().collection('users')
    const user  = await users.findOne({ email: email.toLowerCase() })

    if (user) {
      const rawToken = crypto.randomBytes(32).toString('hex')
      const hashedToken = hashToken(rawToken)

      const resetExpiresAt = new Date(Date.now() + 60 * 60 * 1000)

      await users.updateOne(
        { _id: user._id },
        {
          $set: {
            reset_token: hashedToken,
            reset_expires_at: resetExpiresAt,
          },
        },
      )

      try {
        await sendPasswordResetEmail(user.email, rawToken)//raw token
      } catch (mailErr) {
        console.error('sendPasswordResetEmail failed:', mailErr)
      }
    }

    return res.status(200).json({
      message: 'If that email exists, a reset link has been sent.',
    })
  } catch (err) {
    console.error('POST /auth/forgot-password error:', err)
    return res.status(500).json({ error: 'Internal server error' })
  }
})
 
api.post('/auth/reset-password', async (req, res) => {
  try {
    const { token, new_password } = req.body

    if (!token || !new_password || new_password.length < 8) {
      return res.status(400).json({ error: 'token and new_password (min 8 chars) are required' })
    }

    const users = mongoDb().collection('users')

    const hashedToken = hashToken(token)
    const hashedPassword = await bcrypt.hash(new_password, 12)

    const result = await users.updateOne(
      {
        reset_token: hashedToken,
        reset_expires_at: { $gt: new Date() },
      },
      {
        $set: {
          password: hashedPassword,
          password_changed_at: new Date(),
        },
        $unset: {
          reset_token: '',
          reset_expires_at: '',
        },
      },
    )

    if (result.modifiedCount === 0) {
      return res.status(400).json({ error: 'Invalid or expired reset token' })
    }

    return res.status(200).json({
      message: 'Password reset successfully. You can now log in.',
    })
  } catch (err) {
    console.error('POST /auth/reset-password error:', err)
    return res.status(500).json({ error: 'Internal server error' })
  }
})

api.get('/challenges/current', async (req, res) => {
  try {
    const coll = mongoDb().collection(COLLECTION_CHALLENGES)
    //try to find open challenge, or go to most recent
    const doc = await coll.findOne(
      { status: 'open' },
      { sort: { week: -1 } },
    )
    if (!doc) return res.status(404).json({ error: 'No current challenge found' })
    return res.status(200).json(challengeToApiDetail(doc))
  } catch (e) {
    console.error('GET /challenges/current error:', e)
    return res.status(503).json({ error: 'database_unavailable' })
  }
})

api.get('/challenges', requireBearer, async (req, res) => {
  const { page, pageSize } = parseListPagination(req.query)
  const filter = {}
  if (req.query.week != null && String(req.query.week).trim() !== '') {
    const w = parseInt(req.query.week, 10)
    if (!Number.isNaN(w)) filter.week = w
  }
  if (req.query.status != null && String(req.query.status).trim() !== '') {
    filter.status = String(req.query.status)
  }
  const skip = (page - 1) * pageSize
  try {
    const coll = mongoDb().collection(COLLECTION_CHALLENGES)
    const [rows, total] = await Promise.all([
      coll.find(filter, { projection: { id: 1, title: 1, week: 1, status: 1 } })
        .sort({ week: -1 })
        .skip(skip)
        .limit(pageSize)
        .toArray(),
      coll.countDocuments(filter),
    ])
    res.status(200).json({ items: rows.map(challengeToApiListItem).filter(Boolean), page, page_size: pageSize, total })
  } catch (e) {
    console.error('GET /challenges error:', e)
    res.status(503).json({ error: 'database_unavailable' })
  }
})

api.get('/challenges/:challenge_id/leaderboard', async (req, res) => {
  const { page, pageSize } = parseListPagination(req.query)
  const sort   = req.query.sort === 'desc' ? -1 : 1
  const metric = ['gas', 'memory_bytes', 'lines'].includes(req.query.metric) ? req.query.metric : 'gas'
  const search = req.query.search ? String(req.query.search).trim() : ''

  try {
    const coll = mongoDb().collection(COLLECTION_SUBMISSIONS)
    const { items, total } = await buildLeaderboard(
      coll,
      { challenge_id: req.params.challenge_id },
      metric, sort, page, pageSize, search
    )
    res.status(200).json({ items, page, page_size: pageSize, total })
  } catch (e) {
    console.error('GET /challenges/:id/leaderboard error:', e)
    res.status(503).json({ error: 'database_unavailable' })
  }
})

api.get('/challenges/:challenge_id/submissions', async (req, res) => {
  const { page, pageSize } = parseListPagination(req.query)
  const cid = req.params.challenge_id
  const skip = (page - 1) * pageSize
  try {
    const coll = mongoDb().collection(COLLECTION_SUBMISSIONS)
    const filter = { challenge_id: cid }
    const [items, total] = await Promise.all([
      coll.find(filter).sort({ submitted_at: -1 }).skip(skip).limit(pageSize).toArray(),
      coll.countDocuments(filter),
    ])
    res.status(200).json({ items: items.map(submissionToApiListItem), page, page_size: pageSize, total })
  } catch (e) {
    console.error(e)
    res.status(503).json({ error: 'database_unavailable' })
  }
})

api.post('/challenges/:challenge_id/submissions', requireBearer, async (req, res) => {
  const userId = req.user && req.user.id != null ? String(req.user.id) : ''
  if (!userId) return res.status(401).json({ error: 'Invalid token payload' })
 
  const language    = req.body && req.body.language != null ? String(req.body.language) : 'lua'
  const source      = req.body && req.body.source != null ? String(req.body.source) : ''
  const displayName = req.user && req.user.username ? String(req.user.username) : userId
  const lines       = source === '' ? 1 : source.split('\n').length
  const now         = new Date()
 
  const doc = {
    challenge_id: req.params.challenge_id,
    user_id:      userId,
    display_name: displayName,
    language,
    source,
    status:       'queued',
    submitted_at: now,
    metrics:      { gas: 0, memory_bytes: 0, lines },
  }
 
  try {
    const db = mongoDb()
    const r  = await db.collection(COLLECTION_SUBMISSIONS).insertOne(doc)
    const hexId = r.insertedId.toHexString()
    const saved = await db.collection(COLLECTION_SUBMISSIONS).findOne({ _id: r.insertedId })
    setImmediate(() => {
      processSubmissionEvaluation(db, hexId).catch((err) => {
        if (err.name === 'MongoClientClosedError') return
        console.error('processSubmissionEvaluation', err)
      })
    })
    res.status(200).json({ ...submissionToApiDetail(saved), language })
  } catch (e) {
    console.error(e)
    res.status(503).json({ error: 'database_unavailable' })
  }
})

api.get('/challenges/:challenge_id', async (req, res) => {
  try {
    const coll = mongoDb().collection(COLLECTION_CHALLENGES)
    const doc  = await coll.findOne({ id: req.params.challenge_id })
    if (!doc) return res.status(404).json({ error: 'Challenge not found' })
    return res.status(200).json(challengeToApiDetail(doc))
  } catch (e) {
    console.error('GET /challenges/:id error:', e)
    return res.status(503).json({ error: 'database_unavailable' })
  }
})

api.get('/submissions/:submission_id', async (req, res) => {
  let oid
  try {
    oid = ObjectId.createFromHexString(req.params.submission_id)
  } catch {
    return res.status(404).json({ error: 'not_found' })
  }
  try {
    const doc = await mongoDb().collection(COLLECTION_SUBMISSIONS).findOne({ _id: oid })
    if (!doc) return res.status(404).json({ error: 'not_found' })
    res.status(200).json(submissionToApiDetail(doc))
  } catch (e) {
    console.error(e)
    res.status(503).json({ error: 'database_unavailable' })
  }
})

api.get('/submissions/:submission_id/source', requireBearer, async (req, res) => {
  const id = req.params.submission_id
  let oid
  try {
    oid = ObjectId.createFromHexString(id)
  } catch {
    return res.status(404).json({ error: 'not_found' })
  }
  try {
    const db  = mongoDb()
    const doc = await db.collection(COLLECTION_SUBMISSIONS).findOne({ _id: oid })
    if (!doc) return res.status(404).json({ error: 'not_found' })
 
    //check if challenge is live
    const challenge = await db.collection(COLLECTION_CHALLENGES).findOne({ id: doc.challenge_id })
    if (challenge && challenge.status === 'open') {
      return res.status(403).json({ error: 'Source is not available while the challenge is live' })
    }
 
    res.status(200).json({
      id,
      language: doc.language,
      source:   doc.source != null ? String(doc.source) : '',
    })
  } catch (e) {
    console.error(e)
    res.status(503).json({ error: 'database_unavailable' })
  }
})

api.get('/leaderboard/global', async (req, res) => {
  const { page, pageSize } = parseListPagination(req.query)
  const sort   = req.query.sort === 'desc' ? -1 : 1
  const metric = ['gas', 'memory_bytes', 'lines'].includes(req.query.metric) ? req.query.metric : 'gas'
  const search = req.query.search ? String(req.query.search).trim() : ''

  try {
    const coll = mongoDb().collection(COLLECTION_SUBMISSIONS)
    const { items, total } = await buildLeaderboard(
      coll,
      {},
      metric, sort, page, pageSize, search
    )
    res.status(200).json({ items, page, page_size: pageSize, total })
  } catch (e) {
    console.error('GET /leaderboard/global error:', e)
    res.status(503).json({ error: 'database_unavailable' })
  }
})

api.get('/users/me', requireBearer, async (req, res) => {
  try {
    if (!ObjectId.isValid(req.user.id)) {
      return res.status(401).json({ error: 'Invalid token payload' })
    }
    const user = await mongoDb().collection('users').findOne({ _id: new ObjectId(req.user.id) })
    if (!user) return res.status(404).json({ error: 'User not found' })
    return res.status(200).json({
      id:           user._id.toString(),
      display_name: user.username,
      stats:        user.stats || { submissions: 0, accepted: 0, challenges_solved: 0 },
    })
  } catch (err) {
    console.error('GET /users/me error:', err)
    return res.status(500).json({ error: 'Internal server error' })
  }
})

api.get('/users/:user_id', async (req, res) => {
  try {
    const userId = req.params.user_id
    if (!ObjectId.isValid(userId)) {
      return res.status(404).json({ error: 'User not found' })
    }
    const user = await mongoDb().collection('users').findOne({ _id: new ObjectId(userId) })
    if (!user) return res.status(404).json({ error: 'User not found' })
    return res.status(200).json({
      id:           user._id.toString(),
      display_name: user.username,
      stats:        user.stats,
    })
  } catch (err) {
    console.error('GET /users/:user_id error:', err)
    return res.status(500).json({ error: 'Internal server error' })
  }
})

api.get('/users/:user_id/submissions', async (req, res) => {
  const { page, pageSize } = parseListPagination(req.query)
  const uid = req.params.user_id
  const skip = (page - 1) * pageSize
  try {
    const coll = mongoDb().collection(COLLECTION_SUBMISSIONS)
    const filter = { user_id: uid }
    const [items, total] = await Promise.all([
      coll
        .find(filter)
        .sort({ submitted_at: -1 })
        .skip(skip)
        .limit(pageSize)
        .toArray(),
      coll.countDocuments(filter),
    ])
    res.status(200).json({
      items: items.map(submissionToApiListItem),
      page,
      page_size: pageSize,
      total,
    })
  } catch (e) {
    console.error(e)
    res.status(503).json({ error: 'database_unavailable' })
  }
})

app.use((req, res) => {
  res.status(404).json({ error: 'not_found' })
})

async function start(options = {}) {
  const listen = options.listen !== false

  try {
    await client.connect()
    if (process.env.NODE_ENV !== 'test') console.log('Connected to MongoDB')

    //unique index on email
    await mongoDb().collection('users').createIndex({ email: 1 }, { unique: true })

    //auto delete expired denylist tokens
    await mongoDb().collection('token_denylist').createIndex({ expires_at: 1 }, { expireAfterSeconds: 0 })

    //index for leaderboard
    await mongoDb().collection(COLLECTION_SUBMISSIONS).createIndex({ challenge_id: 1, status: 1, 'metrics.gas': 1 })
    await mongoDb().collection(COLLECTION_SUBMISSIONS).createIndex({ status: 1, 'metrics.gas': 1 })
  } catch (e) {
    console.error('MongoDB connection failed:', e)
  }

  if (listen) {
    app.listen(5000, () => {
      console.log('Server listening on port 5000')
    })
  }
}

if (require.main === module) {
  start().catch(console.error)
}

app.closeMongo = () => client.close()

module.exports = { app, start, client }
