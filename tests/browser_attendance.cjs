/* Local fixture only: never sends Telegram messages or edits live accounts. */
const {chromium, webkit} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const {createHmac} = require('node:crypto');
const assert = require('node:assert/strict');
const base = process.env.TEST_BASE_URL || 'http://127.0.0.1:8765';
function auth(id) {
    const fields = {auth_date:String(Math.floor(Date.now()/1000)), user:JSON.stringify({id})};
    const secret = createHmac('sha256', 'WebAppData').update('123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi').digest();
    fields.hash = createHmac('sha256', secret).update(Object.keys(fields).sort().map(k=>`${k}=${fields[k]}`).join('\n')).digest('hex');
    return new URLSearchParams(fields).toString();
}
(async()=>{
    const engine = process.env.TEST_ENGINE==='webkit' ? webkit : chromium;
    const browser = await engine.launch({headless:true,...(engine===chromium?{channel:'msedge'}:{})});
    const errors=[];
    try {
        async function pageFor(id) {
            const context=await browser.newContext({viewport:{width:390,height:844},timezoneId:'Europe/Moscow'});
            await context.addInitScript(raw=>{
                window.Telegram={WebApp:{initData:raw,ready(){},expand(){},BackButton:{show(){},onClick(){}},
                    showConfirm(text,callback){callback(true);}}};
            },auth(id));
            await context.route('**/telegram-web-app.js*',r=>r.fulfill({contentType:'application/javascript',body:'/* Fixture bridge */'}));
            const page=await context.newPage();
            page.on('pageerror',e=>errors.push(e.message));
            await page.goto(base);
            await page.waitForFunction(()=>document.getElementById('startupPanel').hidden && connected);
            return page;
        }
        const admin=await pageFor(900), first=await pageFor(101), second=await pageFor(102);
        for (const [page,count] of [[first,4],[second,5]]) {
            await page.evaluate(()=>switchTab('notifications'));
            assert.equal(await page.locator('.notification-item').count(),count);
            assert.equal(await page.locator('.tab[data-tab="admin"]').isVisible(),false);
            assert.equal(await page.evaluate(()=>attendanceReminder),null);
        }
        const toggle=second.getByRole('checkbox',{name:'Отметки в СДО',exact:true});
        assert.equal(await toggle.isChecked(),true);
        await second.locator('.notification-item').filter({hasText:'Отметки в СДО'}).locator('.slider').click();
        await second.waitForFunction(()=>!busy && !notificationSettings.attendance);
        await second.reload();
        await second.waitForFunction(()=>connected);
        await second.evaluate(()=>switchTab('notifications'));
        assert.equal(await toggle.isChecked(),false);
        await admin.evaluate(()=>switchTab('admin'));
        await admin.getByRole('button',{name:'Отметки в СДО',exact:true}).click();
        assert.equal(await admin.locator('#attendanceTime').inputValue(),'19:00');
        assert.equal(await admin.locator('[data-attendance-date]:checked').count(),6);
        assert.match(await admin.locator('#adminContent').textContent(),/МН-4-25-02.*Кучина О.В./);
        await admin.locator('#attendanceTime').fill('20:15');
        await admin.locator('[data-attendance-date][value="24.10.2026"]').uncheck();
        await admin.locator('#attendanceUrl').fill('https://sdo.example.edu/course');
        await admin.evaluate(()=>refreshState());
        assert.equal(await admin.locator('#attendanceTime').inputValue(),'20:15');
        assert.equal(await admin.locator('[data-attendance-date]:checked').count(),5);
        await admin.getByRole('button',{name:'Сохранить',exact:true}).click();
        await admin.waitForFunction(()=>!busy && attendanceReminder.time==='20:15');
        await admin.reload();
        await admin.waitForFunction(()=>connected);
        await admin.evaluate(()=>{switchTab('admin');renderAttendanceEditor();});
        assert.equal(await admin.locator('#attendanceTime').inputValue(),'20:15');
        assert.equal(await admin.locator('[data-attendance-date]:checked').count(),5);
        assert.equal(await admin.locator('#attendanceUrl').inputValue(),'https://sdo.example.edu/course');
        assert.equal(await admin.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),true);
        if(process.env.TEST_SCREENSHOT) await admin.screenshot({path:process.env.TEST_SCREENSHOT,fullPage:true});
        assert.deepEqual(errors,[]);
        console.log('Passed: mobile attendance editor, saved settings, polling preserves draft, group targeting, default-on and persistent opt-out; no JS errors.');
    } finally {await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
