'use strict';

const onlineFileLinks = new Map();
const onlineShownConflicts = new Set();
let onlineConflictId = null;
let onlineProfileOptions = '';
let onlineFileError = '';
let onlineOfflineError = '';
let onlineWorkerRegistration = null;
let onlineUpdating = false;

const onlineStore = new TrackerOnline.Store({
    onChange: applyOnlineProfile,
    onStatus: renderOnlineToolbar,
    canApplyRemote: id => !onlineUiBusy(id)
});

function readOnlineView(key, fallback) {
    const value = onlineStore.current().view[key];
    return value === undefined ? fallback : value;
}

function writeOnlineView(key, value) {
    try { onlineStore.setView(key, value); }
    catch (error) { showOnlineError(error); }
}

function showOnlineError(error) {
    console.error('Tracker:', error.message);
    const message = document.getElementById('online-message');
    if (message) { message.textContent = error.message; message.classList.remove('hidden'); }
}

function persistOnlineData() {
    try {
        data = onlineStore.saveCurrent(data, {
            activeProjectId, viewMode: currentViewMode, todoDate, todoLastProj
        });
        return true;
    } catch (error) { showOnlineError(error); return false; }
}

function onlineUiBusy(id) {
    if (id && id !== onlineStore.state.activeProfileId) return false;
    if (['task-modal', 'todo-edit-modal', 'github-modal', 'cloud-conflict-modal', 'online-recovery-modal']
        .some(name => {
            const modal = document.getElementById(name);
            return modal && !modal.classList.contains('hidden');
        })) return true;
    const focused = document.activeElement;
    if (focused && (focused.isContentEditable || (focused.matches('input, textarea') && focused.value))) return true;
    const input = document.getElementById('todo-input');
    return !!(input && input.value.trim()) || document.body.style.cursor === 'grabbing' ||
        document.body.style.cursor === 'ew-resize' || document.body.style.cursor === 'col-resize';
}

function applyOnlineProfile(change) {
    const profile = onlineStore.current();
    data = profile.data;
    activeProjectId = profile.view.activeProjectId || 'overview';
    if (!['overview', 'todo'].includes(activeProjectId) && !data.projects.some(project => project.id === activeProjectId)) activeProjectId = 'overview';
    currentViewMode = profile.view.viewMode === 'summary' ? 'summary' : 'gantt';
    const zoom = profile.view.zoom;
    zoomLevel = ['day', 'week', 'month'].includes(zoom) ? zoom : 'day';
    dayWidth = zoomLevel === 'day' ? 40 : zoomLevel === 'week' ? 10 : 4;
    TOTAL_GANTT_DAYS = zoomLevel === 'day' ? 90 : zoomLevel === 'week' ? 365 : 1095;
    sidebarWidth = Number.isFinite(profile.view.sidebarWidth) ? Math.max(0, Math.min(500, profile.view.sidebarWidth)) : 256;
    taskPanelWidth = Number.isFinite(profile.view.taskPanelWidth) ? Math.max(0, Math.min(1000, profile.view.taskPanelWidth)) : 520;
    lastSidebarWidth = profile.view.lastSidebarWidth || 256;
    lastTaskPanelWidth = profile.view.lastTaskPanelWidth || 520;
    if (change.reason !== 'remote') {
        closeModal();
        closeTodoEditModal();
        dismissAllReminders();
        todoDate = profile.view.todoDate || null;
        todoLastProj = profile.view.todoLastProj || '';
        todoDueSig = null;
        todoLastDay = null;
    }
    render();
    updateOnlineLocalFileButton();
    queueOnlineLocalFile(profile.id);
    renderOnlineToolbar(onlineStore.status());
}

