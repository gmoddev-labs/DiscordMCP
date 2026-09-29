import {z} from 'zod';
import {BlueprintSchema,ChannelSpec,RoleSpec,Snowflake} from './types.js';
import type {ControlPlane} from './control.js';
import type {ActorIdentity,Capability} from './assistant-types.js';

export type Risk='read'|'write'|'destructive';
export type OperationDefinition={
  Name:string;Category:string;Risk:Risk;Description:string;Schema:z.ZodObject<z.ZodRawShape>;
  Capability?:Capability;Progressive:boolean;
  Handler:(Control:ControlPlane,Args:any,Actor:ActorIdentity)=>Promise<unknown>|unknown;
};
const Guild=z.object({guildId:Snowflake});
const Member=Guild.extend({userId:Snowflake});
const MemberRole=Member.extend({roleId:Snowflake});
const Cursor=z.string().regex(/^\d{1,16}$/).optional();
const DateTime=z.string().datetime({offset:true}).optional();
const PlanId=z.object({planId:z.string().startsWith('plan_')});
const ChannelMessage=Guild.extend({channelId:Snowflake,messageId:Snowflake});
export const Define=(Name:string,Category:string,RiskValue:Risk,Description:string,Schema:OperationDefinition['Schema'],
  Handler:OperationDefinition['Handler'],CapabilityValue?:Capability):OperationDefinition=>({
    Name,Category,Risk:RiskValue,Description,Schema,Handler,Capability:CapabilityValue,Progressive:true
  });
