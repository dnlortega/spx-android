(function (global) {
    'use strict';

    const REPOSITORY = 'dnlortega/spx-android';
    const RELEASES_API = `https://api.github.com/repos/${REPOSITORY}/releases/latest`;
    const METADATA_NAME = 'release-metadata.json';
    const MAX_APK_BYTES = 150 * 1024 * 1024;
    const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
    const SNOOZE_INTERVAL_MS = 24 * 60 * 60 * 1000;

    let currentVersion = '0.0.0';
    let currentVersionCode = 0;
    let latestCandidate = null;
    let checkInProgress = false;
    let updateInProgress = false;
    let updateSessionActive = false;
    let installed = false;

    function storageGet(key) {
        try { return global.localStorage.getItem(key); } catch (_) { return null; }
    }

    function storageSet(key, value) {
        try { global.localStorage.setItem(key, String(value)); } catch (_) {}
    }

    function parseVersion(value) {
        const match = String(value || '').trim().match(/^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/);
        if (!match) return null;
        const prerelease = match[4] ? match[4].split('.') : [];
        if (prerelease.some(part => !/^[0-9A-Za-z-]+$/.test(part))) return null;
        return { numbers: [Number(match[1]), Number(match[2]), Number(match[3])], prerelease };
    }

    function compareVersions(left, right) {
        const a = parseVersion(left);
        const b = parseVersion(right);
        if (!a || !b) return 0;
        for (let i = 0; i < 3; i++) {
            if (a.numbers[i] !== b.numbers[i]) return a.numbers[i] > b.numbers[i] ? 1 : -1;
        }
        if (a.prerelease.length === 0 || b.prerelease.length === 0) {
            return a.prerelease.length === b.prerelease.length ? 0 : (a.prerelease.length ? -1 : 1);
        }
        const length = Math.max(a.prerelease.length, b.prerelease.length);
        for (let i = 0; i < length; i++) {
            const av = a.prerelease[i];
            const bv = b.prerelease[i];
            if (av === undefined) return -1;
            if (bv === undefined) return 1;
            if (av === bv) continue;
            const an = /^\d+$/.test(av);
            const bn = /^\d+$/.test(bv);
            if (an && bn) return Number(av) > Number(bv) ? 1 : -1;
            if (an !== bn) return an ? -1 : 1;
            return av > bv ? 1 : -1;
        }
        return 0;
    }

    function isNewerVersion(remote, current) {
        return compareVersions(remote, current) > 0;
    }

    function normalizeSha256(value) {
        const hash = String(value || '').replace(/^sha256:/i, '').trim().toLowerCase();
        return /^[a-f0-9]{64}$/.test(hash) ? hash : '';
    }

    function isTrustedReleaseAssetUrl(value, apkOnly) {
        try {
            const url = new URL(value);
            if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) return false;
            if (url.port && url.port !== '443') return false;
            if (url.hostname.toLowerCase() !== 'github.com') return false;
            const parts = url.pathname.split('/');
            if (parts.length !== 7 || parts[0] !== '' || parts.slice(1).some(part => part === '')) return false;
            const segments = parts.slice(1).map(decodeURIComponent);
            return segments.length === 6 && segments[0] === REPOSITORY.split('/')[0] &&
                segments[1] === REPOSITORY.split('/')[1] && segments[2] === 'releases' &&
                segments[3] === 'download' && !!segments[4] && !/[\\/\u0000]/.test(segments[4]) &&
                !!segments[5] && !/[\\/\u0000]/.test(segments[5]) && (!apkOnly || /\.apk$/i.test(segments[5]));
        } catch (_) {
            return false;
        }
    }

    function isTrustedDownloadUrl(value) {
        return isTrustedReleaseAssetUrl(value, true);
    }

    function selectApkAsset(release, tag) {
        const assets = Array.isArray(release.assets) ? release.assets : [];
        const versionedName = `SPX-Route-OS-v${tag}.apk`;
        return assets.find(asset => asset && asset.name === versionedName && isTrustedDownloadUrl(asset.browser_download_url)) ||
            assets.find(asset => asset && asset.name === 'SPX-Route-OS.apk' && isTrustedDownloadUrl(asset.browser_download_url)) || null;
    }

    function validateReleaseMetadata(metadata, release, tag, metadataAsset) {
        if (!metadata || metadata.schemaVersion !== 1 || metadata.repository !== REPOSITORY) {
            throw new Error('Metadados da atualização inválidos.');
        }
        if (metadata.tagName !== release.tag_name || metadata.versionName !== tag || !parseVersion(tag)) {
            throw new Error('A versão informada não corresponde à Release.');
        }
        if (!Number.isSafeInteger(metadata.versionCode) || metadata.versionCode < 1) {
            throw new Error('Código de versão do APK inválido.');
        }
        if (!metadata.apk || metadata.apk.name !== `SPX-Route-OS-v${tag}.apk`) {
            throw new Error('Arquivo APK esperado não foi informado.');
        }
        const sha256 = normalizeSha256(metadata.apk.sha256);
        const size = metadata.apk.size;
        if (!sha256 || !Number.isSafeInteger(size) || size < 1 || size > MAX_APK_BYTES) {
            throw new Error('Tamanho ou checksum do APK inválido.');
        }
        const asset = selectApkAsset(release, tag);
        if (!asset || asset.name !== metadata.apk.name || !isTrustedDownloadUrl(asset.browser_download_url)) {
            throw new Error('APK da atualização não está disponível na Release.');
        }
        if (!isTrustedReleaseAssetUrl(metadataAsset.browser_download_url, false)) {
            throw new Error('Origem dos metadados não é confiável.');
        }
        const assetHash = normalizeSha256(asset.digest);
        if (assetHash && assetHash !== sha256) throw new Error('Checksum divergente na Release.');
        if (Number.isSafeInteger(asset.size) && asset.size !== size) throw new Error('Tamanho divergente na Release.');
        return { asset, versionCode: metadata.versionCode, versionName: tag, sha256, size };
    }

    async function fetchWithTimeout(url, options, timeoutMs) {
        let timer;
        try {
            return await Promise.race([
                fetch(url, options),
                new Promise((_, reject) => {
                    timer = setTimeout(() => reject(new Error('Tempo de conexão esgotado.')), timeoutMs);
                })
            ]);
        } finally {
            clearTimeout(timer);
        }
    }

    async function readResponseText(response, maxBytes, timeoutMs) {
        let timer;
        try {
            const text = await Promise.race([
                response.text(),
                new Promise((_, reject) => {
                    timer = setTimeout(() => reject(new Error('Tempo de leitura esgotado.')), timeoutMs);
                })
            ]);
            if (text.length > maxBytes) throw new Error('Resposta da atualização excede o limite.');
            return text;
        } finally {
            clearTimeout(timer);
        }
    }

    async function resolveCandidate(release) {
        if (!release || release.draft || release.prerelease) throw new Error('Release indisponível.');
        const tag = String(release.tag_name || '').replace(/^v/i, '').trim();
        if (!parseVersion(tag)) throw new Error('Versão da Release inválida.');
        const assets = Array.isArray(release.assets) ? release.assets : [];
        const metadataAsset = assets.find(asset => asset && asset.name === METADATA_NAME);
        if (metadataAsset) {
            if (!isTrustedReleaseAssetUrl(metadataAsset.browser_download_url, false)) throw new Error('Origem dos metadados não é confiável.');
            const response = await fetchWithTimeout(metadataAsset.browser_download_url, {
                headers: { 'Accept': 'application/json' }
            }, 12000);
            if (!response.ok) throw new Error('Não foi possível ler os metadados da atualização.');
            const text = await readResponseText(response, 64 * 1024, 12000);
            const verified = validateReleaseMetadata(JSON.parse(text), release, tag, metadataAsset);
            return { release, tag, ...verified, downloadUrl: verified.asset.browser_download_url };
        }
        const asset = selectApkAsset(release, tag);
        if (!asset) throw new Error('A Release não contém um APK compatível.');
        const sha256 = normalizeSha256(asset.digest);
        const size = Number.isSafeInteger(asset.size) ? asset.size : 0;
        if (!sha256 || size < 1 || size > MAX_APK_BYTES) {
            throw new Error('A Release não informa um checksum SHA-256 ou tamanho válido para o APK.');
        }
        return {
            release,
            tag,
            asset,
            versionCode: 0,
            versionName: tag,
            sha256,
            size,
            downloadUrl: asset.browser_download_url
        };
    }

    function candidateIsNewer(candidate) {
        if (!candidate) return false;
        if (candidate.versionCode > 0 && currentVersionCode > 0) return candidate.versionCode > currentVersionCode;
        return isNewerVersion(candidate.versionName, currentVersion);
    }

    function setElementText(id, value) {
        const element = document.getElementById(id);
        if (element) element.textContent = value;
    }

    function formatBytes(bytes) {
        if (!Number.isFinite(bytes) || bytes <= 0) return '';
        return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    }

    function showUpdateModal(candidate) {
        if (updateSessionActive) return;
        const modal = document.getElementById('updateModalOverlay');
        if (!modal) return;
        latestCandidate = candidate;
        installed = false;
        updateInProgress = false;
        updateSessionActive = false;
        setElementText('updateModalTag', `v${candidate.versionName}`);
        setElementText('updateModalCurrentTag', `v${currentVersion}`);
        setElementText('updateModalSize', formatBytes(candidate.size) ? ` · ${formatBytes(candidate.size)}` : '');
        setElementText('updateModalNotes', candidate.release.body || 'Correções e melhorias de rota.');
        setElementText('updateStatusText', 'Pronto para baixar e instalar.');
        setElementText('updateProgressPercent', '0%');
        const progress = document.getElementById('updateProgressBar');
        if (progress) progress.style.width = '0%';
        const progressBox = document.getElementById('updateProgressSection');
        if (progressBox) progressBox.classList.add('hidden');
        const action = document.getElementById('updateActionButton');
        if (action) {
            action.disabled = false;
            action.innerHTML = '<i data-lucide="download" class="w-4 h-4"></i> Atualizar agora';
        }
        const close = document.getElementById('updateCloseButton');
        if (close) {
            close.disabled = false;
            close.textContent = 'Lembrar mais tarde';
        }
        modal.classList.remove('hidden');
        if (global.lucide) global.lucide.createIcons();
    }

    function closeUpdateModal() {
        if (updateSessionActive) return;
        const modal = document.getElementById('updateModalOverlay');
        if (modal) modal.classList.add('hidden');
        if (!installed && latestCandidate) {
            storageSet('spx_update_snoozed_tag', latestCandidate.tag);
            storageSet('spx_update_snoozed_until', Date.now() + SNOOZE_INTERVAL_MS);
        }
    }

    function rememberCandidate(candidate) {
        storageSet('spx_update_pending', JSON.stringify({
            downloadUrl: candidate.downloadUrl,
            sha256: candidate.sha256,
            versionCode: candidate.versionCode,
            versionName: candidate.versionName,
            size: candidate.size,
            tag: candidate.tag,
            notes: String(candidate.release.body || '').slice(0, 64 * 1024)
        }));
    }

    function restoreCandidate() {
        try {
            const candidate = JSON.parse(storageGet('spx_update_pending') || 'null');
            if (!candidate || !parseVersion(candidate.versionName) || !isTrustedDownloadUrl(candidate.downloadUrl)) return;
            if (!Number.isSafeInteger(candidate.versionCode) || candidate.versionCode < 0 ||
                !Number.isSafeInteger(candidate.size) || candidate.size < 1 || candidate.size > MAX_APK_BYTES ||
                !normalizeSha256(candidate.sha256)) return;
            latestCandidate = {
                downloadUrl: candidate.downloadUrl,
                sha256: normalizeSha256(candidate.sha256),
                versionCode: candidate.versionCode,
                versionName: candidate.versionName,
                size: candidate.size,
                tag: candidate.tag,
                release: { body: String(candidate.notes || '') }
            };
        } catch (_) {}
    }

    async function checkForUpdates(isManualCheck) {
        if (checkInProgress || updateSessionActive) {
            if (isManualCheck && global.showToast) global.showToast('Aguarde a atualização em andamento.', 'info');
            return;
        }
        const now = Date.now();
        if (!isManualCheck) {
            const lastCheck = Number(storageGet('spx_update_checked_at')) || 0;
            if (now - lastCheck < CHECK_INTERVAL_MS) return;
        }
        checkInProgress = true;
        if (isManualCheck && global.showToast) global.showToast('Buscando atualizações...', 'info');
        try {
            const response = await fetchWithTimeout(RELEASES_API, {
                headers: { 'Accept': 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' }
            }, 12000);
            if (response.status === 404) {
                if (isManualCheck && global.showToast) global.showToast('Nenhuma atualização publicada ainda.', 'info');
                return;
            }
            if (response.status === 403 || response.status === 429) {
                throw new Error('O GitHub limitou as consultas. Tente novamente mais tarde.');
            }
            if (!response.ok) throw new Error(`Falha ao consultar atualizações (HTTP ${response.status}).`);
            const releaseText = await readResponseText(response, 256 * 1024, 12000);
            const candidate = await resolveCandidate(JSON.parse(releaseText));
            storageSet('spx_update_checked_at', now);
            const snoozedTag = storageGet('spx_update_snoozed_tag');
            const snoozedUntil = Number(storageGet('spx_update_snoozed_until')) || 0;
            if (!isManualCheck && snoozedTag === candidate.tag && now < snoozedUntil) return;
            if (candidateIsNewer(candidate)) {
                showUpdateModal(candidate);
            } else if (isManualCheck && global.showToast) {
                global.showToast(`Seu SPX Route OS já está na versão mais recente (${currentVersion}).`, 'success');
            }
        } catch (error) {
            if (isManualCheck && global.showToast) {
                global.showToast(error.message || 'Não foi possível verificar atualizações. Confira sua conexão.', 'error');
            }
        } finally {
            checkInProgress = false;
        }
    }

    function setUpdateProgress(stage, percent, message) {
        const modal = document.getElementById('updateModalOverlay');
        if (modal) modal.classList.remove('hidden');
        const progressBox = document.getElementById('updateProgressSection');
        if (progressBox) progressBox.classList.remove('hidden');
        const safePercent = Math.max(0, Math.min(100, Number(percent) || 0));
        setElementText('updateStatusText', message || 'Atualizando...');
        setElementText('updateProgressPercent', `${Math.round(safePercent)}%`);
        const progress = document.getElementById('updateProgressBar');
        if (progress) progress.style.width = `${safePercent}%`;
        if (global.lucide) global.lucide.createIcons();
    }

    function handleNativeEvent(event) {
        if (!event || typeof event !== 'object') return;
        if (latestCandidate) {
            setElementText('updateModalTag', `v${latestCandidate.versionName}`);
            setElementText('updateModalCurrentTag', `v${currentVersion}`);
            setElementText('updateModalSize', formatBytes(latestCandidate.size) ? ` · ${formatBytes(latestCandidate.size)}` : '');
            setElementText('updateModalNotes', latestCandidate.release.body || 'Correções e melhorias de rota.');
        }
        if (event.stage === 'installed') {
            installed = true;
            updateInProgress = false;
            updateSessionActive = false;
            if (latestCandidate) {
                currentVersion = latestCandidate.versionName;
                currentVersionCode = latestCandidate.versionCode;
            }
            storageSet('spx_update_pending', '');
            setUpdateProgress('installed', 100, event.message || 'Atualização instalada com sucesso.');
            const action = document.getElementById('updateActionButton');
            if (action) {
                action.disabled = false;
                action.innerHTML = '<i data-lucide="check" class="w-4 h-4"></i> Concluir';
            }
            const close = document.getElementById('updateCloseButton');
            if (close) {
                close.disabled = false;
                close.textContent = 'Fechar';
            }
            if (global.showToast) global.showToast(event.message || 'Atualização instalada com sucesso.', 'success');
            return;
        }
        if (event.stage === 'already_current') {
            updateInProgress = false;
            updateSessionActive = false;
            storageSet('spx_update_pending', '');
            closeUpdateModal();
            if (global.showToast) global.showToast(event.message || 'O aplicativo já está atualizado.', 'info');
            return;
        }
        updateSessionActive = ['permission_required', 'downloading', 'validating', 'installing'].includes(event.stage);
        updateInProgress = ['downloading', 'validating', 'installing'].includes(event.stage);
        setUpdateProgress(event.stage, event.percent, event.message);
        const action = document.getElementById('updateActionButton');
        if (action) {
            action.disabled = updateInProgress;
            action.innerHTML = updateInProgress
                ? '<i data-lucide="refresh-cw" class="w-4 h-4 animate-spin"></i> Atualizando...'
                : event.stage === 'permission_required'
                    ? '<i data-lucide="settings" class="w-4 h-4"></i> Autorizar instalação'
                    : '<i data-lucide="refresh-cw" class="w-4 h-4"></i> Tentar novamente';
        }
        const close = document.getElementById('updateCloseButton');
        if (close) {
            close.disabled = updateSessionActive;
            close.textContent = updateSessionActive ? 'Atualização em andamento' : 'Lembrar mais tarde';
        }
        if (event.stage === 'error' && global.showToast) global.showToast(event.message || 'Falha na atualização.', 'error');
    }

    function triggerAppUpdate() {
        if (updateInProgress) return;
        if (installed) { closeUpdateModal(); return; }
        if (!latestCandidate) return;
        const bridge = global.SPXAndroid;
        if (bridge && typeof bridge.installApk === 'function') {
            rememberCandidate(latestCandidate);
            updateInProgress = true;
            updateSessionActive = true;
            const action = document.getElementById('updateActionButton');
            if (action) action.disabled = true;
            const close = document.getElementById('updateCloseButton');
            if (close) {
                close.disabled = true;
                close.textContent = 'Atualização em andamento';
            }
            setUpdateProgress('downloading', 0, 'Preparando atualização...');
            try {
                bridge.installApk(
                    latestCandidate.downloadUrl,
                    latestCandidate.sha256,
                    latestCandidate.versionCode,
                    latestCandidate.versionName,
                    latestCandidate.size
                );
            } catch (_) {
                handleNativeEvent({ stage: 'error', percent: 0, message: 'Não foi possível iniciar a atualização.' });
            }
            return;
        }
        const opened = global.open(latestCandidate.downloadUrl, '_blank', 'noopener,noreferrer');
        if (!opened && global.showToast) global.showToast('Não foi possível abrir o download da atualização.', 'error');
        closeUpdateModal();
    }

    function init() {
        const bridge = global.SPXAndroid;
        if (bridge) {
            if (typeof bridge.getAppVersion === 'function') currentVersion = bridge.getAppVersion() || currentVersion;
            if (typeof bridge.getAppVersionCode === 'function') currentVersionCode = Number(bridge.getAppVersionCode()) || 0;
        }
        restoreCandidate();
    }

    global.SPXUpdate = {
        init,
        check: checkForUpdates,
        handleNativeEvent,
        parseVersion,
        compareVersions,
        isNewerVersion,
        isTrustedDownloadUrl,
        selectApkAsset,
        validateReleaseMetadata,
        resolveCandidate
    };
    global.checkForUpdates = checkForUpdates;
    global.closeUpdateModal = closeUpdateModal;
    global.triggerAppUpdate = triggerAppUpdate;
})(window);
