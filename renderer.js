const { Console } = require('console');
const MediaRendererClient = require('upnp-mediarenderer-client');
const { exec } = require('child_process');
const os = require('os');
const httpProxy = require('http-proxy');

// TODO: Ideally the author will accept the pull request and re-publish. Otherwise tie it to my fork.
const Ytcr = require('yt-cast-receiver');
const YouTubeCastReceiver = Ytcr.default || Ytcr;
const Player = Ytcr.Player;

// Use ports 3005, 3001, 3002 etc for successive YTCRs
const YTCR_BASE_PORT = 3005;

// Use port 800n for the HTTPS->HTTP proxying of the media
const PROXY_BASE_PORT = 8000;
const PLAY_AFTER_LOAD_DELAY_MS = 1000;
const PLAYBACK_START_STOP_GRACE_MS = 5000;
const STOP_CALL_TIMEOUT_MS = 2000;
const PLAYBACK_MONITOR_INTERVAL_MS = 2000;
const TRACK_END_EPSILON_SECONDS = 1;
const VOLUME_WRITE_THROUGH_WINDOW_MS = 1500;

function isTransientSocketError(err) {
    if (!err) {
        return false;
    }

    const message = (err.message || '').toLowerCase();
    return err.code === 'ECONNRESET' || message.includes('socket hang up');
}

function normalizeSeconds(value) {
    if (typeof value === 'number') {
        return Number.isFinite(value) ? value : 0;
    }

    if (typeof value === 'string') {
        const trimmed = value.trim();
        if (!trimmed) {
            return 0;
        }

        const numeric = Number(trimmed);
        if (!Number.isNaN(numeric) && Number.isFinite(numeric)) {
            return numeric;
        }

        const parts = trimmed.split(':');
        if (parts.length === 3) {
            const hours = Number(parts[0]);
            const minutes = Number(parts[1]);
            const seconds = Number(parts[2]);
            if (![hours, minutes, seconds].some(Number.isNaN)) {
                return (hours * 3600) + (minutes * 60) + seconds;
            }
        }
    }

    return 0;
}

// TODO Does this clean up nicely? YTCR instance disappear from the menu in the youtube app? Port freed etc?

/**
 * Class controlling a single upnp media renderer.
 * It implements yt-cast-receiver.Player so that it can receive and translate casts from YouTube.
 */
class Renderer extends Player {

    constructor(location, index, timeout)
    {
        // Call the Ytcr.Player constructor
        super();

        console.log("Creating new renderer: " + location);
        this.location = location;
        this.index = index;
        this.timeout = timeout;
        this.httpServer = null;
        this.hasLoadedTrack = false;
        this.playPromise = null;
        this.loadingVideoId = null;
        this.queuedPlay = null;
        this.playerPlayPromise = null;
        this.pendingVideoId = null;
        this.stopProtectionExpiresAt = 0;
        this.stopCallTimeoutMs = STOP_CALL_TIMEOUT_MS;
        this.lastKnownVolume = { level: 0, muted: false };
        this.volumeWriteThroughUntil = 0;
        this.playbackActive = false;
        this.trackEndCheckInFlight = false;
        this.playbackMonitorIntervalMs = PLAYBACK_MONITOR_INTERVAL_MS;
        this.playbackMonitorTimer = null;
        this.refresh();

        // Instantiate the mediarender client
        this.client = new MediaRendererClient(location);

        // No errors so far
        this.error = false

        // Get device details
        const obj = this;
        this.client.getDeviceDescription(function(err, description) {
            if (err) {
                console.log("Failed to get device description from " + obj.location);
                return;
            }

            // Create a friendly string from the above, which we will name the YouTube cast receiver
            // e.g. "Living Room (Pure Jongo A2)"
            const friendlyName = description.friendlyName;
            const manufacturer = description.manufacturer;
            const modelName = description.modelName;
            obj.friendlyName = `🔊 ${friendlyName} (${manufacturer} ${modelName})`;
            console.log(`[${obj.friendlyName}]: New renderer created, timeout ${obj.timeout}`);

            // TODO Select audio or video according to the capabilities of the renderer
            // obj.client.getSupportedProtocols( function(error, protocols) {
            //     if(err) {
            //         console.log(`[${obj.friendlyName}]: getSupportedProtocols error:`);
            //         console.log(err);
            //     } else {
            //         console.log(`[${obj.friendlyName}]: getSupportedProtocols:`);
            //         console.log(protocols);
            //     }
            // });

            // Create a youtube cast receiver

            const options = {
                device: {
                    name: obj.friendlyName,
                    screenName: obj.friendlyName,
                    brand: description.manufacturer,
                    model: description.modelName
                },
                dial: {
                    port: YTCR_BASE_PORT + obj.index,
                    bindToAddresses: ['192.168.0.154']
                },
                logLevel: 'debug'
            };

            obj.ytcr = new YouTubeCastReceiver(obj, options);
            obj.ytcr.on('senderConnect', client => {
                console.log(`[${obj.friendlyName}]: YouTube client connected`);
                console.log(client);
            });
            obj.ytcr.start().catch(err => {
                console.log(`[${obj.friendlyName}]: Failed to start YouTube Cast Receiver:`);
                console.log(err);
                obj.error = true;
            });


        });
    }



refresh(timeout) {
    if (this.stopped) {
        return;
    }

    this.lastSeenTime =
        Number(process.hrtime.bigint() / 1000000000n);

    if (timeout !== undefined) {
        this.timeout = timeout;
    }

    console.log(
        `[${this.friendlyName || this.location}]: ` +
        `Refreshed, timeout ${this.timeout}s`
    );
}



