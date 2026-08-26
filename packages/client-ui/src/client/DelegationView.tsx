import { useEffect, useMemo, useState } from 'react'
import type { TranslateNS } from '@monotykamary/dsh-client-ui-slots'
import type { FabricDelegationRecord, FabricDelegationWorkerRecord } from 'dsh-fabric-protocol'
import { formatDuration, statusLabel } from './labels.ts'
import type { FabricControls } from './types.ts'
import css from './fabric.module.css'

interface DelegationViewProps extends Pick<FabricControls, 'openNode' | 'cancelWorker' | 'messageWorker'> {
  delegations: readonly FabricDelegationRecord[]
  t: TranslateNS<'fabric'>
}

function workerRoute(worker: FabricDelegationWorkerRecord, t: TranslateNS<'fabric'>): { label: string; title: string } {
  const provider = worker.actualProvider ?? worker.requestedProvider
  const model = worker.actualModel ?? worker.requestedModel
  if (model !== undefined) {
    const label = provider === undefined ? model : provider + ' / ' + model
    return { label, title: worker.actualModel === undefined ? t('delegation.requestedRoute') : t('delegation.observedRoute') }
  }
  const pending = worker.status === 'pending' || worker.status === 'running'
  return { label: pending ? t('delegation.modelResolving') : t('delegation.modelUnavailable'), title: pending ? t('delegation.modelResolving') : t('delegation.modelUnavailable') }
}

function workerOrder(worker: FabricDelegationWorkerRecord): number {
  if (worker.status === 'running') return 0
  if (worker.status === 'pending') return 1
  if (worker.status === 'failed' || worker.status === 'blocked') return 2
  return 3
}

