/* Isolated fixture only. Never uses production students or sends Telegram messages. */
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
(async () => {
    const engine = process.env.TEST_ENGINE==='webkit' ? webkit : chromium;
    const browser = await engine.launch({headless:true, ...(engine===chromium ? {channel:'msedge'} : {})});
    const errors = [];
    try {
        async function action(id, data, status=200) {
            const response = await fetch(base+'/api/action', {method:'POST',headers:{Authorization:'tma '+auth(id),'Content-Type':'application/json'},body:JSON.stringify(data)});
            assert.equal(response.status,status);
            return response.json();
        }
        const tomorrow = new Date(Date.now()+86400000).toLocaleDateString('ru-RU',{timeZone:'Europe/Moscow'});
        const created = await action(900,{action:'create_lesson',date:tomorrow,time:'18:30-21:20',type:'ПЗ',
            subject:'Управление бизнес-процессами',teacher:'Золотухин И.В.',room:'СДО',group:''});
        const lessonId = Math.max(...created.catalog.schedule.filter(l=>l.date===tomorrow).map(l=>l.id));
        const context = await browser.newContext({viewport:{width:390,height:844},timezoneId:'Europe/Moscow'});
        await context.addInitScript(raw=>{window.Telegram={WebApp:{initData:raw,ready(){},expand(){},BackButton:{show(){},onClick(){}},showConfirm(text,cb){cb(true);}}};},auth(103));
        await context.route('**/telegram-web-app.js*',r=>r.fulfill({contentType:'application/javascript',body:'/* test SDK */'}));
        const page = await context.newPage();
        page.on('pageerror',e=>errors.push(e.message));
        await page.goto(base);
        await page.waitForFunction(()=>document.getElementById('startupPanel').hidden && connected);
        const queue = page.locator(`#student-presentation-${lessonId}`);
        await queue.locator(':scope > summary').click();
        const input = page.locator(`#student-presentation-topic-${lessonId}`);
        const select = page.locator(`#student-presentation-position-${lessonId}`);
        await input.fill('Черновик <новой> темы');
        await select.selectOption('8');
        await input.focus();
        await input.evaluate(e=>e.setSelectionRange(4,9));
        // A different student's write changes markup during the automatic refresh.
        await action(102,{action:'save_student_presentation',lessonId,position:2,topic:'Чужая тема'});
        await page.evaluate(()=>refreshState());
        assert.equal(await input.inputValue(),'Черновик <новой> темы');
        assert.equal(await select.inputValue(),'8');
        assert.equal(await queue.evaluate(e=>e.open),true);
        assert.deepEqual(await input.evaluate(e=>[document.activeElement===e,e.selectionStart,e.selectionEnd]),[true,4,9]);
        assert.match(await queue.textContent(),/Чужая тема/);
        await queue.getByRole('button',{name:/Показать ещё/}).click();
        assert.equal(await input.inputValue(),'Черновик <новой> темы');
        assert.equal(await select.inputValue(),'8');
        // Occupant arrives after refresh: reject stale write and keep the draft.
        await action(101,{action:'save_student_presentation',lessonId,position:8,topic:'Место занято'});
        await queue.getByRole('button',{name:'Записаться',exact:true}).click();
        await page.waitForFunction(()=>!busy);
        assert.equal(await input.inputValue(),'Черновик <новой> темы');
        const state = (await (await fetch(base+'/api/state',{headers:{Authorization:'tma '+auth(103)}})).json());
        assert.equal(state.studentPresentations.find(q=>q.lessonId===lessonId).entries.some(e=>e.isMine),false);
        await page.evaluate(()=>refreshState());
        await select.selectOption('7');
        await queue.getByRole('button',{name:'Записаться',exact:true}).click();
        await page.waitForFunction(id=>!busy && studentPresentations.find(q=>q.lessonId===id).entries.some(e=>e.isMine && e.position===7),lessonId);
        await page.evaluate(()=>refreshState());
        assert.equal(await input.inputValue(),'Черновик <новой> темы');
        assert.equal(await select.inputValue(),'7');
        // Once the lesson has finished the edit form disappears, even with unsaved text.
        await input.fill('Несохранённая правка');
        await page.evaluate(id=>{studentPresentations.find(q=>q.lessonId===id).editable=false;renderToday();},lessonId);
        assert.equal(await input.count(),0);
        // Malformed file encoding cannot crash the whole hub.
        assert.match(await page.evaluate(()=>resourceButton(location.origin+'/files/bad%name.pdf')),/Скачать файл/);
        assert.deepEqual(errors,[]);
        console.log('Passed: refresh, changed queue, focus and caret, expanded slots, conflict retains draft, successful save, finished form removed, malformed file URL.');
    } finally {await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
