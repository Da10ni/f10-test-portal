/* eslint-disable */
/**
 * F-10 test portal — a fake login site for exercising SSPOM session management.
 *
 *   node f10-test-portal/server.js          (listens on :4000)
 *   PORT=5055 node f10-test-portal/server.js
 *
 * Why this exists
 * ---------------
 * The session feature was being tested against the-internet.herokuapp.com,
 * which is fine for the happy path but cannot exercise the cases that actually
 * matter: a session EXPIRING mid-flight, a portal revoking sessions server-side,
 * or a login that suddenly demands a CAPTCHA. Those need a portal we control.
 *
 * Deliberate design choices
 * -------------------------
 *  - Zero dependencies. Node's own http module only, so there is no install
 *    step and nothing to keep in sync with the rest of the repo.
 *  - The credentials and the form's element ids (#username, #password,
 *    button[type=submit]) match the herokuapp ones EXACTLY, so an existing
 *    workflow can be pointed here by changing only the URL.
 *  - /secure redirects to /login when unauthenticated. The bot's login
 *    detection keys off the URL containing "/login", so this is what makes
 *    skip_re_login work.
 *  - Binds 0.0.0.0 so a bot running in Docker can reach it via
 *    host.docker.internal.
 *
 * Test knobs live at GET /admin (also driveable over HTTP for scripting):
 *   POST /admin/ttl?seconds=30     session lifetime — set it low to watch a
 *                                  session expire between two runs
 *   POST /admin/captcha?on=1       force a CAPTCHA on the login form
 *   POST /admin/kill-sessions      revoke every session server-side, the way a
 *                                  real portal does when it logs you out
 */
'use strict';

const http = require('http');
const crypto = require('crypto');

const PORT = Number(process.env.PORT || 4000);

const USERNAME = 'tomsmith';
const PASSWORD = 'SuperSecretPassword!';
const COOKIE = 'portal.sid';

/** sid -> { user, expiresAt } — in-memory on purpose; a restart is a clean slate. */
const sessions = new Map();

/**
 * ref -> { title, notes, priority, user, sid, createdAt } — the "work" a bot does.
 *
 * Login alone is a one-step workflow, which is too thin to test anything
 * interesting: it cannot show a bot filling a form, and with several bots
 * draining one queue there is nothing on the portal to tell you WHICH bot did
 * WHICH row. Every todo records the session that created it, so after a
 * multi-bot run /todos is the proof: the same job's rows carry two different
 * session ids.
 */
const todos = new Map();
let todoSeq = 0;

const settings = {
  // How long a portal login lives. Eight hours by default: long enough that a
  // testing session outlives the logins it authenticated. At ten minutes the
  // operator's Sessions kept vanishing mid-test — not a bug, the pool correctly
  // drops a Session five minutes before its portal cookie dies — but it meant
  // re-authenticating constantly instead of testing.
  //
  // Settable per deployment so a hosted copy does not need a code change, and
  // still changeable at runtime to watch an expiry on purpose:
  //   POST /admin/ttl?seconds=60
  // Restarting this portal wipes every session anyway (they are in memory).
  ttlSeconds: Number(process.env.PORTAL_TTL_SECONDS || 28800),
  captchaEnabled: false,
};

let stats = { logins: 0, skipped: 0, rejected: 0, expired: 0 };

// ── helpers ──────────────────────────────────────────────────────────────────

const parseCookies = (req) =>
  Object.fromEntries(
    (req.headers.cookie || '')
      .split(';')
      .map((c) => c.trim())
      .filter(Boolean)
      .map((c) => {
        const i = c.indexOf('=');
        return i === -1 ? [c, ''] : [c.slice(0, i), decodeURIComponent(c.slice(i + 1))];
      }),
  );

const readBody = (req) =>
  new Promise((resolve) => {
    let b = '';
    req.on('data', (c) => {
      b += c;
      if (b.length > 1e6) req.destroy();
    });
    req.on('end', () => resolve(Object.fromEntries(new URLSearchParams(b))));
  });

/**
 * Resolve the caller's session. Expiry is enforced HERE, server-side, rather
 * than trusting the cookie's Max-Age — that is what makes a short TTL a real
 * test: the browser happily replays a cookie the portal has already rejected,
 * which is exactly the situation ERR_SESSION_EXPIRED exists to handle.
 */
