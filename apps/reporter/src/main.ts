import { toPng } from 'html-to-image';
import {
  MAX_SCREENSHOT_LENGTH,
  redactText,
  redactUrl,
  type Feedback,
  type FeedbackInput,
} from '@surflet/core';

interface Context {
  previewId: string;
  name: string;
  revision: string;
  expiresAt: string;
  shareUrl?: string;
}
const root = document.createElement('surflet-reporter');
const shadow = root.attachShadow({ mode: 'open' });
const errors: NonNullable<FeedbackInput['consoleErrors']> = [];
const network: NonNullable<FeedbackInput['networkErrors']> = [];
const steps: string[] = [];
let screenshot: string | undefined;
let context: Context | undefined;
let panelOpen = false;
let screenshotGeneration = 0;
let submitting = false;
let opener: HTMLElement | null = null;

function keep<T>(list: T[], value: T) {
  list.push(value);
  if (list.length > 20) list.shift();
}
function errorMessage(value: unknown) {
  if (value instanceof Error) return redactText(value.message).slice(0, 1500);
  if (typeof value === 'string') return redactText(value).slice(0, 1500);
  return 'An error occurred (non-text error details omitted).';
}
window.addEventListener('error', (event) =>
  keep(errors, { message: errorMessage(event.message), timestamp: new Date().toISOString() }),
);
window.addEventListener('unhandledrejection', (event) =>
  keep(errors, { message: errorMessage(event.reason), timestamp: new Date().toISOString() }),
);
const originalConsoleError = console.error.bind(console);
console.error = (...args: unknown[]) => {
  keep(errors, {
    message: args.map(errorMessage).join(' ').slice(0, 1500),
    timestamp: new Date().toISOString(),
  });
  originalConsoleError(...args);
};
const originalFetch = window.fetch.bind(window);
window.fetch = async (input, init) => {
  const url =
    typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
  const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
  try {
    const result = await originalFetch(input, init);
    if (!url.includes('/__surflet/') && result.status >= 400)
      keep(network, {
        url: redactUrl(new URL(url, location.href).toString()),
        method,
        status: result.status,
        requestId: result.headers.get('x-surflet-request-id')?.slice(0, 100) || undefined,
      });
    return result;
  } catch (error) {
    if (!url.includes('/__surflet/'))
      keep(network, { url: redactUrl(new URL(url, location.href).toString()), method, status: 0 });
    throw error;
  }
};
const originalOpen = XMLHttpRequest.prototype.open;
const xhrListeners = new WeakMap<XMLHttpRequest, EventListener>();
XMLHttpRequest.prototype.open = function (
  method: string,
  url: string | URL,
  async = true,
  username?: string | null,
  password?: string | null,
) {
  const previous = xhrListeners.get(this);
  if (previous) this.removeEventListener('loadend', previous);
  const listener: EventListener = () => {
    if (this.status === 0 || this.status >= 400)
      keep(network, {
        url: redactUrl(new URL(String(url), location.href).toString()),
        method,
        status: this.status,
        requestId: this.getResponseHeader('x-surflet-request-id')?.slice(0, 100) || undefined,
      });
  };
  xhrListeners.set(this, listener);
  this.addEventListener('loadend', listener);
  Reflect.apply(originalOpen, this, [method, url, async, username, password]);
};
document.addEventListener(
  'click',
  (event) => {
    const target = event.target;
    if (!(target instanceof Element) || target === root || target.closest('[data-surflet-private]'))
      return;
    const actionable = target.closest('button,a,[role="button"]');
    if (!actionable) return;
    const label =
      actionable.getAttribute('aria-label') ?? actionable.textContent ?? actionable.tagName;
    keep(
      steps,
      `Click ${actionable.tagName.toLowerCase()}: ${redactText(label.trim()).slice(0, 80)}`,
    );
  },
  true,
);

