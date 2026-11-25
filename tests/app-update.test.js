'use strict';

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../app/src/main/assets/js/app-update.js'), 'utf8');
const elements = new Map();
const storage = new Map();
let sandbox;
let update;
let toasts;

function element(id) {
    if (!elements.has(id)) {
        const classes = new Set();
        elements.set(id, {
            id,
            textContent: '',
            innerHTML: '',
            disabled: false,
            style: {},
            classList: {
                add: (...names) => names.forEach(name => classes.add(name)),
                remove: (...names) => names.forEach(name => classes.delete(name)),
                toggle: (name, force) => {
                    const enabled = force === undefined ? !classes.has(name) : !!force;
                    if (enabled) classes.add(name); else classes.delete(name);
                    return enabled;
                },
                contains: name => classes.has(name)
            }
        });
    }
    return elements.get(id);
}

beforeEach(function () {
    elements.clear();
    storage.clear();
    toasts = [];
    sandbox = {
        console,
        URL,
        setTimeout,
        clearTimeout,
        fetch: async () => { throw new Error('Fetch inesperado no teste'); },
        localStorage: {
            getItem: key => storage.has(key) ? storage.get(key) : null,
            setItem: (key, value) => storage.set(key, String(value))
        },
        document: { getElementById: element },
        open: () => true,
        showToast: message => toasts.push(message)
    };
    sandbox.window = sandbox;
    vm.runInNewContext(source, sandbox, { filename: 'app-update.js' });
    update = sandbox.SPXUpdate;
});

function release(version = '1.3.0') {
    const tag = `v${version}`;
    return {
        tag_name: tag,
        draft: false,
        prerelease: false,
        body: '<img src=x onerror=alert(1)>',
        assets: [
            {
                name: 'release-metadata.json',
                browser_download_url: `https://github.com/dnlortega/spx-android/releases/download/${tag}/release-metadata.json`,
                size: 500
            },
            {
                name: 'SPX-Route-OS.apk',
                browser_download_url: `https://github.com/dnlortega/spx-android/releases/download/${tag}/SPX-Route-OS.apk`,
                size: 2048
            },
            {
                name: `SPX-Route-OS-${tag}.apk`,
                browser_download_url: `https://github.com/dnlortega/spx-android/releases/download/${tag}/SPX-Route-OS-${tag}.apk`,
                size: 2048,
                digest: 'sha256:' + 'a'.repeat(64)
            }
        ]
    };
}

function metadata(version = '1.3.0', versionCode = 8) {
    return {
        schemaVersion: 1,
        repository: 'dnlortega/spx-android',
        tagName: `v${version}`,
        versionName: version,
        versionCode,
        apk: { name: `SPX-Route-OS-v${version}.apk`, size: 2048, sha256: 'a'.repeat(64), signerSha256: 'c'.repeat(64) }
    };
}

async function presentUpdate(options = {}) {
    const version = options.version || '1.3.0';
    const versionCode = options.versionCode || 8;
    const data = release(version);
    const releaseMetadata = metadata(version, versionCode);
    releaseMetadata.apk.signerSha256 = options.signer || 'c'.repeat(64);
    sandbox.fetch = async url => ({
        ok: true,
        status: 200,
        text: async () => JSON.stringify(url.includes('/releases?') ? [data] : releaseMetadata)
    });
    sandbox.SPXAndroid = {
        getAppVersion: () => '1.2.0',
        getAppVersionCode: () => 7,
        getAppSignerSha256: () => 'c'.repeat(64),
        ...options.bridge
    };
    update.init();
    await update.check(true);
    return { data, releaseMetadata };
}

test('versão semântica compara release e pré-release corretamente', function () {
    assert.equal(update.compareVersions('1.10.0', '1.9.9'), 1);
    assert.equal(update.compareVersions('v1.3.0', '1.3.0'), 0);
    assert.equal(update.compareVersions('1.3.0-rc.2', '1.3.0-rc.10'), -1);
    assert.equal(update.compareVersions('1.3.0-rc.1', '1.3.0'), -1);
    assert.equal(update.compareVersions('1.3', '1.3.0'), 0);
    assert.equal(update.isNewerVersion('1.3.0', '1.2.0'), true);
});

