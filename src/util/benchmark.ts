// in the console run:
// runMaplibreBenchmark(46.58432, 7.9645, 10, 10.9, 10);
// runMaplibreBenchmark(46.58432, 7.9645, 10, 10.9, 10, true);

import {Actor} from './actor';

function findParsingTimings(obj: any): any | null {
    if (!obj || typeof obj !== 'object') return null;
    if (obj.parsingTimings) return obj.parsingTimings;
    for (const value of Object.values(obj)) {
        const found = findParsingTimings(value);
        if (found) return found;
    }
    return null;
}

// Monkey-patch Actor.receive on the main thread to intercept worker parsing messages
const originalReceive = Actor.prototype.receive;
Actor.prototype.receive = function(this: any, message: any) {
    const globalWindow = window as any;
    const isBenchmarking = globalWindow.maplibreBenchmark;

    if (isBenchmarking && message && message.data) {
        const timings = findParsingTimings(message.data);
        if (timings) {
            if (!globalWindow.workerTimings) {
                globalWindow.workerTimings = {};
            }
            for (const [layerId, duration] of Object.entries(timings)) {
                if (typeof duration === 'number') {
                    if (!globalWindow.workerTimings[layerId]) {
                        globalWindow.workerTimings[layerId] = { total: 0, count: 0 };
                    }
                    globalWindow.workerTimings[layerId].total += duration;
                    globalWindow.workerTimings[layerId].count += 1;
                }
            }
        }
    }
    return originalReceive.call(this, message);
};

export class MaplibreBenchmark {
    private static _timerId: any = null;
    private static _countdownId: any = null;

    // FPS tracking states
    private static _frameCount = 0;
    private static _lastFrameTime = 0;
    private static _frameDeltas: number[] = [];
    private static _rAFId: any = null;
    private static _fpsResults: { avg: number; onePercentLow: number; totalFrames: number; totalDurationSeconds: number } | null = null;

    // Automated loop states
    private static _isAutomated = false;
    private static _isSilent = false;
    private static _currentMapInstance: any = null;
    private static _boundMoveEndListener: (() => void) | null = null;

    /**
     * Start standard manual benchmark
     */
    static start(durationSeconds: number = 10): void {
        this._isSilent = false;
        this.resetTimingGlobals(false);
        this._isAutomated = false;

        console.log('%c[MapLibre Benchmark] Started manual mode. Please pan and zoom around the map.', 'color: #00aa00; font-weight: bold; font-size: 13px;');

        this.startFPSTracking();

        if (this._timerId) clearTimeout(this._timerId);
        if (this._countdownId) clearInterval(this._countdownId);

        let remaining = durationSeconds;
        console.log('Time remaining: ' + remaining + 's...', 'color: #888;');
        this._countdownId = setInterval(() => {
            remaining--;
            if (remaining > 0) {
                console.log('Time remaining: ' + remaining + 's...', 'color: #888;');
            } else {
                clearInterval(this._countdownId);
            }
        }, 1000);

        this._timerId = setTimeout(() => {
            this.stop();
        }, durationSeconds * 1000);
    }

    /**
     * Start automated zoom benchmark targeting specific coordinates
     */
    static startAutomated(lat: number, lng: number, minZoom: number, maxZoom: number, repeats: number, passedMap?: any, silent: boolean = false): void {
        const map = passedMap || this.findMapInstance();
        if (!map) {
            console.error(
                '%c[MapLibre Benchmark] Error: Could not locate map instance. Ensure window.map is set to your MapLibre map, or pass it as the first argument: runMaplibreBenchmark(map, lat, lng, ...)', 
                'color: #ff0000; font-weight: bold;'
            );
            return;
        }

        this._currentMapInstance = map;
        this._isAutomated = true;
        this._isSilent = silent;
        this.resetTimingGlobals(silent);

        console.log('%c[MapLibre Benchmark] Initializing automated zoom loop...', 'color: #00aa00; font-weight: bold; font-size: 13px;');
        console.log('Target Coordinates: [Lat: ' + lat + ', Lng: ' + lng + '], Zoom Cycle: ' + minZoom + ' -> ' + maxZoom + ', repeats: ' + repeats + ', silent: ' + silent);

        // Jump instantly to coordinate and min zoom, then wait for map to load/settle
        map.jumpTo({
            center: [lng, lat], // MapLibre coordinates are [lng, lat]
            zoom: minZoom
        });

        let idleTimeout: any = null;

        const beginAnimationCycles = () => {
            if (idleTimeout) clearTimeout(idleTimeout);
            map.off('idle', beginAnimationCycles);

            console.log('%c[MapLibre Benchmark] Map settled. Starting active cycles and FPS tracking.', 'color: #00aa55; font-weight: bold;');
            this.startFPSTracking();

            let cycleCount = 0;
            let isZoomingIn = true;

            const executeNextStep = () => {
                if (!this._isAutomated) return;

                if (cycleCount >= repeats) {
                    this.stop();
                    return;
                }

                const targetZoom = isZoomingIn ? maxZoom : minZoom;

                // easeTo provides active rendering for realistic frame performance
                map.easeTo({
                    center: [lng, lat],
                    zoom: targetZoom,
                    duration: 2000, // 2 seconds per transition
                    animate: true,
                    essential: true
                });

                this._boundMoveEndListener = () => {
                    if (!isZoomingIn) {
                        cycleCount++;
                        console.log('%c[MapLibre Benchmark] Completed cycle ' + cycleCount + '/' + repeats, 'color: #888;');
                    }
                    isZoomingIn = !isZoomingIn;
                    executeNextStep();
                };

                map.once('moveend', this._boundMoveEndListener);
            };

            executeNextStep();
        };

        // Wait for map 'idle' event to load initial assets; fallback after 1.5 seconds if idle does not trigger
        map.once('idle', beginAnimationCycles);
        idleTimeout = setTimeout(beginAnimationCycles, 1500);
    }

