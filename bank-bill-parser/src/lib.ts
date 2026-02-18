import Papa from 'papaparse'
import { differenceInCalendarDays, parse, parseISO } from 'date-fns'

export type Tx = {
  date: Date
  description: string
  amount: number // positive = money out (expense)
  raw: Record<string, unknown>
}

export type ColumnMap = {
  date: string
  description: string
  amount: string
}

export function guessColumnMap(headers: string[]): ColumnMap | null {
  const norm = (s: string) => s.trim().toLowerCase()
  const h = headers.map((x) => ({ raw: x, n: norm(x) }))

  const pick = (cands: string[]) => {
    const set = new Set(cands.map(norm))
    return h.find((x) => set.has(x.n))?.raw
  }

  const date = pick(['date', 'transaction date', 'posted date', 'posting date'])
  const description = pick(['description', 'name', 'merchant', 'payee', 'memo'])
  const amount = pick(['amount', 'transaction amount', 'debit', 'withdrawal', 'charge'])

  if (date && description && amount) return { date, description, amount }
  return null
}

function parseDateFlexible(v: unknown): Date | null {
  if (v == null) return null
  const s = String(v).trim()
  if (!s) return null

  // try ISO first
  const iso = parseISO(s)
  if (!Number.isNaN(iso.getTime())) return iso

  // common bank formats
  const fmts = ['M/d/yyyy', 'M/d/yy', 'MM/dd/yyyy', 'MM/dd/yy']
  for (const fmt of fmts) {
    const d = parse(s, fmt, new Date())
    if (!Number.isNaN(d.getTime())) return d
  }
  return null
}

export async function parseCsvFiles(files: File[], map: ColumnMap, opts?: { expenseSign?: 'negative' | 'positive' | 'auto' }): Promise<Tx[]> {
  const expenseSign = opts?.expenseSign ?? 'auto'

  const parseOne = (file: File) =>
    new Promise<Tx[]>((resolve, reject) => {
      Papa.parse<Record<string, unknown>>(file, {
        header: true,
        skipEmptyLines: true,
        complete: (res: Papa.ParseResult<Record<string, unknown>>) => {
          try {
            const rows = res.data
            const txs: Tx[] = []
            for (const row of rows) {
              const d = parseDateFlexible(row[map.date])
              const desc = String(row[map.description] ?? '').trim()
              const amtRaw = row[map.amount]
              const amt = amtRaw == null || amtRaw === '' ? NaN : Number(String(amtRaw).replace(/[$,]/g, ''))
              if (!d || !desc || Number.isNaN(amt)) continue

              // normalize to positive=expense
              let out = amt
              if (expenseSign === 'negative') out = -amt
              else if (expenseSign === 'positive') out = amt
              else {
                // auto: assume negative amounts are expenses; if most are positive, invert
                out = amt
              }

              txs.push({ date: d, description: desc, amount: out, raw: row })
            }

            if (expenseSign === 'auto') {
              const negatives = txs.filter((t) => t.amount < 0).length
              const positives = txs.filter((t) => t.amount > 0).length
              if (positives > negatives) {
                // most files export expenses as positive; keep as-is
              } else {
                // likely expenses are negative → flip
                for (const t of txs) t.amount = Math.abs(t.amount)
              }
            } else {
              for (const t of txs) t.amount = Math.abs(t.amount)
            }

            resolve(txs)
          } catch (e) {
            reject(e)
          }
        },
        error: (err: Error) => reject(err),
      })
    })

  const all = await Promise.all(files.map(parseOne))
  return all.flat().sort((a, b) => a.date.getTime() - b.date.getTime())
}

export function normalizeMerchant(s: string): string {
  return s
    .toLowerCase()
    .replace(/\b(pos|ach|debit|purchase|payment|pymt|online|card)\b/g, ' ')
    .replace(/[0-9]/g, ' ')
    .replace(/[^a-z\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function median(nums: number[]): number {
  if (nums.length === 0) return NaN
  const a = [...nums].sort((x, y) => x - y)
  const m = Math.floor(a.length / 2)
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2
}

function mad(nums: number[], med: number): number {
  const dev = nums.map((x) => Math.abs(x - med))
  return median(dev)
}

export type RecurringGroup = {
  merchant: string
  merchantKey: string
  count: number
  cadence: 'monthly' | 'weekly' | 'biweekly' | 'annual' | 'unknown'
  typicalAmount: number
  amountMad: number
  usualDayOfMonth?: number
  nextExpected?: string
  samples: { date: string; amount: number; description: string }[]
}

export function detectRecurring(txs: Tx[], opts?: { minCount?: number; maxGroups?: number }) {
  const minCount = opts?.minCount ?? 3
  const maxGroups = opts?.maxGroups ?? 200

  const groups = new Map<string, Tx[]>()
  for (const t of txs) {
    const key = normalizeMerchant(t.description)
    if (!key) continue
    const arr = groups.get(key) ?? []
    arr.push(t)
    groups.set(key, arr)
  }

  const out: RecurringGroup[] = []

  for (const [key, arr] of groups) {
    if (arr.length < minCount) continue
    arr.sort((a, b) => a.date.getTime() - b.date.getTime())

    const deltas: number[] = []
    for (let i = 1; i < arr.length; i++) {
      deltas.push(differenceInCalendarDays(arr[i].date, arr[i - 1].date))
    }
    const medDelta = median(deltas)

    const cadence =
      Math.abs(medDelta - 30) <= 5
        ? 'monthly'
        : Math.abs(medDelta - 7) <= 1
          ? 'weekly'
          : Math.abs(medDelta - 14) <= 2
            ? 'biweekly'
            : Math.abs(medDelta - 365) <= 20
              ? 'annual'
              : 'unknown'

    const amounts = arr.map((t) => t.amount)
    const typicalAmount = median(amounts)
    const amountMad = mad(amounts, typicalAmount)

    const doms = arr.map((t) => t.date.getDate())
    const usualDayOfMonth = cadence === 'monthly' ? Math.round(median(doms)) : undefined

    const merchant = titleCase(key)

    out.push({
      merchant,
      merchantKey: key,
      count: arr.length,
      cadence,
      typicalAmount,
      amountMad,
      usualDayOfMonth,
      samples: arr
        .slice(-8)
        .reverse()
        .map((t) => ({ date: t.date.toISOString().slice(0, 10), amount: t.amount, description: t.description })),
    })

    if (out.length >= maxGroups) break
  }

  out.sort((a, b) => {
    // prioritize strong candidates
    const score = (g: RecurringGroup) =>
      (g.cadence === 'unknown' ? 0 : 100) + Math.min(30, g.count * 5) - Math.min(30, g.amountMad)
    return score(b) - score(a)
  })

  return out
}

function titleCase(s: string) {
  return s
    .split(' ')
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(' ')
}
