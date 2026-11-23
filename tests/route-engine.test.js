'use strict';

process.env.TZ = 'UTC';

const test = require('node:test');
const assert = require('node:assert/strict');
const engine = require('../app/src/main/assets/js/route-engine.js');

const {
    haversineKm,
    parseDurationSeconds,
    buildMatrix,
    computeRoute,
    optimizeStops
} = engine;

function point(lat, lng) {
    return { lat, lng };
}

function stop(id, lat, lng, extra) {
    return Object.assign({ id, groupId: 'group-' + id, lat, lng, priority: 'Normal', serviceMinutes: 0 }, extra || {});
}

function matrix(durations, distances) {
    return {
        durations,
        distances: distances || durations.map(function (row) {
            return row.map(function (value) { return value * 1000; });
        })
    };
}

function completeMatrix(size, duration, distance) {
    return Array.from({ length: size }, function (_, i) {
        return Array.from({ length: size }, function (_, j) {
            return i === j ? 0 : duration;
        });
    });
}

test('fallback rodoviário usa Haversine, fator 1,28 e 28 km/h', async function () {
    const points = [point(0, 0), point(0, 1)];
    const result = await buildMatrix(points, { provider: 'fallback' });
    const expectedDistance = Math.round(haversineKm(points[0], points[1]) * 1000 * 1.28);
    const expectedDuration = Math.round(expectedDistance * 3600 / 28000);

    assert.equal(result.provider, 'fallback');
    assert.equal(result.trafficAware, false);
    assert.equal(result.distances[0][1], expectedDistance);
    assert.equal(result.durations[0][1], expectedDuration);
    assert.equal(result.distances[1][0], expectedDistance);
    assert.equal(result.durations[1][1], 0);

    const route = await computeRoute(points, { provider: 'fallback' });
    assert.equal(route.provider, 'fallback');
    assert.equal(route.distanceMeters, expectedDistance);
    assert.equal(route.durationSec, expectedDuration);
    assert.deepEqual(route.coords, [[0, 0], [0, 1]]);
});

test('otimização aguarda a janela abrir e calcula ETA de serviço', function () {
    const start = point(0, 0);
    const delivery = stop('A', 0.01, 0, {
        windowStart: '09:00',
        windowEnd: '10:00',
        windowType: 'Chegada',
        serviceMinutes: 10
    });
    const result = optimizeStops({
        stops: [delivery],
        start,
        matrix: matrix([[0, 1800], [1800, 0]]),
        departureTime: '2025-01-15T08:00:00.000Z'
    });

    assert.equal(result.schedule.length, 1);
    assert.equal(result.schedule[0].arrivalAt, '2025-01-15T08:30:00.000Z');
    assert.equal(result.schedule[0].serviceStartAt, '2025-01-15T09:00:00.000Z');
    assert.equal(result.schedule[0].serviceEndAt, '2025-01-15T09:10:00.000Z');
    assert.equal(result.schedule[0].waitMinutes, 30);
    assert.equal(result.schedule[0].lateMinutes, 0);
    assert.equal(result.schedule[0].windowViolation, false);
    assert.equal(result.metrics.finishAt, '2025-01-15T09:10:00.000Z');
    assert.equal(result.metrics.serviceMinutes, 10);
});

test('otimização registra atraso e violação de janela', function () {
    const result = optimizeStops({
        stops: [stop('A', 0.01, 0, {
            windowStart: '09:00',
            windowEnd: '10:00',
            windowType: 'Chegada',
            serviceMinutes: 15
        })],
        start: point(0, 0),
        matrix: matrix([[0, 9000], [9000, 0]]),
        departureTime: '2025-01-15T08:00:00.000Z'
    });

    assert.equal(result.schedule[0].arrivalAt, '2025-01-15T10:30:00.000Z');
    assert.equal(result.schedule[0].lateMinutes, 30);
    assert.equal(result.schedule[0].windowViolation, true);
    assert.equal(result.metrics.totalLateMinutes, 30);
});