function renderOnlineToolbar(status) {
    const select = document.getElementById('profile-select');
    if (!select) return;
    document.body.classList.toggle('online-starting', !onlineStore.ready && !status.blocked);
    document.body.classList.toggle('online-blocked', status.blocked);
    document.body.classList.toggle('online-save-failed', !!onlineStore.storageError);
    document.getElementById('tracker-shell').inert = !onlineStore.ready || status.blocked || !!onlineStore.storageError;
    const signature = JSON.stringify(onlineStore.state.profiles.map(profile => [profile.id, profile.name]));
    if (signature !== onlineProfileOptions) {
        select.replaceChildren(...onlineStore.state.profiles.map(profile => {
            const option = document.createElement('option');
            option.value = profile.id; option.textContent = profile.name;
            return option;
        }));
        onlineProfileOptions = signature;
    }
    select.value = onlineStore.state.activeProfileId;
    select.disabled = status.blocked || !onlineStore.ready;
    const button = document.getElementById('online-status');
    button.textContent = status.label;
    button.className = 'px-3 py-1.5 rounded text-xs font-semibold ' +
        (status.error || status.conflicts.length ? 'bg-amber-900 text-amber-200' :
            status.label === 'Synced' ? 'bg-green-900 text-green-300' : 'bg-gray-800 text-gray-300');
    button.title = status.config ? status.config.owner + '/' + status.config.repo + ' - ' + status.config.branch : 'Local browser workspace';
    document.getElementById('online-pending').textContent = status.config && status.pending ? status.pending + ' profile(s) pending' : '';
    document.getElementById('github-connect-button').textContent = status.connected ? 'GitHub settings' : 'Connect GitHub';
    document.getElementById('online-retry').classList.toggle('hidden', !status.error || !status.connected || status.blocked);
    document.getElementById('online-recovery-button').classList.toggle('hidden', onlineStore.state.recovery.length === 0);
    const message = document.getElementById('online-message');
    const explanation = status.error ? status.error.message : status.blocked ? 'Editing is blocked. Close other tracker tabs and reload.' :
        status.conflicts.length ? 'Local and GitHub versions differ. Click Needs attention to recover your changes; editing can continue locally.' :
        onlineFileError || onlineOfflineError;
    message.textContent = explanation || '';
    message.classList.toggle('hidden', !explanation);
    const conflict = status.conflicts.find(profile => profile.id === onlineStore.state.activeProfileId) || status.conflicts[0];
    if (conflict && !onlineUiBusy() && !onlineShownConflicts.has(conflict.id + ':' + conflict.conflict.sha)) {
        openOnlineConflict(conflict.id);
    }
}

function onlineAllowProfileChange() {
    if (!onlineUiBusy()) return true;
    return confirm('There may be unsaved text in an editor or the add-item box. Discard that text and switch profiles? Saved changes will stay in their current profile.');
}

function switchOnlineProfile(id) {
    if (!onlineAllowProfileChange()) { renderOnlineToolbar(onlineStore.status()); return; }
    try { onlineStore.setActive(id); } catch (error) { showOnlineError(error); }
}

function createOnlineProfile() {
    if (!onlineAllowProfileChange()) return;
    const name = prompt('New profile name:', 'New profile');
    if (name === null) return;
    try { onlineStore.addProfile(name); } catch (error) { showOnlineError(error); }
}

function renameOnlineProfile() {
    const name = prompt('Profile name:', onlineStore.current().name);
    if (name === null) return;
    try { onlineStore.renameCurrent(name); } catch (error) { showOnlineError(error); }
}

function openOnlineStatus() {
    const conflicts = onlineStore.status().conflicts;
    if (conflicts.length) openOnlineConflict(conflicts.find(profile => profile.id === onlineStore.state.activeProfileId)?.id || conflicts[0].id);
    else if (onlineStore.blocked) alert((onlineStore.status().error?.message || 'Close other tracker tabs.') + '\n\nReload this tab after resolving the problem.');
    else openGitHubModal();
}

function openGitHubModal() {
    if (!onlineStore.ready || onlineStore.blocked) {
        alert(onlineStore.status().error?.message || 'The browser workspace is still starting. Please wait.');
        return;
    }
    if (location.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(location.hostname)) {
        showOnlineError(new Error('Open the HTTPS version of this website before entering a GitHub token.'));
        return;
    }
    const config = onlineStore.config || {};
    document.getElementById('github-owner').value = config.owner || '';
    document.getElementById('github-repo').value = config.repo || '';
    document.getElementById('github-branch').value = config.branch || 'main';
    document.getElementById('github-token').value = '';
    document.getElementById('github-include-local').checked = !onlineStore.config && onlineStore.state.profiles.some(profile =>
        profile.data.projects.length || Object.values(profile.data.todos).some(list => list.length));
    document.getElementById('github-modal-error').classList.add('hidden');
    document.getElementById('github-disconnect').classList.toggle('hidden', !onlineStore.client);
    document.getElementById('github-modal').classList.remove('hidden');
    document.getElementById(config.owner ? 'github-token' : 'github-owner').focus();
}

