importScripts("/src/shared/basecamp-engine.js");

const STORAGE_KEY = "basecampNeedsReplySettings";
const CACHE_KEY = "basecampNeedsReplyLastResult";
const IGNORED_KEY = "basecampNeedsReplyIgnored";
const CACHE_SCHEMA_VERSION = 4;
const CACHE_MAX_AGE_MS = 3 * 60 * 60 * 1000;

chrome.runtime.onInstalled.addListener(async () => {
  const settings = await getSettings();
  await saveSettings(settings);
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || !message.type) return false;

  if (message.type === "BNR_GET_SETTINGS") {
    getSettings(message.accountId, message.origin)
      .then((settings) => sendResponse({ ok: true, settings }))
      .catch((error) => sendResponse(errorResponse(error)));
    return true;
  }

  if (message.type === "BNR_SAVE_SETTINGS") {
    saveSettings(message.settings)
      .then((settings) => sendResponse({ ok: true, settings }))
      .catch((error) => sendResponse(errorResponse(error)));
    return true;
  }

  if (message.type === "BNR_REFRESH") {
    refreshNeedsReply(message, sender)
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse(errorResponse(error)));
    return true;
  }

  if (message.type === "BNR_GET_OR_REFRESH") {
    getOrRefreshNeedsReply(message, sender)
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse(errorResponse(error)));
    return true;
  }

  if (message.type === "BNR_GET_CACHE") {
    Promise.all([getCachedResult(), getIgnoredRecords()])
      .then(([result, ignoredRecords]) => sendResponse({
        ok: true,
        result: result ? buildDisplayResult(result, ignoredRecords, Boolean(message.showAll), true) : null
      }))
      .catch((error) => sendResponse(errorResponse(error)));
    return true;
  }

  if (message.type === "BNR_IGNORE_ITEM") {
    ignoreItem(message)
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse(errorResponse(error)));
    return true;
  }

  if (message.type === "BNR_UNIGNORE_ITEM") {
    unignoreItem(message)
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse(errorResponse(error)));
    return true;
  }

  return false;
});

async function getOrRefreshNeedsReply(message, sender) {
  const cached = await getCachedResult();
  if (cached && !isCacheExpired(cached)) {
    const ignoredRecords = await getIgnoredRecords();
    return buildDisplayResult(cached, ignoredRecords, Boolean(message.showAll), true);
  }
  return refreshNeedsReply(message, sender);
}

async function refreshNeedsReply(message, sender) {
  const accountId = message.accountId || BasecampNeedsReplyEngine.getAccountIdFromUrl(sender && sender.tab && sender.tab.url);
  const settings = await getSettings(accountId, message.origin);
  const rawResult = await BasecampNeedsReplyEngine.getNeedsReplyItems(settings);
  const ignoredRecords = await getIgnoredRecords();
  const filtered = BasecampNeedsReplyEngine.filterIgnoredItems(rawResult.items, ignoredRecords);

  for (const key of filtered.staleIgnoreKeys) delete ignoredRecords[key];

  const cacheResult = {
    ...rawResult,
    rawItems: rawResult.items,
    items: filtered.visible,
    meta: {
      ...rawResult.meta,
      cacheSchemaVersion: CACHE_SCHEMA_VERSION,
      ignoredCount: Object.keys(ignoredRecords).length,
      staleIgnoreKeys: filtered.staleIgnoreKeys
    }
  };

  await chrome.storage.local.set({ [CACHE_KEY]: cacheResult, [IGNORED_KEY]: ignoredRecords });
  return buildDisplayResult(cacheResult, ignoredRecords, Boolean(message.showAll), false);
}

async function ignoreItem(message) {
  if (!message.item || !message.item.threadId) {
    throw new Error("Cannot ignore item without a thread ID.");
  }

  const ignoredRecords = await getIgnoredRecords();
  const record = BasecampNeedsReplyEngine.makeIgnoreRecord(message.item);
  ignoredRecords[record.threadId] = record;

  const cached = await getCachedResult();
  const updatedCache = cached
    ? {
      ...cached,
      rawItems: cached.rawItems || cached.items || [],
      items: BasecampNeedsReplyEngine.filterIgnoredItems(cached.rawItems || cached.items || [], ignoredRecords).visible,
      meta: {
        ...(cached.meta || {}),
        ignoredCount: Object.keys(ignoredRecords).length,
        lastLocalActionAt: new Date().toISOString()
      }
    }
    : null;

  await chrome.storage.local.set({ [IGNORED_KEY]: ignoredRecords, [CACHE_KEY]: updatedCache });
  return {
    ok: true,
    result: updatedCache ? buildDisplayResult(updatedCache, ignoredRecords, Boolean(message.showAll), true) : null,
    ignored: record
  };
}