test('janela de conclusão considera o fim do serviço', function () {
    const result = optimizeStops({
        stops: [stop('A', 0.01, 0, {
            windowStart: '09:00',
            windowEnd: '09:20',
            windowType: 'Conclusão',
            serviceMinutes: 30
        })],
        start: point(0, 0),
        matrix: matrix([[0, 1200], [1200, 0]]),
        departureTime: '2025-01-15T08:00:00.000Z'
    });

    assert.equal(result.schedule[0].serviceStartAt, '2025-01-15T09:00:00.000Z');
    assert.equal(result.schedule[0].serviceEndAt, '2025-01-15T09:30:00.000Z');
    assert.equal(result.schedule[0].lateMinutes, 10);
    assert.equal(result.schedule[0].windowViolation, true);
});

test('janela atravessando meia-noite aguarda a abertura correta', function () {
    const options = {
        stops: [stop('A', 0.01, 0, {
            windowStart: '23:00',
            windowEnd: '01:00',
            windowType: 'Chegada',
            serviceMinutes: 10
        })],
        start: point(0, 0),
        matrix: matrix([[0, 1200], [1200, 0]])
    };
    const beforeOpening = optimizeStops(Object.assign({}, options, {
        departureTime: '2025-01-15T22:00:00.000Z'
    }));
    assert.equal(beforeOpening.schedule[0].arrivalAt, '2025-01-15T22:20:00.000Z');
    assert.equal(beforeOpening.schedule[0].serviceStartAt, '2025-01-15T23:00:00.000Z');
    assert.equal(beforeOpening.schedule[0].waitMinutes, 40);
    assert.equal(beforeOpening.schedule[0].lateMinutes, 0);

    const afterMidnight = optimizeStops(Object.assign({}, options, {
        departureTime: '2025-01-15T23:50:00.000Z'
    }));
    assert.equal(afterMidnight.schedule[0].arrivalAt, '2025-01-16T00:10:00.000Z');
    assert.equal(afterMidnight.schedule[0].waitMinutes, 0);
    assert.equal(afterMidnight.schedule[0].lateMinutes, 0);

    const missedOvernight = optimizeStops(Object.assign({}, options, {
        departureTime: '2025-01-16T02:30:00.000Z'
    }));
    assert.equal(missedOvernight.schedule[0].arrivalAt, '2025-01-16T02:50:00.000Z');
    assert.equal(missedOvernight.schedule[0].waitMinutes, 0);
    assert.equal(missedOvernight.schedule[0].lateMinutes, 110);
    assert.equal(missedOvernight.schedule[0].windowViolation, true);
});

test('prioridade coloca Urgente antes de Alta e Normal', function () {
    const stops = [
        stop('N', 0.01, 0, { priority: 'Normal' }),
        stop('U', 0.02, 0, { priority: 'Urgente' }),
        stop('A', 0.03, 0, { priority: 'Alta' })
    ];
    const result = optimizeStops({
        stops,
        start: point(0, 0),
        matrix: matrix(completeMatrix(4, 0, 0)),
        departureTime: '2025-01-15T08:00:00.000Z'
    });

    assert.deepEqual(result.stops.map(function (item) { return item.id; }), ['U', 'A', 'N']);
    assert.deepEqual(result.schedule.map(function (item) { return item.index; }), [1, 2, 0]);
});

test('primeira parada informada permanece fixa', function () {
    const stops = [stop('A', 0.01, 0), stop('B', 0.02, 0), stop('C', 0.03, 0)];
    const result = optimizeStops({
        stops,
        start: point(0, 0),
        matrix: matrix(completeMatrix(4, 0, 0)),
        departureTime: '2025-01-15T08:00:00.000Z',
        firstStopId: 'B'
    });

    assert.equal(result.stops[0].id, 'B');
    assert.equal(result.schedule[0].stopId, 'B');
    assert.equal(result.schedule[0].index, 1);
});

test('última parada informada permanece fixa', function () {
    const stops = [stop('A', 0.01, 0), stop('B', 0.02, 0), stop('C', 0.03, 0)];
    const result = optimizeStops({
        stops,
        start: point(0, 0),
        matrix: matrix(completeMatrix(4, 0, 0)),
        departureTime: '2025-01-15T08:00:00.000Z',
        lastStopId: 'B'
    });

    assert.equal(result.stops[result.stops.length - 1].id, 'B');
    assert.equal(result.schedule[result.schedule.length - 1].stopId, 'B');
    assert.equal(result.schedule[result.schedule.length - 1].index, 1);
});

