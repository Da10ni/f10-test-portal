# Hosting the F-10 test portal

The portal keeps everything in memory — who is logged in (`sessions`) and every
todo (`todos`). That is deliberate: a restart wipes the state, which is exactly
what you want from a disposable test portal.

It is also why the host has to run a **persistent Node process**. On a
serverless host (Netlify Functions, Vercel Functions, Lambda) each request may
land on a different instance, so a bot that logged in on one request is
"logged out" on the next. The login-skip this portal exists to demonstrate would
look broken while working perfectly. Render, Railway and Fly.io all run a real
process; the steps below use Render.

## Deploy to Render

The app has **no dependencies** and reads `PORT` from the environment, so there
is nothing to build.

### 1. Put this folder in its own Git repo

```bash
cd f10-test-portal
git init
git add .
git commit -m "F-10 test portal"
gh repo create f10-test-portal --private --source=. --push
```

(or create the repo on github.com and `git remote add origin … && git push -u origin main`)

### 2. Create the service on Render

1. https://dashboard.render.com → **New** → **Web Service**
2. Connect the repo
3. Render reads `render.yaml` and fills everything in. If you do it by hand:

   | Field | Value |
   |---|---|
   | Runtime | Node |
   | Build command | *(leave empty)* |
   | Start command | `npm start` |
   | Health check path | `/login` |

4. **Create Web Service**. First deploy takes about a minute.

You get a URL like `https://f10-test-portal.onrender.com`.

### 3. Check it

```
https://<your-url>/login      tomsmith / SuperSecretPassword!
https://<your-url>/todos      the multi-bot readout
https://<your-url>/admin      clear todos, change TTL
```

## Settings

| Env var | Default | Meaning |
|---|---|---|
| `PORT` | 4000 | Set by Render automatically |
| `PORTAL_TTL_SECONDS` | 28800 (8 h) | How long a portal login lives |

TTL is also changeable at runtime from `/admin` without a redeploy — useful for
watching a session lapse on purpose.

## The free plan sleeps

Render's free plan stops the service after ~15 minutes with no traffic, and the
next request cold-starts it (~30–60 s). **A restart clears `sessions` and
`todos`**, so a Session you authenticated before the idle period no longer
matches any portal login: the bot detects that and logs in again. Nothing
breaks, but a login-skip test spanning an idle gap will not show the skip.

Two ways around it:

- Keep the paid instance type ($7/mo), which never sleeps, or
- hit any URL every ~10 minutes to keep it warm.

## After deploying: point the workflow at it

The workflow's navigate steps (1 and 5) still say
`http://host.docker.internal:4000/todos/new`. Two things must change together:

1. Both step URLs → `https://<your-url>/todos/new`
2. The cookie domain stored with each Session — a cookie saved for `localhost`
   is not sent to `onrender.com`, so a restored Session would look logged out
   and every row would re-login.

Sessions authenticated against the local portal do not carry over; authenticate
fresh ones against the hosted URL.