    isStale() {
        // If an error occurred in setup, we are stale.
        if (this.error) return true;

        // If we have not been refreshed (i.e. discovered again) in this.timeout,
        // we are stale.
        const now = Number(process.hrtime.bigint() / 1000000000n);

        if (this.lastSeenTime + this.timeout < now) return true;

        return false;
    }

async shutdown() {
    const name = this.friendlyName || this.location;

    if (this.stopped) {
        console.log(`[${name}]: Renderer already stopped`);
        return;
    }

    console.log(`[${name}]: Stopping renderer`);
    this.stopPlaybackMonitor();

    if (this.ytcr) {
        try {
            console.log(`[${name}]: Stopping YTCR`);
            await this.ytcr.stop();
            console.log(`[${name}]: YTCR stopped`);
        } catch (err) {
            console.log(`[${name}]: YTCR stop error:`);
            console.log(err);
        }

        this.ytcr = null;
    }

    this.stopped = true;

    console.log(`[${name}]: Renderer stopped`);
}




    getAudioUrl(videoId, callback) {
        const obj = this;

        // Call yt-dlp to get the audio URL
        exec(`/home/pi/.local/bin/yt-dlp --js-runtimes /home/pi/.deno/bin/deno -f bestaudio[ext=m4a] --get-url https://www.youtube.com/watch?v=${videoId}`, function(err, stdout, stderr) {
            if(err) {
                console.log(`[${obj.friendlyName}]: Unable to get audio URL using yt-dlp. Using youtube-dl but this is slower!`);

                // Enable to see what went wrong
                // console.log(err);
                // if(stdout) {
                //     console.log(stdout);
                // }
                // if(stderr) {
                //     console.log(stderr);
                // }

                exec(`/home/pi/.local/bin/yt-dlp --js-runtimes deno -f bestaudio[ext=m4a] --get-url https://www.youtube.com/watch?v=${videoId}`, function(err, stdout, stderr) {
                    if(err) {
                        console.log(`[${obj.friendlyName}]: Error getting URL from youtube-dl:`);
                        // Enable to see what went wrong
                        // console.log(err);
                        // if(stdout) {
                        //     console.log(stdout);
                        // }
                        // if(stderr) {
                        //     console.log(stderr);
                        // }
                    } else {
                        // Call the callback with the retrieved URL
                        const audioUrl = stdout.toString().trim();
                        console.log(`[${obj.friendlyName}]: Media URL: ${audioUrl}`);
                        callback(audioUrl);
                    }
                });
            }
            else {
                // Call the callback with the retrieved URL
                const audioUrl = stdout.toString().trim();
                console.log(`[${obj.friendlyName}]: Media URL: ${audioUrl}`);
                callback(audioUrl);
            }
        });
    }

    /**
     * The methods implementing yt-cast-receiver.Player
     */
    async play(video, position, AID) {
        if (this.playerPlayPromise && this.pendingVideoId === video.id) {
            return this.playerPlayPromise;
        }

        // Cast senders can send several play commands while the playlist is updating.
        const playback = super.play(video, position, AID);
        this.playerPlayPromise = playback;
        this.pendingVideoId = video.id;
        try {
            return await playback;
        } finally {
            if (this.playerPlayPromise === playback) {
                this.playerPlayPromise = null;
                this.pendingVideoId = null;
            }
        }
    }

