"use strict";

const tg = window.Telegram?.WebApp || null;
const apiBase = (window.APP_CONFIG?.apiBaseUrl || window.location.origin).replace(/\/$/, "");
let scheduleData = [], topicsData = [], assignmentsData = [], announcementsData = [];
let presentationQueues = [], studentPresentations = [];
const openStudentPresentationQueues = new Set();
const visibleStudentPresentationPlaces = new Map();
let bookings = [], myBookings = [], notificationSettings = {};
let adminTopics = [], adminLessons = [], adminAssignments = [], adminAnnouncements = [];
let adminTopicDrafts = [], adminAuditLog = [], adminStats = null;
let userData = null, isRegistered = false, isAdmin = false;
let connected = false, busy = false, editingProfile = false;
let editingTopics = false, editingSchedule = false, editingHomework = false, editingAudit = false, editingStats = false;
let editingAnnouncements = false;
let mutationVersion = 0, refreshing = false;
let currentScheduleFilter = "upcoming", studyTimezone = "Europe/Moscow";
let currentTopicSubject = "all", currentTopicView = "active", currentHomeworkView = "active";
let currentAdminTopicView = "active", currentAdminHomeworkView = "active";

const SUBJECT_SHORT_NAMES = Object.freeze({
    "Иностранный язык профессиональных коммуникаций": "Профессиональный иностранный",
    "Методы реализации научно-исследовательских проектов": "Методы НИР",
    "Проектное управление устойчивым развитием организаций": "Устойчивое развитие",
    "Развитие компетенций руководителя проекта и проектных команд": "Компетенции руководителя",
    "Управление бизнес-процессами": "Бизнес-процессы",
    "Управление программами и портфелями проектов": "Программы и портфели"
});
const ENGLISH_SUBJECT = "Иностранный язык профессиональных коммуникаций";

function shortSubject(value) {
    if (!value) return "Без предмета";
    return SUBJECT_SHORT_NAMES[value] || (value.length > 38 ? value.slice(0, 35) + "…" : value);
}

function participantCountLabel(count) {
    const lastTwo = count % 100;
    const last = count % 10;
    const word = lastTwo >= 11 && lastTwo <= 14 ? "участников"
        : last === 1 ? "участник" : last >= 2 && last <= 4 ? "участника" : "участников";
    return `${count} ${word}`;
}

function safeHttpsUrl(value) {
    if (typeof value !== "string" || !value.trim()) return "";
    try {
        const parsed = new URL(value.trim(), window.location.origin);
        return parsed.protocol === "https:" || (parsed.protocol === "http:" && parsed.origin === window.location.origin)
            ? parsed.href : "";
    } catch { return ""; }
}

function resourceButton(value, label = "Открыть материалы") {
    const url = safeHttpsUrl(value);
    if (!url) return "";
    const parsed = new URL(url);
    if (parsed.origin === window.location.origin && parsed.pathname.startsWith("/files/")) {
        const fileName = parsed.searchParams.get("name") || decodeURIComponent(parsed.pathname.split("/").pop());
        const downloadUrl = new URL(parsed.href);
        downloadUrl.searchParams.set("download", "1");
        const viewerUrl = new URL("/viewer.html", window.location.origin);
        viewerUrl.searchParams.set("file", parsed.href);
        return `<div class="resource-actions">
            <a class="btn btn-outline resource-link" href="${escapeHtml(viewerUrl.href)}">${escapeHtml(label)}</a>
            <a class="btn btn-secondary resource-download" href="${escapeHtml(downloadUrl.href)}"
                download="${escapeHtml(fileName)}" data-file-name="${escapeHtml(fileName)}"
                onclick="return downloadResource(event, this)">Скачать файл</a></div>`;
    }
    return `<a class="btn btn-outline resource-link" href="${escapeHtml(url)}"
        onclick="return openExternalResource(event, this)">${escapeHtml(label)}</a>`;
}

function openExternalResource(event, link) {
    if (tg?.openLink && link?.href?.startsWith("https://")) {
        event.preventDefault();
        tg.openLink(link.href);
        return false;
    }
    return true;
}

function downloadResource(event, link) {
    if (tg?.downloadFile && tg?.isVersionAtLeast?.("8.0")) {
        event.preventDefault();
        tg.downloadFile({url: link.href, file_name: link.dataset.fileName || "Материалы"});
        return false;
    }
    if (tg?.openLink) {
        event.preventDefault();
        tg.openLink(link.href);
        return false;
    }
    return true;
}

function registrationRequired() {
    return Boolean(tg?.initData) && connected && !isRegistered;
}

function syncRegistrationGate() {
    const required = registrationRequired();
    const wasRequired = document.body.classList.contains("registration-required");
    document.body.classList.toggle("registration-required", required);
    if (required) {
        switchTab("cabinet");
        if (!wasRequired || !document.getElementById("profileFirst")) showRegistrationForm();
    }
}

if (tg) {
    tg.ready();
    tg.expand();
    tg.BackButton?.show();
    tg.BackButton?.onClick(() => {
        if (registrationRequired()) {
            switchTab("cabinet");
            if (!document.getElementById("profileFirst")) showRegistrationForm();
            return;
        }
        tg.close();
    });
}

function formatDate(value) {
    if (!value || /^\d{2}\.\d{2}\.\d{4}$/.test(value)) return value || "—";
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? "—" : date.toLocaleDateString("ru-RU", {timeZone: studyTimezone});
}

function calendarTime(value, clock = "00.00") {
    const [day, month, year] = value.split(".").map(Number);
    const [hour, minute] = clock.trim().split(/[.:]/).map(Number);
    return Date.UTC(year, month - 1, day, hour || 0, minute || 0);
}

function lessonStart(item) { return calendarTime(item.date, item.time.split(/[–—-]/)[0]); }
function lessonEnd(item) { return calendarTime(item.date, item.time.split(/[–—-]/).at(-1)); }

function studyNow() {
    const parts = new Intl.DateTimeFormat("en-GB", {
        timeZone: studyTimezone, year: "numeric", month: "2-digit", day: "2-digit",
        hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23"
    }).formatToParts(new Date());
    const p = Object.fromEntries(parts.map(item => [item.type, item.value]));
    return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
}

function studyToday() {
    const parts = new Intl.DateTimeFormat("en-GB", {
        timeZone: studyTimezone, year: "numeric", month: "2-digit", day: "2-digit"
    }).formatToParts(new Date());
    const p = Object.fromEntries(parts.map(item => [item.type, item.value]));
    return `${p.day}.${p.month}.${p.year}`;
}

function deadlineCountdown(value) {
    if (!/^\d{2}\.\d{2}\.\d{4}$/.test(value || "")) return null;
    const days = Math.round((calendarTime(value) - calendarTime(studyToday())) / 86400000);
    if (days < 0) return {text: "Срок прошёл", className: "overdue"};
    if (days === 0) return {text: "Срок сегодня", className: "today"};
    if (days === 1) return {text: "Остался 1 день", className: "soon"};
    const lastTwo = days % 100;
    const last = days % 10;
    const ending = last === 1 && lastTwo !== 11 ? "день"
        : [2, 3, 4].includes(last) && ![12, 13, 14].includes(lastTwo) ? "дня" : "дней";
    return {text: `Осталось ${days} ${ending}`, className: days <= 3 ? "soon" : ""};
}

function deadlineCountdownMarkup(value) {
    const countdown = deadlineCountdown(value);
    return countdown
        ? `<div class="deadline-countdown ${countdown.className}">${escapeHtml(countdown.text)}</div>`
        : "";
}

async function api(path, payload) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12000);
    try {
        const headers = {};
        if (tg?.initData) headers.Authorization = "tma " + tg.initData;
        if (payload !== undefined) headers["Content-Type"] = "application/json";
        const response = await fetch(apiBase + "/api/" + path, {
            method: payload === undefined ? "GET" : "POST", headers,
            body: payload === undefined ? undefined : JSON.stringify(payload),
            signal: controller.signal, cache: "no-store"
        });
        let data;
        try { data = await response.json(); }
        catch { throw new Error("Сервер приложения недоступен. Попробуйте позже."); }
        if (!response.ok) {
            const error = new Error(data.error || "Не удалось выполнить запрос.");
            error.status = response.status;
            throw error;
        }
        return data;
    } catch (error) {
        if (error.name === "AbortError" || error instanceof TypeError) {
            throw new Error("Нет ответа сервера. Проверьте соединение и повторите действие.");
        }
        throw error;
    } finally { clearTimeout(timeout); }
}

function applyCatalog(data) {
    if (![data.schedule, data.topics, data.assignments].every(Array.isArray)) {
        throw new Error("Сервер вернул некорректные учебные данные.");
    }
    scheduleData = data.schedule;
    topicsData = data.topics;
    assignmentsData = data.assignments;
    studyTimezone = data.timezone || "Europe/Moscow";
    const period = new Intl.DateTimeFormat("ru-RU", {
        timeZone: studyTimezone, month: "long", year: "numeric"
    }).format(new Date());
    document.getElementById("headerPeriod").textContent = period[0].toUpperCase() + period.slice(1);
}

function applyState(data) {
    if (!Array.isArray(data.bookings)) throw new Error("Не удалось загрузить бронирования.");
    if (!userData && data.user) editingProfile = false;
    userData = data.user;
    isRegistered = Boolean(userData);
    isAdmin = data.isAdmin === true;
    adminTopics = isAdmin && Array.isArray(data.adminTopics) ? data.adminTopics : [];
    adminLessons = isAdmin && Array.isArray(data.adminLessons) ? data.adminLessons : [];
    adminAssignments = isAdmin && Array.isArray(data.adminAssignments) ? data.adminAssignments : [];
    adminAnnouncements = isAdmin && Array.isArray(data.adminAnnouncements) ? data.adminAnnouncements : [];
    adminTopicDrafts = isAdmin && Array.isArray(data.topicDrafts) ? data.topicDrafts : [];
    adminAuditLog = isAdmin && Array.isArray(data.auditLog) ? data.auditLog : [];
    adminStats = isAdmin && data.adminStats && typeof data.adminStats === "object" ? data.adminStats : null;
    bookings = data.bookings;
    myBookings = bookings.filter(item => item.isMine);
    announcementsData = Array.isArray(data.announcements) ? data.announcements : [];
    studentPresentations = Array.isArray(data.studentPresentations) ? data.studentPresentations : [];
    presentationQueues = Array.isArray(data.presentationQueues) ? data.presentationQueues : [];
    notificationSettings = data.notifications || {};
    connected = true;
    const adminTab = document.querySelector('.tab[data-tab="admin"]');
    if (adminTab) adminTab.hidden = !isAdmin;
    if (!isAdmin && document.getElementById("admin")?.classList.contains("active")) switchTab("cabinet");
    syncRegistrationGate();
}

async function uploadAdminFile(inputId) {
    const input = document.getElementById(inputId);
    const file = input?.files?.[0];
    if (!file) return "";
    if (file.size > 10 * 1024 * 1024) throw new Error("Файл должен быть не больше 10 МБ.");
    const form = new FormData();
    form.append("file", file);
    const headers = {};
    if (tg?.initData) headers.Authorization = "tma " + tg.initData;
    showStatus("Загружаем файл…", 15000);
    const response = await fetch(apiBase + "/api/upload", {method: "POST", headers, body: form});
    let data;
    try { data = await response.json(); }
    catch { throw new Error("Сервер не смог загрузить файл."); }
    if (!response.ok) throw new Error(data.error || "Не удалось загрузить файл.");
    return new URL(data.path, window.location.origin).href;
}

async function materialUrl(urlInputId, fileInputId) {
    return await uploadAdminFile(fileInputId) || document.getElementById(urlInputId).value.trim();
}