test('download aceita somente APK da Release confiável', function () {
    const valid = 'https://github.com/dnlortega/spx-android/releases/download/v1.3.0/SPX-Route-OS-v1.3.0.apk';
    assert.equal(update.isTrustedDownloadUrl(valid), true);
    assert.equal(update.isTrustedDownloadUrl('http://github.com/dnlortega/spx-android/releases/download/v1.3.0/app.apk'), false);
    assert.equal(update.isTrustedDownloadUrl('https://github.com.evil.test/dnlortega/spx-android/releases/download/v1.3.0/app.apk'), false);
    assert.equal(update.isTrustedDownloadUrl('https://user@github.com/dnlortega/spx-android/releases/download/v1.3.0/app.apk'), false);
    assert.equal(update.isTrustedDownloadUrl(valid + '?download=1'), false);
    assert.equal(update.isTrustedDownloadUrl('https://github.com/dnlortega/spx-android/releases/download/v1.3.0/app.json'), false);
    assert.equal(update.isTrustedDownloadUrl('https://github.com/other/spx-android/releases/download/v1.3.0/app.apk'), false);
});

test('seleção prefere o APK versionado e ignora arquivos não confiáveis', function () {
    const data = release();
    assert.equal(update.selectApkAsset(data, '1.3.0').name, 'SPX-Route-OS-v1.3.0.apk');
    data.assets[2].browser_download_url = 'https://example.com/app.apk';
    assert.equal(update.selectApkAsset(data, '1.3.0').name, 'SPX-Route-OS.apk');
});

test('metadados validam versão, tamanho e checksum do APK', function () {
    const data = release();
    const verified = update.validateReleaseMetadata(metadata(), data, '1.3.0', data.assets[0]);
    assert.equal(verified.versionCode, 8);
    assert.equal(verified.sha256, 'a'.repeat(64));
    assert.equal(verified.size, 2048);

    const wrongVersion = metadata();
    wrongVersion.versionName = '1.2.9';
    assert.throws(() => update.validateReleaseMetadata(wrongVersion, data, '1.3.0', data.assets[0]), /não corresponde/);

    const wrongSize = metadata();
    wrongSize.apk.size = 4096;
    assert.throws(() => update.validateReleaseMetadata(wrongSize, data, '1.3.0', data.assets[0]), /Tamanho divergente/);

    const wrongHash = metadata();
    wrongHash.apk.sha256 = 'b'.repeat(64);
    assert.throws(() => update.validateReleaseMetadata(wrongHash, data, '1.3.0', data.assets[0]), /Checksum divergente/);
});

test('resolução lê metadados e rejeita release em rascunho', async function () {
    const data = release();
    const fetches = [];
    sandbox.fetch = async url => {
        fetches.push(url);
        return { ok: true, text: async () => JSON.stringify(metadata()) };
    };
    const candidate = await update.resolveCandidate(data);
    assert.equal(candidate.versionCode, 8);
    assert.equal(candidate.downloadUrl, data.assets[2].browser_download_url);
    assert.equal(fetches.length, 1);
    await assert.rejects(() => update.resolveCandidate({ ...data, draft: true }), /indisponível/);
    const prerelease = await update.resolveCandidate({ ...data, prerelease: true });
    assert.equal(prerelease.versionCode, 8);
});

test('resolução exige checksum e tamanho mesmo sem metadados', async function () {
    const data = release();
    data.assets = data.assets.filter(asset => asset.name !== 'release-metadata.json');
    delete data.assets[1].digest;
    await assert.rejects(() => update.resolveCandidate(data), /checksum SHA-256/);
    data.assets[1].digest = 'sha256:' + 'a'.repeat(64);
    const candidate = await update.resolveCandidate(data);
    assert.equal(candidate.sha256, 'a'.repeat(64));
    assert.equal(candidate.size, 2048);
    assert.equal(candidate.versionCode, 0);
});

test('notas da Release são inseridas como texto sem HTML executável', function () {
    const data = release();
    update.validateReleaseMetadata(metadata(), data, '1.3.0', data.assets[0]);
    const candidate = { release: data, tag: '1.3.0', versionName: '1.3.0', size: 2048, sha256: 'a'.repeat(64) };
    sandbox.checkForUpdates = update.check;
    sandbox.fetch = async url => {
        if (url.includes('/releases?')) return { ok: true, status: 200, text: async () => JSON.stringify([data]) };
        return { ok: true, text: async () => JSON.stringify(metadata()) };
    };
    sandbox.SPXAndroid = { getAppVersion: () => '1.2.0', getAppVersionCode: () => 7 };
    update.init();
    return update.check(true).then(() => {
        assert.equal(element('updateModalNotes').textContent, data.body);
        assert.equal(element('updateModalNotes').innerHTML, '');
        assert.equal(element('updateModalTag').textContent, 'v1.3.0');
    });
});