async function unignoreItem(message) {
  const threadId = String((message.item && message.item.threadId) || message.threadId || "");
  if (!threadId) {
    throw new Error("Cannot unignore item without a thread ID.");
  }

  const ignoredRecords = await getIgnoredRecords();
  delete ignoredRecords[threadId];

  const cached = await getCachedResult();
  const updatedCache = cached
    ? {
      ...cached,
      rawItems: cached.rawItems || cached.items || [],
      items: BasecampNeedsReplyEngine.filterIgnoredItems(cached.rawItems || cached.items || [], ignoredRecords).visible,
      meta: {
        ...(cached.meta || {}),
        ignoredCount: Object.keys(ignoredRecords).length,
        lastLocalActionAt: new Date().toISOString()
      }
    }
    : null;

  await chrome.storage.local.set({ [IGNORED_KEY]: ignoredRecords, [CACHE_KEY]: updatedCache });
  return {
    ok: true,
    result: updatedCache ? buildDisplayResult(updatedCache, ignoredRecords, Boolean(message.showAll), true) : null,
    unignoredThreadId: threadId
  };
}

async function getCachedResult() {
  const data = await chrome.storage.local.get(CACHE_KEY);
  return data[CACHE_KEY] || null;
}

function buildDisplayResult(result, ignoredRecords, showAll, fromCache) {
  const rawItems = result.rawItems || result.items || [];
  const filtered = BasecampNeedsReplyEngine.filterIgnoredItems(rawItems, ignoredRecords);
  const displayItems = showAll ? rawItems : filtered.visible;

  return {
    ...result,
    ok: true,
    fromCache,
    showAll,
    rawItems,
    items: displayItems.map((item) => decorateItem(item, ignoredRecords)),
    meta: {
      ...(result.meta || {}),
      ignoredCount: Object.keys(ignoredRecords || {}).length,
      totalNeedsReplyCount: rawItems.length,
      visibleNeedsReplyCount: filtered.visible.length
    }
  };
}

function decorateItem(item, ignoredRecords) {
  const ignored = ignoredRecords && ignoredRecords[item.threadId];
  if (!ignored) return { ...item, hiddenState: null };
  return {
    ...item,
    hiddenState: {
      action: "ignore",
      ignoredAt: ignored.ignoredAt
    }
  };
}

async function getIgnoredRecords() {
  const data = await chrome.storage.local.get(IGNORED_KEY);
  return data[IGNORED_KEY] || {};
}

function isCacheExpired(result) {
  if (!result || !result.meta || result.meta.cacheSchemaVersion !== CACHE_SCHEMA_VERSION) return true;
  const checkedAt = result && result.meta && result.meta.checkedAt;
  const time = checkedAt ? new Date(checkedAt).getTime() : 0;
  if (!Number.isFinite(time) || !time) return true;
  return Date.now() - time > CACHE_MAX_AGE_MS;
}

async function getSettings(accountIdFromPage, originFromPage) {
  const data = await chrome.storage.local.get(STORAGE_KEY);
  const stored = data[STORAGE_KEY] || {};
  return BasecampNeedsReplyEngine.normalizeSettings({
    ...stored,
    accountId: stored.accountId || accountIdFromPage,
    origin: originFromPage || stored.origin
  });
}

async function saveSettings(settings) {
  const normalized = BasecampNeedsReplyEngine.normalizeSettings(settings);
  await chrome.storage.local.set({ [STORAGE_KEY]: normalized });
  return normalized;
}

function errorResponse(error) {
  return {
    ok: false,
    error: {
      message: error && error.message ? error.message : String(error),
      status: error && error.status,
      url: error && error.url
    }
  };
}