function renderAll() {
    renderToday();
    renderSchedule();
    renderTopics();
    renderHomework();
    renderNotifications();
    if (!editingProfile) renderCabinet();
    if (isAdmin) {
        if (editingStats) renderAdminStats();
        else if (!editingTopics && !editingSchedule && !editingHomework && !editingAudit && !editingAnnouncements) renderAdmin();
    }
    document.querySelectorAll('#cabinetContent button[type="submit"], #adminContent button[type="submit"]').forEach(button => {
        button.disabled = !connected || busy;
    });
}

async function refreshState() {
    if (!tg?.initData || refreshing || busy || document.hidden) return;
    refreshing = true;
    const version = mutationVersion;
    try {
        const synchronized = await api("sync");
        if (version !== mutationVersion || busy) return;
        applyCatalog(synchronized.catalog);
        applyState(synchronized.state);
        renderAll();
    } catch (error) {
        if (version !== mutationVersion) return;
        const connectionWasAvailable = connected;
        connected = false;
        if (connectionWasAvailable) showStatus(error.message, 5000);
        renderTopics();
        renderNotifications();
    } finally { refreshing = false; }
}

async function performAction(data) {
    if (busy) return false;
    if (!connected || !tg?.initData) {
        showStatus("Откройте приложение через бота и дождитесь подключения.");
        return false;
    }
    busy = true;
    mutationVersion++;
    renderTopics();
    renderNotifications();
    try {
        const result = await api("action", data);
        applyCatalog(result.catalog);
        applyState(result.state);
        showStatus(result.message);
        return true;
    } catch (error) {
        showStatus(error.message, 5000);
        // A timed-out response may still have committed. Read the actual state.
        try {
            const synchronized = await api("sync");
            applyCatalog(synchronized.catalog);
            applyState(synchronized.state);
        }
        catch { connected = false; }
        return false;
    } finally {
        busy = false;
        renderAll();
    }
}

function nearestEvents() {
    const today = studyToday();
    const start = calendarTime(today);
    const end = start + 7 * 86400000 + 86399999;
    const events = [];
    scheduleData.forEach(lesson => {
        const when = lessonStart(lesson);
        if (calendarTime(lesson.date) > start && when <= end) events.push({
            kind: "Пара", title: lesson.subject, lessonId: lesson.id,
            dateLabel: lesson.date, details: `${lesson.time}${lesson.teacher ? ` · ${lesson.teacher}` : ""}`,
            when, url: lesson.url || ""
        });
    });
    assignmentsData.filter(item => !item.archived).forEach(item => {
        const when = calendarTime(item.deadline, "23.59");
        if (calendarTime(item.deadline) > start && when <= end) events.push({
            kind: "Домашка", title: item.subject,
            dateLabel: item.deadline, details: item.description, when, url: item.url || ""
        });
    });
    const myTopicIds = new Set(myBookings.map(item => item.id));
    topicsData.filter(item => myTopicIds.has(item.id) && !item.archived && item.deadline).forEach(item => {
        const when = calendarTime(item.deadline, "23.59");
        if (calendarTime(item.deadline) > start && when <= end) events.push({
            kind: "Доклад", title: item.title,
            dateLabel: item.deadline, details: shortSubject(item.subject), when, url: item.url || ""
        });
    });
    return events.sort((a, b) => a.when - b.when || a.kind.localeCompare(b.kind, "ru")).slice(0, 3);
}

function todayDeadlineEvents() {
    const today = studyToday();
    const events = assignmentsData
        .filter(item => !item.archived && item.deadline === today)
        .map(item => ({
            kind: "Домашка", title: item.subject,
            details: item.description, url: item.url || ""
        }));
    const myTopicIds = new Set(myBookings.map(item => item.id));
    topicsData
        .filter(item => myTopicIds.has(item.id) && !item.archived && item.deadline === today)
        .forEach(item => events.push({
            kind: "Доклад", title: item.title,
            details: shortSubject(item.subject), url: item.url || ""
        }));
    return events.sort((a, b) => a.kind.localeCompare(b.kind, "ru") || a.title.localeCompare(b.title, "ru"));
}

function renderToday() {
    const container = document.getElementById("todayContent");
    if (!container) return;
    const today = studyToday();
    const lessons = scheduleData.filter(item => item.date === today).sort((a, b) => lessonStart(a) - lessonStart(b));
    const deadlines = todayDeadlineEvents();
    const announcements = announcementsData.slice(0, 3);
    const nearest = nearestEvents();
    const nearestLessonIds = new Set(nearest.map(item => item.lessonId).filter(Boolean));
    const additionalPresentationLessons = studentPresentations.filter(item =>
        item.date !== today && !nearestLessonIds.has(item.lessonId));
    const announcementSection = announcements.length ? `<section class="hub-section">
        <h3>Объявления</h3><div class="hub-list">${announcements.map(item => `<article class="hub-card announcement-card">
            <strong>${escapeHtml(item.title)}</strong><p>${escapeHtml(item.body)}</p>
            ${resourceButton(item.url, "Открыть")}</article>`).join("")}</div></section>` : "";
    const lessonSection = lessons.length || deadlines.length ? `<section class="hub-section"><h3>Сегодня</h3>
        <div class="hub-list">${lessons.map(item => `<article class="hub-card today-lesson">
            <div class="hub-card-top"><strong>${escapeHtml(item.subject)}</strong><span>${escapeHtml(item.time)}</span></div>
            <p>${escapeHtml([item.teacher, item.room].filter(Boolean).join(" · ") || "Детали не указаны")}</p>
            ${resourceButton(item.url, "Подключиться к паре")}${renderStudentPresentationQueue(item.id)}</article>`).join("")}
            ${deadlines.map(item => `<article class="hub-card today-deadline">
                <div class="hub-card-top"><strong>${escapeHtml(item.kind)}</strong><span>Срок сегодня</span></div>
                <h4>${escapeHtml(item.title)}</h4><p>${escapeHtml(item.details)}</p>
                ${resourceButton(item.url, "Открыть материалы")}</article>`).join("")}</div></section>` : "";
    const queueSection = presentationQueues.length ? `<section class="hub-section"><h3>Очередь докладов</h3>
        <div class="hub-list">${presentationQueues.map((queue, queueIndex) => renderPresentationQueue(queue, queueIndex)).join("")}</div></section>` : "";
    const nearestSection = `<section class="hub-section"><h3>Ближайшее</h3>
        <div class="hub-list">${nearest.length ? nearest.map(item => `<article class="hub-card nearby-item">
            <div class="hub-card-top"><strong>${escapeHtml(item.kind)}</strong><span>${escapeHtml(item.dateLabel)}</span></div>
            <h4>${escapeHtml(item.title)}</h4><p>${escapeHtml(item.details)}</p>${resourceButton(
                item.url, item.kind === "Пара" ? "Ссылка на пару" : "Открыть материалы")}
            ${item.lessonId ? renderStudentPresentationQueue(item.lessonId) : ""}
        </article>`).join("") : '<div class="empty-state compact">На ближайшие семь дней событий нет.</div>'}</div></section>`;
    const additionalPresentationsSection = additionalPresentationLessons.length ? `<section class="hub-section">
        <h3>Выступления</h3><div class="hub-list">${additionalPresentationLessons.map(item => `<article class="hub-card nearby-item">
            <div class="hub-card-top"><strong>${escapeHtml(item.subject)}</strong><span>${escapeHtml(item.date)} · ${escapeHtml(item.time)}</span></div>
            <p>${escapeHtml([item.teacher, item.room].filter(Boolean).join(" · "))}</p>
            ${renderStudentPresentationQueue(item.lessonId)}</article>`).join("")}</div></section>` : "";
    container.innerHTML = `${announcementSection}${lessonSection}${queueSection}${nearestSection}${additionalPresentationsSection}`;
}

function renderStudentPresentationQueue(lessonId) {
    const queue = studentPresentations.find(item => item.lessonId === lessonId);
    if (!queue) return "";
    const entries = queue.entries || [];
    if (!queue.editable && !entries.length) return "";
    const occupied = new Map(entries.map(item => [item.position, item]));
    const own = entries.find(item => item.isMine);
    const firstFree = Array.from({length: queue.slotCount}, (_, index) => index + 1)
        .find(position => !occupied.has(position));
    const selectedPosition = own?.position || firstFree || queue.slotCount;
    const placeCount = queue.editable ? queue.slotCount : entries.length;
    const visibleCount = Math.min(placeCount, Math.max(10,
        visibleStudentPresentationPlaces.get(lessonId) || 10));
    const slots = queue.editable
        ? Array.from({length: visibleCount}, (_, index) => {
            const position = index + 1;
            const entry = occupied.get(position);
            return entry
                ? `<li class="student-presentation-place occupied ${entry.isMine ? "mine" : ""}">
                    <b>${position}</b><div><strong>${escapeHtml(entry.name)}</strong><span>${escapeHtml(entry.topic)}</span></div></li>`
                : `<li class="student-presentation-place empty"><b>${position}</b><span>Свободно</span></li>`;
        }).join("")
        : entries.slice(0, visibleCount).map(entry =>
            `<li class="student-presentation-place occupied ${entry.isMine ? "mine" : ""}">
                <b>${entry.position}</b><div><strong>${escapeHtml(entry.name)}</strong><span>${escapeHtml(entry.topic)}</span></div></li>`
        ).join("");
    const options = Array.from({length: queue.slotCount}, (_, index) => {
        const position = index + 1;
        const entry = occupied.get(position);
        const label = entry ? `${position} — ${entry.name}${entry.isMine ? " (вы)" : ""}` : String(position);
        return `<option value="${position}" ${position === selectedPosition ? "selected" : ""}>${escapeHtml(label)}</option>`;
    }).join("");
    const remainingPlaces = placeCount - visibleCount;
    return `<details class="student-presentation" ${openStudentPresentationQueues.has(lessonId) ? "open" : ""}
        ontoggle="setStudentPresentationOpen(${lessonId}, this.open)">
        <summary>Список выступающих · ${participantCountLabel(entries.length)}</summary>
        <ol class="student-presentation-places">${slots}</ol>
        ${remainingPlaces > 0 ? `<button class="btn btn-outline student-presentation-more"
            onclick="showMoreStudentPresentationPlaces(${lessonId})">Показать ещё ${Math.min(10, remainingPlaces)}</button>` : ""}
        ${queue.editable ? `<div class="student-presentation-form">
            <label class="form-label" for="student-presentation-topic-${lessonId}">Тема</label>
            <input class="form-control" id="student-presentation-topic-${lessonId}" maxlength="200"
                placeholder="Тема выступления" value="${escapeHtml(own?.topic || "")}">
            <label class="form-label" for="student-presentation-position-${lessonId}">Место</label>
            <select class="form-control" id="student-presentation-position-${lessonId}">${options}</select>
            <button class="btn btn-primary" ${busy || !connected ? "disabled" : ""}
                onclick="saveStudentPresentation(${lessonId})">${own ? "Сохранить" : "Записаться"}</button>
            <small>Тему и место можно менять до конца пары.</small></div>` : ""}
        </details>`;
}

function setStudentPresentationOpen(lessonId, isOpen) {
    if (isOpen) openStudentPresentationQueues.add(lessonId);
    else openStudentPresentationQueues.delete(lessonId);
}

function showMoreStudentPresentationPlaces(lessonId) {
    const queue = studentPresentations.find(item => item.lessonId === lessonId);
    if (!queue) return;
    const visibleCount = Math.max(10, visibleStudentPresentationPlaces.get(lessonId) || 10);
    visibleStudentPresentationPlaces.set(lessonId, Math.min(queue.slotCount, visibleCount + 10));
    renderToday();
}