test('atualização pendente pode ser retomada após recarregar a página', function () {
    const data = release();
    storage.set('spx_update_pending', JSON.stringify({
        downloadUrl: data.assets[2].browser_download_url,
        sha256: 'a'.repeat(64),
        versionCode: 8,
        versionName: '1.3.0',
        signerSha256: 'c'.repeat(64),
        size: 2048,
        tag: '1.3.0',
        notes: '<script>alert(1)</script>'
    }));
    let request;
    let restarted = false;
    sandbox.SPXAndroid = {
        getAppVersion: () => '1.2.0',
        getAppVersionCode: () => 7,
        getAppSignerSha256: () => 'c'.repeat(64),
        installApk: (...args) => { request = args; },
        restartApp: () => { restarted = true; }
    };
    update.init();
    assert.equal(element('mobileAppVersion').textContent, 'v1.2.0');
    assert.equal(element('desktopAppVersion').textContent, 'v1.2.0');
    update.handleNativeEvent({ stage: 'error', percent: 0, message: 'Falha de rede.' });
    assert.equal(element('updateModalNotes').textContent, '<script>alert(1)</script>');
    assert.equal(element('updateModalTag').textContent, 'v1.3.0');
    sandbox.triggerAppUpdate();
    assert.equal(request[0], data.assets[2].browser_download_url);
    assert.equal(request[1], 'a'.repeat(64));
    assert.equal(request[2], 8);
    assert.equal(request[3], '1.3.0');
    assert.equal(request[4], 2048);
    update.handleNativeEvent({ stage: 'installed', percent: 100, message: 'Instalada.' });
    assert.equal(storage.get('spx_update_pending'), '');
    assert.equal(element('mobileAppVersion').textContent, 'v1.3.0');
    assert.equal(element('desktopAppVersion').textContent, 'v1.3.0');
    assert.match(element('updateActionButton').innerHTML, /Reiniciar agora/);
    sandbox.triggerAppUpdate();
    assert.equal(restarted, true);
});

test('seleção oferece Release mais nova com assinatura diferente para reinstalação', async function () {
    const newest = release('1.4.0');
    const older = release();
    const newestMetadata = metadata('1.4.0', 12);
    newestMetadata.apk.signerSha256 = 'd'.repeat(64);
    sandbox.fetch = async url => ({ ok: true, text: async () => JSON.stringify(
        url.includes('v1.4.0') ? newestMetadata : metadata()
    ) });
    sandbox.SPXAndroid = {
        getAppVersion: () => '1.2.0',
        getAppVersionCode: () => 7,
        getAppSignerSha256: () => 'c'.repeat(64)
    };
    update.init();
    const result = await update.findLatestCompatibleCandidate([older, newest]);
    assert.equal(result.candidate.versionName, '1.4.0');
    assert.equal(result.candidate.requiresReinstall, true);
    assert.equal(result.newestBlocked, null);
});

test('modal sinaliza perda de dados e chama a bridge de reinstalação', async function () {
    let installRequest;
    let reinstallRequest;
    const { data } = await presentUpdate({
        version: '1.4.0',
        versionCode: 12,
        signer: 'd'.repeat(64),
        bridge: {
            installApk: (...args) => { installRequest = args; },
            reinstallApk: (...args) => { reinstallRequest = args; }
        }
    });
    assert.equal(element('updateReinstallWarning').classList.contains('hidden'), false);
    assert.match(element('updateActionButton').innerHTML, /Reinstalar atualização/);
    sandbox.triggerAppUpdate();
    assert.equal(installRequest, undefined);
    assert.deepEqual(reinstallRequest, [
        data.assets[2].browser_download_url,
        'a'.repeat(64),
        12,
        '1.4.0',
        2048
    ]);
    const pending = JSON.parse(storage.get('spx_update_pending'));
    assert.equal(pending.requiresReinstall, true);
    assert.equal(pending.signerSha256, 'd'.repeat(64));
});

