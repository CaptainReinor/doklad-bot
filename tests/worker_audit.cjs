const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const source = fs.readFileSync('proxy/cloudflare-worker.js','utf8').replace('export default','globalThis.worker =');
let target, status = 200;
const context = vm.createContext({URL, Headers, Response, Request,
    fetch:async (url)=>{target=new URL(url);return new Response([204,304].includes(status)?null:'test',{status});}});
vm.runInContext(source, context);
(async()=>{
    for (const path of ['//untrusted.example/path','/files/a.pdf?download=1','/%2f%2funtrusted.example/']) {
        await context.worker.fetch(new Request('https://public.example'+path));
        assert.equal(target.origin,'https://origin.138-16-179-240.sslip.io');
    }
    for (const code of [204,304]) {
        status=code;
        const result=await context.worker.fetch(new Request('https://public.example/health'));
        assert.equal(result.status,code);
        assert.equal(await result.text(),'');
    }
    status=200;
    const head=await context.worker.fetch(new Request('https://public.example/health',{method:'HEAD'}));
    assert.equal(await head.text(),'');
    assert.equal((await context.worker.fetch(new Request('https://public.example/telegram/botOTHER:getMe'))).status,403);
    console.log('Passed: proxy origin fixed for double-slash and encoded paths; HEAD/204/304; foreign bot rejected.');
})().catch(e=>{console.error(e);process.exitCode=1;});
