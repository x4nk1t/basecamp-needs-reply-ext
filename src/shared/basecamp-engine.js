/* global fetch */
(function attachBasecampNeedsReplyEngine(global) {
  "use strict";

  const DEFAULT_SETTINGS = Object.freeze({
    accountId: "",
    personId: "",
    daysBack: 7,
    maxReadPages: 3,
    origin: "https://app.basecamp.com"
  });

  function normalizeSettings(settings) {
    const merged = Object.assign({}, DEFAULT_SETTINGS, settings || {});
    merged.accountId = String(merged.accountId || DEFAULT_SETTINGS.accountId).trim();
    merged.personId = String(merged.personId || "").trim();
    merged.daysBack = clampNumber(merged.daysBack, 1, 30, DEFAULT_SETTINGS.daysBack);
    merged.maxReadPages = clampNumber(merged.maxReadPages, 1, 10, DEFAULT_SETTINGS.maxReadPages);
    merged.origin = normalizeOrigin(merged.origin || DEFAULT_SETTINGS.origin);
    return merged;
  }

  function clampNumber(value, min, max, fallback) {
    const number = Number(value);
    if (!Number.isFinite(number)) return fallback;
    return Math.min(max, Math.max(min, Math.round(number)));
  }

  function normalizeOrigin(origin) {
    if (origin === "https://3.basecamp.com") return origin;
    return "https://app.basecamp.com";
  }

  function getAccountIdFromUrl(url) {
    try {
      const parsed = new URL(url);
      const match = parsed.pathname.match(/^\/(\d+)(?:\/|$)/);
      return match ? match[1] : "";
    } catch (_error) {
      return "";
    }
  }

  function parseBasecampAppUrl(url) {
    try {
      const parsed = new URL(url);
      const parts = parsed.pathname.split("/").filter(Boolean);
      const accountId = parts[0] || "";
      const bucketIndex = parts.indexOf("buckets");
      const bucketId = bucketIndex >= 0 ? parts[bucketIndex + 1] : "";
      const commentMatch = parsed.hash.match(/__recording_(\d+)/);
      const numericParts = parts.filter((part) => /^\d+$/.test(part));
      const parentRecordingId = numericParts[numericParts.length - 1] || "";

      return {
        accountId,
        bucketId,
        parentRecordingId,
        focusCommentId: commentMatch ? commentMatch[1] : "",
        origin: parsed.origin,
        path: parsed.pathname,
        isCommentMention: Boolean(commentMatch && accountId && parentRecordingId)
      };
    } catch (_error) {
      return {
        accountId: "",
        bucketId: "",
        parentRecordingId: "",
        focusCommentId: "",
        origin: "",
        path: "",
        isCommentMention: false
      };
    }
  }

  function cutoffDate(daysBack) {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - daysBack);
    return cutoff;
  }

  function isRecent(dateString, cutoff) {
    const date = new Date(dateString);
    return Number.isFinite(date.getTime()) && date >= cutoff;
  }

  function compareRecordingTime(aDate, aId, bDate, bId) {
    const aTime = new Date(aDate).getTime();
    const bTime = new Date(bDate).getTime();
    if (Number.isFinite(aTime) && Number.isFinite(bTime) && aTime !== bTime) {
      return aTime - bTime;
    }
    return Number(aId || 0) - Number(bId || 0);
  }

  function isAfterComment(comment, focusComment) {
    return compareRecordingTime(
      comment && comment.created_at,
      comment && comment.id,
      focusComment && focusComment.created_at,
      focusComment && focusComment.id
    ) > 0;
  }

  function uniqById(items) {
    const seen = new Set();
    const result = [];
    for (const item of items) {
      if (!item || seen.has(item.id)) continue;
      seen.add(item.id);
      result.push(item);
    }
    return result;
  }

  function htmlToText(input) {
    if (!input) return "";
    return String(input)
      .replace(/<br\s*\/?\s*>/gi, "\n")
      .replace(/<\/p>/gi, "\n")
      .replace(/<\/div>/gi, "\n")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/gi, " ")
      .replace(/&amp;/gi, "&")
      .replace(/&lt;/gi, "<")
      .replace(/&gt;/gi, ">")
      .replace(/&quot;/gi, '"')
      .replace(/&#39;/gi, "'")
      .replace(/\s+/g, " ")
      .trim();
  }

  function truncate(text, maxLength) {
    const clean = String(text || "").trim();
    if (clean.length <= maxLength) return clean;
    return `${clean.slice(0, maxLength - 1).trim()}…`;
  }

  function cleanTitle(notificationTitle, parentTitle) {
    if (parentTitle) return parentTitle;
    return String(notificationTitle || "")
      .replace(/^@mentioned you in:\s*/i, "")
      .replace(/^Re:\s*/i, "")
      .trim();
  }

  function makeUrl(origin, accountId, path) {
    const normalizedPath = path.startsWith("/") ? path : `/${path}`;
    return `${normalizeOrigin(origin)}/${accountId}${normalizedPath}`;
  }

  async function fetchJson(url, fetchImpl) {
    const response = await fetchImpl(url, {
      credentials: "include",
      headers: { Accept: "application/json" }
    });

    if (!response.ok) {
      const error = new Error(`Basecamp request failed (${response.status})`);
      error.status = response.status;
      error.url = url;
      throw error;
    }

    return response.json();
  }

  async function fetchReadings({ accountId, origin, maxReadPages, fetchImpl }) {
    const groups = { unreads: [], reads: [] };

    for (let page = 1; page <= maxReadPages; page += 1) {
      const url = makeUrl(origin, accountId, `/my/readings.json?page=${page}`);
      const data = await fetchJson(url, fetchImpl);
      if (page === 1) groups.unreads = Array.isArray(data.unreads) ? data.unreads : [];
      const reads = Array.isArray(data.reads) ? data.reads : [];
      groups.reads.push(...reads);
      if (reads.length === 0) break;
    }

    groups.reads = uniqById(groups.reads);
    return groups;
  }

  async function fetchCurrentUser({ accountId, origin, personIdFallback, fetchImpl }) {
    try {
      const profile = await fetchJson(makeUrl(origin, accountId, "/my/profile.json"), fetchImpl);
      return {
        id: String(profile.id || personIdFallback || ""),
        name: profile.name || "You",
        email: profile.email_address || "",
        avatarUrl: profile.avatar_url || ""
      };
    } catch (error) {
      if (personIdFallback) {
        return {
          id: String(personIdFallback),
          name: "Logged-in user",
          email: "",
          avatarUrl: "",
          detectionError: error && error.message ? error.message : String(error)
        };
      }
      throw error;
    }
  }

  async function getNeedsReplyItems(settings, options) {
    const normalized = normalizeSettings(settings);
    const fetchImpl = (options && options.fetchImpl) || global.fetch.bind(global);
    const cutoff = cutoffDate(normalized.daysBack);
    const currentUser = await fetchCurrentUser({
      accountId: normalized.accountId,
      origin: normalized.origin,
      personIdFallback: normalized.personId,
      fetchImpl
    });
    const currentPersonId = String(currentUser.id || "");

    if (!currentPersonId) {
      throw new Error("Could not detect the logged-in Basecamp user. Please log into Basecamp or set a fallback person ID in the extension options.");
    }

    const readings = await fetchReadings({
      accountId: normalized.accountId,
      origin: normalized.origin,
      maxReadPages: normalized.maxReadPages,
      fetchImpl
    });

    const notifications = uniqById([...(readings.unreads || []), ...(readings.reads || [])]);
    const candidates = notifications
      .filter((notification) => notification && notification.type === "Mention")
      .filter((notification) => String(notification.creator && notification.creator.id) !== currentPersonId)
      .filter((notification) => isRecent(notification.created_at, cutoff))
      .map((notification) => ({ notification, parsed: parseBasecampAppUrl(notification.app_url) }))
      .filter(({ parsed }) => parsed.isCommentMention);

    const unresolved = [];
    const errors = [];

    for (const candidate of candidates) {
      try {
        const item = await inspectMention(candidate, { ...normalized, personId: currentPersonId, currentUser }, fetchImpl);
        if (item) unresolved.push(item);
      } catch (error) {
        errors.push({
          notificationId: candidate.notification && candidate.notification.id,
          url: error && error.url,
          status: error && error.status,
          message: error && error.message ? error.message : String(error)
        });
      }
    }

    const deduped = dedupeByParentRecording(unresolved);
    deduped.sort((a, b) => compareRecordingTime(b.mentionedAt, b.mentionCommentId, a.mentionedAt, a.mentionCommentId));

    return {
      ok: true,
      items: deduped,
      meta: {
        checkedAt: new Date().toISOString(),
        accountId: normalized.accountId,
        personId: currentPersonId,
        currentUser,
        daysBack: normalized.daysBack,
        notificationsChecked: notifications.length,
        mentionCandidates: candidates.length,
        errors
      }
    };
  }

  async function inspectMention(candidate, settings, fetchImpl) {
    const { notification, parsed } = candidate;
    const accountId = parsed.accountId || settings.accountId;
    const origin = settings.origin;
    const focusCommentId = parsed.focusCommentId;

    const focusComment = await fetchJson(makeUrl(origin, accountId, `/comments/${focusCommentId}.json`), fetchImpl);
    const parentRecordingId = String(
      (focusComment.parent && focusComment.parent.id) || parsed.parentRecordingId || ""
    );
    if (!parentRecordingId) return null;

    const threadComments = await fetchJson(
      makeUrl(origin, accountId, `/recordings/${parentRecordingId}/comments.json`),
      fetchImpl
    );

    const focus = {
      id: focusComment.id || focusCommentId,
      created_at: focusComment.created_at || notification.created_at
    };

    const laterReply = Array.isArray(threadComments) && threadComments.some((comment) => {
      return String(comment && comment.creator && comment.creator.id) === settings.personId && isAfterComment(comment, focus);
    });

    if (laterReply) return null;

    const latestThreadComment = Array.isArray(threadComments)
      ? threadComments.reduce((latest, comment) => {
        if (!latest) return comment;
        return compareRecordingTime(comment.created_at, comment.id, latest.created_at, latest.id) > 0 ? comment : latest;
      }, null)
      : null;

    const sender = focusComment.creator || notification.creator || {};
    const project = focusComment.bucket || {};
    const parent = focusComment.parent || {};
    const excerpt = truncate(htmlToText(focusComment.content || notification.content_excerpt || ""), 240);

    return {
      id: `${parentRecordingId}:${focus.id}`,
      accountId,
      projectId: String(project.id || parsed.bucketId || ""),
      projectName: project.name || notification.bucket_name || "Basecamp project",
      threadId: parentRecordingId,
      threadType: parent.type || "Recording",
      threadTitle: cleanTitle(notification.title, parent.title),
      mentionCommentId: String(focus.id),
      latestThreadCommentId: String((latestThreadComment && latestThreadComment.id) || focus.id),
      latestThreadCommentAt: (latestThreadComment && latestThreadComment.created_at) || focus.created_at,
      mentionUrl: notification.app_url,
      parentUrl: parent.app_url || notification.app_url.split("#")[0],
      sender: {
        id: String(sender.id || ""),
        name: sender.name || "Someone",
        avatarUrl: sender.avatar_url || sender.avatarUrl || ""
      },
      mentionedAt: focus.created_at,
      excerpt,
      sourceType: "comment_mention"
    };
  }

  function dedupeByParentRecording(items) {
    const byThread = new Map();
    for (const item of items) {
      const key = item.threadId || item.id;
      const existing = byThread.get(key);
      if (!existing || compareRecordingTime(item.mentionedAt, item.mentionCommentId, existing.mentionedAt, existing.mentionCommentId) > 0) {
        byThread.set(key, item);
      }
    }
    return Array.from(byThread.values());
  }

  function makeIgnoreRecord(item, action) {
    return {
      action: action || "ignore",
      threadId: item.threadId,
      threadTitle: item.threadTitle,
      mentionCommentId: item.mentionCommentId,
      mentionedAt: item.mentionedAt,
      latestThreadCommentId: item.latestThreadCommentId || item.mentionCommentId,
      latestThreadCommentAt: item.latestThreadCommentAt || item.mentionedAt,
      ignoredAt: new Date().toISOString()
    };
  }

  function shouldSuppressItem(item, ignoredRecord) {
    if (!item || !ignoredRecord) return false;

    const itemLatestAt = item.latestThreadCommentAt || item.mentionedAt;
    const itemLatestId = item.latestThreadCommentId || item.mentionCommentId;
    const ignoredLatestAt = ignoredRecord.latestThreadCommentAt || ignoredRecord.mentionedAt || ignoredRecord.ignoredAt;
    const ignoredLatestId = ignoredRecord.latestThreadCommentId || ignoredRecord.mentionCommentId;

    return compareRecordingTime(itemLatestAt, itemLatestId, ignoredLatestAt, ignoredLatestId) <= 0;
  }

  function filterIgnoredItems(items, ignoredRecords) {
    const ignored = ignoredRecords || {};
    const visible = [];
    const staleIgnoreKeys = [];

    for (const item of items || []) {
      const key = item.threadId || item.id;
      const ignoredRecord = ignored[key];
      if (!ignoredRecord) {
        visible.push(item);
        continue;
      }

      if (shouldSuppressItem(item, ignoredRecord)) {
        continue;
      }

      staleIgnoreKeys.push(key);
      visible.push(item);
    }

    return { visible, staleIgnoreKeys };
  }

  global.BasecampNeedsReplyEngine = {
    DEFAULT_SETTINGS,
    normalizeSettings,
    getAccountIdFromUrl,
    parseBasecampAppUrl,
    getNeedsReplyItems,
    htmlToText,
    truncate,
    makeIgnoreRecord,
    shouldSuppressItem,
    filterIgnoredItems
  };
})(globalThis);
