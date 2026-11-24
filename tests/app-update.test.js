'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../app/src/main/assets/js/app-update.js'), 'utf8');
const elements = new Map();
function element(id) {
    if (!elements.has(id)) {
        elements.set(id, {
            id,
            textContent: '',
            innerHTML: '',
            disabled: false,
            style: {},
            classList: { add() {}, remove() {} }
        });
    }
    return elements.get(id);
}
const storage = new Map();
const sandbox = {
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
    showToast: () => {}
};
sandbox.window = sandbox;
vm.runInNewContext(source, sandbox, { filename: 'app-update.js' });
const update = sandbox.SPXUpdate;

function release() {
    const tag = 'v1.3.0';
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

function metadata() {
    return {
        schemaVersion: 1,
        repository: 'dnlortega/spx-android',
        tagName: 'v1.3.0',
        versionName: '1.3.0',
        versionCode: 8,
        apk: { name: 'SPX-Route-OS-v1.3.0.apk', size: 2048, sha256: 'a'.repeat(64) }
    };
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
        if (url.includes('/releases/latest')) return { ok: true, status: 200, text: async () => JSON.stringify(data) };
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
        size: 2048,
        tag: '1.3.0',
        notes: '<script>alert(1)</script>'
    }));
    let request;
    sandbox.SPXAndroid = {
        getAppVersion: () => '1.2.0',
        getAppVersionCode: () => 7,
        installApk: (...args) => { request = args; }
    };
    update.init();
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
});
