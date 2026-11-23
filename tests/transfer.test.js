'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../app/src/main/assets/js/transfer.js'), 'utf8');

function loadTransfer() {
    const context = {
        TextEncoder,
        TextDecoder,
        btoa,
        atob,
        localStorage: { getItem: () => null, setItem: () => {} },
        normalizeClockValue: function (value) {
            if (typeof value === 'number' && value >= 0 && value < 1) {
                const minutes = Math.round(value * 24 * 60) % (24 * 60);
                return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
            }
            const match = String(value || '').match(/^(\d{1,2}):(\d{2})$/);
            return match && Number(match[1]) <= 23 && Number(match[2]) <= 59
                ? `${String(Number(match[1])).padStart(2, '0')}:${match[2]}`
                : '';
        }
    };
    context.window = context;
    vm.runInNewContext(source, context, { filename: 'transfer.js' });
    return context.window.SPXTransfer;
}

function payload() {
    return {
        version: 1,
        type: 'spx-stop-transfer',
        transferId: 'tr-test',
        routeId: 'ROTA-A',
        exportedAt: '2026-11-23T20:00:00.000Z',
        from: { teamId: 'equipe-a', driverId: 'motorista-a', driverName: 'Motorista A' },
        stops: [{
            groupId: 'STOP_1',
            stopLabel: '1',
            stopNumeric: 1,
            primaryAddress: 'Rua das Flores, 100',
            bairro: 'Centro',
            city: 'Bauru',
            zipcode: '17000-000',
            lat: -22.32,
            lng: -49.08,
            priority: 'Urgente',
            serviceMinutes: 0,
            windowStart: 23 / 24,
            windowEnd: 1 / 24,
            windowType: 'Conclusão',
            vehiclePosition: 'Porta-malas esquerdo · A1',
            packages: [{
                id: 'pkg-1',
                atId: 'ROTA-A',
                sequence: 1,
                spxTn: 'brteste1234567',
                address: 'Rua das Flores, 100',
                lat: -22.32,
                lng: -49.08,
                status: 'Entregue',
                deliveredAt: '2026-11-23T19:00:00.000Z',
                pod: { evidenceIds: ['fora-do-dispositivo'] },
                vehicleSlot: 'A1',
                slotZone: 'Porta-malas esquerdo',
                slotPosition: 'A1',
                notes: 'Entregar na portaria'
            }]
        }]
    };
}

test('validação normaliza horários, prioridade, IDs e posição do volume', function () {
    const api = loadTransfer();
    const result = api.validatePayload(payload());
    const stop = result.stops[0];
    const pkg = stop.packages[0];

    assert.equal(stop.priority, 'urgente');
    assert.equal(stop.serviceMinutes, 0);
    assert.equal(stop.windowStart, '23:00');
    assert.equal(stop.windowEnd, '01:00');
    assert.equal(stop.windowType, 'conclusao');
    assert.equal(pkg.spxTn, 'BRTESTE1234567');
    assert.equal(pkg.status, 'Pendente');
    assert.equal(pkg.deliveredAt, '');
    assert.equal(Object.hasOwn(pkg, 'pod'), false);
    assert.equal(pkg.vehicleSlot, 'A1');
    assert.equal(pkg.slotZone, 'Porta-malas esquerdo');
    assert.equal(pkg.slotPosition, 'A1');
});

test('validação remove campos arbitrários e neutraliza sequência maliciosa', function () {
    const api = loadTransfer();
    const incoming = payload();
    Object.defineProperty(incoming.stops[0], '__proto__', {
        value: { polluted: true },
        enumerable: true
    });
    incoming.stops[0].packages[0].sequence = '<img src=x onerror=alert(1)>';
    incoming.stops[0].packages[0].constructor = { prototype: { polluted: true } };

    const stop = api.validatePayload(incoming).stops[0];
    const pkg = stop.packages[0];

    assert.equal(pkg.sequence, 0);
    assert.equal(Object.hasOwn(stop, '__proto__'), false);
    assert.equal(Object.hasOwn(stop, 'constructor'), false);
    assert.equal(Object.hasOwn(pkg, 'constructor'), false);
    assert.equal({}.polluted, undefined);
});

test('validação rejeita coordenadas e limites inválidos', function () {
    const api = loadTransfer();
    const invalidCoordinates = payload();
    invalidCoordinates.stops[0].lat = 91;
    assert.throws(() => api.validatePayload(invalidCoordinates), /coordenadas válidas/);

    const tooManyStops = payload();
    tooManyStops.stops = Array.from({ length: 501 }, function (_, index) {
        const stop = payload().stops[0];
        stop.groupId = `STOP_${index}`;
        stop.packages[0].id = `pkg-${index}`;
        stop.packages[0].spxTn = `BRLIMIT${index}`;
        return stop;
    });
    assert.throws(() => api.validatePayload(tooManyStops), /500 paradas/);
});

test('link preserva acentos e faz round trip do payload', function () {
    const api = loadTransfer();
    const encoded = api.encodePayload(payload());
    const decoded = api.decodePayload(encoded);

    assert.equal(decoded.stops[0].city, 'Bauru');
    assert.equal(decoded.stops[0].packages[0].notes, 'Entregar na portaria');
    assert.equal(decoded.stops[0].packages[0].spxTn, 'brteste1234567');
});
