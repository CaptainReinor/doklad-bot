const {webkit}=require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const {createHmac}=require('node:crypto');
const assert=require('node:assert/strict');
const base=process.env.TEST_BASE_URL || 'http://127.0.0.1:8768';
const subject='Управление программами и портфелями проектов';
function auth(id){
    const f={auth_date:String(Math.floor(Date.now()/1000)),user:JSON.stringify({id})};
    const secret=createHmac('sha256','WebAppData').update('123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi').digest();
    f.hash=createHmac('sha256',secret).update(Object.keys(f).sort().map(k=>`${k}=${f[k]}`).join('\n')).digest('hex');
    return new URLSearchParams(f).toString();
}
(async()=>{
    async function action(id,data,status=200){
        const response=await fetch(base+'/api/action',{method:'POST',headers:{Authorization:'tma '+auth(id),'Content-Type':'application/json'},body:JSON.stringify(data)});
        assert.equal(response.status,status,await response.clone().text());return response.json();
    }
    const original=await (await fetch(base+'/api/catalog',{headers:{Authorization:'tma '+auth(900)}})).json();
    const old=original.topics.filter(t=>t.subject===subject);
    const first=old.find(t=>t.number===1);
    await action(101,{action:'book_topic',topicId:first.id});
    for(const topic of old)await action(900,{action:'set_topic_active',topicId:topic.id,active:false});
    const browser=await webkit.launch({headless:true});
    try{
        const page=await browser.newPage({viewport:{width:390,height:844}}),errors=[];
        page.on('pageerror',e=>errors.push(e.message));page.on('dialog',d=>d.accept());
        await page.addInitScript(raw=>{window.Telegram={WebApp:{initData:raw,ready(){},expand(){},BackButton:{show(){},onClick(){}}}};},auth(900));
        await page.route('**/telegram-web-app.js*',r=>r.fulfill({contentType:'application/javascript',body:'/* Test SDK */'}));
        await page.goto(base);await page.waitForFunction(()=>connected);
        await page.evaluate(()=>{switchTab('admin');openTopicEditor();});
        await page.locator('#draftTopicTitles').fill('Первая новая тема\nВторая новая тема\nТретья новая тема');
        await page.locator('#draftTopicSubject').selectOption(subject);
        await page.locator('#draftTopicStartNumber').fill('1');
        await page.locator('#draftTopicDeadline').fill('2026-09-30');
        await page.locator('#draftTopicGroup').selectOption('МН-4-25-01');
        await page.getByRole('button',{name:'Добавить список в черновик',exact:true}).click();
        await page.waitForFunction(()=>!busy && adminTopicDrafts.length===3);
        await page.getByRole('button',{name:'Опубликовать 3 тем',exact:true}).click();
        await page.waitForFunction(()=>!busy && adminTopicDrafts.length===0);
        const published=await page.evaluate(s=>adminTopics.filter(t=>t.subject===s && !t.archived),subject);
        assert.deepEqual(published.map(t=>t.number),[1,2,3]);
        const preserved=await page.evaluate(s=>adminTopics.filter(t=>t.subject===s && t.archived).map(t=>[t.id,t.number]),subject);
        assert.deepEqual(preserved,old.map(t=>[t.id,t.number]));
        assert.equal(await page.evaluate(id=>bookings.some(b=>b.id===id && b.user==='Анна Тестовый'),first.id),true);
        // Automatic numbering also starts with available CURRENT numbers only.
        for(const topic of published)await action(900,{action:'set_topic_active',topicId:topic.id,active:false});
        await page.evaluate(()=>{closeTopicEditor();openTopicEditor();});
        await page.evaluate(()=>refreshState());
        await page.locator('#draftTopicTitles').fill('Автоматическая первая\nАвтоматическая вторая');
        await page.locator('#draftTopicSubject').selectOption(subject);
        await page.locator('#draftTopicDeadline').fill('2026-09-30');
        await page.locator('#draftTopicGroup').selectOption('МН-4-25-01');
        await page.getByRole('button',{name:'Добавить список в черновик',exact:true}).click();
        await page.waitForFunction(()=>!busy && adminTopicDrafts.length===2);
        await page.getByRole('button',{name:'Опубликовать 2 тем',exact:true}).click();
        await page.waitForFunction(()=>!busy && adminTopicDrafts.length===0);
        assert.deepEqual(await page.evaluate(s=>adminTopics.filter(t=>t.subject===s && !t.archived).map(t=>t.number),subject),[1,2]);
        assert.deepEqual(errors,[]);
        console.log('Passed: draft form publication reuses archived 1/2/3; old numbers and booking retained; automatic draft numbering restarts at available current numbers.');
    }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
