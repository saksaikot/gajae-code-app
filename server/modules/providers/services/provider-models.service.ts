import { createReadStream, type Stats } from 'node:fs';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';

import type { SessionEntry } from '@gajae-code/coding-agent/session/session-manager';


import { providerRegistry } from '@/modules/providers/provider.registry.js';
import type { IProvider } from '@/shared/interfaces.js';
import type {
  LLMProvider,
  ProviderChangeActiveModelInput,
  ProviderCurrentActiveModel,
  ProviderModelsCacheInfo,
  ProviderModelsDefinition,
  ProviderModelsResult,
  ProviderSessionActiveModelChange,
} from '@/shared/types.js';
import { readProviderSessionActiveModelChange, writeProviderSessionActiveModelChange } from '@/shared/utils.js';

import { PROFILE_PREFIX, withoutEffortSuffix } from '../../../../shared/model-selectors.js';

export const PROVIDER_MODELS_CACHE_TTL_MS = 3 * 24 * 60 * 60 * 1000;
const PROVIDER_MODELS_CACHE_VERSION = 12;

type ProviderModelsServiceDependencies = { resolveProvider?: (provider: LLMProvider) => Pick<IProvider, 'models'>; cachePath?: string; activeModelChangesPath?: string; now?: () => number; readConfiguredChains?: (sessionId: string) => Promise<SessionEntry[]> };
type ConfiguredChain = Extract<SessionEntry, { type: 'configured_model_chain' }>;
type RecordedChoice = Pick<ProviderSessionActiveModelChange, 'recordedModel' | 'isRecordedModelAvailable'>;
type ProviderModelsOptions = { bypassCache?: boolean };
type ProviderModelsCacheEntry = { updatedAt: number; expiresAt: number; models: ProviderModelsDefinition };
type ProviderModelsCacheFile = { version: number; entries: Record<string, ProviderModelsCacheEntry> };

const defaultCacheLocation = (): string => path.join(os.homedir(), '.gajae-app', 'provider-models-cache.json');

const hasModelOptionShape = (candidate: unknown): candidate is ProviderModelsDefinition['OPTIONS'][number] => {
  if (!candidate || typeof candidate !== 'object') return false;
  const option = candidate as ProviderModelsDefinition['OPTIONS'][number];
  return typeof option.value === 'string'
    && typeof option.label === 'string'
    && (option.description === undefined || typeof option.description === 'string')
    && (option.roles === undefined || Boolean(option.roles));
};

const hasModelsShape = (candidate: unknown): candidate is ProviderModelsDefinition => {
  if (!candidate || typeof candidate !== 'object') return false;
  const catalog = candidate as ProviderModelsDefinition;
  return typeof catalog.DEFAULT === 'string'
    && Array.isArray(catalog.OPTIONS)
    && catalog.OPTIONS.every(hasModelOptionShape)
    && (catalog.MODELS === undefined || (Array.isArray(catalog.MODELS) && catalog.MODELS.every(hasModelOptionShape)));
};

const hasCacheEntryShape = (candidate: unknown): candidate is ProviderModelsCacheEntry => {
  if (!candidate || typeof candidate !== 'object') return false;
  const entry = candidate as ProviderModelsCacheEntry;
  return typeof entry.updatedAt === 'number' && typeof entry.expiresAt === 'number' && hasModelsShape(entry.models);
};

const deserializeCache = async (fileName: string): Promise<Record<string, ProviderModelsCacheEntry>> => {
  try {
    const parsed = JSON.parse(await readFile(fileName, 'utf8')) as Partial<ProviderModelsCacheFile>;
    if (parsed.version !== PROVIDER_MODELS_CACHE_VERSION || !parsed.entries || typeof parsed.entries !== 'object') return {};
    return Object.fromEntries(Object.entries(parsed.entries).filter(([, item]) => hasCacheEntryShape(item)));
  } catch {
    return {};
  }
};

const cacheDetails = (entry: ProviderModelsCacheEntry, source: ProviderModelsCacheInfo['source']): ProviderModelsCacheInfo => ({
  updatedAt: new Date(entry.updatedAt).toISOString(),
  expiresAt: new Date(entry.expiresAt).toISOString(),
  source,
});

/** The last default chain a session file records, unless a later entry cleared it. */
function lastDefaultChain(entries: SessionEntry[]): ConfiguredChain | undefined {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry.type === 'configured_model_chain' && entry.role === 'default') return entry.cleared ? undefined : entry;
  }
  return undefined;
}

