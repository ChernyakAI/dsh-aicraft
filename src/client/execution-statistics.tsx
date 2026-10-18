import { useEffect, useState } from 'react'
import { Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ExecutionStatistics as Statistics, StatisticsBucket } from '../types.ts'

export interface StatisticsProps {
  workspaceId: string; taskId: string; sessionId: string | null; active: boolean; revision: string; running?: boolean
  load(workspaceId:string,taskId:string,sessionId:string|null,signal:AbortSignal):Promise<Statistics>
  title?: string
}
const number=(n:number)=>new Intl.NumberFormat('en-US',{notation:'compact',maximumFractionDigits:2}).format(n)
const duration=(ms:number)=>{
  const seconds=Math.max(0,Math.round(ms/1000)),hours=Math.floor(seconds/3600),minutes=Math.floor(seconds%3600/60)
  return hours?`${hours}h ${minutes}m ${seconds%60}s`:minutes?`${minutes}m ${seconds%60}s`:`${seconds}s`
}
const money=(n:number)=>n>0&&n<1000?'<$0.000001':new Intl.NumberFormat('en-US',{style:'currency',currency:'USD',minimumFractionDigits:2,maximumFractionDigits:6}).format(n/1e9)
/** Metrics have their own asynchronous lifecycle; they never block project, table or chat rendering. */
export function ExecutionStatistics({workspaceId,taskId,sessionId,active,revision,load,title,running=false}:StatisticsProps){
  const [statistics,setStatistics]=useState<Statistics|null>(null),[error,setError]=useState(''),[details,setDetails]=useState(false)
  useEffect(()=>{
    if(!active||running)return
    const abort=new AbortController()
    const read=async()=>{
      try{
        const next=await load(workspaceId,taskId,sessionId,abort.signal)
        if(!abort.signal.aborted){setStatistics(next);setError('')}
      }catch(e){if(!abort.signal.aborted)setError(e instanceof Error?e.message:String(e))}

    }
    void read()
    return()=>abort.abort()
  },[workspaceId,taskId,sessionId,active,revision,load,running])
  if (!statistics && running) return null
  const s=statistics
  const complete=s!==null&&s.requests>0&&!s.coverageIncomplete&&!s.unknownUsage&&!s.unknownCache&&!s.unknownPrice&&s.priced===s.requests
  const deepseek=s?.buckets.filter(bucket=>bucket.provider==='deepseek-official')??[]
  const dsPriced=deepseek.some(bucket=>bucket.totals.priced>0)
  const dsCost=deepseek.reduce((sum,{totals})=>sum+totals.uncachedCost+totals.cacheCost+totals.outputCost,0)
  const dsMoney=dsCost>0&&dsCost<1000?'<0.000001$':`${new Intl.NumberFormat('en-US',{minimumFractionDigits:2,maximumFractionDigits:6}).format(dsCost/1e9)}$`
  return <section aria-label={title??'Run statistics'} style={{fontSize:12,lineHeight:1.7,marginTop:title?0:8,overflowWrap:'anywhere'}}>
    <div style={{display:'flex',alignItems:'baseline',flexWrap:'wrap',gap:'0 8px',opacity:.8}}>
      <span>{sessionId===null?'Total task time:':'Time:'} {s?duration(s.elapsedMs):error?'N/A':'Calculating…'}{sessionId===null?'.':''}</span>
      {sessionId===null&&s&&<span>Cost: {dsMoney}</span>}
      {sessionId!==null&&complete&&<span>· Tokens: {number(s.total)}</span>}
      {sessionId!==null&&dsPriced&&<span>· Cost: {dsMoney}</span>}
      <button type="button" disabled={!s} onClick={()=>setDetails(true)} style={{border:0,padding:0,background:'none',color:'inherit',font:'inherit',textDecoration:'underline',cursor:s?'pointer':'default'}}>{sessionId===null?'Detailed usage':'Details'}</button>
    </div>
    {details&&s&&<><style>{'.aicraft-statistics-dialog { width: min(960px, 100%); max-height: 100%; }'}</style><Modal className="aicraft-statistics-dialog" open title={title?'Task statistics':'Chat statistics'} closeLabel="Close" onClose={()=>setDetails(false)}>
      <StatisticsDetails statistics={s} error={error}/>
    </Modal></>}
  </section>
}

