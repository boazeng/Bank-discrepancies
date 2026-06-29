import React, { useState, useEffect, useCallback } from 'react'

const API = ''

const card = { background: '#fff', border: '1px solid #e5e9f0', borderRadius: 12, padding: '18px 22px', marginBottom: 20 }
const btn = (bg) => ({ background: bg, color: '#fff', border: 'none', borderRadius: 6, padding: '8px 16px', cursor: 'pointer', fontWeight: 700, fontSize: 13 })
const inp = { padding: '7px 10px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 13, fontFamily: 'inherit' }
const th = { padding: '8px 10px', textAlign: 'right', fontWeight: 600, fontSize: 12, color: '#374151' }
const td = { padding: '8px 10px', fontSize: 13, color: '#1f2937', borderTop: '1px solid #eef1f6' }

export default function AccountsPage() {
  const [accounts, setAccounts] = useState([])
  const [total, setTotal]       = useState(0)
  const [q, setQ]               = useState('')
  const [status, setStatus]     = useState(null)
  const [syncing, setSyncing]   = useState(false)
  const [syncMsg, setSyncMsg]   = useState('')

  const loadStatus = useCallback(async () => {
    const r = await fetch(`${API}/api/receipts/accounts/status`).then(r => r.json()).catch(() => null)
    if (r && r.ok) setStatus(r)
  }, [])

  const search = useCallback(async (query) => {
    const r = await fetch(`${API}/api/receipts/accounts?q=${encodeURIComponent(query || '')}&limit=100`).then(r => r.json()).catch(() => null)
    if (r && r.ok) { setAccounts(r.accounts || []); setTotal(r.total || 0) }
  }, [])

  useEffect(() => { loadStatus(); search('') }, [loadStatus, search])

  const sync = async (full) => {
    setSyncing(true)
    setSyncMsg(full ? 'מסנכרן הכול מפריוריטי… (עשוי לקחת דקה)' : 'מסנכרן חדשים…')
    try {
      const r = await fetch(`${API}/api/receipts/accounts/sync${full ? '?full=1' : ''}`, { method: 'POST' }).then(r => r.json())
      if (r.ok) { setSyncMsg(`✓ סונכרנו ${r.synced} חשבונות (סה״כ ${r.total})`); loadStatus(); search(q) }
      else setSyncMsg('שגיאה: ' + (r.error || ''))
    } catch (e) { setSyncMsg('שגיאה: ' + e.message) } finally { setSyncing(false) }
  }

  const fmt = (iso) => { try { return new Date(iso).toLocaleString('he-IL') } catch { return iso } }

  return (
    <div style={{ maxWidth: 1100, margin: '0 auto', padding: '24px 20px', fontFamily: 'system-ui, sans-serif' }} dir="rtl">
      <h1 style={{ fontSize: 24, fontWeight: 800, color: '#0f172a', margin: '0 0 6px' }}>חשבונות פריוריטי</h1>
      <p style={{ color: '#6b7280', fontSize: 14, margin: '0 0 20px' }}>
        מאגר מקומי של תוכנית החשבונות מפריוריטי — לבחירה מהירה בלי לגשת לפריוריטי בכל תנועה.
      </p>

      {/* ── Sync ── */}
      <div style={{ ...card, background: '#f0f9ff', border: '1px solid #bae6fd', display: 'flex',
        alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: 200 }}>
          <div style={{ fontSize: 15, fontWeight: 700, color: '#075985' }}>
            {status ? `${status.total.toLocaleString()} חשבונות במאגר` : 'טוען…'}
          </div>
          <div style={{ fontSize: 12, color: '#0369a1' }}>
            {status?.last_synced_at ? `סונכרן לאחרונה: ${fmt(status.last_synced_at)}` : 'טרם סונכרן'}
          </div>
        </div>
        {syncMsg && <span style={{ fontSize: 13, color: '#075985' }}>{syncMsg}</span>}
        <button style={{ ...btn('#0284c7'), opacity: syncing ? 0.5 : 1 }} disabled={syncing}
          onClick={() => sync(false)}>🔄 סנכרן חדשים</button>
        <button style={{ ...btn('#64748b'), opacity: syncing ? 0.5 : 1 }} disabled={syncing}
          onClick={() => sync(true)} title="מושך מחדש את כל החשבונות מפריוריטי">סנכרון מלא</button>
      </div>

      {/* ── Search + table ── */}
      <div style={card}>
        <div style={{ display: 'flex', gap: 10, marginBottom: 12, flexWrap: 'wrap' }}>
          <input style={{ ...inp, flex: 1, minWidth: 220 }} placeholder="חיפוש לפי מספר חשבון או תיאור…"
            value={q} onChange={e => setQ(e.target.value)} onKeyDown={e => e.key === 'Enter' && search(q)} />
          <button style={btn('#1d4ed8')} onClick={() => search(q)}>חפש</button>
        </div>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ background: '#f8f9fb' }}>
              <th style={th}>מספר חשבון</th><th style={th}>תיאור</th><th style={th}>סניף</th>
              <th style={th}>סעיף מאזן בוחן</th><th style={th}>כותרת מאזן בוחן</th>
            </tr>
          </thead>
          <tbody>
            {accounts.length === 0 && <tr><td style={td} colSpan={5}><span style={{ color: '#9ca3af' }}>אין תוצאות — נסה לסנכרן או לחפש</span></td></tr>}
            {accounts.map(a => (
              <tr key={a.accname}>
                <td style={{ ...td, fontFamily: 'monospace', fontWeight: 700, color: '#1d4ed8' }}>{a.accname}</td>
                <td style={td}>{a.accdes || '—'}</td>
                <td style={{ ...td, fontFamily: 'monospace', color: '#4b5563' }}>{a.branch_code}</td>
                <td style={{ ...td, fontFamily: 'monospace', color: '#4b5563' }}>{a.tb_code || '—'}</td>
                <td style={td}>{a.tb_des || '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {accounts.length >= 100 && <p style={{ fontSize: 12, color: '#9ca3af', marginTop: 10 }}>מוצגות 100 הראשונות — צמצם את החיפוש.</p>}
      </div>
    </div>
  )
}
