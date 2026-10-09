'use strict'

const assert = require('node:assert/strict')
const request = require('supertest')
const jwt = require('jsonwebtoken')
const { ObjectId } = require('mongodb')

const { app } = require('../../server')

afterAll(async () => {
  await app.closeMongo()
})

function assertJson(res) {
  const ct = res.headers['content-type'] || ''
  assert.match(ct, /json/i, `expected JSON content-type, got ${ct}`)
}

function assertDbBackedGet(res, { okStatuses = [200, 404, 503] } = {}) {
  assertJson(res)
  assert.ok(
    okStatuses.includes(res.status),
    `unexpected status ${res.status} body=${JSON.stringify(res.body)}`,
  )
}

function bearer(claims) {
  const secret = process.env.JWT_SECRET || 'test-secret'
  const exp = Math.floor(Date.now() / 1000) + 3600
  return jwt.sign({ ...claims, exp }, secret)
}

describe('POST /api/auth/register', () => {
  it('returns 400 for invalid email', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ email: 'incorrect', password: 'longenough1' })
      .expect(400)
    assert.equal(res.body.error, 'valid email is required')
  })

  it('returns 400 for bad password', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ email: 'adfasdfregweghr@asgdhgdwgdf.com', password: 'short' })
      .expect(400)
    assert.equal(res.body.error, 'password must be at least 8 characters')
  })
})

describe('GET /api/auth/verify-email', () => {
  it('returns 400 if token is missing', async () => {
    const res = await request(app).get('/api/auth/verify-email').expect(400)
    assert.equal(res.body.error, 'token is required')
  })
})

describe('POST /api/auth/resend-verification', () => {
  it('returns 400 if email is missing', async () => {
    const res = await request(app).post('/api/auth/resend-verification').send({}).expect(400)
    assertJson(res)
    assert.equal(res.body.error, 'email is required')
  })
})

describe('POST /api/auth/login', () => {
  it('returns 400 if email & password is missing', async () => {
    const res = await request(app).post('/api/auth/login').send({}).expect(400)
    assertJson(res)
    assert.equal(res.body.error, 'email and password are required')
  })
})

describe('POST /api/auth/logout', () => {
  it('returns 401 if no Auth', async () => {
    const res = await request(app).post('/api/auth/logout').expect(401)
    assert.equal(res.body.error, 'Bearer token required')
  })

  it('returns 401 if bad JWT', async () => {
    const res = await request(app)
      .post('/api/auth/logout')
      .set('Authorization', 'Bearer not-a-jwt')
      .expect(401)
    assert.equal(res.body.error, 'Invalid or expired token')
  })
})

describe('POST /api/auth/forgot-password', () => {
  it('returns 400 if email is missing', async () => {
    const res = await request(app).post('/api/auth/forgot-password').send({}).expect(400)
    assertJson(res)
    assert.equal(res.body.error, 'email is required')
  })
})

describe('POST /api/auth/reset-password', () => {
  it('returns 400 if token or new_password is missing or too short', async () => {
    const res = await request(app)
      .post('/api/auth/reset-password')
      .send({ token: 'x', new_password: 'short' })
      .expect(400)
    assertJson(res)
    assert.equal(res.body.error, 'token and new_password (min 8 chars) are required')
  })
})

describe('GET /api/challenges/current', () => {
  it('returns JSON', async () => {
    const res = await request(app).get('/api/challenges/current')
    assertDbBackedGet(res, { okStatuses: [200, 404, 503] })
    if (res.status === 200) {
      assert.equal(typeof res.body.id, 'string')
      assert.ok('title' in res.body)
    }
    if (res.status === 404) assert.equal(res.body.error, 'No current challenge found')
    if (res.status === 503) assert.equal(res.body.error, 'database_unavailable')
  })
})

