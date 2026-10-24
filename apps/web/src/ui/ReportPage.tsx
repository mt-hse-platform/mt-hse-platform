// The report on screen (the same HTML that becomes the PDF) inside a sandboxed frame, plus PDF download.
import { useState } from 'react';
import { authorizedFetch } from '../platform.ts';
import { useLocale, useT } from '../i18nReact.tsx';
import { ErrorNotice, LoadingBlock } from './common.tsx';
import { useLoad } from './hooks.ts';

export function ReportPage({ id, onBack }: { id: string; onBack: () => void }) {
  const t = useT();
  const uiLocale = useLocale();
  const [lang, setLang] = useState<'ar' | 'en'>(uiLocale);
  const [pdfError, setPdfError] = useState<unknown>(null);
  const [pdfBusy, setPdfBusy] = useState(false);
  const html = useLoad(async () => (await authorizedFetch(`/inspections/${id}/report?lang=${lang}`)).text(), [id, lang]);

  async function downloadPdf() {
    setPdfBusy(true);
    setPdfError(null);
    try {
      const res = await authorizedFetch(`/inspections/${id}/report.pdf?lang=${lang}`);
      const url = URL.createObjectURL(await res.blob());
      const a = document.createElement('a');
      a.href = url;
      a.download = `inspection-${id.slice(0, 8).toUpperCase()}.pdf`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (e) {
      setPdfError(e);
    } finally {
      setPdfBusy(false);
    }
  }

  return (
    <section className="stack">
      <div className="row-between">
        <button className="btn" onClick={onBack}>←</button>
        <h1 className="grow">{t('report.title')}</h1>
        <button className="btn btn-primary" disabled={pdfBusy || !html.data} onClick={() => void downloadPdf()}>{t('report.pdf')}</button>
      </div>
      <label className="field">
        <span>{t('report.language')}</span>
        <select value={lang} onChange={(e) => setLang(e.target.value as 'ar' | 'en')}>
          <option value="ar">العربية</option>
          <option value="en">English</option>
        </select>
      </label>
      {pdfError ? <ErrorNotice error={pdfError} /> : null}
      {html.error ? <ErrorNotice error={html.error} onRetry={html.reload} /> : null}
      {html.loading && !html.data && <LoadingBlock />}
      {/* sandbox="" : no scripts, no forms, no same-origin access. The report is plain, escaped HTML. */}
      {html.data && <iframe className="report-frame" title={t('report.title')} sandbox="" srcDoc={html.data} />}
    </section>
  );
}
