import { McpServer, ResourceTemplate } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { BlueprintSchema, ChannelSpec, RoleSpec, Snowflake } from './types.js';
import { ControlPlane } from './control.js';
import type {ActorIdentity,Capability} from './assistant-types.js';
import {OperationalError,DescribeError} from './authorization.js';

const PlanInput=z.object({guildId:Snowflake,blueprint:BlueprintSchema,mode:z.enum(['RECONCILE','REPLACE'])});
const GuildInput=z.object({guildId:Snowflake});
const MemberRoleInput=z.object({guildId:Snowflake,userId:Snowflake,roleId:Snowflake});
const MemberInput=z.object({guildId:Snowflake,userId:Snowflake});
const Cursor=z.string().regex(/^\d{1,16}$/).optional();
const DateTime=z.string().datetime({offset:true}).optional();
const EventQuery=GuildInput.extend({limit:z.number().int().min(1).max(200).default(100),cursor:Cursor,since:DateTime,until:DateTime});
export const Calls = {
  GetActiveServers:z.object({}),
  GetCapabilities:GuildInput,
  GetServerSnapshot:GuildInput.extend({includeMembers:z.boolean().default(false)}),
  GetAllMembers:GuildInput,
  GetAllChannels:GuildInput.extend({threadScope:z.enum(['none','active','allAccessible']).default('none')}),
  AdoptResource:z.object({guildId:Snowflake,kind:z.enum(['role','channel']),key:z.string().min(1),resourceId:Snowflake}),
  PlanServer:PlanInput,
  PlanResourceMutation:z.object({guildId:Snowflake,kind:z.enum(['role','channel']),action:z.enum(['create','update','delete']),
    targetId:Snowflake.optional(),spec:z.union([RoleSpec,ChannelSpec]).optional()}),
  PlanWipeChannels:GuildInput,
  PlanWipeRoles:GuildInput,
  ApplyPlan:z.object({planId:z.string().startsWith('plan_')}),
  AbandonPlan:z.object({planId:z.string().startsWith('plan_')}),
  ResolveUncertainAction:z.object({actionId:z.string().startsWith('action_')}),
  GetUncertainActions:GuildInput,
  VerifyServer:z.object({planId:z.string().startsWith('plan_')}),
  AddMemberRole:MemberRoleInput,
  RemoveMemberRole:MemberRoleInput,
  KickMember:MemberInput,
  BanMember:MemberInput.extend({deleteMessageSeconds:z.number().int().min(0).max(604800).default(0)}),
  SetRolePositions:GuildInput.extend({positions:z.array(z.object({roleId:Snowflake,position:z.number().int().min(1)})).min(1)}),
  GetMessage:GuildInput.extend({channelId:Snowflake,messageId:Snowflake}),
  GetRecentMessages:GuildInput.extend({channelId:Snowflake,limit:z.number().int().min(1).max(100).default(50),before:Snowflake.optional()}),
  GetAuditEvents:GuildInput.extend({limit:z.number().int().min(1).max(100).default(50),before:Snowflake.optional()}),
  GetRecentActivity:EventQuery,
  GetOperatorBrief:GuildInput.extend({since:DateTime}),
  CreateNotification:GuildInput.extend({severity:z.enum(['info','attention','important','critical']),category:z.string().min(1).max(80),
    title:z.string().min(1).max(200),details:z.record(z.string(),z.union([z.string().max(256),z.number(),z.boolean()])).default({})}),
  GetNotifications:GuildInput.extend({limit:z.number().int().min(1).max(100).default(50),cursor:Cursor,unacknowledgedOnly:z.boolean().default(false)}),
  AcknowledgeNotification:GuildInput.extend({notificationId:z.string().startsWith('notification_')})
} as const;
export type CallName=keyof typeof Calls;