const tokens=(value:number,unknown:number,requests:number)=>value>0||!unknown||requests>unknown?number(value):'N/A'
const priced=(s:StatisticsBucket['totals'])=>s.priced>0
const cost=(s:StatisticsBucket['totals'])=>priced(s)?money(s.uncachedCost+s.cacheCost+s.outputCost):s.local===s.requests&&s.requests>0&&!s.unknownPrice?'Local':'N/A'
function StatisticsDetails({statistics:s,error}:{statistics:Statistics;error:string}){
  const models=new Map<string,StatisticsBucket & {knownCacheInput:number;knownCacheRead:number}>()
  for(const bucket of s.buckets){
    const key=JSON.stringify([bucket.provider,bucket.model]),previous=models.get(key)
    const knownCache=!bucket.totals.unknownCache&&!bucket.totals.unknownUsage
    const knownCacheInput=knownCache?bucket.totals.input:0,knownCacheRead=knownCache?bucket.totals.cacheRead:0
    if(!previous)models.set(key,{...bucket,totals:{...bucket.totals},knownCacheInput,knownCacheRead})
    else {
      for(const k of Object.keys(bucket.totals) as Array<keyof StatisticsBucket['totals']>)previous.totals[k]+=bucket.totals[k]
      previous.knownCacheInput+=knownCacheInput;previous.knownCacheRead+=knownCacheRead
    }
  }
  const deepseek=s.buckets.filter(b=>b.provider==='deepseek-official')
  const tableStyle={width:'100%',borderCollapse:'collapse' as const,fontSize:12,textAlign:'left' as const}
  const cellStyle={padding:'8px',borderBottom:'1px solid #8090a030',verticalAlign:'top' as const}
  return <div style={{maxHeight:'70vh',overflow:'auto'}}>
    <p>Time: {duration(s.elapsedMs)} (LLM: {duration(s.llmMs)} · Tools: {duration(s.toolMs)}){s.running?' · running':''}</p>
    <h3 style={{fontSize:14}}>Models</h3>
    <div style={{overflowX:'auto'}}><table style={tableStyle}>
      <thead><tr>{['Model / provider','Requests','Tokens','Input','Output','Cache hit','Estimated cost'].map(h=><th key={h} style={cellStyle}>{h}</th>)}</tr></thead>
      <tbody>{[...models.values()].map(b=><tr key={JSON.stringify([b.provider,b.model])}>
        <td style={cellStyle}>{b.model}<br/><span style={{opacity:.65}}>{b.provider}</span></td>
        <td style={cellStyle}>{number(b.totals.requests)}</td>
        <td style={cellStyle}>{tokens(b.totals.total,b.totals.unknownUsage,b.totals.requests)}</td>
        <td style={cellStyle}>{tokens(b.totals.input,b.totals.unknownUsage,b.totals.requests)}</td>
        <td style={cellStyle}>{tokens(b.totals.output,b.totals.unknownUsage,b.totals.requests)}</td>
        <td style={cellStyle}>{!b.knownCacheInput?'N/A':`${new Intl.NumberFormat('en-US',{maximumFractionDigits:1}).format(b.knownCacheRead/b.knownCacheInput*100)}%`}</td>
        <td style={cellStyle}>{cost(b.totals)}</td>
      </tr>)}</tbody>
    </table></div>
    {!models.size&&<p>No recorded model requests.</p>}
    {deepseek.length>0&&<><h3 style={{fontSize:14,marginTop:20}}>DeepSeek cost breakdown</h3>
      <div style={{overflowX:'auto'}}><table style={tableStyle}>
        <thead><tr>{['Model','Tariff period','Token category','Tokens','Estimated cost (USD)'].map(h=><th key={h} style={cellStyle}>{h}</th>)}</tr></thead>
        <tbody>{deepseek.map(b=>{
          const rows=[
            {name:'Uncached input',value:b.totals.input-b.totals.cacheRead,unknown:b.totals.unknownCache||b.totals.unknownUsage,amount:b.totals.uncachedCost},
            {name:'Cached input',value:b.totals.cacheRead,unknown:b.totals.unknownCache,amount:b.totals.cacheCost},
            {name:'Output',value:b.totals.output,unknown:b.totals.unknownUsage,amount:b.totals.outputCost},
          ]
          return rows.map((row,index)=><tr key={JSON.stringify([b.model,b.period,row.name])}>
            {index===0&&<><td rowSpan={4} style={cellStyle}>{b.model}</td><td rowSpan={4} style={cellStyle}>{b.period==='peak'?'Peak':b.period==='off-peak'?'Off-peak':'Unavailable'}</td></>}
            <td style={cellStyle}>{row.name}</td><td style={cellStyle}>{tokens(row.value,row.unknown,b.totals.requests)}</td>
            <td style={cellStyle}>{priced(b.totals)?money(row.amount):'N/A'}</td>
          </tr>).concat(<tr key={JSON.stringify([b.model,b.period,'total'])} style={{fontWeight:600}}>
            <td style={cellStyle}>Total</td><td style={cellStyle}>{tokens(b.totals.total,b.totals.unknownUsage,b.totals.requests)}</td><td style={cellStyle}>{cost(b.totals)}</td>
          </tr>)
        })}</tbody>
      </table></div>
      <p style={{opacity:.65}}>USD estimates use the recorded request start time. Flash rates apply from September 10, 2026, 04:00 UTC; Pro rates from August 16, 2026, 16:00 UTC. Peak/off-peak periods use UTC and the 2026 Chinese holiday calendar. Earlier or unsupported tariff periods are N/A.</p>
    </>}
    <p style={{opacity:.65}}>Includes available subagent usage. Time counts root chat activity; parallel chats overlap. Cost sums available DeepSeek calculations. Cache hit uses periods with known input and cache data. Unavailable values are N/A; local models have no API cost estimate.</p>
    {error&&<p style={{opacity:.65}}>Statistics temporarily unavailable.</p>}
  </div>
}
