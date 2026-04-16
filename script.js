if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register('/sw.js')
      .catch(err => console.error('Service Worker error:', err));
  });
}

(function () {
  const DEVICE_ID_KEY = 'rankmaster_pro_device_id';
  const LAST_ACCOUNT_KEY = 'rankmaster_pro_last_account_email';
  const LOGIN_PROMPT_SEEN_KEY = 'rankmaster_pro_login_prompt_seen';
  const authState = {
    ready: false,
    busy: false,
    cloudEnabled: true,
    authenticated: false,
    email: '',
    syncing: false,
    pendingSync: false,
    lastSyncMessage: 'Local-only mode',
    lastSyncAt: null,
    cloudHistory: [],
    cloudHistoryLoading: false,
    cloudHistoryError: ''
  };
  const CLOUD_POLL_MS = 15000;

  let syncTimer = null;
  let lastDataSnapshot = '';
  let suppressLocalTouch = 0;
  let originalSaveState = null;

  function getDeviceId() {
    let current = localStorage.getItem(DEVICE_ID_KEY);
    if (!current) {
      current =
        (window.crypto && window.crypto.randomUUID && window.crypto.randomUUID()) ||
        `device-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
      localStorage.setItem(DEVICE_ID_KEY, current);
    }
    return current;
  }

  function ensureSyncMeta(targetState = state) {
    if (!targetState || typeof targetState !== 'object') return {};
    if (!targetState.syncMeta || typeof targetState.syncMeta !== 'object') {
      targetState.syncMeta = {};
    }
    if (!targetState.syncMeta.deviceId) {
      targetState.syncMeta.deviceId = getDeviceId();
    }
    return targetState.syncMeta;
  }

  function cloneStateForSyncComparison(targetState) {
    const clone = JSON.parse(JSON.stringify(targetState || {}));
    delete clone.syncMeta;
    return clone;
  }

  function getComparableSnapshot(targetState = state) {
    return JSON.stringify(cloneStateForSyncComparison(targetState));
  }

  function toMillis(value) {
    const stamp = value ? new Date(value).getTime() : 0;
    return Number.isFinite(stamp) ? stamp : 0;
  }

  function getLatestIso(...values) {
    let newest = 0;
    values.forEach(value => {
      newest = Math.max(newest, toMillis(value));
    });
    return newest ? new Date(newest).toISOString() : null;
  }

  function getRemoteChangeMillis(remotePayload) {
    return Math.max(
      toMillis(remotePayload?.save?.syncMeta?.lastLocalChangeAt),
      toMillis(remotePayload?.clientUpdatedAt),
      toMillis(remotePayload?.updatedAt)
    );
  }

  function getLocalChangeMillis() {
    return toMillis(ensureSyncMeta().lastLocalChangeAt);
  }

  function hasPendingLocalUpload() {
    const meta = ensureSyncMeta();
    if (!hasMeaningfulStateData()) return false;
    if (authState.email && meta.accountEmail && meta.accountEmail !== authState.email) {
      return false;
    }

    const localStamp = toMillis(meta.lastLocalChangeAt);
    const syncedStamp = Math.max(
      toMillis(meta.serverUpdatedAt),
      toMillis(meta.lastSyncedAt)
    );

    if (!Number(meta.serverVersion || 0)) {
      return localStamp > 0;
    }
    return localStamp > syncedStamp;
  }

  function hasRemoteNewerData(remoteSave) {
    const remoteStamp = getRemoteChangeMillis(remoteSave);
    const localStamp = toMillis(state?.syncMeta?.lastLocalChangeAt);
    const remoteVersion = Number(remoteSave?.version || 0);
    const localVersion = Number(state?.syncMeta?.serverVersion || 0);

    if (remoteStamp > localStamp) return true;
    if (remoteStamp === localStamp && remoteVersion > localVersion) return true;
    return false;
  }

  function setLastAccountEmail(email) {
    if (email) localStorage.setItem(LAST_ACCOUNT_KEY, email);
    else localStorage.removeItem(LAST_ACCOUNT_KEY);
  }

  function getLastAccountEmail() {
    return localStorage.getItem(LAST_ACCOUNT_KEY) || '';
  }

  function hasSeenLoginPrompt() {
    return localStorage.getItem(LOGIN_PROMPT_SEEN_KEY) === '1';
  }

  function markLoginPromptSeen() {
    localStorage.setItem(LOGIN_PROMPT_SEEN_KEY, '1');
  }

  function getAuthModal() {
    return document.getElementById('auth-start-modal');
  }

  function isAuthPromptVisible() {
    return getAuthModal()?.classList.contains('show') || false;
  }

  function showAuthPrompt() {
    if (authState.authenticated) return;
    const modal = getAuthModal();
    if (!modal) return;
    modal.classList.add('show');
    const email = getLastAccountEmail();
    const modalEmail = document.getElementById('auth-modal-email');
    const settingsEmail = document.getElementById('auth-email');
    if (modalEmail && !modalEmail.value && email) modalEmail.value = email;
    if (settingsEmail && !settingsEmail.value && email) settingsEmail.value = email;
    window.setTimeout(() => {
      const target = document.getElementById('auth-modal-email');
      if (target) target.focus();
    }, 0);
  }

  function hideAuthPrompt() {
    const modal = getAuthModal();
    if (!modal) return;
    modal.classList.remove('show');
  }

  function maybeShowAuthPrompt() {
    if (!authState.authenticated && !hasSeenLoginPrompt()) {
      showAuthPrompt();
    } else if (authState.authenticated) {
      hideAuthPrompt();
    }
  }

  function syncAuthFieldValues(sourceEmail = '', sourcePassword = '') {
    const email = String(sourceEmail || '').trim();
    const password = String(sourcePassword || '');
    ['auth-email', 'auth-modal-email'].forEach(id => {
      const field = document.getElementById(id);
      if (field && field.value !== email) field.value = email;
    });
    ['auth-password', 'auth-modal-password'].forEach(id => {
      const field = document.getElementById(id);
      if (field && field.value !== password) field.value = password;
    });
  }

  function getAuthFields() {
    const modalEmail = document.getElementById('auth-modal-email');
    const modalPassword = document.getElementById('auth-modal-password');
    const settingsEmail = document.getElementById('auth-email');
    const settingsPassword = document.getElementById('auth-password');
    const useModal =
      isAuthPromptVisible() ||
      Boolean(modalEmail?.value) ||
      Boolean(modalPassword?.value);
    return useModal
      ? { emailField: modalEmail, passwordField: modalPassword, altEmailField: settingsEmail, altPasswordField: settingsPassword }
      : { emailField: settingsEmail, passwordField: settingsPassword, altEmailField: modalEmail, altPasswordField: modalPassword };
  }

  function setSyncMessage(message) {
    authState.lastSyncMessage = message;
    updateAuthUI();
  }

  function markServerVersion(meta, payload) {
    meta.serverVersion = Number(payload?.version || 0);
    meta.serverUpdatedAt = payload?.updatedAt || null;
    meta.lastSyncedAt = new Date().toISOString();
    if (authState.email) meta.accountEmail = authState.email;
  }

  function persistStateWithoutTouch(fn) {
    suppressLocalTouch++;
    try {
      return fn();
    } finally {
      suppressLocalTouch = Math.max(0, suppressLocalTouch - 1);
      lastDataSnapshot = getComparableSnapshot();
      updateAuthUI();
    }
  }

  function persistCurrentState() {
    if (typeof originalSaveState === 'function') {
      return originalSaveState();
    }
    try {
      localStorage.setItem('rankmaster_pro_state', JSON.stringify(state));
    } catch (error) {}
  }

  function hasMeaningfulStateData(targetState = state) {
    const players = Array.isArray(targetState?.players) ? targetState.players.length : 0;
    const history = Array.isArray(targetState?.history) ? targetState.history.length : 0;
    const hasTournament = Boolean(targetState?.tournament);
    return players > 0 || history > 0 || hasTournament || getComparableSnapshot(targetState) !== '{}';
  }

  async function fetchJson(url, options = {}) {
    const response = await fetch(url, {
      credentials: 'same-origin',
      cache: 'no-store',
      headers: {
        'Content-Type': 'application/json',
        ...(options.headers || {})
      },
      ...options
    });
    let payload = null;
    try {
      payload = await response.json();
    } catch (error) {}
    if (!response.ok) {
      const message = payload?.error || 'Request failed.';
      const err = new Error(message);
      err.status = response.status;
      err.payload = payload;
      throw err;
    }
    return payload;
  }

  function readAuthFormValues() {
    const { emailField, passwordField, altEmailField, altPasswordField } = getAuthFields();
    const emailValue = String(emailField?.value || altEmailField?.value || '').trim();
    const passwordValue = String(passwordField?.value || altPasswordField?.value || '');
    syncAuthFieldValues(emailValue, passwordValue);
    return {
      email: emailValue,
      password: passwordValue
    };
  }

  function clearAuthFormError() {
    ['auth-error', 'auth-modal-error'].forEach(id => {
      const errorNode = document.getElementById(id);
      if (errorNode) errorNode.textContent = '';
    });
  }

  function setAuthFormError(message) {
    ['auth-error', 'auth-modal-error'].forEach(id => {
      const errorNode = document.getElementById(id);
      if (errorNode) errorNode.textContent = message || '';
    });
  }

  function setAuthBusy(value) {
    authState.busy = Boolean(value);
    const buttons = [
      'auth-login-btn',
      'auth-register-btn',
      'auth-modal-login-btn',
      'auth-modal-register-btn',
      'auth-modal-skip-btn',
      'sync-now-btn',
      'pull-cloud-btn',
      'header-login-btn',
      'header-sync-btn',
      'logout-btn',
      'header-logout-btn'
    ];
    buttons.forEach(id => {
      const node = document.getElementById(id);
      if (node) node.disabled = value;
    });
    updateAuthUI();
  }

  function updateAuthUI() {
    const signedOutCard = document.getElementById('auth-signed-out');
    const signedInCard = document.getElementById('auth-signed-in');
    const syncNowBtn = document.getElementById('sync-now-btn');
    const pullCloudBtn = document.getElementById('pull-cloud-btn');
    const logoutBtn = document.getElementById('logout-btn');
    const headerLoginBtn = document.getElementById('header-login-btn');
    const headerSyncBtn = document.getElementById('header-sync-btn');
    const headerLogoutBtn = document.getElementById('header-logout-btn');
    const authStatusPill = document.getElementById('auth-status-pill');
    const authBannerTitle = document.getElementById('auth-banner-title');
    const authBannerSub = document.getElementById('auth-banner-sub');
    const signedInEmail = document.getElementById('signed-in-email');
    const cloudStatus = document.getElementById('sync-status-text');
    const cloudVersion = document.getElementById('sync-version-text');
    const cloudUpdated = document.getElementById('sync-updated-text');
    const cloudDevice = document.getElementById('sync-device-text');
    const cloudMode = document.getElementById('cloud-mode-text');

    const meta = ensureSyncMeta();
    const serverVersion = Number(meta.serverVersion || 0);
    const updatedText = meta.serverUpdatedAt
      ? new Date(meta.serverUpdatedAt).toLocaleString()
      : 'Not synced yet';
    const pillText = !authState.cloudEnabled
      ? 'Cloud Offline'
      : authState.authenticated
        ? authState.syncing
          ? 'Syncing...'
          : 'Cloud Linked'
        : 'Local Save';

    if (signedOutCard) {
      signedOutCard.style.display = !authState.authenticated ? 'block' : 'none';
    }
    if (signedInCard) {
      signedInCard.style.display =
        authState.cloudEnabled && authState.authenticated ? 'block' : 'none';
    }
    if (signedInEmail) {
      signedInEmail.textContent = authState.email || getLastAccountEmail() || 'Not signed in';
    }
    const rememberedEmail = getLastAccountEmail();
    ['auth-email', 'auth-modal-email'].forEach(id => {
      const field = document.getElementById(id);
      if (field && !field.value && rememberedEmail) field.value = rememberedEmail;
    });
    if (syncNowBtn) {
      syncNowBtn.disabled = !authState.authenticated || authState.syncing || authState.busy;
    }
    if (pullCloudBtn) {
      pullCloudBtn.disabled = !authState.authenticated || authState.syncing || authState.busy;
    }
    if (logoutBtn) {
      logoutBtn.style.display = authState.authenticated ? 'inline-flex' : 'none';
      logoutBtn.disabled = authState.busy;
    }
    if (headerLoginBtn) {
      headerLoginBtn.style.display =
        !authState.authenticated ? 'inline-flex' : 'none';
      headerLoginBtn.disabled = authState.busy;
    }
    if (headerSyncBtn) {
      headerSyncBtn.style.display = authState.authenticated ? 'inline-flex' : 'none';
      headerSyncBtn.disabled = !authState.authenticated || authState.syncing || authState.busy;
    }
    if (headerLogoutBtn) {
      headerLogoutBtn.style.display = authState.authenticated ? 'inline-flex' : 'none';
      headerLogoutBtn.disabled = authState.busy;
    }
    if (authStatusPill) {
      authStatusPill.textContent = pillText;
    }
    if (authBannerTitle) {
      authBannerTitle.textContent = !authState.cloudEnabled
        ? 'Sign-in server is not configured yet'
        : authState.authenticated
          ? `Signed in as ${authState.email}`
          : 'Local mode is active';
    }
    if (authBannerSub) {
      authBannerSub.textContent = !authState.cloudEnabled
        ? 'The login UI is available, but this deployment still needs its Render database and session setup before email sign-in can complete.'
        : authState.authenticated
          ? 'This device keeps saving locally and also checks the database for newer account data.'
          : 'Your data is still saved locally. Sign in once on this device to sync it with your account.';
    }
    if (cloudStatus) {
      cloudStatus.textContent = authState.lastSyncMessage;
    }
    if (cloudVersion) {
      cloudVersion.textContent = serverVersion ? `v${serverVersion}` : 'Local only';
    }
    if (cloudUpdated) {
      cloudUpdated.textContent = updatedText;
    }
    if (cloudDevice) {
      cloudDevice.textContent = meta.deviceId || 'Unknown';
    }
    if (cloudMode) {
      cloudMode.textContent = authState.authenticated
        ? 'Local storage + account sync'
        : authState.cloudEnabled
          ? 'Local storage only until sign-in'
          : 'Login server not ready';
    }
    updateCloudHistoryUI();
  }

  function updateCloudHistoryUI() {
    const statusNode = document.getElementById('cloud-history-status');
    const listNode = document.getElementById('cloud-history-list');
    const refreshBtn = document.getElementById('cloud-history-refresh-btn');
    const currentVersion = Number(ensureSyncMeta().serverVersion || 0);

    if (refreshBtn) {
      refreshBtn.disabled =
        authState.busy || authState.cloudHistoryLoading || !authState.authenticated;
    }
    if (!statusNode || !listNode) return;

    if (!authState.cloudEnabled) {
      statusNode.textContent = 'Cloud history needs the Render web service and database deployment.';
      listNode.innerHTML = '<div class="cloud-history-empty">Cloud version history is unavailable until the server database is configured.</div>';
      return;
    }
    if (!authState.authenticated) {
      statusNode.textContent = 'Sign in to view and restore cloud versions.';
      listNode.innerHTML = '<div class="cloud-history-empty">Cloud rollback becomes available after you sign in and save to the cloud.</div>';
      return;
    }
    if (authState.cloudHistoryLoading) {
      statusNode.textContent = 'Loading cloud history...';
      if (!authState.cloudHistory.length) {
        listNode.innerHTML = '<div class="cloud-history-empty">Loading your recent cloud versions...</div>';
      }
      return;
    }
    if (authState.cloudHistoryError) {
      statusNode.textContent = authState.cloudHistoryError;
      if (!authState.cloudHistory.length) {
        listNode.innerHTML = '<div class="cloud-history-empty">Could not load cloud history right now.</div>';
      }
      return;
    }
    if (!authState.cloudHistory.length) {
      statusNode.textContent = 'No cloud history yet. The first ten signed-in saves will build your rollback list.';
      listNode.innerHTML = '<div class="cloud-history-empty">No cloud versions have been stored yet.</div>';
      return;
    }

    statusNode.textContent = 'The newest ten cloud versions are available below.';
    listNode.innerHTML = authState.cloudHistory.map(item => {
      const isCurrent = Number(item.version || 0) === currentVersion;
      const when = item.updatedAt
        ? new Date(item.updatedAt).toLocaleString()
        : 'Unknown time';
      const disabled = isCurrent || authState.busy || authState.cloudHistoryLoading;
      return `
        <div class="cloud-history-item">
          <div class="cloud-history-meta">
            <div class="cloud-history-title">Cloud Version v${item.version}${isCurrent ? ' (Current)' : ''}</div>
            <div class="cloud-history-sub">Saved ${when}</div>
          </div>
          <button class="btn btn-secondary btn-sm" onclick="restoreCloudVersion(${item.id})" ${disabled ? 'disabled' : ''}>${isCurrent ? 'Current' : 'Restore'}</button>
        </div>
      `;
    }).join('');
  }

  async function loadCloudHistory() {
    if (!authState.cloudEnabled || !authState.authenticated) {
      authState.cloudHistory = [];
      authState.cloudHistoryLoading = false;
      authState.cloudHistoryError = '';
      updateCloudHistoryUI();
      return [];
    }

    authState.cloudHistoryLoading = true;
    authState.cloudHistoryError = '';
    updateCloudHistoryUI();
    try {
      const payload = await fetchJson('/api/save/history', { method: 'GET' });
      authState.cloudHistory = Array.isArray(payload?.history) ? payload.history : [];
      authState.cloudHistoryError = '';
      return authState.cloudHistory;
    } catch (error) {
      authState.cloudHistory = [];
      authState.cloudHistoryError = error.message || 'Could not load cloud history.';
      throw error;
    } finally {
      authState.cloudHistoryLoading = false;
      updateCloudHistoryUI();
    }
  }

  function applyRemoteState(remotePayload, toastMessage) {
    if (!remotePayload?.save || typeof window.normalizeImportedState !== 'function') return;
    persistStateWithoutTouch(() => {
      state = window.normalizeImportedState(remotePayload.save);
      if (typeof window.ensureStateDefaults === 'function') {
        window.ensureStateDefaults();
      }
      const meta = ensureSyncMeta();
      meta.lastLocalChangeAt = getLatestIso(
        remotePayload.save?.syncMeta?.lastLocalChangeAt,
        remotePayload.clientUpdatedAt,
        remotePayload.updatedAt,
        meta.lastLocalChangeAt
      ) || new Date().toISOString();
      markServerVersion(meta, remotePayload);
      persistCurrentState();
      if (typeof window.renderAll === 'function') {
        window.renderAll();
      }
    });
    if (toastMessage && typeof window.showToast === 'function') {
      window.showToast(toastMessage, 'success');
    }
  }

  async function pushLocalState(baseVersion, reason, attempt = 0, force = false) {
    const meta = ensureSyncMeta();
    const payload = {
      state,
      baseVersion: Number.isFinite(baseVersion) ? baseVersion : Number(meta.serverVersion || 0),
      clientUpdatedAt: meta.lastLocalChangeAt || new Date().toISOString(),
      force
    };

    try {
      const saved = await fetchJson('/api/save', {
        method: 'PUT',
        body: JSON.stringify(payload)
      });
      persistStateWithoutTouch(() => {
        const nextMeta = ensureSyncMeta();
        if (!nextMeta.lastLocalChangeAt) {
          nextMeta.lastLocalChangeAt = payload.clientUpdatedAt;
        }
        markServerVersion(nextMeta, saved);
        persistCurrentState();
      });
      authState.lastSyncAt = saved.updatedAt || new Date().toISOString();
      setSyncMessage(`${force ? 'Cloud save overwritten' : 'Cloud save updated'}${reason ? ` (${reason})` : ''}`);
      loadCloudHistory().catch(() => {});
      return saved;
    } catch (error) {
      if (error.status === 409 && attempt < 1 && error.payload?.current) {
        const current = error.payload.current;
        if (force) {
          return pushLocalState(current.version, reason, attempt + 1, true);
        }
        if (hasRemoteNewerData(current)) {
          applyRemoteState(current, 'Loaded the newer cloud save.');
          setSyncMessage('Loaded newer cloud data');
          return current;
        }
        return pushLocalState(current.version, reason, attempt + 1, false);
      }
      throw error;
    }
  }

  async function uploadToCloud(reason = 'manual', options = {}) {
    const {
      overwriteCloud = true,
      promptBeforeOverwrite = false
    } = options;
    if (!authState.cloudEnabled || !authState.authenticated) {
      updateAuthUI();
      return null;
    }
    if (authState.syncing) {
      authState.pendingSync = true;
      return null;
    }

    authState.syncing = true;
    clearTimeout(syncTimer);
    updateAuthUI();

    try {
      const remote = await fetchJson('/api/save');
      const localMeta = ensureSyncMeta();
      const remoteHasState = Boolean(remote?.save);
      const localHasMeaningfulData = hasMeaningfulStateData();
      const accountMismatch =
        authState.email &&
        localMeta.accountEmail &&
        localMeta.accountEmail !== authState.email;

      if (!remoteHasState) {
        if (accountMismatch) {
          setSyncMessage('Cloud account is empty. Local data belongs to a different signed-in account on this device.');
          return remote;
        }
        if (localHasMeaningfulData) {
          return await pushLocalState(0, reason);
        }
        persistStateWithoutTouch(() => {
          const meta = ensureSyncMeta();
          markServerVersion(meta, remote);
          persistCurrentState();
        });
        setSyncMessage('Cloud account is ready for uploads');
        loadCloudHistory().catch(() => {});
        return remote;
      }

      const localSnapshot = getComparableSnapshot();
      const remoteSnapshot = getComparableSnapshot(remote.save);
      if (localSnapshot === remoteSnapshot) {
        persistStateWithoutTouch(() => {
          const meta = ensureSyncMeta();
          if (!meta.lastLocalChangeAt) meta.lastLocalChangeAt = new Date().toISOString();
          meta.lastLocalChangeAt = getLatestIso(
            meta.lastLocalChangeAt,
            remote.save?.syncMeta?.lastLocalChangeAt,
            remote.clientUpdatedAt,
            remote.updatedAt
          ) || meta.lastLocalChangeAt;
          markServerVersion(meta, remote);
          persistCurrentState();
        });
        setSyncMessage('Local and cloud data already match');
        loadCloudHistory().catch(() => {});
        return remote;
      }

      const remoteStamp = getRemoteChangeMillis(remote);
      const localStamp = toMillis(localMeta.lastLocalChangeAt);
      const needsOverwrite =
        accountMismatch ||
        remoteStamp > localStamp ||
        (remoteStamp === localStamp && localSnapshot !== remoteSnapshot);

      if (!localHasMeaningfulData) {
        setSyncMessage('There is no local data to push right now.');
        if (reason === 'manual' && typeof window.showToast === 'function') {
          window.showToast('There is no meaningful local data to upload yet.', 'error');
        }
        return remote;
      }

      if (needsOverwrite && overwriteCloud) {
        if (promptBeforeOverwrite) {
          const overwriteMsg = accountMismatch
            ? 'This local data belongs to a different signed-in account on this device. Overwrite the current cloud save anyway?'
            : 'Overwrite the current cloud save with this device data?';
          if (!window.confirm(overwriteMsg)) {
            setSyncMessage('Cloud overwrite canceled');
            return remote;
          }
        }
        return await pushLocalState(remote.version, `${reason} overwrite`, 0, true);
      }

      if (needsOverwrite) {
        setSyncMessage('Cloud data differs from local data. Use Push To Cloud to overwrite it or Download From Cloud to replace this device.');
        loadCloudHistory().catch(() => {});
        return remote;
      }

      return await pushLocalState(remote.version, reason, 0, false);
    } catch (error) {
      if (error.status === 401) {
        authState.authenticated = false;
        authState.email = '';
        authState.cloudHistory = [];
        authState.cloudHistoryError = '';
        setSyncMessage('Sign in again to sync');
      } else {
        setSyncMessage(error.message || 'Cloud sync failed');
        if (typeof window.showToast === 'function') {
          window.showToast(error.message || 'Cloud sync failed', 'error');
        }
      }
      throw error;
    } finally {
      authState.syncing = false;
      updateAuthUI();
      if (authState.pendingSync) {
        authState.pendingSync = false;
        scheduleSync('queued');
      }
    }
  }

  async function downloadFromCloud(reason = 'manual') {
    if (!authState.cloudEnabled || !authState.authenticated) {
      updateAuthUI();
      return null;
    }

    setAuthBusy(true);
    try {
      const remote = await fetchJson('/api/save');
      if (!remote?.save) {
        setSyncMessage('There is no cloud save to download yet.');
        if (reason === 'manual' && typeof window.showToast === 'function') {
          window.showToast('No cloud save is available yet.', 'error');
        }
        await loadCloudHistory().catch(() => {});
        return null;
      }

      const localSnapshot = getComparableSnapshot();
      const remoteSnapshot = getComparableSnapshot(remote.save);
      const localHasMeaningfulData = hasMeaningfulStateData();
      const remoteIsOlder = getRemoteChangeMillis(remote) < toMillis(ensureSyncMeta().lastLocalChangeAt);

      if (localSnapshot === remoteSnapshot) {
        persistStateWithoutTouch(() => {
          const meta = ensureSyncMeta();
          meta.lastLocalChangeAt = getLatestIso(
            meta.lastLocalChangeAt,
            remote.save?.syncMeta?.lastLocalChangeAt,
            remote.clientUpdatedAt,
            remote.updatedAt
          ) || meta.lastLocalChangeAt || new Date().toISOString();
          markServerVersion(meta, remote);
          persistCurrentState();
        });
        setSyncMessage('This device already has the latest cloud data');
        await loadCloudHistory().catch(() => {});
        return remote;
      }

      if (localHasMeaningfulData) {
        const message = remoteIsOlder
          ? 'The cloud save looks older than your local data. Download it anyway and replace this device?'
          : 'Download the cloud save and replace this device data with it?';
        if (!window.confirm(message)) {
          return null;
        }
      }

      applyRemoteState(remote, 'Downloaded the cloud save to this device.');
      setSyncMessage('Downloaded cloud save to this device');
      await loadCloudHistory().catch(() => {});
      return remote;
    } catch (error) {
      setSyncMessage(error.message || 'Could not download the cloud save.');
      if (reason === 'manual' && typeof window.showToast === 'function') {
        window.showToast(error.message || 'Could not download the cloud save.', 'error');
      }
      throw error;
    } finally {
      setAuthBusy(false);
    }
  }

  async function autoSyncWithCloud(reason = 'auto') {
    if (!authState.cloudEnabled || !authState.authenticated) {
      updateAuthUI();
      return null;
    }
    if (authState.syncing || authState.busy) {
      return null;
    }

    try {
      const remote = await fetchJson('/api/save');
      const localMeta = ensureSyncMeta();
      const remoteHasState = Boolean(remote?.save);
      const localHasMeaningfulData = hasMeaningfulStateData();
      const pendingLocalUpload = hasPendingLocalUpload();
      const accountMismatch =
        authState.email &&
        localMeta.accountEmail &&
        localMeta.accountEmail !== authState.email;

      if (!remoteHasState) {
        if (pendingLocalUpload) {
          return await pushLocalState(0, `${reason} upload`, 0, false);
        }
        setSyncMessage(localHasMeaningfulData ? 'No cloud save yet. Local changes will upload automatically.' : 'Cloud account is ready.');
        await loadCloudHistory().catch(() => {});
        return null;
      }

      const localSnapshot = getComparableSnapshot();
      const remoteSnapshot = getComparableSnapshot(remote.save);

      if (accountMismatch) {
        applyRemoteState(remote, null);
        setSyncMessage('Downloaded cloud data automatically for the signed-in account');
        await loadCloudHistory().catch(() => {});
        return remote;
      }

      if (localSnapshot === remoteSnapshot) {
        persistStateWithoutTouch(() => {
          const meta = ensureSyncMeta();
          meta.lastLocalChangeAt = getLatestIso(
            meta.lastLocalChangeAt,
            remote.save?.syncMeta?.lastLocalChangeAt,
            remote.clientUpdatedAt,
            remote.updatedAt
          ) || meta.lastLocalChangeAt || new Date().toISOString();
          markServerVersion(meta, remote);
          persistCurrentState();
        });
        setSyncMessage('This device already has the latest cloud data');
        await loadCloudHistory().catch(() => {});
        return remote;
      }

      const remoteStamp = getRemoteChangeMillis(remote);
      const localStamp = getLocalChangeMillis();
      const remoteVersion = Number(remote.version || 0);
      const localVersion = Number(localMeta.serverVersion || 0);
      const remoteIsNewer =
        !localHasMeaningfulData ||
        remoteStamp > localStamp ||
        (remoteStamp === localStamp && remoteVersion > localVersion);
      const localIsNewer =
        localHasMeaningfulData &&
        pendingLocalUpload &&
        (localStamp > remoteStamp ||
          (localStamp === remoteStamp && localVersion >= remoteVersion));

      if (remoteIsNewer) {
        applyRemoteState(remote, null);
        setSyncMessage('Downloaded newer cloud data automatically');
        await loadCloudHistory().catch(() => {});
        return remote;
      }

      if (localIsNewer) {
        return await pushLocalState(remote.version, `${reason} upload`, 0, false);
      }

      if (pendingLocalUpload) {
        return await pushLocalState(remote.version, `${reason} upload`, 0, false);
      }

      applyRemoteState(remote, null);
      setSyncMessage('Downloaded cloud data automatically');
      await loadCloudHistory().catch(() => {});
      return remote;
    } catch (error) {
      if (error.status === 401) {
        authState.authenticated = false;
        authState.email = '';
        authState.cloudHistory = [];
        authState.cloudHistoryError = '';
        setSyncMessage('Sign in again to sync');
        updateAuthUI();
        return null;
      }
      setSyncMessage(error.message || 'Automatic cloud sync failed');
      updateAuthUI();
      return null;
    }
  }

  function scheduleSync(reason = 'auto') {
    if (!authState.cloudEnabled || !authState.authenticated) return;
    clearTimeout(syncTimer);
    syncTimer = window.setTimeout(() => {
      uploadToCloud(reason).catch(() => {});
    }, 1200);
  }

  async function refreshSession() {
    try {
      const payload = await fetchJson('/api/auth/session', { method: 'GET' });
      authState.cloudEnabled = payload.cloudEnabled !== false;
      authState.authenticated = Boolean(payload.authenticated);
      authState.email = payload.email || '';
      authState.ready = true;
      if (authState.email) {
        setLastAccountEmail(authState.email);
        ensureSyncMeta().accountEmail = authState.email;
        syncAuthFieldValues(authState.email, '');
      } else {
        syncAuthFieldValues(getLastAccountEmail(), '');
      }
      updateAuthUI();
      if (authState.authenticated) {
        await autoSyncWithCloud('startup');
      } else {
        authState.cloudHistory = [];
        authState.cloudHistoryError = '';
        setSyncMessage(authState.cloudEnabled ? 'Local-only mode' : 'Cloud sync unavailable');
      }
      maybeShowAuthPrompt();
    } catch (error) {
      authState.ready = true;
      authState.cloudEnabled = false;
      authState.authenticated = false;
      authState.email = '';
      authState.cloudHistory = [];
      authState.cloudHistoryError = '';
      syncAuthFieldValues(getLastAccountEmail(), '');
      setSyncMessage('Cloud sync unavailable');
      updateAuthUI();
      maybeShowAuthPrompt();
    }
  }

  async function submitAuth(endpoint, successMessage) {
    clearAuthFormError();
    const { email, password } = readAuthFormValues();
    if (!email || !password) {
      setAuthFormError('Enter your email and password.');
      return;
    }

    syncAuthFieldValues(email, password);

    setAuthBusy(true);
    try {
      const result = await fetchJson(endpoint, {
        method: 'POST',
        body: JSON.stringify({ email, password })
      });
      authState.cloudEnabled = true;
      authState.authenticated = Boolean(result.authenticated);
      authState.email = result.email || email;
      setLastAccountEmail(authState.email);
      markLoginPromptSeen();
      hideAuthPrompt();
      ensureSyncMeta().accountEmail = authState.email;
      authState.cloudHistory = [];
      authState.cloudHistoryError = '';
      setSyncMessage('Signed in. Checking cloud data...');
      updateAuthUI();
      if (typeof window.showToast === 'function') {
        window.showToast(successMessage, 'success');
      }
      await autoSyncWithCloud('auth');
      syncAuthFieldValues(authState.email, '');
    } catch (error) {
      setAuthFormError(error.message || 'Could not sign in.');
    } finally {
      setAuthBusy(false);
    }
  }

  async function logoutAccount() {
    setAuthBusy(true);
    try {
      await fetchJson('/api/auth/logout', {
        method: 'POST',
        body: JSON.stringify({})
      });
      authState.authenticated = false;
      authState.email = '';
      authState.cloudHistory = [];
      authState.cloudHistoryError = '';
      syncAuthFieldValues(getLastAccountEmail(), '');
      setSyncMessage('Signed out. Local save is still available.');
      updateAuthUI();
      if (typeof window.showToast === 'function') {
        window.showToast('Signed out. Local data is still on this device.', 'success');
      }
    } catch (error) {
      setAuthFormError(error.message || 'Could not sign out.');
    } finally {
      setAuthBusy(false);
    }
  }

  async function restoreCloudVersion(historyId) {
    if (!authState.authenticated || !historyId) return;
    if (!window.confirm('Restore this cloud version? The current cloud save will stay protected in the version history.')) {
      return;
    }

    setAuthBusy(true);
    try {
      const payload = await fetchJson('/api/save/restore', {
        method: 'POST',
        body: JSON.stringify({
          historyId,
          clientUpdatedAt: new Date().toISOString()
        })
      });
      if (payload?.current) {
        applyRemoteState(payload.current, `Restored cloud version v${payload?.restoredFrom?.version || ''}.`);
      }
      setSyncMessage(`Restored cloud version v${payload?.restoredFrom?.version || ''}`);
      await loadCloudHistory().catch(() => {});
    } catch (error) {
      setSyncMessage(error.message || 'Could not restore cloud version.');
      if (typeof window.showToast === 'function') {
        window.showToast(error.message || 'Could not restore cloud version.', 'error');
      }
    } finally {
      setAuthBusy(false);
    }
  }

  function wrapSaveState() {
    if (typeof window.saveState !== 'function') return;
    originalSaveState = window.saveState.bind(window);
    lastDataSnapshot = getComparableSnapshot();

    window.saveState = function wrappedSaveState() {
      ensureSyncMeta();
      const nextSnapshot = getComparableSnapshot();
      const changedMeaningfully = nextSnapshot !== lastDataSnapshot;

      if (changedMeaningfully && suppressLocalTouch === 0) {
        const meta = ensureSyncMeta();
        meta.lastLocalChangeAt = new Date().toISOString();
        if (authState.email) meta.accountEmail = authState.email;
      }

      const result = originalSaveState();
      lastDataSnapshot = getComparableSnapshot();
      updateAuthUI();

      if (changedMeaningfully && suppressLocalTouch === 0) {
        scheduleSync('local change');
      }
      return result;
    };
  }

  function setupSyncEventHooks() {
    window.addEventListener('online', () => {
      if (authState.authenticated) {
        autoSyncWithCloud('online').catch(() => {});
      }
    });
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && authState.authenticated) {
        autoSyncWithCloud('resume').catch(() => {});
      }
    });
    window.setInterval(() => {
      if (authState.authenticated && !document.hidden) {
        autoSyncWithCloud('interval').catch(() => {});
      }
    }, CLOUD_POLL_MS);
  }

  function initCloudSync() {
    ensureSyncMeta();
    wrapSaveState();
    syncAuthFieldValues(getLastAccountEmail(), '');
    ['auth-email', 'auth-modal-email', 'auth-password', 'auth-modal-password'].forEach(id => {
      const field = document.getElementById(id);
      if (!field) return;
      field.addEventListener('input', () => {
        const { email, password } = readAuthFormValues();
        syncAuthFieldValues(email, password);
      });
      field.addEventListener('keydown', event => {
        if (event.key === 'Enter') {
          event.preventDefault();
          loginAccount();
        }
      });
    });
    updateAuthUI();
    setupSyncEventHooks();
    refreshSession();
  }

  window.loginAccount = function loginAccount() {
    return submitAuth('/api/auth/login', 'Signed in successfully.');
  };

  window.registerAccount = function registerAccount() {
    return submitAuth('/api/auth/register', 'Account created successfully.');
  };

  window.openAuthPrompt = function openAuthPrompt() {
    clearAuthFormError();
    showAuthPrompt();
  };

  window.continueLocalMode = function continueLocalMode() {
    markLoginPromptSeen();
    hideAuthPrompt();
    clearAuthFormError();
    updateAuthUI();
  };

  window.logoutAccount = logoutAccount;
  window.downloadFromCloud = function downloadFromCloudFromUi() {
    return downloadFromCloud('manual').catch(() => {});
  };
  window.refreshCloudHistory = function refreshCloudHistory() {
    return loadCloudHistory().catch(() => {});
  };
  window.restoreCloudVersion = function restoreCloudVersionFromUi(historyId) {
    return restoreCloudVersion(historyId);
  };
  window.syncNow = function syncNowFromUi() {
    return uploadToCloud('manual').catch(() => {});
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initCloudSync, { once: true });
  } else {
    initCloudSync();
  }
})();
