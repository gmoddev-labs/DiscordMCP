import { test } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { CreateHttpServer } from '../src/http.js';
import type { ControlPlane } from '../src/control.js';

const Token='0123456789abcdef0123456789abcdef';
test('HTTP rejects unauthenticated and invalid origin/host requests, bounds bodies, and closes',async()=>{
  const Control={GetActiveServers:()=>[]} as unknown as ControlPlane;
  const App=CreateHttpServer(Control,Token,'tester');
  await new Promise<void>(Resolve=>App.server.listen(0,'127.0.0.1',Resolve));
  const Address=App.server.address();
  if (!Address||typeof Address==='string') throw new Error('Expected TCP address');
  const Url=`http://127.0.0.1:${Address.port}`;
  try {
    const Unauthorized=await fetch(`${Url}/v1/call`,{method:'POST',body:'{"method":"GetActiveServers"}'});
    assert.equal(Unauthorized.status,401);
    const Valid=await fetch(`${Url}/v1/call`,{method:'POST',headers:{authorization:`Bearer ${Token}`},body:'{"method":"GetActiveServers"}'});
    assert.equal(Valid.status,200);
    assert.deepEqual(await Valid.json(),{result:[]});
    const BadOrigin=await fetch(`${Url}/v1/call`,{method:'POST',headers:{authorization:`Bearer ${Token}`,origin:'https://evil.example'},body:'{}'});
    assert.equal(BadOrigin.status,403);
    const BadHost=await new Promise<number>((Resolve,Reject)=>{
      const Request=request(Url,{method:'GET',headers:{host:'evil.example'}},Response=>{Resolve(Response.statusCode??0);Response.resume();});
      Request.on('error',Reject);Request.end();
    });
    assert.equal(BadHost,403);
    const Oversized=await fetch(`${Url}/v1/call`,{method:'POST',headers:{authorization:`Bearer ${Token}`},body:'x'.repeat(2_000_100)});
    assert.equal(Oversized.status,400);
  } finally {await App.close();}
  await assert.rejects(fetch(`${Url}/health`));
});