    async doPlay(video, position = 0) {
        if (this.playPromise) {
            if (this.loadingVideoId !== video.id) {
                const queuedPlay = { video, position };
                this.queuedPlay = queuedPlay;
                return this.playPromise.then(() => {
                    if (this.queuedPlay !== queuedPlay) {
                        return false;
                    }

                    this.queuedPlay = null;
                    return this.doPlay(video, position);
                });
            }

            return this.playPromise;
        }

        const videoId = video.id;
        this.loadingVideoId = videoId;
        console.log(`[${this.friendlyName}]: Play ${videoId} at position ${position}s`);
        const obj = this;
        this.endedNotified = false;
        this.loadingTrack = true;
        console.log(`[${this.friendlyName}]: RESET endedNotified for ${videoId}`);

        const playback = new Promise(resolve => {
            const localFile = `/tmp/upnptube-${this.index}-${videoId}.m4a`;
            const localUrl = `http://192.168.0.154:9002/upnptube-${this.index}-${videoId}.m4a`;
            exec(`rm -f "${localFile}" && /home/pi/.local/bin/yt-dlp --js-runtimes node --force-overwrites -f 140 -o "${localFile}" "https://www.youtube.com/watch?v=${videoId}"`, function(err) {
                if (err) {
                    obj.loadingTrack = false;
                    obj.hasLoadedTrack = false;
                    console.log(`[${obj.friendlyName}]: yt-dlp download failed`);
                    console.log(err);
                    resolve(false);
                    return;
                }

                exec('find /tmp -name "upnptube-*.m4a" -mtime +1 -delete');
                const options = {
                    autoplay: false,
                    contentType: 'audio/m4a',
                    dlnaFeatures: 'DLNA.ORG_PN=AAC_ISO'
                };
                console.log("LOCAL URL:", localUrl);
                obj.client.load(localUrl, options, function(loadErr) {
                    if (loadErr) {
                        obj.loadingTrack = false;
                        console.log(`[${obj.friendlyName}]: Error loading local media:`);
                        console.log(loadErr);
                        resolve(false);
                        return;
                    }

                    const startPlayback = function() {
                        obj.client.play(function(playErr) {
                            obj.loadingTrack = false;
                            obj.hasLoadedTrack = !playErr;
                            if (!playErr) {
                                obj.playbackActive = true;
                                obj.stopProtectionExpiresAt =
                                    Date.now() + PLAYBACK_START_STOP_GRACE_MS;
                                obj.startPlaybackMonitor();
                            }
                            if (playErr) {
                                console.log(`[${obj.friendlyName}]: Play error:`);
                                console.log(playErr);
                            }
                            resolve(!playErr);
                        });
                    };

                    setTimeout(startPlayback, PLAY_AFTER_LOAD_DELAY_MS);
                });
            });
        });

        this.playPromise = playback;
        try {
            return await playback;
        } finally {
            if (this.playPromise === playback) {
                this.playPromise = null;
                this.loadingVideoId = null;
            }
        }
    }



    async doPause() {
        console.log(`[${this.friendlyName}]: Pause`);
        const obj = this;
        return new Promise(resolve => {
            this.client.pause(function(err) {
                if (err) console.log(`[${obj.friendlyName}]: Pause error:`, err);
                if (!err) {
                    obj.playbackActive = false;
                }
                resolve(!err);
            });
        });
    }

    async doResume() {
        console.log(`[${this.friendlyName}]: Resume`);
        const obj = this;
        return new Promise(resolve => {
            this.client.play(function(err) {
                if (err) console.log(`[${obj.friendlyName}]: Resume error:`, err);
                if (!err) {
                    obj.playbackActive = true;
                    obj.startPlaybackMonitor();
                }
                resolve(!err);
            });
        });
    }

    async doStop() {
        console.log(`[${this.friendlyName}]: Stop`);
        if (this.loadingTrack || Date.now() < this.stopProtectionExpiresAt) {
            return true;
        }

        const obj = this;
        return new Promise(resolve => {
            let settled = false;
            const settle = function(ok) {
                if (settled) {
                    return;
                }

                settled = true;
                if (ok) {
                    obj.playbackActive = false;
                    obj.stopPlaybackMonitor();
                    obj.hasLoadedTrack = false;
                }
                resolve(ok);
            };

            const stopTimeout = setTimeout(function() {
                // Some renderers intermittently never reply to Stop during
                // track transitions. Continue so the next Play can proceed.
                console.log(`[${obj.friendlyName}]: Stop timed out, continuing with next playback`);
                settle(true);
            }, obj.stopCallTimeoutMs);

            this.client.stop(function(err) {
                clearTimeout(stopTimeout);
                if (err) {
                    console.log(`[${obj.friendlyName}]: Stop error:`, err);
                    settle(false);
                    return;
                }

                settle(true);
            });
        });
    }

    async doSeek(position) {
        console.log(`[${this.friendlyName}]: Seek to ${position}s`);
        const obj = this;
        return new Promise(resolve => {
            this.client.seek(position, function(err) {
                if (err) console.log(`[${obj.friendlyName}]: Seek error:`, err);
                resolve(!err);
            });
        });
    }