function closeGitHubModal() {
    if (onlineStore.connecting) return;
    document.getElementById('github-token').value = '';
    document.getElementById('github-modal').classList.add('hidden');
}

async function connectOnlineGitHub(event) {
    event.preventDefault();
    const draft = document.getElementById('todo-input');
    if (draft && draft.value.trim() && !confirm('Connecting reloads the selected workspace. Discard the unsaved text in the add-item box? Saved items are kept.')) return;
    const fields = document.getElementById('github-fields'), errorBox = document.getElementById('github-modal-error');
    fields.disabled = true;
    errorBox.classList.add('hidden');
    let token = document.getElementById('github-token').value;
    document.getElementById('github-token').value = '';
    try {
        await onlineStore.connect({
            owner: document.getElementById('github-owner').value,
            repo: document.getElementById('github-repo').value,
            branch: document.getElementById('github-branch').value
        }, token, document.getElementById('github-include-local').checked);
        closeGitHubModal();
    } catch (error) {
        console.error('GitHub connection:', error.message);
        errorBox.textContent = error.message; errorBox.classList.remove('hidden');
    } finally { token = ''; fields.disabled = false; }
}

async function disconnectOnlineGitHub() {
    const fields = document.getElementById('github-fields');
    fields.disabled = true;
    try { await onlineStore.disconnect(); closeGitHubModal(); }
    catch (error) { showOnlineError(error); }
    finally { fields.disabled = false; }
}

function onlineFileName(name) {
    return String(name).replace(/[^a-zA-Z0-9_-]+/g, '_').slice(0, 80) || 'profile';
}

