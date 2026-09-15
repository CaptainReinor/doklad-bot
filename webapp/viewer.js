"use strict";

const viewerTg = window.Telegram?.WebApp || null;
const content = document.getElementById("viewerContent");
const title = document.getElementById("viewerTitle");
const download = document.getElementById("viewerDownload");
const back = document.getElementById("viewerBack");

function returnToApp() {
    if (history.length > 1) history.back();
    else window.location.replace("/");
}

function showMessage(message) {
    content.innerHTML = "";
    const block = document.createElement("div");
    block.className = "viewer-message";
    block.textContent = message;
    content.appendChild(block);
}

function trustedFileUrl() {
    const value = new URLSearchParams(window.location.search).get("file");
    if (!value) return null;
    try {
        const parsed = new URL(value, window.location.origin);
        return parsed.origin === window.location.origin && parsed.pathname.startsWith("/files/") ? parsed : null;
    } catch { return null; }
}

async function renderFile() {
    const file = trustedFileUrl();
    if (!file) {
        download.hidden = true;
        showMessage("Файл не найден или адрес недействителен.");
        return;
    }
    const fileName = file.searchParams.get("name") || decodeURIComponent(file.pathname.split("/").pop());
    const extension = file.pathname.split(".").pop().toLowerCase();
    const downloadUrl = new URL(file.href);
    downloadUrl.searchParams.set("download", "1");
    title.textContent = fileName;
    document.title = fileName;
    download.href = downloadUrl.href;
    download.setAttribute("download", fileName);

    if (["doc", "docx", "xls", "xlsx", "ppt", "pptx"].includes(extension)) {
        const frame = document.createElement("iframe");
        frame.className = "viewer-frame";
        frame.title = `Просмотр файла ${fileName}`;
        frame.src = `https://view.officeapps.live.com/op/embed.aspx?src=${encodeURIComponent(file.href)}`;
        content.appendChild(frame);
        return;
    }
    if (extension === "pdf") {
        const frame = document.createElement("iframe");
        frame.className = "viewer-frame";
        frame.title = `Просмотр файла ${fileName}`;
        frame.src = file.href;
        content.appendChild(frame);
        return;
    }
    if (["png", "jpg", "jpeg"].includes(extension)) {
        const image = document.createElement("img");
        image.className = "viewer-image";
        image.alt = fileName;
        image.src = file.href;
        content.appendChild(image);
        return;
    }
    if (extension === "txt") {
        try {
            const response = await fetch(file.href);
            if (!response.ok) throw new Error();
            const text = document.createElement("pre");
            text.className = "viewer-text";
            text.textContent = await response.text();
            content.appendChild(text);
        } catch { showMessage("Не удалось открыть текстовый файл. Скачайте его на устройство."); }
        return;
    }
    showMessage("Для этого формата предварительный просмотр недоступен. Скачайте файл на устройство.");
}

back.addEventListener("click", returnToApp);
viewerTg?.ready();
viewerTg?.expand();
viewerTg?.BackButton?.show();
viewerTg?.BackButton?.onClick(returnToApp);
renderFile();