    async doGetVolume() {
        const obj = this;
        return new Promise(function(resolve, reject) {
            obj.client.getVolume(function(err, result) {
                if(err) {
                    if (isTransientSocketError(err)) {
                        resolve(obj.lastKnownVolume || { level: 0, muted: false });
                        return;
                    }
                    reject(err);
                } else {
                    const observedVolume = { level: result, muted: false };
                    const now = Date.now();
                    const isWithinWriteThroughWindow = now < obj.volumeWriteThroughUntil;
                    if (isWithinWriteThroughWindow &&
                        obj.lastKnownVolume &&
                        observedVolume.level !== obj.lastKnownVolume.level) {
                        resolve(obj.lastKnownVolume);
                        return;
                    }

                    const volume = observedVolume;
                    obj.lastKnownVolume = volume;
                    resolve(volume);
                }
            });
        });
    }

    async doSetVolume(volume) {
        console.log(`[${this.friendlyName}]: setVolume to ${volume.level}`);
        const obj = this;
        return new Promise(resolve => {
            this.client.setVolume(volume.level, function(err) {
                if (err) console.log(`[${obj.friendlyName}]: setVolume error:`, err);
                if (!err) {
                    obj.lastKnownVolume = { level: volume.level, muted: !!volume.muted };
                    obj.volumeWriteThroughUntil = Date.now() + VOLUME_WRITE_THROUGH_WINDOW_MS;
                }
                resolve(!err);
            });
        });
    }

    async doGetPosition() {
        if (!this.hasLoadedTrack) {
            return 0;
        }

        const obj = this;
        return new Promise(function(resolve, reject) {
            obj.client.getPosition(function(err, result) {
                if(err) {
                    if (isTransientSocketError(err)) {
                        resolve(0);
                        return;
                    }
                    reject(err);
                } else {
                    resolve(normalizeSeconds(result));
                }
            });
        });
    }

    async doGetDuration() {
        if (!this.hasLoadedTrack) {
            return 0;
        }

        const obj = this;
        return new Promise(function(resolve, reject) {
            obj.client.getDuration(function(err, result) {
                if(err) {
                    if (isTransientSocketError(err)) {
                        resolve(0);
                        return;
                    }
                    reject(err);
                } else {
                    resolve(normalizeSeconds(result));
                }
            });
        });
    }

    async doGetTransportState() {
        const obj = this;
        return new Promise(function(resolve, reject) {
            obj.client.getTransportInfo(function(err, result) {
                if (err) {
                    if (isTransientSocketError(err)) {
                        resolve(null);
                        return;
                    }
                    reject(err);
                    return;
                }

                resolve(result?.CurrentTransportState || null);
            });
        });
    }

    startPlaybackMonitor() {
        if (this.playbackMonitorTimer) {
            return;
        }

        const obj = this;
        this.playbackMonitorTimer = setInterval(function() {
            obj.checkTrackEnd().catch(function(err) {
                if (!isTransientSocketError(err)) {
                    console.log(`[${obj.friendlyName}]: Track-end check failed:`);
                    console.log(err);
                }
            });
        }, this.playbackMonitorIntervalMs);
    }

    stopPlaybackMonitor() {
        if (!this.playbackMonitorTimer) {
            return;
        }

        clearInterval(this.playbackMonitorTimer);
        this.playbackMonitorTimer = null;
    }

    async checkTrackEnd() {
        if (this.trackEndCheckInFlight || this.stopped || !this.playbackActive ||
            this.loadingTrack || !this.hasLoadedTrack || this.endedNotified) {
            return;
        }

        this.trackEndCheckInFlight = true;
        try {
            if (this.client && typeof this.client.getTransportInfo === 'function') {
                const transportState = await this.doGetTransportState();
                if (transportState === 'STOPPED') {
                    this.endedNotified = true;
                    this.playbackActive = false;
                    console.log(`[${this.friendlyName}]: Transport is STOPPED; auto-playing next`);
                    await this.next();
                    return;
                }
            }

            const position = await this.doGetPosition();
            const duration = await this.doGetDuration();
            if (duration > 0 && position >= duration - TRACK_END_EPSILON_SECONDS) {
                this.endedNotified = true;
                this.playbackActive = false;
                console.log(
                    `[${this.friendlyName}]: Track ended at ${position}s / ${duration}s; auto-playing next`
                );
                await this.next();
            }
        } finally {
            this.trackEndCheckInFlight = false;
        }
    }
}

// TODO Work out how to export only the things we want to export
module.exports = { Renderer };
