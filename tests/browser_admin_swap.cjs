/* Run against a fresh tests/browser_server.py fixture; no real student data is used. */
const {chromium, webkit} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const {createHmac} = require('node:crypto');
const assert = require('node:assert/strict');
const base = process.env.TEST_BASE_URL || 'http://127.0.0.1:8765';

function auth(id) {
    const fields = {auth_date:String(Math.floor(Date.now()/1000)), user:JSON.stringify({id})};
    const secret = createHmac('sha256', 'WebAppData').update('123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi').digest();
    fields.hash = createHmac('sha256', secret).update(Object.keys(fields).sort().map(k => `${k}=${fields[k]}`).join('\n')).digest('hex');
    return new URLSearchParams(fields).toString();
}

(async () => {
    async function action(id, data, status = 200) {
        const response = await fetch(base+'/api/action', {method:'POST',
            headers:{Authorization:'tma '+auth(id), 'Content-Type':'application/json'}, body:JSON.stringify(data)});
        assert.equal(response.status, status);
        return response.json();
    }
    const tomorrow = new Date(Date.now()+86400000).toLocaleDateString('ru-RU', {timeZone:'Europe/Moscow'});
    await action(900, {action:'create_lesson', date:tomorrow, time:'18:30-21:20', type:'ПЗ',
        subject:'Управление бизнес-процессами', teacher:'Золотухин И.В.', room:'СДО', group:''});
    const catalog = await (await fetch(base+'/api/catalog')).json();
    const lessonId = Math.max(...catalog.schedule.filter(l => l.date===tomorrow && l.subject==='Управление бизнес-процессами').map(l=>l.id));
    for (const [id, position] of [[101,1],[102,10]]) {
        await action(id, {action:'save_student_presentation', lessonId, position, topic:`Тестовая тема ${id}`});
    }
    const engine = process.env.TEST_ENGINE==='webkit' ? webkit : chromium;
    const browser = await engine.launch({headless:true, ...(engine===chromium ? {channel:'msedge'} : {})});
    const errors = [];
    try {
        async function pageFor(id) {
            const context = await browser.newContext({viewport:{width:390,height:844}, timezoneId:'Europe/Moscow'});
            await context.addInitScript(raw => {
                window.Telegram={WebApp:{initData:raw, ready(){}, expand(){}, BackButton:{show(){},onClick(){}},
                    showConfirm(text, callback){callback(true);}}};
            }, auth(id));
            await context.route('**/telegram-web-app.js*', r=>r.fulfill({contentType:'application/javascript',body:'/* Test bridge */'}));
            const page = await context.newPage();
            page.on('pageerror', error=>errors.push(error.message));
            await page.goto(base);
            await page.waitForFunction(()=>document.getElementById('startupPanel').hidden && connected);
            return page;
        }
        const admin = await pageFor(900);
        const student = await pageFor(101);
        await admin.evaluate(()=>switchTab('notifications'));
        assert.equal(await admin.locator('.notification-item').count(),4);
        assert.equal(await admin.getByRole('checkbox',{name:'Изменения расписания',exact:true}).count(),0);
        assert.equal(await admin.getByRole('checkbox',{name:'Напоминания о парах',exact:true}).count(),1);
        await admin.evaluate(()=>switchTab('today'));
        const queue = admin.locator('.student-presentation').filter({has:admin.locator(`#presentation-swap-first-${lessonId}`)});
        await queue.locator(':scope > summary').click();
        await queue.locator('.student-presentation-admin > summary').click();
        assert.equal(await student.locator('.student-presentation-admin').count(),0);
        const original = await admin.evaluate(id=>studentPresentations.find(q=>q.lessonId===id).entries, lessonId);
        const payload = {action:'admin_swap_student_presentations',lessonId,
            firstId:original[0].presentationId, secondId:original[1].presentationId, firstPosition:1, secondPosition:10};
        await queue.locator(`#presentation-swap-second-${lessonId}`).selectOption('10');
        await queue.getByRole('button',{name:'Переместить',exact:true}).click();
        await admin.waitForFunction(id=>!busy && studentPresentations.find(q=>q.lessonId===id).entries.find(e=>e.position===1).topic==='Тестовая тема 102',lessonId);
        await student.evaluate(()=>refreshState());
        const entries = await student.evaluate(id=>studentPresentations.find(q=>q.lessonId===id).entries,lessonId);
        assert.deepEqual(entries.map(e=>[e.position,e.topic]),[[1,'Тестовая тема 102'],[10,'Тестовая тема 101']]);
        await action(900,payload,409);
        await action(101,payload,403);
        // Free positions are available to the admin, including when moving someone else.
        await queue.locator('.student-presentation-admin > summary').click();
        assert.match(await queue.locator(`#presentation-swap-second-${lessonId} option[value="7"]`).textContent(), /Свободно/);
        await queue.locator(`#presentation-swap-second-${lessonId}`).selectOption('7');
        await queue.getByRole('button',{name:'Переместить',exact:true}).click();
        await admin.waitForFunction(id=>!busy && studentPresentations.find(q=>q.lessonId===id).entries.find(e=>e.position===7)?.topic==='Тестовая тема 102',lessonId);
        await student.evaluate(()=>refreshState());
        assert.deepEqual(await student.evaluate(id=>studentPresentations.find(q=>q.lessonId===id).entries.map(e=>[e.position,e.topic]),lessonId),
            [[7,'Тестовая тема 102'],[10,'Тестовая тема 101']]);
        await admin.evaluate(id=>{
            const queue=studentPresentations.find(q=>q.lessonId===id);
            queue.entries=queue.entries.slice(0,1);
            renderToday();
        },lessonId);
        assert.equal(await admin.locator(`#presentation-swap-first-${lessonId} option`).count(),1);
        assert.equal(await admin.locator(`#presentation-swap-second-${lessonId} option`).count(),20);
        await admin.evaluate(id=>{
            studentPresentations.find(q=>q.lessonId===id).editable=false;
            renderToday();
        },lessonId);
        assert.equal(await admin.locator(`#student-presentation-topic-${lessonId}`).count(),0);
        assert.equal(await admin.locator(`#presentation-swap-first-${lessonId}`).count(),0);
        assert.deepEqual(errors,[]);
        console.log('Passed: admin swap and move to a free position; student synchronization; one-participant form; stale/unauthorized requests rejected; finished-lesson forms hidden.');
    } finally {await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