describe('GET /api/challenges', () => {
  it('returns 401 if no Auth', async () => {
    const res = await request(app).get('/api/challenges').expect(401)
    assert.equal(res.body.error, 'Bearer token required')
  })

  it('returns JSON if Auth', async () => {
    const token = bearer({
      id: new ObjectId().toHexString(),
      email: 'test@safuiashfisad.com',
      username: 'tester',
    })
    const res = await request(app).get('/api/challenges').set('Authorization', `Bearer ${token}`)
    assertDbBackedGet(res, { okStatuses: [200, 401, 503] })
    if (res.status === 200) {
      assert.ok(Array.isArray(res.body.items))
      assert.equal(typeof res.body.page, 'number')
      assert.equal(typeof res.body.total, 'number')
    }
    if (res.status === 401) assert.equal(res.body.error, 'User not found')
    if (res.status === 503) assert.equal(res.body.error, 'database_unavailable')
  })
})

describe('GET /api/challenges/:challenge_id/leaderboard', () => {
  it('returns JSON', async () => {
    const res = await request(app).get('/api/challenges/demo-challenge/leaderboard')
    assertDbBackedGet(res, { okStatuses: [200, 503] })
    if (res.status === 200) {
      assert.ok(Array.isArray(res.body.items))
      assert.equal(typeof res.body.page, 'number')
      assert.equal(typeof res.body.total, 'number')
    }
  })
})

describe('GET /api/challenges/:challenge_id/submissions', () => {
  it('returns JSON', async () => {
    const res = await request(app).get('/api/challenges/demo-challenge/submissions')
    assertDbBackedGet(res, { okStatuses: [200, 503] })
    if (res.status === 200) {
      assert.ok(Array.isArray(res.body.items))
      assert.equal(typeof res.body.page, 'number')
    }
  })
})

describe('POST /api/challenges/:challenge_id/submissions', () => {
  it('returns 401 if no Auth', async () => {
    const res = await request(app)
      .post('/api/challenges/demo-challenge/submissions')
      .send({ language: 'lua', source: 'return 1' })
      .expect(401)
    assert.equal(res.body.error, 'Bearer token required')
  })

  it('returns JSON if Auth', async () => {
    const token = bearer({
      id: new ObjectId().toHexString(),
      email: 's@t.co',
      username: 'submitter',
    })
    const res = await request(app)
      .post('/api/challenges/demo-challenge/submissions')
      .set('Authorization', `Bearer ${token}`)
      .send({ language: 'lua', source: 'return true' })
    assertJson(res)
    assert.ok([200, 401, 503].includes(res.status), `status ${res.status}`)
    if (res.status === 401) assert.equal(res.body.error, 'User not found')
    if (res.status === 503) assert.equal(res.body.error, 'database_unavailable')
  })
})

describe('GET /api/challenges/:challenge_id', () => {
  it('returns JSON', async () => {
    const res = await request(app).get('/api/challenges/nonexistent-challenge-id-xyz')
    assertDbBackedGet(res, { okStatuses: [200, 404, 503] })
    if (res.status === 404) assert.equal(res.body.error, 'Challenge not found')
    if (res.status === 200) assert.equal(typeof res.body.id, 'string')
  })
})

describe('GET /api/submissions/:submission_id', () => {
  it('returns 404 if malformed submission id', async () => {
    const res = await request(app).get('/api/submissions/not-hex').expect(404)
    assert.equal(res.body.error, 'not_found')
  })

  it('returns JSON for well-formed id (200, 404, or 503)', async () => {
    const id = new ObjectId().toHexString()
    const res = await request(app).get(`/api/submissions/${id}`)
    assertDbBackedGet(res, { okStatuses: [200, 404, 503] })
    if (res.status === 404) assert.equal(res.body.error, 'not_found')
    if (res.status === 200) assert.equal(res.body.id, id)
  })
})