    static stop(): void {
        if (this._timerId) {
            clearTimeout(this._timerId);
            this._timerId = null;
        }
        if (this._countdownId) {
            clearInterval(this._countdownId);
            this._countdownId = null;
        }

        // Unregister listeners
        if (this._currentMapInstance && this._boundMoveEndListener) {
            this._currentMapInstance.off('moveend', this._boundMoveEndListener);
            this._boundMoveEndListener = null;
        }

        this._isAutomated = false;
        this._currentMapInstance = null;
        
        // Calculate and stop FPS metrics
        this._fpsResults = this.stopFPSTracking();

        const globalWindow = window as any;
        globalWindow.maplibreBenchmark = false;

        console.log('%c[MapLibre Benchmark] Completed. Formatting results...', 'color: #0055ff; font-weight: bold; font-size: 13px;');
        this.printResults();
    }

    private static resetTimingGlobals(silent: boolean): void {
        const globalWindow = window as any;
        globalWindow.layerTimings = {};
        globalWindow.layoutTimings = {};
        globalWindow.recalcTimings = {};
        globalWindow.uploadTimings = {};
        globalWindow.workerTimings = {};
        globalWindow.maplibreBenchmark = !silent; // Only activate profiling if NOT silent
    }

    private static startFPSTracking(): void {
        this._frameCount = 0;
        this._frameDeltas = [];
        this._lastFrameTime = performance.now();

        const frameLoop = (timestamp: number) => {
            const delta = timestamp - this._lastFrameTime;
            this._lastFrameTime = timestamp;

            // Skip the first frame's delta initialization to avoid timing setup spikes
            if (this._frameCount > 0) {
                this._frameDeltas.push(delta);
            }
            this._frameCount++;
            this._rAFId = requestAnimationFrame(frameLoop);
        };
        this._rAFId = requestAnimationFrame(frameLoop);
    }

    private static stopFPSTracking() {
        if (this._rAFId) {
            cancelAnimationFrame(this._rAFId);
            this._rAFId = null;
        }

        if (this._frameDeltas.length === 0) return null;

        const totalDurationMs = this._frameDeltas.reduce((a, b) => a + b, 0);
        const avgFps = (this._frameDeltas.length / totalDurationMs) * 1000;

        // Calculate 1% Low FPS by sorting slow frames (largest deltas first)
        const sortedDeltas = [...this._frameDeltas].sort((a, b) => b - a);
        const onePercentIndex = Math.floor(sortedDeltas.length * 0.01);
        const onePercentLowFps = onePercentIndex > 0 ? 1000 / sortedDeltas[onePercentIndex] : avgFps;

        return {
            avg: +avgFps.toFixed(1),
            onePercentLow: +onePercentLowFps.toFixed(1),
            totalFrames: this._frameDeltas.length,
            totalDurationSeconds: +(totalDurationMs / 1000).toFixed(2)
        };
    }

