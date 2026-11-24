(function (root, factory) {
    'use strict';

    var api = factory();
    if (typeof module === 'object' && module.exports) {
        module.exports = api;
    }
    if (root && typeof root === 'object') {
        root.SPXRouteEngine = api;
    }
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    var GOOGLE_MATRIX_URL = 'https://routes.googleapis.com/distanceMatrix/v2:computeRouteMatrix';
    var GOOGLE_ROUTES_URL = 'https://routes.googleapis.com/directions/v2:computeRoutes';
    var OSRM_BASE_URL = 'https://router.project-osrm.org';
    var GOOGLE_MATRIX_FIELD_MASK = 'originIndex,destinationIndex,status,condition,distanceMeters,duration';
    var GOOGLE_ROUTES_FIELD_MASK = 'routes.distanceMeters,routes.duration,routes.polyline.encodedPolyline,routes.legs.steps.navigationInstruction,routes.legs.steps.distanceMeters,routes.legs.steps.staticDuration,routes.legs.endLocation';
    var GOOGLE_BLOCK_SIZE = 25;
    var FULL_INSERTION_LIMIT = 60;
    var TWO_OPT_LIMIT = 80;
    var EARTH_RADIUS_KM = 6371.0088;
    var ROAD_FACTOR = 1.28;
    var ROAD_SPEED_KMH = 28;
    var PRIORITY_RANK = { urgente: 0, alta: 1, normal: 2 };

    function finiteNonNegative(value) {
        if (value === null || value === undefined || value === '') {
            return null;
        }
        var number = typeof value === 'number' ? value : Number(value);
        return Number.isFinite(number) && number >= 0 ? number : null;
    }

    function roundMetric(value) {
        var number = finiteNonNegative(value);
        if (number === null) {
            return 0;
        }
        return Math.round(number * 100) / 100;
    }

    function readPoint(point, label) {
        var lat;
        var lng;
        if (Array.isArray(point)) {
            lat = point[0];
            lng = point[1];
        } else if (point && typeof point === 'object') {
            lat = point.lat !== undefined ? point.lat : point.latitude;
            lng = point.lng !== undefined ? point.lng : point.longitude;
        }
        lat = Number(lat);
        lng = Number(lng);
        if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
            throw new TypeError((label || 'Ponto') + ' deve ter latitude e longitude válidas.');
        }
        return { lat: lat, lng: lng };
    }

    function normalizePoints(points) {
        if (!Array.isArray(points)) {
            throw new TypeError('points deve ser um array.');
        }
        return points.map(function (point, index) {
            return readPoint(point, 'points[' + index + ']');
        });
    }

    function haversineKm(a, b) {
        var first = readPoint(a, 'a');
        var second = readPoint(b, 'b');
        var lat1 = first.lat * Math.PI / 180;
        var lat2 = second.lat * Math.PI / 180;
        var deltaLat = lat2 - lat1;
        var deltaLng = (second.lng - first.lng) * Math.PI / 180;
        var sinLat = Math.sin(deltaLat / 2);
        var sinLng = Math.sin(deltaLng / 2);
        var value = sinLat * sinLat + Math.cos(lat1) * Math.cos(lat2) * sinLng * sinLng;
        value = Math.max(0, Math.min(1, value));
        return 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(value));
    }

    function fallbackDistanceMeters(a, b) {
        return Math.round(haversineKm(a, b) * 1000 * ROAD_FACTOR);
    }

    function fallbackDurationSec(distanceMeters) {
        var distance = finiteNonNegative(distanceMeters);
        return distance === null ? 0 : Math.round(distance * 3600 / (ROAD_SPEED_KMH * 1000));
    }

    function parseDurationValue(value) {
        if (typeof value === 'number') {
            return Number.isFinite(value) && value >= 0 ? value : null;
        }
        if (typeof value !== 'string') {
            return null;
        }

        var text = value.trim();
        if (!text) {
            return null;
        }
        if (/^\d+(?:\.\d+)?$/.test(text)) {
            var plain = Number(text);
            return Number.isFinite(plain) ? plain : null;
        }

        var iso = text.match(/^P(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/i);
        if (iso && (iso[1] || iso[2] || iso[3] || iso[4])) {
            var isoSeconds = (Number(iso[1] || 0) * 86400) +
                (Number(iso[2] || 0) * 3600) +
                (Number(iso[3] || 0) * 60) +
                Number(iso[4] || 0);
            return Number.isFinite(isoSeconds) ? isoSeconds : null;
        }

        var clock = text.match(/^(\d+):(\d{1,2})(?::(\d{1,2}(?:\.\d+)?))?$/);
        if (clock) {
            var first = Number(clock[1]);
            var second = Number(clock[2]);
            var third = clock[3] === undefined ? 0 : Number(clock[3]);
            if (second < 60 && third < 60) {
                var clockSeconds = clock[3] === undefined ? first * 60 + second : first * 3600 + second * 60 + third;
                return Number.isFinite(clockSeconds) ? clockSeconds : null;
            }
            return null;
        }

        var unitPattern = /(\d+(?:\.\d+)?)\s*(hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)/gi;
        var match;
        var unitSeconds = 0;
        var foundUnit = false;
        var remaining = text;
        while ((match = unitPattern.exec(text)) !== null) {
            foundUnit = true;
            var amount = Number(match[1]);
            var unit = match[2].toLowerCase().charAt(0);
            if (unit === 'h') {
                unitSeconds += amount * 3600;
            } else if (unit === 'm') {
                unitSeconds += amount * 60;
            } else {
                unitSeconds += amount;
            }
            remaining = remaining.replace(match[0], ' ');
        }
        if (foundUnit && !remaining.replace(/[\s,;]+/g, '')) {
            return Number.isFinite(unitSeconds) ? unitSeconds : null;
        }
        return null;
    }

    function parseDurationSeconds(str) {
        var value = parseDurationValue(str);
        return value === null ? 0 : value;
    }

    function toDateMs(value, fallback) {
        if (value instanceof Date) {
            var dateValue = value.getTime();
            return Number.isFinite(dateValue) ? dateValue : null;
        }
        if (typeof value === 'number') {
            var numeric = value;
            if (Math.abs(numeric) < 100000000000) {
                numeric *= 1000;
            }
            var numericDate = new Date(numeric).getTime();
            return Number.isFinite(numericDate) ? numericDate : null;
        }
        if (typeof value === 'string' && value.trim()) {
            var text = value.trim();
            if (/^\d+(?:\.\d+)?$/.test(text)) {
                return toDateMs(Number(text), fallback);
            }
            var parsed = new Date(text).getTime();
            return Number.isFinite(parsed) ? parsed : null;
        }
        return fallback === undefined ? null : fallback;
    }

    function rfc3339(value) {
        var milliseconds = toDateMs(value, Date.now());
        return new Date(milliseconds === null ? Date.now() : milliseconds).toISOString();
    }

    function throwIfAborted(signal) {
        if (signal && signal.aborted) {
            var error = new Error('Operação cancelada.');
            error.name = 'AbortError';
            throw error;
        }
    }

    function isAbort(error, signal) {
        return Boolean((signal && signal.aborted) || (error && error.name === 'AbortError'));
    }

    function warnFallback(message, error) {
        if (typeof console !== 'undefined' && typeof console.warn === 'function') {
            console.warn('[SPXRouteEngine] ' + message + (error && error.message ? ': ' + error.message : ''));
        }
    }

    async function requestJson(request, url, method, headers, body, signal) {
        throwIfAborted(signal);
        var options = { url: url, method: method, headers: headers, body: body, signal: signal };
        var payload;
        if (typeof request === 'function') {
            payload = await request(options);
        } else {
            if (typeof fetch !== 'function') {
                throw new Error('fetch não está disponível e request não foi informado.');
            }
            var response = await fetch(url, {
                method: method,
                headers: headers,
                body: JSON.stringify(body),
                signal: signal
            });
            if (response.ok === false) {
                throw new Error('HTTP ' + response.status + ' ao consultar ' + url);
            }
            payload = await response.json();
        }
        throwIfAborted(signal);
        return payload;
    }

    function googleHeaders(googleKey, fieldMask) {
        var headers = {
            'Content-Type': 'application/json',
            'X-Goog-FieldMask': fieldMask
        };
        if (googleKey) {
            headers['X-Goog-Api-Key'] = String(googleKey);
        }
        return headers;
    }

    function googleWaypoint(point) {
        return {
            waypoint: {
                location: {
                    latLng: { latitude: point.lat, longitude: point.lng }
                }
            }
        };
    }

    function emptyMatrix(size) {
        var matrix = [];
        for (var i = 0; i < size; i += 1) {
            matrix.push(new Array(size).fill(0));
        }
        return matrix;
    }

    function statusIsOk(status) {
        if (status === undefined || status === null) {
            return true;
        }
        if (typeof status === 'string') {
            return status.toUpperCase() === 'OK';
        }
        if (typeof status === 'object') {
            return status.code === undefined || status.code === null || Number(status.code) === 0;
        }
        return false;
    }

    async function googleMatrix(points, googleKey, departureTime, request, signal) {
        var size = points.length;
        var durations = emptyMatrix(size);
        var distances = emptyMatrix(size);
        if (size <= 1) {
            return { durations: durations, distances: distances, provider: 'google', trafficAware: true };
        }

        var departure = rfc3339(departureTime);
        for (var originStart = 0; originStart < size; originStart += GOOGLE_BLOCK_SIZE) {
            var originEnd = Math.min(size, originStart + GOOGLE_BLOCK_SIZE);
            for (var destinationStart = 0; destinationStart < size; destinationStart += GOOGLE_BLOCK_SIZE) {
                var destinationEnd = Math.min(size, destinationStart + GOOGLE_BLOCK_SIZE);
                var origins = points.slice(originStart, originEnd).map(googleWaypoint);
                var destinations = points.slice(destinationStart, destinationEnd).map(googleWaypoint);
                var body = {
                    origins: origins,
                    destinations: destinations,
                    travelMode: 'DRIVE',
                    routingPreference: 'TRAFFIC_AWARE',
                    departureTime: departure,
                    languageCode: 'pt-BR',
                    regionCode: 'BR',
                    units: 'METRIC'
                };
                var payload = await requestJson(
                    request,
                    GOOGLE_MATRIX_URL,
                    'POST',
                    googleHeaders(googleKey, GOOGLE_MATRIX_FIELD_MASK),
                    body,
                    signal
                );
                var elements = Array.isArray(payload) ? payload : payload && payload.elements;
                if (!Array.isArray(elements)) {
                    throw new Error('Resposta inválida da matriz Google.');
                }

                var seen = new Set();
                elements.forEach(function (element) {
                    var requestOriginIndex = Number(element.originIndex);
                    var requestDestinationIndex = Number(element.destinationIndex);
                    if (!Number.isInteger(requestOriginIndex) || !Number.isInteger(requestDestinationIndex) ||
                        requestOriginIndex < 0 || requestOriginIndex >= origins.length ||
                        requestDestinationIndex < 0 || requestDestinationIndex >= destinations.length) {
                        throw new Error('Índice inválido em um elemento da matriz Google.');
                    }
                    var originIndex = originStart + requestOriginIndex;
                    var destinationIndex = destinationStart + requestDestinationIndex;
                    if (originIndex === destinationIndex) {
                        return;
                    }
                    seen.add(originIndex + ':' + destinationIndex);
                    var condition = element.condition ? String(element.condition).toUpperCase() : '';
                    if (!statusIsOk(element.status) || condition === 'ROUTE_NOT_EXISTS' || condition === 'ROUTE_NOT_FOUND') {
                        throw new Error('Google sem rota de ' + originIndex + ' para ' + destinationIndex + '.');
                    }
                    var duration = parseDurationValue(element.duration);
                    var distance = finiteNonNegative(element.distanceMeters);
                    if (duration === null || distance === null) {
                        throw new Error('Google sem duração/distância de ' + originIndex + ' para ' + destinationIndex + '.');
                    }
                    durations[originIndex][destinationIndex] = duration;
                    distances[originIndex][destinationIndex] = distance;
                });

                for (var i = originStart; i < originEnd; i += 1) {
                    for (var j = destinationStart; j < destinationEnd; j += 1) {
                        if (i !== j && !seen.has(i + ':' + j)) {
                            throw new Error('Google não retornou rota de ' + i + ' para ' + j + '.');
                        }
                    }
                }
            }
        }
        return { durations: durations, distances: distances, provider: 'google', trafficAware: true };
    }

    function osrmCoordinates(points) {
        return points.map(function (point) {
            return point.lng + ',' + point.lat;
        }).join(';');
    }

    async function osrmMatrix(points, request, signal) {
        var size = points.length;
        var durations = emptyMatrix(size);
        var distances = emptyMatrix(size);
        if (size <= 1) {
            return { durations: durations, distances: distances, provider: 'osrm', trafficAware: false };
        }
        var url = OSRM_BASE_URL + '/table/v1/driving/' + osrmCoordinates(points) + '?annotations=duration,distance';
        var payload = await requestJson(request, url, 'GET', {}, undefined, signal);
        var responseDurations = payload && payload.durations;
        var responseDistances = payload && (payload.distances || payload.distance);
        if (!Array.isArray(responseDurations) || !Array.isArray(responseDistances) ||
            responseDurations.length !== size || responseDistances.length !== size) {
            throw new Error('Resposta inválida da tabela OSRM.');
        }
        for (var i = 0; i < size; i += 1) {
            if (!Array.isArray(responseDurations[i]) || !Array.isArray(responseDistances[i]) ||
                responseDurations[i].length !== size || responseDistances[i].length !== size) {
                throw new Error('Tabela OSRM incompleta.');
            }
            for (var j = 0; j < size; j += 1) {
                if (i === j) {
                    continue;
                }
                var duration = finiteNonNegative(responseDurations[i][j]);
                var distance = finiteNonNegative(responseDistances[i][j]);
                if (duration === null || distance === null) {
                    throw new Error('OSRM sem rota de ' + i + ' para ' + j + '.');
                }
                durations[i][j] = duration;
                distances[i][j] = distance;
            }
        }
        return { durations: durations, distances: distances, provider: 'osrm', trafficAware: false };
    }

    function fallbackMatrix(points) {
        var size = points.length;
        var durations = emptyMatrix(size);
        var distances = emptyMatrix(size);
        for (var i = 0; i < size; i += 1) {
            for (var j = i + 1; j < size; j += 1) {
                var distance = fallbackDistanceMeters(points[i], points[j]);
                var duration = fallbackDurationSec(distance);
                distances[i][j] = distance;
                distances[j][i] = distance;
                durations[i][j] = duration;
                durations[j][i] = duration;
            }
        }
        return { durations: durations, distances: distances, provider: 'fallback', trafficAware: false };
    }

    async function buildMatrix(points, options) {
        var settings = options || {};
        var normalized = normalizePoints(points);
        var provider = String(settings.provider || 'auto').toLowerCase();
        var signal = settings.signal;
        throwIfAborted(signal);

        if (provider === 'fallback') {
            return fallbackMatrix(normalized);
        }

        var useGoogle = provider === 'google' || (provider === 'auto' && Boolean(settings.googleKey));
        if (useGoogle && normalized.length > GOOGLE_BLOCK_SIZE) {
            warnFallback('Matriz Google com mais de 25 pontos; usando OSRM para controlar o custo.');
            useGoogle = false;
            provider = 'osrm';
        }

        if (useGoogle) {
            if (!settings.googleKey) {
                warnFallback('Chave Google ausente; usando OSRM.');
            } else {
                try {
                    return await googleMatrix(normalized, settings.googleKey, settings.departureTime, settings.request, signal);
                } catch (error) {
                    if (isAbort(error, signal)) {
                        throw error;
                    }
                    warnFallback('Falha na matriz Google; usando OSRM.', error);
                }
            }
            provider = 'osrm';
        }

        if (provider === 'osrm' || provider === 'auto') {
            try {
                return await osrmMatrix(normalized, settings.request, signal);
            } catch (error) {
                if (isAbort(error, signal)) {
                    throw error;
                }
                warnFallback('Falha na matriz OSRM; usando Haversine rodoviário.', error);
            }
        }
        return fallbackMatrix(normalized);
    }

    function decodeEncodedPolyline(encoded) {
        if (typeof encoded !== 'string' || !encoded) {
            throw new Error('Polyline Google ausente.');
        }
        var coordinates = [];
        var index = 0;
        var lat = 0;
        var lng = 0;
        while (index < encoded.length) {
            var latResult = decodePolylineValue(encoded, index);
            index = latResult.index;
            lat += latResult.delta;
            var lngResult = decodePolylineValue(encoded, index);
            index = lngResult.index;
            lng += lngResult.delta;
            coordinates.push([lat / 100000, lng / 100000]);
        }
        if (!coordinates.length) {
            throw new Error('Polyline Google vazia.');
        }
        return coordinates;
    }

    function decodePolylineValue(encoded, startIndex) {
        var index = startIndex;
        var result = 0;
        var shift = 0;
        var byte;
        do {
            if (index >= encoded.length) {
                throw new Error('Polyline Google truncada.');
            }
            byte = encoded.charCodeAt(index) - 63;
            index += 1;
            result |= (byte & 0x1f) << shift;
            shift += 5;
        } while (byte >= 0x20);
        var delta = result & 1 ? ~(result >> 1) : result >> 1;
        return { delta: delta, index: index };
    }

    function latLngFromGoogle(location) {
        if (!location) {
            return null;
        }
        var latLng = location.latLng || location;
        var point = readPoint({ lat: latLng.latitude, lng: latLng.longitude }, 'localização Google');
        return [point.lat, point.lng];
    }

    async function googleRoute(points, googleKey, departureTime, request, signal) {
        if (points.length < 2) {
            return fallbackRoute(points);
        }
        var body = {
            origin: googleWaypoint(points[0]),
            destination: googleWaypoint(points[points.length - 1]),
            intermediates: points.slice(1, -1).map(googleWaypoint),
            travelMode: 'DRIVE',
            routingPreference: 'TRAFFIC_AWARE',
            departureTime: rfc3339(departureTime),
            languageCode: 'pt-BR',
            regionCode: 'BR',
            units: 'METRIC'
        };
        var payload = await requestJson(
            request,
            GOOGLE_ROUTES_URL,
            'POST',
            googleHeaders(googleKey, GOOGLE_ROUTES_FIELD_MASK),
            body,
            signal
        );
        var route = payload && Array.isArray(payload.routes) ? payload.routes[0] : null;
        var distance = route && finiteNonNegative(route.distanceMeters);
        var duration = route && parseDurationValue(route.duration);
        if (!route || distance === null || duration === null) {
            throw new Error('Google não retornou uma rota válida.');
        }
        var coords = decodeEncodedPolyline(route.polyline && route.polyline.encodedPolyline);
        var steps = [];
        (route.legs || []).forEach(function (leg) {
            var location = latLngFromGoogle(leg.endLocation);
            (leg.steps || []).forEach(function (step) {
                var instruction = step.navigationInstruction || {};
                var stepDuration = parseDurationValue(step.staticDuration);
                if (stepDuration === null) {
                    stepDuration = parseDurationValue(step.duration);
                }
                steps.push({
                    instruction: instruction.instruction || '',
                    maneuver: instruction.maneuver || '',
                    distanceMeters: roundMetric(step.distanceMeters),
                    durationSec: roundMetric(stepDuration === null ? 0 : stepDuration),
                    location: location || (step.endLocation ? latLngFromGoogle(step.endLocation) : null)
                });
            });
        });
        return {
            provider: 'google',
            trafficAware: true,
            distanceMeters: roundMetric(distance),
            durationSec: roundMetric(duration),
            coords: coords,
            steps: steps
        };
    }

    function locationFromLngLat(value) {
        if (!Array.isArray(value) || value.length < 2) {
            return null;
        }
        var point = readPoint([value[1], value[0]], 'localização OSRM');
        return [point.lat, point.lng];
    }

    async function osrmRoute(points, request, signal) {
        if (points.length < 2) {
            return fallbackRoute(points);
        }
        var url = OSRM_BASE_URL + '/route/v1/driving/' + osrmCoordinates(points) +
            '?steps=true&overview=full&geometries=geojson';
        var payload = await requestJson(request, url, 'GET', {}, undefined, signal);
        var route = payload && (payload.code === undefined || payload.code === 'Ok') && Array.isArray(payload.routes) ? payload.routes[0] : null;
        var distance = route && finiteNonNegative(route.distance);
        var duration = route && parseDurationValue(route.duration);
        if (!route || distance === null || duration === null) {
            throw new Error('OSRM não retornou uma rota válida.');
        }
        var coordinates = route.geometry && Array.isArray(route.geometry.coordinates) ? route.geometry.coordinates : null;
        var coords = coordinates && coordinates.length ? coordinates.map(locationFromLngLat).filter(Boolean) : points.map(function (point) {
            return [point.lat, point.lng];
        });
        if (coords.length < 2) {
            throw new Error('Geometria OSRM inválida.');
        }
        var steps = [];
        (route.legs || []).forEach(function (leg) {
            (leg.steps || []).forEach(function (step) {
                var maneuver = step.maneuver || {};
                var type = maneuver.type || '';
                var modifier = maneuver.modifier || '';
                var maneuverLabel = modifier ? type + ' ' + modifier : type;
                steps.push({
                    instruction: step.name || step.ref || (type ? 'Siga ' + type : ''),
                    maneuver: maneuverLabel,
                    distanceMeters: roundMetric(step.distance),
                    durationSec: roundMetric(parseDurationValue(step.duration) || 0),
                    location: locationFromLngLat(maneuver.location)
                });
            });
        });
        return {
            provider: 'osrm',
            trafficAware: false,
            distanceMeters: roundMetric(distance),
            durationSec: roundMetric(duration),
            coords: coords,
            steps: steps
        };
    }

    function fallbackRoute(points) {
        var normalized = normalizePoints(points);
        var distance = 0;
        var duration = 0;
        var steps = [];
        for (var i = 1; i < normalized.length; i += 1) {
            var legDistance = fallbackDistanceMeters(normalized[i - 1], normalized[i]);
            var legDuration = fallbackDurationSec(legDistance);
            distance += legDistance;
            duration += legDuration;
            steps.push({
                instruction: 'Siga até o próximo ponto.',
                maneuver: i === 1 ? 'depart' : 'straight',
                distanceMeters: legDistance,
                durationSec: legDuration,
                location: [normalized[i].lat, normalized[i].lng]
            });
        }
        if (normalized.length === 1) {
            steps.push({
                instruction: 'Destino alcançado.',
                maneuver: 'arrive',
                distanceMeters: 0,
                durationSec: 0,
                location: [normalized[0].lat, normalized[0].lng]
            });
        }
        return {
            provider: 'fallback',
            trafficAware: false,
            distanceMeters: roundMetric(distance),
            durationSec: roundMetric(duration),
            coords: normalized.map(function (point) { return [point.lat, point.lng]; }),
            steps: steps
        };
    }

    async function computeRoute(points, options) {
        var settings = options || {};
        var normalized = normalizePoints(points);
        var provider = String(settings.provider || 'auto').toLowerCase();
        var signal = settings.signal;
        throwIfAborted(signal);
        if (provider === 'fallback') {
            return fallbackRoute(normalized);
        }

        var useGoogle = provider === 'google' || (provider === 'auto' && Boolean(settings.googleKey));
        if (useGoogle) {
            if (!settings.googleKey) {
                warnFallback('Chave Google ausente; usando OSRM.');
            } else {
                try {
                    return await googleRoute(normalized, settings.googleKey, settings.departureTime, settings.request, signal);
                } catch (error) {
                    if (isAbort(error, signal)) {
                        throw error;
                    }
                    warnFallback('Falha na rota Google; usando OSRM.', error);
                }
            }
        }

        if (provider === 'osrm' || provider === 'auto' || useGoogle) {
            try {
                return await osrmRoute(normalized, settings.request, signal);
            } catch (error) {
                if (isAbort(error, signal)) {
                    throw error;
                }
                warnFallback('Falha na rota OSRM; usando Haversine rodoviário.', error);
            }
        }
        return fallbackRoute(normalized);
    }

    function normalizedWord(value) {
        return String(value || '')
            .normalize('NFD')
            .replace(/[\u0300-\u036f]/g, '')
            .trim()
            .toLowerCase();
    }

    function priorityRank(stop) {
        var rank = PRIORITY_RANK[normalizedWord(stop.priority)];
        return rank === undefined ? PRIORITY_RANK.normal : rank;
    }

    function serviceMinutes(stop) {
        return finiteNonNegative(stop.serviceMinutes) || 0;
    }

    function parseClock(value) {
        if (typeof value !== 'string') {
            return null;
        }
        var match = value.trim().match(/^(\d{1,2}):(\d{2})$/);
        if (!match) {
            return null;
        }
        var hours = Number(match[1]);
        var minutes = Number(match[2]);
        if (hours > 23 || minutes > 59) {
            return null;
        }
        return hours * 60 + minutes;
    }

    function atLocalClock(milliseconds, minutes) {
        var date = new Date(milliseconds);
        date.setHours(0, 0, 0, 0);
        date.setMinutes(minutes);
        return date.getTime();
    }

    function shiftLocalDays(milliseconds, days) {
        var date = new Date(milliseconds);
        date.setDate(date.getDate() + days);
        return date.getTime();
    }

    function windowForArrival(arrivalMs, stop) {
        var startMinutes = parseClock(stop.windowStart);
        var endMinutes = parseClock(stop.windowEnd);
        if (startMinutes === null || endMinutes === null) {
            return null;
        }
        var startToday = atLocalClock(arrivalMs, startMinutes);
        var endToday = atLocalClock(arrivalMs, endMinutes);
        if (endMinutes < startMinutes) {
            endToday = shiftLocalDays(endToday, 1);
        }
        var previousStart = shiftLocalDays(startToday, -1);
        var previousEnd = shiftLocalDays(endToday, -1);
        if (arrivalMs >= previousStart && arrivalMs <= previousEnd) {
            return { start: previousStart, end: previousEnd };
        }
        if (arrivalMs >= startToday && arrivalMs <= endToday) {
            return { start: startToday, end: endToday };
        }
        if (arrivalMs > previousEnd && arrivalMs < startToday) {
            if (arrivalMs - previousEnd <= startToday - arrivalMs) {
                return { start: previousStart, end: previousEnd };
            }
            return { start: startToday, end: endToday };
        }
        if (arrivalMs > endToday) {
            var nextStart = shiftLocalDays(startToday, 1);
            var nextEnd = shiftLocalDays(endToday, 1);
            if (arrivalMs - endToday <= nextStart - arrivalMs) {
                return { start: startToday, end: endToday };
            }
            return { start: nextStart, end: nextEnd };
        }
        return { start: startToday, end: endToday };
    }

    function prepareLegs(stops, start, matrix) {
        var size = stops.length + 1;
        var points = [start].concat(stops.map(function (entry) { return entry.stop; }));
        var durationMatrix = matrix && Array.isArray(matrix.durations) ? matrix.durations : [];
        var distanceMatrix = matrix && Array.isArray(matrix.distances) ? matrix.distances : [];
        var legs = [];
        for (var from = 0; from < size; from += 1) {
            legs[from] = [];
            for (var to = 0; to < size; to += 1) {
                if (from === to) {
                    legs[from][to] = { distanceMeters: 0, durationSec: 0 };
                    continue;
                }
                var matrixDistance = distanceMatrix[from] && finiteNonNegative(distanceMatrix[from][to]);
                var matrixDuration = durationMatrix[from] && finiteNonNegative(durationMatrix[from][to]);
                var distance = matrixDistance === null || matrixDistance === undefined ? fallbackDistanceMeters(points[from], points[to]) : matrixDistance;
                var duration = matrixDuration === null || matrixDuration === undefined ? fallbackDurationSec(distance) : matrixDuration;
                legs[from][to] = { distanceMeters: roundMetric(distance), durationSec: roundMetric(duration) };
            }
        }
        return legs;
    }

    function scheduleOrder(order, context, detailed) {
        var now = context.departureMs;
        var previousMatrixIndex = 0;
        var totalDistance = 0;
        var totalDuration = 0;
        var totalService = 0;
        var totalLateMinutes = 0;
        var totalWaitMinutes = 0;
        var violations = 0;
        var schedule = detailed === false ? null : [];
        order.forEach(function (entry) {
            var matrixIndex = entry.originalIndex + 1;
            var leg = context.legs[previousMatrixIndex][matrixIndex];
            var arrivalMs = now + leg.durationSec * 1000;
            var minutes = serviceMinutes(entry.stop);
            var serviceMs = minutes * 60000;
            var window = windowForArrival(arrivalMs, entry.stop);
            var serviceStartMs = window ? Math.max(arrivalMs, window.start) : arrivalMs;
            var serviceEndMs = serviceStartMs + serviceMs;
            var isConclusion = normalizedWord(entry.stop.windowType) === 'conclusao';
            var measuredMs = window && isConclusion ? serviceEndMs : arrivalMs;
            var lateMs = window ? Math.max(0, measuredMs - window.end) : 0;
            var waitMinutes = (serviceStartMs - arrivalMs) / 60000;
            var lateMinutes = lateMs / 60000;
            totalDistance += leg.distanceMeters;
            totalDuration += leg.durationSec;
            totalService += minutes;
            totalLateMinutes += lateMinutes;
            totalWaitMinutes += waitMinutes;
            if (lateMs > 0) {
                violations += 1;
            }
            if (schedule) {
                var stopId = entry.stop.id !== undefined && entry.stop.id !== null ? entry.stop.id : entry.stop.groupId;
                if (stopId === undefined || stopId === null) {
                    stopId = 'stop-' + entry.originalIndex;
                }
                schedule.push({
                    stopId: stopId,
                    index: entry.originalIndex,
                    arrivalAt: new Date(arrivalMs).toISOString(),
                    serviceStartAt: new Date(serviceStartMs).toISOString(),
                    serviceEndAt: new Date(serviceEndMs).toISOString(),
                    waitMinutes: roundMetric(waitMinutes),
                    lateMinutes: roundMetric(lateMinutes),
                    windowViolation: lateMs > 0,
                    distanceMeters: roundMetric(leg.distanceMeters),
                    durationSec: roundMetric(leg.durationSec)
                });
            }
            now = serviceEndMs;
            previousMatrixIndex = matrixIndex;
        });

        var finishMs = now;
        var metrics = {
            distanceMeters: roundMetric(totalDistance),
            durationSec: roundMetric(totalDuration),
            serviceMinutes: roundMetric(totalService),
            finishAt: new Date(finishMs).toISOString(),
            totalLateMinutes: roundMetric(totalLateMinutes)
        };
        var score = totalDuration + totalWaitMinutes * 60 +
            totalLateMinutes * 60 * 8 + violations * 60 * 3;
        return { schedule: schedule || [], metrics: metrics, score: score, finishMs: finishMs };
    }

    function insertionPositions(route, tier, fixedEntry) {
        if (!route.length) {
            return [0];
        }
        var last = -1;
        for (var i = route.length - 1; i >= 0; i -= 1) {
            if (route[i].tier === tier) {
                last = i;
                break;
            }
        }
        if (last !== route.length - 1) {
            return [route.length];
        }
        var first = last;
        while (first > 0 && route[first - 1].tier === tier) {
            first -= 1;
        }
        if (fixedEntry && fixedEntry.tier === tier) {
            var fixedPosition = route.indexOf(fixedEntry);
            if (fixedPosition >= first && fixedPosition <= last) {
                first = fixedPosition + 1;
            }
        }
        var positions = [];
        for (var position = first; position <= last + 1; position += 1) {
            positions.push(position);
        }
        return positions;
    }

    function betterCandidate(candidate, current) {
        if (!current) {
            return true;
        }
        var epsilon = 0.000001;
        if (candidate.result.score < current.result.score - epsilon) {
            return true;
        }
        if (Math.abs(candidate.result.score - current.result.score) <= epsilon) {
            if (candidate.result.metrics.durationSec < current.result.metrics.durationSec - epsilon) {
                return true;
            }
            if (Math.abs(candidate.result.metrics.durationSec - current.result.metrics.durationSec) <= epsilon) {
                if (candidate.result.metrics.totalLateMinutes < current.result.metrics.totalLateMinutes - epsilon) {
                    return true;
                }
                if (Math.abs(candidate.result.metrics.totalLateMinutes - current.result.metrics.totalLateMinutes) <= epsilon) {
                    if (candidate.entry.originalIndex < current.entry.originalIndex) {
                        return true;
                    }
                    if (candidate.entry.originalIndex === current.entry.originalIndex && candidate.position > current.position) {
                        return true;
                    }
                }
            }
        }
        return false;
    }

    function nearestNeighborByTier(entries, firstEntry, lastEntry, context) {
        var route = firstEntry ? [firstEntry] : [];
        [0, 1, 2].forEach(function (tier) {
            var remaining = entries.filter(function (entry) {
                return entry !== firstEntry && entry !== lastEntry && entry.tier === tier;
            });
            while (remaining.length) {
                var fromIndex = route.length ? route[route.length - 1].originalIndex + 1 : 0;
                var bestIndex = 0;
                var bestLeg = context.legs[fromIndex][remaining[0].originalIndex + 1];
                var bestScore = bestLeg.durationSec + bestLeg.distanceMeters / 1000;
                for (var index = 1; index < remaining.length; index += 1) {
                    var leg = context.legs[fromIndex][remaining[index].originalIndex + 1];
                    var score = leg.durationSec + leg.distanceMeters / 1000;
                    if (score < bestScore - 0.000001 ||
                            (Math.abs(score - bestScore) <= 0.000001 && remaining[index].originalIndex < remaining[bestIndex].originalIndex)) {
                        bestIndex = index;
                        bestScore = score;
                    }
                }
                route.push(remaining.splice(bestIndex, 1)[0]);
            }
        });
        if (lastEntry && lastEntry !== firstEntry) route.push(lastEntry);
        return route;
    }

    function greedyInsertion(entries, firstEntry, lastEntry, context) {
        if (entries.length > FULL_INSERTION_LIMIT) return nearestNeighborByTier(entries, firstEntry, lastEntry, context);
        var route = firstEntry ? [firstEntry] : [];
        var remaining = entries.filter(function (entry) { return entry !== firstEntry && entry !== lastEntry; });
        [0, 1, 2].forEach(function (tier) {
            var tierRemaining = remaining.filter(function (entry) { return entry.tier === tier; });
            while (tierRemaining.length) {
                var positions = insertionPositions(route, tier, firstEntry);
                var best = null;
                tierRemaining.forEach(function (entry) {
                    positions.forEach(function (position) {
                        var candidateRoute = route.slice();
                        candidateRoute.splice(position, 0, entry);
                        var result = scheduleOrder(candidateRoute, context, false);
                        var candidate = { entry: entry, position: position, route: candidateRoute, result: result };
                        if (betterCandidate(candidate, best)) {
                            best = candidate;
                        }
                    });
                });
                route = best.route;
                remaining = remaining.filter(function (entry) { return entry !== best.entry; });
                tierRemaining = tierRemaining.filter(function (entry) { return entry !== best.entry; });
            }
        });
        if (lastEntry && lastEntry !== firstEntry) route.push(lastEntry);
        return route;
    }

    function twoOpt(route, firstEntry, lastEntry, context) {
        var current = route;
        var currentResult = scheduleOrder(current, context, false);
        var maxIterations = Math.min(40, Math.max(12, current.length));
        var iteration = 0;
        while (iteration < maxIterations) {
            iteration += 1;
            var best = null;
            for (var i = 0; i < current.length - 1; i += 1) {
                for (var j = i + 1; j < current.length; j += 1) {
                    var tier = current[i].tier;
                    var sameTier = true;
                    var containsEndpoint = false;
                    for (var k = i; k <= j; k += 1) {
                        if (current[k].tier !== tier) {
                            sameTier = false;
                            break;
                        }
                        if (current[k] === firstEntry || current[k] === lastEntry) {
                            containsEndpoint = true;
                        }
                    }
                    if (!sameTier || containsEndpoint) {
                        continue;
                    }
                    var candidateRoute = current.slice();
                    var segment = candidateRoute.slice(i, j + 1).reverse();
                    candidateRoute.splice.apply(candidateRoute, [i, segment.length].concat(segment));
                    var result = scheduleOrder(candidateRoute, context, false);
                    if (result.score < currentResult.score - 0.000001) {
                        best = { route: candidateRoute, result: result };
                    }
                }
            }
            if (!best) {
                break;
            }
            current = best.route;
            currentResult = best.result;
        }
        return current;
    }

    function optimizeStops(options) {
        var settings = options || {};
        if (!Array.isArray(settings.stops)) {
            throw new TypeError('stops deve ser um array.');
        }
        var start = readPoint(settings.start, 'start');
        var departureMs = toDateMs(settings.departureTime, Date.now());
        if (departureMs === null) {
            departureMs = Date.now();
        }
        var entries = settings.stops.map(function (stop, index) {
            if (!stop || typeof stop !== 'object') {
                throw new TypeError('stops[' + index + '] deve ser um objeto.');
            }
            var normalizedStop = Object.assign({}, stop, readPoint(stop, 'stops[' + index + ']'));
            return {
                stop: normalizedStop,
                originalIndex: index,
                tier: priorityRank(normalizedStop)
            };
        });
        function findEntry(stopId) {
            return entries.find(function (entry) {
                return String(entry.stop.id) === String(stopId) ||
                    String(entry.stop.groupId) === String(stopId);
            }) || null;
        }
        var firstEntry = settings.firstStopId === undefined || settings.firstStopId === null
            ? null : findEntry(settings.firstStopId);
        var lastEntry = settings.lastStopId === undefined || settings.lastStopId === null
            ? null : findEntry(settings.lastStopId);
        if (firstEntry && lastEntry && firstEntry === lastEntry && entries.length > 1) {
            throw new Error('A primeira e a última entrega devem ser paradas diferentes.');
        }
        var context = {
            departureMs: departureMs,
            legs: prepareLegs(entries, start, settings.matrix)
        };
        var route;
        if (settings.strategy === 'nearest') {
            route = nearestNeighborByTier(entries, firstEntry, lastEntry, context);
        } else {
            route = greedyInsertion(entries, firstEntry, lastEntry, context);
            if (route.length <= TWO_OPT_LIMIT) route = twoOpt(route, firstEntry, lastEntry, context);
        }
        var result = scheduleOrder(route, context);
        return {
            stops: route.map(function (entry) { return entry.stop; }),
            schedule: result.schedule,
            metrics: result.metrics
        };
    }

    return {
        haversineKm: haversineKm,
        parseDurationSeconds: parseDurationSeconds,
        buildMatrix: buildMatrix,
        computeRoute: computeRoute,
        optimizeStops: optimizeStops
    };
}));
