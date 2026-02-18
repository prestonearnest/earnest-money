import { useEffect, useMemo, useState } from 'react'
import './App.css'
import { detectRecurring, guessColumnMap, parseCsvFiles, type ColumnMap, type RecurringGroup, type Tx } from './lib'
import { supabase } from './supabase'
import { DEFAULT_CATEGORIES, type Category } from './categories'

type Stage = 'upload' | 'map' | 'results'

type Decision = 'bill' | 'subscription' | 'no' | 'unset'

type DecisionsMap = Record<string, Decision>

type CategoryMap = Record<string, Category>

type Tab = 'review' | 'bills' | 'subs' | 'plan' | 'upload'

const GATE_PASSWORD = import.meta.env.VITE_GATE_PASSWORD as string | undefined
const LS_KEY = 'bbp_authed_v1'
const LS_DECISIONS = 'bbp_decisions_v1'
const LS_CATEGORIES = 'bbp_categories_v1'
const LS_TAB = 'bbp_tab_v1'

export default function App() {
  const [authed, setAuthed] = useState(() => {
    if (!GATE_PASSWORD) return true
    return localStorage.getItem(LS_KEY) === '1'
  })

  const [theme, setTheme] = useState<'light' | 'dark'>(() => (localStorage.getItem('bbp_theme_v1') as any) || 'light')
  useEffect(() => {
    document.documentElement.dataset.theme = theme
    localStorage.setItem('bbp_theme_v1', theme)
  }, [theme])

  const [tab, setTab] = useState<Tab>(() => (localStorage.getItem(LS_TAB) as Tab) || 'review')

  const [decisions, setDecisions] = useState<DecisionsMap>(() => {
    try {
      return JSON.parse(localStorage.getItem(LS_DECISIONS) ?? '{}') as DecisionsMap
    } catch {
      return {}
    }
  })

  const [categoryMap, setCategoryMap] = useState<CategoryMap>(() => {
    try {
      return JSON.parse(localStorage.getItem(LS_CATEGORIES) ?? '{}') as CategoryMap
    } catch {
      return {}
    }
  })

  function setDecision(key: string, d: Decision) {
    const next = { ...decisions, [key]: d }
    setDecisions(next)
    localStorage.setItem(LS_DECISIONS, JSON.stringify(next))
  }

  function setCategory(key: string, cat: Category) {
    const next = { ...categoryMap, [key]: cat }
    setCategoryMap(next)
    localStorage.setItem(LS_CATEGORIES, JSON.stringify(next))
  }

  useEffect(() => {
    localStorage.setItem(LS_TAB, tab)
  }, [tab])

  const [stage, setStage] = useState<Stage>('upload')
  const [files, setFiles] = useState<File[]>([])
  const [headers, setHeaders] = useState<string[]>([])
  const [columnMap, setColumnMap] = useState<ColumnMap | null>(null)
  const [expenseSign, setExpenseSign] = useState<'auto' | 'negative' | 'positive'>('auto')

  const [txs, setTxs] = useState<Tx[]>([])
  const [groups, setGroups] = useState<RecurringGroup[]>([])

  const [userEmail, setUserEmail] = useState<string>('')
  const [authStatus, setAuthStatus] = useState<'disabled' | 'signedout' | 'signedin'>('disabled')
  const [minCount, setMinCount] = useState(3)
  const [query, setQuery] = useState('')

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return groups
    return groups.filter((g) => g.merchant.toLowerCase().includes(q) || g.merchantKey.includes(q))
  }, [groups, query])

  const decidedGroups = useMemo(() => {
    return filtered.map((g) => {
      const d = decisions[g.merchantKey] ?? 'unset'
      const kind = d === 'bill' ? 'bill' : d === 'subscription' ? 'subscription' : d === 'no' ? 'unknown' : g.kind
      const cat = categoryMap[g.merchantKey]
      return { ...g, kind, _decision: d, _category: cat }
    })
  }, [filtered, decisions, categoryMap])

  async function readFirstHeaders(file: File) {
    const text = await file.text()
    const firstLine = text.split(/\r?\n/)[0] ?? ''
    // naive csv header split; good enough for mapping UI
    const cols = firstLine
      .split(',')
      .map((s) => s.replace(/^"|"$/g, '').trim())
      .filter(Boolean)
    setHeaders(cols)

    const guess = guessColumnMap(cols)
    setColumnMap(guess)
  }

  async function onChooseFiles(list: FileList | null) {
    if (!list || list.length === 0) return
    const arr = Array.from(list).filter((f) => f.name.toLowerCase().endsWith('.csv'))
    setFiles(arr)
    if (arr[0]) await readFirstHeaders(arr[0])
    setStage('map')
  }

  async function run() {
    if (!columnMap) return
    const parsed = await parseCsvFiles(files, columnMap, { expenseSign })
    setTxs(parsed)
    const recurring = detectRecurring(parsed, { minCount })
    setGroups(recurring)
    setStage('results')
    setTab('review')
  }

  function downloadCsv() {
    const rows = filtered.map((g) => ({
      merchant: g.merchant,
      cadence: g.cadence,
      typicalAmount: round2(g.typicalAmount),
      amountMad: round2(g.amountMad),
      count: g.count,
      usualDayOfMonth: g.usualDayOfMonth ?? '',
    }))

    const header = Object.keys(rows[0] ?? { merchant: '', cadence: '', typicalAmount: '', amountMad: '', count: '', usualDayOfMonth: '' })
    const csv = [header.join(','), ...rows.map((r) => header.map((k) => safeCsv(String((r as any)[k] ?? ''))).join(','))].join('\n')
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'recurring-bills.csv'
    a.click()
    URL.revokeObjectURL(url)
  }

  useEffect(() => {
    if (!supabase) {
      setAuthStatus('disabled')
      return
    }

    supabase.auth.getSession().then(({ data }) => {
      setAuthStatus(data.session ? 'signedin' : 'signedout')
    })

    const { data: sub } = supabase.auth.onAuthStateChange((_evt, session) => {
      setAuthStatus(session ? 'signedin' : 'signedout')
    })

    return () => {
      sub.subscription.unsubscribe()
    }
  }, [])

  async function saveToCloud() {
    if (!supabase) return alert('Cloud sync not configured (missing Supabase env vars).')
    const { data } = await supabase.auth.getSession()
    if (!data.session) return alert('Sign in first.')

    const payload = {
      decisions,
      categories: categoryMap,
      updatedAt: new Date().toISOString(),
    }

    const { error } = await supabase.from('budget_states').upsert({ user_id: data.session.user.id, payload }, { onConflict: 'user_id' })
    if (error) alert(`Cloud save failed: ${error.message}`)
    else alert('Saved to cloud.')
  }

  async function loadFromCloud() {
    if (!supabase) return alert('Cloud sync not configured (missing Supabase env vars).')
    const { data } = await supabase.auth.getSession()
    if (!data.session) return alert('Sign in first.')

    const { data: row, error } = await supabase.from('budget_states').select('payload').eq('user_id', data.session.user.id).maybeSingle()
    if (error) return alert(`Cloud load failed: ${error.message}`)
    if (!row?.payload) return alert('No saved data yet.')

    const p = row.payload as any
    if (p.decisions) {
      setDecisions(p.decisions)
      localStorage.setItem(LS_DECISIONS, JSON.stringify(p.decisions))
    }
    if (p.categories) {
      setCategoryMap(p.categories)
      localStorage.setItem(LS_CATEGORIES, JSON.stringify(p.categories))
    }
    alert('Loaded from cloud.')
  }

  if (!authed) {
    return (
      <div className="wrap">
        <header className="header">
          <div>
            <h1>Budget Builder</h1>
            <p className="sub">This app is password-protected.</p>
          </div>
        </header>

        <section className="card">
          <h2>Enter password</h2>
          <Gate
            onAuthed={() => {
              localStorage.setItem(LS_KEY, '1')
              setAuthed(true)
            }}
          />
          <p className="small">
            Note: this is a simple client-side gate for convenience (not bank-grade security). Don’t upload files on shared/public computers.
          </p>
        </section>
      </div>
    )
  }

  return (
    <div className="appShell">
      <aside className="sidebar">
        <div className="brand">
          <div className="logo" />
          <div>
            <div>Budget Builder</div>
            <div className="sub" style={{ marginTop: 2 }}>Plan your month</div>
          </div>
        </div>

        <nav className="nav">
          {(
            [
              { id: 'review', label: 'Budget' },
              { id: 'bills', label: 'Bills' },
              { id: 'subs', label: 'Subscriptions' },
              { id: 'plan', label: 'Plan' },
              { id: 'upload', label: 'Upload' },
            ] as const
          ).map((t) => (
            <button key={t.id} className={`navItem ${tab === t.id ? 'active' : ''}`} onClick={() => setTab(t.id)} type="button">
              {t.label}
            </button>
          ))}
        </nav>
      </aside>

      <main className="main">
        <div className="wrap">
          <header className="header">
            <div>
              <h1>January</h1>
              <p className="sub">Your budget workspace (prototype)</p>
            </div>
          </header>

          <section className="topbar">
            <div className="row" style={{ gap: 8 }}>
              <button className="btn secondary" type="button" onClick={() => setTheme((t) => (t === 'light' ? 'dark' : 'light'))}>
                {theme === 'light' ? 'Dark' : 'Light'}
              </button>
            </div>
        <div className="tabs">
          {(
            [
              { id: 'review', label: 'Review' },
              { id: 'bills', label: 'Bills' },
              { id: 'subs', label: 'Subscriptions' },
              { id: 'plan', label: 'Plan' },
              { id: 'upload', label: 'Upload' },
            ] as const
          ).map((t) => (
            <button key={t.id} className={`tab ${tab === t.id ? 'active' : ''}`} onClick={() => setTab(t.id)} type="button">
              {t.label}
            </button>
          ))}
        </div>

        <div className="auth">
          {authStatus === 'disabled' && <span className="small">Cloud: not configured</span>}
          {authStatus !== 'disabled' && (
            <>
              {authStatus === 'signedin' ? (
                <>
                  <button className="btn secondary" onClick={() => void loadFromCloud()} type="button">
                    Load
                  </button>
                  <button className="btn" onClick={() => void saveToCloud()} type="button">
                    Save
                  </button>
                  <button
                    className="btn secondary"
                    onClick={() =>
                      void (async () => {
                        await supabase?.auth.signOut()
                      })()
                    }
                    type="button"
                  >
                    Sign out
                  </button>
                </>
              ) : (
                <>
                  <input className="email" placeholder="Email for magic link" value={userEmail} onChange={(e) => setUserEmail(e.target.value)} />
                  <button
                    className="btn"
                    onClick={() =>
                      void (async () => {
                        const email = userEmail.trim()
                        if (!email) return
                        const { error } = await supabase!.auth.signInWithOtp({ email })
                        if (error) alert(error.message)
                        else alert('Check your email for the sign-in link.')
                      })()
                    }
                    type="button"
                  >
                    Sign in
                  </button>
                </>
              )}
            </>
          )}
        </div>
      </section>

      {stage === 'upload' && tab === 'upload' && (
        <section className="card">
          <h2>Upload statements (CSV)</h2>
          <p>Upload 1–3 months of U.S. Bank CSV exports.</p>
          <input type="file" accept=".csv,text/csv" multiple onChange={(e) => void onChooseFiles(e.target.files)} />
        </section>
      )}

      {stage === 'map' && tab === 'upload' && (
        <section className="card">
          <h2>2) Map columns</h2>
          <div className="grid">
            <label>
              Date column
              <select value={columnMap?.date ?? ''} onChange={(e) => setColumnMap((m) => ({ ...(m ?? ({} as any)), date: e.target.value }))}>
                <option value="">—</option>
                {headers.map((h) => (
                  <option key={h} value={h}>
                    {h}
                  </option>
                ))}
              </select>
            </label>

            <label>
              Description column
              <select
                value={columnMap?.description ?? ''}
                onChange={(e) => setColumnMap((m) => ({ ...(m ?? ({} as any)), description: e.target.value }))}
              >
                <option value="">—</option>
                {headers.map((h) => (
                  <option key={h} value={h}>
                    {h}
                  </option>
                ))}
              </select>
            </label>

            <label>
              Amount column
              <select value={columnMap?.amount ?? ''} onChange={(e) => setColumnMap((m) => ({ ...(m ?? ({} as any)), amount: e.target.value }))}>
                <option value="">—</option>
                {headers.map((h) => (
                  <option key={h} value={h}>
                    {h}
                  </option>
                ))}
              </select>
            </label>

            <label>
              Expense sign
              <select value={expenseSign} onChange={(e) => setExpenseSign(e.target.value as any)}>
                <option value="auto">Auto-detect</option>
                <option value="negative">Expenses are negative</option>
                <option value="positive">Expenses are positive</option>
              </select>
            </label>

            <label>
              Minimum occurrences
              <input type="number" min={2} max={12} value={minCount} onChange={(e) => setMinCount(Number(e.target.value))} />
            </label>
          </div>

          <div className="row">
            <button className="btn" disabled={!columnMap?.date || !columnMap?.description || !columnMap?.amount || files.length === 0} onClick={() => void run()}>
              Parse & detect recurring
            </button>
            <button className="btn secondary" onClick={() => (setStage('upload'), setFiles([]), setHeaders([]), setColumnMap(null))}>
              Start over
            </button>
          </div>

          <div className="small">
            <div>
              Files: <b>{files.length}</b>
            </div>
            <div>
              Headers detected: <b>{headers.length}</b>
            </div>
          </div>
        </section>
      )}

      {stage === 'results' && (
        <section className="card">
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <div>
              <h2>3) Results</h2>
              <div className="small">
                Parsed <b>{txs.length}</b> transactions • Found <b>{groups.length}</b> recurring candidates
              </div>
            </div>
            <div className="row">
              <button className="btn secondary" onClick={() => setStage('map')}>
                Back
              </button>
              <button className="btn" onClick={downloadCsv} disabled={filtered.length === 0}>
                Export CSV
              </button>
            </div>
          </div>

          <Dashboard groups={decidedGroups as any} />

          <div className="row" style={{ marginTop: 12 }}>
            <input className="search" placeholder="Filter merchants…" value={query} onChange={(e) => setQuery(e.target.value)} />
          </div>

          <p className="small" style={{ marginTop: 10 }}>
            Review flow: confirm <b>Bill</b> / <b>Subscription</b> / <b>Not recurring</b>. For monthly items we infer “due” as the <b>usual posting day</b>.
          </p>

          {tab === 'review' && (
            <div className="section">
              <h3>Needs review</h3>
              <div className="cards">
                {decidedGroups
                  .filter((g: any) => g._decision === 'unset')
                  .sort((a: any, b: any) => (b.confidence ?? 0) - (a.confidence ?? 0))
                  .map((g: any) => (
                    <RecurringCard
                      key={g.merchantKey}
                      g={g}
                      decision={g._decision}
                      category={g._category}
                      onDecision={setDecision}
                      onCategory={setCategory}
                    />
                  ))}
                {decidedGroups.filter((g: any) => g._decision === 'unset').length === 0 && <div className="empty">Nothing to review.</div>}
              </div>
            </div>
          )}

          {tab === 'bills' && (
            <div className="section">
              <h3>Bills</h3>
              <UpcomingList kind="bill" groups={decidedGroups as any} />
              <div className="cards" style={{ marginTop: 12 }}>
                {decidedGroups
                  .filter((g: any) => g.kind === 'bill')
                  .map((g: any) => (
                    <RecurringCard
                      key={g.merchantKey}
                      g={g}
                      decision={g._decision}
                      category={g._category}
                      onDecision={setDecision}
                      onCategory={setCategory}
                    />
                  ))}
                {decidedGroups.filter((g: any) => g.kind === 'bill').length === 0 && <div className="empty">No bill items yet.</div>}
              </div>
            </div>
          )}

          {tab === 'subs' && (
            <div className="section">
              <h3>Subscriptions</h3>
              <div className="cards">
                {decidedGroups
                  .filter((g: any) => g.kind === 'subscription')
                  .sort((a: any, b: any) => b.typicalAmount - a.typicalAmount)
                  .map((g: any) => (
                    <RecurringCard
                      key={g.merchantKey}
                      g={g}
                      decision={g._decision}
                      category={g._category}
                      onDecision={setDecision}
                      onCategory={setCategory}
                    />
                  ))}
                {decidedGroups.filter((g: any) => g.kind === 'subscription').length === 0 && (
                  <div className="empty">No subscription items yet.</div>
                )}
              </div>
            </div>
          )}

          {tab === 'plan' && (
            <div className="section">
              <h3>Plan</h3>
              <PlanView groups={decidedGroups as any} />
            </div>
          )}

          {tab === 'upload' && (
            <div className="section">
              <h3>Other recurring (lower confidence)</h3>
              <div className="cards">
                {decidedGroups
                  .filter((g: any) => g.kind === 'unknown')
                  .map((g: any) => (
                    <RecurringCard
                      key={g.merchantKey}
                      g={g}
                      decision={g._decision}
                      category={g._category}
                      onDecision={setDecision}
                      onCategory={setCategory}
                    />
                  ))}
                {decidedGroups.filter((g: any) => g.kind === 'unknown').length === 0 && <div className="empty">None.</div>}
              </div>
            </div>
          )}
        </section>
      )}

      <footer className="footer">CSV is the most reliable. Cloud save requires Supabase configuration.</footer>

      <div className="bottomNav">
        {(
          [
            { id: 'review', label: 'Budget' },
            { id: 'bills', label: 'Bills' },
            { id: 'subs', label: 'Subs' },
            { id: 'plan', label: 'Plan' },
            { id: 'upload', label: 'Upload' },
          ] as const
        ).map((t) => (
          <button key={t.id} className={`tab ${tab === t.id ? 'active' : ''}`} onClick={() => setTab(t.id)} type="button">
            {t.label}
          </button>
        ))}
      </div>
    </div>
  </main>
