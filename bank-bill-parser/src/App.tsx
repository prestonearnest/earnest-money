import { useEffect, useMemo, useState } from 'react'
import './App.css'
import { detectRecurring, guessColumnMap, parseCsvFiles, type ColumnMap, type RecurringGroup, type Tx } from './lib'
import { supabase } from './supabase'
import { DEFAULT_CATEGORIES, type Category } from './categories'
import { addMonths, format, getDay, getDaysInMonth, startOfMonth } from 'date-fns'

type Stage = 'upload' | 'map' | 'results'

type Decision = 'bill' | 'subscription' | 'no' | 'unset'

type DecisionsMap = Record<string, Decision>

type CategoryMap = Record<string, Category>

type Tab = 'review' | 'calendar' | 'bills' | 'subs' | 'plan' | 'upload'

type BudgetState = {
  income: number
  plannedByCategory: Record<string, number>
}

const GATE_PASSWORD = import.meta.env.VITE_GATE_PASSWORD as string | undefined
const LS_KEY = 'bbp_authed_v1'
const LS_DECISIONS = 'bbp_decisions_v1'
const LS_CATEGORIES = 'bbp_categories_v1'
const LS_TAB = 'bbp_tab_v1'
const LS_BUDGET = 'bbp_budget_v1'

export default function App() {
  const [authed, setAuthed] = useState(() => {
    if (!GATE_PASSWORD) return true
    return localStorage.getItem(LS_KEY) === '1'
  })

  const [theme, setTheme] = useState<'light' | 'dark'>(() => {
    const saved = localStorage.getItem('bbp_theme_v1') as 'light' | 'dark' | null
    if (saved === 'light' || saved === 'dark') return saved
    return window.matchMedia?.('(prefers-color-scheme: dark)')?.matches ? 'dark' : 'light'
  })
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

  const [budget, setBudget] = useState<BudgetState>(() => {
    try {
      const b = JSON.parse(localStorage.getItem(LS_BUDGET) ?? 'null') as BudgetState | null
      if (b && typeof b.income === 'number' && b.plannedByCategory) return b
    } catch {}
    const plannedByCategory: Record<string, number> = {}
    for (const c of DEFAULT_CATEGORIES) plannedByCategory[c] = 0
    return { income: 0, plannedByCategory }
  })

  function setIncome(n: number) {
    const next = { ...budget, income: n }
    setBudget(next)
    localStorage.setItem(LS_BUDGET, JSON.stringify(next))
  }

  function setPlanned(cat: string, n: number) {
    const next = { ...budget, plannedByCategory: { ...budget.plannedByCategory, [cat]: n } }
    setBudget(next)
    localStorage.setItem(LS_BUDGET, JSON.stringify(next))
  }

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
  const [month, setMonth] = useState<Date>(() => startOfMonth(new Date()))
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
      budget,
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
    if (p.budget) {
      setBudget(p.budget)
      localStorage.setItem(LS_BUDGET, JSON.stringify(p.budget))
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
              { id: 'calendar', label: 'Calendar' },
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
              <h1 className="monthTitle">
                {format(month, 'LLLL yyyy')}{' '}
                <button className="link" type="button" onClick={() => setMonth((m) => addMonths(m, -1))}>
                  ◀
                </button>
                <button className="link" type="button" onClick={() => setMonth(startOfMonth(new Date()))}>
                  Today
                </button>
                <button className="link" type="button" onClick={() => setMonth((m) => addMonths(m, 1))}>
                  ▶
                </button>
              </h1>
              <p className="sub">Plan bills, subscriptions, and your month.</p>
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

          {tab === 'calendar' && (
            <div className="section">
              <h3>Upcoming (next 14 days)</h3>
              <UpcomingCombined groups={decidedGroups as any} />

              <h3 style={{ marginTop: 16 }}>Monthly calendar</h3>
              <BillsCalendar month={month} groups={decidedGroups as any} />
            </div>
          )}

          {tab === 'bills' && (
            <div className="section">
              <h3>Bills</h3>
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
              <h3>Monthly plan (zero-based)</h3>
              <BudgetBuilder budget={budget} onIncome={setIncome} onPlanned={setPlanned} groups={decidedGroups as any} />
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
            { id: 'calendar', label: 'Calendar' },
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

function UpcomingList({
  kind,
  groups,
}: {
  kind: 'bill' | 'subscription'
  groups: Array<RecurringGroup & { _decision?: Decision }>
}) {
  const now = new Date()
  const today = now.getDate()

  const items = groups
    .filter((g: any) => g.kind === kind && g.usualDayOfMonth)
    .map((g: any) => {
      const d = g.usualDayOfMonth as number
      const delta = d >= today ? d - today : 999
      return { ...g, _delta: delta }
    })
    .filter((g: any) => g._delta <= 14)
    .sort((a: any, b: any) => a._delta - b._delta)

  return items
}

function UpcomingCombined({ groups }: { groups: Array<RecurringGroup & { _decision?: Decision }> }) {
  const bills = UpcomingList({ kind: 'bill', groups } as any) as any[]
  const subs = UpcomingList({ kind: 'subscription', groups } as any) as any[]

  return (
    <div className="upcoming">
      <div className="upBox">
        <div className="upHdr">
          <div>
            <div className="merchant">Bills</div>
            <div className="meta">Next 14 days</div>
          </div>
          <div className="amt">{bills.length}</div>
        </div>
        {bills.length === 0 ? (
          <div className="empty" style={{ marginTop: 10 }}>None due soon.</div>
        ) : (
          bills.slice(0, 4).map((g: any) => (
            <div key={g.merchantKey} className="upRow">
              <span className="calMerchant">{g.merchant}</span>
              <span className="meta">{ordinal(g.usualDayOfMonth)}</span>
              <span className="calAmt">${round2(g.typicalAmount)}</span>
            </div>
          ))
        )}
      </div>

      <div className="upBox">
        <div className="upHdr">
          <div>
            <div className="merchant">Subscriptions</div>
            <div className="meta">Next 14 days</div>
          </div>
          <div className="amt">{subs.length}</div>
        </div>
        {subs.length === 0 ? (
          <div className="empty" style={{ marginTop: 10 }}>None due soon.</div>
        ) : (
          subs.slice(0, 4).map((g: any) => (
            <div key={g.merchantKey} className="upRow">
              <span className="calMerchant">{g.merchant}</span>
              <span className="meta">{ordinal(g.usualDayOfMonth)}</span>
              <span className="calAmt">${round2(g.typicalAmount)}</span>
            </div>
          ))
        )}
      </div>
    </div>
  )
}

function BillsCalendar({ month, groups }: { month: Date; groups: Array<RecurringGroup & { _decision?: Decision }> }) {
  const start = startOfMonth(month)
  const daysInMonth = getDaysInMonth(month)
  const startWeekday = getDay(start) // 0=Sun

  const byDay = new Map<number, Array<{ merchant: string; amount: number; kind: 'bill' | 'subscription' }>>()
  for (const g of groups as any[]) {
    if (g.kind !== 'bill' && g.kind !== 'subscription') continue
    if (g.cadence !== 'monthly') continue
    if (!g.usualDayOfMonth) continue
    const d = Math.min(daysInMonth, Math.max(1, g.usualDayOfMonth))
    const arr = byDay.get(d) ?? []
    arr.push({ merchant: g.merchant, amount: g.typicalAmount, kind: g.kind })
    byDay.set(d, arr)
  }

  // 6 rows x 7 cols
  const cells: Array<{ day: number | null }> = []
  for (let i = 0; i < startWeekday; i++) cells.push({ day: null })
  for (let d = 1; d <= daysInMonth; d++) cells.push({ day: d })
  while (cells.length % 7 !== 0) cells.push({ day: null })
  while (cells.length < 42) cells.push({ day: null })

  const weekLabels = ['S', 'M', 'T', 'W', 'T', 'F', 'S']

  return (
    <div className="cal">
      <div className="calHeader">
        {weekLabels.map((w) => (
          <div key={w} className="calDow">
            {w}
          </div>
        ))}
      </div>
      <div className="calGrid">
        {cells.map((c, idx) => {
          if (!c.day) return <div key={idx} className="calCell muted" />
          const items = byDay.get(c.day) ?? []
          return (
            <div key={idx} className="calCell">
              <div className="calDay">{c.day}</div>
              {items.slice(0, 3).map((it, i) => (
                <div key={i} className={`calItem ${it.kind === 'subscription' ? 'sub' : 'bill'}`}>
                  <span className="calMerchant">{it.merchant}</span>
                  <span className="calAmt">${round2(it.amount)}</span>
                </div>
              ))}
              {items.length > 3 && <div className="calMore">+{items.length - 3} more</div>}
            </div>
          )
        })}
      </div>
    </div>
  )
}

function BudgetBuilder({
  budget,
  onIncome,
  onPlanned,
  groups,
}: {
  budget: BudgetState
  onIncome: (n: number) => void
  onPlanned: (cat: string, n: number) => void
  groups: Array<RecurringGroup & { _decision?: Decision; _category?: Category }>
}) {
  const accepted = groups.filter((g: any) => g.kind === 'bill' || g.kind === 'subscription')

  const suggested = new Map<string, number>()
  for (const g of accepted as any[]) {
    const cat = g._category ?? (g.kind === 'subscription' ? 'Subscriptions' : 'Other')
    suggested.set(cat, (suggested.get(cat) ?? 0) + g.typicalAmount)
  }

  const plannedTotal = DEFAULT_CATEGORIES.reduce((sum, c) => sum + (Number(budget.plannedByCategory[c] ?? 0) || 0), 0)
  const remaining = (Number(budget.income) || 0) - plannedTotal

  const status = remaining === 0 ? 'Fully planned' : remaining > 0 ? 'Remaining to allocate' : 'Over planned'

  return (
    <>
      <div className="dash" style={{ gridTemplateColumns: 'repeat(3,minmax(0,1fr))' }}>
        <div className="dashCard">
          <div className="k">Income</div>
          <div className="dashMain">
            <input
              className="money"
              inputMode="decimal"
              value={budget.income ? String(budget.income) : ''}
              placeholder="0"
              onChange={(e) => onIncome(moneyToNumber(e.target.value))}
            />
          </div>
          <div className="small">Monthly take-home</div>
        </div>
        <div className="dashCard">
          <div className="k">Planned</div>
          <div className="dashMain">${round2(plannedTotal)}</div>
          <div className="small">All categories</div>
        </div>
        <div className={`dashCard ${remaining === 0 ? 'primary' : ''}`}>
          <div className="k">{status}</div>
          <div className="dashMain" style={{ color: remaining < 0 ? '#b91c1c' : undefined }}>
            ${round2(Math.abs(remaining))}
          </div>
          <div className="small">Target is $0 remaining</div>
        </div>
      </div>

      <div className="row" style={{ marginTop: 12, justifyContent: 'space-between' }}>
        <div className="small">Tip: start by applying your recurring bills/subscriptions, then fill the rest.</div>
        <button
          className="btn secondary"
          type="button"
          onClick={() => {
            for (const c of DEFAULT_CATEGORIES) {
              const s = suggested.get(c) ?? 0
              if (s > 0) onPlanned(c, roundMoney(s))
            }
          }}
        >
          Apply recurring suggestions
        </button>
      </div>

      <div className="plan">
        {DEFAULT_CATEGORIES.map((c) => {
          const planned = Number(budget.plannedByCategory[c] ?? 0) || 0
          const sug = suggested.get(c) ?? 0
          return (
            <div key={c} className="planRow">
              <div>
                <div className="merchant">{c}</div>
                <div className="meta">Suggested: ${round2(sug)}</div>
              </div>
              <div className="row" style={{ justifyContent: 'flex-end' }}>
                <input
                  className="moneySmall"
                  inputMode="decimal"
                  value={planned ? String(planned) : ''}
                  placeholder="0"
                  onChange={(e) => onPlanned(c, moneyToNumber(e.target.value))}
                />
              </div>
            </div>
          )
        })}
      </div>
    </>
  )
}

function moneyToNumber(s: string) {
  const n = Number(String(s).replace(/[^0-9.\-]/g, ''))
  return Number.isFinite(n) ? n : 0
}

function roundMoney(n: number) {
  return Math.round(n * 100) / 100
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
