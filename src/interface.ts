import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { BlueprintSchema, ChannelSpec, RoleSpec, Snowflake } from './types.js';
import { ControlPlane } from './control.js';

const PlanInput=z.object({guildId:Snowflake,blueprint:BlueprintSchema,mode:z.enum(['RECONCILE','REPLACE'])});
const GuildInput=z.object({guildId:Snowflake});
const MemberRoleInput=z.object({guildId:Snowflake,userId:Snowflake,roleId:Snowflake});
const MemberInput=z.object({guildId:Snowflake,userId:Snowflake});
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
  SetRolePositions:GuildInput.extend({positions:z.array(z.object({roleId:Snowflake,position:z.number().int().min(1)})).min(1)})
} as const;
export type CallName=keyof typeof Calls;

export async function Dispatch(Control:ControlPlane,Name:CallName,Raw:unknown,Actor:string):Promise<unknown> {
  switch(Name) {
    case 'GetActiveServers': return Control.GetActiveServers();
    case 'GetCapabilities': {const A=Calls.GetCapabilities.parse(Raw);return Control.GetCapabilities(A.guildId);}
    case 'GetServerSnapshot': {const A=Calls.GetServerSnapshot.parse(Raw);return Control.GetServerSnapshot(A.guildId,A.includeMembers);}
    case 'GetAllMembers': {const A=Calls.GetAllMembers.parse(Raw);return Control.GetAllMembers(A.guildId);}
    case 'GetAllChannels': {const A=Calls.GetAllChannels.parse(Raw);return Control.GetAllChannels(A.guildId,A.threadScope);}
    case 'AdoptResource': {const A=Calls.AdoptResource.parse(Raw);return Control.AdoptResource(A.guildId,A.kind,A.key,A.resourceId);}
    case 'PlanServer': {const A=Calls.PlanServer.parse(Raw);return Control.PlanServer(A.guildId,A.blueprint,A.mode,Actor);}
    case 'PlanResourceMutation': {const A=Calls.PlanResourceMutation.parse(Raw);return Control.PlanResourceMutation(A.guildId,A.kind,A.action,Actor,A.spec,A.targetId);}
    case 'PlanWipeChannels': {const A=Calls.PlanWipeChannels.parse(Raw);return Control.PlanServer(A.guildId,{version:1,roles:[],channels:[],policy:{pruneChannels:true,pruneRoles:false}},'RECONCILE',Actor);}
    case 'PlanWipeRoles': {const A=Calls.PlanWipeRoles.parse(Raw);return Control.PlanServer(A.guildId,{version:1,roles:[],channels:[],policy:{pruneChannels:false,pruneRoles:true}},'RECONCILE',Actor);}
    case 'ApplyPlan': {const A=Calls.ApplyPlan.parse(Raw);return Control.ApplyPlan(A.planId,Actor);}
    case 'AbandonPlan': {const A=Calls.AbandonPlan.parse(Raw);return Control.AbandonPlan(A.planId,Actor);}
    case 'ResolveUncertainAction': {const A=Calls.ResolveUncertainAction.parse(Raw);await Control.ResolveUncertainAction(A.actionId,Actor);return {ok:true};}
    case 'GetUncertainActions': {const A=Calls.GetUncertainActions.parse(Raw);return Control.GetUncertainActions(A.guildId);}
    case 'VerifyServer': {const A=Calls.VerifyServer.parse(Raw);return Control.VerifyServer(A.planId);}
    case 'AddMemberRole': {const A=Calls.AddMemberRole.parse(Raw);await Control.AddMemberRole(A.guildId,A.userId,A.roleId,Actor);return {ok:true};}
    case 'RemoveMemberRole': {const A=Calls.RemoveMemberRole.parse(Raw);await Control.RemoveMemberRole(A.guildId,A.userId,A.roleId,Actor);return {ok:true};}
    case 'KickMember': {const A=Calls.KickMember.parse(Raw);await Control.KickMember(A.guildId,A.userId,Actor);return {ok:true};}
    case 'BanMember': {const A=Calls.BanMember.parse(Raw);await Control.BanMember(A.guildId,A.userId,Actor,A.deleteMessageSeconds);return {ok:true};}
    case 'SetRolePositions': {const A=Calls.SetRolePositions.parse(Raw);await Control.SetRolePositions(A.guildId,A.positions,Actor);return {ok:true};}
  }
}

export function BuildMcpServer(Control:ControlPlane,Actor:string):McpServer {
  const Server=new McpServer({name:'discord-control-plane',version:'0.1.0'});
  function Register<Name extends CallName>(Name:Name,Description:string,Schema:typeof Calls[Name]) {
    Server.registerTool(Name,{description:Description,inputSchema:Schema as z.ZodObject<z.ZodRawShape>},async (ArgumentsValue:unknown)=>{
      try {
        const Result=await Dispatch(Control,Name,ArgumentsValue,Actor);
        return {content:[{type:'text' as const,text:JSON.stringify(Result)}]};
      } catch (Cause) {
        return {isError:true,content:[{type:'text' as const,text:Cause instanceof Error?Cause.message:String(Cause)}]};
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
  return Server;
}
