import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { initDb, getJob, getJobEvents, type DbInstance } from '../../../db'
import { LoopRunManager, type LoopExecutors, type LoopRunRequest } from './loop-run-manager'
import { createDefinitionEventProjection } from './loop-definition-events'
import { getLoopRun } from './loop-runs-store'
import type { DefinitionLoopInvocation, DefinitionRuntimeResult } from './loop-definition-run'

let db: DbInstance
beforeEach(() => { db = initDb(':memory:') })
afterEach(() => db.close())
function request(): LoopRunRequest { return { runId:'r1',loopId:'test-loop',projectId:'p1',cwd:'/repo',provider:'claude',model:'sonnet',graph:{nodes:[
  {id:'start',type:'start',position:{x:0,y:0}}, {id:'a',type:'core',position:{x:0,y:100},data:{kind:'prompt',params:{text:'Read',access:'read',engine:{provider:'claude'}}}},
  {id:'end',type:'core',position:{x:0,y:200},data:{kind:'end',params:{outcome:'success'}}}],edges:[{id:'s',source:'start',target:'a'},{id:'e',source:'a',target:'end',label:'next'}],config:{maxIterations:3,timeoutMinutes:0}} } }
const complete = (ok=true): DefinitionRuntimeResult => ({text:'done',runtimeStatus:'succeeded',completion:{ok,verified:ok,reasons:ok?[]:['verification missing']},cost:999,tokens:999})
function executors(run: LoopExecutors['runDefinition']): LoopExecutors { return {runDefinition:run,runAiStep:vi.fn(),runShell:vi.fn(),runDecider:vi.fn()} }
const at='2026-09-26T12:00:00.000Z'
function step(sequence:number,type:string,attemptId='attempt-a',nodePath='map[0]/read') { return {type:'workflow-event',event:{id:`r1:${sequence}`,runId:'r1',sequence,type,attemptId,nodePath,scopeId:attemptId,branch:attemptId,visit:1,attempt:1,timestamp:at}} }
function usage(sequence:number, invocationId='physical-1', costUsd:number|null=.6) { return {type:'runtime-efficiency-event',eventId:`r1:${sequence}`,runId:'r1',sequence,timestamp:at,kind:'role-context',attemptId:'attempt-a',nodePath:'map[0]/read',payload:{invocationId,provider:'claude',model:'sonnet',status:'succeeded',startedAt:at,finishedAt:'2026-09-26T12:00:01.000Z',durationMs:1000,usage:{inputTokens:5,outputTokens:2,costUsd,cacheReadInputTokens:3,cacheWriteInputTokens:null}}} }