async function saveStudentPresentation(lessonId) {
    const topic = document.getElementById(`student-presentation-topic-${lessonId}`)?.value.trim();
    const position = Number(document.getElementById(`student-presentation-position-${lessonId}`)?.value);
    const queue = studentPresentations.find(item => item.lessonId === lessonId);
    const own = queue?.entries?.find(item => item.isMine);
    const occupant = queue?.entries?.find(item => item.position === position);
    let confirmOccupied = false;
    let expectedOccupantId = null;
    if (occupant && !occupant.isMine) {
        const prompt = own
            ? `Место ${position} занято ${occupant.name}. Поменяться местами?`
            : `Место ${position} занято ${occupant.name}. Встать сюда и сдвинуть выступающих ниже на одно место?`;
        const confirmed = typeof tg?.showConfirm === "function"
            ? await new Promise(resolve => tg.showConfirm(prompt, resolve))
            : window.confirm(prompt);
        if (!confirmed) return;
        confirmOccupied = true;
        expectedOccupantId = occupant.presentationId;
    }
    await performAction({action: "save_student_presentation", lessonId, topic, position,
        confirmOccupied, expectedOccupantId});
}

function renderPresentationQueue(queue, queueIndex) {
    const positioned = new Map(queue.reports.filter(item => item.position).map(item => [item.position, item]));
    const mine = queue.reports.filter(item => item.isMine);
    const options = mine.map(item => `<option value="${item.topicId}">${escapeHtml(item.title)}${item.position ? ` · место ${item.position}` : ""}</option>`).join("");
    const slots = Array.from({length: queue.slotCount}, (_, offset) => {
        const position = offset + 1;
        const report = positioned.get(position);
        if (!report) return `<button class="queue-slot empty" ${!mine.length || busy || !connected ? "disabled" : ""}
            onclick="chooseQueueSlot(${queueIndex}, ${position})"><b>${position}</b><span>Свободно</span></button>`;
        return `<div class="queue-slot occupied ${report.isMine ? "mine" : ""}"><b>${position}</b>
            <strong>${escapeHtml(report.title)}</strong>
            <span>${escapeHtml(report.owners.map(owner => owner.name).join(", "))}</span>
            ${report.isMine ? `<button class="btn btn-secondary btn-small" onclick="leavePresentationQueue(${queueIndex}, ${report.topicId})">Освободить</button>` : ""}</div>`;
    }).join("");
    return `<article class="hub-card queue-card"><div class="hub-card-top"><strong>${escapeHtml(shortSubject(queue.subject))}</strong>
        <span>${escapeHtml(queue.times.join(", "))}</span></div>
        <p>${escapeHtml([queue.teacher, queue.room].filter(Boolean).join(" · "))}</p>
        ${mine.length ? `<label class="form-label" for="queue-topic-${queueIndex}">Мой доклад</label>
        <select class="form-control queue-topic-select" id="queue-topic-${queueIndex}">${options}</select>` : ""}
        <div class="queue-slots">${slots}</div></article>`;
}

async function chooseQueueSlot(queueIndex, position) {
    const queue = presentationQueues[queueIndex];
    const topicId = Number(document.getElementById(`queue-topic-${queueIndex}`)?.value);
    if (!queue || !topicId) return;
    await performAction({action: "choose_presentation_position", date: queue.date,
        subject: queue.subject, topicId, position});
}

async function leavePresentationQueue(queueIndex, topicId) {
    const queue = presentationQueues[queueIndex];
    if (!queue) return;
    await performAction({action: "leave_presentation_queue", date: queue.date,
        subject: queue.subject, topicId});
}

function renderTopics() {
    const container = document.getElementById("topicsContainer");
    const filters = document.getElementById("topicSubjectFilters");
    const archiveFilters = document.getElementById("topicArchiveFilters");
    archiveFilters.innerHTML = [{value: "active", label: "Актуальные"}, {value: "archive", label: "Архив"}]
        .map(item => `<button class="filter-btn ${currentTopicView === item.value ? "active" : ""}"
            onclick="setTopicView('${item.value}')">${item.label}</button>`).join("");
    const topicPool = topicsData.filter(topic => Boolean(topic.archived) === (currentTopicView === "archive"));
    const subjects = [...new Set(topicPool.map(topic => topic.subject || ""))]
        .sort((a, b) => shortSubject(a).localeCompare(shortSubject(b), "ru"));
    if ((currentTopicSubject === "mine" && !isRegistered) ||
            (currentTopicSubject !== "all" && currentTopicSubject !== "mine" && !subjects.includes(currentTopicSubject))) {
        currentTopicSubject = "all";
    }
    const topicPoolIds = new Set(topicPool.map(topic => topic.id));
    const myVisibleCount = new Set(myBookings.filter(item => topicPoolIds.has(item.id)).map(item => item.id)).size;
    filters.innerHTML = [{value: "all", label: "Все предметы"},
        ...(isRegistered ? [{value: "mine", label: `Мои доклады · ${myVisibleCount}`}] : []),
        ...subjects.map(subject => ({value: subject, label: shortSubject(subject)}))]
        .map(item => `<button class="filter-btn ${currentTopicSubject === item.value ? "active" : ""}"
            data-topic-subject="${escapeHtml(item.value)}" title="${escapeHtml(item.value === "all" ? item.label : (item.value || item.label))}">
            ${escapeHtml(item.label)}</button>`).join("");
    filters.querySelectorAll("[data-topic-subject]").forEach(button => {
        button.addEventListener("click", () => {
            currentTopicSubject = button.dataset.topicSubject;
            renderTopics();
        });
    });

    const myTopicIds = new Set(myBookings.map(item => item.id));
    const visibleTopics = (currentTopicSubject === "all" ? topicPool
        : currentTopicSubject === "mine" ? topicPool.filter(topic => myTopicIds.has(topic.id))
            : topicPool.filter(topic => (topic.subject || "") === currentTopicSubject))
        .sort((a, b) => (a.subject || "").localeCompare(b.subject || "", "ru") ||
            a.number - b.number || a.id - b.id);
    container.innerHTML = visibleTopics.length ? visibleTopics.map(topic => {
        const {owners, mine, occupied, status} = topicBookingState(topic);
        const disabled = !connected || busy || topic.archived || (!mine && occupied);
        const scope = topic.isCommon ? "Общий для групп" : `Для ${topic.group}`;
        return `<article class="topic-card ${mine ? "booked" : ""} ${topic.archived ? "archived" : ""}">
            <div class="topic-number">${topic.number}</div>
            <div class="topic-title">${escapeHtml(topic.title)}</div>
            <div class="booking-owner" title="${escapeHtml(topic.subject || "Предмет не указан")}"> ${escapeHtml(shortSubject(topic.subject))}</div>
            <div class="booking-owner">Срок: ${escapeHtml(topic.deadline || "Не назначен")}</div>
            ${deadlineCountdownMarkup(topic.deadline)}
            <div class="booking-owner"> ${escapeHtml(scope)}</div>
            ${topic.isMulti ? '<div class="booking-owner"> Несколько выступающих</div>' : ""}
            ${owners.map(b => `<div class="booking-owner"> ${escapeHtml(b.group)} · ${escapeHtml(b.user)}${b.isMine ? " (вы)" : ""}</div>`).join("")}
            ${occupied ? `<div class="topic-status">${escapeHtml(status)}</div>` : ""}
            ${resourceButton(topic.url)}
            ${topic.archived ? '<div class="archive-label">Архив</div>' : `<button class="btn ${mine ? "btn-danger" : "btn-primary"}"
                onclick="${mine ? "cancelBooking" : "handleTopicBooking"}(${topic.id})" ${disabled ? "disabled" : ""}>
                ${mine ? "Отменить выбор" : "Выбрать тему"}</button>`}
        </article>`;
    }).join("") : `<div class="empty-state">${currentTopicSubject === "mine"
        ? "Здесь пока нет ваших докладов."
        : currentTopicView === "archive" ? "В архиве пока нет докладов." : "По этому предмету тем пока нет."}</div>`;
    const visibleIds = new Set(visibleTopics.map(topic => topic.id));
    document.getElementById("topicsCount").textContent = visibleTopics.length;
    document.getElementById("bookedTopicsCount").textContent = new Set(
        bookings.filter(item => visibleIds.has(item.id)).map(item => item.id)
    ).size;
    const occupiedIds = new Set(bookings.map(item => item.id));
    document.getElementById("availableTopicsCount").textContent = isRegistered && currentTopicView === "active"
        ? visibleTopics.filter(topic => !occupiedIds.has(topic.id)).length : "—";
}

function setTopicView(value) {
    currentTopicView = value === "archive" ? "archive" : "active";
    currentTopicSubject = "all";
    renderTopics();
}

function topicBookingState(topic) {
    const owners = bookings.filter(item => item.id === topic.id);
    const mine = owners.some(item => item.isMine);
    let occupied = false;
    let status = "";
    if (!mine && owners.length) {
        if (topic.isCommon) {
            if (!topic.isMulti) {
                occupied = true;
                status = "Общий доклад уже занят";
            } else if (!owners.some(item => item.group === userData?.group_name)) {
                occupied = true;
                status = "Доклад уже закреплён за другой группой";
            }
        } else if (!topic.isMulti) {
            occupied = true;
            status = "Тема уже занята";
        }
    }
    return {owners, mine, occupied, status};
}

async function handleTopicBooking(topicId) {
    if (!isRegistered) { switchTab("cabinet"); showRegistrationForm(); return; }
    await performAction({action: "book_topic", topicId});
}

async function cancelBooking(topicId) {
    await performAction({action: "cancel_topic", topicId});
}

