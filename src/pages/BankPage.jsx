import { useState, useEffect, useCallback } from 'react'
import './BankPage.css'

const API = ''

function fmt(dateStr) {
  if (!dateStr) return ''
  const [y, m, d] = dateStr.slice(0, 10).split('-')
  return `${d}/${m}/${y}`
}

function fmtAmount(n) {
  if (n == null) return ''
  return Number(n).toLocaleString('he-IL', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' ₪'
}

const ACTION_STYLES = {
  receipt:         { label: 'הפקת קבלה',       color: '#16a34a', bg: '#f0fdf4' },
  invoice_receipt: { label: 'חשבונית מס קבלה', color: '#7c3aed', bg: '#f5f3ff' },
  journal:         { label: 'פקודת התאמה',      color: '#b45309', bg: '#fff7ed' },
  transfer:        { label: 'העברה בנקאית',     color: '#1d4ed8', bg: '#eff6ff' },
}

function AmountCell({ sum1, direction }) {
  const dir = direction || ''
  const cls = dir === '+' ? 'receipts-amount-plus' : dir === '-' ? 'receipts-amount-minus' : 'receipts-amount'
  return (
    <span className={cls}>
      {dir === '+' ? '+ ' : dir === '-' ? '- ' : ''}{fmtAmount(sum1)}
    </span>
  )
}

export default function BankPage({ mode = 'bank' }) {
  const [bankTxns, setBankTxns]           = useState([])
  const [draftReceipts, setDraftReceipts] = useState([])
  const [closedReceipts, setClosedReceipts] = useState([])
  const [doneActions, setDoneActions]     = useState([])
  const [doneFilterBranch, setDoneFilterBranch] = useState('all')
  const [doneFilterAction, setDoneFilterAction] = useState('all')
  const [draftFilterBranch, setDraftFilterBranch] = useState('all')
  const [loading, setLoading]     = useState(true)
  const [error, setError]         = useState('')

  const [closing, setClosing]             = useState(null)
  const [closingEinvoice, setClosingEinvoice] = useState(null)
  const [deleting, setDeleting]           = useState(null)
  const [refreshingFinal, setRefreshingFinal] = useState(null)
  const [actioning, setActioning] = useState(null)
  const [rowActions, setRowActions] = useState({})
  const [quickConfirming, setQuickConfirming] = useState(null)
  const [dismissedMatches, setDismissedMatches] = useState(new Set())

  const [activeTab, setActiveTab]     = useState('bank')
  const [unmatchedOpen, setUnmatchedOpen] = useState(false)
  const [draftsOpen, setDraftsOpen]       = useState(false)
  const [finalOpen, setFinalOpen]         = useState(false)

  const [days, setDays]               = useState(365)
  const [since, setSince]             = useState('')
  const [branchFilter, setBranchFilter] = useState('all')
  const [allBranches, setAllBranches] = useState([])
  const [bankFilter, setBankFilter] = useState('all')
  const [allBanks, setAllBanks] = useState([])

  // Receipt modal state
  const [receiptModal, setReceiptModal]       = useState(null)
  const [modalAccname, setModalAccname]       = useState('')
  const [modalAccdes, setModalAccdes]         = useState('')
  const [modalDetails, setModalDetails]       = useState('')
  const [modalSending, setModalSending]       = useState(false)
  const [modalError, setModalError]           = useState('')
  const [lastIvnum, setLastIvnum]             = useState(null)
  const [custSuggestions, setCustSuggestions] = useState([])
  const [custSearching, setCustSearching]     = useState(false)
  const [openInvoices, setOpenInvoices]       = useState([])
  const [invoiceSearching, setInvoiceSearching] = useState(false)
  const [selectedInvoices, setSelectedInvoices] = useState(new Set())
  const [existingRc, setExistingRc]             = useState(null)
  const [receiptDocType, setReceiptDocType]     = useState('receipt')
  const [draftInfo, setDraftInfo]               = useState(null)
  const [finalizing, setFinalizing]             = useState(false)

  // Journal entry modal state
  const [journalModal, setJournalModal]               = useState(null)
  const [journalBankGlResolved, setJournalBankGlResolved] = useState('')
  const [journalBankGlDesc, setJournalBankGlDesc]         = useState('')
  const [journalBankGlManual, setJournalBankGlManual]     = useState('')
  const [journalCounterpart, setJournalCounterpart]   = useState('')
  const [journalCounterDesc, setJournalCounterDesc]   = useState('')
  const [journalDetails, setJournalDetails]           = useState('')
  const [journalSending, setJournalSending]           = useState(false)
  const [journalError, setJournalError]               = useState('')
  const [journalSuccess, setJournalSuccess]           = useState('')
  const [journalAccSuggestions, setJournalAccSuggestions] = useState([])
  const [journalAccSearching, setJournalAccSearching]     = useState(false)
  const [journalSaveTpl, setJournalSaveTpl]               = useState(true)
  const [finalizingJournal, setFinalizingJournal]         = useState(null)
  const [finalizeModal, setFinalizeModal]                 = useState(null)
  const [finalizeInputNum, setFinalizeInputNum]           = useState('')
  const [finalizeSaving, setFinalizeSaving]               = useState(false)
  const [finalizingTransfer, setFinalizingTransfer]       = useState(null)
  const [finalizeTransferModal, setFinalizeTransferModal] = useState(null)
  const [finalizeTransferInput, setFinalizeTransferInput] = useState('')
  const [finalizeTransferSaving, setFinalizeTransferSaving] = useState(false)
  const [cancellingAction, setCancellingAction]           = useState(null)

  // Invoice receipt modal state
  const [irModal, setIrModal]         = useState(null)
  const [irDraftInfo, setIrDraftInfo] = useState(null)
  const [irFinalizing, setIrFinalizing] = useState(false)
  const [irAccname, setIrAccname]     = useState('')
  const [irAccdes, setIrAccdes]       = useState('')
  const [irDetails, setIrDetails]     = useState('')
  const [irItems, setIrItems]         = useState([])
  const [irLoading, setIrLoading]     = useState(false)
  const [irSending, setIrSending]     = useState(false)
  const [irError, setIrError]         = useState('')
  const [irPrevNote, setIrPrevNote]   = useState('')
  const [irAccFocused, setIrAccFocused] = useState(false)

  // Bank GL settings
  const [showBankGlSettings, setShowBankGlSettings] = useState(false)
  const [bankGlInputs, setBankGlInputs]             = useState({})
  const [bankGlSaving, setBankGlSaving]             = useState({})

  // Bank transfer modal state
  const [transferModal, setTransferModal]               = useState(null)
  const [transferAccname, setTransferAccname]           = useState('')
  const [transferAccdes, setTransferAccdes]             = useState('')
  const [transferDetails, setTransferDetails]           = useState('')
  const [transferSending, setTransferSending]           = useState(false)
  const [transferError, setTransferError]               = useState('')
  const [transferSuccess, setTransferSuccess]           = useState('')
  const [transferAccFocused, setTransferAccFocused]     = useState(false)
  const [transferDropdownOpen, setTransferDropdownOpen] = useState(false)
  const [transferAccFromSugg, setTransferAccFromSugg]   = useState(false)

  // Pre-loaded account lists for dropdowns
  const [allSuppliers, setAllSuppliers] = useState([])
  const [allCustomers, setAllCustomers] = useState([])
  const [receiptAccFocused, setReceiptAccFocused] = useState(false)

  const loadAll = useCallback(async (d, b, refreshGl, bk) => {
    const daysParam   = d ?? days
    const branchParam = b !== undefined ? b : branchFilter
    const bankParam   = bk !== undefined ? bk : bankFilter
    setLoading(true)
    setError('')
    try {
      const glParam = refreshGl ? '&refresh_gl=1' : ''
      const branchQ = branchParam && branchParam !== 'all' ? `&branch=${encodeURIComponent(branchParam)}` : ''
      const bankQ   = bankParam && bankParam !== 'all' ? `&bank=${encodeURIComponent(bankParam)}` : ''
      const txnUrl = `${API}/api/receipts/bank-transactions?days=${daysParam}${branchQ}${bankQ}${glParam}`
      const [bRes, a, doneRes] = await Promise.all([
        fetch(txnUrl).then(r => r.json()),
        fetch(`${API}/api/receipts/approved`).then(r => r.json()),
        fetch(`${API}/api/receipts/action-queue/done-list`).then(r => r.json()),
      ])
      if (!bRes.ok) {
        setError(`שגיאה בטעינת תנועות בנק: ${bRes.error || 'תשובה לא תקינה מהשרת'}`)
        setBankTxns([])
      } else {
        const txns = bRes.transactions || []
        setBankTxns(txns)
        setSince(bRes.since || '')
        if (!branchParam || branchParam === 'all') {
          const branches = [...new Set(txns.map(t => t.BRANCHNAME).filter(Boolean))].sort()
          setAllBranches(branches)
        }
        if (!bankParam || bankParam === 'all') {
          const banks = [...new Set(txns.map(t => t.bank_name).filter(Boolean))].sort()
          setAllBanks(banks)
        }
        setRowActions(prev => {
          const next = { ...prev }
          txns.forEach(t => { if (!next[t.FNCNUM]) next[t.FNCNUM] = t.suggested_action || 'journal' })
          return next
        })
        const creditLines = txns
          .filter(t => t.direction === '+')
          .slice(0, 30)
          .map(t => ({ fncnum: t.FNCNUM, amount: t.SUM1, branchname: t.BRANCHNAME || '', cashname: t.CASHNAME || '', curdate: (t.CURDATE || '').slice(0, 10) }))
        if (creditLines.length > 0) {
          fetch(`${API}/api/receipts/auto-scan`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ transactions: creditLines }),
          }).then(r => r.json()).then(async data => {
            if (data.ok && data.imported > 0) {
              const [freshBank, freshApproved] = await Promise.all([
                fetch(txnUrl).then(r => r.json()),
                fetch(`${API}/api/receipts/approved`).then(r => r.json()),
              ])
              if (freshBank.ok) setBankTxns(freshBank.transactions || [])
              if (freshApproved.ok) {
                const all2 = freshApproved.receipts || []
                setDraftReceipts(all2.filter(r => r.status !== 'closed'))
                setClosedReceipts(all2.filter(r => r.status === 'closed'))
              }
            }
          }).catch(() => {})
        }
      }
      if (a.ok) {
        const all = a.receipts || []
        setDraftReceipts(all.filter(r => r.status !== 'closed'))
        setClosedReceipts(all.filter(r => r.status === 'closed'))
      }
      if (doneRes.ok) {
        setDoneActions(doneRes.items || [])
      }
    } catch (e) {
      setError('שגיאה בטעינת נתונים: ' + e.message)
    } finally {
      setLoading(false)
    }
  }, [days, branchFilter, bankFilter])

  useEffect(() => { loadAll() }, [loadAll])

  async function closeReceipt(rec) {
    if (!window.confirm(`לסגור את הקבלה ${rec.priority_ivnum} בפריוריטי?\n(פעולה זו אינה הפיכה)`)) return
    setClosing(rec.id)
    try {
      const resp = await fetch(`${API}/api/receipts/${rec.id}/close`, { method: 'POST' })
      const data = await resp.json()
      if (!data.ok) throw new Error(data.error || 'שגיאה')
      await loadAll()
      const rcLine  = data.rc_ivnum ? `\nמספר קבלה סופי: ${data.rc_ivnum}` : ''
      const fncLine = data.fncnum   ? `\nמספר תנועת יומן: ${data.fncnum}`  : ''
      alert(`קבלה ${rec.priority_ivnum} נסגרה בהצלחה${rcLine}${fncLine}`)
    } catch (e) {
      alert('שגיאה בסגירת קבלה: ' + e.message)
    } finally {
      setClosing(null)
    }
  }

  async function closeEinvoice(rec) {
    if (!window.confirm(`לסגור את חשבונית מס הקבלה ${rec.priority_ivnum} בפריוריטי?\n(פעולה זו אינה הפיכה)`)) return
    setClosingEinvoice(rec.id)
    try {
      const resp = await fetch(`${API}/api/receipts/${rec.id}/close-einvoice`, { method: 'POST' })
      const data = await resp.json()
      if (!data.ok) throw new Error(data.error || 'שגיאה')
      await loadAll()
      const finalNum = data.final_ivnum && data.final_ivnum !== rec.priority_ivnum
        ? data.final_ivnum : (data.final_ivnum || rec.priority_ivnum)
      const fncLine = data.fncnum ? `\nמספר תנועת יומן: ${data.fncnum}` : ''
      alert(`חשבונית מס קבלה נסגרה בהצלחה\nמספר חשבונית סופי: ${finalNum}${fncLine}`)
    } catch (e) {
      alert('שגיאה בסגירת חשבונית מס קבלה: ' + e.message)
    } finally {
      setClosingEinvoice(null)
    }
  }

  async function refreshFinalNumbers(rec) {
    setRefreshingFinal(rec.id)
    try {
      const resp = await fetch(`${API}/api/receipts/${rec.id}/refresh-final`, { method: 'POST' })
      const data = await resp.json()
      if (!data.ok) throw new Error(data.error || 'שגיאה')
      await loadAll()
      const finalLine = data.final_ivnum
        ? `\nמספר חשבונית סופי: ${data.final_ivnum}`
        : data.rc_ivnum
          ? `\nמספר קבלה סופי: ${data.rc_ivnum}`
          : '\nלא נמצא מספר סופי'
      const fncLine = data.fncnum ? `\nמספר תנועת יומן: ${data.fncnum}` : ''
      alert(`עודכן${finalLine}${fncLine}`)
    } catch (e) {
      alert('שגיאה: ' + e.message)
    } finally {
      setRefreshingFinal(null)
    }
  }

  async function deleteReceipt(rec) {
    const label = rec.priority_ivnum ? ` (${rec.priority_ivnum})` : ''
    if (!window.confirm(`למחוק את הרשומה של ${rec.accdes || rec.details || ''}${label}?\nאם נשלחה לפריוריטי יש למחוק שם ידנית.`)) return
    setDeleting(rec.id)
    try {
      const resp = await fetch(`${API}/api/receipts/${rec.id}/delete`, { method: 'POST' })
      const data = await resp.json()
      if (!data.ok) throw new Error(data.error || 'שגיאה')
      await loadAll()
    } catch (e) {
      alert('שגיאה במחיקה: ' + e.message)
    } finally {
      setDeleting(null)
    }
  }

  async function searchOpenInvoices(accname, txn) {
    const t = txn || receiptModal
    if (!accname || accname.length < 2 || !t) { setOpenInvoices([]); return }
    setInvoiceSearching(true)
    try {
      const params = new URLSearchParams({
        accname,
        amount:     t.SUM1 != null ? String(t.SUM1) : '',
        branchname: t.BRANCHNAME || '',
      })
      const res = await fetch(`${API}/api/receipts/open-invoices?${params}`).then(r => r.json())
      if (res.ok) setOpenInvoices(res.invoices || [])
    } catch { /* silent */ } finally {
      setInvoiceSearching(false)
    }
  }

  async function openReceiptModal(txn, docType = 'receipt') {
    setReceiptModal(txn)
    setReceiptDocType(docType)
    setModalAccname('')
    setModalAccdes('')
    setModalDetails(docType === 'invoice_receipt' ? 'חשבונית מס קבלה' : 'קבלה')
    setModalError('')
    setLastIvnum(null)
    setCustSuggestions([])
    setOpenInvoices([])
    setSelectedInvoices(new Set())
    setExistingRc(null)
    setDraftInfo(null)
    setFinalizing(false)
    setReceiptAccFocused(false)
    loadAllCustomers()
    if (txn.SUM1) {
      setCustSearching(true)
      try {
        const params = new URLSearchParams({ amount: txn.SUM1 || '', branchname: txn.BRANCHNAME || '', curdate: (txn.CURDATE || '').slice(0, 10) })
        const res = await fetch(`${API}/api/receipts/customer-search?${params}`).then(r => r.json())
        if (res.ok) {
          const suggestions = res.results || []
          setCustSuggestions(suggestions)
          if (suggestions.length === 1) {
            const s = suggestions[0]
            setModalAccname(s.accname)
            setCustSuggestions([])
            if (s.existing_rc) {
              await importExistingReceipt(txn, s)
              return
            } else {
              searchOpenInvoices(s.accname, txn)
            }
          }
        }
      } catch { /* silent */ } finally {
        setCustSearching(false)
      }
    }
  }

  async function importExistingReceipt(txn, suggestion) {
    try {
      await fetch(`${API}/api/receipts/import-existing`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          bank_fncnum: txn.FNCNUM,
          accname:     suggestion.accname,
          accdes:      suggestion.accdes,
          cashname:    txn.CASHNAME || '',
          totprice:    txn.SUM1,
          ivdate:      (txn.CURDATE || '').slice(0, 10),
          branchname:  txn.BRANCHNAME || '',
          rc_ivnum:    suggestion.existing_rc,
          fncnum:      suggestion.existing_fncnum || '',
        }),
      })
    } catch { /* non-fatal */ }
    setReceiptModal(null)
    setOpenInvoices([])
    setSelectedInvoices(new Set())
    setExistingRc(null)
    await loadAll()
  }

  async function submitReceipt() {
    if (!modalAccname.trim()) { setModalError('יש להזין קוד לקוח'); return }
    setModalSending(true)
    setModalError('')
    try {
      const txn = receiptModal
      const resp = await fetch(`${API}/api/receipts/bank-line/create-receipt`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          txn_id:      txn.FNCNUM,
          bank_ref:    txn.REF || '',
          accname:     modalAccname.trim(),
          accdes:      '',
          amount:      txn.SUM1,
          ivdate:      (txn.CURDATE || '').slice(0, 10),
          cashname:    txn.CASHNAME,
          branchname:  txn.BRANCHNAME,
          details:     modalDetails,
          open_invoices: openInvoices.filter(inv => selectedInvoices.has(inv.IVNUM)),
          doc_type:    receiptDocType,
        }),
      })
      const data = await resp.json()
      if (!data.ok) {
        const prioMsg = data.detail?.error?.message?.value || data.detail?.error?.message || ''
        throw new Error(prioMsg || data.error || 'שגיאה')
      }
      setDraftInfo({ ivnum: data.priority_ivnum })
      await loadAll()
    } catch (e) {
      setModalError(e.message)
    } finally {
      setModalSending(false)
    }
  }

  async function finalizeReceipt() {
    if (!draftInfo || !receiptModal) return
    setFinalizing(true)
    setModalError('')
    try {
      const txn = receiptModal
      const resp = await fetch(`${API}/api/receipts/bank-line/finalize-receipt`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          txn_id:         txn.FNCNUM,
          priority_ivnum: draftInfo.ivnum,
          cashname:       txn.CASHNAME,
          doc_type:       receiptDocType,
        }),
      })
      const data = await resp.json()
      if (!data.ok) throw new Error(data.error || 'שגיאה')
      setLastIvnum(draftInfo.ivnum)
      setDraftInfo(null)
      setReceiptModal(null)
      setOpenInvoices([])
      setSelectedInvoices(new Set())
      setExistingRc(null)
      await loadAll()
    } catch (e) {
      setModalError(e.message)
    } finally {
      setFinalizing(false)
    }
  }

  async function recordAction(txn, action) {
    setActioning(txn.FNCNUM)
    try {
      const resp = await fetch(`${API}/api/receipts/bank-line/record-action`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          txn_id:     txn.FNCNUM,
          action,
          details:    txn.DETAILS,
          sum1:       txn.SUM1,
          direction:  txn.direction,
          branchname: txn.BRANCHNAME,
          bank_desc:  txn.bank_desc,
          curdate:    txn.CURDATE,
          cashname:   txn.CASHNAME,
        }),
      })
      const data = await resp.json()
      if (!data.ok) throw new Error(data.error || 'שגיאה')
      await loadAll()
    } catch (e) {
      alert('שגיאה: ' + e.message)
    } finally {
      setActioning(null)
    }
  }

  async function openJournalModal(txn) {
    setJournalModal(txn)
    setJournalDetails(txn.DETAILS || '')
    setJournalError('')
    setJournalSuccess('')
    setJournalAccSuggestions([])
    setJournalSaveTpl(true)
    setJournalCounterpart('')
    setJournalCounterDesc('')
    setJournalBankGlResolved(txn.bank_gl || '')
    setJournalBankGlDesc('')
    setJournalBankGlManual('')

    if (txn.DETAILS) {
      fetch(`${API}/api/receipts/journal-template?details=${encodeURIComponent(txn.DETAILS)}`)
        .then(r => r.json())
        .then(d => {
          if (d.ok && d.counterpart_account) {
            setJournalCounterpart(d.counterpart_account)
            setJournalCounterDesc(d.counterpart_desc || '')
          }
        })
        .catch(() => {})
    }
  }

  async function loadLastEinvoice(accname, branchname, bankAmount) {
    if (!accname) return
    setIrLoading(true)
    setIrPrevNote('')
    try {
      const params = new URLSearchParams({ accname, branchname: branchname || '' })
      const res = await fetch(`${API}/api/receipts/last-einvoice?${params}`).then(r => r.json())
      if (!res.ok) {
        setIrPrevNote(`שגיאה: ${res.error || 'לא ידועה'}`)
        return
      }
      if (!res.found) {
        setIrPrevNote('לא נמצאה חשבונית קודמת ללקוח זה')
        return
      }
      setIrDetails(res.details || '')
      const noteBase = `הועתק מ-${res.ivnum} (${fmt((res.ivdate || '').slice(0, 10))})`
      setIrPrevNote(res.same_month
        ? `⚠ קיימת חשבונית מס קבלה לחודש הנוכחי (${res.ivnum}) — האם אכן להפיק שוב?`
        : noteBase
      )
      if (res.items?.length > 0) {
        const target = bankAmount || 0
        const prevTotal = res.items.reduce((s, it) => s + (Number(it.PRICE) * Number(it.TQUANT) || 0), 0)
        setIrItems(res.items.map(it => {
          const tquant = Number(it.TQUANT) || 1
          let price = Number(it.PRICE) || 0
          if (prevTotal > 0 && target > 0) {
            price = Math.round((price / prevTotal) * target * 100) / 100
          } else if (target > 0) {
            price = target
          }
          return { PARTNAME: it.PARTNAME || '000', PDES: it.PDES || '', TQUANT: tquant, PRICE: price }
        }))
      }
    } catch (e) {
      setIrPrevNote(`שגיאה בטעינה: ${e.message}`)
    } finally {
      setIrLoading(false)
    }
  }

  async function openInvoiceReceiptModal(txn) {
    setIrModal(txn)
    setIrAccname('')
    setIrAccdes('')
    setIrDetails('')
    setIrItems([{ PARTNAME: '000', PDES: '', TQUANT: 1, PRICE: txn.SUM1 || 0 }])
    setIrSending(false)
    setIrError('')
    setIrPrevNote('')
    setIrDraftInfo(null)
    setIrFinalizing(false)
    setCustSuggestions([])
    setIrAccFocused(false)
    loadAllCustomers()

    if (txn.SUM1) {
      setCustSearching(true)
      try {
        const params = new URLSearchParams({ amount: txn.SUM1, branchname: txn.BRANCHNAME || '', curdate: (txn.CURDATE || '').slice(0, 10) })
        const res = await fetch(`${API}/api/receipts/customer-search?${params}`).then(r => r.json())
        if (res.ok) {
          const suggestions = (res.results || []).filter(s => !s.existing_rc)
          if (suggestions.length === 1) {
            const s = suggestions[0]
            setIrAccname(s.accname)
            setIrAccdes(s.accdes || '')
            await loadLastEinvoice(s.accname, txn.BRANCHNAME || '', txn.SUM1)
          } else if (suggestions.length > 1) {
            setCustSuggestions(suggestions)
          }
        }
      } catch { /* silent */ } finally {
        setCustSearching(false)
      }
    }
  }

  async function submitInvoiceReceipt() {
    if (!irAccname.trim()) { setIrError('יש להזין קוד לקוח'); return }
    setIrSending(true)
    setIrError('')
    try {
      const txn = irModal
      const resp = await fetch(`${API}/api/receipts/bank-line/create-invoice-receipt`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          txn_id:    txn.FNCNUM,
          accname:   irAccname.trim(),
          accdes:    irAccdes,
          amount:    txn.SUM1,
          ivdate:    (txn.CURDATE || '').slice(0, 10),
          cashname:  txn.CASHNAME,
          branchname: txn.BRANCHNAME,
          details:   irDetails,
          items:     irItems,
        }),
      })
      const data = await resp.json()
      if (!data.ok) {
        const d = data.detail
        const pMsg = (typeof d === 'string' ? d : null)
          || d?.error?.message?.value || (typeof d?.error?.message === 'string' ? d.error.message : null)
          || (typeof d === 'object' ? JSON.stringify(d) : null)
          || data.error || 'שגיאה'
        throw new Error(pMsg)
      }
      setIrDraftInfo({ ivnum: data.priority_ivnum })
      await loadAll()
    } catch (e) {
      setIrError(e.message)
    } finally {
      setIrSending(false)
    }
  }

  async function finalizeInvoiceReceipt() {
    if (!irDraftInfo || !irModal) return
    setIrFinalizing(true)
    setIrError('')
    try {
      const txn = irModal
      const resp = await fetch(`${API}/api/receipts/bank-line/finalize-receipt`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          txn_id:         txn.FNCNUM,
          priority_ivnum: irDraftInfo.ivnum,
          cashname:       txn.CASHNAME,
          doc_type:       'invoice_receipt',
        }),
      })
      const data = await resp.json()
      if (!data.ok) throw new Error(data.error || 'שגיאה')
      setLastIvnum(irDraftInfo.ivnum)
      setIrDraftInfo(null)
      setIrModal(null)
      await loadAll()
    } catch (e) {
      setIrError(e.message)
    } finally {
      setIrFinalizing(false)
    }
  }

  async function searchJournalAccounts(q, branchname) {
    if (!q || q.length < 2) { setJournalAccSuggestions([]); return }
    setJournalAccSearching(true)
    try {
      const params = new URLSearchParams({ q, branchname: branchname || '' })
      const res = await fetch(`${API}/api/receipts/search-all-accounts?${params}`).then(r => r.json())
      if (res.ok) setJournalAccSuggestions(res.accounts || [])
    } catch { /* silent */ } finally {
      setJournalAccSearching(false)
    }
  }

  async function loadAllCustomers() {
    if (allCustomers.length > 0) return
    try {
      const res = await fetch(`${API}/api/receipts/all-customers`).then(r => r.json())
      if (res.ok) setAllCustomers(res.accounts || [])
    } catch { /* silent */ }
  }

  async function cancelAction(itemId) {
    if (!window.confirm('לבטל את הפעולה ולהחזיר את שורת הבנק לרשימה?')) return
    setCancellingAction(itemId)
    try {
      const resp = await fetch(`${API}/api/receipts/action-queue/${itemId}/remove`, { method: 'POST' })
      const data = await resp.json()
      if (!data.ok) throw new Error(data.error || 'שגיאה')
      setDoneActions(prev => prev.filter(it => it.id !== itemId))
      await loadAll()
    } catch (e) {
      alert('שגיאה: ' + e.message)
    } finally {
      setCancellingAction(null)
    }
  }

  async function deleteAction(itemId) {
    if (!window.confirm('למחוק מהרשימה? שורת הבנק לא תחזור לתנועות הלא מותאמות.')) return
    try {
      const resp = await fetch(`${API}/api/receipts/action-queue/${itemId}/delete`, { method: 'POST' })
      const data = await resp.json()
      if (!data.ok) throw new Error(data.error || 'שגיאה')
      setDoneActions(prev => prev.filter(it => it.id !== itemId))
    } catch (e) {
      alert('שגיאה: ' + e.message)
    }
  }

  async function finalizeJournal(priorityFncnum, cashname) {
    setFinalizingJournal(priorityFncnum)
    try {
      const resp = await fetch(`${API}/api/receipts/journal/${encodeURIComponent(priorityFncnum)}/finalize`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cashname: cashname || '' }),
      })
      const data = await resp.json()
      if (data.ok) {
        const finalFncnum = data.fncnum || priorityFncnum
        setDoneActions(prev => prev.map(it =>
          it.priority_fncnum === priorityFncnum ? { ...it, is_final: true, priority_fncnum: finalFncnum } : it
        ))
        return
      }
      setFinalizeModal({ priorityFncnum, error: data.error })
      setFinalizeInputNum('')
    } catch (e) {
      setFinalizeModal({ priorityFncnum, error: e.message })
      setFinalizeInputNum('')
    } finally {
      setFinalizingJournal(null)
    }
  }

  async function confirmFinalizeJournal() {
    const { priorityFncnum } = finalizeModal
    const finalNum = finalizeInputNum.trim() || priorityFncnum
    setFinalizeSaving(true)
    try {
      const resp = await fetch(`${API}/api/receipts/journal/${encodeURIComponent(priorityFncnum)}/finalize`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ final_fncnum: finalNum }),
      })
      const data = await resp.json()
      if (!data.ok) throw new Error(data.error || 'שגיאה')
      const finalFncnum = data.fncnum || priorityFncnum
      setDoneActions(prev => prev.map(it =>
        it.priority_fncnum === priorityFncnum
          ? { ...it, is_final: true, priority_fncnum: finalFncnum }
          : it
      ))
      setFinalizeModal(null)
      setFinalizeInputNum('')
    } catch (e) {
      alert('שגיאה: ' + e.message)
    } finally {
      setFinalizeSaving(false)
    }
  }

  async function quickConfirm(txn) {
    setQuickConfirming(txn.FNCNUM)
    try {
      const resp = await fetch(`${API}/api/receipts/bank-line/quick-confirm`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          txn_id:     txn.FNCNUM,
          amount:     txn.SUM1,
          direction:  txn.direction,
          cashname:   txn.CASHNAME,
          branchname: txn.BRANCHNAME,
          ivdate:     (txn.CURDATE || '').slice(0, 10),
          details:    txn.DETAILS,
          bank_gl:    txn.bank_gl || '',
          pattern:    txn.auto_match,
        }),
      })
      const data = await resp.json()
      if (!data.ok) throw new Error(
        data.detail?.FORM?.InterfaceErrors?.text ||
        data.detail?.error?.message?.value ||
        data.detail?.error?.message ||
        data.error || 'שגיאה'
      )
      await loadAll()
    } catch (e) {
      alert('שגיאה באישור מהיר: ' + e.message)
    } finally {
      setQuickConfirming(null)
    }
  }

  function openTransferModal(txn) {
    setTransferModal(txn)
    setTransferAccname('')
    setTransferAccdes('')
    setTransferDetails('תשלום')
    setTransferError('')
    setTransferSuccess('')
    setTransferAccFocused(false)
    setTransferDropdownOpen(true)
    setTransferAccFromSugg(false)
    setAllSuppliers([])
    loadAllSuppliers(txn.BRANCHNAME)
    if (txn.DETAILS) {
      fetch(`${API}/api/receipts/transfer-suggestion?details=${encodeURIComponent(txn.DETAILS)}`)
        .then(r => r.json())
        .then(d => {
          if (d.ok && d.accname) {
            setTransferAccname(d.accname)
            setTransferAccdes(d.accdes || '')
            setTransferAccFromSugg(true)
          }
        })
        .catch(() => {})
    }
  }

  async function finalizeTransfer(ivnum) {
    setFinalizingTransfer(ivnum)
    try {
      const resp = await fetch(`${API}/api/receipts/transfer/${encodeURIComponent(ivnum)}/finalize`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}),
      })
      const data = await resp.json()
      if (data.ok) {
        const finalIvnum = data.final_ivnum || ivnum
        setDoneActions(prev => prev.map(it =>
          it.priority_fncnum === ivnum
            ? { ...it, is_final: true, priority_fncnum: finalIvnum, journal_fncnum: data.fncnum }
            : it
        ))
        return
      }
      setFinalizeTransferModal({ ivnum, error: data.error })
      setFinalizeTransferInput('')
    } catch (e) {
      setFinalizeTransferModal({ ivnum, error: e.message })
      setFinalizeTransferInput('')
    } finally {
      setFinalizingTransfer(null)
    }
  }

  async function confirmFinalizeTransfer() {
    const { ivnum } = finalizeTransferModal
    const finalNum = finalizeTransferInput.trim() || ivnum
    setFinalizeTransferSaving(true)
    try {
      const resp = await fetch(`${API}/api/receipts/transfer/${encodeURIComponent(ivnum)}/finalize`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ final_fncnum: finalNum }),
      })
      const data = await resp.json()
      if (!data.ok) throw new Error(data.error || 'שגיאה')
      setDoneActions(prev => prev.map(it =>
        it.priority_fncnum === ivnum
          ? { ...it, is_final: true, journal_fncnum: data.fncnum }
          : it
      ))
      setFinalizeTransferModal(null)
      setFinalizeTransferInput('')
    } catch (e) {
      alert('שגיאה: ' + e.message)
    } finally {
      setFinalizeTransferSaving(false)
    }
  }

  async function loadAllSuppliers(branch) {
    // Suppliers aren't tied to one branch in Priority, so the branch (from the
    // current bank transaction) is appended server-side to every account
    // number returned — refetch per modal open since it differs per transaction.
    try {
      const res = await fetch(`${API}/api/receipts/all-suppliers?branch=${encodeURIComponent(branch || '')}`).then(r => r.json())
      if (res.ok) { setAllSuppliers(res.accounts || []); setTransferDropdownOpen(true) }
    } catch { /* silent */ }
  }

  async function submitTransfer() {
    if (!transferAccname.trim()) { setTransferError('יש להזין חשבון ספק'); return }
    setTransferSending(true)
    setTransferError('')
    try {
      const txn  = transferModal
      const resp = await fetch(`${API}/api/receipts/bank-line/create-transfer`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          txn_id:     txn.FNCNUM,
          bank_ref:   txn.REF || '',
          direction:  txn.direction,
          amount:     txn.SUM1,
          cashname:   txn.CASHNAME,
          branchname: txn.BRANCHNAME,
          accname:    transferAccname.trim(),
          details:    transferDetails,
          ivdate:     (txn.CURDATE || '').slice(0, 10),
        }),
      })
      const data = await resp.json()
      if (!data.ok) throw new Error(
        data.detail?.FORM?.InterfaceErrors?.text ||
        data.detail?.error?.message ||
        data.error || 'שגיאה'
      )
      setTransferSuccess(data.ivnum ? `העברה בנקאית נוצרה: ${data.ivnum}` : 'העברה בנקאית נוצרה בהצלחה')
      await loadAll()
      setTimeout(() => { setTransferModal(null); setTransferSuccess('') }, 2000)
    } catch (e) {
      setTransferError(e.message)
    } finally {
      setTransferSending(false)
    }
  }

  async function saveBankGl(cashname, bankDesc) {
    const gl = (bankGlInputs[cashname] || '').trim()
    if (!gl) return
    setBankGlSaving(p => ({ ...p, [cashname]: true }))
    try {
      const res = await fetch(`${API}/api/receipts/bank-gl-map`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cashname, gl_account: gl, bank_desc: bankDesc }),
      }).then(r => r.json())
      if (!res.ok) throw new Error(res.error || 'שגיאה')
      await loadAll()
    } catch (e) {
      alert('שגיאה בשמירה: ' + e.message)
    } finally {
      setBankGlSaving(p => ({ ...p, [cashname]: false }))
    }
  }

  async function submitJournal() {
    if (!journalCounterpart.trim()) { setJournalError('יש להזין חשבון נגדי'); return }
    if (!journalBankGlResolved) { setJournalError('יש להגדיר חשבון GL לבנק זה בהגדרות הבנק'); return }
    setJournalSending(true)
    setJournalError('')
    try {
      const txn  = journalModal
      const resp = await fetch(`${API}/api/receipts/bank-line/create-journal`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          txn_id:              txn.FNCNUM,
          bank_ref:            txn.REF || '',
          direction:           txn.direction,
          amount:              txn.SUM1,
          cashname:            txn.CASHNAME,
          bank_name:           txn.bank_name || '',
          counterpart_account: journalCounterpart.trim(),
          counterpart_desc:    journalCounterDesc.trim(),
          details:             journalDetails,
          ivdate:              (txn.CURDATE || '').slice(0, 10),
          branchname:          txn.BRANCHNAME,
          bank_gl_account:     journalBankGlResolved || '',
          save_template:       true,
        }),
      })
      const data = await resp.json()
      if (!data.ok) throw new Error((data.detail?.error?.message) || data.error || 'שגיאה')
      setJournalSuccess(data.fncnum ? `פקודת יומן נוצרה: ${data.fncnum}` : 'פקודת יומן נוצרה בהצלחה')
      await loadAll()
      setTimeout(() => { setJournalModal(null); setJournalSuccess('') }, 2000)
    } catch (e) {
      setJournalError(e.message)
    } finally {
      setJournalSending(false)
    }
  }

  return (
    <div className="receipts-page" dir="rtl">
      <div className="receipts-container">

        {loading && <p className="receipts-loading">טוען נתונים...</p>}
        {error   && <p className="receipts-error">{error}</p>}

        {lastIvnum && (
          <div className="receipts-modal-note" style={{ marginBottom: 16 }}>
            ✓ קבלה נשלחה לפריוריטי — מזהה: <strong>{lastIvnum}</strong>
            <button style={{ marginRight: 12, cursor: 'pointer', background: 'none', border: 'none', color: '#1d4ed8' }} onClick={() => setLastIvnum(null)}>×</button>
          </div>
        )}

        {/* ── Bank GL settings banner ── */}
        {!loading && mode !== 'credit' && (() => {
          const missing = [...new Set(bankTxns.filter(t => !t.bank_gl && t.CASHNAME && t.account_type !== 'credit').map(t => t.CASHNAME))]
          if (!missing.length) return null
          return (
            <div style={{ background: '#fffbeb', border: '1px solid #f59e0b', borderRadius: 10,
              padding: '12px 18px', marginBottom: 20, display: 'flex', alignItems: 'center',
              gap: 12, flexWrap: 'wrap' }}>
              <span style={{ fontSize: 18 }}>⚠️</span>
              <span style={{ flex: 1, fontSize: 14, color: '#92400e' }}>
                <strong>{missing.length} חשבון/ות בנק</strong> לא מוגדרים — נדרש מיפוי CASHNAME ← חשבון GL בפריוריטי
              </span>
              <button
                onClick={() => setShowBankGlSettings(p => !p)}
                style={{ background: '#f59e0b', color: '#fff', border: 'none', borderRadius: 6,
                  padding: '6px 14px', cursor: 'pointer', fontWeight: 700, fontSize: 13 }}
              >
                {showBankGlSettings ? 'סגור הגדרות' : 'הגדרת חשבונות בנק'}
              </button>
            </div>
          )
        })()}

        {/* ── Bank GL settings panel ── */}
        {showBankGlSettings && !loading && mode !== 'credit' && (() => {
          const rows = [...new Map(bankTxns.filter(t => t.CASHNAME && t.account_type !== 'credit').map(t => [t.CASHNAME, t])).values()]
          return (
            <div style={{ background: '#fff', border: '1px solid #e5e9f0', borderRadius: 12,
              padding: '20px 24px', marginBottom: 24 }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                gap: 12, margin: '0 0 14px', flexWrap: 'wrap' }}>
                <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: '#1a1a2e' }}>
                  הגדרת חשבונות בנק — מיפוי CASHNAME → GL פריוריטי
                </h3>
                <button
                  onClick={() => loadAll(undefined, undefined, true)}
                  disabled={loading}
                  title="מאלץ זיהוי מחדש של חשבונות GL שטרם זוהו (למשל אחרי שיצרת חשבון GL חדש בפריוריטי), בלי להמתין לרענון היומי"
                  style={{ background: '#1d4ed8', color: '#fff', border: 'none', borderRadius: 6,
                    padding: '6px 14px', cursor: loading ? 'default' : 'pointer', fontWeight: 700,
                    fontSize: 13, opacity: loading ? 0.5 : 1, whiteSpace: 'nowrap' }}
                >
                  {loading ? 'מזהה…' : '🔄 רענון מאולץ'}
                </button>
              </div>
              <p style={{ margin: '0 0 14px', fontSize: 13, color: '#6b7280' }}>
                לכל CASHNAME יש להזין את מספר חשבון הבנק בתוכנית החשבונות של פריוריטי (לדוגמה: 4021-102).
                הגדרה זו נשמרת ומשמשת אוטומטית לכל פקודות היומן מבנק זה.
              </p>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                <thead>
                  <tr style={{ background: '#f8f9fb', color: '#374151' }}>
                    <th style={{ padding: '8px 12px', textAlign: 'right', fontWeight: 600 }}>CASHNAME</th>
                    <th style={{ padding: '8px 12px', textAlign: 'right', fontWeight: 600 }}>שם בנק</th>
                    <th style={{ padding: '8px 12px', textAlign: 'right', fontWeight: 600 }}>חשבון GL נוכחי</th>
                    <th style={{ padding: '8px 12px', textAlign: 'right', fontWeight: 600 }}>חשבון GL חדש</th>
                    <th style={{ padding: '8px 12px' }}></th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map(t => (
                    <tr key={t.CASHNAME} style={{ borderTop: '1px solid #e5e9f0' }}>
                      <td style={{ padding: '8px 12px', fontFamily: 'monospace', fontWeight: 700, color: '#1d4ed8' }}>{t.CASHNAME}</td>
                      <td style={{ padding: '8px 12px', color: '#374151' }}>{t.bank_name || t.bank_desc || '—'}</td>
                      <td style={{ padding: '8px 12px', fontFamily: 'monospace', color: t.bank_gl ? '#16a34a' : '#9ca3af' }}>
                        {t.bank_gl || 'לא מוגדר'}
                      </td>
                      <td style={{ padding: '8px 12px' }}>
                        <input
                          type="text"
                          placeholder="לדוגמה: 4021-102"
                          value={bankGlInputs[t.CASHNAME] || ''}
                          onChange={e => setBankGlInputs(p => ({ ...p, [t.CASHNAME]: e.target.value }))}
                          style={{ padding: '5px 8px', border: '1px solid #d1d5db', borderRadius: 6,
                            fontFamily: 'monospace', fontSize: 13, width: 130 }}
                        />
                      </td>
                      <td style={{ padding: '8px 12px' }}>
                        <button
                          onClick={() => saveBankGl(t.CASHNAME, t.bank_name || t.bank_desc || '')}
                          disabled={bankGlSaving[t.CASHNAME] || !bankGlInputs[t.CASHNAME]}
                          style={{ background: '#1d4ed8', color: '#fff', border: 'none', borderRadius: 6,
                            padding: '5px 12px', cursor: 'pointer', fontSize: 13, fontWeight: 600,
                            opacity: (!bankGlInputs[t.CASHNAME]) ? 0.4 : 1 }}
                        >
                          {bankGlSaving[t.CASHNAME] ? 'שומר...' : 'שמור'}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        })()}

        {!loading && (() => {
          const bankOnly   = bankTxns.filter(t => t.account_type !== 'credit')
          const creditOnly = bankTxns.filter(t => t.account_type === 'credit')

          const sharedControls = (
            <>
              <div className="receipts-days-selector">
                <label>סניף:</label>
                <select
                  value={branchFilter}
                  onChange={e => { const v = e.target.value; setBranchFilter(v); setDraftFilterBranch(v); setDoneFilterBranch(v); loadAll(undefined, v) }}
                >
                  <option value="all">כל הסניפים</option>
                  {allBranches.map(b => <option key={b} value={b}>{b}</option>)}
                </select>
              </div>
              <div className="receipts-days-selector">
                <label>בנק:</label>
                <select
                  value={bankFilter}
                  onChange={e => { const v = e.target.value; setBankFilter(v); loadAll(undefined, undefined, undefined, v) }}
                >
                  <option value="all">כל הבנקים</option>
                  {allBanks.map(bk => <option key={bk} value={bk}>{bk}</option>)}
                </select>
              </div>
              <div className="receipts-days-selector">
                <label>הצג מ-</label>
                <select
                  value={days}
                  onChange={e => { const d = Number(e.target.value); setDays(d); loadAll(d, branchFilter) }}
                >
                  <option value={30}>30 יום</option>
                  <option value={60}>60 יום</option>
                  <option value={90}>90 יום</option>
                  <option value={180}>חצי שנה</option>
                  <option value={365}>שנה</option>
                  <option value={730}>שנתיים</option>
                  <option value={3650}>כל התקופה</option>
                </select>
                {since && <span className="receipts-since">({fmt(since + 'T00:00:00Z')} ואילך)</span>}
              </div>
              <button className="receipts-refresh" onClick={() => loadAll(undefined, branchFilter)}>רענן</button>
            </>
          )

          const txnRows = (txns, isCredit = false) => txns.map(txn => {
            const match   = dismissedMatches.has(txn.FNCNUM) ? null : txn.auto_match
            const chosen  = rowActions[txn.FNCNUM] || txn.suggested_action || 'journal'
            const s       = ACTION_STYLES[chosen] || ACTION_STYLES.journal
            const busy    = actioning === txn.FNCNUM
            const qBusy   = quickConfirming === txn.FNCNUM
            const mStyle  = match ? ACTION_STYLES[match.action] || ACTION_STYLES.journal : null
            return (
              <tr key={txn.FNCNUM} style={match ? { background: '#f0fdf4' } : {}}>
                <td>{fmt(txn.CURDATE)}</td>
                <td>
                  <div>{txn.DETAILS}</div>
                  {match && (
                    <div style={{ fontSize: 11, marginTop: 2 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                        <span className="receipts-action-label" style={{ color: mStyle?.color, background: mStyle?.bg }}>
                          {mStyle?.label}
                        </span>
                        ← <strong>
                          {match.accname}{match.accdes ? ` – ${match.accdes}` : ''}
                        </strong>
                        {(match.action === 'receipt' || match.action === 'invoice_receipt')
                          && match.open_invoices?.[0]?.CUSTNAME && (
                          <> · לקוח {match.open_invoices[0].CUSTNAME}</>
                        )}
                      </div>
                      {match.open_invoices?.length > 0 && (
                        <div>
                          {match.open_invoices.map(inv => (
                            <span key={inv.IVNUM} style={{ display: 'inline-block', marginLeft: 10 }}>
                              · תסגור חשבונית {inv.IVNUM}
                              {inv.IVDATE && <> מתאריך {fmt(inv.IVDATE)}</>}
                              {inv.TOTPRICE != null && <> ע"ס {fmtAmount(inv.TOTPRICE)}</>}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </td>
                <td><AmountCell sum1={txn.SUM1} direction={txn.direction} /></td>
                <td className="receipts-small" title={txn.bank_code}>
                  {txn.bank_desc || txn.bank_code}
                  {isCredit && txn.card_last4 && (
                    <span style={{ fontFamily: 'monospace', color: '#6b7280', fontSize: 11, marginRight: 5 }}>
                      ····{txn.card_last4}
                    </span>
                  )}
                </td>
                <td>{txn.BRANCHNAME}</td>
                <td>
                  {match ? (
                    <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                      <button
                        style={{
                          background: '#16a34a', color: '#fff', border: 'none',
                          borderRadius: 6, padding: '5px 14px', cursor: qBusy ? 'default' : 'pointer',
                          fontWeight: 700, fontSize: 13, whiteSpace: 'nowrap',
                          opacity: qBusy ? 0.6 : 1,
                        }}
                        disabled={qBusy}
                        onClick={() => quickConfirm(txn)}
                      >
                        {qBusy ? '...' : '✓ אשר'}
                      </button>
                      <button
                        style={{
                          background: 'none', border: '1px solid #d1d5db', borderRadius: 6,
                          padding: '5px 10px', cursor: 'pointer', fontSize: 12, color: '#6b7280',
                        }}
                        onClick={() => {
                          if (chosen === 'receipt') openReceiptModal(txn, 'receipt')
                          else if (chosen === 'invoice_receipt') openInvoiceReceiptModal(txn)
                          else if (chosen === 'journal') openJournalModal(txn)
                          else openTransferModal(txn)
                        }}
                      >
                        ✎ ערוך
                      </button>
                      <button
                        title="בטל את ההמלצה וטפל בתנועה ידנית"
                        style={{
                          background: 'none', border: '1px solid #d1d5db', borderRadius: 6,
                          padding: '5px 8px', cursor: 'pointer', fontSize: 12, color: '#9ca3af',
                        }}
                        onClick={() => setDismissedMatches(prev => new Set(prev).add(txn.FNCNUM))}
                      >
                        ✕
                      </button>
                    </div>
                  ) : (
                    <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                      <select
                        className="receipts-action-select"
                        style={{ minWidth: 170, color: s.color, borderColor: s.color + '88' }}
                        value={chosen}
                        onChange={e => setRowActions(prev => ({ ...prev, [txn.FNCNUM]: e.target.value }))}
                      >
                        <option value="receipt">הפקת קבלה</option>
                        <option value="invoice_receipt">חשבונית מס קבלה</option>
                        <option value="journal">רישום פקודת יומן</option>
                        <option value="transfer">הפקת העברה בנקאית</option>
                      </select>
                      <button
                        className="receipts-action-btn"
                        style={{ color: s.color, background: s.bg, borderColor: s.color + '88', whiteSpace: 'nowrap' }}
                        disabled={busy}
                        onClick={() => {
                          if (chosen === 'receipt') openReceiptModal(txn, 'receipt')
                          else if (chosen === 'invoice_receipt') openInvoiceReceiptModal(txn)
                          else if (chosen === 'journal') openJournalModal(txn)
                          else if (chosen === 'transfer') openTransferModal(txn)
                          else { setActioning(txn.FNCNUM); recordAction(txn, chosen) }
                        }}
                      >
                        {busy ? '...' : '← בצע'}
                      </button>
                    </div>
                  )}
                </td>
              </tr>
            )
          })

          return (
          <>
            {/* ── Section 1: תנועות פתוחות בבנק ── */}
            <section className="receipts-section">
              <div className="receipts-section-header">
                <h2 style={{cursor:'pointer', userSelect:'none', display:'flex', alignItems:'center', gap:8}} onClick={() => setUnmatchedOpen(o => !o)}>
                  <span style={{fontSize:11, color:'#9ca3af', fontWeight:400}}>{unmatchedOpen ? '▼' : '▶'}</span>
                  תנועות פתוחות בבנק
                  <span className="receipts-tab-badge" style={{background:'#3b82f6', color:'#fff', marginRight:4}}>
                    {mode === 'credit' ? creditOnly.length : bankOnly.length}
                  </span>
                </h2>
                {unmatchedOpen && sharedControls}
              </div>

              {unmatchedOpen && mode === 'bank' && (
                bankOnly.length === 0 ? (
                  <p className="receipts-empty">אין תנועות בנק פתוחות בתקופה זו</p>
                ) : (
                  <div className="receipts-table-wrap">
                    <table className="receipts-table">
                      <thead>
                        <tr>
                          <th>תאריך</th>
                          <th>תיאור תנועה</th>
                          <th>סכום</th>
                          <th>חשבון בנק</th>
                          <th>סניף</th>
                          <th>פעולה</th>
                        </tr>
                      </thead>
                      <tbody>
                        {txnRows(bankOnly)}
                      </tbody>
                    </table>
                  </div>
                )
              )}

              {unmatchedOpen && mode === 'credit' && (
                creditOnly.length === 0 ? (
                  <p className="receipts-empty">אין תנועות אשראי פתוחות בתקופה זו</p>
                ) : (
                  <div className="receipts-table-wrap">
                    <table className="receipts-table">
                      <thead>
                        <tr>
                          <th>תאריך</th>
                          <th>תיאור תנועה</th>
                          <th>סכום</th>
                          <th>כרטיס אשראי</th>
                          <th>סניף</th>
                          <th>פעולה</th>
                        </tr>
                      </thead>
                      <tbody>
                        {txnRows(creditOnly, true)}
                      </tbody>
                    </table>
                  </div>
                )
              )}
            </section>

            {/* ── Section 2: טיוטות ── */}
            {mode === 'credit' ? null : (() => {
              const nonFinalActions = doneActions.filter(it => it.priority_fncnum && !it.is_final)
              const closedDrafts = closedReceipts.filter(r => !(r.doc_type === 'invoice_receipt' ? r.final_ivnum : r.rc_ivnum))
              const total = draftReceipts.length + closedDrafts.length + nonFinalActions.length
              if (total === 0) return null

              const draftBranches = [...new Set([
                ...draftReceipts.map(r => r.branchname).filter(Boolean),
                ...closedDrafts.map(r => r.branchname).filter(Boolean),
                ...nonFinalActions.map(r => r.branchname).filter(Boolean),
              ])].sort()

              const filteredDraftReceipts = draftReceipts.filter(r =>
                draftFilterBranch === 'all' || r.branchname === draftFilterBranch
              )
              const filteredClosedDrafts = closedDrafts.filter(r =>
                draftFilterBranch === 'all' || r.branchname === draftFilterBranch
              )
              const filteredNonFinalActions = nonFinalActions.filter(r =>
                draftFilterBranch === 'all' || r.branchname === draftFilterBranch
              )

              return (
              <section className="receipts-section">
                <div className="receipts-section-header">
                  <h2 style={{cursor:'pointer', userSelect:'none', display:'flex', alignItems:'center', gap:8}} onClick={() => setDraftsOpen(o => !o)}>
                    <span style={{fontSize:11, color:'#9ca3af', fontWeight:400}}>{draftsOpen ? '▼' : '▶'}</span>
                    טיוטות
                  </h2>
                  <span className="receipts-badge" style={{ background: '#f59e0b' }}>{total}</span>
                  {draftsOpen && draftBranches.length > 0 && (
                    <div className="receipts-days-selector">
                      <label>סניף:</label>
                      <select value={draftFilterBranch} onChange={e => setDraftFilterBranch(e.target.value)}>
                        <option value="all">כל הסניפים</option>
                        {draftBranches.map(b => <option key={b} value={b}>{b}</option>)}
                      </select>
                    </div>
                  )}
                </div>
                {draftsOpen && <div className="receipts-table-wrap">
                  <table className="receipts-table">
                    <thead>
                      <tr>
                        <th>תאריך</th>
                        <th>תיאור</th>
                        <th>סכום</th>
                        <th>סוג פעולה</th>
                        <th>מספר טיוטה</th>
                        <th>סניף</th>
                        <th></th>
                      </tr>
                    </thead>
                    <tbody>
                      {filteredDraftReceipts.map(rec => {
                        const s = ACTION_STYLES[rec.doc_type] || ACTION_STYLES.receipt
                        return (
                          <tr key={rec.id}>
                            <td>{fmt(rec.approved_at || rec.created_at)}</td>
                            <td>
                              <div style={{ fontWeight: 600 }}>{rec.accdes || rec.accname}</div>
                              <div style={{ fontSize: 11, color: '#6b7280' }}>{rec.details}</div>
                            </td>
                            <td><AmountCell sum1={rec.totprice} direction="+" /></td>
                            <td>
                              <span className="receipts-action-label" style={{ color: s.color, background: s.bg }}>
                                {s.label}
                              </span>
                            </td>
                            <td className="receipts-mono">
                              <span style={{ fontSize: 12, color: '#6b7280' }}>טיוטה: {rec.priority_ivnum || '—'}</span>
                            </td>
                            <td>{rec.branchname}</td>
                            <td>
                              <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                                {rec.doc_type !== 'invoice_receipt' && (
                                  <button
                                    className="receipts-btn receipts-btn-approve"
                                    style={{ fontSize: 12, padding: '3px 10px' }}
                                    onClick={() => closeReceipt(rec)}
                                    disabled={closing === rec.id}
                                  >
                                    {closing === rec.id ? 'סוגר...' : 'סגור קבלה'}
                                  </button>
                                )}
                                {rec.doc_type === 'invoice_receipt' && (
                                  <button
                                    className="receipts-btn receipts-btn-approve"
                                    style={{ fontSize: 12, padding: '3px 10px' }}
                                    onClick={() => closeEinvoice(rec)}
                                    disabled={closingEinvoice === rec.id}
                                  >
                                    {closingEinvoice === rec.id ? 'סוגר...' : 'סגור חשבונית'}
                                  </button>
                                )}
                                <button
                                  className="receipts-btn receipts-btn-reject"
                                  style={{ fontSize: 12, padding: '3px 8px' }}
                                  onClick={() => deleteReceipt(rec)}
                                  disabled={deleting === rec.id}
                                >בטל</button>
                              </div>
                            </td>
                          </tr>
                        )
                      })}
                      {filteredClosedDrafts.map(rec => {
                        const s = ACTION_STYLES[rec.doc_type] || ACTION_STYLES.receipt
                        return (
                          <tr key={rec.id}>
                            <td>{fmt(rec.approved_at || rec.created_at)}</td>
                            <td>
                              <div style={{ fontWeight: 600 }}>{rec.accdes || rec.accname}</div>
                              <div style={{ fontSize: 11, color: '#6b7280' }}>{rec.details}</div>
                            </td>
                            <td><AmountCell sum1={rec.totprice} direction="+" /></td>
                            <td>
                              <span className="receipts-action-label" style={{ color: s.color, background: s.bg }}>
                                {s.label}
                              </span>
                            </td>
                            <td className="receipts-mono">
                              <span style={{ fontSize: 12, color: '#6b7280' }}>נשלח לפריוריטי: {rec.priority_ivnum || '—'}</span>
                            </td>
                            <td>{rec.branchname}</td>
                            <td>
                              <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                                <button
                                  className="receipts-btn receipts-btn-approve"
                                  style={{ fontSize: 12, padding: '3px 10px' }}
                                  onClick={() => refreshFinalNumbers(rec)}
                                  disabled={refreshingFinal === rec.id}
                                >
                                  {refreshingFinal === rec.id ? '...' : 'רענן מספרים'}
                                </button>
                                <button
                                  className="receipts-btn receipts-btn-reject"
                                  style={{ fontSize: 12, padding: '3px 8px' }}
                                  onClick={() => deleteReceipt(rec)}
                                  disabled={deleting === rec.id}
                                >מחוק</button>
                              </div>
                            </td>
                          </tr>
                        )
                      })}
                      {filteredNonFinalActions.map(item => {
                        const actionLabel = item.action === 'transfer' ? 'העברה בנקאית' : 'פקודת יומן'
                        const actionColor = item.action === 'transfer' ? '#1d4ed8' : '#b45309'
                        const actionBg    = item.action === 'transfer' ? '#eff6ff'  : '#fff7ed'
                        return (
                          <tr key={item.id}>
                            <td>{fmt(item.curdate)}</td>
                            <td>
                              <div>{item.details}</div>
                              <div style={{ fontSize: 10, color: '#9ca3af' }}>
                                {item.accname1}{item.accdes1 ? ` · ${item.accdes1}` : ''}{item.accname2 ? ` → ${item.accname2}` : ''}
                              </div>
                            </td>
                            <td><AmountCell sum1={item.sum1} direction={item.direction} /></td>
                            <td>
                              <span className="receipts-action-label" style={{ color: actionColor, background: actionBg }}>
                                {actionLabel}
                              </span>
                            </td>
                            <td className="receipts-mono" style={{ fontSize: 11 }}>
                              <div style={{ color: '#6c5ce7', fontWeight: 700 }}>{item.priority_fncnum}</div>
                            </td>
                            <td>{item.branchname}</td>
                            <td style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                              {item.action === 'transfer' ? (
                                <button
                                  onClick={() => finalizeTransfer(item.priority_fncnum)}
                                  disabled={finalizingTransfer === item.priority_fncnum}
                                  style={{ fontSize: 11, padding: '2px 8px', cursor: 'pointer',
                                           background: '#eff6ff', border: '1px solid #1d4ed8',
                                           borderRadius: 4, color: '#1d4ed8', whiteSpace: 'nowrap' }}
                                >
                                  {finalizingTransfer === item.priority_fncnum ? '...' : 'אישור העברה בנקאית'}
                                </button>
                              ) : (
                                <button
                                  onClick={() => finalizeJournal(item.priority_fncnum, item.cashname)}
                                  disabled={finalizingJournal === item.priority_fncnum}
                                  style={{ fontSize: 11, padding: '2px 8px', cursor: 'pointer',
                                           background: '#fff7ed', border: '1px solid #b45309',
                                           borderRadius: 4, color: '#b45309', whiteSpace: 'nowrap' }}
                                >
                                  {finalizingJournal === item.priority_fncnum ? '...' : 'רישום תנועת יומן'}
                                </button>
                              )}
                              <button
                                onClick={() => cancelAction(item.id)}
                                disabled={cancellingAction === item.id}
                                style={{ fontSize: 11, padding: '2px 8px', cursor: 'pointer',
                                         background: '#fef2f2', border: '1px solid #dc2626',
                                         borderRadius: 4, color: '#dc2626', whiteSpace: 'nowrap' }}
                              >
                                {cancellingAction === item.id ? '...' : 'החזר לרשימה'}
                              </button>
                              <button
                                onClick={() => deleteAction(item.id)}
                                style={{ fontSize: 11, padding: '2px 8px', cursor: 'pointer',
                                         background: '#f9fafb', border: '1px solid #9ca3af',
                                         borderRadius: 4, color: '#6b7280', whiteSpace: 'nowrap' }}
                              >
                                מחוק
                              </button>
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>}
              </section>
              )
            })()}

            {/* ── Section 3: פקודות סופיות ── */}
            {mode === 'credit' ? null : (() => {
              const finalActions = doneActions.filter(it => it.priority_fncnum && it.is_final)
              const closedFinal = closedReceipts.filter(r => r.doc_type === 'invoice_receipt' ? r.final_ivnum : r.rc_ivnum)
              const total = closedFinal.length + finalActions.length
              if (total === 0) return null

              const doneBranches = [...new Set([
                ...closedFinal.map(r => r.branchname).filter(Boolean),
                ...finalActions.map(r => r.branchname).filter(Boolean),
              ])].sort()

              const filteredReceipts = closedFinal.filter(r =>
                (doneFilterBranch === 'all' || r.branchname === doneFilterBranch) &&
                (doneFilterAction === 'all' || r.doc_type === doneFilterAction)
              )
              const filteredFinalActions = finalActions.filter(r =>
                (doneFilterBranch === 'all' || r.branchname === doneFilterBranch) &&
                (doneFilterAction === 'all' || r.action === doneFilterAction)
              )

              return (
              <section className="receipts-section">
                <div className="receipts-section-header">
                  <h2 style={{cursor:'pointer', userSelect:'none', display:'flex', alignItems:'center', gap:8}} onClick={() => setFinalOpen(o => !o)}>
                    <span style={{fontSize:11, color:'#9ca3af', fontWeight:400}}>{finalOpen ? '▼' : '▶'}</span>
                    פקודות סופיות
                  </h2>
                  <span className="receipts-badge" style={{ background: '#16a34a' }}>{total}</span>
                  {finalOpen && <>
                    <div className="receipts-days-selector">
                      <label>סניף:</label>
                      <select value={doneFilterBranch} onChange={e => setDoneFilterBranch(e.target.value)}>
                        <option value="all">כל הסניפים</option>
                        {doneBranches.map(b => <option key={b} value={b}>{b}</option>)}
                      </select>
                    </div>
                    <div className="receipts-days-selector">
                      <label>פעולה:</label>
                      <select value={doneFilterAction} onChange={e => setDoneFilterAction(e.target.value)}>
                        <option value="all">הכל</option>
                        <option value="receipt">קבלה</option>
                        <option value="invoice_receipt">חשבונית קבלה</option>
                        <option value="journal">פקודת יומן</option>
                        <option value="transfer">העברה בנקאית</option>
                      </select>
                    </div>
                  </>}
                </div>
                {finalOpen && <div className="receipts-table-wrap">
                  <table className="receipts-table">
                    <thead>
                      <tr>
                        <th>תאריך</th>
                        <th>תיאור</th>
                        <th>סכום</th>
                        <th>פעולה</th>
                        <th>מספרים בפריוריטי</th>
                        <th>סניף</th>
                        <th></th>
                      </tr>
                    </thead>
                    <tbody>
                      {filteredReceipts.map(rec => {
                        const s = ACTION_STYLES[rec.doc_type] || ACTION_STYLES.receipt
                        return (
                          <tr key={rec.id} style={{ opacity: 0.6 }}>
                            <td>{fmt(rec.approved_at)}</td>
                            <td>{rec.accdes || rec.accname}</td>
                            <td><AmountCell sum1={rec.totprice} direction="+" /></td>
                            <td>
                              <span className="receipts-action-label" style={{ color: s.color, background: s.bg }}>
                                {s.label}
                              </span>
                            </td>
                            <td className="receipts-mono">
                              {(() => {
                                const finalNum = rec.doc_type === 'invoice_receipt' ? rec.final_ivnum : rec.rc_ivnum
                                if (finalNum) {
                                  return <>
                                    <div style={{ color: rec.doc_type === 'invoice_receipt' ? '#7c3aed' : '#16a34a', fontWeight: 700, fontSize: 12 }}>
                                      {rec.doc_type === 'invoice_receipt' ? 'חשבונית סופית' : 'קבלה סופית'}: {finalNum}
                                    </div>
                                    {rec.fncnum && /^\d+$/.test(String(rec.fncnum)) && (
                                      <div style={{ color: '#b45309', fontWeight: 600, fontSize: 11 }}>
                                        תנועת יומן: {rec.fncnum}
                                      </div>
                                    )}
                                  </>
                                }
                                return <>
                                  <div style={{ color: '#6b7280', fontSize: 11 }}>טיוטה: {rec.priority_ivnum || '—'}</div>
                                  {rec.fncnum && /^\d+$/.test(String(rec.fncnum)) && (
                                    <div style={{ color: '#b45309', fontWeight: 600, fontSize: 11 }}>
                                      תנועת יומן: {rec.fncnum}
                                    </div>
                                  )}
                                </>
                              })()}
                            </td>
                            <td>{rec.branchname}</td>
                            <td className="receipts-actions">
                              {!(rec.doc_type === 'invoice_receipt' ? rec.final_ivnum : rec.rc_ivnum) && (
                                <button
                                  className="receipts-btn receipts-btn-approve"
                                  style={{ fontSize: '0.75em', padding: '2px 6px' }}
                                  onClick={() => refreshFinalNumbers(rec)}
                                  disabled={refreshingFinal === rec.id}
                                  title="שלוף מספר קבלה סופי ותנועת יומן מפריוריטי"
                                >
                                  {refreshingFinal === rec.id ? '...' : 'רענן מספרים'}
                                </button>
                              )}
                              <button
                                onClick={() => deleteReceipt(rec)}
                                disabled={deleting === rec.id}
                                style={{ fontSize: 11, padding: '2px 8px', cursor: 'pointer',
                                         background: '#f9fafb', border: '1px solid #9ca3af',
                                         borderRadius: 4, color: '#6b7280', whiteSpace: 'nowrap' }}
                              >
                                {deleting === rec.id ? '...' : 'מחוק'}
                              </button>
                            </td>
                          </tr>
                        )
                      })}
                      {filteredFinalActions.map(item => {
                        const actionLabel = item.action === 'transfer' ? 'העברה בנקאית' : 'פקודת יומן'
                        const actionColor = item.action === 'transfer' ? '#1d4ed8' : '#b45309'
                        const actionBg    = item.action === 'transfer' ? '#eff6ff'  : '#fff7ed'
                        return (
                          <tr key={item.id} style={{ opacity: 0.65 }}>
                            <td>{fmt(item.curdate)}</td>
                            <td>
                              <div>{item.details}</div>
                              <div style={{ fontSize: 10, color: '#9ca3af' }}>
                                {item.accname1}{item.accdes1 ? ` · ${item.accdes1}` : ''}{item.accname2 ? ` → ${item.accname2}` : ''}
                              </div>
                            </td>
                            <td><AmountCell sum1={item.sum1} direction={item.direction} /></td>
                            <td>
                              <span className="receipts-action-label" style={{ color: actionColor, background: actionBg }}>
                                {actionLabel}
                              </span>
                            </td>
                            <td className="receipts-mono" style={{ fontSize: 11 }}>
                              {item.action === 'transfer' ? (
                                <>
                                  <div style={{ color: '#1d4ed8', fontWeight: 700 }}>{item.priority_fncnum}</div>
                                  {item.journal_fncnum && (
                                    <div style={{ color: '#b45309', fontWeight: 600, fontSize: 10 }}>תנועת יומן: {item.journal_fncnum}</div>
                                  )}
                                  <div style={{ fontSize: 10, color: '#15803d', fontWeight: 400 }}>סופי</div>
                                </>
                              ) : (
                                <>
                                  <div style={{ color: '#15803d', fontWeight: 700 }}>{item.priority_fncnum}</div>
                                  <div style={{ fontSize: 10, color: '#15803d', fontWeight: 400 }}>סופי</div>
                                </>
                              )}
                            </td>
                            <td>{item.branchname}</td>
                            <td>
                              <button
                                onClick={() => deleteAction(item.id)}
                                style={{ fontSize: 11, padding: '2px 8px', cursor: 'pointer',
                                         background: '#f9fafb', border: '1px solid #9ca3af',
                                         borderRadius: 4, color: '#6b7280', whiteSpace: 'nowrap' }}
                              >
                                מחוק
                              </button>
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>}
              </section>
              )
            })()}
          </>
          )
        })()}
      </div>


      {/* ── Receipt Modal ── */}
      {receiptModal && (
        <div className="receipts-modal-overlay" onClick={e => { if (e.target === e.currentTarget) { setReceiptModal(null); setOpenInvoices([]); setSelectedInvoices(new Set()) } }}>
          <div className="receipts-modal" dir="rtl">
            <h3 style={{ color: receiptDocType === 'invoice_receipt' ? '#7c3aed' : undefined }}>
              {receiptDocType === 'invoice_receipt' ? 'חשבונית מס קבלה' : 'הפקת קבלה'}
            </h3>

            <table className="receipts-modal-info">
              <tbody>
                <tr>
                  <th>תאריך:</th>
                  <td>{fmt(receiptModal.CURDATE)}</td>
                </tr>
                <tr>
                  <th>בנק:</th>
                  <td>{receiptModal.bank_desc || receiptModal.CASHNAME}</td>
                </tr>
                <tr>
                  <th>סניף:</th>
                  <td>{receiptModal.BRANCHNAME}</td>
                </tr>
                <tr>
                  <th>סכום:</th>
                  <td><strong style={{ color: '#16a34a' }}>{fmtAmount(receiptModal.SUM1)}</strong></td>
                </tr>
              </tbody>
            </table>

            {custSearching && (
              <p style={{ fontSize: 13, color: '#6b7280', margin: '0 0 12px' }}>מחפש לקוח...</p>
            )}
            {custSuggestions.length > 0 && (
              <div style={{ marginBottom: 14 }}>
                <p style={{ fontSize: 12, color: '#6b7280', margin: '0 0 6px' }}>התאמות שנמצאו — לחץ לבחירה:</p>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  {custSuggestions.map(c => (
                    <button
                      key={c.accname}
                      onClick={() => {
                        setModalAccname(c.accname)
                        setModalAccdes(c.accdes || '')
                        setCustSuggestions([])
                        if (c.existing_rc) {
                          importExistingReceipt(receiptModal, c)
                          return
                        } else {
                          setExistingRc(null)
                          setOpenInvoices([])
                          setSelectedInvoices(new Set())
                          searchOpenInvoices(c.accname, receiptModal)
                        }
                      }}
                      style={{
                        textAlign: 'right', padding: '6px 10px', borderRadius: 6,
                        border: c.existing_rc ? '1px solid #bbf7d0' : '1px solid #bfdbfe',
                        background: c.existing_rc ? '#f0fdf4' : '#eff6ff',
                        cursor: 'pointer', fontSize: 13,
                      }}
                    >
                      <span style={{ fontFamily: 'monospace', fontWeight: 700, color: '#1d4ed8' }}>{c.accname}</span>
                      {' — '}{c.accdes}
                      {c.branchname && <span style={{ color: '#9ca3af', fontSize: 11, marginRight: 6 }}>סניף {c.branchname}</span>}
                      {c.existing_rc && (
                        <span style={{ display: 'block', color: '#16a34a', fontSize: 11, fontWeight: 600, marginTop: 2 }}>
                          קבלה קיימת: {c.existing_rc}
                        </span>
                      )}
                    </button>
                  ))}
                </div>
              </div>
            )}

            <div className="receipts-modal-field" style={{ position: 'relative' }}>
              <label>קוד לקוח בפריוריטי (ACCNAME) *</label>
              <input
                type="text"
                placeholder={allCustomers.length > 0 ? 'חפש לפי קוד או שם לקוח...' : 'לדוגמה: 50440 או שם לקוח'}
                value={modalAccname}
                onFocus={() => setReceiptAccFocused(true)}
                onBlur={e => {
                  setTimeout(() => setReceiptAccFocused(false), 150)
                  const v = e.target.value.trim()
                  if (v.length >= 2) searchOpenInvoices(v, receiptModal)
                }}
                onChange={e => {
                  const v = e.target.value
                  setModalAccname(v)
                  setModalAccdes('')
                  setOpenInvoices([])
                  setSelectedInvoices(new Set())
                }}
                autoFocus={custSuggestions.length === 0}
              />
              {receiptAccFocused && allCustomers.length > 0 && (() => {
                const q = modalAccname.trim().toLowerCase()
                const branch = receiptModal?.BRANCHNAME
                const filtered = allCustomers
                  .filter(a => q.length === 0 || a.accname.toLowerCase().includes(q) || a.accdes.toLowerCase().includes(q))
                  .sort((a, b) => (a.branchname === branch ? 0 : 1) - (b.branchname === branch ? 0 : 1))
                  .slice(0, 60)
                if (filtered.length === 0) return null
                const pick = (a) => {
                  setModalAccname(a.accname)
                  setModalAccdes(a.accdes || '')
                  setReceiptAccFocused(false)
                  searchOpenInvoices(a.accname, receiptModal)
                }
                return (
                  <div style={{ border: '1px solid #e5e7eb', borderRadius: 6, marginTop: 2, background: '#fff', maxHeight: 200, overflowY: 'auto', position: 'absolute', width: '100%', zIndex: 20, boxShadow: '0 4px 12px rgba(0,0,0,0.12)' }}>
                    {filtered.map(a => (
                      <button
                        key={a.accname}
                        onMouseDown={() => pick(a)}
                        style={{ display: 'block', width: '100%', textAlign: 'right', padding: '6px 10px',
                          border: 'none', background: 'none', cursor: 'pointer', fontSize: 13,
                          borderBottom: '1px solid #f3f4f6' }}
                      >
                        <span style={{ fontFamily: 'monospace', fontWeight: 700, color: '#1d4ed8' }}>{a.accname}</span>
                        {a.accdes && <span style={{ color: '#374151', marginRight: 8 }}>{a.accdes}</span>}
                      </button>
                    ))}
                  </div>
                )
              })()}
              {modalAccdes && (
                <div style={{ marginTop: 4, fontSize: 13, color: '#15803d', fontWeight: 600 }}>
                  {modalAccdes}
                </div>
              )}
            </div>

            {invoiceSearching && (
              <p style={{ fontSize: 12, color: '#6b7280', margin: '0 0 6px' }}>מחפש חשבוניות...</p>
            )}
            {!invoiceSearching && openInvoices.length > 0 && (
              <div style={{ marginBottom: 10 }}>
                <p style={{ fontSize: 11, color: '#6b7280', margin: '0 0 4px' }}>חשבוניות בסכום זה — לחץ לקישור:</p>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                  {openInvoices.map(inv => {
                    const selected = selectedInvoices.has(inv.IVNUM)
                    return (
                      <label
                        key={inv.IVNUM}
                        style={{
                          display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap',
                          padding: '3px 8px', borderRadius: 5, cursor: 'pointer',
                          border: `1px solid ${selected ? '#16a34a' : '#bbf7d0'}`,
                          background: selected ? '#f0fdf4' : '#f9fffe',
                          fontSize: 12,
                        }}
                      >
                        <input type="checkbox" checked={selected} onChange={() => {
                          setSelectedInvoices(prev => {
                            const next = new Set(prev)
                            next.has(inv.IVNUM) ? next.delete(inv.IVNUM) : next.add(inv.IVNUM)
                            return next
                          })
                        }} />
                        <span style={{ fontFamily: 'monospace', fontWeight: 700, color: '#1d4ed8', fontSize: 11 }}>{inv.IVNUM}</span>
                        <span style={{ color: '#374151', fontSize: 11 }}>{inv.CDES}</span>
                        <span style={{ color: '#16a34a', fontWeight: 600, fontSize: 11 }}>{fmtAmount(inv.TOTPRICE)}</span>
                        <span style={{ color: '#9ca3af', fontSize: 10 }}>{fmt(inv.IVDATE)}</span>
                      </label>
                    )
                  })}
                </div>
                {selectedInvoices.size > 0 && (
                  <p style={{ fontSize: 11, color: '#15803d', margin: '3px 0 0', fontStyle: 'italic' }}>
                    {selectedInvoices.size === 1
                      ? `תקושר לחשבונית ${[...selectedInvoices][0]}`
                      : `תקושרו ${selectedInvoices.size} חשבוניות`}
                  </p>
                )}
              </div>
            )}

            <div className="receipts-modal-field">
              <label>פרטים (תיאור)</label>
              <input
                type="text"
                value={modalDetails}
                onChange={e => setModalDetails(e.target.value)}
              />
            </div>

            {existingRc && (
              <div style={{
                margin: '8px 0', padding: '10px 14px', borderRadius: 8,
                background: '#f0fdf4', border: '1px solid #86efac',
                color: '#15803d', fontSize: 13, fontWeight: 600,
              }}>
                קבלה סופית קיימת בפריוריטי:&nbsp;
                <span style={{ fontFamily: 'monospace', fontSize: 14 }}>{existingRc}</span>
              </div>
            )}

            {draftInfo && (
              <div style={{
                margin: '8px 0', padding: '10px 14px', borderRadius: 8,
                background: '#eff6ff', border: '1px solid #93c5fd',
                color: '#1d4ed8', fontSize: 13, fontWeight: 600,
              }}>
                טיוטה נוצרה בפריוריטי:&nbsp;
                <span style={{ fontFamily: 'monospace', fontSize: 14 }}>{draftInfo.ivnum}</span>
                <div style={{ fontWeight: 400, marginTop: 4, color: '#374151' }}>
                  יש לבדוק את הפרטים ולאשר סופית כדי לסגור את המסמך ולבצע התאמת בנק.
                </div>
              </div>
            )}

            {modalError && <p className="receipts-error" style={{ margin: '8px 0' }}>{modalError}</p>}

            <div className="receipts-modal-actions">
              {!draftInfo ? (
                <button
                  className="receipts-btn receipts-btn-approve"
                  onClick={submitReceipt}
                  disabled={modalSending || !!existingRc}
                >
                  {modalSending ? 'שולח לפריוריטי...' : receiptDocType === 'invoice_receipt' ? 'הפק חשבונית מס קבלה' : 'הפק קבלה'}
                </button>
              ) : (
                <button
                  className="receipts-btn receipts-btn-approve"
                  onClick={finalizeReceipt}
                  disabled={finalizing}
                >
                  {finalizing ? 'מאשר סופית...' : 'אשר סופי'}
                </button>
              )}
              <button
                className="receipts-btn receipts-btn-cancel"
                onClick={() => { setReceiptModal(null); setOpenInvoices([]); setSelectedInvoices(new Set()); setExistingRc(null); setDraftInfo(null) }}
                disabled={modalSending || finalizing}
              >
                {draftInfo ? 'השאר כטיוטה וסגור' : 'ביטול'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Invoice Receipt Modal ── */}
      {irModal && (
        <div className="receipts-modal-overlay" onClick={e => { if (e.target === e.currentTarget) { setIrModal(null); setCustSuggestions([]) } }}>
          <div className="receipts-modal" dir="rtl" style={{ maxWidth: 600, maxHeight: '90vh', overflowY: 'auto' }}>
            <h3 style={{ color: '#7c3aed' }}>חשבונית מס קבלה</h3>

            <table className="receipts-modal-info">
              <tbody>
                <tr><th>תאריך:</th><td>{fmt(irModal.CURDATE)}</td></tr>
                <tr><th>בנק:</th><td>{irModal.bank_desc || irModal.CASHNAME}</td></tr>
                <tr><th>סניף:</th><td>{irModal.BRANCHNAME}</td></tr>
                <tr><th>סכום:</th><td><strong style={{ color: '#16a34a' }}>{fmtAmount(irModal.SUM1)}</strong></td></tr>
              </tbody>
            </table>

            {custSearching && <p style={{ fontSize: 13, color: '#6b7280', margin: '0 0 12px' }}>מחפש לקוח...</p>}
            {custSuggestions.length > 0 && (
              <div style={{ marginBottom: 14 }}>
                <p style={{ fontSize: 12, color: '#6b7280', margin: '0 0 6px' }}>התאמות שנמצאו — לחץ לבחירה:</p>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  {custSuggestions.map(c => (
                    <button key={c.accname} onClick={async () => {
                      setIrAccname(c.accname)
                      setIrAccdes(c.accdes || '')
                      setCustSuggestions([])
                      await loadLastEinvoice(c.accname, irModal.BRANCHNAME || '', irModal?.SUM1)
                    }} style={{
                      textAlign: 'right', padding: '6px 10px', borderRadius: 6,
                      border: '1px solid #ddd6fe', background: '#f5f3ff',
                      cursor: 'pointer', fontSize: 13,
                    }}>
                      <span style={{ fontFamily: 'monospace', fontWeight: 700, color: '#7c3aed' }}>{c.accname}</span>
                      {' — '}{c.accdes}
                      {c.branchname && <span style={{ color: '#9ca3af', fontSize: 11, marginRight: 6 }}>סניף {c.branchname}</span>}
                    </button>
                  ))}
                </div>
              </div>
            )}

            <div className="receipts-modal-field">
              <label>קוד לקוח (CUSTNAME) *</label>
              <input
                type="text"
                placeholder={allCustomers.length > 0 ? 'חפש לפי קוד או שם לקוח...' : 'לדוגמה: 50440 או שם לקוח'}
                value={irAccname}
                onFocus={() => setIrAccFocused(true)}
                onChange={e => {
                  setIrAccname(e.target.value)
                  setIrAccdes('')
                }}
                onBlur={async e => {
                  const v = e.target.value.trim()
                  setTimeout(() => setIrAccFocused(false), 150)
                  if (v.length >= 2) await loadLastEinvoice(v, irModal?.BRANCHNAME || '', irModal?.SUM1)
                }}
                autoFocus={custSuggestions.length === 0}
              />
              {irAccFocused && allCustomers.length > 0 && (() => {
                const q = irAccname.trim().toLowerCase()
                const branch = irModal?.BRANCHNAME
                const filtered = allCustomers
                  .filter(a => q.length === 0 || a.accname.toLowerCase().includes(q) || a.accdes.toLowerCase().includes(q))
                  .sort((a, b) => (a.branchname === branch ? 0 : 1) - (b.branchname === branch ? 0 : 1))
                  .slice(0, 60)
                if (filtered.length === 0) return null
                const pick = async (a) => {
                  setIrAccname(a.accname)
                  setIrAccdes(a.accdes || '')
                  setIrAccFocused(false)
                  await loadLastEinvoice(a.accname, irModal?.BRANCHNAME || '', irModal?.SUM1)
                }
                return (
                  <div style={{ border: '1px solid #e5e7eb', borderRadius: 6, marginTop: 2, background: '#fff', maxHeight: 180, overflowY: 'auto', zIndex: 10, position: 'relative' }}>
                    {filtered.map(a => (
                      <button
                        key={a.accname}
                        onMouseDown={() => pick(a)}
                        style={{ display: 'block', width: '100%', textAlign: 'right', padding: '6px 10px',
                          border: 'none', background: 'none', cursor: 'pointer', fontSize: 13,
                          borderBottom: '1px solid #f3f4f6' }}
                      >
                        <span style={{ fontFamily: 'monospace', fontWeight: 700, color: '#7c3aed' }}>{a.accname}</span>
                        {a.accdes && <span style={{ color: '#374151', marginRight: 8 }}>{a.accdes}</span>}
                      </button>
                    ))}
                  </div>
                )
              })()}
              {irAccdes && <div style={{ marginTop: 4, fontSize: 13, color: '#7c3aed', fontWeight: 600 }}>{irAccdes}</div>}
            </div>

            <div className="receipts-modal-field">
              <label>פרטים</label>
              <input type="text" value={irDetails} onChange={e => setIrDetails(e.target.value)} placeholder="פרטי החשבונית" />
              {irPrevNote && (
                <div style={{ fontSize: 11, marginTop: 3, color: irPrevNote.startsWith('שגיאה') || irPrevNote.startsWith('לא נמצא') ? '#b45309' : '#6b7280' }}>
                  {irPrevNote}
                </div>
              )}
            </div>

            {irLoading && <p style={{ fontSize: 13, color: '#6b7280', margin: '4px 0' }}>טוען פרטים מחשבונית קודמת...</p>}
            {!irLoading && (
              <div style={{ marginBottom: 12 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                  <label style={{ fontSize: 13, fontWeight: 600, color: '#374151' }}>פריטים (EINVOICEITEMS)</label>
                  <button
                    type="button"
                    onClick={() => setIrItems(prev => [...prev, { PARTNAME: '000', PDES: '', TQUANT: 1, PRICE: 0 }])}
                    style={{ fontSize: 12, padding: '2px 8px', borderRadius: 4, border: '1px solid #7c3aed', color: '#7c3aed', background: '#f5f3ff', cursor: 'pointer' }}
                  >+ הוסף שורה</button>
                </div>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                  <thead>
                    <tr style={{ color: '#6b7280', borderBottom: '1px solid #e5e7eb' }}>
                      <th style={{ textAlign: 'right', padding: '3px 4px', width: 60 }}>מקט</th>
                      <th style={{ textAlign: 'right', padding: '3px 4px' }}>פרטים</th>
                      <th style={{ textAlign: 'center', padding: '3px 4px', width: 60 }}>כמות</th>
                      <th style={{ textAlign: 'center', padding: '3px 4px', width: 80 }}>מחיר כולל מע"מ</th>
                      <th style={{ width: 24 }}></th>
                    </tr>
                  </thead>
                  <tbody>
                    {irItems.map((item, idx) => (
                      <tr key={idx}>
                        <td style={{ padding: '3px 4px' }}>
                          <input type="text" value={item.PARTNAME}
                            onChange={e => setIrItems(prev => prev.map((it, i) => i === idx ? { ...it, PARTNAME: e.target.value } : it))}
                            style={{ width: '100%', fontSize: 12, padding: '2px 4px', border: '1px solid #d1d5db', borderRadius: 3 }} />
                        </td>
                        <td style={{ padding: '3px 4px' }}>
                          <input type="text" value={item.PDES}
                            onChange={e => setIrItems(prev => prev.map((it, i) => i === idx ? { ...it, PDES: e.target.value } : it))}
                            style={{ width: '100%', fontSize: 12, padding: '2px 4px', border: '1px solid #d1d5db', borderRadius: 3 }} />
                        </td>
                        <td style={{ padding: '3px 4px' }}>
                          <input type="number" value={item.TQUANT}
                            onChange={e => setIrItems(prev => prev.map((it, i) => i === idx ? { ...it, TQUANT: e.target.value } : it))}
                            style={{ width: '100%', fontSize: 12, padding: '2px 4px', border: '1px solid #d1d5db', borderRadius: 3, textAlign: 'center' }} />
                        </td>
                        <td style={{ padding: '3px 4px' }}>
                          <input type="number" value={item.PRICE}
                            onChange={e => setIrItems(prev => prev.map((it, i) => i === idx ? { ...it, PRICE: e.target.value } : it))}
                            style={{ width: '100%', fontSize: 12, padding: '2px 4px', border: '1px solid #d1d5db', borderRadius: 3, textAlign: 'center' }} />
                        </td>
                        <td style={{ padding: '3px 4px', textAlign: 'center' }}>
                          {irItems.length > 1 && (
                            <button type="button" onClick={() => setIrItems(prev => prev.filter((_, i) => i !== idx))}
                              style={{ background: 'none', border: 'none', color: '#ef4444', cursor: 'pointer', fontSize: 16, padding: 0, lineHeight: 1 }}>×</button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {irItems.length > 0 && (() => {
                  const totalWithVat = irItems.reduce((s, it) => s + (Number(it.PRICE) * Number(it.TQUANT) || 0), 0)
                  const totalPreVat  = Math.round(totalWithVat / 1.18 * 100) / 100
                  const bankAmt      = irModal?.SUM1 || 0
                  const diff         = Math.round((bankAmt - totalWithVat) * 100) / 100
                  const exact        = Math.abs(diff) < 0.005
                  return (
                    <div style={{ marginTop: 6, fontSize: 12, color: '#374151', textAlign: 'left', direction: 'ltr' }}>
                      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 16 }}>
                        <span>סה"כ ללא מע"מ: <strong>{totalPreVat.toFixed(2)}</strong></span>
                        <span style={{ color: exact ? '#16a34a' : '#b45309', fontWeight: 600 }}>
                          סה"כ כולל מע"מ (18%): {totalWithVat.toFixed(2)}
                        </span>
                        <span style={{ color: '#1d4ed8', fontWeight: 700 }}>
                          סכום בנק: {bankAmt.toFixed(2)}
                        </span>
                      </div>
                      {!exact && (
                        <div style={{ textAlign: 'right', marginTop: 3, color: '#b45309', fontSize: 11 }}>
                          הפרש: <strong>{diff > 0 ? '+' : ''}{diff.toFixed(2)} ₪</strong>
                          {' — '}שורת הפרש תתווסף אוטומטית לחשבונית
                        </div>
                      )}
                    </div>
                  )
                })()}
              </div>
            )}

            {irDraftInfo && (
              <div style={{
                margin: '8px 0', padding: '10px 14px', borderRadius: 8,
                background: '#eff6ff', border: '1px solid #93c5fd',
                color: '#1d4ed8', fontSize: 13, fontWeight: 600,
              }}>
                טיוטה נוצרה בפריוריטי:&nbsp;
                <span style={{ fontFamily: 'monospace', fontSize: 14 }}>{irDraftInfo.ivnum}</span>
                <div style={{ fontWeight: 400, marginTop: 4, color: '#374151' }}>
                  יש לבדוק את הפרטים ולאשר סופית כדי לסגור את המסמך ולבצע התאמת בנק.
                </div>
              </div>
            )}

            {irError && <p className="receipts-error" style={{ margin: '8px 0' }}>{irError}</p>}

            <div className="receipts-modal-actions">
              {!irDraftInfo ? (
                <button className="receipts-btn receipts-btn-approve" onClick={submitInvoiceReceipt} disabled={irSending}>
                  {irSending ? 'שולח לפריוריטי...' : 'הפק חשבונית מס קבלה'}
                </button>
              ) : (
                <button className="receipts-btn receipts-btn-approve" onClick={finalizeInvoiceReceipt} disabled={irFinalizing}>
                  {irFinalizing ? 'מאשר סופית...' : 'אשר סופי'}
                </button>
              )}
              <button
                className="receipts-btn receipts-btn-cancel"
                onClick={() => { setIrModal(null); setCustSuggestions([]); setIrDraftInfo(null) }}
                disabled={irSending || irFinalizing}
              >
                {irDraftInfo ? 'השאר כטיוטה וסגור' : 'ביטול'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Journal Entry Modal ── */}
      {journalModal && (
        <div className="receipts-modal-overlay" onClick={e => { if (e.target === e.currentTarget) setJournalModal(null) }}>
          <div className="receipts-modal" dir="rtl">
            <h3>רישום פקודת יומן</h3>

            <table className="receipts-modal-info">
              <tbody>
                <tr><th>תאריך:</th><td>{fmt(journalModal.CURDATE)}</td></tr>
                <tr><th>בנק:</th><td>{journalModal.bank_desc || journalModal.CASHNAME}</td></tr>
                <tr><th>סניף:</th><td>{journalModal.BRANCHNAME}</td></tr>
                <tr>
                  <th>סכום:</th>
                  <td><AmountCell sum1={journalModal.SUM1} direction={journalModal.direction} /></td>
                </tr>
              </tbody>
            </table>

            <div style={{ margin: '12px 0', padding: '10px 14px', borderRadius: 8,
              background: '#f8fafc', border: '1px solid #e2e8f0', fontSize: 13 }}>
              <div style={{ fontWeight: 700, marginBottom: 6, color: '#374151' }}>תצוגה מקדימה של הפקודה:</div>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                <thead>
                  <tr style={{ color: '#6b7280' }}>
                    <th style={{ textAlign: 'right', paddingLeft: 8, fontWeight: 600 }}>חשבון</th>
                    <th style={{ textAlign: 'center', fontWeight: 600 }}>חובה</th>
                    <th style={{ textAlign: 'center', fontWeight: 600 }}>זכות</th>
                  </tr>
                </thead>
                <tbody>
                  {(() => {
                    const bankCell = (
                      <td style={{ paddingLeft: 8, color: '#1d4ed8', fontFamily: 'monospace' }}>
                        {journalBankGlResolved
                          ? <><strong>{journalBankGlResolved}</strong>{journalBankGlDesc && <span style={{ color: '#6b7280', fontFamily: 'sans-serif', marginRight: 6, fontWeight: 400 }}>{journalBankGlDesc}</span>}</>
                          : <span style={{ color: '#ef4444' }}>לא מוגדר</span>
                        }
                      </td>
                    )
                    const cpAcc = journalCounterpart
                      ? `${journalCounterpart}${journalModal.BRANCHNAME && !journalCounterpart.endsWith(`-${journalModal.BRANCHNAME}`) ? `-${journalModal.BRANCHNAME}` : ''}`
                      : '???'
                    const cpCell = (
                      <td style={{ paddingLeft: 8, color: '#b45309', fontFamily: 'monospace' }}>
                        {cpAcc}
                        {journalCounterDesc && <span style={{ color: '#6b7280', fontFamily: 'sans-serif', marginRight: 6, fontWeight: 400 }}>{journalCounterDesc}</span>}
                      </td>
                    )
                    return journalModal.direction === '+' ? (
                      <>
                        <tr>{bankCell}<td style={{ textAlign: 'center', color: '#15803d', fontWeight: 700 }}>{fmtAmount(journalModal.SUM1)}</td><td style={{ textAlign: 'center', color: '#9ca3af' }}>—</td></tr>
                        <tr>{cpCell}<td style={{ textAlign: 'center', color: '#9ca3af' }}>—</td><td style={{ textAlign: 'center', color: '#dc2626', fontWeight: 700 }}>{fmtAmount(journalModal.SUM1)}</td></tr>
                      </>
                    ) : (
                      <>
                        <tr>{cpCell}<td style={{ textAlign: 'center', color: '#15803d', fontWeight: 700 }}>{fmtAmount(journalModal.SUM1)}</td><td style={{ textAlign: 'center', color: '#9ca3af' }}>—</td></tr>
                        <tr>{bankCell}<td style={{ textAlign: 'center', color: '#9ca3af' }}>—</td><td style={{ textAlign: 'center', color: '#dc2626', fontWeight: 700 }}>{fmtAmount(journalModal.SUM1)}</td></tr>
                      </>
                    )
                  })()}
                </tbody>
              </table>
            </div>

            {!journalBankGlResolved && (
              <div style={{ background: '#fef9c3', border: '1px solid #f59e0b', borderRadius: 8,
                padding: '10px 14px', marginBottom: 12, fontSize: 13, color: '#92400e' }}>
                ⚠️ חשבון GL לבנק <strong>{journalModal?.CASHNAME}</strong> לא מוגדר.
                <button
                  onClick={() => { setJournalModal(null); setShowBankGlSettings(true) }}
                  style={{ background: 'none', border: 'none', color: '#1d4ed8', cursor: 'pointer',
                    textDecoration: 'underline', fontWeight: 700, fontSize: 13, marginRight: 8 }}
                >
                  עבור להגדרות בנק
                </button>
              </div>
            )}

            <div className="receipts-modal-field">
              <label>חשבון נגדי (ACCNAME) *</label>
              <input
                type="text"
                placeholder={`לדוגמה: 6200 (יושלם עם סיומת -${journalModal.BRANCHNAME})`}
                value={journalCounterpart}
                autoFocus
                onChange={e => {
                  setJournalCounterpart(e.target.value)
                  setJournalCounterDesc('')
                  searchJournalAccounts(e.target.value, journalModal?.BRANCHNAME)
                }}
                onBlur={async () => {
                  if (!journalCounterpart.trim() || journalCounterDesc) return
                  try {
                    const res = await fetch(`${API}/api/receipts/search-all-accounts?q=${encodeURIComponent(journalCounterpart.trim())}&branchname=${encodeURIComponent(journalModal?.BRANCHNAME || '')}`).then(r => r.json())
                    const accs = res.accounts || []
                    const exact = accs.find(a =>
                      a.accname === journalCounterpart.trim() ||
                      a.accname === `${journalCounterpart.trim()}-${journalModal.BRANCHNAME}`
                    ) || accs[0]
                    if (exact) setJournalCounterDesc(exact.accdes)
                  } catch { /* silent */ }
                }}
              />
              {journalCounterDesc && (
                <div style={{ fontSize: 12, color: '#374151', marginTop: 3, paddingRight: 2 }}>
                  <span style={{ color: '#6b7280' }}>שם חשבון: </span>
                  <strong>{journalCounterDesc}</strong>
                </div>
              )}
              {journalAccSearching && (
                <p style={{ fontSize: 12, color: '#6b7280', margin: '2px 0 0' }}>מחפש חשבונות...</p>
              )}
              {journalAccSuggestions.length > 0 && (
                <div style={{ border: '1px solid #e5e7eb', borderRadius: 6, marginTop: 2, background: '#fff', maxHeight: 160, overflowY: 'auto' }}>
                  {journalAccSuggestions.map(a => (
                    <button
                      key={a.accname}
                      onClick={() => {
                        setJournalCounterpart(a.accname)
                        setJournalCounterDesc(a.accdes)
                        setJournalAccSuggestions([])
                      }}
                      style={{ display: 'block', width: '100%', textAlign: 'right', padding: '6px 10px',
                        border: 'none', background: 'none', cursor: 'pointer', fontSize: 13,
                        borderBottom: '1px solid #f3f4f6' }}
                    >
                      <span style={{ fontFamily: 'monospace', fontWeight: 700, color: '#1d4ed8' }}>{a.accname}</span>
                      {' — '}{a.accdes}
                      {a.kind && a.kind !== 'gl' && (
                        <span style={{ marginRight: 6, fontSize: 10, color: '#6b7280', background: '#f3f4f6', borderRadius: 4, padding: '1px 5px' }}>
                          {a.kind === 'customer' ? 'לקוח' : a.kind === 'supplier' ? 'ספק' : a.kind}
                        </span>
                      )}
                    </button>
                  ))}
                </div>
              )}
            </div>

            <div className="receipts-modal-field">
              <label>פרטים</label>
              <input
                type="text"
                value={journalDetails}
                onChange={e => setJournalDetails(e.target.value)}
              />
            </div>

            {journalError   && <p className="receipts-error"  style={{ margin: '8px 0' }}>{journalError}</p>}
            {journalSuccess && <p style={{ margin: '8px 0', color: '#15803d', fontWeight: 600 }}>{journalSuccess}</p>}

            <div className="receipts-modal-actions">
              <button
                className="receipts-btn receipts-btn-approve"
                onClick={submitJournal}
                disabled={journalSending}
              >
                {journalSending ? 'שולח לפריוריטי...' : 'צור פקודת יומן'}
              </button>
              <button
                className="receipts-btn receipts-btn-cancel"
                onClick={() => setJournalModal(null)}
                disabled={journalSending}
              >
                ביטול
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Transfer Modal ── */}
      {transferModal && (
        <div className="receipts-modal-overlay" onClick={e => { if (e.target === e.currentTarget) setTransferModal(null) }}>
          <div className="receipts-modal" dir="rtl">
            <h3>הפקת העברה בנקאית</h3>

            <table className="receipts-modal-info">
              <tbody>
                <tr><th>תאריך:</th><td>{fmt(transferModal.CURDATE)}</td></tr>
                <tr><th>בנק:</th><td>{transferModal.bank_desc || transferModal.CASHNAME}</td></tr>
                <tr><th>סניף:</th><td>{transferModal.BRANCHNAME}</td></tr>
                <tr>
                  <th>סכום:</th>
                  <td><AmountCell sum1={transferModal.SUM1} direction={transferModal.direction} /></td>
                </tr>
              </tbody>
            </table>

            <div className="receipts-modal-field" style={{ position: 'relative' }}>
              <label>חשבון ספק *</label>
              <input
                type="text"
                placeholder={allSuppliers.length > 0 ? 'חפש לפי קוד או שם ספק...' : `לדוגמה: 60367-${transferModal?.BRANCHNAME || '025'}`}
                value={transferAccname}
                autoFocus
                onFocus={() => { setTransferAccFocused(true); setTransferDropdownOpen(true) }}
                onBlur={() => setTimeout(() => { setTransferAccFocused(false); setTransferDropdownOpen(false) }, 150)}
                onChange={e => {
                  setTransferAccname(e.target.value)
                  setTransferAccdes('')
                  setTransferAccFromSugg(false)
                  setTransferDropdownOpen(true)
                }}
              />
              {transferAccdes && (
                <div style={{ fontSize: 12, color: '#374151', marginTop: 3, paddingRight: 2 }}>
                  <span style={{ color: '#6b7280' }}>שם חשבון: </span>
                  <strong>{transferAccdes}</strong>
                  {transferAccFromSugg && (
                    <span style={{ marginRight: 8, fontSize: 11, color: '#7c3aed', background: '#f5f3ff', border: '1px solid #c4b5fd', borderRadius: 4, padding: '1px 6px' }}>
                      מהמלצות
                    </span>
                  )}
                </div>
              )}
              {transferDropdownOpen && allSuppliers.length > 0 && (() => {
                const q = transferAccname.trim().toLowerCase()
                const filtered = allSuppliers
                  .filter(a => q.length === 0 || a.accname.toLowerCase().includes(q) || a.accdes.toLowerCase().includes(q))
                  .slice(0, 60)
                if (filtered.length === 0) return null
                const pick = (a) => { setTransferAccname(a.accname); setTransferAccdes(a.accdes); setTransferDropdownOpen(false); setTransferAccFromSugg(false) }
                return (
                  <div style={{ border: '1px solid #e5e7eb', borderRadius: 6, marginTop: 2, background: '#fff', maxHeight: 240, overflowY: 'auto', position: 'absolute', width: '100%', zIndex: 20, boxShadow: '0 4px 12px rgba(0,0,0,0.12)' }}>
                    {filtered.map(a => (
                      <button
                        key={a.accname}
                        onMouseDown={() => pick(a)}
                        style={{ display: 'block', width: '100%', textAlign: 'right', padding: '6px 10px',
                          border: 'none', background: 'none', cursor: 'pointer', fontSize: 13,
                          borderBottom: '1px solid #f3f4f6' }}
                      >
                        <span style={{ fontFamily: 'monospace', fontWeight: 700, color: '#1d4ed8' }}>{a.accname}</span>
                        {a.accdes && <span style={{ color: '#374151', marginRight: 6 }}>{a.accdes}</span>}
                      </button>
                    ))}
                  </div>
                )
              })()}
              {allSuppliers.length === 0 && (
                <p style={{ fontSize: 12, color: '#9ca3af', margin: '4px 0 0' }}>טוען רשימת ספקים...</p>
              )}
            </div>

            <div className="receipts-modal-field">
              <label>פרטים</label>
              <input
                type="text"
                value={transferDetails}
                onChange={e => setTransferDetails(e.target.value)}
              />
            </div>

            {transferError   && <p className="receipts-error"  style={{ margin: '8px 0' }}>{transferError}</p>}
            {transferSuccess && <p style={{ margin: '8px 0', color: '#15803d', fontWeight: 600 }}>{transferSuccess}</p>}

            <div className="receipts-modal-actions">
              <button
                className="receipts-btn receipts-btn-approve"
                onClick={submitTransfer}
                disabled={transferSending}
              >
                {transferSending ? 'שולח לפריוריטי...' : 'צור העברה בנקאית'}
              </button>
              <button
                className="receipts-btn receipts-btn-cancel"
                onClick={() => setTransferModal(null)}
                disabled={transferSending}
              >
                ביטול
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Finalize Journal Modal ── */}
      {finalizeModal && (
        <div className="receipts-modal-overlay" onClick={e => { if (e.target === e.currentTarget) { setFinalizeModal(null); setFinalizeInputNum('') } }}>
          <div className="receipts-modal" dir="rtl" style={{ maxWidth: 420 }}>
            <h3>רישום תנועת יומן</h3>
            {finalizeModal.error && (
              <p style={{ fontSize: 12, color: '#dc2626', background: '#fef2f2', border: '1px solid #fca5a5',
                           borderRadius: 6, padding: '6px 10px', marginBottom: 10, direction: 'rtl' }}>
                {finalizeModal.error}
              </p>
            )}
            <p style={{ fontSize: 13, color: '#374151', lineHeight: 1.6 }}>
              יש לבצע את הפעולה ידנית בפריוריטי:
            </p>
            <ol style={{ fontSize: 13, color: '#374151', lineHeight: 2, paddingRight: 20, marginBottom: 16 }}>
              <li>פתח פריוריטי ← תנועות יומן</li>
              <li>חפש מספר <strong>{finalizeModal.priorityFncnum}</strong></li>
              <li>לחץ <strong>"רישום תנועת יומן"</strong></li>
            </ol>
            <label style={{ fontSize: 13, fontWeight: 600, display: 'block', marginBottom: 4 }}>
              מספר תנועה סופי (אחרי הרישום בפריוריטי):
            </label>
            <input
              type="text"
              value={finalizeInputNum}
              onChange={e => setFinalizeInputNum(e.target.value)}
              placeholder={`${finalizeModal.priorityFncnum} (השאר ריק אם לא השתנה)`}
              style={{ width: '100%', padding: '6px 10px', fontSize: 13, borderRadius: 6,
                       border: '1px solid #d1d5db', marginBottom: 16, boxSizing: 'border-box' }}
              dir="ltr"
            />
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button
                className="receipts-btn receipts-btn-cancel"
                onClick={() => { setFinalizeModal(null); setFinalizeInputNum('') }}
                disabled={finalizeSaving}
              >ביטול</button>
              <button
                className="receipts-btn receipts-btn-primary"
                onClick={confirmFinalizeJournal}
                disabled={finalizeSaving}
              >{finalizeSaving ? '...' : 'סמן כנרשם'}</button>
            </div>
          </div>
        </div>
      )}

      {/* ── Finalize Transfer Modal ── */}
      {finalizeTransferModal && (
        <div className="receipts-modal-overlay" onClick={e => { if (e.target === e.currentTarget) { setFinalizeTransferModal(null); setFinalizeTransferInput('') } }}>
          <div className="receipts-modal" dir="rtl" style={{ maxWidth: 420 }}>
            <h3>אישור העברה בנקאית</h3>
            {finalizeTransferModal.error && (
              <p style={{ fontSize: 12, color: '#dc2626', background: '#fef2f2', border: '1px solid #fca5a5',
                           borderRadius: 6, padding: '6px 10px', marginBottom: 10, direction: 'rtl' }}>
                {finalizeTransferModal.error}
              </p>
            )}
            <p style={{ fontSize: 13, color: '#374151', lineHeight: 1.6 }}>
              יש לבצע את הפעולה ידנית בפריוריטי:
            </p>
            <ol style={{ fontSize: 13, color: '#374151', lineHeight: 2, paddingRight: 20, marginBottom: 16 }}>
              <li>פתח פריוריטי ← העברות בנקאיות/כרטיסי אשראי</li>
              <li>חפש מספר <strong>{finalizeTransferModal.ivnum}</strong></li>
              <li>לחץ <strong>"אישור העברה בנקאית"</strong></li>
            </ol>
            <label style={{ fontSize: 13, fontWeight: 600, display: 'block', marginBottom: 4 }}>
              מספר פקודת יומן (אחרי האישור בפריוריטי):
            </label>
            <input
              type="text"
              value={finalizeTransferInput}
              onChange={e => setFinalizeTransferInput(e.target.value)}
              placeholder={`${finalizeTransferModal.ivnum} (השאר ריק אם לא השתנה)`}
              style={{ width: '100%', padding: '6px 10px', fontSize: 13, borderRadius: 6,
                       border: '1px solid #d1d5db', marginBottom: 16, boxSizing: 'border-box' }}
              dir="ltr"
            />
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button
                className="receipts-btn receipts-btn-cancel"
                onClick={() => { setFinalizeTransferModal(null); setFinalizeTransferInput('') }}
                disabled={finalizeTransferSaving}
              >ביטול</button>
              <button
                className="receipts-btn receipts-btn-primary"
                onClick={confirmFinalizeTransfer}
                disabled={finalizeTransferSaving}
              >{finalizeTransferSaving ? '...' : 'סמן כמאושר'}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
