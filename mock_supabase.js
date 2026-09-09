/* ===========================================================================
 * LOCAL QA HARNESS — NOT PART OF THE DEPLOYED SITE.
 * ---------------------------------------------------------------------------
 * A minimal stand-in for the Supabase REST + auth endpoints, backed by a real
 * PostgreSQL database that has migrations 0001-0004 applied on top of
 * supabase/test/00_stub_auth.sql.
 *
 * It exists so the browser client can be exercised end to end (register,
 * login, RPC calls, RLS behaviour) without a hosted project. Every RPC is
 * executed by the *actual* SQL functions, as the `authenticated` role, with
 * auth.uid() bound to the caller — so what passes here is what the real
 * project enforces.
 *
 * Do not deploy this file. Do not run it against a Supabase project.
 * ========================================================================= */

const http = require('http');
const crypto = require('crypto');
const { Pool } = require('/tmp/node_modules/pg');

const PORT = Number(process.env.MOCK_PORT || 54321);
const JWT_SECRET = 'local-qa-secret';
const ANON_KEY = 'local-anon-key-for-qa-only-0000000000';

const pool = new Pool({
  host: '127.0.0.1', port: 5432, user: 'postgres',
  password: 'cptest', database: 'cp_test', max: 8
});

/* ---------- tiny HS256 JWT (only so supabase-js can read exp/sub) -------- */
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
function sign(payload) {
  const head = b64({ alg: 'HS256', typ: 'JWT' });
  const body = b64(payload);
  const sig = crypto.createHmac('sha256', JWT_SECRET).update(head + '.' + body).digest('base64url');
  return head + '.' + body + '.' + sig;
}
function verify(token) {
  try {
    const [h, b, s] = String(token).split('.');
    const expect = crypto.createHmac('sha256', JWT_SECRET).update(h + '.' + b).digest('base64url');
    if (s !== expect) return null;
    const payload = JSON.parse(Buffer.from(b, 'base64url').toString());
    if (payload.exp && payload.exp * 1000 < Date.now()) return null;
    return payload;
  } catch (e) { return null; }
}

const hash = (pw) => crypto.createHash('sha256').update('cp:' + pw).digest('hex');

function session(user) {
  const now = Math.floor(Date.now() / 1000);
  return {
    access_token: sign({ sub: user.id, email: user.email, role: 'authenticated', iat: now, exp: now + 3600 }),
    token_type: 'bearer',
    expires_in: 3600,
    expires_at: now + 3600,
    refresh_token: 'refresh-' + user.id,
    user: {
      id: user.id,
      aud: 'authenticated',
      role: 'authenticated',
      email: user.email,
      email_confirmed_at: new Date().toISOString(),
      phone: '',
      created_at: user.created_at,
      updated_at: user.created_at,
      app_metadata: { provider: 'email', providers: ['email'] },
      user_metadata: user.raw_user_meta_data || {},
      identities: []
    }
  };
}

/* ---------- helpers ------------------------------------------------------ */
function send(res, status, body) {
  const payload = body === undefined ? '' : JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': '*',
    'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
    'Access-Control-Expose-Headers': '*'
  });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      try { resolve(raw ? JSON.parse(raw) : {}); } catch (e) { resolve({}); }
    });
  });
}

/* Run a statement as `authenticated` with auth.uid() bound, exactly like the
 * hosted project does when it decodes the JWT. */
async function asUser(uid, fn) {
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query('set local role authenticated');
    await client.query("select set_config('test.uid', $1, true)", [uid || '']);
    const out = await fn(client);
    await client.query('commit');
    return out;
  } catch (e) {
    try { await client.query('rollback'); } catch (_) {}
    throw e;
  } finally {
    client.release();
  }
}