test('pendência com certificado diferente é restaurada sem aceitar instalação normal', function () {
    const data = release('1.4.0');
    storage.set('spx_update_pending', JSON.stringify({
        downloadUrl: data.assets[2].browser_download_url,
        sha256: 'a'.repeat(64),
        versionCode: 12,
        versionName: '1.4.0',
        signerSha256: 'd'.repeat(64),
        size: 2048,
        tag: '1.4.0',
        notes: 'Nova versão'
    }));
    let reinstallRequest;
    let installRequest;
    sandbox.SPXAndroid = {
        getAppVersion: () => '1.3.3',
        getAppVersionCode: () => 11,
        getAppSignerSha256: () => 'c'.repeat(64),
        installApk: (...args) => { installRequest = args; },
        reinstallApk: (...args) => { reinstallRequest = args; }
    };
    update.init();
    sandbox.triggerAppUpdate();
    assert.equal(installRequest, undefined);
    assert.equal(reinstallRequest[3], '1.4.0');
    assert.equal(JSON.parse(storage.get('spx_update_pending')).requiresReinstall, true);
});

test('reinstalação não usa installApk quando a bridge específica não existe', async function () {
    let installRequest;
    await presentUpdate({
        version: '1.4.0',
        versionCode: 12,
        signer: 'd'.repeat(64),
        bridge: { installApk: (...args) => { installRequest = args; } }
    });
    sandbox.triggerAppUpdate();
    assert.equal(installRequest, undefined);
});

test('APK pronto habilita confirmação e segundo clique solicita desinstalação', async function () {
    let confirmations = 0;
    await presentUpdate({
        version: '1.4.0',
        versionCode: 12,
        signer: 'd'.repeat(64),
        bridge: {
            reinstallApk: () => {},
            confirmReinstall: () => { confirmations += 1; }
        }
    });
    sandbox.triggerAppUpdate();
    update.handleNativeEvent({
        stage: 'reinstall_ready',
        percent: 100,
        message: 'APK validado e salvo em Downloads como SPX-Route-OS-v1.4.0-instalar.apk.'
    });
    assert.match(element('updateActionButton').innerHTML, /Confirmar desinstalação/);
    assert.equal(element('updateActionButton').disabled, false);
    assert.equal(element('updateCloseButton').disabled, true);
    assert.equal(element('updateCloseButton').textContent, 'APK validado');
    assert.match(element('updateStatusText').textContent, /SPX-Route-OS-v1\.4\.0-instalar\.apk/);
    sandbox.triggerAppUpdate();
    sandbox.triggerAppUpdate();
    assert.equal(confirmations, 1);
    assert.equal(element('updateActionButton').disabled, true);
    update.handleNativeEvent({
        stage: 'reinstall_opened',
        percent: 100,
        message: 'Confirme a desinstalação no Android. Depois abra Downloads e toque no APK.'
    });
    assert.match(element('updateActionButton').innerHTML, /Aguardando desinstalação/);
    assert.equal(element('updateCloseButton').disabled, true);
    assert.match(element('updateStatusText').textContent, /abra Downloads/);
});

test('modal com APK validado não pode ser fechado nem adiado', async function () {
    await presentUpdate({
        version: '1.4.0',
        versionCode: 12,
        signer: 'd'.repeat(64),
        bridge: { reinstallApk: () => {} }
    });
    sandbox.triggerAppUpdate();
    update.handleNativeEvent({ stage: 'reinstall_ready', percent: 100, message: 'APK salvo.' });
    sandbox.closeUpdateModal();
    assert.equal(element('updateModalOverlay').classList.contains('hidden'), false);
    assert.equal(storage.has('spx_update_snoozed_tag'), false);
    assert.match(element('updateActionButton').innerHTML, /Confirmar desinstalação/);
});

test('mesmo certificado continua usando instalação normal', async function () {
    let installRequest;
    let reinstallRequest;
    await presentUpdate({
        bridge: {
            installApk: (...args) => { installRequest = args; },
            reinstallApk: (...args) => { reinstallRequest = args; }
        }
    });
    assert.equal(element('updateReinstallWarning').classList.contains('hidden'), true);
    sandbox.triggerAppUpdate();
    assert.equal(installRequest[3], '1.3.0');
    assert.equal(reinstallRequest, undefined);
});

test('versão do certificado ausente bloqueia atualização automática', async function () {
    const data = release();
    const withoutSigner = metadata();
    delete withoutSigner.apk.signerSha256;
    sandbox.fetch = async url => ({
        ok: true,
        status: 200,
        text: async () => JSON.stringify(url.includes('/releases?') ? [data] : withoutSigner)
    });
    sandbox.SPXAndroid = {
        getAppVersion: () => '1.2.0',
        getAppVersionCode: () => 7,
        getAppSignerSha256: () => 'c'.repeat(64)
    };
    update.init();
    await assert.rejects(() => update.resolveCandidate(data), /não informa o certificado/);
    await update.check(true);
    assert.equal(element('updateModalTag').textContent, '');
    assert.equal(toasts.some(message => message.includes('não informa o certificado')), true);
});

