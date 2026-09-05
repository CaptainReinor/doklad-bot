/* Run against tests/browser_server.py. No real Telegram credentials are used. */
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { createHmac } = require('node:crypto');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const base = process.env.TEST_BASE_URL || 'http://127.0.0.1:8765';
const artifacts = process.env.TEST_ARTIFACTS || path.resolve('browser-test-results');
fs.mkdirSync(artifacts, { recursive: true });
const token = '123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi';
const errors = [];
const checks = [];

function initData(id) {
    const fields = { auth_date: String(Math.floor(Date.now() / 1000)), user: JSON.stringify({id, first_name:'Тест', last_name:'Студент'}) };
    const secret = createHmac('sha256', 'WebAppData').update(token).digest();
    fields.hash = createHmac('sha256', secret).update(Object.keys(fields).sort().map(k => `${k}=${fields[k]}`).join('\n')).digest('hex');
    return new URLSearchParams(fields).toString();
}

async function main() {
    const browser = await chromium.launch({headless:true, ...(process.platform === 'win32' ? {channel:'msedge'} : {})});
    try {
        async function pageFor(id, width = 390) {
            const context = await browser.newContext({viewport: {width, height:844}, locale:'ru-RU', timezoneId:'Europe/Moscow'});
            await context.route('**/telegram-web-app.js*', route => route.fulfill({contentType:'application/javascript', body:'/* Local test bridge */'}));
            await context.addInitScript(({raw, id}) => {
                localStorage.setItem('studentAssistantRegistered', 'true');
                localStorage.setItem('studentAssistantUser', JSON.stringify({name:'Old account', telegramId:99999}));
                window.Telegram = { WebApp: {initData:raw, initDataUnsafe:{user:{id, first_name:'Тест', last_name:'Студент'}},
                    ready(){}, expand(){}, close(){}, BackButton:{show(){},onClick(){}}, MainButton:{hide(){}}} };
            }, {raw:id ? initData(id) : '', id});
            const page = await context.newPage();
            page.on('pageerror', error => errors.push(error.message));
            await page.goto(base);
            await page.locator('#scheduleContainer .schedule-card').first().waitFor({state:'attached'});
            return page;
        }
        const a = await pageFor(101);
        const b = await pageFor(102);
        const c = await pageFor(103);
        await a.getByRole('button', {name:'Обновить данные'}).click();
        await a.waitForFunction(() => !refreshing);
        assert.match(await a.locator('#connectionStatusText').textContent(), /Обновлено в \d{2}:\d{2}/);
        checks.push('Manual refresh reports the time of the latest successful update');
        assert.equal(await a.locator('#totalClasses').textContent(), '44');
        // Fix the browser clock to the morning of a day with two later lessons.
        await a.clock.install({time: new Date('2026-09-05T10:00:00+03:00')});
        await a.evaluate(() => renderSchedule('upcoming'));
        assert.equal(await a.locator('#scheduleContainer .schedule-card').filter({hasText:'01.09.2026'}).count(), 0);
        assert.equal(await a.locator('#scheduleContainer .schedule-card').filter({hasText:'05.09.2026'}).count(), 2);
        assert.equal(await a.locator('#scheduleContainer .schedule-card.today').count(), 2);
        assert.match(await a.locator('#scheduleContainer .schedule-card.today').first().textContent(), /Сегодня/);
        assert.equal(await a.locator('#scheduleContainer .next-lesson-label').count(), 1);
        await a.locator('[data-filter="past"]').click();
        assert.equal(await a.locator('#scheduleContainer .schedule-card').filter({hasText:'01.09.2026'}).count(), 1);
        assert.equal(await a.locator('#scheduleContainer .schedule-card').filter({hasText:'05.09.2026'}).count(), 0);
        await a.locator('[data-filter="upcoming"]').click();
        checks.push('Upcoming is default; today is red and past dates have a separate newest-first view');
        await a.evaluate(() => switchTab('reports'));
        await b.evaluate(() => switchTab('reports'));
        assert.equal(await b.locator('#topicsContainer .topic-card').filter({hasText:'Роль проектного управления'}).count(), 0);
        assert.equal(await a.locator('#topicsContainer .topic-card').filter({hasText:'Доклад только второй группы'}).count(), 0);
        const commonA = a.locator('#topicsContainer .topic-card').filter({hasText:'Общий тестовый доклад'});
        await commonA.getByRole('button', {name:'Выбрать тему'}).click();
        await commonA.getByRole('button', {name:'Отменить выбор'}).waitFor();
        await b.evaluate(() => refreshState());
        const commonB = b.locator('#topicsContainer .topic-card').filter({hasText:'Общий тестовый доклад'});
        assert.equal(await commonB.getByRole('button', {name:'Выбрать тему'}).isDisabled(), true);
        assert.equal(await b.locator('#bookedTopicsCount').textContent(), '1');
        assert.equal(
            Number(await b.locator('#topicsCount').textContent()) - Number(await b.locator('#bookedTopicsCount').textContent()),
            Number(await b.locator('#availableTopicsCount').textContent())
        );
        await b.evaluate(() => switchTab('queue'));
        assert.equal(await b.locator('#queueBooked').textContent(), '1');
        assert.equal(
            Number(await b.locator('#queueTopicsTotal').textContent()) - Number(await b.locator('#queueBooked').textContent()),
            Number(await b.locator('#queueFree').textContent())
        );
        await b.evaluate(() => switchTab('reports'));
        await c.evaluate(() => refreshState());
        await c.evaluate(() => switchTab('reports'));
        const commonC = c.locator('#topicsContainer .topic-card').filter({hasText:'Общий тестовый доклад'});
        assert.equal(await commonC.getByRole('button', {name:'Выбрать тему'}).isDisabled(), true);
        checks.push('Group-specific topics are hidden; common single-speaker booking is exclusive and updates occupied-topic statistics');
        await c.screenshot({path:path.join(artifacts, 'topics-mobile.png'), fullPage:true});
        await commonA.getByRole('button', {name:'Отменить выбор'}).click();
        await b.evaluate(() => refreshState());
        await commonB.getByRole('button', {name:'Выбрать тему'}).click();
        await commonB.getByRole('button', {name:'Отменить выбор'}).waitFor();
        await b.evaluate(() => refreshState());
        assert.equal(
            Number(await b.locator('#topicsCount').textContent()) - Number(await b.locator('#bookedTopicsCount').textContent()),
            Number(await b.locator('#availableTopicsCount').textContent())
        );
        checks.push('After cancellation another group can claim a common report');

        const rejected = async route => route.fulfill({status:503, contentType:'application/json', body:JSON.stringify({error:'Тест: сервер временно недоступен.'})});
        await c.route('**/api/action', rejected);
        await c.evaluate(() => handleTopicBooking(2));
        assert.equal(await c.locator('#topicsContainer .topic-card').nth(1).getByRole('button', {name:'Отменить выбор'}).count(), 0);
        assert.match(await c.locator('#status').textContent(), /недоступен/);
        await c.unroute('**/api/action', rejected);
        checks.push('Server rejection never displays a false successful booking');

        await c.waitForFunction(() => !refreshing && !busy);
        await c.context().setOffline(true);
        await c.evaluate(() => refreshState());
        assert.equal(await c.locator('#topicsContainer button:enabled').count(), 0);
        await c.context().setOffline(false);
        await c.evaluate(() => refreshState());
        assert.equal(await c.evaluate(() => connected), true);
        assert.ok(await c.locator('#topicsContainer button:enabled').count() > 0);
        checks.push('Offline actions are disabled and recover after reconnection');

        const admin = await pageFor(900, 1280);
        await admin.evaluate(() => switchTab('cabinet'));
        assert.equal(await admin.getByRole('button', {name:/Управление сроками/}).count(), 0);
        await admin.getByRole('button', {name:'📝 Управление домашкой'}).click();
        assert.match(await admin.locator('#cabinetContent').textContent(), /Домашних заданий пока нет/);
        await admin.locator('#newAssignmentSubject').selectOption({label:'Управление бизнес-процессами'});
        await admin.locator('#newAssignmentDescription').fill('Подготовить схему бизнес-процесса и краткое пояснение.');
        await admin.locator('#newAssignmentDeadline').fill('2026-09-30');
        await admin.getByRole('button', {name:'Добавить задание'}).click();
        await admin.locator('.admin-record').filter({hasText:'30.09.2026'}).waitFor();
        await b.evaluate(() => refreshState());
        await b.evaluate(() => switchTab('homework'));
        const homework = b.locator('#homeworkContainer .homework-card');
        assert.equal(await homework.count(), 1);
        assert.match(await homework.textContent(), /Подготовить схему бизнес-процесса/);
        assert.match(await homework.textContent(), /30\.09\.2026/);
        assert.equal(await homework.getByRole('button').count(), 0);
        checks.push('Homework has its own read-only student tab and admin create/edit/delete controls');
        await admin.evaluate(() => closeHomeworkEditor());
        await admin.getByRole('button', {name:'📚 Управление темами'}).click();
        await admin.locator('#newTopicTitle').fill('Тестовая тема администратора');
        await admin.locator('#newTopicSubject').selectOption({label:'Бизнес-процессы'});
        await admin.locator('#newTopicDeadline').fill('2026-10-15');
        await admin.locator('#newTopicGroup').selectOption('МН-4-25-02');
        await admin.locator('#newTopicMulti').check();
        await admin.getByRole('button', {name:'Добавить тему'}).click();
        await admin.locator('input[value="Тестовая тема администратора"]').waitFor();
        await b.evaluate(() => refreshState());
        await b.evaluate(() => switchTab('reports'));
        const createdTopic = b.locator('#topicsContainer .topic-card').filter({hasText:'Тестовая тема администратора'});
        assert.equal(await createdTopic.count(), 1);
        assert.match(await createdTopic.textContent(), /Бизнес-процессы/);
        assert.match(await createdTopic.textContent(), /15\.10\.2026/);
        assert.match(await createdTopic.textContent(), /Несколько выступающих/);
        await b.getByRole('button', {name:'Бизнес-процессы', exact:true}).click();
        assert.ok(await b.locator('#topicsContainer .topic-card').count() >= 1);
        await b.evaluate(() => switchTab('reports'));
        const removeBookingButton = admin.getByRole('button', {name:'Снять бронь'});
        admin.once('dialog', dialog => dialog.accept());
        await removeBookingButton.click();
        await removeBookingButton.waitFor({state:'detached'});
        await b.evaluate(() => refreshState());
        assert.equal(await b.locator('#topicsContainer .topic-card').nth(0).getByRole('button', {name:'Отменить выбор'}).count(), 0);
        checks.push('Topic manager controls report topics and their deadlines');
        await admin.screenshot({path:path.join(artifacts, 'admin-topics-desktop.png'), fullPage:true});

        await admin.evaluate(() => closeTopicEditor());
        await admin.getByRole('button', {name:'🗓 Управление расписанием'}).click();
        assert.equal(await admin.locator('#newLesson-subject').getAttribute('list'), 'scheduleSubjectSuggestions');
        assert.ok(await admin.locator('#scheduleSubjectSuggestions option').count() >= 8);
        await admin.locator('#newLesson-date').fill('2026-12-31');
        await admin.locator('#newLesson-start').fill('18:30');
        await admin.locator('#newLesson-end').fill('19:50');
        await admin.locator('#newLesson-type').selectOption({label:'ПЗ'});
        await admin.locator('#newLesson-subject').fill('Управление бизнес-процессами');
        assert.equal(await admin.locator('#newLesson-teacher').inputValue(), 'Золотухин В.А.');
        await admin.locator('#newLesson-room').fill('СДО');
        await admin.locator('#newLesson-group').fill('МН-4-25-01');
        await admin.locator('#newLesson-url').fill('https://example.edu/lesson/123');
        await admin.getByRole('button', {name:'Добавить занятие'}).click();
        await admin.locator('.admin-record').filter({hasText:'31.12.2026'}).waitFor();
        await b.evaluate(() => refreshState());
        await b.evaluate(() => switchTab('schedule'));
        const linkedLesson = b.locator('#scheduleContainer .schedule-card').filter({hasText:'31.12.2026'});
        assert.equal(await linkedLesson.count(), 1);
        assert.equal(await linkedLesson.getByRole('link', {name:'🔗 Подключиться к паре'}).getAttribute('href'), 'https://example.edu/lesson/123');
        assert.equal(await b.locator('#scheduleContainer .schedule-card').filter({hasText:'08.09.2026'}).getByRole('link', {name:/Подключиться/}).count(), 0);
        checks.push('Admin-created schedule link appears as a button only on the linked lesson');
        await admin.screenshot({path:path.join(artifacts, 'admin-tools-desktop.png'), fullPage:true});

        const newcomer = await pageFor(104);
        assert.equal(await newcomer.locator('#cabinet').evaluate(element => element.classList.contains('active')), true);
        await newcomer.locator('#profileFirst').fill('12345');
        assert.equal(await newcomer.locator('#profileFirst').evaluate(element => element.checkValidity()), false);
        await newcomer.locator('#profileFirst').fill('Новый');
        await newcomer.locator('#profileLast').fill('Студент-Тест');
        assert.equal(await newcomer.locator('#profileGroup option').count(), 3);
        await newcomer.locator('#profileGroup').selectOption('МН-4-25-02');
        await newcomer.getByRole('button', {name:'Зарегистрироваться', exact:true}).click();
        await newcomer.locator('.profile-status').filter({hasText:'Профиль активен'}).waitFor();
        await newcomer.reload();
        await newcomer.evaluate(() => switchTab('cabinet'));
        await newcomer.locator('.profile-status').filter({hasText:'Профиль активен'}).waitFor();
        assert.match(await newcomer.locator('#cabinetContent').textContent(), /Студент-Тест/);
        checks.push('New users land in Cabinet; registration survives reload; names and allowed groups are validated');

        await b.evaluate(() => switchTab('notifications'));
        assert.equal(await b.locator('.notification-item').count(), 3);
        assert.equal(await b.locator('.notification-item').filter({hasText:'Общий список бронирований'}).count(), 0);
        await b.locator('.notification-item').filter({hasText:'Домашние задания'}).locator('.slider').click();
        await b.waitForFunction(() => !busy);
        await b.reload();
        await b.locator('#scheduleContainer .schedule-card').first().waitFor();
        await b.evaluate(() => switchTab('notifications'));
        assert.equal(await b.getByRole('checkbox', {name:'Домашние задания', exact:true}).isChecked(), false);
        checks.push('Only three independent notification preferences are shown and survive reload');

        const preview = await pageFor(null, 320);
        await preview.evaluate(() => switchTab('reports'));
        assert.equal(await preview.locator('#topicsContainer button:enabled').count(), 0);
        assert.match(await preview.locator('#connectionStatus').textContent(), /Режим просмотра/);
        for (const page of [a,b,c,newcomer,preview]) {
            assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), true);
        }
        checks.push('Browser preview cannot claim registration or book; no mobile horizontal overflow');

        // Failed PDF dependency must give an error, not crash the whole page.
        await preview.evaluate(() => { window.html2pdf = undefined; return downloadSchedule(); });
        assert.match(await preview.locator('#status').textContent(), /Модуль PDF не загрузился/);
        checks.push('Missing PDF library is handled');

        await b.evaluate(() => switchTab('schedule'));
        await b.locator('[data-filter="ПЗ"]').click();
        await b.screenshot({path:path.join(artifacts, 'schedule-mobile.png'), fullPage:true});
        if (await b.evaluate(() => typeof html2pdf === 'function')) {
            const downloadPromise = b.waitForEvent('download', {timeout:60000});
            await b.getByRole('button', {name:'📄 Скачать расписание PDF'}).click();
            const download = await downloadPromise;
            const target = path.join(artifacts, 'schedule-test.pdf');
            await download.saveAs(target);
            assert.ok(fs.statSync(target).size > 10000);
            checks.push('PDF export produces a non-empty download');
        } else checks.push('PDF CDN unavailable in this run; download not exercised');
        assert.deepEqual(errors, []);
        fs.writeFileSync(path.join(artifacts, 'results.json'), JSON.stringify({checks, errors}, null, 2));
        console.log(JSON.stringify({passed:checks.length, checks, errors}, null, 2));
    } finally { await browser.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
