const express = require('express')
const { Pool } = require('pg')
const cors = require('cors')
const bcrypt = require('bcryptjs')
const jwt = require('jsonwebtoken')
const crypto = require('crypto')
require('dotenv').config()

const app = express()
app.use(cors())
app.use(express.json())
const path = require('path')
app.use(express.static(path.join(__dirname)))

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'))
})

// ─────────────────────────────
// DATABASE CONNECTION
// ─────────────────────────────
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
})

pool.query('SELECT COUNT(*) FROM states')
    .then(r => console.log(`✅ Database connected! ${r.rows[0].count} states found.`))
    .catch(e => console.error('❌ Database error:', e.message))

const JWT_SECRET = process.env.JWT_SECRET || 'bluestock_villages_secret_2026'

// ─────────────────────────────
// RATE LIMITING (in-memory)
// ─────────────────────────────
const rateLimitStore = {}

const PLAN_LIMITS = {
    free: 5000,
    premium: 50000,
    pro: 300000,
    unlimited: 1000000
}

function checkRateLimit(apiKey, plan) {
    const now = Date.now()
    const limit = PLAN_LIMITS[plan] || 5000
    if (!rateLimitStore[apiKey] || now > rateLimitStore[apiKey].resetTime) {
        rateLimitStore[apiKey] = { count: 0, resetTime: new Date().setHours(24, 0, 0, 0) }
    }
    rateLimitStore[apiKey].count++
    const remaining = Math.max(0, limit - rateLimitStore[apiKey].count)
    return { limit, remaining, exceeded: rateLimitStore[apiKey].count > limit, reset: new Date(rateLimitStore[apiKey].resetTime).toISOString() }
}

// ─────────────────────────────
// STANDARD RESPONSE FORMAT
// ─────────────────────────────
function successResponse(res, data, count, rateInfo, startTime) {
    res.json({
        success: true,
        count: count !== undefined ? count : (Array.isArray(data) ? data.length : 1),
        data,
        meta: {
            requestId: 'req_' + crypto.randomBytes(6).toString('hex'),
            responseTime: Date.now() - startTime,
            rateLimit: { remaining: rateInfo?.remaining ?? 9999, limit: rateInfo?.limit ?? 9999, reset: rateInfo?.reset ?? new Date().toISOString() }
        }
    })
}

function errorResponse(res, statusCode, errorCode, message) {
    res.status(statusCode).json({ success: false, error: { code: errorCode, message } })
}

// ─────────────────────────────
// HELPERS
// ─────────────────────────────
function generateApiKey() { return 'bls_' + crypto.randomBytes(16).toString('hex') }

function verifyToken(req, res, next) {
    const token = req.headers['authorization']?.split(' ')[1]
    if (!token) return errorResponse(res, 401, 'UNAUTHORIZED', 'No token provided')
    try { req.user = jwt.verify(token, JWT_SECRET); next() }
    catch (e) { errorResponse(res, 401, 'INVALID_TOKEN', 'Invalid or expired token') }
}

async function verifyApiKey(req, res, next) {
    const apiKey = req.headers['x-api-key'] || req.query.api_key
    if (!apiKey) return errorResponse(res, 401, 'INVALID_API_KEY', 'API key required. Pass X-API-Key header.')
    try {
        const result = await pool.query('SELECT * FROM users WHERE api_key = $1 AND status = $2', [apiKey, 'active'])
        if (!result.rows.length) return errorResponse(res, 401, 'INVALID_API_KEY', 'Invalid or inactive API key')
        const user = result.rows[0]
        const rateInfo = checkRateLimit(apiKey, user.plan)
        if (rateInfo.exceeded) return errorResponse(res, 429, 'RATE_LIMITED', `Daily quota of ${rateInfo.limit} requests exceeded. Resets at ${rateInfo.reset}`)
        req.user = user; req.rateInfo = rateInfo; next()
    } catch (e) { errorResponse(res, 500, 'INTERNAL_ERROR', e.message) }
}

function adminOnly(req, res, next) {
    if (req.user.role !== 'admin') return errorResponse(res, 403, 'ACCESS_DENIED', 'Admin access required')
    next()
}

async function logApiCall(userId, endpoint, responseTime, statusCode) {
    try { await pool.query('INSERT INTO api_logs (user_id, endpoint, response_time, status_code) VALUES ($1, $2, $3, $4)', [userId, endpoint, responseTime, statusCode]) } catch (e) {}
}