function downloadOnlineJSON(value, filename) {
    const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url; link.download = filename; document.body.appendChild(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function exportAllOnlineProfiles() {
    try {
        downloadOnlineJSON(onlineStore.startupError ? onlineStore.rawRecovery() : onlineStore.exportBackup(), 'Tracker_All_Profiles_Backup.json');
    } catch (error) { showOnlineError(error); }
}

async function importOnlineFile(event) {
    const file = event.target.files[0];
    if (!file) return;
    try {
        const input = JSON.parse(await file.text());
        const all = input.kind === 'tracker-profile-backup';
        if (!confirm(all ? 'Import all profiles as NEW profiles? Existing work will not be replaced.' :
            'Import this backup as a NEW profile? Your current profile will not be replaced.')) return;
        onlineStore.importBackup(input, false);
    } catch (error) { alert('Import failed: ' + error.message); console.error('Tracker import:', error.message); }
    finally { event.target.value = ''; }
}

function openOnlineConflict(id) {
    const profile = onlineStore.state.profiles.find(item => item.id === id);
    if (!profile?.conflict) return;
    onlineConflictId = id;
    onlineShownConflicts.add(id + ':' + profile.conflict.sha);
    document.getElementById('cloud-conflict-description').textContent = profile.conflict.value
        ? '"' + profile.name + '" has local edits and newer GitHub changes. Keep both creates a separate recovered-local profile.'
        : '"' + profile.name + '" is missing on GitHub. Restore the local version to recreate the private file.';
    const summary = value => {
        if (!value) return 'File missing';
        const tasks = Object.values(value.data.tasks).reduce((total, list) => total + list.length, 0);
        const todos = Object.values(value.data.todos).reduce((total, list) => total + list.length, 0);
        return value.profile.name + '\n' + value.data.projects.length + ' projects, ' + tasks + ' tasks, ' + todos + ' To Do items';
    };
    document.getElementById('cloud-conflict-summary').textContent = 'LOCAL\n' + summary(TrackerOnline.documentFor(profile)) +
        '\n\nGITHUB\n' + summary(profile.conflict.value);
    document.getElementById('conflict-both').disabled = !profile.conflict.value;
    document.getElementById('conflict-remote').disabled = !profile.conflict.value;
    document.getElementById('cloud-conflict-modal').classList.remove('hidden');
}

function closeOnlineConflict() {
    onlineConflictId = null;
    document.getElementById('cloud-conflict-modal').classList.add('hidden');
}

function resolveOnlineConflict(choice) {
    if (choice === 'local' && !confirm('Use the current local version to replace the GitHub version? The previous cloud snapshot is retained locally in Recovery.')) return;
    const id = onlineConflictId;
    closeOnlineConflict();
    try { onlineStore.resolveConflict(id, choice); } catch (error) { showOnlineError(error); }
}

function downloadOnlineConflict() {
    const profile = onlineStore.state.profiles.find(item => item.id === onlineConflictId);
    if (!profile?.conflict) return;
    downloadOnlineJSON({
        schemaVersion: 1, kind: 'tracker-profile-backup',
        profiles: [TrackerOnline.documentFor(profile)].concat(profile.conflict.value ? [profile.conflict.value] : [])
    }, onlineFileName(profile.name) + '_local_and_cloud.json');
}

function openOnlineRecovery() {
    const list = document.getElementById('online-recovery-list');
    list.replaceChildren(...onlineStore.state.recovery.map((entry, index) => {
        const button = document.createElement('button');
        button.className = 'text-left bg-gray-900 border border-gray-700 rounded p-3 text-sm hover:border-blue-500';
        button.textContent = entry.document.profile.name + ' - ' + new Date(entry.savedAt).toLocaleString() + '\n' + entry.reason;
        button.onclick = () => {
            try {
                document.getElementById('online-recovery-modal').classList.add('hidden');
                const snapshot = onlineStore.state.recovery[index].document;
                onlineStore.addProfile(snapshot.profile.name.slice(0, 108) + ' (restored)', snapshot.data);
            } catch (error) { showOnlineError(error); }
        };
        return button;
    }));
    document.getElementById('online-recovery-modal').classList.remove('hidden');
}

function onlineLinkKey(id) { return onlineStore.key + ':' + id; }

function updateOnlineLocalFileButton() {
    const button = document.getElementById('btn-sync');
    if (!button) return;
    const linked = onlineFileLinks.has(onlineLinkKey(onlineStore.current().id));
    button.textContent = linked ? 'Local file: ON' : 'Local file';
    button.title = linked ? 'Auto-writing this profile to its linked JSON file. Click to unlink.' : 'Link a separate local JSON file for this profile (Chrome / Edge).';
    button.className = 'px-3 py-1.5 rounded text-xs font-semibold ' + (linked ? 'bg-green-700 hover:bg-green-600' : 'bg-indigo-600 hover:bg-indigo-500');
}

async function toggleOnlineLocalFile() {
    const profile = onlineStore.current(), key = onlineLinkKey(profile.id);
    const existing = onlineFileLinks.get(key);
    if (existing) {
        existing.latest = null;
        if (existing.pending) await existing.pending;
        onlineFileLinks.delete(key); updateOnlineLocalFileButton(); return;
    }
    if (!window.showSaveFilePicker) { alert('Linked local-file writing requires Chrome or Edge. JSON backup downloads still work in other browsers.'); return; }
    try {
        const handle = await window.showSaveFilePicker({
            suggestedName: onlineFileName(profile.name) + '_live.json',
            types: [{ description: 'Tracker profile JSON', accept: { 'application/json': ['.json'] } }]
        });
        for (const [otherKey, entry] of onlineFileLinks) {
            if (otherKey !== key && await handle.isSameEntry(entry.handle)) throw new Error('That file is already linked to another profile. Choose a separate JSON file so their data stays separate.');
        }
        onlineFileLinks.set(key, { handle, latest: null, pending: null });
        onlineFileError = ''; updateOnlineLocalFileButton(); await queueOnlineLocalFile(profile.id);
    } catch (error) {
        if (error.name !== 'AbortError') { onlineFileError = 'Local-file link failed: ' + error.message; showOnlineError(new Error(onlineFileError)); }
    }
}

function queueOnlineLocalFile(id) {
    const key = onlineLinkKey(id), entry = onlineFileLinks.get(key);
    const profile = onlineStore.state.profiles.find(item => item.id === id);
    if (!entry || !profile) return Promise.resolve();
    entry.latest = JSON.stringify(TrackerOnline.documentFor(profile), null, 2);
    if (entry.pending) return entry.pending;
    entry.pending = (async () => {
        try {
            while (entry.latest !== null) {
                const text = entry.latest; entry.latest = null;
                const writable = await entry.handle.createWritable();
                await writable.write(text); await writable.close();
            }
            onlineFileError = '';
        } catch (error) {
            if (onlineFileLinks.get(key) === entry) onlineFileLinks.delete(key);
            onlineFileError = 'Local-file save failed for "' + profile.name + '": ' + error.message + '. Re-link its file. Browser and GitHub saving are separate.';
            console.error('Tracker local file:', error.message);
        } finally {
            entry.pending = null; updateOnlineLocalFileButton(); renderOnlineToolbar(onlineStore.status());
        }
    })();
    return entry.pending;
}

async function registerOnlineOfflineCache() {
    const badge = document.getElementById('offline-cache-state');
    if (location.protocol === 'file:') { badge.textContent = 'Local copy'; return; }
    if (!navigator.serviceWorker) {
        onlineOfflineError = 'Offline page caching is unavailable in this browser. Keep the tab open or use the downloaded local copy when offline.';
        renderOnlineToolbar(onlineStore.status()); return;
    }
    try {
        onlineWorkerRegistration = await navigator.serviceWorker.register('gantt_online_sw.js', { scope: './gantt_online.html', updateViaCache: 'none' });
        const inspect = () => {
            if (onlineWorkerRegistration.active) badge.textContent = 'Offline ready';
            else badge.textContent = 'Preparing offline copy...';
            document.getElementById('online-update-button').classList.toggle('hidden', !onlineWorkerRegistration.waiting);
        };
        inspect();
        onlineWorkerRegistration.addEventListener('updatefound', () => {
            const worker = onlineWorkerRegistration.installing;
            if (worker) worker.addEventListener('statechange', () => {
                inspect();
                if (worker.state === 'redundant' && !onlineWorkerRegistration.active) {
                    onlineOfflineError = 'Offline page caching failed. Reopen while online or use the downloaded local copy.';
                    renderOnlineToolbar(onlineStore.status());
                }
            });
        });
        navigator.serviceWorker.ready.then(inspect);
        navigator.serviceWorker.addEventListener('controllerchange', () => { if (onlineUpdating) location.reload(); });
    } catch (error) {
        onlineOfflineError = 'Offline page caching failed: ' + error.message + '. The downloaded local copy remains usable.';
        renderOnlineToolbar(onlineStore.status());
    }
}

function applyOnlineUpdate() {
    if (!onlineWorkerRegistration?.waiting) return;
    if (onlineStore.config && onlineStore.pendingCount() && !confirm('Some edits are not synced yet. They remain in the browser cache, but you must reconnect after reloading. Update now?')) return;
    try {
        onlineStore.persist(); onlineUpdating = true;
        onlineWorkerRegistration.waiting.postMessage({ type: 'ACTIVATE_UPDATE' });
    } catch (error) { showOnlineError(error); }
}

async function startOnlineTracker() {
    try {
        await onlineStore.start();
        renderOnlineToolbar(onlineStore.status());
        if (onlineStore.ready && !onlineStore.blocked) {
            checkReminders();
            registerOnlineOfflineCache();
            if (onlineStore.config) openGitHubModal();
        }
    } catch (error) { showOnlineError(error); }
    window.addEventListener('beforeunload', event => {
        if (!onlineUpdating && ((onlineStore.config && onlineStore.pendingCount()) ||
            Array.from(onlineFileLinks.values()).some(entry => entry.pending))) {
            event.preventDefault(); event.returnValue = '';
        }
    });
    document.addEventListener('focusout', () => {
        setTimeout(() => {
            if (!onlineUiBusy()) {
                renderOnlineToolbar(onlineStore.status());
                if (onlineStore.state.profiles.some(profile => profile.remotePending)) onlineStore.schedule(0);
            }
        }, 100);
    });
}
