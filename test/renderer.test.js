const assert = require('assert');
const { readFileSync } = require('fs');
const { test } = require('node:test');
const { join } = require('path');
const { pathToFileURL } = require('url');
const { Renderer } = require('../renderer');

test('adapts DLNA volume controls to the YouTube Music receiver contract', async () => {
    const player = Object.create(Renderer.prototype);
    player.friendlyName = 'Test speaker';
    let requestedVolume;
    player.client = {
        getVolume(callback) {
            callback(null, 42);
        },
        setVolume(volume, callback) {
            requestedVolume = volume;
            callback(null);
        },
        getPosition(callback) {
            callback(null, 30);
        },
        getDuration(callback) {
            callback(null, 240);
        }
    };

    assert.deepStrictEqual(await player.doGetVolume(), { level: 42, muted: false });
    assert.strictEqual(await player.doSetVolume({ level: 70, muted: true }), true);
    assert.strictEqual(requestedVolume, 70);
    player.hasLoadedTrack = false;
    assert.strictEqual(await player.doGetPosition(), 0);
    assert.strictEqual(await player.doGetDuration(), 0);

    player.hasLoadedTrack = true;
    assert.strictEqual(await player.doGetPosition(), 30);
    assert.strictEqual(await player.doGetDuration(), 240);
});