// ─────────────────────────────
// ROOT
// ─────────────────────────────
app.get('/ping', (req, res) => res.json({ message: '🌏 Bharat Villages API is running!', version: '1.0.0' }))

// ═══════════════════════════════════════════════
// AUTH
// ═══════════════════════════════════════════════
app.post('/auth/register', async (req, res) => {
    const { business_name, email, password } = req.body
    if (!business_name || !email || !password) return errorResponse(res, 400, 'INVALID_QUERY', 'business_name, email and password required')
    if (password.length < 6) return errorResponse(res, 400, 'INVALID_QUERY', 'Password must be at least 6 characters')
    try {
        const existing = await pool.query('SELECT id FROM users WHERE email = $1', [email])
        if (existing.rows.length) return errorResponse(res, 400, 'INVALID_QUERY', 'Email already registered')
        const password_hash = await bcrypt.hash(password, 10)
        const api_key = generateApiKey()
        const result = await pool.query(
            `INSERT INTO users (business_name, email, password_hash, api_key, role, plan, status) VALUES ($1,$2,$3,$4,'user','free','active') RETURNING id, business_name, email, api_key, plan, role`,
            [business_name, email, password_hash, api_key]
        )
        const user = result.rows[0]
        const token = jwt.sign({ id: user.id, email: user.email, role: user.role }, JWT_SECRET, { expiresIn: '24h' })
        res.json({ success: true, message: 'Account created!', token, user: { id: user.id, business_name: user.business_name, email: user.email, api_key: user.api_key, plan: user.plan, role: user.role } })
    } catch (err) { errorResponse(res, 500, 'INTERNAL_ERROR', err.message) }
})

app.post('/auth/login', async (req, res) => {
    const { email, password } = req.body
    if (!email || !password) return errorResponse(res, 400, 'INVALID_QUERY', 'Email and password required')
    try {
        const result = await pool.query('SELECT * FROM users WHERE email = $1', [email])
        if (!result.rows.length) return errorResponse(res, 401, 'INVALID_API_KEY', 'Invalid email or password')
        const user = result.rows[0]
        if (!await bcrypt.compare(password, user.password_hash)) return errorResponse(res, 401, 'INVALID_API_KEY', 'Invalid email or password')
        if (user.status !== 'active') return errorResponse(res, 403, 'ACCESS_DENIED', 'Account suspended')
        const token = jwt.sign({ id: user.id, email: user.email, role: user.role }, JWT_SECRET, { expiresIn: '24h' })
        res.json({ success: true, message: 'Login successful!', token, user: { id: user.id, business_name: user.business_name, email: user.email, api_key: user.api_key, plan: user.plan, role: user.role } })
    } catch (err) { errorResponse(res, 500, 'INTERNAL_ERROR', err.message) }
})

// ═══════════════════════════════════════════════
// B2B DASHBOARD
// ═══════════════════════════════════════════════
app.get('/dashboard/profile', verifyToken, async (req, res) => {
    try {
        const result = await pool.query('SELECT id, business_name, email, api_key, plan, role, status, created_at FROM users WHERE id = $1', [req.user.id])
        res.json({ success: true, data: result.rows[0] })
    } catch (err) { errorResponse(res, 500, 'INTERNAL_ERROR', err.message) }
})

app.get('/dashboard/usage', verifyToken, async (req, res) => {
    try {
        const today = await pool.query(`SELECT COUNT(*) as count FROM api_logs WHERE user_id=$1 AND created_at>=CURRENT_DATE`, [req.user.id])
        const month = await pool.query(`SELECT COUNT(*) as count FROM api_logs WHERE user_id=$1 AND created_at>=DATE_TRUNC('month',CURRENT_DATE)`, [req.user.id])
        const weekly = await pool.query(`SELECT DATE(created_at) as date, COUNT(*) as count FROM api_logs WHERE user_id=$1 AND created_at>=CURRENT_DATE-INTERVAL '7 days' GROUP BY DATE(created_at) ORDER BY date`, [req.user.id])
        const avgRes = await pool.query(`SELECT ROUND(AVG(response_time)) as avg FROM api_logs WHERE user_id=$1 AND created_at>=CURRENT_DATE`, [req.user.id])
        const user = await pool.query('SELECT plan FROM users WHERE id=$1', [req.user.id])
        const plan = user.rows[0].plan
        res.json({ success: true, data: { today: parseInt(today.rows[0].count), this_month: parseInt(month.rows[0].count), daily_limit: PLAN_LIMITS[plan] || 5000, plan, avg_response_ms: parseInt(avgRes.rows[0].avg) || 0, weekly_breakdown: weekly.rows } })
    } catch (err) { errorResponse(res, 500, 'INTERNAL_ERROR', err.message) }
})