test('decisão de reinstalação consulta o histórico de certificados no Android', async function () {
    let checkedSigner;
    let installRequest;
    await presentUpdate({
        version: '1.4.0',
        versionCode: 12,
        signer: 'd'.repeat(64),
        bridge: {
            canInstallWithSigner: signer => { checkedSigner = signer; return true; },
            installApk: (...args) => { installRequest = args; }
        }
    });
    assert.equal(checkedSigner, 'd'.repeat(64));
    assert.equal(element('updateReinstallWarning').classList.contains('hidden'), true);
    assert.match(element('updateActionButton').innerHTML, /Atualizar agora/);
    sandbox.triggerAppUpdate();
    assert.equal(installRequest[3], '1.4.0');
});

test('falha na reinstalação permite baixar novamente sem repetir a confirmação', async function () {
    let reinstallRequests = 0;
    let confirmations = 0;
    await presentUpdate({
        version: '1.4.0',
        versionCode: 12,
        signer: 'd'.repeat(64),
        bridge: {
            reinstallApk: () => { reinstallRequests += 1; },
            confirmReinstall: () => { confirmations += 1; }
        }
    });
    sandbox.triggerAppUpdate();
    update.handleNativeEvent({ stage: 'reinstall_ready', percent: 100, message: 'APK salvo.' });
    update.handleNativeEvent({ stage: 'error', percent: 0, message: 'Falha de rede.' });
    assert.match(element('updateActionButton').innerHTML, /Tentar novamente/);
    sandbox.triggerAppUpdate();
    assert.equal(reinstallRequests, 2);
    assert.equal(confirmations, 0);
});

test('checagem de atualizações não substitui APK de reinstalação já validado', async function () {
    await presentUpdate({
        version: '1.4.0',
        versionCode: 12,
        signer: 'd'.repeat(64),
        bridge: { reinstallApk: () => {} }
    });
    sandbox.triggerAppUpdate();
    update.handleNativeEvent({ stage: 'reinstall_ready', percent: 100, message: 'APK salvo.' });
    let requests = 0;
    sandbox.fetch = async () => { requests += 1; throw new Error('Consulta inesperada'); };
    await update.check(true);
    assert.equal(requests, 0);
    assert.match(element('updateModalTag').textContent, /1\.4\.0/);
    assert.equal(toasts.some(message => message.includes('Aguarde a atualização em andamento')), true);
});

test('consulta em andamento não substitui candidato quando o APK fica pronto', async function () {
    await presentUpdate({
        version: '1.4.0',
        versionCode: 12,
        signer: 'd'.repeat(64),
        bridge: { reinstallApk: () => {} }
    });
    let resolveReleases;
    sandbox.fetch = async url => {
        if (url.includes('/releases?')) {
            return new Promise(resolve => { resolveReleases = resolve; });
        }
        return { ok: true, status: 200, text: async () => JSON.stringify(metadata('1.5.0', 13)) };
    };
    const checking = update.check(true);
    sandbox.triggerAppUpdate();
    update.handleNativeEvent({ stage: 'reinstall_ready', percent: 100, message: 'APK salvo.' });
    resolveReleases({ ok: true, status: 200, text: async () => JSON.stringify([release('1.5.0')]) });
    await checking;
    assert.match(element('updateModalTag').textContent, /1\.4\.0/);
    assert.match(element('updateActionButton').innerHTML, /Confirmar desinstalação/);
});

test('aviso de perda de dados é restaurado com o evento nativo de reinstalação', function () {
    const data = release('1.4.0');
    storage.set('spx_update_pending', JSON.stringify({
        downloadUrl: data.assets[2].browser_download_url,
        sha256: 'a'.repeat(64),
        versionCode: 12,
        versionName: '1.4.0',
        signerSha256: 'd'.repeat(64),
        size: 2048,
        tag: '1.4.0',
        notes: 'Nova versão'
    }));
    sandbox.SPXAndroid = {
        getAppVersion: () => '1.3.3',
        getAppVersionCode: () => 11,
        getAppSignerSha256: () => 'c'.repeat(64)
    };
    update.init();
    update.handleNativeEvent({ stage: 'reinstall_ready', percent: 100, message: 'APK salvo.' });
    assert.equal(element('updateReinstallWarning').classList.contains('hidden'), false);
    assert.match(element('updateActionButton').innerHTML, /Confirmar desinstalação/);
});
