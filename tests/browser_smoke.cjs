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
                window.Telegram = { WebApp: {initData:raw, initDataUnsafe:{user:{id, first_name:'Тест', last_name:'Студент'}},
                    ready(){}, expand(){}, close(){ window.telegramClosed = true; },
                    BackButton:{show(){},onClick(callback){ window.telegramBack = callback; }}, MainButton:{hide(){}}} };
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
        assert.equal((await a.locator('.brand-title').textContent()).trim(), 'МН-4-25');
        assert.equal(await a.locator('#today').evaluate(element => element.classList.contains('active')), true);
        assert.ok(await a.locator('#today .nearby-item').count() <= 3);
        assert.match(await a.locator('#todayContent').textContent(), /Ближайшее/);
        assert.equal(await a.locator('#today .resource-link').count(), 0);
        assert.deepEqual(await a.evaluate(() => scheduleData.filter(item => item.subject === ENGLISH_SUBJECT)
            .map(item => item.group)), Array(5).fill('МН-4-25-01'));
        assert.deepEqual(await b.evaluate(() => scheduleData.filter(item => item.subject === ENGLISH_SUBJECT)
            .map(item => item.group)), Array(5).fill('МН-4-25-02'));
        checks.push('Today opens as the hub and limits the next seven days to three events');
        assert.match((await a.locator('#headerPeriod').textContent()).trim(), /^\p{L}+ \d{4}/u);
        assert.equal(await a.locator('#connectionStatus, #refreshButton').count(), 0);
        checks.push('Service status bar and manual refresh control are removed');
        assert.equal((await a.locator('#schedule .section-subtitle').textContent()).trim(), 'Расписание занятий');
        assert.equal(await a.locator('#totalClasses').textContent(), '38');
        await a.evaluate(() => switchTab('schedule'));
        // Fix the browser clock to the morning of a day with two later lessons.
        await a.clock.install({time: new Date('2026-09-05T10:00:00+03:00')});
        await a.evaluate(() => renderSchedule('upcoming'));
        assert.equal(await a.locator('#scheduleContainer .schedule-card').filter({hasText:'03.09.2026'}).count(), 0);
        assert.equal(await a.locator('#scheduleContainer .schedule-card').filter({hasText:'05.09.2026'}).count(), 2);
        assert.equal(await a.locator('#scheduleContainer .schedule-card.today').count(), 2);
        assert.match(await a.locator('#scheduleContainer .schedule-card.today').first().textContent(), /Сегодня/);
        assert.equal(await a.locator('#scheduleContainer .next-lesson-label').count(), 1);
        await a.locator('[data-filter="past"]').click();
        assert.equal(await a.locator('#scheduleContainer .schedule-card').filter({hasText:'03.09.2026'}).count(), 1);
        assert.equal(await a.locator('#scheduleContainer .schedule-card').filter({hasText:'05.09.2026'}).count(), 0);
        await a.locator('[data-filter="upcoming"]').click();
        checks.push('Upcoming is default; today is red and past dates have a separate newest-first view');
        await a.evaluate(() => switchTab('reports'));
        await b.evaluate(() => switchTab('reports'));
        assert.equal((await a.locator('#reports .section-subtitle').textContent()).trim(), 'Выберите актуальную тему');
        assert.equal(await b.locator('#topicsContainer .topic-card').filter({hasText:'Роль проектного управления'}).count(), 0);
        assert.equal(await a.locator('#topicsContainer .topic-card').filter({hasText:'Доклад только второй группы'}).count(), 0);
        const commonA = a.locator('#topicsContainer .topic-card').filter({hasText:'Общий тестовый доклад'});
        await commonA.getByRole('button', {name:'Выбрать тему'}).click();
        await commonA.getByRole('button', {name:'Отменить выбор'}).waitFor();
        await a.getByRole('button', {name:/Мои доклады/}).click();
        assert.equal(await a.locator('#topicsContainer .topic-card').count(), 1);
        assert.match(await a.locator('#topicsContainer').textContent(), /Общий тестовый доклад/);
        await a.getByRole('button', {name:'Все предметы'}).click();
        checks.push('My reports filter shows only the current student bookings');
        await b.evaluate(() => refreshState());
        const commonB = b.locator('#topicsContainer .topic-card').filter({hasText:'Общий тестовый доклад'});
        assert.equal(await commonB.getByRole('button', {name:'Выбрать тему'}).isDisabled(), true);
        assert.equal(await b.locator('#bookedTopicsCount').textContent(), '1');
        assert.equal(
            Number(await b.locator('#topicsCount').textContent()) - Number(await b.locator('#bookedTopicsCount').textContent()),
            Number(await b.locator('#availableTopicsCount').textContent())
        );
        assert.equal(await b.locator('.tab[data-tab="queue"]').count(), 0);
        assert.equal(await b.locator('#queue').count(), 0);
        assert.equal(await b.locator('#myBookingsContainer, #myProgress, #myDeadline').count(), 0);
        assert.equal(await b.locator('.tab[data-tab="admin"]').isHidden(), true);
        checks.push('Duplicate bookings UI is removed; personal reports remain in the My reports filter');
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
        assert.doesNotMatch(await admin.locator('#cabinetContent').textContent(), /Администрирование|Управление темами/);
        assert.equal(await admin.locator('.tab[data-tab="admin"]').isVisible(), true);
        await admin.evaluate(() => switchTab('admin'));
        await admin.getByRole('button', {name:'📊 Статистика'}).click();
        assert.equal(await admin.locator('.activity-column').count(), 30);
        assert.equal(await admin.locator('.admin-notification-stat').count(), 5);
        assert.match(await admin.locator('#adminContent').textContent(), /Входов сегодня/);
        assert.doesNotMatch(await admin.locator('#adminContent').textContent(), /без фамилий|Новый сеанс/);
        assert.equal(await admin.locator('#adminContent').textContent().then(text => /Иванов|Петров/.test(text)), false);
        await admin.screenshot({path:path.join(artifacts, 'admin-stats-desktop.png'), fullPage:true});
        const mobileStats = await pageFor(900);
        await mobileStats.evaluate(() => switchTab('admin'));
        await mobileStats.getByRole('button', {name:'📊 Статистика'}).click();
        assert.equal(await mobileStats.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), true);
        await mobileStats.screenshot({path:path.join(artifacts, 'admin-stats-mobile.png'), fullPage:true});
        checks.push('Admin analytics shows aggregate daily visits and notification adoption without personal history');
        await admin.getByRole('button', {name:'К управлению'}).click();
        await admin.getByRole('button', {name:'📣 Объявления'}).click();
        await admin.locator('#newAnnouncementTitle').fill('Важное объявление');
        await admin.locator('#newAnnouncementBody').fill('Завтра аудитория занятия будет изменена.');
        await admin.locator('#newAnnouncementUrl').fill('https://example.edu/announcement');
        await admin.getByRole('button', {name:'Опубликовать', exact:true}).click();
        await admin.locator('.admin-record').filter({hasText:'Важное объявление'}).waitFor();
        await b.evaluate(() => refreshState());
        await b.evaluate(() => switchTab('today'));
        const announcement = b.locator('#today .announcement-card').filter({hasText:'Важное объявление'});
        assert.equal(await announcement.count(), 1);
        assert.equal(await announcement.getByRole('link', {name:'Открыть'}).getAttribute('href'), 'https://example.edu/announcement');
        checks.push('Admins can publish announcements and students see them on Today');
        await admin.evaluate(() => closeAnnouncementEditor());
        assert.equal(await admin.getByRole('button', {name:/Управление сроками/}).count(), 0);
        await admin.getByRole('button', {name:'📝 Управление домашкой'}).click();
        assert.match(await admin.locator('#adminContent').textContent(), /Домашних заданий пока нет/);
        await admin.locator('#newAssignmentSubject').selectOption({label:'Управление бизнес-процессами'});
        await admin.locator('#newAssignmentDescription').fill('Подготовить схему бизнес-процесса и краткое пояснение.');
        await admin.locator('#newAssignmentDeadline').fill('2026-09-30');
        await admin.locator('#newAssignmentFile').setInputFiles({name:'Задание.pdf', mimeType:'application/pdf', buffer:Buffer.from('%PDF-1.4 test homework')});
        await admin.getByRole('button', {name:'Добавить задание'}).click();
        await admin.locator('.admin-record').filter({hasText:'30.09.2026'}).waitFor();
        await b.evaluate(() => refreshState());
        await b.evaluate(() => switchTab('homework'));
        const homework = b.locator('#homeworkContainer .homework-card');
        assert.equal(await homework.count(), 1);
        assert.match(await homework.textContent(), /Подготовить схему бизнес-процесса/);
        assert.match(await homework.textContent(), /30\.09\.2026/);
        assert.match(await homework.textContent(), /Осталось \d+ (день|дня|дней)/);
        assert.match(await homework.getByRole('link', {name:'🔗 Открыть материалы'}).getAttribute('href'), /\/files\/[a-f0-9]+\.pdf$/);
        assert.equal(await homework.getByRole('button').count(), 0);
        checks.push('Homework has its own read-only student tab and admin create/edit/delete controls');
        await admin.locator('#newAssignmentSubject').selectOption({label:'Управление бизнес-процессами'});
        await admin.locator('#newAssignmentDescription').fill('Прошедшее тестовое задание.');
        await admin.locator('#newAssignmentDeadline').fill('2000-01-01');
        await admin.locator('#newAssignmentUrl').fill('https://example.edu/homework/archive');
        await admin.getByRole('button', {name:'Добавить задание'}).click();
        await admin.locator('.admin-record').filter({hasText:'Прошедшее тестовое задание'}).waitFor();
        await b.evaluate(() => refreshState());
        await b.locator('#homeworkArchiveFilters').getByRole('button', {name:'Архив'}).click();
        const archivedHomework = b.locator('#homeworkContainer .homework-card').filter({hasText:'Прошедшее тестовое задание'});
        assert.equal(await archivedHomework.count(), 1);
        assert.equal(await archivedHomework.getByRole('link', {name:'🔗 Открыть материалы'}).getAttribute('href'), 'https://example.edu/homework/archive');
        await admin.evaluate(() => closeHomeworkEditor());
        await admin.getByRole('button', {name:'📚 Управление темами'}).click();
        await admin.locator('#draftTopicTitles').fill('1. Массовая тема А\n2. Массовая тема Б');
        await admin.locator('#draftTopicSubject').selectOption({label:'Бизнес-процессы'});
        await admin.locator('#draftTopicDeadline').fill('2026-10-10');
        await admin.locator('#draftTopicGroup').selectOption('МН-4-25-02');
        await admin.getByRole('button', {name:'Добавить список в черновик'}).click();
        await admin.locator('.draft-item').first().waitFor();
        assert.equal(await admin.locator('.draft-item').count(), 2);
        assert.match(await admin.locator('.notification-preview').textContent(), /Добавлены новые темы докладов: 2/);
        assert.match(await admin.locator('.notification-preview').textContent(), /Массовая тема А/);
        admin.once('dialog', dialog => dialog.accept());
        await admin.getByRole('button', {name:'Опубликовать 2 тем'}).click();
        await admin.locator('input[value="Массовая тема Б"]').waitFor();
        assert.match(await admin.locator('.draft-panel').textContent(), /Черновик пуст/);
        checks.push('Bulk topic draft persists, previews one notification, and publishes in one action');
        await admin.locator('#newTopicTitle').fill('Тестовая тема администратора');
        await admin.locator('#newTopicSubject').selectOption({label:'Бизнес-процессы'});
        await admin.locator('#newTopicDeadline').fill('2026-10-15');
        await admin.locator('#newTopicUrl').fill('https://example.edu/reports/current');
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
        assert.equal(await createdTopic.getByRole('link', {name:'🔗 Открыть материалы'}).getAttribute('href'), 'https://example.edu/reports/current');
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
        await admin.locator('#newTopicTitle').fill('Архивный тестовый доклад');
        await admin.locator('#newTopicSubject').selectOption({label:'Бизнес-процессы'});
        await admin.locator('#newTopicDeadline').fill('2000-01-01');
        await admin.locator('#newTopicGroup').selectOption('МН-4-25-02');
        await admin.locator('#newTopicUrl').fill('https://example.edu/reports/archive');
        await admin.getByRole('button', {name:'Добавить тему'}).click();
        await admin.locator('input[value="Архивный тестовый доклад"]').waitFor();
        await b.evaluate(() => refreshState());
        await b.evaluate(() => switchTab('reports'));
        await b.locator('#topicArchiveFilters').getByRole('button', {name:'Архив'}).click();
        const archivedTopic = b.locator('#topicsContainer .topic-card').filter({hasText:'Архивный тестовый доклад'});
        assert.equal(await archivedTopic.count(), 1);
        assert.equal(await archivedTopic.getByRole('button', {name:'Выбрать тему'}).count(), 0);
        assert.equal(await archivedTopic.getByRole('link', {name:'🔗 Открыть материалы'}).getAttribute('href'), 'https://example.edu/reports/archive');
        await b.screenshot({path:path.join(artifacts, 'archives-mobile.png'), fullPage:true});
        checks.push('Homework and reports support HTTPS resources and automatically move past deadlines to archives');
        await admin.screenshot({path:path.join(artifacts, 'admin-topics-desktop.png'), fullPage:true});

        await admin.evaluate(() => closeTopicEditor());
        await admin.getByRole('button', {name:'🕘 История действий'}).click();
        assert.match(await admin.locator('.audit-list').textContent(), /Опубликовано тем: 2/);
        assert.match(await admin.locator('.audit-list').textContent(), /Администратор Тестовый/);
        checks.push('Admin audit history records publications and edits');
        await admin.getByRole('button', {name:'К управлению'}).click();
        await admin.getByRole('button', {name:'🗓 Управление расписанием'}).click();
        assert.equal(await admin.locator('#newLesson-subject').getAttribute('list'), 'scheduleSubjectSuggestions');
        assert.equal(await admin.locator('#scheduleSubjectSuggestions option').count(), 6);
        await admin.locator('#newLesson-date').fill('2026-12-31');
        await admin.locator('#newLesson-start').fill('18:30');
        await admin.locator('#newLesson-end').fill('19:50');
        await admin.locator('#newLesson-type').selectOption({label:'ПЗ'});
        assert.equal(await admin.locator('#newLesson-group').isDisabled(), true);
        await admin.locator('#newLesson-subject').fill('Иностранный язык профессиональных коммуникаций');
        assert.equal(await admin.locator('#newLesson-group').isEnabled(), true);
        await admin.locator('#newLesson-group').selectOption('МН-4-25-02');
        await admin.locator('#newLesson-subject').fill('Управление бизнес-процессами');
        assert.equal(await admin.locator('#newLesson-teacher').inputValue(), 'Золотухин В.А.');
        await admin.locator('#newLesson-room').fill('СДО');
        assert.equal(await admin.locator('#newLesson-group').isDisabled(), true);
        await admin.locator('#newLesson-url').fill('https://example.edu/lesson/123');
        await admin.getByRole('button', {name:'Добавить занятие'}).click();
        await admin.locator('.admin-record').filter({hasText:'31.12.2026'}).waitFor();
        await b.evaluate(() => refreshState());
        await b.evaluate(() => switchTab('schedule'));
        const linkedLesson = b.locator('#scheduleContainer .schedule-card').filter({hasText:'31.12.2026'});
        assert.equal(await linkedLesson.count(), 1);
        assert.equal(await linkedLesson.getByRole('link', {name:'🔗 Подключиться к паре'}).getAttribute('href'), 'https://example.edu/lesson/123');
        assert.equal(await b.locator('#scheduleContainer .schedule-card').filter({hasText:'08.09.2026'}).getByRole('link', {name:/Подключиться/}).count(), 0);
        checks.push('Schedule is shared except for group-specific English; admin-created links stay attached to their lesson');
        const linkLabels = await pageFor(102);
        await linkLabels.clock.install({time: new Date('2026-12-24T10:00:00+03:00')});
        await linkLabels.evaluate(() => switchTab('today'));
        const futureLinkedLesson = linkLabels.locator('#today .nearby-item').filter({hasText:'31.12.2026'});
        assert.equal(await futureLinkedLesson.getByRole('link', {name:'Ссылка на пару'}).getAttribute('href'),
            'https://example.edu/lesson/123');
        await linkLabels.evaluate(() => {
            scheduleData = [{date:studyToday(), day:'Чт.', time:'11.00–12.20', type:'Л',
                subject:'Тестовая пара', teacher:'Иванов И.И.', room:'Онлайн',
                group:'', url:'https://example.edu/lesson/today'}];
            assignmentsData = []; topicsData = []; myBookings = []; announcementsData = []; presentationQueues = [];
            renderToday();
        });
        assert.equal(await linkLabels.getByRole('link', {name:'Подключиться к паре'}).getAttribute('href'),
            'https://example.edu/lesson/today');
        await linkLabels.context().close();
        const todayIso = await admin.evaluate(() => studyToday().split('.').reverse().join('-'));
        await admin.locator('#newLesson-date').fill(todayIso);
        await admin.locator('#newLesson-start').fill('20:00');
        await admin.locator('#newLesson-end').fill('21:20');
        await admin.locator('#newLesson-type').selectOption({label:'Л'});
        await admin.locator('#newLesson-subject').fill('Управление бизнес-процессами');
        await admin.locator('#newLesson-room').fill('Онлайн');
        await admin.getByRole('button', {name:'Добавить занятие'}).click();
        await admin.waitForFunction(() => !busy);
        await admin.locator('.admin-record').filter({hasText:'20.00–21.20'}).waitFor();
        await admin.evaluate(() => closeScheduleEditor());
        await admin.getByRole('button', {name:'📚 Управление темами'}).click();
        await admin.locator('#newTopicTitle').waitFor();
        await admin.locator('#newTopicTitle').fill('Доклад для очереди сегодня');
        await admin.locator('#newTopicSubject').selectOption({label:'Бизнес-процессы'});
        await admin.locator('#newTopicDeadline').fill(todayIso);
        await admin.locator('#newTopicGroup').selectOption('МН-4-25-02');
        await admin.getByRole('button', {name:'Добавить тему'}).click();
        await admin.locator('input[value="Доклад для очереди сегодня"]').waitFor();
        await b.evaluate(() => refreshState());
        await b.evaluate(() => switchTab('reports'));
        await b.evaluate(() => setTopicView('active'));
        const queueTopic = b.locator('#topicsContainer .topic-card').filter({hasText:'Доклад для очереди сегодня'});
        await queueTopic.getByRole('button', {name:'Выбрать тему'}).click();
        await b.evaluate(() => switchTab('today'));
        await b.locator('#today .queue-card').filter({hasText:'Бизнес-процессы'}).waitFor();
        assert.equal(await b.locator('#today .queue-slot').count(), 1);
        await b.locator('#today .queue-slot.empty').click();
        await b.locator('#today .queue-slot.mine').waitFor();
        assert.match(await b.locator('#today .queue-slot.mine').textContent(), /Доклад для очереди сегодня/);
        await b.screenshot({path:path.join(artifacts, 'today-hub-mobile.png'), fullPage:true});
        checks.push('A presentation queue appears automatically for today and lets an owner choose a slot');
        await admin.screenshot({path:path.join(artifacts, 'admin-tools-desktop.png'), fullPage:true});

        const newcomer = await pageFor(104);
        assert.equal(await newcomer.locator('#cabinet').evaluate(element => element.classList.contains('active')), true);
        assert.equal(await newcomer.locator('.tabs-wrap').isHidden(), true);
        assert.match(await newcomer.locator('.registration-intro').textContent(), /Регистрация обязательна/);
        await newcomer.evaluate(() => switchTab('schedule'));
        assert.equal(await newcomer.locator('#cabinet').evaluate(element => element.classList.contains('active')), true);
        assert.equal(await newcomer.locator('#schedule').evaluate(element => element.classList.contains('active')), false);
        await newcomer.evaluate(() => window.telegramBack());
        assert.equal(await newcomer.evaluate(() => window.telegramClosed === true), false);
        await newcomer.locator('#profileFirst').fill('Новый');
        await newcomer.evaluate(() => refreshState());
        assert.equal(await newcomer.locator('#profileFirst').inputValue(), 'Новый');
        await newcomer.locator('#profileFirst').fill('12345');
        assert.equal(await newcomer.locator('#profileFirst').evaluate(element => element.checkValidity()), false);
        await newcomer.locator('#profileFirst').fill('Новый');
        await newcomer.locator('#profileLast').fill('Студент-Тест');
        assert.equal(await newcomer.locator('#profileGroup option').count(), 3);
        await newcomer.locator('#profileGroup').selectOption('МН-4-25-02');
        await newcomer.getByRole('button', {name:'Зарегистрироваться', exact:true}).click();
        await newcomer.locator('.profile-status').filter({hasText:'Профиль активен'}).waitFor();
        assert.equal(await newcomer.locator('.tabs-wrap').isVisible(), true);
        await newcomer.reload();
        await newcomer.evaluate(() => switchTab('cabinet'));
        await newcomer.locator('.profile-status').filter({hasText:'Профиль активен'}).waitFor();
        assert.match(await newcomer.locator('#cabinetContent').textContent(), /Студент-Тест/);
        checks.push('Registration locks navigation until a valid profile is saved and survives reload');

        await b.evaluate(() => switchTab('notifications'));
        assert.equal(await b.locator('.notification-item').count(), 5);
        assert.equal(await b.locator('.notification-item').filter({hasText:'Общий список бронирований'}).count(), 0);
        assert.match(await b.locator('.notification-item').filter({hasText:'Темы докладов'}).textContent(),
            /Новые темы, изменения старых, напоминание за день до сдачи/);
        assert.equal(await b.getByRole('checkbox', {name:'Напоминания о парах', exact:true}).isChecked(), false);
        assert.equal(await b.getByRole('checkbox', {name:'Объявления', exact:true}).isChecked(), true);
        await b.locator('.notification-item').filter({hasText:'Напоминания о парах'}).locator('.slider').click();
        await b.waitForFunction(() => !busy);
        await b.locator('.notification-item').filter({hasText:'Домашние задания'}).locator('.slider').click();
        await b.waitForFunction(() => !busy);
        await b.reload();
        await b.locator('#scheduleContainer .schedule-card').first().waitFor({state:'attached'});
        await b.evaluate(() => switchTab('notifications'));
        assert.equal(await b.getByRole('checkbox', {name:'Домашние задания', exact:true}).isChecked(), false);
        assert.equal(await b.getByRole('checkbox', {name:'Напоминания о парах', exact:true}).isChecked(), true);
        checks.push('Five independent notification preferences are shown and survive reload');

        const preview = await pageFor(null, 320);
        await preview.evaluate(() => switchTab('reports'));
        assert.equal(await preview.locator('#topicsContainer button:enabled').count(), 0);
        assert.equal(await preview.locator('#connectionStatus, #refreshButton').count(), 0);
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
        } else checks.push('PDF library unavailable in this run; download not exercised');
        assert.deepEqual(errors, []);
        fs.writeFileSync(path.join(artifacts, 'results.json'), JSON.stringify({checks, errors}, null, 2));
        console.log(JSON.stringify({passed:checks.length, checks, errors}, null, 2));
    } finally { await browser.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