/** Render replay-derived delegation groups, workers, and worker inspection. */
export function DelegationView({ delegations, openNode, cancelWorker, messageWorker, t }: DelegationViewProps) {
  const [selectedGroupId, setSelectedGroupId] = useState<string>()
  const [selectedWorkerId, setSelectedWorkerId] = useState<string>()
  const [messageOpen, setMessageOpen] = useState(false)
  const [message, setMessage] = useState('')
  const [messageMode, setMessageMode] = useState<'queue' | 'steer'>('queue')
  const [controlStatus, setControlStatus] = useState<'idle' | 'working' | 'sent' | 'failed'>('idle')
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    if (!delegations.some(group => group.status === 'running')) return
    const timer = window.setInterval(() => { setNow(Date.now()) }, 1_000)
    return () => { window.clearInterval(timer) }
  }, [delegations])
  const group = delegations.find(candidate => candidate.id === selectedGroupId) ?? delegations[0]
  const workers = useMemo(() => [...(group?.workers ?? [])].toSorted((left, right) => workerOrder(left) - workerOrder(right) || left.index - right.index), [group])
  const worker = workers.find(candidate => candidate.id === selectedWorkerId) ?? workers[0]
  useEffect(() => {
    setMessageOpen(false)
    setMessage('')
    setControlStatus('idle')
  }, [worker?.id])
  const childSessionId = worker?.childSessionId
  const sendMessage = async (): Promise<void> => {
    if (childSessionId === undefined || message.trim() === '') return
    setControlStatus('working')
    const sent = await messageWorker(childSessionId, message, messageMode)
    setControlStatus(sent ? 'sent' : 'failed')
    if (sent) setMessage('')
  }
  const retryWorker = async (): Promise<void> => {
    if (childSessionId === undefined || worker === undefined) return
    setControlStatus('working')
    const sent = await messageWorker(childSessionId, t('delegation.retryPrompt', { task: worker.task }), 'queue')
    setControlStatus(sent ? 'sent' : 'failed')
  }

  if (delegations.length === 0) return <div className={css.delegationEmpty}>{t('delegation.empty')}</div>
  return (
    <div className={css.missionControlFrame}>
      <div className={css.missionControl}>
      <nav className={css.delegationGroups} aria-label={t('delegation.groups')}>
        <header><strong>{t('delegation.groups')}</strong><span>{delegations.length}</span></header>
        {delegations.map((candidate) => {
          const active = candidate.workers.filter(item => item.status === 'running' || item.status === 'pending').length
          return <button key={candidate.id} type="button" aria-current={candidate.id === group?.id} data-status={candidate.status} onClick={() => { setSelectedGroupId(candidate.id); setSelectedWorkerId(undefined) }}>
            <span className={css.statusDot} data-status={candidate.status} />
            <span><strong>{candidate.label}</strong><small>{candidate.workers.length} {t('delegation.workers').toLowerCase()} · {candidate.parallel ? t('delegation.parallel') : t('delegation.sequential')}</small></span>
            {active === 0 ? null : <em>{active}</em>}
          </button>
        })}
      </nav>
      <section className={css.workerPane} aria-label={t('delegation.workers')}>
        <header>
          <span><strong>{group?.label}</strong><small>{group === undefined ? '' : statusLabel(group.status, t)}</small></span>
          {group?.totalTokens === undefined ? null : <span className={css.metric}>{group.totalTokens.toLocaleString()} {t('delegation.tokens')}</span>}
        </header>
        <div className={css.workerRows} role="list">
          {workers.map((candidate) => {
            const duration = candidate.durationMs ?? ((candidate.status === 'running' || candidate.status === 'pending') ? now - (group?.createdAt ?? now) : 0)
            const route = workerRoute(candidate, t)
            return <button key={candidate.id} type="button" role="listitem" aria-current={candidate.id === worker?.id} data-status={candidate.status} onClick={() => { setSelectedWorkerId(candidate.id) }}>
              <span className={css.statusDot} data-status={candidate.status} />
              <span className={css.workerIdentity}><strong>{candidate.label}</strong><small>{candidate.task}</small></span>
              <span className={css.workerRoute}><span>{candidate.tier}</span><small title={route.title}>{route.label}</small></span>
              <span className={css.workerMetrics}><small>{formatDuration(duration, t)}</small>{candidate.tokens === undefined ? null : <small>{candidate.tokens.toLocaleString()} tok</small>}</span>
            </button>
          })}
        </div>
      </section>
      <aside className={css.workerInspector} aria-label={t('delegation.inspector')}>
        {worker === undefined ? <p>{t('delegation.noSelection')}</p> : <>
          <header><span className={css.statusDot} data-status={worker.status} /><span><strong>{worker.label}</strong><small>{statusLabel(worker.status, t)}</small></span></header>
          <dl>
            <div><dt>{t('delegation.tier')}</dt><dd>{worker.tier}</dd></div>
            <div><dt>{t('delegation.model')}</dt><dd title={workerRoute(worker, t).title}>{workerRoute(worker, t).label}</dd></div>
            <div><dt>{t('delegation.tokens')}</dt><dd>{worker.tokens?.toLocaleString() ?? '—'}</dd></div>
            <div><dt>{t('details.duration')}</dt><dd>{worker.durationMs === undefined ? '—' : formatDuration(worker.durationMs, t)}</dd></div>
            <div><dt>{t('delegation.relationship')}</dt><dd>{worker.parentSessionId === undefined || worker.childSessionId === undefined ? '—' : worker.parentSessionId.slice(0, 8) + ' → ' + worker.childSessionId.slice(0, 8)}</dd></div>
          </dl>
          {worker.currentActivity === undefined ? null : <section><h3>{t('delegation.activity')}</h3><p>{worker.currentActivity}</p></section>}
          {worker.routingVerified === false ? <p className={css.routingWarning}>{t('delegation.routingMismatch')}</p> : null}
          <section><h3>{t('delegation.task')}</h3><p>{worker.task}</p></section>
          {worker.error === undefined ? null : <section className={css.workerError}><h3>{t('delegation.error')}</h3><pre>{worker.error}</pre></section>}
          {worker.output === undefined ? null : <section><h3>{t('delegation.output')}</h3><pre>{worker.output}</pre></section>}
          {group?.validation === undefined ? null : <section><h3>{t('delegation.validation')}</h3><pre>{group.validation}</pre></section>}
          {worker.childSessionId === undefined ? null : <div className={css.workerControls}>
            <button type="button" onClick={() => { void openNode(worker.childSessionId!) }}>{t('delegation.open')}</button>
            {(worker.status === 'running' || worker.status === 'pending') ? <button type="button" className={css.dangerControl} disabled={controlStatus === 'working'} onClick={() => {
              setControlStatus('working')
              void cancelWorker(worker.childSessionId!).then(cancelled => { setControlStatus(cancelled ? 'sent' : 'failed') })
            }}>{t('delegation.cancel')}</button> : null}
            {worker.status === 'failed' || worker.status === 'stopped' ? <button type="button" disabled={controlStatus === 'working'} onClick={() => { void retryWorker() }}>{t('delegation.retry')}</button> : null}
            <button type="button" aria-expanded={messageOpen} onClick={() => { setMessageOpen(value => !value); setControlStatus('idle') }}>{t('delegation.message')}</button>
            {messageOpen ? <form onSubmit={(event) => { event.preventDefault(); void sendMessage() }}>
              <textarea value={message} aria-label={t('delegation.message')} placeholder={t('delegation.messagePlaceholder')} onChange={event => { setMessage(event.currentTarget.value); setControlStatus('idle') }} />
              <label><span>{t('delegation.delivery')}</span><select value={messageMode} onChange={event => { setMessageMode(event.currentTarget.value as 'queue' | 'steer') }}>
                <option value="queue">{t('delegation.queue')}</option><option value="steer">{t('delegation.steer')}</option>
              </select></label>
              <button type="submit" disabled={controlStatus === 'working' || message.trim() === ''}>{controlStatus === 'working' ? t('delegation.sending') : t('delegation.send')}</button>
            </form> : null}
            {controlStatus === 'sent' ? <small role="status">{t('delegation.controlSent')}</small> : null}
            {controlStatus === 'failed' ? <small role="alert" className={css.controlError}>{t('delegation.controlFailed')}</small> : null}
          </div>}
        </>}
      </aside>
      </div>
    </div>
  )
}