test('serializes playback and uses renderer-specific temporary files', () => {
    const renderer = readFileSync('renderer.js', 'utf8');
    const doPlay = renderer.slice(
        renderer.indexOf('async doPlay'),
        renderer.indexOf('async doPause')
    );

    assert.match(renderer, /this\.playerPlayPromise && this\.pendingVideoId === video\.id/);
    assert.match(renderer, /if \(this\.playPromise\) \{/);
    assert.match(renderer, /return this\.playPromise;/);
    assert.match(renderer, /this\.loadingVideoId !== video\.id/);
    assert.match(renderer, /this\.queuedPlay = queuedPlay/);
    assert.match(renderer, /return this\.doPlay\(video, position\)/);
    assert.match(
        renderer,
        /this\.loadingTrack \|\| Date\.now\(\) < this\.stopProtectionExpiresAt/
    );
    assert.match(renderer, /upnptube-\$\{this\.index\}-\$\{videoId\}\.m4a/);
    assert.match(renderer, /--js-runtimes node/);
    assert.match(renderer, /autoplay: false/);
    assert.match(renderer, /setTimeout\(startPlayback, PLAY_AFTER_LOAD_DELAY_MS\)/);
    assert.match(renderer, /dlnaFeatures: 'DLNA\.ORG_PN=AAC_ISO'/);
    assert.match(renderer, /obj\.startPlaybackMonitor\(\)/);
    assert.match(renderer, /await this\.next\(\)/);
    assert.doesNotMatch(doPlay, /client\.seek/);
});

test('retains a first playlist entry selected at index zero', async () => {
    const playlistModulePath = join(
        __dirname,
        '..',
        'node_modules',
        'yt-cast-receiver',
        'dist',
        'lib',
        'app',
        'Playlist.js'
    );
    const { default: Playlist } = await import(pathToFileURL(playlistModulePath).href);
    const playlist = new Playlist();
    playlist.setRequestHandler({
        async getPreviousNextVideosAbortable() {
            return {};
        }
    });

    await playlist.updateByMessage({
        name: 'setPlaylist',
        payload: {
            listId: 'LM',
            currentIndex: 0,
            videoId: 'HyGngB-14MQ'
        }
    }, {});

    assert.strictEqual(playlist.current.id, 'HyGngB-14MQ');
});

test('normalizes YouTube Music videoEntry playlist selections', async () => {
    const playlistModulePath = join(
        __dirname,
        '..',
        'node_modules',
        'yt-cast-receiver',
        'dist',
        'lib',
        'app',
        'Playlist.js'
    );
    const { default: Playlist } = await import(pathToFileURL(playlistModulePath).href);
    const playlist = new Playlist();
    playlist.setRequestHandler({
        async getPreviousNextVideosAbortable() {
            return {};
        }
    });

    await playlist.updateByMessage({
        name: 'setPlaylist',
        payload: {
            videoEntry: JSON.stringify({
                sourceContainerPlaylistId: 'LM',
                videoId: 'Z4jQ4hZfk00'
            })
        }
    }, {});

    assert.strictEqual(playlist.current.id, 'Z4jQ4hZfk00');
    assert.strictEqual(playlist.current.context.index, 0);
});

test('keeps the newly selected video current when the previous/next lookup fails', async () => {
    const playlistModulePath = join(
        __dirname,
        '..',
        'node_modules',
        'yt-cast-receiver',
        'dist',
        'lib',
        'app',
        'Playlist.js'
    );
    const { default: Playlist } = await import(pathToFileURL(playlistModulePath).href);
    const playlist = new Playlist();
    const loggedErrors = [];
    playlist.setLogger({
        error(...args) {
            loggedErrors.push(args);
        }
    });
    playlist.setRequestHandler({
        async getPreviousNextVideosAbortable() {
            // Simulate a transient network failure (e.g. ECONNRESET/"socket hang up")
            // while fetching previous/next video info from YouTube.
            throw new Error('socket hang up');
        }
    });

    // Should not throw even though the previous/next lookup rejected; the newly
    // selected video must still become current so playback can proceed.
    await playlist.updateByMessage({
        name: 'setPlaylist',
        payload: {
            listId: 'LM',
            currentIndex: 0,
            videoId: 'HyGngB-14MQ'
        }
    }, {});

    assert.strictEqual(playlist.current.id, 'HyGngB-14MQ');
    assert.strictEqual(playlist.hasNext, false);
    assert.strictEqual(playlist.hasPrevious, false);
    assert.ok(loggedErrors.length > 0);
});

test('falls back to zero position and duration on transient socket errors', async () => {
    const player = Object.create(Renderer.prototype);
    player.friendlyName = 'Test speaker';
    player.hasLoadedTrack = true;
    player.client = {
        getPosition(callback) {
            const err = new Error('socket hang up');
            err.code = 'ECONNRESET';
            callback(err);
        },
        getDuration(callback) {
            const err = new Error('socket hang up');
            err.code = 'ECONNRESET';
            callback(err);
        }
    };

    assert.strictEqual(await player.doGetPosition(), 0);
    assert.strictEqual(await player.doGetDuration(), 0);
});

test('normalizes HH:MM:SS position and duration from UPnP responses', async () => {
    const player = Object.create(Renderer.prototype);
    player.friendlyName = 'Test speaker';
    player.hasLoadedTrack = true;
    player.client = {
        getPosition(callback) {
            callback(null, '00:02:15');
        },
        getDuration(callback) {
            callback(null, '00:03:30');
        }
    };

    assert.strictEqual(await player.doGetPosition(), 135);
    assert.strictEqual(await player.doGetDuration(), 210);
});

test('still rejects non-transient position errors', async () => {
    const player = Object.create(Renderer.prototype);
    player.friendlyName = 'Test speaker';
    player.hasLoadedTrack = true;
    player.client = {
        getPosition(callback) {
            callback(new Error('invalid XML response'));
        }
    };

    await assert.rejects(player.doGetPosition(), /invalid XML response/);
});

test('does not block forever when renderer never answers stop', async () => {
    const player = Object.create(Renderer.prototype);
    player.friendlyName = 'Test speaker';
    player.loadingTrack = false;
    player.stopProtectionExpiresAt = 0;
    player.hasLoadedTrack = true;
    player.stopCallTimeoutMs = 5;
    player.client = {
        stop() {
            // Simulate a renderer that never invokes the callback.
        }
    };

    const started = Date.now();
    const result = await player.doStop();
    const elapsed = Date.now() - started;

    assert.strictEqual(result, true);
    assert.strictEqual(player.hasLoadedTrack, false);
    assert.ok(elapsed < 200);
});

test('falls back to last known volume on transient socket errors', async () => {
    const player = Object.create(Renderer.prototype);
    player.friendlyName = 'Test speaker';
    player.lastKnownVolume = { level: 37, muted: false };
    player.client = {
        getVolume(callback) {
            const err = new Error('socket hang up');
            err.code = 'ECONNRESET';
            callback(err);
        }
    };

    assert.deepStrictEqual(await player.doGetVolume(), { level: 37, muted: false });
});

test('still rejects non-transient volume errors', async () => {
    const player = Object.create(Renderer.prototype);
    player.friendlyName = 'Test speaker';
    player.client = {
        getVolume(callback) {
            callback(new Error('bad SOAP response'));
        }
    };

    await assert.rejects(player.doGetVolume(), /bad SOAP response/);
});

test('reads transport state from UPnP client', async () => {
    const player = Object.create(Renderer.prototype);
    player.client = {
        getTransportInfo(callback) {
            callback(null, { CurrentTransportState: 'PLAYING' });
        }
    };

    assert.strictEqual(await player.doGetTransportState(), 'PLAYING');
});

test('keeps requested volume during immediate stale UPnP readback', async () => {
    const player = Object.create(Renderer.prototype);
    player.friendlyName = 'Test speaker';
    player.lastKnownVolume = { level: 17, muted: false };
    player.volumeWriteThroughUntil = 0;
    player.client = {
        setVolume(_level, callback) {
            callback(null);
        },
        getVolume(callback) {
            // Device still reports old level right after SetVolume.
            callback(null, 17);
        }
    };

    await player.doSetVolume({ level: 11, muted: false });
    assert.deepStrictEqual(await player.doGetVolume(), { level: 11, muted: false });
});

test('accepts observed volume after write-through window expires', async () => {
    const player = Object.create(Renderer.prototype);
    player.friendlyName = 'Test speaker';
    player.lastKnownVolume = { level: 11, muted: false };
    player.volumeWriteThroughUntil = Date.now() - 1;
    player.client = {
        getVolume(callback) {
            callback(null, 17);
        }
    };

    assert.deepStrictEqual(await player.doGetVolume(), { level: 17, muted: false });
});

test('auto-advances when playback reaches the track end', async () => {
    const player = Object.create(Renderer.prototype);
    player.friendlyName = 'Test speaker';
    player.trackEndCheckInFlight = false;
    player.stopped = false;
    player.playbackActive = true;
    player.loadingTrack = false;
    player.hasLoadedTrack = true;
    player.endedNotified = false;
    player.client = {};
    player.doGetPosition = async () => 120;
    player.doGetDuration = async () => 120;
    let nextCalls = 0;
    player.next = async () => {
        nextCalls += 1;
        return true;
    };

    await player.checkTrackEnd();

    assert.strictEqual(nextCalls, 1);
    assert.strictEqual(player.endedNotified, true);
    assert.strictEqual(player.playbackActive, false);
});

test('auto-advances when end check receives HH:MM:SS values', async () => {
    const player = Object.create(Renderer.prototype);
    player.friendlyName = 'Test speaker';
    player.trackEndCheckInFlight = false;
    player.stopped = false;
    player.playbackActive = true;
    player.loadingTrack = false;
    player.hasLoadedTrack = true;
    player.endedNotified = false;
    player.client = {
        getPosition(callback) {
            callback(null, '00:02:00');
        },
        getDuration(callback) {
            callback(null, '00:02:01');
        }
    };
    let nextCalls = 0;
    player.next = async () => {
        nextCalls += 1;
        return true;
    };

    await player.checkTrackEnd();

    assert.strictEqual(nextCalls, 1);
    assert.strictEqual(player.endedNotified, true);
});

test('auto-advances when transport reports STOPPED', async () => {
    const player = Object.create(Renderer.prototype);
    player.friendlyName = 'Test speaker';
    player.trackEndCheckInFlight = false;
    player.stopped = false;
    player.playbackActive = true;
    player.loadingTrack = false;
    player.hasLoadedTrack = true;
    player.endedNotified = false;
    player.client = {
        getTransportInfo(callback) {
            callback(null, { CurrentTransportState: 'STOPPED' });
        }
    };
    player.doGetPosition = async () => 0;
    player.doGetDuration = async () => 0;
    let nextCalls = 0;
    player.next = async () => {
        nextCalls += 1;
        return true;
    };

    await player.checkTrackEnd();

    assert.strictEqual(nextCalls, 1);
    assert.strictEqual(player.endedNotified, true);
    assert.strictEqual(player.playbackActive, false);
});

test('does not auto-advance while playback is inactive', async () => {
    const player = Object.create(Renderer.prototype);
    player.friendlyName = 'Test speaker';
    player.trackEndCheckInFlight = false;
    player.stopped = false;
    player.playbackActive = false;
    player.loadingTrack = false;
    player.hasLoadedTrack = true;
    player.endedNotified = false;
    player.doGetPosition = async () => 120;
    player.doGetDuration = async () => 120;
    let nextCalls = 0;
    player.next = async () => {
        nextCalls += 1;
        return true;
    };

    await player.checkTrackEnd();

    assert.strictEqual(nextCalls, 0);
    assert.strictEqual(player.endedNotified, false);
});

test('retries seek once on transient socket reset', async () => {
    const player = Object.create(Renderer.prototype);
    player.friendlyName = 'Test speaker';
    let calls = 0;
    player.client = {
        seek(_position, callback) {
            calls += 1;
            if (calls === 1) {
                const err = new Error('socket hang up');
                err.code = 'ECONNRESET';
                callback(err);
                return;
            }
            callback(null);
        }
    };

    assert.strictEqual(await player.doSeek(112), true);
    assert.strictEqual(calls, 2);
});

test('does not retry seek on non-transient errors', async () => {
    const player = Object.create(Renderer.prototype);
    player.friendlyName = 'Test speaker';
    let calls = 0;
    player.client = {
        seek(_position, callback) {
            calls += 1;
            callback(new Error('invalid args'));
        }
    };

    assert.strictEqual(await player.doSeek(112), false);
    assert.strictEqual(calls, 1);
});
