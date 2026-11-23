(function () {
    const TYPE = 'spx-stop-transfer';
    const VERSION = 1;
    const MAX_LINK_LENGTH = 64 * 1024;
    const MAX_IMAGE_BYTES = 3 * 1024 * 1024;
    const MAX_BASE64_LENGTH = 4 * 1024 * 1024;
    let overlay = null;
    let pendingImport = null;
    let scanCallback = null;

    function esc(value) {
        return String(value == null ? '' : value).replace(/[&<>"']/g, char => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
        }[char]));
    }

    function encodeBase64Url(text) {
        const bytes = new TextEncoder().encode(text);
        let binary = '';
        bytes.forEach(byte => { binary += String.fromCharCode(byte); });
        return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
    }

    function decodeBase64Url(text) {
        const base64 = text.replace(/-/g, '+').replace(/_/g, '/');
        const binary = atob(base64 + '='.repeat((4 - base64.length % 4) % 4));
        const bytes = Uint8Array.from(binary, char => char.charCodeAt(0));
        return new TextDecoder().decode(bytes);
    }

    function encodePayload(payload) {
        const json = JSON.stringify(payload);
        if (window.LZString) return LZString.compressToEncodedURIComponent(json);
        return 'j' + encodeBase64Url(json);
    }

    function decodePayload(data) {
        const decoded = decodeURIComponent(data);
        let json;
        if (decoded.startsWith('j')) json = decodeBase64Url(decoded.slice(1));
        else {
            if (!window.LZString) throw new Error('Biblioteca de compressão indisponível.');
            json = LZString.decompressFromEncodedURIComponent(decoded);
            if (!json) throw new Error('Link de transferência inválido ou incompleto.');
        }
        if (json.length > 5 * 1024 * 1024) throw new Error('Transferência maior que 5 MB.');
        return JSON.parse(json);
    }

    function identity() {
        let settings = {};
        try { settings = JSON.parse(localStorage.getItem('spx_logistics_settings') || '{}'); } catch (_) {}
        return {
            teamId: settings.teamId || 'equipe-local',
            driverId: settings.driverId || 'motorista-local',
            driverName: settings.driverName || 'Motorista local'
        };
    }

    function textValue(value, maxLength, label) {
        const text = String(value == null ? '' : value).trim();
        if (text.length > maxLength) throw new Error(`${label} excede o limite de ${maxLength} caracteres.`);
        return text;
    }

    function numberValue(value, fallback, maxValue, label) {
        if (value == null || value === '') return fallback;
        const number = Number(value);
        if (!Number.isFinite(number) || number < 0 || number > maxValue) throw new Error(`${label} inválido.`);
        return number;
    }

    function priorityValue(value) {
        const priority = String(value || 'normal').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
        return ['urgente', 'alta', 'normal'].includes(priority) ? priority : 'normal';
    }

    function normalizedWindowType(value) {
        const type = String(value || 'chegada').normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase();
        return type === 'conclusao' ? 'conclusao' : 'chegada';
    }

    function clockValue(value) {
        if (!value) return '';
        if (typeof window.normalizeClockValue === 'function') return window.normalizeClockValue(value);
        const match = String(value).match(/^(\d{1,2}):(\d{2})$/);
        return match && Number(match[1]) <= 23 && Number(match[2]) <= 59
            ? `${String(Number(match[1])).padStart(2, '0')}:${match[2]}`
            : '';
    }

    function cleanStop(stop) {
        return {
            groupId: String(stop.groupId),
            stopLabel: String(stop.stopLabel || '-'),
            stopNumeric: stop.stopNumeric == null ? null : Number(stop.stopNumeric),
            isUnassignedStop: !!stop.isUnassignedStop,
            primaryAddress: String(stop.primaryAddress || ''),
            bairro: String(stop.bairro || ''),
            city: String(stop.city || ''),
            zipcode: String(stop.zipcode || ''),
            lat: Number(stop.lat),
            lng: Number(stop.lng),
            approx: !!stop.approx,
            minSequence: Number(stop.minSequence) || 0,
            recipient: stop.recipient || '',
            phone: stop.phone || '',
            priority: stop.priority || 'normal',
            serviceMinutes: numberValue(stop.serviceMinutes, 4, 10080, 'Tempo de serviço'),
            windowStart: stop.windowStart || '',
            windowEnd: stop.windowEnd || '',
            windowType: stop.windowType || 'chegada',
            vehiclePosition: stop.vehiclePosition || '',
            notes: stop.notes || '',
            packages: (stop.packages || []).filter(pkg => pkg.status !== 'Entregue' && pkg.status !== 'Insucesso').map(pkg => ({
                id: String(pkg.id),
                atId: String(pkg.atId || activeAtId || 'ROMANEIO SPX'),
                sequence: Number(pkg.sequence) || 0,
                stopRaw: String(pkg.stopRaw || '-'),
                stopNumeric: pkg.stopNumeric == null ? null : Number(pkg.stopNumeric),
                spxTn: String(pkg.spxTn || ''),
                address: String(pkg.address || stop.primaryAddress || ''),
                bairro: String(pkg.bairro || stop.bairro || ''),
                city: String(pkg.city || stop.city || ''),
                zipcode: String(pkg.zipcode || stop.zipcode || ''),
                lat: pkg.lat == null ? Number(stop.lat) : Number(pkg.lat),
                lng: pkg.lng == null ? Number(stop.lng) : Number(pkg.lng),
                approx: !!stop.approx,
                status: 'Pendente',
                deliveredAt: '',
                recipient: pkg.recipient || '',
                phone: pkg.phone || '',
                priority: pkg.priority || stop.priority || 'normal',
                serviceMinutes: numberValue(pkg.serviceMinutes, 0, 10080, 'Tempo de serviço'),
                windowStart: pkg.windowStart || stop.windowStart || '',
                windowEnd: pkg.windowEnd || stop.windowEnd || '',
                windowType: pkg.windowType || stop.windowType || 'chegada',
                vehiclePosition: pkg.vehiclePosition || stop.vehiclePosition || '',
                vehicleSlot: pkg.vehicleSlot || '',
                slotZone: pkg.slotZone || '',
                slotPosition: pkg.slotPosition || '',
                notes: pkg.notes || ''
            }))
        };
    }

    function buildPayload(stopIds) {
        const from = identity();
        const stops = stopIds.map(id => groupedStops.find(stop => stop.groupId === id)).filter(Boolean).map(cleanStop).filter(stop => stop.packages.length);
        return {
            version: VERSION,
            type: TYPE,
            transferId: 'tr-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8),
            routeId: activeAtId || 'ROMANEIO SPX',
            exportedAt: new Date().toISOString(),
            from,
            stops
        };
    }

    function payloadLink(payload) {
        return 'spxroute://transfer?data=' + encodePayload(payload);
    }

    function validatePayload(payload) {
        if (!payload || payload.type !== TYPE || payload.version !== VERSION || !Array.isArray(payload.stops)) {
            throw new Error('O arquivo ou link não é uma transferência SPX válida.');
        }
        if (!payload.stops.length) throw new Error('A transferência não contém paradas pendentes.');
        if (payload.stops.length > 500) throw new Error('A transferência excede o limite de 500 paradas.');
        payload.transferId = textValue(payload.transferId, 200, 'Identificador da transferência');
        payload.routeId = textValue(payload.routeId, 200, 'Identificador da rota');
        payload.exportedAt = textValue(payload.exportedAt, 64, 'Data de exportação');
        if (payload.from && typeof payload.from === 'object') {
            payload.from = {
                teamId: textValue(payload.from.teamId, 200, 'Equipe'),
                driverId: textValue(payload.from.driverId, 200, 'Motorista'),
                driverName: textValue(payload.from.driverName, 200, 'Nome do motorista')
            };
        }

        let packageCount = 0;
        const cleanStops = payload.stops.map(stop => {
            const groupId = textValue(stop.groupId, 200, 'Parada');
            if (!groupId || !Array.isArray(stop.packages) || !stop.packages.length) {
                throw new Error('Há uma parada inválida na transferência.');
            }
            const lat = Number(stop.lat);
            const lng = Number(stop.lng);
            if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
                throw new Error('Há uma parada sem coordenadas válidas.');
            }
            const primaryAddress = textValue(stop.primaryAddress, 1000, 'Endereço');
            const bairro = textValue(stop.bairro, 200, 'Bairro');
            const city = textValue(stop.city, 200, 'Cidade');
            const serviceMinutes = numberValue(stop.serviceMinutes, 4, 10080, 'Tempo de serviço');
            packageCount += stop.packages.length;
            if (packageCount > 5000) throw new Error('A transferência excede o limite de 5.000 pacotes.');
            const packages = stop.packages.map(pkg => {
                const id = textValue(pkg.id, 200, 'Pacote');
                const spxTn = textValue(pkg.spxTn, 128, 'SPX TN').toUpperCase();
                if (!id || !spxTn) throw new Error('Há um pacote sem identificação na transferência.');
                const packageLat = pkg.lat == null ? lat : Number(pkg.lat);
                const packageLng = pkg.lng == null ? lng : Number(pkg.lng);
                if (!Number.isFinite(packageLat) || !Number.isFinite(packageLng) ||
                    packageLat < -90 || packageLat > 90 || packageLng < -180 || packageLng > 180) {
                    throw new Error('Há um pacote sem coordenadas válidas.');
                }
                const sequence = Number(pkg.sequence);
                return {
                    id,
                    atId: textValue(pkg.atId, 200, 'Romaneio'),
                    sequence: Number.isInteger(sequence) && sequence >= 0 ? sequence : 0,
                    stopRaw: textValue(pkg.stopRaw, 80, 'Stop') || '-',
                    stopNumeric: pkg.stopNumeric == null ? null : numberValue(pkg.stopNumeric, 0, Number.MAX_SAFE_INTEGER, 'Stop'),
                    spxTn,
                    address: textValue(pkg.address, 1000, 'Endereço') || primaryAddress,
                    bairro: textValue(pkg.bairro, 200, 'Bairro') || bairro,
                    city: textValue(pkg.city, 200, 'Cidade') || city,
                    zipcode: textValue(pkg.zipcode, 32, 'CEP'),
                    lat: packageLat,
                    lng: packageLng,
                    approx: pkg.approx == null ? !!stop.approx : !!pkg.approx,
                    status: 'Pendente',
                    deliveredAt: '',
                    recipient: textValue(pkg.recipient, 200, 'Recebedor'),
                    phone: textValue(pkg.phone, 64, 'Telefone'),
                    priority: priorityValue(pkg.priority || stop.priority),
                    serviceMinutes: numberValue(pkg.serviceMinutes, serviceMinutes, 10080, 'Tempo de serviço'),
                    windowStart: clockValue(pkg.windowStart || stop.windowStart),
                    windowEnd: clockValue(pkg.windowEnd || stop.windowEnd),
                    windowType: normalizedWindowType(pkg.windowType || stop.windowType),
                    vehiclePosition: textValue(pkg.vehiclePosition, 500, 'Posição no veículo'),
                    vehicleSlot: textValue(pkg.vehicleSlot, 200, 'Slot'),
                    slotZone: textValue(pkg.slotZone, 200, 'Zona'),
                    slotPosition: textValue(pkg.slotPosition, 200, 'Posição'),
                    notes: textValue(pkg.notes, 4000, 'Observações')
                };
            });
            const minSequence = Number(stop.minSequence);
            const stopNumeric = stop.stopNumeric == null ? null : numberValue(stop.stopNumeric, 0, Number.MAX_SAFE_INTEGER, 'Stop');
            return {
                groupId,
                stopLabel: textValue(stop.stopLabel, 80, 'Stop') || '-',
                stopNumeric,
                isUnassignedStop: !!stop.isUnassignedStop,
                primaryAddress,
                bairro,
                city,
                zipcode: textValue(stop.zipcode, 32, 'CEP'),
                lat,
                lng,
                approx: !!stop.approx,
                minSequence: Number.isInteger(minSequence) && minSequence >= 0 ? minSequence : 0,
                recipient: textValue(stop.recipient, 200, 'Recebedor'),
                phone: textValue(stop.phone, 64, 'Telefone'),
                priority: priorityValue(stop.priority),
                serviceMinutes,
                windowStart: clockValue(stop.windowStart),
                windowEnd: clockValue(stop.windowEnd),
                windowType: normalizedWindowType(stop.windowType),
                vehiclePosition: textValue(stop.vehiclePosition, 500, 'Posição no veículo'),
                notes: textValue(stop.notes, 4000, 'Observações'),
                packages
            };
        });
        payload.stops = cleanStops;
        return payload;
    }

    function ensureModal() {
        if (overlay) return;
        overlay = document.createElement('div');
        overlay.id = 'transferModalOverlay';
        overlay.className = 'hidden fixed inset-0 z-[70] bg-zinc-950/70 backdrop-blur-sm flex items-center justify-center p-3';
        overlay.innerHTML = `
            <div class="bg-white dark:bg-zinc-900 w-full max-w-2xl rounded-2xl border border-zinc-200 dark:border-zinc-800 shadow-2xl max-h-[92dvh] flex flex-col overflow-hidden">
                <div class="p-4 border-b border-zinc-200 dark:border-zinc-800 flex items-center justify-between gap-3">
                    <div class="flex items-center gap-3">
                        <div class="w-10 h-10 rounded-xl bg-indigo-600 text-white flex items-center justify-center"><i data-lucide="send" class="w-5 h-5"></i></div>
                        <div><h2 class="text-sm font-bold">Transferir paradas</h2><p class="text-[11px] text-zinc-500">Envio local por link, QR Code ou arquivo</p></div>
                    </div>
                    <button data-transfer-action="close" class="shadcn-btn h-9 w-9 text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800" aria-label="Fechar"><i data-lucide="x" class="w-4 h-4"></i></button>
                </div>
                <div id="transferModalBody" class="flex-1 overflow-y-auto p-4"></div>
                <input id="transferFileInput" type="file" accept=".json,.spxtransfer,application/json" class="hidden">
                <input id="transferQrInput" type="file" accept="image/*" capture="environment" class="hidden">
            </div>`;
        document.body.appendChild(overlay);
        overlay.addEventListener('click', event => {
            if (event.target === overlay) closeModal();
            const button = event.target.closest('[data-transfer-action]');
            if (!button) return;
            const action = button.dataset.transferAction;
            if (action === 'close') closeModal();
            if (action === 'generate') generateSelected();
            if (action === 'copy') copyLink();
            if (action === 'share') shareLink();
            if (action === 'download') downloadFile();
            if (action === 'scan') startQrScan();
            if (action === 'import-file') document.getElementById('transferFileInput').click();
            if (action === 'confirm-import') confirmImport();
            if (action === 'cancel-import') { pendingImport = null; renderPicker(); }
        });
        document.getElementById('transferFileInput').addEventListener('change', event => {
            const file = event.target.files[0];
            event.target.value = '';
            if (file) readTransferFile(file);
        });
        document.getElementById('transferQrInput').addEventListener('change', event => {
            const file = event.target.files[0];
            event.target.value = '';
            if (file) readQrImage(file);
        });
    }

    function renderPicker() {
        ensureModal();
        document.getElementById('transferModalBody').innerHTML = `
            <div class="grid md:grid-cols-2 gap-3 mb-4">
                <button data-transfer-action="scan" class="shadcn-btn h-12 bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-semibold"><i data-lucide="scan-line" class="w-4 h-4"></i> Ler QR Code por foto</button>
                <button data-transfer-action="import-file" class="shadcn-btn h-12 bg-white dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 text-xs font-semibold"><i data-lucide="file-up" class="w-4 h-4"></i> Importar arquivo</button>
            </div>
            <div class="rounded-xl border border-zinc-200 dark:border-zinc-800 p-3 mb-3 bg-zinc-50 dark:bg-zinc-950">
                <p class="text-xs font-semibold mb-1">Enviar paradas deste aparelho</p>
                <p class="text-[11px] text-zinc-500">Somente entregas pendentes são incluídas. No outro aparelho, abra o link ou leia o QR Code no SPX Route OS.</p>
            </div>
            <div class="space-y-2 max-h-[42dvh] overflow-y-auto">
                ${groupedStops.map((stop, index) => {
                    const pending = stop.packages.filter(pkg => pkg.status !== 'Entregue' && pkg.status !== 'Insucesso');
                    if (!pending.length) return '';
                    return `<label class="flex items-start gap-3 p-3 rounded-xl border border-zinc-200 dark:border-zinc-800 cursor-pointer hover:bg-zinc-50 dark:hover:bg-zinc-950">
                        <input type="checkbox" class="transfer-stop-check mt-1 accent-indigo-600" value="${esc(stop.groupId)}" ${index === 0 ? 'checked' : ''}>
                        <span class="min-w-0 flex-1"><span class="block text-xs font-semibold truncate">${index + 1}. ${esc(stop.primaryAddress)}</span><span class="block text-[11px] text-zinc-500 mt-0.5">${pending.length} pacote(s) · ${esc(stop.priority || 'Normal')} · ${esc(stop.bairro || '')}</span></span>
                    </label>`;
                }).join('') || '<p class="text-xs text-center text-zinc-500 py-8">Nenhuma parada pendente para transferir.</p>'}
            </div>
            <button data-transfer-action="generate" class="shadcn-btn w-full h-11 bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-semibold mt-4"><i data-lucide="qr-code" class="w-4 h-4"></i> Gerar QR Code e link</button>`;
        lucide.createIcons();
    }

    let generatedPayload = null;
    let generatedLink = '';

    function generateSelected() {
        const ids = Array.from(document.querySelectorAll('.transfer-stop-check:checked')).map(input => input.value);
        if (!ids.length) return showToast('Selecione ao menos uma parada.', 'error');
        generatedPayload = buildPayload(ids);
        generatedLink = payloadLink(generatedPayload);
        const packageCount = generatedPayload.stops.reduce((sum, stop) => sum + stop.packages.length, 0);
        const linkTooLarge = generatedLink.length > MAX_LINK_LENGTH;
        let qrSvg = '<p class="text-xs text-amber-700 dark:text-amber-300 p-4">O conteúdo ficou grande para um QR Code. Use o link ou baixe o arquivo de transferência.</p>';
        if (linkTooLarge) {
            qrSvg = '<p class="text-xs text-amber-700 dark:text-amber-300 p-4">O conteúdo excede o limite de links do Android. Baixe o arquivo de transferência.</p>';
        } else if (generatedLink.length <= 2900 && window.qrcode) {
            try {
                const qr = qrcode(0, 'M');
                qr.addData(generatedLink);
                qr.make();
                qrSvg = qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
            } catch (_) {}
        }
        const linkPanel = linkTooLarge
            ? '<div class="rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-200">Selecione menos paradas para gerar um link ou continue pelo arquivo.</div>'
            : `<div><p class="text-[11px] uppercase tracking-wider text-zinc-500 font-bold mb-1">Link de transferência</p><textarea id="transferLinkText" readonly class="w-full h-24 text-[10px] font-mono p-2 rounded-lg bg-zinc-50 dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 resize-none">${esc(generatedLink)}</textarea></div>
                <div class="grid grid-cols-2 gap-2">
                    <button data-transfer-action="copy" class="shadcn-btn h-10 bg-zinc-900 dark:bg-zinc-100 text-white dark:text-zinc-950 text-xs font-semibold"><i data-lucide="copy" class="w-4 h-4"></i> Copiar</button>
                    <button data-transfer-action="share" class="shadcn-btn h-10 bg-indigo-600 text-white text-xs font-semibold"><i data-lucide="share-2" class="w-4 h-4"></i> Enviar</button>
                </div>`;
        document.getElementById('transferModalBody').innerHTML = `
            <div class="text-center mb-4"><span class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-emerald-50 dark:bg-emerald-950 text-emerald-700 dark:text-emerald-300 text-[11px] font-semibold"><i data-lucide="check-circle-2" class="w-3.5 h-3.5"></i> ${generatedPayload.stops.length} parada(s) · ${packageCount} pacote(s)</span></div>
            <div class="grid sm:grid-cols-[220px_1fr] gap-5 items-center">
                <div class="bg-white rounded-xl p-3 border border-zinc-200 [&_svg]:w-full [&_svg]:h-auto">${qrSvg}</div>
                <div class="space-y-3">
                    ${linkPanel}
                    <button data-transfer-action="download" class="shadcn-btn w-full h-10 bg-white dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 text-xs font-semibold"><i data-lucide="download" class="w-4 h-4"></i> Baixar arquivo</button>
                </div>
            </div>
            <button data-transfer-action="cancel-import" class="shadcn-btn w-full h-10 mt-5 bg-zinc-100 dark:bg-zinc-800 text-xs font-semibold"><i data-lucide="arrow-left" class="w-4 h-4"></i> Escolher outras paradas</button>`;
        lucide.createIcons();
    }

    function copyLink() {
        if (generatedLink.length > MAX_LINK_LENGTH) return showToast('Link muito longo; baixe o arquivo de transferência.', 'info');
        const input = document.getElementById('transferLinkText');
        if (!input) return;
        input.select();
        try { document.execCommand('copy'); showToast('Link copiado.', 'success'); }
        catch (_) { showToast('Selecione e copie o link manualmente.', 'info'); }
    }

    async function shareLink() {
        if (!generatedLink) return;
        if (generatedLink.length > MAX_LINK_LENGTH) return showToast('Link muito longo; baixe o arquivo de transferência.', 'info');
        try {
            if (window.SPXAndroid && SPXAndroid.shareText) {
                SPXAndroid.shareText('Transferência SPX Route OS: ' + generatedLink);
            } else if (navigator.share) {
                await navigator.share({ title: 'Transferência SPX Route OS', text: 'Abra no SPX Route OS: ' + generatedLink });
            } else {
                copyLink();
            }
        } catch (_) {}
    }

    function downloadFile() {
        if (!generatedPayload) return;
        const blob = new Blob([JSON.stringify(generatedPayload, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = `SPX_Transferencia_${Date.now()}.spxtransfer.json`;
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    }

    async function readTransferFile(file) {
        try {
            if (file.size > 5 * 1024 * 1024) throw new Error('Arquivo maior que 5 MB.');
            const text = await file.text();
            const trimmed = text.trim();
            let payload;
            if (trimmed.startsWith('spxroute://')) {
                const match = trimmed.match(/[?&]data=([^&]+)/);
                if (!match) throw new Error('Link SPX inválido.');
                payload = decodePayload(match[1]);
            } else {
                payload = JSON.parse(trimmed);
            }
            prepareImport(validatePayload(payload));
        } catch (error) {
            showToast(error.message || 'Falha ao ler a transferência.', 'error');
        }
    }

    async function readQrImage(file) {
        try {
            if (file.size > MAX_IMAGE_BYTES) throw new Error('Imagem maior que 3 MB.');
            const dataUrl = await fileToDataUrl(file);
            const base64 = dataUrl.split(',')[1];
            if (base64.length > MAX_BASE64_LENGTH) throw new Error('Imagem excede o limite de leitura do Android.');
            if (!window.SPXAndroid || !SPXAndroid.scanBarcode) throw new Error('Leitor de QR Code disponível apenas no aplicativo Android.');
            scanCallback = link => importLink(link);
            SPXAndroid.scanBarcode(base64, '__spxTransferQrResult');
        } catch (error) {
            showToast(error.message || 'Falha ao ler o QR Code.', 'error');
        }
    }

    function fileToDataUrl(file) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.onerror = () => reject(new Error('Não foi possível ler a imagem.'));
            reader.readAsDataURL(file);
        });
    }

    window.__spxTransferQrResult = function (value) {
        const callback = scanCallback;
        scanCallback = null;
        if (value && callback) callback(value);
        else showToast('Nenhum QR Code encontrado na foto.', 'error');
    };

    function startQrScan() {
        document.getElementById('transferQrInput').click();
    }

    function prepareImport(payload) {
        pendingImport = payload;
        const packageCount = payload.stops.reduce((sum, stop) => sum + stop.packages.length, 0);
        document.getElementById('transferModalBody').innerHTML = `
            <div class="rounded-xl border border-indigo-200 dark:border-indigo-900 bg-indigo-50/60 dark:bg-indigo-950/30 p-4 mb-4">
                <p class="text-xs font-semibold text-indigo-900 dark:text-indigo-200">Transferência recebida</p>
                <p class="text-[11px] text-indigo-700 dark:text-indigo-300 mt-1">${payload.stops.length} parada(s), ${packageCount} pacote(s) · enviado por ${esc(payload.from && payload.from.driverName || 'outro aparelho')}</p>
            </div>
            <div class="space-y-2 max-h-[48dvh] overflow-y-auto">
                ${payload.stops.map(stop => `<div class="p-3 rounded-xl border border-zinc-200 dark:border-zinc-800"><p class="text-xs font-semibold">${esc(stop.primaryAddress)}</p><p class="text-[11px] text-zinc-500 mt-1">${stop.packages.length} pacote(s) · ${esc(stop.priority || 'Normal')}</p><div class="mt-2 flex flex-wrap gap-1">${stop.packages.map(pkg => `<span class="font-mono text-[10px] px-1.5 py-0.5 rounded bg-zinc-100 dark:bg-zinc-800">${esc(pkg.spxTn)}</span>`).join('')}</div></div>`).join('')}
            </div>
            <div class="flex gap-2 mt-4"><button data-transfer-action="cancel-import" class="shadcn-btn flex-1 h-11 bg-zinc-100 dark:bg-zinc-800 text-xs font-semibold">Cancelar</button><button data-transfer-action="confirm-import" class="shadcn-btn flex-[2] h-11 bg-indigo-600 text-white text-xs font-semibold"><i data-lucide="download" class="w-4 h-4"></i> Importar para minha rota</button></div>`;
        lucide.createIcons();
        overlay.classList.remove('hidden');
    }

    async function confirmImport() {
        if (!pendingImport) return;
        const existingTracking = new Set();
        const existingIds = new Set();
        groupedStops.forEach(stop => stop.packages.forEach(pkg => {
            existingTracking.add(String(pkg.spxTn || '').trim().toUpperCase());
            existingIds.add(String(pkg.id));
        }));
        let importedPackages = 0;
        let skipped = 0;
        const transferRouteId = String(pendingImport.routeId || '');
        for (let stopIndex = 0; stopIndex < pendingImport.stops.length; stopIndex++) {
            const incoming = pendingImport.stops[stopIndex];
            const packages = incoming.packages.filter(pkg => {
                const tracking = String(pkg.spxTn || '').trim().toUpperCase();
                const id = String(pkg.id);
                if (existingTracking.has(tracking) || existingIds.has(id)) { skipped++; return false; }
                existingTracking.add(tracking);
                existingIds.add(id);
                return true;
            });
            if (!packages.length) continue;
            const sameRoute = !transferRouteId || transferRouteId === activeAtId;
            const current = sameRoute ? groupedStops.find(stop => stop.groupId === incoming.groupId &&
                comparableText(stop.primaryAddress) === comparableText(incoming.primaryAddress) &&
                Math.abs(Number(stop.lat) - Number(incoming.lat)) < 0.00001 &&
                Math.abs(Number(stop.lng) - Number(incoming.lng)) < 0.00001) : null;
            if (current) {
                current.packages.push(...packages);
                current.priority = priorityRank(incoming.priority) > priorityRank(current.priority) ? incoming.priority : current.priority;
                if (!current.recipient && incoming.recipient) current.recipient = incoming.recipient;
                if (!current.phone && incoming.phone) current.phone = incoming.phone;
                if (!current.vehiclePosition && incoming.vehiclePosition) current.vehiclePosition = incoming.vehiclePosition;
                if (window.normalizeStopDeliveryFields) normalizeStopDeliveryFields(current);
            } else {
                const importedStop = Object.assign({}, incoming, {
                    groupId: `TRANSFER_${Date.now().toString(36)}_${stopIndex}_${Math.random().toString(36).slice(2, 8)}`,
                    packages
                });
                groupedStops.push(window.normalizeStopDeliveryFields ? normalizeStopDeliveryFields(importedStop) : importedStop);
            }
            importedPackages += packages.length;
        }
        const transferId = pendingImport.transferId;
        pendingImport = null;
        if (!importedPackages) {
            showToast('Nenhum pacote novo; todos já existem nesta rota.', 'info');
            renderPicker();
            return;
        }
        try {
            const imported = JSON.parse(localStorage.getItem('spx_imported_transfers') || '[]');
            imported.push({ transferId, importedAt: new Date().toISOString(), packageCount: importedPackages });
            localStorage.setItem('spx_imported_transfers', JSON.stringify(imported.slice(-100)));
        } catch (_) {}
        originalStopsSnapshot = JSON.parse(JSON.stringify(groupedStops, function (key, value) {
            return key.startsWith('_') || key === 'originalRow' ? undefined : value;
        }));
        activeRoutePlan = null;
        refreshAllViews(true);
        closeModal();
        showToast(`${importedPackages} pacote(s) importado(s)${skipped ? `; ${skipped} duplicado(s) ignorado(s)` : ''}.`, 'success');
    }

    function comparableText(value) {
        return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase();
    }

    function priorityRank(priority) {
        return { normal: 0, alta: 1, urgente: 2 }[String(priority || '').toLowerCase()] || 0;
    }

    async function importLink(link) {
        try {
            const text = String(link || '').trim();
            if (text.length > MAX_LINK_LENGTH || !/^spxroute:\/\/transfer\/?\?/i.test(text)) throw new Error('Link SPX inválido ou muito longo.');
            const match = text.match(/[?&]data=([^&]+)/);
            if (!match) throw new Error('Link SPX inválido.');
            const payload = validatePayload(decodePayload(match[1]));
            ensureModal();
            prepareImport(payload);
            return { ok: true, packageCount: payload.stops.reduce((sum, stop) => sum + stop.packages.length, 0) };
        } catch (error) {
            showToast(error.message || 'Não foi possível importar o link.', 'error');
            return { ok: false, error: error.message };
        }
    }

    function openModal() {
        renderPicker();
        overlay.classList.remove('hidden');
        lucide.createIcons();
    }

    function closeModal() {
        if (overlay) overlay.classList.add('hidden');
    }

    window.SPXTransfer = { openModal, closeModal, importLink, encodePayload, decodePayload, validatePayload };
})();
