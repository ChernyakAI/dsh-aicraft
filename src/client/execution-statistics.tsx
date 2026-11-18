/**
 * FILE: plugin/src/client/execution-statistics.tsx
 * DESCRIPTION: Display derived execution usage and cost
 */
import { notice, noticeText, messageText, type Notice, type Translator } from './messages.ts'
import { Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import { useEffect,useState } from 'react'
import type { ExecutionStatistics as Statistics,StatisticsBucket } from '../types.ts'

export interface StatisticsProps {
  t: Translator
  workspaceId: string
  taskId: string
  sessionId: string | null
  active: boolean
  revision: string
  running?: boolean
  load(workspaceId:string,taskId:string,sessionId:string|null,signal:AbortSignal):Promise<Statistics>
  title?: string
}
const number=(n:number)=>new Intl.NumberFormat('en-US',{ notation:'compact',maximumFractionDigits:2 }).format(n)
const duration=(ms:number,t:Translator)=>{
  const seconds=Math.max(0,Math.round(ms/1000)),hours=Math.floor(seconds/3600),minutes=Math.floor(seconds%3600/60)
  return [hours ? t('hours', { value: hours }) : '', hours || minutes ? t('minutes', { value: minutes }) : '', t('seconds', { value: seconds % 60 })].filter(Boolean).join(' ')
}
const money=(n:number)=>n>0&&n<1000?'<$0.000001':new Intl.NumberFormat('en-US',{ style:'currency',currency:'USD',minimumFractionDigits:2,maximumFractionDigits:6 }).format(n/1e9)
/**
 * Metrics have their own asynchronous lifecycle; they never block project, table or chat rendering.
 */
export function ExecutionStatistics({ t,workspaceId,taskId,sessionId,active,revision,load,title,running=false }:StatisticsProps){
  const [statistics,setStatistics]=useState<Statistics|null>(null)
  const [error,setError]=useState<Notice | null>(null),[details,setDetails]=useState(false)
  useEffect(()=>{
    if(!active||running)return
    const abort=new AbortController()
    const read=async()=>{
      try{
        const next=await load(workspaceId,taskId,sessionId,abort.signal)
        if(!abort.signal.aborted){setStatistics(next);setError(null)}
      }catch(e){if(!abort.signal.aborted)setError(notice(e, { key: 'uiStatisticsTemporarilyUnavailable' }))}

    }
    void read()
    return()=>abort.abort()
  },[workspaceId,taskId,sessionId,active,revision,load,running])
  if (!statistics && running) return null
  const s=statistics
  const complete=s!==null&&s.requests>0&&!s.coverageIncomplete&&!s.unknownUsage&&!s.unknownCache&&!s.unknownPrice&&s.priced===s.requests
  const deepseek=s?.buckets.filter(bucket=>bucket.provider==='deepseek-official')??[]
  const dsPriced=deepseek.some(bucket=>bucket.totals.priced>0)
  const dsCost=deepseek.reduce((sum,{ totals })=>sum+totals.uncachedCost+totals.cacheCost+totals.outputCost,0)
  const dsMoney=dsCost>0&&dsCost<1000?'<0.000001$':`${new Intl.NumberFormat('en-US',{ minimumFractionDigits:2,maximumFractionDigits:6 }).format(dsCost/1e9)}$`
  return <section aria-label={title??t('runStatistics')} style={{ fontSize:12,lineHeight:1.7,marginTop:title?0:8,overflowWrap:'anywhere' }}>
    <div style={{ display:'flex',alignItems:'baseline',flexWrap:'wrap',gap:'0 8px',opacity:.8 }}>
      <span>{sessionId===null?t('totalTaskTime'):t('time')} {s?duration(s.elapsedMs,t):error?t('na'):t('calculating')}{sessionId===null?'.':''}</span>
      {sessionId===null&&s&&<span>{t('uiCost')} {dsMoney}</span>}
      {sessionId!==null&&complete&&<span>{t('uiTokens')} {number(s.total)}</span>}
      {sessionId!==null&&dsPriced&&<span>{t('uiCostAlt')} {dsMoney}</span>}
      <button type="button" disabled={!s} onClick={()=>setDetails(true)} style={{ border:0,padding:0,background:'none',color:'inherit',font:'inherit',textDecoration:'underline',cursor:s?'pointer':'default' }}>{sessionId===null?t('detailedUsage'):t('details')}</button>
    </div>
    {error&&<p role="alert" style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{noticeText(t,error)}</p>}
    {details&&s&&<><style>{'.aicraft-statistics-dialog { width: min(960px, 100%); max-height: 100%; }'}</style><Modal className="aicraft-statistics-dialog aicraft-text-surface" open title={title?t('taskStatistics'):t('chatStatistics')} closeLabel={t('close')} onClose={()=>setDetails(false)}>
      <StatisticsDetails t={t} statistics={s} error={error}/>
    </Modal></>}
  </section>
}

const tokens=(value:number,unknown:number,requests:number,t:Translator)=>value>0||!unknown||requests>unknown?number(value):t('na')
const priced=(s:StatisticsBucket['totals'])=>s.priced>0
const cost=(s:StatisticsBucket['totals'],t:Translator)=>priced(s)?money(s.uncachedCost+s.cacheCost+s.outputCost):s.local===s.requests&&s.requests>0&&!s.unknownPrice?t('local'):t('na')
/**
 * Render available model usage, tariff labels and incomplete-source explanations.
 */
function StatisticsDetails({ t,statistics:s,error }:{ t:Translator;statistics:Statistics;error:Notice|null }){
  const models=new Map<string,StatisticsBucket & { knownCacheInput:number;knownCacheRead:number }>()
  for(const bucket of s.buckets){
    const key=JSON.stringify([bucket.provider,bucket.model]),previous=models.get(key)
    const knownCache=!bucket.totals.unknownCache&&!bucket.totals.unknownUsage
    const knownCacheInput=knownCache?bucket.totals.input:0,knownCacheRead=knownCache?bucket.totals.cacheRead:0
    if(!previous)models.set(key,{ ...bucket,totals:{ ...bucket.totals },knownCacheInput,knownCacheRead })
    else {
      for(const k of Object.keys(bucket.totals) as Array<keyof StatisticsBucket['totals']>)previous.totals[k]+=bucket.totals[k]
      previous.knownCacheInput+=knownCacheInput;previous.knownCacheRead+=knownCacheRead
    }
  }
  const deepseek=s.buckets.filter(b=>b.provider==='deepseek-official')
  const tableStyle={ width:'100%',borderCollapse:'collapse' as const,fontSize:12,textAlign:'left' as const }
  const cellStyle={ padding:'8px',borderBottom:'1px solid var(--aicraft-border-subtle, #8090a030)',verticalAlign:'top' as const }
  return <div style={{ maxHeight:'70vh',overflow:'auto' }}>
    <p>{t('uiTime')} {duration(s.elapsedMs,t)} {t('uiLLM')} {duration(s.llmMs,t)} {t('uiTools')} {duration(s.toolMs,t)}){s.running?' · '+t('running'):''}</p>
    <h3 style={{ fontSize:14 }}>{t('uiModels')}</h3>
    <div style={{ overflowX:'auto' }}><table style={tableStyle}>
      <thead><tr>{[t('modelProvider'),t('requests'),t('tokens'),t('input'),t('output'),t('cacheHit'),t('estimatedCost')].map(h=><th key={h} style={cellStyle}>{h}</th>)}</tr></thead>
      <tbody>{[...models.values()].map(b=><tr key={JSON.stringify([b.provider,b.model])}>
        <td style={cellStyle}>{b.model}<br/><span style={{ opacity:.65 }}>{b.provider}</span></td>
        <td style={cellStyle}>{number(b.totals.requests)}</td>
        <td style={cellStyle}>{tokens(b.totals.total,b.totals.unknownUsage,b.totals.requests,t)}</td>
        <td style={cellStyle}>{tokens(b.totals.input,b.totals.unknownUsage,b.totals.requests,t)}</td>
        <td style={cellStyle}>{tokens(b.totals.output,b.totals.unknownUsage,b.totals.requests,t)}</td>
        <td style={cellStyle}>{!b.knownCacheInput?t('na'):`${new Intl.NumberFormat('en-US',{ maximumFractionDigits:1 }).format(b.knownCacheRead/b.knownCacheInput*100)}%`}</td>
        <td style={cellStyle}>{cost(b.totals,t)}</td>
      </tr>)}</tbody>
    </table></div>
    {!models.size&&<p>{t('uiNoRecordedModelRequests')}</p>}
    {deepseek.length>0&&<><h3 style={{ fontSize:14,marginTop:20 }}>{t('uiDeepSeekCostBreakdown')}</h3>
      <div style={{ overflowX:'auto' }}><table style={tableStyle}>
        <thead><tr>{[t('model'),t('tariffPeriod'),t('tokenCategory'),t('tokens'),t('estimatedCostUsd')].map(h=><th key={h} style={cellStyle}>{h}</th>)}</tr></thead>
        <tbody>{deepseek.map((b)=>{
          const rows=[
            { name:t('uncachedInput'),value:b.totals.input-b.totals.cacheRead,unknown:b.totals.unknownCache||b.totals.unknownUsage,amount:b.totals.uncachedCost },
            { name:t('cachedInput'),value:b.totals.cacheRead,unknown:b.totals.unknownCache,amount:b.totals.cacheCost },
            { name:t('output'),value:b.totals.output,unknown:b.totals.unknownUsage,amount:b.totals.outputCost },
          ]
          return rows.map((row,index)=><tr key={JSON.stringify([b.model,b.period,row.name])}>
            {index===0&&<><td rowSpan={4} style={cellStyle}>{b.model}</td><td rowSpan={4} style={cellStyle}>{b.period==='peak'?t('peak'):b.period==='off-peak'?t('offPeak'):t('unavailable')}</td></>}
            <td style={cellStyle}>{row.name}</td><td style={cellStyle}>{tokens(row.value,row.unknown,b.totals.requests,t)}</td>
            <td style={cellStyle}>{priced(b.totals)?money(row.amount):t('na')}</td>
          </tr>).concat(<tr key={JSON.stringify([b.model,b.period,'total'])} style={{ fontWeight:600 }}>
            <td style={cellStyle}>{t('uiTotal')}</td><td style={cellStyle}>{tokens(b.totals.total,b.totals.unknownUsage,
              b.totals.requests,t)}</td><td style={cellStyle}>{cost(b.totals,t)}</td>
          </tr>)
        })}</tbody>
      </table></div>
      <p style={{ opacity:
        .65 }}>{t('statisticsTariffs')}</p>
    </>}
    <p style={{ opacity: .65 }}>{t('statisticsHint')}</p>
    {s.incomplete.map((line,index)=><p key={index} style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{messageText(t,s.incompleteMessages?.[index],line)}</p>)}
    {error&&<p style={{ opacity:.65 }}>{t('uiStatisticsTemporarilyUnavailable')}</p>}
  </div>
}