describe('GET /api/submissions/:submission_id/source', () => {
  it('returns 401 if no Auth', async () => {
    const res = await request(app).get('/api/submissions/fasfgtrgwegfsadcsadf/source').expect(401)
    assert.equal(res.body.error, 'Bearer token required')
  })

  it('returns 404 if malformed id if Auth', async () => {
    const token = bearer({
      id: new ObjectId().toHexString(),
      email: 'src@t.co',
      username: 'src',
    })
    const res = await request(app)
      .get('/api/submissions/gggggggggggggggggggggggg/source')
      .set('Authorization', `Bearer ${token}`)
    assertJson(res)
    assert.ok([401, 404].includes(res.status), `status ${res.status}`)
    if (res.status === 401) assert.equal(res.body.error, 'User not found')
    if (res.status === 404) assert.equal(res.body.error, 'not_found')
  })

  it('returns JSON if Auth', async () => {
    const token = bearer({
      id: new ObjectId().toHexString(),
      email: 'asdfasf@tgoifdjg.com',
      username: 'adsfasdasdf',
    })
    const id = new ObjectId().toHexString()
    const res = await request(app)
      .get(`/api/submissions/${id}/source`)
      .set('Authorization', `Bearer ${token}`)
    assertDbBackedGet(res, { okStatuses: [200, 401, 404, 503] })
    if (res.status === 401) assert.equal(res.body.error, 'User not found')
    if (res.status === 404) assert.equal(res.body.error, 'not_found')
    if (res.status === 200) {
      assert.equal(res.body.id, id)
      assert.ok('source' in res.body)
    }
  })
})

describe('GET /api/leaderboard/global', () => {
  it('returns JSON', async () => {
    const res = await request(app).get('/api/leaderboard/global')
    assertDbBackedGet(res, { okStatuses: [200, 503] })
    if (res.status === 200) {
      assert.ok(Array.isArray(res.body.items))
      assert.equal(typeof res.body.page, 'number')
    }
  })
})

describe('GET /api/users/me', () => {
  it('returns 401 if no Auth', async () => {
    const res = await request(app).get('/api/users/me').expect(401)
    assert.equal(res.body.error, 'Bearer token required')
  })

  it('returns 401 if token subject id is not a valid ObjectId', async () => {
    const token = bearer({
      id: 'gggggggggggggggggggggggg',
      email: 'zpogsdfgio@tgoifdjg.com',
      username: 'me',
    })
    const res = await request(app).get('/api/users/me').set('Authorization', `Bearer ${token}`).expect(401)
    assert.equal(res.body.error, 'Invalid or expired token')
  })

  it('returns JSON if token id is valid', async () => {
    const token = bearer({
      id: new ObjectId().toHexString(),
      email: 'm2@t.co',
      username: 'me2',
    })
    const res = await request(app).get('/api/users/me').set('Authorization', `Bearer ${token}`)
    assertJson(res)
    assert.ok([200, 401, 404, 500].includes(res.status), `status ${res.status}`)
    if (res.status === 401) assert.equal(res.body.error, 'User not found')
    if (res.status === 404) assert.equal(res.body.error, 'User not found')
    if (res.status === 200) {
      assert.equal(typeof res.body.id, 'string')
      assert.ok(res.body.stats)
    }
  })
})

describe('GET /api/users/:user_id', () => {
  it('returns 404 if invalid ObjectId', async () => {
    const res = await request(app).get('/api/users/not-a-valid-objectid').expect(404)
    assert.equal(res.body.error, 'User not found')
  })

  it('returns JSON if valid ObjectId', async () => {
    const id = new ObjectId().toHexString()
    const res = await request(app).get(`/api/users/${id}`)
    assertJson(res)
    assert.ok([200, 404, 500].includes(res.status), `status ${res.status}`)
    if (res.status === 404) assert.equal(res.body.error, 'User not found')
    if (res.status === 200) assert.equal(res.body.id, id)
  })
})

describe('GET /api/users/:user_id/submissions', () => {
  it('returns JSON', async () => {
    const id = new ObjectId().toHexString()
    const res = await request(app).get(`/api/users/${id}/submissions`)
    assertDbBackedGet(res, { okStatuses: [200, 503] })
    if (res.status === 200) {
      assert.ok(Array.isArray(res.body.items))
      assert.equal(typeof res.body.page, 'number')
    }
  })
})