shadow.innerHTML = `
<style>
:host{all:initial;position:fixed;z-index:2147483000;right:20px;bottom:20px;font-family:ui-sans-serif,system-ui,-apple-system,sans-serif;color:#20231e;font-size:14px;line-height:1.5}
*{box-sizing:border-box}button,input,textarea{font:inherit}button{cursor:pointer}button:disabled{cursor:wait;opacity:.65}
.launcher{display:flex;align-items:center;gap:9px;background:#222a24;color:#fff;border:1px solid #39423b;border-radius:999px;padding:12px 18px;box-shadow:0 5px 24px #0003;font-size:13px;font-weight:600}
.dot{width:7px;height:7px;border-radius:50%;background:#efb384}.panel{width:min(390px,calc(100vw - 32px));background:#fbfaf7;border:1px solid #dddcd5;border-radius:18px;box-shadow:0 16px 64px #18241f33;overflow:hidden}
.top{display:flex;justify-content:space-between;align-items:start;padding:21px 22px 15px;border-bottom:1px solid #e8e7df}.eyebrow{font-size:10px;letter-spacing:.14em;text-transform:uppercase;color:#84877c;margin-bottom:4px}h2{font-size:18px;line-height:1.3;margin:0;font-weight:650}.close{border:0;background:transparent;font-size:22px;line-height:1;color:#7b7e75;padding:0 0 5px 10px}
form,.success{padding:19px 22px}label{display:block;font-size:12px;font-weight:600;margin-bottom:7px}textarea,input[type=text]{width:100%;border:1px solid #d8dbd1;border-radius:9px;background:#fff;padding:10px 12px;outline:none;resize:vertical}textarea:focus,input:focus{border-color:#c45e3a;box-shadow:0 0 0 3px #c45e3a15}textarea{min-height:105px;margin-bottom:14px}.optional{color:#96998f;font-weight:400}
.context{font-family:ui-monospace,SFMono-Regular,monospace;font-size:10px;color:#7c8075;overflow-wrap:anywhere;margin:14px 0 10px}.check{display:flex;align-items:center;gap:8px;font-weight:400;font-size:12px;margin-top:13px}.note{font-size:11px;color:#858a7e;margin:6px 0 12px}.capture{border:1px solid #d8dbd1;border-radius:7px;background:#fff;padding:6px 9px;font-size:11px}.image{max-width:100%;max-height:160px;object-fit:contain;border:1px solid #ddd;border-radius:7px;margin:10px 0;display:block}.actions{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-top:16px}.brand{font-size:11px;color:#92958c}.submit{background:#bf5736;color:#fff;border:0;border-radius:8px;padding:10px 15px;font-weight:600;font-size:12px}.error{font-size:12px;color:#a33b23;white-space:pre-wrap;margin:10px 0 0}.success p{font-size:13px;color:#73796e}.success h3{font-size:17px;margin:0}.hidden{display:none!important}
@media(max-width:500px){:host{right:16px;bottom:16px}.panel{max-height:85vh;overflow:auto}}
</style>
<button class="launcher" type="button" aria-label="Report feedback"><span class="dot"></span>Feedback <span style="opacity:.5">/</span> Surflet</button>
 <section class="panel hidden" role="dialog" aria-modal="true" aria-label="Send feedback" tabindex="-1">
 <header class="top"><div><div class="eyebrow">Shared local preview</div><h2>What should we improve?</h2></div><button class="close" type="button" aria-label="Close feedback">×</button></header>
 <form>
  <label for="message">Your feedback</label><textarea id="message" name="message" maxlength="4000" required placeholder="What happened? What did you expect?"></textarea>
  <label for="reporter">Your name <span class="optional">(optional)</span></label><input id="reporter" type="text" name="reporter" maxlength="80" autocomplete="off" placeholder="How should we address you?">
  <div class="context" aria-live="polite">Connecting to preview…</div>
  <label class="check"><input id="include-screenshot" type="checkbox">Include a screenshot</label>
  <p class="note">Browser errors and recent clicks are included. Form fields and private elements are excluded from screenshots. Review the image before sending.</p>
  <button class="capture hidden" type="button">Capture screenshot</button><img class="image hidden" alt="Screenshot to include with feedback">
  <p class="error" role="alert"></p><button class="retry-context hidden" type="button">Retry connection</button>
  <div class="actions"><span class="brand">Feedback → your developer</span><button class="submit" type="submit">Send feedback</button></div>
 </form>
 <div class="success hidden"><h3>Feedback delivered.</h3><p>Your developer can read this report with the app version and browser context.</p><button class="submit done" type="button">Report another issue</button></div>
</section>`;
document.body.append(root);
function element<T extends Element>(selector: string): T {
  const result = shadow.querySelector<T>(selector);
  if (!result) throw new Error(`Missing reporter element: ${selector}`);
  return result;
}
const form = element<HTMLFormElement>('form');
const message = element<HTMLTextAreaElement>('#message');
const includeScreenshot = element<HTMLInputElement>('#include-screenshot');
const image = element<HTMLImageElement>('.image');
const captureButton = element<HTMLButtonElement>('.capture');
const submitButton = element<HTMLButtonElement>('.submit');
const alert = element<HTMLParagraphElement>('.error');
const retryContext = element<HTMLButtonElement>('.retry-context');
function openPanel(open: boolean) {
  panelOpen = open;
  element('.launcher').classList.toggle('hidden', open);
  element('.panel').classList.toggle('hidden', !open);
  if (open) {
    opener =
      shadow.activeElement instanceof HTMLElement
        ? shadow.activeElement
        : document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null;
    message.focus();
  } else {
    opener?.focus();
  }
}
element('.launcher').addEventListener('click', () => openPanel(true));
element('.close').addEventListener('click', () => openPanel(false));
element('.done').addEventListener('click', () => {
  form.reset();
  screenshot = undefined;
  image.removeAttribute('src');
  image.classList.add('hidden');
  element('.success').classList.add('hidden');
  form.classList.remove('hidden');
  openPanel(true);
});
shadow.addEventListener('keydown', (event) => {
  if (!(event instanceof KeyboardEvent)) return;
  if (event.key === 'Escape' && panelOpen) openPanel(false);
  if (event.key !== 'Tab' || !panelOpen) return;
  const focusable = Array.from(
    shadow.querySelectorAll<HTMLElement>(
      'button:not([disabled]), textarea:not([disabled]), input:not([disabled])',
    ),
  ).filter((node) => !node.closest('.hidden'));
  const first = focusable[0];
  const last = focusable.at(-1);
  if (!first || !last) return;
  if (event.shiftKey && shadow.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && shadow.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
});

async function captureScreenshot() {
  const generation = ++screenshotGeneration;
  captureButton.disabled = true;
  alert.textContent = '';
  try {
    const transparent = (value: string) => value === 'transparent' || value === 'rgba(0, 0, 0, 0)';
    const bodyColor = getComputedStyle(document.body).backgroundColor;
    const pageColor = transparent(bodyColor)
      ? getComputedStyle(document.documentElement).backgroundColor
      : bodyColor;
    const result = await toPng(document.body, {
      pixelRatio: 1,
      width: Math.min(window.innerWidth, 1440),
      height: Math.min(window.innerHeight, 1200),
      skipFonts: true,
      backgroundColor: transparent(pageColor) ? '#ffffff' : pageColor,
      style: { transform: `translate(${-window.scrollX}px, ${-window.scrollY}px)` },
      filter: (node) =>
        !(
          node instanceof Element &&
          (node === root || node.matches('input,textarea,select,[data-surflet-private]'))
        ),
    });
    if (result.length > MAX_SCREENSHOT_LENGTH)
      throw new Error('This screenshot is too large. Send browser context without the image.');
    if (generation !== screenshotGeneration || !includeScreenshot.checked) return;
    screenshot = result;
    image.src = result;
    image.classList.remove('hidden');
  } catch (error) {
    if (generation !== screenshotGeneration || !includeScreenshot.checked) return;
    screenshot = undefined;
    image.classList.add('hidden');
    alert.textContent =
      error instanceof Error
        ? `Screenshot unavailable: ${error.message}`
        : 'Screenshot unavailable. You can send feedback without it.';
  } finally {
    captureButton.disabled = false;
  }
}
includeScreenshot.addEventListener('change', () => {
  captureButton.classList.toggle('hidden', !includeScreenshot.checked);
  if (includeScreenshot.checked) void captureScreenshot();
  else {
    screenshotGeneration++;
    screenshot = undefined;
    image.removeAttribute('src');
    image.classList.add('hidden');
  }
});
captureButton.addEventListener('click', () => {
  void captureScreenshot();
});
async function loadContext() {
  retryContext.classList.add('hidden');
  alert.textContent = '';
  element('.context').textContent = 'Connecting to preview…';
  try {
    const response = await originalFetch('/__surflet/context', { credentials: 'same-origin' });
    if (!response.ok) throw new Error('Preview unavailable');
    const value = (await response.json()) as Context;
    if (!value.previewId || !value.revision || !value.name) throw new Error('Preview returned incomplete context');
    context = value;
    element('.context').textContent =
      `${context.name} · ${context.revision} · ${redactUrl(location.href)}`;
  } catch {
    context = undefined;
    element('.context').textContent = 'Preview connection unavailable.';
    alert.textContent = 'Preview connection unavailable. Retry, or return to the share page to report it.';
    retryContext.classList.remove('hidden');
  }
}
retryContext.addEventListener('click', () => void loadContext());
form.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (submitting) return;
  if (!context) {
    alert.textContent = 'Preview connection is unavailable. Reload the page and try again.';
    return;
  }
  if (includeScreenshot.checked && !screenshot) {
    alert.textContent = 'Capture and review the screenshot, or uncheck the screenshot option.';
    return;
  }
  submitting = true;
  submitButton.disabled = true;
  alert.textContent = '';
  try {
    const latestContext = await originalFetch('/__surflet/context', { credentials: 'same-origin' });
    if (!latestContext.ok) throw new Error('This preview is no longer accepting feedback.');
    const current = (await latestContext.json()) as Context;
    const payload: FeedbackInput = {
      message: message.value,
      reporter: element<HTMLInputElement>('#reporter').value,
      pageUrl: redactUrl(location.href),
      revision: context.revision,
      environment: {
        userAgent: navigator.userAgent.slice(0, 500),
        width: window.innerWidth,
        height: window.innerHeight,
      },
      consoleErrors: [...errors],
      networkErrors: [...network],
      steps: [...steps],
      ...(screenshot ? { screenshot } : {}),
    };
    const csrfName = `surflet_csrf_${current.previewId}=`;
    const csrf = document.cookie
      .split(';')
      .map((value) => value.trim())
      .find((value) => value.startsWith(csrfName))
      ?.slice(csrfName.length);
    if (!csrf)
      throw new Error('Your preview session has ended. Open the app again from the shared link.');
    const response = await originalFetch('/__surflet/feedback', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json', 'x-surflet-csrf': csrf },
      body: JSON.stringify(payload),
    });
    const body = await response.text();
    let result: { feedback?: Feedback; error?: string } = {};
    try {
      result = JSON.parse(body) as { feedback?: Feedback; error?: string };
    } catch {
      if (!response.ok)
        throw new Error(`Feedback could not be sent (${response.status}). Please try again.`);
    }
    if (!response.ok)
      throw new Error(result.error ?? 'Feedback could not be sent. Please try again.');
    form.classList.add('hidden');
    element('.success').classList.remove('hidden');
  } catch (error) {
    alert.textContent = error instanceof Error ? error.message : 'Feedback could not be sent.';
  } finally {
    submitting = false;
    submitButton.disabled = false;
  }
});
void loadContext();
