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

  const COMMENT_PAGE_SIZE = 15;
  const MAX_COMMENT_PAGES = 20;

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

      const isSupportedRecordingPath = isSupportedBodyMentionPath(parsed.pathname);
      const isSupportedAssignmentPath = isSupportedAssignmentRecordingPath(parsed.pathname);

      return {
        accountId,
        bucketId,
        parentRecordingId,
        focusCommentId: commentMatch ? commentMatch[1] : "",
        origin: parsed.origin,
        path: parsed.pathname,
        isCommentMention: Boolean(commentMatch && accountId && parentRecordingId),
        isRecordingMention: Boolean(!commentMatch && accountId && parentRecordingId && isSupportedRecordingPath),
        isAssignmentRecording: Boolean(accountId && parentRecordingId && isSupportedAssignmentPath)
      };
    } catch (_error) {
      return {
        accountId: "",
        bucketId: "",
        parentRecordingId: "",
        focusCommentId: "",
        origin: "",
        path: "",
        isCommentMention: false,
        isRecordingMention: false,
        isAssignmentRecording: false
      };
    }
  }

  function isSupportedBodyMentionPath(pathname) {
    return /\/(card_tables\/cards|todos|messages|documents)\/\d+/.test(pathname || "");
  }

  function isSupportedAssignmentRecordingPath(pathname) {
    return /\/(card_tables\/cards|todos)\/\d+/.test(pathname || "");
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

  async function fetchAssignments({ accountId, origin, fetchImpl }) {
    const data = await fetchJson(makeUrl(origin, accountId, "/my/assignments.json"), fetchImpl);
    return flattenAssignments(data);
  }

  async function fetchRecordingComments({ accountId, origin, recordingId, fetchImpl }) {
    const allComments = [];

    for (let page = 1; page <= MAX_COMMENT_PAGES; page += 1) {
      const data = await fetchJson(
        makeUrl(origin, accountId, `/recordings/${recordingId}/comments.json?page=${page}`),
        fetchImpl
      );
      const comments = normalizeThreadComments(data);
      allComments.push(...comments);

      if (comments.length === 0 || comments.length < COMMENT_PAGE_SIZE) break;
    }

    return uniqById(allComments);
  }

  function flattenAssignments(data) {
    const result = [];
    const visit = (assignment) => {
      if (!assignment || !assignment.id) return;
      result.push(assignment);
      const children = Array.isArray(assignment.children) ? assignment.children : [];
      for (const child of children) visit(child);
    };

    const groups = Array.isArray(data)
      ? [data]
      : [data && data.priorities, data && data.non_priorities];

    for (const group of groups) {
      if (!Array.isArray(group)) continue;
      for (const assignment of group) visit(assignment);
    }

    return uniqById(result);
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

  function isMentionNotification(notification) {
    if (!notification) return false;
    if (notification.type === "Mention") return true;
    if (notification.section === "mentions") return true;
    return false;
  }

  function isActiveAssignmentForCurrentUser(assignment, personId) {
    if (!assignment || assignment.completed) return false;
    if (!Array.isArray(assignment.assignees)) return true;
    return assignment.assignees.some((assignee) => getPersonId(assignee) === String(personId));
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
    const mentionCandidates = notifications
      .filter((notification) => isMentionNotification(notification))
      .filter((notification) => getRecordCreatorId(notification) !== currentPersonId)
      .filter((notification) => isRecent(notification.created_at, cutoff))
      .map((notification) => ({ notification, parsed: parseBasecampAppUrl(notification.app_url) }))
      .filter(({ parsed }) => parsed.isCommentMention || parsed.isRecordingMention);

    const errors = [];
    let assignmentCandidates = [];
    try {
      const assignments = await fetchAssignments({
        accountId: normalized.accountId,
        origin: normalized.origin,
        fetchImpl
      });
      assignmentCandidates = assignments
        .filter((assignment) => isActiveAssignmentForCurrentUser(assignment, currentPersonId))
        .map((assignment) => ({ assignment, parsed: parseBasecampAppUrl(assignment.app_url) }))
        .filter(({ parsed }) => parsed.isAssignmentRecording);
    } catch (error) {
      errors.push({
        source: "assignments",
        url: error && error.url,
        status: error && error.status,
        message: error && error.message ? error.message : String(error)
      });
    }

    const unresolved = [];

    for (const candidate of mentionCandidates) {
      try {
        const item = await inspectMention(candidate, { ...normalized, personId: currentPersonId, currentUser }, fetchImpl);
        if (item) unresolved.push(item);
      } catch (error) {
        errors.push({
          source: "mention",
          notificationId: candidate.notification && candidate.notification.id,
          url: error && error.url,
          status: error && error.status,
          message: error && error.message ? error.message : String(error)
        });
      }
    }

    for (const candidate of assignmentCandidates) {
      try {
        const item = await inspectAssignment(candidate, { ...normalized, personId: currentPersonId, currentUser, cutoff }, fetchImpl);
        if (item) unresolved.push(item);
      } catch (error) {
        errors.push({
          source: "assignment",
          assignmentId: candidate.assignment && candidate.assignment.id,
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
        mentionCandidates: mentionCandidates.length,
        assignmentCandidates: assignmentCandidates.length,
        errors
      }
    };
  }

  async function inspectMention(candidate, settings, fetchImpl) {
    if (candidate.parsed.isCommentMention) {
      return inspectCommentMention(candidate, settings, fetchImpl);
    }
    return inspectRecordingMention(candidate, settings, fetchImpl);
  }

  async function inspectCommentMention(candidate, settings, fetchImpl) {
    const { notification, parsed } = candidate;
    const accountId = parsed.accountId || settings.accountId;
    const origin = settings.origin;
    const focusCommentId = parsed.focusCommentId;

    const focusComment = await fetchJson(makeUrl(origin, accountId, `/comments/${focusCommentId}.json`), fetchImpl);
    const parentRecordingId = String(
      (focusComment.parent && focusComment.parent.id) || parsed.parentRecordingId || ""
    );
    if (!parentRecordingId) return null;

    const threadComments = await fetchRecordingComments({
      accountId,
      origin,
      recordingId: parentRecordingId,
      fetchImpl
    });

    const focus = {
      id: focusComment.id || focusCommentId,
      created_at: focusComment.created_at || notification.created_at
    };

    const latestActivity = latestThreadActivity(threadComments, focus);

    // Only show the thread if this mention is still the latest discussion
    // activity. If anyone has commented after it (including the current user),
    // a newer mention notification should be the thing that brings it back.
    if (isLaterDifferentActivity(latestActivity, focus)) return null;
    if (hasLaterCurrentUserReply(threadComments, focus, settings.personId)) return null;

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
      latestThreadCommentId: String(latestActivity.id || focus.id),
      latestThreadCommentAt: latestActivity.created_at || focus.created_at,
      mentionUrl: notification.app_url,
      parentUrl: parent.app_url || notification.app_url.split("#")[0],
      sender: normalizeSender(sender),
      mentionedAt: focus.created_at,
      excerpt,
      sourceType: "comment_mention"
    };
  }

  async function inspectRecordingMention(candidate, settings, fetchImpl) {
    const { notification, parsed } = candidate;
    const accountId = parsed.accountId || settings.accountId;
    const origin = settings.origin;
    const parentRecordingId = String(parsed.parentRecordingId || "");
    if (!parentRecordingId) return null;

    const recording = await fetchJson(makeRecordingUrl(origin, parsed), fetchImpl);
    const threadComments = await fetchRecordingComments({
      accountId,
      origin,
      recordingId: parentRecordingId,
      fetchImpl
    });

    const focus = {
      id: notification.id || recording.id || parentRecordingId,
      created_at: notification.created_at || recording.created_at || recording.updated_at
    };

    const latestActivity = latestThreadActivity(threadComments, {
      id: recording.id || focus.id,
      created_at: recording.updated_at || recording.created_at || focus.created_at
    });

    // Body/description mentions are only actionable until the thread receives
    // a newer comment. If that newer comment pings the current user, the comment
    // mention path will surface it instead.
    if (isLaterDifferentActivity(latestActivity, focus)) return null;
    if (hasLaterCurrentUserReply(threadComments, focus, settings.personId)) return null;

    const sender = notification.creator || recording.creator || {};
    const project = recording.bucket || {};
    const excerptSource = recording.content || recording.description || recording.body || notification.content_excerpt || "";

    return {
      id: `${parentRecordingId}:${focus.id}`,
      accountId,
      projectId: String(project.id || parsed.bucketId || ""),
      projectName: project.name || notification.bucket_name || "Basecamp project",
      threadId: parentRecordingId,
      threadType: recording.type || "Recording",
      threadTitle: cleanTitle(notification.title, recording.title || recording.content),
      mentionCommentId: String(focus.id),
      latestThreadCommentId: String(latestActivity.id || focus.id),
      latestThreadCommentAt: latestActivity.created_at || focus.created_at,
      mentionUrl: notification.app_url,
      parentUrl: recording.app_url || notification.app_url.split("#")[0],
      sender: normalizeSender(sender),
      mentionedAt: focus.created_at,
      excerpt: truncate(htmlToText(excerptSource), 240),
      sourceType: "recording_mention"
    };
  }

  async function inspectAssignment(candidate, settings, fetchImpl) {
    const { assignment, parsed } = candidate;
    const accountId = parsed.accountId || settings.accountId;
    const origin = settings.origin;
    const assignmentRecordingId = getAssignmentRecordingId(assignment, parsed);
    if (!assignmentRecordingId) return null;

    const recording = await fetchJson(makeRecordingUrl(origin, parsed), fetchImpl);

    // If Basecamp already says this assignment has comments, do not surface it
    // as a generic assignment reminder. Comment/mention-specific logic owns
    // those threads.
    if (getCommentCount(recording) > 0) return null;

    const threadComments = await fetchRecordingComments({
      accountId,
      origin,
      recordingId: assignmentRecordingId,
      fetchImpl
    });

    const assignmentFocus = resolveAssignmentFocus(assignment, recording);
    const focus = {
      id: assignmentFocus.id,
      created_at: assignmentFocus.created_at
    };

    if (!isRecent(focus.created_at, settings.cutoff)) return null;

    // Assignment items are only for tasks/cards with no discussion yet. Once a
    // thread has comments, mention/body-mention handling should decide whether
    // it needs a reply instead of showing a generic assignment reminder.
    if (normalizeThreadComments(threadComments).length > 0) return null;
    if (hasLaterCurrentUserReply(threadComments, focus, settings.personId)) return null;

    const latestActivity = latestThreadActivity(threadComments, {
      id: recording.id || focus.id,
      created_at: recording.updated_at || recording.created_at || focus.created_at
    });
    const project = assignment.bucket || recording.bucket || {};
    const sender = assignment.creator || recording.creator || {};
    const title = assignment.title || assignment.content || recording.title || recording.content;
    const excerptSource = recording.description || recording.content || assignment.content || "";

    return {
      id: `${assignmentRecordingId}:assignment:${focus.id}`,
      accountId,
      projectId: String(project.id || parsed.bucketId || ""),
      projectName: project.name || "Basecamp project",
      threadId: assignmentRecordingId,
      threadType: recording.type || assignment.type || "Assignment",
      threadTitle: cleanTitle("", title),
      mentionCommentId: String(focus.id),
      latestThreadCommentId: String(latestActivity.id || focus.id),
      latestThreadCommentAt: latestActivity.created_at || focus.created_at,
      mentionUrl: assignment.app_url || recording.app_url,
      parentUrl: recording.app_url || (assignment.app_url || "").split("#")[0],
      sender: normalizeSender(sender),
      mentionedAt: focus.created_at,
      excerpt: truncate(htmlToText(excerptSource), 240),
      sourceType: "assignment"
    };
  }

  function getAssignmentRecordingId(assignment, parsed) {
    const assignmentId = String(assignment && assignment.id || "");
    const hashRecordingId = String(parsed && parsed.focusCommentId || "");
    const urlRecordingId = String(parsed && parsed.parentRecordingId || "");

    // Card-table steps are returned as child assignments with an app URL that
    // points to the parent card plus #__recording_<step_id>. The comments that
    // determine whether the user replied live on the assigned step recording,
    // not necessarily on the parent card.
    return assignmentId || hashRecordingId || urlRecordingId;
  }

  function resolveAssignmentFocus(assignment, recording) {
    const sourceAssignment = assignment || {};
    const sourceRecording = recording || {};
    const assignmentId = String(sourceAssignment.id || "");
    const nestedRecording = findNestedRecording(sourceRecording, assignmentId);
    return {
      id: assignmentId || sourceRecording.id,
      created_at:
        sourceAssignment.assigned_at ||
        sourceAssignment.updated_at ||
        (nestedRecording && nestedRecording.updated_at) ||
        sourceRecording.updated_at ||
        sourceAssignment.created_at ||
        (nestedRecording && nestedRecording.created_at) ||
        sourceRecording.created_at
    };
  }

  function findNestedRecording(recording, recordingId) {
    if (!recording || !recordingId) return null;
    const children = [
      ...(Array.isArray(recording.children) ? recording.children : []),
      ...(Array.isArray(recording.steps) ? recording.steps : [])
    ];
    for (const child of children) {
      if (String(child && child.id) === String(recordingId)) return child;
      const nested = findNestedRecording(child, recordingId);
      if (nested) return nested;
    }
    return null;
  }

  function makeRecordingUrl(origin, parsed) {
    const path = parsed.path.endsWith(".json") ? parsed.path : `${parsed.path}.json`;
    return `${normalizeOrigin(origin)}${path}`;
  }

  function normalizeThreadComments(threadComments) {
    if (Array.isArray(threadComments)) return threadComments;
    if (threadComments && Array.isArray(threadComments.comments)) return threadComments.comments;
    if (threadComments && Array.isArray(threadComments.recordings)) return threadComments.recordings;
    return [];
  }

  function getCommentCount(recording) {
    const count = Number(recording && (recording.comments_count ?? recording.comment_count));
    return Number.isFinite(count) ? count : 0;
  }

  function getPersonId(person) {
    return String(
      (person && (person.id ?? person.person_id ?? person.user_id ?? person.recording_id)) || ""
    );
  }

  function getRecordCreatorId(record) {
    return getPersonId(record && (record.creator || record.creator_person || record.person || record.author)) || getPersonId(record);
  }

  function hasLaterCurrentUserReply(threadComments, focus, personId) {
    return normalizeThreadComments(threadComments).some((comment) => {
      return getRecordCreatorId(comment) === String(personId) && isAfterComment(comment, focus);
    });
  }

  function isLaterDifferentActivity(activity, focus) {
    if (!activity || !focus) return false;
    if (String(activity.id || "") === String(focus.id || "")) return false;
    return compareRecordingTime(activity.created_at, activity.id, focus.created_at, focus.id) > 0;
  }

  function latestThreadActivity(threadComments, fallback) {
    const comments = normalizeThreadComments(threadComments);
    const latestComment = comments.length
      ? comments.reduce((latest, comment) => {
        if (!latest) return comment;
        return compareRecordingTime(comment.created_at, comment.id, latest.created_at, latest.id) > 0 ? comment : latest;
      }, null)
      : null;

    if (!latestComment) return fallback || {};
    if (!fallback) return latestComment;
    return compareRecordingTime(latestComment.created_at, latestComment.id, fallback.created_at, fallback.id) > 0
      ? latestComment
      : fallback;
  }

  function normalizeSender(sender) {
    return {
      id: getPersonId(sender),
      name: sender.name || "Someone",
      avatarUrl: sender.avatar_url || sender.avatarUrl || ""
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

  function makeIgnoreRecord(item) {
    return {
      action: "ignore",
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
