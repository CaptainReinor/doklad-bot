/* Startup failures must expose a recoverable page rather than hide behind Telegram's loader. */
const {chromium, webkit} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const {createHmac} = require('node:crypto');

function auth() {
    const fields={auth_date:String(Math.floor(Date.now()/1000)),user:JSON.stringify({id:101})};
    const secret=createHmac('sha256','WebAppData').update('123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi').digest();
    fields.hash=createHmac('sha256',secret).update(Object.keys(fields).sort().map(k=>`${k}=${fields[k]}`).join('\n')).digest('hex');
    return new URLSearchParams(fields).toString();
}

(async()=>{
    const engine=process.env.TEST_ENGINE==='webkit' ? webkit : chromium;
    const browser=await engine.launch({headless:true,...(engine===chromium ? {channel:'msedge'} : {})});
    try {
        for (const scenario of ['native-sdk','normal','visit-failed','visit-pending','sdk-failed','main-failed','sync-failed','sync-pending']) {
            const context=await browser.newContext({viewport:{width:390,height:844},userAgent:'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148',timezoneId:'Europe/Moscow'});
            await context.addInitScript(raw=>{
                window.nativeEvents=[];
                window.TelegramWebviewProxy={postEvent(type){window.nativeEvents.push(type);}};
                window.testInitData=raw;
            },auth());
            await context.route('**/telegram-web-app.js*',route=>{
                if(scenario==='native-sdk') return route.continue();
                if(scenario==='sdk-failed') return route.abort();
                return route.fulfill({contentType:'application/javascript',body:`window.Telegram={WebApp:{initData:window.testInitData,ready(){},expand(){},BackButton:{show(){},onClick(){}}}};`});
            });
            if(scenario==='main-failed') await context.route('**/app.js*',route=>route.abort());
            if(scenario==='visit-failed') await context.route('**/api/visit',route=>route.fulfill({status:503,contentType:'application/json',body:'{"error":"Statistics unavailable"}'}));
            if(scenario==='visit-pending') await context.route('**/api/visit',()=>{});
            if(scenario==='sync-failed') await context.route('**/api/sync',route=>route.fulfill({status:503,contentType:'application/json',body:'{"error":"Сервер временно недоступен"}'}));
            if(scenario==='sync-pending') await context.route('**/api/sync',()=>{});
            const page=await context.newPage();
            await page.clock.install();
            const fragment='#tgWebAppData='+encodeURIComponent(auth());
            await page.goto((process.env.TEST_BASE_URL || 'http://127.0.0.1:8766')+'/'+fragment,{waitUntil:'domcontentloaded'});
            assert.ok(await page.evaluate(()=>window.nativeEvents.includes('web_app_ready')));
            if(['native-sdk','normal','visit-failed','visit-pending'].includes(scenario)) {
                await page.waitForFunction(()=>window.AppStartup && document.getElementById('startupPanel').hidden);
                assert.equal(await page.locator('body').evaluate(el=>el.classList.contains('app-loading')),false);
                assert.ok(await page.locator('#homework .assignment-options').count()>0);
            } else {
                if(scenario==='sync-pending') await page.clock.fastForward(16000);
                await page.locator('#startupRetry').waitFor({state:'visible'});
                assert.equal(await page.locator('body').evaluate(el=>el.classList.contains('app-loading')),true);
                assert.ok((await page.locator('#startupMessage').textContent()).length>10);
                if(scenario==='sync-failed') {
                    await context.unroute('**/api/sync');
                    await page.locator('#startupRetry').click();
                    await page.waitForURL(/reload=/);
                    assert.equal(new URL(page.url()).hash,fragment);
                    await page.waitForFunction(()=>document.getElementById('startupPanel').hidden);
                }
            }
            await context.close();
            console.log(scenario+' passed');
        }
    } finally {await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
