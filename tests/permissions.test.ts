import {test} from 'node:test';
import assert from 'node:assert/strict';
import {ChannelType,PermissionFlagsBits} from 'discord.js';
import {AuditRoles,EvaluatePermissions} from '../src/permissions.js';
import type {PermissionEvidence} from '../src/permissions.js';

const GuildId='123456789012345678';
const UserId='123456789012345679';
const RoleA='123456789012345680';
const RoleB='123456789012345681';
const ChannelId='123456789012345682';
const ParentId='123456789012345683';
const Bit=(...Names:(keyof typeof PermissionFlagsBits)[])=>Names.reduce((Result,Name)=>Result|PermissionFlagsBits[Name],0n).toString();
function Evidence():PermissionEvidence {
  return {guild:{id:GuildId,name:'Guild',owner_id:'123456789012345699'},roles:[
    {id:GuildId,name:'@everyone',permissions:Bit('ViewChannel'),position:0,managed:false},
    {id:RoleA,name:'A',permissions:Bit('SendMessages'),position:3,managed:false},
    {id:RoleB,name:'B',permissions:Bit('ManageMessages'),position:4,managed:false}
  ],member:{user:{id:UserId,username:'member'},roles:[RoleA,RoleB]},
  channel:{id:ChannelId,guild_id:GuildId,name:'text',type:ChannelType.GuildText,permission_overwrites:[]},
  botHighestRolePosition:5};
}
test('guild roles union; everyone, role, and member overwrites apply in documented order',()=>{
  const E=Evidence();
  const Base=EvaluatePermissions(E);
  assert.ok(Base.allowedPermissions.includes('ViewChannel'));
  assert.ok(Base.allowedPermissions.includes('SendMessages'));
  assert.ok(Base.allowedPermissions.includes('ManageMessages'));
  assert.equal(Base.hierarchy.botCanManageMember,true);
  E.channel!.permission_overwrites=[
    {id:GuildId,type:0,allow:'0',deny:Bit('ViewChannel')},
    {id:RoleA,type:0,allow:'0',deny:Bit('SendMessages')},
    {id:RoleB,type:0,allow:Bit('SendMessages'),deny:'0'},
    {id:UserId,type:1,allow:Bit('ViewChannel'),deny:Bit('ManageMessages')}
  ];
  const Result=EvaluatePermissions(E);
  assert.ok(Result.allowedPermissions.includes('ViewChannel'));
  assert.ok(Result.allowedPermissions.includes('SendMessages'));
  assert.ok(Result.deniedPermissions.includes('ManageMessages'));
});
test('administrator and guild owner bypass overwrites; unknown bits survive',()=>{
  const E=Evidence();
  E.channel!.permission_overwrites=[{id:GuildId,type:0,allow:'0',deny:Bit('ViewChannel')}];
  E.roles[1]!.permissions=(PermissionFlagsBits.Administrator|(1n<<62n)).toString();
  const Admin=EvaluatePermissions(E);
  assert.equal(Admin.administrator,true);
  assert.ok(Admin.allowedPermissions.includes('ViewChannel'));
  assert.notEqual(Admin.unknownPermissionBits,'0');
  E.roles[1]!.permissions='0';
  E.guild.owner_id=UserId;
  assert.equal(EvaluatePermissions(E).guildOwner,true);
});
test('threads use parent overwrites and flag private membership uncertainty',()=>{
  const E=Evidence();
  E.channel={id:ChannelId,guild_id:GuildId,name:'private',type:ChannelType.PrivateThread,parent_id:ParentId};
  E.source={id:ParentId,guild_id:GuildId,name:'parent',type:ChannelType.GuildText,
    permission_overwrites:[{id:GuildId,type:0,allow:Bit('SendMessagesInThreads'),deny:'0'}]};
  const Result=EvaluatePermissions(E);
  assert.equal(Result.permissionSourceChannelId,ParentId);
  assert.ok(Result.allowedPermissions.includes('SendMessagesInThreads'));
  assert.ok(Result.deniedPermissions.includes('SendMessages'));
  assert.equal(Result.confidence,'partial');
  const Audit=AuditRoles(E.guild,E.roles,E.channel,E.source,5);
  assert.equal(Audit.roles[0]?.actions.view,null);
  const MissingParent=AuditRoles(E.guild,E.roles,E.channel,undefined,5,['send']);
  assert.deepEqual(MissingParent.roles[0]?.actions,{send:null});
  assert.equal(MissingParent.confidence,'partial');
});
