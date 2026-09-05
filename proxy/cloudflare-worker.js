const BOT_ID = "8235003921";
const APP_ORIGIN = "http://origin.138-16-179-240.sslip.io";

export default {
  async fetch(request) {
    const incoming = new URL(request.url);

    const prefix = "/telegram/";
    if (!incoming.pathname.startsWith(prefix)) {
      return proxyApplication(request, incoming);
    }

    const telegramPath = incoming.pathname.slice(prefix.length);
    const allowedBotApi = telegramPath.startsWith(`bot${BOT_ID}:`);
    const allowedFileApi = telegramPath.startsWith(`file/bot${BOT_ID}:`);
    if (!allowedBotApi && !allowedFileApi) {
      return new Response("Forbidden", { status: 403 });
    }

    const target = new URL(`https://api.telegram.org/${telegramPath}`);
    target.search = incoming.search;
    const headers = new Headers(request.headers);
    headers.delete("host");

    return fetch(target, {
      method: request.method,
      headers,
      body: request.method === "GET" || request.method === "HEAD" ? undefined : request.body,
      redirect: "manual"
    });
  }
};

async function proxyApplication(request, incoming) {
  const target = new URL(incoming.pathname + incoming.search, APP_ORIGIN);
  const headers = new Headers(request.headers);
  headers.delete("host");
  if (headers.has("origin")) headers.set("origin", APP_ORIGIN);
  if (headers.has("referer")) headers.set("referer", `${APP_ORIGIN}/`);

  const upstream = await fetch(target, {
    method: request.method,
    headers,
    body: request.method === "GET" || request.method === "HEAD" ? undefined : request.body,
    redirect: "manual"
  });
  const responseHeaders = new Headers(upstream.headers);
  const location = responseHeaders.get("location");
  if (location?.startsWith(APP_ORIGIN)) {
    responseHeaders.set("location", incoming.origin + location.slice(APP_ORIGIN.length));
  }
  responseHeaders.set("x-student-app-proxy", "cloudflare");
  const body = request.method === "HEAD" || [204, 304].includes(upstream.status)
    ? null : upstream.body;
  return new Response(body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: responseHeaders
  });
}
