const assert = require('assert');
const { test } = require('node:test');
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
        }
    };

    assert.deepStrictEqual(await player.doGetVolume(), { level: 42, muted: false });
    assert.strictEqual(await player.doSetVolume({ level: 70, muted: true }), true);
    assert.strictEqual(requestedVolume, 70);
    assert.strictEqual(await player.doGetPosition(), 30);
});