test('primeira e última paradas permanecem fixas durante a otimização', function () {
    const stops = [stop('A', 0.01, 0), stop('B', 0.02, 0), stop('C', 0.03, 0), stop('D', 0.04, 0)];
    const result = optimizeStops({
        stops,
        start: point(0, 0),
        matrix: matrix(completeMatrix(5, 0, 0)),
        departureTime: '2025-01-15T08:00:00.000Z',
        firstStopId: 'B',
        lastStopId: 'C'
    });

    assert.equal(result.stops[0].id, 'B');
    assert.equal(result.stops[result.stops.length - 1].id, 'C');
    assert.equal(new Set(result.stops.map(function (item) { return item.id; })).size, stops.length);
});

test('última parada normal escolhida fica depois das entregas urgentes', function () {
    const stops = [
        stop('N', 0.01, 0, { priority: 'Normal' }),
        stop('U', 0.02, 0, { priority: 'Urgente' }),
        stop('A', 0.03, 0, { priority: 'Alta' })
    ];
    const result = optimizeStops({
        stops,
        start: point(0, 0),
        matrix: matrix(completeMatrix(4, 0, 0)),
        departureTime: '2025-01-15T08:00:00.000Z',
        lastStopId: 'N'
    });

    assert.deepEqual(result.stops.map(function (item) { return item.id; }), ['U', 'A', 'N']);
});

test('mesma parada não pode ser primeira e última em uma rota com múltiplas entregas', function () {
    const stops = [stop('A', 0.01, 0), stop('B', 0.02, 0)];
    assert.throws(function () {
        optimizeStops({
            stops,
            start: point(0, 0),
            matrix: matrix(completeMatrix(3, 0, 0)),
            firstStopId: 'A',
            lastStopId: 'A'
        });
    }, /paradas diferentes/);
});

test('parada única pode ser primeira e última sem duplicar', function () {
    const result = optimizeStops({
        stops: [stop('A', 0.01, 0)],
        start: point(0, 0),
        matrix: matrix(completeMatrix(2, 0, 0)),
        firstStopId: 'A',
        lastStopId: 'A'
    });

    assert.deepEqual(result.stops.map(function (item) { return item.id; }), ['A']);
    assert.equal(result.schedule.length, 1);
});

test('2-opt usa a matriz fornecida e melhora a ordem gulosa', function () {
    const durations = [
        [0, 11, 25, 56, 42],
        [70, 0, 20, 34, 86],
        [82, 71, 0, 83, 61],
        [20, 23, 52, 0, 79],
        [27, 48, 18, 94, 0]
    ];
    const stops = [
        stop('A', 0.01, 0),
        stop('B', 0.02, 0),
        stop('C', 0.03, 0),
        stop('D', 0.04, 0)
    ];
    const result = optimizeStops({
        stops,
        start: point(0, 0),
        matrix: matrix(durations),
        departureTime: '2025-01-15T08:00:00.000Z'
    });

    assert.deepEqual(result.stops.map(function (item) { return item.id; }), ['A', 'C', 'D', 'B']);
    assert.equal(result.metrics.durationSec, 142);
    assert.equal(result.metrics.distanceMeters, 142000);
    assert.ok(result.schedule.every(function (item) { return Number.isFinite(item.durationSec); }));
});

test('parseDurationSeconds aceita formatos Google, ISO e texto', function () {
    assert.equal(parseDurationSeconds('742s'), 742);
    assert.equal(parseDurationSeconds('1.5s'), 1.5);
    assert.equal(parseDurationSeconds('PT1H2M3S'), 3723);
    assert.equal(parseDurationSeconds('P1DT2H'), 93600);
    assert.equal(parseDurationSeconds('1h 2min 3s'), 3723);
    assert.equal(parseDurationSeconds('01:02:03'), 3723);
    assert.equal(parseDurationSeconds(90), 90);
    assert.equal(parseDurationSeconds('inválido'), 0);
    assert.equal(parseDurationSeconds(null), 0);
});

