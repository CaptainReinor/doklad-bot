"use strict";

const tg = window.Telegram?.WebApp || null;
const apiBase = (window.APP_CONFIG?.apiBaseUrl || window.location.origin).replace(/\/$/, "");
let scheduleData = [], topicsData = [], assignmentsData = [];
let bookings = [], myBookings = [], notificationSettings = {};
let adminTopics = [], adminLessons = [], adminAssignments = [];
let adminTopicDrafts = [], adminAuditLog = [];
let userData = null, isRegistered = false, isAdmin = false;
let connected = false, busy = false, editingProfile = false;
let editingTopics = false, editingSchedule = false, editingHomework = false, editingAudit = false;
let mutationVersion = 0, refreshing = false, participants = 0;
let currentScheduleFilter = "upcoming", studyTimezone = "Europe/Moscow";
let currentTopicSubject = "all";

const SUBJECT_SHORT_NAMES = Object.freeze({
    "Иностранный язык профессиональных коммуникаций": "Профессиональный иностранный",
    "Методы реализации научно-исследовательских проектов": "Методы НИР",
    "Научно-исследовательская работа (П)": "НИР",
    "Практика по профилю профессиональной деятельности (организационно-управленческая) (П)": "Профильная практика",
    "Проектное управление устойчивым развитием организаций": "Устойчивое развитие",
    "Развитие компетенций руководителя проекта и проектных команд": "Компетенции руководителя",
    "Управление бизнес-процессами": "Бизнес-процессы",
    "Управление программами и портфелями проектов": "Программы и портфели"
});

function shortSubject(value) {
    if (!value) return "Без предмета";
    return SUBJECT_SHORT_NAMES[value] || (value.length > 38 ? value.slice(0, 35) + "…" : value);
}

if (tg) {
    tg.ready();
    tg.expand();
    tg.BackButton?.show();
    tg.BackButton?.onClick(() => tg.close());
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

function connectionStatus(text, error = false) {
    const el = document.getElementById("connectionStatus");
    const textEl = document.getElementById("connectionStatusText");
    textEl.textContent = text;
    el.classList.toggle("error", error);
}

function refreshedAt() {
    return new Date().toLocaleTimeString("ru-RU", {
        timeZone: studyTimezone, hour: "2-digit", minute: "2-digit"
    });
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
    adminTopicDrafts = isAdmin && Array.isArray(data.topicDrafts) ? data.topicDrafts : [];
    adminAuditLog = isAdmin && Array.isArray(data.auditLog) ? data.auditLog : [];
    bookings = data.bookings;
    myBookings = bookings.filter(item => item.isMine);
    notificationSettings = data.notifications || {};
    participants = data.participants || 0;
    connected = true;
    connectionStatus(userData
        ? `Обновлено в ${refreshedAt()} · ${userData.group_name}`
        : `Обновлено в ${refreshedAt()} · заполните профиль во вкладке «Кабинет».`);
}

function renderAll() {
    renderSchedule();
    renderTopics();
    renderHomework();
    renderMyBookings();
    renderQueue();
    renderNotifications();
    if (!editingProfile && !editingTopics && !editingSchedule && !editingHomework && !editingAudit) renderCabinet();
    document.querySelectorAll('#cabinetContent button[type="submit"]').forEach(button => {
        button.disabled = !connected || busy;
    });
    const nearest = myBookings.map(b => topicsData.find(t => t.id === b.id)?.deadline)
        .filter(Boolean).sort((a, b) => calendarTime(a) - calendarTime(b))[0];
    const el = document.getElementById("myDeadline");
    if (el) el.textContent = nearest || "—";
}

async function refreshState(force = false) {
    if (!tg?.initData || refreshing || busy || document.hidden) return;
    refreshing = true;
    const version = mutationVersion;
    try {
        const [state, catalog] = await Promise.all([api("state"), api("catalog")]);
        if (version !== mutationVersion || busy) return;
        applyCatalog(catalog);
        applyState(state);
        renderAll();
    } catch (error) {
        if (version !== mutationVersion) return;
        connected = false;
        connectionStatus(error.message, true);
        renderTopics();
        renderNotifications();
    } finally { refreshing = false; }
}

async function manualRefresh() {
    const button = document.getElementById("refreshButton");
    if (refreshing || busy) return;
    if (!tg?.initData) {
        window.location.reload();
        return;
    }
    button.disabled = true;
    button.classList.add("loading");
    connectionStatus("Обновляем данные…");
    try {
        await refreshState(true);
        if (connected) showStatus("Данные обновлены.");
    } finally {
        button.disabled = false;
        button.classList.remove("loading");
    }
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
        try { applyState(await api("state")); }
        catch { connected = false; connectionStatus("Связь с сервером потеряна. Данные могут быть неактуальны.", true); }
        return false;
    } finally {
        busy = false;
        renderAll();
    }
}

