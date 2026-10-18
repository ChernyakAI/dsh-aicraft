import { z } from 'zod'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import { ACCOUNTING_VERSION, isPeakTime, priceRequest } from './pricing.ts'

const count = z.number().int().nonnegative()
const routeSchema = z.object({ provider: z.string(), model: z.string() })
const totalsSchema = z.object({ input: count, output: count, total: count, cacheRead: count, requests: count, unknownUsage: count, unknownCache: count, unknownPrice: count, priced: count, local: count, uncachedCost: count, cacheCost: count, outputCost: count })
export type AccountingTotals = z.infer<typeof totalsSchema>
export const zeroTotals = (): AccountingTotals => ({ input:0,output:0,total:0,cacheRead:0,requests:0,unknownUsage:0,unknownCache:0,unknownPrice:0,priced:0,local:0,uncachedCost:0,cacheCost:0,outputCost:0 })
const usageSchema = z.object({ inputTokens: count, outputTokens: count, totalTokens: count.optional(), cacheReadTokens: count.optional(), cacheWriteTokens: count.optional() })
const bucketSchema = z.object({ provider:z.string(), model:z.string(), period:z.enum(['peak','off-peak','unavailable']), totals:totalsSchema })
const attemptSchema = z.object({ start: count, turn: count, step: count, route: routeSchema.nullable(), sample: usageSchema.nullable(), charged: totalsSchema.nullable(), chargedKey:z.string().nullable() })
export const accountingSchema = z.object({ boundary: count, tracked: z.boolean(), route: routeSchema.nullable(), totals: totalsSchema, buckets:z.array(bucketSchema), attempt: attemptSchema.nullable(), intervals: z.array(z.tuple([count,count])), openSince: count.nullable(), children: z.array(z.object({ id:z.string(), local:z.boolean(), provider:z.string() })) })
export type AccountingState = z.infer<typeof accountingSchema>

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap { aicraftAccounting: AccountingState }
  interface SessionProjectionStateMap { aicraftAccounting: AccountingState }
}
declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    'aicraft/accounting': { version: 1 }
    'aicraft/delegation': { id: string; local: boolean; provider: string }
  }
}
export const record = (value: unknown): Record<string, unknown> => typeof value === 'object' && value !== null ? value as Record<string,unknown> : {}
/** Keep missing cache-hit reporting unknown; an exact total still supplies the full input count. */
function contribution(attempt: z.infer<typeof attemptSchema>): AccountingTotals {
  const result = zeroTotals(); result.requests = 1
  const unavailable = () => { result.unknownUsage=1;result.unknownCache=1;if(attempt.route?.provider==='lmstudio')result.local=1;else result.unknownPrice=1;return result }
  const u = attempt.sample
  if (!u) { return unavailable() }
  let read = u.cacheReadTokens ?? null, write = u.cacheWriteTokens ?? null
  const prompt = u.totalTokens === undefined ? null : u.totalTokens - u.outputTokens
  if (prompt !== null && (prompt < u.inputTokens + (read ?? 0) + (write ?? 0))) { return unavailable() }
  if (prompt !== null && read !== null && write === null && prompt === u.inputTokens + read) write = 0
  if (prompt !== null && read !== null && write !== null && prompt !== u.inputTokens + read + write) { return unavailable() }
  result.input = prompt ?? u.inputTokens + (read ?? 0) + (write ?? 0)
  result.output = u.outputTokens; result.total = result.input + result.output;result.cacheRead=read ?? 0
  if (prompt === null && (read === null || write === null)) result.unknownUsage=1
  if (read === null || (prompt === null && write === null)) result.unknownCache=1
  const price = attempt.route ? priceRequest(attempt.route.provider,attempt.route.model,attempt.start,{ input:u.inputTokens,cacheRead:read,cacheWrite:write,output:u.outputTokens }) : { kind:'unknown' as const }
  if (price.kind === 'local') result.local=1
  else if (price.kind === 'priced') { result.priced=1;result.uncachedCost=price.uncached;result.cacheCost=price.cache;result.outputCost=price.output }
  else result.unknownPrice=1
  return result
}
export function addTotals(a: AccountingTotals,b: AccountingTotals): AccountingTotals {
  return Object.fromEntries(Object.keys(a).map(key => [key,a[key as keyof AccountingTotals]+b[key as keyof AccountingTotals]])) as AccountingTotals
}
function charge(state: AccountingState): AccountingState {
  if (!state.attempt) return state
  const next = contribution(state.attempt), previous=state.attempt.charged ?? zeroTotals()
  const totals = Object.fromEntries(Object.keys(next).map(k=>[k,state.totals[k as keyof AccountingTotals]-previous[k as keyof AccountingTotals]+next[k as keyof AccountingTotals]])) as AccountingTotals
  const route=state.attempt.route??{provider:'unknown',model:'unknown'}
  const peak=next.priced?isPeakTime(state.attempt.start):null
  const period=peak===null?'unavailable':peak?'peak':'off-peak'
  const key=JSON.stringify([route.provider,route.model,period])
  const buckets=state.buckets.map(b=>({...b,totals:{...b.totals}}))
  const adjust=(bucketKey:string,amount:AccountingTotals,sign:number)=>{
    let bucket=buckets.find(b=>JSON.stringify([b.provider,b.model,b.period])===bucketKey)
    if(!bucket){bucket={...route,period,totals:zeroTotals()};buckets.push(bucket)}
    for(const k of Object.keys(amount) as Array<keyof AccountingTotals>)bucket.totals[k]+=sign*amount[k]
  }
  if(state.attempt.chargedKey)adjust(state.attempt.chargedKey,previous,-1)
  adjust(key,next,1)
  return { ...state,totals,buckets:buckets.filter(b=>b.totals.requests>0),attempt:{...state.attempt,charged:next,chargedKey:key} }
}
function sampleOf(data: Record<string,unknown>) {
  let sample:unknown = data.usage
  if (!sample && Array.isArray(data.stream)) for (const item of data.stream) {
    const chunk=record(record(item).chunk)
    if (chunk.type === 'usage') sample=chunk.usage
  }
  const parsed=usageSchema.safeParse(sample)
  return parsed.success ? parsed.data : null
}
/** One immutable native DSH projection; fork prefixes contribute routing context only. */
export const accountingProjection = {
  key:'aicraftAccounting' as const, stateVersion:ACCOUNTING_VERSION, stateSchema:accountingSchema,
  init: (_header:unknown,boundary:number):AccountingState=>({ boundary,tracked:false,route:null,totals:zeroTotals(),buckets:[],attempt:null,intervals:[],openSince:null,children:[] }),
  apply: (state:AccountingState,event:SessionEvent):AccountingState=>{
    const data=record(event.data),type=String(event.type)
    if (type==='request/header') {
      const parsed=routeSchema.safeParse(record(data.header).config)
      if (!parsed.success) return state
      return {...state,route:parsed.data,attempt:state.attempt&&!state.attempt.charged?{...state.attempt,route:parsed.data}:state.attempt}
    }
    if (event.seq<state.boundary) return state
    if (type==='aicraft/accounting') return {...state,tracked:true}
    if (type==='aicraft/delegation') {
      if (state.children.some(c=>c.id===data.id)) return state
      return {...state,children:[...state.children,{id:String(data.id),local:data.local===true,provider:String(data.provider)}]}
    }
    if (type==='turn/start') return {...state,openSince:event.time}
    if (type==='step/start'||type==='llm/retry-started') {
      const settled=state.attempt&&!state.attempt.charged?charge(state):state
      return {...settled,attempt:{start:event.time,turn:Number(data.turn),step:Number(data.step),route:state.route,sample:null,charged:null,chargedKey:null}}
    }
    if ((type==='assistant/attempt'||type==='assistant/message')&&state.attempt) {
      const parsed=routeSchema.safeParse(record(data.message).source)
      const attempt={...state.attempt,sample:sampleOf(data)??state.attempt.sample,route:parsed.success?parsed.data:state.attempt.route}
      return charge({...state,attempt})
    }
    if (type==='llm/retry') return state.attempt&&!state.attempt.charged?charge(state):state
    if (type==='step/end') return {...(state.attempt&&!state.attempt.charged?charge(state):state),attempt:null}
    if (type==='turn/end') {
      const next=state.attempt&&!state.attempt.charged?charge(state):state
      return {...next,attempt:null,openSince:null,intervals:state.openSince===null?state.intervals:[...state.intervals,[state.openSince,Math.max(state.openSince,event.time)]]}
    }
    return state
  },
  wire:{ viewSchema:accountingSchema,view:(state:AccountingState)=>state },
}
/** Union root activity intervals; concurrent executor chats must not double elapsed task time. */
export function intervalUnion(intervals:readonly (readonly [number,number])[]):number {
  const sorted=[...intervals].sort((a,b)=>a[0]-b[0]);let total=0,end=-Infinity
  for(const [from,to]of sorted){total+=Math.max(0,to-Math.max(from,end));end=Math.max(end,to)}
  return total
}
