import React, { useState, useEffect, useCallback } from 'react'

const API = ''

const card = { background: '#fff', border: '1px solid #e5e9f0', borderRadius: 12, padding: '18px 22px', marginBottom: 20 }
const btn = (bg) => ({ background: bg, color: '#fff', border: 'none', borderRadius: 6, padding: '6px 14px', cursor: 'pointer', fontWeight: 700, fontSize: 13 })
const inp = { padding: '7px 10px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 13, fontFamily: 'inherit' }
const th = { padding: '8px 10px', textAlign: 'right', fontWeight: 600, fontSize: 12, color: '#374151' }
const td = { padding: '8px 10px', fontSize: 13, color: '#1f2937', borderTop: '1px solid #eef1f6' }

const EMPTY_ADD = { details: '', counterpart_account: '', counterpart_desc: '', cashname: '', direction: '-' }

export default function RecommendationsPage() {
  const [recs, setRecs]       = useState([])
  const [total, setTotal]     = useState(0)
  const [q, setQ]             = useState('')
  const [loading, setLoading] = useState(false)
  const [editing, setEditing] = useState(null)
  const [editVals, setEditVals] = useState({})
  const [adding, setAdding]   = useState(EMPTY_ADD)
  const [mQuery, setMQuery]   = useState({ details: '', cashname: '' })
  const [matches, setMatches] = useState(null)

  const load = useCallback(async (query) => {
    setLoading(true)
    try {
      const r = await fetch(`${API}/api/receipts/recommendations?q=${encodeURIComponent(query || '')}`).then(r => r.json())
      if (r.ok) { setRecs(r.recommendations || []); setTotal(r.total || 0) }
    } finally { setLoading(false) }
  }, [])

  useEffect(() => { load('') }, [load])

  const addRec = async () => {
    if (!adding.details.trim() || !adding.counterpart_account.trim()) { alert('צריך פירוט וחשבון נגדי'); return }
    const r = await fetch(`${API}/api/receipts/recommendations`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(adding),
    }).then(r => r.json())
    if (r.ok) { setAdding(EMPTY_ADD); load(q) } else alert(r.error || 'שגיאה')
  }

  const startEdit = (rec) => { setEditing(rec.id); setEditVals({ ...rec }) }
  const saveEdit = async (id) => {
    const r = await fetch(`${API}/api/receipts/recommendations/${id}/update`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        details: editVals.details, counterpart_account: editVals.counterpart_account,
        counterpart_desc: editVals.counterpart_desc, cashname: editVals.cashname, direction: editVals.direction,
      }),
    }).then(r => r.json())
    if (r.ok) { setEditing(null); load(q) } else alert(r.error || 'שגיאה')
  }

  const del = async (id) => {
    if (!window.confirm('למחוק את ההמלצה?')) return
    const r = await fetch(`${API}/api/receipts/recommendations/${id}/delete`, { method: 'POST' }).then(r => r.json())
    if (r.ok) load(q)
  }

  const runMatch = async () => {
    if (!mQuery.details.trim()) return
    const p = new URLSearchParams({ details: mQuery.details, cashname: mQuery.cashname })
    const r = await fetch(`${API}/api/receipts/recommendations/match?${p}`).then(r => r.json())
    setMatches(r.ok ? (r.matches || []) : [])
  }

  return (
    <div style={{ maxWidth: 1100, margin: '0 auto', padding: '24px 20px', fontFamily: 'system-ui, sans-serif' }}>
      <h1 style={{ fontSize: 24, fontWeight: 800, color: '#0f172a', margin: '0 0 6px' }}>מאגר המלצות — פקודות יומן</h1>
      <p style={{ color: '#6b7280', fontSize: 14, margin: '0 0 20px' }}>
        המערכת לומדת מפקודות יומן קודמות וממליצה לפי פירוט התנועה. סה״כ <strong>{total}</strong> המלצות.
      </p>

      {/* ── Test the matcher ── */}
      <div style={{ ...card, background: '#f0f9ff', border: '1px solid #bae6fd' }}>
        <h3 style={{ margin: '0 0 12px', fontSize: 15, fontWeight: 700, color: '#075985' }}>🔍 בדיקת התאמה</h3>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <input style={{ ...inp, flex: 2, minWidth: 220 }} placeholder="פירוט תנועה לבדיקה…"
            value={mQuery.details} onChange={e => setMQuery({ ...mQuery, details: e.target.value })}
            onKeyDown={e => e.key === 'Enter' && runMatch()} />
          <input style={{ ...inp, flex: 1, minWidth: 140 }} placeholder="CASHNAME (אופציונלי)"
            value={mQuery.cashname} onChange={e => setMQuery({ ...mQuery, cashname: e.target.value })} />
          <button style={btn('#0284c7')} onClick={runMatch}>בדוק</button>
        </div>
        {matches !== null && (
          <div style={{ marginTop: 12 }}>
            {matches.length === 0 ? <span style={{ color: '#6b7280', fontSize: 13 }}>אין התאמות</span> :
              matches.map(m => (
                <div key={m.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '6px 0', fontSize: 13 }}>
                  <span style={{ background: m.confidence >= 70 ? '#16a34a' : m.confidence >= 40 ? '#f59e0b' : '#9ca3af',
                    color: '#fff', borderRadius: 12, padding: '2px 10px', fontWeight: 700, minWidth: 48, textAlign: 'center' }}>
                    {m.confidence}%
                  </span>
                  <strong style={{ fontFamily: 'monospace', color: '#1d4ed8' }}>{m.counterpart_account}</strong>
                  <span style={{ color: '#6b7280' }}>{m.counterpart_desc}</span>
                  <span style={{ color: '#9ca3af', marginInlineStart: 'auto' }}>{m.details}</span>
                </div>
              ))}
          </div>
        )}
      </div>

      {/* ── Add new ── */}
      <div style={card}>
        <h3 style={{ margin: '0 0 12px', fontSize: 15, fontWeight: 700, color: '#1a1a2e' }}>➕ הוספת המלצה</h3>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <input style={{ ...inp, flex: 2, minWidth: 200 }} placeholder="פירוט (DETAILS)"
            value={adding.details} onChange={e => setAdding({ ...adding, details: e.target.value })} />
          <input style={{ ...inp, width: 130 }} placeholder="חשבון נגדי"
            value={adding.counterpart_account} onChange={e => setAdding({ ...adding, counterpart_account: e.target.value })} />
          <input style={{ ...inp, flex: 1, minWidth: 130 }} placeholder="תיאור חשבון"
            value={adding.counterpart_desc} onChange={e => setAdding({ ...adding, counterpart_desc: e.target.value })} />
          <input style={{ ...inp, width: 130 }} placeholder="CASHNAME"
            value={adding.cashname} onChange={e => setAdding({ ...adding, cashname: e.target.value })} />
          <select style={{ ...inp, width: 70 }} value={adding.direction}
            onChange={e => setAdding({ ...adding, direction: e.target.value })}>
            <option value="-">−</option><option value="+">+</option>
          </select>
          <button style={btn('#1d4ed8')} onClick={addRec}>הוסף</button>
        </div>
      </div>

      {/* ── List ── */}
      <div style={card}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12, flexWrap: 'wrap' }}>
          <input style={{ ...inp, flex: 1, minWidth: 200 }} placeholder="חיפוש בפירוט / חשבון…"
            value={q} onChange={e => setQ(e.target.value)} onKeyDown={e => e.key === 'Enter' && load(q)} />
          <button style={btn('#64748b')} onClick={() => load(q)}>חפש</button>
          {loading && <span style={{ color: '#6b7280', fontSize: 13 }}>טוען…</span>}
        </div>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ background: '#f8f9fb' }}>
              <th style={th}>פירוט</th><th style={th}>CASHNAME</th><th style={th}>כיוון</th>
              <th style={th}>חשבון נגדי</th><th style={th}>תיאור</th><th style={{ ...th, textAlign: 'center' }}>שימושים</th>
              <th style={th}></th>
            </tr>
          </thead>
          <tbody>
            {recs.length === 0 && <tr><td style={td} colSpan={7}><span style={{ color: '#9ca3af' }}>אין המלצות</span></td></tr>}
            {recs.map(r => editing === r.id ? (
              <tr key={r.id} style={{ background: '#fffbeb' }}>
                <td style={td}><input style={{ ...inp, width: '100%' }} value={editVals.details || ''} onChange={e => setEditVals({ ...editVals, details: e.target.value })} /></td>
                <td style={td}><input style={{ ...inp, width: 110 }} value={editVals.cashname || ''} onChange={e => setEditVals({ ...editVals, cashname: e.target.value })} /></td>
                <td style={td}>
                  <select style={{ ...inp, width: 60 }} value={editVals.direction || '-'} onChange={e => setEditVals({ ...editVals, direction: e.target.value })}>
                    <option value="-">−</option><option value="+">+</option>
                  </select>
                </td>
                <td style={td}><input style={{ ...inp, width: 110 }} value={editVals.counterpart_account || ''} onChange={e => setEditVals({ ...editVals, counterpart_account: e.target.value })} /></td>
                <td style={td}><input style={{ ...inp, width: '100%' }} value={editVals.counterpart_desc || ''} onChange={e => setEditVals({ ...editVals, counterpart_desc: e.target.value })} /></td>
                <td style={{ ...td, textAlign: 'center' }}>{r.times_used}</td>
                <td style={{ ...td, whiteSpace: 'nowrap' }}>
                  <button style={{ ...btn('#16a34a'), padding: '4px 10px', marginInlineEnd: 6 }} onClick={() => saveEdit(r.id)}>שמור</button>
                  <button style={{ ...btn('#9ca3af'), padding: '4px 10px' }} onClick={() => setEditing(null)}>ביטול</button>
                </td>
              </tr>
            ) : (
              <tr key={r.id}>
                <td style={td}>{r.details}</td>
                <td style={{ ...td, fontFamily: 'monospace', color: '#4b5563' }}>{r.cashname || '—'}</td>
                <td style={{ ...td, color: r.direction === '+' ? '#16a34a' : '#dc2626', fontWeight: 700 }}>{r.direction || '—'}</td>
                <td style={{ ...td, fontFamily: 'monospace', fontWeight: 700, color: '#1d4ed8' }}>{r.counterpart_account}</td>
                <td style={td}>{r.counterpart_desc || '—'}</td>
                <td style={{ ...td, textAlign: 'center', color: '#6b7280' }}>{r.times_used}</td>
                <td style={{ ...td, whiteSpace: 'nowrap' }}>
                  <button style={{ ...btn('#1d4ed8'), padding: '4px 10px', marginInlineEnd: 6 }} onClick={() => startEdit(r)}>ערוך</button>
                  <button style={{ ...btn('#dc2626'), padding: '4px 10px' }} onClick={() => del(r.id)}>מחק</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
