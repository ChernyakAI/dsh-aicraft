/**
 * FILE: plugin/src/execution-accounting/statistics.ts
 * DESCRIPTION: Track executor accounting and serve derived statistics
 */
import { diagnosticPublication, diagnosticOperation, diagnosticRejection } from '../dsh-integration/diagnostics.ts'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { withFileLock } from '@deepseek-ai/dsh-atomic-write'
import type { FsVersion } from '@deepseek-ai/dsh-fs'
import type { } from '@deepseek-ai/dsh-session-projection'
import type { } from '@deepseek-ai/dsh-session-query'
import type { } from '@deepseek-ai/dsh-subagent'
import { join } from 'node:path'
import { z } from 'zod'
import { readRuns } from '../step-execution/history.ts'
import { readTaskState } from '../task-management/queries.ts'
import type { ExecutionStatistics,StatisticsBucket } from '../types.ts'
import { readMaterial,targetFor } from '../work-materials/materials.ts'
import { accountingProjection,addTotals,intervalUnion,record,zeroTotals } from './accounting.ts'

const trackingSchema=z.object({ version:z.literal(1),sessions:z.array(z.object({ id:z.string(),children:z.array(z.object({
  id:z.string(),local:z.boolean(),provider:z.string() })) })) })
type Tracking = z.infer<typeof trackingSchema>

import { SessionSource, type CachedPacket } from './session-source.ts'

/** Host-owned persisted folds and bounded query admission, independent of panel rendering. */
export class StatisticsController {
  private readonly attached=new WeakSet<Agent>()
  private readonly detach=new WeakMap<Agent,()=>void|Promise<void>>()
  private readonly packets=new Map<string,CachedPacket>()
  private readonly source:SessionSource
  private readers=0
  private readonly waiting:Array<()=>void>=[]
  constructor(private readonly ctx:Context,private readonly lockWaitMs=10000){
    this.source=new SessionSource(ctx)
    ctx.effect(()=>ctx.sessionProjections.register(accountingProjection),'aicraft: persisted accounting')
    ctx.on('agent/disposed',({ agent })=>{
      const stop=this.detach.get(agent);this.detach.delete(agent)
      return stop?.()
    })
    ctx.on('agent/created',async({ agent })=>{
      const cwd=agent.session.header.cwd
      if(!cwd)return
      const parent=agent.session.header.parentSession,owner=parent?ctx.agents.get(parent):undefined
      if(owner&&this.attached.has(owner)){await this.track(agent);return}
      let saved:Tracking
      try{saved=await this.tracking(cwd)}catch(error){ctx.get('logger')?.warn(`AICraft accounting metadata unavailable: ${String(error)}`);return}
      if(saved.sessions.some(item=>item.id===agent.session.id)||ctx.sessionProjections.stateOf(agent.session,'aicraftAccounting')?.tracked)await this.track(agent)
    })
  }
  /** Keep project accounting metadata separate from session logs. */
  private async tracking(cwd:string,update?:(value:Tracking)=>void):Promise<Tracking>{
    return diagnosticOperation({ path: 'src/execution-accounting/statistics.ts' }, { projectPath: cwd }, async () => {
      const path='.aicraft/accounting.json',signal=new AbortController().signal
      const read=async()=>{
        const info=await this.ctx.fs.lstat(path,{ cwd })
        if(!info)return { value:{ version:1,sessions:[] } as Tracking,version:null }
        const doc=await readMaterial(this.ctx.fs,cwd,path,new AbortController().signal)
        return { value:trackingSchema.parse(JSON.parse(doc.text)),version:doc.version }
      }
      if(!update)return (await read()).value
      await targetFor(this.ctx.fs,cwd,path,signal)
      return withFileLock(join(cwd,path),async()=>{
        const target=await targetFor(this.ctx.fs,cwd,path,signal)
        const { value,version }=await read()
        update(value)
        await diagnosticPublication(() => this.ctx.fs.writeText(target,JSON.stringify(value,null,2)+'\n',version===null?{ kind:'createIfAbsent' }:{ kind:'replaceIfVersion',version:version as FsVersion },undefined,{ mode:'workspace-write',workspaceRoot:cwd }), target, 'writeText')
        return value
      },{ waitMs:this.lockWaitMs })

    })
  }
  /**
   * START_METHOD_StatisticsController.track
   * Track only AICraft executors and their native descendants; never append custom chat events.
   */
  async track(agent:Agent):Promise<void>{
    return diagnosticOperation({ path: 'src/execution-accounting/statistics.ts', method: 'StatisticsController.track' }, { sessionId: agent.session.id }, async () => {
      if(this.attached.has(agent))return
      const cwd=agent.session.header.cwd
      if(!cwd)throw diagnosticRejection(new Error('AICraft accounting requires the session project directory'))
      const id=agent.session.id
      this.attached.add(agent)
      try{await this.tracking(cwd,(value)=>{if(!value.sessions.some(item=>item.id===id))value.sessions.push({ id,children:[] })})}
      catch(error){this.attached.delete(agent);throw error}
      const detach=this.ctx.effect(()=>agent.ctx.on('subagent/start',async (info)=>{
        await this.tracking(cwd,(value)=>{
          const session=value.sessions.find(item=>item.id===id)!
          if(!session.children.some(child=>child.id===info.id))session.children.push({ id:info.id,local:info.local,provider:info.provider })
        })
      }),'aicraft: delegation accounting')
      this.detach.set(agent,detach)

    })
  }
  // END_METHOD_StatisticsController.track