const Capabilities:Partial<Record<CallName,Capability>>={
  GetCapabilities:'guild.read',GetServerSnapshot:'guild.read',GetAllMembers:'members.inspect',GetAllChannels:'guild.read',
  AdoptResource:'guild.structure.plan',PlanServer:'guild.structure.plan',PlanResourceMutation:'guild.structure.plan',
  PlanWipeChannels:'guild.structure.replace',PlanWipeRoles:'guild.structure.replace',ApplyPlan:'guild.structure.apply',
  AbandonPlan:'guild.structure.apply',ResolveUncertainAction:'guild.structure.apply',GetUncertainActions:'guild.read',
  VerifyServer:'guild.read',AddMemberRole:'roles.assign',RemoveMemberRole:'roles.assign',KickMember:'moderation.kick',
  BanMember:'moderation.ban',SetRolePositions:'guild.structure.apply',GetMessage:'messages.read',
  GetRecentMessages:'messages.read',GetAuditEvents:'audit.read',GetRecentActivity:'activity.read',
  GetOperatorBrief:'activity.read',CreateNotification:'notifications.create',GetNotifications:'notifications.read',
  AcknowledgeNotification:'notifications.acknowledge'
};
export async function Dispatch(Control:ControlPlane,Name:CallName,Raw:unknown,ActorValue:ActorIdentity|string):Promise<unknown> {
  const Actor:ActorIdentity=typeof ActorValue==='string'?{id:ActorValue,kind:'local-mcp'}:ActorValue;
  if (Name==='GetActiveServers'&&Control.Assistant&&!Control.Assistant.Policy.Decide(Actor,'','guild.read').allowed)
    throw new OperationalError('NOT_AUTHORIZED','Actor is not a configured operator');
  const GuildId=(Raw&&typeof Raw==='object'&&'guildId' in Raw)?String(Raw.guildId):undefined;
  if (GuildId&&Capabilities[Name]) Control.Assistant.Require(Actor,GuildId,Capabilities[Name]);
  if (Name==='VerifyServer'&&Raw&&typeof Raw==='object'&&'planId' in Raw) {
    const Plan=Control.Store.GetPlan(String(Raw.planId));
    if (Plan) Control.Assistant.Require(Actor,Plan.guildId,'guild.read');
  }
  Control.Assistant?.RegisterActor(Actor);
  const ActorId=Actor.id;
  switch(Name) {
    case 'GetActiveServers': return Control.GetActiveServers();
    case 'GetCapabilities': {const A=Calls.GetCapabilities.parse(Raw);return Control.GetCapabilities(A.guildId);}
    case 'GetServerSnapshot': {const A=Calls.GetServerSnapshot.parse(Raw);return Control.GetServerSnapshot(A.guildId,A.includeMembers);}
    case 'GetAllMembers': {const A=Calls.GetAllMembers.parse(Raw);return Control.GetAllMembers(A.guildId);}
    case 'GetAllChannels': {const A=Calls.GetAllChannels.parse(Raw);return Control.GetAllChannels(A.guildId,A.threadScope);}
    case 'AdoptResource': {const A=Calls.AdoptResource.parse(Raw);return Control.AdoptResource(A.guildId,A.kind,A.key,A.resourceId);}
    case 'PlanServer': {const A=Calls.PlanServer.parse(Raw);if (A.mode==='REPLACE') Control.Assistant.Require(Actor,A.guildId,'guild.structure.replace');return Control.PlanServer(A.guildId,A.blueprint,A.mode,ActorId);}
    case 'PlanResourceMutation': {const A=Calls.PlanResourceMutation.parse(Raw);if (A.action==='delete') Control.Assistant.Require(Actor,A.guildId,'guild.structure.replace');return Control.PlanResourceMutation(A.guildId,A.kind,A.action,ActorId,A.spec,A.targetId);}
    case 'PlanWipeChannels': {const A=Calls.PlanWipeChannels.parse(Raw);return Control.PlanServer(A.guildId,{version:1,roles:[],channels:[],policy:{pruneChannels:true,pruneRoles:false}},'RECONCILE',ActorId);}
    case 'PlanWipeRoles': {const A=Calls.PlanWipeRoles.parse(Raw);return Control.PlanServer(A.guildId,{version:1,roles:[],channels:[],policy:{pruneChannels:false,pruneRoles:true}},'RECONCILE',ActorId);}
    case 'ApplyPlan': {const A=Calls.ApplyPlan.parse(Raw);const Plan=Control.Store.GetPlan(A.planId);
      if (Plan) Control.Assistant.Require(Actor,Plan.guildId,'guild.structure.apply');
      const Owner=Plan&&!Plan.actorIdentity&&Actor.kind!=='discord-user'&&Plan.actor===Actor.displayName?Plan.actor:ActorId;
      return Control.ApplyPlan(A.planId,Owner);}
    case 'AbandonPlan': {const A=Calls.AbandonPlan.parse(Raw);const Plan=Control.Store.GetPlan(A.planId);
      if (Plan) Control.Assistant.Require(Actor,Plan.guildId,'guild.structure.apply');
      const Owner=Plan&&!Plan.actorIdentity&&Actor.kind!=='discord-user'&&Plan.actor===Actor.displayName?Plan.actor:ActorId;
      return Control.AbandonPlan(A.planId,Owner);}
    case 'ResolveUncertainAction': {const A=Calls.ResolveUncertainAction.parse(Raw);const Action=Control.Store.GetAction(A.actionId);
      if (Action) Control.Assistant.Require(Actor,Action.guild_id,'guild.structure.apply');
      const Owner=Action&&Actor.kind!=='discord-user'&&Action.actor===Actor.displayName?Action.actor:ActorId;
      await Control.ResolveUncertainAction(A.actionId,Owner);return {ok:true};}
    case 'GetUncertainActions': {const A=Calls.GetUncertainActions.parse(Raw);return Control.GetUncertainActions(A.guildId);}
    case 'VerifyServer': {const A=Calls.VerifyServer.parse(Raw);return Control.VerifyServer(A.planId);}
    case 'AddMemberRole': {const A=Calls.AddMemberRole.parse(Raw);await Control.AddMemberRole(A.guildId,A.userId,A.roleId,ActorId);return {ok:true};}
    case 'RemoveMemberRole': {const A=Calls.RemoveMemberRole.parse(Raw);await Control.RemoveMemberRole(A.guildId,A.userId,A.roleId,ActorId);return {ok:true};}
    case 'KickMember': {const A=Calls.KickMember.parse(Raw);await Control.KickMember(A.guildId,A.userId,ActorId);return {ok:true};}
    case 'BanMember': {const A=Calls.BanMember.parse(Raw);await Control.BanMember(A.guildId,A.userId,ActorId,A.deleteMessageSeconds);return {ok:true};}
    case 'SetRolePositions': {const A=Calls.SetRolePositions.parse(Raw);await Control.SetRolePositions(A.guildId,A.positions,ActorId);return {ok:true};}
    case 'GetMessage': {const A=Calls.GetMessage.parse(Raw);return Control.Discord.GetMessage(A.guildId,A.channelId,A.messageId);}
    case 'GetRecentMessages': {const A=Calls.GetRecentMessages.parse(Raw);return Control.Discord.GetRecentMessages(A.guildId,A.channelId,A.limit,A.before);}
    case 'GetAuditEvents': {const A=Calls.GetAuditEvents.parse(Raw);return Control.Discord.GetAuditEvents(A.guildId,A.limit,A.before);}
    case 'GetRecentActivity': {const A=Calls.GetRecentActivity.parse(Raw);return Control.Assistant.GetRecentActivity(Actor,A.guildId,A.limit,A.cursor,A.since,A.until);}
    case 'GetOperatorBrief': {const A=Calls.GetOperatorBrief.parse(Raw);return Control.Assistant.GetOperatorBrief(Actor,A.guildId,A.since);}
    case 'CreateNotification': {const A=Calls.CreateNotification.parse(Raw);return Control.Assistant.CreateNotification(Actor,A.guildId,A);}
    case 'GetNotifications': {const A=Calls.GetNotifications.parse(Raw);return Control.Assistant.GetNotifications(Actor,A.guildId,A.limit,A.cursor,A.unacknowledgedOnly);}
    case 'AcknowledgeNotification': {const A=Calls.AcknowledgeNotification.parse(Raw);return Control.Assistant.AcknowledgeNotification(Actor,A.guildId,A.notificationId);}
  }
}