function renderTopics() {
    const container = document.getElementById("topicsContainer");
    const filters = document.getElementById("topicSubjectFilters");
    const subjects = [...new Set(topicsData.map(topic => topic.subject || ""))]
        .sort((a, b) => shortSubject(a).localeCompare(shortSubject(b), "ru"));
    if ((currentTopicSubject === "mine" && !isRegistered) ||
            (currentTopicSubject !== "all" && currentTopicSubject !== "mine" && !subjects.includes(currentTopicSubject))) {
        currentTopicSubject = "all";
    }
    filters.innerHTML = [{value: "all", label: "Все предметы"},
        ...(isRegistered ? [{value: "mine", label: `Мои доклады · ${myBookings.length}`}] : []),
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
    const visibleTopics = currentTopicSubject === "all" ? topicsData
        : currentTopicSubject === "mine" ? topicsData.filter(topic => myTopicIds.has(topic.id))
            : topicsData.filter(topic => (topic.subject || "") === currentTopicSubject);
    container.innerHTML = visibleTopics.length ? visibleTopics.map(topic => {
        const {owners, mine, occupied, status} = topicBookingState(topic);
        const disabled = !connected || busy || (!mine && occupied);
        const scope = topic.isCommon ? "Общий для групп" : `Для ${topic.group}`;
        return `<article class="topic-card ${mine ? "booked" : ""}">
            <div class="topic-number">${topic.id}</div>
            <div class="topic-title">${escapeHtml(topic.title)}</div>
            <div class="booking-owner" title="${escapeHtml(topic.subject || "Предмет не указан")}">📘 ${escapeHtml(shortSubject(topic.subject))}</div>
            <div class="booking-owner">Срок: ${escapeHtml(topic.deadline || "Не назначен")}</div>
            <div class="booking-owner">🎓 ${escapeHtml(scope)}</div>
            ${topic.isMulti ? '<div class="booking-owner">🎤 Несколько выступающих</div>' : ""}
            ${owners.map(b => `<div class="booking-owner">👥 ${escapeHtml(b.group)} · ${escapeHtml(b.user)}${b.isMine ? " (вы)" : ""}</div>`).join("")}
            ${occupied ? `<div class="topic-status">${escapeHtml(status)}</div>` : ""}
            <button class="btn ${mine ? "btn-danger" : "btn-primary"}"
                onclick="${mine ? "cancelBooking" : "handleTopicBooking"}(${topic.id})" ${disabled ? "disabled" : ""}>
                ${mine ? "Отменить выбор" : "Выбрать тему"}</button>
        </article>`;
    }).join("") : `<div class="empty-state">${currentTopicSubject === "mine"
        ? "Вы пока не выбрали ни одного доклада." : "По этому предмету тем пока нет."}</div>`;
    const visibleIds = new Set(visibleTopics.map(topic => topic.id));
    document.getElementById("topicsCount").textContent = visibleTopics.length;
    document.getElementById("bookedTopicsCount").textContent = new Set(
        bookings.filter(item => visibleIds.has(item.id)).map(item => item.id)
    ).size;
    const occupiedIds = new Set(bookings.map(item => item.id));
    document.getElementById("availableTopicsCount").textContent = isRegistered
        ? visibleTopics.filter(topic => !occupiedIds.has(topic.id)).length : "—";
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
        <div class="profile-header"><div class="profile-avatar">👤</div>
        <div><div class="profile-name">${escapeHtml(userData.name)}</div><div class="profile-status">✓ Профиль активен</div></div></div>
        <div class="info-item mb-12"><span class="label">Группа</span><span class="value">${escapeHtml(userData.group_name)}</span></div>
        <div class="info-item mb-12"><span class="label">Telegram</span><span class="value">${escapeHtml(userData.username ? "@" + userData.username : "Не указан")}</span></div>
        <button class="btn btn-outline" onclick="editProfile()">✏️ Редактировать профиль</button></div>
        <div class="profile-card card"><h3 class="section-title">Моя активность</h3>
        <p>Выбранных тем: ${myBookings.length}</p><p>Проведено занятий: ${scheduleData.filter(i => lessonEnd(i) < studyNow()).length}</p>
        <p>Домашних заданий: ${assignmentsData.length}</p></div>
        ${isAdmin ? `<div class="profile-card card"><h3 class="section-title">Администрирование</h3>
            <div class="admin-actions">
            <button class="btn btn-primary" onclick="renderTopicEditor()">📚 Управление темами</button>
            <button class="btn btn-primary" onclick="renderHomeworkEditor()">📝 Управление домашкой</button>
            <button class="btn btn-primary" onclick="renderScheduleEditor()">🗓 Управление расписанием</button>
            <button class="btn btn-outline" onclick="renderAuditLog()">🕘 История действий</button>
            </div></div>` : ""}`;
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
    editingTopics = true;
    const subjectOptions = [...new Set(scheduleData.map(item => item.subject).filter(Boolean))]
        .sort((a, b) => shortSubject(a).localeCompare(shortSubject(b), "ru"));
    const selectOptions = selected => `<option value="">Выберите предмет</option>${subjectOptions.map(subject =>
        `<option value="${escapeHtml(subject)}" ${subject === selected ? "selected" : ""}>${escapeHtml(shortSubject(subject))}</option>`).join("")}`;
    const groupOptions = selected => ["МН-4-25-01", "МН-4-25-02"].map(group =>
        `<option value="${group}" ${group === selected ? "selected" : ""}>${group}</option>`).join("");
    document.getElementById("cabinetContent").innerHTML = `<div class="profile-card card admin-editor">
        <h3 class="section-title">Управление темами</h3>
        <h4>Добавить тему доклада</h4>
        <div class="admin-create-grid">
            <div><label class="form-label" for="newTopicTitle">Название новой темы</label>
            <input class="form-control" id="newTopicTitle" maxlength="200" placeholder="Введите название"></div>
            <div><label class="form-label" for="newTopicSubject">Предмет</label>
            <select class="form-control" id="newTopicSubject">${selectOptions("")}</select></div>
            <div><label class="form-label" for="newTopicDeadline">Срок доклада, необязательно</label>
            <input class="form-control" type="date" id="newTopicDeadline"></div>
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
                <div><label class="form-label" for="draftTopicDeadline">Срок, необязательно</label>
                <input class="form-control" type="date" id="draftTopicDeadline"></div>
                <div><label class="form-label" for="draftTopicGroup">Группа</label>
                <select class="form-control" id="draftTopicGroup">${groupOptions("МН-4-25-01")}</select></div>
                <label><input type="checkbox" id="draftTopicCommon" onchange="syncTopicScope('draftTopic')"> Общий доклад</label>
                <label><input type="checkbox" id="draftTopicMulti"> Несколько выступающих</label>
            </div>
            <button class="btn btn-outline" onclick="addTopicDrafts()">Добавить список в черновик</button>
            ${adminTopicDrafts.length ? `<div class="draft-list">${adminTopicDrafts.map(item => `
                <div class="draft-item"><div><strong>${escapeHtml(item.title)}</strong>
                <span>${escapeHtml(shortSubject(item.subject))} · ${escapeHtml(item.isCommon ? "Для всех" : item.group)}${item.deadline ? ` · ${escapeHtml(item.deadline)}` : ""}</span></div>
                <button class="btn btn-danger btn-small" onclick="deleteTopicDraft(${item.id})">Убрать</button></div>`).join("")}</div>
                <h4>Предварительный просмотр рассылки</h4>
                <pre class="notification-preview">${escapeHtml(topicDraftPreview())}</pre>
                <div class="admin-actions">
                    <button class="btn btn-primary" onclick="publishTopicDrafts()">Опубликовать ${adminTopicDrafts.length} тем</button>
                    <button class="btn btn-secondary" onclick="clearTopicDrafts()">Очистить черновик</button>
                </div>` : '<div class="empty-state compact">Черновик пуст. Он сохраняется после закрытия приложения.</div>'}
        </div>
        <div class="admin-records">${adminTopics.map(topic => `<article class="admin-record ${topic.active ? "" : "archived"}">
            <div class="admin-record-heading"><strong>№${topic.id}</strong><span>${topic.active ? "Активна" : "В архиве"}</span></div>
            <label class="form-label" for="topic-title-${topic.id}">Название</label>
            <input class="form-control" id="topic-title-${topic.id}" maxlength="200" value="${escapeHtml(topic.title)}">
            <label class="form-label" for="topic-subject-${topic.id}">Предмет</label>
            <select class="form-control" id="topic-subject-${topic.id}">${selectOptions(topic.subject || "")}</select>
            <label class="form-label" for="topic-deadline-${topic.id}">Срок доклада</label>
            <input class="form-control" type="date" id="topic-deadline-${topic.id}" value="${dateInputValue(topic.deadline)}">
            <label class="form-label" for="topic-group-${topic.id}">Группа</label>
            <select class="form-control" id="topic-group-${topic.id}" ${topic.isCommon ? "disabled" : ""}>${groupOptions(topic.group || "МН-4-25-01")}</select>
            <label><input type="checkbox" id="topic-common-${topic.id}" ${topic.isCommon ? "checked" : ""}
                onchange="syncTopicScope('topic-${topic.id}')"> Общий доклад</label>
            <label><input type="checkbox" id="topic-multi-${topic.id}" ${topic.isMulti ? "checked" : ""}> Несколько выступающих</label>
            <div class="admin-bookings">${topic.bookings.length ? topic.bookings.map(item =>
                `<div class="admin-booking"><span>👥 ${escapeHtml(item.group)} · ${escapeHtml(item.user)}</span>
                <button class="btn btn-danger btn-small" onclick="removeBooking(${item.bookingId})">Снять бронь</button></div>`).join("") : "Бронирований нет"}</div>
            <div class="admin-actions">
                <button class="btn btn-outline" onclick="saveTopic(${topic.id})">Сохранить</button>
                <button class="btn btn-secondary" onclick="toggleTopic(${topic.id}, ${!topic.active})">${topic.active ? "В архив" : "Восстановить"}</button>
                <button class="btn btn-danger" onclick="deleteTopic(${topic.id})" ${topic.bookings.length ? "disabled" : ""}>Удалить</button>
            </div></article>`).join("")}</div>
        <button class="btn btn-secondary" onclick="closeTopicEditor()">Вернуться в кабинет</button></div>`;
}

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

function closeTopicEditor() { editingTopics = false; renderCabinet(); }

async function createTopic() {
    const title = document.getElementById("newTopicTitle").value.trim();
    const subject = document.getElementById("newTopicSubject").value.trim();
    const deadline = apiDate(document.getElementById("newTopicDeadline").value);
    if (!title) { showStatus("Введите название темы."); return; }
    if (!subject) { showStatus("Укажите предмет."); return; }
    const payload = {action: "create_topic", title, subject, ...topicScopePayload("newTopic")};
    if (deadline) payload.deadline = deadline;
    if (await performAction(payload)) renderTopicEditor();
}

function topicDraftPreview() {
    const heading = adminTopicDrafts.length === 1 ? "📚 Добавлена новая тема доклада"
        : `📚 Добавлены новые темы докладов: ${adminTopicDrafts.length}`;
    const rows = adminTopicDrafts.map((item, index) => {
        const scope = item.isCommon ? "Общий доклад" : `Группа: ${item.group}`;
        return `${index + 1}. ${item.title}\nПредмет: ${item.subject}\n${scope}${item.deadline ? `\nСрок: ${item.deadline}` : ""}`;
    });
    return `${heading}\n\n${rows.join("\n\n")}`;
}

async function addTopicDrafts() {
    const titles = document.getElementById("draftTopicTitles").value.split(/\r?\n/)
        .map(line => line.replace(/^\s*(?:\d+[.)]|[-–—•])\s*/, "").trim()).filter(Boolean);
    const subject = document.getElementById("draftTopicSubject").value.trim();
    const deadline = apiDate(document.getElementById("draftTopicDeadline").value);
    if (!titles.length) { showStatus("Добавьте названия тем построчно."); return; }
    if (titles.length > 50) { showStatus("За один раз можно добавить до 50 тем."); return; }
    if (!subject) { showStatus("Укажите предмет для списка тем."); return; }
    const payload = {action: "add_topic_drafts", titles, subject, ...topicScopePayload("draftTopic")};
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
    if (!subject) { showStatus("Укажите предмет."); return; }
    const payload = {action: "update_topic", topicId, title, subject, ...topicScopePayload(String(topicId))};
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
}

function lessonFields(prefix, lesson = {}) {
    const [start, end] = lessonTimeParts(lesson.time);
    return `<div class="lesson-fields">
        <div><label class="form-label" for="${prefix}-date">Дата</label><input class="form-control" type="date" id="${prefix}-date" value="${dateInputValue(lesson.date)}"></div>
        <div><label class="form-label" for="${prefix}-start">Начало</label><input class="form-control" type="time" id="${prefix}-start" value="${start}"></div>
        <div><label class="form-label" for="${prefix}-end">Окончание</label><input class="form-control" type="time" id="${prefix}-end" value="${end}"></div>
        <div><label class="form-label" for="${prefix}-type">Тип</label><select class="form-control" id="${prefix}-type"><option ${lesson.type === "Л" ? "selected" : ""}>Л</option><option ${lesson.type === "ПЗ" ? "selected" : ""}>ПЗ</option></select></div>
        <div class="wide"><label class="form-label" for="${prefix}-subject">Дисциплина</label><input class="form-control" id="${prefix}-subject" list="scheduleSubjectSuggestions" maxlength="200" value="${escapeHtml(lesson.subject || "")}" placeholder="Выберите или введите дисциплину" oninput="fillTeacherFromSubject('${prefix}')"></div>
        <div><label class="form-label" for="${prefix}-teacher">Преподаватель</label><input class="form-control" id="${prefix}-teacher" maxlength="100" value="${escapeHtml(lesson.teacher || "")}"></div>
        <div><label class="form-label" for="${prefix}-room">Аудитория</label><input class="form-control" id="${prefix}-room" maxlength="100" value="${escapeHtml(lesson.room || "")}"></div>
        <div><label class="form-label" for="${prefix}-group">Группа</label><input class="form-control" id="${prefix}-group" maxlength="40" value="${escapeHtml(lesson.group || "МН-4-25-01")}"></div>
        <div class="wide"><label class="form-label" for="${prefix}-url">Ссылка, необязательно</label><input class="form-control" type="url" id="${prefix}-url" maxlength="1000" placeholder="https://..." value="${escapeHtml(lesson.url || "")}"></div>
    </div>`;
}

function lessonPayload(prefix) {
    const start = document.getElementById(`${prefix}-start`).value;
    const end = document.getElementById(`${prefix}-end`).value;
    return {date: apiDate(document.getElementById(`${prefix}-date`).value), time: `${start}–${end}`,
        type: document.getElementById(`${prefix}-type`).value,
        subject: document.getElementById(`${prefix}-subject`).value.trim(),
        teacher: document.getElementById(`${prefix}-teacher`).value.trim(),
        room: document.getElementById(`${prefix}-room`).value.trim(),
        group: document.getElementById(`${prefix}-group`).value.trim(),
        url: document.getElementById(`${prefix}-url`).value.trim()};
}

function renderScheduleEditor() {
    if (!isAdmin) return;
    editingTopics = false;
    editingHomework = false;
    editingAudit = false;
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
    document.getElementById("cabinetContent").innerHTML = `<div class="profile-card card admin-editor">
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
        <button class="btn btn-secondary" onclick="closeScheduleEditor()">Вернуться в кабинет</button></div>`;
}

function closeScheduleEditor() { editingSchedule = false; renderCabinet(); }

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
    {id: "assignments", title: "Домашние задания", description: "Новая домашка и напоминания за день до сдачи."},
    {id: "schedule", title: "Изменения расписания", description: "Сообщение при обновлении расписания."},
    {id: "topics", title: "Темы докладов", description: "Новые темы одной подборкой и напоминания о сроках."}
];

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
    if (!container) return;
    container.innerHTML = assignmentsData.length ? assignmentsData.map(item => `<article class="topic-card homework-card">
        <div class="booking-owner" title="${escapeHtml(item.subject)}">📘 ${escapeHtml(shortSubject(item.subject))}</div>
        <div class="homework-description">${escapeHtml(item.description)}</div>
        <div class="booking-owner">📅 Срок: ${escapeHtml(item.deadline)}</div>
    </article>`).join("") : `<div class="empty-state">Домашних заданий пока нет.</div>`;
}

function renderHomeworkEditor() {
    if (!isAdmin) return;
    editingProfile = false;
    editingTopics = false;
    editingSchedule = false;
    editingAudit = false;
    editingHomework = true;
    document.getElementById("cabinetContent").innerHTML = `<div class="profile-card card admin-editor">
        <h3 class="section-title">Управление домашкой</h3>
        <h4>Добавить домашнее задание</h4>
        <div class="admin-create-grid">
            <div><label class="form-label" for="newAssignmentSubject">Предмет</label>
            <select class="form-control" id="newAssignmentSubject">${homeworkSubjectOptions()}</select></div>
            <div class="wide"><label class="form-label" for="newAssignmentDescription">Описание</label>
            <textarea class="form-control" id="newAssignmentDescription" maxlength="2000" rows="5" placeholder="Что нужно сделать"></textarea></div>
            <div><label class="form-label" for="newAssignmentDeadline">Срок</label>
            <input class="form-control" type="date" id="newAssignmentDeadline"></div>
        </div>
        <button class="btn btn-primary" onclick="createAssignment()">Добавить задание</button>
        <div class="admin-records">${adminAssignments.length ? adminAssignments.map(item => `<details class="admin-record">
            <summary>${escapeHtml(item.deadline)} · ${escapeHtml(shortSubject(item.subject))}</summary>
            <label class="form-label" for="assignment-subject-${item.id}">Предмет</label>
            <select class="form-control" id="assignment-subject-${item.id}">${homeworkSubjectOptions(item.subject)}</select>
            <label class="form-label" for="assignment-description-${item.id}">Описание</label>
            <textarea class="form-control" id="assignment-description-${item.id}" maxlength="2000" rows="5">${escapeHtml(item.description)}</textarea>
            <label class="form-label" for="assignment-deadline-${item.id}">Срок</label>
            <input class="form-control" type="date" id="assignment-deadline-${item.id}" value="${dateInputValue(item.deadline)}">
            <div class="admin-actions">
                <button class="btn btn-outline" onclick="saveAssignment(${item.id})">Сохранить</button>
                <button class="btn btn-danger" onclick="deleteAssignment(${item.id})">Удалить</button>
            </div></details>`).join("") : `<div class="empty-state">Домашних заданий пока нет.</div>`}</div>
        <button class="btn btn-secondary" onclick="closeHomeworkEditor()">Вернуться в кабинет</button></div>`;
}

function renderAuditLog() {
    if (!isAdmin) return;
    editingProfile = false;
    editingTopics = false;
    editingSchedule = false;
    editingHomework = false;
    editingAudit = true;
    const actionNames = {create: "Создание", update: "Изменение", delete: "Удаление",
        archive: "Архив", restore: "Восстановление", deadline: "Срок",
        cancel_booking: "Бронирование", publish: "Публикация"};
    document.getElementById("cabinetContent").innerHTML = `<div class="profile-card card admin-editor">
        <h3 class="section-title">История действий</h3>
        <p class="draft-help">Последние действия администраторов. Хранится до 300 записей.</p>
        <div class="audit-list">${adminAuditLog.length ? adminAuditLog.map(item => `<article class="audit-item">
            <div><strong>${escapeHtml(actionNames[item.action] || item.action)}</strong><span>${escapeHtml(item.actor)}</span></div>
            <p>${escapeHtml(item.summary)}</p><time>${escapeHtml(new Date(item.createdAt).toLocaleString("ru-RU"))}</time>
        </article>`).join("") : '<div class="empty-state">История пока пуста.</div>'}</div>
        <button class="btn btn-secondary" onclick="closeAuditLog()">Вернуться в кабинет</button></div>`;
}

function closeAuditLog() { editingAudit = false; renderCabinet(); }

function assignmentPayload(prefix) {
    return {
        subject: document.getElementById(`${prefix}Subject`).value.trim(),
        description: document.getElementById(`${prefix}Description`).value.trim(),
        deadline: apiDate(document.getElementById(`${prefix}Deadline`).value)
    };
}

async function createAssignment() {
    const payload = assignmentPayload("newAssignment");
    if (!payload.subject || !payload.description || !payload.deadline) {
        showStatus("Заполните предмет, описание и срок."); return;
    }
    if (await performAction({action: "create_assignment", ...payload})) renderHomeworkEditor();
}

async function saveAssignment(assignmentId) {
    const payload = {
        subject: document.getElementById(`assignment-subject-${assignmentId}`).value.trim(),
        description: document.getElementById(`assignment-description-${assignmentId}`).value.trim(),
        deadline: apiDate(document.getElementById(`assignment-deadline-${assignmentId}`).value)
    };
    if (!payload.subject || !payload.description || !payload.deadline) {
        showStatus("Заполните предмет, описание и срок."); return;
    }
    if (await performAction({action: "update_assignment", assignmentId, ...payload})) renderHomeworkEditor();
}

async function deleteAssignment(assignmentId) {
    if (!window.confirm("Удалить это домашнее задание?")) return;
    if (await performAction({action: "delete_assignment", assignmentId})) renderHomeworkEditor();
}

function closeHomeworkEditor() { editingHomework = false; renderCabinet(); }

function renderQueue() {
    document.getElementById("queueTotal").textContent = connected ? participants : "—";
    document.getElementById("queueBooked").textContent = connected
        ? new Set(bookings.map(item => item.id)).size : "—";
    const occupiedIds = new Set(bookings.map(item => item.id));
    document.getElementById("queueFree").textContent = isRegistered
        ? topicsData.filter(topic => !occupiedIds.has(topic.id)).length : "—";
    const topicTotal = document.getElementById("queueTopicsTotal");
    if (topicTotal) topicTotal.textContent = topicsData.length;
    document.getElementById("queueList").innerHTML = bookings.length ? bookings.map(b => `<article class="topic-card">
        <div class="topic-title">${escapeHtml(b.title)}</div>
        <div class="booking-owner" title="${escapeHtml(b.subject || "Предмет не указан")}">📘 ${escapeHtml(shortSubject(b.subject))}</div>
        <div class="booking-owner">👥 ${escapeHtml(b.group)} · ${escapeHtml(b.user)}</div></article>`).join("")
        : `<div class="empty-state">${connected ? "Пока нет бронирований." : "Для просмотра бронирований откройте приложение через бота."}</div>`;
}

document.addEventListener("DOMContentLoaded", async () => {
    setupFilters();
    try {
        applyCatalog(await api("catalog"));
        if (tg?.initData) { applyState(await api("state")); }
        else connectionStatus("Режим просмотра. Для регистрации и бронирования откройте приложение через кнопку бота.", true);
    } catch (error) {
        connectionStatus(error.message + " Показаны исходные учебные данные; актуальные сроки загрузятся при подключении.", true);
        try {
            const response = await fetch("catalog.json", {cache: "no-store"});
            if (response.ok) applyCatalog(await response.json());
        } catch { /* The connection banner already explains the failure. */ }
    }
    renderAll();
    if (connected && !isRegistered) switchTab("cabinet");
    setInterval(refreshState, 5000);
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
                    <div class="icon">📭</div>
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
                                ${todayLesson ? "● Сегодня" : (done ? "✓ Проведено" : "• Предстоит")}
                            </span>
                        </div>

                    </div>

                    ${item.url ? `<a class="btn btn-primary lesson-link-button" href="${escapeHtml(item.url)}" target="_blank" rel="noopener noreferrer">🔗 Подключиться к паре</a>` : ""}

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

    function renderMyBookings() {
        const container =
            document.getElementById(
                "myBookingsContainer"
            );

        const count =
            document.getElementById(
                "myBookingsCount"
            );

        const progress =
            document.getElementById(
                "myProgress"
            );

        if (count) {
            count.textContent =
                myBookings.length;
        }

        const progressValue = topicsData.length ?
            Math.min(
                100,
                Math.round(
                    (myBookings.length /
                        topicsData.length) *
                    100
                )
            ) : 0;

        if (progress) {
            progress.textContent =
                progressValue + "%";
        }

        if (!container) return;

        if (!myBookings.length) {

            container.innerHTML = `
                <div class="empty-state">
                    <div class="icon">📚</div>

                    <div>
                        Вы пока не выбрали тему доклада.
                    </div>

                    <div
                        class="muted"
                        style="margin-top:5px;"
                    >
                        Выберите тему выше.
                    </div>
                </div>
            `;

            return;
        }

        container.innerHTML =
            myBookings.map(item => `
                <article class="booking-item">

                    <div class="booking-title">
                        №${item.id}. ${escapeHtml(item.title)}
                    </div>

                    <div class="booking-meta">
                        Предмет: ${escapeHtml(shortSubject(item.subject))}<br>
                        Забронировано:
                        ${escapeHtml(formatDate(item.date))}
                    </div>

                    <div class="booking-actions">

                        <button
                            class="btn btn-danger"
                            onclick="cancelBooking(${item.id})" ${!connected || busy || item.id === null ? "disabled" : ""}
                        >
                            Отменить
                        </button>

                    </div>

                </article>
            `).join("");
    }

    function exportBookings() {
        if (!myBookings.length) {
            showStatus("Нет выбранных тем для экспорта.");
            return;
        }

        const text =
            [
                "Мои темы докладов",
                "",
                ...myBookings.map(
                    item =>
                        `${item.id}. ${item.title}${item.subject ? ` — ${item.subject}` : ""}`
                )
            ].join("\n");

        const blob =
            new Blob(
                [text],
                {
                    type: "text/plain;charset=utf-8"
                }
            );

        const url =
            URL.createObjectURL(blob);

        const link =
            document.createElement("a");

        link.href = url;
        link.download = "мои-доклады.txt";

        document.body.appendChild(link);
        link.click();
        link.remove();

        URL.revokeObjectURL(url);

        showStatus("Список тем экспортирован.");
    }

    async function downloadSchedule() {
        if (downloadSchedule.pending) return;
        if (typeof html2pdf !== "function") {
            showStatus("Модуль PDF не загрузился. Проверьте подключение и обновите страницу.");
            return;
        }
        const items = scheduleItems(currentScheduleFilter);
        if (!items.length) { showStatus("Нет занятий для выгрузки."); return; }
        downloadSchedule.pending = true;
        showStatus("Формируем PDF...");
        const wrapper = document.createElement("div");
        wrapper.style.cssText = "width:100%;padding:0;background:#fff;color:#172033;font:12px Arial,sans-serif;";
        const cell = "border:1px solid #cbd5e1;padding:8px;vertical-align:top;overflow-wrap:break-word;";
        wrapper.innerHTML = `<h1 style="font-size:24px;margin:0 0 8px">Расписание</h1>
            <p style="margin:0 0 16px">МН-4-25-01 · иностранный язык по расписанию МН-4-25-02<br>
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
            await html2pdf().set({
                margin: 10, filename: "расписание-МН-4-25-01.pdf",
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

        if (!["schedule", "homework", "reports", "cabinet", "notifications", "queue"].includes(tabName)) return;
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

        window.scrollTo({
            top: 0,
            behavior: "smooth"
        });
    }