function validateNameInput(element) {
    const valid = /^\p{L}+(?:[-'’]\p{L}+)*$/u.test(element.value);
    element.setCustomValidity(element.value && !valid ? "Используйте только буквы, дефис или апостроф." : "");
}

function profileForm(edit = false) {
    const source = edit ? userData : (tg?.initDataUnsafe?.user || {});
    const group = source?.group_name || "";
    return `<div class="profile-card card">
        ${edit ? "" : `<div class="registration-intro">
            <strong>Регистрация обязательна</strong>
            <span>Заполните имя, фамилию и учебную группу. После регистрации откроются остальные разделы приложения.</span>
        </div>`}
        <h3 class="section-title">${edit ? "Редактирование профиля" : "Регистрация"}</h3>
        <form onsubmit="event.preventDefault(); ${edit ? "saveProfile" : "registerUser"}()">
        <div class="form-group"><label class="form-label" for="profileFirst">Имя</label>
        <input id="profileFirst" class="form-control" minlength="2" maxlength="50" oninput="validateNameInput(this)" title="Только буквы, дефис или апостроф" required value="${escapeHtml(source?.first_name || "")}"></div>
        <div class="form-group"><label class="form-label" for="profileLast">Фамилия</label>
        <input id="profileLast" class="form-control" minlength="2" maxlength="50" oninput="validateNameInput(this)" title="Только буквы, дефис или апостроф" required value="${escapeHtml(source?.last_name || "")}"></div>
        <div class="form-group"><label class="form-label" for="profileGroup">Учебная группа</label>
        <select id="profileGroup" class="form-control" required>
            <option value="" ${group ? "" : "selected"} disabled>Выберите группу</option>
            <option value="МН-4-25-01" ${group === "МН-4-25-01" ? "selected" : ""}>МН-4-25-01</option>
            <option value="МН-4-25-02" ${group === "МН-4-25-02" ? "selected" : ""}>МН-4-25-02</option>
        </select></div>
        <button class="btn btn-primary" type="submit" ${!connected ? "disabled" : ""}>${edit ? "Сохранить изменения" : "Зарегистрироваться"}</button>
        ${edit ? '<button class="btn btn-secondary" type="button" onclick="cancelProfileEdit()">Отмена</button>' : ""}
        </form></div>`;
}

function showRegistrationForm() {
    editingProfile = true;
    document.getElementById("cabinetContent").innerHTML = profileForm(false);
}

function editProfile() {
    editingProfile = true;
    document.getElementById("cabinetContent").innerHTML = profileForm(true);
}

function cancelProfileEdit() { editingProfile = false; renderCabinet(); }

async function submitProfile(action) {
    const user = {first_name: document.getElementById("profileFirst").value.trim(),
        last_name: document.getElementById("profileLast").value.trim(),
        group_name: document.getElementById("profileGroup").value.trim()};
    if (await performAction({action, user})) { editingProfile = false; renderAll(); }
}

async function registerUser() { return submitProfile("register"); }
async function saveProfile() { return submitProfile("edit_profile"); }

function renderCabinet() {
    if (!isRegistered) { showRegistrationForm(); return; }
    document.getElementById("cabinetContent").innerHTML = `<div class="profile-card card">
        <div class="profile-header"><div class="profile-avatar">СП</div>
        <div><div class="profile-name">${escapeHtml(userData.name)}</div><div class="profile-status">Профиль активен</div></div></div>
        <div class="info-item mb-12"><span class="label">Группа</span><span class="value">${escapeHtml(userData.group_name)}</span></div>
        <div class="info-item mb-12"><span class="label">Telegram</span><span class="value">${escapeHtml(userData.username ? "@" + userData.username : "Не указан")}</span></div>
        <button class="btn btn-outline" onclick="editProfile()">Редактировать профиль</button></div>
        <div class="profile-card card"><h3 class="section-title">Моя активность</h3>
        <p>Выбранных тем: ${new Set(myBookings.filter(item => topicsData.some(topic => topic.id === item.id && !topic.archived)).map(item => item.id)).size}</p><p>Проведено занятий: ${scheduleData.filter(i => lessonEnd(i) < studyNow()).length}</p>
        <p>Домашних заданий: ${assignmentsData.filter(item => !item.archived).length}</p></div>`;
}

function renderAdmin() {
    if (!isAdmin) return;
    editingTopics = false;
    editingSchedule = false;
    editingHomework = false;
    editingAudit = false;
    editingStats = false;
    editingAnnouncements = false;
    document.getElementById("adminContent").innerHTML = `<div class="profile-card card">
        <h3 class="section-title">Управление</h3>
        <div class="admin-actions">
        <button class="btn btn-primary" onclick="openTopicEditor()">Управление темами</button>
        <button class="btn btn-primary" onclick="openHomeworkEditor()">Управление домашкой</button>
        <button class="btn btn-primary" onclick="renderScheduleEditor()">Управление расписанием</button>
        <button class="btn btn-primary" onclick="renderAnnouncementEditor()">Объявления</button>
        <button class="btn btn-primary" onclick="renderAdminStats()">Статистика</button>
        <button class="btn btn-outline" onclick="renderAuditLog()">История действий</button>
        </div></div>`;
}

function dateInputValue(value) {
    return /^\d{2}\.\d{2}\.\d{4}$/.test(value || "") ? value.split(".").reverse().join("-") : "";
}

function apiDate(value) { return value ? value.split("-").reverse().join(".") : ""; }

function renderTopicEditor() {
    if (!isAdmin) return;
    editingSchedule = false;
    editingHomework = false;
    editingAudit = false;
    editingStats = false;
    editingAnnouncements = false;
    editingTopics = true;
    const subjectOptions = [...new Set(scheduleData.map(item => item.subject).filter(Boolean))]
        .sort((a, b) => shortSubject(a).localeCompare(shortSubject(b), "ru"));
    const selectOptions = selected => `<option value="">Выберите предмет</option>${subjectOptions.map(subject =>
        `<option value="${escapeHtml(subject)}" ${subject === selected ? "selected" : ""}>${escapeHtml(shortSubject(subject))}</option>`).join("")}`;
    const groupOptions = selected => ["МН-4-25-01", "МН-4-25-02"].map(group =>
        `<option value="${group}" ${group === selected ? "selected" : ""}>${group}</option>`).join("");
    const topicCounts = {active: adminTopics.filter(item => !item.archived).length,
        archive: adminTopics.filter(item => item.archived).length};
    const sortedAdminTopics = adminTopics.filter(item => Boolean(item.archived) === (currentAdminTopicView === "archive")).sort((a, b) =>
        (a.subject || "").localeCompare(b.subject || "", "ru") || a.number - b.number || a.id - b.id);
    document.getElementById("adminContent").innerHTML = `<div class="profile-card card admin-editor">
        <h3 class="section-title">Управление темами</h3>
        <div class="filter-row">${[{value: "active", label: `Актуальные · ${topicCounts.active}`},
            {value: "archive", label: `Архив · ${topicCounts.archive}`}].map(item =>
            `<button class="filter-btn ${currentAdminTopicView === item.value ? "active" : ""}"
                onclick="setAdminTopicView('${item.value}')">${item.label}</button>`).join("")}</div>
        <div ${currentAdminTopicView === "archive" ? "hidden" : ""}>
        <h4>Добавить тему доклада</h4>
        <div class="admin-create-grid">
            <div><label class="form-label" for="newTopicTitle">Название новой темы</label>
            <input class="form-control" id="newTopicTitle" maxlength="200" placeholder="Введите название"></div>
            <div><label class="form-label" for="newTopicSubject">Предмет</label>
            <select class="form-control" id="newTopicSubject">${selectOptions("")}</select></div>
            <div><label class="form-label" for="newTopicNumber">Номер по предмету, необязательно</label>
            <input class="form-control" type="number" min="1" max="9999" id="newTopicNumber" placeholder="Назначится автоматически"></div>
            <div><label class="form-label" for="newTopicDeadline">Срок доклада, необязательно</label>
            <input class="form-control" type="date" id="newTopicDeadline"></div>
            <div class="wide"><label class="form-label" for="newTopicUrl">Ссылка, необязательно</label>
            <input class="form-control" type="url" id="newTopicUrl" maxlength="1000" placeholder="https://..."></div>
            <div class="wide"><label class="form-label" for="newTopicFile">Или прикрепить файл, до 10 МБ</label>
            <input class="form-control file-control" type="file" id="newTopicFile" accept=".pdf,.doc,.docx,.ppt,.pptx,.xls,.xlsx,.odt,.ods,.txt,.png,.jpg,.jpeg,.zip"></div>
            <div><label class="form-label" for="newTopicGroup">Группа</label>
            <select class="form-control" id="newTopicGroup">${groupOptions("МН-4-25-01")}</select></div>
            <label><input type="checkbox" id="newTopicCommon" onchange="syncTopicScope('newTopic')"> Общий доклад</label>
            <label><input type="checkbox" id="newTopicMulti"> Несколько выступающих</label>
        </div>
        <button class="btn btn-primary" onclick="createTopic()">Добавить тему</button>
        <div class="draft-panel">
            <h4>Массовое добавление через черновик</h4>
            <p class="draft-help">Вставьте темы построчно. Предмет, срок и доступность применятся ко всему списку.</p>
            <label class="form-label" for="draftTopicTitles">Названия тем — по одной в строке</label>
            <textarea class="form-control" id="draftTopicTitles" maxlength="10000" rows="7" placeholder="1. Первая тема\n2. Вторая тема\n3. Третья тема"></textarea>
            <div class="admin-create-grid">
                <div><label class="form-label" for="draftTopicSubject">Предмет</label>
                <select class="form-control" id="draftTopicSubject">${selectOptions("")}</select></div>
                <div><label class="form-label" for="draftTopicStartNumber">Начальный номер, необязательно</label>
                <input class="form-control" type="number" min="1" max="9999" id="draftTopicStartNumber" placeholder="Назначатся автоматически"></div>
                <div><label class="form-label" for="draftTopicDeadline">Срок, необязательно</label>
                <input class="form-control" type="date" id="draftTopicDeadline"></div>
                <div class="wide"><label class="form-label" for="draftTopicUrl">Ссылка для всех тем, необязательно</label>
                <input class="form-control" type="url" id="draftTopicUrl" maxlength="1000" placeholder="https://..."></div>
                <div class="wide"><label class="form-label" for="draftTopicFile">Или общий файл, до 10 МБ</label>
                <input class="form-control file-control" type="file" id="draftTopicFile" accept=".pdf,.doc,.docx,.ppt,.pptx,.xls,.xlsx,.odt,.ods,.txt,.png,.jpg,.jpeg,.zip"></div>
                <div><label class="form-label" for="draftTopicGroup">Группа</label>
                <select class="form-control" id="draftTopicGroup">${groupOptions("МН-4-25-01")}</select></div>
                <label><input type="checkbox" id="draftTopicCommon" onchange="syncTopicScope('draftTopic')"> Общий доклад</label>
                <label><input type="checkbox" id="draftTopicMulti"> Несколько выступающих</label>
            </div>
            <button class="btn btn-outline" onclick="addTopicDrafts()">Добавить список в черновик</button>
            ${adminTopicDrafts.length ? `<div class="draft-list">${adminTopicDrafts.map(item => `
                <div class="draft-item"><div><strong>${item.number ? `№${item.number} · ` : ""}${escapeHtml(item.title)}</strong>
                <span>${escapeHtml(shortSubject(item.subject))} · ${escapeHtml(item.isCommon ? "Для всех" : item.group)}${item.deadline ? ` · ${escapeHtml(item.deadline)}` : ""}${item.url ? " · Есть ссылка" : ""}</span></div>
                <button class="btn btn-danger btn-small" onclick="deleteTopicDraft(${item.id})">Убрать</button></div>`).join("")}</div>
                <h4>Предварительный просмотр рассылки</h4>
                <pre class="notification-preview">${escapeHtml(topicDraftPreview())}</pre>
                <div class="admin-actions">
                    <button class="btn btn-primary" onclick="publishTopicDrafts()">Опубликовать ${adminTopicDrafts.length} тем</button>
                    <button class="btn btn-secondary" onclick="clearTopicDrafts()">Очистить черновик</button>
                </div>` : '<div class="empty-state compact">Черновик пуст. Он сохраняется после закрытия приложения.</div>'}
        </div>
        </div>
        <div class="admin-records">${sortedAdminTopics.map(topic => `${topic.archived
            ? `<details class="admin-record archived"><summary>№${topic.number} · ${escapeHtml(topic.title)} · ${escapeHtml(shortSubject(topic.subject))}</summary>`
            : `<article class="admin-record"><div class="admin-record-heading"><strong>№${topic.number}</strong><span>Активна</span></div>`}
            <label class="form-label" for="topic-title-${topic.id}">Название</label>
            <input class="form-control" id="topic-title-${topic.id}" maxlength="200" value="${escapeHtml(topic.title)}">
            <label class="form-label" for="topic-subject-${topic.id}">Предмет</label>
            <select class="form-control" id="topic-subject-${topic.id}">${selectOptions(topic.subject || "")}</select>
            <label class="form-label" for="topic-number-${topic.id}">Номер по предмету</label>
            <input class="form-control" type="number" min="1" max="9999" id="topic-number-${topic.id}" value="${topic.number}">
            <label class="form-label" for="topic-deadline-${topic.id}">Срок доклада</label>
            <input class="form-control" type="date" id="topic-deadline-${topic.id}" value="${dateInputValue(topic.deadline)}">
            <label class="form-label" for="topic-url-${topic.id}">Ссылка</label>
            <input class="form-control" type="url" id="topic-url-${topic.id}" maxlength="1000" placeholder="https://..." value="${escapeHtml(topic.url || "")}">
            <label class="form-label" for="topic-file-${topic.id}">Заменить ссылку прикреплённым файлом</label>
            <input class="form-control file-control" type="file" id="topic-file-${topic.id}" accept=".pdf,.doc,.docx,.ppt,.pptx,.xls,.xlsx,.odt,.ods,.txt,.png,.jpg,.jpeg,.zip">
            <label class="form-label" for="topic-group-${topic.id}">Группа</label>
            <select class="form-control" id="topic-group-${topic.id}" ${topic.isCommon ? "disabled" : ""}>${groupOptions(topic.group || "МН-4-25-01")}</select>
            <label><input type="checkbox" id="topic-common-${topic.id}" ${topic.isCommon ? "checked" : ""}
                onchange="syncTopicScope('topic-${topic.id}')"> Общий доклад</label>
            <label><input type="checkbox" id="topic-multi-${topic.id}" ${topic.isMulti ? "checked" : ""}> Несколько выступающих</label>
            <div class="admin-bookings">${topic.bookings.length ? topic.bookings.map(item =>
                `<div class="admin-booking"><span> ${escapeHtml(item.group)} · ${escapeHtml(item.user)}</span>
                <button class="btn btn-danger btn-small" onclick="removeBooking(${item.bookingId})">Снять бронь</button></div>`).join("") : "Бронирований нет"}</div>
            <div class="admin-actions">
                <button class="btn btn-outline" onclick="saveTopic(${topic.id})">Сохранить</button>
                ${topic.archived ? (!topic.active ? `<button class="btn btn-secondary" onclick="toggleTopic(${topic.id}, true)">Восстановить</button>` : "")
                    : `<button class="btn btn-secondary" onclick="toggleTopic(${topic.id}, false)">В архив</button>`}
                <button class="btn btn-danger" onclick="${topic.archived ? "deleteArchivedTopic" : "deleteTopic"}(${topic.id})" ${!topic.archived && topic.bookings.length ? "disabled" : ""}>${topic.archived ? "Удалить из архива" : "Удалить"}</button>
            </div>${topic.archived ? "</details>" : "</article>"}`).join("") || `<div class="empty-state">${currentAdminTopicView === "archive" ? "Архив тем пуст." : "Актуальных тем пока нет."}</div>`}</div>
        <button class="btn btn-secondary" onclick="closeTopicEditor()">К управлению</button></div>`;
}

function openTopicEditor() { currentAdminTopicView = "active"; renderTopicEditor(); }
function setAdminTopicView(view) { currentAdminTopicView = view === "archive" ? "archive" : "active"; renderTopicEditor(); }

function syncTopicScope(prefix) {
    const common = document.getElementById(`${prefix.includes("-") ? prefix.replace("topic-", "topic-common-") : prefix + "Common"}`);
    const group = document.getElementById(`${prefix.includes("-") ? prefix.replace("topic-", "topic-group-") : prefix + "Group"}`);
    if (common && group) group.disabled = common.checked;
}

function topicScopePayload(prefix) {
    const formPrefix = prefix === "newTopic" || prefix === "draftTopic";
    const suffix = formPrefix ? "" : prefix;
    const common = document.getElementById(formPrefix ? `${prefix}Common` : `topic-common-${suffix}`).checked;
    return {
        isCommon: common,
        isMulti: document.getElementById(formPrefix ? `${prefix}Multi` : `topic-multi-${suffix}`).checked,
        group: common ? "" : document.getElementById(formPrefix ? `${prefix}Group` : `topic-group-${suffix}`).value
    };
}

function closeTopicEditor() { editingTopics = false; renderAdmin(); }

async function createTopic() {
    const title = document.getElementById("newTopicTitle").value.trim();
    const subject = document.getElementById("newTopicSubject").value.trim();
    const deadline = apiDate(document.getElementById("newTopicDeadline").value);
    const rawNumber = document.getElementById("newTopicNumber").value;
    if (!title) { showStatus("Введите название темы."); return; }
    if (!subject) { showStatus("Укажите предмет."); return; }
    let url;
    try { url = await materialUrl("newTopicUrl", "newTopicFile"); }
    catch (error) { showStatus(error.message, 5000); return; }
    const payload = {action: "create_topic", title, subject, url, ...topicScopePayload("newTopic")};
    if (rawNumber) payload.number = Number(rawNumber);
    if (deadline) payload.deadline = deadline;
    if (await performAction(payload)) renderTopicEditor();
}

function topicDraftPreview() {
    const heading = adminTopicDrafts.length === 1 ? "Добавлена новая тема доклада"
        : `Добавлены новые темы докладов: ${adminTopicDrafts.length}`;
    const rows = adminTopicDrafts.map(item => {
        const scope = item.isCommon ? "Общий доклад" : `Группа: ${item.group}`;
        const number = item.number ? `№${item.number}` : "№ назначится автоматически";
        return `${number}. ${item.title}\nПредмет: ${item.subject}\n${scope}${item.deadline ? `\nСрок: ${item.deadline}` : ""}${item.url ? `\nМатериалы: ${item.url}` : ""}`;
    });
    return `${heading}\n\n${rows.join("\n\n")}`;
}

async function addTopicDrafts() {
    const titles = document.getElementById("draftTopicTitles").value.split(/\r?\n/)
        .map(line => line.replace(/^\s*(?:\d+[.)]|[-–—•])\s*/, "").trim()).filter(Boolean);
    const subject = document.getElementById("draftTopicSubject").value.trim();
    const deadline = apiDate(document.getElementById("draftTopicDeadline").value);
    const rawStartNumber = document.getElementById("draftTopicStartNumber").value;
    if (!titles.length) { showStatus("Добавьте названия тем построчно."); return; }
    if (titles.length > 50) { showStatus("За один раз можно добавить до 50 тем."); return; }
    if (!subject) { showStatus("Укажите предмет для списка тем."); return; }
    let url;
    try { url = await materialUrl("draftTopicUrl", "draftTopicFile"); }
    catch (error) { showStatus(error.message, 5000); return; }
    const payload = {action: "add_topic_drafts", titles, subject, url, ...topicScopePayload("draftTopic")};
    if (rawStartNumber) payload.startNumber = Number(rawStartNumber);
    if (deadline) payload.deadline = deadline;
    if (await performAction(payload)) renderTopicEditor();
}

async function deleteTopicDraft(draftId) {
    if (await performAction({action: "delete_topic_draft", draftId})) renderTopicEditor();
}

async function clearTopicDrafts() {
    if (!window.confirm("Очистить весь черновик тем?")) return;
    if (await performAction({action: "clear_topic_drafts"})) renderTopicEditor();
}

async function publishTopicDrafts() {
    if (!adminTopicDrafts.length) return;
    if (!window.confirm(`Опубликовать тем: ${adminTopicDrafts.length}? Пользователи получат одну подборку.`)) return;
    if (await performAction({action: "publish_topic_drafts"})) renderTopicEditor();
}

async function saveTopic(topicId) {
    const title = document.getElementById(`topic-title-${topicId}`).value.trim();
    const subject = document.getElementById(`topic-subject-${topicId}`).value.trim();
    const deadline = apiDate(document.getElementById(`topic-deadline-${topicId}`).value);
    const number = Number(document.getElementById(`topic-number-${topicId}`).value);
    if (!subject) { showStatus("Укажите предмет."); return; }
    let url;
    try { url = await materialUrl(`topic-url-${topicId}`, `topic-file-${topicId}`); }
    catch (error) { showStatus(error.message, 5000); return; }
    const payload = {action: "update_topic", topicId, title, subject, number, url,
        ...topicScopePayload(String(topicId))};
    if (deadline) payload.deadline = deadline;
    if (await performAction(payload)) renderTopicEditor();
}

async function toggleTopic(topicId, active) {
    if (await performAction({action: "set_topic_active", topicId, active})) renderTopicEditor();
}

async function deleteTopic(topicId) {
    if (!window.confirm("Удалить эту тему? Отменить действие будет нельзя.")) return;
    if (await performAction({action: "delete_topic", topicId})) renderTopicEditor();
}

async function deleteArchivedTopic(topicId) {
    const topic = adminTopics.find(item => item.id === topicId);
    const bookingCount = topic?.bookings?.length || 0;
    const suffix = bookingCount ? ` Вместе с ней будут удалены бронирования: ${bookingCount}.` : "";
    if (!window.confirm(`Удалить тему из архива без возможности восстановления?${suffix}`)) return;
    if (await performAction({action: "delete_archived_topic", topicId})) renderTopicEditor();
}

async function removeBooking(bookingId) {
    if (!window.confirm("Снять бронирование этого студента?")) return;
    if (await performAction({action: "admin_cancel_booking", bookingId})) renderTopicEditor();
}

function lessonTimeParts(value) {
    const parts = (value || "").match(/(\d{2})[.:](\d{2}).*?(\d{2})[.:](\d{2})/);
    return parts ? [`${parts[1]}:${parts[2]}`, `${parts[3]}:${parts[4]}`] : ["", ""];
}

function fillTeacherFromSubject(prefix) {
    const subject = document.getElementById(`${prefix}-subject`).value.trim();
    const teachers = [...new Set(adminLessons
        .filter(lesson => lesson.subject === subject && lesson.teacher)
        .map(lesson => lesson.teacher))];
    if (teachers.length === 1) document.getElementById(`${prefix}-teacher`).value = teachers[0];
    syncLessonGroup(prefix);
}

function syncLessonGroup(prefix) {
    const subject = document.getElementById(`${prefix}-subject`)?.value.trim();
    const select = document.getElementById(`${prefix}-group`);
    if (!select) return;
    const separated = subject === ENGLISH_SUBJECT;
    select.disabled = !separated;
    if (!separated) select.value = "";
    else if (!select.value) select.value = "МН-4-25-01";
}

function lessonGroupOptions(selected = "") {
    return `<option value="" ${selected ? "" : "selected"}>Общее занятие</option>
        <option value="МН-4-25-01" ${selected === "МН-4-25-01" ? "selected" : ""}>МН-4-25-01</option>
        <option value="МН-4-25-02" ${selected === "МН-4-25-02" ? "selected" : ""}>МН-4-25-02</option>`;
}

function lessonFields(prefix, lesson = {}) {
    const [start, end] = lessonTimeParts(lesson.time);
    return `<div class="lesson-fields">
        <div><label class="form-label" for="${prefix}-date">Дата</label><input class="form-control" type="date" id="${prefix}-date" value="${dateInputValue(lesson.date)}"></div>
        <div><label class="form-label" for="${prefix}-start">Начало</label><input class="form-control" type="time" id="${prefix}-start" value="${start}"></div>
        <div><label class="form-label" for="${prefix}-end">Окончание</label><input class="form-control" type="time" id="${prefix}-end" value="${end}"></div>
        <div><label class="form-label" for="${prefix}-type">Тип</label><select class="form-control" id="${prefix}-type"><option ${lesson.type === "Л" ? "selected" : ""}>Л</option><option ${lesson.type === "ПЗ" ? "selected" : ""}>ПЗ</option></select></div>
        <div class="wide"><label class="form-label" for="${prefix}-subject">Дисциплина</label><input class="form-control" id="${prefix}-subject" list="scheduleSubjectSuggestions" maxlength="200" value="${escapeHtml(lesson.subject || "")}" placeholder="Выберите или введите дисциплину" oninput="fillTeacherFromSubject('${prefix}')"></div>
        <div><label class="form-label" for="${prefix}-group">Группа</label><select class="form-control" id="${prefix}-group" ${lesson.subject === ENGLISH_SUBJECT ? "" : "disabled"}>${lessonGroupOptions(lesson.group || "")}</select></div>
        <div><label class="form-label" for="${prefix}-teacher">Преподаватель</label><input class="form-control" id="${prefix}-teacher" maxlength="100" value="${escapeHtml(lesson.teacher || "")}"></div>
        <div><label class="form-label" for="${prefix}-room">Аудитория</label><input class="form-control" id="${prefix}-room" maxlength="100" value="${escapeHtml(lesson.room || "")}"></div>
        <div class="wide"><label class="form-label" for="${prefix}-url">Ссылка, необязательно</label><input class="form-control" type="url" id="${prefix}-url" maxlength="1000" placeholder="https://..." value="${escapeHtml(lesson.url || "")}"></div>
    </div>`;
}

function lessonPayload(prefix) {
    const start = document.getElementById(`${prefix}-start`).value;
    const end = document.getElementById(`${prefix}-end`).value;
    return {date: apiDate(document.getElementById(`${prefix}-date`).value), time: `${start}–${end}`,
        type: document.getElementById(`${prefix}-type`).value,
        subject: document.getElementById(`${prefix}-subject`).value.trim(),
        group: document.getElementById(`${prefix}-group`).value,
        teacher: document.getElementById(`${prefix}-teacher`).value.trim(),
        room: document.getElementById(`${prefix}-room`).value.trim(),
        url: document.getElementById(`${prefix}-url`).value.trim()};
}

function renderScheduleEditor() {
    if (!isAdmin) return;
    editingTopics = false;
    editingHomework = false;
    editingAudit = false;
    editingStats = false;
    editingAnnouncements = false;
    editingSchedule = true;
    const todayStart = calendarTime(studyToday());
    const lessons = [...adminLessons].sort((a, b) => {
        const bucket = item => !item.active ? 2 : (calendarTime(item.date) >= todayStart ? 0 : 1);
        const difference = bucket(a) - bucket(b);
        if (difference) return difference;
        return bucket(a) === 1 ? lessonStart(b) - lessonStart(a) : lessonStart(a) - lessonStart(b);
    });
    const subjects = [...new Set(adminLessons.map(lesson => lesson.subject).filter(Boolean))]
        .sort((a, b) => a.localeCompare(b, "ru"));
    document.getElementById("adminContent").innerHTML = `<div class="profile-card card admin-editor">
        <h3 class="section-title">Управление расписанием</h3>
        <datalist id="scheduleSubjectSuggestions">${subjects.map(subject => `<option value="${escapeHtml(subject)}"></option>`).join("")}</datalist>
        <h4>Добавить занятие</h4>${lessonFields("newLesson")}
        <button class="btn btn-primary" onclick="createLesson()">Добавить занятие</button>
        <div class="admin-records">${lessons.map(lesson => `<details class="admin-record ${lesson.active ? "" : "archived"}">
            <summary>${escapeHtml(lesson.date)} · ${escapeHtml(lesson.time)} · ${escapeHtml(lesson.subject)} ${lesson.active ? "" : "(архив)"}</summary>
            ${lessonFields(`lesson-${lesson.id}`, lesson)}
            <div class="admin-actions">
                <button class="btn btn-outline" onclick="saveLesson(${lesson.id})">Сохранить</button>
                <button class="btn btn-secondary" onclick="toggleLesson(${lesson.id}, ${!lesson.active})">${lesson.active ? "В архив" : "Восстановить"}</button>
                <button class="btn btn-danger" onclick="deleteLesson(${lesson.id})">Удалить</button>
            </div></details>`).join("")}</div>
        <button class="btn btn-secondary" onclick="closeScheduleEditor()">К управлению</button></div>`;
}

function closeScheduleEditor() { editingSchedule = false; renderAdmin(); }

async function createLesson() {
    if (await performAction({action: "create_lesson", ...lessonPayload("newLesson")})) renderScheduleEditor();
}

async function saveLesson(lessonId) {
    if (await performAction({action: "update_lesson", lessonId, ...lessonPayload(`lesson-${lessonId}`)})) renderScheduleEditor();
}

async function toggleLesson(lessonId, active) {
    if (await performAction({action: "set_lesson_active", lessonId, active})) renderScheduleEditor();
}

async function deleteLesson(lessonId) {
    if (!window.confirm("Удалить занятие из расписания?")) return;
    if (await performAction({action: "delete_lesson", lessonId})) renderScheduleEditor();
}

const notificationTypes = [
    {id: "announcements", title: "Объявления", description: "Важные сообщения от администраторов."},
    {id: "assignments", title: "Домашние задания", description: "Новая домашка и напоминания за день до сдачи."},
    {id: "schedule", title: "Изменения расписания", description: "Сообщение при обновлении расписания."},
    {id: "lessons", title: "Напоминания о парах", description: "Одна сводка за день примерно за час до первой пары."},
    {id: "topics", title: "Темы докладов", description: "Новые темы, изменения старых, напоминание за день до сдачи."}
];

function renderAdminStats() {
    if (!isAdmin) return;
    editingProfile = false;
    editingTopics = false;
    editingSchedule = false;
    editingHomework = false;
    editingAudit = false;
    editingAnnouncements = false;
    editingStats = true;
    const stats = adminStats || {registeredUsers: 0, visitsToday: 0, visits7Days: 0,
        visits30Days: 0, dailyVisits: [], notifications: []};
    const daily = Array.isArray(stats.dailyVisits) ? stats.dailyVisits : [];
    const maximum = Math.max(1, ...daily.map(item => Number(item.visits) || 0));
    const notificationNames = Object.fromEntries(notificationTypes.map(item => [item.id, item.title]));
    const chart = daily.map((item, index) => {
        const visits = Number(item.visits) || 0;
        const [year, month, day] = String(item.date).split("-");
        const label = `${day}.${month}`;
        const showLabel = index % 5 === 0 || index === daily.length - 1;
        const height = visits ? Math.max(8, Math.round(visits * 150 / maximum)) : 3;
        return `<div class="activity-column" title="${escapeHtml(`${day}.${month}.${year}: ${visits} входов`)}">
            <span class="activity-value">${visits}</span>
            <div class="activity-bar" style="height:${height}px"></div>
            <span class="activity-date">${showLabel ? escapeHtml(label) : ""}</span>
        </div>`;
    }).join("");
    const notificationRows = (Array.isArray(stats.notifications) ? stats.notifications : []).map(item => `
        <div class="admin-notification-stat">
            <div><strong>${escapeHtml(notificationNames[item.kind] || item.kind)}</strong>
            <span>${Number(item.enabled) || 0} из ${Number(stats.registeredUsers) || 0} пользователей</span></div>
            <b>${Number(item.percent) || 0}%</b>
        </div>`).join("");
    document.getElementById("adminContent").innerHTML = `<div class="profile-card card admin-editor">
        <h3 class="section-title">Статистика</h3>
        <div class="stats-grid admin-stats-grid">
            <div class="stat-card"><div class="number">${Number(stats.registeredUsers) || 0}</div><div class="label">Пользователей</div></div>
            <div class="stat-card"><div class="number">${Number(stats.visitsToday) || 0}</div><div class="label">Входов сегодня</div></div>
            <div class="stat-card"><div class="number">${Number(stats.visits7Days) || 0}</div><div class="label">Входов за 7 дней</div></div>
            <div class="stat-card"><div class="number">${Number(stats.visits30Days) || 0}</div><div class="label">Входов за 30 дней</div></div>
        </div>
        <h4>Входы по дням</h4>
        <div class="activity-chart-scroll"><div class="activity-chart" role="img" aria-label="График входов за 30 дней">${chart}</div></div>
        <h4>Включённые уведомления</h4>
        <div class="admin-notification-stats">${notificationRows || '<div class="empty-state compact">Нет данных.</div>'}</div>
        <button class="btn btn-secondary" onclick="closeAdminStats()">К управлению</button>
    </div>`;
    requestAnimationFrame(() => {
        const scroller = document.querySelector(".activity-chart-scroll");
        if (scroller) scroller.scrollLeft = scroller.scrollWidth;
    });
}

function closeAdminStats() { editingStats = false; renderAdmin(); }

function renderNotifications() {
    document.getElementById("notificationsContainer").innerHTML = notificationTypes.map(item => `
        <div class="notification-item"><div class="notification-info">
        <div class="notification-title">${item.title}</div><div class="notification-description">${item.description}</div></div>
        <label class="switch"><input aria-label="${item.title}" type="checkbox" ${notificationSettings[item.id] ? "checked" : ""}
        ${!connected || !isRegistered || busy ? "disabled" : ""} onchange="toggleNotif('${item.id}', this.checked)"><span class="slider"></span></label></div>`).join("");
}

async function toggleNotif(type, enabled) { await performAction({action: "notification_settings", type, enabled}); }

function homeworkSubjectOptions(selected = "") {
    const subjects = [...new Set(scheduleData.map(item => item.subject).filter(Boolean))]
        .sort((a, b) => a.localeCompare(b, "ru"));
    return `<option value="">Выберите предмет</option>${subjects.map(subject =>
        `<option value="${escapeHtml(subject)}" ${subject === selected ? "selected" : ""}>${escapeHtml(subject)}</option>`).join("")}`;
}

function renderHomework() {
    const container = document.getElementById("homeworkContainer");
    const filters = document.getElementById("homeworkArchiveFilters");
    if (!container) return;
    filters.innerHTML = [{value: "active", label: "Актуальные"}, {value: "archive", label: "Архив"}]
        .map(item => `<button class="filter-btn ${currentHomeworkView === item.value ? "active" : ""}"
            onclick="setHomeworkView('${item.value}')">${item.label}</button>`).join("");
    const items = assignmentsData.filter(item => Boolean(item.archived) === (currentHomeworkView === "archive"));
    container.innerHTML = items.length ? items.map(item => `<article class="topic-card homework-card ${item.archived ? "archived" : ""}">
        <div class="booking-owner" title="${escapeHtml(item.subject)}">${escapeHtml(shortSubject(item.subject))}</div>
        <div class="homework-description">${escapeHtml(item.description)}</div>
        <div class="booking-owner">Срок: ${escapeHtml(item.deadline)}</div>
        ${deadlineCountdownMarkup(item.deadline)}
        ${resourceButton(item.url)}
        ${item.archived ? '<div class="archive-label">Архив</div>' : ""}
    </article>`).join("") : `<div class="empty-state">${currentHomeworkView === "archive"
        ? "В архиве пока нет домашки." : "Домашних заданий пока нет."}</div>`;
}

function setHomeworkView(value) {
    currentHomeworkView = value === "archive" ? "archive" : "active";
    renderHomework();
}

function renderAnnouncementEditor() {
    if (!isAdmin) return;
    editingProfile = false;
    editingTopics = false;
    editingSchedule = false;
    editingHomework = false;
    editingAudit = false;
    editingStats = false;
    editingAnnouncements = true;
    document.getElementById("adminContent").innerHTML = `<div class="profile-card card admin-editor">
        <h3 class="section-title">Объявления</h3>
        <h4>Новое объявление</h4>
        <div class="admin-create-grid">
            <div class="wide"><label class="form-label" for="newAnnouncementTitle">Заголовок</label>
            <input class="form-control" id="newAnnouncementTitle" maxlength="120" placeholder="Например, перенос занятия"></div>
            <div class="wide"><label class="form-label" for="newAnnouncementBody">Текст</label>
            <textarea class="form-control" id="newAnnouncementBody" maxlength="2000" rows="5" placeholder="Что нужно знать студентам"></textarea></div>
            <div class="wide"><label class="form-label" for="newAnnouncementUrl">Ссылка, необязательно</label>
            <input class="form-control" type="url" id="newAnnouncementUrl" maxlength="1000" placeholder="https://..."></div>
        </div>
        <button class="btn btn-primary" onclick="createAnnouncement()">Опубликовать</button>
        <div class="admin-records">${adminAnnouncements.length ? adminAnnouncements.map(item => `<details class="admin-record">
            <summary>${escapeHtml(item.title)}</summary>
            <label class="form-label" for="announcement-title-${item.id}">Заголовок</label>
            <input class="form-control" id="announcement-title-${item.id}" maxlength="120" value="${escapeHtml(item.title)}">
            <label class="form-label" for="announcement-body-${item.id}">Текст</label>
            <textarea class="form-control" id="announcement-body-${item.id}" maxlength="2000" rows="5">${escapeHtml(item.body)}</textarea>
            <label class="form-label" for="announcement-url-${item.id}">Ссылка</label>
            <input class="form-control" type="url" id="announcement-url-${item.id}" maxlength="1000" placeholder="https://..." value="${escapeHtml(item.url || "")}">
            <div class="admin-actions"><button class="btn btn-outline" onclick="saveAnnouncement(${item.id})">Сохранить</button>
            <button class="btn btn-danger" onclick="deleteAnnouncement(${item.id})">Удалить</button></div>
        </details>`).join("") : '<div class="empty-state compact">Объявлений пока нет.</div>'}</div>
        <button class="btn btn-secondary" onclick="closeAnnouncementEditor()">К управлению</button></div>`;
}

async function createAnnouncement() {
    const title = document.getElementById("newAnnouncementTitle").value.trim();
    const body = document.getElementById("newAnnouncementBody").value.trim();
    const url = document.getElementById("newAnnouncementUrl").value.trim();
    if (!title || !body) { showStatus("Заполните заголовок и текст объявления."); return; }
    if (await performAction({action: "create_announcement", title, body, url})) renderAnnouncementEditor();
}

async function saveAnnouncement(announcementId) {
    const title = document.getElementById(`announcement-title-${announcementId}`).value.trim();
    const body = document.getElementById(`announcement-body-${announcementId}`).value.trim();
    const url = document.getElementById(`announcement-url-${announcementId}`).value.trim();
    if (!title || !body) { showStatus("Заполните заголовок и текст объявления."); return; }
    if (await performAction({action: "update_announcement", announcementId, title, body, url})) renderAnnouncementEditor();
}

async function deleteAnnouncement(announcementId) {
    if (!window.confirm("Удалить объявление?")) return;
    if (await performAction({action: "delete_announcement", announcementId})) renderAnnouncementEditor();
}

function closeAnnouncementEditor() { editingAnnouncements = false; renderAdmin(); }

function renderHomeworkEditor() {
    if (!isAdmin) return;
    editingProfile = false;
    editingTopics = false;
    editingSchedule = false;
    editingAudit = false;
    editingStats = false;
    editingAnnouncements = false;
    editingHomework = true;
    const assignmentCounts = {active: adminAssignments.filter(item => !item.archived).length,
        archive: adminAssignments.filter(item => item.archived).length};
    const visibleAssignments = adminAssignments.filter(item =>
        Boolean(item.archived) === (currentAdminHomeworkView === "archive"));
    document.getElementById("adminContent").innerHTML = `<div class="profile-card card admin-editor">
        <h3 class="section-title">Управление домашкой</h3>
        <div class="filter-row">${[{value: "active", label: `Актуальные · ${assignmentCounts.active}`},
            {value: "archive", label: `Архив · ${assignmentCounts.archive}`}].map(item =>
            `<button class="filter-btn ${currentAdminHomeworkView === item.value ? "active" : ""}"
                onclick="setAdminHomeworkView('${item.value}')">${item.label}</button>`).join("")}</div>
        <div ${currentAdminHomeworkView === "archive" ? "hidden" : ""}>
        <h4>Добавить домашнее задание</h4>
        <div class="admin-create-grid">
            <div><label class="form-label" for="newAssignmentSubject">Предмет</label>
            <select class="form-control" id="newAssignmentSubject">${homeworkSubjectOptions()}</select></div>
            <div class="wide"><label class="form-label" for="newAssignmentDescription">Описание</label>
            <textarea class="form-control" id="newAssignmentDescription" maxlength="2000" rows="5" placeholder="Что нужно сделать"></textarea></div>
            <div><label class="form-label" for="newAssignmentDeadline">Срок</label>
            <input class="form-control" type="date" id="newAssignmentDeadline"></div>
            <div class="wide"><label class="form-label" for="newAssignmentUrl">Ссылка, необязательно</label>
            <input class="form-control" type="url" id="newAssignmentUrl" maxlength="1000" placeholder="https://..."></div>
            <div class="wide"><label class="form-label" for="newAssignmentFile">Или прикрепить файл, до 10 МБ</label>
            <input class="form-control file-control" type="file" id="newAssignmentFile" accept=".pdf,.doc,.docx,.ppt,.pptx,.xls,.xlsx,.odt,.ods,.txt,.png,.jpg,.jpeg,.zip"></div>
        </div>
        <button class="btn btn-primary" onclick="createAssignment()">Добавить задание</button>
        <h4>Предварительный просмотр уведомления</h4>
        <pre class="notification-preview" id="homeworkNotificationPreview"></pre>
        </div>
        <div class="admin-records">${visibleAssignments.length ? visibleAssignments.map(item => `<details class="admin-record ${item.archived ? "archived" : ""}">
            <summary>${escapeHtml(item.deadline)} · ${escapeHtml(shortSubject(item.subject))}${item.archived ? " · Архив" : ""}</summary>
            <label class="form-label" for="assignment-subject-${item.id}">Предмет</label>
            <select class="form-control" id="assignment-subject-${item.id}">${homeworkSubjectOptions(item.subject)}</select>
            <label class="form-label" for="assignment-description-${item.id}">Описание</label>
            <textarea class="form-control" id="assignment-description-${item.id}" maxlength="2000" rows="5">${escapeHtml(item.description)}</textarea>
            <label class="form-label" for="assignment-deadline-${item.id}">Срок</label>
            <input class="form-control" type="date" id="assignment-deadline-${item.id}" value="${dateInputValue(item.deadline)}">
            <label class="form-label" for="assignment-url-${item.id}">Ссылка</label>
            <input class="form-control" type="url" id="assignment-url-${item.id}" maxlength="1000" placeholder="https://..." value="${escapeHtml(item.url || "")}">
            <label class="form-label" for="assignment-file-${item.id}">Заменить ссылку прикреплённым файлом</label>
            <input class="form-control file-control" type="file" id="assignment-file-${item.id}" accept=".pdf,.doc,.docx,.ppt,.pptx,.xls,.xlsx,.odt,.ods,.txt,.png,.jpg,.jpeg,.zip">
            <div class="admin-actions">
                <button class="btn btn-outline" onclick="saveAssignment(${item.id})">Сохранить</button>
                <button class="btn btn-danger" onclick="deleteAssignment(${item.id})">${item.archived ? "Удалить из архива" : "Удалить"}</button>
            </div></details>`).join("") : `<div class="empty-state">${currentAdminHomeworkView === "archive" ? "Архив домашки пуст." : "Актуальных домашних заданий пока нет."}</div>`}</div>
        <button class="btn btn-secondary" onclick="closeHomeworkEditor()">К управлению</button></div>`;
    ["newAssignmentSubject", "newAssignmentDescription", "newAssignmentDeadline",
        "newAssignmentUrl", "newAssignmentFile"].forEach(id => {
        const input = document.getElementById(id);
        input?.addEventListener(input?.type === "file" || input?.tagName === "SELECT" ? "change" : "input",
            renderHomeworkNotificationPreview);
    });
    renderHomeworkNotificationPreview();
}

function openHomeworkEditor() { currentAdminHomeworkView = "active"; renderHomeworkEditor(); }
function setAdminHomeworkView(view) { currentAdminHomeworkView = view === "archive" ? "archive" : "active"; renderHomeworkEditor(); }

function renderHomeworkNotificationPreview() {
    const preview = document.getElementById("homeworkNotificationPreview");
    if (!preview) return;
    const subject = document.getElementById("newAssignmentSubject")?.value || "Предмет";
    const description = document.getElementById("newAssignmentDescription")?.value.trim() || "Описание задания";
    const deadline = apiDate(document.getElementById("newAssignmentDeadline")?.value) || "Дата срока";
    const hasMaterial = Boolean(document.getElementById("newAssignmentUrl")?.value.trim() ||
        document.getElementById("newAssignmentFile")?.files?.length);
    preview.textContent = `Добавлено домашнее задание\n${subject}\n${description}\nСрок: ${deadline}${
        hasMaterial ? "\nОткрыть материалы" : ""}`;
}

function renderAuditLog() {
    if (!isAdmin) return;
    editingProfile = false;
    editingTopics = false;
    editingSchedule = false;
    editingHomework = false;
    editingStats = false;
    editingAnnouncements = false;
    editingAudit = true;
    const actionNames = {create: "Создание", update: "Изменение", delete: "Удаление",
        archive: "Архив", restore: "Восстановление", deadline: "Срок",
        cancel_booking: "Бронирование", publish: "Публикация"};
    document.getElementById("adminContent").innerHTML = `<div class="profile-card card admin-editor">
        <h3 class="section-title">История действий</h3>
        <p class="draft-help">Последние действия администраторов. Хранится до 300 записей.</p>
        <div class="audit-list">${adminAuditLog.length ? adminAuditLog.map(item => `<article class="audit-item">
            <div><strong>${escapeHtml(actionNames[item.action] || item.action)}</strong><span>${escapeHtml(item.actor)}</span></div>
            <p>${escapeHtml(item.summary)}</p><time>${escapeHtml(new Date(item.createdAt).toLocaleString("ru-RU"))}</time>
        </article>`).join("") : '<div class="empty-state">История пока пуста.</div>'}</div>
        <button class="btn btn-secondary" onclick="closeAuditLog()">К управлению</button></div>`;
}

function closeAuditLog() { editingAudit = false; renderAdmin(); }

function assignmentPayload(prefix) {
    return {
        subject: document.getElementById(`${prefix}Subject`).value.trim(),
        description: document.getElementById(`${prefix}Description`).value.trim(),
        deadline: apiDate(document.getElementById(`${prefix}Deadline`).value),
        url: document.getElementById(`${prefix}Url`).value.trim()
    };
}

async function createAssignment() {
    const payload = assignmentPayload("newAssignment");
    if (!payload.subject || !payload.description || !payload.deadline) {
        showStatus("Заполните предмет, описание и срок."); return;
    }
    try { payload.url = await materialUrl("newAssignmentUrl", "newAssignmentFile"); }
    catch (error) { showStatus(error.message, 5000); return; }
    if (await performAction({action: "create_assignment", ...payload})) renderHomeworkEditor();
}

async function saveAssignment(assignmentId) {
    const payload = {
        subject: document.getElementById(`assignment-subject-${assignmentId}`).value.trim(),
        description: document.getElementById(`assignment-description-${assignmentId}`).value.trim(),
        deadline: apiDate(document.getElementById(`assignment-deadline-${assignmentId}`).value),
        url: document.getElementById(`assignment-url-${assignmentId}`).value.trim()
    };
    if (!payload.subject || !payload.description || !payload.deadline) {
        showStatus("Заполните предмет, описание и срок."); return;
    }
    try { payload.url = await materialUrl(`assignment-url-${assignmentId}`, `assignment-file-${assignmentId}`); }
    catch (error) { showStatus(error.message, 5000); return; }
    if (await performAction({action: "update_assignment", assignmentId, ...payload})) renderHomeworkEditor();
}

async function deleteAssignment(assignmentId) {
    if (!window.confirm("Удалить это домашнее задание?")) return;
    if (await performAction({action: "delete_assignment", assignmentId})) renderHomeworkEditor();
}

function closeHomeworkEditor() { editingHomework = false; renderAdmin(); }

document.addEventListener("DOMContentLoaded", async () => {
    setupFilters();
    try {
        if (tg?.initData) {
            const [, synchronized] = await Promise.all([api("visit", {}), api("sync")]);
            applyCatalog(synchronized.catalog);
            applyState(synchronized.state);
        }
        else {
            applyCatalog(await api("catalog"));
            showStatus("Режим просмотра. Для регистрации и бронирования откройте приложение через кнопку бота.", 5000);
        }
    } catch (error) {
        showStatus(error.message, 5000);
        try {
            const response = await fetch("catalog.json", {cache: "no-store"});
            if (response.ok) applyCatalog(await response.json());
        } catch { /* The transient message already explains the failure. */ }
    }
    renderAll();
    syncRegistrationGate();
    document.body.classList.remove("app-loading");
    setInterval(() => { if (!document.hidden) refreshState(); }, 15000);
    setInterval(() => { renderSchedule(); }, 60000);
    window.addEventListener("focus", refreshState);
    document.addEventListener("visibilitychange", () => { if (!document.hidden) refreshState(); });
});

    function escapeHtml(value) {
        return String(value ?? "")
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#039;");
    }

    function showStatus(message, duration = 2500) {
        const status = document.getElementById("status");

        if (!status) return;

        status.textContent = message;
        status.classList.add("show");

        clearTimeout(window.statusTimer);

        window.statusTimer = setTimeout(() => {
            status.classList.remove("show");
        }, duration);
    }

    function scheduleItems(filter) {
        const now = studyNow();
        const todayStart = calendarTime(studyToday());
        let items = [...scheduleData];

        if (filter === "past") {
            items = items.filter(item => calendarTime(item.date) < todayStart);
            return items.sort((a, b) => lessonStart(b) - lessonStart(a));
        }

        // Past calendar days live only in the dedicated section. Lecture and
        // practice filters therefore also show today and future dates.
        items = items.filter(item => calendarTime(item.date) >= todayStart);
        if (filter === "Л" || filter === "ПЗ") {
            items = items.filter(item => item.type === filter);
        }

        return items.sort((a, b) => {
            const dayDifference = calendarTime(a.date) - calendarTime(b.date);
            if (dayDifference) return dayDifference;
            const aFinished = lessonEnd(a) < now ? 1 : 0;
            const bFinished = lessonEnd(b) < now ? 1 : 0;
            return aFinished - bFinished || lessonStart(a) - lessonStart(b);
        });
    }

    function renderSchedule(filter = currentScheduleFilter) {
        currentScheduleFilter = filter;

        const container =
            document.getElementById("scheduleContainer");

        if (!container) return;

        const now = studyNow();
        const filtered = scheduleItems(filter);
        const nextLesson = filter === "past" ? null : filtered.find(item => lessonEnd(item) >= now);

        if (!filtered.length) {
            container.innerHTML = `
                <div class="empty-state">
                    <div>${filter === "past" ? "Прошедших занятий пока нет." : "Предстоящих занятий по выбранному фильтру нет."}</div>
                </div>
            `;

            updateScheduleStats();
            return;
        }

        container.innerHTML = filtered.map(item => {

            const date = lessonEnd(item);

            const done = date < now;
            const todayLesson = item.date === studyToday();
            const nearest = nextLesson?.id === item.id;

            const dayNumber =
                item.date.split(".")[0];

            const monthNumber =
                item.date.split(".")[1];

            const months = {
                "01": "янв",
                "02": "фев",
                "03": "мар",
                "04": "апр",
                "05": "май",
                "06": "июн",
                "07": "июл",
                "08": "авг",
                "09": "сен",
                "10": "окт",
                "11": "ноя",
                "12": "дек"
            };

            return `
                <article class="schedule-card ${done ? "done" : ""} ${todayLesson ? "today" : ""}">

                    <div class="schedule-top">

                        <div class="schedule-date">

                            <div class="date-box">
                                <span class="day">
                                    ${escapeHtml(dayNumber)}
                                </span>

                                <span class="month">
                                    ${months[monthNumber]}
                                </span>
                            </div>

                            <div>
                                <div class="weekday">
                                    ${escapeHtml(item.day)}
                                </div>

                                <div class="muted">
                                    ${escapeHtml(formatDate(item.date))}
                                </div>
                            </div>

                        </div>

                        <div class="time">
                            ${escapeHtml(item.time)}
                        </div>

                    </div>

                    <div class="schedule-subject">
                        ${escapeHtml(item.subject)}
                    </div>

                    ${nearest ? '<div class="next-lesson-label">Ближайшая пара</div>' : ""}

                    <div class="schedule-info">

                        <div class="info-item">
                            <span class="label">
                                Тип
                            </span>

                            <span class="value">
                                <span class="type-badge">
                                    ${escapeHtml(item.type)}
                                </span>
                            </span>
                        </div>

                        <div class="info-item">
                            <span class="label">
                                Преподаватель
                            </span>

                            <span class="value">
                                ${escapeHtml(item.teacher)}
                            </span>
                        </div>

                        <div class="info-item">
                            <span class="label">
                                Аудитория
                            </span>

                            <span class="value">
                                ${escapeHtml(item.room)}
                            </span>
                        </div>

                        <div class="info-item">
                            <span class="label">
                                Статус
                            </span>

                            <span class="value">
                                ${todayLesson ? "Сегодня" : (done ? "Проведено" : "Предстоит")}
                            </span>
                        </div>

                    </div>

                    ${item.url ? `<a class="btn btn-primary lesson-link-button" href="${escapeHtml(item.url)}" target="_blank" rel="noopener noreferrer">Подключиться к паре</a>` : ""}

                </article>
            `;
        }).join("");

        updateScheduleStats();
    }

    function updateScheduleStats() {
        const today = studyNow();

        const total =
            scheduleData.length;

        const completed =
            scheduleData.filter(
                item => lessonEnd(item) < today
            ).length;

        const remaining =
            total - completed;

        const totalEl =
            document.getElementById("totalClasses");

        const completedEl =
            document.getElementById("completedClasses");

        const remainingEl =
            document.getElementById("remainingClasses");

        const progressEl =
            document.getElementById("scheduleProgress");

        const progressBar =
            document.getElementById("scheduleProgressBar");

        if (totalEl)
            totalEl.textContent = total;

        if (completedEl)
            completedEl.textContent = completed;

        if (remainingEl)
            remainingEl.textContent = remaining;

        const progress =
            total > 0
                ? Math.round((completed / total) * 100)
                : 0;

        if (progressEl)
            progressEl.textContent = progress + "%";

        if (progressBar)
            progressBar.style.width = progress + "%";
    }

    function filterSchedule(filter, button) {
        document
            .querySelectorAll(".filter-btn")
            .forEach(btn =>
                btn.classList.remove("active")
            );

        if (button) {
            button.classList.add("active");
        }

        renderSchedule(filter);
    }

    function setupFilters() {
        document
            .querySelectorAll(".filter-btn")
            .forEach(button => {

                button.addEventListener("click", () => {

                    const filter =
                        button.dataset.filter;

                    filterSchedule(filter, button);
                });
            });
    }

    let html2pdfLoadPromise = null;

    function loadHtml2Pdf() {
        if (typeof window.html2pdf === "function") return Promise.resolve(window.html2pdf);
        if (html2pdfLoadPromise) return html2pdfLoadPromise;
        html2pdfLoadPromise = new Promise((resolve, reject) => {
            const script = document.createElement("script");
            script.src = "html2pdf.bundle.min.js?v=20260905-2";
            script.onload = () => typeof window.html2pdf === "function"
                ? resolve(window.html2pdf) : reject(new Error("PDF module is unavailable"));
            script.onerror = () => reject(new Error("PDF module failed to load"));
            document.head.appendChild(script);
        }).catch(error => {
            html2pdfLoadPromise = null;
            throw error;
        });
        return html2pdfLoadPromise;
    }

    async function downloadSchedule() {
        if (downloadSchedule.pending) return;
        const items = scheduleItems(currentScheduleFilter);
        if (!items.length) { showStatus("Нет занятий для выгрузки."); return; }
        downloadSchedule.pending = true;
        showStatus("Формируем PDF...");
        let pdfFactory;
        try { pdfFactory = await loadHtml2Pdf(); }
        catch {
            showStatus("Модуль PDF не загрузился. Проверьте подключение и повторите действие.");
            downloadSchedule.pending = false;
            return;
        }
        const wrapper = document.createElement("div");
        wrapper.style.cssText = "width:100%;padding:0;background:#fff;color:#172033;font:12px Arial,sans-serif;";
        const cell = "border:1px solid #cbd5e1;padding:8px;vertical-align:top;overflow-wrap:break-word;";
        wrapper.innerHTML = `<h1 style="font-size:24px;margin:0 0 8px">Расписание</h1>
            <p style="margin:0 0 16px">Расписание занятий<br>
            Занятий в выгрузке: ${items.length}. Время: ${escapeHtml(studyTimezone)}.</p>
            <table style="width:100%;border-collapse:collapse;table-layout:fixed;font:12px Arial,sans-serif;color:#172033">
            <colgroup><col style="width:14%"><col style="width:17%"><col style="width:47%"><col style="width:22%"></colgroup>
            <thead><tr style="background:#edf2f7">${["Дата", "Время", "Занятие", "Преподаватель"].map(t => `<th style="${cell}text-align:left">${t}</th>`).join("")}</tr></thead>
            <tbody>${items.map(i => `<tr style="break-inside:avoid;page-break-inside:avoid">
                <td style="${cell}">${escapeHtml(i.date)}<br>${escapeHtml(i.day)}</td>
                <td style="${cell}">${escapeHtml(i.time)}</td>
                <td style="${cell}"><b>${escapeHtml(i.subject)}</b><br>${escapeHtml(i.type)} · ${escapeHtml(i.room)}</td>
                <td style="${cell}">${escapeHtml(i.teacher)}</td></tr>`).join("")}</tbody></table>`;
        // Render a detached export layout. Capturing cards below the scrolled page
        // produces blank leading pages and cropped content in html2canvas.
        try {
            await pdfFactory().set({
                margin: 10, filename: "расписание.pdf",
                image: {type: "jpeg", quality: 0.98},
                html2canvas: {scale: 2, backgroundColor: "#ffffff", scrollX: 0, scrollY: 0},
                jsPDF: {unit: "mm", format: "a4", orientation: "portrait"},
                pagebreak: {mode: ["css"], avoid: "tr"}
            }).from(wrapper).save();
            showStatus("PDF готов.");
        } catch (error) {
            console.warn("PDF export failed", error);
            showStatus("Не удалось создать PDF. Попробуйте ещё раз.");
        } finally {
            wrapper.remove();
            downloadSchedule.pending = false;
        }
    }

    function switchTab(tabName) {

        if (!["today", "schedule", "homework", "reports", "cabinet", "admin", "notifications"].includes(tabName)) return;
        if (registrationRequired() && tabName !== "cabinet") {
            tabName = "cabinet";
            if (!document.getElementById("profileFirst")) showRegistrationForm();
        }
        if (tabName === "admin" && !isAdmin) tabName = "cabinet";
        document
            .querySelectorAll(".tab-content")
            .forEach(section => {
                section.classList.remove("active");
            });

        document
            .querySelectorAll(".tab")
            .forEach(tab => {
                tab.classList.remove("active");
            });

        const content =
            document.getElementById(
                tabName
            );

        const tab =
            document.querySelector(
                `.tab[data-tab="${tabName}"]`
            );

        if (content) {
            content.classList.add("active");
        }

        if (tab) {
            tab.classList.add("active");

            try {
                tab.scrollIntoView({
                    behavior: "smooth",
                    block: "nearest",
                    inline: "center"
                });
            } catch (error) {}
        }

        if (tabName === "admin") renderAdmin();

        window.scrollTo({
            top: 0,
            behavior: "smooth"
        });
    }
