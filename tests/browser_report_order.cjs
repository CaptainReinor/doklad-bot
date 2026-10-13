const {chromium,webkit}=require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const {createHmac}=require('node:crypto');
const assert=require('node:assert/strict');
const base=process.env.TEST_BASE_URL || 'http://127.0.0.1:8765';
const subject='Управление программами и портфелями проектов';
function auth(id){
    const f={auth_date:String(Math.floor(Date.now()/1000)),user:JSON.stringify({id})};
    const secret=createHmac('sha256','WebAppData').update('123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi').digest();
    f.hash=createHmac('sha256',secret).update(Object.keys(f).sort().map(k=>`${k}=${f[k]}`).join('\n')).digest('hex');
    return new URLSearchParams(f).toString();
}
(async()=>{
    async function action(id,data){
        const response=await fetch(base+'/api/action',{method:'POST',headers:{Authorization:'tma '+auth(id),'Content-Type':'application/json'},body:JSON.stringify(data)});
        assert.equal(response.status,200,await response.clone().text());
        return response.json();
    }
    const catalog=await (await fetch(base+'/api/catalog',{headers:{Authorization:'tma '+auth(900)}})).json();
    const topics=new Map(catalog.topics.filter(t=>t.subject===subject).map(t=>[t.number,t]));
    for(const [number,id,group] of [[7,101,'01'],[8,102,'02'],[9,101,'01'],[10,101,'01']]){
        const t=topics.get(number);
        await action(900,{action:'update_topic',topicId:t.id,title:`Тема ${number} <важная>`,subject,number,
            deadline:number===10?'15.09.2026':'14.09.2026',group:'МН-4-25-'+group,isCommon:false,isMulti:false,url:'https://example.edu/report/'+number});
        await action(id,{action:'book_topic',topicId:t.id});
    }
    for(const time of ['18:30-19:50','20:00-21:20']) await action(900,{action:'create_lesson',date:'14.09.2026',time,type:'ПЗ',
        subject,teacher:'Суслов Е.Ю.',room:'СДО',group:'',url:'https://example.edu/lesson/programs'});
    await action(900,{action:'create_lesson',date:'14.09.2026',time:'16:00-17:20',type:'ПЗ',
        subject:'Управление бизнес-процессами',teacher:'Золотухин В.А.',room:'СДО',group:''});
    const engine=process.env.TEST_ENGINE==='webkit'?webkit:chromium;
    const browser=await engine.launch({headless:true,...(engine===chromium?{channel:'msedge'}:{})});
    try{
        const errors=[];
        async function pageFor(id){
            const context=await browser.newContext({viewport:{width:390,height:844},timezoneId:'Europe/Moscow'});
            await context.addInitScript(raw=>{window.Telegram={WebApp:{initData:raw,ready(){},expand(){},BackButton:{show(){},onClick(){}}}};},auth(id));
            await context.route('**/telegram-web-app.js*',r=>r.fulfill({contentType:'application/javascript',body:'/* Test SDK */'}));
            const page=await context.newPage(); page.on('pageerror',e=>errors.push(e.message));
            await page.clock.install({time:new Date('2026-09-14T12:00:00+03:00')});
            await page.goto(base); await page.waitForFunction(()=>connected && document.getElementById('startupPanel').hidden);
            return page;
        }
        const student=await pageFor(101),other=await pageFor(102),unbooked=await pageFor(103);
        const notes=student.locator('.lesson-report-note');
        assert.equal(await notes.count(),1);
        assert.match(await notes.textContent(),/Вы выступаете с докладом/);
        assert.deepEqual(await notes.locator('.lesson-report-item p:first-child strong').allTextContents(),['7','9']);
        assert.match(await notes.textContent(),/Тема 7 <важная>/);
        assert.doesNotMatch(await notes.textContent(),/Тема 8|Тема 10/);
        const card=student.locator('.today-lesson').filter({has:notes});
        assert.match(await card.textContent(),/Суслов Е.Ю.|18.30/);
        assert.equal(await card.getByRole('link',{name:'Подключиться к паре',exact:true}).getAttribute('href'),'https://example.edu/lesson/programs');
        assert.equal(await card.getByRole('link',{name:'Материалы доклада',exact:true}).count(),2);
        assert.equal(await student.locator('.today-deadline').filter({hasText:'Тема 7'}).count(),0);
        assert.deepEqual(await other.locator('.lesson-report-item p:first-child strong').allTextContents(),['8']);
        assert.equal(await unbooked.locator('.lesson-report-note').count(),0);
        for(const p of [student,other,unbooked]){
            assert.equal(await p.locator('.queue-card, .queue-slot, .queue-topic-select').count(),0);
            assert.ok(await p.locator('.student-presentation-form').count()>0);
            assert.equal(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true);
        }
        await student.evaluate(()=>refreshState());
        assert.deepEqual(await notes.locator('.lesson-report-item p:first-child strong').allTextContents(),['7','9']);
        if(process.env.TEST_PREVIEW_PATH) await student.screenshot({path:process.env.TEST_PREVIEW_PATH,fullPage:true});
        // A presentation ending in the archive disappears from the personal note.
        await action(900,{action:'set_topic_active',topicId:topics.get(7).id,active:false});
        await student.evaluate(()=>refreshState());
        assert.deepEqual(await notes.locator('.lesson-report-item p:first-child strong').allTextContents(),['9']);
        // Future days have no "you present today" note; homework and reports remain otherwise available.
        await student.clock.setFixedTime(new Date('2026-09-13T12:00:00+03:00'));
        await student.evaluate(()=>renderToday());
        assert.equal(await notes.count(),0);
        assert.deepEqual(errors,[]);
        console.log('Passed: topic number order, multiple personal reports, no foreign/future/archive reports, one note per subject/day, lesson details and link preserved, old queue hidden, Zolotukhin forms retained.');
    }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