/* ---------- routes ------------------------------------------------------- */
const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') return send(res, 204);

  const url = new URL(req.url, 'http://localhost');
  const path = url.pathname;
  const body = ['POST', 'PUT', 'PATCH'].includes(req.method) ? await readBody(req) : {};
  const bearer = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const claims = verify(bearer);

  try {
    /* ---- auth ---- */
    if (path === '/auth/v1/signup') {
      const email = String(body.email || '').toLowerCase().trim();
      const meta = (body.data || (body.options && body.options.data) || {});
      const dup = await pool.query('select 1 from auth.users where email=$1', [email]);
      if (dup.rowCount) {
        return send(res, 400, { code: 400, error_code: 'user_already_exists', msg: 'User already registered', message: 'User already registered' });
      }
      const ins = await pool.query(
        `insert into auth.users (email, encrypted_password, raw_user_meta_data)
         values ($1,$2,$3::jsonb) returning *`,
        [email, hash(body.password), JSON.stringify(meta)]
      );
      return send(res, 200, session(ins.rows[0]));
    }

    if (path === '/auth/v1/token') {
      const grant = url.searchParams.get('grant_type');
      if (grant === 'refresh_token') {
        const uid = String(body.refresh_token || '').replace(/^refresh-/, '');
        const r = await pool.query('select * from auth.users where id=$1', [uid]);
        if (!r.rowCount) return send(res, 400, { error: 'invalid_grant', error_description: 'Invalid Refresh Token', message: 'Invalid Refresh Token' });
        return send(res, 200, session(r.rows[0]));
      }
      const email = String(body.email || '').toLowerCase().trim();
      const r = await pool.query('select * from auth.users where email=$1', [email]);
      if (!r.rowCount || r.rows[0].encrypted_password !== hash(body.password)) {
        return send(res, 400, { error: 'invalid_grant', error_description: 'Invalid login credentials', message: 'Invalid login credentials', code: 400 });
      }
      return send(res, 200, session(r.rows[0]));
    }

    if (path === '/auth/v1/user' && req.method === 'GET') {
      if (!claims) return send(res, 401, { message: 'invalid claim' });
      const r = await pool.query('select * from auth.users where id=$1', [claims.sub]);
      if (!r.rowCount) return send(res, 401, { message: 'user not found' });
      return send(res, 200, session(r.rows[0]).user);
    }

    if (path === '/auth/v1/user' && req.method === 'PUT') {
      if (!claims) return send(res, 401, { message: 'invalid claim' });
      if (body.password) {
        await pool.query('update auth.users set encrypted_password=$2 where id=$1', [claims.sub, hash(body.password)]);
      }
      const r = await pool.query('select * from auth.users where id=$1', [claims.sub]);
      return send(res, 200, session(r.rows[0]).user);
    }

    if (path === '/auth/v1/logout') return send(res, 204);
    if (path === '/auth/v1/recover') return send(res, 200, {});

    /* ---- rest: rpc ---- */
    if (path.startsWith('/rest/v1/rpc/')) {
      const fn = path.slice('/rest/v1/rpc/'.length);
      const keys = Object.keys(body);
      const args = keys.map((k, i) => `${k} => $${i + 1}`).join(', ');
      const sql = `select public.${fn}(${args}) as out`;
      const uid = claims ? claims.sub : '';
      try {
        const out = await asUser(uid, (c) => c.query(sql, keys.map((k) => body[k])));
        return send(res, 200, out.rows[0].out);
      } catch (e) {
        return send(res, 400, {
          code: e.code || 'P0001',
          message: e.message,
          details: e.detail || null,
          hint: e.hint || null
        });
      }
    }

    /* ---- rest: direct table access (used to prove RLS blocks tampering) ---- */
    if (path.startsWith('/rest/v1/')) {
      const table = path.slice('/rest/v1/'.length);
      const uid = claims ? claims.sub : '';
      // Translate PostgREST `col=eq.value` filters into a WHERE clause.
      const where = []; const vals = [];
      for (const [k, v] of url.searchParams.entries()) {
        if (k === 'select' || k === 'limit' || k === 'offset' || k === 'order') continue;
        const m = /^eq\.(.*)$/.exec(v);
        if (m) { vals.push(m[1]); where.push(k + ' = $' + vals.length); }
      }
      let sql;
      if (req.method === 'GET') {
        sql = 'select * from public.' + table + (where.length ? ' where ' + where.join(' and ') : '') +
              ' limit ' + (parseInt(url.searchParams.get('limit'), 10) || 100);
      } else if (req.method === 'PATCH') {
        const sets = Object.keys(body).map((c) => { vals.push(body[c]); return c + ' = $' + vals.length; });
        sql = 'update public.' + table + ' set ' + sets.join(', ') +
              (where.length ? ' where ' + where.join(' and ') : '') + ' returning *';
      } else if (req.method === 'POST') {
        const cols = Object.keys(body);
        const ph = cols.map((c) => { vals.push(body[c]); return '$' + vals.length; });
        sql = 'insert into public.' + table + ' (' + cols.join(',') + ') values (' + ph.join(',') + ') returning *';
      } else if (req.method === 'DELETE') {
        sql = 'delete from public.' + table + (where.length ? ' where ' + where.join(' and ') : '') + ' returning *';
      } else {
        return send(res, 405, { message: 'method not allowed' });
      }
      try {
        const out = await asUser(uid, (c) => c.query(sql, vals));
        return send(res, req.method === 'POST' ? 201 : 200, out.rows);
      } catch (e) {
        return send(res, e.code === '42501' ? 403 : 400, {
          code: e.code || 'P0001', message: e.message, details: e.detail || null, hint: e.hint || null
        });
      }
    }

    return send(res, 404, { message: 'not found' });
  } catch (e) {
    return send(res, 500, { message: e.message });
  }
});

server.listen(PORT, () => {
  console.log('mock supabase listening on ' + PORT + ' (anon key: ' + ANON_KEY + ')');
});
