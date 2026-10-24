// UNTESTED in the authoring sandbox (needs playwright-core and a Chrome/Chromium binary). CI exercises it with the
// Google Chrome preinstalled on GitHub runners (src/pdf.itest.ts).
//
// Hardening: JavaScript is disabled and every network request is aborted, so the report HTML can neither run code nor
// fetch anything. Renders are serialized (one at a time) to protect the memory of a small server.
import { chromium } from 'playwright-core';
import type { Browser } from 'playwright-core';
import type { PdfRenderer } from './ports.ts';
import { esc } from '../../../packages/engines/src/report/html.ts';

export class PlaywrightPdfRenderer implements PdfRenderer {
  private browser: Browser | null = null;
  private chain: Promise<unknown> = Promise.resolve();
  private executablePath: string | undefined;
  private noSandbox: boolean;

  /** `noSandbox` is needed when Chromium runs as root inside a container (set PDF_NO_SANDBOX=1). */
  constructor(options: { executablePath?: string; noSandbox?: boolean } = {}) {
    this.executablePath = options.executablePath;
    this.noSandbox = options.noSandbox ?? false;
  }

  private async getBrowser(): Promise<Browser> {
    if (!this.browser || !this.browser.isConnected()) {
      this.browser = await chromium.launch({
        executablePath: this.executablePath,
        args: ['--disable-dev-shm-usage', ...(this.noSandbox ? ['--no-sandbox'] : [])],
      });
    }
    return this.browser;
  }

  render(html: string, o: { locale: 'ar' | 'en'; footerText: string }): Promise<Buffer> {
    const job = async (): Promise<Buffer> => {
      const browser = await this.getBrowser();
      const context = await browser.newContext({ javaScriptEnabled: false });
      try {
        await context.route('**/*', (route) => route.abort());
        const page = await context.newPage();
        page.setDefaultTimeout(30_000);
        await page.setContent(html, { waitUntil: 'load' });
        const footer = `<div style="width:100%;font-size:8px;color:#596273;padding:0 14mm;direction:ltr;display:flex;justify-content:space-between;font-family:sans-serif">
  <span>${esc(o.footerText)}</span><span><span class="pageNumber"></span> / <span class="totalPages"></span></span></div>`;
        return await page.pdf({
          format: 'A4', printBackground: true, displayHeaderFooter: true,
          headerTemplate: '<span></span>', footerTemplate: footer,
          margin: { top: '16mm', bottom: '18mm', left: '14mm', right: '14mm' },
        });
      } finally {
        await context.close();
      }
    };
    const result = this.chain.then(job, job);
    this.chain = result.catch(() => undefined);
    return result;
  }

  async close(): Promise<void> {
    await this.browser?.close();
    this.browser = null;
  }
}