const currentSession = (req) => {
  const sid = parseCookies(req)[COOKIE];
  if (!sid) return null;
  const s = sessions.get(sid);
  if (!s) return null;
  if (Date.now() > s.expiresAt) {
    sessions.delete(sid);
    stats.expired += 1;
    return null;
  }
  return { sid, ...s };
};

const send = (res, status, body, headers = {}) => {
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(body);
};

const redirect = (res, to, headers = {}) => {
  res.writeHead(302, { Location: to, 'Cache-Control': 'no-store', ...headers });
  res.end();
};

const page = (title, accent, inner) => `<!doctype html>
<html><head><meta charset="utf-8"><title>${title}</title><style>
  body{font-family:system-ui,Segoe UI,Arial,sans-serif;margin:0;background:#f4f6f8;
       display:flex;align-items:center;justify-content:center;min-height:100vh}
  .card{background:#fff;padding:44px 52px;border-radius:14px;
        box-shadow:0 8px 30px rgba(0,0,0,.10);min-width:420px}
  h1{margin:0 0 6px;font-size:30px;color:${accent}}
  .sub{color:#667;margin:0 0 26px;font-size:15px}
  label{display:block;margin:16px 0 6px;font-weight:600;color:#334;font-size:14px}
  input{width:100%;padding:11px 13px;border:1px solid #cbd3dc;border-radius:7px;
        font-size:15px;box-sizing:border-box}
  button{margin-top:24px;width:100%;padding:13px;border:0;border-radius:7px;
         background:${accent};color:#fff;font-size:16px;font-weight:600;cursor:pointer}
  .err{background:#fdecea;color:#a3231a;padding:11px 14px;border-radius:7px;
       margin-bottom:18px;font-size:14px}
  .ok{background:#e7f6ec;color:#14652f;padding:11px 14px;border-radius:7px;
      margin-bottom:18px;font-size:14px}
  code{background:#eef1f4;padding:2px 6px;border-radius:4px;font-size:13px}
  .creds{background:#eef4fc;border:1px dashed #9fb8dd;color:#22406e;
         padding:12px 14px;border-radius:7px;margin-bottom:20px;
         font-size:14px;line-height:1.9}
  a{color:${accent}}
  table{width:100%;border-collapse:collapse;font-size:14px}
  td{padding:7px 0;border-bottom:1px solid #eef1f4}
  td:last-child{text-align:right;font-weight:600}
</style></head><body><div class="card">${inner}</div></body></html>`;

// ── routes ───────────────────────────────────────────────────────────────────

const loginPage = (msg) => {
  // The CAPTCHA is intentionally trivial to solve BY HAND and impossible to
  // solve by a scripted step — that asymmetry is the point: it forces the run
  // into the human-action path instead of quietly succeeding.
  const a = 1 + Math.floor(Math.random() * 8);
  const b = 1 + Math.floor(Math.random() * 8);
  const captcha = settings.captchaEnabled
    ? `<label for="captcha">Security check: what is ${a} + ${b}?</label>
       <input id="captcha" name="captcha" autocomplete="off">
       <input type="hidden" name="expected" value="${a + b}">`
    : '';

  return page(
    'Portal Login',
    '#1f4e9c',
    `<h1>Portal Login</h1>
     <p class="sub">F-10 test portal</p>
     <div class="creds">
       Username <code>${USERNAME}</code><br>
       Password <code>${PASSWORD}</code>
     </div>
     ${msg ? `<div class="err">${msg}</div>` : ''}
     <form method="POST" action="/login" autocomplete="off">
       <label for="username">Username</label>
       <input id="username" name="username" autocomplete="off">
       <label for="password">Password</label>
       <!-- autocomplete="new-password" is the one token Chrome actually
            honours on a password field. Plain "off" is ignored on login forms,
            and Chrome was silently filling a stale saved password here, which
            looked like the portal rejecting valid credentials. -->
       <input id="password" name="password" type="password" autocomplete="new-password">
       ${captcha}
       <button type="submit">Login</button>
     </form>`,
  );
};

