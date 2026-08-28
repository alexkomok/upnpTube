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
        this.playerPlayPromise = null;
        this.pendingVideoId = null;
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
            return this.playPromise;
        }

        const videoId = video.id;
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
                const options = { autoplay: false, contentType: 'audio/mp4' };
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
                            if (playErr) {
                                console.log(`[${obj.friendlyName}]: Play error:`);
                                console.log(playErr);
                            }
                            resolve(!playErr);
                        });
                    };

                    if (position > 0) {
                        obj.client.seek(position, function(seekErr) {
                            if (seekErr) {
                                console.log(`[${obj.friendlyName}]: Seek error:`);
                                console.log(seekErr);
                            }
                            startPlayback();
                        });
                    } else {
                        startPlayback();
                    }
                });
            });
        });

        this.playPromise = playback;
        try {
            return await playback;
        } finally {
            if (this.playPromise === playback) {
                this.playPromise = null;
            }
        }
    }



    async doPause() {
        console.log(`[${this.friendlyName}]: Pause`);
        const obj = this;
        return new Promise(resolve => {
            this.client.pause(function(err) {
                if (err) console.log(`[${obj.friendlyName}]: Pause error:`, err);
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
                resolve(!err);
            });
        });
    }

    async doStop() {
        console.log(`[${this.friendlyName}]: Stop`);
        const obj = this;
        return new Promise(resolve => {
            this.client.stop(function(err) {
                if (err) console.log(`[${obj.friendlyName}]: Stop error:`, err);
                if (!err) obj.hasLoadedTrack = false;
                resolve(!err);
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
                    reject(err);
                } else {
                    resolve({ level: result, muted: false });
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
                    reject(err);
                } else {
                    resolve(result);
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
                    reject(err);
                } else {
                    resolve(result);
                }
            });
        });
    }
}

// TODO Work out how to export only the things we want to export
module.exports = { Renderer };