  /**
   * START_METHOD_StatisticsController.read
   * Validate the requested root; retain saved descendants even when their parent packet is unavailable.
   */
  async read(cwd:string,taskId:string,sessionId:string|null,signal:AbortSignal):Promise<ExecutionStatistics>{
    return diagnosticOperation({ path: 'src/execution-accounting/statistics.ts', method: 'StatisticsController.read' }, { projectPath: cwd, taskId: taskId, sessionId: sessionId }, async () => {
      if(!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(taskId))throw diagnosticRejection(new Error('Invalid task identifier'))
      await readTaskState(this.ctx.fs,cwd,taskId,signal)
      const task={ runs:await readRuns(this.ctx.fs,cwd,taskId,signal) }
      const roots=[...new Set(task.runs.filter(run=>sessionId===null||run.sessionId===sessionId).sort((a,b)=>
        Date.parse(b.startedAt)-Date.parse(a.startedAt)).map(run=>run.sessionId))]
      if(sessionId!==null&&!roots.includes(sessionId))throw diagnosticRejection(new Error('The session does not belong to this task'))
      let tracking:Tracking={ version:1,sessions:[] }
      let trackingUnavailable=false
      try{tracking=await this.tracking(cwd)}catch{trackingUnavailable=true}
      const rootSet=new Set(roots),visited=new Set<string>(),incomplete=new Set<string>(),intervals:Array<[number,number]>=[]
      const buckets=new Map<string,StatisticsBucket>()
      let totals=zeroTotals(),llmMs=0,toolMs=0,running=false,sessions=0,coverageIncomplete=false
      const missing=(message:string)=>{coverageIncomplete=true;incomplete.add(message)}
      const stack=[...roots].reverse()
      while(stack.length){
        signal.throwIfAborted()
        const id=stack.pop()!
        if(visited.has(id))continue
        visited.add(id)
        let packet:Awaited<ReturnType<StatisticsController['observe']>>=null
        try{packet=await this.observe(cwd,id,signal)}catch(error){if(signal.aborted)throw error}
        const saved=tracking.sessions.find(item=>item.id===id)
        const children=new Map<string,{ local:boolean }>()
        if(!packet)missing('Some session statistics are unavailable.')
        else{
          const { state,stats,live }=packet;sessions++;totals=addTotals(totals,state.totals)
          for(const bucket of state.buckets){
            const key=JSON.stringify([bucket.provider,bucket.model,bucket.period]),previous=buckets.get(key)
            buckets.set(key,{ ...bucket,totals:previous?addTotals(previous.totals,bucket.totals):bucket.totals })
          }
          if(!state.tracked&&!saved)missing('Earlier subagent usage may be missing.')
          if(trackingUnavailable)missing('Delegation accounting metadata is unavailable.')
          if(state.attempt||state.openSince!==null)running=true
          if(rootSet.has(id)){
            intervals.push(...state.intervals)
            if(state.openSince!==null&&live)intervals.push([state.openSince,Date.now()])
            if(typeof stats.llmMs==='number'&&typeof stats.toolMs==='number'){llmMs+=stats.llmMs;toolMs+=stats.toolMs}
            else incomplete.add('Some timing data is unavailable.')
          }
          for(const child of state.children)children.set(child.id,{ local:child.local })
        }
        // DATA-7 links remain available independently of the parent's projection and metrics.
        for(const child of saved?.children??[])children.set(child.id,{ local:child.local })
        if(packet){
          if(!Array.isArray(packet.catalog))missing('Subagent discovery is unavailable.')
          else for(const value of packet.catalog){const child=record(value);if(typeof child.id==='string'&&!children.has(child.id))children.set(child.id,{ local:true })}
        }
        for(const [child,info]of children){
          if(info.local)stack.push(child)
          else missing('External subagent usage is unavailable.')
        }
      }
      if(totals.unknownUsage)incomplete.add('Some requests did not report complete token usage.')
      if(totals.unknownCache)incomplete.add('Some requests did not report cache details.')
      return { ...totals,buckets:[...buckets.values()],elapsedMs:intervalUnion(intervals),llmMs,toolMs,running,sessions,
        coverageIncomplete,incomplete:[...incomplete] }

    })
  }
  // END_METHOD_StatisticsController.read

  /** Keep one bounded LRU of completed folds; source validation never globally resolves a direct file. */
  private async observe(cwd:string,id:string,signal:AbortSignal){
    if(this.readers>=2)await new Promise<void>(resolve=>this.waiting.push(resolve))
    else this.readers++
    const key=JSON.stringify([cwd,id])
    try{
      signal.throwIfAborted()
      const result=await this.source.read(cwd,id,signal,this.packets.get(key))
      signal.throwIfAborted()
      this.packets.delete(key)
      if(result.packet&&result.stamp){
        this.packets.set(key,{ stamp:result.stamp,packet:result.packet })
        if(this.packets.size>128)this.packets.delete(this.packets.keys().next().value!)
      }
      return result.packet
    }catch(error){this.packets.delete(key);throw error}
    finally{const next=this.waiting.shift();if(next)next();else this.readers--}
  }
}
