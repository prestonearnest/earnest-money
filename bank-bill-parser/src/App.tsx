import { useMemo, useState } from 'react'
import './App.css'
import { detectRecurring, guessColumnMap, parseCsvFiles, type ColumnMap, type RecurringGroup, type Tx } from './lib'

type Stage = 'upload' | 'map' | 'results'

type Decision = 'bill' | 'subscription' | 'no' | 'unset'

type DecisionsMap = Record<string, Decision>

const GATE_PASSWORD = import.meta.env.VITE_GATE_PASSWORD as string | undefined
const LS_KEY = 'bbp_authed_v1'
const LS_DECISIONS = 'bbp_decisions_v1'

export default function App() {
  const [authed, setAuthed] = useState(() => {
    if (!GATE_PASSWORD) return true
    return localStorage.getItem(LS_KEY) === '1'
  })

  const [decisions, setDecisions] = useState<DecisionsMap>(() => {
    try {
      return JSON.parse(localStorage.getItem(LS_DECISIONS) ?? '{}') as DecisionsMap
    } catch {
      return {}
    }
  })

  function setDecision(key: string, d: Decision) {
    const next = { ...decisions, [key]: d }
    setDecisions(next)
    localStorage.setItem(LS_DECISIONS, JSON.stringify(next))
  }

  const [stage, setStage] = useState<Stage>('upload')
  const [files, setFiles] = useState<File[]>([])
  const [headers, setHeaders] = useState<string[]>([])
  const [columnMap, setColumnMap] = useState<ColumnMap | null>(null)
  const [expenseSign, setExpenseSign] = useState<'auto' | 'negative' | 'positive'>('auto')

  const [txs, setTxs] = useState<Tx[]>([])
  const [groups, setGroups] = useState<RecurringGroup[]>([])
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
      return { ...g, kind, _decision: d }
    })
  }, [filtered, decisions])

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

  if (!authed) {
    return (
      <div className="wrap">
        <header className="header">
          <div>
            <h1>Bank Statement → Bills & Recurring Charges</h1>
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
    <div className="wrap">
      <header className="header">
        <div>
          <h1>Bank Statement → Bills & Recurring Charges</h1>
          <p className="sub">Local-only, in your browser. Upload CSV exports (U.S. Bank works fine). For info purposes only.</p>
        </div>
      </header>

      {stage === 'upload' && (
        <section className="card">
          <h2>1) Upload CSVs</h2>
          <p>Download transactions from U.S. Bank as <b>CSV</b> (recommended). Upload up to ~3 months.</p>
          <input type="file" accept=".csv,text/csv" multiple onChange={(e) => void onChooseFiles(e.target.files)} />
        </section>
      )}

      {stage === 'map' && (
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
            Tap <b>Yes: Bill</b> / <b>Yes: Subscription</b> / <b>No</b> on each card to confirm. “Due date” usually isn’t present in bank CSVs;
            for monthly items we infer the <b>usual posting day-of-month</b>.
          </p>

          <div className="section">
            <h3>Bills</h3>
            <div className="cards">
              {decidedGroups
                .filter((g: any) => g.kind === 'bill')
                .map((g: any) => (
                  <RecurringCard key={g.merchantKey} g={g} decision={g._decision} onDecision={setDecision} />
                ))}
              {decidedGroups.filter((g: any) => g.kind === 'bill').length === 0 && <div className="empty">No bill items yet.</div>}
            </div>
          </div>

          <div className="section">
            <h3>Subscriptions</h3>
            <div className="cards">
              {decidedGroups
                .filter((g: any) => g.kind === 'subscription')
                .map((g: any) => (
                  <RecurringCard key={g.merchantKey} g={g} decision={g._decision} onDecision={setDecision} />
                ))}
              {decidedGroups.filter((g: any) => g.kind === 'subscription').length === 0 && (
                <div className="empty">No subscription items yet.</div>
              )}
            </div>
          </div>

          <details className="section">
            <summary>Other recurring (lower confidence)</summary>
            <div className="cards">
              {decidedGroups
                .filter((g: any) => g.kind === 'unknown')
                .map((g: any) => (
                  <RecurringCard key={g.merchantKey} g={g} decision={g._decision} onDecision={setDecision} />
                ))}
              {decidedGroups.filter((g: any) => g.kind === 'unknown').length === 0 && <div className="empty">None.</div>}
            </div>
          </details>
        </section>
      )}

      <footer className="footer">PDF parsing can be added next (via PDF.js). CSV will be the most reliable.</footer>
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
  onDecision,
}: {
  g: RecurringGroup
  decision: Decision
  onDecision: (merchantKey: string, d: Decision) => void
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
