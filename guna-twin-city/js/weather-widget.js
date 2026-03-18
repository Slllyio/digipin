/**
 * Weather Widget Module — Guna Digital Twin
 * ==========================================
 * Live weather data from Open-Meteo (free, no API key).
 *
 *  - Current conditions: temp, humidity, wind, weather icon
 *  - 24h hourly forecast with CSS bar chart (click to expand)
 *  - Auto-refresh every 30 minutes
 *  - localStorage cache with 30min TTL
 *
 * SECURITY: All DOM built via createElement / textContent. No innerHTML.
 */

const WeatherWidget = (() => {
    // ═══════════════════════════════════════════════════════════════
    // CONSTANTS
    // ═══════════════════════════════════════════════════════════════

    const LAT = GUNA_CONFIG.lat;
    const LNG = GUNA_CONFIG.lng;
    const REFRESH_MS = 30 * 60 * 1000; // 30 minutes
    const CACHE_KEY = 'weather_widget_cache';
    const CACHE_TTL = 30 * 60 * 1000; // 30 minutes

    const API_URL =
        'https://api.open-meteo.com/v1/forecast' +
        `?latitude=${LAT}&longitude=${LNG}` +
        '&current=temperature_2m,relative_humidity_2m,wind_speed_10m,weather_code,precipitation' +
        '&hourly=temperature_2m,precipitation_probability,weather_code' +
        '&forecast_days=1' +
        '&timezone=Asia/Kolkata';

    /** WMO Weather Code to emoji + label mapping */
    const WEATHER_MAP = {
        0:  { emoji: '\u2600\uFE0F', label: 'Clear sky' },
        1:  { emoji: '\u26C5',       label: 'Mainly clear' },
        2:  { emoji: '\u26C5',       label: 'Partly cloudy' },
        3:  { emoji: '\u2601\uFE0F', label: 'Overcast' },
        45: { emoji: '\uD83C\uDF2B\uFE0F', label: 'Fog' },
        48: { emoji: '\uD83C\uDF2B\uFE0F', label: 'Rime fog' },
        51: { emoji: '\uD83C\uDF26\uFE0F', label: 'Light drizzle' },
        53: { emoji: '\uD83C\uDF26\uFE0F', label: 'Drizzle' },
        55: { emoji: '\uD83C\uDF27\uFE0F', label: 'Dense drizzle' },
        56: { emoji: '\uD83C\uDF27\uFE0F', label: 'Freezing drizzle' },
        57: { emoji: '\uD83C\uDF27\uFE0F', label: 'Dense freezing drizzle' },
        61: { emoji: '\uD83C\uDF27\uFE0F', label: 'Slight rain' },
        63: { emoji: '\uD83C\uDF27\uFE0F', label: 'Moderate rain' },
        65: { emoji: '\uD83C\uDF27\uFE0F', label: 'Heavy rain' },
        66: { emoji: '\uD83C\uDF27\uFE0F', label: 'Freezing rain' },
        67: { emoji: '\uD83C\uDF27\uFE0F', label: 'Heavy freezing rain' },
        71: { emoji: '\uD83C\uDF28\uFE0F', label: 'Slight snow' },
        73: { emoji: '\uD83C\uDF28\uFE0F', label: 'Moderate snow' },
        75: { emoji: '\uD83C\uDF28\uFE0F', label: 'Heavy snow' },
        77: { emoji: '\uD83C\uDF28\uFE0F', label: 'Snow grains' },
        80: { emoji: '\uD83C\uDF26\uFE0F', label: 'Slight showers' },
        81: { emoji: '\uD83C\uDF27\uFE0F', label: 'Moderate showers' },
        82: { emoji: '\uD83C\uDF27\uFE0F', label: 'Violent showers' },
        85: { emoji: '\uD83C\uDF28\uFE0F', label: 'Snow showers' },
        86: { emoji: '\uD83C\uDF28\uFE0F', label: 'Heavy snow showers' },
        95: { emoji: '\u26A1',       label: 'Thunderstorm' },
        96: { emoji: '\u26A1',       label: 'Thunderstorm with hail' },
        99: { emoji: '\u26A1',       label: 'Severe thunderstorm' },
    };

    // ═══════════════════════════════════════════════════════════════
    // STATE
    // ═══════════════════════════════════════════════════════════════

    let _container = null;
    let _expanded = false;
    let _refreshTimer = null;

    // ═══════════════════════════════════════════════════════════════
    // CACHE
    // ═══════════════════════════════════════════════════════════════

    function _cacheGet() {
        try {
            const raw = localStorage.getItem(CACHE_KEY);
            if (!raw) return null;
            const cached = JSON.parse(raw);
            if (Date.now() - cached.ts > CACHE_TTL) {
                localStorage.removeItem(CACHE_KEY);
                return null;
            }
            return cached.data;
        } catch (_) {
            return null;
        }
    }

    function _cacheSet(data) {
        try {
            localStorage.setItem(CACHE_KEY, JSON.stringify({ ts: Date.now(), data }));
        } catch (_) {
            // storage full — ignore
        }
    }

    // ═══════════════════════════════════════════════════════════════
    // HELPERS
    // ═══════════════════════════════════════════════════════════════

    function _weatherInfo(code) {
        return WEATHER_MAP[code] || { emoji: '\uD83C\uDF24\uFE0F', label: 'Unknown' };
    }

    function _el(tag, cls, textContent) {
        const el = document.createElement(tag);
        if (cls) el.className = cls;
        if (textContent !== undefined) el.textContent = textContent;
        return el;
    }

    function _formatHour(isoString) {
        const d = new Date(isoString);
        const h = d.getHours();
        if (h === 0) return '12am';
        if (h === 12) return '12pm';
        return h > 12 ? (h - 12) + 'pm' : h + 'am';
    }

    // ═══════════════════════════════════════════════════════════════
    // STYLES (injected once)
    // ═══════════════════════════════════════════════════════════════

    function _injectStyles() {
        if (document.getElementById('weather-widget-styles')) return;
        const style = document.createElement('style');
        style.id = 'weather-widget-styles';
        style.textContent = `
            #weather-widget {
                position: fixed;
                bottom: 28px;
                left: 10px;
                z-index: 800;
                background: rgba(30, 30, 30, 0.92);
                color: #fff;
                border-radius: 10px;
                padding: 10px 14px;
                font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
                font-size: 13px;
                cursor: pointer;
                user-select: none;
                backdrop-filter: blur(8px);
                border: 1px solid rgba(255,255,255,0.08);
                box-shadow: 0 4px 16px rgba(0,0,0,0.4);
                min-width: 160px;
                max-width: 320px;
                transition: max-height 0.3s ease, padding 0.3s ease;
            }
            #weather-widget .ww-header {
                display: flex;
                align-items: center;
                gap: 8px;
            }
            #weather-widget .ww-icon {
                font-size: 26px;
                line-height: 1;
            }
            #weather-widget .ww-temp {
                font-size: 22px;
                font-weight: 700;
                letter-spacing: -0.5px;
            }
            #weather-widget .ww-details {
                display: flex;
                flex-direction: column;
                gap: 1px;
                margin-left: 4px;
            }
            #weather-widget .ww-detail-row {
                font-size: 11px;
                color: rgba(255,255,255,0.65);
            }
            #weather-widget .ww-label {
                font-size: 10px;
                color: rgba(255,255,255,0.4);
                margin-top: 2px;
            }
            #weather-widget .ww-forecast {
                display: none;
                margin-top: 10px;
                padding-top: 8px;
                border-top: 1px solid rgba(255,255,255,0.1);
            }
            #weather-widget.ww-expanded .ww-forecast {
                display: block;
            }
            #weather-widget .ww-forecast-title {
                font-size: 11px;
                color: rgba(255,255,255,0.5);
                margin-bottom: 6px;
            }
            #weather-widget .ww-chart {
                display: flex;
                align-items: flex-end;
                gap: 2px;
                height: 60px;
            }
            #weather-widget .ww-bar-col {
                display: flex;
                flex-direction: column;
                align-items: center;
                flex: 1;
                min-width: 0;
            }
            #weather-widget .ww-bar {
                width: 100%;
                min-height: 2px;
                border-radius: 2px 2px 0 0;
                transition: height 0.3s ease;
            }
            #weather-widget .ww-bar-label {
                font-size: 8px;
                color: rgba(255,255,255,0.45);
                margin-top: 2px;
                white-space: nowrap;
                overflow: hidden;
            }
            #weather-widget .ww-bar-temp {
                font-size: 8px;
                color: rgba(255,255,255,0.7);
                margin-bottom: 2px;
            }
            #weather-widget .ww-error {
                font-size: 11px;
                color: #ff6b6b;
            }
            #weather-widget .ww-loading {
                font-size: 11px;
                color: rgba(255,255,255,0.5);
            }
        `;
        document.head.appendChild(style);
    }

    // ═══════════════════════════════════════════════════════════════
    // DOM BUILDING
    // ═══════════════════════════════════════════════════════════════

    function _buildCard(data) {
        // Clear existing content
        while (_container.firstChild) {
            _container.removeChild(_container.firstChild);
        }
        _container.classList.remove('ww-expanded');
        _expanded = false;

        if (!data || !data.current) {
            const err = _el('div', 'ww-error', 'Weather unavailable');
            _container.appendChild(err);
            return;
        }

        const current = data.current;
        const info = _weatherInfo(current.weather_code);

        // Header row
        const header = _el('div', 'ww-header');

        const icon = _el('span', 'ww-icon', info.emoji);
        header.appendChild(icon);

        const temp = _el('span', 'ww-temp', Math.round(current.temperature_2m) + '\u00B0C');
        header.appendChild(temp);

        const details = _el('div', 'ww-details');

        const humRow = _el('span', 'ww-detail-row',
            '\uD83D\uDCA7 ' + current.relative_humidity_2m + '%  \uD83C\uDF2C\uFE0F ' + current.wind_speed_10m + ' km/h');
        details.appendChild(humRow);

        const condRow = _el('span', 'ww-detail-row', info.label);
        details.appendChild(condRow);

        header.appendChild(details);
        _container.appendChild(header);

        const label = _el('div', 'ww-label', 'Guna \u2022 Click for forecast');
        _container.appendChild(label);

        // Forecast section
        if (data.hourly && data.hourly.time && data.hourly.time.length > 0) {
            const forecast = _el('div', 'ww-forecast');

            const title = _el('div', 'ww-forecast-title', '24-Hour Forecast');
            forecast.appendChild(title);

            const chart = _buildChart(data.hourly);
            forecast.appendChild(chart);

            _container.appendChild(forecast);
        }
    }

    function _buildChart(hourly) {
        const chart = _el('div', 'ww-chart');
        const temps = hourly.temperature_2m;
        const times = hourly.time;
        const codes = hourly.weather_code;

        const minT = Math.min(...temps);
        const maxT = Math.max(...temps);
        const range = maxT - minT || 1;

        // Show every other hour to fit 12 bars
        for (let i = 0; i < times.length; i += 2) {
            const col = _el('div', 'ww-bar-col');

            const tempLabel = _el('span', 'ww-bar-temp', Math.round(temps[i]) + '\u00B0');
            col.appendChild(tempLabel);

            const bar = _el('div', 'ww-bar');
            const pct = ((temps[i] - minT) / range) * 100;
            const barHeight = Math.max(4, (pct / 100) * 50);
            bar.style.height = barHeight + 'px';

            // Color based on weather code
            const codeInfo = _weatherInfo(codes[i]);
            const code = codes[i];
            if (code >= 95) {
                bar.style.background = '#e74c3c';
            } else if (code >= 51) {
                bar.style.background = '#3498db';
            } else if (code >= 45) {
                bar.style.background = '#95a5a6';
            } else if (code >= 1) {
                bar.style.background = '#f39c12';
            } else {
                bar.style.background = '#2ecc71';
            }

            col.appendChild(bar);

            const hourLabel = _el('span', 'ww-bar-label', _formatHour(times[i]));
            col.appendChild(hourLabel);

            chart.appendChild(col);
        }

        return chart;
    }

    // ═══════════════════════════════════════════════════════════════
    // DATA FETCHING
    // ═══════════════════════════════════════════════════════════════

    async function _fetchWeather() {
        // Try cache first
        const cached = _cacheGet();
        if (cached) {
            _buildCard(cached);
            return;
        }

        // Show loading
        while (_container.firstChild) {
            _container.removeChild(_container.firstChild);
        }
        const loading = _el('div', 'ww-loading', 'Loading weather...');
        _container.appendChild(loading);

        try {
            const resp = await fetch(API_URL);
            if (!resp.ok) throw new Error('HTTP ' + resp.status);
            const data = await resp.json();
            _cacheSet(data);
            _buildCard(data);
        } catch (err) {
            console.warn('[WeatherWidget] Fetch error:', err);
            while (_container.firstChild) {
                _container.removeChild(_container.firstChild);
            }
            const errEl = _el('div', 'ww-error', 'Weather unavailable');
            _container.appendChild(errEl);
        }
    }

    // ═══════════════════════════════════════════════════════════════
    // INIT
    // ═══════════════════════════════════════════════════════════════

    function init() {
        _injectStyles();

        _container = _el('div');
        _container.id = 'weather-widget';
        _container.setAttribute('role', 'complementary');
        _container.setAttribute('aria-label', 'Weather conditions for Guna');

        _container.addEventListener('click', () => {
            _expanded = !_expanded;
            if (_expanded) {
                _container.classList.add('ww-expanded');
            } else {
                _container.classList.remove('ww-expanded');
            }
        });

        document.body.appendChild(_container);

        // Initial fetch
        _fetchWeather();

        // Auto-refresh
        _refreshTimer = setInterval(() => {
            _fetchWeather();
        }, REFRESH_MS);
    }

    function destroy() {
        if (_refreshTimer) {
            clearInterval(_refreshTimer);
            _refreshTimer = null;
        }
        if (_container && _container.parentNode) {
            _container.parentNode.removeChild(_container);
            _container = null;
        }
    }

    // ═══════════════════════════════════════════════════════════════
    // AUTO-INIT ON DOM READY
    // ═══════════════════════════════════════════════════════════════

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

    // ═══════════════════════════════════════════════════════════════
    // PUBLIC API
    // ═══════════════════════════════════════════════════════════════

    return Object.freeze({
        init,
        destroy,
        refresh: _fetchWeather,
    });
})();
