import {McpServer,ResourceTemplate} from '@modelcontextprotocol/server';
import {z} from 'zod';
import type {ControlPlane} from './control.js';
import type {ActorIdentity} from './assistant-types.js';
import {OperationalError,DescribeError} from './authorization.js';
import {LegacyOperations,type OperationDefinition,type Risk} from './registry.js';
import {DiscordOperations} from './discord-operations.js';
import {CommunityOperations} from './community-operations.js';

const Definitions=[...LegacyOperations,...DiscordOperations,...CommunityOperations];
export const Operations:ReadonlyMap<string,OperationDefinition>=new Map(Definitions.map(Item=>[Item.Name,Item]));
if(Operations.size!==Definitions.length) throw new Error('Duplicate operation name');
export const Calls:Record<string,z.ZodObject<z.ZodRawShape>>=Object.fromEntries(Definitions.map(Item=>[Item.Name,Item.Schema]));
export type CallName=string;

function NormalizeActor(Value:ActorIdentity|string):ActorIdentity {
  return typeof Value==='string'?{id:Value,kind:'local-mcp'}:Value;
}
export async function Dispatch(Control:ControlPlane,Name:CallName,Raw:unknown,ActorValue:ActorIdentity|string):Promise<unknown> {
  const Definition=Operations.get(Name);
  if(!Definition) throw new OperationalError('UNKNOWN_OPERATION','Unknown operation');
  const Args=Definition.Schema.parse(Raw) as Record<string,unknown>;
  const Actor=NormalizeActor(ActorValue);
  if(Name==='GetActiveServers'&&Control.Assistant&&!Control.Assistant.Policy.Decide(Actor,'','guild.read').allowed)
    throw new OperationalError('NOT_AUTHORIZED','Actor is not a configured operator');
  if(typeof Args.guildId==='string'&&Definition.Capability)
    Control.Assistant.Require(Actor,Args.guildId,Definition.Capability);
  Control.Assistant?.RegisterActor(Actor);
  return Definition.Handler(Control,Args,Actor);
}

const SearchSchema=z.object({query:z.string().max(100).optional(),category:z.string().max(60).optional(),limit:z.number().int().min(1).max(20).default(10)});
const InvokeSchema=z.object({tool:z.string().min(1).max(100),args:z.record(z.string(),z.unknown())});
export function SearchTools(Raw:unknown):{items:unknown[];total:number} {
  const Args=SearchSchema.parse(Raw);
  const Query=(Args.query??'').trim().toLowerCase();
  const Tokens=Query.split(/\s+/).filter(Boolean);
  const Items=[...Operations.values()].filter(Item=>Item.Progressive&&(!Args.category||Item.Category===Args.category))
    .map(Item=>{
      const Name=Item.Name.toLowerCase();
      const Text=`${Item.Category} ${Item.Description}`.toLowerCase();
      const Score=!Query?1:Name===Query?100:Name.startsWith(Query)?50:Tokens.reduce((Total,Token)=>Total+(Name.includes(Token)?10:Text.includes(Token)?2:0),0);
      return {Item,Score};
    }).filter(Value=>Value.Score>0).sort((A,B)=>B.Score-A.Score||A.Item.Name.localeCompare(B.Item.Name));
  return {total:Items.length,items:Items.slice(0,Args.limit).map(({Item})=>({
    name:Item.Name,category:Item.Category,risk:Item.Risk,summary:Item.Description,
    ...(Query===Item.Name.toLowerCase()?{inputSchema:z.toJSONSchema(Item.Schema)}:{})
  }))};
}
export async function InvokeTool(Control:ControlPlane,RiskValue:Risk,Raw:unknown,Actor:ActorIdentity|string):Promise<unknown> {
  const Args=InvokeSchema.parse(Raw);
  const Definition=Operations.get(Args.tool);
  if(!Definition||!Definition.Progressive) throw new OperationalError('UNKNOWN_OPERATION','Unknown operation');
  if(Definition.Risk!==RiskValue) throw new OperationalError('RISK_MISMATCH','Operation must use its matching risk dispatcher');
  return Dispatch(Control,Definition.Name,Args.args,Actor);
}

export function BuildMcpServer(Control:ControlPlane,Actor:ActorIdentity|string):McpServer {
  const Mode=process.env.CONTROL_MCP_SURFACE??'full';
  if(Mode!=='full'&&Mode!=='progressive') throw new Error('CONTROL_MCP_SURFACE must be full or progressive');
  const Server=new McpServer({name:'discord-control-plane',version:'0.1.0'});
  function Register(Name:string,Description:string,Schema:z.ZodObject<z.ZodRawShape>,Run:(Args:unknown)=>Promise<unknown>|unknown):void {
    Server.registerTool(Name,{description:Description,inputSchema:Schema},async Args=>{
      try{return {content:[{type:'text' as const,text:JSON.stringify(await Run(Args))}]};}
      catch(Cause){return {isError:true,content:[{type:'text' as const,text:JSON.stringify(DescribeError(Cause))}]};}
    });
  }
  const ProgressiveNames=new Set(['PlanServer','PlanResourceMutation','ApplyPlan','VerifyServer']);
  for(const Item of Operations.values()) {
    if(Mode==='progressive'&&!ProgressiveNames.has(Item.Name)) continue;
    Register(Item.Name,Item.Description,Item.Schema,Args=>Dispatch(Control,Item.Name,Args,Actor));
  }
  Register('SearchTools','Search or browse the internal Discord operation catalog.',SearchSchema,Args=>{
    const Identity=NormalizeActor(Actor);
    if(!Control.Assistant.Policy.Decide(Identity,'','guild.read').allowed) throw new OperationalError('NOT_AUTHORIZED','Actor is not a configured operator');
    return SearchTools(Args);
  });
  for(const RiskValue of ['read','write','destructive'] as const) {
    const Name=RiskValue==='read'?'ReadTool':RiskValue==='write'?'WriteTool':'DestructiveTool';
    Register(Name,`Invoke one ${RiskValue} Discord operation found through SearchTools.`,InvokeSchema,
      Args=>InvokeTool(Control,RiskValue,Args,Actor));
  }
  Server.registerResource('discord-guilds','discord://guilds',{title:'Discord guilds',mimeType:'application/json'},async Uri=>({
    contents:[{uri:Uri.href,mimeType:'application/json',text:JSON.stringify(await Dispatch(Control,'GetActiveServers',{},Actor))}]
  }));
  Server.registerResource('discord-activity',new ResourceTemplate('discord://guild/{guildId}/activity',{list:undefined}),
    {title:'Recent observed Discord activity',mimeType:'application/json'},async(Uri,Variables)=>({
      contents:[{uri:Uri.href,mimeType:'application/json',text:JSON.stringify(await Dispatch(Control,'GetRecentActivity',{guildId:String(Variables.guildId),limit:100},Actor))}]
    }));
  Server.registerResource('discord-notifications',new ResourceTemplate('discord://guild/{guildId}/notifications',{list:undefined}),
    {title:'Discord operator notifications',mimeType:'application/json'},async(Uri,Variables)=>({
      contents:[{uri:Uri.href,mimeType:'application/json',text:JSON.stringify(await Dispatch(Control,'GetNotifications',{guildId:String(Variables.guildId),limit:50},Actor))}]
    }));
  return Server;
}
