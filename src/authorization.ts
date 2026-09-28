import type {ActorIdentity,Capability} from './assistant-types.js';
import {DiscordError} from './discord.js';

export class OperationalError extends Error {
  constructor(readonly code:string,message:string,readonly guildId?:string,readonly targetId?:string) {super(message);}
  ToJSON() {return {code:this.code,message:this.message,guildId:this.guildId,targetId:this.targetId};}
}

export function DescribeError(Cause:unknown):ReturnType<OperationalError['ToJSON']> {
  if (Cause instanceof OperationalError) return Cause.ToJSON();
  if (Cause instanceof DiscordError) {
    const Code=Cause.Status===403?'MISSING_DISCORD_PERMISSION':Cause.Status===404?'RESOURCE_NOT_FOUND':
      Cause.Status===429?'RATE_LIMIT_EXHAUSTED':Cause.Code==='NETWORK'?'ACTION_UNCERTAIN':'DISCORD_ERROR';
    return {code:Code,message:Cause.message,guildId:undefined,targetId:undefined};
  }
  const Message=Cause instanceof Error?Cause.message:String(Cause);
  const Code=Message.startsWith('PLAN_STALE')?'PLAN_STALE':Message.includes('uncertain')?'PLAN_UNCERTAIN':'OPERATION_FAILED';
  return {code:Code,message:Message,guildId:undefined,targetId:undefined};
}

export class AuthorizationPolicy {
  private readonly DiscordOperators:Set<string>;
  constructor(DiscordOperatorIds:string[]=[]){this.DiscordOperators=new Set(DiscordOperatorIds);}
  Decide(Actor:ActorIdentity,_GuildId:string,_Capability:Capability):{allowed:boolean;reason:string} {
    if (Actor.kind==='local-mcp'||Actor.kind==='local-http') return {allowed:true,reason:'Authenticated local operator'};
    if (Actor.kind==='discord-user'&&Actor.externalId&&this.DiscordOperators.has(Actor.externalId))
      return {allowed:true,reason:'Configured Discord operator'};
    return {allowed:false,reason:'Actor is not a configured operator'};
  }
  Require(Actor:ActorIdentity,GuildId:string,Capability:Capability):void {
    const Decision=this.Decide(Actor,GuildId,Capability);
    if (!Decision.allowed) throw new OperationalError('NOT_AUTHORIZED',Decision.reason,GuildId);
  }
}