test('computeRoute decodifica polyline Google e monta steps', async function () {
    const encoded = '_p~iF~ps|U_ulLnnqC_mqNvxq`@';
    const expectedCoords = [
        [38.5, -120.2],
        [40.7, -120.95],
        [43.252, -126.453]
    ];
    let captured;
    const result = await computeRoute([point(38.5, -120.2), point(43.252, -126.453)], {
        provider: 'google',
        googleKey: 'test-key',
        departureTime: '2025-01-15T08:00:00-03:00',
        request: async function (options) {
            captured = options;
            return {
                routes: [{
                    distanceMeters: 12345,
                    duration: '987s',
                    polyline: { encodedPolyline: encoded },
                    legs: [{
                        endLocation: { latLng: { latitude: 43.252, longitude: -126.453 } },
                        steps: [{
                            navigationInstruction: { instruction: 'Vire à esquerda.', maneuver: 'TURN_LEFT' },
                            distanceMeters: 500,
                            staticDuration: '45s'
                        }]
                    }]
                }]
            };
        }
    });

    assert.equal(captured.url, 'https://routes.googleapis.com/directions/v2:computeRoutes');
    assert.equal(captured.method, 'POST');
    assert.equal(captured.headers['X-Goog-Api-Key'], 'test-key');
    assert.equal(captured.body.travelMode, 'DRIVE');
    assert.equal(captured.body.routingPreference, 'TRAFFIC_AWARE');
    assert.equal(captured.body.departureTime, '2025-01-15T11:00:00.000Z');
    assert.equal(captured.body.languageCode, 'pt-BR');
    assert.equal(captured.body.regionCode, 'BR');
    assert.equal(captured.body.units, 'METRIC');
    assert.equal(result.provider, 'google');
    assert.equal(result.trafficAware, true);
    assert.equal(result.distanceMeters, 12345);
    assert.equal(result.durationSec, 987);
    assert.deepEqual(result.coords, expectedCoords);
    assert.deepEqual(result.steps[0], {
        instruction: 'Vire à esquerda.',
        maneuver: 'TURN_LEFT',
        distanceMeters: 500,
        durationSec: 45,
        location: [43.252, -126.453]
    });
});

test('buildMatrix monta matriz Google mockada e valida waypoints/field mask', async function () {
    const points = [point(0, 0), point(0, 1), point(1, 0)];
    let captured;
    const result = await buildMatrix(points, {
        provider: 'google',
        googleKey: 'matrix-key',
        departureTime: '2025-01-15T08:00:00.000Z',
        request: async function (options) {
            captured = options;
            const elements = [];
            for (let i = 0; i < points.length; i += 1) {
                for (let j = 0; j < points.length; j += 1) {
                    if (i === j) {
                        continue;
                    }
                    elements.push({
                        originIndex: i,
                        destinationIndex: j,
                        status: { code: 0 },
                        condition: 'ROUTE_EXISTS',
                        distanceMeters: 1000 + i * 100 + j,
                        duration: (100 + i * 10 + j) + 's'
                    });
                }
            }
            return elements;
        }
    });

    assert.equal(captured.url, 'https://routes.googleapis.com/distanceMatrix/v2:computeRouteMatrix');
    assert.equal(captured.headers['X-Goog-FieldMask'], 'originIndex,destinationIndex,status,condition,distanceMeters,duration');
    assert.equal(captured.body.origins.length, 3);
    assert.deepEqual(captured.body.origins[1].waypoint.location.latLng, { latitude: 0, longitude: 1 });
    assert.equal(captured.body.units, 'METRIC');
    assert.equal(captured.body.routingPreference, 'TRAFFIC_AWARE');
    assert.equal(captured.body.departureTime, '2025-01-15T08:00:00.000Z');
    assert.equal(result.provider, 'google');
    assert.equal(result.trafficAware, true);
    assert.deepEqual(result.durations, [[0, 101, 102], [110, 0, 112], [120, 121, 0]]);
    assert.deepEqual(result.distances, [[0, 1001, 1002], [1100, 0, 1102], [1200, 1201, 0]]);
});

