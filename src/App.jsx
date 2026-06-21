import React, { useState } from 'react'
import BankPage from './pages/BankPage'
import RecommendationsPage from './pages/RecommendationsPage'

const tab = (active) => ({
  background: active ? '#1d4ed8' : 'transparent',
  color: '#fff',
  border: active ? 'none' : '1px solid #334155',
  borderRadius: 8,
  padding: '8px 18px',
  cursor: 'pointer',
  fontWeight: 700,
  fontSize: 14,
})

export default function App() {
  const [view, setView] = useState('bank')
  return (
    <div>
      <nav style={{ display: 'flex', gap: 8, padding: '10px 20px', background: '#0f172a',
        position: 'sticky', top: 0, zIndex: 100 }}>
        <button style={tab(view === 'bank')} onClick={() => setView('bank')}>תנועות בנק</button>
        <button style={tab(view === 'recs')} onClick={() => setView('recs')}>מאגר המלצות</button>
      </nav>
      {view === 'bank' ? <BankPage /> : <RecommendationsPage />}
    </div>
  )
}
