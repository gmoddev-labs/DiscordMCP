import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { resolve } from 'node:path';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { localhostHostValidation, localhostOriginValidation, toNodeHandler } from '@modelcontextprotocol/node';
import { DiscordAdapter } from './discord.js';
import { ControlPlane } from './control.js';
import { Store } from './store.js';
import { BuildMcpServer, Calls, Dispatch, type CallName } from './interface.js';

const DiscordToken=process.env.DISCORD_BOT_TOKEN;
if (!DiscordToken) throw new Error('DISCORD_BOT_TOKEN is required');
const Stdio=process.argv.includes('--stdio');
const ApiToken=process.env.CONTROL_API_TOKEN;
if (!Stdio && (!ApiToken||ApiToken.length<24)) throw new Error('CONTROL_API_TOKEN must be at least 24 characters for HTTP mode');
const Actor=process.env.CONTROL_ACTOR??'local-operator';
const DbPath=resolve(process.env.CONTROL_DB_PATH??'./data/control.db');
const StoreValue=new Store(DbPath);
const DiscordValue=new DiscordAdapter(DiscordToken);
await DiscordValue.Start();
const Control=new ControlPlane(DiscordValue,StoreValue);
const Shutdown=()=>{DiscordValue.Stop();StoreValue.Close();};
process.on('SIGINT',Shutdown);
process.on('SIGTERM',Shutdown);

if (Stdio) {
  await serveStdio(()=>BuildMcpServer(Control,Actor));
} else {
  const Host=process.env.CONTROL_HOST??'127.0.0.1';
  if (Host!=='127.0.0.1'&&Host!=='::1') throw new Error('HTTP mode currently supports loopback binding only');
  const Port=Number(process.env.CONTROL_PORT??8787);
  const Handler=createMcpHandler(()=>BuildMcpServer(Control,Actor));
  const McpNode=toNodeHandler(Handler);
  const ValidateHost=localhostHostValidation();
  const ValidateOrigin=localhostOriginValidation();
  const Server=createServer(async (Request,Response)=>{
    try {
      if (!ValidateHost(Request,Response)||!ValidateOrigin(Request,Response)) return;
      if (Request.url==='/health') {Response.writeHead(200,{'Content-Type':'application/json'}).end(JSON.stringify({ok:true}));return;}
      const Header=Request.headers.authorization??'';
      const Supplied=Buffer.from(Header.startsWith('Bearer ')?Header.slice(7):'');
      const Expected=Buffer.from(ApiToken!);
      if (Supplied.length!==Expected.length||!timingSafeEqual(Supplied,Expected)) {
        Response.writeHead(401,{'Content-Type':'application/json'}).end(JSON.stringify({error:'Unauthorized'}));return;
      }
      if (Request.url==='/mcp') {await McpNode(Request,Response);return;}
      if (Request.url==='/v1/call'&&Request.method==='POST') {
        let Body='';
        for await (const Chunk of Request) {
          Body+=Chunk.toString();
          if (Body.length>2_000_000) throw new Error('Request body too large');
        }
        const Parsed=JSON.parse(Body) as {method?:string;params?:unknown};
        if (!Parsed.method||!(Parsed.method in Calls)) throw new Error('Unknown method');
        const Result=await Dispatch(Control,Parsed.method as CallName,Parsed.params??{},Actor);
        Response.writeHead(200,{'Content-Type':'application/json'}).end(JSON.stringify({result:Result}));return;
      }
      Response.writeHead(404).end();
    } catch (Cause) {
      // Server errors stay in the API response/stderr; no Windows popup is opened.
      const Message=Cause instanceof Error?Cause.message:String(Cause);
      process.stderr.write(`[DiscordControl:HTTP] ${Message}\n`);
      if (!Response.headersSent) Response.writeHead(400,{'Content-Type':'application/json'}).end(JSON.stringify({error:Message}));
    }
  });
  Server.listen(Port,Host,()=>process.stderr.write(`[DiscordControl:HTTP] Listening on ${Host}:${Port}\n`));
}
