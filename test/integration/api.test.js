const request = require('supertest')
const { MongoMemoryServer } = require('mongodb-memory-server')

/** Matches seeded / mock API usage (e.g. mock-login-frontend). */
const CHALLENGE_ID = 'Hardest-Challenge'

describe('API integration', () => {
  let mongoServer
  let app
  let start
  let client

  beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create()
    process.env.MONGODB_URI = mongoServer.getUri()
    process.env.MONGODB_DB = 'integration_test'
    process.env.JWT_SECRET = 'integration-test-jwt-secret-32chars!'
    process.env.JWT_EXPIRES = '7d'
    process.env.SMTP_HOST = ''
    process.env.APP_URL = 'http://localhost:3000'

    const server = require('../../server')
    app = server.app
    start = server.start
    client = server.client
    await start({ listen: false })
  }, 120000)

  afterAll(async () => {
    if (client) await client.close().catch(() => {})
    if (mongoServer) await mongoServer.stop()
  })

  it('rejects registration with invalid email', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ email: 'not-an-email', password: 'password123', username: 'u' })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/email/i)
  })

  it('rejects registration with short password', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ email: 'a@b.co', password: 'short', username: 'u' })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/password/i)
  })

  it('registers, verifies email, logs in, and returns /users/me', async () => {
    const email = `user-${Date.now()}@example.com`
    const password = 'password123'

    const reg = await request(app)
      .post('/api/auth/register')
      .send({ email, password, username: 'integration_user' })
    expect(reg.status).toBe(201)
    expect(reg.body.user_id).toBeTruthy()

    const users = client.db(process.env.MONGODB_DB).collection('users')
    const row = await users.findOne({ email: email.toLowerCase() })
    expect(row).toBeTruthy()
    expect(row.verification_token).toBeTruthy()

    const verify = await request(app).get('/api/auth/verify-email').query({ token: row.verification_token })
    expect(verify.status).toBe(200)

    const login = await request(app).post('/api/auth/login').send({ email, password })
    expect(login.status).toBe(200)
    expect(login.body.access_token).toBeTruthy()

    const me = await request(app)
      .get('/api/users/me')
      .set('Authorization', `Bearer ${login.body.access_token}`)
    expect(me.status).toBe(200)
    expect(me.body.id).toBe(reg.body.user_id)
    expect(me.body.display_name).toBe('integration_user')
  })

  it('returns 409 when email is already registered', async () => {
    const email = `dup-${Date.now()}@example.com`
    const password = 'password123'
    const first = await request(app)
      .post('/api/auth/register')
      .send({ email, password, username: 'a' })
    expect(first.status).toBe(201)

    const second = await request(app)
      .post('/api/auth/register')
      .send({ email, password, username: 'b' })
    expect(second.status).toBe(409)
  })

  it('creates a submission when authenticated', async () => {
    const email = `sub-${Date.now()}@example.com`
    const password = 'password123'
    await request(app)
      .post('/api/auth/register')
      .send({ email, password, username: 'submitter' })
    const users = client.db(process.env.MONGODB_DB).collection('users')
    const row = await users.findOne({ email: email.toLowerCase() })
    await request(app).get('/api/auth/verify-email').query({ token: row.verification_token })

    const login = await request(app).post('/api/auth/login').send({ email, password })
    const token = login.body.access_token

    const res = await request(app)
      .post(`/api/challenges/${CHALLENGE_ID}/submissions`)
      .set('Authorization', `Bearer ${token}`)
      .send({ language: 'lua', source: 'return true\n' })

    expect(res.status).toBe(200)
    expect(res.body.id).toBeTruthy()
    expect(res.body.challenge_id).toBe(CHALLENGE_ID)
    expect(res.body.status).toBe('queued')
  })
})
