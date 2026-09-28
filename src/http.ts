import { createServer, type Server } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { localhostHostValidation, localhostOriginValidation, toNodeHandler } from '@modelcontextprotocol/node';
import { BuildMcpServer, Calls, Dispatch, type CallName } from './interface.js';
import type { ControlPlane } from './control.js';

export function CreateHttpServer(Control:ControlPlane,ApiToken:string,Actor:string):{server:Server;close:()=>Promise<void>} {
  if (ApiToken.length<24) throw new Error('CONTROL_API_TOKEN must be at least 24 characters');
  const Handler=createMcpHandler(()=>BuildMcpServer(Control,Actor));
  const McpNode=toNodeHandler(Handler);
  const ValidateHost=localhostHostValidation();
  const ValidateOrigin=localhostOriginValidation();
  const ServerValue=createServer(async (Request,Response)=>{
    try {
      if (!ValidateHost(Request,Response)||!ValidateOrigin(Request,Response)) return;
      if (Request.url==='/health') {Response.writeHead(200,{'Content-Type':'application/json'}).end(JSON.stringify({ok:true}));return;}
      const Header=Request.headers.authorization??'';
      const Supplied=Buffer.from(Header.startsWith('Bearer ')?Header.slice(7):'');
      const Expected=Buffer.from(ApiToken);
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
      const Message=Cause instanceof Error?Cause.message:String(Cause);
      process.stderr.write(`[DiscordControl:HTTP] ${Message}\n`);
      if (!Response.headersSent) Response.writeHead(400,{'Content-Type':'application/json'}).end(JSON.stringify({error:Message}));
    }
  });
  return {server:ServerValue,close:async()=>{
    await new Promise<void>(Resolve=>{
      ServerValue.close(()=>Resolve());
      ServerValue.closeAllConnections();
    });
    await Handler.close();
  }};
}