app.post('/dashboard/regenerate-key', verifyToken, async (req, res) => {
    try {
        const newKey = generateApiKey()
        await pool.query('UPDATE users SET api_key=$1 WHERE id=$2', [newKey, req.user.id])
        res.json({ success: true, message: 'API key regenerated!', api_key: newKey })
    } catch (err) { errorResponse(res, 500, 'INTERNAL_ERROR', err.message) }
})

// ═══════════════════════════════════════════════
// ADMIN
// ═══════════════════════════════════════════════
app.get('/admin/stats', verifyToken, adminOnly, async (req, res) => {
    try {
        const [users, villages, states, calls, today, avg, byPlan, weekly, endpoints, stateVillages] = await Promise.all([
            pool.query("SELECT COUNT(*) FROM users WHERE role='user'"),
            pool.query("SELECT COUNT(*) FROM villages"),
            pool.query("SELECT COUNT(*) FROM states"),
            pool.query("SELECT COUNT(*) FROM api_logs"),
            pool.query("SELECT COUNT(*) FROM api_logs WHERE created_at>=CURRENT_DATE"),
            pool.query("SELECT ROUND(AVG(response_time)) as avg FROM api_logs WHERE created_at>=CURRENT_DATE"),
            pool.query("SELECT plan, COUNT(*) as count FROM users WHERE role='user' GROUP BY plan"),
            pool.query(`SELECT DATE(created_at) as date, COUNT(*) as count FROM api_logs WHERE created_at>=CURRENT_DATE-INTERVAL '7 days' GROUP BY DATE(created_at) ORDER BY date`),
            pool.query(`SELECT endpoint, COUNT(*) as count FROM api_logs GROUP BY endpoint ORDER BY count DESC LIMIT 6`),
            pool.query(`SELECT s.state_name, COUNT(v.id) as village_count FROM states s JOIN districts d ON d.state_id=s.id JOIN subdistricts sd ON sd.district_id=d.id JOIN villages v ON v.subdistrict_id=sd.id GROUP BY s.state_name ORDER BY village_count DESC LIMIT 10`)
        ])
        res.json({ success: true, data: {
            total_users: parseInt(users.rows[0].count),
            total_villages: parseInt(villages.rows[0].count),
            total_states: parseInt(states.rows[0].count),
            total_api_calls: parseInt(calls.rows[0].count),
            today_api_calls: parseInt(today.rows[0].count),
            avg_response_ms: parseInt(avg.rows[0].avg) || 0,
            users_by_plan: byPlan.rows,
            weekly_api_calls: weekly.rows,
            top_endpoints: endpoints.rows,
            state_village_counts: stateVillages.rows
        }})
    } catch (err) { errorResponse(res, 500, 'INTERNAL_ERROR', err.message) }
})

app.get('/admin/users', verifyToken, adminOnly, async (req, res) => {
    try {
        const result = await pool.query(`SELECT id, business_name, email, plan, role, status, api_key, created_at FROM users ORDER BY created_at DESC`)
        res.json({ success: true, count: result.rows.length, data: result.rows })
    } catch (err) { errorResponse(res, 500, 'INTERNAL_ERROR', err.message) }
})

app.patch('/admin/users/:id', verifyToken, adminOnly, async (req, res) => {
    const { plan, status } = req.body; const updates = []; const values = []; let i = 1
    if (plan) { updates.push(`plan=$${i++}`); values.push(plan) }
    if (status) { updates.push(`status=$${i++}`); values.push(status) }
    if (!updates.length) return errorResponse(res, 400, 'INVALID_QUERY', 'Nothing to update')
    values.push(req.params.id)
    try { await pool.query(`UPDATE users SET ${updates.join(',')} WHERE id=$${i}`, values); res.json({ success: true, message: 'User updated' }) }
    catch (err) { errorResponse(res, 500, 'INTERNAL_ERROR', err.message) }
})

app.get('/admin/logs', verifyToken, adminOnly, async (req, res) => {
    try {
        const result = await pool.query(`SELECT l.id, l.endpoint, l.response_time, l.status_code, l.created_at, u.business_name, u.email FROM api_logs l JOIN users u ON l.user_id=u.id ORDER BY l.created_at DESC LIMIT 50`)
        res.json({ success: true, data: result.rows })
    } catch (err) { errorResponse(res, 500, 'INTERNAL_ERROR', err.message) }
})