/** The selector a chain stands for: its profile, else its first model without the effort. */
function chainSelector(chain: ConfiguredChain): string | undefined {
  if (chain.origin === 'profile-activation') return chain.identity ? `${PROFILE_PREFIX}${chain.identity}` : undefined;
  return chain.entries[0] ? withoutEffortSuffix(chain.entries[0]) : undefined;
}

/** What a session started on, from its file's last default chain: `profile:<name>` or `<provider>/<model>`. */
export function recordedSessionModel(entries: SessionEntry[]): string | undefined {
  const chain = lastDefaultChain(entries);
  return chain && chainSelector(chain);
}

/** A recorded profile must still exist; a recorded model needs its provider signed in. */
function catalogOffersRecorded(catalog: ProviderModelsDefinition, recorded: string): boolean {
  if (catalog.OPTIONS.some(({ value }) => value === recorded)) return true;
  if (recorded.startsWith(PROFILE_PREFIX)) return false;
  const providerOf = (model: string): string => model.split('/')[0];
  return catalog.MODELS === undefined || catalog.MODELS.some(({ value }) => providerOf(value) === providerOf(recorded));
}

/** One file line as a chain entry; undefined for any other line, or a line a live writer has not finished. */
function parseChainLine(line: string): SessionEntry | undefined {
  if (!line.includes('"configured_model_chain"')) return undefined;
  try {
    return JSON.parse(line) as SessionEntry;
  } catch {
    return undefined;
  }
}

async function scanChains(file: string): Promise<SessionEntry[]> {
  const chains: SessionEntry[] = [];
  for await (const line of createInterface({ input: createReadStream(file, 'utf8'), crlfDelay: Infinity })) {
    const chain = parseChainLine(line);
    if (chain) chains.push(chain);
  }
  return chains;
}

/**
 * Remembers each file's scan under its size and mtime, so a turn on an
 * unchanged session file (11-100 MB once a session runs long) does not read it
 * again. The stat comes before the scan: a file that grows mid-scan is scanned
 * again on the next call.
 */