</div>
  )
}

function round2(n: number) {
  return (Math.round(n * 100) / 100).toFixed(2)
}

function safeCsv(s: string) {
  if (s.includes(',') || s.includes('"') || s.includes('\n')) return `"${s.replace(/"/g, '""')}"`
  return s
}

function RecurringCard({
  g,
  decision,
  category,
  onDecision,
  onCategory,
}: {
  g: RecurringGroup
  decision: Decision
  category?: Category
  onDecision: (merchantKey: string, d: Decision) => void
  onCategory: (merchantKey: string, cat: Category) => void
}) {
  const label = g.kind === 'bill' ? 'BILL' : g.kind === 'subscription' ? 'SUBSCRIPTION' : 'RECURRING'
  const due = g.usualDayOfMonth ? `Around the ${ordinal(g.usualDayOfMonth)}` : '—'
  const rangeLow = Math.max(0, g.typicalAmount - Math.max(g.amountMad * 2, g.typicalAmount * 0.06))
  const rangeHigh = g.typicalAmount + Math.max(g.amountMad * 2, g.typicalAmount * 0.06)

  const pill = (d: Decision, text: string) => (
    <button
      className={`pill ${decision === d ? 'active' : ''}`}
      onClick={() => onDecision(g.merchantKey, d)}
      type="button"
    >
      {text}
    </button>
  )

  return (
    <div className="rcard">
      <div className="rcardTop">
        <div>
          <div className="merchant">{g.merchant}</div>
          <div className="meta">
            {label} • {g.cadence}
            {g.confidence ? ` • ${Math.round(g.confidence * 100)}%` : ''}
          </div>
        </div>
        <div className="amt">${round2(g.typicalAmount)}</div>
      </div>

      <div className="pills">
        {pill('bill', 'Yes: Bill')}
        {pill('subscription', 'Yes: Subscription')}
        {pill('no', 'No')}
        {pill('unset', 'Reset')}
        <select
          className="cat"
          value={category ?? ''}
          onChange={(e) => {
            const v = e.target.value as Category
            if (v) onCategory(g.merchantKey, v)
          }}
        >
          <option value="">Category…</option>
          {DEFAULT_CATEGORIES.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
      </div>

      <div className="rcardGrid">
        <div>
          <div className="k">Due date</div>
          <div className="v">{due}</div>
        </div>
        <div>
          <div className="k">Amount range</div>
          <div className="v">${round2(rangeLow)} – ${round2(rangeHigh)}</div>
        </div>
      </div>

      <details>
        <summary>Details</summary>
        <div className="mono" style={{ marginTop: 8 }}>
          {g.samples.map((s) => `${s.date}  $${round2(s.amount)}  ${s.description}`).join('\n')}
        </div>
      </details>
    </div>
  )
}

function UpcomingList({ kind, groups }: { kind: 'bill' | 'subscription'; groups: Array<RecurringGroup & { _decision?: Decision }> }) {
  const items = groups
    .filter((g: any) => g.kind === kind && g.usualDayOfMonth)
    .slice()
    .sort((a: any, b: any) => (a.usualDayOfMonth ?? 99) - (b.usualDayOfMonth ?? 99))

  if (items.length === 0) return <div className="empty">No upcoming dates yet (needs a monthly pattern).</div>

  return (
    <div className="upcoming">
      {items.slice(0, 8).map((g: any) => (
        <div key={g.merchantKey} className="upItem">
          <div>
            <div className="merchant">{g.merchant}</div>
            <div className="meta">Around the {ordinal(g.usualDayOfMonth)}</div>
          </div>
          <div className="amt">${round2(g.typicalAmount)}</div>
        </div>
      ))}
    </div>
  )
}

function PlanView({ groups }: { groups: Array<RecurringGroup & { _decision?: Decision; _category?: Category }> }) {
  const accepted = groups.filter((g: any) => g.kind === 'bill' || g.kind === 'subscription')

  const totals = new Map<string, number>()
  for (const g of accepted) {
    const cat = g._category ?? (g.kind === 'subscription' ? 'Subscriptions' : 'Other')
    totals.set(cat, (totals.get(cat) ?? 0) + g.typicalAmount)
  }

  const rows = DEFAULT_CATEGORIES.map((c) => ({ category: c, amount: totals.get(c) ?? 0 }))

  return (
    <div className="plan">
      {rows.map((r) => (
        <div key={r.category} className="planRow">
          <div className="merchant">{r.category}</div>
          <div className="amt">${round2(r.amount)}</div>
        </div>
      ))}
      <div className="planRow total">
        <div className="merchant">Total planned (from recurring)</div>
        <div className="amt">${round2(rows.reduce((s, r) => s + r.amount, 0))}</div>
      </div>
      <div className="small">Next: add income + manual categories to finish a true zero-based plan.</div>
    </div>
  )
}

function Dashboard({ groups }: { groups: Array<RecurringGroup & { _decision?: Decision }> }) {
  const acceptedBills = groups.filter((g) => g.kind === 'bill')
  const acceptedSubs = groups.filter((g) => g.kind === 'subscription')

  const billTotal = acceptedBills.reduce((sum, g) => sum + g.typicalAmount, 0)
  const subTotal = acceptedSubs.reduce((sum, g) => sum + g.typicalAmount, 0)
  const grandTotal = billTotal + subTotal

  return (
    <div className="dash">
      <div className="dashCard">
        <div className="k">Bills / month</div>
        <div className="dashMain">${round2(billTotal)}</div>
        <div className="small">{acceptedBills.length} items</div>
      </div>
      <div className="dashCard">
        <div className="k">Subscriptions / month</div>
        <div className="dashMain">${round2(subTotal)}</div>
        <div className="small">{acceptedSubs.length} items</div>
      </div>
      <div className="dashCard primary">
        <div className="k">Grand total / month</div>
        <div className="dashMain">${round2(grandTotal)}</div>
        <div className="small">Bills + subscriptions</div>
      </div>
    </div>
  )
}

function ordinal(n: number) {
  const s = ['th', 'st', 'nd', 'rd']
  const v = n % 100
  return n + (s[(v - 20) % 10] || s[v] || s[0])
}

function Gate({ onAuthed }: { onAuthed: () => void }) {
  const [pw, setPw] = useState('')
  const [err, setErr] = useState<string | null>(null)

  function submit() {
    if (!GATE_PASSWORD) return onAuthed()
    if (pw === GATE_PASSWORD) return onAuthed()
    setErr('Wrong password')
  }

  return (
    <div className="row">
      <input
        className="search"
        type="password"
        placeholder="Password"
        value={pw}
        onChange={(e) => {
          setPw(e.target.value)
          setErr(null)
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') submit()
        }}
      />
      <button className="btn" onClick={submit}>
        Unlock
      </button>
      {err && <span className="small" style={{ color: '#fca5a5' }}>{err}</span>}
    </div>
  )
}