app.get('/admin/villages', verifyToken, adminOnly, async (req, res) => {
    const { state_id, district_id, subdistrict_id, q, page = 1, limit = 500 } = req.query
    const offset = (parseInt(page) - 1) * parseInt(limit)
    try {
        let where = 'WHERE 1=1'; const params = []
        let p = 1
        if (state_id) { where += ` AND s.id=$${p++}`; params.push(state_id) }
        if (district_id) { where += ` AND d.id=$${p++}`; params.push(district_id) }
        if (subdistrict_id) { where += ` AND sd.id=$${p++}`; params.push(subdistrict_id) }
        if (q) { where += ` AND LOWER(v.village_name) LIKE LOWER($${p++})`; params.push(`%${q}%`) }
        const base = `FROM villages v JOIN subdistricts sd ON v.subdistrict_id=sd.id JOIN districts d ON sd.district_id=d.id JOIN states s ON d.state_id=s.id ${where}`
        const countRes = await pool.query(`SELECT COUNT(*) ${base}`, params)
        const dataRes = await pool.query(`SELECT v.id, v.village_code, v.village_name, sd.subdistrict_name, d.district_name, s.state_name ${base} ORDER BY v.village_name LIMIT $${p++} OFFSET $${p}`, [...params, parseInt(limit), offset])
        res.json({ success: true, count: dataRes.rows.length, total: parseInt(countRes.rows[0].count), page: parseInt(page), data: dataRes.rows })
    } catch (err) { errorResponse(res, 500, 'INTERNAL_ERROR', err.message) }
})

// ═══════════════════════════════════════════════
// VILLAGE DATA API (API Key required)
// ═══════════════════════════════════════════════
app.get('/api/states', verifyApiKey, async (req, res) => {
    const s = Date.now()
    try {
        const r = await pool.query('SELECT id, state_code, state_name FROM states ORDER BY state_name')
        await logApiCall(req.user.id, '/api/states', Date.now()-s, 200)
        successResponse(res, r.rows, r.rows.length, req.rateInfo, s)
    } catch (err) { errorResponse(res, 500, 'INTERNAL_ERROR', err.message) }
})

app.get('/api/districts', verifyApiKey, async (req, res) => {
    const s = Date.now(); const { state_id } = req.query
    if (!state_id) return errorResponse(res, 400, 'INVALID_QUERY', 'state_id required')
    try {
        const r = await pool.query('SELECT id, district_code, district_name FROM districts WHERE state_id=$1 ORDER BY district_name', [state_id])
        await logApiCall(req.user.id, '/api/districts', Date.now()-s, 200)
        successResponse(res, r.rows, r.rows.length, req.rateInfo, s)
    } catch (err) { errorResponse(res, 500, 'INTERNAL_ERROR', err.message) }
})

app.get('/api/subdistricts', verifyApiKey, async (req, res) => {
    const s = Date.now(); const { district_id } = req.query
    if (!district_id) return errorResponse(res, 400, 'INVALID_QUERY', 'district_id required')
    try {
        const r = await pool.query('SELECT id, subdistrict_code, subdistrict_name FROM subdistricts WHERE district_id=$1 ORDER BY subdistrict_name', [district_id])
        await logApiCall(req.user.id, '/api/subdistricts', Date.now()-s, 200)
        successResponse(res, r.rows, r.rows.length, req.rateInfo, s)
    } catch (err) { errorResponse(res, 500, 'INTERNAL_ERROR', err.message) }
})

app.get('/api/villages', verifyApiKey, async (req, res) => {
    const s = Date.now(); const { subdistrict_id } = req.query
    if (!subdistrict_id) return errorResponse(res, 400, 'INVALID_QUERY', 'subdistrict_id required')
    try {
        const r = await pool.query('SELECT id, village_code, village_name FROM villages WHERE subdistrict_id=$1 ORDER BY village_name', [subdistrict_id])
        await logApiCall(req.user.id, '/api/villages', Date.now()-s, 200)
        successResponse(res, r.rows, r.rows.length, req.rateInfo, s)
    } catch (err) { errorResponse(res, 500, 'INTERNAL_ERROR', err.message) }
})