describe('Core definitions in Loop Manager',()=>{
  it('uses one Core process and physical invocation evidence, never legacy traversal or aggregate double billing',async()=>{
    const ex=executors(async input=>{input.onRuntimeEvent(step(1,'step_started'));input.onRuntimeEvent(usage(2));input.onRuntimeEvent(step(3,'step_succeeded'));return complete()})
    const manager=new LoopRunManager(db,()=>{},ex)
    expect(await manager.run(request())).toMatchObject({outcome:'success',totalCostUsd:.6})
    expect(ex.runAiStep).not.toHaveBeenCalled();expect(ex.runShell).not.toHaveBeenCalled();expect(ex.runDecider).not.toHaveBeenCalled()
    expect(getJob(db,'r1')).toMatchObject({total_cost_usd:.6,tokens_in:5,tokens_out:2,tokens_cache_read:3,tokens_cache_create:null,num_turns:null})
    expect(db.prepare('SELECT COUNT(*) AS n FROM ai_invocations').get()).toEqual({n:1})
    expect(getJobEvents(db,'r1').filter(e=>e.event_type==='loop_step_end').map(e=>JSON.parse(e.payload))).toMatchObject([{attemptId:'attempt-a',nodeId:'map[0]/read',status:'ok'}])
  })
  it('records all concurrent branches and resumes the selected question without replay billing',async()=>{
    let calls=0
    const ex=executors(async input=>{calls++;input.onRuntimeEvent(step(1,'step_started'));input.onRuntimeEvent(step(2,'step_started','attempt-b','map[1]/read'));input.onRuntimeEvent(usage(3));
      if(calls===1)return {text:'',runtimeStatus:'paused',pendingInterrupts:[{id:'q1',nodePath:'map[0]/ask',kind:'question'},{id:'q2',nodePath:'map[1]/ask',kind:'question'}]}
      expect(input).toMatchObject({resume:true,answer:'Answer B',interruptId:'q2'});input.onRuntimeEvent(step(4,'step_succeeded','attempt-b','map[1]/read'));input.onRuntimeEvent(step(5,'step_succeeded'));return complete()
    })
    const manager=new LoopRunManager(db,()=>{},ex);const running=manager.run(request());await vi.waitFor(()=>expect(manager.isPaused('r1')).toBe(true))
    expect(manager.sendInteractiveTurn('r1','Ambiguous')).toBe(false)
    expect(manager.sendInteractiveTurn('r1','Answer B',{interruptId:'q2'})).toBe(true)
    expect((await running).outcome).toBe('success')
    expect(db.prepare('SELECT COUNT(*) AS n FROM ai_invocations').get()).toEqual({n:1})
    const events=getJobEvents(db,'r1');expect(events.filter(e=>e.event_type==='loop_step')).toHaveLength(2)
    expect(events.filter(e=>e.event_type==='loop_step_end').map(e=>JSON.parse(e.payload).index)).toEqual([2,1])
  })
  it('requires explicit approval and keeps text-only messages from authorizing an effect',async()=>{
    let calls=0
    const ex=executors(async input=>{if(calls++===0)return {text:'',runtimeStatus:'paused',pendingInterrupts:[{id:'approval-id',nodePath:'archive',kind:'approval'}]};expect(input.approve).toEqual(['approval-id']);return complete()})
    const manager=new LoopRunManager(db,()=>{},ex);const running=manager.run(request());await vi.waitFor(()=>expect(manager.isPaused('r1')).toBe(true))
    expect(manager.sendInteractiveTurn('r1','yes')).toBe(false)
    expect(manager.isPaused('r1')).toBe(true)
    expect(manager.sendInteractiveTurn('r1','',{interruptId:'approval-id',approve:true})).toBe(true)
    expect((await running).outcome).toBe('success')
  })
  it('cancels a paused run without launching a resume and preserves unavailable billing',async()=>{
    const run=vi.fn(async():Promise<DefinitionRuntimeResult>=>({text:'',runtimeStatus:'paused',pendingInterrupts:[{id:'q1',nodePath:'ask',kind:'question'}]}))
    const manager=new LoopRunManager(db,()=>{},executors(run));const running=manager.run(request());await vi.waitFor(()=>expect(manager.isPaused('r1')).toBe(true));manager.cancel('r1')
    expect(await running).toMatchObject({outcome:'stopped',totalCostUsd:null});expect(run).toHaveBeenCalledTimes(1)
  })
  it('separates successful execution from failed acceptance and rejects old Core before admission',async()=>{
    const manager=new LoopRunManager(db,()=>{},executors(async()=>complete(false)))
    expect((await manager.run(request())).outcome).toBe('blocked')
    const completion=JSON.parse(getJobEvents(db,'r1').find(e=>e.event_type==='loop_completion')!.payload)
    expect(completion).toMatchObject({execution:'success',completion:{ok:false}})
    const unsupported=new LoopRunManager(db,()=>{},{...executors(undefined)})
    await expect(unsupported.run({...request(),runId:'r2'})).rejects.toThrow('engine_unsupported');expect(getLoopRun(db,'r2')).toBeUndefined()
  })
  it('rolls back event and accounting together, replays once, and retains NULL provider values',async()=>{
    let seen: DefinitionLoopInvocation|undefined
    const manager=new LoopRunManager(db,()=>{},executors(async input=>{seen=input;return complete()}));await manager.run(request())
    const observer=vi.fn();let sequence=100
    const project=createDefinitionEventProjection({db,runId:'r1',projectId:'p1',ticketIds:[2,1],nextSequence:()=>sequence++,broadcast:observer})
    db.exec("CREATE TRIGGER reject_core_event BEFORE INSERT ON events WHEN NEW.event_type='runtime-efficiency-event' BEGIN SELECT RAISE(ABORT,'event write failed'); END")
    expect(()=>project(usage(10))).toThrow('event write failed');expect(db.prepare('SELECT COUNT(*) AS n FROM ai_invocations').get()).toEqual({n:0});expect(observer).not.toHaveBeenCalled()
    db.exec('DROP TRIGGER reject_core_event');project(usage(10));project(usage(10));project(usage(11,'physical-2',null))
    const rows=db.prepare('SELECT tokens_in,tokens_out,total_cost_usd FROM ai_invocations ORDER BY id').all()
    expect(rows).toEqual([{tokens_in:3,tokens_out:1,total_cost_usd:.3},{tokens_in:2,tokens_out:1,total_cost_usd:.3},{tokens_in:3,tokens_out:1,total_cost_usd:null},{tokens_in:2,tokens_out:1,total_cost_usd:null}]);expect(observer).toHaveBeenCalledTimes(2)
    expect(()=>project({...usage(10),payload:{...usage(10).payload,model:'changed'}})).toThrow('changed its committed content')
    expect(()=>seen!.onRuntimeEvent({...step(20,'step_started'),event:{...step(20,'step_started').event,runId:'other'}})).toThrow('another run')
  })
})
