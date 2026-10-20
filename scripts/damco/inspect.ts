import { mkdirSync, writeFileSync } from "fs";
import { join, resolve } from "path";
import { chromium, type Frame, type Page } from "playwright";

// READ-ONLY inspection of the operator's Damco browser (see browser.ts).
// Records page structure (labels, ids, names, option texts, table headers) and a
// screenshot. Never reads input values, never types, never clicks.
//   --label <name>    folder label under var/damco-debug
//   --wait-login      poll until the operator has signed in (max 15 min)
const CDP = "http://127.0.0.1:9333";
const args = process.argv.slice(2);
const li = args.indexOf("--label");
const label = li >= 0 && args[li + 1] ? args[li + 1].replace(/[^\w-]/g, "_") : "snapshot";
const waitLogin = args.includes("--wait-login");
const gi = args.indexOf("--goto");
const gotoRel = gi >= 0 && args[gi + 1] ? args[gi + 1] : "";

function sanitizeUrl(u: string): string {
  return u.replace(/;jsessionid=[^?#/]*/gi, "").split(/[?#]/)[0];
}

async function inventory(frame: Frame) {
  // tsx/esbuild wraps named functions in __name(); define it in the page realm.
  await frame.evaluate("globalThis.__name = globalThis.__name || ((f) => f)");
  return frame.evaluate(() => {
    const vis = (el: Element) => {
      const r = (el as HTMLElement).getBoundingClientRect();
      const s = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none";
    };
    const labelOf = (el: Element) => {
      const id = el.id;
      const l = id ? document.querySelector(`label[for="${CSS.escape(id)}"]`) : el.closest("label");
      const cell = el.closest("td")?.previousElementSibling?.textContent;
      return (l?.textContent || el.getAttribute("aria-label") || el.getAttribute("placeholder") || el.getAttribute("title") || cell || "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 80);
    };
    const clean = (h: string | null) => (h ? h.replace(/;jsessionid=[^?#/]*/gi, "").split("?")[0].slice(0, 140) : null);
    const text = (document.body?.innerText || "").replace(/\s+/g, " ");
    return {
      title: document.title,
      inputs: [...document.querySelectorAll("input,textarea")]
        .filter((e) => vis(e) && (e as HTMLInputElement).type !== "hidden")
        .map((e) => ({ tag: e.tagName.toLowerCase(), type: (e as HTMLInputElement).type, id: e.id, name: e.getAttribute("name"), label: labelOf(e) })),
      selects: [...document.querySelectorAll("select")]
        .filter(vis)
        .map((e) => ({ id: e.id, name: e.getAttribute("name"), label: labelOf(e), options: [...(e as HTMLSelectElement).options].slice(0, 60).map((o) => o.text.trim()) })),
      actions: [...document.querySelectorAll("button,input[type=submit],input[type=button],input[type=image],a,[role=button],[role=tab]")]
        .filter(vis)
        .map((e) => ({
          tag: e.tagName.toLowerCase(),
          id: e.id,
          text: ((e as HTMLElement).innerText || (e as HTMLInputElement).value || e.getAttribute("title") || e.getAttribute("alt") || "").replace(/\s+/g, " ").trim().slice(0, 60),
          href: clean(e.getAttribute("href")),
          onclick: (e.getAttribute("onclick") || "").slice(0, 100),
        }))
        .filter((a) => a.text || a.id)
        .slice(0, 250),
      tables: [...document.querySelectorAll("table")]
        .filter(vis)
        .slice(0, 30)
        .map((t) => ({ id: t.id, cls: String(t.className).slice(0, 60), headers: [...t.querySelectorAll("th")].map((th) => th.textContent!.replace(/\s+/g, " ").trim()).slice(0, 40), rows: t.querySelectorAll("tr").length })),
      iframes: [...document.querySelectorAll("iframe,frame")].map((f) => ({ id: f.id, name: f.getAttribute("name"), src: clean(f.getAttribute("src")) })),
      passwordVisible: [...document.querySelectorAll("input[type=password]")].some(vis),
      captchaHint: /recaptcha|hcaptcha|captcha|verify you are human|cf-challenge/i.test(document.documentElement.innerHTML),
      mfaHint: /one[- ]time (pass)?code|verification code|authenticator|\bOTP\b/i.test(text),
      errorText: (text.match(/[^.]{0,80}(invalid|incorrect|locked|expired|denied|not authori[sz]ed|failed)[^.]{0,80}/i) || [""])[0].slice(0, 200),
      textSample: text.slice(0, 1500),
    };
  });
}

async function snapshot(page: Page) {
  const frames = [];
  for (const f of page.frames()) {
    try {
      frames.push({ name: f.name(), url: sanitizeUrl(f.url()), ...(await inventory(f)) });
    } catch (e) {
      frames.push({ name: f.name(), url: sanitizeUrl(f.url()), error: e instanceof Error ? e.message : String(e) });
    }
  }
  return { url: sanitizeUrl(page.url()), at: new Date().toISOString(), frames };
}

function loggedIn(s: Awaited<ReturnType<typeof snapshot>>): boolean {
  const onDamco = /booking\.damco\.com/i.test(s.url);
  const anyPassword = s.frames.some((f) => "passwordVisible" in f && f.passwordVisible);
  return onDamco && !anyPassword && !/login|logon|signin/i.test(s.url);
}

async function main() {
  const browser = await chromium.connectOverCDP(CDP);
  try {
    const pages = browser.contexts().flatMap((c) => c.pages());
    const page = pages.find((p) => /damco|maersk/i.test(p.url())) ?? pages[0];
    if (!page) throw new Error("No open page in the Damco browser.");

    if (gotoRel) {
      const target = /^https?:/i.test(gotoRel) ? gotoRel : `https://booking.damco.com/ShipperPortalWeb/${gotoRel}`;
      await page.goto(target, { waitUntil: "domcontentloaded" });
      await page.waitForTimeout(1500);
    }

    if (waitLogin) {
      const deadline = Date.now() + 15 * 60_000;
      let stable = 0;
      for (;;) {
        const live = browser.contexts().flatMap((c) => c.pages()).find((p) => /damco|maersk/i.test(p.url())) ?? page;
        const s = await snapshot(live).catch(() => null);
        stable = s && loggedIn(s) ? stable + 1 : 0;
        if (stable >= 3) break;
        if (Date.now() > deadline) {
          console.log("LOGIN_TIMEOUT: operator did not complete sign-in within 15 minutes.");
          break;
        }
        await new Promise((r) => setTimeout(r, 2000));
      }
    }

    const target = browser.contexts().flatMap((c) => c.pages()).find((p) => /damco|maersk/i.test(p.url())) ?? page;
    const s = await snapshot(target);
    const dir = resolve("var", "damco-debug", `${new Date().toISOString().replace(/[:.]/g, "-")}-${label}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "inventory.json"), JSON.stringify(s, null, 2));
    await target.screenshot({ path: join(dir, "page.png"), fullPage: true });

    console.log(`URL: ${s.url}`);
    console.log(`LOGGED_IN: ${loggedIn(s)}`);
    for (const f of s.frames) {
      if ("error" in f) {
        console.log(`frame ${f.name || "(main)"} ${f.url}: ERROR ${f.error}`);
        continue;
      }
      console.log(`\n# frame "${f.name || "(main)"}" ${f.url}  title="${f.title}"`);
      console.log(`  passwordVisible=${f.passwordVisible} captchaHint=${f.captchaHint} mfaHint=${f.mfaHint}${f.errorText ? ` errorText="${f.errorText}"` : ""}`);
      for (const i of f.inputs) console.log(`  input  ${i.type.padEnd(9)} id=${i.id || "-"} name=${i.name || "-"} label="${i.label}"`);
      for (const sel of f.selects) console.log(`  select id=${sel.id || "-"} name=${sel.name || "-"} label="${sel.label}" options=[${sel.options.slice(0, 12).join(" | ")}${sel.options.length > 12 ? " …" : ""}]`);
      for (const a of f.actions.slice(0, 80)) console.log(`  action ${a.tag} id=${a.id || "-"} "${a.text}"${a.href ? ` href=${a.href}` : ""}${a.onclick ? ` onclick=${a.onclick}` : ""}`);
      for (const t of f.tables.filter((t) => t.headers.length)) console.log(`  table id=${t.id || "-"} rows=${t.rows} headers=[${t.headers.join(" | ")}]`);
      for (const fr of f.iframes) console.log(`  frame-el id=${fr.id || "-"} name=${fr.name || "-"} src=${fr.src}`);
    }
    console.log(`\nSaved: ${dir}`);
  } finally {
    await browser.close();
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
