import React, { useState } from 'react'
import BankPage from './pages/BankPage'
import RecommendationsPage from './pages/RecommendationsPage'
import TactLogo from './tact/TactLogo'
import TactIcon from './tact/TactIcon'
import './tact/tact-header.css'

const NAV = [
  { key: 'bank', label: 'תנועות בנק', icon: 'swap' },
  { key: 'recs', label: 'מאגר המלצות', icon: 'database' },
]

export default function App() {
  const [view, setView] = useState('bank')
  return (
    <div dir="rtl">
      <div className="tact-bar" style={{ justifyContent: 'space-between' }}>
        <TactLogo word="accounting" size={1} />
        <nav className="tact-nav">
          {NAV.map(n => (
            <button key={n.key} className={view === n.key ? 'active' : ''} onClick={() => setView(n.key)}>
              <TactIcon name={n.icon} size={17} />
              {n.label}
            </button>
          ))}
        </nav>
      </div>
      {view === 'bank' ? <BankPage /> : <RecommendationsPage />}
    </div>
  )
}