function PlanOwner(Control:ControlPlane,PlanIdValue:string,Actor:ActorIdentity):string {
  const Plan=Control.Store.GetPlan(PlanIdValue);
  if (Plan) Control.Assistant.Require(Actor,Plan.guildId,'guild.structure.apply');
  return Plan&&!Plan.actorIdentity&&Actor.kind!=='discord-user'&&Plan.actor===Actor.displayName?Plan.actor:Actor.id;
}
export const LegacyOperations:OperationDefinition[]=[
  Define('GetActiveServers','guild','read','List exact guild IDs available to this bot.',z.object({}),C=>C.GetActiveServers()),
  Define('GetCapabilities','guild','read','Inspect bot permissions and role hierarchy.',Guild,(C,A)=>C.GetCapabilities(A.guildId),'guild.read'),
  Define('GetServerSnapshot','guild','read','Fetch structural state with completeness metadata.',Guild.extend({includeMembers:z.boolean().default(false)}),(C,A)=>C.GetServerSnapshot(A.guildId,A.includeMembers),'guild.read'),
  Define('GetAllMembers','members','read','Fetch paginated guild members.',Guild,(C,A)=>C.GetAllMembers(A.guildId),'members.inspect'),
  Define('GetAllChannels','channels','read','Fetch channels and optional accessible threads.',Guild.extend({threadScope:z.enum(['none','active','allAccessible']).default('none')}),(C,A)=>C.GetAllChannels(A.guildId,A.threadScope),'guild.read'),
  Define('AdoptResource','structure','write','Bind a key to an exact existing resource ID.',z.object({guildId:Snowflake,kind:z.enum(['role','channel']),key:z.string().min(1),resourceId:Snowflake}),(C,A)=>C.AdoptResource(A.guildId,A.kind,A.key,A.resourceId),'guild.structure.plan'),
  Define('PlanServer','structure','destructive','Plan exact-guild structural changes.',Guild.extend({blueprint:BlueprintSchema,mode:z.enum(['RECONCILE','REPLACE'])}),(C,A,Actor)=>{
    if(A.mode==='REPLACE') C.Assistant.Require(Actor,A.guildId,'guild.structure.replace');
    return C.PlanServer(A.guildId,A.blueprint,A.mode,Actor.id);
  },'guild.structure.plan'),
  Define('PlanResourceMutation','structure','destructive','Plan one exact role or channel mutation.',z.object({guildId:Snowflake,kind:z.enum(['role','channel']),action:z.enum(['create','update','delete']),targetId:Snowflake.optional(),spec:z.union([RoleSpec,ChannelSpec]).optional()}),(C,A,Actor)=>{
    if(A.action==='delete') C.Assistant.Require(Actor,A.guildId,'guild.structure.replace');
    return C.PlanResourceMutation(A.guildId,A.kind,A.action,Actor.id,A.spec,A.targetId);
  },'guild.structure.plan'),
  Define('PlanWipeChannels','structure','destructive','Plan deletion of ordinary channels.',Guild,(C,A,Actor)=>C.PlanServer(A.guildId,{version:1,roles:[],channels:[],policy:{pruneChannels:true,pruneRoles:false}},'RECONCILE',Actor.id),'guild.structure.replace'),
  Define('PlanWipeRoles','structure','destructive','Plan deletion of mutable roles.',Guild,(C,A,Actor)=>C.PlanServer(A.guildId,{version:1,roles:[],channels:[],policy:{pruneChannels:false,pruneRoles:true}},'RECONCILE',Actor.id),'guild.structure.replace'),
  Define('ApplyPlan','structure','destructive','Apply a saved plan as its owner.',PlanId,(C,A,Actor)=>C.ApplyPlan(A.planId,PlanOwner(C,A.planId,Actor))),
  Define('AbandonPlan','structure','write','Abandon an inspected interrupted plan.',PlanId,(C,A,Actor)=>C.AbandonPlan(A.planId,PlanOwner(C,A.planId,Actor))),
  Define('ResolveUncertainAction','structure','write','Release an inspected uncertain action hold.',z.object({actionId:z.string().startsWith('action_')}),async(C,A,Actor)=>{
    const Action=C.Store.GetAction(A.actionId);
    if(Action) C.Assistant.Require(Actor,Action.guild_id,'guild.structure.apply');
    const Owner=Action&&Actor.kind!=='discord-user'&&Action.actor===Actor.displayName?Action.actor:Actor.id;
    await C.ResolveUncertainAction(A.actionId,Owner);return {ok:true};
  }),
  Define('GetUncertainActions','structure','read','List uncertain actions for an exact guild.',Guild,(C,A)=>C.GetUncertainActions(A.guildId),'guild.read'),
  Define('VerifyServer','structure','read','Verify a saved plan against Discord.',PlanId,(C,A,Actor)=>{
    const Plan=C.Store.GetPlan(A.planId);if(Plan) C.Assistant.Require(Actor,Plan.guildId,'guild.read');
    return C.VerifyServer(A.planId);
  }),
  Define('AddMemberRole','members','write','Assign one editable role to a member.',MemberRole,async(C,A,Actor)=>{await C.AddMemberRole(A.guildId,A.userId,A.roleId,Actor.id);return {ok:true};},'roles.assign'),
  Define('RemoveMemberRole','members','write','Remove one editable role from a member.',MemberRole,async(C,A,Actor)=>{await C.RemoveMemberRole(A.guildId,A.userId,A.roleId,Actor.id);return {ok:true};},'roles.assign'),
  Define('KickMember','moderation','destructive','Kick one exact member.',Member,async(C,A,Actor)=>{await C.KickMember(A.guildId,A.userId,Actor.id);return {ok:true};},'moderation.kick'),
  Define('BanMember','moderation','destructive','Ban one exact member.',Member.extend({deleteMessageSeconds:z.number().int().min(0).max(604800).default(0)}),async(C,A,Actor)=>{await C.BanMember(A.guildId,A.userId,Actor.id,A.deleteMessageSeconds);return {ok:true};},'moderation.ban'),
  Define('SetRolePositions','structure','write','Move exact editable role IDs.',Guild.extend({positions:z.array(z.object({roleId:Snowflake,position:z.number().int().min(1)})).min(1)}),async(C,A,Actor)=>{await C.SetRolePositions(A.guildId,A.positions,Actor.id);return {ok:true};},'guild.structure.apply'),
  Define('GetMessage','messages','read','Fetch one exact guild message.',ChannelMessage,(C,A)=>C.Discord.GetMessage(A.guildId,A.channelId,A.messageId),'messages.read'),
  Define('GetRecentMessages','messages','read','Fetch one bounded message page.',Guild.extend({channelId:Snowflake,limit:z.number().int().min(1).max(100).default(50),before:Snowflake.optional()}),(C,A)=>C.Discord.GetRecentMessages(A.guildId,A.channelId,A.limit,A.before),'messages.read'),
  Define('GetAuditEvents','audit','read','Fetch one bounded audit page.',Guild.extend({limit:z.number().int().min(1).max(100).default(50),before:Snowflake.optional()}),(C,A)=>C.Discord.GetAuditEvents(A.guildId,A.limit,A.before),'audit.read'),
  Define('GetRecentActivity','activity','read','Read locally observed gateway activity.',Guild.extend({limit:z.number().int().min(1).max(200).default(100),cursor:Cursor,since:DateTime,until:DateTime}),(C,A,Actor)=>C.Assistant.GetRecentActivity(Actor,A.guildId,A.limit,A.cursor,A.since,A.until),'activity.read'),
  Define('GetOperatorBrief','activity','read','Read a bounded activity and notification brief.',Guild.extend({since:DateTime}),(C,A,Actor)=>C.Assistant.GetOperatorBrief(Actor,A.guildId,A.since),'activity.read'),
  Define('CreateNotification','notifications','write','Create an operator notification.',Guild.extend({severity:z.enum(['info','attention','important','critical']),category:z.string().min(1).max(80),title:z.string().min(1).max(200),details:z.record(z.string(),z.union([z.string().max(256),z.number(),z.boolean()])).default({})}),(C,A,Actor)=>C.Assistant.CreateNotification(Actor,A.guildId,A),'notifications.create'),
  Define('GetNotifications','notifications','read','Read bounded operator notifications.',Guild.extend({limit:z.number().int().min(1).max(100).default(50),cursor:Cursor,unacknowledgedOnly:z.boolean().default(false)}),(C,A,Actor)=>C.Assistant.GetNotifications(Actor,A.guildId,A.limit,A.cursor,A.unacknowledgedOnly),'notifications.read'),
  Define('AcknowledgeNotification','notifications','write','Acknowledge one exact notification.',Guild.extend({notificationId:z.string().startsWith('notification_')}),(C,A,Actor)=>C.Assistant.AcknowledgeNotification(Actor,A.guildId,A.notificationId),'notifications.acknowledge')
];
