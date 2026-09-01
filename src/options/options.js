/* global BasecampNeedsReplyEngine, chrome */
(function initOptions() {
  "use strict";

  const STORAGE_KEY = "basecampNeedsReplySettings";
  const form = document.getElementById("settings-form");
  const status = document.getElementById("status");

  restoreSettings();
  form.addEventListener("submit", saveSettings);

  async function restoreSettings() {
    const data = await chrome.storage.local.get(STORAGE_KEY);
    const settings = BasecampNeedsReplyEngine.normalizeSettings(data[STORAGE_KEY]);
    for (const [key, value] of Object.entries(settings)) {
      const input = form.elements[key];
      if (input) input.value = value;
    }
  }

  async function saveSettings(event) {
    event.preventDefault();
    const settings = BasecampNeedsReplyEngine.normalizeSettings({
      accountId: form.elements.accountId.value,
      personId: form.elements.personId.value,
      daysBack: form.elements.daysBack.value,
      maxReadPages: form.elements.maxReadPages.value,
      origin: form.elements.origin.value
    });

    await chrome.storage.local.set({ [STORAGE_KEY]: settings });
    status.textContent = "Settings saved.";
    window.setTimeout(() => {
      status.textContent = "";
    }, 2400);
  }
})();
