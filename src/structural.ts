import { ChannelType, PermissionFlagsBits } from 'discord.js';
import { createHash } from 'node:crypto';
import type { Channel, Role } from './types.js';
import type { DiscordChannel, DiscordRole } from './discord.js';

export const ChannelTypes:Record<Channel['type'],number> = {
  category:ChannelType.GuildCategory,text:ChannelType.GuildText,voice:ChannelType.GuildVoice,
  forum:ChannelType.GuildForum,announcement:ChannelType.GuildAnnouncement,
  stage:ChannelType.GuildStageVoice,media:ChannelType.GuildMedia
};
export function Hash(Value:unknown):string {return createHash('sha256').update(JSON.stringify(Value)).digest('hex');}
export function Bits(Names:string[]):string {
  let Result=0n;
  for (const Name of Names) {
    const Key=Name.toLowerCase().split('_').map((Part,Index)=>Index?Part[0]?.toUpperCase()+Part.slice(1):Part).join('');
    const Actual=Key[0]?.toUpperCase()+Key.slice(1);
    const Bit=(PermissionFlagsBits as Record<string,bigint>)[Actual];
    if (Bit===undefined) throw new Error(`Unknown permission ${Name}`);
    Result|=Bit;
  }
  return Result.toString();
}
export function CanonicalOverwrites(Items:DiscordChannel['permission_overwrites'] = []) {
  return (Items??[]).map(Item=>({id:Item.id,type:Item.type,allow:String(BigInt(Item.allow)),deny:String(BigInt(Item.deny))}))
    .sort((A,B)=>A.id.localeCompare(B.id)||A.type-B.type);
}
export function RoleState(Item:DiscordRole) {
  return {name:Item.name,permissions:String(BigInt(Item.permissions)),hoist:Item.hoist??false,
    mentionable:Item.mentionable??false,color:Item.color??0};
}
export function DesiredRole(Spec:Role) {
  return {name:Spec.name,permissions:Bits(Spec.permissions),hoist:Spec.hoist??false,
    mentionable:Spec.mentionable??false,color:Spec.color??0};
}
export function ChannelState(Item:DiscordChannel) {
  return {name:Item.name,type:Item.type,parent_id:Item.parent_id??null,
    topic:Item.topic??null,nsfw:Item.nsfw??false,
    permission_overwrites:CanonicalOverwrites(Item.permission_overwrites)};
}
export function DesiredChannel(Spec:Channel,GuildId:string,RoleIds:Record<string,string>,ChannelIds:Record<string,string>) {
  const Parent=Spec.parent?ChannelIds[Spec.parent]:undefined;
  if (Spec.parent&&!Parent) throw new Error(`Category ${Spec.parent} is not mapped`);
  const Overwrites=Spec.overwrites.map(Entry=>{
    const Id=Entry.target==='@everyone'?GuildId:RoleIds[Entry.target];
    if (!Id) throw new Error(`Role ${Entry.target} is not mapped`);
    return {id:Id,type:0,allow:Bits(Entry.allow),deny:Bits(Entry.deny)};
  });
  return {name:Spec.name,type:ChannelTypes[Spec.type],parent_id:Parent??null,
    topic:Spec.topic??null,nsfw:Spec.nsfw??false,
    permission_overwrites:CanonicalOverwrites(Overwrites)};
}
export function Structural(Item:DiscordRole|DiscordChannel|undefined,Kind:'role'|'channel'):string {
  if (!Item) return Hash(null);
  return Hash(Kind==='role'?RoleState(Item as DiscordRole):ChannelState(Item as DiscordChannel));
}
export function SetHash(Ids:string[]):string {return Hash([...Ids].sort());}
