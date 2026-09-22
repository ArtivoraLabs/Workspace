# DashView backend (server/)

Optional Node/Express API for accounts, projects, and the live Odoo proxy.
The rest of this repo (every `.html` page) works with zero backend — this
is only needed for real user accounts and the **Odoo (Live)** dashboard tab.

## Run

```bash
cp .env.example .env   # then fill in JWT_SECRET etc — see comments in the file
npm install
npm start               # http://localhost:4000
```

`GET /api/health` should return `{"ok":true}` once it's up.

## What's here

- `src/index.js` — Express entrypoint, CORS, route mounting
- `src/routes/auth.routes.js` — register/login, issues JWT session tokens
- `src/routes/odoo.routes.js` — authenticated proxy to a user's Odoo
  instance (`/test`, `/modules`, `/models`, `/fields`, `/records`,
  `/read-group`); Odoo credentials are sent per-request from the frontend,
  never stored server-side
- `src/services/odooClient.js` — raw Odoo JSON-RPC calls (auth, `search_read`,
  `read_group`)
- `src/db/` — SQLite (via `better-sqlite3`) for accounts/projects only;
  `migrate.js` runs automatically on boot

See `../ODOO_SETUP.md` at the repo root for the full Odoo connectivity
walkthrough and production-deployment notes.