export function BuildMcpServer(Control:ControlPlane,Actor:ActorIdentity|string):McpServer {
  const Server=new McpServer({name:'discord-control-plane',version:'0.1.0'});
  function Register<Name extends CallName>(Name:Name,Description:string,Schema:typeof Calls[Name]) {
    Server.registerTool(Name,{description:Description,inputSchema:Schema as z.ZodObject<z.ZodRawShape>},async (ArgumentsValue:unknown)=>{
      try {
        const Result=await Dispatch(Control,Name,ArgumentsValue,Actor);
        return {content:[{type:'text' as const,text:JSON.stringify(Result)}]};
      } catch (Cause) {
        const ErrorValue=DescribeError(Cause);
        return {isError:true,content:[{type:'text' as const,text:JSON.stringify(ErrorValue)}]};
      }
    });
  }
  Register('GetActiveServers','List exact guild IDs available to this bot.',Calls.GetActiveServers);
  Register('GetCapabilities','Inspect bot permissions and role hierarchy for a guild.',Calls.GetCapabilities);
  Register('GetServerSnapshot','Fetch sanitized structural state and explicit completeness metadata.',Calls.GetServerSnapshot);
  Register('GetAllMembers','Fetch guild members using pagination; requires GUILD_MEMBERS intent.',Calls.GetAllMembers);
  Register('GetAllChannels','Fetch guild channels with optional active or accessible archived threads and completeness metadata.',Calls.GetAllChannels);
  Register('AdoptResource','Bind a semantic blueprint key to an exact existing resource ID.',Calls.AdoptResource);
  Register('PlanServer','Create a persisted deterministic structural plan for an exact guild.',Calls.PlanServer);
  Register('PlanResourceMutation','Plan one exact role/channel create, update, or delete.',Calls.PlanResourceMutation);
  Register('PlanWipeChannels','Plan deletion of all accessible ordinary channels in an exact guild.',Calls.PlanWipeChannels);
  Register('PlanWipeRoles','Plan deletion of all mutable roles in an exact guild.',Calls.PlanWipeRoles);
  Register('ApplyPlan','Execute a persisted plan bound to the same authenticated actor.',Calls.ApplyPlan);
  Register('AbandonPlan','After inspecting an interrupted plan, mark it terminal so a fresh plan can be created.',Calls.AbandonPlan);
  Register('ResolveUncertainAction','After inspecting an uncertain direct action, clear its guild mutation hold.',Calls.ResolveUncertainAction);
  Register('GetUncertainActions','List unresolved direct actions for an exact guild.',Calls.GetUncertainActions);
  Register('VerifyServer','Fetch final state and compare blueprint resources.',Calls.VerifyServer);
  Register('AddMemberRole','Assign one editable role to an exact member.',Calls.AddMemberRole);
  Register('RemoveMemberRole','Remove one editable role from an exact member.',Calls.RemoveMemberRole);
  Register('KickMember','Kick one exact member from an exact guild.',Calls.KickMember);
  Register('BanMember','Ban one exact member from an exact guild.',Calls.BanMember);
  Register('SetRolePositions','Reorder exact editable role IDs below the bot role.',Calls.SetRolePositions);
  Register('GetMessage','Fetch one exact message from an exact guild channel.',Calls.GetMessage);
  Register('GetRecentMessages','Fetch one bounded page of recent messages from an exact channel.',Calls.GetRecentMessages);
  Register('GetAuditEvents','Fetch one bounded page of Discord audit events.',Calls.GetAuditEvents);
  Register('GetRecentActivity','Read bounded locally observed gateway activity.',Calls.GetRecentActivity);
  Register('GetOperatorBrief','Read a structured activity and notification brief.',Calls.GetOperatorBrief);
  Register('CreateNotification','Create a persistent operator notification.',Calls.CreateNotification);
  Register('GetNotifications','Read a bounded page of operator notifications.',Calls.GetNotifications);
  Register('AcknowledgeNotification','Acknowledge one exact operator notification.',Calls.AcknowledgeNotification);
  Server.registerResource('discord-guilds','discord://guilds',{title:'Discord guilds',mimeType:'application/json'},async Uri=>({
    contents:[{uri:Uri.href,mimeType:'application/json',text:JSON.stringify(await Dispatch(Control,'GetActiveServers',{},Actor))}]
  }));
  Server.registerResource('discord-activity',new ResourceTemplate('discord://guild/{guildId}/activity',{list:undefined}),
    {title:'Recent observed Discord activity',mimeType:'application/json'},async (Uri,Variables)=>({
      contents:[{uri:Uri.href,mimeType:'application/json',text:JSON.stringify(await Dispatch(Control,'GetRecentActivity',
        {guildId:String(Variables.guildId),limit:100},Actor))}]
    }));
  Server.registerResource('discord-notifications',new ResourceTemplate('discord://guild/{guildId}/notifications',{list:undefined}),
    {title:'Discord operator notifications',mimeType:'application/json'},async (Uri,Variables)=>({
      contents:[{uri:Uri.href,mimeType:'application/json',text:JSON.stringify(await Dispatch(Control,'GetNotifications',
        {guildId:String(Variables.guildId),limit:50},Actor))}]
    }));
  return Server;
}