test('elemento sem rota no Google causa fallback OSRM explícito', async function () {
    const points = [point(0, 0), point(0, 1)];
    const urls = [];
    const result = await buildMatrix(points, {
        provider: 'google',
        googleKey: 'test-key',
        request: async function (options) {
            urls.push(options.url);
            if (urls.length === 1) {
                return [{
                    originIndex: 0,
                    destinationIndex: 1,
                    status: { code: 0 },
                    condition: 'ROUTE_NOT_EXISTS'
                }];
            }
            return {
                durations: [[0, 100], [200, 0]],
                distances: [[0, 1000], [2000, 0]]
            };
        }
    });

    assert.equal(urls.length, 2);
    assert.match(urls[1], /^https:\/\/router\.project-osrm\.org\/table\/v1\/driving\//);
    assert.equal(result.provider, 'osrm');
    assert.equal(result.trafficAware, false);
    assert.deepEqual(result.durations, [[0, 100], [200, 0]]);
});

test('Google com mais de 25 pontos usa matriz OSRM e marca provider', async function () {
    const points = Array.from({ length: 26 }, function (_, index) {
        return point(index * 0.01, 0);
    });
    let captured;
    const result = await buildMatrix(points, {
        provider: 'google',
        googleKey: 'test-key',
        request: async function (options) {
            captured = options;
            return {
                durations: completeMatrix(26, 60, 60),
                distances: completeMatrix(26, 1000, 1000)
            };
        }
    });

    assert.match(captured.url, /^https:\/\/router\.project-osrm\.org\/table\/v1\/driving\//);
    assert.match(captured.url, /annotations=duration,distance$/);
    assert.equal(result.provider, 'osrm');
    assert.equal(result.trafficAware, false);
    assert.equal(result.durations.length, 26);
    assert.equal(result.durations[25][0], 60);
});

test('computeRoute usa OSRM mockado quando solicitado', async function () {
    let captured;
    const result = await computeRoute([point(0, 0), point(1, 1)], {
        provider: 'osrm',
        request: async function (options) {
            captured = options;
            return {
                code: 'Ok',
                routes: [{
                    distance: 1500,
                    duration: 120,
                    geometry: { coordinates: [[0, 0], [0.5, 0.5], [1, 1]] },
                    legs: [{
                        steps: [{
                            name: 'Avenida Central',
                            distance: 1500,
                            duration: 120,
                            maneuver: { type: 'turn', modifier: 'left', location: [1, 1] }
                        }]
                    }]
                }]
            };
        }
    });

    assert.match(captured.url, /steps=true&overview=full&geometries=geojson$/);
    assert.equal(result.provider, 'osrm');
    assert.equal(result.trafficAware, false);
    assert.deepEqual(result.coords, [[0, 0], [0.5, 0.5], [1, 1]]);
    assert.equal(result.steps[0].instruction, 'Avenida Central');
    assert.equal(result.steps[0].maneuver, 'turn left');
    assert.deepEqual(result.steps[0].location, [1, 1]);
});

test('rota grande conclui otimização e ETA sem exceder o limite', { timeout: 5000 }, function () {
    const priorities = ['Urgente', 'Alta', 'Normal'];
    const stops = Array.from({ length: 123 }, function (_, index) {
        return stop('P' + index, -22.3 + index * 0.0001, -49.1 + (index % 17) * 0.0001, {
            priority: priorities[index % priorities.length],
            serviceMinutes: 4,
            windowStart: '22:00',
            windowEnd: '02:00',
            windowType: 'Conclusão'
        });
    });
    const result = optimizeStops({
        stops,
        start: point(-22.27608, -49.09304),
        matrix: matrix(completeMatrix(124, 600, 2000)),
        departureTime: '2026-11-23T20:00:00.000Z',
        firstStopId: 'P0',
        lastStopId: 'P122'
    });
    const ranks = { urgente: 0, alta: 1, normal: 2 };
    const rank = function (item) { return ranks[String(item.priority).toLowerCase()]; };

    assert.equal(result.stops.length, 123);
    assert.equal(result.schedule.length, 123);
    assert.equal(result.stops[0].id, 'P0');
    assert.equal(result.stops[result.stops.length - 1].id, 'P122');
    assert.ok(result.schedule.every(function (item) { return Number.isFinite(item.durationSec); }));
    assert.ok(Number.isFinite(Date.parse(result.metrics.finishAt)));
    assert.ok(result.stops.every(function (item, index, route) {
        return index === 0 || rank(item) >= rank(route[index - 1]);
    }));
});
