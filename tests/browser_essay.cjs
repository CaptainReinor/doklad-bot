const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const {createHmac} = require('node:crypto');
const assert = require('node:assert/strict');

function initData(id) {
    const fields = {auth_date: String(Math.floor(Date.now()/1000)), user: JSON.stringify({id,first_name:'Иван'})};
    const secret = createHmac('sha256','WebAppData').update('123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi').digest();
    fields.hash = createHmac('sha256',secret).update(Object.keys(fields).sort().map(k=>`${k}=${fields[k]}`).join('\n')).digest('hex');
    return new URLSearchParams(fields).toString();
}

(async()=> {
    const browser = await chromium.launch({headless:true,channel:'msedge'});
    try {
        const context = await browser.newContext({viewport:{width:390,height:844},timezoneId:'Europe/Moscow'});
        await context.route('**/telegram-web-app.js*', route=>route.fulfill({contentType:'application/javascript',body:''}));
        await context.addInitScript(raw=>{
            window.Telegram={WebApp:{initData:raw,initDataUnsafe:{user:{id:101}},ready(){},expand(){},MainButton:{hide(){}},BackButton:{show(){},onClick(){}}}};
        },initData(101));
        const page = await context.newPage();
        const errors=[];
        page.on('pageerror',error=>errors.push(error.message));
        await page.goto(process.env.TEST_BASE_URL || 'http://127.0.0.1:8766');
        await page.waitForFunction(()=>connected && assignmentsData.some(a=>a.subject===ESSAY_SUBJECT));
        await page.evaluate(async()=>{
            for (const option of assignmentOptions.filter(o=>o.isMine)) {
                await performAction({action:'release_assignment_option',assignmentId:option.assignmentId,number:option.number});
            }
        });
        await page.evaluate(()=>{scheduleData=[];myBookings=[];studyToday=()=> '01.09.2026'; renderToday();});
        assert.equal(await page.locator('#todayContent .assignment-options').count(),0);
        await page.evaluate(()=>{switchTab('homework');renderHomework();});
        const list = page.locator('#homework .assignment-options').filter({hasText:'Тема эссе'});
        assert.equal(await list.count(),1);
        assert.equal(await list.getAttribute('open'),null);
        await list.locator(':scope > summary').click();
        assert.equal(await list.locator('.assignment-option').count(),10);
        await list.locator('.assignment-options-more').click();
        assert.equal(await list.locator('.assignment-option').count(),20);
        await list.locator('.assignment-options-more').click();
        assert.equal(await list.locator('.assignment-option').count(),30);
        assert.equal(await list.locator('.assignment-option-theses').count(),0);
        await list.locator('.assignment-option').first().getByRole('button',{name:'Выбрать',exact:true}).click();
        await page.waitForFunction(()=>assignmentOptions.some(o=>o.isMine));
        assert.match(await list.locator(':scope > summary').textContent(),/№ 1/);
        await page.evaluate(()=>{scheduleData=[];myBookings=[];studyToday=()=> '08.11.2026'; renderToday();});
        assert.equal(await page.locator('#todayContent .nearby-item .assignment-options').filter({hasText:'Тема эссе'}).count(),1);
        await page.evaluate(()=>{studyToday=()=> '14.11.2026'; renderToday();});
        assert.equal(await page.locator('#todayContent .today-deadline .assignment-options').filter({hasText:'Тема эссе'}).count(),1);
        assert.equal(await page.locator('#todayContent .nearby-item .assignment-options').filter({hasText:'Тема эссе'}).count(),0);
        await page.evaluate(()=>{studyToday=()=> '15.11.2026'; renderHomework();});
        assert.equal(await list.getByRole('button',{name:'Выбрать',exact:true}).count(),0);
        assert.equal(await list.getByRole('button',{name:'Освободить',exact:true}).count(),0);
        assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
        assert.deepEqual(errors,[]);
        console.log('Essay UI passed: collapsed 10/20/30, titles only, choice, far/near/today/past, mobile layout');
        await page.screenshot({path:process.env.TEST_SCREENSHOT || 'essay-ui.png',fullPage:true});
    } finally {await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
