// Published templates kept on the device, so an inspection can be started without a connection.
// Content is kept PER VERSION: an inspection started offline stays on the version it was filled in with, even if the
// template is re-published before the app is online again.
import { ApiError, NetworkError } from './apiClient.ts';
import type { KeyValueStore } from './session.ts';
import type { LocalizedText, TemplateContent } from '../../../../packages/engines/src/template/types.ts';

export type PublishedTemplate = { id: string; name: LocalizedText; description: LocalizedText | null; publishedVersionId: string | null };
export interface TemplateApi {
  listPublished(): Promise<PublishedTemplate[]>;
  getVersionContent(templateId: string, versionId: string): Promise<TemplateContent>;
  /** optional: the sites the person may choose when starting (a site-scoped role needs one) */
  listSites?(): Promise<{ id: string; name: string }[]>;
}

export type CachedTemplate = { id: string; name: LocalizedText; description: LocalizedText | null; versionId: string };
export type RefreshResult = 'ok' | 'offline' | 'auth' | 'failed';

type Saved = {
  v: 1;
  templates: CachedTemplate[];
  versions: Record<string, { templateId: string; content: TemplateContent; cachedAt: string }>;
  sites?: { id: string; name: string }[];
};
const KEY = 'mthse.templates.v1';
const empty = (): Saved => ({ v: 1, templates: [], versions: {} });

export class TemplateCache {
  private o: { store: KeyValueStore; api: TemplateApi; now?: () => Date };
  private data: Saved = empty();
  private running: Promise<RefreshResult> | null = null;
  private listeners = new Set<() => void>();

  constructor(options: { store: KeyValueStore; api: TemplateApi; now?: () => Date }) { this.o = options; }

  async init(): Promise<void> {
    const raw = await this.o.store.get(KEY);
    if (raw) {
      try {
        const s = JSON.parse(raw) as Partial<Saved>;
        if (s && s.v === 1 && Array.isArray(s.templates) && s.versions && typeof s.versions === 'object') this.data = { v: 1, templates: s.templates, versions: s.versions, ...(Array.isArray(s.sites) ? { sites: s.sites } : {}) };
      } catch { /* unreadable: start empty, the next refresh refills it */ }
    }
    this.emit();
  }

  subscribe(fn: () => void): () => void { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; }
  /** Templates that can be started offline (their content is on the device). */
  list(): CachedTemplate[] { return this.data.templates.filter((t) => t.versionId in this.data.versions).map((t) => ({ ...t })); }
  get(templateId: string): CachedTemplate | null { return this.list().find((t) => t.id === templateId) ?? null; }
  /** Sites the person can choose offline (empty if never downloaded). */
  sites(): { id: string; name: string }[] { return (this.data.sites ?? []).map((x) => ({ ...x })); }
  /** null when that version is not on the device. */
  getContent(versionId: string): TemplateContent | null { return this.data.versions[versionId]?.content ?? null; }

  /**
   * Downloads what is new. `keep` = version ids still needed by unfinished starts (never thrown away).
   * On any failure the old copy stays exactly as it was.
   */
  refresh(keep: string[] = []): Promise<RefreshResult> {
    if (this.running) return this.running;
    this.running = this.doRefresh(keep).finally(() => { this.running = null; });
    return this.running;
  }

  /** Makes sure one version's content is on the device (used right before starting an inspection). */
  async ensure(templateId: string, versionId: string): Promise<boolean> {
    if (this.getContent(versionId)) return true;
    try {
      const content = await this.o.api.getVersionContent(templateId, versionId);
      this.data.versions[versionId] = { templateId, content, cachedAt: this.now() };
      await this.persist();
      return true;
    } catch { return false; }
  }

  async clear(): Promise<void> {
    this.data = empty();
    await this.o.store.remove(KEY);
    this.emit();
  }

  // ---------- internals ----------

  private now() { return (this.o.now?.() ?? new Date()).toISOString(); }
  private emit() { for (const l of [...this.listeners]) l(); }
  private async persist() { await this.o.store.set(KEY, JSON.stringify(this.data)); this.emit(); }

  private async doRefresh(keep: string[]): Promise<RefreshResult> {
    let listed: PublishedTemplate[];
    try { listed = await this.o.api.listPublished(); } catch (err) { return classify(err); }

    const versions = { ...this.data.versions };
    const templates: CachedTemplate[] = [];
    let partial = false;
    for (const t of listed) {
      if (!t.publishedVersionId) continue;
      let have = versions[t.publishedVersionId];
      if (!have) {
        try {
          const content = await this.o.api.getVersionContent(t.id, t.publishedVersionId);
          have = versions[t.publishedVersionId] = { templateId: t.id, content, cachedAt: this.now() };
        } catch (err) {
          const kind = classify(err);
          if (kind === 'auth') return 'auth';
          partial = true;
          const old = this.data.templates.find((x) => x.id === t.id);          // keep the older copy rather than lose the template
          if (old && versions[old.versionId]) templates.push({ ...old, name: t.name, description: t.description });
          continue;
        }
      }
      templates.push({ id: t.id, name: t.name, description: t.description, versionId: t.publishedVersionId });
    }
    const needed = new Set([...templates.map((t) => t.versionId), ...keep]);
    for (const id of Object.keys(versions)) if (!needed.has(id)) delete versions[id];
    let sites = this.data.sites;
    if (this.o.api.listSites) { try { sites = await this.o.api.listSites(); } catch { /* keep the old list */ } }
    this.data = { v: 1, templates, versions, ...(sites ? { sites } : {}) };
    await this.persist();
    return partial ? 'failed' : 'ok';
  }
}

function classify(err: unknown): RefreshResult {
  if (err instanceof NetworkError) return 'offline';
  if (err instanceof ApiError) {
    if (err.status === 401) return 'auth';
    if (err.status === 408 || err.status === 429 || err.status >= 500) return 'offline';
    return 'failed';
  }
  return 'offline';
}
