# bank-bill-parser (local webapp)

Local-first webapp to upload bank transaction CSVs and detect recurring bills/charges.

## Run

```bash
npm install
npm run dev
```

Then open the localhost URL it prints.

## Use

1. Download transactions from U.S. Bank as **CSV** (activity/transactions export).
2. Upload 1+ CSV files.
3. Map the **Date / Description / Amount** columns.
4. Click **Parse & detect recurring**.
5. Optionally **Export CSV** of detected recurring candidates.

## Notes

- This does **not** send files anywhere; parsing happens in-browser.
- **Password gate (optional):** set `VITE_GATE_PASSWORD` as an environment variable in Vercel (or in a local `.env`). If not set, the app has no gate.
  - This is a simple client-side gate for convenience, not strong security.

## Cloud sync (Supabase)

This app supports simple cloud save/load for decisions + category assignments.

### Env vars

Set in Vercel:

- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_ANON_KEY`

### Table

Create a table called `budget_states`:

```sql
create table if not exists public.budget_states (
  user_id uuid primary key references auth.users(id) on delete cascade,
  payload jsonb not null,
  updated_at timestamptz not null default now()
);

alter table public.budget_states enable row level security;

create policy "budget_states_owner_all" on public.budget_states
for all
using (auth.uid() = user_id)
with check (auth.uid() = user_id);
```

- Bank CSVs typically don’t include true “due dates”. For monthly charges we infer the **usual posting day-of-month**.
- PDF parsing can be added later (PDF.js), but CSV is the most reliable.