    private static findMapInstance(): any {
        const globalWindow = window as any;

        // Ensure the object actually contains key MapLibre Map methods
        const isValidMap = (obj: any) => {
            return obj && 
                   typeof obj.jumpTo === 'function' && 
                   typeof obj.easeTo === 'function' && 
                   typeof obj.on === 'function';
        };

        if (isValidMap(globalWindow.map)) {
            return globalWindow.map;
        }
        if (isValidMap(globalWindow.maplibreMap)) {
            return globalWindow.maplibreMap;
        }

        // Search window globally for an active map instance if not bound to standard names
        for (const key of Object.keys(globalWindow)) {
            try {
                const val = globalWindow[key];
                if (isValidMap(val)) {
                    return val;
                }
            } catch (e) {
                // Protect against cross-origin iframe check issues
            }
        }

        return null;
    }

    private static printResults(): void {
        const globalWindow = window as any;

        const formatTimings = (timings: any) => {
            if (!timings) return [];
            return Object.entries(timings)
                .map(([id, stats]: any) => ({
                    'Layer ID': id,
                    'Avg Time (ms)': +(stats.total / stats.count).toFixed(3),
                    'Total Time (ms)': +stats.total.toFixed(3),
                    'Samples': stats.count
                }))
                .sort((a, b) => b['Avg Time (ms)'] - a['Avg Time (ms)']);
        };

        const renderData = formatTimings(globalWindow.layerTimings);
        const layoutData = formatTimings(globalWindow.layoutTimings);
        const recalcData = formatTimings(globalWindow.recalcTimings);
        const uploadData = formatTimings(globalWindow.uploadTimings);
        const workerData = formatTimings(globalWindow.workerTimings);

        console.group('%c--- MAPLIBRE BENCHMARK RESULTS ---', 'font-size: 14px; font-weight: bold; color: #ff5500;');

        if (this._fpsResults) {
            console.log('%c PERFORMANCE METRICS:', 'font-weight: bold; font-size: 12px; color: #0055ff;');
            console.log('%c Average FPS:        %c' + this._fpsResults.avg + ' fps', 'color: #333;', 'font-weight: bold; color: #000;');
            console.log('%c 1% Low FPS:         %c' + this._fpsResults.onePercentLow + ' fps', 'color: #333;', 'font-weight: bold; color: #cc0000;');
            console.log('%c Total Frames:       %c' + this._fpsResults.totalFrames, 'color: #333;', 'color: #000;');
            console.log('%c Total Duration:     %c' + this._fpsResults.totalDurationSeconds + 's', 'color: #333;', 'color: #000;');
            console.log('\n');
        }

        if (this._isSilent) {
            console.log('%cStyle profiling and worker tracking skipped (Silent Mode is active).', 'color: #888; font-style: italic;');
        } else {
            this.displayTable('1. RENDERING PHASE (WebGL Paint - GPU/CPU Bound)', renderData, '#00aa55');
            this.displayTable('2. LAYOUT & COLLISION PHASE (CPU Bound Placement)', layoutData, '#ffaa00');
            this.displayTable('3. STYLE RECALCULATION (CPU Bound Expression Evaluation)', recalcData, '#aa00ff');
            this.displayTable('4. GPU MEMORY UPLOADS (Synchronous WebGL Buffer Blocking)', uploadData, '#cc0000');
            this.displayTable('5. WEB WORKER TILE PARSING (Asynchronous PBF Decoding)', workerData, '#0055ff');
        }

        console.groupEnd();
    }

    private static displayTable(title: string, data: any[], color: string): void {
        if (data.length > 0) {
            console.log('%c' + title, 'font-weight: bold; font-size: 11px; color: ' + color + ';');
            console.table(data);
        } else {
            console.log('%c' + title + ' (No samples recorded)', 'color: #888; font-style: italic;');
        }
    }
}

if (typeof window !== 'undefined') {
    (window as any).runMaplibreBenchmark = (...args: any[]) => {
        if (args.length === 0) {
            MaplibreBenchmark.start(10);
        } else if (args.length === 1 && typeof args[0] === 'number') {
            MaplibreBenchmark.start(args[0]);
        } else {
            let map: any = null;
            let lat: number, lng: number, minZoom: number, maxZoom: number, repeats: number;
            let silent = false;

            if (typeof args[0] === 'object' && args[0] !== null) {
                // Signature: runMaplibreBenchmark(map, lat, lng, min, max, repeats, silent)
                [map, lat, lng, minZoom, maxZoom, repeats, silent] = args;
            } else {
                // Signature: runMaplibreBenchmark(lat, lng, min, max, repeats, silent)
                [lat, lng, minZoom, maxZoom, repeats, silent] = args;
            }

            if (typeof silent !== 'boolean') {
                silent = false;
            }

            MaplibreBenchmark.startAutomated(lat, lng, minZoom, maxZoom, repeats, map, silent);
        }
        return 'Benchmark initiated.';
    };
}