/* global BasecampNeedsReplyEngine, chrome */
(function initBasecampNeedsReply() {
  "use strict";

  const ROOT_ID = "bnr-root";
  const BUTTON_ID = "bnr-tray-button";
  const PANEL_ID = "bnr-panel";
  const FALLBACK_CLASS = "bnr-fallback";
  const STORAGE_KEY = "basecampNeedsReplySettings";
  const CACHE_KEY = "basecampNeedsReplyLastResult";
  const IGNORED_KEY = "basecampNeedsReplyIgnored";
  // Matches AUTO_REFRESH_MIN_AGE_MS in the service worker.
  const AUTO_REFRESH_MIN_AGE_MS = 2 * 60 * 1000;

  let state = {
    isOpen: false,
    isLoading: false,
    items: [],
    meta: null,
    error: null,
    settings: null,
    showAll: false
  };

  let refreshPromise = null;

  function start() {
    ensureRoot();
    injectEntryPoint();
    observeBasecampNavigation();
    document.addEventListener("keydown", handleKeydown);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    chrome.storage.onChanged.addListener(handleStorageChange);

    // Show the cached badge right away, then refresh in the background so the
    // panel already has current data by the time it is opened.
    Promise.all([loadSettings(), loadCachedItems()]).then(autoRefresh);
  }

  function ensureRoot() {
    if (document.getElementById(ROOT_ID)) return document.getElementById(ROOT_ID);
    const root = document.createElement("div");
    root.id = ROOT_ID;
    document.body.appendChild(root);
    return root;
  }

  function injectEntryPoint() {
    if (document.getElementById(BUTTON_ID)) return;

    const myTasksButton = document.querySelector('button[aria-label="My Tasks"], button[title="My Tasks"]');
    const myTasksTab = myTasksButton && myTasksButton.closest(".tray__tab");
    const leftTray = myTasksTab && myTasksTab.closest("section.tray--left");

    if (myTasksTab && leftTray) {
      const tab = document.createElement("div");
      tab.className = "tray__tab bnr-tray-tab";
      tab.dataset.basecampNeedsReply = "true";

      const button = createTrayButton(false);
      tab.appendChild(button);
      myTasksTab.insertAdjacentElement("afterend", tab);
      return;
    }

    const root = ensureRoot();
    const fallback = createTrayButton(true);
    root.appendChild(fallback);
  }

  function createTrayButton(isFallback) {
    const button = document.createElement("button");
    button.id = BUTTON_ID;
    button.type = "button";
    button.className = isFallback
      ? `bnr-button ${FALLBACK_CLASS}`
      : "tray__nav btn btn--sm btn--ghost bnr-button";
    button.setAttribute("aria-label", "Needs Reply");
    button.title = "Needs Reply";
    button.addEventListener("click", togglePanel);

    const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    icon.setAttribute("class", "svg-icon tray__nav-icon hidden@md-up");
    icon.setAttribute("viewBox", "0 0 24 24");
    icon.setAttribute("aria-hidden", "true");
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("fill", "currentColor");
    path.setAttribute("d", "M4 4h16v11H7.8L4 18.8V4Zm2 2v8l1-1h11V6H6Zm3 3h6v2H9V9Z");
    icon.appendChild(path);

    const label = document.createElement("span");
    label.className = isFallback ? "bnr-button__label" : "bnr-button__label hidden@md-down";
    label.append("Needs ", document.createTextNode("Reply"));

    const badge = document.createElement("span");
    badge.className = "bnr-button__badge";
    badge.hidden = true;

    if (!isFallback) button.appendChild(icon);
    button.append(label, badge);
    return button;
  }

  function observeBasecampNavigation() {
    const observer = new MutationObserver(() => {
      window.requestAnimationFrame(() => {
        ensureRoot();
        injectEntryPoint();
      });
    });

    observer.observe(document.body, { childList: true, subtree: true });
  }

  async function loadSettings() {
    const accountId = getCurrentAccountId();
    const origin = getCurrentBasecampOrigin();
    const response = await sendMessage({ type: "BNR_GET_SETTINGS", accountId, origin });
    if (response && response.ok) {
      state.settings = response.settings;
    } else {
      state.settings = BasecampNeedsReplyEngine.normalizeSettings({ accountId, origin });
    }
  }

  async function loadCachedItems() {
    const response = await sendMessage({ type: "BNR_GET_CACHE", showAll: state.showAll });
    if (response && response.ok && response.result) {
      state.items = response.result.items || [];
      state.meta = response.result.meta || null;
      updateBadge();
      if (state.isOpen) renderPanel({ preserveScroll: true });
    }
  }

  async function togglePanel() {
    state.isOpen = !state.isOpen;
    renderPanel();
    if (!state.isOpen) return;

    // Cached items are already rendered; only block on a fetch when nothing
    // has been loaded yet. Otherwise refresh quietly if the data is stale.
    if (!state.meta) {
      await getOrRefreshItems();
    } else {
      autoRefresh();
    }
  }

  async function getOrRefreshItems() {
    return refreshItems("BNR_GET_OR_REFRESH");
  }

  function autoRefresh() {
    if (refreshPromise || isCacheFresh() || !getCurrentAccountId()) return;
    refreshItems("BNR_PREFETCH");
  }

  function isCacheFresh() {
    const checkedAt = state.meta && state.meta.checkedAt;
    const time = checkedAt ? new Date(checkedAt).getTime() : 0;
    return Number.isFinite(time) && time > 0 && Date.now() - time < AUTO_REFRESH_MIN_AGE_MS;
  }

  // Concurrent callers in this tab (page-load prefetch, panel open, manual
  // refresh) share a single in-flight refresh.
  function refreshItems(messageType = "BNR_REFRESH") {
    if (!refreshPromise) {
      refreshPromise = runRefresh(messageType).finally(() => {
        refreshPromise = null;
      });
    }
    return refreshPromise;
  }

  async function runRefresh(messageType) {
    state.isLoading = true;
    state.error = null;
    renderPanel({ preserveScroll: true });

    const accountId = getCurrentAccountId();
    const origin = getCurrentBasecampOrigin();
    const requestedShowAll = state.showAll;

    let response = await sendMessage({ type: messageType, accountId, origin, showAll: requestedShowAll });

    if (!response || !response.ok) {
      response = await refreshItemsFromContentScript(accountId, origin, response && response.error);
    }

    if (response && response.ok) {
      state.items = response.items || [];
      state.meta = response.meta || null;
      state.error = null;
    } else {
      state.error = normalizeError(response && response.error);
    }

    state.isLoading = false;
    renderPanel({ preserveScroll: true });
    updateBadge();

    // The filter changed while this refresh was running; re-read the cache
    // with the current filter.
    if (response && response.ok && requestedShowAll !== state.showAll) {
      await loadCachedItems();
    }
  }

  async function refreshItemsFromContentScript(accountId, origin, backgroundError) {
    try {
      const settings = BasecampNeedsReplyEngine.normalizeSettings({
        ...(state.settings || {}),
        accountId,
        origin
      });
      const result = await BasecampNeedsReplyEngine.getNeedsReplyItems(settings);
      result.meta = {
        ...(result.meta || {}),
        fetchSource: "content-script-same-origin",
        backgroundError
      };

      // Cache the result (and apply ignores) through the service worker so the
      // next panel open is instant; fall back to the raw result if that fails.
      const stored = await sendMessage({ type: "BNR_STORE_RESULT", result, showAll: state.showAll });
      return stored && stored.ok ? stored : result;
    } catch (error) {
      return { ok: false, error: normalizeError(error) };
    }
  }

  function renderPanel(options = {}) {
    const root = ensureRoot();
    let panel = document.getElementById(PANEL_ID);
    const previousBody = document.querySelector(`#${PANEL_ID} .bnr-panel__body`);
    const previousScrollTop = options.preserveScroll && previousBody ? previousBody.scrollTop : null;

    if (!state.isOpen) {
      if (panel) panel.remove();
      return;
    }

    if (!panel) {
      panel = document.createElement("section");
      panel.id = PANEL_ID;
      panel.className = "bnr-panel";
      panel.setAttribute("aria-label", "Needs Reply panel");
      panel.addEventListener("click", (event) => event.stopPropagation());
      root.appendChild(panel);
    }

    panel.replaceChildren();
    panel.appendChild(renderHeader());

    const body = document.createElement("div");
    body.className = "bnr-panel__body";

    // Cached items stay visible while a refresh runs; the header button shows
    // "Checking…" until fresh data arrives.
    if (state.error) {
      body.appendChild(renderError(state.error));
    }
    if (state.items.length) {
      body.appendChild(renderList(state.items));
    } else if (state.isLoading && !state.meta) {
      body.appendChild(renderMessage("Checking mentions and assignments…", "Looking for pings or assigned work where you have not replied yet."));
    } else if (!state.error) {
      body.appendChild(renderMessage("No pending replies found.", "You're clear for the selected time window."));
    }

    panel.appendChild(body);
    panel.appendChild(renderFooter());

    if (previousScrollTop !== null) {
      window.requestAnimationFrame(() => {
        body.scrollTop = previousScrollTop;
      });
    }
  }

  function renderHeader() {
    const header = document.createElement("header");
    header.className = "perma-header bnr-panel__header";

    const topRow = document.createElement("div");
    topRow.className = "bnr-panel__top-row";

    const title = document.createElement("h1");
    title.className = "perma-header__title";
    title.textContent = "Needs Reply";

    const actions = document.createElement("div");
    actions.className = "bnr-panel__actions";

    const refresh = document.createElement("button");
    refresh.type = "button";
    refresh.className = "btn btn--sm btn--ghost bnr-toolbar-button bnr-refresh";
    refresh.disabled = state.isLoading;
    refresh.append(
      createSvgIcon("M17.7 6.3A8 8 0 1 0 20 12h-2a6 6 0 1 1-1.76-4.24L13 11h8V3l-3.3 3.3Z"),
      document.createTextNode(state.isLoading ? "Checking…" : "Refresh")
    );
    refresh.addEventListener("click", () => refreshItems());

    const close = document.createElement("button");
    close.type = "button";
    close.className = "btn btn--sm btn--icon btn--ghost bnr-toolbar-button bnr-close";
    close.setAttribute("aria-label", "Close Needs Reply");
    close.appendChild(createSvgIcon("M18.3 5.71 12 12l6.3 6.29-1.41 1.41L10.59 13.41 4.29 19.7 2.88 18.29 9.17 12 2.88 5.71 4.29 4.3l6.3 6.29 6.3-6.29 1.41 1.41Z"));
    close.addEventListener("click", () => {
      state.isOpen = false;
      renderPanel();
    });

    actions.append(refresh, close);
    topRow.append(title, actions);

    const content = document.createElement("div");
    content.className = "perma-header__content";
    content.appendChild(renderFilterNav());

    header.append(topRow, content);
    return header;
  }

  function renderFilterNav() {
    const nav = document.createElement("nav");
    nav.className = "filter bnr-filter";
    nav.setAttribute("aria-label", "Filter needs reply items");

    const group = document.createElement("div");
    group.className = "button-group";
    group.setAttribute("role", "group");

    const openOnly = document.createElement("button");
    openOnly.type = "button";
    openOnly.className = `button-group__btn btn btn--sm ${state.showAll ? "" : "active"}`.trim();
    openOnly.textContent = "Active";
    openOnly.addEventListener("click", () => setShowAll(false));

    const showAll = document.createElement("button");
    showAll.type = "button";
    showAll.className = `button-group__btn btn btn--sm ${state.showAll ? "active" : ""}`.trim();
    const total = state.meta && state.meta.totalNeedsReplyCount;
    showAll.textContent = total ? `Show all (${total})` : "Show all";
    showAll.addEventListener("click", () => setShowAll(true));

    group.append(openOnly, showAll);
    nav.appendChild(group);
    return nav;
  }

  async function setShowAll(showAll) {
    if (state.showAll === showAll) return;
    state.showAll = showAll;
    renderPanel();
    // Show all only changes local filtering, so re-read the cache instead of
    // fetching from Basecamp.
    if (state.meta) {
      await loadCachedItems();
    } else {
      await getOrRefreshItems();
    }
  }

  function createSvgIcon(pathData) {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("class", "svg-icon bnr-toolbar-icon");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("aria-hidden", "true");

    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("fill", "currentColor");
    path.setAttribute("d", pathData);
    svg.appendChild(path);
    return svg;
  }

  function renderFooter() {
    const footer = document.createElement("footer");
    footer.className = "bnr-panel__footer";

    const settings = state.settings || BasecampNeedsReplyEngine.DEFAULT_SETTINGS;
    const parts = [`${settings.daysBack || 7} days`];
    if (state.meta && state.meta.currentUser && state.meta.currentUser.name) {
      parts.push(`for ${state.meta.currentUser.name}`);
    }
    if (state.meta && state.meta.checkedAt) {
      parts.push(`checked ${formatRelativeTime(state.meta.checkedAt)}`);
    }
    if (state.meta && state.meta.fetchSource) {
      parts.push("same-origin fallback");
    }
    if (state.meta && Array.isArray(state.meta.errors) && state.meta.errors.length) {
      parts.push(`${state.meta.errors.length} checks failed`);
    }

    footer.textContent = parts.join(" · ");
    return footer;
  }

  function renderList(items) {
    const list = document.createElement("div");
    list.className = "bnr-list";
    for (const item of items) list.appendChild(renderItem(item));
    return list;
  }

  function renderItem(item) {
    const article = document.createElement("article");
    article.className = item.hiddenState ? "bnr-item bnr-item--hidden" : "bnr-item";

    const meta = document.createElement("div");
    meta.className = "bnr-item__meta";
    meta.textContent = `${item.projectName || "Basecamp"} · ${formatDate(item.mentionedAt)}`;
    if (item.sourceType === "recording_mention" || item.sourceType === "assignment") {
      const source = document.createElement("span");
      source.className = "bnr-source-badge";
      source.textContent = item.sourceType === "assignment" ? "Assignment" : "Description mention";
      meta.append(" · ", source);
    }
    if (item.hiddenState) {
      const badge = document.createElement("span");
      badge.className = "bnr-hidden-badge";
      badge.textContent = "Ignored";
      meta.append(" · ", badge);
    }

    const title = document.createElement("a");
    title.className = "bnr-item__title";
    title.href = item.mentionUrl || item.parentUrl;
    title.target = "_self";
    title.textContent = item.threadTitle || "Open thread";

    const sender = document.createElement("p");
    sender.className = "bnr-item__sender";
    const senderName = item.sender && item.sender.name ? item.sender.name : "someone";
    sender.textContent = item.sourceType === "assignment"
      ? "Assigned to you"
      : `Mentioned by ${senderName}`;

    const excerpt = document.createElement("p");
    excerpt.className = "bnr-item__excerpt";
    excerpt.textContent = item.excerpt || "No excerpt available.";

    const actions = document.createElement("div");
    actions.className = "bnr-item__actions";

    const open = document.createElement("a");
    open.className = "bnr-item__open";
    open.href = item.mentionUrl || item.parentUrl;
    open.target = "_self";
    open.textContent = "Open in Basecamp";

    const ignore = document.createElement("button");
    ignore.type = "button";
    ignore.className = "bnr-item__secondary";
    ignore.textContent = item.hiddenState ? "Unignore" : "Ignore";
    ignore.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (item.hiddenState) {
        unhideItem(item);
      } else {
        hideItem(item);
      }
    });

    actions.append(open, ignore);
    article.append(meta, title, sender, excerpt, actions);
    return article;
  }

  async function hideItem(item) {
    state.items = state.items.filter((candidate) => candidate.threadId !== item.threadId);
    updateBadge();
    renderPanel({ preserveScroll: true });

    const response = await sendMessage({ type: "BNR_IGNORE_ITEM", item, showAll: state.showAll });
    if (response && response.ok && response.result) {
      state.items = response.result.items || [];
      state.meta = response.result.meta || state.meta;
      updateBadge();
      renderPanel({ preserveScroll: true });
      return;
    }

    state.error = normalizeError(response && response.error);
    renderPanel();
  }

  async function unhideItem(item) {
    const response = await sendMessage({ type: "BNR_UNIGNORE_ITEM", item, showAll: state.showAll });
    if (response && response.ok && response.result) {
      state.items = response.result.items || [];
      state.meta = response.result.meta || state.meta;
      updateBadge();
      renderPanel({ preserveScroll: true });
      return;
    }

    state.error = normalizeError(response && response.error);
    renderPanel();
  }

  function renderMessage(titleText, detailText) {
    const box = document.createElement("div");
    box.className = "bnr-message";
    const title = document.createElement("strong");
    title.textContent = titleText;
    const detail = document.createElement("p");
    detail.textContent = detailText;
    box.append(title, detail);
    return box;
  }

  function renderError(error) {
    const box = renderMessage("Could not check mentions or assignments.", authHint(error));
    box.classList.add("bnr-message--error");
    const detail = document.createElement("small");
    detail.textContent = error.message || String(error);
    box.appendChild(detail);
    return box;
  }

  function updateBadge() {
    const badge = document.querySelector(`#${BUTTON_ID} .bnr-button__badge`);
    if (!badge) return;
    badge.textContent = String(state.items.length);
    badge.hidden = state.items.length === 0;
  }

  function getCurrentAccountId() {
    return BasecampNeedsReplyEngine.getAccountIdFromUrl(window.location.href)
      || (state.settings && state.settings.accountId)
      || BasecampNeedsReplyEngine.DEFAULT_SETTINGS.accountId;
  }

  function getCurrentBasecampOrigin() {
    if (window.location.origin === "https://3.basecamp.com") return "https://3.basecamp.com";
    return "https://app.basecamp.com";
  }

  function sendMessage(message) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(message, (response) => {
          if (chrome.runtime.lastError) {
            resolve({ ok: false, error: { message: chrome.runtime.lastError.message } });
            return;
          }
          resolve(response);
        });
      } catch (error) {
        resolve({ ok: false, error: normalizeError(error) });
      }
    });
  }

  function normalizeError(error) {
    if (!error) return { message: "Unknown error" };
    if (typeof error === "string") return { message: error };
    return {
      message: error.message || String(error),
      status: error.status,
      url: error.url
    };
  }

  function authHint(error) {
    if (error && (error.status === 401 || error.status === 403)) {
      return "Please make sure you are logged into Basecamp in this browser profile, then retry.";
    }
    return "Retry in a moment. If it keeps failing, reload Basecamp and check that you are logged in.";
  }

  function formatDate(dateString) {
    const date = new Date(dateString);
    if (!Number.isFinite(date.getTime())) return "recently";
    return date.toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  }

  function formatRelativeTime(dateString) {
    const date = new Date(dateString);
    if (!Number.isFinite(date.getTime())) return "recently";
    const seconds = Math.max(1, Math.round((Date.now() - date.getTime()) / 1000));
    if (seconds < 60) return "just now";
    const minutes = Math.round(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.round(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.round(hours / 24);
    return `${days}d ago`;
  }

  function handleStorageChange(changes, areaName) {
    if (areaName !== "local") return;
    if (changes[STORAGE_KEY]) loadSettings().then(() => {
      if (state.isOpen) renderPanel({ preserveScroll: true });
    });
    // Another tab (or the service worker) refreshed or ignored something.
    if (changes[CACHE_KEY] || changes[IGNORED_KEY]) loadCachedItems();
  }

  function handleVisibilityChange() {
    if (document.visibilityState === "visible") autoRefresh();
  }

  function handleKeydown(event) {
    if (event.key === "Escape" && state.isOpen) {
      state.isOpen = false;
      renderPanel();
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start, { once: true });
  } else {
    start();
  }
})();
