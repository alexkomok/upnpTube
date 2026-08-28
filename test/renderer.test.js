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
