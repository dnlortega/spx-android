(function () {
    'use strict';

    const ROOT_ID = 'spxLogisticsRoot';
    const STYLE_ID = 'spxLogisticsStyle';
    const SETTINGS_KEY = 'spx_logistics_settings';
    const GOOGLE_KEY_STORAGE = 'spx_google_routes_key';
    const VEHICLE_ZONES = [
        'Banco dianteiro',
        'Banco traseiro',
        'Porta-malas esquerdo',
        'Porta-malas direito',
        'Compartimento traseiro'
    ];
    const FAILURE_REASONS = [
        'Recebedor ausente',
        'Endereço não localizado',
        'Recebedor recusou a entrega',
        'Destinatário incorreto',
        'Área de risco ou acesso bloqueado',
        'Outro'
    ];

    let root = null;
    let initialized = false;
    let autocompleteTimer = null;
    let autocompleteController = null;
    let autocompleteToken = 0;
    let addressState = null;
    let finderState = { query: '', results: [] };
    let loadState = { query: '', zone: 'Todas' };
    let podState = null;
    let navigationLine = null;
    let locationWatchId = null;
    let rerouteTimer = null;
    let navigationRequestToken = 0;
    let googleRequestCounter = 0;
    const googleRequests = new Map();

    const navState = {
        active: false,
        plan: null,
        stopIds: [],
        lastPosition: null,
        nearest: null,
        destinationGroupId: '',
        offRouteSince: 0,
        lastRerouteAt: 0,
        rerouting: false,
        startedAt: ''
    };

    function byId(id) {
        return document.getElementById(id);
    }

    function fallbackEscape(value) {
        return String(value == null ? '' : value).replace(/[&<>"']/g, function (char) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char];
        });
    }

    function esc(value) {
        if (typeof window.escapeHtml === 'function') return window.escapeHtml(value);
        return fallbackEscape(value);
    }

    function icon(name, className) {
        return `<i data-lucide="${esc(name)}" class="${esc(className || 'w-4 h-4')}" aria-hidden="true"></i>`;
    }

    function refreshIcons() {
        try {
            if (window.lucide && typeof window.lucide.createIcons === 'function') window.lucide.createIcons();
        } catch (_) {}
    }

    function notify(message, type) {
        try {
            if (typeof window.showToast === 'function') {
                window.showToast(message, type || 'info');
                return;
            }
        } catch (_) {}
        const target = byId('spxInlineError');
        if (target) {
            target.textContent = message;
            target.classList.remove('hidden');
        }
    }

    function errorMessage(error) {
        if (!error) return 'Não foi possível concluir a operação.';
        if (typeof error === 'string') return error;
        return error.message || 'Não foi possível concluir a operação.';
    }

    function reportError(error, prefix) {
        const message = errorMessage(error);
        notify(prefix ? `${prefix}: ${message}` : message, 'error');
        return message;
    }

    function makeId(prefix) {
        let unique;
        try {
            if (window.crypto && typeof window.crypto.randomUUID === 'function') unique = window.crypto.randomUUID();
            else unique = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
        } catch (_) {
            unique = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
        }
        return `${prefix || 'spx'}-${unique}`;
    }

    function clone(value) {
        return JSON.parse(JSON.stringify(value));
    }

    function numberValue(value) {
        if (typeof value === 'string' && /s$/i.test(value.trim())) return parseFloat(value);
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : 0;
    }

    function validCoords(value) {
        if (!value) return false;
        const lat = Number(value.lat);
        const lng = Number(value.lng);
        return Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;
    }

    function normalizePosition(position) {
        if (!position) return null;
        if (Array.isArray(position)) return { lat: Number(position[0]), lng: Number(position[1]) };
        if (position.coords) {
            return {
                lat: Number(position.coords.latitude),
                lng: Number(position.coords.longitude),
                accuracy: Number(position.coords.accuracy) || 0
            };
        }
        const lat = Number(position.latitude != null ? position.latitude : position.lat);
        const lng = Number(position.longitude != null ? position.longitude : position.lng);
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
        return { lat, lng, accuracy: Number(position.accuracy) || 0 };
    }

    function distanceKm(a, b) {
        if (!validCoords(a) || !validCoords(b)) return 0;
        if (window.SPXRouteEngine && typeof window.SPXRouteEngine.haversineKm === 'function') {
            const result = window.SPXRouteEngine.haversineKm(a, b);
            if (Number.isFinite(Number(result))) return Number(result);
        }
        if (typeof window.haversineDistanceKm === 'function') {
            return window.haversineDistanceKm(a.lat, a.lng, b.lat, b.lng);
        }
        const rad = Math.PI / 180;
        const dLat = (b.lat - a.lat) * rad;
        const dLng = (b.lng - a.lng) * rad;
        const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
        return 6371 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(Math.max(0, 1 - h)));
    }

    function formatDistance(meters) {
        const value = Math.max(0, Number(meters) || 0);
        if (value < 1000) return `${Math.round(value / 10) * 10} m`;
        return `${(value / 1000).toFixed(value < 10000 ? 1 : 0)} km`;
    }

    function formatDuration(seconds) {
        const totalMinutes = Math.max(0, Math.round((Number(seconds) || 0) / 60));
        if (totalMinutes < 60) return `${totalMinutes} min`;
        const hours = Math.floor(totalMinutes / 60);
        const minutes = totalMinutes % 60;
        return minutes ? `${hours} h ${minutes} min` : `${hours} h`;
    }

    function formatClock(value) {
        if (!value) return '—';
        const date = value instanceof Date ? value : new Date(value);
        if (Number.isNaN(date.getTime())) return '—';
        try {
            return date.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
        } catch (_) {
            return date.toISOString().slice(11, 16);
        }
    }

    function formatDateTime(value) {
        if (!value) return '—';
        const date = new Date(value);
        if (Number.isNaN(date.getTime())) return '—';
        try {
            return date.toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
        } catch (_) {
            return date.toISOString();
        }
    }

    function normalizeText(value) {
        return String(value || '')
            .normalize('NFD')
            .replace(/[\u0300-\u036f]/g, '')
            .toLowerCase();
    }

    function getStops() {
        return typeof groupedStops !== 'undefined' && Array.isArray(groupedStops) ? groupedStops : [];
    }

    function getSnapshot() {
        return typeof originalStopsSnapshot !== 'undefined' && Array.isArray(originalStopsSnapshot) ? originalStopsSnapshot : [];
    }

    function allPackages() {
        const result = [];
        getStops().forEach(function (stop, stopIndex) {
            (stop.packages || []).forEach(function (pkg) {
                result.push({ stop, pkg, stopIndex });
            });
        });
        return result;
    }

    function canonicalZone(value) {
        const normalized = normalizeText(value).replace(/\s+/g, ' ').trim();
        return VEHICLE_ZONES.find(function (zone) { return normalizeText(zone) === normalized; }) || '';
    }

    function parseVehiclePosition(value) {
        if (!value) return { zone: '', position: '', label: '' };
        if (typeof value === 'object') {
            const zone = canonicalZone(value.zone || value.slotZone || '');
            const position = String(value.position || value.slotPosition || value.shelf || value.compartment || '').trim();
            const label = String(value.label || [zone || value.zone, position].filter(Boolean).join(' · ') || '').trim();
            return { zone, position, label };
        }
        const label = String(value).trim();
        const directZone = canonicalZone(label);
        if (directZone) return { zone: directZone, position: '', label: directZone };
        for (const zone of VEHICLE_ZONES) {
            if (!normalizeText(label).startsWith(normalizeText(zone))) continue;
            const remainder = label.slice(zone.length);
            if (remainder && !/^[\s·/\\-]/.test(remainder)) continue;
            return { zone, position: remainder.replace(/^[\s·/\\-]+/, '').trim(), label };
        }
        return { zone: '', position: '', label };
    }

    function packageSlot(pkg) {
        const parsedSlot = parseVehiclePosition(pkg.vehicleSlot);
        const parsedPosition = parseVehiclePosition(pkg.vehiclePosition);
        const zone = canonicalZone(pkg.slotZone) || parsedSlot.zone || parsedPosition.zone;
        const position = String(pkg.slotPosition || parsedSlot.position || parsedPosition.position || '').trim();
        const label = zone
            ? [zone, position].filter(Boolean).join(' · ')
            : String(pkg.vehiclePosition || pkg.vehicleSlot || position || '').trim();
        return { zone, position, label };
    }

    function ensurePackageSlotFields() {
        allPackages().forEach(function (item) {
            const slot = packageSlot(item.pkg);
            item.pkg.slotZone = slot.zone;
            item.pkg.slotPosition = slot.position;
            item.pkg.vehicleSlot = slot.label;
            item.pkg.vehiclePosition = slot.label;
        });
        getStops().forEach(function (stop) {
            const labels = [...new Set((stop.packages || []).map(function (pkg) { return packageSlot(pkg).label; }).filter(Boolean))];
            if (labels.length) stop.vehiclePosition = labels.join(' | ');
        });
    }

    function findPackage(groupId, pkgId) {
        const stop = getStops().find(function (item) { return String(item.groupId) === String(groupId); });
        if (!stop) return null;
        const pkg = (stop.packages || []).find(function (item) { return String(item.id) === String(pkgId); });
        return pkg ? { stop, pkg } : null;
    }

    function aggregateStatus(stop) {
        if (typeof window.getStopAggregateStatus === 'function') return window.getStopAggregateStatus(stop);
        const packages = stop.packages || [];
        const delivered = packages.filter(function (pkg) { return pkg.status === 'Entregue'; }).length;
        const failed = packages.filter(function (pkg) { return pkg.status === 'Insucesso'; }).length;
        if (packages.length && delivered === packages.length) return 'Entregue';
        if (packages.length && failed === packages.length) return 'Insucesso';
        if (delivered || failed) return 'Parcial';
        return 'Pendente';
    }

    function isPendingStop(stop) {
        const status = aggregateStatus(stop);
        return status === 'Pendente' || status === 'Parcial';
    }

    function pendingStops() {
        return getStops().filter(isPendingStop);
    }

    function safeSaveState() {
        try {
            if (typeof window.saveState === 'function') return window.saveState() !== false;
            return false;
        } catch (error) {
            reportError(error, 'Não foi possível salvar o estado local');
            return false;
        }
    }

    function refreshExistingViews(fitBounds) {
        ensurePackageSlotFields();
        try {
            if (typeof window.refreshAllViews === 'function') window.refreshAllViews(!!fitBounds);
            else safeSaveState();
        } catch (error) {
            reportError(error, 'Não foi possível atualizar as telas');
        }
    }

    function focusOnMap(groupId) {
        try {
            if (typeof window.focusStopOnMap === 'function') window.focusStopOnMap(groupId);
        } catch (error) {
            reportError(error, 'Não foi possível abrir o mapa');
        }
    }

    function getSettings() {
        try {
            const parsed = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
            return parsed && typeof parsed === 'object' ? parsed : {};
        } catch (_) {
            return {};
        }
    }

    function persistSettings(settings) {
        localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    }

    function priorityBadge(priority) {
        const normalized = normalizeText(priority || 'normal');
        const value = normalized === 'urgente' ? 'Urgente' : normalized === 'alta' ? 'Alta' : 'Normal';
        const classes = value === 'Urgente'
            ? 'bg-rose-50 text-rose-700 border-rose-200 dark:bg-rose-950 dark:text-rose-300 dark:border-rose-800'
            : value === 'Alta'
                ? 'bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-950 dark:text-amber-300 dark:border-amber-800'
                : 'bg-zinc-100 text-zinc-600 border-zinc-200 dark:bg-zinc-800 dark:text-zinc-300 dark:border-zinc-700';
        return `<span class="inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-bold ${classes}">${esc(value)}</span>`;
    }

    function statusBadge(status) {
        const value = status || 'Pendente';
        const classes = value === 'Entregue'
            ? 'bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950 dark:text-emerald-300 dark:border-emerald-800'
            : value === 'Insucesso'
                ? 'bg-rose-50 text-rose-700 border-rose-200 dark:bg-rose-950 dark:text-rose-300 dark:border-rose-800'
                : value === 'Parcial'
                    ? 'bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-950 dark:text-amber-300 dark:border-amber-800'
                    : 'bg-zinc-100 text-zinc-600 border-zinc-200 dark:bg-zinc-800 dark:text-zinc-300 dark:border-zinc-700';
        return `<span class="inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-bold ${classes}">${esc(value)}</span>`;
    }

    function windowLabel(stop) {
        if (!stop || (!stop.windowStart && !stop.windowEnd)) return 'Sem janela';
        const type = stop.windowType || 'Chegada';
        return `${type}: ${stop.windowStart || '—'}–${stop.windowEnd || '—'}`;
    }

    function getRoutePlan() {
        return typeof activeRoutePlan === 'undefined' ? null : activeRoutePlan;
    }

    function setRoutePlan(plan) {
        activeRoutePlan = plan;
    }

    function ensureRoot() {
        if (root && byId(ROOT_ID)) return root;
        if (!byId(STYLE_ID)) {
            const style = document.createElement('style');
            style.id = STYLE_ID;
            style.textContent = `
                #spxLogisticsRoot { font-family: inherit; }
                #spxLogisticsRoot [hidden] { display: none !important; }
                #spxLogisticsRoot .spx-signature { touch-action: none; user-select: none; }
                #spxLogisticsRoot .spx-thin-scroll { scrollbar-width: thin; }
                #spxLogisticsRoot .spx-thin-scroll::-webkit-scrollbar { width: 6px; height: 6px; }
                #spxLogisticsRoot .spx-thin-scroll::-webkit-scrollbar-thumb { background: rgba(113,113,122,.35); border-radius: 999px; }
                @supports (padding: max(0px)) {
                    #spxLogisticsRoot .spx-safe-bottom { padding-bottom: max(1rem, env(safe-area-inset-bottom)); }
                }
            `;
            document.head.appendChild(style);
        }
        root = byId(ROOT_ID);
        if (!root) {
            root = document.createElement('div');
            root.id = ROOT_ID;
            root.className = 'hidden fixed inset-0 z-[80] bg-zinc-50 text-zinc-900 dark:bg-zinc-950 dark:text-zinc-50';
            document.body.appendChild(root);
        }
        return root;
    }

    function pageHeader(title, subtitle, action) {
        return `
            <header class="sticky top-0 z-20 border-b border-zinc-200/80 bg-zinc-50/95 px-4 py-3 backdrop-blur-xl dark:border-zinc-800 dark:bg-zinc-950/95 sm:px-6">
                <div class="mx-auto flex max-w-6xl items-center gap-3">
                    <button data-action="back-hub" class="shadcn-btn h-10 w-10 shrink-0 border border-zinc-200 bg-white text-zinc-600 hover:bg-zinc-100 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-300" aria-label="Voltar ao hub">${icon('arrow-left')}</button>
                    <div class="min-w-0 flex-1">
                        <h1 class="truncate text-base font-bold tracking-tight sm:text-lg">${esc(title)}</h1>
                        <p class="truncate text-[11px] text-zinc-500 dark:text-zinc-400">${esc(subtitle)}</p>
                    </div>
                    ${action || `<button data-action="close-root" class="shadcn-btn h-10 w-10 shrink-0 border border-zinc-200 bg-white text-zinc-500 hover:bg-zinc-100 dark:border-zinc-800 dark:bg-zinc-900" aria-label="Fechar">${icon('x')}</button>`}
                </div>
            </header>`;
    }

    function modalShell(title, subtitle, body, footer) {
        return `
            <div class="flex min-h-full items-end justify-center bg-zinc-950/55 p-0 backdrop-blur-sm sm:items-center sm:p-4" data-action="modal-backdrop">
                <section class="flex max-h-[96dvh] w-full flex-col overflow-hidden rounded-t-3xl border border-zinc-200 bg-white shadow-2xl dark:border-zinc-800 dark:bg-zinc-900 sm:max-h-[92dvh] sm:max-w-3xl sm:rounded-2xl" role="dialog" aria-modal="true" aria-label="${esc(title)}">
                    <header class="flex items-center gap-3 border-b border-zinc-200 px-4 py-3 dark:border-zinc-800 sm:px-5">
                        <button data-action="back-hub" class="shadcn-btn h-9 w-9 shrink-0 text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800" aria-label="Voltar">${icon('arrow-left')}</button>
                        <div class="min-w-0 flex-1">
                            <h2 class="truncate text-sm font-bold sm:text-base">${esc(title)}</h2>
                            <p class="truncate text-[11px] text-zinc-500 dark:text-zinc-400">${esc(subtitle)}</p>
                        </div>
                        <button data-action="close-root" class="shadcn-btn h-9 w-9 shrink-0 text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800" aria-label="Fechar">${icon('x')}</button>
                    </header>
                    <div class="spx-thin-scroll flex-1 overflow-y-auto p-4 sm:p-5">${body}</div>
                    ${footer || ''}
                </section>
            </div>`;
    }

    function inlineError(id, message) {
        return `<div id="${esc(id)}" class="${message ? '' : 'hidden '}mb-3 rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-xs font-medium text-rose-700 dark:border-rose-900 dark:bg-rose-950/40 dark:text-rose-300" role="alert">${esc(message || '')}</div>`;
    }

    function showInlineError(id, message) {
        const element = byId(id);
        if (!element) return;
        element.textContent = message;
        element.classList.toggle('hidden', !message);
    }

    function setRootContent(content, pointerEvents) {
        ensureRoot();
        root.innerHTML = content;
        root.classList.remove('hidden');
        root.classList.toggle('pointer-events-none', pointerEvents === 'none');
        refreshIcons();
    }

    function routeEtaFor(groupId) {
        const plan = getRoutePlan();
        if (!plan) return null;
        if (plan.stopEtas && plan.stopEtas[String(groupId)]) return plan.stopEtas[String(groupId)];
        if (Array.isArray(plan.schedule)) {
            const scheduled = plan.schedule.find(function (item) { return String(item.stopId) === String(groupId); });
            if (scheduled) {
                if (typeof window.getStopEta === 'function') {
                    const currentEta = window.getStopEta(groupId);
                    if (currentEta) return { eta: currentEta instanceof Date ? currentEta.toISOString() : currentEta };
                }
                return {
                    eta: scheduled.arrivalAt || scheduled.serviceStartAt || '',
                    durationFromStartSeconds: numberValue(scheduled.durationFromStartSeconds),
                    distanceFromStartMeters: numberValue(scheduled.distanceFromStartMeters)
                };
            }
        }
        return null;
    }

    function etaText(groupId) {
        const eta = routeEtaFor(groupId);
        if (!eta) return '—';
        if (typeof eta === 'string') return formatClock(eta);
        if (eta.eta) return formatClock(eta.eta);
        if (Number.isFinite(Number(eta.etaSecondsFromNow))) {
            return formatClock(Date.now() + Number(eta.etaSecondsFromNow) * 1000);
        }
        if (Number.isFinite(Number(eta.durationFromStartSeconds))) {
            return formatClock(Date.now() + Number(eta.durationFromStartSeconds) * 1000);
        }
        return '—';
    }

    function renderHub() {
        ensurePackageSlotFields();
        const stops = getStops();
        const plan = getRoutePlan();
        const planStops = plan && Array.isArray(plan.points)
            ? plan.points.filter(function (point) { return point.groupId; })
            : (plan && Array.isArray(plan.schedule) ? plan.schedule.map(function (item) { return { groupId: item.stopId }; }) : []);
        const planDistance = plan ? numberValue(plan.totalDistanceMeters != null ? plan.totalDistanceMeters : (plan.metrics && (plan.metrics.distanceMeters != null ? plan.metrics.distanceMeters : plan.metrics.distance))) : 0;
        const planDuration = plan ? numberValue(plan.totalDurationSeconds != null ? plan.totalDurationSeconds : (plan.metrics && (plan.metrics.durationSec != null ? plan.metrics.durationSec : plan.metrics.duration))) : 0;
        const settings = getSettings();
        const atId = typeof activeAtId !== 'undefined' && activeAtId ? activeAtId : 'ROMANEIO LOCAL';

        const actionCard = function (action, title, description, iconName, tone) {
            const tones = {
                orange: 'bg-[#EE4D2D] text-white',
                indigo: 'bg-indigo-600 text-white',
                emerald: 'bg-emerald-600 text-white',
                zinc: 'bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-950'
            };
            return `<button data-action="${esc(action)}" class="group rounded-2xl border border-zinc-200 bg-white p-4 text-left shadow-sm transition hover:-translate-y-0.5 hover:border-zinc-300 hover:shadow-md dark:border-zinc-800 dark:bg-zinc-900 dark:hover:border-zinc-700">
                <span class="mb-3 flex h-10 w-10 items-center justify-center rounded-xl ${tones[tone] || tones.zinc}">${icon(iconName, 'w-5 h-5')}</span>
                <span class="block text-sm font-bold">${esc(title)}</span>
                <span class="mt-1 block text-[11px] leading-relaxed text-zinc-500 dark:text-zinc-400">${esc(description)}</span>
            </button>`;
        };

        const routeRows = planStops.length ? planStops.map(function (point, index) {
            const stop = stops.find(function (item) { return String(item.groupId) === String(point.groupId); });
            if (!stop) return '';
            const eta = routeEtaFor(stop.groupId);
            const remaining = eta && Number.isFinite(Number(eta.distanceFromStartMeters))
                ? formatDistance(Math.max(0, planDistance - Number(eta.distanceFromStartMeters)))
                : '';
            return `<button data-action="hub-focus-stop" data-group-id="${esc(stop.groupId)}" class="flex w-full items-center gap-3 rounded-xl border border-zinc-200 px-3 py-2.5 text-left transition hover:bg-zinc-50 dark:border-zinc-800 dark:hover:bg-zinc-800/50">
                <span class="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-zinc-900 text-[11px] font-bold text-white dark:bg-zinc-100 dark:text-zinc-950">${index + 1}</span>
                <span class="min-w-0 flex-1">
                    <span class="flex items-center gap-1.5">${priorityBadge(stop.priority)}${statusBadge(aggregateStatus(stop))}<span class="truncate text-xs font-semibold">${esc(stop.primaryAddress)}</span></span>
                    <span class="mt-1 block truncate text-[10px] text-zinc-500">${esc(windowLabel(stop))}${remaining ? ` · ${remaining}` : ''}</span>
                </span>
                <span class="shrink-0 text-right"><span class="block text-[10px] text-zinc-400">ETA</span><span class="block text-xs font-bold">${esc(etaText(stop.groupId))}</span></span>
            </button>`;
        }).join('') : '';

        setRootContent(`
            <div class="min-h-full overflow-y-auto spx-thin-scroll">
                ${pageHeader('SPX Logistics', `${atId} · operação local`, `<button data-action="close-root" class="shadcn-btn h-10 px-3 text-xs font-semibold text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800">Voltar ao app</button>`)}
                <main class="mx-auto max-w-6xl px-4 py-5 sm:px-6 sm:py-7">
                    ${navState.active ? `<button data-action="resume-navigation" class="mb-5 flex w-full items-center gap-3 rounded-2xl border border-orange-200 bg-orange-50 p-4 text-left dark:border-orange-900 dark:bg-orange-950/40">
                        <span class="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-[#EE4D2D] text-white">${icon('navigation')}</span>
                        <span class="min-w-0 flex-1"><span class="block text-sm font-bold text-orange-900 dark:text-orange-200">Navegação integrada em andamento</span><span class="block truncate text-[11px] text-orange-700 dark:text-orange-300">Toque para retomar a manobra atual.</span></span>${icon('chevron-right')}
                    </button>` : ''}

                    <section class="mb-6">
                        <div class="mb-3 flex items-end justify-between gap-3">
                            <div><h3 class="text-sm font-bold">Ações operacionais</h3><p class="text-[11px] text-zinc-500">Fluxos disponíveis neste aparelho, sem backend.</p></div>
                            <span class="rounded-full border border-zinc-200 bg-white px-2.5 py-1 text-[10px] font-semibold text-zinc-500 dark:border-zinc-800 dark:bg-zinc-900">${icon('hard-drive', 'inline w-3 h-3 mr-1')} Local</span>
                        </div>
                        <div class="grid grid-cols-2 gap-3 md:grid-cols-3">
                            ${actionCard('open-address', 'Nova entrega', 'Cadastre pacote, endereço, prioridade e janela.', 'package-plus', 'orange')}
                            ${actionCard('open-finder', 'Localizador de pacotes', 'Busque por SPX TN, recebedor ou endereço.', 'package-search', 'indigo')}
                            ${actionCard('open-load', 'Carga do veículo', 'Organize cada pacote por zona e posição.', 'truck', 'emerald')}
                            ${actionCard('open-transfer', 'Transferir paradas', 'Envie ou importe paradas por link, QR ou arquivo.', 'send', 'zinc')}
                            ${actionCard('start-navigation', 'Navegação integrada', 'Roteie até 25 paradas com GPS e ETA.', 'navigation', 'orange')}
                            ${actionCard('open-settings', 'Configurações', 'Chave Google Routes e identidade do motorista.', 'settings', 'zinc')}
                        </div>
                    </section>

                    <section class="mb-6 rounded-2xl border border-dashed border-zinc-300 bg-zinc-100/60 p-4 dark:border-zinc-700 dark:bg-zinc-900/50">
                        <div class="flex items-start gap-3">
                            <span class="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-zinc-200 text-zinc-500 dark:bg-zinc-800">${icon('users')}</span>
                            <div class="min-w-0 flex-1"><div class="flex flex-wrap items-center gap-2"><h3 class="text-sm font-bold">Equipes</h3><span class="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-bold text-amber-800 dark:bg-amber-950 dark:text-amber-300">Fase com servidor</span></div><p class="mt-1 text-[11px] leading-relaxed text-zinc-500">Gestão de equipes, sincronização e compartilhamento em tempo real estarão disponíveis quando o servidor for conectado. Nesta versão, a operação é individual e local.</p></div>
                        </div>
                    </section>

                    ${plan ? `<section class="rounded-2xl border border-zinc-200 bg-white p-4 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
                        <div class="mb-3 flex flex-wrap items-center justify-between gap-2">
                            <div><h3 class="text-sm font-bold">Plano de rota e ETA</h3><p class="text-[11px] text-zinc-500">${esc(plan.provider || 'auto')} · ${formatDistance(planDistance)} · ${formatDuration(planDuration)}</p></div>
                            <span class="rounded-full bg-zinc-100 px-2.5 py-1 text-[10px] font-semibold text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">${plan.trafficAware ? 'Trânsito considerado' : 'Estimativa sem trânsito'}</span>
                        </div>
                        <div class="space-y-2">${routeRows || '<p class="text-xs text-zinc-500">Nenhuma parada neste plano.</p>'}</div>
                    </section>` : ''}

                    <p class="mt-6 text-center text-[10px] text-zinc-400">${esc(settings.driverName || 'Motorista local')} · ${esc(settings.teamId || 'equipe-local')} · dados salvos somente no dispositivo</p>
                </main>
            </div>`, 'auto');
    }

    function openHub() {
        if (!initialized) init();
        if (autocompleteTimer) clearTimeout(autocompleteTimer);
        if (autocompleteController) autocompleteController.abort();
        autocompleteTimer = null;
        autocompleteController = null;
        addressState = null;
        podState = null;
        renderHub();
    }

    function defaultAddressValues() {
        const settings = getSettings();
        return {
            spxTn: '',
            recipient: '',
            phone: '',
            address: '',
            bairro: '',
            city: '',
            zipcode: '',
            priority: 'Normal',
            serviceMinutes: String(settings.defaultServiceMinutes || 5),
            windowStart: '',
            windowEnd: '',
            windowType: 'Chegada',
            notes: ''
        };
    }

    function fieldHtml(name, label, value, options) {
        const config = options || {};
        const required = config.required ? 'required' : '';
        const inputMode = config.inputMode ? `inputmode="${esc(config.inputMode)}"` : '';
        const placeholder = config.placeholder ? `placeholder="${esc(config.placeholder)}"` : '';
        const type = config.type || 'text';
        const autocomplete = config.autocomplete ? `autocomplete="${esc(config.autocomplete)}"` : '';
        const control = type === 'select'
            ? `<select name="${esc(name)}" ${required} class="h-11 w-full rounded-xl border border-zinc-200 bg-white px-3 text-sm outline-none transition focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/15 dark:border-zinc-700 dark:bg-zinc-950">${(config.options || []).map(function (option) { return `<option value="${esc(option)}" ${String(option) === String(value) ? 'selected' : ''}>${esc(option)}</option>`; }).join('')}</select>`
            : `<input name="${esc(name)}" type="${esc(type)}" value="${esc(value)}" ${required} ${inputMode} ${placeholder} ${autocomplete} class="h-11 w-full rounded-xl border border-zinc-200 bg-white px-3 text-sm outline-none transition placeholder:text-zinc-400 focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/15 dark:border-zinc-700 dark:bg-zinc-950">`;
        return `<label class="block">
            <span class="mb-1.5 flex items-center gap-1 text-[11px] font-bold text-zinc-600 dark:text-zinc-300">${esc(label)}${config.required ? ' <span class="text-[#EE4D2D]">*</span>' : ''}${config.voice ? `<button type="button" data-action="voice-input" data-field="${esc(name)}" class="ml-auto inline-flex h-7 items-center gap-1 rounded-lg px-2 text-[10px] font-semibold text-indigo-600 hover:bg-indigo-50 dark:text-indigo-400 dark:hover:bg-indigo-950" aria-label="Ditar ${esc(label)}">${icon('mic', 'w-3.5 h-3.5')} Voz</button>` : ''}</span>
            ${control}
        </label>`;
    }

    function renderAddressModal(error) {
        const state = addressState;
        const suggestions = state.suggestions.map(function (item, index) {
            return `<button type="button" data-action="select-address" data-index="${index}" class="flex w-full items-start gap-3 px-3 py-2.5 text-left transition hover:bg-indigo-50 dark:hover:bg-indigo-950/40">
                <span class="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-indigo-50 text-indigo-600 dark:bg-indigo-950 dark:text-indigo-300">${icon('map-pin', 'w-4 h-4')}</span>
                <span class="min-w-0 flex-1"><span class="block truncate text-xs font-semibold">${esc(item.label)}</span><span class="block truncate text-[10px] text-zinc-500">${esc(item.secondary)}</span></span>
            </button>`;
        }).join('');

        const body = `
            ${inlineError('spxAddressError', error || '')}
            <form data-action="address-form" id="spxAddressForm" class="space-y-4">
                <div class="rounded-2xl border border-indigo-200 bg-indigo-50/60 p-3 dark:border-indigo-900 dark:bg-indigo-950/30">
                    <div class="flex flex-wrap items-center gap-2">
                        <button type="button" data-action="ocr-address" class="shadcn-btn h-10 bg-indigo-600 px-3 text-xs font-semibold text-white hover:bg-indigo-700">${icon('scan-line', 'w-4 h-4')} Ler etiqueta por foto</button>
                        <span class="text-[11px] leading-relaxed text-indigo-700 dark:text-indigo-300">A leitura preenche SPX TN, CEP e linha de endereço. Revise antes de salvar.</span>
                    </div>
                    <input type="file" accept="image/*" capture="environment" class="hidden" data-purpose="address-label">
                    ${state.ocrText ? `<details class="mt-3 rounded-xl bg-white/70 p-3 dark:bg-zinc-950/50"><summary class="cursor-pointer text-[11px] font-bold text-indigo-700 dark:text-indigo-300">Texto reconhecido para revisão</summary><pre class="mt-2 max-h-32 overflow-auto whitespace-pre-wrap break-words font-sans text-[11px] leading-relaxed text-zinc-600 dark:text-zinc-300">${esc(state.ocrText)}</pre></details>` : ''}
                </div>

                <div class="grid gap-3 sm:grid-cols-2">
                    ${fieldHtml('spxTn', 'SPX TN', state.values.spxTn, { required: true, placeholder: 'BR...', voice: true })}
                    ${fieldHtml('recipient', 'Recebedor', state.values.recipient, { placeholder: 'Nome de quem vai receber', voice: true })}
                    ${fieldHtml('phone', 'Telefone', state.values.phone, { type: 'tel', inputMode: 'tel', placeholder: '(00) 00000-0000', voice: true })}
                    ${fieldHtml('priority', 'Prioridade', state.values.priority, { type: 'select', options: ['Normal', 'Alta', 'Urgente'] })}
                </div>

                <div class="relative">
                    ${fieldHtml('address', 'Endereço completo', state.values.address, { required: true, placeholder: 'Rua, número, complemento', voice: true, autocomplete: 'street-address' })}
                    <div id="spxAddressSuggestions" class="${state.suggestions.length ? '' : 'hidden '}absolute left-0 right-0 top-full z-30 mt-1 overflow-hidden rounded-xl border border-zinc-200 bg-white shadow-xl dark:border-zinc-700 dark:bg-zinc-900">${suggestions}</div>
                </div>
                <div id="spxAddressLookupStatus" class="text-[11px] text-zinc-500">${esc(state.lookupStatus || 'O autocomplete Photon busca enquanto você digita.')}</div>

                <div class="grid gap-3 sm:grid-cols-2">
                    ${fieldHtml('bairro', 'Bairro', state.values.bairro, { required: true, voice: true })}
                    ${fieldHtml('city', 'Cidade', state.values.city, { required: true, voice: true })}
                    ${fieldHtml('zipcode', 'CEP', state.values.zipcode, { required: true, inputMode: 'numeric', placeholder: '00000-000', voice: true })}
                    ${fieldHtml('serviceMinutes', 'Minutos de serviço', state.values.serviceMinutes, { required: true, type: 'number', inputMode: 'numeric' })}
                    ${fieldHtml('windowStart', 'Janela — início', state.values.windowStart, { type: 'time' })}
                    ${fieldHtml('windowEnd', 'Janela — fim', state.values.windowEnd, { type: 'time' })}
                </div>
                <label class="block">
                    <span class="mb-1.5 block text-[11px] font-bold text-zinc-600 dark:text-zinc-300">Tipo da janela</span>
                    <select name="windowType" class="h-11 w-full rounded-xl border border-zinc-200 bg-white px-3 text-sm outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/15 dark:border-zinc-700 dark:bg-zinc-950">
                        <option value="Chegada" ${state.values.windowType === 'Chegada' ? 'selected' : ''}>Chegada</option>
                        <option value="Conclusão" ${state.values.windowType === 'Conclusão' ? 'selected' : ''}>Conclusão</option>
                    </select>
                </label>
                <label class="block">
                    <span class="mb-1.5 flex items-center gap-1 text-[11px] font-bold text-zinc-600 dark:text-zinc-300">Observações<button type="button" data-action="voice-input" data-field="notes" class="ml-auto inline-flex h-7 items-center gap-1 rounded-lg px-2 text-[10px] font-semibold text-indigo-600 hover:bg-indigo-50 dark:text-indigo-400 dark:hover:bg-indigo-950">${icon('mic', 'w-3.5 h-3.5')} Voz</button></span>
                    <textarea name="notes" rows="3" placeholder="Ponto de referência, instruções de acesso, ligar antes..." class="w-full resize-y rounded-xl border border-zinc-200 bg-white px-3 py-2.5 text-sm outline-none placeholder:text-zinc-400 focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/15 dark:border-zinc-700 dark:bg-zinc-950">${esc(state.values.notes)}</textarea>
                </label>
                <div class="spx-safe-bottom flex flex-col-reverse gap-2 border-t border-zinc-200 pt-4 dark:border-zinc-800 sm:flex-row sm:justify-end">
                    <button type="button" data-action="back-hub" class="shadcn-btn h-11 border border-zinc-200 bg-white px-4 text-xs font-semibold text-zinc-600 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-300">Cancelar</button>
                    <button type="submit" id="spxAddressSave" class="shadcn-btn h-11 bg-[#EE4D2D] px-5 text-xs font-bold text-white hover:bg-[#d63f22] disabled:opacity-50">${icon('save', 'w-4 h-4')} Salvar e geocodificar</button>
                </div>
            </form>`;

        setRootContent(modalShell('Nova entrega', 'Cadastro local de pacote e parada', body), 'auto');
    }

    function openAddressModal() {
        if (autocompleteTimer) clearTimeout(autocompleteTimer);
        if (autocompleteController) autocompleteController.abort();
        addressState = {
            values: defaultAddressValues(),
            suggestions: [],
            selectedCoords: null,
            lookupStatus: '',
            ocrText: '',
            busy: false
        };
        renderAddressModal();
    }

    function syncAddressForm(form) {
        if (!addressState || !form) return;
        const locationFields = ['address', 'bairro', 'city', 'zipcode'];
        locationFields.forEach(function (name) {
            const input = form.elements[name];
            if (!input) return;
            if (addressState.values[name] !== input.value) addressState.selectedCoords = null;
            addressState.values[name] = input.value;
        });
        ['spxTn', 'recipient', 'phone', 'priority', 'serviceMinutes', 'windowStart', 'windowEnd', 'windowType', 'notes'].forEach(function (name) {
            const input = form.elements[name];
            if (input) addressState.values[name] = input.value;
        });
    }

    function photonProperties(feature) {
        const properties = feature.properties || {};
        const geometry = feature.geometry || {};
        const coords = geometry.coordinates || [];
        const street = properties.street || properties.name || '';
        const houseNumber = properties.housenumber || properties.house_number || '';
        const line = [street, houseNumber].filter(Boolean).join(', ');
        const district = properties.district || properties.suburb || properties.neighbourhood || properties.city || '';
        const city = properties.city || properties.town || properties.village || properties.municipality || '';
        const postcode = properties.postcode || '';
        const label = [line, district, city, postcode].filter(Boolean).join(' · ');
        return {
            label: label || street || 'Endereço selecionado',
            secondary: [properties.state, properties.country].filter(Boolean).join(' · '),
            address: line || street,
            bairro: district,
            city,
            zipcode: postcode,
            lat: Number(coords[1]),
            lng: Number(coords[0])
        };
    }

    async function searchPhoton(query) {
        if (!addressState) return;
        const token = ++autocompleteToken;
        if (autocompleteController) autocompleteController.abort();
        autocompleteController = new AbortController();
        addressState.lookupStatus = 'Buscando endereços no Photon...';
        const status = byId('spxAddressLookupStatus');
        if (status) status.textContent = addressState.lookupStatus;
        try {
            const response = await fetch(`https://photon.komoot.io/api/?lang=pt&limit=5&q=${encodeURIComponent(query)}`, { signal: autocompleteController.signal });
            if (!response.ok) throw new Error(`Photon respondeu ${response.status}`);
            const data = await response.json();
            if (token !== autocompleteToken || !addressState) return;
            addressState.suggestions = (data.features || []).map(photonProperties).filter(function (item) {
                return Number.isFinite(item.lat) && Number.isFinite(item.lng);
            });
            addressState.lookupStatus = addressState.suggestions.length
                ? 'Selecione uma sugestão para preencher e fixar a localização.'
                : 'Nenhuma sugestão encontrada. Revise o endereço e tente novamente.';
            renderAddressSuggestions();
        } catch (error) {
            if (error.name === 'AbortError' || token !== autocompleteToken) return;
            if (!addressState) return;
            addressState.suggestions = [];
            addressState.lookupStatus = `Autocomplete indisponível: ${errorMessage(error)}. Você ainda pode salvar para geocodificar.`;
            renderAddressSuggestions();
        }
    }

    function renderAddressSuggestions() {
        const box = byId('spxAddressSuggestions');
        const status = byId('spxAddressLookupStatus');
        if (!addressState || !box) return;
        box.innerHTML = addressState.suggestions.map(function (item, index) {
            return `<button type="button" data-action="select-address" data-index="${index}" class="flex w-full items-start gap-3 px-3 py-2.5 text-left transition hover:bg-indigo-50 dark:hover:bg-indigo-950/40">
                <span class="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-indigo-50 text-indigo-600 dark:bg-indigo-950 dark:text-indigo-300">${icon('map-pin', 'w-4 h-4')}</span>
                <span class="min-w-0 flex-1"><span class="block truncate text-xs font-semibold">${esc(item.label)}</span><span class="block truncate text-[10px] text-zinc-500">${esc(item.secondary)}</span></span>
            </button>`;
        }).join('');
        box.classList.toggle('hidden', !addressState.suggestions.length);
        if (status) status.textContent = addressState.lookupStatus || '';
        refreshIcons();
    }

    function scheduleAddressSearch(form) {
        if (!addressState) return;
        syncAddressForm(form);
        addressState.suggestions = [];
        renderAddressSuggestions();
        if (autocompleteTimer) clearTimeout(autocompleteTimer);
        const query = [addressState.values.address, addressState.values.bairro, addressState.values.city, addressState.values.zipcode]
            .map(function (value) { return String(value || '').trim(); })
            .filter(Boolean)
            .join(', ');
        if (query.length < 3) return;
        autocompleteTimer = setTimeout(function () { searchPhoton(query); }, 380);
    }

    function selectAddress(index) {
        if (!addressState) return;
        const selected = addressState.suggestions[Number(index)];
        if (!selected) return;
        ['address', 'bairro', 'city', 'zipcode'].forEach(function (name) {
            if (selected[name]) addressState.values[name] = selected[name];
        });
        addressState.selectedCoords = { lat: selected.lat, lng: selected.lng };
        addressState.suggestions = [];
        addressState.lookupStatus = 'Localização selecionada. Revise os campos antes de salvar.';
        renderAddressModal();
        notify('Endereço selecionado no Photon.', 'success');
    }

    function registerBridgeCallback(prefix, callback) {
        const name = `__spxLogistics_${prefix}_${makeId('cb').replace(/[^A-Za-z0-9_]/g, '_')}`;
        window[name] = function () {
            try { callback.apply(window, arguments); } finally { delete window[name]; }
        };
        return name;
    }

    function bridgeText(args) {
        if (!args || !args.length) return '';
        let value = args[0];
        if (args.length > 1 && typeof value === 'string' && value.length > 200) value = args[args.length - 1];
        if (value && typeof value === 'object') {
            return value.text || value.rawText || value.label || value.result || value.value || value.code || JSON.stringify(value);
        }
        return value == null ? '' : String(value);
    }

    function startVoiceInput(fieldName) {
        if (!window.SPXAndroid || typeof window.SPXAndroid.startVoiceInput !== 'function') {
            notify('Entrada por voz disponível apenas no aplicativo Android.', 'error');
            return;
        }
        const callback = registerBridgeCallback('voice', function () {
            const form = byId('spxAddressForm');
            const input = form && form.elements[fieldName];
            if (!input || !addressState) return;
            input.value = bridgeText(arguments).trim();
            if (fieldName === 'spxTn') input.value = input.value.toUpperCase();
            syncAddressForm(form);
            input.focus();
            notify('Texto ditado inserido. Revise antes de continuar.', 'success');
        });
        try {
            window.SPXAndroid.startVoiceInput(callback);
        } catch (error) {
            delete window[callback];
            reportError(error, 'Não foi possível iniciar a voz');
        }
    }

    function extractLabelText(rawText) {
        const text = String(rawText || '');
        const normalized = text.replace(/\r/g, '');
        const spxMatch = normalized.match(/\bBR[A-Z0-9]{8,}\b/i);
        const cepMatch = normalized.match(/\b\d{5}[-.\s]?\d{3}\b/);
        const lines = normalized.split('\n').map(function (line) { return line.trim(); }).filter(Boolean);
        let address = '';
        const streetPattern = /(^|\s)(rua|r\.|avenida|av\.?|travessa|tv\.|alameda|praça|praca|estrada|rodovia|via|viela|beco|passeio|marginal)\b/i;
        for (const line of lines) {
            if (streetPattern.test(line) && /\d/.test(line)) {
                address = line.replace(/^\s*(endereço|destino|destinatário|entrega)\s*:?\s*/i, '').replace(/\b\d{5}[-.\s]?\d{3}\b/g, '').trim();
                break;
            }
        }
        if (!address) {
            for (const line of lines) {
                if (/\bBR[A-Z0-9]{8,}\b/i.test(line) || /\b\d{5}[-.\s]?\d{3}\b/.test(line)) continue;
                if (line.length >= 8 && /\d/.test(line) && !/recebedor|telefone|nome|cep/i.test(line)) {
                    address = line.replace(/^\s*(endereço|destino|entrega)\s*:?\s*/i, '').trim();
                    break;
                }
            }
        }
        return {
            rawText: text,
            spxTn: spxMatch ? spxMatch[0].toUpperCase() : '',
            zipcode: cepMatch ? cepMatch[0].replace(/\D/g, '').replace(/^(\d{5})(\d{3})$/, '$1-$2') : '',
            address
        };
    }

    function readFileAsDataUrl(file) {
        return new Promise(function (resolve, reject) {
            const reader = new FileReader();
            reader.onload = function () { resolve(String(reader.result || '')); };
            reader.onerror = function () { reject(new Error('Não foi possível ler a imagem.')); };
            reader.readAsDataURL(file);
        });
    }

    function compressImage(file, maxSize, quality) {
        return new Promise(function (resolve, reject) {
            const objectUrl = URL.createObjectURL(file);
            const image = new Image();
            image.onload = function () {
                try {
                    const scale = Math.min(1, (maxSize || 1280) / Math.max(image.naturalWidth, image.naturalHeight));
                    const width = Math.max(1, Math.round(image.naturalWidth * scale));
                    const height = Math.max(1, Math.round(image.naturalHeight * scale));
                    const canvas = document.createElement('canvas');
                    canvas.width = width;
                    canvas.height = height;
                    const context = canvas.getContext('2d');
                    if (!context) throw new Error('Canvas indisponível neste dispositivo.');
                    context.fillStyle = '#ffffff';
                    context.fillRect(0, 0, width, height);
                    context.drawImage(image, 0, 0, width, height);
                    resolve(canvas.toDataURL('image/jpeg', quality == null ? 0.78 : quality));
                } catch (error) {
                    reject(error);
                } finally {
                    URL.revokeObjectURL(objectUrl);
                }
            };
            image.onerror = function () {
                URL.revokeObjectURL(objectUrl);
                reject(new Error('A imagem selecionada não pôde ser aberta.'));
            };
            image.src = objectUrl;
        });
    }

    async function recognizeAddressPhoto(file) {
        if (!file) return;
        if (!window.SPXAndroid || typeof window.SPXAndroid.recognizeLabel !== 'function') {
            notify('OCR de etiqueta disponível apenas no aplicativo Android.', 'error');
            return;
        }
        showInlineError('spxAddressError', '');
        const oldLabel = byId('spxAddressOcrStatus');
        if (oldLabel) oldLabel.textContent = 'Comprimindo e lendo a etiqueta...';
        try {
            const dataUrl = await compressImage(file, 1280, 0.78);
            const base64 = dataUrl.split(',')[1];
            const callback = registerBridgeCallback('ocr', function () {
                if (!addressState) return;
                const extracted = extractLabelText(bridgeText(arguments));
                if (extracted.spxTn) addressState.values.spxTn = extracted.spxTn;
                if (extracted.zipcode) addressState.values.zipcode = extracted.zipcode;
                if (extracted.address) addressState.values.address = extracted.address;
                addressState.selectedCoords = null;
                addressState.ocrText = extracted.rawText || 'Nenhum texto reconhecido.';
                addressState.lookupStatus = 'Texto da etiqueta preenchido. Revise os campos e selecione uma sugestão se necessário.';
                renderAddressModal();
                if (extracted.spxTn || extracted.zipcode || extracted.address) notify('Etiqueta lida. Revise os dados extraídos.', 'success');
                else notify('Nenhum dado útil foi reconhecido na etiqueta.', 'error');
            });
            window.SPXAndroid.recognizeLabel(base64, callback);
        } catch (error) {
            reportError(error, 'Não foi possível ler a etiqueta');
        }
    }

    async function saveAddress(form) {
        if (!addressState || addressState.busy) return;
        syncAddressForm(form);
        const values = addressState.values;
        const spxTn = String(values.spxTn || '').trim().toUpperCase();
        const zipcode = String(values.zipcode || '').replace(/\D/g, '').slice(0, 8);
        const serviceMinutes = Number(values.serviceMinutes);
        if (!/^BR[A-Z0-9]{8,}$/i.test(spxTn)) {
            showInlineError('spxAddressError', 'Informe um SPX TN válido começando com BR.');
            return;
        }
        if (!String(values.address || '').trim() || !String(values.bairro || '').trim() || !String(values.city || '').trim() || zipcode.length !== 8) {
            showInlineError('spxAddressError', 'Preencha endereço, bairro, cidade e CEP com 8 dígitos.');
            return;
        }
        if (!Number.isFinite(serviceMinutes) || serviceMinutes < 1 || serviceMinutes > 240) {
            showInlineError('spxAddressError', 'Os minutos de serviço devem estar entre 1 e 240.');
            return;
        }
        const duplicate = allPackages().find(function (item) { return String(item.pkg.spxTn || '').toUpperCase() === spxTn; });
        if (duplicate) {
            showInlineError('spxAddressError', 'Este SPX TN já está cadastrado no romaneio.');
            return;
        }

        addressState.busy = true;
        const saveButton = byId('spxAddressSave');
        if (saveButton) saveButton.disabled = true;
        showInlineError('spxAddressError', '');
        let optimizationWarning = '';
        try {
            let coords = validCoords(addressState.selectedCoords) ? addressState.selectedCoords : null;
            if (!validCoords(coords) && typeof window.geocodeAddress === 'function') {
                coords = await window.geocodeAddress(values.address, values.bairro, values.city, zipcode);
            }
            if (!validCoords(coords)) {
                throw new Error('Não foi possível geocodificar o endereço. Revise os dados ou selecione uma sugestão Photon. Nenhuma parada foi criada.');
            }

            const pkgId = makeId('pkg');
            const groupId = `UNASSIGNED_${Date.now()}_${pkgId}`;
            const now = new Date().toISOString();
            const settings = getSettings();
            const sequence = allPackages().reduce(function (max, item) { return Math.max(max, Number(item.pkg.sequence) || 0); }, 0) + 1;
            const formattedZip = zipcode.replace(/^(\d{5})(\d{3})$/, '$1-$2');
            const pkg = {
                id: pkgId,
                atId: typeof activeAtId !== 'undefined' && activeAtId ? activeAtId : 'ROMANEIO LOCAL',
                sequence,
                stopRaw: '-',
                stopNumeric: null,
                spxTn,
                address: String(values.address).trim(),
                bairro: String(values.bairro).trim(),
                city: String(values.city).trim(),
                zipcode: formattedZip,
                lat: Number(coords.lat),
                lng: Number(coords.lng),
                approx: false,
                status: 'Pendente',
                deliveredAt: '',
                recipient: String(values.recipient || '').trim(),
                phone: String(values.phone || '').trim(),
                priority: values.priority || 'Normal',
                serviceMinutes,
                windowStart: values.windowStart || '',
                windowEnd: values.windowEnd || '',
                windowType: values.windowType || 'Chegada',
                vehicleSlot: '',
                slotZone: '',
                slotPosition: '',
                notes: String(values.notes || '').trim(),
                teamId: settings.teamId || 'equipe-local',
                driverId: settings.driverId || 'motorista-local',
                createdAt: now
            };
            const stop = {
                groupId,
                stopLabel: '-',
                stopNumeric: null,
                isUnassignedStop: true,
                primaryAddress: pkg.address,
                bairro: pkg.bairro,
                city: pkg.city,
                zipcode: pkg.zipcode,
                lat: pkg.lat,
                lng: pkg.lng,
                minSequence: sequence,
                approx: false,
                recipient: pkg.recipient,
                phone: pkg.phone,
                priority: pkg.priority,
                serviceMinutes: pkg.serviceMinutes,
                windowStart: pkg.windowStart,
                windowEnd: pkg.windowEnd,
                windowType: pkg.windowType,
                vehiclePosition: '',
                notes: pkg.notes,
                packages: [pkg],
                createdAt: now
            };
            if (window.normalizeStopDeliveryFields) normalizeStopDeliveryFields(stop);
            getStops().push(stop);
            getSnapshot().push(clone(stop));
            if (typeof activeAtId !== 'undefined' && !activeAtId) activeAtId = 'ROMANEIO LOCAL';
            activeRoutePlan = null;
            if (getStops().length >= 2 && typeof window.optimizePendingFrom === 'function') {
                try {
                    const start = typeof window.getRouteOrigin === 'function' ? window.getRouteOrigin() : hubLocation;
                    await window.optimizePendingFrom(start, undefined, 'do ponto de partida', true);
                } catch (error) {
                    optimizationWarning = ' A otimização automática falhou; use Reorganizar para tentar novamente.';
                }
            }
            refreshExistingViews(false);
            addressState = null;
            renderHub();
            notify('Entrega cadastrada e geocodificada com sucesso.' + optimizationWarning, optimizationWarning ? 'info' : 'success');
        } catch (error) {
            const message = reportError(error, 'Não foi possível salvar a entrega');
            showInlineError('spxAddressError', message);
        } finally {
            if (addressState) addressState.busy = false;
            const button = byId('spxAddressSave');
            if (button) button.disabled = false;
        }
    }

    function packageMatchesQuery(pkg, stop, query) {
        if (!query) return true;
        const needle = normalizeText(query);
        return [pkg.spxTn, pkg.recipient, pkg.address, pkg.bairro, pkg.city, stop.primaryAddress, stop.stopLabel]
            .some(function (value) { return normalizeText(value).includes(needle); });
    }

    function finderResults() {
        const query = finderState.query.trim();
        return allPackages().filter(function (item) { return packageMatchesQuery(item.pkg, item.stop, query); });
    }

    function renderFinderResults() {
        const container = byId('spxFinderResults');
        if (!container) return;
        const results = finderResults().slice(0, queryLimit());
        finderState.results = results;
        if (!results.length) {
            container.innerHTML = `<div class="rounded-2xl border border-dashed border-zinc-300 p-8 text-center dark:border-zinc-700"><span class="mx-auto mb-3 flex h-11 w-11 items-center justify-center rounded-xl bg-zinc-100 text-zinc-400 dark:bg-zinc-800">${icon('package-search', 'w-5 h-5')}</span><p class="text-xs font-semibold">Nenhum pacote encontrado</p><p class="mt-1 text-[11px] text-zinc-500">Tente outro SPX TN, recebedor ou endereço.</p></div>`;
            return;
        }
        container.innerHTML = results.map(function (item) {
            const slot = packageSlot(item.pkg);
            return `<article class="rounded-2xl border border-zinc-200 bg-white p-3.5 dark:border-zinc-800 dark:bg-zinc-950">
                <div class="flex items-start gap-3">
                    <span class="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-zinc-100 font-mono text-xs font-bold text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">${item.stopIndex + 1}</span>
                    <div class="min-w-0 flex-1">
                        <div class="flex flex-wrap items-center gap-1.5"><span class="break-all font-mono text-xs font-bold text-[#EE4D2D]">${esc(item.pkg.spxTn)}</span>${statusBadge(item.pkg.status)}${priorityBadge(item.stop.priority || item.pkg.priority)}</div>
                        <p class="mt-1.5 truncate text-xs font-semibold">${esc(item.pkg.address || item.stop.primaryAddress)}</p>
                        <p class="mt-0.5 truncate text-[11px] text-zinc-500">${esc(item.pkg.recipient || 'Recebedor não informado')} · ${esc(item.pkg.bairro || item.stop.bairro)}</p>
                        <p class="mt-1 text-[10px] text-zinc-400">${slot.label ? `Carga: ${esc(slot.label)}` : 'Sem posição de carga'} · ${esc(windowLabel(item.stop))}</p>
                    </div>
                </div>
                <div class="mt-3 grid grid-cols-3 gap-2">
                    <button data-action="finder-map" data-group-id="${esc(item.stop.groupId)}" class="shadcn-btn h-9 border border-zinc-200 bg-white text-[11px] font-semibold text-zinc-600 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300">${icon('map-pin', 'inline w-3.5 h-3.5 mr-1')} Mapa</button>
                    <button data-action="finder-load" data-group-id="${esc(item.stop.groupId)}" data-pkg-id="${esc(item.pkg.id)}" class="shadcn-btn h-9 border border-zinc-200 bg-white text-[11px] font-semibold text-zinc-600 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300">${icon('truck', 'inline w-3.5 h-3.5 mr-1')} Carga</button>
                    <button data-action="finder-pod" data-group-id="${esc(item.stop.groupId)}" data-pkg-id="${esc(item.pkg.id)}" class="shadcn-btn h-9 bg-zinc-900 text-[11px] font-semibold text-white dark:bg-zinc-100 dark:text-zinc-950">${icon('file-check-2', 'inline w-3.5 h-3.5 mr-1')} POD</button>
                </div>
            </article>`;
        }).join('');
        refreshIcons();
    }

    function queryLimit() {
        return finderState.query.trim() ? 80 : 40;
    }

    function openPackageFinder() {
        finderState = { query: finderState.query || '', results: [] };
        const body = `
            <div class="mb-4 rounded-2xl border border-zinc-200 bg-zinc-50 p-3 dark:border-zinc-800 dark:bg-zinc-950">
                <label class="relative block">
                    <span class="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-zinc-400">${icon('search')}</span>
                    <input id="spxFinderSearch" type="search" value="${esc(finderState.query)}" placeholder="SPX TN, recebedor ou endereço" class="h-12 w-full rounded-xl border border-zinc-200 bg-white pl-10 pr-24 text-sm outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/15 dark:border-zinc-700 dark:bg-zinc-900">
                    <button type="button" data-action="scan-code" data-purpose="finder-code" class="absolute right-1.5 top-1.5 shadcn-btn h-9 bg-indigo-600 px-2.5 text-[11px] font-semibold text-white">${icon('camera', 'w-3.5 h-3.5')} Foto</button>
                </label>
                <input type="file" accept="image/*" capture="environment" class="hidden" data-purpose="finder-code">
                <p class="mt-2 text-[10px] text-zinc-500">A busca considera todos os pacotes, inclusive entregues e insucessos.</p>
            </div>
            <div id="spxFinderResults" class="space-y-3"></div>`;
        setRootContent(modalShell('Localizador de pacotes', 'Busca local por código, recebedor ou endereço', body), 'auto');
        renderFinderResults();
        setTimeout(function () { const input = byId('spxFinderSearch'); if (input) input.focus(); }, 60);
    }

    async function scanPackageCode(file, purpose) {
        if (!file) return;
        if (!window.SPXAndroid || typeof window.SPXAndroid.scanBarcode !== 'function') {
            notify('Leitura de código por foto disponível apenas no aplicativo Android.', 'error');
            return;
        }
        try {
            const dataUrl = await compressImage(file, 1600, 0.82);
            const base64 = dataUrl.split(',')[1];
            const callback = registerBridgeCallback('barcode', function () {
                const raw = bridgeText(arguments).trim();
                const match = raw.match(/\bBR[A-Z0-9]{8,}\b/i);
                const code = (match ? match[0] : raw).toUpperCase();
                if (!code) {
                    notify('Nenhum código foi reconhecido na foto.', 'error');
                    return;
                }
                if (purpose === 'load-code') {
                    loadState.query = code;
                    renderLoadModal();
                } else {
                    finderState.query = code;
                    const input = byId('spxFinderSearch');
                    if (input) input.value = code;
                    renderFinderResults();
                }
                notify(`Código ${code} selecionado.`, 'success');
            });
            window.SPXAndroid.scanBarcode(base64, callback);
        } catch (error) {
            reportError(error, 'Não foi possível ler o código');
        }
    }

    function packageZone(pkg) {
        return packageSlot(pkg).zone;
    }

    function zoneCount(zone) {
        return allPackages().filter(function (item) { return packageZone(item.pkg) === zone; }).length;
    }

    function renderVehicleDiagram() {
        const zoneButton = function (zone, classes, label) {
            const count = zoneCount(zone);
            const active = loadState.zone === zone;
            return `<button type="button" data-action="select-load-zone" data-zone="${esc(zone)}" class="relative flex min-h-[74px] flex-col items-center justify-center rounded-xl border p-2 text-center transition ${active ? 'border-[#EE4D2D] bg-orange-50 ring-2 ring-[#EE4D2D]/20 dark:bg-orange-950/40' : 'border-zinc-300 bg-zinc-50 hover:bg-zinc-100 dark:border-zinc-700 dark:bg-zinc-950 dark:hover:bg-zinc-800'}">
                <span class="text-[10px] font-bold leading-tight">${esc(label || zone)}</span>
                <span class="mt-1 rounded-full bg-white px-2 py-0.5 text-[10px] font-bold text-zinc-500 shadow-sm dark:bg-zinc-800">${count} pct${count === 1 ? '' : 's'}</span>
            </button>`;
        };
        return `<div class="mx-auto max-w-sm rounded-[28px] border-2 border-zinc-300 bg-zinc-100 p-3 dark:border-zinc-700 dark:bg-zinc-800">
            <div class="mb-2 flex items-center justify-between text-[9px] font-bold uppercase tracking-widest text-zinc-400"><span>Frente</span>${icon('move-up', 'w-3.5 h-3.5')}</div>
            <div class="grid grid-cols-2 gap-2">
                ${zoneButton('Banco dianteiro', '', 'Banco dianteiro')}
                ${zoneButton('Banco traseiro', '', 'Banco traseiro')}
                ${zoneButton('Porta-malas esquerdo', '', 'Porta-malas esquerdo')}
                ${zoneButton('Porta-malas direito', '', 'Porta-malas direito')}
            </div>
            <div class="my-2 border-t border-dashed border-zinc-300 dark:border-zinc-600"></div>
            ${zoneButton('Compartimento traseiro', '', 'Compartimento traseiro')}
            <div class="mt-2 flex items-center justify-center gap-1 text-[9px] font-bold uppercase tracking-widest text-zinc-400">${icon('move-down', 'w-3.5 h-3.5')} Traseira</div>
        </div>`;
    }

    function loadResults() {
        const query = loadState.query.trim();
        return allPackages().filter(function (item) {
            const zone = packageZone(item.pkg);
            const zoneMatch = loadState.zone === 'Todas' || loadState.zone === 'Sem zona' ? (loadState.zone === 'Todas' || !zone) : zone === loadState.zone;
            return zoneMatch && packageMatchesQuery(item.pkg, item.stop, query);
        });
    }

    function renderLoadResults() {
        const container = byId('spxLoadResults');
        if (!container) return;
        const results = loadResults();
        if (!results.length) {
            container.innerHTML = `<p class="rounded-xl border border-dashed border-zinc-300 p-6 text-center text-xs text-zinc-500 dark:border-zinc-700">Nenhum pacote nesta zona ou busca.</p>`;
            return;
        }
        container.innerHTML = results.map(function (item) {
            const slot = packageSlot(item.pkg);
            return `<article class="flex items-center gap-3 rounded-xl border border-zinc-200 p-3 dark:border-zinc-800">
                <span class="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${slot.zone ? 'bg-emerald-50 text-emerald-600 dark:bg-emerald-950 dark:text-emerald-300' : 'bg-zinc-100 text-zinc-400 dark:bg-zinc-800'}">${icon(slot.zone ? 'package-check' : 'package', 'w-4 h-4')}</span>
                <div class="min-w-0 flex-1"><p class="break-all font-mono text-[11px] font-bold">${esc(item.pkg.spxTn)}</p><p class="truncate text-[11px] text-zinc-500">${esc(item.pkg.recipient || item.stop.primaryAddress)}</p><p class="mt-0.5 truncate text-[10px] ${slot.zone ? 'text-emerald-600 dark:text-emerald-400' : 'text-amber-600 dark:text-amber-400'}">${slot.label ? esc(slot.label) : 'Sem zona definida'}</p></div>
                <button data-action="edit-slot" data-group-id="${esc(item.stop.groupId)}" data-pkg-id="${esc(item.pkg.id)}" class="shadcn-btn h-9 w-9 shrink-0 border border-zinc-200 bg-white text-zinc-500 dark:border-zinc-700 dark:bg-zinc-950" aria-label="Editar posição de ${esc(item.pkg.spxTn)}">${icon('pencil', 'w-3.5 h-3.5')}</button>
            </article>`;
        }).join('');
        refreshIcons();
    }

    function renderLoadModal(error) {
        const assigned = allPackages().filter(function (item) { return !!packageZone(item.pkg); }).length;
        const total = allPackages().length;
        const body = `
            ${inlineError('spxLoadError', error || '')}
            <div class="grid gap-5 lg:grid-cols-[minmax(280px,0.9fr)_minmax(320px,1.1fr)]">
                <section>
                    <div class="mb-3 flex items-center justify-between"><div><h3 class="text-sm font-bold">Mapa da carga</h3><p class="text-[11px] text-zinc-500">Toque em uma zona para filtrar.</p></div><span class="rounded-full bg-emerald-50 px-2.5 py-1 text-[10px] font-bold text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300">${assigned}/${total} posicionados</span></div>
                    ${renderVehicleDiagram()}
                    <div class="mt-3 flex flex-wrap gap-2">
                        <button data-action="select-load-zone" data-zone="Todas" class="rounded-full border px-3 py-1.5 text-[10px] font-bold ${loadState.zone === 'Todas' ? 'border-zinc-900 bg-zinc-900 text-white dark:border-zinc-100 dark:bg-zinc-100 dark:text-zinc-950' : 'border-zinc-200 bg-white text-zinc-500 dark:border-zinc-700 dark:bg-zinc-900'}">Todas</button>
                        <button data-action="select-load-zone" data-zone="Sem zona" class="rounded-full border px-3 py-1.5 text-[10px] font-bold ${loadState.zone === 'Sem zona' ? 'border-zinc-900 bg-zinc-900 text-white dark:border-zinc-100 dark:bg-zinc-100 dark:text-zinc-950' : 'border-zinc-200 bg-white text-zinc-500 dark:border-zinc-700 dark:bg-zinc-900'}">Sem zona</button>
                    </div>
                </section>
                <section>
                    <label class="relative mb-3 block">
                        <span class="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-zinc-400">${icon('search')}</span>
                        <input id="spxLoadSearch" type="search" value="${esc(loadState.query)}" placeholder="Buscar SPX TN, recebedor ou endereço" class="h-11 w-full rounded-xl border border-zinc-200 bg-white pl-10 pr-24 text-xs outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/15 dark:border-zinc-700 dark:bg-zinc-950">
                        <button type="button" data-action="scan-code" data-purpose="load-code" class="absolute right-1.5 top-1.5 shadcn-btn h-8 bg-indigo-600 px-2.5 text-[10px] font-semibold text-white">${icon('camera', 'w-3.5 h-3.5')} Foto</button>
                    </label>
                    <input type="file" accept="image/*" capture="environment" class="hidden" data-purpose="load-code">
                    <div id="spxLoadResults" class="spx-thin-scroll max-h-[46dvh] space-y-2 overflow-y-auto pr-1"></div>
                </section>
            </div>`;
        setRootContent(modalShell('Carga do veículo', 'Posicione os pacotes para agilizar a entrega', body), 'auto');
        renderLoadResults();
    }

    function openLoad(query) {
        loadState = { query: query || loadState.query || '', zone: query ? 'Todas' : (loadState.zone || 'Todas') };
        renderLoadModal();
    }

    function openSlotEditor(groupId, pkgId) {
        const found = findPackage(groupId, pkgId);
        if (!found) {
            notify('Pacote não encontrado.', 'error');
            return;
        }
        const zone = packageZone(found.pkg);
        const options = VEHICLE_ZONES.map(function (item) {
            return `<option value="${esc(item)}" ${item === zone ? 'selected' : ''}>${esc(item)}</option>`;
        }).join('');
        const body = `
            <form data-action="slot-form" class="space-y-4">
                <input type="hidden" name="groupId" value="${esc(groupId)}">
                <input type="hidden" name="pkgId" value="${esc(pkgId)}">
                <div class="rounded-xl bg-zinc-50 p-3 dark:bg-zinc-950"><p class="break-all font-mono text-xs font-bold text-[#EE4D2D]">${esc(found.pkg.spxTn)}</p><p class="mt-1 truncate text-[11px] text-zinc-500">${esc(found.pkg.address || found.stop.primaryAddress)}</p></div>
                ${inlineError('spxSlotError', '')}
                <label class="block"><span class="mb-1.5 block text-[11px] font-bold">Zona do veículo *</span><select name="zone" required class="h-11 w-full rounded-xl border border-zinc-200 bg-white px-3 text-sm dark:border-zinc-700 dark:bg-zinc-950"><option value="">Selecione a zona</option>${options}</select></label>
                <label class="block"><span class="mb-1.5 block text-[11px] font-bold">Posição na zona</span><input name="position" value="${esc(found.pkg.slotPosition || '')}" maxlength="40" placeholder="Ex.: A1, fundo, próximo à porta" class="h-11 w-full rounded-xl border border-zinc-200 bg-white px-3 text-sm dark:border-zinc-700 dark:bg-zinc-950"><span class="mt-1 block text-[10px] text-zinc-500">Use uma referência curta para encontrar o pacote rapidamente.</span></label>
                <div class="flex justify-end gap-2 border-t border-zinc-200 pt-4 dark:border-zinc-800"><button type="button" data-action="back-load" class="shadcn-btn h-10 border border-zinc-200 px-4 text-xs font-semibold dark:border-zinc-700">Cancelar</button><button type="submit" class="shadcn-btn h-10 bg-emerald-600 px-4 text-xs font-bold text-white">${icon('save', 'w-4 h-4')} Salvar posição</button></div>
            </form>`;
        setRootContent(modalShell('Editar posição na carga', found.pkg.spxTn, body), 'auto');
    }

    function saveSlot(form) {
        const groupId = form.elements.groupId.value;
        const pkgId = form.elements.pkgId.value;
        const zone = form.elements.zone.value;
        const position = String(form.elements.position.value || '').trim();
        const found = findPackage(groupId, pkgId);
        if (!found || !VEHICLE_ZONES.includes(zone)) {
            showInlineError('spxSlotError', 'Selecione uma zona válida do veículo.');
            return;
        }
        found.pkg.slotZone = zone;
        found.pkg.slotPosition = position;
        found.pkg.vehicleSlot = position ? `${zone} · ${position}` : zone;
        found.pkg.vehiclePosition = found.pkg.vehicleSlot;
        ensurePackageSlotFields();
        safeSaveState();
        renderLoadModal();
        notify('Posição de carga atualizada.', 'success');
    }

    function signaturePoint(event, canvas) {
        const rect = canvas.getBoundingClientRect();
        return {
            x: (event.clientX - rect.left) * canvas.width / Math.max(1, rect.width),
            y: (event.clientY - rect.top) * canvas.height / Math.max(1, rect.height)
        };
    }

    function beginSignature(event) {
        if (!podState || event.target.id !== 'spxSignatureCanvas') return;
        event.preventDefault();
        const canvas = event.target;
        const context = canvas.getContext('2d');
        if (!context) return;
        podState.drawing = true;
        podState.pointerId = event.pointerId;
        podState.lastPoint = signaturePoint(event, canvas);
        podState.hasSignature = true;
        try { canvas.setPointerCapture(event.pointerId); } catch (_) {}
        context.beginPath();
        context.arc(podState.lastPoint.x, podState.lastPoint.y, 1.8, 0, Math.PI * 2);
        context.fillStyle = '#18181b';
        context.fill();
        byId('spxSignatureHint')?.classList.add('hidden');
    }

    function moveSignature(event) {
        if (!podState || !podState.drawing || event.pointerId !== podState.pointerId) return;
        event.preventDefault();
        const canvas = byId('spxSignatureCanvas');
        if (!canvas) return;
        const context = canvas.getContext('2d');
        if (!context) return;
        const point = signaturePoint(event, canvas);
        context.beginPath();
        context.moveTo(podState.lastPoint.x, podState.lastPoint.y);
        context.lineTo(point.x, point.y);
        context.strokeStyle = '#18181b';
        context.lineWidth = 3.2;
        context.lineCap = 'round';
        context.lineJoin = 'round';
        context.stroke();
        podState.lastPoint = point;
    }

    function endSignature(event) {
        if (!podState || !podState.drawing || event.pointerId !== podState.pointerId) return;
        podState.drawing = false;
        const canvas = byId('spxSignatureCanvas');
        if (canvas) {
            try { canvas.releasePointerCapture(event.pointerId); } catch (_) {}
            podState.signatureData = canvas.toDataURL('image/png');
        }
    }

    function podPackageList(state) {
        return state.pkgIds.map(function (id) { return findPackage(state.groupId, id); }).filter(Boolean);
    }

    function renderPOD(error) {
        const state = podState;
        const found = findPackage(state.groupId, state.pkgIds[0]);
        if (!found) {
            notify('Parada do POD não encontrada.', 'error');
            openHub();
            return;
        }
        const isFailure = state.status === 'Insucesso';
        const body = `
            ${inlineError('spxPodError', error || '')}
            <form data-action="pod-form" id="spxPodForm" class="space-y-4">
                <div class="rounded-2xl border border-zinc-200 bg-zinc-50 p-3 dark:border-zinc-800 dark:bg-zinc-950">
                    <div class="flex flex-wrap items-center gap-2"><span class="text-xs font-bold">Stop ${esc(found.stop.stopLabel || '—')}</span>${statusBadge(state.status)}<span class="text-[11px] text-zinc-500">${state.pkgIds.length} pacote(s)</span></div>
                    <p class="mt-1 truncate text-xs font-semibold">${esc(found.stop.primaryAddress)}</p>
                    <p class="mt-1 break-all font-mono text-[10px] text-zinc-500">${esc(podPackageList(state).map(function (item) { return item.pkg.spxTn; }).join(' · '))}</p>
                </div>

                <div class="grid grid-cols-2 gap-2 rounded-xl bg-zinc-100 p-1 dark:bg-zinc-800">
                    <label class="flex h-10 cursor-pointer items-center justify-center gap-2 rounded-lg text-xs font-bold ${!isFailure ? 'bg-white text-emerald-700 shadow-sm dark:bg-zinc-950 dark:text-emerald-300' : 'text-zinc-500'}"><input type="radio" name="podStatus" value="Entregue" ${!isFailure ? 'checked' : ''} class="accent-emerald-600">${icon('check-circle-2', 'w-4 h-4')} Entrega</label>
                    <label class="flex h-10 cursor-pointer items-center justify-center gap-2 rounded-lg text-xs font-bold ${isFailure ? 'bg-white text-rose-700 shadow-sm dark:bg-zinc-950 dark:text-rose-300' : 'text-zinc-500'}"><input type="radio" name="podStatus" value="Insucesso" ${isFailure ? 'checked' : ''} class="accent-rose-600">${icon('x-circle', 'w-4 h-4')} Insucesso</label>
                </div>

                <div id="spxFailureReasonWrap" class="${isFailure ? '' : 'hidden '}">
                    <label class="block"><span class="mb-1.5 block text-[11px] font-bold">Motivo do insucesso *</span><select name="failureReason" ${isFailure ? 'required' : ''} class="h-11 w-full rounded-xl border border-zinc-200 bg-white px-3 text-sm dark:border-zinc-700 dark:bg-zinc-950"><option value="">Selecione o motivo</option>${FAILURE_REASONS.map(function (reason) { return `<option value="${esc(reason)}">${esc(reason)}</option>`; }).join('')}</select></label>
                </div>

                <label class="block"><span class="mb-1.5 block text-[11px] font-bold">Recebedor (opcional)</span><input name="recipient" value="${esc(state.recipient || '')}" placeholder="Nome completo de quem recebeu" class="h-11 w-full rounded-xl border border-zinc-200 bg-white px-3 text-sm dark:border-zinc-700 dark:bg-zinc-950"></label>

                <div>
                    <div class="mb-1.5 flex items-center justify-between gap-2"><span class="text-[11px] font-bold">Assinatura (opcional)</span><button type="button" data-action="clear-signature" class="text-[10px] font-semibold text-zinc-500 hover:text-rose-600">Limpar</button></div>
                    <div class="relative overflow-hidden rounded-2xl border-2 border-dashed border-zinc-300 bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-950">
                        <canvas id="spxSignatureCanvas" width="900" height="320" class="spx-signature block h-40 w-full cursor-crosshair bg-white" aria-label="Área de assinatura"></canvas>
                        <span id="spxSignatureHint" class="pointer-events-none absolute inset-0 flex items-center justify-center text-xs text-zinc-400">${icon('pen-line', 'w-5 h-5 mr-2')} Assine com o dedo ou ponteiro</span>
                    </div>
                    <p class="mt-1 text-[10px] text-zinc-500">Preencha somente se desejar registrar um comprovante. A entrega pode ser concluída sem recebedor, assinatura ou foto.</p>
                </div>

                <label class="block"><span class="mb-1.5 block text-[11px] font-bold">Justificativa de recebedor ausente (opcional)</span><textarea name="absentJustification" rows="2" placeholder="Use quando quiser registrar a ausência do recebedor" class="w-full resize-y rounded-xl border border-zinc-200 bg-white px-3 py-2.5 text-sm dark:border-zinc-700 dark:bg-zinc-950">${esc(state.absentJustification || '')}</textarea></label>

                <div class="grid gap-3 sm:grid-cols-2">
                    <div>
                        <span class="mb-1.5 block text-[11px] font-bold">Foto do comprovante (opcional)</span>
                        <button type="button" data-action="pod-photo" class="shadcn-btn h-11 w-full border border-zinc-200 bg-white text-xs font-semibold text-zinc-600 dark:border-zinc-700 dark:bg-zinc-950">${icon('camera', 'w-4 h-4')} Tirar ou escolher foto</button>
                        <input type="file" accept="image/*" capture="environment" class="hidden" data-purpose="pod-photo">
                        <p class="mt-1 text-[10px] text-zinc-500">JPEG, maior lado até 1280 px.</p>
                    </div>
                    <div id="spxPhotoPreview" class="${state.photoData ? '' : 'hidden '}relative overflow-hidden rounded-xl border border-zinc-200 bg-zinc-100 dark:border-zinc-700 dark:bg-zinc-950">
                        ${state.photoData ? `<img src="${esc(state.photoData)}" alt="Prévia da foto do comprovante" class="h-28 w-full object-cover"><button type="button" data-action="remove-photo" class="absolute right-2 top-2 flex h-8 w-8 items-center justify-center rounded-full bg-zinc-950/70 text-white" aria-label="Remover foto">${icon('x', 'w-4 h-4')}</button>` : ''}
                    </div>
                </div>

                <label class="block"><span class="mb-1.5 block text-[11px] font-bold">Observações</span><textarea name="notes" rows="3" placeholder="Informações adicionais sobre a entrega ou insucesso" class="w-full resize-y rounded-xl border border-zinc-200 bg-white px-3 py-2.5 text-sm dark:border-zinc-700 dark:bg-zinc-950">${esc(state.notes || '')}</textarea></label>

                <div class="spx-safe-bottom flex flex-col-reverse gap-2 border-t border-zinc-200 pt-4 dark:border-zinc-800 sm:flex-row sm:justify-end">
                    <button type="button" data-action="close-pod" class="shadcn-btn h-11 border border-zinc-200 bg-white px-4 text-xs font-semibold text-zinc-600 dark:border-zinc-700 dark:bg-zinc-950">Cancelar</button>
                    <button type="submit" id="spxPodSave" class="shadcn-btn h-11 ${isFailure ? 'bg-rose-600 hover:bg-rose-700' : 'bg-emerald-600 hover:bg-emerald-700'} px-5 text-xs font-bold text-white disabled:opacity-50">${icon('file-check-2', 'w-4 h-4')} ${isFailure ? 'Registrar insucesso' : 'Concluir entrega'}</button>
                </div>
            </form>`;
        setRootContent(modalShell(isFailure ? 'Registrar insucesso' : 'Concluir entrega', 'O comprovante é opcional; o status é alterado ao salvar.', body), 'auto');
    }

    function openPOD(groupId, pkgIds, status) {
        const stop = getStops().find(function (item) { return String(item.groupId) === String(groupId); });
        if (!stop) {
            notify('Parada não encontrada para registrar o POD.', 'error');
            return;
        }
        let ids = Array.isArray(pkgIds) ? pkgIds.map(String) : [];
        if (!ids.length) ids = (stop.packages || []).filter(function (pkg) { return pkg.status !== 'Entregue' && pkg.status !== 'Insucesso'; }).map(function (pkg) { return String(pkg.id); });
        ids = ids.filter(function (id, index) { return ids.indexOf(id) === index && stop.packages.some(function (pkg) { return String(pkg.id) === id; }); });
        if (!ids.length) {
            notify('Não há pacotes selecionados para o POD.', 'error');
            return;
        }
        podState = {
            groupId: String(groupId),
            pkgIds: ids,
            status: status === 'Insucesso' ? 'Insucesso' : 'Entregue',
            recipient: '',
            absentJustification: '',
            notes: '',
            signatureData: '',
            hasSignature: false,
            photoData: '',
            drawing: false,
            pointerId: null,
            lastPoint: null,
            saving: false
        };
        renderPOD();
    }

    function updatePodMode(status) {
        if (!podState) return;
        podState.status = status;
        const wrap = byId('spxFailureReasonWrap');
        const select = byId('spxPodForm')?.elements.failureReason;
        if (wrap) wrap.classList.toggle('hidden', status !== 'Insucesso');
        if (select) select.required = status === 'Insucesso';
        const save = byId('spxPodSave');
        if (save) {
            save.classList.toggle('bg-rose-600', status === 'Insucesso');
            save.classList.toggle('hover:bg-rose-700', status === 'Insucesso');
            save.classList.toggle('bg-emerald-600', status !== 'Insucesso');
            save.classList.toggle('hover:bg-emerald-700', status !== 'Insucesso');
        }
        document.querySelectorAll('#spxPodForm label').forEach(function (label) {
            const radio = label.querySelector('input[name="podStatus"]');
            if (!radio) return;
            const active = radio.checked;
            label.classList.toggle('bg-white', active);
            label.classList.toggle('dark:bg-zinc-950', active);
            label.classList.toggle('shadow-sm', active);
            label.classList.toggle('text-emerald-700', active && radio.value === 'Entregue');
            label.classList.toggle('dark:text-emerald-300', active && radio.value === 'Entregue');
            label.classList.toggle('text-rose-700', active && radio.value === 'Insucesso');
            label.classList.toggle('dark:text-rose-300', active && radio.value === 'Insucesso');
            label.classList.toggle('text-zinc-500', !active);
        });
    }

    async function savePOD(form) {
        if (!podState || podState.saving) return;
        const state = podState;
        const status = form.elements.podStatus.value === 'Insucesso' ? 'Insucesso' : 'Entregue';
        const recipient = String(form.elements.recipient.value || '').trim();
        const absentJustification = String(form.elements.absentJustification.value || '').trim();
        const failureReason = status === 'Insucesso' ? String(form.elements.failureReason.value || '').trim() : '';
        const notes = String(form.elements.notes.value || '').trim();
        if (status === 'Insucesso' && !failureReason) {
            showInlineError('spxPodError', 'Selecione o motivo do insucesso.');
            return;
        }
        if ((state.signatureData || state.photoData) && (!window.SPXStore || typeof window.SPXStore.putEvidence !== 'function')) {
            showInlineError('spxPodError', 'O armazenamento local de comprovantes está indisponível. Remova a assinatura e a foto ou tente novamente.');
            return;
        }

        state.saving = true;
        state.status = status;
        state.recipient = recipient;
        state.absentJustification = absentJustification;
        state.notes = notes;
        const button = byId('spxPodSave');
        if (button) button.disabled = true;
        showInlineError('spxPodError', '');
        const savedEvidenceIds = [];
        let committed = false;
        let rollback = null;
        try {
            const stop = getStops().find(function (item) { return String(item.groupId) === state.groupId; });
            if (!stop) throw new Error('A parada foi removida antes de salvar o POD.');
            const packages = state.pkgIds.map(function (id) {
                return stop.packages.find(function (item) { return String(item.id) === String(id); });
            });
            if (!packages.length || packages.some(function (pkg) { return !pkg; })) {
                throw new Error('Um pacote foi removido antes de salvar o POD.');
            }
            const previousPackageData = packages.map(function (pkg) {
                return {
                    status: pkg.status,
                    deliveredAt: pkg.deliveredAt,
                    recipient: pkg.recipient,
                    pod: pkg.pod,
                    failureReason: pkg.failureReason,
                    absentJustification: pkg.absentJustification,
                    notes: pkg.notes
                };
            });
            const previousStopData = {
                pod: stop.pod,
                podPackageIds: stop.podPackageIds,
                lastPodAt: stop.lastPodAt
            };
            rollback = { stop, packages, previousPackageData, previousStopData };
            const previousEvidenceIds = new Set(packages.reduce(function (ids, pkg) {
                return ids.concat((pkg.pod && pkg.pod.evidenceIds) || []);
            }, []));
            const completedAt = new Date().toISOString();
            const evidence = [];
            if (state.signatureData) {
                evidence.push({
                    id: makeId('signature'),
                    type: 'signature',
                    mimeType: 'image/png',
                    data: state.signatureData,
                    groupId: state.groupId,
                    stopId: state.groupId,
                    packageIds: state.pkgIds.slice(),
                    status,
                    createdAt: completedAt
                });
            }
            if (state.photoData) {
                evidence.push({
                    id: makeId('photo'),
                    type: 'photo',
                    mimeType: 'image/jpeg',
                    data: state.photoData,
                    groupId: state.groupId,
                    stopId: state.groupId,
                    packageIds: state.pkgIds.slice(),
                    status,
                    createdAt: completedAt
                });
            }
            for (const record of evidence) {
                await window.SPXStore.putEvidence(record);
                savedEvidenceIds.push(record.id);
            }
            const signatureEvidence = evidence.find(function (record) { return record.type === 'signature'; });
            const photoEvidence = evidence.find(function (record) { return record.type === 'photo'; });
            const metadata = {
                status,
                recipient,
                absentJustification,
                failureReason,
                notes,
                completedAt,
                evidenceIds: evidence.map(function (record) { return record.id; }),
                signatureEvidenceId: signatureEvidence ? signatureEvidence.id : '',
                photoEvidenceId: photoEvidence ? photoEvidence.id : ''
            };
            packages.forEach(function (pkg) {
                pkg.status = status;
                pkg.deliveredAt = completedAt;
                pkg.recipient = recipient;
                pkg.pod = clone(metadata);
                pkg.failureReason = status === 'Insucesso' ? failureReason : '';
                pkg.absentJustification = status === 'Insucesso' ? absentJustification : '';
                if (notes) pkg.notes = notes;
            });
            stop.pod = clone(metadata);
            stop.podPackageIds = [...new Set([...(stop.podPackageIds || []), ...state.pkgIds])]
                .filter(function (id) { return stop.packages.some(function (pkg) { return String(pkg.id) === String(id); }); });
            stop.lastPodAt = completedAt;
            if (!safeSaveState()) throw new Error('Não foi possível salvar a conclusão no dispositivo. Libere espaço e tente novamente.');
            committed = true;
            const retainedEvidenceIds = new Set(stop.packages.reduce(function (ids, pkg) {
                return ids.concat((pkg.pod && pkg.pod.evidenceIds) || []);
            }, []));
            if (window.SPXStore && typeof window.SPXStore.deleteEvidence === 'function') {
                await Promise.all([...previousEvidenceIds].filter(function (id) { return !retainedEvidenceIds.has(id); })
                    .map(function (id) { return window.SPXStore.deleteEvidence(id); })).catch(() => {});
            }
            refreshExistingViews(false);
            podState = null;
            if (navState.active) {
                drawNavigationPolyline();
                renderNavigation();
                rerouteNavigation('Rota recalculada após a conclusão da parada.');
            } else {
                renderHub();
            }
            notify(status === 'Entregue' ? 'Entrega concluída.' : 'Insucesso registrado.', 'success');
        } catch (error) {
            if (!committed && rollback) {
                const { stop, packages, previousPackageData, previousStopData } = rollback;
                packages.forEach(function (pkg, index) {
                    const previous = previousPackageData[index];
                    pkg.status = previous.status;
                    pkg.deliveredAt = previous.deliveredAt;
                    pkg.recipient = previous.recipient;
                    pkg.pod = previous.pod;
                    pkg.failureReason = previous.failureReason;
                    pkg.absentJustification = previous.absentJustification;
                    pkg.notes = previous.notes;
                });
                stop.pod = previousStopData.pod;
                stop.podPackageIds = previousStopData.podPackageIds;
                stop.lastPodAt = previousStopData.lastPodAt;
                await Promise.all(savedEvidenceIds.map(function (id) { return window.SPXStore.deleteEvidence(id); })).catch(() => {});
                refreshExistingViews(false);
            }
            const message = reportError(error, 'Não foi possível salvar a conclusão');
            showInlineError('spxPodError', committed ? `${message} A conclusão foi salva, mas a tela pode precisar ser atualizada.` : `${message} O status não foi alterado.`);
        } finally {
            if (podState) podState.saving = false;
            const saveButton = byId('spxPodSave');
            if (saveButton) saveButton.disabled = false;
        }
    }

    function closePOD() {
        podState = null;
        if (navState.active) renderNavigation();
        else renderHub();
    }

    async function loadGoogleKey() {
        let bridgeValue = '';
        if (window.SPXAndroid && typeof window.SPXAndroid.getGoogleRoutesKey === 'function') {
            try { bridgeValue = await window.SPXAndroid.getGoogleRoutesKey(); } catch (_) {}
        }
        if (bridgeValue) return String(bridgeValue).trim();
        try {
            const localKey = (localStorage.getItem(GOOGLE_KEY_STORAGE) || '').trim();
            if (localKey) return localKey;
        } catch (_) {}
        const settings = getSettings();
        return settings.googleRoutesKey ? String(settings.googleRoutesKey).trim() : '';
    }

    async function saveGoogleKey(key) {
        const value = String(key || '').trim();
        let bridgeSaved = false;
        if (window.SPXAndroid && typeof window.SPXAndroid.saveGoogleRoutesKey === 'function') {
            try {
                await window.SPXAndroid.saveGoogleRoutesKey(value);
                bridgeSaved = true;
            } catch (_) {}
        }
        try {
            if (bridgeSaved) localStorage.removeItem(GOOGLE_KEY_STORAGE);
            else localStorage.setItem(GOOGLE_KEY_STORAGE, value);
        } catch (_) {}
        const settings = getSettings();
        delete settings.googleRoutesKey;
        persistSettings(settings);
        return bridgeSaved;
    }

    function openSettings() {
        const settings = getSettings();
        const body = `
            ${inlineError('spxSettingsError', '')}
            <form data-action="settings-form" class="space-y-4">
                <section class="rounded-2xl border border-zinc-200 p-4 dark:border-zinc-800">
                    <div class="mb-3 flex items-center gap-2">${icon('key-round', 'w-4 h-4 text-indigo-600')}<h3 class="text-sm font-bold">Google Routes</h3></div>
                    <label class="block"><span class="mb-1.5 block text-[11px] font-bold">Chave de API</span><span class="relative block"><input id="spxGoogleRoutesKey" name="googleRoutesKey" type="password" value="${esc(settings.googleRoutesKey || '')}" autocomplete="off" placeholder="Cole a chave do Google Routes" class="h-11 w-full rounded-xl border border-zinc-200 bg-white px-3 pr-20 text-sm outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/15 dark:border-zinc-700 dark:bg-zinc-950"><button type="button" data-action="toggle-key" class="absolute right-1.5 top-1.5 shadcn-btn h-8 px-2 text-[10px] font-semibold text-zinc-500">Mostrar</button></span><span class="mt-1 block text-[10px] leading-relaxed text-zinc-500">No Android, a chave fica apenas nas preferências privadas do aplicativo. No navegador, é usada apenas a persistência local.</span></label>
                </section>
                <section class="grid gap-3 sm:grid-cols-2">
                    ${fieldHtml('teamId', 'Team ID', settings.teamId || 'equipe-local', { required: true })}
                    ${fieldHtml('driverId', 'Driver ID', settings.driverId || 'motorista-local', { required: true })}
                    ${fieldHtml('driverName', 'Nome do motorista', settings.driverName || 'Motorista local', { required: true })}
                    ${fieldHtml('defaultServiceMinutes', 'Serviço padrão (min)', settings.defaultServiceMinutes || 5, { required: true, type: 'number', inputMode: 'numeric' })}
                </section>
                <div class="spx-safe-bottom flex justify-end gap-2 border-t border-zinc-200 pt-4 dark:border-zinc-800"><button type="button" data-action="back-hub" class="shadcn-btn h-10 border border-zinc-200 px-4 text-xs font-semibold dark:border-zinc-700">Cancelar</button><button type="submit" class="shadcn-btn h-10 bg-indigo-600 px-5 text-xs font-bold text-white">${icon('save', 'w-4 h-4')} Salvar configurações</button></div>
            </form>`;
        setRootContent(modalShell('Configurações', 'Preferências locais do SPX Logistics', body), 'auto');
        loadGoogleKey().then(function (key) {
            const input = byId('spxGoogleRoutesKey');
            if (input && key) input.value = key;
        }).catch(function (error) { reportError(error, 'Não foi possível ler a chave do bridge'); });
    }

    async function saveSettings(form) {
        const key = String(form.elements.googleRoutesKey.value || '').trim();
        const defaultServiceMinutes = Number(form.elements.defaultServiceMinutes.value);
        if (!String(form.elements.teamId.value || '').trim() || !String(form.elements.driverId.value || '').trim() || !String(form.elements.driverName.value || '').trim()) {
            showInlineError('spxSettingsError', 'Preencha Team ID, Driver ID e nome do motorista.');
            return;
        }
        if (!Number.isFinite(defaultServiceMinutes) || defaultServiceMinutes < 1 || defaultServiceMinutes > 240) {
            showInlineError('spxSettingsError', 'O serviço padrão deve estar entre 1 e 240 minutos.');
            return;
        }
        try {
            const bridgeSaved = await saveGoogleKey(key);
            const settings = {
                ...getSettings(),
                teamId: String(form.elements.teamId.value).trim(),
                driverId: String(form.elements.driverId.value).trim(),
                driverName: String(form.elements.driverName.value).trim(),
                defaultServiceMinutes
            };
            persistSettings(settings);
            renderHub();
            notify(bridgeSaved ? 'Configurações salvas no Android e localmente.' : 'Configurações salvas localmente.', 'success');
        } catch (error) {
            const message = reportError(error, 'Não foi possível salvar as configurações');
            showInlineError('spxSettingsError', message);
        }
    }

    const GOOGLE_ROUTE_PATHS = new Set([
        '/distanceMatrix/v2:computeRouteMatrix',
        '/directions/v2:computeRoutes'
    ]);

    function normalizeGoogleEndpoint(url) {
        const value = String(url || '').trim();
        if (!value) throw new Error('Endpoint do Google Routes não informado.');
        const parsed = new URL(value, 'https://routes.googleapis.com');
        if (parsed.protocol !== 'https:' || parsed.hostname !== 'routes.googleapis.com' ||
            parsed.port || parsed.username || parsed.password) {
            throw new Error('O endpoint deve usar HTTPS em routes.googleapis.com.');
        }
        if (!GOOGLE_ROUTE_PATHS.has(parsed.pathname) || parsed.search || parsed.hash) {
            throw new Error('Endpoint do Google Routes não permitido.');
        }
        return parsed.pathname;
    }

    function normalizeOsrmUrl(url) {
        const parsed = new URL(String(url || ''));
        if (parsed.protocol !== 'https:' || parsed.hostname !== 'router.project-osrm.org' ||
            parsed.port || parsed.username || parsed.password || parsed.hash ||
            !/^\/(?:table|route)\/v1\/driving\/[^/]+$/.test(parsed.pathname)) {
            throw new Error('Endpoint OSRM não permitido.');
        }
        return parsed.toString();
    }

    function parseGooglePayload(payload) {
        if (typeof payload === 'string') {
            const text = payload.trim();
            if (!text) return null;
            try { return JSON.parse(text); } catch (_) { return text; }
        }
        return payload;
    }

    function unpackGoogleCallback(args) {
        if (args.length >= 2 && (typeof args[0] === 'string' || typeof args[0] === 'number')) {
            return { id: String(args[0]), value: args[1] };
        }
        if (args.length === 1 && args[0] && typeof args[0] === 'object') {
            const object = args[0];
            const id = object.id || object.requestId || object.callbackId || '';
            const value = object.result != null ? object.result : (object.data != null ? object.data : (object.body != null ? object.body : object));
            return { id: id ? String(id) : '', value };
        }
        return { id: '', value: args[args.length - 1] };
    }

    function finishGoogleRequest(id, error, value) {
        const pending = googleRequests.get(id);
        if (!pending) return;
        googleRequests.delete(id);
        if (pending.timer) clearTimeout(pending.timer);
        if (pending.abortHandler && pending.signal) pending.signal.removeEventListener('abort', pending.abortHandler);
        if (error) pending.reject(error);
        else pending.resolve(parseGooglePayload(value));
    }

    window.SPXGoogleRoutes = {
        onResult: function () {
            const callback = unpackGoogleCallback(arguments);
            if (!callback.id) return;
            finishGoogleRequest(callback.id, null, callback.value);
        },
        onError: function () {
            const callback = unpackGoogleCallback(arguments);
            const message = bridgeText(callback.value && typeof callback.value === 'object' ? [callback.value.message || callback.value.error || callback.value] : [callback.value]);
            const error = new Error(message || 'Falha retornada pelo bridge Google Routes.');
            if (!callback.id) {
                notify(error.message, 'error');
                return;
            }
            finishGoogleRequest(callback.id, error);
        }
    };

    async function googleRequest(options) {
        const config = options || {};
        const method = String(config.method || 'POST').toUpperCase();
        let parsedUrl = null;
        try { parsedUrl = new URL(String(config.url || '')); } catch (_) {}
        if (parsedUrl && parsedUrl.hostname === 'router.project-osrm.org') {
            const url = normalizeOsrmUrl(parsedUrl);
            if (method !== 'GET') throw new Error('Requisições OSRM devem usar GET.');
            if (config.signal && config.signal.aborted) throw Object.assign(new Error('Requisição cancelada.'), { name: 'AbortError' });
            const controller = new AbortController();
            let timedOut = false;
            const timer = setTimeout(function () {
                timedOut = true;
                controller.abort();
            }, 12000);
            const abortHandler = function () { controller.abort(); };
            if (config.signal) config.signal.addEventListener('abort', abortHandler, { once: true });
            let response;
            let text;
            try {
                response = await fetch(url, {
                    method: 'GET',
                    headers: config.headers || {},
                    signal: controller.signal
                });
                text = await response.text();
            } catch (error) {
                if (config.signal && config.signal.aborted) {
                    throw Object.assign(new Error('Requisição cancelada.'), { name: 'AbortError' });
                }
                if (timedOut) throw new Error('OSRM não respondeu no tempo limite.');
                throw error;
            } finally {
                clearTimeout(timer);
                if (config.signal) config.signal.removeEventListener('abort', abortHandler);
            }
            let payload = text;
            try { payload = text ? JSON.parse(text) : null; } catch (_) {}
            if (!response.ok) throw new Error(`OSRM: HTTP ${response.status}`);
            return payload;
        }

        const endpoint = normalizeGoogleEndpoint(config.url);
        if (method !== 'POST') throw new Error('Requisições Google Routes devem usar POST.');
        const suppliedHeaders = new Headers(config.headers || {});
        const key = suppliedHeaders.get('X-Goog-Api-Key') || config.key || config.apiKey || await loadGoogleKey() || '';
        if (!key) throw new Error('Configure a chave do Google Routes antes de usar trânsito em tempo real.');
        const fieldMask = suppliedHeaders.get('X-Goog-FieldMask') || config.fieldMask || '';
        const body = config.body == null ? {} : config.body;
        const bodyString = typeof body === 'string' ? body : JSON.stringify(body);
        const controller = new AbortController();
        const abortHandler = function () {
            const error = new Error('Requisição Google Routes cancelada.');
            error.name = 'AbortError';
            controller.abort();
            if (config.signal) config.signal.removeEventListener('abort', abortHandler);
        };
        if (config.signal) {
            if (config.signal.aborted) throw Object.assign(new Error('Requisição cancelada.'), { name: 'AbortError' });
            config.signal.addEventListener('abort', abortHandler, { once: true });
        }

        if (window.SPXAndroid && typeof window.SPXAndroid.googleRoutesRequest === 'function') {
            return new Promise(function (resolve, reject) {
                const id = `spxgr-${Date.now()}-${++googleRequestCounter}`;
                const timer = setTimeout(function () {
                    finishGoogleRequest(id, new Error('O bridge Google Routes não respondeu em 30 segundos.'));
                }, 30000);
                const nativeAbortHandler = function () {
                    finishGoogleRequest(id, Object.assign(new Error('Requisição Google Routes cancelada.'), { name: 'AbortError' }));
                };
                controller.signal.addEventListener('abort', nativeAbortHandler, { once: true });
                googleRequests.set(id, {
                    resolve,
                    reject,
                    timer,
                    signal: controller.signal,
                    abortHandler: nativeAbortHandler
                });
                try {
                    window.SPXAndroid.googleRoutesRequest(id, endpoint.replace(/^\/+/, ''), bodyString, key, fieldMask);
                } catch (error) {
                    finishGoogleRequest(id, error);
                }
            }).finally(function () {
                if (config.signal) config.signal.removeEventListener('abort', abortHandler);
            });
        }

        let browserTimedOut = false;
        const browserTimer = setTimeout(function () {
            browserTimedOut = true;
            controller.abort();
        }, 30000);
        try {
            suppliedHeaders.set('Content-Type', 'application/json');
            suppliedHeaders.set('Accept', 'application/json');
            suppliedHeaders.set('X-Goog-Api-Key', key);
            if (fieldMask) suppliedHeaders.set('X-Goog-FieldMask', fieldMask);
            const response = await fetch(`https://routes.googleapis.com${endpoint}`, {
                method: 'POST',
                headers: suppliedHeaders,
                body: bodyString,
                signal: controller.signal
            });
            const text = await response.text();
            let payload = text;
            try { payload = text ? JSON.parse(text) : null; } catch (_) {}
            if (!response.ok) {
                const detail = payload && payload.error && payload.error.message ? payload.error.message : `HTTP ${response.status}`;
                throw new Error(`Google Routes: ${detail}`);
            }
            return payload;
        } catch (error) {
            if (config.signal && config.signal.aborted) {
                throw Object.assign(new Error('Requisição cancelada.'), { name: 'AbortError' });
            }
            if (browserTimedOut) throw new Error('Google Routes não respondeu no tempo limite.');
            throw error;
        } finally {
            clearTimeout(browserTimer);
            if (config.signal) config.signal.removeEventListener('abort', abortHandler);
        }
    }

    function decodePolyline(encoded) {
        const input = String(encoded || '');
        let index = 0;
        let lat = 0;
        let lng = 0;
        const coordinates = [];
        while (index < input.length) {
            let result = 0;
            let shift = 0;
            let byte;
            do {
                byte = input.charCodeAt(index++) - 63;
                result |= (byte & 0x1f) << shift;
                shift += 5;
            } while (byte >= 0x20 && index < input.length);
            lat += (result & 1) ? ~(result >> 1) : (result >> 1);
            result = 0;
            shift = 0;
            do {
                byte = input.charCodeAt(index++) - 63;
                result |= (byte & 0x1f) << shift;
                shift += 5;
            } while (byte >= 0x20 && index < input.length);
            lng += (result & 1) ? ~(result >> 1) : (result >> 1);
            coordinates.push([lat / 1e5, lng / 1e5]);
        }
        return coordinates;
    }

    function normalizeCoordinate(value, reverse) {
        if (Array.isArray(value)) {
            let lat = Number(value[0]);
            let lng = Number(value[1]);
            if (reverse || Math.abs(lat) > 90) {
                const swap = lat;
                lat = lng;
                lng = swap;
            }
            return { lat, lng };
        }
        if (value && value.lat != null && value.lng != null) return { lat: Number(value.lat), lng: Number(value.lng) };
        if (value && value.latitude != null && value.longitude != null) return { lat: Number(value.latitude), lng: Number(value.longitude) };
        return null;
    }

    function normalizePolyline(raw, points) {
        const route = raw && (raw.route || (raw.routes && raw.routes[0]) || raw);
        let coordinates = raw.polyline || route.polyline || raw.coordinates || route.coordinates || raw.coords || route.coords;
        let reverse = false;
        if (!coordinates && route.geometry && Array.isArray(route.geometry.coordinates)) {
            coordinates = route.geometry.coordinates;
            reverse = true;
        }
        if (!coordinates && route.encodedPolyline) coordinates = decodePolyline(route.encodedPolyline);
        if (!coordinates && raw.encodedPolyline) coordinates = decodePolyline(raw.encodedPolyline);
        if (coordinates && !Array.isArray(coordinates) && typeof coordinates === 'object') {
            coordinates = coordinates.encodedPolyline || coordinates.points || coordinates.coordinates || '';
        }
        if (typeof coordinates === 'string') coordinates = decodePolyline(coordinates);
        if (Array.isArray(coordinates)) {
            const normalized = coordinates.map(function (coordinate) { return normalizeCoordinate(coordinate, reverse); }).filter(validCoords);
            if (normalized.length >= 2) return normalized;
        }
        return points.map(function (point) { return { lat: Number(point.lat), lng: Number(point.lng) }; }).filter(validCoords);
    }

    function normalizeRoutePlan(raw, points) {
        const result = raw || {};
        const route = result.route || (result.routes && result.routes[0]) || result;
        const polyline = normalizePolyline(result, points);
        let legs = result.legs || route.legs || [];
        if (!Array.isArray(legs)) legs = [];
        if (!legs.length && Array.isArray(result.steps)) legs = [{ steps: result.steps }];
        let totalDistanceMeters = numberValue(result.totalDistanceMeters != null ? result.totalDistanceMeters : route.distanceMeters);
        let totalDurationSeconds = numberValue(result.totalDurationSeconds != null ? result.totalDurationSeconds : (result.totalDuration != null ? result.totalDuration : (route.duration != null ? route.duration : route.durationSec)));
        if (!totalDistanceMeters) totalDistanceMeters = legs.reduce(function (sum, leg) { return sum + numberValue(leg.distanceMeters != null ? leg.distanceMeters : leg.distance); }, 0);
        if (!totalDurationSeconds) totalDurationSeconds = legs.reduce(function (sum, leg) { return sum + numberValue(leg.durationSeconds != null ? leg.durationSeconds : (leg.duration != null ? leg.duration : leg.durationSec)); }, 0);
        if (!totalDistanceMeters && polyline.length > 1) {
            for (let index = 1; index < polyline.length; index++) totalDistanceMeters += distanceKm(polyline[index - 1], polyline[index]) * 1000;
        }

        const steps = [];
        let cumulativeDistance = 0;
        let cumulativeDuration = 0;
        legs.forEach(function (leg, legIndex) {
            const legSteps = leg.steps || leg.maneuvers || [];
            legSteps.forEach(function (step) {
                const stepDistance = numberValue(step.distanceMeters != null ? step.distanceMeters : step.distance);
                const stepDuration = numberValue(step.durationSeconds != null ? step.durationSeconds : (step.duration != null ? step.duration : step.durationSec));
                const navigationInstruction = step.navigationInstruction && step.navigationInstruction.instructions;
                const maneuverText = step.maneuver && typeof step.maneuver === 'object'
                    ? (step.maneuver.instruction || step.maneuver.text || step.maneuver.type || '')
                    : step.maneuver;
                steps.push({
                    ...step,
                    instruction: step.instruction || step.text || navigationInstruction || maneuverText || step.name || 'Siga em frente',
                    distanceMeters: stepDistance,
                    durationSeconds: stepDuration,
                    startDistanceMeters: cumulativeDistance,
                    endDistanceMeters: cumulativeDistance + stepDistance,
                    startDurationSeconds: cumulativeDuration,
                    legIndex
                });
                cumulativeDistance += stepDistance;
                cumulativeDuration += stepDuration;
            });
            if (!legSteps.length) {
                const legDistance = numberValue(leg.distanceMeters != null ? leg.distanceMeters : leg.distance);
                const legDuration = numberValue(leg.durationSeconds != null ? leg.durationSeconds : (leg.duration != null ? leg.duration : leg.durationSec));
                steps.push({
                    instruction: legIndex === 0 ? 'Siga para o primeiro destino' : 'Continue para o próximo destino',
                    distanceMeters: legDistance,
                    durationSeconds: legDuration,
                    startDistanceMeters: cumulativeDistance,
                    endDistanceMeters: cumulativeDistance + legDistance,
                    startDurationSeconds: cumulativeDuration,
                    legIndex
                });
                cumulativeDistance += legDistance;
                cumulativeDuration += legDuration;
            }
        });

        const stopEtas = {};
        if (result.stopEtas && typeof result.stopEtas === 'object') {
            Object.keys(result.stopEtas).forEach(function (key) { stopEtas[key] = result.stopEtas[key]; });
        }
        if (Array.isArray(result.stops)) {
            result.stops.forEach(function (stop, index) {
                const groupId = stop.groupId || stop.id || (points[index + 1] && points[index + 1].groupId);
                if (!groupId) return;
                const etaSeconds = numberValue(stop.etaSecondsFromNow != null ? stop.etaSecondsFromNow : stop.durationFromStartSeconds);
                stopEtas[String(groupId)] = {
                    eta: stop.eta || stop.arrivalTime || (etaSeconds ? new Date(Date.now() + etaSeconds * 1000).toISOString() : ''),
                    etaSecondsFromNow: etaSeconds,
                    durationFromStartSeconds: etaSeconds,
                    distanceFromStartMeters: numberValue(stop.distanceFromStartMeters)
                };
            });
        }
        const stopPoints = points.filter(function (point) { return point.groupId; });
        if (legs.length >= stopPoints.length) {
            let duration = 0;
            let distance = 0;
            stopPoints.forEach(function (point, index) {
                const leg = legs[index] || {};
                duration += numberValue(leg.durationSeconds != null ? leg.durationSeconds : (leg.duration != null ? leg.duration : leg.durationSec));
                distance += numberValue(leg.distanceMeters != null ? leg.distanceMeters : leg.distance);
                const existing = stopEtas[String(point.groupId)];
                if (!existing || (!existing.eta && !existing.durationFromStartSeconds)) {
                    stopEtas[String(point.groupId)] = {
                        eta: new Date(Date.now() + duration * 1000).toISOString(),
                        durationFromStartSeconds: duration,
                        distanceFromStartMeters: distance
                    };
                }
                duration += numberValue(point.serviceMinutes || 0) * 60;
            });
        }
        if (legs.length < stopPoints.length && totalDistanceMeters > 0) {
            stopPoints.forEach(function (point) {
                const existing = stopEtas[String(point.groupId)];
                if (existing && existing.eta) return;
                const nearest = nearestPointOnPolyline(point, polyline);
                const routeDistance = Math.min(totalDistanceMeters, Math.max(0, Number(nearest.routeDistanceMeters) || 0));
                const durationFromStartSeconds = totalDurationSeconds * routeDistance / totalDistanceMeters;
                stopEtas[String(point.groupId)] = {
                    eta: new Date(Date.now() + durationFromStartSeconds * 1000).toISOString(),
                    durationFromStartSeconds,
                    distanceFromStartMeters: routeDistance
                };
            });
        }

        let previousStopDuration = 0;
        let previousStopDistance = 0;
        const schedule = stopPoints.map(function (point) {
            const eta = stopEtas[String(point.groupId)] || {};
            const durationFromStartSeconds = numberValue(eta.durationFromStartSeconds != null ? eta.durationFromStartSeconds : eta.etaSecondsFromNow);
            const distanceFromStartMeters = numberValue(eta.distanceFromStartMeters);
            const item = {
                stopId: String(point.groupId),
                arrivalAt: eta.eta || (durationFromStartSeconds ? new Date(Date.now() + durationFromStartSeconds * 1000).toISOString() : ''),
                durationSec: Math.max(0, durationFromStartSeconds - previousStopDuration),
                durationFromStartSeconds,
                distanceMeters: Math.max(0, distanceFromStartMeters - previousStopDistance),
                distanceFromStartMeters,
                waitMinutes: 0,
                lateMinutes: 0,
                windowViolation: false
            };
            previousStopDuration = durationFromStartSeconds;
            previousStopDistance = distanceFromStartMeters;
            return item;
        });

        const provider = String(result.provider || route.provider || 'auto');
        const trafficAware = result.trafficAware != null ? !!result.trafficAware : (route.trafficAware != null ? !!route.trafficAware : /google/i.test(provider));
        return {
            ...result,
            points,
            polyline,
            legs,
            steps,
            schedule,
            stopEtas,
            totalDistanceMeters,
            totalDurationSeconds,
            provider,
            trafficAware,
            fallback: !!result.fallback || (!trafficAware && !/google/i.test(provider)),
            createdAt: result.createdAt || new Date().toISOString(),
            raw: result
        };
    }

    function navigationStops() {
        return pendingStops().filter(function (stop) { return validCoords(stop); }).slice(0, 25);
    }

    function navigationPoints(origin, stops) {
        return [{
            lat: Number(origin.lat),
            lng: Number(origin.lng),
            label: 'Posição atual',
            groupId: ''
        }].concat(stops.map(function (stop) {
            return {
                lat: Number(stop.lat),
                lng: Number(stop.lng),
                label: stop.primaryAddress || `Stop ${stop.stopLabel}`,
                groupId: String(stop.groupId),
                serviceMinutes: Number(stop.serviceMinutes) || 0
            };
        }));
    }

    async function computeNavigationPlan(origin, stops) {
        if (!window.SPXRouteEngine || typeof window.SPXRouteEngine.computeRoute !== 'function') {
            throw new Error('SPXRouteEngine.computeRoute não está disponível.');
        }
        const points = navigationPoints(origin, stops);
        const key = await loadGoogleKey();
        const controller = new AbortController();
        const timer = setTimeout(function () { controller.abort(); }, 30000);
        try {
            const raw = await window.SPXRouteEngine.computeRoute(points, {
                provider: 'auto',
                apiKey: key,
                key,
                googleKey: key,
                googleRoutesKey: key,
                request: googleRequest,
                departureTime: new Date().toISOString(),
                signal: controller.signal,
                fieldMask: 'routes.distanceMeters,routes.duration,routes.polyline.encodedPolyline,routes.legs.steps'
            });
            if (!raw) throw new Error('O motor de rota não retornou um plano.');
            return normalizeRoutePlan(raw, points);
        } catch (error) {
            if (error.name === 'AbortError') throw new Error('O cálculo da rota excedeu o tempo limite.');
            throw error;
        } finally {
            clearTimeout(timer);
        }
    }

    function drawNavigationPolyline() {
        if (navigationLine) {
            try { navigationLine.remove(); } catch (_) {}
            navigationLine = null;
        }
        const plan = navState.plan || getRoutePlan();
        if (!plan || !map || !window.L || !Array.isArray(plan.polyline) || plan.polyline.length < 2) return;
        try {
            navigationLine = window.L.polyline(plan.polyline.map(function (point) { return [point.lat, point.lng]; }), {
                color: '#EE4D2D',
                weight: 7,
                opacity: 0.9,
                lineCap: 'round',
                lineJoin: 'round'
            }).addTo(map);
            navigationLine.bringToFront();
        } catch (error) {
            reportError(error, 'Não foi possível desenhar a rota no mapa');
        }
    }

    function startLocationWatch() {
        if (!navigator.geolocation || typeof navigator.geolocation.watchPosition !== 'function') return;
        if (locationWatchId != null) navigator.geolocation.clearWatch(locationWatchId);
        locationWatchId = navigator.geolocation.watchPosition(function (position) {
            onPosition(position);
        }, function (error) {
            if (error && error.code === 1) notify('Permissão de localização negada. A navegação usará a última posição conhecida.', 'error');
        }, { enableHighAccuracy: true, maximumAge: 5000, timeout: 20000 });
    }

    async function startIntegratedNavigation() {
        if (navState.active) {
            renderNavigation();
            return;
        }
        const stops = navigationStops();
        if (!stops.length) {
            notify('Não há paradas pendentes com coordenadas válidas para navegar.', 'error');
            return;
        }
        const pending = pendingStops();
        const invalidCount = pending.filter(function (stop) { return !validCoords(stop); }).length;
        const overLimitCount = Math.max(0, pending.filter(validCoords).length - stops.length);
        if (invalidCount > 0) notify(`${invalidCount} parada(s) sem coordenadas válidas foram excluídas da navegação.`, 'error');
        if (overLimitCount > 0) notify(`${overLimitCount} parada(s) ficaram fora deste plano porque o limite é 25.`, 'info');
        let origin = validCoords(driverPos) ? driverPos : null;
        if (!origin && typeof window.getQuickPosition === 'function') origin = normalizePosition(await window.getQuickPosition(8000));
        if (!validCoords(origin) && validCoords(hubLocation)) origin = hubLocation;
        if (!validCoords(origin) && typeof window.getRouteOrigin === 'function') origin = window.getRouteOrigin();
        if (!validCoords(origin)) {
            notify('Não foi possível obter o GPS ou um ponto de partida válido.', 'error');
            return;
        }
        const token = ++navigationRequestToken;
        notify('Calculando rota integrada...', 'info');
        try {
            const plan = await computeNavigationPlan(origin, stops);
            if (token !== navigationRequestToken) return;
            setRoutePlan(plan);
            navState.active = true;
            navState.plan = plan;
            navState.stopIds = plan.points.filter(function (point) { return point.groupId; }).map(function (point) { return String(point.groupId); });
            navState.lastPosition = { lat: Number(origin.lat), lng: Number(origin.lng), accuracy: origin.accuracy || 0 };
            navState.nearest = nearestPointOnPolyline(navState.lastPosition, plan.polyline);
            navState.destinationGroupId = currentNavigationDestination();
            navState.offRouteSince = 0;
            navState.lastRerouteAt = 0;
            navState.rerouting = false;
            navState.startedAt = new Date().toISOString();
            driverPos = navState.lastPosition;
            refreshExistingViews(false);
            drawNavigationPolyline();
            try {
                if (map && plan.polyline.length) map.fitBounds(plan.polyline.map(function (point) { return [point.lat, point.lng]; }), { padding: [45, 65], maxZoom: 16 });
            } catch (_) {}
            if (typeof window.switchMobileTab === 'function') window.switchMobileTab('map');
            try { startLocationWatch(); } catch (watchError) { reportError(watchError, 'GPS contínuo indisponível'); }
            renderNavigation();
            notify(plan.trafficAware ? 'Rota calculada com trânsito.' : 'Rota calculada. ETA sem simulação de trânsito.', 'success');
        } catch (error) {
            reportError(error, 'Não foi possível iniciar a navegação');
            if (!navState.active) renderHub();
        }
    }

    function nearestPointOnPolyline(position, polyline) {
        if (!validCoords(position) || !Array.isArray(polyline) || polyline.length < 2) {
            return { distanceMeters: Infinity, routeDistanceMeters: 0, segmentIndex: 0, fraction: 0 };
        }
        const latScale = 111320;
        const lngScale = Math.max(1, Math.cos(position.lat * Math.PI / 180) * 111320);
        let best = { distanceMeters: Infinity, routeDistanceMeters: 0, segmentIndex: 0, fraction: 0 };
        let routeDistance = 0;
        for (let index = 1; index < polyline.length; index++) {
            const a = polyline[index - 1];
            const b = polyline[index];
            if (!validCoords(a) || !validCoords(b)) continue;
            const ax = (a.lng - position.lng) * lngScale;
            const ay = (a.lat - position.lat) * latScale;
            const bx = (b.lng - position.lng) * lngScale;
            const by = (b.lat - position.lat) * latScale;
            const dx = bx - ax;
            const dy = by - ay;
            const lengthSquared = dx * dx + dy * dy;
            const fraction = lengthSquared ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / lengthSquared)) : 0;
            const px = ax + fraction * dx;
            const py = ay + fraction * dy;
            const deviation = Math.sqrt(px * px + py * py);
            if (deviation < best.distanceMeters) {
                best = {
                    distanceMeters: deviation,
                    routeDistanceMeters: routeDistance + Math.sqrt(lengthSquared) * fraction,
                    segmentIndex: index - 1,
                    fraction
                };
            }
            routeDistance += distanceKm(a, b) * 1000;
        }
        return best;
    }

    function currentNavigationDestination() {
        for (const id of navState.stopIds) {
            const stop = getStops().find(function (item) { return String(item.groupId) === id; });
            if (stop && isPendingStop(stop)) return id;
        }
        return '';
    }

    function currentNavigationStep(plan, routeDistance) {
        if (!plan || !Array.isArray(plan.steps) || !plan.steps.length) return null;
        const upcoming = plan.steps.find(function (step) { return routeDistance <= Number(step.endDistanceMeters) + 80; });
        if (upcoming) return upcoming;
        return plan.steps[plan.steps.length - 1];
    }

    function navigationView() {
        const plan = navState.plan || getRoutePlan();
        if (!plan) return null;
        const nearest = navState.lastPosition ? nearestPointOnPolyline(navState.lastPosition, plan.polyline) : null;
        if (nearest) navState.nearest = nearest;
        const totalDistance = Math.max(0, Number(plan.totalDistanceMeters) || 0);
        const totalDuration = Math.max(0, Number(plan.totalDurationSeconds) || 0);
        const traveled = Math.min(totalDistance, Math.max(0, Number(nearest && nearest.routeDistanceMeters) || 0));
        const remainingDistance = Math.max(0, totalDistance - traveled);
        const remainingDuration = totalDistance ? totalDuration * remainingDistance / totalDistance : totalDuration;
        const destinationGroupId = currentNavigationDestination();
        const destination = getStops().find(function (stop) { return String(stop.groupId) === destinationGroupId; });
        const step = currentNavigationStep(plan, traveled);
        return {
            plan,
            nearest,
            totalDistance,
            totalDuration,
            remainingDistance,
            remainingDuration,
            progress: totalDistance ? Math.max(0, Math.min(100, traveled / totalDistance * 100)) : 0,
            destination,
            destinationGroupId,
            step,
            eta: remainingDuration ? new Date(Date.now() + remainingDuration * 1000).toISOString() : '',
            deviation: nearest ? nearest.distanceMeters : 0
        };
    }

    function renderNavigation() {
        if (!navState.active) {
            renderHub();
            return;
        }
        const view = navigationView();
        if (!view) return;
        const plan = view.plan;
        const stops = navState.stopIds.map(function (id) { return getStops().find(function (stop) { return String(stop.groupId) === id; }); }).filter(Boolean);
        const stopRows = stops.map(function (stop, index) {
            const active = String(stop.groupId) === String(view.destinationGroupId);
            return `<button data-action="nav-focus-stop" data-group-id="${esc(stop.groupId)}" class="flex w-full items-center gap-2.5 rounded-xl border px-3 py-2 text-left ${active ? 'border-[#EE4D2D] bg-orange-50 dark:bg-orange-950/40' : 'border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950'}">
                <span class="flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[10px] font-bold ${active ? 'bg-[#EE4D2D] text-white' : 'bg-zinc-100 text-zinc-500 dark:bg-zinc-800'}">${index + 1}</span>
                <span class="min-w-0 flex-1"><span class="flex items-center gap-1.5">${priorityBadge(stop.priority)}<span class="truncate text-[11px] font-semibold">${esc(stop.primaryAddress)}</span></span><span class="mt-0.5 block truncate text-[10px] text-zinc-500">${esc(windowLabel(stop))}</span></span>
                <span class="shrink-0 text-[11px] font-bold">${esc(etaText(stop.groupId))}</span>
            </button>`;
        }).join('');
        const instruction = view.step ? view.step.instruction : 'Siga para o destino';
        const destinationText = view.destination ? view.destination.primaryAddress : 'Rota concluída';
        const providerLabel = plan.trafficAware ? 'Google Routes · trânsito' : `${plan.provider || 'local'} · sem trânsito`;
        setRootContent(`
            <div class="pointer-events-none fixed inset-0 z-[75] p-3 sm:p-4">
                <section class="pointer-events-auto ml-auto flex max-h-[88dvh] w-full flex-col overflow-hidden rounded-3xl border border-zinc-200 bg-white/95 shadow-2xl backdrop-blur-xl dark:border-zinc-800 dark:bg-zinc-900/95 sm:max-w-[430px]" role="dialog" aria-label="Navegação integrada">
                    <header class="flex items-center gap-2 border-b border-zinc-200 px-4 py-3 dark:border-zinc-800">
                        <span class="flex h-9 w-9 items-center justify-center rounded-xl bg-[#EE4D2D] text-white">${icon('navigation', 'w-4 h-4')}</span>
                        <div class="min-w-0 flex-1"><h2 class="text-sm font-bold">Navegação integrada</h2><p class="truncate text-[10px] text-zinc-500">${esc(providerLabel)}</p></div>
                        <button data-action="nav-hub" class="shadcn-btn h-8 w-8 text-zinc-400" aria-label="Abrir hub">${icon('layout-grid', 'w-4 h-4')}</button>
                        <button data-action="nav-end" class="shadcn-btn h-8 w-8 text-zinc-400 hover:text-rose-600" aria-label="Encerrar navegação">${icon('x', 'w-4 h-4')}</button>
                    </header>
                    <div class="spx-thin-scroll flex-1 overflow-y-auto p-4">
                        <div class="rounded-2xl bg-zinc-900 p-4 text-white dark:bg-zinc-100 dark:text-zinc-950">
                            <div class="flex items-start gap-3"><span class="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-[#EE4D2D]">${icon('corner-up-right', 'w-6 h-6')}</span><div class="min-w-0"><p id="spxNavInstruction" class="text-base font-bold leading-snug">${esc(instruction)}</p><p id="spxNavDestination" class="mt-1 truncate text-[11px] text-zinc-400 dark:text-zinc-500">${esc(destinationText)}</p></div></div>
                            <div class="mt-4 grid grid-cols-3 gap-2"><div><span class="block text-[9px] uppercase tracking-wider text-zinc-400">Restante</span><strong id="spxNavDistance" class="mt-0.5 block text-sm">${formatDistance(view.remainingDistance)}</strong></div><div><span class="block text-[9px] uppercase tracking-wider text-zinc-400">ETA</span><strong id="spxNavEta" class="mt-0.5 block text-sm">${formatClock(view.eta)}</strong></div><div><span class="block text-[9px] uppercase tracking-wider text-zinc-400">Duração</span><strong id="spxNavDuration" class="mt-0.5 block text-sm">${formatDuration(view.remainingDuration)}</strong></div></div>
                            <div class="mt-3 h-1.5 overflow-hidden rounded-full bg-white/15 dark:bg-zinc-300"><div id="spxNavProgress" class="h-full rounded-full bg-[#EE4D2D] transition-all" style="width:${view.progress}%"></div></div>
                            <div class="mt-2 flex items-center justify-between text-[9px] text-zinc-400"><span id="spxNavProgressText">${view.progress.toFixed(0)}% concluído</span><span id="spxNavDeviation">${view.deviation > 150 ? `Desvio ${formatDistance(view.deviation)}` : 'Na rota'}</span></div>
                        </div>
                        ${navState.rerouting ? `<div class="mt-3 flex items-center gap-2 rounded-xl bg-amber-50 px-3 py-2 text-[11px] font-semibold text-amber-700 dark:bg-amber-950 dark:text-amber-300">${icon('refresh-cw', 'w-3.5 h-3.5 animate-spin')} Recalculando rota pelo desvio...</div>` : ''}
                        <div class="mt-3 grid grid-cols-2 gap-2">
                            <button data-action="nav-complete" class="shadcn-btn h-11 bg-emerald-600 text-xs font-bold text-white hover:bg-emerald-700">${icon('check-circle-2', 'w-4 h-4')} Concluir parada</button>
                            <button data-action="nav-fail" class="shadcn-btn h-11 border border-rose-200 bg-white text-xs font-bold text-rose-600 hover:bg-rose-50 dark:border-rose-900 dark:bg-zinc-950 dark:text-rose-300">${icon('x-circle', 'w-4 h-4')} Insucesso</button>
                        </div>
                        <div class="mt-4 flex items-center justify-between"><h3 class="text-xs font-bold">Paradas e ETA</h3><span class="text-[10px] text-zinc-400">${stops.length} no plano</span></div>
                        <div class="mt-2 space-y-2">${stopRows || '<p class="text-xs text-zinc-500">Todas as paradas do plano foram concluídas.</p>'}</div>
                        <p class="mt-3 text-[10px] leading-relaxed text-zinc-400">${plan.trafficAware ? 'ETA considera os dados de trânsito retornados pelo provedor.' : 'Fallback sem trânsito: distância e duração são estimativas, não simulação de tráfego.'}</p>
                    </div>
                </section>
            </div>`, 'none');
    }

    function updateNavigationLiveUI() {
        if (!navState.active) return;
        const view = navigationView();
        if (!view) return;
        const destination = view.destination ? view.destination.primaryAddress : 'Rota concluída';
        const values = {
            spxNavInstruction: view.step ? view.step.instruction : 'Siga para o destino',
            spxNavDestination: destination,
            spxNavDistance: formatDistance(view.remainingDistance),
            spxNavEta: formatClock(view.eta),
            spxNavDuration: formatDuration(view.remainingDuration),
            spxNavProgressText: `${view.progress.toFixed(0)}% concluído`,
            spxNavDeviation: view.deviation > 150 ? `Desvio ${formatDistance(view.deviation)}` : 'Na rota'
        };
        Object.keys(values).forEach(function (id) { const element = byId(id); if (element) element.textContent = values[id]; });
        const progress = byId('spxNavProgress');
        if (progress) progress.style.width = `${view.progress}%`;
        if (navState.destinationGroupId !== view.destinationGroupId) {
            navState.destinationGroupId = view.destinationGroupId;
            renderNavigation();
        }
    }

    function scheduleReroute() {
        if (!navState.active || navState.rerouting || rerouteTimer) return;
        rerouteTimer = setTimeout(function () {
            rerouteTimer = null;
            rerouteNavigation();
        }, 1800);
    }

    async function rerouteNavigation(message = 'Rota recalculada após o desvio.') {
        if (!navState.active || navState.rerouting || !validCoords(navState.lastPosition)) return;
        const stops = navState.stopIds.map(function (id) { return getStops().find(function (stop) { return String(stop.groupId) === id; }); }).filter(function (stop) { return stop && isPendingStop(stop) && validCoords(stop); }).slice(0, 25);
        if (!stops.length) return;
        const token = ++navigationRequestToken;
        navState.rerouting = true;
        renderNavigation();
        try {
            const plan = await computeNavigationPlan(navState.lastPosition, stops);
            if (token !== navigationRequestToken || !navState.active) return;
            setRoutePlan(plan);
            navState.plan = plan;
            navState.stopIds = plan.points.filter(function (point) { return point.groupId; }).map(function (point) { return String(point.groupId); });
            navState.nearest = nearestPointOnPolyline(navState.lastPosition, plan.polyline);
            navState.offRouteSince = 0;
            navState.lastRerouteAt = Date.now();
            drawNavigationPolyline();
            safeSaveState();
            notify(message, 'success');
        } catch (error) {
            reportError(error, 'Não foi possível recalcular a rota');
        } finally {
            navState.rerouting = false;
            if (navState.active) renderNavigation();
        }
    }

    function endIntegratedNavigation() {
        navState.active = false;
        navState.plan = null;
        navState.stopIds = [];
        navState.lastPosition = null;
        navState.nearest = null;
        navState.destinationGroupId = '';
        navState.offRouteSince = 0;
        navState.rerouting = false;
        navigationRequestToken++;
        if (rerouteTimer) clearTimeout(rerouteTimer);
        rerouteTimer = null;
        if (locationWatchId != null && navigator.geolocation) navigator.geolocation.clearWatch(locationWatchId);
        locationWatchId = null;
        if (navigationLine) {
            try { navigationLine.remove(); } catch (_) {}
            navigationLine = null;
        }
        refreshExistingViews(false);
        renderHub();
        notify('Navegação encerrada. O plano de ETA foi mantido.', 'info');
    }

    function onPosition(position) {
        const normalized = normalizePosition(position);
        if (!validCoords(normalized)) return false;
        driverPos = normalized;
        try { if (typeof window.drawDriverMarker === 'function') window.drawDriverMarker(); } catch (_) {}
        if (!navState.active || !navState.plan) return true;
        navState.lastPosition = normalized;
        const nearest = nearestPointOnPolyline(normalized, navState.plan.polyline);
        navState.nearest = nearest;
        if (nearest.distanceMeters > 150) {
            if (!navState.offRouteSince) navState.offRouteSince = Date.now();
            if (Date.now() - navState.offRouteSince >= 1200) scheduleReroute();
        } else {
            navState.offRouteSince = 0;
            if (rerouteTimer) {
                clearTimeout(rerouteTimer);
                rerouteTimer = null;
            }
        }
        updateNavigationLiveUI();
        return true;
    }

    function refresh() {
        if (!initialized) init();
        ensurePackageSlotFields();
        if (root.classList.contains('hidden')) return getRoutePlan();
        if (byId('spxAddressForm') || byId('spxPodForm') || root.querySelector('[data-action="settings-form"]')) return getRoutePlan();
        if (navState.active) {
            drawNavigationPolyline();
            renderNavigation();
        } else if (byId('spxFinderSearch')) {
            renderFinderResults();
        } else if (byId('spxLoadSearch')) {
            renderLoadResults();
        } else {
            renderHub();
        }
        return getRoutePlan();
    }

    function openTransfer() {
        if (!window.SPXTransfer || typeof window.SPXTransfer.openModal !== 'function') {
            notify('O módulo de transferência não está disponível.', 'error');
            return;
        }
        root.classList.add('hidden');
        try {
            window.SPXTransfer.openModal();
        } catch (error) {
            reportError(error, 'Não foi possível abrir a transferência');
            renderHub();
        }
    }

    async function handleClick(event) {
        const button = event.target.closest('[data-action]');
        if (!button || !root.contains(button)) return;
        const action = button.dataset.action;
        try {
            if (action === 'close-root') {
                addressState = null;
                podState = null;
                if (autocompleteTimer) clearTimeout(autocompleteTimer);
                if (autocompleteController) autocompleteController.abort();
                root.classList.add('hidden');
                return;
            }
            if (action === 'modal-backdrop') {
                if (event.target === button) openHub();
                return;
            }
            if (action === 'back-hub') { openHub(); return; }
            if (action === 'open-address') { openAddressModal(); return; }
            if (action === 'open-finder') { openPackageFinder(); return; }
            if (action === 'open-load') { openLoad(); return; }
            if (action === 'open-transfer') { openTransfer(); return; }
            if (action === 'open-settings') { openSettings(); return; }
            if (action === 'start-navigation') { await startIntegratedNavigation(); return; }
            if (action === 'resume-navigation') { renderNavigation(); return; }
            if (action === 'select-address') { selectAddress(button.dataset.index); return; }
            if (action === 'voice-input') { startVoiceInput(button.dataset.field); return; }
            if (action === 'ocr-address') { byId('spxAddressForm')?.querySelector('[data-purpose="address-label"]')?.click(); return; }
            if (action === 'scan-code') { root.querySelector(`input[data-purpose="${button.dataset.purpose}"]`)?.click(); return; }
            if (action === 'finder-map') { root.classList.add('hidden'); focusOnMap(button.dataset.groupId); return; }
            if (action === 'finder-load') { openLoad(allPackages().find(function (item) { return String(item.pkg.id) === String(button.dataset.pkgId); })?.pkg.spxTn || ''); return; }
            if (action === 'finder-pod') { openPOD(button.dataset.groupId, [button.dataset.pkgId], 'Entregue'); return; }
            if (action === 'hub-focus-stop') { root.classList.add('hidden'); focusOnMap(button.dataset.groupId); return; }
            if (action === 'select-load-zone') { loadState.zone = button.dataset.zone || 'Todas'; renderLoadModal(); return; }
            if (action === 'edit-slot') { openSlotEditor(button.dataset.groupId, button.dataset.pkgId); return; }
            if (action === 'back-load') { renderLoadModal(); return; }
            if (action === 'clear-signature') {
                if (!podState) return;
                const canvas = byId('spxSignatureCanvas');
                if (canvas) canvas.getContext('2d')?.clearRect(0, 0, canvas.width, canvas.height);
                podState.signatureData = '';
                podState.hasSignature = false;
                byId('spxSignatureHint')?.classList.remove('hidden');
                return;
            }
            if (action === 'pod-photo') { root.querySelector('input[data-purpose="pod-photo"]')?.click(); return; }
            if (action === 'remove-photo') {
                if (podState) podState.photoData = '';
                const preview = byId('spxPhotoPreview');
                if (preview) { preview.innerHTML = ''; preview.classList.add('hidden'); }
                return;
            }
            if (action === 'close-pod') { closePOD(); return; }
            if (action === 'toggle-key') {
                const input = byId('spxGoogleRoutesKey');
                if (input) {
                    input.type = input.type === 'password' ? 'text' : 'password';
                    button.textContent = input.type === 'password' ? 'Mostrar' : 'Ocultar';
                }
                return;
            }
            if (action === 'nav-complete') {
                const destination = viewDestinationPending();
                if (!destination) return notify('Não há parada pendente para concluir.', 'info');
                window.markEntireStopStatus(destination.groupId, 'Entregue');
                return;
            }
            if (action === 'nav-fail') {
                if (!viewDestinationPending()) return notify('Não há parada pendente para registrar insucesso.', 'info');
                const ids = (viewDestinationPending().packages || []).filter(function (pkg) { return pkg.status !== 'Entregue' && pkg.status !== 'Insucesso'; }).map(function (pkg) { return pkg.id; });
                openPOD(viewDestinationPending().groupId, ids, 'Insucesso');
                return;
            }
            if (action === 'nav-end') { endIntegratedNavigation(); return; }
            if (action === 'nav-hub') { renderHub(); return; }
            if (action === 'nav-focus-stop') { focusOnMap(button.dataset.groupId); return; }
        } catch (error) {
            reportError(error, 'Não foi possível executar a ação');
        }
    }

    function viewDestinationPending() {
        const id = currentNavigationDestination();
        return getStops().find(function (stop) { return String(stop.groupId) === id && isPendingStop(stop); }) || null;
    }

    async function handleChange(event) {
        const target = event.target;
        try {
            if (target.matches('input[data-purpose="address-label"]')) {
                await recognizeAddressPhoto(target.files && target.files[0]);
                target.value = '';
                return;
            }
            if (target.matches('input[data-purpose="finder-code"]') || target.matches('input[data-purpose="load-code"]')) {
                await scanPackageCode(target.files && target.files[0], target.dataset.purpose);
                target.value = '';
                return;
            }
            if (target.matches('input[data-purpose="pod-photo"]')) {
                const file = target.files && target.files[0];
                target.value = '';
                if (!file || !podState) return;
                showInlineError('spxPodError', '');
                podState.photoData = await compressImage(file, 1280, 0.78);
                const preview = byId('spxPhotoPreview');
                if (preview) {
                    preview.innerHTML = `<img src="${esc(podState.photoData)}" alt="Prévia da foto do comprovante" class="h-28 w-full object-cover"><button type="button" data-action="remove-photo" class="absolute right-2 top-2 flex h-8 w-8 items-center justify-center rounded-full bg-zinc-950/70 text-white" aria-label="Remover foto">${icon('x', 'w-4 h-4')}</button>`;
                    preview.classList.remove('hidden');
                    refreshIcons();
                }
                return;
            }
            if (target.matches('input[name="podStatus"]')) {
                updatePodMode(target.value);
                return;
            }
        } catch (error) {
            reportError(error, 'Não foi possível processar a seleção');
        }
    }

    function handleInput(event) {
        const target = event.target;
        if (target.id === 'spxAddressForm' || (target.form && target.form.id === 'spxAddressForm')) {
            if (['address', 'bairro', 'city', 'zipcode'].includes(target.name)) scheduleAddressSearch(target.form);
            else if (addressState) syncAddressForm(target.form);
            return;
        }
        if (target.id === 'spxFinderSearch') {
            finderState.query = target.value;
            renderFinderResults();
            return;
        }
        if (target.id === 'spxLoadSearch') {
            loadState.query = target.value;
            renderLoadResults();
        }
    }

    async function handleSubmit(event) {
        const form = event.target;
        const action = form.dataset.action;
        if (!action) return;
        event.preventDefault();
        try {
            if (action === 'address-form') { await saveAddress(form); return; }
            if (action === 'slot-form') { saveSlot(form); return; }
            if (action === 'pod-form') { await savePOD(form); return; }
            if (action === 'settings-form') { await saveSettings(form); return; }
        } catch (error) {
            reportError(error, 'Não foi possível salvar o formulário');
        }
    }

    function handleKeydown(event) {
        if (event.key !== 'Escape' || !root || root.classList.contains('hidden')) return;
        if (podState) closePOD();
        else if (navState.active) renderHub();
        else renderHub();
    }

    function init() {
        if (initialized) return;
        ensureRoot();
        if (!root.__spxLogisticsEventsBound) {
            root.addEventListener('click', handleClick);
            root.addEventListener('change', handleChange);
            root.addEventListener('input', handleInput);
            root.addEventListener('submit', handleSubmit);
            root.addEventListener('pointerdown', beginSignature);
            root.addEventListener('pointermove', moveSignature);
            root.addEventListener('pointerup', endSignature);
            root.addEventListener('pointercancel', endSignature);
            root.addEventListener('keydown', handleKeydown);
            root.__spxLogisticsEventsBound = true;
        }
        ensurePackageSlotFields();
        initialized = true;
        refreshIcons();
    }

    window.SPXLogistics = {
        init,
        openHub,
        openAddressModal,
        openPackageFinder,
        openPOD,
        startIntegratedNavigation,
        openSettings,
        refresh,
        onPosition,
        getRoutePlan,
        googleRequest,
        openLoad,
        endIntegratedNavigation
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', function () { init(); }, { once: true });
    } else {
        init();
    }
})();
