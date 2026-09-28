import {randomUUID} from 'node:crypto';
import type {OperationalEvent} from './assistant-types.js';

type EventInput=Omit<OperationalEvent,'id'|'observedAt'> & {id?:string;observedAt?:string};
export function NormalizeEvent(Input:EventInput):OperationalEvent {
  if (!/^\d{17,20}$/.test(Input.guildId)) throw new Error('Event requires an exact guild ID');
  return {id:Input.id??`event_${randomUUID()}`,guildId:Input.guildId,observedAt:Input.observedAt??new Date().toISOString(),
    type:Input.type,channelId:Input.channelId,messageId:Input.messageId,authorId:Input.authorId,userId:Input.userId,
    roleId:Input.roleId,threadId:Input.threadId,accountCreatedAt:Input.accountCreatedAt};
}

export class EventDispatcher {
  private readonly Handlers=new Set<(EventValue:OperationalEvent)=>void|Promise<void>>();
  Subscribe(Handler:(EventValue:OperationalEvent)=>void|Promise<void>):()=>void {
    this.Handlers.add(Handler);return ()=>this.Handlers.delete(Handler);
  }
  Dispatch(EventValue:OperationalEvent):void {
    for (const Handler of this.Handlers) {
      try {void Promise.resolve(Handler(EventValue)).catch(Cause=>this.Report(Cause));}
      catch (Cause) {this.Report(Cause);}
    }
  }
  private Report(Cause:unknown):void {
    process.stderr.write(`[DiscordAssistant:Events] Handler failed: ${Cause instanceof Error?Cause.message:String(Cause)}\n`);
  }
}
