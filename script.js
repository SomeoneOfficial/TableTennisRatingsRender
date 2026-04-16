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
    lastSyncAt: null
  };

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

  function hasRemoteNewerData(remoteSave) {
    const remoteStamp = toMillis(
      remoteSave?.save?.syncMeta?.lastLocalChangeAt ||
        remoteSave?.clientUpdatedAt ||
        remoteSave?.updatedAt
    );
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
  }

  function applyRemoteState(remotePayload, toastMessage) {
    if (!remotePayload?.save || typeof window.normalizeImportedState !== 'function') return;
    persistStateWithoutTouch(() => {
      state = window.normalizeImportedState(remotePayload.save);
      if (typeof window.ensureStateDefaults === 'function') {
        window.ensureStateDefaults();
      }
      const meta = ensureSyncMeta();
      meta.lastLocalChangeAt =
        remotePayload.save?.syncMeta?.lastLocalChangeAt ||
        remotePayload.clientUpdatedAt ||
        remotePayload.updatedAt ||
        meta.lastLocalChangeAt ||
        new Date().toISOString();
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

  async function pushLocalState(baseVersion, reason, attempt = 0) {
    const meta = ensureSyncMeta();
    const payload = {
      state,
      baseVersion: Number.isFinite(baseVersion) ? baseVersion : Number(meta.serverVersion || 0),
      clientUpdatedAt: meta.lastLocalChangeAt || new Date().toISOString()
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
      setSyncMessage(`Cloud save updated${reason ? ` (${reason})` : ''}`);
      return saved;
    } catch (error) {
      if (error.status === 409 && attempt < 1 && error.payload?.current) {
        const current = error.payload.current;
        if (hasRemoteNewerData(current)) {
          applyRemoteState(current, 'Loaded the newer cloud save.');
          setSyncMessage('Loaded newer cloud data');
          return current;
        }
        return pushLocalState(current.version, reason, attempt + 1);
      }
      throw error;
    }
  }

  async function syncNow(reason = 'manual') {
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
      const accountMismatch =
        authState.email &&
        localMeta.accountEmail &&
        localMeta.accountEmail !== authState.email;

      if (remoteHasState && (accountMismatch || hasRemoteNewerData(remote))) {
        applyRemoteState(remote, 'Loaded the newer cloud save.');
        setSyncMessage('Using newer data from the cloud');
        return remote;
      }

      if (!remoteHasState) {
        if (accountMismatch) {
          setSyncMessage('Cloud account is empty. Local data belongs to a different signed-in account on this device.');
          return remote;
        }
        if (hasMeaningfulStateData()) {
          return await pushLocalState(0, reason);
        }
        persistStateWithoutTouch(() => {
          const meta = ensureSyncMeta();
          markServerVersion(meta, remote);
          persistCurrentState();
        });
        setSyncMessage('Cloud account is ready');
        return remote;
      }

      const localSnapshot = getComparableSnapshot();
      const remoteSnapshot = getComparableSnapshot(remote.save);
      if (localSnapshot === remoteSnapshot) {
        persistStateWithoutTouch(() => {
          const meta = ensureSyncMeta();
          if (!meta.lastLocalChangeAt) {
            meta.lastLocalChangeAt =
              remote.save?.syncMeta?.lastLocalChangeAt ||
              remote.clientUpdatedAt ||
              remote.updatedAt ||
              new Date().toISOString();
          }
          markServerVersion(meta, remote);
          persistCurrentState();
        });
        setSyncMessage('Local and cloud data are in sync');
        return remote;
      }

      const remoteStamp = toMillis(
        remote.save?.syncMeta?.lastLocalChangeAt ||
          remote.clientUpdatedAt ||
          remote.updatedAt
      );
      const localStamp = toMillis(localMeta.lastLocalChangeAt);

      if (remoteStamp > localStamp) {
        applyRemoteState(remote, 'Loaded the newer cloud save.');
        setSyncMessage('Using newer data from the cloud');
        return remote;
      }

      return await pushLocalState(remote.version, reason);
    } catch (error) {
      if (error.status === 401) {
        authState.authenticated = false;
        authState.email = '';
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

  function scheduleSync(reason = 'auto') {
    if (!authState.cloudEnabled || !authState.authenticated) return;
    clearTimeout(syncTimer);
    syncTimer = window.setTimeout(() => {
      syncNow(reason).catch(() => {});
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
        await syncNow('startup');
      } else {
        setSyncMessage(authState.cloudEnabled ? 'Local-only mode' : 'Cloud sync unavailable');
      }
      maybeShowAuthPrompt();
    } catch (error) {
      authState.ready = true;
      authState.cloudEnabled = false;
      authState.authenticated = false;
      authState.email = '';
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
      setSyncMessage('Signed in. Checking cloud data...');
      updateAuthUI();
      if (typeof window.showToast === 'function') {
        window.showToast(successMessage, 'success');
      }
      await syncNow('auth');
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
        syncNow('online').catch(() => {});
      }
    });
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && authState.authenticated) {
        syncNow('resume').catch(() => {});
      }
    });
    window.setInterval(() => {
      if (authState.authenticated && !document.hidden) {
        syncNow('interval').catch(() => {});
      }
    }, 60000);
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
  window.syncNow = function syncNowFromUi() {
    return syncNow('manual').catch(() => {});
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initCloudSync, { once: true });
  } else {
    initCloudSync();
  }
})();