export function rememberChainsByFile(scan: (file: string) => Promise<SessionEntry[]>): (file: string) => Promise<SessionEntry[]> {
  const scans = new Map<string, { size: number; mtimeMs: number; chains: SessionEntry[] }>();
  return async (file) => {
    let info: Stats;
    try {
      info = await stat(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      scans.delete(file);
      return [];
    }
    const known = scans.get(file);
    if (known && known.size === info.size && known.mtimeMs === info.mtimeMs) return known.chains;
    const chains = await scan(file);
    scans.set(file, { size: info.size, mtimeMs: info.mtimeMs, chains });
    return chains;
  };
}

const readChainsOfFile = rememberChainsByFile(scanChains);

/** The session file's default chains only. */
async function readConfiguredChains(sessionId: string): Promise<SessionEntry[]> {
  const { sessionsDb } = await import('@/modules/database/index.js');
  const file = sessionsDb.getSessionById(sessionId)?.jsonl_path;
  return file ? readChainsOfFile(file) : [];
}

export const createProviderModelsService = (dependencies: ProviderModelsServiceDependencies = {}) => {
  const locateProvider = dependencies.resolveProvider ?? providerRegistry.resolveProvider;
  const fileName = dependencies.cachePath ?? defaultCacheLocation();
  const clock = dependencies.now ?? Date.now;
  const readChains = dependencies.readConfiguredChains ?? readConfiguredChains;
  const remembered = new Map<LLMProvider, ProviderModelsCacheEntry>();
  const fetching = new Map<LLMProvider, Promise<ProviderModelsResult>>();
  let diskRead: Promise<void> | undefined;
  let diskWasRead = false;

  const usable = (provider: LLMProvider, time: number, source: ProviderModelsCacheInfo['source']): ProviderModelsResult | undefined => {
    const entry = remembered.get(provider);
    if (!entry) return undefined;
    if (entry.expiresAt <= time) {
      remembered.delete(provider);
      return undefined;
    }
    return { models: entry.models, cache: cacheDetails(entry, source) };
  };

  const sourceHasChanged = async (provider: LLMProvider, entry: ProviderModelsResult): Promise<boolean> => {
    if (!Number.isFinite(Date.parse(entry.cache.updatedAt))) return false;
    try {
      const revision = await locateProvider(provider).models.getCatalogRevision?.();
      return typeof revision === 'number' && revision > Date.parse(entry.cache.updatedAt);
    } catch {
      return false;
    }
  };

  const writeCache = async (): Promise<void> => {
    try {
      const time = clock();
      const entries = Object.fromEntries([...remembered].filter(([, entry]) => entry.expiresAt > time));
      await mkdir(path.dirname(fileName), { recursive: true });
      await writeFile(fileName, `${JSON.stringify({ version: PROVIDER_MODELS_CACHE_VERSION, entries }, null, 2)}\n`, 'utf8');
    } catch (error) {
      console.warn('Unable to persist provider models cache:', error);
    }
  };

  const readCacheOnce = async (): Promise<void> => {
    if (diskWasRead) return;
    diskRead ??= (async () => {
      const time = clock();
      for (const [key, entry] of Object.entries(await deserializeCache(fileName))) {
        if (entry.expiresAt > time) remembered.set(key as LLMProvider, entry);
      }
      diskWasRead = true;
    })().finally(() => { diskRead = undefined; });
    await diskRead;
  };

  const retrieve = (provider: LLMProvider): Promise<ProviderModelsResult> => {
    const request = locateProvider(provider).models.getSupportedModels().then(async (models) => {
      const updatedAt = clock();
      const entry = { updatedAt, expiresAt: updatedAt + PROVIDER_MODELS_CACHE_TTL_MS, models };
      remembered.set(provider, entry);
      await writeCache();
      return { models, cache: cacheDetails(entry, 'fresh') };
    }).finally(() => { fetching.delete(provider); });
    fetching.set(provider, request);
    return request;
  };

  const getProviderModels = async (provider: LLMProvider, options: ProviderModelsOptions = {}): Promise<ProviderModelsResult> => {
    if (options.bypassCache) return fetching.get(provider) ?? retrieve(provider);

    const fromMemory = usable(provider, clock(), 'memory');
    if (fromMemory && !await sourceHasChanged(provider, fromMemory)) return fromMemory;
    const inFlight = fetching.get(provider);
    if (inFlight) return inFlight;

    await readCacheOnce();
    const fromDisk = usable(provider, clock(), 'disk');
    if (fromDisk && !await sourceHasChanged(provider, fromDisk)) return fromDisk;
    return fetching.get(provider) ?? retrieve(provider);
  };

  const recordedChoice = async (provider: LLMProvider, sessionId: string): Promise<RecordedChoice> => {
    const recordedModel = recordedSessionModel(await readChains(sessionId));
    if (!recordedModel) return {};
    const { models } = await getProviderModels(provider);
    return { recordedModel, isRecordedModelAvailable: catalogOffersRecorded(models, recordedModel) };
  };

  return {
    getProviderModels,
    getCurrentActiveModel: (provider: LLMProvider, sessionId?: string): Promise<ProviderCurrentActiveModel> => locateProvider(provider).models.getCurrentActiveModel(sessionId),
    async getChangedActiveModel(provider: LLMProvider, sessionId: string): Promise<ProviderSessionActiveModelChange> {
      const saved = await readProviderSessionActiveModelChange(provider, sessionId, { filePath: dependencies.activeModelChangesPath });
      if (!saved.supported || saved.changed) return saved;
      return { ...saved, ...await recordedChoice(provider, saved.sessionId) };
    },
    changeActiveModel: (provider: LLMProvider, input: ProviderChangeActiveModelInput): Promise<ProviderSessionActiveModelChange> => locateProvider(provider).models.changeActiveModel(input),
    /**
     * The model a turn runs on: the session's pin when it has one, else the
     * profile or model its file records while that is still available, else what
     * the request asked for. On a session's first turn an explicit request
     * becomes the pin, so the choice made before the first message survives
     * a reload and a later change of the global default; `default` pins
     * nothing and the session keeps following the app default.
     */
    async resolveResumeModel(provider: LLMProvider, sessionId: string | undefined, requestedModel?: string | null, options: { firstTurn?: boolean } = {}): Promise<string | undefined> {
      const requested = typeof requestedModel === 'string' ? requestedModel.trim() : '';
      if (!sessionId?.trim()) return requested || undefined;
      const saved = await readProviderSessionActiveModelChange(provider, sessionId, { filePath: dependencies.activeModelChangesPath });
      if (saved.supported && saved.changed && saved.model?.trim()) return saved.model.trim();
      const recorded = await recordedChoice(provider, sessionId);
      if (recorded.isRecordedModelAvailable) return recorded.recordedModel;
      if (options.firstTurn && requested && requested !== 'default') {
        await writeProviderSessionActiveModelChange(provider, { sessionId, model: requested }, { filePath: dependencies.activeModelChangesPath });
      }
      return requested || undefined;
    },
    clearCache(): void {
      remembered.clear();
      fetching.clear();
      diskRead = undefined;
      diskWasRead = false;
    },
  };
};

export const providerModelsService = createProviderModelsService();