const securePage = (s) => {
  const left = Math.max(0, Math.round((s.expiresAt - Date.now()) / 1000));
  return page(
    'Secure Area',
    '#14652f',
    `<h1>Welcome to the Secure Area!</h1>
     <p class="sub">Tum andar ho — bina dobara login kiye.</p>
     <div class="ok">Logged in as <b>${s.user}</b></div>
     <table>
       <tr><td>Session id</td><td><code>${s.sid.slice(0, 16)}…</code></td></tr>
       <tr><td>Expires in</td><td>${left}s</td></tr>
     </table>
     <p class="sub" style="margin-top:22px">
       <a href="/todos">Todo list</a> &nbsp;·&nbsp;
       <a href="/todos/new">New todo</a> &nbsp;·&nbsp;
       <a href="/logout">Logout</a> &nbsp;·&nbsp; <a href="/admin">Admin</a>
     </p>`,
  );
};

/** Escape anything that came from a form before it goes back into HTML. */
const esc = (v) =>
  String(v ?? '').replace(/[&<>"]/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c],
  );

/**
 * The form a bot fills. Field ids (#title, #notes, #priority) are stable and
 * boring on purpose — a workflow addresses them by id, so renaming one silently
 * breaks every saved workflow.
 */
const newTodoPage = (s) =>
  page(
    'New Todo',
    '#1f4e9c',
    `<h1>New Todo</h1>
     <p class="sub">F-10 test portal &mdash; create a task</p>
     <div class="ok">Logged in as <b>${esc(s.user)}</b> &middot; session <code>${s.sid.slice(0, 12)}…</code></div>
     <form method="POST" action="/todos" autocomplete="off">
       <label for="title">Title</label>
       <input id="title" name="title" autocomplete="off">
       <label for="notes">Notes</label>
       <input id="notes" name="notes" autocomplete="off">
       <label for="priority">Priority</label>
       <select id="priority" name="priority"
               style="width:100%;padding:11px 13px;border:1px solid #cbd3dc;border-radius:7px;font-size:15px;box-sizing:border-box">
         <option value="low">low</option>
         <option value="normal" selected>normal</option>
         <option value="high">high</option>
       </select>
       <button type="submit">Create Todo</button>
     </form>
     <p class="sub" style="margin-top:22px">
       <a href="/todos">All todos</a> &nbsp;&middot;&nbsp; <a href="/secure">Secure area</a>
     </p>`,
  );

/**
 * Confirmation page. The reference is what a workflow asserts on to prove the
 * row was really submitted — a page that merely stopped erroring is not proof.
 */
const todoDetailPage = (t) =>
  page(
    `Todo ${t.ref}`,
    '#14652f',
    `<h1>Todo created</h1>
     <p class="sub">Task saved successfully</p>
     <div class="ok">Reference <b id="reference">${t.ref}</b></div>
     <table>
       <tr><td>Title</td><td>${esc(t.title)}</td></tr>
       <tr><td>Notes</td><td>${esc(t.notes)}</td></tr>
       <tr><td>Priority</td><td>${esc(t.priority)}</td></tr>
       <tr><td>Created by session</td><td><code>${t.sid.slice(0, 12)}…</code></td></tr>
     </table>
     <p class="sub" style="margin-top:22px">
       <a href="/todos/new">Create another</a> &nbsp;&middot;&nbsp; <a href="/todos">All todos</a>
     </p>`,
  );

/**
 * Every todo, newest first, with the session that created it.
 *
 * This is the multi-bot readout: run one job with two bots and this page shows
 * its rows split across two session ids. One session id for every row means the
 * bots were not actually sharing the work.
 */
const todosPage = () => {
  const rows = [...todos.values()].sort((a, b) => b.createdAt - a.createdAt);
  const bySession = new Map();
  for (const t of rows) bySession.set(t.sid, (bySession.get(t.sid) ?? 0) + 1);

  const list = rows.length
    ? rows
        .map(
          (t) =>
            `<tr><td><a href="/todos/${t.ref}">${t.ref}</a> &nbsp; ${esc(t.title)}</td>
             <td><code>${t.sid.slice(0, 8)}…</code></td></tr>`,
        )
        .join('')
    : '<tr><td colspan="2" style="color:#889">No todos yet</td></tr>';

  const split = [...bySession.entries()]
    .map(([sid, n]) => `<code>${sid.slice(0, 8)}…</code> &rarr; ${n}`)
    .join('<br>');

  return page(
    'Todos',
    '#1f4e9c',
    `<h1>Todos</h1>
     <p class="sub">${rows.length} total &mdash; created by ${bySession.size} session(s)</p>
     ${bySession.size ? `<div class="ok">Per session:<br>${split}</div>` : ''}
     <table>${list}</table>
     <p class="sub" style="margin-top:22px">
       <a href="/todos/new">New todo</a> &nbsp;&middot;&nbsp; <a href="/admin">Admin</a>
     </p>`,
  );
};

const adminPage = () =>
  page(
    'Test Portal Admin',
    '#7a3ea3',
    `<h1>Test Portal Admin</h1>
     <p class="sub">Session management ke edge cases yahan se chalao</p>
     <table>
       <tr><td>Session TTL</td><td>${settings.ttlSeconds}s</td></tr>
       <tr><td>CAPTCHA</td><td>${settings.captchaEnabled ? 'ON' : 'OFF'}</td></tr>
       <tr><td>Active sessions</td><td>${sessions.size}</td></tr>
       <tr><td>Logins</td><td>${stats.logins}</td></tr>
       <tr><td>Rejected</td><td>${stats.rejected}</td></tr>
       <tr><td>Expired</td><td>${stats.expired}</td></tr>
       <tr><td>Todos</td><td>${todos.size}</td></tr>
     </table>
     <p class="sub"><a href="/todos">View todos</a> (per-session split)</p>
     <form method="POST" action="/admin/ttl">
       <label for="seconds">Session TTL (seconds)</label>
       <input id="seconds" name="seconds" value="${settings.ttlSeconds}">
       <button type="submit">Set TTL</button>
     </form>
     <form method="POST" action="/admin/captcha">
       <input type="hidden" name="on" value="${settings.captchaEnabled ? '0' : '1'}">
       <button type="submit">Turn CAPTCHA ${settings.captchaEnabled ? 'OFF' : 'ON'}</button>
     </form>
     <form method="POST" action="/admin/kill-sessions">
       <button type="submit">Kill all sessions</button>
     </form>
     <form method="POST" action="/admin/clear-todos">
       <button type="submit" style="background:#7a3ea3">Clear all todos</button>
     </form>`,
  );

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const path = url.pathname;
  const method = req.method || 'GET';

  if (path === '/health') {
    return send(
      res,
      200,
      JSON.stringify({ status: 'ok', sessions: sessions.size, settings, stats }),
      { 'Content-Type': 'application/json' },
    );
  }

  if (path === '/' ) return redirect(res, '/secure');

  if (path === '/login' && method === 'GET') {
    // Already authenticated? Send them straight in. This mirrors how real
    // portals behave and is what lets a workflow's login step be skipped.
    return currentSession(req) ? redirect(res, '/secure') : send(res, 200, loginPage(null));
  }

  if (path === '/login' && method === 'POST') {
    const body = await readBody(req);

    if (settings.captchaEnabled && String(body.captcha ?? '').trim() !== String(body.expected)) {
      stats.rejected += 1;
      return send(res, 200, loginPage('Security check failed. Please try again.'));
    }

    if (body.username !== USERNAME || body.password !== PASSWORD) {
      stats.rejected += 1;
      return send(res, 200, loginPage('Your username or password is invalid!'));
    }

    const sid = crypto.randomBytes(24).toString('hex');
    sessions.set(sid, { user: body.username, expiresAt: Date.now() + settings.ttlSeconds * 1000 });
    stats.logins += 1;

    // HttpOnly + Max-Age so Playwright's storageState captures it as a real,
    // persistable portal cookie rather than an in-memory session cookie.
    return redirect(res, '/secure', {
      'Set-Cookie': `${COOKIE}=${sid}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${settings.ttlSeconds}`,
    });
  }

  if (path === '/secure') {
    // Log what actually arrived. "Bot got bounced to /login" has three very
    // different causes — no cookie sent at all, a cookie for a session the
    // portal no longer knows, or a genuinely expired one — and they are
    // indistinguishable from the bot's side. This line names which it was.
    const sid = parseCookies(req)[COOKIE];
    const s = currentSession(req);
    console.log(
      `[portal] GET /secure  cookie=${sid ? sid.slice(0, 12) + '…' : 'NONE'}  ` +
        `→ ${s ? 'ANDAR (logged in)' : sid ? 'REJECTED (sid ajnabi ya khatam)' : 'BAHAR (cookie aayi hi nahi)'}`,
    );
    if (!s) return redirect(res, '/login');
    stats.skipped += 1;
    return send(res, 200, securePage(s));
  }

  // ── todos ──────────────────────────────────────────────────────────────────
  // All of these bounce to /login when unauthenticated, exactly like /secure —
  // that redirect is what the bot's login check keys off, so a todo workflow
  // gets session handling for free.

  if (path === '/todos/new' && method === 'GET') {
    const s = currentSession(req);
    console.log(
      `[portal] GET /todos/new → ${s ? 'ANDAR (session ' + s.sid.slice(0, 8) + '…)' : 'BAHAR → /login'}`,
    );
    if (!s) return redirect(res, '/login');
    return send(res, 200, newTodoPage(s));
  }

  if (path === '/todos' && method === 'POST') {
    const s = currentSession(req);
    if (!s) return redirect(res, '/login');
    const body = await readBody(req);
    const title = String(body.title ?? '').trim();
    if (!title) {
      // A blank title is the one input error worth modelling: it returns the
      // form rather than a reference, so a workflow asserting on the reference
      // fails honestly instead of reporting a row it never created.
      return send(res, 200, newTodoPage(s).replace('<h1>New Todo</h1>',
        '<h1>New Todo</h1><div class="err">Title is required.</div>'));
    }
    todoSeq += 1;
    const ref = `TD-${String(todoSeq).padStart(4, '0')}`;
    const todo = {
      ref,
      title,
      notes: String(body.notes ?? '').trim(),
      priority: String(body.priority ?? 'normal'),
      user: s.user,
      sid: s.sid,
      createdAt: Date.now(),
    };
    todos.set(ref, todo);
    console.log(
      `[portal] todo ${ref} "${title}" created by session ${s.sid.slice(0, 8)}…`,
    );
    return redirect(res, `/todos/${ref}`);
  }

  if (path.startsWith('/todos/') && method === 'GET') {
    const s = currentSession(req);
    if (!s) return redirect(res, '/login');
    const ref = path.slice('/todos/'.length);
    const t = todos.get(ref);
    if (!t) return send(res, 404, page('Not found', '#a3231a', '<h1>No such todo</h1>'));
    return send(res, 200, todoDetailPage(t));
  }

  if (path === '/todos' && method === 'GET') {
    const s = currentSession(req);
    if (!s) return redirect(res, '/login');
    return send(res, 200, todosPage());
  }

  if (path === '/logout') {
    const s = currentSession(req);
    if (s) sessions.delete(s.sid);
    return redirect(res, '/login', { 'Set-Cookie': `${COOKIE}=; Path=/; Max-Age=0` });
  }

  if (path === '/admin' && method === 'GET') return send(res, 200, adminPage());

  if (path === '/admin/ttl' && method === 'POST') {
    const body = await readBody(req);
    const n = parseInt(body.seconds ?? url.searchParams.get('seconds'), 10);
    if (Number.isFinite(n) && n > 0) settings.ttlSeconds = n;
    console.log(`[portal] session TTL = ${settings.ttlSeconds}s`);
    return redirect(res, '/admin');
  }

  if (path === '/admin/captcha' && method === 'POST') {
    const body = await readBody(req);
    const on = (body.on ?? url.searchParams.get('on')) === '1';
    settings.captchaEnabled = on;
    console.log(`[portal] CAPTCHA = ${on ? 'ON' : 'OFF'}`);
    return redirect(res, '/admin');
  }

  if (path === '/admin/kill-sessions' && method === 'POST') {
    const n = sessions.size;
    sessions.clear();
    console.log(`[portal] revoked ${n} session(s)`);
    return redirect(res, '/admin');
  }

  // Wipe the todos between test rounds so a run's output is unambiguous — old
  // rows from a previous round would otherwise muddy the per-session split.
  if (path === '/admin/clear-todos' && method === 'POST') {
    const n = todos.size;
    todos.clear();
    todoSeq = 0;
    console.log(`[portal] cleared ${n} todo(s)`);
    return redirect(res, '/todos');
  }

  send(res, 404, page('Not found', '#a3231a', '<h1>404</h1>'));
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`F-10 test portal → http://localhost:${PORT}`);
  console.log(`  login   : http://localhost:${PORT}/login   (${USERNAME} / ${PASSWORD})`);
  console.log(`  secure  : http://localhost:${PORT}/secure`);
  console.log(`  todo    : http://localhost:${PORT}/todos/new   (multi-step form)`);
  console.log(`  todos   : http://localhost:${PORT}/todos       (who created what)`);
  console.log(`  admin   : http://localhost:${PORT}/admin`);
  console.log(`  docker  : http://host.docker.internal:${PORT}`);
});