app.get('/api/search', verifyApiKey, async (req, res) => {
    const s = Date.now(); const { q, limit = 20 } = req.query
    if (!q || q.length < 2) return errorResponse(res, 400, 'INVALID_QUERY', 'Query must be at least 2 characters')
    try {
        const r = await pool.query(
            `SELECT v.id, v.village_name, sd.subdistrict_name, d.district_name, s.state_name FROM villages v JOIN subdistricts sd ON v.subdistrict_id=sd.id JOIN districts d ON sd.district_id=d.id JOIN states s ON d.state_id=s.id WHERE LOWER(v.village_name) LIKE LOWER($1) ORDER BY v.village_name LIMIT $2`,
            [`%${q}%`, Math.min(parseInt(limit), 50)]
        )
        await logApiCall(req.user.id, '/api/search', Date.now()-s, 200)
        successResponse(res, r.rows, r.rows.length, req.rateInfo, s)
    } catch (err) { errorResponse(res, 500, 'INTERNAL_ERROR', err.message) }
})

// ── AUTOCOMPLETE endpoint
app.get('/api/autocomplete', verifyApiKey, async (req, res) => {
    const s = Date.now(); const { q, hierarchyLevel = 'village' } = req.query
    if (!q || q.length < 2) return errorResponse(res, 400, 'INVALID_QUERY', 'Query must be at least 2 characters')
    try {
        let r
        if (hierarchyLevel === 'state') {
            r = await pool.query(`SELECT id, state_name as label, state_code as code FROM states WHERE LOWER(state_name) LIKE LOWER($1) ORDER BY state_name LIMIT 10`, [`${q}%`])
        } else if (hierarchyLevel === 'district') {
            r = await pool.query(`SELECT id, district_name as label, district_code as code FROM districts WHERE LOWER(district_name) LIKE LOWER($1) ORDER BY district_name LIMIT 10`, [`${q}%`])
        } else {
            r = await pool.query(
                `SELECT v.id, v.village_name as label, v.village_code as code,
                    CONCAT(v.village_name,', ',sd.subdistrict_name,', ',d.district_name,', ',s.state_name,', India') as full_address,
                    json_build_object('village',v.village_name,'subDistrict',sd.subdistrict_name,'district',d.district_name,'state',s.state_name,'country','India') as hierarchy
                 FROM villages v JOIN subdistricts sd ON v.subdistrict_id=sd.id JOIN districts d ON sd.district_id=d.id JOIN states s ON d.state_id=s.id
                 WHERE LOWER(v.village_name) LIKE LOWER($1) ORDER BY v.village_name LIMIT 10`,
                [`${q}%`]
            )
        }
        const formatted = r.rows.map(row => ({ value: `village_id_${row.id}`, label: row.label, fullAddress: row.full_address || row.label, hierarchy: row.hierarchy || {} }))
        await logApiCall(req.user.id, '/api/autocomplete', Date.now()-s, 200)
        successResponse(res, formatted, formatted.length, req.rateInfo, s)
    } catch (err) { errorResponse(res, 500, 'INTERNAL_ERROR', err.message) }
})

app.get('/api/village/:id', verifyApiKey, async (req, res) => {
    const s = Date.now()
    try {
        const r = await pool.query(
            `SELECT v.id, v.village_code, v.village_name, sd.subdistrict_name, d.district_name, s.state_name, CONCAT(v.village_name,', ',sd.subdistrict_name,', ',d.district_name,', ',s.state_name,', India') AS full_address FROM villages v JOIN subdistricts sd ON v.subdistrict_id=sd.id JOIN districts d ON sd.district_id=d.id JOIN states s ON d.state_id=s.id WHERE v.id=$1`,
            [req.params.id]
        )
        if (!r.rows.length) return errorResponse(res, 404, 'NOT_FOUND', 'Village not found')
        await logApiCall(req.user.id, '/api/village', Date.now()-s, 200)
        successResponse(res, r.rows[0], 1, req.rateInfo, s)
    } catch (err) { errorResponse(res, 500, 'INTERNAL_ERROR', err.message) }
})

// ─────────────────────────────
// START SERVER
// ─────────────────────────────
const PORT = process.env.PORT || 3000
app.listen(PORT, () => {
    console.log(`✅ Bharat Villages API running!`)
    console.log(`   🌐 http://localhost:${PORT}/index.html`)
    console.log(`   🔍 Autocomplete: GET /api/autocomplete?q=pat&api_key=YOUR_KEY`)
    console.log(`   📊 Admin Stats:  GET /admin/stats`)
})