(function () {
    'use strict';

    const CONFIG_KEY = 'gantt_online_connection_v1';
    const CACHE_PREFIX = 'gantt_online_workspace_v1:';
    const INDEX_PATH = 'profiles/index.json';
    const MAX_FILE_BYTES = 900000;

    function requireValue(condition, message) {
        if (!condition) throw new Error(message);
    }
    function clone(value) { return JSON.parse(JSON.stringify(value)); }
    function stable(value) {
        if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']';
        if (value && typeof value === 'object') {
            return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + stable(value[key])).join(',') + '}';
        }
        return JSON.stringify(value);
    }
    function same(left, right) { return stable(left) === stable(right); }
    function isObject(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
    function validId(id) {
        return typeof id === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/.test(id) &&
            !['__proto__', 'prototype', 'constructor', 'index'].includes(id);
    }
    function validDate(value) {
        if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
        const parts = value.split('-').map(Number);
        const date = new Date(parts[0], parts[1] - 1, parts[2], 12);
        return date.getFullYear() === parts[0] && date.getMonth() === parts[1] - 1 && date.getDate() === parts[2];
    }
    function validTime(value) {
        return typeof value === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value);
    }
    function escapeText(value) {
        return String(value == null ? '' : value).replace(/[&<>"']/g, char =>
            ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
    }
    function sanitizeRichText(value) {
        requireValue(window.DOMPurify && window.DOMPurify.isSupported, 'The local rich-text sanitizer did not load. Restore online_assets before using the tracker.');
        return window.DOMPurify.sanitize(String(value || ''), {
            ALLOWED_TAGS: ['p', 'br', 'div', 'span', 'b', 'strong', 'i', 'em', 'u', 's', 'ul', 'ol', 'li',
                'blockquote', 'h1', 'h2', 'h3', 'h4', 'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td'],
            ALLOWED_ATTR: [], ALLOW_DATA_ATTR: false, ALLOW_ARIA_ATTR: false
        });
    }
    function emptyData() {
        return { projects: [], tasks: {}, todos: {}, settings: { sound: true, digestTime: '18:00' } };
    }
    function normalizeData(input) {
        requireValue(isObject(input) && Array.isArray(input.projects) && isObject(input.tasks), 'Invalid tracker data: projects and tasks are required.');
        requireValue(input.todos === undefined || isObject(input.todos), 'Invalid To Do data.');
        const output = emptyData();
        const projectIds = new Set();
        output.projects = input.projects.map(project => {
            requireValue(isObject(project) && validId(project.id) && !projectIds.has(project.id), 'Invalid or duplicate project ID.');
            requireValue(typeof project.name === 'string' && project.name.trim(), 'Each project needs a name.');
            requireValue(validDate(project.startDate), 'Invalid project start date.');
            requireValue(project.description == null || typeof project.description === 'string', 'Invalid project description.');
            requireValue(project.countWeekends === undefined || typeof project.countWeekends === 'boolean', 'Invalid weekend setting.');
            projectIds.add(project.id);
            return {
                id: project.id, name: project.name, description: sanitizeRichText(project.description),
                startDate: project.startDate, countWeekends: project.countWeekends !== false
            };
        });
        output.projects.forEach(project => {
            const tasks = input.tasks[project.id] || [];
            requireValue(Array.isArray(tasks), 'Invalid task list for ' + project.name + '.');
            const ids = new Set();
            output.tasks[project.id] = tasks.map(task => {
                requireValue(isObject(task) && validId(task.id) && !ids.has(task.id), 'Invalid or duplicate task ID.');
                requireValue(typeof task.name === 'string' && task.name.trim(), 'Each task needs a name.');
                requireValue(Number.isSafeInteger(task.startDay) && task.startDay >= 0 &&
                    Number.isSafeInteger(task.duration) && task.duration >= 0, 'Invalid task dates or duration.');
                requireValue(task.indent === undefined || (Number.isSafeInteger(task.indent) && task.indent >= 0), 'Invalid task hierarchy.');
                requireValue(task.progress === undefined || (Number.isFinite(task.progress) && task.progress >= 0 && task.progress <= 100), 'Invalid task progress.');
                requireValue(task.description == null || typeof task.description === 'string', 'Invalid task description.');
                ids.add(task.id);
                return {
                    id: task.id, name: task.name, description: sanitizeRichText(task.description),
                    startDay: task.startDay, duration: task.duration, indent: task.indent || 0,
                    isMilestone: !!task.isMilestone, isParent: !!task.isParent,
                    progress: task.progress || 0, isManualProgress: !!task.isManualProgress,
                    progressSymbol: task.progressSymbol === '*' ? '*' : '\u00a4'
                };
            });
        });
        const todoIds = new Set();
        Object.entries(input.todos || {}).forEach(([date, list]) => {
            requireValue(validDate(date) && Array.isArray(list), 'Invalid To Do date or list.');
            output.todos[date] = list.map(item => {
                requireValue(isObject(item) && validId(item.id) && !todoIds.has(item.id), 'Invalid or duplicate To Do ID.');
                requireValue(typeof item.text === 'string' && item.text.trim(), 'Each To Do item needs text.');
                requireValue(!item.time || validTime(item.time), 'Invalid reminder time.');
                requireValue(!item.projectId || validId(item.projectId), 'Invalid project tag.');
                requireValue(item.snoozeUntil == null || (Number.isFinite(item.snoozeUntil) && item.snoozeUntil >= 0), 'Invalid snooze time.');
                requireValue(item.icsSeq === undefined || (Number.isSafeInteger(item.icsSeq) && item.icsSeq >= 0), 'Invalid calendar sequence.');
                todoIds.add(item.id);
                return {
                    id: item.id, text: item.text, done: !!item.done, time: item.time || null,
                    projectId: item.projectId || null, notified: !!item.notified,
                    snoozeUntil: item.snoozeUntil || null, icsSeq: item.icsSeq || 0
                };
            });
            if (!output.todos[date].length) delete output.todos[date];
        });
        if (input.settings !== undefined) {
            requireValue(isObject(input.settings), 'Invalid profile settings.');
            requireValue(input.settings.sound === undefined || typeof input.settings.sound === 'boolean', 'Invalid sound setting.');
            requireValue(input.settings.digestTime === undefined || input.settings.digestTime === '' || validTime(input.settings.digestTime), 'Invalid wrap-up time.');
            output.settings.sound = input.settings.sound !== false;
            output.settings.digestTime = input.settings.digestTime === undefined ? '18:00' : input.settings.digestTime;
        }
        return output;
    }
    function normalizeDocument(input, expectedId) {
        requireValue(isObject(input) && input.schemaVersion === 1 && isObject(input.profile), 'Unsupported profile file format.');
        requireValue(validId(input.profile.id) && (!expectedId || input.profile.id === expectedId), 'Unexpected profile file ID.');
        requireValue(typeof input.profile.name === 'string' && input.profile.name.trim() && input.profile.name.length <= 120, 'Invalid profile name (maximum 120 characters).');
        return { schemaVersion: 1, profile: { id: input.profile.id, name: input.profile.name.trim() }, data: normalizeData(input.data) };
    }
    function normalizeIndex(input) {
        requireValue(isObject(input) && input.schemaVersion === 1 && Array.isArray(input.profiles), 'Unsupported cloud profile index.');
        requireValue(input.profiles.every(validId) && new Set(input.profiles).size === input.profiles.length, 'Invalid cloud profile index IDs.');
        return { schemaVersion: 1, profiles: input.profiles.slice() };
    }
    function makeId() {
        const bytes = new Uint8Array(16);
        crypto.getRandomValues(bytes);
        return 'p-' + Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
    }
    function documentFor(profile) {
        return { schemaVersion: 1, profile: { id: profile.id, name: profile.name }, data: clone(profile.data) };
    }
    function cachedProfile(document, sha, registered) {
        return {
            id: document.profile.id, name: document.profile.name, data: document.data, view: {},
            baseSha: sha || null, baseValue: sha ? clone(document) : null,
            registered: !!registered, conflict: null, remotePending: false
        };
    }
    function freshState(data) {
        const profile = cachedProfile({ schemaVersion: 1, profile: { id: makeId(), name: 'Default' }, data: data || emptyData() });
        return { schemaVersion: 1, activeProfileId: profile.id, profiles: [profile], manifestKnown: false, recovery: [] };
    }
    function normalizeState(input) {
        requireValue(isObject(input) && input.schemaVersion === 1 && Array.isArray(input.profiles) && input.profiles.length, 'Invalid browser cache. Export its recovery copy before clearing it.');
        const ids = new Set();
        const profiles = input.profiles.map(item => {
            const doc = normalizeDocument(documentFor(item));
            requireValue(!ids.has(doc.profile.id), 'Duplicate cached profile ID.');
            ids.add(doc.profile.id);
            requireValue(item.baseSha == null || (typeof item.baseSha === 'string' && /^[a-f0-9]{40,64}$/.test(item.baseSha)), 'Invalid cached file version.');
            const profile = cachedProfile(doc, item.baseSha, item.registered);
            profile.baseValue = item.baseValue ? normalizeDocument(item.baseValue, profile.id) : null;
            requireValue((profile.baseSha === null) === (profile.baseValue === null), 'Incomplete cached sync version.');
            profile.view = isObject(item.view) ? clone(item.view) : {};
            if (item.conflict) profile.conflict = {
                sha: item.conflict.sha || null,
                value: item.conflict.value ? normalizeDocument(item.conflict.value, profile.id) : null
            };
            return profile;
        });
        requireValue(Array.isArray(input.recovery || []), 'Invalid recovery cache.');
        return {
            schemaVersion: 1, profiles, activeProfileId: ids.has(input.activeProfileId) ? input.activeProfileId : profiles[0].id,
            manifestKnown: !!input.manifestKnown,
            recovery: (input.recovery || []).map(entry => {
                requireValue(isObject(entry) && typeof entry.savedAt === 'string', 'Invalid recovery snapshot.');
                return { savedAt: entry.savedAt, reason: String(entry.reason || ''), document: normalizeDocument(entry.document) };
            })
        };
    }
    function normalizeConfig(input) {
        requireValue(isObject(input), 'Enter the GitHub repository details.');
        const owner = String(input.owner || '').trim(), repo = String(input.repo || '').trim(), branch = String(input.branch || '').trim();
        requireValue(/^[a-zA-Z0-9][a-zA-Z0-9-]{0,99}$/.test(owner), 'Enter a GitHub owner, not a URL.');
        requireValue(/^[a-zA-Z0-9_.-]+$/.test(repo) && !['.', '..'].includes(repo), 'Enter a repository name, not a URL.');
        requireValue(branch && branch.length <= 255 && !/[\x00-\x20?#]/.test(branch), 'Enter the existing data repository branch.');
        return { owner, repo, branch };
    }
    function cacheKey(config) {
        return CACHE_PREFIX + (config ? [config.owner.toLowerCase(), config.repo.toLowerCase(), config.branch].map(encodeURIComponent).join(':') : 'local');
    }
    function loadLegacy(storage) {
        const v37 = storage.getItem('gantt_v37'), v36 = storage.getItem('gantt_v36');
        if (!v37 && !v36) return emptyData();
        const input = normalizeData(JSON.parse(v37 || v36));
        if (!v37) input.projects.forEach(project => {
            if (project.countWeekends !== false) return;
            input.tasks[project.id].forEach(task => {
                if (task.isParent || task.isMilestone || !task.duration) return;
                const start = new Date(project.startDate + 'T12:00:00');
                start.setDate(start.getDate() + task.startDay);
                let working = 0, calendar = 0;
                while (working < task.duration) {
                    if (start.getDay() !== 0 && start.getDay() !== 6) working++;
                    calendar++; start.setDate(start.getDate() + 1);
                }
                task.duration = calendar;
            });
        });
        input.settings = {
            sound: storage.getItem('todo_sound_v1') !== 'off',
            digestTime: storage.getItem('todo_digest_v1') === null ? '18:00' : storage.getItem('todo_digest_v1')
        };
        return normalizeData(input);
    }
    function hasContent(profile) {
        return profile.name !== 'Default' || profile.data.projects.length > 0 || Object.values(profile.data.todos).some(list => list.length > 0);
    }
    function encodeContent(value) {
        const bytes = new TextEncoder().encode(JSON.stringify(value, null, 2));
        requireValue(bytes.length <= MAX_FILE_BYTES, 'This profile exceeds the 900,000-byte cloud file limit. It is still local; split it into smaller profiles or export a backup.');
        let binary = '';
        for (let offset = 0; offset < bytes.length; offset += 8192) binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
        return btoa(binary);
    }
    function decodeContent(value) {
        const binary = atob(value.replace(/\s/g, ''));
        return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(binary, char => char.charCodeAt(0))));
    }
    class GitHubError extends Error {
        constructor(message, status, retryAt) {
            super(message);
            this.status = status; this.retryAt = retryAt || 0;
            this.retryable = !status || status >= 500 || !!retryAt;
        }
    }
    class GitHubClient {
        #token;
        constructor(config, token) {
            this.config = normalizeConfig(config);
            requireValue(typeof token === 'string' && /^github_pat_[a-zA-Z0-9_]+$/.test(token.trim()), 'Enter a fine-grained GitHub PAT (github_pat_...).');
            this.#token = token.trim(); this.cache = new Map(); this.queue = Promise.resolve(); this.lastWrite = 0;
        }
        clearToken() { this.#token = ''; this.cache.clear(); }
        request(suffix, options) {
            const result = this.queue.then(() => this.performRequest(suffix, options || {}));
            this.queue = result.catch(() => undefined);
            return result;
        }
        async performRequest(suffix, options) {
            requireValue(this.#token, 'Reconnect with a GitHub token.');
            if (options.method === 'PUT') {
                const wait = 1100 - (Date.now() - this.lastWrite);
                if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait));
                this.lastWrite = Date.now();
            }
            const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 20000);
            let response, responseText = '';
            try {
                response = await fetch('https://api.github.com/repos/' + encodeURIComponent(this.config.owner) + '/' + encodeURIComponent(this.config.repo) + suffix, {
                    method: options.method || 'GET',
                    headers: Object.assign({
                        Accept: 'application/vnd.github+json', Authorization: 'Bearer ' + this.#token,
                        'X-GitHub-Api-Version': '2022-11-28'
                    }, options.body ? { 'Content-Type': 'application/json' } : {}, options.headers || {}),
                    body: options.body ? JSON.stringify(options.body) : undefined,
                    cache: 'no-store', credentials: 'omit', redirect: 'error', signal: controller.signal
                });
                if (response.status !== 304) responseText = await response.text();
            } catch (error) {
                throw new GitHubError(error.name === 'AbortError' ? 'GitHub timed out. Changes remain local and will retry.' : 'GitHub could not be reached. Changes remain local and will retry.');
            } finally { clearTimeout(timeout); }
            if (response.status === 304 || (response.status === 404 && options.allowMissing)) return response;
            if (!response.ok) {
                let message = 'GitHub request failed (' + response.status + ').';
                if (response.status === 401) message = 'GitHub rejected the token. Reconnect with a valid, unexpired PAT.';
                else if (response.status === 403) message = 'GitHub denied access. Check Contents: read/write, repository access, organization approval, and branch rules.';
                else if (response.status === 404) message = 'GitHub repository or branch is missing or inaccessible to this token.';
                else if (response.status === 409) message = 'GitHub changed during upload. Local changes have not been discarded.';
                else if (response.status === 422) message = 'GitHub rejected the write. Check token permissions and branch rules.';
                const retryAfter = Number(response.headers.get('retry-after')), reset = Number(response.headers.get('x-ratelimit-reset'));
                let retryAt = 0;
                if (retryAfter > 0) retryAt = Date.now() + retryAfter * 1000;
                else if (response.headers.get('x-ratelimit-remaining') === '0' && reset > 0) retryAt = reset * 1000 + 1000;
                else if ([403, 429].includes(response.status) && /rate limit/i.test(responseText)) retryAt = Date.now() + 60000;
                if (retryAt) message = 'GitHub rate limit reached. Changes remain local; sync will resume after ' + new Date(retryAt).toLocaleTimeString() + '.';
                throw new GitHubError(message, response.status, retryAt);
            }
            return new Response(responseText, { status: response.status, headers: response.headers });
        }
        async validateAccess() {
            const response = await this.request(''), repo = await response.json();
            requireValue(repo.private === true, 'The data repository must be private. Personal data will not be uploaded to a public repository.');
            await this.request('/branches/' + encodeURIComponent(this.config.branch));
        }
        async readFile(path) {
            const cached = this.cache.get(path);
            const response = await this.request('/contents/' + path.split('/').map(encodeURIComponent).join('/') + '?ref=' + encodeURIComponent(this.config.branch), {
                headers: cached && cached.etag ? { 'If-None-Match': cached.etag } : {}, allowMissing: true
            });
            if (response.status === 304) return clone(cached.value);
            if (response.status === 404) { this.cache.delete(path); return null; }
            const content = await response.json();
            requireValue(content.type === 'file' && content.encoding === 'base64' && typeof content.content === 'string', 'Unsupported GitHub file. Profile JSON must be smaller than 1 MB.');
            requireValue(typeof content.sha === 'string' && /^[a-f0-9]{40,64}$/.test(content.sha), 'GitHub returned an invalid file version.');
            const value = { sha: content.sha, value: decodeContent(content.content) };
            this.cache.set(path, { etag: response.headers.get('etag'), value: clone(value) });
            return value;
        }
        async writeFile(path, value, sha, message) {
            const body = { message, content: encodeContent(value), branch: this.config.branch };
            if (sha) body.sha = sha;
            const response = await this.request('/contents/' + path.split('/').map(encodeURIComponent).join('/'), { method: 'PUT', body });
            const result = await response.json();
            requireValue(result.content && typeof result.content.sha === 'string', 'GitHub did not confirm the saved version. Sync will check before retrying.');
            this.cache.delete(path);
            return result.content.sha;
        }
    }
    class Store {
        constructor(options) {
            options = options || {};
            this.storage = options.storage || window.localStorage;
            this.onChange = options.onChange || (() => {}); this.onStatus = options.onStatus || (() => {});
            this.canApplyRemote = options.canApplyRemote || (() => true);
            this.config = null; this.client = null; this.ready = false; this.blocked = false;
            this.startupError = null; this.storageError = null; this.running = null; this.connecting = false;
            this.timer = null; this.pollTimer = null; this.retryAt = 0; this.failures = 0;
            this.error = null; this.paused = false; this.syncAgain = false;
            try {
                const rawConfig = this.storage.getItem(CONFIG_KEY);
                this.config = rawConfig ? normalizeConfig(JSON.parse(rawConfig)) : null;
                this.key = cacheKey(this.config);
                const raw = this.storage.getItem(this.key);
                this.state = raw ? normalizeState(JSON.parse(raw)) : freshState(this.config ? emptyData() : loadLegacy(this.storage));
            } catch (error) {
                this.startupError = error; this.blocked = true; this.key = this.key || cacheKey(null); this.state = freshState();
            }
            this.refreshSavedValues();
        }
        refreshSavedValues() {
            this.savedValues = new Map(this.state.profiles.map(profile => [profile.id, stable(documentFor(profile))]));
        }
        current() { return this.state.profiles.find(profile => profile.id === this.state.activeProfileId); }
        isDirty(profile) { return !profile.baseValue || !same(documentFor(profile), profile.baseValue); }
        pendingCount() { return this.state.profiles.filter(profile => this.isDirty(profile) || !profile.registered).length; }
        status() {
            const conflicts = this.state.profiles.filter(profile => profile.conflict);
            let label;
            if (this.startupError || this.blocked) label = 'Editing blocked';
            else if (this.storageError) label = 'Local save failed';
            else if (conflicts.length) label = 'Needs attention';
            else if (this.error) label = 'Sync error';
            else if (!this.client) label = this.config ? 'Reconnect GitHub' : 'Saved locally';
            else if (navigator.onLine === false) label = 'Offline - saved locally';
            else if (this.running || this.connecting) label = 'Syncing...';
            else if (this.state.profiles.some(profile => profile.remotePending)) label = 'Cloud update waiting';
            else if (this.pendingCount()) label = 'Changes pending';
            else label = 'Synced';
            return {
                label, pending: this.pendingCount(), conflicts, connected: !!this.client, config: this.config,
                error: this.startupError || this.storageError || this.error, blocked: this.blocked
            };
        }
        emit() { this.onStatus(this.status()); }
        persist() {
            if (!this.ready || this.blocked) return;
            try {
                this.storage.setItem(this.key, JSON.stringify(this.state)); this.storageError = null;
            } catch (error) {
                this.storageError = new Error('Browser storage could not save your changes. Export all profiles before closing this tab. ' + error.message);
                this.emit(); throw this.storageError;
            }
        }
        async start() {
            if (this.startupError) { this.emit(); return; }
            if (!navigator.locks) {
                this.blocked = true;
                this.error = new Error('This browser lacks safe multi-tab locking. Use a current Chrome, Edge, Firefox, or Safari browser.');
                this.emit(); return;
            }
            await new Promise((resolve, reject) => {
                navigator.locks.request('gantt_online_workspace_writer_v1', { ifAvailable: true }, async lock => {
                    if (!lock) {
                        this.blocked = true;
                        this.error = new Error('Another tracker tab is editing this browser workspace. Close that tab, then reload this one.');
                        this.emit(); resolve(); return;
                    }
                    try {
                        const raw = this.storage.getItem(this.key);
                        if (raw) { this.state = normalizeState(JSON.parse(raw)); this.refreshSavedValues(); }
                        this.ready = true; this.persist();
                    } catch (error) { this.blocked = true; this.error = error; this.emit(); reject(error); return; }
                    this.onChange({ reason: 'start', id: this.state.activeProfileId });
                    this.emit(); resolve();
                    await new Promise(release => { this.releaseLock = release; });
                }).catch(reject);
            });
            if (!this.ready || this.blocked) return;
            this.pollTimer = setInterval(() => { if (!document.hidden) this.schedule(0); }, 30000);
            this.onFocus = () => { if (!document.hidden) this.schedule(0); };
            this.onOnline = () => { if (!this.paused) { this.retryAt = 0; this.schedule(0); } this.emit(); };
            this.onOffline = () => this.emit();
            window.addEventListener('focus', this.onFocus); document.addEventListener('visibilitychange', this.onFocus);
            window.addEventListener('online', this.onOnline); window.addEventListener('offline', this.onOffline);
        }
        stop() {
            clearTimeout(this.timer); clearInterval(this.pollTimer);
            if (this.releaseLock) this.releaseLock();
            window.removeEventListener('focus', this.onFocus); document.removeEventListener('visibilitychange', this.onFocus);
            window.removeEventListener('online', this.onOnline); window.removeEventListener('offline', this.onOffline);
            if (this.client) this.client.clearToken();
            this.client = null;
        }
        requireEditable() { requireValue(this.ready && !this.blocked && !this.startupError, 'The tracker is not ready for editing.'); }
        saveCurrent(data, view) {
            this.requireEditable();
            const profile = this.current(); profile.data = normalizeData(data);
            if (view) Object.assign(profile.view, view);
            const value = stable(documentFor(profile)), changed = this.savedValues.get(profile.id) !== value;
            this.persist(); this.savedValues.set(profile.id, value);
            if (changed) this.schedule();
            this.emit(); return profile.data;
        }
        setView(key, value) { this.requireEditable(); this.current().view[key] = value; this.persist(); }
        setActive(id) {
            this.requireEditable();
            requireValue(this.state.profiles.some(profile => profile.id === id), 'Profile not found.');
            this.state.activeProfileId = id; this.persist();
            this.onChange({ reason: 'profile', id }); this.emit(); this.schedule(0);
        }
        addProfile(name, data) {
            this.requireEditable();
            const doc = normalizeDocument({ schemaVersion: 1, profile: { id: makeId(), name }, data: data || emptyData() });
            const profile = cachedProfile(doc);
            this.state.profiles.push(profile); this.savedValues.set(profile.id, stable(doc));
            this.state.activeProfileId = profile.id; this.persist();
            this.onChange({ reason: 'profile', id: profile.id }); this.schedule(); this.emit();
            return profile.id;
        }
        renameCurrent(name) {
            this.requireEditable();
            const profile = this.current(), doc = normalizeDocument({ schemaVersion: 1, profile: { id: profile.id, name }, data: profile.data });
            profile.name = doc.profile.name; this.persist(); this.savedValues.set(profile.id, stable(doc));
            this.schedule(); this.emit();
        }
        async connect(input, token, includeLocal) {
            this.requireEditable();
            const config = normalizeConfig(input), client = new GitHubClient(config, token);
            this.connecting = true; clearTimeout(this.timer); this.emit();
            try {
                if (this.running) await this.running;
                await client.validateAccess();
                const key = cacheKey(config), existing = this.storage.getItem(key);
                let state;
                if (existing) state = normalizeState(JSON.parse(existing));
                else {
                    const remoteIndex = await client.readFile(INDEX_PATH);
                    const ids = remoteIndex ? normalizeIndex(remoteIndex.value).profiles : [];
                    state = { schemaVersion: 1, profiles: [], activeProfileId: null, manifestKnown: !!remoteIndex, recovery: [] };
                    for (const id of ids) {
                        const remote = await client.readFile('profiles/' + id + '.json');
                        requireValue(remote, 'The cloud index references a missing profile: ' + id + '. Restore its file from GitHub history.');
                        state.profiles.push(cachedProfile(normalizeDocument(remote.value, id), remote.sha, true));
                    }
                    if (includeLocal) this.state.profiles.filter(hasContent).forEach(profile => {
                        const doc = documentFor(profile); doc.profile.id = makeId();
                        if (ids.length) doc.profile.name = doc.profile.name.slice(0, 104) + ' (local import)';
                        state.profiles.push(cachedProfile(doc));
                    });
                    if (!state.profiles.length) { state = freshState(); state.manifestKnown = !!remoteIndex; }
                    state.activeProfileId = state.profiles[0].id;
                }
                this.storage.setItem(key, JSON.stringify(state)); this.storage.setItem(CONFIG_KEY, JSON.stringify(config));
                if (this.client) this.client.clearToken();
                this.client = client; this.config = config; this.key = key; this.state = state;
                this.refreshSavedValues(); this.error = null; this.paused = false; this.retryAt = 0; this.failures = 0;
                this.onChange({ reason: 'connection', id: state.activeProfileId });
            } catch (error) { client.clearToken(); throw error; }
            finally { this.connecting = false; this.emit(); this.schedule(0); }
        }
        async disconnect() {
            clearTimeout(this.timer); this.connecting = true;
            try { if (this.running) await this.running; }
            finally {
                if (this.client) this.client.clearToken();
                this.client = null; this.error = null; this.paused = false; this.connecting = false; this.emit();
            }
        }
        schedule(delay) {
            clearTimeout(this.timer);
            if (!this.ready || this.blocked || !this.client || this.connecting || this.paused) return;
            if (navigator.onLine === false) { this.emit(); return; }
            const wait = Math.max(delay === undefined ? 2000 : delay, this.retryAt - Date.now(), 0);
            this.timer = setTimeout(() => { this.sync().catch(error => this.reportError(error)); }, wait);
        }
        retry() { this.paused = false; this.retryAt = 0; this.schedule(0); }
        reportError(error) {
            this.error = error; this.failures++; this.paused = !(error instanceof GitHubError && error.retryable);
            if (!this.paused) {
                this.retryAt = Math.max(error.retryAt || 0, Date.now() + Math.min(120000, 10000 * Math.pow(2, Math.min(this.failures - 1, 4))));
                this.schedule(0);
            }
            console.error('Tracker sync:', error.message); this.emit();
        }
        sync() {
            if (this.running) { this.syncAgain = true; return this.running; }
            if (!this.ready || this.blocked || !this.client || this.connecting || this.paused || navigator.onLine === false || Date.now() < this.retryAt) return Promise.resolve();
            this.running = this.performSync(this.client).then(() => {
                this.error = null; this.failures = 0; this.retryAt = 0;
            }).finally(() => {
                this.running = null; this.emit();
                if (this.syncAgain) { this.syncAgain = false; this.schedule(); }
            });
            this.emit(); return this.running;
        }
        async performSync(client) {
            const remoteIndex = await client.readFile(INDEX_PATH);
            requireValue(remoteIndex || !this.state.manifestKnown, 'The cloud profile index disappeared. Restore profiles/index.json from GitHub history; local data is preserved.');
            const index = remoteIndex ? normalizeIndex(remoteIndex.value) : { schemaVersion: 1, profiles: [] };
            requireValue(!this.state.profiles.some(profile => profile.registered && !index.profiles.includes(profile.id)), 'A profile was removed from the cloud index outside the app. Restore the index from GitHub history before syncing.');
            for (const id of index.profiles) {
                const cached = this.state.profiles.find(profile => profile.id === id);
                if (cached) { if (cached.baseSha) cached.registered = true; continue; }
                const remote = await client.readFile('profiles/' + id + '.json');
                requireValue(remote, 'The cloud index references a missing profile: ' + id + '. Restore it from GitHub history.');
                const profile = cachedProfile(normalizeDocument(remote.value, id), remote.sha, true);
                this.state.profiles.push(profile); this.savedValues.set(id, stable(documentFor(profile)));
                this.persist(); this.emit();
            }
            for (const profile of this.state.profiles.slice()) {
                if (this.isDirty(profile) || !profile.registered || profile.id === this.state.activeProfileId || profile.conflict) await this.syncProfile(client, profile);
            }
            const uploaded = this.state.profiles.filter(profile => profile.baseSha && !profile.registered).map(profile => profile.id);
            if (uploaded.length || !remoteIndex) await this.registerProfiles(client, uploaded);
            this.state.manifestKnown = true; this.persist();
        }
        async syncProfile(client, profile) {
            const path = 'profiles/' + profile.id + '.json', remoteFile = await client.readFile(path);
            const remote = remoteFile ? normalizeDocument(remoteFile.value, profile.id) : null, local = documentFor(profile);
            if (!remote && (profile.baseSha || profile.registered)) {
                profile.conflict = { sha: null, value: null }; this.persist(); this.emit(); return;
            }
            if (remote && same(local, remote)) { this.acceptRemote(profile, remote, remoteFile.sha, false); return; }
            if (profile.conflict) {
                profile.conflict = { sha: remoteFile ? remoteFile.sha : null, value: remote }; this.persist(); this.emit(); return;
            }
            const remoteChanged = remoteFile && remoteFile.sha !== profile.baseSha;
            if (remoteChanged && this.isDirty(profile) && (!profile.baseValue || !same(remote, profile.baseValue))) {
                profile.conflict = { sha: remoteFile.sha, value: remote }; this.persist(); this.emit(); return;
            }
            if (remoteChanged && !this.isDirty(profile)) {
                if (!this.canApplyRemote(profile.id)) { profile.remotePending = true; this.emit(); return; }
                this.acceptRemote(profile, remote, remoteFile.sha, true); return;
            }
            if (remoteChanged) { profile.baseSha = remoteFile.sha; profile.baseValue = clone(remote); this.persist(); }
            if (!this.isDirty(profile)) return;
            const snapshot = documentFor(profile);
            let sha;
            try { sha = await client.writeFile(path, snapshot, remoteFile ? remoteFile.sha : null, 'Update tracker profile'); }
            catch (error) {
                if (!(error instanceof GitHubError) || ![409, 422].includes(error.status)) throw error;
                client.cache.delete(path);
                if (error.status === 422) {
                    const latest = await client.readFile(path);
                    if (!latest || (remoteFile && latest.sha === remoteFile.sha)) throw error;
                }
                this.syncAgain = true; return;
            }
            // Edits made during this request remain pending against the uploaded snapshot.
            profile.baseSha = sha; profile.baseValue = snapshot; profile.remotePending = false;
            this.persist();
            if (this.isDirty(profile)) this.syncAgain = true;
            this.emit();
        }
        acceptRemote(profile, value, sha, replace) {
            if (replace) {
                profile.name = value.profile.name; profile.data = clone(value.data);
                this.savedValues.set(profile.id, stable(documentFor(profile)));
            }
            profile.baseSha = sha; profile.baseValue = clone(value); profile.conflict = null; profile.remotePending = false;
            this.persist();
            if (replace && profile.id === this.state.activeProfileId) this.onChange({ reason: 'remote', id: profile.id });
            this.emit();
        }
        async registerProfiles(client, ids) {
            for (let attempt = 0; attempt < 3; attempt++) {
                const latest = await client.readFile(INDEX_PATH);
                requireValue(latest || !this.state.manifestKnown, 'The cloud index was removed during sync. Restore it from GitHub history.');
                const value = latest ? normalizeIndex(latest.value) : { schemaVersion: 1, profiles: [] };
                const merged = { schemaVersion: 1, profiles: Array.from(new Set(value.profiles.concat(ids))) };
                if (!latest || !same(value, merged)) {
                    try { await client.writeFile(INDEX_PATH, merged, latest ? latest.sha : null, 'Register tracker profiles'); }
                    catch (error) {
                        if (!(error instanceof GitHubError) || ![409, 422].includes(error.status)) throw error;
                        client.cache.delete(INDEX_PATH);
                        if (error.status === 422 && latest) throw error;
                        continue;
                    }
                }
                this.state.profiles.forEach(profile => { if (merged.profiles.includes(profile.id)) profile.registered = true; });
                this.state.manifestKnown = true; this.persist(); return;
            }
            throw new GitHubError('The profile index changed repeatedly. Local profiles are safe; registration will retry.', 503);
        }
        resolveConflict(id, choice) {
            this.requireEditable();
            const profile = this.state.profiles.find(item => item.id === id);
            requireValue(profile && profile.conflict, 'This conflict is no longer pending.');
            requireValue(['local', 'remote', 'both'].includes(choice), 'Choose a recovery action.');
            const conflict = clone(profile.conflict);
            requireValue(conflict.value || choice === 'local', 'The cloud file was deleted. Restore the local copy or download it for recovery.');
            const local = documentFor(profile);
            const saveRecovery = (doc, reason) => this.state.recovery.push({ savedAt: new Date().toISOString(), reason, document: clone(doc) });
            if (choice === 'local') {
                if (conflict.value) saveRecovery(conflict.value, 'Cloud version before choosing local');
                profile.baseSha = conflict.sha; profile.baseValue = conflict.value; profile.conflict = null;
                if (!conflict.value) profile.registered = false;
            } else {
                saveRecovery(local, 'Local version before choosing cloud');
                if (choice === 'both') {
                    local.profile.id = makeId(); local.profile.name = local.profile.name.slice(0, 96) + ' (recovered local)';
                    this.state.profiles.push(cachedProfile(local)); this.state.activeProfileId = local.profile.id;
                }
                this.acceptRemote(profile, conflict.value, conflict.sha, true);
            }
            this.persist(); this.onChange({ reason: 'recovery', id: this.state.activeProfileId }); this.emit(); this.schedule(0);
        }
        exportBackup() {
            return { schemaVersion: 1, kind: 'tracker-profile-backup', profiles: this.state.profiles.map(documentFor), recovery: clone(this.state.recovery) };
        }
        rawRecovery() { return { cacheKey: this.key, content: this.storage.getItem(this.key) }; }
        importBackup(input, replaceCurrent) {
            this.requireEditable();
            if (input && input.kind === 'tracker-profile-backup') {
                requireValue(input.schemaVersion === 1 && Array.isArray(input.profiles) && input.profiles.length, 'Invalid all-profiles backup.');
                const documents = input.profiles.map(item => normalizeDocument(item));
                requireValue(input.recovery === undefined || Array.isArray(input.recovery), 'Invalid backup recovery list.');
                const recovery = (input.recovery || []).map(entry => {
                    requireValue(isObject(entry) && typeof entry.savedAt === 'string', 'Invalid backup recovery snapshot.');
                    return { savedAt: entry.savedAt, reason: String(entry.reason || ''), document: normalizeDocument(entry.document) };
                });
                documents.forEach(doc => { doc.profile.id = makeId(); this.state.profiles.push(cachedProfile(doc)); });
                this.state.recovery.push(...recovery); this.state.activeProfileId = documents[0].profile.id;
                this.refreshSavedValues(); this.persist();
                this.onChange({ reason: 'import', id: this.state.activeProfileId }); this.emit(); this.schedule(); return;
            }
            const doc = input && input.schemaVersion === 1 && input.profile ? normalizeDocument(input)
                : { schemaVersion: 1, profile: { id: makeId(), name: 'Imported' }, data: normalizeData(input) };
            if (!replaceCurrent) { this.addProfile(doc.profile.name, doc.data); return; }
            const profile = this.current();
            this.state.recovery.push({ savedAt: new Date().toISOString(), reason: 'Before importing into current profile', document: documentFor(profile) });
            profile.data = doc.data; this.saveCurrent(profile.data); this.onChange({ reason: 'import', id: profile.id });
        }
    }
    window.TrackerOnline = {
        Store, GitHubClient, GitHubError, normalizeData, normalizeDocument, normalizeIndex, sanitizeRichText,
        escapeText, emptyData, documentFor, encodeContent, decodeContent, cacheKey, same, MAX_FILE_BYTES
    };
})();
